import { conversationKeys, invalidateConversation } from '@/lib/conversations/cache'
import { queryClient } from '@/lib/query/queryClient'
import { isConversationDirty } from '@/lib/sync/dirty'
import { fetchConversationBody, isBodyStale, refreshSync } from '@/lib/sync/sync'
import { tunnelClient } from '@/lib/tunnel/client'
import { useAppStore } from '@/state/appStore'
import { forgetConversationNotifications } from '@/lib/notifications/push'
import { useRunStatus } from '@/state/runStatus'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { useEffect } from 'react'
import { deleteConversation, getConversation, listConversations } from '@/lib/conversations/repo'
import type { ConversationFile, ConversationMeta } from '@/lib/conversations/types'

/**
 * Read layer over the SQLite store. These queries are local — instant, never
 * stale in the network sense — so they refetch on invalidation only, and the
 * AsyncStorage query persister skips them (see queryClient LOCAL_QUERY_KEYS):
 * persisting them would duplicate what SQLite already holds.
 *
 * Keys and invalidations live in `./cache` so non-React writers can invalidate
 * without importing this module — see the note there.
 */

export function useConversationList(): UseQueryResult<ConversationMeta[]> {
  return useQuery({
    queryKey: conversationKeys.list,
    queryFn: listConversations,
    staleTime: Infinity
  })
}

/**
 * How long a conversation with nothing to show waits for the tunnel before
 * answering with what little it has.
 *
 * Sized against the connecting overlay, which appears at 1.2s and offers its
 * escape at 6.2s: the wait is over before the user is ever given the choice to
 * carry on without a desktop, so it can never be the thing holding them.
 */
const CONNECT_GRACE_MS = 6_000

/** Resolve when the tunnel is up, or when the grace runs out — whichever
 *  comes first. Never rejects; the caller carries on either way. */
function whenConnected(withinMs: number): Promise<void> {
  if (tunnelClient.connected) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    let unsubscribe: (() => void) | null = null
    const settle = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe?.()
      resolve()
    }
    const timer = setTimeout(settle, withinMs)
    // subscribe() replays the current state to a new listener synchronously,
    // so this can settle before it has returned anything to unsubscribe with.
    unsubscribe = tunnelClient.subscribe((state) => {
      if (state.status === 'connected') settle()
    })
    if (settled) unsubscribe()
  })
}

export function useConversation(id: string | null): UseQueryResult<ConversationFile | null> {
  const query = useQuery({
    queryKey: conversationKeys.detail(id ?? 'none'),
    queryFn: async () => {
      if (!id) return null
      let local = await getConversation(id)

      // Paired, and there is nothing here to draw: no copy at all, or metadata
      // whose body was never downloaded. Both answers live on the desktop, and
      // on a cold start — a notification tap especially — the handshake is
      // still a second or two away. Answering "empty" now is not merely early,
      // it is WRONG on screen: the chat screen would drop its skeleton and
      // paint the new-chat hero over a conversation that has a transcript, and
      // only correct itself once the link came up. So wait for the link. Demo
      // mode never waits — nothing is coming — and neither does a conversation
      // already cached, which is the ordinary case.
      if (
        !tunnelClient.connected &&
        useAppStore.getState().paired &&
        (!local || local.messages.length === 0)
      ) {
        await whenConnected(CONNECT_GRACE_MS)
        if (tunnelClient.connected) local = await getConversation(id)
      }

      // Not in this phone's index yet — reachable from a notification, a
      // deep link, or simply a conversation created since the last catch-up.
      // Pull the index and look again rather than rendering nothing forever.
      if (!local && tunnelClient.connected) {
        await refreshSync().catch(() => undefined)
        local = await getConversation(id)
      }
      if (!local) return null

      // Paired mode syncs metadata only, so a conversation never opened has
      // no messages here yet. Emptiness is not the whole test though: a body
      // pulled last week is just as wrong once the desktop has added to it,
      // and the phone learns that from updated_at — plus one signal that
      // outranks the timestamps entirely: a notification NAMED this
      // conversation. That arrives outside the tunnel, so it knows about
      // changes the phone's own metadata may not yet, and a tap on it must
      // land on the fresh transcript, not on whatever the timestamps
      // believed. The flag clears when a fetch succeeds, so it costs one
      // download, once.
      if (tunnelClient.connected) {
        const needsBody =
          local.messages.length === 0 || isConversationDirty(id) || (await isBodyStale(id))
        if (needsBody) {
          const fetched = await fetchConversationBody(id).catch(() => false)
          // Only re-read on success. A refused or malformed answer leaves the
          // copy in hand untouched, which is better than the empty screen a
          // blind re-read would produce.
          if (fetched) return getConversation(id)
        }
      }
      return local
    },
    enabled: id !== null,
    staleTime: Infinity
  })

  // The queryFn can only download the body while the tunnel is up, and on a
  // cold start the user reaches a conversation before the handshake finishes.
  // Without this, that first answer — the empty local copy — is pinned by
  // staleTime for the whole session. So every arrival of the connection asks
  // again; the queryFn re-checks against SQLite and fetches only if the copy
  // is actually missing or stale, so the repeat costs one local read.
  useEffect(() => {
    if (id === null) return
    let lastStatus: string | null = null
    return tunnelClient.subscribe((state) => {
      if (state.status === 'connected' && lastStatus !== 'connected') {
        void queryClient.invalidateQueries({ queryKey: conversationKeys.detail(id) })
      }
      lastStatus = state.status
    })
  }, [id])

  return query
}

export async function removeConversation(id: string): Promise<void> {
  await deleteConversation(id)
  invalidateConversation(id)
  // Nothing left to tint. The entry would age out on its own, but a run status
  // outliving its conversation is the kind of thing that only stays harmless
  // until something else starts reading the map.
  useRunStatus.getState().dropRun(id)
  // Same rule for its badge: an unread count with no row to mark would sit in
  // the totals forever. The full clear — bucket AND tray — or the next
  // reconciliation would find its notifications with no row to charge.
  forgetConversationNotifications(id)
}
