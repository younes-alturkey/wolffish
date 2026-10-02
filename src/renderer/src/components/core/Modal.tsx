import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@lib/utils/cn'

export type ModalProps = {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  /** Optional footer area for action buttons. */
  footer?: ReactNode
  /** Click-outside / ESC dismissable (default true). */
  dismissable?: boolean
  /** Extra classes for the dialog panel. */
  className?: string
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  dismissable = true,
  className
}: ModalProps): React.JSX.Element | null {
  useEffect(() => {
    if (!open || !dismissable) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, dismissable, onClose])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      role="presentation"
      onClick={dismissable ? onClose : undefined}
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center p-4',
        'bg-black/40 backdrop-blur-sm'
      )}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'bg-surface border-border text-fg flex w-full max-w-md flex-col gap-4 rounded-2xl border p-6',
          'shadow-xl dark:shadow-2xl',
          className
        )}
      >
        {title && <h2 className="text-fg text-lg font-semibold tracking-tight">{title}</h2>}
        <div className="flex flex-col gap-3 text-sm leading-relaxed">{children}</div>
        {footer && <div className="flex flex-col gap-2 pt-2">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}
