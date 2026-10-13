import { cn } from '@lib/utils/cn'
import type { WebNotificationRecord } from '@preload/index'
import { Archive02Icon, Tick02Icon } from 'hugeicons-react'
import { memo } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * One notification, as a card — the notifications page and a conversation's
 * notifications sheet both draw it, the port of the phone's NotificationCard.
 * The same object in both places, with the same two actions: Mark as read
 * (unread only) and Archive (inbox only).
 */

function phaseTone(phase: WebNotificationRecord['phase']): string {
  switch (phase) {
    case 'completed':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
    case 'failed':
      return 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
    case 'needs_input':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
    case 'started':
      return 'border-primary/40 bg-primary/10 text-primary'
    default:
      return 'border-border text-muted'
  }
}

function CardAction({
  label,
  Icon,
  onClick
}: {
  label: string
  Icon: React.ComponentType<{ size?: number }>
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      // The card itself is a button: the action must not also open it.
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={cn(
        'border-border text-muted hover:text-fg hover:bg-bg flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-medium',
        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none'
      )}
    >
      <Icon size={13} />
      <span className="truncate">{label}</span>
    </button>
  )
}

export const NotificationCard = memo(function NotificationCard({
  record,
  time,
  onOpen,
  onRead,
  onArchive,
  unread,
  framed = true
}: {
  record: WebNotificationRecord
  time: string
  /** Absent where a tap has nowhere to go — the sheet sits over its conversation. */
  onOpen?: (record: WebNotificationRecord) => void
  /** Absent where reading is not done by hand — the sheet reads its list on open. */
  onRead?: (id: string) => void
  onArchive: (id: string) => void
  /**
   * The New mark, when the record's own `read` is not the right answer: the
   * sheet reads everything as it opens and passes what WAS unread a moment
   * before, so the marks do not blink out from under the user.
   */
  unread?: boolean
  /** False inside a settings-style section, which draws the frame itself. */
  framed?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const isNew = unread ?? !record.read
  return (
    <div
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen ? () => onOpen(record) : undefined}
      onKeyDown={
        onOpen
          ? (e) => {
              if (e.target !== e.currentTarget) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onOpen(record)
              }
            }
          : undefined
      }
      className={cn(
        'flex flex-col gap-1.5 text-start',
        framed
          ? cn(
              'bg-surface rounded-xl border px-4 py-3',
              // The unread mark is the card's own outline: a list is scanned
              // down its edge, and a tinted border reads at that speed.
              isNew ? 'border-primary/50' : 'border-border'
            )
          : 'px-6 py-4',
        onOpen &&
          'hover:bg-bg/40 cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none focus-visible:ring-inset'
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'rounded-full border px-2 py-0.5 text-[10px] font-medium',
            phaseTone(record.phase)
          )}
        >
          {t(`notifications.phase.${record.phase}`)}
        </span>
        <span className="text-muted min-w-0 flex-1 truncate text-end text-[11px]">{time}</span>
      </div>
      <p className={cn('text-fg text-sm', isNew ? 'font-semibold' : 'font-medium')}>
        {record.title}
      </p>
      {record.body && (
        <p className="text-muted text-xs leading-relaxed whitespace-pre-wrap">{record.body}</p>
      )}
      {(!record.archived || isNew) && (
        <div className="flex items-center gap-2 pt-1">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {!record.archived && !record.read && onRead && (
              <CardAction
                label={t('notifications.markRead')}
                Icon={Tick02Icon}
                onClick={() => onRead(record.id)}
              />
            )}
            {!record.archived && (
              <CardAction
                label={t('notifications.archive')}
                Icon={Archive02Icon}
                onClick={() => onArchive(record.id)}
              />
            )}
          </div>
          {isNew && (
            <span className="bg-primary text-primary-fg rounded-full px-2 py-0.5 text-[10px] font-semibold">
              {t('notifications.new')}
            </span>
          )}
        </div>
      )}
    </div>
  )
})
