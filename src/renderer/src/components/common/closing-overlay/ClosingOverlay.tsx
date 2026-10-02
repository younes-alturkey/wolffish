import { cn } from '@lib/utils/cn'
import { Radar01Icon } from 'hugeicons-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Full-screen overlay shown when the user tries to quit Wolffish while
 * background tasks (conversation save, title generation) are still in
 * flight. The main process holds the actual quit until the task counter
 * drains; this component only narrates the wait.
 *
 * The progress bar is intentionally fake — it follows an asymptotic
 * curve `1 - exp(-t / k)` capped near 95% so it always feels alive but
 * never lies about being "done". The window disappears the moment main
 * calls app.quit, which is the real end-of-progress signal.
 */
export function ClosingOverlay(): React.JSX.Element | null {
  const { t } = useTranslation()
  const [closing, setClosing] = useState(false)
  const [progress, setProgress] = useState(0)
  const startedAtRef = useRef<number | null>(null)

  useEffect(() => {
    return window.api.app.onClosingPending(() => {
      if (startedAtRef.current === null) startedAtRef.current = Date.now()
      setClosing(true)
    })
  }, [])

  useEffect(() => {
    if (!closing) return
    const tick = (): void => {
      const startedAt = startedAtRef.current ?? Date.now()
      const elapsedMs = Date.now() - startedAt
      const eased = 1 - Math.exp(-elapsedMs / 4000)
      setProgress(Math.min(0.95, eased))
    }
    tick()
    const id = window.setInterval(tick, 120)
    return () => window.clearInterval(id)
  }, [closing])

  if (!closing) return null

  return (
    <div className="bg-bg/95 fixed inset-0 z-50 flex items-center justify-center px-6 py-12 backdrop-blur-sm">
      <div className="flex w-full max-w-md flex-col gap-6">
        <header className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-fg text-2xl font-semibold tracking-tight">{t('closing.title')}</h1>
          <p className="text-muted text-sm leading-relaxed">{t('closing.subtitle')}</p>
        </header>

        <section
          className={cn(
            'border-border bg-surface rounded-2xl border p-6 shadow-sm dark:shadow-none',
            'flex flex-col gap-4'
          )}
        >
          <div className="flex flex-col items-center gap-3 py-2 text-center">
            <Radar01Icon size={36} className="text-muted animate-pulse" />
            <p className="text-fg text-base font-medium">{t('closing.bodyTitle')}</p>
            <p className="text-muted text-sm leading-relaxed">{t('closing.body')}</p>
          </div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            className="bg-bg border-border h-1.5 w-full overflow-hidden rounded-full border"
          >
            <div
              className="bg-accent h-full rounded-full transition-[width] duration-150 ease-out"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
        </section>
      </div>
    </div>
  )
}
