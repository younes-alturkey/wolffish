/**
 * The chat screen, rendered, across the moment a prompt is sent.
 *
 * conversations/feed.ts decides what rows exist and turnOrdering.test.ts drives
 * the wire; neither of them can catch the screen putting those rows on hold.
 * That was the first half of the complaint — "I see nothing when I send a
 * prompt" — and it lived entirely here: a new chat has no conversation to load,
 * so it fell through the hero (gone the moment feed length changed) into a
 * conversation query that had not resolved, and rendered an empty feed for the
 * length of a round trip.
 *
 * So this asserts frames, like the others, but real ones — what is mounted
 * after each step, including the two handovers where a blank could hide: the
 * tap, and the arrival of the conversation id.
 */

import { cleanup, act, fireEvent, render } from '@testing-library/react-native'
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
  useLocalSearchParams: () => ({})
}))
jest.mock('expo-image', () => {
  const { View } = require('react-native')
  return { Image: View }
})
// Pulled in through the message renderers' file/chart cards; nothing here
// renders one, and the native module is not registered in a jest binary.
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
// Reanimated's worklets runtime needs the native binary; the screen uses it
// only for the skeleton's fade-out, which has no bearing on what is mounted.
jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native')
  const fade = { duration: () => fade }
  return { __esModule: true, default: { View }, FadeOut: fade }
})

/** The composer's only role here is to hand the screen a submit. */
jest.mock('@/components/chat/Composer', () => {
  const { Text } = require('react-native')
  return {
    Composer: ({
      onSubmit,
      streaming
    }: {
      onSubmit: (p: { kind: 'text'; text: string; files: [] }) => void
      streaming: boolean
    }) => (
      <Text
        testID="send"
        onPress={() => onSubmit({ kind: 'text', text: 'hello there', files: [] })}
      >
        {streaming ? 'stop' : 'send'}
      </Text>
    )
  }
})

/**
 * The real feed is a scroller with a reveal gate; its rows are what matter —
 * and its row count on EVERY commit, which is the only way to catch a blank
 * that lasts one frame and is gone before any query could run.
 */
const mockCommits: number[] = []
jest.mock('@/components/chat/ChatFeed', () => {
  const { View } = require('react-native')
  const React = require('react')
  return {
    FEED_FADE_MS: 0,
    ChatFeed: ({ children }: { children: React.ReactNode }) => {
      mockCommits.push(React.Children.count(children))
      return <View testID="feed">{children}</View>
    }
  }
})

const mockConversation: { data: unknown; isFetching: boolean } = {
  data: undefined,
  isFetching: true
}
jest.mock('@/lib/conversations/hooks', () => ({
  useConversation: () => mockConversation
}))

let mockResolveSend: (value: { conversationId: string }) => void = () => undefined
jest.mock('@/lib/sync/prompt', () => ({
  sendPrompt: jest.fn(
    () => new Promise<{ conversationId: string }>((resolve) => (mockResolveSend = resolve))
  ),
  abortTurn: jest.fn()
}))

import ChatScreen from '@/app/chat'
import { queryClient } from '@/lib/query/queryClient'
import { QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from '@/providers/toast/ToastProvider'
import { useAppStore } from '@/state/appStore'
import { useChatRuntime } from '@/state/chatRuntime'

const CONVERSATION = 'conv-1'

let view: Awaited<ReturnType<typeof render>>

// RTL 14 renders through act() and publishes the result asynchronously.
async function mount(): Promise<void> {
  view = await render(
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
          {/* Real, not a stub: the send path raises toasts for a file that could
            not be sent, and a provider-less screen would throw on the first. */}
          <ToastProvider>
            <ChatScreen />
          </ToastProvider>
        </ThemeContext.Provider>
      </SafeAreaProvider>
    </QueryClientProvider>
  )
}

/** How many rows on screen say this. */
const count = (pattern: RegExp): number => view.queryAllByText(pattern).length
/** The typed thinking words render as "<word>…", starting empty. */
const thinking = (): boolean => count(/…/) > 0
const prompt = (): boolean => count(/hello there/) > 0

afterEach(() => {
  // Two open handles, or the jest worker never exits after the last assertion:
  // the mounted tree (any interval it holds is cleared on unmount) and the query
  // cache (a query that loses its last observer arms a 7-day gc timer).
  cleanup()
  queryClient.clear()
})

beforeEach(() => {
  useAppStore.setState({ paired: true })
  useChatRuntime.setState({ streams: {} })
  mockConversation.data = undefined
  mockConversation.isFetching = true
  mockCommits.length = 0
})

/** No commit of the feed has ever been empty since the send. */
const expectNoBlankCommit = (): void => expect(mockCommits.filter((n) => n === 0)).toEqual([])

describe('sending from a new chat', () => {
  it('never shows an empty screen between the tap and the reply', async () => {
    await mount()
    // Before: the hero. Nothing has been sent, so there is no feed at all.
    expect(prompt()).toBe(false)
    expect(view.queryByTestId('feed')).toBeNull()

    // The tap. Both rows go up together — the prompt and the thinking words.
    await fireEvent.press(view.getByTestId('send'))
    expect(prompt()).toBe(true)
    expect(thinking()).toBe(true)
    expect(view.getByTestId('send')).toHaveTextContent('stop')

    // Still nothing back from the desktop: the conversation query is undefined
    // AND fetching, which is exactly the state that used to render blank.
    await act(async () => undefined)
    expect(prompt()).toBe(true)
    expect(thinking()).toBe(true)
    expectNoBlankCommit()
  })

  it('hands the rows from the screen to the live turn without dropping a frame', async () => {
    await mount()
    await fireEvent.press(view.getByTestId('send'))

    // The desktop answers with an id, and the live turn takes over the rows the
    // screen was holding. Both updates land in one commit; if they did not, the
    // frame between them would be the blank this test exists for.
    await act(async () => {
      useChatRuntime.getState().putStream(CONVERSATION, {
        message: { role: 'assistant', content: '', timestamp: 2 },
        user: { id: 'm_1_aaaaaa', role: 'user', content: 'hello there', timestamp: 1 },
        status: 'streaming'
      })
      mockResolveSend({ conversationId: CONVERSATION })
    })

    expect(prompt()).toBe(true)
    expect(thinking()).toBe(true)

    // The reply streams in: the thinking words give way to text, in place.
    await act(async () => {
      useChatRuntime.getState().putStream(CONVERSATION, {
        message: {
          id: 'm_2_bbbbbb',
          role: 'assistant',
          content: 'Working on it.',
          timestamp: 2,
          segments: [{ kind: 'text', turnId: 't', segmentId: 's1', delta: 'Working on it.' }]
        },
        user: { id: 'm_1_aaaaaa', role: 'user', content: 'hello there', timestamp: 1 },
        status: 'streaming'
      })
    })
    expect(count(/Working on it\./)).toBeGreaterThan(0)
    expect(prompt()).toBe(true)

    // And the stored transcript arrives carrying both, under the same ids.
    mockConversation.data = {
      id: CONVERSATION,
      title: 'A chat',
      messages: [
        { id: 'm_1_aaaaaa', role: 'user', content: 'hello there', timestamp: 1 },
        {
          id: 'm_2_bbbbbb',
          role: 'assistant',
          content: 'Working on it.',
          timestamp: 2,
          segments: [{ kind: 'text', turnId: 't', segmentId: 's1', delta: 'Working on it.' }]
        }
      ]
    }
    mockConversation.isFetching = false
    await act(async () => {
      useChatRuntime.getState().endStream(CONVERSATION)
    })

    // Once each, from the stored copy — not twice, which is what an overlay
    // released on a timer rather than on an id would have produced.
    expect(count(/hello there/)).toBe(1)
    expect(count(/Working on it\./)).toBe(1)
    expect(thinking()).toBe(false)
  })
})
