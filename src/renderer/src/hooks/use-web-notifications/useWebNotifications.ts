import { webTransport } from '@lib/web-bridge/boot'
import type { WebNotificationAction, WebNotificationRecord } from '@preload/index'
import { useSyncExternalStore } from 'react'

/**
 * The notification log, as every surface reads it — the bell, its sheet,
 * the notifications page, the counts on the menu disc and on the
 * conversation rows. One store, so the numbers can never disagree with the
 * list beside them. Main owns the log and broadcasts it whole after every
 * change, to the desktop window and every browser alike, so a notification
 * read in one is read in all.
 */

let items: WebNotificationRecord[] = []
let started = false
const listeners = new Set<() => void>()

function set(next: WebNotificationRecord[]): void {
  items = next
  for (const listener of listeners) listener()
}

function refresh(): void {
  void window.api.web
    .notifications()
    .then(set)
    .catch(() => undefined)
}

function start(): void {
  if (started) return
  started = true
  window.api.web.onNotifications(set)
  refresh()
  // Web: broadcasts sent while the socket was down are gone; read again.
  // The desktop window has no socket to lose (webTransport() is null).
  webTransport()?.onConnection((state) => {
    if (state === 'open') refresh()
  })
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useWebNotifications(): WebNotificationRecord[] {
  return useSyncExternalStore(subscribe, () => items)
}

export function updateWebNotifications(action: WebNotificationAction): void {
  void window.api.web
    .updateNotifications(action)
    .then(set)
    .catch(() => undefined)
}

/** Everything unread — the menu disc and the Notifications row. */
export function unreadTotal(list: readonly WebNotificationRecord[]): number {
  let total = 0
  for (const record of list) if (!record.read) total++
  return total
}

/** One conversation's unread — its bell and its row. */
export function unreadFor(list: readonly WebNotificationRecord[], conversationId: string): number {
  let total = 0
  for (const record of list) if (!record.read && record.conversationId === conversationId) total++
  return total
}

/** What a conversation's sheet lists: its notifications, minus the archived. */
export function unarchivedFor(
  list: readonly WebNotificationRecord[],
  conversationId: string
): WebNotificationRecord[] {
  return list.filter((record) => record.conversationId === conversationId && !record.archived)
}
