import { ExpandedSheet } from '@components/core/ExpandedSheet'
import { cn } from '@lib/utils/cn'
import { ArrowExpandIcon, Download01Icon, FolderOpenIcon, LinkSquare02Icon } from 'hugeicons-react'
import { useCallback, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export type FileViewerShellProps = {
  /** Workspace-relative path — what the upload IPC resolves. */
  filePath: string
  fileName: string
  /** Sits before the filename in the footer. */
  icon: ReactNode
  /** The card's stage. Paging controls are laid over it by the viewer, not
   *  passed in here — see ViewerPager. */
  children: ReactNode
  /** Sheet body. Omit to drop the expand button entirely — a control that
   *  cannot act renders nothing. */
  expanded?: ReactNode
}

/**
 * The card frame every paged document viewer shares: stage, the four file
 * actions, and the expanded sheet. Split out when the presentation viewer
 * landed rather than copied a fourth time — the PDF, docx and spreadsheet
 * cards each grew their own footer before this existed.
 *
 * The root carries `group` so overlay controls anywhere inside can reveal
 * themselves on hover of the card.
 */
export function FileViewerShell({
  filePath,
  fileName,
  icon,
  children,
  expanded
}: FileViewerShellProps): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  const openExternal = useCallback(async () => {
    try {
      await window.api.upload.openExternal(filePath)
    } catch {
      // best-effort
    }
  }, [filePath])

  const download = useCallback(async () => {
    try {
      await window.api.upload.download(filePath)
    } catch {
      // best-effort
    }
  }, [filePath])

  const revealInFolder = useCallback(async () => {
    try {
      await window.api.upload.revealInFolder(filePath)
    } catch {
      // best-effort
    }
  }, [filePath])

  return (
    <div
      className={cn(
        'group border-border bg-surface flex w-full max-w-[85%] flex-col self-start',
        'overflow-hidden rounded-2xl border'
      )}
    >
      {children}
      <div className="flex items-center gap-2 px-3 py-2">
        {icon}
        <span
          className="text-muted min-w-0 flex-1 truncate text-[11px] font-medium"
          title={fileName}
        >
          {fileName}
        </span>
        {expanded && (
          <ViewerAction title={t('chat.fileCard.expand')} onClick={() => setOpen(true)}>
            <ArrowExpandIcon size={14} />
          </ViewerAction>
        )}
        <ViewerAction title={t('chat.pdfViewer.openExternal')} onClick={openExternal}>
          <LinkSquare02Icon size={14} />
        </ViewerAction>
        <ViewerAction title={t('chat.fileCard.reveal')} onClick={revealInFolder}>
          <FolderOpenIcon size={14} />
        </ViewerAction>
        <ViewerAction title={t('chat.fileCard.download')} onClick={download}>
          <Download01Icon size={14} />
        </ViewerAction>
      </div>
      {/* Portals to document.body, so nesting it in the card costs no layout. */}
      {expanded && (
        <ExpandedSheet open={open} onClose={() => setOpen(false)} title={fileName}>
          {expanded}
        </ExpandedSheet>
      )}
    </div>
  )
}

function ViewerAction({
  title,
  onClick,
  children
}: {
  title: string
  onClick: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cn(
        'text-muted hover:text-fg flex shrink-0 cursor-pointer items-center justify-center rounded p-1',
        'focus-visible:ring-accent focus-visible:ring-2'
      )}
    >
      {children}
    </button>
  )
}
