/**
 * Whether a catch-up is running, and how far it has got.
 *
 * Its own module, importing nothing: `lib/sync` writes it and the overlay
 * reads it, and routing that through sync.ts would put a UI concern in the
 * middle of the sync path and a cycle between them.
 *
 * The ratio is derived from which halves of a reconcile have finished, not
 * measured — nobody can know how long a workspace takes to pull. It reports
 * progress that has actually happened rather than a guess at what is left.
 */
export type SyncStep = 'settings' | 'conversations' | 'wrapping'

export type SyncActivity = {
  ratio: number
  step: SyncStep
  /**
   * When the OUTERMOST catch-up started — what the overlay's clock counts
   * from. Overlapping reconciles keep the first one's stamp rather than each
   * resetting it, because what the user is waiting on is the wait, not
   * whichever pull happens to be reporting.
   */
  startedAt: number
} | null

let activity: SyncActivity = null
/** Reconciles can overlap — two connections in quick succession. The overlay
 *  must clear when the last one finishes, not the first. */
let depth = 0
let startedAt = 0
const listeners = new Set<(activity: SyncActivity) => void>()

function publish(next: SyncActivity): void {
  activity = next
  for (const listener of listeners) listener(activity)
}

export function getSyncActivity(): SyncActivity {
  return activity
}

export function onSyncActivity(listener: (activity: SyncActivity) => void): () => void {
  listeners.add(listener)
  listener(activity)
  return () => listeners.delete(listener)
}

/**
 * Mark a catch-up as running. Returns the reporter for its parts and the
 * finisher, which must run even when the pull fails — an overlay left up
 * after a failed sync is worse than the failure.
 */
export function beginSync(): {
  step: (done: { settings: boolean; conversations: boolean }) => void
  end: () => void
} {
  depth += 1
  if (depth === 1) {
    startedAt = Date.now()
    publish({ ratio: 0.08, step: 'settings', startedAt })
  }
  return {
    step: ({ settings, conversations }) => {
      if (depth === 0) return
      const finished = (settings ? 1 : 0) + (conversations ? 1 : 0)
      publish({
        ratio: 0.08 + 0.92 * (finished / 2),
        step: finished === 2 ? 'wrapping' : settings ? 'conversations' : 'settings',
        startedAt
      })
    },
    end: () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) publish(null)
    }
  }
}
