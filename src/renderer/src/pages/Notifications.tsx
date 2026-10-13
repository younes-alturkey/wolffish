import { NotificationCard } from '@components/common/notification-card/NotificationCard'
import { formatRelative } from '@components/common/process-card/format'
import { Button } from '@components/core/Button'
import { Modal } from '@components/core/Modal'
import {
  updateWebNotifications,
  useWebNotifications
} from '@hooks/use-web-notifications/useWebNotifications'
import { useNow } from '@hooks/use-now/useNow'
import { mapConversationMessages } from '@lib/conversation-open'
import { groupConversationRows } from '@lib/conversation-rows'
import { RTL_LOCALES } from '@lib/i18n'
import { cn } from '@lib/utils/cn'
import { pageTopPadding } from '@lib/utils/platform'
import type { WebNotificationRecord } from '@preload/index'
import { useFlow } from '@providers/flow/useFlow'
import { useSessions } from '@providers/sessions/useSessions'
import { useLocale } from '@providers/locale/useLocale'
import {
  Archive02Icon,
  ArrowLeft02Icon,
  ArrowRight02Icon,
  InboxIcon,
  Notification03Icon,
  Tick02Icon
} from 'hugeicons-react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

type Tab = 'inbox' | 'archive'

/**
 * Every notification the Web UI sent, kept after the banner is gone — the
 * port of the phone's notifications page.
 *
 * Two tabs, because a notification has two independent ends: read/unread is
 * about attention and moves nothing (a read one stays in the list, quietly),
 * archived is about the list and is one-way — archiving reads at the same
 * time, so the archive is a finished pile rather than a second inbox.
 *
 * Unread here is the same fact as the counts on the menu disc, the bell and
 * the conversation rows, and it goes only when the user answers it: Mark as
 * read, a tap that opens the notification, archiving, or the two bulk
 * controls — which confirm first, being the only ones that reach everything.
 */
export function Notifications(): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const BackIcon = RTL_LOCALES.has(locale) ? ArrowRight02Icon : ArrowLeft02Icon
  const { goTo } = useFlow()
  const { activateConversation, openConversation } = useSessions()
  const items = useWebNotifications()
  const now = useNow()
  const [tab, setTab] = useState<Tab>('inbox')
  const [confirming, setConfirming] = useState<'read' | 'archive' | null>(null)

  const visible = useMemo(
    () => items.filter((record) => (tab === 'archive' ? record.archived : !record.archived)),
    [items, tab]
  )
  // The same recency ladder History and the conversations sheet use, so
  // "Yesterday" means one thing across the app. `items` is newest-first.
  const groups = useMemo(() => groupConversationRows(visible, now), [visible, now])
  const unreadInList = visible.some((record) => !record.read)

  const open = useCallback(
    async (record: WebNotificationRecord) => {
      // The tap is the answer — and it reads whether or not there is a
      // conversation to go to.
      if (!record.read) updateWebNotifications({ kind: 'read', id: record.id })
      const id = record.conversationId
      if (!id) return
      // A conversation still running has no file yet: its live session is
      // the way in. Only fall to disk when no session holds it.
      if (activateConversation(id)) {
        goTo('chat')
        return
      }
      const conversation = await window.api.conversation.load(id)
      if (!conversation) return
      openConversation(conversation, mapConversationMessages(conversation))
      goTo('chat')
    },
    [activateConversation, openConversation, goTo]
  )

  return (
    <main className={cn('bg-bg flex h-full w-full flex-col', pageTopPadding)}>
      <div className="flex shrink-0 items-center px-6 pb-2 pt-3 max-sm:px-3">
        <button
          type="button"
          onClick={() => goTo('chat')}
          aria-label={t('common.back')}
          className={cn(
            'text-muted hover:text-fg flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-2 text-sm',
            'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
          )}
        >
          <BackIcon size={16} />
          <span>{t('common.back')}</span>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full w-full items-start justify-center px-6 pt-4 pb-10 max-sm:px-3">
          <div className="flex w-full max-w-2xl flex-col gap-6">
            <header className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                <h1 className="text-fg min-w-0 flex-1 text-2xl font-semibold tracking-tight">
                  {t('notifications.title')}
                </h1>
                {/* Inbox only: nothing in the archive is left to read or archive. */}
                {tab === 'inbox' && (
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!unreadInList}
                      onClick={() => setConfirming('read')}
                    >
                      <Tick02Icon size={15} />
                      {t('notifications.markAllRead')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={visible.length === 0}
                      onClick={() => setConfirming('archive')}
                    >
                      <Archive02Icon size={15} />
                      {t('notifications.archiveAll')}
                    </Button>
                  </div>
                )}
              </div>
              <p className="text-muted text-sm leading-relaxed">{t('notifications.subtitle')}</p>
            </header>

            <div
              role="tablist"
              aria-label={t('notifications.title')}
              className="border-border bg-bg/40 flex w-full items-center rounded-lg border p-0.5"
            >
              {(
                [
                  { value: 'inbox', label: t('notifications.tabs.inbox'), Icon: InboxIcon },
                  { value: 'archive', label: t('notifications.tabs.archive'), Icon: Archive02Icon }
                ] as const
              ).map(({ value, label, Icon }) => {
                const active = tab === value
                return (
                  <button
                    key={value}
                    role="tab"
                    type="button"
                    aria-selected={active}
                    onClick={() => setTab(value)}
                    className={cn(
                      'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium',
                      'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                      active
                        ? 'bg-primary text-primary-fg shadow-sm'
                        : 'text-muted hover:text-fg cursor-pointer'
                    )}
                  >
                    <Icon size={14} />
                    {label}
                  </button>
                )
              })}
            </div>

            {visible.length === 0 ? (
              <section className="bg-surface border-border flex flex-col items-center gap-2 rounded-2xl border px-8 py-12 text-center">
                <span className="text-muted">
                  <Notification03Icon size={28} />
                </span>
                <p className="text-fg text-sm font-medium">
                  {t(tab === 'archive' ? 'notifications.archiveEmpty' : 'notifications.empty')}
                </p>
                <p className="text-muted text-xs leading-relaxed">
                  {t(
                    tab === 'archive' ? 'notifications.archiveEmptyHint' : 'notifications.emptyHint'
                  )}
                </p>
              </section>
            ) : (
              groups.map((group) => (
                <div key={group.key} className="flex flex-col gap-2">
                  <h2 className="text-muted px-1 text-[11px] font-medium tracking-wide uppercase">
                    {t(group.labelKey)}
                  </h2>
                  <section className="bg-surface border-border divide-border/60 flex flex-col divide-y overflow-hidden rounded-2xl border">
                    {group.rows.map((record) => (
                      <NotificationCard
                        key={record.id}
                        record={record}
                        framed={false}
                        time={formatRelative(record.at, now, locale)}
                        onOpen={open}
                        onRead={(id) => updateWebNotifications({ kind: 'read', id })}
                        onArchive={(id) => updateWebNotifications({ kind: 'archive', id })}
                      />
                    ))}
                  </section>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <Modal
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={t(
          confirming === 'archive'
            ? 'notifications.confirmArchiveAll.title'
            : 'notifications.confirmReadAll.title'
        )}
        footer={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirming(null)}
              className="flex-1"
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="flex-1"
              onClick={() => {
                updateWebNotifications({
                  kind: confirming === 'archive' ? 'archiveAll' : 'readAll'
                })
                setConfirming(null)
              }}
            >
              {t(
                confirming === 'archive' ? 'notifications.archiveAll' : 'notifications.markAllRead'
              )}
            </Button>
          </div>
        }
      >
        <p className="text-muted">
          {t(
            confirming === 'archive'
              ? 'notifications.confirmArchiveAll.message'
              : 'notifications.confirmReadAll.message',
            { count: visible.length }
          )}
        </p>
      </Modal>
    </main>
  )
}
