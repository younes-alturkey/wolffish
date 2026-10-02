/**
 * The CLI channel — wolffish spoken through a terminal.
 *
 * Structurally the Electron channel with a socket where the WebContents was:
 * it owns a per-turn sink, routes approvals and ask-the-user cards to the
 * attached client, and streams the same segments the renderer receives. What
 * it does NOT share with the Electron channel is who persists — the renderer
 * writes its own conversation file at the fold, and a terminal has no such
 * bookkeeping, so this channel persists the way Telegram and WhatsApp do:
 * append the user message on dispatch, build the assistant message from the
 * accumulator at end of turn, write once.
 *
 * Everything about being local is what makes it cheap. Attachments are paths
 * on the same filesystem the agent reads; delivered files are paths the user
 * can already open. There is no transport here, and there is deliberately no
 * transport-shaped code.
 *
 * Detach is not cancel. A client that goes away (SSH dropped, ^D, laptop shut)
 * leaves the turn running — that is the entire point of the daemon — and a
 * pending approval PARKS instead of failing closed, so reattaching (from here
 * or from the phone) can still answer it. Compare ElectronChannel, which
 * denies on window close: there, the window closing means the human is gone.
 * Here it means the human closed a viewport.
 */
import {
  buildAssistantMessage,
  replayWindow,
  stubStaleToolResults,
  assistantSegmentsToHistory,
  type AssistantAccumulator,
  type MirrorMessageListener,
  type TurnSink
} from '@main/channels/channel'
import type { TurnRunner } from '@main/channels/turn-runner'
import { TurnStatsCollector } from '@main/channels/turn-stats'
import {
  createConversation,
  loadConversation,
  mintMessageId,
  saveConversation,
  updateConversation,
  type ConversationFile,
  type ConversationMessage,
  type MessageAttachment
} from '@main/conversations'
import type { Agent } from '@main/runtime/agent'
import type { ApprovalDecision, ApprovalRequest } from '@main/runtime/amygdala'
import {
  appendTextSegment,
  upsertTaskSegment,
  upsertCountdownSegment,
  upsertWaitSegment,
  upsertProcessSegment,
  upsertBrowserSegment,
  upsertToolResultSegment,
  upsertTodoSegment,
  upsertWorkflowSegment,
  type Segment
} from '@main/runtime/broca'
import type { AskUserRequest, AskUserResponse } from '@main/runtime/cerebellum'
import type { InterjectVerdict, Interjection } from '@main/runtime/agent/interjection'
import { queueConversationSummarization } from '@main/conversation-summarizer'
import { turnScope, type CorpusEvents } from '@main/runtime/corpus'
import { composeAttachmentContext } from '@main/uploads/compose-attachments'
import type { ChatHistoryMessage } from '@preload/index'

/** Live mirror cadence — same budget every other channel uses. */
const MIRROR_THROTTLE_MS = 500

/**
 * One frame pushed to attached CLI clients. The client renders; nothing here
 * knows about ANSI, terminal width, or colour — a headless design decision, so
 * a second client (a TUI, an editor plugin) can render the same stream
 * differently without the daemon changing.
 */
export type CliEvent =
  | { t: 'segment'; conversationId: string | null; turnId: string; segment: Segment }
  | {
      t: 'turnEvent'
      conversationId: string | null
      turnId: string
      type: keyof CorpusEvents
      payload: unknown
    }
  | {
      t: 'approvalRequest'
      conversationId: string | null
      turnId: string
      id: string
      toolCallId: string
      tool: string
      args: Record<string, unknown>
      level: string
      reason: string
      description?: unknown
    }
  | {
      t: 'askRequest'
      conversationId: string | null
      turnId: string
      id: string
      toolCallId: string
      questions: unknown
    }
  | { t: 'done'; conversationId: string | null; turnId: string }
  | { t: 'error'; conversationId: string | null; turnId: string; error: string }
  | { t: 'credentialBlocked'; conversationId: string | null; turnId: string; type: string }

export type CliEventListener = (event: CliEvent) => void

export type CliSendPayload = {
  text: string
  conversationId?: string | null
  /** Absolute paths already staged into the workspace by the server. */
  attachments?: MessageAttachment[]
  workingFolders?: string[]
  projectId?: string | null
  thinkingMode?: 'off' | 'on' | 'high' | 'max'
  modeOverride?: 'single' | 'workflow'
  /** Plan mode: read-only turn that may only write its plan file. */
  planMode?: boolean
}

/** A message typed while the conversation's turn is still running. */
export type CliInterjectPayload = {
  conversationId: string
  /** Minted by the terminal, so it can retire its own pending row on delivery. */
  messageId: string
  text: string
  /** Absolute paths already staged into the workspace by the server. */
  attachments?: MessageAttachment[]
}

type LiveTurn = {
  controller: AbortController
  conversationId: string | null
  taskId: string | null
}

export class CliChannel {
  private readonly listeners = new Set<CliEventListener>()
  /**
   * Approvals and asks outlive their client on purpose (see the file header).
   * They resolve when SOMEONE answers, or when the turn ends — never merely
   * because the terminal that asked went away.
   */
  private readonly pendingApprovals = new Map<
    string,
    {
      turnId: string
      resolve: (decision: ApprovalDecision) => void
      /** Enough to REDRAW the card for a terminal that arrived after it. */
      frame: CliEvent
    }
  >()
  private readonly pendingAsks = new Map<
    string,
    { turnId: string; resolve: (response: AskUserResponse) => void; frame: CliEvent }
  >()
  private readonly turns = new Map<string, LiveTurn>()
  private readonly byConversation = new Map<string, string>()
  private mirrorListener: MirrorMessageListener | null = null

  constructor(
    private readonly agent: Agent,
    private readonly runner: TurnRunner
  ) {}

  setMessageMirror(listener: MirrorMessageListener | null): void {
    this.mirrorListener = listener
  }

  /** Attach a client. Returns the detach. */
  subscribe(listener: CliEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(event: CliEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // one broken client must never tear down a turn
      }
    }
  }

  /**
   * Requests still waiting for a human, so a client attaching mid-turn can
   * render the cards it never saw. Same idea as chat:activeRuns for runs.
   */
  /**
   * Everything still waiting for a human, WITH the frame that describes it.
   *
   * Returning only ids was enough to count them and nothing else: a terminal
   * reattaching after an SSH drop could see that two decisions were parked and
   * had no way to render either question, so the only honest thing it could do
   * was say so and leave the turn stuck. The stored frame is the same one the
   * live stream sent, so a returning client draws exactly the card it missed.
   */
  pendingRequests(): Array<{
    kind: 'approval' | 'ask'
    id: string
    turnId: string
    frame: CliEvent
  }> {
    return [
      ...[...this.pendingApprovals.entries()].map(([id, e]) => ({
        kind: 'approval' as const,
        id,
        turnId: e.turnId,
        frame: e.frame
      })),
      ...[...this.pendingAsks.entries()].map(([id, e]) => ({
        kind: 'ask' as const,
        id,
        turnId: e.turnId,
        frame: e.frame
      }))
    ]
  }

  /**
   * Run one turn. Loads (or creates) the conversation, appends the user
   * message, rebuilds the replay history exactly as the other non-renderer
   * channels do, and hands off to the shared runner.
   */
  async send(payload: CliSendPayload): Promise<{ turnId: string; conversationId: string }> {
    const conversation = await this.loadOrCreate(payload.conversationId ?? null)

    // Preempt this conversation's own in-flight turn, and only that one —
    // identical to the renderer's resend semantics.
    const previous = this.byConversation.get(conversation.id)
    if (previous) this.turns.get(previous)?.controller.abort()

    const attachments = payload.attachments ?? []
    const userMessage: ConversationMessage = {
      id: mintMessageId(),
      role: 'user',
      content: payload.text,
      timestamp: Date.now(),
      ...(attachments.length > 0 ? { attachments } : {})
    }

    // Local copy drives the history build below; the persist is an append-RMW
    // against the freshest disk state so a concurrent writer is never
    // clobbered. A null disk means the conversation was deleted underneath us.
    conversation.messages.push(userMessage)
    conversation.updatedAt = userMessage.timestamp
    await updateConversation(conversation.id, (disk) => {
      if (!disk) return null
      disk.messages.push(userMessage)
      disk.updatedAt = userMessage.timestamp
      return disk
    })

    const window = replayWindow(conversation)
    const history: ChatHistoryMessage[] = stubStaleToolResults(
      window.preamble.concat(
        window.messages.flatMap((m) => {
          if (m.role !== 'user') return assistantSegmentsToHistory(m)
          const atts = m.attachments ?? []
          const entry: ChatHistoryMessage = {
            role: 'user',
            content: composeAttachmentContext(m.content, atts)
          }
          if (atts.length > 0) {
            entry.attachments = atts.map((a) => ({
              type: a.type,
              filePath: a.filePath,
              originalName: a.originalName,
              mimeType: a.mimeType,
              sizeBytes: a.sizeBytes
            }))
          }
          return [entry]
        })
      ),
      conversation.id
    )

    const handle = this.runner.send({
      history,
      conversationId: conversation.id,
      conversationTitle:
        conversation.title && conversation.title !== 'Untitled' ? conversation.title : null,
      userMessageId: userMessage.id,
      projectId: payload.projectId ?? conversation.projectId ?? null,
      workingFolders: payload.workingFolders,
      thinkingMode: payload.thinkingMode,
      modeOverride: payload.modeOverride,
      planMode: payload.planMode === true,
      channel: 'cli',
      makeSink: ({ turnId, conversationId }) =>
        this.createSink(turnId, conversationId, conversation, userMessage)
    })

    this.turns.set(handle.turnId, {
      controller: handle.controller,
      conversationId: conversation.id,
      taskId: null
    })
    this.byConversation.set(conversation.id, handle.turnId)
    void handle.done.catch(() => undefined).finally(() => this.releaseTurn(handle.turnId))

    return { turnId: handle.turnId, conversationId: conversation.id }
  }

  private async loadOrCreate(conversationId: string | null): Promise<ConversationFile> {
    if (conversationId) {
      const existing = await loadConversation(conversationId)
      if (existing) return existing
    }
    // No idle rotation here, unlike the phone-facing channels: a terminal
    // session is explicit about which conversation it is in (`wolffish resume`,
    // `/resume`), so silently starting a fresh one would be a surprise.
    const fresh = createConversation(null)
    fresh.channel = 'cli'
    await saveConversation(fresh)
    return fresh
  }

  /**
   * Hand a message to the conversation's RUNNING turn instead of starting a
   * new one (see runtime/agent/interjection.ts). Unlike `send`, this never
   * preempts: the whole point is that the work in flight keeps going and
   * reads the message at its next stop point. The runner answers
   * `no_live_turn` when nothing is running on that conversation — including
   * a turn some other surface owns, which is fine: the inbox is per
   * conversation, not per channel, so a terminal can steer an app-started
   * run on the same transcript.
   */
  interject(payload: CliInterjectPayload): InterjectVerdict {
    const item: Interjection = {
      messageId: payload.messageId,
      text: payload.text,
      attachments: payload.attachments ?? [],
      channel: 'cli',
      sentAt: Date.now()
    }
    // Verdict only — see the Electron twin: `durable` never crosses IPC.
    const { status } = this.runner.interject(payload.conversationId, item)
    return { status }
  }

  /** Take a still-unread mid-turn message back. False once the agent read it. */
  withdrawInterjection(conversationId: string, messageId: string): boolean {
    return this.runner.withdrawInterjection(conversationId, messageId, 'user')
  }

  /** Mid-turn messages parked on a conversation — for a terminal attaching cold. */
  pendingInterjections(conversationId: string): Interjection[] {
    return this.runner.pendingInterjections(conversationId)
  }

  /** Stop a conversation's live turn (or every one when unscoped). */
  async cancel(conversationId?: string | null): Promise<{ canceled: boolean }> {
    const targets: string[] = []
    if (conversationId) {
      const turnId = this.byConversation.get(conversationId)
      if (turnId) targets.push(turnId)
    } else {
      targets.push(...this.turns.keys())
    }
    let canceled = false
    for (const turnId of targets) {
      const turn = this.turns.get(turnId)
      if (!turn) continue
      canceled = true
      turn.controller.abort()
      if (turn.taskId) {
        const taskId = turn.taskId
        await turnScope
          .run({ turnId, conversationId: turn.conversationId, autonomous: false }, () =>
            this.agent.motor.stopTask(taskId)
          )
          .catch(() => undefined)
      }
    }
    return { canceled }
  }

  respondApproval(id: string, decision: ApprovalDecision): boolean {
    const entry = this.pendingApprovals.get(id)
    if (!entry) return false
    this.pendingApprovals.delete(id)
    entry.resolve(decision)
    return true
  }

  respondAsk(id: string, response: AskUserResponse): boolean {
    const entry = this.pendingAsks.get(id)
    if (!entry) return false
    this.pendingAsks.delete(id)
    entry.resolve(response)
    return true
  }

  hasActiveTurn(): boolean {
    return this.turns.size > 0
  }

  isConversationActive(conversationId: string): boolean {
    return this.byConversation.has(conversationId)
  }

  abort(): void {
    for (const turn of this.turns.values()) turn.controller.abort()
    this.turns.clear()
    this.byConversation.clear()
  }

  /**
   * A finished turn drops its registration and drains ITS pending requests.
   * This is the only place a park expires: the turn is over, so nothing is
   * waiting on the answer any more.
   */
  private releaseTurn(turnId: string): void {
    const turn = this.turns.get(turnId)
    this.turns.delete(turnId)
    if (turn?.conversationId && this.byConversation.get(turn.conversationId) === turnId) {
      this.byConversation.delete(turn.conversationId)
    }
    for (const [id, entry] of this.pendingApprovals.entries()) {
      if (entry.turnId !== turnId) continue
      this.pendingApprovals.delete(id)
      entry.resolve('denied')
    }
    for (const [id, entry] of this.pendingAsks.entries()) {
      if (entry.turnId !== turnId) continue
      this.pendingAsks.delete(id)
      entry.resolve({ kind: 'canceled' })
    }
  }

  private createSink(
    turnId: string,
    conversationId: string | null,
    conversation: ConversationFile,
    userMessage: ConversationMessage
  ): TurnSink {
    const assistantTimestamp = Date.now()
    const acc: AssistantAccumulator = {
      assistantMessageId: mintMessageId(assistantTimestamp),
      assistantTimestamp,
      assistantContent: '',
      segments: [],
      approvals: new Map(),
      toolTimings: new Map(),
      stopReason: null
    }
    /**
     * Tokenomics for the persisted context-meter `stats`. The renderer builds
     * these itself for in-app turns; every other channel must fold them in at
     * the fold, and this one did not — so a CLI conversation reopened in the
     * app showed a blank meter card. Same collector Telegram/WhatsApp use.
     */
    const stats = new TurnStatsCollector(Date.now())

    let lastMirrorAt = 0
    let mirrorTimer: NodeJS.Timeout | null = null
    const emitMirror = (): void => {
      if (!this.mirrorListener || !conversationId) return
      if (!this.turns.has(turnId)) return
      const message = buildAssistantMessage(acc)
      if (!message) return
      lastMirrorAt = Date.now()
      this.mirrorListener(conversationId, message, userMessage)
    }
    const scheduleMirror = (immediate: boolean): void => {
      if (!this.mirrorListener || !conversationId) return
      const sinceLast = Date.now() - lastMirrorAt
      if (immediate || sinceLast >= MIRROR_THROTTLE_MS) {
        if (mirrorTimer) {
          clearTimeout(mirrorTimer)
          mirrorTimer = null
        }
        emitMirror()
        return
      }
      if (mirrorTimer) return
      mirrorTimer = setTimeout(() => {
        mirrorTimer = null
        emitMirror()
      }, MIRROR_THROTTLE_MS - sinceLast)
      mirrorTimer.unref?.()
    }

    /**
     * One write, at the fold — the same shape every other channel persists.
     * Runs even without an assistant message when the turn reached the model,
     * so an errored/empty turn still records its all-time roll-up (Telegram
     * and WhatsApp do the same).
     */
    const persist = async (): Promise<void> => {
      const assistant = buildAssistantMessage(acc)
      const foldStats = stats.hasData()
      if (!assistant && !foldStats) return
      const endedAt = Date.now()
      await updateConversation(conversation.id, (disk) => {
        if (!disk) return null
        if (assistant) {
          const existing = disk.messages.findIndex((m) => m.id === assistant.id)
          if (existing >= 0) disk.messages[existing] = assistant
          else disk.messages.push(assistant)
          disk.updatedAt = assistant.timestamp
        }
        if (foldStats) disk.stats = stats.foldInto(disk.stats, endedAt)
        /**
         * A heartbeat or procedure run SEALS its conversation as a finished
         * record. Answering in one from the terminal makes it live again, and
         * saying so is not optional bookkeeping — Telegram and WhatsApp both do
         * it (see the identical block in their channels) and this one did not,
         * with two consequences that both look like something else:
         *
         *  - The app treats a sealed file as a closed record, so terminal turns
         *    appended to an automation's conversation were written to disk and
         *    never appeared in the window. Reported as "I don't see it on
         *    desktop"; the messages were there the whole time.
         *  - The summarizer SKIPS sealed files, so the conversation never gets
         *    a rolling summary and every later reply replays the entire
         *    verbatim transcript — forever, and more expensively each time.
         */
        if (disk.sealed) disk.sealed = false
        return disk
      })
        .then(() => {
          /**
           * Ask for a rolling summary, exactly as Telegram and WhatsApp do at
           * this same fold.
           *
           * Missing here, and the omission compounds: without a summary the
           * next turn replays the whole verbatim transcript, so a long-lived
           * terminal conversation grows its own context linearly and costs
           * more on every reply until it hits the ceiling. That is worst
           * precisely where this channel matters most — a headless box, where
           * the terminal is the ONLY surface and its conversations are the
           * long ones.
           */
          if (assistant) queueConversationSummarization(conversation.id)
        })
        .catch(() => undefined)
    }

    return {
      channelId: 'cli',
      turnId,
      conversationId,
      onSegment: (segment) => {
        this.emit({ t: 'segment', conversationId, turnId, segment })
        if ('worker' in segment && segment.worker) return
        if (segment.kind === 'workflow') upsertWorkflowSegment(acc.segments, segment)
        else if (segment.kind === 'task') upsertTaskSegment(acc.segments, segment)
        else if (segment.kind === 'countdown') upsertCountdownSegment(acc.segments, segment)
        else if (segment.kind === 'wait') upsertWaitSegment(acc.segments, segment)
        else if (segment.kind === 'process') upsertProcessSegment(acc.segments, segment)
        else if (segment.kind === 'browser') upsertBrowserSegment(acc.segments, segment)
        else if (segment.kind === 'tool_result') upsertToolResultSegment(acc.segments, segment)
        else if (segment.kind === 'todo') upsertTodoSegment(acc.segments, segment)
        else if (segment.kind === 'text' || segment.kind === 'reasoning')
          appendTextSegment(acc.segments, segment)
        else acc.segments.push(segment)
        if (segment.kind === 'turn_end') acc.stopReason = segment.stopReason
        if (segment.kind === 'text') acc.assistantContent += segment.delta
        scheduleMirror(
          segment.kind === 'task' ||
            segment.kind === 'countdown' ||
            segment.kind === 'wait' ||
            segment.kind === 'process' ||
            segment.kind === 'user_message'
        )
      },
      onTurnEvent: <E extends keyof CorpusEvents>(type: E, payload: CorpusEvents[E]): void => {
        if (type === 'task.created') {
          const task = payload as CorpusEvents['task.created']
          const turn = this.turns.get(turnId)
          if (task.taskId && turn) turn.taskId = task.taskId
        }
        // Accumulate tokenomics for the persisted context-meter stats.
        stats.note(type, payload)
        this.emit({ t: 'turnEvent', conversationId, turnId, type, payload })
      },
      onApprovalRequest: (req: ApprovalRequest & { id: string }) => {
        return new Promise<ApprovalDecision>((resolve) => {
          const frame: CliEvent = {
            t: 'approvalRequest',
            conversationId,
            turnId,
            id: req.id,
            toolCallId: req.toolCall.id,
            tool: req.toolCall.name,
            args: req.toolCall.args,
            level: req.level,
            reason: req.reason,
            description: req.description
          }
          this.pendingApprovals.set(req.id, { turnId, resolve, frame })
          this.emit(frame)
        })
      },
      onAskUserRequest: (req: AskUserRequest & { id: string }) => {
        return new Promise<AskUserResponse>((resolve) => {
          const frame: CliEvent = {
            t: 'askRequest',
            conversationId,
            turnId,
            id: req.id,
            toolCallId: req.toolCallId,
            questions: req.questions
          }
          this.pendingAsks.set(req.id, { turnId, resolve, frame })
          this.emit(frame)
        })
      },
      onDone: () => {
        void persist().finally(() => this.emit({ t: 'done', conversationId, turnId }))
      },
      onError: (error) => {
        void persist().finally(() => this.emit({ t: 'error', conversationId, turnId, error }))
      },
      onCredentialBlocked: (type) => {
        this.emit({ t: 'credentialBlocked', conversationId, turnId, type })
      }
    }
  }
}
