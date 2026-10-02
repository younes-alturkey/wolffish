import { diskWriter } from '@main/io/diskWriter'
import { mintMessageId, updateConversation } from '@main/conversations'
import type { CountdownAbortReason, CountdownSnapshot } from '@main/runtime/broca'
import { wlog } from '@main/workspace/logger'
import { WORKSPACE_ROOT } from '@main/workspace/root'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Turn-end countdowns — the one kind of tool effect that is deliberately
 * NOT run by the tool call that asked for it.
 *
 * A restart, a shutdown, a logout, or anything else that takes the app (or
 * the machine) down mid-turn destroys the very reply that was warning the
 * user about it. So the model does not fire such actions: it ARMS one here
 * (`arm`), finishes its reply, and the clock starts only once that turn has
 * ended and its transcript is on disk (`turnEnded`). The user sees a card
 * with the label, a draining bar and an Abort button for the whole grace
 * period; when it elapses the manager runs the armed tool call itself.
 *
 * Invariants:
 *  - ONE pending countdown per app. Arming a second one aborts the first as
 *    `superseded` — there is no queue of reboots.
 *  - A turn that is stopped or errors never starts its countdown: the reply
 *    that was supposed to warn the user never landed, so nothing fires.
 *  - The `fired` state is written to the conversation file BEFORE the target
 *    runs: a target that kills the process leaves history saying it ran.
 *  - A countdown found `armed`/`counting` at startup is a lie — no timer
 *    survives a relaunch — and is rewritten as `aborted: relaunch`.
 *
 * Display rides the `countdown` segment (broca.ts). While the arming turn
 * streams, the snapshot reaches its broca through the turn emitter Agent
 * registers; after the turn ends every transition reaches the renderer and
 * the phone through the listeners wired in main/index.ts, and the
 * conversation file through this manager's own write-through.
 */

export type CountdownArmInput = {
  label: string
  seconds: number
  tool: string
  args: Record<string, unknown>
}

export type CountdownArmResult =
  | { ok: true; snapshot: CountdownSnapshot }
  | { ok: false; error: string }

/** Runs the armed tool call when the clock elapses. Injected by main. */
export type CountdownExecutor = (
  tool: string,
  args: Record<string, unknown>
) => Promise<{ success: boolean; output?: string; error?: string }>

export const COUNTDOWN_DEFAULT_SECONDS = 10
export const COUNTDOWN_MIN_SECONDS = 3
export const COUNTDOWN_MAX_SECONDS = 600

/**
 * The arming turn's final persist is fired without being awaited (the
 * channels' onDone → checkpoint.flush({final:true})), so the `counting`
 * write-through waits this long before its read-modify-write — otherwise
 * the flush could land after it and put the stale `armed` card back on disk.
 * The terminal write comes seconds later still, so even a lost `counting`
 * write is corrected before anyone reopens the conversation.
 */
const COUNTING_WRITE_DELAY_MS = 2_000

const REGISTRY_KEEP_TERMINAL = 20

type CountdownRecord = {
  snapshot: CountdownSnapshot
  timer: ReturnType<typeof setTimeout> | null
}

export class CountdownManager {
  private readonly records = new Map<string, CountdownRecord>()
  private readonly snapshotListeners = new Set<(snap: CountdownSnapshot) => void>()
  private readonly writtenListeners = new Set<(snap: CountdownSnapshot) => void>()
  private readonly turnEmitters = new Map<string, (snap: CountdownSnapshot) => void>()
  private executor: CountdownExecutor | null = null
  private firing = false
  private loaded = false

  private registryPath(): string {
    return path.join(WORKSPACE_ROOT, 'countdowns.json')
  }

  /** Main hands in the tool runner (cerebellum.executeTool) once at boot. */
  setExecutor(executor: CountdownExecutor): void {
    this.executor = executor
  }

  /**
   * True while an armed target is being executed. The `system` plugin reads
   * this to tell "the model asked for a restart" (arm a countdown) from
   * "the countdown is firing the restart it armed" (run it now).
   */
  isFiring(): boolean {
    return this.firing
  }

  /**
   * Load the registry. Anything not terminal was pending when the app went
   * down; its timer died with the process, so it is rewritten as aborted —
   * in the registry and in the conversation file the card lives in.
   */
  async init(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    let parsed: { countdowns?: CountdownSnapshot[] } = {}
    try {
      parsed = JSON.parse(await fs.readFile(this.registryPath(), 'utf8'))
    } catch {
      return
    }
    for (const snap of parsed.countdowns ?? []) {
      if (!snap?.countdownId) continue
      const record: CountdownRecord = { snapshot: snap, timer: null }
      this.records.set(snap.countdownId, record)
      if (!isTerminal(snap.status)) {
        wlog.info('[countdown]', `${snap.countdownId} was ${snap.status} at relaunch — aborting`)
        record.snapshot = {
          ...snap,
          status: 'aborted',
          abortedBy: 'relaunch',
          endedAt: Date.now()
        }
        await this.writeThrough(record.snapshot)
      }
    }
    await this.persist()
  }

  onSnapshot(cb: (snap: CountdownSnapshot) => void): () => void {
    this.snapshotListeners.add(cb)
    return () => this.snapshotListeners.delete(cb)
  }

  /**
   * Fires after a post-turn snapshot has landed in the conversation FILE —
   * the moment a nudge to re-read the body (the phone's path) is truthful.
   */
  onWritten(cb: (snap: CountdownSnapshot) => void): () => void {
    this.writtenListeners.add(cb)
    return () => this.writtenListeners.delete(cb)
  }

  /**
   * Agent registers the live turn's broca forwarder here so the `armed`
   * snapshot rides the arming turn's segment stream (the task-card pattern).
   */
  registerTurnEmitter(turnId: string, emit: (snap: CountdownSnapshot) => void): () => void {
    this.turnEmitters.set(turnId, emit)
    return () => this.turnEmitters.delete(turnId)
  }

  get(countdownId: string): CountdownSnapshot | null {
    return this.records.get(countdownId)?.snapshot ?? null
  }

  /** The single armed-or-counting countdown, if any. */
  pending(): CountdownSnapshot | null {
    for (const rec of this.records.values()) {
      if (!isTerminal(rec.snapshot.status)) return rec.snapshot
    }
    return null
  }

  /**
   * Register a countdown against the running turn. Nothing runs here: the
   * clock starts in turnEnded(). A pending countdown is superseded.
   */
  async arm(
    conversationId: string | null,
    turnId: string | null,
    input: CountdownArmInput
  ): Promise<CountdownArmResult> {
    const label = input.label.trim()
    if (!label) return { ok: false, error: 'label is required.' }
    const tool = input.tool.trim()
    if (!tool) return { ok: false, error: 'tool is required.' }
    if (!turnId) {
      return { ok: false, error: 'A countdown can only be armed from inside a running turn.' }
    }
    const seconds = clampSeconds(input.seconds)

    const previous = this.pending()
    if (previous) await this.abort(previous.countdownId, 'superseded')

    const snapshot: CountdownSnapshot = {
      countdownId: mintCountdownId(),
      conversationId,
      turnId,
      label,
      seconds,
      status: 'armed',
      armedAt: Date.now(),
      fireAt: null,
      endedAt: null,
      target: { tool, args: input.args ?? {} }
    }
    const record: CountdownRecord = { snapshot, timer: null }
    this.records.set(snapshot.countdownId, record)
    wlog.info('[countdown]', `${snapshot.countdownId} armed: "${label}" → ${tool} in ${seconds}s`)
    this.emitSnapshot(record)
    await this.persist()
    return { ok: true, snapshot }
  }

  /**
   * The arming turn is over. `completed` is true only for a turn that ran to
   * its own end — a Stop or an error means the warning never landed, so the
   * countdown is dropped instead of started.
   */
  turnEnded(turnId: string, completed: boolean): void {
    for (const record of this.records.values()) {
      const snap = record.snapshot
      if (snap.turnId !== turnId || snap.status !== 'armed') continue
      if (!completed) {
        void this.abort(snap.countdownId, 'stop')
        continue
      }
      const fireAt = Date.now() + snap.seconds * 1000
      record.snapshot = { ...snap, status: 'counting', fireAt }
      wlog.info('[countdown]', `${snap.countdownId} counting — fires in ${snap.seconds}s`)
      this.emitSnapshot(record)
      // See COUNTING_WRITE_DELAY_MS. The status is re-read at write time so a
      // countdown aborted inside the delay writes its terminal state instead.
      setTimeout(() => {
        void this.writeThrough(record.snapshot)
      }, COUNTING_WRITE_DELAY_MS)
      record.timer = setTimeout(() => {
        void this.fire(snap.countdownId)
      }, snap.seconds * 1000)
      void this.persist()
    }
  }

  /** Stop a pending countdown. No-op (ok:false) once it is terminal. */
  async abort(
    countdownId: string,
    by: CountdownAbortReason
  ): Promise<{ ok: boolean; error?: string }> {
    const record = this.records.get(countdownId)
    if (!record) return { ok: false, error: 'Unknown countdown.' }
    if (isTerminal(record.snapshot.status)) {
      return { ok: false, error: `Countdown already ${record.snapshot.status}.` }
    }
    if (record.timer) clearTimeout(record.timer)
    record.timer = null
    record.snapshot = {
      ...record.snapshot,
      status: 'aborted',
      abortedBy: by,
      endedAt: Date.now()
    }
    wlog.info('[countdown]', `${countdownId} aborted by ${by}`)
    this.emitSnapshot(record)
    await this.writeThroughIfPostTurn(record.snapshot)
    await this.persist()
    return { ok: true }
  }

  /** Abort whatever is pending (the channels' /cancel). Null when nothing was. */
  async abortPending(by: CountdownAbortReason): Promise<CountdownSnapshot | null> {
    const snap = this.pending()
    if (!snap) return null
    await this.abort(snap.countdownId, by)
    return this.get(snap.countdownId)
  }

  private async fire(countdownId: string): Promise<void> {
    const record = this.records.get(countdownId)
    if (!record || record.snapshot.status !== 'counting') return
    record.timer = null
    const { target } = record.snapshot
    // History says "fired" BEFORE the target runs: a restart takes this
    // process with it, and a reopen must not find a card still counting.
    record.snapshot = { ...record.snapshot, status: 'fired', endedAt: Date.now() }
    wlog.info('[countdown]', `${countdownId} firing ${target.tool}`)
    this.emitSnapshot(record)
    await this.writeThrough(record.snapshot)
    await this.persist()

    if (!this.executor) {
      record.snapshot = { ...record.snapshot, status: 'failed', error: 'No tool runner is wired.' }
      this.emitSnapshot(record)
      await this.writeThrough(record.snapshot)
      await this.persist()
      return
    }
    this.firing = true
    let outcome: { success: boolean; output?: string; error?: string }
    try {
      outcome = await this.executor(target.tool, target.args)
    } catch (err) {
      outcome = { success: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      this.firing = false
    }
    if (outcome.success) {
      const first = (outcome.output ?? '').split(/\r?\n/)[0]?.trim()
      record.snapshot = { ...record.snapshot, result: first || undefined }
    } else {
      record.snapshot = {
        ...record.snapshot,
        status: 'failed',
        error: outcome.error || 'The action reported a failure.'
      }
      wlog.warn('[countdown]', `${countdownId} target failed: ${record.snapshot.error}`)
    }
    this.emitSnapshot(record)
    await this.writeThrough(record.snapshot)
    await this.persist()
  }

  private emitSnapshot(record: CountdownRecord): void {
    const { snapshot } = record
    if (snapshot.turnId) {
      const emit = this.turnEmitters.get(snapshot.turnId)
      if (emit) {
        try {
          emit(snapshot)
        } catch {
          // Broca guard drops post-turn emits; nothing else to do.
        }
      }
    }
    for (const cb of this.snapshotListeners) {
      try {
        cb(snapshot)
      } catch {
        // Never let a listener kill the manager.
      }
    }
  }

  /** While the arming turn streams, its broca persists the segment; after, we do. */
  private async writeThroughIfPostTurn(snapshot: CountdownSnapshot): Promise<void> {
    if (snapshot.turnId && this.turnEmitters.has(snapshot.turnId)) return
    await this.writeThrough(snapshot)
  }

  /**
   * Rewrite the card in the conversation file in place (keeping its ids); if
   * the arming turn never persisted a segment, a minimal assistant message
   * carries it so the card still shows in order at the end of the transcript.
   */
  private async writeThrough(snapshot: CountdownSnapshot): Promise<void> {
    const conversationId = snapshot.conversationId
    if (!conversationId) return
    await updateConversation(conversationId, (current) => {
      if (!current) return null
      let found = false
      for (const message of current.messages) {
        for (const seg of message.segments ?? []) {
          if (seg.kind === 'countdown' && seg.snapshot.countdownId === snapshot.countdownId) {
            seg.snapshot = snapshot
            found = true
          }
        }
      }
      if (!found) {
        current.messages.push({
          id: mintMessageId(),
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          segments: [
            {
              kind: 'countdown',
              turnId: snapshot.turnId ?? `countdown_${snapshot.countdownId}`,
              segmentId: `countdown_${snapshot.countdownId}`,
              snapshot
            }
          ]
        })
      }
      return current
    }).catch(() => undefined)
    for (const cb of this.writtenListeners) {
      try {
        cb(snapshot)
      } catch {
        // Never let a listener kill the manager.
      }
    }
  }

  private async persist(): Promise<void> {
    const all = [...this.records.values()].map((r) => r.snapshot)
    const live = all.filter((s) => !isTerminal(s.status))
    const terminal = all
      .filter((s) => isTerminal(s.status))
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .slice(0, REGISTRY_KEEP_TERMINAL)
    for (const s of all) {
      if (isTerminal(s.status) && !terminal.includes(s)) this.records.delete(s.countdownId)
    }
    const payload = JSON.stringify({ version: 1, countdowns: [...live, ...terminal] }, null, 2)
    await diskWriter.writeFileAtomic(this.registryPath(), payload).catch(() => {})
  }
}

export function isTerminal(status: CountdownSnapshot['status']): boolean {
  return status === 'fired' || status === 'aborted' || status === 'failed'
}

export function clampSeconds(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return COUNTDOWN_DEFAULT_SECONDS
  return Math.max(COUNTDOWN_MIN_SECONDS, Math.min(COUNTDOWN_MAX_SECONDS, Math.round(n)))
}

function mintCountdownId(): string {
  return `cd_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export const countdowns = new CountdownManager()
