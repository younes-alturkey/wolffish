import { BrowserChrome, CHROME_HEIGHT } from '@components/common/browser-card/BrowserChrome'
import { useConversationBrowser } from '@components/common/browser-card/useConversationBrowser'
import { isStartPage } from '@components/common/browser-card/start-page'
import { BrowserSheet } from '@components/common/browser-sheet/BrowserSheet'
import { cn } from '@lib/utils/cn'
import { BrowserIcon, FileEmpty01Icon, PlayIcon } from 'hugeicons-react'
import type { BrowserFrame, BrowserInputEvent, BrowserTabSnapshot } from '@preload/index'
import { useCallback, useEffect, useRef, useState } from 'react'
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
 * usable as it is. The expand button opens the same browser, same chrome,
 * same state, at full size (BrowserSheet) with the real view and native input
 * for anything the forwarded events cannot do (IME, file pickers, 2FA).
 *
 * Reopening the conversation reopens the browser: the segment carries the
 * last page, and an empty browser restores it on first look.
 *
 * Cost discipline: the screencast runs only while the card is actually in
 * the chat viewport (a two-way IntersectionObserver) — scrolled away, the
 * canvas keeps its last frame and the tab keeps living in main, unstreamed.
 * In card mode the page's viewport IS the card, so frames fill it edge to
 * edge and the card's coordinates are the page's.
 */

const CARD_HEIGHT = 340
const IDLE_FPS = 5
const HOVER_FPS = 30

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
  const [framedTab, setFramedTab] = useState<string | null>(null)
  const hasFrame = framedTab !== null && framedTab === tabId
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const attachedRef = useRef(false)

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

  // Frames for the active tab: decode off the main thread, draw 1:1.
  useEffect(() => {
    if (!tabId) return
    let cancelled = false
    let pending = false
    const off = window.api.browser.onFrame((frame: BrowserFrame) => {
      if (frame.tabId !== tabId || cancelled || pending) return
      const canvas = canvasRef.current
      if (!canvas) return
      pending = true
      const blob = new Blob([frame.data as BlobPart], { type: 'image/jpeg' })
      createImageBitmap(blob)
        .then((bitmap) => {
          pending = false
          if (cancelled) {
            bitmap.close()
            return
          }
          const ctx = canvas.getContext('2d')
          if (!ctx) return
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width
            canvas.height = bitmap.height
          }
          ctx.drawImage(bitmap, 0, 0)
          bitmap.close()
          setFramedTab(tabId)
        })
        .catch(() => {
          pending = false
        })
    })
    return () => {
      cancelled = true
      off()
    }
  }, [tabId])

  const viewerSize = useCallback((): { width: number; height: number } => {
    const host = hostRef.current
    const dpr = window.devicePixelRatio || 1
    const width = Math.max(1, Math.round((host?.clientWidth ?? 640) * dpr))
    const height = Math.max(1, Math.round(CARD_HEIGHT * dpr))
    return { width, height }
  }, [])

  // The page's viewport in card mode: the card itself, in window CSS pixels.
  const publishCardStage = useCallback((): void => {
    const host = hostRef.current
    if (!host || !tabId) return
    void window.api.browser.setStageRect(tabId, {
      x: 0,
      y: 0,
      width: Math.max(1, Math.round(host.clientWidth)),
      height: CARD_HEIGHT
    })
  }, [tabId])

  // Stream only while on screen, only the active tab, never under the sheet.
  useEffect(() => {
    if (closed || !tabId) return
    const host = hostRef.current
    if (!host) return
    const attach = (): void => {
      if (attachedRef.current) return
      attachedRef.current = true
      publishCardStage()
      void window.api.browser.attachViewer(tabId, viewerSize(), IDLE_FPS)
    }
    const detach = (): void => {
      if (!attachedRef.current) return
      attachedRef.current = false
      void window.api.browser.detachViewer(tabId)
    }
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting)
        if (visible && !sheetOpen) attach()
        else detach()
      },
      { rootMargin: '300px' }
    )
    io.observe(host)
    const ro = new ResizeObserver(() => {
      if (!attachedRef.current || sheetOpen) return
      publishCardStage()
      void window.api.browser.setViewerSize(tabId, viewerSize())
    })
    ro.observe(host)
    return () => {
      io.disconnect()
      ro.disconnect()
      detach()
    }
  }, [tabId, closed, sheetOpen, viewerSize, publishCardStage])

  // Parked again from somewhere else (the sheet closed, a crash): give the
  // page the card's size back, or frames arrive laid out for the sheet.
  const liveMode = active?.mode ?? 'card'
  useEffect(() => {
    if (liveMode === 'card' && attachedRef.current && !sheetOpen) publishCardStage()
  }, [liveMode, sheetOpen, publishCardStage])

  // ── Input: the card is the page. Mouse, wheel and keys go straight in. ──
  useEffect(() => {
    const host = hostRef.current
    if (!host || !tabId || closed || sheetOpen) return
    const send = (event: BrowserInputEvent): void => {
      void window.api.browser.sendInput(tabId, event)
    }
    const at = (e: MouseEvent): { x: number; y: number } => {
      const r = host.getBoundingClientRect()
      return { x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) }
    }
    const mods = (e: MouseEvent | KeyboardEvent): string[] => {
      const m: string[] = []
      if (e.shiftKey) m.push('shift')
      if (e.ctrlKey) m.push('control')
      if (e.altKey) m.push('alt')
      if (e.metaKey) m.push('meta')
      return m
    }
    const button = (e: MouseEvent): 'left' | 'middle' | 'right' =>
      e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left'
    let moveRaf = 0
    let lastMove: MouseEvent | null = null
    const onMove = (e: MouseEvent): void => {
      lastMove = e
      if (moveRaf) return
      moveRaf = requestAnimationFrame(() => {
        moveRaf = 0
        if (lastMove) send({ type: 'mouseMove', ...at(lastMove), modifiers: mods(lastMove) })
      })
    }
    const onDown = (e: MouseEvent): void => {
      host.focus({ preventScroll: true })
      e.preventDefault()
      send({
        type: 'mouseDown',
        ...at(e),
        button: button(e),
        clickCount: Math.max(1, e.detail),
        modifiers: mods(e)
      })
    }
    const onUp = (e: MouseEvent): void => {
      send({
        type: 'mouseUp',
        ...at(e),
        button: button(e),
        clickCount: Math.max(1, e.detail),
        modifiers: mods(e)
      })
    }
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      // DOM deltaY > 0 scrolls down; Chromium's wheel delta is the inverse.
      send({
        type: 'mouseWheel',
        ...at(e),
        deltaX: -e.deltaX,
        deltaY: -e.deltaY,
        modifiers: mods(e)
      })
    }
    const onContextMenu = (e: MouseEvent): void => e.preventDefault()
    const onKeyDown = (e: KeyboardEvent): void => {
      const keyCode = electronKeyCode(e.key)
      if (!keyCode) return
      e.preventDefault()
      e.stopPropagation()
      send({ type: 'keyDown', keyCode, modifiers: mods(e) })
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        send({ type: 'char', keyCode: e.key, modifiers: mods(e) })
      }
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      const keyCode = electronKeyCode(e.key)
      if (!keyCode) return
      e.preventDefault()
      send({ type: 'keyUp', keyCode, modifiers: mods(e) })
    }
    host.addEventListener('mousemove', onMove)
    host.addEventListener('mousedown', onDown)
    host.addEventListener('mouseup', onUp)
    host.addEventListener('wheel', onWheel, { passive: false })
    host.addEventListener('contextmenu', onContextMenu)
    host.addEventListener('keydown', onKeyDown)
    host.addEventListener('keyup', onKeyUp)
    return () => {
      cancelAnimationFrame(moveRaf)
      host.removeEventListener('mousemove', onMove)
      host.removeEventListener('mousedown', onDown)
      host.removeEventListener('mouseup', onUp)
      host.removeEventListener('wheel', onWheel)
      host.removeEventListener('contextmenu', onContextMenu)
      host.removeEventListener('keydown', onKeyDown)
      host.removeEventListener('keyup', onKeyUp)
    }
  }, [tabId, closed, sheetOpen])

  const onHover = (hovering: boolean): void => {
    if (!attachedRef.current || !tabId) return
    void window.api.browser.setViewerFps(tabId, hovering ? HOVER_FPS : IDLE_FPS)
  }

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
          onMouseEnter={() => onHover(true)}
          onMouseLeave={() => onHover(false)}
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

/**
 * DOM `key` → Electron accelerator key code for sendInputEvent. Printable
 * keys pass through; named keys map to their accelerator names; anything
 * else (Dead, Unidentified, IME composition) is dropped.
 */
function electronKeyCode(key: string): string | null {
  if (key.length === 1) return key === ' ' ? 'Space' : key
  const named: Record<string, string> = {
    Enter: 'Return',
    Backspace: 'Backspace',
    Tab: 'Tab',
    Escape: 'Escape',
    Delete: 'Delete',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Insert: 'Insert',
    Shift: 'Shift',
    Control: 'Control',
    Alt: 'Alt',
    Meta: 'Meta'
  }
  if (named[key]) return named[key]
  if (/^F\d{1,2}$/.test(key)) return key
  return null
}
