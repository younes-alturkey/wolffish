/**
 * Switching conversations from the sheet, on the one screen the app has.
 *
 * The chat screen used to be per-conversation: History PUSHED a copy of it, so
 * everything in flight belonged to a component that was about to be covered up.
 * The sheet swaps the conversation IN PLACE instead — the desktop's model, and
 * the only one that survives a navigator you can open from every conversation —
 * which puts two things on this screen that were never on it before:
 *
 *  - a send that outlives the conversation it was sent from. The turn keeps
 *    running where it was sent (that IS concurrency), but its result must not
 *    drag the user back into a chat they have left, and must not mark a send
 *    they have since started in the NEW one as finished.
 *  - a mid-turn message sent into the turn being walked away from. That one is
 *    the DESKTOP's, parked in its turn runner under the conversation it was
 *    sent to, so leaving must not take it back — it goes off screen with that
 *    conversation and is drawn again on the way in.
 *
 * Both are silent when wrong: the screen simply shows the wrong conversation, or
 * refuses to send, with nothing thrown anywhere.
 */

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  // The focus-scoped badge clearing belongs to react-navigation; a no-op
  // keeps this suite free of notification side effects.
  useFocusEffect: () => undefined,
  useLocalSearchParams: () => ({ id: 'conv-a' })
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

// The real feed is a reanimated scroller with a reveal gate; what it contains
// is not what this file is about.
jest.mock('@/components/chat/ChatFeed', () => {
  const { View } = require('react-native')
  return {
    FEED_FADE_MS: 0,
    ChatFeed: ({ children }: { children: React.ReactNode }) => <View testID="feed">{children}</View>
  }
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
      <Text testID="send" onPress={() => onSubmit({ kind: 'text', text: 'hello', files: [] })}>
        {streaming ? 'stop' : 'send'}
      </Text>
    )
  }
})

/**
 * The sheet, reduced to the one thing this file is about: a way to ask for
 * another conversation — either of the two, since coming BACK is half of what
 * switching in place has to get right. What it actually draws is pinned in
 * components/chat/__tests__/ConversationsSheet.test.tsx.
 */
jest.mock('@/components/chat/ConversationsSheet', () => {
  const { Text, View } = require('react-native')
  return {
    ConversationsSheet: ({ onSelect }: { onSelect: (id: string) => void }) => (
      <View>
        {['conv-a', 'conv-b'].map((id) => (
          <Text key={id} testID={`open-${id}`} onPress={() => onSelect(id)}>
            sheet
          </Text>
        ))}
      </View>
    )
  }
})

const mockConversation: { data: unknown; isFetching: boolean } = { data: null, isFetching: false }
jest.mock('@/lib/conversations/hooks', () => ({ useConversation: () => mockConversation }))

let mockResolveSend: (value: { conversationId: string }) => void = () => undefined
jest.mock('@/lib/sync/prompt', () => ({
  sendPrompt: jest.fn(
    () => new Promise<{ conversationId: string }>((resolve) => (mockResolveSend = resolve))
  ),
  interject: jest.fn(async () => ({ status: 'pending' })),
  withdrawInterjection: jest.fn(async () => undefined),
  beginTurn: jest.fn(),
  abortTurn: jest.fn()
}))

import ChatScreen from '@/app/chat'
import { interject, withdrawInterjection } from '@/lib/sync/prompt'
import { queryClient } from '@/lib/query/queryClient'
import { ThemeContext } from '@/providers/theme/useTheme'
import { ToastProvider } from '@/providers/toast/ToastProvider'
import { useAppStore } from '@/state/appStore'
import { useChatRuntime } from '@/state/chatRuntime'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render } from '@testing-library/react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'

let view: Awaited<ReturnType<typeof render>>

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
          <ToastProvider>
            <ChatScreen />
          </ToastProvider>
        </ThemeContext.Provider>
      </SafeAreaProvider>
    </QueryClientProvider>
  )
}

const sendLabel = (): string => view.getByTestId('send').props.children as string
const press = (testID: string): Promise<void> => fireEvent.press(view.getByTestId(testID))
/** The caption under a message the agent has not read yet. */
const PENDING_CAPTION = 'Read at the next step'
/** The mid-turn messages the runtime holds for one conversation. */
const pendingFor = (conversationId: string): unknown[] =>
  useChatRuntime.getState().pending[conversationId] ?? []
const interjectMock = interject as jest.MockedFunction<typeof interject>
const withdraw = withdrawInterjection as jest.MockedFunction<typeof withdrawInterjection>

/** A turn is running in this conversation, from wherever it was started. */
const runTurn = async (conversationId: string): Promise<void> => {
  await act(async () => {
    useChatRuntime.getState().putStream(conversationId, {
      message: { role: 'assistant', content: '', timestamp: 1 },
      status: 'streaming'
    })
  })
}

beforeEach(() => {
  useAppStore.setState({ paired: true })
  useChatRuntime.setState({ streams: {}, pending: {}, draftRestores: {} })
  mockConversation.data = null
  mockConversation.isFetching = false
  interjectMock.mockClear()
  withdraw.mockClear()
})

afterEach(() => {
  cleanup()
  queryClient.clear()
})

describe('switching conversations in place', () => {
  it('leaves the turn running where it was, and follows it back', async () => {
    await mount()
    await runTurn('conv-a')
    expect(sendLabel()).toBe('stop')

    // Walk away. The turn is not stopped — nothing on this screen can stop a
    // turn by navigating — so the entry is still there, and the conversation
    // now on screen has no turn of its own.
    await press('open-conv-b')
    expect(useChatRuntime.getState().streams['conv-a']).toBeTruthy()
    expect(sendLabel()).toBe('send')

    // And it is still running when the user comes back to it.
    await runTurn('conv-b')
    expect(Object.keys(useChatRuntime.getState().streams).sort()).toEqual(['conv-a', 'conv-b'])
    expect(sendLabel()).toBe('stop')
  })

  /**
   * The old shape of this was a queue: a mid-turn message waited on THIS
   * screen, so walking away threw it out. It does not wait here any more — it
   * is handed to the running turn at the tap and parked in the desktop's
   * inbox under the conversation it was sent to. So leaving is not a
   * cancellation: nothing is withdrawn, the row simply belongs to a
   * conversation that is no longer on screen, and it is back the moment that
   * conversation is. (What a switch DOES drop is a message written before the
   * chat had an id — it never left the phone; see chatInterject.test.tsx.)
   */
  it('leaves a mid-turn message with the conversation it was sent to', async () => {
    await mount()
    await runTurn('conv-a')
    await press('send')
    expect(interjectMock).toHaveBeenCalledTimes(1)
    expect(interjectMock.mock.calls[0]?.[0]?.conversationId).toBe('conv-a')
    expect(view.getByText(PENDING_CAPTION)).toBeTruthy()

    // Off screen with the conversation it is steering — and untouched: the
    // desktop is still holding it, and nothing here asked for it back.
    await press('open-conv-b')
    expect(view.queryByText(PENDING_CAPTION)).toBeNull()
    expect(pendingFor('conv-a')).toHaveLength(1)
    expect(withdraw).not.toHaveBeenCalled()

    // And drawn again on the way back, under the same turn it is waiting on.
    await press('open-conv-a')
    expect(view.getByText(PENDING_CAPTION)).toBeTruthy()
    expect(sendLabel()).toBe('stop')
  })

  it('a send settling after the switch does not drag the user back', async () => {
    await mount()
    // A send into conv-a that the desktop has not answered yet.
    await press('send')
    expect(sendLabel()).toBe('stop')

    await press('open-conv-b')
    // The new conversation is idle — the send in flight belongs to the old one.
    expect(sendLabel()).toBe('send')

    // conv-a's round trip lands now. It must change nothing here: not the
    // conversation on screen, and not the composer, which is free to send.
    await act(async () => {
      mockResolveSend({ conversationId: 'conv-a' })
    })
    expect(sendLabel()).toBe('send')

    // Proof that the screen is still on conv-b: a turn started there drives the
    // composer, and one started in conv-a does not.
    await runTurn('conv-b')
    expect(sendLabel()).toBe('stop')
  })
})
