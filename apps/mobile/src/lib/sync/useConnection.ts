import { reconcilePresentedNotifications, refreshPushRegistration } from '@/lib/notifications/push'
import { clearOverlays, seedOverlays } from '@/lib/sync/overlays'
import { clearDesktopUpdater, seedDesktopUpdater } from '@/lib/sync/updater'
import { attachLiveUpdates, reconcile } from '@/lib/sync/sync'
import { attachTurnStream, seedActiveRuns } from '@/lib/sync/prompt'
import { tunnelClient } from '@/lib/tunnel/client'
import { useAppStore } from '@/state/appStore'
// Type-only, and it has to stay that way — see watchNetwork for why a value
// import of this module is a launch crash rather than a caught failure.
import type { NetworkStateType } from 'expo-network'
import { useEffect } from 'react'
import { AppState, type AppStateStatus } from 'react-native'

/**
 * Keeps the tunnel alive across the app's lifecycle.
 *
 * iOS suspends a backgrounded app within seconds, so the socket dies whenever
 * the user leaves and must be rebuilt when they return. That is the normal
 * cycle, not an error: reconnecting is a fresh handshake in well under a
 * second, and the desktop parks on the relay waiting for exactly this.
 *
 * Three separate jobs, deliberately not fused:
 *
 * Getting connected is the tunnel's own affair. It retries with backoff, times
 * out a dial that hangs, and tears down a socket that has gone quiet — so it
 * keeps working the whole time the app is open, not only at launch. All this
 * hook adds is a nudge when the user comes back, because returning to the app
 * is evidence the network probably returned too — and, more to the point, the
 * moment when what the tunnel believes about itself is least likely to be
 * true. See Tunnel.refresh, which resume() runs on the way through.
 *
 * The dial itself does not wait for any of this: `dialStoredPairing` goes out
 * as the bundle evaluates, so the socket, the relay's TLS and the handshake
 * overlap the work of starting the app rather than queueing behind it.
 *
 * Noticing the network moved is the third, and it exists because the other two
 * only fire when the USER does something. A phone that walks out of wifi range
 * onto cellular never backgrounds and never taps anything: the socket dies
 * bound to an interface that no longer exists, and nothing at all announces it.
 * Left to the transport's own watchdog that costs up to half a minute of an app
 * that looks connected and answers nothing — the longest remaining gap, and the
 * one nobody can do anything about from inside the tunnel.
 *
 * Catching up hangs off the *connection*, not off the app opening. Those are
 * not the same moment and conflating them was the bug: foregrounding often
 * finds the network still down, and a catch-up wired to that event alone
 * leaves the phone stale until the next time the user happens to open it.
 * Wired here, every connection that forms — first, tenth, after an hour in a
 * lift — brings the phone level, with nobody watching.
 */
/**
 * Start connecting NOW — before React renders, before the persisted store has
 * rehydrated, before anything on screen exists to care.
 *
 * Everything the dial needs is in the keystore, which is why it can run this
 * early: the `paired` flag the hook below waits for is a mirror of a pairing
 * this reads directly. Waiting for it cost the whole of startup — bundle
 * evaluation, two providers restoring from AsyncStorage, the first render —
 * before the first packet went out, and that time is dead air on a screen the
 * user is already looking at.
 *
 * Idempotent and self-cancelling: no stored pairing does nothing at all, and
 * the hook's own resume() joins this attempt instead of starting a second.
 */
export function dialStoredPairing(): void {
  void tunnelClient.resume().catch(() => undefined)
}

export function useConnection(): void {
  const paired = useAppStore((state) => state.paired)

  useEffect(() => {
    if (!paired) return

    // resume() replaces a tunnel that has stopped trying, joins one that is
    // still dialing, and checks one that claims to be connected; either way it
    // is safe to call as often as we like. `patient` reaches the wake probe —
    // see Tunnel.refresh.
    const kick = (patient = false): void => {
      void tunnelClient.resume(patient).catch(() => undefined)
    }

    kick()

    // Which state the app comes back FROM decides what the return means, so
    // it is tracked here: RN only hands the listener where it arrived.
    let lastState: AppStateStatus = AppState.currentState
    const onChange = (next: AppStateStatus): void => {
      const was = lastState
      lastState = next
      if (next !== 'active') return
      // Backgrounding is left alone deliberately: iOS tears the socket down
      // itself, and calling stop() here would cancel the reconnect loop that
      // makes returning instant.
      //
      // Only a return from a REAL background gets the probe-and-catch-up
      // treatment. 'background' is the away state: iOS suspends JS within
      // seconds there, the socket is presumed dead, and pushes sent meanwhile
      // are gone. 'inactive' is not away at all — the control centre, the
      // notification shade, a permission sheet, an incoming-call banner — JS
      // keeps running and the socket keeps its keepalive cadence the whole
      // time, so there is nothing to verify and nothing to catch up on.
      // Kicking on those dips put a short-fuse probe and a visible resync in
      // the middle of active use for the crime of glancing at a notification
      // — the probe could even kill the healthy socket it was checking. A
      // tunnel that is NOT connected is still kicked from any return: that
      // costs nothing when a dial is already running and skips a queued
      // backoff when one is not.
      if (was === 'background' || !tunnelClient.connected) {
        kick()
        // A brief background can leave the socket intact: iOS suspends JS
        // before the OS gets around to killing the connection, and anything
        // the desktop pushed meanwhile is simply gone. The edge-triggered
        // catch-up below only fires when a connection re-FORMS, so a
        // still-connected return needs its own reconcile or those minutes
        // stay missing until the next reconnect.
        if (tunnelClient.connected) void reconcile().catch(() => undefined)
      }
      // Every foreground re-upserts the push registration — the contract that
      // keeps the relay's token fresh. A reconnecting return is covered by
      // the client's own connect-time registration; a still-open socket is
      // exactly the case only this call reaches.
      void refreshPushRegistration()
      // Count what the OS displayed while the app was away, then push the
      // absolute total to the icon and the relay — which is also the moment
      // general (non-conversation) notifications stop counting against the
      // icon: opening the app is what clears those.
      void reconcilePresentedNotifications()
    }
    const subscription = AppState.addEventListener('change', onChange)
    // Patient: a type flap fires mid-use with the user none the wiser, and a
    // spurious one must cost a probe, never the healthy socket it probed.
    const network = watchNetwork(() => kick(true))

    // Edge-triggered: only the transition into connected, so a burst of
    // status updates cannot start several catch-ups.
    let wasConnected = false
    const off = tunnelClient.subscribe((state) => {
      const isConnected = state.status === 'connected'
      if (isConnected && !wasConnected) {
        // Handlers are stored per topic, so re-attaching replaces rather than
        // stacking — safe on a reconnect that reuses the same tunnel.
        attachLiveUpdates()
        attachTurnStream()
        // After attachTurnStream, never before: that call force-settles the
        // turns this phone may have missed the end of while it was away, and
        // this one re-opens the ones the desktop says are still going. The
        // other order would clear what this just seeded.
        void seedActiveRuns()
        void reconcile().catch(() => undefined)
        // What the desktop is busy with only ever arrives as a push, so a
        // connection formed mid-run has already missed it. Seeded on every
        // connection, not just the first, because the clear below empties it
        // on every drop.
        void seedOverlays()
        // The updater mirror follows the same push-only contract — a phone
        // connecting mid-download has missed every percent tick so far.
        void seedDesktopUpdater()
      }
      // Overlay cards claim something is running on a machine this one can no
      // longer see. Losing the tunnel does not end those runs, but it does end
      // this phone's evidence for them, and a card left standing would go on
      // asserting one long after it finished. The updater mirror clears for
      // the same reason — and mid-install the drop IS the restart doing its
      // work; the reconnect and its fresh snapshot report the outcome.
      if (!isConnected && wasConnected) {
        clearOverlays()
        clearDesktopUpdater()
      }
      wasConnected = isConnected
    })

    return () => {
      subscription.remove()
      network()
      off()
    }
  }, [paired])
}

/**
 * Call `onUsable` whenever this device's network becomes something worth
 * re-checking the tunnel against. Returns the unsubscribe.
 *
 * Two edges, and the second is the one that matters:
 *
 * - The network came back. Obvious, and the tunnel's backoff would have got
 *   there on its own eventually; this only makes it immediate.
 * - The INTERFACE changed while still connected — walking out of wifi range
 *   onto cellular, or back. Nothing else in the app can see this. The socket
 *   was bound to an interface that no longer exists, so it is dead, but the OS
 *   reports it OPEN until a TCP timeout that may be a minute away, and the
 *   phone never backgrounds, so no other signal fires. This is the whole
 *   reason for the module.
 *
 * The first event is never an edge: there is no previous state to have changed
 * from, and the mount's own kick already covers "connect at startup".
 *
 * `onUsable` runs the ordinary resume(), which probes rather than assuming —
 * so a spurious type flap costs one keepalive and 2.5 seconds, not a
 * reconnect. Deliberately not more aggressive than that.
 */
function watchNetwork(onUsable: () => void): () => void {
  let previous: { type?: NetworkStateType; usable: boolean } | null = null
  try {
    // Required here, not imported at the top, and the distinction is the whole
    // guard. A native module resolves the moment its module body EVALUATES —
    // which for a static import is bundle load, long before any try/catch at
    // the call site can run. A binary without it then dies at launch with
    // "Cannot find native module 'ExpoNetwork'" and no screen at all, which is
    // exactly the trap PairSheet's lazy camera import exists to avoid. Behind
    // a require the failure lands here, where it costs the listener and
    // nothing else.
    const Network = require('expo-network') as typeof import('expo-network')
    const subscription = Network.addNetworkStateListener((state) => {
      // Undefined counts as usable: an unknown answer must never be the reason
      // a reconnect does not happen. Only an explicit `false` is a no.
      const usable = state.isConnected !== false && state.isInternetReachable !== false
      const last = previous
      previous = { type: state.type, usable }
      if (!usable || last === null) return
      if (!last.usable || last.type !== state.type) {
        // Nothing to do while the user is away — returning runs its own kick,
        // and a phone in someone's pocket changes network constantly. Only an
        // explicit `background` skips: `inactive` is a control centre swipe or
        // an incoming call, the app is still on screen and the user is coming
        // straight back, and early in launch this reads as nothing at all.
        // Same rule as `usable` above — an unknown answer is never the reason
        // a reconnect does not happen.
        if (AppState.currentState === 'background') return
        onUsable()
      }
    })
    return () => subscription.remove()
  } catch {
    // A JS bundle can outrun the binary it runs on: this module arrived in a
    // native build, and an older one has nothing to subscribe to. The
    // fingerprint runtime version normally keeps those apart, so this should
    // be unreachable in the wild — but every dev client built before the
    // module landed reaches it, and the cost of being wrong is the whole app
    // at launch. The cost of the guard is that reconnection falls back to
    // exactly what it did before the listener existed.
    return () => undefined
  }
}
