/**
 * Behavior tests for the no-progress guard — the repetition detector that
 * surfaces (never enforces) a "you keep making the same call" signal.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/no-progress-guard.test.ts
 */
import assert from 'node:assert/strict'
import {
  NoProgressTracker,
  noProgressNotice,
  toolCallSignature,
  NO_PROGRESS_WORKER_REPEATS,
  NO_PROGRESS_MASTER_REPEATS,
  NO_PROGRESS_WINDOW
} from '@main/runtime/agent/no-progress-guard'

function testDiverseWorkNeverTrips(): void {
  const t = new NoProgressTracker()
  // A full window of DISTINCT calls — real progress. Nothing repeats.
  for (let i = 0; i < NO_PROGRESS_WINDOW; i++) t.record('ext_read_page', { url: `https://x/${i}` })
  assert.equal(t.signal(), null, 'no repetition → no signal')
  assert.equal(noProgressNotice(t.signal()), null)
  console.log('ok: a full window of distinct calls never trips')
}

function testIdenticalRepeatTrips(): void {
  const t = new NoProgressTracker()
  for (let i = 0; i < NO_PROGRESS_WORKER_REPEATS; i++)
    t.record('ext_read_page', { format: 'markdown' })
  const sig = t.signal()
  assert.ok(sig)
  assert.equal(sig.repeats, NO_PROGRESS_WORKER_REPEATS)
  const notice = noProgressNotice(sig)
  assert.ok(notice, 'reaching the worker bar surfaces a notice')
  assert.match(notice, /ext_read_page/, 'the notice names the repeated call')
  assert.match(notice, new RegExp(`${NO_PROGRESS_WORKER_REPEATS} times`))
  console.log('ok: an identical call repeated to the worker bar trips a named notice')
}

function testBelowBarNoNotice(): void {
  const t = new NoProgressTracker()
  // One short of the bar — a legit double/triple-check must not nag.
  for (let i = 0; i < NO_PROGRESS_WORKER_REPEATS - 1; i++) t.record('web_search', { q: 'same' })
  const sig = t.signal()
  assert.ok(sig)
  assert.equal(sig.repeats, NO_PROGRESS_WORKER_REPEATS - 1)
  assert.equal(noProgressNotice(sig), null, 'below the worker bar → no notice')
  console.log('ok: repetition below the worker bar surfaces no notice')
}

function testPingPongTripsOnIdenticalRead(): void {
  // The actual incident shape: switch tab → read → switch tab → read, where the
  // read ("current page") is byte-identical every time.
  const t = new NoProgressTracker()
  for (let i = 0; i < 8; i++) {
    t.record('ext_switch_tab', { tab: i % 2 === 0 ? 'A' : 'B' })
    t.record('ext_read_page', { format: 'markdown' })
  }
  const sig = t.signal()
  assert.ok(sig)
  assert.match(sig.label, /ext_read_page/, 'the dominant repeated call is the read')
  assert.ok(sig.repeats >= NO_PROGRESS_WORKER_REPEATS)
  assert.ok(noProgressNotice(sig))
  console.log('ok: switch↔read ping-pong trips on the identical read')
}

function testMasterBarReached(): void {
  const t = new NoProgressTracker()
  for (let i = 0; i < NO_PROGRESS_MASTER_REPEATS; i++)
    t.record('ext_read_page', { format: 'markdown' })
  const sig = t.signal()
  assert.ok(sig && sig.repeats >= NO_PROGRESS_MASTER_REPEATS, 'repeats reach the master bar')
  console.log('ok: sustained repetition reaches the master escalation bar')
}

function testRollingRecoveryClearsNotice(): void {
  const t = new NoProgressTracker()
  for (let i = 0; i < NO_PROGRESS_WORKER_REPEATS + 2; i++)
    t.record('ext_read_page', { format: 'markdown' })
  assert.ok(noProgressNotice(t.signal()), 'tripped while spinning')
  // The agent moves on to distinct work — the old repeats roll out of the window.
  for (let i = 0; i < NO_PROGRESS_WINDOW; i++) t.record('other_tool', { i })
  assert.equal(noProgressNotice(t.signal()), null, 'notice clears once repetition rolls off')
  console.log('ok: the notice self-clears once the repetition leaves the window')
}

function testSignatureDistinguishesArgsAndIsStable(): void {
  assert.notEqual(
    toolCallSignature('ext_read_page', { url: 'a' }),
    toolCallSignature('ext_read_page', { url: 'b' }),
    'different args → different signature'
  )
  assert.equal(
    toolCallSignature('t', { a: 1, b: 2 }),
    toolCallSignature('t', { b: 2, a: 1 }),
    'key order does not change the signature'
  )
  assert.notEqual(
    toolCallSignature('read', { x: 1 }),
    toolCallSignature('write', { x: 1 }),
    'different tool name → different signature'
  )
  // Missing/empty args are handled without throwing.
  assert.equal(typeof toolCallSignature('t', undefined), 'string')
  console.log('ok: signature distinguishes tool+args and is key-order stable')
}

function main(): void {
  testDiverseWorkNeverTrips()
  testIdenticalRepeatTrips()
  testBelowBarNoNotice()
  testPingPongTripsOnIdenticalRead()
  testMasterBarReached()
  testRollingRecoveryClearsNotice()
  testSignatureDistinguishesArgsAndIsStable()
  console.log('\nAll no-progress-guard tests passed.')
}

main()
