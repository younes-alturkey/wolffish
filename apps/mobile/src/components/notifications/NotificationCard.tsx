import { Archive02Icon, Tick02Icon } from '@/components/core/icons'
import { cn } from '@/lib/utils/cn'
import type { NotifyPhase } from '@/lib/tunnel/protocol'
import type { NotificationRecord } from '@/state/notifications'
import { memo } from 'react'
import { Pressable, Text, View } from 'react-native'

/**
 * One notification, as a card — shared by the notifications page and the
 * conversation's own notifications sheet.
 *
 * Shared because those two surfaces show the SAME thing to the same person a
 * minute apart: the page is every notification this phone has had, the sheet
 * is the handful belonging to the conversation on screen. A card that looked
 * or behaved differently between them would read as a different kind of
 * object, and its two actions — which are not confirmed anywhere — would have
 * to be trusted twice.
 *
 * What differs is only what each surface CHOOSES to render: the sheet leaves
 * archived notifications out entirely (they have been filed, and the page is
 * where a filed one is read back), while the page keeps them under its own
 * tab. Neither difference lives in here.
 */

/** The phase chip's tint, in the vocabulary the conversation chips already
 *  use (see ConversationChip.chipTone) — real palette colors, because a var()
 *  token cannot carry an /alpha in this project. */
export function phaseTone(phase: NotifyPhase): string {
  switch (phase) {
    case 'completed':
      return 'border-emerald-500/40 bg-emerald-500/10'
    case 'failed':
      return 'border-red-500/40 bg-red-500/10'
    case 'needs_input':
      return 'border-amber-500/40 bg-amber-500/10'
    case 'started':
      return 'border-primary-line bg-primary-soft'
    default:
      return 'border-border'
  }
}

export function phaseText(phase: NotifyPhase): string {
  switch (phase) {
    case 'completed':
      return 'text-emerald-600 dark:text-emerald-400'
    case 'failed':
      return 'text-red-600 dark:text-red-400'
    case 'needs_input':
      return 'text-amber-600 dark:text-amber-400'
    case 'started':
      return 'text-primary'
    default:
      return 'text-muted'
  }
}

/**
 * One notification's own small control — icon above a label, sized for a
 * thumb, on the card's own surface. Not the core Button: these sit INSIDE a
 * pressable card and must read as secondary to it.
 */
function CardAction({
  label,
  Icon,
  onPress
}: {
  label: string
  Icon: (props: { size: number; className: string }) => React.JSX.Element
  onPress: () => void
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={onPress}
      className="border-border flex-row items-center gap-1.5 rounded-lg border px-2.5 py-1.5 active:bg-border-soft"
    >
      <Icon size={13} className="text-muted" />
      <Text numberOfLines={1} className="text-muted font-sans-medium text-[11px]">
        {label}
      </Text>
    </Pressable>
  )
}

export const NotificationCard = memo(function NotificationCard({
  record,
  time,
  phaseLabel,
  newLabel,
  readLabel,
  archiveLabel,
  onOpen,
  onRead,
  onArchive,
  unread
}: {
  record: NotificationRecord
  time: string
  phaseLabel: string
  newLabel: string
  readLabel: string
  archiveLabel: string
  onOpen: (record: NotificationRecord) => void
  /** Absent where reading is not something the user does by hand — the
   *  conversation's sheet reads its whole list the moment it opens. */
  onRead?: (id: string) => void
  onArchive: (id: string) => void
  /**
   * Whether to wear the New mark, when the record's own `read` is not the
   * right answer. The conversation's sheet reads everything on open and then
   * passes what WAS unread a moment ago, so the user can still see what they
   * had missed instead of watching the marks blink out from under them.
   */
  unread?: boolean
}): React.JSX.Element {
  const isNew = unread ?? !record.read
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={record.title}
      onPress={() => onOpen(record)}
      className={cn(
        'bg-surface flex-col gap-1.5 rounded-xl border px-4 py-3 active:bg-border-soft',
        // The unread mark is the card's own outline rather than a dot the eye
        // has to find: a list is scanned down its edge, and a tinted border is
        // legible at that speed in both themes.
        isNew ? 'border-primary-line' : 'border-border'
      )}
    >
      <View className="flex-row items-center gap-2">
        <View className={cn('rounded-full border px-2 py-0.5', phaseTone(record.phase))}>
          <Text className={cn('font-sans-medium text-[10px]', phaseText(record.phase))}>
            {phaseLabel}
          </Text>
        </View>
        {/* min-w-0 with flex-1: without it a long relative phrase pushes the
            trailing edge off the card rather than truncating inside it. */}
        <Text
          numberOfLines={1}
          className="text-muted min-w-0 flex-1 text-right font-sans text-[11px]"
        >
          {time}
        </Text>
      </View>
      <Text
        className={cn(
          'text-left text-sm',
          isNew ? 'text-fg font-sans-semibold' : 'text-fg font-sans-medium'
        )}
      >
        {record.title}
      </Text>
      {/* The whole body, unclipped: it is capped at 180 characters upstream,
          and this page exists precisely to show what the banner cut off. */}
      <Text className="text-muted text-left font-sans text-xs leading-relaxed">{record.body}</Text>
      {(!record.archived || isNew) && (
        <View className="flex-row items-center gap-2 pt-1">
          {/* The actions grow and wrap inside their own box; min-w-0 with
              flex-1 is what keeps a long translation shrinking itself instead
              of shoving the chip off the card. */}
          <View className="min-w-0 flex-1 flex-row flex-wrap items-center gap-2">
            {!record.archived && !record.read && onRead && (
              <CardAction label={readLabel} Icon={Tick02Icon} onPress={() => onRead(record.id)} />
            )}
            {!record.archived && (
              <CardAction
                label={archiveLabel}
                Icon={Archive02Icon}
                onPress={() => onArchive(record.id)}
              />
            )}
          </View>
          {/* The unread mark: a word, on the card's trailing bottom corner —
              solid primary, the same pill the unread counts wear everywhere
              else in the app, so "unread" reads as one mark throughout. It
              sits at the END of the card rather than the start because that is
              where the eye leaves each card, and it is text rather than a dot
              because a dot has to be learned. Mirrors on its own: the row is
              a flex-row, which React Native reverses under RTL. */}
          {isNew && (
            <View className="bg-primary rounded-full px-2 py-0.5">
              <Text className="text-primary-fg font-sans-semibold text-[10px]">{newLabel}</Text>
            </View>
          )}
        </View>
      )}
    </Pressable>
  )
})
