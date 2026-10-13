import { tokensFor, type ThemeTokens } from '@/lib/theme/colors'
import { createContext, useContext } from 'react'

export type ThemeSource = 'system' | 'light' | 'dark'

export type ThemeContextValue = {
  theme: ThemeSource
  isDark: boolean
  setTheme: (source: ThemeSource) => Promise<void>
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider')
  return ctx
}

/** Concrete token values for the active scheme, for props that need a color string. */
export function useTokens(): ThemeTokens {
  return tokensFor(useTheme().isDark)
}
