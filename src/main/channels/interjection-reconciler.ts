import {
  loadConversation,
  type ConversationChannel,
  type ConversationFile
} from '@main/conversations'
import {
  holdInterjection,
  parkedConversationIds,
  parkedInterjections,
  releaseInterjection,
  type ParkedInterjection
} from '@main/channels/interjection-store'

/**
 * The part that decides where a parked mid-turn message ends up.
 *
 * interjection-store.ts guarantees the message still EXISTS after a crash, a
 * dropped tunnel or a turn that ended without reading it. This decides what to
 * do about that, and it is written as a reconciliation loop rather than a
 * hand-off chain on purpose: every earlier shape of this was "surface A tells
 * surface B, which re-sends" — one missed push and the words were gone. A loop
 * that keeps asking *does this message have a home yet?* cannot be broken by a
 * missed event, only delayed by one.
 *
 * A message HAS A HOME when the conversation on disk holds it:
 *  - as a real `messages[]` entry (it was re-dispatched as a normal turn), or
 *  - as a `user_message` segment inside an assistant message (the agent read
 *    it mid-turn and the transcript recorded it where it was read).
 * Those are the only two resting places in the whole system, which is what
 * makes the check total rather than a list of cases that rots.
 *
 * Anything else — read but never written, accepted but never read, swept while
 * nobody was listening — is re-dispatched as a fresh turn through the channel
 * that sent it. Two things are HELD instead of re-sent, and both are handed
 * back to the next surface that opens the conversation rather than auto-sent:
 * a message whose run the user STOPPED (re-sending would restart work they
 * aborted), and one whose channel has no dispatcher at all — because a message
 * nothing can re-send is a message nobody would ever see again.
 *
 * Run it whenever the answer could have changed — app start, a conversation
 * save, the end of a lane — and as often as you like: it is idempotent, reads
 * one small file plus one transcript, and does nothing in the overwhelmingly
 * common case where the park is empty.
 */

/**
 * Re-send one parked message as a normal turn. Registered by each channel that
 * can originate an interjection, so this module needs to know nothing about
 * phones, terminals or chat apps. Returns false when it could not dispatch
 * (no tunnel, channel stopped) — the message stays parked and is retried on
 * the next pass.
 */
export type InterjectionDispatcher = (item: ParkedInterjection) => Promise<boolean>

const dispatchers = new Map<ConversationChannel, InterjectionDispatcher>()

/** Wire a channel's re-dispatch. Returns the unregister. */
export function registerInterjectionDispatcher(
  channel: ConversationChannel,
  dispatch: InterjectionDispatcher
): () => void {
  dispatchers.set(channel, dispatch)
  return () => {
    if (dispatchers.get(channel) === dispatch) dispatchers.delete(channel)
  }
}

export type ReconcilerDeps = {
  /** True while any turn for this conversation is queued or running. */
  isConversationActive: (conversationId: string) => boolean
  /** Message ids still sitting in the live inbox — those are not ours to touch. */
  liveInboxIds: (conversationId: string) => Set<string>
  log?: (line: string) => void
}

/**
 * How long a delivered message may go unproven before we assume its segment
 * never reached the transcript and re-dispatch it.
 *
 * It has to outlast the slowest legitimate write of that segment: an in-app
 * turn's transcript is saved by the RENDERER moments after agent.respond
 * returns, and the reconciler is woken by that very save. 30s is far past
 * every observed fold and far short of the user noticing a message is missing.
 */
const PROOF_GRACE_MS = 30_000

/** Every message id the transcript already holds, in either resting place. */
export function homedInterjectionIds(conversation: ConversationFile): Set<string> {
  const ids = new Set<string>()
  for (const message of conversation.messages ?? []) {
    if (message.id) ids.add(message.id)
    if (message.role !== 'assistant') continue
    for (const segment of message.segments ?? []) {
      if (segment && typeof segment === 'object' && segment.kind === 'user_message') {
        ids.add(segment.messageId)
      }
    }
  }
  return ids
}

/**
 * Conversations with a pass in flight. This runs from three places at once —
 * the lane's own sweep, the save that sweep causes, and the startup scan — and
 * two passes racing would read the same un-homed message and dispatch it
 * twice: two turns against one transcript, the second aborting the first.
 * One pass per conversation at a time; a caller that arrives mid-pass is
 * dropped rather than queued, because the pass already in flight will see
 * everything it would have.
 */
const inFlight = new Set<string>()

/**
 * Shortest gap between re-send attempts for one conversation. A dispatcher
 * that keeps refusing (a channel that is down) must not be retried on every
 * transcript save for as long as the app runs — this turns a hot loop into a
 * poll, and the message stays parked either way.
 */
let retryIntervalMs = 15_000
const lastAttemptAt = new Map<string, number>()

/** Override the retry gap (tests use a short value) — mirrors TurnRunner.setTitleTimeout. */
export function setInterjectionRetryInterval(ms: number): void {
  retryIntervalMs = ms
}

/**
 * One pass over one conversation's park. Safe to call concurrently with a
 * running turn: anything still in the live inbox, and every message in an
 * active conversation whose grace has not expired, is left alone.
 */
export async function reconcileConversation(
  conversationId: string,
  deps: ReconcilerDeps
): Promise<void> {
  if (inFlight.has(conversationId)) return
  inFlight.add(conversationId)
  try {
    await reconcileOnce(conversationId, deps)
  } finally {
    inFlight.delete(conversationId)
  }
}

async function reconcileOnce(conversationId: string, deps: ReconcilerDeps): Promise<void> {
  const parked = await parkedInterjections(conversationId)
  if (parked.length === 0) {
    lastAttemptAt.delete(conversationId)
    return
  }

  const live = deps.liveInboxIds(conversationId)
  const active = deps.isConversationActive(conversationId)
  const pending = parked.filter((item) => !live.has(item.messageId))
  if (pending.length === 0) return

  const conversation = await loadConversation(conversationId)
  // No file YET is not the same as no file EVER, and this module may not guess
  // between them: a brand-new in-app chat is parked against a conversation id
  // whose titler shell has not landed, and an unreadable file is a transient
  // I/O failure. Both would look exactly like a deletion here, and releasing on
  // either would be this module destroying the thing it exists to protect.
  // Real deletions are handled where they are actually known — the
  // `conversation.deleted` corpus event calls forgetConversationPark.
  if (!conversation) return
  const homed = homedInterjectionIds(conversation)
  const now = Date.now()

  for (const item of pending) {
    if (homed.has(item.messageId)) {
      await releaseInterjection(conversationId, item.messageId)
      continue
    }
    // Held: waiting for a person now, not for the machine.
    // pendingInterjections() hands it back to the next surface that opens this
    // conversation, and only that surface's give-back releases it.
    if (item.disposition === 'held') continue
    // A turn is still running and could yet read (or write) it.
    if (active) continue
    // A message the lane SWEPT is known to be unread — the turn is over and
    // nothing will ever write it — so it goes straight back out as a turn. The
    // grace below would only make the user wait for an answer they are already
    // waiting for.
    const sweptUnread = item.reason === 'turn_ended' || item.reason === 'error'
    // Everything else may simply not have been SAVED yet: the writer that puts
    // a delivered message's segment on disk (a channel sink's fold, or the
    // renderer's) runs after the turn, and the mark that would have said
    // "delivered" is itself an async write that can land after this pass.
    // Judge by the clock, not by a flag that can be behind.
    if (!sweptUnread && now - (item.deliveredAt ?? item.parkedAt) < PROOF_GRACE_MS) continue

    const since = now - (lastAttemptAt.get(conversationId) ?? 0)
    if (since < retryIntervalMs) continue

    const dispatch = dispatchers.get(item.channel)
    if (!dispatch) {
      // Nothing in this process can put the message back on the wire: the
      // in-app composer and the terminal register no dispatcher (their own
      // windows re-send while they are open, which is the case that does not
      // reach here), and the phone's is unregistered while its channel is
      // stopped. Leaving it `live` would park it on a re-send that never
      // comes — preserved, and never seen again, which is the half of "never
      // dropped" that is not worth much on its own.
      //
      // So hand it to a person instead: HELD is surfaced by the cold-start
      // listing, and the next surface to open this conversation puts the words
      // back in its composer. Done immediately rather than after a grace: the
      // worst case is a channel that registers a moment later, and then the
      // message comes back as a draft instead of being auto-sent — a visible,
      // one-keypress outcome, and a far better failure than silence.
      deps.log?.(
        `mid-turn message ${item.messageId} (${item.channel}) has no home and no dispatcher — holding it for the next surface`
      )
      await holdInterjection(conversationId, item.messageId)
      continue
    }
    deps.log?.(
      `mid-turn message ${item.messageId} never reached the transcript (${item.state}, ${item.channel}) — re-sending as a turn`
    )
    lastAttemptAt.set(conversationId, Date.now())
    let sent = false
    try {
      sent = await dispatch(item)
    } catch (error) {
      sent = false
      deps.log?.(
        `re-sending mid-turn message ${item.messageId} failed — ${error instanceof Error ? error.message : String(error)}`
      )
    }
    // Released only on a dispatch that owns the message from here (it persists
    // it as a real user message before it runs). A refusal keeps it parked for
    // the next pass — which is the whole point of a loop.
    if (sent) {
      await releaseInterjection(conversationId, item.messageId)
      lastAttemptAt.delete(conversationId)
      // One re-dispatch per pass per conversation: the turn it just started is
      // the lane, and the rest are read by it as interjections or picked up by
      // the pass its own fold triggers.
      return
    }
  }
}

/** Every parked conversation — app start, and any time a broad sweep is wanted. */
export async function reconcileAll(deps: ReconcilerDeps): Promise<void> {
  for (const conversationId of await parkedConversationIds()) {
    await reconcileConversation(conversationId, deps).catch(() => undefined)
  }
}
