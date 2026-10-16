import { useEffect, useState } from 'react'

const QUERY = '(hover: hover)'

/**
 * Whether the primary pointer can hover — false on phones and tablets, where
 * a tap fires a synthetic mouseenter that never leaves. Hover cards that open
 * on enter and close on leave must switch to a tap toggle there; the same
 * media query Tailwind v4 gates `hover:` on, so styling and behaviour agree.
 */
export function useHoverCapable(): boolean {
  const [capable, setCapable] = useState<boolean>(
    () => typeof window.matchMedia !== 'function' || window.matchMedia(QUERY).matches
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(QUERY)
    const onChange = (e: MediaQueryListEvent): void => setCapable(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return capable
}
