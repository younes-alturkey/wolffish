import { beginSync, getSyncActivity, onSyncActivity } from '@/lib/sync/activity'

/**
 * The overlay reads this, so what matters is that it always clears. A sync
 * that fails, or two that overlap, must not leave a blocking dialog on
 * screen — that turns a slow refresh into an app the user cannot use.
 */
describe('sync activity', () => {
  it('reports progress as each half lands, then clears', () => {
    const seen: (number | null)[] = []
    const off = onSyncActivity((a) => seen.push(a ? a.ratio : null))

    const progress = beginSync()
    expect(getSyncActivity()).not.toBeNull()

    progress.step({ settings: true, conversations: false })
    const half = getSyncActivity()?.ratio ?? 0
    progress.step({ settings: true, conversations: true })
    const full = getSyncActivity()?.ratio ?? 0
    expect(full).toBeGreaterThan(half)

    progress.end()
    expect(getSyncActivity()).toBeNull()
    expect(seen[seen.length - 1]).toBeNull()
    off()
  })

  it('names the half still outstanding', () => {
    const progress = beginSync()
    progress.step({ settings: true, conversations: false })
    expect(getSyncActivity()?.step).toBe('conversations')
    progress.step({ settings: false, conversations: true })
    expect(getSyncActivity()?.step).toBe('settings')
    progress.end()
  })

  // Two connections in quick succession each start a reconcile. Clearing on
  // the first to finish would hide an overlay while work is still running —
  // and worse, the second's end() could then clear a third.
  it('stays up until the last overlapping sync finishes', () => {
    const first = beginSync()
    const second = beginSync()
    first.end()
    expect(getSyncActivity()).not.toBeNull()
    second.end()
    expect(getSyncActivity()).toBeNull()
  })

  it('cannot be driven negative by an extra end', () => {
    const progress = beginSync()
    progress.end()
    progress.end()
    expect(getSyncActivity()).toBeNull()
    const next = beginSync()
    expect(getSyncActivity()).not.toBeNull()
    next.end()
    expect(getSyncActivity()).toBeNull()
  })
})
