import { cn } from '@lib/utils/cn'
import { isMac } from '@lib/utils/platform'
import { Cancel01Icon } from 'hugeicons-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

export type ExpandedSheetProps = {
  open: boolean
  onClose: () => void
  /** Shown in the header bar; also used as the close button's accessible title. */
  title?: string
  /** Action controls rendered in the header before the close button. */
  actions?: ReactNode
  /** Rendered just before the title (an icon or logo). */
  leading?: ReactNode
  children: ReactNode
}

/**
 * Trailing-edge side sheet (80% of the viewport wide, full height) for reading
 * — or writing — content at a larger size: the file viewers expand into it, and
 * so do the prompt/instructions editors behind the automation, project and
 * procedure forms. The same surface, mirrored, as the conversations/profile
 * sheets that slide in from the leading edge. Clicking the backdrop does NOT
 * dismiss it: only the × button or Escape close it, so a stray click while
 * reading a long document — or drafting a long prompt — never loses the place.
 *
 * Not built on core/Modal because Modal gates Escape and backdrop-click on a
 * single `dismissable` flag, so it can't express "Escape closes but a backdrop
 * click does not" — the exact behavior wanted here.
 */
export function ExpandedSheet({
  open,
  onClose,
  title,
  actions,
  leading,
  children
}: ExpandedSheetProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Move focus into the dialog on open so keyboard/screen-reader users land
  // inside it rather than on the page behind the (non-dismissable) backdrop.
  // Keyed on `open` ALONE, and kept out of the Escape effect above: callers
  // pass `onClose` as an inline arrow, so that effect re-runs on every parent
  // render — and with the focus call inside it, every keystroke in the sheet's
  // editor would bounce the caret out to the × button.
  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
  }, [open])

  if (!open || typeof document === 'undefined') return null

  // macOS draws its traffic lights over the top-left of the webview. At 80vw on
  // the trailing edge that corner is the sheet's own header under RTL, so it
  // takes the same clearance the editor sheet uses.
  const underTrafficLights = isMac && document.documentElement.dir === 'rtl'

  return createPortal(
    <div role="presentation" className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm">
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        className="wf-sheet-panel-end border-border bg-surface absolute inset-y-0 inset-e-0 flex w-[80vw] max-w-full flex-col overflow-hidden border-s shadow-xl"
      >
        <div
          className={cn(
            'border-border flex shrink-0 items-center gap-2 border-b px-5 py-3',
            underTrafficLights && 'pt-12'
          )}
        >
          {leading}
          <span
            id={titleId}
            className="text-fg min-w-0 flex-1 truncate text-sm font-semibold"
            title={title}
          >
            {title}
          </span>
          {actions}
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
        <div className="flex-1 overflow-auto">{children}</div>
      </aside>
    </div>,
    document.body
  )
}
