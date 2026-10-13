import type { ChartSpec } from '@/lib/charts/spec'
import type { ChartTheme } from '@/lib/charts/theme'

/**
 * Chart snapshot service — the queue between chart cards and the single
 * hidden rasterizer WebView (ChartSnapshotHost).
 *
 * Inline chart cards show a PNG snapshot, not a live plot: previews in the
 * feed are non-interactive by house rule (FileViewers.tsx header note), a
 * live ECharts WebView per card would reload — white flash, replayed entry
 * animation — every time the list recycles it, and one shared runtime beats
 * N copies of a 1 MB engine. The expanded sheet is where the live,
 * interactive chart lives.
 *
 * The host renders one job at a time (rasterizing is quick; bounding memory
 * matters more than latency here), results land in a small in-memory LRU
 * keyed by spec + theme + geometry, and jobs queue until the host reports
 * ready. The host mounts lazily on first demand and is told via `onDemand`.
 */

export type ChartSnapshotRequest = {
  spec: ChartSpec
  theme: ChartTheme
  /** CSS pixel geometry of the target plot. */
  width: number
  height: number
  /** Export scale — device pixel ratio for display, 2 for share-parity. */
  scale: number
  /** PNG background; omitted = transparent (the card surface shows through). */
  background?: string
}

export type ChartSnapshotJob = ChartSnapshotRequest & { id: number }

type Pending = {
  job: ChartSnapshotJob
  cacheKey: string
  resolve: (dataUrl: string) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Rendered PNGs are a few hundred KB each — cap the cache, evict oldest. */
const CACHE_CAP = 32
/** Covers host mount + page load + raster; the page's own guard is 2s. */
const JOB_TIMEOUT_MS = 15_000

const cache = new Map<string, string>()
const waiting: Pending[] = []
const inFlight = new Map<number, Pending>()

let nextId = 1
let sender: ((job: ChartSnapshotJob) => void) | null = null
let demandListener: (() => void) | null = null
let crashes = 0

function cacheKey(request: ChartSnapshotRequest): string {
  return JSON.stringify([
    request.spec,
    request.theme.isDark,
    request.width,
    request.height,
    request.scale,
    request.background ?? ''
  ])
}

function remember(key: string, dataUrl: string): void {
  cache.delete(key)
  cache.set(key, dataUrl)
  if (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

function pump(): void {
  if (!sender || inFlight.size > 0) return
  const next = waiting.shift()
  if (!next) return
  inFlight.set(next.job.id, next)
  sender(next.job)
}

function settle(id: number, result: { dataUrl?: string; error?: string }): void {
  const entry = inFlight.get(id)
  if (!entry) return
  inFlight.delete(id)
  clearTimeout(entry.timer)
  if (result.dataUrl) {
    crashes = 0
    remember(entry.cacheKey, result.dataUrl)
    entry.resolve(result.dataUrl)
  } else {
    entry.reject(new Error(result.error ?? 'chart snapshot failed'))
  }
  pump()
}

/**
 * Render a spec to a PNG data URL. Resolves from cache when the same spec has
 * already been rasterized at this theme + geometry; rejects when the host
 * cannot produce an image (the card degrades to the plain file card).
 */
export function requestChartSnapshot(request: ChartSnapshotRequest): Promise<string> {
  const key = cacheKey(request)
  const hit = cache.get(key)
  if (hit) {
    // Refresh recency so scrolling through a long feed keeps hot entries.
    remember(key, hit)
    return Promise.resolve(hit)
  }
  return new Promise<string>((resolve, reject) => {
    const job: ChartSnapshotJob = { ...request, id: nextId++ }
    const entry: Pending = {
      job,
      cacheKey: key,
      resolve,
      reject,
      timer: setTimeout(() => {
        // Wherever it is stuck (queue or host), give up on this job only.
        const index = waiting.indexOf(entry)
        if (index >= 0) waiting.splice(index, 1)
        inFlight.delete(job.id)
        reject(new Error('chart snapshot timed out'))
        pump()
      }, JOB_TIMEOUT_MS)
    }
    waiting.push(entry)
    demandListener?.()
    pump()
  })
}

/** Host page reported a finished snapshot. */
export function completeChartSnapshot(id: number, dataUrl: string): void {
  settle(id, { dataUrl })
}

/** Host page reported a failure for one job (or, with no id, the active one). */
export function failChartSnapshot(id: number | undefined, message: string): void {
  if (id !== undefined) {
    settle(id, { error: message })
    return
  }
  const active = inFlight.keys().next().value
  if (active !== undefined) settle(active, { error: message })
}

/**
 * The live host registers its dispatcher once its page is ready; jobs flow
 * one at a time from here. Returns an unregister for unmount.
 */
export function registerChartHost(send: (job: ChartSnapshotJob) => void): () => void {
  sender = send
  pump()
  return () => {
    if (sender === send) sender = null
  }
}

/**
 * The host's WebView process died. Re-queue the in-flight job (it never
 * completed) unless the process keeps dying — two strikes and everything
 * drains rejected so cards fall back instead of spinning forever.
 */
export function chartHostCrashed(): void {
  sender = null
  crashes += 1
  const active = [...inFlight.values()]
  inFlight.clear()
  if (crashes >= 2) {
    crashes = 0
    waiting.unshift(...active)
    failAllChartWork('chart renderer unavailable')
    return
  }
  waiting.unshift(...active)
}

/** Drain everything rejected — the renderer cannot run at all right now. */
export function failAllChartWork(message: string): void {
  sender = null
  const doomed = [...inFlight.values(), ...waiting.splice(0)]
  inFlight.clear()
  for (const entry of doomed) {
    clearTimeout(entry.timer)
    entry.reject(new Error(message))
  }
}

/** True when jobs are waiting — the host mounts on demand, not at startup. */
export function hasChartWork(): boolean {
  return waiting.length > 0 || inFlight.size > 0
}

/** ChartSnapshotHost listens here to learn it is needed. One listener. */
export function onChartDemand(listener: () => void): () => void {
  demandListener = listener
  if (hasChartWork()) listener()
  return () => {
    if (demandListener === listener) demandListener = null
  }
}
