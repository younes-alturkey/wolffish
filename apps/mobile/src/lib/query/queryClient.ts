import AsyncStorage from '@react-native-async-storage/async-storage'
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister'
import { defaultShouldDehydrateQuery, QueryClient, type Query } from '@tanstack/react-query'

/**
 * Server-state layer. The query cache is persisted to the device so remote
 * content survives restarts and refreshes slowly in the background instead of
 * refetching everything up front:
 *
 * - gcTime keeps data eligible for persistence for 7 days.
 * - staleTime means cached data renders instantly and refetches in the
 *   background only after a minute of staleness.
 * - maxAge on the persister drops anything older than 7 days at restore.
 *
 * Conversation queries are backed by SQLite (lib/conversations) and are
 * excluded from AsyncStorage persistence — SQLite is already durable, and
 * mirroring hundreds of conversations into AsyncStorage would defeat the
 * point of the database.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 7 * 24 * 60 * 60 * 1000,
      staleTime: 60 * 1000,
      retry: 2
    }
  }
})

/** Query families whose source of truth is on-device SQLite. */
const LOCAL_QUERY_KEYS = new Set(['conversations', 'conversation', 'data-usage'])

export function shouldPersistQuery(query: Query): boolean {
  if (typeof query.queryKey[0] === 'string' && LOCAL_QUERY_KEYS.has(query.queryKey[0])) {
    return false
  }
  return defaultShouldDehydrateQuery(query)
}

/**
 * AsyncStorage key the dehydrated cache is written under. Exported because a
 * demo refresh deletes it outright (lib/demo/reset) — clearing the in-memory
 * cache alone leaves the last dehydrated copy on disk to be restored at the
 * next launch.
 */
export const QUERY_CACHE_KEY = 'wolffish.query-cache'

export const asyncStoragePersister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: QUERY_CACHE_KEY,
  throttleTime: 3_000
})

export const PERSIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
