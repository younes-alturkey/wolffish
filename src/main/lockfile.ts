import { diskWriter } from '@main/io/diskWriter'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export type LockResult = { acquired: true } | { acquired: false; runningPid: number }

export async function acquireLock(lockPath: string): Promise<LockResult> {
  await fsp.mkdir(path.dirname(lockPath), { recursive: true })

  if (existsSync(lockPath)) {
    const raw = readFileSync(lockPath, 'utf8').trim()
    const pid = Number.parseInt(raw, 10)
    if (Number.isFinite(pid) && pid > 0 && pid !== process.pid && isProcessAlive(pid)) {
      return { acquired: false, runningPid: pid }
    }
    await fsp.rm(lockPath, { force: true })
  }

  await diskWriter.writeFileAtomic(lockPath, String(process.pid))
  return { acquired: true }
}

export function releaseLockSync(lockPath: string): void {
  try {
    if (!existsSync(lockPath)) return
    const raw = readFileSync(lockPath, 'utf8').trim()
    const pid = Number.parseInt(raw, 10)
    if (pid !== process.pid) return
    rmSync(lockPath, { force: true })
  } catch {
    // already gone or unreadable; nothing to do
  }
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
