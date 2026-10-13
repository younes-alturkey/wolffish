import { tunnelClient } from '@/lib/tunnel/client'
import { Rpc, type OverlaySeed, type ReindexStatus } from '@/lib/tunnel/protocol'
import { useMemo } from 'react'
import { create } from 'zustand'

/**
 * The reindex overlay — the desktop rebuilding its memory index, as a card
 * over whatever screen the phone is on.
 *
 * The desktop treats a reindex as a blocking overlay that replaces its chat
 * screen for the duration. The phone shows it as one card instead, because a
 * phone that cannot be used at all while an index rebuilds is a phone that
 * looks broken — and because a desktop that has stopped answering deserves an
 * explanation wherever the user happens to be looking.
 *
 * IN MEMORY ONLY, and cleared the moment the tunnel drops. The card claims
 * something is happening *right now* on a machine this one cannot see; a card
 * that survived a relaunch, or an hour offline, would be asserting that on no
 * evidence. There is nothing to restore it from either — the desktop announces
 * transitions, not history — which is what `seedOverlays` is for.
 *
 * The status only ever arrives as a push and no screen fetches it, so a phone
 * connecting mid-rebuild has already missed the only announcement it was going
 * to get. `seedOverlays()` closes that window once per connection; the pushes
 * keep it current after that.
 *
 * Unpaired (demo) phones have no overlay and never will: there is no desktop
 * rebuilding anything. The stack renders nothing, which is the truth.
 */

/** The one card's worth of state. */
export type ActiveOverlay = {
  kind: 'reindex'
  id: 'reindex'
  startedAt: number
  done: number
  total: number
}

type OverlayState = {
  reindex: ReindexStatus | null
}

export const useOverlayStore = create<OverlayState>()(() => ({
  reindex: null
}))

// ------------------------------------------------------------------ reading

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * A reindex status off the wire, or null — which is also what the desktop sends
 * when a rebuild ENDS, and is therefore what retires the card.
 *
 * A rebuild with no files (`total` 0) is dropped: there is nothing to report
 * and a bar over zero has no meaning.
 */
export function readReindex(payload: unknown): ReindexStatus | null {
  const status = (payload as { status?: unknown } | null)?.status as Partial<ReindexStatus> | null
  if (!status || typeof status !== 'object') return null
  const total = count(status.total)
  if (total <= 0) return null
  return { startedAt: count(status.startedAt), done: Math.min(count(status.done), total), total }
}

// ------------------------------------------------------------------ writing

/**
 * Bumped by everything that writes newer knowledge than a seed in flight —
 * a push, or the tunnel dropping. See seedOverlays for what reads it.
 */
let revision = 0

/** Fold a `reindex.status` push. `null` is the end, and retires the card. */
export function applyOverlayReindex(reindex: ReindexStatus | null): void {
  revision += 1
  useOverlayStore.setState({ reindex })
}

/** Nothing is knowably running once the tunnel is gone. See the file doc. */
export function clearOverlays(): void {
  revision += 1
  useOverlayStore.setState({ reindex: null })
}

/**
 * Ask the desktop whether a rebuild is under way, once per connection.
 *
 * Discarded if anything else wrote while it was in flight. The seed is issued
 * on the same edge that attaches the push handlers, so a rebuild that ends
 * during that round trip arrives as a push FIRST and the answer — already
 * describing a world that has moved on — would put the finished rebuild back.
 * That push was very likely the last one the desktop had to send, which
 * leaves a card standing over nothing until the next unrelated one.
 *
 * Never throws: a desktop too old to answer this leaves the stack empty until
 * the next push, which is exactly the behaviour before the card existed.
 */
export async function seedOverlays(): Promise<void> {
  const tunnel = tunnelClient.active
  if (!tunnel || !tunnelClient.connected) return
  const issued = revision
  try {
    const seed = (await tunnel.rpc(Rpc.overlaysRead)) as OverlaySeed | null
    if (revision !== issued) return
    useOverlayStore.setState({ reindex: readReindex({ status: seed?.reindex }) })
  } catch {
    // Deliberately silent, and deliberately NOT reportRpcFailure: an
    // unsupported method is not a sick tunnel, and nothing the user asked for
    // has failed.
  }
}

// ---------------------------------------------------------------- composing

/** The card to draw, or null when the desktop is not rebuilding. */
export function composeOverlay(reindex: ReindexStatus | null): ActiveOverlay | null {
  if (!reindex) return null
  return {
    kind: 'reindex',
    id: 'reindex',
    startedAt: reindex.startedAt,
    done: reindex.done,
    total: reindex.total
  }
}

/**
 * The card, for the one component that draws it. Composed in a memo rather
 * than inside the selector: a selector that builds a new object on every call
 * has no stable snapshot for useSyncExternalStore to compare, and React says
 * so at runtime.
 */
export function useActiveOverlay(): ActiveOverlay | null {
  const reindex = useOverlayStore((state) => state.reindex)
  return useMemo(() => composeOverlay(reindex), [reindex])
}
