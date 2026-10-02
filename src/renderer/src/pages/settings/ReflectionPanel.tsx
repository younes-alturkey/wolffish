import { Select, type SelectOption } from '@components/core/Select'
import { useToast } from '@components/core/toast/useToast'
import { cn } from '@lib/utils/cn'
import { formatCompact } from '@lib/utils/format'
import type { CompactionRunRecord, CompactionRuns, ReflectionConfig } from '@preload/index'
import { useLocale } from '@providers/locale/useLocale'
import { Activity04Icon, PlayIcon, Refresh01Icon } from 'hugeicons-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

const HOUR_OPTIONS: SelectOption<string>[] = Array.from({ length: 24 }, (_, i) => ({
  value: String(i),
  label: `${String(i).padStart(2, '0')}:00`
}))

const QUIET_HOUR_CHOICES = [1, 2, 3, 6, 12, 24, 48]

/**
 * Settings → Knowledge → Reflection. The nightly self-review (schedule +
 * quiet gate) and the monthly deep reflection audit — plus last-run cards
 * for both jobs, mirroring the compaction panel's layout language.
 */
export function ReflectionPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const { locale } = useLocale()

  const [config, setConfig] = useState<ReflectionConfig | null>(null)
  const [runs, setRuns] = useState<CompactionRuns | null>(null)
  const [saving, setSaving] = useState(false)
  const [resyncing, setResyncing] = useState(false)
  const [running, setRunning] = useState<'reflection' | 'deepClean' | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let cancelled = false
    void window.api.runtime.getReflectionConfig().then((cfg) => {
      if (!cancelled) setConfig(cfg)
    })
    const loadRuns = (): void => {
      void window.api.runtime.getCompactionRuns().then((r) => {
        if (!cancelled) setRuns(r)
      })
    }
    loadRuns()
    // A reflection/deep-clean job can finish while the panel is open —
    // refresh the cards (both jobs report on the compaction:changed push).
    const off = window.api.runtime.onCompactionChanged(loadRuns)
    // The paired phone edits the same config over the tunnel; that change
    // lands here as reflection:changed, so an open panel re-pulls instead of
    // showing pre-edit values until it is next remounted.
    const offConfig = window.api.runtime.onReflectionChanged(() => {
      void window.api.runtime.getReflectionConfig().then((cfg) => {
        if (!cancelled) setConfig(cfg)
      })
    })
    return () => {
      cancelled = true
      off()
      offConfig()
    }
  }, [])

  // Tick every 60s so the "runs in …" label stays fresh
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const onResync = async (): Promise<void> => {
    setResyncing(true)
    try {
      setConfig(await window.api.runtime.getReflectionConfig())
      setRuns(await window.api.runtime.getCompactionRuns())
      setNow(Date.now())
      toast.show({
        tone: 'success',
        message: t('settings.knowledge.reflection.resyncSuccessToast')
      })
    } catch {
      toast.show({ tone: 'error', message: t('settings.knowledge.reflection.resyncErrorToast') })
    } finally {
      setResyncing(false)
    }
  }

  const persist = async (patch: Partial<ReflectionConfig>): Promise<void> => {
    if (saving) return
    setSaving(true)
    try {
      setConfig(await window.api.runtime.setReflectionConfig(patch))
    } finally {
      setSaving(false)
    }
  }

  const runNow = async (kind: 'reflection' | 'deepClean'): Promise<void> => {
    if (running) return
    setRunning(kind)
    try {
      const result =
        kind === 'reflection'
          ? await window.api.runtime.runReflectionNow()
          : await window.api.runtime.runDeepCleanNow()
      toast.show({
        tone: 'success',
        message: t(
          result === 'coalesced'
            ? 'settings.knowledge.reflection.runAlready'
            : 'settings.knowledge.reflection.runStarted'
        )
      })
    } catch {
      toast.show({ tone: 'error', message: t('settings.knowledge.reflection.runError') })
    } finally {
      setRunning(null)
    }
  }

  const quietOptions = useMemo<SelectOption<string>[]>(
    () =>
      QUIET_HOUR_CHOICES.map((h) => ({
        value: String(h),
        label: t('settings.knowledge.reflection.quietHoursOption', { count: h })
      })),
    [t]
  )

  if (!config) return <div />

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <h1 className="text-fg text-2xl font-semibold tracking-tight">
              {t('settings.knowledge.reflection.title')}
            </h1>
            <p className="text-muted text-sm leading-relaxed">
              {t('settings.knowledge.reflection.subtitle')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void onResync()}
            disabled={resyncing}
            aria-label={t('settings.knowledge.reflection.resync')}
            className={cn(
              'inline-flex items-center gap-1 rounded-md text-xs cursor-pointer',
              'text-muted hover:text-fg px-1.5 py-0.5',
              'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
              'disabled:cursor-not-allowed disabled:opacity-40'
            )}
          >
            <Refresh01Icon size={14} />
            <span>{t('settings.knowledge.reflection.resync')}</span>
          </button>
        </header>

        <section className="bg-surface border-border flex items-center justify-between rounded-2xl border px-6 py-4">
          <span className="text-fg text-sm font-medium">
            {new Date(now).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
          </span>
          <code className="text-muted bg-bg/60 border-border/40 rounded border px-2 py-1 text-[11px]">
            {new Intl.DateTimeFormat(locale, { timeZoneName: 'long' })
              .formatToParts(now)
              .find((p) => p.type === 'timeZoneName')?.value ??
              Intl.DateTimeFormat().resolvedOptions().timeZone}
          </code>
        </section>

        {/* Nightly reflection schedule — a core feature: no off switch, only
            the hour and the quiet gate are configurable. */}
        <section className="bg-surface border-border flex flex-col gap-6 rounded-2xl border p-6">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <span className="text-fg text-sm font-medium">
                  {t('settings.knowledge.reflection.nightly.label')}
                </span>
                <RunNowButton
                  label={t('settings.knowledge.reflection.runNow')}
                  disabled={running !== null}
                  onClick={() => void runNow('reflection')}
                />
              </div>
              <Select<string>
                className="min-w-28"
                value={String(config.hour)}
                options={HOUR_OPTIONS}
                onChange={(v) => void persist({ hour: Number(v) })}
                disabled={saving}
              />
            </div>
            <p className="text-muted text-xs leading-relaxed">
              {t('settings.knowledge.reflection.nightly.description')}
            </p>
            <NextRun ms={nextDailyMs(config.hour, now)} locale={locale} />
          </div>

          <div className="border-border/60 border-t" />

          {/* Quiet gate */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-4">
              <span className="text-fg text-sm font-medium">
                {t('settings.knowledge.reflection.quiet.label')}
              </span>
              <Select<string>
                className="min-w-32"
                value={String(config.quietHours)}
                options={quietOptions}
                onChange={(v) => void persist({ quietHours: Number(v) })}
                disabled={saving}
              />
            </div>
            <p className="text-muted text-xs leading-relaxed">
              {t('settings.knowledge.reflection.quiet.description')}
            </p>
          </div>
        </section>

        {/* Monthly deep reflection (internally `deepClean`) — core like the
            nightly pass, no off switch. */}
        <section className="bg-surface border-border flex flex-col gap-2 rounded-2xl border p-6">
          <div className="flex items-center gap-2">
            <span className="text-fg text-sm font-medium">
              {t('settings.knowledge.reflection.deepClean.label')}
            </span>
            <RunNowButton
              label={t('settings.knowledge.reflection.runNow')}
              disabled={running !== null}
              onClick={() => void runNow('deepClean')}
            />
          </div>
          <p className="text-muted text-xs leading-relaxed">
            {t('settings.knowledge.reflection.deepClean.description')}
          </p>
        </section>

        {/* Last-run cards — absent entirely until a job has actually run. */}
        {runs?.reflection && (
          <LastRunCard kind="reflection" record={runs.reflection} locale={locale} />
        )}
        {runs?.deepClean && (
          <LastRunCard kind="deepClean" record={runs.deepClean} locale={locale} />
        )}
      </div>
    </div>
  )
}

// ── Small controls ───────────────────────────────────────────────────

/**
 * The label never collapses while a run is in flight — `disabled` covers the
 * busy window (callers pass `running !== null`), and the dim is the whole
 * signal, so the button never changes size mid-run.
 */
function RunNowButton({
  label,
  disabled,
  onClick
}: {
  label: string
  disabled: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'border-border bg-bg/40 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1 text-xs font-medium',
        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        disabled ? 'text-muted/50 cursor-not-allowed' : 'text-fg hover:bg-border/40 cursor-pointer'
      )}
    >
      <PlayIcon size={12} />
      <span>{label}</span>
    </button>
  )
}

// ── Last-run cards (compaction panel's layout language) ──────────────

const CHIP_CLASS = 'text-muted bg-bg/60 border-border/40 rounded border px-2 py-1 text-[11px]'

function formatDuration(ms: number, locale: string): string {
  const seconds = ms / 1000
  try {
    if (seconds < 90) {
      return new Intl.NumberFormat(locale, {
        style: 'unit',
        unit: 'second',
        maximumFractionDigits: seconds < 10 ? 1 : 0
      }).format(seconds)
    }
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: 'minute',
      maximumFractionDigits: 1
    }).format(seconds / 60)
  } catch {
    return `${Math.round(seconds)}s`
  }
}

function LastRunCard({
  kind,
  record,
  locale
}: {
  kind: 'reflection' | 'deepClean'
  record: CompactionRunRecord
  locale: string
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <section className="bg-surface border-border flex flex-col gap-3 rounded-2xl border p-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Activity04Icon size={16} className="text-muted" />
          <span className="text-fg text-sm font-medium">
            {t(`settings.knowledge.reflection.lastRun.${kind}Title`)}
          </span>
        </div>
        <code className={CHIP_CLASS}>
          {t('settings.knowledge.reflection.lastRun.ranAt', {
            time: new Date(record.at).toLocaleString(locale, {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit'
            })
          })}
        </code>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {record.model && <code className={CHIP_CLASS}>{record.model}</code>}
        <code className={CHIP_CLASS}>
          {t('settings.knowledge.reflection.lastRun.took', {
            duration: formatDuration(record.durationMs, locale)
          })}
        </code>
        {record.inputTokens !== null && record.outputTokens !== null && (
          <code className={CHIP_CLASS}>
            {t('settings.knowledge.reflection.lastRun.tokens', {
              input: formatCompact(record.inputTokens, locale),
              output: formatCompact(record.outputTokens, locale)
            })}
          </code>
        )}
      </div>
      <pre
        dir="auto"
        className="text-fg/80 bg-bg/60 border-border/40 max-h-64 overflow-auto rounded-lg border p-3 text-[11px] leading-relaxed whitespace-pre-wrap"
      >
        {record.output}
      </pre>
    </section>
  )
}

// ── "runs in …" helpers ──────────────────────────────────────────────

function nextDailyMs(hour: number, nowMs: number): number {
  const d = new Date(nowMs)
  d.setHours(hour, 0, 0, 0)
  if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1)
  return d.getTime() - nowMs
}

function formatFromNow(ms: number, locale: string): string {
  const totalMinutes = Math.round(ms / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const days = Math.floor(hours / 24)

  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
    if (days > 0) return rtf.format(days, 'day')
    if (hours > 0) return rtf.format(hours, 'hour')
    return rtf.format(totalMinutes, 'minute')
  } catch {
    if (days > 0) return `in ${days}d`
    if (hours > 0) return `in ${hours}h`
    return `in ${totalMinutes}m`
  }
}

function NextRun({ ms, locale }: { ms: number; locale: string }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <code className="text-muted bg-bg/60 border-border/40 inline-block self-start rounded border px-2 py-1 text-[11px]">
      {t('settings.knowledge.reflection.nextRun', { time: formatFromNow(ms, locale) })}
    </code>
  )
}
