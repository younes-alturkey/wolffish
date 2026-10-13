/**
 * The reindex overlay's state: what the wire is allowed to say, and how the
 * once-per-connection seed races the pushes.
 *
 * The failure mode worth pinning does not crash: a card built from
 * `undefined` renders `NaN` and a clock counting from 1970, and a seed that
 * lands after a push describes a world that has already moved on.
 */

const mockRpc = jest.fn()
const link = { connected: true }
jest.mock('@/lib/tunnel/client', () => ({
  tunnelClient: {
    get connected() {
      return link.connected
    },
    get active() {
      return link.connected ? { rpc: mockRpc, connected: true } : null
    },
    reportRpcFailure: jest.fn()
  }
}))

import {
  applyOverlayReindex,
  clearOverlays,
  composeOverlay,
  readReindex,
  seedOverlays,
  useOverlayStore
} from '@/lib/sync/overlays'

beforeEach(() => {
  mockRpc.mockReset()
  link.connected = true
  clearOverlays()
})

describe('reading the wire', () => {
  it('reads a reindex, and treats the end of one as null', () => {
    expect(readReindex({ status: { startedAt: 5, done: 3, total: 10 } })).toEqual({
      startedAt: 5,
      done: 3,
      total: 10
    })
    expect(readReindex({ status: null })).toBeNull()
    expect(readReindex(null)).toBeNull()
  })

  it('ignores a rebuild with no files, and clamps done past total', () => {
    // A bar over zero files means nothing, and a bar past 100% is a lie.
    expect(readReindex({ status: { startedAt: 5, done: 0, total: 0 } })).toBeNull()
    expect(readReindex({ status: { startedAt: 5, done: 99, total: 10 } })?.done).toBe(10)
  })

  it('fills in a start time an older desktop does not send', () => {
    // 0, not Date.now(): a clock seeded from "now" on every push would reset
    // each tick and never advance. The UI reads 0 as "no start time".
    expect(readReindex({ status: { done: 1, total: 2 } })?.startedAt).toBe(0)
  })
})

describe('composing the card', () => {
  it('draws nothing when the desktop is not rebuilding', () => {
    expect(composeOverlay(null)).toBeNull()
  })

  it('carries the count onto the card', () => {
    expect(composeOverlay({ startedAt: 9, done: 1, total: 2 })).toEqual({
      kind: 'reindex',
      id: 'reindex',
      startedAt: 9,
      done: 1,
      total: 2
    })
  })
})

describe('the store', () => {
  it('folds a reindex push and retires it on null', () => {
    applyOverlayReindex({ startedAt: 1, done: 1, total: 2 })
    expect(useOverlayStore.getState().reindex).not.toBeNull()
    applyOverlayReindex(null)
    expect(useOverlayStore.getState().reindex).toBeNull()
  })

  it('empties on a dropped tunnel', () => {
    // The card asserts something is happening right now on a machine this
    // one can no longer see.
    applyOverlayReindex({ startedAt: 1, done: 1, total: 2 })
    clearOverlays()
    expect(useOverlayStore.getState()).toEqual({ reindex: null })
  })
})

describe('seeding on connect', () => {
  it('takes the desktop’s answer', async () => {
    mockRpc.mockResolvedValue({ reindex: { startedAt: 4, done: 2, total: 8 } })
    await seedOverlays()
    expect(useOverlayStore.getState().reindex).toEqual({ startedAt: 4, done: 2, total: 8 })
  })

  it('leaves the stack empty when the desktop is too old to answer', async () => {
    // An unsupported method is not a sick tunnel and nothing the user asked
    // for has failed, so this must neither throw nor report a failure — the
    // stack simply waits for the next push, as it did before the card existed.
    mockRpc.mockRejectedValue(new Error('unknown method'))
    await expect(seedOverlays()).resolves.toBeUndefined()
    expect(useOverlayStore.getState().reindex).toBeNull()
  })

  it('does not call out over a dead tunnel', async () => {
    link.connected = false
    await seedOverlays()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('loses to a push that landed while it was in flight', async () => {
    // The seed goes out on the same edge that attaches the push handlers, so
    // this is not a rare interleaving — it is one round trip wide, every
    // reconnect. Without the guard the answer arrives describing a world that
    // has already moved on and puts the finished rebuild back on screen, and
    // the push that ended it was very likely the last one the desktop had to
    // send.
    let answer!: (value: unknown) => void
    mockRpc.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve
      })
    )
    const seeding = seedOverlays()

    applyOverlayReindex(null)
    answer({ reindex: { startedAt: 1, done: 1, total: 2 } })
    await seeding

    expect(useOverlayStore.getState().reindex).toBeNull()
  })

  it('applies when nothing else wrote while it waited', async () => {
    // The other half of the guard: a quiet round trip must still seed, or a
    // phone connecting mid-rebuild shows nothing until it ends.
    mockRpc.mockResolvedValue({ reindex: { startedAt: 1, done: 1, total: 2 } })
    await seedOverlays()
    expect(useOverlayStore.getState().reindex).not.toBeNull()
  })
})
