/**
 * Conversations with EVIDENCE of a change the sync machinery may not have
 * seen — independent of the updated_at bookkeeping, which is exactly what
 * makes it worth keeping: every staleness check compares two timestamps this
 * phone synced, and a phone that slept through the pushes has both of them
 * old. A notification is the one signal that arrives OUTSIDE the tunnel
 * (APNs/FCM reach a phone whose socket is long dead), so it knows better
 * than the timestamps do.
 *
 * A mark means "fetch this conversation's body at the next opportunity, no
 * matter what the timestamps say". It is cleared by the fetch that honours
 * it, and only on success — a failed fetch keeps the debt.
 *
 * Deliberately a leaf module with no imports: the writers live in
 * notifications (which sync imports for badge clearing) and the reader in
 * sync itself, so anything imported here would be one step from a require
 * cycle. In-memory only: the marks' sources — a tapped notification, one
 * arriving in the foreground — re-fire on every launch that needs them.
 */

const dirty = new Set<string>()

/** Note evidence that this conversation changed behind the sync's back. */
export function markConversationDirty(conversationId: string): void {
  if (conversationId) dirty.add(conversationId)
}

/** Whether a fetch is owed regardless of the timestamp comparison. */
export function isConversationDirty(conversationId: string): boolean {
  return dirty.has(conversationId)
}

/** The debt is paid — called by the body fetch that succeeded. */
export function clearConversationDirty(conversationId: string): void {
  dirty.delete(conversationId)
}
