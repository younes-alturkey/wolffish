import {
  loadConversation,
  resolveSummaryMarkIndex,
  updateConversation,
  type ConversationFile,
  type ConversationMessage
} from '@main/conversations'
import { turnScope } from '@main/runtime/corpus'
import type { Thalamus } from '@main/runtime/thalamus'

/**
 * Post-turn rolling prefix summarizer. When a conversation's replayable
 * content outgrows verbatim replay, summarize everything before a
 * turn-boundary mark ONCE and persist {summary, summarizedThroughMessage}
 * into the ConversationFile. Both rebuild paths then replay
 * `summary + tail` — replacing the old behavior where an over-threshold
 * conversation re-paid an in-memory compaction (including a fresh LLM
 * summary call) on EVERY subsequent message.
 *
 * Fire-and-forget: called after a turn is persisted (channel onTurnEnded /
 * the conversation:save IPC), never blocks a turn, one in-flight run per
 * conversation. The summarized turns stay on disk and indexed —
 * conversation_read retrieves them verbatim.
 */

/** Unsummarized replay content (chars) that triggers (re)summarization. */
const SUMMARIZE_THRESHOLD_CHARS = 120_000
/** Most recent messages always replayed verbatim, never summarized. */
const KEEP_TAIL_MESSAGES = 8
/** Per-message excerpt cap fed to the summarization prompt. */
const SUMMARY_INPUT_PER_MESSAGE = 2_000
/** Ceiling on the stored summary itself. */
const SUMMARY_MAX_CHARS = 6_000

const inFlight = new Set<string>()

export type SummaryUpdate = {
  conversationId: string
  summary: string
  summarizedThroughMessage: number
  /** Id of the first uncovered message — null while a transition file still lacks message ids. */
  summarizedThroughMessageId: string | null
}

let configured: {
  thalamus: Thalamus
  onUpdated?: (update: SummaryUpdate) => void
} | null = null

/**
 * Wire the summarizer once at startup (index.ts): the thalamus that makes
 * the summary LLM call, and the push that tells the renderer to fold a new
 * summary into its in-memory conversation (so its next whole-file save
 * doesn't clobber it).
 */
export function configureSummarizer(deps: {
  thalamus: Thalamus
  onUpdated?: (update: SummaryUpdate) => void
}): void {
  configured = deps
}

/**
 * Fire-and-forget entry point for the persistence seams (channel post-turn
 * saves, the conversation:save IPC). Never throws, never blocks a turn.
 */
export function queueConversationSummarization(conversationId: string): void {
  if (!configured) return
  const { thalamus, onUpdated } = configured
  // The sealed turnScope keeps the summary call's llm.response emit out of
  // any live turn's relay — this runs post-save for one conversation while a
  // DIFFERENT conversation's turn may be streaming, and the relay would
  // stamp the spend onto that unrelated turn. The ledger listener records
  // it regardless (corpus-level, not relay-level).
  void turnScope.run({ turnId: null, conversationId, autonomous: true }, () =>
    maybeSummarizeConversation(conversationId, thalamus, onUpdated)
  )
}

/**
 * Check the conversation and (re)generate its prefix summary if the
 * unsummarized region has outgrown the threshold. Returns the update when a
 * new summary was written, null otherwise. Never throws.
 */
export async function maybeSummarizeConversation(
  conversationId: string,
  thalamus: Thalamus,
  onUpdated?: (update: SummaryUpdate) => void
): Promise<SummaryUpdate | null> {
  if (inFlight.has(conversationId)) return null
  inFlight.add(conversationId)
  try {
    const conv = await loadConversation(conversationId)
    if (!conv || conv.sealed) return null

    const mark = resolveSummaryMarkIndex(
      conv.messages,
      conv.summarizedThroughMessage,
      conv.summarizedThroughMessageId
    )
    const newMark = pickNewMark(conv, mark)
    if (newMark === null) return null

    const rendered = conv.messages
      .slice(mark, newMark)
      .map((m, i) => renderForSummary(m, mark + i))
      .join('\n\n')

    const prompt =
      `You are compressing the earlier part of an ongoing conversation into a rolling summary the assistant will rely on in place of the verbatim transcript.\n` +
      `Preserve: user goals and decisions, exact names/emails/dates/numbers/IDs/URLs/file paths, what was produced or delivered (and where), commitments made, unresolved threads, and user preferences expressed.\n` +
      `Drop: pleasantries, tool mechanics, dead ends. Write tight prose bullets. HARD LIMIT ${SUMMARY_MAX_CHARS} characters.\n\n` +
      (conv.summary
        ? `Existing summary of even earlier turns (fold it in):\n${conv.summary}\n\n`
        : '') +
      `Transcript to fold in:\n\n${rendered}`

    let text: string
    try {
      const result = await thalamus.summarize(prompt)
      text = result.text.trim()
    } catch {
      return null
    }
    if (!text) return null
    if (text.length > SUMMARY_MAX_CHARS) text = text.slice(0, SUMMARY_MAX_CHARS) + '…'

    // The summary covered messages [mark, newMark) of the copy we loaded —
    // pin the boundary to that exact logical message by ID, not position:
    // a merge may have inserted messages before newMark by the time the
    // write below runs, and a positional mark would silently shift what the
    // summary claims to cover. Null for a transition file whose messages
    // still lack ids — the numeric mark carries it alone, as before.
    const markId = conv.messages[newMark]?.id ?? null

    // RMW inside the file's write queue: the renderer (or a channel) may
    // append a newer turn while the LLM call runs — the summary lands on the
    // freshest copy atomically, so concurrent writers can't clobber messages
    // and a racing whole-file save can't drop this summary.
    let wrote = false
    let finalMark = newMark
    await updateConversation(conversationId, (fresh) => {
      if (!fresh) return null
      wrote = true
      fresh.summary = text
      // Re-anchor the numeric mark onto the FRESH transcript so the two
      // forms agree on disk; the id keeps it honest wherever it resolves.
      const freshIdx = markId ? fresh.messages.findIndex((m) => m.id === markId) : -1
      finalMark = freshIdx >= 0 ? freshIdx : newMark
      fresh.summarizedThroughMessage = finalMark
      fresh.summarizedThroughMessageId = markId
      return fresh
    })
    if (!wrote) return null

    const update: SummaryUpdate = {
      conversationId,
      summary: text,
      summarizedThroughMessage: finalMark,
      summarizedThroughMessageId: markId
    }
    onUpdated?.(update)
    return update
  } catch {
    return null
  } finally {
    inFlight.delete(conversationId)
  }
}

/**
 * Where the new mark should land: keep the last KEEP_TAIL_MESSAGES verbatim,
 * snap back to a user-message boundary (replay must start on a user turn or
 * providers reject the shape), and only move if the region to fold in has
 * actually outgrown the threshold.
 */
function pickNewMark(conv: ConversationFile, mark: number): number | null {
  const total = conv.messages.length
  let candidate = total - KEEP_TAIL_MESSAGES
  while (candidate > mark && conv.messages[candidate]?.role !== 'user') candidate--
  if (candidate <= mark) return null

  let unsummarizedChars = 0
  for (let i = mark; i < candidate; i++) {
    unsummarizedChars += messageSizeChars(conv.messages[i])
  }
  if (unsummarizedChars < SUMMARIZE_THRESHOLD_CHARS) return null
  return candidate
}

/** Approximate replay weight of one persisted message. */
export function messageSizeChars(msg: ConversationMessage): number {
  let size = msg.content?.length ?? 0
  for (const seg of msg.segments ?? []) {
    if (seg.kind === 'text') size += seg.delta.length
    else if (seg.kind === 'tool_result') size += seg.output.length
    else if (seg.kind === 'tool_call') size += 100
  }
  return size
}

function renderForSummary(msg: ConversationMessage, index: number): string {
  const parts: string[] = []
  const text = msg.content?.trim()
  if (text) parts.push(text.slice(0, SUMMARY_INPUT_PER_MESSAGE))
  for (const seg of msg.segments ?? []) {
    if (seg.kind === 'tool_call') {
      parts.push(`[called ${seg.name}]`)
    } else if (seg.kind === 'tool_result' && seg.output) {
      parts.push(`[result: ${seg.output.slice(0, 400)}]`)
    }
  }
  return `#${index} ${msg.role}:\n${parts.join('\n').slice(0, SUMMARY_INPUT_PER_MESSAGE * 2)}`
}
