import { BrowserChrome } from '@components/common/browser-card/BrowserChrome'
import { StartPanel } from '@components/common/browser-card/StartPanel'
import { isStartPage } from '@components/common/browser-card/start-page'
import {
  useConversationBrowser,
  type ConversationBrowser
} from '@components/common/browser-card/useConversationBrowser'
import { useScreencast } from '@components/common/browser-card/useScreencast'
import { ExpandedSheet } from '@components/core/ExpandedSheet'
import { cn } from '@lib/utils/cn'
import { isWeb } from '@lib/utils/platform'
import logo from '@resources/images/icon.png'
import type { BrowserTabSnapshot } from '@preload/index'
import { BrowserIcon, KeyboardIcon } from 'hugeicons-react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * The conversation's browser at full size: the same chrome as the chat card
 * (BrowserChrome) over the real page — the WebContentsView raised by main over
 * the stage div, so input is native and the user can sign in or solve a
 * challenge by hand. Reached from the card's expand button and from the disc
 * beside New chat; either way it is the card's browser, bigger, not another.
 *
 * The page is raised only once the sheet's slide-in has finished: the chrome
 * and the page are one piece, and a native view cannot ride a CSS animation,
 * so it joins when the panel has stopped moving rather than sitting still
 * while the controls slide over it.
 *
 * The Web UI has no native view to raise — raising it would move the page
 * over the desktop window of the machine serving it — so there the stage is
 * the card's canvas at the sheet's size (WebStage).
 */
export function BrowserSheet({
  conversationId,
  onClose,
  browser: shared
}: {
  conversationId: string | null
  onClose: () => void
  /** The card's hook, when opened from a card — one state, two sizes. */
  browser?: ConversationBrowser
}): React.JSX.Element {
  const { t } = useTranslation()
  const own = useConversationBrowser({ conversationId })
  const browser = shared ?? own
  const stageRef = useRef<HTMLDivElement>(null)
  const activeId = browser.active?.tabId ?? null

  // With nothing open, open a start page — the sheet is never empty.
  const { loaded, tabs, newTab } = browser
  useEffect(() => {
    if (loaded && tabs.length === 0) void newTab()
  }, [loaded, tabs.length, newTab])

  useLayoutEffect(() => {
    if (!activeId || isWeb) return
    const stage = stageRef.current
    if (!stage) return
    const tabId = activeId
    let raf = 0
    let raised = false
    const publish = (): void => {
      const r = stage.getBoundingClientRect()
      void window.api.browser.setStageRect(tabId, {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height)
      })
    }
    const raise = (): void => {
      if (raised) return
      raised = true
      publish()
      void window.api.browser.setMode(tabId, 'expanded').catch(() => {})
    }
    const ro = new ResizeObserver(() => {
      if (!raised) return
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(publish)
    })
    ro.observe(stage)
    // Join when the panel stops moving; the timer covers a panel with no
    // animation (reduced motion) or one that already finished.
    const panel = stage.closest('aside')
    const onEnd = (e: Event): void => {
      if (e.target === panel) raise()
    }
    panel?.addEventListener('animationend', onEnd)
    const fallback = setTimeout(raise, 260)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
      clearTimeout(fallback)
      panel?.removeEventListener('animationend', onEnd)
      void window.api.browser.setMode(tabId, 'card').catch(() => {})
    }
  }, [activeId])

  return (
    <ExpandedSheet
      open
      onClose={onClose}
      title={t('chat.browser.startTitle')}
      leading={
        <img src={logo} alt="" className="h-[18px] w-[18px] shrink-0 rounded-md object-cover" />
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <BrowserChrome browser={browser} showTitle={false} autoFocusAddress />
        {isWeb ? (
          <WebStage tab={browser.active} />
        ) : (
          // The real page is drawn by main over this div's rect.
          <div
            ref={stageRef}
            className="bg-surface min-h-0 flex-1"
            aria-label={t('chat.browser.livePage')}
          >
            {!activeId && <StartPanel />}
          </div>
        )}
      </div>
    </ExpandedSheet>
  )
}

/**
 * The Web UI's page: the tab's screencast on a canvas the size of the sheet,
 * with mouse, wheel and touch sent back in, and a hidden field the keyboard
 * button focuses — the one way to bring up a phone's keyboard for the page.
 */
function WebStage({ tab }: { tab: BrowserTabSnapshot | null }): React.JSX.Element {
  const { t } = useTranslation()
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { hasFrame, setHover, keyboardRef } = useScreencast({
    tabId: tab?.tabId ?? null,
    hostRef,
    canvasRef,
    paused: false,
    touch: true,
    keyboard: true
  })
  const errored = tab?.loadState === 'error' && tab.error
  const host = ((): string => {
    if (!tab || isStartPage(tab.url)) return ''
    try {
      return new URL(tab.url).host || tab.url
    } catch {
      return tab.url
    }
  })()

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={hostRef}
        tabIndex={-1}
        aria-label={t('chat.browser.livePage')}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className="bg-surface absolute inset-0 touch-none overflow-hidden outline-none"
      >
        <canvas
          ref={canvasRef}
          className={cn('block h-full w-full object-cover object-top', !hasFrame && 'opacity-0')}
          aria-hidden
        />
        {!tab && (
          <div className="absolute inset-0">
            <StartPanel />
          </div>
        )}
        {tab && !hasFrame && !errored && (
          <div className="text-muted absolute inset-0 flex flex-col items-center justify-center gap-3 text-xs">
            <BrowserIcon size={28} aria-hidden />
            <span>{host ? t('chat.browser.opening', { host }) : t('chat.browser.loading')}</span>
          </div>
        )}
        {errored && (
          <div
            role="alert"
            className="absolute inset-x-3 bottom-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900 dark:border-red-700 dark:bg-red-900/40 dark:text-red-100"
          >
            {tab.error?.message}
          </div>
        )}
        <textarea
          ref={keyboardRef}
          aria-label={t('chat.browser.keyboard')}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          // 16px keeps iOS from zooming the app in when the field takes focus.
          className="pointer-events-none absolute bottom-0 start-0 h-px w-px resize-none border-0 p-0 text-[16px] opacity-0"
        />
      </div>
      {tab && (
        // Outside the host, so a tap on it never reaches the page beneath;
        // focused inside the tap itself, or a phone will not raise its keyboard.
        <button
          type="button"
          onClick={() => keyboardRef.current?.focus({ preventScroll: true })}
          aria-label={t('chat.browser.keyboard')}
          title={t('chat.browser.keyboard')}
          className="border-border bg-surface/90 text-muted hover:text-fg absolute end-3 bottom-3 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border shadow-sm backdrop-blur focus-visible:ring-2 focus-visible:ring-accent"
        >
          <KeyboardIcon size={18} />
        </button>
      )}
    </div>
  )
}
