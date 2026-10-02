/**
 * Telegram-specific text helpers.
 *
 * There is deliberately NO Markdown→HTML converter here. The model is
 * taught to write Telegram's HTML subset directly (CHANNEL_PROMPTS in
 * runtime/prefrontal.ts) and its prose is sent verbatim with
 * `parse_mode: 'HTML'` — the model is the formatter, not this module.
 * What remains is the plumbing the channel needs around that contract:
 * entity escaping for CODE-composed HTML surfaces, and the invisible
 * bidi mark that fixes RTL/LTR paragraph direction on mixed-locale
 * clients.
 */

import { findDividerBars } from '../format'

/** Escape `&`, `<`, `>` for HTML text content. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * The complete set of tag names Telegram's Bot API HTML parser accepts.
 * A single tag outside this set — or a bare `<`/`&`, or an unclosed pair —
 * makes it reject the WHOLE message with 400 "can't parse entities".
 */
export const TELEGRAM_ALLOWED_TAGS: readonly string[] = [
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'a',
  'code',
  'pre',
  'blockquote',
  'span',
  'tg-spoiler',
  'tg-emoji'
]
const ALLOWED = new Set(TELEGRAM_ALLOWED_TAGS)

/**
 * Tags whose ENTITY-ESCAPED form (`&lt;b&gt;`) can only mean the model
 * escaped its own formatting: the allowed set plus `<br>`, which is never
 * displayed-on-purpose. Escaped forms of other names (`&lt;message&gt;`,
 * `&lt;div&gt;`) stay legal — they render as literal text, which is the
 * plausible intent when the name isn't a Telegram formatting tag.
 */
const ESCAPED_TAG_INTENT = new Set([...TELEGRAM_ALLOWED_TAGS, 'br'])

export type TelegramHtmlReport = {
  ok: boolean
  /** All problems, hard first — what `telegram_check_format` lists. */
  issues: string[]
  /**
   * The message would reach the user wrong: Telegram rejects the HTML
   * (400 → plain fallback shows tag soup), entity-escaped tags render
   * as literal "<b>" text, a decorative divider-bar line wraps into
   * several broken lines of bar characters on a phone, or leaked
   * Markdown (**bold**, # headings, [text](url), | tables |, --- rules)
   * shows its raw symbols — Telegram renders no Markdown. Send tools
   * refuse to send while any exist; the model rewrites its own text
   * (sendAsIs is the escape hatch for markup that IS the content, and
   * RejectBudget still force-delivers after repeated bounces so a
   * message is never lost). Quoting inside <code>/<pre> is exempt.
   */
  hard: string[]
  /**
   * Delivered with a note on the send result instead of blocking.
   * Currently empty on Telegram — kept for report-shape parity with
   * WhatsApp (which parks cosmetic-only findings here).
   */
  soft: string[]
}

/**
 * Validate a message against Telegram's HTML subset WITHOUT sending it —
 * the engine behind the `telegram_check_format` tool and the pre-send gate
 * inside every send/edit tool. This does NOT rewrite or repair anything
 * (the model is the formatter); it only reports exactly what would reach
 * the user wrong, so the model can fix its own markup. Hard failure modes:
 *   1. a tag Telegram doesn't support (a stray `<message>`, a leaked
 *      `<p>`/`<br>`/`<h2>`, a Markdown-ish tag) — 400,
 *   2. an unclosed tag (`<b>` with no `</b>`) — 400,
 *   3. a mismatched/orphan closing tag (`</i>` with no open `<i>`) — 400,
 *   4. a bare `<` or `&` that should have been written `&lt;` / `&amp;` — 400,
 *   5. entity-escaped formatting tags (`&lt;b&gt;text&lt;/b&gt;`) — Telegram
 *      happily delivers these as LITERAL "<b>text</b>" text, so neither the
 *      API nor a tag-syntax check ever objects; only this rule can. Escaped
 *      tags inside a real `<code>`/`<pre>` span are exempt — that is the
 *      correct way to display a tag on purpose,
 *   6. decorative divider-bar lines (━━━━━, ═════, -----) — perfectly valid
 *      text, but a phone's narrow bubble wraps them into several broken
 *      lines of bar characters. Bars inside `<code>`/`<pre>` are exempt —
 *      quoted CLI output legitimately contains long box-drawing runs,
 *   7. leaked Markdown (**bold**, # headings, [text](url), | tables |,
 *      --- rules) — parses fine as HTML, but Telegram renders no Markdown,
 *      so the raw symbols reach the user. Also exempt inside
 *      `<code>`/`<pre>`, where quoting Markdown is the point.
 * `>` is left unchecked — Telegram accepts a bare `>` in text.
 */
/**
 * Blank the CONTENT of `<pre>…</pre>` and `<code>…</code>` spans (tags
 * stay, length preserved) so the divider-bar check never fires on quoted
 * code — showing a box-drawn CLI table inside a code span is intentional
 * content, not decoration. `<pre>` first: its body may contain `<code>`.
 */
function maskCodeSpans(message: string): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ')
  return message
    .replace(
      /(<pre(?:\s[^<>]*)?>)([\s\S]*?)(<\/pre>)/gi,
      (_, open, body, close) => open + blank(body) + close
    )
    .replace(
      /(<code(?:\s[^<>]*)?>)([\s\S]*?)(<\/code>)/gi,
      (_, open, body, close) => open + blank(body) + close
    )
}

export function validateTelegramHtml(message: string): TelegramHtmlReport {
  const unsupported = new Set<string>()
  const orphanClose = new Set<string>()
  const escapedTags = new Set<string>()
  let escapedCount = 0
  const stack: string[] = []
  let bareLt = 0
  let bareAmp = 0
  // Raw <code>/<pre> nesting depth — while inside, escaped-tag detection
  // is suspended (see failure mode 5 above).
  let codeDepth = 0

  // Trailing `\/?` so self-closing junk (<br/>, <br />) is diagnosed as an
  // unsupported tag rather than a bare "<".
  const tag = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^<>]*)?\/?>/
  const entity = /^&(?:amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);/
  // `&lt;` immediately followed by a tag name and closed by `&gt;` on the
  // same line. `[^<>\n]*?` keeps the span from swallowing raw tags. Only
  // DETECTS — consumption stays with the normal entity branch below.
  const escapedTag = /^&lt;(\/?)([a-zA-Z][a-zA-Z0-9-]*)[^<>\n]*?&gt;/

  let i = 0
  while (i < message.length) {
    const ch = message[i]
    if (ch === '<') {
      const m = tag.exec(message.slice(i))
      if (!m) {
        bareLt++
        i++
        continue
      }
      const closing = m[1] === '/'
      const name = m[2].toLowerCase()
      if (!ALLOWED.has(name)) {
        unsupported.add(name)
      } else if (closing) {
        if (stack.length > 0 && stack[stack.length - 1] === name) {
          stack.pop()
          if (name === 'code' || name === 'pre') codeDepth = Math.max(0, codeDepth - 1)
        } else orphanClose.add(name)
      } else {
        stack.push(name)
        if (name === 'code' || name === 'pre') codeDepth++
      }
      i += m[0].length
      continue
    }
    if (ch === '&') {
      const em = codeDepth === 0 ? escapedTag.exec(message.slice(i)) : null
      if (em && ESCAPED_TAG_INTENT.has(em[2].toLowerCase())) {
        escapedTags.add(`&lt;${em[1]}${em[2]}&gt;`)
        escapedCount++
      }
      const m = entity.exec(message.slice(i))
      if (!m) {
        bareAmp++
        i++
        continue
      }
      i += m[0].length
      continue
    }
    i++
  }

  const hard: string[] = []
  if (escapedCount > 0) {
    hard.push(
      `Entity-escaped formatting tag(s) ×${escapedCount}: ${[...escapedTags].join(' ')}. Telegram delivers these as LITERAL text — the user sees "<b>" instead of bold. Write the real raw characters: <b>bold</b>, never &lt;b&gt;bold&lt;/b&gt;. Entities are ONLY for a literal < or & in prose; to display a tag as text on purpose, wrap it in <code>…</code>.`
    )
  }
  if (unsupported.size > 0) {
    hard.push(
      `Unsupported tag(s): ${[...unsupported].map((t) => `<${t}>`).join(', ')}. Telegram allows ONLY: ${TELEGRAM_ALLOWED_TAGS.map((t) => `<${t}>`).join(', ')}. Remove them or use a real newline instead of <br>/<p>.`
    )
  }
  if (stack.length > 0) {
    const counts = stack.reduce<Record<string, number>>((acc, t) => {
      acc[t] = (acc[t] ?? 0) + 1
      return acc
    }, {})
    hard.push(
      `Unclosed tag(s): ${Object.entries(counts)
        .map(([t, c]) => (c > 1 ? `<${t}>×${c}` : `<${t}>`))
        .join(', ')}. Every open tag needs a matching close.`
    )
  }
  if (orphanClose.size > 0) {
    hard.push(
      `Closing tag(s) with no matching open: ${[...orphanClose].map((t) => `</${t}>`).join(', ')}.`
    )
  }
  if (bareLt > 0) {
    hard.push(`${bareLt} bare "<" not starting a valid tag — write a literal less-than as &lt;.`)
  }
  if (bareAmp > 0) {
    hard.push(`${bareAmp} bare "&" not part of an entity — write a literal ampersand as &amp;.`)
  }
  const masked = maskCodeSpans(message)
  const bars = findDividerBars(masked)
  if (bars.length > 0) {
    hard.push(
      `Decorative divider line(s) ${bars.join(' ')} — a phone's narrow bubble wraps these into several broken lines of bar characters. Delete them: a blank line separates sections, and an emoji + <b>bold</b> line is the header.`
    )
  }

  // Leaked Markdown parses fine as HTML but Telegram renders NO Markdown — the
  // raw symbols reach the user, so these are HARD: the send gates refuse the
  // message and the model rewrites its own text in Telegram HTML (sendAsIs is
  // the deliberate escape hatch when the markup IS the content; RejectBudget
  // still guarantees delivery if the model can't converge). Checks run on the
  // code-span-masked text — quoting Markdown inside <code>/<pre> is
  // intentional display, never a leak. The ** and lookaround guards keep
  // prose like "x**2 + y**2" or "f(**kwargs)" legal: real Markdown bold hugs
  // non-space text and is not glued to a word character on the outside.
  if (/(?<![\w*])\*\*(?!\s)[^*\n]+?(?<!\s)\*\*(?![\w*])/.test(masked)) {
    hard.push('Markdown **bold** — Telegram shows the asterisks literally. Use <b>bold</b>.')
  }
  if (/^\s{0,3}#{1,6}\s+\S/m.test(masked)) {
    hard.push('Markdown "# heading" — Telegram has no headings. Use a short <b>bold</b> line.')
  }
  if (/!?\[[^\]\n]*\]\((?!wolffish-media:\/\/)[^)\s]+\)/.test(masked)) {
    hard.push('Markdown [text](url) link — Telegram shows it raw. Use <a href="url">text</a>.')
  }
  if (/^\s*\|.*\|.*$/m.test(masked) || /\|\s*:?-{2,}/.test(masked)) {
    hard.push(
      'Markdown | table | — Telegram has no tables. Use one "<b>Label:</b> value" line per fact.'
    )
  }
  if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/m.test(masked)) {
    hard.push('Markdown "---" rule — Telegram shows it raw. Use a blank line to separate sections.')
  }

  // Reserved for delivered-with-a-note cosmetics (WhatsApp keeps its ```lang
  // check here). Telegram currently has none: every leak class above either
  // breaks the HTML parse or shows raw symbols, so all of it refuses the send.
  const soft: string[] = []

  const issues = [...hard, ...soft]
  return { ok: issues.length === 0, issues, hard, soft }
}

const LRM = '\u200E'
const RLM = '\u200F'
const RTL_SCRIPT =
  /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0780-\u07BF\uFB50-\uFDFF\uFE70-\uFEFF]/
const LTR_SCRIPT = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u1E00-\u1EFF]/

/**
 * Return a zero-width Unicode directional mark matching the first
 * strong character in `text`. Prepending this to a Telegram message
 * forces the correct paragraph direction regardless of the client's
 * UI locale — without it, RTL clients can reorder LTR text around
 * punctuation (e.g. "Hey! What's up?" → "! What's up?Hey").
 *
 * ⚠️ BREAKING CHANGE RISK: the invisible mark becomes the first
 * character of every outgoing message. Anything downstream that
 * compares, hashes, or parses the raw message text (e.g. reply
 * matching, dedup, or Telegram's own /command detection) may break
 * if it doesn't expect a leading zero-width char.
 */
export function bidiMark(text: string): string {
  for (const ch of text) {
    if (RTL_SCRIPT.test(ch)) return RLM
    if (LTR_SCRIPT.test(ch)) return LRM
  }
  return ''
}
