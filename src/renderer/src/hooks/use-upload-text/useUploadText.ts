import { useEffect, useState } from 'react'

type LoadedText = { forPath: string; text: string | null; error: boolean }

/**
 * Fetch an uploaded file's bytes through the upload IPC channel and decode
 * them as UTF-8 text. Companion to `useUploadBlob` for renderers that show
 * the file's content inline (markdown attachments) instead of feeding a
 * media element.
 *
 * Pass `null` to skip loading (file missing or too large to render inline).
 *
 * Returns `{ text, error }`. While loading, both are null/false. On failure
 * `error` is true and the caller should fall back to a non-inline card.
 */
export function useUploadText(filePath: string | null): { text: string | null; error: boolean } {
  const [loaded, setLoaded] = useState<LoadedText | null>(null)

  useEffect(() => {
    if (!filePath) return

    let cancelled = false
    void (async () => {
      try {
        const buffer = await window.api.upload.readFile(filePath)
        if (!buffer) throw new Error(`missing upload: ${filePath}`)
        if (cancelled) return
        setLoaded({ forPath: filePath, text: new TextDecoder().decode(buffer), error: false })
      } catch {
        if (!cancelled) setLoaded({ forPath: filePath, text: null, error: true })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [filePath])

  // A result for a different path is stale — report "still loading" instead.
  if (!filePath || loaded?.forPath !== filePath) return { text: null, error: false }
  return { text: loaded.text, error: loaded.error }
}
