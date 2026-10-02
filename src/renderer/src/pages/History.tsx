import { ChannelIcon } from '@components/common/channel-icon/ChannelIcon'
import { DiagnosticExportOverlay } from '@components/common/diagnostic-export-overlay/DiagnosticExportOverlay'
import { Button } from '@components/core/Button'
import { Modal } from '@components/core/Modal'
import { CONVERSATION_CHIP_BASE, conversationChipClasses } from '@lib/conversation-chip'
import {
  buildConversationRows,
  filterConversationRows,
  groupConversationRows,
  runPhaseKey,
  type ConversationRow
} from '@lib/conversation-rows'
import { RTL_LOCALES } from '@lib/i18n'
import { mapConversationMessages } from '@lib/conversation-open'
import { cn } from '@lib/utils/cn'
import { pageTopPadding } from '@lib/utils/platform'
import type { ConversationMeta, Project } from '@preload/index'
import { useFlow } from '@providers/flow/useFlow'
import { useSessions } from '@providers/sessions/useSessions'
import { useLocale } from '@providers/locale/useLocale'
import {
  ArrowLeft02Icon,
  ArrowRight02Icon,
  BubbleChatIcon,
  Bug01Icon,
  Delete01Icon,
  Search01Icon
} from 'hugeicons-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

// Varied title-bar widths so the loading skeleton looks like real conversation rows.
const skeletonTitleWidths = [62, 45, 78, 38, 55, 70, 48, 84, 41, 66]

// Last-fetched list, kept across remounts (this page remounts on every visit).
// Seeds the next mount for an instant paint, then refreshes silently in the
// background — so the skeleton shows ONLY on the first-ever cold load, never on
// return visits. Module-scoped: lives for the app session. (Same cold-start
// pattern the channel settings panels use.)
let cachedConversations: ConversationMeta[] | null = null
let cachedProjects: Project[] | null = null

export function History(): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const isRtl = RTL_LOCALES.has(locale)
  const BackIcon = isRtl ? ArrowRight02Icon : ArrowLeft02Icon
  const { goTo } = useFlow()
  const {
    openConversation,
    activateConversation,
    newSession,
    activeConversationId,
    runStatuses,
    closeConversation
  } = useSessions()

  const [conversations, setConversations] = useState<ConversationMeta[]>(
    () => cachedConversations ?? []
  )
  // Projects, for resolving a bound conversation's emoji LIVE (an icon change
  // on the Projects page propagates; a stamp would go stale).
  const [projects, setProjects] = useState<Project[]>(() => cachedProjects ?? [])
  // Skeleton ONLY on the first-ever load (cold cache). Return visits seed from
  // the cache above and refresh silently — no skeleton flash.
  const [loading, setLoading] = useState(() => cachedConversations === null)
  // Title search. Page-local and uncached on purpose: the list you return to
  // is the whole list, not whatever you were narrowing to last visit.
  const [query, setQuery] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<ConversationRow | null>(null)
  // Diagnostic export target — the same per-conversation bundle the chat
  // composer's bug button produces, reachable for a conversation you are not
  // currently in (which is most of them, on this page).
  const [diagnosticsTarget, setDiagnosticsTarget] = useState<string | null>(null)

  // The SINGLE fetch path (mount + live refresh). Writes the module cache so
  // the next remount paints instantly. Delete mutates state/cache locally
  // instead of refetching (see handleDelete).
  const refresh = useCallback(async () => {
    const [list, projectList] = await Promise.all([
      window.api.conversation.list(),
      window.api.projects.list().catch(() => [] as Project[])
    ])
    cachedConversations = list
    cachedProjects = projectList
    setConversations(list)
    setProjects(projectList)
    setLoading(false)
  }, [])

  // One effect owns every list update, so there is never a double fetch: a
  // silent background refresh on mount (the cache-seeded list is already on
  // screen) PLUS a live refresh whenever main pushes conversation:changed (it
  // fires after the cortex row is (re)indexed/removed, so this page stays fresh
  // for conversations arriving on any channel or from an autonomous run).
  // Debounced to coalesce a turn's write bursts.
  //
  // It ALSO re-runs whenever a turn starts or ends anywhere (statusKey) — the
  // rail's rule, for the rail's reason: that transition is exactly when a new
  // conversation can appear, whatever channel it came from, and the list call
  // is cortex-backed at ~1ms.
  const statusKey = useMemo(() => runPhaseKey(runStatuses), [runStatuses])
  useEffect(() => {
    // The mount refresh rides the same timer as the live pushes: scheduled,
    // never called synchronously in the effect body (setState-in-effect
    // cascades), and coalesced with any push that lands immediately after.
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => void refresh(), 0)
    const off = window.api.conversation.onChanged(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void refresh(), 250)
    })
    return () => {
      if (timer) clearTimeout(timer)
      off()
    }
  }, [refresh, statusKey])

  // Indexed conversations MERGED with this session's live runs, so a
  // conversation started anywhere — in-app, WhatsApp, Telegram, an automation,
  // a procedure — shows up here the moment its first turn starts, with the
  // same pulsing number chip the rail gives it, instead of only once the work
  // is over and the cortex has caught up.
  const rows = useMemo(
    () =>
      buildConversationRows({
        metas: conversations,
        runStatuses,
        projects,
        untitled: t('chat.conversationsUntitled')
      }),
    [conversations, runStatuses, projects, t]
  )

  // What the page actually lists: the rows the typed keywords match, all of
  // them when nothing is typed.
  const visible = useMemo(() => filterConversationRows(rows, query), [rows, query])

  // Sliced into the recency buckets the page renders headers over. Recomputed
  // with the rows (which refresh on every turn start/end and every
  // conversation:changed push), so the day boundary is never more stale than
  // the list itself.
  //
  // Grouped over the MATCHES, so the number chips count 1..n down whatever is
  // on screen. Keeping each row's rank in the unfiltered list would print
  // 3, 17, 42 under a search — the chip answers "which row am I looking at",
  // which is a question about the visible list.
  const groups = useMemo(() => groupConversationRows(visible), [visible])

  const handleResume = useCallback(
    async (id: string) => {
      // A still-processing in-app conversation has no file on disk yet, so
      // activate its live session directly — a load-first path would return
      // null and dead-end. Only fall to disk when no live session holds it.
      if (activateConversation(id)) {
        goTo('chat')
        return
      }
      const conv = await window.api.conversation.load(id)
      if (!conv) return
      const mapped = mapConversationMessages(conv)
      openConversation(conv, mapped)
      goTo('chat')
    },
    [goTo, openConversation, activateConversation]
  )

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    const id = deleteTarget.conversationId
    // Main refuses while the conversation has a turn in flight (ok:false) —
    // the row's disabled state should prevent it, this is the backstop.
    const result = await window.api.conversation.delete(id)
    if (result.ok) {
      closeConversation(id)
      // Drop the row optimistically. deleteConversation removes the FILE, but
      // the cortex row lingers until the watcher's removeFile (~500ms) — so a
      // refresh() here would re-fetch the still-indexed row and flash it back.
      // The conversation:changed push reconciles the list silently right after.
      cachedConversations = cachedConversations?.filter((c) => c.id !== id) ?? null
      setConversations((prev) => prev.filter((c) => c.id !== id))
    }
    setDeleteTarget(null)
  }, [deleteTarget, closeConversation])

  const handleNewChat = useCallback(() => {
    newSession()
    goTo('chat')
  }, [goTo, newSession])

  return (
    <main className={cn('bg-bg flex h-full w-full flex-col', pageTopPadding)}>
      <div className="flex items-center gap-3 px-6 pb-4 pt-3">
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
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={handleNewChat}>
          {t('history.newChat')}
        </Button>
      </div>

      {/* Search sits OUTSIDE the scroller, at the grid's own max width, so it
          stays reachable however far down a long history you have scrolled.
          It renders only once there is something to search: an input over an
          empty page is a control that cannot act. */}
      {!loading && rows.length > 0 && (
        <div className="px-6 pb-4">
          <label className="relative mx-auto block w-full max-w-5xl">
            <Search01Icon
              size={15}
              aria-hidden
              className="text-muted pointer-events-none absolute start-3 top-1/2 -translate-y-1/2"
            />
            <input
              type="search"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('history.searchPlaceholder')}
              aria-label={t('history.searchPlaceholder')}
              className={cn(
                'border-border bg-bg text-fg placeholder:text-muted w-full rounded-lg border py-2 pe-3 ps-9 text-sm',
                'focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none'
              )}
            />
          </label>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-6 pb-6">
        <div className="mx-auto flex h-full max-w-5xl flex-col">
          {loading && (
            <div className="grid grid-cols-1 gap-x-3 gap-y-1 pb-8 md:grid-cols-2">
              {Array.from({ length: 20 }).map((_, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 rounded-xl px-4 py-3"
                  aria-hidden="true"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex h-5 items-center">
                      <div
                        className="bg-border/60 h-3.5 animate-pulse rounded"
                        style={{ width: `${skeletonTitleWidths[i % skeletonTitleWidths.length]}%` }}
                      />
                    </div>
                    <div className="flex h-4 items-center">
                      <div className="bg-border/60 h-3 w-20 animate-pulse rounded" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {!loading && visible.length === 0 && (
            <div className="text-muted flex flex-1 flex-col items-center justify-center gap-3 text-center">
              <BubbleChatIcon size={40} className="opacity-40" />
              <p className="text-sm">
                {rows.length === 0 ? t('history.empty') : t('history.searchEmpty')}
              </p>
            </div>
          )}
          {!loading && visible.length > 0 && (
            /* The bottom breathing room lives HERE, on the content, not on the
               scroll container's pb-6: the wrapper above is h-full, so the
               groups overflow OUT of its box and Chromium drops the scroller's
               end-side padding — the last row ends flush against the window
               edge. Padding on the overflowing content itself survives (a
               margin does not). The scroller keeps its pb-6 for short lists
               that never overflow. */
            <div className="flex flex-col gap-5 pb-8">
              {groups.map((group) => (
                <section key={group.key} className="flex flex-col gap-1.5">
                  {/* The header sits at the row padding's inset so it lines up
                      with the titles under it, not with the number chips. */}
                  <h2 className="text-muted px-4 text-[11px] font-medium tracking-wide uppercase">
                    {t(group.labelKey)}
                  </h2>
                  <div className="grid grid-cols-1 gap-x-3 gap-y-1 md:grid-cols-2">
                    {group.rows.map((row, i) => {
                      // Rank in the WHOLE list, not in this group — the chip
                      // number has to keep counting across the headers.
                      const position = group.startIndex + i
                      const isActive = activeConversationId === row.conversationId
                      const processing = row.phase === 'processing'
                      const title = row.title
                      const sourceIcon = row.icon
                      const diagnosticsDisabled = !row.indexed
                      // Visibility and the disabled dim are ONE decision, not two
                      // opacity utilities stacked in the class list: `cn` is plain
                      // clsx, so a second `opacity-*` would be settled by stylesheet
                      // order rather than by the order written here. The row that is
                      // currently open keeps its actions on screen — it is already
                      // pinned with its own surface, so the controls read as part of
                      // that row instead of as hover chrome; every other row reveals
                      // them on hover.
                      const actionVisibility = (disabled: boolean): string =>
                        disabled
                          ? isActive
                            ? 'opacity-40'
                            : 'opacity-0 group-hover:opacity-40'
                          : isActive
                            ? 'opacity-100'
                            : 'opacity-0 group-hover:opacity-100'
                      return (
                        <div
                          key={row.conversationId}
                          className={cn(
                            'group flex items-center gap-3 rounded-xl px-4 py-3',
                            'hover:bg-surface cursor-pointer',
                            isActive && 'bg-surface border-border border'
                          )}
                          onClick={() => handleResume(row.conversationId)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleResume(row.conversationId)
                          }}
                        >
                          <span
                            aria-hidden
                            className={cn(
                              CONVERSATION_CHIP_BASE,
                              conversationChipClasses(row.phase, isActive)
                            )}
                          >
                            {position}
                          </span>
                          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span className="text-fg truncate text-sm font-medium">{title}</span>
                              {sourceIcon ? (
                                <span aria-hidden className="shrink-0 text-xs leading-none">
                                  {sourceIcon}
                                </span>
                              ) : (
                                <ChannelIcon
                                  channel={row.channel}
                                  size={12}
                                  className="text-muted shrink-0"
                                />
                              )}
                            </div>
                            <span className="text-muted text-xs">
                              {relativeTime(row.updatedAt, locale)}
                            </span>
                          </div>
                          {/* Row actions as one cluster — the row's own gap-3
                              would read as two unrelated controls, not a pair. */}
                          <div className="flex shrink-0 items-center gap-0.5">
                            {/* Diagnostic export — this is the ONLY export
                                button in the app now (the chat composer used to
                                carry a second one), so it stays live for the
                                open conversation too. The collector reads the
                                conversation off DISK, and an in-app transcript
                                only lands there at turn boundaries, so pressing
                                this mid-turn bundles a transcript ending at the
                                previous turn — the corpus logs still cover the
                                live turn, which is what a run that has gone
                                wrong is usually read from. Background runs were
                                always exportable on exactly that reasoning; the
                                open conversation is no different. Off only
                                while the row is live-only (`!indexed`): that
                                conversation isn't in the index — for an in-app
                                first turn it isn't even on disk yet — so there
                                is nothing to collect until the index catches
                                up. */}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                if (!diagnosticsDisabled) setDiagnosticsTarget(row.conversationId)
                              }}
                              disabled={diagnosticsDisabled}
                              aria-label={t('diagnostics.button')}
                              title={
                                diagnosticsDisabled
                                  ? t('history.diagnosticsPending')
                                  : t('diagnostics.button')
                              }
                              className={cn(
                                'text-muted rounded-lg p-1.5',
                                actionVisibility(diagnosticsDisabled),
                                diagnosticsDisabled
                                  ? 'cursor-not-allowed'
                                  : 'cursor-pointer hover:text-fg',
                                'focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent'
                              )}
                            >
                              <Bug01Icon size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                if (!processing) setDeleteTarget(row)
                              }}
                              disabled={processing}
                              aria-label={t('history.delete')}
                              title={processing ? t('history.processing') : undefined}
                              className={cn(
                                'text-muted rounded-lg p-1.5',
                                actionVisibility(processing),
                                processing
                                  ? 'cursor-not-allowed'
                                  : 'cursor-pointer hover:text-red-600 dark:hover:text-red-400',
                                'focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent'
                              )}
                            >
                              <Delete01Icon size={14} />
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>

      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={t('history.deleteTitle')}
        footer={
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteTarget(null)}
              className="flex-1"
            >
              {t('history.deleteCancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleDelete}
              className="flex-1 border border-transparent bg-red-600 text-white shadow-none hover:bg-red-700"
            >
              {t('history.deleteConfirm')}
            </Button>
          </div>
        }
      >
        <p className="text-muted">{t('history.deleteWarning')}</p>
      </Modal>

      {/* Portals to <body> and owns the screen until the archive is written.
          History unmounts on navigation, so it needs no visibility gate the way
          the always-mounted Chat sessions do. */}
      {diagnosticsTarget && (
        <DiagnosticExportOverlay
          conversationId={diagnosticsTarget}
          onClose={() => setDiagnosticsTarget(null)}
        />
      )}
    </main>
  )
}

function relativeTime(timestamp: number, locale: string): string {
  const now = Date.now()
  const diff = now - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
    if (days > 0) return rtf.format(-days, 'day')
    if (hours > 0) return rtf.format(-hours, 'hour')
    if (minutes > 0) return rtf.format(-minutes, 'minute')
    return rtf.format(-seconds, 'second')
  } catch {
    if (days > 0) return `${days}d ago`
    if (hours > 0) return `${hours}h ago`
    if (minutes > 0) return `${minutes}m ago`
    return 'just now'
  }
}
