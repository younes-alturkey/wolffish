import {
  Cancel01Icon,
  CheckmarkCircle02Icon,
  CircleIcon,
  Task01Icon
} from '@/components/core/icons'
import type { TodoItem, TodoStatus } from '@/lib/conversations/types'
import { cn } from '@/lib/utils/cn'
import { useTokens } from '@/providers/theme/useTheme'
import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { ActivityIndicator, Text, View, type ViewStyle } from 'react-native'

/**
 * The model's task list (todo_write) as a checklist card — the mobile twin of
 * the desktop's TodoCard. Fully DETERMINISTIC: the items on the `todo` block
 * are the whole state — one card per turn, replaced in place on every write
 * (segments.ts fold) — so the card is the same live, after the turn, and when
 * the conversation is reopened from the stored transcript. Always visible: it
 * is output FOR the user, not tool mechanics, so it renders on the clean feed.
 */

// ActivityIndicator's smallest is 'small' — 20pt — so it is scaled by 16/20 to
// sit in the same 16pt box as the status glyphs on the rows around it. A numeric
// size is not used because ActivityIndicator only honours one on some platforms.
const SPINNER_BOX: ViewStyle = {
  width: 16,
  height: 16,
  alignItems: 'center',
  justifyContent: 'center'
}
const SPINNER: ViewStyle = { transform: [{ scale: 0.8 }] }

/**
 * The status glyph on a row. In progress is a REAL spinner: every glyph in the
 * icon set is a static SVG and react-native-svg has no rotation animation, so
 * the `animate-pulse` this row used to carry only faded the icon in place — a
 * spinner that never spun, which reads as a frozen row. ActivityIndicator is
 * native, so it turns on its own.
 */
function StatusIcon({ status }: { status: TodoStatus }): React.JSX.Element {
  const tokens = useTokens()

  switch (status) {
    case 'completed':
      return <CheckmarkCircle02Icon size={16} className="text-emerald-600 dark:text-emerald-400" />
    case 'in_progress':
      return (
        <View style={SPINNER_BOX}>
          <ActivityIndicator size="small" color={tokens.primary} style={SPINNER} />
        </View>
      )
    case 'cancelled':
      return <Cancel01Icon size={16} className="text-muted" />
    default:
      return <CircleIcon size={16} className="text-muted" />
  }
}

export const TodoCard = memo(function TodoCard({
  items
}: {
  items: TodoItem[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const done = items.filter((item) => item.status === 'completed').length
  const total = items.filter((item) => item.status !== 'cancelled').length
  const allDone = total > 0 && done === total
  const percent = total > 0 ? Math.round((done / total) * 100) : 0

  return (
    <View className="bg-surface border-border w-[85%] flex-col gap-2 self-start rounded-xl border px-3 py-2.5">
      <View className="flex-row items-center gap-2">
        <Task01Icon size={14} className="text-primary" />
        <Text numberOfLines={1} className="text-fg font-sans-medium flex-1 text-left text-xs">
          {t('chat.todoCard.title')}
        </Text>
        <View
          className={cn(
            'rounded-full px-2 py-0.5',
            allDone ? 'bg-emerald-500/15' : 'bg-primary-soft'
          )}
        >
          <Text
            className={cn(
              'font-sans-medium text-[10px]',
              allDone ? 'text-emerald-600 dark:text-emerald-400' : 'text-primary'
            )}
            style={{ writingDirection: 'ltr' }}
          >
            {t('chat.todoCard.progress', { done, total })}
          </Text>
        </View>
      </View>
      <View className="bg-surface-soft h-1 w-full overflow-hidden rounded-full">
        <View
          className={cn('h-full rounded-full', allDone ? 'bg-emerald-500' : 'bg-primary')}
          style={{ width: `${percent}%` }}
        />
      </View>
      <View className="flex-col gap-1">
        {items.map((item, index) => (
          <View key={`${index}-${item.content}`} className="flex-row items-start gap-2">
            <View className="pt-0.5">
              <StatusIcon status={item.status} />
            </View>
            <Text
              className={cn(
                'flex-1 text-left font-sans text-xs leading-5',
                item.status === 'completed' && 'text-muted line-through',
                item.status === 'cancelled' && 'text-muted line-through',
                item.status === 'in_progress' ? 'text-fg font-sans-medium' : 'text-fg'
              )}
            >
              {item.content}
            </Text>
            {item.priority === 'high' && item.status !== 'completed' ? (
              <View className="rounded-full bg-red-500/15 px-1.5 py-0.5">
                <Text className="font-sans-medium text-[10px] text-red-600 dark:text-red-400">
                  {t('chat.todoCard.high')}
                </Text>
              </View>
            ) : null}
          </View>
        ))}
      </View>
    </View>
  )
})
