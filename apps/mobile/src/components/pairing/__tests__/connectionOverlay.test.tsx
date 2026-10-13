/**
 * One interruption per episode.
 *
 * The reconnect card and the sync card used to be separate overlays, so a
 * single drop mid-use interrupted twice: the first vanished the instant the
 * link formed and the second blinked in over the same spot a beat later.
 * What is pinned here is the merged contract:
 *
 * - a blip that resolves quickly still shows nothing at all (the thresholds
 *   both originals had are kept, each trigger judged against its own clock);
 * - an episode that does surface walks reconnect → sync on ONE card, with the
 *   handoff gap between "connected" and the reconcile's first report bridged
 *   rather than hidden through;
 * - one dismissal covers the whole episode, catch-up included — whoever chose
 *   "continue offline" must not be interrupted again by the sync that follows
 *   the reconnect they were not waiting on.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))

// The card itself has its own test; here it is reduced to the props the
// overlay drives, so every assertion reads as the contract above. Host
// component names as raw strings and `jest.requireActual`, deliberately: a
// plain `require` of react or react-native inside this hoisted factory is
// rewritten by the css-interop babel plugin into a module-scope variable the
// factory is not allowed to reach.
jest.mock('@/components/common/BlockingProgress', () => {
  const React = jest.requireActual('react')
  return {
    BlockingProgress: (props: {
      title: string
      detail?: string
      ratio: number
      escape?: { label: string; onPress: () => void }
    }) =>
      React.createElement(
        'View',
        null,
        React.createElement('Text', { testID: 'overlay-title' }, props.title),
        props.detail
          ? React.createElement('Text', { testID: 'overlay-detail' }, props.detail)
          : null,
        React.createElement('Text', { testID: 'overlay-ratio' }, String(props.ratio)),
        props.escape
          ? React.createElement(
              'Text',
              { testID: 'overlay-escape', onPress: props.escape.onPress },
              props.escape.label
            )
          : null
      )
  }
})

// `mock`-prefixed: jest hoists these factories above the file, and only names
// it can prove are mocks may cross that boundary.
type PublishedState = { status: string; reconnects: number; lastError: string | null }
let mockPublish: ((state: PublishedState) => void) | null = null
const mockBaseState: PublishedState = { status: 'connected', reconnects: 0, lastError: null }
jest.mock('@/lib/tunnel/client', () => ({
  tunnelClient: {
    get state() {
      return mockBaseState
    },
    subscribe: (listener: (state: PublishedState) => void) => {
      mockPublish = listener
      return () => undefined
    }
  }
}))

// Initializes the real i18n instance the overlay's useTranslation reads. The
// live app gets this from the tunnel client's own import; here that module is
// a mock, so the side effect must be asked for by name.
import '@/lib/i18n'

import { ConnectionOverlay } from '@/components/pairing/ConnectionOverlay'
import { beginSync } from '@/lib/sync/activity'
import { useAppStore } from '@/state/appStore'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native'

/** The activity module is real and module-scoped; every begun sync must end,
 *  or its depth leaks into the next test. */
let openSyncs: Array<{ end: () => void }> = []

function startSync(): ReturnType<typeof beginSync> {
  const progress = beginSync()
  openSyncs.push(progress)
  return progress
}

function publish(over: Partial<PublishedState>): void {
  mockPublish?.({ ...mockBaseState, ...over })
}

async function mount(): Promise<void> {
  useAppStore.setState({ paired: true })
  await render(<ConnectionOverlay />)
}

const title = (): string | null => {
  const node = screen.queryByTestId('overlay-title')
  return node ? (node.props.children as string) : null
}

const ratio = (): number => Number(screen.getByTestId('overlay-ratio').props.children)

beforeEach(() => {
  jest.useFakeTimers()
  mockPublish = null
  openSyncs = []
})

afterEach(() => {
  for (const progress of openSyncs) progress.end()
  cleanup()
  jest.useRealTimers()
  useAppStore.setState({ paired: false })
})

describe('a blip', () => {
  it('shows nothing when the drop and its catch-up both resolve quickly', async () => {
    await mount()

    await act(async () => publish({ status: 'reconnecting' }))
    await act(async () => jest.advanceTimersByTime(900))
    expect(title()).toBeNull()

    // Reconnected under the outage threshold; the catch-up lands under its
    // own. The ordinary case stays exactly as silent as it always was.
    let progress: ReturnType<typeof beginSync> | null = null
    await act(async () => {
      publish({ status: 'connected' })
      progress = startSync()
    })
    await act(async () => jest.advanceTimersByTime(400))
    expect(title()).toBeNull()
    await act(async () => progress?.end())
    await act(async () => jest.advanceTimersByTime(2_000))

    expect(title()).toBeNull()
  })
})

describe('an episode worth showing', () => {
  it('walks reconnect then sync on one card, and leaves once', async () => {
    await mount()

    await act(async () => publish({ status: 'reconnecting' }))
    await act(async () => jest.advanceTimersByTime(1_200))
    expect(title()).toBe('Reconnecting')
    // The reconnect half owns the bar's first half only — the catch-up that
    // follows every reconnect owns the rest.
    expect(ratio()).toBeLessThanOrEqual(0.5)

    // The link forms and the catch-up starts: the same card swaps its words,
    // with no hide and no second appearance threshold.
    let progress: ReturnType<typeof beginSync> | null = null
    await act(async () => {
      publish({ status: 'connected' })
      progress = startSync()
    })
    expect(title()).toBe('Syncing')
    expect(ratio()).toBeGreaterThanOrEqual(0.5)

    await act(async () => progress?.step({ settings: true, conversations: false }))
    expect(screen.getByTestId('overlay-detail').props.children).toBe('Conversations')

    await act(async () => progress?.end())
    // Held through the visibility floor, then gone for good.
    await act(async () => jest.advanceTimersByTime(1_500))
    expect(title()).toBeNull()
  })

  it('bridges the gap between connected and the first sync report', async () => {
    await mount()

    await act(async () => publish({ status: 'reconnecting' }))
    await act(async () => jest.advanceTimersByTime(1_200))
    expect(title()).toBe('Reconnecting')

    // Connected, but the reconcile has not reported itself yet — the beat
    // that used to hide one card and summon the other.
    await act(async () => publish({ status: 'connected' }))
    await act(async () => jest.advanceTimersByTime(200))
    expect(title()).toBe('Syncing')
    // Waiting at the sync half's start, not pretending to be done.
    expect(ratio()).toBe(0.5)

    let progress: ReturnType<typeof beginSync> | null = null
    await act(async () => {
      progress = startSync()
    })
    expect(title()).toBe('Syncing')
    await act(async () => progress?.end())
    await act(async () => jest.advanceTimersByTime(1_500))
    expect(title()).toBeNull()
  })

  it('honours one dismissal for the whole episode, catch-up included', async () => {
    await mount()

    await act(async () => publish({ status: 'reconnecting' }))
    await act(async () => jest.advanceTimersByTime(1_200))
    // The way out is held for a full minute; nothing is offered before it.
    await act(async () => jest.advanceTimersByTime(59_000))
    expect(screen.queryByTestId('overlay-escape')).toBeNull()
    await act(async () => jest.advanceTimersByTime(1_000))
    expect(screen.getByTestId('overlay-escape')).toBeTruthy()

    await act(async () => fireEvent.press(screen.getByTestId('overlay-escape')))
    expect(title()).toBeNull()

    // The reconnect lands and its catch-up runs long — and stays out of the
    // way, because "continue offline" was about this whole episode.
    let progress: ReturnType<typeof beginSync> | null = null
    await act(async () => {
      publish({ status: 'connected' })
      progress = startSync()
    })
    await act(async () => jest.advanceTimersByTime(3_000))
    expect(title()).toBeNull()

    await act(async () => progress?.end())
    await act(async () => jest.advanceTimersByTime(1_500))

    // The NEXT episode earns its own card — a dismissal is not forever.
    await act(async () => publish({ status: 'reconnecting' }))
    await act(async () => jest.advanceTimersByTime(1_200))
    expect(title()).toBe('Reconnecting')
  })
})
