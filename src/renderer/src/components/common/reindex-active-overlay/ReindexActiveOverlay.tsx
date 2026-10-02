import type { ReindexStatus } from '@preload/index'
import { DatabaseSync01Icon } from 'hugeicons-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Full-screen blocking overlay shown while the cortex search index is being
 * rebuilt (one-time after an app update). Unlike automation/procedure runs
 * (non-blocking, and drawing nothing over the app), this one really does block:
 * pulsing icon, started-at + live elapsed timer, an explanatory body, and a
 * "blocked" footer — with a progress bar instead of an activity log.
 *
 * The agent already gates every turn on the index being ready; this just makes
 * that wait visible and explains why, so a long rebuild doesn't read as a hang.
 */
export function ReindexActiveOverlay(): React.JSX.Element | null {
  const { t, i18n } = useTranslation()
  const [status, setStatus] = useState<ReindexStatus | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let cancelled = false
    window.api.reindex.getStatus().then((s) => {
      if (!cancelled) setStatus(s)
    })
    const offStarted = window.api.reindex.onStarted((s) =>
      setStatus({ startedAt: s.startedAt, total: s.total, done: 0 })
    )
    const offProgress = window.api.reindex.onProgress((s) =>
      setStatus((prev) =>
        prev
          ? { ...prev, done: s.done, total: s.total }
          : { startedAt: Date.now(), done: s.done, total: s.total }
      )
    )
    const offEnded = window.api.reindex.onEnded(() => setStatus(null))
    return () => {
      cancelled = true
      offStarted()
      offProgress()
      offEnded()
    }
  }, [])

  // Key the ticker on startedAt (constant for a whole rebuild), NOT the full
  // status — otherwise every per-second progress update re-runs this effect and
  // resets the interval before it can fire, freezing the elapsed timer.
  const activeStartedAt = status?.startedAt ?? null
  useEffect(() => {
    if (activeStartedAt === null) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [activeStartedAt])

  if (!status) return null

  const elapsed = Math.max(0, Math.floor((now - status.startedAt) / 1000))
  const mm = Math.floor(elapsed / 60)
  const ss = elapsed % 60
  const elapsedStr = `${mm}:${ss.toString().padStart(2, '0')}`
  // Localize the time-of-day to the active language (Arabic gets Arabic
  // numerals/AM-PM), matching how the app formats timestamps elsewhere.
  const startedStr = new Date(status.startedAt).toLocaleTimeString(i18n.language, {
    hour: '2-digit',
    minute: '2-digit'
  })
  const pct = status.total > 0 ? Math.min(100, Math.round((status.done / status.total) * 100)) : 0

  return (
    <main className="bg-bg flex h-full w-full flex-col items-center justify-center pt-10">
      <div className="flex w-full max-w-md flex-col items-center gap-6 px-6">
        <div className="relative">
          <div className="absolute inset-0 animate-ping rounded-full bg-emerald-500/20" />
          <div className="relative flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/15">
            <DatabaseSync01Icon size={20} className="text-emerald-500 animate-pulse" />
          </div>
        </div>

        <div className="flex flex-col items-center gap-1.5">
          <h2 className="text-fg text-sm font-medium">{t('reindex.overlay.title')}</h2>
          <div className="text-muted flex items-center gap-2 text-xs">
            <span>{t('reindex.overlay.startedAt', { time: startedStr })}</span>
            <span className="text-border">·</span>
            {/* duration is conventionally LTR even in RTL UIs */}
            <span dir="ltr" className="tabular-nums font-mono">
              {elapsedStr}
            </span>
          </div>
        </div>

        <pre className="text-muted bg-surface border-border w-full rounded-lg border px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap">
          {t('reindex.overlay.body')}
        </pre>

        <div className="border-border bg-surface/50 w-full rounded-lg border px-3 py-2.5">
          <div className="text-muted mb-1.5 flex items-center justify-between text-[10px] font-medium uppercase tracking-wide">
            <span>{t('reindex.overlay.progress')}</span>
            {/* "done / total" pinned LTR so the count reads correctly in RTL */}
            <span dir="ltr" className="tabular-nums">
              {status.done.toLocaleString()} / {status.total.toLocaleString()}
            </span>
          </div>
          <div className="bg-border/60 h-1.5 w-full overflow-hidden rounded-full">
            <div
              className="h-full rounded-full bg-emerald-500 transition-[width] duration-500 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        <p className="text-muted/50 text-center text-[11px]">{t('reindex.overlay.blocked')}</p>
      </div>
    </main>
  )
}
