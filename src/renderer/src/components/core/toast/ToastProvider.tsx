import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  Alert02Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  InformationCircleIcon
} from 'hugeicons-react'
import { cn } from '@lib/utils/cn'
import {
  ToastContext,
  type ToastContextValue,
  type ToastInput,
  type ToastTone
} from '@components/core/toast/useToast'

type Toast = ToastInput & { id: number }

const DEFAULT_DURATION_MS = 3500

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([])
  const idRef = useRef(0)
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
  }, [])

  const show = useCallback(
    (input: ToastInput): number => {
      const id = ++idRef.current
      const toast: Toast = {
        id,
        tone: input.tone ?? 'info',
        durationMs: input.durationMs ?? DEFAULT_DURATION_MS,
        sticky: input.sticky ?? false,
        placement: input.placement ?? 'bottom',
        message: input.message
      }
      setToasts((prev) => [...prev, toast])
      if (!toast.sticky) {
        const timer = setTimeout(() => dismiss(id), toast.durationMs)
        timersRef.current.set(id, timer)
      }
      return id
    },
    [dismiss]
  )

  useEffect(
    () => () => {
      const timers = timersRef.current
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    },
    []
  )

  const value = useMemo<ToastContextValue>(() => ({ show, dismiss }), [show, dismiss])

  // Two stacks: transient toasts keep the classic bottom position; ambient
  // app-state notices (placement: 'top') stack under the titlebar. top-12
  // keeps the top stack clear of the 40px titlebar drag strip
  // (.app-titlebar) — a toast inside the drag region would swallow clicks.
  const top = toasts.filter((t) => t.placement === 'top')
  const bottom = toasts.filter((t) => t.placement !== 'top')
  const portal =
    typeof document !== 'undefined'
      ? createPortal(
          <>
            <div
              aria-live="polite"
              aria-atomic="true"
              className="pointer-events-none fixed inset-x-0 top-12 z-50 flex flex-col items-center gap-2 px-4"
            >
              {top.map((t) => (
                <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
              ))}
            </div>
            <div
              aria-live="polite"
              aria-atomic="true"
              className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2 px-4"
            >
              {bottom.map((t) => (
                <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
              ))}
            </div>
          </>,
          document.body
        )
      : null

  return (
    <ToastContext.Provider value={value}>
      {children}
      {portal}
    </ToastContext.Provider>
  )
}

const TONE_STYLES: Record<ToastTone, string> = {
  info: 'bg-surface text-fg border-border',
  success:
    'bg-emerald-50 text-emerald-900 border-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-100 dark:border-emerald-700',
  warning:
    'bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-900/40 dark:text-amber-100 dark:border-amber-700',
  error:
    'bg-red-50 text-red-900 border-red-300 dark:bg-red-900/40 dark:text-red-100 dark:border-red-700'
}

function ToneIcon({ tone }: { tone: ToastTone }): React.JSX.Element {
  if (tone === 'success') return <CheckmarkCircle02Icon size={16} />
  if (tone === 'warning' || tone === 'error') return <Alert02Icon size={16} />
  return <InformationCircleIcon size={16} />
}

function ToastItem({
  toast,
  onDismiss
}: {
  toast: Toast
  onDismiss: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      role="status"
      onClick={onDismiss}
      className={cn(
        'pointer-events-auto flex max-w-md cursor-pointer items-start gap-2 rounded-xl border px-4 py-2.5 text-sm shadow-md backdrop-blur',
        TONE_STYLES[toast.tone ?? 'info']
      )}
    >
      <span className="mt-0.5 shrink-0">
        <ToneIcon tone={toast.tone ?? 'info'} />
      </span>
      <span className="min-w-0 wrap-break-word leading-relaxed">{toast.message}</span>
      <button
        type="button"
        aria-label={t('common.dismiss')}
        title={t('common.dismiss')}
        onClick={(e) => {
          e.stopPropagation()
          onDismiss()
        }}
        className="mt-0.5 shrink-0 cursor-pointer rounded-md p-0.5 opacity-60 hover:opacity-100"
      >
        <Cancel01Icon size={14} />
      </button>
    </div>
  )
}
