import { ChannelIcon } from '@components/common/channel-icon/ChannelIcon'
import { hasChannelIcon } from '@components/common/channel-icon/hasChannelIcon'
import { CONVERSATION_CHIP_BASE, conversationChipClasses } from '@lib/conversation-chip'
import { mapConversationMessages } from '@lib/conversation-open'
import {
  buildConversationRows,
  filterConversationRows,
  groupConversationRows,
  runPhaseKey,
  type ConversationRow
} from '@lib/conversation-rows'
import { cn } from '@lib/utils/cn'
import { isMac } from '@lib/utils/platform'
import type { ConversationMeta, Project } from '@preload/index'
import { useFlow, type Screen } from '@providers/flow/useFlow'
import { useSessions } from '@providers/sessions/useSessions'
import {
  AiBrain01Icon,
  Clock01Icon,
  FileEditIcon,
  LibraryIcon,
  Search01Icon,
  Settings02Icon
} from 'hugeicons-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'

/** Rows rendered before the first scroll, and rows added per reach-the-end. */
const PAGE = 40

/**
 * Every navigable page, Settings first, in the mobile sheet's row idiom. The
 * same screens the old left rail carried — the sheet replaces the rail, it
 * doesn't curate it.
 */
const NAV: {
  key: string
  screen: Screen
  icon: ComponentType<{ size?: number }>
  labelKey: string
}[] = [
  { key: 'settings', screen: 'settings', icon: Settings02Icon, labelKey: 'chat.settings' },
  { key: 'library', screen: 'library', icon: LibraryIcon, labelKey: 'chat.library' },
  {
    key: 'customization',
    screen: 'customization',
    icon: AiBrain01Icon,
    labelKey: 'chat.customization'
  },
  { key: 'viewer', screen: 'viewer', icon: FileEditIcon, labelKey: 'chat.workspace' },
  { key: 'history', screen: 'history', icon: Clock01Icon, labelKey: 'chat.conversations' }
]

/**
 * Leading-edge conversations sheet — the desktop port of the mobile app's
 * ConversationsSheet. A fixed strip of page rows on top (never scrolls), a
 * divider, then the full cross-channel conversations list as the only
 * scroller, windowed PAGE rows at a time ("infinite" growth on reach-the-end;
 * the index is already in memory, so windowing is a render cap, not a fetch).
 *
 * Mounted-ness is a pure function of `open` (the parent renders it only while
 * open): state — the scroll position, the window limit, the fetched metas —
 * resets naturally on every open, and nothing here re-renders on streamed
 * tokens while the sheet is closed. Enter animates via transform only
 * (.wf-sheet-panel); exit is an instant unmount like every other overlay.
 */
export function ConversationsSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const { goTo } = useFlow()
  const {
    runStatuses,
    openConversation,
    activateConversation,
    activeConversationId,
    activeProject
  } = useSessions()
  const [metas, setMetas] = useState<ConversationMeta[]>([])
  // Projects, for resolving a bound conversation's badge emoji LIVE (an icon
  // change on the Projects page propagates; a stamp would go stale).
  const [projects, setProjects] = useState<Project[]>([])
  const [limit, setLimit] = useState(PAGE)
  // Title search over the conversations below — never over the page rows
  // above, which are the way OUT of chat and must stay where they are.
  const [query, setQuery] = useState('')
  const scrollerRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Refresh the list on mount and whenever any turn starts/ends anywhere — a
  // turn starting is exactly when a new conversation can appear, and the
  // cortex-backed list call is ~1ms.
  const statusKey = useMemo(() => runPhaseKey(runStatuses), [runStatuses])
  useEffect(() => {
    let cancelled = false
    void window.api.conversation.list().then((list) => {
      if (!cancelled) setMetas(list)
    })
    void window.api.projects
      .list()
      .then((list) => {
        if (!cancelled) setProjects(list)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [statusKey])

  // A conversation can change with NO turn lifecycle event — autonomous
  // heartbeat/procedure runs, a create-without-turn, the sensitive-data gate —
  // none of which touch runStatuses/statusKey, so the effect above never fires
  // for them. The main process pushes conversation:changed after the cortex row
  // is (re)indexed/removed, so re-listing here is always fresh. Debounced to
  // coalesce the write bursts of an active turn into a single refetch.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = window.api.conversation.onChanged(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void window.api.conversation.list().then(setMetas), 250)
    })
    return () => {
      if (timer) clearTimeout(timer)
      off()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const rows = useMemo<ConversationRow[]>(() => {
    const all = buildConversationRows({
      metas,
      runStatuses,
      projects,
      untitled: t('chat.conversationsUntitled')
    })
    if (!activeProject) return all
    // Project mode: only this project's conversations. A brand-new one has no
    // indexed projectId until its first end-of-turn save, so the active
    // conversation bridges through on its id — it is by construction the one
    // being created inside the project right now.
    return all.filter(
      (r) => r.projectId === activeProject.id || r.conversationId === activeConversationId
    )
  }, [metas, projects, runStatuses, t, activeProject, activeConversationId])

  // What the sheet lists: the rows the typed keywords match, all of them when
  // nothing is typed. Filtering happens BEFORE the window, so a match buried
  // at row 500 is on screen immediately instead of after twelve scrolls.
  const visible = useMemo(() => filterConversationRows(rows, query), [rows, query])

  // Windowing: slicing a prefix keeps groupConversationRows' rank numbers
  // identical to the listed rows' — the chips count across group headers.
  const windowed = useMemo(
    () => (visible.length > limit ? visible.slice(0, limit) : visible),
    [visible, limit]
  )
  const groups = useMemo(() => groupConversationRows(windowed), [windowed])
  const hasMore = visible.length > windowed.length

  // Grow the window as the sentinel nears the viewport. The observer re-fires
  // after each growth relayouts the sentinel, so a tall screen keeps growing
  // until the sentinel clears the margin or the list is fully rendered.
  useEffect(() => {
    if (!hasMore) return
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setLimit((current) => current + PAGE)
      },
      { root: scrollerRef.current, rootMargin: '400px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore])

  // Close FIRST, then act — the same order the mobile sheet settled on: the
  // destination (a switched conversation, a pushed page) should never render
  // behind a still-open sheet.
  const openRow = useCallback(
    async (conversationId: string) => {
      onClose()
      // A still-processing in-app conversation has no file on disk yet, so
      // activate its live session directly — a load-first path would return
      // null and dead-end. Only fall to disk when no live session holds it.
      if (activateConversation(conversationId)) return
      const conv = await window.api.conversation.load(conversationId)
      if (!conv) return
      openConversation(conv, mapConversationMessages(conv))
    },
    [onClose, activateConversation, openConversation]
  )

  const go = useCallback(
    (screen: Screen) => {
      onClose()
      goTo(screen)
    },
    [onClose, goTo]
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
        aria-label={t('chat.conversations')}
        className={cn(
          'wf-sheet-panel bg-bg border-border/40 absolute inset-y-0 inset-s-0 flex w-130 max-w-[92vw] flex-col border-e'
        )}
      >
        {/* Fixed page rows — deliberately NOT part of the scroller, so the
            way out of chat never scrolls away behind a long history. pt-12
            clears the macOS traffic lights; Windows/Linux keep their native
            titlebar above the webview, so the rows sit higher. */}
        <nav className={cn('flex shrink-0 flex-col gap-0.5 px-2.5 pb-1', isMac ? 'pt-12' : 'pt-6')}>
          {NAV.map(({ key, screen, icon: Icon, labelKey }) => (
            <button
              key={key}
              type="button"
              onClick={() => go(screen)}
              aria-label={t(labelKey)}
              className={cn(
                'text-fg hover:bg-surface flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-1.5 py-2.5',
                'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
              )}
            >
              <span className="text-muted flex h-6 w-6 shrink-0 items-center justify-center">
                <Icon size={17} />
              </span>
              <span className="min-w-0 flex-1 truncate text-start text-[13px] font-medium">
                {t(labelKey)}
              </span>
            </button>
          ))}
        </nav>
        {/* The rule between the pages and the conversations. */}
        <div aria-hidden className="border-border/60 mx-4 mt-2 shrink-0 border-t" />
        {activeProject && (
          <div className="flex shrink-0 items-center gap-1.5 px-4 pt-3">
            <span aria-hidden className="text-[11px] leading-none">
              {activeProject.icon || '📁'}
            </span>
            <span
              title={activeProject.title}
              className="text-muted min-w-0 flex-1 truncate text-[10px] font-medium tracking-wide uppercase"
            >
              {activeProject.title.trim() || t('projects.untitled')}
            </span>
          </div>
        )}
        {/* Search is fixed with the nav rather than scrolling with the list:
            the query is what you are steering the list WITH, so it has to stay
            on screen while the results move. Only rendered once there is
            something to search. */}
        {rows.length > 0 && (
          // The padding lives on the wrapper, not the label, so the icon and
          // the input's own inset are the SAME pair every other search field
          // in the app uses (start-3 / ps-9) rather than a second set of
          // numbers that has to be kept in step with this row's padding.
          <div className="shrink-0 px-2.5 pt-3">
            <label className="relative block">
              <Search01Icon
                size={14}
                aria-hidden
                className="text-muted pointer-events-none absolute start-3 top-1/2 -translate-y-1/2"
              />
              <input
                type="search"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  // A new query is a new list — start it at one window again,
                  // or a wide search inherits the 400 rows the last scroll grew.
                  setLimit(PAGE)
                }}
                placeholder={t('history.searchPlaceholder')}
                aria-label={t('history.searchPlaceholder')}
                className={cn(
                  'border-border bg-bg text-fg placeholder:text-muted w-full rounded-lg border py-1.5 pe-3 ps-9 text-xs',
                  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none'
                )}
              />
            </label>
          </div>
        )}
        <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4">
          {visible.length === 0 ? (
            <p className="text-muted px-1.5 pt-3 text-xs">
              {rows.length === 0 ? t('history.empty') : t('history.searchEmpty')}
            </p>
          ) : (
            <nav className="flex w-full flex-col gap-0.5">
              {groups.map((group) => (
                <div key={group.key} className="flex w-full flex-col gap-0.5">
                  <span className="text-muted truncate px-1.5 pt-2 text-[10px] font-medium tracking-wide uppercase">
                    {t(group.labelKey)}
                  </span>
                  {group.rows.map((row, i) => {
                    // Rank in the WHOLE list — the chip keeps counting past the
                    // group headers rather than restarting at 1 under each.
                    const position = group.startIndex + i
                    const isActive = row.conversationId === activeConversationId
                    return (
                      <button
                        key={row.conversationId}
                        type="button"
                        onClick={() => void openRow(row.conversationId)}
                        title={row.title}
                        aria-label={row.title}
                        className={cn(
                          // `group` lets the chip react to hovering anywhere on
                          // the row. One border ternary (never transparent +
                          // colored at once) because `cn` is a plain join, not
                          // tailwind-merge; both states reserve the 1px so
                          // selection never reflows the list.
                          'group text-muted flex w-full cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1.5 text-start',
                          'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                          isActive
                            ? 'bg-surface border-border border'
                            : 'hover:bg-surface border border-transparent'
                        )}
                      >
                        <span className="relative inline-flex shrink-0">
                          <span
                            aria-hidden
                            className={cn(
                              CONVERSATION_CHIP_BASE,
                              conversationChipClasses(row.phase, isActive)
                            )}
                          >
                            {position}
                          </span>
                          {/* Origin badge: where this conversation came from
                              (channel / automation / procedure), floated off
                              the chip's bottom-end corner, direction-logical. */}
                          {row.icon ? (
                            <span
                              aria-hidden
                              className="absolute -inset-e-1 -bottom-1.5 flex h-3.5 w-3.5 items-center justify-center text-[9px] leading-none"
                            >
                              {row.icon}
                            </span>
                          ) : (
                            hasChannelIcon(row.channel) && (
                              <span className="absolute -inset-e-1 -bottom-1.5 flex h-3.5 w-3.5 items-center justify-center">
                                <ChannelIcon
                                  channel={row.channel}
                                  size={9}
                                  className="text-muted"
                                />
                              </span>
                            )
                          )}
                        </span>
                        <span
                          className={cn(
                            'group-hover:text-fg min-w-0 flex-1 truncate text-xs whitespace-nowrap',
                            isActive && 'text-fg'
                          )}
                        >
                          {row.title}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ))}
            </nav>
          )}
          {hasMore && <div ref={sentinelRef} aria-hidden className="h-px" />}
        </div>
      </aside>
    </div>
  )
}
