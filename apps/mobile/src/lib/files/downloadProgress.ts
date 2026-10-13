import { useCallback, useSyncExternalStore } from 'react'

/**
 * Live byte counts for the workspace downloads currently in flight, keyed by
 * the workspace-relative path being fetched.
 *
 * The file cache is the only writer, and it wraps every download it makes —
 * bytes pulled from the desktop over the tunnel and bytes pulled from the CDN
 * alike — so one store covers every file a conversation can produce. Cards
 * subscribe by path (useDownloadProgress) and render the transfer itself
 * instead of an indeterminate spinner.
 *
 * Deliberately not zustand: this updates far faster than app state should, and
 * the per-path subscription means a feed of ten cards wakes only the one card
 * whose file moved.
 */

export type DownloadProgress = {
  /** Bytes written so far. */
  receivedBytes: number
  /** Total the source promised; 0 when it didn't say (no Content-Length). */
  totalBytes: number
}

/**
 * Native progress callbacks fire per packet — hundreds a second on a fast
 * link, and every one of them would be a React render. The store always holds
 * the latest count; it only wakes subscribers this often.
 */
const EMIT_INTERVAL_MS = 100

const inFlight = new Map<string, DownloadProgress>()
const listeners = new Map<string, Set<() => void>>()
const lastEmitAt = new Map<string, number>()

function emit(relPath: string): void {
  const subscribed = listeners.get(relPath)
  if (!subscribed) return
  for (const listener of subscribed) listener()
}

/** Register a download before its first byte, so cards can show it starting. */
export function beginDownload(relPath: string): void {
  inFlight.set(relPath, { receivedBytes: 0, totalBytes: 0 })
  lastEmitAt.delete(relPath)
  emit(relPath)
}

/**
 * Record how far a download has got. `totalBytes` may be 0 or negative when
 * the source gave no size — the last known total is kept in that case, so one
 * silent callback doesn't erase a total an earlier one supplied.
 */
export function reportDownload(relPath: string, receivedBytes: number, totalBytes: number): void {
  const previous = inFlight.get(relPath)
  // Not started, or already finished: a late callback must not resurrect a
  // download whose card has moved on.
  if (!previous) return

  const total = totalBytes > 0 ? totalBytes : previous.totalBytes
  const received = Math.max(receivedBytes, 0)
  if (received === previous.receivedBytes && total === previous.totalBytes) return
  // A new object every time: useSyncExternalStore compares snapshots by
  // identity, so mutating this one in place would never re-render.
  inFlight.set(relPath, { receivedBytes: received, totalBytes: total })

  const now = Date.now()
  const last = lastEmitAt.get(relPath)
  // Always publish the first update (it carries the total the bar sizes
  // itself from) and the completion; throttle everything between.
  const notable = last === undefined || (total > 0 && received >= total)
  if (!notable && now - last < EMIT_INTERVAL_MS) return
  lastEmitAt.set(relPath, now)
  emit(relPath)
}

/** Clear a download, whether it landed or failed. Safe to call twice. */
export function endDownload(relPath: string): void {
  if (!inFlight.delete(relPath)) return
  lastEmitAt.delete(relPath)
  emit(relPath)
}

/**
 * A path's current transfer, or null when nothing is downloading it — either
 * the bytes are already here or the fetch hasn't started yet, and a card
 * treats both as "waiting".
 */
export function getDownload(relPath: string): DownloadProgress | null {
  return inFlight.get(relPath) ?? null
}

/** Watch one path. Returns the unsubscribe. */
export function subscribeDownload(relPath: string, listener: () => void): () => void {
  const subscribed = listeners.get(relPath) ?? new Set<() => void>()
  subscribed.add(listener)
  listeners.set(relPath, subscribed)
  return () => {
    subscribed.delete(listener)
    if (subscribed.size === 0) listeners.delete(relPath)
  }
}

/** The store as a React hook — the subscribe/snapshot pair above, bound. */
export function useDownloadProgress(relPath: string | null): DownloadProgress | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) => (relPath ? subscribeDownload(relPath, onStoreChange) : () => {}),
    [relPath]
  )
  const snapshot = useCallback(() => (relPath ? getDownload(relPath) : null), [relPath])
  return useSyncExternalStore(subscribe, snapshot)
}
