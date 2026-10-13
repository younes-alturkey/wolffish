/**
 * The composer's hand-over: what leaves it, how many times, and what the field
 * looks like on either side of that.
 *
 * The subject is one press producing one message. The draft is React state, so
 * a second press landing before the first has committed still reads the text
 * that was already handed over — on a phone that is an ordinary double tap, and
 * it used to send the same message twice.
 *
 * Mid-turn the composer is the same composer: Send is Send (the screen routes
 * it into the running turn), the placeholder is the one thing that changes,
 * and the field takes back the words of a withdrawn message.
 */

import { cleanup, act, fireEvent, render, waitFor } from '@testing-library/react-native'
import { Keyboard } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { ThemeContext } from '@/providers/theme/useTheme'

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)
// The rainbow strip and the sheets' entrances; nothing here turns on either.
jest.mock('@/components/chat/RainbowBorder', () => ({ RainbowBorder: () => null }))
jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native')
  const anim = { duration: () => anim, delay: () => anim, springify: () => anim }
  return { __esModule: true, default: { View }, FadeInDown: anim, FadeInUp: anim, FadeOut: anim }
})
// Whether a desktop is on the other end decides if plan mode can be on at all.
let mockReachable = true
jest.mock('@/lib/tunnel/useTunnelStatus', () => ({
  useDesktopReachable: () => mockReachable
}))
jest.mock('expo-audio', () => ({
  useAudioRecorder: () => ({ prepareToRecordAsync: jest.fn(), record: jest.fn(), stop: jest.fn() }),
  useAudioRecorderState: () => ({ durationMillis: 0 }),
  useAudioPlayer: () => ({ play: jest.fn(), pause: jest.fn() }),
  useAudioPlayerStatus: () => ({ playing: false, currentTime: 0, duration: 0 }),
  setAudioModeAsync: jest.fn(),
  AudioModule: { requestRecordingPermissionsAsync: jest.fn() },
  RecordingPresets: { HIGH_QUALITY: {} }
}))

import { Composer, type ComposerSubmit } from '@/components/chat/Composer'
import { queryClient } from '@/lib/query/queryClient'
import { QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from '@/providers/toast/ToastProvider'
import { useAppStore } from '@/state/appStore'
import { useChatRuntime } from '@/state/chatRuntime'

/** The expanded editor's placeholder — its handle here, and the assertion that
 *  the long copy is the one this surface carries. */
const EXPANDED = 'Message Wolffish — take all the room you need.'
/** Mid-turn, both fields say where the message is going. */
const MID_TURN = 'Message Wolffish while it works…'
const EXPANDED_MID_TURN = 'Message Wolffish while it works — take all the room you need.'

const onSubmit = jest.fn<void, [ComposerSubmit]>()
const CONVERSATION = 'conv-1'

let view: Awaited<ReturnType<typeof render>>

async function mount(streaming = false): Promise<void> {
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
            <Composer
              streaming={streaming}
              conversation={null}
              conversationId={CONVERSATION}
              onSubmit={onSubmit}
              onStop={jest.fn()}
              onNewConversation={jest.fn()}
            />
          </ToastProvider>
        </ThemeContext.Provider>
      </SafeAreaProvider>
    </QueryClientProvider>
  )
}

/** Type into the field carrying `placeholder`. */
const type = async (placeholder: string, text: string): Promise<void> => {
  await fireEvent.changeText(view.getByPlaceholderText(placeholder), text)
}

/**
 * A press WITHOUT act() around it, so two can be put inside one act and land in
 * a single frame — which is the whole subject of the same-frame tests. Pressable
 * exposes its handler as `onClick` on the host view.
 */
const press = (label: string): void => (view.getByLabelText(label).props.onClick as () => void)()

/** What the one-row field currently holds. */
const fieldValue = (): string => view.getByLabelText('Message Wolffish').props.value as string

const dismissed = jest.spyOn(Keyboard, 'dismiss')

afterEach(() => {
  // Two open handles, or the jest worker never exits after the last assertion:
  // the mounted tree (any interval it holds is cleared on unmount) and the query
  // cache (a query that loses its last observer arms a 7-day gc timer).
  cleanup()
  queryClient.clear()
})

beforeEach(() => {
  onSubmit.mockClear()
  dismissed.mockClear()
  useChatRuntime.setState({ draftRestores: {} })
})

describe('handing a message over', () => {
  it('sends once for two presses in the same frame, and empties the field', async () => {
    await mount()
    await type('Message Wolffish', 'hello')
    await act(async () => {
      press('Send')
      press('Send')
    })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith({ kind: 'text', text: 'hello', files: [] })
    expect(fieldValue()).toBe('')
  })

  it('lets the next message go once the field has repainted', async () => {
    await mount()
    await type('Message Wolffish', 'first')
    await act(async () => press('Send'))
    await type('Message Wolffish', 'second')
    await act(async () => press('Send'))
    expect(onSubmit).toHaveBeenCalledTimes(2)
    expect(onSubmit.mock.calls[1]?.[0]).toEqual({ kind: 'text', text: 'second', files: [] })
  })

  /**
   * The keyboard goes with the message. It was holding half the screen for a
   * field that is now empty, and what the user wants that half for is the
   * reply — so it comes down at the hand-over rather than waiting for a tap
   * somewhere neutral.
   */
  it('drops the keyboard when the message leaves', async () => {
    await mount()
    await type('Message Wolffish', 'hello')
    expect(dismissed).not.toHaveBeenCalled()
    await act(async () => press('Send'))
    expect(dismissed).toHaveBeenCalled()
  })

  it('drops it for a mid-turn message too', async () => {
    await mount(true)
    await type(MID_TURN, 'skip the tests folder')
    await act(async () => press('Send'))
    expect(dismissed).toHaveBeenCalled()
  })

  /**
   * Mid-turn is not a different composer. Send is still Send — the screen
   * decides that it goes into the running turn — and one press is still one
   * message; only the placeholder says where it is going.
   */
  it('sends mid-turn under the same button, and still only once per frame', async () => {
    await mount(true)
    await type(MID_TURN, 'use the other file')
    expect(view.queryByLabelText('Queue message')).toBeNull()
    await act(async () => {
      press('Send')
      press('Send')
    })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith({ kind: 'text', text: 'use the other file', files: [] })
  })

  /**
   * A mid-turn message taken back — by the user, or because the turn was
   * stopped before the agent read it — is the draft again. It comes back
   * through the runtime store (chatRuntime.restoreDraft) and joins whatever
   * is being typed rather than replacing it; the store entry is spent.
   */
  it('takes a withdrawn message back into the field, after what is being typed', async () => {
    await mount(true)
    await type(MID_TURN, 'and then')
    await act(async () => {
      useChatRuntime.getState().restoreDraft(CONVERSATION, 'skip the tests folder')
    })
    expect(view.getByLabelText(MID_TURN).props.value).toBe('and then\nskip the tests folder')
    expect(useChatRuntime.getState().draftRestores[CONVERSATION]).toBeUndefined()
  })
})

describe('the keyboard dismiss bar', () => {
  /**
   * The iPhone keyboard has no dismiss control of its own, so the composer
   * docks one above it: the field names its own accessory by id, and the
   * chevron puts the keyboard away — without touching the draft, which is
   * the difference between hiding the keyboard and abandoning the message.
   */
  it('links the field to its accessory, and the chevron drops the keyboard only', async () => {
    await mount()
    const field = view.getByLabelText('Message Wolffish')
    expect(typeof field.props.inputAccessoryViewID).toBe('string')
    expect(field.props.inputAccessoryViewID.length).toBeGreaterThan(0)
    await type('Message Wolffish', 'still writing')
    await act(async () => press('Hide keyboard'))
    expect(dismissed).toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(fieldValue()).toBe('still writing')
  })
})

describe('the expanded editor', () => {
  it('sends its own draft and comes down with it', async () => {
    await mount()
    await act(async () => press('Edit prompt'))
    await type(EXPANDED, 'a much longer prompt')
    await act(async () => press('Send'))

    expect(onSubmit).toHaveBeenCalledWith({
      kind: 'text',
      text: 'a much longer prompt',
      files: []
    })
    // Collapsed with it, and the composer's own field is empty behind it.
    expect(view.queryAllByPlaceholderText(EXPANDED)).toHaveLength(0)
    expect(fieldValue()).toBe('')
  })

  it('says where a mid-turn message goes, and still sends it as Send', async () => {
    await mount(true)
    await act(async () => press('Edit prompt'))
    await type(EXPANDED_MID_TURN, 'actually, the other branch')
    await act(async () => press('Send'))
    expect(onSubmit).toHaveBeenCalledWith({
      kind: 'text',
      text: 'actually, the other branch',
      files: []
    })
  })

  it('commits without sending when Done is used instead', async () => {
    await mount()
    await act(async () => press('Edit prompt'))
    await type(EXPANDED, 'still writing')
    await act(async () => press('Done'))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(view.queryAllByPlaceholderText(EXPANDED)).toHaveLength(0)
    expect(fieldValue()).toBe('still writing')
  })
})

/**
 * Plan mode's chip — the stance's only handle, the way the desktop's composer
 * carries it: it stands in the bottom row whether the stance is on or off, one
 * tap flips it, and it stands in DEMO too, where the tour would otherwise hide
 * a control the user has (the stance is simply kept locally there). The one
 * state that dims it is a paired phone whose desktop is out of reach, where a
 * tap answers with the reason rather than a flip nobody would receive.
 */
describe('the plan-mode chip', () => {
  const runtime = () => require('@/state/chatRuntime') as typeof import('@/state/chatRuntime')
  const ON = 'Plan mode is on: this turn only investigates and writes a plan. Tap to allow changes.'
  const OFF = 'Plan first: read-only turns that write a plan you approve before anything changes.'
  const OFFLINE = 'Connect the desktop to change plan mode.'

  beforeEach(() => {
    runtime().useChatRuntime.setState({ planModes: {} })
    useAppStore.setState({ paired: true })
    mockReachable = true
  })

  it('stands in the row while plan mode is off, and turns it on when tapped', async () => {
    await mount()
    expect(view.getByText('Plan')).toBeTruthy()
    fireEvent.press(view.getByLabelText(OFF))
    await waitFor(() => expect(runtime().planModeFor(null)).toBe(true))
    expect(view.getByLabelText(ON)).toBeTruthy()
  })

  it('turns plan mode off when tapped again', async () => {
    runtime().useChatRuntime.getState().setPlanMode(null, true)
    await mount()
    fireEvent.press(view.getByLabelText(ON))
    await waitFor(() => expect(runtime().planModeFor(null)).toBe(false))
    expect(view.getByLabelText(OFF)).toBeTruthy()
  })

  /**
   * Demo has no desktop, so `useDesktopReachable` is false there — but that
   * must not dim the chip or swallow the tap the way it does on a paired
   * phone in a lift. The stance flips and stays.
   */
  it('stands in demo too, and flips the stance locally', async () => {
    useAppStore.setState({ paired: false })
    mockReachable = false
    await mount()
    expect(view.getByText('Plan')).toBeTruthy()
    fireEvent.press(view.getByLabelText(OFF))
    await waitFor(() => expect(runtime().planModeFor(null)).toBe(true))
    expect(view.queryByText(OFFLINE)).toBeNull()
  })

  it('stays put but refuses the flip while a paired desktop cannot hear it', async () => {
    useAppStore.setState({ paired: true })
    mockReachable = false
    await mount()
    fireEvent.press(view.getByLabelText(OFF))
    expect(await view.findByText(OFFLINE)).toBeTruthy()
    expect(runtime().planModeFor(null)).toBe(false)
  })
})
