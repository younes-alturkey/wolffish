/**
 * The chat screen across the moment its transcript VANISHES.
 *
 * Every sync race that empties the stored copy mid-session used to land on
 * the worst frame the state machine had: the hero needs `!loading`, the
 * skeleton needed `!feedRevealed`, and a feed with no rows paints nothing —
 * the pure-blank chat reported 2026-08-26, opened from a notification
 * mid-run. These pin the repaired machine: rows → vanish shows the skeleton
 * (never blank, never the hero), the healed copy repaints without a remount,
 * and a conversation the query answers null for still resolves to the hero.
 */

import { cleanup, render } from '@testing-library/react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { ThemeContext } from '@/providers/theme/useTheme'

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useFocusEffect: () => undefined,
  // The screen opens ON a conversation — the notification-tap shape.
  useLocalSearchParams: () => ({ id: 'conv-1' })
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
jest.mock('@/components/chat/Composer', () => {
  const { View } = require('react-native')
  return { Composer: () => <View testID="composer" /> }
})
jest.mock('@/components/chat/ChatSkeleton', () => {
  const { View } = require('react-native')
  return { ChatSkeleton: () => <View testID="skeleton" /> }
})
jest.mock('@/components/chat/ChatFeed', () => {
  const { View } = require('react-native')
  const React = require('react')
  return {
    FEED_FADE_MS: 0,
    // The real feed reveals (onReady) once rows have been laid out and pinned;
    // the mock honours that contract so `feedRevealed` arms the way it does in
    // the app — the vanish scenario is precisely about what happens AFTER it.
    ChatFeed: ({ children, onReady }: { children: React.ReactNode; onReady: () => void }) => {
      const hasRows = React.Children.count(children) > 0
      React.useEffect(() => {
        if (hasRows) onReady()
      }, [hasRows, onReady])
      return <View testID="feed">{children}</View>
    }
  }
})

const mockConversation: { data: unknown; isFetching: boolean } = {
  data: undefined,
  isFetching: true
}
jest.mock('@/lib/conversations/hooks', () => ({
  useConversation: () => ({ ...mockConversation })
}))
jest.mock('@/lib/sync/prompt', () => ({
  sendPrompt: jest.fn(),
  abortTurn: jest.fn()
}))

import ChatScreen from '@/app/chat'
import { queryClient } from '@/lib/query/queryClient'
import { QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from '@/providers/toast/ToastProvider'
import { useAppStore } from '@/state/appStore'
import { useChatRuntime } from '@/state/chatRuntime'

let view: Awaited<ReturnType<typeof render>>

function screenTree(): React.JSX.Element {
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
          <ToastProvider>
            <ChatScreen />
          </ToastProvider>
        </ThemeContext.Provider>
      </SafeAreaProvider>
    </QueryClientProvider>
  )
}

async function mount(): Promise<void> {
  view = await render(screenTree())
}

const transcript = () => [
  { id: 'm1', role: 'user' as const, content: 'run the report', timestamp: 1 },
  { id: 'm2', role: 'assistant' as const, content: 'the report is done', timestamp: 2 }
]

const skeleton = (): boolean => view.queryAllByTestId('skeleton').length > 0
const hero = (): boolean => view.queryAllByText(/Wolffish is ready/).length > 0
const rows = (): number => view.queryAllByText(/report/).length

afterEach(() => {
  cleanup()
  queryClient.clear()
})

beforeEach(() => {
  useAppStore.setState({ paired: true })
  useChatRuntime.setState({ streams: {} })
  mockConversation.data = undefined
  mockConversation.isFetching = true
})

describe('a transcript that vanishes mid-session', () => {
  it('shows the skeleton over the gap — never a blank feed, never the hero', async () => {
    mockConversation.data = { id: 'conv-1', messages: transcript() }
    mockConversation.isFetching = false
    await mount()
    expect(rows()).toBeGreaterThan(0)

    // The stored copy empties under the open screen (a sync race mid-heal) —
    // present-but-empty, no fetch running: previously the machine's blank
    // frame (hero needs !loading, skeleton needed !feedRevealed).
    mockConversation.data = { id: 'conv-1', messages: [] }
    await view.rerender(screenTree())

    expect(rows()).toBe(0)
    expect(skeleton()).toBe(true)
    expect(hero()).toBe(false)

    // A fetch racing in behind it changes nothing about what is shown.
    mockConversation.isFetching = true
    await view.rerender(screenTree())
    expect(skeleton()).toBe(true)
    expect(hero()).toBe(false)

    // The healed copy repaints — same mounted feed, skeleton gone.
    mockConversation.data = { id: 'conv-1', messages: transcript() }
    mockConversation.isFetching = false
    await view.rerender(screenTree())
    expect(rows()).toBeGreaterThan(0)
    expect(skeleton()).toBe(false)
  })

  it('a conversation the query answers null for still resolves to the hero', async () => {
    mockConversation.data = { id: 'conv-1', messages: transcript() }
    mockConversation.isFetching = false
    await mount()
    expect(rows()).toBeGreaterThan(0)

    // Genuinely gone — deleted out from under the screen. Not a race: the
    // row itself no longer exists, and the hero is the honest resolution.
    mockConversation.data = null
    await view.rerender(screenTree())

    expect(hero()).toBe(true)
    expect(skeleton()).toBe(false)
  })

  it('an opened conversation still shows the skeleton while first loading', async () => {
    mockConversation.data = undefined
    mockConversation.isFetching = true
    await mount()

    expect(skeleton()).toBe(true)
    expect(hero()).toBe(false)
  })
})
