import en from './locales/en.json'
import ar from './locales/ar.json'

export type Locale = 'en' | 'ar'

const MESSAGES: Record<Locale, Record<string, unknown>> = { en, ar }
const STORAGE_KEY = 'locale'

export function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'en' || saved === 'ar') return saved
  } catch {
    // Storage can be blocked (private windows); fall through to the browser language.
  }
  return navigator.language.toLowerCase().startsWith('ar') ? 'ar' : 'en'
}

export function saveLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    // Not persisting the choice is fine.
  }
}

export function translator(locale: Locale) {
  return (key: string, vars: Record<string, string> = {}): string => {
    const value = key
      .split('.')
      .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], MESSAGES[locale])
    const text = typeof value === 'string' ? value : key
    return text.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? `{${name}}`)
  }
}
