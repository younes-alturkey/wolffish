import { cn } from '@lib/utils/cn'
import type { TodoItem, TodoStatus } from '@preload/index'
import {
  Cancel01Icon,
  CheckmarkCircle02Icon,
  CircleIcon,
  Loading03Icon,
  Task01Icon
} from 'hugeicons-react'
import { useTranslation } from 'react-i18next'

/**
 * The model's task list (todo_write) as a checklist card. Fully
 * DETERMINISTIC: the items on the `todo` segment are the whole state — one
 * segment per turn, replaced in place on every write (upsertTodoSegment) —
 * so the card is the same live, after the turn, and when the conversation
 * is reopened from history. Always visible: it is output FOR the user, not
 * tool mechanics, so it renders on the clean feed too.
 */

export function TodoCard({ items }: { items: TodoItem[] }): React.JSX.Element {
  const { t } = useTranslation()
  const done = items.filter((i) => i.status === 'completed').length
  const total = items.filter((i) => i.status !== 'cancelled').length
  const allDone = total > 0 && done === total
  const percent = total > 0 ? Math.round((done / total) * 100) : 0

  return (
    <div className="border-border bg-surface w-full max-w-[85%] self-start rounded-2xl border px-4 py-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Task01Icon size={16} className="text-accent shrink-0" aria-hidden />
          <span className="text-fg font-medium">{t('chat.todoCard.title')}</span>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-xs tabular-nums',
            allDone
              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              : 'bg-accent/10 text-accent'
          )}
        >
          {t('chat.todoCard.progress', { done, total })}
        </span>
      </div>
      <div className="bg-muted/20 mt-2 h-1 w-full overflow-hidden rounded-full">
        <div
          className={cn('h-full rounded-full', allDone ? 'bg-emerald-500' : 'bg-accent')}
          style={{ width: `${percent}%` }}
        />
      </div>
      <ul className="mt-2 flex flex-col gap-1">
        {items.map((item, i) => (
          <li key={`${i}-${item.content}`} className="flex items-start gap-2">
            <StatusIcon status={item.status} />
            <span
              className={cn(
                'min-w-0 flex-1 leading-5',
                item.status === 'completed' && 'text-muted line-through',
                item.status === 'cancelled' && 'text-muted/70 line-through',
                item.status === 'in_progress' && 'text-fg font-medium'
              )}
            >
              {item.content}
            </span>
            {item.priority === 'high' && item.status !== 'completed' && (
              <span className="shrink-0 rounded-full bg-red-500/10 px-1.5 py-0.5 text-[11px] text-red-600 dark:text-red-400">
                {t('chat.todoCard.high')}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function StatusIcon({ status }: { status: TodoStatus }): React.JSX.Element {
  const cls = 'mt-0.5 shrink-0'
  switch (status) {
    case 'completed':
      return (
        <CheckmarkCircle02Icon
          size={16}
          className={cn(cls, 'text-emerald-600 dark:text-emerald-400')}
          aria-hidden
        />
      )
    case 'in_progress':
      return <Loading03Icon size={16} className={cn(cls, 'text-accent animate-spin')} aria-hidden />
    case 'cancelled':
      return <Cancel01Icon size={16} className={cn(cls, 'text-muted/70')} aria-hidden />
    default:
      return <CircleIcon size={16} className={cn(cls, 'text-muted')} aria-hidden />
  }
}
