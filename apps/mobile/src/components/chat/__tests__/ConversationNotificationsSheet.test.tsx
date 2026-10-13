jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)
jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
jest.mock('expo-blur', () => ({ BlurView: () => null }))

/**
 * The conversation's own notifications sheet — what this run said, read back
 * beside the transcript that produced it.
 *
 * OPENING IT IS READING THEM, and that is the rule the rest follows from. It
 * is one of only two places a notification becomes read (the other is the
 * notifications page's own controls); arriving in the conversation is not,
 * because a transcript never repeats what the run sent to a lock screen. So
 * there is no "mark as read" button here — it would ask the user to tell the
 * app what it can already see — and the New marks stay up for the visit off a
 * snapshot taken before the read, rather than blinking out under a thumb.
 *
 * The rest:
 *  - ARCHIVED ONES ARE GONE. Archiving is filing, and the page is where a
 *    filed notification is read back. A sheet that kept showing them would
 *    make the archive button look broken.
 *  - READ ONES STAY, plainly, from earlier visits.
 *  - NOTHING CONFIRMS, including archive-all in the header: it cannot reach
 *    past the conversation you are standing in, and everything it files is
 *    still on the page.
 */

import { ConversationNotificationsSheet } from '@/components/chat/ConversationNotificationsSheet'
import '@/lib/i18n'
import { ThemeContext } from '@/providers/theme/useTheme'
import { useNotifications, type NotificationRecord } from '@/state/notifications'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'

const NOW = Date.now()

function record(id: string, over: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id,
    title: `Run ${id}`,
    body: 'Fourteen runs since, no flakes.',
    at: NOW - 3 * 3_600_000,
    conversationId: 'conv-a',
    deeplink: null,
    phase: 'completed',
    read: false,
    archived: false,
    counted: true,
    ...over
  }
}

async function mount(): Promise<void> {
  await render(
    <ThemeContext.Provider
      value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
    >
      <ConversationNotificationsSheet open onClose={jest.fn()} conversationId="conv-a" />
    </ThemeContext.Provider>
  )
}

beforeEach(() => {
  useNotifications.setState({ items: [] })
})

describe('what the sheet lists', () => {
  it('shows this conversation and not the one next to it', async () => {
    useNotifications.setState({
      items: [
        record('mine'),
        record('theirs', { conversationId: 'conv-b', title: 'Run theirs' }),
        record('general', { conversationId: null, title: 'Run general' })
      ]
    })
    await mount()

    expect(screen.getByText('Run mine')).toBeTruthy()
    expect(screen.queryByText('Run theirs')).toBeNull()
    expect(screen.queryByText('Run general')).toBeNull()
  })

  it('keeps read ones from earlier visits, plainly', async () => {
    useNotifications.setState({ items: [record('n1', { read: true })] })
    await mount()

    expect(screen.getByText('Run n1')).toBeTruthy()
    // Nothing was new this time, so no mark — archive still stands.
    expect(screen.queryByText('New')).toBeNull()
    expect(screen.getByLabelText('Archive')).toBeTruthy()
  })

  it('leaves archived ones to the notifications page', async () => {
    useNotifications.setState({
      items: [record('filed', { archived: true, read: true }), record('open')]
    })
    await mount()

    expect(screen.getByText('Run open')).toBeTruthy()
    expect(screen.queryByText('Run filed')).toBeNull()
  })

  it('says so when everything has been filed', async () => {
    useNotifications.setState({ items: [record('filed', { archived: true, read: true })] })
    await mount()

    expect(
      screen.getByText('Nothing left here — everything this conversation sent is archived.')
    ).toBeTruthy()
  })
})

describe('opening it', () => {
  it('reads the whole list, with no button to press', async () => {
    useNotifications.setState({ items: [record('n1'), record('n2')] })

    await mount()

    await waitFor(() =>
      expect(useNotifications.getState().items.every((entry) => entry.read)).toBe(true)
    )
    // There is nothing to press, because there is nothing left to do.
    expect(screen.queryByLabelText('Mark as read')).toBeNull()
  })

  it('still shows what was new, rather than blinking the marks out', async () => {
    // The read above happens on mount. The New marks come from a snapshot
    // taken before it, so the user gets to see what they had missed.
    useNotifications.setState({ items: [record('n1'), record('n2', { read: true })] })

    await mount()

    await waitFor(() => expect(useNotifications.getState().items[0].read).toBe(true))
    expect(screen.getAllByText('New')).toHaveLength(1)
  })

  it('leaves other conversations unread', async () => {
    useNotifications.setState({
      items: [record('mine'), record('theirs', { conversationId: 'conv-b' })]
    })

    await mount()

    await waitFor(() => expect(useNotifications.getState().items[0].read).toBe(true))
    expect(useNotifications.getState().items[1].read).toBe(false)
  })
})

describe('its actions', () => {
  it('archives one on the spot, and it leaves the sheet', async () => {
    useNotifications.setState({ items: [record('n1'), record('n2')] })
    await mount()

    fireEvent.press(screen.getAllByLabelText('Archive')[0])

    await waitFor(() => expect(screen.queryByText('Run n1')).toBeNull())
    expect(screen.getByText('Run n2')).toBeTruthy()
    // Archiving reads at the same time — the store's rule, not the sheet's.
    expect(useNotifications.getState().items[0]).toMatchObject({ archived: true, read: true })
  })

  it('files the whole conversation from the header, without asking', async () => {
    useNotifications.setState({
      items: [record('n1'), record('n2'), record('other', { conversationId: 'conv-b' })]
    })
    await mount()

    fireEvent.press(screen.getByLabelText('Archive all'))

    await waitFor(() =>
      expect(
        screen.getByText('Nothing left here — everything this conversation sent is archived.')
      ).toBeTruthy()
    )
    // No dialog stood between the press and the change…
    expect(screen.queryByText('Archive all?')).toBeNull()
    // …and it could not reach past the conversation it belongs to.
    const state = useNotifications.getState().items
    expect(
      state
        .filter((entry) => entry.archived)
        .map((entry) => entry.id)
        .sort()
    ).toEqual(['n1', 'n2'])
  })
})
