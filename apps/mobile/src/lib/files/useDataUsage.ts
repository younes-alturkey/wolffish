import { countConversations } from '@/lib/conversations/repo'
import { getCacheUsage, type CacheUsage } from '@/lib/files/fileCache'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'

/** What this device is holding: downloaded media, and conversations indexed. */
export type DataUsage = {
  cache: CacheUsage
  conversations: number
}

/**
 * Shared because two screens print these figures — the Data panel's device
 * card and the settings list's Data row — and they must agree. One key means
 * one fetcher and one invalidation: releasing the cache from the panel
 * updates the row behind it too.
 */
export const dataUsageKey = ['data-usage'] as const

/**
 * Both figures are SQLite aggregates (a SUM/COUNT over `cached_files`, a COUNT
 * over conversations), so this is cheap enough to mount on a list row.
 */
export function useDataUsage(): UseQueryResult<DataUsage> {
  return useQuery({
    queryKey: dataUsageKey,
    queryFn: async () => ({
      cache: await getCacheUsage(),
      conversations: await countConversations()
    }),
    staleTime: 10_000
  })
}
