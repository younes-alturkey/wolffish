import type { BrowserFps, BrowserFrame, BrowserInputEvent, BrowserTabMode } from '@preload/index'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

const IDLE_FPS: BrowserFps = 5
const HOVER_FPS: BrowserFps = 30

/**
 * Frames past this many device pixels on their long side are scaled down at
 * the source. A sheet on a large screen at 2× would otherwise ask for 3K
 * JPEGs, thirty a second, over a phone's socket.
 */
const MAX_FRAME_PX = 1920

/** What the keyboard field holds when empty, so a delete on it is still an edit. */
const SENTINEL = '​'
/** The field is emptied past this, keeping just enough for autocorrect's context. */
const FIELD_MAX = 200

/**
 * A tab drawn from main's screencast into a <canvas>, with the user's mouse,
 * wheel and keys sent back into the page. The chat card shows its tab this
 * way, and so does the Web UI's expanded sheet: a browser has no native view
 * to raise, so there the sheet is the card's canvas at full size.
 *
 * The page's viewport IS the host element — `height` pins it (the card),
 * otherwise the host's measured height is used (the sheet) — so frames fill
 * it edge to edge and the host's coordinates are the page's.
 *
 * Cost discipline: frames stream only while the host is near the viewport
 * and not `paused` (a two-way IntersectionObserver); scrolled away, the canvas
 * keeps its last frame and the tab keeps living in main, unstreamed.
 */
export function useScreencast({
  tabId,
  hostRef,
  canvasRef,
  paused,
  height,
  mode,
  touch = false,
  keyboard = false
}: {
  tabId: string | null
  hostRef: RefObject<HTMLDivElement | null>
  canvasRef: RefObject<HTMLCanvasElement | null>
  /** Holds the stream and input off while something else shows this tab. */
  paused: boolean
  height?: number
  /** The tab's live mode: a view parked again from elsewhere gets this size back. */
  mode?: BrowserTabMode
  /** Touch drags scroll the page. Off, they scroll whatever holds the host (the chat feed). */
  touch?: boolean
  /**
   * Typing goes through a hidden field (the returned keyboardRef) instead of
   * the host — the only thing that raises a phone's keyboard, and the way
   * IME, autocorrect and paste arrive as text rather than as keys.
   */
  keyboard?: boolean
}): {
  hasFrame: boolean
  setHover: (hovering: boolean) => void
  keyboardRef: RefObject<HTMLTextAreaElement | null>
} {
  const [framedTab, setFramedTab] = useState<string | null>(null)
  const attachedRef = useRef(false)
  const keyboardRef = useRef<HTMLTextAreaElement>(null)
  const hasFrame = framedTab !== null && framedTab === tabId

  // Frames for the tab: decode off the main thread, draw 1:1.
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
  }, [tabId, canvasRef])

  // The page's viewport: the host, in window CSS pixels.
  const pageSize = useCallback((): { width: number; height: number } => {
    const host = hostRef.current
    return {
      width: Math.max(1, Math.round(host?.clientWidth ?? 640)),
      height: Math.max(1, Math.round(height ?? host?.clientHeight ?? 400))
    }
  }, [hostRef, height])

  const viewerSize = useCallback((): { width: number; height: number } => {
    const page = pageSize()
    const scale = Math.min(
      window.devicePixelRatio || 1,
      MAX_FRAME_PX / Math.max(page.width, page.height)
    )
    return {
      width: Math.max(1, Math.round(page.width * scale)),
      height: Math.max(1, Math.round(page.height * scale))
    }
  }, [pageSize])

  const publishStage = useCallback((): void => {
    if (!hostRef.current || !tabId) return
    void window.api.browser.setStageRect(tabId, { x: 0, y: 0, ...pageSize() })
  }, [hostRef, tabId, pageSize])

  // Stream only while on screen — in the viewport, in a window or tab that is
  // itself showing — and never while paused. A hidden app holding its viewer
  // would keep main capturing frames nobody sees.
  useEffect(() => {
    const host = hostRef.current
    if (!host || !tabId) return
    const attach = (): void => {
      if (attachedRef.current) return
      attachedRef.current = true
      publishStage()
      void window.api.browser.attachViewer(tabId, viewerSize(), IDLE_FPS)
    }
    const detach = (): void => {
      if (!attachedRef.current) return
      attachedRef.current = false
      void window.api.browser.detachViewer(tabId)
    }
    let intersecting = false
    const sync = (): void => {
      if (intersecting && !paused && !document.hidden) attach()
      else detach()
    }
    const io = new IntersectionObserver(
      (entries) => {
        intersecting = entries.some((e) => e.isIntersecting)
        sync()
      },
      { rootMargin: '300px' }
    )
    io.observe(host)
    document.addEventListener('visibilitychange', sync)
    const ro = new ResizeObserver(() => {
      if (!attachedRef.current || paused) return
      publishStage()
      void window.api.browser.setViewerSize(tabId, viewerSize())
    })
    ro.observe(host)
    return () => {
      io.disconnect()
      ro.disconnect()
      document.removeEventListener('visibilitychange', sync)
      detach()
    }
  }, [hostRef, tabId, paused, viewerSize, publishStage])

  // Parked again from somewhere else (the native sheet closed, a crash): give
  // the page this host's size back, or frames arrive laid out for the sheet.
  useEffect(() => {
    if (mode === 'card' && attachedRef.current && !paused) publishStage()
  }, [mode, paused, publishStage])

  // ── Input: the host is the page. Mouse, wheel, touch and keys go straight in. ──
  useEffect(() => {
    const host = hostRef.current
    if (!host || !tabId || paused) return
    const field = keyboard ? keyboardRef.current : null
    const send = (event: BrowserInputEvent): void => {
      void window.api.browser.sendInput(tabId, event)
    }
    const at = (p: { clientX: number; clientY: number }): { x: number; y: number } => {
      const r = host.getBoundingClientRect()
      return { x: Math.round(p.clientX - r.left), y: Math.round(p.clientY - r.top) }
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
    // A tap arrives as mouse events too; it must not raise the phone's
    // keyboard on every touch — that is the keyboard button's job.
    let lastTouchAt = 0
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
      const fromTouch = Date.now() - lastTouchAt < 1000
      ;(field && !fromTouch ? field : host).focus({ preventScroll: true })
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
      // Text the keyboard field will deliver as an edit: composition, the
      // keycode-229 keys of Android keyboards, printable keys, paste.
      if (field && (e.isComposing || e.keyCode === 229)) return
      const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey
      if (field && printable) return
      if (field && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return
      const keyCode = electronKeyCode(e.key)
      if (!keyCode) return
      e.preventDefault()
      e.stopPropagation()
      send({ type: 'keyDown', keyCode, modifiers: mods(e) })
      if (printable) send({ type: 'char', keyCode: e.key, modifiers: mods(e) })
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (field && (e.isComposing || e.keyCode === 229)) return
      if (field && e.key.length === 1 && !e.ctrlKey && !e.metaKey) return
      const keyCode = electronKeyCode(e.key)
      if (!keyCode) return
      e.preventDefault()
      send({ type: 'keyUp', keyCode, modifiers: mods(e) })
    }
    // The keyboard field: whatever the user's keyboard did to its text is
    // replayed into the page as backspaces and characters.
    let typed = SENTINEL
    const resetField = (): void => {
      if (!field) return
      field.value = SENTINEL
      typed = SENTINEL
    }
    const onInput = (): void => {
      if (!field) return
      const before = Array.from(typed)
      const after = Array.from(field.value)
      let same = 0
      while (same < before.length && same < after.length && before[same] === after[same]) same++
      for (let i = before.length - same; i > 0; i--) {
        send({ type: 'keyDown', keyCode: 'Backspace' })
        send({ type: 'keyUp', keyCode: 'Backspace' })
      }
      for (const ch of after.slice(same)) {
        if (ch === SENTINEL) continue
        const keyCode = ch === '\n' ? 'Return' : ch === ' ' ? 'Space' : ch
        send({ type: 'keyDown', keyCode })
        send({ type: 'char', keyCode: ch === '\n' ? '\r' : ch })
        send({ type: 'keyUp', keyCode })
      }
      typed = field.value
      if (typed === '' || typed.length > FIELD_MAX) resetField()
    }
    // Touch drags scroll the page; a finger moving up scrolls it down, as on
    // a phone, which is Chromium's negative wheel delta.
    let touchAt: { x: number; y: number } | null = null
    const onTouchStart = (e: TouchEvent): void => {
      lastTouchAt = Date.now()
      const t = e.touches[0]
      touchAt = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null
    }
    const onTouchMove = (e: TouchEvent): void => {
      const t = e.touches[0]
      if (!touchAt || e.touches.length !== 1 || !t) return
      e.preventDefault()
      send({
        type: 'mouseWheel',
        ...at(t),
        deltaX: t.clientX - touchAt.x,
        deltaY: t.clientY - touchAt.y,
        modifiers: []
      })
      touchAt = { x: t.clientX, y: t.clientY }
    }
    const onTouchEnd = (): void => {
      lastTouchAt = Date.now()
      touchAt = null
    }
    const keys: HTMLElement = field ?? host
    resetField()
    host.addEventListener('mousemove', onMove)
    host.addEventListener('mousedown', onDown)
    host.addEventListener('mouseup', onUp)
    host.addEventListener('wheel', onWheel, { passive: false })
    host.addEventListener('contextmenu', onContextMenu)
    keys.addEventListener('keydown', onKeyDown)
    keys.addEventListener('keyup', onKeyUp)
    field?.addEventListener('input', onInput)
    if (touch) {
      host.addEventListener('touchstart', onTouchStart, { passive: true })
      host.addEventListener('touchmove', onTouchMove, { passive: false })
      host.addEventListener('touchend', onTouchEnd)
      host.addEventListener('touchcancel', onTouchEnd)
    }
    return () => {
      cancelAnimationFrame(moveRaf)
      host.removeEventListener('mousemove', onMove)
      host.removeEventListener('mousedown', onDown)
      host.removeEventListener('mouseup', onUp)
      host.removeEventListener('wheel', onWheel)
      host.removeEventListener('contextmenu', onContextMenu)
      keys.removeEventListener('keydown', onKeyDown)
      keys.removeEventListener('keyup', onKeyUp)
      field?.removeEventListener('input', onInput)
      host.removeEventListener('touchstart', onTouchStart)
      host.removeEventListener('touchmove', onTouchMove)
      host.removeEventListener('touchend', onTouchEnd)
      host.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [hostRef, keyboard, tabId, paused, touch])

  const setHover = useCallback(
    (hovering: boolean): void => {
      if (!attachedRef.current || !tabId) return
      void window.api.browser.setViewerFps(tabId, hovering ? HOVER_FPS : IDLE_FPS)
    },
    [tabId]
  )

  return { hasFrame, setHover, keyboardRef }
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
