jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * The Updates screen's desktop card: the controls that drive the PAIRED
 * DESKTOP's updater from this phone.
 *
 * The store contract is pinned in lib/sync/__tests__/updater.test.ts; this is
 * the half that only exists on screen, and its two silent failure modes are
 * what the assertions chase. The wire: a tap on Check or on the dialog's
 * confirm has to leave as the named RPC (`desktop.updater.check` /
 * `desktop.updater.install`) — a mistyped method would render exactly like
 * the real thing while going nowhere. The gate: install RESTARTS the desktop,
 * so nothing may leave before the dialog's confirm, and a cancel must leave
 * nothing at all.
 *
 * The dead state is load-bearing too: paired with no live mirror
 * (disconnected, an old desktop) the check row stays on the card but its
 * button is disabled — visible, and inert on the wire.
 *
 * No hand-rolled `act`: every tap is a fireEvent settled by waitFor.
 */

const mockRpc = jest.fn()

jest.mock('@/lib/tunnel/client', () => ({
  tunnelClient: {
    get active() {
      return { rpc: mockRpc, connected: true }
    },
    get connected() {
      return true
    },
    subscribe: () => () => undefined,
    reportRpcFailure: jest.fn()
  }
}))

// Mutable so the demo-mode block can unpair; reset in beforeEach.
const mockAppState = { paired: true, otaEnabled: false, setOtaEnabled: jest.fn() }
jest.mock('@/state/appStore', () => {
  const useAppStore = (selector: (s: typeof mockAppState) => unknown): unknown =>
    selector(mockAppState)
  useAppStore.getState = (): typeof mockAppState => mockAppState
  return { useAppStore }
})

// The This-app card reads the OTA runtime; none of it exists under jest, and
// none of it is under test here — the desktop card is.
jest.mock('expo-updates', () => ({
  isEnabled: false,
  isEmbeddedLaunch: true,
  updateId: null,
  runtimeVersion: null,
  createdAt: null
}))

const mockToastShow = jest.fn()
jest.mock('@/providers/toast/useToast', () => ({
  useToast: () => ({ show: mockToastShow, dismiss: jest.fn() })
}))

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
jest.mock('expo-router', () => ({ router: { back: jest.fn(), push: jest.fn() } }))

import UpdatesScreen from '@/app/settings/updates'
import { LocaleContext } from '@/providers/locale/useLocale'
import { ThemeContext } from '@/providers/theme/useTheme'
import { Rpc } from '@/lib/tunnel/protocol'
import { applyUpdaterPush, clearDesktopUpdater, readUpdaterState } from '@/lib/sync/updater'
import type { UpdaterWireState } from '@/lib/tunnel/protocol'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import '@/lib/i18n'

function push(over: Partial<UpdaterWireState>): void {
  applyUpdaterPush(
    readUpdaterState({ state: { phase: 'idle', version: null, percent: 0, error: null, ...over } })
  )
}

async function draw(): Promise<void> {
  await render(
    <ThemeContext.Provider
      value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
    >
      <LocaleContext.Provider
        value={{ locale: 'en', isRtl: false, setLocale: async () => undefined }}
      >
        <UpdatesScreen />
      </LocaleContext.Provider>
    </ThemeContext.Provider>
  )
}

const installCalls = (): unknown[][] =>
  mockRpc.mock.calls.filter(([method]) => method === Rpc.updaterInstall)

beforeEach(() => {
  mockRpc.mockReset()
  mockToastShow.mockReset()
  mockAppState.paired = true
  clearDesktopUpdater()
})

describe('the desktop card without a live mirror', () => {
  it('keeps the check row while paired, with its button dead', async () => {
    await draw()
    // Both cards keep their "Check for updates" row; the desktop twin's
    // button is disabled, and a press on it must leave nothing on the wire.
    expect(screen.getAllByText('Check for updates')).toHaveLength(2)
    expect(screen.queryByText('Install downloaded update')).toBeNull()

    const buttons = screen.getAllByText('Check')
    expect(buttons[buttons.length - 1]).toBeDisabled()
    fireEvent.press(buttons[buttons.length - 1])
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockToastShow).not.toHaveBeenCalled()
  })
})

describe('demo mode', () => {
  it('keeps the check row, answering up to date without a wire', async () => {
    mockAppState.paired = false
    await draw()

    // The demo's mirror is always empty, so the check row IS the feature —
    // and the install flow stays unreachable, which is the truth.
    expect(screen.getAllByText('Check for updates')).toHaveLength(2)
    expect(screen.queryByText('Install downloaded update')).toBeNull()

    const buttons = screen.getAllByText('Check')
    fireEvent.press(buttons[buttons.length - 1])

    await waitFor(() =>
      expect(mockToastShow).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Up to date', tone: 'success' })
      )
    )
    expect(mockRpc).not.toHaveBeenCalled()
  })
})

describe('checking from the phone', () => {
  it('sends desktop.updater.check and reports up to date', async () => {
    push({ phase: 'idle' })
    mockRpc.mockResolvedValue({ ok: true, version: null })
    await draw()

    expect(screen.getAllByText('Check for updates')).toHaveLength(2)
    // Two Check buttons on the screen; the desktop card renders second.
    const buttons = screen.getAllByText('Check')
    fireEvent.press(buttons[buttons.length - 1])

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith(Rpc.updaterCheck))
    await waitFor(() =>
      expect(mockToastShow).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Up to date', tone: 'success' })
      )
    )
  })

  it('says nothing on found — the phase pushes are the announcement', async () => {
    push({ phase: 'idle' })
    mockRpc.mockResolvedValue({ ok: true, version: '9.9.9' })
    await draw()

    const buttons = screen.getAllByText('Check')
    fireEvent.press(buttons[buttons.length - 1])

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith(Rpc.updaterCheck))
    expect(mockToastShow).not.toHaveBeenCalled()
  })
})

describe('watching a download', () => {
  it('renders the phase and the percent straight off the push', async () => {
    push({ phase: 'downloading', version: '9.9.9', percent: 42 })
    await draw()
    expect(screen.getByText('Downloading update')).toBeTruthy()
    expect(screen.getByText(/42%/)).toBeTruthy()
    expect(screen.getByText('v9.9.9')).toBeTruthy()
  })
})

describe('installing from the phone', () => {
  it('sends nothing until the restart dialog is confirmed', async () => {
    push({ phase: 'ready', version: '9.9.9' })
    mockRpc.mockResolvedValue({ ok: true })
    await draw()

    expect(screen.getByText('Install downloaded update')).toBeTruthy()
    fireEvent.press(screen.getByText('Update'))

    // The dialog names the act — an install restarts that machine.
    const confirm = await screen.findByText('Update and restart')
    expect(screen.getByText(/install v9\.9\.9 and restart/)).toBeTruthy()
    expect(installCalls()).toHaveLength(0)

    fireEvent.press(confirm)
    await waitFor(() => expect(installCalls()).toHaveLength(1))
    await waitFor(() =>
      expect(mockToastShow).toHaveBeenCalledWith(
        expect.objectContaining({ tone: 'success', message: expect.stringContaining('restarting') })
      )
    )
  })

  it('a cancelled dialog sends nothing at all', async () => {
    push({ phase: 'ready', version: '9.9.9' })
    await draw()

    fireEvent.press(screen.getByText('Update'))
    fireEvent.press(await screen.findByText('Cancel'))

    await waitFor(() => expect(screen.queryByText('Update and restart')).toBeNull())
    expect(installCalls()).toHaveLength(0)
  })

  it('a refused install says check first, and the row stays ready', async () => {
    push({ phase: 'ready', version: '9.9.9' })
    mockRpc.mockResolvedValue({ ok: false })
    await draw()

    fireEvent.press(screen.getByText('Update'))
    fireEvent.press(await screen.findByText('Update and restart'))

    await waitFor(() =>
      expect(mockToastShow).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error' }))
    )
    expect(screen.getByText('Install downloaded update')).toBeTruthy()
  })
})

describe('the error phase', () => {
  it('translates the code and offers a retry that re-checks', async () => {
    push({
      phase: 'error',
      error: { code: 'network', message: 'raw transport text', detail: null }
    })
    mockRpc.mockResolvedValue({ ok: true, version: null })
    await draw()

    expect(screen.getByText('Update failed')).toBeTruthy()
    expect(screen.getByText(/update server/)).toBeTruthy()

    fireEvent.press(screen.getByText('Retry'))
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith(Rpc.updaterCheck))
  })
})
