/**
 * The conversations sheet — the chat screen's whole navigator, rendered.
 *
 * Four things here can only be caught with the list actually drawn, and each was
 * a real bug on the desktop before it was a rule:
 *
 *  - the number chip counts the conversation's rank in the WHOLE list, so it
 *    must keep counting ACROSS the date headers rather than restarting at 1
 *    under each one;
 *  - the chip's state is the conversation's, so a turn running in a conversation
 *    the user is NOT looking at has to show up there, and lift it;
 *  - picking a row hands an id back rather than navigating, because the chat
 *    screen swaps conversations in place;
 *  - closed, the sheet renders nothing and subscribes to nothing.
 *
 * The row MERGE itself (which conversations, in what state) is pinned purely in
 * lib/conversations/__tests__/rows.test.ts, and so is the scroll window's one
 * load-bearing property — that showing a PREFIX of the list never renumbers it.
 * Neither is asserted here: SectionList mounts about ten cells regardless of
 * what it was handed, and RTL exposes only host elements, so a test written
 * against the rendered list would be measuring React Native's virtualizer
 * rather than this sheet's. The data sources are mocked so this file is only
 * ever about what reaches the screen.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)
jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }))
jest.mock('expo-blur', () => {
  const { View } = jest.requireActual('react-native')
  return { BlurView: View }
})
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))

// SQLite- and tunnel-backed. The sheet reads them as plain lists.
let mockMetas: ConversationMeta[] = []
let mockProjects: Array<{ id: string; icon: string; title: string }> = []
let mockActiveProject: { id: string; icon: string; title: string } | null = null
jest.mock('@/lib/conversations/hooks', () => ({
  useConversationList: () => ({ data: mockMetas })
}))
jest.mock('@/lib/sync/projects', () => ({
  useProjects: () => ({ data: mockProjects }),
  useActiveProject: () => mockActiveProject
}))

import { ConversationsSheet } from '@/components/chat/ConversationsSheet'
import type { ConversationMeta } from '@/lib/conversations/types'
import { ThemeContext } from '@/providers/theme/useTheme'
import { useChatRuntime } from '@/state/chatRuntime'
import { useRunStatus } from '@/state/runStatus'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react-native'
import { router } from 'expo-router'
// Without the real bundle every label below resolves to its own key.
import '@/lib/i18n'

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const NOW = Date.now()
/**
 * Today's local midnight — the boundary grouping.ts actually slices on, and so
 * the only fixed point a date-group fixture may be written against. Offsets
 * from `now` are not: "yesterday" as now − 25h is two calendar days back for
 * every run between midnight and 1am, which is how CI, on UTC, caught it.
 */
const MIDNIGHT = ((): number => {
  const d = new Date(NOW)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
})()

function meta(
  id: string,
  updatedAt: number,
  over: Partial<ConversationMeta> = {}
): ConversationMeta {
  return { id, title: id, updatedAt, createdAt: updatedAt, messageCount: 2, ...over }
}

const onSelect = jest.fn()
const onClose = jest.fn()

let view: Awaited<ReturnType<typeof render>>

/** RTL 14 renders through act() and publishes the result asynchronously. */
async function draw(activeId: string | null = null): Promise<void> {
  view = await render(
    <ThemeContext.Provider
      value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
    >
      <ConversationsSheet open onClose={onClose} activeId={activeId} onSelect={onSelect} />
    </ThemeContext.Provider>
  )
}

/** The rank drawn on one conversation's chip. */
function chipOf(title: string): number {
  // The chip is the row's only number — the title beside it is the id string.
  const digits = within(screen.getByLabelText(title)).getAllByText(/^\d+$/)
  return Number(digits[0].props.children)
}

beforeEach(() => {
  jest.clearAllMocks()
  mockMetas = []
  mockProjects = []
  mockActiveProject = null
  useChatRuntime.setState({ streams: {} })
  useRunStatus.setState({ runs: {} })
})

afterEach(cleanup)

describe('the conversations sheet', () => {
  it('links to the three core pages, and closes before it navigates', async () => {
    await draw()
    // Projects, Automations and Procedures are tabs of the Library now, so the
    // sheet carries one row for the three of them — the desktop's own sheet.
    for (const label of ['Settings', 'Library', 'Customization', 'Conversations']) {
      expect(screen.getByLabelText(label)).toBeTruthy()
    }
    for (const label of ['Projects', 'Automations', 'Procedures']) {
      expect(screen.queryByLabelText(label)).toBeNull()
    }
    await fireEvent.press(screen.getByLabelText('Library'))
    expect(onClose).toHaveBeenCalled()
    expect(router.push).toHaveBeenCalledWith('/settings/library')
  })

  it('groups by date and keeps the numbers counting across the headers', async () => {
    // Anchored to midnight, so each row sits in its bucket at every hour of the
    // day: today's newest and today's oldest possible, the last hour of
    // yesterday, and three calendar days back.
    mockMetas = [
      meta('first', NOW),
      meta('second', MIDNIGHT),
      meta('third', MIDNIGHT - HOUR),
      meta('fourth', MIDNIGHT - 3 * DAY)
    ]
    await draw()

    expect(screen.getByText('Today')).toBeTruthy()
    expect(screen.getByText('Yesterday')).toBeTruthy()
    expect(screen.getByText('Previous 7 days')).toBeTruthy()
    // …1, 2 · "Yesterday" · 3 · "Previous 7 days" · 4 — never 1, 2 · 1 · 1.
    expect(chipOf('first')).toBe(1)
    expect(chipOf('second')).toBe(2)
    expect(chipOf('third')).toBe(3)
    expect(chipOf('fourth')).toBe(4)
  })

  it('shows — and lifts — a turn running in a conversation the user is not in', async () => {
    mockMetas = [meta('quiet', NOW - 1000), meta('busy', NOW - 500_000)]
    await draw('quiet')
    expect(chipOf('quiet')).toBe(1)

    await act(async () => {
      useChatRuntime.setState({
        streams: {
          busy: {
            status: 'streaming',
            message: { role: 'assistant', content: '', timestamp: NOW }
          }
        }
      })
    })

    // The running conversation is now the top of the list, and renumbered with
    // it — the rank is a position, not an identity.
    await waitFor(() => expect(chipOf('busy')).toBe(1))
    expect(chipOf('quiet')).toBe(2)
  })

  it('hands the picked conversation back instead of navigating to it', async () => {
    mockMetas = [meta('one', NOW - 1000), meta('two', NOW - 2000)]
    await draw('one')

    await fireEvent.press(screen.getByLabelText('two'))
    expect(onSelect).toHaveBeenCalledWith('two')
    expect(onClose).toHaveBeenCalled()
    expect(router.push).not.toHaveBeenCalled()
  })

  it('marks the open conversation as the selected row', async () => {
    mockMetas = [meta('one', NOW - 1000), meta('two', NOW - 2000)]
    await draw('two')
    expect(screen.getByLabelText('two').props.accessibilityState.selected).toBe(true)
    expect(screen.getByLabelText('one').props.accessibilityState.selected).toBe(false)
  })

  describe('inside a project', () => {
    const PROJECT = { id: 'proj-1', icon: '📕', title: 'Release notes' }

    it('narrows the list to that project, and names it', async () => {
      mockProjects = [PROJECT]
      mockActiveProject = PROJECT
      mockMetas = [
        meta('inside', NOW - 1000, { projectId: 'proj-1' }),
        meta('outside', NOW - 2000),
        meta('other-project', NOW - 3000, { projectId: 'proj-2' })
      ]
      await draw()

      expect(screen.getByLabelText('inside')).toBeTruthy()
      expect(screen.queryByLabelText('outside')).toBeNull()
      expect(screen.queryByLabelText('other-project')).toBeNull()
      // Said out loud: a list that simply got shorter is indistinguishable
      // from conversations having gone missing.
      expect(screen.getByText('Release notes')).toBeTruthy()
      // And renumbered against what is actually shown.
      expect(chipOf('inside')).toBe(1)
    })

    it('keeps the open conversation even before it carries the project', async () => {
      // A conversation created inside the project moments ago: the desktop
      // stamped it, this phone's index has not caught up, and it is the one on
      // screen. Falling out of the list you are looking at it from is the one
      // thing the filter must never do.
      mockProjects = [PROJECT]
      mockActiveProject = PROJECT
      mockMetas = [meta('brand-new', NOW), meta('outside', NOW - 2000)]
      await draw('brand-new')

      expect(screen.getByLabelText('brand-new')).toBeTruthy()
      expect(screen.queryByLabelText('outside')).toBeNull()
    })

    it('goes back to everything when the project is left', async () => {
      mockProjects = [PROJECT]
      mockMetas = [meta('inside', NOW - 1000, { projectId: 'proj-1' }), meta('outside', NOW - 2000)]
      await draw()
      expect(screen.getByLabelText('outside')).toBeTruthy()
      expect(screen.queryByText('Release notes')).toBeNull()
    })
  })

  it('renders nothing at all while closed', async () => {
    mockMetas = [meta('one', NOW)]
    await render(
      <ThemeContext.Provider
        value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
      >
        <ConversationsSheet open={false} onClose={onClose} activeId={null} onSelect={onSelect} />
      </ThemeContext.Provider>
    )
    expect(screen.queryByLabelText('one')).toBeNull()
    expect(screen.queryByLabelText('Settings')).toBeNull()
  })

  /**
   * The regression that froze the whole app.
   *
   * The sheet used to stay mounted past `open` so it could slide out, and it
   * came down from an animation completion callback. Any run where that
   * callback did not arrive left a full-screen, fully transparent Modal
   * presented over everything — invisible, and swallowing every touch in the
   * app. So: nothing of the sheet may survive the render in which `open` goes
   * false. Not a frame of it, however pretty the exit would have been.
   */
  it('is gone the moment it is closed, with nothing left to swallow touches', async () => {
    mockMetas = [meta('one', NOW)]
    view = await render(
      <ThemeContext.Provider
        value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
      >
        <ConversationsSheet open onClose={onClose} activeId={null} onSelect={onSelect} />
      </ThemeContext.Provider>
    )
    expect(screen.getByLabelText('Settings')).toBeTruthy()

    await view.rerender(
      <ThemeContext.Provider
        value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
      >
        <ConversationsSheet open={false} onClose={onClose} activeId={null} onSelect={onSelect} />
      </ThemeContext.Provider>
    )
    expect(screen.queryByLabelText('Settings')).toBeNull()
    expect(screen.queryByLabelText('one')).toBeNull()
    // Nothing rendered AT ALL — not an emptied panel, not a hidden Modal, no
    // tree. Anything left here is something that can still take a touch.
    expect(view.toJSON()).toBeNull()
  })
})
