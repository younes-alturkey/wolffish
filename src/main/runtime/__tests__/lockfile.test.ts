/**
 * The workspace lock across a reboot. A pid alone is not an identity: the
 * stale lock's number is reused by whatever starts first on the next boot
 * (observed: a kernel thread), and the app then believed another instance
 * owned the workspace and never started its MCP connections.
 *
 * Standalone. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/runtime/__tests__/lockfile.test.ts
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: unknown): void {
  if (cond) passed++
  else {
    failed++
    console.error(`FAIL ${label}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`)
  }
}

async function run(): Promise<void> {
  const { acquireLock, releaseLockSync } = await import('@main/lockfile')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wf-lock-'))
  const lock = path.join(dir, '.lock')

  // A live process running this same executable stands in for another instance.
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 300))
  const otherPid = other.pid!

  writeFileSync(lock, `${otherPid}\n${process.execPath}`)
  const held = await acquireLock(lock)
  ok('a live owner running the recorded executable keeps the lock', held.acquired === false, held)

  writeFileSync(lock, `${otherPid}\n/opt/Somewhere/else-app`)
  const reused = await acquireLock(lock)
  ok('a live pid running a different executable is a stale lock', reused.acquired === true, reused)
  const written = readFileSync(lock, 'utf8').split('\n')
  ok(
    'the new lock records pid and executable',
    written[0] === String(process.pid) && written[1] === process.execPath,
    written
  )
  releaseLockSync(lock)

  writeFileSync(lock, String(otherPid))
  const legacy = await acquireLock(lock)
  ok('a pid-only lock held by a live app process is still respected', legacy.acquired === false)

  other.kill('SIGKILL')
  await new Promise((r) => setTimeout(r, 300))
  writeFileSync(lock, `${otherPid}\n${process.execPath}`)
  const dead = await acquireLock(lock)
  ok('a dead owner releases the lock', dead.acquired === true, dead)
  releaseLockSync(lock)

  if (process.platform === 'linux') {
    // pid 2 is kthreadd on every Linux: alive, with no executable.
    writeFileSync(lock, '2')
    const kthread = await acquireLock(lock)
    ok('a kernel thread never owns the lock', kthread.acquired === true, kthread)
    releaseLockSync(lock)
  }

  console.log(`lockfile: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void run().catch((err) => {
  console.error('test harness crashed:', err)
  process.exit(1)
})
