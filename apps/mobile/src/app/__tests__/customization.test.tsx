jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * The Customization screen — three documents, one editor, one write path.
 *
 * The sync contract itself is pinned in lib/sync/__tests__/customization.test.ts;
 * this is the half that only exists on screen. Three things here can be quietly
 * wrong while every unit test passes: the code block is a scroll view with a
 * press target inside it, which is exactly the arrangement where a tap stops
 * opening anything; the editor holds a draft while the store underneath keeps
 * moving, so a desktop edit arriving mid-typing must not re-seed the field; and
 * a refused save has to say so somewhere the user can actually see, which
 * inside a modal cannot be a toast.
 *
 * Every interaction is followed by `waitFor` rather than a bare assertion, and
 * nothing here calls `act` by hand: the editor is a Modal over an async write,
 * so nothing it does is settled in the tick its event fires in.
 */

const mockRpc = jest.fn()
let mockConnected = true

jest.mock('@/lib/tunnel/client', () => ({
  tunnelClient: {
    get active() {
      return mockConnected ? { rpc: mockRpc, connected: true } : null
    },
    get connected() {
      return mockConnected
    },
    subscribe: () => () => undefined,
    reportRpcFailure: jest.fn()
  }
}))

let mockPaired = true

// Both call shapes: the hook form (useSettingsReadOnly subscribes) and the
// imperative one (settingsAreReadOnly reads it on the write path).
jest.mock('@/state/appStore', () => {
  const useAppStore = (selector: (state: { paired: boolean }) => unknown): unknown =>
    selector({ paired: mockPaired })
  useAppStore.getState = (): { paired: boolean } => ({ paired: mockPaired })
  return { useAppStore }
})

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
// The toast confirms a save that has ALREADY closed the editor; what this file
// is about is the message that must survive the editor staying open, which is
// inline by construction. Stubbing it keeps the provider's animation runtime
// out of the tree too.
const mockToast = jest.fn()
jest.mock('@/providers/toast/useToast', () => ({
  useToast: () => ({ show: mockToast, dismiss: jest.fn() })
}))
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
jest.mock('expo-router', () => ({ router: { back: jest.fn(), push: jest.fn() } }))
// The screen's focus refresh belongs to the sync layer, which has its own
// tests; here it would only add an unawaited RPC to every render.
jest.mock('@/lib/sync/useFreshConfig', () => ({ useFreshConfig: () => undefined }))

import { ThemeContext } from '@/providers/theme/useTheme'
import CustomizationScreen from '@/app/settings/customization'
import { useDemoConfig } from '@/state/demoConfig'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import '@/lib/i18n'

async function draw(): Promise<void> {
  await render(
    <ThemeContext.Provider
      value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
    >
      <CustomizationScreen />
    </ThemeContext.Provider>
  )
}

/**
 * Tap a card and wait for the editor. `target` picks which of the card's two
 * press targets is used — the header row, or the code block itself.
 */
async function openEditor(name: string, target: 'header' | 'block' = 'header'): Promise<void> {
  fireEvent.press(screen.getAllByLabelText(`Edit ${name}`)[target === 'header' ? 0 : 1])
  await waitFor(() => expect(screen.getByLabelText(name)).toBeTruthy())
}

/** Type into the open editor and wait for the controlled field to hold it. */
async function typeInto(name: string, text: string): Promise<void> {
  fireEvent.changeText(screen.getByLabelText(name), text)
  await waitFor(() => expect(screen.getByLabelText(name).props.value).toBe(text))
}

/** Seed the store the way a landed snapshot would. */
function seed(soul: string, user = '# User', agents = '# Agents'): void {
  useDemoConfig.setState({
    soulMarkdown: soul,
    userMarkdown: user,
    agentsMarkdown: agents,
    customizationOversized: []
  })
}

beforeEach(() => {
  mockRpc.mockReset()
  mockRpc.mockResolvedValue({ ok: true })
  mockToast.mockClear()
  mockConnected = true
  mockPaired = true
  useDemoConfig.getState().reset()
})

describe('Customization screen', () => {
  it('shows all three documents with their paths and current text', async () => {
    seed('# Soul\nanswer first')
    await draw()

    expect(screen.getByText('Soul')).toBeTruthy()
    expect(screen.getByText('User')).toBeTruthy()
    expect(screen.getByText('Agents')).toBeTruthy()
    expect(screen.getByText('brain/identity/soul.md')).toBeTruthy()
    expect(screen.getByText('brain/identity/user.md')).toBeTruthy()
    expect(screen.getByText('brain/prefrontal/agents.md')).toBeTruthy()
    expect(screen.getByText('# Soul\nanswer first')).toBeTruthy()
  })

  it('says so rather than showing a blank block when a document is empty', async () => {
    seed('')
    await draw()

    expect(screen.getByText('Nothing written yet. Tap to start.')).toBeTruthy()
  })

  it('opens the editor from a tap on the code block itself', async () => {
    seed('# Soul\nanswer first')
    await draw()

    // The press target inside the scroll view — the one a finger lands on when
    // reading the document, and the one a scroller can quietly swallow.
    await openEditor('Soul', 'block')

    expect(screen.getByLabelText('Save')).toBeTruthy()
  })

  it('saves the edited document to the desktop and closes', async () => {
    seed('# Soul\nanswer first')
    await draw()

    await openEditor('Soul')
    await typeInto('Soul', '# Soul\nanswer first, always')
    fireEvent.press(screen.getByLabelText('Save'))

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('desktop.config.set', {
        settings: { soulMarkdown: '# Soul\nanswer first, always' }
      })
    )
    // Closed, confirmed, and the card behind it now shows what was written.
    await waitFor(() => expect(screen.queryByLabelText('Save')).toBeNull())
    expect(mockToast).toHaveBeenCalledWith({ tone: 'success', message: 'Saved to the desktop.' })
    expect(useDemoConfig.getState().soulMarkdown).toBe('# Soul\nanswer first, always')
  })

  it('keeps the draft and says why when the desktop refuses the write', async () => {
    seed('# Soul\nanswer first')
    mockRpc.mockImplementation((method: string) =>
      method === 'desktop.config.set'
        ? Promise.reject(new Error('not editable'))
        : Promise.resolve({})
    )
    await draw()

    await openEditor('Soul')
    await typeInto('Soul', 'a soul the desktop rejected')
    fireEvent.press(screen.getByLabelText('Save'))

    // Inline, not a toast — a toast raised inside an RN Modal never paints on
    // iOS — and the editor stays open precisely so the text is not lost.
    await waitFor(() => expect(screen.getByText("Couldn't save. Try again.")).toBeTruthy())
    expect(screen.getByLabelText('Soul').props.value).toBe('a soul the desktop rejected')
  })

  it('drops the refusal once the text it described is being changed', async () => {
    seed('# Soul')
    mockRpc.mockImplementation((method: string) =>
      method === 'desktop.config.set' ? Promise.reject(new Error('no')) : Promise.resolve({})
    )
    await draw()

    await openEditor('Soul')
    await typeInto('Soul', 'first attempt')
    fireEvent.press(screen.getByLabelText('Save'))
    await waitFor(() => expect(screen.getByText("Couldn't save. Try again.")).toBeTruthy())

    await typeInto('Soul', 'second attempt')

    expect(screen.queryByText("Couldn't save. Try again.")).toBeNull()
  })

  it('does not re-seed the field when the document changes on the desktop mid-edit', async () => {
    seed('# Soul\nanswer first')
    await draw()

    await openEditor('Soul')
    await typeInto('Soul', 'what this phone is typing')
    // A snapshot lands while the editor is open — the card behind it updates,
    // the draft under the cursor must not.
    useDemoConfig.setState({ soulMarkdown: 'what the desktop just saved' })

    await waitFor(() =>
      expect(screen.getByLabelText('Soul').props.value).toBe('what this phone is typing')
    )
  })

  it('opens read-only with no Save while paired but disconnected', async () => {
    seed('# Soul\nanswer first')
    mockConnected = false
    await draw()

    await openEditor('Soul')

    expect(screen.getByText("Read-only — the desktop isn't connected.")).toBeTruthy()
    expect(screen.queryByLabelText('Save')).toBeNull()
    expect(screen.getByLabelText('Soul').props.editable).toBe(false)
  })

  it('offers no editor for a document too large to have been sent', async () => {
    seed('a stale partial copy')
    useDemoConfig.setState({ customizationOversized: ['soul'] })
    await draw()

    expect(screen.getByText('Too large to sync — open this document on the desktop.')).toBeTruthy()
    // No code block either: there is nothing whole here to open an editor over.
    expect(screen.queryByText('a stale partial copy')).toBeNull()
    fireEvent.press(screen.getAllByLabelText('Edit Soul')[0])
    expect(screen.queryByLabelText('Save')).toBeNull()
  })
})
