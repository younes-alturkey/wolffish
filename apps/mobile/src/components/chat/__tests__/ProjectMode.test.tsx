/**
 * Project mode in chat: what the composer's first button becomes, and what
 * choosing a project actually means.
 *
 * Both of these were wrong in ways that only show up across two surfaces. Project
 * mode used to hold a COPY of the project row, so an edit made on the desktop
 * refreshed the Projects list and left the composer's emoji and the chat hero
 * showing the old one — a stale mirror, indistinguishable from a sync that had
 * not arrived. And picking a project in the chat menu only filed the
 * conversation: the app went on acting as though no project were chosen, which is
 * not what choosing one means.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)
jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('@/components/chat/RainbowBorder', () => ({ RainbowBorder: () => null }))
jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native')
  const anim = { duration: () => anim, delay: () => anim, springify: () => anim }
  return { __esModule: true, default: { View }, FadeInDown: anim, FadeInUp: anim, FadeOut: anim }
})
jest.mock('expo-audio', () => ({
  useAudioRecorder: () => ({ prepareToRecordAsync: jest.fn(), record: jest.fn(), stop: jest.fn() }),
  useAudioRecorderState: () => ({ durationMillis: 0 }),
  useAudioPlayer: () => ({ play: jest.fn(), pause: jest.fn() }),
  useAudioPlayerStatus: () => ({ playing: false, currentTime: 0, duration: 0 }),
  setAudioModeAsync: jest.fn(),
  AudioModule: { requestRecordingPermissionsAsync: jest.fn() },
  RecordingPresets: { HIGH_QUALITY: {} }
}))
// The sheet's other rows reach for the model catalog, the context meter and the
// tunnel; the project picker is the whole subject here.
jest.mock('@/components/chat/ChatControls', () => {
  const { Text } = require('react-native')
  return {
    ContextMeterCard: () => <Text>context-meter</Text>,
    ModeAndThinkingControls: () => <Text>mode-and-thinking</Text>
  }
})
jest.mock('@/components/chat/ModelSwitch', () => {
  const { Text } = require('react-native')
  return {
    ModelSwitch: () => <Text>model-switch</Text>
  }
})

jest.mock('@/lib/sync/prompt', () => ({
  abortTurn: jest.fn(),
  beginTurn: jest.fn(),
  sendPrompt: jest.fn()
}))

let mockConnected = true
jest.mock('@/lib/tunnel/client', () => ({
  tunnelClient: {
    get active() {
      return mockConnected ? { rpc: jest.fn(), connected: true } : null
    },
    get connected() {
      return mockConnected
    },
    subscribe: () => () => undefined,
    reportRpcFailure: jest.fn()
  }
}))

import { ChatMenuSheet } from '@/components/chat/ChatMenuSheet'
import { ProjectDialog } from '@/components/workspace/ProjectDialog'
import { Composer } from '@/components/chat/Composer'
import { queryClient } from '@/lib/query/queryClient'
import { projectKeys } from '@/lib/sync/projects'
import type { SyncProject } from '@/lib/tunnel/protocol'
import { ThemeContext } from '@/providers/theme/useTheme'
import { ToastProvider } from '@/providers/toast/ToastProvider'
import { useChatRuntime } from '@/state/chatRuntime'
import { QueryClientProvider } from '@tanstack/react-query'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
// Without the real bundle every label below resolves to its own key.
import '@/lib/i18n'

function project(over: Partial<SyncProject> = {}): SyncProject {
  return {
    id: 'proj-1',
    title: 'Quarterly report',
    icon: '📊',
    instructions: 'Cite the source table.',
    files: [],
    directories: [],
    thinking: null,
    createdAt: 1,
    updatedAt: 1,
    ...over
  }
}

/** Seed the list the way a landed `projectsList` answer would. */
function seed(projects: SyncProject[]): void {
  queryClient.setQueryData(projectKeys.list, projects)
}

function wrap(node: React.JSX.Element): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 }
        }}
      >
        <ThemeContext.Provider
          value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
        >
          <ToastProvider>{node}</ToastProvider>
        </ThemeContext.Provider>
      </SafeAreaProvider>
    </QueryClientProvider>
  )
}

async function drawComposer(): Promise<void> {
  await render(
    wrap(
      <Composer
        streaming={false}
        conversation={null}
        conversationId={null}
        onSubmit={jest.fn()}
        onStop={jest.fn()}
        onNewConversation={jest.fn()}
      />
    )
  )
}

afterEach(() => {
  cleanup()
  queryClient.clear()
})

beforeEach(() => {
  queryClient.clear()
  mockConnected = true
  useChatRuntime.setState({ activeProjectId: null, pendingProjectId: null })
})

describe('the composer’s project button', () => {
  it('is the menu glyph until a project is active, then the project’s emoji', async () => {
    seed([project()])
    await drawComposer()
    expect(screen.getByLabelText('Chat controls')).toBeTruthy()

    await act(async () => {
      useChatRuntime.getState().setActiveProject('proj-1')
    })
    await waitFor(() => expect(screen.getByLabelText('Quarterly report')).toBeTruthy())
    expect(screen.getByText('📊')).toBeTruthy()
  })

  it('follows an edit made on the DESKTOP, in the render the list moves in', async () => {
    seed([project()])
    useChatRuntime.setState({ activeProjectId: 'proj-1' })
    await drawComposer()
    await waitFor(() => expect(screen.getByText('📊')).toBeTruthy())

    // What a `projects.changed` push resolves to: the desktop's row, re-listed.
    await act(async () => {
      seed([project({ title: 'Annual report', icon: '📈' })])
    })

    await waitFor(() => expect(screen.getByText('📈')).toBeTruthy())
    expect(screen.getByLabelText('Annual report')).toBeTruthy()
    expect(screen.queryByText('📊')).toBeNull()
  })

  it('drops project mode’s chrome when the project is deleted out from under it', async () => {
    seed([project()])
    useChatRuntime.setState({ activeProjectId: 'proj-1' })
    await drawComposer()
    await waitFor(() => expect(screen.getByText('📊')).toBeTruthy())

    await act(async () => {
      seed([])
    })
    // The menu glyph is back: a project whose instructions no turn will receive
    // must not be shown as the one this chat is inside.
    await waitFor(() => expect(screen.getByLabelText('Chat controls')).toBeTruthy())
  })
})

describe('picking a project in the chat menu', () => {
  /**
   * Tap the chip named `label`. Every project is already on the row — there is
   * no list to open first, which is the point of the chips.
   */
  async function pick(label: string): Promise<void> {
    await waitFor(() => expect(screen.getByText(label)).toBeTruthy())
    fireEvent.press(screen.getByText(label))
  }

  it('enters the project', async () => {
    seed([project()])
    await render(wrap(<ChatMenuSheet open onClose={jest.fn()} conversation={null} />))
    await pick('Quarterly report')
    await waitFor(() => expect(useChatRuntime.getState().activeProjectId).toBe('proj-1'))
  })

  it('lays every project on the row at once, with the active one lit', async () => {
    seed([project(), project({ id: 'proj-2', title: 'Field notes', icon: '🗒️' })])
    useChatRuntime.setState({ activeProjectId: 'proj-2' })
    await render(wrap(<ChatMenuSheet open onClose={jest.fn()} conversation={null} />))

    // Nothing to open first: unfiled and both projects are on screen, each with
    // its own icon — that is what the chips buy over the dropdown they replace.
    await waitFor(() => expect(screen.getByText('Field notes')).toBeTruthy())
    expect(screen.getByText('Quarterly report')).toBeTruthy()
    expect(screen.getByText('No project')).toBeTruthy()
    expect(screen.getByText('🗒️')).toBeTruthy()
    expect(screen.getByText('📊')).toBeTruthy()

    // Exactly one chip reads as chosen, and it is the project mode is in.
    const lit = screen.getAllByRole('tab', { selected: true })
    expect(lit).toHaveLength(1)
    expect(within(lit[0]).getByText('Field notes')).toBeTruthy()
  })

  it('closes the sheet on the pick, and enters even from an existing chat', async () => {
    // The chat that was open is NOT moved into the project — entering starts a
    // fresh conversation there (see the chat screen's rule), and a conversation
    // already under way never received the project's instructions.
    const onClose = jest.fn()
    seed([project()])
    await render(
      wrap(
        <ChatMenuSheet
          open
          onClose={onClose}
          conversation={
            {
              id: 'conv-1',
              title: 'Chat',
              messages: [],
              createdAt: 1,
              updatedAt: 1
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any
          }
        />
      )
    )
    await pick('Quarterly report')
    await waitFor(() => expect(useChatRuntime.getState().activeProjectId).toBe('proj-1'))
    expect(onClose).toHaveBeenCalled()
  })

  it('leaves the project when No project is chosen', async () => {
    seed([project()])
    useChatRuntime.setState({ activeProjectId: 'proj-1' })
    await render(wrap(<ChatMenuSheet open onClose={jest.fn()} conversation={null} />))
    await pick('No project')
    await waitFor(() => expect(useChatRuntime.getState().activeProjectId).toBeNull())
  })
})

describe('the project dialog’s view switch', () => {
  /** Open project mode's dialog from the composer's project button. */
  async function openDialog(): Promise<void> {
    seed([project()])
    useChatRuntime.setState({ activeProjectId: 'proj-1' })
    await drawComposer()
    await waitFor(() => expect(screen.getByText('📊')).toBeTruthy())
    fireEvent.press(screen.getByLabelText('Quarterly report'))
    await waitFor(() => expect(screen.getByText('Cite the source table.')).toBeTruthy())
  }

  it('opens on the project and switches to the chat controls', async () => {
    await openDialog()
    // The controls the composer's menu glyph opens when no project is active are
    // not lost by the swap — they are the dialog's other view.
    expect(screen.queryByText('model-switch')).toBeNull()

    fireEvent.press(screen.getByLabelText('Controls'))
    await waitFor(() => expect(screen.getByText('model-switch')).toBeTruthy())
    expect(screen.getByText('mode-and-thinking')).toBeTruthy()
    expect(screen.getByText('context-meter')).toBeTruthy()
    // The project half is put away, not stacked under them.
    expect(screen.queryByText('Cite the source table.')).toBeNull()
    // And the project's own actions stay on the footer either way.
    expect(screen.getByText('Close project')).toBeTruthy()

    fireEvent.press(screen.getByLabelText('Project'))
    await waitFor(() => expect(screen.getByText('Cite the source table.')).toBeTruthy())
  })

  it('leaves the project chips out of the controls, since you are in one', async () => {
    await openDialog()
    fireEvent.press(screen.getByLabelText('Controls'))
    await waitFor(() => expect(screen.getByText('model-switch')).toBeTruthy())
    // Changing the project from inside its own dialog would unmount the dialog
    // mid-interaction; Close project on the footer is the way out. The one thing
    // labelled Project here is the view switch, not a row of chips under it.
    expect(screen.getAllByLabelText('Project')).toHaveLength(1)
    expect(screen.queryByText('No project')).toBeNull()
  })
})

describe('the same dialog outside project mode', () => {
  it('has no view switch, because there is no chat there to control', async () => {
    seed([project()])
    // How the Projects screen opens it: no controls, no chat-mode actions.
    await render(
      wrap(<ProjectDialog project={project()} onClose={jest.fn()} onChanged={jest.fn()} />)
    )
    await waitFor(() => expect(screen.getByText('Cite the source table.')).toBeTruthy())
    expect(screen.queryByLabelText('Controls')).toBeNull()
    expect(screen.queryByLabelText('Project')).toBeNull()
    // Its own single action instead of project mode's pair.
    expect(screen.getByText('Done')).toBeTruthy()
    expect(screen.queryByText('Close project')).toBeNull()
  })
})
