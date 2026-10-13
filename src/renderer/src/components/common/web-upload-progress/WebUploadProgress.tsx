import { cn } from '@lib/utils/cn'
import { onUploadProgress, type UploadProgress } from '@lib/web-bridge/picked-files'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * The send-time upload, shown above the composer on the web: which file is
 * going up, how far, and which of how many. Appears on the first byte and
 * leaves on its own once the last file has landed, or lingers on a failure
 * long enough to be read.
 */
export function WebUploadProgress(): React.JSX.Element | null {
  const { t } = useTranslation()
  const [state, setState] = useState<UploadProgress | null>(null)

  useEffect(() => {
    let hide: ReturnType<typeof setTimeout> | null = null
    const off = onUploadProgress((progress) => {
      if (hide) clearTimeout(hide)
      hide = null
      setState(progress)
      if (progress.error || (progress.done && progress.index === progress.count)) {
        hide = setTimeout(() => setState(null), progress.error ? 5000 : 900)
      }
    })
    return () => {
      off()
      if (hide) clearTimeout(hide)
    }
  }, [])

  if (!state) return null
  const percent =
    state.total > 0 ? Math.min(100, Math.round((state.loaded / state.total) * 100)) : 0
  const finished = state.done && state.index === state.count && !state.error
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-28 z-40 flex justify-center px-4"
    >
      <div className="bg-surface border-border text-fg flex w-full max-w-sm flex-col gap-1.5 rounded-xl border px-3 py-2 text-xs shadow-lg">
        <div className="flex items-center justify-between gap-3">
          <span className={cn('truncate', state.error && 'text-rose-600 dark:text-rose-400')}>
            {state.error
              ? state.error
              : finished
                ? t('web.upload.done')
                : t('web.upload.uploading', { name: state.name })}
          </span>
          <span className="text-muted shrink-0 tabular-nums">
            {state.count > 1
              ? `${percent}% · ${t('web.upload.count', { index: state.index, count: state.count })}`
              : `${percent}%`}
          </span>
        </div>
        <div className="bg-border/60 h-1 overflow-hidden rounded-full">
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-200',
              state.error ? 'bg-rose-500' : 'bg-primary'
            )}
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
    </div>
  )
}
