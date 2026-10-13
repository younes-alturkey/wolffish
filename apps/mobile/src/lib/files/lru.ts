/**
 * Pure conversation-scoped LRU selection for the workspace file cache —
 * separated from the expo-file-system plumbing so the release policy is
 * unit-testable.
 */

/** A conversation touched this recently is never pruned (the open one's media). */
export const PRUNE_GRACE_MS = 5 * 60 * 1000

export type CachedFileRow = {
  rel_path: string
  size_bytes: number
  last_access_at: number
  /** Whose media this is; null for a workspace file opened outside a conversation. */
  conversation_id?: string | null
}

/** A file belonging to no conversation stands alone — its own bucket of one. */
function bucketKey(row: CachedFileRow): string {
  return row.conversation_id ? `c:${row.conversation_id}` : `f:${row.rel_path}`
}

/**
 * Which rows to delete so the total falls back under the budget.
 *
 * The unit is the CONVERSATION, not the file. Each conversation's media is
 * ranked by its most recently touched file and released oldest-conversation
 * first, so a recent conversation never loses media while an older one still
 * holds bytes on disk — plain per-file LRU would happily release the picture
 * you received this morning to keep a PDF you re-opened from last year.
 * Within one conversation the order is that per-file LRU, oldest access first.
 *
 * The grace window is per-conversation for the same reason. Opening a
 * conversation only touches the media that actually rendered; the rest of a
 * long scrollback stays untouched and would otherwise be the first thing
 * released out from under the person reading it. One recent touch anywhere in
 * a conversation keeps all of it.
 */
export function selectPrunable(
  rows: CachedFileRow[],
  budgetBytes: number,
  now: number = Date.now(),
  graceMs: number = PRUNE_GRACE_MS
): CachedFileRow[] {
  let total = rows.reduce((sum, row) => sum + row.size_bytes, 0)
  if (total <= budgetBytes) return []

  const buckets = new Map<string, { files: CachedFileRow[]; touchedAt: number }>()
  for (const row of rows) {
    const key = bucketKey(row)
    const bucket = buckets.get(key)
    if (!bucket) buckets.set(key, { files: [row], touchedAt: row.last_access_at })
    else {
      bucket.files.push(row)
      bucket.touchedAt = Math.max(bucket.touchedAt, row.last_access_at)
    }
  }

  const candidates = [...buckets.values()]
    .filter((bucket) => now - bucket.touchedAt > graceMs)
    .sort((a, b) => a.touchedAt - b.touchedAt)
    .flatMap((bucket) => bucket.files.sort((a, b) => a.last_access_at - b.last_access_at))

  const doomed: CachedFileRow[] = []
  for (const row of candidates) {
    if (total <= budgetBytes) break
    doomed.push(row)
    total -= row.size_bytes
  }
  return doomed
}
