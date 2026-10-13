import type { ConversationChannel, ConversationMeta } from '@/lib/conversations/types'

/**
 * ONE definition of "which conversations to list, and what state each is in" —
 * the desktop's buildConversationRows (src/renderer/src/lib/conversation-rows.ts)
 * ported to the phone's two sources of truth.
 *
 * The desktop merges its indexed list with a live `runStatuses` map fed by the
 * cross-channel chat:turnState broadcast. The phone has the same broadcast
 * (Event.turnStatus) but it does not need a map to know what is RUNNING: a turn
 * in flight — started here, on the desktop, or on a channel — already has a live
 * entry in chatRuntime, because that is what draws the streaming reply. So:
 *
 *   processing        a live stream with status 'streaming' exists
 *   completed/failed/
 *   stopped           the last terminal transition, while it is still FRESH
 *   null              anything older, and anything that never ran this session
 *
 * Deriving `processing` from the live stream rather than from a stored flag is
 * what makes it self-correcting: a phone that drops mid-turn and reconnects
 * re-settles its streams (see attachTurnStream), so a run that ended while it
 * was away cannot leave a chip pulsing forever — the desktop's terminal push
 * for it was lost, and no amount of remembering 'started' would recover it.
 */

export type ConversationRunPhase = 'processing' | 'completed' | 'failed' | 'stopped'

/** The phases a turn ENDS in — the only ones worth remembering after the fact. */
export type TerminalRunPhase = Exclude<ConversationRunPhase, 'processing'>

/** One conversation's last finished turn, as remembered by the run store. */
export type ConversationRun = { phase: TerminalRunPhase; at: number }

/**
 * How long a finished run's terminal chip tint (success / error / stopped)
 * marks its conversation as FRESH. Past the window the row reads like any other
 * old conversation — the tint distinguishes runs that JUST ended, it is not a
 * permanent record. Evaluated at build time with no timer of its own, exactly
 * as on the desktop: the tint expires on whatever next rebuilds the list.
 */
export const TERMINAL_FRESH_WINDOW_MS = 30 * 60 * 1000

/** A conversation as a list row — everything a rail/sheet row draws from. */
export type ConversationRow = {
  id: string
  title: string
  phase: ConversationRunPhase | null
  /** Origin — drives the small badge on the number chip. */
  channel: ConversationChannel | null
  /**
   * Source emoji for the badge: the conversation's project icon (resolved live
   * from the project list, so an icon renamed on the desktop propagates) or its
   * stamped automation/procedure icon. Null falls back to the channel glyph.
   */
  icon: string | null
  projectId: string | null
  /** Recency key — a running turn beats the stored updated_at. */
  at: number
  /**
   * False while the conversation is known ONLY from a turn running in it: it
   * has no row in this phone's index yet, so nothing that reads the local
   * record (title, message count, delete) has anything to read.
   */
  indexed: boolean
}

/** The shape this module needs from chatRuntime's live streams. */
export type LiveTurnView = {
  status: string
  message: { timestamp: number }
  user?: { content: string; timestamp: number }
  /** Where the turn was started, when the row has no indexed meta to read it from. */
  channel?: ConversationChannel | null
}

/** The shape this module needs from a project — its icon, by id. */
export type ProjectIconView = { id: string; icon?: string }

export type BuildConversationRowsInput = {
  metas: readonly ConversationMeta[]
  /** chatRuntime's `streams`, keyed by conversation id. */
  live?: Readonly<Record<string, LiveTurnView>>
  /** The run store's `runs`, keyed by conversation id. */
  runs?: Readonly<Record<string, ConversationRun>>
  /** Optional — resolves a bound conversation's badge emoji from its project. */
  projects?: readonly ProjectIconView[]
  /** Localized label for a conversation whose title hasn't resolved yet. */
  untitled: string
  /** Freshness clock for the terminal-tint window (injectable for tests). */
  now?: number
}

/** The remembered terminal phase, or null once it has gone stale. */
function freshTerminal(run: ConversationRun | undefined, now: number): TerminalRunPhase | null {
  if (!run) return null
  return now - run.at > TERMINAL_FRESH_WINDOW_MS ? null : run.phase
}

/**
 * A synthesized row's title: the prompt the running turn is answering, cut to
 * the same 60 characters `createLocalConversation` cuts a phone-sent title to,
 * so the row does not change shape when the desktop's own metadata lands.
 */
function titleFromPrompt(live: LiveTurnView): string | null {
  const first = live.user?.content.trim().split('\n')[0]?.trim()
  if (!first) return null
  return first.slice(0, 60)
}

/**
 * Merge the indexed conversation list with the turns running right now.
 *
 * The second half — synthesizing a row for a live turn with no indexed
 * conversation — is what makes a conversation STARTED ON THE DESKTOP appear,
 * pulsing, while it is still being written. The desktop only pushes a
 * conversation's metadata once its turn ends (pushTurnToMobile), so without
 * this the phone would learn about it a whole run late. The indexed row wins
 * the moment it arrives, so a synthesized row is only ever a brief bridge.
 */
export function buildConversationRows({
  metas,
  live = {},
  runs = {},
  projects,
  untitled,
  now = Date.now()
}: BuildConversationRowsInput): ConversationRow[] {
  const projectIcons = new Map((projects ?? []).map((project) => [project.id, project.icon]))
  const rows: ConversationRow[] = []
  const seen = new Set<string>()

  for (const meta of metas) {
    const turn = live[meta.id]
    const running = turn?.status === 'streaming'
    seen.add(meta.id)
    rows.push({
      id: meta.id,
      title: meta.title && meta.title !== 'Untitled' ? meta.title : untitled,
      phase: running ? 'processing' : freshTerminal(runs[meta.id], now),
      channel: meta.channel ?? null,
      icon: (meta.projectId ? projectIcons.get(meta.projectId) : undefined) ?? meta.icon ?? null,
      projectId: meta.projectId ?? null,
      // A running turn lifts its conversation to the top even before the
      // desktop has saved anything into it.
      at: running ? Math.max(meta.updatedAt, turn.message.timestamp) : meta.updatedAt,
      indexed: true
    })
  }

  for (const [id, turn] of Object.entries(live)) {
    if (seen.has(id) || turn.status !== 'streaming') continue
    rows.push({
      id,
      title: titleFromPrompt(turn) ?? untitled,
      phase: 'processing',
      // From the live turn, because there is no indexed row to read it from
      // yet — this is exactly the window in which a conversation started in a
      // terminal would otherwise show no origin at all.
      channel: turn.channel ?? null,
      icon: null,
      projectId: null,
      at: turn.user?.timestamp ?? turn.message.timestamp,
      indexed: false
    })
  }

  return rows.sort((a, b) => b.at - a.at)
}

/**
 * Fold a string down to what a title search should compare: case-insensitive,
 * and blind to the marks a keyboard may or may not have put there. NFD splits
 * a composed letter into base + combining mark, and dropping the marks makes
 * "cafe" find "Café" and a bare Arabic word find its vowelled spelling — which
 * matters because a title is written BY the model, not by the person searching
 * for it, so the two spellings are routinely not the same one.
 */
function foldForSearch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
}

/** The typed query as the keywords it contains — split, folded, empties dropped. */
export function conversationSearchKeywords(query: string): string[] {
  return query.split(/\s+/).map(foldForSearch).filter(Boolean)
}

/**
 * Title search — the desktop's filterConversationRows
 * (src/renderer/src/lib/conversation-rows.ts), ported so the same query
 * narrows the History screen and the conversations sheet here exactly as it
 * narrows them there. The terminal holds a third copy (src/cli/lib/search.mjs);
 * all three are pinned to one table of cases.
 *
 * Every keyword must appear SOMEWHERE in the title, in any order — typing
 * "release notes" finds "Notes for the 1.0.311 release" — because recalling a
 * conversation is recalling two or three words from it, rarely the phrase it
 * was titled with. An empty query hands back the rows untouched (the same
 * array), so a list that is not being searched pays nothing for the call.
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
