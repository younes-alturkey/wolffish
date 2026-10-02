/**
 * Title search for the terminal, shared by every door that lists
 * conversations: the REPL's `/conversations`, `wolffish conversations` and its
 * `--search` flag.
 *
 * Kept as its own module with NO dependencies so it can be tested — and read —
 * on its own, and so the app and the CLI have exactly one rule between them to
 * keep in step.
 */

/**
 * Fold a string down to what a search should compare: case-insensitive, and
 * blind to the marks a keyboard may or may not have put there. NFD splits a
 * composed letter into base + combining mark, and dropping the marks makes
 * `cafe` find "Café" and a bare Arabic word find its vowelled spelling —
 * which matters because a title is written BY the model, not by the person
 * searching for it, so the two spellings are routinely not the same one.
 *
 * The terminal's copy of the app's foldForSearch (conversation-rows.ts); the
 * two must agree, or one query answers differently in two windows.
 */
export function foldForSearch(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
}

/**
 * Does `haystack` contain every keyword in `query`?
 *
 * Keywords, not a phrase: typing `release notes` finds "Notes for the 1.0.311
 * release", because recalling a conversation is recalling two or three words
 * from it, rarely the order they were titled in. An empty query matches
 * everything, so callers can pass an input's contents through unguarded.
 *
 * The haystack is the CALLER's choice on purpose. Searching a conversation is
 * searching its title — that is the app's rule, and the one this mirrors — but
 * the `wolffish conversations` menu has always also reached the channel and
 * the id from its own prompt, and narrowing that would take away a way of
 * finding things that already works.
 */
export function matchesKeywords(haystack, query) {
  const words = String(query ?? '')
    .split(/\s+/)
    .map(foldForSearch)
    .filter(Boolean)
  if (words.length === 0) return true
  const folded = foldForSearch(haystack)
  return words.every((word) => folded.includes(word))
}

/** The conversations whose TITLE carries every keyword typed. */
export function filterConversationsByTitle(list, query) {
  if (!String(query ?? '').trim()) return list
  return list.filter((conv) => matchesKeywords(conv.title ?? 'Untitled', query))
}
