/**
 * Browser notifications for the Web UI.
 *
 * Three layers, each covering a case the one below cannot:
 *   - a toast inside the app for every `web:notify` the server sends, so an
 *     open tab always shows what the agent said;
 *   - a local notification (through the service worker where the platform
 *     insists on it — Android — or the Notification constructor) when the
 *     page is hidden and no push subscription will cover it, and when a turn
 *     blocks on an approval or a question while the page is hidden;
 *   - a Web Push subscription, registered with the server, which is what
 *     lands with the tab closed and the phone in a pocket.
 *
 * All of it needs a secure context: on plain http://<ip> the browser offers
 * none of these APIs, and `state().supported` says so for the panel.
 */
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
  onClick?: () => void
}) => void

let registration: ServiceWorkerRegistration | null = null
let subscribed = false
let vapidPublicKey: string | null = null
let toastSink: ToastSink | null = null
const stateListeners = new Set<(state: NotificationState) => void>()

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

async function showLocal(
  title: string,
  body: string,
  url: string | null,
  tag?: string
): Promise<void> {
  if (!notificationState().supported || Notification.permission !== 'granted') return
  const options: NotificationOptions = {
    body,
    icon: '/icon-256.png',
    tag,
    data: { url: url ?? '/' }
  }
  if (registration) {
    // Android refuses the constructor; the worker's showNotification is the
    // one path that works everywhere a worker runs.
    registration.active?.postMessage({ type: 'notify', data: { title, body, url, id: tag } })
    return
  }
  try {
    const n = new Notification(title, options)
    n.onclick = () => {
      window.focus()
      openUrl(url ?? '/')
      n.close()
    }
  } catch {
    // no constructor here and no worker: nothing to show
  }
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
  vapidPublicKey = transport.hello?.vapidPublicKey ?? null
  const state = notificationState()
  if (state.supported && 'serviceWorker' in navigator) {
    try {
      registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
      navigator.serviceWorker.addEventListener('message', (event) => {
        const msg = event.data as { type?: string; url?: string } | null
        if (msg?.type === 'open' && typeof msg.url === 'string') openUrl(msg.url)
      })
      if (Notification.permission === 'granted') await subscribePush()
    } catch (err) {
      console.warn('[web] service worker registration failed', err)
      registration = null
    }
  }

  transport.subscribe<NotifyPayload>('web:notify', (payload) => {
    toastSink?.({
      message: `${payload.title} — ${payload.body}`,
      tone:
        payload.phase === 'failed' ? 'error' : payload.phase === 'needs_input' ? 'warning' : 'info',
      onClick: payload.url ? () => openUrl(payload.url!) : undefined
    })
    // The push covers a hidden page when this browser is subscribed; without
    // a subscription the in-band frame is the only thing that can.
    if (document.visibilityState === 'hidden' && !subscribed) {
      void showLocal(payload.title, payload.body, payload.url, payload.id)
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
  // the harness itself, not the model, raises a notification.
  const blocked = (kind: 'approval' | 'question') => (event: { conversationId: string | null }) => {
    if (document.visibilityState !== 'hidden') return
    const url = event.conversationId
      ? `/?conversation=${encodeURIComponent(event.conversationId)}`
      : '/'
    void showLocal(
      'Wolffish',
      kind === 'approval'
        ? 'A tool call is waiting for your approval.'
        : 'Wolffish has a question for you.',
      url,
      `needs-user-${event.conversationId ?? 'x'}`
    )
  }
  transport.subscribe('chat:approvalRequest', blocked('approval'))
  transport.subscribe('chat:askRequest', blocked('question'))
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
