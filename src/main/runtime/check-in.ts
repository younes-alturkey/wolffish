import type { StepResult } from '@main/runtime/motor'
import { wlog } from '@main/workspace/logger'

/**
 * Check-ins — the model's awareness of a tool call that is taking long.
 *
 * A tool call used to hold the agent loop for as long as it ran: a folder
 * search that crawled the whole home directory kept the model frozen for an
 * hour, and nothing in the loop could tell it so — interjections drain
 * between model calls, the no-progress guard counts calls, the runtime tail
 * is rebuilt before the next model call. Inside one call the model does not
 * exist.
 *
 * This manager gives every tool call a CHECK-IN: after the delay the model
 * chose for the call (or the default), a call that is still running is
 * PARKED — the promise keeps running, untouched — and the tool result the
 * model receives says "still running, here is what it has printed so far,
 * here is its handle". The model then decides, at a real stop point:
 *
 *  - `call_wait`  — block on it again (with its own check-in), and get the
 *                   real result the moment it lands;
 *  - `call_stop`  — abort it (for a shell command, the whole process tree);
 *  - anything else — carry on; the runtime tail names the parked call on
 *                   every later iteration until it is read or stopped.
 *
 * Nothing here caps, kills, or retries. A ten-hour command is ten check-ins
 * the model chose to wait through. The only harness-owned number is the
 * DEFAULT delay, and it decides when the model gets to think, never what it
 * does.
 */

/** The universal per-call argument: seconds until this call's first check-in. */
export const CHECK_IN_ARG = 'check_in_after'

/** Check-in delay when the model does not set `check_in_after`. */
export const DEFAULT_CHECK_IN_SECONDS = 120

/**
 * Tools whose blocking IS the model's decision — a wait it asked for, a
 * question to the user, an await on an agent with its own escalation — or
 * that carry their own explicit timeout. Racing those would second-guess a
 * choice the model already made.
 */
export const CHECK_IN_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  'wait',
  'call_wait',
  'call_stop',
  'ask_user',
  'agents_await',
  'video_await',
  'process_status',
  'close_turn',
  'countdown_start'
])

export type ParkedCallState = 'running' | 'finished' | 'stopped'

export type ParkedCall = {
  handle: string
  conversationKey: string
  turnId: string
  toolCallId: string
  name: string
  argsSummary: string
  startedAt: number
  /** How many check-ins this call has been through (the first park is 1). */
  checkIns: number
  controller: AbortController
  promise: Promise<StepResult>
  state: ParkedCallState
  /** Set with state `stopped`: the model's call_stop, or the user's Stop on the turn. */
  stoppedBy: 'user' | 'model' | null
  result: StepResult | null
  finishedAt: number | null
  /** The final result was handed to the model through call_wait. */
  reported: boolean
}

export type ProgressValue = string | (() => string)

export type CheckInRaceInput = {
  promise: Promise<StepResult>
  controller: AbortController
  conversationKey: string
  turnId: string
  toolCallId: string
  name: string
  argsSummary: string
  seconds: number
}

export type CheckInRaceOutcome =
  | { kind: 'settled'; result: StepResult }
  | { kind: 'checked_in'; record: ParkedCall; text: string }

export type CheckInWaitOutcome =
  | { kind: 'finished'; record: ParkedCall; result: StepResult }
  | { kind: 'checked_in'; record: ParkedCall; text: string }
  | { kind: 'unknown' }

/** Split the universal check-in argument off a call's args. */
export function splitCheckInArg(args: Record<string, unknown>): {
  args: Record<string, unknown>
  seconds: number | null
} {
  if (!args || !(CHECK_IN_ARG in args)) return { args, seconds: null }
  const { [CHECK_IN_ARG]: raw, ...rest } = args
  const n = typeof raw === 'string' ? Number(raw) : raw
  const seconds = typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null
  return { args: rest, seconds }
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rest = s % 60
  if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`
  const h = Math.floor(m / 60)
  const mm = m % 60
  return mm ? `${h}h ${mm}m` : `${h}h`
}

const MAX_PARKED_PER_CONVERSATION = 50

export class CheckInManager {
  private readonly parked = new Map<string, ParkedCall>()
  private seq = 0
  /** Where a running tool's latest progress text lives (cerebellum owns the map). */
  private progressSource: ((toolCallId: string) => ProgressValue | null) | null = null
  private readonly turnEmitters = new Map<string, (record: ParkedCall) => void>()

  setProgressSource(fn: (toolCallId: string) => ProgressValue | null): void {
    this.progressSource = fn
  }

  /**
   * The Agent registers one emitter per live turn so a parked call that
   * finishes while its turn is still open updates its card in place. Returns
   * the unregister.
   */
  registerTurnEmitter(turnId: string, emit: (record: ParkedCall) => void): () => void {
    this.turnEmitters.set(turnId, emit)
    return () => {
      this.turnEmitters.delete(turnId)
    }
  }

  private emit(record: ParkedCall): void {
    const emit = this.turnEmitters.get(record.turnId)
    if (!emit) return
    try {
      emit(record)
    } catch {
      // A dead emitter must never break the call it describes.
    }
  }

  private progressText(toolCallId: string): string {
    const v = this.progressSource?.(toolCallId) ?? null
    if (v === null) return ''
    try {
      const text = typeof v === 'function' ? v() : v
      return typeof text === 'string' ? text.trim() : ''
    } catch {
      return ''
    }
  }

  get(handle: string): ParkedCall | null {
    return this.parked.get(handle) ?? null
  }

  /** Every parked call of one conversation, oldest first. */
  list(conversationKey: string): ParkedCall[] {
    return [...this.parked.values()].filter((r) => r.conversationKey === conversationKey)
  }

  /**
   * Run a tool promise against its check-in delay. Settles with the result
   * when the call finishes first; otherwise parks the call — still running —
   * and returns the model-facing check-in text.
   */
  async race(input: CheckInRaceInput): Promise<CheckInRaceOutcome> {
    const ms = Math.max(1000, Math.round(input.seconds * 1000))
    const startedAt = Date.now()
    let timer: ReturnType<typeof setTimeout> | null = null
    const settled = input.promise.then(
      (result) => ({ kind: 'settled' as const, result }),
      (err) => ({
        kind: 'settled' as const,
        result: {
          ok: false,
          output: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
          attempts: 0
        } as StepResult
      })
    )
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), ms)
    })
    const first = await Promise.race([settled, timeout])
    if (timer) clearTimeout(timer)
    if (first.kind === 'settled') return first

    this.seq += 1
    const record: ParkedCall = {
      handle: `call-${this.seq}`,
      conversationKey: input.conversationKey,
      turnId: input.turnId,
      toolCallId: input.toolCallId,
      name: input.name,
      argsSummary: input.argsSummary,
      startedAt,
      checkIns: 1,
      controller: input.controller,
      promise: input.promise,
      state: 'running',
      result: null,
      finishedAt: null,
      reported: false,
      stoppedBy: null
    }
    this.park(record)
    void settled.then((s) => {
      record.result = s.result
      record.finishedAt = Date.now()
      if (record.state === 'running') record.state = 'finished'
      wlog.info(
        '[check-in]',
        `${record.handle} ${record.state} after ${formatElapsed(record.finishedAt - record.startedAt)} — ${record.name}`
      )
      this.emit(record)
    })
    wlog.info(
      '[check-in]',
      `${record.handle} parked after ${formatElapsed(ms)} — ${record.name} ${record.argsSummary}`
    )
    return { kind: 'checked_in', record, text: this.checkInText(record) }
  }

  private park(record: ParkedCall): void {
    this.parked.set(record.handle, record)
    // Bound the map per conversation: a parked call the model never read is
    // still a parked call, but an unbounded map is a leak. Oldest FINISHED
    // ones go first; a running call is never dropped.
    const mine = this.list(record.conversationKey)
    if (mine.length > MAX_PARKED_PER_CONVERSATION) {
      for (const r of mine) {
        if (r.state === 'running') continue
        this.parked.delete(r.handle)
        if (this.list(record.conversationKey).length <= MAX_PARKED_PER_CONVERSATION) break
      }
    }
  }

  /** The model-facing text of a check-in: what is running, for how long, what it printed, what to do. */
  checkInText(record: ParkedCall): string {
    const elapsed = formatElapsed(Date.now() - record.startedAt)
    const progress = this.progressText(record.toolCallId)
    const nth = record.checkIns > 1 ? ` (check-in ${record.checkIns})` : ''
    const lines = [
      `STILL RUNNING${nth}: \`${record.name}\`${record.argsSummary ? ` ${record.argsSummary}` : ''} has been running for ${elapsed} and has not finished. Handle: ${record.handle}.`,
      progress ? `Latest progress:\n${progress}` : 'It has produced no progress output so far.',
      'Nothing was stopped — it keeps running while you decide. Most steps finish in seconds to minutes, so a call this long usually means the wrong call (a search too broad, a hang, a wait for input that never comes): ' +
        `call_stop handle="${record.handle}" and take a narrower route. Keep waiting only when the progress above shows real work on a job you know is long (a build, a download, a big test suite): ` +
        `call_wait handle="${record.handle}" blocks on it again (check_in_after sets the next check-in) and returns its real result the moment it lands. ` +
        'If you move on instead, the runtime status names it every step until you read or stop it.'
    ]
    return lines.join('\n\n')
  }

  /**
   * Block on a parked call again for up to `seconds`. Returns the final
   * result when it lands, a fresh check-in when it does not.
   */
  async wait(
    handle: string,
    conversationKey: string,
    seconds: number,
    signal?: AbortSignal
  ): Promise<CheckInWaitOutcome> {
    const record = this.parked.get(handle)
    if (!record || record.conversationKey !== conversationKey) return { kind: 'unknown' }
    if (record.state !== 'running') return this.finish(record)
    const ms = Math.max(1000, Math.round(seconds * 1000))
    let timer: ReturnType<typeof setTimeout> | null = null
    let onAbort: (() => void) | null = null
    const timeout = new Promise<'timeout' | 'aborted'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms)
      if (signal) {
        onAbort = (): void => resolve('aborted')
        if (signal.aborted) resolve('aborted')
        else signal.addEventListener('abort', onAbort, { once: true })
      }
    })
    const done = record.promise.then(
      () => 'done' as const,
      () => 'done' as const
    )
    const first = await Promise.race([done, timeout])
    if (timer) clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    if (first === 'done' || record.state !== 'running') {
      // The settle hook above runs on the same microtask chain; give it a tick.
      await Promise.resolve()
      return this.finish(record)
    }
    if (first === 'aborted') return { kind: 'unknown' }
    record.checkIns += 1
    return { kind: 'checked_in', record, text: this.checkInText(record) }
  }

  private finish(record: ParkedCall): CheckInWaitOutcome {
    const result = record.result ?? {
      ok: false,
      output: 'The call ended without a result.',
      attempts: 0
    }
    record.reported = true
    this.parked.delete(record.handle)
    return { kind: 'finished', record, result }
  }

  /** Abort a parked call. The tool's own stop path answers (for a shell command, the tree is killed). */
  stop(
    handle: string,
    conversationKey: string
  ): { ok: true; record: ParkedCall } | { ok: false; error: string } {
    const record = this.parked.get(handle)
    if (!record || record.conversationKey !== conversationKey) {
      return { ok: false, error: `No running call with handle "${handle}" in this conversation.` }
    }
    if (record.state === 'finished') {
      return {
        ok: false,
        error: `${handle} already finished — call_wait handle="${handle}" returns its result.`
      }
    }
    if (record.state === 'stopped') return { ok: true, record }
    record.state = 'stopped'
    record.stoppedBy = 'model'
    record.controller.abort()
    wlog.info(
      '[check-in]',
      `${record.handle} stopped by the model after ${formatElapsed(Date.now() - record.startedAt)}`
    )
    return { ok: true, record }
  }

  /** A turn was stopped by the user: everything it parked stops with it. */
  abortTurn(turnId: string): void {
    for (const record of this.parked.values()) {
      if (record.turnId !== turnId || record.state !== 'running') continue
      record.state = 'stopped'
      record.stoppedBy = 'user'
      record.controller.abort()
    }
  }

  /**
   * The runtime-tail notice for one conversation: every parked call that is
   * still running or finished unread. Undefined when there is nothing.
   */
  noticeText(conversationKey: string, now = Date.now()): string | undefined {
    const mine = this.list(conversationKey).filter((r) => !r.reported)
    if (mine.length === 0) return undefined
    const parts = mine.map((r) => {
      const label = `\`${r.name}\`${r.argsSummary ? ` ${r.argsSummary}` : ''}`
      if (r.state === 'running') {
        return `${r.handle}: ${label} still running (${formatElapsed(now - r.startedAt)} so far) — call_wait to block on it, call_stop to end it`
      }
      if (r.state === 'stopped') {
        return `${r.handle}: ${label} stopped${r.finishedAt ? ` ${formatElapsed(now - r.finishedAt)} ago` : ''} — call_wait returns its final output`
      }
      return `${r.handle}: ${label} finished ${r.finishedAt ? formatElapsed(now - r.finishedAt) : '?'} ago after ${formatElapsed((r.finishedAt ?? now) - r.startedAt)} — call_wait handle="${r.handle}" reads its result`
    })
    return `CHECKED-IN CALLS (yours to read or stop; nothing ends them for you): ${parts.join('; ')}.`
  }
}

export const checkIns = new CheckInManager()
