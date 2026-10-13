import { useAppStore, whenHydrated } from '@/state/appStore'
import { ThemeContext, type ThemeSource } from '@/providers/theme/useTheme'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { colorScheme as nativewindScheme, useColorScheme } from 'nativewind'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { View } from 'react-native'

// Pre-store persistence key — migrated into the zustand store on first run.
const LEGACY_KEY = 'wolffish.theme'

function isThemeSource(value: unknown): value is ThemeSource {
  return value === 'system' || value === 'light' || value === 'dark'
}

const nextTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Restores a stored theme, and makes sure NativeWind actually took it.
 *
 * NativeWind keeps no copy of the value handed to `colorScheme.set()`: it
 * forwards it to `Appearance.setColorScheme()` and then waits for the OS to
 * report a scheme back. The OS only reports a *change* — re-applying the scheme
 * it already holds emits nothing — so a set that changes nothing leaves
 * NativeWind rendering the scheme it read when the module loaded, which is the
 * device's own.
 *
 * A language switch restarts the app, and the restart leaves exactly that split
 * behind: the OS keeps the override the previous run applied while the fresh JS
 * context reads the device scheme. Re-applying the stored theme over an OS that
 * already has it says nothing, and the app comes back in the device's scheme
 * with the selector still showing the stored one.
 *
 * So: apply, give the OS a tick to report, and only if it never did, force a
 * real change by way of the opposite scheme. The two writes have to land in
 * separate ticks — a same-tick pair is coalesced into no change at all. The
 * scheme they pass through is the wrong one already showing, and this runs
 * behind the splash besides, so there is nothing to see.
 */
async function restoreScheme(source: ThemeSource): Promise<void> {
  nativewindScheme.set(source)
  // 'system' asks for whatever the OS reports, so its report cannot disagree.
  if (source === 'system') return
  await nextTick()
  if (nativewindScheme.get() === source) return
  nativewindScheme.set(source === 'dark' ? 'light' : 'dark')
  await nextTick()
  nativewindScheme.set(source)
  // One more tick before revealing, so the first painted frame is the fixed one.
  await nextTick()
}

export function ThemeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const theme = useAppStore((s) => s.theme)
  const setThemeState = useAppStore((s) => s.setTheme)
  const [ready, setReady] = useState<boolean>(false)
  // Resolved scheme after NativeWind applies the source ('system' follows
  // the OS appearance live).
  const { colorScheme } = useColorScheme()

  useEffect(() => {
    let cancelled = false

    void (async () => {
      await whenHydrated()
      const legacy = await AsyncStorage.getItem(LEGACY_KEY)
      if (cancelled) return
      if (isThemeSource(legacy)) {
        useAppStore.getState().setTheme(legacy)
        void AsyncStorage.removeItem(LEGACY_KEY)
      }
      await restoreScheme(useAppStore.getState().theme)
      if (cancelled) return
      setReady(true)
    })()

    return () => {
      cancelled = true
    }
  }, [])

  const setTheme = useCallback(
    async (source: ThemeSource) => {
      // A plain set is enough here: the selector disables the active option, so
      // a tap always asks for a scheme the OS is not already in, and the OS
      // reports the change back on its own.
      nativewindScheme.set(source)
      setThemeState(source)
    },
    [setThemeState]
  )

  if (!ready) return <View className="bg-bg h-full w-full" />

  return (
    <ThemeContext.Provider value={{ theme, isDark: colorScheme === 'dark', setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}
