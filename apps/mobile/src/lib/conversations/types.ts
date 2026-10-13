/**
 * Conversation domain types — ported from wolffish-app (the source of truth):
 * Segment from src/main/runtime/broca.ts, ConversationFile/ConversationMessage
 * from src/main/conversations.ts (re-exported via preload). The mobile app
 * consumes the exact on-disk shapes the desktop persists so that synced (or
 * demo-imported) conversations render without translation.
 *
 * Load-bearing rule from analyzing 868 real conversation files: schemas grew
 * over three months (15 top-level key combinations observed), so every field
 * beyond the v1 core is optional and renderers must tolerate unknown segment
 * kinds and tool names.
 */

import type { SyncProcess } from '@/lib/tunnel/protocol'

export type ConversationChannel =
  'electron' | 'telegram' | 'whatsapp' | 'mobile' | 'cli' | 'heartbeat' | 'procedure'

export type SegmentTurnEndReason =
  'end_turn' | 'tool_use' | 'max_tokens' | 'error' | 'no_provider_available'

/** `stopped`: ended on purpose (the user's Stop, or the model's call_stop) — a warning, never a failure. */
export type ToolResultStatus = 'success' | 'failed' | 'denied' | 'checked_in' | 'stopped'

/** A file change as a unified diff — what the edit tools attach to their result. */
export type ToolResultDiff = {
  path: string
  patch: string
  additions: number
  deletions: number
}

/**
 * Presentation-only detail on a tool result (desktop broca.ts ToolResultMeta):
 * the red/green diff of an edit, a shell run's exit code, duration and spill
 * file, the tool's own short label ("Run tests"). Never fed back to the model;
 * the feed renders it the same live and from the stored transcript.
 */
export type ToolResultMeta = {
  diff?: ToolResultDiff
  /** Shell exit code, null when killed. */
  exitCode?: number | null
  durationMs?: number
  /** Absolute path of the full output when it was spilled to disk. */
  outputPath?: string
  truncated?: boolean
  /** The directory a command ran in. */
  cwd?: string
  /** A short human label chosen by the tool (e.g. "Run tests"). */
  label?: string
  /** The call checked in as still running (desktop runtime/check-in.ts): its handle and state. */
  checkIn?: { handle: string; state: 'running' | 'finished' | 'stopped' }
  /** Who ended a `stopped` call: the user's Stop on the turn, or the model's call_stop. */
  stoppedBy?: 'user' | 'model'
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

/**
 * One item of the model's task list (todo_write). The whole list rides every
 * `todo` segment; a turn shows exactly ONE checklist card, at the position of
 * its first write, in its latest state (replace-by-turnId).
 */
export type TodoItem = {
  content: string
  status: TodoStatus
  priority?: 'high' | 'medium' | 'low'
}

/** Legacy parallel-worker tag — render paths must skip worker-tagged segments. */
export type SegmentWorker = { id: string; label?: string }

export type WorkflowAgentView = {
  id: string
  name: string
  task: string
  phase?: string
  provider: string
  model: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: number
  endedAt?: number
  llmCalls: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  resultChars?: number
}

export type WorkflowSnapshot = {
  workflowId: string
  status: 'running' | 'completed' | 'canceled' | 'error'
  startedAt: number
  endedAt?: number
  note?: string
  phases: Array<{ title: string; status: 'pending' | 'active' | 'done' }>
  agents: WorkflowAgentView[]
  totals: {
    agents: number
    toolCalls: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    cost: number
  }
}

export type TaskStatus = 'submitted' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export type CountdownStatus = 'armed' | 'counting' | 'fired' | 'aborted' | 'failed'
export type CountdownAbortReason = 'user' | 'stop' | 'superseded' | 'relaunch'

/**
 * A turn-end countdown — mirrors the desktop's CountdownSnapshot in broca.ts.
 * The card that shows the user an action (a restart, say) will run N seconds
 * after the reply that armed it, with an Abort button. Snapshots REPLACE each
 * other by countdownId; the card derives its bar from fireAt locally.
 */
export type CountdownSnapshot = {
  countdownId: string
  conversationId: string | null
  turnId: string | null
  label: string
  seconds: number
  status: CountdownStatus
  armedAt: number
  fireAt: number | null
  endedAt: number | null
  target: { tool: string; args: Record<string, unknown> }
  result?: string
  error?: string
  abortedBy?: CountdownAbortReason
}

/**
 * A process card — mirrors the desktop's ProcessCardSnapshot
 * (main/processes/types.ts): the managed processes a `process_show` chose to
 * put in the chat, with Stop/Restart. Snapshots REPLACE each other by cardId;
 * `names: null` follows every managed process. The records are the wire's
 * SyncProcess, field for field.
 */
export type ProcessCardSnapshot = {
  cardId: string
  conversationId: string | null
  turnId: string | null
  title: string | null
  names: string[] | null
  processes: SyncProcess[]
  createdAt: number
  updatedAt: number
}

export type WaitStatus = 'waiting' | 'elapsed' | 'interrupted' | 'canceled'

/**
 * A blocking `wait` — mirrors the desktop's WaitSnapshot in broca.ts. The
 * agent asked to be idle for `seconds` (there is no maximum) and this is the
 * card that says why, until when, and offers the box that ends it early.
 * Snapshots REPLACE each other by waitId; the card derives its clock from
 * endsAt locally, so a four-hour wait costs two segments.
 */
/** The desktop in-app browser's card state — src/main/browser/types.ts, mirrored. */
export type BrowserTabSnapshot = {
  tabId: string
  conversationId: string | null
  url: string
  title: string
  loadState: 'idle' | 'loading' | 'ready' | 'error'
  canGoBack: boolean
  canGoForward: boolean
  mode: 'card' | 'expanded'
  frameSize: { width: number; height: number }
  generation: number
  error: { code: string; message: string } | null
  active: boolean
  /** Every tab of the conversation's browser, in strip order. */
  strip: Array<{ url: string; title: string; active: boolean }>
  /** Workspace-relative JPEG of the active page, captured for the phone. */
  still: string | null
}

export type WaitSnapshot = {
  waitId: string
  conversationId: string | null
  reason: string
  seconds: number
  status: WaitStatus
  startedAt: number
  endsAt: number
  endedAt?: number
  /** What the user sent to cut it short. The card's record only. */
  interruptedBy?: string
}

/**
 * Async generation task (MiniMax H3 video today; `kind` leaves room for
 * future generators). Mirrors the desktop's TaskSnapshot in broca.ts —
 * snapshots REPLACE each other by taskId, so one card renders per task.
 */
export type TaskSnapshot = {
  taskId: string
  kind: 'video'
  conversationId: string | null
  title: string
  status: TaskStatus
  detail?: string
  createdAt: number
  updatedAt: number
  endedAt?: number
  /** Wall-clock estimate for the progress bar; the API reports no true %. */
  estimateSeconds: number
  /** Workspace-relative artifact path once downloaded. */
  outputPath?: string
  outputBytes?: number
  error?: string
  video?: {
    model: string
    resolution: string
    durationSeconds: number
    ratio?: string
    inputSummary: string
  }
}

/**
 * One provider failure behind an errored turn — the desktop's
 * NoProviderAvailableInfo, verbatim. Rides the turn_end segment over the wire
 * and is what the provider error card renders from.
 */
export type NoProviderAvailableInfo = {
  provider: string
  providerLogo: string
  statusCode: number | null
  errorReason: string
  errorDetail: string | null
  retriesAttempted: number
  totalDurationMs: number
}

export type Segment =
  | { kind: 'text'; turnId: string; segmentId: string; delta: string; worker?: SegmentWorker }
  /**
   * A run of the model's thinking, streamed in place (desktop broca.ts,
   * 2026-08). Dual-published: the final iteration's thinking ALSO rides
   * `turn_end.reasoningContent` for surfaces that predate this kind — when a
   * message carries any reasoning segments, the turn_end copy is a duplicate
   * of the last one and must not render.
   */
  | { kind: 'reasoning'; turnId: string; segmentId: string; delta: string; worker?: SegmentWorker }
  | {
      kind: 'tool_call'
      turnId: string
      segmentId: string
      toolCallId: string
      name: string
      args: Record<string, unknown>
      worker?: SegmentWorker
    }
  | {
      kind: 'tool_result'
      turnId: string
      segmentId: string
      toolCallId: string
      status: ToolResultStatus
      output: string
      error?: string
      meta?: ToolResultMeta
      worker?: SegmentWorker
    }
  | { kind: 'active_model'; turnId: string; segmentId: string; provider: string; model: string }
  /**
   * A message the user sent MID-TURN, at the exact point the agent read it
   * (desktop agent/interjection.ts). It lives inside the assistant message
   * rather than as a user row of its own because that is where it happened:
   * between one iteration and the next. `messageId` is the id the sending
   * surface minted, which is what retires that surface's pending bubble.
   */
  | {
      kind: 'user_message'
      turnId: string
      segmentId: string
      messageId: string
      text: string
      attachments?: MessageAttachment[]
      voicePrompt?: boolean
      voiceLang?: string
      timestamp: number
    }
  /** The model's task list — one card per turn, replaced in place on every write. */
  | {
      kind: 'todo'
      turnId: string
      segmentId: string
      items: TodoItem[]
      /**
       * The list this write belongs to — the turnId of the turn that created
       * it; absent on the creating write. A later turn that continues an open
       * list writes with the ORIGINAL list id, and the feed draws that card,
       * at its original position, in the latest state (latestTodoLists).
       */
      listId?: string
    }
  | {
      kind: 'turn_end'
      turnId: string
      segmentId: string
      stopReason: SegmentTurnEndReason
      iterationCount: number
      reasoningContent?: string
      providerErrors?: NoProviderAvailableInfo[]
    }
  | { kind: 'separator'; turnId: string; segmentId: string }
  | { kind: 'workflow'; turnId: string; segmentId: string; snapshot: WorkflowSnapshot }
  | { kind: 'task'; turnId: string; segmentId: string; snapshot: TaskSnapshot }
  | { kind: 'countdown'; turnId: string; segmentId: string; snapshot: CountdownSnapshot }
  | { kind: 'wait'; turnId: string; segmentId: string; snapshot: WaitSnapshot }
  | { kind: 'process'; turnId: string; segmentId: string; snapshot: ProcessCardSnapshot }
  | { kind: 'browser'; turnId: string; segmentId: string; snapshot: BrowserTabSnapshot }
  | {
      kind: 'compaction_started'
      turnId: string
      segmentId: string
      messagesCount: number
      targetsCount: number
      tokenCount: number
      tokenBudget: number
      startedAt: number
    }
  | {
      kind: 'compaction'
      turnId: string
      segmentId: string
      targetsCount: number
      tokensSaved: number
      durationMs: number
      details: Array<{
        toolName?: string
        originalChars: number
        compactedChars: number
        compactedBy: string
      }>
    }

export type MessageAttachmentType = 'audio' | 'video' | 'image' | 'pdf' | 'other'

export type MessageAttachment = {
  type: MessageAttachmentType
  /** Workspace-relative, e.g. "uploads/conv-…/photo.png" — resolved via the file cache. */
  filePath: string
  originalName: string
  mimeType: string
  sizeBytes: number
  width?: number
  height?: number
  durationSeconds?: number
}

export type ToolTiming = { startedAt: number; endedAt?: number }

/**
 * Approval + ask-the-user shapes, verbatim from the desktop's preload types.
 * The desktop flags a dangerous tool call and parks the turn until the user
 * decides; `ask_user` parks it until they answer. Both render as cards here,
 * live over the tunnel and — for approvals, which persist — replayed from the
 * stored transcript afterwards.
 */
export type DangerLevel = 'safe' | 'warn' | 'confirm' | 'destructive' | 'block'
export type ApprovalDecision = 'approved' | 'denied'
export type RiskLevel = 'low' | 'medium' | 'high'

export type ApprovalDescription = {
  title: string
  description: string
  command?: string
  impact?: string
  risk: RiskLevel
}

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

/** The user's response to a whole card — `answers[i]` answers `questions[i]`. */
export type AskUserResponse = { kind: 'answered'; answers: AskUserAnswer[] } | { kind: 'canceled' }

export type ConversationMessage = {
  id?: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  segments?: Segment[]
  approvals?: Record<string, PersistedApproval>
  toolTimings?: Record<string, ToolTiming>
  stopReason?: SegmentTurnEndReason
  error?: string
  attachments?: MessageAttachment[]
  voicePrompt?: boolean
  voiceLang?: string
}

export type ConversationTurnStats = {
  endedAt?: number
  elapsedMs?: number
  apiMs?: number
  apiCalls?: number
  toolCalls?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  cost?: number
  provider?: string
  model?: string
}

export type ConversationStats = {
  allTime?: ConversationTurnStats & { processingMs?: number; turns?: number }
  lastTurn?: ConversationTurnStats
  meter?: {
    contextTokens: number
    contextBudget: number
    compactionAt?: number
    model?: string
  } | null
}

/** The persisted conversation shape (desktop conv-<id>.json). */
export type ConversationFile = {
  id: string
  title: string
  model: string | null
  messages: ConversationMessage[]
  createdAt: number
  updatedAt: number
  channel?: ConversationChannel
  projectId?: string
  icon?: string
  sealed?: boolean
  stats?: ConversationStats | null
  summary?: string | null
}

/** Listing row — mirrors the desktop's ConversationMeta. */
export type ConversationMeta = {
  id: string
  title: string
  updatedAt: number
  createdAt: number
  channel?: ConversationChannel
  projectId?: string
  icon?: string
  messageCount: number
}

/** Message ids follow the desktop mint format — the merge-reconciliation key. */
export function mintMessageId(now: number = Date.now()): string {
  const hex = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0')
  return `m_${now}_${hex}`
}

/** Conversation ids mirror the desktop generator: local timestamp + guard. */
export function mintConversationId(now: Date = new Date()): string {
  const pad = (n: number, w = 2): string => n.toString().padStart(w, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  const hex = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0')
  return `${stamp}_${pad(now.getMilliseconds(), 3)}-${hex}`
}
