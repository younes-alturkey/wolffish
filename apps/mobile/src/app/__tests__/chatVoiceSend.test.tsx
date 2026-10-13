/**
 * The chat screen across a voice-note send.
 *
 * The 2–3 second gap this pins down: the voice branch used to upload the
 * recording BEFORE anything entered the feed, so the tap produced only the
 * thinking words for the length of a relay round trip, and the transport
 * popped in when the desktop finally answered. The recording is now staged
 * into the workspace at the tap and published like a file send's pictures —
 * so these tests hold the upload open and assert the transport is already on
 * screen, then walk the handover to the desktop's copy without a blank or a
 * doubled row.
 */

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { ThemeContext } from '@/providers/theme/useTheme'

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useFocusEffect: () => undefined,
  useLocalSearchParams: () => ({})
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

/** The composer's only role here is to hand the screen its submits. */
jest.mock('@/components/chat/Composer', () => {
  const { Text, View } = require('react-native')
  return {
    Composer: ({ onSubmit, streaming }: { onSubmit: (p: unknown) => void; streaming: boolean }) => (
      <View>
        <Text
          testID="send-text"
          onPress={() => onSubmit({ kind: 'text', text: 'hello there', files: [] })}
        >
          {streaming ? 'stop' : 'send'}
        </Text>
        <Text
          testID="send-voice"
          onPress={() =>
            onSubmit({ kind: 'voice', uri: 'file:///av/recording.m4a', durationSeconds: 3.5 })
          }
        >
          voice
        </Text>
      </View>
    )
  }
})

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

/**
 * The workspace, reduced to what this suite needs: staging always succeeds
 * (the bytes are local), and every path stats as cached — which is the
 * production behavior a staged or imported file has, and what lets the
 * transport mount loaded rather than in its download state.
 */
jest.mock('@/lib/files/fileCache', () => ({
  statCachedFile: jest.fn(() => ({ uri: 'file:///workspace/cached.m4a', sizeBytes: 1234 })),
  resolveWorkspaceFile: jest.fn(async () => ({
    uri: 'file:///workspace/cached.m4a',
    missing: false
  })),
  stageOutgoingFile: jest.fn(async (_uri: string, id: string, name: string) => ({
    relPath: `uploads/.staging/${id}/${name}`,
    uri: `file:///workspace/uploads/.staging/${id}/${name}`,
    sizeBytes: 1234
  })),
  importLocalFile: jest.fn(async (_uri: string, relPath: string) => `file:///workspace/${relPath}`),
  discardStagedFile: jest.fn(),
  isStagedPath: jest.fn(() => false),
  seedWorkspaceFile: jest.fn()
}))

/** Every upload is left pending until the test resolves it — the relay round
 *  trip the whole suite is about. */
let mockResolveUpload: (value: unknown) => void = () => undefined
jest.mock('@/lib/sync/files', () => ({
  uploadFileToDesktop: jest.fn(
    () => new Promise<unknown>((resolve) => (mockResolveUpload = resolve))
  )
}))

/** sendPrompt held open like the upload; beginTurn and friends stay REAL so
 *  the voice branch's optimistic publish drives the actual live-turn store. */
let mockResolveSend: (value: { conversationId: string }) => void = () => undefined
jest.mock('@/lib/sync/prompt', () => {
  const actual = jest.requireActual('@/lib/sync/prompt')
  return {
    ...actual,
    sendPrompt: jest.fn(
      () => new Promise<{ conversationId: string }>((resolve) => (mockResolveSend = resolve))
    ),
    abortTurn: jest.fn()
  }
})

import ChatScreen from '@/app/chat'
import { queryClient } from '@/lib/query/queryClient'
import { sendPrompt } from '@/lib/sync/prompt'
import { uploadFileToDesktop } from '@/lib/sync/files'
import { QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from '@/providers/toast/ToastProvider'
import { useAppStore } from '@/state/appStore'
import { useChatRuntime } from '@/state/chatRuntime'

const CONVERSATION = 'conv-1'
const send = sendPrompt as jest.MockedFunction<typeof sendPrompt>
const upload = uploadFileToDesktop as jest.Mock

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

const count = (pattern: RegExp): number => view.queryAllByText(pattern).length
/** The transport's name row — the recording, rendered. */
const transports = (): number => count(/voice-\d+\.m4a/)
const thinking = (): boolean => count(/…/) > 0

/** Answer the pending upload the way the desktop does: under its own path,
 *  keeping the name the phone sent. */
const desktopAccepts = (): void => {
  const uploadedName = upload.mock.calls[upload.mock.calls.length - 1][1] as string
  mockResolveUpload({
    conversationId: CONVERSATION,
    attachment: {
      type: 'audio',
      filePath: `uploads/conv-1/${uploadedName}`,
      originalName: uploadedName,
      mimeType: 'audio/mp4',
      sizeBytes: 4321
    }
  })
}

afterEach(() => {
  cleanup()
  queryClient.clear()
})

beforeEach(() => {
  jest.clearAllMocks()
  useAppStore.setState({ paired: true })
  useChatRuntime.setState({ streams: {} })
  mockConversation.data = undefined
  mockConversation.isFetching = true
  mockCommits.length = 0
})

const expectNoBlankCommit = (): void => expect(mockCommits.filter((n) => n === 0)).toEqual([])

describe('sending a voice note', () => {
  it('puts the transport on screen at the tap, before the desktop answers', async () => {
    await mount()
    await fireEvent.press(view.getByTestId('send-voice'))

    // The bubble is up while the upload is STILL OPEN — the desktop has not
    // named the file and sendPrompt has not run. This is the 2–3 seconds that
    // used to show only the thinking words.
    await waitFor(() => expect(transports()).toBe(1))
    expect(upload).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
    expect(thinking()).toBe(true)

    // The desktop answers; the message goes with the desktop's own metadata
    // and the id the bubble already renders under.
    await act(async () => desktopAccepts())
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const input = send.mock.calls[0][0]
    expect(input.voicePrompt).toBe(true)
    expect(input.messageId).toMatch(/^m_/)
    expect(input.attachments?.[0]?.filePath).toMatch(/^uploads\/conv-1\/voice-\d+\.m4a$/)
    expect(input.attachments?.[0]?.durationSeconds).toBe(3.5)
    // The transport never left the screen while the paths swapped underneath.
    expect(transports()).toBe(1)

    // The turn opens under the same id and the send settles: still one row.
    await act(async () => {
      useChatRuntime.getState().putStream(CONVERSATION, {
        message: { role: 'assistant', content: '', timestamp: 2 },
        user: {
          id: input.messageId as string,
          role: 'user',
          content: '',
          timestamp: 1,
          voicePrompt: true,
          attachments: input.attachments
        },
        status: 'streaming'
      })
      mockResolveSend({ conversationId: CONVERSATION })
    })
    expect(transports()).toBe(1)
    expect(thinking()).toBe(true)
    expectNoBlankCommit()
  })

  it('publishes the bubble on the live turn for a conversation that already exists', async () => {
    await mount()
    // Adopt a conversation first: a plain text send, settled with stored rows.
    await fireEvent.press(view.getByTestId('send-text'))
    mockConversation.data = {
      id: CONVERSATION,
      title: 'A chat',
      messages: [
        { id: 'm_1_aaaaaa', role: 'user', content: 'hello there', timestamp: 1 },
        { id: 'm_2_bbbbbb', role: 'assistant', content: 'Working on it.', timestamp: 2 }
      ]
    }
    mockConversation.isFetching = false
    await act(async () => {
      mockResolveSend({ conversationId: CONVERSATION })
    })
    expect(count(/hello there/)).toBe(1)

    // The voice tap. The bubble rides the conversation's live turn — the real
    // beginTurn — and is on screen while the upload is still open.
    await fireEvent.press(view.getByTestId('send-voice'))
    await waitFor(() => expect(transports()).toBe(1))
    expect(send).toHaveBeenCalledTimes(1) // the text send only
    const live = useChatRuntime.getState().streams[CONVERSATION]
    expect(live?.user?.attachments?.[0]?.filePath).toMatch(/^uploads\/\.staging\//)
    expect(thinking()).toBe(true)

    // Desktop answers; the prompt goes out under the id the live row holds,
    // so the desktop-path copy replaces the bubble rather than joining it.
    await act(async () => desktopAccepts())
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    const input = send.mock.calls[1][0]
    expect(input.messageId).toBe(live?.user?.id)
    expect(input.conversationId).toBe(CONVERSATION)

    await act(async () => {
      mockResolveSend({ conversationId: CONVERSATION })
    })
    expect(transports()).toBe(1)
    expect(count(/hello there/)).toBe(1)
    expectNoBlankCommit()
  })
})
