/**
 * appendTextSegment — the accumulator's prose folder.
 *
 * The contract under test: adjacent text ticks from the same author fold
 * into ONE segment (first tick's segmentId names the run, deltas concatenate
 * in order), while every boundary stays a boundary — a different turn, a
 * worker line against the main line, two different workers, or any non-text
 * segment between. One heartbeat reply used to persist as 2,441 few-character
 * text segments; folded, it is a handful.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/text-coalesce.test.ts
 */

import type { Segment } from '@main/runtime/broca'
import { appendTextSegment } from '@main/runtime/broca'

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

const text = (
  delta: string,
  id: string,
  turnId = 't1',
  worker?: { id: string; label: string }
): Extract<Segment, { kind: 'text' }> => ({
  kind: 'text',
  turnId,
  segmentId: id,
  delta,
  ...(worker ? { worker } : {})
})

// A streamed reply: many few-character ticks fold to one segment.
{
  const segments: Segment[] = []
  for (let i = 0; i < 500; i++) appendTextSegment(segments, text(`w${i} `, `s${i}`))
  ok('ticks fold to one segment', segments.length === 1, `${segments.length}`)
  const first = segments[0]
  ok('first tick names the run', first.kind === 'text' && first.segmentId === 's0')
  ok(
    'deltas concatenate in order',
    first.kind === 'text' && first.delta.startsWith('w0 w1 w2') && first.delta.endsWith('w499 ')
  )
}

// A non-text segment between two runs keeps them apart.
{
  const segments: Segment[] = []
  appendTextSegment(segments, text('before', 'a'))
  segments.push({
    kind: 'tool_call',
    turnId: 't1',
    segmentId: 'c1',
    toolCallId: 'call1',
    name: 'shell',
    args: {}
  })
  appendTextSegment(segments, text('after', 'b'))
  ok('tool boundary splits runs', segments.length === 3)
}

// Turn and author boundaries never fold.
{
  const segments: Segment[] = []
  appendTextSegment(segments, text('one', 'a', 't1'))
  appendTextSegment(segments, text('two', 'b', 't2'))
  ok('a new turn is a new segment', segments.length === 2)

  const workers: Segment[] = []
  appendTextSegment(workers, text('main', 'a'))
  appendTextSegment(workers, text('agent', 'b', 't1', { id: 'w1', label: 'Scout' }))
  appendTextSegment(workers, text('agent more', 'c', 't1', { id: 'w1', label: 'Scout' }))
  appendTextSegment(workers, text('other agent', 'd', 't1', { id: 'w2', label: 'Judge' }))
  ok('worker lines stay their own runs', workers.length === 3, `${workers.length}`)
  const middle = workers[1]
  ok(
    'same worker folds its own ticks',
    middle.kind === 'text' && middle.delta === 'agentagent more'
  )
}

// The fold replaces the tail object rather than mutating it — a mirror that
// captured the previous reference must not see it grow underneath.
{
  const segments: Segment[] = []
  appendTextSegment(segments, text('first', 'a'))
  const captured = segments[0]
  appendTextSegment(segments, text(' second', 'b'))
  ok('captured reference is not mutated', captured.kind === 'text' && captured.delta === 'first')
  const tail = segments[0]
  ok('tail holds the folded run', tail.kind === 'text' && tail.delta === 'first second')
}

console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
