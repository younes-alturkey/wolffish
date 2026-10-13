/**
 * Recency buckets for conversation lists — the desktop's
 * groupConversationRows (src/renderer/src/lib/conversation-rows.ts), ported so
 * both apps slice history at the SAME boundaries under the SAME labels.
 *
 * The windows coarsen as they recede — a day, a day, a week, a month, a
 * quarter, a half-year, a year, then everything before that. That widening is
 * the point: recent work is scanned by exact day, old work by rough era, so a
 * long list stays retrievable without ever growing a scroll of undifferentiated
 * rows.
 *
 * Generic over the row type, because more than one shape flows through it and
 * all must bucket identically: the History screen and the conversations sheet
 * both group merged rows by `at` (which a running turn lifts into "Today").
 * One ladder, one set of labels, one numbering rule — a second copy is how two
 * surfaces end up disagreeing about what "Yesterday" means.
 */
export type ConversationGroupKey =
  'today' | 'yesterday' | 'last7' | 'last30' | 'last3m' | 'last6m' | 'lastYear' | 'older'

export type RecencyGroup<T> = {
  key: ConversationGroupKey
  /** i18n key — ONE label per bucket, so every surface names it identically. */
  labelKey: string
  /**
   * The bucket's rows. Named `data` rather than the desktop's `rows` so a group
   * IS a SectionList section and needs no per-render remapping.
   */
  data: T[]
  /**
   * 1-based position of this group's first row in the FLAT list. The number
   * chips run continuously across the headers (…7, 8 · "Yesterday" · 9, 10…)
   * rather than restarting per group — the chip is the conversation's rank in
   * the whole list, and grouping must not renumber it. It doubles as the
   * first-group test: only the first group can start at 1.
   */
  startIndex: number
}

/**
 * Slice recency-sorted rows into the date groups a list renders headers over.
 * Empty buckets are dropped, so a header never appears over nothing.
 *
 * Input MUST already be newest-first — listConversations orders by
 * `updated_at DESC`, and buildConversationRows sorts by `at` — since each
 * bucket keeps the order it was handed.
 */
export function groupByRecency<T>(
  items: readonly T[],
  /** The row's recency key. MUST be the same key the input was sorted by, or a
   *  lifted row lands in the middle of an older bucket. */
  recencyOf: (item: T) => number,
  now: number = Date.now()
): RecencyGroup<T>[] {
  // Calendar boundaries, not rolling windows: something from 11pm last night
  // reads as "Yesterday", not "Today". Both steppers move calendar FIELDS
  // rather than subtracting milliseconds, so neither a DST change nor a leap
  // day can slide a boundary off local midnight.
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)

  const daysBack = (n: number): number => {
    const d = new Date(midnight)
    d.setDate(d.getDate() - n)
    return d.getTime()
  }
  // Month steps land on the same day-of-month, clamped when the target month is
  // too short to have it: from Aug 31, six months back is Feb 28 (or 29), NOT
  // the Mar 2/3 a bare setMonth overflows to.
  const monthsBack = (n: number): number => {
    const d = new Date(midnight)
    const day = d.getDate()
    d.setDate(1)
    d.setMonth(d.getMonth() - n)
    const lastOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
    d.setDate(Math.min(day, lastOfMonth))
    return d.getTime()
  }

  // The ladder, newest first, declared ONCE — it is both the bucketing test and
  // the render order, so the two can never drift apart. Each bucket claims
  // everything at or after its cutoff that no earlier bucket already took;
  // 'older' is the open-ended tail and needs no cutoff.
  const ladder = [
    ['today', daysBack(0)],
    ['yesterday', daysBack(1)],
    ['last7', daysBack(7)],
    ['last30', daysBack(30)],
    ['last3m', monthsBack(3)],
    ['last6m', monthsBack(6)],
    ['lastYear', monthsBack(12)]
  ] as const satisfies ReadonlyArray<readonly [ConversationGroupKey, number]>

  const buckets = new Map<ConversationGroupKey, T[]>()
  for (const item of items) {
    const at = recencyOf(item)
    const key: ConversationGroupKey = ladder.find(([, from]) => at >= from)?.[0] ?? 'older'
    const bucket = buckets.get(key)
    if (bucket) bucket.push(item)
    else buckets.set(key, [item])
  }

  const groups: RecencyGroup<T>[] = []
  let startIndex = 1
  for (const key of [...ladder.map(([k]) => k), 'older' as const]) {
    const bucketRows = buckets.get(key)
    if (!bucketRows?.length) continue
    groups.push({ key, labelKey: `history.groups.${key}`, data: bucketRows, startIndex })
    startIndex += bucketRows.length
  }
  return groups
}
