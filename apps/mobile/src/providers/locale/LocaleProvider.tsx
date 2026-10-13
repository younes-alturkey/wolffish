import i18n, {
  RTL_LOCALES,
  deviceLocale,
  isSupportedLocale,
  type SupportedLocale
} from '@/lib/i18n'
import { restartApp } from '@/lib/utils/restart'
import { LocaleContext } from '@/providers/locale/useLocale'
import { useAppStore, whenHydrated } from '@/state/appStore'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { I18nManager, View } from 'react-native'

// Pre-store persistence key — migrated into the zustand store on first run.
const LEGACY_KEY = 'wolffish.locale'

export function LocaleProvider({ children }: { children: ReactNode }): React.JSX.Element {
  // The locale the UI is currently rendering. Deliberately NOT derived from
  // the store: when a switch needs a restart, the store persists the new
  // choice while the visible UI stays frozen in the old language until the
  // app relaunches — switching strings moments before a restart reads as a
  // glitch.
  const [locale, setRenderedLocale] = useState<SupportedLocale>('en')
  const [ready, setReady] = useState<boolean>(false)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      await whenHydrated()
      const legacy = await AsyncStorage.getItem(LEGACY_KEY)
      if (cancelled) return
      if (isSupportedLocale(legacy) && useAppStore.getState().locale === null) {
        useAppStore.getState().setLocale(legacy)
        void AsyncStorage.removeItem(LEGACY_KEY)
      }
      const next = useAppStore.getState().locale ?? deviceLocale()
      await i18n.changeLanguage(next)
      // Sync native flags without reloading — a startup reload could loop in
      // environments where the RTL flag does not persist (e.g. Expo Go).
      const wantRtl = RTL_LOCALES.has(next)
      if (I18nManager.isRTL !== wantRtl) {
        I18nManager.allowRTL(wantRtl)
        I18nManager.forceRTL(wantRtl)
      }
      if (!cancelled) {
        setRenderedLocale(next)
        setReady(true)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  const setLocale = useCallback(async (next: SupportedLocale) => {
    useAppStore.getState().setLocale(next)
    const wantRtl = RTL_LOCALES.has(next)
    if (I18nManager.isRTL !== wantRtl) {
      // The store persists asynchronously; restarting before the write lands
      // would bring the app back in the old language (growth-app flushes
      // redux-persist and sleeps for the same reason).
      await new Promise((resolve) => setTimeout(resolve, 400))
      I18nManager.allowRTL(wantRtl)
      I18nManager.forceRTL(wantRtl)
      try {
        // The UI stays frozen in the old language until this relaunch
        // completes — the switch lands all at once.
        await restartApp()
        return
      } catch {
        // Restart unavailable — switch strings in place; the layout
        // direction completes on the next cold start.
      }
    }
    await i18n.changeLanguage(next)
    setRenderedLocale(next)
  }, [])

  if (!ready) return <View className="bg-bg h-full w-full" />

  return (
    <LocaleContext.Provider value={{ locale, isRtl: RTL_LOCALES.has(locale), setLocale }}>
      {children}
    </LocaleContext.Provider>
  )
}
