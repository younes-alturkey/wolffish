import { useEffect, useState } from 'react'

/**
 * Fetch an uploaded file's bytes through the upload IPC channel and wrap
 * them in an object URL the renderer can feed to `<img>`, `<audio>`,
 * `<video>` etc. Mirrors the Blob-URL pattern voice memos use — keeps the
 * URL scoped to the renderer's lifetime, avoids registering a custom
 * Electron protocol, and gives every media element a stable string source
 * across re-renders.
 *
 * Pass `mimeType` so the Blob carries the right content-type for the
 * underlying decoder (Safari's quicktime decoder is MIME-strict; HEIC
 * preview also requires the right hint).
 *
 * Returns `{ url, error }`. While loading, both are null. On failure
 * `error` is true and the caller should render a "deleted" placeholder.
 */
export function useUploadBlob(
  filePath: string,
  mimeType: string
): { url: string | null; error: boolean } {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    let revoke: string | null = null

    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

    void (async () => {
      // The read can lose a race with the file still being written — e.g. a
      // screenshot the agent just captured but hasn't flushed to disk yet.
      // A single failure used to latch the "deleted" placeholder forever, so
      // retry a few times before giving up; the bytes normally land within a
      // few hundred ms. A genuinely missing file still ends in the error state.
      for (let attempt = 0; ; attempt++) {
        try {
          const buffer = await window.api.upload.readFile(filePath)
          if (!buffer) throw new Error(`missing upload: ${filePath}`)
          if (cancelled) return
          const blob = new Blob([buffer], { type: mimeType })
          const objectUrl = URL.createObjectURL(blob)
          revoke = objectUrl
          setUrl(objectUrl)
          setError(false)
          return
        } catch {
          if (cancelled) return
          if (attempt >= 3) {
            setUrl(null)
            setError(true)
            return
          }
          await sleep(200)
        }
      }
    })()

    return () => {
      cancelled = true
      if (revoke) URL.revokeObjectURL(revoke)
    }
  }, [filePath, mimeType])

  return { url, error }
}
