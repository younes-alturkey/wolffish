import type { Corpus } from '@main/runtime/corpus'
import type { NoProviderAvailableInfo, StreamChunk } from '@main/runtime/thalamus'
import type { BrowserTabSnapshot } from '@main/browser/types'
import type { ProcessCardSnapshot } from '@main/processes/types'

/**
 * Broca produces the final, user-facing response.
 *
 * Maps to: Broca's area — a region in the left frontal lobe that handles
 * speech production. Patients with Broca's aphasia understand language
 * fine, but struggle to produce it: they know what they want to say, but
 * the words come out halting and broken. Production is Broca's job.
 *
 * In Wolffish, Broca tees the unified stream coming from Thalamus into
 * an ordered series of `Segment`s — text deltas, tool calls, tool
 * results, and a final turn_end marker. The segment stream is what the
 * renderer consumes; the underlying chunk stream still passes through
 * to Wernicke for parsing. Broca writes no prose itself: every visible
 * artifact comes from the model or from a tool's own output.
 */

export type SegmentTurnEndReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'error'
  | 'no_provider_available'
  | 'closed'

/**
 * `checked_in`: the call is STILL RUNNING — it passed its check-in delay and
 * the model got a progress report instead of a result (runtime/check-in.ts).
 * The card stays open on that status until a second tool_result for the same
 * toolCallId replaces it in place (upsertToolResultSegment) with the final
 * outcome, or forever if the call outlives its turn.
 *
 * `stopped`: the call was ended on purpose, not by its own failure — the
 * user pressed Stop on the turn, or the model called call_stop on a parked
 * call. `meta.stoppedBy` says which. Replays into the model's history as an
 * error (the call did not complete) but renders as a warning, never a failure.
 */
export type ToolResultStatus = 'success' | 'failed' | 'denied' | 'checked_in' | 'stopped'

/**
 * LEGACY (removed Orchestrator mode, ≤1.0.204): segments persisted by old
 * conversations may carry this tag, set on subagent output that was forwarded
 * into the orchestrator turn's stream. Workflow mode no longer forwards
 * subagent segments — the workflow card is the subagent surface — but every
 * render/replay path must keep SKIPPING worker-tagged segments or old
 * conversations replay subagent prose as the assistant's own.
 */
export type SegmentWorker = { id: string; label: string }

export type WorkflowPhaseStatus = 'pending' | 'active' | 'done'

export type WorkflowAgentView = {
  id: string
  name: string
  /** Truncated task snippet for display — the full prompt lives in logs. */
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

/**
 * The deterministic state of one workflow-mode run, built by WorkflowSession
 * from the harness's own observations (spawn lifecycle, LLM usage callbacks,
 * tool-call counts, wall-clock) — never from model claims. Carried whole on
 * every `workflow` segment: each snapshot REPLACES the previous one for the
 * same workflowId (see upsertWorkflowSegment), so exactly one card persists
 * per run and live/reload render identically.
 */
export type WorkflowSnapshot = {
  workflowId: string
  status: 'running' | 'completed' | 'canceled' | 'error'
  startedAt: number
  endedAt?: number
  /** Optional master-declared plan note (via workflow_plan). */
  note?: string
  phases: Array<{ title: string; status: WorkflowPhaseStatus }>
  agents: WorkflowAgentView[]
  /** Agents-only sums (one row per agent above). */
  totals: {
    agents: number
    toolCalls: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    cost: number
  }
  /**
   * The master turn's OWN LLM usage, fed per-call from the agent loop so the
   * card can show the true whole-turn cost — agents-only totals under-report
   * the run (the first real run hid ~4.6% of spend). Optional: snapshots
   * persisted before this field shipped lack it.
   */
  master?: {
    llmCalls: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    cost: number
  }
}

export type TaskStatus = 'submitted' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/**
 * Lifecycle of a turn-end countdown (see runtime/countdown.ts). `armed`
 * while the arming turn is still running; `counting` from the moment that
 * turn ended until the deadline; then exactly one of `fired` (the target
 * ran), `failed` (it ran and reported an error) or `aborted` (the user, a
 * Stop on the arming turn, a newer countdown, or an app relaunch stopped it).
 */
export type CountdownStatus = 'armed' | 'counting' | 'fired' | 'aborted' | 'failed'

export type CountdownAbortReason = 'user' | 'stop' | 'superseded' | 'relaunch'

/**
 * Full state of a turn-end countdown — the payload of the `countdown`
 * segment. Everything the card shows comes from here; the model narrates
 * nothing. The card derives its bar from fireAt/seconds locally, so main
 * pushes only state transitions, never ticks.
 */
export type CountdownSnapshot = {
  countdownId: string
  conversationId: string | null
  /** The turn that armed it — the one whose end starts the clock. */
  turnId: string | null
  /** What happens when it fires, in the user's words ("Restart this Mac"). */
  label: string
  /** Grace period between the arming turn's end and the fire. */
  seconds: number
  status: CountdownStatus
  armedAt: number
  /** Set when the clock starts (status `counting`); the deadline. */
  fireAt: number | null
  /** Set on every terminal status. */
  endedAt: number | null
  /** The tool call that fires — shown so the user knows exactly what runs. */
  target: { tool: string; args: Record<string, unknown> }
  /** The fired tool's first output line, when it returned one. */
  result?: string
  /** Why it failed (status `failed`). */
  error?: string
  /** Who or what stopped it (status `aborted`). */
  abortedBy?: CountdownAbortReason
}

/**
 * A file change a tool made, as a unified diff. Produced by the filesystem
 * tools (file_edit / file_write) and carried on the tool_result segment's
 * `meta` so the feed can render red/green hunks and a +N −M chip — live and
 * on reload alike, since the segment persists whole.
 */
export type ToolResultDiff = {
  file: string
  /** Standard unified diff text (`--- a/…`, `+++ b/…`, `@@` hunks). */
  patch: string
  additions: number
  deletions: number
  kind: 'edit' | 'create' | 'overwrite'
}

/**
 * Structured facts about a tool result, for the UI only. Display-only in
 * the strict sense: both model-context rebuild paths ignore `meta` — the
 * model sees `output`, the user sees what `meta` renders. Optional on every
 * result; readers that predate it (mobile, CLI) ignore the field.
 */
export type ToolResultMeta = {
  diff?: ToolResultDiff
  /** Shell exit code, null when killed. */
  exitCode?: number | null
  durationMs?: number
  /** Absolute path of the full output when it was spilled to disk. */
  outputPath?: string
  /**
   * There was more than the result shows — a capped result set, a cut log.
   * DISPLAY ONLY, and deliberately loose: each tool means it its own way
   * (the shell means "the log was cut", `file_grep` means "more matches than
   * the limit"). Never read this to decide whether the text still needs
   * bounding for the model — that is `outputBounded`.
   */
  truncated?: boolean
  /**
   * The tool ALREADY applied the model-context cap to `output` (2000 lines /
   * 50 KB) and spilled the rest itself, so the motor must pass the text
   * through untouched rather than head-bounding a tail-biased log a second
   * time. Only a tool that really did the work sets this.
   */
  outputBounded?: boolean
  /** The directory a command ran in. */
  cwd?: string
  /** A short human label chosen by the tool (e.g. "Run tests"). */
  label?: string
  /**
   * The call checked in as still running (runtime/check-in.ts): its handle
   * and where it stands. `running` on the check-in result itself and on a
   * call_wait that timed out again; `finished` / `stopped` on the in-place
   * update and on the call_wait that delivered the final result.
   */
  checkIn?: { handle: string; state: 'running' | 'finished' | 'stopped' }
  /** Who ended a `stopped` call: the user's Stop on the turn, or the model's call_stop. */
  stoppedBy?: 'user' | 'model'
}

/**
 * The tools whose call changes the user's project — an edit, a write, a shell
 * run. Every clean feed (the in-app chat, the phone's live mirror) shows
 * these as a compact activity row even with verbose off; every other tool
 * call stays mechanics. One list, so the surfaces cannot drift.
 */
export const CODE_ACTIVITY_TOOLS: ReadonlySet<string> = new Set([
  'file_edit',
  'file_write',
  'file_patch',
  'shell_exec'
])

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

/**
 * One item of the model's task list (todo_write). The whole list rides every
 * `todo` segment; consumers upsert by turnId so a turn shows exactly ONE
 * checklist card, at the position of its first write, in its latest state.
 */
export type TodoItem = {
  content: string
  status: TodoStatus
  priority?: 'high' | 'medium' | 'low'
}

/**
 * The deterministic state of one async generation task (MiniMax H3 video
 * today; `kind` leaves room for future generators to reuse the same card).
 * Built by VideoTaskManager from its own observations — submit time, poll
 * transitions, download results — never from model claims. Carried whole on
 * every `task` segment: each snapshot REPLACES the previous one for the
 * same taskId (see upsertTaskSegment), so exactly one card persists per
 * task and live/reload render identically.
 */
export type TaskSnapshot = {
  taskId: string
  kind: 'video'
  conversationId: string | null
  /** Short human label for the card header (model-provided or derived). */
  title: string
  status: TaskStatus
  /** One-line current detail: last transition, error summary, or artifact note. */
  detail?: string
  createdAt: number
  updatedAt: number
  endedAt?: number
  /**
   * Wall-clock estimate for the progress bar, measured from live runs. The
   * card clamps at 95% until a terminal state arrives — the API reports no
   * true progress.
   */
  estimateSeconds: number
  /** Workspace-relative artifact path once downloaded. */
  outputPath?: string
  outputBytes?: number
  error?: string
  /** Kind-specific display facts. */
  video?: {
    model: string
    resolution: string
    durationSeconds: number
    ratio?: string
    /** e.g. "text + first frame + 2 reference images". */
    inputSummary: string
  }
}

/** How a `wait` ended — or that it hasn't. */
export type WaitStatus = 'waiting' | 'elapsed' | 'interrupted' | 'canceled'

/**
 * The deterministic state of one `wait` call (utilities). The tool BLOCKS for
 * as long as the model asked for — there is no ceiling — so this snapshot is
 * what the user sees meanwhile: why the agent is idle, when it means to wake,
 * and an input that ends the wait early by sending a message into the running
 * turn.
 *
 * Carried whole on every `wait` segment; each snapshot REPLACES the previous
 * one for the same waitId (see upsertWaitSegment), so exactly one card
 * persists per wait and live/reloaded conversations render identically. Two
 * snapshots are emitted per wait — `waiting` at the start, one terminal state
 * at the end — and the start one rides the checkpoint's structural flush, so
 * a wait that outlives the app still left its card on disk.
 */
export type WaitSnapshot = {
  waitId: string
  /** Where the card lives — the WaitCard needs it to interject. */
  conversationId: string | null
  /** The model's own words for why it is waiting. Shown as the card's title. */
  reason: string
  /** What the model asked for, in seconds. Uncapped by design. */
  seconds: number
  status: WaitStatus
  startedAt: number
  /** startedAt + seconds, the card's deadline. Fixed at start. */
  endsAt: number
  endedAt?: number
  /**
   * What the user sent to cut the wait short, when they did. The text itself
   * reaches the model as an ordinary mid-turn message (the interjection path
   * owns it) — this copy is for the card's record only.
   */
  interruptedBy?: string
}

/**
 * The master's workflow-management tools. Their tool_call/tool_result
 * segments persist and replay into model context like any tool (the master's
 * memory of agent reports lives in agents_await results), but NO render
 * surface shows them as chips — the workflow card and the channels' phase
 * messages are their user-facing surface.
 */
export const WORKFLOW_TOOL_NAMES: ReadonlySet<string> = new Set([
  'workflow_plan',
  'agent_spawn',
  'agent_send',
  'agents_await',
  'agent_cancel'
])

/**
 * Replace-by-id upsert for workflow snapshot segments: the latest snapshot
 * for a workflowId supersedes any earlier one in an accumulated segment
 * array. Shared by every surface that accumulates segments (renderer
 * messages, channel ActiveTurn.segments, autonomous-run sinks) so persisted
 * conversations hold exactly ONE card per workflow run.
 */
export function upsertWorkflowSegment(
  segments: Segment[],
  segment: Extract<Segment, { kind: 'workflow' }>
): void {
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i]
    if (s.kind === 'workflow' && s.snapshot.workflowId === segment.snapshot.workflowId) {
      segments[i] = segment
      return
    }
  }
  segments.push(segment)
}

/**
 * Replace-by-id upsert for async-task snapshot segments — same contract as
 * upsertWorkflowSegment, keyed by snapshot.taskId. Shared by every surface
 * that accumulates segments so persisted conversations hold exactly ONE
 * card per generation task.
 */
export function upsertTaskSegment(
  segments: Segment[],
  segment: Extract<Segment, { kind: 'task' }>
): void {
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i]
    if (s.kind === 'task' && s.snapshot.taskId === segment.snapshot.taskId) {
      segments[i] = segment
      return
    }
  }
  segments.push(segment)
}

/**
 * Replace-by-id upsert for countdown snapshot segments — the task contract,
 * keyed by snapshot.countdownId. One card per countdown on every surface.
 */
export function upsertCountdownSegment(
  segments: Segment[],
  segment: Extract<Segment, { kind: 'countdown' }>
): void {
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i]
    if (s.kind === 'countdown' && s.snapshot.countdownId === segment.snapshot.countdownId) {
      segments[i] = segment
      return
    }
  }
  segments.push(segment)
}

/**
 * Replace-by-toolCallId upsert for tool results. A call that checked in as
 * still running gets a SECOND tool_result when it finally lands (the
 * in-place card update); every persist path folds it onto the first so a
 * conversation never carries two results for one call — which the history
 * rebuild would replay as two tool messages for one tool_use.
 */
export function upsertToolResultSegment(
  segments: Segment[],
  segment: Extract<Segment, { kind: 'tool_result' }>
): void {
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i]
    if (s.kind === 'tool_result' && s.toolCallId === segment.toolCallId) {
      segments[i] = segment
      return
    }
  }
  segments.push(segment)
}

/**
 * Replace-by-id upsert for wait snapshot segments — the task contract, keyed
 * by snapshot.waitId. One card per wait on every surface, so the terminal
 * snapshot resolves the waiting card in place instead of stacking a second.
 */
export function upsertWaitSegment(
  segments: Segment[],
  segment: Extract<Segment, { kind: 'wait' }>
): void {
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i]
    if (s.kind === 'wait' && s.snapshot.waitId === segment.snapshot.waitId) {
      segments[i] = segment
      return
    }
  }
  segments.push(segment)
}

/**
 * Replace-by-id upsert for in-app browser page cards — the task contract,
 * keyed by snapshot.tabId. One card per page on every surface, so a
 * navigation or a load-state change updates the card in place.
 */
/**
 * What a browser card stands for: the CONVERSATION's browser, not one tab.
 * One card per conversation, updated in place as its tabs come and go; a
 * tab with no conversation (never in practice) keys on itself.
 */
export function browserKey(snapshot: Pick<BrowserTabSnapshot, 'conversationId' | 'tabId'>): string {
  return snapshot.conversationId ?? snapshot.tabId
}

export function upsertProcessSegment(
  segments: Segment[],
  segment: Extract<Segment, { kind: 'process' }>
): void {
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i]
    if (s.kind === 'process' && s.snapshot.cardId === segment.snapshot.cardId) {
      segments[i] = segment
      return
    }
  }
  segments.push(segment)
}

export function upsertBrowserSegment(
  segments: Segment[],
  segment: Extract<Segment, { kind: 'browser' }>
): void {
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i]
    if (s.kind === 'browser' && browserKey(s.snapshot) === browserKey(segment.snapshot)) {
      segments[i] = segment
      return
    }
  }
  segments.push(segment)
}

/**
 * Replace-by-turnId upsert for the todo checklist — one card per turn, in
 * its latest state, at the position of the first write. Same contract as
 * the snapshot upserts above; shared by every surface that accumulates
 * segments so live and reloaded conversations render identically.
 */
/** The list a todo segment belongs to — its own turn unless it continues an earlier one. */
export function todoListId(segment: Extract<Segment, { kind: 'todo' }>): string {
  return segment.listId ?? segment.turnId
}

/**
 * Every task list in a conversation in its LATEST state, keyed by list id,
 * walking the messages' segments in order (a later write replaces an
 * earlier one). Renderers draw each list once, on the card of the turn that
 * created it, with these items — so a continuation write in a later turn
 * resolves the earlier card in place.
 */
export function latestTodoLists(
  segmentLists: Array<ReadonlyArray<Segment> | undefined>
): Map<string, TodoItem[]> {
  const out = new Map<string, TodoItem[]>()
  for (const segments of segmentLists) {
    if (!segments) continue
    for (const segment of segments) {
      if (segment.kind === 'todo') out.set(todoListId(segment), segment.items)
    }
  }
  return out
}

export type OpenTodoList = { listId: string; items: TodoItem[] }

/**
 * The conversation's most recently written task list when it still has
 * unfinished items (pending or in_progress) — the list a turn inherits,
 * so the model can carry it on and mark it done. Null when the latest list
 * is settled or there is none.
 */
export function openTodoList(
  segmentLists: Array<ReadonlyArray<Segment> | undefined>
): OpenTodoList | null {
  let latest: OpenTodoList | null = null
  for (const segments of segmentLists) {
    if (!segments) continue
    for (const segment of segments) {
      if (segment.kind === 'todo') latest = { listId: todoListId(segment), items: segment.items }
    }
  }
  if (!latest) return null
  const open = latest.items.some((i) => i.status === 'pending' || i.status === 'in_progress')
  return open ? latest : null
}

export function upsertTodoSegment(
  segments: Segment[],
  segment: Extract<Segment, { kind: 'todo' }>
): void {
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i]
    if (s.kind === 'todo' && s.turnId === segment.turnId) {
      segments[i] = segment
      return
    }
  }
  segments.push(segment)
}

/**
 * Append a text or reasoning segment, folding it into the previous one when
 * both are adjacent parts of the same run — same kind, same author (worker
 * or main line, same worker id) with nothing between them. Shared by every
 * surface that accumulates segments, exactly like the snapshot upserts above.
 *
 * Without this, a streamed reply persisted one segment PER MODEL TICK — a
 * few characters each. One heartbeat automation's reply landed as 2,441
 * text segments (~250 KB of segment envelope wrapped around a 10 KB
 * answer), and every later reader — this app's own renderer, the wire to
 * the phone, the phone's store — paid O(ticks) forever after. Folded here,
 * a prose run is ONE segment; boundaries stay boundaries, and the first
 * tick's segmentId keeps naming the run so nothing keyed on it moves.
 * Reasoning streams tick-by-tick exactly like text, so it folds under the
 * same rule — kinds never fold into each other.
 */
export function appendTextSegment(
  segments: Segment[],
  segment: Extract<Segment, { kind: 'text' | 'reasoning' }>
): void {
  const last = segments[segments.length - 1]
  if (
    last &&
    (last.kind === 'text' || last.kind === 'reasoning') &&
    last.kind === segment.kind &&
    last.turnId === segment.turnId &&
    Boolean(last.worker) === Boolean(segment.worker) &&
    last.worker?.id === segment.worker?.id
  ) {
    segments[segments.length - 1] = { ...last, delta: last.delta + segment.delta }
    return
  }
  segments.push(segment)
}

/**
 * Fold one streamed segment into an accumulated message: snapshot kinds
 * upsert by their key, prose folds per run, everything else appends. The ONE
 * fold every accumulator calls. It used to be a hand-copied if-chain in eight
 * places, and the copies drifted: the automation/heartbeat accumulator never
 * learned `todo`, so a heartbeat run that rewrote its task list 138 times
 * saved 138 checklist cards, and WhatsApp never learned `browser`.
 */
export function foldSegment(segments: Segment[], segment: Segment): void {
  switch (segment.kind) {
    case 'workflow':
      return upsertWorkflowSegment(segments, segment)
    case 'task':
      return upsertTaskSegment(segments, segment)
    case 'countdown':
      return upsertCountdownSegment(segments, segment)
    case 'wait':
      return upsertWaitSegment(segments, segment)
    case 'process':
      return upsertProcessSegment(segments, segment)
    case 'browser':
      return upsertBrowserSegment(segments, segment)
    case 'tool_result':
      return upsertToolResultSegment(segments, segment)
    case 'todo':
      return upsertTodoSegment(segments, segment)
    case 'text':
    case 'reasoning':
      return appendTextSegment(segments, segment)
    default:
      segments.push(segment)
  }
}

export type Segment =
  | { kind: 'text'; turnId: string; segmentId: string; delta: string; worker?: SegmentWorker }
  | {
      /**
       * A user message delivered to the model MID-TURN — sent while the run
       * was working and read at the agent's next stop point (see
       * agent/interjection.ts). NOT display-only: both model-context rebuild
       * paths (channel.ts assistantSegmentsToHistory, the renderer's
       * textHistory) flush the iteration so far and emit a `role: 'user'`
       * entry here, so the next turn's history carries it at its true
       * position. Every renderer draws it as a user bubble inline in the
       * assistant's card. `messageId` is the sender's own id — the surface
       * retires its optimistic pending bubble when this arrives.
       */
      kind: 'user_message'
      turnId: string
      segmentId: string
      messageId: string
      text: string
      attachments?: import('@main/conversations').MessageAttachment[]
      voicePrompt?: boolean
      voiceLang?: string
      timestamp: number
    }
  | {
      /**
       * A run of the model's thinking, streamed in place — one delta per
       * provider tick, folded per run by appendTextSegment exactly like text,
       * so the whole turn's reasoning renders at its true position (before
       * the prose/tool calls it produced), not just the final iteration's.
       * Display-only: both model-context rebuild paths ignore it.
       *
       * Dual-published on purpose: the final iteration's thinking still rides
       * `turn_end.reasoningContent` (unchanged) so surfaces that predate this
       * kind — the mobile app, the CLI renderer — keep their turn-end
       * reasoning card. The in-app renderer prefers these in-place segments
       * and skips the turn_end copy whenever a message contains any.
       */
      kind: 'reasoning'
      turnId: string
      segmentId: string
      delta: string
      worker?: SegmentWorker
    }
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
      /** UI-only structured facts (diff, exit code, duration). See ToolResultMeta. */
      meta?: ToolResultMeta
      worker?: SegmentWorker
    }
  | {
      /**
       * The model's task list after a todo_write call (see TodoItem).
       * Replace-by-turnId semantics — NOT append — on every surface, so a
       * turn carries one checklist card in its latest state. Display-only:
       * both model-context rebuild paths ignore it (the model keeps the list
       * through the todo_write tool result it already has).
       */
      kind: 'todo'
      turnId: string
      segmentId: string
      items: TodoItem[]
      /**
       * The list this write belongs to — the turnId of the turn that created
       * it. Absent (or equal to turnId) on the creating write. A later turn
       * that continues an open list writes with the ORIGINAL list id, and
       * every renderer draws that card, at its original position, in the
       * latest state (latestTodoLists) — the model "goes back" and marks
       * the earlier card done rather than growing a second checklist.
       */
      listId?: string
    }
  | {
      kind: 'active_model'
      turnId: string
      segmentId: string
      provider: string
      model: string
    }
  | {
      kind: 'turn_end'
      turnId: string
      segmentId: string
      stopReason: SegmentTurnEndReason
      iterationCount: number
      providerErrors?: NoProviderAvailableInfo[]
      reasoningContent?: string
    }
  | { kind: 'separator'; turnId: string; segmentId: string }
  | {
      /**
       * Full-state snapshot of a workflow-mode run (see WorkflowSnapshot).
       * Replace-by-workflowId semantics — NOT append — on every surface.
       * Display-only: both model-context rebuild paths ignore it.
       */
      kind: 'workflow'
      turnId: string
      segmentId: string
      snapshot: WorkflowSnapshot
    }
  | {
      /**
       * Full-state snapshot of an async generation task (see TaskSnapshot).
       * Replace-by-taskId semantics — NOT append — on every surface.
       * Display-only: both model-context rebuild paths ignore it.
       */
      kind: 'task'
      turnId: string
      segmentId: string
      snapshot: TaskSnapshot
    }
  | {
      /**
       * Full-state snapshot of a turn-end countdown (see CountdownSnapshot).
       * Replace-by-countdownId semantics on every surface. Display-only:
       * both model-context rebuild paths ignore it.
       */
      kind: 'countdown'
      turnId: string
      segmentId: string
      snapshot: CountdownSnapshot
    }
  | {
      /**
       * Full-state snapshot of a blocking `wait` (see WaitSnapshot).
       * Replace-by-waitId semantics on every surface. Display-only: both
       * model-context rebuild paths ignore it — the tool_result carries
       * what the model needs to know about how the wait ended.
       */
      kind: 'wait'
      turnId: string
      segmentId: string
      snapshot: WaitSnapshot
    }
  | {
      /**
       * A page open in Wolffish's own browser (see BrowserTabSnapshot): the
       * live card in the chat. Replace-by-tabId semantics on every surface —
       * one card per page, in its latest state, at the position the page was
       * opened. Display-only: both model-context rebuild paths ignore it; the
       * tool results carry what the model needs.
       */
      kind: 'browser'
      turnId: string
      segmentId: string
      snapshot: BrowserTabSnapshot
    }
  | {
      /**
       * A live process card (see ProcessCardSnapshot): the processes the
       * model chose to show, with Stop/Restart controls. Replace-by-cardId
       * semantics on every surface; after the opening turn ends the same
       * snapshots ride the process:cardChanged broadcast. Display-only: both
       * model-context rebuild paths ignore it.
       */
      kind: 'process'
      turnId: string
      segmentId: string
      snapshot: ProcessCardSnapshot
    }
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
      /** Number of tool results that were compacted. */
      targetsCount: number
      /** Total tokens reclaimed by compaction. */
      tokensSaved: number
      /** How long the compaction took in milliseconds. */
      durationMs: number
      /** Per-target details for the card. */
      details: Array<{
        toolName?: string
        originalChars: number
        compactedChars: number
        /** Model name that performed the compaction (or 'truncate'). */
        compactedBy: string
      }>
    }

export type SegmentSink = (segment: Segment) => void

export type BrocaOptions = {
  corpus?: Corpus
  /**
   * Predicate consulted when a tool_call chunk arrives. Returning true
   * marks that tool call as silent: broca skips both its tool_call and
   * its eventual tool_result segments, so the renderer shows nothing
   * for the call. Used for wolffish-internal housekeeping (memory
   * writes, episode logs) that the user never asked about.
   */
  shouldSilenceToolCall?: (name: string, args: Record<string, unknown>) => boolean
}

export class Broca {
  private turnId: string | null = null
  private sink: SegmentSink | null = null
  private counter = 0
  private turnEnded = false
  private silentToolCallIds = new Set<string>()
  /**
   * Tool calls whose tool_call segment has been emitted but whose
   * tool_result segment has not. Drained by emitToolResult. Anything still
   * here when the turn ends (a run stopped mid-tool) is closed by
   * closeOpenToolCalls so the persisted segment stream never carries a
   * tool_call without a matching result.
   */
  private openToolCallIds = new Set<string>()

  constructor(private options: BrocaOptions = {}) {
    void this.options
  }

  /**
   * True if the given toolCallId was marked silent when its tool_call
   * chunk arrived. Callers that bypass broca (the agent's approval
   * loop) check this before requesting approval or treating the call
   * as user-visible.
   */
  isSilent(toolCallId: string): boolean {
    return this.silentToolCallIds.has(toolCallId)
  }

  /**
   * Open a per-turn segment channel. The agent calls this once per
   * user message, before any LLM stream begins. Resets the segment
   * counter so segmentIds are monotonic per turn.
   */
  beginTurn(turnId: string, sink: SegmentSink): void {
    this.turnId = turnId
    this.sink = sink
    this.counter = 0
    this.turnEnded = false
    this.silentToolCallIds.clear()
    this.openToolCallIds.clear()
  }

  /**
   * Close the per-turn channel. Called from the agent's finally block
   * so a thrown error doesn't leave the channel half-open.
   */
  endTurn(): void {
    this.turnId = null
    this.sink = null
    this.counter = 0
    this.turnEnded = false
    this.silentToolCallIds.clear()
    this.openToolCallIds.clear()
  }

  /**
   * Tee an upstream chunk stream: emit a Segment for every text and
   * tool_call chunk while passing every chunk through to whoever is
   * downstream (typically Wernicke). turn_meta and error chunks aren't
   * surfaced as segments — turn_meta is internal metadata, and errors
   * are surfaced via the agent's turn_end with stopReason='error'.
   */
  async *streamSegments(chunks: AsyncGenerator<StreamChunk>): AsyncGenerator<StreamChunk> {
    for await (const chunk of chunks) {
      if (chunk.type === 'text' && chunk.text.length > 0) {
        this.emit({
          kind: 'text',
          turnId: this.requireTurn(),
          segmentId: this.nextId(),
          delta: chunk.text
        })
      } else if (chunk.type === 'reasoning' && chunk.text.length > 0) {
        this.emit({
          kind: 'reasoning',
          turnId: this.requireTurn(),
          segmentId: this.nextId(),
          delta: chunk.text
        })
      } else if (chunk.type === 'tool_call') {
        if (this.options.shouldSilenceToolCall?.(chunk.name, chunk.args)) {
          this.silentToolCallIds.add(chunk.id)
        } else {
          this.emit({
            kind: 'tool_call',
            turnId: this.requireTurn(),
            segmentId: this.nextId(),
            toolCallId: chunk.id,
            name: chunk.name,
            args: chunk.args
          })
          this.openToolCallIds.add(chunk.id)
        }
      } else if (chunk.type === 'active_model') {
        this.emit({
          kind: 'active_model',
          turnId: this.requireTurn(),
          segmentId: this.nextId(),
          provider: chunk.provider,
          model: chunk.model
        })
      }
      yield chunk
    }
  }

  /**
   * Emit a synthetic tool_call segment for the active turn. Used by the
   * dependency resolver to surface install actions that aren't part of
   * the LLM's stream — without this segment, the renderer has nowhere
   * to anchor the approval card and it never appears, even though the
   * IPC fired.
   */
  emitToolCall(
    turnId: string,
    toolCallId: string,
    name: string,
    args: Record<string, unknown>
  ): void {
    if (this.turnId !== turnId || !this.sink) return
    if (this.options.shouldSilenceToolCall?.(name, args)) {
      this.silentToolCallIds.add(toolCallId)
      return
    }
    this.emit({
      kind: 'tool_call',
      turnId,
      segmentId: this.nextId(),
      toolCallId,
      name,
      args
    })
    this.openToolCallIds.add(toolCallId)
  }

  /**
   * Emit a tool_result segment for the active turn. Status mirrors the
   * motor/safety outcome: 'success' or 'failed' from execution, 'denied'
   * for amygdala-blocked or user-denied calls.
   */
  emitToolResult(
    turnId: string,
    toolCallId: string,
    status: ToolResultStatus,
    output: string,
    error?: string,
    meta?: ToolResultMeta
  ): void {
    if (this.turnId !== turnId || !this.sink) return
    if (this.silentToolCallIds.has(toolCallId)) {
      this.silentToolCallIds.delete(toolCallId)
      return
    }
    this.openToolCallIds.delete(toolCallId)
    const segment: Segment = {
      kind: 'tool_result',
      turnId,
      segmentId: this.nextId(),
      toolCallId,
      status,
      output
    }
    if (error !== undefined) segment.error = error
    if (meta !== undefined) segment.meta = meta
    this.emit(segment)
  }

  /**
   * Re-emit a tool_result for a call that already has one: the in-place
   * update of a checked-in card once the parked call lands. Bypasses the
   * open-call bookkeeping (the call was closed by its check-in result) and
   * relies on upsertToolResultSegment on every consumer to fold it.
   */
  emitToolResultUpdate(
    turnId: string,
    toolCallId: string,
    status: ToolResultStatus,
    output: string,
    error?: string,
    meta?: ToolResultMeta
  ): boolean {
    if (this.turnId !== turnId || !this.sink) return false
    const segment: Segment = {
      kind: 'tool_result',
      turnId,
      segmentId: this.nextId(),
      toolCallId,
      status,
      output
    }
    if (error !== undefined) segment.error = error
    if (meta !== undefined) segment.meta = meta
    this.emit(segment)
    return true
  }

  /**
   * Emit the model's task list after a todo_write call. The Agent is the
   * only caller. Consumers upsert by turnId — see upsertTodoSegment.
   */
  emitTodo(turnId: string, items: TodoItem[], listId?: string): void {
    if (this.turnId !== turnId || !this.sink) return
    this.emit({
      kind: 'todo',
      turnId,
      segmentId: this.nextId(),
      items,
      ...(listId && listId !== turnId ? { listId } : {})
    })
  }

  /**
   * Emit a user message the agent just delivered into the running turn
   * (an interjection). The Agent is the only caller, and it calls this at
   * the moment the message is pushed into the model's messages — so the
   * segment lands strictly after the tool results it follows and before the
   * next iteration's active_model marker, which is what the rebuild rule in
   * both history paths relies on.
   */
  emitUserMessage(
    turnId: string,
    item: {
      messageId: string
      text: string
      attachments?: import('@main/conversations').MessageAttachment[]
      voicePrompt?: boolean
      voiceLang?: string
    }
  ): boolean {
    // Reported rather than swallowed: this segment is the ONLY record of a
    // message the user has already been told was delivered, so a silent no-op
    // here is the message vanishing from the transcript while the model
    // answers it. The caller logs it, and the durable park keeps the message
    // until a transcript actually holds it (channels/interjection-store.ts).
    if (this.turnId !== turnId || !this.sink) return false
    this.emit({
      kind: 'user_message',
      turnId,
      segmentId: this.nextId(),
      messageId: item.messageId,
      text: item.text,
      ...(item.attachments && item.attachments.length > 0 ? { attachments: item.attachments } : {}),
      ...(item.voicePrompt ? { voicePrompt: true } : {}),
      ...(item.voiceLang ? { voiceLang: item.voiceLang } : {}),
      timestamp: Date.now()
    })
    return true
  }

  /**
   * Emit a synthetic tool_result for every tool_call this turn announced
   * but never resolved — the case where the user stops a run while a tool
   * is still in flight. Without it the persisted segment stream holds a
   * tool_call with no matching result, and the next request rebuilt from
   * those segments (renderer textHistory / channel assistantSegmentsToHistory)
   * sends an assistant tool_calls message with no tool results, which every
   * cloud provider rejects ("tool_calls must be followed by tool messages").
   *
   * Call immediately before emitTurnEnd. A no-op when nothing is open (the
   * normal end-of-turn case), so it is safe to call unconditionally.
   * Returns the ids that were closed.
   */
  closeOpenToolCalls(
    turnId: string,
    status: ToolResultStatus,
    output: string,
    meta?: ToolResultMeta
  ): string[] {
    if (this.turnId !== turnId || !this.sink) return []
    if (this.openToolCallIds.size === 0) return []
    const closed: string[] = []
    for (const toolCallId of this.openToolCallIds) {
      const segment: Segment = {
        kind: 'tool_result',
        turnId,
        segmentId: this.nextId(),
        toolCallId,
        status,
        output
      }
      if (meta !== undefined) segment.meta = meta
      this.emit(segment)
      closed.push(toolCallId)
    }
    this.openToolCallIds.clear()
    return closed
  }

  /**
   * Emit a text segment directly into the active turn. Used by _to_chat
   * tools so plugins can inject content into the chat stream without
   * relying on the model to copy tool output verbatim.
   */
  emitText(turnId: string, text: string): void {
    if (this.turnId !== turnId || !this.sink) return
    if (text.trim().length === 0) return
    this.emit({
      kind: 'text',
      turnId,
      segmentId: this.nextId(),
      delta: text
    })
  }

  /**
   * Emit a separator segment that tells the renderer to flush the current
   * text buffer into its own bubble before continuing. Used by _to_chat
   * tools that return multiple items (e.g. several GIFs) so each renders
   * in its own message block rather than a single concatenated bubble.
   */
  emitSeparator(turnId: string): void {
    if (this.turnId !== turnId || !this.sink) return
    this.emit({ kind: 'separator', turnId, segmentId: this.nextId() })
  }

  /**
   * Emit a workflow snapshot into the active turn. The WorkflowSession is
   * the only caller; it throttles token-only updates itself. Consumers
   * upsert by snapshot.workflowId — see upsertWorkflowSegment.
   */
  emitWorkflow(turnId: string, snapshot: WorkflowSnapshot): void {
    if (this.turnId !== turnId || !this.sink) return
    this.emit({ kind: 'workflow', turnId, segmentId: this.nextId(), snapshot })
  }

  /**
   * Emit an async-task snapshot into the active turn. VideoTaskManager is
   * the only caller, via the turn emitter Agent registers for live turns.
   * Consumers upsert by snapshot.taskId — see upsertTaskSegment.
   */
  emitTask(turnId: string, snapshot: TaskSnapshot): void {
    if (this.turnId !== turnId || !this.sink) return
    this.emit({ kind: 'task', turnId, segmentId: this.nextId(), snapshot })
  }

  /**
   * Emit a countdown snapshot into the active turn — the arming turn's card,
   * via the turn emitter Agent registers for live turns. Post-turn
   * transitions (counting, fired, aborted) never reach a broca; they ride
   * the countdown:changed broadcast and the conversation-file write-through.
   */
  emitCountdown(turnId: string, snapshot: CountdownSnapshot): void {
    if (this.turnId !== turnId || !this.sink) return
    this.emit({ kind: 'countdown', turnId, segmentId: this.nextId(), snapshot })
  }

  /**
   * Emit an in-app browser page snapshot into the active turn — the card of
   * a page opened by this turn. Consumers upsert by snapshot.tabId; after the
   * turn ends the same snapshots ride the browser:changed broadcast.
   */
  emitBrowser(turnId: string, snapshot: BrowserTabSnapshot): void {
    if (this.turnId !== turnId || !this.sink) return
    this.emit({ kind: 'browser', turnId, segmentId: this.nextId(), snapshot })
  }

  /**
   * Emit a wait snapshot into the active turn — the `waiting` card and its
   * terminal state, both from inside the blocking tool call (WaitManager,
   * via the turn emitter Agent registers). Consumers upsert by
   * snapshot.waitId — see upsertWaitSegment.
   */
  emitWait(turnId: string, snapshot: WaitSnapshot): void {
    if (this.turnId !== turnId || !this.sink) return
    this.emit({ kind: 'wait', turnId, segmentId: this.nextId(), snapshot })
  }

  /**
   * Emit a process-card snapshot into the active turn — the card a
   * process_show opened in this turn. Consumers upsert by snapshot.cardId;
   * after the turn ends the same snapshots ride process:cardChanged.
   */
  emitProcess(turnId: string, snapshot: ProcessCardSnapshot): void {
    if (this.turnId !== turnId || !this.sink) return
    this.emit({ kind: 'process', turnId, segmentId: this.nextId(), snapshot })
  }

  emitCompactionStarted(
    turnId: string,
    messagesCount: number,
    targetsCount: number,
    tokenCount: number,
    tokenBudget: number
  ): void {
    if (this.turnId !== turnId || !this.sink) return
    this.emit({
      kind: 'compaction_started',
      turnId,
      segmentId: this.nextId(),
      messagesCount,
      targetsCount,
      tokenCount,
      tokenBudget,
      startedAt: Date.now()
    })
  }

  /**
   * Emit a compaction card so the renderer can show the user that context
   * was intelligently summarized before this LLM call.
   */
  emitCompaction(
    turnId: string,
    targetsCount: number,
    tokensSaved: number,
    durationMs: number,
    details: Array<{
      toolName?: string
      originalChars: number
      compactedChars: number
      compactedBy: string
    }>
  ): void {
    if (this.turnId !== turnId || !this.sink) return
    this.emit({
      kind: 'compaction',
      turnId,
      segmentId: this.nextId(),
      targetsCount,
      tokensSaved,
      durationMs,
      details
    })
  }

  /**
   * Emit the turn_end segment that closes the turn from the renderer's
   * perspective. Called from every loop exit path in the agent so the
   * renderer always sees a closing marker. Idempotent — a second call
   * within the same turn is dropped, so an error path that triggers
   * this from both the catch handler and the finally block doesn't
   * double-render.
   */
  emitTurnEnd(
    turnId: string,
    stopReason: SegmentTurnEndReason,
    iterationCount: number,
    providerErrors?: NoProviderAvailableInfo[],
    reasoningContent?: string
  ): void {
    if (this.turnId !== turnId || !this.sink) return
    if (this.turnEnded) return
    this.turnEnded = true
    const segment: Segment = {
      kind: 'turn_end',
      turnId,
      segmentId: this.nextId(),
      stopReason,
      iterationCount
    }
    if (providerErrors?.length) segment.providerErrors = providerErrors
    if (reasoningContent) segment.reasoningContent = reasoningContent
    this.emit(segment)
  }

  private requireTurn(): string {
    if (!this.turnId) throw new Error('Broca.streamSegments called outside a turn')
    return this.turnId
  }

  private nextId(): string {
    this.counter += 1
    return `seg_${this.counter}`
  }

  private emit(segment: Segment): void {
    try {
      this.sink?.(segment)
    } catch {
      // a renderer that's gone away shouldn't tear down the agent
    }
  }
}
