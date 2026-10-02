import { useEffect, useRef, useState, type RefObject } from 'react'

export type DocxPagesState = {
  status: 'loading' | 'ready' | 'failed'
  /** 0-based index of the page currently at the top of the viewport. */
  page: number
  pageCount: number
  /** Where the document's pages are painted. */
  hostRef: RefObject<HTMLDivElement | null>
  /** The scrolling ancestor the page tracker measures against. */
  scrollRef: RefObject<HTMLDivElement | null>
}

export type UseDocxPagesOptions = {
  /**
   * Largest zoom the page may take. The card fits and never magnifies (1) —
   * it is a preview, and blowing a page up there just shows less of it. The
   * expanded sheet is for reading, so it fills the width and is only capped
   * to keep a very wide monitor from rendering the page at 3x.
   */
  maxZoom?: number
}

/**
 * Paint a .docx into a container with docx-preview and keep track of which
 * page is in view.
 *
 * docx-preview lays the document out as one <section> per page, with the real
 * page size, margins, styles, tables and images from the file — so the card
 * shows something that looks like the document, not the flattened HTML the
 * old mammoth render produced. The library is loaded on first use: a chat
 * with no documents in it never pays for the code.
 *
 * Most documents come back as a single page: docx-preview splits only at
 * explicit page and section breaks, never by reflowing text, so the position
 * chip appears exactly when a document really has separate pages. There are no
 * paging controls — the document scrolls, so scrolling IS the navigation.
 */
export function useDocxPages(filePath: string, options: UseDocxPagesOptions = {}): DocxPagesState {
  const maxZoom = options.maxZoom ?? 1
  const hostRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pagesRef = useRef<HTMLElement[]>([])
  const [status, setStatus] = useState<DocxPagesState['status']>('loading')
  const [page, setPage] = useState(0)
  const [pageCount, setPageCount] = useState(0)
  const [renderedPath, setRenderedPath] = useState(filePath)

  // Pointed at a different document: reset during render rather than in an
  // effect, so the pager never counts the previous file's pages.
  if (renderedPath !== filePath) {
    setRenderedPath(filePath)
    setStatus('loading')
    setPage(0)
    setPageCount(0)
  }

  useEffect(() => {
    let cancelled = false
    const host = hostRef.current
    if (!host) return

    void (async () => {
      try {
        const [{ renderAsync }, buffer] = await Promise.all([
          import('docx-preview'),
          window.api.upload.readFile(filePath)
        ])
        if (cancelled) return
        if (!buffer) throw new Error(`missing upload: ${filePath}`)
        host.replaceChildren()
        await renderAsync(new Blob([buffer]), host, host, {
          // No outer wrapper: the card is the wrapper, and the library's own
          // one paints a grey desk we would have to undo in both themes.
          inWrapper: false,
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          // Images become blob: URLs rather than base64 — the same reason the
          // deck renderer writes files instead of inlining megabytes.
          useBase64URL: false
        })
        if (cancelled) return
        pagesRef.current = Array.from(host.querySelectorAll<HTMLElement>('section'))
        setPageCount(pagesRef.current.length)
        setStatus('ready')
      } catch {
        if (!cancelled) setStatus('failed')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [filePath])

  // A Word page is 794px (A4) or 816px (Letter) at 96 DPI, which almost never
  // matches the surface. Scale the document to the FULL viewer width with
  // `zoom`, which re-lays the text out at the new size instead of blurring it
  // the way a transform would.
  useEffect(() => {
    if (status !== 'ready') return
    const host = hostRef.current
    const scroller = scrollRef.current
    if (!host || !scroller || !pagesRef.current.length) return

    const fit = (): void => {
      host.style.zoom = '1'
      // The host's own content box, NOT the scroller's: the scroller's
      // clientWidth still carries its padding, and a page fitted to that is
      // exactly one padding too wide — which is what put a stray horizontal
      // scrollbar under the card.
      const available = host.clientWidth
      // Widest page, not the first: a document can turn a section sideways.
      const pageWidth = pagesRef.current.reduce((max, page) => Math.max(max, page.offsetWidth), 0)
      if (!pageWidth || !available) return
      // Fit the PAGE, never the content. Something wider than its own page (a
      // big table) keeps overflowing and the scroller lets you reach it —
      // squeezing the whole document to swallow it would misrepresent it.
      //
      // Scale the page rather than forcing its width: a section carries the
      // real page geometry, and stretching it would reflow text the file
      // paginated for a different measure, so the page breaks on screen would
      // stop matching the ones in Word.
      host.style.zoom = String(Math.min(maxZoom, available / pageWidth))
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [status, maxZoom])

  // Which page is in view. Measured from bounding rects rather than offsetTop
  // so the `zoom` above never skews the arithmetic.
  useEffect(() => {
    if (status !== 'ready') return
    const scroller = scrollRef.current
    if (!scroller) return
    const onScroll = (): void => {
      const top = scroller.getBoundingClientRect().top
      let current = 0
      for (let i = 0; i < pagesRef.current.length; i++) {
        // A page counts as the one being read once its top has passed the
        // viewport top, with a little slack so it doesn't flip early.
        if (pagesRef.current[i].getBoundingClientRect().top - top <= 24) current = i
        else break
      }
      setPage(current)
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [status])

  return { status, page, pageCount, hostRef, scrollRef }
}
