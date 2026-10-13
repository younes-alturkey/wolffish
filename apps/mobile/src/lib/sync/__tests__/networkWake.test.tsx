/**
 * What the tunnel does when the NETWORK moves under it.
 *
 * This listener exists for one case the rest of the app is blind to: walking
 * out of wifi range onto cellular. The phone never backgrounds, the user never
 * taps anything, and the socket is dead the instant the interface it was bound
 * to goes away — but the OS still reports it OPEN, so nothing at all says so
 * until the transport's own watchdog gets there, up to half a minute later.
 *
 * The edges are the whole design, and both mistakes are real: too eager and a
 * phone reconnects on every spurious report while it sits on one network; too
 * shy and the handoff it was written for goes unnoticed.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

jest.mock('@/lib/notifications/push', () => ({
  refreshPushRegistration: jest.fn(),
  reconcilePresentedNotifications: jest.fn()
}))
jest.mock('@/lib/sync/overlays', () => ({ seedOverlays: jest.fn(), clearOverlays: jest.fn() }))
jest.mock('@/lib/sync/updater', () => ({
  seedDesktopUpdater: jest.fn(),
  clearDesktopUpdater: jest.fn()
}))
jest.mock('@/lib/sync/sync', () => ({
  attachLiveUpdates: jest.fn(),
  reconcile: jest.fn(async () => undefined)
}))
jest.mock('@/lib/sync/prompt', () => ({
  attachTurnStream: jest.fn(),
  seedActiveRuns: jest.fn(async () => undefined)
}))

// `mock`-prefixed: jest hoists these factories above the file, and only names
// it can prove are mocks may cross that boundary.
const mockResume = jest.fn(async () => true)
jest.mock('@/lib/tunnel/client', () => ({
  tunnelClient: {
    resume: () => mockResume(),
    subscribe: () => () => undefined,
    get connected() {
      return false
    }
  }
}))

type NetworkEvent = { type?: string; isConnected?: boolean; isInternetReachable?: boolean }
let mockEmit: ((event: NetworkEvent) => void) | null = null
const mockRemove = jest.fn()
jest.mock('expo-network', () => ({
  addNetworkStateListener: (listener: (event: NetworkEvent) => void) => {
    mockEmit = listener
    return { remove: mockRemove }
  }
}))

import { useConnection } from '@/lib/sync/useConnection'
import { useAppStore } from '@/state/appStore'
import { cleanup, render } from '@testing-library/react-native'
import { AppState, type AppStateStatus } from 'react-native'

function Host(): null {
  useConnection()
  return null
}

/** Mount a paired phone and hand back the emitter, with the mount's own kick
 *  already accounted for — every assertion below is about network edges. */
async function mount(): Promise<(event: NetworkEvent) => void> {
  useAppStore.setState({ paired: true })
  await render(<Host />)
  mockResume.mockClear()
  return (event) => mockEmit?.(event)
}

const WIFI = { type: 'WIFI', isConnected: true, isInternetReachable: true }
const CELLULAR = { type: 'CELLULAR', isConnected: true, isInternetReachable: true }
const NONE = { type: 'NONE', isConnected: false, isInternetReachable: false }

beforeEach(() => {
  AppState.currentState = 'active'
  mockEmit = null
  mockResume.mockClear()
  mockRemove.mockClear()
})

afterEach(() => {
  cleanup()
  useAppStore.setState({ paired: false })
})

describe('network edges', () => {
  it('ignores the first report — there is nothing it changed from', async () => {
    const network = await mount()

    network(WIFI)

    // The mount's own kick already connected; treating the opening state as a
    // change would double every launch.
    expect(mockResume).not.toHaveBeenCalled()
  })

  it('reconnects on a wifi-to-cellular handoff', async () => {
    const network = await mount()
    network(WIFI)

    network(CELLULAR)

    // The case the whole listener exists for: still "connected" throughout, so
    // no other signal in the app fires, and the socket is already dead.
    expect(mockResume).toHaveBeenCalledTimes(1)
  })

  it('sits still while the network stays where it is', async () => {
    const network = await mount()
    network(WIFI)

    network(WIFI)
    network(WIFI)

    expect(mockResume).not.toHaveBeenCalled()
  })

  it('reconnects when the network comes back, and not when it goes', async () => {
    const network = await mount()
    network(WIFI)

    network(NONE)
    // Nothing to reconnect TO: dialing into a dead network only burns an
    // attempt and climbs the backoff ladder.
    expect(mockResume).not.toHaveBeenCalled()

    network(WIFI)
    expect(mockResume).toHaveBeenCalledTimes(1)
  })

  it('stays quiet while the app is in the background', async () => {
    const network = await mount()
    network(WIFI)
    AppState.currentState = 'background'

    network(CELLULAR)

    // A phone in a pocket changes network constantly, and coming back to the
    // app runs its own kick — so this would be pure churn.
    expect(mockResume).not.toHaveBeenCalled()
  })

  it('still fires when the app state is not yet known', async () => {
    const network = await mount()
    network(WIFI)
    // Early in launch RN has not set this at all. Treating unknown as "away"
    // would silently drop the reconnect on the one path this exists for.
    AppState.currentState = undefined as unknown as AppStateStatus

    network(CELLULAR)

    expect(mockResume).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes with the hook', async () => {
    useAppStore.setState({ paired: true })
    const view = await render(<Host />)

    // Awaited like render(): React 19 flushes the effect cleanup on the
    // microtask, and a bare unmount() asserts against a teardown that has not
    // happened yet.
    await view.unmount()

    // A listener outliving its hook would keep kicking a tunnel client that
    // nothing on screen is watching any more.
    expect(mockRemove).toHaveBeenCalled()
  })
})
