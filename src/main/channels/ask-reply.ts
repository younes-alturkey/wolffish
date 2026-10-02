/**
 * Shared interpretation of a user's reply to an ask_user question on a
 * text-only channel (Telegram / WhatsApp), where the answer arrives as the
 * next plain message rather than a dedicated UI action.
 *
 * The contract the user is told ("reply with a number, or type your own
 * instructions") is encoded here once so both channels behave identically:
 *  - a message that is ENTIRELY a number in 1–optionCount picks that option;
 *  - a bare number outside that range is treated as a misclick → reprompt,
 *    NOT as free text (sending "7" to the model as instructions is never what
 *    the user meant);
 *  - anything else is the free-text "something else" answer when allowOther
 *    is set, otherwise a reprompt.
 *
 * Crucially the number match is STRICT (the whole trimmed message must be the
 * number) so a custom instruction that merely contains a digit — "do option 3
 * but cheaper" — is read as text, not as picking option 3.
 */

export type AskReplyOutcome =
  | { kind: 'option'; index: number }
  | { kind: 'custom'; text: string }
  | { kind: 'reprompt'; reason: 'out-of-range' | 'need-number' }

/** Strict pure-number parse: the whole trimmed string must be 1–2 digits. */
export function parseAskNumber(text: string): number | null {
  const m = /^\s*(\d{1,2})\s*$/.exec(text)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return Number.isFinite(n) ? n : null
}

export function interpretAskReply(
  text: string,
  optionCount: number,
  allowOther: boolean
): AskReplyOutcome {
  const trimmed = text.trim()
  const num = parseAskNumber(trimmed)

  if (num !== null && num >= 1 && num <= optionCount) {
    return { kind: 'option', index: num - 1 }
  }
  if (num !== null) {
    // A whole-message number, just out of range — a misclick, not instructions.
    return { kind: 'reprompt', reason: 'out-of-range' }
  }
  if (!allowOther) {
    return { kind: 'reprompt', reason: 'need-number' }
  }
  return { kind: 'custom', text: trimmed }
}
