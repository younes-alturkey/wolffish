import { isCheckDue } from '@/lib/updates/policy'
import { useAppStore } from '@/state/appStore'
import * as Updates from 'expo-updates'
import { useEffect } from 'react'
import { AppState } from 'react-native'

/**
 * Keeps the running app current with OTA updates (EAS Update) — and, just as
 * importantly, stops when the user says stop.
 *
 * Every routine check lives here, in JS: the native layer is configured
 * ON_ERROR_RECOVERY (app.config.ts), so it no longer checks inside the launch
 * sequence, where no preference could ever have reached it. This hook runs the
 * launch check, re-checks when the app returns to the foreground (throttled by
 * policy.ts), and downloads in the background. All of it is gated on
 * appStore.otaEnabled, so turning updates off in Settings genuinely ends them.
 * No-op in development and wherever updates are disabled (local builds, web).
 *
 * Announcing what it downloaded is not this hook's job: components/updates/
 * UpdateNotice watches the same pending-update state and renders the card.
 *
 * One residue the switch cannot undo: an update already downloaded before it
 * was turned off is held by the native store and still applies on the next
 * cold start. Off prevents new updates, not a pending one.
 */
export function useOtaUpdates(): void {
  const enabled = useAppStore((state) => state.otaEnabled)

  useEffect(() => {
    if (!enabled || !updatesAvailable()) return
    // The launch pass: with the native check retired, this is what keeps a
    // store build current. Throttled like every other pass, so flipping the
    // switch back and forth doesn't hammer the update server.
    void checkIfDue()
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void checkIfDue()
    })
    return () => subscription.remove()
  }, [enabled])
}

/** Whether this build can reach the update server at all. */
export function updatesAvailable(): boolean {
  return !__DEV__ && Updates.isEnabled
}

export type UpdateCheckOutcome =
  /** An update was found and downloaded — restart to apply it. */
  | 'downloaded'
  /** The server has nothing newer for this runtime. */
  | 'upToDate'
  /** This build never checks: development, or updates disabled at build time. */
  | 'unavailable'
  /** Offline, a server hiccup, or a download that failed midway. */
  | 'failed'

/** Wall clock of the last check, shared by the manual and background passes. */
let lastCheckedAt = 0

/**
 * Check now, whatever the throttle says — the Settings screen's manual check.
 * Deliberately runs even while automatic updates are off: a user asking for an
 * update in as many words is not the thing that switch turns off.
 */
export async function checkForUpdateNow(): Promise<UpdateCheckOutcome> {
  if (!updatesAvailable()) return 'unavailable'
  lastCheckedAt = Date.now()
  try {
    const check = await Updates.checkForUpdateAsync()
    if (!check.isAvailable) return 'upToDate'
    const fetched = await Updates.fetchUpdateAsync()
    return fetched.isNew ? 'downloaded' : 'upToDate'
  } catch {
    return 'failed'
  }
}

/**
 * The background pass: quiet by design. Offline periods and update-server
 * hiccups are invisible — the next foreground pass simply tries again.
 */
async function checkIfDue(): Promise<void> {
  if (!isCheckDue(lastCheckedAt, Date.now())) return
  await checkForUpdateNow()
}
