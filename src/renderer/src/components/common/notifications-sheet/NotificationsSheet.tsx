import { NotificationCard } from '@components/common/notification-card/NotificationCard'
import { formatRelative } from '@components/common/process-card/format'
import {
  unarchivedFor,
  updateWebNotifications,
  useWebNotifications
} from '@hooks/use-web-notifications/useWebNotifications'
import { useNow } from '@hooks/use-now/useNow'
import { cn } from '@lib/utils/cn'
import { isMac } from '@lib/utils/platform'
import { useLocale } from '@providers/locale/useLocale'
import { Archive02Icon, Cancel01Icon, Notification03Icon } from 'hugeicons-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * What THIS conversation has notified about, read back beside the transcript
 * that produced it — the port of the phone's ConversationNotificationsSheet,
 * on the trailing edge opposite the conversations sheet.
 *
 * Opening it IS reading them, as on the phone: the list appears and the
 * bell's count goes, with no button to press — pressing one would be asking
 * the user to tell the app what it can already see. The cards keep their New
 * marks while the sheet is open, off a snapshot taken before the read, and
 * offer no Mark as read because it is already done. Archived ones do not
 * show: archiving is filing, and the page is where a filed one is read back.
 *
 * Nothing confirms: Archive all cannot reach past the conversation
 * underneath, and every archived card is still on the notifications page.
 */
export function NotificationsSheet({
  conversationId,
  onClose
}: {
  conversationId: string
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const items = useWebNotifications()
  const records = useMemo(() => unarchivedFor(items, conversationId), [items, conversationId])
  const now = useNow()

  // What was unread as the sheet opened — the lazy initializer runs once, on
  // the first render, the last moment the log still remembers.
  const [wasUnread] = useState(() => new Set(records.filter((r) => !r.read).map((r) => r.id)))

  // Seeing them is reading them.
  useEffect(() => {
    updateWebNotifications({ kind: 'readConversation', conversationId })
  }, [conversationId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const headerButton = cn(
    'text-muted hover:text-fg hover:bg-surface flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg',
    'disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent',
    'focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none'
  )

  return (
    <div className="fixed inset-0 z-50">
      <div
        aria-hidden
        onClick={onClose}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={t('notifications.title')}
        className="wf-sheet-panel-end bg-bg border-border/40 absolute inset-y-0 inset-e-0 flex w-96 max-w-[92vw] flex-col border-s pb-[env(safe-area-inset-bottom)] max-sm:w-full max-sm:max-w-full max-sm:border-s-0"
      >
        <div
          className={cn(
            'border-border/60 flex shrink-0 items-center gap-1 border-b px-3 pb-3',
            isMac ? 'pt-12' : 'pt-6'
          )}
        >
          <span className="text-muted flex h-8 w-6 shrink-0 items-center justify-center">
            <Notification03Icon size={17} />
          </span>
          <h2 className="text-fg min-w-0 flex-1 truncate text-sm font-semibold">
            {t('notifications.title')}
          </h2>
          <button
            type="button"
            disabled={records.length === 0}
            onClick={() => updateWebNotifications({ kind: 'archiveConversation', conversationId })}
            title={t('notifications.archiveAll')}
            aria-label={t('notifications.archiveAll')}
            className={headerButton}
          >
            <Archive02Icon size={17} />
          </button>
          <button
            type="button"
            onClick={onClose}
            title={t('common.dismiss')}
            aria-label={t('common.dismiss')}
            className={headerButton}
          >
            <Cancel01Icon size={16} />
          </button>
        </div>
        {records.length === 0 ? (
          // Reachable for a beat: archiving the last card empties the sheet
          // under the pointer rather than closing it out from under the user.
          <p className="text-muted flex flex-1 items-center justify-center px-8 text-center text-sm">
            {t('notifications.conversationEmpty')}
          </p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
            {records.map((record) => (
              <NotificationCard
                key={record.id}
                record={record}
                time={formatRelative(record.at, now, locale)}
                unread={wasUnread.has(record.id)}
                onArchive={(id) => updateWebNotifications({ kind: 'archive', id })}
              />
            ))}
          </div>
        )}
      </aside>
    </div>
  )
}
