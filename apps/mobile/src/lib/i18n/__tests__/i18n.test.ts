jest.mock('expo-localization', () => ({
  getLocales: jest.fn(() => [{ languageCode: 'ar' }])
}))

import { getLocales } from 'expo-localization'
import i18n, { RTL_LOCALES, SUPPORTED_LOCALES, deviceLocale, isSupportedLocale } from '@/lib/i18n'

describe('isSupportedLocale', () => {
  it('accepts every supported locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(isSupportedLocale(locale)).toBe(true)
    }
  })

  it('rejects unknown values', () => {
    expect(isSupportedLocale('fr')).toBe(false)
    expect(isSupportedLocale(null)).toBe(false)
    expect(isSupportedLocale(undefined)).toBe(false)
    expect(isSupportedLocale(42)).toBe(false)
  })
})

describe('deviceLocale', () => {
  it('returns the device language when supported', () => {
    ;(getLocales as jest.Mock).mockReturnValue([{ languageCode: 'ar' }])
    expect(deviceLocale()).toBe('ar')
  })

  it('falls back to English for unsupported languages', () => {
    ;(getLocales as jest.Mock).mockReturnValue([{ languageCode: 'ja' }])
    expect(deviceLocale()).toBe('en')
  })

  it('falls back to English when no locale is reported', () => {
    ;(getLocales as jest.Mock).mockReturnValue([])
    expect(deviceLocale()).toBe('en')
  })
})

describe('locale data', () => {
  it('marks Arabic as RTL and English as LTR', () => {
    expect(RTL_LOCALES.has('ar')).toBe(true)
    expect(RTL_LOCALES.has('en')).toBe(false)
  })

  it('ships translations for every supported locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(i18n.hasResourceBundle(locale, 'translation')).toBe(true)
    }
  })

  it('keeps the shared app name in sync across locales', () => {
    expect(i18n.getResource('en', 'translation', 'app.name')).toBe('Wolffish')
    expect(i18n.getResource('ar', 'translation', 'app.name')).toBe('وولفيش')
  })
})
