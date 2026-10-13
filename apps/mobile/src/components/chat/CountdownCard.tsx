import { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useTranslation } from 'react-i18next'

import { ProgressBar } from '@/components/core/ProgressBar'
import { Clock01Icon } from '@/components/core/icons'
import type { CountdownSnapshot, CountdownStatus } from '@/lib/conversations/types'
import { Rpc } from '@/lib/tunnel/protocol'
import { cn } from '@/lib/utils/cn'

/**
 * Turn-end countdown card — the mobile twin of the desktop's CountdownCard.
 * Fully deterministic: label, deadline and state all come from the desktop
 * manager's CountdownSnapshot; snapshots replace each other by countdownId
 * upstream (segments.ts fold, the countdown.changed push), so live and
 * reloaded conversations render identically.
 *
 * The bar drains locally from fireAt at 10 Hz — the desktop pushes state
 * transitions only, never ticks. Abort is a real RPC (Rpc.countdownAbort):
 * unlike a video task, a restart is something the phone user must be able
 * to stop from wherever they are. In its terminal states the card is a
 * one-line record — no bar, no button.
 */

const STATUS_TONE: Record<CountdownStatus, { container: string; text: string }> = {
  armed: { container: 'bg-primary-soft', text: 'text-primary' },
  counting: { container: 'bg-primary-soft', text: 'text-primary' },
  fired: { container: 'bg-emerald-500/15', text: 'text-emerald-600 dark:text-emerald-400' },
  failed: { container: 'bg-red-500/15', text: 'text-red-600 dark:text-red-400' },
  aborted: { container: 'bg-border-soft', text: 'text-muted' }
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

  const [aborting, setAborting] = useState(false)
  // The transport is pulled in at press time, not at import time: tunnelClient
  // reaches the push module and through it AsyncStorage, which is null under
  // jest — a top-level import here fails every suite that renders a bubble.
  const abort = async (): Promise<void> => {
    if (aborting) return
    setAborting(true)
    try {
      const { tunnelClient } = await import('@/lib/tunnel/client')
      const client = tunnelClient.active
      if (client && tunnelClient.connected) {
        await client.rpc(Rpc.countdownAbort, { countdownId: snapshot.countdownId })
      }
    } catch {
      // The desktop's push (or the nudge after its write) settles the card.
    } finally {
      setAborting(false)
    }
  }

  const remainingMs = counting ? Math.max(0, (snapshot.fireAt ?? 0) - now) : snapshot.seconds * 1000
  const remainingS = Math.ceil(remainingMs / 1000)
  const progress = counting ? remainingMs / (snapshot.seconds * 1000) : 1

  const endedLabel = snapshot.endedAt
    ? new Date(snapshot.endedAt).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit'
      })
    : ''

  const hint =
    snapshot.status === 'armed'
      ? t('chat.countdown.armedHint', { count: snapshot.seconds })
      : snapshot.status === 'aborted'
        ? t(`chat.countdown.abortedBy.${snapshot.abortedBy ?? 'user'}`)
        : snapshot.status === 'fired'
          ? (snapshot.result ?? t('chat.countdown.firedHint'))
          : snapshot.status === 'failed'
            ? ''
            : t('chat.countdown.countingHint')

  const tone = STATUS_TONE[snapshot.status]

  return (
    <View className="bg-surface border-border w-[85%] flex-col gap-2 self-start rounded-xl border px-3 py-2.5">
      <View className="flex-row items-center gap-2">
        <Clock01Icon size={15} className="text-muted" />
        <View className={cn('rounded-full px-2 py-0.5', tone.container)}>
          <Text className={cn('font-sans-medium text-[11px]', tone.text)}>
            {t(`chat.countdown.status.${snapshot.status}`)}
          </Text>
        </View>
        <Text
          selectable
          numberOfLines={1}
          className="text-fg font-sans-medium min-w-0 flex-1 text-left text-sm"
        >
          {snapshot.label}
        </Text>
        {live ? (
          <Text
            className="text-muted font-sans text-[11px]"
            style={{ writingDirection: 'ltr', fontVariant: ['tabular-nums'] }}
          >
            {t('chat.countdown.remaining', { count: remainingS })}
          </Text>
        ) : endedLabel ? (
          <Text
            className="text-muted font-sans text-[11px]"
            style={{ writingDirection: 'ltr', fontVariant: ['tabular-nums'] }}
          >
            {endedLabel}
          </Text>
        ) : null}
      </View>

      {live && <ProgressBar value={progress} pulse={!counting} />}

      <View className="flex-row items-center gap-2">
        {hint.length > 0 && (
          <Text
            selectable
            numberOfLines={2}
            className="text-muted font-sans min-w-0 flex-1 text-left text-[11px]"
          >
            {hint}
          </Text>
        )}
        {live && (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: aborting }}
            disabled={aborting}
            onPress={() => void abort()}
            className={cn(
              'border-border bg-bg rounded-full border px-3 py-1',
              aborting && 'opacity-40'
            )}
          >
            <Text className="text-fg font-sans-medium text-xs">{t('chat.countdown.abort')}</Text>
          </Pressable>
        )}
      </View>

      {snapshot.status === 'failed' && (
        <View className="rounded-md border border-red-300 bg-red-50 px-3 py-2 dark:border-red-700 dark:bg-red-900/40">
          <Text
            selectable
            className="text-left font-sans text-[11px] text-red-900 dark:text-red-100"
          >
            {snapshot.error ?? t('chat.countdown.status.failed')}
          </Text>
        </View>
      )}
    </View>
  )
}
