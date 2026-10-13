jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * The Relay screen in demo mode, and the settings row that opens it.
 *
 * The tour used to have no Relay screen at all; now it describes a made-up
 * link (lib/demo/relay) that must LOOK exactly like a healthy paired one —
 * connected face, stable fingerprints, the real relay endpoint — while its
 * three actions stay honest about what a demo can actually do. The wire is
 * what the assertions chase: Sync must answer from the saved snapshot and
 * never call the live sync module, Reconnect must move the fiction's own
 * counters, and Unpair must run the demo wipe and land on the door — never
 * touching the tunnel, badges or push registration that only a pairing owns.
 *
 * The paired path is pinned alongside so the demo branch cannot silently
 * swallow it: a real unpair still clears badges, unregisters push and drops
 * the socket before the wipe.
 *
 * No hand-rolled `act`: every tap is a fireEvent settled by waitFor.
 */

jest.mock('@/lib/tunnel/client', () => ({
  tunnelClient: {
    state: null,
    subscribe: () => () => undefined,
    suspend: jest.fn(),
    resume: jest.fn(),
    disconnect: jest.fn(),
    reportRpcFailure: jest.fn()
  }
}))

jest.mock('@/lib/demo/factoryReset', () => ({ factoryResetDevice: jest.fn() }))
jest.mock('@/lib/demo/importer', () => ({ applyConfigSnapshot: jest.fn() }))
jest.mock('@/lib/notifications/push', () => ({
  clearAllBadges: jest.fn(),
  unregisterPush: jest.fn()
}))
jest.mock('@/lib/sync/activity', () => ({
  beginSync: () => ({ step: jest.fn(), end: jest.fn() })
}))
jest.mock('@/lib/sync/sync', () => ({
  getLastSyncedAt: () => null,
  refreshConfig: jest.fn(),
  refreshSync: jest.fn()
}))

// Mutable so each block can pick its mode; reset in beforeEach.
const mockAppState = { paired: false, demoMode: true, setPaired: jest.fn() }
jest.mock('@/state/appStore', () => {
  const useAppStore = (selector: (s: typeof mockAppState) => unknown): unknown =>
    selector(mockAppState)
  useAppStore.getState = (): typeof mockAppState => mockAppState
  return { useAppStore }
})

const mockToastShow = jest.fn()
jest.mock('@/providers/toast/useToast', () => ({
  useToast: () => ({ show: mockToastShow, dismiss: jest.fn() })
}))

// The settings list's trailing summaries read stores this test does not
// exercise; the list's shape — which rows exist — is what is under test.
jest.mock('@/components/settings/TabSummaries', () => {
  const summaries = [
    'AppearanceSummary',
    'CapabilitiesSummary',
    'ChannelsSummary',
    'DataSummary',
    'KnowledgeSummary',
    'McpSummary',
    'ModelSummary',
    'PreferencesSummary',
    'ServicesSummary',
    'UpdatesSummary',
    'UsageSummary',
    'VariablesSummary'
  ]
  return Object.fromEntries(summaries.map((name) => [name, (): null => null]))
})
jest.mock('@/lib/sync/useFreshConfig', () => ({ useFreshConfig: () => undefined }))

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), canGoBack: jest.fn(() => true), push: jest.fn(), replace: jest.fn() }
}))
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }))

import RelayScreen from '@/app/settings/relay'
import SettingsScreen from '@/app/settings/index'
import { factoryResetDevice } from '@/lib/demo/factoryReset'
import { applyConfigSnapshot } from '@/lib/demo/importer'
import { resetDemoRelay } from '@/lib/demo/relay'
import { clearAllBadges, unregisterPush } from '@/lib/notifications/push'
import { refreshConfig, refreshSync } from '@/lib/sync/sync'
import { tunnelClient } from '@/lib/tunnel/client'
import { LocaleContext } from '@/providers/locale/useLocale'
import { ThemeContext } from '@/providers/theme/useTheme'
import { router } from 'expo-router'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import '@/lib/i18n'

const mockFactoryReset = jest.mocked(factoryResetDevice)
const mockApplySnapshot = jest.mocked(applyConfigSnapshot)
const mockClearAllBadges = jest.mocked(clearAllBadges)
const mockUnregisterPush = jest.mocked(unregisterPush)
const mockRefreshConfig = jest.mocked(refreshConfig)
const mockRefreshSync = jest.mocked(refreshSync)
const mockDisconnect = jest.mocked(tunnelClient.disconnect)
const mockSuspend = jest.mocked(tunnelClient.suspend)
const mockResume = jest.mocked(tunnelClient.resume)
const mockReplace = jest.mocked(router.replace)

async function draw(element: React.JSX.Element): Promise<void> {
  await render(
    <ThemeContext.Provider
      value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
    >
      <LocaleContext.Provider
        value={{ locale: 'en', isRtl: false, setLocale: async () => undefined }}
      >
        {element}
      </LocaleContext.Provider>
    </ThemeContext.Provider>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockAppState.paired = false
  mockAppState.demoMode = true
  mockFactoryReset.mockResolvedValue(undefined)
  mockApplySnapshot.mockResolvedValue(true)
  mockClearAllBadges.mockResolvedValue(undefined)
  mockUnregisterPush.mockResolvedValue(undefined)
  mockDisconnect.mockResolvedValue(undefined)
  mockResume.mockResolvedValue(true)
  resetDemoRelay()
})

describe('the settings list row', () => {
  it('shows Relay wearing the connected face in demo mode', async () => {
    await draw(<SettingsScreen />)
    expect(screen.getByText('Relay')).toBeTruthy()
    expect(screen.getByText('Connected')).toBeTruthy()
  })

  it('is absent on the door — neither paired nor demo', async () => {
    mockAppState.demoMode = false
    await draw(<SettingsScreen />)
    expect(screen.queryByText('Relay')).toBeNull()
  })
})

describe('the demo link on screen', () => {
  it('renders connected, with the made-up details a paired screen would show', async () => {
    await draw(<RelayScreen />)

    expect(screen.getByText('Connected')).toBeTruthy()
    // The real endpoint and the fiction's stable short forms — the page must
    // read like a paired one, not like a placeholder.
    expect(screen.getByText('wss://relay.wolffi.sh')).toBeTruthy()
    expect(screen.getByText('9d4f…07a2')).toBeTruthy()
    expect(screen.getByText('6b1e…c8d3')).toBeTruthy()
    expect(screen.getByText('f27c…5a91')).toBeTruthy()
    expect(screen.getByText('3e8b…d6f0')).toBeTruthy()
    // Up for hours, not since the tap that opened the screen.
    expect(screen.getByText('3h')).toBeTruthy()
  })

  it('Sync answers from the snapshot and never calls the live sync module', async () => {
    await draw(<RelayScreen />)

    const buttons = screen.getAllByText('Sync')
    fireEvent.press(buttons[buttons.length - 1])

    await waitFor(() =>
      expect(mockToastShow).toHaveBeenCalledWith(
        expect.objectContaining({ tone: 'success', message: expect.stringContaining('Up to date') })
      )
    )
    expect(mockApplySnapshot).toHaveBeenCalled()
    expect(mockRefreshConfig).not.toHaveBeenCalled()
    expect(mockRefreshSync).not.toHaveBeenCalled()
  })

  it("Reconnect moves the fiction's own counter, not the tunnel", async () => {
    await draw(<RelayScreen />)

    fireEvent.press(screen.getAllByText('Reconnect')[1])

    // The reconnect counter is the only row that can read '1'.
    expect(await screen.findByText('1')).toBeTruthy()
    expect(mockSuspend).not.toHaveBeenCalled()
    expect(mockResume).not.toHaveBeenCalled()
  })
})

describe('leaving the demo', () => {
  it('unpair runs the demo wipe and lands on the door', async () => {
    await draw(<RelayScreen />)

    // The dialog tells the demo truth — sample data, not keys.
    fireEvent.press(screen.getAllByText('Unpair')[1])
    expect(await screen.findByText('Leave the demo?')).toBeTruthy()
    const withDialog = screen.getAllByText('Unpair')
    fireEvent.press(withDialog[withDialog.length - 1])

    await waitFor(() => expect(mockFactoryReset).toHaveBeenCalled())
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'))
    // Nothing a pairing owns is touched: no socket, no badges, no push.
    expect(mockDisconnect).not.toHaveBeenCalled()
    expect(mockClearAllBadges).not.toHaveBeenCalled()
    expect(mockUnregisterPush).not.toHaveBeenCalled()
    expect(mockAppState.setPaired).not.toHaveBeenCalled()
  })
})

describe('the paired path, unchanged', () => {
  it('unpair still clears badges, unregisters push and drops the socket before the wipe', async () => {
    mockAppState.paired = true
    mockAppState.demoMode = false
    await draw(<RelayScreen />)

    // Row title renders before the row button, and the dialog's confirm last.
    fireEvent.press(screen.getAllByText('Unpair')[1])
    expect(await screen.findByText('Unpair from this desktop?')).toBeTruthy()
    const withDialog = screen.getAllByText('Unpair')
    fireEvent.press(withDialog[withDialog.length - 1])

    await waitFor(() => expect(mockFactoryReset).toHaveBeenCalled())
    expect(mockClearAllBadges).toHaveBeenCalled()
    expect(mockUnregisterPush).toHaveBeenCalled()
    expect(mockDisconnect).toHaveBeenCalled()
    expect(mockAppState.setPaired).toHaveBeenCalledWith(false)
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/'))
  })
})
