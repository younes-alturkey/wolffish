import type { LiveStream } from '@/state/chatRuntime'
import type { ConversationMessage } from '@/lib/conversations/types'
import { deliveredInterjectionIds } from '@/lib/conversations/segments'

/**
 * The chat feed's row list: the stored transcript with the in-flight turn laid
 * over it.
 *
 * The whole point of this function is that it is a PURE MERGE with no notion of
 * time. Every earlier attempt at "show the live turn, then swap in the saved
 * copy" was a sequencing problem — clear the overlay too early and the row is
 * in neither place (a blank); too late and it is in both (a duplicate). Neither
 * ordering can be guaranteed, because the two halves arrive independently: the
 * desktop pushes turn.status the moment a turn ends but persists the message
 * before that, and the body fetch that follows may or may not have caught it.
 *
 * So nothing is sequenced. Both halves are addressed by MESSAGE ID — the phone
 * mints the prompt's id and sends it with the turn, the desktop stamps its
 * assistant message once and mirrors it under that id — and while the overlay
 * is mounted, ITS copy of that message is the one emitted (the stored copy can
 * be a mid-run progress snapshot, saved so an automation survives a quit, and
 * is then strictly older than the mirror). The overlay can therefore be
 * dropped whenever, arrive whenever, and repeat: the feed is the same either
 * way, because it is only ever dropped once the stored transcript holds the
 * final copy of the same message.
 *
 * The assistant row's key is fixed rather than derived from the message. A
 * turn's live row starts as a thinking indicator with no id at all and later
 * learns the desktop's; keying on that would remount the row mid-turn and
 * restart the typed words. There is at most one live assistant row, so one
 * constant key is enough to keep it mounted for the whole turn.
 */

export const LIVE_KEY = 'live'

export type FeedItem = {
  key: string
  message: ConversationMessage
  /** True while this row is being written — drives the thinking indicator. */
  streaming: boolean
  /**
   * A user message sent mid-turn that the agent has not read yet. Drawn as a
   * user bubble with a "read at the next step" caption and a withdraw
   * control, AFTER the live assistant row — it is waiting on that row's turn.
   */
  pending?: boolean
}

export type BuildFeedInput = {
  /** The stored transcript, in order. Undefined while it is still being read. */
  messages?: ConversationMessage[]
  /** The in-flight turn for this conversation, if any. */
  live?: LiveStream
  /**
   * The prompt sent from a chat that has no conversation id yet, held by the
   * screen for the round trip that mints one. Ignored once `live` carries it.
   */
  pendingUser?: ConversationMessage | null
  /** True between pressing Send and the desktop accepting the turn. */
  sending?: boolean
  /**
   * Mid-turn messages not yet read by the agent (chatRuntime.pending). Each
   * is emitted after the live row under its own id, and dropped the moment
   * that id is found anywhere in the transcript: as a stored message, or as
   * a `user_message` segment inside an assistant message — stored or live.
   * That second match is what makes a missed `delivered` push harmless.
   */
  pending?: ConversationMessage[]
}

export function buildFeed({
  messages,
  live,
  pendingUser,
  sending,
  pending
}: BuildFeedInput): FeedItem[] {
  const items: FeedItem[] = []
  const stored = new Set<string>()
  // While the overlay is up, its copy of the turn's message is the one to draw.
  // The stored transcript can hold the SAME id and still be behind it: an
  // automation persists its answer-so-far while it runs (that is what lets a
  // run survive a quit), so a body fetched mid-turn carries a snapshot that is
  // stale the moment it lands. Rendering that copy froze the feed at whatever
  // the fetch happened to catch, with the live mirror updating an invisible
  // row. The stored copy takes over when settleTurn drops the overlay — which
  // it only does once a post-turn fetch has the final message in hand, so the
  // handover swaps identical content.
  const liveId = live?.message.id
  for (const message of messages ?? []) {
    if (liveId && message.id === liveId) continue
    const key = message.id ?? `${message.role}:${message.timestamp}`
    if (message.id) stored.add(message.id)
    items.push({ key, message, streaming: false })
  }

  // The prompt. `live.user` supersedes the screen's copy — they are the same
  // message under the same id, so preferring one keeps it from rendering twice.
  const user = live?.user ?? pendingUser ?? null
  if (user && !(user.id && stored.has(user.id))) {
    items.push({ key: user.id ?? 'pending-user', message: user, streaming: false })
  }

  if (live) {
    items.push({ key: LIVE_KEY, message: live.message, streaming: live.status === 'streaming' })
  } else if (sending) {
    // Sending, but the desktop has not answered yet: there is no turn to show
    // and no id to file it under, so the thinking row stands in for both. It is
    // the same row the live turn will occupy, under the same key, so the handover
    // is invisible — the typed words never restart.
    items.push({
      key: LIVE_KEY,
      message: { role: 'assistant', content: '', timestamp: Date.now() },
      streaming: true
    })
  }

  // Mid-turn messages, after the row whose turn they are waiting on. Same
  // id discipline as the prompt: a row is dropped by the transcript holding
  // its id, never by a timer or an ordering — so a `delivered` push and the
  // mirror carrying the segment can arrive in either order, or one of them
  // not at all, and the feed reads the same.
  if (pending && pending.length > 0) {
    const delivered = deliveredInterjectionIds(messages ?? [], live?.message)
    for (const message of pending) {
      if (!message.id) continue
      if (stored.has(message.id) || delivered.has(message.id)) continue
      items.push({ key: message.id, message, streaming: false, pending: true })
    }
  }
  return items
}
