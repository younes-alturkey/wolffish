import { createElement, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'

/**
 * Storage partition shared by every HTML file preview guest. Persistent so a
 * page's localStorage (a game's high score) survives like it would in a
 * browser. Mirrored by main's HTML_PREVIEW_PARTITION, where the partition's
 * permission policy lives.
 */
const PARTITION = 'persist:htmlpreview'

/** The subset of the Electron <webview> API the preview drives imperatively. */
type PreviewWebview = HTMLElement & {
  reload: () => void
  openDevTools: () => void
  executeJavaScript: (code: string) => Promise<number>
  setZoomFactor: (factor: number) => void
}

export type HtmlPreviewHandle = {
  reload: () => void
  openDevTools: () => void
}

/**
 * Live, browser-grade preview of a local .html file: an Electron <webview>
 * guest loading the file from its real location. Its own process, its own
 * origin, nothing inherited from the app — so inline scripts, canvas,
 * keyboard, audio, localStorage, relative assets and CDN loads all behave as
 * they would in Chrome. (The srcDoc iframe this replaced inherited the app's
 * CSP, whose script-src 'self' silently blocked every inline <script>.)
 *
 * Lazy-mounted: the guest process only spins up once the card scrolls near
 * the viewport, so a transcript full of pages doesn't start them all at once.
 * `fit` shrinks a page wider than the card down to fit (inline card); the
 * expanded sheet leaves the page at 1×.
 *
 * Main hardens every guest (will-attach-webview strips preload/node; popups
 * and web links from a file: page go to the system browser) — see index.ts.
 */
export function HtmlPreview({
  src,
  fit = false,
  ref
}: {
  src: string
  fit?: boolean
  ref?: Ref<HtmlPreviewHandle>
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (visible) return
    const el = hostRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true)
          io.disconnect()
        }
      },
      { rootMargin: '200px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [visible])

  const webview = (): PreviewWebview | null =>
    (hostRef.current?.querySelector('webview') as PreviewWebview | null) ?? null

  useImperativeHandle(
    ref,
    () => ({
      reload: () => webview()?.reload(),
      openDevTools: () => webview()?.openDevTools()
    }),
    []
  )

  // Same shrink-only fit the website card uses: a page laid out wider than
  // the card (a fixed 800px canvas in a 600px card) is zoomed down so its full
  // width shows; pages that already fit stay at 1×. Re-fits on load,
  // in-page navigation, and card resize.
  useEffect(() => {
    if (!visible || !fit) return
    const wv = webview()
    if (!wv) return
    let disposed = false
    const refit = (): void => {
      if (disposed) return
      wv.executeJavaScript(
        'Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0)'
      )
        .then((contentWidth) => {
          if (disposed || !contentWidth) return
          const avail = wv.offsetWidth
          if (!avail) return
          wv.setZoomFactor(contentWidth > avail ? Math.max(0.3, (avail - 1) / contentWidth) : 1)
        })
        .catch(() => {})
    }
    wv.addEventListener('dom-ready', refit)
    wv.addEventListener('did-finish-load', refit)
    const ro = new ResizeObserver(refit)
    ro.observe(wv)
    return () => {
      disposed = true
      wv.removeEventListener('dom-ready', refit)
      wv.removeEventListener('did-finish-load', refit)
      ro.disconnect()
    }
  }, [visible, fit])

  return (
    <div ref={hostRef} className="h-full w-full bg-white">
      {visible
        ? createElement('webview', {
            src,
            partition: PARTITION,
            // Popups (target=_blank, window.open) must reach the guest's
            // window-open handler in main, which routes them to the system
            // browser; without this the guest drops them silently.
            allowpopups: 'true',
            webpreferences: 'contextIsolation=yes,nodeIntegration=no,sandbox=yes',
            style: { width: '100%', height: '100%', border: '0', display: 'inline-flex' }
          })
        : null}
    </div>
  )
}
