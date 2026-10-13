import type { SupportedLocale } from '@/lib/i18n'
import type { ThemeSource } from '@/providers/theme/useTheme'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

/**
 * Client-state store — the app-slice counterpart to the TanStack Query
 * server cache. Small, synchronous, selector-based (components re-render
 * only for the slices they read), persisted to the device. Server data
 * (conversations, messages, media) does NOT belong here — that lives in
 * SQLite behind the query layer (lib/conversations).
 */
export type AppState = {
  theme: ThemeSource
  /** null until the user picks one — the device language is used instead. */
  locale: SupportedLocale | null
  /** Demo mode: the app runs against the imported demo dataset. */
  demoMode: boolean
  /**
   * A desktop is paired and its data is what the app renders. Distinct from
   * demoMode rather than its inverse: a device can be neither (the door
   * screen), and disconnecting must return to demo mode being available
   * rather than implicitly entering it.
   */
  paired: boolean
  /**
   * Version of the demo bundle ingested into SQLite, null before the first
   * import. Holding the version rather than a boolean means a republished
   * dataset is distinguishable from an imported one when that check lands.
   */
  demoVersion: string | null
  /**
   * Whether THIS device applies OTA updates (EAS Update). Device-local and
   * deliberately not part of the desktop config snapshot: it governs this
   * install's own bundle, which no desktop knows or owns. Every check runs
   * from JS (lib/updates/useOtaUpdates) precisely so this switch can stop
   * them — see app.config.ts `checkAutomatically`.
   */
  otaEnabled: boolean
  setTheme: (theme: ThemeSource) => void
  setLocale: (locale: SupportedLocale) => void
  setDemoMode: (demoMode: boolean) => void
  setPaired: (paired: boolean) => void
  setDemoVersion: (demoVersion: string | null) => void
  setOtaEnabled: (otaEnabled: boolean) => void
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      theme: 'system',
      locale: null,
      demoMode: false,
      paired: false,
      demoVersion: null,
      otaEnabled: true,
      setTheme: (theme) => set({ theme }),
      setLocale: (locale) => set({ locale }),
      setDemoMode: (demoMode) => set({ demoMode }),
      setPaired: (paired) => set({ paired }),
      setDemoVersion: (demoVersion) => set({ demoVersion }),
      setOtaEnabled: (otaEnabled) => set({ otaEnabled })
    }),
    {
      name: 'wolffish.app',
      storage: createJSONStorage(() => AsyncStorage),
      version: 5,
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as AppState & { demoImported?: boolean }
        // v3 replaced the demoImported boolean with the imported bundle's
        // version. The old flag meant "the dataset was pushed to this device",
        // which no device off the App Store could ever have been — dropping it
        // sends every install through the one download it always needed.
        if (version < 3) {
          const { demoImported: _demoImported, ...rest } = state
          return { ...rest, demoVersion: null } as AppState
        }
        // v4 added otaEnabled and v5 added paired; a key missing from the
        // persisted blob falls back to the initializer's value, so neither
        // needs a branch. Later versions must NOT re-run the v3 branch, which
        // would drop demoVersion and send an already-loaded device back
        // through the whole demo download.
        return state
      },
      partialize: (state) => ({
        theme: state.theme,
        locale: state.locale,
        demoMode: state.demoMode,
        paired: state.paired,
        demoVersion: state.demoVersion,
        otaEnabled: state.otaEnabled
      })
    }
  )
)

/** Resolves once the persisted state has been restored from disk. */
export function whenHydrated(): Promise<void> {
  if (useAppStore.persist.hasHydrated()) return Promise.resolve()
  return new Promise((resolve) => {
    const unsub = useAppStore.persist.onFinishHydration(() => {
      unsub()
      resolve()
    })
  })
}
