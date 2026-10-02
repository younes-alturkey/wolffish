import { diskWriter } from '@main/io/diskWriter'
import { conversationDirName } from '@main/conversations'
import type { TaskSnapshot, TaskStatus } from '@main/runtime/broca'
import { readConfig } from '@main/workspace/workspace'
import { WORKSPACE_ROOT } from '@main/workspace/root'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/**
 * MiniMax H3 asynchronous video generation — task manager.
 *
 * The H3 API is task-shaped: POST returns a task_id, the task runs for
 * minutes server-side, and a query endpoint reports queued → running →
 * succeeded|failed|cancelled. This manager owns that lifetime end to end so
 * the model never has to busy-poll: submit() validates and prepares media,
 * creates the task and starts a 10s poll loop; awaitTask() parks until the
 * task lands (the workflow agents_await pattern); on success the artifact is
 * downloaded into workspace/generations/video/conv-<id>/ before the waiter
 * resolves, so the path a waiter receives always exists on disk.
 *
 * Display rides the generic `task` segment (see broca.ts): every state
 * change produces a TaskSnapshot that replaces the previous one by taskId.
 * While the owning turn streams, Agent forwards snapshots onto its broca;
 * after the turn ends the snapshot flow continues through the listeners
 * wired in main/index.ts (renderer broadcast + conversation-file
 * write-through + channel fallback delivery), so a task that outlives its
 * turn still completes its card, saves its artifact, and reaches the user.
 *
 * Every wire fact in here (endpoints, field names, status strings, limits,
 * the audio mime quirk) was verified against the live API on 2026-08-04 —
 * see the header comments on each constant.
 */

/** Verified live: /v2 hosts H3 only; older Hailuo models reject with 2013. */
const VIDEO_API_BASE = 'https://api.minimax.io/v2'
export const VIDEO_MODEL = 'MiniMax-H3'

/** Verified live: "supported durations: 4s..15s" (error 2013 outside). */
const MIN_DURATION = 4
const MAX_DURATION = 15
/** Verified live: "supported resolutions: 768P, 2K". */
const RESOLUTIONS = ['768P', '2K'] as const
/**
 * Verified live: text-only ("t2va") requires an explicit ratio from this
 * list and rejects 'adaptive'; with visual inputs the field may be omitted
 * (the task adapts to the media) or set to 'adaptive'.
 */
const RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'] as const

/**
 * Verified live: 6016px input fails with "expected each side in [256, 5760]".
 * No max-side constant: the 2048px optimize trigger below subsumes the
 * 5760px API ceiling for every image sharp can decode.
 */
const IMAGE_MIN_SIDE = 256
/** Docs (platform.minimax.io/docs/guides/video-generation): aspect 2:5..5:2. */
const IMAGE_MIN_ASPECT = 2 / 5
const IMAGE_MAX_ASPECT = 5 / 2
const IMAGE_MAX_BYTES = 30 * 1024 * 1024
/**
 * Generation output caps at 2K (2560×1440 verified), so inputs gain nothing
 * past ~2K — larger frames only burn request-body budget (64 MB hard cap).
 * Verified live that a 2048px sharp-downscaled frame generates the same
 * class of output as the original (Desktop combos 02 vs 09b, 2026-08-04).
 */
const IMAGE_OPTIMIZE_SIDE = 2048
const IMAGE_OPTIMIZE_TRIGGER_BYTES = 8 * 1024 * 1024

/** Docs: reference clips 2–15s each, ≤15s combined, ≤50 MB each, H.264/H.265. */
const CLIP_MIN_SECONDS = 2
const CLIP_MAX_SECONDS = 15
const VIDEO_MAX_BYTES = 50 * 1024 * 1024
/** Transcode target: 768P/2K output never needs more than ~1280px reference. */
const VIDEO_OPTIMIZE_SIDE = 1280
const VIDEO_OPTIMIZE_TRIGGER_BYTES = 32 * 1024 * 1024

const AUDIO_MAX_BYTES = 15 * 1024 * 1024

/** Docs: ≤2 frames, ≤9 reference images, ≤3 clips, ≤3 audios, ≤12 media total. */
const MAX_REFERENCE_IMAGES = 9
const MAX_REFERENCE_VIDEOS = 3
const MAX_REFERENCE_AUDIOS = 3
const MAX_MEDIA_ITEMS = 12

/**
 * Docs put the request-body ceiling at 64 MB; we stop at 60 to leave head-
 * room for JSON overhead. URL inputs cost nothing against this budget.
 */
const BODY_BUDGET_BYTES = 60 * 1024 * 1024

const POLL_MS = 10_000
const FIRST_POLL_MS = 5_000
/** ~5 minutes of consecutive unreachable polls before we declare the task lost. */
const MAX_CONSECUTIVE_POLL_FAILURES = 30
/** Terminal records kept in the registry for reopen/history; older are pruned. */
const REGISTRY_KEEP_TERMINAL = 50

// TaskSnapshot/TaskStatus live in broca.ts beside WorkflowSnapshot — the
// segment stream owns the shape; this manager just produces it.
export type { TaskSnapshot, TaskStatus } from '@main/runtime/broca'

export type VideoSubmitInput = {
  prompt: string
  title?: string
  durationSeconds?: number
  resolution?: string
  ratio?: string
  firstFrame?: string
  lastFrame?: string
  referenceImages?: string[]
  referenceVideos?: string[]
  referenceAudios?: string[]
}

export type VideoSubmitResult =
  | { ok: true; snapshot: TaskSnapshot; notes: string[] }
  | { ok: false; error: string }

type TaskRecord = {
  snapshot: TaskSnapshot
  turnId: string | null
  pollTimer: NodeJS.Timeout | null
  consecutivePollFailures: number
  /** Set at terminal; cleared when a waiter or the runtime tail consumes it. */
  noticePending: boolean
  /**
   * The post-turn fallback already sent this artifact to the user. Flips
   * the pending notice from "present it now" to "already delivered" so the
   * model acknowledges instead of double-sending.
   */
  deliveredByHarness: boolean
  waiters: Array<(snap: TaskSnapshot) => void>
}

type PreparedMedia = {
  /** Data URL (base64) or pass-through http(s) URL. */
  url: string
  /** Bytes charged against the request-body budget (0 for http URLs). */
  bodyBytes: number
  seconds?: number
  note?: string
}

export class VideoTaskManager {
  private tasks = new Map<string, TaskRecord>()
  private snapshotListeners = new Set<(snap: TaskSnapshot) => void>()
  private terminalListeners = new Set<(snap: TaskSnapshot) => void>()
  /** Turn-scoped broca forwarders registered by Agent for live turns. */
  private turnEmitters = new Map<string, (snap: TaskSnapshot) => void>()
  private loaded = false

  /** Registry file holding every known task; survives app restarts. */
  private registryPath(): string {
    return path.join(WORKSPACE_ROOT, 'generations', 'video', 'registry.json')
  }

  private outputDir(conversationId: string | null): string {
    const dir = conversationId ? conversationDirName(conversationId) : 'orphan'
    return path.join(WORKSPACE_ROOT, 'generations', 'video', dir)
  }

  /**
   * Load persisted records and resume polling anything non-terminal — a
   * task submitted before an app restart keeps its lifecycle: the poll
   * loop re-attaches and the artifact still lands.
   */
  async init(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await fs.readFile(this.registryPath(), 'utf8')
      const parsed = JSON.parse(raw) as { tasks?: TaskSnapshot[] }
      for (const snap of parsed.tasks ?? []) {
        if (!snap?.taskId) continue
        const record: TaskRecord = {
          snapshot: snap,
          turnId: null,
          pollTimer: null,
          consecutivePollFailures: 0,
          noticePending: false,
          deliveredByHarness: false,
          waiters: []
        }
        this.tasks.set(snap.taskId, record)
        if (!isTerminal(snap.status)) this.schedulePoll(snap.taskId, FIRST_POLL_MS)
      }
    } catch {
      // Missing or unreadable registry: fresh start.
    }
  }

  onSnapshot(cb: (snap: TaskSnapshot) => void): () => void {
    this.snapshotListeners.add(cb)
    return () => this.snapshotListeners.delete(cb)
  }

  /** Fires once per task, after download (success) or on failure/cancel. */
  onTerminal(cb: (snap: TaskSnapshot) => void): () => void {
    this.terminalListeners.add(cb)
    return () => this.terminalListeners.delete(cb)
  }

  /**
   * Agent registers the live turn's broca forwarder here so snapshots for
   * tasks born in that turn ride its segment stream (the workflow-card
   * pattern). Everything else — later turns, closed conversations — flows
   * through the global listeners instead.
   */
  registerTurnEmitter(turnId: string, emit: (snap: TaskSnapshot) => void): () => void {
    this.turnEmitters.set(turnId, emit)
    return () => this.turnEmitters.delete(turnId)
  }

  /** True while the owning turn's broca forwarder is still registered. */
  isTurnLive(turnId: string | null): boolean {
    return turnId !== null && this.turnEmitters.has(turnId)
  }

  /** True while the turn that submitted this task is still streaming. */
  isOwningTurnLive(taskId: string): boolean {
    const record = this.tasks.get(taskId)
    return record ? this.isTurnLive(record.turnId) : false
  }

  get(taskId: string): TaskSnapshot | null {
    return this.tasks.get(taskId)?.snapshot ?? null
  }

  listFor(conversationId: string | null): TaskSnapshot[] {
    const out: TaskSnapshot[] = []
    for (const rec of this.tasks.values()) {
      if (rec.snapshot.conversationId === conversationId) out.push(rec.snapshot)
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * Record that the harness already delivered this task's artifact to the
   * user (the post-turn fallback path). The pending notice survives — the
   * model still needs to KNOW the task landed — but it flips to the
   * already-delivered wording so the next turn acknowledges instead of
   * sending the same video a second time. Without this the fallback and
   * the notice both deliver: one file, two messages on the user's phone.
   */
  markDelivered(taskId: string): void {
    const record = this.tasks.get(taskId)
    if (record) record.deliveredByHarness = true
  }

  /**
   * Runtime-tail notices for tasks that reached a terminal state without a
   * waiter (the model moved on instead of calling video_await). Drained
   * once per agent iteration; awaitTask consumption clears the flag too,
   * so a task is never announced twice.
   */
  drainNotices(conversationId: string | null): string[] {
    const out: string[] = []
    for (const rec of this.tasks.values()) {
      if (!rec.noticePending || rec.snapshot.conversationId !== conversationId) continue
      rec.noticePending = false
      out.push(terminalNotice(rec.snapshot, rec.deliveredByHarness))
    }
    return out
  }

  async submit(
    conversationId: string | null,
    turnId: string | null,
    input: VideoSubmitInput
  ): Promise<VideoSubmitResult> {
    const apiKey = await videoApiKey()
    if (!apiKey) {
      return { ok: false, error: NOT_CONFIGURED_ERROR }
    }

    const prompt = (input.prompt ?? '').trim()
    if (!prompt) return { ok: false, error: 'prompt is required.' }
    if (prompt.length > 7000) {
      return { ok: false, error: `prompt is ${prompt.length} characters; the API caps it at 7000.` }
    }

    const duration = input.durationSeconds ?? 6
    if (!Number.isInteger(duration) || duration < MIN_DURATION || duration > MAX_DURATION) {
      return {
        ok: false,
        error: `durationSeconds must be an integer between ${MIN_DURATION} and ${MAX_DURATION} (got ${input.durationSeconds}).`
      }
    }
    const resolution = (input.resolution ?? '768P').toUpperCase()
    if (!RESOLUTIONS.includes(resolution as (typeof RESOLUTIONS)[number])) {
      return { ok: false, error: `resolution must be one of ${RESOLUTIONS.join(', ')}.` }
    }

    const firstFrame = input.firstFrame?.trim() || null
    const lastFrame = input.lastFrame?.trim() || null
    const refImages = compactList(input.referenceImages)
    const refVideos = compactList(input.referenceVideos)
    const refAudios = compactList(input.referenceAudios)

    if (refImages.length > MAX_REFERENCE_IMAGES) {
      return {
        ok: false,
        error: `at most ${MAX_REFERENCE_IMAGES} reference images (got ${refImages.length}).`
      }
    }
    if (refVideos.length > MAX_REFERENCE_VIDEOS) {
      return {
        ok: false,
        error: `at most ${MAX_REFERENCE_VIDEOS} reference videos (got ${refVideos.length}).`
      }
    }
    if (refAudios.length > MAX_REFERENCE_AUDIOS) {
      return {
        ok: false,
        error: `at most ${MAX_REFERENCE_AUDIOS} reference audios (got ${refAudios.length}).`
      }
    }
    const mediaCount =
      (firstFrame ? 1 : 0) +
      (lastFrame ? 1 : 0) +
      refImages.length +
      refVideos.length +
      refAudios.length
    if (mediaCount > MAX_MEDIA_ITEMS) {
      return {
        ok: false,
        error: `at most ${MAX_MEDIA_ITEMS} media inputs total (got ${mediaCount}).`
      }
    }

    const hasVisual =
      Boolean(firstFrame || lastFrame) || refImages.length > 0 || refVideos.length > 0
    let ratio = input.ratio?.trim() || undefined
    if (!hasVisual) {
      // Verified live: text-only rejects a missing or 'adaptive' ratio.
      if (!ratio || ratio === 'adaptive') ratio = '16:9'
      if (!RATIOS.includes(ratio as (typeof RATIOS)[number])) {
        return {
          ok: false,
          error: `ratio must be one of ${RATIOS.join(', ')} (or omitted with image/video inputs).`
        }
      }
    } else if (
      ratio &&
      ratio !== 'adaptive' &&
      !RATIOS.includes(ratio as (typeof RATIOS)[number])
    ) {
      return {
        ok: false,
        error: `ratio must be one of ${RATIOS.join(', ')}, 'adaptive', or omitted.`
      }
    }

    // ── Prepare media ────────────────────────────────────────────────────
    const notes: string[] = []
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }]
    let bodyBytes = prompt.length
    let clipSeconds = 0
    let audioSeconds = 0

    try {
      const pushImage = async (source: string, role: string): Promise<void> => {
        const media = await prepareImage(source, role)
        if (media.note) notes.push(`${role}: ${media.note}`)
        bodyBytes += media.bodyBytes
        content.push({ type: 'image_url', image_url: { url: media.url }, role })
      }
      if (firstFrame) await pushImage(firstFrame, 'first_frame')
      if (lastFrame) await pushImage(lastFrame, 'last_frame')
      for (const src of refImages) await pushImage(src, 'reference_image')
      for (const src of refVideos) {
        const media = await prepareVideo(src)
        if (media.note) notes.push(`reference_video: ${media.note}`)
        bodyBytes += media.bodyBytes
        clipSeconds += media.seconds ?? 0
        content.push({ type: 'video_url', video_url: { url: media.url }, role: 'reference_video' })
      }
      for (const src of refAudios) {
        const media = await prepareAudio(src)
        if (media.note) notes.push(`reference_audio: ${media.note}`)
        bodyBytes += media.bodyBytes
        audioSeconds += media.seconds ?? 0
        content.push({ type: 'audio_url', audio_url: { url: media.url }, role: 'reference_audio' })
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    if (clipSeconds > CLIP_MAX_SECONDS) {
      return {
        ok: false,
        error: `reference videos total ${Math.round(clipSeconds)}s; the API caps combined clips at ${CLIP_MAX_SECONDS}s. Use fewer or shorter clips (ffmpeg can trim).`
      }
    }
    if (audioSeconds > CLIP_MAX_SECONDS) {
      return {
        ok: false,
        error: `reference audios total ${Math.round(audioSeconds)}s; the API caps combined audio at ${CLIP_MAX_SECONDS}s.`
      }
    }
    if (bodyBytes > BODY_BUDGET_BYTES) {
      return {
        ok: false,
        error:
          `prepared request is ~${mb(bodyBytes)} MB; the API caps the body at 64 MB. ` +
          `Drop or shrink inputs, or pass public https:// URLs instead of files (URLs cost nothing against the cap).`
      }
    }

    const body: Record<string, unknown> = {
      model: VIDEO_MODEL,
      content,
      duration,
      resolution
    }
    if (ratio) body.ratio = ratio

    // ── Create the task ──────────────────────────────────────────────────
    let created: { task_id?: string }
    try {
      const res = await videoApiFetch(apiKey, 'POST', `${VIDEO_API_BASE}/video_generation`, body)
      if (!res.ok) return { ok: false, error: `MiniMax rejected the task: ${res.error}` }
      created = res.json as { task_id?: string }
    } catch (err) {
      return {
        ok: false,
        error: `MiniMax request failed: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    const taskId = created.task_id
    if (!taskId) return { ok: false, error: 'MiniMax returned no task_id.' }

    const now = Date.now()
    const snapshot: TaskSnapshot = {
      taskId,
      kind: 'video',
      conversationId,
      title: input.title?.trim() || deriveTitle(prompt),
      status: 'submitted',
      detail: 'Task accepted by MiniMax',
      createdAt: now,
      updatedAt: now,
      estimateSeconds: estimateSeconds(resolution, duration),
      video: {
        model: VIDEO_MODEL,
        resolution,
        durationSeconds: duration,
        ratio,
        inputSummary: inputSummary(firstFrame, lastFrame, refImages, refVideos, refAudios)
      }
    }
    const record: TaskRecord = {
      snapshot,
      turnId,
      pollTimer: null,
      consecutivePollFailures: 0,
      noticePending: false,
      deliveredByHarness: false,
      waiters: []
    }
    this.tasks.set(taskId, record)
    this.emitSnapshot(record)
    await this.persist()
    this.schedulePoll(taskId, FIRST_POLL_MS)
    return { ok: true, snapshot, notes }
  }

  /**
   * Park until the task reaches a terminal state (artifact already on disk
   * for successes). Resolves null when the signal aborts first — the task
   * itself keeps running and the fallback delivery path takes over.
   */
  awaitTask(taskId: string, signal?: AbortSignal): Promise<TaskSnapshot | null> {
    const record = this.tasks.get(taskId)
    if (!record) return Promise.resolve(null)
    if (isTerminal(record.snapshot.status)) {
      record.noticePending = false
      return Promise.resolve(record.snapshot)
    }
    return new Promise((resolve) => {
      let settled = false
      const done = (snap: TaskSnapshot | null): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        resolve(snap)
      }
      const onAbort = (): void => done(null)
      record.waiters.push((snap) => {
        record.noticePending = false
        done(snap)
      })
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  async cancel(taskId: string): Promise<{ ok: boolean; error?: string }> {
    const record = this.tasks.get(taskId)
    if (!record) return { ok: false, error: `unknown task ${taskId}` }
    if (isTerminal(record.snapshot.status)) {
      return { ok: false, error: `task is already ${record.snapshot.status}` }
    }
    const apiKey = await videoApiKey()
    if (!apiKey) return { ok: false, error: NOT_CONFIGURED_ERROR }
    try {
      // Verified live: DELETE answers {"action":"cancelled","status":"cancelled"}.
      const res = await videoApiFetch(
        apiKey,
        'DELETE',
        `${VIDEO_API_BASE}/video_generation/${taskId}`
      )
      if (!res.ok) return { ok: false, error: res.error }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    await this.transition(record, 'cancelled', { detail: 'Cancelled', endedAt: Date.now() })
    return { ok: true }
  }

  // ── Poll loop ──────────────────────────────────────────────────────────

  private schedulePoll(taskId: string, delayMs: number): void {
    const record = this.tasks.get(taskId)
    if (!record || isTerminal(record.snapshot.status)) return
    if (record.pollTimer) clearTimeout(record.pollTimer)
    record.pollTimer = setTimeout(() => {
      record.pollTimer = null
      void this.poll(taskId)
    }, delayMs)
    record.pollTimer.unref?.()
  }

  private async poll(taskId: string): Promise<void> {
    const record = this.tasks.get(taskId)
    if (!record || isTerminal(record.snapshot.status)) return
    const apiKey = await videoApiKey()
    if (!apiKey) {
      this.schedulePoll(taskId, POLL_MS)
      return
    }

    let task: MiniMaxTask | null = null
    try {
      const res = await videoApiFetch(
        apiKey,
        'GET',
        `${VIDEO_API_BASE}/query/video_generation/${taskId}`
      )
      if (res.ok) {
        task = (res.json as { task?: MiniMaxTask }).task ?? null
        record.consecutivePollFailures = 0
      } else {
        record.consecutivePollFailures++
      }
    } catch {
      record.consecutivePollFailures++
    }

    if (!task) {
      if (record.consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        await this.transition(record, 'failed', {
          detail: 'Lost contact with MiniMax while polling',
          error: 'Status polling failed repeatedly; check connectivity and the MiniMax console.',
          endedAt: Date.now()
        })
        return
      }
      this.schedulePoll(taskId, POLL_MS)
      return
    }

    const status = mapStatus(task.status)
    if (status === 'succeeded') {
      const url = task.content?.url
      if (!url) {
        await this.transition(record, 'failed', {
          detail: 'Succeeded but no download URL returned',
          error: 'MiniMax reported success without a video URL.',
          endedAt: Date.now()
        })
        return
      }
      await this.download(record, url)
      return
    }
    if (status === 'failed' || status === 'cancelled') {
      const message = task.error?.message ?? 'Generation failed'
      const code = task.error?.code ? ` (${task.error.code})` : ''
      await this.transition(record, status, {
        detail: status === 'failed' ? 'Generation failed' : 'Cancelled',
        error: status === 'failed' ? `${message}${code}` : undefined,
        endedAt: Date.now()
      })
      return
    }
    if (status !== record.snapshot.status) {
      await this.transition(record, status, {
        detail: status === 'running' ? 'Generating' : 'Waiting in queue'
      })
    }
    this.schedulePoll(taskId, POLL_MS)
  }

  private async download(record: TaskRecord, url: string): Promise<void> {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`download HTTP ${res.status}`)
      const buffer = Buffer.from(await res.arrayBuffer())
      const dir = this.outputDir(record.snapshot.conversationId)
      const absPath = path.join(dir, `video-${record.snapshot.taskId}.mp4`)
      await diskWriter.writeFileAtomic(absPath, buffer)
      const relPath = path.relative(WORKSPACE_ROOT, absPath)
      await this.transition(record, 'succeeded', {
        detail: `Video ready — ${mb(buffer.length)} MB`,
        outputPath: relPath,
        outputBytes: buffer.length,
        endedAt: Date.now()
      })
    } catch (err) {
      await this.transition(record, 'failed', {
        detail: 'Download failed',
        error: `Generated video could not be downloaded: ${err instanceof Error ? err.message : String(err)}`,
        endedAt: Date.now()
      })
    }
  }

  private async transition(
    record: TaskRecord,
    status: TaskStatus,
    patch: Partial<TaskSnapshot>
  ): Promise<void> {
    if (record.pollTimer) {
      clearTimeout(record.pollTimer)
      record.pollTimer = null
    }
    record.snapshot = { ...record.snapshot, ...patch, status, updatedAt: Date.now() }
    this.emitSnapshot(record)
    if (isTerminal(status)) {
      record.noticePending = record.waiters.length === 0
      const waiters = record.waiters
      record.waiters = []
      for (const w of waiters) w(record.snapshot)
      for (const cb of this.terminalListeners) {
        try {
          cb(record.snapshot)
        } catch {
          // Listener errors must not break the poll loop.
        }
      }
    }
    await this.persist()
  }

  private emitSnapshot(record: TaskRecord): void {
    const { snapshot, turnId } = record
    if (turnId) {
      const emit = this.turnEmitters.get(turnId)
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

  private async persist(): Promise<void> {
    const all = [...this.tasks.values()].map((r) => r.snapshot)
    const live = all.filter((s) => !isTerminal(s.status))
    const terminal = all
      .filter((s) => isTerminal(s.status))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, REGISTRY_KEEP_TERMINAL)
    const payload = JSON.stringify({ version: 1, tasks: [...live, ...terminal] }, null, 2)
    await diskWriter.writeFileAtomic(this.registryPath(), payload).catch(() => {})
  }
}

// ── MiniMax wire helpers ─────────────────────────────────────────────────

type MiniMaxTask = {
  id?: string
  status?: string
  content?: { url?: string }
  error?: { code?: string; message?: string }
}

/**
 * The video service's OWN key (config.video.apiKey) — never the MiniMax
 * chat provider's. The two are independent settings even though MiniMax
 * issues one credential that unlocks both APIs: see VideoConfig in
 * workspace.ts for why that duplication is deliberate.
 */
async function videoApiKey(): Promise<string> {
  const config = await readConfig()
  return config?.video?.apiKey?.trim() ?? ''
}

const NOT_CONFIGURED_ERROR =
  'Video generation has no API key. The user must paste their MiniMax key into ' +
  'Settings → Services → Video generation (this is a separate field from the MiniMax ' +
  'chat provider — the same key value works, but it is not shared automatically). ' +
  'Tell them that; do not retry until it is set.'

/**
 * Configuration + reachability probe for the `video_check` tool, so the
 * agent can confirm the service is usable BEFORE spending a generation.
 * The probe queries a non-existent task id: a valid key answers 500
 * "record not found", a bad key answers 401 — verified live 2026-08-04.
 * Costs nothing either way.
 */
export async function checkVideoService(): Promise<{
  configured: boolean
  reachable: boolean
  detail: string
}> {
  const apiKey = await videoApiKey()
  if (!apiKey) {
    return { configured: false, reachable: false, detail: NOT_CONFIGURED_ERROR }
  }
  try {
    const res = await fetch(`${VIDEO_API_BASE}/query/video_generation/0`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    })
    if (res.status === 401 || res.status === 403) {
      return {
        configured: true,
        reachable: false,
        detail:
          'The MiniMax key saved under Settings → Services → Video generation was rejected (401). ' +
          'Ask the user to re-check it; do not attempt a generation.'
      }
    }
    return {
      configured: true,
      reachable: true,
      detail: `Video generation is ready (model ${VIDEO_MODEL}, key accepted).`
    }
  } catch (err) {
    return {
      configured: true,
      reachable: false,
      detail: `Could not reach the MiniMax video API: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

async function videoApiFetch(
  apiKey: string,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  body?: Record<string, unknown>
): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  if (!res.ok) {
    // Error envelope (verified live): {"type":"error","error":{"type":...,"message":...}}
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } }
      if (parsed.error?.message) return { ok: false, error: parsed.error.message }
    } catch {
      // fall through to raw text
    }
    return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 300)}`.trim() }
  }
  try {
    return { ok: true, json: JSON.parse(text) }
  } catch {
    return { ok: false, error: `unparseable response: ${text.slice(0, 200)}` }
  }
}

function mapStatus(raw: string | undefined): TaskStatus {
  // Verified live lifecycle: queued → running → succeeded|failed|cancelled.
  switch (raw) {
    case 'queued':
      return 'queued'
    case 'running':
      return 'running'
    case 'succeeded':
      return 'succeeded'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'queued'
  }
}

function isTerminal(status: TaskStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled'
}

function estimateSeconds(resolution: string, duration: number): number {
  // Measured live 2026-08-04: 768P 4s ranged 91–258s, 2K 4s took 198s.
  return resolution === '2K' ? 60 + 45 * duration : 40 + 30 * duration
}

function deriveTitle(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim()
  return flat.length > 64 ? `${flat.slice(0, 61)}…` : flat
}

function inputSummary(
  firstFrame: string | null,
  lastFrame: string | null,
  refImages: string[],
  refVideos: string[],
  refAudios: string[]
): string {
  const parts = ['text']
  if (firstFrame) parts.push('first frame')
  if (lastFrame) parts.push('last frame')
  if (refImages.length > 0)
    parts.push(`${refImages.length} ref image${refImages.length > 1 ? 's' : ''}`)
  if (refVideos.length > 0)
    parts.push(`${refVideos.length} ref video${refVideos.length > 1 ? 's' : ''}`)
  if (refAudios.length > 0)
    parts.push(`${refAudios.length} ref audio${refAudios.length > 1 ? 's' : ''}`)
  return parts.join(' + ')
}

function terminalNotice(snap: TaskSnapshot, deliveredByHarness = false): string {
  if (snap.status === 'succeeded') {
    const abs = snap.outputPath ? path.join(WORKSPACE_ROOT, snap.outputPath) : null
    if (deliveredByHarness) {
      return (
        `Video task ${snap.taskId} ("${snap.title}") succeeded${abs ? ` — saved to ${abs}` : ''} ` +
        `and was ALREADY SENT to the user while you were away. Do NOT send it again — just acknowledge it in a sentence if it is still relevant.`
      )
    }
    return (
      `Video task ${snap.taskId} ("${snap.title}") succeeded${abs ? ` — saved to ${abs}` : ''}. ` +
      `Present it now: in-app call send_file with that path; on Telegram/WhatsApp use telegram_send_video / whatsapp_send_video.`
    )
  }
  if (snap.status === 'failed') {
    return `Video task ${snap.taskId} ("${snap.title}") FAILED: ${snap.error ?? 'unknown error'}. Tell the user, and fix the inputs before retrying.`
  }
  return `Video task ${snap.taskId} ("${snap.title}") was cancelled.`
}

function compactList(items: string[] | undefined): string[] {
  return (items ?? []).map((s) => s.trim()).filter((s) => s.length > 0)
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}

function isHttpUrl(source: string): boolean {
  return /^https?:\/\//i.test(source)
}

/** Extensions that PROVE a URL's media kind. Used only to catch a URL sitting
 *  in the wrong slot — never to accept one. */
const URL_KIND_EXTS: Record<MediaKind, readonly string[]> = {
  image: [
    '.jpg',
    '.jpeg',
    '.png',
    '.webp',
    '.heic',
    '.heif',
    '.gif',
    '.bmp',
    '.tif',
    '.tiff',
    '.avif'
  ],
  video: ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.flv', '.wmv', '.mpg', '.mpeg', '.3gp'],
  audio: ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.wma', '.aif', '.aiff']
}

type MediaKind = 'image' | 'video' | 'audio'

/**
 * Local files are validated by extension on the way in (an .mp3 handed to
 * first_frame dies in prepareImage with a readable message); http URLs skip
 * every check because there is nothing on disk to stat or probe. That gap is
 * the one the model falls into: it reads URLs out of the user's message and
 * has to decide which is the image, which the clip, which the audio. So when
 * a URL's extension PROVES it is the wrong kind for the slot it landed in,
 * fail here — before the API call — with the reassignment spelled out.
 *
 * Deliberately narrow: only a known extension that contradicts the slot is an
 * error. Extensionless URLs (signed CDN links, share pages, ?format= params)
 * pass straight through to MiniMax, which is the authority on what it can
 * fetch.
 */
function assertUrlKind(source: string, kind: MediaKind, slot: string): void {
  const clean = source.split(/[?#]/)[0].toLowerCase()
  const dot = clean.lastIndexOf('.')
  if (dot < 0 || dot < clean.lastIndexOf('/')) return
  const ext = clean.slice(dot)
  if (URL_KIND_EXTS[kind].includes(ext)) return
  const actual = (Object.keys(URL_KIND_EXTS) as MediaKind[]).find((k) =>
    URL_KIND_EXTS[k].includes(ext)
  )
  if (!actual) return
  const slotFor: Record<MediaKind, string> = {
    image: 'first_frame, last_frame or reference_images',
    video: 'reference_videos',
    audio: 'reference_audios'
  }
  const article = (k: MediaKind): string => (k === 'video' ? 'a' : 'an')
  throw new Error(
    `${urlLabel(source)} is ${article(actual)} ${actual} URL (${ext}) but was passed as ${slot}, which takes ${article(kind)} ${kind}. ` +
      `Move it to ${slotFor[actual]}. If you are not sure what a URL the user gave you actually is, ask them before generating instead of guessing.`
  )
}

/** Short display name for a URL — the filename when there is one, so signed
 *  CDN links don't drown the error message. */
function urlLabel(source: string): string {
  const clean = source.split(/[?#]/)[0]
  const base = clean.split('/').filter(Boolean).pop()
  if (base && base.length <= 60) return base
  return source.length <= 80 ? source : `${source.slice(0, 77)}…`
}

/** Data-URL byte cost: base64 inflates by 4/3 plus the mime prefix. */
function dataUrl(mime: string, buffer: Buffer): { url: string; bodyBytes: number } {
  const b64 = buffer.toString('base64')
  return { url: `data:${mime};base64,${b64}`, bodyBytes: b64.length + mime.length + 13 }
}

function resolveLocalPath(source: string): string {
  let p = source
  if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2))
  if (!path.isAbsolute(p)) p = path.join(WORKSPACE_ROOT, p)
  return p
}

async function statOrThrow(absPath: string, kind: string): Promise<{ size: number }> {
  try {
    return await fs.stat(absPath)
  } catch {
    throw new Error(`${kind} not found: ${absPath}`)
  }
}

// ── Image preparation (sharp) ────────────────────────────────────────────

const IMAGE_EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif'
}

async function prepareImage(source: string, slot = 'an image input'): Promise<PreparedMedia> {
  if (isHttpUrl(source)) {
    assertUrlKind(source, 'image', slot)
    return { url: source, bodyBytes: 0 }
  }
  const absPath = resolveLocalPath(source)
  const stat = await statOrThrow(absPath, 'image')
  const ext = path.extname(absPath).toLowerCase()
  const mime = IMAGE_EXT_MIME[ext]
  if (!mime) {
    throw new Error(
      `unsupported image format "${ext}" for ${path.basename(absPath)} — the API takes JPG, PNG, WEBP, HEIC, HEIF.`
    )
  }

  let meta: { width?: number; height?: number; hasAlpha?: boolean } = {}
  let decodable = true
  try {
    const sharp = (await import('sharp')).default
    meta = await sharp(absPath).metadata()
  } catch {
    // sharp without libheif can't decode HEIC; pass the file through and
    // let the API validate — it decodes HEIC server-side.
    decodable = false
  }

  const width = meta.width ?? 0
  const height = meta.height ?? 0
  if (decodable && width > 0 && height > 0) {
    const short = Math.min(width, height)
    const long = Math.max(width, height)
    if (short < IMAGE_MIN_SIDE) {
      throw new Error(
        `image ${path.basename(absPath)} is ${width}x${height}; the API needs each side ≥ ${IMAGE_MIN_SIDE}px.`
      )
    }
    const aspect = width / height
    if (aspect < IMAGE_MIN_ASPECT || aspect > IMAGE_MAX_ASPECT) {
      throw new Error(
        `image ${path.basename(absPath)} aspect ${width}:${height} is outside the allowed 2:5–5:2 range; crop it first.`
      )
    }
    // The optimize triggers subsume the API's hard limits (5760px / 30 MB):
    // anything over either bound gets the same 2048px re-encode.
    const needsResize = long > IMAGE_OPTIMIZE_SIDE || stat.size > IMAGE_OPTIMIZE_TRIGGER_BYTES
    if (needsResize) {
      const sharp = (await import('sharp')).default
      const pipeline = sharp(absPath).rotate().resize({
        width: IMAGE_OPTIMIZE_SIDE,
        height: IMAGE_OPTIMIZE_SIDE,
        fit: 'inside',
        withoutEnlargement: true
      })
      const { data, info } = meta.hasAlpha
        ? await pipeline.png().toBuffer({ resolveWithObject: true })
        : await pipeline.jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true })
      if (data.length > IMAGE_MAX_BYTES) {
        throw new Error(
          `image ${path.basename(absPath)} is still ${mb(data.length)} MB after optimization (max 30 MB).`
        )
      }
      const outMime = meta.hasAlpha ? 'image/png' : 'image/jpeg'
      return {
        ...dataUrl(outMime, data),
        note: `optimized ${width}x${height} (${mb(stat.size)} MB) → ${info.width}x${info.height} (${mb(data.length)} MB)`
      }
    }
  }

  if (stat.size > IMAGE_MAX_BYTES) {
    throw new Error(`image ${path.basename(absPath)} is ${mb(stat.size)} MB (max 30 MB).`)
  }
  const buffer = await fs.readFile(absPath)
  return dataUrl(mime, buffer)
}

// ── Video / audio preparation (ffmpeg) ───────────────────────────────────

/**
 * Prefer the wolffish-managed ffmpeg (~/.wolffish/bin/ffmpeg/ffmpeg — the
 * layout the ffmpeg capability installs); fall back to PATH. Same
 * resolution the WhatsApp GIF transcoder uses.
 */
function ffmpegBinary(): string {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const managed = path.join(path.dirname(WORKSPACE_ROOT), 'bin', 'ffmpeg', exe)
  return existsSync(managed) ? managed : exe
}

type MediaProbe = { seconds: number; codec: string | null; width: number; height: number }

/** ffmpeg -i writes stream facts to stderr; that is the whole probe. */
async function probeMedia(absPath: string): Promise<MediaProbe> {
  let stderr = ''
  try {
    await execFileP(ffmpegBinary(), ['-hide_banner', '-i', absPath], {
      maxBuffer: 4 * 1024 * 1024
    })
  } catch (err) {
    // ffmpeg exits 1 for probe-only invocations; the stderr is still there.
    stderr = (err as { stderr?: string }).stderr ?? ''
  }
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  const seconds = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0
  const video = /Stream #\d+:\d+.*?: Video: (\w+).*?, (\d{2,5})x(\d{2,5})/.exec(stderr)
  return {
    seconds,
    codec: video ? video[1] : null,
    width: video ? Number(video[2]) : 0,
    height: video ? Number(video[3]) : 0
  }
}

async function prepareVideo(source: string): Promise<PreparedMedia> {
  if (isHttpUrl(source)) {
    assertUrlKind(source, 'video', 'reference_videos')
    return { url: source, bodyBytes: 0 }
  }
  const absPath = resolveLocalPath(source)
  const stat = await statOrThrow(absPath, 'video')
  const probe = await probeMedia(absPath)
  if (
    probe.seconds > 0 &&
    (probe.seconds < CLIP_MIN_SECONDS || probe.seconds > CLIP_MAX_SECONDS + 0.5)
  ) {
    throw new Error(
      `video ${path.basename(absPath)} is ${probe.seconds.toFixed(1)}s; reference clips must be ${CLIP_MIN_SECONDS}–${CLIP_MAX_SECONDS}s. Trim it first (ffmpeg -ss/-t).`
    )
  }
  const ext = path.extname(absPath).toLowerCase()
  const codecOk = probe.codec === 'h264' || probe.codec === 'hevc'
  const long = Math.max(probe.width, probe.height)
  const needsWork =
    !codecOk ||
    ext !== '.mp4' ||
    long > VIDEO_OPTIMIZE_SIDE ||
    stat.size > VIDEO_OPTIMIZE_TRIGGER_BYTES

  if (!needsWork) {
    if (stat.size > VIDEO_MAX_BYTES) {
      throw new Error(`video ${path.basename(absPath)} is ${mb(stat.size)} MB (max 50 MB).`)
    }
    const buffer = await fs.readFile(absPath)
    return { ...dataUrl('video/mp4', buffer), seconds: probe.seconds }
  }

  // Normalize: H.264 mp4, long side ≤1280, faststart. The output resolution
  // caps at 2K, so a 1280px reference sacrifices nothing (verified live —
  // reference runs with a 768P clip matched full-res behavior).
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-video-'))
  const outPath = path.join(dir, 'ref.mp4')
  try {
    await execFileP(
      ffmpegBinary(),
      [
        '-y',
        '-i',
        absPath,
        '-vf',
        `scale='min(${VIDEO_OPTIMIZE_SIDE},iw)':'min(${VIDEO_OPTIMIZE_SIDE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        outPath
      ],
      { maxBuffer: 16 * 1024 * 1024 }
    )
    const buffer = await fs.readFile(outPath)
    if (buffer.length === 0) throw new Error('ffmpeg produced an empty file')
    if (buffer.length > VIDEO_MAX_BYTES) {
      throw new Error(
        `video ${path.basename(absPath)} is still ${mb(buffer.length)} MB after transcoding (max 50 MB).`
      )
    }
    return {
      ...dataUrl('video/mp4', buffer),
      seconds: probe.seconds,
      note: `transcoded ${probe.codec ?? 'unknown'} ${probe.width}x${probe.height} (${mb(stat.size)} MB) → h264 ≤${VIDEO_OPTIMIZE_SIDE}px (${mb(buffer.length)} MB)`
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function prepareAudio(source: string): Promise<PreparedMedia> {
  if (isHttpUrl(source)) {
    assertUrlKind(source, 'audio', 'reference_audios')
    return { url: source, bodyBytes: 0 }
  }
  const absPath = resolveLocalPath(source)
  const stat = await statOrThrow(absPath, 'audio')
  const probe = await probeMedia(absPath)
  if (
    probe.seconds > 0 &&
    (probe.seconds < CLIP_MIN_SECONDS || probe.seconds > CLIP_MAX_SECONDS + 0.5)
  ) {
    throw new Error(
      `audio ${path.basename(absPath)} is ${probe.seconds.toFixed(1)}s; reference audio must be ${CLIP_MIN_SECONDS}–${CLIP_MAX_SECONDS}s. Trim it first.`
    )
  }
  const ext = path.extname(absPath).toLowerCase()
  // Verified live: the API derives the format from the data-URL mime and
  // accepts only wav/mp3 — `audio/mpeg` is REJECTED as ".mpeg", so .mp3
  // must ship as the nonstandard `audio/mp3`.
  if (ext === '.mp3' || ext === '.wav') {
    if (stat.size > AUDIO_MAX_BYTES) {
      throw new Error(`audio ${path.basename(absPath)} is ${mb(stat.size)} MB (max 15 MB).`)
    }
    const buffer = await fs.readFile(absPath)
    return {
      ...dataUrl(ext === '.mp3' ? 'audio/mp3' : 'audio/wav', buffer),
      seconds: probe.seconds
    }
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-audio-'))
  const outPath = path.join(dir, 'ref.mp3')
  try {
    await execFileP(
      ffmpegBinary(),
      ['-y', '-i', absPath, '-vn', '-codec:a', 'libmp3lame', '-qscale:a', '4', outPath],
      { maxBuffer: 16 * 1024 * 1024 }
    )
    const buffer = await fs.readFile(outPath)
    if (buffer.length === 0) throw new Error('ffmpeg produced an empty file')
    if (buffer.length > AUDIO_MAX_BYTES) {
      throw new Error(
        `audio ${path.basename(absPath)} is still ${mb(buffer.length)} MB after conversion (max 15 MB).`
      )
    }
    return {
      ...dataUrl('audio/mp3', buffer),
      seconds: probe.seconds,
      note: `converted ${ext} (${mb(stat.size)} MB) → mp3 (${mb(buffer.length)} MB)`
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Singleton, wired in main/index.ts (host bridge, broadcasts, fallback delivery). */
export const videoTasks = new VideoTaskManager()
