import type { ApprovalDecision, ApprovalRequest } from '@main/runtime/amygdala'
import type { AskUserRequest, AskUserResponse } from '@main/runtime/cerebellum'
import type { Segment, SegmentTurnEndReason } from '@main/runtime/broca'
import { turnScope, type CorpusEvent, type CorpusEvents } from '@main/runtime/corpus'
import { composeAttachmentContext } from '@main/uploads/compose-attachments'
import {
  resolveSummaryMarkIndex,
  type ConversationFile,
  type ConversationMessage
} from '@main/conversations'
import type { ChatHistoryMessage, PersistedApproval, PersistedToolTiming } from '@preload/index'

/**
 * A channel is one mouth wolffish can speak through. The Electron renderer
 * is the original channel; Telegram is the second. Both run the same agent
 * pipeline — the only difference is how segments, approvals, and turn
 * events get rendered to the user.
 *
 * Concretely, a channel receives a user message, calls into the shared
 * turn runner with a TurnSink describing how to render output, and the
 * runner drives agent.respond. Approval requests are routed to the
 * channel via the singleton TurnRouter so amygdala doesn't need to know
 * which channel a turn belongs to.
 */
export type ChannelId = 'electron' | 'telegram' | 'whatsapp' | 'cli'

/**
 * The set of callbacks the agent uses to render an active turn. The
 * channel owns the implementation — IPC sends for Electron, formatted
 * bot messages for Telegram. Methods may be invoked from any pipeline
 * region; implementations must handle being called after the turn ends
 * (e.g. a stale segment from a slow stream) without throwing.
 */
export interface TurnSink {
  readonly channelId: ChannelId
  readonly turnId: string
  readonly conversationId: string | null

  /** Streams text deltas, tool calls, tool results, turn_end. */
  onSegment(segment: Segment): void

  /** Tagged corpus events relayed to the channel. */
  onTurnEvent<E extends CorpusEvent>(type: E, payload: CorpusEvents[E]): void

  /**
   * Amygdala-flagged tool call. Resolve with the user's decision. The
   * channel is responsible for showing the request to the user and
   * waiting for their reply. Returns 'denied' on timeout / channel
   * close so a hung approval never wedges the pipeline.
   */
  onApprovalRequest(req: ApprovalRequest & { id: string }): Promise<ApprovalDecision>

  /**
   * Ask the user a multiple-choice question and resolve with their answer.
   * Optional: only channels with an interactive surface (the Electron
   * renderer) implement it. When absent, dispatchAskUser resolves
   * `unsupported` so the `ask` tool degrades to a plain-text prompt rather
   * than wedging the pipeline. Like onApprovalRequest, the channel must
   * resolve (not hang) on timeout / channel close.
   */
  onAskUserRequest?(req: AskUserRequest & { id: string }): Promise<AskUserResponse>

  /** Turn finished cleanly. */
  onDone(): void

  /** Turn threw. The channel should surface the error to the user. */
  onError(error: string): void

  /**
   * Sensitive-data filter discarded the message before it reached the
   * pipeline. Channels that log sensitive content (e.g. by echoing
   * messages back) should observe this to stay quiet.
   */
  onCredentialBlocked(type: string): void
}

/**
 * Singleton router that connects amygdala's global approval bridge (and the
 * ask_user bridge) to the channel sink that owns the REQUESTING turn. Turns
 * run concurrently, so there is no single "active" sink — the runner
 * registers each turn's sink under its turnId, and dispatch resolves the
 * caller's turn through the turn-identity AsyncLocalStorage (approval/ask
 * requests are awaited inside the turn's async call tree, so getStore()
 * names the right turn). An unresolvable request fails closed: approvals
 * deny, ask_user degrades to 'unsupported' — a sealed background run
 * (autonomous scope, no registered sink) lands here by design.
 */
class TurnRouter {
  private readonly sinks = new Map<string, TurnSink>()

  register(turnId: string, sink: TurnSink): void {
    this.sinks.set(turnId, sink)
  }

  unregister(turnId: string): void {
    this.sinks.delete(turnId)
  }

  /** Number of live registered turns (quit-drain diagnostics). */
  activeCount(): number {
    return this.sinks.size
  }

  private resolveSink(): TurnSink | null {
    const scope = turnScope.getStore()
    if (!scope || scope.autonomous || !scope.turnId) return null
    return this.sinks.get(scope.turnId) ?? null
  }

  async dispatchApproval(req: ApprovalRequest & { id: string }): Promise<ApprovalDecision> {
    const sink = this.resolveSink()
    if (!sink) return 'denied'
    return sink.onApprovalRequest(req)
  }

  async dispatchAskUser(req: AskUserRequest & { id: string }): Promise<AskUserResponse> {
    const sink = this.resolveSink()
    if (!sink || !sink.onAskUserRequest) return { kind: 'unsupported' }
    return sink.onAskUserRequest(req)
  }
}

export const turnRouter = new TurnRouter()

/**
 * Notified with a live snapshot of a channel turn's in-progress assistant
 * message so the in-app renderer can mirror a Telegram/WhatsApp run as it
 * streams — instead of the whole transcript appearing at once only after the
 * end-of-turn disk save. index.ts wires this to a renderer broadcast; the
 * same `message` identity (stable id) lands on disk at end-of-turn, so the
 * renderer reconciles the two by id and never shows the assistant twice.
 *
 * `userMessage` is the PROMPT that started this turn, carried on every tick
 * beside the answer. A mirror used to describe the assistant alone, which was
 * fine for the renderer (it has the prompt in its own feed) and wrong for the
 * phone: an in-app turn writes its user message to disk only at the fold, so
 * a phone watching the conversation had the answer streaming in with no
 * question above it for the whole turn — and a phone that PAIRS mid-turn has
 * no other way to learn the prompt exists. Repeated on every snapshot rather
 * than announced once, because a late-joining viewer only ever sees ticks.
 * It carries the id the turn will persist under, so the receiver drops its
 * copy the moment the stored transcript takes over.
 *
 * `message` is null for a prompt-only mirror — the tick emitted at turn start,
 * before the assistant has written anything worth showing.
 */
export type MirrorMessageListener = (
  conversationId: string,
  message: ConversationMessage | null,
  userMessage?: ConversationMessage
) => void

/**
 * The per-turn assistant-message accumulator a channel builds up as segments
 * stream in. TelegramChannel and WhatsAppChannel both hold these fields on
 * their ActiveTurn; buildAssistantMessage turns them into the persisted
 * assistant message — reused for BOTH the live mid-turn mirror snapshots and
 * the single end-of-turn save, keyed by the SAME stable id and timestamp so
 * the two are one message, never a duplicate.
 */
export type AssistantAccumulator = {
  /** Stable message id, minted once at onTurnStarted (mirror + persist share it). */
  assistantMessageId: string
  /** Stable message timestamp, stamped once at onTurnStarted (mirror + persist share it). */
  assistantTimestamp: number
  assistantContent: string
  segments: Segment[]
  approvals: Map<string, PersistedApproval>
  toolTimings: Map<string, PersistedToolTiming>
  stopReason: SegmentTurnEndReason | null
}

/**
 * Assemble the assistant ConversationMessage from a turn's accumulated
 * output, or null when the turn produced nothing to save (no prose AND no
 * segments). Same shape the Electron channel persists via the renderer, so
 * the in-app history replays the exact sequence the channel user saw.
 */
export function buildAssistantMessage(acc: AssistantAccumulator): ConversationMessage | null {
  const content = acc.assistantContent.trim()
  const hasSegments = acc.segments.length > 0
  if (content.length === 0 && !hasSegments) return null
  const assistant: ConversationMessage = {
    id: acc.assistantMessageId,
    role: 'assistant',
    content,
    timestamp: acc.assistantTimestamp
  }
  if (hasSegments) assistant.segments = acc.segments
  if (acc.approvals.size > 0) {
    assistant.approvals = Object.fromEntries(
      [...acc.approvals.values()].map((a) => [a.toolCallId, a])
    )
  }
  if (acc.toolTimings.size > 0) assistant.toolTimings = Object.fromEntries(acc.toolTimings)
  if (acc.stopReason) assistant.stopReason = acc.stopReason
  return assistant
}

/**
 * The replay window for a persisted conversation: when a rolling prefix
 * summary exists (written by the post-turn summarizer), replay
 * `summary preamble + messages from the mark` instead of the whole
 * transcript. The summarized turns stay on disk and indexed —
 * conversation_read retrieves them verbatim, and the preamble says so.
 */
export function replayWindow(
  conversation: Pick<
    ConversationFile,
    'id' | 'messages' | 'summary' | 'summarizedThroughMessage' | 'summarizedThroughMessageId'
  >
): { messages: ConversationMessage[]; preamble: ChatHistoryMessage[] } {
  // Id form first — it survives merges that insert before the boundary —
  // numeric mark as the fallback; the range guard below is unchanged (a
  // stale/corrupt mark degrades to full replay, never everything-skipped).
  const mark = resolveSummaryMarkIndex(
    conversation.messages,
    conversation.summarizedThroughMessage,
    conversation.summarizedThroughMessageId
  )
  const summary = conversation.summary?.trim()
  if (!summary || mark <= 0 || mark >= conversation.messages.length) {
    return { messages: conversation.messages, preamble: [] }
  }
  return {
    messages: conversation.messages.slice(mark),
    preamble: [
      {
        role: 'user',
        content:
          `[Conversation summary — the first ${mark} messages of this conversation were compressed; ` +
          `conversation_read("${conversation.id}") retrieves any of them verbatim]\n\n${summary}`
      },
      { role: 'assistant', content: 'Understood — continuing with that context.' }
    ]
  }
}

/** Tool results older than this many chars get stubbed once stale. */
const STALE_TOOL_RESULT_MIN_CHARS = 2_000
/** The last N user exchanges keep their tool results verbatim. */
const STALE_TOOL_PROTECT_EXCHANGES = 2

/**
 * Replace large tool-result payloads from OLDER exchanges with a
 * self-describing recovery stub. The full bytes stay persisted and indexed —
 * the stub names the retrieval call — so replay cost stops growing with
 * every old page-dump while nothing is ever actually lost. Mirrors the
 * outbound stub-with-recovery-pointer contract.
 */
export function stubStaleToolResults(
  history: ChatHistoryMessage[],
  conversationId: string
): ChatHistoryMessage[] {
  // Everything from the Nth-from-last user message onward is protected.
  let protectFrom = history.length
  let usersSeen = 0
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') {
      usersSeen++
      protectFrom = i
      if (usersSeen >= STALE_TOOL_PROTECT_EXCHANGES) break
    }
  }
  // Degenerate history with no user messages: exchange boundaries can't be
  // established, so nothing is provably stale — protect everything.
  if (usersSeen === 0) return history
  return history.map((entry, i) => {
    if (i >= protectFrom) return entry
    if (entry.role !== 'tool') return entry
    if (typeof entry.content !== 'string' || entry.content.length < STALE_TOOL_RESULT_MIN_CHARS) {
      return entry
    }
    return {
      ...entry,
      content: `[${entry.toolName} result from earlier in this conversation, ${entry.content.length} chars — memory_search or conversation_read("${conversationId}") retrieves it verbatim]`
    }
  })
}

/**
 * Reconstruct the full message history from a conversation's stored messages,
 * preserving tool calls and tool results from assistant segments. This gives
 * the model access to its prior tool interactions across turns.
 *
 * Worker-tagged segments (LEGACY, from the removed Orchestrator mode) are
 * excluded — mirrors the renderer's textHistory. The master's real context
 * received subagent output through its own await tool results (main
 * segments); replaying the forwarded worker segments too would interleave
 * subagent prose into the assistant's text and present subagent tool calls
 * as the master's own. Workflow-mode `workflow` snapshot segments fall
 * through the kind dispatch below untouched — display-only by design.
 */
/**
 * The history entry for a `user_message` segment — the same shape the
 * agent pushed into the model's messages when it delivered it (see
 * agent/interjection.ts interjectionToHistoryMessage): a voice note as a
 * `<voice_note>` block, attachments as the model-led reference list.
 */
export function interjectionSegmentToHistory(
  s: Extract<Segment, { kind: 'user_message' }>
): ChatHistoryMessage {
  if (s.voicePrompt) {
    const langAttr = s.voiceLang ? ` lang="${s.voiceLang}"` : ''
    return { role: 'user', content: `<voice_note${langAttr}>\n${s.text}` }
  }
  const attachments = s.attachments ?? []
  const entry: ChatHistoryMessage = {
    role: 'user',
    content: composeAttachmentContext(s.text, attachments)
  }
  if (attachments.length > 0) entry.attachments = attachments
  return entry
}

export function assistantSegmentsToHistory(msg: ConversationMessage): ChatHistoryMessage[] {
  const segments = msg.segments?.filter((s) => !('worker' in s && s.worker))
  if (!segments || segments.length === 0) {
    return [{ role: 'assistant', content: msg.content }]
  }

  const out: ChatHistoryMessage[] = []
  const toolCallNames = new Map<string, string>()
  for (const s of segments) {
    if (s.kind === 'tool_call') toolCallNames.set(s.toolCallId, s.name)
  }

  let iterText = ''
  let iterToolUses: Array<{ id: string; name: string; args: Record<string, unknown> }> = []
  let iterToolResults: ChatHistoryMessage[] = []
  let hasContent = false

  const flush = (): void => {
    if (!hasContent) return
    const assistantMsg: ChatHistoryMessage = { role: 'assistant', content: iterText }
    if (iterToolUses.length > 0) assistantMsg.toolUses = iterToolUses
    out.push(assistantMsg)
    for (const tr of iterToolResults) out.push(tr)
    // Backfill canceled results for any tool_call segment left without a
    // matching tool_result (a run stopped mid-tool). Providers reject an
    // assistant tool_calls message that isn't answered for every id, so the
    // next turn on this chat would 400 without this. Mirrors the renderer's
    // textHistory and the agent's Broca.closeOpenToolCalls.
    const resultIds = new Set(
      iterToolResults
        .filter((r): r is Extract<ChatHistoryMessage, { role: 'tool' }> => r.role === 'tool')
        .map((r) => r.toolUseId)
    )
    for (const use of iterToolUses) {
      if (resultIds.has(use.id)) continue
      out.push({
        role: 'tool',
        toolUseId: use.id,
        toolName: use.name,
        content: 'Tool execution was canceled by the user before it completed.',
        isError: true
      })
    }
    iterText = ''
    iterToolUses = []
    iterToolResults = []
    hasContent = false
  }

  let iterCount = 0
  for (const s of segments) {
    if (s.kind === 'active_model') {
      if (iterCount > 0) flush()
      iterCount++
    } else if (s.kind === 'user_message') {
      // A message the user sent mid-turn, read by the agent at this exact
      // point (after the iteration's tool results, before the next model
      // call). Close the iteration so far and replay it as the real user
      // entry it was — the model saw it there. Mirrored in the renderer's
      // textHistory (Chat.tsx); the two must stay identical.
      flush()
      out.push(interjectionSegmentToHistory(s))
    } else if (s.kind === 'text') {
      iterText += s.delta
      hasContent = true
    } else if (s.kind === 'tool_call') {
      iterToolUses.push({ id: s.toolCallId, name: s.name, args: s.args })
      hasContent = true
    } else if (s.kind === 'tool_result') {
      // Tool-result IMAGES are deliberately not replayed. They live only in
      // the in-memory messages array for the turn that produced them; a
      // segment stores the caption, never the base64. Re-hydrating them from
      // disk here would be auto-injection through the back door — the same
      // thing the attachment path refuses to do — and would re-bill every
      // screenshot on every later turn. The producing tools put the file path
      // in their caption and say the pixels are turn-scoped, so a model that
      // still needs to see it calls image_view again. Mirrored in the
      // renderer's textHistory (Chat.tsx).
      iterToolResults.push({
        role: 'tool',
        toolUseId: s.toolCallId,
        toolName: toolCallNames.get(s.toolCallId) ?? 'unknown',
        content: s.output,
        isError: s.status === 'failed' || s.status === 'stopped' || undefined
      })
      hasContent = true
    }
  }
  flush()

  if (out.length === 0) {
    return [{ role: 'assistant', content: msg.content }]
  }

  const turnEnd = segments.find((s) => s.kind === 'turn_end')
  if (turnEnd && 'reasoningContent' in turnEnd && turnEnd.reasoningContent) {
    const first = out[0]
    if (first.role === 'assistant') {
      first.reasoningContent = turnEnd.reasoningContent as string
    }
  }

  return out
}
