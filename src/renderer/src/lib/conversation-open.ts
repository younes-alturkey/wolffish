import { keepLatestBrowserCard } from '@main/runtime/browser-card'
import type { ConversationFile, ConversationMessage, PersistedApproval } from '@preload/index'
import type { ApprovalCardState, AssistantStatus, ChatMessage } from '@providers/flow/useFlow'

/**
 * Map ONE persisted message into a feed message. Extracted so the live
 * channel-turn mirror (conversation.onMessageMirror) can map a single
 * in-progress assistant snapshot with the exact same rules the full-file
 * load uses — the mirrored message and the one the load later reads must be
 * byte-for-byte the same shape, or the id-keyed upsert would flicker.
 */
export function mapConversationMessage(m: ConversationMessage): ChatMessage {
  // The persisted id IS the feed id: persistConversation writes it back, so
  // the message keeps one identity across load → feed → save → merge (the
  // id-keyed reconcile in mergeConversationOnto depends on that round-trip).
  // Minting is the fallback for a pre-id file only — the launch migration
  // ids those before the renderer can load one, so it should never fire —
  // and the first save then adopts the minted ids onto disk.
  const msgId = m.id ?? `m_${m.timestamp}_${Math.random().toString(36).slice(2, 6)}`
  if (m.role === 'user') {
    return {
      id: msgId,
      role: 'user' as const,
      content: m.content,
      timestamp: m.timestamp,
      ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
      // Voice-note provenance has to survive the round-trip: dropping it
      // here would let a continued Telegram/WhatsApp conversation replay
      // every voice note's audio back to the LLM, which is exactly what
      // the flag exists to prevent.
      ...(m.voicePrompt ? { voicePrompt: true } : {}),
      ...(m.voiceLang ? { voiceLang: m.voiceLang } : {}),
      // The app's own aside (the Continue after a stalled call) must still
      // render as a note after a reload, not as the person's bubble.
      ...(m.systemAside ? { systemAside: true } : {})
    }
  }
  const segments = m.segments ?? [
    {
      kind: 'text' as const,
      delta: m.content,
      turnId: '',
      segmentId: `seg_${m.timestamp}`
    }
  ]
  const approvals = m.approvals
    ? (Object.fromEntries(
        Object.entries(m.approvals).map(([k, v]: [string, PersistedApproval]) => [
          k,
          v as ApprovalCardState
        ])
      ) as Record<string, ApprovalCardState>)
    : undefined
  const isError = !!m.error
  return {
    id: msgId,
    role: 'assistant' as const,
    segments,
    approvals,
    toolTimings: m.toolTimings,
    status: (isError ? 'error' : 'complete') as AssistantStatus,
    stopReason: m.stopReason,
    ...(isError ? { error: m.error } : {}),
    timestamp: m.timestamp
  }
}

/**
 * Map a persisted conversation's messages into feed messages — the shape a
 * Chat session renders. Shared by every open-conversation entry point
 * (History rows, the sidebar's Conversations list) so they can't drift.
 */
export function mapConversationMessages(conv: ConversationFile): ChatMessage[] {
  return keepLatestBrowserCard(conv.messages.map(mapConversationMessage))
}

/**
 * How much an assistant bubble actually carries: how many segments, and how
 * much streamed text inside them. Both grow monotonically through one turn —
 * every mirror snapshot is a superset of the one before it, and the
 * end-of-turn save is a superset of them all — which is what makes the pair
 * enough to tell a fresher copy from a staler one.
 */
function assistantWeight(m: ChatMessage): { segments: number; text: number } {
  if (m.role !== 'assistant') return { segments: 0, text: 0 }
  let text = 0
  for (const s of m.segments) {
    if ('delta' in s && typeof s.delta === 'string') text += s.delta.length
  }
  return { segments: m.segments.length, text }
}

/**
 * Is the persisted copy of a message ahead of the copy the feed holds?
 *
 * Only ever true for an assistant message that GREW: a user message never
 * changes after it is written, and "grew" is the only safe direction to
 * follow — a mid-turn checkpoint can hit disk while a live mirror is already
 * further along, and adopting that would rewind the bubble mid-answer.
 */
function diskCopyIsFresher(disk: ChatMessage, feed: ChatMessage): boolean {
  if (disk.role !== 'assistant' || feed.role !== 'assistant') return false
  const fresh = assistantWeight(disk)
  const current = assistantWeight(feed)
  return fresh.segments > current.segments || fresh.text > current.text
}

/**
 * The refreshed copy of a bubble, carrying forward the state that lives only
 * in the feed.
 *
 * A persisted message is not a superset of the one on screen: approval and
 * ask cards and tool timings are renderer-side state (asks are never written
 * at all, and a mid-turn checkpoint's copy carries no approvals), so a plain
 * swap would take the cards out from under a turn that just finished — and
 * the next whole-file save, which writes what the FEED holds, would make that
 * loss permanent. Disk wins on the answer itself (segments, prose, stop
 * reason); the feed wins on the cards it is showing.
 */
function withLiveState(fresh: ChatMessage, held: ChatMessage): ChatMessage {
  if (fresh.role !== 'assistant' || held.role !== 'assistant') return fresh
  const approvals =
    fresh.approvals || held.approvals ? { ...fresh.approvals, ...held.approvals } : undefined
  const toolTimings =
    fresh.toolTimings || held.toolTimings
      ? { ...fresh.toolTimings, ...held.toolTimings }
      : undefined
  return {
    ...fresh,
    ...(approvals ? { approvals } : {}),
    ...(toolTimings ? { toolTimings } : {}),
    ...(held.asks ? { asks: held.asks } : {})
  }
}

/**
 * Bring an open feed up to date with the conversation file another surface
 * wrote — the phone, Telegram, WhatsApp, an automation, the CLI.
 *
 * Two jobs, and for a long time it only did the first:
 *
 *  - APPEND what the feed has never seen (the disk messages whose ids it
 *    doesn't hold), which is how a reply typed elsewhere lands in a chat
 *    sitting open on screen.
 *  - REFRESH what the feed holds a STALE copy of. A run on another surface
 *    streams its assistant message into this feed as throttled snapshots
 *    under the id it will be saved with, and the last snapshot always stops
 *    short of the finished answer — a reply that finishes inside the throttle
 *    window leaves the feed on the FIRST snapshot, often segments-only (a
 *    model chip), which draws as an empty bubble. Append-only then discarded
 *    the fold's complete copy for carrying an id the feed already knew, so
 *    the prompt sat under a blank answer until the app was restarted (closing
 *    the window only hides it — the feed survives).
 *
 * Returns `prev` itself when nothing changed, so React bails out and nothing
 * re-renders: the broadcast behind this carries no conversation id, so it
 * fires for every conversation's writes and most calls are no-ops.
 *
 * `isPersisted` is the caller's own feed→file projection (Chat's
 * isPersistedMessage) rather than a copy of it: this has to count what the
 * feed holds exactly the way the writer counts it, and a second definition
 * that drifted would mis-index the transcript.
 */
export function reconcileFeedWithDisk(
  prev: ChatMessage[],
  conv: ConversationFile,
  isPersisted: (m: ChatMessage) => boolean
): ChatMessage[] {
  const persistedPrev = prev.filter(isPersisted)
  // Id-keyed diff when both sides are fully id'd (every post-migration file
  // and every live feed): the tail is exactly the disk messages the feed
  // doesn't hold. Positions can't fool it — a diverged writer reconciled by
  // the merge may land its message BEFORE ours in the file, where a
  // count-based slice would grab our own messages back as "new" and duplicate
  // them in the feed. Appended at the end even if the file holds it mid-array:
  // feed order self-corrects on the next full load, and an append is what
  // keeps React from remounting the bubbles already on screen.
  if (conv.messages.every((m) => m.id) && persistedPrev.every((m) => m.id)) {
    const held = new Map(persistedPrev.map((m) => [m.id, m]))
    const tail = conv.messages.filter((m) => !held.has(m.id!))
    const refreshed = new Map<string, ChatMessage>()
    for (const m of conv.messages) {
      // Only an assistant message can ever be fresher on disk, and this loop
      // runs on a broadcast that fires for EVERY conversation's writes — so
      // the role check comes before the mapping, not inside the comparison.
      if (m.role !== 'assistant') continue
      const feedCopy = held.get(m.id!)
      if (!feedCopy) continue
      const mapped = mapConversationMessage(m)
      if (diskCopyIsFresher(mapped, feedCopy)) refreshed.set(m.id!, withLiveState(mapped, feedCopy))
    }
    if (tail.length === 0 && refreshed.size === 0) return prev
    // Same id, so React reconciles the one bubble instead of remounting the
    // feed. Identity-checked: only the exact copy the diff compared against is
    // replaced, never some other entry that happens to share the id.
    const base =
      refreshed.size === 0
        ? prev
        : prev.map((m) => {
            const next = refreshed.get(m.id)
            return next && held.get(m.id) === m ? next : m
          })
    if (tail.length === 0) return base
    return keepLatestBrowserCard([...base, ...mapConversationMessages({ ...conv, messages: tail })])
  }
  // Transition fallback (an id-less message on either side): count what the
  // feed holds the way the WRITER counts it, or the slice below takes the
  // wrong messages. Safe here because id-less files also merge positionally —
  // disk stays append-only relative to this feed.
  const have = persistedPrev.length
  if (conv.messages.length <= have) return prev
  return [...prev, ...mapConversationMessages({ ...conv, messages: conv.messages.slice(have) })]
}
