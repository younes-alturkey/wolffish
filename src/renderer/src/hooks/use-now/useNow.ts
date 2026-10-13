import { useEffect, useState } from 'react'

/**
 * A clock that moves — one instant per tick for a whole list, so two cards
 * from the same minute never disagree about how long ago it was, and a page
 * left open does not keep saying "now" about something from an hour ago.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
