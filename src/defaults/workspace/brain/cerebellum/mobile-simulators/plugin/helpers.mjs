// Helper-process registry: every long-lived child this capability starts
// (an os_log stream, a console-pty launch, a logcat tail, an emulator, a
// video recording) is recorded as one JSON file so it can be found, stopped
// and swept by a later process — including a process that is not the one
// that started it.
//
// Liveness is never "is there a process with this pid": pids get reused.
// A helper is alive only when the pid exists AND its command line still
// carries the argv signature recorded at start. Ownership is the starting
// process's pid + a per-load instance id, so a sweep in a new app launch
// can tell "mine, still running" from "orphan of a dead Wolffish".
import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const INSTANCE_ID = randomUUID()
let dir = null

export function initHelpers(workspaceRoot) {
  dir = path.join(workspaceRoot, 'files', 'mobile', 'helpers')
}

export function helpersDir() {
  return dir
}

function fileFor(id) {
  return path.join(dir, `${id}.json`)
}

/**
 * Record a started helper. `kind` is oslog | console | logcat | emulator |
 * record; `signature` a short substring the live command line must contain.
 */
export async function registerHelper({ kind, pid, argv, signature, device, app, file, extra }) {
  if (!dir || !pid) return null
  await mkdir(dir, { recursive: true })
  const rec = {
    id: randomUUID(),
    kind,
    pid,
    argv: Array.isArray(argv) ? argv.slice(0, 12) : [],
    signature: signature ?? (Array.isArray(argv) ? argv.slice(0, 3).join(' ') : ''),
    device: device ?? null,
    app: app ?? null,
    file: file ?? null,
    extra: extra ?? null,
    owner: { pid: process.pid, instance: INSTANCE_ID },
    startedAt: Date.now()
  }
  const tmp = `${fileFor(rec.id)}.part`
  await writeFile(tmp, JSON.stringify(rec, null, 2), 'utf8')
  const { rename } = await import('node:fs/promises')
  await rename(tmp, fileFor(rec.id))
  return rec
}

export async function listHelpers(filter = {}) {
  if (!dir) return []
  let names
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out = []
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    try {
      const rec = JSON.parse(await readFile(path.join(dir, n), 'utf8'))
      if (filter.kind && rec.kind !== filter.kind) continue
      if (filter.device && rec.device !== filter.device) continue
      if (filter.app && rec.app !== filter.app) continue
      out.push(rec)
    } catch {
      // half-written or corrupt — the sweep will take it
    }
  }
  return out.sort((a, b) => a.startedAt - b.startedAt)
}

export async function forgetHelper(id) {
  if (!dir) return
  await rm(fileFor(id), { force: true }).catch(() => {})
}

/** The live command line for a pid, or null when there is no such process. */
export function commandLineOf(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(null)
    if (process.platform === 'win32') {
      execFile(
        'powershell',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}").CommandLine`],
        { timeout: 8000, windowsHide: true },
        (err, stdout) => resolve(err ? null : String(stdout ?? '').trim() || null)
      )
      return
    }
    execFile('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null)
      const line = String(stdout ?? '').trim()
      resolve(line || null)
    })
  })
}

/** Alive = pid exists and still runs the command we started. */
export async function helperAlive(rec) {
  const line = await commandLineOf(rec.pid)
  if (!line) return false
  if (!rec.signature) return true
  return line.includes(rec.signature)
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}

/** SIGTERM (or SIGINT when asked), wait, then SIGKILL. Only when the argv still matches. */
export async function stopHelper(rec, { signal = 'SIGTERM', graceMs = 1500 } = {}) {
  if (!(await helperAlive(rec))) {
    await forgetHelper(rec.id)
    return { stopped: false, reason: 'not running' }
  }
  try {
    process.kill(rec.pid, signal)
  } catch {
    await forgetHelper(rec.id)
    return { stopped: false, reason: 'not running' }
  }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (!pidAlive(rec.pid)) break
    await new Promise((r) => setTimeout(r, 100))
  }
  if (pidAlive(rec.pid)) {
    try {
      process.kill(rec.pid, 'SIGKILL')
    } catch {
      // gone between checks
    }
  }
  await forgetHelper(rec.id)
  return { stopped: true }
}

/**
 * Startup sweep: records whose owner process is gone are orphans of a dead
 * Wolffish — stop the helper if it still runs our argv, then drop the
 * record. Records whose owner is alive belong to another live instance and
 * are left alone. Records whose helper is dead are simply dropped.
 */
export async function sweepHelpers() {
  const recs = await listHelpers()
  let stopped = 0
  let dropped = 0
  for (const rec of recs) {
    const ownerAlive = rec.owner?.instance === INSTANCE_ID || (rec.owner?.pid && pidAlive(rec.owner.pid) && rec.owner.instance !== INSTANCE_ID)
    const alive = await helperAlive(rec)
    if (!alive) {
      await forgetHelper(rec.id)
      dropped++
      continue
    }
    if (!ownerAlive) {
      await stopHelper(rec)
      stopped++
    }
  }
  return { stopped, dropped }
}

/** Stop every helper this instance owns (plugin destroy / app quit). */
export async function stopOwnedHelpers() {
  const recs = await listHelpers()
  for (const rec of recs) {
    if (rec.owner?.instance === INSTANCE_ID) await stopHelper(rec).catch(() => {})
  }
}

export function instanceId() {
  return INSTANCE_ID
}
