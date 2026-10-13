/**
 * Running a procedure from its card.
 *
 * The desktop's Play starts a FRESH conversation and auto-sends the prompt into
 * it. On the phone that has to happen in two steps, and getting the order wrong
 * is silent: the chat screen clears the open conversation through state, so a
 * submit issued in the same tick still reads the conversation the user was
 * looking at and files the procedure's turn there — a run that appears to have
 * worked, in the wrong transcript. What is pinned here is therefore WHICH
 * conversation the prompt goes to, and that it goes exactly once.
 */

import { cleanup, act, render } from '@testing-library/react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { ThemeContext } from '@/providers/theme/useTheme'

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  // The focus-scoped badge clearing belongs to react-navigation; a no-op
  // keeps this suite free of notification side effects.
  useFocusEffect: () => undefined,
  useLocalSearchParams: () => mockParams
}))
jest.mock('expo-image', () => {
  const { View } = require('react-native')
  return { Image: View }
})
jest.mock('react-native-webview', () => {
  const { View } = jest.requireActual('react-native')
  return { WebView: (props: object) => <View {...props} /> }
})
jest.mock('expo-audio', () => ({
  useAudioPlayer: () => ({ play: jest.fn(), pause: jest.fn(), remove: jest.fn() }),
  useAudioPlayerStatus: () => ({ playing: false, currentTime: 0, duration: 0 }),
  setAudioModeAsync: jest.fn()
}))
jest.mock('expo-video', () => ({
  useVideoPlayer: () => ({ loop: false, status: 'readyToPlay' }),
  VideoView: () => null
}))
jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native')
  const fade = { duration: () => fade }
  return { __esModule: true, default: { View }, FadeOut: fade }
})
jest.mock('@/components/chat/Composer', () => ({ Composer: () => null }))
jest.mock('@/components/chat/ChatFeed', () => {
  const { View } = require('react-native')
  return {
    FEED_FADE_MS: 0,
    ChatFeed: ({ children }: { children: React.ReactNode }) => <View>{children}</View>
  }
})

let mockParams: { id?: string } = {}

const mockConversation: { data: unknown; isFetching: boolean } = {
  data: undefined,
  isFetching: false
}
jest.mock('@/lib/conversations/hooks', () => ({ useConversation: () => mockConversation }))

let mockResolveSend: (value: { conversationId: string }) => void = () => undefined
jest.mock('@/lib/sync/prompt', () => ({
  sendPrompt: jest.fn(
    () => new Promise<{ conversationId: string }>((resolve) => (mockResolveSend = resolve))
  ),
  abortTurn: jest.fn()
}))

import ChatScreen from '@/app/chat'
import { sendPrompt } from '@/lib/sync/prompt'
import { queryClient } from '@/lib/query/queryClient'
import { QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from '@/providers/toast/ToastProvider'
import { useAppStore } from '@/state/appStore'
import { useChatRuntime } from '@/state/chatRuntime'

const send = sendPrompt as jest.MockedFunction<typeof sendPrompt>
const OPEN = 'conv-open'

async function mount(): Promise<void> {
  await render(
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
          <ToastProvider>
            <ChatScreen />
          </ToastProvider>
        </ThemeContext.Provider>
      </SafeAreaProvider>
    </QueryClientProvider>
  )
}

afterEach(() => {
  // Two open handles, or the jest worker never exits after the last assertion:
  // the mounted tree (any interval it holds is cleared on unmount) and the query
  // cache (a query that loses its last observer arms a 7-day gc timer).
  cleanup()
  queryClient.clear()
})

beforeEach(() => {
  useAppStore.setState({ paired: true })
  useChatRuntime.setState({ streams: {}, pendingPrompt: null, activeProjectId: null })
  mockParams = {}
  mockConversation.data = undefined
  send.mockClear()
})

describe('a procedure run', () => {
  it('sends into a FRESH conversation, never the one that was open', async () => {
    // The user was reading a conversation when they went to run the procedure.
    mockParams = { id: OPEN }
    await mount()
    expect(send).not.toHaveBeenCalled()

    await act(async () => {
      useChatRuntime.getState().setPendingPrompt('Summarize my week.')
    })

    expect(send).toHaveBeenCalledTimes(1)
    // null, not OPEN: the desktop mints the conversation, which is what makes
    // this a new chat rather than a message appended to what was on screen.
    expect(send.mock.calls[0][0]).toMatchObject({
      conversationId: null,
      text: 'Summarize my week.'
    })
  })

  it('sends once, and takes the prompt out of the runtime as it goes', async () => {
    await mount()
    await act(async () => {
      useChatRuntime.getState().setPendingPrompt('Run me.')
    })
    expect(useChatRuntime.getState().pendingPrompt).toBeNull()

    // The reply lands and the screen adopts the minted id — the re-renders that
    // follow must not replay the run.
    await act(async () => {
      mockResolveSend({ conversationId: 'conv-new' })
    })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('starts from an empty chat with nothing left over from the last one', async () => {
    mockParams = { id: OPEN }
    await mount()
    await act(async () => {
      useChatRuntime.getState().setPendingPrompt('Fresh.')
    })
    // The conversation the run replaced keeps its own live entry — leaving is not
    // stopping — but the prompt went to a new one.
    expect(send.mock.calls[0][0].conversationId).toBeNull()
  })
})

/**
 * Entering a project is entering a NEW conversation in it.
 *
 * Both ways in — the Projects screen's card and the chat menu's picker — live on
 * other screens, so they can only set project mode; this screen is what puts the
 * open conversation down. Getting it wrong is silent in the worst way: the chat
 * you were already in would wear the project's chrome while every one of its
 * turns ran without the project's instructions.
 */
describe('entering a project', () => {
  it('starts a fresh conversation, leaving the one that was open', async () => {
    mockParams = { id: OPEN }
    await mount()

    await act(async () => {
      useChatRuntime.getState().setActiveProject('proj-1')
    })

    // The next send goes to a conversation the desktop will mint — not to OPEN,
    // which was created outside the project.
    await act(async () => {
      useChatRuntime.getState().setPendingPrompt('First message in the project.')
    })
    expect(send.mock.calls[0][0].conversationId).toBeNull()
  })

  it('starts one on the way OUT too, so the next chat is plainly unfiled', async () => {
    mockParams = { id: OPEN }
    useChatRuntime.setState({ activeProjectId: 'proj-1' })
    await mount()

    await act(async () => {
      useChatRuntime.getState().setActiveProject(null)
    })
    await act(async () => {
      useChatRuntime.getState().setPendingPrompt('Outside now.')
    })
    expect(send.mock.calls[0][0].conversationId).toBeNull()
  })

  it('does not disturb the conversation you opened while already inside one', async () => {
    // Project mode does not change here — opening a project's conversation from
    // History must land on that transcript, not bounce out to an empty chat.
    useChatRuntime.setState({ activeProjectId: 'proj-1' })
    mockParams = { id: OPEN }
    await mount()

    await act(async () => {
      useChatRuntime.getState().setPendingPrompt('Reply here.')
    })
    // The pendingPrompt path resets on its own (a procedure run is always a new
    // chat); what matters is that no reset happened before it, which it could
    // only show by the project rule having fired. Assert the rule stayed put.
    expect(useChatRuntime.getState().activeProjectId).toBe('proj-1')
  })
})
