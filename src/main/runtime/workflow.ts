import type { WorkflowAgentView, WorkflowPhaseStatus, WorkflowSnapshot } from '@main/runtime/broca'
import type { ChatMessage, ProviderId } from '@main/runtime/thalamus'
import type { NoProgressSignal } from '@main/runtime/agent/no-progress-guard'
import { calculateCost } from '@main/runtime/usage'

/**
 * Workflow mode — the model-led multi-agent registry and event-driven driver.
 *
 * One `WorkflowSession` belongs to one master turn. It is the SINGLE SOURCE OF
 * TRUTH for that turn's subagents: every agent is born here (via the master's
 * workflow tools), lives here with a status, and dies only here
 * (cancel/finalize). No orphans — `finalize()` aborts every survivor.
 *
 * The session is also the deterministic truth behind the chat's workflow card:
 * every material state change (plan, spawn, status, landing) produces a
 * `WorkflowSnapshot` through `onSnapshot`, built from the harness's own
 * observations (LLM usage callbacks, tool-call counts, wall-clock) — never
 * from model claims. Token-only updates are throttled so a chatty agent
 * doesn't flood the segment stream.
 *
 * Execution is event-driven: `spawn`/`sendTo` are non-blocking (the agent
 * runs in the background), and `awaitNext` returns the moment the NEXT agent
 * lands — never an await-all. The master model decides whose completion gates
 * the next move.
 */

export type WorkflowAgentStatus = WorkflowAgentView['status']

/** Reasoning effort the master picks for an agent (the canonical scale). */
export type WorkflowEffort = 'off' | 'on' | 'high' | 'max'

/** An explicit per-agent model choice; null ⇒ the master's own model. */
export type WorkflowModelChoice = { provider: ProviderId; model: string }

export type WorkflowAgentResult = {
  /** The agent's final assistant text — for the master's eyes only. */
  text: string
  stopReason: string
  failed: boolean
}

/**
 * What awaitNext hands back. Either an agent LANDED (finished — its result is
 * ready) or a still-running agent tripped a NO-PROGRESS escalation (it's stuck
 * re-issuing the same call; the master is woken to decide cancel/steer/wait).
 * Landings always take priority over no-progress notices.
 */
export type WorkflowWaitOutcome =
  | { kind: 'landed'; id: string; name: string; result: WorkflowAgentResult }
  | { kind: 'no_progress'; id: string; name: string; signal: NoProgressSignal }

export type AgentUsageDelta = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

/**
 * Runs one subagent turn to completion and returns its result. Injected by
 * the Agent (which owns `respond`, Broca, model resolution) so this module
 * stays free of the Agent's heavy dependencies. The two callbacks are how the
 * harness feeds deterministic per-agent stats back into the session.
 */
export type RunAgentTurn = (args: {
  agentId: string
  name: string
  history: ChatMessage[]
  signal: AbortSignal
  model: WorkflowModelChoice | null
  effort?: WorkflowEffort
  /** Refuse every mutating tool call for this agent's run (explore agent). */
  readOnly?: boolean
  onToolCall: () => void
  onLlmCall: (provider: ProviderId, model: string, usage: AgentUsageDelta) => void
  /**
   * Fired (bounded — once per worsening band, not every iteration) when this
   * agent has been re-issuing the same tool call to no effect. The session
   * records it and wakes any master parked in awaitNext so it can manage the
   * spinning agent. Never enforced here — the master decides.
   */
  onNoProgress: (signal: NoProgressSignal) => void
}) => Promise<WorkflowAgentResult>

export type SpawnAgentArgs = {
  task: string
  name?: string
  model?: WorkflowModelChoice | null
  effort?: WorkflowEffort
  phase?: string
  /**
   * Read-only explore agent: every mutating tool call is refused for its
   * whole run, so it can be pointed at a codebase or a folder to answer
   * questions without any risk of changing it. Same gate as plan mode.
   */
  readOnly?: boolean
}

/** How many agents may execute at the same time; excess spawns queue. */
export const MAX_RUNNING_AGENTS = 6
/** Hard per-turn total — the runaway backstop, not a target. */
export const MAX_TOTAL_AGENTS = 30

/** Minimum gap between snapshots that only changed token counters. */
const USAGE_SNAPSHOT_THROTTLE_MS = 1500

/** Task text stored on the card — the full prompt stays in the agent's history. */
const TASK_SNIPPET_CHARS = 280

type AgentRecord = {
  id: string
  name: string
  task: string
  phase?: string
  provider: ProviderId
  model: string
  status: WorkflowAgentStatus
  abort: AbortController
  history: ChatMessage[]
  result: WorkflowAgentResult | null
  effort?: WorkflowEffort
  readOnly?: boolean
  modelChoice: WorkflowModelChoice | null
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
  /** Latest no-progress escalation from the agent's loop (for the master's notice). */
  noProgress?: NoProgressSignal | null
}

export class WorkflowSession {
  private agents = new Map<string, AgentRecord>()
  private seq = 0
  private phases: string[] = []
  private note: string | undefined
  // Ids that have landed (completed/failed) and not yet been consumed by
  // awaitNext. A Set (not an array) so a re-driven or re-landed agent can
  // never sit in the queue twice and be reported as a phantom second
  // completion. Insertion order is preserved, so awaitNext still returns the
  // earliest unconsumed landing.
  private landed = new Set<string>()
  // Running agents that tripped a no-progress escalation and haven't been
  // surfaced to the master yet. Consumed by awaitNext AFTER landings (a
  // finished agent is more actionable than a stuck one). Cleared the moment the
  // agent lands, is re-driven, or is cancelled — the notice must never outlive
  // the condition that raised it.
  private noProgressPending = new Set<string>()
  // Resolvers parked in awaitNext, woken when an agent lands, escalates, or on
  // finalize.
  private waiters: Array<() => void> = []
  // Spawned-but-not-started agents waiting for a running slot.
  private pending: string[] = []
  private disposed = false
  private status: WorkflowSnapshot['status'] = 'running'
  private readonly startedAt = Date.now()
  private endedAt: number | undefined
  private usageTimer: ReturnType<typeof setTimeout> | null = null
  private lastEmitAt = 0
  private master: NonNullable<WorkflowSnapshot['master']> = {
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0
  }

  constructor(
    private readonly workflowId: string,
    private readonly runAgentTurn: RunAgentTurn,
    /** Resolves the master's own provider+model (the default agent model). */
    private readonly defaultModel: () => WorkflowModelChoice | null,
    /** Receives every snapshot — the Agent routes it into the turn's Broca. */
    private readonly onSnapshot: (snapshot: WorkflowSnapshot) => void
  ) {}

  private nextId(): string {
    this.seq += 1
    return `a${this.seq}`
  }

  private runningCount(): number {
    let n = 0
    for (const rec of this.agents.values()) if (rec.status === 'running') n += 1
    return n
  }

  private agentView(rec: AgentRecord): WorkflowAgentView {
    return {
      id: rec.id,
      name: rec.name,
      task: rec.task,
      phase: rec.phase,
      provider: rec.provider,
      model: rec.model,
      status: rec.status,
      startedAt: rec.startedAt,
      endedAt: rec.endedAt,
      llmCalls: rec.llmCalls,
      toolCalls: rec.toolCalls,
      inputTokens: rec.inputTokens,
      outputTokens: rec.outputTokens,
      cacheReadTokens: rec.cacheReadTokens,
      cacheWriteTokens: rec.cacheWriteTokens,
      cost: rec.cost,
      resultChars: rec.resultChars
    }
  }

  /**
   * Phase status is DERIVED, never model-claimed: a phase is `active` while
   * any assigned agent is queued/running, `done` once it has agents and all
   * of them are terminal, `pending` otherwise. Once the run COMPLETES, every
   * remaining `pending` phase resolves to `done` — a phase the master worked
   * itself (synthesis, delivery) has no agents, and leaving it grey reads as
   * "never ran" on a successful card.
   */
  private phaseStatus(title: string): WorkflowPhaseStatus {
    let landed = 0
    let live = 0
    for (const rec of this.agents.values()) {
      if (rec.phase !== title) continue
      if (rec.status === 'running' || rec.status === 'queued') live += 1
      else if (rec.status === 'completed' || rec.status === 'failed') landed += 1
    }
    if (live > 0) return 'active'
    // `done` needs at least one agent that actually landed — a phase whose
    // agents were ALL force-cancelled by a stop must not green on the
    // canceled card. On a COMPLETED run every remaining phase greens too:
    // the master worked it itself (synthesis, delivery).
    if (landed > 0) return 'done'
    return this.status === 'completed' ? 'done' : 'pending'
  }

  snapshot(): WorkflowSnapshot {
    const agents = [...this.agents.values()].map((r) => this.agentView(r))
    const totals = agents.reduce(
      (acc, a) => {
        acc.toolCalls += a.toolCalls
        acc.inputTokens += a.inputTokens
        acc.outputTokens += a.outputTokens
        acc.cacheReadTokens += a.cacheReadTokens
        acc.cacheWriteTokens += a.cacheWriteTokens
        acc.cost += a.cost
        return acc
      },
      {
        agents: agents.length,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0
      }
    )
    return {
      workflowId: this.workflowId,
      status: this.status,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      note: this.note,
      phases: this.phases.map((title) => ({ title, status: this.phaseStatus(title) })),
      agents,
      totals,
      master: { ...this.master }
    }
  }

  /** Emit a snapshot now for structural changes (spawn/status/plan/landing). */
  private emit(): void {
    if (this.usageTimer) {
      clearTimeout(this.usageTimer)
      this.usageTimer = null
    }
    this.lastEmitAt = Date.now()
    this.onSnapshot(this.snapshot())
  }

  /** Throttled emit for token-counter-only changes. */
  private emitUsage(): void {
    if (this.disposed || this.usageTimer) return
    const since = Date.now() - this.lastEmitAt
    if (since >= USAGE_SNAPSHOT_THROTTLE_MS) {
      this.emit()
      return
    }
    this.usageTimer = setTimeout(() => {
      this.usageTimer = null
      if (!this.disposed) this.emit()
    }, USAGE_SNAPSHOT_THROTTLE_MS - since)
  }

  private wake(id: string): void {
    this.landed.add(id)
    this.waiters.shift()?.()
  }

  /**
   * A running agent tripped a no-progress escalation — record it and wake a
   * parked master so it can decide. Ignored once the workflow is disposed or if
   * the agent is no longer running (a landing that raced the escalation wins).
   */
  private wakeNoProgress(id: string, signal: NoProgressSignal): void {
    if (this.disposed) return
    const rec = this.agents.get(id)
    if (!rec || rec.status !== 'running') return
    rec.noProgress = signal
    this.noProgressPending.add(id)
    this.waiters.shift()?.()
  }

  /**
   * The MASTER turn's own LLM usage, fed per-call from the agent loop. Kept
   * separate from the per-agent rows so the card can show both the agents'
   * spend and the true whole-turn number.
   */
  recordMasterUsage(provider: ProviderId, model: string, usage: AgentUsageDelta): void {
    if (this.disposed) return
    this.master.llmCalls += 1
    this.master.inputTokens += usage.inputTokens
    this.master.outputTokens += usage.outputTokens
    this.master.cacheReadTokens += usage.cacheReadTokens
    this.master.cacheWriteTokens += usage.cacheCreationTokens
    this.master.cost += calculateCost(
      provider,
      model,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheCreationTokens,
      usage.cacheReadTokens
    )
    // Only worth re-drawing when the card is already live (the master's very
    // first calls precede any plan/spawn — no card exists yet to update).
    if (this.hasActivity()) this.emitUsage()
  }

  /** Declare (or revise) the intended phases — recorded for the card. */
  plan(phases: string[], note?: string): void {
    if (this.disposed) return
    this.phases = phases.map((p) => p.trim()).filter((p) => p.length > 0)
    if (note !== undefined) this.note = note.trim() || undefined
    this.emit()
  }

  // Run (or re-run) an agent's current history in the background; on
  // completion mark it landed and wake any awaiter. A turn that throws is
  // captured as a failed result the master can react to — it never kills
  // the run.
  private drive(rec: AgentRecord): void {
    rec.status = 'running'
    rec.startedAt = Date.now()
    rec.endedAt = undefined
    this.emit()
    void this.runAgentTurn({
      agentId: rec.id,
      name: rec.name,
      history: rec.history,
      signal: rec.abort.signal,
      model: rec.modelChoice,
      effort: rec.effort,
      readOnly: rec.readOnly,
      onToolCall: () => {
        rec.toolCalls += 1
        this.emitUsage()
      },
      onLlmCall: (provider, model, usage) => {
        rec.llmCalls += 1
        rec.inputTokens += usage.inputTokens
        rec.outputTokens += usage.outputTokens
        rec.cacheReadTokens += usage.cacheReadTokens
        rec.cacheWriteTokens += usage.cacheCreationTokens
        rec.cost += calculateCost(
          provider,
          model,
          usage.inputTokens,
          usage.outputTokens,
          usage.cacheCreationTokens,
          usage.cacheReadTokens
        )
        this.emitUsage()
      },
      onNoProgress: (signal) => this.wakeNoProgress(rec.id, signal)
    })
      .then(
        (result) => result,
        (err): WorkflowAgentResult => ({
          text: `Agent failed: ${err instanceof Error ? err.message : String(err)}`,
          stopReason: 'error',
          failed: true
        })
      )
      .then((result) => {
        // Only an agent still in the 'running' state THIS drive() set may
        // land. If it was retired mid-flight — cancel() or finalize() — the
        // late completion must not resurrect it or re-enter the landed queue.
        if (rec.status !== 'running' || this.disposed) return
        rec.result = result
        rec.endedAt = Date.now()
        rec.resultChars = result.text.length
        // Append the reply so a follow-up continues the same thread.
        rec.history.push({ role: 'assistant', content: result.text })
        rec.status = result.failed ? 'failed' : 'completed'
        // The landing supersedes any stuck-notice — the agent is done, not stuck.
        this.noProgressPending.delete(rec.id)
        rec.noProgress = null
        this.wake(rec.id)
        this.emit()
        this.drainPending()
      })
  }

  private drainPending(): void {
    while (this.pending.length > 0 && this.runningCount() < MAX_RUNNING_AGENTS) {
      const id = this.pending.shift()
      const rec = id ? this.agents.get(id) : undefined
      if (rec && rec.status === 'queued') this.drive(rec)
    }
  }

  /** Spawn a live agent with an initial task. Non-blocking — returns its id. */
  spawn(args: SpawnAgentArgs): string {
    if (this.disposed) throw new Error('workflow session is closed')
    if (this.agents.size >= MAX_TOTAL_AGENTS) {
      throw new Error(
        `agent cap reached (${MAX_TOTAL_AGENTS} per turn) — collect or cancel existing agents instead of spawning more`
      )
    }
    const id = this.nextId()
    const choice = args.model ?? null
    const resolved = choice ?? this.defaultModel()
    const rec: AgentRecord = {
      id,
      name: args.name?.trim() || `agent ${id}`,
      task:
        args.task.length > TASK_SNIPPET_CHARS
          ? `${args.task.slice(0, TASK_SNIPPET_CHARS - 1)}…`
          : args.task,
      phase: args.phase?.trim() || undefined,
      provider: resolved?.provider ?? 'local',
      model: resolved?.model ?? 'local',
      status: 'queued',
      abort: new AbortController(),
      history: [{ role: 'user', content: args.task }],
      result: null,
      effort: args.effort,
      readOnly: args.readOnly === true,
      modelChoice: choice,
      startedAt: Date.now(),
      llmCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0
    }
    this.agents.set(id, rec)
    if (this.runningCount() < MAX_RUNNING_AGENTS) {
      this.drive(rec)
    } else {
      this.pending.push(id)
      this.emit()
    }
    return id
  }

  /** Send a follow-up to a landed agent. Non-blocking. An `effort` here
   * re-tunes the agent's reasoning for this and subsequent runs. */
  sendTo(id: string, message: string, effort?: WorkflowEffort): void {
    // Same closed-session contract as spawn: an agent_send racing the user's
    // Stop must fail loudly, not launch an unabortable post-dispose turn.
    if (this.disposed) throw new Error('workflow session is closed')
    const rec = this.require(id)
    if (rec.status === 'running' || rec.status === 'queued') {
      throw new Error(`agent ${id} is still ${rec.status} — await it first, or cancel and respawn`)
    }
    if (rec.status === 'cancelled') throw new Error(`agent ${id} was cancelled`)
    // Drop any unconsumed prior landing — it's about to be superseded by a
    // fresh run, and must not surface as a stale completion of the new task.
    this.landed.delete(id)
    // Likewise drop a stale no-progress notice: the re-driven turn gets a fresh
    // tracker, so any earlier stuck-signal no longer describes it.
    this.noProgressPending.delete(id)
    rec.noProgress = null
    if (effort !== undefined) rec.effort = effort
    rec.history.push({ role: 'user', content: message })
    rec.result = null
    if (this.runningCount() < MAX_RUNNING_AGENTS) {
      this.drive(rec)
    } else {
      rec.status = 'queued'
      this.pending.push(id)
      this.emit()
    }
  }

  /**
   * Block until the NEXT agent (optionally restricted to `ids`) either LANDS or
   * trips a no-progress escalation, and return that outcome. Returns null when
   * no matching agent is still running or queued (nothing left to wait for).
   * Event-driven: resolves on the first landing/escalation, leaving others for
   * later calls. Landings are served BEFORE no-progress notices — a finished
   * agent is more actionable than a stuck one.
   */
  async awaitNext(ids?: string[]): Promise<WorkflowWaitOutcome | null> {
    const want = ids && ids.length ? new Set(ids) : null
    for (;;) {
      let pick: string | undefined
      for (const id of this.landed) {
        if (!want || want.has(id)) {
          pick = id
          break
        }
      }
      if (pick !== undefined) {
        this.landed.delete(pick)
        const rec = this.agents.get(pick)
        if (rec?.result) return { kind: 'landed', id: pick, name: rec.name, result: rec.result }
        continue
      }
      // No landing waiting — surface a no-progress notice if one is pending.
      let stuck: string | undefined
      for (const id of this.noProgressPending) {
        if (!want || want.has(id)) {
          stuck = id
          break
        }
      }
      if (stuck !== undefined) {
        this.noProgressPending.delete(stuck)
        const rec = this.agents.get(stuck)
        // Only surface it if the agent is genuinely still running with a signal —
        // a landing/cancel that raced this consume clears both, so re-loop.
        if (rec && rec.status === 'running' && rec.noProgress) {
          return { kind: 'no_progress', id: stuck, name: rec.name, signal: rec.noProgress }
        }
        continue
      }
      if (this.disposed) return null
      const anyLive = [...this.agents.values()].some(
        (r) => (!want || want.has(r.id)) && (r.status === 'running' || r.status === 'queued')
      )
      if (!anyLive) return null
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
  }

  /** Cancel an agent, aborting its in-flight tool calls immediately. */
  cancel(id: string): void {
    if (this.disposed) return
    const rec = this.require(id)
    rec.abort.abort()
    this.landed.delete(id)
    this.noProgressPending.delete(id)
    rec.noProgress = null
    const idx = this.pending.indexOf(id)
    if (idx >= 0) this.pending.splice(idx, 1)
    rec.status = 'cancelled'
    rec.endedAt = Date.now()
    this.emit()
    this.drainPending()
  }

  list(): WorkflowAgentView[] {
    return [...this.agents.values()].map((r) => this.agentView(r))
  }

  /** True once the master has planned or spawned anything — i.e. the card exists. */
  hasActivity(): boolean {
    return this.agents.size > 0 || this.phases.length > 0
  }

  /**
   * Terminal teardown — abort every survivor, mark the workflow's final
   * status, emit the closing snapshot (MUST run before the turn's Broca is
   * ended, or the card is stuck on 'running' forever), and wake awaiters.
   * No orphans.
   */
  finalize(status: 'completed' | 'canceled' | 'error'): void {
    if (this.disposed) return
    this.disposed = true
    if (this.usageTimer) {
      clearTimeout(this.usageTimer)
      this.usageTimer = null
    }
    this.landed.clear()
    this.noProgressPending.clear()
    this.pending = []
    for (const rec of this.agents.values()) {
      if (rec.status === 'running' || rec.status === 'queued') {
        rec.abort.abort()
        rec.status = 'cancelled'
        rec.endedAt = Date.now()
      }
    }
    this.status = status
    this.endedAt = Date.now()
    if (this.hasActivity()) this.onSnapshot(this.snapshot())
    const ws = this.waiters.splice(0)
    for (const w of ws) w()
  }

  /** Abort-path teardown (turn signal fired) — like finalize('canceled'). */
  dispose(): void {
    this.finalize('canceled')
  }

  private require(id: string): AgentRecord {
    const rec = this.agents.get(id)
    if (!rec) throw new Error(`unknown agent "${id}"`)
    return rec
  }
}
