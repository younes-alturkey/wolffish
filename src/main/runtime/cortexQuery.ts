/**
 * FTS5 MATCH-query construction for cortex search. Kept in its own module —
 * free of the native better-sqlite3 import — so the bounding logic that fixes
 * the main-thread freeze is unit-testable on its own.
 */

// Cap on terms in a generated FTS5 MATCH query. The dominant cost of a big
// query was snippet() (removed from cortex.search — it was unused), so term
// count is now cheap (~5ms at 48 terms vs ~1ms at 12). This cap is mostly a
// belt-and-braces bound on the query string + bm25 work, set generously enough
// to give good recall coverage on a long, multi-section prompt while never
// approaching the ~1,400-term query that used to freeze the app.
export const FTS_MAX_TERMS = 48

// Common English glue — dropped so the bounded term budget is spent on words
// that actually discriminate between memories, not "the"/"with"/"every".
const FTS_STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'if',
  'then',
  'else',
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'with',
  'from',
  'by',
  'as',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'can',
  'may',
  'might',
  'must',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'you',
  'your',
  'yours',
  'we',
  'our',
  'ours',
  'they',
  'them',
  'their',
  'i',
  'me',
  'my',
  'not',
  'no',
  'so',
  'up',
  'out',
  'about',
  'into',
  'over',
  'than',
  'too',
  'very',
  'just',
  'also',
  'each',
  'every',
  'any',
  'all',
  'some',
  'more',
  'most',
  'such',
  'only',
  'own',
  'same',
  'how',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'use',
  'using'
])

// Only the first FTS_MAX_TERMS distinct terms are ever used, and they come from
// the head of the message — so the tail is dead weight. Cap the scanned prefix
// so tokenizing can't do an unbounded O(input) main-thread scan when the input
// is huge and skip-heavy (all stop words / <3-char tokens never fill the term
// budget, so the loop would otherwise walk every token of a multi-MB paste).
const FTS_MAX_SCAN_CHARS = 100_000

/**
 * Build a defensive FTS5 MATCH query: tokenize the user's input, drop
 * punctuation that the FTS5 grammar treats as operators, drop stop words,
 * dedupe, and CAP the term count so a huge message can't produce a
 * pathologically large OR query. Each term is quoted so a stray hyphen or
 * colon doesn't blow up the parse. Returns null when nothing usable remains.
 */
export function toFtsMatchQuery(input: string): string | null {
  const scan = input.length > FTS_MAX_SCAN_CHARS ? input.slice(0, FTS_MAX_SCAN_CHARS) : input
  const seen = new Set<string>()
  const terms: string[] = []
  for (const raw of scan.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (terms.length >= FTS_MAX_TERMS) break
    if (raw.length < 3) continue
    if (FTS_STOP_WORDS.has(raw)) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    terms.push(raw)
  }
  if (terms.length === 0) return null
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
}
