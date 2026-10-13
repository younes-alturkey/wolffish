/**
 * History, while a run is happening somewhere else.
 *
 * The desktop's History merges its indexed list with the turns running right
 * now, so an automation shows up there the moment it starts. This screen
 * follows it through the same arc:
 *
 *  1. before the desktop's metadata push lands (or against an older desktop
 *     that never sends one), the conversation is known ONLY from its live
 *     turn — the row is synthesized, titled from the prompt;
 *  2. once the metadata push lands, the indexed row takes over with the
 *     desktop's own title;
 *  3. while either row is processing, delete is disabled — the desktop
 *     refuses a delete mid-run, so an enabled button could only fail;
 *  4. when the run ends, delete frees up.
 */

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() }
}))

// The bundle overlay pulls the tunnel client in at import time, and no test
// here asks for a bundle — the button is absent without a reachable desktop.
jest.mock('@/components/conversations/DiagnosticExportOverlay', () => ({
  DiagnosticExportOverlay: () => null
}))
jest.mock('@/lib/tunnel/useTunnelStatus', () => ({ useDesktopReachable: () => false }))

const mockList: { data: unknown; isLoading: boolean } = { data: [], isLoading: false }
const mockRemove = jest.fn(async (_id: string) => undefined)
jest.mock('@/lib/conversations/hooks', () => ({
  useConversationList: () => mockList,
  removeConversation: (id: string) => mockRemove(id)
}))
jest.mock('@/lib/sync/projects', () => ({ useProjects: () => ({ data: [] }) }))

import HistoryScreen from '@/app/history'
import i18n from '@/lib/i18n'
import type { ConversationMeta } from '@/lib/conversations/types'
import { ThemeContext } from '@/providers/theme/useTheme'
import { useChatRuntime } from '@/state/chatRuntime'
import { useRunStatus } from '@/state/runStatus'
import { render, screen, waitFor } from '@testing-library/react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'

const NOW = Date.now()

function meta(id: string, title: string, over: Partial<ConversationMeta> = {}): ConversationMeta {
  return { id, title, createdAt: NOW - 60_000, updatedAt: NOW - 60_000, messageCount: 2, ...over }
}

/** What the phone holds after `turn.status: started` + the first mirror tick. */
function startRun(conversationId: string, prompt: string): void {
  useChatRuntime.getState().putStream(conversationId, {
    message: { role: 'assistant', content: '', timestamp: NOW },
    status: 'streaming',
    user: { id: 'm_1_aaaaaa', role: 'user', content: prompt, timestamp: NOW },
    channel: 'heartbeat'
  })
}

async function mount(): Promise<void> {
  await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 }
      }}
    >
      <ThemeContext.Provider
        value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
      >
        <HistoryScreen />
      </ThemeContext.Provider>
    </SafeAreaProvider>
  )
}

/** The delete button on the row wearing this accessible title. */
function deleteOn(title: string): { disabled?: boolean } {
  const row = screen.getByLabelText(title)
  const deletes = screen
    .getAllByLabelText(i18n.t('history.delete'))
    .filter((button) => isInside(button, row))
  expect(deletes).toHaveLength(1)
  return (deletes[0].props.accessibilityState ?? {}) as { disabled?: boolean }
}

function isInside(node: { parent: unknown }, ancestor: unknown): boolean {
  let current: unknown = node
  while (current) {
    if (current === ancestor) return true
    current = (current as { parent?: unknown }).parent
  }
  return false
}

beforeEach(() => {
  mockList.data = []
  mockList.isLoading = false
  mockRemove.mockClear()
  useChatRuntime.setState({ streams: {}, cards: {} })
  useRunStatus.setState({ runs: {} })
})

describe('a run the index has not heard of yet', () => {
  it('appears the moment it starts, titled from its prompt, with delete held', async () => {
    mockList.data = [meta('conv-old', 'Last week planning')]
    startRun('conv-auto', 'Summarize unread email')
    await mount()

    // Both rows: the synthesized run first (a running turn outranks history).
    expect(screen.getByLabelText('Summarize unread email')).toBeTruthy()
    expect(screen.getByLabelText('Last week planning')).toBeTruthy()

    // Delete is disabled exactly where a turn is in flight.
    expect(deleteOn('Summarize unread email').disabled).toBe(true)
    expect(deleteOn('Last week planning').disabled).toBeFalsy()
  })
})

describe('a run the desktop has pushed metadata for', () => {
  it('wears the desktop title while running, and frees delete when the run ends', async () => {
    // The `started` push now carries the conversation's metadata — the shell is
    // on disk before the lifecycle fires — so the indexed row exists from the
    // first instant, under the desktop's own title.
    mockList.data = [
      meta('conv-auto', 'Daily (09:00): Summarize unread email', { channel: 'heartbeat' })
    ]
    startRun('conv-auto', 'Summarize unread email')
    await mount()

    // One row, the indexed one — never a second synthesized copy beside it.
    expect(screen.getByLabelText('Daily (09:00): Summarize unread email')).toBeTruthy()
    expect(screen.queryByLabelText('Summarize unread email')).toBeNull()
    expect(deleteOn('Daily (09:00): Summarize unread email').disabled).toBe(true)

    // The run ends: the stream settles away and the terminal phase is recorded.
    useChatRuntime.getState().endStream('conv-auto')
    useRunStatus.getState().markRun('conv-auto', 'completed')

    await waitFor(() =>
      expect(deleteOn('Daily (09:00): Summarize unread email').disabled).toBeFalsy()
    )
  })
})
