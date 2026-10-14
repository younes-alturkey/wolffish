import { BrowserChrome, CHROME_HEIGHT } from '@components/common/browser-card/BrowserChrome'
import { useConversationBrowser } from '@components/common/browser-card/useConversationBrowser'
import { useScreencast } from '@components/common/browser-card/useScreencast'
import { isStartPage } from '@components/common/browser-card/start-page'
import { BrowserSheet } from '@components/common/browser-sheet/BrowserSheet'
import { cn } from '@lib/utils/cn'
import { BrowserIcon, FileEmpty01Icon, PlayIcon } from 'hugeicons-react'
import type { BrowserTabSnapshot } from '@preload/index'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * The conversation's browser, in the chat feed. ONE card per conversation:
 * the model opens, navigates and switches tabs and this same card follows;
 * the tab strip shows every tab, the canvas shows the active one.
 *
 * Two sizes, one browser. Main owns each tab as a WebContentsView parked in
 * the window's corner; the card draws its screencast into a <canvas> — a DOM
 * element, so it clips and scrolls with the feed and survives a remount —
 * and forwards the user's mouse, wheel and keys into the page, so the card is
 * usable as it is (useScreencast). The expand button opens the same browser,
 * same chrome, same state, at full size (BrowserSheet) with the real view and
 * native input for anything the forwarded events cannot do (IME, file
 * pickers, 2FA) — or, in the Web UI, the same canvas made large.
 *
 * Reopening the conversation reopens the browser: the segment carries the
 * last page, and an empty browser restores it on first look.
 */

const CARD_HEIGHT = 340

export function BrowserCard({ snapshot }: { snapshot: BrowserTabSnapshot }): React.JSX.Element {
  const { t } = useTranslation()
  const browser = useConversationBrowser({
    conversationId: snapshot.conversationId,
    tabId: snapshot.tabId,
    seed: snapshot
  })
  const { active, loaded, tabs } = browser
  // A conversation opened from history has a page to bring back: that is a
  // LOADING browser, never a closed or empty one. Closed is only ever the
  // result of closing it in this session — i.e. after the one restore
  // attempt has settled.
  const restoreStartedRef = useRef(false)
  const [restoreSettled, setRestoreSettled] = useState(false)
  const restoring = loaded && tabs.length === 0 && !restoreSettled && !!snapshot.url
  const closed = loaded && tabs.length === 0 && !restoring
  const tabId = active?.tabId ?? null
  const [sheetOpen, setSheetOpen] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const { hasFrame, setHover } = useScreencast({
    tabId: closed ? null : tabId,
    hostRef,
    canvasRef,
    paused: sheetOpen,
    height: CARD_HEIGHT,
    mode: active?.mode ?? 'card'
  })

  // A browser that was used in this conversation comes back with it. Tabs
  // die with the app process; the card's segment remembers the strip, so on
  // the FIRST look — and only then, a browser the user just closed stays
  // closed — an empty browser reopens on the tabs it had.
  useEffect(() => {
    if (!loaded || restoreStartedRef.current) return
    restoreStartedRef.current = true
    const settle = (): void => setRestoreSettled(true)
    if (tabs.length === 0 && snapshot.url) {
      void restoreBrowser(snapshot).finally(settle)
    } else {
      void Promise.resolve().then(settle)
    }
  }, [loaded, tabs.length, snapshot])

  const loading = active?.loadState === 'loading'
  const errored = active?.loadState === 'error' && active.error
  // What the empty canvas means. A start page with nothing drawn yet is the
  // only genuine "nothing to show"; any real URL is a page on its way.
  const pendingUrl = restoring ? snapshot.url : active && !isStartPage(active.url) ? active.url : ''
  const pendingHost = ((): string => {
    try {
      return new URL(pendingUrl).host || pendingUrl
    } catch {
      return pendingUrl
    }
  })()
  const opening = (
    <div className="text-muted flex w-full flex-col items-center justify-center gap-3 text-xs">
      <BrowserIcon size={28} aria-hidden />
      <span>{t('chat.browser.opening', { host: pendingHost })}</span>
      <span className="bg-border relative h-1 w-40 overflow-hidden rounded-full" aria-hidden>
        <span className="wf-progress-fake bg-accent absolute inset-y-0 start-0 w-full rounded-full" />
      </span>
    </div>
  )

  return (
    <div className="border-border bg-surface flex w-full max-w-[85%] flex-col self-start overflow-hidden rounded-2xl border text-sm">
      {closed ? (
        // Same footprint as a live card, so the feed does not jump; the
        // browser can come straight back on the page it had.
        <div
          className="text-muted flex w-full flex-col items-center justify-center gap-3 text-xs"
          style={{ height: CARD_HEIGHT + CHROME_HEIGHT }}
        >
          <BrowserIcon size={28} aria-hidden />
          <span>{t('chat.browser.closedNote')}</span>
          <button
            type="button"
            onClick={() => void restoreBrowser(snapshot)}
            className="border-border text-fg hover:bg-border/40 mt-1 flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium focus-visible:ring-2 focus-visible:ring-accent"
          >
            <PlayIcon size={13} aria-hidden />
            {t('chat.browser.relaunch')}
          </button>
        </div>
      ) : (
        <BrowserChrome
          browser={browser}
          showTitle
          onExpand={() => setSheetOpen(true)}
          onCloseAll={browser.closeAll}
        />
      )}

      {!closed && (
        <div
          ref={hostRef}
          tabIndex={0}
          aria-label={t('chat.browser.livePage')}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          className="bg-surface relative w-full overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
          style={{ height: CARD_HEIGHT }}
        >
          <canvas
            ref={canvasRef}
            className={cn('block h-full w-full object-cover object-top', !hasFrame && 'opacity-0')}
            aria-hidden
          />
          {!hasFrame && !errored && (
            <div className="absolute inset-0 flex items-center justify-center">
              {sheetOpen ? (
                <span className="text-muted text-xs">{t('chat.browser.openInSheet')}</span>
              ) : pendingUrl || loading ? (
                opening
              ) : (
                <div className="text-muted flex flex-col items-center gap-3 text-xs">
                  <FileEmpty01Icon size={28} aria-hidden />
                  <span>{t('chat.browser.waiting')}</span>
                </div>
              )}
            </div>
          )}
          {sheetOpen && hasFrame && (
            <div className="text-muted bg-surface/70 absolute inset-0 flex items-center justify-center text-xs backdrop-blur-[1px]">
              {t('chat.browser.openInSheet')}
            </div>
          )}
          {errored && (
            <div
              role="alert"
              className="absolute inset-x-3 bottom-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900 dark:border-red-700 dark:bg-red-900/40 dark:text-red-100"
            >
              {active?.error?.message}
            </div>
          )}
        </div>
      )}

      {sheetOpen && !closed && (
        <BrowserSheet
          conversationId={snapshot.conversationId}
          browser={browser}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </div>
  )
}

/**
 * Bring a persisted browser back: every tab of its strip, in order, then the
 * one that was showing. A segment from before strips were recorded restores
 * its single page.
 */
async function restoreBrowser(snapshot: BrowserTabSnapshot): Promise<void> {
  const entries =
    snapshot.strip && snapshot.strip.length > 0
      ? snapshot.strip
      : [{ url: snapshot.url, title: snapshot.title, active: true }]
  let activeId: string | null = null
  for (const e of entries) {
    try {
      const made = await window.api.browser.createTab({
        url: e.url,
        conversationId: snapshot.conversationId
      })
      if (e.active) activeId = made.tabId
    } catch {
      // a page that will not open is skipped; the rest still come back
    }
  }
  if (activeId) await window.api.browser.activate(activeId).catch(() => {})
}
