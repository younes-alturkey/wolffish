import { parseDeeplink, type DeeplinkTarget } from '@/lib/tunnel/protocol'
import type { Href } from 'expo-router'

/**
 * Where a `wolffish://…` deeplink goes in this app, and the ONE place that
 * answers it.
 *
 * Two surfaces ask: a tap on the OS banner (lib/notifications/push.ts) and a
 * tap on a card in the notifications page, which exists to be the banner the
 * user missed. They must land identically, which is only guaranteed while
 * they read the same table — and the table is also the whole security story
 * for this path. Notification payloads are data; only a link naming one of
 * this app's own screens may steer it, and a link this build cannot resolve
 * answers null, which every caller reads as "go nowhere" rather than falling
 * through to the not-found route (which redirects home, which on a paired
 * phone redirects into whatever chat was last open — a tap that appeared to
 * do something arbitrary instead of nothing).
 */

/** The in-app route a target names. `wolffish://chat?id=X` is `/chat?id=X`,
 *  `wolffish://settings/model` is `/settings/model` — the deeplink table and
 *  this app's own routes are the same list, by construction. */
export function hrefFor(target: DeeplinkTarget): Href {
  if (target.route === 'chat' && target.conversationId) {
    return { pathname: '/chat', params: { id: target.conversationId } } as Href
  }
  return `/${target.route}` as Href
}

/** The route a raw link names, or null when it names none this build has. */
export function hrefForDeeplink(value: unknown): Href | null {
  const target = parseDeeplink(value)
  return target ? hrefFor(target) : null
}
