import { queryClient } from '@/lib/query/queryClient'

/**
 * Query keys for the conversation store, and the invalidations that go with
 * them.
 *
 * Deliberately its own module rather than part of `hooks.ts`: the writers that
 * need to invalidate — sync, the prompt runner, the demo agent — are not React
 * code and must not pull in the hooks, which import back from sync to fetch a
 * conversation body on first open. That import pair was a require cycle, and a
 * cycle here resolves to `undefined` at module-init time depending on which
 * side Metro loads first. This file imports only the query client, so both
 * sides can depend on it and neither depends on the other.
 *
 * The key roots are mirrored in queryClient's LOCAL_QUERY_KEYS, which keeps
 * these out of the persisted cache — SQLite already holds the data.
 */
export const conversationKeys = {
  list: ['conversations'] as const,
  detail: (id: string) => ['conversation', id] as const
}

/** One conversation changed: its own view and its row in the list. */
export function invalidateConversation(id: string): void {
  void queryClient.invalidateQueries({ queryKey: conversationKeys.detail(id) })
  void queryClient.invalidateQueries({ queryKey: conversationKeys.list })
}

/** The set of conversations changed — added, removed, retitled, reordered. */
export function invalidateConversationList(): void {
  void queryClient.invalidateQueries({ queryKey: conversationKeys.list })
}

/**
 * Re-read one conversation and RESOLVE ONCE THE QUERY HOLDS THE RESULT — the
 * awaitable half of `invalidateConversation`, which only schedules the work.
 *
 * The difference matters exactly once: at the end of a turn, where the live
 * overlay may only be released after the stored transcript is actually in hand
 * (see sync/prompt.ts). Invalidation would return before the read, leaving a
 * window with the message in neither place.
 */
export async function refetchConversation(id: string): Promise<void> {
  await queryClient.refetchQueries({ queryKey: conversationKeys.detail(id) }).catch(() => undefined)
  void queryClient.invalidateQueries({ queryKey: conversationKeys.list })
}

/**
 * Is this message in the copy the chat screen is currently rendering?
 *
 * Read from the query cache rather than SQLite deliberately: the question a
 * caller is really asking is "has the stored row taken over on screen yet",
 * and the screen draws what the query holds. A row that is on disk but not yet
 * read back is not yet visible, and releasing a live overlay against it would
 * leave a gap.
 */
export function conversationHasMessage(id: string, messageId: string): boolean {
  const data = queryClient.getQueryData<{ messages?: Array<{ id?: string }> } | null>(
    conversationKeys.detail(id)
  )
  return (data?.messages ?? []).some((message) => message.id === messageId)
}
