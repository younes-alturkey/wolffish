/**
 * The chat screen's mid-turn send — what happens to a prompt written while a
 * turn is still running.
 *
 * It goes INTO the turn. Not refused, not parked behind it: it is handed to
 * the desktop's turn runner (sync/prompt.ts interject) and the agent reads it
 * at its next step, so "skip the tests folder" reaches the work it was meant
 * to steer. Everything here is about WHICH call the screen makes and what it
 * shows while the answer is pending — the pending bubble under the live row,
 * and the withdraw that takes it back. A submit that reached sendPrompt
 * mid-turn would preempt the running turn, which is the one thing that must
 * never happen by accident.
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

/**
 * The composer stands in for the whole input: two ways to hand a submit over,
 * and whether the screen calls the turn running.
 */
jest.mock('@/components/chat/Composer', () => {
  const { Text, View } = require('react-native')
  return {
    Composer: ({
      onSubmit,
      streaming
    }: {
      onSubmit: (p: { kind: 'text'; text: string; files: unknown[] }) => void
      streaming: boolean
    }) => (
      <View>
        {['first', 'second'].map((text) => (
          <Text
            key={text}
            testID={`send-${text}`}
            onPress={() => onSubmit({ kind: 'text', text, files: [] })}
          >
            {streaming ? 'mid-turn' : 'idle'}
          </Text>
        ))}
        {/* The same submit with a file on it — the one whose hand-over is
            slow enough to be taken back mid-flight. */}
        <Text
          testID="send-with-file"
          onPress={() =>
            onSubmit({
              kind: 'text',
              text: 'skip the tests folder',
              files: [{ uri: 'file:///pic.jpg', name: 'pic.jpg', mimeType: 'image/jpeg' }]
            })
          }
        >
          file
        </Text>
      </View>
    )
  }
})

jest.mock('@/components/chat/ChatFeed', () => {
  const { View } = require('react-native')
  return {
    FEED_FADE_MS: 0,
    ChatFeed: ({ children }: { children: React.ReactNode }) => <View>{children}</View>
  }
})

/**
 * Rows reduced to their kind, in tree order — the pending bubble is real
 * (its caption and withdraw control are under test) and draws its user
 * bubble through the same stub.
 */
jest.mock('@/components/chat/MessageBubbles', () => {
  const { Text } = require('react-native')
  return {
    UserBubble: () => <Text testID="row-user">user</Text>,
    AssistantMessageView: () => <Text testID="row-assistant">assistant</Text>
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
 * The staging and upload of a file send. `stageForSend` hangs until the test
 * lets it go: that stall is the window this screen still owns the message in
 * — nothing downstream has been told it exists — and the window a withdraw
 * has to be answered in.
 */
let mockFinishStaging: () => void = () => undefined
jest.mock('@/lib/sync/attachments', () => ({
  stageForSend: jest.fn(
    () =>
      new Promise((resolve) => {
        mockFinishStaging = () => resolve([{ relPath: 'uploads/pic.jpg', uri: 'file:///pic.jpg' }])
      })
  ),
  stagedAttachment: () => ({ type: 'image', filePath: 'uploads/pic.jpg' }),
  discardStaged: jest.fn(),
  fileLocally: jest.fn(async () => [{ type: 'image', filePath: 'uploads/pic.jpg' }]),
  uploadForSend: jest.fn(async () => ({ attachments: [], failed: [], conversationId: null }))
}))

/** The demo turn runner — what an UNPAIRED mid-turn message must reach. */
jest.mock('@/lib/demo/agent', () => ({
  demoInterject: jest.fn(() => true),
  withdrawDemoInterjection: jest.fn(() => null),
  sendDemoPrompt: jest.fn(async () => 'conv-1'),
  stopDemoTurn: jest.fn(),
  deriveTitle: () => 'title',
  ensureDemoConversation: jest.fn(async () => 'conv-1')
}))

/** Every send is left pending until the test resolves it, exactly as a real
 *  round trip to the desktop would be. */
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
import { interject, sendPrompt, withdrawInterjection } from '@/lib/sync/prompt'
import { demoInterject, sendDemoPrompt } from '@/lib/demo/agent'
import { queryClient } from '@/lib/query/queryClient'
import { QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from '@/providers/toast/ToastProvider'
import { useAppStore } from '@/state/appStore'
import { useChatRuntime } from '@/state/chatRuntime'

const CONVERSATION = 'conv-1'
const PENDING_CAPTION = 'Read at the next step'
const send = sendPrompt as jest.MockedFunction<typeof sendPrompt>
const interjectMock = interject as jest.MockedFunction<typeof interject>
const withdraw = withdrawInterjection as jest.MockedFunction<typeof withdrawInterjection>
const demoPark = demoInterject as jest.MockedFunction<typeof demoInterject>
const demoSend = sendDemoPrompt as jest.MockedFunction<typeof sendDemoPrompt>

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

/** The first send comes back and the desktop is running its turn. */
async function turnRunning(): Promise<void> {
  await act(async () => {
    useChatRuntime.getState().putStream(CONVERSATION, {
      message: { role: 'assistant', content: '', timestamp: 2 },
      status: 'streaming'
    })
    mockResolveSend({ conversationId: CONVERSATION })
  })
}

/** The kinds of the rows on screen, top to bottom. */
const rows = (): string[] =>
  view
    .getAllByTestId(/^(row-assistant|pending-interjection)$/)
    .map((node) => node.props.testID as string)

/** The message ids the screen has pending for the open conversation. */
const pendingIds = (): string[] =>
  (useChatRuntime.getState().pending[CONVERSATION] ?? []).map((m) => m.id ?? '')

afterEach(() => {
  cleanup()
  queryClient.clear()
})

beforeEach(() => {
  useAppStore.setState({ paired: true })
  useChatRuntime.setState({ streams: {}, pending: {}, draftRestores: {} })
  mockConversation.data = undefined
  mockConversation.isFetching = false
  send.mockClear()
  interjectMock.mockClear()
  interjectMock.mockImplementation(async () => ({ status: 'pending' }))
  withdraw.mockClear()
  demoPark.mockClear()
  demoPark.mockImplementation(() => true)
  demoSend.mockClear()
})

describe('sending while a turn is running', () => {
  it('hands the message to the running turn and never starts a new one', async () => {
    await mount()
    await fireEvent.press(view.getByTestId('send-first'))
    expect(send).toHaveBeenCalledTimes(1)
    await turnRunning()

    await fireEvent.press(view.getByTestId('send-second'))
    expect(send).toHaveBeenCalledTimes(1)
    expect(interjectMock).toHaveBeenCalledTimes(1)
    const input = interjectMock.mock.calls[0]?.[0]
    expect(input?.conversationId).toBe(CONVERSATION)
    expect(input?.text).toBe('second')
    // The id the pending bubble is drawn under is the id the desktop echoes
    // back — that is what retires the bubble when the segment arrives.
    expect(input?.messageId).toMatch(/^m_/)
    expect(pendingIds()).toEqual([input?.messageId])
    // And the turn on screen is still the turn on screen.
    expect(useChatRuntime.getState().streams[CONVERSATION]?.status).toBe('streaming')
  })

  it('draws the pending bubble after the live assistant row, with its caption', async () => {
    await mount()
    await fireEvent.press(view.getByTestId('send-first'))
    await turnRunning()
    expect(rows()).toEqual(['row-assistant'])

    await fireEvent.press(view.getByTestId('send-second'))
    expect(rows()).toEqual(['row-assistant', 'pending-interjection'])
    expect(view.getByText(PENDING_CAPTION)).toBeTruthy()
  })

  it('sends it as a normal turn when the desktop reports no live turn', async () => {
    await mount()
    await fireEvent.press(view.getByTestId('send-first'))
    await turnRunning()

    interjectMock.mockImplementationOnce(async () => ({ status: 'no_live_turn' }))
    await fireEvent.press(view.getByTestId('send-second'))
    // Let the hand-over's answer land and the fallback run.
    await act(async () => undefined)
    expect(interjectMock).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(2)
    const fallback = send.mock.calls[1]?.[0]
    expect(fallback?.text).toBe('second')
    expect(fallback?.conversationId).toBe(CONVERSATION)
    // Same id: the bubble already on screen becomes the turn's prompt.
    expect(fallback?.messageId).toBe(interjectMock.mock.calls[0]?.[0]?.messageId)
  })

  it('takes a pending message back through the desktop when its X is tapped', async () => {
    await mount()
    await fireEvent.press(view.getByTestId('send-first'))
    await turnRunning()
    await fireEvent.press(view.getByTestId('send-second'))
    const id = interjectMock.mock.calls[0]?.[0]?.messageId ?? ''

    await fireEvent.press(view.getByLabelText('Withdraw message'))
    expect(withdraw).toHaveBeenCalledWith(CONVERSATION, id)
    // The row itself comes down on the desktop's `withdrawn` push (prompt.ts),
    // not here — the desktop decides, since the agent may have read it a
    // beat ago. Nothing was sent as a turn.
    expect(send).toHaveBeenCalledTimes(1)
  })

  /**
   * A second message written before the FIRST send has come back — the chat
   * has no conversation id yet, so there is no turn to hand it to. It shows
   * at once and goes the moment the id arrives.
   */
  it('holds a message written before the chat has an id, then hands it over', async () => {
    await mount()
    await fireEvent.press(view.getByTestId('send-first'))
    await fireEvent.press(view.getByTestId('send-second'))
    expect(send).toHaveBeenCalledTimes(1)
    expect(interjectMock).not.toHaveBeenCalled()
    expect(view.getByText(PENDING_CAPTION)).toBeTruthy()

    await turnRunning()
    expect(interjectMock).toHaveBeenCalledTimes(1)
    expect(interjectMock.mock.calls[0]?.[0]?.conversationId).toBe(CONVERSATION)
    expect(interjectMock.mock.calls[0]?.[0]?.text).toBe('second')
    expect(send).toHaveBeenCalledTimes(1)
    expect(view.getByText(PENDING_CAPTION)).toBeTruthy()
  })

  /**
   * The second submit landing while the FIRST send is still in flight, in a
   * conversation that already has an id. There is no turn yet — the one being
   * opened is the turn this message means to steer — so handing it over now
   * gets `no_live_turn` back and the message would go as a turn of its OWN,
   * racing the send it was written behind. Two turns would then run in one
   * conversation, fighting over one live overlay. It waits instead.
   */
  it('waits for a send already in flight rather than opening a turn beside it', async () => {
    await mount()
    // A first send into an existing conversation, still on its round trip.
    await fireEvent.press(view.getByTestId('send-first'))
    await turnRunning()
    await fireEvent.press(view.getByTestId('send-second'))
    await act(async () => undefined)
    expect(interjectMock).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)

    // Now a THIRD, written while a fresh send is mid-flight: `sending` is
    // true and no turn has opened for it yet. (Inside `act`, or the screen
    // still renders against the turn that just ended.)
    await act(async () => {
      useChatRuntime.getState().endStream(CONVERSATION)
    })
    send.mockClear()
    interjectMock.mockClear()
    await fireEvent.press(view.getByTestId('send-first'))
    expect(send).toHaveBeenCalledTimes(1)
    await fireEvent.press(view.getByTestId('send-second'))
    await act(async () => undefined)
    // Held: not handed over, and above all not sent as a turn of its own.
    expect(interjectMock).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
    // Showing all the same — the wait is behind the bubble, not instead of it.
    // (Two rows now: the one handed over earlier, and this one waiting.)
    expect(view.getAllByText(PENDING_CAPTION)).toHaveLength(2)

    // The send lands; now there is a turn, and it goes into that one.
    await turnRunning()
    expect(interjectMock).toHaveBeenCalledTimes(1)
    expect(interjectMock.mock.calls[0]?.[0]?.text).toBe('second')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('drops a held message when the user walks away to a new chat', async () => {
    await mount()
    await fireEvent.press(view.getByTestId('send-first'))
    await fireEvent.press(view.getByTestId('send-second'))
    expect(view.getByText(PENDING_CAPTION)).toBeTruthy()

    await fireEvent.press(view.getByLabelText('New chat'))
    expect(view.queryByText(PENDING_CAPTION)).toBeNull()
    await turnRunning()
    expect(interjectMock).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
  })
})

/**
 * The same rule with no desktop behind it. Demo runs its agent on this phone,
 * so it has a turn runner and an inbox of its own — and it is NOT exempt: a
 * mid-turn submit that fell through to an ordinary demo send would start a
 * second turn in the conversation, and the two would share one live stream
 * and one timer (lib/demo/agent.ts), so whichever finished first would end
 * the other's overlay.
 */
describe('sending while a DEMO turn is running', () => {
  beforeEach(() => {
    useAppStore.setState({ paired: false })
  })

  it('parks it on the running demo turn instead of starting a second one', async () => {
    await mount()
    await fireEvent.press(view.getByTestId('send-first'))
    expect(demoSend).toHaveBeenCalledTimes(1)
    await turnRunning()

    await fireEvent.press(view.getByTestId('send-second'))
    await act(async () => undefined)
    expect(demoPark).toHaveBeenCalledTimes(1)
    expect(demoPark.mock.calls[0]?.[1]?.text).toBe('second')
    // The one thing that must never happen: a second demo turn.
    expect(demoSend).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
    // And it waits on screen exactly as a paired one does.
    expect(view.getByText(PENDING_CAPTION)).toBeTruthy()
  })

  it('sends it as an ordinary demo prompt when the turn has already ended', async () => {
    await mount()
    await fireEvent.press(view.getByTestId('send-first'))
    await turnRunning()

    // The turn ended in the sliver between the tap and the hand-over.
    demoPark.mockImplementation(() => false)
    await fireEvent.press(view.getByTestId('send-second'))
    await act(async () => undefined)
    expect(demoSend).toHaveBeenCalledTimes(2)
    expect(demoSend.mock.calls[1]?.[0]?.text).toBe('second')
    // Under the id its bubble was already drawn under, so the stored copy
    // replaces that bubble rather than joining it.
    expect(demoSend.mock.calls[1]?.[0]?.messageId).toMatch(/^m_/)
    expect(view.queryByText(PENDING_CAPTION)).toBeNull()
  })
})

/**
 * Withdrawing a message whose files are still moving.
 *
 * Nothing downstream has been told this message exists yet — not the desktop,
 * not a demo turn — so no `withdrawn` push and no runner answer is ever coming
 * for it. A row taken down on the strength of one that never arrives takes the
 * user's typed words with it, silently, which is the whole failure this covers.
 */
describe('taking a message back while the desktop is still deciding', () => {
  /**
   * The hand-over is in flight — for a voice note that is a whole
   * transcription long. A withdraw sent in that window asks the desktop for a
   * message it does not have yet, so it is refused and no push follows; the
   * desktop then parks the message and the agent reads something the user
   * took back. The ask has to be made again once it is known to have landed.
   */
  it('asks again once the desktop has the message', async () => {
    await mount()
    await fireEvent.press(view.getByTestId('send-first'))
    await turnRunning()

    let acceptInterjection: (value: { status: 'pending' }) => void = () => undefined
    interjectMock.mockImplementationOnce(
      () => new Promise((resolve) => (acceptInterjection = resolve))
    )
    await fireEvent.press(view.getByTestId('send-second'))
    const id = interjectMock.mock.calls[0]?.[0]?.messageId ?? ''

    // Taken back while the desktop is still deciding: this first ask is the
    // one that can miss.
    await fireEvent.press(view.getByLabelText('Withdraw message'))
    expect(withdraw).toHaveBeenCalledTimes(1)

    await act(async () => {
      acceptInterjection({ status: 'pending' })
    })
    // It landed after all, so the ask is repeated against a desktop that now
    // holds it — otherwise the agent reads a withdrawn message.
    expect(withdraw).toHaveBeenCalledTimes(2)
    expect(withdraw).toHaveBeenLastCalledWith(CONVERSATION, id)
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('taking a message back while its files are still uploading', () => {
  it('answers the withdraw here, and puts the words back in the composer', async () => {
    await mount()
    await fireEvent.press(view.getByTestId('send-first'))
    await turnRunning()

    await fireEvent.press(view.getByTestId('send-with-file'))
    expect(view.getByText(PENDING_CAPTION)).toBeTruthy()
    // The upload is still running: the hand-over has not happened.
    expect(interjectMock).not.toHaveBeenCalled()

    await fireEvent.press(view.getByLabelText('Withdraw message'))
    expect(view.queryByText(PENDING_CAPTION)).toBeNull()
    expect(useChatRuntime.getState().draftRestores[CONVERSATION]).toBe('skip the tests folder')
    // Not the desktop's to decide — it was never told.
    expect(withdraw).not.toHaveBeenCalled()

    // And when the bytes finally land, the message is not handed over — nor
    // does its bubble come back for the rest of the transfer.
    await act(async () => {
      mockFinishStaging()
    })
    expect(interjectMock).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
    expect(view.queryByText(PENDING_CAPTION)).toBeNull()
  })
})
