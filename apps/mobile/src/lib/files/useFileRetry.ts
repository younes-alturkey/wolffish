import { useCallback, useEffect, useRef, useState } from 'react'
import { tunnelClient } from '@/lib/tunnel/client'

/**
 * Retry pacing for a TRANSIENT file resolution failure — the half of the
 * "file was deleted" fix that lives in the hooks.
 *
 * A workspace file resolve can fail without the file being gone: the tunnel
 * is mid-reconnect, or a fileRead timed out behind a busy sync pass (a
 * chunked body pull and a few prefetches share one socket). The resolving
 * hooks used to pin that failure as `missing` for the life of the mount, so
 * one bad moment rendered "file was deleted or unavailable" until the
 * conversation — or the app — was reopened. With this, a transient failure
 * keeps the loading card and quietly tries again.
 *
 * The shape: `nonce` is an effect dependency — bumping it is what re-runs the
 * caller's resolve. After a transient failure the caller calls
 * `scheduleRetry()`: a few backoff attempts first (most stalls are a busy
 * link that clears in seconds), then one armed listener on the tunnel's
 * connect edge (a failure that outlives the backoff usually IS the
 * connection, and the reconnect is the moment it stops being true — the edge
 * also resets the backoff for a fresh round). `settle()` disarms everything;
 * the caller invokes it when a resolve lands a real answer. Everything
 * disarms on unmount and on a key change.
 */
const RETRY_DELAYS_MS = [2_000, 6_000, 15_000]

export function useFileRetry(key: string | null): {
  nonce: number
  scheduleRetry: () => void
  settle: () => void
} {
  const [nonce, setNonce] = useState(0)
  const attemptsRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)

  const settle = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    unsubscribeRef.current?.()
    unsubscribeRef.current = null
  }, [])

  // A new key is a new file: whatever the old one was waiting on is over.
  useEffect(() => {
    attemptsRef.current = 0
    return settle
  }, [key, settle])

  const scheduleRetry = useCallback(() => {
    // One armed retry at a time — a re-render must not stack timers.
    if (timerRef.current || unsubscribeRef.current) return
    const attempt = attemptsRef.current
    if (attempt < RETRY_DELAYS_MS.length) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        attemptsRef.current += 1
        setNonce((n) => n + 1)
      }, RETRY_DELAYS_MS[attempt])
      return
    }
    // Backoff spent. subscribe() replays the current state synchronously —
    // possibly before it has returned anything to unsubscribe with (the same
    // trap whenConnected in conversations/hooks.ts documents) — so seed `was`
    // from the live flag and keep a local handle for the replay window.
    let was = tunnelClient.connected
    let fired = false
    const off = tunnelClient.subscribe((state) => {
      const is = state.status === 'connected'
      if (is && !was) {
        fired = true
        attemptsRef.current = 0
        unsubscribeRef.current?.()
        unsubscribeRef.current = null
        setNonce((n) => n + 1)
      }
      was = is
    })
    if (fired) off()
    else unsubscribeRef.current = off
  }, [])

  return { nonce, scheduleRetry, settle }
}
