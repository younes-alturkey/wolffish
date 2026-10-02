import { countdowns } from '@main/runtime/countdown'
import { Boom } from '@hapi/boom'
import {
  assistantSegmentsToHistory,
  buildAssistantMessage,
  replayWindow,
  stubStaleToolResults,
  type MirrorMessageListener,
  type TurnSink
} from '@main/channels/channel'
import { queueConversationSummarization } from '@main/conversation-summarizer'
import type { TurnRunner } from '@main/channels/turn-runner'
import {
  interjectionAckText,
  type Interjection,
  type InterjectionEvent
} from '@main/runtime/agent/interjection'
import {
  getConversationIdForJid,
  setConversationIdForJid
} from '@main/channels/whatsapp/conversations'
import { markdownToPlain } from '@main/channels/format'
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
import { stripInlineMarkup, validateWhatsAppFormat } from '@main/channels/whatsapp/format'
import { GIF_PLAYBACK_MAX_SECONDS, transcodeGifToMp4 } from '@main/channels/whatsapp/gif'
import {
  extractInboundMedia,
  extractTextBody,
  isInboundVoiceNote,
  messageTimestamp,
  shouldProcessMessage,
  type InboundMedia
} from '@main/channels/whatsapp/messages'
import {
  deleteReadHistory,
  flushReadHistory,
  loadReadHistory,
  scheduleReadHistoryFlush
} from '@main/channels/whatsapp/read-history'
import {
  buildWhatsAppCapability,
  WHATSAPP_CAPABILITY_NAME,
  type WhatsAppBufferedMessage
} from '@main/channels/whatsapp/tools'
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
import { interpretAskReply } from '@main/channels/ask-reply'
import { bindChatToConversation } from '@main/channels/chat-binding'
import type { Agent } from '@main/runtime/agent'
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
  upsertTaskSegment,
  upsertCountdownSegment,
  upsertWaitSegment,
  upsertToolResultSegment,
  upsertProcessSegment,
  upsertTodoSegment,
  appendTextSegment,
  upsertWorkflowSegment,
  WORKFLOW_TOOL_NAMES,
  type Segment,
  type SegmentTurnEndReason,
  type WorkflowSnapshot
} from '@main/runtime/broca'
import { turnScope, type CorpusEvents } from '@main/runtime/corpus'
import { TurnStatsCollector } from '@main/channels/turn-stats'
import type { LocalProvider } from '@main/runtime/providers/local'
import { composeAttachmentContext } from '@main/uploads/compose-attachments'
import { saveUploadFromBuffer } from '@main/uploads/uploads'
import {
  getWhatsAppConfig,
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
  WhatsAppConfig
} from '@preload/index'
import {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isHostedLidUser,
  isHostedPnUser,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
  type BaileysEventMap,
  type proto,
  type WAMessage,
  type WASocket
} from '@whiskeysockets/baileys'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pino from 'pino'

export type WhatsAppConnectionStatus = 'disconnected' | 'connecting' | 'qr' | 'connected' | 'error'

export type WhatsAppChannelStatus = {
  status: WhatsAppConnectionStatus
  error: string | null
  qr: string | null
  /**
   * The 8-character code WhatsApp shows under "Link with phone number
   * instead", when linking was started that way rather than by QR.
   *
   * It exists because a QR does not fit a terminal. A WhatsApp code is ~215
   * characters, which is a 49×49 matrix even at the lowest error correction —
   * 27 printed rows before the caption, against the 24 an SSH window gives
   * you. On the headless box this channel is most useful on, the square is
   * unscannable no matter how it is drawn, and this is the route that works.
   */
  pairingCode: string | null
  connectedPhone: string | null
  connectedName: string | null
  /**
   * Whether an established (linked) session exists. True means a
   * `connecting` status is a reconnect of an already-paired account, not
   * first-time pairing — the UI shows just a pulsing dot instead of the
   * QR box in that case.
   */
  hasSession: boolean
}

type WhatsAppErrorKind = 'auth' | 'network' | 'crypto' | 'stream' | 'unknown'

const RECONNECT_INITIAL_MS = 2000
const RECONNECT_MAX_MS = 30000
const RECONNECT_FACTOR = 1.8
const RECONNECT_JITTER = 0.25
const RECONNECT_MAX_ATTEMPTS = 12

const STALE_DEFAULT_HOURS = 3

// Ceiling for a single inbound media download. WhatsApp itself allows up to
// ~2 GB documents, but the whole blob is buffered in memory before it's
// written, so we decline anything larger with a friendly note rather than
// risk the main process. Matches the in-app 1 GB per-message upload budget.
const MAX_WHATSAPP_MEDIA_BYTES = 1024 * 1024 * 1024

const BUSY_SYSTEM_PROMPT =
  "You are a friendly assistant currently working on a previous task for the user. The user has just sent a NEW message but you cannot address it yet — another task is still running. Reply briefly (1-2 short sentences) acknowledging their new message and politely asking them to wait. Do NOT attempt to answer their question, perform any action, or speculate about an answer. Just say you're busy and will get to it. Be warm and natural. Write plain conversational text only — no Markdown, no formatting markup of any kind (your reply is delivered verbatim to a phone chat)."
const BUSY_REPLY_TIMEOUT_MS = 8000
const FALLBACK_BUSY_REPLY = "Hold on — I'm working on something. I'll get back to you in a moment."

const COMMANDS_HELP =
  '/stop — stop the current task\n' +
  '/cancel — drop messages waiting in the queue\n' +
  '/new — start a fresh conversation\n' +
  '/resume — continue a previous chat\n' +
  '/delete — delete a saved conversation\n' +
  '/current — show the active conversation\n' +
  '/status — system status report\n' +
  '/mode — single or workflow mode\n' +
  '/model — pick the cloud model\n' +
  '/project — pick or exit a project\n' +
  '/local — switch to local model\n' +
  '/cloud — switch to cloud model'

/**
 * Min gap between live in-app mirror snapshots of an in-flight turn — bursts
 * of segments coalesce into at most one broadcast per window, a trailing timer
 * guarantees the last state lands, and the end-of-turn drain emits one final
 * un-throttled snapshot. Matches the Telegram twin.
 */
const MIRROR_THROTTLE_MS = 500

/**
 * How long a queue flush waits for the chat to come free before giving up on
 * the head message, and how many consecutive failed starts of the SAME message
 * it tolerates. Mirrors the Telegram twin — including the rule that a message
 * parked behind OUR OWN running turn starts no flush at all (see
 * enqueueMessage), so this budget never has to cover the length of a turn.
 */
const QUEUE_FLUSH_WAIT_MS = 30_000
const QUEUE_FLUSH_POLL_MS = 50
const QUEUE_FLUSH_ATTEMPTS = 3

/**
 * One message parked while this jid's turn was running. Everything the
 * dispatcher needs and nothing else — attachments are already downloaded and
 * on disk (see channels/message-queue.ts for why that cannot be deferred).
 */
type QueuedWhatsAppMessage = QueuedMessageBase

type ActiveTurn = {
  jid: string
  /**
   * The owning turn's id. Sink callbacks and the end-of-turn cleanup verify
   * it before touching this state — a late event from an aborted turn on
   * the same jid must never write into (or tear down) its successor's turn.
   */
  turnId: string
  conversation: ConversationFile
  textBuffer: string
  /**
   * Channel-format notices parked for the agent loop — one per flushed
   * prose block that failed validateWhatsAppFormat AFTER it was already
   * delivered (delivery always wins; observe-and-notify, never rewrite).
   * Drained by the formatNotices pull the runner threads to the agent;
   * leftovers at turn end carry over to pendingFormatNotices so the NEXT
   * turn still hears about a leak in the final prose block.
   */
  formatNotices: string[]
  /**
   * Last seen workflow snapshot per run (workflow mode). renderSegment
   * diffs the incoming snapshot against this to derive phase-transition
   * and per-agent progress messages deterministically.
   */
  workflowState: Map<string, WorkflowSnapshot>
  /**
   * Full prose the model produced this turn. Master-only: legacy worker
   * narration stays in `segments` (worker-tagged), never here.
   */
  assistantContent: string
  segments: Segment[]
  approvals: Map<string, PersistedApproval>
  toolTimings: Map<string, PersistedToolTiming>
  stopReason: SegmentTurnEndReason | null
  /**
   * Stable identity for THIS turn's assistant message, minted once at
   * onTurnStarted. The live in-app mirror snapshots and the end-of-turn disk
   * save share this id + timestamp, so the renderer treats them as one
   * growing message instead of appending a duplicate when the file lands.
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
  pendingApprovalResolve: ((decision: ApprovalDecision) => void) | null
  /**
   * Outstanding ask_user request. Questions are posed one message at a
   * time, in order; each inbound message answers the CURRENT question: a
   * number in 1–options.length picks that option; any other text becomes
   * custom instructions ("something else") when allowOther is set. Answers
   * accumulate until every question is answered, then the request resolves
   * with all of them at once.
   */
  pendingAsk: {
    id: string
    questions: AskUserQuestion[]
    current: number
    answers: AskUserAnswer[]
  } | null
  pendingAskResolve: ((response: AskUserResponse) => void) | null
  toolCallNames: Map<string, string>
  pendingActiveModel: string | null
  lastFlushedModel: string | null
  /**
   * Per-turn tokenomics accumulator. Fed every relayed turn event and folded
   * into the conversation's persisted `stats` at end-of-turn so the in-app
   * context-meter card restores real numbers for this WhatsApp conversation
   * instead of a blank gauge. See {@link TurnStatsCollector}.
   */
  stats: TurnStatsCollector
  /**
   * Resolved absolute paths of every file already sent this turn. Prevents the
   * same file being transmitted twice when it's reachable from more than one
   * parse point (e.g. a tool_result AND the trailing prose). Turn-scoped, so a
   * legitimate re-send in a later turn is not suppressed.
   */
  sentFiles: Set<string>
  /**
   * Resolved once at turn start from WhatsAppConfig.verbose. When false
   * (the default), renderSegment relays only agent messages, file-bearing
   * tool results, and errors — every other tool call/result/activity send
   * is skipped. Persistence and ordering are unaffected; this gates the
   * outbound send only.
   */
  verbose: boolean
  /**
   * Set once the turn's voice_respond reply has been sent. A turn delivers at
   * most ONE voice memo reply — a model that responds, then redoes the reply,
   * has the duplicate suppressed. voice_generate assets are unaffected.
   */
  voiceReplySent: boolean
}

/**
 * In-flight conversation picker raised by /resume or /delete. The whole
 * candidate list is snapshotted here when the picker opens — `page` just
 * windows it — and the next number-only reply selects from it.
 */
type PendingSelection =
  | { command: 'resume' | 'delete'; items: ConversationMeta[]; page: number }
  | { command: 'model'; models: ModelOption[] }
  | { command: 'project'; projects: Project[] }

export class WhatsAppChannel {
  private sock: WASocket | null = null
  private status: WhatsAppConnectionStatus = 'disconnected'
  private statusError: string | null = null
  private currentQr: string | null = null
  private reconnectAttempt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private authDir: string | null = null
  private readonly activeByJid = new Map<string, ActiveTurn>()
  /**
   * Channel-format notices whose turn ended before the agent loop could
   * drain them (a leak in the FINAL prose block has no next iteration).
   * Keyed by jid; merged into the next turn's first drain so the model
   * still hears what reached the user's phone. In-memory only — a restart
   * drops them, which is fine: the notice is a correction aid, not a
   * delivery record.
   */
  private readonly pendingFormatNotices = new Map<string, string[]>()
  /**
   * Synchronous per-jid "a turn is being set up" claim. Inbound messages are
   * fired via `void` per upsert with no per-jid serialization, so a batch (a
   * reconnect backlog, or two rapid sends coalesced into one notify) can land
   * two same-jid messages that BOTH pass the arrival gate before either turn
   * starts (activeByJid is only set at onTurnStarted, after the async
   * download/STT/title/queue window). This set is claimed synchronously at the
   * top of dispatchTurn and released once the turn hands off to activeByJid —
   * so the second same-jid dispatch is declined instead of double-dispatching
   * (two conversations, a lost turn, an orphaned ActiveTurn).
   */
  private readonly dispatchingByJid = new Set<string>()
  /**
   * Messages that arrived while this jid's turn was still running. Accepted
   * and dispatched in order as the chat frees up — see
   * channels/message-queue.ts. Drained by flushQueue from the same end-of-turn
   * cleanup that releases the per-jid slot.
   */
  private readonly queue = new ChannelMessageQueue<string, QueuedWhatsAppMessage>()
  /**
   * Jids whose flush loop is already running. The loop is fired from
   * end-of-turn cleanup AND from enqueue (covering the race where a turn ends
   * between the busy check and the park), so it has to be idempotent.
   */
  private readonly flushingByJid = new Set<string>()
  /** Live copy of QUEUE_FLUSH_WAIT_MS — instance state so tests can shorten it. */
  private queueFlushWaitMs = QUEUE_FLUSH_WAIT_MS
  /**
   * The jid behind every message this channel handed to a RUNNING turn
   * (runner.interject), keyed by the interjection's messageId. The runner's
   * lifecycle events carry the conversation, not the chat — and a re-dispatch
   * after a turn-ended sweep has to go back to the jid that sent it. Entries
   * leave on the terminal event (delivered or withdrawn) and on stop().
   */
  private readonly interjectedByMessageId = new Map<string, { jid: string }>()
  /** Unsubscribe for the runner's interjection events; null while stopped. */
  private offInterjection: (() => void) | null = null
  private readonly sentIds = new Set<string>()
  // Delivery-ack tracking. WhatsApp reports a sent message's status via
  // 'messages.update' (ERROR=0, PENDING=1, SERVER_ACK=2, DELIVERY_ACK=3, …).
  // ackStatus holds the highest status seen per message id; ackWaiters holds
  // the callbacks of confirmDelivery() calls still waiting on that id.
  private readonly ackStatus = new Map<string, number>()
  private readonly ackWaiters = new Map<string, Set<(status: number) => void>>()
  private readonly pendingSelections = new Map<string, PendingSelection>()
  private allowedPhoneNumbers: string[] = []
  private readonly lidToPhone = new Map<string, string>()
  private readonly segmentQueue = new Map<string, Promise<void>>()
  private processingEnabled = true
  private qrRequested = false
  /**
   * Set when linking was started by phone number instead of QR. Holds the
   * number until the socket is far enough along to ask WhatsApp for a code,
   * which is the moment the first QR would otherwise have been emitted — that
   * is the earliest point the server will answer a pairing request.
   */
  private pairingNumber: string | null = null
  private pairingCode: string | null = null
  private hadValidSession = false
  private connectedAt = 0
  /**
   * Bumped by stop()/logout. connect() captures it before its async
   * setup and bails if it changed — so a stop() that lands while the
   * version fetch is in flight can't have the late catch (or a
   * just-built socket) resurrect a channel the user deliberately closed.
   */
  private connectGeneration = 0
  /**
   * Wired by index.ts to a renderer broadcast. When set, in-flight turns push
   * live assistant-message snapshots so an in-app viewer of the same
   * conversation mirrors the run as it streams — not only at end-of-turn.
   */
  private mirrorListener: MirrorMessageListener | null = null

  constructor(
    private readonly agent: Agent,
    private readonly runner: TurnRunner,
    private readonly localProvider: LocalProvider
  ) {}

  /**
   * Wire the live in-app mirror. index.ts points this at a renderer
   * broadcast so an open conversation reflects a WhatsApp run as it streams.
   */
  setMessageMirror(listener: MirrorMessageListener | null): void {
    this.mirrorListener = listener
  }

  /** Override the queue-flush wait budget (tests use a short value). */
  setQueueFlushWait(ms: number): void {
    this.queueFlushWaitMs = ms
  }

  /**
   * Emit a throttled live snapshot of the in-flight turn's assistant message
   * (see the Telegram twin for the full rationale). Builds the same message
   * the end-of-turn save persists — same stable id — so the renderer upserts
   * by id and never duplicates it.
   */
  private scheduleMirror(jid: string, turnId: string): void {
    if (!this.mirrorListener) return
    const active = this.activeByJid.get(jid)
    if (!active || active.turnId !== turnId) return
    const conversationId = active.conversation.id
    const emit = (): void => {
      const current = this.activeByJid.get(jid)
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
    if (active.mirrorTimer) return
    active.mirrorTimer = setTimeout(() => {
      const current = this.activeByJid.get(jid)
      if (current) current.mirrorTimer = null
      emit()
    }, MIRROR_THROTTLE_MS - sinceLast)
    active.mirrorTimer.unref?.()
  }

  getStatus(): WhatsAppChannelStatus {
    const user = this.sock?.user
    return {
      status: this.status,
      error: this.statusError,
      qr: this.currentQr,
      pairingCode: this.pairingCode,
      connectedPhone: user?.id ? user.id.split('@')[0].split(':')[0] : null,
      connectedName: user?.notify ?? user?.name ?? null,
      hasSession: this.hadValidSession
    }
  }

  getSocket(): WASocket | null {
    return this.sock
  }

  hasActiveTurn(): boolean {
    return this.activeByJid.size > 0
  }

  abort(): void {
    for (const turn of this.activeByJid.values()) {
      turn.controller.abort()
    }
    this.activeByJid.clear()
    // App-wide abort (quit/shutdown) — dropping the queue here is what keeps a
    // flush from starting a fresh turn on the way out.
    this.queue.clearAll()
    this.flushingByJid.clear()
  }

  updateAllowedPhoneNumbers(numbers: string[]): void {
    this.allowedPhoneNumbers = numbers
  }

  setProcessingEnabled(enabled: boolean): void {
    this.processingEnabled = enabled
  }

  isStarted(): boolean {
    return this.sock !== null
  }

  async start(config: WhatsAppConfig): Promise<WhatsAppChannelStatus> {
    if (!config.enabled) {
      await this.stop('config disabled')
      return this.getStatus()
    }

    this.allowedPhoneNumbers = config.allowedPhoneNumbers ?? []
    this.processingEnabled = true
    this.watchInterjections()
    this.statusError = null
    this.currentQr = null
    this.pairingCode = null
    this.pairingNumber = null

    this.authDir = path.join(workspaceRoot(), 'whatsapp', 'auth')
    await fs.mkdir(this.authDir, { recursive: true })

    const { capability, plugin } = buildWhatsAppCapability({
      getSocket: () => this.sock,
      trackSentId: (id) => this.sentIds.add(id),
      readMessages: (jid, count) => this.readMessages(jid, count),
      ensureFfmpeg: () => this.agent.cerebellum.ensureSystemTool('ffmpeg'),
      confirmDelivery: (id) => this.confirmDelivery(id),
      bindChatToSendingConversation: (jid) => this.bindChatToSendingConversation(jid),
      defaultJid: async () => {
        const cfg = await getWhatsAppConfig()
        const phone = cfg.allowedPhoneNumbers?.[0]?.replace(/[^0-9]/g, '')
        return phone ? `${phone}@s.whatsapp.net` : null
      }
    })
    this.agent.cerebellum.registerInProcessCapability(capability, plugin)

    // Seed the read buffer from disk so whatsapp_read has history from earlier
    // sessions. loadReadHistory never throws; an empty/corrupt file is fine.
    if (this.readBuffer.size === 0) {
      for (const [jid, msgs] of await loadReadHistory()) {
        this.readBuffer.set(jid, msgs)
      }
    }

    const hasAuth = await this.hasAuthCredentials()
    if (hasAuth) {
      this.hadValidSession = true
      this.status = 'connecting'
      await this.connect()
    } else {
      this.status = 'disconnected'
      this.statusError = null
    }
    return this.getStatus()
  }

  async stop(reason?: string): Promise<void> {
    // Invalidate any in-flight connect() so its async tail can't bring
    // the channel back up after we tear it down here.
    this.connectGeneration++
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempt = 0

    if (this.sock) {
      try {
        this.sock.end(undefined)
      } catch {
        // best-effort
      }
      this.sock = null
    }

    for (const turn of this.activeByJid.values()) {
      turn.controller.abort()
      if (turn.pendingApprovalResolve) {
        turn.pendingApprovalResolve('denied')
      }
    }
    this.activeByJid.clear()
    // A disconnected socket must not resurrect a queue on reconnect — the
    // parked messages are still in the user's phone chat if they want them.
    this.queue.clearAll()
    this.flushingByJid.clear()
    this.unwatchInterjections()
    this.pendingSelections.clear()
    this.lidToPhone.clear()
    // Persist the read buffer before dropping it so history survives a restart;
    // on logout, delete it instead so a different linked account starts clean.
    if (reason === 'logout') {
      await deleteReadHistory()
    } else {
      await flushReadHistory(this.readBuffer)
    }
    this.readBuffer.clear()

    this.status = 'disconnected'
    this.statusError = null
    this.currentQr = null
    this.pairingCode = null
    this.pairingNumber = null
    this.qrRequested = false
    this.agent.cerebellum.unregisterInProcessCapability(WHATSAPP_CAPABILITY_NAME)
    this.agent.corpus.emit('whatsapp.stopped', reason ? { reason } : {})
  }

  async restart(config: WhatsAppConfig): Promise<WhatsAppChannelStatus> {
    await this.stop('restart')
    return this.start(config)
  }

  async logout(): Promise<void> {
    if (this.sock) {
      try {
        await this.sock.logout()
      } catch {
        // best-effort
      }
    }
    await this.clearAuthState()
    await this.stop('logout')
    this.agent.corpus.emit('whatsapp.loggedOut', {})
  }

  // --- Connection lifecycle ---

  private async connect(): Promise<void> {
    if (!this.authDir) return

    // Snapshot the generation so the async tail below can tell whether a
    // stop() landed while we were awaiting the network.
    const generation = this.connectGeneration

    let sock: WASocket
    let saveCreds: () => Promise<void>
    try {
      const logger = pino({ level: 'silent' })
      // eslint-disable-next-line react-hooks/rules-of-hooks -- Baileys utility, not a React hook
      const auth = await useMultiFileAuthState(this.authDir)
      saveCreds = auth.saveCreds
      // Fetching the latest protocol version hits the network; offline at
      // boot this throws before we ever get a socket. Handle it like any
      // other connection failure so an established session keeps retrying
      // gracefully instead of wedging on `connecting` or showing a raw
      // stack-trace error.
      const { version } = await fetchLatestBaileysVersion()

      sock = makeWASocket({
        auth: {
          creds: auth.state.creds,
          keys: makeCacheableSignalKeyStore(auth.state.keys, logger)
        },
        version,
        logger,
        printQRInTerminal: false,
        browser: ['Wolffish', 'desktop', '1.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
        keepAliveIntervalMs: 25000,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        getMessage: async (key) => {
          return this.messageStore.get(key.id ?? '') ?? undefined
        }
      })
    } catch (err) {
      // A stop() that landed during setup wins — don't retry or paint
      // status for a channel the user closed.
      if (this.connectGeneration !== generation) return
      this.sock = null
      this.handleSetupFailure(err)
      return
    }

    // Superseded by a stop() while we were building the socket: drop it.
    if (this.connectGeneration !== generation) {
      try {
        sock.end(undefined)
      } catch {
        // best-effort
      }
      return
    }

    this.sock = sock
    // Every listener guards on socket identity (`this.sock !== sock`) so a
    // late event flushed from a socket we've already replaced or torn down
    // can't act on the current session — stale creds writes, ghost message
    // turns, and cross-session lid-map pollution all dissolve. Matches the
    // connection.update guard; only the live socket drives any state.
    sock.ev.on('creds.update', () => {
      if (this.sock !== sock) return
      void saveCreds()
    })
    sock.ev.on('connection.update', (update) => this.handleConnectionUpdate(update, sock))
    sock.ev.on('messages.upsert', (upsert) => this.handleMessagesUpsert(upsert, sock))
    sock.ev.on('messages.update', (updates) => this.handleMessagesUpdate(updates))

    sock.ev.on('messaging-history.set', ({ contacts }) => {
      if (this.sock !== sock) return
      if (!contacts) return
      for (const c of contacts) {
        if (!c.id || !c.lid) continue
        const pn = c.id.split('@')[0].split(':')[0]
        const lid = c.lid.split('@')[0].split(':')[0]
        if (pn && lid) this.lidToPhone.set(lid, pn)
      }
    })

    sock.ev.on('lid-mapping.update', ({ lid, pn }) => {
      if (this.sock !== sock) return
      const lidNum = lid.split('@')[0].split(':')[0]
      const pnNum = pn.split('@')[0].split(':')[0]
      if (lidNum && pnNum) this.lidToPhone.set(lidNum, pnNum)
    })
  }

  private handleConnectionUpdate(
    update: Partial<BaileysEventMap['connection.update']>,
    sock: WASocket
  ): void {
    // Ignore events from a socket we've already replaced (a newer
    // reconnect) or torn down (stop() sets this.sock = null). A genuine
    // event from the current live socket arrives while this.sock still
    // equals it — the close branch nulls this.sock only further down, so
    // this guard never swallows the first close of the active socket.
    // Without it, a late `close` fired during stop()'s teardown would
    // schedule a phantom reconnect that resurrects a disabled channel.
    if (this.sock !== sock) return

    const { connection, lastDisconnect, qr } = update

    if (qr) {
      if (this.qrRequested) {
        // A QR here means the socket has reached the unauthenticated-but-live
        // point, which is the earliest WhatsApp will answer a pairing-code
        // request. Take that route instead of the square when a number was
        // given, and never draw a QR the caller did not ask for.
        if (this.pairingNumber) {
          void this.askForPairingCode(sock, this.pairingNumber)
          return
        }
        if (this.pairingCode) return
        // Only accept the first QR — ignore Baileys' QR rotation.
        if (this.status !== 'qr') {
          this.status = 'qr'
          this.currentQr = qr
          this.statusError = null
          this.agent.corpus.emit('whatsapp.qr', { qr })
          this.agent.corpus.emit('whatsapp.statusChanged', {})
        }
      } else {
        // QR emitted without user request — session is invalid.
        this.sock?.end(undefined)
        this.sock = null
        this.status = 'disconnected'
        this.currentQr = null
        this.pairingCode = null
        this.statusError = this.hadValidSession ? 'Session expired — link WhatsApp again.' : null
        this.hadValidSession = false
        void this.clearAuthState()
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer)
          this.reconnectTimer = null
        }
        this.reconnectAttempt = 0
        this.agent.corpus.emit('whatsapp.statusChanged', {})
        return
      }
      return
    }

    if (connection === 'open') {
      this.status = 'connected'
      this.statusError = null
      this.currentQr = null
      this.pairingCode = null
      this.reconnectAttempt = 0
      this.qrRequested = false
      this.hadValidSession = true
      this.connectedAt = Date.now()
      this.agent.corpus.emit('whatsapp.started', {})
      // Also emit statusChanged so every transition flows through the
      // same channel the renderer listens on — `open` shouldn't be the
      // one transition that reaches the UI only via the started handler.
      this.agent.corpus.emit('whatsapp.statusChanged', {})
      return
    }

    if (connection === 'close') {
      this.sock = null
      const error = lastDisconnect?.error as Boom | undefined
      const statusCode = error?.output?.statusCode ?? 0

      if (statusCode === DisconnectReason.loggedOut) {
        this.status = 'disconnected'
        this.statusError = 'Logged out — link WhatsApp again.'
        this.qrRequested = false
        void this.clearAuthState()
        this.agent.corpus.emit('whatsapp.loggedOut', {})
        this.agent.corpus.emit('whatsapp.statusChanged', {})
        return
      }

      // 515 = restart required (e.g. after QR scan to complete pairing).
      if (statusCode === DisconnectReason.restartRequired) {
        this.scheduleReconnect(0)
        return
      }

      // If we were in QR flow (pairing) and it wasn't a restart, it's a real timeout.
      if (this.qrRequested) {
        this.status = 'disconnected'
        this.statusError = 'The code expired — start linking again.'
        this.qrRequested = false
        this.currentQr = null
        this.pairingCode = null
        this.agent.corpus.emit('whatsapp.statusChanged', {})
        return
      }

      // Only auto-reconnect established sessions (network blips).
      if (!this.hadValidSession) {
        this.status = 'disconnected'
        this.statusError = null
        this.agent.corpus.emit('whatsapp.statusChanged', {})
        return
      }

      if (this.reconnectAttempt < RECONNECT_MAX_ATTEMPTS) {
        // A routine network blip. Stay in the calm `connecting` state with
        // no error text — the panel renders that as an amber spinner, not
        // a red error box. Surfacing "Reconnecting (attempt N)..." as a
        // statusError (which the UI styles like a failure) is exactly what
        // made an otherwise-successful reconnect look broken. The attempt
        // counter still drives backoff; it just isn't shown to the user.
        this.status = 'connecting'
        this.statusError = null
        this.agent.corpus.emit('whatsapp.statusChanged', {})
        this.scheduleReconnect()
      } else {
        // Genuinely gave up — now it's a real error worth showing.
        this.status = 'error'
        this.statusError = 'Failed to reconnect after maximum attempts.'
        this.agent.corpus.emit('whatsapp.error', {
          kind: classifyError(error),
          message: error?.message ?? 'Max reconnect attempts exhausted'
        })
      }
    }
  }

  /**
   * Socket construction threw before we ever wired up `connection.update`
   * (e.g. the version fetch failed offline at boot). Mirror the close
   * handler's graceful path: an established session keeps retrying with
   * backoff under the calm `connecting` state; otherwise we settle into a
   * quiet `disconnected` the user can retry from.
   */
  private handleSetupFailure(err: unknown): void {
    if (this.hadValidSession && this.reconnectAttempt < RECONNECT_MAX_ATTEMPTS) {
      this.status = 'connecting'
      this.statusError = null
      this.agent.corpus.emit('whatsapp.statusChanged', {})
      this.scheduleReconnect()
      return
    }
    if (this.hadValidSession) {
      this.status = 'error'
      this.statusError = 'Failed to reconnect after maximum attempts.'
      this.agent.corpus.emit('whatsapp.error', {
        kind: err instanceof Boom ? classifyError(err) : 'network',
        message: err instanceof Error ? err.message : 'Connection setup failed'
      })
      return
    }
    this.status = 'disconnected'
    this.statusError = null
    this.agent.corpus.emit('whatsapp.statusChanged', {})
  }

  private scheduleReconnect(overrideMs?: number): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)

    let delayMs: number
    if (overrideMs !== undefined) {
      delayMs = overrideMs
    } else {
      const base = RECONNECT_INITIAL_MS * Math.pow(RECONNECT_FACTOR, this.reconnectAttempt)
      const capped = Math.min(base, RECONNECT_MAX_MS)
      const jitter = capped * RECONNECT_JITTER * (Math.random() * 2 - 1)
      delayMs = Math.max(0, capped + jitter)
    }

    this.reconnectAttempt++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      // connect() now self-handles setup failures via handleSetupFailure,
      // so it won't reject; the catch is a defensive backstop only.
      void this.connect().catch(() => undefined)
    }, delayMs)
  }

  // WhatsApp acks a sent message by emitting 'messages.update' with a rising
  // status. Record the highest status seen per id and wake any confirmDelivery()
  // waiter. ERROR (0) is terminal and is processed even if a PENDING arrived
  // first (it would otherwise be filtered as "not higher").
  private handleMessagesUpdate(updates: BaileysEventMap['messages.update']): void {
    for (const { key, update } of updates) {
      const id = key.id
      const status = update.status
      if (!id || typeof status !== 'number') continue
      const prev = this.ackStatus.get(id)
      if (status !== 0 && prev !== undefined && status <= prev) continue
      this.ackStatus.set(id, status)
      if (this.ackStatus.size > 1000) {
        const oldest = this.ackStatus.keys().next().value
        if (oldest !== undefined) this.ackStatus.delete(oldest)
      }
      const waiters = this.ackWaiters.get(id)
      if (waiters) for (const notify of [...waiters]) notify(status)
    }
  }

  /**
   * Resolve once WhatsApp confirms a sent message reached its servers
   * (SERVER_ACK, status ≥ 2) — the honest signal that a send actually left,
   * unlike sendMessage() resolving on a locally-queued, client-minted id.
   * Returns 'acked' on SERVER_ACK+, 'error' on an ERROR status, or 'timeout'
   * if no ack arrives in time. A recipient being offline only delays
   * DELIVERY_ACK, not SERVER_ACK, so a timeout here is genuinely suspicious.
   * Checks the recent-status cache first to avoid missing an ack that landed
   * between sendMessage() resolving and this call.
   */
  confirmDelivery(id: string, timeoutMs = 8000): Promise<'acked' | 'error' | 'timeout'> {
    const seen = this.ackStatus.get(id)
    if (seen !== undefined) {
      if (seen >= 2) return Promise.resolve('acked')
      if (seen === 0) return Promise.resolve('error')
    }
    return new Promise((resolve) => {
      const set = this.ackWaiters.get(id) ?? new Set<(status: number) => void>()
      this.ackWaiters.set(id, set)
      const settle = (result: 'acked' | 'error' | 'timeout'): void => {
        clearTimeout(timer)
        set.delete(notify)
        if (set.size === 0) this.ackWaiters.delete(id)
        resolve(result)
      }
      const notify = (status: number): void => {
        if (status >= 2) settle('acked')
        else if (status === 0) settle('error')
      }
      const timer = setTimeout(() => settle('timeout'), timeoutMs)
      set.add(notify)
    })
  }

  // --- Message store (in-memory, for getMessage retry decryption) ---

  private messageStore = new Map<string, proto.IMessage>()
  private readonly MESSAGE_STORE_MAX = 5000
  private readonly MESSAGE_STORE_KEYS: string[] = []

  private storeMessage(id: string, message: proto.IMessage): void {
    if (this.messageStore.size >= this.MESSAGE_STORE_MAX) {
      const oldest = this.MESSAGE_STORE_KEYS.shift()
      if (oldest) this.messageStore.delete(oldest)
    }
    this.messageStore.set(id, message)
    this.MESSAGE_STORE_KEYS.push(id)
  }

  // --- Per-chat read buffer (in-memory, backs whatsapp_read) ---
  //
  // Baileys has no reliable "fetch last N messages" API and dropped its
  // built-in store, so we keep our own rolling buffer of observed messages
  // per chat JID. It only holds traffic seen since this socket connected —
  // there is no pre-connect history. Cleared on stop()/logout.

  private readonly readBuffer = new Map<string, WhatsAppBufferedMessage[]>()
  private readonly READ_BUFFER_MAX_PER_CHAT = 100
  private readonly READ_BUFFER_MAX_CHATS = 200

  /**
   * Record one observed message into its chat's rolling buffer. Skips
   * broadcasts/status/protocol noise (shouldProcessMessage) and anything with
   * no extractable text/placeholder. Captures fromMe messages too, so reads
   * show both sides of a conversation.
   */
  private bufferForRead(msg: WAMessage): void {
    if (!shouldProcessMessage(msg)) return
    const jid = msg.key.remoteJid
    if (!jid) return
    const text = extractTextBody(msg)
    if (!text) return

    const fromMe = msg.key.fromMe === true
    const entry: WhatsAppBufferedMessage = {
      id: msg.key.id ?? '',
      jid,
      fromMe,
      sender: this.resolveBufferSender(msg, jid, fromMe),
      text,
      timestamp: messageTimestamp(msg).getTime()
    }

    let arr = this.readBuffer.get(jid)
    if (!arr) {
      if (this.readBuffer.size >= this.READ_BUFFER_MAX_CHATS) {
        const oldestChat = this.readBuffer.keys().next().value
        if (oldestChat) this.readBuffer.delete(oldestChat)
      }
      arr = []
      this.readBuffer.set(jid, arr)
    }
    // Dedup: the same id can arrive via both `notify` and an `append`/sync.
    if (entry.id && arr.some((m) => m.id === entry.id)) return
    arr.push(entry)
    if (arr.length > this.READ_BUFFER_MAX_PER_CHAT) {
      arr.splice(0, arr.length - this.READ_BUFFER_MAX_PER_CHAT)
    }
    scheduleReadHistoryFlush(this.readBuffer)
  }

  /** Build a human display for a message's sender ("me" for outgoing). */
  private resolveBufferSender(msg: WAMessage, jid: string, fromMe: boolean): string {
    if (fromMe) return 'me'
    const name = msg.pushName?.trim() ?? ''
    const phone = jid.endsWith('@g.us')
      ? this.phoneFromJid(msg.key.participant ?? '')
      : this.phoneFromJid(jid)
    if (name && phone) return `${name} (${phone})`
    return name || phone || 'unknown'
  }

  /** Strip a JID down to a phone number, resolving @lid via the lid map. */
  private phoneFromJid(jid: string): string {
    if (!jid) return ''
    const local = jid.split('@')[0].split(':')[0]
    if (jid.endsWith('@lid') || jid.endsWith('@hosted.lid')) {
      return this.lidToPhone.get(local) ?? local
    }
    return local
  }

  /**
   * Return up to `count` of the most recent buffered messages for `jid`,
   * oldest first. For a contact DM, falls back to matching by phone digits so
   * a @s.whatsapp.net JID still finds a chat buffered under @lid (and vice
   * versa). Groups (@g.us) match by exact JID only.
   */
  readMessages(jid: string, count: number): WhatsAppBufferedMessage[] {
    let arr = this.readBuffer.get(jid)
    if (!arr && !jid.endsWith('@g.us')) {
      const want = this.phoneFromJid(jid).replace(/[^0-9]/g, '')
      if (want) {
        for (const [key, msgs] of this.readBuffer) {
          if (key.endsWith('@g.us')) continue
          const have = this.phoneFromJid(key).replace(/[^0-9]/g, '')
          if (have && (have === want || have.endsWith(want) || want.endsWith(have))) {
            arr = msgs
            break
          }
        }
      }
    }
    if (!arr || arr.length === 0) return []
    // Sort by timestamp so "last N" is truly chronological even if a synced
    // history message arrived after a live one. Copy so the buffer is untouched.
    return [...arr].sort((a, b) => a.timestamp - b.timestamp).slice(-count)
  }

  // --- Inbound message handling ---

  private handleMessagesUpsert(upsert: BaileysEventMap['messages.upsert'], sock: WASocket): void {
    // Drop events flushed from a socket we've already replaced/torn down so
    // a stale message can't spin up a ghost turn after stop() or a reconnect.
    if (this.sock !== sock) return

    // Capture every observed message (notify + history/append) into the
    // per-chat read buffer that whatsapp_read queries. Runs before the
    // notify-only turn guard below so reads also see the user's own
    // outgoing messages and chats that aren't on the allow-list. Wrapped
    // so a buffer hiccup can never disrupt the message-delivery path.
    try {
      for (const msg of upsert.messages) {
        this.bufferForRead(msg)
      }
    } catch {
      // best-effort: read history is non-critical, never block delivery
    }

    if (upsert.type !== 'notify') return

    for (const msg of upsert.messages) {
      const msgId = msg.key.id
      if (msgId && msg.message) {
        this.storeMessage(msgId, msg.message)
      }

      if (!this.processingEnabled) continue
      if (!shouldProcessMessage(msg)) continue

      // Drop messages sent before this session connected (history sync after pairing)
      const msgTs = (msg.messageTimestamp as number) ?? 0
      const msgTime = msgTs > 1e12 ? msgTs : msgTs * 1000
      if (this.connectedAt > 0 && msgTime < this.connectedAt - 5000) continue

      if (msgId && this.sentIds.delete(msgId)) continue

      const body = extractTextBody(msg)
      if (!body) continue

      const jid = msg.key.remoteJid!
      const altJid = (msg.key as Record<string, unknown>).remoteJidAlt as string | undefined

      let senderPhone: string
      if (altJid && altJid.includes('@s.whatsapp.net')) {
        senderPhone = altJid.split('@')[0].split(':')[0]
      } else if (jid.endsWith('@lid') || jid.endsWith('@hosted.lid')) {
        const lidKey = jid.split('@')[0].split(':')[0]
        senderPhone = this.lidToPhone.get(lidKey) ?? lidKey
      } else {
        senderPhone = jid.split('@')[0].split(':')[0]
      }
      const allowed = this.allowedPhoneNumbers.map((n) => n.replace(/[^0-9]/g, ''))
      const isAllowed = allowed.some(
        (n) => n === senderPhone || senderPhone.endsWith(n) || n.endsWith(senderPhone)
      )
      if (!isAllowed) continue

      // Voice notes (push-to-talk) get downloaded + transcribed, then
      // dispatched as a normal text turn. Sits after the allow-list/sentIds/
      // timestamp guards so only authorized, live messages trigger a download.
      // Non-voice messages fall through to the existing text path untouched.
      if (isInboundVoiceNote(msg)) {
        void this.handleInboundVoice(jid, msg)
        continue
      }

      // Inbound media (documents/PDFs, images, video, non-voice audio,
      // stickers): download into the conversation's uploads folder and
      // dispatch as a real file attachment — the same pipeline in-app uploads
      // and Telegram media use — instead of the dead '<media:…>' placeholder
      // the agent can't act on. Sits in the same slot as the voice check
      // (after the allow-list/sentIds/timestamp guards, before the command
      // parser) so a media caption like "stop" attaches the file rather than
      // being mistaken for a command.
      const media = extractInboundMedia(msg)
      if (media) {
        void this.handleInboundMedia(jid, msg, media)
        continue
      }

      this.agent.corpus.emit('whatsapp.message.received', { remoteJid: jid, body })

      void this.handleInboundMessage(jid, body)
    }
  }

  private async handleInboundMessage(jid: string, text: string): Promise<void> {
    const trimmed = text.trim()
    const lower = trimmed.toLowerCase()

    const active = this.activeByJid.get(jid)

    // /status — read-only introspection. Works even during an active turn.
    if (lower === '/status' || lower === 'status') {
      await this.handleStatusCommand(jid)
      return
    }

    // /current — read-only. Shows which conversation is active.
    if (lower === '/current' || lower === 'current') {
      await this.handleCurrentCommand(jid)
      return
    }

    // /local and /cloud — flip provider mode. Busy-blocked to avoid
    // switching mid-turn.
    if (lower === '/local' || lower === 'local') {
      if (this.activeByJid.size > 0) {
        await this.sendBusyReply(jid, trimmed)
        return
      }
      await this.handleLocalCloudCommand(jid, true)
      return
    }
    if (lower === '/cloud' || lower === 'cloud') {
      if (this.activeByJid.size > 0) {
        await this.sendBusyReply(jid, trimmed)
        return
      }
      await this.handleLocalCloudCommand(jid, false)
      return
    }

    // /mode — set single vs workflow (the global chat mode). Bare `/mode`
    // reports the current mode; `/mode single` / `/mode workflow` set it.
    // Setting is busy-blocked inside the handler; reading is always allowed.
    if (
      lower === '/mode' ||
      lower === 'mode' ||
      lower.startsWith('/mode ') ||
      lower.startsWith('mode ')
    ) {
      await this.handleModeCommand(jid, commandArg(trimmed), trimmed)
      return
    }

    // /model — list connected cloud models and switch the Brain. Bare
    // `/model` lists (read-only, allowed mid-turn); `/model <query>` filters
    // and, on a single match, switches directly. Selecting is busy-blocked
    // inside the handler.
    if (
      lower === '/model' ||
      lower === 'model' ||
      lower.startsWith('/model ') ||
      lower.startsWith('model ')
    ) {
      await this.handleModelCommand(jid, commandArg(trimmed), trimmed)
      return
    }

    // /project — show the active project and a numbered picker; "/project
    // close" leaves it. Listing is read-only and allowed mid-turn (like
    // /model); selecting and exiting rotate the chat to a FRESH conversation
    // (the project binding lives on the conversation itself), so those paths
    // are busy-blocked inside the handler exactly like /new.
    if (lower === '/project' || lower === 'project' || lower.startsWith('/project ')) {
      await this.handleProjectCommand(jid, commandArg(trimmed), trimmed)
      return
    }

    // /cancel — take back everything this chat sent that has not been read
    // yet: interjections still pending on the running turn, then the sliver
    // queue. Works mid-turn (that is the only time either exists), touches
    // the running turn not at all, and is never itself queued.
    if (lower === '/cancel' || lower === 'cancel') {
      // Same as Telegram: a pending turn-end countdown is abortable from here.
      const countdown = await countdowns.abortPending('user')
      if (countdown) {
        await this.safeSend(jid, `Aborted: ${countdown.label}.`)
        return
      }
      const dropped = await this.dropUnread(jid)
      await this.safeSend(
        jid,
        dropped > 0 ? queueClearedText(dropped) : queueEmptyText(this.activeByJid.has(jid))
      )
      return
    }

    // /stop — stop the active turn for this JID. The queue deliberately
    // SURVIVES a stop (the in-app queue does too: stopping advances it rather
    // than dropping it) — the trailing note makes that visible, and /cancel is
    // the way out.
    if (lower === '/stop' || lower === 'stop') {
      if (!active) {
        const queued = this.clearQueue(jid)
        await this.safeSend(
          jid,
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
      const note = queuePendingNote(this.queue.size(jid))
      await this.safeSend(jid, 'Stopping...')
      const deadline = Date.now() + 10_000
      while (this.activeByJid.has(jid) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
      }
      if (this.activeByJid.has(jid)) {
        await this.safeSend(
          jid,
          `Attempted to stop, but the task may still be winding down.${note}`
        )
      } else {
        await this.safeSend(jid, `Stopped.${note}`)
      }
      return
    }

    // /approve and /deny — resolve pending approval
    if (active?.pendingApprovalId && active.pendingApprovalResolve) {
      if (lower === '/approve' || lower === 'approve' || lower === 'yes') {
        this.resolveApproval(active, 'approved')
        await this.safeSend(jid, 'Approved.')
        return
      }
      if (lower === '/deny' || lower === 'deny' || lower === 'no') {
        this.resolveApproval(active, 'denied')
        await this.safeSend(jid, 'Denied.')
        return
      }
    }

    // /new — start fresh conversation. Busy-blocked per chat: it rewires
    // THIS jid's conversation mapping, so only this jid's own turn matters.
    if (lower === '/new' || lower === 'new' || lower === '/start') {
      if (this.activeByJid.has(jid)) {
        await this.sendBusyReply(jid, trimmed)
        return
      }
      await this.handleNewCommand(jid)
      return
    }

    // /resume — conversation picker
    if (lower === '/resume' || lower === 'resume') {
      if (this.activeByJid.has(jid)) {
        await this.sendBusyReply(jid, trimmed)
        return
      }
      await this.renderConversationPicker(jid, 'resume')
      return
    }

    // /delete — conversation picker for deletion
    if (lower === '/delete' || lower === 'delete') {
      if (this.activeByJid.has(jid)) {
        await this.sendBusyReply(jid, trimmed)
        return
      }
      await this.renderConversationPicker(jid, 'delete')
      return
    }

    // Number reply for an outstanding /resume, /delete, or /model picker
    const pending = this.pendingSelections.get(jid)
    if (pending) {
      // `next` pages the conversation picker. This has to sit ahead of the
      // number parse and the cancel fall-through below — otherwise the word
      // reads as "not a selection", silently drops the picker, and gets sent
      // to the model as an ordinary chat turn.
      if (
        (pending.command === 'resume' || pending.command === 'delete') &&
        isNextPageReply(lower)
      ) {
        const page = pending.page + 1
        if (pageExists(pending.items, page)) {
          this.pendingSelections.set(jid, { ...pending, page })
          await this.sendPickerPage(jid, pending.command, pending.items, page)
        } else {
          await this.safeSend(jid, 'That was the last page — reply with a number to pick one.')
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
        this.pendingSelections.delete(jid)
        if (pending.command === 'model') {
          await this.applyModelSelection(jid, pending.models[num - 1], trimmed)
        } else if (pending.command === 'project') {
          await this.applyProjectSelection(jid, pending.projects[num - 1], trimmed)
        } else if (pending.command === 'resume') {
          await this.handleResumeSelection(jid, pending.items[num - 1].id)
        } else {
          await this.handleDeleteSelection(jid, pending.items[num - 1].id)
        }
        return
      }
      this.pendingSelections.delete(jid)
    }

    // Outstanding ask_user question — the user's reply IS the answer. A
    // number in range picks that option; any other text becomes custom
    // instructions ("something else"). Sits before the busy-check so the
    // reply isn't bounced as "I'm busy" while the agent waits on it.
    if (active?.pendingAsk && active.pendingAskResolve) {
      await this.resolvePendingAsk(jid, active, trimmed)
      return
    }

    // Busy check — one turn at a time PER CHAT. Other chats (and other
    // channels, and the in-app renderer) run their own turns concurrently;
    // the TurnRunner serializes per conversation, so per-jid gating is the
    // whole story for ordering. A message that lands mid-turn is PARKED, not
    // declined: it runs on its own turn the moment this chat frees up,
    // exactly like the in-app composer's queue.
    if (this.isJidBusy(jid)) {
      await this.parkMessage(jid, { id: mintMessageId(), text: trimmed, attachments: [] })
      return
    }

    // Free — dispatch as a new turn
    await this.dispatchTurn(jid, trimmed)
  }

  private resolveApproval(active: ActiveTurn, decision: ApprovalDecision): void {
    const approvalId = active.pendingApprovalId!
    const resolve = active.pendingApprovalResolve!
    active.pendingApprovalId = null
    active.pendingApprovalResolve = null
    const stored = active.approvals.get(approvalId)
    if (stored) stored.decision = decision
    resolve(decision)
  }

  // --- Slash command handlers ---

  private async handleStatusCommand(jid: string): Promise<void> {
    try {
      const report = await this.agent.insula.reflect()
      const text = typeof report === 'string' ? report : JSON.stringify(report, null, 2)
      // The insula report is Markdown; nothing downstream converts it
      // anymore, so flatten it to plain text before sending.
      await this.safeSend(jid, markdownToPlain(text))
    } catch {
      await this.safeSend(jid, 'Unable to generate status report.')
    }
  }

  private async handleCurrentCommand(jid: string): Promise<void> {
    const convId = await getConversationIdForJid(jid)
    if (!convId) {
      await this.safeSend(jid, 'No active conversation. Send a message to start one.')
      return
    }
    const conv = await loadConversation(convId)
    if (!conv) {
      await this.safeSend(jid, 'No active conversation. Send a message to start one.')
      return
    }
    const msgs = conv.messages.length
    const ago = relativeTime(conv.updatedAt)
    await this.safeSend(jid, `*${conv.title}*\n${msgs} messages · updated ${ago}`)
  }

  /**
   * Handle /local and /cloud — flip llm.localOnly (persist + live thalamus),
   * mirroring the in-app local/cloud switch and the main-process IPC handler.
   * Distinct from /mode (single vs workflow — see handleModeCommand).
   */
  private async handleLocalCloudCommand(jid: string, localOnly: boolean): Promise<void> {
    await persistLocalOnly(localOnly)
    this.agent.thalamus.setLocalOnly(localOnly)
    await this.safeSend(jid, localOnly ? 'Switched to local model.' : 'Switched to cloud model.')
  }

  /**
   * Handle /mode — read or set the global chat mode (single vs workflow),
   * mirroring the in-app mode picker's two steps: persist (setMode) + live
   * (agent.setMode). Bare `/mode` reports the current mode. Setting is
   * busy-blocked because mode is global (like the Brain and localOnly) —
   * switching while a turn is in flight would change the next iteration out
   * from under it. `arg` is lower-cased; `raw` is the original text.
   */
  private async handleModeCommand(jid: string, arg: string, raw: string): Promise<void> {
    const config = await readConfig()
    const current = config?.llm.mode === 'workflow' ? 'workflow' : 'single'
    if (!arg) {
      await this.safeSend(jid, `Mode: *${current}*\nSwitch with /mode single or /mode workflow.`)
      return
    }
    const next = arg === 'workflow' ? 'workflow' : arg === 'single' ? 'single' : null
    if (!next) {
      await this.safeSend(jid, 'Usage: /mode single or /mode workflow.')
      return
    }
    if (next === current) {
      await this.safeSend(jid, `Already in ${current} mode.`)
      return
    }
    if (this.activeByJid.size > 0) {
      await this.sendBusyReply(jid, raw)
      return
    }
    await persistMode(next)
    this.agent.setMode(next)
    await this.safeSend(jid, next === 'workflow' ? 'Mode: workflow.' : 'Mode: single.')
  }

  /**
   * Handle /model — list connected cloud models and switch the Brain. Bare
   * `/model` lists them numbered (read-only, so allowed even mid-turn) and
   * arms a numbered picker; `/model <query>` filters by substring and, on a
   * single match, switches directly. The switch mirrors the in-app model
   * picker (persist setBrain + live thalamus.setBrain) and also clears
   * localOnly — a deliberately chosen cloud model would otherwise be ignored
   * while local-only mode is on (resolveEntry short-circuits to local).
   */
  private async handleModelCommand(jid: string, query: string, raw: string): Promise<void> {
    const options = collectModelOptions(this.agent.thalamus.getCloudProviders())
    if (options.length === 0) {
      await this.safeSend(
        jid,
        'No cloud providers connected. Add an API key in Settings, or use /local for the on-device model.'
      )
      return
    }
    const matches = filterModelOptions(options, query)
    // A query that pins exactly one model switches straight to it.
    if (query && matches.length === 1) {
      await this.applyModelSelection(jid, matches[0], raw)
      return
    }
    if (matches.length === 0) {
      await this.safeSend(jid, `No cloud model matches "${query}".`)
      return
    }
    const activeProvider = this.agent.thalamus.getActiveProvider()
    const activeModel = this.agent.thalamus.getActiveModel()
    const shown = matches.slice(0, MODEL_LIST_CAP)
    this.pendingSelections.set(jid, { command: 'model', models: shown })
    const lines = shown.map((o, i) => {
      const current = o.providerId === activeProvider && o.model === activeModel ? ' ✅' : ''
      return `${i + 1}. *${o.providerId}* · ${o.model}${current}`
    })
    const header =
      query && matches.length !== options.length
        ? `*Models matching "${query}"* — reply with the number:`
        : '*Pick a model* — reply with the number:'
    const more =
      matches.length > shown.length
        ? `\n\n…and ${matches.length - shown.length} more — narrow with /model <name>.`
        : ''
    await this.safeSend(jid, `${header}\n\n${lines.join('\n')}${more}`)
  }

  /**
   * Commit a chosen cloud model as the Brain (persist + live), clearing
   * localOnly so it actually takes effect. Busy-blocked: the Brain is global,
   * so swapping it mid-turn would change the in-flight turn's next iteration.
   */
  private async applyModelSelection(jid: string, option: ModelOption, raw: string): Promise<void> {
    if (this.activeByJid.size > 0) {
      await this.sendBusyReply(jid, raw)
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
    await this.safeSend(jid, `Model: ${option.providerId} · ${option.model}${note}`)
  }

  private async handleNewCommand(jid: string): Promise<void> {
    // /new inside a project STAYS in the project — the fresh conversation
    // inherits the current one's binding; /project close is the way out.
    const project = await this.activeProjectForJid(jid)
    const fresh = createConversation(null)
    fresh.channel = 'whatsapp'
    if (project) fresh.projectId = project.id
    await saveConversation(fresh)
    await setConversationIdForJid(jid, fresh.id)
    const note = this.dropQueueForRotation(jid)
    if (project) {
      await this.safeSend(
        jid,
        `New conversation started in ${projectLabel(project)}.${note} To leave the project, use /project close.`
      )
      return
    }
    await this.safeSend(jid, `New conversation started.${note}\n\n${COMMANDS_HELP}`)
  }

  /**
   * The project this jid is currently "in" — derived from the bound
   * conversation's own projectId, never from separate channel state, so it
   * survives restarts and can't drift from what turns actually run with.
   * A dangling binding (project deleted in the app) reads as no project.
   */
  private async activeProjectForJid(jid: string): Promise<Project | null> {
    const currentId = await getConversationIdForJid(jid)
    if (!currentId) return null
    const current = await loadConversation(currentId)
    if (!current?.projectId) return null
    const projects = await listProjects().catch(() => [] as Project[])
    return projects.find((p) => p.id === current.projectId) ?? null
  }

  private async handleProjectCommand(jid: string, arg: string | null, raw: string): Promise<void> {
    const active = await this.activeProjectForJid(jid)

    if (arg && arg.trim().toLowerCase() === 'close') {
      if (this.activeByJid.has(jid)) {
        await this.sendBusyReply(jid, raw)
        return
      }
      if (!active) {
        await this.safeSend(jid, 'No active project to close.')
        return
      }
      this.pendingSelections.delete(jid)
      const fresh = createConversation(null)
      fresh.channel = 'whatsapp'
      await saveConversation(fresh)
      await setConversationIdForJid(jid, fresh.id)
      await this.safeSend(
        jid,
        `Left ${projectLabel(active)}. Fresh conversation started outside it.${this.dropQueueForRotation(jid)}`
      )
      return
    }

    const projects = await listProjects().catch(() => [] as Project[])
    if (projects.length === 0) {
      await this.safeSend(jid, 'No projects yet — create one from the Projects page in the app.')
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
    this.pendingSelections.set(jid, { command: 'project', projects })
    await this.safeSend(jid, lines.join('\n'))
  }

  private async applyProjectSelection(jid: string, project: Project, raw: string): Promise<void> {
    // Selecting rotates the chat to a fresh bound conversation — same
    // mapping mutation as /new, so the same busy gate applies.
    if (this.activeByJid.has(jid)) {
      await this.sendBusyReply(jid, raw)
      return
    }
    const fresh = createConversation(null)
    fresh.channel = 'whatsapp'
    fresh.projectId = project.id
    await saveConversation(fresh)
    await setConversationIdForJid(jid, fresh.id)
    await this.safeSend(
      jid,
      `${project.icon || '📁'} Now in project “${project.title.trim() || 'Untitled'}”.${this.dropQueueForRotation(jid)} Conversations here start from its instructions and files — /project close to leave.`
    )
  }

  /**
   * Open the numbered picker that drives /resume and /delete. Lists every
   * conversation of every origin, newest first, a page at a time.
   *
   * The full list is snapshotted into pendingSelections here and every page is
   * served from that snapshot rather than re-listing. Two reasons: /resume
   * rewrites updatedAt, which IS the sort key, so a second listing would
   * reshuffle rows under the numbers the user is still reading; and listing
   * parses every conversation file on disk, which shouldn't be paid per page.
   */
  private async renderConversationPicker(jid: string, command: 'resume' | 'delete'): Promise<void> {
    // Both /resume and /delete reach ANY conversation — a chat is no longer
    // pinned to its origin channel, so you manage the whole history from
    // anywhere, exactly like the in-app Conversations page. Each row carries an
    // origin tag so a mixed list stays legible. (listConversations is already
    // newest-first.)
    const all = await listConversations()
    // Automation runs outnumber real chats several-to-one and would bury them
    // in a newest-first list, so /resume hides them by default. /delete keeps
    // them — cleaning them up from a phone is a thing you'd actually want.
    const cfg = await getWhatsAppConfig()
    const items =
      command === 'resume' && (cfg.hideAutomationsFromResume ?? true)
        ? all.filter((c) => c.channel !== 'heartbeat')
        : all

    if (items.length === 0) {
      this.pendingSelections.delete(jid)
      await this.safeSend(jid, 'No saved conversations yet.')
      return
    }

    this.pendingSelections.set(jid, { command, items, page: 0 })
    await this.sendPickerPage(jid, command, items, 0)
  }

  /**
   * Render one page of an open picker. Numbering is continuous across the
   * whole list rather than restarting per page — page 2 opens at 26 — so a
   * number identifies the same conversation for as long as the picker is open,
   * and a number from a page already scrolled past still selects.
   */
  private async sendPickerPage(
    jid: string,
    command: 'resume' | 'delete',
    items: ConversationMeta[],
    page: number
  ): Promise<void> {
    const { shown, start, last, total, hasMore } = pickerPage(items, page)
    const header =
      command === 'resume'
        ? '*Resume a conversation* — reply with the number:'
        : '*Delete a conversation* — reply with the number:'

    const body = shown.map((conv, idx) => formatPickerItem(conv, start + idx)).join('\n\n')

    let footer = ''
    if (hasMore) {
      footer = `\n\n_${start + 1}–${last} of ${total} — reply *next* for more._`
    } else if (start > 0) {
      footer = `\n\n_${start + 1}–${last} of ${total} — end of list._`
    }

    await this.safeSend(jid, `${header}\n\n${body}${footer}`)
  }

  private async handleResumeSelection(jid: string, conversationId: string): Promise<void> {
    const conv = await loadConversation(conversationId)
    if (!conv) {
      await this.safeSend(jid, 'That conversation is no longer available.')
      return
    }
    // Restart the idle clock. loadOrCreateConversation's stale check keys
    // off updatedAt, and a resumed conversation is by definition old — left
    // untouched, the very next message would trip that check and bounce the
    // user straight back to a fresh conversation, undoing the resume. Bump
    // before remapping so a failed write leaves the old mapping intact.
    await updateConversation(conversationId, (disk) => {
      if (!disk) return null
      disk.updatedAt = Date.now()
      return disk
    })
    await setConversationIdForJid(jid, conversationId)
    await this.safeSend(jid, `Resumed: *${conv.title}*${this.dropQueueForRotation(jid)}`)
  }

  private async handleDeleteSelection(jid: string, conversationId: string): Promise<void> {
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
      await this.safeSend(jid, 'That conversation is busy right now — try again once it finishes.')
      return
    }

    const currentId = await getConversationIdForJid(jid)
    const wasActive = currentId === conversationId

    await deleteConversation(conversationId)
    this.agent.corpus.emit('conversation.deleted', { id: conversationId })

    if (wasActive) {
      const fresh = createConversation(null)
      fresh.channel = 'whatsapp'
      await saveConversation(fresh)
      await setConversationIdForJid(jid, fresh.id)
      await this.safeSend(
        jid,
        `Deleted. New conversation started.${this.dropQueueForRotation(jid)}\n\n${COMMANDS_HELP}`
      )
    } else {
      await this.safeSend(jid, 'Deleted.')
    }
  }

  /**
   * Inbound voice note: download the OGG/Opus blob into the conversation's
   * uploads folder (so it lands in ~/.wolffish and the in-app history can
   * replay it), transcribe it via the cerebellum, then dispatch a normal text
   * turn with the transcript as content and voicePrompt:true. Mirrors
   * Telegram's handleVoiceMessage. Every early-return surfaces a friendly
   * message; nothing throws back into the upsert loop.
   */
  private async handleInboundVoice(jid: string, msg: WAMessage): Promise<void> {
    // A busy chat parks the voice note instead of declining it. Download and
    // transcription happen NOW, not at flush time: the media keys ride this
    // inbound message and we no longer hold it later, and doing the STT up
    // front is what lets the transcript echo (and the queue ack) reach the
    // user immediately. Mirrors Telegram's handleVoiceMessage.
    const busyTurn = this.activeByJid.get(jid)
    const sock = this.sock
    if (!sock) return

    try {
      // While a turn is running, its conversation IS this chat's conversation —
      // use it directly so the upload lands in the folder the queued turn will
      // read from, and so we never race loadOrCreateConversation's idle check.
      const conversation = busyTurn?.conversation ?? (await this.loadOrCreateConversation(jid))

      let attachment: MessageAttachment
      try {
        // The raw `msg` carries the encrypted media keys; reuploadRequest lets
        // baileys re-fetch keys if the first decrypt attempt fails.
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
        )
        attachment = await saveUploadFromBuffer(
          conversation.id,
          buffer,
          `voice_${msg.key.id ?? Date.now()}.ogg`
        )
        this.agent.corpus.emit('whatsapp.message.received', {
          remoteJid: jid,
          body: '<voice_note>'
        })
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err)
        await this.safeSend(jid, `⚠️ Voice download failed: ${errMessage}`)
        return
      }

      // Scope the conversation id so the transcript persists under the right
      // folder, and ensure ffmpeg (silent self-install) since this direct tool
      // call bypasses the agent loop's dependency resolution. runWithConversation
      // (ALS) instead of the imperative global — setting/clearing the global
      // here would clobber whichever conversation a concurrent turn published.
      await this.agent.cerebellum.ensureSystemTool('ffmpeg')
      const result = await this.agent.cerebellum.runWithConversation(conversation.id, () =>
        this.agent.cerebellum.executeTool('stt_transcribe', {
          filePath: attachment.filePath
        })
      )
      if (!result.success) {
        await this.safeSend(
          jid,
          `⚠️ Couldn't transcribe voice message: ${result.error ?? 'unknown error'}`
        )
        return
      }
      const transcript = extractTranscriptText(result.output ?? '')
      if (!transcript) {
        await this.safeSend(jid, '⚠️ Voice message transcribed to nothing.')
        return
      }
      // Whisper's detected language — a deterministic reply-language signal
      // threaded into the <voice_note lang="…"> tag (see telegram channel).
      const voiceLang = extractVoiceLanguage(result.output ?? '')

      // Echo what we heard, then dispatch with the transcript as the prompt and
      // the audio attached. voicePrompt:true keeps the audio out of the
      // LLM-bound history (the transcript IS the prompt) while preserving the
      // file on disk for replay.
      await this.safeSend(jid, `🎙 ${transcript}`)
      // Busy (still, or newly) ⇒ park it with both flags intact, so the
      // flushed turn is byte-identical to this one.
      if (this.isJidBusy(jid)) {
        await this.parkMessage(jid, {
          id: mintMessageId(),
          text: transcript,
          attachments: [attachment],
          voicePrompt: true,
          voiceLang
        })
        return
      }
      await this.dispatchTurn(jid, transcript, [attachment], { voicePrompt: true, voiceLang })
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)
      await this.safeSend(jid, `⚠️ Voice message failed: ${errMessage}`)
    }
  }

  /**
   * Inbound media (documents/PDFs, images, video, non-voice audio, stickers):
   * download the blob into the conversation's uploads folder and dispatch a
   * normal text turn with the file attached and the caption (if any) as the
   * prompt. This routes channel media through the exact same
   * upload → attachment → processHistoryAttachments pipeline the in-app chat
   * uses, so a PDF is handed to the model as a native document (and read the
   * same way an in-app PDF is) instead of a dead '<media:document>'
   * placeholder. Mirrors handleInboundVoice + Telegram's handleMediaMessage.
   * Every early-return surfaces a friendly message; nothing throws back into
   * the upsert loop.
   */
  private async handleInboundMedia(
    jid: string,
    msg: WAMessage,
    media: InboundMedia
  ): Promise<void> {
    // A busy chat no longer declines media — the file is downloaded and the
    // message parked. The download CANNOT be deferred to flush time: the
    // encrypted media keys ride this inbound message, which we no longer hold
    // once the turn ends, so a queued photo would be undeliverable. The size
    // guards below still apply, so the "don't pull a blob we can't use"
    // concern stays bounded exactly as it is on an idle chat.
    const busyTurn = this.activeByJid.get(jid)
    const sock = this.sock
    if (!sock) return

    // Pre-download size guard using the size WhatsApp declares in the media
    // header — refuses an oversized file before pulling it down. Best-effort:
    // the header omits fileLength on some messages, so a post-download check
    // below is the real backstop.
    if (media.fileLength != null && media.fileLength > MAX_WHATSAPP_MEDIA_BYTES) {
      await this.safeSend(
        jid,
        `⚠️ File too large (${formatBytes(media.fileLength)}). Limit is ${formatBytes(MAX_WHATSAPP_MEDIA_BYTES)}.`
      )
      return
    }

    try {
      // See handleInboundVoice — the running turn's conversation is this
      // chat's conversation, and using it avoids re-reading (and re-racing)
      // the mapping mid-turn.
      const conversation = busyTurn?.conversation ?? (await this.loadOrCreateConversation(jid))

      let attachment: MessageAttachment
      try {
        // The raw `msg` carries the encrypted media keys; reuploadRequest lets
        // baileys re-fetch keys if the first decrypt attempt fails. Same call
        // the voice path uses — it works uniformly across media kinds.
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
        )
        // Backstop for media whose header omitted fileLength (the pre-download
        // guard couldn't fire): drop it now rather than persist + dispatch a
        // file over the cap.
        if (buffer.length > MAX_WHATSAPP_MEDIA_BYTES) {
          await this.safeSend(
            jid,
            `⚠️ File too large (${formatBytes(buffer.length)}). Limit is ${formatBytes(MAX_WHATSAPP_MEDIA_BYTES)}.`
          )
          return
        }
        // Pass the WhatsApp mimetype as a hint so an extension-less document
        // still classifies correctly (the filename already carries a
        // synthesized extension, but the hint is a belt-and-suspenders).
        attachment = await saveUploadFromBuffer(
          conversation.id,
          buffer,
          media.fileName,
          media.mimeType
        )
        this.agent.corpus.emit('whatsapp.media.received', {
          remoteJid: jid,
          type: attachment.type,
          filePath: attachment.filePath,
          sizeBytes: attachment.sizeBytes
        })
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err)
        await this.safeSend(jid, `⚠️ Media download failed: ${errMessage}`)
        return
      }

      // No vision gate here — images dispatch on every model. A non-vision
      // model gets a text note (name + path + tool guidance) from the
      // attachment pipeline instead of the image bytes, and explains to the
      // user what it can and can't do with the file.

      // Empty caption is fine — composeAttachmentContext forwards the file
      // with empty text and the model sees the attachment alone.
      //
      // Re-read the busy state: the download may have outlasted the turn that
      // was running when this message arrived (dispatch now), or a turn may
      // have started during it (park it). The queued entry carries the saved
      // attachment, so the flushed turn hands the model the same native
      // document/image blocks an unqueued one would.
      if (this.isJidBusy(jid)) {
        await this.parkMessage(jid, {
          id: mintMessageId(),
          text: media.caption ?? '',
          attachments: [attachment]
        })
        return
      }
      await this.dispatchTurn(jid, media.caption ?? '', [attachment])
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)
      await this.safeSend(jid, `⚠️ Media message failed: ${errMessage}`)
    }
  }

  // --- Turn dispatch (mirrors Telegram's pattern) ---

  /**
   * Run one user message as a turn. Resolves TRUE once the turn has finished,
   * FALSE if the chat turned out to be busy and the message was parked instead
   * (or, for a queue flush, handed back to the caller to re-queue).
   */
  private async dispatchTurn(
    jid: string,
    userText: string,
    attachments: MessageAttachment[] = [],
    options: { voicePrompt?: boolean; voiceLang?: string; fromQueue?: boolean } = {}
  ): Promise<boolean> {
    // SYNCHRONOUS per-jid claim BEFORE any await — closes the TOCTOU where two
    // same-jid messages both reach dispatch (both past the arrival gate, both
    // before activeByJid is set) and double-dispatch. The second is parked.
    if (this.dispatchingByJid.has(jid) || this.activeByJid.has(jid)) {
      await this.parkOrYield(jid, userText, attachments, options)
      return false
    }
    this.dispatchingByJid.add(jid)
    try {
      return await this.dispatchTurnInner(jid, userText, attachments, options)
    } finally {
      // Safety net for early-return paths before onTurnStarted handed the
      // claim off to activeByJid (a no-op once already released there).
      this.dispatchingByJid.delete(jid)
    }
  }

  /**
   * A dispatch that lost the busy race. A normal message is handed to the
   * running turn (or, with no live lane yet, parked in the sliver queue) and
   * acked; one that came FROM the queue is left alone — it is already
   * queued, and re-acking would tell the user twice for a single message.
   * The flush loop puts it back at the head and interjects it itself.
   */
  private async parkOrYield(
    jid: string,
    userText: string,
    attachments: MessageAttachment[],
    options: { voicePrompt?: boolean; voiceLang?: string; fromQueue?: boolean }
  ): Promise<void> {
    if (options.fromQueue) return
    await this.parkMessage(jid, {
      id: mintMessageId(),
      text: userText,
      attachments,
      voicePrompt: options.voicePrompt,
      voiceLang: options.voiceLang
    })
  }

  private async dispatchTurnInner(
    jid: string,
    userText: string,
    attachments: MessageAttachment[],
    options: { voicePrompt?: boolean; voiceLang?: string; fromQueue?: boolean }
  ): Promise<boolean> {
    const conversation = await this.loadOrCreateConversation(jid)

    // A turn still QUEUED on this conversation's lane (not yet started, so not
    // in activeByJid) is also busy — park rather than stack a second turn.
    if (this.runner.isConversationActive(conversation.id)) {
      await this.parkOrYield(jid, userText, attachments, options)
      return false
    }

    // Resolve the verbosity preference once per turn. false (default) =
    // clean feed (agent messages + file results + errors only).
    const verbose = (await getWhatsAppConfig()).verbose ?? false

    const userMessage: ConversationMessage = {
      id: mintMessageId(),
      role: 'user',
      content: userText,
      timestamp: Date.now(),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(options.voicePrompt ? { voicePrompt: true } : {}),
      ...(options.voiceLang ? { voiceLang: options.voiceLang } : {})
    }
    // Local copy feeds the replay-history build below; the persist itself is
    // an append-RMW against the freshest disk state so a concurrent writer
    // (summarizer, another surface) is never clobbered by this stale copy.
    // A null disk means the conversation was deleted out from under us —
    // skip the write rather than resurrect the file.
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
    // have taken the per-jid slot while our render queue drained.
    let dispatchedTurn: ActiveTurn | null = null
    const handle = this.runner.send({
      history,
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      // Project binding rides the conversation file, so continued
      // project conversations get the overlay on every channel turn.
      projectId: conversation.projectId ?? null,
      channel: 'whatsapp',
      formatNotices: () => this.drainFormatNotices(jid),
      makeSink: ({ turnId, conversationId }) => this.createSink(turnId, conversationId, jid),
      onTurnStarted: ({ turnId, controller }) => {
        // Stamp the assistant message's identity up front so live mirror
        // snapshots and the end-of-turn save share one id + timestamp.
        const assistantTimestamp = Date.now()
        const active: ActiveTurn = {
          jid,
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
          toolCallNames: new Map(),
          pendingActiveModel: null,
          lastFlushedModel: null,
          stats: new TurnStatsCollector(Date.now()),
          sentFiles: new Set(),
          verbose,
          voiceReplySent: false
        }
        dispatchedTurn = active
        this.activeByJid.set(jid, active)
        // Hand the synchronous claim off to activeByJid — from here the active
        // turn itself is the per-jid guard.
        this.dispatchingByJid.delete(jid)
      },
      onTurnEnded: () => {
        // Drain the render queue (which includes the final text flush
        // enqueued by onDone) before cleaning up the active turn.
        const pending = this.segmentQueue.get(jid) ?? Promise.resolve()
        // .catch BEFORE .then — see the Telegram twin. A rejected render queue
        // must still reach the cleanup that deletes activeByJid and flushes the
        // queue; skipping it leaves the jid permanently "busy" and, since
        // enqueue starts no flush while that slot is held, strands the queue.
        void pending
          .catch(() => undefined)
          .then(() => {
            // Persist and resolve against OUR captured turn object — the
            // per-jid slot may already belong to a successor turn by the time
            // this network-bound drain fires, and reading the map here used to
            // silently drop the finished turn's transcript.
            const finished = dispatchedTurn
            if (finished) {
              if (finished.pendingApprovalId) {
                const stored = finished.approvals.get(finished.pendingApprovalId)
                if (stored && !stored.decision) stored.decision = 'denied'
              }

              // Assembled from the SAME accumulator the live mirror used — same
              // stable id + timestamp — so the disk record and any already-
              // mirrored in-app copy are one message, reconciled by id.
              // Returns null only when there's nothing to save (no prose AND no
              // segments), so tool-only turns still persist.
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
                // message at once — ahead of the disk save + reindex.
                if (finished.mirrorTimer) {
                  clearTimeout(finished.mirrorTimer)
                  finished.mirrorTimer = null
                }
                this.mirrorListener?.(finished.conversation.id, assistant)
              }
              // Fold this turn's tokenomics into the persisted stats so the
              // in-app context-meter card restores real numbers for this WhatsApp
              // conversation (it was blank before — channel turns never wrote
              // stats). Persist even without an assistant message so an
              // errored/empty turn still records its all-time roll-up.
              const foldStats = finished.stats.hasData()
              if (assistant || foldStats) {
                // Append-RMW: the copy held since dispatch may be stale w.r.t.
                // the summarizer (summary fields) — append onto the freshest disk
                // state instead of whole-saving the held copy over it. A null disk
                // means the conversation was deleted mid-drain — skip rather than
                // resurrect it.
                void updateConversation(finished.conversation.id, (disk) => {
                  if (!disk) return null
                  if (assistant) {
                    disk.messages.push(assistant)
                    disk.updatedAt = endedAt
                  }
                  if (foldStats) disk.stats = finished.stats.foldInto(disk.stats, endedAt)
                  // A heartbeat/procedure run seals its conversation as a finished
                  // record, and the summarizer below skips sealed files. A user
                  // turn in it — reachable since a background run can hand this
                  // chat its conversation — makes it live again; left sealed it
                  // would replay the whole verbatim transcript on every reply
                  // forever. Mirrors the in-app unseal in persistConversation.
                  if (disk.sealed) disk.sealed = false
                  return disk
                })
                  .then(() => {
                    if (assistant) queueConversationSummarization(finished.conversation.id)
                  })
                  .catch(() => undefined)
              }

              // Format leaks flushed with no agent iteration left to read
              // them (typically the FINAL prose block) carry over to the
              // next turn's drain, so the model still hears what reached
              // the user's phone.
              if (finished.formatNotices.length > 0) {
                const prior = this.pendingFormatNotices.get(jid) ?? []
                this.pendingFormatNotices.set(jid, [...prior, ...finished.formatNotices])
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
            // Release the per-jid slot and render queue only if WE still own
            // them — a successor turn's entries must survive our teardown.
            if (!finished || this.activeByJid.get(jid) === finished) {
              this.activeByJid.delete(jid)
              this.segmentQueue.delete(jid)
              // The chat is free: hand it to anything the user sent mid-turn.
              // This is the channel's streaming→idle transition — the same edge
              // the in-app composer flushes its queue on, and for the same
              // reason it needs no special casing for /stop or an errored turn:
              // both land here through the identical cleanup path.
              this.flushQueue(jid)
            }
          })
      }
    })

    await handle.done
    return true
  }

  /**
   * The conversation-map key the INBOUND path would use for a chat we are
   * sending to. Returns null when this chat can never hold a conversation.
   *
   * Sends address a contact by phone (`<phone>@s.whatsapp.net` — what
   * whatsapp_check hands the model), but the map is keyed by whatever
   * `msg.key.remoteJid` arrives as, and on a LID-addressed account that is an
   * `@lid`. Binding the phone form would write a key the inbound path never
   * reads: a silent no-op plus a junk entry. Baileys' own PN→LID store answers
   * this exactly — it is persisted in the auth state (so it survives restarts,
   * unlike the session-scoped lidToPhone map, which is keyed the other way
   * round anyway) and falls back to a USYNC fetch on first contact.
   *
   * Groups are excluded on purpose: the inbound allow-list matches the sender
   * phone taken from remoteJid/remoteJidAlt, which for a group is the group id,
   * so no group message ever reaches loadOrCreateConversation and a group key
   * would be unreachable by construction.
   */
  private async inboundKeyForJid(jid: string): Promise<string | null> {
    // Already a LID: that IS the inbound form (both spellings, as phoneFromJid).
    if (isLidUser(jid) || isHostedLidUser(jid)) return jidNormalizedUser(jid)
    // Anything that isn't a phone-addressed contact — group, broadcast,
    // newsletter, bot — can't hold a conversation. Never invent a key for it.
    if (!isPnUser(jid) && !isHostedPnUser(jid)) return null
    const sock = this.sock
    if (!sock) return null
    const pn = jidNormalizedUser(jid)
    try {
      // No mapping ⇒ this account isn't LID-addressed, so inbound arrives under
      // the phone JID and that IS the key.
      return (await sock.signalRepository.lidMapping.getLIDForPN(pn)) ?? pn
    } catch {
      return null // never guess a key — a wrong one is worse than no bind
    }
  }

  /**
   * Point this chat at the conversation that just sent to it (see
   * bindChatToConversation for what that means and why). Everything
   * WhatsApp-specific is the key: the outbound JID has to be resolved to the
   * form the inbound path maps by, and the equality test has to run on THAT —
   * the map is exact-key, so comparing the phone JID would never match and
   * every send would rewrite.
   */
  private async bindChatToSendingConversation(jid: string): Promise<void> {
    const key = await this.inboundKeyForJid(jid)
    if (!key) return
    await bindChatToConversation(turnScope.getStore()?.conversationId, {
      getBoundConversationId: () => getConversationIdForJid(key),
      setBoundConversationId: (id) => setConversationIdForJid(key, id),
      updateConversation
    })
  }

  private async loadOrCreateConversation(jid: string): Promise<ConversationFile> {
    const existingId = await getConversationIdForJid(jid)
    if (existingId) {
      const loaded = await loadConversation(existingId)
      if (loaded) {
        const cfg = await getWhatsAppConfig()
        const autoRefresh = cfg.autoRefresh ?? true
        const staleMs = (cfg.staleHours ?? STALE_DEFAULT_HOURS) * 60 * 60 * 1000
        if (autoRefresh && loaded.messages.length > 0) {
          const elapsed = Date.now() - loaded.updatedAt
          if (elapsed >= staleMs) {
            // Idle rotation deliberately does NOT inherit the old
            // conversation's projectId (unlike /new): hitting the idle
            // limit closes the project — the fresh conversation is plain.
            const fresh = createConversation(null)
            fresh.channel = 'whatsapp'
            await saveConversation(fresh)
            await setConversationIdForJid(jid, fresh.id)
            const oldTitle = loaded.title || 'Untitled'
            const hours = Math.floor(elapsed / 3_600_000)
            let projectNote = ''
            if (loaded.projectId) {
              const project = (await listProjects().catch(() => [] as Project[])).find(
                (p) => p.id === loaded.projectId
              )
              projectNote = project
                ? ` Left ${projectLabel(project)} — use /project to re-enter it.`
                : ' Left its project — use /project to pick one.'
            }
            await this.safeSend(
              jid,
              `Conversation "${oldTitle}" was idle for ${hours}h — started a fresh one.${projectNote}\n\nUse /resume to go back.`
            )
            return fresh
          }
        }
        return loaded
      }
    }
    const fresh = createConversation(null)
    fresh.channel = 'whatsapp'
    await saveConversation(fresh)
    await setConversationIdForJid(jid, fresh.id)
    return fresh
  }

  // --- TurnSink (renders segments into WhatsApp messages) ---

  private createSink(turnId: string, conversationId: string | null, jid: string): TurnSink {
    return {
      channelId: 'whatsapp',
      turnId,
      conversationId,
      onSegment: (segment) => {
        this.enqueueRender(jid, async () => {
          await this.renderSegment(jid, segment)
          // Mirror AFTER the render so the snapshot sees the freshly appended
          // segment + accumulated prose. Throttled internally.
          this.scheduleMirror(jid, turnId)
        })
      },
      onTurnEvent: <E extends keyof CorpusEvents>(type: E, payload: CorpusEvents[E]): void => {
        const active = this.activeByJid.get(jid)
        if (!active || active.turnId !== turnId) return
        // Accumulate tokenomics for the persisted context-meter stats.
        active.stats.note(type, payload)
        if (type === 'task.created') {
          const task = payload as CorpusEvents['task.created']
          if (task.taskId) active.taskId = task.taskId
        }
      },
      onApprovalRequest: (req) => this.handleApprovalRequest(jid, turnId, req),
      onAskUserRequest: (req) => this.handleAskRequest(jid, turnId, req),
      onDone: () => {
        this.enqueueRender(jid, () => this.flushFinalText(jid))
      },
      onError: (error) => {
        void this.safeSend(jid, `Error: ${error}`)
      },
      onCredentialBlocked: () => {
        // Runner already pushed the canned reply through onSegment
      }
    }
  }

  private enqueueRender(jid: string, fn: () => Promise<void>): void {
    const prev = this.segmentQueue.get(jid) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.segmentQueue.set(jid, next)
  }

  private async renderSegment(jid: string, segment: Segment): Promise<void> {
    const active = this.activeByJid.get(jid)
    if (!active) return
    // A late segment from an aborted predecessor turn on this jid must not
    // bleed into the successor's transcript.
    if (segment.turnId !== active.turnId) return

    // Workflow/task snapshots supersede each other — keep only the latest
    // per run/task or a long run persists hundreds of full snapshots.
    if (segment.kind === 'workflow') upsertWorkflowSegment(active.segments, segment)
    else if (segment.kind === 'task') upsertTaskSegment(active.segments, segment)
    else if (segment.kind === 'countdown') upsertCountdownSegment(active.segments, segment)
    else if (segment.kind === 'wait') upsertWaitSegment(active.segments, segment)
    else if (segment.kind === 'process') upsertProcessSegment(active.segments, segment)
    else if (segment.kind === 'tool_result') upsertToolResultSegment(active.segments, segment)
    else if (segment.kind === 'todo') upsertTodoSegment(active.segments, segment)
    else if (segment.kind === 'text' || segment.kind === 'reasoning')
      appendTextSegment(active.segments, segment)
    else active.segments.push(segment)

    // The todo checklist is an in-app card; on a chat channel the model's
    // own narration carries progress, so the segment persists but sends nothing.
    if (segment.kind === 'todo') return

    if (segment.kind === 'workflow') {
      await this.renderWorkflowUpdate(jid, segment.snapshot)
      return
    }

    if (segment.kind === 'task') {
      // One compact heads-up when a video generation starts — WhatsApp has
      // no task card AND no typing indicator, so without this line a
      // multi-minute generation is absolute silence. 'submitted' occurs
      // exactly once per task, so this can't double-send. Terminal delivery
      // is the model's job (video_await → whatsapp_send_video), with the
      // manager's fallback covering a dead turn.
      if (segment.snapshot.status === 'submitted') {
        const video = segment.snapshot.video
        const mins = Math.max(1, Math.round(segment.snapshot.estimateSeconds / 60))
        const facts = video ? ` (${video.resolution}, ${video.durationSeconds}s)` : ''
        await this.safeSend(
          jid,
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
      await this.flushPendingActiveModel(jid)
      active.textBuffer += segment.delta
      active.assistantContent += segment.delta
      return
    }

    if (segment.kind === 'tool_call') {
      active.toolCallNames.set(segment.toolCallId, segment.name)
      active.toolTimings.set(segment.toolCallId, { startedAt: Date.now() })
      if (segment.worker) return // LEGACY orchestrator-mode segments — see text branch
      await this.flushPendingActiveModel(jid)
      await this.flushBufferedText(jid)
      // ask_user posts its own formatted question via onAskUserRequest — never
      // surface the raw tool call (even in verbose), or the question doubles up.
      if (segment.name === ASK_USER_TOOL) return
      // offer_options carries its whole card in the ARGS — there is no result
      // to render later — so it posts here, in clean and verbose alike: it is
      // content the model produced FOR the user, not tool mechanics. One
      // message per option, each body in a ``` block, which is the closest
      // WhatsApp has to the in-app copy button.
      if (segment.name === OFFER_OPTIONS_TOOL) {
        await this.sendOptionsCard(jid, segment.args)
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
      const args = formatArgs(segment.args)
      const msg =
        args.length > 0 ? `⚙️ *${segment.name}*\n\`\`\`\n${args}\n\`\`\`` : `⚙️ *${segment.name}*`
      await this.safeSend(jid, msg)
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
      // Workflow tool results are the master's input — the phase messages are
      // the user surface.
      if (name && WORKFLOW_TOOL_NAMES.has(name)) return
      const heading = name ? `${icon} *${name}*` : icon
      const output = segment.output?.trim() ?? ''
      // An stt_* result's file payload is the user's SOURCE recording (an
      // input, already transcribed), not a deliverable — never echo its audio.
      const isSttResult = name?.startsWith('stt_') ?? false
      // One voice memo reply per turn: suppress a redone voice_respond so the
      // model responding twice can't send two memos. Gated on success so the
      // dedup only ever suppresses a *successful* re-send; a FAILED voice_respond
      // isn't deduped here — in verbose it surfaces as an error, on the clean
      // feed it's dropped by the gate below. voice_generate assets
      // (isResponse:false) are unaffected — they fall through and each send.
      if (name === 'voice_respond' && active.voiceReplySent && segment.status === 'success') {
        return
      }

      const imagePaths = extractWolffishMediaPaths(output)
      if (imagePaths.length > 0) {
        await this.safeSend(jid, heading)
        for (const imgPath of imagePaths) {
          await this.sendImageFile(jid, imgPath)
        }
        const remaining = stripWolffishMediaMarkdown(output).trim()
        if (remaining.length > 0) {
          await this.safeSend(jid, blockquote(truncateToolOutput(remaining)))
        }
        return
      }

      const docPaths = extractDocumentPaths(output)
      if (docPaths.length > 0) {
        await this.safeSend(jid, heading)
        for (const docPath of docPaths) {
          await this.sendDocumentFile(jid, docPath)
        }
        return
      }

      const avPaths = isSttResult ? [] : extractAudioVideoPaths(output)
      if (avPaths.length > 0) {
        await this.safeSend(jid, heading)
        for (const av of avPaths) {
          if (av.type === 'audio') {
            await this.sendAudioFile(jid, av.path)
          } else {
            await this.sendVideoFile(jid, av.path)
          }
        }
        // Mark the single voice reply as delivered (last-write dedup above).
        if (name === 'voice_respond') active.voiceReplySent = true
        return
      }

      // Generic files (any extension) explicitly delivered via send_file —
      // upload them as native documents.
      const filePaths = extractGenericFilePaths(output)
      if (filePaths.length > 0) {
        await this.safeSend(jid, heading)
        for (const filePath of filePaths) {
          await this.sendDocumentFile(jid, filePath)
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
        await this.safeSend(jid, heading)
        return
      }
      // Deliberately NOT markdown-converted: tool output is not model
      // prose — it's frequently code/shell text (def f(**a), # comments)
      // that the converter would corrupt, and failed results shown here
      // are diagnostics the user may be debugging against verbatim.
      await this.safeSend(jid, `${heading}\n${blockquote(truncateToolOutput(output))}`)
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
      const via = model && model !== 'truncate' ? ` via ${model}` : ''
      const msg =
        `🗜️ *Context compacted* — ${segment.targetsCount}` +
        ` message${segment.targetsCount !== 1 ? 's' : ''} compacted, ` +
        `~${saved} tokens saved${via}`
      await this.safeSend(jid, msg)
      return
    }

    if (segment.kind === 'turn_end') {
      active.stopReason = segment.stopReason
      active.pendingActiveModel = null
      await this.flushBufferedText(jid)
      return
    }

    if (segment.kind === 'active_model') {
      active.pendingActiveModel = segment.model
      return
    }
  }

  private async flushPendingActiveModel(jid: string): Promise<void> {
    const active = this.activeByJid.get(jid)
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
    await this.safeSend(jid, `🤖 *${model}*`)
  }

  /**
   * Turn a workflow snapshot into channel progress messages by diffing it
   * against the last seen snapshot: run start (with the plan), phase
   * start/completion (always sent — the channel has no card, these ARE the
   * workflow surface), per-agent landings (also always sent — the workflow
   * panel surfaces in ALL modes, the clean feed never suppresses it), and the
   * closing summary. Deterministic: everything derives from harness telemetry.
   * Composed directly in WhatsApp's own formatting — these are
   * channel-constructed lines, not model prose.
   */
  private async renderWorkflowUpdate(jid: string, snapshot: WorkflowSnapshot): Promise<void> {
    const active = this.activeByJid.get(jid)
    if (!active) return
    const prev = active.workflowState.get(snapshot.workflowId)
    active.workflowState.set(snapshot.workflowId, snapshot)
    // Master narration lands before the progress it precedes.
    await this.flushBufferedText(jid)
    const phaseTitles = snapshot.phases.map((p) => p.title)
    if (!prev) {
      const planLine = phaseTitles.length > 0 ? `\n${phaseTitles.join(' → ')}` : ''
      const noteLine = snapshot.note ? `\n_${snapshot.note}_` : ''
      await this.safeSend(jid, `🔀 *Workflow started*${planLine}${noteLine}`)
    } else {
      const prevPlan = prev.phases.map((p) => p.title).join('|')
      if (phaseTitles.length > 0 && prevPlan !== phaseTitles.join('|')) {
        await this.safeSend(jid, `🔀 *Plan:* ${phaseTitles.join(' → ')}`)
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
        await this.safeSend(jid, `▶️ *Phase ${i + 1}/${total}:* ${ph.title}`)
      } else if (ph.status === 'done' && before === 'active') {
        const count = snapshot.agents.filter((a) => a.phase === ph.title).length
        await this.safeSend(
          jid,
          `✅ *Phase ${i + 1}/${total} done:* ${ph.title} (${count} agent${count === 1 ? '' : 's'})`
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
          await this.safeSend(
            jid,
            `${icon} *${a.name}* · ${a.provider}/${a.model} — ${a.status}${secs ? ` in ${formatWorkflowDuration(secs)}` : ''} · ${a.toolCalls} tool${a.toolCalls === 1 ? '' : 's'}`
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
      await this.safeSend(
        jid,
        `${icon} *Workflow ${snapshot.status}* — ${snapshot.totals.agents} agent${snapshot.totals.agents === 1 ? '' : 's'} · ${snapshot.totals.toolCalls} tool call${snapshot.totals.toolCalls === 1 ? '' : 's'} · ${formatWorkflowDuration(secs)}`
      )
    }
  }

  private async flushBufferedText(jid: string): Promise<void> {
    const active = this.activeByJid.get(jid)
    if (!active) return
    const raw = active.textBuffer
    active.textBuffer = ''

    // The wolffish-media:// scheme is honored here — in the model's OWN
    // prose — because embedding it is the model's deliberate act of
    // showing an image (the one image-marker exception in the channel
    // overlay). Tool results don't get that treatment (see
    // extractWolffishMediaPaths). Beyond stripping those markers the
    // prose is sent VERBATIM: the model writes WhatsApp formatting
    // itself (CHANNEL_PROMPTS in runtime/prefrontal.ts) — there is no
    // Markdown converter between the model and the user.
    const imagePaths = extractWolffishMediaPaths(raw, { includeMediaScheme: true })
    const cleaned = stripWolffishMediaMarkdown(raw).trim()

    if (cleaned.length > 0) {
      for (const chunk of splitForWhatsApp(cleaned)) {
        await this.safeSend(jid, chunk)
      }
      // Observe-and-notify (never rewrite, never withhold): the block above
      // was DELIVERED exactly as the model wrote it — the delivery guarantee
      // outranks formatting — but if it violates the WhatsApp contract
      // (leaked Markdown, HTML) the model is told on its next iteration via
      // the runner's formatNotices pull so it writes clean WhatsApp markup
      // in the remaining blocks. Validated on the whole un-split block: a
      // length split can cut a marker pair in half and fake a clean chunk.
      const report = validateWhatsAppFormat(cleaned)
      if (report.hard.length > 0) {
        const issues = report.hard.slice(0, 3).join(' ')
        active.formatNotices.push(
          `⚠️ Channel formatting: your prose was already DELIVERED to the user's WhatsApp chat with raw markup — ${issues} EVERY prose block you write in this conversation, including narration between tool calls, goes verbatim to their phone as a WhatsApp message (WhatsApp markup only: *bold* _italic_ \`code\`, NEVER Markdown, NEVER HTML). Write clean WhatsApp formatting in every remaining prose block.`
        )
      }
    }
    for (const imgPath of imagePaths) {
      await this.sendImageFile(jid, imgPath)
    }
  }

  /**
   * Drain every parked channel-format notice for this jid — the pull end
   * of the observe-and-notify loop (TurnSendOptions.formatNotices). Merges
   * notices carried over from a previous turn (a leak in the final prose
   * block has no next iteration inside its own turn) with the live turn's.
   */
  private drainFormatNotices(jid: string): string[] {
    const pending = this.pendingFormatNotices.get(jid) ?? []
    this.pendingFormatNotices.delete(jid)
    const active = this.activeByJid.get(jid)
    const live = active ? active.formatNotices.splice(0) : []
    return [...pending, ...live]
  }

  private async flushFinalText(jid: string): Promise<void> {
    await this.flushBufferedText(jid)
  }

  private handleApprovalRequest(
    jid: string,
    turnId: string,
    req: ApprovalRequest & { id: string }
  ): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      const active = this.activeByJid.get(jid)
      // Requesting turn must still own this jid's slot — a stale request
      // from an aborted predecessor fails closed instead of hijacking the
      // successor's pending-approval state.
      if (!active || active.turnId !== turnId) {
        resolve('denied')
        return
      }

      if (active.pendingApprovalResolve) {
        active.pendingApprovalResolve('denied')
        const prior = active.pendingApprovalId
        if (prior) {
          const stored = active.approvals.get(prior)
          if (stored && !stored.decision) stored.decision = 'denied'
        }
      }

      active.pendingApprovalId = req.id
      active.pendingApprovalResolve = resolve

      active.approvals.set(req.id, {
        approvalId: req.id,
        toolCallId: req.toolCall.id,
        tool: req.toolCall.name,
        args: req.toolCall.args,
        reason: req.reason,
        level: req.level,
        description: req.description
      })

      const parts: string[] = [`*Approval required:* ${req.toolCall.name}`]
      if (req.description?.title) parts.push(req.description.title)
      if (req.description?.description) parts.push(req.description.description)
      if (req.reason) parts.push(`Reason: ${req.reason}`)
      const args = formatArgs(req.toolCall.args)
      if (args.length > 0) parts.push(args)
      parts.push('\nReply "approve" or "deny".')
      void this.safeSend(jid, parts.join('\n\n'))
    })
  }

  /**
   * Ask the user multiple-choice question(s) and resolve once they've
   * answered them all. Questions are posted one at a time as numbered
   * lists; each next message answers the current one (a number picks an
   * option, other text becomes custom instructions), and the request
   * resolves with every answer once the last question is done. Mirrors
   * handleApprovalRequest — resolver lives on the active turn, fired by
   * resolvePendingAsk or drained canceled at turn end.
   */
  private handleAskRequest(
    jid: string,
    turnId: string,
    req: AskUserRequest & { id: string }
  ): Promise<AskUserResponse> {
    return new Promise<AskUserResponse>((resolve) => {
      const active = this.activeByJid.get(jid)
      if (!active || active.turnId !== turnId || req.questions.length === 0) {
        resolve({ kind: 'canceled' })
        return
      }
      if (active.pendingAskResolve) active.pendingAskResolve({ kind: 'canceled' })
      active.pendingAsk = { id: req.id, questions: req.questions, current: 0, answers: [] }
      active.pendingAskResolve = resolve
      void this.safeSend(jid, formatAskQuestionPlain(req.questions[0], 0, req.questions.length))
    })
  }

  /** Interpret the user's reply to the current outstanding ask_user question. */
  private async resolvePendingAsk(jid: string, active: ActiveTurn, text: string): Promise<void> {
    const pending = active.pendingAsk
    const resolve = active.pendingAskResolve
    if (!pending || !resolve) return
    const question = pending.questions[pending.current]
    const n = question.options.length
    const outcome = interpretAskReply(text, n, question.allowOther)

    if (outcome.kind === 'reprompt') {
      // Keep the question pending and tell the user how to answer.
      await this.safeSend(
        jid,
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
    // without waiting on a WhatsApp roundtrip (same ordering as before).
    const finished = pending.current + 1 >= pending.questions.length
    if (finished) {
      active.pendingAsk = null
      active.pendingAskResolve = null
      resolve({ kind: 'answered', answers: pending.answers })
    }

    if (outcome.kind === 'option') {
      // Same sanitization the question card applies to this label —
      // otherwise a model-authored '**Deploy now**' echoes back raw.
      await this.safeSend(
        jid,
        `✅ Option ${outcome.index + 1}: ${stripInlineMarkup(question.options[outcome.index].label)}`
      )
    } else {
      await this.safeSend(jid, '✅ Got it — using your instructions.')
    }

    // More questions? Post the next one and keep the request pending.
    if (!finished) {
      pending.current++
      await this.safeSend(
        jid,
        formatAskQuestionPlain(
          pending.questions[pending.current],
          pending.current,
          pending.questions.length
        )
      )
    }
  }

  // --- Mid-turn messages: interject first, sliver queue second ---
  // (see runtime/agent/interjection.ts and channels/message-queue.ts)

  /**
   * True while this jid cannot take a new turn. `dispatchingByJid` is the
   * synchronous setup claim, `activeByJid` the running turn, and the runner
   * lane covers one still QUEUED behind a predecessor — the same trio
   * dispatchTurn gates on.
   */
  private isJidBusy(jid: string, conversationId?: string): boolean {
    if (this.dispatchingByJid.has(jid) || this.activeByJid.has(jid)) return true
    if (conversationId && this.runner.isConversationActive(conversationId)) return true
    return false
  }

  /**
   * The conversation a busy jid's message belongs to: the running turn's own
   * conversation when we hold one (never re-read the mapping mid-turn), else
   * the jid mapping (memory-cached after the first hit).
   */
  private async resolveConversationId(jid: string): Promise<string | null> {
    const active = this.activeByJid.get(jid)
    if (active) return active.conversation.id
    return await getConversationIdForJid(jid).catch(() => null)
  }

  /**
   * A message that arrived while this jid is busy. INTERJECT FIRST: hand it
   * to the running turn, which reads it at its next stop point and answers
   * it inside the same run. Only when the runner has no lane for the
   * conversation yet — the pre-send sliver behind `dispatchingByJid`, where
   * the conversation load / download / STT is still running before
   * runner.send registers the turn — does it fall back to the sliver queue,
   * whose flush interjects again before it would ever start its own turn.
   * Twin of the Telegram implementation; both acks read the same on the
   * phone.
   */
  private async parkMessage(jid: string, item: QueuedWhatsAppMessage): Promise<void> {
    const conversationId = await this.resolveConversationId(jid)
    if (conversationId && this.tryInterject(jid, conversationId, item)) {
      await this.safeSend(jid, interjectionAckText(item.attachments.length))
      return
    }
    await this.enqueueMessage(jid, item)
  }

  /**
   * Offer one message to the conversation's running turn. True when the
   * runner accepted it (pending on the turn's inbox; this channel owns its
   * lifecycle from here — see onInterjectionEvent), false when there is no
   * live lane and the caller must queue or dispatch. The jid record is
   * written BEFORE the call: `pending` is emitted synchronously from inside
   * interject, and a terminal event may follow in the same tick.
   */
  private tryInterject(jid: string, conversationId: string, item: QueuedWhatsAppMessage): boolean {
    this.interjectedByMessageId.set(item.id, { jid })
    const interjection: Interjection = {
      messageId: item.id,
      text: item.text,
      attachments: item.attachments,
      ...(item.voicePrompt ? { voicePrompt: true } : {}),
      ...(item.voiceLang ? { voiceLang: item.voiceLang } : {}),
      channel: 'whatsapp',
      sentAt: Date.now()
    }
    const result = this.runner.interject(conversationId, interjection)
    if (result.status === 'pending') return true
    this.interjectedByMessageId.delete(item.id)
    return false
  }

  /**
   * /cancel: withdraw every interjection this channel sent for the jid's
   * conversation that the turn has not read yet, then clear the sliver queue.
   * Returns the combined count; an already-read message is history and is
   * neither withdrawn nor counted.
   */
  private async dropUnread(jid: string): Promise<number> {
    let withdrawn = 0
    const conversationId = await this.resolveConversationId(jid)
    if (conversationId) {
      for (const pending of this.runner.pendingInterjections(conversationId)) {
        if (pending.channel !== 'whatsapp') continue
        if (this.runner.withdrawInterjection(conversationId, pending.messageId, 'user')) withdrawn++
      }
    }
    return withdrawn + this.clearQueue(jid)
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
   * Lifecycle of the interjections THIS channel sent; every other channel's
   * messages, and events for messages we never recorded, are ignored.
   * Mirrors the Telegram twin — see its comment for why a turn_ended/error
   * return goes through the sliver queue and not a direct re-interject or
   * dispatch (the sweep fires while the finished lane is still counted).
   * A `canceled` return (the user sent /stop) is reported and never resent.
   */
  private onInterjectionEvent(ev: InterjectionEvent): void {
    if (ev.channel !== 'whatsapp') return
    if (ev.state === 'pending') return
    const sender = this.interjectedByMessageId.get(ev.messageId)
    this.interjectedByMessageId.delete(ev.messageId)
    if (!sender || ev.state !== 'withdrawn') return
    if (ev.reason === 'turn_ended' || ev.reason === 'error') {
      this.queue.enqueue(sender.jid, {
        id: ev.messageId,
        text: ev.text,
        attachments: ev.attachments,
        ...(ev.voicePrompt ? { voicePrompt: true } : {}),
        ...(ev.voiceLang ? { voiceLang: ev.voiceLang } : {})
      })
      // Same gate as enqueueMessage: a running turn of ours is about to flush
      // from its cleanup; otherwise nothing else will.
      if (!this.activeByJid.has(sender.jid)) this.flushQueue(sender.jid)
      return
    }
    if (ev.reason === 'canceled') {
      void this.safeSend(sender.jid, unreadAfterStopText(ev.text, ev.attachments.length))
    }
  }

  /**
   * Park a message in the sliver queue and tell the user it landed. Reached
   * only when interject said no_live_turn (see parkMessage) — and directly by
   * the turn-ended re-dispatch, which skips the ack.
   *
   * The flush fires ONLY when no running turn owns this jid — see the Telegram
   * twin for the full reasoning. Short version: `activeByJid` is what the wait
   * polls, so flushing while it holds this jid starts a wait that can only
   * expire, and an expiry counts as a failed dispatch — three of them warned
   * the user their message was wedged on a turn that was merely long.
   *
   * Gated on `activeByJid` alone, NOT isJidBusy: `dispatchingByJid` is the
   * pre-turn setup claim, and a setup that early-returns releases it without
   * ever running the cleanup — so treating it as "a cleanup will flush" would
   * strand the queue until the next turn ended. The flush started here polls
   * through that setup and, the moment its turn goes live, hands the message
   * to it as an interjection instead of waiting for it to finish.
   */
  private async enqueueMessage(jid: string, item: QueuedWhatsAppMessage): Promise<void> {
    this.queue.enqueue(jid, item)
    await this.safeSend(jid, queuedAckText(item.attachments.length))
    if (!this.activeByJid.has(jid)) this.flushQueue(jid)
  }

  /**
   * Drain this jid's sliver queue in arrival order, INTERJECTING FIRST: an
   * item joins the turn that is live on the conversation by now and only
   * starts a turn of its own when there is no live lane. Twin of the
   * Telegram implementation — see its comments for why the macrotask yield
   * at the top of every iteration, the wait, the retry bound and the
   * fire-and-forget shape are each load-bearing.
   */
  private flushQueue(jid: string): void {
    if (this.flushingByJid.has(jid)) return
    if (this.queue.size(jid) === 0) return
    this.flushingByJid.add(jid)
    void (async () => {
      let attempts = 0
      try {
        while (this.queue.size(jid) > 0) {
          await new Promise((r) => setTimeout(r, 0))
          const state = await this.waitForFreeJid(jid)
          const next = this.queue.shift(jid)
          if (!next) return
          let started = false
          if (state === 'live') {
            const conversationId = await this.resolveConversationId(jid)
            // No ack: the user was told "I'll read it" when it was parked.
            started = !!conversationId && this.tryInterject(jid, conversationId, next)
          } else if (state === 'free') {
            // A throwing dispatch counts as a failed attempt, not a lost
            // message: the item is already off the queue here, so letting the
            // throw escape would drop what the user was promised we'd run.
            try {
              started = await this.dispatchTurn(jid, next.text, next.attachments, {
                voicePrompt: next.voicePrompt,
                voiceLang: next.voiceLang,
                fromQueue: true
              })
            } catch {
              started = false
            }
          }
          if (started) {
            attempts = 0
            continue
          }
          this.queue.requeue(jid, next)
          // Back off before retrying. Without this the attempt budget can burn
          // out in microseconds on a transient claim and cry wolf at the user.
          await new Promise((r) => setTimeout(r, QUEUE_FLUSH_POLL_MS))
          if (++attempts >= QUEUE_FLUSH_ATTEMPTS) {
            await this.safeSend(
              jid,
              "Still busy, so your queued messages haven't run yet. /stop frees the chat, /cancel drops them."
            )
            return
          }
        }
      } catch {
        // A failed flush must never wedge the chat — the queue survives and the
        // next end-of-turn cleanup retries it.
      } finally {
        this.flushingByJid.delete(jid)
      }
    })()
  }

  /**
   * Poll until this jid can take a turn ('free') or a turn goes live on its
   * conversation ('live' — the flush interjects into it). 'expired' means the
   * budget ran out with our own claim/slot still held and no lane live.
   *
   * Waiting on the RUNNER LANE, not just the per-jid slot, is load-bearing —
   * see the Telegram twin for the microtask-ordering window this closes. The
   * mapping read is memory-cached after the first hit. Only ever called after
   * the flush loop's macrotask yield, so the first check sees a settled lane.
   */
  private async waitForFreeJid(jid: string): Promise<'free' | 'live' | 'expired'> {
    const conversationId = (await getConversationIdForJid(jid).catch(() => null)) ?? undefined
    const deadline = Date.now() + this.queueFlushWaitMs
    for (;;) {
      if (conversationId && this.runner.isConversationActive(conversationId)) return 'live'
      if (!this.isJidBusy(jid, conversationId)) return 'free'
      if (Date.now() >= deadline) return 'expired'
      await new Promise((r) => setTimeout(r, QUEUE_FLUSH_POLL_MS))
    }
  }

  private clearQueue(jid: string): number {
    return this.queue.clear(jid)
  }

  /**
   * Drop the queue because this chat is being pointed at a DIFFERENT
   * conversation, and return a sentence the caller appends to its own reply.
   * A message parked for this chat must never flush into a fresh or resumed
   * conversation — the in-app queue clears on conversation switch for exactly
   * this reason. Silent when nothing was queued.
   */
  private dropQueueForRotation(jid: string): string {
    const dropped = this.clearQueue(jid)
    if (dropped === 0) return ''
    return dropped === 1
      ? ' 1 queued message was dropped with it.'
      : ` ${dropped} queued messages were dropped with it.`
  }

  // --- Busy handling ---

  private async sendBusyReply(jid: string, userText: string): Promise<void> {
    if (!this.localProvider.isReady) {
      await this.safeSend(jid, FALLBACK_BUSY_REPLY)
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
    await this.safeSend(jid, trimmed.length > 0 ? trimmed : FALLBACK_BUSY_REPLY)
  }

  // --- Sending ---

  /**
   * Post an offer_options card as messages. Tabs don't exist here, so every
   * option is sent in order under its letter with the body in a ``` block;
   * a per-option message keeps each snippet independently long-press-copyable
   * and each send comfortably small.
   */
  private async sendOptionsCard(jid: string, args: Record<string, unknown>): Promise<void> {
    const card = renderOptionsForChannel(args)
    if (!card) return
    await this.safeSend(jid, `🗂 *${card.title ?? `${card.options.length} options to copy`}*`)
    for (const option of card.options) {
      const note = option.description ? `\n_${option.description}_` : ''
      const cut = option.truncated ? '\n_(shortened — the full version is in the app)_' : ''
      await this.safeSend(
        jid,
        `*${option.letter} · ${option.title}*${note}\n\`\`\`\n${option.content}\n\`\`\`${cut}`
      )
    }
  }

  private async safeSend(jid: string, text: string): Promise<void> {
    if (!this.sock) return
    try {
      const sent = await this.sock.sendMessage(jid, { text })
      if (sent?.key.id) {
        this.sentIds.add(sent.key.id)
        this.agent.corpus.emit('whatsapp.message.sent', { remoteJid: jid })
      }
    } catch {
      // best-effort — connection may have dropped
    }
  }

  /**
   * Existence + size in one stat, ahead of the read. Replaces a bare
   * `fs.access` that only answered the first question: the 50 MB ceiling used
   * to sit in the send_file tool, so nothing on this side had to think about
   * size. That cap is gone (it was Telegram's number applied to every surface,
   * including the in-app chat and the CLI, which upload nothing), so the guard
   * that keeps a multi-GB file out of memory has to be here — at the one place
   * that actually uploads.
   */
  private async guardUploadSize(jid: string, filePath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(filePath)
      if (stat.size <= MAX_WHATSAPP_MEDIA_BYTES) return true
      await this.safeSend(
        jid,
        `📎 ${path.basename(filePath)} is ${formatBytes(stat.size)} — over WhatsApp's ${formatBytes(MAX_WHATSAPP_MEDIA_BYTES)} limit. It is saved at ${filePath}.`
      )
      return false
    } catch {
      return false
    }
  }

  private async sendImageFile(jid: string, filePath: string): Promise<void> {
    if (!this.sock) return
    const resolved = path.resolve(filePath)
    const active = this.activeByJid.get(jid)
    if (active?.sentFiles.has(resolved)) return
    try {
      if (!(await this.guardUploadSize(jid, resolved))) return
      const buffer = await fs.readFile(resolved)
      const ext = path.extname(resolved).toLowerCase()
      // Animated GIFs can't ride as an imageMessage (WhatsApp drops them) — send
      // them through the video/gifPlayback path so they deliver and loop.
      if (ext === '.gif') {
        await this.sendGifFile(jid, resolved, buffer)
        if (active) active.sentFiles.add(resolved)
        return
      }
      const IMAGE_MIME: Record<string, string> = {
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
        '.tiff': 'image/tiff',
        '.tif': 'image/tiff'
      }
      const mimetype = IMAGE_MIME[ext] ?? 'image/jpeg'
      const sent = await this.sock.sendMessage(jid, {
        image: buffer,
        mimetype
      })
      if (sent?.key.id) {
        this.sentIds.add(sent.key.id)
      }
      if (active) active.sentFiles.add(resolved)
    } catch {
      // best-effort
    }
  }

  // Send an animated GIF the way WhatsApp expects: transcoded to mp4 and sent
  // as video with gifPlayback so it loops. Long clips go as a normal video;
  // if ffmpeg is unavailable the original GIF is delivered as a document so it
  // still arrives rather than being silently dropped as an imageMessage.
  private async sendGifFile(jid: string, resolved: string, buffer: Buffer): Promise<void> {
    if (!this.sock) return
    // Self-install the bundled ffmpeg if missing, so the GIF plays as a GIF
    // rather than degrading to the document fallback.
    await this.agent.cerebellum.ensureSystemTool('ffmpeg')
    const converted = await transcodeGifToMp4(buffer)
    if ('error' in converted) {
      const sent = await this.sock.sendMessage(jid, {
        document: buffer,
        fileName: path.basename(resolved),
        mimetype: 'image/gif'
      })
      if (sent?.key.id) this.sentIds.add(sent.key.id)
      return
    }
    const sent = await this.sock.sendMessage(jid, {
      video: converted.mp4,
      gifPlayback: converted.durationSec <= GIF_PLAYBACK_MAX_SECONDS,
      mimetype: 'video/mp4'
    })
    if (sent?.key.id) this.sentIds.add(sent.key.id)
  }

  private async sendDocumentFile(jid: string, filePath: string): Promise<void> {
    if (!this.sock) return
    const resolved = path.resolve(filePath)
    const active = this.activeByJid.get(jid)
    if (active?.sentFiles.has(resolved)) return
    try {
      if (!(await this.guardUploadSize(jid, resolved))) return
      const buffer = await fs.readFile(resolved)
      const ext = path.extname(resolved).toLowerCase()
      const MIME: Record<string, string> = {
        '.pdf': 'application/pdf',
        '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.ppt': 'application/vnd.ms-powerpoint',
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.csv': 'text/csv'
      }
      const mimetype = MIME[ext] ?? 'application/octet-stream'
      const sent = await this.sock.sendMessage(jid, {
        document: buffer,
        mimetype,
        fileName: path.basename(resolved)
      })
      if (sent?.key.id) {
        this.sentIds.add(sent.key.id)
      }
      if (active) active.sentFiles.add(resolved)
    } catch {
      // best-effort
    }
  }

  private async sendAudioFile(jid: string, filePath: string): Promise<void> {
    if (!this.sock) return
    const resolved = path.resolve(filePath)
    const active = this.activeByJid.get(jid)
    if (active?.sentFiles.has(resolved)) return
    try {
      if (!(await this.guardUploadSize(jid, resolved))) return
      const buffer = await fs.readFile(resolved)
      const ext = path.extname(resolved).toLowerCase()
      const AUDIO_MIME: Record<string, string> = {
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.m4a': 'audio/mp4',
        '.ogg': 'audio/ogg',
        '.flac': 'audio/flac',
        '.aac': 'audio/aac',
        '.wma': 'audio/x-ms-wma',
        '.opus': 'audio/opus',
        '.webm': 'audio/webm'
      }
      const mimetype = AUDIO_MIME[ext] ?? 'audio/mpeg'
      const sent = await this.sock.sendMessage(jid, {
        audio: buffer,
        mimetype,
        fileName: path.basename(resolved)
      })
      if (sent?.key.id) {
        this.sentIds.add(sent.key.id)
      }
      if (active) active.sentFiles.add(resolved)
    } catch {
      // best-effort
    }
  }

  private async sendVideoFile(jid: string, filePath: string): Promise<void> {
    if (!this.sock) return
    const resolved = path.resolve(filePath)
    const active = this.activeByJid.get(jid)
    if (active?.sentFiles.has(resolved)) return
    try {
      if (!(await this.guardUploadSize(jid, resolved))) return
      let buffer: Buffer = await fs.readFile(resolved)
      const ext = path.extname(resolved).toLowerCase()
      const VIDEO_MIME: Record<string, string> = {
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime',
        '.avi': 'video/x-msvideo',
        '.mkv': 'video/x-matroska',
        '.m4v': 'video/mp4',
        '.wmv': 'video/x-ms-wmv',
        '.flv': 'video/x-flv',
        '.webm': 'video/webm'
      }
      let mimetype = VIDEO_MIME[ext] ?? 'video/mp4'
      // WhatsApp inline video degrades sharply past ~16 MB (the image/audio
      // ceiling this channel already enforces elsewhere). Oversized videos
      // are re-encoded to fit; if even that fails they ride as a document
      // (100 MB ceiling) so the user still receives the file. The original
      // on disk keeps full quality either way.
      const WHATSAPP_VIDEO_LIMIT = 16 * 1024 * 1024
      let caption: string | undefined
      if (buffer.length > WHATSAPP_VIDEO_LIMIT) {
        await this.agent.cerebellum.ensureSystemTool('ffmpeg')
        const compressed = await compressVideoToLimit(resolved, WHATSAPP_VIDEO_LIMIT - 512 * 1024)
        if ('error' in compressed) {
          const sent = await this.sock.sendMessage(jid, {
            document: buffer,
            fileName: path.basename(resolved),
            mimetype
          })
          if (sent?.key.id) this.sentIds.add(sent.key.id)
          if (active) active.sentFiles.add(resolved)
          await this.safeSend(
            jid,
            `⚖️ Sent as a file — the video is too large for inline WhatsApp playback and compression failed. Original quality is available in the app.`
          )
          return
        }
        buffer = compressed.mp4
        mimetype = 'video/mp4'
        caption = `⚖️ ${compressed.note} — original quality is available in the app.`
      }
      const sent = await this.sock.sendMessage(jid, {
        video: buffer,
        mimetype,
        fileName: path.basename(resolved),
        ...(caption ? { caption } : {})
      })
      if (sent?.key.id) {
        this.sentIds.add(sent.key.id)
      }
      if (active) active.sentFiles.add(resolved)
    } catch (err) {
      // A silent drop here means the user was promised a video and got
      // nothing — say what happened instead.
      const detail = err instanceof Error ? err.message : String(err)
      await this.safeSend(
        jid,
        `🎬 Sending ${path.basename(resolved)} failed (${detail}). The video is available in the app.`
      ).catch(() => undefined)
    }
  }

  // --- Auth state management ---

  private async hasAuthCredentials(): Promise<boolean> {
    if (!this.authDir) return false
    try {
      const credsPath = path.join(this.authDir, 'creds.json')
      await fs.access(credsPath)
      const stat = await fs.stat(credsPath)
      return stat.size > 10
    } catch {
      return false
    }
  }

  requestQr(): void {
    this.qrRequested = true
    this.pairingNumber = null
    this.pairingCode = null
    if (!this.authDir) return
    if (this.status === 'disconnected' || this.status === 'error') {
      this.status = 'connecting'
      this.statusError = null
      this.reconnectAttempt = 0
      void this.connect()
    }
  }

  /**
   * Link by phone number rather than QR — the headless route.
   *
   * Returns immediately: the code cannot be asked for until the socket has
   * reached the point where WhatsApp would have handed us a QR, so the request
   * is armed here and fired from handleConnectionUpdate. The code arrives on
   * `whatsapp.pairingCode` and on the status snapshot, exactly the way the QR
   * does, so a caller that missed the event can still read it.
   *
   * Refuses while a session is live: this begins a NEW link, and doing it
   * silently under a working account would take the agent off WhatsApp.
   */
  requestPairingCode(phoneNumber: string): { ok: boolean; error?: string } {
    const digits = String(phoneNumber ?? '').replace(/[^0-9]/g, '')
    // WhatsApp wants country code + number, no plus and no separators. Below
    // eight digits cannot be a real one, and the failure this catches is a
    // user typing a local number without its country code, which otherwise
    // fails minutes later with an opaque server error.
    if (digits.length < 8) {
      return { ok: false, error: 'give the full number including country code, e.g. +15551234567' }
    }
    if (this.status === 'connected') {
      return { ok: false, error: 'already linked — disconnect first to link a different account' }
    }
    if (!this.authDir) return { ok: false, error: 'WhatsApp is not started' }
    this.qrRequested = true
    this.pairingNumber = digits
    this.pairingCode = null
    if (this.status === 'disconnected' || this.status === 'error') {
      this.status = 'connecting'
      this.statusError = null
      this.reconnectAttempt = 0
      void this.connect()
    }
    return { ok: true }
  }

  /**
   * Ask WhatsApp for the eight-character code, once, on the socket that is
   * currently negotiating. Failures land on the status as an error rather than
   * throwing into an event handler.
   */
  private async askForPairingCode(sock: WASocket, number: string): Promise<void> {
    this.pairingNumber = null
    try {
      const code = await sock.requestPairingCode(number)
      if (this.sock !== sock) return
      this.pairingCode = code
      this.status = 'qr'
      this.statusError = null
      this.agent.corpus.emit('whatsapp.pairingCode', { code })
      this.agent.corpus.emit('whatsapp.statusChanged', {})
    } catch (error) {
      if (this.sock !== sock) return
      this.pairingCode = null
      this.status = 'error'
      this.statusError =
        error instanceof Error ? error.message : 'WhatsApp refused the pairing request'
      this.agent.corpus.emit('whatsapp.statusChanged', {})
    }
  }

  private async clearAuthState(): Promise<void> {
    if (!this.authDir) return
    try {
      const entries = await fs.readdir(this.authDir)
      await Promise.all(entries.map((e) => fs.rm(path.join(this.authDir!, e), { force: true })))
    } catch {
      // best-effort
    }
    this.hadValidSession = false
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function classifyError(error: Boom | undefined): WhatsAppErrorKind {
  if (!error) return 'unknown'
  const msg = (error.message ?? '').toLowerCase()
  const stack = (error.stack ?? '').toLowerCase()
  const combined = msg + '\n' + stack

  if (combined.includes('bad mac') || combined.includes('unable to authenticate data'))
    return 'crypto'
  if (
    combined.includes('econnrefused') ||
    combined.includes('enotfound') ||
    combined.includes('timeout') ||
    combined.includes('network')
  )
    return 'network'
  if (combined.includes('stream error') || combined.includes('515')) return 'stream'
  if (error.output?.statusCode === DisconnectReason.loggedOut) return 'auth'

  return 'unknown'
}

function formatArgs(args: Record<string, unknown>): string {
  try {
    const str = JSON.stringify(args, null, 2)
    return str.length > 1000 ? str.slice(0, 1000) + '...' : str
  } catch {
    return ''
  }
}

function formatPickerItem(conv: ConversationMeta, idx: number): string {
  const keycap = keycapNumber(idx + 1)
  const title = truncateTitle(conv.title)
  const msgs = conv.messageCount ?? 0
  const ago = relativeTime(conv.updatedAt)
  return `${keycap} *${title}*\n    ${msgs} messages · ${ago} · ${originLabel(conv.channel)}`
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

/**
 * The argument tail after a command word, lower-cased and trimmed — recovers
 * "workflow" from "/mode workflow" (or "mode workflow") and "opus" from
 * "/model opus". WhatsApp accepts both slashed and bare command words, so
 * this keys off the first whitespace rather than a leading slash.
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

/**
 * Render ONE ask_user question as a WhatsApp message: bold question (with a
 * "Question i of n" line when the request carries several), optional
 * details, a numbered list (label + description), and a hint on how to
 * answer. The free-text "something else" option isn't numbered — the hint
 * tells the user they can just type their own instructions instead.
 */
function formatAskQuestionPlain(q: AskUserQuestion, index: number, total: number): string {
  // The channel overlay instructs the model to write ask_user text as
  // plain prose, so details/descriptions pass through verbatim. The
  // question and labels are embedded inside this card's own *bold*
  // wrappers — flatten any stray inline markers so they can't break
  // the span.
  const parts: string[] = [`❓ *${stripInlineMarkup(q.question)}*`]
  if (total > 1) parts.push(`_Question ${index + 1} of ${total}_`)
  if (q.details) parts.push(q.details)
  const list = q.options
    .map((opt, i) => {
      const head = `*${i + 1}.* ${stripInlineMarkup(opt.label)}`
      return opt.description ? `${head}\n${opt.description}` : head
    })
    .join('\n\n')
  parts.push(list)
  const count = q.options.length
  parts.push(
    q.allowOther
      ? `_Reply with a number (1–${count}) to choose — or just type what you'd rather do._`
      : `_Reply with a number (1–${count}) to choose._`
  )
  return parts.join('\n\n')
}

/**
 * Pull the transcript text out of an stt_transcribe tool result (a JSON blob
 * with a `text` field). Falls back to the raw trimmed output. Mirrors the
 * Telegram channel's extractTranscript.
 */
function extractTranscriptText(rawOutput: string): string {
  const trimmed = rawOutput.trim()
  if (trimmed.length === 0) return ''
  try {
    const parsed = JSON.parse(trimmed) as { text?: unknown }
    if (parsed && typeof parsed.text === 'string') return parsed.text.trim()
  } catch {
    // not JSON; fall through to raw
  }
  return trimmed
}

/**
 * Pull Whisper's detected language (ISO 639-1) out of an stt_transcribe
 * result. Returns '' when absent — callers fall back to a plain <voice_note>.
 */
function extractVoiceLanguage(rawOutput: string): string {
  const trimmed = rawOutput.trim()
  if (trimmed.length === 0) return ''
  try {
    const parsed = JSON.parse(trimmed) as { language?: unknown }
    if (parsed && typeof parsed.language === 'string') return parsed.language.trim()
  } catch {
    // not JSON
  }
  return ''
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

const WHATSAPP_MESSAGE_LIMIT = 4096

/** "42s" under 90s, then "3m 20s" — compact wall-clock for workflow messages. */
function formatWorkflowDuration(secs: number): string {
  if (secs < 90) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}

function splitForWhatsApp(text: string): string[] {
  if (text.length <= WHATSAPP_MESSAGE_LIMIT) return [text]
  const out: string[] = []
  let remaining = text
  while (remaining.length > WHATSAPP_MESSAGE_LIMIT) {
    const slice = remaining.slice(0, WHATSAPP_MESSAGE_LIMIT)
    let cut = slice.lastIndexOf('\n\n')
    if (cut < WHATSAPP_MESSAGE_LIMIT * 0.5) cut = slice.lastIndexOf('\n')
    if (cut < WHATSAPP_MESSAGE_LIMIT * 0.5) cut = slice.lastIndexOf('. ')
    if (cut < WHATSAPP_MESSAGE_LIMIT * 0.5) cut = WHATSAPP_MESSAGE_LIMIT
    out.push(remaining.slice(0, cut).trimEnd())
    remaining = remaining.slice(cut).trimStart()
  }
  if (remaining.length > 0) out.push(remaining)
  return out
}

const TOOL_OUTPUT_LIMIT = 1500

function truncateToolOutput(text: string): string {
  if (text.length <= TOOL_OUTPUT_LIMIT) return text
  return text.slice(0, TOOL_OUTPUT_LIMIT - 1) + '…'
}

function blockquote(text: string): string {
  return text
    .split('\n')
    .map((line) => '> ' + line.trimStart())
    .join('\n')
}
