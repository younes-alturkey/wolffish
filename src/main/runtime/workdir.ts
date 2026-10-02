/**
 * Working-folder intelligence for a turn: what kind of project each working
 * folder is, its git state, the check commands it exposes, and the
 * instruction files (AGENTS.md / CLAUDE.md) that should govern work inside it.
 *
 * Two consumers, two cache profiles:
 *
 * - `describeWorkingFolders` renders the live facts (branch, dirty count,
 *   detected toolchain) for the outbound VOLATILE TAIL — computed once per
 *   turn next to the folder listing, never baked into persisted content.
 * - `buildInstructionsOverlay` renders the instruction files for the PINNED
 *   system prompt. They change rarely, so they belong in the cached prefix
 *   rather than the tail; the agent computes them once per turn beside the
 *   project overlay.
 *
 * Everything here is best-effort and bounded: every git call has a timeout,
 * every read is capped, and a failure degrades to "no facts" rather than a
 * throw — this runs on the hot path of every turn that has a working folder.
 *
 * Discovery rules mirror OpenCode's instruction.ts: from the folder up to the
 * repository root, the first NAME that matches anywhere wins (all of its
 * ancestors stack; AGENTS.md and CLAUDE.md never both load), and files nested
 * deeper than the folder attach lazily the first time a file under them is
 * read (see `findNestedInstructionFile`).
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const GIT_TIMEOUT_MS = 3_000
/** Per instruction file. */
export const INSTRUCTION_FILE_MAX_CHARS = 24_000
/** Across every instruction file in one overlay. */
export const INSTRUCTIONS_OVERLAY_MAX_CHARS = 32_000
const INSTRUCTION_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md'] as const
const MAKEFILE_TARGET_MAX = 12
const SCRIPTS_MAX = 16

export type GitFacts = {
  root: string
  branch: string
  /** Modified + untracked entries from `git status --porcelain`. */
  dirty: number
  lastCommit: string
}

export type FolderFacts = {
  folder: string
  git: GitFacts | null
  /** One-line toolchain summary, e.g. "npm (package-lock.json) · TypeScript · ESLint". */
  toolchain: string
  /** Candidate check commands in verify order (narrow → broad). */
  checks: string[]
  /** Dev / run entry points that do not exit on their own. */
  runs: string[]
  /** True when the folder looks like a code project (git or a manifest). */
  code: boolean
}

function run(cmd: string, args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        cmd,
        args,
        { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (err, stdout) => resolve(err ? null : String(stdout))
      )
    } catch {
      resolve(null)
    }
  })
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function readJson(p: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(p, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function readText(p: string, cap = 64 * 1024): Promise<string | null> {
  try {
    const fh = await fs.open(p, 'r')
    try {
      const buf = Buffer.alloc(cap)
      const { bytesRead } = await fh.read(buf, 0, cap, 0)
      return buf.subarray(0, bytesRead).toString('utf8')
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
}

export async function gitFacts(folder: string): Promise<GitFacts | null> {
  const root = (await run('git', ['rev-parse', '--show-toplevel'], folder))?.trim()
  if (!root) return null
  const [branch, status, last] = await Promise.all([
    run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], folder),
    run('git', ['status', '--porcelain', '--untracked-files=normal'], folder),
    run('git', ['log', '-1', '--format=%h %s'], folder)
  ])
  const dirty = status ? status.split('\n').filter((l) => l.trim().length > 0).length : 0
  return {
    root: path.resolve(root),
    branch: branch?.trim() || 'HEAD',
    dirty,
    lastCommit: (last?.trim() ?? '').slice(0, 96)
  }
}

type Manifest = {
  toolchain: string[]
  checks: string[]
  runs: string[]
}

/**
 * Read the manifests a folder carries and derive the toolchain line plus the
 * candidate check/run commands. Detection is by file presence and script
 * names only — cheap, deterministic, and explicitly labelled "detected" in
 * the tail so the model verifies before relying on a command.
 */
async function detectManifest(folder: string): Promise<Manifest> {
  const toolchain: string[] = []
  const checks: string[] = []
  const runs: string[] = []
  const has = async (name: string): Promise<boolean> => exists(path.join(folder, name))

  // ── JavaScript / TypeScript ────────────────────────────────────────────
  const pkg = await readJson(path.join(folder, 'package.json'))
  if (pkg) {
    const pm =
      (await has('bun.lockb')) || (await has('bun.lock'))
        ? 'bun'
        : (await has('pnpm-lock.yaml'))
          ? 'pnpm'
          : (await has('yarn.lock'))
            ? 'yarn'
            : 'npm'
    const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : ''
    const manager = declared || pm
    const scripts =
      pkg.scripts && typeof pkg.scripts === 'object'
        ? Object.keys(pkg.scripts as Record<string, unknown>)
        : []
    const shown = scripts.slice(0, SCRIPTS_MAX)
    toolchain.push(
      `${manager} (package.json${scripts.length > 0 ? `; scripts: ${shown.join(', ')}${scripts.length > shown.length ? ', …' : ''}` : ''})`
    )
    const deps = {
      ...((pkg.dependencies as Record<string, unknown>) ?? {}),
      ...((pkg.devDependencies as Record<string, unknown>) ?? {})
    }
    if ((await has('tsconfig.json')) || 'typescript' in deps) toolchain.push('TypeScript')
    if ('eslint' in deps) toolchain.push('ESLint')
    if ('prettier' in deps) toolchain.push('Prettier')
    if ('@biomejs/biome' in deps) toolchain.push('Biome')
    if ('vitest' in deps) toolchain.push('Vitest')
    else if ('jest' in deps) toolchain.push('Jest')
    if ('electron' in deps) toolchain.push('Electron')
    if ('next' in deps) toolchain.push('Next.js')
    else if ('vite' in deps) toolchain.push('Vite')
    const runScript = (name: string): string =>
      manager === 'npm' && (name === 'test' || name === 'start')
        ? `npm ${name}`
        : `${manager} run ${name}`
    const pick = (pred: (s: string) => boolean): string[] => scripts.filter(pred)
    for (const s of pick((s) => /^(typecheck|type-check|tsc|check-types|types)(:|$)/.test(s)))
      checks.push(runScript(s))
    for (const s of pick((s) => /^lint(:|$)/.test(s) && !/fix/.test(s))) checks.push(runScript(s))
    for (const s of pick((s) => /^test(:|$)/.test(s) && !/watch/.test(s))) checks.push(runScript(s))
    for (const s of pick((s) => /^build(:|$)/.test(s))) checks.push(runScript(s))
    for (const s of pick((s) => /^(dev|start|serve|preview)(:|$)/.test(s))) runs.push(runScript(s))
    if (checks.length === 0 && (await has('tsconfig.json'))) checks.push('npx tsc --noEmit')
  }

  // ── Python ─────────────────────────────────────────────────────────────
  const pyproject = await readText(path.join(folder, 'pyproject.toml'))
  const hasReq = await has('requirements.txt')
  if (pyproject || hasReq || (await has('setup.py')) || (await has('setup.cfg'))) {
    const parts: string[] = []
    if (await has('uv.lock')) parts.push('uv')
    else if (await has('poetry.lock')) parts.push('poetry')
    else if (await has('Pipfile')) parts.push('pipenv')
    else parts.push('pip')
    toolchain.push(
      `Python (${parts.join(', ')}${pyproject ? '; pyproject.toml' : hasReq ? '; requirements.txt' : ''})`
    )
    const uses = (needle: string): boolean => !!pyproject && pyproject.includes(needle)
    if (uses('[tool.ruff]') || (await has('ruff.toml')) || (await has('.ruff.toml'))) {
      toolchain.push('Ruff')
      checks.push('ruff check .')
    }
    if (uses('[tool.mypy]') || (await has('mypy.ini'))) checks.push('mypy .')
    if (uses('[tool.pyright]') || (await has('pyrightconfig.json'))) checks.push('pyright')
    if (
      uses('[tool.pytest') ||
      (await has('pytest.ini')) ||
      (await has('conftest.py')) ||
      (await has('tests'))
    )
      checks.push('pytest')
  }

  // ── Rust / Go / others ─────────────────────────────────────────────────
  if (await has('Cargo.toml')) {
    toolchain.push('Rust (Cargo.toml)')
    checks.push('cargo check', 'cargo clippy', 'cargo test')
    runs.push('cargo run')
  }
  if (await has('go.mod')) {
    toolchain.push('Go (go.mod)')
    checks.push('go build ./...', 'go vet ./...', 'go test ./...')
  }
  if (await has('Package.swift')) {
    toolchain.push('Swift package (Package.swift)')
    checks.push('swift build', 'swift test')
  } else {
    try {
      const entries = await fs.readdir(folder)
      const ws = entries.find((e) => e.endsWith('.xcworkspace'))
      const proj = entries.find((e) => e.endsWith('.xcodeproj'))
      if (ws || proj) {
        toolchain.push(`Xcode (${ws ?? proj})`)
        checks.push(
          `xcodebuild -${ws ? 'workspace' : 'project'} ${ws ?? proj} -scheme <scheme> -destination 'platform=iOS Simulator,name=iPhone 17' build`
        )
        runs.push(
          'xcode_run (xcode_defaults scheme=<scheme> first) → mobile_snapshot / mobile_tap on the simulator'
        )
      }
    } catch {
      // unreadable folder — no facts
    }
  }
  // React Native / Expo: a package manifest beside ios/ and android/ folders
  // (Expo adds app.json or app.config.*). The run path is the framework's own
  // command, then the mobile tools drive the running app.
  if (await has('package.json')) {
    const hasIos = await has('ios')
    const hasAndroid = await has('android')
    const expo =
      (await has('app.json')) || (await has('app.config.js')) || (await has('app.config.ts'))
    if (hasIos || hasAndroid) {
      toolchain.push(expo ? 'Expo (app.json + ios/ android/)' : 'React Native (ios/ android/)')
      if (hasIos)
        runs.push(
          expo
            ? 'npx expo run:ios (shell_exec background=true) → mobile_snapshot / mobile_tap'
            : 'npx react-native run-ios (shell_exec background=true) → mobile_snapshot / mobile_tap'
        )
      if (hasAndroid)
        runs.push(
          expo
            ? 'npx expo run:android (shell_exec background=true, emulator via mobile_boot) → mobile_snapshot'
            : 'npx react-native run-android (shell_exec background=true, emulator via mobile_boot) → mobile_snapshot'
        )
    }
  }
  if (await has('pubspec.yaml')) {
    toolchain.push('Flutter/Dart (pubspec.yaml)')
    checks.push('dart analyze', 'flutter test')
    runs.push(
      'flutter run -d <udid or serial> (shell_exec background=true; mobile_devices lists ids) → mobile_snapshot / mobile_tap'
    )
  }
  if ((await has('build.gradle')) || (await has('build.gradle.kts'))) {
    toolchain.push('Gradle')
    checks.push('./gradlew build', './gradlew test')
    if (await has('app')) {
      runs.push(
        './gradlew assembleDebug (shell_exec) → mobile_install app=app/build/outputs/apk/debug/app-debug.apk → mobile_launch bundle_id=<package> → mobile_snapshot'
      )
    }
  } else if (await has('pom.xml')) {
    toolchain.push('Maven (pom.xml)')
    checks.push('mvn -q test')
  }
  if (await has('Gemfile')) {
    toolchain.push('Ruby (Gemfile)')
    checks.push('bundle exec rspec')
  }
  if (await has('composer.json')) {
    toolchain.push('PHP (composer.json)')
    checks.push('composer test')
  }
  if (await has('CMakeLists.txt')) {
    toolchain.push('CMake')
    checks.push('cmake --build build')
  }
  if ((await has('Dockerfile')) || (await has('docker-compose.yml')) || (await has('compose.yaml')))
    toolchain.push('Docker')

  // ── Makefile targets ───────────────────────────────────────────────────
  const makefile = await readText(path.join(folder, 'Makefile'), 32 * 1024)
  if (makefile) {
    const targets = [
      ...new Set(
        makefile
          .split('\n')
          .map((l) => /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(l)?.[1])
          .filter((t): t is string => !!t && !t.startsWith('.'))
      )
    ]
    toolchain.push(
      `Makefile${targets.length > 0 ? ` (targets: ${targets.slice(0, MAKEFILE_TARGET_MAX).join(', ')}${targets.length > MAKEFILE_TARGET_MAX ? ', …' : ''})` : ''}`
    )
    for (const t of targets) {
      if (/^(check|lint|typecheck|test|tests|build)$/.test(t)) checks.push(`make ${t}`)
      if (/^(dev|run|serve|start)$/.test(t)) runs.push(`make ${t}`)
    }
  }

  return { toolchain, checks: [...new Set(checks)], runs: [...new Set(runs)] }
}

export async function describeFolder(folder: string): Promise<FolderFacts> {
  const [git, manifest] = await Promise.all([gitFacts(folder), detectManifest(folder)])
  return {
    folder,
    git,
    toolchain: manifest.toolchain.join(' · '),
    checks: manifest.checks,
    runs: manifest.runs,
    code: !!git || manifest.toolchain.length > 0
  }
}

/** True when any working folder is a code project — gates the coding overlay. */
export function anyCodeFolder(facts: FolderFacts[]): boolean {
  return facts.some((f) => f.code)
}

/**
 * The live facts block for the volatile tail. Rendered next to the folder
 * listing; the first line states the default cwd contract so the model
 * never has to guess where `shell_exec` and relative paths land.
 */
export function renderFolderFacts(facts: FolderFacts[]): string {
  if (facts.length === 0) return ''
  const lines: string[] = ['<working_folder_facts>']
  lines.push(
    `Default cwd for shell_exec and the base for relative file paths: ${facts[0].folder} (pass cwd/an absolute path to work elsewhere).`
  )
  for (const f of facts) {
    const parts: string[] = []
    if (f.git) {
      parts.push(
        `git ${f.git.branch}${f.git.dirty > 0 ? `, ${f.git.dirty} changed/untracked` : ', clean'}${f.git.lastCommit ? `, last commit ${f.git.lastCommit}` : ''}${f.git.root !== f.folder ? ` (repo root ${f.git.root})` : ''}`
      )
    }
    if (f.toolchain) parts.push(f.toolchain)
    if (parts.length === 0) continue
    lines.push(`- ${f.folder}: ${parts.join(' · ')}`)
    if (f.checks.length > 0) {
      lines.push(
        `    Detected check commands (verify before relying on them): ${f.checks.join('; ')}`
      )
    }
    if (f.runs.length > 0) {
      lines.push(
        `    Detected run commands (do not exit on their own — use background=true): ${f.runs.join('; ')}`
      )
    }
  }
  if (lines.length === 2) return ''
  lines.push('</working_folder_facts>')
  return lines.join('\n')
}

export async function describeWorkingFolders(folders: string[]): Promise<{
  facts: FolderFacts[]
  block: string
}> {
  const facts = await Promise.all(folders.slice(0, 8).map((f) => describeFolder(f)))
  return { facts, block: renderFolderFacts(facts) }
}

/**
 * Instruction files for one folder: walk from the folder up to its git root
 * (or just the folder when it is not in a repo); the first NAME with any
 * match wins and all of its matches stack, nearest last so the closest file
 * has the final word when the model reads them in order.
 */
export async function findInstructionFiles(
  folder: string,
  gitRoot?: string | null
): Promise<string[]> {
  const root = gitRoot ? path.resolve(gitRoot) : path.resolve(folder)
  const dirs: string[] = []
  let cur = path.resolve(folder)
  // Walk up until we pass the root; guard against a folder outside its
  // supposed root (or a filesystem root) with a hard cap.
  for (let i = 0; i < 64; i++) {
    dirs.push(cur)
    if (cur === root) break
    const parent = path.dirname(cur)
    if (parent === cur || !cur.startsWith(root)) break
    cur = parent
  }
  for (const name of INSTRUCTION_FILE_NAMES) {
    const found: string[] = []
    for (const dir of dirs) {
      const candidate = path.join(dir, name)
      if (await exists(candidate)) found.push(candidate)
    }
    if (found.length > 0) return found.reverse() // root first, nearest last
  }
  return []
}

export function formatInstructionFile(file: string, content: string): string {
  let body = content.trim()
  if (body.length > INSTRUCTION_FILE_MAX_CHARS) {
    body =
      body.slice(0, INSTRUCTION_FILE_MAX_CHARS) +
      `\n[… truncated at ${INSTRUCTION_FILE_MAX_CHARS} chars — read the file for the rest]`
  }
  return `<instructions_file path="${file}">\n${body}\n</instructions_file>`
}

/**
 * The pinned-prompt overlay: every instruction file for the turn's working
 * folders, verbatim, capped. Empty string when there are none.
 */
export async function buildInstructionsOverlay(facts: FolderFacts[]): Promise<string> {
  const seen = new Set<string>()
  const blocks: string[] = []
  let total = 0
  for (const f of facts) {
    const files = await findInstructionFiles(f.folder, f.git?.root ?? null)
    for (const file of files) {
      if (seen.has(file)) continue
      seen.add(file)
      const content = await readText(file, INSTRUCTION_FILE_MAX_CHARS + 1024)
      if (!content || !content.trim()) continue
      const block = formatInstructionFile(file, content)
      if (total + block.length > INSTRUCTIONS_OVERLAY_MAX_CHARS) {
        blocks.push(
          `<instructions_file path="${file}">\n[not inlined — overlay budget reached; read the file]\n</instructions_file>`
        )
        continue
      }
      total += block.length
      blocks.push(block)
    }
  }
  if (blocks.length === 0) return ''
  return (
    `\n\n<project_instruction_files>\n` +
    `These instruction files live in the working folder(s). They describe the project's conventions, commands and gotchas — follow them; a project's own instructions outrank general doctrine.\n` +
    blocks.join('\n') +
    `\n</project_instruction_files>`
  )
}

/**
 * Lazy nested discovery: given a file the model just read and the turn's
 * working folders, return the nearest AGENTS.md / CLAUDE.md strictly BELOW
 * the containing working folder (the folder's own file is already pinned).
 * Null when there is none or the file is outside every working folder.
 */
export async function findNestedInstructionFile(
  filePath: string,
  folders: string[]
): Promise<string | null> {
  const abs = path.resolve(filePath)
  const containing = folders
    .map((f) => path.resolve(f))
    .filter((f) => abs.startsWith(f + path.sep))
    .sort((a, b) => b.length - a.length)[0]
  if (!containing) return null
  let dir = path.dirname(abs)
  for (let i = 0; i < 64 && dir !== containing && dir.startsWith(containing); i++) {
    for (const name of INSTRUCTION_FILE_NAMES) {
      const candidate = path.join(dir, name)
      if (candidate === abs) continue
      if (await exists(candidate)) return candidate
    }
    dir = path.dirname(dir)
  }
  return null
}

/** The system-reminder wrapper appended to a read result for a nested file. */
export function formatNestedInstructionReminder(file: string, content: string): string {
  return `\n\n<system-reminder>\nInstructions from: ${file}\n${content.trim().slice(0, INSTRUCTION_FILE_MAX_CHARS)}\n</system-reminder>`
}

export async function readInstructionFile(file: string): Promise<string | null> {
  return readText(file, INSTRUCTION_FILE_MAX_CHARS + 1024)
}
