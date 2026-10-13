/**
 * The blocking-wait card on the phone.
 *
 * Three things have to be true of it, and none of them are visible from a
 * typecheck: while the agent is idle the card SAYS SO (a turn that goes quiet
 * with no card is indistinguishable from a hang), the box that ends the wait
 * early sends a real mid-turn message, and once the wait is over the card is
 * a record — no clock, no box, nothing left to press.
 *
 * It also renders in Arabic here, because the strings are the whole card: a
 * missing key shows up as `chat.wait.…` on screen in the language nobody on
 * the team reads by default.
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react-native'
import { ThemeContext } from '@/providers/theme/useTheme'

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

const mockInterject = jest.fn(async (_input: unknown) => ({ status: 'pending' as const }))
jest.mock('@/lib/sync/prompt', () => ({ interject: (input: unknown) => mockInterject(input) }))

import i18n from '@/lib/i18n'
import { WaitCard } from '@/components/chat/WaitCard'
import type { WaitSnapshot } from '@/lib/conversations/types'

const CONVERSATION = '2026-09-17_06-00-00_000-abcdef'
const START = 1_700_000_000_000

function snapshot(over: Partial<WaitSnapshot> = {}): WaitSnapshot {
  return {
    waitId: 'wait_1',
    conversationId: CONVERSATION,
    reason: 'Letting the deploy finish',
    seconds: 600,
    status: 'waiting',
    startedAt: START,
    endsAt: START + 600_000,
    ...over
  }
}

async function draw(snap: WaitSnapshot): Promise<Awaited<ReturnType<typeof render>>> {
  return await render(
    <ThemeContext.Provider
      value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
    >
      <WaitCard snapshot={snap} />
    </ThemeContext.Provider>
  )
}

describe('WaitCard', () => {
  beforeEach(() => {
    mockInterject.mockClear()
    jest.useFakeTimers().setSystemTime(START + 60_000)
  })
  afterEach(() => {
    jest.useRealTimers()
    cleanup()
  })

  it('says why the agent is idle, and until when', async () => {
    const view = await draw(snapshot())
    expect(view.getByText('Letting the deploy finish')).toBeTruthy()
    expect(view.getByText('Waiting')).toBeTruthy()
    // Nine of the ten minutes are left, counted from endsAt — not from a tick
    // the desktop had to push.
    expect(view.getByText('9m left')).toBeTruthy()
    expect(view.getByPlaceholderText('Send a message to continue now')).toBeTruthy()
  })

  it('sends a real mid-turn message from the box, and only once there is one', async () => {
    const view = await draw(snapshot())
    // Nothing typed: no send button at all, rather than a greyed one.
    expect(view.queryByLabelText('Send')).toBeNull()

    const box = view.getByPlaceholderText('Send a message to continue now')
    await fireEvent.changeText(box, 'skip it, move on')
    await fireEvent.press(view.getByLabelText('Send'))
    expect(mockInterject).toHaveBeenCalledTimes(1)
    expect(mockInterject.mock.calls[0]?.[0]).toMatchObject({
      conversationId: CONVERSATION,
      text: 'skip it, move on'
    })
  })

  it('is a record once the wait is over — no clock, no box', async () => {
    const view = await draw(
      snapshot({ status: 'interrupted', endedAt: START + 35_000, interruptedBy: 'skip it' })
    )
    expect(view.getByText('Woken early')).toBeTruthy()
    expect(view.getByText('You sent a message after 35s, so it carried on early.')).toBeTruthy()
    expect(view.queryByPlaceholderText('Send a message to continue now')).toBeNull()
    expect(view.queryByLabelText('Send')).toBeNull()
  })

  it('reports an elapsed wait in the duration that was asked for', async () => {
    const view = await draw(snapshot({ status: 'elapsed', endedAt: START + 600_000 }))
    expect(view.getByText('Waited')).toBeTruthy()
    expect(view.getByText('Waited 10m, then carried on.')).toBeTruthy()
  })

  it('renders in Arabic', async () => {
    await act(async () => {
      await i18n.changeLanguage('ar')
    })
    try {
      const view = await draw(snapshot())
      expect(view.getByText('بالانتظار')).toBeTruthy()
      expect(view.getByPlaceholderText('أرسل رسالة للمتابعة الآن')).toBeTruthy()
      // The duration stays in Latin digits inside the Arabic sentence — the
      // card formats it itself rather than leaving it to a locale.
      expect(view.getByText('ينتظر 10m قبل المتابعة. أرسل رسالة للمتابعة الآن.')).toBeTruthy()
    } finally {
      await act(async () => {
        await i18n.changeLanguage('en')
      })
    }
  })
})
