import type { SupportedLocale } from '@/lib/i18n'
import { tunnelClient } from '@/lib/tunnel/client'
import { Rpc } from '@/lib/tunnel/protocol'
import { Asset } from 'expo-asset'
import { File } from 'expo-file-system'
// Assets, not source: Metro follows these at bundle time to pack the markdown
// into the binary (the `md` asset extension is registered in metro.config.js).
// The `@/` alias resolves them the same as any module — Metro applies
// tsconfig paths before it decides source-vs-asset.
import ar202607 from '@/changelog/2026-07/ar.md'
import en202607 from '@/changelog/2026-07/en.md'
import ar202608 from '@/changelog/2026-08/ar.md'
import en202608 from '@/changelog/2026-08/en.md'
import ar202609 from '@/changelog/2026-09/ar.md'
import en202609 from '@/changelog/2026-09/en.md'

/**
 * Release notes — one markdown page per month per locale, the desktop's
 * src/changelog/<month>/<locale>.md layout kept verbatim so the two apps'
 * notes are written the same way and read the same way.
 *
 * A release adds its section to the top of BOTH pages by hand (the version
 * bump itself is scripts/provision.js) and moves the `Latest` chip down to
 * it. A new month means a new directory and one more entry in PAGES: the
 * imports have to be static for Metro to see the files and pack them into
 * the binary, so the registry cannot be built by globbing a folder.
 */
const PAGES: Record<string, Record<SupportedLocale, number>> = {
  '2026-07': { en: en202607, ar: ar202607 },
  '2026-08': { en: en202608, ar: ar202608 },
  '2026-09': { en: en202609, ar: ar202609 }
}

/** Months that have notes, newest first — the order the page lists them in. */
export const CHANGELOG_MONTHS: string[] = Object.keys(PAGES).sort().reverse()

/** The newest month, or null when no notes have been written at all. */
export const LATEST_MONTH: string | null = CHANGELOG_MONTHS[0] ?? null

// Read once per (month, locale) and kept: these are a few KB of prose, and a
// second visit to the page should be instant rather than another disk read.
const cache = new Map<string, string>()

/**
 * The notes for one month in one language. Falls back to English for a month
 * that has no page in the requested language, and returns null when the month
 * is unknown or its asset cannot be read — the caller shows the empty state
 * rather than a broken page.
 */
export async function readChangelog(
  month: string,
  locale: SupportedLocale
): Promise<string | null> {
  const page = PAGES[month]
  if (!page) return null
  const key = `${month}:${locale}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  try {
    const asset = Asset.fromModule(page[locale] ?? page.en)
    // Local in a store build, a Metro fetch in development — either way this
    // is what puts a readable URI on the asset, and it is a no-op once done.
    if (!asset.localUri) await asset.downloadAsync()
    const text = await new File(asset.localUri ?? asset.uri).text()
    cache.set(key, text)
    return text
  } catch {
    return null
  }
}

// The desktop's pages, fetched over the tunnel and kept for the app run.
// Session-lifetime on purpose: the content belongs to the desktop's build, so
// a fresh run re-asks and a desktop updated mid-pairing serves its new notes.
const desktopCache = new Map<string, string>()

/**
 * One month of the PAIRED DESKTOP's release notes, verbatim markdown — the
 * live twin of readChangelog above. Which months exist comes from the config
 * snapshot (useDesktopChangelogMonths); the body is fetched only when the
 * reader opens it, because the full set is hundreds of KB. The desktop falls
 * back to English for a month with no page in the requested language, same
 * as the local reader. Null when the tunnel is down and the page is not
 * already cached — the screen shows its connect-to-read empty state.
 */
export async function readDesktopChangelog(
  month: string,
  locale: SupportedLocale
): Promise<string | null> {
  const key = `${month}:${locale}`
  const cached = desktopCache.get(key)
  if (cached !== undefined) return cached
  const tunnel = tunnelClient.active
  if (!tunnel) return null
  try {
    const answer = (await tunnel.rpc(Rpc.changelogRead, { month, locale })) as {
      markdown?: string | null
    }
    const markdown = typeof answer?.markdown === 'string' ? answer.markdown : null
    if (!markdown) return null
    desktopCache.set(key, markdown)
    return markdown
  } catch {
    return null
  }
}

/**
 * A month key rendered in the reader's language — 'July 2026', 'يوليو 2026'.
 * Built from the first of the month at noon: a date at midnight can slip a day
 * backwards under a negative UTC offset and name the wrong month.
 */
export function formatChangelogMonth(month: string, locale: SupportedLocale): string {
  const [year, monthNumber] = month.split('-').map(Number)
  if (!year || !monthNumber) return month
  return new Date(year, monthNumber - 1, 1, 12).toLocaleDateString(locale, {
    month: 'long',
    year: 'numeric'
  })
}
