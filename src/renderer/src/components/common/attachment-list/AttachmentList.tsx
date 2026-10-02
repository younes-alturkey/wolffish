import { AudioPlayer } from '@components/common/audio-player/AudioPlayer'
import { ChartCard } from '@components/common/chart-card/ChartCard'
import { FileCard } from '@components/common/file-card/FileCard'
import { DocxViewer } from '@components/common/docx-viewer/DocxViewer'
import { HtmlFileViewer } from '@components/common/html-file-viewer/HtmlFileViewer'
import { PresentationViewer } from '@components/common/presentation-viewer/PresentationViewer'
import { ImageViewer } from '@components/common/image-viewer/ImageViewer'
import { MarkdownFileViewer } from '@components/common/markdown-file-viewer/MarkdownFileViewer'
import { PdfViewer } from '@components/common/pdf-viewer/PdfViewer'
import { SpreadsheetViewer } from '@components/common/spreadsheet-viewer/SpreadsheetViewer'
import { VideoPlayer } from '@components/common/video-player/VideoPlayer'
import { cn } from '@lib/utils/cn'
import type { MessageAttachment } from '@preload/index'
import { Fragment, useEffect, useState } from 'react'

export type AttachmentListProps = {
  attachments: MessageAttachment[]
  /**
   * Alignment of each attachment card within the parent flex column.
   * Defaults to 'start' (assistant-side rendering); pass 'end' under
   * user bubbles so cards line up against the right edge instead of
   * inheriting the renderer components' built-in self-start.
   * Only applies to the default 'list' variant.
   */
  align?: 'start' | 'end'
  /**
   * 'list' (default) — a single column at chat-bubble width (each viewer's
   * built-in max-w-[85%]), used under message bubbles. 'grid' — a full-width
   * CSS-columns masonry that lets tiles of different heights (image / audio /
   * video / pdf) pack naturally with no single-column dead space; used by the
   * conversation files dialog.
   */
  variant?: 'list' | 'grid'
}

/**
 * Render each attachment with the type-appropriate renderer. Existence is
 * checked in parallel via IPC at mount time so a chat message that
 * references a since-deleted file shows the per-type "deleted" state
 * instead of a broken player. When a check is in flight the renderer is
 * told `fileExists=true` — the underlying components fall back to a
 * "deleted" state on read failure anyway, so the user never sees a
 * broken-load flash.
 */
export function AttachmentList({
  attachments,
  align = 'start',
  variant = 'list'
}: AttachmentListProps): React.JSX.Element | null {
  const existence = useExistenceMap(attachments)
  if (attachments.length === 0) return null

  if (variant === 'grid') {
    return (
      // CSS multi-column masonry: tiles flow into as many ~26rem columns as
      // fit and keep their natural height, so a short audio card sits beside a
      // tall image without the single-column dead space. The per-tile wrapper
      // neutralizes each viewer's built-in max-w-[85%]/self-start so tiles fill
      // their column edge to edge (break-inside-avoid keeps a tile whole).
      <div className="columns-[26rem] gap-4">
        {attachments.map((att, idx) => (
          <div
            key={`${att.filePath}-${idx}`}
            className="mb-4 break-inside-avoid *:w-full *:max-w-none!"
          >
            {renderViewer(att, existence[att.filePath] ?? true)}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div
      className={cn(
        // w-full lets each renderer's `w-full max-w-[85%]` resolve against
        // the parent bubble's full width instead of the AttachmentList's
        // intrinsic content width — without this, the audio/video players
        // collapse to the size of their controls.
        'flex w-full flex-col gap-2',
        align === 'end' ? 'items-end *:self-end' : 'items-start *:self-start'
      )}
    >
      {attachments.map((att, idx) => (
        <Fragment key={`${att.filePath}-${idx}`}>
          {renderViewer(att, existence[att.filePath] ?? true)}
        </Fragment>
      ))}
    </div>
  )
}

/** Dispatch one attachment to its type-appropriate viewer (no key — the caller
 *  owns keying so the same dispatch serves both the list and grid variants). */
function renderViewer(att: MessageAttachment, exists: boolean): React.JSX.Element {
  if (att.type === 'audio') {
    return (
      <AudioPlayer
        filePath={att.filePath}
        fileExists={exists}
        mimeType={att.mimeType}
        fileName={att.originalName}
      />
    )
  }
  if (att.type === 'video') {
    return (
      <VideoPlayer
        filePath={att.filePath}
        fileExists={exists}
        mimeType={att.mimeType}
        fileName={att.originalName}
      />
    )
  }
  if (att.type === 'image') {
    return (
      <ImageViewer
        filePath={att.filePath}
        fileExists={exists}
        mimeType={att.mimeType}
        fileName={att.originalName}
        width={att.width}
        height={att.height}
      />
    )
  }
  if (att.type === 'pdf') {
    return (
      <PdfViewer
        filePath={att.filePath}
        fileExists={exists}
        fileName={att.originalName}
        sizeBytes={att.sizeBytes}
      />
    )
  }
  if (isChartAttachment(att)) {
    return (
      <ChartCard
        filePath={att.filePath}
        fileExists={exists}
        fileName={att.originalName}
        sizeBytes={att.sizeBytes}
        mimeType={att.mimeType}
      />
    )
  }
  if (isPresentationAttachment(att)) {
    return (
      <PresentationViewer
        filePath={att.filePath}
        fileExists={exists}
        fileName={att.originalName}
        sizeBytes={att.sizeBytes}
      />
    )
  }
  if (isDocumentAttachment(att)) {
    return (
      <DocxViewer
        filePath={att.filePath}
        fileExists={exists}
        fileName={att.originalName}
        sizeBytes={att.sizeBytes}
      />
    )
  }
  // Before the plain-text check: a .csv often arrives typed text/plain, and it
  // belongs in the grid rather than the markdown viewer.
  if (isSpreadsheetAttachment(att)) {
    return (
      <SpreadsheetViewer
        filePath={att.filePath}
        fileExists={exists}
        fileName={att.originalName}
        sizeBytes={att.sizeBytes}
      />
    )
  }
  if (isMarkdownAttachment(att) || isPlainTextAttachment(att)) {
    return (
      <MarkdownFileViewer
        filePath={att.filePath}
        fileExists={exists}
        fileName={att.originalName}
        sizeBytes={att.sizeBytes}
        mimeType={att.mimeType}
      />
    )
  }
  if (isHtmlAttachment(att)) {
    return (
      <HtmlFileViewer
        filePath={att.filePath}
        fileExists={exists}
        fileName={att.originalName}
        sizeBytes={att.sizeBytes}
        mimeType={att.mimeType}
      />
    )
  }
  return (
    <FileCard
      filePath={att.filePath}
      fileExists={exists}
      fileName={att.originalName}
      sizeBytes={att.sizeBytes}
      mimeType={att.mimeType}
    />
  )
}

function isChartAttachment(att: MessageAttachment): boolean {
  // The full `.chart.json` suffix — not the mime type — is the chart-card
  // contract; a plain .json stays a generic file.
  return /\.chart\.json$/i.test(att.originalName)
}

/** Uploaded Office files arrive typed `other`, so the extension is the only
 *  signal — the same one the delivered-file dispatcher in Chat.tsx uses.
 *  Legacy binary .ppt/.doc are deliberately absent: neither renderer reads
 *  them, and they stay plain file cards. */
function isPresentationAttachment(att: MessageAttachment): boolean {
  return /\.(pptx|potx)$/i.test(att.originalName)
}

function isDocumentAttachment(att: MessageAttachment): boolean {
  return /\.docx$/i.test(att.originalName)
}

/** Legacy binary .xls reads for values only, but it still reads — unlike .doc
 *  and .ppt, which stay plain file cards. */
function isSpreadsheetAttachment(att: MessageAttachment): boolean {
  return /\.(xlsx|xlsm|xltx|xls|csv)$/i.test(att.originalName)
}

function isMarkdownAttachment(att: MessageAttachment): boolean {
  return att.mimeType === 'text/markdown' || /\.(md|mdx|markdown)$/i.test(att.originalName)
}

function isPlainTextAttachment(att: MessageAttachment): boolean {
  return att.mimeType === 'text/plain' || /\.txt$/i.test(att.originalName)
}

function isHtmlAttachment(att: MessageAttachment): boolean {
  return att.mimeType === 'text/html' || /\.(html|htm)$/i.test(att.originalName)
}

function useExistenceMap(attachments: MessageAttachment[]): Record<string, boolean> {
  const [map, setMap] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let cancelled = false
    const paths = attachments.map((a) => a.filePath)
    if (paths.length === 0) return

    void (async () => {
      const results = await Promise.all(
        paths.map((p) => window.api.upload.exists(p).catch(() => false))
      )
      if (cancelled) return
      const next: Record<string, boolean> = {}
      paths.forEach((p, i) => {
        next[p] = results[i]
      })
      setMap(next)
    })()

    return () => {
      cancelled = true
    }
    // attachments identity changes per render but file paths are stable for
    // a given message — depending on a stringified key avoids needless
    // refetches without forcing the parent to memoize the array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachments.map((a) => a.filePath).join('|')])

  return map
}
