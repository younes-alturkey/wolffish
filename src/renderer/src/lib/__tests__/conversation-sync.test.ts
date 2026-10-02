/**
 * What an open chat feed does with the conversation file another surface just
 * wrote — the diff behind "you answer on your phone while this chat sits on
 * screen".
 *
 * The bug this pins: a turn run from the phone (or Telegram, or an automation)
 * streams throttled snapshots of its assistant message into the open feed
 * under the id it will be SAVED with. The last snapshot always stops short of
 * the finished answer, and for a short reply the only snapshot the window ever
 * got was the first one — a model chip, no prose, which draws as an empty
 * bubble. The diff was append-only, so the fold's complete copy was discarded
 * for carrying an id the feed already knew: the prompt sat under a blank
 * answer until the whole app was restarted (closing the window only hides it,
 * so the stale feed survived).
 *
 * So: appends are still appends, a stale copy is refreshed in place, and a
 * copy that would go BACKWARDS (a mid-turn checkpoint landing behind a live
 * mirror) is refused.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx \
 *     src/renderer/src/lib/__tests__/conversation-sync.test.ts
 */

import type { ConversationFile, ConversationMessage } from '@preload/index'
import type { ChatMessage } from '@providers/flow/useFlow'
import { reconcileFeedWithDisk } from '../conversation-open'

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

/** Chat.tsx's own feed→file projection, the rule this diff must count by. */
function isPersisted(m: ChatMessage): boolean {
  if (m.role === 'user') return true
  if (m.role === 'assistant' && m.status === 'error') return true
  if (m.role === 'assistant' && m.status === 'complete') return m.segments.length > 0
  return false
}

const chip = (id = 'c1'): Record<string, unknown> => ({
  kind: 'active_model',
  turnId: 't1',
  segmentId: id,
  provider: 'anthropic',
  model: 'claude-test'
})
const text = (delta: string, id = 's1'): Record<string, unknown> => ({
  kind: 'text',
  turnId: 't1',
  segmentId: id,
  delta
})

function diskUser(id: string, content: string): ConversationMessage {
  return { id, role: 'user', content, timestamp: 1 } as ConversationMessage
}
function diskAssistant(id: string, segments: Array<Record<string, unknown>>): ConversationMessage {
  const content = segments
    .filter((s) => s.kind === 'text')
    .map((s) => String(s.delta))
    .join('')
  return { id, role: 'assistant', content, timestamp: 2, segments } as ConversationMessage
}
function file(messages: ConversationMessage[]): ConversationFile {
  return {
    id: 'conv-1',
    title: 'T',
    model: null,
    messages,
    createdAt: 0,
    updatedAt: 0
  } as ConversationFile
}
function feedUser(id: string, content: string): ChatMessage {
  return { id, role: 'user', content, timestamp: 1 } as ChatMessage
}
function feedAssistant(id: string, segments: Array<Record<string, unknown>>): ChatMessage {
  return { id, role: 'assistant', segments, status: 'complete', timestamp: 2 } as ChatMessage
}

function run(): void {
  // --------------------------------------------------- the plain append case
  {
    const feed = [feedUser('m1', 'hi')]
    const next = reconcileFeedWithDisk(
      feed,
      file([diskUser('m1', 'hi'), diskAssistant('m2', [text('hello back')])]),
      isPersisted
    )
    ok('a reply written elsewhere is appended', next.length === 2 && next[1]?.id === 'm2')
    ok('... and the message already on screen is the SAME object', next[0] === feed[0])
  }

  // ------------------------------------------------------------ the no-op case
  {
    const feed = [feedUser('m1', 'hi'), feedAssistant('m2', [text('hello back')])]
    const next = reconcileFeedWithDisk(
      feed,
      file([diskUser('m1', 'hi'), diskAssistant('m2', [text('hello back')])]),
      isPersisted
    )
    ok('nothing new, nothing grown — the feed array itself is returned', next === feed)
  }

  // ------------------------------------------------------- the regression case
  // The feed holds the FIRST mirror snapshot: a model chip and no prose. Disk
  // now holds the finished answer under that same id.
  {
    const feed = [feedUser('m1', 'chart please'), feedAssistant('m2', [chip()])]
    const next = reconcileFeedWithDisk(
      feed,
      file([
        diskUser('m1', 'chart please'),
        diskAssistant('m2', [chip(), text('Here is the chart.')])
      ]),
      isPersisted
    )
    ok('the half-written bubble is not duplicated', next.length === 2)
    const refreshed = next[1]
    ok('... it is replaced in place, under the same id', refreshed?.id === 'm2')
    ok(
      '... and now carries the finished answer',
      refreshed?.role === 'assistant' &&
        refreshed.segments.some((s) => s.kind === 'text' && s.delta === 'Here is the chart.'),
      JSON.stringify(refreshed)
    )
    ok('... while the prompt above it is untouched', next[0] === feed[0])
  }

  // Same thing when the reply also grew a following message: refresh AND append
  // in one pass.
  {
    const feed = [feedUser('m1', 'go'), feedAssistant('m2', [text('Wor')])]
    const next = reconcileFeedWithDisk(
      feed,
      file([
        diskUser('m1', 'go'),
        diskAssistant('m2', [text('Working on it. Done.')]),
        diskUser('m3', 'thanks')
      ]),
      isPersisted
    )
    ok(
      'a refresh and an append land together',
      next.length === 3 &&
        next[1]?.role === 'assistant' &&
        next[1].segments.some((s) => s.kind === 'text' && s.delta === 'Working on it. Done.') &&
        next[2]?.id === 'm3',
      JSON.stringify(next.map((m) => m.id))
    )
  }

  // ------------------------------------------------------- the backwards guard
  // A mid-turn checkpoint can hit disk while the live mirror is already
  // further along. Adopting it would rewind the bubble mid-answer.
  {
    const feed = [feedUser('m1', 'go'), feedAssistant('m2', [text('Working on it. Done.')])]
    const next = reconcileFeedWithDisk(
      feed,
      file([diskUser('m1', 'go'), diskAssistant('m2', [text('Wor')])]),
      isPersisted
    )
    ok('a shorter disk copy never replaces a longer live one', next === feed)
  }

  // A non-persisted bubble (the streaming placeholder this session owns) is
  // never counted as held, and never replaced by a disk message that happens
  // to share its id.
  {
    const streaming = { id: 'm2', role: 'assistant', segments: [], status: 'streaming' } as unknown
    const feed = [feedUser('m1', 'go'), streaming as ChatMessage]
    const next = reconcileFeedWithDisk(
      feed,
      file([diskUser('m1', 'go'), diskAssistant('m2', [text('from elsewhere')])]),
      isPersisted
    )
    ok(
      'a live placeholder is left alone and the disk copy arrives beside it',
      next.length === 3 && next[1] === streaming && next[2]?.id === 'm2',
      JSON.stringify(next.map((m) => m.id))
    )
  }

  // ------------------------------------------------ the cards are not dropped
  // Approvals, asks and tool timings live in the feed, not (all) on disk — a
  // mid-turn checkpoint's copy carries no approvals at all. A refresh that
  // swapped them away would take the cards out from under a finished turn,
  // and the next whole-file save (which writes what the FEED holds) would
  // make that permanent.
  {
    const held = {
      id: 'm2',
      role: 'assistant',
      segments: [text('Wor')],
      status: 'complete',
      approvals: { c1: { approvalId: 'a1', toolCallId: 'c1', decision: 'approved' } },
      asks: { c2: { askId: 'k1', answered: true } },
      toolTimings: { c1: { startedAt: 1, endedAt: 2 } }
    } as unknown as ChatMessage
    const next = reconcileFeedWithDisk(
      [feedUser('m1', 'go'), held],
      file([diskUser('m1', 'go'), diskAssistant('m2', [text('Working on it. Done.')])]),
      isPersisted
    )
    const refreshed = next[1] as unknown as Record<string, Record<string, unknown>>
    ok(
      'the refreshed bubble keeps its approval, ask and timing cards',
      refreshed.approvals?.c1 !== undefined &&
        refreshed.asks?.c2 !== undefined &&
        refreshed.toolTimings?.c1 !== undefined,
      JSON.stringify(refreshed)
    )
  }

  // --------------------------------------------------- the id-less transition
  {
    const feed = [{ id: 'x', role: 'user', content: 'hi', timestamp: 1 } as ChatMessage]
    const legacy = file([
      { role: 'user', content: 'hi', timestamp: 1 } as ConversationMessage,
      { role: 'assistant', content: 'hello', timestamp: 2 } as ConversationMessage
    ])
    const next = reconcileFeedWithDisk(feed, legacy, isPersisted)
    ok('an id-less file still appends positionally', next.length === 2)
    ok(
      '... and an id-less file with nothing new is a no-op',
      reconcileFeedWithDisk(next, legacy, isPersisted) === next
    )
  }

  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

run()
