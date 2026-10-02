import { CodeFileViewer } from '@components/common/code-file-viewer/CodeFileViewer'
import { FileCard } from '@components/common/file-card/FileCard'
import { useUploadText } from '@hooks/use-upload-text/useUploadText'
import { useCallback, useEffect, useState } from 'react'

export type MarkdownFileViewerProps = {
  filePath: string
  fileExists: boolean
  fileName: string
  /** Byte size, or 0 when unknown (tool-delivered files) — resolved via IPC. */
  sizeBytes: number
  mimeType: string
}

/**
 * Inline renderer for markdown and plain-text attachments (README.md, .txt
 * and friends). Loads the file text over the upload IPC channel and reuses
 * the CodeFileViewer card so attached readmes look identical to tool-result
 * ones: rendered markdown (or line-numbered plain text, keyed off the file
 * extension) in a max-height scrollable block with copy and download in the
 * footer. Falls back to the plain FileCard while loading, on read failure,
 * or for files too large to render inline.
 */
const MAX_INLINE_BYTES = 512 * 1024

export function MarkdownFileViewer({
  filePath,
  fileExists,
  fileName,
  sizeBytes,
  mimeType
}: MarkdownFileViewerProps): React.JSX.Element {
  // Attachments pass a real size; tool-delivered files pass 0 (unknown). In the
  // unknown case we stat the file over IPC so the oversize guard below still
  // applies (without it a multi-MB generated .md would be read fully into the
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
  const oversized = sizeKnown && resolvedSize > MAX_INLINE_BYTES
  const { text, error } = useUploadText(fileExists && sizeKnown && !oversized ? filePath : null)

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

  if (text === null) {
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
      content={text}
      fileName={fileName}
      sizeBytes={resolvedSize || undefined}
      onDownload={download}
      onReveal={revealInFolder}
    />
  )
}
