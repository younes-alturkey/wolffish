/**
 * Tests for the brainstem's bounded run pool (brainstem.ts): up to
 * MAX_CONCURRENT_JOBS jobs run at once, overflow queues FIFO, fires coalesce
 * per job id, a completion promotes the next queued job, a failing run frees
 * its slot without wedging the pool, and every transition pushes an
 * onRunsChanged snapshot.
 *
 * Then the two ways a slot used to be held by nothing at all — the reasons a
 * manual run reported "queued" while the pool looked empty: an automation id
 * shifting under a live run (positional ids, a run that outlives the reload)
 * aliasing one job onto another, and a throwing listener skipping the release.
 *
 * Drives the pool through runDetached (the procedures path) with a fake agent
 * whose processAutonomous blocks on a per-label gate, so the test controls
 * exactly when each "run" finishes. Also asserts the brainstem job id is
 * threaded into the autonomous turn (opts.jobId) — the renderer routes live
 * log entries to the right concurrent card by that id.
 *
 * Redirects the workspace to a temp home BEFORE loading the runtime graph so
 * nothing touches the real ~/.wolffish workspace.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/heartbeat-run-pool.test.ts
 */

import fs from 'node:fs'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-heartbeat-pool-'))
;(os as unknown as { homedir: () => string }).homedir = (): string => TEST_HOME

const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => os.tmpdir() }
    }
  }
  return origLoad.apply(this, args)
}

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function run(): Promise<void> {
  const { Brainstem, MAX_CONCURRENT_JOBS } = await import('@main/runtime/brainstem')

  const ws = path.join(TEST_HOME, 'ws')
  fs.mkdirSync(path.join(ws, 'brain', 'brainstem'), { recursive: true })

  const bs = new Brainstem({ workspaceRoot: ws })

  const snapshots: Array<{ running: string[]; queued: string[] }> = []
  const ended: string[] = []
  bs.setListener({
    onJobEnded: (p) => ended.push(`${p.id}:${p.status}`),
    onRunsChanged: (s) =>
      snapshots.push({
        running: s.running.map((r) => r.id),
        queued: s.queued.map((q) => q.id)
      })
  })

  const gates = new Map<string, () => void>()
  const jobIdsSeen = new Map<string, string | undefined>()
  let active = 0
  let maxActive = 0
  const fakeAgent = {
    processAutonomous: (opts: { jobLabel: string; jobId?: string }) => {
      jobIdsSeen.set(opts.jobLabel, opts.jobId)
      if (opts.jobLabel === 'FAIL') return Promise.reject(new Error('boom'))
      active += 1
      maxActive = Math.max(maxActive, active)
      return new Promise((resolve) => {
        gates.set(opts.jobLabel, () => {
          active -= 1
          resolve({ success: true, response: '', toolCalls: 0, conversationId: 'x' })
        })
      })
    }
  }
  bs.setAgent(fakeAgent as unknown as import('@main/runtime/agent').Agent)

  const runningIds = (): string[] => bs.getRunningJobs().map((r) => r.id)
  const queuedIds = (): string[] => bs.getQueuedJobs().map((q) => q.id)

  // ── Fill the pool: three run at once, the fourth queues ────────────────
  const r1 = bs.runDetached('a', 'A', 'job-a')
  const r2 = bs.runDetached('b', 'B', 'job-b')
  const r3 = bs.runDetached('c', 'C', 'job-c')
  const r4 = bs.runDetached('d', 'D', 'job-d')
  ok('first three start immediately', r1.started && r2.started && r3.started)
  ok('fourth is accepted but queued', r4.ok && !r4.started)
  ok(
    'pool holds MAX_CONCURRENT_JOBS runs',
    runningIds().length === MAX_CONCURRENT_JOBS,
    runningIds().join(',')
  )
  ok('running ids are the first three', runningIds().join(',') === 'job-a,job-b,job-c')
  ok('queue holds the fourth', queuedIds().join(',') === 'job-d')
  ok(
    'a snapshot carried the queued job',
    snapshots.some((s) => s.queued.includes('job-d'))
  )

  // ── Coalescing: a re-fire of a running or queued job takes no slot ─────
  const r4b = bs.runDetached('d', 'D', 'job-d')
  ok('queued re-fire coalesces', r4b.ok && !r4b.started && !!r4b.error)
  const r1b = bs.runDetached('a', 'A', 'job-a')
  ok('running re-fire coalesces', r1b.ok && !r1b.started && !!r1b.error)
  ok('coalesced fires take no slot', runningIds().length === 3 && queuedIds().length === 1)

  // ── A completion promotes the queued job into the freed slot ───────────
  gates.get('B')!()
  await sleep(60)
  ok('B ended completed', ended.includes('job-b:completed'))
  ok(
    'D promoted into the freed slot',
    [...runningIds()].sort().join(',') === 'job-a,job-c,job-d',
    runningIds().join(',')
  )
  ok('queue drained', queuedIds().length === 0)

  // ── A failing run reports failed and frees its slot ────────────────────
  const rf = bs.runDetached('f', 'FAIL', 'job-f')
  ok('failure job queues behind the full pool', rf.ok && !rf.started)
  gates.get('A')!()
  await sleep(60)
  ok('FAIL ran and failed', ended.includes('job-f:failed'))
  ok(
    'pool survives the failure',
    [...runningIds()].sort().join(',') === 'job-c,job-d',
    runningIds().join(',')
  )

  // ── The brainstem job id threads into the autonomous turn ──────────────
  ok('jobId threaded (A)', jobIdsSeen.get('A') === 'job-a')
  ok('jobId threaded (FAIL)', jobIdsSeen.get('FAIL') === 'job-f')

  // ── Concurrency never exceeded the cap ─────────────────────────────────
  ok('cap respected', maxActive === MAX_CONCURRENT_JOBS, String(maxActive))

  // ── Drain the rest ─────────────────────────────────────────────────────
  gates.get('C')!()
  gates.get('D')!()
  await sleep(60)
  ok('pool empty after drain', runningIds().length === 0 && queuedIds().length === 0)
  const last = snapshots[snapshots.length - 1]
  ok('final snapshot is empty', last.running.length === 0 && last.queued.length === 0)
  ok(
    'every non-failing run completed',
    ended.filter((e) => e.endsWith(':completed')).length === 4,
    ended.join(' ')
  )

  // ── An edit under a live run can't alias one automation onto another ───
  //
  // parseHeartbeat numbers automation ids POSITIONALLY per kind, and a run in
  // flight deliberately survives a scheduler reload. Delete the first of two
  // "Daily" jobs while it runs and the survivor inherits its id — which used
  // to make every manual fire of the survivor coalesce into a run that was
  // never its own: reported as waiting, never started, forever.
  const ws2 = path.join(TEST_HOME, 'ws2')
  fs.mkdirSync(path.join(ws2, 'brain', 'brainstem'), { recursive: true })
  const hbPath = path.join(ws2, 'brain', 'brainstem', 'heartbeat.md')
  const write = (...blocks: string[]): void =>
    fs.writeFileSync(hbPath, blocks.map((b) => `## ${b}\n\nBody of ${b}.\n`).join('\n'))

  write('Daily (08:00)', 'Daily (20:00)')
  const bs2 = new Brainstem({ workspaceRoot: ws2 })
  const gates2 = new Map<string, () => void>()
  bs2.setAgent({
    processAutonomous: (opts: { jobLabel: string }) =>
      new Promise((resolve) => {
        gates2.set(opts.jobLabel, () =>
          resolve({ success: true, response: '', toolCalls: 0, conversationId: 'x' })
        )
      })
  } as unknown as import('@main/runtime/agent').Agent)
  await bs2.startScheduler(false)

  const first = bs2.runJobNow('Daily (08:00)')
  ok('the first Daily starts', first.ok && first.started && first.state === 'running')
  write('Daily (20:00)') // the running job leaves the file; ids shift under it
  await bs2.reloadScheduler()
  ok(
    'the run survives the reload',
    bs2
      .getRunningJobs()
      .map((r) => r.label)
      .join(',') === 'Daily (08:00)'
  )
  const second = bs2.runJobNow('Daily (20:00)')
  ok(
    'THE OTHER AUTOMATION STILL STARTS',
    second.ok && second.started && second.state === 'running',
    JSON.stringify(second)
  )
  ok(
    'both run side by side',
    bs2
      .getRunningJobs()
      .map((r) => r.label)
      .sort()
      .join(',') === 'Daily (08:00),Daily (20:00)'
  )
  // Same job twice still coalesces — label identity dedupes, id identity doesn't.
  const again = bs2.runJobNow('Daily (20:00)')
  ok('a re-fire of the SAME job still coalesces', again.ok && again.state === 'coalesced')
  for (const open of gates2.values()) open()
  await sleep(60)

  // ── A throwing listener can't leak the slot it was announcing ──────────
  //
  // onJobStarted is an IPC broadcast to windows that may be tearing down.
  // When it threw before the try was entered, the release never ran and the
  // slot was held for the life of the process — three of those and every
  // later fire reports "queued" behind runs that ended long ago.
  const bs3 = new Brainstem({ workspaceRoot: ws2 })
  bs3.setAgent({
    processAutonomous: () =>
      Promise.resolve({ success: true, response: '', toolCalls: 0, conversationId: 'x' })
  } as unknown as import('@main/runtime/agent').Agent)
  bs3.setListener({
    onJobStarted: () => {
      throw new Error('Object has been destroyed')
    }
  })
  await bs3.startScheduler(false)
  const hostile = bs3.runJobNow('Daily (20:00)')
  ok('a run whose announcement throws still counts as started', hostile.started)
  await sleep(60)
  ok('THE SLOT IS RELEASED', bs3.getRunningJobs().length === 0)
  ok('and the next fire is not stuck behind a ghost', bs3.runJobNow('Daily (20:00)').started)

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
