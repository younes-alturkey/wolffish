import ar from '@/lib/i18n/locales/ar.json'
import en from '@/lib/i18n/locales/en.json'
import { getLocales } from 'expo-localization'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

export const SUPPORTED_LOCALES = ['en', 'ar'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

export const RTL_LOCALES: ReadonlySet<SupportedLocale> = new Set(['ar'])

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return SUPPORTED_LOCALES.includes(value as SupportedLocale)
}

/** Best supported match for the device language, falling back to English. */
export function deviceLocale(): SupportedLocale {
  const code = getLocales()[0]?.languageCode
  return isSupportedLocale(code) ? code : 'en'
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ar: { translation: ar }
  },
  lng: deviceLocale(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false
})

export default i18n
