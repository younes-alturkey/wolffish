import { cn } from '@lib/utils/cn'
import type { CountdownSnapshot, CountdownStatus } from '@preload/index'
import { Clock01Icon } from 'hugeicons-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Turn-end countdown card. Fully DETERMINISTIC: the label, the deadline and
 * the state all come from the manager's CountdownSnapshot — the model
 * narrates nothing. One card per countdown: snapshots replace each other
 * by countdownId upstream (upsertCountdownSegment live, the
 * countdown:changed fold after the turn ends), so live and reloaded
 * conversations render identically.
 *
 * The bar is derived locally from fireAt/seconds at 10 Hz — main pushes
 * state transitions only, never ticks. In its terminal states the card is
 * a one-line record: no bar, no button.
 */

const STATUS_COLOR: Record<CountdownStatus, string> = {
  armed: 'bg-accent/10 text-accent',
  counting: 'bg-accent/10 text-accent',
  fired: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  failed: 'bg-red-500/10 text-red-600 dark:text-red-400',
  aborted: 'bg-muted/20 text-muted'
}

export function CountdownCard({ snapshot }: { snapshot: CountdownSnapshot }): React.JSX.Element {
  const { t } = useTranslation()
  const live = snapshot.status === 'armed' || snapshot.status === 'counting'
  const counting = snapshot.status === 'counting' && snapshot.fireAt !== null

  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    if (!counting) return
    const id = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(id)
  }, [counting])

  const remainingMs = counting ? Math.max(0, (snapshot.fireAt ?? 0) - now) : snapshot.seconds * 1000
  const remainingS = Math.ceil(remainingMs / 1000)
  const percent = counting
    ? Math.max(0, Math.min(100, (remainingMs / (snapshot.seconds * 1000)) * 100))
    : 100

  const endedAt = snapshot.endedAt ? new Date(snapshot.endedAt) : null
  const endedLabel = endedAt
    ? endedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : ''

  return (
    <div className="border-border bg-surface flex w-full max-w-[85%] flex-col gap-2 self-start rounded-2xl border px-4 py-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Clock01Icon size={15} className="text-muted shrink-0" aria-hidden />
          <span
            className={cn(
              'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium',
              STATUS_COLOR[snapshot.status]
            )}
          >
            {t(`chat.countdown.status.${snapshot.status}`)}
          </span>
          <span dir="auto" className="text-fg truncate font-medium">
            {snapshot.label}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {live && (
            <span dir="ltr" className="text-muted text-xs tabular-nums" aria-live="polite">
              {t('chat.countdown.remaining', { count: remainingS })}
            </span>
          )}
          {!live && endedLabel && (
            <span dir="ltr" className="text-muted text-xs tabular-nums">
              {endedLabel}
            </span>
          )}
          {live && (
            <button
              type="button"
              onClick={() => void window.api.countdown.abort(snapshot.countdownId)}
              className="border-border bg-bg text-fg hover:bg-surface flex shrink-0 cursor-pointer items-center rounded-full border px-3 py-1 text-xs font-medium focus-visible:ring-2 focus-visible:ring-accent"
            >
              {t('chat.countdown.abort')}
            </button>
          )}
        </div>
      </div>

      {live && (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          className="bg-bg border-border h-1.5 w-full overflow-hidden rounded-full border"
        >
          <div
            className="bg-accent h-full rounded-full transition-[width] duration-100 ease-linear"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}

      <div className="text-muted flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span dir="auto">
          {snapshot.status === 'armed'
            ? t('chat.countdown.armedHint', { count: snapshot.seconds })
            : snapshot.status === 'aborted'
              ? t(`chat.countdown.abortedBy.${snapshot.abortedBy ?? 'user'}`)
              : snapshot.status === 'fired'
                ? (snapshot.result ?? t('chat.countdown.firedHint'))
                : snapshot.status === 'failed'
                  ? ''
                  : t('chat.countdown.countingHint')}
        </span>
        <span dir="ltr" className="ms-auto font-mono tabular-nums opacity-70">
          {snapshot.target.tool}
        </span>
      </div>

      {snapshot.status === 'failed' && (
        <div
          role="alert"
          aria-live="polite"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900 dark:border-red-700 dark:bg-red-900/40 dark:text-red-100"
        >
          {snapshot.error ?? t('chat.countdown.status.failed')}
        </div>
      )}
    </div>
  )
}
