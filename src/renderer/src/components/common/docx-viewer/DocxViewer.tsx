import { FileCard } from '@components/common/file-card/FileCard'
import { useDocxPages } from '@components/common/docx-viewer/useDocxPages'
import { FileViewerShell } from '@components/common/file-viewer-shell/FileViewerShell'
import { ViewerPager } from '@components/common/file-viewer-shell/ViewerPager'
import { cn } from '@lib/utils/cn'
import { File01Icon } from 'hugeicons-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export type DocxViewerProps = {
  filePath: string
  fileExists: boolean
  fileName: string
  sizeBytes: number
}

/**
 * A .docx as pages. docx-preview lays the file out with its real page size,
 * margins, styles, tables and images, so the card shows the document rather
 * than the flattened HTML the old mammoth render produced.
 *
 * The card and the expanded sheet each paint their own copy: a document is
 * flowing HTML, not the megabytes-per-slide a deck is, and one live copy per
 * visible surface is simpler than moving nodes between them.
 *
 * Pages are scrolled, not paged — the only overlay is a chip saying which page
 * you are on. The page is scaled to fill the surface edge to edge, so the
 * viewer width is the page width; content that is wider than its own page
 * still scrolls, because shrinking the whole document to hide that would
 * misrepresent it.
 */
export function DocxViewer({
  filePath,
  fileExists,
  fileName,
  sizeBytes
}: DocxViewerProps): React.JSX.Element {
  if (!fileExists) {
    return (
      <FileCard
        filePath={filePath}
        fileExists={false}
        fileName={fileName}
        sizeBytes={sizeBytes}
        mimeType={DOCX_MIME}
      />
    )
  }
  return <ActiveDocument filePath={filePath} fileName={fileName} sizeBytes={sizeBytes} />
}

function ActiveDocument({
  filePath,
  fileName,
  sizeBytes
}: {
  filePath: string
  fileName: string
  sizeBytes: number
}): React.JSX.Element {
  const [failed, setFailed] = useState(false)

  // A document that won't parse falls back to the plain file card — what a
  // .docx showed before any of this, and it keeps every file action.
  if (failed) {
    return (
      <FileCard
        filePath={filePath}
        fileExists={true}
        fileName={fileName}
        sizeBytes={sizeBytes}
        mimeType={DOCX_MIME}
      />
    )
  }

  return (
    <FileViewerShell
      filePath={filePath}
      fileName={fileName}
      icon={<File01Icon size={14} className="text-muted shrink-0" />}
      expanded={<DocxSurface filePath={filePath} expanded />}
    >
      <DocxSurface filePath={filePath} onFailed={() => setFailed(true)} />
    </FileViewerShell>
  )
}

function DocxSurface({
  filePath,
  expanded = false,
  onFailed
}: {
  filePath: string
  expanded?: boolean
  onFailed?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // The card fits the page and stops there; the expanded sheet is for reading,
  // so it fills its width — capped so a very wide monitor does not render the
  // page at three times size.
  const { status, page, pageCount, hostRef, scrollRef } = useDocxPages(filePath, {
    maxZoom: expanded ? 2 : 1
  })

  useEffect(() => {
    if (status === 'failed') onFailed?.()
  }, [status, onFailed])

  return (
    <div
      className={cn(
        // `relative` anchors the position chip, which floats above the
        // scroller rather than living inside it — otherwise it would scroll
        // away with the document.
        'relative flex min-h-0 w-full flex-col',
        expanded && 'h-full'
      )}
    >
      <div
        ref={scrollRef}
        // No padding: the page is painted edge to edge, so the viewer width IS
        // the page width. The tint only shows while the document is loading.
        className={cn('bg-muted/10 min-h-0 overflow-auto', expanded ? 'flex-1' : 'max-h-100')}
      >
        {status !== 'ready' && (
          <div className="flex h-50 w-full items-center justify-center">
            <span className="text-muted animate-pulse text-xs">{t('chat.docxViewer.loading')}</span>
          </div>
        )}
        {/* docx-preview owns everything under here — React never reconciles
            it, so the library is free to replace the whole subtree. */}
        <div ref={hostRef} className="docx-surface" hidden={status !== 'ready'} />
      </div>
      {status === 'ready' && pageCount > 1 && (
        <ViewerPager
          index={page}
          count={pageCount}
          label={t('chat.docxViewer.pageOf', { index: page + 1, count: pageCount })}
        />
      )}
    </div>
  )
}
