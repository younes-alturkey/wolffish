import { purgeDemoState } from '@/lib/demo/reset'
import { useAppStore } from '@/state/appStore'

/**
 * Factory reset THIS DEVICE — everything demo mode ever wrote plus the
 * device's own demo entry, back to the blank home screen a fresh install
 * boots into.
 *
 * Scope is deliberately one machine wide: the desktop workspace is not
 * touched — it cannot be from here — and factory-resetting Wolffish itself is
 * the desktop app's own Data-panel action. What survives is the same
 * carve-out that reset makes for keys/language/theme: this device's theme,
 * language and OTA switch are preferences about the phone, not data about
 * the workspace.
 *
 * purgeDemoState already sequences the wipe so an interruption is safe
 * (version cleared first, every step independently guarded); the only extra
 * state a factory reset owns is the demo-mode flag itself, dropped last so a
 * half-finished reset reads as "demo on, dataset gone" — the state the next
 * demo entry repairs by re-importing.
 */
export async function factoryResetDevice(): Promise<void> {
  await purgeDemoState()
  useAppStore.getState().setDemoMode(false)
}
