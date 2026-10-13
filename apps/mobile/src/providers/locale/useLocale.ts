import type { SupportedLocale } from '@/lib/i18n'
import { createContext, useContext } from 'react'

export type LocaleContextValue = {
  locale: SupportedLocale
  isRtl: boolean
  setLocale: (next: SupportedLocale) => Promise<void>
}

export const LocaleContext = createContext<LocaleContextValue | null>(null)

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext)
  if (!ctx) throw new Error('useLocale must be used within a LocaleProvider')
  return ctx
}
