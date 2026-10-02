// The one executor every backend in this capability goes through.
//
// Rules that make simulator driving reliable rather than merely working:
//   - argv only, never a shell: a device name with parentheses or a bundle id
//     is data, not syntax;
//   - every call has a timeout and is SIGKILLed past it; a stuck simctl must
//     end the tool call, not the turn;
//   - stdin is closed so nothing can sit waiting on a prompt;
//   - output is capped (tail-biased) so a chatty log can never flood context;
//   - the caller's abort signal kills the child;
//   - binaries resolve to absolute paths from the toolchain's known homes,
//     PATH last, so a missing SDK reports as such instead of ENOENT noise.
//
// Tests inject a fake executor through __setExecutor and never spawn.
import { execFile, spawn } from 'node:child_process'
import { access, constants, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export const OUTPUT_TAIL_LINES = 200
export const OUTPUT_TAIL_BYTES = 50 * 1024
const OUTPUT_MEMORY_CAP = 8 * 1024 * 1024

let override = null

/** Test seam: replace the process runner. `fn(cmd, args, opts) -> {code, out, err, stdout?}`. */
export function __setExecutor(fn) {
  override = typeof fn === 'function' ? fn : null
}
export function __resetExecutor() {
  override = null
}

/**
 * Run a command to completion. Resolves with `{ code, out, err, stdout, timedOut, durationMs }`
 * where `out` is stdout+stderr interleaved as text (tail-capped), `stdout` the raw
 * stdout bytes (for screenshots), `err` the stderr text. Never rejects.
 */
export function run(cmd, args, { cwd, timeout = 60_000, env, signal, binary = false, input } = {}) {
  if (override) {
    return Promise.resolve(override(cmd, args, { cwd, timeout, env, binary, input })).then((r) => ({
      code: r?.code ?? 0,
      out: typeof r?.out === 'string' ? r.out : '',
      err: typeof r?.err === 'string' ? r.err : '',
      stdout: Buffer.isBuffer(r?.stdout) ? r.stdout : Buffer.from(r?.stdout ?? r?.out ?? '', 'utf8'),
      timedOut: !!r?.timedOut,
      durationMs: r?.durationMs ?? 0
    }))
  }
  const startedAt = Date.now()
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, NO_COLOR: '1', ...(env ?? {}) },
        stdio: [input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (e) {
      resolve({ code: -1, out: '', err: e?.message ?? String(e), stdout: Buffer.alloc(0), timedOut: false, durationMs: 0 })
      return
    }
    const outChunks = []
    const stdoutChunks = []
    let outBytes = 0
    let errText = ''
    let done = false
    let timedOut = false
    const finish = (code, extraErr) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      const stdout = Buffer.concat(stdoutChunks)
      // Full text up to the memory cap: callers parse JSON/XML out of it and
      // apply tail() themselves before anything reaches the model.
      resolve({
        code,
        out: binary ? '' : Buffer.concat(outChunks).toString('utf8'),
        err: extraErr ?? errText,
        stdout,
        timedOut,
        durationMs: Date.now() - startedAt
      })
    }
    const kill = () => {
      try {
        child.kill('SIGKILL')
      } catch {
        // gone
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
      finish(null, `timed out after ${Math.round(timeout / 1000)}s`)
    }, timeout)
    const onAbort = () => {
      kill()
      finish(null, 'aborted')
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const push = (chunk) => {
      if (outBytes >= OUTPUT_MEMORY_CAP) return
      outBytes += chunk.length
      outChunks.push(chunk)
    }
    child.stdout.on('data', (c) => {
      if (binary) stdoutChunks.push(c)
      else push(c)
    })
    child.stderr.on('data', (c) => {
      push(c)
      if (errText.length < 20_000) errText += c.toString()
    })
    child.on('error', (e) => finish(-1, e?.message ?? String(e)))
    child.on('close', (code) => finish(code))
    if (input != null) {
      try {
        child.stdin.end(input)
      } catch {
        // stdin closed early — the child will see EOF
      }
    }
  })
}

/**
 * Start a long-running helper detached from the tool call: stdout+stderr go
 * to `logFd` (an open file descriptor) and the child keeps running after
 * the promise resolves. Returns `{ pid, child }` or `{ error }`.
 */
export function spawnDetached(cmd, args, { cwd, env, logFd } = {}) {
  try {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, NO_COLOR: '1', ...(env ?? {}) },
      stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
      detached: process.platform !== 'win32',
      windowsHide: true
    })
    child.on('error', () => {})
    child.unref()
    return { pid: child.pid ?? null, child }
  } catch (e) {
    return { error: e?.message ?? String(e) }
  }
}

/** Last `maxLines` lines and at most `maxBytes`, with a count of what was dropped. */
export function tail(text, maxLines = OUTPUT_TAIL_LINES, maxBytes = OUTPUT_TAIL_BYTES) {
  if (!text) return ''
  const lines = text.split('\n')
  const kept = lines.slice(-maxLines)
  let joined = kept.join('\n')
  while (Buffer.byteLength(joined, 'utf8') > maxBytes && kept.length > 1) {
    kept.shift()
    joined = kept.join('\n')
  }
  return (lines.length > kept.length ? `…(${lines.length - kept.length} earlier lines omitted)\n` : '') + joined
}

// ─── Binary resolution ────────────────────────────────────────────────────

const resolved = new Map()

async function executable(p) {
  try {
    await access(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function whichCmd() {
  return process.platform === 'win32' ? 'where' : 'which'
}

async function fromPath(name) {
  return new Promise((resolve) => {
    execFile(whichCmd(), [name], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null)
      const first = String(stdout ?? '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean)
      resolve(first || null)
    })
  })
}

export function androidSdkRoots() {
  const roots = []
  for (const v of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) if (v) roots.push(v)
  const home = homedir()
  if (process.platform === 'darwin') roots.push(path.join(home, 'Library', 'Android', 'sdk'))
  else if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'))
  } else roots.push(path.join(home, 'Android', 'Sdk'), path.join(home, 'Android', 'sdk'))
  return [...new Set(roots)]
}

const EXE = process.platform === 'win32' ? '.exe' : ''

/**
 * Absolute path of a toolchain binary, or null. Known homes first, PATH last.
 * Cached per process (cleared by __resetBinaries for tests).
 */
export async function resolveBinary(name) {
  if (resolved.has(name)) return resolved.get(name)
  let found = null
  const candidates = []
  if (name === 'adb') for (const r of androidSdkRoots()) candidates.push(path.join(r, 'platform-tools', `adb${EXE}`))
  if (name === 'emulator') for (const r of androidSdkRoots()) candidates.push(path.join(r, 'emulator', `emulator${EXE}`))
  if (name === 'avdmanager') {
    for (const r of androidSdkRoots()) {
      candidates.push(path.join(r, 'cmdline-tools', 'latest', 'bin', process.platform === 'win32' ? 'avdmanager.bat' : 'avdmanager'))
      try {
        const versions = await readdir(path.join(r, 'cmdline-tools'))
        for (const v of versions) candidates.push(path.join(r, 'cmdline-tools', v, 'bin', process.platform === 'win32' ? 'avdmanager.bat' : 'avdmanager'))
      } catch {
        // no cmdline-tools
      }
    }
  }
  if (name === 'xcrun' || name === 'xcodebuild') candidates.push(`/usr/bin/${name}`)
  for (const c of candidates) {
    if (await executable(c)) {
      found = c
      break
    }
  }
  if (!found) found = await fromPath(name)
  resolved.set(name, found)
  return found
}

export function __resetBinaries() {
  resolved.clear()
}

/** `xcrun simctl …` with the resolved xcrun. */
export async function simctl(args, opts = {}) {
  const xcrun = (await resolveBinary('xcrun')) ?? 'xcrun'
  return run(xcrun, ['simctl', ...args], { timeout: 30_000, ...opts })
}

/** `adb [-s serial] …` with the resolved adb. */
export async function adb(serial, args, opts = {}) {
  const bin = (await resolveBinary('adb')) ?? 'adb'
  return run(bin, serial ? ['-s', serial, ...args] : args, { timeout: 30_000, ...opts })
}

export function isUuid(s) {
  return typeof s === 'string' && /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(s.trim())
}

export function isAdbSerial(s) {
  return typeof s === 'string' && /^(emulator-\d+|[A-Za-z0-9._:-]{4,64})$/.test(s.trim()) && !isUuid(s)
}

export const BUNDLE_ID_RE = /^[A-Za-z0-9.-]{2,255}$/
export const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/
