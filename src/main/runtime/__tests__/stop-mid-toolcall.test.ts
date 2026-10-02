/**
 * Stop-mid-tool-call tests — pins the fix for the bug where stopping a run
 * while a tool was executing left an assistant `tool_calls` message with no
 * matching tool result. The next request then failed with provider HTTP 400
 * ("An assistant message with 'tool_calls' must be followed by tool messages
 * responding to each 'tool_call_id'"), and the running tool was never
 * actually interrupted.
 *
 * Three layers, matching the fix:
 *   1. Broca.closeOpenToolCalls — emits a synthetic tool_result for every
 *      tool_call announced but not resolved when a turn ends abruptly, so the
 *      persisted segment stream is always balanced at the source.
 *   2. assistantSegmentsToHistory (shared Telegram/WhatsApp rebuild) —
 *      backfills a canceled tool result for any dangling tool_call segment,
 *      healing conversations saved before the source-side fix.
 *   3. Motor.executeStep — an aborted signal stops the step without invoking
 *      the plugin, and a live signal is threaded down to the plugin so an
 *      in-flight tool can actually be canceled.
 *
 * Run: npx tsx src/main/runtime/__tests__/stop-mid-toolcall.test.ts
 */

import { assistantSegmentsToHistory } from '../../channels/channel'
import { Broca, type Segment } from '../broca'
import { Motor } from '../motor'
import type { ToolCall } from '../wernicke'

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

type ToolResultSegment = Extract<Segment, { kind: 'tool_result' }>

// ---------------------------------------------------------------------------
// Layer 1 — Broca.closeOpenToolCalls
// ---------------------------------------------------------------------------

function testBroca(): void {
  const segs: Segment[] = []
  const broca = new Broca()
  broca.beginTurn('t1', (s) => segs.push(s))

  // Two tool calls announced; only the second resolves (the first was still
  // running when the user pressed stop and got killed).
  broca.emitToolCall('t1', 'call_1', 'shell_exec', { command: 'sleep 100' })
  broca.emitToolCall('t1', 'call_2', 'read_file', { path: 'a.txt' })
  broca.emitToolResult('t1', 'call_2', 'success', 'done')

  const closed = broca.closeOpenToolCalls('t1', 'failed', 'stopped')
  ok(
    'closeOpenToolCalls closes only the unresolved call',
    closed.length === 1 && closed[0] === 'call_1',
    JSON.stringify(closed)
  )

  const results = segs.filter((s): s is ToolResultSegment => s.kind === 'tool_result')
  ok(
    'synthetic failed result emitted for the unresolved call',
    results.some((r) => r.toolCallId === 'call_1' && r.status === 'failed')
  )
  ok(
    'resolved call gets exactly one result (no duplicate)',
    results.filter((r) => r.toolCallId === 'call_2').length === 1
  )
  ok(
    'every announced tool_call now has a result',
    new Set(results.map((r) => r.toolCallId)).size === 2
  )

  const closedAgain = broca.closeOpenToolCalls('t1', 'failed', 'stopped')
  ok('second close is a no-op', closedAgain.length === 0)

  // A user Stop closes the call as `stopped` (a warning on the card, not a
  // failure) and says who stopped it.
  broca.emitToolCall('t1', 'call_3', 'shell_exec', { command: 'sleep 100' })
  broca.closeOpenToolCalls('t1', 'stopped', 'stopped by the user', { stoppedBy: 'user' })
  const stoppedResult = segs.find(
    (s): s is ToolResultSegment => s.kind === 'tool_result' && s.toolCallId === 'call_3'
  )
  ok(
    'a user Stop closes the call as stopped, by the user',
    stoppedResult?.status === 'stopped' && stoppedResult.meta?.stoppedBy === 'user',
    JSON.stringify(stoppedResult)
  )

  broca.endTurn()

  // A clean turn (every call resolved) leaves nothing to close.
  const segs2: Segment[] = []
  const broca2 = new Broca()
  broca2.beginTurn('t2', (s) => segs2.push(s))
  broca2.emitToolCall('t2', 'c', 'read_file', {})
  broca2.emitToolResult('t2', 'c', 'success', 'ok')
  ok('clean turn has nothing to close', broca2.closeOpenToolCalls('t2', 'failed', 'x').length === 0)
  broca2.endTurn()
}

// ---------------------------------------------------------------------------
// Layer 2 — assistantSegmentsToHistory backfill
// ---------------------------------------------------------------------------

function testHistoryBackfill(): void {
  // A turn stopped mid-tool: the tool_call segment was persisted but no
  // tool_result followed (an older conversation saved before the source fix).
  const dangling: Segment[] = [
    { kind: 'active_model', turnId: 't', segmentId: 's1', provider: 'deepseek', model: 'x' },
    { kind: 'text', turnId: 't', segmentId: 's2', delta: 'Running a command…' },
    {
      kind: 'tool_call',
      turnId: 't',
      segmentId: 's3',
      toolCallId: 'call_1',
      name: 'shell_exec',
      args: { command: 'sleep 100' }
    },
    { kind: 'turn_end', turnId: 't', segmentId: 's4', stopReason: 'end_turn', iterationCount: 1 }
  ]
  const history = assistantSegmentsToHistory({
    role: 'assistant',
    content: '',
    segments: dangling
  } as never)

  const assistantIdx = history.findIndex((m) => m.role === 'assistant')
  const toolIdx = history.findIndex((m) => m.role === 'tool')
  const assistant = history[assistantIdx] as Extract<
    (typeof history)[number],
    { role: 'assistant' }
  >
  const toolMsgs = history.filter(
    (m): m is Extract<(typeof history)[number], { role: 'tool' }> => m.role === 'tool'
  )

  ok(
    'assistant message carries the announced tool_use',
    !!assistant?.toolUses &&
      assistant.toolUses.length === 1 &&
      assistant.toolUses[0].id === 'call_1'
  )
  ok(
    'dangling tool_call is backfilled with exactly one result',
    toolMsgs.length === 1 && toolMsgs[0].toolUseId === 'call_1'
  )
  ok('backfilled result is flagged as an error', toolMsgs[0]?.isError === true)
  ok('backfilled result has non-empty content', (toolMsgs[0]?.content ?? '').length > 0)
  ok('tool result immediately follows the assistant message', toolIdx === assistantIdx + 1)

  // Balanced case: a tool_call WITH a matching tool_result must not get a
  // second (backfilled) result.
  const balanced: Segment[] = [
    { kind: 'active_model', turnId: 't', segmentId: 's1', provider: 'x', model: 'y' },
    {
      kind: 'tool_call',
      turnId: 't',
      segmentId: 's2',
      toolCallId: 'c1',
      name: 'read_file',
      args: {}
    },
    {
      kind: 'tool_result',
      turnId: 't',
      segmentId: 's3',
      toolCallId: 'c1',
      status: 'success',
      output: 'ok'
    },
    { kind: 'turn_end', turnId: 't', segmentId: 's4', stopReason: 'end_turn', iterationCount: 1 }
  ]
  const h2 = assistantSegmentsToHistory({
    role: 'assistant',
    content: '',
    segments: balanced
  } as never)
  ok(
    'balanced tool_call is not double-backfilled',
    h2.filter((m) => m.role === 'tool').length === 1
  )
}

// ---------------------------------------------------------------------------
// Layer 3 — Motor.executeStep abort threading
// ---------------------------------------------------------------------------

async function testMotorAbort(): Promise<void> {
  const call: ToolCall = { id: 'call_1', name: 'shell_exec', args: {} }

  // A signal already aborted before the step runs: stop immediately, never
  // touch the plugin.
  let invoked = 0
  const preAborted = new Motor({
    cerebellum: {
      executeTool: async () => {
        invoked++
        return { success: true, output: 'ran' }
      }
    } as never
  })
  const t1 = await preAborted.createTask('test')
  const ac = new AbortController()
  ac.abort()
  const res = await preAborted.executeStep(t1.id, call, ac.signal)
  ok('pre-aborted step returns not-ok', res.ok === false)
  ok('pre-aborted step reports stopped', /stopped/i.test(res.output))
  ok('plugin is not invoked when pre-aborted', invoked === 0)

  // A live signal is forwarded to the plugin so the tool can cancel itself.
  let sawSignal: boolean = false
  const live = new Motor({
    cerebellum: {
      executeTool: async (_name: string, _args: Record<string, unknown>, signal?: AbortSignal) => {
        sawSignal = signal instanceof AbortSignal
        return { success: true, output: 'ok' }
      }
    } as never
  })
  const t2 = await live.createTask('test2')
  const res2 = await live.executeStep(t2.id, call, new AbortController().signal)
  ok('live step succeeds', res2.ok === true)
  ok('an AbortSignal is forwarded to the plugin', sawSignal)

  // Aborting the turn signal mid-task mirrors into the task controller so a
  // subsequent step is stopped even without an explicit stopTask call.
  const mirror = new Motor({
    cerebellum: { executeTool: async () => ({ success: true, output: 'ok' }) } as never
  })
  const t3 = await mirror.createTask('test3')
  const turnAc = new AbortController()
  // First step wires the external signal into the task controller.
  await mirror.executeStep(t3.id, call, turnAc.signal)
  turnAc.abort()
  const res3 = await mirror.executeStep(t3.id, { ...call, id: 'call_2' }, turnAc.signal)
  ok(
    'step after a mirrored turn-abort is stopped',
    res3.ok === false && /stopped/i.test(res3.output)
  )
}

async function main(): Promise<void> {
  testBroca()
  testHistoryBackfill()
  await testMotorAbort()
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
