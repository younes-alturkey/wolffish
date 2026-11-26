import { webTransport } from '@lib/web-bridge/boot'
import { useSyncExternalStore } from 'react'

/**
 * The conversation ids most recently opened, newest first, as main keeps them
 * for every surface — the desktop window and each Web UI browser read and
 * update one list. One store per renderer, so the sheet (which remounts on
 * every open) paints the section instantly instead of after a round trip.
 */

let ids: string[] = []
let started = false
const listeners = new Set<() => void>()

function set(next: string[]): void {
  ids = next
  for (const listener of listeners) listener()
}

function refresh(): void {
  void window.api.conversation
    .recent()
    .then(set)
    .catch(() => undefined)
}

function start(): void {
  if (started) return
  started = true
  window.api.conversation.onRecentChanged(set)
  refresh()
  // Web: broadcasts sent while the socket was down are gone; read again.
  webTransport()?.onConnection((state) => {
    if (state === 'open') refresh()
  })
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useRecentConversations(): readonly string[] {
  return useSyncExternalStore(subscribe, () => ids)
}

export function recordConversationOpened(id: string): void {
  void window.api.conversation
    .markOpened(id)
    .then(set)
    .catch(() => undefined)
}
