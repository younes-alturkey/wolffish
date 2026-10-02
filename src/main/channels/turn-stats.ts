import type { ConversationStats, ConversationTurnStats } from '@main/conversations'
import type { CorpusEvent, CorpusEvents } from '@main/runtime/corpus'

/**
 * Main-process twin of the renderer's per-turn tokenomics accumulator
 * (`turnStatsRef` + `finalizeTurn` in Chat.tsx). The in-app chat builds the
 * context-meter `stats` in the renderer and persists it itself; every other
 * channel runs its turn in the main process, so nothing ever wrote `stats` for
 * WhatsApp / Telegram / heartbeat / procedure conversations — their meter card
 * came up blank on reopen. This collector closes that gap by folding the same
 * corpus events the renderer routes on (`context.built`, `llm.response`,
 * `turn.usage`, `tool.called`) into the persisted `ConversationStats` shape.
 *
 * Wiring: create one per turn (channels: per ActiveTurn; heartbeat: per
 * processAutonomous run), feed it every relayed turn event via {@link note},
 * then {@link foldInto} the conversation's existing stats at end-of-turn and
 * write the result back to disk.
 *
 * Parity is deliberate and load-bearing — the routing rules (brain vs worker
 * vs summary/title, meter = last brain call's prompt tokens, side-spend still
 * counting toward all-time) match Chat.tsx line-for-line so an in-app and a
 * channel conversation read the same numbers. Keep the two in sync.
 */

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

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Side-spend bucket (workflow workers / summarization + titling side-calls). */
type Side = {
  turns: number
  calls: number
  cost: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

function emptySide(): Side {
  return {
    turns: 0,
    calls: 0,
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0
  }
}

export class TurnStatsCollector {
  private readonly startedAt: number

  // Brain-only accumulators (mirror renderer `turnStatsRef`).
  private inputTokens = 0
  private outputTokens = 0
  private cacheReadTokens = 0
  private cacheCreationTokens = 0
  /** Last brain call's prompt composition — the meter numerator (absolute). */
  private contextTokens = 0
  private apiCalls = 0
  private apiMs = 0
  private toolCalls = 0

  // Side-spend, itemized so it never pollutes the brain meter but still counts
  // toward all-time totals.
  private readonly worker: Side = emptySide()
  private readonly summary: Side = emptySide()

  // Meter window, learned from context.built and the last brain llm.response.
  private budget = 0
  private compactionAt: number | null = null
  private meterModel: string | null = null
  private hasBrainReading = false

  // Brain turn.usage roll-up (authoritative cost + tool count + provider/model).
  private pending: {
    provider: string | null
    model: string | null
    cost: number
    toolCalls: number | null
  } | null = null
  private lastCall: { provider: string; model: string } | null = null

  constructor(startedAt: number) {
    this.startedAt = startedAt
  }

  /**
   * Feed a relayed corpus event. Only the four the renderer routes on matter;
   * everything else is ignored, so callers can forward the whole turn-event
   * stream without pre-filtering.
   */
  note<E extends CorpusEvent>(type: E, payload: CorpusEvents[E]): void {
    if (type === 'context.built') {
      const p = payload as CorpusEvents['context.built']
      if (num(p.tokenBudget) > 0) this.budget = p.tokenBudget
      if (num(p.compactionAt) > 0) this.compactionAt = p.compactionAt ?? null
      return
    }
    if (type === 'llm.response') {
      const p = payload as CorpusEvents['llm.response']
      const role = typeof p.role === 'string' ? p.role : 'brain'
      const uncached = num(p.inputTokens)
      const cacheRead = num(p.cacheReadTokens)
      const cacheCreated = num(p.cacheCreationTokens)
      const out = num(p.outputTokens)
      const durationMs = num(p.durationMs)
      if (role === 'worker') {
        this.worker.calls += 1
        this.worker.inputTokens += uncached
        this.worker.outputTokens += out
        this.worker.cacheReadTokens += cacheRead
        this.worker.cacheCreationTokens += cacheCreated
      } else if (role === 'summary' || role === 'title') {
        this.summary.calls += 1
        this.summary.inputTokens += uncached
        this.summary.outputTokens += out
        this.summary.cacheReadTokens += cacheRead
        this.summary.cacheCreationTokens += cacheCreated
        this.summary.cost += num(p.cost)
      } else {
        const hasUsage = uncached > 0 || cacheRead > 0 || cacheCreated > 0 || out > 0
        if (hasUsage) {
          // Prompt side of the latest brain call — what's resident in the
          // window right now (fresh + cached prefix + cache writes).
          this.contextTokens = uncached + cacheRead + cacheCreated
          this.hasBrainReading = true
          if (typeof p.model === 'string') this.meterModel = p.model
        }
        if (typeof p.provider === 'string' && typeof p.model === 'string') {
          this.lastCall = { provider: p.provider, model: p.model }
        }
        this.inputTokens += uncached
        this.outputTokens += out
        this.cacheReadTokens += cacheRead
        this.cacheCreationTokens += cacheCreated
        this.apiCalls += 1
        this.apiMs += durationMs
      }
      return
    }
    if (type === 'turn.usage') {
      const p = payload as CorpusEvents['turn.usage']
      const cost = num(p.cost)
      if (p.role === 'worker') {
        this.worker.turns += 1
        this.worker.cost += cost
      } else {
        this.pending = {
          provider: typeof p.provider === 'string' ? p.provider : null,
          model: typeof p.model === 'string' ? p.model : null,
          cost,
          // Brain-only tool count from the agent loop — the live tool.called
          // counter also sees relayed WORKER tool events during workflow turns,
          // so this is the authoritative per-turn number.
          toolCalls: typeof p.toolCalls === 'number' ? p.toolCalls : null
        }
      }
      return
    }
    if (type === 'tool.called') {
      this.toolCalls += 1
    }
  }

  /**
   * True once this turn observed any billable brain activity worth persisting.
   * Lets callers skip a stats write for a turn that never reached the model
   * (e.g. an immediate sensitive-data block) so they don't stamp an empty
   * "turn" onto the conversation's all-time totals.
   */
  hasData(): boolean {
    return this.hasBrainReading || this.apiCalls > 0 || this.pending !== null
  }

  /**
   * Fold this turn onto the conversation's existing stats and return the new
   * snapshot to persist. Mirrors Chat.tsx `finalizeTurn`: the frozen last-turn
   * roll-up, the lifetime totals (brain + side-spend), and the meter reading
   * stamped with the model it was measured under. The meter is only overwritten
   * when this turn produced a brain reading — an errored/no-provider turn keeps
   * the last known reading instead of blanking it.
   */
  foldInto(prev: ConversationStats | null | undefined, endedAt: number): ConversationStats {
    const elapsedMs = Math.max(0, endedAt - this.startedAt)
    const toolCalls = this.pending?.toolCalls ?? this.toolCalls
    const lastTurn: ConversationTurnStats = {
      endedAt,
      elapsedMs,
      apiMs: this.apiMs,
      apiCalls: this.apiCalls,
      toolCalls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheCreationTokens: this.cacheCreationTokens,
      cost: (this.pending?.cost ?? 0) + this.worker.cost + this.summary.cost,
      provider: this.pending?.provider ?? this.lastCall?.provider ?? null,
      model: this.pending?.model ?? this.lastCall?.model ?? null
    }
    const base = prev?.allTime ?? EMPTY_ALL_TIME
    const allTime: ConversationStats['allTime'] = {
      processingMs: base.processingMs + elapsedMs,
      apiMs: base.apiMs + this.apiMs,
      turns: base.turns + 1,
      apiCalls: base.apiCalls + this.apiCalls + this.worker.calls + this.summary.calls,
      toolCalls: base.toolCalls + toolCalls,
      inputTokens:
        base.inputTokens + this.inputTokens + this.worker.inputTokens + this.summary.inputTokens,
      outputTokens:
        base.outputTokens +
        this.outputTokens +
        this.worker.outputTokens +
        this.summary.outputTokens,
      cacheReadTokens:
        base.cacheReadTokens +
        this.cacheReadTokens +
        this.worker.cacheReadTokens +
        this.summary.cacheReadTokens,
      cacheCreationTokens:
        base.cacheCreationTokens +
        this.cacheCreationTokens +
        this.worker.cacheCreationTokens +
        this.summary.cacheCreationTokens,
      cost: base.cost + lastTurn.cost
    }
    // Keep the prior meter when this turn never measured a brain reading (a
    // turn that errored before the first usage-bearing call) so reopening
    // shows the last real reading rather than an empty gauge.
    const meter =
      this.hasBrainReading && this.budget > 0
        ? {
            contextTokens: this.contextTokens,
            contextBudget: this.budget,
            compactionAt: this.compactionAt,
            model: this.meterModel
          }
        : (prev?.meter ?? null)
    return { allTime, lastTurn, meter }
  }
}
