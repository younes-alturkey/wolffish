import { FileCard } from '@components/common/file-card/FileCard'
import { FileViewerShell } from '@components/common/file-viewer-shell/FileViewerShell'
import { ViewerPager } from '@components/common/file-viewer-shell/ViewerPager'
import { useDeckSlides } from '@components/common/presentation-viewer/useDeckSlides'
import { PresentationBarChart01Icon } from 'hugeicons-react'
import { useTranslation } from 'react-i18next'

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

export type PresentationViewerProps = {
  filePath: string
  fileExists: boolean
  fileName: string
  sizeBytes: number
}

/**
 * A .pptx/.potx as the slides themselves. Main renders every slide to an SVG
 * inside the workspace (see deck-preview.ts) and this pages through them —
 * one card with chevrons, and the whole deck again at full size in the sheet.
 *
 * The slide is an <img>, not inline markup: the renderer never has to trust a
 * stranger's deck, and two slides can't collide over an SVG gradient id.
 *
 * A deck that won't parse — legacy binary .ppt, encrypted, truncated — falls
 * back to the plain file card, which is what it showed before this existed.
 */
export function PresentationViewer({
  filePath,
  fileExists,
  fileName,
  sizeBytes
}: PresentationViewerProps): React.JSX.Element {
  if (!fileExists) {
    return (
      <FileCard
        filePath={filePath}
        fileExists={false}
        fileName={fileName}
        sizeBytes={sizeBytes}
        mimeType={PPTX_MIME}
      />
    )
  }
  return <ActiveDeck filePath={filePath} fileName={fileName} sizeBytes={sizeBytes} />
}

function ActiveDeck({
  filePath,
  fileName,
  sizeBytes
}: {
  filePath: string
  fileName: string
  sizeBytes: number
}): React.JSX.Element {
  const { t } = useTranslation()
  const { status, preview, index, setIndex, url } = useDeckSlides(filePath)

  if (status === 'failed') {
    return (
      <FileCard
        filePath={filePath}
        fileExists={true}
        fileName={fileName}
        sizeBytes={sizeBytes}
        mimeType={PPTX_MIME}
      />
    )
  }

  const count = preview?.slides.length ?? 0
  const aspect = preview ? `${preview.width} / ${preview.height}` : '16 / 9'

  const pager = count > 1 && (
    <ViewerPager
      index={index}
      count={count}
      onChange={setIndex}
      label={t('chat.presentationViewer.slideOf', { index: index + 1, count })}
    />
  )

  return (
    <FileViewerShell
      filePath={filePath}
      fileName={fileName}
      icon={<PresentationBarChart01Icon size={14} className="text-muted shrink-0" />}
      expanded={
        preview ? (
          <div className="group flex h-full w-full flex-col gap-3 p-4">
            <div
              className="bg-muted/10 relative m-auto flex w-full max-w-full items-center justify-center rounded-lg"
              style={{ aspectRatio: aspect, maxHeight: '100%' }}
            >
              {url && <img src={url} alt={fileName} className="h-full w-full object-contain" />}
              {pager}
            </div>
            {preview.totalSlides > count && (
              <p className="text-muted shrink-0 text-center text-[11px]">
                {t('chat.presentationViewer.partial', { count, total: preview.totalSlides })}
              </p>
            )}
          </div>
        ) : undefined
      }
    >
      <div
        className="bg-muted/10 relative flex w-full items-center justify-center"
        style={{ aspectRatio: aspect }}
      >
        {url ? (
          <img src={url} alt={fileName} className="h-full w-full object-contain" />
        ) : (
          <span className="text-muted animate-pulse text-xs">
            {t('chat.presentationViewer.loading')}
          </span>
        )}
        {url && pager}
      </div>
    </FileViewerShell>
  )
}
