import { isStartPage } from '@components/common/browser-card/start-page'
import logo from '@resources/images/icon.png'
import {
  addressOf,
  labelOf,
  type ConversationBrowser
} from '@components/common/browser-card/useConversationBrowser'
import { cn } from '@lib/utils/cn'
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  LinkSquare02Icon,
  ArrowExpandIcon,
  PlusSignIcon,
  RefreshIcon
} from 'hugeicons-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * The browser's controls — ONE piece, used unchanged by the chat card and by
 * the expanded sheet, so the two are the same browser at two sizes:
 *
 *   row 1  title · the conversation's tabs as chips (× each) · new tab · [open in browser · expand · close]
 *   row 2  back · forward · reload · address
 *
 * The card adds expand/close at the end of row 1; the sheet carries its own
 * title and close in the ExpandedSheet header, so it hides the title here.
 */
/** Two fixed 36px rows + the 1px rule under them: the card's closed state
 *  reserves exactly this so the feed never shifts when a browser closes. */
export const CHROME_HEIGHT = 36 * 2 + 1

export function BrowserChrome({
  browser,
  showTitle,
  onExpand,
  onCloseAll,
  autoFocusAddress
}: {
  browser: ConversationBrowser
  showTitle: boolean
  onExpand?: () => void
  onCloseAll?: () => void
  /** Land the caret in the address field when a start page comes on show. */
  autoFocusAddress?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const { tabs, active } = browser
  const [draft, setDraft] = useState<string | null>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const activeId = active?.tabId ?? null
  const startPage = !!active && isStartPage(active.url)

  useEffect(() => {
    if (autoFocusAddress && startPage) addressRef.current?.focus()
  }, [autoFocusAddress, startPage, activeId])

  useEffect(() => {
    stripRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId])

  const submit = (): void => {
    const url = toUrl(draft ?? '')
    setDraft(null)
    if (url) browser.navigate(url)
  }

  const iconButton =
    'text-muted hover:text-fg flex shrink-0 cursor-pointer items-center justify-center rounded p-1 focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:opacity-40'
  const loading = active?.loadState === 'loading'

  return (
    <div className="border-border flex shrink-0 flex-col border-b">
      <div
        role="tablist"
        aria-label={t('chat.browser.pages')}
        className="flex h-9 min-w-0 items-center gap-1 px-2.5"
      >
        {showTitle && (
          <>
            {/* In the chat card the logo IS the title. */}
            <img
              src={logo}
              alt={t('chat.browser.startTitle')}
              title={t('chat.browser.startTitle')}
              className="h-[18px] w-[18px] shrink-0 rounded-md object-cover"
            />
            <span className="border-border mx-1 h-4 shrink-0 border-s" aria-hidden />
          </>
        )}
        {/* The strip scrolls sideways without end and without a bar; a
            vertical wheel over it scrolls it too, since that is the wheel a
            mouse has. The + stays put outside the scroller. */}
        <div
          ref={stripRef}
          onWheel={(e) => {
            const el = stripRef.current
            if (!el || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
            el.scrollLeft += e.deltaY
          }}
          className="wf-scroll-x-bare flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden"
        >
          {tabs.map((x) => {
            const selected = x.tabId === activeId
            return (
              <span
                key={x.tabId}
                className={cn(
                  'flex max-w-48 shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-xs',
                  selected ? 'border-border bg-border/40 text-fg' : 'text-muted border-transparent'
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => {
                    setDraft(null)
                    browser.activate(x.tabId)
                  }}
                  title={x.url}
                  className="min-w-0 cursor-pointer truncate focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {labelOf(x, t('chat.browser.startTitle'))}
                </button>
                <button
                  type="button"
                  onClick={() => browser.closeTab(x.tabId)}
                  aria-label={t('chat.browser.closeTab')}
                  title={t('chat.browser.closeTab')}
                  className="text-muted hover:text-fg cursor-pointer rounded focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <Cancel01Icon size={12} />
                </button>
              </span>
            )
          })}
        </div>
        <button
          type="button"
          onClick={() => void browser.newTab()}
          aria-label={t('chat.browser.newTab')}
          title={t('chat.browser.newTab')}
          className={iconButton}
        >
          <PlusSignIcon size={14} />
        </button>
        {active && !startPage && (
          <button
            type="button"
            onClick={() => void window.api.browser.openExternal(active.url)}
            aria-label={t('chat.browser.openInBrowser')}
            title={t('chat.browser.openInBrowser')}
            className={iconButton}
          >
            <LinkSquare02Icon size={15} />
          </button>
        )}
        {onExpand && (
          <button
            type="button"
            onClick={onExpand}
            aria-label={t('chat.browser.expand')}
            title={t('chat.browser.expand')}
            className={iconButton}
          >
            <ArrowExpandIcon size={15} />
          </button>
        )}
        {onCloseAll && (
          <button
            type="button"
            onClick={onCloseAll}
            aria-label={t('chat.browser.closeAll')}
            title={t('chat.browser.closeAll')}
            className={iconButton}
          >
            <Cancel01Icon size={15} />
          </button>
        )}
      </div>

      <div className="flex h-9 items-center gap-1 px-2.5">
        <button
          type="button"
          disabled={!active?.canGoBack}
          onClick={browser.goBack}
          aria-label={t('chat.browser.back')}
          title={t('chat.browser.back')}
          className={iconButton}
        >
          <ArrowLeft01Icon size={15} className="rtl:rotate-180" />
        </button>
        <button
          type="button"
          disabled={!active?.canGoForward}
          onClick={browser.goForward}
          aria-label={t('chat.browser.forward')}
          title={t('chat.browser.forward')}
          className={iconButton}
        >
          <ArrowRight01Icon size={15} className="rtl:rotate-180" />
        </button>
        <button
          type="button"
          disabled={!active}
          onClick={browser.reload}
          aria-label={t('chat.browser.reload')}
          title={t('chat.browser.reload')}
          className={iconButton}
        >
          <RefreshIcon size={15} className={cn(loading && 'animate-spin')} />
        </button>
        <input
          ref={addressRef}
          type="text"
          dir="ltr"
          disabled={!active}
          value={draft ?? addressOf(active)}
          placeholder={t('chat.browser.address')}
          aria-label={t('chat.browser.address')}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
              e.currentTarget.blur()
            }
          }}
          className="border-border bg-bg text-fg placeholder:text-muted min-w-0 flex-1 rounded-md border px-2.5 py-0.5 font-mono text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
        />
      </div>
    </div>
  )
}

/** What the user typed → what to load. Bare hosts get a scheme; localhost stays http. */
function toUrl(input: string): string | null {
  const s = input.trim()
  if (!s) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s
  const host = s.split(/[/?#]/)[0]
  const local = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i.test(host)
  return `${local ? 'http' : 'https'}://${s}`
}
