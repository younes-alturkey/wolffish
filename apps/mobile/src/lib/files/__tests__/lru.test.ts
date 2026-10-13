import { selectPrunable, type CachedFileRow } from '@/lib/files/lru'

function row(
  rel: string,
  size: number,
  lastAccess: number,
  conversationId?: string
): CachedFileRow {
  return {
    rel_path: rel,
    size_bytes: size,
    last_access_at: lastAccess,
    conversation_id: conversationId ?? null
  }
}

const NOW = 1_000_000_000
const OLD = NOW - 60 * 60 * 1000 // 1h ago — outside the grace window

describe('selectPrunable', () => {
  it('returns nothing while under budget', () => {
    expect(selectPrunable([row('a', 100, OLD)], 1000, NOW)).toEqual([])
  })

  it('evicts least-recently-used first until back under budget', () => {
    const rows = [
      row('newest', 400, OLD + 3000),
      row('oldest', 400, OLD + 1000),
      row('middle', 400, OLD + 2000)
    ]
    const doomed = selectPrunable(rows, 800, NOW)
    expect(doomed.map((r) => r.rel_path)).toEqual(['oldest'])
  })

  it('keeps evicting until the budget is met', () => {
    const rows = [row('a', 500, OLD + 1), row('b', 500, OLD + 2), row('c', 500, OLD + 3)]
    const doomed = selectPrunable(rows, 500, NOW)
    expect(doomed.map((r) => r.rel_path)).toEqual(['a', 'b'])
  })

  it('spares files accessed inside the grace window even over budget', () => {
    const rows = [row('open-conversation', 2000, NOW - 1000), row('stale', 500, OLD)]
    const doomed = selectPrunable(rows, 1000, NOW)
    expect(doomed.map((r) => r.rel_path)).toEqual(['stale'])
  })

  it('a zero budget clears everything outside the grace window', () => {
    const rows = [row('a', 1, OLD), row('b', 1, NOW)]
    expect(selectPrunable(rows, 0, NOW).map((r) => r.rel_path)).toEqual(['a'])
  })

  it('releases the oldest conversation whole before touching a recent one', () => {
    // The recent conversation holds the single oldest FILE — per-file LRU would
    // release that one first, which is exactly what must not happen.
    const rows = [
      row('recent/never-scrolled-to', 400, OLD + 1000, 'conv-recent'),
      row('recent/read-just-now', 400, OLD + 9000, 'conv-recent'),
      row('stale/first', 400, OLD + 3000, 'conv-stale'),
      row('stale/second', 400, OLD + 4000, 'conv-stale')
    ]
    const doomed = selectPrunable(rows, 800, NOW)
    expect(doomed.map((r) => r.rel_path)).toEqual(['stale/first', 'stale/second'])
  })

  it('one recent touch spares a whole conversation, unrendered media included', () => {
    // The zero-budget case is the Data screen's Release button: it frees the
    // cache, but not the conversation the reader just came from.
    const rows = [
      row('open/on-screen', 500, NOW - 1000, 'conv-open'),
      row('open/further-down', 500, OLD, 'conv-open'),
      row('cold/anything', 500, OLD, 'conv-cold')
    ]
    expect(selectPrunable(rows, 0, NOW).map((r) => r.rel_path)).toEqual(['cold/anything'])
  })

  it('keeps releasing older conversations until the budget is met', () => {
    const rows = [
      row('a/one', 500, OLD + 1000, 'conv-a'),
      row('b/one', 500, OLD + 2000, 'conv-b'),
      row('c/one', 500, OLD + 3000, 'conv-c')
    ]
    const doomed = selectPrunable(rows, 500, NOW)
    expect(doomed.map((r) => r.rel_path)).toEqual(['a/one', 'b/one'])
  })

  it('treats a file with no conversation as its own unit', () => {
    const rows = [
      row('loose.pdf', 400, OLD + 1000),
      row('conv/media', 400, OLD + 2000, 'conv-x'),
      row('conv/other', 400, OLD + 3000, 'conv-x')
    ]
    const doomed = selectPrunable(rows, 800, NOW)
    expect(doomed.map((r) => r.rel_path)).toEqual(['loose.pdf'])
  })
})
