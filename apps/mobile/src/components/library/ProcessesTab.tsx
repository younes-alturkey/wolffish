import { ProcessRow } from '@/components/chat/ProcessCard'
import { Badge } from '@/components/core/Badge'
import { Button } from '@/components/core/Button'
import { ConfirmDialog } from '@/components/core/ConfirmDialog'
import { INPUT_TEXT_ALIGN, WRITING_DIRECTION, rtlPlaceholder } from '@/components/core/Input'
import { Input } from '@/components/core/Input'
import { Modal } from '@/components/core/Modal'
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Delete02Icon,
  Edit02Icon,
  File01Icon,
  Folder01Icon,
  Search01Icon
} from '@/components/core/icons'
import { DialogError } from '@/components/workspace/PromptSheet'
import {
  isLiveState,
  readProcessLogs,
  removeProcess,
  stopAllProcesses,
  updateProcess,
  useProcesses,
  type ProcessAutostart,
  type RestartPolicy
} from '@/lib/sync/processes'
import { useProjectsWritable } from '@/lib/sync/projects'
import type { SyncProcess } from '@/lib/tunnel/protocol'
import { cn } from '@/lib/utils/cn'
import { formatSignedRelative } from '@/lib/utils/relativeTime'
import { useToast } from '@/providers/toast/useToast'
import { useTokens } from '@/providers/theme/useTheme'
import { useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native'

/**
 * Processes — one tab of the Library screen, which owns the chrome around it;
 * this is the desktop's Processes page on one column. Every managed process
 * (a dev server the model started, a tunnel, a script, one it adopted),
 * grouped by working folder in collapsible sections, searchable and
 * filterable by state and autostart level. Stop / Restart / edit / remove are
 * the same desktop functions its page calls, over RPC; the registry's push
 * re-lists this phone, never local optimism.
 */

const AUTOSTART: ProcessAutostart[] = ['off', 'wolffish', 'system']
const RESTART: RestartPolicy[] = ['never', 'on-failure', 'always']

type StatusFilter = 'all' | 'running' | 'stopped' | 'crashed'
type AutostartFilter = 'all' | ProcessAutostart

function matchesStatus(r: SyncProcess, f: StatusFilter): boolean {
  if (f === 'all') return true
  if (f === 'running') return isLiveState(r.run.state)
  if (f === 'crashed') return r.run.state === 'crashed'
  return !isLiveState(r.run.state) && r.run.state !== 'crashed'
}

function shortFolder(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : cwd
}

/** One row of pills — the ModePills shape, for the autostart and restart controls. */
function Pills<T extends string>({
  value,
  options,
  labels,
  disabled,
  accessibilityLabel,
  onChange,
  raised = false
}: {
  value: T
  options: readonly T[]
  labels: (option: T) => string
  disabled?: boolean
  accessibilityLabel: string
  onChange: (next: T) => void
  /** On the page background the track is the cards' colour; inside a card it is the page's. */
  raised?: boolean
}): React.JSX.Element {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      className={cn(
        'border-border flex-row items-center self-start rounded-lg border p-0.5',
        raised ? 'bg-surface' : 'bg-bg'
      )}
    >
      {options.map((option) => {
        const selected = option === value
        return (
          <Pressable
            key={option}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled }}
            disabled={disabled || selected}
            onPress={() => onChange(option)}
            className={cn(
              'rounded-md px-2.5 py-1',
              selected ? 'bg-primary' : disabled ? 'opacity-40' : 'active:bg-border-soft'
            )}
          >
            <Text
              className={cn(
                'font-sans-medium text-[11px]',
                selected ? 'text-primary-fg' : 'text-muted'
              )}
            >
              {labels(option)}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

export function ProcessesTab(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const tokens = useTokens()
  const { data: records = [], isLoading, refetch } = useProcesses()
  const writable = useProjectsWritable()

  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [autostartFilter, setAutostartFilter] = useState<AutostartFilter>('all')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [editing, setEditing] = useState<SyncProcess | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<SyncProcess | null>(null)
  const [logsFor, setLogsFor] = useState<SyncProcess | null>(null)
  const [logText, setLogText] = useState('')
  const [bulk, setBulk] = useState<'stop' | 'delete' | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)

  useFocusEffect(
    useCallback(() => {
      void refetch()
    }, [refetch])
  )

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])

  // The log sheet polls gently while open: a running process writes, the
  // registry does not, so a change push alone would never refresh it.
  useEffect(() => {
    if (!logsFor) return
    let disposed = false
    const read = (): void => {
      void readProcessLogs(logsFor.name, 300)
        .then((text) => {
          if (!disposed) setLogText(text)
        })
        .catch(() => undefined)
    }
    read()
    const id = setInterval(read, 3000)
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
    const map = new Map<string, SyncProcess[]>()
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

  const fail = useCallback(
    (message?: string) => toast.show({ tone: 'error', message: message || t('processes.error') }),
    [t, toast]
  )

  const handleBulk = useCallback(async () => {
    if (bulkBusy) return
    setBulkBusy(true)
    try {
      if (bulk === 'stop') {
        const results = await stopAllProcesses()
        toast.show({
          tone: 'success',
          message: t('processes.stoppedCount', {
            count: results.filter((r) => r.stopped).length
          })
        })
      } else if (bulk === 'delete') {
        // Stop everything first, then forget every record — a failure partway
        // leaves nothing running that the list no longer shows.
        await stopAllProcesses()
        let removed = 0
        for (const r of records) {
          const res = await removeProcess(r.name).catch(() => ({ ok: false }))
          if (res.ok) removed++
        }
        toast.show({ tone: 'success', message: t('processes.removedCount', { count: removed }) })
      }
    } catch {
      fail()
    } finally {
      setBulkBusy(false)
      setBulk(null)
    }
  }, [bulk, bulkBusy, fail, records, t, toast])

  const handleDelete = useCallback(async () => {
    const target = deleteTarget
    if (!target) return
    try {
      const res = await removeProcess(target.name)
      if (res.ok)
        toast.show({ tone: 'success', message: t('processes.removed', { name: target.name }) })
      else fail(res.error)
    } catch {
      fail()
    }
    setDeleteTarget(null)
  }, [deleteTarget, fail, t, toast])

  const setAutostart = useCallback(
    async (record: SyncProcess, autostart: ProcessAutostart) => {
      if (record.autostart === autostart) return
      try {
        const res = await updateProcess({ name: record.name, autostart })
        if (!res.ok) fail(res.error)
        else if (res.warning) toast.show({ tone: 'info', message: res.warning })
      } catch {
        fail()
      }
    },
    [fail, toast]
  )

  const setRestart = useCallback(
    async (record: SyncProcess, restart: RestartPolicy) => {
      if (record.restart === restart) return
      try {
        const res = await updateProcess({ name: record.name, restart })
        if (!res.ok) fail(res.error)
      } catch {
        fail()
      }
    },
    [fail]
  )

  return (
    <>
      <View className="flex-row items-center justify-between gap-3">
        <View className="min-w-0 shrink flex-row items-center gap-2">
          <Text className="text-fg font-sans-semibold text-left text-base">
            {t('processes.title')}
          </Text>
          {!isLoading && (
            <Badge label={t('processes.runningBadge', { running, total: records.length })} />
          )}
        </View>
        {records.length > 0 && (
          <View className="shrink-0 flex-row items-center gap-2">
            {running > 0 && (
              <Button size="sm" variant="soft" disabled={!writable} onPress={() => setBulk('stop')}>
                {t('processes.stopAll')}
              </Button>
            )}
            <Button
              size="sm"
              variant="dangerSoft"
              disabled={!writable}
              onPress={() => setBulk('delete')}
            >
              {t('processes.deleteAll')}
            </Button>
          </View>
        )}
      </View>

      {!isLoading && records.length > 0 && (
        <View className="flex-col gap-2">
          <View className="border-border bg-surface h-10 flex-row items-center gap-2 rounded-lg border px-3">
            <Search01Icon size={15} className="text-muted" />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={rtlPlaceholder(t('processes.searchPlaceholder'))}
              placeholderTextColor={tokens.muted}
              selectionColor={tokens.accent}
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              style={WRITING_DIRECTION}
              className={cn('text-fg h-10 flex-1 font-sans text-sm', INPUT_TEXT_ALIGN)}
            />
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View className="flex-row items-center gap-2">
              <Pills
                value={status}
                options={['all', 'running', 'stopped', 'crashed'] as const}
                labels={(f) => t(`processes.status.${f}`)}
                accessibilityLabel={t('processes.status.all')}
                onChange={setStatus}
                raised
              />
              <Pills
                value={autostartFilter}
                options={['all', 'off', 'wolffish', 'system'] as const}
                labels={(f) =>
                  f === 'all' ? t('processes.status.all') : t(`processes.autostart.${f}`)
                }
                accessibilityLabel={t('processes.autostartLabel')}
                onChange={setAutostartFilter}
                raised
              />
            </View>
          </ScrollView>
        </View>
      )}

      {isLoading ? (
        <Text className="text-muted py-10 text-center font-sans text-sm">
          {t('common.loading')}
        </Text>
      ) : records.length === 0 ? (
        <View className="border-border rounded-2xl border border-dashed px-6 py-12">
          <Text className="text-muted text-center font-sans text-sm">
            {writable ? t('processes.empty') : t('processes.offline')}
          </Text>
        </View>
      ) : groups.length === 0 ? (
        <View className="border-border rounded-2xl border border-dashed px-6 py-12">
          <Text className="text-muted text-center font-sans text-sm">
            {t('processes.noMatches')}
          </Text>
        </View>
      ) : (
        <View className="flex-col gap-4">
          {groups.map(([cwd, list]) => {
            const open = !collapsed.has(cwd)
            const Chevron = open ? ArrowDown01Icon : ArrowRight01Icon
            const live = list.filter((r) => isLiveState(r.run.state)).length
            return (
              <View key={cwd} className="flex-col gap-2">
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: open }}
                  onPress={() => toggleGroup(cwd)}
                  className="bg-surface border-border flex-row items-center gap-2 rounded-xl border px-3 py-2 active:bg-border-soft"
                >
                  <Chevron size={14} className="text-muted" />
                  <Folder01Icon size={15} className="text-muted" />
                  <Text
                    numberOfLines={1}
                    className="text-fg font-sans-medium min-w-0 shrink text-sm"
                    style={{ writingDirection: 'ltr' }}
                  >
                    {shortFolder(cwd)}
                  </Text>
                  <View className="ms-auto shrink-0">
                    <Badge
                      variant={live > 0 ? 'success' : 'default'}
                      label={t('processes.groupCount', { running: live, total: list.length })}
                    />
                  </View>
                </Pressable>
                {open && (
                  <View className="flex-col gap-3">
                    {list.map((record) => {
                      const isLive = isLiveState(record.run.state)
                      return (
                        <View
                          key={record.id ?? record.name}
                          className={cn(
                            'bg-surface border-border flex-col gap-2.5 rounded-2xl border px-4 py-3',
                            !isLive && record.run.state !== 'crashed' && 'opacity-80'
                          )}
                        >
                          <View className="flex-row items-start justify-between gap-2">
                            <View className="min-w-0 flex-1">
                              <ProcessRow record={record} now={now} compact readOnly={!writable} />
                            </View>
                          </View>

                          {/* The command, in a code block, as on the desktop card. */}
                          <View className="bg-bg border-border rounded-lg border px-3 py-2">
                            <Text
                              selectable
                              numberOfLines={3}
                              className="text-fg font-mono text-[11px] leading-4"
                              style={{ writingDirection: 'ltr' }}
                            >
                              {record.command}
                            </Text>
                          </View>

                          <View className="flex-col gap-2">
                            <View className="flex-row flex-wrap items-center gap-2">
                              <Text className="text-muted font-sans text-[11px]">
                                {t('processes.autostartLabel')}
                              </Text>
                              <Pills
                                value={record.autostart}
                                options={AUTOSTART}
                                labels={(m) => t(`processes.autostart.${m}`)}
                                disabled={!writable}
                                accessibilityLabel={t('processes.autostartLabel')}
                                onChange={(m) => void setAutostart(record, m)}
                              />
                            </View>
                            <View className="flex-row flex-wrap items-center gap-2">
                              <Text className="text-muted font-sans text-[11px]">
                                {t('processes.restartLabel')}
                              </Text>
                              <Pills
                                value={record.restart}
                                options={RESTART}
                                labels={(p) => t(`processes.restart.${p}`)}
                                disabled={!writable}
                                accessibilityLabel={t('processes.restartLabel')}
                                onChange={(p) => void setRestart(record, p)}
                              />
                            </View>
                          </View>

                          {/* Facts, then the row's own actions at the end. */}
                          <View className="flex-row items-center justify-between gap-2">
                            <Text
                              numberOfLines={1}
                              className="text-muted min-w-0 shrink text-left font-sans text-[11px]"
                            >
                              {[
                                record.run.pid && isLive
                                  ? t('processes.pid', { pid: record.run.pid })
                                  : null,
                                t('processes.createdAt', {
                                  time: formatSignedRelative(record.createdAt, now, t)
                                })
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </Text>
                            <View className="shrink-0 flex-row items-center">
                              {record.run.logPath ? (
                                <Pressable
                                  accessibilityRole="button"
                                  accessibilityLabel={t('processes.logs')}
                                  hitSlop={6}
                                  onPress={() => {
                                    setLogText('')
                                    setLogsFor(record)
                                  }}
                                  className="h-8 w-8 items-center justify-center rounded-lg active:bg-border-soft"
                                >
                                  <File01Icon size={15} className="text-muted" />
                                </Pressable>
                              ) : null}
                              <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={t('processes.edit')}
                                hitSlop={6}
                                onPress={() => setEditing(record)}
                                className="h-8 w-8 items-center justify-center rounded-lg active:bg-border-soft"
                              >
                                <Edit02Icon size={15} className="text-muted" />
                              </Pressable>
                              <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={t('processes.remove')}
                                hitSlop={6}
                                disabled={!writable}
                                onPress={() => setDeleteTarget(record)}
                                className={cn(
                                  'h-8 w-8 items-center justify-center rounded-lg',
                                  writable ? 'active:bg-border-soft' : 'opacity-40'
                                )}
                              >
                                <Delete02Icon size={15} className="text-muted" />
                              </Pressable>
                            </View>
                          </View>
                        </View>
                      )
                    })}
                  </View>
                )}
              </View>
            )
          })}
          {filtering && (
            <Text className="text-muted text-center font-sans text-[11px]">
              {t('processes.showingCount', { shown: filtered.length, total: records.length })}
            </Text>
          )}
        </View>
      )}

      <ProcessEditor record={editing} readOnly={!writable} onClose={() => setEditing(null)} />

      <ConfirmDialog
        open={bulk !== null}
        title={bulk === 'delete' ? t('processes.deleteAllTitle') : t('processes.stopAllTitle')}
        message={
          bulk === 'delete'
            ? t('processes.deleteAllConfirm', { count: records.length, running })
            : t('processes.stopAllConfirm', { count: running })
        }
        confirmLabel={bulk === 'delete' ? t('processes.deleteAll') : t('processes.stopAll')}
        cancelLabel={t('processes.cancel')}
        busy={bulkBusy}
        onConfirm={() => void handleBulk()}
        onCancel={() => setBulk(null)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('processes.removeTitle')}
        message={t('processes.removeConfirm', { name: deleteTarget?.name ?? '' })}
        confirmLabel={t('processes.remove')}
        cancelLabel={t('processes.cancel')}
        onConfirm={() => void handleDelete()}
        onCancel={() => setDeleteTarget(null)}
      />

      <Modal
        open={logsFor !== null}
        onClose={() => setLogsFor(null)}
        title={logsFor ? t('processes.logsTitle', { name: logsFor.name }) : ''}
        footer={
          <View className="flex-row justify-end">
            <Button size="sm" variant="ghost" onPress={() => setLogsFor(null)}>
              {t('processes.done')}
            </Button>
          </View>
        }
      >
        <ScrollView className="bg-bg border-border max-h-96 rounded-lg border" horizontal={false}>
          <Text
            selectable
            className="text-fg p-3 font-mono text-[11px] leading-4"
            style={{ writingDirection: 'ltr', textAlign: 'left' }}
          >
            {logText || t('processes.logsEmpty')}
          </Text>
        </ScrollView>
      </Modal>
    </>
  )
}

function ProcessEditor({
  record,
  readOnly,
  onClose
}: {
  record: SyncProcess | null
  readOnly: boolean
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  // Reported inline rather than as a toast — see DialogError.
  const [error, setError] = useState<string | null>(null)
  const [command, setCommand] = useState('')
  const [cwd, setCwd] = useState('')
  const [restart, setRestart] = useState<RestartPolicy>('on-failure')
  const [onQuit, setOnQuit] = useState<'keep' | 'stop'>('keep')
  const [saving, setSaving] = useState(false)

  // Seed from the record each time the sheet opens on one.
  useEffect(() => {
    if (!record) return
    setError(null)
    setCommand(record.command)
    setCwd(record.cwd)
    setRestart(record.restart)
    setOnQuit(record.onQuit)
  }, [record])

  const save = async (): Promise<void> => {
    if (!record || saving) return
    setSaving(true)
    setError(null)
    try {
      const live = isLiveState(record.run.state)
      const res = await updateProcess({
        name: record.name,
        command: command.trim() !== record.command ? command.trim() : undefined,
        cwd: cwd.trim() !== record.cwd ? cwd.trim() : undefined,
        restart: restart !== record.restart ? restart : undefined,
        onQuit: onQuit !== record.onQuit ? onQuit : undefined
      })
      if (!res.ok) {
        setError(res.error ?? t('processes.error'))
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
    } catch {
      setError(t('processes.error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={record !== null}
      onClose={onClose}
      title={record ? t('processes.editTitle', { name: record.name }) : ''}
      footer={
        <View className="flex-row justify-end gap-2">
          <Button size="sm" variant="ghost" onPress={onClose}>
            {t('processes.cancel')}
          </Button>
          <Button
            size="sm"
            disabled={readOnly || saving || !command.trim()}
            onPress={() => void save()}
          >
            {t('processes.save')}
          </Button>
        </View>
      }
    >
      <View className="flex-col gap-3">
        <Input
          label={t('processes.command')}
          value={command}
          editable={!readOnly}
          onChangeText={setCommand}
          autoCapitalize="none"
          autoCorrect={false}
          className="font-mono"
        />
        <Input
          label={t('processes.cwd')}
          value={cwd}
          editable={!readOnly}
          onChangeText={setCwd}
          autoCapitalize="none"
          autoCorrect={false}
          className="font-mono"
        />
        <View className="flex-col gap-1.5">
          <Text className="text-muted font-sans-medium text-left text-sm">
            {t('processes.restartLabel')}
          </Text>
          <Pills
            value={restart}
            options={RESTART}
            labels={(p) => t(`processes.restart.${p}`)}
            disabled={readOnly}
            accessibilityLabel={t('processes.restartLabel')}
            onChange={setRestart}
          />
        </View>
        <View className="flex-col gap-1.5">
          <Text className="text-muted font-sans-medium text-left text-sm">
            {t('processes.onQuitLabel')}
          </Text>
          <Pills
            value={onQuit}
            options={['keep', 'stop'] as const}
            labels={(v) => t(`processes.onQuit.${v}`)}
            disabled={readOnly}
            accessibilityLabel={t('processes.onQuitLabel')}
            onChange={setOnQuit}
          />
        </View>
        <DialogError message={error} />
        <Text className="text-muted text-left font-sans text-xs">{t('processes.portHint')}</Text>
      </View>
    </Modal>
  )
}
