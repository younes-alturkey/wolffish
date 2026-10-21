import { cn } from '@lib/utils/cn'
import { framesPdf } from '@lib/utils/platform'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export type PdfPagesProps = {
  url: string
  title: string
  className?: string
}

/**
 * Every page of a PDF, scrollable. The browser's own viewer in a frame where
 * it shows the whole document; pdf.js onto canvases where it doesn't (see
 * `framesPdf`). The legacy build because it carries the polyfills an older
 * iOS Safari needs, and it loads only on those devices.
 */
export function PdfPages({ url, title, className }: PdfPagesProps): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  if (framesPdf || failed) {
    return <iframe src={url} title={title} className={cn('border-0', className)} />
  }
  return <CanvasPages url={url} className={className} onFail={setFailed} />
}

/**
 * iOS gives a page a fixed budget of canvas memory and blanks canvases past
 * it, so each page is drawn only while it is near the view and capped at this
 * many device pixels — about a 4× letter page, sharp at full zoom on most phones.
 */
const MAX_CANVAS_PIXELS = 8_000_000

/** Pinch-out stops at fit-width; pinch-in at this many times it. */
const MAX_ZOOM = 4

/** The column's padding and page gap at zoom 1 — scaled with it, so layout is linear in zoom. */
const SPACING = 8

type Pinch = {
  startDistance: number
  startZoom: number
  /** Content coordinates under the fingers' midpoint at the start, at startZoom. */
  focusX: number
  focusY: number
  startMidX: number
  startMidY: number
  midX: number
  midY: number
  zoom: number
}

function CanvasPages({
  url,
  className,
  onFail
}: {
  url: string
  className?: string
  onFail: (failed: true) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [aspect, setAspect] = useState(1.294)
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  const [zoom, setZoom] = useState(1)
  const column = useRef<HTMLDivElement>(null)
  const zoomRef = useRef(zoom)
  /** Where to scroll once a committed zoom has laid out. */
  const pendingScroll = useRef<{ left: number; top: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    let loaded: PDFDocumentProxy | null = null
    let destroy: (() => void) | null = null
    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
        const task = pdfjs.getDocument({ url })
        destroy = () => void task.destroy()
        if (cancelled) return destroy()
        loaded = await task.promise
        const first = (await loaded.getPage(1)).getViewport({ scale: 1 })
        if (cancelled) return
        setAspect(first.height / first.width)
        setDoc(loaded)
      } catch {
        if (!cancelled) onFail(true)
      }
    })()
    return () => {
      cancelled = true
      destroy?.()
    }
  }, [url, onFail])

  useEffect(() => {
    const el = column.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    zoomRef.current = zoom
    const target = pendingScroll.current
    if (!root || !target) return
    pendingScroll.current = null
    root.scrollTo(target)
  }, [zoom, root])

  // The page's own pinch-zoom is refused here (touch-action, and preventDefault
  // on two-finger moves — iOS honours only the latter), and the gesture scales
  // the column instead: a transform while the fingers are down, so it tracks
  // them at frame rate, then one committed zoom that re-lays out and redraws
  // the pages sharp, scrolled so the point between the fingers stays put.
  useEffect(() => {
    const el = column.current
    if (!root || !el) return
    let pinch: Pinch | null = null

    const midpoint = (touches: TouchList): { x: number; y: number; distance: number } => {
      const [a, b] = [touches[0], touches[1]]
      const rect = root.getBoundingClientRect()
      return {
        x: (a.clientX + b.clientX) / 2 - rect.left,
        y: (a.clientY + b.clientY) / 2 - rect.top,
        distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      }
    }

    const start = (event: TouchEvent): void => {
      if (event.touches.length !== 2) return
      const mid = midpoint(event.touches)
      pinch = {
        startDistance: mid.distance || 1,
        startZoom: zoomRef.current,
        focusX: root.scrollLeft + mid.x,
        focusY: root.scrollTop + mid.y,
        startMidX: mid.x,
        startMidY: mid.y,
        midX: mid.x,
        midY: mid.y,
        zoom: zoomRef.current
      }
      el.style.transformOrigin = `${pinch.focusX}px ${pinch.focusY}px`
    }

    const move = (event: TouchEvent): void => {
      if (!pinch || event.touches.length !== 2) return
      event.preventDefault()
      const mid = midpoint(event.touches)
      pinch.midX = mid.x
      pinch.midY = mid.y
      pinch.zoom = Math.min(
        MAX_ZOOM,
        Math.max(1, pinch.startZoom * (mid.distance / pinch.startDistance))
      )
      const scale = pinch.zoom / pinch.startZoom
      el.style.transform = `translate(${mid.x - pinch.startMidX}px, ${mid.y - pinch.startMidY}px) scale(${scale})`
    }

    const end = (event: TouchEvent): void => {
      if (!pinch || event.touches.length >= 2) return
      const ratio = pinch.zoom / pinch.startZoom
      pendingScroll.current = {
        left: pinch.focusX * ratio - pinch.midX,
        top: pinch.focusY * ratio - pinch.midY
      }
      el.style.transform = ''
      const next = pinch.zoom
      pinch = null
      setZoom(next)
    }

    // Safari's own pinch events; cancelling them is what keeps the app from zooming.
    const refuse = (event: Event): void => event.preventDefault()

    root.addEventListener('touchstart', start, { passive: true })
    root.addEventListener('touchmove', move, { passive: false })
    root.addEventListener('touchend', end)
    root.addEventListener('touchcancel', end)
    root.addEventListener('gesturestart', refuse)
    root.addEventListener('gesturechange', refuse)
    return () => {
      root.removeEventListener('touchstart', start)
      root.removeEventListener('touchmove', move)
      root.removeEventListener('touchend', end)
      root.removeEventListener('touchcancel', end)
      root.removeEventListener('gesturestart', refuse)
      root.removeEventListener('gesturechange', refuse)
    }
  }, [root])

  return (
    <div
      ref={setRoot}
      className={cn('bg-muted/15 overflow-auto overscroll-contain', className)}
      style={{ touchAction: 'pan-x pan-y' }}
    >
      <div
        ref={column}
        className="flex flex-col"
        style={{ width: `${zoom * 100}%`, gap: SPACING * zoom, padding: SPACING * zoom }}
      >
        {doc && root ? (
          Array.from({ length: doc.numPages }, (_, i) => (
            <CanvasPage
              key={i}
              doc={doc}
              number={i + 1}
              width={width}
              aspect={aspect}
              root={root}
            />
          ))
        ) : (
          <div className="flex h-full min-h-40 items-center justify-center">
            <span className="text-muted animate-pulse text-xs">{t('chat.pdfViewer.loading')}</span>
          </div>
        )}
      </div>
    </div>
  )
}

function CanvasPage({
  doc,
  number,
  width,
  aspect,
  root
}: {
  doc: PDFDocumentProxy
  number: number
  width: number
  aspect: number
  root: HTMLElement
}): React.JSX.Element {
  const holder = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [near, setNear] = useState(false)
  const [ownAspect, setOwnAspect] = useState<number | null>(null)

  useEffect(() => {
    const el = holder.current
    if (!el) return
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {
      root,
      rootMargin: '100% 0px'
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [root])

  useEffect(() => {
    const el = canvas.current
    if (!near || !el) return
    return () => {
      el.width = 0
      el.height = 0
    }
  }, [near])

  // Drawn off-screen and copied in, so a zoom shows the old bitmap stretched
  // until the sharp one lands rather than a blank page.
  useEffect(() => {
    const el = canvas.current
    if (!near || !el || width === 0) return
    let cancelled = false
    let task: RenderTask | null = null
    const scratch = document.createElement('canvas')
    void (async () => {
      try {
        const page = await doc.getPage(number)
        if (cancelled) return
        const base = page.getViewport({ scale: 1 })
        setOwnAspect(base.height / base.width)
        let scale = (width / base.width) * Math.min(window.devicePixelRatio || 1, 3)
        const pixels = base.width * base.height * scale * scale
        if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels)
        const viewport = page.getViewport({ scale })
        scratch.width = Math.floor(viewport.width)
        scratch.height = Math.floor(viewport.height)
        task = page.render({ canvas: scratch, viewport })
        await task.promise
        if (cancelled) return
        el.width = scratch.width
        el.height = scratch.height
        el.getContext('2d')?.drawImage(scratch, 0, 0)
      } catch {
        // Cancelled by scrolling away, or one page pdf.js can't draw — it stays blank.
      } finally {
        scratch.width = 0
        scratch.height = 0
      }
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [near, doc, number, width])

  return (
    <div
      ref={holder}
      className="w-full bg-white shadow-sm"
      style={{ aspectRatio: `1 / ${ownAspect ?? aspect}` }}
    >
      <canvas ref={canvas} className="block h-full w-full" />
    </div>
  )
}
