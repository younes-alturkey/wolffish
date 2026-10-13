/**
 * The Web UI's socket to the main process — what stands in for the preload
 * when the renderer runs in a browser.
 *
 * Same protocol as the CLI's local socket, over WebSocket: `invoke` frames
 * keyed by the renderer's own IPC channel names, `event` frames for
 * everything the app pushes. Bytes cross as `{ $bin: base64 }` and come
 * back as Uint8Array, which is what every Blob-building caller in the
 * renderer already accepts.
 *
 * Reconnects on its own with a short backoff — a phone that locks and
 * unlocks loses the socket every time. Broadcasts are not replayed (the
 * renderer re-fetches what it shows on `conversation:changed`-style events),
 * but events addressed to this page — a turn it started — are: the server
 * holds them under `pageId` while the socket is down. A close with code 4001
 * means this browser was signed out, and that is final.
 */

import { randomId } from '@lib/utils/randomId'

export type HelloFrame = {
  version: string
  /** The daemon's pid — a different one after a reconnect means the app restarted. */
  pid: number
  clientId: string
  sessionId: string
  secure: boolean
  notificationsEnabled: boolean
  vapidPublicKey: string | null
  /** The server pushes a blocked turn's approval/question to a browser that reported itself away. */
  needsUserPush?: boolean
  /**
   * Whether the server still held this page's events across the gap. False on
   * a first connect and on a reconnect after the server gave the page up —
   * then a turn this page was streaming must be recovered from main.
   */
  resumed?: boolean
}

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'signed-out'

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

const INVOKE_TIMEOUT_MS = 10 * 60_000
const RECONNECT_MIN_MS = 800
const RECONNECT_MAX_MS = 10_000
/** While the app is known to be restarting: often enough that the reload follows the new process within a second. */
const RESTART_POLL_MS = 1_000

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export function encodeForWire(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Uint8Array) return { $bin: toBase64(value) }
  if (value instanceof ArrayBuffer) return { $bin: toBase64(new Uint8Array(value)) }
  if (Array.isArray(value)) return value.map(encodeForWire)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'function') continue
    out[k] = encodeForWire(v)
  }
  return out
}

export function decodeFromWire(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(decodeFromWire)
  const obj = value as Record<string, unknown>
  if (typeof obj.$bin === 'string' && Object.keys(obj).length === 1) return fromBase64(obj.$bin)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) out[k] = decodeFromWire(v)
  return out
}

export class WebTransport {
  private ws: WebSocket | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>()
  private readonly connectionListeners = new Set<(state: ConnectionState) => void>()
  private reconnectDelay = RECONNECT_MIN_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private helloWaiters: Array<{ resolve: (h: HelloFrame) => void; reject: (e: Error) => void }> = []
  /** Whether the CURRENT socket ever got its hello — a close before one is a refused upgrade. */
  private greeted = false
  hello: HelloFrame | null = null
  /**
   * This page load's identity across reconnects. The server binds a running
   * turn's events to the page, not the socket, and holds them while the
   * socket is down — a phone that locks mid-answer gets the rest on unlock.
   */
  private readonly pageId = randomId()
  state: ConnectionState = 'closed'
  /**
   * Set when the app announced it is going down to come back (restart,
   * device reboot, factory reset). The gap is expected, so retries hold a
   * steady cadence instead of backing off to ten seconds.
   */
  restartExpected = false

  constructor() {
    // A phone coming back from its lock screen gets its socket back at once
    // rather than after the backoff it was in the middle of.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.state === 'closed') this.open()
    })
    window.addEventListener('online', () => {
      if (this.state === 'closed') this.open()
    })
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return
    this.state = next
    for (const listener of this.connectionListeners) {
      try {
        listener(next)
      } catch {
        // a listener's problem is not the transport's
      }
    }
  }

  onConnection(listener: (state: ConnectionState) => void): () => void {
    this.connectionListeners.add(listener)
    return () => this.connectionListeners.delete(listener)
  }

  /** Open the socket; resolves with the server's hello. */
  connect(): Promise<HelloFrame> {
    if (this.hello && this.state === 'open') return Promise.resolve(this.hello)
    return new Promise((resolve, reject) => {
      this.helloWaiters.push({ resolve, reject })
      this.open()
    })
  }

  private open(): void {
    if (this.state === 'signed-out') return
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    )
      return
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.setState('connecting')
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${scheme}://${location.host}/ws?page=${this.pageId}`)
    this.ws = ws
    this.greeted = false
    ws.onmessage = (event) => this.onFrame(String(event.data))
    ws.onclose = (event) => {
      if (this.ws !== ws) return
      this.ws = null
      this.failPending(new Error('connection lost'))
      if (event.code === 4001 || event.code === 1008) {
        this.signedOut()
        return
      }
      this.setState('closed')
      if (!this.greeted) {
        // Closed before any hello: the upgrade was refused. Either the server
        // is down (keep trying) or this browser's session is gone — signed
        // out from elsewhere, a regenerated passphrase — and reconnecting
        // would only ever meet the same 401. Ask the auth route, which
        // answers either way.
        void this.probeSession().then((authenticated) => {
          if (authenticated === false) this.signedOut()
          else this.scheduleReconnect()
        })
        return
      }
      this.scheduleReconnect()
    }
    ws.onerror = () => {
      // onclose follows and carries the retry
    }
  }

  private signedOut(): void {
    this.setState('signed-out')
    for (const w of this.helloWaiters) w.reject(new Error('signed out'))
    this.helloWaiters = []
  }

  /** Whether this browser is still signed in; null when the server cannot be asked. */
  private async probeSession(): Promise<boolean | null> {
    try {
      const res = await fetch('/api/auth/status', { cache: 'no-store' })
      if (!res.ok) return null
      const body = (await res.json()) as { authenticated?: boolean }
      return body.authenticated === true
    } catch {
      return null
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.state === 'signed-out') return
    const delay = this.restartExpected ? RESTART_POLL_MS : this.reconnectDelay
    this.reconnectDelay = Math.min(RECONNECT_MAX_MS, Math.round(this.reconnectDelay * 1.7))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, delay)
  }

  private failPending(error: Error): void {
    for (const [, p] of this.pending) p.reject(error)
    this.pending.clear()
  }

  private onFrame(raw: string): void {
    let frame: {
      t?: string
      id?: number
      ok?: boolean
      value?: unknown
      error?: string
      channel?: string
      payload?: unknown
    }
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }
    if (frame.t === 'hello') {
      this.hello = frame as unknown as HelloFrame
      this.greeted = true
      this.reconnectDelay = RECONNECT_MIN_MS
      this.setState('open')
      for (const w of this.helloWaiters) w.resolve(this.hello)
      this.helloWaiters = []
      return
    }
    if (frame.t === 'result' && typeof frame.id === 'number') {
      const p = this.pending.get(frame.id)
      if (!p) return
      this.pending.delete(frame.id)
      if (frame.ok) p.resolve(decodeFromWire(frame.value))
      else p.reject(new Error(frame.error ?? 'request failed'))
      return
    }
    if (frame.t === 'event' && typeof frame.channel === 'string') {
      this.emitLocal(frame.channel, decodeFromWire(frame.payload))
    }
  }

  /** Deliver an event to local subscribers — also used by the bridge for synthetic progress ticks. */
  emitLocal(channel: string, payload: unknown): void {
    const set = this.listeners.get(channel)
    if (!set) return
    for (const listener of [...set]) {
      try {
        listener(payload)
      } catch (err) {
        console.error(`[web] listener for ${channel} threw`, err)
      }
    }
  }

  subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
    let set = this.listeners.get(channel)
    if (!set) {
      set = new Set()
      this.listeners.set(channel, set)
    }
    const wrapped = listener as (payload: unknown) => void
    set.add(wrapped)
    return () => {
      set.delete(wrapped)
    }
  }

  /** A one-way frame with no reply; dropped while no socket is open. */
  post(frame: Record<string, unknown>): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify(frame))
    } catch {
      // the next open re-sends whatever the caller keeps current
    }
  }

  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // Give a reconnect in progress a moment rather than failing a tap that
      // landed in the gap between lock screen and socket.
      return this.connect().then(() => this.invoke(channel, ...args))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${channel} timed out`))
      }, INVOKE_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      try {
        ws.send(JSON.stringify({ t: 'invoke', id, channel, args: encodeForWire(args) }))
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }
}
