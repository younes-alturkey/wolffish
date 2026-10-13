jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)
jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))

const mockPush = jest.fn()
jest.mock('expo-router', () => ({
  // Called through rather than handed over: jest hoists this factory above the
  // `const` above it, and the screen's own import runs it — so a direct
  // `push: mockPush` captures the binding while it is still undefined.
  router: {
    push: (...args: unknown[]) => mockPush(...args),
    back: jest.fn(),
    replace: jest.fn(),
    canGoBack: () => true
  }
}))

/**
 * The notifications page — the banner the user missed, read back.
 *
 * What is pinned here is the half that only exists on screen. The store's own
 * arithmetic lives in state/__tests__/notifications.test.ts; these are the
 * three things a working store can still get wrong from a screen:
 *
 *  - the TEXT. A notification's body is the only place its content survives
 *    once the banner is gone, so it renders whole, alongside how long ago it
 *    was sent — localized, from the same units table every other duration in
 *    the app reads.
 *  - the DEEPLINK. A card is a way back into the conversation that raised it.
 *    The route it resolves has to be the one the OS banner would have opened,
 *    down to the conversation id, or the page is a dead list.
 *  - the TWO PILES. Archive is one-way and takes the card out of the inbox;
 *    the archive tab is where it went. A card that vanishes from both is a
 *    notification the user cannot get back to.
 *
 * One render and one press per test, per this project's RNTL discipline — a
 * second press in the same test overlaps the act scope and silently empties
 * every later render in the file.
 */

import NotificationsScreen from '@/app/notifications'
import '@/lib/i18n'
import { ThemeContext } from '@/providers/theme/useTheme'
import { iconBadge, useNotifications, type NotificationRecord } from '@/state/notifications'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'

const NOW = Date.now()

function record(id: string, over: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id,
    title: `Migration ${id}`,
    body: 'Your migration completed without errors.',
    at: NOW - 3 * 3_600_000,
    conversationId: 'conv-a',
    deeplink: 'wolffish://chat?id=conv-a',
    phase: 'completed',
    read: false,
    archived: false,
    counted: true,
    ...over
  }
}

/** The state a delivered notification leaves behind. There is only the log
 *  now: every badge in the app is counted off these records. */
function seed(...records: NotificationRecord[]): void {
  useNotifications.setState({ items: records })
}

async function mount(): Promise<void> {
  // The bulk actions' confirm dialog goes through the core Modal, which reads
  // the theme for its blur tint — so the screen needs the provider even though
  // nothing else on it does.
  await render(
    <ThemeContext.Provider
      value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
    >
      <NotificationsScreen />
    </ThemeContext.Provider>
  )
}

beforeEach(() => {
  mockPush.mockClear()
  useNotifications.setState({ items: [] })
})

describe('the list', () => {
  it('shows a notification whole — title, body, phase and how long ago', async () => {
    seed(record('n1'))
    await mount()

    expect(screen.getByText('Migration n1')).toBeTruthy()
    expect(screen.getByText('Your migration completed without errors.')).toBeTruthy()
    expect(screen.getByText('Done')).toBeTruthy()
    // From the shared units table, so it reads the same as every other
    // duration in the app — and translates with them.
    expect(screen.getByText('3h ago')).toBeTruthy()
    // The unread mark is a word on the card, so it is readable rather than
    // learned — and it is localized, which a dot could never be.
    expect(screen.getByText('New')).toBeTruthy()
  })

  it('says so when there is nothing, rather than showing an empty frame', async () => {
    await mount()

    expect(screen.getByText('No notifications yet.')).toBeTruthy()
    expect(screen.queryByText('Mark as read')).toBeNull()
  })

  it('offers nothing to read on one already read', async () => {
    seed(record('n1', { read: true, counted: false }))
    await mount()

    expect(screen.getByText('Migration n1')).toBeTruthy()
    expect(screen.queryByText('Mark as read')).toBeNull()
    expect(screen.queryByText('New')).toBeNull()
    // Archive is still on offer: read and filed are different questions.
    // By role, because "Archive" also names the tab beside this list.
    expect(screen.getAllByRole('button', { name: 'Archive' })).toHaveLength(1)
  })
})

describe('a card', () => {
  it('opens the conversation it came from, deeplink and all', async () => {
    seed(record('n1'))
    await mount()

    fireEvent.press(screen.getByText('Migration n1'))

    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith({ pathname: '/chat', params: { id: 'conv-a' } })
    )
    // Opening it answers it — here and on the icon.
    expect(useNotifications.getState().items[0].read).toBe(true)
    expect(iconBadge(useNotifications.getState())).toBe(0)
  })

  it('goes nowhere for a link this build cannot resolve, but still reads', async () => {
    seed(record('n1', { deeplink: 'wolffish://settings/from-the-future', conversationId: null }))
    await mount()

    fireEvent.press(screen.getByText('Migration n1'))

    await waitFor(() => expect(useNotifications.getState().items[0].read).toBe(true))
    expect(mockPush).not.toHaveBeenCalled()
  })
})

describe('mark as read', () => {
  it('takes the badge down by exactly one, leaving the card in the list', async () => {
    seed(record('n1'), record('n2'))
    expect(iconBadge(useNotifications.getState())).toBe(2)
    await mount()

    fireEvent.press(screen.getAllByText('Mark as read')[0])

    await waitFor(() => expect(iconBadge(useNotifications.getState())).toBe(1))
    // Read, not gone: the text is still there to read, minus its New mark.
    expect(screen.getByText('Migration n1')).toBeTruthy()
    expect(screen.getAllByText('New')).toHaveLength(1)
    expect(mockPush).not.toHaveBeenCalled()
  })
})

describe('archive', () => {
  it('takes the card out of the inbox and the badge with it', async () => {
    seed(record('n1'), record('n2'))
    await mount()

    fireEvent.press(screen.getAllByRole('button', { name: 'Archive' })[0])

    await waitFor(() => expect(screen.queryByText('Migration n1')).toBeNull())
    expect(screen.getByText('Migration n2')).toBeTruthy()
    expect(iconBadge(useNotifications.getState())).toBe(1)
    expect(useNotifications.getState().items[0]).toMatchObject({ archived: true, read: true })
  })

  it('is where the archive tab looks', async () => {
    seed(record('n1', { read: true, archived: true, counted: false }), record('n2'))
    await mount()

    fireEvent.press(screen.getByRole('tab', { name: 'Archive' }))

    // The archived card is here, the inbox one is not — and nothing in the
    // archive offers to be read or archived again, bulk buttons included.
    await waitFor(() => expect(screen.getByText('Migration n1')).toBeTruthy())
    expect(screen.queryByText('Migration n2')).toBeNull()
    expect(screen.queryByText('Mark as read')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull()
    expect(screen.queryByLabelText('Archive all')).toBeNull()
    expect(screen.queryByLabelText('Mark all read')).toBeNull()
  })
})

describe('the two bulk buttons', () => {
  it('asks before marking everything read, and does nothing until it is answered', async () => {
    seed(record('n1'), record('n2', { conversationId: 'conv-b' }))
    await mount()

    fireEvent.press(screen.getByLabelText('Mark all read'))

    // The press opens the question; the badge is untouched until it is
    // answered. Both of these act on EVERY notification at once and cannot be
    // undone from this screen, which is the whole reason they ask.
    await waitFor(() => expect(screen.getByText('Mark all as read?')).toBeTruthy())
    expect(iconBadge(useNotifications.getState())).toBe(2)
    expect(useNotifications.getState().items.every((entry) => !entry.read)).toBe(true)
  })

  it('marks everything read once the dialog is confirmed', async () => {
    seed(record('n1'), record('n2', { conversationId: 'conv-b' }))
    await mount()
    fireEvent.press(screen.getByLabelText('Mark all read'))
    await waitFor(() => expect(screen.getByText('Mark all as read?')).toBeTruthy())

    fireEvent.press(screen.getByText('Mark all read'))

    await waitFor(() => expect(iconBadge(useNotifications.getState())).toBe(0))
    // Read, not filed: the text is all still there, and no mark is left.
    expect(screen.getByText('Migration n1')).toBeTruthy()
    expect(screen.getByText('Migration n2')).toBeTruthy()
    expect(screen.queryByText('New')).toBeNull()
  })

  it('archives everything once the dialog is confirmed', async () => {
    seed(record('n1'), record('n2'))
    await mount()
    fireEvent.press(screen.getByLabelText('Archive all'))
    await waitFor(() => expect(screen.getByText('Archive all?')).toBeTruthy())

    fireEvent.press(screen.getAllByText('Archive all').slice(-1)[0])

    await waitFor(() => expect(screen.getByText('No notifications yet.')).toBeTruthy())
    expect(useNotifications.getState().items.every((entry) => entry.archived && entry.read)).toBe(
      true
    )
    expect(iconBadge(useNotifications.getState())).toBe(0)
  })

  it('cancels without touching anything', async () => {
    seed(record('n1'), record('n2'))
    await mount()
    fireEvent.press(screen.getByLabelText('Archive all'))
    await waitFor(() => expect(screen.getByText('Archive all?')).toBeTruthy())

    fireEvent.press(screen.getByText('Cancel'))

    await waitFor(() => expect(screen.queryByText('Archive all?')).toBeNull())
    expect(useNotifications.getState().items.every((entry) => !entry.archived)).toBe(true)
    expect(iconBadge(useNotifications.getState())).toBe(2)
  })

  it('are dead rather than absent when the inbox is empty', async () => {
    await mount()

    fireEvent.press(screen.getByLabelText('Archive all'))

    // Disabled, so not even the question is asked.
    expect(screen.queryByText('Archive all?')).toBeNull()
    expect(useNotifications.getState().items).toHaveLength(0)
  })
})
