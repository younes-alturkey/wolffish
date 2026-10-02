import { cn } from '@lib/utils/cn'
import { isMac } from '@lib/utils/platform'
import { Cancel01Icon } from 'hugeicons-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

export type EditorSheetProps = {
  open: boolean
  onClose: () => void
  /** Shown in the header bar and used as the dialog's accessible name. */
  title?: ReactNode
  children: ReactNode
  /** Pinned action bar along the bottom edge — never scrolls away. */
  footer?: ReactNode
  /**
   * Backdrop-click / Escape dismiss (default true). Callers set it false while
   * another overlay is stacked on top, so Escape closes only that one.
   */
  dismissable?: boolean
}

/**
 * Trailing-edge side sheet for the long edit forms — automations, projects and
 * procedures. Same surface as the chat's logs/files sheets (backdrop dismiss,
 * `wf-sheet-panel-end` motion) at the conversations sheet's width, so the three
 * editors read as one family with the rest of the app's sheets.
 *
 * The point of the sheet over core/Modal: a Modal panel is centered and
 * unbounded in height, so a form with a schedule block, a chip row, file and
 * folder lists and a prompt editor grew past the viewport with nothing to
 * scroll and the Done button off-screen. Here the body is the only scroller,
 * full height, with the header and the action bar pinned around it.
 */
export function EditorSheet({
  open,
  onClose,
  title,
  children,
  footer,
  dismissable = true
}: EditorSheetProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open || !dismissable) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, dismissable, onClose])

  // Move focus into the dialog on open so keyboard/screen-reader users land
  // inside it rather than on the trigger behind the backdrop. Keyed on `open`
  // ALONE — a dep that changes per render would yank focus out of the form
  // mid-typing on every parent tick.
  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
  }, [open])

  if (!open || typeof document === 'undefined') return null

  // macOS draws its traffic lights over the top-left of the webview. The sheet
  // rides the trailing edge, which IS that corner under RTL — the header then
  // needs the conversations sheet's clearance.
  const underTrafficLights = isMac && document.documentElement.dir === 'rtl'

  return createPortal(
    <div
      role="presentation"
      onClick={dismissable ? onClose : undefined}
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'wf-sheet-panel-end border-border bg-surface absolute inset-y-0 inset-e-0 flex flex-col overflow-hidden border-s shadow-xl',
          // The conversations sheet's exact width, mirrored to this edge.
          'w-130 max-w-[92vw]'
        )}
      >
        <div
          className={cn(
            'border-border flex shrink-0 items-center gap-2 border-b px-5 py-3',
            underTrafficLights && 'pt-12'
          )}
        >
          <h2 id={titleId} className="text-fg min-w-0 flex-1 truncate text-sm font-semibold">
            {title}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t('chat.fileCard.close')}
            title={t('chat.fileCard.close')}
            className={cn(
              'text-muted hover:text-fg flex shrink-0 cursor-pointer items-center justify-center rounded p-1',
              'focus-visible:ring-2 focus-visible:ring-accent'
            )}
          >
            <Cancel01Icon size={16} />
          </button>
        </div>
        {/* The only scroller: however tall the form grows, the header above and
            the action bar below stay put. */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm leading-relaxed">
          {children}
        </div>
        {footer && (
          <div className="border-border flex shrink-0 flex-col gap-2 border-t px-5 py-3">
            {footer}
          </div>
        )}
      </aside>
    </div>,
    document.body
  )
}
