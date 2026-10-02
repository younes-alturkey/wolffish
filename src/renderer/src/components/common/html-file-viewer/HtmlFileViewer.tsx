import { CodeFileViewer } from '@components/common/code-file-viewer/CodeFileViewer'
import { FileCard } from '@components/common/file-card/FileCard'
import { useUploadText } from '@hooks/use-upload-text/useUploadText'
import { useCallback, useEffect, useState } from 'react'

export type HtmlFileViewerProps = {
  filePath: string
  fileExists: boolean
  fileName: string
  /** Byte size, or 0 when unknown (tool-delivered files) — resolved via IPC. */
  sizeBytes: number
  mimeType: string
}

/**
 * Inline renderer for HTML attachments and generated .html files. Reuses the
 * CodeFileViewer card with `htmlPreview`: the Preview view is a <webview>
 * guest loading the file from disk by its file: URL (scripts, canvas,
 * keyboard, audio — the page as a browser shows it), the Source view is the
 * highlighted markup read over the upload IPC channel. The size gate below
 * only applies to that Source read — the guest streams a file of any size —
 * so an oversized page still previews and its Source view says why it is
 * empty. Falls back to the plain FileCard while resolving, on failure, or
 * when the file is gone.
 */
const MAX_SOURCE_BYTES = 512 * 1024

export function HtmlFileViewer({
  filePath,
  fileExists,
  fileName,
  sizeBytes,
  mimeType
}: HtmlFileViewerProps): React.JSX.Element {
  // Attachments pass a real size; tool-delivered files pass 0 (unknown). In the
  // unknown case we stat the file over IPC so the oversize guard below still
  // applies (without it a multi-MB generated .html would be read fully into the
  // renderer) and the footer shows the true size instead of "0 B".
  const [resolvedSize, setResolvedSize] = useState<number | null>(sizeBytes > 0 ? sizeBytes : null)
  useEffect(() => {
    if (sizeBytes > 0 || !fileExists) return
    let cancelled = false
    window.api.upload
      .getMetadata(filePath)
      .then((meta) => {
        if (!cancelled) setResolvedSize(meta?.sizeBytes ?? 0)
      })
      .catch(() => {
        if (!cancelled) setResolvedSize(0)
      })
    return () => {
      cancelled = true
    }
  }, [filePath, sizeBytes, fileExists])

  const sizeKnown = resolvedSize !== null
  const oversized = sizeKnown && resolvedSize > MAX_SOURCE_BYTES
  const { text, error } = useUploadText(fileExists && sizeKnown && !oversized ? filePath : null)

  // The file: URL the live preview guest loads. Resolved in main so the path
  // stays workspace-scoped; null means the path was refused.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!fileExists) return
    let cancelled = false
    window.api.upload
      .fileUrl(filePath)
      .then((url) => {
        if (!cancelled) setPreviewUrl(url)
      })
      .catch(() => {
        if (!cancelled) setPreviewUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [filePath, fileExists])

  const download = useCallback(() => {
    window.api.upload.download(filePath).catch(() => {
      // best-effort
    })
  }, [filePath])

  const revealInFolder = useCallback(() => {
    window.api.upload.revealInFolder(filePath).catch(() => {
      // best-effort
    })
  }, [filePath])

  // Hand the .html to the OS, which opens it in the default browser — the same
  // live page in a full window.
  const openExternal = useCallback(() => {
    window.api.upload.openExternal(filePath).catch(() => {
      // best-effort
    })
  }, [filePath])

  // Ready once the source is in hand, or once we know it never will be (too
  // large) — either way the preview needs only the URL.
  const ready = previewUrl !== null && (text !== null || oversized)
  if (!ready) {
    return (
      <FileCard
        filePath={filePath}
        fileExists={fileExists && !error}
        fileName={fileName}
        sizeBytes={resolvedSize ?? sizeBytes}
        mimeType={mimeType}
      />
    )
  }

  return (
    <CodeFileViewer
      content={text ?? ''}
      fileName={fileName}
      language="html"
      htmlPreview
      previewUrl={previewUrl}
      sourceUnavailable={oversized}
      sizeBytes={resolvedSize || undefined}
      onDownload={download}
      onReveal={revealInFolder}
      onOpenExternal={openExternal}
    />
  )
}
