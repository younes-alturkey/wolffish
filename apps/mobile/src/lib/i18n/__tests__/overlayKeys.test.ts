/**
 * Every string the reindex card or its opened sheet can put on screen, in both
 * locales — the same guard workspaceKeys.test.ts puts on the three workspace
 * screens, and for the same reason: i18next answers a MISSING key with the key
 * itself, so a gap renders `overlays.reindexTitle` on a card instead of
 * throwing. Listed out one by one, not derived, so that renaming one breaks
 * this test rather than a card.
 */

import ar from '@/lib/i18n/locales/ar.json'
import en from '@/lib/i18n/locales/en.json'

const LOCALES = { en, ar } as Record<string, Record<string, unknown>>

function lookup(bundle: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      bundle
    )
}

const KEYS = [
  'overlays.reindexTitle',
  'overlays.openHint',
  'overlays.startedAt',
  'overlays.reindexBody',
  'overlays.runsOnDesktop'
]

describe.each(Object.keys(LOCALES))('%s', (locale) => {
  it.each(KEYS)('has real text for %s', (key) => {
    const value = lookup(LOCALES[locale], key)
    expect(typeof value).toBe('string')
    expect(value).not.toBe('')
    expect(value).not.toBe(key)
  })
})
