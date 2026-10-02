import { RTL_LOCALES } from '@lib/i18n'
import { cn } from '@lib/utils/cn'
import { pageTopPadding } from '@lib/utils/platform'
import { Heartbeat, type HeartbeatView } from '@pages/Heartbeat'
import { Procedures } from '@pages/Procedures'
import { Processes } from '@pages/Processes'
import { Projects } from '@pages/Projects'
import { useFlow } from '@providers/flow/useFlow'
import { useLocale } from '@providers/locale/useLocale'
import {
  ArrowLeft02Icon,
  ArrowRight02Icon,
  ComputerTerminal01Icon,
  Folder01Icon,
  GridViewIcon,
  HeartCheckIcon,
  PlayListIcon,
  SourceCodeIcon
} from 'hugeicons-react'
import { useEffect, useState, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'

type Tab = 'automations' | 'projects' | 'procedures' | 'processes'

const TABS: { key: Tab; icon: ComponentType<{ size?: number }>; labelKey: string }[] = [
  { key: 'automations', icon: HeartCheckIcon, labelKey: 'chat.heartbeat' },
  { key: 'projects', icon: Folder01Icon, labelKey: 'chat.projects' },
  { key: 'procedures', icon: PlayListIcon, labelKey: 'chat.procedures' },
  { key: 'processes', icon: ComputerTerminal01Icon, labelKey: 'chat.processes' }
]

/**
 * The tab you left on, for the next visit. Module-level rather than state:
 * the page unmounts on Back (NonChatScreen renders one screen at a time), and
 * coming back to Procedures after a detour through chat should land on
 * Procedures, not reset to the first tab every time.
 */
let lastTab: Tab = 'automations'

/**
 * Library — Automations, Projects and Procedures as one page with three tabs.
 *
 * The same move Customization made for Soul, User and Agents: three sidebar
 * rows that each opened a near-identical card grid under its own back button
 * become one destination with the tabs where the Changelog page puts its
 * version chip — back button leading, tabs beside it, the grid below. The
 * three pages keep their own state, loads and editor sheets; this page only
 * owns the chrome they used to duplicate.
 *
 * Only the active tab is mounted. Unlike Customization there is no draft to
 * keep warm across tabs — each grid is a list over a file the main process
 * pushes changes for, so remounting is a cheap reload — and mounting all three
 * would let a hidden Automations tab's Cmd+S listener fire from Projects.
 *
 * The cards/markdown toggle Automations used to keep in its own header sits
 * at the trailing end of this one while that tab is active, so it stays where
 * it was on screen; `view` lives here because the header does.
 */
export function Library(): React.JSX.Element {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const isRtl = RTL_LOCALES.has(locale)
  const BackIcon = isRtl ? ArrowRight02Icon : ArrowLeft02Icon
  const { goTo } = useFlow()

  const [active, setActive] = useState<Tab>(lastTab)
  const [view, setView] = useState<HeartbeatView>('cards')
  useEffect(() => {
    lastTab = active
  }, [active])

  return (
    <main className={cn('bg-bg flex h-full w-full flex-col', pageTopPadding)}>
      <header className="border-border flex items-center justify-between gap-2 border-b px-3 py-3">
        <div className="flex items-center gap-2">
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

          {/* Laid out with the document flow, so in Arabic the tabs run
              right-to-left from the back button without a mirrored class. */}
          <div
            role="tablist"
            aria-label={t('library.title')}
            className="border-border bg-surface inline-flex items-center rounded-lg border p-0.5"
          >
            {TABS.map(({ key, icon: Icon, labelKey }) => {
              const selected = key === active
              return (
                <button
                  key={key}
                  role="tab"
                  type="button"
                  aria-selected={selected}
                  onClick={() => setActive(key)}
                  className={cn(
                    'flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium',
                    'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                    selected ? 'bg-primary text-primary-fg' : 'text-muted hover:text-fg'
                  )}
                >
                  <Icon size={14} />
                  <span>{t(labelKey)}</span>
                </button>
              )
            })}
          </div>
        </div>

        {active === 'automations' ? (
          <button
            type="button"
            onClick={() => setView((v) => (v === 'cards' ? 'markdown' : 'cards'))}
            aria-label={view === 'cards' ? t('heartbeat.markdownMode') : t('heartbeat.cardsMode')}
            className={cn(
              'text-muted hover:text-fg flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-2 text-sm',
              'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
            )}
          >
            {view === 'cards' ? <SourceCodeIcon size={16} /> : <GridViewIcon size={16} />}
            <span>{view === 'cards' ? t('heartbeat.markdownMode') : t('heartbeat.cardsMode')}</span>
          </button>
        ) : null}
      </header>

      {active === 'automations' ? (
        <Heartbeat view={view} />
      ) : active === 'projects' ? (
        <Projects />
      ) : active === 'processes' ? (
        <Processes />
      ) : (
        <Procedures />
      )}
    </main>
  )
}
