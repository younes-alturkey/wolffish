import type { DeckPreview } from '@preload/index'
import { useCallback, useEffect, useRef, useState } from 'react'

export type DeckSlidesState = {
  status: 'loading' | 'ready' | 'failed'
  preview: DeckPreview | null
  index: number
  setIndex: (next: number) => void
  /** Object URL of the current slide, or null before its first paint. */
  url: string | null
}

/**
 * Render a deck once in main, then page through the SVG files it wrote.
 *
 * Each slide's bytes are fetched on demand and the object URL kept, so
 * flipping back is instant and a forty-slide photo deck never holds more than
 * the slides actually looked at. The previous slide stays on screen until the
 * next one has decoded — a card that blanks between clicks reads as broken.
 */
export function useDeckSlides(filePath: string): DeckSlidesState {
  const [status, setStatus] = useState<DeckSlidesState['status']>('loading')
  const [preview, setPreview] = useState<DeckPreview | null>(null)
  const [index, setIndexState] = useState(0)
  const [url, setUrl] = useState<string | null>(null)
  const [renderedPath, setRenderedPath] = useState(filePath)
  const urls = useRef(new Map<string, string>())

  // Pointed at a different deck: reset during render rather than in an effect,
  // so the card never paints one file's slides under another file's name.
  if (renderedPath !== filePath) {
    setRenderedPath(filePath)
    setStatus('loading')
    setPreview(null)
    setIndexState(0)
    setUrl(null)
  }

  // One cache per file: a re-delivered deck at the same path is a different
  // deck, and its old object URLs would show the previous version's slides.
  useEffect(() => {
    const cache = urls.current
    return () => {
      for (const objectUrl of cache.values()) URL.revokeObjectURL(objectUrl)
      cache.clear()
    }
  }, [filePath])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const rendered = await window.api.upload.renderDeck(filePath)
        if (cancelled) return
        if (!rendered || !rendered.slides.length) {
          setStatus('failed')
          return
        }
        setPreview(rendered)
        setStatus('ready')
      } catch {
        if (!cancelled) setStatus('failed')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [filePath])

  const slidePath = preview?.slides[index] ?? null

  useEffect(() => {
    if (!slidePath) return
    const cached = urls.current.get(slidePath)
    if (cached) {
      setUrl(cached)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const buffer = await window.api.upload.readFile(slidePath)
        if (cancelled || !buffer) return
        const objectUrl = URL.createObjectURL(new Blob([buffer], { type: 'image/svg+xml' }))
        urls.current.set(slidePath, objectUrl)
        setUrl(objectUrl)
      } catch {
        // The card keeps showing the slide it already has.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [slidePath])

  const setIndex = useCallback(
    (next: number) => {
      const count = preview?.slides.length ?? 0
      if (next < 0 || next >= count) return
      setIndexState(next)
    },
    [preview]
  )

  return { status, preview, index, setIndex, url }
}
