/**
 * Interactive chart card for delivered `.chart.json` specs (the `(chart)`
 * marker type). Loads the spec over the upload IPC channel, renders it live
 * via ChartSpecPlot, and expands into an ExpandedSheet with a Chart ⇄ Data
 * toggle and PNG export. Falls back to the plain FileCard while loading, on
 * read failure, for oversized files, and for specs that cannot render —
 * the file stays downloadable either way.
 */
import { ChartSpecPlot } from '@components/charts/chart-spec/ChartSpecPlot'
import { parseChartSpec } from '@components/charts/chart-spec/spec'
import { FileCard } from '@components/common/file-card/FileCard'
import { ExpandedSheet } from '@components/core/ExpandedSheet'
import { useUploadText } from '@hooks/use-upload-text/useUploadText'
import { cn } from '@lib/utils/cn'
import type { EChartsType } from 'echarts/core'
import {
  ArrowExpandIcon,
  ChartLineData02Icon,
  Download01Icon,
  FolderOpenIcon,
  Image01Icon
} from 'hugeicons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export type ChartCardProps = {
  filePath: string
  fileExists: boolean
  fileName: string
  /** Byte size, or 0 when unknown (tool-delivered files) — resolved via IPC. */
  sizeBytes: number
  mimeType: string
}

const MAX_INLINE_BYTES = 1024 * 1024
const DEFAULT_PLOT_HEIGHT = 320

const iconButton =
  'text-muted hover:text-fg flex shrink-0 cursor-pointer items-center justify-center rounded p-1 focus-visible:ring-2 focus-visible:ring-accent'

export function ChartCard({
  filePath,
  fileExists,
  fileName,
  sizeBytes,
  mimeType
}: ChartCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [sheetView, setSheetView] = useState<'chart' | 'data'>('chart')
  // One ref per surface: the sheet's instance is disposed when it closes, so
  // PNG export picks whichever plot is actually live for the button pressed.
  const cardChartRef = useRef<EChartsType | null>(null)
  const sheetChartRef = useRef<EChartsType | null>(null)

  // Attachments pass a real size; tool-delivered files pass 0 (unknown). Stat
  // over IPC so the oversize guard applies before reading the whole file.
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
  const spec = useMemo(() => (text === null ? null : parseChartSpec(text)), [text])

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

  const handleCardInstance = useCallback((chart: EChartsType | null) => {
    cardChartRef.current = chart
  }, [])
  const handleSheetInstance = useCallback((chart: EChartsType | null) => {
    sheetChartRef.current = chart
  }, [])

  const savePng = useCallback(() => {
    const chart = sheetChartRef.current ?? cardChartRef.current
    if (!chart) return
    const surface = getComputedStyle(document.documentElement)
      .getPropertyValue('--color-surface')
      .trim()
    const url = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: surface })
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${fileName.replace(/\.chart\.json$/i, '')}.png`
    anchor.click()
  }, [fileName])

  if (text === null || spec === null) {
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

  const title = spec.title.length > 0 ? spec.title : fileName
  const plotHeight = spec.height ?? DEFAULT_PLOT_HEIGHT

  const pngButton = (
    <button
      type="button"
      onClick={savePng}
      title={t('chat.chartCard.savePng')}
      aria-label={t('chat.chartCard.savePng')}
      className={cn(iconButton)}
    >
      <Image01Icon size={14} />
    </button>
  )
  const downloadButton = (
    <button
      type="button"
      onClick={download}
      title={t('chat.fileCard.download')}
      aria-label={t('chat.fileCard.download')}
      className={cn(iconButton)}
    >
      <Download01Icon size={14} />
    </button>
  )
  const revealButton = (
    <button
      type="button"
      onClick={revealInFolder}
      title={t('chat.fileCard.reveal')}
      aria-label={t('chat.fileCard.reveal')}
      className={cn(iconButton)}
    >
      <FolderOpenIcon size={14} />
    </button>
  )
  const expandButton = (
    <button
      type="button"
      onClick={() => setSheetOpen(true)}
      title={t('chat.fileCard.expand')}
      aria-label={t('chat.fileCard.expand')}
      className={cn(iconButton)}
    >
      <ArrowExpandIcon size={14} />
    </button>
  )

  const sheetViewToggle = (
    <div className="border-border bg-bg/40 inline-flex shrink-0 items-center rounded-lg border p-0.5">
      {(['chart', 'data'] as const).map((view) => (
        <button
          key={view}
          type="button"
          onClick={() => setSheetView(view)}
          aria-pressed={sheetView === view}
          className={cn(
            'rounded-md px-2 py-0.5 text-[11px] font-medium',
            sheetView === view
              ? 'bg-primary text-primary-fg shadow-sm'
              : 'text-muted hover:text-fg cursor-pointer'
          )}
        >
          {t(view === 'chart' ? 'chat.chartCard.viewChart' : 'chat.chartCard.viewData')}
        </button>
      ))}
    </div>
  )

  const dataView = (
    <pre dir="ltr" className="text-fg flex-1 overflow-auto p-4 font-mono text-xs leading-5">
      {JSON.stringify(spec, null, 2)}
    </pre>
  )

  return (
    <div
      className={cn(
        'border-border bg-surface flex w-full max-w-[85%] flex-col self-start',
        'overflow-hidden rounded-2xl border'
      )}
    >
      <div className="flex w-full items-start gap-2 px-4 pb-1 pt-3">
        <ChartLineData02Icon size={15} className="text-muted mt-0.5 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-fg truncate text-sm font-semibold" title={title}>
            {title}
          </span>
          {spec.subtitle ? (
            <span className="text-muted truncate text-[11px]">{spec.subtitle}</span>
          ) : null}
        </div>
      </div>

      <div className="w-full px-2" style={{ height: plotHeight }}>
        <ChartSpecPlot spec={spec} className="h-full w-full" onInstance={handleCardInstance} />
      </div>

      <div className="border-border flex items-center gap-2 border-t px-3 py-1.5">
        <span className="text-muted min-w-0 flex-1 truncate text-[10px]" title={spec.footnote}>
          {spec.footnote ?? fileName}
        </span>
        {revealButton}
        {downloadButton}
        {pngButton}
        {expandButton}
      </div>

      <ExpandedSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={title}
        actions={
          <>
            {sheetViewToggle}
            {pngButton}
            {downloadButton}
            {revealButton}
          </>
        }
      >
        {sheetView === 'chart' ? (
          <div className="flex h-full w-full flex-col p-4">
            {spec.subtitle ? (
              <span className="text-muted pb-2 text-xs">{spec.subtitle}</span>
            ) : null}
            <ChartSpecPlot
              spec={spec}
              className="min-h-0 w-full flex-1"
              onInstance={handleSheetInstance}
            />
            {spec.footnote ? (
              <span className="text-muted pt-2 text-[11px]">{spec.footnote}</span>
            ) : null}
          </div>
        ) : (
          dataView
        )}
      </ExpandedSheet>
    </div>
  )
}
