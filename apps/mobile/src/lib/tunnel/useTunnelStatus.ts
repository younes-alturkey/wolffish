import { tunnelClient } from '@/lib/tunnel/client'
import { useAppStore } from '@/state/appStore'
import type { TunnelState, TunnelStatus } from '@/lib/tunnel/tunnel'
import type { TFunction } from 'i18next'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/** The four colours a link can be — the tones `StatusDot` renders. */
export type TunnelTone = 'ok' | 'busy' | 'error' | 'idle'

/**
 * The whole tunnel state, for a screen that renders its details.
 *
 * Republished on every frame the tunnel sends or receives, so anything that
 * only needs the phase should take `useTunnelStatus` instead rather than
 * re-render itself against a byte counter.
 */
export function useTunnelState(): TunnelState | null {
  const [state, setState] = useState<TunnelState | null>(tunnelClient.state)
  useEffect(() => tunnelClient.subscribe(setState), [])
  return state
}

/**
 * One status → word + colour mapping, shared by the hook below and the demo's
 * made-up link (lib/demo/relay renders 'connected' through it) — one table,
 * so the settings row, the Relay screen and the fiction cannot disagree.
 *
 * Anything mid-flight is amber, not grey: a handshake in progress is the link
 * working, and grey would read as dead.
 */
export function describeTunnelStatus(
  status: TunnelStatus,
  t: TFunction
): { status: TunnelStatus; label: string; tone: TunnelTone } {
  switch (status) {
    case 'connected':
      return { status, label: t('relay.status.connected'), tone: 'ok' }
    case 'connecting':
    case 'handshaking':
      return { status, label: t('relay.status.connecting'), tone: 'busy' }
    case 'waiting-for-peer':
      return { status, label: t('relay.status.waiting'), tone: 'busy' }
    case 'reconnecting':
      return { status, label: t('relay.status.reconnecting'), tone: 'busy' }
    case 'error':
      return { status, label: t('relay.status.error'), tone: 'error' }
    default:
      return { status, label: t('relay.status.idle'), tone: 'idle' }
  }
}

/**
 * The link as a word and a colour — what a status chip needs and nothing more.
 *
 * Keeps the phase rather than the state object, so the traffic counters that
 * tick constantly on a busy tunnel do not re-render whoever is showing it.
 */
export function useTunnelStatus(): { status: TunnelStatus; label: string; tone: TunnelTone } {
  const { t } = useTranslation()
  const [status, setStatus] = useState<TunnelStatus>(tunnelClient.state?.status ?? 'idle')
  useEffect(() => tunnelClient.subscribe((state) => setStatus(state.status)), [])
  return describeTunnelStatus(status, t)
}

/**
 * Is there a desktop on the other end RIGHT NOW — paired, and connected.
 *
 * The predicate behind every control that cannot work without one: the
 * workspace stores the phone edits through the desktop, and the diagnostic
 * bundle, which is collected there. Demo mode is false by construction (there
 * is no desktop to pair with), and so is a paired phone in a lift.
 *
 * Written once here rather than per screen because it is not a preference, it
 * is a fact about the link, and two copies of it would eventually disagree
 * about what "connected" means.
 */
export function useDesktopReachable(): boolean {
  const paired = useAppStore((state) => state.paired)
  const [connected, setConnected] = useState(tunnelClient.connected)
  useEffect(() => tunnelClient.subscribe((state) => setConnected(state.status === 'connected')), [])
  return paired && connected
}
