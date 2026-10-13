import { DEFAULT_RELAY_URL, KEEPALIVE_MS } from '@/lib/tunnel/protocol'
import type { TunnelState } from '@/lib/tunnel/tunnel'
import { useEffect, useState } from 'react'

/**
 * The demo's relay link — the connection the tour's Relay screen describes.
 *
 * Demo mode has no tunnel, but a settings list with no Relay row made the
 * tour a different shape from the paired app it is standing in for. So the
 * demo carries a link of its own: made up, and internally consistent — up
 * since before you looked, fingerprints that never change, counters that
 * tick at the real keepalive cadence, a catch-up clock stamped by the same
 * snapshot read a demo entry runs. The values are fiction; the shape is the
 * real `TunnelState`, so the screen renders both without knowing which it
 * holds.
 *
 * In-memory only, like the chat runtime: `resetDemoRelay` drops it with the
 * dataset it described (purgeDemoState), and the next demo entry starts a
 * fresh link.
 */

/** How long the made-up link has already been up when first looked at —
 *  a lived-in "Connected for 3h", never a suspicious "just now". */
const BASE_UPTIME_MS = 13_680_000

/** Traffic already on the counters at first look: roughly that uptime's
 *  keepalives plus a morning of pushes, receive-heavy the way a phone that
 *  mostly listens really is. */
const BASE_FRAMES_SENT = 1_369
const BASE_FRAMES_RECEIVED = 2_642
const BASE_BYTES_SENT = 1_204_566
const BASE_BYTES_RECEIVED = 58_720_412

/** The short forms the screen prints — same `xxxx…xxxx` shape fingerprint()
 *  gives real key material. Constants, so the "encryption" story holds still
 *  across visits. */
const DEMO_RENDEZVOUS = '9d4f…07a2'
const DEMO_OWN_KEY = '6b1e…c8d3'
const DEMO_PEER_KEY = 'f27c…5a91'
const DEMO_SESSION = '3e8b…d6f0'

type DemoLink = {
  /** When the fiction was first read — anchors the keepalive arithmetic. */
  startedAt: number
  connectedAt: number
  lastSyncAt: number | null
  reconnects: number
  /** Snapshot reads so far — each one moves the traffic counters a little. */
  catchUps: number
}

let link: DemoLink | null = null

const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function ensureLink(): DemoLink {
  if (!link) {
    const now = Date.now()
    link = {
      startedAt: now,
      connectedAt: now - BASE_UPTIME_MS,
      lastSyncAt: null,
      reconnects: 0,
      catchUps: 0
    }
  }
  return link
}

/**
 * The link right now. Computed on every read rather than stored: the
 * keepalive share of the counters is elapsed time, so each read is a link
 * whose traffic has moved — `useDemoRelayState` decides when to read.
 */
export function demoRelaySnapshot(): TunnelState {
  const current = ensureLink()
  // Keepalives ask and answer, so both directions move together.
  const heartbeats = Math.floor((Date.now() - current.startedAt) / KEEPALIVE_MS)
  return {
    status: 'connected',
    peerPresent: true,
    relayUrl: DEFAULT_RELAY_URL,
    rendezvous: DEMO_RENDEZVOUS,
    ownKey: DEMO_OWN_KEY,
    peerKey: DEMO_PEER_KEY,
    session: DEMO_SESSION,
    connectedAt: current.connectedAt,
    lastError: null,
    reconnects: current.reconnects,
    framesSent: BASE_FRAMES_SENT + heartbeats + current.catchUps * 3,
    framesReceived: BASE_FRAMES_RECEIVED + heartbeats + current.catchUps * 5,
    bytesSent: BASE_BYTES_SENT + heartbeats * 44,
    bytesReceived: BASE_BYTES_RECEIVED + heartbeats * 44
  }
}

/** Hear about the mutations below — reads stay pull-based via the snapshot. */
export function subscribeDemoRelay(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * A catch-up ran — applyConfigSnapshot stamps this on every demo entry and
 * every Sync press, so the Relay screen's "last catch-up" line tells the
 * truth about the one kind of sync the demo actually performs.
 */
export function markDemoRelaySync(): void {
  const current = ensureLink()
  current.lastSyncAt = Date.now()
  current.catchUps += 1
  emit()
}

/** When the demo last caught up, for the screen's polled sync line. */
export function getDemoLastSyncAt(): number | null {
  return link?.lastSyncAt ?? null
}

/**
 * The screen's Reconnect, in fiction: the link drops and rebuilds instantly,
 * so the same rows a real rebuild moves — "Connected for" and the reconnect
 * counter — are the ones that answer the tap.
 */
export function reconnectDemoRelay(): void {
  const current = ensureLink()
  current.connectedAt = Date.now()
  current.reconnects += 1
  emit()
}

/** Forget the fiction — purgeDemoState's in-memory step, and the tests'. */
export function resetDemoRelay(): void {
  link = null
  emit()
}

/** How often a mounted screen re-reads the link for its keepalive share —
 *  the Relay screen's own label clock, matched. */
const DEMO_RELAY_POLL_MS = 5_000

/**
 * The made-up link for a screen: re-read on every mutation above and on a
 * 5s clock for the keepalive share of the counters.
 *
 * The snapshot lives in STATE, deliberately. Returning `demoRelaySnapshot()`
 * straight from the render looked equivalent — but this app compiles under
 * React Compiler (app.config.ts `reactCompiler`), which memoizes a hook's
 * return against its reactive inputs, and a Date.now() inside a module call
 * is invisible to that analysis: the screen kept rendering the first
 * snapshot forever, counters frozen. A setState with a fresh object is a
 * reactive input the compiler honours.
 */
export function useDemoRelayState(): TunnelState {
  const [state, setState] = useState(demoRelaySnapshot)
  useEffect(() => {
    const refresh = (): void => setState(demoRelaySnapshot())
    const unsubscribe = subscribeDemoRelay(refresh)
    const timer = setInterval(refresh, DEMO_RELAY_POLL_MS)
    return () => {
      unsubscribe()
      clearInterval(timer)
    }
  }, [])
  return state
}
