import type {
  CountdownSnapshot,
  CountdownStatus,
  Segment,
  SegmentTurnEndReason,
  TaskSnapshot,
  TaskStatus,
  TodoItem,
  TodoStatus,
  ToolResultDiff,
  ToolResultMeta,
  ToolResultStatus,
  WaitSnapshot,
  WaitStatus
} from '@main/runtime/broca'
import type {
  ListeningPort,
  ProcessAutostart,
  ProcessCardSnapshot,
  ProcessPortPolicy,
  ProcessRecord,
  ProcessState,
  RestartPolicy
} from '@main/processes/types'
import type {
  BrowserCloseReason,
  BrowserFps,
  BrowserFrame,
  BrowserInputEvent,
  BrowserStripEntry,
  BrowserPartition,
  BrowserRect,
  BrowserTabMode,
  BrowserTabSnapshot
} from '@main/browser/types'
import type {
  InterjectVerdict,
  Interjection,
  InterjectionEvent
} from '@main/runtime/agent/interjection'
import { buildApi } from '@preload/api'
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'

export type {
  ListeningPort,
  ProcessAutostart,
  ProcessCardSnapshot,
  ProcessPortPolicy,
  ProcessRecord,
  ProcessState,
  RestartPolicy,
  BrowserCloseReason,
  BrowserFps,
  BrowserFrame,
  BrowserInputEvent,
  BrowserStripEntry,
  BrowserPartition,
  BrowserRect,
  BrowserTabMode,
  BrowserTabSnapshot,
  CountdownSnapshot,
  CountdownStatus,
  Segment,
  SegmentTurnEndReason,
  TaskSnapshot,
  TaskStatus,
  TodoItem,
  TodoStatus,
  ToolResultDiff,
  ToolResultMeta,
  ToolResultStatus,
  WaitSnapshot,
  WaitStatus
}

export type ThemeSource = 'system' | 'light' | 'dark'
export type Locale = 'en' | 'ar'

export type ThemeState = {
  themeSource: ThemeSource
  shouldUseDarkColors: boolean
}

export type ModelFamily = 'gemma' | 'qwen' | 'llama' | 'deepseek' | 'kimi'
export type SizeKey = 'nano' | 'mini' | 'compact' | 'standard' | 'pro' | 'max' | 'extreme' | 'ultra'

export type ModelEntry = {
  family: ModelFamily
  sizeKey: SizeKey
  ollamaName: string
  sizeBytes: number
  ramBytes: number
  paramsBillions?: number
  releaseDate?: string
}

export type SystemInfo = {
  totalRamBytes: number
  freeDiskBytes: number | null
  totalDiskBytes: number | null
  platform: NodeJS.Platform
  arch: string
  cpuCount: number
  cpuModel: string
}

export type LocalModelConfig = {
  enabled: boolean
  provider: 'ollama'
  model: string | null
  endpoint: string
}

export type CloudProviderConfig = {
  id:
    | 'anthropic'
    | 'openai'
    | 'openrouter'
    | 'deepseek'
    | 'mimo'
    | 'kimi'
    | 'minimax'
    | 'xai'
    | 'qwen'
    | 'stepfun'
    | 'zai'
  model: string
  apiKey: string
  models?: string[]
  reasoningModels?: string[]
}

export type SafetyConfig = {
  bypassPermissions: boolean
  blockCredentials: boolean
}

export type TelegramConfig = {
  enabled: boolean
  botToken: string
  allowedUserIds: number[]
  autoRefresh?: boolean
  staleHours?: number
  /**
   * When true, every tool call/result/activity is relayed to the chat
   * (full transparency). When false (default), only agent messages,
   * file-bearing tool results, and errors are sent — a clean feed.
   * Affects sending only; history persistence is unchanged.
   */
  verbose?: boolean
  /** Keep automation runs out of the /resume picker (on by default). */
  hideAutomationsFromResume?: boolean
}

export type WhatsAppConfig = {
  enabled: boolean
  allowedPhoneNumbers: string[]
  autoRefresh?: boolean
  staleHours?: number
  /**
   * When true, every tool call/result/activity is relayed to the chat
   * (full transparency). When false (default), only agent messages,
   * file-bearing tool results, and errors are sent — a clean feed.
   * Affects sending only; history persistence is unchanged.
   */
  verbose?: boolean
  /** Keep automation runs out of the /resume picker (on by default). */
  hideAutomationsFromResume?: boolean
}

/**
 * In-app (desktop) chat display preferences. Mirrors the Telegram /
 * WhatsApp verbose toggle, but for the primary renderer feed: when false
 * (default) the in-app chat shows a clean feed — agent replies,
 * file-bearing tool results, errors, and the model chip — and hides
 * tool-activity and compaction cards. Display-only; history is unaffected.
 */
export type InAppConfig = {
  verbose?: boolean
  /**
   * Whether the model's thinking renders as a collapsible card. Default
   * TRUE, one workspace answer for this app and the phone, and display-only:
   * the reasoning is streamed, stored and exported whichever way it is set.
   */
  reasoning?: boolean
}

export type WhatsAppConnectionStatus = 'disconnected' | 'connecting' | 'qr' | 'connected' | 'error'

export type WhatsAppChannelStatus = {
  status: WhatsAppConnectionStatus
  error: string | null
  qr: string | null
  /** The eight-character code, when linking was started by phone number. */
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

export type WhatsAppApi = {
  getConfig: () => Promise<WhatsAppConfig>
  setConfig: (
    patch: Partial<WhatsAppConfig>
  ) => Promise<{ ok: true; status: WhatsAppChannelStatus; config: WhatsAppConfig }>
  status: () => Promise<WhatsAppChannelStatus>
  logout: () => Promise<void>
  requestQr: () => Promise<void>
  onQr: (callback: (qr: string) => void) => () => void
  onStatusChange: (callback: (status: WhatsAppChannelStatus) => void) => () => void
}

export type InAppApi = {
  getConfig: () => Promise<InAppConfig>
  setConfig: (patch: Partial<InAppConfig>) => Promise<{ ok: true; config: InAppConfig }>
  onConfigChange: (callback: (config: InAppConfig) => void) => () => void
}

/** Mirrors main's CliConfig (dual decl — see the channel-config convention). */
export type CliConfig = {
  verbose?: boolean
  runMode?: 'gui' | 'headless'
}

/**
 * Whether the shell can find `wolffish`. Every field answers a different
 * failure the user would otherwise only meet as "command not found":
 * the shim missing, its folder absent from PATH, or another binary of the
 * same name winning (on Linux the package's own /usr/bin symlink to the GUI).
 */
export type CliPathStatus = {
  installed: boolean
  /** The shim file exists, even if the shell cannot find it — see cli-path.ts. */
  present: boolean
  target: string
  resolved: string | null
  needsPathEntry: boolean
  /** The app already put the folder on PATH for new terminals (profile / user PATH). */
  profileHasEntry: boolean
  profileHint: string | null
  shadowedBy: string | null
  error: string | null
}

export type AutostartInfo = {
  active: boolean
  mechanism: string
  location: string | null
  warning: string | null
  mode: 'gui' | 'headless'
}

/**
 * What each run mode WOULD register on this machine. Lets the picker label the
 * two choices with the real mechanism rather than generic words, and flag a
 * host with no desktop session, where a login item can never fire.
 */
export type AutostartMechanisms = {
  gui: string
  headless: string
  current: string
  headlessHost: boolean
}

export type CliApi = {
  getConfig: () => Promise<CliConfig>
  setConfig: (patch: Partial<CliConfig>) => Promise<{ ok: true; config: CliConfig }>
  onConfigChange: (callback: (config: CliConfig) => void) => () => void
  pathStatus: () => Promise<CliPathStatus>
  installPath: () => Promise<CliPathStatus>
  uninstallPath: () => Promise<CliPathStatus>
  onPathChange: (callback: (status: CliPathStatus) => void) => () => void
  serviceStatus: () => Promise<AutostartInfo>
  serviceInstall: (mode?: 'gui' | 'headless') => Promise<AutostartInfo>
  serviceUninstall: () => Promise<AutostartInfo>
  serviceSetMode: (mode: 'gui' | 'headless') => Promise<AutostartInfo>
  serviceMechanism: () => Promise<AutostartMechanisms>
  entryPath: () => Promise<{ execPath: string; entry: string }>
}

// MCP connection views. Mirrors src/main/runtime/mcp/types.ts (the
// preload re-declares main types by convention) — keep both in sync.
export type McpTransportKind = 'stdio' | 'http'

export type McpServerState = 'connected' | 'connecting' | 'needs-auth' | 'offline' | 'disabled'

/**
 * One custom HTTP header for a remote server. Persisted plaintext;
 * `sensitive` only masks the value in the settings UI.
 */
export type McpHeader = {
  key: string
  value: string
  sensitive?: boolean
}

export type McpServerSnapshot = {
  id: string
  name: string
  slug: string
  transport: McpTransportKind
  target: string
  enabled: boolean
  state: McpServerState
  toolCount: number
  toolNames: string[]
  /** http: the configured custom headers (values raw; UI masks sensitive ones). */
  headers?: McpHeader[]
  serverName?: string
  serverVersion?: string
  error?: string
  /** Live connect-progress line, present only while state is `connecting`. */
  progress?: string
  lastConnectedAt?: number
}

export type McpTestResult = {
  ok: boolean
  toolCount?: number
  durationMs?: number
  error?: string
}

export type McpAddInput = {
  name?: string
  target: string
  env?: Record<string, string>
  /** http custom headers. Ignored for stdio targets. */
  headers?: McpHeader[]
}

export type McpAddResult = { ok: true; server: McpServerSnapshot } | { ok: false; error: string }

export type McpApi = {
  list: () => Promise<McpServerSnapshot[]>
  add: (input: McpAddInput) => Promise<McpAddResult>
  remove: (id: string) => Promise<{ ok: boolean; error?: string }>
  setEnabled: (id: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>
  setHeaders: (id: string, headers: McpHeader[]) => Promise<{ ok: boolean; error?: string }>
  test: (id: string) => Promise<McpTestResult>
  authorize: (id: string) => Promise<{ ok: boolean; error?: string }>
  onStatusChange: (callback: (servers: McpServerSnapshot[]) => void) => () => void
}

export type SttConfig = {
  defaultModel: string
  /** Pinned transcription language: ISO 639-1/Whisper code, `auto`, or '' (= the `en` default). */
  language: string
}

export type TtsConfig = {
  defaultVoice: string
  defaultSpeed: string
  /** Voice prompts get spoken replies (default ON) — a model directive, mirrored from workspace.ts. */
  voiceReplies: boolean
}

export type Variable = {
  name: string
  value: string
  sensitive: boolean
}

export type WeekStartsOn = 0 | 1

export type WorkspaceConfig = {
  version: 1
  launchAtStartup?: boolean
  ollamaModelsFolder?: string
  llm: {
    local: LocalModelConfig
    providers: CloudProviderConfig[]
    /** The single user-chosen cloud model — the Brain. */
    brain?: BrainSelection | null
    /** Chat mode: 'single' (default, solo turns) vs 'workflow' (model-led agents). */
    mode?: 'single' | 'workflow'
    localOnly?: boolean
    restrictPowerfulModels?: boolean
    /** Per-model thinking mode. Key is model name, value is ThinkingMode. */
    thinkingModes?: Record<string, ThinkingMode>
  }
  safety?: SafetyConfig
  weekStartsOn?: WeekStartsOn
  variables?: Variable[]
  telegram?: TelegramConfig
  whatsapp?: WhatsAppConfig
  inapp?: InAppConfig
  stt?: SttConfig
  tts?: TtsConfig
  computerUse?: ComputerUseConfig
  browserExtension?: BrowserExtensionConfig
  updates?: UpdatesConfig
  lastSettingsState?: {
    tab?: string
    provider?: string
    channel?: string
    service?: string
    knowledgeTab?: string
    sidebarCollapsed?: string
    rightSidebarCollapsed?: string
  }
  locale: Locale
  theme: ThemeSource
  onboardingCompleted: boolean
}

export type WorkspaceStatus = {
  rootPath: string
  initialized: boolean
  hasLocalModel: boolean
  onboardingCompleted: boolean
  config: WorkspaceConfig | null
}

export type OllamaTag = { name: string; size: number }

/**
 * Main's background read of the daemon: up or not, and what it holds. Kept
 * current by a watch that pushes `ollama:changed` only when the answer
 * differs, so the renderer holds the flag before any surface asks for it.
 */
export type OllamaSnapshot = { reachable: boolean; installed: OllamaTag[] }

export type PullProgressEvent = {
  modelName: string
  status: string
  completed: number | null
  total: number | null
}

export type PullDoneEvent =
  | { modelName: string; ok: true }
  | { modelName: string; ok: false; error: string; aborted: boolean }

export type SelectModelResult =
  | { ok: true; alreadyDownloaded?: boolean; alreadyRunning?: boolean }
  | { ok: false; error: string; aborted: boolean }

export type PersistedApproval = {
  approvalId: string
  toolCallId: string
  tool: string
  args: Record<string, unknown>
  reason: string
  level: DangerLevel
  description?: ApprovalDescription
  decision?: ApprovalDecision
}

export type PersistedToolTiming = {
  startedAt: number
  endedAt?: number
}

export type MessageAttachmentType = 'audio' | 'video' | 'image' | 'pdf' | 'other'

export type MessageAttachment = {
  type: MessageAttachmentType
  /** Path relative to workspace root, e.g. "uploads/conv-2026-05-01_14-30-45/photo.png". */
  filePath: string
  originalName: string
  mimeType: string
  sizeBytes: number
  width?: number
  height?: number
  durationSeconds?: number
}

export type ConversationMessage = {
  /**
   * Stable per-message identity, unique within one conversation — the
   * reconciliation key mergeConversationOnto unions transcripts by (dual
   * decl — see src/main/conversations.ts for the full contract). Optional
   * only for files written before the field shipped.
   */
  id?: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  segments?: Segment[]
  approvals?: Record<string, PersistedApproval>
  toolTimings?: Record<string, PersistedToolTiming>
  stopReason?: SegmentTurnEndReason
  error?: string
  attachments?: MessageAttachment[]
  /** Set when this user message is a voice transcript — the audio attachment must not be exposed to the LLM. */
  voicePrompt?: boolean
  /** Whisper's detected language for a voicePrompt message (ISO 639-1). */
  voiceLang?: string
  /**
   * A user-role message the APP wrote, not the person — the "Continue"
   * after a stalled provider call, say. It rides history as a user turn (so
   * provider alternation holds and the model reads it as a system aside)
   * but renders as a muted note, never as the person's own bubble.
   */
  systemAside?: boolean
}

export type ConversationChannel =
  | 'electron'
  | 'telegram'
  | 'whatsapp'
  | 'mobile'
  | 'cli'
  | 'heartbeat'
  | 'procedure'

export type TimelineEntry = {
  id: string
  timestamp: number
  kind: string
  summary?: string
  detail?: string
}

/** Frozen roll-up of the most recent completed turn (dual decl — see src/main/conversations.ts). */
export type ConversationTurnStats = {
  endedAt: number
  elapsedMs: number
  apiMs: number
  apiCalls: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  cost: number
  provider: string | null
  model: string | null
}

/** Persisted per-conversation tokenomics (dual decl — see src/main/conversations.ts). */
export type ConversationStats = {
  /**
   * Lifetime totals for this conversation. Includes workflow-agent spend;
   * accrues from the first turn after this feature shipped for pre-existing
   * conversations.
   */
  allTime: {
    processingMs: number
    apiMs: number
    turns: number
    apiCalls: number
    toolCalls: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    cost: number
  }
  lastTurn: ConversationTurnStats | null
  /**
   * Context-meter snapshot at last save. `model` records which model the
   * reading was measured under so a reload never divides an old model's
   * numerator by a different model's window.
   */
  meter: {
    contextTokens: number
    contextBudget: number
    compactionAt?: number | null
    model?: string | null
  } | null
}

export type ConversationFile = {
  id: string
  title: string
  model: string | null
  messages: ConversationMessage[]
  createdAt: number
  updatedAt: number
  channel?: ConversationChannel
  /** Binds this conversation to a project (dual decl — see src/main/conversations.ts). */
  projectId?: string
  /** Source emoji (automation/procedure icon) for the rail's number-chip badge. */
  icon?: string
  sealed?: boolean
  workingFolder?: string[] | null
  /** Reference files for every turn — seeded by a procedure's Play (dual decl — see src/main/conversations.ts). */
  contextFiles?: string[] | null
  /** Legacy meter snapshot — superseded by `stats.meter`, still read as a fallback. */
  contextMeter?: { contextTokens: number; contextBudget: number } | null
  stats?: ConversationStats | null
  timeline?: TimelineEntry[]
  /** Rolling prefix summary — see src/main/conversations.ts (dual decl). */
  summary?: string | null
  /**
   * First message index NOT covered by `summary` (always a user message).
   * Legacy positional form — the id form below wins when it resolves.
   */
  summarizedThroughMessage?: number | null
  /** Id of the first message NOT covered by `summary` — survives id-keyed merges that insert before the mark (dual decl — see src/main/conversations.ts). */
  summarizedThroughMessageId?: string | null
}

export type ConversationMeta = {
  id: string
  title: string
  updatedAt: number
  channel?: ConversationChannel
  projectId?: string
  /** Source emoji (automation/procedure icon) for the rail's number-chip badge. */
  icon?: string
  messageCount: number
}

export type ChatHistoryAttachment = {
  type: MessageAttachmentType
  filePath: string
  originalName: string
  mimeType: string
  sizeBytes: number
}

export type ChatHistoryMessage =
  | {
      role: 'user'
      content: string
      attachments?: ChatHistoryAttachment[]
      reasoningContent?: string
      /** App-written aside (see ConversationMessage.systemAside). */
      systemAside?: boolean
    }
  | {
      role: 'assistant'
      content: string
      toolUses?: Array<{ id: string; name: string; args: Record<string, unknown> }>
      reasoningContent?: string
    }
  | {
      role: 'tool'
      toolUseId: string
      toolName: string
      content: string
      isError?: boolean
    }
export type ChatDoneEvent = { turnId: string; conversationId: string | null }
export type ChatErrorEvent = { turnId: string; conversationId: string | null; error: string }

/**
 * Turn lifecycle broadcast (chat:turnState) — fired for EVERY channel's
 * turns (in-app, WhatsApp, Telegram) so the Conversations sidebar can show
 * live status chips without owning the turn.
 */
export type ChatTurnStateEvent = {
  phase: 'started' | 'done' | 'canceled' | 'error'
  turnId: string
  conversationId: string | null
  channel: string
  title?: string | null
  error?: string
}

/**
 * One conversation with a turn in flight right now, on any channel
 * (chat:activeRuns). The lifecycle broadcast above only carries
 * TRANSITIONS, so a window that opened mid-run — the normal case for a tray
 * app whose Telegram/WhatsApp channels keep running with no window — needs
 * this snapshot to render those conversations as running.
 */
export type ChatActiveRun = {
  conversationId: string
  channel: string
  title: string | null
}

export type ChatTurnEvent = {
  turnId: string
  conversationId: string | null
  type:
    | 'context.built'
    | 'llm.response'
    | 'turn.usage'
    | 'task.created'
    | 'task.stepCompleted'
    | 'task.completed'
    | 'task.failed'
    | 'task.stopped'
    | 'tool.called'
    | 'tool.completed'
    | 'tool.failed'
    | 'safety.allowed'
    | 'safety.blocked'
    | 'safety.approved'
    | 'safety.denied'
    | 'compaction.started'
    | 'compaction.applied'
  payload: Record<string, unknown>
}

export type DangerLevel = 'safe' | 'warn' | 'confirm' | 'destructive' | 'block'
export type ApprovalDecision = 'approved' | 'denied' | 'approved_session'

export type RiskLevel = 'low' | 'medium' | 'high'

export type ApprovalDescription = {
  title: string
  description: string
  command?: string
  impact?: string
  risk: RiskLevel
}

export type ChatApprovalRequestEvent = {
  turnId: string
  conversationId: string | null
  id: string
  toolCallId: string
  tool: string
  args: Record<string, unknown>
  level: DangerLevel
  reason: string
  description?: ApprovalDescription
}

/** One selectable choice on an ask-the-user question card. */
export type AskUserOption = {
  label: string
  description?: string
}

/** One question on an ask-the-user card. A card carries 1..N of these. */
export type AskUserQuestion = {
  question: string
  details?: string
  options: AskUserOption[]
  allowOther: boolean
  otherLabel?: string
  otherDescription?: string
}

/** The user's answer to ONE question on the card. */
export type AskUserAnswer = { kind: 'option'; index: number } | { kind: 'custom'; text: string }

/**
 * The user's response to a whole question card, sent back to the main
 * process once — `answers[i]` answers `questions[i]`, and the card only
 * submits when every question is answered.
 */
export type AskUserResponse =
  | { kind: 'answered'; answers: AskUserAnswer[] }
  | { kind: 'canceled' }
  | { kind: 'unsupported' }

/** Emitted when the agent asks the user multiple-choice question(s). */
export type ChatAskRequestEvent = {
  turnId: string
  conversationId: string | null
  id: string
  toolCallId: string
  questions: AskUserQuestion[]
}

export type ChatCredentialBlockedEvent = {
  turnId: string
  conversationId: string | null
  type: string
}

export type ThemeApi = {
  get: () => Promise<ThemeState>
  set: (source: ThemeSource) => Promise<ThemeState>
  onUpdated: (listener: (state: ThemeState) => void) => () => void
}

export type LocaleApi = {
  get: () => Promise<Locale>
  set: (locale: Locale) => Promise<Locale>
}

export type SystemApi = {
  getInfo: () => Promise<SystemInfo>
}

export type WorkspaceApi = {
  getStatus: () => Promise<WorkspaceStatus>
  completeOnboarding: () => Promise<WorkspaceConfig>
  getModelCatalog: () => Promise<readonly ModelEntry[]>
}

export type AppClosingPendingEvent = { tasks: number; reason?: 'quit' | 'reboot' }

export type AppApi = {
  factoryReset: () => Promise<void>
  /** Drain and relaunch. Resolves before the process goes down; the overlay follows by broadcast. */
  reboot: () => Promise<{ scheduled: boolean }>
  onClosingPending: (listener: (event: AppClosingPendingEvent) => void) => () => void
}

export type DataAnalytics = {
  workspaceBytes: number
  hippocampusBytes: number
  corpusBytes: number
  prefrontalBytes: number
  ramBytes: number
  cpuPercent: number
  totalRamBytes: number
  cpuCount: number
}

export type DataApi = {
  getAnalytics: () => Promise<DataAnalytics>
}

/** Which service's config changed — the panels re-seed from this. */
export type ServicesChangedPayload = {
  service: 'brave' | 'memes' | 'stt' | 'tts' | 'computerUse' | 'browserExtension' | 'video'
}

/** Video generation (MiniMax H3) service config — its own key, see VideoApi. */
export type VideoConfig = {
  apiKey: string
  /**
   * Director mode: ON, the chat model expands video requests into cinematic
   * prompts (and shows the user what it sent); OFF, it forwards the user's
   * prompt verbatim. A model directive only — nothing is enforced.
   */
  director: boolean
}

export type VideoServiceStatus = {
  /** A key is saved. */
  configured: boolean
  /** The saved key was accepted by MiniMax (probe costs nothing). */
  reachable: boolean
  /** Human-readable detail: ready, the remedy, or the failure. */
  detail: string
}

export type VideoApi = {
  getConfig: () => Promise<VideoConfig>
  /**
   * Save the key. Deliberately independent of the MiniMax entry under
   * Settings → Providers: MiniMax issues one credential that unlocks both
   * APIs, but video generation is a service that must keep working when
   * the chat brain changes provider, so the value is entered in both
   * places rather than shared.
   */
  setConfig: (patch: Partial<VideoConfig>) => Promise<{ ok: true; config: VideoConfig }>
  /** Validate the saved key against MiniMax without spending a generation. */
  test: () => Promise<VideoServiceStatus>
}

export type ServicesApi = {
  /**
   * A service's config was saved — by this window, another window, or the
   * paired phone over the tunnel. Payload names the service so a panel can
   * ignore everyone else's changes.
   */
  onChanged: (listener: (payload: ServicesChangedPayload) => void) => () => void
}

export type LaunchAtStartupStatus = { active: boolean }

/** What a preferences:changed broadcast carries — only the fields that were saved. */
export type PreferencesPatch = {
  launchAtStartup?: boolean
  bypassPermissions?: boolean
  blockCredentials?: boolean
  restrictPowerfulModels?: boolean
  weekStartsOn?: WeekStartsOn
}

export type RuntimeApi = {
  setLaunchAtStartup: (value: boolean) => Promise<{ value: boolean; active: boolean }>
  getLaunchAtStartupStatus: () => Promise<LaunchAtStartupStatus>
  setBypassPermissions: (value: boolean) => Promise<{ value: boolean }>
  setBlockCredentials: (value: boolean) => Promise<{ value: boolean }>
  setLocalOnly: (value: boolean) => Promise<{ value: boolean }>
  setRestrictPowerfulModels: (value: boolean) => Promise<{ value: boolean }>
  setThinkingMode: (model: string, mode: ThinkingMode) => Promise<void>
  setUpdatesEnabled: (value: boolean) => Promise<{ value: boolean }>
  setWeekStartsOn: (value: WeekStartsOn) => Promise<{ value: WeekStartsOn }>
  setLastSettingsState: (patch: Record<string, string>) => Promise<void>
  /** A preference saved anywhere — this window, another window. Payload is the patch. */
  onPreferencesChanged: (listener: (patch: PreferencesPatch) => void) => () => void
  /** A paired phone wrote settings over the tunnel — the applied patch rides along. */
  onMobileSettingsChange: (
    listener: (payload: { keys: string[]; settings?: Record<string, unknown> }) => void
  ) => () => void
  getCompactionConfig: () => Promise<CompactionConfig>
  setCompactionConfig: (patch: Partial<CompactionConfig>) => Promise<CompactionConfig>
  getCompactionRuns: () => Promise<CompactionRuns>
  onCompactionChanged: (listener: (payload: unknown) => void) => () => void
  /**
   * The compaction CONFIG changed — this window, another window, or the paired
   * phone. Distinct from onCompactionChanged, which announces a finished run:
   * this one carries the saved config, so a panel (and the floating run card)
   * adopts a flip made anywhere without refetching.
   */
  onCompactionConfigChanged: (listener: (config: CompactionConfig) => void) => () => void
  getReflectionConfig: () => Promise<ReflectionConfig>
  setReflectionConfig: (patch: Partial<ReflectionConfig>) => Promise<ReflectionConfig>
  runReflectionNow: () => Promise<'running' | 'queued' | 'coalesced'>
  runDeepCleanNow: () => Promise<'running' | 'queued' | 'coalesced'>
  onReflectionChanged: (listener: (payload: unknown) => void) => () => void
}

export type CompactionConfig = {
  dailyHour: number
  weeklyDay: number
  weeklyHour: number
}

/** Last completed run of a compaction job (mirrors brainstem's type). */
export type CompactionRunRecord = {
  at: number
  durationMs: number
  /** Null for the weekly digest — that pass makes no LLM call. */
  provider: string | null
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  output: string
}

export type CompactionRuns = {
  daily: CompactionRunRecord | null
  weekly: CompactionRunRecord | null
  /** Nightly reflection pass (mirrors brainstem's type; absent pre-feature). */
  reflection?: CompactionRunRecord | null
  /** Monthly adversarial deep clean. */
  deepClean?: CompactionRunRecord | null
}

/** Mirrors workspace's ReflectionConfig (dual decl). Reflection + deep clean are core — no off switches, only the hour. */
export type ReflectionConfig = {
  hour: number
  quietHours: number
}

export type OllamaModelDetail = {
  name: string
  tag: string
  fullName: string
  sizeBytes: number
  family: string | null
  parameterSize: string | null
  quantization: string | null
  format: string | null
}

export type OllamaApi = {
  detect: () => Promise<{ reachable: boolean; installed: boolean }>
  installUrl: () => Promise<string>
  openInstallPage: () => Promise<{ opened: boolean }>
  start: () => Promise<{ ok: boolean; error?: string }>
  listInstalled: () => Promise<OllamaTag[]>
  /** The watch's settled answer right now — seeds the renderer cache at boot. */
  snapshot: () => Promise<OllamaSnapshot>
  /** Fires only when reachability or the installed list actually changes. */
  onChanged: (listener: (snapshot: OllamaSnapshot) => void) => () => void
  scanAvailable: () => Promise<OllamaModelDetail[]>
  getModelsFolder: () => Promise<string>
  setModelsFolder: (folder: string) => Promise<{ ok: true; folder: string }>
  pickModelsFolder: () => Promise<string | null>
}

export type ModelCapabilities = {
  provider: string | null
  model: string | null
  supportsVision: boolean
  contextWindow: number
  /** Token count where auto-compaction triggers for this model. */
  compactionAt: number
}

export type ModelApi = {
  select: (modelName: string) => Promise<SelectModelResult>
  cancelPull: () => Promise<{ canceled: boolean }>
  status: () => Promise<{ model: string | null }>
  capabilities: () => Promise<ModelCapabilities>
  onPullProgress: (listener: (event: PullProgressEvent) => void) => () => void
  onPullDone: (listener: (event: PullDoneEvent) => void) => () => void
}

export type ProviderListEntry = {
  id: CloudProviderConfig['id']
  model: string
  apiKey: string
  models?: string[]
  reasoningModels?: string[]
}

export type ProviderTestErrorKind =
  | 'invalid_key'
  | 'rate_limited'
  | 'invalid_model'
  | 'network'
  | 'generic'

export type ProviderTestResult =
  | { ok: true; models: string[]; reasoningModels?: string[] }
  | { ok: false; kind: ProviderTestErrorKind; message?: string }

// `id` is null for events not tied to a specific provider (e.g. the Brain
// was cleared). Listeners that filter by provider id simply won't match.
export type ProviderUpdatedEvent = { id: CloudProviderConfig['id'] | null }

/** The single user-chosen cloud model — the Brain. */
export type BrainSelection = { providerId: CloudProviderConfig['id']; model: string }

export type ProviderApi = {
  list: () => Promise<ProviderListEntry[]>
  test: (payload: { id: CloudProviderConfig['id']; apiKey?: string }) => Promise<ProviderTestResult>
  save: (payload: {
    id: CloudProviderConfig['id']
    model: string
    apiKey?: string
    models?: string[]
    reasoningModels?: string[]
  }) => Promise<{ ok: true } | { ok: false; error: string }>
  remove: (id: CloudProviderConfig['id']) => Promise<{ ok: true }>
  setBrain: (brain: BrainSelection | null) => Promise<{ ok: true }>
  setMode: (mode: 'single' | 'workflow') => Promise<{ ok: true }>
  onUpdated: (listener: (event: ProviderUpdatedEvent) => void) => () => void
}

// Canonical reasoning scale (see src/main/runtime/reasoning.ts). Inlined here
// to keep the preload bundle decoupled from main.
export type ThinkingMode = 'off' | 'on' | 'high' | 'max'

export type ChatApi = {
  send: (payload: {
    history: ChatHistoryMessage[]
    conversationId?: string | null
    /**
     * The feed id of the user message this turn sends. The titler may
     * pre-persist that same logical message (the titled shell for a first
     * in-app turn) — stamping it with THIS id is what lets the renderer's
     * end-of-turn save reconcile with the shell instead of duplicating it.
     */
    userMessageId?: string
    /**
     * The feed id of the assistant message this turn will stream into. Main
     * checkpoints the turn-so-far to disk under this id while it runs, so the
     * end-of-turn save reconciles with the checkpoint by id instead of leaving
     * a duplicate — and so a crash or a machine restart mid-run leaves the run
     * on disk rather than the prompt alone.
     */
    assistantMessageId?: string
    /** Active working-folder paths — the agent injects fresh listings into the outbound volatile tail. */
    workingFolders?: string[]
    /**
     * Reference files this conversation's turns are told about (name, size,
     * path) and read with their own tools — never injected. Seeded by a
     * procedure's Play from that procedure's own attachments.
     */
    contextFiles?: string[]
    thinkingMode?: ThinkingMode
    /** Per-turn chat-mode override (procedure Play honors the procedure's stamp). */
    modeOverride?: 'single' | 'workflow'
    /** Project this conversation runs inside — overlays its context on the turn. */
    projectId?: string | null
    /**
     * Plan mode: a read-only turn that may only write the conversation's
     * plan file. The composer's Plan chip sets it per conversation.
     */
    planMode?: boolean
  }) => Promise<{ turnId: string; ok: boolean; error?: string }>
  /**
   * Cancel one conversation's in-flight turn; omitted id cancels all. Works
   * whatever channel started the turn — an in-app Stop on a mirrored
   * Telegram/WhatsApp run aborts it through the shared TurnRunner.
   */
  cancel: (payload?: { conversationId?: string | null }) => Promise<{ canceled: boolean }>
  /** Conversations running RIGHT NOW, any channel (window cold-start seed). */
  activeRuns: () => Promise<ChatActiveRun[]>
  /** One conversation's plan-mode stance, held in main and shared with the phone. */
  getPlanMode: (conversationId: string) => Promise<boolean>
  /** Set it; every window and the paired phone hear the change via onPlanMode. */
  setPlanMode: (payload: { conversationId: string; planMode: boolean }) => Promise<boolean>
  onPlanMode: (
    listener: (change: { conversationId: string; planMode: boolean }) => void
  ) => () => void
  /**
   * The newest live-mirror snapshot of one running conversation's in-progress
   * assistant message, or null when nothing is cached (no run, or the turn
   * has produced nothing yet). activeRuns says a run exists; this is what it
   * has written so far — the seed that lets a window opened mid-run draw the
   * turn instead of a bare thinking bubble until the next mirror tick.
   */
  turnMirror: (conversationId: string) => Promise<ConversationMessage | null>
  respondApproval: (payload: { id: string; decision: ApprovalDecision }) => Promise<{ ok: boolean }>
  respondAsk: (payload: { id: string; response: AskUserResponse }) => Promise<{ ok: boolean }>
  /** Save-dialog + Chromium print of a renderer-built transcript HTML. */
  exportPdf: (payload: {
    html: string
    fileName: string
  }) => Promise<{ ok: boolean; canceled?: boolean; error?: string }>
  onSegment: (
    listener: (segment: Segment & { conversationId?: string | null }) => void
  ) => () => void
  onDone: (listener: (event: ChatDoneEvent) => void) => () => void
  onError: (listener: (event: ChatErrorEvent) => void) => () => void
  onTurnEvent: (listener: (event: ChatTurnEvent) => void) => () => void
  onApprovalRequest: (listener: (event: ChatApprovalRequestEvent) => void) => () => void
  onAskRequest: (listener: (event: ChatAskRequestEvent) => void) => () => void
  onCredentialBlocked: (listener: (event: ChatCredentialBlockedEvent) => void) => () => void
  /** Turn lifecycle across ALL channels — backs the sidebar status chips. */
  onTurnState: (listener: (event: ChatTurnStateEvent) => void) => () => void
  /**
   * Hand a message to the conversation's RUNNING turn (any channel's — the
   * inbox is keyed by conversation). The agent reads it at its next stop
   * point and echoes it back as a `user_message` segment carrying the same
   * messageId. `no_live_turn` means exactly that: send it as a normal turn.
   * Attachments are staged on disk first, exactly as for `send`.
   */
  interject: (payload: {
    conversationId: string
    messageId: string
    text: string
    attachments?: MessageAttachment[]
    voicePrompt?: boolean
    voiceLang?: string
  }) => Promise<InterjectVerdict>
  /** Take a still-unread message back. False once the agent has read it. */
  withdrawInterjection: (payload: { conversationId: string; messageId: string }) => Promise<boolean>
  /** Messages parked for a conversation and not read yet — the cold-start seed for the pending bubbles. */
  pendingInterjections: (conversationId: string) => Promise<ChatInterjection[]>
  /**
   * Let go of a HELD message once this window has put its words back in the
   * composer. Only a `held` row (its run was stopped) can be released this
   * way — see the field's note.
   */
  releaseHeldInterjection: (payload: {
    conversationId: string
    messageId: string
  }) => Promise<boolean>
  /** Mid-turn message lifecycle (pending / delivered / withdrawn), every surface's messages included. */
  onInterjection: (listener: (event: ChatInterjectionEvent) => void) => () => void
}

/** Lifecycle event of one mid-turn message — mirrors runtime/agent/interjection.ts InterjectionEvent. */
export type ChatInterjectionEvent = InterjectionEvent
/** One parked mid-turn message, as chat:pendingInterjections returns it. */
export type ChatInterjection = Interjection & {
  /**
   * True for a message the durable park is HOLDING rather than queuing: its
   * run was stopped before the agent read it, so it is never auto-resent and
   * never waiting on a stop point. The window that opens the conversation puts
   * it back in the composer instead of drawing a pending bubble — otherwise it
   * would be a row promising a delivery that will never come.
   */
  held?: boolean
}

export type ConversationSummaryUpdate = {
  conversationId: string
  summary: string
  summarizedThroughMessage: number
  /** Id of the first uncovered message — null while a transition file still lacks message ids. */
  summarizedThroughMessageId: string | null
}

export type TaskApi = {
  /** Cancel a queued/running async generation task (the task card's stop). */
  cancel: (taskId: string) => Promise<{ ok: boolean; error?: string }>
  /**
   * Fired on every async-task snapshot change (task:changed) — status
   * transitions, artifact download — including after the owning turn ended.
   * The renderer upserts the snapshot into the matching `task` segment and
   * folds it into its in-memory conversation so the next whole-file save
   * carries it.
   */
  onChanged: (listener: (snapshot: TaskSnapshot) => void) => () => void
}

/**
 * Wolffish's own browser — the in-app pages the model opens, each a live
 * card in the chat. Main owns every tab (a WebContentsView z-parked under the
 * app UI); the renderer only draws frames, reports the card's rect, and
 * flips the same tab between card and expanded.
 */
export type BrowserApi = {
  createTab: (input: {
    url: string
    conversationId: string | null
    partition?: BrowserPartition
  }) => Promise<BrowserTabSnapshot>
  closeTab: (tabId: string) => Promise<void>
  listTabs: () => Promise<BrowserTabSnapshot[]>
  navigate: (tabId: string, url: string) => Promise<BrowserTabSnapshot>
  goBack: (tabId: string) => Promise<BrowserTabSnapshot>
  goForward: (tabId: string) => Promise<BrowserTabSnapshot>
  reload: (tabId: string) => Promise<BrowserTabSnapshot>
  /** A card is on screen: start (refcounted) the screencast at this size and rate. */
  attachViewer: (
    tabId: string,
    size: { width: number; height: number },
    fps: BrowserFps
  ) => Promise<void>
  detachViewer: (tabId: string) => Promise<void>
  setViewerFps: (tabId: string, fps: BrowserFps) => Promise<void>
  /** The card's device-pixel size changed (resize, dpr change). */
  setViewerSize: (tabId: string, size: { width: number; height: number }) => Promise<void>
  /** Make this tab the one the conversation's browser shows. */
  activate: (tabId: string) => Promise<void>
  /** Mouse/keyboard from the card, in the page's CSS pixels. Fire-and-forget. */
  sendInput: (tabId: string, event: BrowserInputEvent) => Promise<void>
  /** Hand an http(s) URL to the system's default browser. */
  openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>
  /** The expanded host's rect in window CSS pixels; null when collapsed. Main clamps. */
  setStageRect: (tabId: string, rect: BrowserRect | null) => Promise<void>
  setMode: (tabId: string, mode: BrowserTabMode) => Promise<BrowserTabSnapshot>
  /** Screencast frames (JPEG bytes). High-frequency: decode off the main thread. */
  onFrame: (listener: (frame: BrowserFrame) => void) => () => void
  /** Every tab state change (browser:changed), including after the opening turn ended. */
  onChanged: (listener: (snapshot: BrowserTabSnapshot) => void) => () => void
  onClosed: (
    listener: (payload: { tabId: string; reason: BrowserCloseReason }) => void
  ) => () => void
}

export type CountdownApi = {
  /** The countdown card's Abort: stops a pending turn-end countdown for good. */
  abort: (countdownId: string) => Promise<{ ok: boolean; error?: string }>
  /**
   * Fired on every countdown transition (countdown:changed) — counting,
   * fired, aborted, failed — all of which happen after the arming turn
   * ended. The renderer folds the snapshot into the matching `countdown`
   * segment (by countdownId) and into its in-memory conversation.
   */
  onChanged: (listener: (snapshot: CountdownSnapshot) => void) => () => void
}

export type ProcessesApi = {
  list: () => Promise<ProcessRecord[]>
  start: (payload: {
    name: string
    command: string
    cwd?: string
    env?: Record<string, string>
    port?: ProcessPortPolicy
    restart?: RestartPolicy
    onQuit?: 'keep' | 'stop'
    autostart?: ProcessAutostart
  }) => Promise<{ ok: boolean; error?: string; record?: ProcessRecord }>
  stop: (name: string) => Promise<{ ok: boolean; stopped: boolean; error?: string }>
  stopAll: () => Promise<Array<{ name: string; stopped: boolean }>>
  restart: (name: string) => Promise<{ ok: boolean; error?: string; record?: ProcessRecord }>
  update: (payload: {
    name: string
    command?: string
    cwd?: string
    env?: Record<string, string>
    port?: ProcessPortPolicy
    restart?: RestartPolicy
    onQuit?: 'keep' | 'stop'
    autostart?: ProcessAutostart
    newName?: string
  }) => Promise<{ ok: boolean; error?: string; record?: ProcessRecord; warning?: string }>
  remove: (name: string) => Promise<{ ok: boolean; error?: string }>
  logs: (name: string, lines?: number) => Promise<string>
  ports: () => Promise<Array<ListeningPort & { managed: string | null }>>
  /** Fired on every registry write (processes:changed); payload-free — re-list. */
  onChanged: (listener: () => void) => () => void
  /**
   * A process card's snapshot changed after its turn ended
   * (process:cardChanged). The renderer folds it into the matching
   * `process` segment by cardId.
   */
  onCardChanged: (listener: (snapshot: ProcessCardSnapshot) => void) => () => void
}

export type ConversationApi = {
  list: () => Promise<ConversationMeta[]>
  load: (id: string) => Promise<ConversationFile | null>
  save: (conv: ConversationFile) => Promise<{ ok: true }>
  /** ok:false ⇒ refused (conversation has a turn in flight). */
  delete: (id: string) => Promise<{ ok: boolean }>
  create: (model: string | null) => Promise<ConversationFile>
  /**
   * Fired when the main-side rolling summarizer persisted a new prefix
   * summary. The renderer folds it into its in-memory conversation so the
   * next whole-file save preserves it and the next send replays lean.
   */
  onSummaryUpdated: (listener: (update: ConversationSummaryUpdate) => void) => () => void
  /**
   * Fired when a conversation was deleted anywhere (in-app History OR a
   * channel /delete). The sidebar prunes its live run-status so a
   * channel-side delete doesn't leave a ghost row.
   */
  onDeleted: (listener: (event: { id: string }) => void) => () => void
  /**
   * Fired when the conversation list-visible set may have changed on disk (a
   * conversation was created, renamed, appended, or removed and re-indexed).
   * Covers paths that emit no turn lifecycle — autonomous heartbeat/procedure
   * runs, create-without-turn, the sensitive-data gate — so the rail and
   * History refetch. Payload-free: the listener just re-lists.
   */
  onChanged: (listener: () => void) => () => void
  /**
   * Fired repeatedly while a Telegram/WhatsApp turn is IN FLIGHT — a live
   * snapshot of its in-progress assistant message so an in-app viewer of the
   * same conversation mirrors the run as it streams, not only at end-of-turn.
   * The message id is stable for the turn and matches the record the save
   * later writes, so the renderer upserts by id (never a duplicate).
   */
  onMessageMirror: (
    listener: (payload: { conversationId: string; message: ConversationMessage }) => void
  ) => () => void
}

export type ViewerTreeNode =
  | { type: 'dir'; name: string; relativePath: string; children: ViewerTreeNode[] }
  | { type: 'file'; name: string; relativePath: string }

export type UsageTimeRange = 'today' | 'this_month' | '3_months' | '6_months' | 'ytd' | 'all_time'

export type UsageProviderSummary = {
  provider:
    | 'anthropic'
    | 'openai'
    | 'openrouter'
    | 'deepseek'
    | 'mimo'
    | 'kimi'
    | 'minimax'
    | 'xai'
    | 'qwen'
    | 'stepfun'
    | 'zai'
    | 'local'
  totalInputTokens: number
  totalOutputTokens: number
  totalCost: number
  models: Array<{ model: string; inputTokens: number; outputTokens: number; cost: number }>
}

export type BraveUsageSummary = {
  totalQueries: number
  totalCost: number
}

export type UsageSummary = {
  providers: UsageProviderSummary[]
  brave: BraveUsageSummary
}

export type UsageStats = {
  messages: number
  conversations: number
  activeDays: number
  longestStreak: number
  totalTokens: number
  favouriteModel: string | null
  totalCost: number
  topSpendDay: { date: string; cost: number } | null
}

export type UsageDailyEntry = {
  date: string
  totalTokens: number
}

export type UsageApi = {
  getSummary: (range: UsageTimeRange) => Promise<UsageSummary>
  getStats: (range: UsageTimeRange) => Promise<UsageStats>
  getDaily: (year: number) => Promise<UsageDailyEntry[]>
  sync: () => Promise<{ ok: true }>
}

export type ViewerApi = {
  readTree: () => Promise<ViewerTreeNode[]>
  readFile: (relativePath: string) => Promise<string>
  readBinaryFile: (relativePath: string) => Promise<ArrayBuffer>
  writeFile: (relativePath: string, content: string) => Promise<void>
  hasDefault: (relativePath: string) => Promise<boolean>
  readDefault: (relativePath: string) => Promise<string>
  stat: (relativePath: string) => Promise<{ mtimeMs: number }>
  download: (relativePath: string) => Promise<{ ok: boolean }>
  revealInFolder: (relativePath: string) => Promise<{ ok: boolean }>
  resync: () => Promise<ViewerTreeNode[]>
  /**
   * One of the three customization documents (soul / user / agents) was
   * written — by this window, another window, or the paired phone. Carries the
   * workspace-relative path so a listener can ignore documents it is not
   * showing. Fires only for those three: every other workspace file has a
   * single editor and nothing to reconcile with.
   */
  onCustomizationChanged: (listener: (payload: { doc: string; path: string }) => void) => () => void
}

export type HeartbeatJobView = {
  id: string
  type: string
  cron: string | null
  label: string
  /**
   * The automation's display name (its `name: …` marker); null on a job that
   * predates the field, where the schedule heading stands in. The heading —
   * `label` — stays the identity the scheduler and the file grammar key on.
   */
  name: string | null
  body: string
  /** The job's own chat mode (its `mode: …` marker); null ⇒ follows global. */
  mode: 'single' | 'workflow' | null
  /** The job's own reasoning effort (its `thinking: …` marker); null ⇒ chat. */
  thinking: 'off' | 'on' | 'high' | 'max' | null
  nextRunMs: number | null
}

/**
 * Which family a pooled run belongs to (dual decl — see brainstem's RunFamily).
 * The run pool is shared by automations, the built-in compaction and
 * reflection jobs, and model-triggered procedure runs; consumers that mean
 * automations specifically (the Automations page's play-button gating) skip
 * `procedure` by this stamp rather than parsing job ids.
 */
export type RunFamily = 'automation' | 'compaction' | 'reflection' | 'procedure'

export type HeartbeatRunningJob = {
  id: string
  label: string
  body: string
  startedAt: number
  /** The run's own mode (stamped marker / procedure field); null ⇒ global. */
  mode: 'single' | 'workflow' | null
  /** Resolved in main from the job id — never re-derived here. */
  family: RunFamily
}

export type HeartbeatQueuedJob = {
  id: string
  label: string
  /** The job's own mode (stamped marker / procedure field); null ⇒ global. */
  mode: 'single' | 'workflow' | null
  queuedAt: number
  /** Resolved in main from the job id — never re-derived here. */
  family: RunFamily
}

/** Live run-pool state: up to 3 concurrent runs plus the FIFO overflow. */
export type HeartbeatRunsSnapshot = {
  running: HeartbeatRunningJob[]
  queued: HeartbeatQueuedJob[]
}

export type HeartbeatLogEntry = {
  id: string
  timestamp: number
  kind: 'text' | 'tool_call' | 'tool_result' | 'started' | 'completed' | 'failed' | 'skipped'
  summary: string
}

export type HeartbeatApi = {
  getJobs: () => Promise<HeartbeatJobView[]>
  /** Snapshot of the run pool — every running job plus the queued overflow. */
  getRuns: () => Promise<HeartbeatRunsSnapshot>
  /** Run an automation on demand by id or exact heading label, bypassing its schedule. */
  runJob: (idOrLabel: string) => Promise<{
    ok: boolean
    started: boolean
    /** Which kind of wait: 'queued' runs on its own, 'coalesced' never will. */
    state?: 'running' | 'queued' | 'coalesced'
    /** Runs holding the shared pool right now — what a queued fire waits behind. */
    running?: number
    error?: string
  }>
  /**
   * Per-job "Edited …" stamps (heading label → epoch ms), maintained in main
   * by diffing the file at every scheduler reload — so edits stamp no matter
   * which surface wrote them (card editor, markdown, the agent, external).
   */
  getMeta: () => Promise<Record<string, number>>
  /** One-shot donation of the legacy localStorage stamps; returns the merged map. */
  adoptMeta: (stamps: Record<string, number>) => Promise<Record<string, number>>
  /** The heartbeat file changed (any writer) — re-fetch jobs + meta. */
  onChanged: (listener: () => void) => () => void
  onJobStarted: (listener: (job: HeartbeatRunningJob) => void) => () => void
  onJobEnded: (
    listener: (payload: { id: string; status: 'completed' | 'failed'; error?: string }) => void
  ) => () => void
  onJobLog: (listener: (entry: HeartbeatLogEntry) => void) => () => void
  /** The run pool changed: a run started or ended, or the queue moved. */
  onRunsChanged: (listener: (snapshot: HeartbeatRunsSnapshot) => void) => () => void
}

/** One attached automation file (dual decl — see src/main/automations/files.ts). */
export type AutomationFileRef = {
  /** Absolute path inside the workspace — attaching COPIES the source in. */
  path: string
  name: string
}

/**
 * Live ticks while picked files are copied into the automation's uploads dir.
 * `copiedBytes`/`totalBytes` span the whole batch (dual decl — see
 * AttachFilesProgress in src/main/automations/files.ts).
 */
export type AutomationCopyProgress = {
  /** 1-based position of the file being copied. */
  index: number
  total: number
  name: string
  copiedBytes: number
  totalBytes: number
}

export type AutomationAttachResult = {
  added: AutomationFileRef[]
  /** Sources already attached under that name — not copied again. */
  skipped: string[]
  /** Sources that don't exist on disk. */
  missing: string[]
}

/**
 * The disk half of an automation's files and working directories. The LISTS
 * themselves live as `file:`/`dir:` marker lines in heartbeat.md and are
 * written by whoever edits that file — these calls only do what needs main:
 * the native pickers, the copy into the workspace, and deleting a copy we own.
 */
export type AutomationFilesApi = {
  /**
   * Native multi-select picker that COPIES the chosen files into this
   * automation's uploads dir. `existing` is its current file list, so the copy
   * lands in the dir it already owns. Returns null on cancel; the caller
   * writes the returned refs out as `file:` markers.
   */
  pickFiles: (existing: string[]) => Promise<AutomationAttachResult | null>
  /** Delete an attached file's copy. A path outside our uploads dir is left alone. */
  removeFile: (path: string) => Promise<{ ok: true }>
  /**
   * Copy progress for an in-flight pickFiles(). The FIRST tick means the
   * picker closed and bytes are moving — nothing fires while the user is
   * still browsing.
   */
  onCopyProgress: (listener: (progress: AutomationCopyProgress) => void) => () => void
}

/** One attached procedure file (dual decl — see src/main/procedures.ts). */
export type ProcedureFileRef = {
  /** Absolute path inside the workspace — attaching COPIES the source into uploads/procedure-<id>/. */
  path: string
  name: string
}

/**
 * Native path pickers that belong to no one feature — automations and
 * procedures both point runs at folders, and only main has `dialog`.
 */
export type DirectoryListing = import('@main/paths/paths').DirectoryListing

export type PathsApi = {
  /** Native multi-select folder picker. Returns null on cancel. */
  pickDirectories: () => Promise<string[] | null>
  /** One level of the server's folders, for the Web UI's folder sheet. `~` expands. */
  listDirectories: (target: string, options?: { hidden?: boolean }) => Promise<DirectoryListing>
}

export type Procedure = {
  id: string
  title: string
  prompt: string
  /** The procedure's own chat mode; absent (legacy rows) ⇒ follows global. */
  mode?: 'single' | 'workflow'
  /**
   * The procedure's own reasoning effort; absent (legacy rows) ⇒ follows the
   * chat's selected thinking mode. Stamped at creation from chat's pick.
   */
  thinking?: ThinkingMode
  /** Emoji shown on the card; absent (legacy rows) ⇒ the page's default. */
  icon?: string
  /** Project binding — runs get the project overlay and register under it. */
  projectId?: string
  /** Copied-in reference files every run is told about (never injected). */
  files?: ProcedureFileRef[]
  /** Working folders every run gets a fresh listing of. References, not copies. */
  directories?: string[]
  createdAt: number
  updatedAt: number
}

/**
 * Live ticks while picked files are copied into the procedure's uploads dir.
 * `copiedBytes`/`totalBytes` span the whole batch (dual decl — see
 * AttachFilesProgress in src/main/uploads/owned-copies.ts).
 */
export type ProcedureCopyProgress = {
  procedureId: string
  /** 1-based position of the file being copied. */
  index: number
  total: number
  name: string
  copiedBytes: number
  totalBytes: number
}

export type ProceduresApi = {
  list: () => Promise<Procedure[]>
  create: (payload: {
    title: string
    prompt: string
    mode?: 'single' | 'workflow'
    thinking?: ThinkingMode
    icon?: string
    projectId?: string
  }) => Promise<Procedure>
  update: (payload: {
    id: string
    title?: string
    prompt?: string
    mode?: 'single' | 'workflow'
    thinking?: ThinkingMode
    icon?: string
    projectId?: string
    /** Whole-list replace — detached copies WE own are deleted from disk. */
    files?: ProcedureFileRef[]
    /** Whole-list replace. References only, so nothing is deleted. */
    directories?: string[]
  }) => Promise<Procedure>
  delete: (id: string) => Promise<{ ok: true }>
  /**
   * Native multi-select picker that COPIES the chosen files into the
   * procedure's uploads dir and attaches them. Returns the updated procedure,
   * or null on cancel.
   */
  pickFiles: (procedureId: string) => Promise<Procedure | null>
  /** The store changed (any writer, incl. the agent's tools) — re-fetch the list. */
  onChanged: (listener: () => void) => () => void
  /**
   * Copy progress for an in-flight pickFiles(). The FIRST tick means the
   * picker closed and bytes are moving — nothing fires while the user is
   * still browsing.
   */
  onCopyProgress: (listener: (progress: ProcedureCopyProgress) => void) => () => void
}

export type ProjectFileRef = {
  /** Absolute path inside the workspace — attaching COPIES the source into uploads/project-<id>/ (dual decl — see src/main/projects.ts). */
  path: string
  name: string
}

export type Project = {
  id: string
  title: string
  /** Emoji icon (native emoji set — universal across OSes). */
  icon: string
  instructions: string
  files: ProjectFileRef[]
  /** Working folders every turn in the project gets a fresh listing of. */
  directories?: string[]
  /**
   * The project's own reasoning effort; absent (projects saved before the
   * field shipped) ⇒ follows the chat's selected thinking mode.
   */
  thinking?: ThinkingMode
  createdAt: number
  updatedAt: number
}

/**
 * Live ticks while picked files are copied into the project's uploads dir.
 * `copiedBytes`/`totalBytes` span the whole batch (dual decl — see
 * AttachFilesProgress in src/main/projects.ts).
 */
export type ProjectCopyProgress = {
  projectId: string
  /** 1-based position of the file being copied. */
  index: number
  total: number
  name: string
  copiedBytes: number
  totalBytes: number
}

export type ProjectsApi = {
  list: () => Promise<Project[]>
  create: (payload: { title: string; icon?: string; instructions?: string }) => Promise<Project>
  update: (payload: {
    id: string
    title?: string
    icon?: string
    instructions?: string
    thinking?: ThinkingMode
    files?: ProjectFileRef[]
    /** Whole-list replace. References only, so nothing is deleted. */
    directories?: string[]
  }) => Promise<Project>
  delete: (id: string) => Promise<{ ok: true }>
  /**
   * Native multi-select picker that COPIES the chosen files into the
   * project's uploads dir and attaches them. Returns the updated project,
   * or null on cancel.
   */
  pickFiles: (projectId: string) => Promise<Project | null>
  /** The store changed (any writer, incl. the agent's tools) — re-fetch the list. */
  onChanged: (listener: () => void) => () => void
  /**
   * Copy progress for an in-flight pickFiles(). The FIRST tick means the
   * picker closed and bytes are moving — nothing fires while the user is
   * still browsing.
   */
  onCopyProgress: (listener: (progress: ProjectCopyProgress) => void) => () => void
}

export type ReindexStatus = {
  startedAt: number
  total: number
  done: number
}

export type ReindexApi = {
  getStatus: () => Promise<ReindexStatus | null>
  onStarted: (listener: (status: { startedAt: number; total: number }) => void) => () => void
  onProgress: (listener: (status: { done: number; total: number }) => void) => () => void
  onEnded: (listener: (payload: { filesCount: number; durationMs: number }) => void) => () => void
}

/**
 * Per-conversation diagnostic export (dual decl — mirrors src/main/diagnostics.ts).
 * The overlay renders one localized line per step key, so the union here and
 * DIAGNOSTIC_STEPS there must stay in step.
 */
export type DiagnosticStep =
  | 'conversation'
  | 'logs'
  | 'tasks'
  | 'memory'
  | 'context'
  | 'settings'
  | 'attachments'
  | 'opinion'
  | 'archive'

export type DiagnosticProgress = {
  conversationId: string
  step: DiagnosticStep
  index: number
  total: number
  files: number
}

export type DiagnosticResult = {
  ok: boolean
  error?: string
  conversationId: string
  conversationTitle: string
  fileName: string
  zipPath: string
  relativePath: string
  sizeBytes: number
  fileCount: number
  durationMs: number
  modelOpinion: boolean
  opinionSkipped?: 'no-model' | 'local-only' | 'failed' | 'empty'
  groups: Array<{ key: string; count: number }>
  warnings: string[]
}

export type DiagnosticsApi = {
  export: (payload: { conversationId: string }) => Promise<DiagnosticResult>
  saveCopy: (payload: {
    zipPath: string
    fileName: string
  }) => Promise<{ ok: boolean; canceled?: boolean; error?: string }>
  reveal: (zipPath: string) => Promise<{ ok: boolean }>
  onProgress: (listener: (progress: DiagnosticProgress) => void) => () => void
}

export type CapabilityEntry = {
  name: string
  description: string
  status: 'ok' | 'error'
  hasPlugin: boolean
  toolCount: number
  triggers: string[]
  requires: string[]
  official: boolean
  /** A locked core capability — shows the Core badge, sorts last, can't be disabled. */
  core: boolean
  /** Authored by Wolffish itself (skill_create) — shows the Wolffish badge. */
  wolffish: boolean
  /**
   * False only for a Wolffish-authored plugin skill that hasn't passed a real
   * tool call since it was created or last edited — shows an Untested badge.
   */
  tested: boolean
  enabled: boolean
  error?: string
}

export type CapabilityImportSource = 'skill' | 'folder' | 'zip'

export type CapabilityImportResult =
  | {
      ok: true
      name: string
      folderName: string
      source: CapabilityImportSource
      hasPlugin: boolean
      toolCount: number
    }
  | { ok: false; error: string }

export type CapabilityDeleteResult =
  | { ok: true; capabilities: CapabilityEntry[] }
  | { ok: false; error: string }

export type CerebellumApi = {
  listCapabilities: () => Promise<CapabilityEntry[]>
  reload: () => Promise<CapabilityEntry[]>
  toggleCapability: (name: string, enabled: boolean) => Promise<void>
  /** Validate and import a dropped/picked SKILL.md, folder, or .zip. */
  importCapability: (sourcePath: string) => Promise<CapabilityImportResult>
  /** Open a native file/folder picker for the import dropzone. Null if canceled. */
  pickImport: (options?: { title?: string; filterName?: string }) => Promise<string | null>
  /** Delete a user-imported capability and nuke its folder. Refuses official ones. */
  deleteCapability: (name: string) => Promise<CapabilityDeleteResult>
  /**
   * A capability was toggled somewhere other than this window — the paired
   * phone, the agent's skills plugin — and the panel should follow. Fires
   * with the full refreshed list; returns the unsubscribe.
   */
  onCapabilitiesChanged: (callback: (capabilities: CapabilityEntry[]) => void) => () => void
}

export type VoiceApi = {
  readFile: (filePath: string) => Promise<ArrayBuffer>
  download: (filePath: string) => Promise<{ ok: boolean }>
  revealInFolder: (filePath: string) => Promise<{ ok: boolean }>
  exists: (filePath: string) => Promise<boolean>
}

export type UploadedFileMetadata = {
  type: MessageAttachmentType
  filePath: string
  originalName: string
  mimeType: string
  sizeBytes: number
  width?: number
  height?: number
  durationSeconds?: number
}

export type UploadFileMeta = {
  sizeBytes: number
  mtimeMs: number
  mimeType: string
}

export type VariablesApi = {
  list: () => Promise<Variable[]>
  save: (variables: Variable[]) => Promise<{ ok: true }>
  /** Fires on every save from any origin — this panel, another window, the
   *  paired phone — with the array that now holds. Returns unsubscribe. */
  onChanged: (listener: (payload: { variables: Variable[] }) => void) => () => void
}

/**
 * Kinds of telegram errors that the renderer can translate into a
 * locale-appropriate message. `unknown` falls back to the raw error
 * string from grammY/Telegram so we never silently swallow a useful
 * server message.
 */
export type TelegramErrorKind =
  | 'missing_token'
  | 'token_format'
  | 'invalid_token'
  | 'invalid_user_id'
  | 'rate_limit'
  | 'network'
  | 'unknown'

export type TelegramChannelStatus = {
  status: 'stopped' | 'starting' | 'running' | 'error'
  errorKind: TelegramErrorKind | null
  /** Raw error string from grammY/Telegram, useful when kind is `unknown`. */
  error: string | null
  /** Connected bot's @username, available once running. Null otherwise. */
  botUsername: string | null
  /** Connected bot's display name (first_name), available once running. */
  botName: string | null
}

export type TelegramTestResult =
  | { ok: true }
  | { ok: false; kind: TelegramErrorKind; message?: string }

/**
 * Mobile channel — the tunnel to the Wolffish phone app.
 *
 * Unlike Telegram/WhatsApp there is no token to type: the desktop offers a
 * pairing (a QR to scan, or a code to read out) and the phone claims it. The
 * panel then renders live connection state, including the short key
 * fingerprints both devices display so they can be compared at a glance.
 */
export type MobileTunnelState = {
  status:
    | 'idle'
    | 'connecting'
    | 'waiting-for-peer'
    | 'handshaking'
    | 'connected'
    | 'reconnecting'
    | 'error'
  peerPresent: boolean
  relayUrl: string
  rendezvous: string | null
  ownKey: string | null
  peerKey: string | null
  session: string | null
  connectedAt: number | null
  lastError: string | null
  reconnects: number
  framesSent: number
  framesReceived: number
  bytesSent: number
  bytesReceived: number
}

export type MobileStatus = {
  paired: boolean
  pairing: {
    method: 'qr' | 'code'
    pairedAt: number
    lastSeenAt: number | null
    deviceName: string | null
    /** How the phone describes itself. Null on a phone running an older build. */
    platform: 'ios' | 'android' | null
    model: string | null
    osVersion: string | null
    appVersion: string | null
  } | null
  tunnel: MobileTunnelState | null
  offer: {
    mode: 'qr' | 'code'
    payload: string | null
    code: string | null
    expiresAt: number
  } | null
  storage: { available: boolean; backend: string }
  verbose: boolean
  /** Whether the model's notify_phone tool may send push notifications. */
  notificationsEnabled: boolean
  /** Relay endpoint the tunnel dials — known before pairing, shown in the panel. */
  relayUrl: string
  /** What "reset to default" returns to, so the panel needn't hardcode it. */
  defaultRelayUrl: string
}

export type MobileApi = {
  status: () => Promise<MobileStatus>
  /** Open a QR pairing — the payload is rendered as a QR by the panel. */
  offerQr: () => Promise<MobileStatus>
  /** Open a typed-code pairing, for a desktop the phone cannot see. */
  offerCode: () => Promise<MobileStatus>
  /** Drop the live link but keep the pairing — the phone reconnects itself. */
  disconnect: () => Promise<MobileStatus>
  /** Forget the phone and drop the keys. */
  unpair: () => Promise<MobileStatus>
  setVerbose: (verbose: boolean) => Promise<MobileStatus>
  /** Allow or forbid the model's notify_phone push notifications. */
  setNotifications: (enabled: boolean) => Promise<MobileStatus>
  /**
   * Point the tunnel at a different relay (null resets to the default).
   * Rejects on a malformed URL. Changing relay drops any offer or pairing —
   * both name the old relay — so the panel confirms first.
   */
  setRelayUrl: (url: string | null) => Promise<MobileStatus>
  onStatusChange: (callback: (status: MobileStatus) => void) => () => void
}

export type TelegramApi = {
  getConfig: () => Promise<TelegramConfig>
  setConfig: (patch: Partial<TelegramConfig>) => Promise<{
    ok: true
    status: TelegramChannelStatus
    config: TelegramConfig
  }>
  status: () => Promise<TelegramChannelStatus>
  sendTestMessage: (payload: { token: string; userId: number }) => Promise<TelegramTestResult>
  onStatusChange: (callback: (status: TelegramChannelStatus) => void) => () => void
}

/**
 * Brave Search API. Stateless — the renderer just toggles a flag and sets
 * a key. The web-search cerebellum plugin reads the persisted config and
 * uses Brave as the primary provider when enabled, falling back to
 * DuckDuckGo on failure.
 */
export type BraveErrorKind =
  | 'missing_key'
  | 'invalid_key'
  | 'rate_limit'
  | 'subscription'
  | 'network'
  | 'unknown'

export type BraveStatus = {
  status: 'disabled' | 'configured' | 'error'
  errorKind: BraveErrorKind | null
  /** Raw error from the last test attempt, surfaced when kind is `unknown`. */
  error: string | null
}

export type BraveConfig = {
  enabled: boolean
  apiKey: string
}

export type BraveTestResult =
  | { ok: true; resultsCount: number }
  | { ok: false; kind: BraveErrorKind; message?: string }

export type BraveApi = {
  getConfig: () => Promise<BraveConfig>
  setConfig: (patch: Partial<BraveConfig>) => Promise<{
    ok: true
    status: BraveStatus
    config: BraveConfig
  }>
  status: () => Promise<BraveStatus>
  test: (apiKey: string) => Promise<BraveTestResult>
}

export type GoogleConfig = {
  status: 'inactive' | 'active'
  account: string
  clientId: string
  projectId: string
  credentialsStored: boolean
}

export type GoogleErrorKind =
  | 'platform_unsupported'
  | 'install_failed'
  | 'credentials_invalid'
  | 'auth_failed'
  | 'auth_timeout'
  | 'network'
  | 'unknown'

export type GoogleStatus = {
  status: 'inactive' | 'active' | 'error'
  errorKind: GoogleErrorKind | null
  error: string | null
}

export type GoogleBinaryStatus = {
  gogInstalled: boolean
  gogVersion: string | null
}

export type GoogleSetupResult =
  | { ok: true; binary: GoogleBinaryStatus }
  | { ok: false; kind: GoogleErrorKind; message?: string }

export type GoogleUpdateResult =
  | {
      ok: true
      updated: boolean
      version: string | null
      previousVersion?: string | null
    }
  | { ok: false; kind: GoogleErrorKind; message?: string }

export type GoogleSetupStateEvent = { stage: 'idle' | 'setup' | 'updating'; percent: number }
export type GoogleAuthUrlEvent = { url: string }

export type GoogleCredentialsResult =
  | { ok: true; clientId: string; projectId: string }
  | { ok: false; kind: GoogleErrorKind; message?: string }

export type GoogleAuthResult =
  | { ok: true; account: string }
  | { ok: false; kind: GoogleErrorKind; message?: string }

export type GoogleApi = {
  getConfig: () => Promise<GoogleConfig>
  setConfig: (patch: Partial<GoogleConfig>) => Promise<{
    ok: true
    status: GoogleStatus
    config: GoogleConfig
  }>
  status: () => Promise<GoogleStatus>
  checkBinary: () => Promise<GoogleBinaryStatus>
  setup: () => Promise<GoogleSetupResult>
  update: () => Promise<GoogleUpdateResult>
  getSetupState: () => Promise<GoogleSetupStateEvent>
  onSetupState: (listener: (event: GoogleSetupStateEvent) => void) => () => void
  onAuthUrl: (listener: (event: GoogleAuthUrlEvent) => void) => () => void
  uploadCredentials: (jsonContent: string) => Promise<GoogleCredentialsResult>
  deleteCredentials: () => Promise<{ ok: true } | { ok: false; message: string }>
  // `reauth` re-runs the same OAuth flow for an account that already exists,
  // forcing Google's consent screen so a fresh refresh token comes back.
  authAdd: (email: string, opts?: { reauth?: boolean }) => Promise<GoogleAuthResult>
  cancelAuth: () => Promise<boolean>
  listAccounts: () => Promise<string[]>
  // Best-effort per-account token health: email → true (refresh token still
  // valid) / false (expired or revoked). Accounts we couldn't evaluate are
  // omitted, not marked unhealthy.
  checkAccounts: () => Promise<Record<string, boolean>>
  removeAccount: (
    email: string
  ) => Promise<{ ok: true; accounts: string[] } | { ok: false; message: string }>
}

export type NotionErrorKind =
  | 'missing_token'
  | 'invalid_token'
  | 'rate_limit'
  | 'network'
  | 'unknown'

export type NotionStatus = {
  status: 'disabled' | 'configured' | 'error'
  errorKind: NotionErrorKind | null
  error: string | null
}

export type NotionConnection = {
  id: string
  label: string
  token: string
  name: string
  email: string
}

export type NotionConfig = {
  connections: NotionConnection[]
}

export type NotionTestResult =
  | { ok: true; name: string; email: string | null }
  | { ok: false; kind: NotionErrorKind; message?: string }

export type NotionApi = {
  getConfig: () => Promise<NotionConfig>
  setConfig: (connections: NotionConnection[]) => Promise<{
    ok: true
    status: NotionStatus
    config: NotionConfig
  }>
  status: () => Promise<NotionStatus>
  test: (token: string) => Promise<NotionTestResult>
}

export type GitHubErrorKind =
  | 'missing_token'
  | 'invalid_token'
  | 'rate_limit'
  | 'insufficient_scope'
  | 'network'
  | 'unknown'

export type GitHubStatus = {
  status: 'disabled' | 'configured' | 'error'
  errorKind: GitHubErrorKind | null
  error: string | null
}

export type GitHubConnection = {
  id: string
  label: string
  token: string
  login: string
  name: string
}

export type GitHubConfig = {
  connections: GitHubConnection[]
}

export type GitHubTestResult =
  | { ok: true; login: string; name: string | null; scopes: string }
  | { ok: false; kind: GitHubErrorKind; message?: string }

export type GitHubApi = {
  getConfig: () => Promise<GitHubConfig>
  setConfig: (connections: GitHubConnection[]) => Promise<{
    ok: true
    status: GitHubStatus
    config: GitHubConfig
  }>
  status: () => Promise<GitHubStatus>
  test: (token: string) => Promise<GitHubTestResult>
}

export type MemesConfig = {
  imgflip: {
    username: string
    password: string
  }
  giphy: {
    apiKey: string
  }
}

export type MemesErrorKind = 'missing_key' | 'invalid_key' | 'rate_limit' | 'network' | 'unknown'

export type MemesStatus = {
  memegen: 'available'
  giphy: 'disabled' | 'configured' | 'error'
  imgflip: 'disabled' | 'configured' | 'error'
  giphyErrorKind: MemesErrorKind | null
  giphyError: string | null
  imgflipErrorKind: MemesErrorKind | null
  imgflipError: string | null
}

export type MemesTestResult = { ok: true } | { ok: false; kind: MemesErrorKind; message?: string }

export type MemesApi = {
  getConfig: () => Promise<MemesConfig>
  setConfig: (patch: Partial<MemesConfig>) => Promise<{
    ok: true
    status: MemesStatus
    config: MemesConfig
  }>
  status: () => Promise<MemesStatus>
  testGiphy: (apiKey: string) => Promise<MemesTestResult>
  testImgflip: (payload: { username: string; password: string }) => Promise<MemesTestResult>
}

export type UpdatesConfig = {
  enabled: boolean
}

export type ComputerUseConfig = {
  screenshotMaxWidth: number
  screenshotFormat: 'jpeg' | 'png'
}

export type ComputerUsePermissions = {
  platform: string
  hint: string | null
  accessibility: boolean
  screenRecording: boolean
  /**
   * Linux only: the session type and compositor the desktop runs under, so
   * the panel can say what background input will and will not do there.
   */
  linux?: { sessionType: string; desktop: string | null }
}

export type ComputerUseSettingsPane = 'accessibility' | 'screenRecording' | 'automation'

/**
 * No setter: screenshot resolution and format are the agent's to choose per
 * capture (`max_width` / `format` on computer_screenshot), so the stored
 * values are a fallback default and nothing in the UI writes them.
 */
export type ComputerUseApi = {
  getConfig: () => Promise<ComputerUseConfig>
  checkPermissions: () => Promise<ComputerUsePermissions>
  /**
   * macOS: open the Privacy & Security pane that holds a grant. Triggers the
   * system prompt for it first where the OS allows (Accessibility), so the
   * app shows up in the list ready to be switched on.
   */
  openSettings: (pane: ComputerUseSettingsPane) => Promise<{ ok: boolean }>
}

export type ExtensionLastSeen = {
  name: string
  browser: string
  version: string | null
  profileEmail: string | null
  at: number
}

export type BrowserExtensionConfig = {
  port: number
  screenshotMaxWidth: number
  screenshotFormat: 'jpeg' | 'png'
  screenshotQuality: number
  /** On-page shadow cursor + pill. Default true. */
  overlayEnabled?: boolean
  bridgeToken?: string
  lastSeen?: Record<string, ExtensionLastSeen>
}

export type ExtensionConnectionStatus = 'stopped' | 'listening' | 'connected' | 'error'

// Mirrors src/main/channels/extension/doctor.ts (preload cannot import main).
export type ExtensionFindingSeverity = 'blocker' | 'degraded' | 'note'
export type ExtensionFixKind = 'auto' | 'one-click' | 'guided' | 'none'
/** Mirrors MacSettingsPane in channels/extension/doctor.ts. */
export type ExtensionMacPane = 'accessibility' | 'screenRecording' | 'automation'

export type Finding = {
  /** Stable snake_case id — translate by id; title/steps are English fallbacks. */
  id: string
  severity: ExtensionFindingSeverity
  title: string
  detail: string
  /** `pane` is the finding's own — the fix executor must not default it. */
  fix: {
    kind: ExtensionFixKind
    action?: string
    steps: string[]
    url?: string
    pane?: ExtensionMacPane
  }
  verify: string
  /** Selection key when the finding is about one connected browser. */
  browser?: string
}

export type DoctorReport = {
  ready: boolean
  tier: 'full' | 'degraded' | 'managed' | 'none'
  findings: Finding[]
  summary: string
  facts: Record<string, unknown>
}

export type DoctorOptions = {
  target?: string | null
  conversationId?: string | null
  tabId?: number
  probe?: boolean
}

export type FixOptions = {
  target?: string | null
  pane?: ExtensionMacPane | string
  url?: string
  extensionId?: string | null
}

export type FixResult = { ok: boolean; message: string; steps?: string[] }

export type ExtensionBrowserInfo = {
  id: string
  instanceId: string | null
  key: string
  browser: string
  name: string
  version: string | null
  browserVersion: string | null
  os: string | null
  profileEmail: string | null
  /** chrome.runtime.id — null on pre-v2 extensions. */
  extensionId: string | null
  /** Connected without a bridge token (pre-v2 build). */
  legacy: boolean
  overlayEnabled: boolean
  connectedAt: number
  lastPing: number
}

export type ExtensionServerStatus = {
  status: ExtensionConnectionStatus
  error: string | null
  extensionVersion: string | null
  port: number
  browsers: ExtensionBrowserInfo[]
}

export type BrowserExtensionApi = {
  getConfig: () => Promise<BrowserExtensionConfig>
  setConfig: (
    patch: Partial<BrowserExtensionConfig>
  ) => Promise<{ ok: true; config: BrowserExtensionConfig }>
  status: () => Promise<ExtensionServerStatus>
  openExtensionFolder: () => Promise<void>
  getExtensionPath: () => Promise<string>
  updateExtension: (target?: string | null) => Promise<{ ok: true }>
  testConnection: (
    target?: string | null
  ) => Promise<{ ok: boolean; steps: number; passed: number; error?: string }>
  openExtensionsPage: () => Promise<void>
  /** Readiness report — works with zero browsers connected. */
  doctor: (opts?: DoctorOptions) => Promise<DoctorReport>
  /** Run a finding's `fix.action` — including starting a browser. */
  fix: (action: string, opts?: FixOptions) => Promise<FixResult>
  setOverlayEnabled: (enabled: boolean, target?: string | null) => Promise<{ ok: true }>
  onStatusChange: (callback: (status: ExtensionServerStatus) => void) => () => void
}

export type UpdateAvailableEvent = {
  version: string
  releaseNotes: string | null
}

export type UpdateDownloadProgressEvent = {
  percent: number
}

export type UpdateReadyEvent = {
  version: string
  releaseNotes: string | null
  /** Where the installer was saved when the user has to run it (macOS); null when the app installs itself. */
  installerPath: string | null
}

export type UpdaterPhase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'installing'
  | 'error'

export type UpdaterErrorCode =
  | 'checksum'
  | 'network'
  | 'timeout'
  | 'filesystem'
  | 'install'
  | 'unknown'

export type UpdaterErrorInfo = {
  code: UpdaterErrorCode
  message: string
  detail: string | null
}

export type UpdaterState = {
  phase: UpdaterPhase
  version: string | null
  percent: number
  releaseNotes: string | null
  error: UpdaterErrorInfo | null
  installerPath: string | null
}

export type UpdateCheckResult = { ok: true; version: string | null } | { ok: false; error: string }

export type UpdaterApi = {
  install: () => Promise<void>
  check: () => Promise<UpdateCheckResult>
  getVersion: () => Promise<string>
  getReady: () => Promise<UpdateReadyEvent | null>
  getState: () => Promise<UpdaterState>
  /** macOS: show the downloaded installer in Finder. */
  revealInstaller: () => Promise<void>
  consumePostUpdate: () => Promise<boolean>
  listChangelogMonths: () => Promise<string[]>
  readChangelog: (month: string, locale?: string) => Promise<string>
  onAvailable: (listener: (event: UpdateAvailableEvent) => void) => () => void
  onProgress: (listener: (event: UpdateDownloadProgressEvent) => void) => () => void
  onReady: (listener: (event: UpdateReadyEvent) => void) => () => void
  onState: (listener: (state: UpdaterState) => void) => () => void
}

export type SttTranscribeResult =
  | { ok: true; transcript: string; language?: string }
  | { ok: false; error: string }

export type MicApi = {
  checkAccess: () => Promise<'granted' | 'denied' | 'not-determined' | 'restricted'>
  requestAccess: () => Promise<boolean>
}

// Local voice-engine provisioning (Kokoro TTS / faster-whisper STT) exposed to
// the Settings panels: a manual install with streamed progress + a readiness
// check so the panels can gate voice/model selection until installed.
export type EngineInstallPhase = 'python' | 'engine' | 'ffmpeg' | 'model' | 'done'
export type EngineInstallProgressEvent = { phase: EngineInstallPhase; percent: number }
export type EngineStatus = { installed: boolean }
export type EngineInstallResult = { ok: true } | { ok: false; error: string }
export type TtsPreviewResult = { ok: true; filePath: string } | { ok: false; error: string }
// Queryable in-flight install state — lets a panel recover progress after the
// user navigates away and back (the install keeps running in main).
export type EngineInstallRuntimeState = {
  installing: boolean
  progress: EngineInstallProgressEvent | null
  error: string | null
}

export type SttApi = {
  getConfig: () => Promise<SttConfig>
  setConfig: (patch: Partial<SttConfig>) => Promise<{ ok: true; config: SttConfig }>
  transcribe: (payload: {
    filePath: string
    conversationId?: string
  }) => Promise<SttTranscribeResult>
  installStatus: () => Promise<EngineStatus>
  install: () => Promise<EngineInstallResult>
  onInstallProgress: (listener: (event: EngineInstallProgressEvent) => void) => () => void
  getInstallState: () => Promise<EngineInstallRuntimeState>
}

export type TtsApi = {
  getConfig: () => Promise<TtsConfig>
  setConfig: (patch: Partial<TtsConfig>) => Promise<{ ok: true; config: TtsConfig }>
  installStatus: () => Promise<EngineStatus>
  install: () => Promise<EngineInstallResult>
  onInstallProgress: (listener: (event: EngineInstallProgressEvent) => void) => () => void
  getInstallState: () => Promise<EngineInstallRuntimeState>
  preview: (payload: { text?: string; voice?: string; speed?: string }) => Promise<TtsPreviewResult>
}

export type UploadValidationError =
  | { code: 'file_too_large'; maxBytes: number }
  | { code: 'max_files_reached'; max: number }
  | { code: 'total_size_exceeded'; maxBytes: number }
  | { code: 'type_not_supported' }

/** One top-level entry of a working folder, for attaching folder structure to chat context. */
export type FolderEntry = { name: string; isDirectory: boolean }
/**
 * The top-level listing of a working folder (capped). When `truncated`,
 * `omittedDirectories`/`omittedFiles` count what was dropped past the cap.
 * `error` is set when the dir was unreadable.
 */
export type FolderListing = {
  entries: FolderEntry[]
  truncated: boolean
  omittedDirectories?: number
  omittedFiles?: number
  error?: string
}

/** Byte progress for one in-flight saveFile(), keyed by its progressId. */
export type UploadCopyProgress = {
  progressId: string
  copiedBytes: number
  totalBytes: number
}

/** Where a deck's rendered slides live, and the canvas they were drawn on.
 *  Dual decl — the source of truth is src/main/uploads/deck-preview.ts. */
export type DeckPreview = {
  /** Workspace-relative path per rendered slide, in presentation order. */
  slides: string[]
  /** Slides the deck holds — larger than `slides.length` when a very large
   *  deck stopped at the render budget. */
  totalSlides: number
  /** Slide canvas in CSS px at 96 DPI; the card takes its aspect from this. */
  width: number
  height: number
}

export type UploadApi = {
  pickFile: () => Promise<string[]>
  pickFolder: () => Promise<string | null>
  saveFile: (payload: {
    conversationId: string
    sourcePath: string
    /** Opt in to onCopyProgress ticks tagged with this id. */
    progressId?: string
  }) => Promise<UploadedFileMetadata>
  saveBuffer: (payload: {
    conversationId: string
    buffer: ArrayBuffer
    fileName: string
  }) => Promise<UploadedFileMetadata>
  readFile: (relativePath: string) => Promise<ArrayBuffer | null>
  exists: (relativePath: string) => Promise<boolean>
  /** Render every slide of a .pptx/.potx to SVG files inside the workspace and
   *  return where they landed. Null when the deck can't be parsed (legacy .ppt,
   *  encrypted, truncated) — the caller falls back to the plain file card.
   *  Cached on the deck's mtime + size, so this is cheap after the first call.
   *  (Dual decl — see DeckPreview in src/main/uploads/deck-preview.ts.) */
  renderDeck: (relativePath: string) => Promise<DeckPreview | null>
  getMetadata: (relativePath: string) => Promise<UploadFileMeta | null>
  isSupported: (fileName: string) => Promise<boolean>
  validate: (payload: {
    fileName: string
    sizeBytes: number
    currentCount: number
    currentTotalBytes: number
  }) => Promise<UploadValidationError | null>
  openExternal: (relativePath: string) => Promise<{ ok: boolean; error?: string }>
  /** file: URL of an upload, for the in-chat HTML preview <webview>; null when the path is invalid. */
  fileUrl: (relativePath: string) => Promise<string | null>
  /** Existence + type of a device path (resolves a leading ~), for chat path cards. */
  statPath: (path: string) => Promise<{ exists: boolean; isDirectory: boolean }>
  /** The project folder each directory is charged to, keyed by the directory
   *  as given — the repository root above it, else its manifest's folder, else
   *  the working folder or workspace/home container it sits in (see
   *  src/main/uploads/project-folders.ts). Feeds the folder chips over a
   *  transcript: one chip per project, never one per nested directory. */
  projectFolders: (dirs: string[], workingFolders: string[]) => Promise<Record<string, string>>
  /** Top-level contents of a directory (resolves a leading ~), for attaching working-folder structure to chat context. */
  listFolder: (path: string) => Promise<FolderListing>
  /** Open a directory, or reveal a file in its parent folder (resolves a leading ~). */
  revealPath: (path: string) => Promise<{ ok: boolean; error?: string }>
  /** Save a copy of a device path (resolves a leading ~) to a user-picked location. */
  downloadPath: (path: string) => Promise<{ ok: boolean; error?: string }>
  download: (relativePath: string) => Promise<{ ok: boolean }>
  /** Reveal the file in the OS file manager (Finder/Explorer). */
  revealInFolder: (relativePath: string) => Promise<{ ok: boolean }>
  /** Resolve the absolute filesystem path for a File object (e.g. from drag-and-drop). */
  getPathForFile: (file: File) => string
  /** Byte progress for saveFile() calls that passed a progressId. */
  onCopyProgress: (listener: (progress: UploadCopyProgress) => void) => () => void
}

/** Spellcheck fields relayed from the main-process `context-menu` event — the
 *  only place Chromium exposes the misspelled word + its suggestions. `misspelledWord`
 *  is empty when nothing under the cursor is misspelled. */
export type SpellcheckContextMenu = {
  isEditable: boolean
  misspelledWord: string
  dictionarySuggestions: string[]
}

export type SpellcheckApi = {
  /** Fires on every right-click that the page doesn't preventDefault. Carries the
   *  spellcheck payload so the renderer's own styled menu can offer corrections. */
  onContextMenu: (listener: (event: SpellcheckContextMenu) => void) => () => void
  /** Replace the currently-selected misspelled word in the focused field. */
  replace: (word: string) => Promise<void>
  /** Add a word to the spellchecker's custom dictionary so it stops being flagged. */
  addToDictionary: (word: string) => Promise<void>
}

export type WebUiStatus = import('@main/channels/web/server').WebUiStatus
export type HttpsEnableInput = import('@main/channels/web/server').HttpsEnableInput
export type HttpsEnableResult = import('@main/channels/web/server').HttpsEnableResult
export type HttpsProgressEvent = import('@main/channels/web/server').HttpsProgressEvent
export type HttpsStatus = import('@main/channels/web/server').HttpsStatus
export type PreflightStep = import('@main/channels/web/preflight').PreflightStep
export type WebUiPublicConfig = import('@main/channels/web/ipc').WebUiPublicConfig
export type WebSessionView = import('@main/channels/web/ipc').WebSessionView
export type WebPublicLinkView = import('@main/channels/web/ipc').WebPublicLinkView
export type WebUiConfigPatch = import('@main/workspace/workspace').WebUiConfigPatch
export type WebUiHttpsMode = import('@main/workspace/workspace').WebUiHttpsMode
export type WebNotifyResult = import('@main/channels/web/server').NotifyResult

/**
 * The Web UI channel — the desktop app served to a browser. Configured from
 * the desktop (and from the Web UI itself: a browser can change the port it
 * is on, and reconnects when the server comes back).
 */
export type WebUiApi = {
  getConfig: () => Promise<WebUiPublicConfig>
  setConfig: (
    patch: WebUiConfigPatch
  ) => Promise<{ ok: true; config: WebUiPublicConfig; status: WebUiStatus }>
  /** Sets (or replaces) the master password. Every signed-in browser is signed out. */
  setPassword: (
    password: string
  ) => Promise<{ ok: true; config: WebUiPublicConfig; status: WebUiStatus }>
  /** The generated passphrase in clear, or null once the user set their own password. */
  revealPassword: () => Promise<{ password: string | null }>
  /** A fresh generated passphrase, returned in clear. Every signed-in browser is signed out. */
  regeneratePassword: () => Promise<{
    ok: true
    password: string
    config: WebUiPublicConfig
    status: WebUiStatus
  }>
  status: () => Promise<WebUiStatus>
  listSessions: () => Promise<WebSessionView[]>
  revokeSession: (id: string) => Promise<{ ok: true }>
  revokeAllSessions: () => Promise<{ ok: true }>
  /** Public links — files, folders and ports the agent published past the sign-in. */
  listPublic: () => Promise<WebPublicLinkView[]>
  revokePublic: (id: string) => Promise<{ ok: true }>
  revokeAllPublic: () => Promise<{ ok: true; revoked: number }>
  testNotification: () => Promise<WebNotifyResult>
  /** Force a Let's Encrypt issuance now, outside the renewal schedule. */
  renewCertificate: () => Promise<WebUiStatus>
  /** The one button: preflight, then Let's Encrypt on 443 with port 80 for validation. */
  httpsEnable: (input: HttpsEnableInput) => Promise<HttpsEnableResult>
  httpsDisable: () => Promise<WebUiStatus>
  restart: () => Promise<WebUiStatus>
  /** Asks ipify.org what address the internet sees this machine at. */
  detectPublicIp: () => Promise<{ ipv4: string | null; ipv6: string | null }>
  onConfigChange: (listener: (config: WebUiPublicConfig) => void) => () => void
  onStatusChange: (listener: (status: WebUiStatus) => void) => () => void
  /** The full list after a public link is made or revoked, from any surface. */
  onPublicChange: (listener: (links: WebPublicLinkView[]) => void) => () => void
  /** Each state change and each preflight or issuance step while HTTPS is being set up. */
  onHttpsProgress: (listener: (event: HttpsProgressEvent) => void) => () => void
}

export type WolffishApi = {
  theme: ThemeApi
  locale: LocaleApi
  system: SystemApi
  workspace: WorkspaceApi
  ollama: OllamaApi
  model: ModelApi
  provider: ProviderApi
  chat: ChatApi
  conversation: ConversationApi
  task: TaskApi
  countdown: CountdownApi
  processes: ProcessesApi
  browser: BrowserApi
  viewer: ViewerApi
  heartbeat: HeartbeatApi
  automationFiles: AutomationFilesApi
  paths: PathsApi
  procedures: ProceduresApi
  projects: ProjectsApi
  reindex: ReindexApi
  diagnostics: DiagnosticsApi
  app: AppApi
  data: DataApi
  services: ServicesApi
  video: VideoApi
  runtime: RuntimeApi
  usage: UsageApi
  cerebellum: CerebellumApi
  variables: VariablesApi
  voice: VoiceApi
  upload: UploadApi
  mobile: MobileApi
  telegram: TelegramApi
  whatsapp: WhatsAppApi
  inapp: InAppApi
  cli: CliApi
  web: WebUiApi
  mcp: McpApi
  brave: BraveApi
  notion: NotionApi
  github: GitHubApi
  google: GoogleApi
  memes: MemesApi
  mic: MicApi
  stt: SttApi
  tts: TtsApi
  computerUse: ComputerUseApi
  browserExtension: BrowserExtensionApi
  updater: UpdaterApi
  spellcheck: SpellcheckApi
}

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: WolffishApi = buildApi({
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  subscribe,
  getPathForFile: (file) => webUtils.getPathForFile(file)
})

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  ;(window as unknown as { api: WolffishApi }).api = api
}
