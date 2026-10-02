import { useCallback, useEffect, useState, type ReactNode } from 'react'
import i18n, { RTL_LOCALES, type SupportedLocale } from '@lib/i18n'
import { LocaleContext } from '@providers/locale/useLocale'

function applyDocumentLocale(locale: SupportedLocale): void {
  const root = document.documentElement
  root.lang = locale
  root.dir = RTL_LOCALES.has(locale) ? 'rtl' : 'ltr'
}

export function LocaleProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [locale, setLocaleState] = useState<SupportedLocale>('en')
  const [ready, setReady] = useState<boolean>(false)

  useEffect(() => {
    let cancelled = false

    void window.api.locale.get().then(async (stored) => {
      if (cancelled) return
      await i18n.changeLanguage(stored)
      applyDocumentLocale(stored)
      setLocaleState(stored)
      setReady(true)
    })

    return () => {
      cancelled = true
    }
  }, [])

  const setLocale = useCallback(async (next: SupportedLocale) => {
    const stored = await window.api.locale.set(next)
    await i18n.changeLanguage(stored)
    applyDocumentLocale(stored)
    setLocaleState(stored)
  }, [])

  if (!ready) return <div className="bg-bg h-full w-full" aria-hidden />

  return <LocaleContext.Provider value={{ locale, setLocale }}>{children}</LocaleContext.Provider>
}
