import type { WaitSnapshot, WaitStatus } from '@main/runtime/broca'
import { turnScope } from '@main/runtime/corpus'
import { wlog } from '@main/workspace/logger'

/**
 * Blocking waits — the `wait` tool's engine.
 *
 * The model decides how long to be idle and nothing here argues with it:
 * there is no ceiling, no clamp and no "that's too long" refusal. What this
 * manager owns is everything the user needs while it happens — a card that
 * says WHY the agent is idle and until when, and a way to end it early.
 *
 * Three ways a wait ends, and the tool result names which:
 *  - `elapsed`     — the timer ran out. The normal path.
 *  - `interrupted` — a mid-turn message arrived (the card's input, the
 *    composer, or a phone/channel message on this conversation). The text
 *    itself is NOT consumed here: it stays in the interjection inbox and is
 *    delivered to the model as an ordinary user message at the very next
 *    stop point — which is the tool result this wait is about to return. One
 *    delivery path, one copy in the transcript, in the order the user saw.
 *  - `canceled`    — the run was stopped (the tool call's AbortSignal).
 *
 * ONE wait per conversation at a time. A second `wait` call from the same
 * conversation is a model bug (nothing else can call it mid-block), so it is
 * refused rather than queued.
 *
 * Display rides the `wait` segment (broca.ts): the `waiting` snapshot goes
 * out the moment the tool blocks — the electron/CLI/mobile sinks class it as
 * structural, so the turn checkpoint puts the card on disk within the second
 * — and the terminal snapshot replaces it in place (upsertWaitSegment). An
 * hour-long wait is therefore already persisted long before it ends.
 */

export type WaitStartInput = {
  /** The model's own words for why it is waiting. */
  reason: string
  /** Seconds to block. Uncapped — the model chooses. */
  seconds: number
}

export type WaitOutcome = {
  status: Exclude<WaitStatus, 'waiting'>
  /** Whole seconds actually spent blocked. */
  waitedSeconds: number
  /** The interrupting message, when one ended it. */
  interruptedBy?: string
}

export type WaitStartResult = { ok: true; outcome: WaitOutcome } | { ok: false; error: string }

type WaitRecord = {
  snapshot: WaitSnapshot
  turnId: string | null
  timer: ReturnType<typeof setTimeout> | null
  settle: (outcome: WaitOutcome) => void
}

export class WaitManager {
  /**
   * Live waits, keyed by conversation — or by turn, for a run that has no
   * conversation of its own. Without the turn fallback every conversationless
   * run in the process shared one key `''`, so the second concurrent one to
   * call `wait` was refused as a duplicate of the first.
   */
  private readonly active = new Map<string, WaitRecord>()
  private readonly turnEmitters = new Map<string, (snap: WaitSnapshot) => void>()

  /**
   * Agent registers one emitter per live turn so a wait's cards ride that
   * turn's broca (the video/countdown pattern). Returns the unregister.
   */
  registerTurnEmitter(turnId: string, emit: (snap: WaitSnapshot) => void): () => void {
    this.turnEmitters.set(turnId, emit)
    return () => {
      this.turnEmitters.delete(turnId)
    }
  }

  private key(conversationId: string | null, turnId?: string | null): string {
    return conversationId ?? (turnId ? `turn:${turnId}` : '')
  }

  private emit(record: WaitRecord): void {
    if (!record.turnId) return
    const emit = this.turnEmitters.get(record.turnId)
    if (!emit) return
    try {
      emit(record.snapshot)
    } catch {
      // A dead emitter (turn already torn down) must never break the wait.
    }
  }

  /** The live wait on a conversation, if any. */
  pending(conversationId: string | null): WaitSnapshot | null {
    return this.active.get(this.key(conversationId))?.snapshot ?? null
  }

  /**
   * Block for `seconds`. Resolves with how the wait ended — never rejects,
   * and always settles: the timer, an interrupt and the abort signal are the
   * only three exits and each one clears the others.
   */
  async start(input: WaitStartInput, signal?: AbortSignal): Promise<WaitStartResult> {
    const seconds = Number(input.seconds)
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return { ok: false, error: 'seconds must be a positive number.' }
    }
    const reason = input.reason.trim()
    if (!reason) {
      return {
        ok: false,
        error:
          "reason is required — one line, in the user's words, saying what you are waiting for."
      }
    }

    const scope = turnScope.getStore()
    const conversationId = scope?.conversationId ?? null
    const key = this.key(conversationId, scope?.turnId ?? null)
    if (this.active.has(key)) {
      return {
        ok: false,
        error:
          'A wait is already running here. Never start a second one — let the first return, then decide whether you still need to wait.'
      }
    }
    if (signal?.aborted) {
      return { ok: true, outcome: { status: 'canceled', waitedSeconds: 0 } }
    }

    const startedAt = Date.now()
    const ms = Math.round(seconds * 1000)
    const snapshot: WaitSnapshot = {
      waitId: `wait_${startedAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      conversationId,
      reason,
      seconds,
      status: 'waiting',
      startedAt,
      endsAt: startedAt + ms
    }

    return await new Promise<WaitStartResult>((resolve) => {
      let done = false
      const record: WaitRecord = {
        snapshot,
        turnId: scope?.turnId ?? null,
        timer: null,
        settle: (outcome) => {
          if (done) return
          done = true
          if (record.timer) clearTimeout(record.timer)
          record.timer = null
          signal?.removeEventListener('abort', onAbort)
          this.active.delete(key)
          record.snapshot = {
            ...record.snapshot,
            status: outcome.status,
            endedAt: Date.now(),
            ...(outcome.interruptedBy ? { interruptedBy: outcome.interruptedBy } : {})
          }
          this.emit(record)
          wlog.info(
            '[wait]',
            `${record.snapshot.waitId} ${outcome.status} after ${outcome.waitedSeconds}s of ${seconds}s`
          )
          resolve({ ok: true, outcome })
        }
      }
      const elapsedSeconds = (): number => Math.round((Date.now() - startedAt) / 1000)
      const onAbort = (): void =>
        record.settle({ status: 'canceled', waitedSeconds: elapsedSeconds() })

      this.active.set(key, record)
      // The card goes out BEFORE the block starts: the user must see why the
      // agent went quiet at the moment it does, not when it wakes.
      this.emit(record)
      wlog.info('[wait]', `${snapshot.waitId} waiting ${seconds}s — ${reason}`)

      record.timer = setTimeout(
        () => record.settle({ status: 'elapsed', waitedSeconds: elapsedSeconds() }),
        ms
      )
      // Deliberately NOT unref'd. A wait is supposed to hold the runtime open
      // — that is what the model asked for — and an unref'd timer let a
      // headless host (the CLI daemon, a test runner) exit mid-wait with the
      // turn silently unfinished. Quitting is still clean: the turn's Stop
      // path aborts the signal, which settles this immediately.
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * End this conversation's wait early because the user spoke. Called from
   * the turn runner's interject path, so EVERY surface that can send a
   * mid-turn message (the card's own input, the composer, the phone,
   * Telegram, WhatsApp) breaks a wait without knowing this exists.
   *
   * Returns true when a wait was actually cut short.
   */
  interrupt(conversationId: string | null, text?: string): boolean {
    const record = this.active.get(this.key(conversationId))
    if (!record) return false
    const trimmed = (text ?? '').trim()
    record.settle({
      status: 'interrupted',
      waitedSeconds: Math.round((Date.now() - record.snapshot.startedAt) / 1000),
      ...(trimmed ? { interruptedBy: trimmed } : {})
    })
    return true
  }
}

export const waits = new WaitManager()
