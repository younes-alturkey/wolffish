/**
 * Behavior tests for WorkflowSession — the workflow-mode agent registry and
 * the deterministic snapshot source behind the chat's workflow card.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/workflow-session.test.ts
 */
import assert from 'node:assert/strict'
import type { WorkflowSnapshot } from '@main/runtime/broca'
import {
  MAX_RUNNING_AGENTS,
  MAX_TOTAL_AGENTS,
  WorkflowSession,
  type RunAgentTurn,
  type WorkflowAgentResult,
  type WorkflowWaitOutcome
} from '@main/runtime/workflow'

type Controlled = {
  resolve: (r: WorkflowAgentResult) => void
  reject: (e: Error) => void
  args: Parameters<RunAgentTurn>[0]
}

/** A runAgentTurn stub whose completions the test controls per agent. */
function harness(): {
  session: WorkflowSession
  pending: Controlled[]
  snapshots: WorkflowSnapshot[]
} {
  const pending: Controlled[] = []
  const snapshots: WorkflowSnapshot[] = []
  const run: RunAgentTurn = (args) =>
    new Promise<WorkflowAgentResult>((resolve, reject) => {
      pending.push({ resolve, reject, args })
      args.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
  const session = new WorkflowSession(
    'wf_test',
    run,
    () => ({ provider: 'anthropic', model: 'claude-test' }),
    (snap) => snapshots.push(snap)
  )
  return { session, pending, snapshots }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** Narrow an awaitNext outcome to a landing (asserts it isn't null / no-progress). */
function landing(o: WorkflowWaitOutcome | null): Extract<WorkflowWaitOutcome, { kind: 'landed' }> {
  assert.ok(o && o.kind === 'landed', 'expected a landing outcome')
  return o
}

async function testSpawnAwaitTelemetry(): Promise<void> {
  const { session, pending, snapshots } = harness()
  session.plan(['analysis', 'verify'], 'test note')
  const id = session.spawn({ task: 'do the thing', name: 'researcher', phase: 'analysis' })
  assert.equal(id, 'a1')
  await tick()
  assert.equal(pending.length, 1)
  // Harness telemetry callbacks drive the deterministic counters.
  pending[0].args.onToolCall()
  pending[0].args.onToolCall()
  pending[0].args.onLlmCall('anthropic', 'claude-test', {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 400,
    cacheCreationTokens: 20
  })
  // Phase derivation while running.
  let snap = session.snapshot()
  assert.equal(snap.phases[0].status, 'active')
  assert.equal(snap.phases[1].status, 'pending')
  assert.equal(snap.note, 'test note')

  pending[0].resolve({ text: 'report text', stopReason: 'end_turn', failed: false })
  const landed = landing(await session.awaitNext())
  assert.equal(landed.id, 'a1')
  assert.equal(landed.name, 'researcher')
  assert.equal(landed.result.text, 'report text')

  snap = session.snapshot()
  const agent = snap.agents[0]
  assert.equal(agent.status, 'completed')
  assert.equal(agent.toolCalls, 2)
  assert.equal(agent.llmCalls, 1)
  assert.equal(agent.inputTokens, 100)
  assert.equal(agent.cacheReadTokens, 400)
  assert.equal(agent.cacheWriteTokens, 20)
  assert.ok(agent.cost > 0, 'cost priced via calculateCost')
  assert.equal(snap.phases[0].status, 'done')
  // An agentless phase (the master works it itself) stays pending while the
  // run is live…
  assert.equal(snap.phases[1].status, 'pending')
  assert.ok(snapshots.length > 0, 'snapshots emitted on structural changes')
  // The master's own calls ride the snapshot too — the card shows the true
  // whole-turn spend, not agents-only.
  session.recordMasterUsage('anthropic', 'claude-test', {
    inputTokens: 50,
    outputTokens: 25,
    cacheReadTokens: 200,
    cacheCreationTokens: 10
  })
  const withMaster = session.snapshot()
  assert.equal(withMaster.master?.llmCalls, 1)
  assert.equal(withMaster.master?.inputTokens, 50)
  assert.equal(withMaster.master?.cacheReadTokens, 200)
  assert.ok((withMaster.master?.cost ?? 0) > 0)
  session.finalize('completed')
  // …and resolves to done on successful completion — grey chips on a
  // completed card read as "never ran".
  const finalSnap = snapshots[snapshots.length - 1]
  assert.equal(finalSnap.phases[1].status, 'done')
  console.log(
    'ok: spawn → telemetry → await → phase derivation (+agentless phase greens on completion)'
  )
}

async function testFirstLandingWins(): Promise<void> {
  const { session, pending } = harness()
  session.spawn({ task: 'slow' })
  session.spawn({ task: 'fast' })
  await tick()
  pending[1].resolve({ text: 'fast done', stopReason: 'end_turn', failed: false })
  const first = await session.awaitNext()
  assert.equal(first?.id, 'a2')
  // The slow agent keeps running; a scoped await for it still parks until it lands.
  pending[0].resolve({ text: 'slow done', stopReason: 'end_turn', failed: false })
  const second = await session.awaitNext(['a1'])
  assert.equal(second?.id, 'a1')
  // Nothing left → null, not a hang.
  assert.equal(await session.awaitNext(), null)
  session.finalize('completed')
  console.log('ok: awaitNext returns first landing; scoped await; null when dry')
}

async function testConcurrencyCapQueues(): Promise<void> {
  const { session, pending } = harness()
  const ids: string[] = []
  for (let i = 0; i < MAX_RUNNING_AGENTS + 1; i++) ids.push(session.spawn({ task: `t${i}` }))
  await tick()
  assert.equal(pending.length, MAX_RUNNING_AGENTS, 'excess spawn queues, not runs')
  const queued = session.list().find((a) => a.id === ids[ids.length - 1])
  assert.equal(queued?.status, 'queued')
  // A landing frees the slot and drains the queue.
  pending[0].resolve({ text: 'done', stopReason: 'end_turn', failed: false })
  await session.awaitNext([ids[0]])
  await tick()
  assert.equal(pending.length, MAX_RUNNING_AGENTS + 1, 'queued agent started after a slot freed')
  session.finalize('completed')
  console.log('ok: concurrency cap queues and drains')
}

async function testTotalCapThrows(): Promise<void> {
  const { session } = harness()
  for (let i = 0; i < MAX_TOTAL_AGENTS; i++) session.spawn({ task: `t${i}` })
  assert.throws(() => session.spawn({ task: 'one too many' }), /agent cap/)
  session.finalize('canceled')
  console.log('ok: total agent cap is a hard error')
}

async function testSendToAndGuards(): Promise<void> {
  const { session, pending } = harness()
  const id = session.spawn({ task: 'first' })
  await tick()
  assert.throws(() => session.sendTo(id, 'too early'), /still running/)
  pending[0].resolve({ text: 'first done', stopReason: 'end_turn', failed: false })
  await session.awaitNext()
  session.sendTo(id, 'follow up')
  await tick()
  assert.equal(pending.length, 2)
  // Follow-up history carries the prior assistant reply + the new message.
  const history = pending[1].args.history
  assert.equal(history.length, 3)
  assert.deepEqual(history[1], { role: 'assistant', content: 'first done' })
  pending[1].resolve({ text: 'second done', stopReason: 'end_turn', failed: false })
  const landed = landing(await session.awaitNext())
  assert.equal(landed.result.text, 'second done')
  session.finalize('completed')
  console.log('ok: sendTo guards + text-only continuation history')
}

async function testFailureAsData(): Promise<void> {
  const { session, pending } = harness()
  session.spawn({ task: 'will crash' })
  await tick()
  pending[0].reject(new Error('provider exploded'))
  const landed = landing(await session.awaitNext())
  assert.match(landed.result.text, /provider exploded/)
  assert.equal(landed.result.failed, true)
  assert.equal(session.snapshot().agents[0].status, 'failed')
  session.finalize('completed')
  console.log('ok: a thrown agent turn lands as a failed result, never kills the run')
}

async function testCancelAndLateCompletion(): Promise<void> {
  const { session, pending } = harness()
  const id = session.spawn({ task: 'doomed' })
  await tick()
  session.cancel(id)
  assert.equal(session.snapshot().agents[0].status, 'cancelled')
  // A late completion must not resurrect a retired agent.
  pending[0].resolve({ text: 'zombie', stopReason: 'end_turn', failed: false })
  await tick()
  assert.equal(session.snapshot().agents[0].status, 'cancelled')
  assert.equal(await session.awaitNext(), null)
  session.finalize('canceled')
  console.log('ok: cancel aborts; late completion cannot resurrect')
}

async function testFinalizeTerminalSnapshot(): Promise<void> {
  const { session, pending, snapshots } = harness()
  session.spawn({ task: 'survivor' })
  await tick()
  assert.equal(pending.length, 1)
  // A parked awaiter must be woken by finalize (stop-button path).
  const parked = session.awaitNext(['a1'])
  session.finalize('canceled')
  assert.equal(await parked, null)
  const last = snapshots[snapshots.length - 1]
  assert.equal(last.status, 'canceled')
  assert.equal(last.agents[0].status, 'cancelled')
  assert.ok(last.endedAt !== undefined)
  // Post-finalize mutations are rejected or inert — an agent_send racing the
  // user's Stop must never launch an unabortable post-dispose turn.
  assert.throws(() => session.spawn({ task: 'nope' }), /closed/)
  assert.throws(() => session.sendTo('a1', 'zombie follow-up'), /closed/)
  const before = snapshots.length
  session.plan(['late plan'])
  session.cancel('a1')
  assert.equal(snapshots.length, before, 'plan/cancel are no-ops after finalize')
  console.log('ok: finalize aborts survivors, wakes awaiters, emits terminal snapshot')
}

async function testNoProgressWakesMaster(): Promise<void> {
  const { session, pending } = harness()
  const id = session.spawn({ task: 'stuck scanner' })
  await tick()
  // The master parks in awaitNext while the agent runs — this is the hole that
  // let one spinning agent block the whole run for 37 minutes.
  const waiting = session.awaitNext()
  // The agent's loop escalates: it's been re-issuing the same call to no effect.
  const signal = {
    repeats: 12,
    label: 'ext_read_page format=markdown',
    distinct: 3,
    windowSize: 24
  }
  pending[0].args.onNoProgress(signal)
  const outcome = await waiting
  assert.ok(outcome && outcome.kind === 'no_progress', 'a no-progress escalation wakes the master')
  assert.equal(outcome.id, id)
  assert.equal(outcome.signal.repeats, 12)
  assert.match(outcome.signal.label, /ext_read_page/)

  // Consumed once: with the agent still running and no NEW escalation, the next
  // await parks again rather than re-firing the stale notice. Prove it stays
  // parked by racing it against a tick.
  const parked = session.awaitNext()
  const raced = await Promise.race([parked, tick().then(() => 'still-parked' as const)])
  assert.equal(raced, 'still-parked', 'a consumed no-progress notice is not re-delivered')

  // A real landing supersedes the notice and resolves the parked master — even
  // if the agent had a stale no-progress flag, the completion wins.
  pending[0].resolve({ text: 'partial findings', stopReason: 'end_turn', failed: false })
  const landed = landing(await parked)
  assert.equal(landed.id, id)
  assert.equal(landed.result.text, 'partial findings')
  session.finalize('completed')
  console.log('ok: no-progress wakes a parked master; consumed once; a landing supersedes it')
}

async function testLandingBeatsNoProgress(): Promise<void> {
  const { session, pending } = harness()
  const stuck = session.spawn({ task: 'stuck' })
  const quick = session.spawn({ task: 'quick' })
  await tick()
  // Both a landing and a no-progress notice are pending at once → the landing is
  // served first (a finished agent is more actionable than a stuck one).
  pending[0].args.onNoProgress({
    repeats: 15,
    label: 'ext_read_page format=markdown',
    distinct: 2,
    windowSize: 24
  })
  pending[1].resolve({ text: 'quick done', stopReason: 'end_turn', failed: false })
  // Let the landing settle into the landed queue so BOTH a landing and a
  // no-progress notice are pending when awaitNext scans — the point of the test.
  await tick()
  const first = await session.awaitNext()
  assert.ok(first && first.kind === 'landed', 'landing served before the no-progress notice')
  assert.equal(first.id, quick)
  // The stuck agent's notice is still available on the next await.
  const second = await session.awaitNext()
  assert.ok(second && second.kind === 'no_progress')
  assert.equal(second.id, stuck)
  session.finalize('completed')
  console.log('ok: a landing is served before a pending no-progress notice')
}

async function main(): Promise<void> {
  await testSpawnAwaitTelemetry()
  await testFirstLandingWins()
  await testConcurrencyCapQueues()
  await testTotalCapThrows()
  await testSendToAndGuards()
  await testFailureAsData()
  await testCancelAndLateCompletion()
  await testFinalizeTerminalSnapshot()
  await testNoProgressWakesMaster()
  await testLandingBeatsNoProgress()
  console.log('\nAll workflow-session tests passed.')
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  }
)
