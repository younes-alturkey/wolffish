import { browserKey, type Segment } from './broca'

/**
 * One browser card per conversation, in the LATEST turn that used it.
 *
 * A `browser` segment is minted by whichever turn opens a tab, so a
 * conversation that opened its browser in three turns carried three cards —
 * three canvases streaming the same browser, and three restores on reopen.
 * This keeps the last card for each browser (its key is the conversation)
 * and drops the earlier ones. Idempotent, and applied at every seam a
 * transcript passes through: the persist merge, the disk→feed mapping, the
 * live append. Returns the same array when nothing changes so React state
 * does not churn.
 */
export function keepLatestBrowserCard<M extends object>(messages: M[]): M[] {
  const seen = new Set<string>()
  let out: M[] | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const segs = (messages[i] as { segments?: Segment[] }).segments
    if (!segs || !segs.some((s) => s.kind === 'browser')) continue
    const kept = segs.filter((s) => {
      if (s.kind !== 'browser') return true
      const key = browserKey(s.snapshot)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    if (kept.length === segs.length) continue
    if (!out) out = [...messages]
    out[i] = { ...messages[i], segments: kept }
  }
  return out ?? messages
}
