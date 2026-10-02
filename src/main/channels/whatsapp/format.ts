/**
 * WhatsApp-specific text helpers.
 *
 * There is deliberately NO Markdown→WhatsApp converter here. The model
 * is taught to write WhatsApp's own formatting directly (CHANNEL_PROMPTS
 * in runtime/prefrontal.ts) and its prose is sent verbatim — the model
 * is the formatter, not this module. What remains is one helper for the
 * channel's CODE-composed surfaces.
 */

import { findDividerBars } from '../format'

/**
 * Strip inline markup markers, keep the text. Used for model-authored
 * strings the channel embeds inside its own WhatsApp `*bold*` wrapper
 * (ask-card questions and option labels) — a stray asterisk or
 * underscore inside the span would break the wrapper or fight it, so
 * the label is flattened to plain text first. Links collapse to
 * "label (url)".
 */
export function stripInlineMarkup(s: string): string {
  return s
    .replace(/!?\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_, label, url) =>
      label && label !== url ? `${label} (${url})` : url
    )
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, '$1')
    .replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .trim()
}

export type WhatsAppFormatReport = {
  ok: boolean
  /** All problems, hard first — what `whatsapp_check_format` lists. */
  issues: string[]
  /**
   * The message would reach the recipient visibly wrong: HTML tags or
   * entities, which WhatsApp NEVER parses — they arrive as literal
   * "<b>" / "&amp;" text — a decorative divider-bar line that wraps
   * into several broken lines of bar characters on a phone, or leaked
   * Markdown (**bold**, __bold__, # headings, [text](url), | tables |,
   * --- rules), whose raw symbols WhatsApp shows as-is. Send tools
   * refuse to send while any exist; the model rewrites its own text
   * (sendAsIs is the escape hatch for markup that IS the content, and
   * RejectBudget still force-delivers after repeated bounces so a
   * message is never lost). Quoting inside `backticks`/``` is exempt.
   */
  hard: string[]
  /**
   * Delivered with a note on the send result instead of blocking —
   * cosmetic-only findings (currently just the ```lang fence tag).
   */
  soft: string[]
}

/**
 * Blank the CONTENT of ``` fences and `inline code` spans (markers stay,
 * length preserved) — quoting HTML or Markdown inside a code span is
 * intentional display, so checks must not fire on it. ``` pairs first
 * (their content may contain single backticks), then ` spans.
 */
function maskCodeSpans(message: string): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ')
  return message
    .replace(/```[\s\S]*?```/g, (m) => '```' + blank(m.slice(3, -3)) + '```')
    .replace(/`[^`\n]+`/g, (m) => '`' + blank(m.slice(1, -1)) + '`')
}

/**
 * Tag names a model plausibly emits when it confuses WhatsApp with an
 * HTML channel (Telegram's subset + common document HTML). Only these
 * count as "an HTML tag" — angle-bracket text like an email address
 * (<foo@bar.com>) or "<3" never matches.
 */
const HTML_TAG = new RegExp(
  '</?(?:b|strong|i|em|u|ins|s|strike|del|a|code|pre|blockquote|span|br|p|div|ul|ol|li|h[1-6]|table|tr|td|th|html|body|tg-spoiler)(?:\\s[^<>\\n]*)?/?>',
  'gi'
)
const HTML_ENTITY = /&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/g

/**
 * Validate a message against WhatsApp's own formatting WITHOUT sending it —
 * the engine behind the `whatsapp_check_format` tool and the pre-send gate
 * in the send tools. WhatsApp never rejects a message, so nothing here is
 * about the API; it's about what the recipient SEES. This does NOT rewrite
 * anything (the model is the formatter). Hard: HTML tags/entities —
 * WhatsApp parses no HTML, so `<b>` and `&amp;` arrive as literal text
 * (the cross-channel confusion class) — decorative divider-bar lines
 * (━━━━━, ═════, -----), which a phone's narrow bubble wraps into several
 * broken lines of bar characters, and leaked Markdown (**bold**,
 * __bold__, # headings, [text](url), | tables |, --- rules), shown as
 * raw symbols. Soft: cosmetic-only findings (the ```lang fence tag).
 * All classes are exempt inside ``` fences and `inline code` spans,
 * where showing markup is the point. WhatsApp's real syntax is
 * single-char: *bold* _italic_ ~strike~ `code` ```block``` ,
 * "- "/"1. " lists, "> " quotes — those are fine.
 */
export function validateWhatsAppFormat(message: string): WhatsAppFormatReport {
  const masked = maskCodeSpans(message)
  const hard: string[] = []
  const soft: string[] = []

  const sample = (matches: RegExpMatchArray | null): string =>
    [...new Set(matches ?? [])].slice(0, 4).join(' ')

  const tags = masked.match(HTML_TAG)
  if (tags && tags.length > 0) {
    hard.push(
      `HTML tag(s) ${sample(tags)}: WhatsApp renders NO HTML — they reach the recipient as literal text. Use WhatsApp markup instead: *bold* _italic_ ~strike~. To show a tag as text on purpose, wrap it in \`backticks\`.`
    )
  }
  const entities = masked.match(HTML_ENTITY)
  if (entities && entities.length > 0) {
    hard.push(
      `HTML entities ${sample(entities)}: WhatsApp shows them literally — the recipient sees "&amp;", not "&". Write the plain & < > characters themselves.`
    )
  }
  const bars = findDividerBars(masked)
  if (bars.length > 0) {
    hard.push(
      `Decorative divider line(s) ${bars.join(' ')} — a phone's narrow bubble wraps these into several broken lines of bar characters. Delete them: a blank line separates sections, and an emoji + *bold* line is the header.`
    )
  }

  // Leaked Markdown — WhatsApp renders none of it, so the raw symbols would
  // reach the recipient. HARD: the send gates refuse the message and the
  // model rewrites its own text in WhatsApp markup (sendAsIs is the escape
  // hatch when the markup IS the content; RejectBudget still guarantees
  // delivery if the model can't converge). All checks run on the code-span-
  // masked text — quoting Markdown inside `backticks` / ``` fences is
  // intentional display. The lookaround guards keep "x**2 + y**2",
  // "f(**kwargs)" and mid-word underscores legal: real Markdown emphasis
  // hugs non-space text and is not glued to a word character on the outside.
  if (/(?<![\w*])\*\*(?!\s)[^*\n]+?(?<!\s)\*\*(?![\w*])/.test(masked)) {
    hard.push(
      'Markdown **bold** (double asterisks) — WhatsApp bold is a SINGLE *asterisk*: *bold*.'
    )
  }
  if (/(?<![\w_])__(?!\s)[^_\n]+?(?<!\s)__(?![\w_])/.test(masked)) {
    hard.push(
      'Markdown __bold__ (double underscores) — WhatsApp italic is a SINGLE _underscore_: _italic_. To show a literal dunder name like __init__, wrap it in `backticks`.'
    )
  }
  if (/^\s{0,3}#{1,6}\s+\S/m.test(masked)) {
    hard.push('Markdown "# heading" — WhatsApp has no headings. Use a short *bold* line instead.')
  }
  // [text](url) links — but NOT the allowed ![alt](wolffish-media://…) image marker.
  if (/!?\[[^\]\n]*\]\((?!wolffish-media:\/\/)[^)\s]+\)/.test(masked)) {
    hard.push(
      'Markdown [text](url) link — WhatsApp shows it raw. Paste the bare URL; WhatsApp auto-links it.'
    )
  }
  if (/^\s*\|.*\|.*$/m.test(masked) || /\|\s*:?-{2,}/.test(masked)) {
    hard.push(
      'Markdown | table | — WhatsApp has no tables. Write one "*Label:* value" line per fact.'
    )
  }
  if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/m.test(masked)) {
    hard.push(
      'Markdown "---" horizontal rule — WhatsApp shows it raw. Use a blank line to separate sections.'
    )
  }
  // Runs on the ORIGINAL — the lang tag sits inside the fence content the
  // mask blanks out.
  if (/```[^\s`]+/.test(message)) {
    soft.push(
      'A language tag after ``` — WhatsApp shows the tag as text. Use a bare ``` fence with no language.'
    )
  }

  const issues = [...hard, ...soft]
  return { ok: issues.length === 0, issues, hard, soft }
}
