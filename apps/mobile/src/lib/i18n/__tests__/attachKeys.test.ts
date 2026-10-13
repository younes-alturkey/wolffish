/**
 * Every string the attach flow can put on screen, in both locales.
 *
 * These are all toasts, and a toast is the only feedback an upload refusal
 * gets — a key that resolves to nothing renders an empty card with an error
 * icon and no reason, which is worse than no toast at all. i18next answers a
 * MISSING key with the key itself, so the check is not "does it resolve" but
 * "is it real text", and it has to hold for Arabic too or the refusal is
 * silent for half the users.
 */

import ar from '@/lib/i18n/locales/ar.json'
import en from '@/lib/i18n/locales/en.json'
import { uploadErrorMessage, type UploadValidationError } from '@/lib/files/uploadPolicy'

const LOCALES = { en, ar } as Record<string, Record<string, unknown>>

/** Resolve a dotted key the way i18next does, or undefined when absent. */
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
  'chat.attach.title',
  'chat.attach.media',
  'chat.attach.mediaHint',
  'chat.attach.files',
  'chat.attach.filesHint',
  'chat.attach.remove',
  'chat.attach.error',
  'chat.attach.failed',
  'chat.upload.fileTooLarge',
  'chat.upload.maxFiles',
  'chat.upload.totalExceeded',
  'chat.upload.typeNotSupported',
  'units.bytes',
  'units.kilobytes',
  'units.megabytes',
  'units.gigabytes'
]

describe.each(Object.keys(LOCALES))('%s', (locale) => {
  it.each(KEYS)('has real text for %s', (key) => {
    const value = lookup(LOCALES[locale], key)
    expect(typeof value).toBe('string')
    expect((value as string).trim().length).toBeGreaterThan(0)
  })

  it('interpolates every placeholder the code actually passes', () => {
    // A key whose placeholder was renamed still "resolves" — it just renders
    // the raw {{token}} at the user. Assert the tokens the call sites supply.
    expect(lookup(LOCALES[locale], 'chat.attach.remove')).toContain('{{name}}')
    expect(lookup(LOCALES[locale], 'chat.attach.failed')).toContain('{{names}}')
    expect(lookup(LOCALES[locale], 'chat.upload.maxFiles')).toContain('{{count}}')
    expect(lookup(LOCALES[locale], 'chat.upload.fileTooLarge')).toContain('{{limit}}')
    expect(lookup(LOCALES[locale], 'chat.upload.totalExceeded')).toContain('{{limit}}')
  })
})

describe('uploadErrorMessage', () => {
  const errors: UploadValidationError[] = [
    { code: 'type_not_supported' },
    { code: 'max_files_reached', max: 10 },
    { code: 'file_too_large', maxBytes: 512 * 1024 * 1024 },
    { code: 'total_size_exceeded', maxBytes: 1024 * 1024 * 1024 }
  ]

  it.each(errors)('produces non-empty English text for $code', (error) => {
    // The real bundle, resolved the way i18next would, so a message can never
    // come back as the empty string the toast would render as a blank card.
    const t = (key: string, vars?: Record<string, unknown>): string => {
      const value = lookup(en, key)
      if (typeof value !== 'string') return key
      return value.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(vars?.[name] ?? ''))
    }
    const message = uploadErrorMessage(error, t)
    expect(message.trim().length).toBeGreaterThan(0)
    expect(message).not.toContain('{{')
    expect(message.startsWith('chat.')).toBe(false)
  })
})
