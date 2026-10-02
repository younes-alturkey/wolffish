/**
 * fitMirrorMessage / fitWireMessages — the wire-budget trimmer.
 *
 * The contract under test: a snapshot inside the budget passes through
 * IDENTICAL (same reference, zero allocation); one outside comes back
 * renderable and under budget — id and role always kept, every segment still
 * present and in order for as long as the budget allows, the newest payloads
 * favored over the oldest — and the INPUT is never mutated, because the
 * accumulator's segments are the very objects the end-of-turn save persists.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/mirror-budget.test.ts
 */

import type { ConversationMessage } from '@main/conversations'
import type { Segment } from '@main/runtime/broca'
import {
  fitMirrorMessage,
  fitWireMessages,
  MIRROR_ELIDED_OUTPUT,
  MIRROR_TRIM_MARKER
} from '@main/channels/mirror-budget'

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

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))

const toolResult = (n: number, size: number): Segment => ({
  kind: 'tool_result',
  turnId: 't',
  segmentId: `sr${n}`,
  toolCallId: `c${n}`,
  status: 'success',
  output: `out-${n} ` + 'y'.repeat(size)
})

const toolCall = (n: number, argSize: number): Segment => ({
  kind: 'tool_call',
  turnId: 't',
  segmentId: `sc${n}`,
  toolCallId: `c${n}`,
  name: 'shell_exec',
  args: { command: `cmd-${n} ` + 'z'.repeat(argSize), nested: { note: 'n'.repeat(argSize) } }
})

const message = (segments: Segment[], content = 'hello'): ConversationMessage => ({
  id: 'm_1_aaaaaa',
  role: 'assistant',
  content,
  timestamp: 1,
  segments
})

const BUDGET = 64 * 1024

// ------------------------------------------------------------ under budget
{
  const small = message([toolResult(1, 100)])
  const out = fitMirrorMessage(small, BUDGET)
  ok('under budget: the same object back, untouched', out === small)
}

// ---------------------------------------------------- long strings capped
{
  const input = message([
    toolCall(1, 40 * 1024),
    toolResult(1, 40 * 1024),
    toolResult(2, 40 * 1024)
  ])
  const before = JSON.stringify(input)
  const out = fitMirrorMessage(input, BUDGET)
  ok('over budget: something came back', out !== null)
  ok('... under the budget', out !== null && bytes(out) <= BUDGET, String(out && bytes(out)))
  ok('... id and role kept', out?.id === 'm_1_aaaaaa' && out?.role === 'assistant')
  ok(
    '... every segment present, in order',
    (out?.segments ?? []).map((s) => s.segmentId).join(',') === 'sc1,sr1,sr2',
    JSON.stringify(out?.segments?.map((s) => s.segmentId))
  )
  const capped = out?.segments?.find((s) => s.segmentId === 'sr1')
  ok(
    '... a capped tool output keeps its head and says it was trimmed',
    capped?.kind === 'tool_result' &&
      capped.output.startsWith('out-1') &&
      capped.output.includes(MIRROR_TRIM_MARKER),
    capped?.kind === 'tool_result' ? capped.output.slice(0, 40) : String(capped?.kind)
  )
  const call = out?.segments?.find((s) => s.segmentId === 'sc1')
  ok(
    '... long strings inside tool args are capped too, nested ones included',
    call?.kind === 'tool_call' &&
      String(call.args.command).includes(MIRROR_TRIM_MARKER) &&
      String((call.args.nested as { note: string }).note).includes(MIRROR_TRIM_MARKER),
    call?.kind === 'tool_call' ? String(call.args.command).length.toString() : String(call?.kind)
  )
  ok('the input was not mutated', JSON.stringify(input) === before)
}

// ----------------------------------------------- count: oldest elided first
{
  // Each payload is under the string cap, so only whole-payload elision can
  // bring the total down. The newest must survive intact.
  const input = message(Array.from({ length: 200 }, (_, i) => toolResult(i, 1_500)))
  const before = JSON.stringify(input)
  const out = fitMirrorMessage(input, BUDGET)
  ok('count overflow: fits', out !== null && bytes(out) <= BUDGET, String(out && bytes(out)))
  ok('... every card still present', out?.segments?.length === 200, String(out?.segments?.length))
  const newest = out?.segments?.at(-1)
  const oldest = out?.segments?.[0]
  ok(
    '... newest payload whole',
    newest?.kind === 'tool_result' &&
      newest.output.startsWith('out-199') &&
      newest.output.length > 1_000,
    newest?.kind === 'tool_result' ? String(newest.output.length) : String(newest?.kind)
  )
  ok(
    '... oldest payload elided, structure kept',
    oldest?.kind === 'tool_result' &&
      oldest.output === MIRROR_ELIDED_OUTPUT &&
      oldest.toolCallId === 'c0',
    oldest?.kind === 'tool_result' ? oldest.output.slice(0, 40) : String(oldest?.kind)
  )
  ok('the input was not mutated', JSON.stringify(input) === before)
}

// -------------------------------------------------------- prose-only bulk
{
  const input = message([], 'p'.repeat(512 * 1024))
  const out = fitMirrorMessage(input, BUDGET)
  ok(
    'giant prose alone still fits',
    out !== null && bytes(out) <= BUDGET,
    String(out && bytes(out))
  )
  ok(
    '... keeping its newest end — the feed is pinned to the bottom',
    (out?.content ?? '').endsWith('p') && (out?.content ?? '').includes(MIRROR_TRIM_MARKER)
  )
}

// ------------------------------------------------------------- unfittable
{
  const circular: Record<string, unknown> = {}
  circular.self = circular
  const out = fitMirrorMessage(
    { id: 'm', role: 'assistant', content: '', timestamp: 1, segments: [circular as never] },
    BUDGET
  )
  ok('an unserializable message yields null, never a throw', out === null)
}

// -------------------------------------------------------- fitWireMessages
{
  const smallBody = [message([toolResult(1, 100)])]
  ok(
    'a body under the ceiling passes through untouched',
    fitWireMessages(smallBody, BUDGET) === smallBody
  )

  const bigBody = [
    { id: 'u', role: 'user', content: 'go', timestamp: 0 } as ConversationMessage,
    message(Array.from({ length: 300 }, (_, i) => toolResult(i, 1_500)))
  ]
  const fitted = fitWireMessages(bigBody, BUDGET)
  ok(
    'an oversized body comes back under the ceiling',
    bytes(fitted) <= BUDGET,
    String(bytes(fitted))
  )
  ok('... with every message still present', fitted.length === 2)
  ok('... the user message untouched', fitted[0] === bigBody[0])
}

console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
