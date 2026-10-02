/**
 * Tests for the channel text helpers that remain after the egress
 * Markdown converters were removed (the model now writes channel-native
 * formatting itself — CHANNEL_PROMPTS in runtime/prefrontal.ts — and its
 * prose is sent verbatim). What still transforms text, and is covered
 * here, only touches CODE-composed surfaces:
 *
 *  - markdownToPlain (channels/format.ts): flattens Markdown-shaped tool
 *    output / system reports before a channel embeds them.
 *  - stripInlineMarkup (channels/whatsapp/format.ts): flattens labels
 *    embedded inside the WhatsApp ask-card's own *bold* wrappers.
 *  - escapeHtml + bidiMark (channels/telegram/format.ts): entity escaping
 *    for code-composed Telegram HTML, and the RTL/LTR direction mark.
 *
 * All modules are pure (no electron imports), so this runs standalone.
 * Run: npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/channel-format.test.ts
 */

import { markdownToPlain } from '../format'
import { bidiMark, escapeHtml, validateTelegramHtml } from '../telegram/format'
import { MAX_CONSECUTIVE_REJECTS, RejectBudget } from '../send-policy'
import { stripInlineMarkup, validateWhatsAppFormat } from '../whatsapp/format'

let passed = 0
let failed = 0
function eq(label: string, actual: string, expected: string): void {
  if (actual === expected) {
    passed++
    return
  }
  failed++
  console.error(
    `FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`
  )
}
function ok(label: string, actual: boolean, expected: boolean): void {
  if (actual === expected) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}\n  expected ok=${expected}, got ok=${actual}`)
}

// --- markdownToPlain ---

eq('plain text untouched', markdownToPlain('exit code 0\nall good'), 'exit code 0\nall good')
eq('heading flattened', markdownToPlain('## Boarding details'), 'Boarding details')
eq('bold stripped', markdownToPlain('**Terminal 1** at RUH'), 'Terminal 1 at RUH')
eq('underscore bold stripped', markdownToPlain('__very__ important'), 'very important')
eq('italic stripped', markdownToPlain('that is *tomorrow* morning'), 'that is tomorrow morning')
eq('snake_case preserved', markdownToPlain('use turn_scope here'), 'use turn_scope here')
eq('arithmetic preserved', markdownToPlain('2 * 3 = 6 and 2*3=6'), '2 * 3 = 6 and 2*3=6')
eq('inline code unwrapped', markdownToPlain('run `npm i` now'), 'run npm i now')
eq('fence unwrapped', markdownToPlain('```python\nprint(1)\n```'), 'print(1)\n')
eq('bullets normalized', markdownToPlain('- a\n* b\n+ c'), '• a\n• b\n• c')
eq('link flattened', markdownToPlain('[docs](https://x.example)'), 'docs (https://x.example)')
eq('quote unwrapped', markdownToPlain('> gate closes 08:20'), 'gate closes 08:20')

// --- stripInlineMarkup (WhatsApp ask-card labels) ---

eq('bold marker stripped', stripInlineMarkup('**Use the fast path**'), 'Use the fast path')
eq('whatsapp bold stripped', stripInlineMarkup('*Yes*'), 'Yes')
eq('mixed markers stripped', stripInlineMarkup('_prefer_ `code` ~~old~~'), 'prefer code old')
eq('snake_case survives', stripInlineMarkup('keep turn_scope name'), 'keep turn_scope name')
eq(
  'link collapses to label (url)',
  stripInlineMarkup('[check-in](https://a.example)'),
  'check-in (https://a.example)'
)

// --- escapeHtml (Telegram code-composed surfaces) ---

eq('escapes the three entities', escapeHtml('a < b && c > d'), 'a &lt; b &amp;&amp; c &gt; d')
eq('plain text untouched by escape', escapeHtml('hello world'), 'hello world')

// --- bidiMark (Telegram paragraph direction) ---

eq('ltr text gets LRM', bidiMark('Hey! What is up?'), '\u200E')
eq('rtl text gets RLM', bidiMark('مرحبا بك'), '\u200F')
eq('leading punctuation skipped', bidiMark('«مرحبا»'), '\u200F')
eq('digits-only gets no mark', bidiMark('42'), '')

// --- validateTelegramHtml (the telegram_check_format engine) ---

// The exact heartbeat failure: a stray </message> wrapper tag.
ok('stray wrapper tag is invalid', validateTelegramHtml('<b>Total</b> 😄</message>').ok, false)
ok(
  'valid subset passes',
  validateTelegramHtml('<b>Digest</b>\n<i>2 unread</i> cost &lt;5').ok,
  true
)
ok('plain text passes', validateTelegramHtml('just plain text, nothing to parse').ok, true)
ok(
  'link with href passes',
  validateTelegramHtml('see <a href="https://x.example">docs</a>').ok,
  true
)
ok('spoiler span passes', validateTelegramHtml('<span class="tg-spoiler">boo</span>').ok, true)
ok('unclosed tag is invalid', validateTelegramHtml('<b>bold with no close').ok, false)
ok('orphan closing tag is invalid', validateTelegramHtml('text </i> more').ok, false)
ok('leaked block tags invalid', validateTelegramHtml('<p>hi</p><br>').ok, false)
ok('bare ampersand is invalid', validateTelegramHtml('Tom & Jerry').ok, false)
ok('bare less-than is invalid', validateTelegramHtml('2 < 3 rule').ok, false)
ok('bare greater-than is fine', validateTelegramHtml('5 > 3 rule').ok, true)
// Leaked Markdown parses as HTML but renders raw on Telegram — also flagged.
ok('markdown bold flagged on telegram', validateTelegramHtml('**Digest**').ok, false)
ok('markdown heading flagged on telegram', validateTelegramHtml('# Digest\nbody').ok, false)
ok(
  'markdown link flagged on telegram',
  validateTelegramHtml('see [docs](https://x.example)').ok,
  false
)
ok('media marker fine on telegram', validateTelegramHtml('![m](wolffish-media://a.png)').ok, true)
ok('self-closing br is invalid', validateTelegramHtml('a<br/>b').ok, false)
// The reported problem is named in the issues so the model can self-correct.
eq(
  'stray tag issue names it',
  validateTelegramHtml('x</message>').issues.some((s) => s.includes('<message>'))
    ? 'named'
    : 'missing',
  'named'
)

// Entity-escaped formatting tags: Telegram delivers them as literal "<b>"
// text (no API error), so only this semantic check can catch them. The
// 16:15 email-digest heartbeat shipped exactly this and telegram_check_format
// said "valid".
ok(
  'escaped formatting tags invalid (the digest failure)',
  validateTelegramHtml(
    '📬 &lt;b&gt;alturkeyy@gmail.com&lt;/b&gt; — 1 unread thread\n&lt;i&gt;From: someone&lt;/i&gt;\n&lt;b&gt;No action required.&lt;/b&gt;'
  ).ok,
  false
)
ok('escaped bold pair invalid', validateTelegramHtml('&lt;b&gt;Digest&lt;/b&gt;').ok, false)
ok('escaped closing tag alone invalid', validateTelegramHtml('x &lt;/i&gt; y').ok, false)
ok('escaped br invalid', validateTelegramHtml('line&lt;br&gt;line').ok, false)
ok(
  'escaped a-href invalid',
  validateTelegramHtml('&lt;a href="https://x.example"&gt;docs&lt;/a&gt;').ok,
  false
)
// Inside a real <code>/<pre> span, escaped tags are the CORRECT way to
// display a tag on purpose — exempt.
ok(
  'escaped tag inside <code> passes',
  validateTelegramHtml('use <code>&lt;b&gt;</code> for bold').ok,
  true
)
ok(
  'escaped tags inside <pre> pass',
  validateTelegramHtml('<pre>&lt;b&gt;bold&lt;/b&gt;</pre>').ok,
  true
)
// Escaped NON-formatting tag names render literally too, but that is the
// plausible intent — only formatting-tag names are flagged. Sharing HTML
// code as content must never be blocked.
ok('escaped unknown tag passes', validateTelegramHtml('the &lt;message&gt; wrapper').ok, true)
ok(
  'escaped html snippet in prose passes',
  validateTelegramHtml('try &lt;div class="x"&gt;hi&lt;/div&gt; instead').ok,
  true
)
ok(
  'escaped html document inside <pre> passes',
  validateTelegramHtml(
    '<pre>&lt;html&gt;&lt;body&gt;&lt;b&gt;hi&lt;/b&gt;&lt;/body&gt;&lt;/html&gt;</pre>'
  ).ok,
  true
)
ok('plain prose entities pass', validateTelegramHtml('cost &lt;5 &amp; rising').ok, true)
eq(
  'escaped tag issue teaches raw tags',
  validateTelegramHtml('&lt;b&gt;x&lt;/b&gt;').issues.some((s) => s.includes('raw characters'))
    ? 'taught'
    : 'missing',
  'taught'
)
// hard/soft split: send tools refuse hard, deliver-and-note soft. Markdown
// is HARD — Telegram renders none of it, so the raw symbols would reach the
// user (the 00:14 flight-tracking narration shipped exactly this); the gate
// refuses and the model rewrites (sendAsIs = the intentional-content escape).
ok('escaped tags are hard', validateTelegramHtml('&lt;b&gt;x&lt;/b&gt;').hard.length > 0, true)
ok('unclosed tag is hard', validateTelegramHtml('<b>x').hard.length > 0, true)
ok('markdown bold is hard', validateTelegramHtml('**x** ok').hard.length === 1, true)
ok('markdown bold leaves soft empty', validateTelegramHtml('**x** ok').soft.length === 0, true)
ok(
  'the flight-narration leak shape is hard',
  validateTelegramHtml('Key findings:\n- **Departed**: 10:23 PM (18 min late)').hard.length > 0,
  true
)
ok('markdown heading is hard', validateTelegramHtml('# Digest\nbody').hard.length > 0, true)
ok(
  'markdown link is hard',
  validateTelegramHtml('see [docs](https://x.example)').hard.length > 0,
  true
)
ok(
  'markdown table is hard',
  validateTelegramHtml('| item | price |\n| a | 5 |').hard.length > 0,
  true
)
ok('markdown hr is hard', validateTelegramHtml('above\n---\nbelow').hard.length > 0, true)
// Plain "- " bullets are legal Telegram text (the overlay teaches them) —
// only the Markdown markers inside them are the leak.
ok('plain dash bullets pass', validateTelegramHtml('- Departed: 10:23 PM\n- Seat: 18E').ok, true)
// Legit double-asterisk prose is not Markdown bold: exponents and **kwargs
// hug word characters on the outside, real bold never does.
ok('exponent x**2 passes', validateTelegramHtml('x**2 + y**2 = z**2').ok, true)
ok('python kwargs pass', validateTelegramHtml('call f(**kwargs) and g(**opts)').ok, true)
// Quoting Markdown inside <code>/<pre> is intentional display — exempt.
ok('markdown inside <code> passes', validateTelegramHtml('<code>**x**</code> is bold').ok, true)
ok(
  'markdown inside <pre> passes',
  validateTelegramHtml('<pre># heading\n**bold** [a](b)</pre>').ok,
  true
)
ok(
  'media marker not flagged on telegram',
  validateTelegramHtml('![meme](wolffish-media://a.png)').ok,
  true
)

// Decorative divider-bar lines are perfectly valid HTML but a phone's
// narrow bubble wraps them into several broken lines of bar characters —
// hard. The 19:34 security-audit report shipped exactly this and
// telegram_check_format said "valid".
ok(
  'divider bar lines invalid (the audit failure)',
  validateTelegramHtml('━━━━━━━━━━━━━━━━━━━━━━\n🟢 <b>LOW</b>\n━━━━━━━━━━━━━━━━━━━━━━').ok,
  false
)
ok('divider bar is hard', validateTelegramHtml('══════════\n<b>SUMMARY</b>').hard.length > 0, true)
ok('em-dash bar is hard', validateTelegramHtml('——————————').hard.length > 0, true)
ok('tatweel bar is hard', validateTelegramHtml('ــــــــــ\nمرحبا').hard.length > 0, true)
ok('short dash run in prose passes', validateTelegramHtml('scores: —— pending').ok, true)
ok(
  'box-drawn table inside <pre> passes',
  validateTelegramHtml('<pre>┌────────────┐\n│ a          │\n└────────────┘</pre>').ok,
  true
)
eq(
  'divider issue teaches the blank line',
  validateTelegramHtml('━━━━━━━━━━').issues.some((s) => s.includes('blank line'))
    ? 'taught'
    : 'missing',
  'taught'
)
ok('bare progress bar passes on telegram', validateTelegramHtml('▓▓▓▓▓▓░░░░').ok, true)

// --- RejectBudget (the send tools' never-lose-a-message guarantee) ---

{
  let t = 1_000_000
  const budget = new RejectBudget(() => t)
  ok('fresh chat has budget', budget.exhausted(1), false)
  budget.reject(1)
  ok('one bounce leaves budget', budget.exhausted(1), false)
  budget.reject(1)
  ok(`${MAX_CONSECUTIVE_REJECTS} bounces exhaust it — gate must yield`, budget.exhausted(1), true)
  ok('other chats unaffected', budget.exhausted(2), false)
  budget.delivered(1)
  ok('a successful send resets it', budget.exhausted(1), false)
  budget.reject(1)
  budget.reject(1)
  t += 16 * 60 * 1000
  ok('stale bounces expire after the window', budget.exhausted(1), false)
}

// --- validateWhatsAppFormat (the whatsapp_check_format engine) ---

ok('markdown bold flagged', validateWhatsAppFormat('**Order arrived**').ok, false)
ok('whatsapp bold passes', validateWhatsAppFormat('*Order arrived* _53 SAR_').ok, true)

// WhatsApp renders NO HTML — tags and entities arrive as literal text.
// The cross-channel confusion class (Telegram HTML or a serializer quirk
// escaping angle brackets) is hard; the send tools refuse it.
ok('html tags flagged on whatsapp', validateWhatsAppFormat('<b>Order arrived</b>').ok, false)
ok('html tags are hard', validateWhatsAppFormat('<b>x</b>').hard.length > 0, true)
ok(
  'html entities flagged on whatsapp',
  validateWhatsAppFormat('save 20% &amp; more &lt;3').ok,
  false
)
ok('html entities are hard', validateWhatsAppFormat('Tom &amp; Jerry').hard.length > 0, true)
ok(
  'escaped-tag soup flagged on whatsapp too',
  validateWhatsAppFormat('&lt;b&gt;Digest&lt;/b&gt;').ok,
  false
)
// Everyday angle-bracket text is NOT html — never block real prose.
ok('email in angle brackets passes', validateWhatsAppFormat('From: Foo <foo@bar.com>').ok, true)
ok('heart and comparisons pass', validateWhatsAppFormat('i <3 u, and 2 < 3 & 5 > 4').ok, true)
ok('unknown tag-like token passes', validateWhatsAppFormat('the <thing> placeholder').ok, true)
// Inside `backticks` or ``` fences, showing markup is the point.
ok('html inside inline code passes', validateWhatsAppFormat('use `<b>` on telegram').ok, true)
ok(
  'html inside fence passes',
  validateWhatsAppFormat('```\n<div class="x">&amp;</div>\n```').ok,
  true
)
ok(
  'markdown inside fence passes',
  validateWhatsAppFormat('```\n**not markdown, just code**\n```').ok,
  true
)
// Markdown is HARD on WhatsApp too — nothing renders it, the raw symbols
// would reach the recipient; the gate refuses and the model rewrites.
ok('markdown bold is hard', validateWhatsAppFormat('**x** ok').hard.length === 1, true)
ok('markdown bold leaves soft empty', validateWhatsAppFormat('**x** ok').soft.length === 0, true)
ok('double-underscore bold is hard', validateWhatsAppFormat('__very__ bold').hard.length > 0, true)
// Deliberate tradeoff: a bare dunder name reads as Markdown __bold__ and
// bounces — the fix the gate teaches (`__init__` in backticks) is also the
// better phone rendering.
ok('bare dunder bounces', validateWhatsAppFormat('call __init__ now').hard.length > 0, true)
ok('backticked dunder passes', validateWhatsAppFormat('call `__init__` now').ok, true)
ok('exponent x**2 passes on whatsapp', validateWhatsAppFormat('x**2 + y**2').ok, true)
ok('heading flagged', validateWhatsAppFormat('# Digest\nbody').ok, false)
ok('markdown link flagged', validateWhatsAppFormat('see [docs](https://x.example)').ok, false)
ok('bare url passes', validateWhatsAppFormat('see https://x.example').ok, true)
ok('media marker not flagged', validateWhatsAppFormat('![meme](wolffish-media://a.png)').ok, true)
ok('table flagged', validateWhatsAppFormat('| item | price |\n| a | 5 |').ok, false)
ok('hr flagged', validateWhatsAppFormat('above\n---\nbelow').ok, false)
ok('lang fence flagged', validateWhatsAppFormat('```python\nprint(1)\n```').ok, false)
ok('bare fence passes', validateWhatsAppFormat('```\nprint(1)\n```').ok, true)

// Divider bars: plain text, but they wrap into broken bar lines on a
// phone — hard, same as on Telegram.
ok('divider bar flagged on whatsapp', validateWhatsAppFormat('━━━━━━━━━━\n*HIGH*').ok, false)
ok('divider bar is hard on whatsapp', validateWhatsAppFormat('━━━━━━━━━━\nx').hard.length > 0, true)
ok(
  'long dash rule is hard on whatsapp',
  validateWhatsAppFormat('------------------------\nfindings').hard.length > 0,
  true
)
ok(
  'short md hr is hard too (markdown rule)',
  validateWhatsAppFormat('above\n---\nbelow').hard.length > 0,
  true
)
ok('spaced bullet bar is hard', validateWhatsAppFormat('• • • • • •').hard.length > 0, true)
ok('bars inside a fence pass', validateWhatsAppFormat('```\n━━━━━━━━━━\n```').ok, true)
ok('progress bar with label passes', validateWhatsAppFormat('▓▓▓▓▓▓░░░░ 60%').ok, true)
// Block Elements are the progress-bar alphabet, not divider decoration —
// a bare bar passes too (the label is style, not a gate requirement).
ok('bare progress bar passes', validateWhatsAppFormat('▓▓▓▓▓▓░░░░').ok, true)
ok('full-block bar passes', validateWhatsAppFormat('██████████').ok, true)

const total = passed + failed
console.log(`${passed}/${total} passed`)
if (failed > 0) process.exit(1)
