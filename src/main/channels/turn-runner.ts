import { countdowns } from '@main/runtime/countdown'
import { turnRouter, type TurnSink } from '@main/channels/channel'
import { lastConversationMessageAt, type ConversationChannel } from '@main/conversations'
import { ensureConversationTitle, TITLE_DEADLINE_REASON } from '@main/conversation-titler'
import type { Agent } from '@main/runtime/agent'
import { turnScope, type CorpusEvent } from '@main/runtime/corpus'
import { CREDENTIAL_BLOCKED_REPLY, detectSensitiveData } from '@main/runtime/sensitiveDataFilter'
import type {
  Interjection,
  InterjectionEvent,
  InterjectionWithdrawReason,
  InterjectResult
} from '@main/runtime/agent/interjection'
import {
  markInterjectionWithdrawn,
  markInterjectionsDelivered,
  parkInterjection,
  releaseInterjection
} from '@main/channels/interjection-store'
import { waits } from '@main/runtime/wait'
import type { ChatHistoryMessage } from '@preload/index'

/**
 * Corpus events relayed to the channel as turn events. Same set the
 * original Electron chat:send handler used — the renderer expects each
 * of these in onTurnEvent listeners.
 */
export const TURN_RELAYED_EVENTS: CorpusEvent[] = [
  'context.built',
  'llm.response',
  'turn.usage',
  'task.created',
  'task.stepCompleted',
  'task.completed',
  'task.failed',
  'task.stopped',
  'tool.called',
  'tool.completed',
  'tool.failed',
  'safety.allowed',
  'safety.blocked',
  'safety.approved',
  'safety.denied',
  'compaction.started',
  'compaction.applied'
]

export type TurnSendOptions = {
  history: ChatHistoryMessage[]
  conversationId?: string | null
  conversationTitle?: string | null
  /**
   * The caller's own message id for the user message this turn carries
   * (the renderer's feed id, a channel's dispatch-persisted id). Threaded
   * to the titler so the shell it may pre-persist for that SAME logical
   * message carries the SAME id — the caller's later save then reconciles
   * with the shell by id instead of duplicating it.
   */
  userMessageId?: string
  /**
   * Delivery channel for this turn's prose. Threaded into the system
   * prompt so the model writes in the channel's native text formatting
   * (WhatsApp renders no Markdown). Omitted → no formatting overlay.
   */
  channel?: ConversationChannel
  /**
   * Active working-folder paths for this turn. The agent injects a fresh
   * listing into the OUTBOUND volatile tail (after every cache breakpoint) —
   * never into persisted/user content, so history stays byte-stable.
   */
  workingFolders?: string[]
  /**
   * Reference files for this turn — a procedure's attachments, carried on the
   * conversation the Play button created. Listed to the model (name, size,
   * path), never injected. Only procedures put files here, which is why the
   * overlay below names them as such.
   */
  contextFiles?: string[]
  /** Project this turn's conversation runs inside — its context overlays the system prompt. */
  projectId?: string | null
  thinkingMode?: 'off' | 'on' | 'high' | 'max'
  /**
   * Per-turn chat-mode override — the Procedures Play button threads the
   * procedure's own mode through here so a live procedure run honors its
   * stamp. Omitted (every normal channel turn) ⇒ the global mode.
   */
  modeOverride?: 'single' | 'workflow'
  /** Plan mode: read-only turn that may only write its plan file (see Agent). */
  planMode?: boolean
  /**
   * Channel-format feedback pull (observe-and-notify — see the channel
   * overlays' verbatim-prose contract). A prose-mirroring channel
   * (Telegram/WhatsApp) validates each prose block it delivers; when a
   * block leaked raw markup it parks a notice, and the agent drains this
   * every iteration to ride the notices on the volatile runtime tail —
   * the model then fixes the delivered message (telegram_edit_message)
   * and writes clean blocks for the rest of the turn. Nothing rewrites
   * or withholds the model's prose; the framework only tells it what the
   * user actually received. Omitted for channels that render Markdown.
   */
  formatNotices?: () => string[]
  /**
   * External controller. Lets channels tie cancellation to a parent
   * lifecycle (e.g. closing the renderer window aborts every pending
   * Electron turn).
   */
  controller?: AbortController
  /** Build the sink for this turn. Called exactly once. */
  makeSink: (ctx: { turnId: string; conversationId: string | null }) => TurnSink
  /**
   * Channels use this to register the new turn (abort previous, store
   * controller, capture sender). Fires after the sensitive-data gate
   * passes and before agent.respond starts.
   */
  onTurnStarted?: (handle: { turnId: string; controller: AbortController }) => void
  /** Symmetric cleanup for onTurnStarted. Always fires. */
  onTurnEnded?: (handle: { turnId: string }) => void
}

export type TurnHandle = {
  turnId: string
  controller: AbortController
  /** Resolves when the turn finishes (success or error). */
  done: Promise<void>
}

/**
 * A turn in flight (or queued) for a conversation, as seen from outside.
 * The renderer asks for these on window open: chat:turnState is a
 * BROADCAST, so a window created after a Telegram/WhatsApp run started —
 * the normal case for a tray app whose channels run headless — never saw
 * the 'started' event and would otherwise render the conversation idle.
 */
export type ActiveRun = {
  conversationId: string
  channel: string
  title: string | null
}

type LiveRun = {
  controller: AbortController
  channel: string
  title: string | null
}

/**
 * Lifecycle notifications for every foreground turn, regardless of channel.
 * Broadcast to the renderer (chat:turnState) so the Conversations sidebar
 * can show live status chips for in-app, WhatsApp and Telegram runs alike.
 */
export type TurnLifecycleEvent = {
  phase: 'started' | 'done' | 'canceled' | 'error'
  turnId: string
  conversationId: string | null
  channel: string
  title?: string | null
  error?: string
}

/**
 * A message the user sent while its conversation's turn was running, parked
 * for the agent to read at its next stop point (see agent/interjection.ts).
 * Kept per conversation, not per turn: a phone can message a desktop run,
 * and a turn queued behind its predecessor on the lane inherits whatever
 * the predecessor never got to.
 */
type Inbox = Interjection[]

/**
 * Single agent-wide dispatcher. Drives every turn through agent.respond
 * regardless of which channel originated it. Owns:
 *  - the sensitive-data gate,
 *  - per-turn corpus listener registration (keyed by turn identity),
 *  - amygdala approval / ask_user routing via turnRouter (keyed by turnId),
 *  - PER-CONVERSATION serialization: turns for the SAME conversation queue
 *    behind each other (a conversation is one ordered transcript), while
 *    turns for different conversations run in parallel. Every turn gets its
 *    own Broca (agent-side default) and runs inside a turnScope ALS entry,
 *    so concurrent respond() calls share no per-turn state.
 *
 * A channel can still preempt its own conversation's in-flight turn by
 * aborting the previous controller before calling send — that lets the
 * queued head unwind quickly.
 */
export class TurnRunner {
  /**
   * One promise tail per conversation (turns without a conversation id get a
   * private lane keyed by turnId). Entries are dropped once the tail settles
   * and is still the live tail — mirrors diskWriter's per-path queues.
   */
  private readonly chains = new Map<string, Promise<void>>()
  /** Live turn count per conversation key — backs isConversationActive. */
  private readonly activeTurns = new Map<string, number>()
  /**
   * Live turns keyed conversationId → turnId, carrying what an outside
   * observer needs: the abort handle (cross-channel cancel) and the channel
   * + title (the renderer's cold-start snapshot). Kept SEPARATE from
   * activeTurns because that map also lanes conversation-less turns under a
   * synthetic key, and its counts back the quit-drain — neither of which
   * this map should have to model.
   */
  private readonly liveRuns = new Map<string, Map<string, LiveRun>>()
  /**
   * Titles resolved this session, keyed by conversation id — skips the
   * per-turn disk check + LLM titling on every follow-up turn while still
   * feeding the real title to the lifecycle broadcast / cerebellum. Seeded on
   * the first turn (from an existing on-disk title for a resumed chat, or a
   * freshly generated one).
   */
  private readonly titledCache = new Map<string, string>()
  /**
   * When each conversation's most recent turn ENDED in this process, keyed by
   * conversation id. The in-session floor under the on-disk last-message
   * probe: an in-app fold is persisted by the renderer moments AFTER
   * agent.respond returns, so a turn queued right behind its predecessor can
   * read a transcript that doesn't have the last exchange yet — and would
   * claim a stale hours-old gap to the model. If a turn for this conversation
   * ended in-process at T, "we last talked" is at least T, whatever the disk
   * says.
   */
  private readonly lastTurnEndedAt = new Map<string, number>()
  private blockCredentials: boolean = false
  private locale: 'en' | 'ar' = 'en'
  private lifecycleListener: ((ev: TurnLifecycleEvent) => void) | null = null
  private readonly interjectionListeners = new Set<(ev: InterjectionEvent) => void>()
  /**
   * Woken whenever a lane ends with messages the turn never read, so the
   * reconciler gets a pass at exactly the moment something may have been left
   * behind. One listener (main wires it); the reconciler is idempotent, so a
   * missed call only delays a re-home to the next conversation save.
   */
  private interjectionSweepListener: ((conversationId: string) => void) | null = null
  /** Mid-turn user messages parked per conversation — see interject(). */
  private readonly inboxes = new Map<string, Inbox>()
  /**
   * Conversations owned by a run that never enters a lane — an automation,
   * procedure or heartbeat job (Agent.processAutonomous calls agent.respond
   * directly, so it has no entry in `activeTurns`, `chains` or `liveRuns`).
   *
   * They still need the inbox: an autonomous run is exactly the kind the user
   * watches and wants to steer ("that post text is wrong, fix it before
   * posting"). Without this, interject() answered `no_live_turn` for every
   * one of them while the window read `busy` — so the composer's optimistic
   * bubble went up and came straight back down, and the words waited,
   * invisible, for the run to end. Counted, not a flag, so two runs on one
   * conversation cannot close each other's inbox.
   */
  private readonly offLaneRuns = new Map<string, number>()
  /**
   * Deadline (ms) for the title-first LLM call. Titling is awaited BEFORE
   * agent.respond, so this is dead air on the front of a new conversation — a
   * hung or very slow provider must never wedge the turn. On expiry titling
   * degrades to a plain slice of the user's message (a deadline is not a
   * cancel — see TITLE_DEADLINE_REASON), so the turn always proceeds named.
   *
   * 30s, not 15s. Titling normally runs with reasoning OFF now
   * (thalamus.completeSingle), which puts a title at ~1.2s and never comes near
   * either number — so for most brains this value is inert and costs nothing.
   * It exists for the brains the reasoning-off fix CANNOT reach: an always-on
   * reasoner (grok-4/4.5, qwq, kimi-k2.7-code, minimax-m2.x) has no 'off' in
   * its registry, keeps the old p50 11.4s / p90 22.2s, and 15s clipped that
   * distribution at roughly its p70 — a coin-flip on every title.
   *
   * The ceiling is bounded by what it buys: 22.2s covers the p90, 30s leaves
   * headroom, and past ~30s a real title stops being worth the wait when a
   * readable slice is already guaranteed. It also un-breaks the retry ladder —
   * thalamus's backoff needs 1+2+4+8 = exactly 15,000ms before its 5th attempt,
   * so under the old 15s the deadline ALWAYS won that tie and the last retries
   * were unreachable (measured: a failing provider unwound at 15,009ms).
   *
   * Do NOT treat the raise as headroom to let titling get slow again: it is
   * only affordable because the common path is ~1.2s.
   */
  private titleTimeoutMs = 30_000

  constructor(private readonly agent: Agent) {}

  setBlockCredentials(value: boolean): void {
    this.blockCredentials = value
  }

  /** Override the title-first deadline (tests use a short value). */
  setTitleTimeout(ms: number): void {
    this.titleTimeoutMs = ms
  }

  setLocale(value: 'en' | 'ar'): void {
    this.locale = value
  }

  /** Wire the turn lifecycle broadcast (renderer status chips). */
  setLifecycleListener(listener: ((ev: TurnLifecycleEvent) => void) | null): void {
    this.lifecycleListener = listener
  }

  /**
   * Observe mid-turn message events. Its own channel, deliberately not
   * chat:turnState: that listener maps every phase it does not know to
   * "failed", and a pending message is not a run-state transition. Many
   * listeners: the broadcast to the surfaces is one, and each channel that
   * can SEND an interjection is another (a Telegram message returned with
   * reason turn_ended is re-dispatched by the Telegram channel). Returns
   * the unsubscribe.
   */
  onInterjection(listener: (ev: InterjectionEvent) => void): () => void {
    this.interjectionListeners.add(listener)
    return () => {
      this.interjectionListeners.delete(listener)
    }
  }

  /** Wire the end-of-lane sweep notification (the reconciler's prompt to look). */
  setInterjectionSweepListener(listener: ((conversationId: string) => void) | null): void {
    this.interjectionSweepListener = listener
  }

  /** True while any turn for this conversation is queued or running. */
  isConversationActive(conversationId: string): boolean {
    return (this.activeTurns.get(conversationId) ?? 0) > 0
  }

  /**
   * Register a run that owns this conversation without riding a lane — an
   * automation, procedure or heartbeat job. It buys exactly two things: the
   * inbox accepts mid-turn messages for it (see interject), and whatever it
   * never read is swept back to its senders when it closes.
   *
   * Deliberately NOT folded into `isConversationActive`: that count also backs
   * the quit-drain and the channels' "is this chat busy" checks, and an
   * autonomous run is neither a lane turn nor something a queued turn should
   * wait behind. The caller pairs this with closeOffLaneRun in a finally —
   * Agent.processAutonomous does it through the bridge main wires.
   */
  openOffLaneRun(conversationId: string): void {
    this.offLaneRuns.set(conversationId, (this.offLaneRuns.get(conversationId) ?? 0) + 1)
  }

  /**
   * The counterpart. The LAST run to close sweeps the inbox, exactly as the
   * lane tail does for a lane turn: anything the run never got to goes back
   * to its sender with the reason, and the park keeps it either way.
   */
  closeOffLaneRun(conversationId: string, reason: InterjectionWithdrawReason): void {
    const remaining = (this.offLaneRuns.get(conversationId) ?? 1) - 1
    if (remaining > 0) {
      this.offLaneRuns.set(conversationId, remaining)
      return
    }
    this.offLaneRuns.delete(conversationId)
    // Only if no lane turn is running on the same conversation — that one owns
    // the inbox now and drains it before its first call.
    if (this.isConversationActive(conversationId)) return
    this.sweepInterjections(conversationId, reason)
  }

  /** True while an off-lane run owns this conversation. */
  hasOffLaneRun(conversationId: string): boolean {
    return this.offLaneRuns.has(conversationId)
  }

  /**
   * Would interject() take a message for this conversation right now — a lane
   * turn OR an off-lane run is there to read it?
   *
   * The one definition OF THIS QUESTION. A surface that pre-checks before
   * doing expensive work (the phone transcribes a voice note before handing
   * it over, so it asks first) must ask exactly what interject() asks, or the
   * two drift and the pre-check silently refuses messages the inbox would
   * have taken — which is how automations lost every mid-turn message aimed
   * at them.
   *
   * NOT a replacement for `isConversationActive` at the sites that ask "is
   * this chat busy" (the Telegram/WhatsApp guards, the quit-drain): those
   * answer a different question, and a Telegram message arriving during an
   * automation still opens its own lane turn rather than interjecting. That
   * is unchanged behaviour, and changing it is a separate decision.
   */
  canInterject(conversationId: string): boolean {
    return this.isConversationActive(conversationId) || this.hasOffLaneRun(conversationId)
  }

  /**
   * The drain an off-lane run's agent loop calls at its stop points — the same
   * one a lane turn gets threaded as AgentTurnOptions.takeInterjections, so a
   * message reaches an automation by exactly the path it reaches a chat turn.
   */
  drainInterjections(conversationId: string, turnId: string): Interjection[] {
    return this.takeInterjections(conversationId, turnId)
  }

  /**
   * Hand a user message to the conversation's RUNNING turn. Accepted whenever
   * a turn is registered on the lane — including the window between send()
   * and the first model call, and a turn still queued behind its
   * predecessor, since the loop drains the inbox before its first call too —
   * or whenever an off-lane run (an automation, procedure or heartbeat job)
   * owns it. `no_live_turn` means exactly that: the caller starts a normal turn.
   */
  interject(conversationId: string, item: Interjection): InterjectResult {
    if (!this.canInterject(conversationId)) return { status: 'no_live_turn' }
    const inbox = this.inboxes.get(conversationId)
    if (inbox) inbox.push(item)
    else this.inboxes.set(conversationId, [item])
    // The park is what makes this message survive everything the in-memory
    // inbox cannot: a crash, a quit, a phone that goes away before the turn
    // hands the message back. Started here and NOT awaited — Telegram and
    // WhatsApp document that `pending` is emitted synchronously from inside
    // this call, before any terminal event for the same message can fire —
    // and handed to the caller so an async one can wait for real durability.
    // Never rejects (nobody awaits it on most paths), but never lies either:
    // a failed park resolves FALSE so the caller that acks on durability can
    // say so in the log instead of promising a disk copy that is not there.
    const durable = parkInterjection(conversationId, item).then(
      () => true,
      (error: unknown) => {
        console.error(
          `[turn-runner] parking mid-turn message ${item.messageId} failed — it survives only in memory:`,
          error
        )
        return false
      }
    )
    this.emitInterjection(conversationId, item, 'pending')
    // A blocking `wait` on this lane ends the moment the user speaks — from
    // the wait card's own input, the composer, or any channel. The text is
    // NOT consumed here: it stays in the inbox above and is delivered as an
    // ordinary mid-turn message at the agent's next stop point, which is the
    // wait's own tool result. One copy, in the order the user saw it.
    waits.interrupt(conversationId, item.text)
    return { status: 'pending', durable }
  }

  /**
   * Take a still-undelivered message back out. False once the agent has
   * already read it — a delivered message is history and cannot be unsent.
   */
  withdrawInterjection(
    conversationId: string,
    messageId: string,
    reason: InterjectionWithdrawReason = 'user'
  ): boolean {
    const inbox = this.inboxes.get(conversationId)
    if (!inbox) return false
    const idx = inbox.findIndex((i) => i.messageId === messageId)
    if (idx < 0) return false
    const [item] = inbox.splice(idx, 1)
    if (inbox.length === 0) this.inboxes.delete(conversationId)
    // Taken back BY THE USER is the one way a message leaves without a home:
    // they unsent it. Every other reason keeps the park so the reconciler can
    // re-home it — see sweepInterjections.
    void releaseInterjection(conversationId, messageId).catch(() => undefined)
    this.emitInterjection(conversationId, item, 'withdrawn', reason)
    return true
  }

  /** Messages parked for a conversation and not yet read (cold-start snapshots). */
  pendingInterjections(conversationId: string): Interjection[] {
    return [...(this.inboxes.get(conversationId) ?? [])]
  }

  /**
   * Message ids still sitting in the live inbox. The reconciler's "not mine to
   * touch" set: a parked message that is also here is simply waiting for the
   * agent's next stop point, not lost.
   */
  liveInterjectionIds(conversationId: string): Set<string> {
    return new Set((this.inboxes.get(conversationId) ?? []).map((i) => i.messageId))
  }

  /**
   * Drain the inbox for the agent loop. Called only from inside the turn
   * (threaded as AgentTurnOptions.takeInterjections); each item is on its
   * way into the model's messages the moment this returns, so `delivered`
   * is broadcast here.
   */
  private takeInterjections(conversationId: string, turnId: string): Interjection[] {
    const inbox = this.inboxes.get(conversationId)
    if (!inbox || inbox.length === 0) return []
    this.inboxes.delete(conversationId)
    // Delivered is NOT released: the message has left the inbox but has not
    // yet reached the transcript, and the writer that puts it there (a channel
    // sink's fold, or the renderer's) runs later and can fail. The park is the
    // proof obligation; the reconciler discharges it by finding the
    // `user_message` segment on disk.
    void markInterjectionsDelivered(
      conversationId,
      inbox.map((i) => i.messageId),
      turnId
    ).catch(() => undefined)
    for (const item of inbox) this.emitInterjection(conversationId, item, 'delivered')
    return inbox
  }

  /**
   * End-of-lane sweep: whatever the turn never got to (the sliver between
   * the loop's final drain and this point, or a Stop) goes back to its
   * sender with the reason — unless another turn is already queued on this
   * lane, in which case it stays and that turn reads it before its first
   * call.
   */
  private sweepInterjections(conversationId: string, reason: InterjectionWithdrawReason): void {
    const inbox = this.inboxes.get(conversationId)
    if (!inbox || inbox.length === 0) return
    this.inboxes.delete(conversationId)
    // The park KEEPS these. The `withdrawn` push below is the fast path — the
    // sender usually hears it and re-sends or takes its draft back — but it is
    // a push over a link that can be down, to a surface that can be gone, so
    // it is no longer the only path. Recording the reason turns the park into
    // a work item the reconciler can act on without any surface's help: a
    // stopped run holds its message, everything else gets re-sent as a turn.
    for (const item of inbox) {
      void markInterjectionWithdrawn(conversationId, item.messageId, reason).catch(() => undefined)
      this.emitInterjection(conversationId, item, 'withdrawn', reason)
    }
    this.interjectionSweepListener?.(conversationId)
  }

  private emitInterjection(
    conversationId: string,
    item: Interjection,
    state: InterjectionEvent['state'],
    reason?: InterjectionWithdrawReason
  ): void {
    const ev: InterjectionEvent = {
      conversationId,
      messageId: item.messageId,
      channel: item.channel,
      text: item.text,
      attachments: item.attachments,
      ...(item.voicePrompt ? { voicePrompt: true } : {}),
      ...(item.voiceLang ? { voiceLang: item.voiceLang } : {}),
      state,
      ...(reason ? { reason } : {})
    }
    for (const listener of this.interjectionListeners) {
      try {
        listener(ev)
      } catch {
        // a broken listener must never tear down a turn
      }
    }
  }

  /** Total queued+running turns across all conversations (quit-drain). */
  activeTurnCount(): number {
    let n = 0
    for (const count of this.activeTurns.values()) n += count
    return n
  }

  /**
   * Snapshot of every conversation with a turn in flight, for a renderer
   * window that missed the 'started' broadcasts (opened, or reopened from
   * the tray, mid-run). One entry per conversation — the lane serializes
   * them, so the head is the run the UI should reflect.
   */
  activeRuns(): ActiveRun[] {
    const out: ActiveRun[] = []
    for (const [conversationId, runs] of this.liveRuns) {
      const head = runs.values().next().value
      if (!head) continue
      out.push({
        conversationId,
        channel: head.channel,
        title: head.title ?? this.titledCache.get(conversationId) ?? null
      })
    }
    return out
  }

  /**
   * Abort every live turn of a conversation, whatever channel owns it. This
   * is what makes the in-app Stop button real for a Telegram/WhatsApp run
   * the user is watching from the app: the originating channel keeps its own
   * controllers, but they all resolve through here.
   *
   * In-app turns go through ElectronChannel.cancel first (it also forwards
   * the stop to motor) — this is the fallback for everything else.
   */
  cancelConversation(conversationId: string): boolean {
    const runs = this.liveRuns.get(conversationId)
    if (!runs || runs.size === 0) return false
    for (const run of runs.values()) run.controller.abort()
    return true
  }

  private emitLifecycle(ev: TurnLifecycleEvent): void {
    try {
      this.lifecycleListener?.(ev)
    } catch {
      // a broken listener must never tear down a turn
    }
  }

  send(opts: TurnSendOptions): TurnHandle {
    const turnId = generateTurnId()
    const controller = opts.controller ?? new AbortController()

    const sink = opts.makeSink({
      turnId,
      conversationId: opts.conversationId ?? null
    })

    const lastMessage = opts.history[opts.history.length - 1]
    const userContent = lastMessage && lastMessage.role === 'user' ? lastMessage.content : ''
    const sensitive = this.blockCredentials ? detectSensitiveData(userContent) : null

    if (sensitive) {
      // Sensitive-data gate runs synchronously and bypasses the chain
      // — there is no agent.respond, so no shared state to corrupt
      // and no benefit from queueing. The reply still uses the
      // channel's sink so the user gets the canned response wherever
      // they sent the message from.
      this.agent.corpus.emit('security.credentialBlocked', {
        type: sensitive.type,
        messageDiscarded: true
      })
      sink.onSegment({
        kind: 'text',
        turnId,
        segmentId: 'seg_1',
        delta: CREDENTIAL_BLOCKED_REPLY
      })
      sink.onSegment({
        kind: 'turn_end',
        turnId,
        segmentId: 'seg_2',
        stopReason: 'end_turn',
        iterationCount: 0
      })
      sink.onCredentialBlocked(sensitive.type)
      sink.onDone()
      return {
        turnId,
        controller,
        done: Promise.resolve()
      }
    }

    const agent = this.agent
    const conversationId = opts.conversationId ?? null
    // Why the turn's undelivered mid-turn messages go back to their senders
    // — set when the turn settles, read by the lane tail's sweep below.
    let sweepReason: InterjectionWithdrawReason = 'turn_ended'
    // Turns for the SAME conversation serialize (one transcript, one order);
    // a turn with no conversation gets a private lane and runs immediately.
    const laneKey = conversationId ?? `turn:${turnId}`
    const prevChain = this.chains.get(laneKey) ?? Promise.resolve()
    this.activeTurns.set(laneKey, (this.activeTurns.get(laneKey) ?? 0) + 1)
    // Register NOW, not at lane start: a turn queued behind its
    // conversation's predecessor is already something the UI must render as
    // running (and something Stop must be able to cancel).
    if (conversationId) {
      let runs = this.liveRuns.get(conversationId)
      if (!runs) {
        runs = new Map<string, LiveRun>()
        this.liveRuns.set(conversationId, runs)
      }
      runs.set(turnId, {
        controller,
        channel: sink.channelId,
        title:
          opts.conversationTitle && opts.conversationTitle !== 'Untitled'
            ? opts.conversationTitle
            : (this.titledCache.get(conversationId) ?? null)
      })
    }

    const done = (async () => {
      // Wait for any in-flight turn OF THIS CONVERSATION to finish. A channel
      // that wants priority should abort the previous turn's controller
      // before calling send — that lets the queued head unwind quickly.
      await prevChain.catch(() => undefined)

      opts.onTurnStarted?.({ turnId, controller })

      // "When did we last talk" probe for the conversation-resumed runtime
      // notice: newest persisted message EXCLUDING this turn's own user
      // message (channels persist it before dispatching — see
      // lastConversationMessageAt). Kicked off here so the disk read runs
      // under the titling await instead of adding latency; resolved to a
      // value right before agent.respond. Sequenced after prevChain so a
      // queued turn reads the transcript its predecessor left, and floored
      // by lastTurnEndedAt for the fold-persist lag that read can still
      // race. Best-effort: a failed read means no notice, never a failed
      // turn.
      const lastMessageAtProbe = conversationId
        ? lastConversationMessageAt(conversationId, opts.userMessageId).catch(() => null)
        : Promise.resolve(null)

      const offs: Array<() => void> = []
      for (const eventName of TURN_RELAYED_EVENTS) {
        const off = agent.corpus.on(eventName, (payload) => {
          // Relay only events emitted from inside THIS turn's async call tree.
          // Corpus emit is synchronous (mitt), so getStore() reads the
          // EMITTER's scope: background autonomous runs are dropped outright,
          // a concurrent foreground turn's events are dropped because their
          // turnId differs (they have their own relay), and scope-less emits
          // (outside any turn) stay fail-open and relay as they always have.
          // Without the turnId check, every live turn's meter/token/task
          // events would blend into every other turn's sink.
          const scope = turnScope.getStore()
          if (scope?.autonomous) return
          if (scope?.turnId && scope.turnId !== turnId) return
          sink.onTurnEvent(eventName, payload)
        })
        offs.push(off)
      }

      turnRouter.register(turnId, sink)

      // Resolve what's already known synchronously (caller-provided or
      // session-cached) so follow-up turns carry their real title from the
      // first event. 'Untitled' is a placeholder, not a title, and it is
      // TRUTHY — passing it through would satisfy the `if (!title)` below and
      // skip titling for good. Channels persist exactly that placeholder to
      // disk before the turn (telegram/channel.ts loadOrCreateConversation),
      // so a caller wiring `conversationTitle: conv.title` is a live hazard.
      const provided =
        opts.conversationTitle && opts.conversationTitle !== 'Untitled'
          ? opts.conversationTitle
          : undefined
      let title = provided ?? (conversationId ? this.titledCache.get(conversationId) : undefined)

      // Emit 'started' BEFORE titling — titling is a blocking LLM call
      // (~1.2s typical, titleTimeoutMs cap), and gating the emit on it left
      // a window where a brand-new conversation existed on disk but had no
      // live status: the rail showed a dead untitled row (or, pre-index,
      // nothing). Early, the row appears instantly with a pulsing chip; the
      // resolved title reaches the renderer via the titled-shell disk write
      // (watcher → conversation:changed) and the terminal emit below.
      // Exactly ONE 'started' per turn — the lifecycle contract (see the
      // concurrent-edge roll-up test) — so this is a move, not a re-emit.
      this.emitLifecycle({
        phase: 'started',
        turnId,
        conversationId,
        channel: sink.channelId,
        title: title ?? null
      })

      // Title next, still before any processing. For a new conversation this
      // is a pure LLM call to the chosen model; it also persists the title
      // (writing a titled shell for an in-app chat whose file doesn't exist
      // yet), so the conversation is saved with its title before
      // agent.respond runs. Idempotent + session-cached: a conversation
      // already titled skips the LLM (and the disk check) entirely, so
      // follow-up turns pay nothing.
      if (!title) {
        // Bound the title-first call with a PRIVATE deadline that aborts ONLY
        // titling — never the turn's own controller (that would kill the turn).
        // On timeout the titler degrades to a plain slice of the user's message
        // and agent.respond still runs. The abort REASON is what distinguishes
        // the two abort sources: a deadline wants that slice (this conversation
        // may never get a second turn to be re-titled on), while a genuine turn
        // cancel — chained in below so titling unwinds promptly — must stay ''
        // so it doesn't bury the real title a later turn would write.
        // thalamus retries the model call internally; this only caps a
        // hung/slow provider so it can't wedge the turn.
        const titleController = new AbortController()
        const abortTitling = (): void => titleController.abort()
        if (controller.signal.aborted) abortTitling()
        else controller.signal.addEventListener('abort', abortTitling, { once: true })
        const titleTimer = setTimeout(
          () => titleController.abort(TITLE_DEADLINE_REASON),
          this.titleTimeoutMs
        )
        try {
          title = await ensureConversationTitle(
            conversationId,
            userContent,
            opts.channel,
            agent.thalamus,
            titleController.signal,
            opts.userMessageId
          )
        } finally {
          clearTimeout(titleTimer)
          controller.signal.removeEventListener('abort', abortTitling)
        }
        if (conversationId && title && title !== 'Untitled') {
          this.titledCache.set(conversationId, title)
          const run = this.liveRuns.get(conversationId)?.get(turnId)
          if (run) run.title = title
        }
      }

      // Disk truth floored by in-process truth (see lastTurnEndedAt).
      const diskLastMessageAt = (await lastMessageAtProbe) ?? 0
      const sessionLastEndedAt = conversationId
        ? (this.lastTurnEndedAt.get(conversationId) ?? 0)
        : 0
      const lastMessageAt = Math.max(diskLastMessageAt, sessionLastEndedAt) || null

      let completed = false
      try {
        // (sweepReason is set in the finally below and read by the lane tail.)
        // The turnScope entry is what keys everything per-turn downstream:
        // the corpus relays above, approval/ask routing in turnRouter, and
        // the daily-log attribution — all read the emitter's scope.
        const result = await turnScope.run({ turnId, conversationId, autonomous: false }, () =>
          agent.respond({
            history: opts.history,
            turnId,
            conversationId,
            conversationTitle: title,
            channel: opts.channel,
            workingFolders: opts.workingFolders,
            contextFiles: opts.contextFiles,
            contextFilesOwner: 'procedure',
            projectId: opts.projectId,
            lastMessageAt,
            signal: controller.signal,
            onSegment: (segment) => sink.onSegment(segment),
            thinkingMode: opts.thinkingMode,
            modeOverride: opts.modeOverride,
            planMode: opts.planMode === true,
            formatNotices: opts.formatNotices,
            takeInterjections: conversationId
              ? () => this.takeInterjections(conversationId, turnId)
              : undefined
          })
        )
        sink.onDone()
        completed = result.stopReason !== 'canceled'
        this.emitLifecycle({
          phase: result.stopReason === 'canceled' ? 'canceled' : 'done',
          turnId,
          conversationId,
          channel: sink.channelId,
          title
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const humanized = humanizeProviderError(message, this.locale)
        sink.onError(humanized)
        this.emitLifecycle({
          phase: controller.signal.aborted ? 'canceled' : 'error',
          turnId,
          conversationId,
          channel: sink.channelId,
          title,
          error: humanized
        })
      } finally {
        // Recorded on EVERY exit (done, canceled, error) — the user was here
        // seconds ago in all three, and the queued successor turn reads this
        // map strictly after this finally runs (it awaits our promise tail).
        if (conversationId) this.lastTurnEndedAt.set(conversationId, Date.now())
        sweepReason = controller.signal.aborted ? 'canceled' : completed ? 'turn_ended' : 'error'
        for (const off of offs) off()
        turnRouter.unregister(turnId)
        // A countdown armed in this turn starts its clock now — or is dropped
        // if the turn was stopped or died, since the reply that warned the
        // user never landed.
        countdowns.turnEnded(turnId, completed)
        opts.onTurnEnded?.({ turnId })
      }
    })()

    const tail = done.catch(() => undefined)
    this.chains.set(laneKey, tail)
    void tail.then(() => {
      const remaining = (this.activeTurns.get(laneKey) ?? 1) - 1
      if (remaining <= 0) this.activeTurns.delete(laneKey)
      else this.activeTurns.set(laneKey, remaining)
      if (this.chains.get(laneKey) === tail) this.chains.delete(laneKey)
      if (conversationId) {
        const runs = this.liveRuns.get(conversationId)
        runs?.delete(turnId)
        if (runs && runs.size === 0) this.liveRuns.delete(conversationId)
        // Undelivered mid-turn messages: kept for a successor already queued
        // on this lane (it drains them before its first call); otherwise
        // returned to their senders with why — a Stop restores the draft, a
        // natural finish re-sends as a fresh turn. Swept HERE, after the lane
        // count drops, not in the turn's finally: between the two, interject()
        // still said "pending" for a lane nobody would ever drain, and a
        // message accepted in that window sat unread until the next turn.
        // Now everything accepted up to the decrement is swept with it, and
        // anything after is refused with no_live_turn.
        //
        // The off-lane guard is the mirror of closeOffLaneRun's lane guard: an
        // automation can own this conversation while a channel message opens a
        // lane turn beside it, and the lane turn ending must not sweep the
        // automation's inbox out from under a run that is still going and will
        // still drain it.
        if (remaining <= 0 && !this.hasOffLaneRun(conversationId)) {
          this.sweepInterjections(conversationId, sweepReason)
        }
      }
    })

    return { turnId, controller, done }
  }
}

type ErrorKey =
  | 'stalled'
  | 'invalidKey'
  | 'modelNotFound'
  | 'rateLimited'
  | 'serverError'
  | 'offline'
  | 'badRequest'

const ERROR_MESSAGES: Record<ErrorKey, Record<'en' | 'ar', string>> = {
  invalidKey: {
    en: 'The model API key appears to be invalid or expired. Update it in Settings.',
    ar: 'يبدو أن مفتاح API للنموذج غير صالح أو منتهي الصلاحية. حدّثه من الإعدادات.'
  },
  modelNotFound: {
    en: 'The configured model was not found. It may have been renamed or retired by the provider.',
    ar: 'لم يُعثر على النموذج المحدد. ربما تم تغيير اسمه أو إيقافه من قبل المزوّد.'
  },
  rateLimited: {
    en: 'Rate-limited by the model provider. Try again in a moment.',
    ar: 'تم تقييد الطلبات من المزوّد. حاول مجدداً بعد قليل.'
  },
  serverError: {
    en: 'The model provider is temporarily unavailable. Try again shortly.',
    ar: 'مزوّد النموذج غير متاح مؤقتاً. حاول مجدداً بعد قليل.'
  },
  offline: {
    en: 'You appear to be offline. Check your internet connection.',
    ar: 'يبدو أنك غير متصل بالإنترنت. تحقق من اتصالك.'
  },
  badRequest: {
    en: 'The provider rejected the request. Try a different model or check your configuration.',
    ar: 'رفض المزوّد الطلب. جرّب نموذجاً آخر أو تحقق من الإعدادات.'
  },
  stalled: {
    en: 'Five minutes passed with no response from the API, so the request was aborted. Press Continue to carry on from here.',
    ar: 'مرّت خمس دقائق دون أي استجابة من الـ API، فأُلغي الطلب. اضغط «متابعة» للاستمرار من هنا.'
  }
}

function humanizeProviderError(raw: string, locale: 'en' | 'ar'): string {
  // Reason-key strings from thalamus STATUS_REASON_LABEL (no_provider_available path)
  if (raw === 'authentication failed' || raw === 'forbidden')
    return ERROR_MESSAGES.invalidKey[locale]
  if (raw === 'model not found') return ERROR_MESSAGES.modelNotFound[locale]
  if (raw === 'rate-limited') return ERROR_MESSAGES.rateLimited[locale]
  if (raw === 'bad request') return ERROR_MESSAGES.badRequest[locale]
  if (
    raw === 'unavailable' ||
    raw === 'server error' ||
    raw === 'gateway error' ||
    raw === 'timeout' ||
    raw === 'overloaded'
  ) {
    return ERROR_MESSAGES.serverError[locale]
  }
  if (raw === 'offline') return ERROR_MESSAGES.offline[locale]
  if (raw === 'stalled') return ERROR_MESSAGES.stalled[locale]

  // Raw HTTP errors from committed-error path (provider threw mid-stream)
  if (/HTTP\s+400/i.test(raw)) {
    const provider = extractProviderName(raw)
    const base = ERROR_MESSAGES.badRequest[locale]
    return provider ? `${provider}: ${base}` : base
  }
  if (/HTTP\s+40[13]/i.test(raw)) {
    const provider = extractProviderName(raw)
    const base = ERROR_MESSAGES.invalidKey[locale]
    return provider ? `${provider}: ${base}` : base
  }
  if (/HTTP\s+404/i.test(raw)) return ERROR_MESSAGES.modelNotFound[locale]
  if (/HTTP\s+429/i.test(raw)) return ERROR_MESSAGES.rateLimited[locale]
  if (/HTTP\s+5\d\d/i.test(raw) || /overloaded/i.test(raw))
    return ERROR_MESSAGES.serverError[locale]
  return raw
}

function extractProviderName(error: string): string | null {
  const match = /^(anthropic|openai|deepseek|mimo|kimi|minimax)\b/i.exec(error)
  return match ? match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase() : null
}

function generateTurnId(): string {
  return `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}
