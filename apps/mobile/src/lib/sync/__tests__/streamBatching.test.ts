jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * Inbound stream batching — the phone's half of the slow-streaming fix.
 *
 * A phone catching up on a queue the relay held (a slow link under a long
 * turn, a return from background) receives hundreds of deltas and mirror
 * snapshots in one burst. Painted per event, that replayed the whole backlog
 * on screen — the reply "streaming" a word at a time for minutes after the
 * desktop had finished, every frame re-rendering the live row. Pooled, a
 * burst is a handful of store writes, each carrying everything that arrived
 * since the last: the backlog fast-forwards.
 *
 * The contract under test:
 *   · a burst of deltas lands as ONE live-row write holding all their text
 *   · a burst of mirrors lands as ONE write of the NEWEST snapshot
 *   · a mirror supersedes the pooled deltas before it; deltas after it ride
 *     as its tail — nothing prints twice, nothing is lost
 *   · boundaries flush synchronously: a turn.status never runs ahead of the
 *     stream events that preceded it
 *   · a reconnect drops what the dead socket left pooled
 */

jest.mock('@/lib/i18n', () => ({ __esModule: true, default: { t: (key: string) => key } }))

jest.mock('@/lib/sync/sync', () => ({
  fetchConversationBody: jest.fn(async () => true)
}))

jest.mock('@/lib/conversations/cache', () => ({
  invalidateConversation: jest.fn(),
  invalidateConversationList: jest.fn(),
  refetchConversation: jest.fn(async () => undefined),
  // The boundary scenarios' stored copies "arrive" instantly, so their
  // settles complete and release the overlay instead of leaving retry timers.
  conversationHasMessage: (_id: string, messageId: string) =>
    messageId === 'm_1_batch3' || messageId === 'm_1_abort1'
}))

const mockDb = {
  runAsync: jest.fn(async () => undefined),
  execAsync: jest.fn(async () => undefined),
  getFirstAsync: jest.fn(async () => ({ next: 0 })),
  getAllAsync: jest.fn(async () => []),
  withExclusiveTransactionAsync: jest.fn(async (fn: (tx: unknown) => Promise<void>) => {
    await fn(mockDb)
  })
}
jest.mock('@/lib/db/database', () => ({ getDb: () => Promise.resolve(mockDb) }))

type EventHandler = (payload: unknown) => void
const mockHandlers = new Map<string, EventHandler>()
const mockRpc = jest.fn()

jest.mock('@/lib/tunnel/client', () => ({
  tunnelClient: {
    get active() {
      return {
        rpc: mockRpc,
        onEvent: (topic: string, handler: EventHandler) => mockHandlers.set(topic, handler)
      }
    },
    connected: true
  }
}))

import { abortTurn, attachTurnStream } from '@/lib/sync/prompt'
import { useChatRuntime } from '@/state/chatRuntime'

const CONVERSATION = 'conv-batch'

function emit(topic: string, payload: unknown): void {
  mockHandlers.get(topic)?.(payload)
}

/** Wait out the pooling window, generously. */
async function window(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100))
}

function liveMessage(): { content?: string } | undefined {
  return useChatRuntime.getState().streams[CONVERSATION]?.message
}

let unsubscribe: (() => void) | null = null
let writes = 0

beforeEach(() => {
  useChatRuntime.getState().reset()
  mockRpc.mockResolvedValue({ runs: [] })
  attachTurnStream()
  writes = 0
  unsubscribe = useChatRuntime.subscribe(() => {
    writes += 1
  })
})

afterEach(() => {
  unsubscribe?.()
})

it('a burst of deltas is one write carrying all their text', async () => {
  for (let i = 0; i < 40; i += 1) {
    emit('message.delta', { conversationId: CONVERSATION, text: `word${i} ` })
  }
  expect(writes).toBe(0) // pooled, not painted
  await window()
  expect(writes).toBe(1)
  expect(liveMessage()?.content).toBe(Array.from({ length: 40 }, (_, i) => `word${i} `).join(''))
})

it('a burst of mirrors is one write of the newest snapshot', async () => {
  for (let i = 1; i <= 20; i += 1) {
    emit('message.appended', {
      conversationId: CONVERSATION,
      message: {
        id: 'm_1_batch1',
        role: 'assistant',
        content: `answer so far ${i}`,
        timestamp: i
      }
    })
  }
  expect(writes).toBe(0)
  await window()
  expect(writes).toBe(1)
  expect(liveMessage()?.content).toBe('answer so far 20')
})

it('a mirror supersedes the deltas before it; later deltas ride its tail', async () => {
  emit('message.delta', { conversationId: CONVERSATION, text: 'already inside the mirror' })
  emit('message.appended', {
    conversationId: CONVERSATION,
    message: { id: 'm_1_batch2', role: 'assistant', content: 'Hello there', timestamp: 1 }
  })
  emit('message.delta', { conversationId: CONVERSATION, text: ', friend' })
  await window()
  expect(liveMessage()?.content).toBe('Hello there, friend')
})

it('a turn boundary flushes the pool before it settles the turn', async () => {
  // The final mirror and the terminal status can arrive in the same burst; the
  // settle must judge the mirror's content, not run ahead of it and judge a
  // pooled-away live row.
  emit('message.appended', {
    conversationId: CONVERSATION,
    message: { id: 'm_1_batch3', role: 'assistant', content: 'the whole answer', timestamp: 1 }
  })
  emit('turn.status', { conversationId: CONVERSATION, state: 'done' })
  // Synchronous: the boundary itself applied the mirror, no window needed.
  expect(liveMessage()?.content).toBe('the whole answer')
  const stream = useChatRuntime.getState().streams[CONVERSATION]
  expect(stream?.status).toBe('complete')
  expect(stream?.ended).toBe('desktop')
  // The settle releases the overlay against the stored copy, and the pooled
  // flush must not fire afterwards and resurrect it as a running turn.
  await window()
  expect(useChatRuntime.getState().streams[CONVERSATION]).toBeUndefined()
})

it('Stop flushes the pool before marking the turn complete', async () => {
  emit('turn.status', { conversationId: CONVERSATION, state: 'started' })
  emit('message.appended', {
    conversationId: CONVERSATION,
    message: { id: 'm_1_abort1', role: 'assistant', content: 'partial answer', timestamp: 1 }
  })
  await abortTurn(CONVERSATION)
  // Without the flush-first ordering, the pooled mirror lands AFTER the
  // complete mark and puts the row back to 'streaming' — the composer's Stop
  // button flipping back for the length of the desktop round trip.
  const stream = useChatRuntime.getState().streams[CONVERSATION]
  expect(stream?.status).toBe('complete')
  expect(stream?.message.content).toBe('partial answer')
  await window()
  expect(useChatRuntime.getState().streams[CONVERSATION]?.status ?? 'complete').toBe('complete')
})

it('a reconnect drops what the dead socket left pooled', async () => {
  emit('message.appended', {
    conversationId: CONVERSATION,
    message: { id: 'm_1_batch4', role: 'assistant', content: 'from before the drop', timestamp: 1 }
  })
  attachTurnStream() // what a reconnect does
  await window()
  expect(useChatRuntime.getState().streams[CONVERSATION]).toBeUndefined()
})
