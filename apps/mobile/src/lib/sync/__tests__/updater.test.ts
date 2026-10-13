/**
 * The desktop-updater mirror: what the wire is allowed to say, when the store
 * may claim a phase, and what each driving action reports back.
 *
 * Three failure modes are worth pinning and none crashes. Version skew — a
 * NEWER desktop can send a phase this build has no view for, and an unknown
 * phase must degrade to 'idle' (no card) rather than an undefined branch.
 * The seed race — the seed goes out on the same edge that attaches the push
 * handlers, so an answer describing a pre-push world must lose. And the
 * install's lost answer — the restart the install causes can take the
 * connection (and the RPC reply) with it, which has to read as 'unknown',
 * never as a refusal the phone would then claim to the user.
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
  applyUpdaterPush,
  checkDesktopUpdate,
  clearDesktopUpdater,
  installDesktopUpdate,
  readUpdaterState,
  seedDesktopUpdater,
  useDesktopUpdater
} from '@/lib/sync/updater'
import type { UpdaterWireState } from '@/lib/tunnel/protocol'

function wire(over: Partial<UpdaterWireState> = {}): { state: UpdaterWireState } {
  return {
    state: { phase: 'idle', version: null, percent: 0, error: null, ...over }
  }
}

beforeEach(() => {
  mockRpc.mockReset()
  link.connected = true
  clearDesktopUpdater()
})

describe('reading the wire', () => {
  it('reads a full state whole', () => {
    expect(readUpdaterState(wire({ phase: 'downloading', version: '1.2.3', percent: 42 }))).toEqual(
      { phase: 'downloading', version: '1.2.3', percent: 42, error: null }
    )
  })

  it('treats a phase it does not know as idle', () => {
    // A newer desktop's phase must degrade to "no card", never to an
    // undefined branch in the row that switches on it.
    expect(readUpdaterState(wire({ phase: 'osmosing' as never }))?.phase).toBe('idle')
  })

  it('clamps percent to what a progress bar can draw', () => {
    expect(readUpdaterState(wire({ percent: 180 }))?.percent).toBe(100)
    expect(readUpdaterState(wire({ percent: -3 }))?.percent).toBe(0)
    expect(readUpdaterState(wire({ percent: Number.NaN }))?.percent).toBe(0)
  })

  it('normalizes an error and defaults a code it cannot read', () => {
    expect(
      readUpdaterState(wire({ phase: 'error', error: { code: 'network' } as never }))?.error
    ).toEqual({ code: 'network', message: '', detail: null })
    expect(
      readUpdaterState(wire({ phase: 'error', error: { message: 'boom' } as never }))?.error
    ).toEqual({ code: 'unknown', message: 'boom', detail: null })
  })

  it('reads junk as null — including the honest null of a desktop without an updater', () => {
    expect(readUpdaterState(null)).toBeNull()
    expect(readUpdaterState({})).toBeNull()
    expect(readUpdaterState({ state: null })).toBeNull()
    expect(readUpdaterState({ state: 'ready' })).toBeNull()
  })
})

describe('the store', () => {
  it('folds a push whole and ignores a malformed one', () => {
    applyUpdaterPush(readUpdaterState(wire({ phase: 'downloading', percent: 10 })))
    expect(useDesktopUpdater.getState().state?.percent).toBe(10)
    // A frame this build cannot parse keeps the last known state — clearing
    // mid-download over one junk push would blank a live progress bar.
    applyUpdaterPush(readUpdaterState({ state: 7 }))
    expect(useDesktopUpdater.getState().state?.percent).toBe(10)
  })

  it('empties on a dropped tunnel', () => {
    // Every phase asserts something is happening right now on a machine this
    // one can no longer see — and mid-install the drop IS the restart.
    applyUpdaterPush(readUpdaterState(wire({ phase: 'ready', version: '2.0.0' })))
    clearDesktopUpdater()
    expect(useDesktopUpdater.getState().state).toBeNull()
  })
})

describe('seeding on connect', () => {
  it('takes the desktop’s answer whole', async () => {
    mockRpc.mockResolvedValue(wire({ phase: 'verifying', version: '2.0.0', percent: 100 }))
    await seedDesktopUpdater()
    expect(useDesktopUpdater.getState().state?.phase).toBe('verifying')
  })

  it('stays hidden when the desktop cannot self-update', async () => {
    // `{ state: null }` is an answer, not an error: the desktop is present
    // and saying no. The controls hide, exactly the pre-feature screen.
    applyUpdaterPush(readUpdaterState(wire({ phase: 'ready' })))
    mockRpc.mockResolvedValue({ state: null })
    clearDesktopUpdater()
    await seedDesktopUpdater()
    expect(useDesktopUpdater.getState().state).toBeNull()
  })

  it('leaves the mirror empty when the desktop is too old to answer', async () => {
    mockRpc.mockRejectedValue(new Error('no handler for desktop.updater.state'))
    await expect(seedDesktopUpdater()).resolves.toBeUndefined()
    expect(useDesktopUpdater.getState().state).toBeNull()
  })

  it('does not call out over a dead tunnel', async () => {
    link.connected = false
    await seedDesktopUpdater()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('loses to a push that landed while it was in flight', async () => {
    // Same one-round-trip-wide race as the overlay seed: an answer from
    // before the push must not put the old phase back.
    let answer!: (value: unknown) => void
    mockRpc.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve
      })
    )
    const seeding = seedDesktopUpdater()

    applyUpdaterPush(readUpdaterState(wire({ phase: 'ready', version: '2.0.0' })))
    answer(wire({ phase: 'downloading', version: '2.0.0', percent: 50 }))
    await seeding

    expect(useDesktopUpdater.getState().state?.phase).toBe('ready')
  })
})

describe('driving the desktop', () => {
  it('maps a check to found / up to date / failed', async () => {
    mockRpc.mockResolvedValueOnce({ ok: true, version: '2.0.0' })
    expect(await checkDesktopUpdate()).toEqual({ outcome: 'found', version: '2.0.0' })
    mockRpc.mockResolvedValueOnce({ ok: true, version: null })
    expect(await checkDesktopUpdate()).toEqual({ outcome: 'upToDate' })
    mockRpc.mockResolvedValueOnce({ ok: false, error: 'ENOTFOUND' })
    expect(await checkDesktopUpdate()).toEqual({ outcome: 'failed' })
    mockRpc.mockRejectedValueOnce(new Error('gone'))
    expect(await checkDesktopUpdate()).toEqual({ outcome: 'failed' })
  })

  it('refuses to check while offline', async () => {
    link.connected = false
    expect(await checkDesktopUpdate()).toEqual({ outcome: 'offline' })
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('flips the mirror to installing the moment an install is armed', async () => {
    // The desktop's own 'installing' push races the restart; the phone must
    // not depend on winning that race to disable its button.
    applyUpdaterPush(readUpdaterState(wire({ phase: 'ready', version: '2.0.0' })))
    mockRpc.mockResolvedValue({ ok: true })
    expect(await installDesktopUpdate()).toBe('armed')
    expect(useDesktopUpdater.getState().state?.phase).toBe('installing')
  })

  it('reports a clean refusal without touching the mirror', async () => {
    applyUpdaterPush(readUpdaterState(wire({ phase: 'ready', version: '2.0.0' })))
    mockRpc.mockResolvedValue({ ok: false })
    expect(await installDesktopUpdate()).toBe('refused')
    expect(useDesktopUpdater.getState().state?.phase).toBe('ready')
  })

  it('reports a lost answer as unknown, never as a refusal', async () => {
    // The reply may have died with the connection the restart closed. The
    // caller says "if it began, the desktop reconnects shortly" — it must not
    // claim a failure it cannot know.
    applyUpdaterPush(readUpdaterState(wire({ phase: 'ready', version: '2.0.0' })))
    mockRpc.mockRejectedValue(new Error('tunnel closed'))
    expect(await installDesktopUpdate()).toBe('unknown')
  })

  it('refuses to install while offline', async () => {
    link.connected = false
    expect(await installDesktopUpdate()).toBe('offline')
    expect(mockRpc).not.toHaveBeenCalled()
  })
})
