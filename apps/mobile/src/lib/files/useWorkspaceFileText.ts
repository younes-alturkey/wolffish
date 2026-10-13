import { File } from 'expo-file-system'
import { useEffect, useMemo, useState } from 'react'
import { resolveWorkspaceFile, statCachedFile } from '@/lib/files/fileCache'
import { useFileRetry } from '@/lib/files/useFileRetry'

/**
 * Read a workspace file's text through the file cache, with the desktop's
 * 512 KB inline guard (MarkdownFileViewer/HtmlFileViewer MAX_INLINE_BYTES):
 * past that the caller falls back to a plain file card instead of pulling
 * megabytes of text into the JS heap.
 */
export const MAX_INLINE_TEXT_BYTES = 512 * 1024

export type WorkspaceTextState = {
  /** Local file URI once cached; null while loading or when missing. */
  uri: string | null
  /** File body; null while loading, when missing, or when oversized. */
  text: string | null
  sizeBytes: number
  loading: boolean
  missing: boolean
  oversized: boolean
}

const INITIAL: WorkspaceTextState = {
  uri: null,
  text: null,
  sizeBytes: 0,
  loading: true,
  missing: false,
  oversized: false
}

/**
 * The body of a file already on disk, read during render. Text viewers size
 * themselves from their content (a two-line file gets a two-line card), so
 * reading a beat later would mount the card at one height and resize it at
 * another — see useWorkspaceFile for why that is the jump we are removing.
 *
 * Reading synchronously is only safe because the same size guard the async
 * path applies runs first: nothing above MAX_INLINE_TEXT_BYTES is ever read,
 * here or there.
 */
function readCached(relPath: string, maxBytes: number): WorkspaceTextState | null {
  const stat = statCachedFile(relPath)
  if (!stat) return null
  if (stat.sizeBytes > maxBytes) {
    return { ...INITIAL, uri: stat.uri, sizeBytes: stat.sizeBytes, loading: false, oversized: true }
  }
  try {
    return {
      uri: stat.uri,
      text: new File(stat.uri).textSync(),
      sizeBytes: stat.sizeBytes,
      loading: false,
      missing: false,
      oversized: false
    }
  } catch {
    // Unreadable (binary behind a text extension, a race with cache pruning) —
    // the caller degrades to the plain file card, exactly as it does when the
    // async read below throws.
    return { ...INITIAL, uri: stat.uri, loading: false, missing: true }
  }
}

export function useWorkspaceFileText(
  relPath: string | null,
  conversationId?: string,
  maxBytes: number = MAX_INLINE_TEXT_BYTES
): WorkspaceTextState {
  const cached = useMemo(
    () => (relPath ? readCached(relPath, maxBytes) : null),
    [relPath, maxBytes]
  )
  // Tagged with its path — see the same note in useWorkspaceFile.
  const [fetched, setFetched] = useState<{ path: string; state: WorkspaceTextState } | null>(null)
  const { nonce, scheduleRetry, settle: settleRetry } = useFileRetry(relPath)

  useEffect(() => {
    if (!relPath || cached) return
    let alive = true

    void (async () => {
      const settle = (state: WorkspaceTextState): void => {
        if (alive) setFetched({ path: relPath, state })
      }
      const resolved = await resolveWorkspaceFile(relPath, conversationId)
      if (!alive) return
      if (!resolved.uri) {
        if (!resolved.missing) {
          // Transient — keep the loading card and let the retry cadence
          // re-run this effect; `missing` is reserved for a source that
          // answered "not here". See useWorkspaceFile.
          scheduleRetry()
          return
        }
        settleRetry()
        settle({ ...INITIAL, loading: false, missing: true })
        return
      }
      settleRetry()
      const uri = resolved.uri
      try {
        const file = new File(uri)
        const sizeBytes = file.size ?? 0
        if (sizeBytes > maxBytes) {
          settle({ uri, text: null, sizeBytes, loading: false, missing: false, oversized: true })
          return
        }
        const text = await file.text()
        settle({ uri, text, sizeBytes, loading: false, missing: false, oversized: false })
      } catch {
        // Unreadable (binary with a text extension, permissions, a race with
        // cache pruning) — the caller degrades to the plain file card.
        settle({ ...INITIAL, uri, loading: false, missing: true })
      }
    })()

    return () => {
      alive = false
    }
  }, [relPath, conversationId, maxBytes, cached, nonce, scheduleRetry, settleRetry])

  if (!relPath) return { ...INITIAL, loading: false }
  if (cached) return cached
  return fetched?.path === relPath ? fetched.state : INITIAL
}
