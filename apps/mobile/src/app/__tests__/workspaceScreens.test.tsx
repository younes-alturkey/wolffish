jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * The Projects, Procedures and Automations tabs of the Library screen, on
 * screen.
 *
 * The sync contracts are pinned in lib/sync/__tests__/workspaceStores.test.ts and
 * the file surgery in lib/automations/__tests__/heartbeat.test.ts. What only
 * exists here is whether the screens actually MOUNT and render the desktop's data
 * — which typechecking cannot answer: a missing i18n key renders its own name, a
 * hook called conditionally throws at runtime, and a card that reads a field the
 * wire does not carry renders blank. All three are invisible until the screen is
 * opened, and this is the cheapest place to open it.
 *
 * Also pinned: the read-only rendering. Disconnected, these are the desktop's
 * files with nowhere for a write to land, and a screen that offers its buttons
 * anyway is a screen that swallows taps.
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
jest.mock('@/state/appStore', () => {
  const useAppStore = (selector: (state: { paired: boolean }) => unknown): unknown =>
    selector({ paired: mockPaired })
  useAppStore.getState = (): { paired: boolean } => ({ paired: mockPaired })
  return { useAppStore }
})

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('@/providers/toast/useToast', () => ({
  useToast: () => ({ show: jest.fn(), dismiss: jest.fn() })
}))
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
let mockParams: { tab?: string } = {}
jest.mock('expo-router', () => ({
  router: {
    back: jest.fn(),
    push: jest.fn(),
    replace: jest.fn(),
    dismissTo: jest.fn(),
    canGoBack: () => true
  },
  // The focus refresh belongs to react-navigation; the queries fetch on mount
  // here anyway, so running it would only double every RPC.
  useFocusEffect: () => undefined,
  useLocalSearchParams: () => mockParams
}))
jest.mock('@/lib/sync/useFreshConfig', () => ({ useFreshConfig: () => undefined }))
// SQLite-backed, and only feeds the per-project conversation counts.
jest.mock('@/lib/conversations/hooks', () => ({ useConversationList: () => ({ data: [] }) }))

import { LocaleContext } from '@/providers/locale/useLocale'
import { ThemeContext } from '@/providers/theme/useTheme'
import LibraryScreen from '@/app/settings/library'
import { AutomationsTab } from '@/components/library/AutomationsTab'
import { ProceduresTab } from '@/components/library/ProceduresTab'
import { ProjectsTab } from '@/components/library/ProjectsTab'
import { queryClient } from '@/lib/query/queryClient'
import { Rpc } from '@/lib/tunnel/protocol'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import '@/lib/i18n'

const PROJECT = {
  id: 'proj-1',
  title: 'Quarterly report',
  icon: '📊',
  instructions: 'Always cite the source table.',
  files: [{ path: 'uploads/project-proj-1/q3.pdf', name: 'q3.pdf' }],
  createdAt: 1,
  updatedAt: Date.now()
}

const PROCEDURE = {
  id: 'proc-1',
  title: 'Weekly digest',
  prompt: 'Summarize the week.',
  mode: 'workflow' as const,
  icon: '📋',
  projectId: 'proj-1',
  createdAt: 1,
  updatedAt: Date.now()
}

const HEARTBEAT = [
  '## Daily (09:00)',
  '',
  'project: proj-1',
  'icon: 🫀',
  '',
  'Summarize yesterday.',
  '',
  '<!-- ## Weekly (Monday 09:30)',
  '',
  'Plan the week.',
  '-->',
  ''
].join('\n')

/** The desktop, answering every read this trio makes. */
function serveAll(): void {
  mockRpc.mockImplementation(async (method: string) => {
    if (method === Rpc.projectsList) return { projects: [PROJECT] }
    if (method === Rpc.proceduresList) return { procedures: [PROCEDURE] }
    if (method === Rpc.automationsRead) {
      return {
        markdown: HEARTBEAT,
        // Only the ACTIVE automation reaches the scheduler, which is why the
        // inactive one's card has to come from the file.
        jobs: [
          {
            id: 'daily',
            label: 'Daily (09:00)',
            type: 'daily',
            cron: '0 9 * * *',
            nextRunMs: Date.now() + 3 * 3_600_000,
            mode: null
          }
        ],
        stamps: { 'Daily (09:00)': Date.now() - 60_000 },
        runs: { running: [{ id: 'daily', label: 'Daily (09:00)' }], queued: [] }
      }
    }
    return {}
  })
}

function draw(node: React.JSX.Element): void {
  // The app's own client, so the screens read and write the very cache the sync
  // layer does — a fresh one per test would hide the cache-absorb behaviour that
  // makes these screens repaint before the desktop's push arrives.
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeContext.Provider
        value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
      >
        {/* The automations cards print an absolute moment beside the relative
            one, and that formatting is locale-driven. */}
        <LocaleContext.Provider
          value={{ locale: 'en', isRtl: false, setLocale: async () => undefined }}
        >
          {node}
        </LocaleContext.Provider>
      </ThemeContext.Provider>
    </QueryClientProvider>
  )
}

afterEach(() => {
  // Two open handles to close, or the jest worker never exits after the last
  // assertion: these screens tick a 30 s clock (cleared on unmount), and every
  // query that loses its last observer arms a 7-day garbage-collection timer.
  cleanup()
  queryClient.clear()
})

beforeEach(() => {
  queryClient.clear()
  mockRpc.mockReset()
  mockConnected = true
  mockPaired = true
  mockParams = {}
  serveAll()
})

describe('Projects screen', () => {
  it('renders the desktop’s projects with their instructions and counts', async () => {
    draw(<ProjectsTab />)
    // The FIRST paint in this file pays for the whole module graph — all three
    // screens plus their pickers and dialogs — so the default 1s deadline sits
    // uncomfortably close to the real ~0.5s on a loaded machine. Only the
    // patience changes; the assertion is the same.
    await waitFor(() => expect(screen.getByText('Quarterly report')).toBeTruthy(), {
      timeout: 5000
    })
    expect(screen.getByText('📊')).toBeTruthy()
    expect(screen.getByText('Always cite the source table.')).toBeTruthy()
    // The card's meta line: one file, no conversations yet, plus the edit stamp.
    expect(screen.getByText(/1 files/)).toBeTruthy()
    expect(screen.getByText(/0 conversations/)).toBeTruthy()
  })

  it('says so and offers nothing to press when there is no desktop to write to', async () => {
    mockConnected = false
    draw(<ProjectsTab />)
    // New and Delete are present but disabled — the desktop owns these files.
    await waitFor(() => expect(screen.getByText('New')).toBeTruthy())
    expect(screen.getByText('New').parent?.props.accessibilityState?.disabled).toBe(true)
  })

  it('shows the empty state rather than a blank list', async () => {
    mockRpc.mockResolvedValue({ projects: [] })
    draw(<ProjectsTab />)
    await waitFor(() => expect(screen.getByText(/No projects yet/)).toBeTruthy())
  })
})

describe('Procedures screen', () => {
  it('renders the procedure with its project’s emoji and its own mode', async () => {
    draw(<ProceduresTab />)
    await waitFor(() => expect(screen.getByText('Weekly digest')).toBeTruthy())
    expect(screen.getByText('Summarize the week.')).toBeTruthy()
    // A project-bound procedure wears the PROJECT's emoji, not its own 📋.
    await waitFor(() => expect(screen.getByText('📊')).toBeTruthy())
    // The stamped mode wins over the workspace default.
    expect(screen.getByText('Workflow').props.className).toContain('text-primary-fg')
    expect(screen.getByLabelText('Run')).toBeTruthy()
  })

  it('offers the project as a chip row, with the binding lit', async () => {
    draw(<ProceduresTab />)
    await waitFor(() => expect(screen.getByText('Weekly digest')).toBeTruthy())
    fireEvent.press(screen.getByLabelText('Edit'))
    // The chat controls' picker, not a Select: every project on one x-scrolling
    // row, the bound one lit.
    await waitFor(() => expect(screen.getByText('No project')).toBeTruthy())
    expect(screen.getByText('Quarterly report').props.className).toContain('text-primary-fg')
    expect(screen.getByText('No project').props.className).not.toContain('text-primary-fg')
  })
})

describe('Automations screen', () => {
  it('renders active and inactive automations, with the type chip and the next run', async () => {
    draw(<AutomationsTab />)
    await waitFor(() => expect(screen.getByText('Daily (09:00)')).toBeTruthy())
    // The switched-off one never reaches the scheduler — its card is parsed
    // from the file, which is the whole reason the parser lives on this side.
    expect(screen.getByText('Weekly (Monday 09:30)')).toBeTruthy()
    // Type chips, from the schedule kind.
    expect(screen.getByText('Daily')).toBeTruthy()
    expect(screen.getByText('Weekly')).toBeTruthy()
    // The desktop's served moment, as "Next run in 3h · <date>".
    expect(screen.getByText(/Next run in 3h/)).toBeTruthy()
    // Inactive says only that: it never fires, so a next run would be a lie.
    expect(screen.getByText(/Inactive/)).toBeTruthy()
    // The run pool gates the play button and says why.
    expect(screen.getByText(/running right now/)).toBeTruthy()
  })

  it('keeps the meta line to next run and edit stamp — the project shows as the emoji', async () => {
    draw(<AutomationsTab />)
    await waitFor(() => expect(screen.getByText('Daily (09:00)')).toBeTruthy())
    // The binding is worn, not written: the card takes the project's emoji …
    expect(screen.getByText('📊')).toBeTruthy()
    // … and the meta line never names it, so it cannot wrap onto a second row.
    expect(screen.getByText(/Next run in 3h/).props.children).not.toMatch(/Quarterly report/)
    expect(screen.getByText(/Next run in 3h/).props.children).toMatch(/Edited/)
  })

  it('offers the project as a chip row in the editor', async () => {
    draw(<AutomationsTab />)
    await waitFor(() => expect(screen.getByText('Daily (09:00)')).toBeTruthy())
    fireEvent.press(screen.getAllByLabelText('Edit automation')[0])
    await waitFor(() => expect(screen.getByText('No project')).toBeTruthy())
    // The bound chip is lit, exactly as the chat controls light theirs.
    expect(screen.getByText('Quarterly report').props.className).toContain('text-primary-fg')
  })
})

describe('Library screen', () => {
  it('opens on Automations with the three tabs', async () => {
    draw(<LibraryScreen />)
    await waitFor(() => expect(screen.getByText('Daily (09:00)')).toBeTruthy())
    expect(screen.getByText('Library')).toBeTruthy()
    for (const label of ['Automations', 'Projects', 'Procedures']) {
      expect(screen.getByLabelText(label)).toBeTruthy()
    }
    expect(screen.getByLabelText('Automations').props.accessibilityState.selected).toBe(true)
    // Cards only: the desktop's raw heartbeat.md view has no phone counterpart.
    expect(screen.queryByLabelText('Markdown')).toBeNull()
    expect(screen.queryByText('Quarterly report')).toBeNull()
  })

  it('switches tabs in place — Projects replaces Automations under the same header', async () => {
    draw(<LibraryScreen />)
    await waitFor(() => expect(screen.getByText('Daily (09:00)')).toBeTruthy())
    fireEvent.press(screen.getByLabelText('Projects'))
    await waitFor(() => expect(screen.getByText('Quarterly report')).toBeTruthy())
    expect(screen.queryByText('Daily (09:00)')).toBeNull()
    expect(screen.getByLabelText('Projects').props.accessibilityState.selected).toBe(true)
    expect(screen.getByText('Library')).toBeTruthy()
  })

  it('lands on the tab a deep link names', async () => {
    // The old settings/procedures route redirects here with this param — a
    // notification naming it must still open the procedures list.
    mockParams = { tab: 'procedures' }
    draw(<LibraryScreen />)
    await waitFor(() => expect(screen.getByText('Weekly digest')).toBeTruthy())
    expect(screen.getByLabelText('Procedures').props.accessibilityState.selected).toBe(true)
  })
})
