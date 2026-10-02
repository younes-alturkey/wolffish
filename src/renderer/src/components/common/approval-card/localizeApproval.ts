import type { TFunction } from 'i18next'

/**
 * Approval copy (title / description / impact) is authored in English by
 * plugins in the main process, where i18n isn't available — so we localize
 * it here, inside the card. Each string is looked up in a per-locale phrase
 * map shipped in the locale files under `chat.approval.phrases`.
 *
 * This is deliberately additive and forgiving: anything not in the map —
 * most notably interpolated strings that embed non-translatable data like
 * file paths, URLs, selectors and coordinates — falls straight back to the
 * original English untouched. New or changed plugin strings therefore keep
 * working (in English) until a translation is added, never breaking.
 */

// Stable empty reference so a missing map (e.g. the `en` base, which needs no
// lookup) doesn't allocate on every render.
const NO_PHRASES: Record<string, string> = {}

/**
 * Pull the active locale's approval phrase map. Returns an empty map when the
 * locale ships none (the English source strings are their own fallback).
 */
export function getApprovalPhrases(t: TFunction): Record<string, string> {
  const map = t('chat.approval.phrases', {
    returnObjects: true,
    defaultValue: NO_PHRASES
  }) as unknown
  return map && typeof map === 'object' && !Array.isArray(map)
    ? (map as Record<string, string>)
    : NO_PHRASES
}

/**
 * Translate one plugin-authored phrase via the supplied map, falling back to
 * the original text whenever there's no exact match. Whitespace is trimmed
 * for the lookup only — the original text is returned verbatim on a miss.
 */
export function localizeApprovalPhrase(
  text: string | null | undefined,
  phrases: Record<string, string>
): string {
  if (!text) return ''
  const hit = phrases[text] ?? phrases[text.trim()]
  return typeof hit === 'string' && hit.length > 0 ? hit : text
}
