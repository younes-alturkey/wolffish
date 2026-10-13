import { ComputerTerminal01Icon, PlayIcon, RefreshIcon, StopIcon } from '@/components/core/icons'
import type { ProcessCardSnapshot } from '@/lib/conversations/types'
import type { SyncProcess } from '@/lib/tunnel/protocol'
import { cn } from '@/lib/utils/cn'
import { formatRelativeTime, formatSignedRelative } from '@/lib/utils/relativeTime'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, Text, View } from 'react-native'
import * as WebBrowser from 'expo-web-browser'

/**
 * The live process card — the mobile twin of the desktop's ProcessCard.
 * Fully deterministic: which processes it shows and what state they are in
 * come from the desktop's ProcessCardSnapshot (a `process_show` the model
 * chose to make); snapshots replace each other by cardId upstream
 * (segments.ts fold live, the process.card push after the turn ended), so a
 * live turn and a reloaded conversation render identically.
 *
 * Stop and Restart are the same desktop functions the Library tab and the
 * model's tools call, reached over RPC; the registry's own push is what
 * re-renders the card, never local optimism. Times are relative and come from
 * the shared units table, re-derived every 30 s.
 */

type ProcessState = SyncProcess['run']['state']

const STATE_TONE: Record<ProcessState, { container: string; text: string; dot: string }> = {
  starting: { container: 'bg-primary-soft', text: 'text-primary', dot: 'bg-primary' },
  running: {
    container: 'bg-emerald-500/15',
    text: 'text-emerald-600 dark:text-emerald-400',
    dot: 'bg-emerald-500'
  },
  stopping: { container: 'bg-border-soft', text: 'text-muted', dot: 'bg-muted' },
  stopped: { container: 'bg-border-soft', text: 'text-muted', dot: 'bg-muted' },
  exited: { container: 'bg-border-soft', text: 'text-muted', dot: 'bg-muted' },
  crashed: { container: 'bg-red-500/15', text: 'text-red-600 dark:text-red-400', dot: 'bg-red-500' }
}

function isLive(state: ProcessState): boolean {
  return state === 'starting' || state === 'running' || state === 'stopping'
}

export function ProcessRow({
  record,
  now,
  compact = false,
  readOnly = false
}: {
  record: SyncProcess
  now: number
  compact?: boolean
  /** No desktop to act on (demo, or the tunnel is down): the buttons show but do nothing. */
  readOnly?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const [busy, setBusy] = useState<'stop' | 'restart' | null>(null)
  const live = isLive(record.run.state)
  const tone = STATE_TONE[record.run.state] ?? STATE_TONE.stopped
  const stamp = live ? record.run.startedAt : record.run.endedAt

  const act = async (kind: 'stop' | 'restart'): Promise<void> => {
    if (busy) return
    setBusy(kind)
    try {
      // Pulled in at press time, not at import: the sync module reaches the
      // tunnel and through it AsyncStorage, which is null under jest — a
      // top-level import here would fail every suite that renders a bubble.
      const processes = require('@/lib/sync/processes') as typeof import('@/lib/sync/processes')
      if (kind === 'stop') await processes.stopProcess(record.name)
      else await processes.restartProcess(record.name)
    } catch {
      // The desktop's push settles the card either way.
    } finally {
      setBusy(null)
    }
  }

  return (
    <View className={cn('flex-col gap-1', !compact && 'py-1')}>
      <View className="flex-row items-center gap-2">
        <View className={cn('h-2 w-2 shrink-0 rounded-full', tone.dot)} />
        <Text
          numberOfLines={1}
          className="text-fg font-sans-medium min-w-0 shrink text-left text-sm"
          style={{ writingDirection: 'ltr' }}
        >
          {record.name}
        </Text>
        <View className={cn('shrink-0 rounded-full px-2 py-0.5', tone.container)}>
          <Text className={cn('font-sans-medium text-[11px]', tone.text)}>
            {t(`chat.process.state.${record.run.state}`)}
            {record.run.state === 'crashed' && record.run.exitCode !== null
              ? ` · ${t('chat.process.exitCode', { code: record.run.exitCode })}`
              : ''}
          </Text>
        </View>
        {record.origin.kind === 'adopted' && (
          <View className="bg-border-soft shrink-0 rounded-full px-2 py-0.5">
            <Text className="text-muted font-sans text-[11px]">{t('chat.process.adopted')}</Text>
          </View>
        )}
        <View className="ms-auto shrink-0 flex-row items-center">
          {live && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('chat.process.stop')}
              accessibilityState={{ disabled: busy !== null || readOnly }}
              hitSlop={6}
              disabled={busy !== null || readOnly}
              onPress={() => void act('stop')}
              className={cn(
                'h-8 w-8 items-center justify-center rounded-lg',
                busy || readOnly ? 'opacity-40' : 'active:bg-border-soft'
              )}
            >
              <StopIcon size={16} className="text-muted" />
            </Pressable>
          )}
          {record.origin.kind !== 'adopted' && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={live ? t('chat.process.restart') : t('chat.process.start')}
              accessibilityState={{ disabled: busy !== null || readOnly }}
              hitSlop={6}
              disabled={busy !== null || readOnly}
              onPress={() => void act('restart')}
              className={cn(
                'h-8 w-8 items-center justify-center rounded-lg',
                busy || readOnly ? 'opacity-40' : 'active:bg-border-soft'
              )}
            >
              {live ? (
                <RefreshIcon size={16} className="text-muted" />
              ) : (
                <PlayIcon size={16} className="text-muted" />
              )}
            </Pressable>
          )}
        </View>
      </View>
      <View className="flex-row flex-wrap items-center gap-x-3 gap-y-0.5 ps-4">
        {record.run.url ? (
          <Pressable
            accessibilityRole="link"
            onPress={() => void WebBrowser.openBrowserAsync(record.run.url as string)}
            hitSlop={4}
          >
            <Text className="text-accent font-sans text-[11px]" style={{ writingDirection: 'ltr' }}>
              {record.run.url}
            </Text>
          </Pressable>
        ) : record.run.port ? (
          <Text className="text-muted font-sans text-[11px]" style={{ writingDirection: 'ltr' }}>
            {t('chat.process.port', { port: record.run.port })}
          </Text>
        ) : null}
        {stamp ? (
          <Text className="text-muted font-sans text-[11px]">
            {live
              ? t('chat.process.since', { time: formatRelativeTime(stamp, t) })
              : t('chat.process.endedAt', { time: formatSignedRelative(stamp, now, t) })}
          </Text>
        ) : null}
        {record.run.restarts > 0 && (
          <Text className="text-muted font-sans text-[11px]">
            {t('chat.process.restarts', { count: record.run.restarts })}
          </Text>
        )}
        {record.autostart !== 'off' && (
          <Text className="text-muted font-sans text-[11px]">
            {t(`chat.process.autostart.${record.autostart}`)}
          </Text>
        )}
      </View>
      {!compact && (
        <Text
          numberOfLines={1}
          className="text-muted ps-4 font-mono text-[11px] opacity-80"
          style={{ writingDirection: 'ltr' }}
        >
          {record.command}
        </Text>
      )}
      {record.run.lastError && !live ? (
        <Text className="text-muted ps-4 text-left font-sans text-[11px]">
          {record.run.lastError}
        </Text>
      ) : null}
    </View>
  )
}

export function ProcessCard({ snapshot }: { snapshot: ProcessCardSnapshot }): React.JSX.Element {
  const { t } = useTranslation()
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  const list = snapshot.processes ?? []
  const running = list.filter((r) => isLive(r.run.state)).length

  return (
    <View className="bg-surface border-border w-[85%] flex-col gap-2 self-start rounded-xl border px-3 py-2.5">
      <View className="flex-row items-center gap-2">
        <ComputerTerminal01Icon size={15} className="text-muted" />
        <Text
          selectable
          numberOfLines={1}
          className="text-fg font-sans-medium min-w-0 flex-1 text-left text-sm"
        >
          {snapshot.title ||
            (list.length === 1 ? t('chat.process.titleOne') : t('chat.process.title'))}
        </Text>
        {list.length > 1 && (
          <Text
            className="text-muted font-sans text-[11px]"
            style={{ fontVariant: ['tabular-nums'] }}
          >
            {t('chat.process.runningCount', { count: running, total: list.length })}
          </Text>
        )}
      </View>
      {list.length === 0 ? (
        <Text className="text-muted font-sans text-left text-[11px]">
          {t('chat.process.empty')}
        </Text>
      ) : (
        <View className="flex-col">
          {list.map((record, index) => (
            <View
              key={record.id ?? record.name}
              className={cn(index > 0 && 'border-border-soft border-t pt-1')}
            >
              <ProcessRow record={record} now={now} />
            </View>
          ))}
        </View>
      )}
    </View>
  )
}
