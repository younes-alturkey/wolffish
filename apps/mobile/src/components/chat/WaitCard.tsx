import { useEffect, useId, useState } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'
import { useTranslation } from 'react-i18next'

import { INPUT_TEXT_ALIGN, WRITING_DIRECTION, rtlPlaceholder } from '@/components/core/Input'
import { KeyboardDismissAccessory } from '@/components/core/KeyboardDismissBar'
import { ProgressBar } from '@/components/core/ProgressBar'
import { Clock01Icon, SentIcon } from '@/components/core/icons'
import { mintMessageId, type WaitSnapshot, type WaitStatus } from '@/lib/conversations/types'
import { useTokens } from '@/providers/theme/useTheme'
import { cn } from '@/lib/utils/cn'

/**
 * Blocking-wait card — the mobile twin of the desktop's WaitCard. Fully
 * deterministic: the reason, the deadline and the state all come from the
 * desktop's WaitSnapshot; snapshots replace each other by waitId upstream
 * (segments.ts fold), so a live turn and a reloaded conversation render
 * identically, at the point in the transcript where the wait began.
 *
 * The clock fills locally from endsAt at 1 Hz — the desktop pushes the two
 * state changes only, never ticks, so an hour-long wait costs two segments.
 *
 * The box is not a private channel to the wait: it sends an ordinary
 * mid-turn message into the running turn (the same `interject` the composer
 * uses), which both wakes the agent and reaches it as the user's next words.
 * So the phone can end a wait started on the desktop, and vice versa. In its
 * terminal states the card is a one-line record — no clock, no box.
 */

const STATUS_TONE: Record<WaitStatus, { container: string; text: string }> = {
  waiting: { container: 'bg-primary-soft', text: 'text-primary' },
  elapsed: { container: 'bg-emerald-500/15', text: 'text-emerald-600 dark:text-emerald-400' },
  interrupted: { container: 'bg-amber-500/15', text: 'text-amber-600 dark:text-amber-400' },
  canceled: { container: 'bg-border-soft', text: 'text-muted' }
}

/** "4h 12m" / "12m 30s" / "45s" — the desktop card's shape, verbatim. */
function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds))
  if (s < 60) return `${s}s`
  if (s < 3600) {
    const m = Math.floor(s / 60)
    const rem = s % 60
    return rem ? `${m}m ${rem}s` : `${m}m`
  }
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  return m ? `${h}h ${m}m` : `${h}h`
}

export function WaitCard({
  snapshot,
  conversationId
}: {
  snapshot: WaitSnapshot
  conversationId?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const tokens = useTokens()
  const accessoryID = useId()
  const live = snapshot.status === 'waiting'
  const cid = conversationId ?? snapshot.conversationId ?? null

  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    if (!live) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [live])

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || sending || !cid) return
    setSending(true)
    try {
      // Pulled in at press time, not at import: the sync module reaches the
      // tunnel and through it AsyncStorage, which is null under jest — a
      // top-level import here would fail every suite that renders a bubble.
      // `require`, not `await import`, for the same reason the other way
      // round: jest's VM cannot resolve a dynamic import at all, so an
      // `import()` here would leave this button's only job untestable.
      const { interject } = require('@/lib/sync/prompt') as typeof import('@/lib/sync/prompt')
      await interject({ conversationId: cid, messageId: mintMessageId(), text, attachments: [] })
      setDraft('')
    } catch {
      // The draft stays put to try again; the wait runs on either way.
    } finally {
      setSending(false)
    }
  }

  const totalMs = Math.max(1, snapshot.endsAt - snapshot.startedAt)
  const remainingMs = live ? Math.max(0, snapshot.endsAt - now) : 0
  // Fills as the wait runs down, so it reads as progress toward waking.
  const progress = live ? (totalMs - remainingMs) / totalMs : 1

  const endedLabel = snapshot.endedAt
    ? new Date(snapshot.endedAt).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit'
      })
    : ''
  const spentSeconds = snapshot.endedAt
    ? (snapshot.endedAt - snapshot.startedAt) / 1000
    : snapshot.seconds

  const hint =
    snapshot.status === 'waiting'
      ? t('chat.wait.waitingHint', { duration: formatDuration(snapshot.seconds) })
      : snapshot.status === 'elapsed'
        ? t('chat.wait.elapsedHint', { duration: formatDuration(snapshot.seconds) })
        : snapshot.status === 'interrupted'
          ? t('chat.wait.interruptedHint', { duration: formatDuration(spentSeconds) })
          : t('chat.wait.canceledHint', { duration: formatDuration(spentSeconds) })

  const tone = STATUS_TONE[snapshot.status]

  return (
    <View className="bg-surface border-border w-[85%] flex-col gap-2 self-start rounded-xl border px-3 py-2.5">
      <View className="flex-row items-center gap-2">
        <Clock01Icon size={15} className="text-muted" />
        <View className={cn('rounded-full px-2 py-0.5', tone.container)}>
          <Text className={cn('font-sans-medium text-[11px]', tone.text)}>
            {t(`chat.wait.status.${snapshot.status}`)}
          </Text>
        </View>
        <Text
          selectable
          numberOfLines={1}
          className="text-fg font-sans-medium min-w-0 flex-1 text-left text-sm"
        >
          {snapshot.reason}
        </Text>
        {live ? (
          <Text
            className="text-muted font-sans text-[11px]"
            style={{ writingDirection: 'ltr', fontVariant: ['tabular-nums'] }}
          >
            {t('chat.wait.remaining', { duration: formatDuration(remainingMs / 1000) })}
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

      {live && <ProgressBar value={progress} />}

      {hint.length > 0 && (
        <Text selectable numberOfLines={2} className="text-muted font-sans text-left text-[11px]">
          {hint}
        </Text>
      )}

      {live && cid ? (
        <View className="flex-row items-center gap-2">
          <KeyboardDismissAccessory nativeID={accessoryID} />
          <TextInput
            inputAccessoryViewID={accessoryID}
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={() => void send()}
            returnKeyType="send"
            placeholder={rtlPlaceholder(t('chat.wait.inputPlaceholder'))}
            placeholderTextColor={tokens.muted}
            selectionColor={tokens.accent}
            style={WRITING_DIRECTION}
            className={cn(
              'border-border bg-bg text-fg h-9 flex-1 rounded-lg border px-3 py-2 font-sans text-xs leading-tight',
              INPUT_TEXT_ALIGN
            )}
          />
          {/* No greyed stub: with nothing to send there is nothing to press. */}
          {draft.trim().length > 0 && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('chat.wait.send')}
              accessibilityState={{ disabled: sending }}
              disabled={sending}
              onPress={() => void send()}
              className={cn(
                'bg-primary h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                sending && 'opacity-40'
              )}
            >
              <SentIcon size={16} className="text-primary-fg" />
            </Pressable>
          )}
        </View>
      ) : null}
    </View>
  )
}
