/**
 * What a return to the foreground is allowed to cost, by where it came from.
 *
 * 'background' is the real away: iOS suspends JS within seconds there, the
 * socket is presumed dead and pushes sent meanwhile are gone — so that return
 * probes the link and reconciles what was missed. 'inactive' is not away at
 * all: the control centre, the notification shade, a permission sheet, an
 * incoming-call banner. JS keeps running and the socket keeps its keepalive
 * cadence throughout, so a return from a dip must cost NOTHING — kicking
 * there put a short-fuse probe and a visible resync in the middle of active
 * use, and the probe could kill the very socket it was checking.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

const mockRefreshPush = jest.fn()
const mockReconcilePresented = jest.fn()
jest.mock('@/lib/notifications/push', () => ({
  refreshPushRegistration: () => mockRefreshPush(),
  reconcilePresentedNotifications: () => mockReconcilePresented()
}))
jest.mock('@/lib/sync/overlays', () => ({ seedOverlays: jest.fn(), clearOverlays: jest.fn() }))
jest.mock('@/lib/sync/updater', () => ({
  seedDesktopUpdater: jest.fn(),
  clearDesktopUpdater: jest.fn()
}))
const mockReconcile = jest.fn(async () => undefined)
jest.mock('@/lib/sync/sync', () => ({
  attachLiveUpdates: jest.fn(),
  reconcile: () => mockReconcile()
}))
jest.mock('@/lib/sync/prompt', () => ({
  attachTurnStream: jest.fn(),
  seedActiveRuns: jest.fn(async () => undefined)
}))

// `mock`-prefixed: jest hoists these factories above the file, and only names
// it can prove are mocks may cross that boundary.
const mockResume = jest.fn(async () => true)
let mockConnected = true
jest.mock('@/lib/tunnel/client', () => ({
  tunnelClient: {
    resume: () => mockResume(),
    subscribe: () => () => undefined,
    get connected() {
      return mockConnected
    }
  }
}))

jest.mock('expo-network', () => ({
  addNetworkStateListener: () => ({ remove: jest.fn() })
}))

import { useConnection } from '@/lib/sync/useConnection'
import { useAppStore } from '@/state/appStore'
import { cleanup, render } from '@testing-library/react-native'
import { AppState, type AppStateStatus } from 'react-native'

function Host(): null {
  useConnection()
  return null
}

let emitAppState: ((state: AppStateStatus) => void) | null = null

/** Mount a paired, connected phone and hand back the AppState emitter, with
 *  the mount's own kick already accounted for — every assertion below is
 *  about which returns are allowed to cost anything. */
async function mount(): Promise<(state: AppStateStatus) => void> {
  useAppStore.setState({ paired: true })
  await render(<Host />)
  mockResume.mockClear()
  mockReconcile.mockClear()
  return (state) => emitAppState?.(state)
}

beforeEach(() => {
  AppState.currentState = 'active'
  mockConnected = true
  emitAppState = null
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_type: string, handler: (state: AppStateStatus) => void) => {
      emitAppState = handler
      return { remove: jest.fn() } as ReturnType<typeof AppState.addEventListener>
    })
  mockResume.mockClear()
  mockReconcile.mockClear()
  mockRefreshPush.mockClear()
  mockReconcilePresented.mockClear()
})

afterEach(() => {
  cleanup()
  jest.restoreAllMocks()
  useAppStore.setState({ paired: false })
})

describe('returning to the foreground', () => {
  it('costs nothing after an inactive dip while connected', async () => {
    const appState = await mount()

    // The control centre swipe: active → inactive → active, socket healthy
    // and delivering the whole time.
    appState('inactive')
    appState('active')

    expect(mockResume).not.toHaveBeenCalled()
    expect(mockReconcile).not.toHaveBeenCalled()
  })

  it('probes and reconciles after a real background', async () => {
    const appState = await mount()

    appState('background')
    appState('active')

    // The away state: the socket is presumed dead and pushes were missable —
    // this return earns both the probe and the catch-up.
    expect(mockResume).toHaveBeenCalledTimes(1)
    expect(mockReconcile).toHaveBeenCalledTimes(1)
  })

  it('still kicks a disconnected tunnel from any return', async () => {
    const appState = await mount()
    mockConnected = false

    appState('inactive')
    appState('active')

    // Not connected: the kick joins or hurries a reconnect that is already
    // owed, and the catch-up waits for the connection it needs.
    expect(mockResume).toHaveBeenCalledTimes(1)
    expect(mockReconcile).not.toHaveBeenCalled()
  })

  it('keeps the push-registration contract on every return', async () => {
    const appState = await mount()
    mockRefreshPush.mockClear()
    mockReconcilePresented.mockClear()

    appState('inactive')
    appState('active')

    // Cheap, idempotent, and the token contract predates the gating — a dip
    // must not be the reason a rotated token misses its re-upsert.
    expect(mockRefreshPush).toHaveBeenCalledTimes(1)
    expect(mockReconcilePresented).toHaveBeenCalledTimes(1)
  })
})
