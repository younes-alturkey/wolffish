/**
 * Shared helpers behind the channel `/resume` and `/delete` conversation
 * pickers (WhatsApp + Telegram).
 *
 * Both channels render the same thing: this channel's conversations, newest
 * first, numbered, a page at a time, picked by replying with a number. Only
 * the markup differs (Telegram HTML vs WhatsApp's native syntax), so the
 * paging arithmetic, the numbering, and the reply parsing live here rather
 * than being maintained twice — the same split `model-picker.ts` uses for
 * `/model`.
 */

/**
 * Conversations shown per page. A phone chat is a poor place to scroll, but
 * 25 rows still fits comfortably inside both channels' 4096-char message
 * limit (worst case ≈3k with long titles), so a page is one message and never
 * gets split mid-picker.
 */
export const PAGE_SIZE = 25

/** Replies that advance an open picker to its next page. */
const NEXT_PAGE_WORDS = new Set(['next', '/next'])

/** True when a reply means "show me the next page" rather than a selection. */
export function isNextPageReply(lowercasedText: string): boolean {
  return NEXT_PAGE_WORDS.has(lowercasedText.trim())
}

/** Keycap emoji per digit, indexed by the digit's value. */
const KEYCAP_DIGITS = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'] as const

/**
 * Render a 1-based item number as keycap emoji. Numbers past 9 are spelled
 * out digit by digit (26 → 2️⃣6️⃣): picker numbering runs across the whole
 * list, so it has to keep working past the 10 glyphs a single page needed
 * back when the list was capped at 10. 10 keeps its dedicated glyph.
 */
export function keycapNumber(n: number): string {
  if (n === 10) return '🔟'
  return String(n)
    .split('')
    .map((d) => KEYCAP_DIGITS[Number(d)])
    .join('')
}

/**
 * Parse a number-only reply for picker selection. Accepts up to 4 digits,
 * optionally surrounded by whitespace. Returns null for anything else,
 * including text that merely contains a number — "send 1 message" must not
 * select item 1, and with `/delete` pending, "call me at 5" must not delete
 * conversation 5.
 */
export function parseSelectionNumber(text: string): number | null {
  const m = /^\s*(\d{1,4})\s*$/.exec(text)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Longest conversation title a picker row shows. Titles are model-written and
 * unbounded (the longest on disk today is ~101 chars, from a URL falling
 * through the no-LLM path). Both channels cap a message at 4096 chars and
 * neither splits a picker — an over-long page would simply fail to send — so a
 * page of 25 rows has to keep each row bounded. 64 is plenty to recognise a
 * conversation by, and reads better on a phone.
 */
const TITLE_MAX = 64

export function truncateTitle(title: string): string {
  const clean = (title || 'Untitled').trim() || 'Untitled'
  return clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX - 1)}…` : clean
}

/**
 * Short human origin tag for a picker row. Now that /resume lists conversations
 * from every channel (a chat is no longer pinned to its own), a row on its own
 * — title, time, count — doesn't say whether you're about to resume a Telegram
 * chat, an in-app one, or an automation run. This is the disambiguator.
 */
export function originLabel(channel?: string | null): string {
  switch (channel) {
    case 'telegram':
      return 'Telegram'
    case 'whatsapp':
      return 'WhatsApp'
    case 'mobile':
      return 'Phone'
    case 'cli':
      return 'Terminal'
    case 'heartbeat':
      return 'Automated'
    case 'procedure':
      return 'Procedure'
    default:
      return 'App'
  }
}

export type PickerPage<T> = {
  /** The items on this page. */
  shown: T[]
  /** 0-based index of the first item — add 1 for the number the user sees. */
  start: number
  /** 1-based number of the last item on this page. */
  last: number
  /** Size of the whole list, not the page. */
  total: number
  /** Whether a further page exists. */
  hasMore: boolean
}

/**
 * Window a snapshotted list into one page. `page` is 0-based; numbering is
 * continuous across pages (page 1 opens at item 26) so a number identifies
 * the same conversation for as long as the picker is open, and a number from
 * a page already scrolled past still selects.
 */
export function pickerPage<T>(items: T[], page: number): PickerPage<T> {
  const start = Math.max(0, page) * PAGE_SIZE
  const shown = items.slice(start, start + PAGE_SIZE)
  const last = start + shown.length
  return { shown, start, last, total: items.length, hasMore: last < items.length }
}

/** True when `page` (0-based) has at least one item to show. */
export function pageExists(items: unknown[], page: number): boolean {
  return page >= 0 && page * PAGE_SIZE < items.length
}

/**
 * Highest item number the user has actually been shown, given the page they
 * are on. Paging only ever moves forward, so everything from 1 to here has
 * been rendered at some point and stays selectable — replying "3" from page 2
 * still picks the third conversation.
 *
 * Selection is bounded by THIS rather than the snapshot size: the snapshot
 * holds every conversation, so an unbounded number would let "30" typed on
 * page 1 act on a row the user has never laid eyes on — and for /delete that
 * is an unrecoverable delete of the wrong conversation.
 */
export function selectableCount(items: unknown[], page: number): number {
  return pickerPage(items, page).last
}
