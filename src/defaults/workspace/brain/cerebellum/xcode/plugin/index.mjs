// xcode: build, test and run iOS apps with xcodebuild. Discovers projects,
// lists schemes, reads the bundle id, keeps per-conversation defaults, parses
// build output into `file:line: message` errors, and chains
// build → boot → install → launch on the Simulator in one call.
//
// Every process is spawned with an argv array (never a shell), with a hard
// timeout and — for xcodebuild — a no-output watchdog. Success is decided by
// the exit code, never by log text. Tests inject a fake executor through
// __setExecutor so no real xcodebuild ever runs under test.
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

let workspaceRoot = path.join(homedir(), '.wolffish', 'workspace')
let getCurrentConversationId = () => null
let getWorkingFolders = () => []

const BUILD_TIMEOUT_MS = 20 * 60_000
const TEST_TIMEOUT_MS = 30 * 60_000
const STALL_TIMEOUT_MS = 5 * 60_000
const LIST_TIMEOUT_MS = 30_000
const SETTINGS_TIMEOUT_MS = 120_000
const BOOT_TIMEOUT_MS = 120_000
const INSTALL_TIMEOUT_MS = 120_000
const LAUNCH_TIMEOUT_MS = 60_000
const SIMCTL_TIMEOUT_MS = 30_000
const BUNDLE_CACHE_TTL_MS = 10 * 60_000
const MAX_REPORTED_ERRORS = 25
const MAX_REPORTED_FAILURES = 25
const DISCOVER_MAX_DEPTH = 3
const OUTPUT_TAIL_LINES = 200
const OUTPUT_TAIL_BYTES = 50 * 1024

const SCHEME_PATTERN = /^[\w .-]+$/
const CONFIGURATION_PATTERN = /^[\w .-]+$/
const DEVICE_PATTERN = /^[\w .()+-]+$/
const BUNDLE_ID_PATTERN = /^[\w.-]+$/
const TEST_SELECTOR_PATTERN = /^[\w./()-]+$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SKIPPED_DIRS = new Set(['node_modules', '.build', 'DerivedData', 'Pods', '.git'])

// ---------------------------------------------------------------------------
// Process execution (injectable)
// ---------------------------------------------------------------------------

/**
 * Spawn `cmd` with an argv array. Options:
 *   cwd, env, timeout (hard cap, SIGKILL), stallTimeout (SIGKILL when no
 *   bytes arrive for this long), signal (AbortSignal → SIGKILL), onData(chunk)
 *   (when given, output is streamed to it and NOT accumulated in `out`).
 * Resolves (never rejects) with { code, out, err, timedOut?, stalled?, aborted?, streamed? }.
 */
function defaultRun(cmd, args, { cwd, env, timeout = 60_000, stallTimeout = 0, signal, onData } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: null, out: '', err: 'aborted before start', aborted: true })
      return
    }
    let child
    try {
      child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, NO_COLOR: '1', ...(env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (err) {
      resolve({ code: -1, out: '', err: err?.message ?? String(err) })
      return
    }
    const chunks = []
    let errText = ''
    let done = false
    let stallTimer = null
    const text = () => Buffer.concat(chunks).toString('utf8')
    const kill = () => {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (stallTimer) clearTimeout(stallTimer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ ...result, streamed: Boolean(onData) })
    }
    const timer = setTimeout(() => {
      kill()
      finish({ code: null, out: text(), err: `timed out after ${Math.round(timeout / 1000)}s`, timedOut: true })
    }, timeout)
    const armStall = () => {
      if (!stallTimeout) return
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        kill()
        finish({ code: null, out: text(), err: `no output for ${Math.round(stallTimeout / 1000)}s`, stalled: true })
      }, stallTimeout)
    }
    const onAbort = () => {
      kill()
      finish({ code: null, out: text(), err: 'aborted', aborted: true })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    armStall()
    const onChunk = (chunk, isErr) => {
      armStall()
      if (isErr && errText.length < 20_000) errText += chunk.toString()
      if (onData) onData(chunk)
      else chunks.push(chunk)
    }
    child.stdout.on('data', (c) => onChunk(c, false))
    child.stderr.on('data', (c) => onChunk(c, true))
    child.on('error', (e) => finish({ code: -1, out: text(), err: e?.message ?? String(e) }))
    child.on('close', (code) => finish({ code, out: text(), err: errText }))
  })
}

let executor = defaultRun

/** Test seam: replace the process runner with a fake `(cmd, args, opts) => {code, out, err}`. */
export function __setExecutor(fn) {
  executor = typeof fn === 'function' ? fn : defaultRun
}

/** Test seam: restore the real spawn-based runner. */
export function __resetExecutor() {
  executor = defaultRun
}

async function run(cmd, args, opts = {}) {
  const r = await executor(cmd, args, opts)
  return {
    code: typeof r?.code === 'number' ? r.code : r?.code === null ? null : -1,
    out: typeof r?.out === 'string' ? r.out : '',
    err: typeof r?.err === 'string' ? r.err : '',
    timedOut: r?.timedOut === true,
    stalled: r?.stalled === true,
    aborted: r?.aborted === true,
    streamed: r?.streamed === true
  }
}

function tail(text, maxLines = OUTPUT_TAIL_LINES, maxBytes = OUTPUT_TAIL_BYTES) {
  const lines = text.split('\n')
  const kept = lines.slice(-maxLines)
  let joined = kept.join('\n')
  while (Buffer.byteLength(joined, 'utf8') > maxBytes && kept.length > 1) {
    kept.shift()
    joined = kept.join('\n')
  }
  return (lines.length > kept.length ? `…(${lines.length - kept.length} earlier lines omitted)\n` : '') + joined
}

// ---------------------------------------------------------------------------
// xcodebuild output parser
// ---------------------------------------------------------------------------

// Ported shapes (XcodeBuildMCP xcodebuild-line-parsers.ts):
//   /path/File.swift:42:10: error: message      → location file:line
//   /path/Project.xcodeproj: error: message      → location = path
//   xcodebuild: error: message | error: message  → no location
//   ld: <linker diagnostic>                      → no location (ld has no "error:" prefix)
const ERROR_WITH_LINE = /^(.*?):(\d+)(?::\d+)?: (?:fatal error|error): (.+)$/iu
const ERROR_WITH_PATH = /^(\/[^:]+): (?:fatal error|error): (.+)$/iu
const ERROR_PREFIXED = /^(?:[\w-]+:\s+)?(?:fatal error|error): (.+)$/iu
const ERROR_LINKER = /^ld: (?!warning:)(.+)$/u
const ERROR_ANYWHERE = /(?:^|\s)(?:fatal error|error):\s+\S/iu
const WARNING_WITH_LINE = /^(.*?):(\d+)(?::\d+)?:\s+warning:\s+(.+)$/u
const WARNING_PREFIXED = /^(?:[\w-]+:\s+)?warning:\s+(.+)$/iu
// XCTest failure diagnostic: /path/Tests.swift:12: error: -[Suite test] : XCTAssert... failed - message
const XCTEST_FAILURE = /^(.*?):(\d+): error: -\[(.+?)\s+(.+?)\] : (.+)$/u
// Swift Testing issue: ✘ Test "name" recorded an issue at File.swift:12:5: Expectation failed: ...
const SWIFT_TESTING_ISSUE = /Test (?:"(.+?)"|(\S+?)) recorded an issue at (\S+?):(\d+)(?::\d+)?: (.+)$/u
// XCTest case: Test Case '-[Suite test]' passed (0.001 seconds)
const XCTEST_CASE = /^Test [Cc]ase '(.+)' (passed|failed|skipped)(?: on '.+')? \(([^)]+)\)/u
// Swift Testing case: ✔ Test "name" passed after 0.001 seconds. | ✘ Test example() failed after ...
const SWIFT_TESTING_CASE = /^\s*[✔✘⏭︎✔✘]*\s*Test (?:"(.+?)"|(\S+?)) (passed|failed|skipped)(?: after ([\d.]+) seconds)?/u
// XCTest totals (per suite and overall; the last one is the overall)
const XCTEST_TOTALS = /^\s*Executed (\d+) tests?, with (\d+) failures?(?: \(\d+ unexpected\))? in (.+)$/u
// Swift Testing totals: Test run with 12 tests passed after 0.3 seconds. | ... failed after 0.3 seconds with 2 issues.
const SWIFT_TESTING_TOTALS = /^\s*[✔✘]*\s*Test run with (\d+) tests? (passed|failed) after ([\d.]+) seconds(?: with (\d+) issues?)?/u

function parseRawTestName(rawName) {
  const objc = rawName.match(/^-\[(.+?)\s+(.+)\]$/u)
  if (objc) return { suite: objc[1].split('.').pop() ?? objc[1], test: objc[2] }
  const slash = rawName.split('/').filter(Boolean)
  if (slash.length >= 2) return { suite: slash.slice(0, -1).join('/'), test: slash[slash.length - 1] }
  const dot = rawName.lastIndexOf('.')
  if (dot > 0 && dot < rawName.length - 1) return { suite: rawName.slice(0, dot), test: rawName.slice(dot + 1) }
  return { suite: '', test: rawName }
}

function parseErrorLine(line) {
  let m = line.match(ERROR_WITH_LINE)
  if (m) return { location: `${m[1]}:${m[2]}`, message: m[3] }
  m = line.match(ERROR_WITH_PATH)
  if (m) return { location: m[1], message: m[2] }
  m = line.match(ERROR_PREFIXED)
  if (m) return { location: '', message: m[1] }
  m = line.match(ERROR_LINKER)
  if (m) return { location: 'ld', message: m[1] }
  if (ERROR_ANYWHERE.test(line)) return { location: '', message: line.trim() }
  return null
}

function parseWarningLine(line) {
  let m = line.match(WARNING_WITH_LINE)
  if (m) return { location: `${m[1]}:${m[2]}`, message: m[3] }
  m = line.match(WARNING_PREFIXED)
  if (m) return { location: '', message: m[1] }
  return null
}

function diagnosticKey(location, message) {
  return `${location ?? ''}|${message}`.trim().toLowerCase()
}

/**
 * Incremental line parser over xcodebuild output. `mode` is 'build' or
 * 'test'. Feed chunks (Buffer or string) as they arrive; call end() to flush
 * the last partial line. Errors and warnings are deduped by
 * lowercased `location|message`.
 */
export function createOutputParser(mode = 'build') {
  const seen = new Set()
  const state = {
    errors: [],
    warningCount: 0,
    lineCount: 0,
    lastLines: [],
    tests: { passed: 0, failed: 0, skipped: 0 },
    failures: [],
    totals: null
  }
  let carry = ''

  const addError = (location, message) => {
    const key = diagnosticKey(location, message)
    if (seen.has(key)) return
    seen.add(key)
    state.errors.push({ location, message })
  }
  const addFailure = (suite, test, message, location) => {
    const key = `test|${suite}|${test}|${location}|${message}`.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    state.failures.push({ suite, test, message, location })
  }

  const handleLine = (rawLine) => {
    const line = rawLine.replace(/\r$/, '')
    state.lineCount++
    state.lastLines.push(line)
    if (state.lastLines.length > 40) state.lastLines.shift()
    if (!line.trim()) return

    if (mode === 'test') {
      let m = line.match(XCTEST_CASE)
      if (m) {
        state.tests[m[2]]++
        return
      }
      m = line.match(SWIFT_TESTING_CASE)
      if (m) {
        state.tests[m[3]]++
        return
      }
      m = line.match(XCTEST_TOTALS)
      if (m) {
        state.totals = { executed: Number(m[1]), failed: Number(m[2]), duration: m[3] }
        return
      }
      m = line.match(SWIFT_TESTING_TOTALS)
      if (m) {
        state.totals = { executed: Number(m[1]), failed: m[2] === 'failed' ? Number(m[4] ?? 1) : 0, duration: `${m[3]} seconds` }
        return
      }
      m = line.match(XCTEST_FAILURE)
      if (m) {
        const suite = m[3].split('.').pop() ?? m[3]
        addFailure(suite, m[4], m[5].replace(/^failed\s*-\s*/u, ''), m[2] === '0' ? '' : `${m[1]}:${m[2]}`)
        return
      }
      m = line.match(SWIFT_TESTING_ISSUE)
      if (m) {
        addFailure('', m[1] ?? m[2], m[5], `${m[3]}:${m[4]}`)
        return
      }
    }

    const warning = parseWarningLine(line)
    if (warning) {
      const key = `warning|${diagnosticKey(warning.location, warning.message)}`
      if (!seen.has(key)) {
        seen.add(key)
        state.warningCount++
      }
      return
    }
    const error = parseErrorLine(line)
    if (error) addError(error.location, error.message)
  }

  return {
    feed(chunk) {
      carry += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      let nl = carry.indexOf('\n')
      while (nl >= 0) {
        handleLine(carry.slice(0, nl))
        carry = carry.slice(nl + 1)
        nl = carry.indexOf('\n')
      }
    },
    end() {
      if (carry) handleLine(carry)
      carry = ''
      return state
    },
    state
  }
}

function formatError(e) {
  return e.location ? `${e.location}: ${e.message}` : e.message
}

// ---------------------------------------------------------------------------
// Validation + defaults
// ---------------------------------------------------------------------------

const defaultsByConversation = new Map()

function conversationKey() {
  let id = null
  try {
    id = getCurrentConversationId()
  } catch {
    id = null
  }
  return typeof id === 'string' && id ? id : '(none)'
}

function currentDefaults() {
  return defaultsByConversation.get(conversationKey()) ?? {}
}

function str(v) {
  return typeof v === 'string' ? v.trim() : ''
}

function fail(error, extra = {}) {
  return { success: false, retryable: false, error, ...extra }
}

function missing(field, hint) {
  return fail(`MISSING_DEFAULTS: ${field} is unknown — set it with xcode_defaults {${field}: "..."} or pass ${field}${hint ? `. ${hint}` : ''}`)
}

function projectFlag(projectPath) {
  return projectPath.endsWith('.xcworkspace') ? '-workspace' : '-project'
}

async function pathExists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

function absolutize(p) {
  if (path.isAbsolute(p)) return p
  let folders = []
  try {
    folders = getWorkingFolders() ?? []
  } catch {
    folders = []
  }
  return path.resolve(folders[0] ?? process.cwd(), p)
}

async function validateProject(raw) {
  const p = str(raw)
  if (!p) return { error: missing('project', 'xcode_discover finds it.') }
  const abs = absolutize(p)
  if (!abs.endsWith('.xcodeproj') && !abs.endsWith('.xcworkspace')) return { error: fail(`project must be a .xcodeproj or .xcworkspace path, got ${abs}`) }
  if (!(await pathExists(abs))) return { error: fail(`project does not exist: ${abs}`) }
  return { project: abs }
}

function validateScheme(raw) {
  const s = str(raw)
  if (!s) return { error: missing('scheme', 'xcode_schemes lists them.') }
  if (!SCHEME_PATTERN.test(s)) return { error: fail(`scheme contains unsupported characters: ${JSON.stringify(s)}`) }
  return { scheme: s }
}

function validateConfiguration(raw) {
  const c = str(raw) || 'Debug'
  if (!CONFIGURATION_PATTERN.test(c)) return { error: fail(`configuration contains unsupported characters: ${JSON.stringify(c)}`) }
  return { configuration: c }
}

function validateDevice(raw) {
  const d = str(raw)
  if (!d) return { device: '' }
  if (!DEVICE_PATTERN.test(d)) return { error: fail(`device contains unsupported characters: ${JSON.stringify(d)}`) }
  return { device: d }
}

/**
 * Resolve project/scheme/configuration/device from args, falling back to
 * the conversation's xcode_defaults. Returns { error } or the resolved set.
 */
async function resolveBuildInputs(args) {
  const d = currentDefaults()
  const project = await validateProject(args?.project ?? d.project)
  if (project.error) return { error: project.error }
  const scheme = validateScheme(args?.scheme ?? d.scheme)
  if (scheme.error) return { error: scheme.error }
  const configuration = validateConfiguration(args?.configuration ?? d.configuration)
  if (configuration.error) return { error: configuration.error }
  const device = validateDevice(args?.device ?? d.device)
  if (device.error) return { error: device.error }
  return { project: project.project, scheme: scheme.scheme, configuration: configuration.configuration, device: device.device }
}

function destinationFor(device) {
  if (!device) return 'generic/platform=iOS Simulator'
  return UUID_PATTERN.test(device) ? `platform=iOS Simulator,id=${device}` : `platform=iOS Simulator,name=${device}`
}

function sanitizeForPath(s) {
  return s.replace(/[^a-z0-9_-]/gi, '_')
}

function timestamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
}

// ---------------------------------------------------------------------------
// xcode_discover
// ---------------------------------------------------------------------------

async function walk(dir, depth, found) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  const names = new Set(entries.map((e) => e.name))
  const dirs = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name))
  if (names.has('pubspec.yaml')) found.flutter.push(dir)
  if (dirs.has('ios') && (names.has('app.json') || names.has('app.config.js') || names.has('app.config.ts'))) found.expo.push(dir)
  else if (dirs.has('ios') && dirs.has('android') && names.has('package.json')) found.reactNative.push(dir)
  if (names.has('build.gradle') || names.has('build.gradle.kts')) found.gradle.push(dir)
  if (names.has('Package.swift')) found.packages.push(path.join(dir, 'Package.swift'))
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = path.join(dir, entry.name)
    if (entry.name.endsWith('.xcworkspace')) {
      // Every .xcodeproj carries an internal project.xcworkspace; that is not a user workspace.
      if (!dir.endsWith('.xcodeproj')) found.workspaces.push(full)
      continue
    }
    if (entry.name.endsWith('.xcodeproj')) {
      found.projects.push(full)
      continue
    }
    if (SKIPPED_DIRS.has(entry.name) || entry.name.endsWith('.app')) continue
    if (depth < DISCOVER_MAX_DEPTH) await walk(full, depth + 1, found)
  }
}

async function xcodeDiscover(args) {
  let folder = str(args?.folder)
  if (!folder) {
    let folders = []
    try {
      folders = getWorkingFolders() ?? []
    } catch {
      folders = []
    }
    folder = folders[0] ?? ''
  }
  if (!folder) return fail('folder is required (the working folder to scan)')
  folder = absolutize(folder)
  let info
  try {
    info = await stat(folder)
  } catch {
    return fail(`folder does not exist: ${folder}`)
  }
  if (!info.isDirectory()) return fail(`folder is not a directory: ${folder}`)

  const found = { workspaces: [], projects: [], packages: [], flutter: [], expo: [], reactNative: [], gradle: [] }
  await walk(folder, 0, found)
  for (const list of Object.values(found)) list.sort()

  const lines = [`Scanned ${folder} (depth ${DISCOVER_MAX_DEPTH}).`]
  const workspaceDirs = new Set(found.workspaces.map((w) => path.dirname(w)))
  if (found.workspaces.length) {
    lines.push('', 'Xcode workspaces (prefer these over a sibling .xcodeproj — they carry CocoaPods/SPM):')
    for (const w of found.workspaces) lines.push(`  ${w}`)
  }
  if (found.projects.length) {
    lines.push('', 'Xcode projects:')
    for (const p of found.projects) {
      const shadowed = workspaceDirs.has(path.dirname(p))
      lines.push(`  ${p}${shadowed ? '  (a workspace sits next to it — use the workspace)' : ''}`)
    }
  }
  if (found.packages.length) {
    lines.push('', 'Swift packages:')
    for (const p of found.packages) lines.push(`  ${p}`)
  }
  if (found.flutter.length) {
    lines.push('', 'Flutter apps:')
    for (const p of found.flutter) lines.push(`  ${p}`)
  }
  if (found.expo.length) {
    lines.push('', 'Expo / React Native apps:')
    for (const p of found.expo) lines.push(`  ${p}`)
  }
  if (found.reactNative.length) {
    lines.push('', 'React Native apps:')
    for (const p of found.reactNative) lines.push(`  ${p}`)
  }
  if (found.gradle.length) {
    lines.push('', 'Gradle (Android) projects:')
    for (const p of found.gradle) lines.push(`  ${p}`)
  }

  const runPaths = []
  if (found.workspaces.length || found.projects.length) {
    const pick = found.workspaces[0] ?? found.projects.find((p) => !workspaceDirs.has(path.dirname(p))) ?? found.projects[0]
    runPaths.push(`Xcode: xcode_defaults {project: "${pick}", scheme: <from xcode_schemes>, device: <udid or name>} then xcode_run.`)
  }
  if (found.packages.length && !found.workspaces.length && !found.projects.length) {
    runPaths.push('Swift package: `swift build` / `swift test` via shell_exec (xcodebuild needs a scheme from `xcodebuild -list` on the package folder for iOS).')
  }
  if (found.flutter.length) runPaths.push('Flutter: `flutter run -d <udid>` via shell_exec background=true (then mobile_screenshot).')
  if (found.expo.length) runPaths.push('Expo: `npx expo run:ios` via shell_exec background=true (then mobile_screenshot).')
  if (found.reactNative.length) runPaths.push('React Native: `npx react-native run-ios --simulator "<name>"` via shell_exec background=true.')
  if (found.gradle.length) runPaths.push('Gradle: `./gradlew assembleDebug` via shell_exec then mobile_install with the APK.')

  if (runPaths.length) {
    lines.push('', 'Run path:')
    for (const r of runPaths) lines.push(`  ${r}`)
  } else {
    lines.push('', 'No Xcode workspace/project, Swift package, Flutter, React Native or Gradle project found. If the app lives deeper than 3 folders, pass that folder.')
  }
  return { success: true, output: lines.join('\n'), meta: { label: 'Discover' } }
}

// ---------------------------------------------------------------------------
// xcode_schemes
// ---------------------------------------------------------------------------

function parseJson(text) {
  // xcodebuild sometimes prefixes JSON with warnings; find the first brace.
  const start = text.search(/[[{]/)
  if (start < 0) return null
  try {
    return JSON.parse(text.slice(start))
  } catch {
    return null
  }
}

async function xcodeSchemes(args) {
  const project = await validateProject(args?.project ?? currentDefaults().project)
  if (project.error) return project.error
  const p = project.project
  const r = await run('xcodebuild', ['-list', '-json', projectFlag(p), p], { cwd: path.dirname(p), timeout: LIST_TIMEOUT_MS })
  if (r.code !== 0) return fail(`xcodebuild -list ${r.timedOut ? 'timed out' : `exited ${r.code}`}: ${tail(r.err || r.out, 20)}`)
  const json = parseJson(r.out)
  const node = json?.workspace ?? json?.project
  if (!node) return fail(`could not parse xcodebuild -list output:\n${tail(r.out, 20)}`)
  const schemes = Array.isArray(node.schemes) ? node.schemes : []
  const targets = Array.isArray(node.targets) ? node.targets : []
  const configurations = Array.isArray(node.configurations) ? node.configurations : []
  const lines = [`${json.workspace ? 'Workspace' : 'Project'} ${node.name ?? path.basename(p)}`]
  lines.push(`Schemes (${schemes.length}): ${schemes.length ? schemes.join(', ') : '(none — the project has no shared schemes; open it in Xcode once or check Manage Schemes > Shared)'}`)
  if (targets.length) lines.push(`Targets (${targets.length}): ${targets.join(', ')}`)
  if (configurations.length) lines.push(`Configurations: ${configurations.join(', ')}`)
  if (schemes.length) lines.push(`Next: xcode_defaults {project: "${p}", scheme: "${schemes[0]}"} (pick the app scheme, not a test or Pods scheme).`)
  return { success: true, output: lines.join('\n'), meta: { label: 'Schemes', exitCode: 0 } }
}

// ---------------------------------------------------------------------------
// xcode_bundle_id
// ---------------------------------------------------------------------------

const bundleCache = new Map()

async function readBuildSettings(project, scheme, configuration) {
  const key = `${project}|${scheme}|${configuration}`
  const cached = bundleCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return { settings: cached.settings, cached: true }
  const argv = ['-showBuildSettings', '-json', '-scheme', scheme, '-configuration', configuration, projectFlag(project), project, '-destination', 'generic/platform=iOS Simulator']
  const r = await run('xcodebuild', argv, { cwd: path.dirname(project), timeout: SETTINGS_TIMEOUT_MS })
  if (r.code !== 0) return { error: `xcodebuild -showBuildSettings ${r.timedOut ? 'timed out' : `exited ${r.code}`}: ${tail(r.err || r.out, 20)}` }
  const json = parseJson(r.out)
  const entries = Array.isArray(json) ? json : []
  const withBundle = entries.filter((e) => e?.buildSettings?.PRODUCT_BUNDLE_IDENTIFIER)
  const entry = withBundle.find((e) => e.target === scheme) ?? withBundle.find((e) => /\.app$/.test(e.buildSettings.FULL_PRODUCT_NAME ?? '')) ?? withBundle[0] ?? entries[0]
  if (!entry?.buildSettings) return { error: `no build settings in xcodebuild output:\n${tail(r.out, 20)}` }
  const s = entry.buildSettings
  const settings = {
    target: entry.target ?? '',
    bundleId: s.PRODUCT_BUNDLE_IDENTIFIER ?? '',
    productName: s.FULL_PRODUCT_NAME ?? '',
    targetBuildDir: s.TARGET_BUILD_DIR ?? '',
    builtProductsDir: s.BUILT_PRODUCTS_DIR ?? ''
  }
  bundleCache.set(key, { settings, expiresAt: Date.now() + BUNDLE_CACHE_TTL_MS })
  return { settings, cached: false }
}

async function xcodeBundleId(args) {
  const d = currentDefaults()
  const project = await validateProject(args?.project ?? d.project)
  if (project.error) return project.error
  const scheme = validateScheme(args?.scheme ?? d.scheme)
  if (scheme.error) return scheme.error
  const configuration = validateConfiguration(args?.configuration ?? d.configuration)
  if (configuration.error) return configuration.error
  const r = await readBuildSettings(project.project, scheme.scheme, configuration.configuration)
  if (r.error) return fail(r.error)
  const s = r.settings
  if (!s.bundleId) return fail(`PRODUCT_BUNDLE_IDENTIFIER is empty for scheme ${scheme.scheme}${s.target ? ` (target ${s.target})` : ''}.`)
  const lines = [
    `PRODUCT_BUNDLE_IDENTIFIER: ${s.bundleId}${r.cached ? ' (cached)' : ''}`,
    `FULL_PRODUCT_NAME: ${s.productName || '(unknown)'}`,
    `TARGET_BUILD_DIR: ${s.targetBuildDir || '(unknown)'}`,
    `BUILT_PRODUCTS_DIR: ${s.builtProductsDir || '(unknown)'}`
  ]
  if (s.target) lines.push(`Target: ${s.target}`)
  return { success: true, output: lines.join('\n'), meta: { label: 'Bundle id' } }
}

// ---------------------------------------------------------------------------
// xcode_defaults
// ---------------------------------------------------------------------------

const DEFAULT_FIELDS = ['project', 'scheme', 'configuration', 'device']

function hasDefaultsArgs(args) {
  if (!args || typeof args !== 'object') return false
  if (args.clear === true) return true
  return DEFAULT_FIELDS.some((f) => str(args[f]))
}

function formatDefaults(d) {
  const rows = DEFAULT_FIELDS.map((f) => `  ${f}: ${d[f] ? d[f] : '(unset)'}`)
  return rows.join('\n')
}

async function xcodeDefaults(args) {
  const key = conversationKey()
  if (args?.clear === true) {
    defaultsByConversation.delete(key)
    return { success: true, output: 'Cleared the Xcode defaults for this conversation.' }
  }
  if (!hasDefaultsArgs(args)) {
    const d = currentDefaults()
    const empty = !DEFAULT_FIELDS.some((f) => d[f])
    return {
      success: true,
      output: empty
        ? 'No Xcode defaults set for this conversation. Set them with xcode_defaults {project, scheme, configuration, device} — xcode_discover finds the project, xcode_schemes the scheme.'
        : `Xcode defaults for this conversation:\n${formatDefaults(d)}`
    }
  }
  const next = { ...currentDefaults() }
  if (str(args.project)) {
    const v = await validateProject(args.project)
    if (v.error) return v.error
    next.project = v.project
  }
  if (str(args.scheme)) {
    const v = validateScheme(args.scheme)
    if (v.error) return v.error
    next.scheme = v.scheme
  }
  if (str(args.configuration)) {
    const v = validateConfiguration(args.configuration)
    if (v.error) return v.error
    next.configuration = v.configuration
  }
  if (str(args.device)) {
    const v = validateDevice(args.device)
    if (v.error) return v.error
    next.device = v.device
  }
  defaultsByConversation.set(key, next)
  const stillMissing = ['project', 'scheme'].filter((f) => !next[f])
  return {
    success: true,
    output: `Xcode defaults for this conversation:\n${formatDefaults(next)}${stillMissing.length ? `\nStill needed before building: ${stillMissing.join(', ')}.` : '\nNext: xcode_run (build + install + launch) or xcode_build.'}`
  }
}

// ---------------------------------------------------------------------------
// xcodebuild runner shared by build / test / run
// ---------------------------------------------------------------------------

async function openLog(kind, scheme) {
  const dir = path.join(workspaceRoot, 'files', 'xcode', 'logs')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${kind}-${sanitizeForPath(scheme)}-${timestamp()}.log`)
  const stream = createWriteStream(file, { flags: 'w' })
  stream.on('error', () => {
    // A log that cannot be written must not fail the build; the parser still sees every byte.
  })
  return {
    file,
    write(chunk) {
      if (!stream.destroyed) stream.write(chunk)
    },
    close() {
      return new Promise((resolve) => {
        if (stream.destroyed) {
          resolve()
          return
        }
        stream.end(resolve)
      })
    }
  }
}

function derivedDataFor(scheme) {
  return path.join(workspaceRoot, 'files', 'derived-data', sanitizeForPath(scheme))
}

async function findApp(derived, configuration, scheme) {
  const dir = path.join(derived, 'Build', 'Products', `${configuration}-iphonesimulator`)
  try {
    const entries = await readdir(dir)
    const apps = entries.filter((e) => e.endsWith('.app'))
    const preferred = apps.find((a) => a === `${scheme}.app`) ?? apps[0]
    return { dir, app: preferred ? path.join(dir, preferred) : null }
  } catch {
    return { dir, app: null }
  }
}

/**
 * Run xcodebuild for `action` ('build' | 'clean build' | 'test'), streaming to
 * a log file and the parser. Returns { code, seconds, parsed, logPath, kind }
 * where kind ∈ 'ok' | 'failed' | 'stalled' | 'timeout' | 'aborted' | 'spawn'.
 */
async function runXcodebuild({ inputs, action, extraArgs = [], signal, kind }) {
  const { project, scheme, configuration, device } = inputs
  const derived = derivedDataFor(scheme)
  await mkdir(derived, { recursive: true })
  const argv = [
    projectFlag(project), project,
    '-scheme', scheme,
    '-configuration', configuration,
    '-destination', destinationFor(device),
    '-derivedDataPath', derived,
    '-skipMacroValidation',
    'COMPILER_INDEX_STORE_ENABLE=NO',
    ...extraArgs,
    ...action.split(' ')
  ]
  const log = await openLog(kind, scheme)
  const parser = createOutputParser(kind === 'test' ? 'test' : 'build')
  const startedAt = Date.now()
  const r = await run('xcodebuild', argv, {
    cwd: path.dirname(project),
    timeout: kind === 'test' ? TEST_TIMEOUT_MS : BUILD_TIMEOUT_MS,
    stallTimeout: STALL_TIMEOUT_MS,
    signal,
    onData: (chunk) => {
      log.write(chunk)
      parser.feed(chunk)
    }
  })
  if (!r.streamed && r.out) {
    log.write(r.out)
    parser.feed(r.out)
  }
  const parsed = parser.end()
  await log.close()
  const seconds = Math.round((Date.now() - startedAt) / 1000)
  let outcome = 'ok'
  if (r.aborted) outcome = 'aborted'
  else if (r.stalled) outcome = 'stalled'
  else if (r.timedOut) outcome = 'timeout'
  else if (r.code === -1 && r.out === '') outcome = 'spawn'
  else if (r.code !== 0) outcome = 'failed'
  return { code: r.code, err: r.err, seconds, parsed, logPath: log.file, outcome, derived, argv }
}

function describeFailure(res, label) {
  const { parsed, outcome, seconds, logPath, code, err } = res
  const head =
    outcome === 'stalled' ? `BUILD_STALLED: xcodebuild produced no output for ${Math.round(STALL_TIMEOUT_MS / 60_000)} minutes and was killed after ${seconds}s.`
    : outcome === 'timeout' ? `${label}_FAILED: xcodebuild exceeded the time cap and was killed after ${seconds}s.`
    : outcome === 'aborted' ? `${label}_FAILED: aborted after ${seconds}s.`
    : outcome === 'spawn' ? `${label}_FAILED: could not start xcodebuild (${err || 'is Xcode installed? xcode-select -p'}).`
    : `${label}_FAILED: xcodebuild exited ${code} after ${seconds}s.`
  const lines = [head]
  const errors = parsed.errors.slice(0, MAX_REPORTED_ERRORS)
  if (errors.length) {
    lines.push(`Errors (${parsed.errors.length}${parsed.errors.length > errors.length ? `, first ${errors.length}` : ''}):`)
    for (const e of errors) lines.push(`  ${formatError(e)}`)
  } else if (outcome === 'failed') {
    lines.push('No error diagnostics were parsed; the last lines of the log:')
    for (const l of parsed.lastLines.slice(-15)) lines.push(`  ${l}`)
  }
  lines.push(`Warnings: ${parsed.warningCount}`)
  lines.push(`Log: ${logPath}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// xcode_build
// ---------------------------------------------------------------------------

async function buildStep(args, signal) {
  const inputs = await resolveBuildInputs(args)
  if (inputs.error) return { error: inputs.error }
  const clean = args?.clean === true
  const res = await runXcodebuild({ inputs, action: clean ? 'clean build' : 'build', signal, kind: 'build' })
  if (res.outcome !== 'ok') return { error: fail(describeFailure(res, 'BUILD'), { meta: { label: 'Build', durationMs: res.seconds * 1000, exitCode: res.code } }) }
  const { app, dir } = await findApp(res.derived, inputs.configuration, inputs.scheme)
  return { inputs, res, app, productsDir: dir }
}

async function xcodeBuild(args, signal) {
  const b = await buildStep(args, signal)
  if (b.error) return b.error
  const { inputs, res, app, productsDir } = b
  const lines = [
    `Built ${inputs.scheme} (${inputs.configuration}) for ${inputs.device || 'the iOS Simulator (generic)'} in ${res.seconds}s.`,
    app ? `App: ${app}` : `App: no .app bundle found under ${productsDir} — the product may not be an app (check the scheme); the log names the product path.`,
    `Warnings: ${res.parsed.warningCount}`,
    `Log: ${res.logPath}`,
    app
      ? `Next: xcode_run (build + install + launch in one call), or mobile_install app="${app}" then mobile_launch bundle_id=<xcode_bundle_id>.`
      : 'Next: xcode_schemes to confirm the app scheme.'
  ]
  return { success: true, output: lines.join('\n'), meta: { label: 'Build', durationMs: res.seconds * 1000, exitCode: 0 } }
}

// ---------------------------------------------------------------------------
// xcode_test
// ---------------------------------------------------------------------------

function testSelectors(raw, flag) {
  const s = str(raw)
  if (!s) return { args: [] }
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean)
  for (const p of parts) if (!TEST_SELECTOR_PATTERN.test(p)) return { error: fail(`test selector contains unsupported characters: ${JSON.stringify(p)} (expected Target/Class/testMethod)`) }
  return { args: parts.map((p) => `${flag}:${p}`) }
}

async function xcodeTest(args, signal) {
  const inputs = await resolveBuildInputs(args)
  if (inputs.error) return inputs.error
  const only = testSelectors(args?.only, '-only-testing')
  if (only.error) return only.error
  const skip = testSelectors(args?.skip, '-skip-testing')
  if (skip.error) return skip.error
  const res = await runXcodebuild({ inputs, action: 'test', extraArgs: [...only.args, ...skip.args], signal, kind: 'test' })
  const { parsed } = res
  const counts = parsed.tests
  const total = counts.passed + counts.failed + counts.skipped
  const summary = total > 0
    ? `${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped (${total} tests${parsed.totals?.duration ? `, ${parsed.totals.duration}` : ''})`
    : parsed.totals
      ? `${parsed.totals.executed - parsed.totals.failed} passed, ${parsed.totals.failed} failed (${parsed.totals.executed} tests)`
      : 'no test results parsed'
  const lines = []
  if (res.outcome === 'ok') lines.push(`Tests passed for ${inputs.scheme}: ${summary} in ${res.seconds}s.`)
  else lines.push(`TEST_FAILED: ${summary}${res.outcome === 'failed' ? ` (xcodebuild exited ${res.code}` : ` (${res.outcome}`} after ${res.seconds}s).`)
  const failures = parsed.failures.slice(0, MAX_REPORTED_FAILURES)
  if (failures.length) {
    lines.push(`Failures (${parsed.failures.length}${parsed.failures.length > failures.length ? `, first ${failures.length}` : ''}):`)
    for (const f of failures) lines.push(`  ${f.suite ? `${f.suite}.` : ''}${f.test}: ${f.message}${f.location ? ` (${f.location})` : ''}`)
  }
  if (res.outcome !== 'ok' && parsed.errors.length) {
    const errors = parsed.errors.slice(0, MAX_REPORTED_ERRORS)
    lines.push(`Build errors (${parsed.errors.length}):`)
    for (const e of errors) lines.push(`  ${formatError(e)}`)
  }
  if (res.outcome !== 'ok' && !failures.length && !parsed.errors.length) {
    lines.push(res.outcome === 'stalled' ? `BUILD_STALLED: no output for ${Math.round(STALL_TIMEOUT_MS / 60_000)} minutes.` : 'No diagnostics were parsed; the last lines of the log:')
    for (const l of parsed.lastLines.slice(-15)) lines.push(`  ${l}`)
  }
  lines.push(`Warnings: ${parsed.warningCount}`)
  lines.push(`Log: ${res.logPath}`)
  const meta = { label: 'Test', durationMs: res.seconds * 1000, exitCode: res.code }
  if (res.outcome !== 'ok') return fail(lines.join('\n'), { meta })
  return { success: true, output: lines.join('\n'), meta }
}

// ---------------------------------------------------------------------------
// xcode_run
// ---------------------------------------------------------------------------

async function listSimulators() {
  const r = await run('xcrun', ['simctl', 'list', 'devices', '--json'], { timeout: SIMCTL_TIMEOUT_MS })
  if (r.code !== 0) return { error: `xcrun simctl list failed: ${tail(r.err || r.out, 5)}` }
  const json = parseJson(r.out)
  if (!json?.devices) return { error: 'could not parse simctl device list' }
  const devices = []
  for (const list of Object.values(json.devices)) {
    if (!Array.isArray(list)) continue
    for (const d of list) {
      if (d?.isAvailable === false) continue
      devices.push({ name: String(d.name ?? ''), udid: String(d.udid ?? ''), state: String(d.state ?? '') })
    }
  }
  return { devices }
}

/** name | udid | '' → { udid, name, state } ('' picks the booted device, else the first iPhone). */
async function resolveSimulator(device) {
  const list = await listSimulators()
  if (list.error) return { error: list.error }
  const { devices } = list
  if (!device) {
    const booted = devices.find((d) => d.state === 'Booted')
    if (booted) return { device: booted }
    return { error: 'no simulator is booted and no device was given' }
  }
  if (UUID_PATTERN.test(device)) {
    const byUdid = devices.find((d) => d.udid.toLowerCase() === device.toLowerCase())
    return byUdid ? { device: byUdid } : { error: `no simulator with udid ${device}` }
  }
  const byName = devices.filter((d) => d.name.toLowerCase() === device.toLowerCase())
  if (!byName.length) return { error: `no simulator named ${JSON.stringify(device)} (mobile_devices lists them)` }
  return { device: byName.find((d) => d.state === 'Booted') ?? byName[0] }
}

async function xcodeRun(args, signal) {
  // Resolve the device before building so a bad name fails in seconds, not after a 5-minute build.
  const inputs = await resolveBuildInputs(args)
  if (inputs.error) return inputs.error
  const bundleArg = str(args?.bundle_id)
  if (bundleArg && !BUNDLE_ID_PATTERN.test(bundleArg)) return fail(`bundle_id contains unsupported characters: ${JSON.stringify(bundleArg)}`)

  const sim = await resolveSimulator(inputs.device)
  if (sim.error) return fail(`BOOT_FAILED: ${sim.error}${inputs.device ? '' : ' — pass device or set it with xcode_defaults {device: "..."}'}`)
  const target = sim.device

  const b = await buildStep({ ...args, device: target.udid }, signal)
  if (b.error) return b.error
  if (!b.app) return fail(`BUILD_FAILED: the build succeeded but no .app bundle was found under ${b.productsDir} — is ${inputs.scheme} an app scheme?`)
  const app = b.app
  if (signal?.aborted) return fail('BOOT_FAILED: aborted')

  if (target.state !== 'Booted') {
    const boot = await run('xcrun', ['simctl', 'boot', target.udid], { timeout: BOOT_TIMEOUT_MS, signal })
    if (boot.code !== 0 && !/already booted|current state: Booted/i.test(boot.err + boot.out)) {
      return fail(`BOOT_FAILED: xcrun simctl boot ${target.udid} ${boot.timedOut ? 'timed out' : `exited ${boot.code}`}: ${tail(boot.err || boot.out, 5)}`)
    }
    const status = await run('xcrun', ['simctl', 'bootstatus', target.udid, '-b'], { timeout: BOOT_TIMEOUT_MS, signal })
    if (status.code !== 0) return fail(`BOOT_FAILED: ${target.name} did not finish booting within ${Math.round(BOOT_TIMEOUT_MS / 1000)}s: ${tail(status.err || status.out, 5)}`)
    // Best effort: show the window. The install/launch below do not depend on it.
    await run('open', ['-a', 'Simulator'], { timeout: 15_000 })
  }

  let bundleId = bundleArg
  if (!bundleId) {
    const settings = await readBuildSettings(inputs.project, inputs.scheme, inputs.configuration)
    if (settings.error || !settings.settings.bundleId) {
      return fail(`LAUNCH_FAILED: could not read the bundle id (${settings.error ?? 'PRODUCT_BUNDLE_IDENTIFIER is empty'}). Built app: ${app}. Pass bundle_id explicitly.`)
    }
    bundleId = settings.settings.bundleId
  }

  const install = await run('xcrun', ['simctl', 'install', target.udid, app], { timeout: INSTALL_TIMEOUT_MS, signal })
  if (install.code !== 0) return fail(`INSTALL_FAILED: xcrun simctl install ${install.timedOut ? 'timed out' : `exited ${install.code}`}: ${tail(install.err || install.out, 8)}\nApp: ${app}`)

  const launch = await run('xcrun', ['simctl', 'launch', '--terminate-running-process', target.udid, bundleId], { timeout: LAUNCH_TIMEOUT_MS, signal })
  if (launch.code !== 0) return fail(`LAUNCH_FAILED: xcrun simctl launch ${bundleId} ${launch.timedOut ? 'timed out' : `exited ${launch.code}`}: ${tail(launch.err || launch.out, 8)}\nApp installed at: ${app}`)
  const pidMatch = launch.out.match(/:\s*(\d+)\s*$/m)
  const pid = pidMatch ? Number(pidMatch[1]) : null

  const lines = [
    `Running ${inputs.scheme} (${inputs.configuration}) on ${target.name} (${target.udid})${pid ? `, pid ${pid}` : ''}. Build took ${b.res.seconds}s.`,
    `App: ${app}`,
    `Bundle id: ${bundleId}`,
    `Warnings: ${b.res.parsed.warningCount}`,
    `Log: ${b.res.logPath}`,
    `Next: mobile_use device=${target.udid} then mobile_indicator_on, mobile_screenshot / mobile_snapshot to see it; mobile_log to read its output.`
  ]
  return { success: true, output: lines.join('\n'), meta: { label: 'Run', durationMs: b.res.seconds * 1000, exitCode: 0 } }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const handlers = {
  xcode_discover: xcodeDiscover,
  xcode_schemes: xcodeSchemes,
  xcode_bundle_id: xcodeBundleId,
  xcode_defaults: xcodeDefaults,
  xcode_build: xcodeBuild,
  xcode_test: xcodeTest,
  xcode_run: xcodeRun
}

const toolDefinitions = Object.keys(handlers).map((name) => ({ name, description: name, parameters: { type: 'object', properties: {} } }))

function labelFor(args) {
  const d = currentDefaults()
  return str(args?.scheme) || d.scheme || 'the app'
}

const plugin = {
  name: 'xcode',
  tools: toolDefinitions,
  async init(context) {
    if (typeof context?.workspaceRoot === 'string' && context.workspaceRoot) workspaceRoot = context.workspaceRoot
    if (typeof context?.getCurrentConversationId === 'function') getCurrentConversationId = context.getCurrentConversationId
    if (typeof context?.getWorkingFolders === 'function') getWorkingFolders = context.getWorkingFolders
  },
  isReadOnlyCall(toolName, args) {
    if (['xcode_discover', 'xcode_schemes', 'xcode_bundle_id'].includes(toolName)) return true
    if (toolName === 'xcode_defaults') return !hasDefaultsArgs(args)
    return false
  },
  describeAction(toolName, args) {
    const scheme = labelFor(args)
    if (toolName === 'xcode_build') return { title: 'Xcode', description: `Build ${scheme}`, risk: 'low' }
    if (toolName === 'xcode_test') return { title: 'Xcode', description: `Test ${scheme}`, risk: 'low' }
    if (toolName === 'xcode_run') {
      const device = str(args?.device) || currentDefaults().device || 'the Simulator'
      return { title: 'Xcode', description: `Run ${scheme} on ${device}`, risk: 'low' }
    }
    return null
  },
  async execute(toolName, args, signal) {
    const fn = handlers[toolName]
    if (!fn) return { success: false, error: `xcode: unknown tool ${toolName}` }
    try {
      return await fn(args ?? {}, signal)
    } catch (err) {
      return { success: false, error: err?.message ?? String(err) }
    }
  }
}

export default plugin
