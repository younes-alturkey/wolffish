import { isWeb } from '@lib/utils/platform'
import { useEffect, useState } from 'react'

/**
 * A URL the renderer can feed to `<img>`, `<audio>`, `<video>`, `<iframe>`
 * for an uploaded file.
 *
 * Desktop: the bytes come through the upload IPC channel and are wrapped
 * in an object URL — the Blob-URL pattern voice memos use, which keeps the
 * URL scoped to the renderer's lifetime, avoids registering a custom
 * Electron protocol, and gives every media element a stable string source
 * across re-renders.
 *
 * Web: the server's own file route, which streams the file with Range
 * support and lets the browser cache it. Nothing is read into memory, so a
 * 260 MB PDF costs a phone nothing until its viewer asks for pages — and
 * nothing that size ever crosses the socket.
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

    // The read can lose a race with the file still being written — e.g. a
    // screenshot the agent just captured but hasn't flushed to disk yet.
    // A single failure used to latch the "deleted" placeholder forever, so
    // retry a few times before giving up; the bytes normally land within a
    // few hundred ms. A genuinely missing file still ends in the error state.
    const resolve = async (): Promise<string> => {
      if (isWeb) {
        const href = await window.api.upload.fileUrl(filePath)
        if (!href) throw new Error(`missing upload: ${filePath}`)
        const head = await fetch(href, { method: 'HEAD', credentials: 'same-origin' })
        if (!head.ok) throw new Error(`${href}: ${head.status}`)
        return href
      }
      const buffer = await window.api.upload.readFile(filePath)
      if (!buffer) throw new Error(`missing upload: ${filePath}`)
      const objectUrl = URL.createObjectURL(new Blob([buffer], { type: mimeType }))
      revoke = objectUrl
      return objectUrl
    }

    void (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const next = await resolve()
          if (cancelled) return
          setUrl(next)
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
