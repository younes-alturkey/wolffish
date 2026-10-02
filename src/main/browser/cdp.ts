/**
 * In-process CDP over `webContents.debugger`.
 *
 * No `--remote-debugging-port` anywhere: the debugger attaches to the guest's
 * own WebContents inside this process, so there is no open port and no
 * handshake to secure.
 *
 * Two lifecycle facts drive the shape of this file:
 *
 *  - The debugger detaches when the WebContents closes OR when DevTools is
 *    opened on it (electron.d.ts:7343-7346). That second one is a user action
 *    we cannot prevent, so detach is a normal event, not a fault, and every
 *    pending command has to be settled when it happens — otherwise a turn
 *    hangs forever on a promise nobody will resolve.
 *  - A render-process crash leaves sendCommand permanently unanswered too.
 *    The extension server gets away with no timeout because a dead socket
 *    settles its pending map; in-process there is no socket, so terminal
 *    events plus a real timeout are what replace it.
 */
import type { WebContents } from 'electron'
import { wlog } from '@main/workspace/logger'

const TAG = 'browser'

/** Nothing legitimate takes this long; a wedged page must not hang a turn. */
const COMMAND_TIMEOUT_MS = 30_000

export type CdpEventHandler = (method: string, params: Record<string, unknown>) => void

export class CdpDetachedError extends Error {
  constructor(reason: string) {
    super(`The browser debugging session detached (${reason}). Re-open the page to continue.`)
    this.name = 'CdpDetachedError'
  }
}

export class CdpSession {
  private readonly wc: WebContents
  private attached = false
  private detachReason: string | null = null
  private readonly handlers = new Set<CdpEventHandler>()
  private readonly inflight = new Set<{ reject: (err: Error) => void; timer: NodeJS.Timeout }>()

  constructor(wc: WebContents) {
    this.wc = wc
  }

  get isAttached(): boolean {
    return this.attached && !this.wc.isDestroyed()
  }

  attach(): void {
    if (this.attached) return
    this.wc.debugger.attach('1.3')
    this.attached = true
    this.detachReason = null

    this.wc.debugger.on('detach', (_event, reason) => {
      this.attached = false
      this.detachReason = reason
      wlog.info(TAG, `cdp detached: ${reason}`)
      this.settleAll(new CdpDetachedError(reason))
    })

    this.wc.debugger.on('message', (_event, method, params) => {
      const payload = (params ?? {}) as Record<string, unknown>
      for (const handler of this.handlers) {
        try {
          handler(method, payload)
        } catch (err) {
          // One bad subscriber must not starve the others, and must never
          // take the main process down from inside an event callback.
          wlog.warn(TAG, `cdp handler threw for ${method}:`, err)
        }
      }
    })
  }

  on(handler: CdpEventHandler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  /**
   * `sessionId` is threaded through for out-of-process iframe targets — the
   * flat-session model, where one debugger serves several targets. Unused
   * today (cross-origin frames render as a wall line, like the extension's),
   * but the signature is the seam that makes adding them additive.
   */
  async send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string
  ): Promise<T> {
    if (!this.isAttached) throw new CdpDetachedError(this.detachReason ?? 'not attached')

    return new Promise<T>((resolve, reject) => {
      const entry = {
        reject,
        timer: setTimeout(() => {
          this.inflight.delete(entry)
          reject(new Error(`CDP ${method} timed out after ${COMMAND_TIMEOUT_MS}ms`))
        }, COMMAND_TIMEOUT_MS)
      }
      this.inflight.add(entry)

      // Only pass a session id when there is one. An explicit `undefined`
      // third argument is not "absent" to the native binding — it is a
      // session that does not exist, and a command routed to it never
      // answers. (Every command in the spike, which worked, had two args.)
      const call = sessionId
        ? this.wc.debugger.sendCommand(method, params, sessionId)
        : this.wc.debugger.sendCommand(method, params)
      call
        .then((result: unknown) => {
          clearTimeout(entry.timer)
          this.inflight.delete(entry)
          resolve(result as T)
        })
        .catch((err: unknown) => {
          clearTimeout(entry.timer)
          this.inflight.delete(entry)
          reject(err instanceof Error ? err : new Error(String(err)))
        })
    })
  }

  /** Fire-and-forget: acks and teardown, where a rejection is noise. */
  sendSilent(method: string, params: Record<string, unknown> = {}, sessionId?: string): void {
    if (!this.isAttached) return
    const call = sessionId
      ? this.wc.debugger.sendCommand(method, params, sessionId)
      : this.wc.debugger.sendCommand(method, params)
    call.catch(() => {})
  }

  detach(): void {
    this.handlers.clear()
    this.settleAll(new CdpDetachedError('closed'))
    if (!this.attached) return
    this.attached = false
    try {
      if (!this.wc.isDestroyed()) this.wc.debugger.detach()
    } catch {
      // already gone — the only outcome we wanted anyway
    }
  }

  private settleAll(err: Error): void {
    for (const entry of this.inflight) {
      clearTimeout(entry.timer)
      entry.reject(err)
    }
    this.inflight.clear()
  }
}
