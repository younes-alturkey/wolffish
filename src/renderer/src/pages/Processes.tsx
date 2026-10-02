import { CardFact, CardFacts } from '@components/common/card-facts/CardFacts'
import { formatDuration, formatRelative, isLiveState } from '@components/common/process-card/format'
import { Badge, type BadgeVariant } from '@components/core/Badge'
import { Button } from '@components/core/Button'
import { Modal } from '@components/core/Modal'
import { useToast } from '@components/core/toast/useToast'
import { cn } from '@lib/utils/cn'
import type { ProcessAutostart, ProcessRecord, ProcessState, RestartPolicy } from '@preload/index'
import { useLocale } from '@providers/locale/useLocale'
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Clock01Icon,
  ComputerTerminal01Icon,
  Delete02Icon,
  Edit02Icon,
  File01Icon,
  Folder01Icon,
  Link01Icon,
  PlayIcon,
  RefreshIcon,
  RepeatIcon,
  Search01Icon,
  StopIcon
} from 'hugeicons-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

const iconButtonClass = cn(
  'text-muted flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg',
  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
  'disabled:cursor-not-allowed disabled:opacity-40'
)

const fieldClass =
  'border-border bg-bg text-fg w-full rounded-lg border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none'

const chipGroupClass = 'border-border bg-surface inline-flex items-center rounded-lg border p-0.5'
const chipClass = (selected: boolean): string =>
  cn(
    'cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium',
    'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
    selected ? 'bg-primary text-primary-fg' : 'text-muted hover:text-fg'
  )

const AUTOSTART: ProcessAutostart[] = ['off', 'wolffish', 'system']
const RESTART: RestartPolicy[] = ['never', 'on-failure', 'always']

type StatusFilter = 'all' | 'running' | 'stopped' | 'crashed'
type AutostartFilter = 'all' | ProcessAutostart

const STATE_BADGE: Record<ProcessState, BadgeVariant> = {
  starting: 'primary',
  running: 'success',
  stopping: 'default',
  stopped: 'default',
  exited: 'default',
  crashed: 'danger'
}

function matchesStatus(r: ProcessRecord, f: StatusFilter): boolean {
  if (f === 'all') return true
  if (f === 'running') return isLiveState(r.run.state)
  if (f === 'crashed') return r.run.state === 'crashed'
  return !isLiveState(r.run.state) && r.run.state !== 'crashed'
}

function shortFolder(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : cwd
}

/**
 * Processes — one tab of the Library page. Every process the manager knows
 * (started by the model, by the shell's background path, or adopted),
 * grouped by working folder in collapsible sections, searchable, filterable
 * by state and autostart level, on cards shaped like the automations cards:
 * identity row with the actions at the end, a controls row, a facts row.
 * The list is the registry itself: `processes:changed` re-fetches on every
 * write, whoever wrote it.
 */
export function Processes(): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const toast = useToast()
  const [records, setRecords] = useState<ProcessRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [autostartFilter, setAutostartFilter] = useState<AutostartFilter>('all')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [editing, setEditing] = useState<ProcessRecord | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ProcessRecord | null>(null)
  const [bulk, setBulk] = useState<'stop' | 'delete' | null>(null)
  const [logsFor, setLogsFor] = useState<ProcessRecord | null>(null)
  const [logText, setLogText] = useState('')
  const [busy, setBusy] = useState<Record<string, 'stop' | 'restart' | undefined>>({})
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  const refresh = useCallback((): void => {
    void window.api.processes
      .list()
      .then((list) => {
        setRecords(list)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    refresh()
    return window.api.processes.onChanged(refresh)
  }, [refresh])

  // The log drawer polls gently while open: a running process writes, the
  // registry does not, so a change push alone would never refresh it.
  useEffect(() => {
    if (!logsFor) return
    let disposed = false
    const read = (): void => {
      void window.api.processes.logs(logsFor.name, 300).then((text) => {
        if (!disposed) setLogText(text)
      })
    }
    read()
    const id = setInterval(read, 2000)
    return () => {
      disposed = true
      clearInterval(id)
    }
  }, [logsFor])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return records.filter(
      (r) =>
        matchesStatus(r, status) &&
        (autostartFilter === 'all' || r.autostart === autostartFilter) &&
        (!q ||
          r.name.toLowerCase().includes(q) ||
          r.command.toLowerCase().includes(q) ||
          r.cwd.toLowerCase().includes(q) ||
          (r.run.url ?? '').toLowerCase().includes(q))
    )
  }, [records, query, status, autostartFilter])

  const groups = useMemo(() => {
    const map = new Map<string, ProcessRecord[]>()
    for (const r of filtered) {
      const list = map.get(r.cwd) ?? []
      list.push(r)
      map.set(r.cwd, list)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [filtered])

  const running = records.filter((r) => isLiveState(r.run.state)).length
  const filtering = query.trim() !== '' || status !== 'all' || autostartFilter !== 'all'

  const toggleGroup = useCallback((cwd: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(cwd)) next.delete(cwd)
      else next.add(cwd)
      return next
    })
  }, [])

  const act = useCallback(
    async (record: ProcessRecord, kind: 'stop' | 'restart') => {
      if (busy[record.name]) return
      setBusy((prev) => ({ ...prev, [record.name]: kind }))
      try {
        const res =
          kind === 'stop'
            ? await window.api.processes.stop(record.name)
            : await window.api.processes.restart(record.name)
        if (!res.ok) toast.show({ tone: 'error', message: res.error ?? t('processes.error') })
      } catch {
        toast.show({ tone: 'error', message: t('processes.error') })
      } finally {
        setBusy((prev) => ({ ...prev, [record.name]: undefined }))
      }
    },
    [busy, t, toast]
  )

  const handleStopAll = useCallback(async () => {
    setBulk(null)
    const results = await window.api.processes.stopAll()
    toast.show({
      tone: 'success',
      message: t('processes.stoppedCount', { count: results.filter((r) => r.stopped).length })
    })
  }, [t, toast])

  // Stop everything first, then forget every record — a remove on a live
  // process stops it anyway, but doing the stops up front means a failure
  // partway leaves nothing running that the page no longer lists.
  const handleDeleteAll = useCallback(async () => {
    setBulk(null)
    await window.api.processes.stopAll()
    let removed = 0
    for (const r of records) {
      const res = await window.api.processes.remove(r.name)
      if (res.ok) removed++
    }
    toast.show({ tone: 'success', message: t('processes.removedCount', { count: removed }) })
  }, [records, t, toast])

  const handleDelete = useCallback(async () => {
    const target = deleteTarget
    if (!target) return
    const res = await window.api.processes.remove(target.name)
    if (res.ok)
      toast.show({ tone: 'success', message: t('processes.removed', { name: target.name }) })
    else toast.show({ tone: 'error', message: res.error ?? t('processes.error') })
    setDeleteTarget(null)
  }, [deleteTarget, t, toast])

  const setAutostart = useCallback(
    async (record: ProcessRecord, autostart: ProcessAutostart) => {
      if (record.autostart === autostart) return
      const res = await window.api.processes.update({ name: record.name, autostart })
      if (!res.ok) toast.show({ tone: 'error', message: res.error ?? t('processes.error') })
      else if (res.warning) toast.show({ tone: 'info', message: res.warning })
    },
    [t, toast]
  )

  const setRestart = useCallback(
    async (record: ProcessRecord, restart: RestartPolicy) => {
      if (record.restart === restart) return
      const res = await window.api.processes.update({ name: record.name, restart })
      if (!res.ok) toast.show({ tone: 'error', message: res.error ?? t('processes.error') })
    },
    [t, toast]
  )

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-10">
          <header className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <h1 className="text-fg text-2xl font-semibold tracking-tight">
                  {t('processes.title')}
                </h1>
                {!loading && (
                  <Badge variant="default" size="sm">
                    {t('processes.runningBadge', { running, total: records.length })}
                  </Badge>
                )}
              </div>
              <p className="text-muted text-sm leading-relaxed">{t('processes.subtitle')}</p>
            </div>
            {records.length > 0 && (
              <div className="flex shrink-0 items-center gap-2">
                {running > 0 && (
                  <Button size="sm" variant="outline" onClick={() => setBulk('stop')}>
                    {t('processes.stopAll')}
                  </Button>
                )}
                <Button size="sm" variant="danger" onClick={() => setBulk('delete')}>
                  {t('processes.deleteAll')}
                </Button>
              </div>
            )}
          </header>

          {/* Search leads, the two filter groups trail; both wrap on a narrow
              window without the search losing its width. */}
          {!loading && records.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="relative min-w-[220px] flex-1">
                <Search01Icon
                  size={15}
                  aria-hidden
                  className="text-muted pointer-events-none absolute start-3 top-1/2 -translate-y-1/2"
                />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('processes.searchPlaceholder')}
                  aria-label={t('processes.searchPlaceholder')}
                  className={cn(fieldClass, 'ps-9')}
                />
              </label>
              <div
                role="radiogroup"
                aria-label={t('processes.filterStatus')}
                className={chipGroupClass}
              >
                {(['all', 'running', 'stopped', 'crashed'] as StatusFilter[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    role="radio"
                    aria-checked={status === f}
                    onClick={() => setStatus(f)}
                    className={chipClass(status === f)}
                  >
                    {t(`processes.status.${f}`)}
                  </button>
                ))}
              </div>
              <div
                role="radiogroup"
                aria-label={t('processes.autostartLabel')}
                className={chipGroupClass}
              >
                {(['all', 'off', 'wolffish', 'system'] as AutostartFilter[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    role="radio"
                    aria-checked={autostartFilter === f}
                    onClick={() => setAutostartFilter(f)}
                    className={chipClass(autostartFilter === f)}
                  >
                    {f === 'all' ? t('processes.status.all') : t(`processes.autostart.${f}`)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {loading ? (
            <div className="text-muted py-10 text-center text-sm">{t('common.loading')}</div>
          ) : records.length === 0 ? (
            <div className="border-border text-muted rounded-2xl border border-dashed px-6 py-12 text-center text-sm">
              {t('processes.empty')}
            </div>
          ) : groups.length === 0 ? (
            <div className="border-border text-muted rounded-2xl border border-dashed px-6 py-12 text-center text-sm">
              {t('processes.noMatches')}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {groups.map(([cwd, list]) => {
                const open = !collapsed.has(cwd)
                const Chevron = open ? ArrowDown01Icon : ArrowRight01Icon
                const live = list.filter((r) => isLiveState(r.run.state)).length
                return (
                  <section key={cwd} className="flex flex-col gap-2">
                    <button
                      type="button"
                      onClick={() => toggleGroup(cwd)}
                      aria-expanded={open}
                      title={cwd}
                      className={cn(
                        'bg-surface border-border text-fg flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-start text-sm',
                        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
                      )}
                    >
                      <Chevron size={14} className="text-muted shrink-0" aria-hidden />
                      <Folder01Icon size={15} className="text-muted shrink-0" aria-hidden />
                      <span dir="ltr" className="min-w-0 truncate font-medium">
                        {shortFolder(cwd)}
                      </span>
                      <span
                        dir="ltr"
                        className="text-muted hidden min-w-0 truncate text-xs sm:inline"
                      >
                        {cwd}
                      </span>
                      <Badge
                        variant={live > 0 ? 'success' : 'default'}
                        size="sm"
                        className="ms-auto shrink-0"
                      >
                        {t('processes.groupCount', { running: live, total: list.length })}
                      </Badge>
                    </button>
                    {open && (
                      <ul className="flex flex-col gap-3">
                        {list.map((record) => {
                          const isLive = isLiveState(record.run.state)
                          const pending = busy[record.name]
                          const stamp = isLive ? record.run.startedAt : record.run.endedAt
                          return (
                            <li key={record.id} className="min-w-0">
                              <div
                                className={cn(
                                  'bg-surface border-border flex w-full flex-col gap-3 rounded-2xl border p-4 text-start',
                                  !isLive && record.run.state !== 'crashed' && 'opacity-80'
                                )}
                              >
                                {/* Identity row: tile, name + state, actions at the end. */}
                                <div className="flex w-full min-w-0 items-center gap-2.5">
                                  <span
                                    aria-hidden
                                    className="border-border bg-bg flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border"
                                  >
                                    <ComputerTerminal01Icon size={17} className="text-muted" />
                                  </span>
                                  <span className="text-fg flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold">
                                    <bdi dir="ltr" className="min-w-0 truncate">
                                      {record.name}
                                    </bdi>
                                    <Badge
                                      variant={STATE_BADGE[record.run.state]}
                                      size="sm"
                                      className="shrink-0"
                                    >
                                      {t(`chat.process.state.${record.run.state}`)}
                                      {record.run.state === 'crashed' &&
                                      record.run.exitCode !== null
                                        ? ` · ${t('chat.process.exitCode', { code: record.run.exitCode })}`
                                        : ''}
                                    </Badge>
                                    {record.origin.kind === 'adopted' && (
                                      <Badge variant="default" size="sm" className="shrink-0">
                                        {t('chat.process.adopted')}
                                      </Badge>
                                    )}
                                  </span>
                                  <div className="flex shrink-0 items-center">
                                    {isLive && (
                                      <button
                                        type="button"
                                        onClick={() => void act(record, 'stop')}
                                        disabled={!!pending}
                                        aria-label={t('chat.process.stop')}
                                        title={t('chat.process.stop')}
                                        className={cn(iconButtonClass, 'hover:text-rose-500')}
                                      >
                                        <StopIcon size={16} />
                                      </button>
                                    )}
                                    {record.origin.kind !== 'adopted' && (
                                      <button
                                        type="button"
                                        onClick={() => void act(record, 'restart')}
                                        disabled={!!pending}
                                        aria-label={
                                          isLive
                                            ? t('chat.process.restart')
                                            : t('chat.process.start')
                                        }
                                        title={
                                          isLive
                                            ? t('chat.process.restart')
                                            : t('chat.process.start')
                                        }
                                        className={cn(
                                          iconButtonClass,
                                          'hover:text-emerald-600 dark:hover:text-emerald-400'
                                        )}
                                      >
                                        {isLive ? (
                                          <RefreshIcon size={16} />
                                        ) : (
                                          <PlayIcon size={16} />
                                        )}
                                      </button>
                                    )}
                                    <span
                                      aria-hidden
                                      className="bg-border mx-1 h-4 w-px shrink-0"
                                    />
                                    {record.run.logPath && (
                                      <button
                                        type="button"
                                        onClick={() => setLogsFor(record)}
                                        aria-label={t('processes.logs')}
                                        title={t('processes.logs')}
                                        className={cn(iconButtonClass, 'hover:text-fg')}
                                      >
                                        <File01Icon size={15} />
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => setEditing(record)}
                                      aria-label={t('processes.edit')}
                                      title={t('processes.edit')}
                                      className={cn(iconButtonClass, 'hover:text-fg')}
                                    >
                                      <Edit02Icon size={15} />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setDeleteTarget(record)}
                                      aria-label={t('processes.remove')}
                                      title={t('processes.remove')}
                                      className={cn(iconButtonClass, 'hover:text-rose-500')}
                                    >
                                      <Delete02Icon size={15} />
                                    </button>
                                  </div>
                                </div>

                                {/* Where it is: the URL when it has one, always the command. */}
                                <div className="flex w-full min-w-0 flex-col gap-1 text-xs">
                                  {record.run.url ? (
                                    <a
                                      dir="ltr"
                                      href={record.run.url}
                                      onClick={(e) => {
                                        e.preventDefault()
                                        void window.api.browser.openExternal(
                                          record.run.url as string
                                        )
                                      }}
                                      className="text-accent inline-flex w-fit max-w-full cursor-pointer items-center gap-1 hover:underline"
                                    >
                                      <Link01Icon size={12} aria-hidden className="shrink-0" />
                                      <span className="truncate">{record.run.url}</span>
                                    </a>
                                  ) : record.run.port ? (
                                    <span dir="ltr" className="text-muted">
                                      {t('chat.process.port', { port: record.run.port })}
                                    </span>
                                  ) : null}
                                  <pre
                                    dir="ltr"
                                    title={record.command}
                                    className="bg-bg border-border text-fg max-h-24 w-full overflow-auto rounded-lg border px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all"
                                  >
                                    {record.command}
                                  </pre>
                                  {record.run.lastError && !isLive && (
                                    <span dir="auto" className="text-muted">
                                      {record.run.lastError}
                                    </span>
                                  )}
                                </div>

                                {/* Controls row: autostart level, restart policy. */}
                                <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                                  <div className="flex items-center gap-2">
                                    <span className="text-muted">
                                      {t('processes.autostartLabel')}
                                    </span>
                                    <div
                                      role="radiogroup"
                                      aria-label={t('processes.autostartLabel')}
                                      className={chipGroupClass}
                                    >
                                      {AUTOSTART.map((mode) => (
                                        <button
                                          key={mode}
                                          type="button"
                                          role="radio"
                                          aria-checked={record.autostart === mode}
                                          onClick={() => void setAutostart(record, mode)}
                                          className={chipClass(record.autostart === mode)}
                                        >
                                          {t(`processes.autostart.${mode}`)}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-muted">
                                      {t('processes.restartLabel')}
                                    </span>
                                    <div
                                      role="radiogroup"
                                      aria-label={t('processes.restartLabel')}
                                      className={chipGroupClass}
                                    >
                                      {RESTART.map((policy) => (
                                        <button
                                          key={policy}
                                          type="button"
                                          role="radio"
                                          aria-checked={record.restart === policy}
                                          onClick={() => void setRestart(record, policy)}
                                          className={chipClass(record.restart === policy)}
                                        >
                                          {t(`processes.restart.${policy}`)}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                </div>

                                {/* Facts row: uptime or end, restarts, pid, added. */}
                                <CardFacts>
                                  {stamp && (
                                    <CardFact
                                      icon={<Clock01Icon size={12} />}
                                      title={new Date(stamp).toLocaleString(locale)}
                                    >
                                      {isLive
                                        ? t('chat.process.since', {
                                            time: formatDuration(now - stamp, locale)
                                          })
                                        : t('chat.process.endedAt', {
                                            time: formatRelative(stamp, now, locale)
                                          })}
                                    </CardFact>
                                  )}
                                  {record.run.restarts > 0 && (
                                    <CardFact icon={<RepeatIcon size={12} />}>
                                      {t('chat.process.restarts', { count: record.run.restarts })}
                                    </CardFact>
                                  )}
                                  {record.run.pid && isLive && (
                                    <CardFact icon={<ComputerTerminal01Icon size={12} />}>
                                      {t('processes.pid', { pid: record.run.pid })}
                                    </CardFact>
                                  )}
                                  <CardFact icon={<Edit02Icon size={12} />}>
                                    {t('processes.createdAt', {
                                      time: formatRelative(record.createdAt, now, locale)
                                    })}
                                  </CardFact>
                                </CardFacts>
                              </div>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </section>
                )
              })}
              {filtering && (
                <p className="text-muted text-center text-xs">
                  {t('processes.showingCount', { shown: filtered.length, total: records.length })}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {editing && <EditDialog record={editing} onClose={() => setEditing(null)} />}

      <Modal
        open={bulk !== null}
        onClose={() => setBulk(null)}
        title={bulk === 'delete' ? t('processes.deleteAllTitle') : t('processes.stopAllTitle')}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setBulk(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => void (bulk === 'delete' ? handleDeleteAll() : handleStopAll())}
            >
              {bulk === 'delete' ? t('processes.deleteAll') : t('processes.stopAll')}
            </Button>
          </div>
        }
      >
        <p className="text-muted text-sm">
          {bulk === 'delete'
            ? t('processes.deleteAllConfirm', { count: records.length, running })
            : t('processes.stopAllConfirm', { count: running })}
        </p>
      </Modal>

      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={t('processes.removeTitle')}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" size="sm" onClick={() => void handleDelete()}>
              {t('processes.remove')}
            </Button>
          </div>
        }
      >
        <p className="text-muted text-sm">
          {t('processes.removeConfirm', { name: deleteTarget?.name ?? '' })}
        </p>
      </Modal>

      <Modal
        open={logsFor !== null}
        onClose={() => setLogsFor(null)}
        title={logsFor ? t('processes.logsTitle', { name: logsFor.name }) : ''}
        className="max-w-3xl"
      >
        <pre
          dir="ltr"
          className="bg-bg border-border text-fg max-h-[60vh] overflow-auto rounded-lg border p-3 font-mono text-xs whitespace-pre-wrap"
        >
          {logText || t('processes.logsEmpty')}
        </pre>
      </Modal>
    </>
  )
}

function EditDialog({
  record,
  onClose
}: {
  record: ProcessRecord
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const [command, setCommand] = useState(record.command)
  const [cwd, setCwd] = useState(record.cwd)
  const [restart, setRestart] = useState<RestartPolicy>(record.restart)
  const [onQuit, setOnQuit] = useState<'keep' | 'stop'>(record.onQuit)
  const [saving, setSaving] = useState(false)
  const live = isLiveState(record.run.state)

  const save = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    const res = await window.api.processes.update({
      name: record.name,
      command: command.trim() !== record.command ? command.trim() : undefined,
      cwd: cwd.trim() !== record.cwd ? cwd.trim() : undefined,
      restart: restart !== record.restart ? restart : undefined,
      onQuit: onQuit !== record.onQuit ? onQuit : undefined
    })
    setSaving(false)
    if (!res.ok) {
      toast.show({ tone: 'error', message: res.error ?? t('processes.error') })
      return
    }
    toast.show({
      tone: 'success',
      message:
        live && (command.trim() !== record.command || cwd.trim() !== record.cwd)
          ? t('processes.savedRestartHint')
          : t('processes.saved')
    })
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('processes.editTitle', { name: record.name })}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving || !command.trim()}>
            {t('common.save')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-muted text-xs">{t('processes.command')}</span>
          <input
            dir="ltr"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            className={cn(fieldClass, 'font-mono')}
            spellCheck={false}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted text-xs">{t('processes.cwd')}</span>
          <input
            dir="ltr"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            className={cn(fieldClass, 'font-mono')}
            spellCheck={false}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-muted text-xs">{t('processes.restartLabel')}</span>
            <select
              value={restart}
              onChange={(e) => setRestart(e.target.value as RestartPolicy)}
              className={fieldClass}
            >
              {RESTART.map((r) => (
                <option key={r} value={r}>
                  {t(`processes.restart.${r}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted text-xs">{t('processes.onQuitLabel')}</span>
            <select
              value={onQuit}
              onChange={(e) => setOnQuit(e.target.value as 'keep' | 'stop')}
              className={fieldClass}
            >
              <option value="keep">{t('processes.onQuit.keep')}</option>
              <option value="stop">{t('processes.onQuit.stop')}</option>
            </select>
          </label>
        </div>
        <p className="text-muted text-xs">{t('processes.portHint')}</p>
      </div>
    </Modal>
  )
}
