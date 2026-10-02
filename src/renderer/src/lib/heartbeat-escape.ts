/**
 * Write-time escape for automation prompt bodies headed into heartbeat.md.
 *
 * Three kinds of line carry structural meaning no block body can hold: a
 * `## ` line ENDS the block in every parser of this file (the engine's
 * collectBody, this page's scan, the phone's port) — pasting a prompt with
 * its own `## Prompt` section silently truncated everything after it; a
 * dashed separator line is dropped wholesale; and HTML comment tokens are
 * the on/off wrapper — a stray `<!--` swallows every automation below it
 * from the scheduler's view, and a stray `-->` would cut the wrapper short
 * the day the automation is switched off. Rather than losing user text to
 * any of these, respell each in the closest form every parser already reads
 * as plain body content: one leading space for the line-anchored rules (all
 * of them are anchored at column 0), one inner space for the comment tokens
 * (the engine's comment strip is position-independent, so a prefix cannot
 * defuse those).
 *
 * A byte-for-byte port of the phone's escape (wolffish-mobile
 * src/lib/automations/heartbeat.ts) so every draft editor writes the same
 * safe spelling. Only WRITTEN bytes change — parsing stays identical on all
 * sides. Idempotent, so re-saving a parsed body never grows.
 */
export function escapePromptBody(text: string): string {
  return text
    .split('<!--')
    .join('< !--')
    .split('-->')
    .join('-- >')
    .split('\n')
    .map((line) => (/^##\s/.test(line) || /^---+\s*$/.test(line) ? ` ${line}` : line))
    .join('\n')
}
