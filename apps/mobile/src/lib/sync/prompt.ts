import i18n from '@/lib/i18n'
import { getDb } from '@/lib/db/database'
import {
  conversationHasMessage,
  invalidateConversation,
  invalidateConversationList,
  refetchConversation
} from '@/lib/conversations/cache'
import { mintMessageId } from '@/lib/conversations/types'
import { attachCardStream, seedTurnCards } from '@/lib/sync/cards'
import { fetchConversationBody, setConversationSettleHook } from '@/lib/sync/sync'
import { tunnelClient } from '@/lib/tunnel/client'
import { Event, Rpc } from '@/lib/tunnel/protocol'
import { planModeFor, useChatRuntime, type LiveStream } from '@/state/chatRuntime'
import { markRun, useRunStatus } from '@/state/runStatus'
import type {
  ConversationMessage,
  MessageAttachment,
  Segment,
  ConversationChannel
} from '@/lib/conversations/types'

/**
 * Sending a turn from the phone, and rendering the one the desktop runs.
 *
 * The desktop runs every turn — it holds the models, the capabilities and the
 * workspace. The phone hands over the prompt and renders what comes back, which
 * arrives as events rather than a reply: `message.appended` carrying the
 * assistant message as it grows, `message.delta` for the text between those
 * snapshots, and `turn.status` around the edges. That is the same stream the
 * desktop's own chat view consumes, which is why a turn started here looks
 * identical on both screens.
 *
 * A turn started on the OTHER side arrives the same way, with one addition:
 * `message.appended` also carries the prompt being answered. It has to. The
 * desktop's chat view has that prompt in its own feed and writes it to disk
 * only when the turn folds, so a phone with the conversation open — or one
 * that pairs halfway through, which is how this was found — has it neither
 * stored nor streamed, and renders an answer to a question that is nowhere
 * on screen. Every snapshot repeats it, because a late joiner only ever sees
 * snapshots.
 *
 * ORDER IS THE WHOLE CONTRACT. The phone must show the same things in the same
 * sequence the desktop does — later is fine, out of order or flickering is not
 * — and everything below follows from that:
 *
 *  - The turn appears at the TAP, not at the reply. A round trip to the desktop
 *    (which mints the conversation for a new chat) is dead air otherwise, and
 *    dead air is where the user presses Send again.
 *  - Nothing that arrives mid-turn writes to SQLite, and nothing mid-turn
 *    refetches the body. The desktop persists an assistant message once, when
 *    the turn ends; a fetch before that returns a transcript WITHOUT it and
 *    overwrites what the phone is showing — the vanishing reply.
 *  - Live rows carry the ids the desktop will save them under, so the feed
 *    drops each one exactly when the stored copy takes its place. See
 *    conversations/feed.ts — that merge is what makes every ordering safe.
 *
 * Live state lives in chatRuntime, keyed by conversation, so it survives
 * leaving and re-entering a conversation mid-turn and is readable from tests
 * without a renderer.
 */

export type SendPromptInput = {
  conversationId: string | null
  text: string
  attachments?: MessageAttachment[]
  /** True for a voice note: the audio is the prompt, and the desktop
   * transcribes it before running the turn. */
  voicePrompt?: boolean
  /** The id the caller's optimistic bubble already renders under. Reusing it
   * keeps the prompt row's identity across the handover — the live row and
   * the stored copy replace the bubble instead of remounting or joining it. */
  messageId?: string
}

/**
 * The project a first message files its new conversation under: project mode if
 * the chat is inside one, otherwise the per-chat pick from the menu sheet.
 *
 * Resolved here rather than passed in by each caller so the rule lives in one
 * place — the chat screen, the procedures screen and a voice note all mint
 * conversations through this module, and each deciding for itself is how one of
 * them ends up filing nothing.
 *
 * It travels WITH the send because the desktop stamps it at creation: the turn
 * this send starts reads projectId off the conversation file to build its
 * overlay, so filing afterwards would leave the first turn — the one that
 * matters most — without the project's instructions.
 */
function projectForNewConversation(): string | null {
  const { activeProjectId, pendingProjectId } = useChatRuntime.getState()
  return activeProjectId ?? pendingProjectId ?? null
}

export type SendPromptResult = { conversationId: string }

/** The segment id the tail text renders under — constant so the text block it
 *  produces keeps its identity as the tail grows. */
const TAIL_SEGMENT_ID = 'live_tail'

// ------------------------------------------------------------- live turn

function blankAssistant(): ConversationMessage {
  return { role: 'assistant', content: '', timestamp: Date.now() }
}

/**
 * The assistant message to render: the desktop's newest snapshot with the text
 * that has streamed in since appended to it.
 *
 * Both halves describe the same message — the snapshot is built from the deltas
 * the desktop has already emitted, so a snapshot always contains everything the
 * tail did up to the moment it was taken, and the tail resets when one lands.
 * Frames arrive in order on one socket, so this can never double-print.
 */
function compose(base: ConversationMessage, tail: string): ConversationMessage {
  if (!tail) return base
  const segments: Segment[] = [...(base.segments ?? [])]
  const last = segments[segments.length - 1]
  if (last && last.kind === 'text' && !last.worker) {
    segments[segments.length - 1] = { ...last, delta: last.delta + tail }
  } else {
    segments.push({ kind: 'text', turnId: 'live', segmentId: TAIL_SEGMENT_ID, delta: tail })
  }
  return { ...base, content: (base.content ?? '') + tail, segments }
}

function liveFor(conversationId: string): LiveStream | undefined {
  return useChatRuntime.getState().streams[conversationId]
}

/** Rebuild one conversation's live entry from its parts. */
function putLive(
  conversationId: string,
  next: {
    base?: ConversationMessage
    tail?: string
    user?: ConversationMessage
    status?: LiveStream['status']
    channel?: ConversationChannel | null
  }
): void {
  const current = liveFor(conversationId)
  const base = next.base ?? current?.base ?? blankAssistant()
  const tail = next.tail ?? ''
  const user = next.user ?? current?.user
  useChatRuntime.getState().putStream(conversationId, {
    base,
    tail,
    user,
    status: next.status ?? current?.status ?? 'streaming',
    channel: next.channel ?? current?.channel ?? null,
    message: compose(base, tail)
  })
}

/** Whether a turn is being written into this conversation right now. */
export function isTurnRunning(conversationId: string): boolean {
  return liveFor(conversationId)?.status === 'streaming'
}

/**
 * A prompt mirrored from the desktop — the question a turn running THERE is
 * answering — or null if the payload is not one.
 *
 * This is the other half of the mirror, and the half without which a turn
 * started anywhere but this phone renders as an answer to nothing: the desktop
 * writes an in-app turn's user message to disk only when the turn folds, and
 * the phone deliberately does not re-read a body mid-turn, so for the length of
 * the run the prompt exists in neither place. It arrives on every snapshot, so
 * a phone that pairs or opens the conversation mid-turn picks it up on the next
 * tick rather than never.
 *
 * The wire is data, not policy. An id is mandatory: the feed drops this row
 * when the stored transcript arrives carrying the same id, and one without an
 * id could never be dropped — it would sit under the answer permanently, which
 * is a worse bug than the one being fixed.
 */
function mirroredPrompt(value: unknown): ConversationMessage | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<ConversationMessage>
  if (raw.role !== 'user') return null
  if (typeof raw.id !== 'string' || !raw.id) return null
  if (typeof raw.content !== 'string') return null
  return {
    ...raw,
    id: raw.id,
    role: 'user',
    content: raw.content,
    timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : Date.now()
  }
}

/**
 * A full assistant mirror off the wire — the desktop's snapshot of the turn
 * it is writing — or null if the payload is not one. The id is mandatory for
 * the same reason the prompt's is: it is what lets the stored copy replace
 * this snapshot instead of joining it. One definition, shared by the push
 * handler and the turn-so-far recovery, so "what counts as a mirror" cannot
 * drift between the live path and the late-join path.
 */
function mirroredAssistant(value: unknown): ConversationMessage | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<ConversationMessage>
  if (raw.role !== 'assistant') return null
  if (typeof raw.id !== 'string' || !raw.id) return null
  return raw as ConversationMessage
}

/**
 * Open a live turn before anything has come back from the desktop, so the
 * prompt and the thinking words are on screen from the tap. Called by the send
 * path, by `turn.status: started` for turns begun on another surface — an open
 * conversation shows a desktop-side run the moment it starts, not at its first
 * token — and by the mirror, which is the only one of the three that can carry
 * the prompt of a turn this phone did not send.
 */
export function beginTurn(
  conversationId: string,
  user?: ConversationMessage,
  channel?: ConversationChannel | null
): void {
  const current = liveFor(conversationId)
  // A turn already streaming keeps its accumulated output: `started` can land
  // after the first snapshot, and re-basing on a blank would erase it.
  if (current?.status === 'streaming') {
    if (user) putLive(conversationId, { base: current.base, tail: current.tail, user, channel })
    return
  }
  // A fresh turn: whatever cards the previous one parked on are settled facts
  // now — the desktop resolves or fails every parked request before its turn
  // can end, and the stored transcript renders the outcome. Cleared here as
  // well as at the settle, because a queued prompt flushes the moment the old
  // turn reports done — BEFORE its settle fetch returns — and a card left in
  // the store would ride the new live row's tail, below the new prompt.
  useChatRuntime.getState().clearCards(conversationId)
  // The previous turn's unfinished settle business dies with it: a retry
  // firing into the new turn would fetch a mid-turn body, which is exactly
  // what the live-turn contract forbids.
  clearSettleRetry(conversationId)
  putLive(conversationId, { base: blankAssistant(), tail: '', user, status: 'streaming', channel })
}

/**
 * The turns already in flight when this phone connected — the desktop's
 * chat:activeRuns, asked for once per connection.
 *
 * Turn lifecycle reaches the phone as pushes and nothing else, so a tunnel that
 * comes up mid-run has missed the only `started` that turn will ever send. Until
 * the desktop next mirrors it — which across a long tool call is minutes away —
 * the conversation renders as idle: a live composer and no stop, over a turn
 * still being written. An overlay per running conversation makes all of those
 * read correctly from the first frame, because every one of them derives
 * "running" from the live streams (see conversations/rows.ts).
 *
 * ORDER: called from the same connected edge that runs attachTurnStream, and
 * AFTER it. That function force-settles every turn this phone believed was
 * running, on the assumption it may have missed the end of one while away;
 * seeding first would hand it the very overlays this closes the window for.
 *
 * This RE-OPENS turns, which is not the same act as beginning one, and the
 * difference is why it does not call beginTurn:
 *
 *  - an existing overlay keeps everything it had — its base, its streamed
 *    tail, its prompt — because this turn is the one that was already being
 *    written, not a new one on top of it;
 *  - and its PARKED CARDS survive. beginTurn clears them (a fresh turn settles
 *    the last one's questions), and a phone reconnecting to a turn parked on an
 *    approval is the opposite case: that card is exactly what the user came
 *    back to answer, and it is not re-pushed.
 *
 * Never throws — a desktop too old to answer leaves the phone exactly where it
 * was, learning about the run when the desktop next mirrors it.
 */
export async function seedActiveRuns(): Promise<void> {
  const tunnel = tunnelClient.active
  if (!tunnel || !tunnelClient.connected) return
  // Anything the push stream reports as FINISHED from here on is newer than
  // this answer, which is a snapshot taken before the round trip. Without the
  // stamp, a run ending inside that window gets re-opened by its own stale
  // seed and thinks forever — the failure seedOverlays guards with `revision`.
  const issuedAt = Date.now()
  try {
    const seed = (await tunnel.rpc(Rpc.activeRuns)) as { conversationIds?: unknown } | null
    const ids = seed?.conversationIds
    if (!Array.isArray(ids)) return
    for (const id of ids) {
      if (typeof id !== 'string' || !id) continue
      const current = liveFor(id)
      // Ended while the answer was in flight — by a terminal push that found a
      // live overlay to mark, or one that found none and only left its mark on
      // the run store. Either way the turn is over and the seed is stale.
      if (current && current.status !== 'streaming' && current.ended === 'desktop') continue
      const ended = useRunStatus.getState().runs[id]
      if (ended && ended.at >= issuedAt) continue
      if (current) {
        // Take back the assumption that it ended; keep everything else — the
        // base, the streamed tail, the prompt, and the cards.
        const { ended: _assumed, ...rest } = current
        useChatRuntime.getState().putStream(id, { ...rest, status: 'streaming' })
      } else {
        // Nothing here: a thinking row, exactly as `turn.status: started`
        // would have opened one had this phone been connected to hear it.
        putLive(id, { base: blankAssistant(), tail: '', status: 'streaming' })
      }
      // A row with no snapshot behind it is a PLACEHOLDER — bare thinking
      // words over however much of the turn already happened. That is all a
      // phone ever had here, and it is exactly wrong for the one that
      // relaunched mid-turn (iOS reclaiming a backgrounded app): its user is
      // looking at a conversation that had prose, cards and maybe an open
      // question a moment ago, and the next mirror tick that would redraw
      // them can be minutes away across a long tool call. Ask the desktop
      // for the turn-so-far instead of waiting for it.
      if (!liveFor(id)?.base?.id) await recoverTurnSoFar(id, issuedAt)
      // The mid-turn messages parked on this run, which this phone may have
      // missed the pushes for — or sent itself before a relaunch.
      await seedPendingInterjections(id)
    }
    // A conversation with pending rows but no run cannot have any: the turn
    // ended while this phone was away and the withdraw pushes went with it.
    // Only judged against a real answer — an older desktop threw above.
    //
    // The rows go, but OUR words do not go with them. Missing the pushes is
    // exactly missing the answer to "was it read?", so this is the one sweep
    // that cannot know — and between dropping a message the user wrote and
    // handing it back to the composer it was written in, only one of those is
    // recoverable. A row another surface sent is merely un-drawn, as its
    // `withdrawn` push would have done.
    const running = new Set(ids.filter((id): id is string => typeof id === 'string'))
    const runtime = useChatRuntime.getState()
    for (const [key, rows] of Object.entries(runtime.pending)) {
      if (key.startsWith('\u0000')) continue // the id-less screen key is not a conversation
      if (running.has(key)) continue
      for (const row of rows) {
        if (!row.id || !sentInterjections.delete(row.id)) continue
        if (row.content && !row.voicePrompt) runtime.restoreDraft(key, row.content)
      }
      runtime.clearPending(key)
    }
  } catch {
    // Silent, and deliberately not reportRpcFailure: a desktop that predates
    // this method is not a sick tunnel, and nothing the user asked for failed.
  }
}

/**
 * Replace one running conversation's pending list with the desktop's
 * (Rpc.pendingInterjections). Never throws — an older desktop answers with
 * an unknown-method error and the phone keeps whatever rows it has.
 */
async function seedPendingInterjections(conversationId: string): Promise<void> {
  const tunnel = tunnelClient.active
  if (!tunnel || !tunnelClient.connected) return
  let answer: unknown
  try {
    answer = await tunnel.rpc(Rpc.pendingInterjections, { conversationId })
  } catch {
    return
  }
  const raw = (answer as { pending?: unknown } | null)?.pending
  if (!Array.isArray(raw)) return
  // HELD rows (`held: true`) are not waiting on anything: their run was
  // stopped before the agent read them, and the desktop parks them on disk
  // rather than resending work the user aborted. Drawing them as pending would
  // promise a delivery that is never coming, so their words go straight back
  // to the composer they were written in — and the withdraw is this phone
  // saying it has them, without which the park would hand them over again on
  // every reconnect.
  const heldRows = raw.filter((row) => (row as { held?: unknown } | null)?.held === true)
  const runtimeForHeld = useChatRuntime.getState()
  for (const held of heldRows) {
    const row = interjectionRow(held)
    if (!row?.id) continue
    // Claim before restoring. restoreDraft APPENDS and the withdraw that
    // releases the park is a round trip, so two overlapping seeds — a
    // reconnect racing a screen re-entry — would each restore the same words.
    if (!restoredHeld.has(row.id)) {
      restoredHeld.add(row.id)
      sentInterjections.delete(row.id)
      if (row.content && !row.voicePrompt) runtimeForHeld.restoreDraft(conversationId, row.content)
    }
    // Retried on every seed until it lands, which is why it sits OUTSIDE the
    // claim above. A tunnel that dropped between the answer and here sends
    // nothing at all — there is no call to fail, only an absent one — and a
    // park that is never released comes back on the next connect, where the
    // claim would skip the restore and the words would go nowhere at all.
    void tunnelClient.active
      ?.rpc(Rpc.withdrawInterjection, { conversationId, messageId: row.id })
      .catch(() => undefined)
  }
  const rows = raw
    .filter((row) => (row as { held?: unknown } | null)?.held !== true)
    .map(interjectionRow)
    .filter((row): row is ConversationMessage => row !== null)
  // Re-adopt the ones this phone sent. Ownership lives in `sentInterjections`,
  // which is module state and therefore gone after a relaunch — and without
  // it a `withdrawn` push for our own message reads as another surface's and
  // is merely un-drawn, losing words the user wrote. `channel` is what the
  // desktop files each row under, and the phone is the only `mobile` sender
  // on a pairing, so it survives the process where the set does not.
  for (const row of raw) {
    if ((row as { held?: unknown } | null)?.held === true) continue
    const sender = (row as { channel?: unknown; messageId?: unknown } | null)?.channel
    const id = (row as { messageId?: unknown } | null)?.messageId
    if (sender === 'mobile' && typeof id === 'string' && id) sentInterjections.add(id)
  }
  useChatRuntime.getState().setPending(conversationId, rows)
}

/**
 * A pending-row message off the wire — the shape Rpc.pendingInterjections
 * lists and Event.interjection carries — or null if it is not one. The id
 * is mandatory for the same reason the prompt's is: it is what lets the
 * `user_message` segment retire the row.
 */
function interjectionRow(value: unknown): ConversationMessage | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as {
    messageId?: unknown
    text?: unknown
    attachments?: unknown
    voicePrompt?: unknown
    voiceLang?: unknown
    sentAt?: unknown
  }
  if (typeof raw.messageId !== 'string' || !raw.messageId) return null
  const attachments = Array.isArray(raw.attachments)
    ? (raw.attachments as MessageAttachment[]).filter(
        (a) => a && typeof a === 'object' && typeof a.filePath === 'string'
      )
    : []
  return {
    id: raw.messageId,
    role: 'user',
    content: typeof raw.text === 'string' ? raw.text : '',
    timestamp: typeof raw.sentAt === 'number' ? raw.sentAt : Date.now(),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(raw.voicePrompt === true ? { voicePrompt: true } : {}),
    ...(typeof raw.voiceLang === 'string' && raw.voiceLang ? { voiceLang: raw.voiceLang } : {})
  }
}

/**
 * Pull one running conversation's turn-so-far (Rpc.turnMirror) and lay it
 * over the placeholder row seedActiveRuns just opened: the newest mirror
 * snapshot as the live base, the prompt it answers, and the ask/approval
 * cards the turn is still parked on — which for a relaunched phone are
 * otherwise LOST, with the desktop parked on a promise nothing can answer.
 *
 * Everything about it is defensive, because it races the live push stream it
 * is catching up to:
 *  - applied only while the row is still streaming AND still base-less — a
 *    mirror push that lands during the round trip is newer than the answer
 *    and wins by simply having set the base first;
 *  - re-checked against the run store, so a turn that ended mid-flight is
 *    not re-drawn as running;
 *  - never throws, and an older desktop (no such method) leaves the phone
 *    exactly where it was: the placeholder row, as before this existed.
 */
async function recoverTurnSoFar(conversationId: string, issuedAt: number): Promise<void> {
  const tunnel = tunnelClient.active
  if (!tunnel || !tunnelClient.connected) return
  let answer: unknown
  try {
    answer = await tunnel.rpc(Rpc.turnMirror, { conversationId })
  } catch {
    return
  }
  if (!answer || typeof answer !== 'object') return
  const snapshot = answer as {
    message?: unknown
    userMessage?: unknown
    asks?: unknown
    approvals?: unknown
  }
  const ended = useRunStatus.getState().runs[conversationId]
  if (ended && ended.at >= issuedAt) return
  const live = liveFor(conversationId)
  if (!live || live.status !== 'streaming') return
  if (live.base?.id) return
  seedTurnCards(conversationId, snapshot.asks, snapshot.approvals)
  const message = mirroredAssistant(snapshot.message)
  const prompt = mirroredPrompt(snapshot.userMessage ?? null)
  if (!message && !prompt) return
  putLive(conversationId, {
    // A snapshot contains every delta up to the moment it was cached, so the
    // tail resets with it — at worst the last throttle-window of text repaints
    // one tick later. No snapshot ⇒ whatever streamed since reconnect stays.
    ...(message ? { base: message, tail: '' } : { tail: live.tail ?? '' }),
    ...(prompt ? { user: prompt } : {}),
    status: 'streaming'
  })
}

// ------------------------------------------------------------- settling

/**
 * A finished turn, brought to rest.
 *
 * The desktop announces the end and saves the message in that order across two
 * independent paths (the turn runner's lifecycle push and the channel sink's
 * own), so the first body fetch after `done` may still predate the save. That
 * is not worth racing: the fetch is simply repeated when the second signal
 * lands, and the live row stays up throughout because the feed drops it on id,
 * not on a timer. What this guarantees is only that a fetch HAPPENS — the
 * ordering is the merge's problem, and it has no ordering.
 *
 * One settle at a time per conversation, with a trailing rerun, so the two
 * signals cost one fetch when they arrive together and two when they do not.
 */
const settling = new Map<string, { again: boolean; run: Promise<void> }>()

/**
 * The settle's own safety net, for the tail nobody pushes about.
 *
 * The fetch after `done` can predate the desktop's disk write, and the signal
 * that follows the save — the post-save nudge, the metadata push — rides a
 * tunnel that may blink at exactly that moment. Before this existed, a settle
 * whose fetch came back pre-save simply STOPPED: the live overlay stayed up
 * forever (its message never matched the stored copy) and the stored
 * transcript stayed one turn short until something else happened to re-open
 * the conversation. A few bounded retries close that tail: the first lands
 * roughly when the renderer's save does, and a turn still unmatched after the
 * last is back to waiting for a real signal, exactly as before.
 */
const SETTLE_RETRY_DELAYS_MS = [1_500, 3_000, 6_000]
const settleRetries = new Map<
  string,
  { attempt: number; timer: ReturnType<typeof setTimeout> | null }
>()

function clearSettleRetry(conversationId: string): void {
  const pending = settleRetries.get(conversationId)
  if (pending?.timer) clearTimeout(pending.timer)
  settleRetries.delete(conversationId)
}

function scheduleSettleRetry(conversationId: string): void {
  const attempt = settleRetries.get(conversationId)?.attempt ?? 0
  if (attempt >= SETTLE_RETRY_DELAYS_MS.length) return
  // A phone with no tunnel has nothing to retry against; the reconnect
  // re-settles every open turn anyway (see attachTurnStream).
  if (!tunnelClient.connected) return
  clearSettleRetry(conversationId)
  const timer = setTimeout(() => {
    settleRetries.set(conversationId, { attempt: attempt + 1, timer: null })
    // A NEW turn owns the conversation now — a fetch would be the forbidden
    // mid-turn body read, and beginTurn cleared this turn's debt anyway.
    if (liveFor(conversationId)?.status === 'streaming') return
    if (!tunnelClient.connected) return
    if (liveFor(conversationId)) {
      // Overlay still up: the settle owns the fetch, the id match and the
      // scheduling of the next attempt.
      void settleTurn(conversationId)
      return
    }
    // Overlay already RELEASED — the id-less case, dropped on faith before
    // the save it knows is coming. settleTurn would return before its own
    // re-schedule (nothing left to match), so this chain fetches and keeps
    // itself alive until the net runs out: with no id there is no
    // convergence signal to stop on, and three small body fetches are the
    // price of the streamed reply reaching the screen without one.
    void fetchConversationBody(conversationId)
      .catch(() => false)
      .then(() => refetchConversation(conversationId))
      .then(() => scheduleSettleRetry(conversationId))
  }, SETTLE_RETRY_DELAYS_MS[attempt])
  settleRetries.set(conversationId, { attempt, timer })
}

function settleTurn(conversationId: string): Promise<void> {
  // The settle judges the live row against the stored body — apply whatever
  // the batching window still holds before judging (hoisted; defined below).
  flushStream(conversationId)
  const active = settling.get(conversationId)
  if (active) {
    active.again = true
    return active.run
  }
  // Whatever retry was queued, this settle IS it now — a real signal and a
  // timer must not race two fetches. The attempt count survives the clear so
  // the net stays bounded per turn end.
  const pendingRetry = settleRetries.get(conversationId)
  if (pendingRetry?.timer) {
    clearTimeout(pendingRetry.timer)
    pendingRetry.timer = null
  }
  const entry = { again: false, run: Promise.resolve() }
  entry.run = (async () => {
    try {
      do {
        entry.again = false
        await fetchConversationBody(conversationId).catch(() => false)
        // Awaited, not invalidated: the query must hold the stored transcript
        // before the overlay is considered for release, or the row would be in
        // neither place for a frame.
        await refetchConversation(conversationId)
      } while (entry.again)
    } finally {
      settling.delete(conversationId)
    }
    const live = liveFor(conversationId)
    if (!live || live.status === 'streaming') return
    // Released only against its replacement. A turn whose message is now in the
    // stored transcript is already being drawn from there, so dropping the
    // overlay changes nothing on screen — that is the point. A turn whose
    // message is NOT there yet keeps it: `done` and the desktop's disk write
    // are announced by two independent paths, and the fetch that follows the
    // first can easily predate the second. Whatever streamed stays up, and the
    // signal that follows the save settles it.
    //
    // Nothing to match — a turn aborted before it wrote a word, or an older
    // desktop that streams text without ever naming the message — comes down
    // here instead, since no arriving copy ever will.
    const id = live.message.id
    if (!id || conversationHasMessage(conversationId, id)) {
      useChatRuntime.getState().endStream(conversationId)
      // The parked cards go with the turn they belonged to, and not a moment
      // earlier: from here the stored transcript draws the outcome — an
      // approval from the record persisted on the assistant message, an
      // answered question from its tool_call args and tool_result output — so
      // dropping them changes nothing on screen. A card still up when the turn
      // ended unanswered was failed closed on the desktop; the transcript is
      // where the truth about that lives.
      useChatRuntime.getState().clearCards(conversationId)
      // An id-less turn that STREAMED something is the one release made on
      // faith: nothing can match the save (every desktop mirror carries the
      // id, but an oversize mirror degrades to a bare nudge and leaves the
      // overlay id-less), so the overlay just dropped against a body that
      // may predate the save — the streamed reply vanishes from screen.
      // `done` on a turn that produced text means that save is landing;
      // keep refetching on the same bounded net until it does.
      if (!id && (live.message.content ?? '').length > 0) {
        scheduleSettleRetry(conversationId)
      } else {
        clearSettleRetry(conversationId)
      }
      return
    }
    scheduleSettleRetry(conversationId)
  })()
  settling.set(conversationId, entry)
  return entry.run
}

// The upsert push and reconcile's catch-up route a just-ended turn's body
// refresh through the settle, so the overlay releases against the copy they
// fetched. Registered at module scope: sync.ts cannot import this module
// (prompt already imports sync — that pair would be a require cycle). The
// typeof guard is for the tests that stub sync.ts down to the one function
// they drive — a missing setter must cost the hook, not the module.
if (typeof setConversationSettleHook === 'function') {
  setConversationSettleHook((conversationId) => void settleTurn(conversationId))
}

// ------------------------------------------------- inbound stream batching

/**
 * How long inbound stream events may pool before they paint. Three frames —
 * imperceptible against a live model, decisive against a backlog: a phone
 * catching up on a queue the relay held (a slow link during a long turn, a
 * return from background) receives hundreds of deltas and mirrors in a burst,
 * and painting each one re-rendered the live row per event — the reply
 * "streaming" a word at a time for minutes after the desktop had finished.
 * Pooled, a burst collapses to at most ~20 store writes a second, each
 * carrying everything that arrived since the last: the backlog fast-forwards
 * instead of replaying.
 */
const STREAM_FLUSH_MS = 48

type PendingStream = {
  /** Newest full mirror received this window — supersedes any before it. */
  mirror?: ConversationMessage
  /** The prompt off the newest event that carried one. */
  prompt?: ConversationMessage
  /** Delta text received after `mirror` (or since the last flush). */
  tail: string
  timer: ReturnType<typeof setTimeout> | null
}

const pendingStreams = new Map<string, PendingStream>()

/** The conversation's open pooling window, its flush armed. */
function pendingFor(conversationId: string): PendingStream {
  let entry = pendingStreams.get(conversationId)
  if (!entry) {
    entry = { tail: '', timer: null }
    pendingStreams.set(conversationId, entry)
  }
  if (!entry.timer) {
    entry.timer = setTimeout(() => flushStream(conversationId), STREAM_FLUSH_MS)
  }
  return entry
}

/**
 * Apply everything a conversation's window pooled, as ONE store write. The
 * fold is the same one the live row itself performs: a mirror supersedes the
 * deltas before it (they are already inside it), deltas after it extend its
 * tail. Order against everything that READS live state is preserved by the
 * handlers below flushing before they read — a nudge, a turn boundary, a
 * settle must see the events that arrived ahead of them applied, not pooled.
 */
function flushStream(conversationId: string): void {
  const entry = pendingStreams.get(conversationId)
  if (!entry) return
  pendingStreams.delete(conversationId)
  if (entry.timer) clearTimeout(entry.timer)
  if (entry.prompt && liveFor(conversationId)?.user?.id !== entry.prompt.id) {
    beginTurn(conversationId, entry.prompt)
  }
  if (entry.mirror) {
    putLive(conversationId, { base: entry.mirror, tail: entry.tail, status: 'streaming' })
    return
  }
  if (!entry.tail) return
  const live = liveFor(conversationId)
  putLive(conversationId, {
    base: live?.base,
    tail: (live?.tail ?? '') + entry.tail,
    status: 'streaming'
  })
}

/** Drop every pooled stream event — the socket they rode is gone, and a late
 *  flush would re-open overlays the reconnect is about to re-settle. */
function dropPendingStreams(): void {
  for (const entry of pendingStreams.values()) {
    if (entry.timer) clearTimeout(entry.timer)
  }
  pendingStreams.clear()
}

// --------------------------------------------------------------- events

/**
 * Wire the turn event stream. Called once when the tunnel comes up, alongside
 * `attachLiveUpdates` — kept separate because these events only matter while a
 * conversation is on screen, whereas list updates always matter.
 */
export function attachTurnStream(): void {
  const tunnel = tunnelClient.active
  if (!tunnel) return

  // Whatever the DEAD socket left pooled dies with it: a flush firing after
  // the re-settle below would put a stale mirror back up as a running turn.
  dropPendingStreams()

  // The parked-card topics ride the same stream: they are turn events, and a
  // turn that is waiting on the user is a turn state like any other.
  attachCardStream()

  // Re-attached on every reconnect, which is also the one moment a live turn
  // can be a lie: the phone drops mid-turn, the turn finishes without it, and
  // its terminal event is never delivered. Every turn believed to be running is
  // therefore re-settled here. A turn that really is still going re-announces
  // itself on the next snapshot — self-correcting in the direction that costs
  // nothing, where the alternative is thinking words that never stop.
  for (const [conversationId, live] of Object.entries(useChatRuntime.getState().streams)) {
    if (live.status !== 'streaming') continue
    // Marked as the guess it is. The turn may well still be running on the
    // desktop — seedActiveRuns, a beat later, re-opens the ones that are —
    // and until something says otherwise nothing may read this as a finished
    // turn. See LiveStream.ended.
    useChatRuntime
      .getState()
      .putStream(conversationId, { ...live, status: 'complete', ended: 'assumed' })
    void settleTurn(conversationId)
  }

  tunnel.onEvent(Event.messageDelta, (payload) => {
    const { conversationId, text, replace } = (payload ?? {}) as {
      conversationId?: string
      text?: string
      replace?: boolean
    }
    if (!conversationId || typeof text !== 'string') return
    // Turns this phone started arrive as increments; a mirror of a turn running
    // elsewhere arrives as the message so far. Appending the latter would print
    // the answer again on every tick.
    if (replace === true) {
      flushStream(conversationId)
      const live = liveFor(conversationId)
      putLive(conversationId, { base: live?.base, tail: text, status: 'streaming' })
      return
    }
    pendingFor(conversationId).tail += text
  })

  tunnel.onEvent(Event.messageAppended, (payload) => {
    const { conversationId, message, userMessage } = (payload ?? {}) as {
      conversationId?: string
      message?: unknown
      userMessage?: unknown
    }
    if (!conversationId) return

    const prompt = mirroredPrompt(userMessage)

    // A FULL assistant message (stable id + role) is the desktop's live mirror
    // of the turn it is writing — prose, tool cards and task cards, exactly as
    // they stand right now. It replaces the live row's base, and the deltas
    // that built the text it already contains are dropped with it — pooled
    // rather than painted, so a burst of snapshots is one store write of the
    // newest. The prompt rides the pool and is applied at the flush, before
    // the snapshot, exactly as it used to apply before the putLive here.
    const mirrored = mirroredAssistant(message)
    if (mirrored) {
      const entry = pendingFor(conversationId)
      entry.mirror = mirrored
      entry.tail = ''
      if (prompt) entry.prompt = prompt
      return
    }

    // A nudge reads live state below; the events that arrived ahead of it
    // must be ON the live row by then, not pooled behind it.
    flushStream(conversationId)

    // The prompt, before every early return below — a mirror whose assistant
    // half was withheld for size still carries it, and the turns whose
    // answers outgrow that budget are exactly the long ones where a missing
    // question is most obvious. Applied once per turn rather than per tick:
    // the id is the whole payload's identity, so an unchanged one means
    // there is nothing to do and no reason to wake the feed.
    if (prompt && liveFor(conversationId)?.user?.id !== prompt.id) {
      beginTurn(conversationId, prompt)
    }

    // Anything else is a nudge: some conversation's stored body changed. Mid
    // turn there is nothing to gain from it — the desktop has not saved the
    // assistant message yet — and everything to lose, because the body it would
    // hand back is the one from BEFORE this turn. Fetch when the turn is over,
    // which the nudge that follows the save (or turn.status) will ask for.
    if (isTurnRunning(conversationId)) return
    // A conversation with a turn just ended is settling; the nudge that follows
    // the desktop's save is precisely the second attempt that path waits for,
    // so it joins it rather than racing a fetch of its own.
    if (liveFor(conversationId)) {
      void settleTurn(conversationId)
      return
    }
    void fetchConversationBody(conversationId)
      .then(() => invalidateConversation(conversationId))
      .catch(() => undefined)
  })

  tunnel.onEvent(Event.turnStatus, (payload) => {
    const { conversationId, state, detail } = (payload ?? {}) as {
      conversationId?: string
      state?: string
      /** The desktop sends the originating channel here on `started`. */
      detail?: unknown
    }
    if (!conversationId) return
    // A boundary reads and rewrites live state: the stream events that
    // arrived ahead of it must be applied first, or a pooled mirror would
    // flush AFTER the settle and re-open the turn it just closed.
    flushStream(conversationId)
    // Started anywhere — this app, the desktop, a channel. An open conversation
    // shows the turn from its first instant rather than its first token.
    if (state === 'started') {
      beginTurn(
        conversationId,
        undefined,
        typeof detail === 'string' ? (detail as ConversationChannel) : null
      )
      return
    }
    if (state !== 'done' && state !== 'error' && state !== 'canceled') return
    // How it ended, remembered for as long as that is news — this is what tints
    // the conversation's number chip in the sheet, exactly as the desktop's
    // rail tints its own. Recorded for EVERY conversation the desktop reports
    // on, not just the open one: the whole point of the list is that a turn
    // finishing somewhere the user is not looking still shows up there.
    markRun(
      conversationId,
      state === 'done' ? 'completed' : state === 'error' ? 'failed' : 'stopped'
    )
    const live = liveFor(conversationId)
    if (live) {
      // Marked finished, NOT removed. The composer's Stop goes back to Send
      // here, while the reply stays on screen until its saved copy arrives to
      // take over — the two are separate events and only one of them is now.
      //
      // `ended: 'desktop'` is the desktop SAYING so, as opposed to the
      // reconnect re-settle assuming it. It is what lets end-of-turn chrome
      // treat this turn as finished while it is still the live row, without
      // doing the same for every turn that merely stopped streaming a moment.
      useChatRuntime.getState().putStream(conversationId, {
        ...live,
        status: state === 'error' ? 'error' : 'complete',
        ended: 'desktop'
      })
    }
    invalidateConversationList()
    void settleTurn(conversationId)
  })

  tunnel.onEvent(Event.interjection, (payload) => {
    const ev = (payload ?? {}) as {
      conversationId?: unknown
      state?: unknown
      reason?: unknown
    } & Record<string, unknown>
    const conversationId = typeof ev.conversationId === 'string' ? ev.conversationId : ''
    const row = interjectionRow(ev)
    if (!conversationId || !row) return
    const runtime = useChatRuntime.getState()
    // Whether THIS phone sent it — its id was minted here (interject below).
    // Another surface's message only ever adds or removes a pending row.
    const mine = sentInterjections.has(row.id ?? '')
    switch (ev.state) {
      case 'pending':
        // Replaces the optimistic row under the same id with the desktop's
        // copy: a voice note comes back with its transcript as the text.
        runtime.putPending(conversationId, row)
        return
      case 'delivered':
        // The agent read it. The `user_message` segment in the next mirror
        // draws it inside the assistant card; the pending row comes down.
        runtime.dropPending(conversationId, row.id ?? '')
        sentInterjections.delete(row.id ?? '')
        return
      case 'withdrawn': {
        runtime.dropPending(conversationId, row.id ?? '')
        if (!mine) return
        sentInterjections.delete(row.id ?? '')
        if (ev.reason === 'turn_ended' || ev.reason === 'error') {
          // The turn finished without reading it. It is still a message the
          // user sent, so it goes as the next turn — but the DESKTOP sends it
          // now, not this phone. It emitted this very event, so it cannot miss
          // it; it holds the transcript; and it keeps the message parked on
          // disk until one exists. A phone that was backgrounded, relaunching
          // or off the tunnel at this moment used to lose the words outright,
          // which is the whole reason the hand-back moved over there.
          //
          // Nothing to do here but let the row go: the fresh turn arrives as a
          // normal `message.appended` with the prompt attached, under the same
          // message id, so the feed shows it exactly once.
          return
        }
        // Withdrawn by the user, or the turn was stopped: not sent. The
        // words go back to the composer, where they were.
        if (row.content && !row.voicePrompt) runtime.restoreDraft(conversationId, row.content)
        return
      }
      default:
        return
    }
  })
}

// ------------------------------------------------------------ interject

export type InterjectInput = {
  conversationId: string
  /** Minted by the screen at the tap — the pending bubble's id. */
  messageId: string
  text: string
  /** Already uploaded: real desktop paths, as sendPrompt's are. */
  attachments?: MessageAttachment[]
  voicePrompt?: boolean
}

export type InterjectResult = { status: 'pending' } | { status: 'no_live_turn' }

/**
 * The ids of the mid-turn messages THIS phone sent and the agent has not yet
 * read. What decides whether a `withdrawn` push is ours to act on — restore
 * the draft, or re-send as a turn — or someone else's to merely un-draw.
 */
const sentInterjections = new Set<string>()

/**
 * Held messages (a stopped run's, see seedPendingInterjections) already handed
 * back to a composer by this process. Guards the double-restore: the give-back
 * appends, so restoring one twice duplicates the user's words in the field.
 */
const restoredHeld = new Set<string>()

/**
 * Whether an RPC failed because the desktop predates the method. The
 * desktop's tunnel answers an unregistered method with exactly this text
 * (wolffish-app tunnel.ts); matched on the message rather than the error
 * class so this module stays free of the tunnel's crypto imports.
 */
function isUnknownRpc(error: unknown): boolean {
  return error instanceof Error && /^no handler for /.test(error.message)
}

/**
 * Hand a message to the conversation's RUNNING turn. Deliberately touches
 * none of the turn machinery — no beginTurn, no endStream, no markRun, no
 * cards — because it is not a turn: the turn on screen is the one being
 * steered, and it keeps its overlay, its cards and its prompt throughout.
 *
 * The pending row goes up under the caller's id before the wire is touched
 * (the screen usually put it there already; this is the copy with the
 * uploaded files) and comes down again unless the desktop accepts it.
 * `no_live_turn` — and an older desktop, which has no such method — both
 * mean the same thing to the caller: send it as a normal turn.
 */
export async function interject(input: InterjectInput): Promise<InterjectResult> {
  const tunnel = tunnelClient.active
  const message: ConversationMessage = {
    id: input.messageId,
    role: 'user',
    content: input.text,
    timestamp: Date.now(),
    ...(input.attachments && input.attachments.length > 0
      ? { attachments: input.attachments }
      : {}),
    ...(input.voicePrompt ? { voicePrompt: true } : {})
  }
  const runtime = useChatRuntime.getState()
  runtime.putPending(input.conversationId, message)
  if (!tunnel || !tunnelClient.connected) {
    runtime.dropPending(input.conversationId, input.messageId)
    return { status: 'no_live_turn' }
  }
  sentInterjections.add(input.messageId)
  let result: { status?: unknown }
  try {
    result = (await tunnel.rpc(
      Rpc.interject,
      {
        conversationId: input.conversationId,
        messageId: input.messageId,
        text: input.text,
        attachments: input.attachments ?? [],
        voicePrompt: input.voicePrompt === true
      },
      // A voice note is transcribed before the desktop answers — the same
      // allowance the bulk transfers get, for the same reason: slow is not dead.
      input.voicePrompt ? INTERJECT_VOICE_TIMEOUT_MS : undefined
    )) as { status?: unknown }
  } catch (error) {
    sentInterjections.delete(input.messageId)
    useChatRuntime.getState().dropPending(input.conversationId, input.messageId)
    if (isUnknownRpc(error)) return { status: 'no_live_turn' }
    throw error
  }
  if (result?.status === 'pending') return { status: 'pending' }
  sentInterjections.delete(input.messageId)
  useChatRuntime.getState().dropPending(input.conversationId, input.messageId)
  return { status: 'no_live_turn' }
}

const INTERJECT_VOICE_TIMEOUT_MS = 120_000

/**
 * Take a pending message back. The row comes down at the tap; the desktop's
 * `withdrawn` push (reason `user`) is what puts the words back in the
 * composer. A desktop that says no — the agent read it a beat ago — has
 * already pushed `delivered`, and the segment is on screen.
 *
 * Unless the desktop is never reached at all. Then no push is coming: not a
 * `withdrawn`, not a `delivered`, nothing — and a row taken down on a promise
 * nobody made takes the user's words with it. So the ask is made first and
 * the give-back is OURS whenever it did not land, which is the one case the
 * desktop cannot be the authority on.
 */
export async function withdrawInterjection(
  conversationId: string,
  messageId: string
): Promise<void> {
  const runtime = useChatRuntime.getState()
  const row = (runtime.pending[conversationId] ?? []).find((m) => m.id === messageId)
  runtime.dropPending(conversationId, messageId)
  const tunnel = tunnelClient.active
  const giveBack = (): void => {
    sentInterjections.delete(messageId)
    // A voice note's words are its transcript, which lives on the desktop —
    // there is nothing here to put back in the field.
    if (row?.content && !row.voicePrompt) {
      useChatRuntime.getState().restoreDraft(conversationId, row.content)
    }
  }
  if (!tunnel || !tunnelClient.connected) {
    giveBack()
    return
  }
  const answer = await tunnel
    .rpc(Rpc.withdrawInterjection, { conversationId, messageId })
    .catch(() => null)
  // A transfer that failed is the offline case with extra steps.
  if (answer === null) giveBack()
}

/** Test seam: whether an id is one this phone is waiting on. */
export function isOwnInterjection(messageId: string): boolean {
  return sentInterjections.has(messageId)
}

// ----------------------------------------------------------------- send

/**
 * Hand a prompt to the desktop. Returns the conversation id so the UI can
 * navigate immediately, the same contract `sendDemoPrompt` offers.
 *
 * The prompt's id is minted HERE and travels with it, so the desktop saves the
 * message under the same id this phone is already showing. That one field is
 * what lets the optimistic bubble be replaced rather than joined by the stored
 * copy when the body arrives.
 */
export async function sendPrompt(input: SendPromptInput): Promise<SendPromptResult> {
  const tunnel = tunnelClient.active
  const timestamp = Date.now()
  const user: ConversationMessage = {
    id: input.messageId ?? mintMessageId(timestamp),
    role: 'user',
    content: input.text,
    timestamp,
    ...(input.attachments && input.attachments.length > 0
      ? { attachments: input.attachments }
      : {}),
    ...(input.voicePrompt ? { voicePrompt: true } : {})
  }

  // Read before the wire is touched, so the value the local stub is written
  // with below is the same one the desktop was asked for.
  const projectId = input.conversationId ? null : projectForNewConversation()
  // The conversation's plan stance (the fresh chat's for a first message),
  // read at the send so a toggle flipped while a message sat in the queue
  // still applies to it — the desktop composer reads its own chip the same way.
  const planMode = planModeFor(input.conversationId)

  // Offline. The desktop holds the models and the workspace, so there is no
  // answer to be had here — but throwing turns a normal situation (a phone in
  // a lift) into an error the user has to interpret. Keep what they wrote,
  // say plainly why it is waiting, and let them carry on reading.
  if (!tunnel || !tunnelClient.connected) return offlineReply(input, user, projectId)

  // The turn is on screen before the wire is touched, for a conversation that
  // has one. A new chat has no id to file it under yet; the chat screen holds
  // that single prompt for the length of this round trip and hands it over
  // below — see `pendingUser` in conversations/feed.ts.
  if (input.conversationId) beginTurn(input.conversationId, user)

  let result: { conversationId?: string }
  try {
    result = (await tunnel.rpc(Rpc.sendMessage, {
      conversationId: input.conversationId,
      messageId: user.id,
      text: input.text,
      attachments: input.attachments ?? [],
      voicePrompt: input.voicePrompt === true,
      // Only meaningful for a conversation the desktop is about to create; it
      // ignores the field for one that already exists and has its own binding.
      ...(projectId ? { projectId } : {}),
      // Off is the wire's default; a desktop predating the field ignores it.
      ...(planMode ? { planMode: true } : {})
    })) as { conversationId?: string }
  } catch (error) {
    // The turn never started. Take the optimistic row down with it rather than
    // leaving the thinking words running against a desktop that never heard.
    if (input.conversationId) {
      useChatRuntime.getState().endStream(input.conversationId)
      useChatRuntime.getState().clearCards(input.conversationId)
    }
    throw error
  }

  const conversationId = result?.conversationId ?? input.conversationId
  if (!conversationId) throw new Error('desktop did not return a conversation')

  // A conversation the desktop just minted has no row here yet. Write one now:
  // it gives History the chat immediately and, more importantly, keeps the
  // conversation query off the catch-up path it takes for an unknown id (a full
  // index pull, then a body fetch, before anything can render). The desktop's
  // own metadata overwrites this the moment it arrives.
  if (!input.conversationId) {
    await createLocalConversation(conversationId, input.text, timestamp, projectId)
    // The per-chat pick was for THIS chat and has now been spent. Project mode
    // is not cleared — it holds until the user closes the project.
    if (useChatRuntime.getState().pendingProjectId) {
      useChatRuntime.getState().setPendingProject(null)
    }
    // The plan stance set while this chat had no id follows it under the id
    // it now has, so the second turn keeps the mode the first ran in.
    useChatRuntime.getState().adoptPlanMode(conversationId)
  }
  beginTurn(conversationId, user)
  invalidateConversationList()
  return { conversationId }
}

/**
 * A locally-known stub for a conversation the desktop created. Deliberately
 * INSERT OR IGNORE and message-less: the desktop is the source of truth for
 * both, and its copy arrives through the index push moments later. `channel`
 * matches what the desktop stamped so the phone badge does not appear late, and
 * `project_id` for the same reason — the chat's project chrome and the Projects
 * screen's count both read it, and a beat showing the chat as unfiled is a beat
 * showing the wrong thing.
 */
async function createLocalConversation(
  conversationId: string,
  text: string,
  timestamp: number,
  projectId: string | null = null
): Promise<void> {
  const db = await getDb()
  await db
    .runAsync(
      `INSERT OR IGNORE INTO conversations
         (id, title, channel, project_id, sealed, created_at, updated_at, message_count)
       VALUES (?, ?, 'mobile', ?, 0, ?, ?, 1)`,
      [conversationId, text.trim().slice(0, 60) || 'Untitled', projectId, timestamp, timestamp]
    )
    .catch(() => undefined)
}

/**
 * The offline stand-in: the user's message is kept, and the assistant slot
 * says why it is not answering. Written locally exactly as the demo agent
 * writes its replies, so the feed has one shape rather than a special case,
 * and nothing here is ever sent — when the desktop returns, its own copy of
 * the conversation replaces this one wholesale.
 */
async function offlineReply(
  input: SendPromptInput,
  user: ConversationMessage,
  projectId: string | null = null
): Promise<SendPromptResult> {
  const conversationId = input.conversationId ?? `local_${Date.now()}`
  if (input.conversationId === null) {
    await createLocalConversation(conversationId, input.text || 'Offline', Date.now(), projectId)
  }
  await appendLocalMessage(conversationId, user)
  await appendLocalMessage(conversationId, {
    id: `offline_${Date.now()}`,
    role: 'assistant',
    content: i18n.t('chat.offlineReply'),
    timestamp: Date.now()
  })
  // Stored copy first, live row second — settleTurn's contract, kept here for
  // the send paths that publish their bubble on a live turn before finding the
  // desktop out of reach (files, voice notes). The refetch puts both stored
  // rows in the caller's hands, and only then does the overlay come down —
  // dropping it earlier blanks the prompt for a frame, never dropping it
  // leaves thinking words running against a desktop that was never asked.
  await refetchConversation(conversationId)
  useChatRuntime.getState().endStream(conversationId)
  return { conversationId }
}

async function appendLocalMessage(
  conversationId: string,
  message: ConversationMessage
): Promise<void> {
  const db = await getDb()
  const row = await db.getFirstAsync<{ next: number }>(
    'SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM messages WHERE conversation_id = ?',
    [conversationId]
  )
  // Attachments ride in the payload so the bubble shows the file card
  // immediately — the same column shape the synced copy arrives in.
  const { id, role, content, timestamp, ...rest } = message
  const payload = Object.keys(rest).length > 0 ? JSON.stringify(rest) : null
  await db.runAsync(
    `INSERT OR REPLACE INTO messages
       (conversation_id, seq, id, role, content, timestamp, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [conversationId, row?.next ?? 0, id ?? `local_${timestamp}`, role, content, timestamp, payload]
  )
  await db.runAsync(
    'UPDATE conversations SET updated_at = ?, message_count = message_count + 1 WHERE id = ?',
    [timestamp, conversationId]
  )
}

/** Ask the desktop to stop the running turn. */
export async function abortTurn(conversationId: string): Promise<void> {
  const tunnel = tunnelClient.active
  if (!tunnel) return
  await tunnel.rpc(Rpc.abortTurn, { conversationId }).catch(() => undefined)
  // Marked complete here rather than waiting for the `canceled` status: the
  // button must not sit in its stop state through a round trip that may be
  // lost. Whatever streamed stays up until the desktop's saved copy of it
  // arrives, exactly as it does for a turn that ended on its own.
  //
  // The batching window first — a pooled delta flushing AFTER the mark would
  // put the row back to 'streaming' and flip Send to Stop again. Same order
  // as every other boundary: apply what arrived, then close.
  flushStream(conversationId)
  const live = liveFor(conversationId)
  if (live) useChatRuntime.getState().putStream(conversationId, { ...live, status: 'complete' })
  void settleTurn(conversationId)
}
