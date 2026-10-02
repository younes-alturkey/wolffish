import { cn } from '@lib/utils/cn'
import type { ProcessCardSnapshot, ProcessRecord, ProcessState } from '@preload/index'
import { useLocale } from '@providers/locale/useLocale'
import { ComputerTerminal01Icon } from 'hugeicons-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDuration, formatRelative, isLiveState } from './format'

/**
 * The live process card. Everything on it comes from the manager's
 * ProcessCardSnapshot — the model chose WHICH processes to show
 * (process_show) and narrates nothing else. One card per cardId: snapshots
 * replace each other upstream (upsertProcessSegment live, the
 * process:cardChanged fold after the turn ends), so live and reloaded
 * conversations render identically, and the Stop / Restart buttons act
 * through the same main-process functions the model's tools use.
 *
 * Times are relative and localized (Intl.RelativeTimeFormat in the app
 * locale), re-derived every 30 s from a local clock — main pushes state
 * transitions only, never ticks.
 */

const STATE_COLOR: Record<ProcessState, string> = {
  starting: 'bg-accent/10 text-accent',
  running: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  stopping: 'bg-muted/20 text-muted',
  stopped: 'bg-muted/20 text-muted',
  exited: 'bg-muted/20 text-muted',
  crashed: 'bg-red-500/10 text-red-600 dark:text-red-400'
}

const DOT_COLOR: Record<ProcessState, string> = {
  starting: 'bg-accent',
  running: 'bg-emerald-500',
  stopping: 'bg-muted',
  stopped: 'bg-muted',
  exited: 'bg-muted',
  crashed: 'bg-red-500'
}

const buttonClass =
  'border-border bg-bg text-fg hover:bg-surface flex shrink-0 cursor-pointer items-center rounded-full border px-3 py-1 text-xs font-medium focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:opacity-50'

export function ProcessRow({
  record,
  now,
  compact
}: {
  record: ProcessRecord
  now: number
  compact?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const [busy, setBusy] = useState<'stop' | 'restart' | null>(null)
  const live = isLiveState(record.run.state)
  const stamp = live && record.run.startedAt ? record.run.startedAt : record.run.endedAt
  const stampLabel = stamp
    ? live
      ? t('chat.process.since', { time: formatDuration(now - stamp, locale) })
      : t('chat.process.endedAt', { time: formatRelative(stamp, now, locale) })
    : ''

  const act = async (kind: 'stop' | 'restart'): Promise<void> => {
    if (busy) return
    setBusy(kind)
    try {
      if (kind === 'stop') await window.api.processes.stop(record.name)
      else await window.api.processes.restart(record.name)
    } catch {
      // The registry push will show the truth either way.
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={cn('flex flex-col gap-1', compact ? '' : 'py-1')}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn('h-2 w-2 shrink-0 rounded-full', DOT_COLOR[record.run.state])}
            aria-hidden
          />
          <span dir="ltr" className="text-fg truncate font-medium">
            {record.name}
          </span>
          <span
            className={cn(
              'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium',
              STATE_COLOR[record.run.state]
            )}
          >
            {t(`chat.process.state.${record.run.state}`)}
            {record.run.state === 'crashed' && record.run.exitCode !== null
              ? ` · ${t('chat.process.exitCode', { code: record.run.exitCode })}`
              : ''}
          </span>
          {record.origin.kind === 'adopted' && (
            <span className="bg-muted/20 text-muted inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs">
              {t('chat.process.adopted')}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {live && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void act('stop')}
              className={buttonClass}
            >
              {busy === 'stop' ? t('chat.process.stopping') : t('chat.process.stop')}
            </button>
          )}
          {record.origin.kind !== 'adopted' && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void act('restart')}
              className={buttonClass}
            >
              {busy === 'restart'
                ? t('chat.process.restarting')
                : live
                  ? t('chat.process.restart')
                  : t('chat.process.start')}
            </button>
          )}
        </div>
      </div>
      <div className="text-muted flex flex-wrap items-center gap-x-3 gap-y-0.5 ps-4 text-xs">
        {record.run.url ? (
          <a
            dir="ltr"
            href={record.run.url}
            onClick={(e) => {
              e.preventDefault()
              void window.api.browser.openExternal(record.run.url as string)
            }}
            className="text-accent cursor-pointer hover:underline"
          >
            {record.run.url}
          </a>
        ) : record.run.port ? (
          <span dir="ltr">{t('chat.process.port', { port: record.run.port })}</span>
        ) : null}
        {stampLabel && <span>{stampLabel}</span>}
        {record.run.restarts > 0 && (
          <span>{t('chat.process.restarts', { count: record.run.restarts })}</span>
        )}
        {record.autostart !== 'off' && (
          <span>{t(`chat.process.autostart.${record.autostart}`)}</span>
        )}
        {!compact && (
          <span dir="ltr" className="truncate font-mono opacity-70" title={record.command}>
            {record.command}
          </span>
        )}
      </div>
      {record.run.lastError && !live && (
        <div className="text-muted ps-4 text-xs" dir="auto">
          {record.run.lastError}
        </div>
      )}
    </div>
  )
}

export function ProcessCard({ snapshot }: { snapshot: ProcessCardSnapshot }): React.JSX.Element {
  const { t } = useTranslation()
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  const list = snapshot.processes
  const running = list.filter((r) => isLiveState(r.run.state)).length

  return (
    <div className="border-border bg-surface flex w-full max-w-[85%] flex-col gap-2 self-start rounded-2xl border px-4 py-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <ComputerTerminal01Icon size={15} className="text-muted shrink-0" aria-hidden />
          <span dir="auto" className="text-fg truncate font-medium">
            {snapshot.title ||
              (list.length === 1 ? t('chat.process.titleOne') : t('chat.process.title'))}
          </span>
        </div>
        {list.length > 1 && (
          <span className="text-muted shrink-0 text-xs tabular-nums">
            {t('chat.process.runningCount', { count: running, total: list.length })}
          </span>
        )}
      </div>
      {list.length === 0 ? (
        <div className="text-muted text-xs">{t('chat.process.empty')}</div>
      ) : (
        <div className="divide-border flex flex-col divide-y">
          {list.map((r) => (
            <ProcessRow key={r.id} record={r} now={now} />
          ))}
        </div>
      )}
    </div>
  )
}
