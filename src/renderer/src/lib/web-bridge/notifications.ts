/**
 * Browser notifications for the Web UI.
 *
 * Three layers, each covering a case the one below cannot:
 *   - a toast inside the app for every `web:notify` the server sends, so an
 *     open tab always shows what the agent said;
 *   - a local notification (through the service worker where the platform
 *     insists on it — Android — or the Notification constructor) when the
 *     user is away from the page and no push will cover it, and when a turn
 *     blocks on an approval or a question while they are away;
 *   - a Web Push subscription, registered with the server, which is what
 *     lands with the tab closed and the phone in a pocket.
 *
 * Plus an unread count of what arrived while the user was away — a
 * notification, a turn blocked on them, a turn that ended — drawn on the app
 * icon, the tab title and the favicon (badge.ts), and cleared the moment
 * they are back. With a service worker the worker owns the count, so a push
 * landing with every tab closed counts too; without one (plain HTTP) the
 * page keeps it.
 *
 * "Away" is the page hidden OR the window not focused: a desktop browser
 * sitting visible behind another app shows a toast nobody is looking at.
 * The page tells the server too, which pushes a blocked turn's approval or
 * question to this browser only while it is away.
 *
 * Notifications need a secure context: on plain http://<ip> the browser
 * offers none of those APIs, and `state().supported` says so for the panel.
 * The title and favicon count work everywhere.
 */
import i18n from '@lib/i18n'
import { renderUnreadBadge } from '@lib/web-bridge/badge'
import type { WebTransport } from '@lib/web-bridge/transport'

export type NotificationState = {
  supported: boolean
  secure: boolean
  permission: NotificationPermission | 'unsupported'
  subscribed: boolean
  pushSupported: boolean
}

type NotifyPayload = {
  id: string
  title: string
  body: string
  phase: string
  urgency: string
  url: string | null
  conversationId: string | null
  at: number
}

type ToastSink = (input: {
  message: string
  tone?: 'info' | 'success' | 'warning' | 'error'
  sticky?: boolean
  onClick?: () => void
}) => void

let registration: ServiceWorkerRegistration | null = null
let subscribed = false
let vapidPublicKey: string | null = null
/** The server pushes a blocked turn to an away browser itself (older builds do not). */
let serverPushesNeedsUser = false
let toastSink: ToastSink | null = null
const stateListeners = new Set<(state: NotificationState) => void>()

/** The page's own count, used only when no service worker can own it. */
const localUnread = new Set<string>()
/** Constructor notifications, closed when the user is back — the worker closes its own. */
const localShown = new Set<Notification>()
/** Notification ids already toasted: the worker relays a push to a focused page that may have had the frame too. */
const toasted = new Set<string>()
let lastAttended: boolean | null = null

export function registerToastSink(sink: ToastSink | null): void {
  toastSink = sink
}

export function notificationState(): NotificationState {
  const secure = window.isSecureContext
  const supported = secure && 'Notification' in window
  return {
    supported,
    secure,
    permission: supported ? Notification.permission : 'unsupported',
    subscribed,
    pushSupported: supported && 'serviceWorker' in navigator && 'PushManager' in window
  }
}

export function onNotificationState(listener: (state: NotificationState) => void): () => void {
  stateListeners.add(listener)
  return () => stateListeners.delete(listener)
}

function announce(): void {
  const state = notificationState()
  for (const listener of stateListeners) listener(state)
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(normalized)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/**
 * A tap on a notification — the toast or the system banner — is the user
 * answering it, so it is read in the log (as on the phone). Ids the log does
 * not hold (a blocked turn's `needs-…`) change nothing.
 */
function markNotificationRead(id: unknown): void {
  if (typeof id !== 'string' || !id || id.startsWith('needs-')) return
  void window.api.web.updateNotifications({ kind: 'read', id }).catch(() => undefined)
}

/**
 * A banner tapped with no Wolffish tab open: the worker opened this page with
 * `read=<id>` on the URL. Answer it and take the marker off the address bar.
 */
function consumeReadMarker(): void {
  const params = new URLSearchParams(location.search)
  const id = params.get('read')
  if (!id) return
  markNotificationRead(id)
  params.delete('read')
  const rest = params.toString()
  history.replaceState(history.state, '', location.pathname + (rest ? `?${rest}` : ''))
}

/** Open the app at a URL the notification named — in place when it is this origin. */
function openUrl(url: string): void {
  try {
    const target = new URL(url, location.origin)
    if (target.origin === location.origin) {
      window.dispatchEvent(
        new CustomEvent('wolffish:open', { detail: { url: target.pathname + target.search } })
      )
      return
    }
  } catch {
    // fall through
  }
  location.assign(url)
}

/** The user is looking at this page: it is on screen and its window has focus. */
function attended(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

function activeWorker(): Promise<ServiceWorker | null> {
  if (!registration) return Promise.resolve(null)
  if (registration.active) return Promise.resolve(registration.active)
  // First load: the worker is still installing; `ready` settles once it is active.
  return navigator.serviceWorker.ready.then((r) => r.active).catch(() => null)
}

function postToWorker(message: Record<string, unknown>): void {
  void activeWorker().then((worker) => worker?.postMessage(message))
}

function markUnread(id: string): void {
  if (attended()) return
  if (registration) {
    postToWorker({ type: 'unread:add', id })
    return
  }
  localUnread.add(id)
  renderUnreadBadge(localUnread.size)
}

function clearUnread(): void {
  for (const n of localShown) n.close()
  localShown.clear()
  localUnread.clear()
  // The worker also closes what it showed: the tray entries are read now.
  if (registration) postToWorker({ type: 'unread:clear' })
  renderUnreadBadge(0)
}

function needsUserCopy(): { approval: string; question: string } {
  return {
    approval: i18n.t('web.notifications.approval'),
    question: i18n.t('web.notifications.question')
  }
}

function reportAttention(transport: WebTransport): void {
  // The copy rides along so the server's push for a blocked turn reads in
  // the language this page is in — main has no translations of its own.
  transport.post({ t: 'attention', attended: attended(), copy: needsUserCopy() })
}

function watchAttention(transport: WebTransport): void {
  const check = (): void => {
    // On a window blur, hasFocus() can still answer true inside the handler.
    setTimeout(() => {
      const now = attended()
      if (now === lastAttended) return
      lastAttended = now
      if (now) clearUnread()
      reportAttention(transport)
    }, 0)
  }
  document.addEventListener('visibilitychange', check)
  window.addEventListener('focus', check)
  window.addEventListener('blur', check)
  window.addEventListener('pageshow', check)
  transport.onConnection((state) => {
    if (state === 'open') reportAttention(transport)
  })
  lastAttended = attended()
  if (lastAttended) clearUnread()
  else postToWorker({ type: 'unread:get' })
  reportAttention(transport)
}

async function showLocal(
  title: string,
  body: string,
  url: string | null,
  tag: string,
  phase: string
): Promise<void> {
  if (!notificationState().supported || Notification.permission !== 'granted') return
  if (registration) {
    // Android refuses the constructor; the worker's showNotification is the
    // one path that works everywhere a worker runs.
    postToWorker({ type: 'notify', data: { title, body, url, id: tag, phase } })
    return
  }
  try {
    const n = new Notification(title, {
      body,
      icon: '/icon-256.png',
      badge: '/icon-128.png',
      tag,
      requireInteraction: phase === 'needs_input',
      data: { url: url ?? '/' }
    })
    localShown.add(n)
    n.onclose = () => localShown.delete(n)
    n.onclick = () => {
      window.focus()
      openUrl(url ?? '/')
      n.close()
    }
  } catch {
    // no constructor here and no worker: nothing to show
  }
}

function toastNotification(payload: NotifyPayload): void {
  if (toasted.has(payload.id)) return
  toasted.add(payload.id)
  if (toasted.size > 200) toasted.delete(toasted.values().next().value as string)
  toastSink?.({
    message: payload.body ? `${payload.title} — ${payload.body}` : payload.title,
    tone:
      payload.phase === 'failed' ? 'error' : payload.phase === 'needs_input' ? 'warning' : 'info',
    sticky: payload.phase === 'needs_input',
    onClick: () => {
      markNotificationRead(payload.id)
      if (payload.url) openUrl(payload.url)
    }
  })
}

async function subscribePush(): Promise<boolean> {
  if (!registration || !vapidPublicKey || !('PushManager' in window)) return false
  try {
    const existing = await registration.pushManager.getSubscription()
    const sub =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource
      }))
    const json = sub.toJSON()
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint, keys: json.keys })
    })
    subscribed = res.ok
    return subscribed
  } catch (err) {
    console.warn('[web] push subscription failed', err)
    subscribed = false
    return false
  }
}

/**
 * Ask for permission (must be called from a user gesture — a tap on the
 * banner) and, granted, subscribe to push.
 */
export async function requestNotificationPermission(): Promise<NotificationState> {
  if (notificationState().supported) {
    try {
      await Notification.requestPermission()
    } catch {
      // Safari's callback form throws on the promise form in old builds
    }
    if (Notification.permission === 'granted') await subscribePush()
  }
  announce()
  return notificationState()
}

/**
 * Ask on the first gesture after sign-in instead of waiting for a tap on the
 * strip: browsers only grant permission from a user gesture, and the first
 * tap in the app is one. One shot per page load — a prompt the user closed
 * is not raised again until the next visit; the strip stays for them. A tap
 * on the strip itself is left to the strip's own button.
 */
export function armFirstGesturePrompt(onResult: (state: NotificationState) => void): () => void {
  if (!notificationState().supported || Notification.permission !== 'default') return () => {}
  const controller = new AbortController()
  const fire = (event: Event): void => {
    if (event instanceof KeyboardEvent && event.key === 'Escape') return
    if (event.target instanceof Element && event.target.closest('[data-notifications-nudge]'))
      return
    controller.abort()
    if (Notification.permission !== 'default') return
    void requestNotificationPermission().then(onResult)
  }
  const options = { capture: true, signal: controller.signal }
  window.addEventListener('click', fire, options)
  window.addEventListener('keydown', fire, options)
  return () => controller.abort()
}

/**
 * iOS and iPadOS deliver Web Push only to a page opened from the Home
 * Screen, and Safari itself has no Notification API at all: true when this
 * is that browser, so the strip can say what to do instead of nothing.
 */
export function needsHomeScreenInstall(): boolean {
  if (!window.isSecureContext || typeof Notification !== 'undefined') return false
  const apple =
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  if (!apple) return false
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  return !standalone
}

export async function setupNotifications(transport: WebTransport): Promise<void> {
  consumeReadMarker()
  vapidPublicKey = transport.hello?.vapidPublicKey ?? null
  serverPushesNeedsUser = transport.hello?.needsUserPush === true
  const state = notificationState()
  if (state.supported && 'serviceWorker' in navigator) {
    try {
      registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
      navigator.serviceWorker.addEventListener('message', (event) => {
        const msg = event.data as {
          type?: string
          url?: string
          id?: string
          count?: number
          data?: NotifyPayload
        } | null
        if (msg?.type === 'open' && typeof msg.url === 'string') {
          markNotificationRead(msg.id)
          openUrl(msg.url)
        }
        if (msg?.type === 'unread' && typeof msg.count === 'number') {
          // The worker's count is the truth, but the user being here clears it.
          if (msg.count > 0 && attended()) clearUnread()
          else renderUnreadBadge(msg.count)
        }
        // A push the worker kept off the screen because this page has focus.
        if (msg?.type === 'push' && msg.data?.id) toastNotification(msg.data)
      })
      if (Notification.permission === 'granted') await subscribePush()
    } catch (err) {
      console.warn('[web] service worker registration failed', err)
      registration = null
    }
  }

  transport.subscribe<NotifyPayload>('web:notify', (payload) => {
    toastNotification(payload)
    markUnread(payload.id)
    // The push covers an away page when this browser is subscribed; without
    // a subscription the in-band frame is the only thing that can.
    if (!attended() && !subscribed) {
      void showLocal(payload.title, payload.body, payload.url, payload.id, payload.phase)
    }
  })

  // The server now serves a trusted certificate: a page still on plain HTTP
  // at that same host moves over, after the same three seconds the HTTPS
  // card counts down. Another host (a LAN address while the certificate is
  // for the public one) stays put — it may not even reach the new origin.
  transport.subscribe<{ url?: string }>('web:httpsActive', ({ url }) => {
    if (typeof url !== 'string' || location.protocol === 'https:') return
    try {
      if (new URL(url).hostname !== location.hostname) return
    } catch {
      return
    }
    setTimeout(() => location.replace(`${url}${location.pathname}${location.search}`), 3000)
  })

  // A turn blocked on the user while they are elsewhere: the one case where
  // the harness itself, not the model, raises a notification. Same id as
  // the server's push for it, so the two count once.
  const blocked =
    (kind: 'approval' | 'question') => (event: { id: string; conversationId: string | null }) => {
      if (attended()) return
      const id = `needs-${event.id}`
      markUnread(id)
      if (subscribed && serverPushesNeedsUser) return
      const url = event.conversationId
        ? `/?conversation=${encodeURIComponent(event.conversationId)}`
        : '/'
      void showLocal('Wolffish', needsUserCopy()[kind], url, id, 'needs_input')
    }
  transport.subscribe('chat:approvalRequest', blocked('approval'))
  transport.subscribe('chat:askRequest', blocked('question'))

  // A turn this page started ended while the user was away. The desktop
  // bounces its Dock icon for this; here it is the count alone — the banner
  // is the model's call (notify_web), and a second one would double it.
  const ended = (event: { turnId: string }): void => markUnread(`turn-${event.turnId}`)
  transport.subscribe('chat:done', ended)
  transport.subscribe('chat:error', ended)

  watchAttention(transport)
  announce()
}

export async function teardownPushSubscription(): Promise<void> {
  if (!registration) return
  try {
    const sub = await registration.pushManager.getSubscription()
    if (sub) {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint })
      }).catch(() => undefined)
      await sub.unsubscribe().catch(() => undefined)
    }
  } catch {
    // best effort on the way out
  }
  subscribed = false
}
