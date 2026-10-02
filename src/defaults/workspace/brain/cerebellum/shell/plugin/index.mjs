import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, chmod, constants, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { describeCommand, isInvestigation, isReadOnly, looksLikeWatcher } from './tokenize.mjs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

// Injected at init: the turn's working folders (conversation picker ∪
// project directories). The first one is the default cwd, so `npm test`
// lands in the project without the model retyping an absolute path.
let getWorkingFolders = () => []

// The app's process registry (PluginContext.processes), when the host wired
// one in. Every background start goes through it so there is ONE list of
// long-lived processes — persisted, supervised, visible in Library and to
// `process_*` — instead of this plugin's own map that dies with the app.
let processesHost = null

// Injected at init: binds a progress reporter to the tool call in flight. A
// check-in (the runtime parking a long command and asking the model what to
// do) reads what it reported — the last lines and the output rate — so the
// model judges the command by what it printed, not by elapsed time alone.
let progressReporterFactory = null

function defaultCwd() {
  try {
    const folders = getWorkingFolders()
    if (Array.isArray(folders) && typeof folders[0] === 'string' && folders[0]) return folders[0]
  } catch {
    // fall through to home
  }
  return homedir()
}

function resolveCwd(input) {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) return defaultCwd()
  if (raw === '~') return homedir()
  if (raw.startsWith('~/')) return path.join(homedir(), raw.slice(2))
  // A relative cwd is relative to the working folder (or home without one).
  if (!path.isAbsolute(raw)) return path.resolve(defaultCwd(), raw)
  return raw
}

// ---------------------------------------------------------------------------
// Shell detection (cached)
// ---------------------------------------------------------------------------

let shellPromise = null

async function probeWindowsShell() {
  const candidates = [
    { name: 'pwsh', args: ['-NoProfile', '-NonInteractive', '-Command'], powershell: true },
    { name: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command'], powershell: true }
  ]
  for (const c of candidates) {
    try {
      await execFileP('where', [c.name], { windowsHide: true })
      return { bin: c.name, args: c.args, powershell: c.powershell }
    } catch {
      // not on PATH
    }
  }
  return { bin: 'cmd.exe', args: ['/c'] }
}

function detectShell() {
  if (shellPromise) return shellPromise
  if (process.platform !== 'win32') {
    shellPromise = Promise.resolve({ bin: '/bin/sh', args: ['-c'] })
    return shellPromise
  }
  shellPromise = probeWindowsShell().catch(() => ({ bin: 'cmd.exe', args: ['/c'] }))
  return shellPromise
}

/**
 * Drop a trailing bare `2>&1` when the shell is PowerShell.
 *
 * `2>&1` is a POSIX reflex and it parses fine in PowerShell, so it fails
 * silently rather than loudly: redirecting a NATIVE command's stderr into the
 * success stream makes PowerShell wrap every stderr line in a
 * NativeCommandError record, which leaves `$?` false, which makes
 * `powershell -Command` exit 1 — even when the child exited 0. A command that
 * fully succeeded then gets reported to the model as FAILED, with its real
 * output buried under CategoryInfo/FullyQualifiedErrorId noise. Measured:
 * `node noisy.js 2>&1` exits 1, the same command without it exits 0.
 *
 * The redirect buys nothing here regardless — execForeground already returns
 * combine(stdout, stderr) — so on PowerShell it is pure downside.
 *
 * Deliberately narrow. Only a TRAILING `2>&1` is dropped, and only when the
 * rest of the command has no other `>`: that leaves `cmd > out.log 2>&1`
 * (stderr belongs in the file) and `cmd 2>&1 | Select-String x` (stderr
 * belongs in the pipe) exactly as written. cmd.exe and /bin/sh are never
 * touched — POSIX behaviour is byte-for-byte unchanged.
 */
const TRAILING_STDERR_MERGE_RE = /\s+2>&1\s*$/

function stripRedundantStderrMerge(command, shell) {
  if (!shell?.powershell) return command
  const match = TRAILING_STDERR_MERGE_RE.exec(command)
  if (!match) return command
  const head = command.slice(0, match.index)
  if (head.includes('>')) return command
  return head.trim() || command
}

// ---------------------------------------------------------------------------
// Elevation detection
// ---------------------------------------------------------------------------

// Matches sudo, doas, pkexec, gsudo, runas anywhere in a command — at the
// start, after &&, after ||, after ;, or after whitespace.
const ELEVATION_RE = /(?:^|\s|&&|\|\||;)\s*(?:sudo|doas|pkexec|gsudo|runas)\s/i

// Narrower regex that captures the elevation keyword so we can rewrite it.
// Used to inject the -A flag into sudo/doas invocations.
const SUDO_INJECT_RE = /(?<=^|\s|&&|\|\||;)(\s*)(sudo|doas)(\s)/gi

// ---------------------------------------------------------------------------
// Cross-platform askpass: native OS password dialog
// ---------------------------------------------------------------------------

// Cached state so the user sees at most one password dialog per ~5 min window.
// After a successful prime, subsequent sudo calls within the cache window
// succeed silently. The askpass helper stays on disk until cleanup.
let askpassState = null // { askpassPath, tmpDir, env, primedAt }

// Injected at plugin init by the main process. On macOS we route elevation
// through this shared, app-lifetime password session so the user is prompted
// once per app run instead of per command. Null until init runs, and unused on
// non-macOS where the legacy per-session askpass path below still applies.
let sudoCtx = null

async function cleanupAskpass() {
  if (!askpassState) return
  const { tmpDir } = askpassState
  askpassState = null
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
}

// Returns the shell script body for the askpass helper on the current platform.
// The script must print the password to stdout and exit 0 on success, or
// exit non-zero on cancellation.
async function buildAskpassScript(message) {
  const escaped = (message || 'Wolffish needs admin access to run this command.').replace(
    /"/g,
    '\\"'
  )

  if (process.platform === 'darwin') {
    return `#!/bin/bash
set -e
osascript \\
  -e 'tell application "System Events" to activate' \\
  -e 'display dialog "${escaped}" default answer "" with hidden answer with title "Wolffish" buttons {"Cancel", "Authorize"} default button "Authorize"' \\
  -e 'text returned of result' 2>/dev/null
`
  }

  if (process.platform === 'linux') {
    // Probe for a GUI password tool. Wolffish is an Electron app so a
    // desktop environment is always present.
    const tools = [
      { cmd: 'zenity', args: () => `zenity --password --title="Wolffish" --text="${escaped}" 2>/dev/null` },
      { cmd: 'kdialog', args: () => `kdialog --password "${escaped}" --title "Wolffish" 2>/dev/null` },
      { cmd: 'ssh-askpass', args: () => `SSH_ASKPASS_REQUIRE=force ssh-askpass "${escaped}" 2>/dev/null` }
    ]

    for (const tool of tools) {
      try {
        await execFileP('which', [tool.cmd])
        return `#!/bin/bash\nset -e\n${tool.args()}\n`
      } catch {
        // not available
      }
    }

    return null // no GUI tool found
  }

  // Windows: sudo doesn't exist natively. Return null to trigger the
  // fast-fail path.
  return null
}

// Run a command and collect its output. Same pattern as the package-manager
// plugin's runSpawn — non-blocking, Promise-based.
function runCollect(cmd, args, env = process.env) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: err?.message ?? String(err) })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (c) => { stdout += c.toString().slice(0, 10_000) })
    child.stderr?.on('data', (c) => { stderr += c.toString().slice(0, 10_000) })
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: err?.message ?? String(err) }))
  })
}

// Commands that add a NEW directory to the persistent/login PATH — installers
// whose target dir isn't already on the running process's PATH. After one
// succeeds we re-read the PATH so the new tool is reachable by the next tool
// call without an app restart, the same staleness node_check / the ffmpeg
// resolver guard against. Excluded on purpose: npm -g / pip / cargo (their bin
// dirs are already on PATH) and apt/dnf/yum (install to /usr/bin, always on
// PATH) — a refresh there adds nothing and just fires needlessly. brew/port/snap
// ARE included: a GUI-launched app's minimal PATH lacks /opt/homebrew/bin,
// /opt/local/bin, /snap/bin.
const PATH_MUTATING_RE =
  /\b(?:winget|choco|scoop|msiexec|setx)\b|SetEnvironmentVariable|\b(?:brew|port|snap)\s+install\b/i

// Re-read the user's "real" PATH and merge any new entries into process.env.PATH
// so a tool just installed by a shell command is reachable by the next spawn. On
// Windows that's the registry (Machine + User scopes); elsewhere it's the login
// shell's PATH, which sources the rc files where Homebrew/nvm/etc. live.
// Append-only, deduped, best-effort — a failure leaves PATH untouched.
async function refreshWolffishPath() {
  const sep = process.platform === 'win32' ? ';' : ':'
  let raw = []
  try {
    if (process.platform === 'win32') {
      const script =
        "[Environment]::GetEnvironmentVariable('PATH','Machine');" +
        "[Environment]::GetEnvironmentVariable('PATH','User')"
      const { stdout } = await execFileP(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: 5_000, windowsHide: true }
      )
      raw = stdout.split(/\r?\n/).flatMap((line) => line.split(';'))
    } else {
      const shell = process.env.SHELL || '/bin/sh'
      const { stdout } = await execFileP(
        shell,
        ['-ilc', 'printf "__WFPATH__%s__WFPATH__" "$PATH"'],
        { timeout: 5_000 }
      )
      const resolved = stdout.match(/__WFPATH__(.+?)__WFPATH__/)?.[1]
      raw = resolved ? resolved.split(':') : []
    }
  } catch {
    return // best-effort
  }
  const strip = (p) => p.trim().replace(/[\\/]+$/, '')
  const key = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
  const additions = raw.map(strip).filter(Boolean)
  if (additions.length === 0) return
  const current = (process.env.PATH ?? '')
    .split(sep)
    .map((p) => p.trim())
    .filter(Boolean)
  const seen = new Set(current.map((p) => key(strip(p))))
  let mutated = false
  for (const entry of additions) {
    const k = key(entry)
    if (seen.has(k)) continue
    seen.add(k)
    current.push(entry)
    mutated = true
  }
  if (mutated) process.env.PATH = current.join(sep)
}

/**
 * Ensure sudo credentials are cached. Shows a native OS password dialog
 * on the first call; subsequent calls within ~5 minutes are free.
 *
 * Returns { ok, env, error?, cancelled? }.
 * On success, `env` contains SUDO_ASKPASS pointing at the helper script.
 * The caller passes this env to the spawned command.
 */
async function ensureElevation() {
  // The askpass helper lives for the entire Wolffish session. We create it
  // once and reuse it. Since every sudo command gets the -A flag injected,
  // sudo itself will call the helper whenever its OS-level cache expires —
  // we don't need to proactively re-prime. The user sees a native password
  // dialog only when the OS actually needs credentials (controlled by
  // sudoers timestamp_timeout, typically 5–15 min, configurable by the user).
  if (askpassState) {
    return { ok: true, env: askpassState.env }
  }

  const script = await buildAskpassScript()
  if (!script) {
    if (process.platform === 'win32') {
      return {
        ok: false,
        error:
          'operation not permitted (elevation required). ' +
          'Windows does not use sudo. Run this command in an elevated terminal (Run as Administrator), ' +
          'or ask the user to execute it manually.'
      }
    }
    return {
      ok: false,
      error:
        'operation not permitted (elevation required). ' +
        'No GUI password tool found (tried zenity, kdialog, ssh-askpass). ' +
        'Install zenity (`apt install zenity`) or ask the user to run the command in their terminal.'
    }
  }

  const tmpDir = await mkdtemp(path.join(tmpdir(), 'wolffish-askpass-'))
  const askpassPath = path.join(tmpDir, 'askpass.sh')

  try {
    await writeFile(askpassPath, script, 'utf8')
    await chmod(askpassPath, 0o700)
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    return { ok: false, error: `failed to create askpass helper: ${err?.message ?? String(err)}` }
  }

  const env = { ...process.env, SUDO_ASKPASS: askpassPath }

  // Prime sudo's credential cache on first use so the user sees the dialog
  // now rather than mid-command. After this, sudo re-prompts via the askpass
  // helper automatically when the OS cache expires.
  const auth = await runCollect('sudo', ['-A', '-v'], env)

  if (auth.code !== 0) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    const detail = (auth.stderr || '').trim()
    if (!detail || /cancel/i.test(detail)) {
      return {
        ok: false,
        cancelled: true,
        error:
          'operation not permitted (user cancelled the password dialog). ' +
          'Admin access is required to run this command. Try again when ready, ' +
          'or ask the user to run it in their terminal.'
      }
    }
    return {
      ok: false,
      error: `operation not permitted (sudo authentication failed): ${detail.slice(0, 300)}`
    }
  }

  askpassState = { askpassPath, tmpDir, env }
  return { ok: true, env }
}

/**
 * Rewrite a command so that bare `sudo` / `doas` invocations include the
 * -A flag, forcing them to use the SUDO_ASKPASS helper instead of a TTY.
 * This handles chained commands like `sudo cmd1 && sudo cmd2`.
 */
function injectAskpassFlag(command) {
  return command.replace(SUDO_INJECT_RE, (_, ws, keyword, trail) => {
    return `${ws}${keyword} -A${trail}`
  })
}

// ---------------------------------------------------------------------------
// Tool definitions (the model-facing schema is the SKILL.md frontmatter; this
// array is kept in sync for skill_create derivation and tests)
// ---------------------------------------------------------------------------

const toolDefinitions = [
  {
    name: 'shell_exec',
    description:
      'Run a shell command and return its combined stdout+stderr (tail-biased; the full output of a long run is saved to a log file the result names).',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        cwd: {
          type: 'string',
          description:
            'Working directory. Omit it to run in the first working folder (or home when none). Absolute, or relative to the working folder.'
        },
        timeout: {
          type: 'number',
          description:
            'Optional hard limit in ms — the command is killed when it passes. Rarely needed: without it the command runs until it exits and checks in with you (check_in_after) while it does, so you stay in control without killing anything. Ignored when background is true.'
        },
        background: {
          type: 'boolean',
          description:
            'Start the command detached and return immediately with its PID and a log file path. Use for dev servers, watchers, daemons — anything that does not exit on its own. Read the log with file_read; stop it with shell_stop.'
        },
        force: {
          type: 'boolean',
          description:
            'Run a command in the foreground even though it looks like a server/watcher. Only when you are sure it exits on its own.'
        }
      },
      required: ['command']
    }
  },
  {
    name: 'shell_jobs',
    description:
      'List the background processes started with shell_exec background=true in this app session.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'shell_stop',
    description:
      'Stop a background process started with shell_exec background=true (by PID, or all of them).',
    parameters: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: 'PID from shell_exec background / shell_jobs' },
        all: { type: 'boolean', description: 'Stop every background job started this session' }
      }
    }
  }
]

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

// Bounded, tail-biased preview of a command's output (ported from OpenCode's
// shell tool): the LAST 2000 lines / 50 KB stay in the result — a failing
// test run's assertion is at the bottom — and the full text is written to
// <workspace>/tool-output/ so nothing is lost. Memory is capped too: a
// runaway command keeps only its last 8 MB in RAM.
const OUTPUT_MAX_LINES = 2000
const OUTPUT_MAX_BYTES = 50 * 1024
const OUTPUT_MEMORY_CAP = 8 * 1024 * 1024
const TOOL_OUTPUT_DIR = 'tool-output'

// Injected at init: where spilled logs and background logs live.
let workspaceRoot = null

// CSI sequences (colours, cursor moves), OSC sequences (titles, hyperlinks)
// and bare carriage returns used for progress-bar redraws.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\r(?=[^\n])/g

function stripAnsi(text) {
  return text.replace(ANSI_RE, '')
}

function tailBound(text, maxLines = OUTPUT_MAX_LINES, maxBytes = OUTPUT_MAX_BYTES) {
  const lines = text.split('\n')
  if (lines.length <= maxLines && Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return { text, cut: false }
  }
  const out = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], 'utf8') + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        // The last line alone exceeds the byte cap — keep its tail, aligned
        // to a UTF-8 boundary so we never split a character.
        const buf = Buffer.from(lines[i], 'utf8')
        let start = Math.max(0, buf.length - maxBytes)
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString('utf8'))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return { text: out.join('\n'), cut: true }
}

let spillCounter = 0
async function spillFile(prefix) {
  if (!workspaceRoot) return null
  const dir = path.join(workspaceRoot, TOOL_OUTPUT_DIR)
  await mkdir(dir, { recursive: true })
  spillCounter = (spillCounter + 1) % 1000
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  return path.join(dir, `${stamp}-${prefix}-${String(spillCounter).padStart(3, '0')}.log`)
}

// A chronological capture of stdout+stderr with a memory cap.
function makeCapture() {
  const chunks = []
  let used = 0
  let dropped = false
  return {
    push(chunk) {
      const text = chunk.toString()
      const size = Buffer.byteLength(text, 'utf8')
      chunks.push({ text, size })
      used += size
      while (used > OUTPUT_MEMORY_CAP && chunks.length > 1) {
        const first = chunks.shift()
        used -= first.size
        dropped = true
      }
    },
    text() {
      return stripAnsi(chunks.map((c) => c.text).join(''))
    },
    get dropped() {
      return dropped
    }
  }
}

// ---------------------------------------------------------------------------
// Background jobs
// ---------------------------------------------------------------------------

// Every process started with background=true this app session, so the model
// can read its log and stop it — a dev server started to verify a fix must
// be tear-down-able without the user hunting PIDs.
const backgroundJobs = new Map() // pid -> { pid, command, cwd, logPath, startedAt }

function killTree(pid, signal = 'SIGTERM') {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
      return
    }
    // Detached children lead their own process group; -pid signals the group.
    try {
      process.kill(-pid, signal)
    } catch {
      process.kill(pid, signal)
    }
  } catch {
    // already gone
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function stopJob(job) {
  killTree(job.pid, 'SIGTERM')
  await new Promise((r) => setTimeout(r, 1500))
  if (isAlive(job.pid)) {
    killTree(job.pid, 'SIGKILL')
    await new Promise((r) => setTimeout(r, 300))
  }
  backgroundJobs.delete(job.pid)
  return !isAlive(job.pid)
}

function describeJob(job) {
  const alive = isAlive(job.pid)
  const age = Math.round((Date.now() - job.startedAt) / 1000)
  return `PID ${job.pid} (${alive ? 'running' : 'exited'}, ${age}s): ${job.command}\n    cwd: ${job.cwd}\n    log: ${job.logPath}`
}

// ---------------------------------------------------------------------------
// Core execution
// ---------------------------------------------------------------------------

async function execShell(args, signal) {
  if (signal?.aborted) return { success: false, error: 'Stopped by user.' }
  // Bound here, synchronously, while the call's async context is current.
  const reportProgress = progressReporterFactory ? progressReporterFactory() : null

  const command = String(args?.command ?? '').trim()
  if (!command) return { success: false, error: 'empty command' }

  const cwd = resolveCwd(args?.cwd)
  try {
    await access(cwd, constants.F_OK)
  } catch {
    return { success: false, error: `cwd does not exist or is not accessible: ${cwd}` }
  }

  const shell = await detectShell()
  const needsElevation = ELEVATION_RE.test(command)

  // --- Watcher guard ---
  // A server or watcher run in the foreground never returns, and the turn
  // hangs with it. The guard refuses the shape before spawning, names the
  // fix, and stays model-led: force=true runs it anyway.
  if (args?.background !== true && args?.force !== true && looksLikeWatcher(command)) {
    return {
      success: false,
      retryable: false,
      error:
        `This command looks like a server or watcher that does not exit on its own (${command}). ` +
        'Run it with background=true — its output goes to a log file you can read with file_read and it can be stopped with shell_stop — ' +
        'or pass force=true if it really does exit.'
    }
  }

  // --- Elevation handling ---
  // When the command contains sudo/doas/pkexec, we:
  // 1. Prime the credential cache via a native OS password dialog
  // 2. Inject the -A flag so sudo uses the askpass helper (not a TTY)
  // 3. Pass SUDO_ASKPASS in the environment
  // This guarantees the command never hangs waiting for terminal input.
  let execEnv = process.env
  let execCommand = command

  if (needsElevation) {
    let handled = false

    // Preferred path (macOS + Linux): the shared in-memory password session.
    if (sudoCtx && process.platform !== 'win32') {
      const auth = await sudoCtx.ensurePassword()
      if (auth.ok) {
        execEnv = { ...process.env, ...sudoCtx.getElevatedEnv() }
        execCommand = injectAskpassFlag(command)
        handled = true
      } else if (!auth.unsupported) {
        return {
          success: false,
          error: auth.error ?? 'operation not permitted (elevation required)'
        }
      }
    }

    // Fallback: legacy per-session askpass dialog.
    if (!handled) {
      const elevation = await ensureElevation()
      if (!elevation.ok) {
        return { success: false, error: elevation.error }
      }
      execEnv = elevation.env
      execCommand = injectAskpassFlag(command)
      await runCollect('sudo', ['-A', '-v'], execEnv)
    }
  }

  // Plain output: no ANSI colour in captured text (stripped anyway as a
  // backstop), and no pager waiting on a TTY that does not exist.
  execEnv = {
    ...execEnv,
    NO_COLOR: execEnv.NO_COLOR ?? '1',
    FORCE_COLOR: execEnv.FORCE_COLOR ?? '0',
    PAGER: execEnv.PAGER ?? 'cat',
    GIT_PAGER: execEnv.GIT_PAGER ?? 'cat'
  }

  // Applied after elevation rewriting so both dispatch paths get the same
  // command text. No-op on cmd.exe and /bin/sh.
  execCommand = stripRedundantStderrMerge(execCommand, shell)

  if (args?.background === true) {
    if (processesHost) {
      const started = await processesHost.start({
        command: execCommand,
        cwd,
        env: Object.fromEntries(Object.entries(execEnv).filter(([k]) => !(k in process.env))),
        wait: false,
        origin: { conversationId: null, kind: 'shell' }
      })
      if (!started.ok) return { success: false, error: started.error ?? 'failed to start background process' }
      return {
        success: true,
        output:
          `Started in background as managed process "${started.name}" (PID ${started.pid}).` +
          (started.logPath ? ` Log: ${started.logPath} — read it with process_logs name=${started.name} once it has had a moment to start.` : '') +
          ` It keeps running after this turn; process_status / process_stop name=${started.name} manage it (process_start is the better tool for servers: it picks a free port and waits for readiness).`,
        meta: { label: 'Start in background', cwd, outputPath: started.logPath ?? undefined }
      }
    }
    return execBackground({ command: execCommand, display: command, cwd, shell, env: execEnv })
  }

  const timeoutMs = typeof args?.timeout === 'number' && args.timeout > 0 ? args.timeout : 0

  const result = await execForeground({
    command: execCommand,
    display: command,
    cwd,
    shell,
    timeoutMs,
    reportProgress,
    env: execEnv,
    signal
  })
  if (result.success) {
    // If the command installed something onto PATH, re-read the PATH so the new
    // tool is reachable by the next tool call without an app restart.
    if (PATH_MUTATING_RE.test(command)) {
      await refreshWolffishPath()
    }
  }
  return result
}

async function execBackground({ command, display, cwd, shell, env }) {
  let logPath = null
  let logFd = null
  try {
    logPath = await spillFile('bg')
    if (logPath) logFd = await open(logPath, 'a')
  } catch {
    logPath = null
    logFd = null
  }
  try {
    const stdio = logFd ? ['ignore', logFd.fd, logFd.fd] : 'ignore'
    const child = spawn(shell.bin, [...shell.args, command], {
      cwd,
      env,
      detached: true,
      stdio,
      windowsHide: true
    })
    const pid = child.pid
    if (!pid) {
      await logFd?.close().catch(() => {})
      return { success: false, error: 'failed to start background process (no PID returned)' }
    }
    child.unref()
    // The fd is inherited by the child; our handle can close now.
    await logFd?.close().catch(() => {})
    const job = { pid, command: display, cwd, logPath, startedAt: Date.now() }
    backgroundJobs.set(pid, job)
    return {
      success: true,
      output:
        `Started in background, PID: ${pid}.` +
        (logPath
          ? ` Output log: ${logPath} — read it with file_read (or tail -n 50 "${logPath}") once the process has had a moment to start.`
          : ' (No log file available.)') +
        ` Stop it with shell_stop(pid=${pid}).`,
      meta: { label: 'Start in background', cwd, outputPath: logPath ?? undefined }
    }
  } catch (err) {
    await logFd?.close().catch(() => {})
    return { success: false, error: err?.message ?? String(err) }
  }
}

function execForeground({ command, display, cwd, shell, timeoutMs, env, signal, reportProgress }) {
  const startedAt = Date.now()
  const label = describeCommand(display).label
  // Output-rate window for the check-in report: (timestamp, bytes) pairs
  // from the last 30 s. Cheap to keep; only read when the command runs long.
  const recent = []
  const noteChunk = (bytes) => {
    const now = Date.now()
    recent.push([now, bytes])
    while (recent.length > 0 && now - recent[0][0] > 30_000) recent.shift()
  }
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(shell.bin, [...shell.args, command], {
        cwd,
        env,
        // stdin is 'ignore' so processes that unexpectedly block on input
        // get EOF immediately instead of hanging forever. stdout/stderr are
        // piped for capture. detached on POSIX so the whole process group can
        // be killed on stop/timeout.
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32'
      })
    } catch (err) {
      resolve({ success: false, error: err?.message ?? String(err) })
      return
    }

    const capture = makeCapture()
    let stderrOnly = ''
    let stdoutSeen = false
    let resolved = false
    let timer = null
    let onAbort = null

    if (reportProgress) {
      // A function, computed on demand: the check-in reads it once when the
      // command runs long, so a chatty command costs nothing per chunk.
      reportProgress(() => {
        const now = Date.now()
        const bytes = recent.reduce((n, [, b]) => n + b, 0)
        const span = recent.length > 0 ? Math.max(1, (now - recent[0][0]) / 1000) : 0
        const rate =
          recent.length > 0
            ? `${Math.round(bytes / span)} B/s over the last ${Math.round(span)}s`
            : 'no output in the last 30s'
        const text = stripAnsi(capture.text())
        const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
        const tail = lines.slice(-20).join('\n')
        const head = `Output rate: ${rate}. ${lines.length} line(s) so far${lines.length > 20 ? ' (last 20 shown)' : ''}.`
        return tail ? `${head}\n${tail}` : `${head}\n(nothing printed yet)`
      })
    }

    const finalize = async (base) => {
      const raw = capture.text().trim()
      const bounded = tailBound(raw)
      let output = bounded.text
      let outputPath
      if (bounded.cut || capture.dropped) {
        try {
          outputPath = await spillFile('shell')
          if (outputPath) await writeFile(outputPath, raw, 'utf8')
        } catch {
          outputPath = undefined
        }
        const note = capture.dropped
          ? '...output truncated (only the last 8 MB were kept)...'
          : '...output truncated...'
        output =
          `${note}\n\n` +
          (outputPath
            ? `Full output saved to: ${outputPath}\nUse file_grep to search it or file_read with startLine/endLine to view specific sections.\n\n`
            : '') +
          output
      }
      const meta = {
        label,
        cwd,
        durationMs: Date.now() - startedAt,
        exitCode: base.exitCode ?? null,
        truncated: bounded.cut || capture.dropped,
        // We already applied the model-context cap, tail-biased — the motor
        // must not head-bound this text again and throw away the failure at
        // the bottom. (`truncated` alone cannot say this: file_grep sets it
        // to mean "more matches than the limit" on text that IS unbounded.)
        outputBounded: bounded.cut || capture.dropped
      }
      if (outputPath) meta.outputPath = outputPath
      return { ...base, output: output || base.output, meta }
    }

    const finish = (result) => {
      if (resolved) return
      resolved = true
      if (timer) clearTimeout(timer)
      if (signal && onAbort) signal.removeEventListener('abort', onAbort)
      void finalize(result).then(resolve)
    }

    // The command's shell spawns descendants; a plain child.kill leaves them
    // running. Kill the whole tree: taskkill on Windows, the process group
    // elsewhere (the child is detached, so it leads its own group).
    const kill = () => {
      if (child.pid) killTree(child.pid, 'SIGKILL')
      else {
        try {
          child.kill('SIGKILL')
        } catch {
          // already dead
        }
      }
    }

    if (signal) {
      if (signal.aborted) {
        kill()
        finish({ success: false, error: 'Stopped by user.', output: '' })
        return
      }
      onAbort = () => {
        kill()
        finish({ success: false, error: 'Stopped by user.', output: '' })
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        kill()
        finish({
          success: false,
          error: `Command timed out after ${timeoutMs}ms (a hard limit you set). Decide from what it printed: a narrower command, a managed process (process_start) for something that must keep running, or the same command with no timeout — it will check in with you while it runs.`,
          output: ''
        })
      }, timeoutMs)
    }

    child.stdout?.on('data', (chunk) => {
      stdoutSeen = true
      capture.push(chunk)
      noteChunk(chunk.length)
    })
    child.stderr?.on('data', (chunk) => {
      capture.push(chunk)
      noteChunk(chunk.length)
      if (stderrOnly.length < 20_000) stderrOnly += chunk.toString()
    })
    child.on('error', (err) => {
      finish({ success: false, error: err?.message ?? String(err) })
    })
    child.on('close', (code) => {
      const combined = capture.text().trim()
      if (code === 0) {
        finish({ success: true, output: combined || '(no output)', exitCode: 0 })
        return
      }
      // Exit code 1 with no output at all is the universal "no match / nothing
      // found" signal for query tools — grep (1 = no lines matched), find/ls on
      // an absent path, test, and any pipeline ending in one of them. That is a
      // valid empty result, not a failure. Reporting it as a failure made the
      // motor retry a deterministic no-match three times and handed the model a
      // blind "(unknown)" error with zero signal. Surface it as a clean empty
      // result. Exit codes >= 2 still mean a real error (e.g. grep 2 = read
      // error) and fall through to the failure path below.
      if (code === 1 && !combined) {
        finish({
          success: true,
          output: '(no matches — command exited 1 with no output)',
          exitCode: 1
        })
        return
      }
      // `grep -c` (and `grep -c -r`) print a tally and exit 1 when the total
      // count is zero — "0" for a single file, "<file>:0" per file with -r.
      // The number IS the result, not an error. Treat a stderr-free exit-1
      // whose stdout is only zero-counts as a clean empty result.
      if (code === 1 && !stderrOnly.trim() && stdoutSeen && combined) {
        const lines = combined.split(/\r?\n/)
        if (lines.every((l) => /^(?:.+:)?0$/.test(l.trim()))) {
          finish({ success: true, output: combined, exitCode: 1 })
          return
        }
      }
      const diagnostic = buildDiagnostic(combined, stderrOnly, command)
      const partial = combined.length > 100
      finish({
        success: false,
        exitCode: code,
        partial,
        error: diagnostic
          ? `Command exited with code ${code}: ${diagnostic}`
          : `Command exited with code ${code} (no output captured — if you redirected stderr with 2>/dev/null, drop it so the cause is visible)`,
        output: combined
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

// The model's classified error line: the tail of the combined output (where
// a failing run reports its failure) plus the head of stderr when stderr
// carried something distinct. Short by design — the tool result's `output`
// carries the bounded full text alongside.
function buildDiagnostic(combined, stderr, command) {
  const err = stderr.trim()
  const out = combined.trim()

  if (!err && ELEVATION_RE.test(command) && out.length < 200) {
    return `operation not permitted (non-interactive shell, elevation required)\n${out}`
  }
  if (!out) return err.slice(0, 300)
  if (out.length <= 600) return out
  const tail = out.slice(-400)
  const head = err && !out.startsWith(err.slice(0, 40)) ? `${err.slice(0, 200)}\n---\n` : ''
  return `${head}…${tail}`
}

// ---------------------------------------------------------------------------
// Risk descriptions (for the approval card UI)
// ---------------------------------------------------------------------------

function describeShellAction(command) {
  const cmd = String(command ?? '').trim()
  const described = describeCommand(cmd)
  const out = {
    title: 'Run shell command',
    description: described.label,
    command: cmd,
    risk: described.risk
  }
  if (described.impact) out.impact = described.impact
  return out
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

const plugin = {
  name: 'shell',
  tools: toolDefinitions,
  async init(context) {
    sudoCtx = context?.sudo ?? null
    processesHost = context?.processes ?? null
    progressReporterFactory =
      typeof context?.progressReporter === 'function' ? context.progressReporter : null
    if (typeof context?.getWorkingFolders === 'function') {
      getWorkingFolders = context.getWorkingFolders
    }
    if (typeof context?.workspaceRoot === 'string' && context.workspaceRoot) {
      workspaceRoot = context.workspaceRoot
    }
  },
  // A read-only turn (plan mode, explore agents) asks per call: `git status`
  // observes, `git push` acts. Conservative allowlist — see tokenize.mjs.
  isReadOnlyCall(toolName, args) {
    if (toolName === 'shell_jobs') return true
    if (toolName !== 'shell_exec') return false
    const command = typeof args?.command === 'string' ? args.command : ''
    // Checks (tests, type-check, lint) count as investigation: a plan that
    // cannot reproduce the failure is a guess.
    return (
      command.length > 0 &&
      args?.background !== true &&
      (isReadOnly(command) || isInvestigation(command))
    )
  },
  describeAction(toolName, args) {
    if (toolName === 'shell_exec') return describeShellAction(args?.command)
    if (toolName === 'shell_stop') {
      return {
        title: 'Stop background process',
        description: args?.all ? 'Stop every background job' : `Stop PID ${args?.pid}`,
        risk: 'low'
      }
    }
    return null
  },
  async execute(toolName, args, signal) {
    if (toolName === 'shell_exec') return execShell(args, signal)
    if (toolName === 'shell_jobs') {
      if (processesHost) {
        const jobs = processesHost.list()
        if (jobs.length === 0) return { success: true, output: 'No managed processes. process_start creates one.' }
        return {
          success: true,
          output: jobs
            .map((j) => `${j.name}: ${j.state}${j.pid ? ` (PID ${j.pid})` : ''} — ${j.command}\n    cwd: ${j.cwd}${j.logPath ? `\n    log: ${j.logPath}` : ''}`)
            .join('\n')
        }
      }
      if (backgroundJobs.size === 0) {
        return { success: true, output: 'No background jobs started this session.' }
      }
      return { success: true, output: [...backgroundJobs.values()].map(describeJob).join('\n') }
    }
    if (toolName === 'shell_stop') {
      if (processesHost) {
        if (args?.all === true) {
          const results = await processesHost.stopAll()
          if (results.length === 0) return { success: true, output: 'No managed processes to stop.' }
          return { success: true, output: results.map((r) => `${r.name}: ${r.stopped ? 'stopped' : 'was not running'}`).join('\n') }
        }
        const pid = Number(args?.pid)
        const name = typeof args?.name === 'string' && args.name.trim() ? args.name.trim() : Number.isInteger(pid) && pid > 0 ? processesHost.findByPid(pid) : null
        if (!name) {
          if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
            await stopJob({ pid, command: '(not managed)', cwd: '', logPath: '', startedAt: Date.now() })
            return { success: true, output: `Stopped PID ${pid} (not a managed process).` }
          }
          return { success: false, error: 'Pass name (from shell_jobs / process_list), pid, or all=true.' }
        }
        const res = await processesHost.stop(name)
        if (!res.ok) return { success: false, error: res.error ?? 'stop failed' }
        return { success: true, output: res.stopped ? `Stopped ${name}.` : `${name} was not running.` }
      }
      if (args?.all === true) {
        const jobs = [...backgroundJobs.values()]
        if (jobs.length === 0) return { success: true, output: 'No background jobs to stop.' }
        const results = []
        for (const job of jobs) {
          results.push(`PID ${job.pid}: ${(await stopJob(job)) ? 'stopped' : 'still running'}`)
        }
        return { success: true, output: results.join('\n') }
      }
      const pid = Number(args?.pid)
      if (!Number.isInteger(pid) || pid <= 0) {
        return {
          success: false,
          error: 'Pass pid (from shell_exec background / shell_jobs) or all=true.'
        }
      }
      const job = backgroundJobs.get(pid) ?? {
        pid,
        command: '(not started by shell_exec)',
        cwd: '',
        logPath: '',
        startedAt: Date.now()
      }
      if (!isAlive(pid)) {
        backgroundJobs.delete(pid)
        return { success: true, output: `PID ${pid} is not running.` }
      }
      const stopped = await stopJob(job)
      return stopped
        ? { success: true, output: `Stopped PID ${pid} (${job.command}).` }
        : { success: false, error: `PID ${pid} is still running after SIGTERM and SIGKILL.` }
    }
    return { success: false, error: `shell: unknown tool ${toolName}` }
  }
}

export default plugin
