import {
  createConversation,
  loadConversation,
  mintMessageId,
  saveConversation,
  type ConversationChannel,
  type ConversationFile,
  type ConversationMessage
} from '@main/conversations'
import { titleFromMessage } from '@main/conversation-titler'
import { diskWriter } from '@main/io/diskWriter'
import { net } from 'electron'
import { AsyncLocalStorage } from 'node:async_hooks'
import os from 'node:os'
import path from 'node:path'
import { deliveredFileNames } from '@main/runtime/agent/delivered-files'
import {
  armContentFreeReplyNotice,
  armControlTokenNotice,
  armSilencePlaceholderNotice,
  contentFreeReply,
  drainControlTokenNotice,
  silencePlaceholder,
  trailingControlToken
} from '@main/runtime/agent/control-token-guard'
import { emptyTurnNudge, MAX_EMPTY_TURN_NUDGES } from '@main/runtime/agent/empty-turn-guard'
import {
  closingNotice,
  createClosingGuardState,
  recordClosingTool
} from '@main/runtime/agent/closing-guard'
import {
  INTERJECTION_NOTICE,
  interjectionToHistoryMessage,
  type AutonomousInterjectionBridge,
  type Interjection,
  type InterjectionWithdrawReason
} from '@main/runtime/agent/interjection'
import {
  INDICATOR_OFF_TOOLS,
  indicatorNoticeText,
  indicatorNudge,
  indicatorOffTools,
  lastIndicatorActionFrom,
  MAX_SCREEN_INDICATOR_NUDGES,
  trackIndicators,
  type LastIndicatorAction
} from '@main/runtime/agent/screen-indicator-guard'
import {
  MAX_TODO_NUDGES,
  openTaskListNotice,
  todoCloseoutNudge
} from '@main/runtime/agent/todo-guard'
import {
  NoProgressTracker,
  noProgressNotice,
  NO_PROGRESS_MASTER_REPEATS,
  NO_PROGRESS_WORKER_REPEATS,
  type NoProgressSignal
} from '@main/runtime/agent/no-progress-guard'
import { Amygdala, SafetyBlockedError } from '@main/runtime/amygdala'
import { BasalGanglia } from '@main/runtime/basalganglia'
import { Brainstem } from '@main/runtime/brainstem'
import {
  Broca,
  WORKFLOW_TOOL_NAMES,
  type Segment,
  type SegmentSink,
  type SegmentTurnEndReason,
  type TodoItem,
  type ToolResultMeta,
  type ToolResultStatus,
  openTodoList,
  type OpenTodoList,
  foldSegment
} from '@main/runtime/broca'
import { Cerebellum, type WorkflowHost } from '@main/runtime/cerebellum'
import type { StepResult } from '@main/runtime/motor'
import { buildProjectOverlay, projectThinking, projectWorkingFolders } from '@main/projects'
import {
  anyCodeFolder,
  buildInstructionsOverlay,
  describeWorkingFolders,
  findNestedInstructionFile,
  formatNestedInstructionReminder,
  readInstructionFile,
  type FolderFacts
} from '@main/runtime/workdir'
import { buildAttachedFilesOverlay } from '@main/uploads/owned-copies'
import { compactOverflow } from '@main/runtime/compactor'
import { Corpus, turnScope, type CorpusEvent } from '@main/runtime/corpus'
import { TurnStatsCollector } from '@main/channels/turn-stats'
import {
  buildAssistantMessage,
  type AssistantAccumulator,
  type MirrorMessageListener
} from '@main/channels/channel'
import type { ActiveRun, TurnLifecycleEvent } from '@main/channels/turn-runner'
import { Cortex } from '@main/runtime/cortex'
import { Device } from '@main/runtime/device'
import { Hippocampus, type TurnToolCall } from '@main/runtime/hippocampus'
import { countdowns } from '@main/runtime/countdown'
import { processManager } from '@main/processes/instance'
import { waits } from '@main/runtime/wait'
import {
  checkIns,
  CHECK_IN_EXEMPT_TOOLS,
  DEFAULT_CHECK_IN_SECONDS,
  splitCheckInArg,
  type ParkedCall
} from '@main/runtime/check-in'
import { browserTabs } from '@main/browser/tab-manager'
import { videoTasks } from '@main/runtime/video-tasks'
import { Hypothalamus } from '@main/runtime/hypothalamus'
import { Insula } from '@main/runtime/insula'
import { Motor } from '@main/runtime/motor'
import {
  WorkflowSession,
  type AgentUsageDelta,
  type RunAgentTurn,
  type WorkflowAgentResult,
  type WorkflowModelChoice
} from '@main/runtime/workflow'
import {
  formatLastMessageNotice,
  formatRuntimeStatus,
  PHONE_NOTIFY_CHANNEL_NOTICE,
  PHONE_NOTIFY_NOTICE,
  PHONE_NOTIFY_SENT_NOTICE,
  VOICE_REPLY_NOTICE,
  WEB_NOTIFY_CHANNEL_NOTICE,
  WEB_NOTIFY_NOTICE,
  WEB_NOTIFY_SENT_NOTICE
} from '@main/runtime/outbound'
import fs from 'node:fs/promises'
import { Prefrontal } from '@main/runtime/prefrontal'
import { RAS } from '@main/runtime/ras'
import {
  Thalamus,
  type ChatMessage,
  type NoProviderAvailableInfo,
  type ProviderId,
  type StopReason,
  type StreamChunk,
  type StreamUsage,
  type ToolDefinition,
  type ToolUse,
  type UserContentBlock
} from '@main/runtime/thalamus'
import { Usage, calculateCost } from '@main/runtime/usage'
import { cloudModelSupportsVision } from '@main/runtime/vision'
import { Wernicke, type ToolCall } from '@main/runtime/wernicke'
import { processAttachments, type MessageAttachmentInput } from '@main/uploads/file-processor'
import { isInternalToolCall, readConfig } from '@main/workspace/workspace'

/**
 * Maximum number of tools each provider API accepts per request.
 * Only providers with a confirmed, documented limit are listed here.
 * Providers not in this map have no known hard limit — all tools are
 * sent through unfiltered.
 *
 * OpenAI is deliberately absent: 128 was the chat/completions limit, and
 * /v1/responses took 400 tools on every catalog model and 1000 on
 * gpt-6.1-sol (verified live 2026-10-13). The cap had been dropping
 * capabilities the model had just activated (pdf-design, web-ui,
 * close-turn) by relevance score mid-turn.
 */
/** Tool-universe sizing (toolUniverseFor): JSON schema chars per token, and cap. */
const UNIVERSE_CHARS_PER_TOKEN = 3.6
const UNIVERSE_MAX_WINDOW_SHARE = 0.1

/** Share of the context window past which superseded reads are stubbed. */
const SUPERSEDE_PRESSURE = 0.4

const PROVIDER_TOOL_LIMITS: Record<string, number> = {
  xai: 200
}

/**
 * What the model reads before an automation's or procedure's saved
 * instruction. The instruction alone arrived as a bare user message, and one
 * that DESCRIBES its job ("UNATTENDED AUTOMATION — runs daily…") reads exactly
 * like a request to set that automation up: a heartbeat run of a news brief
 * went looking for the brief's schedule, found itself "already running", and
 * spent the whole run confirming the setup instead of writing the brief. The
 * prompt shown in the conversation stays the instruction as saved.
 */
function autonomousRunFraming(opts: {
  jobLabel: string
  jobName?: string
  channel?: string
}): string {
  const now = new Date().toString()
  const job = opts.jobName ? `${opts.jobName}" (${opts.jobLabel})` : `${opts.jobLabel}"`
  if (opts.channel === 'procedure') {
    return (
      `[Run of the saved procedure "${job}, started ${now}. The text below is its ` +
      'saved instruction: carry it out now, in this run.]\n\n'
    )
  }
  return (
    `[Scheduled run of the automation "${job}, firing ${now}. The text below is its ` +
    'saved instruction: carry it out now, in this run. The automation already exists and is ' +
    'already scheduled — this run IS it — so do not look for, create, verify, reschedule or edit ' +
    'it unless the instruction itself asks you to. The user may open this conversation and ' +
    'watch the run as it works, and reads what it delivers afterwards.]\n\n'
  )
}

/**
 * Result text injected for a tool call that was announced to the model but
 * never finished because the run was stopped (or errored) mid-flight. Must
 * be non-empty — Anthropic rejects empty tool_result content — and reads as
 * a normal tool failure so a continued conversation makes sense to the model.
 */
const INTERRUPTED_TOOL_RESULT =
  'Tool execution was interrupted before it completed because the run was stopped. No output was produced.'

/** Same slot when the user pressed Stop: the card reads as stopped, not failed. */
const STOPPED_TOOL_RESULT =
  'Tool execution was stopped by the user before it completed. No output was produced.'

/**
 * When a max_tokens/length stop arrives but the input is within this many
 * tokens of the model's context window, there is no room left to generate
 * into. Continuing would just feed a "continue" turn that gets truncated
 * away, so the loop is ended instead. Guards the local-model case where the
 * prompt grows to fill num_ctx and the model can only emit ~1 token per call,
 * spinning the max_tokens continuation forever.
 */
const CONTEXT_FULL_MARGIN_TOKENS = 512

/**
 * Below this context budget the full core toolset (+prompt) won't fit with
 * useful headroom — slim to the bootstrap set. ~24k covers the lean prompt
 * (~5-7k), bootstrap schemas (~3k), and room for a real conversation.
 */
const MIN_FULL_CORE_BUDGET_TOKENS = 24_000

/** The tools a small-window model keeps: retrieval + discovery + files + shell. */
const SMALL_WINDOW_BOOTSTRAP_TOOLS: ReadonlySet<string> = new Set([
  'tool_search',
  'tool_activate',
  'memory_search',
  'memory_get',
  'conversation_list',
  'conversation_read',
  'memory_save',
  'wolffish_recall',
  'ask_user',
  'file_read',
  'file_edit',
  'file_write',
  'file_grep',
  'file_glob',
  'shell_exec',
  'todo_write',
  'send_file',
  'web_search'
])

/**
 * User messages within this many history entries of the end get their
 * attachments expanded into full content blocks; older attachments stay
 * metadata-only (the <attachments> text already carries each absolute path).
 */
const ATTACHMENT_VERBATIM_WINDOW = 4

/**
 * Live-mirror cadence for an autonomous run's in-progress assistant message —
 * the same 500ms every channel uses, so a heartbeat/procedure conversation
 * open in the app fills in exactly like a Telegram one.
 */
const AUTONOMOUS_MIRROR_THROTTLE_MS = 500

/**
 * Durability cadence for the same message. The mirror only reaches open
 * viewers; this is what puts the run's progress ON DISK while it is still
 * running, so quitting (or a crash) mid-run leaves a resumable transcript
 * instead of just the prompt. Much slower than the mirror on purpose: each
 * save rewrites AND reindexes the whole conversation file (a long automation's
 * transcript is not small) and pushes a list-changed to every surface, and the
 * only thing the extra frequency buys is a few more seconds of a run that
 * ended abnormally.
 */
const AUTONOMOUS_PERSIST_THROTTLE_MS = 30_000

export type AgentOptions = {
  thalamus: Thalamus
  workspaceRoot: string
  getActiveModel?: () => string | null
  defaultBudgetTokens?: number
}

export type AgentTurnOptions = {
  history: ChatMessage[]
  turnId: string
  onSegment: SegmentSink
  signal?: AbortSignal
  /**
   * Stable conversation id reserved by the renderer before send. Threaded
   * through to the cerebellum so plugins can stamp per-conversation
   * artifacts (voice memos, attachments) with it. Optional so non-chat
   * call sites don't have to invent one.
   */
  conversationId?: string | null
  conversationTitle?: string | null
  /**
   * Plan mode: the user wants a plan, not execution. The turn is read-only
   * (every mutating tool call is refused — see isReadOnlyCall) except for
   * the plan file the Agent names in the tail; the tail also carries the
   * plan-mode workflow, and the first non-plan turn after one gets a
   * one-time "you may execute now" note pointing at the plan.
   */
  planMode?: boolean
  /**
   * Read-only run without a plan file — a workflow explore agent. Same
   * gate as plan mode, no plan-file exception, an agent-specific note.
   */
  readOnly?: boolean
  /**
   * Project this conversation runs inside. Its instructions + file list
   * (never file content — model-led) overlay the system prompt each turn.
   */
  projectId?: string | null
  /**
   * Files this turn has been given as reference material — an automation's or
   * a procedure's attachments. Overlaid on the system prompt as a model-led
   * LIST (name, size, path); content is never injected, exactly like a
   * project's files. Turn-constant, so it never perturbs the pinned-prompt
   * cache.
   */
  contextFiles?: string[] | null
  /** Which of the two owns them — the overlay names it so the model knows. */
  contextFilesOwner?: 'automation' | 'procedure'
  /**
   * Timestamp (ms epoch) of the conversation's previous persisted message —
   * the one BEFORE this turn's own user message. Computed by the TurnRunner
   * from the on-disk transcript (lastConversationMessageAt, which excludes
   * the current userMessageId so channel pre-dispatch persists don't zero
   * the gap). When the gap is large enough, the runtime tail tells the
   * model the conversation is resuming after days/weeks/months — replayed
   * history carries no timestamps, so this is its only temporal anchor.
   * Absent/null (fresh conversation, subagent, autonomous run) → no notice.
   */
  lastMessageAt?: number | null
  /**
   * Delivery channel for this turn's user-facing prose. Threaded into the
   * system prompt so the model writes in the channel's native text
   * formatting (WhatsApp renders no Markdown; see prefrontal's channel
   * overlay). Omitted for in-app and background turns → no overlay.
   */
  channel?: ConversationChannel
  /**
   * Active working-folder paths. The agent reads a fresh shallow listing
   * MAIN-SIDE once per turn and injects it into the outbound volatile tail
   * (after every cache breakpoint) — never into persisted user content,
   * where a fresh-per-send readdir used to rewrite the previous user
   * message and invalidate the provider prompt-cache prefix.
   */
  workingFolders?: string[]
  /**
   * Isolated Broca instance for this turn. Every turn gets its OWN Broca —
   * omitted, respond() constructs a fresh one. Callers that need to read
   * the segment stream around the turn (processAutonomous, workflow
   * subagents) pass theirs explicitly.
   */
  broca?: import('@main/runtime/broca').Broca
  /**
   * Publish this turn's conversation as the app-wide "current conversation"
   * (cerebellum global + conversation.changed emit, consumed by the
   * extension server). Defaults to true for channel turns; sealed
   * background runs (heartbeat/procedures) pass false so a scheduled run
   * can never flip the visible conversation mid-chat.
   */
  publishConversation?: boolean
  /**
   * When true, confirm/destructive tool calls are auto-approved without
   * going through the approval bridge. Block-level calls still block.
   * Used by autonomous heartbeat jobs that cannot prompt a human.
   */
  bypassApproval?: boolean
  thinkingMode?: 'off' | 'on' | 'high' | 'max'
  /**
   * Turn role (workflow mode). 'agent' marks a nested subagent turn (lean
   * context, no channel/delegation tools, invisible to the UI); 'master' is
   * stamped internally on a workflow-mode top-level turn. Omitted for single
   * mode and background runs.
   */
  role?: 'master' | 'agent'
  /**
   * Explicit model for this turn — the master's per-agent choice. Overrides
   * the Brain for stream resolution, context budgeting, vision gating and
   * provider tool caps. Omitted ⇒ the Brain.
   */
  modelOverride?: WorkflowModelChoice
  /**
   * Per-LLM-call usage feedback for the workflow card — invoked with the
   * provider/model that actually served the call. Session-scoped (threaded by
   * runAgentTurn), so concurrent workflows can never cross-attribute tokens.
   */
  onUsage?: (provider: ProviderId, model: string, usage: AgentUsageDelta) => void
  /**
   * No-progress escalation for a SUBAGENT turn — invoked (once per worsening
   * band, never every iteration) when the agent has been re-issuing the same
   * tool call past the master bar. Threaded by runAgentTurn to the workflow so
   * the master is woken from agents_await to manage the spinning agent (cancel,
   * steer, or keep waiting). Absent for master/single/background turns.
   */
  onNoProgress?: (signal: NoProgressSignal) => void
  /**
   * Per-turn chat-mode override — heartbeat jobs and procedures carry their
   * OWN mode (stamped at creation, user-editable per item), which beats the
   * global setting for that run. Omitted ⇒ the global mode.
   */
  modeOverride?: 'single' | 'workflow'
  /**
   * Channel-format feedback pull. A prose-mirroring channel (Telegram/
   * WhatsApp) validates every prose block it delivers to the user's phone;
   * a block that leaked raw markup parks a notice which this drains once
   * per iteration. Notices ride the volatile runtime tail (same vehicle
   * and cache rationale as the no-progress notice) so the model can repair
   * the delivered message and write clean blocks for the rest of the turn.
   * Observe-and-notify only — the framework never rewrites model prose.
   */
  formatNotices?: () => string[]
  /**
   * Mid-turn user-message pull (see agent/interjection.ts). The TurnRunner
   * keeps a per-conversation inbox of messages the user sent while this
   * turn was running; the loop drains it at its two stop points — the top
   * of every iteration and the would-end branch — and delivers each as a
   * real user message plus a `user_message` segment. Same pull shape as
   * formatNotices so it survives concurrent turns. Omitted for subagents
   * and autonomous runs, which nobody can message.
   */
  takeInterjections?: () => Interjection[]
}

export type AgentTurnResult = {
  stopReason: SegmentTurnEndReason | 'canceled'
  toolCalls: number
  taskId?: string
}

export type AutonomousTurnOptions = {
  instruction: string
  jobLabel: string
  /** The automation's display name (`name:` marker), when it has one. */
  jobName?: string
  /**
   * The brainstem job id this run belongs to (e.g. "every-2",
   * "procedure:<id>") — the same id the pool's RunningJobInfo carries.
   * Stamped on this run's onJobLog entries so the renderer can route live
   * activity to the right concurrent run card. Absent ⇒ jobLabel is used.
   */
  jobId?: string
  signal?: AbortSignal
  /**
   * Channel stamped on the sealed conversation this run produces. Defaults to
   * 'heartbeat' (automations); the `procedures` capability passes 'procedure' so
   * a procedure run is distinguishable from a scheduled automation in history.
   */
  channel?: ConversationChannel
  /**
   * The job's/procedure's own chat mode, threaded through to the turn as
   * modeOverride. Omitted ⇒ the run follows the global mode.
   */
  mode?: 'single' | 'workflow'
  /**
   * The job's/procedure's own reasoning effort, threaded through to the turn.
   * Omitted ⇒ the braintem already resolved the fallback (the chat's selected
   * mode) before calling; undefined here means nothing was selectable.
   */
  thinkingMode?: 'off' | 'on' | 'high' | 'max'
  /**
   * Project binding: the turn gets the project overlay and the sealed
   * conversation registers under the project (rail groups/badges it).
   */
  projectId?: string
  /**
   * Source emoji stamped on the sealed conversation — the rail's number-chip
   * badge shows it (automation's own icon, or a procedure's icon).
   */
  icon?: string
  /**
   * The automation's attached files (`file:` markers) — listed to the run as
   * reference material, never injected. See AgentTurnOptions.contextFiles.
   */
  contextFiles?: string[]
  /**
   * The automation's working directories (`dir:` markers). Ride the same
   * channel as the in-app composer's folder picker: a fresh shallow listing
   * rendered into the volatile tail each iteration, so the run sees the
   * folder as it is NOW rather than as it was when the turn started.
   */
  workingFolders?: string[]
}

export type AutonomousTurnResult = {
  success: boolean
  response: string
  toolCalls: number
  conversationId: string
}

/**
 * Agent is the brain. It owns one instance of every region and runs the
 * pipeline below for each turn.
 *
 * Wolffish Brain Pipeline
 * 1.  thalamus     → classify + route input
 * 2.  ras          → filter relevant context
 * 3.  prefrontal   → build context + plan approach
 * 4.  cortex       → search index for relevant memories
 * 5.  hippocampus  → load recent episodes + knowledge
 * 6.  cerebellum   → load matching skills
 * 7.  [LLM CALL]   → send assembled context to model
 * 8.  wernicke     → parse response, extract tool calls
 * 9.  amygdala     → safety check each tool call
 * 10. motor        → execute approved tool calls
 * 11. broca        → emit segments to renderer
 * 12. hippocampus  → save conversation to episode
 * 13. basalganglia → record outcome
 * 14. corpus       → emit events throughout
 * 15. hypothalamus → monitor health throughout
 * 16. brainstem    → background processes (independent)
 * 17. insula       → available on-demand for introspection
 *
 * The tool-use loop runs the model and amygdala-gated motor execution
 * for as long as the model keeps calling tools. There is no framework
 * cap on iterations — loop detection is the model's responsibility,
 * informed by the <runtime> block prefrontal injects each iteration
 * and the procedures in agents.md. Every turn — successful, canceled,
 * or errored — emits a turn_end segment so the renderer always has a
 * closing marker, even when the model produces only tool calls and no
 * prose.
 */
export class Agent {
  readonly thalamus: Thalamus
  readonly prefrontal: Prefrontal
  readonly corpus: Corpus
  readonly ras: RAS
  readonly cortex: Cortex
  readonly hippocampus: Hippocampus
  readonly cerebellum: Cerebellum
  readonly wernicke: Wernicke
  readonly amygdala: Amygdala
  readonly motor: Motor
  readonly basalganglia: BasalGanglia
  readonly hypothalamus: Hypothalamus
  readonly brainstem: Brainstem
  readonly insula: Insula
  readonly device: Device
  readonly usage: Usage

  private cortexReady: Promise<void> | null = null
  private cerebellumReady: Promise<void> | null = null

  // Lifecycle broadcast for AUTONOMOUS runs (heartbeat/procedure) — the same
  // TurnLifecycleEvent shape TurnRunner emits for channel turns, wired to the
  // same chat:turnState broadcast in index.ts. 'started' rides it too now: the
  // conversation is created and saved BEFORE the run begins (like every other
  // conversation), so there IS a row to pulse mid-run, and the rail/chat show
  // it processing exactly like a Telegram turn.
  private autonomousLifecycle: ((ev: TurnLifecycleEvent) => void) | null = null

  // Live-mirror sink for autonomous runs, pointed at the same
  // conversation:messageMirror broadcast (+ phone push) the channels use. The
  // run's in-progress assistant message is streamed under a STABLE id, so an
  // open viewer watches it grow and the end-of-turn save replaces it in place.
  private autonomousMirror: MirrorMessageListener | null = null

  // Mid-turn messages for autonomous runs. These runs call respond() directly
  // rather than going through the TurnRunner, so they had no inbox at all: a
  // message typed into an automation the user was watching was refused with
  // `no_live_turn`, the composer's optimistic bubble vanished, and the words
  // sat invisible until the run ended and the window re-sent them as a fresh
  // turn. The bridge borrows the runner's inbox — main wires it, because the
  // runner owns the Agent and not the other way round.
  private autonomousInterjections: AutonomousInterjectionBridge | null = null

  // Autonomous runs in flight, keyed by conversation id. They never pass
  // through the TurnRunner, so this is their half of the two facts an outside
  // observer needs: the cold-start snapshot (chat:activeRuns — a window opened
  // mid-run) and a real abort handle (the in-app Stop button).
  private readonly liveAutonomousRuns = new Map<
    string,
    { controller: AbortController; channel: string; title: string }
  >()

  // Workflow mode. `mode` is the global chat setting (chat-page mode button).
  // The active master turn's agent registry rides on AsyncLocalStorage — NOT a
  // single Agent field — so concurrent top-level turns (a channel turn and a
  // heartbeat job, two channels) each get their OWN session and can't clobber
  // one another. A subagent turn runs with a null workflow scope (spawning is
  // master-only), even though it executes inside the master's async context.
  private mode: 'single' | 'workflow' = 'single'
  private workflowCtx = new AsyncLocalStorage<WorkflowSession | null>()
  /**
   * Nested instruction files (a package's own AGENTS.md / CLAUDE.md below
   * the working folder) already attached to a conversation, so each one
   * rides a read result exactly once. Keyed by conversation id (turn id for
   * conversation-less runs); in-memory only — after a restart a file may
   * attach once more, which is harmless.
   */
  private attachedInstructionFiles = new Map<string, Set<string>>()
  /** Whether a conversation's PREVIOUS turn ran in plan mode (for the switch note). */
  private lastPlanTurn = new Map<string, boolean>()
  private readonly workspaceRoot: string

  constructor(options: AgentOptions) {
    this.thalamus = options.thalamus

    const workspaceRoot = options.workspaceRoot
    this.workspaceRoot = workspaceRoot
    this.corpus = new Corpus({ workspaceRoot })
    this.thalamus.setCorpus(this.corpus)

    const corpus = this.corpus
    const getContextBudget = options.defaultBudgetTokens
      ? () => options.defaultBudgetTokens!
      : () => this.thalamus.getContextBudget()
    this.ras = new RAS({ totalBudgetTokens: getContextBudget() })
    this.cortex = new Cortex({ workspaceRoot, corpus })
    this.amygdala = new Amygdala({ corpus })
    this.cerebellum = new Cerebellum({
      workspaceRoot,
      amygdala: this.amygdala,
      corpus
    })
    this.hippocampus = new Hippocampus({ workspaceRoot, corpus })
    this.basalganglia = new BasalGanglia({ workspaceRoot, corpus })
    this.device = new Device()
    this.prefrontal = new Prefrontal({
      workspaceRoot,
      cortex: this.cortex,
      ras: this.ras,
      cerebellum: this.cerebellum,
      hippocampus: this.hippocampus,
      basalganglia: this.basalganglia,
      corpus,
      device: this.device,
      getContextBudget,
      getContextWindow: () => this.thalamus.getActiveContextWindow()
    })
    this.wernicke = new Wernicke({ corpus })
    this.motor = new Motor({ workspaceRoot, cerebellum: this.cerebellum, corpus })
    this.hypothalamus = new Hypothalamus({
      corpus,
      workspaceRoot,
      cerebellum: this.cerebellum,
      thalamus: this.thalamus,
      device: this.device,
      getContextBudget,
      getActiveModel: options.getActiveModel
    })
    this.brainstem = new Brainstem({
      workspaceRoot,
      corpus,
      cortex: this.cortex,
      hippocampus: this.hippocampus,
      thalamus: this.thalamus
    })
    this.brainstem.setAgent(this)
    this.insula = new Insula({
      corpus,
      workspaceRoot,
      hypothalamus: this.hypothalamus,
      basalganglia: this.basalganglia,
      hippocampus: this.hippocampus
    })
    this.usage = new Usage({ workspaceRoot, corpus })
    // Side-calls that bypass the turn loop's captureUsage — summarization
    // (compaction / post-turn summarizer) and conversation titling — never
    // reached the ledger on their own. Thalamus emits them as llm.response
    // role:'summary' / role:'title'; record both here, where Usage lives.
    // (Titling is its own role so the ledger can itemize it as titling, not
    // summary.)
    corpus.on('llm.response', (payload) => {
      if (payload.role !== 'summary' && payload.role !== 'title') return
      const provider = payload.provider as ProviderId
      const cost = calculateCost(
        provider,
        payload.model,
        payload.inputTokens,
        payload.outputTokens,
        payload.cacheCreationTokens,
        payload.cacheReadTokens
      )
      void this.usage
        .recordUsage({
          timestamp: new Date(),
          provider,
          model: payload.model,
          inputTokens: payload.inputTokens,
          outputTokens: payload.outputTokens,
          cacheCreationTokens: payload.cacheCreationTokens,
          cacheReadTokens: payload.cacheReadTokens,
          cost
        })
        .catch(() => undefined)
    })
  }

  /**
   * Bring background services up: cortex SQLite index and the cerebellum's
   * capability scan. Both are safe to call repeatedly; the work only runs
   * once.
   */
  async init(): Promise<void> {
    if (!this.cortexReady) {
      this.cortexReady = this.cortex.init().catch((err) => {
        this.cortexReady = null
        throw err
      })
    }
    if (!this.cerebellumReady) {
      this.cerebellumReady = this.cerebellum
        .loadAll()
        .then(() => undefined)
        .catch((err) => {
          this.cerebellumReady = null
          throw err
        })
    }
    await Promise.all([this.cortexReady, this.cerebellumReady])
    await this.brainstem.init().catch(() => undefined)
    this.hypothalamus.init()
  }

  async stop(): Promise<void> {
    await this.hypothalamus.stop().catch(() => undefined)
    await this.brainstem.stop().catch(() => undefined)
    this.cortex.close()
    await this.cerebellum.stop().catch(() => undefined)
    await this.corpus.stop()
  }

  /**
   * Set the global chat mode. In 'workflow' mode a top-level (non-agent) turn
   * becomes a workflow master: it owns an agent registry and the `workflow`
   * capability is live. In 'single' mode every turn runs solo. Pushed from
   * config at startup and on the provider:setMode IPC.
   */
  setMode(mode: 'single' | 'workflow'): void {
    this.mode = mode
  }

  /** Wire the autonomous-run lifecycle broadcast (renderer status chips). */
  setAutonomousLifecycleListener(listener: ((ev: TurnLifecycleEvent) => void) | null): void {
    this.autonomousLifecycle = listener
  }

  /** Wire the autonomous-run live message mirror (renderer + phone). */
  setAutonomousMessageMirror(listener: MirrorMessageListener | null): void {
    this.autonomousMirror = listener
  }

  /**
   * Wire the autonomous-run mid-turn message inbox (main points it at the
   * TurnRunner's). Unset, autonomous runs simply cannot be steered — which is
   * exactly the behaviour this replaces, so leaving it null is safe.
   */
  setAutonomousInterjections(bridge: AutonomousInterjectionBridge | null): void {
    this.autonomousInterjections = bridge
  }

  /**
   * Snapshot of every autonomous run in flight, in the same shape TurnRunner
   * reports channel runs — index.ts concatenates the two for chat:activeRuns.
   * Without this, a window opened (or reopened from the tray) while an
   * automation runs would render its conversation idle: 'started' is a
   * broadcast, and this app keeps running with no window at all.
   */
  activeAutonomousRuns(): ActiveRun[] {
    const out: ActiveRun[] = []
    for (const [conversationId, run] of this.liveAutonomousRuns) {
      out.push({ conversationId, channel: run.channel, title: run.title })
    }
    return out
  }

  /** True while an automation/procedure run owns this conversation. */
  isAutonomousRunActive(conversationId: string): boolean {
    return this.liveAutonomousRuns.has(conversationId)
  }

  /**
   * Abort the autonomous run writing this conversation — what makes the
   * in-app Stop button real for an automation the user is watching. Mirrors
   * TurnRunner.cancelConversation, which never sees these runs.
   */
  cancelAutonomousRun(conversationId: string): boolean {
    const run = this.liveAutonomousRuns.get(conversationId)
    if (!run) return false
    run.controller.abort()
    return true
  }

  /**
   * The agent-management bridge handed to the `workflow` capability's plugin
   * (via cerebellum.setWorkflowHost). Every method operates on the active
   * master turn's registry — the single source of truth — and throws if no
   * workflow turn is in flight (which the capability gating makes unreachable
   * in practice). Model choices are validated HERE, at spawn time, so a bad
   * provider surfaces as an immediate tool error the master can react to.
   */
  workflowHost(): WorkflowHost {
    const session = (): WorkflowSession => {
      // Resolve the session for the turn whose tool call is executing right
      // now (ALS follows the async call tree), so two concurrent workflow
      // turns never reach into each other's registry.
      const active = this.workflowCtx.getStore()
      if (!active) {
        throw new Error(
          'no active workflow — the agent tools are only available to the master during a workflow-mode turn'
        )
      }
      return active
    }
    return {
      plan: (phases, note) => session().plan(phases, note),
      spawnAgent: ({ task, name, model, effort, phase }) =>
        session().spawn({
          task,
          name,
          model: this.parseModelChoice(model),
          effort,
          phase
        }),
      sendToAgent: (id, message, effort) => session().sendTo(id, message, effort),
      awaitAgents: (ids) => session().awaitNext(ids),
      cancelAgent: (id) => session().cancel(id),
      listAgents: () => session().list()
    }
  }

  /**
   * Parse and validate a master-supplied `provider/model` choice. Split on
   * the FIRST slash only — OpenRouter model ids contain slashes themselves
   * (`openrouter/anthropic/claude-…`). Unknown/unconnected providers throw
   * (an immediate, deterministic tool error); a model id missing from the
   * provider's cached catalog is accepted as-is — the catalog can lag the
   * provider, and a genuinely bad id lands as that agent's failure result.
   */
  private parseModelChoice(model?: string): WorkflowModelChoice | null {
    const raw = model?.trim()
    if (!raw) return null
    const slash = raw.indexOf('/')
    if (slash <= 0 || slash === raw.length - 1) {
      throw new Error(
        `invalid model "${raw}" — use "provider/model-id" exactly as listed in <workflow_models>, or omit for your own model`
      )
    }
    const choice = { provider: raw.slice(0, slash) as ProviderId, model: raw.slice(slash + 1) }
    const problem = this.thalamus.validateModelChoice(choice)
    if (problem) throw new Error(problem)
    return choice
  }

  /**
   * Drive one subagent turn to completion and harvest its final text. An
   * agent is a real `respond()` turn with: a fresh Broca whose segments stay
   * OUT of the user sink (the workflow card is the subagent surface — the
   * observer only counts tool calls and collects text), `role:'agent'` (lean
   * context, no channel/delegation tools), an optional per-agent model,
   * `conversationId:null` (invisible — no conversation persistence),
   * `bypassApproval` (the master is its operator), and its own abort signal
   * (the registry kills it on cancel). An agent never retries at the code
   * level — a failure surfaces to the master, which decides whether to
   * re-run.
   */
  private runAgentTurn(parent: AgentTurnOptions): RunAgentTurn {
    return async (args) => {
      const agentBroca = new Broca({
        corpus: this.corpus,
        shouldSilenceToolCall: isInternalToolCall
      })
      const texts: string[] = []
      const result = await this.respond({
        history: [...args.history],
        turnId: `${parent.turnId}::${args.agentId}`,
        onSegment: (seg: Segment) => {
          if (seg.kind === 'text') texts.push(seg.delta)
          else if (seg.kind === 'tool_call') args.onToolCall()
        },
        signal: args.signal,
        conversationId: null,
        broca: agentBroca,
        bypassApproval: true,
        role: 'agent',
        modelOverride: args.model ?? undefined,
        // The master sets each agent's reasoning effort; omitted ⇒ the agent
        // model's provider default. The user's Brain reasoning setting drives
        // only the master turn, never the agents.
        thinkingMode: args.effort,
        readOnly: args.readOnly === true,
        onUsage: (provider, model, usage) => args.onLlmCall(provider, model, usage),
        // Surface this subagent's no-progress escalation up to the workflow so
        // the master can be woken from agents_await to manage it.
        onNoProgress: (signal) => args.onNoProgress?.(signal)
      })
      const text = texts.join('').trim()
      const failed = result.stopReason === 'error' || result.stopReason === 'no_provider_available'
      return {
        text: text || '(agent produced no text output)',
        stopReason: String(result.stopReason),
        failed
      } satisfies WorkflowAgentResult
    }
  }

  private async processHistoryAttachments(
    history: ChatMessage[],
    modelSel: WorkflowModelChoice | null = null
  ): Promise<ChatMessage[]> {
    const provider = modelSel?.provider ?? this.thalamus.getActiveProvider()
    // Attachments are 100% model-led: content is NEVER auto-injected — every
    // file becomes a reference note and the model pulls what it needs via
    // tools (pdf_read/pdf_search, file_read, image_view). supportsVision
    // only picks the image note's wording (view-on-demand vs can't-see).
    const isLocal = provider === null || provider === 'local'
    const supportsVision = isLocal
      ? await this.thalamus.localSupportsVision()
      : cloudModelSupportsVision(provider, modelSel?.model ?? this.thalamus.getActiveModel() ?? '')

    // Attachment aging: reference notes (with their type facts and tool
    // guidance) are generated only for attachments in the RECENT window —
    // older messages keep just their <attachments> metadata text, which
    // already names each file's absolute path for on-demand retrieval.
    let lastAttachmentIdx = -1
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i] as { role: string; attachments?: MessageAttachmentInput[] }
      if (m.role === 'user' && m.attachments && m.attachments.length > 0) {
        lastAttachmentIdx = i
        break
      }
    }

    const out: ChatMessage[] = []
    for (let i = 0; i < history.length; i++) {
      const m = history[i]
      if (m.role !== 'user') {
        out.push(m)
        continue
      }
      const raw = m as {
        role: 'user'
        content: string | UserContentBlock[]
        attachments?: MessageAttachmentInput[]
      }
      if (!raw.attachments || raw.attachments.length === 0) {
        out.push(m)
        continue
      }
      const recent = i === lastAttachmentIdx || i >= history.length - ATTACHMENT_VERBATIM_WINDOW
      if (!recent) {
        out.push(m)
        continue
      }
      const fileBlocks = await processAttachments(raw.attachments, { supportsVision })
      if (fileBlocks.length === 0) {
        out.push(m)
        continue
      }
      const textContent = typeof raw.content === 'string' ? raw.content : ''
      const blocks: UserContentBlock[] = []
      if (textContent) blocks.push({ type: 'text', text: textContent })
      blocks.push(...fileBlocks)
      out.push({ role: 'user', content: blocks })
    }
    return out
  }

  /**
   * Run one turn. Establishes the turn-scoped conversation (AsyncLocalStorage)
   * so the tool calls inside it stamp artifacts with THIS turn's conversation,
   * even while concurrent worker turns run with their own (null) scope. Workers
   * are nested respond() calls; each gets its own scope here.
   */
  async respond(turn: AgentTurnOptions): Promise<AgentTurnResult> {
    // Every turn gets its own segment emitter. Turns run concurrently, so a
    // shared Broca would let turn B's beginTurn re-point the sink mid-stream
    // and stamp A's output with B's turnId — per-turn instances make that
    // class of collision structurally impossible.
    const broca =
      turn.broca ?? new Broca({ corpus: this.corpus, shouldSilenceToolCall: isInternalToolCall })
    // A top-level turn in workflow mode owns an agent registry; a subagent
    // turn and single mode do not. The session is created here and pinned to
    // this turn's async scope (workflowCtx.run) so the WorkflowHost resolves
    // THIS turn's registry even when several top-level turns run concurrently.
    // A per-turn override (heartbeat job / procedure mode) beats the global.
    const isWorkflowTurn = turn.role !== 'agent' && (turn.modeOverride ?? this.mode) === 'workflow'
    const workflow: WorkflowSession | null = isWorkflowTurn
      ? new WorkflowSession(
          `wf_${turn.turnId}`,
          this.runAgentTurn(turn),
          () => {
            const provider = this.thalamus.getActiveProvider()
            const model = this.thalamus.getActiveModel()
            return provider && model ? { provider, model } : null
          },
          // Snapshots ride the MASTER turn's segment stream (deterministic
          // card truth). Same broca reference runRespond uses; emits after
          // broca.endTurn() are dropped by broca's guard, which is why the
          // finally block finalizes the session BEFORE ending the turn.
          (snapshot) => {
            broca.emitWorkflow(turn.turnId, snapshot)
          }
        )
      : null
    // Video tasks born in this turn ride its broca as live task-card
    // segments (the workflow-card pattern). Registered for the turn's whole
    // life and removed in the finally so VideoTaskManager can tell "turn
    // still streaming" (broca path) from "turn ended" (broadcast +
    // conversation-file write-through + channel fallback delivery).
    const unregisterVideoEmitter = videoTasks.registerTurnEmitter(turn.turnId, (snapshot) =>
      broca.emitTask(turn.turnId, snapshot)
    )
    // Same pattern for a turn-end countdown armed in this turn: its `armed`
    // card rides this broca; the clock starts (and every later state flows
    // through main's listeners) only once the TurnRunner reports the turn
    // ended — see countdowns.turnEnded.
    const unregisterCountdownEmitter = countdowns.registerTurnEmitter(turn.turnId, (snapshot) =>
      broca.emitCountdown(turn.turnId, snapshot)
    )
    // Same pattern for a blocking `wait`: its card is emitted from inside the
    // tool call that is holding this turn open, so it can only reach the user
    // through this turn's broca.
    const unregisterWaitEmitter = waits.registerTurnEmitter(turn.turnId, (snapshot) =>
      broca.emitWait(turn.turnId, snapshot)
    )
    // Same pattern for a page opened in Wolffish's own browser: its live card
    // rides this turn's broca while the turn runs; after that, every change
    // reaches the renderer through the browser:changed broadcast.
    const unregisterBrowserEmitter = browserTabs.registerTurnEmitter(turn.turnId, (snapshot) =>
      broca.emitBrowser(turn.turnId, snapshot)
    )
    // Same pattern for a process card opened by process_show in this turn:
    // live updates ride this broca; after the turn, process:cardChanged.
    const unregisterProcessEmitter = processManager.registerTurnEmitter(turn.turnId, (snapshot) =>
      broca.emitProcess(turn.turnId, snapshot)
    )
    // Same pattern for a tool call that checked in as still running: when it
    // finally lands while this turn is still open, its card flips in place
    // (a second tool_result for the same call, folded by every persist path).
    const unregisterCheckInEmitter = checkIns.registerTurnEmitter(turn.turnId, (record) =>
      this.emitCheckInLanding(broca, turn.turnId, record)
    )
    try {
      return await this.cerebellum.runWithConversation(turn.conversationId ?? null, () =>
        this.workflowCtx.run(workflow, () => this.runRespond(turn, workflow, broca))
      )
    } finally {
      unregisterVideoEmitter()
      unregisterCountdownEmitter()
      unregisterWaitEmitter()
      unregisterBrowserEmitter()
      unregisterProcessEmitter()
      unregisterCheckInEmitter()
    }
  }

  /** The in-place card update for a parked call that landed (or was stopped) mid-turn. */
  private emitCheckInLanding(broca: Broca, turnId: string, record: ParkedCall): void {
    const result = record.result
    if (!result) return
    const stopped = record.state === 'stopped'
    const meta = {
      ...(result.meta ?? {}),
      durationMs: (record.finishedAt ?? Date.now()) - record.startedAt,
      checkIn: { handle: record.handle, state: stopped ? 'stopped' : 'finished' },
      ...(stopped && record.stoppedBy ? { stoppedBy: record.stoppedBy } : {})
    } as ToolResultMeta
    broca.emitToolResultUpdate(
      turnId,
      record.toolCallId,
      stopped ? 'stopped' : result.ok ? 'success' : 'failed',
      result.output,
      result.ok ? undefined : (result.verbose ?? result.output),
      meta
    )
  }

  /**
   * OpenCode's lazy nested-instruction rule: the first time a turn reads a
   * file under a subdirectory that carries its own AGENTS.md / CLAUDE.md
   * (below the working folder, whose file is already pinned), that file
   * rides the read result as a system-reminder. Returns '' when there is
   * nothing new to attach.
   */
  private async nestedInstructionReminder(
    rawPath: string,
    folders: string[],
    key: string
  ): Promise<string> {
    if (folders.length === 0) return ''
    const expanded = rawPath.startsWith('~/')
      ? path.join(os.homedir(), rawPath.slice(2))
      : rawPath === '~'
        ? os.homedir()
        : rawPath
    const abs = path.isAbsolute(expanded) ? expanded : path.resolve(folders[0], expanded)
    const file = await findNestedInstructionFile(abs, folders).catch(() => null)
    if (!file) return ''
    let attached = this.attachedInstructionFiles.get(key)
    if (!attached) {
      attached = new Set()
      this.attachedInstructionFiles.set(key, attached)
    }
    if (attached.has(file)) return ''
    const content = await readInstructionFile(file)
    if (!content || !content.trim()) return ''
    attached.add(file)
    return formatNestedInstructionReminder(file, content)
  }

  private async runRespond(
    turn: AgentTurnOptions,
    workflow: WorkflowSession | null,
    broca: Broca
  ): Promise<AgentTurnResult> {
    await this.init().catch(() => undefined)

    const lastMessage = turn.history[turn.history.length - 1]
    const userContent =
      lastMessage && lastMessage.role === 'user'
        ? typeof lastMessage.content === 'string'
          ? lastMessage.content
          : ''
        : ''
    this.corpus.emit('message.received', {
      content: userContent,
      timestamp: new Date().toISOString()
    })

    const messages: ChatMessage[] = await this.processHistoryAttachments(
      [...turn.history],
      turn.modelOverride ?? null
    )
    // Project context: computed ONCE per turn (turn-stable, so the pinned
    // prompt cache never churns mid-turn) and appended to the system prompt
    // below. Instructions verbatim; files as a model-led reference list.
    const projectOverlay = await buildProjectOverlay(turn.projectId ?? null).catch(() => '')
    // The project's own reasoning effort — applied when the caller passed
    // none (channel turns; runs whose stamp and chat both resolve empty),
    // the working-folders contract: resolved live per turn, so editing the
    // project moves the effort for every conversation already inside it. An
    // explicit per-turn value always wins — the in-app composer (which
    // already sends the project's mode when one is active) or a procedure's
    // and automation's own stamp is the more specific instruction.
    const projectMode =
      turn.thinkingMode == null
        ? await projectThinking(turn.projectId ?? null).catch(() => null)
        : null
    // An automation's or procedure's own attached files, on the same terms and
    // for the same cache reason: one string, computed before the loop,
    // appended to the system prompt beside the project block.
    const filesOverlay = await buildAttachedFilesOverlay(
      turn.contextFiles ?? [],
      turn.contextFilesOwner ?? 'automation'
    ).catch(() => '')
    let task: Awaited<ReturnType<typeof this.motor.createTask>> | null = null
    let totalToolCalls = 0
    let iterationCount = 0
    // File names a tool auto-delivered to the user this turn. Fed to the runtime
    // tail (deliveredFilesReminder) so the model is reminded not to re-send them
    // via send_file — turn-scoped and reset per respond() call, and it rides the
    // post-cache-breakpoint tail so it never perturbs the cached history prefix.
    const deliveredThisTurn = new Set<string>()
    // Closing-message guard (see agent/closing-guard). Turn-scoped: the failure
    // it covers is intra-turn — two wrap-ups inside ONE turn, either side of a
    // turn-closing tool call. Advisory only; it tells the model the news is
    // already out and lets it decide, and it rides the runtime tail into a call
    // the model was making anyway, so it costs no extra request.
    const closingGuard = createClosingGuardState()
    // Mid-turn user messages (interjections). Drained at the loop's two stop
    // points only — never inside a tool batch, where an unanswered tool_use
    // would follow. Each delivered message is pushed as a real user entry
    // (after the batch's tool results, so Anthropic-shaped wires merge it
    // into that same user turn) and emitted as a `user_message` segment at
    // the same moment, which is what puts it at its true position in every
    // surface's transcript. The notice rides the volatile tail for exactly
    // the iteration that delivered it.
    let interjectionNoticeText: string | undefined
    // Armed by either delivery point; the loop top turns it into the notice
    // for the very next model call and disarms it, so a delivery at the
    // would-end branch (which `continue`s back to the top) is not wiped by
    // the top's own reset.
    let interjectionNoticeArmed = false
    const deliverInterjections = async (): Promise<boolean> => {
      const items = turn.takeInterjections?.() ?? []
      if (items.length === 0) return false
      for (const item of items) {
        const [msg] = await this.processHistoryAttachments(
          [interjectionToHistoryMessage(item)],
          turn.modelOverride ?? null
        )
        messages.push(msg)
        const recorded = broca.emitUserMessage(turn.turnId, item)
        console.log(
          `[agent] mid-turn message delivered (iter ${iterationCount}, ${item.channel}, ${item.text.length} chars)` +
            (recorded ? '' : ' — NOT RECORDED: no open segment channel for this turn')
        )
      }
      interjectionNoticeArmed = true
      return true
    }
    // Stop point 2's variant: the model's reply (no tool calls) must sit in
    // history BEFORE the message that arrived during it — the order the user
    // saw. Reads the inbox first so a non-empty reply is only pushed when
    // there is something to answer; an empty reply is skipped (providers
    // reject empty assistant content) and the message still follows the last
    // tool results.
    let lastParsedReply: { text: string; thinking?: string } | null = null
    const deliverInterjectionsAfterReply = async (): Promise<boolean> => {
      const items = turn.takeInterjections?.() ?? []
      if (items.length === 0) return false
      const reply = lastParsedReply
      if (reply && reply.text.trim()) {
        const replyMsg: ChatMessage = { role: 'assistant', content: reply.text }
        if (reply.thinking) replyMsg.reasoningContent = reply.thinking
        messages.push(replyMsg)
      }
      for (const item of items) {
        const [msg] = await this.processHistoryAttachments(
          [interjectionToHistoryMessage(item)],
          turn.modelOverride ?? null
        )
        messages.push(msg)
        const recorded = broca.emitUserMessage(turn.turnId, item)
        console.log(
          `[agent] mid-turn message delivered at end of reply (iter ${iterationCount}, ${item.channel}, ${item.text.length} chars)` +
            (recorded ? '' : ' — NOT RECORDED: no open segment channel for this turn')
        )
      }
      interjectionNoticeArmed = true
      return true
    }
    // Bounded guard against a silent empty end_turn (no tool calls, no text) —
    // see emptyTurnNudge. Loop-scoped so it persists across iterations and
    // resets per respond() call; it is the only thing that stops such a turn
    // from looping (the outer while(true) has no numeric iteration cap).
    let emptyTurnNudges = 0
    // Computer-use screen indicator ("Wolffish is capturing your screen"),
    // raised and lowered by the model alone. Tracked per run — never probed
    // globally — so a concurrent conversation's live session is never mistaken
    // for this turn's, and so neither guard below can act on a glow this run
    // did not raise. See screen-indicator-guard.
    // The same set now also carries the mobile driving indicator; both ride
    // the registry in screen-indicator-guard, so every layer below iterates
    // INDICATORS instead of naming one capability.
    let indicatorsOn = new Set<string>()
    let screenIndicatorNudges = 0
    // The last screen/device action's evidence + expectation, carried in the
    // tail so the next step verifies it (see screen-indicator-guard).
    let lastComputerAction: LastIndicatorAction | null = null
    // No-progress guard: observes tool-call repetition and surfaces it to the
    // model via the runtime tail (never caps or aborts). Loop-scoped, reset per
    // respond() call. `noProgressReported` dedups the master escalation to once
    // per spinning episode (re-armed when the agent recovers below the worker
    // bar) so a parked master isn't re-woken on every iteration.
    const noProgress = new NoProgressTracker()
    // Highest master-escalation band already reported this episode (repeats /
    // NO_PROGRESS_MASTER_REPEATS): escalate to the master only when it climbs to
    // a new band, and reset to 0 when the agent recovers — so a parked master is
    // woken a small, bounded number of times, not on every iteration.
    let noProgressBand = 0
    // Voice replies notice, controlled by the Preferences switch ALONE
    // (config.tts.voiceReplies, default ON) — deliberately NOT by whether
    // this turn's message happens to be a voice note: the preference decides
    // whether the standing policy is stated, and the notice's own wording is
    // conditional ("whenever the user message is a <voice_note>…"), so it is
    // truthful on typed turns too. Computed ONCE per turn, restated in the
    // runtime tail every iteration — the <voice_prompts> system-prompt block
    // carries the full rule, and the shipped failure was a model reading
    // that block and replying in text anyway, so the rule also rides at the
    // request's most salient position. Master/single turns only: a subagent
    // never speaks to the user. Config read failure means no notice
    // (fail-open to the system prompt's own rule), never a crash.
    const voiceReplyNotice =
      turn.role !== 'agent' &&
      !this.cerebellum.isDisabled('text-to-speech') &&
      (await readConfig().catch(() => null))?.tts?.voiceReplies !== false
        ? VOICE_REPLY_NOTICE
        : undefined
    // Conversation-resumed notice: the previous persisted message's age,
    // rendered once per turn (now = turn start, so the string — and with it
    // the volatile tail — stays byte-stable across the turn's iterations).
    // Undefined for an active conversation (< the notice's gap floor), a
    // fresh conversation, or any caller that didn't thread lastMessageAt
    // (subagents, autonomous runs). Master/single turns only: a subagent's
    // task brief has no "we last spoke" to resume.
    const lastMessageNotice =
      turn.role !== 'agent' ? formatLastMessageNotice(turn.lastMessageAt) : undefined
    // Phone-notification notice, gated exactly like the voice one and for the
    // same shipped reason (a rule buried in a 25k-token prompt loses to the
    // task at hand). Three gates, all resolved once per turn:
    //   role      a subagent never notifies the user — `phone` is in
    //             AGENT_EXCLUDED_CAPABILITIES, so the tool isn't even there.
    //   presence  the mobile channel registers/withdraws the capability with
    //             pairing + phone identity + the user's notifications switch,
    //             so its presence IS the availability check (see
    //             updateNotifyToolRegistration). Name hard-coded for the same
    //             decoupling reason prefrontal's CHANNEL_CAPABILITIES is —
    //             runtime must not import the channel layer.
    //   disabled  `phone` is core-exposed but not locked, so the Capabilities
    //             page can still switch it off.
    // Fail-closed: no phone, no notice — instructions for an absent tool are
    // noise. Mid-turn re-pairing is not tracked; it lands on the next turn.
    const phoneNotifyAvailable =
      turn.role !== 'agent' &&
      !this.cerebellum.isDisabled('phone') &&
      this.cerebellum.getCapabilities().some((c) => c.name === 'phone')
    // Telegram/WhatsApp turns get the narrower notice: the reply itself
    // arrives on that same phone as a message with its own notification, so a
    // turn-end push is a second buzz for one thing. Major beats only there.
    const phoneNotifyIdle =
      turn.channel === 'telegram' || turn.channel === 'whatsapp'
        ? PHONE_NOTIFY_CHANNEL_NOTICE
        : PHONE_NOTIFY_NOTICE
    // Flips once, the first time a notify_phone call reaches the phone this
    // turn (or may have — see the UNCONFIRMED note at the call site). One tail
    // transition per turn, like deliveredThisTurn.
    let notifiedThisTurn = false
    // The browser twin. notify_web is registered while a browser is signed in
    // to the Web UI and notifications are allowed (index.ts syncWebCapability
    // ties the registration to exactly that), so presence is the check here
    // too — same channel narrowing, same once-per-turn flip.
    const webNotifyAvailable =
      turn.role !== 'agent' &&
      !this.cerebellum.isDisabled('web-ui') &&
      this.cerebellum.getCapabilities().some((c) => c.name === 'web-ui')
    const webNotifyIdle =
      turn.channel === 'telegram' || turn.channel === 'whatsapp'
        ? WEB_NOTIFY_CHANNEL_NOTICE
        : WEB_NOTIFY_NOTICE
    let webNotifiedThisTurn = false
    // The task list this turn continues: the conversation's latest todo list
    // when it still has unfinished items (a turn interrupted mid-work leaves
    // one behind). Model-led — the model is told about it every iteration
    // until it writes, and its todo_write then carries the ORIGINAL list id
    // so the earlier card resolves in place instead of a second checklist
    // appearing. `fresh: true` on the write starts a new list instead.
    const inheritedTodo =
      turn.role !== 'agent' && turn.conversationId
        ? await loadConversation(turn.conversationId)
            .then((conv) => (conv ? openTodoList(conv.messages.map((m) => m.segments)) : null))
            .catch(() => null)
        : null
    let todoListId: string | null = inheritedTodo?.listId ?? null
    let todoWrittenThisTurn = false
    // The list as this turn last wrote it. Drives the task-list tail notice
    // and the turn-end close-out nudge (see todo-guard).
    let todoItemsThisTurn: TodoItem[] | null = null
    let todoNudges = 0
    let stopReason: SegmentTurnEndReason | 'canceled' = 'end_turn'
    let lastAssistantText = ''
    let lastReasoningContent: string | undefined
    let noProviderAvailable: NoProviderAvailableInfo[] | null = null
    let providerErrors: NoProviderAvailableInfo[] | undefined
    const turnTools: TurnToolCall[] = []
    let turnUsage: StreamUsage = { inputTokens: 0, outputTokens: 0 }
    let turnProvider: ProviderId | null = null
    let turnModel: string | null = null
    // Track the most recent LLM response's input token count (uncached +
    // cache reads — providers report them separately). This is ground
    // truth from the provider and beats any char-based estimation.
    // Passed to compactOverflow so it can calibrate against reality.
    let lastIterationInputTokens = 0
    // Superseded-read stubbing rewrites older results, which re-bills every
    // cached token after them; it pays only near the window. Latched on for
    // the rest of the turn once reached, so stubs never flip back and forth.
    let supersedeOutbound = false
    // When a context-overflow 400 fires, we force compaction and retry
    // exactly once. This flag prevents infinite retry loops.
    let contextOverflowRetried = false

    // Context optimization gates (default on). `enabled` pins the system
    // prompt and tool list for the whole turn so every byte upstream of
    // the messages tail stays cache-stable; the live loop counters travel
    // as an outbound-only volatile tail message instead. `truncation`
    // additionally collapses provably superseded/duplicated payloads in
    // the outbound clone (internal history is never touched). Disabling
    // `enabled` restores the legacy per-iteration prompt rebuild.
    const cfg = await readConfig().catch(() => null)
    const optimizationConfig = cfg?.contextOptimization
    const optimizeContext = optimizationConfig?.enabled !== false
    const truncateOutbound = optimizeContext && optimizationConfig?.truncation !== false
    // ONE unified path for every model, local or cloud: same context, same
    // tools, same memory, same doctrine. The only local-specific artifact is
    // a small honesty overlay (prefrontal LOCAL_MODEL_PROMPT) — prompt text,
    // not logic. The old stateless/restrict lobotomies existed because the
    // full-fat context drowned small models; the lean assembly removed the
    // reason they existed. A per-agent model override is always cloud.
    const isLocalProvider = turn.modelOverride
      ? false
      : this.thalamus.getActiveProvider() === 'local'

    // Resolve the local model's real context window up front — before the
    // system prompt is built and the conversation runs — by hitting Ollama's
    // /api/show (warms the LocalProvider cache). Without this, the first turn
    // after Ollama starts reads a cold cache: context assembly, the
    // `context.built` meter event, and num_ctx would all use the 16k fallback
    // until a later turn happens to warm it. Cached after the first call, so
    // this is a no-op on subsequent turns; cloud providers resolve
    // synchronously. Best-effort — if Ollama is momentarily unreachable the
    // window stays uncached and falls back, exactly as before.
    if (isLocalProvider) {
      await this.thalamus.resolveActiveContextWindow().catch(() => undefined)
    }

    let pinnedSystemPrompt: string | null = null
    let pinnedTools: ToolDefinition[] | null = null
    // Cerebellum tool-surface version captured when the pin was built. When a
    // skill is created/edited/enabled/disabled mid-turn (via the `skills`
    // capability), the cerebellum's generation moves and we rebuild the pin
    // on the next iteration — so the new/edited tool is callable in the SAME
    // turn, enabling create→load→test→edit→retest without ending the turn.
    let pinnedGeneration = -1
    // Full tool list for providers that restrict callable tools per request
    // (see toolUniverseFor). Null = send the exposed set as before. With a
    // universe pinned, an activation-only version move keeps the pinned
    // prompt: only the callable subset changes, so the cached prefix holds.
    let pinnedUniverse: ToolDefinition[] | null = null
    let pinnedGlobalGeneration = -1

    // Working-folder listing: read ONCE per turn, main-side, and delivered via
    // the outbound volatile tail (after every cache breakpoint) — never baked
    // into persisted or replayed user content.
    //
    // A project's own folders join the turn's here, at the ONE seam every
    // surface passes through: an in-app chat inside the project, a channel
    // turn, an automation or a procedure bound to it all get them, and editing
    // the project moves them for conversations already running. Deduped
    // because the conversation may have picked the same folder itself.
    const turnWorkingFolders = [
      ...new Set([
        ...(turn.workingFolders ?? []),
        ...(await projectWorkingFolders(turn.projectId ?? null).catch(() => []))
      ])
    ]
    // The folders become the turn's working directory contract: the shell's
    // default cwd and the file tools' relative-path base (plugins read them
    // through PluginContext.getWorkingFolders). Entered on the turn's async
    // context, so every tool call — and every workflow agent spawned inside
    // this turn — resolves the same folders.
    this.cerebellum.enterWorkingFolders(turnWorkingFolders)
    // Live repo facts (branch, dirty count, detected toolchain and check
    // commands) ride the tail beside the listing — computed once per turn.
    let folderFacts: FolderFacts[] = []
    let folderFactsBlock = ''
    if (turnWorkingFolders.length > 0) {
      const described = await describeWorkingFolders(turnWorkingFolders).catch(() => null)
      folderFacts = described?.facts ?? []
      folderFactsBlock = described?.block ?? ''
    }
    // The facts block is refreshed after any iteration that ran a mutating
    // tool (an edit, a write, a shell command), so the git state the model
    // reads stays true mid-turn — a "clean" reading from turn start beside a
    // diff it just made was read as a reverted edit in a benchmark run.
    let workingFoldersBlock =
      turnWorkingFolders.length > 0
        ? [await renderWorkingFolders(turnWorkingFolders), folderFactsBlock]
            .filter((b) => b.length > 0)
            .join('\n')
        : ''
    let folderFactsStale = false
    const refreshFolderFacts = async (): Promise<void> => {
      if (!folderFactsStale || turnWorkingFolders.length === 0) return
      folderFactsStale = false
      const described = await describeWorkingFolders(turnWorkingFolders).catch(() => null)
      if (!described) return
      folderFacts = described.facts
      folderFactsBlock = described.block
      workingFoldersBlock = [await renderWorkingFolders(turnWorkingFolders), folderFactsBlock]
        .filter((b) => b.length > 0)
        .join('\n')
    }
    // Instruction files (AGENTS.md / CLAUDE.md) found in the working folders
    // go in the PINNED prompt, not the tail: they change rarely and the
    // model should read them as standing doctrine. Computed once per turn so
    // the cached prefix stays byte-stable across iterations.
    const instructionsOverlay =
      folderFacts.length > 0 ? await buildInstructionsOverlay(folderFacts).catch(() => '') : ''
    // The coding doctrine rides the pinned prompt only for code projects —
    // a non-coding turn never pays for it. Provider-specific addenda key on
    // the turn's provider (override, else the configured brain).
    // Read-only turns: plan mode (with its one writable plan file) and
    // explore agents. The gate itself sits in the tool loop; these blocks
    // tell the model the rules and ride the volatile tail.
    const planKey = turn.conversationId ?? turn.turnId
    const planFileFor = (key: string): string =>
      path.join(this.workspaceRoot, 'files', 'plans', `${key.replace(/[^a-z0-9_-]/gi, '_')}.md`)
    const planFile = turn.planMode ? planFileFor(planKey) : null
    const readOnly = turn.planMode === true || turn.readOnly === true
    let readOnlyBlock = ''
    if (turn.planMode) {
      readOnlyBlock = renderPlanModeBlock(planFile ?? '', turnWorkingFolders.length > 0)
    } else if (turn.readOnly) {
      readOnlyBlock = READ_ONLY_AGENT_BLOCK
    } else if (this.lastPlanTurn.get(planKey)) {
      readOnlyBlock = renderPlanSwitchBlock(planFileFor(planKey))
    }
    if (turn.role !== 'agent') this.lastPlanTurn.set(planKey, turn.planMode === true)
    let codingOverlay = ''
    if (anyCodeFolder(folderFacts)) {
      const provider =
        turn.modelOverride?.provider ??
        (await readConfig().catch(() => null))?.llm?.brain?.providerId ??
        null
      codingOverlay = await this.prefrontal.buildCodingOverlay(provider ?? null).catch(() => '')
    }

    broca.beginTurn(turn.turnId, turn.onSegment)
    // Publish the active conversation to the UI/extension ONCE, for real
    // (non-agent) turns only — a subagent is invisible and must never flip the
    // visible conversation, and a sealed background run (publishConversation:
    // false) must never flip it either. The turn-scoped stamp itself rides on
    // ALS (see respond), so this is purely the global + conversation.changed
    // emit. With concurrent turns the global is last-started-wins by design —
    // it is a UI/extension display pointer, not a correctness input.
    const publishConversation = turn.role !== 'agent' && turn.publishConversation !== false
    if (publishConversation) {
      this.cerebellum.setCurrentConversationId(turn.conversationId ?? null, turn.conversationTitle)
    }

    // `workflow` (created in respond() and already pinned to this turn's ALS
    // scope) is non-null exactly for a top-level workflow turn. The tool
    // surface keys off it: master → agent tools visible; a single-mode
    // top-level turn → undefined (hidden); a subagent → 'agent'.
    const isMasterTurn = workflow !== null
    const toolRole: 'master' | 'agent' | undefined =
      turn.role === 'agent' ? 'agent' : isMasterTurn ? 'master' : undefined
    // Per-agent model choice: budget/window/vision/tool-cap math below must
    // follow the model that actually serves this turn, not the global Brain.
    const modelSel = turn.modelOverride ?? null
    let onTurnAbort: (() => void) | null = null
    if (workflow && turn.signal) {
      // Cancel propagation: if the turn aborts while the master is parked in
      // agents_await, dispose wakes the awaiter so the tool loop can unwind.
      const session = workflow
      onTurnAbort = () => session.dispose()
      turn.signal.addEventListener('abort', onTurnAbort)
    }

    try {
      while (true) {
        if (turn.signal?.aborted) {
          stopReason = 'canceled'
          break
        }

        // Stop point 1: a message the user sent during the previous tool
        // batch (or before the very first call) is read now, before the model
        // picks its next step. The notice rides this iteration's tail only —
        // armed here or by stop point 2, disarmed for the next pass.
        await deliverInterjections()
        interjectionNoticeText = interjectionNoticeArmed ? INTERJECTION_NOTICE : undefined
        interjectionNoticeArmed = false

        iterationCount += 1

        // Host connectivity, sampled fresh each iteration — the same signal
        // the thalamus uses to skip cloud providers. When definitively
        // offline, the runtime context tells the model so it works from its
        // own knowledge and offline tools instead of burning iterations on
        // internet tools that can only fail. Fail-open: a detection error
        // must never mislabel a healthy connection.
        const online = isHostOnline()

        // No-progress signal for THIS iteration, computed from the calls made so
        // far. Rides the same volatile vehicle as the counters (runtime tail /
        // legacy <runtime> block, both after every cache breakpoint) so it never
        // perturbs the cached prompt prefix. `null` renders nothing.
        const noProgressSignal = noProgress.signal()
        const noProgressText = noProgressNotice(noProgressSignal) ?? undefined
        // Parked tool calls (runtime/check-in.ts): still running or finished
        // unread. Same vehicle as noProgress — the model is told every
        // iteration until it reads or stops them; nothing ends them for it.
        const checkInsText = checkIns.noticeText(turn.conversationId ?? turn.turnId)

        // Channel-format notices — a prose-mirroring channel reporting that an
        // already-DELIVERED prose block reached the user's phone with raw
        // markup (observe-and-notify: the model repairs its own text; nothing
        // rewrites it). Drained once per iteration; rides the same volatile
        // vehicle as the no-progress notice so it never perturbs the cached
        // prompt prefix. Empty (the common case) renders nothing.
        const channelNotices = turn.formatNotices?.() ?? []
        const channelFormatText = channelNotices.length > 0 ? channelNotices.join(' ') : undefined

        // Faked-silence notice — the previous model call ended its visible text
        // in a literal control token, a lone punctuation mark or a bracketed
        // stand-in for silence, which the user saw as-is (observe-and-notify:
        // the model repairs its own behaviour; nothing rewrites its output).
        // Drained once per iteration; rides the same volatile vehicle as the
        // no-progress notice so it never perturbs the cached prompt prefix.
        // Undefined (the common case) renders nothing.
        //
        // The slot is global, so the notice reaches the model even when the
        // leak happened in a conversation that ended with it (every autonomous
        // run mints a fresh sealed conversation, so that is the common case,
        // not the corner one). Draining is gated to the same roles that arm:
        // worker text never reaches the user, so a worker must not swallow the
        // notice the master is owed.
        const controlTokenText =
          turn.role !== 'agent' ? drainControlTokenNotice(turn.conversationId ?? null) : undefined

        // Async video-task landings the model has not consumed (it moved on
        // instead of calling video_await). Rides the same volatile vehicle;
        // drained once per iteration so a landing is announced exactly once.
        const videoNotices = videoTasks.drainNotices(turn.conversationId ?? null)
        const videoTasksText = videoNotices.length > 0 ? videoNotices.join(' ') : undefined

        // Screen-indicator notice: present on every iteration from the moment
        // this turn raises the computer-use glow until it lowers it. The
        // user's screen is currently saying they are being captured, so the
        // rule that takes it down rides at the request's most salient
        // position — the same observe-and-notify vehicle, and the same
        // shipped failure (a rule read once in a long prompt, then lost to a
        // task that went well), as the phone and voice notices.
        const screenIndicatorText = indicatorNoticeText(indicatorsOn, lastComputerAction)

        // Closing-message notice: this turn already wrote its wrap-up and closed
        // it with a turn-closing tool, so the model is told once that the news is
        // out and a second telling is the same paragraph twice. Master/single
        // only — an agent turn holds no delivery tools (see AGENT_EXCLUDED_
        // CAPABILITIES), so it has no closer to double up on. Spent on drain, so
        // it rides exactly one call. See agent/closing-guard.
        const closingNoticeText = turn.role === 'agent' ? undefined : closingNotice(closingGuard)

        // Phone-notification notice for THIS iteration: the cadence reminder
        // until something goes out, then the don't-repeat guard. Undefined
        // when no phone is reachable — see phoneNotifyAvailable.
        const phoneNotifyText = !phoneNotifyAvailable
          ? undefined
          : notifiedThisTurn
            ? PHONE_NOTIFY_SENT_NOTICE
            : phoneNotifyIdle
        const webNotifyText = !webNotifyAvailable
          ? undefined
          : webNotifiedThisTurn
            ? WEB_NOTIFY_SENT_NOTICE
            : webNotifyIdle

        // Escalate a SUBAGENT's runaway to its master (onNoProgress is wired only
        // for agent turns) so the master can manage it — cancel, steer, or keep
        // waiting. Once per worsening band; re-armed when the agent recovers
        // below the worker bar. Never auto-acts; the master decides.
        if (turn.onNoProgress) {
          const repeats = noProgressSignal?.repeats ?? 0
          if (repeats < NO_PROGRESS_WORKER_REPEATS) {
            noProgressBand = 0
          } else if (repeats >= NO_PROGRESS_MASTER_REPEATS && noProgressSignal) {
            const band = Math.floor(repeats / NO_PROGRESS_MASTER_REPEATS)
            if (band > noProgressBand) {
              noProgressBand = band
              turn.onNoProgress(noProgressSignal)
            }
          }
        }

        const runtime = {
          iteration: iterationCount,
          toolsCalled: totalToolCalls,
          renderCounters: !optimizeContext,
          deliveredFiles: [...deliveredThisTurn],
          online,
          lastMessage: lastMessageNotice,
          noProgress: noProgressText,
          channelFormat: channelFormatText,
          controlToken: controlTokenText,
          videoTasks: videoTasksText,
          closing: closingNoticeText,
          openTodo:
            inheritedTodo && !todoWrittenThisTurn ? openTodoNotice(inheritedTodo) : undefined,
          taskList: todoItemsThisTurn ? openTaskListNotice(todoItemsThisTurn) : undefined,
          processes: processManager.noticeText(turn.conversationId ?? null) || undefined,
          checkIns: checkInsText,
          voiceReply: voiceReplyNotice,
          phoneNotify: phoneNotifyText,
          webNotify: webNotifyText,
          screenIndicator: screenIndicatorText,
          interjection: interjectionNoticeText
        }

        let systemPrompt: string
        let filteredTools: ToolDefinition[]
        if (optimizeContext) {
          // Task-start pin: prompt and tools are derived once per turn and
          // reused across iterations. Rebuilt when THIS conversation's
          // toolset version moves — a mid-turn tool_search activation, a
          // skill created/edited/toggled, an MCP surface change. Another
          // conversation's activation never invalidates this pin (or its
          // provider prompt-cache prefix).
          const currentVersion = this.cerebellum.getToolsetVersion(turn.conversationId ?? null)
          const currentGlobal = this.cerebellum.getToolsetGeneration()
          if (
            pinnedSystemPrompt === null ||
            pinnedTools === null ||
            pinnedGeneration !== currentVersion
          ) {
            const activationOnly =
              pinnedSystemPrompt !== null &&
              pinnedUniverse !== null &&
              pinnedGlobalGeneration === currentGlobal
            if (!activationOnly || pinnedSystemPrompt === null) {
              pinnedUniverse = this.toolUniverseFor(modelSel, toolRole, turn.conversationId ?? null)
              pinnedSystemPrompt = await this.prefrontal.buildSystemPrompt(
                userContent,
                runtime,
                toolRole,
                {
                  localModel: isLocalProvider,
                  channel: turn.channel,
                  conversationId: turn.conversationId ?? null
                }
              )
            }
            pinnedTools = this.slimForWindow(
              this.filterToolsForProvider(
                this.prefrontal.selectTools(toolRole, turn.conversationId ?? null),
                userContent,
                modelSel,
                toolRole
              ),
              modelSel,
              toolRole
            )
            pinnedGeneration = currentVersion
            pinnedGlobalGeneration = currentGlobal
          }
          systemPrompt = pinnedSystemPrompt
          filteredTools = pinnedTools
        } else {
          // Legacy path: rebuild the system prompt each iteration so the
          // <runtime> block reflects the live iteration counter.
          systemPrompt = await this.prefrontal.buildSystemPrompt(userContent, runtime, toolRole, {
            localModel: isLocalProvider,
            channel: turn.channel,
            conversationId: turn.conversationId ?? null
          })
          filteredTools = this.slimForWindow(
            this.filterToolsForProvider(
              this.prefrontal.selectTools(toolRole, turn.conversationId ?? null),
              userContent,
              modelSel,
              toolRole
            ),
            modelSel,
            toolRole
          )
        }
        if (projectOverlay) systemPrompt = systemPrompt + projectOverlay
        if (filesOverlay) systemPrompt = systemPrompt + filesOverlay
        if (instructionsOverlay) systemPrompt = systemPrompt + instructionsOverlay
        if (codingOverlay) systemPrompt = systemPrompt + codingOverlay

        // Context Compaction: if context exceeds the model's input budget,
        // use LLM-generated summaries to reduce size while retaining
        // critical details. Only fires when actually needed.
        const compactionStart = Date.now()
        const compaction = await compactOverflow(
          this.thalamus,
          systemPrompt,
          messages,
          turn.signal,
          {
            // Sized on what is sent: the whole universe when one is pinned.
            tools: filteredTools.length > 0 ? (pinnedUniverse ?? filteredTools) : undefined,
            lastKnownInputTokens: lastIterationInputTokens,
            inputBudget: modelSel ? this.thalamus.getContextBudgetFor(modelSel) : undefined,
            onStarted: (targetsCount, currentTokens) => {
              this.corpus.emit('compaction.started', { messagesCount: messages.length })
              const contextWindow = this.thalamus.getContextWindowFor(modelSel)
              broca.emitCompactionStarted(
                turn.turnId,
                messages.length,
                targetsCount,
                currentTokens,
                contextWindow
              )
            }
          }
        )
        if (compaction) {
          const compactionDurationMs = Date.now() - compactionStart
          broca.emitCompaction(
            turn.turnId,
            compaction.targets.length,
            compaction.tokensSaved,
            compactionDurationMs,
            compaction.targets.map((t) => ({
              toolName: t.toolName,
              originalChars: t.originalChars,
              compactedChars: t.compactedChars,
              compactedBy: t.compactedBy
            }))
          )
          this.corpus.emit('compaction.applied', {
            tokensSaved: compaction.tokensSaved,
            targetsCount: compaction.targets.length
          })
        }

        await refreshFolderFacts()
        const stream = this.thalamus.stream({
          system: systemPrompt,
          messages,
          tools: filteredTools.length > 0 ? filteredTools : undefined,
          toolUniverse: filteredTools.length > 0 ? (pinnedUniverse ?? undefined) : undefined,
          signal: turn.signal,
          role: turn.role,
          modelOverride: turn.modelOverride,
          thinkingMode: turn.thinkingMode ?? projectMode ?? undefined,
          cacheKey: turn.conversationId ?? turn.turnId,
          truncateOutbound,
          supersedeOutbound: (supersedeOutbound ||=
            lastIterationInputTokens >=
            this.thalamus.getContextWindowFor(modelSel) * SUPERSEDE_PRESSURE),
          // The live runtime tail (host clock + loop counters) rides at the
          // very end of the outbound clone — omitted on iteration 1 (unless
          // working folders need announcing or the host is offline, both
          // facts the model needs before its first tool pick) so the first
          // cache write is a clean prefix. It renders strictly after every
          // cache breakpoint (see anthropic.ts), so it never perturbs a
          // prefix hash.
          volatileStatus:
            optimizeContext &&
            // voiceReplyNotice keeps iteration 1 in: a conversational voice
            // turn often ends without a single tool call, so a tail deferred
            // to iteration 2 would never render the one notice that matters.
            // phoneNotifyText is in for exactly the same reason — a turn that
            // answers from knowledge alone still has to close with a
            // notification, and it never reaches iteration 2 to be told.
            // lastMessageNotice too: a "welcome back after 3 weeks" turn is
            // typically pure conversation, and the gap must inform the very
            // first reply, not the second iteration that never comes.
            // controlTokenText keeps iteration 1 in for the same reason: the
            // leak is typically a turn's FINAL call, so the armed notice
            // arrives at the NEXT turn's first iteration — deferring the tail
            // to iteration 2 would drop the one notice this guard exists for.
            (iterationCount > 1 ||
              workingFoldersBlock ||
              readOnlyBlock ||
              !online ||
              lastMessageNotice ||
              noProgressText ||
              channelFormatText ||
              controlTokenText ||
              videoTasksText ||
              closingNoticeText ||
              voiceReplyNotice ||
              phoneNotifyText ||
              webNotifyText ||
              screenIndicatorText ||
              interjectionNoticeText ||
              checkInsText)
              ? formatRuntimeStatus({
                  iteration: iterationCount,
                  toolsCalled: totalToolCalls,
                  deliveredFiles: [...deliveredThisTurn],
                  online,
                  lastMessage: lastMessageNotice,
                  noProgress: noProgressText,
                  channelFormat: channelFormatText,
                  controlToken: controlTokenText,
                  videoTasks: videoTasksText,
                  closing: closingNoticeText,
                  checkIns: checkInsText,
                  voiceReply: voiceReplyNotice,
                  phoneNotify: phoneNotifyText,
                  webNotify: webNotifyText,
                  screenIndicator: screenIndicatorText,
                  interjection: interjectionNoticeText
                }) +
                (workingFoldersBlock ? `\n${workingFoldersBlock}` : '') +
                (readOnlyBlock ? `\n${readOnlyBlock}` : '')
              : undefined
        })
        const teed = broca.streamSegments(stream)
        const tracked = captureUsage(teed, (provider, model, usage) => {
          if (provider) turnProvider = provider
          if (model) turnModel = model
          if (usage) {
            // Session-scoped per-call usage feedback for the workflow card:
            // agent turns report through their spawn callback; the MASTER
            // turn feeds its own session directly so the card can show the
            // true whole-turn spend, not just the agents'.
            if (provider && model) {
              const delta = {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheReadTokens: usage.cacheReadTokens ?? 0,
                cacheCreationTokens: usage.cacheCreationTokens ?? 0
              }
              turn.onUsage?.(provider, model, delta)
              workflow?.recordMasterUsage(provider, model, delta)
            }
            // Track per-iteration input tokens for compaction calibration.
            // This is ground truth from the provider — use it on the next
            // iteration to catch cases where char estimation underestimates.
            // Cache reads count: they are real context the model ingested,
            // and once caching works they dominate the total.
            lastIterationInputTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0)
            turnUsage = {
              inputTokens: turnUsage.inputTokens + usage.inputTokens,
              outputTokens: turnUsage.outputTokens + usage.outputTokens,
              cacheCreationTokens:
                (turnUsage.cacheCreationTokens ?? 0) + (usage.cacheCreationTokens ?? 0),
              cacheReadTokens: (turnUsage.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0)
            }
          }
        })
        const parsed = await this.wernicke.parse(tracked)

        if (turn.signal?.aborted) {
          stopReason = 'canceled'
          break
        }

        if (parsed.error) {
          // Detect context-overflow 400s: the provider rejected the request
          // because the payload exceeded its context window. Instead of
          // crashing, force compaction and retry exactly once.
          // "prompt is too long" is Anthropic's exact context-overflow 400
          // wording; "request too large"/"payload too large" cover request-size
          // rejections (413-class), where compacting bulky tool results can
          // genuinely shrink the body enough to succeed.
          const isContextOverflow =
            /maximum context length|context.length.*exceeded|too many tokens|reduce the length|prompt is too long|request too large|payload too large/i.test(
              parsed.error
            )

          if (isContextOverflow && !contextOverflowRetried) {
            contextOverflowRetried = true
            console.log(
              `[agent] Context overflow detected — forcing compaction and retrying. ` +
                `Error: ${parsed.error.slice(0, 200)}`
            )
            // Note: not emitting a corpus event here to avoid type changes.
            // The console.log above provides observability.

            // Force compaction — bypasses the estimate check and compacts
            // the largest messages unconditionally.
            const overflowCompactionStart = Date.now()
            const overflowCompaction = await compactOverflow(
              this.thalamus,
              systemPrompt,
              messages,
              turn.signal,
              {
                tools: filteredTools.length > 0 ? (pinnedUniverse ?? filteredTools) : undefined,
                lastKnownInputTokens: lastIterationInputTokens,
                inputBudget: modelSel ? this.thalamus.getContextBudgetFor(modelSel) : undefined,
                force: true,
                onStarted: (targetsCount, currentTokens) => {
                  this.corpus.emit('compaction.started', {
                    messagesCount: messages.length,
                    force: true
                  })
                  const contextWindow = this.thalamus.getContextWindowFor(modelSel)
                  broca.emitCompactionStarted(
                    turn.turnId,
                    messages.length,
                    targetsCount,
                    currentTokens,
                    contextWindow
                  )
                }
              }
            )
            if (overflowCompaction) {
              const dur = Date.now() - overflowCompactionStart
              broca.emitCompaction(
                turn.turnId,
                overflowCompaction.targets.length,
                overflowCompaction.tokensSaved,
                dur,
                overflowCompaction.targets.map((t) => ({
                  toolName: t.toolName,
                  originalChars: t.originalChars,
                  compactedChars: t.compactedChars,
                  compactedBy: t.compactedBy
                }))
              )
              this.corpus.emit('compaction.applied', {
                tokensSaved: overflowCompaction.tokensSaved,
                targetsCount: overflowCompaction.targets.length
              })
            }
            // Don't increment iterationCount — this is a retry of the same
            // iteration, not a new one. Just loop back to rebuild prompt
            // and re-call the LLM with the compacted messages.
            iterationCount -= 1
            continue
          }

          if (parsed.noProviderAvailable) {
            stopReason = 'no_provider_available'
            noProviderAvailable = parsed.noProviderAvailable
          } else {
            stopReason = 'error'
            if (parsed.providerFailures) {
              providerErrors = parsed.providerFailures
            }
          }
          if (task) await this.motor.completeTask(task.id, 'failed').catch(() => undefined)
          throw new Error(parsed.error)
        }

        if (parsed.thinking) lastReasoningContent = parsed.thinking

        // Faked-silence watch: a model that "says nothing" by typing a
        // stand-in for it — an end-of-sequence marker (grok-4.6's literal
        // `<|eos|>`), a lone punctuation mark, or a bracketed status note
        // (`(no output)`, `(no content)`) — has just sent the user visible
        // clutter in place of a clean empty ending. Observe-and-
        // notify only — the text streams on untouched; the armed notice tells
        // the model on its next call (this turn's next iteration, or the
        // conversation's next turn) and the model decides what to do. Worker
        // text never reaches the user, so agent roles don't arm.
        if (turn.role !== 'agent') {
          const leakedToken = trailingControlToken(parsed.text)
          const placeholder = leakedToken ? null : silencePlaceholder(parsed.text)
          const contentFree = leakedToken || placeholder ? null : contentFreeReply(parsed.text)
          // Three shapes of one failure, checked in order of how specific the
          // evidence is; they are mutually exclusive in practice (a token
          // carries `<|…|>`, a placeholder carries words, a content-free reply
          // carries only punctuation), so the order only decides which notice
          // wins if a reply somehow managed to be two of them.
          if (leakedToken) armControlTokenNotice(turn.conversationId ?? null, leakedToken)
          else if (placeholder)
            armSilencePlaceholderNotice(turn.conversationId ?? null, placeholder)
          else if (contentFree) armContentFreeReplyNotice(turn.conversationId ?? null, contentFree)
        }

        if (parsed.toolCalls.length === 0) {
          lastParsedReply = { text: parsed.text, thinking: parsed.thinking }
          if (parsed.stopReason === 'max_tokens') {
            // A max_tokens stop normally means the reply was cut off mid-output,
            // so we let the model continue. But when the *input* already fills
            // the context window there is no room to generate into — the
            // "continue" turn below just gets truncated away and the loop spins
            // forever emitting ~1 token per call (a local model whose prompt has
            // grown to num_ctx). Detect that and end the turn with what we have.
            const contextWindow = this.thalamus.getContextWindowFor(modelSel)
            const contextFull =
              lastIterationInputTokens >= contextWindow - CONTEXT_FULL_MARGIN_TOKENS
            if (contextFull) {
              console.log(
                `[agent] max_tokens stop with context full ` +
                  `(${lastIterationInputTokens}/${contextWindow} input tokens) — ` +
                  `ending turn (iter ${iterationCount})`
              )
              lastAssistantText = parsed.text
              stopReason = 'max_tokens'
              break
            }
            console.log(`[agent] max_tokens truncation — continuing (iter ${iterationCount})`)
            const truncatedMsg: ChatMessage = { role: 'assistant', content: parsed.text }
            if (parsed.thinking) truncatedMsg.reasoningContent = parsed.thinking
            messages.push(truncatedMsg)
            messages.push({
              role: 'user',
              content:
                '[System: Your previous response was truncated by the output token limit. Do NOT repeat what you already said. Continue from where you stopped.]'
            })
            continue
          }

          // Stop point 2: the model is done with what it was asked, but a
          // message arrived while it was answering. The turn does not end
          // with a user message unread — the reply so far stays in history
          // (it already streamed to the user), the message lands after it,
          // and the loop goes round once more so the model answers it here
          // instead of the surface opening a fresh turn. An empty reply is
          // skipped rather than pushed: providers reject empty assistant
          // content, and the message still follows the last tool results.
          const pendingBeforeEnd = turn.takeInterjections
            ? await deliverInterjectionsAfterReply()
            : false
          if (pendingBeforeEnd) {
            console.log(
              `[agent] end_turn with a mid-turn message pending — continuing (iter ${iterationCount})`
            )
            continue
          }

          // Silent empty end_turn: the model ended its turn with no tool calls
          // and no visible text (a reasoning model can emit a reasoning block
          // but an empty content channel). Left alone this ends the run
          // mid-plan with no closing message to the user. Nudge it to continue
          // or wrap up — bounded by MAX_EMPTY_TURN_NUDGES so it can never spin.
          const nudge = emptyTurnNudge(parsed, emptyTurnNudges)
          if (nudge) {
            emptyTurnNudges += 1
            console.log(
              `[agent] empty end_turn (no output, no tool call) — nudging to ` +
                `continue (${emptyTurnNudges}/${MAX_EMPTY_TURN_NUDGES}, iter ${iterationCount})`
            )
            messages.push(...nudge)
            continue
          }

          // The turn is ending with the computer-use screen indicator this run
          // raised still on the user's display, telling them they are being
          // captured by an agent that has stopped. Send it back once (twice at
          // most) so the model closes it itself — the lifecycle stays the
          // model's, this only refuses to let the turn end while the claim is
          // live. See screen-indicator-guard.
          const glowNudge = indicatorNudge(indicatorsOn, parsed, screenIndicatorNudges)
          if (glowNudge) {
            screenIndicatorNudges += 1
            console.log(
              `[agent] end_turn with an indicator still on — nudging for ` +
                `${glowNudge.offTool} (${screenIndicatorNudges}/${MAX_SCREEN_INDICATOR_NUDGES}, iter ${iterationCount})`
            )
            // The nudge tells the model its reply is already delivered and to
            // end empty once the indicator is down. Honour that: an empty
            // close is now the instructed outcome, not the glitched dropout
            // emptyTurnNudge exists to catch, and nudging it for obeying would
            // buy two more model calls and a closing message the user does not
            // need. The turn is one tool call from over, so the budget this
            // spends has nothing left to protect.
            emptyTurnNudges = MAX_EMPTY_TURN_NUDGES
            messages.push(...glowNudge.messages)
            continue
          }

          // The turn is ending with the task list it wrote this turn still
          // showing open items — the card the user reads as "still working".
          // Send it back once so the model writes the true final state itself
          // (completed / cancelled / blocked-with-follow-up). See todo-guard.
          const todoNudge = todoCloseoutNudge(todoItemsThisTurn, parsed, todoNudges)
          if (todoNudge) {
            todoNudges += 1
            console.log(
              `[agent] end_turn with the task list still open — nudging for a todo_write ` +
                `close-out (${todoNudges}/${MAX_TODO_NUDGES}, iter ${iterationCount})`
            )
            // Same honour as the indicator nudge. The aside no longer ORDERS
            // an empty close — demanding silence from a model that cannot emit
            // a zero-token content channel is what buys a placeholder — but it
            // still offers one, so a model that takes it is making the call the
            // aside handed it, not dropping out. Never chase that.
            emptyTurnNudges = MAX_EMPTY_TURN_NUDGES
            messages.push(...todoNudge)
            continue
          }

          lastAssistantText = parsed.text
          stopReason = mapProviderStopReason(parsed.stopReason)
          break
        }

        // The LLM wants to call tools. Materialize a task on first iteration
        // so the renderer can show task progress alongside the streaming reply.
        if (!task) {
          task = await this.motor.createTask(userContent || 'Tool execution')
        }

        // close_turn — the model's explicit "everything is delivered and
        // nothing further is needed". Handled before dispatch so it never
        // becomes a task step and never reaches the amygdala. Its tool_call
        // segment already streamed, so it is answered here: left open, the
        // turn-end sweep stamped EVERY close as "failed — interrupted because
        // the run was stopped", which drew a failed card on each turn and
        // replayed into the next turn's history as a failed call.
        // This is the producible exit that replaces the old, impossible
        // "end with an entirely empty response" ask; see cerebellum's
        // registerCloseTurnCapability for why that ask had to go.
        //
        // Every OTHER call in the same batch still runs: a model that closes
        // the turn alongside real work gets the work done and then stops. Only
        // when close_turn is the sole call does the turn end here.
        //
        // This runs BEFORE the assistant message below is built, and that
        // ordering is the whole point: close_turn is intercepted here and never
        // dispatched, so no tool message will ever answer it. A message that
        // declares it next to calls that ARE dispatched is a request no provider
        // accepts — "An assistant message with 'tool_calls' must be followed by
        // tool messages responding to each 'tool_call_id'" — and that rejection
        // failed a turn whose work had already finished and shipped.
        const closeTurnCall = parsed.toolCalls.find((tc) => tc.name === 'close_turn')
        if (closeTurnCall) {
          broca.emitToolResult(turn.turnId, closeTurnCall.id, 'success', 'Turn closed.')
          console.log(
            `[agent] close_turn${parsed.toolCalls.length > 1 ? ` (with ${parsed.toolCalls.length - 1} other call(s))` : ''} — ending turn (iter ${iterationCount})`
          )
          const others = parsed.toolCalls.filter((tc) => tc.name !== 'close_turn')
          if (others.length === 0) {
            lastAssistantText = parsed.text
            stopReason = 'closed'
            break
          }
          parsed.toolCalls = others
          parsed.stopReason = 'tool_use'
        }

        const toolUses: ToolUse[] = parsed.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          args: tc.args
        }))
        const assistantMsg: ChatMessage = { role: 'assistant', content: parsed.text, toolUses }
        if (parsed.thinking) assistantMsg.reasoningContent = parsed.thinking
        if (parsed.providerReasoning) assistantMsg.providerReasoning = parsed.providerReasoning
        messages.push(assistantMsg)

        // Parallel read batches: when one assistant message carries several
        // tool calls, the read-only ones (file_read, file_grep, file_glob,
        // memory_search… — frontmatter `readOnly: true`) START now, bounded,
        // and are awaited below at their own position in the batch. Mutating
        // and approval-gated calls keep their sequential slot, so a write
        // after a read in the same batch still sees the read complete
        // first. Segment order is untouched: tool_call segments already
        // streamed in order, and tool_result segments are emitted by the
        // sequential loop, in order, as each result is awaited.
        // The universal `check_in_after` argument (runtime/check-in.ts) is the
        // model's, not the tool's: split it off BEFORE the safety match and
        // the dispatch so it never reaches a plugin's schema or changes an
        // approval signature. The assistant message above keeps the args as
        // emitted — that is what the provider must see echoed back.
        const checkInSeconds = new Map<string, number>()
        parsed.toolCalls = parsed.toolCalls.map((tc) => {
          // call_wait takes the argument ITSELF — it is the delay of the
          // wait it performs, read by the check-in plugin — so it is the
          // one call that keeps it.
          if (tc.name === 'call_wait') return tc
          const split = splitCheckInArg(tc.args)
          if (split.seconds !== null) checkInSeconds.set(tc.id, split.seconds)
          return split.args === tc.args ? tc : { ...tc, args: split.args }
        })
        // One AbortController per call: the turn's Stop reaches the call
        // through it while the call is in flight, and call_stop aborts that
        // one call alone once it is parked (the motor's task signal would
        // take every later call of the turn down with it).
        const callControllers = new Map<string, AbortController>()
        const controllerFor = (id: string): AbortController => {
          let c = callControllers.get(id)
          if (!c) {
            c = new AbortController()
            callControllers.set(id, c)
          }
          return c
        }

        const prestarted = new Map<string, Promise<StepResult>>()
        if (task && parsed.toolCalls.length > 1) {
          let inflight = 0
          for (const call of parsed.toolCalls) {
            if (inflight >= PARALLEL_READ_LIMIT) break
            if (!this.cerebellum.isReadOnlyTool(call.name)) continue
            if (!this.cerebellum.isToolReady(call.name)) continue
            if (broca.isSilent(call.id)) continue
            const level = this.amygdala.match(call)?.level ?? 'safe'
            if (level !== 'safe' && level !== 'warn') continue
            const taskId = task.id
            const p = this.motor.executeStep(
              taskId,
              call,
              turn.signal,
              controllerFor(call.id).signal
            )
            // Swallow here; the awaiting slot below re-throws through the
            // same promise and handles it. Without this an early rejection
            // would surface as an unhandled rejection before its turn.
            p.catch(() => undefined)
            prestarted.set(call.id, p)
            inflight += 1
          }
        }

        let aborted = false
        for (const call of parsed.toolCalls) {
          if (turn.signal?.aborted) {
            aborted = true
            // Pre-started read-only calls whose slot was never reached are
            // linked to the turn's Stop only when awaited; abort them here so
            // a Stop mid-batch ends every call the batch started.
            for (const c of callControllers.values()) c.abort()
            break
          }

          const argsSummary = summarizeArgs(call.args)

          // Feed the no-progress guard every call the model makes (any outcome —
          // a denied-and-retried loop is no-progress too). Workflow orchestration
          // tools are control-flow, not work: a master legitimately re-issues
          // agents_await, so they never count toward repetition.
          if (!WORKFLOW_TOOL_NAMES.has(call.name)) {
            noProgress.record(call.name, call.args)
          }

          // Resolve dependencies BEFORE the original tool's safety gate.
          // ensureDependencies has its own internal amygdala approvals for
          // each install in the chain, so the user sees install dialogs in
          // chain order. If the chain fails, surface the error to the LLM
          // and skip both the original tool's safety check and execution.
          //
          // Pass a hook so synthetic install calls surface as real broca
          // segments. The approval card keys off matching tool_call
          // segments — without one the IPC fires fine but the dialog
          // never renders and the install Promise hangs.
          try {
            const depCapName = this.cerebellum.getToolCapability(call.name)
            if (depCapName) {
              const turnId = turn.turnId
              await this.cerebellum.ensureDependencies(depCapName, {
                emitToolCall: (id, name, args) => broca.emitToolCall(turnId, id, name, args),
                emitToolResult: (id, status, output, error) =>
                  broca.emitToolResult(turnId, id, status, output, error)
              })
            }
          } catch (depErr) {
            const depMessage = depErr instanceof Error ? depErr.message : String(depErr)
            const output = `Dependency error: ${depMessage}`
            messages.push({
              role: 'tool',
              toolUseId: call.id,
              toolName: call.name,
              content: output,
              isError: true
            })
            broca.emitToolResult(turn.turnId, call.id, 'failed', output, depMessage)
            turnTools.push({ name: call.name, argsSummary, outcome: 'failed' })
            continue
          }

          // Read-only gate (plan mode / explore agent): a call that would
          // change state is refused before any safety or execution step,
          // with the rule spelled out so the model adjusts instead of
          // retrying. The plan file is the one exception in plan mode.
          if (readOnly && !prestarted.has(call.id)) {
            const allowed =
              (await this.cerebellum.isReadOnlyCall(call.name, call.args).catch(() => false)) ||
              (planFile !== null && isPlanFileCall(call, planFile, turnWorkingFolders))
            if (!allowed) {
              const output = planFile
                ? `Refused: plan mode is active (read-only). ${call.name} would change something. Investigate with read-only tools, and write the plan itself to ${planFile} — the one file you may create or edit. Ask the user to turn plan mode off when they want it executed.`
                : `Refused: this run is read-only (explore agent). ${call.name} would change something. Observe with read-only tools and report your findings instead.`
              messages.push({
                role: 'tool',
                toolUseId: call.id,
                toolName: call.name,
                content: output,
                isError: true
              })
              broca.emitToolResult(turn.turnId, call.id, 'denied', output, 'read-only turn')
              turnTools.push({ name: call.name, argsSummary, outcome: 'denied' })
              continue
            }
          }

          const silent = broca.isSilent(call.id)
          const match = silent ? null : this.amygdala.match(call)
          const level = match?.level ?? 'safe'

          if (level === 'block') {
            const reason = match?.reason ?? 'destructive operation'
            const output = `Blocked by safety policy: ${reason}`
            messages.push({
              role: 'tool',
              toolUseId: call.id,
              toolName: call.name,
              content: output,
              isError: true
            })
            this.corpus.emit('safety.blocked', {
              tool: call.name,
              args: call.args,
              reason: match?.reason ?? 'blocked'
            })
            broca.emitToolResult(turn.turnId, call.id, 'denied', output, reason)
            turnTools.push({ name: call.name, argsSummary, outcome: 'blocked' })
            await this.basalganglia
              .recordOutcome({
                timestamp: new Date(),
                tool: call.name,
                outcome: 'blocked',
                args: call.args,
                reason
              })
              .catch(() => undefined)
            continue
          }

          if (level === 'confirm' || level === 'destructive') {
            if (turn.bypassApproval || this.amygdala.isBypassingPermissions()) {
              this.corpus.emit('safety.autoApproved', {
                id: `auto_${Date.now().toString(36)}`,
                tool: call.name,
                args: call.args,
                level,
                reason: match?.reason ?? 'requires confirmation'
              })
            } else {
              const description = await this.cerebellum
                .describeToolCall(call.name, call.args)
                .catch(() => undefined)
              const decision = await this.amygdala.requestApproval({
                toolCall: call,
                level,
                reason: match?.reason ?? 'requires confirmation',
                description,
                // "Allow for this conversation" rules are scoped here.
                sessionKey: turn.conversationId ?? turn.turnId
              })
              if (decision === 'denied') {
                const reason = match?.reason ?? 'requires confirmation'
                const output = `Denied by user: ${reason}`
                messages.push({
                  role: 'tool',
                  toolUseId: call.id,
                  toolName: call.name,
                  content: output,
                  isError: true
                })
                if (task) {
                  await this.motor.recordDeniedStep(task.id, call, output).catch(() => undefined)
                }
                broca.emitToolResult(turn.turnId, call.id, 'denied', output, reason)
                turnTools.push({ name: call.name, argsSummary, outcome: 'denied' })
                await this.basalganglia
                  .recordOutcome({
                    timestamp: new Date(),
                    tool: call.name,
                    outcome: 'denied',
                    args: call.args,
                    reason
                  })
                  .catch(() => undefined)
                continue
              }
            }
          } else {
            this.corpus.emit('safety.allowed', {
              tool: call.name,
              args: call.args
            })
          }

          // Snapshot the file BEFORE the first mutating file tool touches it
          // this turn, so changes_revert can put it back (snapshots.ts).
          if (FILE_MUTATING_TOOLS.has(call.name) && typeof call.args.path === 'string') {
            const target = resolveToolPath(call.args.path, turnWorkingFolders, this.workspaceRoot)
            await this.cerebellum.snapshots
              .capture(turn.conversationId ?? turn.turnId, turn.turnId, target)
              .catch(() => undefined)
          }
          let result: {
            ok: boolean
            output: string
            images?: Array<{ mediaType: string; data: string }>
            verbose?: string
            meta?: Record<string, unknown>
          }
          let checkedIn = false
          try {
            // A read-only call the batch pre-started (see prestarted above)
            // is awaited here, at its own position, so results land in call
            // order even though execution overlapped.
            const controller = controllerFor(call.id)
            const onTurnStop = (): void => controller.abort()
            if (turn.signal) {
              if (turn.signal.aborted) controller.abort()
              else turn.signal.addEventListener('abort', onTurnStop, { once: true })
            }
            const pending =
              prestarted.get(call.id) ??
              this.motor.executeStep(task.id, call, turn.signal, controller.signal)
            // The check-in race (runtime/check-in.ts): a call that outlives
            // its delay is parked — still running — and the model gets a
            // STILL RUNNING report instead of blocking on it. Tools whose
            // blocking is the model's own decision are never raced.
            const raced = CHECK_IN_EXEMPT_TOOLS.has(call.name)
              ? { kind: 'settled' as const, result: await pending }
              : await checkIns.race({
                  promise: pending,
                  controller,
                  conversationKey: turn.conversationId ?? turn.turnId,
                  turnId: turn.turnId,
                  toolCallId: call.id,
                  name: call.name,
                  argsSummary,
                  seconds: checkInSeconds.get(call.id) ?? DEFAULT_CHECK_IN_SECONDS
                })
            if (raced.kind === 'checked_in') {
              // Parked: the turn's Stop no longer reaches it through this
              // listener — abortTurn below covers a Stop explicitly — so a
              // turn that ENDS naturally leaves the call running, as the
              // model chose.
              turn.signal?.removeEventListener('abort', onTurnStop)
              checkedIn = true
              result = {
                ok: true,
                output: raced.text,
                meta: {
                  checkIn: { handle: raced.record.handle, state: 'running' },
                  durationMs: Date.now() - raced.record.startedAt
                }
              }
            } else {
              turn.signal?.removeEventListener('abort', onTurnStop)
              const r = raced.result
              result = {
                ok: r.ok,
                output: r.output,
                images: r.images,
                verbose: r.verbose,
                meta: r.meta
              }
            }
          } catch (err) {
            if (err instanceof SafetyBlockedError) {
              result = { ok: false, output: `Blocked: ${err.reason}` }
            } else {
              const message = err instanceof Error ? err.message : String(err)
              result = { ok: false, output: `Tool error: ${message}` }
            }
          }
          // A read under a subdirectory with its own instruction file attaches
          // that file once (see nestedInstructionReminder). Appended to the
          // output BEFORE the segment is emitted so the persisted tool_result
          // and the model's context stay byte-identical.
          if (call.name === 'file_read' && result.ok && typeof call.args.path === 'string') {
            const reminder = await this.nestedInstructionReminder(
              call.args.path,
              turnWorkingFolders,
              turn.conversationId ?? turn.turnId
            ).catch(() => '')
            if (reminder) result.output += reminder
          }
          totalToolCalls += 1
          // A turn-closing tool that actually LANDED — a failed send is not a
          // close, so this reads result.ok. See agent/closing-guard.
          if (result.ok) recordClosingTool(closingGuard, call.name, parsed.text)
          if (result.ok && MUTATING_FOLDER_TOOLS.has(call.name)) folderFactsStale = true
          // Follow the computer-use screen indicator this run raised: the tail
          // notice, the turn-end nudge and the terminal failsafe all read this
          // one flag. Successful calls only — a glow that failed to appear is
          // not on the user's screen.
          indicatorsOn = trackIndicators(indicatorsOn, call.name, result.ok)
          if (result.ok) {
            const la = lastIndicatorActionFrom(result.meta)
            if (la) lastComputerAction = la
          }
          if (INDICATOR_OFF_TOOLS.has(call.name) && result.ok) lastComputerAction = null

          // A call that did not complete because someone ENDED it — the user's
          // Stop on the turn, or the model's call_stop read back through
          // call_wait — is `stopped`, not `failed`: the card wears a warning,
          // and meta.stoppedBy names who.
          const stoppedBy: 'user' | 'model' | undefined = checkedIn
            ? undefined
            : ((result.meta?.stoppedBy as 'user' | 'model' | undefined) ??
              (!result.ok && turn.signal?.aborted ? 'user' : undefined))
          const status: ToolResultStatus = checkedIn
            ? 'checked_in'
            : stoppedBy
              ? 'stopped'
              : result.ok
                ? 'success'
                : 'failed'
          const resultMeta = (stoppedBy ? { ...(result.meta ?? {}), stoppedBy } : result.meta) as
            | ToolResultMeta
            | undefined

          // Tools whose name ends with _to_chat inject their output directly
          // into the chat stream instead of showing a tool result card.
          // Multi-line output (e.g. several GIFs) is split on newlines so
          // each non-empty line gets its own bubble via a separator flush.
          if (call.name.endsWith('_to_chat') && result.ok && result.output) {
            const lines = result.output.split('\n').filter((l) => l.trim().length > 0)
            for (let i = 0; i < lines.length; i++) {
              broca.emitText(turn.turnId, lines[i])
              if (i < lines.length - 1) broca.emitSeparator(turn.turnId)
            }
            broca.emitToolResult(turn.turnId, call.id, 'success', 'Added to chat.', undefined)
          } else {
            broca.emitToolResult(
              turn.turnId,
              call.id,
              status,
              result.output,
              // UI-only `error` carries the raw original (full stdout+stderr)
              // so the user sees it as-is in a scrollable block. `output` keeps
              // the classified message — the only field replayed into model
              // context — so the verbose dump never clouds the conversation.
              result.ok ? undefined : (result.verbose ?? result.output),
              // UI-only structured facts (a diff, an exit code) — persisted on
              // the segment so a reopened conversation renders the same card.
              resultMeta
            )
          }
          // The model's task list is a card, not a tool chip: one checklist
          // per turn, upserted by turnId in its latest state (upsertTodoSegment).
          if (call.name === 'todo_write' && result.ok) {
            const items = normalizeTodoItems(call.args.todos)
            if (items) {
              const listId = call.args.fresh === true ? turn.turnId : (todoListId ?? turn.turnId)
              todoListId = listId
              todoWrittenThisTurn = true
              todoItemsThisTurn = items
              broca.emitTodo(turn.turnId, items, listId)
            }
          }

          const outcome = result.ok ? 'success' : 'failed'
          turnTools.push({ name: call.name, argsSummary, outcome })
          await this.basalganglia
            .recordOutcome({
              timestamp: new Date(),
              tool: call.name,
              outcome,
              args: call.args,
              ...(result.ok ? { output: result.output } : { error: result.output })
            })
            .catch(() => undefined)

          // Record any file the model delivered through this tool (the
          // [wolffish-output] marker — send_file's transport; bare {path}
          // JSON is mere generation and never counts as delivery). The
          // reminder rides the runtime tail (deliveredThisTurn → runtime /
          // volatileStatus), NOT this tool message — keeping it out of the
          // cached history prefix. Tool result content stays byte-identical to
          // the persisted segment, so cross-turn prefix caching is unaffected.
          if (result.ok) {
            for (const name of deliveredFileNames(result.output)) deliveredThisTurn.add(name)
          }

          // A phone notification landed this turn: the runtime tail switches
          // from "close the turn with one" to "don't repeat it".
          //
          // An UNCONFIRMED delivery counts as landed even though it reports as
          // a failure. That is the whole point of the phase: the relay never
          // answered, so the notification may already be on the user's lock
          // screen, and a tail still demanding one is exactly the pressure
          // that turned one model call into three notifications on 2026-08-08.
          // Every OTHER failure (a refused deeplink, the relay link down) left
          // nothing on the phone and says so — the reminder stays up, and the
          // tool's own answer tells the model to fix the link and call again.
          // Matched on the sentinel word rather than imported, because runtime
          // must not depend on the channel layer (same rule as
          // CHANNEL_CAPABILITIES); if that wording ever drifts, the behaviour
          // degrades to the pre-notice status quo, where the tool description
          // and the doctrine already forbid a retry.
          if (
            call.name === 'notify_phone' &&
            (result.ok || result.output.includes('UNCONFIRMED'))
          ) {
            notifiedThisTurn = true
          }
          if (call.name === 'notify_web' && (result.ok || result.output.includes('UNCONFIRMED'))) {
            webNotifiedThisTurn = true
          }

          const toolMsg: ChatMessage & { role: 'tool' } = {
            role: 'tool',
            toolUseId: call.id,
            toolName: call.name,
            content: call.name.endsWith('_to_chat') && result.ok ? 'Added to chat.' : result.output,
            isError: !result.ok
          }
          if (result.images && result.images.length > 0) {
            toolMsg.images = result.images
          }
          messages.push(toolMsg)
        }

        if (aborted) {
          stopReason = 'canceled'
          break
        }
      }

      // A run stopped mid-tool leaves tool_call segments with no matching
      // tool_result. Close them before turn_end so the persisted segment
      // stream — which the renderer and channels replay into the next
      // request's history — stays valid. No-op on a clean turn.
      if (stopReason === 'canceled') {
        broca.closeOpenToolCalls(turn.turnId, 'stopped', STOPPED_TOOL_RESULT, {
          stoppedBy: 'user'
        })
      } else {
        broca.closeOpenToolCalls(turn.turnId, 'failed', INTERRUPTED_TOOL_RESULT)
      }
      // A Stop on the turn stops what the turn parked too — the user pressed
      // Stop on THIS work. A turn that ends on its own leaves parked calls
      // running: that was the model's decision, and the next turn's runtime
      // status names them.
      if (stopReason === 'canceled') checkIns.abortTurn(turn.turnId)

      if (task) {
        // Motor derives succeeded/failed from per-step outcomes. We only
        // override on cancel — the abort is the agent's truth, not the
        // steps' (a step that finished cleanly an instant before the abort
        // shouldn't make the task look successful).
        const override = stopReason === 'canceled' ? 'stopped' : undefined
        await this.motor.completeTask(task.id, override).catch(() => undefined)
      }

      await this.hippocampus
        .appendEpisode({
          timestamp: new Date(),
          userMessage: userContent,
          toolCalls: turnTools,
          assistantResponse: lastAssistantText,
          // 'worker' kept as the persisted episode origin for subagent turns —
          // episode files predate the workflow rename and stay compatible.
          origin: turn.role === 'agent' ? 'worker' : (turn.channel ?? 'electron')
        })
        .catch(() => undefined)

      broca.emitTurnEnd(
        turn.turnId,
        segmentReasonFor(stopReason),
        iterationCount,
        undefined,
        lastReasoningContent
      )

      return {
        stopReason,
        toolCalls: totalToolCalls,
        taskId: task?.id
      }
    } catch (err) {
      // Same invariant on the error path: a tool call may have been emitted
      // before the failure. Close any still open so the segment stream the
      // channels persist isn't left with a dangling tool_call.
      broca.closeOpenToolCalls(turn.turnId, 'failed', INTERRUPTED_TOOL_RESULT)
      if (noProviderAvailable) {
        broca.emitTurnEnd(turn.turnId, 'no_provider_available', iterationCount, noProviderAvailable)
      } else {
        broca.emitTurnEnd(turn.turnId, 'error', iterationCount, providerErrors)
      }
      // Keep the workflow card's terminal status truthful: an unexpected
      // throw (not a user cancel) is an error, whatever the loop last set.
      if (stopReason !== 'canceled') {
        stopReason = noProviderAvailable ? 'no_provider_available' : 'error'
      }
      throw err
    } finally {
      // The computer-use screen indicator is a statement standing on the
      // user's display — "Wolffish is capturing your screen" — and this turn
      // is now over on every path that reaches here, so the statement is
      // false. The model owns the lifecycle wherever it can still act (the
      // runtime-tail notice every iteration, the turn-end nudge above); this
      // fires only where no model step is possible any more: a cancel, an
      // error, or a spent nudge budget. Not a timer and never mid-session —
      // only this run's own glow is ever cleared, so a concurrent
      // conversation's live session is untouched.
      if (indicatorsOn.size > 0) {
        const offTools = indicatorOffTools(indicatorsOn)
        indicatorsOn = new Set()
        console.log(
          `[agent] turn ended (${stopReason}) with an indicator still on — clearing it (${offTools.join(', ')})`
        )
        for (const offTool of offTools) {
          await this.cerebellum.executeTool(offTool, {}).catch(() => undefined)
        }
      }
      // Ledger truth must survive every exit path. This used to run only on
      // the success path, so a turn that errored on iteration 51 silently
      // dropped 50 iterations of real billed usage from the ledger while the
      // renderer had already shown the tokens live. Runs here so success,
      // cancel AND error all record.
      if (turnProvider && turnModel && (turnUsage.inputTokens > 0 || turnUsage.outputTokens > 0)) {
        const cost = calculateCost(
          turnProvider,
          turnModel,
          turnUsage.inputTokens,
          turnUsage.outputTokens,
          turnUsage.cacheCreationTokens,
          turnUsage.cacheReadTokens
        )
        await this.usage
          .recordUsage({
            timestamp: new Date(),
            provider: turnProvider,
            model: turnModel,
            inputTokens: turnUsage.inputTokens,
            outputTokens: turnUsage.outputTokens,
            cacheCreationTokens: turnUsage.cacheCreationTokens,
            cacheReadTokens: turnUsage.cacheReadTokens,
            cost
          })
          .catch(() => undefined)
        // Whole-turn roll-up with the cache split, so a 200-iteration task
        // leaves one line that says whether caching actually worked. Hit
        // rate counts cache writes in the denominator: on Anthropic each
        // iteration's fresh extension reports as cache_creation, not input,
        // and omitting it overstated the rate.
        const cacheRead = turnUsage.cacheReadTokens ?? 0
        const cacheWrite = turnUsage.cacheCreationTokens ?? 0
        const totalIngested = turnUsage.inputTokens + cacheRead + cacheWrite
        this.corpus.emit('turn.usage', {
          provider: turnProvider,
          model: turnModel,
          // Subagent turns keep the 'worker' wire value — the renderer's
          // meter routing and persisted ConversationStats predate the rename.
          role: turn.role === 'agent' ? 'worker' : 'brain',
          iterations: iterationCount,
          toolCalls: totalToolCalls,
          inputTokens: turnUsage.inputTokens,
          outputTokens: turnUsage.outputTokens,
          cacheCreationTokens: cacheWrite,
          cacheReadTokens: cacheRead,
          cacheHitRate: totalIngested > 0 ? cacheRead / totalIngested : 0,
          cost
        })
      }
      if (workflow) {
        // Tear the registry down BEFORE broca.endTurn(): finalize aborts every
        // surviving agent (no orphans) and emits the TERMINAL snapshot through
        // this turn's still-open segment channel — after endTurn the emit
        // would be silently dropped and every persisted card would say
        // 'running' forever. The ALS scope unwinds on its own when respond()'s
        // run() callback returns, so there is no shared pointer to clear.
        if (turn.signal && onTurnAbort) turn.signal.removeEventListener('abort', onTurnAbort)
        workflow.finalize(
          stopReason === 'canceled'
            ? 'canceled'
            : stopReason === 'error' || stopReason === 'no_provider_available'
              ? 'error'
              : 'completed'
        )
      }
      broca.endTurn()
      // Guarded clear: with concurrent turns, another conversation may have
      // published itself since this turn started — clearing unconditionally
      // would null a sibling turn's live pointer.
      if (publishConversation) {
        this.cerebellum.clearCurrentConversationId(turn.conversationId ?? null)
      }
      if (workflow) {
        // Flush queued disk writes so nothing lands half-written after the
        // turn closes.
        await diskWriter.flush().catch(() => undefined)
      }
    }
  }

  /**
   * The full tool list to pin for this turn, or null to keep shipping only
   * the exposed set. OpenAI only (it alone restricts callable tools per
   * request via `allowed_tools`, which keeps a changing subset out of the
   * cached prefix). Off until the conversation activates something beyond the
   * core set — a short chat keeps the lean first request — and off when the
   * universe would take more than a tenth of the window (~48k tokens for the
   * 336 bundled tools on 2026-10-13, against 1.05M on gpt-6.x).
   */
  private toolUniverseFor(
    modelSel: WorkflowModelChoice | null,
    toolRole: 'master' | 'agent' | undefined,
    conversationId: string | null
  ): ToolDefinition[] | null {
    const provider = modelSel?.provider ?? this.thalamus.getActiveProvider()
    if (provider !== 'openai') return null
    if (!this.cerebellum.hasActivations(conversationId)) return null
    const universe = this.prefrontal.selectToolUniverse(toolRole)
    const chars = universe.reduce((n, t) => n + JSON.stringify(t).length, 0)
    const window = this.thalamus.getContextWindowFor(modelSel)
    return chars / UNIVERSE_CHARS_PER_TOKEN <= window * UNIVERSE_MAX_WINDOW_SHARE ? universe : null
  }

  /**
   * Window-aware core-set slimming, keyed on the MEASURED context budget —
   * never on provider identity. The compactor can shrink messages but not
   * the prompt or tool schemas, so a small-window model (e.g. a local model
   * with a 16k trained context) must get a reduced bootstrap set or the
   * prompt alone would pin its window. Any model with a small window —
   * local or cloud — triggers this identically.
   */
  private slimForWindow(
    tools: ToolDefinition[],
    modelSel: WorkflowModelChoice | null = null,
    toolRole?: 'master' | 'agent'
  ): ToolDefinition[] {
    if (this.thalamus.getContextBudgetFor(modelSel) >= MIN_FULL_CORE_BUDGET_TOKENS) return tools
    // A workflow master must never lose its agent tools to window slimming —
    // the workflow.md doctrine commands them, and a dropped schema turns
    // every delegation attempt into an unknown-tool error.
    return tools.filter(
      (t) =>
        SMALL_WINDOW_BOOTSTRAP_TOOLS.has(t.name) ||
        (toolRole === 'master' && WORKFLOW_TOOL_NAMES.has(t.name))
    )
  }

  private filterToolsForProvider(
    tools: ToolDefinition[],
    message: string,
    modelSel: WorkflowModelChoice | null = null,
    toolRole?: 'master' | 'agent'
  ): ToolDefinition[] {
    const provider = modelSel?.provider ?? this.thalamus.getActiveProvider()
    const limit = PROVIDER_TOOL_LIMITS[provider ?? ''] ?? null
    if (limit === null || tools.length <= limit) {
      return tools
    }

    const capToolMap = new Map<string, ToolDefinition[]>()
    const orphaned: ToolDefinition[] = []
    for (const tool of tools) {
      // The master's workflow tools ride the always-kept bucket — relevance
      // scoring must never prune the delegation surface under a provider cap.
      const capName =
        toolRole === 'master' && WORKFLOW_TOOL_NAMES.has(tool.name)
          ? null
          : this.cerebellum.getToolCapability(tool.name)
      if (!capName) {
        orphaned.push(tool)
        continue
      }
      const list = capToolMap.get(capName) ?? []
      list.push(tool)
      capToolMap.set(capName, list)
    }

    const capMap = new Map(this.cerebellum.getCapabilities().map((c) => [c.name, c]))

    const scored: Array<{ name: string; score: number; tools: ToolDefinition[] }> = []
    for (const [capName, capTools] of capToolMap) {
      const cap = capMap.get(capName)
      const content = cap
        ? [
            cap.name,
            cap.description,
            ...cap.triggers.keywords,
            ...cap.tools.map((t) => t.name + ' ' + t.description)
          ].join(' ')
        : capName
      scored.push({
        name: capName,
        score: this.ras.scoreRelevance(message, content),
        tools: capTools
      })
    }

    scored.sort((a, b) => b.score - a.score || a.tools.length - b.tools.length)

    const kept: ToolDefinition[] = [...orphaned]
    const dropped: string[] = []
    let remaining = limit - orphaned.length

    for (const entry of scored) {
      if (remaining <= 0) {
        dropped.push(entry.name)
        continue
      }
      if (entry.tools.length <= remaining) {
        kept.push(...entry.tools)
        remaining -= entry.tools.length
      } else {
        // Partial inclusion: score individual tools and include the most
        // relevant ones that still fit within the budget.
        const toolScored = entry.tools
          .map((t) => ({
            tool: t,
            score: this.ras.scoreRelevance(message, t.name + ' ' + t.description)
          }))
          .sort((a, b) => b.score - a.score)
        const partial = toolScored.slice(0, remaining)
        kept.push(...partial.map((p) => p.tool))
        remaining -= partial.length
        dropped.push(entry.name + '(partial)')
      }
    }

    if (dropped.length > 0) {
      this.corpus.emit('tools.filtered', {
        total: tools.length,
        kept: kept.length,
        dropped
      })
    }

    return kept
  }

  async processAutonomous(opts: AutonomousTurnOptions): Promise<AutonomousTurnResult> {
    await this.init().catch(() => undefined)

    // Pure LLM title of the job's instruction (falls back to a plain trim if
    // the model is unreachable), prefixed with the job label so a scheduled
    // run reads e.g. "Hourly (15): Summarize unread email".
    const summary = await titleFromMessage(opts.instruction, this.thalamus).catch(() => 'Untitled')

    const conv: ConversationFile = {
      ...createConversation(null),
      title: summary === 'Untitled' ? opts.jobLabel : `${opts.jobLabel}: ${summary}`,
      channel: opts.channel ?? 'heartbeat',
      sealed: true,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.icon ? { icon: opts.icon } : {})
    }

    const turnId = `hb_${Date.now().toString(36)}`

    // The prompt, minted ONCE. The conversation shell below, every mid-run
    // progress save and the final persist all write this same message — a
    // re-minted id would union into a second copy of the same prompt (the
    // merge is id-keyed; see mergeConversationOnto).
    const userMsg: ConversationMessage = {
      id: mintMessageId(conv.createdAt),
      role: 'user',
      content: opts.instruction,
      timestamp: conv.createdAt
    }

    // chat:turnState for this run — 'started' when the shell is on disk, a
    // terminal phase after the final save, so the list refetch each broadcast
    // triggers always finds the conversation. Guarded like TurnRunner's emit:
    // a broken listener must never turn into a job failure.
    const emitLifecycle = (
      phase: 'started' | 'done' | 'canceled' | 'error',
      error?: string
    ): void => {
      try {
        this.autonomousLifecycle?.({
          phase,
          turnId,
          conversationId: conv.id,
          channel: conv.channel ?? 'heartbeat',
          title: conv.title,
          ...(error !== undefined ? { error } : {})
        })
      } catch {
        // never let a listener failure surface as a run failure
      }
    }

    // The conversation exists BEFORE the run does — title first, then the
    // shell, then the turn: the same order every other conversation follows.
    // This is what puts an automation in the rail the moment it starts, lets
    // it be opened and watched live, and leaves something resumable behind if
    // the app quits mid-run. Previously the file was written only when the run
    // ENDED, so a run interrupted by a quit vanished without a trace.
    conv.messages = [userMsg]
    await saveConversation(conv).catch(() => undefined)

    // This run's abort handle. An external signal (if the caller passed one)
    // still aborts it; the controller adds the path the in-app Stop button
    // needs, which has no other way to reach a run that never touches the
    // TurnRunner.
    const controller = new AbortController()
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort()
      else opts.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    this.liveAutonomousRuns.set(conv.id, {
      controller,
      channel: conv.channel ?? 'heartbeat',
      title: conv.title
    })
    // Mid-turn messages for this run. Opened at the try below — everything
    // between here and there is straight-line setup with no await in it, so
    // no message can arrive in the gap, and opening inside the try is what
    // pairs it with the finally that closes it. An inbox left open with
    // nothing to drain it would accept the user's words and hold them
    // forever, which is the one outcome this subsystem exists to prevent.
    const interjections = this.autonomousInterjections
    // Why whatever the run never read goes back to its sender. Set on the
    // failure paths; a Stop is read off the controller at close time.
    let sweepReason: InterjectionWithdrawReason = 'turn_ended'
    emitLifecycle('started')

    const segments: import('@main/runtime/broca').Segment[] = []
    // Log entries carry the brainstem job id (matching the pool's
    // RunningJobInfo.id) so the renderer routes them to the right card when
    // several runs are live at once.
    const logId = opts.jobId ?? opts.jobLabel
    let textAccum = ''
    const flushText = (): void => {
      const trimmed = textAccum.trim()
      if (!trimmed) return
      const listener = this.brainstem?.['listener']
      listener?.onJobLog?.({
        id: logId,
        timestamp: Date.now(),
        kind: 'text',
        summary: trimmed.slice(0, 120)
      })
      textAccum = ''
    }

    // Live mirror of the in-progress answer — the same accumulator +
    // stable-id contract the channels use, over the SAME segments array this
    // run persists, so the snapshot a viewer watches grow and the message
    // saved at the end are one message that gets replaced in place, never
    // duplicated.
    const acc: AssistantAccumulator = {
      assistantMessageId: mintMessageId(),
      assistantTimestamp: Date.now(),
      assistantContent: '',
      segments,
      approvals: new Map(),
      toolTimings: new Map(),
      stopReason: null
    }
    let mirrorTimer: NodeJS.Timeout | null = null
    let lastMirrorAt = 0
    let lastPersistAt = Date.now()
    /** In-flight progress save, if any — the final save waits on it. */
    let progressWrite: Promise<void> | null = null
    let finished = false
    const pushMirror = (message: ConversationMessage): void => {
      lastMirrorAt = Date.now()
      try {
        // The prompt rides every tick like it does for a channel turn: a phone
        // that opens this conversation mid-run only ever sees ticks.
        this.autonomousMirror?.(conv.id, message, userMsg)
      } catch {
        // a torn-down window or a dead tunnel must never wedge the run
      }
    }
    /**
     * Mid-run durability: put the answer-so-far ON DISK so quitting (or
     * crashing) mid-run leaves a transcript that can be opened and continued,
     * rather than a conversation holding only its prompt. Fire-and-forget, one
     * at a time, on its own much slower cadence — every save reindexes the
     * file and pushes a list-changed to every surface.
     */
    const persistProgress = (message: ConversationMessage): void => {
      if (progressWrite || finished) return
      lastPersistAt = Date.now()
      progressWrite = saveConversation({
        ...conv,
        messages: [userMsg, message],
        updatedAt: Date.now()
      })
        .catch(() => undefined)
        .finally(() => {
          progressWrite = null
        })
    }
    const emitMirror = (): void => {
      if (finished) return
      const message = buildAssistantMessage(acc)
      if (!message) return
      pushMirror(message)
      if (Date.now() - lastPersistAt >= AUTONOMOUS_PERSIST_THROTTLE_MS) persistProgress(message)
    }
    const scheduleMirror = (immediate: boolean): void => {
      if (finished) return
      const sinceLast = Date.now() - lastMirrorAt
      if (immediate || sinceLast >= AUTONOMOUS_MIRROR_THROTTLE_MS) {
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
      }, AUTONOMOUS_MIRROR_THROTTLE_MS - sinceLast)
      mirrorTimer.unref?.()
    }
    /**
     * Close the run out: stop every pending tick before the final save writes
     * the real message, and drop the live registration so nothing reports this
     * conversation as still running once the terminal broadcast goes out.
     * Idempotent — the `finally` below calls it as a backstop.
     */
    const endRun = (): void => {
      if (finished) return
      finished = true
      if (mirrorTimer) {
        clearTimeout(mirrorTimer)
        mirrorTimer = null
      }
      this.liveAutonomousRuns.delete(conv.id)
      // Closes the inbox and sweeps anything the run never got to back to
      // whoever sent it — the same contract the lane tail gives a chat turn.
      // Guarded by `finished` above so the catch + finally pair cannot sweep
      // twice (the second pass would find an empty inbox, but the reason is
      // only right the first time).
      interjections?.close(conv.id, controller.signal.aborted ? 'canceled' : sweepReason)
    }

    const sink: SegmentSink = (seg) => {
      // Workflow/task snapshots supersede each other — keep only the latest
      // per run/task in the sealed conversation, mirroring every other
      // persist path.
      foldSegment(segments, seg)
      if (seg.kind === 'text') acc.assistantContent += seg.delta
      if (seg.kind === 'turn_end') acc.stopReason = seg.stopReason
      // Task snapshots flush immediately — a card flipping to running/succeeded
      // should not wait out the text throttle. A mid-run message the user sent
      // rides the same exemption for a stronger reason: its `delivered` push
      // has already retired the pending bubble on every surface, so until this
      // snapshot lands their words are on no screen at all.
      scheduleMirror(
        seg.kind === 'task' ||
          seg.kind === 'countdown' ||
          seg.kind === 'wait' ||
          seg.kind === 'process' ||
          seg.kind === 'browser' ||
          seg.kind === 'user_message'
      )
      const listener = this.brainstem?.['listener']
      if (!listener?.onJobLog) return
      if (seg.kind === 'text') {
        textAccum += seg.delta
        return
      }
      // Reasoning ticks are display-only — flushing the text log per tick
      // would shred the job log into fragments.
      if (seg.kind === 'reasoning') return
      flushText()
      if (seg.kind === 'tool_call') {
        listener.onJobLog({
          id: logId,
          timestamp: Date.now(),
          kind: 'tool_call',
          summary: `Tool: ${seg.name}`
        })
      } else if (seg.kind === 'tool_result') {
        const preview = seg.output?.slice(0, 80) ?? (seg.status === 'failed' ? 'error' : 'done')
        listener.onJobLog({
          id: logId,
          timestamp: Date.now(),
          kind: 'tool_result',
          summary: `Result: ${preview}`
        })
      }
    }
    const localBroca = new Broca({ corpus: this.corpus, shouldSilenceToolCall: isInternalToolCall })

    // Accumulate this run's tokenomics into the same persisted `stats` shape
    // the channels and the in-app renderer write, so a heartbeat / procedure
    // conversation shows real context-meter numbers when opened in-app instead
    // of a blank gauge. This run's corpus events are sealed (never relayed), so
    // subscribe directly and filter to THIS turn's id — a concurrent foreground
    // turn's events carry a different id and must not bleed in.
    const statsCollector = new TurnStatsCollector(Date.now())
    const statsEvents: CorpusEvent[] = [
      'context.built',
      'llm.response',
      'turn.usage',
      'tool.called'
    ]
    const statsOffs = statsEvents.map((eventName) =>
      this.corpus.on(eventName, (payload) => {
        if (turnScope.getStore()?.turnId !== turnId) return
        statsCollector.note(eventName, payload)
      })
    )

    // Persist the sealed conversation — shared by the success path and the
    // failure path below. A failed run MUST still land in history: the rail
    // can only mark a conversation red if a conversation exists to mark
    // (previously a thrown run saved nothing and simply vanished from the
    // list, so failures were invisible outside the Heartbeat page).
    const persistRun = async (stopReason: ConversationMessage['stopReason']): Promise<string> => {
      const responseText = segments
        .filter((s): s is Extract<typeof s, { kind: 'text' }> => s.kind === 'text')
        .map((s) => s.delta)
        .join('')
      const now = Date.now()
      if (stopReason) acc.stopReason = stopReason
      // One builder for the mirror and the save — the channel contract — so
      // the message written here carries the id (and timestamp) the viewer is
      // already showing, and replaces the snapshot instead of adding to it.
      // Null means the run died before producing anything: it keeps just the
      // instruction, since an empty assistant bubble would render as noise.
      const assistantMsg = buildAssistantMessage(acc)
      conv.messages = assistantMsg ? [userMsg, assistantMsg] : [userMsg]
      conv.updatedAt = now
      // Persist the context-meter stats so opening this heartbeat / procedure
      // conversation in-app shows real numbers. Skipped when the run never
      // reached the model (nothing consumed → a blank gauge is correct).
      if (statsCollector.hasData()) conv.stats = statsCollector.foldInto(null, now)
      // A progress save still in flight would otherwise land after this one
      // and rewrite the message with a stale snapshot — the merge is
      // incoming-wins on a shared id — so let it finish first.
      if (progressWrite) await progressWrite
      await saveConversation(conv).catch(() => undefined)
      // Final snapshot to whoever is watching: the last throttled tick is up
      // to 500ms stale and predates turn_end, and the disk-tail sync can't
      // repair that (same id, same count). Same final mirror the channels emit
      // at end of turn.
      if (assistantMsg) pushMirror(assistantMsg)
      return responseText
    }

    // Run inside a sealed autonomous turn scope so this background run's
    // corpus events (context/tokens/tools/tasks) are NOT relayed into a live
    // chat that may still be streaming — they'd otherwise corrupt that
    // conversation's meter/timeline and hijack its active task id. The scope
    // still carries the run's identity for daily-log attribution. See
    // turnScope in corpus.ts. publishConversation:false keeps a scheduled run
    // from flipping the app-wide visible-conversation pointer mid-chat.
    let result: AgentTurnResult
    try {
      // From here the conversation takes mid-turn messages, and endRun() in
      // the finally below is what gives back whatever the run never read.
      interjections?.open(conv.id)
      result = await turnScope.run({ turnId, conversationId: conv.id, autonomous: true }, () =>
        this.respond({
          history: [{ role: 'user', content: autonomousRunFraming(opts) + opts.instruction }],
          turnId,
          onSegment: sink,
          signal: controller.signal,
          conversationId: conv.id,
          conversationTitle: conv.title,
          broca: localBroca,
          bypassApproval: true,
          publishConversation: false,
          modeOverride: opts.mode,
          thinkingMode: opts.thinkingMode,
          projectId: opts.projectId ?? null,
          contextFiles: opts.contextFiles ?? null,
          // The same field serves both background sources; the overlay names
          // the one that actually owns these files, which the run's channel
          // already tells us.
          contextFilesOwner: opts.channel === 'procedure' ? 'procedure' : 'automation',
          workingFolders: opts.workingFolders,
          // Mid-turn messages reach an unattended run exactly as they reach a
          // chat turn: the loop drains this at its two stop points and each
          // message becomes a real user entry plus a `user_message` segment.
          ...(interjections
            ? { takeInterjections: (): Interjection[] => interjections.take(conv.id, turnId) }
            : {})
        })
      )
    } catch (err) {
      sweepReason = 'error'
      endRun()
      flushText()
      await persistRun('end_turn')
      emitLifecycle(
        controller.signal.aborted ? 'canceled' : 'error',
        err instanceof Error ? err.message : String(err)
      )
      throw err
    } finally {
      for (const off of statsOffs) off()
      endRun()
    }
    flushText()

    const responseText = await persistRun(
      result.stopReason === 'canceled' ? 'end_turn' : result.stopReason
    )
    emitLifecycle(result.stopReason === 'canceled' ? 'canceled' : 'done')

    return {
      success: result.stopReason === 'end_turn',
      response: responseText,
      toolCalls: result.toolCalls,
      conversationId: conv.id
    }
  }
}

function mapProviderStopReason(s: StopReason): SegmentTurnEndReason {
  switch (s) {
    case 'max_tokens':
      return 'max_tokens'
    case 'tool_use':
      return 'tool_use'
    case 'end_turn':
    case 'stop_sequence':
    case 'unknown':
    default:
      return 'end_turn'
  }
}

// turn_end's union doesn't carry 'canceled' — the user pressing stop
// isn't a model-side reason. Surface it as end_turn so no footer chip
// renders; the renderer already knows the user canceled because the
// chat:error event arrived.

/**
 * Definitive-offline detection for the runtime context — Chromium's network
 * change notifier via Electron, the same signal the thalamus consults before
 * dispatching to a cloud provider. `false` means provably offline; `true`
 * means "possibly online" (the API can't promise reachability), which is why
 * only the offline state is ever rendered to the model. Fail-open: if the
 * probe itself throws, report online rather than falsely alarming the model.
 */
function isHostOnline(): boolean {
  try {
    return net.isOnline()
  } catch {
    return true
  }
}

/**
 * Plan mode's standing instructions, generalised from OpenCode's plan-mode
 * reminder: read-only investigation, one writable plan file, clarify real
 * ambiguities with the user, end with the plan. Task-neutral — a trip, a
 * document, a data cleanup and a refactor all plan the same way.
 */
function renderPlanModeBlock(planFile: string, hasWorkingFolders: boolean): string {
  return [
    '<plan_mode>',
    'Plan mode is ON for this conversation: the user wants a plan, not execution. You may only OBSERVE — read, search, list, fetch, recall — and write the plan itself.',
    `The plan file is ${planFile}: file_write / file_edit on that one path are allowed; every other call that changes state (writes, edits, shell commands that mutate, sends, memory writes) is refused. Build the plan incrementally in that file.`,
    'Workflow: (1) understand the request and the material it touches' +
      (hasWorkingFolders ? ' — search and read the working folder' : '') +
      '; in workflow mode, spawn up to 3 read-only explore agents in parallel (agent_spawn with readOnly=true) for open-ended questions, one focus each; in single mode, search yourself. (2) ask_user about real ambiguities up front — never "is this plan okay?". (3) write the plan: the recommended approach only (not every alternative), the files or resources it touches, the steps in order, and a verification section saying how the result will be checked. (4) BEFORE your final reply, file_write the plan to the plan file — a plan-mode turn that ends without the plan file written is incomplete — then end your reply with the plan itself and tell the user to turn plan mode off to execute it.',
    '</plan_mode>'
  ].join('\n')
}

/** The one-time note on the first executing turn after a plan-mode turn. */
function renderPlanSwitchBlock(planFile: string): string {
  return [
    '<plan_mode_switch>',
    `Plan mode was switched OFF. You may change files, run commands and use every tool again. A plan may exist at ${planFile} — read it and execute it unless the user says otherwise, verifying as you go.`,
    '</plan_mode_switch>'
  ].join('\n')
}

const READ_ONLY_AGENT_BLOCK = [
  '<read_only_agent>',
  'This run is read-only: you are an explore agent. Search, read, list, fetch and recall; every call that would change state is refused. Return your findings — with absolute paths and line numbers — as your final message.',
  '</read_only_agent>'
].join('\n')

/** A file_write / file_edit aimed at the plan file (the one plan-mode exception). */
function isPlanFileCall(call: ToolCall, planFile: string, folders: string[]): boolean {
  if (call.name !== 'file_write' && call.name !== 'file_edit') return false
  const raw = typeof call.args.path === 'string' ? call.args.path : ''
  if (!raw) return false
  const expanded = raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw
  const abs = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(folders[0] ?? path.dirname(planFile), expanded)
  return path.resolve(abs) === path.resolve(planFile)
}

/** File tools whose call is preceded by a snapshot of the target (undo). */
const FILE_MUTATING_TOOLS: ReadonlySet<string> = new Set(['file_edit', 'file_write', 'file_patch'])

/** A file tool's `path` argument resolved the way the filesystem plugin resolves it. */
function resolveToolPath(raw: string, folders: string[], workspaceRoot: string): string {
  if (raw === '~') return os.homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2))
  if (path.isAbsolute(raw)) return raw
  return path.resolve(folders[0] ?? workspaceRoot, raw)
}

/** Tools whose success can change the working folder's git state. */
const MUTATING_FOLDER_TOOLS: ReadonlySet<string> = new Set([
  'file_edit',
  'file_write',
  'file_patch',
  'shell_exec'
])

/** Read-only tool calls a single batch may run concurrently. */
const PARALLEL_READ_LIMIT = 8

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed', 'cancelled'])
const TODO_PRIORITIES = new Set(['high', 'medium', 'low'])

/**
 * The todo_write argument, validated into card items. Null when the shape
 * is not a list — the tool itself already rejected it, so no card.
 */
/**
 * The open-task-list notice: what the user still sees as unfinished on the
 * earlier card, and the one rule for resolving it. Observe-and-notify — the
 * model decides whether this turn is that work.
 */
function openTodoNotice(open: OpenTodoList): string {
  const unfinished = open.items.filter((i) => i.status === 'pending' || i.status === 'in_progress')
  const shown = unfinished
    .slice(0, 6)
    .map((i) => `"${i.content}" (${i.status})`)
    .join(', ')
  const more = unfinished.length > 6 ? ` and ${unfinished.length - 6} more` : ''
  return `<open_task_list>Your task list from an earlier turn is still showing ${unfinished.length} of ${open.items.length} items unfinished on the user's screen: ${shown}${more}. If this turn continues or finishes that work, bring the list up to date with todo_write (mark done items completed, abandoned ones cancelled, the current one in_progress) — your write updates that same card in place. If this turn is unrelated work, leave it, or pass fresh: true to start a separate list.</open_task_list>`
}

function normalizeTodoItems(raw: unknown): TodoItem[] | null {
  if (!Array.isArray(raw)) return null
  const items: TodoItem[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const content = typeof e.content === 'string' ? e.content.trim() : ''
    if (!content) continue
    const status =
      typeof e.status === 'string' && TODO_STATUSES.has(e.status) ? e.status : 'pending'
    const item: TodoItem = { content, status: status as TodoItem['status'] }
    if (typeof e.priority === 'string' && TODO_PRIORITIES.has(e.priority)) {
      item.priority = e.priority as TodoItem['priority']
    }
    items.push(item)
  }
  return items
}

/** Entries listed per working folder in the volatile tail. */
const WORKING_FOLDER_MAX_ENTRIES = 200

/**
 * Fresh shallow listing of the user's working folders, rendered for the
 * outbound volatile tail. Main-side replacement for the renderer-composed
 * <working_folders> block that used to rewrite the previous user message
 * every send (invalidating the provider prompt-cache prefix).
 */
async function renderWorkingFolders(folders: string[]): Promise<string> {
  const rendered: string[] = []
  for (const folder of folders.slice(0, 8)) {
    try {
      const entries = await fs.readdir(folder, { withFileTypes: true })
      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      const shown = entries.slice(0, WORKING_FOLDER_MAX_ENTRIES)
      const lines = shown.map((e) => `    ${e.isDirectory() ? `${e.name}/` : e.name}`)
      const omitted = entries.length - shown.length
      rendered.push(
        `- ${folder}${lines.length === 0 ? ' (empty)' : `\n${lines.join('\n')}`}${omitted > 0 ? `\n    … and ${omitted} more entries omitted` : ''}`
      )
    } catch {
      rendered.push(`- ${folder} (could not read contents)`)
    }
  }
  if (rendered.length === 0) return ''
  return (
    `<working_folders>\nThe user has set the following working directories (top-level contents listed). ` +
    `When the user references files, paths, or project context, assume they are relative to these unless stated otherwise:\n${rendered.join('\n')}\n</working_folders>`
  )
}

function segmentReasonFor(s: SegmentTurnEndReason | 'canceled'): SegmentTurnEndReason {
  return s === 'canceled' ? 'end_turn' : s
}

const ARGS_SUMMARY_LIMIT = 80

function summarizeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args ?? {})
  if (entries.length === 0) return ''
  const parts: string[] = []
  for (const [key, value] of entries) {
    parts.push(`${key}=${stringifyValue(value)}`)
  }
  return clamp(parts.join(' '), ARGS_SUMMARY_LIMIT)
}

function stringifyValue(value: unknown): string {
  if (value == null) return String(value)
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1).trimEnd()}…`
}

async function* captureUsage(
  stream: AsyncGenerator<StreamChunk>,
  onCapture: (provider: ProviderId | null, model: string | null, usage: StreamUsage | null) => void
): AsyncGenerator<StreamChunk> {
  for await (const chunk of stream) {
    if (chunk.type === 'active_model') {
      onCapture(chunk.provider, chunk.model, null)
    } else if (chunk.type === 'turn_meta') {
      // turn_meta names the entry that actually served the call (stamped
      // by thalamus), which can differ from the active_model head when
      // the cascade fell through — pinning must follow the real winner.
      onCapture(chunk.provider ?? null, chunk.model ?? null, chunk.usage ?? null)
    }
    yield chunk
  }
}
