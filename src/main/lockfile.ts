import { diskWriter } from '@main/io/diskWriter'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export type LockResult = { acquired: true } | { acquired: false; runningPid: number }

/**
 * The lock holds the owner's pid and, on the next line, its executable. A pid
 * alone is not an identity: after a reboot the stale lock's number belongs to
 * whatever started first this boot — observed on a VPS, a kernel thread
 * (`[psimon]`) — and `kill(pid, 0)` happily reports it alive, so the app
 * decided another instance owned the workspace and never started its MCP
 * connections, on every boot.
 */
export async function acquireLock(lockPath: string): Promise<LockResult> {
  await fsp.mkdir(path.dirname(lockPath), { recursive: true })

  if (existsSync(lockPath)) {
    const [rawPid, rawExe] = readFileSync(lockPath, 'utf8').split('\n')
    const pid = Number.parseInt(rawPid?.trim() ?? '', 10)
    const exe = rawExe?.trim() || null
    if (Number.isFinite(pid) && pid > 0 && pid !== process.pid && isOwnerAlive(pid, exe)) {
      return { acquired: false, runningPid: pid }
    }
    await fsp.rm(lockPath, { force: true })
  }

  await diskWriter.writeFileAtomic(lockPath, `${process.pid}\n${process.execPath}`)
  return { acquired: true }
}

export function releaseLockSync(lockPath: string): void {
  try {
    if (!existsSync(lockPath)) return
    const raw = readFileSync(lockPath, 'utf8').split('\n')[0]?.trim() ?? ''
    const pid = Number.parseInt(raw, 10)
    if (pid !== process.pid) return
    rmSync(lockPath, { force: true })
  } catch {
    // already gone or unreadable; nothing to do
  }
}

function isOwnerAlive(pid: number, exe: string | null): boolean {
  if (!isProcessAlive(pid)) return false
  const running = executableOf(pid)
  // Unknowable here (Windows, or the probe failed): trust the pid as before.
  if (running === undefined) return true
  // A process with no executable is a kernel thread — never an app instance.
  if (running === null) return false
  // A lock from before the executable was recorded: any app process will do.
  if (!exe) return true
  // macOS `ps` reports the path the process was launched by, which may be a
  // bare name or a symlink — the name alone still tells an app from a stranger.
  return running === exe || path.basename(running) === path.basename(exe)
}

/** The pid's executable path; null for a kernel thread; undefined when it cannot be told. */
function executableOf(pid: number): string | null | undefined {
  try {
    if (process.platform === 'linux') {
      try {
        // An owner still running after a package upgrade replaced its binary
        // reads as "<path> (deleted)" — still the same app.
        return readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '')
      } catch (err) {
        // Kernel threads have no exe link; a process we may not inspect does.
        return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined
      }
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
      return out || undefined
    }
  } catch {
    // fall through
  }
  return undefined
}

function isProcessAlive(pid: number): boolean {
  try {
    // signal 0 probes for existence without delivering anything
    process.kill(pid, 0)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return true
    return false
  }
}
