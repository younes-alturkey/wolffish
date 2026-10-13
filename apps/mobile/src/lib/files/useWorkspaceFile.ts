import { useEffect, useMemo, useState } from 'react'
import { resolveWorkspaceFile, statCachedFile } from '@/lib/files/fileCache'
import { useFileRetry } from '@/lib/files/useFileRetry'

export type WorkspaceFileState = {
  /** Local file URI once cached; null while loading or when missing. */
  uri: string | null
  /** Size of the cached file, 0 when unknown — cards fall back to this when
   *  the sender didn't record one (delivered files carry no metadata). */
  sizeBytes: number
  loading: boolean
  missing: boolean
}

const PENDING: WorkspaceFileState = { uri: null, sizeBytes: 0, loading: true, missing: false }
const ABSENT: WorkspaceFileState = { uri: null, sizeBytes: 0, loading: false, missing: false }

/**
 * Resolve a workspace-relative media path through the file cache. The first
 * view of a file copies it out of the demo source (or downloads it from the
 * desktop) — subsequent views hit the cache instantly.
 *
 * "Instantly" is load-bearing, not a nicety: a file already on disk resolves
 * during render, so its card mounts at full size in the same frame as the rest
 * of the message. Going through the effect instead would mount a placeholder
 * first and grow a frame later, which shifts every message below it and pulls
 * the feed's scroll position with it — the jump this hook exists to avoid.
 *
 * `missing` is reserved for a source that ANSWERED "this file does not exist".
 * A resolve that merely failed — the tunnel mid-reconnect, a transfer timed
 * out behind a busy sync pass — keeps the loading state and retries on the
 * useFileRetry cadence instead. Pinning those failures as missing was the
 * "file was deleted or unavailable" that only a restart cleared.
 */
export function useWorkspaceFile(
  relPath: string | null,
  conversationId?: string
): WorkspaceFileState {
  // A stat, not a read — see statCachedFile. Re-run only when the path
  // changes, so a re-render never re-hits the filesystem.
  const cached = useMemo(() => (relPath ? statCachedFile(relPath) : null), [relPath])
  // Tagged with the path it answers for: the reset below lands after the
  // render that changed `relPath`, so an untagged result would show the
  // previous file for one frame.
  const [fetched, setFetched] = useState<{ path: string; state: WorkspaceFileState } | null>(null)
  const retry = useFileRetry(relPath)

  const { nonce, scheduleRetry, settle } = retry
  useEffect(() => {
    // Already on disk, or nothing asked for: no fetch, and nothing to reset —
    // the render-time value below is the whole answer.
    if (!relPath || cached) return
    let alive = true
    void resolveWorkspaceFile(relPath, conversationId).then((resolved) => {
      if (!alive) return
      if (!resolved.uri && !resolved.missing) {
        // Transient — the loading card stands (PENDING is already what
        // renders while `fetched` holds no terminal answer for this path)
        // and the retry cadence re-runs this effect via `nonce`.
        scheduleRetry()
        return
      }
      settle()
      const stat = resolved.uri ? statCachedFile(relPath) : null
      setFetched({
        path: relPath,
        state: {
          uri: resolved.uri,
          sizeBytes: stat?.sizeBytes ?? 0,
          loading: false,
          missing: resolved.missing
        }
      })
    })
    return () => {
      alive = false
    }
  }, [relPath, conversationId, cached, nonce, scheduleRetry, settle])

  if (!relPath) return ABSENT
  if (cached)
    return { uri: cached.uri, sizeBytes: cached.sizeBytes, loading: false, missing: false }
  return fetched?.path === relPath ? fetched.state : PENDING
}
