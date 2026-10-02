import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ThemeContext, type ThemeSource } from '@providers/theme/useTheme'

function applyDarkClass(isDark: boolean): void {
  const root = document.documentElement
  if (isDark) root.classList.add('dark')
  else root.classList.remove('dark')
}

export function ThemeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [theme, setThemeState] = useState<ThemeSource>('system')
  const [isDark, setIsDark] = useState<boolean>(false)
  const [ready, setReady] = useState<boolean>(false)

  useEffect(() => {
    let cancelled = false

    void window.api.theme.get().then((state) => {
      if (cancelled) return
      setThemeState(state.themeSource)
      setIsDark(state.shouldUseDarkColors)
      applyDarkClass(state.shouldUseDarkColors)
      setReady(true)
    })

    const off = window.api.theme.onUpdated((state) => {
      setThemeState(state.themeSource)
      setIsDark(state.shouldUseDarkColors)
      applyDarkClass(state.shouldUseDarkColors)
    })

    return () => {
      cancelled = true
      off()
    }
  }, [])

  const setTheme = useCallback(async (source: ThemeSource) => {
    const next = await window.api.theme.set(source)
    setThemeState(next.themeSource)
    setIsDark(next.shouldUseDarkColors)
    applyDarkClass(next.shouldUseDarkColors)
  }, [])

  if (!ready) return <div className="bg-bg h-full w-full" aria-hidden />

  return (
    <ThemeContext.Provider value={{ theme, isDark, setTheme }}>{children}</ThemeContext.Provider>
  )
}
