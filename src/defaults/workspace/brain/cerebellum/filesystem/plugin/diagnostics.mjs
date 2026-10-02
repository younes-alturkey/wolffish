// After-edit diagnostics for file_edit / file_write. The plugin calls
// `diagnoseFile(file, rootHint)` once the bytes are on disk and appends the
// ERRORS (never warnings) to the tool result so the model fixes type and lint
// mistakes in the same turn instead of discovering them at build time.
//
// OpenCode does this through an LSP client. We use the project's OWN tools —
// its `typescript` (long-lived tsserver over stdio), its `eslint`, and
// `ruff` / `pyright` from PATH — which is cheaper, needs no language-server
// install, and can never drift from what the project's build actually runs.
//
// Contract:
//   diagnoseFile(file, rootHint)
//     → null   no tool applies (unknown language, no tsconfig + no eslint
//              config, ruff/pyright not installed) or the tool failed/timed out
//     → { tool, errors: [{ line, col, message, code? }], truncated, total }
//              `errors` is [] when the tool ran clean. Capped at MAX_ERRORS
//              (`truncated: true`, `total` = the uncapped count).
//   Never throws. Whole call bounded by CALL_BUDGET_MS.
//
// Language rules:
//   TS/JS   tsserver (needs `typescript` in the nearest package.json AND a
//           tsconfig.json at/above the file) then eslint (needs `eslint` in
//           the same package.json, its bin, and a config). Either half may be
//           absent; both absent → null.
//   Python  ruff from PATH; pyright from PATH when a pyrightconfig.json or a
//           `[tool.pyright]` pyproject table is at/above the file.
//   Go/Rust/others: not covered yet → null. See `diagnoseFile`'s switch for
//           the extension point (add a case per language family that returns
//           a { tool, errors, truncated } or null).

import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export const MAX_ERRORS = 20
const CALL_BUDGET_MS = 12_000
const TSSERVER_IDLE_MS = 5 * 60 * 1000
const TSSERVER_KILL_GRACE_MS = 2_000

const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
const ESLINT_EXTS = new Set([...TS_EXTS, '.vue'])
const PY_EXTS = new Set(['.py', '.pyi'])
const ESLINT_CONFIGS = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yaml',
  '.eslintrc.yml'
]

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {string} file absolute (or cwd-relative) path of the file just written
 * @param {string} [rootHint] project root; directory walks stop here
 * @returns {Promise<null | { tool: string, errors: Array<{ line: number, col: number, message: string, code?: string }>, truncated: boolean }>}
 */
export async function diagnoseFile(file, rootHint) {
  try {
    const given = path.resolve(String(file ?? ''))
    if (!given || !fs.existsSync(given)) return null
    // Real paths throughout: eslint's flat config treats a file reached via a
    // symlinked spelling (macOS /tmp → /private/tmp, a linked home) as
    // "outside of base path" and silently ignores it, and the tsserver cache
    // must key one project one way.
    const abs = await fsp.realpath(given)
    const root = rootHint ? await fsp.realpath(path.resolve(String(rootHint))).catch(() => path.resolve(String(rootHint))) : undefined
    const deadline = Date.now() + CALL_BUDGET_MS
    const ext = path.extname(abs).toLowerCase()

    if (TS_EXTS.has(ext) || ESLINT_EXTS.has(ext)) return await diagnoseJsTs(abs, root, deadline, ext)
    if (PY_EXTS.has(ext)) return await diagnosePython(abs, root, deadline)
    // Extension point: Go (`go vet`), Rust (`cargo check --message-format json`),
    // etc. Each adds an `if (<EXTS>.has(ext)) return await diagnose<Lang>(...)`
    // branch here that yields the same { tool, errors, truncated } shape.
    return null
  } catch {
    return null
  }
}

/**
 * OpenCode's block shape, appended verbatim to the tool result.
 * @param {string} file
 * @param {null | { tool: string, errors: Array<{ line: number, col: number, message: string, code?: string }>, truncated: boolean }} result
 * @returns {string} '' when there is nothing to report
 */
export function formatDiagnostics(file, result) {
  if (!result || !Array.isArray(result.errors) || result.errors.length === 0) return ''
  const lines = result.errors.map((e) => `ERROR [${e.line}:${e.col}] ${e.message}`)
  if (result.truncated && typeof result.total === 'number' && result.total > result.errors.length) {
    lines.push(`... and ${result.total - result.errors.length} more`)
  } else if (result.truncated) {
    lines.push('... and more')
  }
  return (
    `\n\nErrors detected in this file (${result.tool}), please fix:\n` +
    `<diagnostics file="${file}">\n${lines.join('\n')}\n</diagnostics>`
  )
}

/** Stop every cached tsserver (tests, app exit). Resolves once they have exited. */
export async function shutdownDiagnostics() {
  const servers = [...tsServers.values()]
  tsServers.clear()
  await Promise.all(servers.map((s) => s.stop()))
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Directories from `dir` upward, ending at `root` (inclusive) when it is an ancestor. */
function* walkUp(dir, root) {
  let cur = dir
  for (;;) {
    yield cur
    if (root && cur === root) return
    const parent = path.dirname(cur)
    if (parent === cur) return
    cur = parent
  }
}

function findUp(dir, root, predicate) {
  for (const d of walkUp(dir, root)) {
    const hit = predicate(d)
    if (hit) return hit
  }
  return null
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function hasDep(pkg, name) {
  return Boolean(
    (pkg?.dependencies && pkg.dependencies[name]) ||
      (pkg?.devDependencies && pkg.devDependencies[name]) ||
      (pkg?.peerDependencies && pkg.peerDependencies[name])
  )
}

/** Nearest package.json (walking up) whose deps mention `dep`; returns its dir. */
function findPackageDirWithDep(fileDir, root, dep) {
  return findUp(fileDir, root, (d) => {
    const p = path.join(d, 'package.json')
    if (!fs.existsSync(p)) return null
    return hasDep(readJsonSafe(p), dep) ? d : null
  })
}

function findFileUp(fileDir, root, names) {
  return findUp(fileDir, root, (d) => {
    for (const n of names) {
      const p = path.join(d, n)
      if (fs.existsSync(p)) return p
    }
    return null
  })
}

function cap(errors) {
  const total = errors.length
  return {
    errors: errors.slice(0, MAX_ERRORS),
    truncated: total > MAX_ERRORS,
    total
  }
}

function merge(parts) {
  const live = parts.filter(Boolean)
  if (live.length === 0) return null
  // Parts arrive already capped; `total` sums their uncapped counts so the
  // "... and N more" line stays honest after the merge.
  const errors = live.flatMap((p) => p.errors).slice(0, MAX_ERRORS)
  const total = live.reduce((n, p) => n + (p.total ?? p.errors.length), 0)
  return { tool: live.map((p) => p.tool).join('+'), errors, truncated: total > errors.length, total }
}

function withTimeout(promise, ms, label) {
  let timer
  const bomb = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), Math.max(0, ms))
    timer.unref?.()
  })
  return Promise.race([promise, bomb]).finally(() => clearTimeout(timer))
}

/** Run a CLI to completion with a hard deadline; resolves { code, stdout, stderr } or null on spawn failure/timeout. */
function runCli(cmd, args, { cwd, env, deadline }) {
  const budget = deadline - Date.now()
  if (budget <= 0) return Promise.resolve(null)
  return new Promise((resolve) => {
    let child
    try {
      child = execFile(
        cmd,
        args,
        { cwd, env, timeout: budget, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (err && (err.code === 'ENOENT' || err.killed || err.signal)) return resolve(null)
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
          resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
        }
      )
    } catch {
      resolve(null)
    }
    child?.on?.('error', () => resolve(null))
  })
}

const whichCache = new Map()
async function onPath(name) {
  if (whichCache.has(name)) return whichCache.get(name)
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  let found = null
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    for (const e of exts) {
      const p = path.join(dir, name + e)
      try {
        await fsp.access(p, fs.constants.X_OK)
        found = p
        break
      } catch {
        /* keep looking */
      }
    }
    if (found) break
  }
  whichCache.set(name, found)
  return found
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript
// ---------------------------------------------------------------------------

async function diagnoseJsTs(abs, root, deadline, ext) {
  const fileDir = path.dirname(abs)
  const tsPkgDir = TS_EXTS.has(ext) ? findPackageDirWithDep(fileDir, root, 'typescript') : null
  const tsconfig = tsPkgDir ? findFileUp(fileDir, root, ['tsconfig.json']) : null

  let ts = null
  if (tsPkgDir && tsconfig) {
    const tsserverJs = path.join(tsPkgDir, 'node_modules', 'typescript', 'lib', 'tsserver.js')
    if (fs.existsSync(tsserverJs)) ts = await tsserverDiagnostics(abs, tsPkgDir, tsserverJs, deadline)
  }

  let lint = null
  if (ESLINT_EXTS.has(ext)) {
    const eslintPkgDir = findPackageDirWithDep(fileDir, root, 'eslint')
    if (eslintPkgDir) lint = await eslintDiagnostics(abs, eslintPkgDir, root, deadline)
  }
  return merge([ts, lint])
}

// --- tsserver client --------------------------------------------------------
//
// One long-lived `node tsserver.js` per project root (the package.json dir that
// owns `typescript`), kept alive across edits so the second call pays only for
// the diagnostics, not the project load. Idle-killed after TSSERVER_IDLE_MS.
//
// Wire format: requests are one JSON object per line on stdin; responses come
// back on stdout as `Content-Length: N\r\n\r\n<json>\n` frames (N includes the
// trailing newline). `open`/`close` produce no response; `reload` and the
// *DiagnosticsSync commands do. Events (type "event") are ignored.

/** @type {Map<string, TsServer>} */
const tsServers = new Map()

class TsServer {
  constructor(projectRoot, tsserverJs) {
    this.projectRoot = projectRoot
    this.tsserverJs = tsserverJs
    this.seq = 0
    this.pending = new Map()
    this.buffer = Buffer.alloc(0)
    this.openFiles = new Set()
    this.idleTimer = null
    this.exited = null // Promise resolved on process exit
    this.proc = spawn(
      process.execPath,
      [tsserverJs, '--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'],
      {
        cwd: projectRoot,
        // Under Electron, process.execPath is the app binary; this flag makes
        // it behave as plain node. Inert under a real node.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true
      }
    )
    this.exited = new Promise((resolve) => {
      const done = () => {
        this.failAll(new Error('tsserver exited'))
        if (tsServers.get(projectRoot) === this) tsServers.delete(projectRoot)
        this.clearIdle()
        resolve()
      }
      this.proc.once('exit', done)
      this.proc.once('error', done)
    })
    this.proc.stdout.on('data', (chunk) => this.onData(chunk))
    this.proc.stdin.on('error', () => {
      /* EPIPE after exit — pending requests are failed by the exit handler */
    })
    this.touch()
  }

  get alive() {
    return this.proc.exitCode === null && this.proc.signalCode === null && !this.proc.killed
  }

  touch() {
    this.clearIdle()
    this.idleTimer = setTimeout(() => void this.stop(), TSSERVER_IDLE_MS)
    this.idleTimer.unref?.()
  }

  clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  failAll(err) {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = this.buffer.subarray(0, headerEnd).toString('utf8')
      const m = /Content-Length:\s*(\d+)/i.exec(header)
      if (!m) {
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      const len = Number(m[1])
      const frameEnd = headerEnd + 4 + len
      if (this.buffer.length < frameEnd) return
      const body = this.buffer.subarray(headerEnd + 4, frameEnd).toString('utf8')
      this.buffer = this.buffer.subarray(frameEnd)
      let msg
      try {
        msg = JSON.parse(body)
      } catch {
        continue
      }
      if (msg?.type === 'response' && typeof msg.request_seq === 'number') {
        const p = this.pending.get(msg.request_seq)
        if (p) {
          this.pending.delete(msg.request_seq)
          if (msg.success === false) p.reject(new Error(msg.message || `tsserver ${msg.command} failed`))
          else p.resolve(msg.body)
        }
      }
    }
  }

  /** Fire-and-forget commands (`open`, `close`) — tsserver sends no response. */
  notify(command, args) {
    if (!this.alive) throw new Error('tsserver not running')
    this.touch()
    const seq = ++this.seq
    this.proc.stdin.write(JSON.stringify({ seq, type: 'request', command, arguments: args }) + '\n')
  }

  request(command, args, deadline) {
    if (!this.alive) return Promise.reject(new Error('tsserver not running'))
    this.touch()
    const seq = ++this.seq
    const p = new Promise((resolve, reject) => this.pending.set(seq, { resolve, reject }))
    this.proc.stdin.write(JSON.stringify({ seq, type: 'request', command, arguments: args }) + '\n')
    return withTimeout(p, deadline - Date.now(), `tsserver ${command}`).finally(() => {
      this.pending.delete(seq)
    })
  }

  async stop() {
    this.clearIdle()
    if (tsServers.get(this.projectRoot) === this) tsServers.delete(this.projectRoot)
    if (!this.alive) return
    try {
      // Closing stdin lets tsserver exit on its own; SIGTERM as the nudge,
      // SIGKILL as the backstop.
      this.proc.stdin.end()
      this.proc.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    await withTimeout(this.exited, TSSERVER_KILL_GRACE_MS, 'tsserver exit').catch(() => {
      try {
        this.proc.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    })
    await this.exited.catch(() => {})
  }
}

function getTsServer(projectRoot, tsserverJs) {
  const cached = tsServers.get(projectRoot)
  if (cached?.alive) return cached
  if (cached) tsServers.delete(projectRoot)
  const server = new TsServer(projectRoot, tsserverJs)
  tsServers.set(projectRoot, server)
  return server
}

function flattenMessage(text) {
  // Non-line-position shape: `text` plus a nested `next` chain; the
  // includeLinePosition shape already delivers a flat `message`.
  if (typeof text === 'string') return text
  if (text && typeof text === 'object') {
    const parts = []
    let cur = text
    while (cur) {
      if (typeof cur.messageText === 'string') parts.push(cur.messageText)
      else if (typeof cur.text === 'string') parts.push(cur.text)
      cur = Array.isArray(cur.next) ? cur.next[0] : cur.next
    }
    return parts.join(' ')
  }
  return String(text ?? '')
}

function mapTsDiagnostic(d) {
  if (!d || d.category !== 'error') return null
  const loc = d.startLocation ?? d.start
  const line = Number(loc?.line)
  const col = Number(loc?.offset)
  if (!Number.isFinite(line) || !Number.isFinite(col)) return null
  const message = flattenMessage(d.message ?? d.text)
    .replace(/\s*\r?\n\s*/g, ' ')
    .trim()
  const out = { line, col, message }
  if (d.code !== undefined && d.code !== null) out.code = String(d.code)
  return out
}

async function tsserverDiagnostics(abs, projectRoot, tsserverJs, deadline) {
  const server = getTsServer(projectRoot, tsserverJs)
  try {
    if (server.openFiles.has(abs)) {
      // The file is already open, so tsserver's in-memory copy (not the disk)
      // is the source of truth — reload it so the diagnostics see the new bytes.
      await server.request('reload', { file: abs, tmpfile: abs }, deadline)
    } else {
      server.notify('open', { file: abs, projectRootPath: projectRoot })
      server.openFiles.add(abs)
    }
    const args = { file: abs, includeLinePosition: true }
    const [syntactic, semantic] = await Promise.all([
      server.request('syntacticDiagnosticsSync', args, deadline),
      server.request('semanticDiagnosticsSync', args, deadline)
    ])
    const raw = [...(Array.isArray(syntactic) ? syntactic : []), ...(Array.isArray(semantic) ? semantic : [])]
    const errors = raw.map(mapTsDiagnostic).filter(Boolean)
    return { tool: 'tsserver', ...cap(errors) }
  } catch (err) {
    // A timeout on a cold load of a big project is not a broken server: leave
    // it warming so the next edit finds it ready. Anything else (crash, EPIPE,
    // a failed command) drops the server so the next call respawns cleanly.
    if (!/timed out/.test(String(err?.message ?? ''))) void server.stop()
    return null
  }
}

// --- eslint -----------------------------------------------------------------

async function eslintDiagnostics(abs, pkgDir, root, deadline) {
  const bin = path.join(pkgDir, 'node_modules', '.bin', 'eslint')
  if (!fs.existsSync(bin)) return null
  if (!findFileUp(path.dirname(abs), root, ESLINT_CONFIGS)) return null
  // `.bin/eslint` is a `#!/usr/bin/env node` shim (a .cmd on Windows); run the
  // real script through our own binary so PATH-less GUI launches still work.
  let script
  try {
    script = await fsp.realpath(bin)
  } catch {
    return null
  }
  if (!/\.[cm]?js$/i.test(script)) script = path.join(pkgDir, 'node_modules', 'eslint', 'bin', 'eslint.js')
  if (!fs.existsSync(script)) return null

  const res = await runCli(
    process.execPath,
    [script, '--format', 'json', '--no-error-on-unmatched-pattern', abs],
    { cwd: pkgDir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, deadline }
  )
  // exit 0 = clean, 1 = lint errors present, 2 = eslint itself failed (config
  // error, crash) — the last is "tool unavailable", not "file is clean".
  if (!res || res.code >= 2) return null
  let results
  try {
    results = JSON.parse(res.stdout)
  } catch {
    return null
  }
  if (!Array.isArray(results)) return null
  const errors = []
  for (const r of results) {
    for (const m of r?.messages ?? []) {
      if (m?.severity !== 2) continue
      const e = {
        line: Number(m.line) || 1,
        col: Number(m.column) || 1,
        message: String(m.message ?? '').trim()
      }
      if (m.ruleId) e.code = String(m.ruleId)
      errors.push(e)
    }
  }
  return { tool: 'eslint', ...cap(errors) }
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

async function diagnosePython(abs, root, deadline) {
  const [ruffBin, pyrightBin] = await Promise.all([onPath('ruff'), onPath('pyright')])
  const fileDir = path.dirname(abs)
  const cwd = findNearestPythonRoot(fileDir, root) ?? fileDir

  const jobs = []
  if (ruffBin) jobs.push(ruffDiagnostics(ruffBin, abs, cwd, deadline))
  if (pyrightBin && hasPyrightConfig(fileDir, root)) jobs.push(pyrightDiagnostics(pyrightBin, abs, cwd, deadline))
  if (jobs.length === 0) return null
  return merge(await Promise.all(jobs))
}

function findNearestPythonRoot(fileDir, root) {
  return findUp(fileDir, root, (d) =>
    ['pyproject.toml', 'setup.py', 'setup.cfg', 'pyrightconfig.json', 'ruff.toml', '.git'].some((n) =>
      fs.existsSync(path.join(d, n))
    )
      ? d
      : null
  )
}

function hasPyrightConfig(fileDir, root) {
  return Boolean(
    findUp(fileDir, root, (d) => {
      if (fs.existsSync(path.join(d, 'pyrightconfig.json'))) return d
      const toml = path.join(d, 'pyproject.toml')
      if (fs.existsSync(toml)) {
        try {
          if (/^\s*\[tool\.pyright(\.|\])/m.test(fs.readFileSync(toml, 'utf8'))) return d
        } catch {
          /* unreadable → treat as absent */
        }
      }
      return null
    })
  )
}

async function ruffDiagnostics(bin, abs, cwd, deadline) {
  const res = await runCli(bin, ['check', '--output-format', 'json', '--exit-zero', abs], { cwd, deadline })
  if (!res) return null
  let items
  try {
    items = JSON.parse(res.stdout)
  } catch {
    return null
  }
  if (!Array.isArray(items)) return null
  const errors = items.map((it) => {
    const e = {
      line: Number(it?.location?.row) || 1,
      col: Number(it?.location?.column) || 1,
      message: String(it?.message ?? '').trim()
    }
    if (it?.code) e.code = String(it.code)
    return e
  })
  return { tool: 'ruff', ...cap(errors) }
}

async function pyrightDiagnostics(bin, abs, cwd, deadline) {
  const res = await runCli(bin, ['--outputjson', abs], { cwd, deadline })
  if (!res) return null
  let out
  try {
    out = JSON.parse(res.stdout)
  } catch {
    return null
  }
  const diags = Array.isArray(out?.generalDiagnostics) ? out.generalDiagnostics : null
  if (!diags) return null
  const errors = diags
    .filter((d) => d?.severity === 'error')
    .map((d) => {
      const e = {
        line: (Number(d?.range?.start?.line) || 0) + 1,
        col: (Number(d?.range?.start?.character) || 0) + 1,
        message: String(d?.message ?? '')
          .replace(/\s*\r?\n\s*/g, ' ')
          .trim()
      }
      if (d?.rule) e.code = String(d.rule)
      return e
    })
  return { tool: 'pyright', ...cap(errors) }
}
