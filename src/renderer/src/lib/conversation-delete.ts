import type { ConversationMeta } from '@preload/index'
import { useSyncExternalStore } from 'react'

/**
 * Tombstones for conversations whose delete is in flight, or whose index row
 * has not yet caught up with the vanished file.
 *
 * `conversation:delete` is a round trip: a millisecond over IPC, but over the
 * Web UI socket it is the network, and from a phone that is long enough to
 * read as "nothing happened" — or, when the socket drops under the call, to
 * leave the confirm dialog stuck. So every list surface drops the row the
 * moment the user confirms and runs the call behind it.
 *
 * The tombstone outlives the call on purpose. The file is gone when the call
 * returns, but the cortex row lingers until the watcher's removeFile (~500ms),
 * and any conversation:changed push in that window — an automation's write, a
 * channel turn — re-fetches a list that still carries the row and would flash
 * it back. A tombstone retires on the first fetched list that no longer
 * carries its id (the index has caught up), or when the delete fails.
 */
let pending: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()

function setPending(next: Set<string>): void {
  pending = next
  for (const listener of listeners) listener()
}

function retire(id: string): void {
  if (!pending.has(id)) return
  const next = new Set(pending)
  next.delete(id)
  setPending(next)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshot(): ReadonlySet<string> {
  return pending
}

export type ConversationDeleteOutcome = 'deleted' | 'busy' | 'failed'

/**
 * Delete a conversation, tombstoning it for the duration. Resolves — never
 * rejects — with what happened: `busy` is main's refusal (a turn still runs in
 * it), `failed` is the call itself not completing (the socket dropped).
 */
export async function requestConversationDelete(id: string): Promise<ConversationDeleteOutcome> {
  setPending(new Set(pending).add(id))
  let result: { ok: boolean }
  try {
    result = await window.api.conversation.delete(id)
  } catch {
    retire(id)
    return 'failed'
  }
  if (result.ok) return 'deleted'
  retire(id)
  return 'busy'
}

/**
 * A freshly fetched list with the tombstoned rows removed. A tombstone whose
 * id the list no longer carries is retired here — this is the only signal that
 * the index has caught up with the deletion.
 */
export function settleConversationDeletes(list: ConversationMeta[]): ConversationMeta[] {
  if (pending.size === 0) return list
  const present = new Set(list.map((c) => c.id))
  for (const id of pending) if (!present.has(id)) retire(id)
  if (pending.size === 0) return list
  return list.filter((c) => !pending.has(c.id))
}

/**
 * The live tombstone set, for the row layer. Lists built from the index alone
 * are already clean after settleConversationDeletes; this is for rows that
 * merge this session's run statuses, where a conversation that ran this
 * session would otherwise be synthesized back as a ghost until main confirms.
 */
export function usePendingConversationDeletes(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, snapshot)
}
