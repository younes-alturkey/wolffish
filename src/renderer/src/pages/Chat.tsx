import { ApprovalCard } from '@components/common/approval-card/ApprovalCard'
import { AttachmentList } from '@components/common/attachment-list/AttachmentList'
import { AudioPlayer } from '@components/common/audio-player/AudioPlayer'
import { CompactionCard } from '@components/common/compaction-card/CompactionCard'
import { ContextMeter, type SideSpend } from '@components/common/context-meter/ContextMeter'
import { DocxViewer } from '@components/common/docx-viewer/DocxViewer'
import { ChartCard } from '@components/common/chart-card/ChartCard'
import { FileCard } from '@components/common/file-card/FileCard'
import { HtmlFileViewer } from '@components/common/html-file-viewer/HtmlFileViewer'
import { ImageViewer } from '@components/common/image-viewer/ImageViewer'
import { MarkdownFileViewer } from '@components/common/markdown-file-viewer/MarkdownFileViewer'
import { ModelSwitch } from '@components/common/model-switch/ModelSwitch'
import { PageViewer } from '@components/common/page-viewer/PageViewer'
import { PathCard } from '@components/common/path-card/PathCard'
import { canonicalPath } from '@components/common/path-card/pathStat'
import { PdfViewer } from '@components/common/pdf-viewer/PdfViewer'
import { PresentationViewer } from '@components/common/presentation-viewer/PresentationViewer'
import { ProviderErrorCards } from '@components/common/provider-error-card/ProviderErrorCard'
import { QuestionCard } from '@components/common/question-card/QuestionCard'
import { OptionsCard } from '@components/common/options-card/OptionsCard'
import { ReasoningCard } from '@components/common/reasoning-card/ReasoningCard'
import { SpreadsheetViewer } from '@components/common/spreadsheet-viewer/SpreadsheetViewer'
import { ToolCard } from '@components/common/tool-card/ToolCard'

/** Plan-mode stance per conversation, for the session (see Chat's planMode state). */
const planModeByConversation = new Map<string, boolean>()
/**
 * The stance of a chat that has no conversation yet. A fresh chat gets its id
 * only when the first send creates the conversation, so the toggle needs a
 * key before then; the send path moves the stance under the real id.
 */
const NEW_CHAT_PLAN_KEY = '\u0000new-chat'
import { TurnFooter } from '@components/common/turn-footer/TurnFooter'
import { UpdateCard } from '@components/common/update-card/UpdateCard'
import { VideoPlayer } from '@components/common/video-player/VideoPlayer'
import { TaskCard } from '@components/common/task-card/TaskCard'
import { CountdownCard } from '@components/common/countdown-card/CountdownCard'
import { ProcessCard } from '@components/common/process-card/ProcessCard'
import { WaitCard } from '@components/common/wait-card/WaitCard'
import { TodoCard } from '@components/common/todo-card/TodoCard'
import { TouchedFolders } from '@components/common/touched-folders/TouchedFolders'
import { WorkflowCard } from '@components/common/workflow-card/WorkflowCard'
import { CodeEditor } from '@components/core/CodeEditor'
import { CopyButton } from '@components/core/CopyButton'
import { ExpandedSheet } from '@components/core/ExpandedSheet'
import { Markdown } from '@components/core/Markdown'
import { useToast } from '@components/core/toast/useToast'
import { buildChatPdfHtml, hasExportableContent } from '@lib/chat-export/buildChatPdfHtml'
import {
  mapConversationMessage,
  mapConversationMessages,
  reconcileFeedWithDisk
} from '@lib/conversation-open'
import { RTL_LOCALES } from '@lib/i18n'
import { cn } from '@lib/utils/cn'
import { formatBytesL, formatCompact } from '@lib/utils/format'
import { isWeb, pageTopPadding } from '@lib/utils/platform'
import { webTransport } from '@lib/web-bridge/boot'
import { finalizeAttachments } from '@lib/web-bridge/attachments'
import {
  changedDirectories,
  collectChangedFiles,
  folderChips,
  groupTouchedFolders
} from '@lib/touched-folders/touchedFolders'
import {
  CODE_ACTIVITY_TOOLS,
  latestTodoLists,
  todoListId,
  browserKey,
  WORKFLOW_TOOL_NAMES,
  type TaskSnapshot,
  type CountdownSnapshot,
  type WorkflowSnapshot,
  foldSegment
} from '@main/runtime/broca'
import { BrowserCard } from '@components/common/browser-card/BrowserCard'
import { keepLatestBrowserCard } from '@main/runtime/browser-card'
import {
  normalizeReasoningMode,
  reasoningModesFor,
  type ReasoningMode
} from '@main/runtime/reasoning'
import { preselectSettingsTab } from '@pages/settings/settingsNav'
import type {
  ApprovalDecision,
  AskUserResponse,
  BrowserTabSnapshot,
  ChatHistoryMessage,
  ConversationFile,
  ConversationStats,
  ConversationTurnStats,
  MessageAttachment,
  MessageAttachmentType,
  Segment,
  ThinkingMode,
  TimelineEntry,
  ProcessCardSnapshot,
  TodoItem
} from '@preload/index'
import {
  useFlow,
  type ApprovalCardState,
  type AskCardState,
  type AssistantMessage,
  type ChatMessage,
  type PendingProcedure,
  type ToolTiming
} from '@providers/flow/useFlow'
import { useLocale } from '@providers/locale/useLocale'
import { useOllama } from '@providers/ollama/useOllama'
import { useSessions, type SessionDescriptor } from '@providers/sessions/useSessions'
import { useTheme } from '@providers/theme/useTheme'
import iconTransparent from '@resources/images/icon_transparent.png'
import {
  ArrowUp02Icon,
  BubbleChatIcon,
  CancelCircleIcon,
  Clock01Icon,
  CloudUploadIcon,
  ComputerTerminal01Icon,
  Delete02Icon,
  Download01Icon,
  Edit02Icon,
  Files01Icon,
  Folder01Icon,
  Image02Icon,
  Mic01Icon,
  PauseIcon,
  PlayIcon,
  PlusSignIcon,
  Settings02Icon,
  StopCircleIcon,
  Task01Icon,
  WorkflowSquare03Icon
} from 'hugeicons-react'
import {
  createContext,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

type ToolResultSegment = Extract<Segment, { kind: 'tool_result' }>

/**
 * A message sent while a turn was still running, waiting for the agent to
 * read it at its next stop point (main: runtime/agent/interjection.ts). It
 * renders as a user bubble at the TAIL of the feed — after the streaming
 * assistant card, never inside `messages` (appendSegment writes into the
 * last assistant message and must keep finding it) — until its
 * `user_message` segment lands inside that card, which is where it lives
 * from then on. `mine` marks the window that sent it: only that window puts
 * the text back in its draft on a withdraw, or resends it when the turn
 * closed before reading it. Rows for messages sent from the phone (or
 * another window) show and hide, nothing more.
 */
type PendingInterjection = {
  conversationId: string
  messageId: string
  text: string
  attachments: MessageAttachment[]
  voicePrompt?: boolean
  voiceLang?: string
  /** A voice take whose transcript is still coming back — not handed to the runner yet. */
  transcribing?: boolean
  /**
   * Waiting in `heldMessagesRef` for the situation to settle, not in the
   * runner's inbox: the runner bounced it in the sliver where the turn had
   * just closed while this window still read busy, and it goes out again on
   * the busy→idle transition. The row stays up throughout because the
   * composer was cleared the moment the user pressed Enter, so this is the
   * only copy of their words on screen — without it they watch a bubble
   * appear and vanish with nothing to show for it. The X takes it back
   * locally (there is nothing at the runner to withdraw).
   */
  holding?: boolean
  mine: boolean
}

/**
 * A message that could not go out the instant it was submitted: sent inside
 * sendContent's own window (a brand-new conversation has no id yet and the
 * turn may not be registered on the runner), or bounced by the runner in the
 * sliver where the turn had just closed but this window still reads busy.
 * It waits here, in order, and goes out the moment the situation settles —
 * as an interjection if a turn is live, as the next turn if not. A voice
 * take waits un-uploaded; upload and transcription belong to its send.
 */
type HeldMessage =
  | {
      kind: 'text'
      text: string
      attachments: MessageAttachment[]
      voicePrompt?: boolean
      voiceLang?: string
      /**
       * Set once this message has been shown as a pending row (a bounce that
       * is waiting for the busy→idle retry). Carried so the retry reuses the
       * SAME id: the row retires on the delivered `user_message` segment,
       * which can only match if the id survives the round trip.
       */
      messageId?: string
    }
  | { kind: 'voice'; blob: Blob; blobUrl: string | null }

/**
 * A file mid-copy into the conversation's uploads folder. It holds a chip in
 * the composer from the moment it's picked until the bytes have landed, so a
 * large file no longer copies invisibly. `id` is also the progressId main
 * tags its byte ticks with; `percent` is null when the source has no
 * measurable transfer (clipboard bytes) and the chip spins instead.
 */
type StagingFile = { id: string; name: string; percent: number | null }

/**
 * Render-only bubble shown while a run this session doesn't own (a
 * Telegram/WhatsApp turn, an automation) is working on the open
 * conversation and hasn't mirrored an assistant message yet. Empty segments
 * + 'streaming' is exactly what an in-app turn renders before its first
 * token, so the feed reads the same either way. timestamp 0 suppresses the
 * relative-time footer — this row is not a real message and never enters
 * `messages`, so nothing can persist it.
 */
const REMOTE_RUN_PLACEHOLDER: AssistantMessage = {
  id: '__remote_run__',
  role: 'assistant',
  segments: [],
  status: 'streaming',
  timestamp: 0
}

// In-app verbose display preference, mirroring the Telegram / WhatsApp
// channel toggle but for what the renderer DISPLAYS (history is untouched).
// false (default) = clean feed: agent replies, file-bearing tool results,
// and errors only; the model/provider chip, tool-activity and compaction
// cards are hidden. true = the full activity feed (chip included). Provided
// by Chat, read in AssistantBubble.
const InAppVerboseContext = createContext(false)

// Whether the model's thinking renders as a ReasoningCard. ON by default and
// display-only: switching it off hides the card, and the reasoning still
// streams, still persists, still exports either way. Same workspace key the
// phone obeys (`inapp.reasoning`), so the two surfaces can never disagree.
const InAppReasoningContext = createContext(false)

export type ChatProps = {
  /** Stable identity of this session in the ChatSessionsProvider. */
  sessionKey: string
  /**
   * True only for the active session while the chat screen is showing.
   * Hidden instances keep streaming and persisting but must not run
   * portals, media, focus-stealing, or keyboard-owning behavior.
   */
  visible: boolean
  descriptor: SessionDescriptor
}

export function Chat({ sessionKey, visible, descriptor }: ChatProps): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const { isDark } = useTheme()
  const toast = useToast()
  const isRtl = RTL_LOCALES.has(locale)
  const { goTo, status, refreshStatus } = useFlow()
  // Settled before this screen mounts; the model card hides Ollama on it.
  const ollama = useOllama()
  const {
    reportSession,
    markSending,
    consumeProcedure,
    activeProject,
    setActiveProject,
    runStatuses
  } = useSessions()
  // Project mode: THIS session runs inside the globally active project. The
  // binding is per-session (descriptor), so a backgrounded plain chat never
  // borrows another session's project chrome. (The project button and manage
  // dialog live in the app-level FloatingChrome now, alongside New Chat.)
  const sessionProject =
    activeProject !== null && descriptor.projectId === activeProject.id ? activeProject : null
  // Per-session conversation state. Each mounted Chat instance owns ONE
  // conversation for its whole life: a fresh session starts null and gets an
  // id on first send; an opened conversation starts seeded. Switching
  // conversations switches INSTANCES (see ChatSessionsProvider) — the id
  // never changes from one conversation to another within an instance.
  const [messages, setMessages] = useState<ChatMessage[]>(descriptor.initialMessages ?? [])
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    descriptor.initialConversationId
  )

  const currentModel = status?.config?.llm.local.model ?? null
  const localOnly = status?.config?.llm.localOnly ?? false
  const cloudProviders = useMemo(
    () => status?.config?.llm.providers ?? [],
    [status?.config?.llm.providers]
  )
  const brain = status?.config?.llm.brain ?? null
  const hasCloudProvider = cloudProviders.some((p) => p.apiKey && p.apiKey.length > 0)
  // The single Brain is the active cloud model — but only when its provider
  // still has a saved key. Null otherwise (no cloud model selected).
  const activeCloudProvider = useMemo(() => {
    if (!brain) return null
    const provider = cloudProviders.find((p) => p.id === brain.providerId)
    return provider && provider.apiKey && provider.apiKey.length > 0 ? brain.providerId : null
  }, [brain, cloudProviders])
  // A configured local model only counts while Ollama actually has it. The
  // snapshot is main's background watch — never a probe of our own — and the
  // `reachable` guard keeps a daemon that is merely down (or a snapshot that
  // has not seeded yet) from reading as "your model is gone". Without this, a
  // model removed with `ollama rm` leaves currentModel set, which hid the
  // notice below and kept the composer live until a send failed with a raw
  // provider error.
  const localModelMissing =
    !!currentModel && ollama.reachable && !ollama.installed.some((tag) => tag.name === currentModel)
  const hasAnyModel = (!!currentModel && !localModelMissing) || hasCloudProvider
  const [savingMode, setSavingMode] = useState(false)
  const activeCloudModel = useMemo(
    () => (activeCloudProvider && brain ? brain.model : null),
    [activeCloudProvider, brain]
  )

  // Chat mode: 'single' (solo turns) vs 'workflow' (model-led agents).
  // Switched from the composer's mode button; global, like the Brain.
  const chatMode = status?.config?.llm.mode === 'workflow' ? 'workflow' : 'single'
  const persistedThinkingModes = status?.config?.llm.thinkingModes

  // Ordered reasoning modes this model honours (canonical scale). Drives the
  // brain button. Source of truth is reasoningModesFor — corrected to live
  // provider behaviour during verification.
  const reasoningModes = useMemo<ReasoningMode[]>(() => {
    if (localOnly) return []
    const provider = activeCloudProvider
    const model = activeCloudModel
    if (!provider || !model) return []
    const openrouterReasoning =
      provider === 'openrouter'
        ? (cloudProviders.find((p) => p.id === 'openrouter')?.reasoningModels?.includes(model) ??
          false)
        : false
    return reasoningModesFor(provider, model, { openrouterReasoning })
  }, [localOnly, activeCloudProvider, activeCloudModel, cloudProviders])

  // Active mode, clamped/migrated to a value valid for this model's modes.
  // Inside a project the PROJECT's thinking mode is the active value — it is
  // what this conversation's turns actually run at (the agent applies it to
  // every turn carrying a projectId), so the chip shows and edits the
  // project's stamp rather than the per-model config it would otherwise own.
  const thinkingMode = useMemo<ReasoningMode>(
    () =>
      normalizeReasoningMode(
        sessionProject?.thinking ??
          (activeCloudModel ? persistedThinkingModes?.[activeCloudModel] : undefined),
        reasoningModes
      ),
    [sessionProject, activeCloudModel, persistedThinkingModes, reasoningModes]
  )

  // Persist via API — the source of truth is persistedThinkingModes, which
  // updates reactively through status once the write completes.
  const setThinkingMode = useCallback(
    async (mode: string) => {
      // Inside a project the chip edits the PROJECT's thinking mode — the
      // value every turn of its conversations runs at — so the write and the
      // thing that actually runs can never disagree. Outside one the
      // per-model config is written exactly as before.
      if (sessionProject) {
        if (mode === sessionProject.thinking) return
        try {
          const updated = await window.api.projects.update({
            id: sessionProject.id,
            thinking: mode as ThinkingMode
          })
          setActiveProject(updated)
        } catch {
          // The write failed — the chip stays on the project's committed value.
        }
        return
      }
      if (!activeCloudModel) return
      // Skip redundant writes. The effect below drives this setter
      // autonomously on every status/model transition (including starting a
      // new chat), so persisting an unchanged value just adds config.json
      // write churn — and that write contention is what surfaced the
      // config-wipe race in the first place. A never-seen model has no
      // persisted value (undefined), so the default still gets written once.
      const current = persistedThinkingModes?.[activeCloudModel]
      if (mode === current) return
      await window.api.runtime.setThinkingMode(activeCloudModel, mode as ThinkingMode)
      await refreshStatus()
    },
    [sessionProject, setActiveProject, activeCloudModel, persistedThinkingModes, refreshStatus]
  )

  // Migrate/clamp the persisted mode to a value valid for this model. Runs on
  // load and on every model switch so a stale or legacy token (e.g. 'basic')
  // is rewritten to a canonical one. No write when the model has no modes —
  // and none inside a project, where the chip drives the project's stamp and
  // the per-model config is not what this conversation runs at.
  useEffect(() => {
    if (sessionProject || !activeCloudModel || reasoningModes.length === 0) return
    const persisted = persistedThinkingModes?.[activeCloudModel]
    const normalized = normalizeReasoningMode(persisted, reasoningModes)
    if (persisted !== normalized) void setThinkingMode(normalized)
  }, [sessionProject, reasoningModes, activeCloudModel, persistedThinkingModes, setThinkingMode])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    const off = window.api.provider.onUpdated(() => {
      void refreshStatus()
    })
    return off
  }, [refreshStatus])

  // In-app verbose display preference. Read once on mount and kept live via
  // the broadcast the settings panel triggers on save, so toggling it
  // re-renders an open feed immediately. Off (default) = clean feed.
  // Seed from the already-loaded workspace config (status is resolved before
  // Chat renders) so the very FIRST paint knows whether tool cards belong in
  // the clean feed. Without this seed it defaulted to false, the async
  // getConfig() below flipped it to true a beat later, and tool cards popped in
  // on a second render — growing the conversation and flashing on open.
  const [inAppVerbose, setInAppVerbose] = useState(status?.config?.inapp?.verbose ?? false)
  // Same seed-then-subscribe as verbose above, and for the same reason: a
  // late flip would pop thinking cards into a feed that had already laid out.
  const [inAppReasoning, setInAppReasoning] = useState(status?.config?.inapp?.reasoning ?? true)
  useEffect(() => {
    let cancelled = false
    void window.api.inapp.getConfig().then((cfg) => {
      if (!cancelled) {
        setInAppVerbose(cfg.verbose ?? false)
        setInAppReasoning(cfg.reasoning ?? true)
      }
    })
    const off = window.api.inapp.onConfigChange((cfg) => {
      setInAppVerbose(cfg.verbose ?? false)
      setInAppReasoning(cfg.reasoning ?? true)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  const onModeChange = useCallback(
    async (next: boolean) => {
      if (savingMode || next === localOnly) return
      setSavingMode(true)
      try {
        await window.api.runtime.setLocalOnly(next)
        await refreshStatus()
      } finally {
        setSavingMode(false)
      }
    },
    [savingMode, localOnly, refreshStatus]
  )
  // While the agent is paused for a confirm/destructive approval, the
  // streaming bubble swaps "Thinking…" for "Awaiting permission…".
  const awaitingApproval = messages.some((m) => {
    if (!isAssistant(m) || !m.approvals) return false
    for (const approval of Object.values(m.approvals)) {
      if (approval.decision === undefined) return true
    }
    return false
  })
  // While the agent is paused on an ask_user question, the streaming bubble
  // shows "Awaiting your answer…" instead of the thinking shimmer.
  const awaitingAsk = messages.some((m) => {
    if (!isAssistant(m) || !m.asks) return false
    for (const ask of Object.values(m.asks)) {
      if (!ask.answered) return true
    }
    return false
  })

  const [draft, setDraft] = useState('')
  const [draftExpanded, setDraftExpanded] = useState(false)
  const [streaming, setStreaming] = useState(false)
  /**
   * A turn running for THIS conversation that this session does NOT own:
   * started from Telegram / WhatsApp, from an automation, or before this
   * window existed. `streaming` only ever tracks turns this session itself
   * sent, so without this a channel conversation opened mid-run rendered as
   * an idle, ready-to-send chat — composer live, model switchable, no stop —
   * while the agent was still working on it.
   *
   * The message mirror streams that run's text into the feed but says
   * nothing about liveness; the run state comes from the cross-channel
   * lifecycle broadcast (ChatSessionsProvider.runStatuses), seeded on window
   * open by chat:activeRuns so a mid-run open is covered too.
   */
  const remoteRunning =
    activeConversationId !== null && runStatuses[activeConversationId]?.phase === 'processing'
  /**
   * "A turn is in flight for this conversation" — the gate EVERY piece of
   * chat chrome reads (composer, stop/queue, pickers, export, folders, mic).
   * `streaming` stays the narrower fact "this session owns the running turn"
   * and keeps driving the local turn mechanics (event demux, finalize,
   * persistence) — those must not fire for someone else's turn.
   */
  const busy = streaming || remoteRunning

  /**
   * The feed, plus a pending bubble while a channel run is live and hasn't
   * mirrored its assistant message yet — otherwise the transcript would end
   * on the user's message and look finished. Once the mirror lands (or the
   * run ends) the real bubble takes over and this disappears.
   */
  const feedMessages = useMemo(() => {
    if (!remoteRunning) return messages
    const last = messages[messages.length - 1]
    if (last && isAssistant(last) && last.status !== 'error') return messages
    return [...messages, REMOTE_RUN_PLACEHOLDER]
  }, [messages, remoteRunning])
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // On turn end (done, error, cancel, failed send), return focus to the
  // composer so the user can keep typing without reaching for the mouse.
  // Keyed on `busy`, so a channel run finishing hands the composer back the
  // same way an in-app one does.
  // Running as an effect on the flag (instead of the old rAF-after-onDone,
  // which raced the re-render and silently lost) guarantees it fires after
  // the end-of-turn commit. Don't steal focus if the user is deliberately
  // typing in another field, and it's a no-op when Chat is hidden
  // (display:none can't hold focus) or while the voice recorder has replaced
  // the textarea (ref is null).
  const prevStreamingRef = useRef(false)
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current
    prevStreamingRef.current = busy
    if (!wasStreaming || busy) return
    // A hidden session finishing in the background must not yank focus from
    // whatever the user is doing in the visible one.
    if (!visible) return
    const el = textareaRef.current
    if (!el || el.disabled) return
    const active = document.activeElement as HTMLElement | null
    const typingElsewhere =
      !!active &&
      active !== el &&
      (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)
    if (typingElsewhere) return
    el.focus()
  }, [busy, visible])

  // The composer textarea and the expanded CodeMirror editor both use the app-wide
  // <InputContextMenu> (Select all / Copy / Paste / Clear + spelling corrections);
  // no per-surface menu here. See InputContextMenu.tsx for the main-driven flow.
  // Plan mode per conversation: a read-only turn that may only write the
  // conversation's plan file (Agent.planMode). Remembered per conversation
  // for the session, not persisted — like OpenCode's plan agent, it is a
  // stance for the next turns, not a property of the transcript.
  const [planModeTick, bumpPlanMode] = useReducer((n: number) => n + 1, 0)
  const planMode = useMemo(
    () => planModeByConversation.get(activeConversationId ?? NEW_CHAT_PLAN_KEY) ?? false,
    // planModeTick re-derives after a toggle; the map itself is module state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeConversationId, planModeTick]
  )
  // Every local change to the map bumps this; a seed read that started
  // before a change resolves stale and is dropped (see the effect below).
  const planModeGeneration = useRef(0)
  const setPlanMode = useCallback(
    (next: boolean) => {
      planModeByConversation.set(activeConversationId ?? NEW_CHAT_PLAN_KEY, next)
      planModeGeneration.current += 1
      bumpPlanMode()
      // Main holds the shared stance (runtime/plan-mode): the paired phone's
      // switch reads it and its own flips come back through onPlanMode below.
      // A chat with no id yet stays local until its first send creates one.
      if (activeConversationId) {
        void window.api.chat.setPlanMode({ conversationId: activeConversationId, planMode: next })
      }
    },
    [activeConversationId]
  )
  // Mirror main's stance: seed when a conversation opens (the phone may have
  // flipped it while this window showed another chat), and follow every
  // change any surface makes from then on.
  useEffect(() => {
    if (!activeConversationId) return
    let alive = true
    const generation = planModeGeneration.current
    void window.api.chat.getPlanMode(activeConversationId).then((on) => {
      // A flip (here or pushed from the phone) that landed while this read
      // was in flight is newer than the answer — keep it.
      if (!alive || generation !== planModeGeneration.current) return
      if ((planModeByConversation.get(activeConversationId) ?? false) === on) return
      planModeByConversation.set(activeConversationId, on)
      bumpPlanMode()
    })
    return () => {
      alive = false
    }
  }, [activeConversationId])
  useEffect(
    () =>
      window.api.chat.onPlanMode(({ conversationId, planMode: on }) => {
        if ((planModeByConversation.get(conversationId) ?? false) === on) return
        planModeByConversation.set(conversationId, on)
        planModeGeneration.current += 1
        bumpPlanMode()
      }),
    []
  )
  const [storedFolders, setStoredFolders] = useState<string[]>([])
  const workingFolders = useMemo(
    () => (activeConversationId ? storedFolders : []),
    [activeConversationId, storedFolders]
  )
  // Every task list in its latest state, keyed by list id (broca
  // latestTodoLists): a later turn's todo_write that continues an earlier
  // list resolves THAT card in place. Memoized on a signature of the todo
  // segments only, so streaming text never re-renders every row through
  // this prop (ChatItem is memoized on prop identity).
  const todoSignature = useMemo(
    () =>
      messages
        .flatMap((m) => (m.role === 'assistant' ? m.segments : []))
        .filter((s) => s.kind === 'todo')
        .map((s) => `${todoListId(s)}:${s.segmentId}`)
        .join('|'),
    [messages]
  )
  const todoLists = useMemo(
    () => latestTodoLists(messages.map((m) => (m.role === 'assistant' ? m.segments : undefined))),
    // todoSignature is the memo key on purpose: it changes exactly when a todo segment does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [todoSignature]
  )
  // The folders this conversation changed files in — chips over the
  // transcript's top edge. Derived from the persisted segments so the strip
  // is the same live, after the turn and on a reopened conversation. Each
  // changed directory is charged to ONE project folder (the repository root
  // above it, else the container it sits in), resolved by main because that
  // needs the filesystem — asked once per distinct set of directories, not per
  // streamed token, and a reply for a set that has since changed is dropped.
  const changedFiles = useMemo(
    () => collectChangedFiles(messages, workingFolders),
    [messages, workingFolders]
  )
  // Main is asked about every changed file's directory AND every attached
  // working folder — an attached folder's chip names the project it opens
  // (the repo it sits in, or itself), which is how an attached repo and the
  // edits made inside it land on one chip. Distinct, so the key moves only
  // when the set does.
  const folderDirsKey = useMemo(
    () =>
      Array.from(
        new Set([...changedDirectories(changedFiles), ...workingFolders.filter(Boolean)])
      ).join('\n'),
    [changedFiles, workingFolders]
  )
  const [projectByDir, setProjectByDir] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!folderDirsKey) return
    let alive = true
    void window.api.upload
      .projectFolders(folderDirsKey.split('\n'), workingFolders)
      .then((map) => {
        if (alive) setProjectByDir((prev) => ({ ...prev, ...map }))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [folderDirsKey, workingFolders])
  // The strip: attached folders first, then the projects with changes, one
  // chip per path (folderChips). An attached folder that saw no changes is a
  // chip only while it stays attached; one that did keeps its chip from the
  // segments after removal. Nothing before the first message — until then the
  // composer's own folder row is the only place the folders show.
  const firstMessageSent = messages.length > 0
  const folderStrip = useMemo(() => {
    if (!firstMessageSent) return []
    const projectFor = (dir: string): string | undefined => projectByDir[dir]
    return folderChips(workingFolders, groupTouchedFolders(changedFiles, projectFor), projectFor)
  }, [firstMessageSent, workingFolders, changedFiles, projectByDir])
  /**
   * Reference files this conversation's turns are told about — seeded by a
   * procedure's Play from that procedure's attachments and persisted on the
   * conversation, so every follow-up turn here still knows what it can read.
   * Model-led: the paths go out, the bytes never do.
   */
  const [storedContextFiles, setStoredContextFiles] = useState<string[]>([])
  const contextFiles = useMemo(
    () => (activeConversationId ? storedContextFiles : []),
    [activeConversationId, storedContextFiles]
  )
  /**
   * Files the user has staged but not yet sent. Each entry holds the
   * already-saved metadata returned from upload:saveFile so the file is
   * on disk the moment it's picked — sending later just attaches the
   * stable filePath. If the user discards a staged file we leave the
   * bytes on disk; cheap, and a future "uploads orphan sweep" can clean
   * them up if it ever becomes a problem.
   */
  const [pendingAttachments, setPendingAttachments] = useState<MessageAttachment[]>([])
  /**
   * Files currently being copied into the conversation's uploads folder.
   * Each gets a chip in the composer the instant it's picked/dropped —
   * copying a large file is not instant, and before this the composer sat
   * blank until the finished attachment popped into existence. Send is
   * blocked while any is live: the bytes aren't on disk yet.
   */
  const [stagingFiles, setStagingFiles] = useState<StagingFile[]>([])
  const staging = stagingFiles.length > 0
  /**
   * Mid-turn messages not yet read by the agent — this window's own and
   * anyone else's on the same conversation (see PendingInterjection). Kept
   * OUT of `messages` on purpose and drawn after the feed.
   */
  const [pendingInterjections, setPendingInterjections] = useState<PendingInterjection[]>([])
  // Event handlers (chat:interjection, the mirror) need the current list
  // without re-subscribing per change.
  const pendingInterjectionsRef = useRef<PendingInterjection[]>([])
  useEffect(() => {
    pendingInterjectionsRef.current = pendingInterjections
  }, [pendingInterjections])
  /** Messages waiting for a send in flight to settle — see HeldMessage. */
  const heldMessagesRef = useRef<HeldMessage[]>([])
  const flushingHeldRef = useRef(false)
  /** Withdraw outcomes already applied (the X's reply and the broadcast both report the same one). */
  const settledInterjectionsRef = useRef<Set<string>>(new Set())
  /** Voice interjections the user took back while their transcript was still in flight. */
  const abortedVoiceInterjectionsRef = useRef<Set<string>>(new Set())
  // Active model's name, fed to the context meter. Refreshed when the
  // active model changes. Uploads are never gated on model capability —
  // a non-vision model receives a text note about the file instead of
  // the image bytes and can still operate on it with tools.
  const [activeModelName, setActiveModelName] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [contextTokens, setContextTokens] = useState<number | null>(null)
  const [contextBudget, setContextBudget] = useState<number | null>(null)
  // Token count where auto-compaction actually triggers for the active model
  // — drawn as a tick on the meter so the visible % and the compaction
  // trigger share one denominator story.
  const [compactionAt, setCompactionAt] = useState<number | null>(null)
  const [inputTokens, setInputTokens] = useState<number | null>(null)
  const [outputTokens, setOutputTokens] = useState<number | null>(null)
  const [cacheReadTokens, setCacheReadTokens] = useState<number | null>(null)
  const [cacheWriteTokens, setCacheWriteTokens] = useState<number | null>(null)
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null)
  // Set when the turn finishes; freezes the elapsed-time display until
  // the next message is sent. Stays visible between turns so the user
  // can see how long the last reply took.
  const [turnEndedAt, setTurnEndedAt] = useState<number | null>(null)
  // Persisted per-conversation tokenomics: lifetime totals plus the last
  // turn's frozen roll-up. Restored on conversation load so the meter card
  // shows the last state (including the previous turn's elapsed time) after
  // a reload or restart.
  const [convStats, setConvStats] = useState<ConversationStats | null>(null)
  // True when the latest brain call reported no usage (Ollama blip, stream
  // died before the terminal meta). The meter keeps its last reading instead
  // of wiping to 0%; the card labels the reading as unavailable.
  const [usageUnavailable, setUsageUnavailable] = useState(false)
  // Most recent brain API call — the card's footnote row plus the window
  // composition (fresh / cache-read / cache-written) for the segmented bar.
  const [lastCall, setLastCall] = useState<{
    provider: string
    model: string
    durationMs: number
    fresh: number
    cacheRead: number
    cacheWrite: number
  } | null>(null)
  // Workflow-agent + summarization spend observed during the live turn,
  // itemized separately so it never pollutes the brain's meter or counters.
  const [sideSpend, setSideSpend] = useState<SideSpend | null>(null)
  // The live/last turn's workflow run, mirrored from the same snapshot
  // segments that drive the feed's WorkflowCard — the meter card itemizes
  // its agents and their consumption.
  const [workflowSpend, setWorkflowSpend] = useState<WorkflowSnapshot | null>(null)
  // Model the current meter reading was measured under. Guards restores and
  // model switches from dividing an old model's numerator by a different
  // model's window.
  const [meterModel, setMeterModel] = useState<string | null>(null)

  const [timelineEntries, setTimelineEntries] = useState<TimelineEntry[]>([])
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [filesOpen, setFilesOpen] = useState(false)
  // Files that appear in the conversation — user uploads plus files delivered
  // by tools — unified into MessageAttachment[] so the files dialog can render
  // them through AttachmentList (the same per-type dispatch, existence checks
  // and viewers the feed already uses). collectConversationFiles reuses the
  // feed's extractors.
  //
  // Files almost only ever change when a user attachment or a whole tool_call /
  // tool_result segment lands, so we key the heavy scan on those cheap counts
  // instead of `messages` identity. (tool_call is counted too: files are now
  // pulled from call args, so a producer/send call must re-run the scan even
  // before its result arrives.) Otherwise it would re-run on every streaming
  // token (messages gets a fresh identity per delta) and re-scan every
  // historical segment, regressing the per-delta budget.
  //
  // The one exception is inline media — a `wolffish-media://` ref the model
  // writes into its own prose — which arrives mid-text-stream and moves
  // neither count. So the tail message's ref count joins the key. Only the
  // LAST message is ever mid-stream, which keeps this bounded to the text
  // being typed rather than the whole transcript, and it is enough: the count
  // is a change DETECTOR, while the rescan it fires still walks every message.
  // Any earlier message was itself the tail when its own refs landed.
  const filesKey = useMemo(() => {
    let userAttachments = 0
    let toolSegments = 0
    for (const m of messages) {
      if (m.role === 'user') userAttachments += m.attachments?.length ?? 0
      else
        for (const s of m.segments) {
          if (s.kind === 'tool_result' || s.kind === 'tool_call') toolSegments += 1
          else if (s.kind === 'user_message') userAttachments += s.attachments?.length ?? 0
        }
    }
    const tail = messages[messages.length - 1]
    const tailMedia = tail && tail.role !== 'user' ? countMediaRefs(tail.segments) : 0
    return `${userAttachments}:${toolSegments}:${tailMedia}`
  }, [messages])
  const conversationFiles = useMemo(
    () => collectConversationFiles(messages),
    // Recompute only when the attachment/tool-segment counts change; `messages`
    // is intentionally read fresh inside but excluded from the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filesKey]
  )
  // What the sheet and its chip actually show: named-and-still-there. Every
  // display site below reads this, never conversationFiles, so the count on
  // the chip and the tiles behind it can't disagree.
  const presentFiles = useFilesOnDisk(conversationFiles)

  // A conversation's event log. In-app turns build `timelineEntries` live and
  // persist it; channel-owned conversations (WhatsApp / Telegram) never do —
  // their turns run in the main process, which doesn't write a timeline. So
  // when there is no stored/live timeline, derive one from the persisted
  // messages (a turn divider per prompt + a row per tool call / result) so the
  // "View Logs" button reflects real activity for channel conversations too.
  // Keyed on a cheap prompt/segment count — like filesKey — so it doesn't
  // re-run per streaming token; the derived result is discarded anyway while a
  // live in-app timeline is accumulating.
  const timelineKey = useMemo(() => {
    let prompts = 0
    let segs = 0
    for (const m of messages) {
      if (m.role === 'user') prompts += 1
      else segs += m.segments.length
    }
    return `${prompts}:${segs}`
  }, [messages])
  const derivedTimeline = useMemo(
    () => deriveTimelineFromMessages(messages),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timelineKey]
  )
  // Prefer the live/stored timeline (in-app); fall back to the derived one
  // (channel-owned or legacy conversations that never stored a timeline).
  const displayTimeline = timelineEntries.length > 0 ? timelineEntries : derivedTimeline
  // Real events only — turn-boundary dividers structure the log but shouldn't
  // count toward the "N events" badges.
  const timelineEventCount = useMemo(
    () => displayTimeline.reduce((n, e) => n + (e.kind === 'turn.started' ? 0 : 1), 0),
    [displayTimeline]
  )

  // Clears the context meter + per-turn token/timing readouts back to empty.
  // Every path that opens a fresh chat runs this via the
  // activeConversationId→null effect below — the floating New Chat disc,
  // History's New Chat, Procedures' Play, and deleting the active
  // conversation. Keeping it in one place stops those entry points from
  // drifting apart (History's button used to leave the meter stale).
  const resetTurnStats = useCallback(() => {
    setContextTokens(null)
    setContextBudget(null)
    setCompactionAt(null)
    setInputTokens(null)
    setOutputTokens(null)
    setCacheReadTokens(null)
    setCacheWriteTokens(null)
    setTurnStartedAt(null)
    setTurnEndedAt(null)
    setConvStats(null)
    setUsageUnavailable(false)
    setLastCall(null)
    setSideSpend(null)
    setWorkflowSpend(null)
    setMeterModel(null)
    // State-only on purpose: the ref twins (meterModelRef, turnStartedAtRef,
    // pendingTurnUsageRef, lastCallRef, turnStatsRef) reset inline at the
    // conversation-switch effect and the send paths — mutating them here
    // would freeze them component-wide (react-hooks/immutability) because
    // this callback rides in hook dep arrays.
  }, [
    setContextTokens,
    setContextBudget,
    setInputTokens,
    setOutputTokens,
    setCacheReadTokens,
    setTurnStartedAt,
    setTurnEndedAt
  ])

  const scrollerRef = useRef<HTMLDivElement>(null)
  const pendingTurnIdRef = useRef<string | null>(null)
  // Ref twin of activeConversationId for the once-created event closures.
  const conversationIdRef = useRef<string | null>(descriptor.initialConversationId)
  // True from the moment a send is committed (conversation id reserved) until
  // its chat:send invoke resolves with the turnId. Segments for OUR
  // conversation arriving inside that window are adopted (see matchesTurn) —
  // event delivery and the invoke reply race over the same IPC pipe.
  const sendInFlightRef = useRef(false)
  // The last turn whose terminal event (done/error) this session processed.
  // A turn can complete BEFORE its chat:send invoke resolves (the
  // sensitive-data gate emits everything synchronously inside the handler) —
  // re-arming pendingTurnIdRef with an already-finished turn would wedge the
  // composer forever, so the post-invoke assignment checks this first.
  const lastTerminalTurnIdRef = useRef<string | null>(null)
  // Synchronous re-entry guard for the send path. `streaming` doesn't flip
  // until AFTER ensureConversationId() awaits a disk create for a fresh
  // session — a second Enter in that window would fire a second turn for one
  // conversation. This ref closes synchronously; it also drives the provider's
  // mid-send eviction protection.
  const sendingRef = useRef(false)
  const conversationRef = useRef<ConversationFile | null>(null)
  const modelContextWindowRef = useRef<number | null>(null)
  // Model name + compaction point from the last model:capabilities probe —
  // read inside event/load closures where the state would be stale.
  const activeModelNameRef = useRef<string | null>(null)
  const activeCompactionAtRef = useRef<number | null>(null)
  // Ref twin of `meterModel` for the same stale-closure reason.
  const meterModelRef = useRef<string | null>(null)
  // Wall-clock send instant, mirrored from turnStartedAt so finalizeTurn can
  // compute elapsed inside the once-created event closure.
  const turnStartedAtRef = useRef<number | null>(null)
  // The brain turn's `turn.usage` roll-up (cost, provider, model, brain-only
  // tool count) parked until chat:done folds it into the conversation stats.
  const pendingTurnUsageRef = useRef<{
    provider: string | null
    model: string | null
    cost: number
    toolCalls: number | null
  } | null>(null)
  const lastCallRef = useRef<{ provider: string; model: string } | null>(null)
  // Mirror of the per-turn token/context aggregates, kept in a ref so the
  // `task.completed` timeline entry can read final totals synchronously.
  // The onTurnEvent closure is created once, so reading the token state
  // directly there would see stale (turn-start) values — the ref does not.
  const turnStatsRef = useRef<TurnStats>(emptyTurnStats())

  // ── Voice recording ───────────────────────────────────────────
  type RecorderPhase = 'idle' | 'recording' | 'review'
  const [recPhase, setRecPhase] = useState<RecorderPhase>('idle')
  const [recElapsed, setRecElapsed] = useState(0)
  const [recBlobUrl, setRecBlobUrl] = useState<string | null>(null)
  const [recPlaying, setRecPlaying] = useState(false)
  const [micAvailable, setMicAvailable] = useState(true)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recChunksRef = useRef<Blob[]>([])
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const recAudioRef = useRef<HTMLAudioElement | null>(null)
  const recBlobRef = useRef<Blob | null>(null)

  // Keep the provider's picture of this session current — the sidebar chips,
  // session reuse/eviction, and open-conversation routing all read it.
  // `dirty` marks unsent composer state (draft text, staged attachments,
  // messages pending mid-turn, a voice take, or a message still transcribing)
  // so eviction never silently destroys work the user hasn't sent.
  const sessionDirty =
    draft.trim().length > 0 ||
    pendingAttachments.length > 0 ||
    staging ||
    pendingInterjections.length > 0 ||
    recPhase !== 'idle' ||
    messages.some((m) => m.role === 'user' && 'transcribing' in m && m.transcribing === true)
  // Reports `busy`, not `streaming`: a session mirroring a live channel run
  // is just as un-evictable as one running its own turn — dropping it
  // mid-run would tear down the feed the mirror is writing into.
  useEffect(() => {
    reportSession(sessionKey, {
      conversationId: activeConversationId,
      streaming: busy,
      dirty: sessionDirty
    })
  }, [sessionKey, activeConversationId, busy, sessionDirty, reportSession])

  useEffect(() => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((devices) => {
        setMicAvailable(devices.some((d) => d.kind === 'audioinput'))
      })
      .catch(() => setMicAvailable(false))
  }, [])

  const discardRecording = useCallback(() => {
    if (recTimerRef.current) {
      clearInterval(recTimerRef.current)
      recTimerRef.current = null
    }
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop()
    }
    if (recAudioRef.current) {
      recAudioRef.current.pause()
      recAudioRef.current = null
    }
    if (recBlobUrl) URL.revokeObjectURL(recBlobUrl)
    recBlobRef.current = null
    setRecBlobUrl(null)
    setRecPlaying(false)
    setRecPhase('idle')
    setRecElapsed(0)
  }, [recBlobUrl])

  const startRecording = useCallback(async () => {
    try {
      const access = await window.api.mic.checkAccess()
      if (access === 'not-determined') {
        const granted = await window.api.mic.requestAccess()
        if (!granted) {
          toast.show({ message: t('chat.voice.permissionDenied'), tone: 'error' })
          return
        }
      } else if (access === 'denied' || access === 'restricted') {
        // A browser on plain http: has no microphone API at all — the fix is
        // HTTPS, not an OS permission, so say that one.
        const needsHttps = isWeb && !window.isSecureContext
        toast.show({
          message: t(needsHttps ? 'chat.voice.needsHttps' : 'chat.voice.permissionDenied'),
          tone: 'error'
        })
        return
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'
      const recorder = new MediaRecorder(stream, { mimeType })
      recChunksRef.current = []
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recChunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(recChunksRef.current, { type: mimeType })
        recBlobRef.current = blob
        const url = URL.createObjectURL(blob)
        setRecBlobUrl(url)
        setRecPhase('review')
      }
      recorder.onerror = () => {
        stream.getTracks().forEach((t) => t.stop())
        toast.show({ message: t('chat.voice.error'), tone: 'error' })
        discardRecording()
      }
      mediaRecorderRef.current = recorder
      recorder.start(250)
      setRecElapsed(0)
      setRecPhase('recording')
      recTimerRef.current = setInterval(() => setRecElapsed((s) => s + 1), 1000)
    } catch (err) {
      const msg =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? t('chat.voice.permissionDenied')
          : t('chat.voice.error')
      toast.show({ message: msg, tone: 'error' })
    }
  }, [toast, t, discardRecording])

  const stopRecording = useCallback(() => {
    if (recTimerRef.current) {
      clearInterval(recTimerRef.current)
      recTimerRef.current = null
    }
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop()
    }
  }, [])

  const togglePlayback = useCallback(() => {
    if (!recBlobUrl) return
    if (recPlaying && recAudioRef.current) {
      recAudioRef.current.pause()
      setRecPlaying(false)
      return
    }
    const audio = new Audio(recBlobUrl)
    recAudioRef.current = audio
    audio.onended = () => setRecPlaying(false)
    audio.play()
    setRecPlaying(true)
  }, [recBlobUrl, recPlaying])

  useEffect(() => {
    return () => {
      if (recTimerRef.current) clearInterval(recTimerRef.current)
      if (recBlobUrl) URL.revokeObjectURL(recBlobUrl)
    }
  }, [recBlobUrl])

  // Chat stays MOUNTED (just hidden) when you navigate to another screen or
  // switch to another session — see App.tsx. Media doesn't stop under
  // display:none, so on becoming hidden we stop it ourselves: end live mic
  // capture (otherwise the mic stays hot with no UI to stop it), pause
  // voice-review playback, and pause any feed audio/video that was playing.
  // Stopping while recording lands in 'review', so nothing is lost — the
  // take is there when you come back.
  useEffect(() => {
    if (visible) return
    if (recPhase === 'recording') stopRecording()
    if (recAudioRef.current && !recAudioRef.current.paused) {
      recAudioRef.current.pause()
      setRecPlaying(false)
    }
    scrollerRef.current?.querySelectorAll('audio, video').forEach((el) => {
      const media = el as HTMLMediaElement
      if (!media.paused) media.pause()
    })
  }, [visible, recPhase, stopRecording])
  // ── End voice recording ───────────────────────────────────────

  // Re-sync model-dependent UI whenever the active model changes — the local
  // model, the local-only toggle, OR the cloud Brain (activeCloudModel). Two
  // things ride on this: the model name shown on the context meter, and the
  // context-meter budget.
  // Pushing caps.contextWindow into contextBudget here makes the meter reflect
  // the new model's window immediately on switch — before any turn fires.
  // Without activeCloudModel in the deps the budget stayed pinned to the
  // previous model's window when switching between cloud models.
  useEffect(() => {
    let cancelled = false
    void window.api.model.capabilities().then((caps) => {
      if (cancelled) return
      setActiveModelName(caps.model)
      // caps.provider is null exactly when no model is resolved (the backend's
      // 8 000 placeholder case); a non-null provider means contextWindow is the
      // real resolved window. Null the ref otherwise so the budget consumers
      // below treat any positive window as authoritative.
      const cw = caps.provider ? caps.contextWindow : null
      modelContextWindowRef.current = cw
      activeModelNameRef.current = caps.model
      activeCompactionAtRef.current = caps.compactionAt > 0 ? caps.compactionAt : null
      // Only adopt the new model's window when the current meter reading was
      // measured under the same model (or there is no reading yet). Otherwise
      // keep the saved self-consistent pair — dividing an old model's
      // numerator by a different model's window renders a fraudulent %.
      const sameModel = meterModelRef.current === null || meterModelRef.current === caps.model
      if (cw && cw > 0 && sameModel) {
        setContextBudget(cw)
        setCompactionAt(activeCompactionAtRef.current)
      }
    })
    return () => {
      cancelled = true
    }
  }, [currentModel, localOnly, activeCloudModel])

  // Fold main-side rolling-summary updates into the in-memory conversation:
  // the summarizer persisted {summary, mark} after our last save — merge them
  // so the NEXT whole-file save preserves them and the next send replays
  // summary + tail instead of the full transcript.
  useEffect(() => {
    return window.api.conversation.onSummaryUpdated((update) => {
      const conv = conversationRef.current
      if (!conv || conv.id !== update.conversationId) return
      conv.summary = update.summary
      conv.summarizedThroughMessage = update.summarizedThroughMessage
      conv.summarizedThroughMessageId = update.summarizedThroughMessageId
    })
  }, [])

  const persistConversation = useCallback(
    async (msgs: ChatMessage[]) => {
      const convMessages = msgs.filter(isPersistedMessage).map((m) => {
        // Preserve each message's own send time — stamping Date.now() here
        // rewrote every timestamp on every save, destroying real history.
        // The feed id persists too (`id` FIRST — the launch probe keys on a
        // leading id): it's the identity the main-side merge reconciles
        // concurrent writers by, and it round-trips through load
        // (mapConversationMessages) so one logical message keeps one id for
        // the life of the conversation.
        if (isUser(m)) {
          return {
            id: m.id,
            role: 'user' as const,
            content: m.content,
            timestamp: m.timestamp ?? Date.now(),
            ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
            // Written by the channels, replayed by us: a save from the app
            // must hand these back untouched or continuing a voice-note
            // conversation in-app would strip the flag off disk.
            ...(m.voicePrompt ? { voicePrompt: true } : {}),
            ...(m.voiceLang ? { voiceLang: m.voiceLang } : {}),
            ...(m.systemAside ? { systemAside: true } : {})
          }
        }
        const am = m as AssistantMessage
        return {
          id: am.id,
          role: 'assistant' as const,
          content: collectText(am.segments),
          // Coalesce streaming text deltas at persistence time: one text
          // segment per run instead of thousands of one-word deltas (a
          // single conversation was 28k delta segments / 4MB on disk).
          segments: coalesceTextSegments(am.segments),
          approvals: am.approvals,
          toolTimings: am.toolTimings,
          stopReason: am.stopReason,
          ...(am.status === 'error' && am.error ? { error: am.error } : {}),
          timestamp: am.timestamp ?? Date.now()
        }
      })

      if (convMessages.length === 0) return

      // Never let a whole-file save DROP persisted messages: the feed is
      // append-only relative to disk in every legitimate flow, so coming up
      // short here means this component's state is stale (a remount
      // re-seeded from an old session descriptor). The main-side merge
      // refuses the shrink too — this skip just avoids the pointless write
      // and the updatedAt churn.
      const diskCount = conversationRef.current?.messages.length ?? 0
      if (convMessages.length < diskCount) {
        console.warn(
          `[chat] skipped stale conversation save (${convMessages.length} < ${diskCount} messages on disk)`
        )
        return
      }

      // Channel-owned conversations (WhatsApp / Telegram / heartbeat /
      // procedure) are saved from here too — they are continued in-app like any
      // other chat, and blocking the write would stream a reply and then lose it
      // on reopen. This is a whole-file save of a copy loaded when the
      // conversation was opened, so it does still assume nothing else appended
      // to the file in the meantime: if a message arrives on the channel while
      // that same conversation is open here, this save overwrites it. Only the
      // two live channels can do that (each automation run gets its own fresh
      // conversation), and it needs the phone and the app going at once.

      if (!conversationRef.current) {
        const conv = await window.api.conversation.create(
          localOnly ? currentModel : activeCloudModel
        )
        if (descriptor.projectId) conv.projectId = descriptor.projectId
        if (descriptor.icon) conv.icon = descriptor.icon
        conversationRef.current = conv
        // The plan stance set while this chat had no id follows it under the
        // id it now has, so the second turn keeps the mode the first ran in.
        const stance = planModeByConversation.get(NEW_CHAT_PLAN_KEY)
        planModeByConversation.delete(NEW_CHAT_PLAN_KEY)
        if (stance !== undefined) {
          planModeByConversation.set(conv.id, stance)
          if (stance) void window.api.chat.setPlanMode({ conversationId: conv.id, planMode: true })
        }
        setActiveConversationId(conv.id)
      }

      conversationRef.current.messages = convMessages
      conversationRef.current.updatedAt = Date.now()
      // A heartbeat/procedure run seals its conversation as a finished record,
      // and the rolling summarizer skips sealed files. Once the user carries on
      // in it, it is a live conversation again — leaving it sealed would replay
      // the full verbatim transcript forever instead of a prefix summary.
      if (conversationRef.current.sealed) conversationRef.current.sealed = false
      // Persist the full tokenomics snapshot: lifetime totals, the last
      // turn's roll-up, and the meter reading stamped with the model it was
      // measured under. Supersedes the legacy `contextMeter` field (still
      // read as a fallback on load).
      const meter =
        contextTokens != null && contextBudget != null
          ? {
              contextTokens,
              contextBudget,
              compactionAt: compactionAt ?? null,
              model: meterModelRef.current === LEGACY_METER_MODEL ? null : meterModelRef.current
            }
          : (conversationRef.current.stats?.meter ?? null)
      if (convStats || meter) {
        conversationRef.current.stats = {
          allTime: convStats?.allTime ?? conversationRef.current.stats?.allTime ?? EMPTY_ALL_TIME,
          lastTurn: convStats?.lastTurn ?? conversationRef.current.stats?.lastTurn ?? null,
          meter
        }
      }
      conversationRef.current.timeline =
        timelineEntries.length > 0
          ? timelineEntries
          : (conversationRef.current.timeline ?? undefined)
      await window.api.conversation.save(conversationRef.current)
    },
    [
      descriptor.projectId,
      descriptor.icon,
      currentModel,
      localOnly,
      activeCloudModel,
      setActiveConversationId,
      contextTokens,
      contextBudget,
      compactionAt,
      convStats,
      timelineEntries
    ]
  )

  useEffect(() => {
    // Within one session the conversation id only ever transitions null→id
    // (first send / seeded open). A turn somehow pending across an id CHANGE
    // belongs to the conversation being left — cancel THAT conversation's
    // turn only; other sessions' streams must keep running.
    const previousId = conversationIdRef.current
    conversationIdRef.current = activeConversationId
    if (activeConversationId) {
      // Always (re)load on id change. The previous `&& !conversationRef.current`
      // guard left a stale ref behind when switching from one conversation
      // to another without first nulling activeConversationId — newly sent
      // messages would then merge into the previous conversation's file.
      if (conversationRef.current?.id === activeConversationId) return
      const targetId = activeConversationId
      void window.api.conversation.load(targetId).then((conv) => {
        // Drop the result if the user has already switched again — the
        // newer effect run is now in flight and owns conversationRef.
        if (!conv || conversationIdRef.current !== targetId) return
        conversationRef.current = conv
        // A turn still in flight for the OUTGOING conversation must not
        // bleed into this one (its llm.response events would overwrite the
        // restored meter and its done would persist the wrong reading here).
        // Kill it — scoped to that conversation — and drop its pending
        // events; the spend still lands in the global usage ledger.
        if (pendingTurnIdRef.current !== null && previousId !== targetId) {
          pendingTurnIdRef.current = null
          setStreaming(false)
          if (previousId) void window.api.chat.cancel({ conversationId: previousId })
        }
        // Pending mid-turn bubbles belong to the conversation they were sent
        // into (the runner still holds them there). A filter, not a wipe:
        // this conversation's own cold-start seed may already have landed.
        setPendingInterjections((prev) => prev.filter((p) => p.conversationId === targetId))
        // A remount re-seeds `messages` from the session descriptor — a
        // snapshot minted when the session was OPENED. Turns persisted since
        // then exist only on disk, and leaving the feed on the stale seed
        // hands the next whole-file save a shorter transcript (the
        // 2026-07-17 data loss: a completed retry turn erased by exactly
        // this). With no turn in flight, a disk copy holding MORE persisted
        // messages than the feed is the truth — adopt it.
        if (pendingTurnIdRef.current === null) {
          setMessages((prev) => {
            const have = prev.filter(isPersistedMessage).length
            if (conv.messages.length <= have) return prev
            return mapConversationMessages(conv)
          })
        }
        // Wipe the previous conversation's live counters FIRST — a direct
        // A→B switch used to leak A's frozen elapsed and token counts into
        // B's composer — then restore B's persisted state on top.
        resetTurnStats()
        turnStartedAtRef.current = null
        pendingTurnUsageRef.current = null
        lastCallRef.current = null
        meterModelRef.current = null
        turnStatsRef.current = emptyTurnStats()
        setConvStats(conv.stats ?? null)
        // The meter's workflow section survives reopen the way lastTurn does:
        // restore the persisted snapshot only when the FINAL assistant message
        // carries one (i.e. the last turn was a workflow run) — an older run's
        // snapshot next to a newer turn's stats would misattribute the spend.
        const lastAssistant = conv.messages.filter((m) => m.role === 'assistant').at(-1)
        const wfSeg = (lastAssistant?.segments ?? []).findLast(
          (s): s is Extract<Segment, { kind: 'workflow' }> => s.kind === 'workflow'
        )
        setWorkflowSpend(wfSeg?.snapshot ?? null)
        const meter =
          conv.stats?.meter ??
          (conv.contextMeter
            ? {
                contextTokens: conv.contextMeter.contextTokens,
                contextBudget: conv.contextMeter.contextBudget,
                compactionAt: null,
                model: null
              }
            : null)
        if (meter) {
          setContextTokens(meter.contextTokens)
          // Legacy snapshots carry no model stamp. Mark the ref with a
          // sentinel (never a real model name) so the capabilities effect
          // treats the reading as "measured under an unknown model" and
          // keeps the saved self-consistent budget instead of swapping the
          // denominator. Display state stays null (no bogus header text).
          meterModelRef.current = meter.model ?? LEGACY_METER_MODEL
          setMeterModel(meter.model ?? null)
          // Adopt the live model's window only when the saved reading was
          // measured under the same model; otherwise keep the saved
          // self-consistent pair (old numerator ÷ new denominator lies).
          const cw = modelContextWindowRef.current
          const sameModel = meter.model != null && meter.model === activeModelNameRef.current
          setContextBudget(sameModel && cw && cw > 0 ? cw : meter.contextBudget)
          setCompactionAt(
            sameModel
              ? (activeCompactionAtRef.current ?? meter.compactionAt ?? null)
              : (meter.compactionAt ?? null)
          )
        } else {
          const cw = modelContextWindowRef.current
          if (cw && cw > 0) {
            setContextBudget(cw)
            setCompactionAt(activeCompactionAtRef.current)
          }
        }
        const raw = conv.workingFolder
        const folders = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
        setStoredFolders(folders)
        setStoredContextFiles(Array.isArray(conv.contextFiles) ? conv.contextFiles : [])
        // Channel-owned and legacy conversations never stored a timeline — the
        // log is derived from their messages for display. Seed the live
        // timeline from that derivation so continuing one in-app EXTENDS the
        // log instead of restarting it: the live timeline wins over the derived
        // one once non-empty, and persistConversation writes it back, so
        // seeding empty would drop every earlier turn from View Logs for good.
        setTimelineEntries(
          conv.timeline ?? deriveTimelineFromMessages(mapConversationMessages(conv))
        )
        setFilesOpen(false)
      })
    } else {
      // Fresh chat (New Chat / Procedures Play / active-conversation delete):
      // wipe the meter + per-turn stats so no stale reading carries over from
      // the conversation we just left — this effect covers every entry point,
      // none of which can reach this component's state directly.
      conversationRef.current = null
      queueMicrotask(() => {
        // Same in-flight guard as the load branch — a stray turn from the
        // conversation we just left must not repopulate the fresh chat.
        if (pendingTurnIdRef.current !== null) {
          pendingTurnIdRef.current = null
          setStreaming(false)
          if (previousId) void window.api.chat.cancel({ conversationId: previousId })
        }
        // A fresh chat has no run to be pending on.
        setPendingInterjections([])
        resetTurnStats()
        turnStartedAtRef.current = null
        pendingTurnUsageRef.current = null
        lastCallRef.current = null
        meterModelRef.current = null
        turnStatsRef.current = emptyTurnStats()
        setTimelineEntries([])
        setFilesOpen(false)
        // A fresh chat starts in plan mode off — the stance is a choice made
        // for one conversation, never carried into the next.
        planModeByConversation.delete(NEW_CHAT_PLAN_KEY)
        bumpPlanMode()
      })
    }
  }, [activeConversationId, resetTurnStats])

  // Pull in messages another surface appended to the conversation we have open
  // — you answer on your phone while this chat sits on screen. Nothing else
  // fetches them: the feed would sit stale until reopened, and our next save
  // (a whole-file write of this stale copy) would drop them entirely.
  //
  // The diff itself is reconcileFeedWithDisk: it appends the arriving bubbles
  // and refreshes in place the one message a live channel mirror left us a
  // half-written copy of (see there). Both work message-by-message, id-keyed,
  // so React re-renders only what actually changed — re-mapping the whole
  // conversation would remint every id and remount every item (images
  // reloading, path cards re-statting, the scroll jumping), which is exactly
  // the flash to avoid.
  useEffect(() => {
    if (!activeConversationId) return
    const targetId = activeConversationId
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const sync = async (): Promise<void> => {
      // Our own turn owns the transcript while it runs, and its end-of-turn
      // save is the writer — syncing under it would race that save. A message
      // that lands mid-turn is still lost to it; closing that needs stable
      // message ids, not this.
      if (pendingTurnIdRef.current !== null) return
      const conv = await window.api.conversation.load(targetId)
      if (cancelled || !conv || conversationIdRef.current !== targetId) return
      setMessages((prev) => reconcileFeedWithDisk(prev, conv, isPersistedMessage))
    }

    // The broadcast carries no id, so it fires for EVERY conversation's writes
    // (including every automation run). Debounced, and the whole cost of a miss
    // is one file read that ends in a no-op setState.
    const off = window.api.conversation.onChanged(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void sync().catch(() => undefined), 250)
    })
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      off()
    }
  }, [activeConversationId])

  // Live mirror of an IN-FLIGHT Telegram/WhatsApp turn. The channel streams
  // throttled snapshots of its in-progress assistant message (main-side
  // conversation:messageMirror); we upsert by id so an open channel
  // conversation fills in AS THE RUN HAPPENS — instead of the whole transcript
  // landing at once only when the end-of-turn save + reindex fire
  // conversation:changed (the sync() effect above). The snapshot's id is
  // stable for the turn and equals the record that save writes, so sync() then
  // sees it as already-known and no duplicate is ever appended.
  useEffect(() => {
    if (!activeConversationId) return
    const targetId = activeConversationId
    return window.api.conversation.onMessageMirror(({ conversationId, message }) => {
      if (conversationId !== targetId || conversationIdRef.current !== targetId) return
      // Our OWN in-app turn owns the feed while it streams (chat:segment) —
      // never let a background channel mirror fight it. Same guard sync() uses.
      if (pendingTurnIdRef.current !== null) return
      const mapped = mapConversationMessage(message)
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === mapped.id)
        // Not seen yet → append. Already present (same stable id) → replace in
        // place; the shared id keeps React reconciling the one growing bubble
        // rather than remounting it, so earlier messages never reload.
        if (idx === -1) return [...prev, mapped]
        const next = prev.slice()
        next[idx] = mapped
        return next
      })
      // A mid-turn message the run has now read arrives here as a
      // `user_message` segment inside the mirrored card — the tail bubble
      // that stood in for it retires (the own-turn path does this on
      // chat:segment).
      if (pendingInterjectionsRef.current.length > 0 && isAssistant(mapped)) {
        const delivered = new Set<string>()
        for (const s of mapped.segments) if (s.kind === 'user_message') delivered.add(s.messageId)
        if (delivered.size > 0) {
          setPendingInterjections((prev) => prev.filter((p) => !delivered.has(p.messageId)))
        }
      }
    })
  }, [activeConversationId])

  /**
   * Mid-turn messages the durable park is HOLDING for this conversation: sent
   * while a run was going, never read because the run was stopped, and never
   * auto-resent (the user aborted the work they were steering). The words come
   * back to the composer the moment the conversation is opened — by ANY window,
   * not only the one that happened to be connected when the Stop landed, which
   * is what makes this survive a quit, a crash or a phone going away.
   *
   * Deliberately NOT gated on a live run, unlike the pending seed below: a held
   * message exists precisely because nothing is running.
   */
  useEffect(() => {
    if (!activeConversationId) return
    const targetId = activeConversationId
    let cancelled = false
    void window.api.chat
      .pendingInterjections(targetId)
      .then(async (items) => {
        const held = items.filter((i) => i.held)
        if (cancelled || held.length === 0 || conversationIdRef.current !== targetId) return
        for (const item of held) {
          // Claim before restoring, never after. setDraft APPENDS, and the
          // release is a round trip — so two overlapping passes (a conversation
          // switched back and forth, a StrictMode double-mount, a reopen while
          // the first release is still in flight) would each read the same held
          // row and put the user's words in the composer twice.
          if (settledInterjectionsRef.current.has(item.messageId)) continue
          settledInterjectionsRef.current.add(item.messageId)
          // Released only once the text is demonstrably back in the composer —
          // the release is the hand-off, so it follows the restore, never
          // precedes it.
          if (item.text.length > 0) {
            setDraft((prev) => (prev.trim().length > 0 ? `${prev}\n${item.text}` : item.text))
          }
          if (!item.voicePrompt && item.attachments.length > 0) {
            setPendingAttachments((prev) => [
              ...prev,
              ...item.attachments.filter((a) => !prev.some((b) => b.filePath === a.filePath))
            ])
          }
          await window.api.chat
            .releaseHeldInterjection({ conversationId: targetId, messageId: item.messageId })
            .catch(() => undefined)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [activeConversationId])

  // The same cold-start gap for mid-turn messages: a window opened (or
  // switched) onto a running conversation missed every chat:interjection
  // event so far. Ask the runner what is still parked. Never `mine` — this
  // window did not send them, so a withdraw must not touch its draft.
  useEffect(() => {
    if (!activeConversationId || !remoteRunning) return
    const targetId = activeConversationId
    let cancelled = false
    void window.api.chat
      .pendingInterjections(targetId)
      .then((items) => {
        if (cancelled || items.length === 0 || conversationIdRef.current !== targetId) return
        setPendingInterjections((prev) => {
          const known = new Set(prev.map((p) => p.messageId))
          const fresh = items.filter((i) => !i.held && !known.has(i.messageId))
          if (fresh.length === 0) return prev
          return [
            ...prev,
            ...fresh.map(
              (i): PendingInterjection => ({
                conversationId: targetId,
                messageId: i.messageId,
                text: i.text,
                attachments: i.attachments,
                ...(i.voicePrompt ? { voicePrompt: true } : {}),
                ...(i.voiceLang ? { voiceLang: i.voiceLang } : {}),
                mine: false
              })
            )
          ]
        })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [activeConversationId, remoteRunning])

  // The mirror above only carries what happens NEXT. A window opened — or
  // reloaded — while a run is already in flight has missed every tick so
  // far, and across a long tool call the next one is minutes away; until it
  // lands, the conversation reads as the prompt plus a bare thinking bubble
  // over a turn that may be twelve minutes of prose and cards deep (the
  // 2026-08-22 Gmail sweep). Seed the feed from main's cached turn-so-far —
  // the renderer's half of the phone's Rpc.turnMirror recovery. Append-only
  // under the same stable id: a live tick or the fold's saved copy that got
  // here first is fresher and wins by already holding the slot.
  useEffect(() => {
    if (!activeConversationId || !remoteRunning) return
    const targetId = activeConversationId
    let cancelled = false
    void window.api.chat
      .turnMirror(targetId)
      .then((message) => {
        // `cancelled` also covers the run ENDING while the call was in
        // flight (remoteRunning flips and re-runs this effect): a snapshot
        // applied after the fold could shadow the saved copy under its id.
        if (cancelled || !message || conversationIdRef.current !== targetId) return
        if (pendingTurnIdRef.current !== null) return
        const mapped = mapConversationMessage(message)
        setMessages((prev) => (prev.some((m) => m.id === mapped.id) ? prev : [...prev, mapped]))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [activeConversationId, remoteRunning])

  // Web UI: a reconnect the server did NOT resume (the page was away past its
  // grace) lost every event of the turn this page was streaming, `chat:done`
  // included — left alone the feed sits mid-answer, "working", forever. Hand
  // the turn back to main's copy: stop owning it WITHOUT saving (the partial
  // feed copy would overwrite the checkpoint main kept writing) and take the
  // message from disk. A run still going is then followed the way any other
  // surface's run is — remoteRunning, the checkpoint syncs, the mirror.
  useEffect(() => {
    const transport = webTransport()
    if (!transport) return
    return transport.onConnection((state) => {
      if (state !== 'open' || transport.hello?.resumed !== false) return
      const turnId = pendingTurnIdRef.current
      const targetId = conversationIdRef.current
      if (turnId === null || !targetId) return
      lastTerminalTurnIdRef.current = turnId
      pendingTurnIdRef.current = null
      setStreaming(false)
      setTurnEndedAt(Date.now())
      void window.api.conversation
        .load(targetId)
        .then((conv) => {
          if (!conv || conversationIdRef.current !== targetId) return
          setMessages((prev) => {
            const fromDisk = new Map(
              conv.messages.filter((m) => m.id).map((m) => [m.id!, m] as const)
            )
            return prev.map((m) => {
              if (!isAssistant(m) || m.status !== 'streaming') return m
              const saved = fromDisk.get(m.id)
              return saved ? mapConversationMessage(saved) : { ...m, status: 'complete' }
            })
          })
        })
        .catch(() => undefined)
    })
  }, [setMessages])

  // Async-task snapshots (video generation) keep flowing AFTER the owning
  // turn ends — poll transitions, artifact download. Fold each push into the
  // matching `task` segment in both the reactive messages and the in-memory
  // conversation copy, so the card updates live and the next whole-file save
  // carries the new state. During streaming the same snapshot also arrives
  // as a broca segment; both paths upsert by taskId, so double delivery is
  // idempotent.
  useEffect(() => {
    if (!activeConversationId) return
    const targetId = activeConversationId
    return window.api.task.onChanged((snapshot) => {
      if (snapshot.conversationId !== targetId || conversationIdRef.current !== targetId) return
      setMessages((prev) => foldTaskSnapshot(prev, snapshot))
      const conv = conversationRef.current
      if (conv && conv.id === targetId) {
        for (const message of conv.messages) {
          for (const seg of message.segments ?? []) {
            if (seg.kind === 'task' && seg.snapshot.taskId === snapshot.taskId) {
              seg.snapshot = snapshot
            }
          }
        }
      }
    })
  }, [activeConversationId])

  // Countdown transitions after the arming turn ended (counting, fired,
  // aborted, failed) arrive as pushes, not segments — same fold as tasks.
  useEffect(() => {
    if (!activeConversationId) return
    const targetId = activeConversationId
    return window.api.countdown.onChanged((snapshot) => {
      if (snapshot.conversationId !== targetId || conversationIdRef.current !== targetId) return
      setMessages((prev) => foldCountdownSnapshot(prev, snapshot))
      const conv = conversationRef.current
      if (conv && conv.id === targetId) {
        for (const message of conv.messages) {
          for (const seg of message.segments ?? []) {
            if (seg.kind === 'countdown' && seg.snapshot.countdownId === snapshot.countdownId) {
              seg.snapshot = snapshot
            }
          }
        }
      }
    })
  }, [activeConversationId])

  // Process-card changes after the opening turn ended (a stop from Library,
  // a crash, a restart) arrive as pushes — the countdown fold, keyed by cardId.
  useEffect(() => {
    if (!activeConversationId) return
    const targetId = activeConversationId
    return window.api.processes.onCardChanged((snapshot) => {
      if (snapshot.conversationId !== targetId || conversationIdRef.current !== targetId) return
      setMessages((prev) => foldProcessSnapshot(prev, snapshot))
      const conv = conversationRef.current
      if (conv && conv.id === targetId) {
        for (const message of conv.messages) {
          for (const seg of message.segments ?? []) {
            if (seg.kind === 'process' && seg.snapshot.cardId === snapshot.cardId) {
              seg.snapshot = snapshot
            }
          }
        }
      }
    })
  }, [activeConversationId])

  // In-app browser page changes after the opening turn ended (a navigation,
  // a title, a load state) arrive as pushes — the countdown fold, keyed by
  // tabId, so a reopened conversation shows the card's last state.
  useEffect(() => {
    if (!activeConversationId) return
    const targetId = activeConversationId
    return window.api.browser.onChanged((snapshot) => {
      if (snapshot.conversationId !== targetId || conversationIdRef.current !== targetId) return
      setMessages((prev) => foldBrowserSnapshot(prev, snapshot))
      const conv = conversationRef.current
      if (conv && conv.id === targetId) {
        for (const message of conv.messages) {
          for (const seg of message.segments ?? []) {
            if (seg.kind === 'browser' && browserKey(seg.snapshot) === browserKey(snapshot)) {
              seg.snapshot = snapshot
            }
          }
        }
      }
    })
  }, [activeConversationId])

  const shouldPersistRef = useRef(false)

  useLayoutEffect(() => {
    if (shouldPersistRef.current) {
      shouldPersistRef.current = false
      void persistConversation(messages).catch(() => undefined)
    }
  }, [messages, persistConversation])

  const persistedErrorIdsRef = useRef(new Set<string>())
  useLayoutEffect(() => {
    const unpersisted = messages.find(
      (m): m is AssistantMessage =>
        isAssistant(m) && m.status === 'error' && !persistedErrorIdsRef.current.has(m.id)
    )
    if (unpersisted && conversationRef.current) {
      persistedErrorIdsRef.current.add(unpersisted.id)
      void persistConversation(messages).catch(() => undefined)
    }
  }, [messages, persistConversation])

  useEffect(() => {
    // Demux for concurrent conversations: every chat:* event carries turnId +
    // conversationId. An event is OURS when its turnId matches the pending
    // turn — or, in the window where a send's events race its invoke reply
    // (both ride the same IPC pipe), when it names OUR conversation while our
    // send is in flight; the turnId is adopted then. Everything else belongs
    // to another session's conversation and is ignored here.
    const matchesTurn = (turnId: string, conversationId?: string | null): boolean => {
      if (pendingTurnIdRef.current === turnId) return true
      if (
        pendingTurnIdRef.current === null &&
        sendInFlightRef.current &&
        conversationId != null &&
        conversationId === conversationIdRef.current
      ) {
        pendingTurnIdRef.current = turnId
        return true
      }
      return false
    }
    const offSegment = window.api.chat.onSegment((segment) => {
      if (!matchesTurn(segment.turnId, segment.conversationId)) return
      setMessages((prev) => appendSegment(prev, segment))
      // The delivered copy of a mid-turn message now lives inside the
      // assistant card, at the point the agent read it — the tail bubble
      // that stood in for it retires.
      if (segment.kind === 'user_message') {
        const deliveredId = segment.messageId
        setPendingInterjections((prev) =>
          prev.some((p) => p.messageId === deliveredId)
            ? prev.filter((p) => p.messageId !== deliveredId)
            : prev
        )
      }
      // Every snapshot (including throttled token ticks) refreshes the meter's
      // workflow section — the timeline entry below is gated, this must not be.
      if (segment.kind === 'workflow') setWorkflowSpend(segment.snapshot)
      const segKind = segment.kind
      if (
        segKind === 'tool_call' ||
        segKind === 'tool_result' ||
        segKind === 'compaction' ||
        segKind === 'workflow'
      ) {
        const entry = buildSegmentTimelineEntry(segment)
        if (entry) {
          if (segKind === 'workflow') {
            // Snapshots also emit on throttled token ticks — only a CHANGED
            // one-liner (status/phase/agent/tool transition) earns an entry.
            setTimelineEntries((prev) => {
              const last = prev.findLast((e) => e.kind === 'segment.workflow')
              if (last?.summary === entry.summary) return prev
              return [...prev, entry]
            })
          } else if (segKind === 'compaction') {
            setTimelineEntries((prev) => {
              const idx = prev.findLastIndex((e) => e.kind === 'compaction.started')
              if (idx !== -1) {
                const updated = [...prev]
                updated[idx] = { ...updated[idx], ...entry }
                return updated
              }
              return [...prev, entry]
            })
          } else {
            setTimelineEntries((prev) => [...prev, entry])
          }
        }
      }
    })
    // Fold the finished turn into the persisted conversation stats: the last
    // turn's frozen roll-up plus the lifetime totals (which include worker
    // and summarization side-spend so the all-time numbers reflect what the
    // conversation actually consumed).
    const finalizeTurn = (endedAt: number): void => {
      const startedAt = turnStartedAtRef.current
      if (startedAt === null) return
      turnStartedAtRef.current = null
      const elapsedMs = Math.max(0, endedAt - startedAt)
      const stats = turnStatsRef.current
      const pending = pendingTurnUsageRef.current
      pendingTurnUsageRef.current = null
      const lastTurn: ConversationTurnStats = {
        endedAt,
        elapsedMs,
        apiMs: stats.apiMs,
        apiCalls: stats.apiCalls,
        // Prefer the agent's brain-only count — the live counter also saw
        // relayed agent tool events during workflow turns.
        toolCalls: pending?.toolCalls ?? stats.toolCalls,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        cacheReadTokens: stats.cacheReadTokens,
        cacheCreationTokens: stats.cacheCreationTokens,
        cost: (pending?.cost ?? 0) + stats.worker.cost + stats.summary.cost,
        provider: pending?.provider ?? lastCallRef.current?.provider ?? null,
        model: pending?.model ?? lastCallRef.current?.model ?? null
      }
      setConvStats((prev) => {
        const base = prev?.allTime ?? conversationRef.current?.stats?.allTime ?? EMPTY_ALL_TIME
        return {
          allTime: {
            processingMs: base.processingMs + elapsedMs,
            apiMs: base.apiMs + stats.apiMs,
            turns: base.turns + 1,
            apiCalls: base.apiCalls + stats.apiCalls + stats.worker.calls + stats.summary.calls,
            toolCalls: base.toolCalls + lastTurn.toolCalls,
            inputTokens:
              base.inputTokens +
              stats.inputTokens +
              stats.worker.inputTokens +
              stats.summary.inputTokens,
            outputTokens:
              base.outputTokens +
              stats.outputTokens +
              stats.worker.outputTokens +
              stats.summary.outputTokens,
            cacheReadTokens:
              base.cacheReadTokens +
              stats.cacheReadTokens +
              stats.worker.cacheReadTokens +
              stats.summary.cacheReadTokens,
            cacheCreationTokens:
              base.cacheCreationTokens +
              stats.cacheCreationTokens +
              stats.worker.cacheCreationTokens +
              stats.summary.cacheCreationTokens,
            cost: base.cost + lastTurn.cost
          },
          lastTurn,
          meter: prev?.meter ?? null
        }
      })
    }
    const offDone = window.api.chat.onDone(({ turnId, conversationId }) => {
      if (!matchesTurn(turnId, conversationId)) return
      lastTerminalTurnIdRef.current = turnId
      pendingTurnIdRef.current = null
      setStreaming(false)
      const endedAt = Date.now()
      setTurnEndedAt(endedAt)
      finalizeTurn(endedAt)
      shouldPersistRef.current = true
      setMessages((prev) => markComplete(prev, turnId))
    })
    const offError = window.api.chat.onError(({ turnId, conversationId, error }) => {
      if (!matchesTurn(turnId, conversationId)) return
      lastTerminalTurnIdRef.current = turnId
      pendingTurnIdRef.current = null
      setStreaming(false)
      const endedAt = Date.now()
      setTurnEndedAt(endedAt)
      finalizeTurn(endedAt)
      shouldPersistRef.current = true
      setMessages((prev) => markError(prev, turnId, error))
    })
    const offTurnEvent = window.api.chat.onTurnEvent(
      ({ turnId, conversationId, type, payload }) => {
        if (!matchesTurn(turnId, conversationId)) return
        if (type === 'context.built') {
          // The window the backend just built this turn with is the freshest
          // reading there is — the turn resolves the local model's real context
          // length (via /api/show) before this fires. Adopt it AND refresh the
          // ref, so a capabilities fetch that happened to run while Ollama was
          // still starting (and returned the 16k fallback) can't keep pinning the
          // meter to that stale value. Previously the stale ref won here, which
          // re-asserted 16k on every turn even after the backend had recovered.
          if (typeof payload.tokenBudget === 'number' && payload.tokenBudget > 0) {
            modelContextWindowRef.current = payload.tokenBudget
            setContextBudget(payload.tokenBudget)
            // A turn is running under the active model now. If the reading on
            // screen was measured under a DIFFERENT model, blank it until this
            // turn's first usage-bearing llm.response measures fresh — the old
            // numerator against the new budget is a fabricated percentage.
            if (
              meterModelRef.current !== null &&
              meterModelRef.current !== activeModelNameRef.current
            ) {
              setContextTokens(null)
            }
            meterModelRef.current = activeModelNameRef.current
            setMeterModel(activeModelNameRef.current)
          }
          if (typeof payload.compactionAt === 'number' && payload.compactionAt > 0) {
            setCompactionAt(payload.compactionAt)
          }
        } else if (type === 'llm.response') {
          const role = typeof payload.role === 'string' ? payload.role : 'brain'
          const uncached = typeof payload.inputTokens === 'number' ? payload.inputTokens : 0
          const cacheRead =
            typeof payload.cacheReadTokens === 'number' ? payload.cacheReadTokens : 0
          const cacheCreated =
            typeof payload.cacheCreationTokens === 'number' ? payload.cacheCreationTokens : 0
          const out = typeof payload.outputTokens === 'number' ? payload.outputTokens : 0
          const durationMs = typeof payload.durationMs === 'number' ? payload.durationMs : 0
          const stats = turnStatsRef.current
          if (role === 'worker') {
            // Workflow agents stream through the same relay stamped with
            // this turn's id. Itemize their spend separately — folding it into
            // the brain's counters overwrote the meter with the worker's
            // (smaller) context and inflated the turn totals.
            stats.worker.calls += 1
            stats.worker.inputTokens += uncached
            stats.worker.outputTokens += out
            stats.worker.cacheReadTokens += cacheRead
            stats.worker.cacheCreationTokens += cacheCreated
            setSideSpend(sideSpendOf(stats))
          } else if (role === 'summary' || role === 'title') {
            // Compaction / summarizer / titling side-calls: real spend, not
            // context. Titling runs in a detached scope so its llm.response is
            // normally never relayed here — this branch just guarantees a
            // stray one can never feed the context meter (it never counts as
            // 'brain').
            stats.summary.calls += 1
            stats.summary.inputTokens += uncached
            stats.summary.outputTokens += out
            stats.summary.cacheReadTokens += cacheRead
            stats.summary.cacheCreationTokens += cacheCreated
            stats.summary.cost += typeof payload.cost === 'number' ? payload.cost : 0
            setSideSpend(sideSpendOf(stats))
          } else {
            const hasUsage = uncached > 0 || cacheRead > 0 || cacheCreated > 0 || out > 0
            if (hasUsage) {
              // Prompt side of the latest call — what is resident in the
              // model's window right now (fresh + cached prefix + cache
              // writes; output lands in the next call's prompt).
              setContextTokens(uncached + cacheRead + cacheCreated)
              setUsageUnavailable(false)
              if (typeof payload.model === 'string') {
                meterModelRef.current = payload.model
                setMeterModel(payload.model)
              }
              stats.contextTokens = uncached + cacheRead + cacheCreated
            } else {
              // Provider reported no usage (Ollama blip, stream died before
              // the terminal meta). Keep the last known reading instead of
              // wiping the meter to 0% — but say so.
              setUsageUnavailable(true)
            }
            setInputTokens((prev) => (prev ?? 0) + uncached)
            setOutputTokens((prev) => (prev ?? 0) + out)
            setCacheReadTokens((prev) => (prev ?? 0) + cacheRead)
            setCacheWriteTokens((prev) => (prev ?? 0) + cacheCreated)
            if (typeof payload.provider === 'string' && typeof payload.model === 'string') {
              lastCallRef.current = { provider: payload.provider, model: payload.model }
              setLastCall({
                provider: payload.provider,
                model: payload.model,
                durationMs,
                fresh: uncached,
                cacheRead,
                cacheWrite: cacheCreated
              })
            }
            // Mirror into the ref (final context size is absolute; the rest
            // accumulate) so task.completed can report end-of-turn totals.
            stats.inputTokens += uncached
            stats.outputTokens += out
            stats.cacheReadTokens += cacheRead
            stats.cacheCreationTokens += cacheCreated
            stats.apiCalls += 1
            stats.apiMs += durationMs
          }
        } else if (type === 'turn.usage') {
          const stats = turnStatsRef.current
          const cost = typeof payload.cost === 'number' ? payload.cost : 0
          if (payload.role === 'worker') {
            stats.worker.turns += 1
            stats.worker.cost += cost
            setSideSpend(sideSpendOf(stats))
          } else {
            pendingTurnUsageRef.current = {
              provider: typeof payload.provider === 'string' ? payload.provider : null,
              model: typeof payload.model === 'string' ? payload.model : null,
              cost,
              // Brain-only tool count from the agent loop — the live
              // tool.called counter below also sees relayed WORKER tool
              // events, so this is the authoritative per-turn number.
              toolCalls: typeof payload.toolCalls === 'number' ? payload.toolCalls : null
            }
          }
        } else if (type === 'tool.called') {
          turnStatsRef.current.toolCalls += 1
        }
        if (
          type !== 'tool.called' &&
          type !== 'tool.completed' &&
          type !== 'tool.failed' &&
          type !== 'compaction.applied'
        ) {
          const { summary: tlSummary, detail: tlDetail } = timelineEventSummary(
            type,
            payload,
            turnStatsRef.current
          )
          setTimelineEntries((prev) => [
            ...prev,
            {
              id: `te_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              timestamp: Date.now(),
              kind: type,
              ...(tlSummary ? { summary: tlSummary } : {}),
              ...(tlDetail ? { detail: tlDetail } : {})
            }
          ])
        }
      }
    )
    const offApprovalRequest = window.api.chat.onApprovalRequest((event) => {
      // turnId is always stamped now (the sink closes over it) — strict
      // matching only, so a concurrent conversation's approval can never
      // render (or be answered) on this session's card.
      if (!matchesTurn(event.turnId, event.conversationId)) return
      setMessages((prev) =>
        attachApproval(prev, {
          approvalId: event.id,
          toolCallId: event.toolCallId,
          tool: event.tool,
          args: event.args,
          reason: event.reason,
          level: event.level,
          description: event.description
        })
      )
    })
    const offAskRequest = window.api.chat.onAskRequest((event) => {
      if (!matchesTurn(event.turnId, event.conversationId)) return
      setMessages((prev) =>
        attachAsk(prev, {
          askId: event.id,
          toolCallId: event.toolCallId,
          questions: event.questions
        })
      )
    })
    return () => {
      offSegment()
      offDone()
      offError()
      offTurnEvent()
      offApprovalRequest()
      offAskRequest()
    }
  }, [setMessages])

  // The feed pins to the end like a logs tail purely via CSS: the scroller is
  // `flex flex-col-reverse`, so its scroll origin sits at the bottom (newest).
  // Opening a conversation lands at the true end with no flash, and the view
  // stays pinned as async children (file viewers, images, code highlighting)
  // settle — no measure-and-jump that could park mid-feed, and a user who
  // scrolls up to read history is never yanked down. The only case CSS can't
  // cover is sending while scrolled up: force the newest into view so the user
  // always sees their own message and the reply.
  const scrollToBottom = useCallback(() => {
    const el = scrollerRef.current
    if (el) el.scrollTop = 0
  }, [])

  const respondApproval = useCallback(
    async (approvalId: string, decision: ApprovalDecision) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (!isAssistant(m) || !m.approvals) return m
          let changed = false
          const next: Record<string, ApprovalCardState> = {}
          for (const [key, approval] of Object.entries(m.approvals)) {
            if (approval.approvalId === approvalId) {
              next[key] = { ...approval, decision }
              changed = true
            } else {
              next[key] = approval
            }
          }
          return changed ? { ...m, approvals: next } : m
        })
      )
      await window.api.chat.respondApproval({ id: approvalId, decision })
    },
    [setMessages]
  )

  const respondAsk = useCallback(
    async (askId: string, response: AskUserResponse) => {
      // Optimistically mark the card answered so the chosen options highlight
      // the instant the last one is clicked — the tool_result lands a beat
      // later.
      setMessages((prev) =>
        prev.map((m) => {
          if (!isAssistant(m) || !m.asks) return m
          let changed = false
          const next: Record<string, AskCardState> = {}
          for (const [key, ask] of Object.entries(m.asks)) {
            if (ask.askId === askId) {
              next[key] = {
                ...ask,
                answered: true,
                answers: response.kind === 'answered' ? response.answers : undefined
              }
              changed = true
            } else {
              next[key] = ask
            }
          }
          return changed ? { ...m, asks: next } : m
        })
      )
      await window.api.chat.respondAsk({ id: askId, response })
    },
    [setMessages]
  )

  /**
   * Resolve (or reserve) a conversation id without sending. Used by the
   * upload picker too — files need a destination folder before the user
   * has written any text.
   */
  const ensureConversationId = useCallback(async (): Promise<string> => {
    if (activeConversationId) {
      if (!conversationRef.current || conversationRef.current.id !== activeConversationId) {
        const loaded = await window.api.conversation.load(activeConversationId)
        if (loaded) {
          conversationRef.current = loaded
        } else {
          const now = Date.now()
          conversationRef.current = {
            id: activeConversationId,
            title: 'Untitled',
            model: currentModel,
            messages: [],
            createdAt: now,
            updatedAt: now,
            // Disk was unreadable, so the merge has nothing to preserve the
            // binding from — carry it from the session descriptor instead.
            ...(descriptor.projectId ? { projectId: descriptor.projectId } : {}),
            ...(descriptor.icon ? { icon: descriptor.icon } : {})
          }
        }
      }
      return activeConversationId
    }
    const conv = await window.api.conversation.create(localOnly ? currentModel : activeCloudModel)
    if (descriptor.projectId) conv.projectId = descriptor.projectId
    if (descriptor.icon) conv.icon = descriptor.icon
    conversationRef.current = conv
    // Sync the ref immediately — the event demux (matchesTurn) may need it
    // before the state commit re-runs the id effect.
    conversationIdRef.current = conv.id
    setActiveConversationId(conv.id)
    return conv.id
  }, [
    activeConversationId,
    currentModel,
    localOnly,
    activeCloudModel,
    setActiveConversationId,
    descriptor.projectId,
    descriptor.icon
  ])

  // Refs over the send paths for the cross-calls below (a held message is
  // flushed from inside the send that held it; a voice interjection falls
  // back to a turn): the callbacks are declared in dependency order, and a
  // ref is how a later one is reached from an earlier one without a TDZ.
  const flushHeldRef = useRef<() => Promise<void>>(async () => undefined)

  /**
   * Hand one message to the conversation's running turn. The optimistic
   * bubble goes up first (as `mine`), then the runner is asked; `false`
   * means no turn was live to read it — the bubble comes down and the
   * caller starts a turn instead. `messageId` is minted here unless the
   * caller already owns a row (a voice take that showed its transcribing
   * bubble before the transcript came back).
   */
  const interjectNow = useCallback(
    async (
      conversationId: string,
      item: {
        text: string
        attachments: MessageAttachment[]
        voicePrompt?: boolean
        voiceLang?: string
      },
      messageId: string = cryptoId()
    ): Promise<boolean> => {
      setPendingInterjections((prev) =>
        prev.some((p) => p.messageId === messageId)
          ? prev.map((p) =>
              p.messageId === messageId ? { ...p, ...item, transcribing: false, holding: false } : p
            )
          : [...prev, { conversationId, messageId, ...item, mine: true }]
      )
      let status: 'pending' | 'no_live_turn'
      try {
        // Mid-turn on the web the picked files go up now too.
        const attachments = isWeb
          ? await finalizeAttachments(conversationId, item.attachments)
          : item.attachments
        status = (
          await window.api.chat.interject({
            conversationId,
            messageId,
            text: item.text,
            attachments,
            ...(item.voicePrompt ? { voicePrompt: true } : {}),
            ...(item.voiceLang ? { voiceLang: item.voiceLang } : {})
          })
        ).status
      } catch {
        status = 'no_live_turn'
      }
      if (status === 'no_live_turn') {
        setPendingInterjections((prev) => prev.filter((p) => p.messageId !== messageId))
        return false
      }
      return true
    },
    []
  )

  const sendContent = useCallback(
    async (
      content: string,
      attachments: MessageAttachment[] = [],
      opts?: {
        modeOverride?: 'single' | 'workflow'
        /**
         * Procedure Play only. The procedure's own reasoning stamp — this
         * send uses it over the state-based thinkingMode for THIS turn only
         * (a lingering override would leak into later sends).
         */
        thinkingOverride?: 'off' | 'on' | 'high' | 'max'
        /**
         * An already-transcribed voice note (a voice interjection the turn
         * closed on before reading it, or that found no live turn): the
         * content is its transcript, `attachments` its audio. The feed and
         * the history get exactly the shape sendVoiceBlob gives a take sent
         * straight away — the transcript IS the prompt, the audio never
         * reaches the model, the detected language rides the voice_note tag.
         */
        voice?: { lang?: string }
        /**
         * Procedure Play only. The conversation's folders and reference files
         * are seeded in the same tick this send fires, and React state does
         * not update inside a closure that has already been created — so the
         * run's own lists ride the call rather than being read back.
         */
        workingFolders?: string[]
        contextFiles?: string[]
        /**
         * The app is speaking, not the person: the Continue after a stalled
         * provider call. Persisted as a user turn flagged systemAside, so the
         * model reads it as a system note and the feed shows a muted line.
         */
        systemAside?: boolean
      }
    ) => {
      const trimmed = content.trim()
      // Allow attachment-only messages: a file with no caption is still a
      // valid send. We require at least one of the two so a stray Enter
      // on an empty input doesn't fire.
      if (!trimmed && attachments.length === 0) return
      // `busy` doesn't flip until after the ensureConversationId() await
      // below (a disk create for a fresh session). sendingRef closes that
      // window synchronously so a second Enter can't fire a second turn, and
      // markSending tells the provider not to evict this session mid-create.
      // Gating on `busy` also refuses to fire a turn INTO a live channel run:
      // it would be built from a history the running turn is still extending.
      if (busy || sendingRef.current) return
      sendingRef.current = true
      markSending(sessionKey, true)

      try {
        const conversationId = await ensureConversationId()

        // The Web UI holds picked files in the page until now: they go up
        // here, each becoming a real attachment, before anything is composed
        // or shown. A failure puts the draft and the chips back.
        if (isWeb) {
          try {
            attachments = await finalizeAttachments(conversationId, attachments)
          } catch (err) {
            toast.show({ message: err instanceof Error ? err.message : String(err), tone: 'error' })
            setDraft((prev) => (prev.trim().length > 0 ? prev : content))
            setPendingAttachments((prev) => (prev.length > 0 ? prev : attachments))
            return
          }
        }

        const userMessage: ChatMessage = {
          id: cryptoId(),
          role: 'user',
          content: trimmed,
          timestamp: Date.now(),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(opts?.voice ? { voicePrompt: true } : {}),
          ...(opts?.voice?.lang ? { voiceLang: opts.voice.lang } : {}),
          ...(opts?.systemAside ? { systemAside: true } : {})
        }
        const assistantPlaceholder: AssistantMessage = {
          id: cryptoId(),
          role: 'assistant',
          segments: [],
          status: 'streaming',
          timestamp: Date.now()
        }
        // Prepend an attachment summary so the LLM knows what files came
        // along with this turn even though it can't read them. Tools like
        // stt_transcribe_upload can then pick up the file from this hint.
        const workspaceRoot = status?.rootPath ?? null
        // Working-folder listings no longer ride the user message: composing a
        // fresh readdir into the persisted-vs-wire content rewrote the previous
        // user message every send and invalidated the provider prompt-cache
        // prefix. The folder paths travel in the chat:send payload instead and
        // the agent injects a fresh listing into the outbound volatile tail.
        const composed = composeHistoryContent(trimmed, attachments, workspaceRoot)
        // Mirrors sendVoiceBlob's entry exactly for a transcribed voice note.
        const historyContent = opts?.voice
          ? `<voice_note${opts.voice.lang ? ` lang="${opts.voice.lang}"` : ''}>\n${composed}`
          : composed
        const currentEntry: {
          role: 'user'
          content: string
          attachments?: MessageAttachment[]
          systemAside?: boolean
        } = { role: 'user', content: historyContent }
        if (attachments.length > 0) currentEntry.attachments = attachments
        if (opts?.systemAside) currentEntry.systemAside = true
        const history = textHistory(messages, workspaceRoot, {
          summary: conversationRef.current?.summary,
          summarizedThroughMessage: conversationRef.current?.summarizedThroughMessage,
          summarizedThroughMessageId: conversationRef.current?.summarizedThroughMessageId,
          conversationId: conversationRef.current?.id ?? null
        }).concat(currentEntry)

        setMessages((prev) => [...prev, userMessage, assistantPlaceholder])
        scrollToBottom()
        setStreaming(true)
        const sendNow = Date.now()
        setTurnStartedAt(sendNow)
        turnStartedAtRef.current = sendNow
        setTurnEndedAt(null)
        setInputTokens(0)
        setOutputTokens(0)
        setCacheReadTokens(0)
        setCacheWriteTokens(0)
        setSideSpend(null)
        setWorkflowSpend(null)
        setUsageUnavailable(false)
        pendingTurnUsageRef.current = null
        turnStatsRef.current = emptyTurnStats()
        // Keep the timeline additive across the whole conversation — seed a
        // boundary for this turn instead of wiping the prior turns' events.
        setTimelineEntries((prev) => [...prev, makeTurnBoundary(trimmed)])
        setTimelineOpen(false)
        setFilesOpen(false)

        // Adoption window: events for this conversation may arrive before the
        // invoke reply delivers the turnId (same IPC pipe, no ordering
        // guarantee) — matchesTurn adopts them while this flag is up.
        sendInFlightRef.current = true
        const response = await window.api.chat.send({
          history,
          conversationId,
          // The titler shell pre-persists this same user message — under the
          // SAME id, so our end-of-turn save reconciles with the shell
          // instead of duplicating it.
          userMessageId: userMessage.id,
          // Main checkpoints the turn-so-far to disk under this id while it
          // runs (channels/turn-checkpoint.ts). Handing it OUR placeholder's
          // id is what makes that checkpoint and the save below one message:
          // the id-keyed merge replaces it rather than appending a second
          // copy of the same answer.
          assistantMessageId: assistantPlaceholder.id,
          workingFolders: opts?.workingFolders ?? workingFolders,
          contextFiles: opts?.contextFiles ?? contextFiles,
          thinkingMode: (opts?.thinkingOverride ??
            thinkingMode) as import('@preload/index').ThinkingMode,
          planMode,
          projectId: descriptor.projectId ?? undefined,
          // Per-call only (procedure Play): a lingering state-based override
          // would leak the procedure's mode into later sends.
          ...(opts?.modeOverride ? { modeOverride: opts.modeOverride } : {})
        })
        sendInFlightRef.current = false
        // matchesTurn may have adopted the turnId from an early event already —
        // and the turn may have fully COMPLETED before this invoke resolved
        // (the sensitive-data gate finishes synchronously). Re-arming with a
        // finished turn would wedge the composer forever.
        if (
          pendingTurnIdRef.current === null &&
          response.turnId !== lastTerminalTurnIdRef.current
        ) {
          pendingTurnIdRef.current = response.turnId
        }
        if (!response.ok && response.error) {
          pendingTurnIdRef.current = null
          setStreaming(false)
          setTurnEndedAt(Date.now())
          // The send never became a turn — don't let a later finalize fold it.
          turnStartedAtRef.current = null
          shouldPersistRef.current = true
          setMessages((prev) => markError(prev, response.turnId, response.error ?? 'unknown error'))
        }
      } finally {
        // Release the synchronous re-entry guard once the turn is in flight
        // (or the send failed): `streaming` now guards further sends, and a
        // streaming session is already eviction-proof.
        sendingRef.current = false
        markSending(sessionKey, false)
        // Anything submitted while this send was in flight goes out now —
        // into the turn it just started, or as the next turn if that one
        // already ended.
        void flushHeldRef.current()
      }
    },
    [
      descriptor.projectId,
      busy,
      messages,
      setMessages,
      ensureConversationId,
      status?.rootPath,
      workingFolders,
      contextFiles,
      thinkingMode,
      planMode,
      scrollToBottom,
      markSending,
      sessionKey,
      toast
    ]
  )

  const send = useCallback(async () => {
    const trimmed = draft.trim()
    if (!trimmed && pendingAttachments.length === 0) return
    // A file is still being copied into the workspace — sending now would
    // drop it from the message. The buttons are disabled too; this catches
    // the Enter key, which doesn't go through them.
    if (staging) return
    const atts = pendingAttachments
    // Mid-turn submits SEND: the message goes to the running turn, which
    // reads it at its next step (a pending bubble at the tail of the feed
    // until then). A live Telegram/automation run on this conversation is
    // steered the same way — the runner's inbox is keyed by conversation.
    // sendingRef counts as mid-turn too: a send is in flight and its turn
    // may not be registered yet, so the message waits for it to settle
    // (flushHeld) instead of being eaten by sendContent's re-entry guard.
    if (busy || sendingRef.current) {
      setDraft('')
      setPendingAttachments([])
      heldMessagesRef.current.push({ kind: 'text', text: trimmed, attachments: atts })
      void flushHeldRef.current()
      return
    }
    setDraft('')
    setPendingAttachments([])
    await sendContent(trimmed, atts)
  }, [draft, pendingAttachments, staging, busy, sendContent])

  // "Try again" on a failed turn's error card: continue the conversation with
  // a message that names what went wrong, so the model resumes from where it
  // stopped instead of restarting the task blind.
  const handleTryAgain = useCallback(
    (reason: string) => {
      void sendContent(t('errors.provider.tryAgainMessage', { reason }))
    },
    [sendContent, t]
  )

  // The stalled card's Continue: not a re-ask but a system aside — the model
  // is told the previous request was aborted after five silent minutes and
  // that everything above still stands. Rides history as a user turn (see
  // UserMessage.systemAside) so provider alternation holds.
  const handleContinue = useCallback(() => {
    void sendContent(t('errors.provider.stallContinueMessage'), [], { systemAside: true })
  }, [sendContent, t])

  // A procedure's Play button spawns a fresh SESSION carrying the procedure
  // on its descriptor, then switches to Chat — this instance auto-sends it
  // into its brand-new conversation. The ref guards against a re-fire (e.g.
  // the `streaming` flip): the descriptor's procedure object is stable for
  // the life of the session, so reference identity is the one-shot latch.
  const procedureRunRef = useRef<PendingProcedure | null>(null)
  useEffect(() => {
    const procedure = descriptor.procedure
    if (procedure == null || busy) return
    if (procedureRunRef.current === procedure) return
    procedureRunRef.current = procedure
    // Consume at the PROVIDER too: the descriptor outlives this instance, so
    // without nulling it a remounted Chat would re-execute the procedure —
    // duplicate autonomous runs with real side effects.
    consumeProcedure(sessionKey)
    const { prompt, mode, files = [], directories = [], thinking } = procedure
    // The procedure's attachments become THIS conversation's: the folders show
    // up in the composer's picker and the files ride every turn's overlay, so a
    // follow-up question typed here still has both. Written to disk before the
    // send so a reload of the conversation keeps them.
    setStoredFolders(directories)
    setStoredContextFiles(files)
    void (async () => {
      if (files.length > 0 || directories.length > 0) {
        await ensureConversationId()
        const conv = conversationRef.current
        if (conv) {
          conv.workingFolder = directories.length > 0 ? directories : null
          conv.contextFiles = files.length > 0 ? files : null
          await window.api.conversation.save(conv).catch(() => undefined)
        }
      }
      await sendContent(prompt, [], {
        ...(mode ? { modeOverride: mode } : {}),
        // The procedure's own thinking stamp; absent ⇒ the state-based
        // thinkingMode (the chat's selection / the project's stamp) carries it.
        ...(thinking ? { thinkingOverride: thinking } : {}),
        workingFolders: directories,
        contextFiles: files
      })
    })()
  }, [descriptor.procedure, busy, sendContent, consumeProcedure, sessionKey, ensureConversationId])

  /**
   * Send one voice take: upload the audio, drop it in the feed with a
   * transcribing placeholder, run STT, then fire the turn. Takes the blob as
   * an argument instead of reading the recorder state, because the same path
   * serves a take sent straight from review AND one that waited in the queue
   * while another turn ran — upload and STT happen on the send either way.
   */
  const sendVoiceBlob = useCallback(
    async (blob: Blob, blobUrl: string | null) => {
      // Same synchronous re-entry + eviction guard as sendContent: the STT and
      // upload awaits below all precede setStreaming(true), so `busy`
      // can't protect this window on its own.
      if (busy || sendingRef.current) return
      sendingRef.current = true
      markSending(sessionKey, true)

      try {
        const conversationId = await ensureConversationId()
        const buffer = await blob.arrayBuffer()
        const fileName = `recording-${Date.now()}.webm`
        const meta = await window.api.upload.saveBuffer({ conversationId, buffer, fileName })
        if (blobUrl) URL.revokeObjectURL(blobUrl)
        const attachment: MessageAttachment = {
          type: meta.type,
          filePath: meta.filePath,
          originalName: meta.originalName,
          mimeType: meta.mimeType,
          sizeBytes: meta.sizeBytes
        }

        // Render the audio in chat immediately with a transcribing
        // placeholder, BEFORE running STT — so the player shows up the
        // instant the user clicks send, and the transcript fills in
        // when whisper returns.
        const userMsgId = cryptoId()
        const userTs = Date.now()
        setMessages((prev) => [
          ...prev,
          {
            id: userMsgId,
            role: 'user',
            content: '',
            attachments: [attachment],
            transcribing: true,
            timestamp: userTs
          }
        ])

        const sttResult = await window.api.stt.transcribe({
          filePath: meta.filePath,
          conversationId
        })

        if (!sttResult.ok) {
          toast.show({ message: sttResult.error, tone: 'error' })
          setMessages((prev) =>
            prev.map((m) => (m.id === userMsgId ? { ...m, content: '', transcribing: false } : m))
          )
          return
        }

        const transcript = sttResult.transcript
        // voicePrompt/voiceLang are what the CHANNELS stamp on a voice note, and
        // textHistory reads them to replay this message as `<voice_note>` +
        // transcript on every later turn. Without them the audio path would be
        // re-advertised to the model in an <attachments> block for the rest of
        // the conversation, and the detected language would be lost after turn 1.
        setMessages((prev) =>
          prev.map((m) =>
            m.id === userMsgId
              ? {
                  ...m,
                  content: transcript,
                  transcribing: false,
                  voicePrompt: true,
                  ...(sttResult.language ? { voiceLang: sttResult.language } : {})
                }
              : m
          )
        )

        // Now trigger the LLM — mirrors sendContent's tail. We use the
        // raw transcript (no 🎙 prefix) for the model-facing history so
        // the agent doesn't echo our UI marker back. The <voice_note lang="…">
        // tag carries Whisper's detected language so the model replies in it
        // instead of guessing from a short transcript.
        const workspaceRoot = status?.rootPath ?? null
        const langAttr = sttResult.language ? ` lang="${sttResult.language}"` : ''
        const historyContent = `<voice_note${langAttr}>\n${composeHistoryContent(
          transcript,
          [attachment],
          workspaceRoot
        )}`
        const currentEntry: {
          role: 'user'
          content: string
          attachments?: MessageAttachment[]
        } = { role: 'user', content: historyContent, attachments: [attachment] }
        const history = textHistory(messages, workspaceRoot, {
          summary: conversationRef.current?.summary,
          summarizedThroughMessage: conversationRef.current?.summarizedThroughMessage,
          summarizedThroughMessageId: conversationRef.current?.summarizedThroughMessageId,
          conversationId: conversationRef.current?.id ?? null
        }).concat(currentEntry)

        const assistantPlaceholder: AssistantMessage = {
          id: cryptoId(),
          role: 'assistant',
          segments: [],
          status: 'streaming',
          timestamp: Date.now()
        }
        setMessages((prev) => [...prev, assistantPlaceholder])
        scrollToBottom()
        setStreaming(true)
        const sendNow = Date.now()
        setTurnStartedAt(sendNow)
        turnStartedAtRef.current = sendNow
        setTurnEndedAt(null)
        setInputTokens(0)
        setOutputTokens(0)
        setCacheReadTokens(0)
        setCacheWriteTokens(0)
        setSideSpend(null)
        setWorkflowSpend(null)
        setUsageUnavailable(false)
        pendingTurnUsageRef.current = null
        turnStatsRef.current = emptyTurnStats()
        // Keep the timeline additive across the whole conversation — seed a
        // boundary for this turn instead of wiping the prior turns' events.
        setTimelineEntries((prev) => [...prev, makeTurnBoundary(transcript)])
        setTimelineOpen(false)
        setFilesOpen(false)

        sendInFlightRef.current = true
        const response = await window.api.chat.send({
          history,
          conversationId,
          // Same contract as sendContent: the titler shell persists this very
          // message, and it must carry the feed's id to reconcile later.
          userMessageId: userMsgId,
          // Same contract as sendContent — main's mid-turn checkpoint writes
          // under this id so the fold below replaces it, not duplicates it.
          assistantMessageId: assistantPlaceholder.id,
          workingFolders,
          contextFiles,
          thinkingMode: thinkingMode as import('@preload/index').ThinkingMode,
          projectId: descriptor.projectId ?? undefined
        })
        sendInFlightRef.current = false
        if (
          pendingTurnIdRef.current === null &&
          response.turnId !== lastTerminalTurnIdRef.current
        ) {
          pendingTurnIdRef.current = response.turnId
        }
        if (!response.ok && response.error) {
          pendingTurnIdRef.current = null
          setStreaming(false)
          setTurnEndedAt(Date.now())
          // The send never became a turn — don't let a later finalize fold it.
          turnStartedAtRef.current = null
          shouldPersistRef.current = true
          setMessages((prev) => markError(prev, response.turnId, response.error ?? 'unknown error'))
        }
      } catch {
        toast.show({ message: t('chat.voice.error'), tone: 'error' })
      } finally {
        sendingRef.current = false
        markSending(sessionKey, false)
        // Same as sendContent: what was submitted meanwhile goes out now.
        void flushHeldRef.current()
      }
    },
    [
      descriptor.projectId,
      ensureConversationId,
      toast,
      t,
      busy,
      messages,
      setMessages,
      markSending,
      sessionKey,
      status,
      workingFolders,
      contextFiles,
      thinkingMode,
      scrollToBottom
    ]
  )

  /**
   * A voice take sent MID-TURN: upload the audio, show it as a pending
   * bubble with the transcribing placeholder, run STT, then hand the
   * transcript to the running turn as a voice-note interjection. Upload and
   * STT happen here rather than at the send because the runner needs real
   * on-disk paths and real text. If the turn is gone by the time the
   * transcript is back, the take becomes the next turn (held, then sent
   * through sendContent's voice shape) — never dropped.
   */
  const interjectVoiceBlob = useCallback(
    async (blob: Blob, blobUrl: string | null, conversationId: string) => {
      const messageId = cryptoId()
      try {
        const buffer = await blob.arrayBuffer()
        const fileName = `recording-${Date.now()}.webm`
        const meta = await window.api.upload.saveBuffer({ conversationId, buffer, fileName })
        if (blobUrl) URL.revokeObjectURL(blobUrl)
        const attachment: MessageAttachment = {
          type: meta.type,
          filePath: meta.filePath,
          originalName: meta.originalName,
          mimeType: meta.mimeType,
          sizeBytes: meta.sizeBytes
        }
        setPendingInterjections((prev) => [
          ...prev,
          {
            conversationId,
            messageId,
            text: '',
            attachments: [attachment],
            voicePrompt: true,
            transcribing: true,
            mine: true
          }
        ])
        const sttResult = await window.api.stt.transcribe({
          filePath: meta.filePath,
          conversationId
        })
        // Taken back (the X) while the transcript was in flight — the row is
        // already gone; the runner never heard of it.
        if (abortedVoiceInterjectionsRef.current.delete(messageId)) return
        if (!sttResult.ok) {
          toast.show({ message: sttResult.error, tone: 'error' })
          setPendingInterjections((prev) => prev.filter((p) => p.messageId !== messageId))
          return
        }
        const item = {
          text: sttResult.transcript,
          attachments: [attachment],
          voicePrompt: true as const,
          ...(sttResult.language ? { voiceLang: sttResult.language } : {})
        }
        const accepted = await interjectNow(conversationId, item, messageId)
        if (!accepted) {
          heldMessagesRef.current.push({ kind: 'text', ...item })
          void flushHeldRef.current()
        }
      } catch {
        setPendingInterjections((prev) => prev.filter((p) => p.messageId !== messageId))
        toast.show({ message: t('chat.voice.error'), tone: 'error' })
      }
    },
    [interjectNow, toast, t]
  )

  /**
   * The review row's send button. Mid-turn it SENDS the take to the running
   * turn — same rule as a typed prompt (see `send`): uploaded and
   * transcribed now, read by the agent at its next step. The recorder
   * resets either way: the take now belongs to the send, not to the
   * composer.
   */
  const sendRecording = useCallback(async () => {
    const blob = recBlobRef.current
    if (!blob) return
    const blobUrl = recBlobUrl
    if (recAudioRef.current) {
      recAudioRef.current.pause()
      recAudioRef.current = null
    }
    setRecPhase('idle')
    setRecPlaying(false)
    setRecElapsed(0)
    recBlobRef.current = null
    // Hand the object URL over WITHOUT revoking: whichever path uploads the
    // audio revokes it once the bytes are on disk.
    setRecBlobUrl(null)
    if (busy || sendingRef.current) {
      heldMessagesRef.current.push({ kind: 'voice', blob, blobUrl })
      void flushHeldRef.current()
      return
    }
    await sendVoiceBlob(blob, blobUrl)
  }, [busy, recBlobUrl, sendVoiceBlob])

  // `busy` for the flush below, read at call time rather than captured:
  // the flush is reached from inside sends and IPC callbacks whose closures
  // are older than the latest render.
  const busyRef = useRef(busy)
  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  /**
   * Send whatever is waiting in heldMessagesRef, in order. A live turn (this
   * window's, or a channel run on the same conversation) takes each message
   * as an interjection; with none, the first message becomes the next turn
   * and that send's own finally flushes the rest. The one thing this must
   * never do is hand a message to sendContent while the window still reads
   * busy — the re-entry guard there would eat it — so a message the runner
   * bounced while busy goes back to the head and waits for the busy→idle
   * transition (the effect below) to retry.
   */
  const flushHeld = useCallback(async (): Promise<void> => {
    if (flushingHeldRef.current || sendingRef.current) return
    flushingHeldRef.current = true
    try {
      for (;;) {
        const item = heldMessagesRef.current.shift()
        if (!item) break
        const conversationId = conversationIdRef.current
        const live =
          conversationId !== null && (pendingTurnIdRef.current !== null || busyRef.current)
        if (live && conversationId) {
          if (item.kind === 'voice') {
            await interjectVoiceBlob(item.blob, item.blobUrl, conversationId)
            continue
          }
          // Minted here rather than inside interjectNow so a bounce can keep
          // the row it just put up and the retry can reuse the same id.
          const messageId = item.messageId ?? cryptoId()
          const accepted = await interjectNow(conversationId, item, messageId)
          if (accepted) continue
          // Bounced: the turn closed a moment ago. If this window still
          // reads busy, the idle transition is imminent — wait for it.
          if (busyRef.current || sendingRef.current) {
            heldMessagesRef.current.unshift({ ...item, messageId })
            // interjectNow took its optimistic row down on the bounce, and
            // the composer was emptied the moment this was submitted — so
            // without putting a row back the user's words are on no screen
            // at all until the retry lands.
            //
            // EVERY queued text message gets one, not just the one that
            // bounced: this returns without draining the rest, and each of
            // them emptied the composer when it was submitted too. Ids are
            // minted and written back here so the retry reuses them and the
            // rows retire against their own delivered segments.
            const rows: PendingInterjection[] = []
            heldMessagesRef.current = heldMessagesRef.current.map((held) => {
              if (held.kind !== 'text') return held
              const id = held.messageId ?? cryptoId()
              rows.push({
                conversationId,
                messageId: id,
                text: held.text,
                attachments: held.attachments,
                ...(held.voicePrompt ? { voicePrompt: true } : {}),
                ...(held.voiceLang ? { voiceLang: held.voiceLang } : {}),
                holding: true,
                mine: true
              })
              return held.messageId ? held : { ...held, messageId: id }
            })
            setPendingInterjections((prev) => {
              const known = new Set(prev.map((p) => p.messageId))
              const fresh = rows.filter((r) => !known.has(r.messageId))
              return fresh.length === 0 ? prev : [...prev, ...fresh]
            })
            return
          }
        }
        // No live turn: this message is the next turn — its own bubble is
        // about to join the feed, so any held row standing in for it goes.
        if (item.kind === 'text' && item.messageId) {
          const heldId = item.messageId
          setPendingInterjections((prev) => prev.filter((p) => p.messageId !== heldId))
        }
        // Release the flag first — that send's finally re-enters here for
        // the rest.
        flushingHeldRef.current = false
        if (item.kind === 'voice') await sendVoiceBlob(item.blob, item.blobUrl)
        else {
          await sendContent(
            item.text,
            item.attachments,
            item.voicePrompt ? { voice: { lang: item.voiceLang } } : undefined
          )
        }
        return
      }
    } finally {
      flushingHeldRef.current = false
    }
  }, [interjectNow, interjectVoiceBlob, sendContent, sendVoiceBlob])
  useEffect(() => {
    flushHeldRef.current = flushHeld
  }, [flushHeld])
  // The busy→idle transition: a message the runner bounced while this
  // window still read busy goes out now as the next turn. Runs inside the
  // async callback (the repo's set-state-in-effect pattern).
  useEffect(() => {
    if (busy || heldMessagesRef.current.length === 0) return
    void flushHeld()
  }, [busy, flushHeld])

  /**
   * Apply a withdraw outcome once — the X's own reply and the broadcast
   * event both report it. Only a message THIS window sent touches the
   * composer: taken back (by the user, or by a Stop) it returns to the
   * draft; closed on before being read (turn_ended / error — the sliver
   * between the agent's last drain and the lane closing) it is sent again
   * as the next turn. Anyone else's row just disappears.
   */
  const settleWithdrawn = useCallback(
    (item: PendingInterjection, reason: 'user' | 'canceled' | 'turn_ended' | 'error') => {
      if (settledInterjectionsRef.current.has(item.messageId)) return
      settledInterjectionsRef.current.add(item.messageId)
      setPendingInterjections((prev) => prev.filter((p) => p.messageId !== item.messageId))
      if (!item.mine) return
      if (reason === 'user' || reason === 'canceled') {
        if (item.text.length > 0) {
          setDraft((prev) => (prev.trim().length > 0 ? `${prev}\n${item.text}` : item.text))
        }
        // The audio of a voice note is not re-staged: its transcript is the
        // message, and it is back in the draft.
        if (!item.voicePrompt && item.attachments.length > 0) {
          setPendingAttachments((prev) => [
            ...prev,
            ...item.attachments.filter((a) => !prev.some((b) => b.filePath === a.filePath))
          ])
        }
        return
      }
      heldMessagesRef.current.push({
        kind: 'text',
        text: item.text,
        attachments: item.attachments,
        ...(item.voicePrompt ? { voicePrompt: true } : {}),
        ...(item.voiceLang ? { voiceLang: item.voiceLang } : {})
      })
      void flushHeldRef.current()
    },
    []
  )

  /** The X on a pending bubble. False from the runner means the agent already read it — its segment retires the row. */
  const withdrawPending = useCallback(
    async (item: PendingInterjection) => {
      if (item.transcribing) {
        // Not at the runner yet — the transcript is still coming back.
        abortedVoiceInterjectionsRef.current.add(item.messageId)
        setPendingInterjections((prev) => prev.filter((p) => p.messageId !== item.messageId))
        return
      }
      if (item.holding) {
        // Also not at the runner: it is waiting in heldMessagesRef for the
        // busy→idle retry, so taking it back means dropping it there and
        // handing the words to the composer — the same place a withdraw
        // puts them once the runner does hold the message.
        heldMessagesRef.current = heldMessagesRef.current.filter(
          (h) => h.kind === 'voice' || h.messageId !== item.messageId
        )
        setPendingInterjections((prev) => prev.filter((p) => p.messageId !== item.messageId))
        if (item.text.length > 0) {
          setDraft((prev) => (prev.trim().length > 0 ? `${prev}\n${item.text}` : item.text))
        }
        if (!item.voicePrompt && item.attachments.length > 0) {
          setPendingAttachments((prev) => [
            ...prev,
            ...item.attachments.filter((a) => !prev.some((b) => b.filePath === a.filePath))
          ])
        }
        return
      }
      let taken = false
      try {
        taken = await window.api.chat.withdrawInterjection({
          conversationId: item.conversationId,
          messageId: item.messageId
        })
      } catch {
        taken = false
      }
      if (taken) settleWithdrawn(item, 'user')
    },
    [settleWithdrawn]
  )

  // Mid-turn message lifecycle, every surface's included: the phone can
  // steer a run this window is watching, and this window can steer a
  // Telegram run. Pending rows show and hide for anyone's message; the
  // draft restore and the resend happen only for a message THIS window sent.
  useEffect(() => {
    return window.api.chat.onInterjection((ev) => {
      if (ev.conversationId !== conversationIdRef.current) return
      if (ev.state === 'pending') {
        setPendingInterjections((prev) =>
          prev.some((p) => p.messageId === ev.messageId)
            ? prev
            : [
                ...prev,
                {
                  conversationId: ev.conversationId,
                  messageId: ev.messageId,
                  text: ev.text,
                  attachments: ev.attachments,
                  ...(ev.voicePrompt ? { voicePrompt: true } : {}),
                  ...(ev.voiceLang ? { voiceLang: ev.voiceLang } : {}),
                  mine: false
                }
              ]
        )
        return
      }
      if (ev.state === 'delivered') {
        // Belt and braces with the `user_message` segment.
        setPendingInterjections((prev) => prev.filter((p) => p.messageId !== ev.messageId))
        return
      }
      const known = pendingInterjectionsRef.current.find((p) => p.messageId === ev.messageId)
      settleWithdrawn(
        known ?? {
          conversationId: ev.conversationId,
          messageId: ev.messageId,
          text: ev.text,
          attachments: ev.attachments,
          mine: false
        },
        ev.reason ?? 'user'
      )
    })
  }, [settleWithdrawn])

  /**
   * The pending bubbles the feed draws: this conversation's, minus any whose
   * delivered copy is already in the streaming card (the segment can land
   * before its `delivered` event is processed — never show both).
   */
  const visiblePendingInterjections = useMemo((): PendingInterjection[] => {
    if (pendingInterjections.length === 0) return pendingInterjections
    const tail = messages[messages.length - 1]
    const delivered = new Set<string>()
    if (tail && isAssistant(tail)) {
      for (const s of tail.segments) if (s.kind === 'user_message') delivered.add(s.messageId)
    }
    return pendingInterjections.filter(
      (p) => p.conversationId === activeConversationId && !delivered.has(p.messageId)
    )
  }, [pendingInterjections, messages, activeConversationId])

  const stop = useCallback(() => {
    // Scoped: only THIS session's conversation stops — the other sessions'
    // (and channels') turns keep running.
    const conversationId = conversationIdRef.current
    if (!conversationId) return
    void window.api.chat.cancel({ conversationId })
  }, [])

  /**
   * Save each source (filesystem path or in-memory File) into the active
   * conversation's uploads folder, gathering metadata to stage as
   * pendingAttachments. Validates each file individually against
   * size/count/type limits — invalid files get a toast error, valid ones
   * are staged. Files dropped from the OS or pasted from clipboard arrive
   * as File objects: paths come via webUtils.getPathForFile when the file
   * lives on disk, otherwise we read the buffer (e.g. clipboard images).
   */
  const stageSources = useCallback(
    async (sources: Array<{ kind: 'path'; path: string } | { kind: 'file'; file: File }>) => {
      if (sources.length === 0) return
      const conversationId = await ensureConversationId()
      let currentCount = pendingAttachments.length
      let currentTotalBytes = pendingAttachments.reduce((s, a) => s + a.sizeBytes, 0)

      // Every chip appears at once, before the first byte moves — a 5-file
      // pick shouldn't reveal itself one file at a time. `id` doubles as the
      // progressId main tags its copy ticks with.
      const staged: StagingFile[] = sources.map((source) => ({
        id: cryptoId(),
        name: source.kind === 'path' ? baseNameOf(source.path) : pastedFileName(source.file),
        // Path sources copy main-side and report real bytes; in-memory ones
        // (clipboard pastes) have no measurable transfer — they spin instead.
        percent: source.kind === 'path' ? 0 : null
      }))
      const unstage = (id: string): void =>
        setStagingFiles((prev) => prev.filter((s) => s.id !== id))
      setStagingFiles((prev) => [...prev, ...staged])

      try {
        for (const [i, source] of sources.entries()) {
          const stagedId = staged[i].id
          try {
            let meta: MessageAttachment
            if (source.kind === 'path') {
              meta = await window.api.upload.saveFile({
                conversationId,
                sourcePath: source.path,
                progressId: stagedId
              })
            } else {
              const buffer = await source.file.arrayBuffer()
              const fileName = pastedFileName(source.file)
              meta = await window.api.upload.saveBuffer({ conversationId, buffer, fileName })
            }
            const error = await window.api.upload.validate({
              fileName: meta.originalName,
              sizeBytes: meta.sizeBytes,
              currentCount,
              currentTotalBytes
            })
            if (error) {
              const msg = validationErrorMessage(error, t)
              toast.show({ message: msg, tone: 'error' })
              continue
            }
            // Committed one at a time so a finished chip hands straight over
            // to its real attachment instead of the row emptying and refilling.
            setPendingAttachments((prev) => [...prev, meta])
            currentCount++
            currentTotalBytes += meta.sizeBytes
          } catch {
            // skip this file — multi-file batches shouldn't fail-fast
          } finally {
            unstage(stagedId)
          }
        }
      } finally {
        // Belt and braces: nothing from this batch can outlive it, however
        // it ended — a stuck chip would block send forever.
        setStagingFiles((prev) => prev.filter((s) => !staged.some((x) => x.id === s.id)))
      }
    },
    [ensureConversationId, pendingAttachments, toast, t]
  )

  // Byte ticks for the staged chips' rings, correlated by progressId. A tick
  // for an id that's already landed (or never staged) is a no-op that keeps
  // the array identity, so it can't cost a render.
  useEffect(() => {
    return window.api.upload.onCopyProgress(({ progressId, copiedBytes, totalBytes }) => {
      setStagingFiles((prev) => {
        const index = prev.findIndex((s) => s.id === progressId)
        if (index === -1) return prev
        const percent =
          totalBytes > 0 ? Math.min(100, Math.round((copiedBytes / totalBytes) * 100)) : 100
        if (prev[index].percent === percent) return prev
        const next = prev.slice()
        next[index] = { ...next[index], percent }
        return next
      })
    })
  }, [])

  const stageFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      const sources = files.map((file) => {
        let path = ''
        try {
          path = window.api.upload.getPathForFile(file)
        } catch {
          path = ''
        }
        return path.length > 0
          ? ({ kind: 'path', path } as const)
          : ({ kind: 'file', file } as const)
      })
      await stageSources(sources)
    },
    [stageSources]
  )

  const pickUploads = useCallback(async () => {
    const paths = await window.api.upload.pickFile()
    await stageSources(paths.map((path) => ({ kind: 'path', path }) as const))
  }, [stageSources])

  const removePending = useCallback((filePath: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.filePath !== filePath))
  }, [])

  const [exportingPdf, setExportingPdf] = useState(false)
  const canExportPdf = useMemo(
    () => hasExportableContent(messages, inAppVerbose),
    [messages, inAppVerbose]
  )

  const exportChatPdf = useCallback(async () => {
    if (exportingPdf || busy || !hasExportableContent(messages, inAppVerbose)) return
    setExportingPdf(true)
    try {
      const firstUser = messages.find(isUser)?.content.replace(/\s+/g, ' ').trim() ?? ''
      const title = (firstUser || t('chat.pdfExport.untitled')).slice(0, 80)
      const exportedAt = `Wolffish · ${new Date().toLocaleString(locale, {
        dateStyle: 'long',
        timeStyle: 'short'
      })}`
      const html = buildChatPdfHtml({
        title,
        exportedAt,
        userLabel: t('chat.pdfExport.you'),
        assistantLabel: 'Wolffish',
        toolStatusLabels: {
          running: t('chat.toolCard.status.running'),
          success: t('chat.toolCard.status.success'),
          failed: t('chat.toolCard.status.failed'),
          denied: t('chat.toolCard.status.denied'),
          checked_in: t('chat.toolCard.status.checked_in'),
          stopped: t('chat.toolCard.status.stopped'),
          stoppedByUser: t('chat.toolCard.status.stoppedByUser'),
          stoppedByModel: t('chat.toolCard.status.stoppedByModel')
        },
        toolStopReasons: {
          user: t('chat.toolCard.stopReason.user'),
          model: t('chat.toolCard.stopReason.model')
        },
        verbose: inAppVerbose,
        locale,
        rtl: isRtl,
        messages
      })
      const fileName = `${
        title
          .replace(/[\\/:*?"<>|]/g, '-')
          .trim()
          .slice(0, 60) || 'wolffish-chat'
      }.pdf`
      const result = await window.api.chat.exportPdf({ html, fileName })
      if (result.ok) toast.show({ message: t('chat.pdfExport.saved'), tone: 'success' })
      else if (!result.canceled) toast.show({ message: t('chat.pdfExport.error'), tone: 'error' })
    } finally {
      setExportingPdf(false)
    }
  }, [exportingPdf, busy, messages, inAppVerbose, t, locale, isRtl, toast])

  const persistWorkingFolders = useCallback(
    async (folders: string[]) => {
      await ensureConversationId()
      const conv = conversationRef.current
      if (!conv) return
      conv.workingFolder = folders.length > 0 ? folders : null
      await window.api.conversation.save(conv)
    },
    [ensureConversationId]
  )

  // Adding stays live mid-turn, like attaching: the running turn already has
  // the folder list it was sent with, and a folder picked now rides the NEXT
  // (queued) prompt — sendContent reads `workingFolders` when the queue
  // flushes, not when the row was queued.
  const addWorkingFolder = useCallback(async () => {
    const folder = await window.api.upload.pickFolder()
    if (!folder || storedFolders.includes(folder)) return
    const updated = [...storedFolders, folder]
    setStoredFolders(updated)
    await persistWorkingFolders(updated)
  }, [storedFolders, persistWorkingFolders])

  // Removing does NOT: the running turn may be reading files under that
  // folder, so pulling it out mid-turn would strand the work in flight.
  // The UI disables the delete affordance while busy; this guard is the
  // backstop for any other caller.
  const removeWorkingFolder = useCallback(
    async (path: string) => {
      if (busy) return
      const updated = storedFolders.filter((f) => f !== path)
      setStoredFolders(updated)
      const conv = conversationRef.current
      if (!conv) return
      conv.workingFolder = updated.length > 0 ? updated : null
      await window.api.conversation.save(conv)
    },
    [busy, storedFolders]
  )

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.stopPropagation()
    setDragActive(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    // The dragleave fires on every child boundary; only clear the flag
    // when we leave the chat container itself (relatedTarget outside).
    const related = e.relatedTarget as Node | null
    if (related && (e.currentTarget as Node).contains(related)) return
    setDragActive(false)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()
      setDragActive(false)
      const files = Array.from(e.dataTransfer.files ?? [])
      if (files.length === 0) return
      await stageFiles(files)
    },
    [stageFiles]
  )

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLElement>) => {
      const files = Array.from(e.clipboardData?.files ?? [])
      if (files.length === 0) return
      // Intercept clipboard files so they don't end up as binary noise
      // pasted into the textarea. Plain text paste keeps default behavior.
      e.preventDefault()
      await stageFiles(files)
    },
    [stageFiles]
  )

  const hasMessages = messages.length > 0
  const placeholderAlign = useMemo(() => (isRtl ? 'text-right' : 'text-left'), [isRtl])

  return (
    <main
      className={cn('bg-bg relative flex h-full w-full flex-col', pageTopPadding)}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onPaste={handlePaste}
    >
      {dragActive && (
        <div
          aria-hidden
          className={cn(
            'bg-bg/80 pointer-events-none absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 backdrop-blur',
            'text-fg text-sm font-medium'
          )}
        >
          <CloudUploadIcon size={40} className="text-accent" />
          {t('chat.dropToAttach')}
        </div>
      )}
      {/* Navigation lives in the app-level FloatingChrome (glass discs +
          conversations sheet) laid over this transcript — no rails, no
          header. It stays live while turns stream; only the composer of a
          PROCESSING conversation is gated (below). */}
      <TouchedFolders folders={folderStrip} />
      <div
        ref={scrollerRef}
        className="relative flex flex-1 flex-col-reverse overflow-x-hidden overflow-y-auto px-6 py-8 max-sm:px-3 max-sm:py-5"
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 px-6 pt-2">
          <div className="pointer-events-auto">
            <UpdateCard />
          </div>
        </div>
        <div
          className={cn(
            // `w-full` is essential: as a flex item of the column-reverse
            // scroller, `mx-auto` alone would shrink this wrapper to its
            // content width (collapsing the column and centering bubbles).
            // w-full + max-w-3xl + mx-auto restores the normal centered column.
            'mx-auto flex w-full max-w-3xl flex-col gap-4',
            // Empty state centers the welcome; otherwise the conversation
            // bottom-pins via the column-reverse scroller — the newest message
            // is glued to the bottom from the first frame, so opening a
            // conversation never flashes the top before snapping to the end.
            !hasMessages && 'h-full justify-center'
          )}
        >
          {!hasMessages && (
            <div className="text-fg flex flex-col items-center gap-4 text-center">
              {/* Project mode swaps the wolffish hero for the project's own
                  identity: emoji icon, title, and the instructions themselves —
                  the base every conversation here starts from. */}
              {sessionProject ? (
                <span aria-hidden className="text-6xl leading-none">
                  {sessionProject.icon || '📁'}
                </span>
              ) : (
                <img
                  src={iconTransparent}
                  alt=""
                  aria-hidden
                  className="h-20 w-20 object-contain"
                  draggable={false}
                />
              )}
              <div className="flex flex-col gap-2">
                <h2 className="text-2xl font-semibold tracking-tight">
                  {sessionProject
                    ? sessionProject.title.trim() || t('projects.untitled')
                    : t('chat.empty.title')}
                </h2>
                {sessionProject ? (
                  // The instructions in full, in the same capped code block the
                  // Projects cards draw — a prompt is the thing you actually
                  // came here to read, and two clamped lines never showed it.
                  // `overscroll-contain` keeps its wheel from chaining into the
                  // conversation scroller once it hits an end.
                  sessionProject.instructions.trim() ? (
                    <pre
                      dir="auto"
                      className={cn(
                        'bg-surface border-border text-muted w-full max-w-md',
                        'max-h-40 overflow-auto overscroll-contain rounded-lg border px-3 py-2',
                        'text-start font-mono text-xs leading-relaxed wrap-break-word whitespace-pre-wrap'
                      )}
                    >
                      {sessionProject.instructions.trim()}
                    </pre>
                  ) : (
                    <p className="text-muted max-w-md text-sm leading-relaxed">
                      {t('projects.noInstructions')}
                    </p>
                  )
                ) : (
                  <p dir="auto" className="text-muted text-sm leading-relaxed">
                    {t('chat.empty.subtitle')}
                  </p>
                )}
              </div>
              {!hasAnyModel && (
                <div
                  className={cn(
                    'border-border bg-surface text-muted',
                    'mt-2 flex w-full max-w-sm items-center gap-2.5 rounded-xl border px-4 py-3 text-xs leading-relaxed'
                  )}
                >
                  <Settings02Icon size={14} className="shrink-0" aria-hidden />
                  <p className="flex-1">
                    {localModelMissing ? t('chat.noModel.localMissing') : t('chat.noModel.notice')}
                    <br />
                    <button
                      type="button"
                      onClick={() => {
                        preselectSettingsTab('model')
                        goTo('settings')
                      }}
                      className="text-primary hover:underline cursor-pointer font-medium"
                    >
                      {t('chat.noModel.settingsLink')}
                    </button>
                  </p>
                </div>
              )}
            </div>
          )}
          <InAppVerboseContext.Provider value={inAppVerbose}>
            <InAppReasoningContext.Provider value={inAppReasoning}>
              {feedMessages.map((m, i) => (
                <ChatItem
                  key={m.id}
                  message={m}
                  t={t}
                  todoLists={todoLists}
                  awaitingApproval={awaitingApproval}
                  awaitingAsk={awaitingAsk}
                  onApprovalDecision={respondApproval}
                  onAskRespond={respondAsk}
                  onTryAgain={
                    i === feedMessages.length - 1 &&
                    !busy &&
                    m.role === 'assistant' &&
                    m.status === 'error'
                      ? handleTryAgain
                      : undefined
                  }
                  onContinue={
                    i === feedMessages.length - 1 &&
                    !busy &&
                    m.role === 'assistant' &&
                    m.status === 'error'
                      ? handleContinue
                      : undefined
                  }
                />
              ))}
              {/* Messages sent mid-turn and not yet read: AFTER the streaming
                  card, at the tail — the agent reads them at its next step,
                  and the bubble then moves inside the card at that exact
                  point (the `user_message` segment). */}
              {visiblePendingInterjections.map((p) => (
                <PendingInterjectionBubble
                  key={p.messageId}
                  item={p}
                  onWithdraw={() => void withdrawPending(p)}
                />
              ))}
            </InAppReasoningContext.Provider>
          </InAppVerboseContext.Provider>
          {hasMessages && !hasAnyModel && (
            <div
              className={cn(
                'border-border bg-surface text-muted',
                'flex items-center gap-2.5 rounded-xl border px-4 py-3 text-xs leading-relaxed self-start'
              )}
            >
              <Settings02Icon size={14} className="shrink-0" aria-hidden />
              <p className="flex-1">
                {localModelMissing ? t('chat.noModel.localMissing') : t('chat.noModel.notice')}
                <br />
                <button
                  type="button"
                  onClick={() => {
                    preselectSettingsTab('model')
                    goTo('settings')
                  }}
                  className="text-primary hover:underline cursor-pointer font-medium"
                >
                  {t('chat.noModel.settingsLink')}
                </button>
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Composer: identical for every conversation, whatever channel it came
          from. A WhatsApp / Telegram / heartbeat / procedure conversation is
          continued from here exactly like an in-app one — same file, same
          agent, same turn path; only the reply's delivery differs (it renders
          here rather than being pushed back to the channel). */}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (busy) stop()
          else void send()
        }}
        className={cn(
          'bg-bg/80 relative z-40 p-3 backdrop-blur',
          !busy && 'border-t border-border/60'
        )}
      >
        {busy && <div className="rainbow-border" />}
        {(pendingAttachments.length > 0 || staging) && (
          <div className="pointer-events-none absolute inset-x-0 bottom-full flex flex-col gap-2 px-4 pb-2">
            <div className="pointer-events-auto mx-auto flex max-w-xl flex-wrap gap-2">
              {pendingAttachments.map((att) => (
                <PendingAttachmentChip
                  key={att.filePath}
                  attachment={att}
                  onRemove={() => removePending(att.filePath)}
                />
              ))}
              {/* Copying chips sit at the end and are swapped for the real
                  chip above as each file lands. */}
              {stagingFiles.map((file) => (
                <StagingAttachmentChip key={file.id} file={file} />
              ))}
            </div>
          </div>
        )}
        {/* One surface, Codex/Claude-style: the prompt IS the composer. The
            card carries the border/background that used to belong to the
            textarea; every control rides INSIDE it. Top zone: just the
            textarea (or the recorder strip that swaps in for it) — New Chat
            and the Project button moved up to the floating chrome. Bottom
            zone: model + usage at the start, message actions + send at the
            end. */}
        <div className="border-border bg-surface focus-within:border-muted relative flex w-full flex-col rounded-xl border">
          <div className="flex w-full items-start">
            {recPhase === 'idle' ? (
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    // Mid-turn this sends to the running turn — send()
                    // branches on `busy`.
                    void send()
                    return
                  }
                  // Escape while a turn runs is Stop — the keyboard twin of
                  // the red button beside the textarea.
                  if (e.key === 'Escape' && busy) {
                    e.preventDefault()
                    stop()
                  }
                }}
                rows={1}
                placeholder={busy ? t('chat.interject.placeholder') : t('chat.placeholder')}
                dir={isRtl ? 'rtl' : 'ltr'}
                className={cn(
                  'text-fg placeholder:text-muted max-h-40 min-h-9.5 min-w-0 flex-1 resize-none bg-transparent px-3.5 pt-2.5 pb-0.5 text-sm outline-none',
                  placeholderAlign
                )}
              />
            ) : recPhase === 'recording' ? (
              <div className="flex min-h-9.5 min-w-0 flex-1 items-center gap-3 px-3.5">
                <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500" />
                <span className="text-fg tabular-nums text-sm font-medium">
                  {formatRecTime(recElapsed)}
                </span>
                <span className="text-muted flex-1 text-xs">{t('chat.voice.recording')}</span>
                {/* Ends the RECORDING, not the turn — while a turn runs the
                    red turn-Stop sits right beside it, so it needs its own
                    label. */}
                <button
                  type="button"
                  onClick={stopRecording}
                  className="bg-red-600 text-white flex h-7 w-7 items-center justify-center rounded-full hover:bg-red-700"
                  aria-label={t('chat.voice.stopRecording')}
                  title={t('chat.voice.stopRecording')}
                >
                  <StopCircleIcon size={14} />
                </button>
              </div>
            ) : (
              <div className="flex min-h-9.5 min-w-0 flex-1 items-center gap-2 px-3.5">
                <button
                  type="button"
                  onClick={togglePlayback}
                  className="text-muted hover:text-fg flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                  aria-label={recPlaying ? t('chat.voice.pause') : t('chat.voice.play')}
                >
                  {recPlaying ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
                </button>
                <span className="text-fg tabular-nums text-sm font-medium">
                  {formatRecTime(recElapsed)}
                </span>
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={discardRecording}
                  className="text-muted hover:text-fg flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                  aria-label={t('chat.voice.delete')}
                  title={t('chat.voice.delete')}
                >
                  <Delete02Icon size={14} />
                </button>
                {/* Mid-turn this sends the take to the running turn — the
                    same send either way. */}
                <button
                  type="button"
                  onClick={() => void sendRecording()}
                  className="bg-primary text-primary-fg flex h-7 w-7 shrink-0 items-center justify-center rounded-full hover:brightness-110"
                  aria-label={t('chat.voice.send')}
                  title={t('chat.voice.send')}
                >
                  <ArrowUp02Icon size={14} />
                </button>
              </div>
            )}
          </div>
          {/* Below 640px the footer wraps into two rows — the chips (model,
              meter, logs, files) then the action buttons — because seven
              controls plus a model name never fit one 360px line without
              squeezing the send button off the end. */}
          <div className="flex w-full items-center gap-1 px-1.5 pb-1.5 max-sm:flex-wrap">
            {/* Reasoning effort and chat mode ride INSIDE this card's chip
                rows now (two rows above the model search) — one panel for
                every model knob instead of three composer pills. */}
            <ModelSwitch
              localOnly={localOnly}
              localModel={currentModel}
              providers={cloudProviders}
              ollama={ollama}
              brain={brain}
              disabled={savingMode || busy}
              reasoningModes={reasoningModes}
              reasoningMode={thinkingMode}
              chatMode={chatMode}
              showControls={recPhase === 'idle'}
              onModeChange={onModeChange}
              onSelectModel={async (sel) => {
                await window.api.provider.setBrain(sel)
                await refreshStatus()
              }}
              onSelectLocalModel={async (model) => {
                // Every model the card offers is already installed, so this
                // is the no-pull branch of model:select — it just writes the
                // choice and re-points the local provider.
                await window.api.model.select(model)
                await refreshStatus()
              }}
              onSelectReasoning={setThinkingMode}
              onSelectChatMode={async (mode) => {
                if (mode === chatMode) return
                await window.api.provider.setMode(mode)
                await refreshStatus()
              }}
            />
            {recPhase === 'idle' && (
              <ContextMeter
                used={contextTokens ?? 0}
                budget={contextBudget ?? 0}
                compactionAt={compactionAt}
                locale={locale}
                turnStartedAt={turnStartedAt}
                turnEndedAt={turnEndedAt}
                turnInputTokens={inputTokens}
                turnOutputTokens={outputTokens}
                turnCacheReadTokens={cacheReadTokens}
                turnCacheWriteTokens={cacheWriteTokens}
                lastTurn={convStats?.lastTurn ?? null}
                allTime={convStats?.allTime ?? null}
                sideSpend={sideSpend}
                workflow={workflowSpend}
                lastCall={lastCall}
                usageUnavailable={usageUnavailable}
                meterModel={meterModel}
                activeModel={activeModelName}
                provider={
                  lastCall?.provider ??
                  convStats?.lastTurn?.provider ??
                  (localOnly ? 'local' : activeCloudProvider)
                }
              />
            )}
            {/* Logs and files ride beside the meter rather than inside its
                card: the footer's start edge has the room, and one click
                opens the sheet instead of hover-card → button. Icon + count
                only — the count is the label. A chip with nothing behind it
                is dead weight, so each one stays out of the row entirely until
                its count is non-zero. */}
            {recPhase === 'idle' && (
              <>
                <SheetCountButton
                  icon={<ComputerTerminal01Icon size={14} />}
                  count={timelineEventCount}
                  label={t('chat.timeline.viewLogs')}
                  countLabel={t('chat.timeline.eventCount', { count: timelineEventCount })}
                  onOpen={() => setTimelineOpen(true)}
                />
                <SheetCountButton
                  icon={<Files01Icon size={14} />}
                  count={presentFiles.length}
                  label={t('chat.files.viewFiles')}
                  countLabel={t('chat.files.fileCount', { count: presentFiles.length })}
                  onOpen={() => setFilesOpen(true)}
                />
              </>
            )}
            <div className="min-w-0 flex-1" />
            {/* Plan mode, leading the end-edge cluster beside the draft editor
                button. It renders only while it can actually be toggled: the
                field is showing (the recorder owns the top row otherwise) and a
                model exists to run the turn. The stance keys on the
                conversation, or on the fresh chat until its first send creates
                one, so it works before the id exists. */}
            {recPhase === 'idle' && hasAnyModel && (
              <button
                type="button"
                onClick={() => setPlanMode(!planMode)}
                aria-pressed={planMode}
                title={planMode ? t('chat.planMode.onTitle') : t('chat.planMode.offTitle')}
                className={cn(
                  'me-1 flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full border px-2 text-xs font-medium',
                  // Leads the wrapped action row on phones.
                  'max-sm:ms-auto',
                  planMode
                    ? 'border-accent/40 bg-accent/10 text-accent'
                    : 'border-border bg-surface text-muted hover:text-fg'
                )}
              >
                <Task01Icon size={14} aria-hidden />
                {t('chat.planMode.label')}
              </button>
            )}
            {/* Opens the draft in the full-height CodeMirror sheet — leads the
                end-edge cluster; gone while the recorder owns the top zone. It
                names the sheet it opens, the way the automation, project and
                procedure editors name theirs, and now wears the same edit
                glyph their cards use to open an editor: the four-arrow expand
                mark belongs to the file, PDF, video and chart viewers, where
                the act really is "make this bigger", while this button's own
                label is "Write your message". Sized 16 like every other
                icon-only control in the cluster — the pencil is a lighter mark
                than the arrows were, so at 14 it read undersized beside them. */}
            {recPhase === 'idle' && (
              <button
                type="button"
                onClick={() => setDraftExpanded(true)}
                title={t('chat.expandDraft')}
                aria-label={t('chat.expandDraft')}
                className="text-muted hover:text-fg hover:bg-border/40 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg"
              >
                <Edit02Icon size={16} />
              </button>
            )}
            {/* No button when there is nothing printable, and none while it
                couldn't act — the turn running, the export in flight — since
                a greyed control in the row reads as broken. Both states are
                transient; the button returns the moment they end. */}
            {canExportPdf && !busy && !exportingPdf && (
              <button
                type="button"
                onClick={() => void exportChatPdf()}
                title={t('chat.downloadPdf')}
                aria-label={t('chat.downloadPdf')}
                className={cn(
                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                  'text-muted hover:text-fg hover:bg-border/40',
                  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                  'cursor-pointer'
                )}
              >
                <Download01Icon size={16} />
              </button>
            )}
            {/* Picking a folder stays live mid-turn — it rides the next queued
                prompt, same as an attachment. Removing is locked while the turn
                runs so the agent can't lose a folder it's working in. */}
            <WorkingFolderButton
              key={activeConversationId ?? 'none'}
              folders={workingFolders}
              onAdd={() => void addWorkingFolder()}
              onRemove={(folder) => void removeWorkingFolder(folder)}
              removeDisabled={busy}
            />
            {/* Attaching stays live mid-turn — staged files ride the next
                queued prompt instead of the running one. */}
            <button
              type="button"
              onClick={pickUploads}
              title={t('chat.attachFile')}
              aria-label={t('chat.attachFile')}
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                'text-muted hover:text-fg hover:bg-border/40',
                'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                'cursor-pointer'
              )}
            >
              <Image02Icon size={16} />
            </button>
            {/* Recording stays live mid-turn, like attaching: the take goes
                to the running turn like a typed message does. */}
            <button
              type="button"
              onClick={recPhase === 'idle' ? () => void startRecording() : undefined}
              disabled={!micAvailable || recPhase !== 'idle'}
              title={!micAvailable ? t('chat.voice.noMic') : t('chat.voice.record')}
              aria-label={t('chat.voice.record')}
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                'text-muted enabled:hover:text-fg enabled:hover:bg-border/40',
                'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                'disabled:cursor-not-allowed disabled:opacity-50',
                micAvailable && recPhase === 'idle' && 'cursor-pointer'
              )}
            >
              <Mic01Icon size={16} />
            </button>
            {/* Mid-turn the send arrow joins the row only once there is
                something to send — an empty draft beside a running turn
                shows nothing but Stop, and the arrow appearing as you type
                is the sign the message can go through to the running turn
                (send() branches on `busy`). Enter matches the arrow. */}
            {recPhase === 'idle' &&
              busy &&
              (draft.trim().length > 0 || pendingAttachments.length > 0) && (
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={!hasAnyModel || staging}
                  title={staging ? t('chat.upload.copyingWait') : t('chat.send')}
                  aria-label={t('chat.send')}
                  className={cn(
                    'flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full max-sm:h-9 max-sm:w-9',
                    'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                    'bg-primary text-primary-fg enabled:hover:brightness-110'
                  )}
                >
                  <ArrowUp02Icon size={16} />
                </button>
              )}
            {/* The recorder hides Send (the review row has its own) but never
                Stop: a turn you can't stop while you happen to be recording
                would be a trap. */}
            {(recPhase === 'idle' || busy) && (
              <button
                type="submit"
                // While busy this button is Stop, and Stop is gated on
                // NOTHING — a turn you can't stop because a file is copying,
                // or because the model it is running on just disappeared from
                // Ollama, would be a trap. That second case is live now that
                // hasAnyModel follows the daemon watch: `ollama rm` mid-turn
                // must never cost the user their stop button.
                disabled={
                  !busy &&
                  (!hasAnyModel ||
                    staging ||
                    (draft.trim().length === 0 && pendingAttachments.length === 0))
                }
                title={!busy && staging ? t('chat.upload.copyingWait') : undefined}
                aria-label={busy ? t('chat.stop') : t('chat.send')}
                className={cn(
                  'flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full max-sm:h-9 max-sm:w-9',
                  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                  busy
                    ? 'bg-red-600 text-white enabled:hover:bg-red-700'
                    : 'bg-primary text-primary-fg enabled:hover:brightness-110'
                )}
              >
                {busy ? <StopCircleIcon size={16} /> : <ArrowUp02Icon size={16} />}
              </button>
            )}
          </div>
        </div>
      </form>
      {/* The expanded composer — the file viewers' own expand sheet, over the
          same draft state, so what is written here is what the composer sends
          once this closes. The sheet, not a centered dialog: the automation,
          project and procedure editors expand the same way, so "give me more
          room" has one shape everywhere in the app. Still gated on `visible`,
          for the reason the portals below are — it mounts to <body>, so a
          hidden session's sheet would otherwise paint over whatever screen is
          actually in front. */}
      <ExpandedSheet
        open={visible && draftExpanded}
        onClose={() => setDraftExpanded(false)}
        title={t('chat.expandDraft')}
      >
        <CodeEditor
          value={draft}
          language="markdown"
          isDark={isDark}
          onChange={setDraft}
          className="h-full overflow-auto"
          placeholder={t('chat.placeholder')}
          spellcheck
        />
      </ExpandedSheet>
      {/* Gated on visibility: these portal to <body>, so without this they would
          escape the hidden wrapper and paint over another screen (or another
          session's view). */}
      {visible &&
        timelineOpen &&
        createPortal(
          <div
            role="presentation"
            onClick={() => setTimelineOpen(false)}
            className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
          >
            <aside
              role="dialog"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
              className="wf-sheet-panel-end border-border bg-surface absolute inset-y-0 inset-e-0 flex w-[80vw] max-w-full flex-col max-sm:w-[92vw] overflow-hidden border-s shadow-xl"
            >
              <div className="border-border flex shrink-0 items-center justify-between border-b px-5 py-3">
                <h2 className="text-fg min-w-0 flex-1 truncate text-sm font-semibold">
                  {messages.find((m) => m.role === 'user')?.content || t('chat.timeline.title')}
                </h2>
                <span
                  className={cn(
                    'ms-3 inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
                    chatMode === 'workflow'
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border text-muted'
                  )}
                >
                  {chatMode === 'workflow' ? (
                    <WorkflowSquare03Icon size={11} />
                  ) : (
                    <BubbleChatIcon size={11} />
                  )}
                  {t(
                    chatMode === 'workflow' ? 'chat.modePicker.workflow' : 'chat.modePicker.single'
                  )}
                </span>
                <span className="text-muted ms-3 shrink-0 text-[10px] tabular-nums">
                  {t('chat.timeline.eventCount', { count: timelineEventCount })}
                </span>
              </div>
              <TimelineList entries={displayTimeline} locale={locale} />
            </aside>
          </div>,
          document.body
        )}
      {visible &&
        filesOpen &&
        presentFiles.length > 0 &&
        createPortal(
          <div
            role="presentation"
            onClick={() => setFilesOpen(false)}
            className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
          >
            <aside
              role="dialog"
              aria-modal="true"
              onClick={(e) => e.stopPropagation()}
              className="wf-sheet-panel-end border-border bg-surface absolute inset-y-0 inset-e-0 flex w-[80vw] max-w-full flex-col max-sm:w-[92vw] overflow-hidden border-s shadow-xl"
            >
              <div className="border-border flex shrink-0 items-center justify-between border-b px-5 py-3">
                <h2 className="text-fg min-w-0 flex-1 truncate text-sm font-semibold">
                  {t('chat.files.title')}
                </h2>
                <span
                  className={cn(
                    'ms-3 inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
                    chatMode === 'workflow'
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border text-muted'
                  )}
                >
                  {chatMode === 'workflow' ? (
                    <WorkflowSquare03Icon size={11} />
                  ) : (
                    <BubbleChatIcon size={11} />
                  )}
                  {t(
                    chatMode === 'workflow' ? 'chat.modePicker.workflow' : 'chat.modePicker.single'
                  )}
                </span>
                <span className="text-muted ms-3 shrink-0 text-[10px] tabular-nums">
                  {t('chat.files.fileCount', { count: presentFiles.length })}
                </span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5 py-4 max-sm:px-3">
                <AttachmentList attachments={presentFiles} variant="grid" />
              </div>
            </aside>
          </div>,
          document.body
        )}
    </main>
  )
}

function relativeTime(ts: number, locale: string): string {
  const diff = Date.now() - ts
  const s = Math.floor(diff / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)

  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
    if (d > 0) return rtf.format(-d, 'day')
    if (h > 0) return rtf.format(-h, 'hour')
    if (m > 0) return rtf.format(-m, 'minute')
    if (s < 5) return rtf.format(0, 'second') // "now" / "الآن"
    return rtf.format(-s, 'second')
  } catch {
    if (d > 0) return `${d}d ago`
    if (h > 0) return `${h}h ago`
    if (m > 0) return `${m}m ago`
    if (s < 5) return 'just now'
    return `${s}s ago`
  }
}

const TIMELINE_KIND_COLOR: Record<string, string> = {
  'turn.started': 'bg-accent',
  'context.built': 'bg-sky-500',
  'llm.response': 'bg-indigo-500',
  'tool.called': 'bg-blue-500',
  'tool.completed': 'bg-emerald-500',
  'tool.failed': 'bg-red-500',
  'safety.allowed': 'bg-emerald-500',
  'safety.blocked': 'bg-red-500',
  'safety.approved': 'bg-emerald-500',
  'safety.denied': 'bg-amber-500',
  'compaction.started': 'bg-blue-500',
  'compaction.applied': 'bg-violet-500',
  'task.created': 'bg-sky-500',
  'task.stepCompleted': 'bg-emerald-500',
  'task.completed': 'bg-emerald-500',
  'task.failed': 'bg-red-500',
  'task.stopped': 'bg-amber-500',
  'segment.tool_call': 'bg-blue-500',
  'segment.workflow': 'bg-primary',
  'segment.tool_result': 'bg-violet-500',
  'segment.compaction': 'bg-violet-500'
}

function CompactionStartedCard({
  messagesCount,
  targetsCount,
  tokenCount,
  tokenBudget,
  startedAt
}: {
  messagesCount: number
  targetsCount: number
  tokenCount: number
  tokenBudget: number
  startedAt: number
}): React.JSX.Element {
  const { t } = useTranslation()
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(id)
  }, [])
  const elapsedMs = now - startedAt
  return (
    <div className="border-border bg-surface w-full max-w-[85%] max-sm:max-w-full self-start rounded-2xl border px-4 py-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center rounded-full bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-600 animate-pulse dark:text-blue-400">
          {t('chat.compactionCard.title')}
        </span>
        <span className="text-muted shrink-0 text-xs tabular-nums">
          {formatCompactionElapsed(elapsedMs)}
        </span>
      </div>
      <p className="text-muted mt-1 text-xs">
        {t('chat.compactionCard.compacting', {
          targets: targetsCount,
          messages: messagesCount,
          current: formatCompact(tokenCount),
          limit: formatCompact(tokenBudget)
        })}
      </p>
    </div>
  )
}

function formatCompactionElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const totalSeconds = ms / 1000
  if (totalSeconds < 60) return `${totalSeconds.toFixed(totalSeconds < 10 ? 1 : 0)}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.floor(totalSeconds % 60)
  return `${minutes}m ${seconds}s`
}

// Per-turn aggregates mirrored from the live token state (see turnStatsRef)
// so terminal timeline entries can report end-of-turn totals. `worker` and
// `summary` itemize side-spend (workflow agents, compaction/summarizer
// calls) so it never pollutes the brain's meter or counters but still counts
// toward the conversation's all-time totals.
type TurnStats = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  contextTokens: number
  apiCalls: number
  apiMs: number
  toolCalls: number
  worker: {
    turns: number
    calls: number
    cost: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
  }
  summary: {
    calls: number
    cost: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
  }
}

// Sentinel for meter readings restored from legacy `contextMeter` snapshots
// (no model stamp). Never equals a real model name, so the capabilities
// effect won't swap the denominator under an unknown-provenance numerator.
// Normalized back to null at persist time.
const LEGACY_METER_MODEL = '\u0000legacy'

function emptyTurnStats(): TurnStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    contextTokens: 0,
    apiCalls: 0,
    apiMs: 0,
    toolCalls: 0,
    worker: {
      turns: 0,
      calls: 0,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0
    },
    summary: {
      calls: 0,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0
    }
  }
}

// Compact display snapshot of the live turn's side-spend for the meter card.
function sideSpendOf(stats: TurnStats): SideSpend | null {
  const w = stats.worker
  const s = stats.summary
  if (w.calls === 0 && w.turns === 0 && s.calls === 0) return null
  return {
    workerTurns: w.turns,
    workerCalls: w.calls,
    workerTokens: w.inputTokens + w.outputTokens,
    workerCost: w.cost,
    summaryCalls: s.calls,
    summaryTokens: s.inputTokens + s.outputTokens,
    summaryCost: s.cost
  }
}

const EMPTY_ALL_TIME: ConversationStats['allTime'] = {
  processingMs: 0,
  apiMs: 0,
  turns: 0,
  apiCalls: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  cost: 0
}

// Render a duration in seconds — never raw milliseconds. Sub-ten-second
// values keep one decimal ("0.3s", "9.4s") so short turns stay legible;
// past a minute we roll up into m/s and h/m because "1m 49s" scans far
// better than "109s" (108679ms → "1m 49s").
function formatDuration(ms: number): string {
  const totalSec = ms / 1000
  if (totalSec < 10) return `${totalSec.toFixed(1)}s`
  // Round to whole seconds first so the m/s split can never yield "1m 60s".
  const rounded = Math.round(totalSec)
  if (rounded < 60) return `${rounded}s`
  const min = Math.floor(rounded / 60)
  const sec = rounded % 60
  if (min < 60) return sec === 0 ? `${min}m` : `${min}m ${sec}s`
  const hr = Math.floor(min / 60)
  const remMin = min % 60
  return remMin === 0 ? `${hr}h` : `${hr}h ${remMin}m`
}

// A composer-footer chip for a sheet that has a count: icon + number, no
// text. Zero renders nothing at all — there is no sheet worth opening behind
// an empty log or file list, and a greyed-out chip only advertises that
// absence. The chip joins the row when the first event or file lands.
function SheetCountButton({
  icon,
  count,
  label,
  countLabel,
  onOpen
}: {
  icon: ReactNode
  count: number
  label: string
  /** Pluralized "N events" / "N files" — the count for screen readers. */
  countLabel: string
  onOpen: () => void
}): React.JSX.Element | null {
  if (count === 0) return null
  return (
    <button
      type="button"
      onClick={onOpen}
      title={label}
      aria-label={`${label} (${countLabel})`}
      className={cn(
        // The same frame the ContextMeter wears beside it: 28px tall, 8px
        // radius, a 1px stroke in the border token and no fill — its
        // SquareFrame is literally `fill="none"` stroked in `text-border`,
        // and both utilities read the one `--color-border`, so the two match
        // in either theme. The hover wash is the single departure: unlike the
        // meter's hover-card trigger these chips actually click, so they keep
        // the affordance the meter has no use for.
        'flex h-7 shrink-0 items-center gap-1 rounded-lg border border-border px-1.5',
        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        'text-muted hover:text-fg hover:bg-border/40 cursor-pointer'
      )}
    >
      {icon}
      <span className="text-[10px] font-medium leading-none tabular-nums" dir="ltr">
        {count}
      </span>
    </button>
  )
}

// The working-folder control: a bordered card that reveals the folder list on
// hover and pins it open on click — the same hover(150ms)/pin/Escape/outside-
// click model as the context meter. With no folders yet it is a plain "select
// folder" button (click opens the picker). The parent keys this by conversation
// id, so it remounts (popover reset) when the conversation changes.
function WorkingFolderButton({
  folders,
  onAdd,
  onRemove,
  removeDisabled
}: {
  folders: string[]
  onAdd: () => void
  onRemove: (folder: string) => void
  // Mid-turn (queue mode) the picker stays open for business — only the
  // per-folder delete locks, so a queued prompt can gain a folder but the
  // running turn can never lose one out from under it.
  removeDisabled: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const hasFolders = folders.length > 0

  // Escape unpins/closes; clicking outside while open/pinned closes.
  useEffect(() => {
    if (!open && !pinned) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setPinned(false)
        setOpen(false)
      }
    }
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setPinned(false)
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open, pinned])

  useEffect(() => {
    return () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current)
    }
  }, [])

  const onEnter = (): void => {
    if (!hasFolders) return
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setOpen(true), 150)
  }
  const onLeave = (): void => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    if (pinned) return
    hoverTimer.current = setTimeout(() => setOpen(false), 200)
  }
  const cardVisible = (open || pinned) && hasFolders

  return (
    // Reference folders are a machine act and the phone composer row has no
    // space for them — desktop widths only.
    <div
      ref={rootRef}
      className="relative max-sm:hidden"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <button
        type="button"
        onClick={() => {
          if (!hasFolders) {
            onAdd()
            return
          }
          setPinned((p) => {
            const next = !p
            if (next) setOpen(true)
            return next
          })
        }}
        onFocus={onEnter}
        onBlur={onLeave}
        aria-expanded={cardVisible}
        title={hasFolders ? t('chat.workingFolder') : t('chat.selectFolder')}
        aria-label={hasFolders ? t('chat.workingFolder') : t('chat.selectFolder')}
        className={cn(
          'flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg',
          'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
          hasFolders
            ? 'bg-primary/10 text-primary hover:bg-primary/20'
            : 'text-muted hover:text-fg hover:bg-border/40'
        )}
      >
        <Folder01Icon size={16} />
      </button>
      {cardVisible && (
        <div className="border-border bg-surface text-fg absolute bottom-full inset-e-0 z-20 mb-2 rounded-lg border px-2 py-2 text-xs shadow-md min-w-50 max-w-70">
          <div className="text-muted mb-1.5 text-[10px] font-medium uppercase tracking-wide whitespace-nowrap">
            {t('chat.workingFolder')}
          </div>
          <div dir="ltr" className="space-y-1.5">
            {folders.map((folder) => (
              <div key={folder} className="space-y-0.5">
                <div className="truncate text-xs" title={folder}>
                  {folder.split('/').pop()}
                </div>
                <div className="flex items-center gap-1">
                  <code
                    className="border-border bg-bg text-muted block min-w-0 flex-1 truncate rounded border px-1 py-0.5 font-mono text-[9px]"
                    title={folder}
                  >
                    {folder}
                  </code>
                  <button
                    type="button"
                    onClick={() => onRemove(folder)}
                    disabled={removeDisabled}
                    className={cn(
                      'text-muted/40 shrink-0',
                      'enabled:hover:text-red-500 enabled:cursor-pointer',
                      'disabled:cursor-not-allowed disabled:opacity-40'
                    )}
                    title={removeDisabled ? t('chat.removeFolderBusy') : t('chat.removeFolder')}
                    aria-label={t('chat.removeFolder')}
                  >
                    <Delete02Icon size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={onAdd}
            className="text-muted hover:text-fg mt-1.5 flex w-full cursor-pointer items-center gap-1 text-[10px]"
          >
            <PlusSignIcon size={10} />
            {t('chat.addMore')}
          </button>
        </div>
      )}
    </div>
  )
}

function TimelineList({
  entries,
  locale
}: {
  entries: TimelineEntry[]
  locale: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const endRef = useRef<HTMLDivElement>(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 5_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries.length])

  if (entries.length === 0) {
    return (
      <div className="text-muted/50 flex items-center justify-center py-8 text-xs">
        {t('heartbeat.overlay.waiting')}
      </div>
    )
  }

  // Number only real events (skip turn-boundary dividers) so the badges stay
  // contiguous — 1, 2, 3… — across every turn in the accumulated log.
  let running = 0
  const eventNumbers = entries.map((e) => (e.kind === 'turn.started' ? 0 : ++running))

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-5 py-3 max-sm:px-3">
      <div className="flex flex-col gap-1">
        {entries.map((entry, i) => {
          const isLast = i === entries.length - 1
          // A turn boundary renders as a labeled divider, not a numbered row —
          // it visually groups the events that follow into one turn.
          if (entry.kind === 'turn.started') {
            return (
              <div key={entry.id} className="mt-3 flex items-center gap-2 first:mt-0">
                <span className="bg-border/60 h-px flex-1" />
                <span
                  dir="auto"
                  className="text-muted/60 max-w-[75%] shrink truncate text-[10px] font-medium"
                >
                  {entry.summary || t('chat.timeline.event.turn.started')}
                </span>
                <span className="bg-border/60 h-px flex-1" />
              </div>
            )
          }
          const color = TIMELINE_KIND_COLOR[entry.kind] ?? 'bg-muted/40'
          const label = t(`chat.timeline.event.${entry.kind}`, { defaultValue: entry.kind })
          const timeStr = relativeTime(entry.timestamp, locale)
          const content =
            entry.summary || entry.detail
              ? [entry.summary, entry.detail].filter(Boolean).join('\n')
              : null
          return (
            <div
              key={entry.id}
              className={cn(
                'rounded-lg px-3 py-2 text-xs',
                isLast ? 'text-fg bg-accent/5' : 'text-muted/70'
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[9px] font-semibold tabular-nums',
                    isLast ? `${color} text-white` : 'bg-muted/15 text-muted/50',
                    entry.kind === 'compaction.started' && 'animate-pulse'
                  )}
                >
                  {eventNumbers[i]}
                </span>
                <span className="font-semibold">{label}</span>
                {entry.kind === 'compaction.started' && (
                  <span className="text-blue-500 animate-pulse text-[10px]">●</span>
                )}
                <span className="flex-1" />
                <span className="text-muted/40 shrink-0 text-[10px] tabular-nums">{timeStr}</span>
              </div>
              {content && (
                <div className="group/tl relative mt-1.5 ms-4">
                  <pre
                    dir="ltr"
                    className={cn(
                      'overflow-x-auto rounded-md border px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap wrap-break-word',
                      isLast
                        ? 'bg-bg border-border text-fg/80'
                        : 'bg-bg/50 border-border/50 text-muted/50'
                    )}
                  >
                    {content}
                  </pre>
                  <div className="absolute right-1.5 top-1.5 opacity-0 group-hover/tl:opacity-100">
                    <CopyButton text={content} />
                  </div>
                </div>
              )}
            </div>
          )
        })}
        <div ref={endRef} />
      </div>
    </div>
  )
}

// A turn-boundary divider. The timeline accumulates across every turn of the
// conversation (see the send paths — we no longer wipe it per turn), so each
// user prompt seeds one of these to separate one turn's events from the next.
function makeTurnBoundary(text: string): TimelineEntry {
  const clean = text.trim().replace(/\s+/g, ' ')
  return {
    id: `turn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
    kind: 'turn.started',
    ...(clean ? { summary: clean.length > 140 ? `${clean.slice(0, 140)}…` : clean } : {})
  }
}

function buildSegmentTimelineEntry(segment: Segment): TimelineEntry | null {
  const segKind = segment.kind
  const ts = Date.now()
  if (segKind === 'workflow') {
    // One line, dot-separated, no detail — mirrors the drawer's other rows.
    const snap = segment.snapshot
    const activePhase = snap.phases.find((p) => p.status === 'active')?.title
    const line = [
      snap.status,
      activePhase ?? null,
      `${snap.totals.agents} agent${snap.totals.agents === 1 ? '' : 's'}`,
      `${snap.totals.toolCalls} tool${snap.totals.toolCalls === 1 ? '' : 's'}`
    ]
      .filter(Boolean)
      .join(' · ')
    return {
      id: segment.segmentId,
      timestamp: ts,
      kind: 'segment.workflow',
      summary: line
    }
  }
  if (segKind === 'tool_call') {
    const args = segment.args
    const action =
      typeof args.command === 'string'
        ? args.command
        : typeof args.path === 'string'
          ? args.path
          : typeof args.query === 'string'
            ? args.query
            : null
    return {
      id: segment.segmentId,
      timestamp: ts,
      kind: `segment.${segKind}`,
      summary: segment.name,
      detail: action ?? (Object.keys(args).length > 0 ? JSON.stringify(args, null, 2) : undefined)
    }
  }
  if (segKind === 'tool_result') {
    const output = segment.output || segment.error || ''
    return {
      id: segment.segmentId,
      timestamp: ts,
      kind: `segment.${segKind}`,
      summary: segment.status,
      detail: output ? (output.length > 2000 ? output.slice(0, 2000) + '…' : output) : undefined
    }
  }
  if (segKind === 'compaction') {
    const lines = segment.details.map((d) => {
      const pct =
        d.originalChars > 0 ? Math.round((1 - d.compactedChars / d.originalChars) * 100) : 0
      return `${d.toolName ?? 'unknown'}: ${d.originalChars} → ${d.compactedChars} chars (${pct}% reduced)`
    })
    lines.unshift(
      `~${formatCompact(segment.tokensSaved)} tokens saved in ${formatDuration(segment.durationMs)}`
    )
    return {
      id: segment.segmentId,
      timestamp: ts,
      kind: `segment.${segKind}`,
      detail: lines.join('\n')
    }
  }
  return null
}

// Reconstruct a conversation's event log from its persisted messages. Channel-
// owned conversations (WhatsApp / Telegram) run their turns in the main
// process, which never writes a `timeline`, so the live-built one is empty on
// load. Walking the messages recovers the same shape the live path builds: one
// `turn.started` divider per user prompt, then a row per tool call / result
// (plus any workflow / compaction segments) via buildSegmentTimelineEntry.
// Timestamps come from the owning message so rows read the right times instead
// of "just now", and ids fall back to a positional key when a persisted
// segment carries none. Used only when there is no stored/live timeline, so
// in-app conversations keep their richer, event-sourced log.
function deriveTimelineFromMessages(messages: ChatMessage[]): TimelineEntry[] {
  const out: TimelineEntry[] = []
  messages.forEach((message, mi) => {
    if (message.role === 'user') {
      const clean = (message.content ?? '').trim().replace(/\s+/g, ' ')
      out.push({
        id: `derived_turn_${mi}`,
        timestamp: message.timestamp ?? 0,
        kind: 'turn.started',
        ...(clean ? { summary: clean.length > 140 ? `${clean.slice(0, 140)}…` : clean } : {})
      })
      return
    }
    message.segments.forEach((segment, si) => {
      const entry = buildSegmentTimelineEntry(segment)
      if (!entry) return
      out.push({
        ...entry,
        id: entry.id || `derived_${mi}_${si}`,
        timestamp: message.timestamp ?? entry.timestamp
      })
    })
  })
  return out
}

function timelineEventSummary(
  type: string,
  payload: Record<string, unknown>,
  turnStats?: TurnStats
): { summary?: string; detail?: string } {
  switch (type) {
    case 'context.built': {
      const count = typeof payload.tokenCount === 'number' ? payload.tokenCount : null
      const budget = typeof payload.tokenBudget === 'number' ? payload.tokenBudget : null
      const sections = Array.isArray(payload.sectionsIncluded)
        ? (payload.sectionsIncluded as string[]).join(', ')
        : null
      const lines: string[] = []
      if (count != null)
        lines.push(
          `Tokens: ${formatCompact(count)}${budget != null ? ` / ${formatCompact(budget)} budget` : ''}`
        )
      if (sections) lines.push(`Sections: ${sections}`)
      return { detail: lines.length > 0 ? lines.join('\n') : undefined }
    }
    case 'llm.response': {
      const inp = typeof payload.inputTokens === 'number' ? payload.inputTokens : 0
      const out = typeof payload.outputTokens === 'number' ? payload.outputTokens : 0
      const cache = typeof payload.cacheReadTokens === 'number' ? payload.cacheReadTokens : 0
      const cacheCreated =
        typeof payload.cacheCreationTokens === 'number' ? payload.cacheCreationTokens : 0
      const dur = typeof payload.durationMs === 'number' ? payload.durationMs : null
      const provider = typeof payload.provider === 'string' ? payload.provider : null
      const model = typeof payload.model === 'string' ? payload.model : null
      const role = typeof payload.role === 'string' ? payload.role : null
      const lines: string[] = []
      lines.push(`Input: ${formatCompact(inp)} tokens`)
      lines.push(`Output: ${formatCompact(out)} tokens`)
      if (cache > 0) lines.push(`Cache read: ${formatCompact(cache)} tokens`)
      if (cacheCreated > 0) lines.push(`Cache created: ${formatCompact(cacheCreated)} tokens`)
      if (provider) lines.push(`Provider: ${provider}`)
      if (model) lines.push(`Model: ${model}`)
      if (role && role !== 'brain') lines.push(`Role: ${role === 'worker' ? 'agent' : role}`)
      if (dur != null) lines.push(`Duration: ${formatDuration(dur)}`)
      const roleTag = role && role !== 'brain' ? ` (${role})` : ''
      return {
        summary: `${formatCompact(inp)} in / ${formatCompact(out)} out${roleTag}`,
        detail: lines.join('\n')
      }
    }
    case 'turn.usage': {
      const cost = typeof payload.cost === 'number' ? payload.cost : null
      const hitRate = typeof payload.cacheHitRate === 'number' ? payload.cacheHitRate : null
      const iterations = typeof payload.iterations === 'number' ? payload.iterations : null
      const toolCalls = typeof payload.toolCalls === 'number' ? payload.toolCalls : null
      const model = typeof payload.model === 'string' ? payload.model : null
      const role = typeof payload.role === 'string' ? payload.role : null
      const lines: string[] = []
      if (model) lines.push(`Model: ${model}`)
      if (cost != null) lines.push(`Cost: $${cost.toFixed(4)}`)
      if (hitRate != null) lines.push(`Cache hit: ${Math.round(hitRate * 100)}%`)
      if (iterations != null) lines.push(`Iterations: ${iterations}`)
      if (toolCalls != null) lines.push(`Tool calls: ${toolCalls}`)
      // 'worker' is the wire value for workflow-agent turns (legacy name).
      const roleTag = role === 'worker' ? 'agent · ' : ''
      const summaryParts: string[] = []
      if (cost != null) summaryParts.push(`$${cost.toFixed(4)}`)
      if (hitRate != null) summaryParts.push(`${Math.round(hitRate * 100)}% cached`)
      return {
        summary: `${roleTag}${summaryParts.join(' · ')}` || undefined,
        detail: lines.length > 0 ? lines.join('\n') : undefined
      }
    }
    case 'safety.blocked':
      return {
        detail:
          [
            typeof payload.tool === 'string' ? `Tool: ${payload.tool}` : null,
            typeof payload.reason === 'string' ? payload.reason : null
          ]
            .filter(Boolean)
            .join('\n') || undefined
      }
    case 'safety.allowed':
    case 'safety.approved':
    case 'safety.denied':
      return { detail: typeof payload.tool === 'string' ? payload.tool : undefined }
    case 'compaction.started': {
      const lines: string[] = []
      if (typeof payload.messagesCount === 'number')
        lines.push(`Messages: ${payload.messagesCount}`)
      if (payload.force) lines.push('Mode: forced (overflow recovery)')
      if (payload.progressive) lines.push('Mode: progressive (mid-iteration)')
      return { detail: lines.length > 0 ? lines.join('\n') : undefined }
    }
    case 'task.created': {
      const lines: string[] = []
      if (typeof payload.name === 'string') lines.push(payload.name)
      if (typeof payload.stepsTotal === 'number') lines.push(`Steps: ${payload.stepsTotal}`)
      return { detail: lines.length > 0 ? lines.join('\n') : undefined }
    }
    case 'task.stepCompleted':
      return {
        detail:
          typeof payload.step === 'number' && typeof payload.total === 'number'
            ? `Step ${payload.step}/${payload.total}`
            : undefined
      }
    case 'task.completed': {
      const lines: string[] = []
      if (typeof payload.durationMs === 'number')
        lines.push(`Duration: ${formatDuration(payload.durationMs)}`)
      // End-of-turn roll-up from the live token aggregates — only what was
      // actually recorded, so a no-LLM turn stays a bare duration line.
      if (turnStats) {
        if (turnStats.inputTokens > 0 || turnStats.outputTokens > 0)
          lines.push(
            `Tokens: ${formatCompact(turnStats.inputTokens)} in / ${formatCompact(turnStats.outputTokens)} out`
          )
        if (turnStats.cacheReadTokens > 0)
          lines.push(`Cache read: ${formatCompact(turnStats.cacheReadTokens)} tokens`)
        if (turnStats.contextTokens > 0)
          lines.push(`Context: ${formatCompact(turnStats.contextTokens)} tokens`)
      }
      return { detail: lines.length > 0 ? lines.join('\n') : undefined }
    }
    case 'task.failed':
      return { detail: typeof payload.error === 'string' ? payload.error : undefined }
    case 'task.stopped':
      return { detail: typeof payload.taskId === 'string' ? `Task: ${payload.taskId}` : undefined }
    default:
      return {}
  }
}

function useRelativeTime(ts: number | undefined): string | null {
  const { i18n } = useTranslation()
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!ts) return
    const id = setInterval(() => setTick((t) => t + 1), 30_000)
    return () => clearInterval(id)
  }, [ts])
  return ts ? relativeTime(ts, i18n.language) : null
}

type ChatItemProps = {
  message: ChatMessage
  t: (k: string, opts?: Record<string, unknown>) => string
  /** Every task list in its latest state — see Chat's todoLists memo. */
  todoLists: Map<string, TodoItem[]>
  awaitingApproval: boolean
  awaitingAsk: boolean
  onApprovalDecision: (id: string, decision: ApprovalDecision) => void
  onAskRespond: (askId: string, response: AskUserResponse) => void
  /** Present only on the last message when it's a failed turn and no turn is running. */
  onTryAgain?: (reason: string) => void
  /** Same gate; only the stalled card renders it (see ProviderErrorCard). */
  onContinue?: () => void
}

// Memoized so a streaming turn (or any parent state tick — token counters,
// timeline, awaiting flags) re-renders ONLY the rows that actually changed
// instead of the whole feed. appendSegment gives just the LAST message a new
// object identity, so during streaming this collapses N re-renders into 1.
const ChatItem = memo(
  function ChatItem({
    message,
    t,
    todoLists,
    awaitingApproval,
    awaitingAsk,
    onApprovalDecision,
    onAskRespond,
    onTryAgain,
    onContinue
  }: ChatItemProps): React.JSX.Element {
    if (message.role === 'user') {
      return (
        <UserBubble
          content={message.content}
          attachments={message.attachments}
          transcribing={message.transcribing}
          voicePrompt={message.voicePrompt}
          systemAside={message.systemAside}
          timestamp={message.timestamp}
          t={t}
        />
      )
    }
    return (
      <AssistantBubble
        message={message}
        todoLists={todoLists}
        awaitingApproval={awaitingApproval}
        awaitingAsk={awaitingAsk}
        onApprovalDecision={onApprovalDecision}
        onAskRespond={onAskRespond}
        onTryAgain={onTryAgain}
        onContinue={onContinue}
      />
    )
  },
  (prev, next) => {
    // Re-render only when this row's own inputs change. The callbacks are
    // useCallback-stable and message identity changes solely for the message
    // that was actually mutated (new segment, approval/ask update, status flip).
    if (prev.message !== next.message) return false
    if (prev.t !== next.t) return false
    // A todo_write anywhere in the conversation may resolve THIS row's card.
    if (prev.todoLists !== next.todoLists) return false
    if (prev.onApprovalDecision !== next.onApprovalDecision) return false
    if (prev.onAskRespond !== next.onAskRespond) return false
    // Flips between undefined and a stable callback as the row gains/loses
    // "last failed message while idle" status — must invalidate the memo.
    if (prev.onTryAgain !== next.onTryAgain) return false
    if (prev.onContinue !== next.onContinue) return false
    // awaitingApproval/awaitingAsk are GLOBAL booleans passed to every row but
    // only drive the streaming bubble's "Awaiting…" placeholder. Ignoring them
    // for non-streaming rows is what stops a mid-turn permission prompt from
    // re-rendering the entire conversation.
    if (next.message.role === 'assistant' && next.message.status === 'streaming') {
      return (
        prev.awaitingApproval === next.awaitingApproval && prev.awaitingAsk === next.awaitingAsk
      )
    }
    return true
  }
)

/**
 * The user's bubble — the top-level feed row, the pending mid-turn row at
 * the tail (with `footer`: a status line instead of copy + time) and the
 * delivered `user_message` segment inside the assistant card all draw
 * through this one component, so a message reads the same wherever it sits.
 */
function UserBubble({
  content,
  attachments,
  transcribing,
  voicePrompt,
  systemAside,
  timestamp,
  footer,
  t: tProp
}: {
  content: string
  attachments?: MessageAttachment[]
  transcribing?: boolean
  voicePrompt?: boolean
  /** The app spoke, not the person: a muted note instead of a bubble. */
  systemAside?: boolean
  timestamp?: number
  /** Replaces the copy + time footer (the pending row's status + withdraw). */
  footer?: ReactNode
  t?: (k: string, opts?: Record<string, unknown>) => string
}): React.JSX.Element {
  // ChatItem hands its `t` down so its memo re-renders on a locale change;
  // the segment-level and pending-row callers have none to pass.
  const { t: tHook } = useTranslation()
  const t = tProp ?? tHook
  // A voice note's own player IS the prompt on screen. The transcript is still
  // what `content` stores — history, titling and export all read it, and the
  // model still receives it as `<voice_note>` — but printing it back under the
  // player only repeats what the user just said out loud.
  const hasContent = content.length > 0 && !voicePrompt
  const hasAttachments = !!attachments && attachments.length > 0
  const timeLabel = useRelativeTime(timestamp)
  const showFooter = !transcribing && hasContent
  // After every hook: the app's own aside renders as a muted note, never as
  // the person's bubble.
  if (systemAside) {
    return (
      <div className="flex w-full justify-center py-1">
        <span className="text-muted text-xs italic">{t('errors.provider.systemAsideLabel')}</span>
      </div>
    )
  }
  return (
    <div className="flex w-full flex-col gap-1.5 items-end">
      {transcribing ? (
        <div className="bg-primary text-primary-fg max-w-[85%] max-sm:max-w-full rounded-2xl px-4 py-2.5 text-sm leading-relaxed wrap-break-word">
          <span className="animate-pulse">{t('chat.voice.transcribing')}</span>
        </div>
      ) : (
        hasContent && (
          <div
            data-select-root
            className="bg-primary text-primary-fg max-w-[85%] max-sm:max-w-full rounded-2xl px-4 py-2.5 text-sm leading-relaxed wrap-anywhere [&_h1]:text-inherit [&_h2]:text-inherit [&_h3]:text-inherit [&_h4]:text-inherit [&_code]:text-inherit [&_code]:bg-primary-fg/15 [&_pre_pre]:bg-primary-fg/10 [&_pre_pre]:text-inherit [&_pre_pre]:border-primary-fg/20 [&_a]:text-primary-fg [&_blockquote]:text-inherit [&_blockquote]:border-primary-fg/40 [&_table]:border-primary-fg/20 [&_th]:border-primary-fg/20 [&_td]:border-primary-fg/20 [&_thead]:bg-primary-fg/10 [&_hr]:border-primary-fg/30"
          >
            <Markdown content={content} />
          </div>
        )
      )}
      {hasAttachments && (
        <div className="flex w-full flex-col items-end gap-2">
          <AttachmentList attachments={attachments!} align="end" />
        </div>
      )}
      {footer !== undefined
        ? footer
        : showFooter && (
            <div className="flex items-center gap-1.5">
              <CopyButton
                text={content}
                variant="inline"
                ariaLabelKey="chat.copyMessage"
                className="px-2"
              />
              {timeLabel && (
                <span className="inline-flex items-center gap-1 text-xs text-muted">
                  <Clock01Icon size={14} />
                  {timeLabel}
                </span>
              )}
            </div>
          )}
    </div>
  )
}

/**
 * A mid-turn message the agent hasn't read yet, at the tail of the feed.
 * The same bubble as any user message, with a quiet status line and an X
 * that takes it back (into the draft, when this window sent it) in place
 * of the copy + time footer.
 */
function PendingInterjectionBubble({
  item,
  onWithdraw
}: {
  item: PendingInterjection
  onWithdraw: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <UserBubble
      content={item.text}
      attachments={item.attachments.length > 0 ? item.attachments : undefined}
      transcribing={item.transcribing}
      voicePrompt={item.voicePrompt}
      footer={
        <div className="text-muted flex items-center gap-1.5 text-xs">
          {/* A held row is NOT at the runner — promising it will be read at
              the next step would be a promise nothing in this process has
              made. It says what is actually true: it goes out when the turn
              in front of it finishes. */}
          <span>{t(item.holding ? 'chat.interject.holding' : 'chat.interject.pending')}</span>
          <button
            type="button"
            onClick={onWithdraw}
            title={t('chat.interject.withdraw')}
            aria-label={t('chat.interject.withdraw')}
            className="text-muted hover:text-fg focus-visible:ring-2 focus-visible:ring-accent flex h-5 w-5 cursor-pointer items-center justify-center rounded"
          >
            <CancelCircleIcon size={14} />
          </button>
        </div>
      }
    />
  )
}

function AssistantBubble({
  message,
  todoLists,
  awaitingApproval,
  awaitingAsk,
  onApprovalDecision,
  onAskRespond,
  onTryAgain,
  onContinue
}: {
  message: AssistantMessage
  todoLists: Map<string, TodoItem[]>
  awaitingApproval: boolean
  awaitingAsk: boolean
  onApprovalDecision: (id: string, decision: ApprovalDecision) => void
  onAskRespond: (askId: string, response: AskUserResponse) => void
  onTryAgain?: (reason: string) => void
  onContinue?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const verbose = useContext(InAppVerboseContext)
  const showReasoning = useContext(InAppReasoningContext)
  const isStreaming = message.status === 'streaming'
  const isError = message.status === 'error'
  const [typedText, setTypedText] = useState('')
  const wordsRef = useRef<string[]>([])

  useEffect(() => {
    const words = [...(t('chat.thinkingWords', { returnObjects: true }) as string[])]
    for (let i = words.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[words[i], words[j]] = [words[j], words[i]]
    }
    wordsRef.current = words
  }, [t])

  useEffect(() => {
    if (!isStreaming) return
    let wordIdx = 0
    let charIdx = 0
    let wait = 0
    let phase: 'typing' | 'pause' = 'typing'

    const id = setInterval(() => {
      const words = wordsRef.current
      const c = [...words[wordIdx % words.length]]

      if (phase === 'typing') {
        charIdx++
        setTypedText(c.slice(0, charIdx).join(''))
        if (charIdx >= c.length) {
          phase = 'pause'
          wait = 0
        }
      } else {
        if (++wait >= 40) {
          // 2s hold then next word
          wordIdx = (wordIdx + 1) % words.length
          charIdx = 0
          phase = 'typing'
        }
      }
    }, 50)

    return () => clearInterval(id)
  }, [isStreaming])
  const renderable = renderSegments(
    message.segments,
    message.approvals,
    message.asks,
    message.toolTimings,
    onApprovalDecision,
    onAskRespond,
    verbose,
    showReasoning,
    todoLists
  )
  const showThinking = isStreaming && renderable.empty
  const fullText = useMemo(() => collectText(message.segments), [message.segments])
  const showCopy = !isStreaming && !isError && fullText.length > 0
  const timeLabel = useRelativeTime(message.timestamp)

  if (isError && message.error) {
    const providerSeg = message.segments.find(
      (s): s is Extract<Segment, { kind: 'turn_end' }> =>
        s.kind === 'turn_end' && !!s.providerErrors?.length
    )
    if (providerSeg?.providerErrors?.length) {
      return (
        <div className="flex flex-col gap-1 items-start">
          <ProviderErrorCards
            failures={providerSeg.providerErrors}
            onTryAgain={onTryAgain}
            onContinue={onContinue}
          />
        </div>
      )
    }
    return (
      <div className="flex flex-col gap-1 items-start">
        <ProviderErrorCards
          failures={[
            {
              provider: 'unknown',
              providerLogo: '',
              statusCode: null,
              errorReason: message.error,
              errorDetail: null,
              retriesAttempted: 0,
              totalDurationMs: 0
            }
          ]}
          onTryAgain={onTryAgain}
          onContinue={onContinue}
        />
      </div>
    )
  }

  return (
    <div className="flex w-full flex-col gap-2 items-start">
      {showThinking ? (
        <div className="bg-surface border-border text-fg max-w-[85%] max-sm:max-w-full rounded-2xl border px-4 py-2.5 text-sm leading-relaxed wrap-break-word">
          <span className="text-muted italic">
            {awaitingApproval ? (
              <span className="animate-pulse">{t('chat.awaitingPermission')}</span>
            ) : awaitingAsk ? (
              <span className="animate-pulse">{t('chat.awaitingAnswer')}</span>
            ) : (
              <span className="animate-pulse">{typedText}…</span>
            )}
          </span>
        </div>
      ) : (
        renderable.blocks
      )}
      {showCopy && (
        <div className="flex items-center gap-1.5">
          <CopyButton
            text={fullText}
            variant="inline"
            ariaLabelKey="chat.copyMessage"
            className="px-2"
          />
          {timeLabel && (
            <span className="inline-flex items-center gap-1 text-xs text-muted">
              <Clock01Icon size={14} />
              {timeLabel}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

type RenderResult = { blocks: ReactNode; empty: boolean }

// The `ask` capability's single tool. Its tool_call renders as an interactive
// QuestionCard rather than a generic tool card.
const ASK_USER_TOOL = 'ask_user'

// The `options` capability's single tool. Its tool_call renders as a tabbed
// OptionsCard rather than a generic tool card — copy-and-paste content the
// model produced FOR the user, so it shows on the clean feed too.
const OFFER_OPTIONS_TOOL = 'offer_options'

function renderSegments(
  segments: Segment[],
  approvals: Record<string, ApprovalCardState> | undefined,
  asks: Record<string, AskCardState> | undefined,
  toolTimings: Record<string, ToolTiming> | undefined,
  onApprovalDecision: (id: string, decision: ApprovalDecision) => void,
  onAskRespond: (askId: string, response: AskUserResponse) => void,
  verbose: boolean,
  showReasoning: boolean,
  todoLists: Map<string, TodoItem[]> = new Map()
): RenderResult {
  const blocks: ReactNode[] = []
  let textBuffer = ''
  let textRun = 0
  let reasoningBuffer = ''
  let reasoningRun = 0
  // In-place reasoning (kind 'reasoning') supersedes the legacy turn_end copy:
  // when any exists in this message, the turn_end card is skipped or the final
  // iteration's thinking would render twice (broca dual-publishes it for the
  // mobile/CLI surfaces that only know turn_end).
  const hasReasoningSegments = segments.some((s) => s.kind === 'reasoning' && !s.worker)
  // Generic guard: every file path already rendered as a player/viewer in this
  // message. Prevents the same file showing twice when it's reachable from more
  // than one detector (e.g. a voice result that also matches the generic media
  // extractor). Rebuilt every render, so the per-render scope IS the TTL.
  const emittedFiles = new Set<string>()
  const drawnTodoLists = new Set<string>()
  const emitOnce = (filePath: string): boolean => {
    if (emittedFiles.has(filePath)) return false
    emittedFiles.add(filePath)
    return true
  }

  // A run of streamed thinking flushes as one ReasoningCard at its
  // true position — above the prose/tool activity that thinking produced. At
  // most one of textBuffer/reasoningBuffer is ever non-empty (each branch
  // flushes the other before accumulating), so flushText draining both below
  // can never reorder them.
  const flushReasoning = (): void => {
    // Thinking hidden (default): drop the run instead of carding it. Dropped
    // at the flush rather than at the segment so the buffer/ordering rules
    // above stay in one place.
    if (!showReasoning) {
      reasoningBuffer = ''
      return
    }
    if (reasoningBuffer.trim().length === 0) {
      reasoningBuffer = ''
      return
    }
    reasoningRun += 1
    blocks.push(<ReasoningCard key={`rs-${reasoningRun}`} content={reasoningBuffer} />)
    reasoningBuffer = ''
  }

  const flushTextOnly = (): void => {
    if (textBuffer.length === 0) return
    textRun += 1
    // A standalone wolffish-media image (e.g. a generated meme/GIF) renders as
    // a proper file card — filename + reveal/download — matching every other
    // attachment, instead of a bare floating photo.
    const mediaImage = textBuffer.trim().match(/^!\[[^\]]*\]\(wolffish-media:\/\/([^)]+)\)$/)
    if (mediaImage) {
      const relativePath = mediaImage[1]
      const mediaFileName = relativePath.split('/').pop() ?? 'image'
      const mediaExt = (mediaFileName.match(/\.[^./\\]+$/)?.[0] ?? '').toLowerCase()
      const mediaMime = `image/${mediaExt === '.jpg' ? 'jpeg' : mediaExt.slice(1) || 'png'}`
      blocks.push(
        <ImageViewer
          key={`md-${textRun}`}
          filePath={relativePath}
          fileExists={true}
          mimeType={mediaMime}
          fileName={mediaFileName}
        />
      )
      textBuffer = ''
      return
    }
    const bubble = (
      <div
        key={`md-${textRun}`}
        data-select-root
        className="bg-surface border-border text-fg max-w-[85%] max-sm:max-w-full rounded-2xl border px-4 py-2.5 text-sm leading-relaxed self-start wrap-anywhere"
      >
        <Markdown content={textBuffer} />
      </div>
    )
    blocks.push(bubble)
    textBuffer = ''
  }

  const flushText = (): void => {
    flushTextOnly()
    flushReasoning()
  }

  // Voice replies: a turn surfaces at most ONE voice_respond memo — the LAST
  // one. The model occasionally replies, then redoes the reply; only the final
  // voice_respond is the real answer, so earlier ones are superseded.
  // voice_generate ASSETS (isResponse:false) are unaffected and each render.
  // One O(n) index of tool results by call id so the loops below resolve a
  // call's result in O(1). Previously each tool_call re-scanned every segment
  // (findResult), making a render O(tool_calls × segments) — rebuilt on every
  // render and growing with each streaming delta, the dominant cost on
  // tool-heavy turns. First-match semantics preserved (don't overwrite).
  const resultByToolCall = new Map<string, ToolResultSegment>()
  for (const s of segments) {
    if (s.kind === 'tool_result' && !resultByToolCall.has(s.toolCallId))
      resultByToolCall.set(s.toolCallId, s)
  }

  let lastVoiceReplyId: string | null = null
  for (const s of segments) {
    if (s.kind !== 'tool_call') continue
    const r = resultByToolCall.get(s.toolCallId)
    const v = r?.status === 'success' ? parseVoiceResult(r.output) : null
    if (v?.isResponse) lastVoiceReplyId = s.toolCallId
  }

  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx]
    if (seg.kind === 'text') {
      // LEGACY: worker-tagged segments only exist in conversations persisted
      // by the removed Orchestrator mode — never render them (subagent output
      // was the master's input, not the user's; the workflow card is today's
      // subagent surface).
      if (seg.worker) continue
      // A pending thinking run preceded this prose — its card goes above.
      flushReasoning()
      textBuffer += seg.delta
    } else if (seg.kind === 'reasoning') {
      if (seg.worker) continue // LEGACY orchestrator-mode segments — see text branch
      // Prose already buffered belongs to the previous iteration — it goes
      // above this thinking run. Text only: draining the reasoning buffer here
      // would split one streamed run into a card per tick.
      flushTextOnly()
      reasoningBuffer += seg.delta
    } else if (seg.kind === 'workflow') {
      // The workflow card: one full-width, deterministic, collapsible block
      // per run. Snapshots are upserted by workflowId on append, so exactly
      // one segment (the latest state) exists per run — live and reloaded
      // conversations render identically.
      flushText()
      blocks.push(<WorkflowCard key={`wf-${seg.snapshot.workflowId}`} snapshot={seg.snapshot} />)
    } else if (seg.kind === 'task') {
      // The generic async-task card (video generation today): one
      // deterministic card per task, upserted by taskId on append (live) and
      // folded from task:changed pushes after the turn ends. Renders
      // regardless of verbose — like the chart card, it is output FOR the
      // user, not tool mechanics.
      flushText()
      blocks.push(<TaskCard key={`task-${seg.snapshot.taskId}`} snapshot={seg.snapshot} />)
    } else if (seg.kind === 'countdown') {
      // The turn-end countdown card: one per countdown, upserted by
      // countdownId on append (the `armed` state, live) and folded from
      // countdown:changed pushes after the turn ends. Output FOR the user —
      // renders regardless of verbose, like the task card.
      flushText()
      blocks.push(
        <CountdownCard key={`countdown-${seg.snapshot.countdownId}`} snapshot={seg.snapshot} />
      )
    } else if (seg.kind === 'process') {
      // The live process card the model chose to show: one per cardId,
      // upserted on append and folded from process:cardChanged pushes after
      // the turn ends. Output FOR the user — renders regardless of verbose.
      flushText()
      blocks.push(<ProcessCard key={`process-${seg.snapshot.cardId}`} snapshot={seg.snapshot} />)
    } else if (seg.kind === 'wait') {
      // The blocking-wait card: one per wait, upserted by waitId, carrying
      // its own input while it runs. Output FOR the user — it renders
      // regardless of verbose, like the task and countdown cards: a turn
      // that went quiet with no explanation reads as a hang.
      flushText()
      blocks.push(<WaitCard key={`wait-${seg.snapshot.waitId}`} snapshot={seg.snapshot} />)
    } else if (seg.kind === 'browser') {
      // A page in Wolffish's own browser: one live card per page, upserted by
      // tabId on append and folded from browser:changed pushes after the turn
      // ends. Output FOR the user — renders regardless of verbose; the whole
      // point is that they can see it.
      flushText()
      blocks.push(
        <BrowserCard key={`browser-${browserKey(seg.snapshot)}`} snapshot={seg.snapshot} />
      )
    } else if (seg.kind === 'todo') {
      // The model's task list: one checklist card per LIST, at the turn that
      // created it, in its latest state — a later turn's write that continues
      // the list (listId ≠ turnId) resolves this card in place and draws
      // nothing of its own. Output FOR the user — renders on the clean feed.
      // drawnTodoLists: conversations saved before every accumulator upserted
      // todo segments hold one per write (a heartbeat run saved 138).
      if (todoListId(seg) !== seg.turnId || drawnTodoLists.has(seg.turnId)) continue
      drawnTodoLists.add(seg.turnId)
      flushText()
      blocks.push(
        <TodoCard key={`todo-${seg.turnId}`} items={todoLists.get(seg.turnId) ?? seg.items} />
      )
    } else if (seg.kind === 'user_message') {
      // A message the user sent mid-turn, at the exact point the agent read
      // it. Output FROM the user — always visible, clean feed included, and
      // never folded into the prose around it: the bubble before it closes
      // here and the next text segment opens a new one after.
      flushText()
      blocks.push(
        <UserBubble
          key={`um-${seg.segmentId}`}
          content={seg.text}
          attachments={seg.attachments}
          voicePrompt={seg.voicePrompt}
          timestamp={seg.timestamp}
        />
      )
    } else if (seg.kind === 'tool_call') {
      if (seg.worker) continue // LEGACY orchestrator-mode segments — see text branch
      flushText()
      // The master's workflow tools never render as chips (even in verbose) —
      // the workflow card above is their surface; their segments still
      // persist and replay so the master keeps its agent reports across
      // turns.
      if (WORKFLOW_TOOL_NAMES.has(seg.name)) continue
      const result = resultByToolCall.get(seg.toolCallId)

      // ask_user renders a dedicated interactive question card instead of a
      // tool card — always visible (the user must be able to answer), even
      // on the clean feed. Rendered while pending (live ask state) and after
      // answering (the tool_result). Skip everything else for this call.
      if (seg.name === ASK_USER_TOOL) {
        const ask = asks?.[seg.toolCallId]
        if (ask || result) {
          blocks.push(
            <QuestionCard
              key={`ask_${seg.segmentId}`}
              args={seg.args}
              result={result}
              ask={ask}
              onRespond={onAskRespond}
            />
          )
        }
        continue
      }

      // offer_options renders its tabbed copy-and-paste card from the call's
      // args alone — there is no answer and no live state, so it draws the
      // instant the call lands and identically forever after. Always visible,
      // clean feed included: like a delivered file or a PathCard it is a
      // deliberate model act, not tool mechanics. Skip everything else for
      // this call (the result is a one-line confirmation for the model).
      if (seg.name === OFFER_OPTIONS_TOOL) {
        blocks.push(<OptionsCard key={`options_${seg.segmentId}`} args={seg.args} />)
        continue
      }

      const approval = approvals?.[seg.toolCallId]
      const timing = toolTimings?.[seg.toolCallId]

      const voiceData = result?.status === 'success' ? parseVoiceResult(result.output) : null
      // An stt_* result's filePath is the user's SOURCE recording (an input),
      // never a deliverable — don't echo it back as an audio card.
      const isSttResult = (seg.name ?? '').startsWith('stt_')

      // Clean feed (verbose off): the tool-activity card is dropped entirely —
      // successful, failed, AND denied calls alike. The clean feed relays only
      // what the model produces FOR the user: prose plus the file viewers and
      // location cards below (send_file's [wolffish-output:] / show_path's
      // [wolffish-path:] markers), which render in their own branches
      // regardless of this flag. Tool mechanics, including failures, are
      // verbose-only. Mirrors the channel renderSegment rules. (The model
      // still sees every result — segment.output replays into its context;
      // this gate is purely what the UI shows.)
      // The code tools are the one exception: an edit, a write or a shell run
      // is a change the user can see in their project, so the clean feed
      // shows it as a compact activity row (status, file or command, +N −M
      // or exit code) expandable to the diff or output — never hidden.
      const cardVisible = verbose || CODE_ACTIVITY_TOOLS.has(seg.name)

      if (voiceData) {
        if (cardVisible) {
          blocks.push(
            <ToolCard
              key={seg.segmentId}
              call={seg}
              result={result}
              timing={timing}
              compact={!verbose}
            />
          )
        }
        // Render every voice_generate asset, but for the voice_respond REPLY
        // only the final one — a redone reply must not show as a second memo.
        const supersededReply = voiceData.isResponse && seg.toolCallId !== lastVoiceReplyId
        if (!supersededReply) {
          blocks.push(
            <AudioPlayer
              key={`voice_${seg.segmentId}`}
              source="voice"
              filePath={voiceData.filePath}
              fileExists={true}
              mimeType="audio/mpeg"
              fileName={voiceData.fileName}
            />
          )
        }
      } else if (approval) {
        // Approval cards always render — the user must be able to act on a
        // pending tool call regardless of the verbose preference.
        blocks.push(
          <ApprovalCard
            key={`appr_${seg.segmentId}`}
            state={approval}
            onDecision={(d) => onApprovalDecision(approval.approvalId, d)}
          />
        )
        if (approval.decision !== undefined && cardVisible) {
          blocks.push(
            <ToolCard
              key={seg.segmentId}
              call={seg}
              result={result}
              timing={timing}
              compact={!verbose}
            />
          )
        }
      } else if (cardVisible) {
        blocks.push(
          <ToolCard
            key={seg.segmentId}
            call={seg}
            result={result}
            timing={timing}
            compact={!verbose}
          />
        )
      }

      const fileContent = isFileContentResult(seg, result)
      const page = fileContent ? null : extractToolResultPage(seg, result)

      // File-content results (file_read/file_write/file_patch — the body of
      // the file named by args.path) render NOTHING, but still own their
      // branch: generating or touching a file is not delivering it — the model
      // shows a file only via its own send_file act (the [wolffish-output:]
      // marker paths below) — and marker text or paths quoted INSIDE file
      // content must never be mistaken for a delivery or earn a path card.
      // Fetched-page content is a rendering of routine successful output, not
      // a delivered file — the channel clean feed skips it, so we only show it
      // when verbose. It too owns its branch (no fall-through to the
      // delivered-file viewers, which never coincide).
      if (fileContent) {
        // Deliberately empty — file content is invisible in the feed.
      } else if (page) {
        if (verbose) {
          blocks.push(
            <PageViewer
              key={`page_${seg.segmentId}`}
              content={page.content}
              title={page.title}
              url={page.url}
              format={page.format}
            />
          )
        }
      } else {
        const imagePath = extractToolResultImage(result)
        if (imagePath) {
          const imgRelPath = imagePath.startsWith('wolffish-media://')
            ? imagePath
            : imagePath.replace(/^.*?\.wolffish\/workspace\//, '')
          const imgReachable = !imgRelPath.startsWith('/')
          const imgFileName = imagePath.split('/').pop() ?? 'image'
          const imgExt = (imagePath.match(/\.[^./\\]+$/) || [''])[0].toLowerCase()
          const imgMime = `image/${imgExt === '.jpg' ? 'jpeg' : imgExt.slice(1)}`
          if (emitOnce(imgRelPath)) {
            blocks.push(
              <ImageViewer
                key={`img_${seg.segmentId}`}
                filePath={imgRelPath}
                fileExists={imgReachable}
                mimeType={imgMime}
                fileName={imgFileName}
              />
            )
          }
        }

        const docResults = extractToolResultDocuments(result)
        if (docResults) {
          for (let di = 0; di < docResults.length; di++) {
            const doc = docResults[di]
            const fileName = doc.path.split('/').pop() ?? 'document'
            const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
            if (ext === 'pdf') {
              blocks.push(
                <PdfViewer
                  key={`doc_${seg.segmentId}_${di}`}
                  filePath={doc.path}
                  fileExists={true}
                  fileName={fileName}
                  sizeBytes={doc.size}
                />
              )
            } else if (ext === 'docx') {
              blocks.push(
                <DocxViewer
                  key={`doc_${seg.segmentId}_${di}`}
                  filePath={doc.path}
                  fileExists={true}
                  fileName={fileName}
                  sizeBytes={doc.size}
                />
              )
            } else if (ext === 'pptx' || ext === 'potx') {
              blocks.push(
                <PresentationViewer
                  key={`doc_${seg.segmentId}_${di}`}
                  filePath={doc.path}
                  fileExists={true}
                  fileName={fileName}
                  sizeBytes={doc.size}
                />
              )
            } else if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
              blocks.push(
                <SpreadsheetViewer
                  key={`doc_${seg.segmentId}_${di}`}
                  filePath={doc.path}
                  fileExists={true}
                  fileName={fileName}
                  sizeBytes={doc.size}
                />
              )
            } else if (ext === 'txt') {
              // Plain text delivered as a (document) renders the same inline
              // text card as .txt via the (file) catch-all.
              blocks.push(
                <MarkdownFileViewer
                  key={`doc_${seg.segmentId}_${di}`}
                  filePath={doc.path}
                  fileExists={true}
                  fileName={fileName}
                  sizeBytes={doc.size}
                  mimeType="text/plain"
                />
              )
            } else {
              blocks.push(
                <FileCard
                  key={`doc_${seg.segmentId}_${di}`}
                  filePath={doc.path}
                  fileExists={true}
                  fileName={fileName}
                  sizeBytes={doc.size}
                  mimeType={docMimeType(ext)}
                />
              )
            }
          }
        }

        // Skip the generic media extractor for voice_respond / voice_generate:
        // their audio already rendered as the dedicated voice player above, and
        // the same workspace path would otherwise match here and render a SECOND
        // player (a native <video> card when the file is webm). This is the
        // voice-"double" fix. emitOnce is the generic backstop for any other
        // overlap within a message.
        const media = voiceData || isSttResult ? null : extractToolResultMedia(result)
        if (media) {
          const mediaFileName = media.path.split('/').pop() ?? 'media'
          const mediaExt = (media.path.match(/\.[^./\\]+$/) || [''])[0].toLowerCase()
          const mediaMime =
            media.type === 'audio'
              ? `audio/${mediaExt === '.mp3' ? 'mpeg' : mediaExt.slice(1)}`
              : `video/${mediaExt === '.mov' ? 'quicktime' : mediaExt.slice(1)}`
          // Convert absolute workspace path to a relative path for the blob loader.
          // If the path is outside the workspace (e.g. /tmp/) the regex won't
          // match and relPath stays absolute — render with fileExists=false so
          // the player shows an "unavailable" placeholder.
          const relPath = media.path.replace(/^.*?\.wolffish\/workspace\//, '')
          const fileReachable = !relPath.startsWith('/')
          if (emitOnce(relPath)) {
            if (media.type === 'audio') {
              blocks.push(
                <AudioPlayer
                  key={`media_${seg.segmentId}`}
                  filePath={relPath}
                  fileExists={fileReachable}
                  mimeType={mediaMime}
                  fileName={mediaFileName}
                />
              )
            } else {
              blocks.push(
                <VideoPlayer
                  key={`media_${seg.segmentId}`}
                  filePath={relPath}
                  fileExists={fileReachable}
                  mimeType={mediaMime}
                  fileName={mediaFileName}
                />
              )
            }
          }
        }

        // Generic files (any extension) explicitly delivered via send_file —
        // render a file card with reveal/download, same as a non-previewable
        // attachment. send_file copies out-of-workspace files into files/ so
        // the absolute path is always reachable.
        const genericFiles = extractToolResultGenericFiles(result)
        for (let gi = 0; gi < genericFiles.length; gi++) {
          const gPath = genericFiles[gi]
          const gName = gPath.split('/').pop() ?? 'file'
          const gExt = gName.split('.').pop()?.toLowerCase() ?? ''
          // Markdown delivered via the (file) catch-all renders inline as rich
          // markdown — same card attachments use — instead of a bare file card.
          if (gExt === 'md' || gExt === 'mdx' || gExt === 'markdown') {
            blocks.push(
              <MarkdownFileViewer
                key={`file_${seg.segmentId}_${gi}`}
                filePath={gPath}
                fileExists={true}
                fileName={gName}
                sizeBytes={0}
                mimeType="text/markdown"
              />
            )
          } else if (gExt === 'txt') {
            // Plain text delivered via the (file) catch-all renders inline as a
            // line-numbered text card — same loader/viewer .md files use —
            // instead of a bare file card.
            blocks.push(
              <MarkdownFileViewer
                key={`file_${seg.segmentId}_${gi}`}
                filePath={gPath}
                fileExists={true}
                fileName={gName}
                sizeBytes={0}
                mimeType="text/plain"
              />
            )
          } else if (gExt === 'html' || gExt === 'htm') {
            // HTML delivered via the (file) catch-all renders inline as
            // highlighted source with a live, sandboxed preview on expand —
            // same card attachments use — instead of a bare file card.
            blocks.push(
              <HtmlFileViewer
                key={`file_${seg.segmentId}_${gi}`}
                filePath={gPath}
                fileExists={true}
                fileName={gName}
                sizeBytes={0}
                mimeType="text/html"
              />
            )
          } else {
            blocks.push(
              <FileCard
                key={`file_${seg.segmentId}_${gi}`}
                filePath={gPath}
                fileExists={true}
                fileName={gName}
                sizeBytes={0}
                mimeType={docMimeType(gExt)}
              />
            )
          }
        }

        // Interactive chart cards — `.chart.json` specs explicitly delivered
        // via send_file carry the (chart) marker (see the dataviz capability's
        // spec contract). Rendered on the clean feed too, like every delivered
        // file; a spec that fails to parse falls back to a plain file card
        // inside ChartCard itself.
        const chartFiles = extractToolResultCharts(result)
        for (let ci = 0; ci < chartFiles.length; ci++) {
          const cPath = chartFiles[ci]
          if (!emitOnce(cPath)) continue
          blocks.push(
            <ChartCard
              key={`chart_${seg.segmentId}_${ci}`}
              filePath={cPath}
              fileExists={true}
              fileName={cPath.split('/').pop() ?? 'chart.json'}
              sizeBytes={0}
              mimeType="application/json"
            />
          )
        }

        // Location cards the model explicitly pushed via show_path — the
        // [wolffish-path:] marker is their transport, mirroring send_file's
        // delivery markers. Always rendered (clean feed too): pushing an
        // openable folder/file location is a deliberate act FOR the user, not
        // tool mechanics. Nothing is ever parsed out of prose or incidental
        // tool output — no marker, no card. PathCard still verifies the path
        // on-device; a since-deleted path keeps its card (it WAS a real tool
        // call) with the button disabled and an "unavailable" note.
        const shownPaths = extractToolResultPaths(result)
        for (let pi = 0; pi < shownPaths.length; pi++) {
          blocks.push(
            <PathCard
              key={`path_${seg.segmentId}_${pi}`}
              path={shownPaths[pi].path}
              kind={shownPaths[pi].kind}
            />
          )
        }
      }
    } else if (seg.kind === 'tool_result') {
      // Already rendered alongside its tool_call.
      continue
    } else if (seg.kind === 'separator') {
      // Flush whatever text has accumulated into its own bubble, then
      // continue — the next text segment starts a new bubble.
      flushText()
    } else if (seg.kind === 'compaction_started') {
      // Clean feed: compaction is internal activity, not a result — hide it.
      if (!verbose) continue
      const hasCompletion = segments.some((s, j) => j > segIdx && s.kind === 'compaction')
      if (!hasCompletion) {
        flushText()
        blocks.push(
          <CompactionStartedCard
            key={seg.segmentId}
            messagesCount={seg.messagesCount}
            targetsCount={seg.targetsCount}
            tokenCount={seg.tokenCount}
            tokenBudget={seg.tokenBudget}
            startedAt={seg.startedAt}
          />
        )
      }
    } else if (seg.kind === 'compaction') {
      // Clean feed: compaction is internal activity, not a result — hide it.
      if (!verbose) continue
      flushText()
      blocks.push(
        <CompactionCard
          key={seg.segmentId}
          targetsCount={seg.targetsCount}
          tokensSaved={seg.tokensSaved}
          durationMs={seg.durationMs}
          details={seg.details}
        />
      )
    } else if (seg.kind === 'turn_end') {
      flushText()
      if (seg.providerErrors?.length) {
        blocks.push(<ProviderErrorCards key={seg.segmentId} failures={seg.providerErrors} />)
      } else if (seg.stopReason === 'error') {
        blocks.push(<TurnFooter key={seg.segmentId} stopReason={seg.stopReason} />)
      }
      // LEGACY: conversations persisted before in-place reasoning segments
      // carry the final iteration's thinking only here. When the message has
      // reasoning segments, this is a duplicate of the last one — skip it.
      if (showReasoning && seg.reasoningContent?.trim() && !hasReasoningSegments) {
        blocks.push(<ReasoningCard key={`r-${seg.segmentId}`} content={seg.reasoningContent} />)
      }
    }
  }

  flushText()

  return { blocks: <>{blocks}</>, empty: blocks.length === 0 }
}

function PendingAttachmentChip({
  attachment,
  onRemove
}: {
  attachment: MessageAttachment
  onRemove: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      className={cn(
        'border-border bg-surface text-fg flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs',
        'max-w-xs'
      )}
    >
      <span className="bg-primary/10 text-primary inline-flex h-5 items-center rounded px-1.5 text-[10px] font-medium uppercase tracking-wide">
        {attachment.type}
      </span>
      <span className="truncate" title={attachment.originalName}>
        {attachment.originalName}
      </span>
      <span className="text-muted shrink-0 tabular-nums text-[10px]">
        {formatBytesL(attachment.sizeBytes, t)}
      </span>
      <button
        type="button"
        onClick={onRemove}
        title="Remove"
        aria-label="Remove attachment"
        className="text-muted hover:text-fg focus-visible:ring-2 focus-visible:ring-accent shrink-0 cursor-pointer rounded"
      >
        <CancelCircleIcon size={14} />
      </button>
    </div>
  )
}

/**
 * The chip a file holds while it is being copied into the conversation's
 * uploads folder — same shape as the finished attachment chip so the swap at
 * the end doesn't jump. It carries no remove button: the copy is a main-side
 * operation with nothing to cancel, and it is over in a moment.
 */
function StagingAttachmentChip({ file }: { file: StagingFile }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      className={cn(
        'border-border bg-surface text-muted flex max-w-xs items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs'
      )}
      title={t('chat.upload.copyingFile', { name: file.name })}
    >
      <ProgressRing percent={file.percent} />
      <span className="truncate" dir="ltr">
        {file.name}
      </span>
      <span className="shrink-0 tabular-nums text-[10px]">
        {file.percent === null ? t('chat.upload.copying') : `${file.percent}%`}
      </span>
    </div>
  )
}

/**
 * 16px ring. A known percentage fills clockwise from the top; `null` (no
 * measurable transfer) spins a fixed arc instead. Strokes are currentColor
 * so the ring inherits the chip's accent without depending on stroke-*
 * utilities existing for the theme tokens.
 */
function ProgressRing({ percent }: { percent: number | null }): React.JSX.Element {
  const radius = 6
  const circumference = 2 * Math.PI * radius
  const filled = percent === null ? 25 : percent
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      aria-hidden
      className={cn('text-primary shrink-0', percent === null && 'animate-spin')}
    >
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        opacity=".2"
      />
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - filled / 100)}
        transform="rotate(-90 8 8)"
      />
    </svg>
  )
}

/** m:ss for a recording's length — shared by the recorder rows and the
 *  queued-take row (module scope so both can reach it). */
function formatRecTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

const DOCUMENT_EXTS_RE = /\.(?:pdf|docx?|xlsx?|pptx?|csv)$/i
const CODE_EXTS_RE =
  /\.(?:js|jsx|mjs|cjs|ts|tsx|vue|svelte|py|rb|rs|go|java|kt|kts|swift|c|cpp|h|hpp|cs|css|scss|less|sass|html|htm|xml|json|yaml|yml|toml|ini|conf|env|sh|bash|zsh|fish|bat|cmd|ps1|sql|graphql|gql|md|mdx|txt|log|php|lua|r|pl|dart|scala|groovy|proto|zig|ex|exs|erl|hs|clj|ml|dockerfile|makefile)$/i

const DOC_MIME_MAP: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv'
}

function docMimeType(ext: string): string {
  return DOC_MIME_MAP[ext] ?? 'application/octet-stream'
}

type ToolCallSegment = Extract<Segment, { kind: 'tool_call' }>

// A tool result whose entire output is a `[wolffish-output: <path> (<type>)]`
// delivery marker is a file *delivery*, not file *content* — the path-keyed
// viewers (image/doc/media/generic) own those. send_file accepts both `file`
// and `path` args, so a `{path: 'report.md'}` mis-call would otherwise be
// classified as file content below and its delivery would never render.
const DELIVERY_MARKER_ONLY_RE =
  /^\[wolffish-output:\s*[^\]]+?\s+\((?:image|audio|video|document|file|chart)\)\]$/

// show_path's transport gets the same guard: its `path` arg may name a code
// file whose LOCATION is being shown, which must not classify as file content
// below (that branch renders nothing and would swallow the card).
const PATH_MARKER_ONLY_RE = /^\[wolffish-path:\s*[^\]]+\]$/

/**
 * True when a successful tool result is the CONTENT of the code/text file
 * named by the call's `path` arg (file_read/file_write/file_patch). Such
 * results render nothing in the feed — a file is shown only via the model's
 * own send_file act — but they must still be recognized so marker text or
 * paths quoted inside file content are never treated as deliveries/cards.
 */
function isFileContentResult(call: ToolCallSegment, result?: ToolResultSegment): boolean {
  if (!result?.output || result.status !== 'success') return false
  const trimmed = result.output.trim()
  if (DELIVERY_MARKER_ONLY_RE.test(trimmed) || PATH_MARKER_ONLY_RE.test(trimmed)) return false
  const argsPath = typeof call.args?.path === 'string' ? call.args.path : null
  return argsPath != null && CODE_EXTS_RE.test(argsPath)
}

function extractToolResultImage(result?: ToolResultSegment): string | null {
  if (!result?.output || result.status !== 'success') return null
  // MARKER-ONLY by design: the [wolffish-output: path (image)] marker is
  // send_file's transport — the model's own explicit delivery act. Bare
  // workspace paths, {path} JSON and media_url fields are mere generation
  // (a screenshot tool naming its output file); the harness never delivers
  // a file the model didn't send. Line-anchored (here and in every delivery
  // extractor below): a real marker stands on its own line — send_file emits
  // it as the whole output — while a result that merely QUOTES the marker
  // template mid-line (a grep/cat over code or docs that mention it) must
  // never mint a phantom viewer for a placeholder path.
  const marker = result.output.match(
    /^[ \t]*\[wolffish-output:[ \t]*([^\]\n]+?)[ \t]+\(image\)\][ \t]*$/m
  )
  return marker ? marker[1].trim() : null
}

/** Tools whose successful output is a fetched web page worth rendering as a card. */
const PAGE_CONTENT_TOOLS = new Set(['browser_page_content', 'ext_read_page', 'web_fetch'])

/**
 * Extract a renderable web page from a page-content tool result. Returns the
 * page text plus whatever title/url metadata the tool exposed: ext_read_page
 * yields JSON `{content,url,title}`; browser_page_content yields raw text/HTML
 * (title sniffed from <title> when HTML); web_fetch carries its URL in args.
 */
function extractToolResultPage(
  call: ToolCallSegment,
  result?: ToolResultSegment
): { content: string; title: string | null; url: string | null; format: string } | null {
  if (!result?.output || result.status !== 'success') return null
  if (!PAGE_CONTENT_TOOLS.has(call.name)) return null
  const raw = result.output.trim()
  if (!raw) return null

  const argFormat = typeof call.args?.format === 'string' ? call.args.format : null
  const argUrl = typeof call.args?.url === 'string' ? call.args.url : null

  if (call.name === 'ext_read_page') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed.content === 'string') {
        return {
          content: parsed.content,
          title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title : null,
          url: typeof parsed.url === 'string' && parsed.url.trim() ? parsed.url : null,
          format: argFormat ?? 'text'
        }
      }
    } catch {
      /* not JSON — fall through and render the raw text */
    }
  }

  const format = argFormat ?? (call.name === 'web_fetch' ? 'markdown' : 'text')
  let title: string | null = null
  if (format === 'html') {
    const tm = raw.match(/<title[^>]*>([^<]+)<\/title>/i)
    if (tm) title = tm[1].trim()
  }
  return { content: raw, title, url: argUrl, format }
}

function extractToolResultDocuments(
  result?: ToolResultSegment
): { path: string; size: number }[] | null {
  if (!result?.output || result.status !== 'success') return null
  const output = result.output.trim()
  const docs: { path: string; size: number }[] = []
  const seen = new Set<string>()

  // MARKER-ONLY by design: the [wolffish-output: path (document)] marker is
  // send_file's transport — the model's own explicit delivery act. The old
  // {path}/{files:[{path}]} JSON detection is gone: a tool naming its output
  // file (e.g. browser_pdf returning {"path": …}) is mere generation, and
  // auto-attaching it delivered the file mid-turn before the model's own
  // send_file. Delivery is 100% the model's call.
  const markerRegex = /^[ \t]*\[wolffish-output:[ \t]*([^\]\n]+?)[ \t]+\(document\)\][ \t]*$/gm
  let marker: RegExpExecArray | null
  while ((marker = markerRegex.exec(output)) !== null) {
    const markerPath = marker[1].trim()
    if (DOCUMENT_EXTS_RE.test(markerPath) && !seen.has(markerPath)) {
      seen.add(markerPath)
      docs.push({ path: markerPath, size: 0 })
    }
  }

  return docs.length > 0 ? docs : null
}

/**
 * Extract an audio/video file path from tool result output. MARKER-ONLY by
 * design: the `[wolffish-output: /path (audio|video)]` marker is send_file's
 * transport — the model's own explicit delivery act. The old bare-workspace-
 * path fallback is gone: a tool naming a media file it generated is not a
 * delivery, and auto-rendering it overrode the model's send timing.
 */
function extractToolResultMedia(
  result?: ToolResultSegment
): { path: string; type: 'audio' | 'video' } | null {
  if (!result?.output || result.status !== 'success') return null
  const marker = result.output.match(
    /^[ \t]*\[wolffish-output:[ \t]*([^\]\n]+?)[ \t]+\((audio|video)\)\][ \t]*$/m
  )
  if (marker) {
    return { path: marker[1].trim(), type: marker[2] as 'audio' | 'video' }
  }
  return null
}

/**
 * Extract generic file paths explicitly delivered via send_file. These carry
 * a `[wolffish-output: /path (file)]` marker — the catch-all type for any
 * extension that isn't an image/audio/video/document. Only the explicit
 * marker is matched (no bare-path fallback) so incidental paths in tool
 * output are never mistaken for a delivery.
 */
function extractToolResultGenericFiles(result?: ToolResultSegment): string[] {
  if (!result?.output || result.status !== 'success') return []
  const paths: string[] = []
  const seen = new Set<string>()
  const markerRegex = /^[ \t]*\[wolffish-output:[ \t]*([^\]\n]+?)[ \t]+\(file\)\][ \t]*$/gm
  let match: RegExpExecArray | null
  while ((match = markerRegex.exec(result.output)) !== null) {
    const p = match[1].trim()
    if (!seen.has(p)) {
      seen.add(p)
      paths.push(p)
    }
  }
  return paths
}

/**
 * Extract chart specs explicitly delivered via send_file. These carry a
 * `[wolffish-output: /path (chart)]` marker — emitted for `*.chart.json`
 * files (the interactive chart-card spec; see the dataviz capability).
 * MARKER-ONLY like every delivery type above.
 */
function extractToolResultCharts(result?: ToolResultSegment): string[] {
  if (!result?.output || result.status !== 'success') return []
  const paths: string[] = []
  const seen = new Set<string>()
  const markerRegex = /^[ \t]*\[wolffish-output:[ \t]*([^\]\n]+?)[ \t]+\(chart\)\][ \t]*$/gm
  let match: RegExpExecArray | null
  while ((match = markerRegex.exec(result.output)) !== null) {
    const p = match[1].trim()
    if (!seen.has(p)) {
      seen.add(p)
      paths.push(p)
    }
  }
  return paths
}

/**
 * Extract folder/file locations the model explicitly pushed via show_path.
 * These carry a `[wolffish-path: /abs/path (folder|file)]` marker — the
 * model's own deliberate act, so the card renders on the clean feed too
 * (like delivered files). The type suffix is the path's kind AT CALL TIME:
 * it lets the card keep the right icon/labels after the path is deleted
 * (the live stat can no longer answer). MARKER-ONLY by design: paths merely
 * named in prose or incidental tool output never surface a card.
 */
function extractToolResultPaths(
  result?: ToolResultSegment
): { path: string; kind?: 'folder' | 'file' }[] {
  if (!result?.output || result.status !== 'success') return []
  const out: { path: string; kind?: 'folder' | 'file' }[] = []
  const seen = new Set<string>()
  const markerRegex =
    /^[ \t]*\[wolffish-path:[ \t]*([^\]\n]+?)(?:[ \t]+\((folder|file)\))?[ \t]*\][ \t]*$/gm
  let match: RegExpExecArray | null
  while ((match = markerRegex.exec(result.output)) !== null) {
    const p = match[1].trim()
    if (!seen.has(p)) {
      seen.add(p)
      out.push({ path: p, kind: match[2] as 'folder' | 'file' | undefined })
    }
  }
  return out
}

type DeliveredBucket = 'image' | 'audio' | 'video' | 'document' | 'file' | 'chart'

// Extension → media bucket, so a file path found anywhere (a tool arg, a
// marker) gets the right viewer. Kept intentionally broad — View Files is a
// "log of files", so anything with a real extension is fair game; unknown
// extensions fall through to the generic file card.
const IMAGE_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'heic',
  'heif',
  'avif',
  'tiff',
  'ico'
])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'wma'])
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'wmv', 'flv'])
const DOC_EXTS = new Set([
  'pdf',
  'doc',
  'docx',
  'ppt',
  'pptx',
  'xls',
  'xlsx',
  'csv',
  'tsv',
  'txt',
  'md',
  'markdown',
  'html',
  'htm',
  'rtf',
  'odt',
  'ods',
  'odp',
  'json',
  'xml',
  'yaml',
  'yml'
])

function extToBucket(filePath: string): DeliveredBucket {
  // wolffish-media:// refs carry no extension and are almost always images.
  if (filePath.startsWith('wolffish-media://')) return 'image'
  const base = filePath.split(/[\\/]/).pop() ?? ''
  // The chart-card spec suffix outranks the bare `.json` extension.
  if (base.toLowerCase().endsWith('.chart.json')) return 'chart'
  const ext = (base.match(/\.[^.]+$/)?.[0].slice(1) ?? '').toLowerCase()
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (DOC_EXTS.has(ext)) return 'document'
  return 'file'
}

// Arg KEYS whose value names a file path. An allowlist (not a value-only
// heuristic) is what keeps out the look-alikes that share the "ends in .ext"
// shape: gmail `account` (foo@gmail.com → ".com"), WhatsApp `jid` (…@g.us),
// CSS `selector` (div.a.b), `command`/`args` shell strings, memory `ref`. Only
// genuine path fields are read. Case-insensitive.
const FILE_PATH_ARG_KEYS = new Set([
  'path',
  'filepath',
  'file_path',
  'file',
  'output_path',
  'outputpath',
  'input_path',
  'inputpath',
  'dest',
  'destination',
  'dest_path',
  'save_path',
  'paths',
  'url'
])

// Tools that pull an EXISTING file's content into the transcript as reference.
// Their args are skipped: the file they name predates the conversation and
// belongs to whatever run produced it, so listing it here answers "what did
// the agent consult" when the sheet is asking "what does this conversation
// have". In practice these resolve to previous days' output — a digest run
// reads last week's PDFs and its ledger, and each one used to land in today's
// sheet as if today had made it.
//
// image_view deliberately is NOT in this set, though it also only reads. Its
// path is almost always something THIS run just made: the design manuals build
// a page, render it, and instruct the model to LOOK at the result before
// shipping, so it is the one structured signal for artifacts a shell script
// wrote — blog covers, chart PNGs, browser screenshots. Nothing else names
// those files anywhere in the conversation, so skipping it would drop real
// deliverables to spare the sheet some intermediate render proofs. Proofs at
// least get cleaned up, and useFilesOnDisk drops them when they do.
const CONTENT_READ_TOOLS = new Set([
  'file_read',
  'pdf_read',
  'pdf_info',
  'pdf_search',
  'archive_list',
  'skill_read_source'
])

// Decide whether a file-path arg value names a WORKSPACE file worth listing,
// and if so normalize it to the relative form AttachmentList resolves. Guards
// reject anything that can't render: prose / commands (metacharacters), URLs
// (any non-file scheme), out-of-workspace paths (a leading /, ~ or drive — only
// files under the workspace resolve), and values with no real (letter-led)
// extension. Absolute paths INSIDE the workspace are stripped to relative;
// file:// URLs are unwrapped + percent-decoded; wolffish-media:// is kept.
function normalizeFilePathArg(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let s = raw.trim()
  if (s.length === 0 || s.length > 512 || /[\n\r\t]/.test(s)) return null
  if (s.startsWith('wolffish-media://')) return s
  let wasFileUrl = false
  if (s.startsWith('file://')) {
    s = s.slice('file://'.length)
    wasFileUrl = true
  }
  // Any remaining scheme (http, https, data, ftp…) is not a local file.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null
  if (wasFileUrl) {
    try {
      s = decodeURIComponent(s)
    } catch {
      /* keep raw on malformed escapes */
    }
  }
  // Shell / query / email metacharacters never appear in a real file path but
  // are all over command strings, search queries, JIDs and emails.
  if (/["'`|<>;*?@]|&&/.test(s)) return null
  s = s.replace(/^.*?\.wolffish\/workspace\//, '')
  // After stripping the workspace prefix, anything still absolute (/, ~, C:\)
  // lives outside the workspace and can't be resolved/rendered — drop it.
  if (/^([/~]|[A-Za-z]:\\)/.test(s)) return null
  const base = s.split(/[\\/]/).pop() ?? ''
  // Letter-led extension so version-ish tokens ("v2.0", "1.5") don't qualify.
  if (!/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(base)) return null
  return s
}

// Pull the file paths out of a tool call's args — only from allowlisted path
// keys, and only string / string-array values (nested objects are skipped to
// bound surprises). This is what turns View Files into a complete log:
// producers (browser_pdf output_path, document_convert), channel send tools
// (telegram_send_document path) and file readers/writers all name their file in
// the args, and none leave a [wolffish-output:] marker.
function argFilePaths(args: Record<string, unknown> | undefined): string[] {
  if (!args) return []
  const out: string[] = []
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      const p = normalizeFilePathArg(v)
      if (p) out.push(p)
    } else if (Array.isArray(v)) {
      for (const item of v) visit(item)
    }
  }
  for (const [key, value] of Object.entries(args)) {
    if (FILE_PATH_ARG_KEYS.has(key.toLowerCase())) visit(value)
  }
  return out
}

// Fold an absolute path that lives inside the workspace down to the relative
// form user uploads and arg-scanned files use, so the SAME file collapses in
// dedup no matter which source named it: a marker delivery gives an absolute
// path (send_file emits `/…/.wolffish/workspace/files/x.pdf`) while the arg
// scan gives `files/x.pdf`. Without this the file appears twice. Non-workspace,
// already-relative, and wolffish-media:// values pass through unchanged.
function toWorkspaceRelative(p: string): string {
  if (p.startsWith('wolffish-media://')) return p
  return p.replace(/^.*?\.wolffish\/workspace\//, '')
}

/** Shared empty set, so "nothing missing" keeps a stable identity. */
const NO_MISSING_FILES: ReadonlySet<string> = new Set()

/**
 * Narrow the collected files to the ones actually on disk right now.
 *
 * collectConversationFiles reports every file a conversation ever NAMED, and a
 * long run names plenty it then cleans up: a PDF verify loop renders proof
 * pages, looks at them, re-renders and `rm`s the batch. Those are gone by the
 * time anyone opens the sheet, and a "log of files" made mostly of tombstones
 * is worse than a short honest one — so the sheet drops them, and its chip
 * counts what it will actually show.
 *
 * The FEED deliberately keeps the opposite behavior: a message that delivered
 * a file still renders that file's per-type "deleted" state, because hiding it
 * there would make the history claim the delivery never happened.
 *
 * Two failure modes to fail SAFE on, both toward showing too much rather than
 * too little: a check that never resolves leaves the full list up (nothing is
 * hidden until a stat has actually come back false, so the first paint is the
 * complete list, not a flash of empty), and a check that errors counts as
 * present, since a broken IPC is not evidence a file is gone.
 */
function useFilesOnDisk(files: MessageAttachment[]): MessageAttachment[] {
  const [missing, setMissing] = useState<ReadonlySet<string>>(NO_MISSING_FILES)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const paths = files.map((f) => f.filePath)
      const present = await Promise.all(
        paths.map((p) => window.api.upload.exists(p).catch(() => true))
      )
      if (cancelled) return
      const gone = new Set<string>()
      paths.forEach((p, i) => {
        if (!present[i]) gone.add(p)
      })
      setMissing(gone.size === 0 ? NO_MISSING_FILES : gone)
    })()
    return () => {
      cancelled = true
    }
  }, [files])

  return useMemo(
    () => (missing.size === 0 ? files : files.filter((f) => !missing.has(f.filePath))),
    [files, missing]
  )
}

/**
 * Build the flat, ordered, de-duplicated list of files that appear across the
 * whole conversation — a "log of files". Four sources: user uploads (already
 * MessageAttachment[]); files a tool NAMED in its call args (produced,
 * converted, written, inspected, or sent to a channel — see argFilePaths, and
 * CONTENT_READ_TOOLS for what that excludes); files a tool DELIVERED via a
 * [wolffish-output:] marker in its result (pulled with the SAME extractors the
 * feed uses); and generated media the model showed inline as a
 * wolffish-media:// ref. All adapt into MessageAttachment so AttachmentList
 * renders them with its existing per-type dispatch, existence checks and
 * viewers. Order follows appearance; dedup is on the canonical,
 * workspace-relative path so a file surfaced in more than one place (e.g.
 * produced then sent, or arg + marker) collapses to a single entry.
 *
 * Every entry here is a CLAIM that a file exists; the caller is what turns
 * that into a list worth showing — see useFilesOnDisk.
 */
function collectConversationFiles(messages: ChatMessage[]): MessageAttachment[] {
  const out: MessageAttachment[] = []
  const seen = new Set<string>()
  const push = (att: MessageAttachment): void => {
    const key = canonicalPath(toWorkspaceRelative(att.filePath))
    if (seen.has(key)) return
    seen.add(key)
    out.push(att)
  }

  for (const message of messages) {
    if (message.role === 'user') {
      for (const att of message.attachments ?? []) push(att)
      continue
    }
    // First pass over tool_calls: index them for result pairing AND surface
    // every file named in their args. This is what makes View Files a complete
    // "log of files" — producers (browser_pdf, document_convert), channel send
    // tools and writers all put their file path in the args and leave no
    // [wolffish-output:] marker, so the result-marker pass below never sees
    // them. Order follows call order, so the dialog reads like a timeline.
    // Reference reads are skipped — see CONTENT_READ_TOOLS.
    const callById = new Map<string, ToolCallSegment>()
    for (const seg of message.segments) {
      // Files the user attached to a mid-turn message — the user's own, like
      // a top-level message's attachments above.
      if (seg.kind === 'user_message') {
        for (const att of seg.attachments ?? []) push(att)
        continue
      }
      if (seg.kind !== 'tool_call') continue
      callById.set(seg.toolCallId, seg)
      if (CONTENT_READ_TOOLS.has(seg.name)) continue
      for (const p of argFilePaths(seg.args)) push(fileToAttachment(p, extToBucket(p)))
    }
    // Media the model generated and showed inline: meme_generate and friends
    // answer with `![alt](wolffish-media://<relative path>)`, which the feed
    // turns into a real image card — but it is neither an arg nor a
    // [wolffish-output:] marker, so without this the file the user is looking
    // at is the one file the sheet does not list. The scheme is stripped here
    // (the feed strips it too) so the path resolves like every other entry and
    // dedups against whatever else named the same file.
    for (const ref of mediaRefsInText(message.segments)) push(fileToAttachment(ref, 'image'))
    for (const seg of message.segments) {
      if (seg.kind !== 'tool_result' || seg.status !== 'success' || !seg.output) continue
      const call = callById.get(seg.toolCallId)
      // Mirror renderSegments' branch order exactly: a file-content result
      // (file_read/file_write/file_patch) or a fetched-page result never
      // yields a *delivered* file there, so it must not here either —
      // otherwise a delivery marker quoted inside file content or page text
      // would surface as a phantom file the feed never shows. (The file itself,
      // if any, is already surfaced from the call args above.)
      if (call && (isFileContentResult(call, seg) || extractToolResultPage(call, seg))) {
        continue
      }
      // The master's workflow tool results are agent reports, not deliveries —
      // the feed hides those chips entirely, so a delivery marker quoted inside
      // an agents_await report must not surface as a phantom file here either.
      if (call && WORKFLOW_TOOL_NAMES.has(call.name)) continue
      for (const att of deliveredFilesToAttachments(seg)) push(att)
    }
  }
  return out
}

const MEDIA_SCHEME = 'wolffish-media://'

/**
 * How many wolffish-media:// refs a message's text carries. A change detector
 * for filesKey — mediaRefsInText does the actual parsing — so it counts the
 * scheme alone and never asks whether the ref around it is well-formed: an
 * over-count costs one rescan, and a rescan is what we wanted anyway.
 *
 * Counted with a carry rather than per segment because a LIVE stream keeps one
 * text segment per token (they are only coalesced at persistence time, see
 * mapConversationMessages), so the scheme almost always straddles a boundary —
 * `wolffish-med` then `ia://…`. The carry is one character shorter than the
 * scheme, which is exactly the width that makes both directions safe: no
 * occurrence can fit inside it to be counted twice, and none spanning any
 * number of one-character deltas can slip between two scans.
 *
 * The alternative, joining the whole message per delta the way collectText
 * does, is the per-token cost filesKey exists to avoid.
 */
function countMediaRefs(segments: Segment[]): number {
  let count = 0
  let carry = ''
  for (const s of segments) {
    if (s.kind !== 'text') continue
    const chunk = carry + s.delta
    for (
      let i = chunk.indexOf(MEDIA_SCHEME);
      i !== -1;
      i = chunk.indexOf(MEDIA_SCHEME, i + MEDIA_SCHEME.length)
    ) {
      count += 1
    }
    carry = chunk.slice(1 - MEDIA_SCHEME.length)
  }
  return count
}

// Workspace-relative paths of the wolffish-media:// images a message shows in
// its own prose. Deliberately looser than flushTextOnly's anchored match: that
// one only swaps a STANDALONE ref for a file card, but a ref sitting inside a
// paragraph still renders as an image, and both are files the user can see.
// Read off the joined text, never a single delta — the markdown routinely
// straddles a token boundary mid-stream.
//
// The parsing mirrors the wolffish-media protocol handler in main, since that
// is what decides which bytes a ref actually serves: percent escapes decoded —
// browser_screenshot emits an encodeURIComponent'd path, so a raw match would
// silently name a file that does not exist — query dropped, leading slashes
// trimmed, and anything climbing out of the workspace refused.
function mediaRefsInText(segments: Segment[]): string[] {
  const text = collectText(segments)
  if (!text.includes(MEDIA_SCHEME)) return []
  const out: string[] = []
  for (const m of text.matchAll(/!\[[^\]\n]*\]\(wolffish-media:\/\/([^)\s]+)\)/g)) {
    let rel: string
    try {
      rel = decodeURIComponent(m[1])
    } catch {
      continue
    }
    rel = (rel.split('?')[0] ?? '').replace(/^\/+/, '')
    if (!rel) continue
    if (rel.split(/[\\/]/).some((part) => part === '..')) continue
    out.push(rel)
  }
  return out
}

/**
 * Adapt one tool_result's delivered files into MessageAttachment[], applying
 * the same extractors and path normalization renderSegments uses in the feed
 * so the files dialog and the feed agree on what (and where) each file is.
 */
function deliveredFilesToAttachments(result: ToolResultSegment): MessageAttachment[] {
  const atts: MessageAttachment[] = []

  // Every branch normalizes to the workspace-relative form so a marker delivery
  // and an arg-scanned path for the same file share a dedup key (documents /
  // generic files used to keep the marker's absolute path, which slipped past
  // dedup and showed the file twice).
  const imagePath = extractToolResultImage(result)
  if (imagePath) atts.push(fileToAttachment(toWorkspaceRelative(imagePath), 'image'))

  const docs = extractToolResultDocuments(result)
  if (docs)
    for (const d of docs)
      atts.push(fileToAttachment(toWorkspaceRelative(d.path), 'document', d.size))

  const media = extractToolResultMedia(result)
  if (media) atts.push(fileToAttachment(toWorkspaceRelative(media.path), media.type))

  for (const p of extractToolResultGenericFiles(result))
    atts.push(fileToAttachment(toWorkspaceRelative(p), 'file'))

  for (const p of extractToolResultCharts(result))
    atts.push(fileToAttachment(toWorkspaceRelative(p), 'chart'))

  return atts
}

function fileToAttachment(
  filePath: string,
  bucket: DeliveredBucket,
  sizeBytes = 0
): MessageAttachment {
  const fileName = filePath.split('/').pop() ?? 'file'
  // Anchored match (mirrors the feed) so a dotless name yields '' — split('.')
  // would return the whole filename and defeat the mimeForAttachment fallbacks.
  const ext = (fileName.match(/\.[^.]+$/)?.[0].slice(1) ?? '').toLowerCase()
  const type: MessageAttachmentType =
    bucket === 'image'
      ? 'image'
      : bucket === 'audio'
        ? 'audio'
        : bucket === 'video'
          ? 'video'
          : ext === 'pdf'
            ? 'pdf'
            : 'other'
  return {
    type,
    filePath,
    originalName: fileName,
    // Chart specs are JSON; AttachmentList keys the chart card off the
    // `.chart.json` filename, this just keeps the type label honest.
    mimeType: bucket === 'chart' ? 'application/json' : mimeForAttachment(type, ext),
    sizeBytes
  }
}

/**
 * Best-effort MIME for a delivered file. AttachmentList keys markdown/html off
 * the filename too, so this only needs to be exactly right for the media
 * decoders (image/audio/video) and pdf; everything else falls back to the
 * shared docMimeType map.
 */
function mimeForAttachment(type: MessageAttachmentType, ext: string): string {
  if (type === 'image') return `image/${ext === 'jpg' ? 'jpeg' : ext || 'png'}`
  if (type === 'audio') return `audio/${ext === 'mp3' ? 'mpeg' : ext || 'mpeg'}`
  if (type === 'video') return `video/${ext === 'mov' ? 'quicktime' : ext || 'mp4'}`
  if (type === 'pdf') return 'application/pdf'
  return docMimeType(ext)
}

function collectText(segments: Segment[]): string {
  let out = ''
  for (const s of segments) {
    if (s.kind === 'text') out += s.delta
  }
  return out
}

function cryptoId(): string {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function isAssistant(m: ChatMessage): m is AssistantMessage {
  return (m.kind === undefined || m.kind === 'message') && m.role === 'assistant'
}

function isUser(m: ChatMessage): m is Extract<ChatMessage, { role: 'user' }> {
  return (m.kind === undefined || m.kind === 'message') && m.role === 'user'
}

/**
 * Fold a post-turn task-snapshot push into whichever message holds the
 * matching `task` segment. No-op when the task isn't in this transcript
 * (e.g. a push for another conversation raced the open).
 */
function foldTaskSnapshot(messages: ChatMessage[], snapshot: TaskSnapshot): ChatMessage[] {
  return messages.map((m) => {
    if (!isAssistant(m)) return m
    if (!m.segments.some((s) => s.kind === 'task' && s.snapshot.taskId === snapshot.taskId)) {
      return m
    }
    return {
      ...m,
      segments: m.segments.map((s) =>
        s.kind === 'task' && s.snapshot.taskId === snapshot.taskId ? { ...s, snapshot } : s
      )
    }
  })
}

/**
 * Fold a post-turn countdown-snapshot push into whichever message holds the
 * matching `countdown` segment — the task fold, keyed by countdownId.
 */
function foldCountdownSnapshot(
  messages: ChatMessage[],
  snapshot: CountdownSnapshot
): ChatMessage[] {
  return messages.map((m) => {
    if (!isAssistant(m)) return m
    if (
      !m.segments.some(
        (s) => s.kind === 'countdown' && s.snapshot.countdownId === snapshot.countdownId
      )
    ) {
      return m
    }
    return {
      ...m,
      segments: m.segments.map((s) =>
        s.kind === 'countdown' && s.snapshot.countdownId === snapshot.countdownId
          ? { ...s, snapshot }
          : s
      )
    }
  })
}

/**
 * Fold a post-turn process-card push into whichever message holds the
 * matching `process` segment — the countdown fold, keyed by cardId.
 */
function foldProcessSnapshot(
  messages: ChatMessage[],
  snapshot: ProcessCardSnapshot
): ChatMessage[] {
  return messages.map((m) => {
    if (!isAssistant(m)) return m
    if (!m.segments.some((s) => s.kind === 'process' && s.snapshot.cardId === snapshot.cardId))
      return m
    return {
      ...m,
      segments: m.segments.map((s) =>
        s.kind === 'process' && s.snapshot.cardId === snapshot.cardId ? { ...s, snapshot } : s
      )
    }
  })
}

/**
 * Fold a post-turn browser-page push into whichever message holds the
 * matching `browser` segment — the countdown fold, keyed by tabId.
 */
function foldBrowserSnapshot(messages: ChatMessage[], snapshot: BrowserTabSnapshot): ChatMessage[] {
  return messages.map((m) => {
    if (!isAssistant(m)) return m
    if (
      !m.segments.some(
        (s) => s.kind === 'browser' && browserKey(s.snapshot) === browserKey(snapshot)
      )
    ) {
      return m
    }
    return {
      ...m,
      segments: m.segments.map((s) =>
        s.kind === 'browser' && browserKey(s.snapshot) === browserKey(snapshot)
          ? { ...s, snapshot }
          : s
      )
    }
  })
}

function appendSegment(messages: ChatMessage[], segment: Segment): ChatMessage[] {
  const out = [...messages]
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]
    if (isAssistant(m) && m.status === 'streaming') {
      // Snapshot kinds REPLACE their predecessor for the same run/task/list —
      // the segment kinds' documented contract (broca foldSegment), not
      // render-layer dedup. Everything else appends.
      const nextSegments = [...m.segments]
      foldSegment(nextSegments, segment)
      const next: AssistantMessage = { ...m, segments: nextSegments }
      if (segment.kind === 'turn_end') next.stopReason = segment.stopReason
      if (segment.kind === 'tool_call') {
        next.toolTimings = {
          ...(m.toolTimings ?? {}),
          [segment.toolCallId]: { startedAt: Date.now() }
        }
      } else if (segment.kind === 'tool_result') {
        // A checked-in result is a progress report, not an end: the clock
        // keeps running until the in-place update with the real outcome.
        const existing = m.toolTimings?.[segment.toolCallId]
        if (existing && segment.status !== 'checked_in') {
          next.toolTimings = {
            ...m.toolTimings,
            [segment.toolCallId]: { ...existing, endedAt: Date.now() }
          }
        }
      }
      out[i] = next
      // The browser card lives in the latest turn that used the browser;
      // an earlier turn's copy of it goes.
      return segment.kind === 'browser' ? keepLatestBrowserCard(out) : out
    }
  }
  return out
}

function markComplete(messages: ChatMessage[], turnId: string): ChatMessage[] {
  void turnId
  const out = [...messages]
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]
    if (isAssistant(m) && m.status === 'streaming') {
      out[i] = { ...m, status: 'complete' }
      return out
    }
  }
  return out
}

function markError(messages: ChatMessage[], turnId: string, error: string): ChatMessage[] {
  void turnId
  const out = [...messages]
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]
    if (isAssistant(m) && m.status === 'streaming') {
      out[i] = { ...m, status: 'error', error }
      return out
    }
  }
  return out
}

/** Tool results older than this many chars get stubbed once stale. */
const STALE_TOOL_RESULT_MIN_CHARS = 2_000
/** The last N user exchanges keep their tool results verbatim. */
const STALE_TOOL_PROTECT_EXCHANGES = 2

/**
 * Mirror of the channel-side replay policy (channels/channel.ts
 * stubStaleToolResults): large tool results from older exchanges collapse to
 * a recovery stub — the bytes stay persisted and indexed, one
 * conversation_read away.
 */
function stubStaleToolResults(
  history: ChatHistoryMessage[],
  conversationId: string | null
): ChatHistoryMessage[] {
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
  const readRef = conversationId ? `conversation_read("${conversationId}")` : 'memory_search'
  return history.map((entry, i) => {
    if (i >= protectFrom) return entry
    if (entry.role !== 'tool') return entry
    if (typeof entry.content !== 'string' || entry.content.length < STALE_TOOL_RESULT_MIN_CHARS) {
      return entry
    }
    return {
      ...entry,
      content: `[${entry.toolName} result from earlier in this conversation, ${entry.content.length} chars — ${readRef} retrieves it verbatim]`
    }
  })
}

/**
 * Whether a feed message reaches disk — persistConversation writes exactly
 * these and nothing else.
 *
 * The single definition matters: it is the projection from feed to file, so
 * anything that counts or indexes persisted messages (the rolling-summary
 * mark, the disk-tail sync) must agree with the writer exactly. A second copy
 * that drifted would silently mis-index the transcript.
 */
function isPersistedMessage(m: ChatMessage): boolean {
  if (isUser(m)) return true
  if (isAssistant(m) && m.status === 'error') return true
  if (isAssistant(m) && m.status === 'complete') return m.segments.length > 0
  return false
}

type ReplayWindowInfo = {
  summary?: string | null
  summarizedThroughMessage?: number | null
  /** Id form of the mark — wins over the numeric index when it resolves. */
  summarizedThroughMessageId?: string | null
  conversationId?: string | null
}

function textHistory(
  messages: ChatMessage[],
  workspaceRoot: string | null,
  replay?: ReplayWindowInfo
): ChatHistoryMessage[] {
  const out: ChatHistoryMessage[] = []

  // Rolling prefix summary: skip the persisted messages the summarizer
  // already folded in and replay the summary preamble instead. The mark is
  // an index into the PERSISTED message list, so count renderer messages
  // with the same filter persistConversation uses. The id form wins when it
  // resolves — feed ids ARE the persisted ids since the round-trip shipped,
  // and the id survives merges that insert messages before the boundary —
  // with the numeric mark as the transition fallback.
  let mark = replay?.summarizedThroughMessage ?? 0
  if (replay?.summarizedThroughMessageId) {
    let persistIdx = 0
    for (const m of messages) {
      if (!isPersistedMessage(m)) continue
      if (m.id === replay.summarizedThroughMessageId) {
        mark = persistIdx
        break
      }
      persistIdx++
    }
  }
  const summary = replay?.summary?.trim()
  // Mirror of channel.ts replayWindow's defensive guard: a stale/corrupt mark
  // at/beyond the persisted count degrades to full replay — never to an
  // everything-skipped send.
  const persistedTotal = messages.filter(isPersistedMessage).length
  const useSummary = Boolean(summary) && mark > 0 && mark < persistedTotal
  if (useSummary) {
    out.push({
      role: 'user',
      content:
        `[Conversation summary — the first ${mark} messages of this conversation were compressed; ` +
        `conversation_read("${replay?.conversationId ?? ''}") retrieves any of them verbatim]\n\n${summary}`
    })
    out.push({ role: 'assistant', content: 'Understood — continuing with that context.' })
  }
  let persistIdx = -1

  for (const m of messages) {
    if (useSummary) {
      if (isPersistedMessage(m)) {
        persistIdx++
        if (persistIdx < mark) continue
      }
    }
    if (isUser(m)) {
      // A voice note's transcript IS the prompt; the audio is kept on disk for
      // replay only and must not reach the LLM as an attachment. Same rule the
      // Telegram/WhatsApp history builders apply — it has to live here too now
      // that those conversations can be continued from the app.
      if (m.voicePrompt) {
        const langAttr = m.voiceLang ? ` lang="${m.voiceLang}"` : ''
        out.push({ role: 'user', content: `<voice_note${langAttr}>\n${m.content}` })
        continue
      }
      const content = composeHistoryContent(m.content, m.attachments ?? [], workspaceRoot)
      const entry: ChatHistoryMessage = { role: 'user', content }
      if (m.attachments && m.attachments.length > 0) entry.attachments = m.attachments
      if (m.systemAside) entry.systemAside = true
      out.push(entry)
    } else if (isAssistant(m) && m.status === 'complete') {
      const segments = m.segments.filter((s) => !('worker' in s && s.worker))
      const turnEnd = segments.find((s) => s.kind === 'turn_end')
      const reasoningContent =
        turnEnd && 'reasoningContent' in turnEnd && turnEnd.reasoningContent
          ? (turnEnd.reasoningContent as string)
          : undefined

      // Build a tool_call lookup so tool_results can reference the name
      const toolCallNames = new Map<string, string>()
      for (const s of segments) {
        if (s.kind === 'tool_call') toolCallNames.set(s.toolCallId, s.name)
      }

      // Split segments into iterations delimited by active_model boundaries.
      // Each iteration = one LLM call that may produce text + tool_uses,
      // followed by tool results before the next LLM call.
      let iterText = ''
      let iterToolUses: Array<{ id: string; name: string; args: Record<string, unknown> }> = []
      let iterToolResults: ChatHistoryMessage[] = []
      let hasContent = false

      const flushIteration = (): void => {
        if (!hasContent) return
        const assistantMsg: ChatHistoryMessage = {
          role: 'assistant',
          content: iterText
        }
        if (iterToolUses.length > 0) assistantMsg.toolUses = iterToolUses
        if (reasoningContent && out.length === 0) assistantMsg.reasoningContent = reasoningContent
        out.push(assistantMsg)
        for (const tr of iterToolResults) out.push(tr)
        // Backfill: a run stopped mid-tool can leave a tool_call segment with
        // no tool_result (older conversations saved before the agent closed
        // these at the source). Providers reject an assistant tool_calls
        // message that isn't answered for every id, so synthesize a canceled
        // result for each missing one — immediately after the assistant turn.
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
          if (iterCount > 0) flushIteration()
          iterCount++
        } else if (s.kind === 'user_message') {
          // A message the user sent mid-turn, read by the agent at this exact
          // point. Close the iteration so far and replay it as the real user
          // entry it was. Mirrors channels/channel.ts assistantSegmentsToHistory
          // (interjectionSegmentToHistory) — the two must stay identical.
          flushIteration()
          if (s.voicePrompt) {
            const langAttr = s.voiceLang ? ` lang="${s.voiceLang}"` : ''
            out.push({ role: 'user', content: `<voice_note${langAttr}>\n${s.text}` })
          } else {
            const atts = s.attachments ?? []
            const entry: ChatHistoryMessage = {
              role: 'user',
              content: composeHistoryContent(s.text, atts, workspaceRoot)
            }
            if (atts.length > 0) entry.attachments = atts
            out.push(entry)
          }
        } else if (s.kind === 'text') {
          iterText += s.delta
          hasContent = true
        } else if (s.kind === 'tool_call') {
          iterToolUses.push({ id: s.toolCallId, name: s.name, args: s.args })
          hasContent = true
        } else if (s.kind === 'tool_result') {
          // Tool-result images are deliberately not replayed — see the same
          // note in channels/channel.ts segmentsToHistory. Pixels are scoped
          // to the turn that produced them; the caption carries the path.
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
      flushIteration()
    }
  }
  return stubStaleToolResults(out, replay?.conversationId ?? null)
}

/**
 * Merge consecutive text-delta and reasoning-delta segments (same turn, same
 * kind) into one segment each. Replay joins deltas anyway, and the UI renders
 * joined runs identically — only the on-disk shape changes.
 */
function coalesceTextSegments(segments: Segment[]): Segment[] {
  const out: Segment[] = []
  for (const s of segments) {
    const prev = out[out.length - 1]
    if (
      (s.kind === 'text' || s.kind === 'reasoning') &&
      prev &&
      (prev.kind === 'text' || prev.kind === 'reasoning') &&
      prev.kind === s.kind &&
      prev.turnId === s.turnId &&
      (prev.worker?.id ?? null) === (s.worker?.id ?? null)
    ) {
      out[out.length - 1] = { ...prev, delta: prev.delta + s.delta }
    } else {
      out.push(s)
    }
  }
  return out
}

function attachApproval(messages: ChatMessage[], approval: ApprovalCardState): ChatMessage[] {
  const out = [...messages]
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]
    if (isAssistant(m) && m.status === 'streaming') {
      const approvals = { ...(m.approvals ?? {}), [approval.toolCallId]: approval }
      out[i] = { ...m, approvals }
      return out
    }
  }
  return out
}

function attachAsk(messages: ChatMessage[], ask: AskCardState): ChatMessage[] {
  const out = [...messages]
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]
    if (isAssistant(m) && m.status === 'streaming') {
      const asks = { ...(m.asks ?? {}), [ask.toolCallId]: ask }
      out[i] = { ...m, asks }
      return out
    }
  }
  return out
}

type VoiceResultData = {
  filePath: string
  fileName: string
  isResponse: boolean
}

function parseVoiceResult(output: string): VoiceResultData | null {
  try {
    const parsed = JSON.parse(output)
    if (typeof parsed?.filePath === 'string' && typeof parsed?.fileName === 'string') {
      return {
        filePath: parsed.filePath,
        fileName: parsed.fileName,
        isResponse: !!parsed.isResponse
      }
    }
  } catch {
    // not voice output
  }
  return null
}

/**
 * Resolve a workspace-relative upload path to an absolute path the LLM
 * can hand straight to shell tools. The renderer can't import path/os,
 * so we join with forward slashes — uploads are always under
 * `${rootPath}/uploads/...` and the workspace root never contains a
 * trailing slash. Falls back to the relative path when the workspace
 * root isn't yet known (rare; status loads before chat is usable).
 */
function toAbsoluteUploadPath(relativePath: string, workspaceRoot: string | null): string {
  if (!workspaceRoot) return relativePath
  const root = workspaceRoot.replace(/[\\/]+$/, '')
  const rel = relativePath.replace(/^[\\/]+/, '')
  return `${root}/${rel}`
}

/**
 * Build the LLM-facing content string for a user turn. Text comes first
 * (when present); attachments are appended as a bullet list under a
 * sentinel header so the model has unambiguous metadata to act on
 * (filename, type, size, absolute path). The sentinel uses pseudo-XML
 * rather than markdown so it survives copy-paste between providers
 * without bullets collapsing. The path is rendered as an absolute path
 * so the model can pass it straight to ffmpeg/ffprobe/etc. — guessing a
 * root (e.g. macOS "Application Support") leads to file-not-found.
 */
function composeHistoryContent(
  text: string,
  attachments: MessageAttachment[],
  workspaceRoot: string | null
): string {
  // Working folders deliberately do NOT render here anymore: the agent
  // injects a fresh listing into the outbound volatile tail each turn, so
  // history content stays byte-stable and the prompt-cache prefix survives.
  const parts: string[] = []
  if (text) parts.push(text)
  if (attachments.length > 0) {
    const lines = attachments.map((a) => {
      const ext = a.originalName.includes('.')
        ? a.originalName.slice(a.originalName.lastIndexOf('.'))
        : ''
      const abs = toAbsoluteUploadPath(a.filePath, workspaceRoot)
      return `  - ${a.originalName} (type=${a.type}, mime=${a.mimeType}, size=${a.sizeBytes}b, path=${abs}${ext ? `, ext=${ext}` : ''})`
    })
    parts.push(
      `<attachments>\nThe user attached ${attachments.length} file${attachments.length === 1 ? '' : 's'} to this message:\n${lines.join('\n')}\n</attachments>`
    )
    const hasVideo = attachments.some((a) => a.type === 'video')
    if (hasVideo) {
      parts.push(
        `<video_instructions>\nOne or more attached files are videos. You cannot view or process video content directly. Instead, use ffmpeg via your shell tool to read the video metadata and inspect the file. Start by running: ffmpeg -hide_banner -i "<path>" for each video file — its stderr reports duration, resolution, codecs and streams. (If ffprobe is available it gives structured JSON: ffprobe -v quiet -print_format json -show_format -show_streams "<path>".) Use ffmpeg for any further video operations the user requests.\n</video_instructions>`
      )
    }
  }
  return parts.join('\n\n')
}

/**
 * Last segment of a device path, for labelling a chip before main has
 * reported the file's final (collision-suffixed) name. Handles both
 * separators — the picker returns native paths.
 */
function baseNameOf(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

// Clipboard images (e.g. screenshots) often arrive as File objects with no
// useful name — fall back to a timestamp + the mime-derived extension so the
// saved file is still recognizable on disk.
function pastedFileName(file: File): string {
  if (file.name && file.name !== 'image.png') return file.name
  const ext = file.type.includes('/') ? file.type.split('/')[1] : 'bin'
  return `pasted-${Date.now()}.${ext || 'bin'}`
}

function hasFiles(e: React.DragEvent<HTMLDivElement>): boolean {
  const types = e.dataTransfer?.types
  if (!types) return false
  for (let i = 0; i < types.length; i++) {
    if (types[i] === 'Files') return true
  }
  return false
}

type ValidationErrorType =
  | { code: 'file_too_large'; maxBytes: number }
  | { code: 'max_files_reached'; max: number }
  | { code: 'total_size_exceeded'; maxBytes: number }
  | { code: 'type_not_supported' }

function validationErrorMessage(
  error: ValidationErrorType,
  t: (k: string, v?: Record<string, unknown>) => string
): string {
  switch (error.code) {
    case 'file_too_large':
      return t('chat.upload.fileTooLarge', { limit: formatBytesL(error.maxBytes, t, 0) })
    case 'max_files_reached':
      return t('chat.upload.maxFiles', { count: error.max })
    case 'total_size_exceeded':
      return t('chat.upload.totalExceeded', { limit: formatBytesL(error.maxBytes, t, 0) })
    case 'type_not_supported':
      return t('chat.upload.typeNotSupported')
  }
}
