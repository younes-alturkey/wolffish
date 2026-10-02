/**
 * Channel-shared plain-text helpers.
 *
 * The model writes channel-native formatting itself (see CHANNEL_PROMPTS
 * in runtime/prefrontal.ts) and its prose is sent verbatim — there is no
 * Markdown converter between the model and any channel. What remains here
 * is for CODE-composed surfaces only: tool output and system reports that
 * are themselves Markdown and need to be flattened to readable plain text
 * before a channel embeds them (Telegram wraps tool results in <pre>,
 * which renders every byte literally; WhatsApp has no renderer at all).
 */

/**
 * A "divider bar" line: nothing but repeated bar/dash characters — the
 * decorative section separators models love to draw (━━━━━, ═════, ─────,
 * -----, _____, ▬▬▬▬▬, • • • • •, Arabic ـــــ tatweel runs). Chat
 * bubbles are narrow: on a phone these wrap into several broken lines of
 * bar characters, so the channel overlays forbid them and both pre-send
 * gates reject them (code spans are exempt at the call sites — quoted CLI
 * output legitimately contains long box-drawing runs). Six or more bar
 * characters counts as a bar; short expressive runs ("---", "——") stay
 * below the threshold. Block Elements (▓ ░ █ and friends) are NOT bar
 * characters: a run of them is a progress bar — content, not decoration —
 * and passes even without a label.
 */
// Bar characters: ASCII rule chars, middle dot U+00B7, Arabic tatweel
// U+0640, en/em/horizontal-bar dashes U+2013–U+2015, bullet U+2022,
// minus U+2212, horizontal line extension U+23AF, box drawing
// U+2500–U+257F, geometric shapes U+25A0–U+25FF, wavy dashes
// U+3030/U+FE4F. Block Elements U+2580–U+259F (▓ ░ █) are deliberately
// excluded — that's the progress-bar alphabet.
const DIVIDER_BAR_LINE = /^[ \t]*(?:[-=_~*#+·ـ–-―•−⎯─-╿■-◿〰﹏][ \t]*){6,}$/

/**
 * Return up to three distinct divider-bar lines found in `text`, quoted
 * and truncated for use in a gate's issue message. Empty array = clean.
 */
export function findDividerBars(text: string): string[] {
  const bars: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!DIVIDER_BAR_LINE.test(line)) continue
    const bar = line.trim()
    const sample = `"${bar.length > 12 ? bar.slice(0, 12) + '…' : bar}"`
    if (!bars.includes(sample)) bars.push(sample)
    if (bars.length >= 3) break
  }
  return bars
}

/**
 * Strip Markdown markup, keep the underlying text. Used for tool
 * results and system reports (e.g. insula /status) whose output is
 * itself Markdown — leaving `**bold**` and `## heading` intact would
 * surface the raw syntax in the user's chat. Plain shell/data output
 * without markup passes through unchanged.
 */
export function markdownToPlain(text: string): string {
  return text
    .replace(/```[A-Za-z0-9_+-]*\n?([\s\S]*?)```/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/gm, '$1')
    .replace(/^([ \t]*)[*+-][ \t]+/gm, '$1• ')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, '$1')
    .replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, '$1')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
    .replace(/^>[ \t]?/gm, '')
}
