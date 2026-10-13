/**
 * How the renderer starts in a browser: find out whether this browser is
 * signed in, and once it is, put the socket-backed `window.api` in place
 * before the app mounts — the app itself never learns it is not in Electron.
 */
import { installWebApi } from '@lib/web-bridge/bridge'
import { setupNotifications, teardownPushSubscription } from '@lib/web-bridge/notifications'
import { WebTransport } from '@lib/web-bridge/transport'

export type WebAuthStatus = {
  authenticated: boolean
  passwordSet: boolean
  version: string
  secure: boolean
  notificationsEnabled: boolean
}

let transport: WebTransport | null = null

export function webTransport(): WebTransport | null {
  return transport
}

export async function fetchAuthStatus(): Promise<WebAuthStatus> {
  const res = await fetch('/api/auth/status', { cache: 'no-store' })
  if (!res.ok) throw new Error(`auth status ${res.status}`)
  return (await res.json()) as WebAuthStatus
}

export async function signIn(
  password: string
): Promise<{ ok: true } | { ok: false; error: string; retryAfterMs?: number }> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  })
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    error?: string
    retryAfterMs?: number
  }
  if (res.ok && body.ok) return { ok: true }
  return {
    ok: false,
    error: body.error ?? `sign-in failed (${res.status})`,
    retryAfterMs: body.retryAfterMs
  }
}

/**
 * The link a signed-out browser was sent here from (`/?next=/files/…`), when
 * it is one of this origin's file routes. Anything else — another origin, a
 * protocol-relative host, an arbitrary page — is ignored, so the parameter
 * can never turn the sign-in page into a redirector.
 */
export function pendingNext(): string | null {
  const raw = new URLSearchParams(location.search).get('next')
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null
  return /^\/(files|download|device|pdf)(\/|\?|$)/.test(raw) ? raw : null
}

/**
 * Go where the link pointed. A viewable file (`/files/…`) is navigated to;
 * a download link starts the download and the app mounts behind it, since a
 * browser left on an attachment response would otherwise sit on a blank
 * sign-in page. A browser that cannot show the file type hands the
 * navigation to its download manager and stays put, so the app mounts
 * behind that case too, after a moment — if the navigation did happen,
 * this page is gone before the timer fires.
 */
export function followNext(next: string, mountApp: () => Promise<void>): Promise<void> {
  history.replaceState(null, '', '/')
  if (!/^\/(download|device|pdf)(\/|\?|$)/.test(next)) {
    location.replace(next)
    return new Promise((resolve) => {
      setTimeout(() => resolve(mountApp()), 2500)
    })
  }
  const a = document.createElement('a')
  a.href = next
  a.download = ''
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => a.remove(), 1000)
  return mountApp()
}

/** Sign this browser out: its session is gone on the server, its push subscription with it. */
export async function signOut(): Promise<void> {
  await teardownPushSubscription()
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined)
  location.replace('/')
}

/** Open the socket and install `window.api`. Resolves once the server said hello. */
export async function connectWeb(): Promise<void> {
  if (transport) return
  const t = new WebTransport()
  await t.connect()
  transport = t
  window.api = installWebApi(t)
  const bootPid = t.hello?.pid ?? null
  t.subscribe<{ reason?: string }>('app:closingPending', (event) => {
    if (event?.reason && event.reason !== 'quit') t.restartExpected = true
  })
  t.onConnection((state) => {
    if (state === 'signed-out') location.replace('/')
    // A reconnect to a different process is a restart, a device reboot, a
    // factory reset or an update: the bundle this page runs may be stale and
    // its state certainly is, so start over.
    if (state === 'open' && bootPid !== null && t.hello && t.hello.pid !== bootPid) {
      location.reload()
    }
  })
  await setupNotifications(t)
}
