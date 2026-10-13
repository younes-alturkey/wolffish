import { countdowns } from '@main/runtime/countdown'
import { interpretAskReply } from '@main/channels/ask-reply'
import { bindChatToConversation } from '@main/channels/chat-binding'
import {
  assistantSegmentsToHistory,
  buildAssistantMessage,
  replayWindow,
  stubStaleToolResults,
  type MirrorMessageListener,
  type TurnSink
} from '@main/channels/channel'
import { queueConversationSummarization } from '@main/conversation-summarizer'
import {
  getConversationIdForChat,
  setConversationIdForChat
} from '@main/channels/telegram/conversations'
import { markdownToPlain } from '@main/channels/format'
import { extractTranscript, extractVoiceLanguage } from '@main/channels/stt-result'
import {
  ChannelMessageQueue,
  queueClearedText,
  queueEmptyText,
  queuePendingNote,
  queuedAckText,
  unreadAfterStopText,
  type QueuedMessageBase
} from '@main/channels/message-queue'
import { listProjects, projectLabel, type Project } from '@main/projects'
import { bidiMark, escapeHtml, validateTelegramHtml } from '@main/channels/telegram/format'
import {
  flushMessageIds,
  loadMessageIds,
  recordMessageId,
  takeMessageIdsForChat
} from '@main/channels/telegram/messages'
import { buildTelegramCapability, TELEGRAM_CAPABILITY_NAME } from '@main/channels/telegram/tools'
import { TurnStatsCollector } from '@main/channels/turn-stats'
import type { TurnRunner } from '@main/channels/turn-runner'
import {
  createConversation,
  deleteConversation,
  listConversations,
  loadConversation,
  mintMessageId,
  saveConversation,
  updateConversation,
  type ConversationFile,
  type ConversationMessage,
  type ConversationMeta,
  type MessageAttachment
} from '@main/conversations'
import type { Agent } from '@main/runtime/agent'
import {
  interjectionAckText,
  type Interjection,
  type InterjectionEvent
} from '@main/runtime/agent/interjection'
import type { ApprovalDecision, ApprovalRequest } from '@main/runtime/amygdala'
import {
  ASK_USER_TOOL,
  OFFER_OPTIONS_TOOL,
  type AskUserAnswer,
  type AskUserQuestion,
  type AskUserRequest,
  type AskUserResponse
} from '@main/runtime/cerebellum'
import { compressVideoToLimit } from '@main/channels/video-compress'
import { renderOptionsForChannel } from '@main/channels/options-render'
import {
  WORKFLOW_TOOL_NAMES,
  type Segment,
  type SegmentTurnEndReason,
  type WorkflowSnapshot,
  foldSegment
} from '@main/runtime/broca'
import { turnScope, type CorpusEvents } from '@main/runtime/corpus'
import type { LocalProvider } from '@main/runtime/providers/local'
import { composeAttachmentContext } from '@main/uploads/compose-attachments'
import { saveUploadFromBuffer } from '@main/uploads/uploads'
import {
  getTelegramConfig,
  readConfig,
  setBrain as persistBrain,
  setLocalOnly as persistLocalOnly,
  setMode as persistMode,
  workspaceRoot
} from '@main/workspace/workspace'
import {
  isNextPageReply,
  keycapNumber,
  originLabel,
  pageExists,
  parseSelectionNumber,
  pickerPage,
  selectableCount,
  truncateTitle
} from '@main/channels/conversation-picker'
import {
  collectModelOptions,
  filterModelOptions,
  MODEL_LIST_CAP,
  type ModelOption
} from '@main/channels/model-picker'
import type {
  ChatHistoryMessage,
  PersistedApproval,
  PersistedToolTiming,
  TelegramConfig,
  TelegramErrorKind,
  TelegramTestResult
} from '@preload/index'
import { Bot, GrammyError, HttpError, InputFile, type Context as BotContext } from 'grammy'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Maximum bytes per Telegram message. The spec is 4096; we cap one
 * char below to leave room for the trailing newline our split logic
 * adds when it has to chunk.
 */
const MESSAGE_LIMIT = 4096

/**
 * Approval / cancel / new / status are slash commands only —
 * deterministic so an off-the-cuff "yes" or "stop" in normal
 * conversation never accidentally resolves an approval or cancels a
 * task. /start is the Telegram convention for "begin a session" so
 * it's an alias for /new.
 */
const APPROVE_COMMAND = '/approve'
const DENY_COMMAND = '/deny'
const STATUS_COMMAND = '/status'
const CURRENT_COMMAND = '/current'
const RESUME_COMMAND = '/resume'
const DELETE_COMMAND = '/delete'
const CLEAR_COMMAND = '/clear'
const LOCAL_COMMAND = '/local'
const CLOUD_COMMAND = '/cloud'
const MODE_COMMAND = '/mode'
const MODEL_COMMAND = '/model'
const PROJECT_COMMAND = '/project'
/**
 * /cancel used to be an alias for /stop. It now drops the QUEUE instead —
 * messages sent mid-turn are parked rather than declined, so "cancel" needs to
 * mean the queue and "stop" needs to keep meaning the running task. The two
 * are genuinely different actions now, and the empty-queue reply points anyone
 * with the old habit at /stop.
 */
const STOP_COMMANDS = new Set(['/stop'])
const CANCEL_COMMAND = '/cancel'
const NEW_COMMANDS = new Set(['/new', '/start'])

const COMMANDS_HELP_HTML = [
  '<b>Commands:</b>',
  '/mode — single or workflow mode',
  '/model — pick the cloud model',
  '/project — pick or exit a project',
  '/resume — continue a previous chat',
  '/delete — delete a saved conversation',
  '/cancel — drop messages waiting in the queue',
  '/clear — clear messages from this chat',
  '/ — show more commands'
].join('\n')

/**
 * Static reply used when the local model is unavailable or fails.
 * Phrased to match what the local-model fallback would generate so
 * users don't get a noticeably different experience.
 */
const FALLBACK_BUSY_REPLY = "Hold on — I'm working on something. I'll get back to you in a moment."

/**
 * System prompt for the local-model decline. Kept short so a
 * lightweight local model can produce a coherent response in <2s.
 * Strict instruction not to attempt the request — we want the user to
 * resend after the active turn finishes.
 */
const BUSY_SYSTEM_PROMPT =
  "You are a friendly assistant currently working on a previous task for the user. The user has just sent a NEW message but you cannot address it yet — another task is still running. Reply briefly (1-2 short sentences) acknowledging their new message and politely asking them to wait. Do NOT attempt to answer their question, perform any action, or speculate about an answer. Just say you're busy and will get to it. Be warm and natural. Write plain conversational text only — no Markdown, no formatting markup of any kind (your reply is delivered verbatim to a phone chat)."

/**
 * Cap how long we wait for the local model to produce the decline.
 * If the model is slow (cold start, big quant), bail and use the
 * fallback so the user isn't left hanging.
 */
const BUSY_REPLY_TIMEOUT_MS = 8000

/**
 * Telegram bot API limits file downloads to 20 MB. Anything larger
 * fails at getFile() with a 400. We surface a friendly message and
 * leave the message untouched so the user can resend a smaller copy.
 */
const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024

/**
 * Telegram bot API limits uploads to 50 MB. This is a TELEGRAM constraint, so
 * it lives here rather than in the send_file tool, where it used to apply to
 * the in-app chat and the CLI as well — neither of which uploads anything.
 * Video gets a compression pass at the same number (sendVideoFile); every
 * other type is refused with its path, since re-encoding a PDF is not a thing.
 */
const TELEGRAM_UPLOAD_LIMIT = 50 * 1024 * 1024

/**
 * Telegram clears the "typing…" indicator ~5s after the last
 * sendChatAction. Re-fire every 4s while a turn is live so the
 * indicator stays visible the whole time agent.respond is working,
 * not just for the first burst.
 */
const TYPING_HEARTBEAT_MS = 4000

/**
 * Min gap between live in-app mirror snapshots of an in-flight turn. Each
 * snapshot carries the whole in-progress assistant message, so we coalesce
 * bursts of segments (a fast text stream) into at most one broadcast per
 * window while a trailing timer guarantees the last state still lands. The
 * end-of-turn drain always emits one final, un-throttled snapshot. 500ms
 * matches the renderer's own 250ms sync debounce — live enough to feel like
 * Telegram, cheap enough not to re-render the feed on every token.
 */
const MIRROR_THROTTLE_MS = 500

// Startup/reconnect backoff. grammY's long-poll loop retries network
// blips on its own once it's running, so this only covers the launch
// handshake (bot.init / getMe), which is a one-shot that throws on a
// cold-boot network race. We retry that with capped exponential backoff
// + jitter so the channel resolves to `running` on its own instead of
// landing in a terminal error the user has to clear by re-saving.
//
// The cap is deliberately short (10s, not 30s): right after a reboot the
// network can take a while to come up, and a 30s gap meant the channel
// could sit in "starting" for minutes before catching connectivity. A
// 10s steady cadence catches the network within ~10s of it returning.
// Network failures retry FOREVER (see handleLaunchFailure) — the max
// attempt count only bounds rate-limit retries.
const RECONNECT_INITIAL_MS = 2000
const RECONNECT_MAX_MS = 10000
const RECONNECT_FACTOR = 1.8
const RECONNECT_JITTER = 0.25
const RECONNECT_MAX_ATTEMPTS = 12

// Hard ceiling on the launch handshake. grammY's API client has a very
// long default request timeout (~500s), so a getMe that hangs on a
// half-open connection (network up, no real route — common mid-reboot)
// could stall the whole retry loop for minutes. Racing bot.init() against
// this turns a hang into a normal transient failure that retries on the
// 10s cadence instead of waiting out the underlying socket timeout.
const LAUNCH_TIMEOUT_MS = 20000

type ChannelStatus = 'stopped' | 'starting' | 'running' | 'error'

export type TelegramChannelStatus = {
  status: ChannelStatus
  errorKind: TelegramErrorKind | null
  error: string | null
  /** Connected bot's @username, available once running. Null otherwise. */
  botUsername: string | null
  /** Connected bot's display name (first_name), available once running. */
  botName: string | null
}

/**
 * Per-chat state held while a turn is in flight. Lives in memory only;
 * the conversation file on disk is the source of truth for history.
 */
/**
 * In-flight conversation picker raised by /resume or /delete. The whole
 * candidate list is snapshotted here when the picker opens — `page` just
 * windows it — and the next number-only reply selects from it.
 */
type PendingSelection =
  | { command: 'resume' | 'delete'; items: ConversationMeta[]; page: number }
  | { command: 'model'; models: ModelOption[] }
  | { command: 'project'; projects: Project[] }

/**
 * One parked message for this chat. Carries the grammY context it arrived on
 * purely for `ctx.api` (typing indicators + the download URL builder) — that
 * handle is the long-lived Bot api, so a context outliving its own handler is
 * safe to reuse here. The payload itself (text, already-downloaded
 * attachments, voice flags) is exactly what dispatchTurn takes.
 */
type QueuedTelegramMessage = QueuedMessageBase & {
  userId: number
  ctx: BotContext
}

/**
 * How long a queue flush waits for the chat to come free before giving up on
 * the head message.
 *
 * Both callers are cases where the wait is expected to resolve almost
 * immediately: the end-of-turn cleanup that frees the slot (the budget covers
 * only the runner lane's own tail settling), and an enqueue that found no
 * running turn of ours. A message parked behind OUR OWN running turn does not
 * start a flush at all — see enqueueMessage — so this budget is never asked to
 * cover the length of a turn.
 */
const QUEUE_FLUSH_WAIT_MS = 30_000
const QUEUE_FLUSH_POLL_MS = 50
/** Consecutive failed starts of the SAME head message before we tell the user. */
const QUEUE_FLUSH_ATTEMPTS = 3

type ActiveTurn = {
  chatId: number
  /**
   * The owning turn's id. Sink callbacks and the end-of-turn cleanup verify
   * it before touching this state — a late event from an aborted turn on
   * the same chat must never write into (or tear down) its successor's turn.
   */
  turnId: string
  conversation: ConversationFile
  /**
   * Pending text we haven't sent to Telegram yet — drained and
   * cleared by flushBufferedText on each tool call and at turn_end.
   * Keeps the message ordering tight: prose, tool, prose, tool.
   */
  textBuffer: string
  /**
   * Channel-format notices parked for the agent loop — one per flushed
   * prose block that failed validateTelegramHtml AFTER it was already
   * delivered (delivery always wins; observe-and-notify, never rewrite).
   * Drained by the formatNotices pull the runner threads to the agent
   * (ridden on the volatile runtime tail); leftovers at turn end carry
   * over to pendingFormatNotices so the NEXT turn still hears about a
   * leak in the final prose block.
   */
  formatNotices: string[]
  /**
   * Last seen workflow snapshot per run (workflow mode). renderSegment
   * diffs the incoming snapshot against this to derive phase-transition
   * and per-agent progress messages deterministically.
   */
  workflowState: Map<string, WorkflowSnapshot>
  /**
   * Full prose the model produced this turn — accumulated alongside
   * textBuffer but NEVER cleared. Used to derive the assistant
   * message's `content` field at save time. Master-only: legacy worker
   * narration stays in `segments` (worker-tagged), never here.
   */
  assistantContent: string
  /**
   * Every segment emitted during the turn, in order. Persisted
   * verbatim on the assistant message so the in-app history can
   * replay the full sequence (text, tool calls, tool results,
   * active_model chips, turn_end) — same fidelity the Electron
   * channel saves.
   */
  segments: Segment[]
  /**
   * All approvals raised this turn, keyed by approvalId. Filled
   * in when amygdala fires the bridge; the decision is back-filled
   * once the user sends /approve or /deny. Pending approvals at
   * turn end are recorded as denied (they never got a reply).
   */
  approvals: Map<string, PersistedApproval>
  /**
   * Per-tool-call timing. Start recorded on the tool_call segment,
   * end recorded on the matching tool_result. Used by the in-app
   * tool card to show "ran for Xms".
   */
  toolTimings: Map<string, PersistedToolTiming>
  /** Captured from the turn_end segment so the renderer can show the right footer chip. */
  stopReason: SegmentTurnEndReason | null
  /**
   * Stable identity for THIS turn's assistant message, minted once at
   * onTurnStarted. The live in-app mirror snapshots and the single
   * end-of-turn disk save both carry this id + timestamp, so the renderer
   * treats them as one growing message (reconciled by id) instead of
   * appending a duplicate when the file finally lands.
   */
  assistantMessageId: string
  assistantTimestamp: number
  /**
   * The prompt this turn is answering, carried on every mirror snapshot. It is
   * already on disk here — but the phone does not re-read a conversation body
   * while a turn writes into it, so this is the only copy that reaches a phone
   * watching the run before it ends.
   */
  userMessage: ConversationMessage
  /** Wall-clock of the last mirror snapshot emitted — backs the throttle. */
  lastMirrorAt: number
  /** Trailing-edge throttle timer for the mirror; cleared at end-of-turn. */
  mirrorTimer: NodeJS.Timeout | null
  taskId: string | null
  controller: AbortController
  pendingApprovalId: string | null
  /** Resolves the approval Promise once the user replies. */
  pendingApprovalResolve: ((decision: ApprovalDecision) => void) | null
  /**
   * Outstanding ask_user request, if the agent is paused waiting for the
   * user to answer. Questions are posed one message at a time, in order;
   * each inbound message is interpreted against the CURRENT question: a
   * number in 1–options.length picks that option; any other text becomes
   * "something else" (custom instructions) when allowOther is set. Answers
   * accumulate until every question is answered, then the request resolves
   * with all of them at once.
   */
  pendingAsk: {
    id: string
    questions: AskUserQuestion[]
    current: number
    answers: AskUserAnswer[]
  } | null
  /** Resolves the ask_user Promise once the user answers. */
  pendingAskResolve: ((response: AskUserResponse) => void) | null
  /** Cleared once the assistant message has been pushed to disk. */
  done: Promise<void> | null
  /** setInterval handle for the typing-indicator heartbeat. */
  typingTimer: NodeJS.Timeout | null
  /**
   * Maps tool_call id → tool name so a later tool_result segment
   * (which carries only the id) can render under the same heading
   * the call did. Wiped at end-of-turn with the rest of the
   * active record.
   */
  toolCallNames: Map<string, string>
  /**
   * Each agent iteration emits an active_model chip. We defer sending
   * it until the iteration commits real content (text or a tool call),
   * so iterations that produce nothing — e.g. the silent wrap-up turn
   * after a voice_respond — don't leave a stray chip in the chat.
   * Cleared on flush (chip sent) or at turn_end (chip dropped).
   */
  pendingActiveModel: string | null
  /** Last model name actually sent as a chip — prevents the same
   *  provider name from appearing twice across back-to-back iterations. */
  lastFlushedModel: string | null
  /**
   * Resolved absolute paths of every file already sent this turn. Prevents the
   * same file being transmitted twice when it's reachable from more than one
   * parse point (e.g. a tool_result AND the trailing prose that flushes after
   * it). Turn-scoped, so a legitimate re-send in a later turn isn't suppressed.
   */
  sentFiles: Set<string>
  /**
   * Promise chain that serializes renderSegment calls. Each call
   * chains onto the previous one so concurrent fire-and-forget
   * invocations execute in arrival order — prevents text segments
   * from interleaving when an earlier segment yields at an await.
   */
  renderChain: Promise<void>
  /**
   * Resolved once at turn start from TelegramConfig.verbose. When false
   * (the default), renderSegment relays only agent messages, file-bearing
   * tool results, and errors — every other tool call/result/activity send
   * is skipped. Persistence and ordering are unaffected; this gates the
   * outbound send only.
   */
  verbose: boolean
  /**
   * Set once the turn's voice_respond reply has been sent. A turn delivers at
   * most ONE voice memo reply — if the model responds, then redoes the reply,
   * the duplicate is suppressed. voice_generate assets are unaffected.
   */
  voiceReplySent: boolean
  /**
   * Per-turn tokenomics accumulator. Fed every relayed turn event and folded
   * into the conversation's persisted `stats` at end-of-turn so the in-app
   * context-meter card restores real numbers for this Telegram conversation
   * instead of a blank gauge. See {@link TurnStatsCollector}.
   */
  stats: TurnStatsCollector
}

/**
 * The Telegram channel. Mirrors what ElectronChannel does, but for the
 * Telegram surface:
 *
 *  - bot lifecycle (start / stop / restart on config change),
 *  - long-poll updates via grammY,
 *  - chat-id → conversation-id mapping (resumes prior conversations),
 *  - per-chat active turn (cancel / approval / stream buffer),
 *  - segment-to-message rendering (text accumulated, tool calls and
 *    results emitted as their own messages, final assistant text sent
 *    at onDone in 4096-byte chunks),
 *  - approval flow via /approve and /deny slash commands,
 *  - cancellation via /stop, fresh-start via /new.
 *
 * The channel is intentionally a no-op when telegram.enabled is false:
 * no bot instance, no listeners, nothing imported from grammY at
 * runtime beyond the type definitions. start()/stop() are idempotent
 * so the settings panel can flip them freely.
 */
export class TelegramChannel {
  private bot: Bot | null = null
  /**
   * The currently-running bot's token. Stored so media handlers can
   * build the download URL — grammY exposes file paths but not the
   * full https://api.telegram.org/file/bot<TOKEN>/<path> URL.
   */
  private botToken: string | null = null
  private allowedUserIds = new Set<number>()
  private status: ChannelStatus = 'stopped'
  private statusError: string | null = null
  private statusErrorKind: TelegramErrorKind | null = null
  /**
   * The token start() was last asked to bring up. Held so a backoff
   * retry (after a cold-boot network failure) can relaunch without the
   * caller re-invoking start(). Cleared by stop().
   */
  private desiredToken: string | null = null
  private reconnectAttempt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private readonly activeByChat = new Map<number, ActiveTurn>()
  /**
   * Channel-format notices whose turn ended before the agent loop could
   * drain them (a leak in the FINAL prose block has no next iteration).
   * Keyed by chat; merged into the next turn's first drain so the model
   * still hears what reached the user's phone and can repair it with
   * telegram_edit_message. In-memory only — a restart drops them, which
   * is fine: the notice is a correction aid, not a delivery record.
   */
  private readonly pendingFormatNotices = new Map<number, string[]>()
  /**
   * Messages that arrived while this chat's turn was still running. They are
   * accepted and dispatched in order as the chat frees up — see
   * channels/message-queue.ts. Drained by flushQueue from the same end-of-turn
   * cleanup that releases the per-chat slot.
   */
  private readonly queue = new ChannelMessageQueue<number, QueuedTelegramMessage>()
  /**
   * Chats whose flush loop is already running. The loop is fired from
   * end-of-turn cleanup AND from enqueue (covering the race where a turn
   * finishes between the busy check and the park), so it has to be idempotent.
   */
  private readonly flushingByChat = new Set<number>()
  /**
   * Live copy of QUEUE_FLUSH_WAIT_MS. Instance state purely so tests can
   * shorten it (see setQueueFlushWait) — a budget that only expires after 30s
   * is otherwise unreachable in a test suite, which is exactly how the
   * enqueue-fires-a-doomed-wait bug shipped.
   */
  private queueFlushWaitMs = QUEUE_FLUSH_WAIT_MS
  /**
   * Sender context for every message this channel handed to a RUNNING turn
   * (runner.interject), keyed by the interjection's messageId. The runner's
   * lifecycle events carry the conversation and the message, not the chat —
   * and a re-dispatch after a turn-ended sweep needs the Telegram user id and
   * grammY context the original arrival had. Entries leave on the terminal
   * event (delivered or withdrawn) and on stop().
   */
  private readonly interjectedByMessageId = new Map<
    string,
    { chatId: number; userId: number; ctx: BotContext }
  >()
  /** Unsubscribe for the runner's interjection events; null while stopped. */
  private offInterjection: (() => void) | null = null
  /**
   * Tracks pickers in progress per chat. /resume and /delete render
   * a numbered list and store the corresponding conversation ids
   * here; the next number-only reply from that chat resolves the
   * picker. Any other reply implicitly cancels it.
   */
  private readonly pendingSelections = new Map<number, PendingSelection>()
  /**
   * Per-chat typing heartbeats covering pre-turn processing — the
   * window between a Telegram update arriving and dispatchTurn's own
   * heartbeat taking over. Covers downloads, transcription, validation,
   * conversation lookup. Handed off in onTurnStarted; otherwise cleared
   * by the handler's finally so an early return never leaks the bubble.
   */
  private readonly preTypingByChat = new Map<number, NodeJS.Timeout>()
  /**
   * Wired by index.ts to a renderer broadcast. When set, in-flight turns push
   * live assistant-message snapshots so an in-app viewer of the same
   * conversation mirrors the run as it streams — not only at end-of-turn.
   */
  private mirrorListener: MirrorMessageListener | null = null

  constructor(
    private readonly agent: Agent,
    private readonly runner: TurnRunner,
    /**
     * Used for the "I'm busy" decline replies when a new message
     * arrives while another Telegram turn is in flight. Going through
     * the full agent.respond pipeline would either queue the decline
     * (defeats the point) or interrupt the active turn (worse). The
     * local provider can answer instantly without touching shared
     * agent state.
     */
    private readonly localProvider: LocalProvider
  ) {}

  /**
   * Wire the live in-app mirror. index.ts points this at a renderer
   * broadcast so an open conversation reflects a Telegram run as it streams.
   */
  setMessageMirror(listener: MirrorMessageListener | null): void {
    this.mirrorListener = listener
  }

  /** Override the queue-flush wait budget (tests use a short value). */
  setQueueFlushWait(ms: number): void {
    this.queueFlushWaitMs = ms
  }

  /**
   * Emit a live snapshot of the in-flight turn's assistant message, throttled
   * so a fast text stream doesn't broadcast (and re-render the in-app feed) on
   * every token. Builds the same message the end-of-turn save persists — same
   * stable id — so the renderer upserts by id and never duplicates it. A no-op
   * when no mirror is wired, the turn produced nothing yet, or `turnId` is no
   * longer the live turn for this chat (a late render from an aborted turn).
   */
  private scheduleMirror(chatId: number, turnId: string): void {
    if (!this.mirrorListener) return
    const active = this.activeByChat.get(chatId)
    if (!active || active.turnId !== turnId) return
    const conversationId = active.conversation.id
    const emit = (): void => {
      const current = this.activeByChat.get(chatId)
      if (!current || current.turnId !== turnId || !this.mirrorListener) return
      const message = buildAssistantMessage(current)
      if (!message) return
      current.lastMirrorAt = Date.now()
      this.mirrorListener(conversationId, message, current.userMessage)
    }
    const sinceLast = Date.now() - active.lastMirrorAt
    if (sinceLast >= MIRROR_THROTTLE_MS) {
      if (active.mirrorTimer) {
        clearTimeout(active.mirrorTimer)
        active.mirrorTimer = null
      }
      emit()
      return
    }
    // Inside the window: a trailing timer guarantees the latest state lands.
    if (active.mirrorTimer) return
    active.mirrorTimer = setTimeout(() => {
      const current = this.activeByChat.get(chatId)
      if (current) current.mirrorTimer = null
      emit()
    }, MIRROR_THROTTLE_MS - sinceLast)
    active.mirrorTimer.unref?.()
  }

  /**
   * Start the bot with the given config. Idempotent — already-running
   * with the same token is a no-op; same-token "start" while starting
   * just waits. Returns the final state on completion.
   */
  async start(config: TelegramConfig): Promise<TelegramChannelStatus> {
    if (!config.enabled) {
      return this.getStatus()
    }
    // Trim defensively. Tokens copied from BotFather sometimes carry
    // trailing whitespace or zero-width chars that grammY passes
    // straight through to the URL, producing a 404 from getMe.
    const trimmedToken = config.botToken.trim()
    if (!trimmedToken) {
      this.setStatusError('missing_token', null)
      return this.getStatus()
    }
    if (!isPlausibleBotToken(trimmedToken)) {
      this.setStatusError('token_format', null)
      return this.getStatus()
    }
    if (this.status === 'running' || this.status === 'starting') {
      return this.getStatus()
    }

    this.allowedUserIds = new Set(config.allowedUserIds)
    this.desiredToken = trimmedToken
    this.reconnectAttempt = 0
    this.statusError = null
    this.statusErrorKind = null
    this.setStatus('starting')
    this.watchInterjections()

    await this.launch()
    return this.getStatus()
  }

  /**
   * Bring the bot up for the current `desiredToken`. Split out of start()
   * so a backoff retry can relaunch after a transient cold-boot failure
   * without the caller re-invoking start(). On a network/rate-limit
   * failure during the handshake it schedules a retry and stays in
   * `starting` (no scary error text); a terminal failure (bad token)
   * lands in `error`. Every successful launch ends in `running` and
   * pushes a status change so the settings panel resolves on its own —
   * the user never has to hit Save to nudge it.
   */
  private async launch(): Promise<void> {
    const token = this.desiredToken
    if (!token) return

    const bot = new Bot(token)
    bot.on('message:text', (ctx) => void this.handleTextMessage(ctx))
    // Voice messages get their own path: Telegram's press-and-hold
    // mic recording is handled as if the user typed the transcript.
    // Other media (photos, video, audio files, documents) keep the
    // existing attach-and-dispatch flow.
    bot.on('message:voice', (ctx) => void this.handleVoiceMessage(ctx))
    bot.on(
      ['message:photo', 'message:video', 'message:audio', 'message:document'],
      (ctx) => void this.handleMediaMessage(ctx)
    )
    bot.catch((err) => {
      const kind = classifyBotError(err.error)
      const message = err.error instanceof Error ? err.error.message : String(err.error)
      this.agent.corpus.emit('telegram.error', { kind, message })
    })

    try {
      // bot.init() validates the token by fetching the bot's own
      // identity. A bad token throws here; we surface the failure
      // without ever starting the long-poll loop. Bounded by
      // LAUNCH_TIMEOUT_MS so a hung getMe (network up, no route) becomes a
      // normal transient retry instead of a multi-minute stall.
      await withTimeout(bot.init(), LAUNCH_TIMEOUT_MS)
    } catch (err) {
      // A stop()/reconfigure that landed while we were awaiting wins —
      // drop this dead bot instead of resurrecting the channel.
      if (this.desiredToken !== token) {
        await bot.stop().catch(() => undefined)
        return
      }
      this.handleLaunchFailure(err)
      return
    }

    // Superseded mid-handshake (stop or a new token): abandon quietly.
    if (this.desiredToken !== token) {
      await bot.stop().catch(() => undefined)
      return
    }

    this.bot = bot
    this.botToken = token

    // Publish the slash command menu so Telegram clients show the
    // available commands in the chat's command picker. Fire-and-forget and
    // non-fatal: it must never delay (or block) reaching `running`, and on
    // older bot servers or a slow network it just no-ops — the commands
    // still work as plain text, only the discoverability hint is missing.
    void bot.api
      .setMyCommands([
        { command: 'new', description: 'Start a fresh conversation' },
        { command: 'current', description: 'Current conversation' },
        { command: 'resume', description: 'Pick a conversation to resume' },
        { command: 'delete', description: 'Pick a conversation to delete' },
        { command: 'clear', description: 'Clear all messages' },
        { command: 'stop', description: 'Stop the current task' },
        { command: 'cancel', description: 'Drop queued messages' },
        { command: 'approve', description: 'Approve a pending action' },
        { command: 'deny', description: 'Deny a pending action' },
        { command: 'status', description: 'Wolffish current status' },
        { command: 'mode', description: 'Set single or workflow mode' },
        { command: 'model', description: 'Pick the cloud model' },
        { command: 'local', description: 'Switch to local model' },
        { command: 'cloud', description: 'Switch to cloud model' }
      ])
      .catch(() => undefined)

    // Hydrate the persisted message-id tracker so /clear can delete
    // messages from previous sessions. Best-effort — a missing or
    // corrupt file just leaves the tracker empty.
    await loadMessageIds()

    // Register the channel's tool surface with the cerebellum so the
    // LLM can use telegram_send proactively — e.g. notifying the user
    // when a long-running task finishes. Re-registration is idempotent;
    // calling start() after a config change just rewires references.
    const { capability, plugin } = buildTelegramCapability({
      getBot: () => this.bot,
      getAllowedUserIds: () => this.allowedUserIds,
      trackOutgoing: (cid, mid) => this.trackMessageId(cid, mid),
      bindChatToSendingConversation: (cid) => this.bindChatToSendingConversation(cid),
      ensureFfmpeg: () => this.agent.cerebellum.ensureSystemTool('ffmpeg')
    })
    this.agent.cerebellum.registerInProcessCapability(capability, plugin)

    // Long-poll loop. drop_pending_updates so a freshly enabled bot
    // doesn't replay weeks of old messages on first launch. grammY
    // retries transient network errors inside the loop on its own, so a
    // rejection here means the loop stopped for good — relaunch on a
    // transient kind, surface anything terminal. Guard on identity so a
    // late rejection from a bot we've already replaced/stopped is ignored.
    void bot.start({ drop_pending_updates: true }).catch((err) => {
      if (this.bot !== bot) return
      this.bot = null
      this.handleLaunchFailure(err)
    })

    this.reconnectAttempt = 0
    this.statusError = null
    this.statusErrorKind = null
    this.setStatus('running')
    this.agent.corpus.emit('telegram.started', {
      allowedUserCount: this.allowedUserIds.size
    })
  }

  /**
   * Shared failure path for the launch handshake and the long-poll loop.
   * Transient kinds retry with capped backoff while staying in `starting`
   * (the panel shows a calm pulsing dot, not a red error); everything else
   * is terminal. Network failures — including a timed-out handshake — retry
   * FOREVER so the channel always heals itself once connectivity returns,
   * instead of giving up and forcing the user to re-save. Rate limits stay
   * bounded since hammering past a 429 is counterproductive.
   */
  private handleLaunchFailure(err: unknown): void {
    // Superseded by a stop()/reconfigure — the channel no longer wants
    // this token up, so don't retry or paint an error.
    if (this.desiredToken === null) return
    // A timed-out handshake is a connectivity problem, not a bad token.
    const corpusKind = err instanceof LaunchTimeoutError ? 'network' : classifyBotError(err)
    const rawMessage = err instanceof Error ? err.message : String(err)

    const keepTrying =
      corpusKind === 'network' ||
      (corpusKind === 'rate_limit' && this.reconnectAttempt < RECONNECT_MAX_ATTEMPTS)
    if (keepTrying) {
      // Only touch state / emit when something actually changes — during a
      // long outage we'd otherwise push an identical "starting" every 10s
      // and flood the corpus log. The first failure (or a transition out of
      // an error) updates; subsequent retries just reschedule silently.
      if (this.status !== 'starting' || this.statusError !== null) {
        this.statusError = null
        this.statusErrorKind = null
        this.setStatus('starting')
      }
      this.scheduleReconnect()
      return
    }
    // Terminal. Log it and map the corpus taxonomy onto the user-facing
    // kind the panel renders (`token` → `invalid_token`, etc.).
    this.agent.corpus.emit('telegram.error', { kind: corpusKind, message: rawMessage })
    this.setStatusError(mapBotErrorKind(corpusKind), rawMessage)
  }

  /** Schedule a relaunch with capped exponential backoff + jitter. */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    const base = RECONNECT_INITIAL_MS * Math.pow(RECONNECT_FACTOR, this.reconnectAttempt)
    const capped = Math.min(base, RECONNECT_MAX_MS)
    const jitter = capped * RECONNECT_JITTER * (Math.random() * 2 - 1)
    const delayMs = Math.max(0, capped + jitter)
    this.reconnectAttempt++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.launch()
    }, delayMs)
  }

  /** Stop the bot. Idempotent. */
  async stop(reason?: string): Promise<void> {
    // Cancel any pending backoff retry and forget the desired token first
    // so an in-flight launch() or a timer that fires after us no-ops
    // instead of resurrecting the channel.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempt = 0
    this.desiredToken = null

    this.unwatchInterjections()
    if (!this.bot) {
      this.activeByChat.clear()
      this.pendingSelections.clear()
      for (const timer of this.preTypingByChat.values()) clearInterval(timer)
      this.preTypingByChat.clear()
      this.statusError = null
      this.statusErrorKind = null
      this.setStatus('stopped')
      return
    }
    try {
      await this.bot.stop()
    } catch {
      // best-effort; if the stop call itself errors we still want the
      // local state to reflect that the bot is no longer accepting
      // updates. Anything stuck inside grammY is the SDK's problem.
    }
    this.bot = null
    this.botToken = null
    this.activeByChat.clear()
    // A stopped bot must not resurrect a queue on the next start — the parked
    // messages are still sitting in the user's phone chat if they want them.
    this.queue.clearAll()
    this.flushingByChat.clear()
    this.pendingSelections.clear()
    // Tear down any in-flight pre-turn typing heartbeats — if a
    // handler was mid-download when stop() came in, its finally won't
    // run before the process exits.
    for (const timer of this.preTypingByChat.values()) clearInterval(timer)
    this.preTypingByChat.clear()
    // Flush any pending tracker writes to disk. Don't clear the
    // in-memory cache — message ids are persistent across bot
    // stop/start so /clear can sweep prior sessions.
    await flushMessageIds()
    this.statusError = null
    this.statusErrorKind = null
    this.setStatus('stopped')
    // Take the channel's tools out of the LLM's surface so it doesn't
    // see capabilities it can no longer execute. Idempotent.
    this.agent.cerebellum.unregisterInProcessCapability(TELEGRAM_CAPABILITY_NAME)
    this.agent.corpus.emit('telegram.stopped', reason ? { reason } : {})
  }

  async restart(config: TelegramConfig): Promise<TelegramChannelStatus> {
    await this.stop('restart')
    return this.start(config)
  }

  /**
   * Send a one-off test message without taking over the long-poll
   * loop. Used by the settings panel to verify a token+chat-id pair
   * before the user enables the channel for real.
   *
   * The sent message is recorded in the persistent tracker so a later
   * /clear sweeps it alongside real-conversation messages — otherwise
   * test messages pile up in the user's chat with no way to remove them.
   */
  async sendTestMessage(token: string, userId: number): Promise<TelegramTestResult> {
    const trimmed = (token ?? '').trim()
    if (!trimmed) return { ok: false, kind: 'missing_token' }
    if (!Number.isFinite(userId)) return { ok: false, kind: 'invalid_user_id' }
    if (!isPlausibleBotToken(trimmed)) return { ok: false, kind: 'token_format' }
    const tempBot = new Bot(trimmed)
    try {
      await tempBot.init()
      const sent = await tempBot.api.sendMessage(userId, 'Wolffish Telegram channel is working ✅')
      // Hydrate the tracker if start() hasn't run yet — sendTestMessage
      // commonly fires before the channel is enabled. Then record and
      // flush synchronously so the id survives an app quit before the
      // user ever starts the bot.
      await loadMessageIds()
      this.trackMessageId(userId, sent.message_id)
      await flushMessageIds()
      return { ok: true }
    } catch (err) {
      const corpusKind = classifyBotError(err)
      const raw = err instanceof Error ? err.message : String(err)
      return { ok: false, kind: mapBotErrorKind(corpusKind), message: raw }
    }
  }

  getStatus(): TelegramChannelStatus {
    // botInfo is populated by bot.init(); this.bot is only assigned after
    // that handshake succeeds, so reading it here can never throw the
    // "call bot.init() first" getter error. Null whenever not running.
    const info = this.bot?.botInfo
    return {
      status: this.status,
      errorKind: this.statusErrorKind,
      error: this.statusError,
      botUsername: info?.username ?? null,
      botName: info?.first_name ?? null
    }
  }

  /**
   * Single chokepoint for status transitions. Updates the field and
   * pushes a `telegram.statusChanged` event so the settings panel (which
   * subscribes via IPC) reflects the new state live — without it, the
   * panel only learns the status on mount or after a manual Save, which
   * is exactly why a freshly-started bot used to read "starting" forever.
   */
  private setStatus(next: ChannelStatus): void {
    this.status = next
    this.agent.corpus.emit('telegram.statusChanged', {})
  }

  /**
   * Centralizes the "I'm in an error state" transition. Records the
   * discriminated kind (so the renderer can translate) and the raw
   * message (used as a fallback when the kind is `unknown`), then flips
   * to `error` through setStatus so the change is pushed to the panel.
   */
  private setStatusError(kind: TelegramErrorKind, message: string | null): void {
    this.statusErrorKind = kind
    this.statusError = message
    this.setStatus('error')
  }

  hasActiveTurn(): boolean {
    return this.activeByChat.size > 0
  }

  /**
   * Start a typing heartbeat for the pre-turn window. Idempotent per
   * chat — repeat calls keep the existing timer. A single
   * sendChatAction expires after ~5s in Telegram, so anything that
   * could outlast that (downloads, transcription, validation, conv
   * lookup) needs the periodic re-fire to keep the bubble lit. The
   * matching stopPreTyping must run on every exit path, including
   * errors and busy-replies, or the bubble persists past the work.
   */
  private startPreTyping(chatId: number, ctx: BotContext): void {
    if (this.preTypingByChat.has(chatId)) return
    void ctx.api.sendChatAction(chatId, 'typing').catch(() => undefined)
    const timer = setInterval(() => {
      void ctx.api.sendChatAction(chatId, 'typing').catch(() => undefined)
    }, TYPING_HEARTBEAT_MS)
    timer.unref?.()
    this.preTypingByChat.set(chatId, timer)
  }

  private stopPreTyping(chatId: number): void {
    const timer = this.preTypingByChat.get(chatId)
    if (!timer) return
    clearInterval(timer)
    this.preTypingByChat.delete(chatId)
  }

  abort(): void {
    for (const turn of this.activeByChat.values()) {
      turn.controller.abort()
    }
    this.activeByChat.clear()
    // App-wide abort (quit/shutdown) — dropping the queue here is what keeps a
    // flush from starting a fresh turn on the way out.
    this.queue.clearAll()
    this.flushingByChat.clear()
  }

  private async handleTextMessage(ctx: BotContext): Promise<void> {
    const userId = ctx.from?.id
    const chatId = ctx.chat?.id
    const text = ctx.message?.text
    if (!userId || !chatId || !text) return

    // Silent ignore for non-allowed users. No reply, no acknowledgment,
    // nothing the attacker can use to fingerprint the bot.
    if (!this.allowedUserIds.has(userId)) return

    // Track the incoming id so /clear can delete it later.
    if (ctx.message?.message_id) {
      this.trackMessageId(chatId, ctx.message.message_id)
    }

    const trimmed = text.trim()
    const lower = trimmed.toLowerCase()
    const command = parseSlashCommand(lower)

    const active = this.activeByChat.get(chatId)

    // /status — read-only introspection. Doesn't touch the agent
    // pipeline, so it works whether or not a turn is running. Useful
    // for a worried user who wants to know "is the bot stuck?" while
    // a long task is mid-flight.
    if (command === STATUS_COMMAND) {
      await this.handleStatusCommand(chatId)
      return
    }

    // /current — read-only too. Reports which conversation this
    // chat is currently bound to, in the same one-row layout the
    // /resume picker uses for each item.
    if (command === CURRENT_COMMAND) {
      await this.handleCurrentCommand(chatId)
      return
    }

    // /local and /cloud — flip the same llm.localOnly setting the
    // chat input's mode switch toggles. Busy-blocked for the same
    // reason the renderer disables the toggle mid-stream: switching
    // mid-turn would leave the in-flight stream running on the old
    // provider while the user thinks the next message is from the new
    // one. Caller can /stop first if they want to switch immediately.
    if (command === LOCAL_COMMAND || command === CLOUD_COMMAND) {
      if (this.activeByChat.size > 0) {
        await this.sendBusyReply(chatId, trimmed)
        return
      }
      await this.handleLocalCloudCommand(chatId, command === LOCAL_COMMAND)
      return
    }

    // /mode — set single vs workflow (the global chat mode). Bare `/mode`
    // reports the current mode; `/mode single` / `/mode workflow` set it.
    // Setting is busy-blocked inside the handler (mode is global, like the
    // Brain); reading is always allowed.
    if (command === MODE_COMMAND) {
      await this.handleModeCommand(chatId, commandArg(trimmed), trimmed)
      return
    }

    // /model — list connected cloud models and switch the Brain. Bare
    // `/model` lists (read-only, allowed even mid-turn); `/model <query>`
    // filters and, on a single match, switches directly. Selecting is
    // busy-blocked inside the handler.
    if (command === MODEL_COMMAND) {
      await this.handleModelCommand(chatId, commandArg(trimmed), trimmed)
      return
    }

    // /project — show the active project and a numbered picker; "/project
    // close" leaves it. Listing is read-only and allowed mid-turn (like
    // /model); selecting and exiting rotate the chat to a FRESH conversation
    // (the project binding lives on the conversation itself), so those paths
    // are busy-blocked inside the handler exactly like /new.
    if (command === PROJECT_COMMAND) {
      await this.handleProjectCommand(chatId, commandArg(trimmed), trimmed)
      return
    }

    // /clear — wipe the visible chat in Telegram. Touches nothing
    // Wolffish-side: the conversation file, mapping, and history
    // all stay intact. Busy-blocked because deleting messages
    // mid-turn while the agent is still sending creates a race
    // (deletes happen, agent sends new messages, those orphans
    // pile up). Caller can /stop first if they want to clear
    // mid-task.
    if (command === CLEAR_COMMAND) {
      if (this.activeByChat.has(chatId)) {
        await this.sendBusyReply(chatId, trimmed)
        return
      }
      await this.handleClearCommand(chatId, ctx.message?.message_id ?? 0)
      return
    }

    // /cancel — take back everything this chat sent that has not been read
    // yet: interjections still pending on the running turn, then the sliver
    // queue. Works mid-turn (that is the only time either exists), touches
    // the running turn not at all, and is never itself queued.
    if (command === CANCEL_COMMAND) {
      // A pending turn-end countdown (a restart the last reply armed) is the
      // other thing the phone user may need to stop from here — the card's
      // Abort button lives in the app, not in this chat.
      const countdown = await countdowns.abortPending('user')
      if (countdown) {
        await this.sendPlain(chatId, `Aborted: ${countdown.label}.`)
        return
      }
      const dropped = await this.dropUnread(chatId)
      await this.sendPlain(
        chatId,
        dropped > 0 ? queueClearedText(dropped) : queueEmptyText(this.activeByChat.has(chatId))
      )
      return
    }

    // /stop — only meaningful while a turn is running, and only resolves
    // the turn for the chat that issued it. Comes before the busy-check
    // below so a user trying to halt a stuck turn isn't told "I'm busy".
    // The queue deliberately SURVIVES a stop (the in-app queue does too:
    // stopping advances it rather than dropping it) — the trailing note
    // makes that visible, and /cancel is the way out.
    if (command && STOP_COMMANDS.has(command)) {
      if (!active) {
        const queued = this.clearQueue(chatId)
        await this.safeSend(
          chatId,
          queued > 0 ? `Nothing to stop. ${queueClearedText(queued)}` : 'Nothing to stop.'
        )
        return
      }
      active.controller.abort()
      if (active.taskId) {
        // Scope the stop to the target turn: motor.stopTask emits
        // task.stopped synchronously, and a scope-less emit would fan out to
        // every live turn's relay (fail-open), polluting other
        // conversations' timelines.
        await turnScope
          .run(
            { turnId: active.turnId, conversationId: active.conversation.id, autonomous: false },
            () => this.agent.motor.stopTask(active.taskId!)
          )
          .catch(() => undefined)
      }
      // Read the depth NOW, not after the wait below: the cleanup that frees
      // the chat also starts the flush, so by the time we get past the wait
      // the queue has already been popped and the note would read zero.
      const note = queuePendingNote(this.queue.size(chatId))
      await this.safeSend(chatId, '⏹ Stopping…')
      const deadline = Date.now() + 10_000
      while (this.activeByChat.has(chatId) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
      }
      if (this.activeByChat.has(chatId)) {
        await this.safeSend(
          chatId,
          `⏹ Attempted to stop, but the task may still be winding down.${note}`
        )
      } else {
        await this.safeSend(chatId, `⏹ Stopped.${note}`)
      }
      return
    }

    // /approve and /deny — only meaningful when there's a pending
    // approval for this chat. Determinism is the point: a casual "yes"
    // in conversation should never resolve an approval, only the
    // explicit slash command does.
    if (active && active.pendingApprovalId && active.pendingApprovalResolve) {
      if (command === APPROVE_COMMAND || command === DENY_COMMAND) {
        const decision: ApprovalDecision = command === APPROVE_COMMAND ? 'approved' : 'denied'
        const approvalId = active.pendingApprovalId
        const resolve = active.pendingApprovalResolve
        active.pendingApprovalId = null
        active.pendingApprovalResolve = null
        // Back-fill the decision on the persisted record so the
        // saved conversation reflects what the user chose.
        const stored = active.approvals.get(approvalId)
        if (stored) stored.decision = decision
        resolve(decision)
        await this.safeSend(chatId, decision === 'approved' ? '✅ Approved.' : '❌ Denied.')
        return
      }
      // Anything else falls through. The approval stays pending; on
      // turn cleanup it resolves denied so the agent doesn't hang.
      // Falling through means the busy-check below will catch the
      // message and decline politely.
    }

    // /new, /resume, /delete all require a clean slate — they touch
    // the chat-id → conversation-id mapping and would race a turn
    // that's actively reading from it. Decline if anything is in
    // flight; the user has to /stop or wait first.
    if (command && NEW_COMMANDS.has(command)) {
      if (this.activeByChat.has(chatId)) {
        await this.sendBusyReply(chatId, trimmed)
        return
      }
      await this.handleNewCommand(chatId)
      return
    }
    if (command === RESUME_COMMAND) {
      if (this.activeByChat.has(chatId)) {
        await this.sendBusyReply(chatId, trimmed)
        return
      }
      await this.renderConversationPicker(chatId, 'resume')
      return
    }
    if (command === DELETE_COMMAND) {
      if (this.activeByChat.has(chatId)) {
        await this.sendBusyReply(chatId, trimmed)
        return
      }
      await this.renderConversationPicker(chatId, 'delete')
      return
    }

    // Number-only reply for an outstanding /resume or /delete picker.
    // We check here — after the slash-command handlers but before
    // the busy/dispatch path — so a user typing "1" right after
    // the picker selects a row instead of starting a turn. Anything
    // that isn't a valid number cancels the picker silently and
    // falls through to normal handling.
    const pending = this.pendingSelections.get(chatId)
    if (pending) {
      // `next` pages the conversation picker. This has to sit ahead of the
      // number parse and the cancel fall-through below — otherwise the word
      // reads as "not a selection", silently drops the picker, and gets sent
      // to the model as an ordinary chat turn.
      // `command` rather than `lower` so the group-chat form `/next@botname`
      // works — parseSlashCommand strips the @suffix; it is null for bare text,
      // where `lower` is already the whole word.
      if (
        (pending.command === 'resume' || pending.command === 'delete') &&
        isNextPageReply(command ?? lower)
      ) {
        const page = pending.page + 1
        if (pageExists(pending.items, page)) {
          this.pendingSelections.set(chatId, { ...pending, page })
          await this.sendPickerPage(chatId, pending.command, pending.items, page)
        } else {
          await this.sendPlain(chatId, 'That was the last page — reply with a number to pick one.')
        }
        return
      }
      const num = parseSelectionNumber(trimmed)
      // Only what the user has actually SEEN is selectable — see selectableCount.
      const count =
        pending.command === 'model'
          ? pending.models.length
          : pending.command === 'project'
            ? pending.projects.length
            : selectableCount(pending.items, pending.page)
      if (num !== null && num >= 1 && num <= count) {
        this.pendingSelections.delete(chatId)
        if (pending.command === 'model') {
          await this.applyModelSelection(chatId, pending.models[num - 1], trimmed)
        } else if (pending.command === 'project') {
          await this.applyProjectSelection(chatId, pending.projects[num - 1], trimmed)
        } else if (pending.command === 'resume') {
          await this.handleResumeSelection(chatId, pending.items[num - 1].id)
        } else {
          await this.handleDeleteSelection(chatId, pending.items[num - 1].id)
        }
        return
      }
      // Not a recognized selection — drop the picker and let the
      // message fall through to the normal flow.
      this.pendingSelections.delete(chatId)
    }

    // Outstanding ask_user question for this chat: the user's reply IS the
    // answer. A number in range picks that option; any other text becomes
    // custom instructions ("something else"). Slash commands were handled
    // above, so only genuine answers reach here. Sits before the busy-check
    // so the reply isn't bounced as "I'm busy" while the agent waits on it.
    if (active && active.pendingAsk && active.pendingAskResolve) {
      await this.resolvePendingAsk(chatId, active, trimmed)
      return
    }

    // One turn at a time PER CHAT. Another allowed user's chat (and every
    // other channel, and the in-app renderer) runs its own turn
    // concurrently — the TurnRunner serializes per conversation. A new
    // message while THIS chat is busy is PARKED, not declined: it runs on its
    // own turn the moment this chat frees up, exactly like the in-app
    // composer's queue.
    if (this.activeByChat.has(chatId)) {
      await this.parkMessage(chatId, {
        id: mintMessageId(),
        userId,
        ctx,
        text: trimmed,
        attachments: []
      })
      return
    }

    // Free — dispatch as a new turn.
    await this.dispatchTurn(chatId, userId, trimmed, [], ctx)
  }

  /**
   * Handle the /status slash command. Calls insula.reflect() — same
   * report the introspect capability produces — and ships it as a
   * (potentially multi-message) reply. Long reports get chunked at
   * 4096 bytes by safeSend's caller; we pre-split here so the chunks
   * land in the right order even if a later send queues behind another.
   *
   * Read-only: does not abort or queue against any active turn. The
   * report includes uptime, active provider/model, capabilities,
   * RAM/disk, performance stats, and recent topics — exactly what an
   * Electron user gets from the introspect plugin.
   */
  private async handleStatusCommand(chatId: number): Promise<void> {
    let report: string
    try {
      report = await this.agent.insula.reflect()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.sendPlain(chatId, `⚠️ Couldn't generate status: ${message}`)
      return
    }
    // The insula report is Markdown; nothing downstream converts it
    // anymore, so flatten it to plain text before sending.
    const trimmed = markdownToPlain(report).trim()
    if (trimmed.length === 0) {
      await this.safeSend(chatId, 'No status data available yet.')
      return
    }
    for (const chunk of splitForTelegram(trimmed)) {
      await this.sendPlain(chatId, chunk)
    }
  }

  /**
   * Handle the /current slash command. Reports which conversation
   * this chat is currently bound to, formatted the same way each
   * row in the /resume picker is — title, relative time, message
   * count. Read-only: never creates a conversation, never changes
   * state, works regardless of busy state.
   */
  private async handleCurrentCommand(chatId: number): Promise<void> {
    const currentId = await getConversationIdForChat(chatId)
    if (!currentId) {
      await this.safeSend(chatId, 'No active conversation. Send any message to start one.')
      return
    }
    const conv = await loadConversation(currentId)
    if (!conv) {
      await this.safeSend(chatId, 'No active conversation. Send any message to start one.')
      return
    }
    const title = escapeHtml(conv.title || 'Untitled')
    const when = formatRelativeTime(conv.updatedAt)
    const count = conv.messages.length === 1 ? '1 message' : `${conv.messages.length} messages`
    await this.sendHtml(chatId, `<b>${title}</b>\n${when}\n${count}`)
  }

  /**
   * Handle the /new (or /start) slash command. Caller has already
   * verified no turn is running. Rotates this chat's mapping to a
   * brand-new conversation file; the old conversation stays on disk
   * under its original id, it just stops being the resume target for
   * this chat.
   */
  private async handleNewCommand(chatId: number): Promise<void> {
    this.pendingSelections.delete(chatId)
    // /new inside a project STAYS in the project — the fresh conversation
    // inherits the current one's binding; /project close is the way out.
    const project = await this.activeProjectForChat(chatId)
    const fresh = createConversation(null)
    fresh.channel = 'telegram'
    if (project) fresh.projectId = project.id
    await saveConversation(fresh)
    await setConversationIdForChat(chatId, fresh.id)
    const note = this.dropQueueForRotation(chatId)

    if (project) {
      await this.sendPlain(
        chatId,
        `✨ New conversation started in ${projectLabel(project)}.${note} To leave the project, use /project close.`
      )
      return
    }
    await this.sendHtml(chatId, `✨ New conversation started.${note}\n\n${COMMANDS_HELP_HTML}`)
  }

  /**
   * The project this chat is currently "in" — derived from the bound
   * conversation's own projectId, never from separate channel state, so it
   * survives restarts and can't drift from what turns actually run with.
   * A dangling binding (project deleted in the app) reads as no project.
   */
  private async activeProjectForChat(chatId: number): Promise<Project | null> {
    const currentId = await getConversationIdForChat(chatId)
    if (!currentId) return null
    const current = await loadConversation(currentId)
    if (!current?.projectId) return null
    const projects = await listProjects().catch(() => [] as Project[])
    return projects.find((p) => p.id === current.projectId) ?? null
  }

  private async handleProjectCommand(
    chatId: number,
    arg: string | null,
    raw: string
  ): Promise<void> {
    const active = await this.activeProjectForChat(chatId)

    if (arg && arg.trim().toLowerCase() === 'close') {
      if (this.activeByChat.has(chatId)) {
        await this.sendBusyReply(chatId, raw)
        return
      }
      if (!active) {
        await this.sendPlain(chatId, 'No active project to close.')
        return
      }
      this.pendingSelections.delete(chatId)
      const fresh = createConversation(null)
      fresh.channel = 'telegram'
      await saveConversation(fresh)
      await setConversationIdForChat(chatId, fresh.id)
      await this.sendPlain(
        chatId,
        `Left ${projectLabel(active)}. ✨ Fresh conversation started outside it.${this.dropQueueForRotation(chatId)}`
      )
      return
    }

    const projects = await listProjects().catch(() => [] as Project[])
    if (projects.length === 0) {
      await this.sendPlain(
        chatId,
        'No projects yet — create one from the Projects page in the app.'
      )
      return
    }
    const lines: string[] = []
    lines.push(active ? `Active project: ${projectLabel(active)}` : 'No active project.')
    lines.push('')
    projects.forEach((p, i) => {
      lines.push(`${i + 1}. ${projectLabel(p)}`)
    })
    lines.push('')
    lines.push(
      active
        ? 'Reply with a number to switch (starts a fresh conversation there) — or /project close to leave.'
        : 'Reply with a number to start a conversation in that project.'
    )
    this.pendingSelections.set(chatId, { command: 'project', projects })
    await this.sendPlain(chatId, lines.join('\n'))
  }

  private async applyProjectSelection(
    chatId: number,
    project: Project,
    raw: string
  ): Promise<void> {
    // Selecting rotates the chat to a fresh bound conversation — same
    // mapping mutation as /new, so the same busy gate applies.
    if (this.activeByChat.has(chatId)) {
      await this.sendBusyReply(chatId, raw)
      return
    }
    const fresh = createConversation(null)
    fresh.channel = 'telegram'
    fresh.projectId = project.id
    await saveConversation(fresh)
    await setConversationIdForChat(chatId, fresh.id)
    await this.sendPlain(
      chatId,
      `${project.icon || '📁'} Now in project “${project.title.trim() || 'Untitled'}”.${this.dropQueueForRotation(chatId)} Conversations here start from its instructions and files — /project close to leave.`
    )
  }

  /**
   * Record a Telegram message id so /clear can later delete it.
   * Delegates to the persistent module — IDs survive app restarts
   * so a week of accumulated messages can be cleared even after
   * many launches.
   */
  private trackMessageId(chatId: number, messageId: number): void {
    recordMessageId(chatId, messageId)
  }

  /**
   * Handle /clear — delete the messages we've sent or received in
   * this chat from the Telegram client. Pure UI cleanup; the
   * conversation file, chat-id mapping, episodes, basalganglia
   * feedback, and every other piece of Wolffish state are left
   * untouched. The user can /resume the same conversation right
   * after and pick up where they left off.
   *
   * Uses Telegram's batched `deleteMessages` (plural) — up to 100
   * ids per request, so a typical clear lands in one round trip
   * instead of N. Designed for private bot chats; group-chat 48h
   * limits aren't a concern here. Per-batch errors are swallowed
   * so one bad id doesn't abort the sweep — the rest still go.
   */
  private async handleClearCommand(chatId: number, clearMessageId: number): Promise<void> {
    if (!this.bot) return
    recordMessageId(chatId, clearMessageId)
    const ids = takeMessageIdsForChat(chatId)
    if (ids.length === 0) return
    const BATCH = 100
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH)
      await this.bot.api.deleteMessages(chatId, chunk).catch(() => undefined)
    }
  }

  /**
   * Handle /local and /cloud — flip llm.localOnly via the same code
   * path the chat input's local/cloud switch uses: persist the config,
   * then push the new value into the live thalamus so the next turn's
   * model resolution picks it up. The IPC handler in main does the same
   * two steps; we mirror them here so a Telegram-driven switch and an
   * Electron-driven switch leave the runtime in identical state.
   * (Distinct from /mode, which is single-vs-workflow — see
   * handleModeCommand.)
   */
  private async handleLocalCloudCommand(chatId: number, localOnly: boolean): Promise<void> {
    await persistLocalOnly(localOnly)
    this.agent.thalamus.setLocalOnly(localOnly)
    await this.safeSend(
      chatId,
      localOnly ? '🖥 Switched to local model.' : '☁️ Switched to cloud model.'
    )
  }

  /**
   * Handle /mode — read or set the global chat mode (single vs workflow),
   * mirroring the in-app mode picker's two steps: persist (setMode) + live
   * (agent.setMode). Bare `/mode` reports the current mode. Setting is
   * busy-blocked because mode is global (like the Brain and localOnly) —
   * switching while a turn is in flight would change the next iteration out
   * from under it. `arg` is lower-cased; `raw` is the original text (for the
   * busy reply echo).
   */
  private async handleModeCommand(chatId: number, arg: string, raw: string): Promise<void> {
    const config = await readConfig()
    const current = config?.llm.mode === 'workflow' ? 'workflow' : 'single'
    if (!arg) {
      await this.sendHtml(
        chatId,
        `Mode: <b>${current}</b>\nSwitch with <code>/mode single</code> or <code>/mode workflow</code>.`
      )
      return
    }
    const next = arg === 'workflow' ? 'workflow' : arg === 'single' ? 'single' : null
    if (!next) {
      await this.sendHtml(
        chatId,
        'Usage: <code>/mode single</code> or <code>/mode workflow</code>.'
      )
      return
    }
    if (next === current) {
      await this.safeSend(chatId, `Already in ${current} mode.`)
      return
    }
    if (this.activeByChat.size > 0) {
      await this.sendBusyReply(chatId, raw)
      return
    }
    await persistMode(next)
    this.agent.setMode(next)
    await this.safeSend(chatId, next === 'workflow' ? '🔀 Mode: workflow.' : '💬 Mode: single.')
  }

  /**
   * Handle /model — list connected cloud models and switch the Brain. Bare
   * `/model` lists them numbered (read-only, so allowed even mid-turn) and
   * arms a numbered picker; `/model <query>` filters by substring and, on a
   * single match, switches directly. The switch mirrors the in-app model
   * picker (persist setBrain + live thalamus.setBrain) and also clears
   * localOnly — a deliberately chosen cloud model would otherwise be ignored
   * while local-only mode is on (resolveEntry short-circuits to the local
   * model).
   */
  private async handleModelCommand(chatId: number, query: string, raw: string): Promise<void> {
    const options = collectModelOptions(this.agent.thalamus.getCloudProviders())
    if (options.length === 0) {
      await this.sendHtml(
        chatId,
        'No cloud providers connected. Add an API key in Settings, or use <code>/local</code> for the on-device model.'
      )
      return
    }
    const matches = filterModelOptions(options, query)
    // A query that pins exactly one model switches straight to it.
    if (query && matches.length === 1) {
      await this.applyModelSelection(chatId, matches[0], raw)
      return
    }
    if (matches.length === 0) {
      await this.sendHtml(chatId, `No cloud model matches <b>${escapeHtml(query)}</b>.`)
      return
    }
    const activeProvider = this.agent.thalamus.getActiveProvider()
    const activeModel = this.agent.thalamus.getActiveModel()
    const shown = matches.slice(0, MODEL_LIST_CAP)
    this.pendingSelections.set(chatId, { command: 'model', models: shown })
    const lines = shown.map((o, i) => {
      const current = o.providerId === activeProvider && o.model === activeModel ? ' ✅' : ''
      return `${i + 1}. <b>${escapeHtml(o.providerId)}</b> · ${escapeHtml(o.model)}${current}`
    })
    const header =
      query && matches.length !== options.length
        ? `<b>Models matching “${escapeHtml(query)}”</b> — reply with the number:`
        : '<b>Pick a model</b> — reply with the number:'
    const more =
      matches.length > shown.length
        ? `\n\n…and ${matches.length - shown.length} more — narrow with <code>/model &lt;name&gt;</code>.`
        : ''
    await this.sendHtml(chatId, `${header}\n\n${lines.join('\n')}${more}`)
  }

  /**
   * Commit a chosen cloud model as the Brain (persist + live), clearing
   * localOnly so it actually takes effect. Busy-blocked: the Brain is global,
   * so swapping it mid-turn would change the in-flight turn's next iteration.
   */
  private async applyModelSelection(
    chatId: number,
    option: ModelOption,
    raw: string
  ): Promise<void> {
    if (this.activeByChat.size > 0) {
      await this.sendBusyReply(chatId, raw)
      return
    }
    // Capture the prior local-only state before switching — only to decide
    // whether to note the mode flip in the reply.
    const config = await readConfig()
    const wasLocalOnly = config?.llm.localOnly ?? false
    await persistBrain(option)
    this.agent.thalamus.setBrain(option)
    // Choosing a specific cloud model IS a request to run on the cloud, so
    // force localOnly OFF — unconditionally, so a failed config read can never
    // leave the pick shadowed by local mode (resolveEntry would keep serving
    // the on-device model). Mirrors the in-app ModelSwitch, which flips to
    // cloud on select.
    await persistLocalOnly(false)
    this.agent.thalamus.setLocalOnly(false)
    const note = wasLocalOnly ? ' (switched to cloud)' : ''
    // sendPlain: code-composed text embedding dynamic provider/model ids —
    // entity-escaped so an id containing < or & can't bounce the HTML parse.
    await this.sendPlain(chatId, `☁️ Model: ${option.providerId} · ${option.model}${note}`)
  }

  /**
   * Open the numbered picker that drives /resume and /delete. Lists every
   * conversation of every origin, newest first, a page at a time. Caller has
   * already verified no turn is running on THIS chat.
   *
   * The full list is snapshotted into pendingSelections here and every page is
   * served from that snapshot rather than re-listing. Two reasons: /resume
   * rewrites updatedAt, which IS the sort key, so a second listing would
   * reshuffle rows under the numbers the user is still reading; and listing
   * parses every conversation file on disk, which shouldn't be paid per page.
   */
  private async renderConversationPicker(
    chatId: number,
    command: 'resume' | 'delete'
  ): Promise<void> {
    // Both /resume and /delete reach ANY conversation — a chat is no longer
    // pinned to its origin channel, so you manage the whole history from
    // anywhere, exactly like the in-app Conversations page. Each row carries an
    // origin tag so a mixed list stays legible. (listConversations is already
    // newest-first.)
    const all = await listConversations()
    // Automation runs outnumber real chats several-to-one and would bury them
    // in a newest-first list, so /resume hides them by default. /delete keeps
    // them — cleaning them up from a phone is a thing you'd actually want.
    const cfg = await getTelegramConfig()
    const items =
      command === 'resume' && (cfg.hideAutomationsFromResume ?? true)
        ? all.filter((c) => c.channel !== 'heartbeat')
        : all

    if (items.length === 0) {
      this.pendingSelections.delete(chatId)
      await this.safeSend(chatId, 'No saved conversations yet.')
      return
    }

    this.pendingSelections.set(chatId, { command, items, page: 0 })
    await this.sendPickerPage(chatId, command, items, 0)
  }

  /**
   * Render one page of an open picker. Numbering is continuous across the
   * whole list rather than restarting per page — page 2 opens at 26 — so a
   * number identifies the same conversation for as long as the picker is open,
   * and a number from a page already scrolled past still selects.
   */
  private async sendPickerPage(
    chatId: number,
    command: 'resume' | 'delete',
    items: ConversationMeta[],
    page: number
  ): Promise<void> {
    const { shown, start, last, total, hasMore } = pickerPage(items, page)
    const headerHtml =
      command === 'resume'
        ? '<b>Resume a conversation</b> — reply with the number:'
        : '<b>Delete a conversation</b> — reply with the number:'

    const itemsHtml = shown.map((conv, idx) => formatPickerItem(conv, start + idx)).join('\n\n')

    let footerHtml = ''
    if (hasMore) {
      footerHtml = `\n\n<i>${start + 1}–${last} of ${total} — reply <b>next</b> for more.</i>`
    } else if (start > 0) {
      footerHtml = `\n\n<i>${start + 1}–${last} of ${total} — end of list.</i>`
    }

    await this.sendHtml(chatId, `${headerHtml}\n\n${itemsHtml}${footerHtml}`)
  }

  /**
   * Swap this chat's active conversation to the selected one, which is
   * what /resume effectively means: "make this conversation the one I'm
   * continuing." Also restarts the idle clock: loadOrCreateConversation's
   * stale check keys off updatedAt, and a resumed conversation is by
   * definition old — left untouched, the very next message would trip
   * that check and bounce the user straight back to a fresh conversation,
   * undoing the resume.
   */
  private async handleResumeSelection(chatId: number, conversationId: string): Promise<void> {
    const conv = await loadConversation(conversationId)
    if (!conv) {
      await this.safeSend(chatId, '⚠️ That conversation is no longer available.')
      return
    }
    // Bump before remapping so a failed write leaves the old mapping intact.
    await updateConversation(conversationId, (disk) => {
      if (!disk) return null
      disk.updatedAt = Date.now()
      return disk
    })
    await setConversationIdForChat(chatId, conversationId)
    await this.sendHtml(
      chatId,
      `▶️ Resumed: <b>${escapeHtml(conv.title)}</b>${this.dropQueueForRotation(chatId)}`
    )
  }

  /**
   * Delete the chosen conversation. If it was the chat's active
   * conversation, also rotate the mapping to a fresh one — leaving
   * the chat with no active conversation would orphan the next
   * message. If a different (non-active) conversation was deleted,
   * the chat keeps its current active.
   */
  private async handleDeleteSelection(chatId: number, conversationId: string): Promise<void> {
    // The same backstop the in-app delete uses (conversation:delete in
    // index.ts): deleting a conversation mid-turn races its end-of-turn
    // persist, which resurrects the file — or strands a live stream with no
    // home. This chat's own busy-check can't cover it, because /delete now
    // reaches every conversation: the turn may belong to the app or another
    // chat entirely. deleteConversation is called directly here, so the IPC
    // handler's guard is not in the path and this has to be its own.
    // An automation/procedure run owns a real conversation for its whole
    // lifetime now (it is listed here while it runs), and those runs never
    // enter the TurnRunner — so they need their own check.
    if (
      this.runner.isConversationActive(conversationId) ||
      this.agent.isAutonomousRunActive(conversationId)
    ) {
      await this.safeSend(
        chatId,
        '⚠️ That conversation is busy right now — try again once it finishes.'
      )
      return
    }

    const currentId = await getConversationIdForChat(chatId)
    const wasActive = currentId === conversationId

    await deleteConversation(conversationId)
    this.agent.corpus.emit('conversation.deleted', { id: conversationId })

    if (wasActive) {
      const fresh = createConversation(null)
      fresh.channel = 'telegram'
      await saveConversation(fresh)
      await setConversationIdForChat(chatId, fresh.id)
      await this.sendHtml(
        chatId,
        `🗑 Deleted. New conversation started.${this.dropQueueForRotation(chatId)}\n\n${COMMANDS_HELP_HTML}`
      )
    } else {
      await this.safeSend(chatId, '🗑 Deleted.')
    }
  }

  // --- Mid-turn messages: interject first, sliver queue second ---
  // (see runtime/agent/interjection.ts and channels/message-queue.ts)

  /**
   * True while this chat cannot take a new turn. `activeByChat` covers a
   * running turn; the runner lane covers one still QUEUED behind a
   * predecessor (started, not yet in activeByChat) — the same pair
   * dispatchTurn re-checks. Callers that don't hold a conversation id use the
   * first half alone; that's the arrival gate, and dispatchTurn's own re-check
   * is what catches the rest.
   */
  private isChatBusy(chatId: number, conversationId?: string): boolean {
    if (this.activeByChat.has(chatId)) return true
    if (conversationId && this.runner.isConversationActive(conversationId)) return true
    return false
  }

  /**
   * The conversation a busy chat's message belongs to: the running turn's
   * own conversation when we hold one (never re-read the mapping mid-turn),
   * else the chat mapping (memory-cached after the first hit).
   */
  private async resolveConversationId(chatId: number): Promise<string | null> {
    const active = this.activeByChat.get(chatId)
    if (active) return active.conversation.id
    return await getConversationIdForChat(chatId).catch(() => null)
  }

  /**
   * A message that arrived while this chat is busy. INTERJECT FIRST: hand it
   * to the running turn, which reads it at its next stop point and answers
   * it inside the same run — the user is steering the work that is happening
   * now. Only when the runner has no lane for the conversation yet (the chat
   * is marked busy by us but runner.send has not registered the turn: the
   * pre-send sliver while a download, an STT run or the conversation load is
   * still going) does the message fall back to the sliver queue, whose flush
   * interjects again before it would ever start a turn of its own.
   *
   * Both acks read the same on the phone — one promise, two carriers.
   */
  private async parkMessage(chatId: number, item: QueuedTelegramMessage): Promise<void> {
    const conversationId = await this.resolveConversationId(chatId)
    if (conversationId && this.tryInterject(chatId, conversationId, item)) {
      await this.sendPlain(chatId, interjectionAckText(item.attachments.length))
      return
    }
    await this.enqueueMessage(chatId, item)
  }

  /**
   * Offer one message to the conversation's running turn. True when the
   * runner accepted it (it is pending on the turn's inbox and this channel
   * now owns its lifecycle — see onInterjectionEvent); false when there is
   * no live lane and the caller must queue or dispatch instead.
   *
   * The sender record is written BEFORE the call: the runner emits `pending`
   * synchronously from inside interject, and a later terminal event must
   * find the record even if it fires in the same tick.
   */
  private tryInterject(
    chatId: number,
    conversationId: string,
    item: QueuedTelegramMessage
  ): boolean {
    this.interjectedByMessageId.set(item.id, { chatId, userId: item.userId, ctx: item.ctx })
    const interjection: Interjection = {
      messageId: item.id,
      text: item.text,
      attachments: item.attachments,
      ...(item.voicePrompt ? { voicePrompt: true } : {}),
      ...(item.voiceLang ? { voiceLang: item.voiceLang } : {}),
      channel: 'telegram',
      sentAt: Date.now()
    }
    const result = this.runner.interject(conversationId, interjection)
    if (result.status === 'pending') return true
    this.interjectedByMessageId.delete(item.id)
    return false
  }

  /**
   * /cancel: withdraw every interjection this channel sent for the chat's
   * conversation that the turn has not read yet, then clear the sliver queue.
   * Returns the combined count. A message the agent already read is history
   * and stays — the runner refuses to withdraw it, and it is not counted.
   */
  private async dropUnread(chatId: number): Promise<number> {
    let withdrawn = 0
    const conversationId = await this.resolveConversationId(chatId)
    if (conversationId) {
      for (const pending of this.runner.pendingInterjections(conversationId)) {
        if (pending.channel !== 'telegram') continue
        if (this.runner.withdrawInterjection(conversationId, pending.messageId, 'user')) withdrawn++
      }
    }
    return withdrawn + this.clearQueue(chatId)
  }

  /** Subscribe once per start; idempotent. Paired with unwatchInterjections in stop(). */
  private watchInterjections(): void {
    if (this.offInterjection) return
    this.offInterjection = this.runner.onInterjection((ev) => this.onInterjectionEvent(ev))
  }

  private unwatchInterjections(): void {
    this.offInterjection?.()
    this.offInterjection = null
    this.interjectedByMessageId.clear()
  }

  /**
   * Lifecycle of the interjections THIS channel sent (every other channel's
   * messages, and events for messages we never recorded, are ignored).
   *
   *  - delivered: the turn read it; nothing to do but forget the record.
   *  - withdrawn/user: /cancel took it back; the reply was already sent.
   *  - withdrawn/turn_ended or error: the turn finished (or died) in the
   *    sliver between the agent's final drain and the lane closing, so the
   *    message was never read. Re-dispatch it as a fresh turn through the
   *    sliver queue — NOT a direct dispatch: the sweep fires while the
   *    finished lane is still counted, so a re-interject here would park the
   *    message on a turn that will never read it, and a direct dispatchTurn
   *    would bounce off its own busy re-check into exactly that. The queue is
   *    drained by the same end-of-turn cleanup that releases the chat, and
   *    its flush yields to a macrotask before it looks at the lane.
   *  - withdrawn/canceled: the user stopped the turn. Tell them the message
   *    was not read; never auto-resend after a stop.
   */
  private onInterjectionEvent(ev: InterjectionEvent): void {
    if (ev.channel !== 'telegram') return
    if (ev.state === 'pending') return
    const sender = this.interjectedByMessageId.get(ev.messageId)
    this.interjectedByMessageId.delete(ev.messageId)
    if (!sender || ev.state !== 'withdrawn') return
    if (ev.reason === 'turn_ended' || ev.reason === 'error') {
      this.queue.enqueue(sender.chatId, {
        id: ev.messageId,
        userId: sender.userId,
        ctx: sender.ctx,
        text: ev.text,
        attachments: ev.attachments,
        ...(ev.voicePrompt ? { voicePrompt: true } : {}),
        ...(ev.voiceLang ? { voiceLang: ev.voiceLang } : {})
      })
      // Same gate as enqueueMessage: a running turn of ours (the one whose
      // sweep just fired) is about to flush from its cleanup; otherwise
      // nothing else will, so start the flush here.
      if (!this.activeByChat.has(sender.chatId)) this.flushQueue(sender.chatId)
      return
    }
    if (ev.reason === 'canceled') {
      void this.sendPlain(sender.chatId, unreadAfterStopText(ev.text, ev.attachments.length))
    }
  }

  /**
   * Park a message in the sliver queue and tell the user it landed. Reached
   * only when interject said no_live_turn (see parkMessage) — and directly
   * by the turn-ended re-dispatch, which skips the ack.
   *
   * The flush fires ONLY when no running turn of ours owns this chat.
   *
   * When one does, its end-of-turn cleanup is guaranteed to flush, and the
   * item is on the queue BEFORE this check — so that cleanup cannot miss it,
   * whichever side of the `activeByChat.delete` we land on. Flushing anyway
   * would start a wait on the very map that just admitted us: on any turn
   * longer than 30s the wait can only expire, and an expiry is counted as a
   * failed dispatch, so three of them (90s) told the user their message
   * hadn't run and pointed them at /stop — killing a healthy turn that was
   * about to answer them. The queue was fine; only the warning was wrong.
   *
   * The callers that DO flush are the ones the wait was written for: the turn
   * ended during the async work that produced this message (a media download,
   * an STT run), or dispatchTurn's re-check parked it because a FOREIGN lane
   * (the in-app composer, a heartbeat) holds the conversation. Nothing of
   * ours cleans up after those, so the wait + bounded retry is what gets the
   * message out.
   */
  private async enqueueMessage(chatId: number, item: QueuedTelegramMessage): Promise<void> {
    this.queue.enqueue(chatId, item)
    await this.sendPlain(chatId, queuedAckText(item.attachments.length))
    if (!this.activeByChat.has(chatId)) this.flushQueue(chatId)
  }

  /**
   * Drain this chat's sliver queue in arrival order. For every item:
   * INTERJECT FIRST — if a turn is live on the conversation by now (the one
   * that was being set up when the message arrived, or a foreign one), the
   * message joins it and the turn reads it at its next stop point; only
   * with no live lane does the item start a turn of its own.
   *
   * Fire-and-forget by design: it is called from the end-of-turn cleanup
   * chain, which must not block on the next turn's entire lifetime.
   *
   * Every iteration yields to a MACROTASK before it looks at the lane. This
   * is load-bearing: the cleanup that calls us runs in the same microtask
   * drain as the runner's own tail, where a turn that has already swept its
   * inbox is still counted on the lane for a few more microtasks. Seen from
   * a timer callback, "the lane is live" means a turn that will read the
   * inbox; seen from inside that drain, it can mean a corpse — and an
   * interjection parked on a corpse is never read.
   */
  private flushQueue(chatId: number): void {
    if (this.flushingByChat.has(chatId)) return
    if (this.queue.size(chatId) === 0) return
    this.flushingByChat.add(chatId)
    void (async () => {
      // Retries for the CURRENT head only, reset on every successful dispatch.
      // Bounds the one loop that could otherwise spin: our own per-chat slot
      // held by a cleanup that never completes. A FOREIGN lane (the in-app
      // composer, a heartbeat) no longer needs the retry — the item joins that
      // turn as an interjection instead.
      let attempts = 0
      try {
        while (this.queue.size(chatId) > 0) {
          await new Promise((r) => setTimeout(r, 0))
          const state = await this.waitForFreeChat(chatId)
          const next = this.queue.shift(chatId)
          if (!next) return
          let started = false
          if (state === 'live') {
            const conversationId = await this.resolveConversationId(chatId)
            // No ack: the user was told "I'll read it" when it was parked.
            started = !!conversationId && this.tryInterject(chatId, conversationId, next)
          } else if (state === 'free') {
            // A throwing dispatch counts as a failed attempt, not a lost
            // message: the item is already off the queue here, so letting the
            // throw escape would drop what the user was promised we'd run.
            try {
              started = await this.dispatchTurn(
                chatId,
                next.userId,
                next.text,
                next.attachments,
                next.ctx,
                undefined,
                { voicePrompt: next.voicePrompt, voiceLang: next.voiceLang, fromQueue: true }
              )
            } catch {
              started = false
            }
          }
          if (started) {
            attempts = 0
            continue
          }
          // Never dropped: the message goes back to the head of the line.
          this.queue.requeue(chatId, next)
          // Back off before retrying. Without this the attempt budget can burn
          // out in microseconds on a transient claim and cry wolf at the user.
          await new Promise((r) => setTimeout(r, QUEUE_FLUSH_POLL_MS))
          if (++attempts >= QUEUE_FLUSH_ATTEMPTS) {
            // Wedged — say so rather than spin or silently stall. The queue
            // survives, and the next end-of-turn cleanup retries it.
            await this.sendPlain(
              chatId,
              "⚠️ Still busy, so your queued messages haven't run yet. /stop frees the chat, /cancel drops them."
            )
            return
          }
        }
      } catch {
        // A failed flush must never wedge the chat — the queue survives and the
        // next end-of-turn cleanup retries it.
      } finally {
        this.flushingByChat.delete(chatId)
      }
    })()
  }

  /**
   * Poll until this chat can take a turn ('free') or a turn goes live on its
   * conversation ('live' — the flush interjects into it instead of waiting
   * for it to end). 'expired' means the budget ran out with our own per-chat
   * slot still held and no lane live: a cleanup that has not released it.
   *
   * Waiting on the RUNNER LANE, not just the per-chat slot, is load-bearing.
   * The flush is fired from the cleanup that deletes the slot, and that
   * cleanup runs on the render chain — which, when the chain is already
   * drained, is scheduled as a microtask AHEAD of the runner's own tail. So
   * "activeByChat is empty" can be true while the finished turn is still
   * counted on its conversation's lane, and dispatching into that window just
   * bounces off dispatchTurn's re-check. The mapping read is memory-cached
   * after the first hit, and the value can't shift under us: every command
   * that rotates it clears this chat's queue, which ends the flush.
   *
   * Only ever called after the flush loop's macrotask yield, so the first
   * check already sees a settled lane — see flushQueue.
   */
  private async waitForFreeChat(chatId: number): Promise<'free' | 'live' | 'expired'> {
    const conversationId = (await getConversationIdForChat(chatId).catch(() => null)) ?? undefined
    const deadline = Date.now() + this.queueFlushWaitMs
    for (;;) {
      if (conversationId && this.runner.isConversationActive(conversationId)) return 'live'
      if (!this.isChatBusy(chatId, conversationId)) return 'free'
      if (Date.now() >= deadline) return 'expired'
      await new Promise((r) => setTimeout(r, QUEUE_FLUSH_POLL_MS))
    }
  }

  /**
   * Drop everything queued for this chat. Called by /cancel and by every
   * command that rotates the chat onto a DIFFERENT conversation — a queue
   * belongs to the conversation it was typed into, and must never flush into
   * the fresh one (the in-app queue clears on conversation switch for exactly
   * this reason).
   */
  private clearQueue(chatId: number): number {
    return this.queue.clear(chatId)
  }

  /**
   * Drop the queue because this chat is being pointed at a DIFFERENT
   * conversation, and return a sentence the caller appends to its own reply.
   * Silent (empty string) when nothing was queued, so the common case reads
   * exactly as it did before. Plain text — safe inside sendHtml too.
   */
  private dropQueueForRotation(chatId: number): string {
    const dropped = this.clearQueue(chatId)
    if (dropped === 0) return ''
    return dropped === 1
      ? ' 1 queued message was dropped with it.'
      : ` ${dropped} queued messages were dropped with it.`
  }

  /**
   * Generate and send a polite "I'm busy" reply using the local
   * provider directly. Bypasses the agent pipeline entirely so the
   * decline doesn't queue behind the active turn or interrupt it.
   * Falls back to a static message if the local model isn't
   * configured, errors out, or doesn't produce text within
   * BUSY_REPLY_TIMEOUT_MS — keeps the user from hanging on a slow
   * cold-start.
   */
  private async sendBusyReply(chatId: number, userText: string): Promise<void> {
    if (!this.localProvider.isReady) {
      await this.safeSend(chatId, FALLBACK_BUSY_REPLY)
      return
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), BUSY_REPLY_TIMEOUT_MS)

    let response = ''
    try {
      for await (const chunk of this.localProvider.stream({
        system: BUSY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userText }],
        signal: controller.signal
      })) {
        if (chunk.type === 'text') response += chunk.text
        if (chunk.type === 'turn_meta') break
        if (chunk.type === 'error') {
          response = ''
          break
        }
      }
    } catch {
      response = ''
    } finally {
      clearTimeout(timer)
    }

    const trimmed = response.trim()
    await this.safeSend(chatId, trimmed.length > 0 ? trimmed : FALLBACK_BUSY_REPLY)
  }

  /**
   * Telegram's press-and-hold voice message (the mic button — comes
   * in as `message:voice`, distinct from `message:audio` which is a
   * music file the user attached).
   *
   * Flow: download the OGG/Opus blob to the conversation's uploads
   * folder (same place every other media file lives), run it through
   * the cerebellum's stt_transcribe tool, then dispatch a normal
   * text turn using the transcript as content with the voice file
   * attached. The agent sees a regular user turn with the transcript
   * spelled out; the audio is preserved as an attachment so the
   * in-app history can play it back later.
   *
   * Other audio types (`message:audio`, attached MP3s, etc.) keep
   * the original attach-and-dispatch flow via handleMediaMessage.
   */
  private async handleVoiceMessage(ctx: BotContext): Promise<void> {
    const userId = ctx.from?.id
    const chatId = ctx.chat?.id
    const message = ctx.message
    if (!userId || !chatId || !message) return
    if (!this.allowedUserIds.has(userId)) return

    if (message.message_id) this.trackMessageId(chatId, message.message_id)

    const fileInfo = extractFileInfo(message)
    if (!fileInfo) return

    // A busy chat parks the voice note instead of declining it. Download and
    // transcription happen NOW, not at flush time: the file handle expires,
    // and doing the STT up front is what lets the transcript echo (and the
    // queue ack) reach the user immediately. See handleMediaMessage.
    const busyTurn = this.activeByChat.get(chatId)

    // Light up the typing bubble for the entire pre-turn window —
    // download, STT, transcript echo. dispatchTurn's onTurnStarted
    // hands off to the in-turn heartbeat; the finally below catches
    // every early-return path (download fail, transcribe fail, etc.)
    // so the bubble never lingers past the work.
    this.startPreTyping(chatId, ctx)
    try {
      const conversation = busyTurn?.conversation ?? (await this.loadOrCreateConversation(chatId))

      let attachment: MessageAttachment
      try {
        const file = await ctx.api.getFile(fileInfo.fileId)
        if (typeof file.file_size === 'number' && file.file_size > TELEGRAM_DOWNLOAD_LIMIT) {
          await this.safeSend(
            chatId,
            `⚠️ Voice message too large (${formatBytes(file.file_size)}). Limit is ${formatBytes(TELEGRAM_DOWNLOAD_LIMIT)}.`
          )
          return
        }
        if (!file.file_path) {
          throw new Error('telegram getFile returned no file_path')
        }
        if (!this.botToken) {
          throw new Error('bot is not running')
        }
        const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`
        const response = await fetch(url)
        if (!response.ok) {
          throw new Error(`download failed: HTTP ${response.status}`)
        }
        const buffer = Buffer.from(await response.arrayBuffer())

        // Save to workspace/uploads/{conv}/ — same pattern any other
        // media file uses. The voice file persists alongside the
        // conversation; the in-app history can replay it later.
        attachment = await saveUploadFromBuffer(
          conversation.id,
          buffer,
          fileInfo.fileName ?? defaultFileName(file.file_path),
          fileInfo.mimeType
        )
        this.agent.corpus.emit('telegram.media.received', {
          chatId,
          userId,
          type: attachment.type,
          filePath: attachment.filePath,
          sizeBytes: attachment.sizeBytes
        })
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err)
        await this.sendPlain(chatId, `⚠️ Voice download failed: ${errMessage}`)
        return
      }

      // Scope the conversation id (ALS, not the imperative global) BEFORE
      // invoking the tool so the speech-to-text plugin's
      // persistTranscription() routes the transcript into speech/conv-{id}/
      // instead of speech/orphan/. This path runs the tool directly, outside
      // any turn — setting the GLOBAL here would clobber whichever
      // conversation a concurrent turn published.
      // Also ensure ffmpeg (silent self-install): direct tool calls bypass
      // the agent loop's dependency resolution.
      await this.agent.cerebellum.ensureSystemTool('ffmpeg')
      const result = await this.agent.cerebellum.runWithConversation(conversation.id, () =>
        this.agent.cerebellum.executeTool('stt_transcribe', {
          filePath: attachment.filePath
        })
      )
      if (!result.success) {
        await this.sendPlain(
          chatId,
          `⚠️ Couldn't transcribe voice message: ${result.error ?? 'unknown error'}`
        )
        return
      }
      const transcript = extractTranscript(result.output ?? '')
      if (!transcript) {
        await this.safeSend(chatId, '⚠️ Voice message transcribed to nothing.')
        return
      }
      // Whisper's detected language — a deterministic signal of which
      // language to reply in, threaded into the <voice_note lang="…"> tag
      // so the model doesn't guess (and drift to the user's native tongue)
      // from a short transcript.
      const voiceLang = extractVoiceLanguage(result.output ?? '')

      // Echo the transcript back so the user sees exactly what we
      // heard before the agent responds — italics + mic emoji to
      // distinguish it from a normal reply. Goes out before the turn
      // dispatch so it lands above the agent's answer in the chat.
      await this.sendHtml(chatId, `🎙 <i>${escapeHtml(transcript)}</i>`)

      // Dispatch with the transcript as content and the voice file
      // attached. The agent reads the prose; the audio is along for
      // the ride so the conversation file preserves the original.
      // voicePrompt:true tells the history builder to keep the audio
      // out of the LLM-bound history — the transcript IS the prompt.
      // Busy (still, or newly) ⇒ park it with both flags intact, so the
      // flushed turn is byte-identical to this one.
      if (this.activeByChat.has(chatId)) {
        await this.parkMessage(chatId, {
          id: mintMessageId(),
          userId,
          ctx,
          text: transcript,
          attachments: [attachment],
          voicePrompt: true,
          voiceLang
        })
        return
      }
      await this.dispatchTurn(
        chatId,
        userId,
        transcript,
        [attachment],
        ctx,
        busyTurn ? undefined : conversation,
        { voicePrompt: true, voiceLang }
      )
    } finally {
      this.stopPreTyping(chatId)
    }
  }

  /**
   * Photos, videos, audio files, documents. Downloads the file via
   * grammY's getFile + the file-bot URL, saves into the conversation's
   * upload folder, attaches metadata to the user message, then dispatches
   * the turn the same way text messages do. Caption (if present) becomes
   * the message body — without one, the message body is empty and the
   * model sees the attachment alone.
   *
   * Voice messages (`message:voice`) get a different path —
   * handleVoiceMessage transcribes them and treats the transcript as
   * the user's prompt instead of attaching the OGG blob.
   */
  private async handleMediaMessage(ctx: BotContext): Promise<void> {
    const userId = ctx.from?.id
    const chatId = ctx.chat?.id
    const message = ctx.message
    if (!userId || !chatId || !message) return
    if (!this.allowedUserIds.has(userId)) return

    if (message.message_id) this.trackMessageId(chatId, message.message_id)

    const fileInfo = extractFileInfo(message)
    if (!fileInfo) return

    const caption = (message.caption ?? '').trim()

    // A busy chat no longer declines media — the file is downloaded and the
    // message parked. The download CANNOT be deferred to flush time: Telegram's
    // file_path is short-lived and this update is gone by then, so a queued
    // photo would be undeliverable. The size guards below still apply, so the
    // "don't pull 50 MB we can't use" concern is bounded the same way it is on
    // an idle chat.
    const busyTurn = this.activeByChat.get(chatId)

    // Light up the typing bubble for the entire pre-turn window —
    // a 20 MB download over slow networks can easily exceed 5 seconds,
    // which is when Telegram clears a single sendChatAction. The finally
    // catches every early-return path so the bubble never lingers.
    this.startPreTyping(chatId, ctx)
    try {
      // While a turn is running, its conversation IS this chat's conversation —
      // use it directly so the upload lands in the folder the queued turn will
      // read from, and so we never race loadOrCreateConversation's idle check.
      const conversation = busyTurn?.conversation ?? (await this.loadOrCreateConversation(chatId))

      let attachment: MessageAttachment
      try {
        const file = await ctx.api.getFile(fileInfo.fileId)
        if (typeof file.file_size === 'number' && file.file_size > TELEGRAM_DOWNLOAD_LIMIT) {
          await this.safeSend(
            chatId,
            `⚠️ File too large (${formatBytes(file.file_size)}). Telegram bots can only fetch files up to 20 MB.`
          )
          return
        }
        if (!file.file_path) {
          throw new Error('telegram getFile returned no file_path')
        }
        if (!this.botToken) {
          throw new Error('bot is not running')
        }
        const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`
        const response = await fetch(url)
        if (!response.ok) {
          throw new Error(`download failed: HTTP ${response.status}`)
        }
        const buffer = Buffer.from(await response.arrayBuffer())
        // Pass Telegram's declared mime_type as a hint so a document whose
        // filename lacks an extension still classifies correctly (e.g. a PDF
        // named "scan" → type=pdf) instead of collapsing to an opaque blob.
        attachment = await saveUploadFromBuffer(
          conversation.id,
          buffer,
          fileInfo.fileName ?? defaultFileName(file.file_path),
          fileInfo.mimeType
        )
        this.agent.corpus.emit('telegram.media.received', {
          chatId,
          userId,
          type: attachment.type,
          filePath: attachment.filePath,
          sizeBytes: attachment.sizeBytes
        })
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err)
        await this.sendPlain(chatId, `⚠️ Media upload failed: ${errMessage}`)
        return
      }

      // No vision gate here — images dispatch on every model. A non-vision
      // model gets a text note (name + path + tool guidance) from the
      // attachment pipeline instead of the image bytes, and explains to the
      // user what it can and can't do with the file.
      //
      // Re-read the busy state: the download may have outlasted the turn that
      // was running when this message arrived (in which case dispatch now), or
      // a turn may have started during it (park it). The queued entry carries
      // the saved attachment, so the flushed turn hands the model the same
      // native document/image blocks an unqueued one would.
      if (this.activeByChat.has(chatId)) {
        await this.parkMessage(chatId, {
          id: mintMessageId(),
          userId,
          ctx,
          text: caption,
          attachments: [attachment]
        })
        return
      }
      // Only pass the conversation as preloaded when WE loaded it — a copy
      // lifted off a turn that has since ended is stale by definition.
      await this.dispatchTurn(
        chatId,
        userId,
        caption,
        [attachment],
        ctx,
        busyTurn ? undefined : conversation
      )
    } finally {
      this.stopPreTyping(chatId)
    }
  }

  /**
   * Run one user message as a turn. Resolves TRUE once the turn has finished,
   * FALSE if the chat turned out to be busy and the message was parked instead
   * (or, for a queue flush, handed back to the caller to re-queue).
   */
  private async dispatchTurn(
    chatId: number,
    userId: number,
    userText: string,
    attachments: MessageAttachment[],
    ctx: BotContext,
    preloadedConversation?: ConversationFile,
    options: { voicePrompt?: boolean; voiceLang?: string; fromQueue?: boolean } = {}
  ): Promise<boolean> {
    // Cover the gap between dispatch entry and onTurnStarted — load,
    // save, history build. Idempotent: voice/media already started their
    // own pre-typer; this is a no-op there. For text messages it's the
    // first call. onTurnStarted hands off; the finally below is a safety
    // net for synchronous failures before the turn even starts.
    this.startPreTyping(chatId, ctx)
    try {
      const conversation = preloadedConversation ?? (await this.loadOrCreateConversation(chatId))

      // Re-check the busy state at DISPATCH time, not just message arrival.
      // The voice/media paths spend seconds between their entry gate and
      // this point (download + ffmpeg + STT), and activeByChat is only set
      // when the runner lane actually starts — so a second message could
      // slip past the arrival gate and queue a second turn onto the same
      // conversation lane, where the two turns' per-chat state would
      // collide. isConversationActive also covers a turn still QUEUED on
      // the lane (not yet started).
      //
      // Losing this race is no longer a decline: the message is parked and
      // runs when the chat frees up. A flush that loses it hands the message
      // back to the flush loop instead (it is already queued — re-acking it
      // would tell the user "queued" twice for one message).
      if (this.isChatBusy(chatId, conversation.id)) {
        if (!options.fromQueue) {
          await this.parkMessage(chatId, {
            id: mintMessageId(),
            userId,
            ctx,
            text: userText,
            attachments,
            voicePrompt: options.voicePrompt,
            voiceLang: options.voiceLang
          })
        }
        return false
      }

      // Resolve the verbosity preference once per turn. false (default) =
      // clean feed (agent messages + file results + errors only).
      const verbose = (await getTelegramConfig()).verbose ?? false

      const userMessage: ConversationMessage = {
        id: mintMessageId(),
        role: 'user',
        content: userText,
        timestamp: Date.now(),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(options.voicePrompt ? { voicePrompt: true } : {}),
        ...(options.voiceLang ? { voiceLang: options.voiceLang } : {})
      }
      // Local copy feeds the replay-history build below; the persist itself
      // is an append-RMW against the freshest disk state so a concurrent
      // writer (summarizer, another surface) is never clobbered by this
      // stale copy. A null disk means the conversation was deleted out from
      // under us — skip the write rather than resurrect the file.
      conversation.messages.push(userMessage)
      conversation.updatedAt = userMessage.timestamp
      await updateConversation(conversation.id, (disk) => {
        if (!disk) return null
        disk.messages.push(userMessage)
        disk.updatedAt = userMessage.timestamp
        return disk
      })

      // History exposed to the agent. Voice-prompt messages keep their
      // raw transcript only — the audio stays on disk for chat replay
      // but never reaches the LLM (transcript IS the prompt).
      // Every other user message gets the `<attachments>` metadata
      // block composed into content + the attachments field forwarded,
      // so the agent's processHistoryAttachments can convert images,
      // PDFs, and docs into native content blocks (same rules the
      // in-app channel uses).
      const window = replayWindow(conversation)
      const history: ChatHistoryMessage[] = stubStaleToolResults(
        window.preamble.concat(
          window.messages.flatMap((m) => {
            if (m.role !== 'user') return assistantSegmentsToHistory(m)
            if (m.voicePrompt) {
              const langAttr = m.voiceLang ? ` lang="${m.voiceLang}"` : ''
              return [{ role: 'user' as const, content: `<voice_note${langAttr}>\n${m.content}` }]
            }
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

      // This dispatch's own ActiveTurn, captured so the end-of-turn cleanup
      // always operates on OUR turn's state — never a successor's that may
      // have taken the per-chat slot while our render chain drained.
      let dispatchedTurn: ActiveTurn | null = null
      const handle = this.runner.send({
        history,
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        // Project binding rides the conversation file, so continued
        // project conversations get the overlay on every channel turn.
        projectId: conversation.projectId ?? null,
        channel: 'telegram',
        formatNotices: () => this.drainFormatNotices(chatId),
        makeSink: ({ turnId, conversationId }) => this.createSink(turnId, conversationId, chatId),
        onTurnStarted: ({ turnId, controller }) => {
          // Stamp the assistant message's identity up front so live mirror
          // snapshots and the end-of-turn save share one id + timestamp.
          const assistantTimestamp = Date.now()
          const active: ActiveTurn = {
            chatId,
            turnId,
            conversation,
            textBuffer: '',
            formatNotices: [],
            workflowState: new Map(),
            assistantContent: '',
            segments: [],
            approvals: new Map(),
            toolTimings: new Map(),
            stopReason: null,
            assistantMessageId: mintMessageId(assistantTimestamp),
            assistantTimestamp,
            userMessage,
            lastMirrorAt: 0,
            mirrorTimer: null,
            taskId: null,
            controller,
            pendingApprovalId: null,
            pendingApprovalResolve: null,
            pendingAsk: null,
            pendingAskResolve: null,
            done: null,
            typingTimer: null,
            toolCallNames: new Map(),
            pendingActiveModel: null,
            lastFlushedModel: null,
            sentFiles: new Set(),
            renderChain: Promise.resolve(),
            verbose,
            voiceReplySent: false,
            stats: new TurnStatsCollector(Date.now())
          }
          dispatchedTurn = active
          this.activeByChat.set(chatId, active)
          // Hand off from the pre-turn heartbeat — the turn timer below
          // covers the rest of the window. Stopping the pre-typer here
          // avoids two intervals firing in parallel through the turn.
          this.stopPreTyping(chatId)
          // Fire once immediately so the indicator shows up right away,
          // then re-fire on a 4s cadence — Telegram clears the bubble
          // after ~5s, so a single fire only covers the first burst.
          // While an approval is pending we pause the heartbeat so the
          // chat doesn't look "busy" while the agent is actually waiting
          // on the user. It resumes when they answer.
          void ctx.api.sendChatAction(chatId, 'typing').catch(() => undefined)
          active.typingTimer = setInterval(() => {
            const turn = this.activeByChat.get(chatId)
            if (!turn) return
            if (turn.pendingApprovalId || turn.pendingAsk) return
            void ctx.api.sendChatAction(chatId, 'typing').catch(() => undefined)
          }, TYPING_HEARTBEAT_MS)
          // unref so this timer doesn't keep node.js alive on its own
          // during a graceful shutdown.
          active.typingTimer.unref?.()
        },
        onTurnEnded: () => {
          // Drain the render chain BEFORE persisting/cleanup — the terminal
          // workflow snapshot (emitted in the agent's finally, i.e. always the
          // chain's tail) and any late tool_result are otherwise still queued
          // when activeByChat is deleted, so renderSegment's `if (!active)`
          // guard would drop them from both the feed and the saved
          // conversation. Mirrors WhatsApp's queue drain.
          const chain = dispatchedTurn?.renderChain ?? Promise.resolve()
          // .catch BEFORE .then: a rejected render chain must still reach the
          // cleanup. It is what deletes activeByChat and flushes the queue, so
          // skipping it leaks the per-chat slot — the chat then reads as
          // permanently busy, every later message parks, and (since enqueue
          // deliberately starts no flush while that slot is held) the queue
          // strands. The links swallow send failures, but nothing else.
          void chain
            .catch(() => undefined)
            .then(() => {
              // Persist and resolve against OUR captured turn object — the
              // per-chat slot may already belong to a successor turn by the
              // time this network-bound drain fires, and reading the map here
              // used to silently drop the finished turn's transcript (and leak
              // its typing timer).
              const finished = dispatchedTurn
              if (finished) {
                // Mark any approval still pending at end-of-turn as denied
                // so the saved record matches the real outcome — the runner
                // also denies the Promise via pendingApprovalResolve below,
                // but the persisted decision needs the same write.
                if (finished.pendingApprovalId) {
                  const stored = finished.approvals.get(finished.pendingApprovalId)
                  if (stored && !stored.decision) stored.decision = 'denied'
                }

                // Persist the full assistant turn — text, every segment in
                // order, approvals (with decisions), tool timings, stop
                // reason. Same shape the in-app Electron channel saves.
                // Assembled from the SAME accumulator the live mirror emitted,
                // so the disk record and any already-mirrored in-app copy share
                // one id + timestamp and reconcile instead of duplicating.
                // buildAssistantMessage returns null only when there's nothing
                // to save (no prose AND no segments) so tool-only turns persist.
                const endedAt = Date.now()
                const assistant = buildAssistantMessage(finished)
                if (assistant) {
                  finished.conversation.messages.push(assistant)
                  // updatedAt tracks the turn's END, not the assistant's stamped
                  // start time, so idle-rotation staleness + the rail's sort see
                  // fresh activity for a long turn.
                  finished.conversation.updatedAt = endedAt
                  // Kill any pending throttled snapshot and push the final,
                  // un-throttled one so an in-app viewer flips to the terminal
                  // message (with stop-reason chip) at once — ahead of the disk
                  // save + reindex that would otherwise be the first it hears.
                  if (finished.mirrorTimer) {
                    clearTimeout(finished.mirrorTimer)
                    finished.mirrorTimer = null
                  }
                  this.mirrorListener?.(finished.conversation.id, assistant)
                }
                // Fold this turn's tokenomics into the persisted stats so the
                // in-app context-meter card restores real numbers for this
                // Telegram conversation (it was blank before — channel turns
                // never wrote stats). Persist even without an assistant message
                // so an errored/empty turn still records its all-time roll-up.
                const foldStats = finished.stats.hasData()
                if (assistant || foldStats) {
                  // Append-RMW: the copy held since dispatch may be stale
                  // w.r.t. the summarizer — append onto the freshest disk
                  // state instead of whole-saving the held copy over it. A
                  // null disk means the conversation was deleted mid-drain —
                  // skip rather than resurrect it.
                  void updateConversation(finished.conversation.id, (disk) => {
                    if (!disk) return null
                    if (assistant) {
                      disk.messages.push(assistant)
                      disk.updatedAt = endedAt
                    }
                    if (foldStats) disk.stats = finished.stats.foldInto(disk.stats, endedAt)
                    // A heartbeat/procedure run seals its conversation as a
                    // finished record, and the summarizer below skips sealed
                    // files. A user turn in it — reachable since a background run
                    // can hand this chat its conversation — makes it live again;
                    // left sealed it would replay the whole verbatim transcript on
                    // every reply forever. Mirrors the in-app unseal.
                    if (disk.sealed) disk.sealed = false
                    return disk
                  })
                    .then(() => {
                      if (assistant) queueConversationSummarization(finished.conversation.id)
                    })
                    .catch(() => undefined)
                }
                if (finished.typingTimer) {
                  clearInterval(finished.typingTimer)
                  finished.typingTimer = null
                }
                // Format leaks flushed with no agent iteration left to read
                // them (typically the FINAL prose block) carry over to the
                // next turn's drain, so the model still hears what reached
                // the user's phone and can repair it there.
                if (finished.formatNotices.length > 0) {
                  const prior = this.pendingFormatNotices.get(chatId) ?? []
                  this.pendingFormatNotices.set(chatId, [...prior, ...finished.formatNotices])
                  finished.formatNotices = []
                }
                // Safety-net for the empty-turn path (assistant === null, so the
                // block above didn't run): a trailing mirror timer must never
                // outlive its turn and fire into a successor's state.
                if (finished.mirrorTimer) {
                  clearTimeout(finished.mirrorTimer)
                  finished.mirrorTimer = null
                }
                if (finished.pendingApprovalResolve) {
                  finished.pendingApprovalResolve('denied')
                  finished.pendingApprovalId = null
                  finished.pendingApprovalResolve = null
                }
                // An unanswered question at end-of-turn resolves canceled so the
                // ask tool's execute() unwinds and the run can finish.
                if (finished.pendingAskResolve) {
                  finished.pendingAskResolve({ kind: 'canceled' })
                  finished.pendingAsk = null
                  finished.pendingAskResolve = null
                }
              }
              // Release the per-chat slot only if WE still own it — a
              // successor turn's entry must survive our teardown.
              if (!finished || this.activeByChat.get(chatId) === finished) {
                this.activeByChat.delete(chatId)
                // The chat is free: hand it to anything the user sent mid-turn.
                // This is the channel's streaming→idle transition — the same
                // edge the in-app composer flushes its queue on, and for the
                // same reason it needs no special casing for /stop or an errored
                // turn: both land here through the identical cleanup path.
                this.flushQueue(chatId)
              }
            })
        }
      })

      await handle.done
      return true
    } finally {
      // Safety net — onTurnStarted already cleared this on the happy
      // path. This catches the case where runner.send throws or
      // handle.done rejects before onTurnStarted ever fires.
      this.stopPreTyping(chatId)
    }
  }

  /**
   * Point this chat at the conversation that just sent to it (see
   * bindChatToConversation for what that means and why). Nothing to resolve
   * here, unlike WhatsApp: the id the send tools address is the same numeric
   * chat id the inbound path keys the map by.
   */
  private async bindChatToSendingConversation(chatId: number): Promise<void> {
    await bindChatToConversation(turnScope.getStore()?.conversationId, {
      getBoundConversationId: () => getConversationIdForChat(chatId),
      setBoundConversationId: (id) => setConversationIdForChat(chatId, id),
      updateConversation
    })
  }

  private async loadOrCreateConversation(chatId: number): Promise<ConversationFile> {
    const existingId = await getConversationIdForChat(chatId)
    if (existingId) {
      const loaded = await loadConversation(existingId)
      if (loaded) {
        const cfg = await getTelegramConfig()
        const autoRefresh = cfg.autoRefresh ?? true
        const staleMs = (cfg.staleHours ?? 3) * 60 * 60 * 1000
        if (autoRefresh && loaded.messages.length > 0) {
          const elapsed = Date.now() - loaded.updatedAt
          if (elapsed >= staleMs) {
            // Idle rotation deliberately does NOT inherit the old
            // conversation's projectId (unlike /new): hitting the idle
            // limit closes the project — the fresh conversation is plain.
            const fresh = createConversation(null)
            fresh.channel = 'telegram'
            await saveConversation(fresh)
            await setConversationIdForChat(chatId, fresh.id)
            const oldTitle = loaded.title || 'Untitled'
            let projectNote = ''
            if (loaded.projectId) {
              const project = (await listProjects().catch(() => [] as Project[])).find(
                (p) => p.id === loaded.projectId
              )
              projectNote = project
                ? ` Left ${escapeHtml(projectLabel(project))} — use /project to re-enter it.`
                : ' Left its project — use /project to pick one.'
            }
            await this.sendHtml(
              chatId,
              `🔄 Conversation "<b>${escapeHtml(oldTitle)}</b>" was idle for ${Math.floor(elapsed / 3_600_000)}h — started a fresh one.${projectNote}\n\nUse /resume to go back. Your past conversations are preserved.`
            )
            return fresh
          }
        }
        return loaded
      }
    }
    const fresh = createConversation(null)
    fresh.channel = 'telegram'
    await saveConversation(fresh)
    await setConversationIdForChat(chatId, fresh.id)
    return fresh
  }

  private createSink(turnId: string, conversationId: string | null, chatId: number): TurnSink {
    return {
      channelId: 'telegram',
      turnId,
      conversationId,
      onSegment: (segment) => {
        const active = this.activeByChat.get(chatId)
        // Only our own turn's segments — a late emit from an aborted
        // predecessor must not chain into the successor's render queue.
        if (active && active.turnId === turnId) {
          active.renderChain = active.renderChain
            .then(() => this.renderSegment(chatId, segment))
            // Mirror AFTER the render so the snapshot sees the freshly
            // appended segment + accumulated prose. Throttled internally.
            .then(() => this.scheduleMirror(chatId, turnId))
        }
      },
      onTurnEvent: <E extends keyof CorpusEvents>(type: E, payload: CorpusEvents[E]): void => {
        const active = this.activeByChat.get(chatId)
        if (!active || active.turnId !== turnId) return
        // Accumulate tokenomics for the persisted context-meter stats.
        active.stats.note(type, payload)
        if (type === 'task.created') {
          const task = payload as CorpusEvents['task.created']
          if (task.taskId) active.taskId = task.taskId
        }
      },
      onApprovalRequest: (req) => this.handleApprovalRequest(chatId, turnId, req),
      onAskUserRequest: (req) => this.handleAskRequest(chatId, turnId, req),
      onDone: () => {
        const active = this.activeByChat.get(chatId)
        if (active && active.turnId === turnId) {
          active.renderChain = active.renderChain.then(() => this.flushFinalText(chatId))
        } else if (!active) {
          void this.flushFinalText(chatId)
        }
      },
      onError: (error) => {
        void this.sendPlain(chatId, `⚠️ ${truncateForTelegram(error)}`)
      },
      onCredentialBlocked: () => {
        // The runner already pushed the canned reply through onSegment;
        // nothing extra to do here.
      }
    }
  }

  private async renderSegment(chatId: number, segment: Segment): Promise<void> {
    const active = this.activeByChat.get(chatId)
    if (!active) return
    // A late segment from an aborted predecessor turn on this chat must not
    // bleed into the successor's transcript.
    if (segment.turnId !== active.turnId) return

    // Persist EVERY segment in turn order. The in-app chat replays
    // assistant messages from this list (text + tool cards + chips),
    // so dropping any of them would degrade the history view —
    // tool calls would disappear, approvals would orphan, etc.
    // Workflow/task snapshots supersede each other — keep only the latest
    // per run/task or a long run persists hundreds of full snapshots.
    foldSegment(active.segments, segment)

    // The todo checklist is an in-app card; on a chat channel the model's
    // own narration carries progress, so the segment persists but sends nothing.
    if (segment.kind === 'todo') return

    if (segment.kind === 'workflow') {
      await this.renderWorkflowUpdate(chatId, segment.snapshot)
      return
    }

    if (segment.kind === 'task') {
      // One compact heads-up when a video generation starts — the channel
      // has no task card, so this is what tells the user a multi-minute job
      // is underway. 'submitted' occurs exactly once per task, so this can't
      // double-send. Terminal delivery is the model's job (video_await →
      // telegram_send_video), with the manager's fallback covering a dead
      // turn — announcing it here too would message every video twice.
      if (segment.snapshot.status === 'submitted') {
        const video = segment.snapshot.video
        const mins = Math.max(1, Math.round(segment.snapshot.estimateSeconds / 60))
        const facts = video ? ` (${video.resolution}, ${video.durationSeconds}s)` : ''
        await this.sendPlain(
          chatId,
          `🎬 Generating video: ${segment.snapshot.title}${facts} — about ${mins} min. I'll send it here when it's ready.`
        )
      }
      return
    }

    if (segment.kind === 'text') {
      // LEGACY: worker-tagged segments only exist in conversations persisted
      // by the removed Orchestrator mode — never render them (subagent output
      // was the master's input, not the user's).
      if (segment.worker) return
      await this.flushPendingActiveModel(chatId)
      active.textBuffer += segment.delta
      active.assistantContent += segment.delta
      return
    }

    if (segment.kind === 'tool_call') {
      // Flush any prose preceding the tool call so the message order
      // in Telegram matches the model's output: "here's what I'm
      // thinking … now running tool …". The typing indicator stays
      // live via the per-turn heartbeat. Render the call as a
      // headline with monospace args underneath — the heading is
      // bold so it's scannable, the args go in <pre> so JSON
      // structure stays legible.
      active.toolCallNames.set(segment.toolCallId, segment.name)
      active.toolTimings.set(segment.toolCallId, { startedAt: Date.now() })
      if (segment.worker) return // LEGACY orchestrator-mode segments — see text branch
      await this.flushPendingActiveModel(chatId)
      await this.flushBufferedText(chatId)
      // ask_user posts its own formatted question via onAskUserRequest — never
      // surface the raw tool call (even in verbose), or the question doubles up.
      if (segment.name === ASK_USER_TOOL) return
      // offer_options carries its whole card in the ARGS — there is no result
      // to render later — so it posts here, in clean and verbose alike: it is
      // content the model produced FOR the user, not tool mechanics. One
      // message per option, each body in a <pre> block, which is the closest
      // Telegram has to the in-app copy button (tap to copy).
      if (segment.name === OFFER_OPTIONS_TOOL) {
        await this.sendOptionsCard(chatId, segment.args)
        return
      }
      // The master's workflow tools never render as cards (even in verbose) —
      // the workflow snapshot messages above are their surface. Prose was
      // already flushed, so ordering stays: narration → phase updates.
      if (WORKFLOW_TOOL_NAMES.has(segment.name)) return
      // Clean feed: skip the tool-call card. Prose preceding the call has
      // already been flushed above; bookkeeping (names/timings) stands so a
      // file-bearing result can still render its heading.
      if (!active.verbose) return
      const heading = `⚙️ <b>${escapeHtml(segment.name)}</b>`
      const args = formatArgsForTelegram(segment.args)
      const html = args.length > 0 ? `${heading}\n<pre>${escapeHtml(args)}</pre>` : heading
      await this.sendHtml(chatId, html)
      return
    }

    if (segment.kind === 'tool_result') {
      const timing = active.toolTimings.get(segment.toolCallId)
      if (timing) timing.endedAt = Date.now()
      const icon =
        segment.status === 'success'
          ? '✅'
          : segment.status === 'denied'
            ? '❌'
            : segment.status === 'stopped'
              ? '⏹️'
              : '⚠️'
      if (segment.worker) return // LEGACY orchestrator-mode segments — see text branch
      const name = active.toolCallNames.get(segment.toolCallId)
      // ask_user's result is the user's own answer, already acknowledged inline
      // when they replied — don't echo it back as a tool-result block.
      if (name === ASK_USER_TOOL) return
      // The options card already posted from the call; its result is a
      // one-line confirmation written for the model, never for the user.
      if (name === OFFER_OPTIONS_TOOL) return
      // Workflow tool results are the master's input — the card/phase
      // messages are the user surface.
      if (name && WORKFLOW_TOOL_NAMES.has(name)) return
      const heading = name ? `${icon} <b>${escapeHtml(name)}</b>` : icon
      const output = segment.output?.trim() ?? ''
      // An stt_* result's file payload is the user's SOURCE recording (an
      // input, already transcribed), never a deliverable — so its audio path
      // must not be echoed back as a voice message below.
      const isSttResult = name?.startsWith('stt_') ?? false
      // One voice memo reply per turn: suppress a redone voice_respond no matter
      // which send path it would take (parsed voice branch OR the av fallback).
      // Gated on success so the dedup only ever suppresses a *successful*
      // re-send; a FAILED voice_respond isn't deduped here — in verbose it
      // surfaces as an error, on the clean feed it's dropped by the gate below.
      // voice_generate assets are unaffected and always delivered.
      if (name === 'voice_respond' && active.voiceReplySent && segment.status === 'success') {
        return
      }

      // voice_respond / voice_generate produce a JSON blob whose only
      // useful payload is the MP3 path — render a clean result line
      // and send the audio file as a native Telegram audio message
      // instead of dumping the JSON as a code block.
      if (segment.status === 'success' && (name === 'voice_respond' || name === 'voice_generate')) {
        const voice = parseVoiceToolOutput(output)
        if (voice) {
          if (name === 'voice_respond') active.voiceReplySent = true
          await this.sendHtml(chatId, heading)
          await this.sendVoiceAudio(chatId, voice)
          return
        }
      }

      const imagePaths = extractWolffishMediaPaths(output)
      if (imagePaths.length > 0) {
        for (const imgPath of imagePaths) {
          await this.sendImageFile(chatId, imgPath)
        }
        const remaining = stripWolffishMediaMarkdown(output).trim()
        if (remaining.length > 0) {
          const cleanRemaining = markdownToPlain(remaining)
          await this.sendHtml(
            chatId,
            `${heading}\n<pre>${escapeHtml(truncateToolOutput(cleanRemaining))}</pre>`
          )
        }
        return
      }

      const docPaths = extractDocumentPaths(output)
      if (docPaths.length > 0) {
        await this.sendHtml(chatId, heading)
        for (const docPath of docPaths) {
          await this.sendDocumentFile(chatId, docPath)
        }
        return
      }

      const avPaths = isSttResult ? [] : extractAudioVideoPaths(output)
      if (avPaths.length > 0) {
        await this.sendHtml(chatId, heading)
        for (const av of avPaths) {
          if (av.type === 'audio') {
            await this.sendAudioFile(chatId, av.path)
          } else {
            await this.sendVideoFile(chatId, av.path)
          }
        }
        // Mark the single voice reply as delivered even on this fallback path.
        if (name === 'voice_respond') active.voiceReplySent = true
        return
      }

      // Generic files (any extension) explicitly delivered via send_file —
      // upload them as native documents.
      const filePaths = extractGenericFilePaths(output)
      if (filePaths.length > 0) {
        await this.sendHtml(chatId, heading)
        for (const filePath of filePaths) {
          await this.sendDocumentFile(chatId, filePath)
        }
        return
      }

      // Clean feed: file-bearing results already returned above (their delivery
      // branches don't check verbose). Everything reaching here is tool
      // mechanics — skip it whether it succeeded, failed, or was denied. The
      // clean feed relays only agent prose and delivered files; tool activity,
      // including errors, is verbose-only. (The model still receives the full
      // result in its context — this gate only affects what the channel shows.)
      if (!active.verbose) return

      if (output.length === 0) {
        await this.sendHtml(chatId, heading)
        return
      }
      // Wrap every tool result in <pre> so shell-style output
      // (ffmpeg, file reads, git diffs) keeps its monospace
      // structure. Strip Markdown markup first so reflective tools
      // like wolffish_status — whose output is itself Markdown —
      // don't surface literal `**` and `##` characters inside the
      // code block. Plain non-markdown output is unaffected by the
      // strip pass.
      const cleaned = markdownToPlain(output)
      const truncated = truncateToolOutput(cleaned)
      await this.sendHtml(chatId, `${heading}\n<pre>${escapeHtml(truncated)}</pre>`)
      return
    }

    if (segment.kind === 'compaction') {
      // Clean feed: compaction is internal activity, not a result.
      if (!active.verbose) return
      const saved =
        segment.tokensSaved >= 1000
          ? `${Math.round(segment.tokensSaved / 1000)}k`
          : String(segment.tokensSaved)
      const model = segment.details[0]?.compactedBy
      const via = model && model !== 'truncate' ? ` via ${escapeHtml(model)}` : ''
      const html =
        `🗜️ <b>Context compacted</b> — ${segment.targetsCount}` +
        ` message${segment.targetsCount !== 1 ? 's' : ''} compacted, ` +
        `~${saved} tokens saved${via}`
      await this.sendHtml(chatId, html)
      return
    }

    if (segment.kind === 'turn_end') {
      active.stopReason = segment.stopReason
      // Flush any remaining text. onDone is also called by the runner
      // after this — flushing here covers tool-only turns where the
      // model produced no trailing text after the last tool call.
      // Drop any pending model chip — the iteration ended without
      // committing real content (e.g. silent wrap-up after voice_respond).
      active.pendingActiveModel = null
      await this.flushBufferedText(chatId)
      return
    }

    if (segment.kind === 'active_model') {
      // Defer the chip until the iteration commits real content
      // (text or a tool call). Skips silent wrap-up iterations that
      // would otherwise leave a stray "🤖 model" message at the end.
      active.pendingActiveModel = segment.model
      return
    }
  }

  private async flushPendingActiveModel(chatId: number): Promise<void> {
    const active = this.activeByChat.get(chatId)
    if (!active) return
    // Clean feed: the model chip is activity, not content — drop it.
    if (!active.verbose) {
      active.pendingActiveModel = null
      return
    }
    const model = active.pendingActiveModel
    if (!model) return
    active.pendingActiveModel = null
    if (model === active.lastFlushedModel) return
    active.lastFlushedModel = model
    await this.sendHtml(chatId, `🤖 <b>${escapeHtml(model)}</b>`)
  }

  private async sendVoiceAudio(
    chatId: number,
    voice: { filePath: string; fileName: string }
  ): Promise<void> {
    if (!this.bot) return
    const resolved = path.resolve(voice.filePath)
    const active = this.activeByChat.get(chatId)
    if (active?.sentFiles.has(resolved)) return
    try {
      const buffer = await fs.readFile(voice.filePath)
      const file = new InputFile(buffer, voice.fileName || path.basename(voice.filePath))
      await this.bot.api.sendAudio(chatId, file)
      active?.sentFiles.add(resolved)
    } catch (err) {
      await this.sendHtml(
        chatId,
        `⚠️ Failed to send voice memo: ${escapeHtml(err instanceof Error ? err.message : String(err))}`
      )
    }
  }

  /**
   * Refuse an upload Telegram would reject anyway, WITHOUT reading it first.
   *
   * The 50 MB ceiling used to live in the send_file tool, which meant the
   * in-app chat and the CLI — neither of which has any such limit — inherited
   * a bot API's constraint. It belongs here, where the limit actually is. But
   * moving it also removed the thing that was keeping `fs.readFile` below
   * from being handed a 2 GB file: nothing else checked. So the size check is
   * a stat, ahead of the read, and the user is told where the file still is.
   */
  private async guardUploadSize(chatId: number, filePath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(filePath)
      if (stat.size <= TELEGRAM_UPLOAD_LIMIT) return true
      await this.sendPlain(
        chatId,
        `📎 ${path.basename(filePath)} is ${formatBytes(stat.size)} — over Telegram's ${formatBytes(TELEGRAM_UPLOAD_LIMIT)} upload limit. It is saved at ${filePath}.`
      )
      return false
    } catch {
      return false
    }
  }

  private async sendImageFile(chatId: number, filePath: string): Promise<void> {
    if (!this.bot) return
    const resolved = path.resolve(filePath)
    const active = this.activeByChat.get(chatId)
    if (active?.sentFiles.has(resolved)) return
    if (!(await this.guardUploadSize(chatId, resolved))) return
    try {
      const buffer = await fs.readFile(filePath)
      const file = new InputFile(buffer, path.basename(filePath))
      const ext = path.extname(filePath).toLowerCase()
      if (ext === '.gif') {
        await this.bot.api.sendAnimation(chatId, file)
      } else {
        await this.bot.api.sendPhoto(chatId, file)
      }
      active?.sentFiles.add(resolved)
    } catch {
      // best-effort — file may not exist or bot may have dropped
    }
  }

  private async sendDocumentFile(chatId: number, filePath: string): Promise<void> {
    if (!this.bot) return
    const resolved = path.resolve(filePath)
    const active = this.activeByChat.get(chatId)
    if (active?.sentFiles.has(resolved)) return
    if (!(await this.guardUploadSize(chatId, resolved))) return
    try {
      const buffer = await fs.readFile(filePath)
      const file = new InputFile(buffer, path.basename(filePath))
      const sent = await this.bot.api.sendDocument(chatId, file)
      this.trackMessageId(chatId, sent.message_id)
      active?.sentFiles.add(resolved)
    } catch {
      // best-effort
    }
  }

  private async sendAudioFile(chatId: number, filePath: string): Promise<void> {
    if (!this.bot) return
    const resolved = path.resolve(filePath)
    const active = this.activeByChat.get(chatId)
    if (active?.sentFiles.has(resolved)) return
    if (!(await this.guardUploadSize(chatId, resolved))) return
    try {
      const buffer = await fs.readFile(filePath)
      const file = new InputFile(buffer, path.basename(filePath))
      await this.bot.api.sendAudio(chatId, file)
      active?.sentFiles.add(resolved)
    } catch {
      // best-effort
    }
  }

  private async sendVideoFile(chatId: number, filePath: string): Promise<void> {
    if (!this.bot) return
    const resolved = path.resolve(filePath)
    const active = this.activeByChat.get(chatId)
    if (active?.sentFiles.has(resolved)) return
    try {
      // Telegram's bot API refuses uploads over 50 MB. A generated 2K video
      // can approach that, so an oversized file is re-encoded to fit and
      // sent with a note — the original quality stays available in the app.
      // The original file on disk is never modified.
      // Stat first: an oversized video is COMPRESSED rather than refused, and
      // the compressor works from the path — reading the original into memory
      // just to measure it would be the one case where a multi-GB file did
      // land in RAM. (The send_file tool no longer caps at 50 MB; that limit
      // is Telegram's and now lives entirely on this side.)
      const original = await fs.stat(resolved)
      let buffer: Buffer
      let caption: string | undefined
      if (original.size > TELEGRAM_UPLOAD_LIMIT) {
        await this.agent.cerebellum.ensureSystemTool('ffmpeg')
        const compressed = await compressVideoToLimit(
          resolved,
          TELEGRAM_UPLOAD_LIMIT - 2 * 1024 * 1024
        )
        if ('error' in compressed) {
          await this.sendPlain(
            chatId,
            `🎬 ${path.basename(resolved)} is ${(original.size / 1024 / 1024).toFixed(0)} MB — too large for Telegram and compression failed (${compressed.error}). The full-quality video is in the app.`
          )
          return
        }
        buffer = compressed.mp4
        caption = `⚖️ ${compressed.note} — original quality is available in the app.`
      } else {
        buffer = await fs.readFile(resolved)
      }
      const file = new InputFile(buffer, path.basename(resolved))
      await this.bot.api.sendVideo(chatId, file, caption ? { caption } : undefined)
      active?.sentFiles.add(resolved)
    } catch (err) {
      // A silent drop here means the user was promised a video and got
      // nothing — say what happened instead.
      const detail = err instanceof Error ? err.message : String(err)
      await this.sendPlain(
        chatId,
        `🎬 Sending ${path.basename(resolved)} failed (${detail}). The video is available in the app.`
      ).catch(() => undefined)
    }
  }

  /**
   * Turn a workflow snapshot into channel progress messages by diffing it
   * against the last seen snapshot: run start (with the plan), phase
   * start/completion (always sent — the channel has no card, these ARE the
   * workflow surface), per-agent landings (also always sent — the workflow
   * panel surfaces in ALL modes, the clean feed never suppresses it), and the
   * closing summary. Deterministic: everything derives from harness telemetry.
   */
  private async renderWorkflowUpdate(chatId: number, snapshot: WorkflowSnapshot): Promise<void> {
    const active = this.activeByChat.get(chatId)
    if (!active) return
    const prev = active.workflowState.get(snapshot.workflowId)
    active.workflowState.set(snapshot.workflowId, snapshot)
    // Master narration lands before the progress it precedes.
    await this.flushBufferedText(chatId)
    const phaseTitles = snapshot.phases.map((p) => p.title)
    if (!prev) {
      const planLine = phaseTitles.length > 0 ? `\n${escapeHtml(phaseTitles.join(' → '))}` : ''
      const noteLine = snapshot.note ? `\n<i>${escapeHtml(snapshot.note)}</i>` : ''
      await this.sendHtml(chatId, `🔀 <b>Workflow started</b>${planLine}${noteLine}`)
    } else {
      const prevPlan = prev.phases.map((p) => p.title).join('|')
      if (phaseTitles.length > 0 && prevPlan !== phaseTitles.join('|')) {
        await this.sendHtml(chatId, `🔀 <b>Plan</b>: ${escapeHtml(phaseTitles.join(' → '))}`)
      }
    }
    const prevPhase = new Map((prev?.phases ?? []).map((p) => [p.title, p.status]))
    const total = snapshot.phases.length
    // Phase transitions announce only while the run is LIVE — the terminal
    // snapshot flips statuses in bulk (agentless greening, cancel sweeps),
    // which would read as a spurious phase burst before the summary line.
    for (let i = 0; snapshot.status === 'running' && i < snapshot.phases.length; i++) {
      const ph = snapshot.phases[i]
      const before = prevPhase.get(ph.title)
      if (ph.status === 'active' && before !== 'active') {
        await this.sendHtml(chatId, `▶️ <b>Phase ${i + 1}/${total}</b>: ${escapeHtml(ph.title)}`)
      } else if (ph.status === 'done' && before === 'active') {
        const count = snapshot.agents.filter((a) => a.phase === ph.title).length
        await this.sendHtml(
          chatId,
          `✅ <b>Phase ${i + 1}/${total} done</b>: ${escapeHtml(ph.title)} (${count} agent${count === 1 ? '' : 's'})`
        )
      }
    }
    // Per-agent landings belong to the workflow panel, which surfaces in ALL
    // modes and channels — the clean feed's tool-card suppression never applies
    // to the workflow surface — so these are NOT verbose-gated. `prev` guards
    // the diff (the first snapshot has nothing to diff against).
    if (prev) {
      const before = new Map(prev.agents.map((a) => [a.id, a.status]))
      for (const a of snapshot.agents) {
        const b = before.get(a.id)
        const landed = a.status === 'completed' || a.status === 'failed' || a.status === 'cancelled'
        if (landed && a.status !== b) {
          const icon = a.status === 'completed' ? '✅' : a.status === 'failed' ? '⚠️' : '✖️'
          const secs = a.endedAt ? Math.max(1, Math.round((a.endedAt - a.startedAt) / 1000)) : 0
          await this.sendHtml(
            chatId,
            `${icon} <b>${escapeHtml(a.name)}</b> · ${escapeHtml(`${a.provider}/${a.model}`)} — ${a.status}${secs ? ` in ${formatWorkflowDuration(secs)}` : ''} · ${a.toolCalls} tool${a.toolCalls === 1 ? '' : 's'}`
          )
        }
      }
    }
    if (snapshot.status !== 'running' && (!prev || prev.status === 'running')) {
      const secs = Math.max(
        1,
        Math.round(((snapshot.endedAt ?? snapshot.startedAt) - snapshot.startedAt) / 1000)
      )
      const icon =
        snapshot.status === 'completed' ? '🏁' : snapshot.status === 'canceled' ? '✖️' : '⚠️'
      await this.sendHtml(
        chatId,
        `${icon} <b>Workflow ${snapshot.status}</b> — ${snapshot.totals.agents} agent${snapshot.totals.agents === 1 ? '' : 's'} · ${snapshot.totals.toolCalls} tool call${snapshot.totals.toolCalls === 1 ? '' : 's'} · ${formatWorkflowDuration(secs)}`
      )
    }
  }

  private async flushBufferedText(chatId: number): Promise<void> {
    const active = this.activeByChat.get(chatId)
    if (!active) return
    const raw = active.textBuffer
    active.textBuffer = ''

    // The wolffish-media:// scheme is honored here — in the model's OWN
    // prose — because embedding it in markdown is the model's deliberate
    // act of showing an image. Tool results don't get that treatment (see
    // extractWolffishMediaPaths).
    const imagePaths = extractWolffishMediaPaths(raw, { includeMediaScheme: true })
    const cleaned = stripWolffishMediaMarkdown(raw)

    if (cleaned.trim().length > 0) {
      const sentIds: number[] = []
      for (const chunk of splitForTelegram(cleaned)) {
        const id = await this.safeSend(chatId, chunk)
        if (id !== null) sentIds.push(id)
      }
      // Observe-and-notify (never rewrite, never withhold): the block above
      // was DELIVERED exactly as the model wrote it — the delivery guarantee
      // outranks formatting — but if it violates the Telegram contract
      // (leaked Markdown, broken HTML) the model is told on its next
      // iteration via the runner's formatNotices pull, with the message ids
      // so it can telegram_edit_message the damage and write clean HTML in
      // the remaining blocks. Validated on the whole un-split block: a 4096
      // split can cut a tag/marker pair in half and fake a clean chunk.
      const report = validateTelegramHtml(cleaned)
      if (!report.ok) {
        const issues = report.issues.slice(0, 3).join(' ')
        const ids = sentIds.length > 0 ? ` (message_id ${sentIds.join(', ')})` : ''
        active.formatNotices.push(
          `⚠️ Channel formatting: your prose was already DELIVERED to the user's Telegram chat${ids} with raw markup — ${issues} EVERY prose block you write in this conversation, including narration between tool calls, goes verbatim to their phone as a Telegram message (Telegram HTML only, NEVER Markdown). If the delivered text matters, repair it now with telegram_edit_message; either way write clean Telegram HTML in every remaining prose block.`
        )
      }
    }
    for (const imgPath of imagePaths) {
      await this.sendImageFile(chatId, imgPath)
    }
  }

  /**
   * Drain every parked channel-format notice for this chat — the pull end
   * of the observe-and-notify loop (TurnSendOptions.formatNotices). Merges
   * notices carried over from a previous turn (a leak in the final prose
   * block has no next iteration inside its own turn) with the live turn's.
   */
  private drainFormatNotices(chatId: number): string[] {
    const pending = this.pendingFormatNotices.get(chatId) ?? []
    this.pendingFormatNotices.delete(chatId)
    const active = this.activeByChat.get(chatId)
    const live = active ? active.formatNotices.splice(0) : []
    return [...pending, ...live]
  }

  private async flushFinalText(chatId: number): Promise<void> {
    await this.flushBufferedText(chatId)
  }

  private handleApprovalRequest(
    chatId: number,
    turnId: string,
    req: ApprovalRequest & { id: string }
  ): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      const active = this.activeByChat.get(chatId)
      // Requesting turn must still own this chat's slot — a stale request
      // from an aborted predecessor fails closed instead of hijacking the
      // successor's pending-approval state.
      if (!active || active.turnId !== turnId) {
        resolve('denied')
        return
      }

      // Drop any prior pending approval from a previous tool call —
      // the new one supersedes it. The earlier resolver fires denied
      // so the prior amygdala await unwinds cleanly.
      if (active.pendingApprovalResolve) {
        active.pendingApprovalResolve('denied')
        // Mark the superseded approval as denied so the saved
        // history reflects what actually happened.
        const prior = active.pendingApprovalId
        if (prior) {
          const stored = active.approvals.get(prior)
          if (stored && !stored.decision) stored.decision = 'denied'
        }
      }
      active.pendingApprovalId = req.id
      active.pendingApprovalResolve = resolve

      // Stash the approval data in the turn record so the in-app
      // history view can show the same approval card the live
      // Electron flow would. Decision stays undefined here and
      // gets back-filled when the user sends /approve or /deny.
      active.approvals.set(req.id, {
        approvalId: req.id,
        toolCallId: req.toolCall.id,
        tool: req.toolCall.name,
        args: req.toolCall.args,
        reason: req.reason,
        level: req.level,
        description: req.description
      })

      const args = formatArgsForTelegram(req.toolCall.args)
      const parts: string[] = [`🔒 <b>Approval required:</b> ${escapeHtml(req.toolCall.name)}`]
      if (req.description?.title) parts.push(escapeHtml(req.description.title))
      if (req.description?.description) parts.push(escapeHtml(req.description.description))
      if (req.reason) parts.push(`<b>Reason:</b> ${escapeHtml(req.reason)}`)
      if (args.length > 0) parts.push(`<pre>${escapeHtml(args)}</pre>`)
      parts.push('Send /approve or /deny.')
      void this.sendHtml(chatId, parts.join('\n\n'))
    })
  }

  /**
   * Ask the user multiple-choice question(s) and resolve once they've
   * answered them all. Questions are posted one at a time as numbered
   * lists; each next message answers the current one (a number picks an
   * option, other text becomes custom instructions), and the request
   * resolves with every answer once the last question is done. Mirrors
   * handleApprovalRequest — the resolver lives on the active turn and is
   * fired by resolvePendingAsk / drained canceled at turn end.
   */
  private handleAskRequest(
    chatId: number,
    turnId: string,
    req: AskUserRequest & { id: string }
  ): Promise<AskUserResponse> {
    return new Promise<AskUserResponse>((resolve) => {
      const active = this.activeByChat.get(chatId)
      if (!active || active.turnId !== turnId || req.questions.length === 0) {
        resolve({ kind: 'canceled' })
        return
      }
      // A new request supersedes any prior unanswered one.
      if (active.pendingAskResolve) active.pendingAskResolve({ kind: 'canceled' })
      active.pendingAsk = { id: req.id, questions: req.questions, current: 0, answers: [] }
      active.pendingAskResolve = resolve
      void this.sendHtml(chatId, formatAskQuestionHtml(req.questions[0], 0, req.questions.length))
    })
  }

  /** Interpret the user's reply to the current outstanding ask_user question. */
  private async resolvePendingAsk(chatId: number, active: ActiveTurn, text: string): Promise<void> {
    const pending = active.pendingAsk
    const resolve = active.pendingAskResolve
    if (!pending || !resolve) return
    const question = pending.questions[pending.current]
    const n = question.options.length
    const outcome = interpretAskReply(text, n, question.allowOther)

    if (outcome.kind === 'reprompt') {
      // Keep the question pending and tell the user how to answer.
      await this.safeSend(
        chatId,
        outcome.reason === 'out-of-range'
          ? `⚠️ That isn't one of the options (1–${n}). Reply with a valid number${question.allowOther ? ', or type your own instructions' : ''}.`
          : `Please reply with a number between 1 and ${n}.`
      )
      return
    }

    pending.answers.push(
      outcome.kind === 'option'
        ? { kind: 'option', index: outcome.index }
        : { kind: 'custom', text: outcome.text }
    )

    // Last answer in: resolve BEFORE the ack so the agent loop resumes
    // without waiting on a Telegram roundtrip (same ordering as before).
    const finished = pending.current + 1 >= pending.questions.length
    if (finished) {
      active.pendingAsk = null
      active.pendingAskResolve = null
      resolve({ kind: 'answered', answers: pending.answers })
    }

    if (outcome.kind === 'option') {
      // Escaped like the question card itself — a label whose plain text
      // mentions something tag-shaped must render identically in both.
      await this.sendHtml(
        chatId,
        `✅ Option ${outcome.index + 1}: ${escapeHtml(question.options[outcome.index].label)}`
      )
    } else {
      await this.safeSend(chatId, '✅ Got it — using your instructions.')
    }

    // More questions? Post the next one and keep the request pending.
    if (!finished) {
      pending.current++
      await this.sendHtml(
        chatId,
        formatAskQuestionHtml(
          pending.questions[pending.current],
          pending.current,
          pending.questions.length
        )
      )
    }
  }

  /**
   * Send a message VERBATIM with parse_mode HTML. Model prose is
   * already Telegram HTML — the channel overlay (CHANNEL_PROMPTS in
   * runtime/prefrontal.ts) teaches the model the exact tag subset, so
   * nothing rewrites its text here; the model is the formatter.
   * Code-composed callers write plain prose (delivered as-is) or
   * Telegram HTML themselves.
   *
   * If Telegram rejects the HTML (bad tag, unclosed pair, bare `<`),
   * falls back to the same text with known Telegram tags stripped so
   * the user still sees the content rather than nothing.
   */
  private async safeSend(chatId: number, text: string): Promise<number | null> {
    // ⚠️ Potential breaking change — the leading zero-width mark may
    // interfere with downstream text matching, hashing, or /command parsing.
    // The mark is derived from the TAG-STRIPPED text: tag names are Latin
    // letters, so scanning raw HTML would give an Arabic reply that opens
    // with <b> a wrong LTR mark — the exact reordering bug the mark exists
    // to prevent.
    const mark = bidiMark(stripHtmlTags(text))
    return this.dispatchSend(chatId, mark + text, mark + stripHtmlTags(text))
  }

  /**
   * Send CODE-composed plain text that embeds arbitrary dynamic content —
   * error strings, report fragments, titles. Entity-escaped so the HTML
   * parse can never reject it (a message mentioning "<pre>" would
   * otherwise bounce and lose that substring to the tag-stripping
   * fallback). Model prose never comes through here — that's safeSend.
   */
  private async sendPlain(chatId: number, text: string): Promise<void> {
    const mark = bidiMark(text)
    await this.dispatchSend(chatId, mark + escapeHtml(text), mark + text)
  }

  /**
   * Send a message that's already in Telegram HTML form. Used for the
   * structured surfaces the channel constructs itself — tool calls,
   * tool results, approval prompts — where wrapping their output in
   * <pre> code blocks is more readable than plain-text monospace
   * approximations. Same fallback semantics as safeSend.
   */
  /**
   * Post an offer_options card as messages. Tabs don't exist here, so every
   * option is sent in order under its letter with the body in a <pre> block;
   * a per-option message also keeps each snippet independently copyable and
   * each send under Telegram's 4096-character ceiling.
   */
  private async sendOptionsCard(chatId: number, args: Record<string, unknown>): Promise<void> {
    const card = renderOptionsForChannel(args)
    if (!card) return
    const heading = card.title
      ? `🗂 <b>${escapeHtml(card.title)}</b>`
      : `🗂 <b>${card.options.length} options to copy</b>`
    await this.sendHtml(chatId, heading)
    for (const option of card.options) {
      const head = `<b>${escapeHtml(option.letter)} · ${escapeHtml(option.title)}</b>`
      const note = option.description ? `\n<i>${escapeHtml(option.description)}</i>` : ''
      const cut = option.truncated ? '\n<i>(shortened — the full version is in the app)</i>' : ''
      await this.sendHtml(chatId, `${head}${note}\n<pre>${escapeHtml(option.content)}</pre>${cut}`)
    }
  }

  private async sendHtml(chatId: number, html: string): Promise<void> {
    await this.dispatchSend(chatId, html, stripHtmlTags(html))
  }

  private async dispatchSend(
    chatId: number,
    html: string,
    plainFallback: string
  ): Promise<number | null> {
    if (!this.bot) return null
    try {
      const sent = await this.bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' })
      this.trackMessageId(chatId, sent.message_id)
      return sent.message_id
    } catch (err) {
      const kind = classifyBotError(err)
      if (kind !== 'send' && kind !== 'unknown') {
        const message = err instanceof Error ? err.message : String(err)
        this.agent.corpus.emit('telegram.error', { kind, message })
        return null
      }
    }
    try {
      const sent = await this.bot.api.sendMessage(chatId, plainFallback)
      this.trackMessageId(chatId, sent.message_id)
      return sent.message_id
    } catch (err) {
      const kind = classifyBotError(err)
      const message = err instanceof Error ? err.message : String(err)
      this.agent.corpus.emit('telegram.error', { kind, message })
      return null
    }
  }
}

/**
 * Telegram caps each message at 4096 characters. Split on paragraph
 * boundaries when possible so a long reply doesn't get sliced
 * mid-sentence; fall back to hard-cut for monolithic blocks.
 */
/** "42s" under 90s, then "3m 20s" — compact wall-clock for workflow messages. */
function formatWorkflowDuration(secs: number): string {
  if (secs < 90) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

function splitForTelegram(text: string): string[] {
  if (text.length <= MESSAGE_LIMIT) return [text]
  const out: string[] = []
  let remaining = text
  while (remaining.length > MESSAGE_LIMIT) {
    const slice = remaining.slice(0, MESSAGE_LIMIT)
    let cut = slice.lastIndexOf('\n\n')
    if (cut < MESSAGE_LIMIT * 0.5) cut = slice.lastIndexOf('\n')
    if (cut < MESSAGE_LIMIT * 0.5) cut = slice.lastIndexOf('. ')
    if (cut < MESSAGE_LIMIT * 0.5) cut = MESSAGE_LIMIT
    out.push(remaining.slice(0, cut).trimEnd())
    remaining = remaining.slice(cut).trimStart()
  }
  if (remaining.length > 0) out.push(remaining)
  return out
}

function truncateForTelegram(text: string): string {
  if (text.length <= MESSAGE_LIMIT) return text
  return text.slice(0, MESSAGE_LIMIT - 1) + '…'
}

const TOOL_OUTPUT_LIMIT = 1500

function truncateToolOutput(text: string): string {
  if (text.length <= TOOL_OUTPUT_LIMIT) return text
  return text.slice(0, TOOL_OUTPUT_LIMIT - 1) + '…'
}

function formatArgsForTelegram(args: Record<string, unknown>): string {
  const entries = Object.entries(args ?? {})
  if (entries.length === 0) return ''
  const parts: string[] = []
  for (const [key, value] of entries) {
    parts.push(`${key}: ${stringifyArg(value)}`)
  }
  return parts.join('\n')
}

function stringifyArg(value: unknown): string {
  if (value == null) return String(value)
  if (typeof value === 'string') {
    if (value.length > 200) return value.slice(0, 199) + '…'
    return value
  }
  try {
    const json = JSON.stringify(value)
    if (json.length > 200) return json.slice(0, 199) + '…'
    return json
  } catch {
    return String(value)
  }
}

/**
 * Extract the leading slash command from a lowercased message, or
 * null if the message isn't a command. Strips bot-username suffixes
 * (`/new@MyBot`) and discards trailing arguments — we only key off
 * the command itself.
 */
/**
 * Strip Telegram-flavored HTML tags and decode the four entities the
 * channel emits. Used as the plain-text fallback for safeSend/sendHtml
 * when Telegram rejects the HTML — the user still sees readable
 * content, just without formatting. Scoped to Telegram's known tag set
 * on purpose: a code-authored error message containing something
 * tag-shaped like "Expected <string>" must not lose text on the
 * fallback path.
 */
const TELEGRAM_TAG =
  /<\/?(?:b|strong|i|em|u|ins|s|strike|del|tg-spoiler|pre|span(?:\s[^>]*)?|a(?:\s[^>]*)?|code(?:\s[^>]*)?|blockquote(?:\s[^>]*)?|tg-emoji(?:\s[^>]*)?|tg-time(?:\s[^>]*)?)>/gi

function stripHtmlTags(html: string): string {
  return html
    .replace(TELEGRAM_TAG, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

/**
 * Render ONE ask_user question as a Telegram HTML message: bold question
 * (with a "Question i of n" line when the request carries several), optional
 * details, a numbered list (label + description), and a hint on how to
 * answer. The free-text "something else" option isn't numbered — the hint
 * tells the user they can just type their own instructions instead.
 */
function formatAskQuestionHtml(q: AskUserQuestion, index: number, total: number): string {
  const parts: string[] = [`❓ <b>${escapeHtml(q.question)}</b>`]
  if (total > 1) parts.push(`<i>Question ${index + 1} of ${total}</i>`)
  if (q.details) parts.push(escapeHtml(q.details))
  const list = q.options
    .map((opt, i) => {
      const head = `<b>${i + 1}.</b> ${escapeHtml(opt.label)}`
      return opt.description ? `${head}\n${escapeHtml(opt.description)}` : head
    })
    .join('\n\n')
  parts.push(list)
  const n = q.options.length
  parts.push(
    q.allowOther
      ? `<i>Reply with a number (1–${n}) to choose — or just type what you'd rather do.</i>`
      : `<i>Reply with a number (1–${n}) to choose.</i>`
  )
  return parts.join('\n\n')
}

/**
 * Render one item in the /resume or /delete picker. Three lines —
 * keycap-numbered title, relative time, message count — matching
 * the layout the user requested. Title is HTML-escaped because it
 * goes through sendHtml without further conversion.
 */
function formatPickerItem(conv: ConversationMeta, index: number): string {
  const numEmoji = keycapNumber(index + 1)
  const title = escapeHtml(truncateTitle(conv.title))
  const when = formatRelativeTime(conv.updatedAt)
  const count = conv.messageCount === 1 ? '1 message' : `${conv.messageCount ?? 0} messages`
  return `${numEmoji} <b>${title}</b>\n${when}\n${count} · ${originLabel(conv.channel)}`
}

/**
 * Plain-English relative time. Telegram users see this in /resume
 * and /delete pickers, so it skews short and human. Anything past
 * a week falls back to a date so old conversations stay legible.
 */
function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp
  if (diffMs < 0) return 'just now'
  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 2) return 'a minute ago'
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 2) return 'an hour ago'
  if (hours < 24) return `${hours} hours ago`
  const days = Math.floor(hours / 24)
  if (days < 2) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return new Date(timestamp).toLocaleDateString()
}

function parseSlashCommand(lower: string): string | null {
  if (!lower.startsWith('/')) return null
  // Take everything up to the first space, then strip @username.
  const head = lower.split(/\s+/, 1)[0]
  const at = head.indexOf('@')
  return at >= 0 ? head.slice(0, at) : head
}

/**
 * The argument tail after a `/command` token, lower-cased and trimmed —
 * parseSlashCommand keeps only the leading token, so `/mode workflow` and
 * `/model opus` need this to recover "workflow" / "opus".
 */
function commandArg(text: string): string {
  const sp = text.trim().search(/\s/)
  return sp === -1
    ? ''
    : text
        .trim()
        .slice(sp + 1)
        .trim()
        .toLowerCase()
}

/** Thrown when the launch handshake (bot.init) outlives LAUNCH_TIMEOUT_MS. */
class LaunchTimeoutError extends Error {
  constructor() {
    super('Telegram launch handshake timed out')
    this.name = 'LaunchTimeoutError'
  }
}

/**
 * Race a promise against a timeout. On timeout the returned promise rejects
 * with LaunchTimeoutError; the underlying promise is left to settle on its
 * own (we just stop waiting on it). The timer is always cleared so a
 * fast-resolving promise doesn't keep the process awake.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LaunchTimeoutError()), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function classifyBotError(err: unknown): CorpusEvents['telegram.error']['kind'] {
  if (err instanceof GrammyError) {
    const code = err.error_code
    // 404 from getMe means Telegram couldn't resolve the bot for the
    // supplied token — i.e. the token is wrong or revoked. Same
    // user-facing meaning as 401/403, just a different status code.
    if (code === 401 || code === 403 || code === 404) return 'token'
    if (code === 429) return 'rate_limit'
    return 'send'
  }
  if (err instanceof HttpError) {
    // grammY wraps non-JSON 4xx responses as HttpError. The auth-shaped
    // codes (401/403/404) still mean the token is bad — message format
    // is `Call to 'getMe' failed! (404: Not Found)`.
    if (/\((?:401|403|404):/.test(err.message ?? '')) return 'token'
    return 'network'
  }
  // Best-effort fallback for wrapped/non-grammy errors.
  const msg = err instanceof Error ? err.message : String(err)
  if (/\((?:401|403|404):/.test(msg)) return 'token'
  return 'unknown'
}

/**
 * Map the corpus error taxonomy onto the user-facing kind set the panel
 * renders. The corpus collapses every auth-shaped failure (401/403/404)
 * into `token`; the panel wants `invalid_token` so it can show a
 * token-specific hint, and a generic `unknown` for everything else.
 */
function mapBotErrorKind(corpusKind: CorpusEvents['telegram.error']['kind']): TelegramErrorKind {
  return corpusKind === 'token'
    ? 'invalid_token'
    : corpusKind === 'rate_limit'
      ? 'rate_limit'
      : corpusKind === 'network'
        ? 'network'
        : 'unknown'
}

/**
 * Loose bot-token shape check. BotFather hands out tokens of the form
 * `<digits>:<35-char base64-ish string>`. Catches the most common
 * paste mistakes (just the API ID, the link without the token, etc.)
 * before we send a doomed request to Telegram.
 */
function isPlausibleBotToken(token: string): boolean {
  return /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token)
}

type ExtractedFile = { fileId: string; fileName?: string; mimeType?: string }

/**
 * Extract the bot-API file id and (best-effort) original name from a
 * telegram message. Telegram exposes different shapes per media kind —
 * this normalizes them so the channel only has to think in terms of
 * "fetch this id, save it as that name".
 */
function extractFileInfo(message: unknown): ExtractedFile | null {
  const m = message as {
    photo?: Array<{ file_id?: string; width?: number; height?: number }>
    video?: { file_id?: string; file_name?: string; mime_type?: string }
    audio?: {
      file_id?: string
      file_name?: string
      title?: string
      performer?: string
      mime_type?: string
    }
    voice?: { file_id?: string; mime_type?: string }
    document?: { file_id?: string; file_name?: string; mime_type?: string }
    message_id?: number
  } | null
  if (!m) return null

  if (m.photo && m.photo.length > 0) {
    // Telegram returns multiple sizes; the last entry is the largest.
    const largest = m.photo[m.photo.length - 1]
    if (!largest?.file_id) return null
    const stamp = m.message_id ?? Date.now()
    return { fileId: largest.file_id, fileName: `photo_${stamp}.jpg` }
  }

  if (m.video?.file_id) {
    return {
      fileId: m.video.file_id,
      fileName: m.video.file_name ?? `video_${m.message_id ?? Date.now()}.mp4`,
      mimeType: m.video.mime_type
    }
  }

  if (m.audio?.file_id) {
    const fallbackTitle =
      [m.audio.performer, m.audio.title].filter(Boolean).join(' - ') ||
      `audio_${m.message_id ?? Date.now()}`
    return {
      fileId: m.audio.file_id,
      fileName: m.audio.file_name ?? `${fallbackTitle}.mp3`,
      mimeType: m.audio.mime_type
    }
  }

  if (m.voice?.file_id) {
    return {
      fileId: m.voice.file_id,
      fileName: `voice_${m.message_id ?? Date.now()}.ogg`,
      mimeType: m.voice.mime_type
    }
  }

  if (m.document?.file_id) {
    return {
      fileId: m.document.file_id,
      fileName: m.document.file_name ?? `document_${m.message_id ?? Date.now()}`,
      mimeType: m.document.mime_type
    }
  }

  return null
}

function defaultFileName(filePath: string): string {
  const base = filePath.split('/').pop() ?? 'upload.bin'
  if (base.length === 0) return 'upload.bin'
  return base
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function parseVoiceToolOutput(output: string): { filePath: string; fileName: string } | null {
  if (!output) return null
  try {
    const parsed = JSON.parse(output)
    const filePath = typeof parsed?.filePath === 'string' ? parsed.filePath : ''
    const fileName = typeof parsed?.fileName === 'string' ? parsed.fileName : ''
    if (!filePath) return null
    return { filePath, fileName: fileName || path.basename(filePath) }
  } catch {
    return null
  }
}

function extractWolffishMediaPaths(
  output: string,
  opts?: { includeMediaScheme?: boolean }
): string[] {
  const paths: string[] = []
  const seen = new Set<string>()

  // Explicit [wolffish-output: path (image)] markers — send_file's transport,
  // i.e. the model's own deliberate delivery act. Line-anchored: a real marker
  // stands on its own line (send_file emits it as the whole output); output
  // that merely QUOTES the template mid-line — grep/cat over code or docs —
  // must never trigger a send.
  const markerRegex = /^[ \t]*\[wolffish-output:[ \t]*([^\]\n]+?)[ \t]+\(image\)\][ \t]*$/gm
  let match: RegExpExecArray | null
  while ((match = markerRegex.exec(output)) !== null) {
    const abs = match[1].trim()
    if (!seen.has(abs)) {
      seen.add(abs)
      paths.push(abs)
    }
  }

  // wolffish-media:// URLs count as a delivery ONLY in the model's own prose
  // (a markdown image embed = the model deliberately showing the image).
  // In tool results they're mere generation — e.g. browser_screenshot's
  // media_url field naming its output — and auto-sending those would ship a
  // file the model never chose to deliver.
  if (opts?.includeMediaScheme) {
    const mediaRegex = /wolffish-media:\/\/([^\s)"]+)/g
    while ((match = mediaRegex.exec(output)) !== null) {
      const abs = path.join(workspaceRoot(), decodeURIComponent(match[1]))
      if (!seen.has(abs)) {
        seen.add(abs)
        paths.push(abs)
      }
    }
  }

  return paths
}

function stripWolffishMediaMarkdown(text: string): string {
  return text
    .replace(/\[wolffish-output:[^\]]+\]/g, '')
    .replace(/!\[[^\]]*\]\(wolffish-media:\/\/[^\s)]+\)/g, '')
    .replace(/(Saved to|Screenshot saved[^.]*) ~?\/[^\s"]+\.(?:png|jpe?g|gif|webp|bmp|tiff?)/gi, '')
    .trim()
}

function extractDocumentPaths(output: string): string[] {
  // MARKER-ONLY by design: the [wolffish-output: … (document)] marker is
  // send_file's transport — the model's explicit delivery act. Bare {path}
  // JSON and prose paths are mere generation; the harness never auto-sends.
  // Line-anchored: a quoted marker template mid-line is not a delivery.
  const paths: string[] = []
  const seen = new Set<string>()
  const home = os.homedir()
  const markerRegex = /^[ \t]*\[wolffish-output:[ \t]*([^\]\n]+?)[ \t]+\(document\)\][ \t]*$/gm
  let markerMatch: RegExpExecArray | null
  while ((markerMatch = markerRegex.exec(output)) !== null) {
    const raw = markerMatch[1].trim()
    const abs = raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw
    if (!seen.has(abs)) {
      seen.add(abs)
      paths.push(abs)
    }
  }
  return paths
}

// Generic files explicitly delivered via send_file carry a `(file)` marker
// (any extension that isn't an image/audio/video/document). `(chart)` — the
// in-app interactive chart-card spec — has no channel rendering, so it rides
// this same path and arrives as a plain document instead of being silently
// dropped. Only the explicit marker is matched — no bare-path fallback — so
// incidental paths in tool output are never mistaken for a delivery.
function extractGenericFilePaths(output: string): string[] {
  const paths: string[] = []
  const seen = new Set<string>()
  const home = os.homedir()
  const markerRegex =
    /^[ \t]*\[wolffish-output:[ \t]*([^\]\n]+?)[ \t]+\((?:file|chart)\)\][ \t]*$/gm
  let match: RegExpExecArray | null
  while ((match = markerRegex.exec(output)) !== null) {
    const raw = match[1].trim()
    const abs = raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw
    if (!seen.has(abs)) {
      seen.add(abs)
      paths.push(abs)
    }
  }
  return paths
}

function extractAudioVideoPaths(output: string): { path: string; type: 'audio' | 'video' }[] {
  const results: { path: string; type: 'audio' | 'video' }[] = []
  const seen = new Set<string>()
  const home = os.homedir()

  function resolvePath(p: string): string {
    return p.startsWith('~/') ? path.join(home, p.slice(2)) : p
  }

  // 1. Explicit [wolffish-output: path (audio|video)] markers (line-anchored —
  //    a quoted marker template mid-line is not a delivery)
  const markerRegex = /^[ \t]*\[wolffish-output:[ \t]*([^\]\n]+?)[ \t]+\((audio|video)\)\][ \t]*$/gm
  let match: RegExpExecArray | null
  while ((match = markerRegex.exec(output)) !== null) {
    const abs = resolvePath(match[1].trim())
    if (!seen.has(abs)) {
      seen.add(abs)
      results.push({ path: abs, type: match[2] as 'audio' | 'video' })
    }
  }

  // MARKER-ONLY by design: bare audio/video paths are mere generation, not
  // delivery — the model sends outputs explicitly via send_file/voice tools.

  return results
}

// Re-exported so the IPC layer can include attachment data when
// surfacing already-saved Telegram media to other consumers in
// future phases. Not used yet.
export type { MessageAttachment }
