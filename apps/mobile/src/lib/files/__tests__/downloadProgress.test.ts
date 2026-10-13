import {
  beginDownload,
  endDownload,
  getDownload,
  reportDownload,
  subscribeDownload
} from '@/lib/files/downloadProgress'

const PATH = 'uploads/conv-1/clip.mp4'
const OTHER = 'files/report.pdf'

/**
 * The store is what turns two very different transports (chunked RPC over the
 * tunnel, a native CDN download) into one progress bar, so what matters is the
 * contract every file card reads through it: the latest counts are always
 * there, subscribers are woken sparingly, and a finished download stays
 * finished.
 */
describe('download progress', () => {
  let now = 1_000_000_000
  let clock: jest.SpyInstance

  beforeEach(() => {
    now = 1_000_000_000
    clock = jest.spyOn(Date, 'now').mockImplementation(() => now)
  })

  afterEach(() => {
    endDownload(PATH)
    endDownload(OTHER)
    clock.mockRestore()
  })

  /** Count the wake-ups a card watching `relPath` would get. */
  function watch(relPath: string): { wakes: () => number; stop: () => void } {
    let count = 0
    const stop = subscribeDownload(relPath, () => {
      count += 1
    })
    return { wakes: () => count, stop }
  }

  it('reports nothing for a path that is not downloading', () => {
    expect(getDownload(PATH)).toBeNull()
  })

  it('publishes the total before the first byte, then each step', () => {
    beginDownload(PATH)
    expect(getDownload(PATH)).toEqual({ receivedBytes: 0, totalBytes: 0 })

    // The tunnel knows the size a round trip before it has any bytes — the bar
    // is sized from this, so it has to land even though nothing was received.
    reportDownload(PATH, 0, 4_000)
    expect(getDownload(PATH)).toEqual({ receivedBytes: 0, totalBytes: 4_000 })

    now += 200
    reportDownload(PATH, 1_000, 4_000)
    expect(getDownload(PATH)).toEqual({ receivedBytes: 1_000, totalBytes: 4_000 })
  })

  it('hands out a new object per update, so subscribers see the change', () => {
    beginDownload(PATH)
    const first = getDownload(PATH)
    now += 200
    reportDownload(PATH, 1_000, 4_000)
    // useSyncExternalStore compares snapshots by identity: mutating one in
    // place would leave every card frozen on its first frame.
    expect(getDownload(PATH)).not.toBe(first)
  })

  it('throttles the flood between the first update and the last', () => {
    const watcher = watch(PATH)
    beginDownload(PATH)
    reportDownload(PATH, 100, 4_000)
    const afterFirst = watcher.wakes()

    // Native progress fires per packet; these all land inside one window.
    now += 10
    reportDownload(PATH, 200, 4_000)
    now += 10
    reportDownload(PATH, 300, 4_000)
    expect(watcher.wakes()).toBe(afterFirst)
    // Throttled means not announced, never stale: the newest count is held.
    expect(getDownload(PATH)?.receivedBytes).toBe(300)

    now += 100
    reportDownload(PATH, 400, 4_000)
    expect(watcher.wakes()).toBe(afterFirst + 1)
    watcher.stop()
  })

  it('always announces completion, however close behind the last update', () => {
    const watcher = watch(PATH)
    beginDownload(PATH)
    reportDownload(PATH, 100, 4_000)
    const afterFirst = watcher.wakes()

    now += 1
    reportDownload(PATH, 4_000, 4_000)
    // Throttled away, the bar would freeze mid-transfer for the rest of the
    // card's life — the very dead-progress state this replaced a spinner over.
    expect(watcher.wakes()).toBe(afterFirst + 1)
    watcher.stop()
  })

  it('keeps a total that a later silent callback does not carry', () => {
    beginDownload(PATH)
    reportDownload(PATH, 0, 4_000)

    now += 200
    // -1 is what a download with no Content-Length reports.
    reportDownload(PATH, 1_000, -1)
    expect(getDownload(PATH)).toEqual({ receivedBytes: 1_000, totalBytes: 4_000 })
  })

  it('ignores callbacks that arrive after the download ended', () => {
    beginDownload(PATH)
    reportDownload(PATH, 1_000, 4_000)
    endDownload(PATH)
    expect(getDownload(PATH)).toBeNull()

    // A resurrected entry would put a loading card back over a loaded file.
    now += 200
    reportDownload(PATH, 2_000, 4_000)
    expect(getDownload(PATH)).toBeNull()
  })

  it('wakes only the cards watching the path that moved', () => {
    const watched = watch(PATH)
    const bystander = watch(OTHER)

    beginDownload(PATH)
    reportDownload(PATH, 500, 4_000)
    expect(watched.wakes()).toBeGreaterThan(0)
    expect(bystander.wakes()).toBe(0)
    watched.stop()
    bystander.stop()
  })

  it('restarts cleanly when a pruned file is fetched again', () => {
    beginDownload(PATH)
    reportDownload(PATH, 4_000, 4_000)
    endDownload(PATH)

    // The LRU can drop a file and the next mount re-fetches it; the second
    // transfer must not inherit the first one's finished counts.
    beginDownload(PATH)
    expect(getDownload(PATH)).toEqual({ receivedBytes: 0, totalBytes: 0 })
  })
})
