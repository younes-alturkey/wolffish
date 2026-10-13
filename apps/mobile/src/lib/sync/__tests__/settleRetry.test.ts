jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * The settle's safety net.
 *
 * A turn's `done` and the desktop's disk write are announced by independent
 * paths with no ordering, so the fetch after `done` can pull the PRE-save
 * transcript. The signal that follows the save is supposed to fetch again —
 * but it rides the tunnel, and a tunnel that blinks at exactly that moment
 * used to leave the phone stuck: live overlay up forever, stored transcript
 * one turn short, healed only by leaving and reopening the conversation.
 * That is the reported 2026-08-25 regression ("conversation stays stale even
 * though its turn completed"), and these tests pin its fix: a few bounded
 * retries that keep fetching until the stored copy holds the turn's message,
 * then stop for good.
 */

const mockFetchBody = jest.fn(async (_id: string) => true)
jest.mock('@/lib/sync/sync', () => ({
  fetchConversationBody: (id: string) => mockFetchBody(id),
  setConversationSettleHook: jest.fn()
}))

let mockHasMessage = false
jest.mock('@/lib/conversations/cache', () => ({
  invalidateConversation: jest.fn(),
  invalidateConversationList: jest.fn(),
  refetchConversation: jest.fn(async () => undefined),
  conversationHasMessage: () => mockHasMessage
}))

jest.mock('@/lib/i18n', () => ({ __esModule: true, default: { t: (key: string) => key } }))
jest.mock('@/lib/db/database', () => ({ getDb: () => Promise.resolve({}) }))
jest.mock('@/lib/sync/cards', () => ({
  attachCardStream: jest.fn(),
  seedTurnCards: jest.fn()
}))

const mockRpc = jest.fn()
const mockHandlers = new Map<string, (payload: unknown) => void>()
let mockConnected = true
jest.mock('@/lib/tunnel/client', () => ({
  tunnelClient: {
    get active() {
      return {
        rpc: mockRpc,
        onEvent: (topic: string, handler: (payload: unknown) => void) => {
          mockHandlers.set(topic, handler)
        }
      }
    },
    get connected() {
      return mockConnected
    }
  }
}))

import { attachTurnStream } from '@/lib/sync/prompt'
import { Event } from '@/lib/tunnel/protocol'
import { useChatRuntime } from '@/state/chatRuntime'
import { useRunStatus } from '@/state/runStatus'

const CONV = 'conv-retry'

beforeEach(() => {
  jest.useFakeTimers()
  mockFetchBody.mockClear()
  mockRpc.mockReset()
  mockHandlers.clear()
  mockHasMessage = false
  mockConnected = true
  useChatRuntime.getState().reset()
  useRunStatus.getState().reset()
})

afterEach(() => {
  jest.useRealTimers()
})

/** Run one turn to its `done` push: started → a full mirror snapshot → done. */
async function finishTurn(): Promise<void> {
  attachTurnStream()
  mockHandlers.get(Event.turnStatus)?.({ conversationId: CONV, state: 'started' })
  mockHandlers.get(Event.messageAppended)?.({
    conversationId: CONV,
    message: { id: 'm-live', role: 'assistant', content: 'the answer', timestamp: 1 }
  })
  mockHandlers.get(Event.turnStatus)?.({ conversationId: CONV, state: 'done' })
  await jest.advanceTimersByTimeAsync(0)
}

describe('settle retries', () => {
  it('keeps fetching until the stored copy holds the message, then releases', async () => {
    await finishTurn()
    // The first settle fetched a transcript from BEFORE the save — the
    // stored copy does not hold the live message, so the overlay stays.
    expect(mockFetchBody).toHaveBeenCalledTimes(1)
    expect(useChatRuntime.getState().streams[CONV]).toBeDefined()

    // First retry lands about when the desktop's save does — still early.
    await jest.advanceTimersByTimeAsync(1_500)
    expect(mockFetchBody).toHaveBeenCalledTimes(2)
    expect(useChatRuntime.getState().streams[CONV]).toBeDefined()

    // The save is on disk by the second retry; the fetch finds the message.
    mockHasMessage = true
    await jest.advanceTimersByTimeAsync(3_000)
    expect(mockFetchBody).toHaveBeenCalledTimes(3)
    expect(useChatRuntime.getState().streams[CONV]).toBeUndefined()

    // Released means finished: no timer left to fetch a fourth time.
    await jest.advanceTimersByTimeAsync(60_000)
    expect(mockFetchBody).toHaveBeenCalledTimes(3)
  })

  it('gives up after the bounded attempts and waits for a real signal', async () => {
    await finishTurn()

    await jest.advanceTimersByTimeAsync(60_000)

    // One settle at `done` plus three retries, then quiet — the overlay
    // stays up (whatever streamed is still the best copy anywhere) and the
    // next push or reconnect owns the rest, exactly as before the net.
    expect(mockFetchBody).toHaveBeenCalledTimes(4)
    expect(useChatRuntime.getState().streams[CONV]).toBeDefined()
  })

  it('a real signal supersedes the pending retry instead of doubling it', async () => {
    await finishTurn()
    expect(mockFetchBody).toHaveBeenCalledTimes(1)

    // The post-save nudge arrives before the first retry fires.
    mockHasMessage = true
    mockHandlers.get(Event.messageAppended)?.({ conversationId: CONV })
    await jest.advanceTimersByTimeAsync(0)
    expect(mockFetchBody).toHaveBeenCalledTimes(2)
    expect(useChatRuntime.getState().streams[CONV]).toBeUndefined()

    // The superseded timer must not fire a third fetch.
    await jest.advanceTimersByTimeAsync(60_000)
    expect(mockFetchBody).toHaveBeenCalledTimes(2)
  })

  it('does not retry into a NEW turn in the same conversation', async () => {
    await finishTurn()
    expect(mockFetchBody).toHaveBeenCalledTimes(1)

    // A queued prompt starts the next turn before the retry fires. Fetching
    // now would read a mid-turn body — the vanishing-reply bug.
    mockHandlers.get(Event.turnStatus)?.({ conversationId: CONV, state: 'started' })
    await jest.advanceTimersByTimeAsync(60_000)

    expect(mockFetchBody).toHaveBeenCalledTimes(1)
  })

  it('schedules nothing while disconnected — the reconnect re-settles instead', async () => {
    mockConnected = false
    await finishTurn()
    expect(mockFetchBody).toHaveBeenCalledTimes(1)

    await jest.advanceTimersByTimeAsync(60_000)

    expect(mockFetchBody).toHaveBeenCalledTimes(1)
  })

  it('an id-less streamed turn keeps refetching after its overlay released', async () => {
    // The degraded-mirror shape: an oversize mirror falls back to a bare
    // nudge, so the phone streams deltas but never learns the message id.
    // At `done` the settle has nothing to match, releases the overlay against
    // a body that may predate the save — and the streamed reply vanishes.
    // The bounded net must go on refetching anyway; the save it is waiting
    // for has no other way to reach the screen.
    attachTurnStream()
    mockHandlers.get(Event.turnStatus)?.({ conversationId: CONV, state: 'started' })
    mockHandlers.get(Event.messageDelta)?.({ conversationId: CONV, text: 'streamed without an id' })
    mockHandlers.get(Event.turnStatus)?.({ conversationId: CONV, state: 'done' })
    await jest.advanceTimersByTimeAsync(0)

    // Released immediately — nothing to match — but the debt stays.
    expect(mockFetchBody).toHaveBeenCalledTimes(1)
    expect(useChatRuntime.getState().streams[CONV]).toBeUndefined()

    // Each retry refetches with no overlay to guard it, then chains the next.
    await jest.advanceTimersByTimeAsync(1_500)
    expect(mockFetchBody).toHaveBeenCalledTimes(2)
    await jest.advanceTimersByTimeAsync(3_000)
    expect(mockFetchBody).toHaveBeenCalledTimes(3)
    await jest.advanceTimersByTimeAsync(6_000)
    expect(mockFetchBody).toHaveBeenCalledTimes(4)

    // Bounded: the net runs out rather than polling forever.
    await jest.advanceTimersByTimeAsync(60_000)
    expect(mockFetchBody).toHaveBeenCalledTimes(4)
  })

  it('a blank id-less turn releases without any retry churn', async () => {
    // Aborted before a word streamed: nothing vanished, nothing to recover.
    attachTurnStream()
    mockHandlers.get(Event.turnStatus)?.({ conversationId: CONV, state: 'started' })
    mockHandlers.get(Event.turnStatus)?.({ conversationId: CONV, state: 'canceled' })
    await jest.advanceTimersByTimeAsync(0)
    expect(mockFetchBody).toHaveBeenCalledTimes(1)

    await jest.advanceTimersByTimeAsync(60_000)

    expect(mockFetchBody).toHaveBeenCalledTimes(1)
  })
})
