import { FileCard } from '@components/common/file-card/FileCard'
import { FileViewerShell } from '@components/common/file-viewer-shell/FileViewerShell'
import { SheetGrid } from '@components/common/spreadsheet-viewer/SheetGrid'
import type { WorkbookModel } from '@lib/spreadsheet/types'
import { readWorkbook } from '@lib/spreadsheet/workbook'
import { Table01Icon } from 'hugeicons-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export type SpreadsheetViewerProps = {
  filePath: string
  fileExists: boolean
  fileName: string
  sizeBytes: number
}

/**
 * A workbook as a grid — the document's own fills, fonts, borders, number
 * formats and frozen panes, inside app-themed chrome.
 *
 * One model feeds both surfaces. A sheet is data rather than the megabytes of
 * DOM a rendered document is, and the grid windows its rows, so the card and the
 * expanded sheet can share a single parse of the whole workbook instead of the
 * card reading a truncated slice it would have to re-read on expand.
 */
export function SpreadsheetViewer({
  filePath,
  fileExists,
  fileName,
  sizeBytes
}: SpreadsheetViewerProps): React.JSX.Element {
  if (!fileExists) {
    return (
      <FileCard
        filePath={filePath}
        fileExists={false}
        fileName={fileName}
        sizeBytes={sizeBytes}
        mimeType={XLSX_MIME}
      />
    )
  }
  return <ActiveWorkbook filePath={filePath} fileName={fileName} sizeBytes={sizeBytes} />
}

function ActiveWorkbook({
  filePath,
  fileName,
  sizeBytes
}: {
  filePath: string
  fileName: string
  sizeBytes: number
}): React.JSX.Element {
  const { t } = useTranslation()
  // Stamped with the path it belongs to, so a prop change reads as "not loaded
  // yet" without a synchronous reset and the extra render pass that costs.
  const [loaded, setLoaded] = useState<{
    path: string
    workbook: WorkbookModel | null
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const buffer = await window.api.upload.readFile(filePath)
        if (!buffer) throw new Error(`missing upload: ${filePath}`)
        const model = await readWorkbook(buffer, fileName)
        if (!cancelled) setLoaded({ path: filePath, workbook: model })
      } catch {
        if (!cancelled) setLoaded({ path: filePath, workbook: null })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [filePath, fileName])

  const ready = loaded?.path === filePath ? loaded : null

  // A workbook that won't parse falls back to the plain file card — what a
  // spreadsheet showed before any of this, and it keeps every file action.
  if (ready && !ready.workbook) {
    return (
      <FileCard
        filePath={filePath}
        fileExists={true}
        fileName={fileName}
        sizeBytes={sizeBytes}
        mimeType={XLSX_MIME}
      />
    )
  }

  const workbook = ready?.workbook ?? null

  return (
    <FileViewerShell
      filePath={filePath}
      fileName={fileName}
      icon={<Table01Icon size={14} className="text-muted shrink-0" />}
      expanded={
        workbook ? (
          // ExpandedSheet hands its body a block box, so the grid needs a
          // definite height of its own — otherwise it grows to its full content
          // height, never scrolls itself, and row windowing never engages.
          <div className="flex h-full flex-col">
            <SheetGrid workbook={workbook} variant="page" />
          </div>
        ) : undefined
      }
    >
      {workbook ? (
        <SheetGrid workbook={workbook} variant="card" />
      ) : (
        <div className="flex h-50 w-full items-center justify-center">
          <span className="text-muted animate-pulse text-xs">
            {t('chat.spreadsheetViewer.loading')}
          </span>
        </div>
      )}
    </FileViewerShell>
  )
}
