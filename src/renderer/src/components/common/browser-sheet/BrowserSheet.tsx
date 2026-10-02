import { BrowserChrome } from '@components/common/browser-card/BrowserChrome'
import { StartPanel } from '@components/common/browser-card/StartPanel'
import {
  useConversationBrowser,
  type ConversationBrowser
} from '@components/common/browser-card/useConversationBrowser'
import { ExpandedSheet } from '@components/core/ExpandedSheet'
import logo from '@resources/images/icon.png'
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
    if (!activeId) return
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
        {/* The real page is drawn by main over this div's rect. */}
        <div
          ref={stageRef}
          className="bg-surface min-h-0 flex-1"
          aria-label={t('chat.browser.livePage')}
        >
          {!activeId && <StartPanel />}
        </div>
      </div>
    </ExpandedSheet>
  )
}
