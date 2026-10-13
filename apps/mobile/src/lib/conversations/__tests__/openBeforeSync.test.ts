jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

let mockConnected = false
const mockListeners: ((state: { status: string }) => void)[] = []
jest.mock('@/lib/tunnel/client', () => ({
  tunnelClient: {
    get connected() {
      return mockConnected
    },
    subscribe: (listener: (state: { status: string }) => void) => {
      mockListeners.push(listener)
      return () => undefined
    }
  }
}))

const mockGetConversation = jest.fn()
jest.mock('@/lib/conversations/repo', () => ({
  getConversation: (id: string) => mockGetConversation(id),
  listConversations: jest.fn(),
  deleteConversation: jest.fn()
}))

const mockFetchBody = jest.fn()
jest.mock('@/lib/sync/sync', () => ({
  fetchConversationBody: (id: string) => mockFetchBody(id),
  isBodyStale: async () => false,
  refreshSync: jest.fn()
}))

jest.mock('@/lib/query/queryClient', () => ({
  queryClient: { invalidateQueries: jest.fn() }
}))

import { useConversation } from '@/lib/conversations/hooks'
import type { ConversationFile } from '@/lib/conversations/types'
import { useAppStore } from '@/state/appStore'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react-native'
import { createElement, type ReactNode } from 'react'

/**
 * Opening a conversation before the phone has caught up — which is every
 * notification tap, since the tap lands the app on the conversation while the
 * handshake is still forming.
 *
 * Paired mode syncs metadata only, so the copy on the phone is routinely a
 * title with no messages. Answering with THAT while the tunnel is still coming
 * up is not merely early: the chat screen drops its skeleton and paints the
 * new-chat hero over a conversation that has a transcript. So the read waits
 * for the link — and only ever when a link is what is missing.
 */
const METADATA_ONLY: ConversationFile = {
  id: 'conv-a',
  title: 'Yesterday',
  model: null,
  messages: [],
  createdAt: 1,
  updatedAt: 2
}

const WITH_BODY: ConversationFile = {
  ...METADATA_ONLY,
  messages: [{ id: 'm1', role: 'assistant', content: 'here it is', timestamp: 3 }]
}

// One client per test, and no garbage-collection window: a cache kept warm
// past the test holds a timer, which keeps the whole jest run from exiting.
let client: QueryClient

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  return createElement(QueryClientProvider, { client }, children)
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  mockConnected = false
  mockListeners.length = 0
  mockGetConversation.mockReset()
  mockFetchBody.mockReset()
})

afterEach(() => {
  client.clear()
})

it('holds the read until the tunnel is up, then answers with the body', async () => {
  useAppStore.setState({ paired: true })
  mockGetConversation.mockResolvedValue(METADATA_ONLY)

  const { result } = await renderHook(() => useConversation('conv-a'), { wrapper })

  // Nothing settles while the phone cannot ask — no empty answer to draw.
  await waitFor(() => expect(mockGetConversation).toHaveBeenCalled())
  expect(result.current.data).toBeUndefined()

  mockGetConversation.mockResolvedValue(WITH_BODY)
  mockFetchBody.mockResolvedValue(true)
  mockConnected = true
  mockListeners.forEach((listener) => listener({ status: 'connected' }))

  await waitFor(() => expect(result.current.data).toEqual(WITH_BODY))
})

it('answers straight away when there is nothing to wait for', async () => {
  // Demo mode: no desktop is coming, so a conversation with no messages is
  // the whole truth and waiting would stall every open by the full grace.
  useAppStore.setState({ paired: false })
  mockGetConversation.mockResolvedValue(METADATA_ONLY)

  const { result } = await renderHook(() => useConversation('conv-a'), { wrapper })

  await waitFor(() => expect(result.current.data).toEqual(METADATA_ONLY))
  expect(mockFetchBody).not.toHaveBeenCalled()
})

it('answers with what it has when the tunnel never comes', async () => {
  jest.useFakeTimers()
  try {
    useAppStore.setState({ paired: true })
    mockGetConversation.mockResolvedValue(METADATA_ONLY)

    const { result } = await renderHook(() => useConversation('conv-a'), { wrapper })

    // The wait is bounded: a desktop that is asleep must not leave the screen
    // under a skeleton forever.
    await waitFor(() => expect(result.current.data).toEqual(METADATA_ONLY), { timeout: 30_000 })
  } finally {
    jest.useRealTimers()
  }
})
