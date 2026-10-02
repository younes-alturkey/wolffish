import type { ConversationChannel, ConversationMeta, Project } from '@preload/index'
import type { ConversationRunPhase, ConversationRunStatus } from '@providers/sessions/useSessions'

/**
 * ONE definition of "which conversations to list, and what state each is in",
 * shared by every surface that lists them — the right-hand rail, the History
 * page, a project's conversations dialog. Written once so a conversation reads
 * IDENTICALLY wherever it was started from: in-app, WhatsApp, Telegram, a
 * heartbeat automation, a played procedure. The numbered chip's phase colors
 * (primary pulse while processing, then the terminal success/danger/warning
 * tint while the row is FRESH) come from the cross-channel chat:turnState
 * broadcast, so they only ever depend on a run existing — never on which
 * channel owns it.
 */
export type ConversationRow = {
  conversationId: string
  title: string
  phase: ConversationRunPhase | null
  /** Origin — drives the small badge on the number chip. */
  channel: ConversationChannel | string | null
  /**
   * Source emoji for the number-chip badge: the conversation's project icon
   * (resolved live) or its stamped automation/procedure icon. Null falls back
   * to the channel-glyph badge.
   */
  icon: string | null
  projectId: string | null
  /** Recency key — live phase changes beat file mtimes. */
  at: number
  /** Best-known last activity, for "x minutes ago" stamps. */
  updatedAt: number
  /**
   * False while the conversation is known ONLY from its live run status — it
   * has no row in the conversation index yet, so anything that acts on the
   * stored file (delete, diagnostic export) has nothing to act on.
   */
  indexed: boolean
}

/**
 * How long a finished run's terminal chip tint (success/danger/warning) marks
 * its conversation as FRESH. Past the window the row reads as any other old
 * conversation (neutral chip) — the tint exists to distinguish runs that JUST
 * ended, not to be a permanent record. Deliberately evaluated at list-build
 * time with NO timer of its own: the tint expires on whatever next rebuilds
 * the list (a turn starting or ending anywhere, an index change, navigation).
 * Resuming an expired conversation restarts the cycle naturally — its new
 * turn re-stamps the status clock through chat:turnState.
 */
export const TERMINAL_FRESH_WINDOW_MS = 30 * 60 * 1000

/**
 * The phase a row should RENDER: `processing` always shows (a live run pulses
 * however long it takes); a terminal phase shows only while fresh.
 */
function effectivePhase(
  live: ConversationRunStatus | undefined,
  now: number
): ConversationRunPhase | null {
  if (!live) return null
  if (live.phase !== 'processing' && now - live.at > TERMINAL_FRESH_WINDOW_MS) return null
  return live.phase
}

/**
 * Merge the indexed conversation list with this app session's live run
 * statuses into the rows a list surface renders.
 *
 * The second half — synthesizing a row for a status with no indexed
 * conversation — is what makes a BRAND-NEW conversation appear, pulsing, the
 * moment its first turn starts. Every origin needs it, for its own reason: an
 * in-app chat has no file at all until the end-of-turn save, and a channel
 * chat writes an 'Untitled' shell that still reaches the cortex a beat behind
 * the turn. Without it the row only shows up once the work is over.
 *
 * ALL phases are synthesized, not just 'processing': gating on processing made
 * a conversation VANISH the instant it completed — its phase flipped
 * synchronously while the list refetch was still in flight, so it fell out of
 * both sources for a render and the whole list reflowed. Once the index has
 * it, the indexed row wins, so a synthesized row is only ever a brief bridge.
 */
export function buildConversationRows({
  metas,
  runStatuses,
  projects,
  untitled,
  now = Date.now()
}: {
  metas: readonly ConversationMeta[]
  runStatuses: Record<string, ConversationRunStatus>
  /** Optional — resolves a bound conversation's badge emoji from its project. */
  projects?: readonly Project[]
  /** Localized label for a conversation whose title hasn't resolved yet. */
  untitled: string
  /** Freshness clock for the terminal-tint window (injectable for tests). */
  now?: number
}): ConversationRow[] {
  const projectIcons = new Map((projects ?? []).map((p) => [p.id, p.icon]))
  const byId = new Map<string, ConversationRow>()

  for (const meta of metas) {
    const live = runStatuses[meta.id]
    // A just-created conversation reaches the index BEFORE its LLM title
    // resolves (the shell persists as 'Untitled'; the titled write re-indexes
    // 1–4s later). While the indexed title is still the sentinel, prefer the
    // live-status title when one exists — the row only ever transitions
    // Untitled → real, never regresses.
    const indexedTitle = meta.title && meta.title !== 'Untitled' ? meta.title : null
    byId.set(meta.id, {
      conversationId: meta.id,
      title: indexedTitle ?? live?.title ?? untitled,
      phase: effectivePhase(live, now),
      channel: meta.channel ?? live?.channel ?? null,
      // Project emoji wins (a project conversation reads as its project);
      // otherwise the stamped automation/procedure emoji.
      icon: (meta.projectId ? projectIcons.get(meta.projectId) : undefined) ?? meta.icon ?? null,
      projectId: meta.projectId ?? null,
      at: Math.max(meta.updatedAt, live?.at ?? 0),
      updatedAt: meta.updatedAt,
      indexed: true
    })
  }

  for (const [id, s] of Object.entries(runStatuses)) {
    if (byId.has(id)) continue
    byId.set(id, {
      conversationId: id,
      title: s.title ?? untitled,
      phase: effectivePhase(s, now),
      channel: s.channel ?? null,
      icon: null,
      projectId: null,
      at: s.at,
      // Nothing on disk to date it — the run's own clock IS its recency.
      updatedAt: s.at,
      indexed: false
    })
  }

  return [...byId.values()].sort((a, b) => b.at - a.at)
}

/**
 * Recency buckets, coarsening as they recede — a day, a day, a week, a month, a
 * quarter, a half-year, a year, then everything before that. The windows widen
 * on purpose: recent work is scanned by exact day, old work by rough era, so a
 * long list stays retrievable without ever growing a scrollbar of
 * undifferentiated rows.
 */
export type ConversationGroupKey =
  | 'today'
  | 'yesterday'
  | 'last7'
  | 'last30'
  | 'last3m'
  | 'last6m'
  | 'lastYear'
  | 'older'

export type ConversationGroup = {
  key: ConversationGroupKey
  /** i18n key — ONE label per bucket, so every surface names it identically. */
  labelKey: string
  rows: ConversationRow[]
  /**
   * 1-based position of this group's first row in the FLAT list. The number
   * chips run continuously across the headers (…7, 8 · "Yesterday" · 9, 10…)
   * rather than restarting per group — the chip is the conversation's rank in
   * the whole list, and grouping must not renumber it.
   */
  startIndex: number
}

/**
 * Slice the (already recency-sorted) rows into the date groups a list surface
 * renders headers for. Empty buckets are dropped, so a header never appears
 * over nothing.
 */
export function groupConversationRows(
  rows: readonly ConversationRow[],
  now: number = Date.now()
): ConversationGroup[] {
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

  const buckets = new Map<ConversationGroupKey, ConversationRow[]>()
  for (const row of rows) {
    // Bucketed on `at` — the SAME key buildConversationRows sorts by — so each
    // bucket's rows are contiguous in the sorted order. Bucketing on updatedAt
    // while sorting on `at` would drop a live run into the middle of an older
    // group, since a run's clock is what lifts it to the top of the list.
    const key: ConversationGroupKey = ladder.find(([, from]) => row.at >= from)?.[0] ?? 'older'
    const bucket = buckets.get(key)
    if (bucket) bucket.push(row)
    else buckets.set(key, [row])
  }

  const groups: ConversationGroup[] = []
  let startIndex = 1
  for (const key of [...ladder.map(([k]) => k), 'older' as const]) {
    const bucketRows = buckets.get(key)
    if (!bucketRows?.length) continue
    groups.push({ key, labelKey: `history.groups.${key}`, rows: bucketRows, startIndex })
    startIndex += bucketRows.length
  }
  return groups
}

/**
 * A stable key over the live phases, for effects that must refetch the
 * conversation list whenever a turn starts or ends ANYWHERE — that transition
 * is exactly when a new conversation can appear, on any channel.
 */
export function runPhaseKey(runStatuses: Record<string, ConversationRunStatus>): string {
  return Object.entries(runStatuses)
    .map(([id, s]) => `${id}:${s.phase}`)
    .join('|')
}

/**
 * Fold a string down to what a title search should compare: case-insensitive,
 * and blind to the marks a keyboard may or may not have put there. NFD splits
 * a composed letter into base + combining mark, and dropping the marks makes
 * "cafe" find "Café" and a bare Arabic word find its vowelled spelling — which
 * matters here because a title is written BY the model, not by the person
 * searching for it, so the two spellings are routinely not the same one.
 */
function foldForSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
}

/**
 * The typed query as the keywords it contains — whitespace-separated, folded,
 * empties dropped.
 */
export function conversationSearchKeywords(query: string): string[] {
  return query.split(/\s+/).map(foldForSearch).filter(Boolean)
}

/**
 * Title search, shared by every surface that lists conversations so the same
 * query narrows the History page and the conversations sheet identically.
 *
 * Every keyword must appear SOMEWHERE in the title, in any order — typing
 * "release notes" finds "Notes for the 1.0.311 release" — because recalling a
 * conversation is recalling two or three words from it, rarely the phrase it
 * was titled with. An empty query returns the rows untouched (the same array,
 * so a non-searching surface pays nothing for the call).
 */
export function filterConversationRows(
  rows: readonly ConversationRow[],
  query: string
): readonly ConversationRow[] {
  const keywords = conversationSearchKeywords(query)
  if (keywords.length === 0) return rows
  return rows.filter((row) => {
    const title = foldForSearch(row.title)
    return keywords.every((word) => title.includes(word))
  })
}
