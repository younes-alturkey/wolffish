/**
 * The socket half of the CLI: connect, invoke, listen, reconnect — and, when
 * nothing is listening, start the daemon.
 *
 * Wire protocol (see src/main/channels/cli/server.ts): newline-delimited JSON.
 *   → { id, t:'invoke', channel, args }        → { id, t:'result', ok, value|error }
 *   ← { t:'hello', protocol, version, pid, platform }
 *   ← { t:'turn', event }                        the CLI channel's own turn frames
 *   ← { t:'event', channel, payload }            every app-wide broadcast
 *
 * This client is API-compatible with the legacy `lib/client.mjs` (invoke,
 * onTurn, onEvent, onClose, hello, close) so the ported command modules keep
 * working unchanged, and adds what the TUI needs: a reconnect loop with
 * backoff, and connection-state listeners.
 *
 * Autostart: a client that spawned the daemon as an ordinary child would tie
 * the agent's life to the terminal. Detached + unref() is what makes
 * `wolffish` a viewport onto a process that outlives it.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

export const SOCKET_PATH =
  process.env.WOLFFISH_SOCKET ||
  (process.platform === 'win32'
    ? '\\\\.\\pipe\\wolffish-cli'
    : path.join(os.homedir(), '.wolffish', 'cli.sock'))

const PID_PATH = path.join(os.homedir(), '.wolffish', 'cli.pid')

/** One handler call may take this long before the client gives up. */
const INVOKE_TIMEOUT_MS = 180_000
const BOOT_TIMEOUT_MS = 45_000
const BOOT_POLL_MS = 250

export type Hello = {
  t: 'hello'
  protocol: number
  version: string
  pid: number
  platform: string
}

export type TurnFrame = { t: string; [key: string]: unknown }
export type EventFrame = { channel: string; payload: unknown }
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed'

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class DaemonClient {
  socket: net.Socket | null = null
  hello: Hello | null = null
  /** Legacy hook: called once when the socket closes. */
  onClose: (() => void) | null = null
  state: ConnectionState = 'connecting'

  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly turnListeners = new Set<(event: TurnFrame) => void>()
  private readonly eventListeners = new Set<(event: EventFrame) => void>()
  private readonly stateListeners = new Set<(state: ConnectionState) => void>()
  private buffer = ''
  private onHello: (() => void) | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 1000
  private closedByUser = false
  /** When true the client reconnects on its own after a drop. */
  autoReconnect = false

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(SOCKET_PATH)
      let settled = false
      socket.setNoDelay(true)

      socket.on('connect', () => {
        this.socket = socket
        this.buffer = ''
        this.reconnectDelay = 1000
        this.setState('connected')
        const settle = () => {
          if (settled) return
          settled = true
          this.onHello = null
          resolve()
        }
        this.onHello = settle
        setTimeout(settle, 250).unref?.()
      })
      socket.on('error', (err) => {
        if (!settled) {
          settled = true
          reject(err)
        }
      })
      socket.on('data', (chunk: Buffer | string) => this.ingest(chunk))
      socket.on('close', () => {
        if (this.socket === socket) this.socket = null
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer)
          entry.reject(new Error('lost connection to the Wolffish daemon'))
        }
        this.pending.clear()
        if (this.onClose) this.onClose()
        if (this.autoReconnect && !this.closedByUser) this.scheduleReconnect()
        else this.setState('closed')
      })
    })
  }

  private scheduleReconnect(): void {
    this.setState('reconnecting')
    if (this.reconnectTimer) return
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.closedByUser) return
      this.connect().catch(() => this.scheduleReconnect())
    }, delay)
    this.reconnectTimer.unref?.()
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return
    this.state = state
    for (const listener of this.stateListeners) listener(state)
  }

  private ingest(chunk: Buffer | string): void {
    this.buffer += chunk.toString('utf8')
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line) this.dispatch(line)
      index = this.buffer.indexOf('\n')
    }
  }

  private dispatch(line: string): void {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(line)
    } catch {
      return
    }
    if (frame.t === 'hello') {
      this.hello = frame as unknown as Hello
      if (this.onHello) this.onHello()
      return
    }
    if (frame.t === 'result') {
      const entry = this.pending.get(frame.id as number)
      if (!entry) return
      this.pending.delete(frame.id as number)
      clearTimeout(entry.timer)
      if (frame.ok) entry.resolve(frame.value)
      else entry.reject(new Error(String(frame.error ?? 'unknown error')))
      return
    }
    if (frame.t === 'turn') {
      const event = frame.event as TurnFrame
      for (const listener of this.turnListeners) {
        try {
          listener(event)
        } catch {
          /* a listener must not kill the stream */
        }
      }
      return
    }
    if (frame.t === 'event') {
      const event = { channel: String(frame.channel), payload: frame.payload }
      for (const listener of this.eventListeners) {
        try {
          listener(event)
        } catch {
          /* same */
        }
      }
    }
  }

  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('not connected'))
        return
      }
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error(
            `${channel} did not answer in ${INVOKE_TIMEOUT_MS / 1000}s — the daemon may be wedged (wolffish service stop, then run any command again)`
          )
        )
      }, INVOKE_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.socket.write(JSON.stringify({ id, t: 'invoke', channel, args }) + '\n')
    })
  }

  onTurn(listener: (event: TurnFrame) => void): () => void {
    this.turnListeners.add(listener)
    return () => this.turnListeners.delete(listener)
  }

  onEvent(listener: (event: EventFrame) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onState(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  close(): void {
    this.closedByUser = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.socket?.end()
    this.socket = null
    this.setState('closed')
  }
}

export function daemonPid(): number | null {
  try {
    if (!existsSync(PID_PATH)) return null
    const pid = Number.parseInt(readFileSync(PID_PATH, 'utf8').trim(), 10)
    if (!Number.isFinite(pid)) return null
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

/**
 * The app binary a missing daemon is started from.
 *
 * `WOLFFISH_EXEC` is set by the shim (the compiled CLI's own execPath is the
 * CLI, not the app). `APPIMAGE` wins over a raw execPath because an AppImage
 * mount dies with the process that made it.
 */
export function daemonExecPath(): string {
  const configured = process.env.WOLFFISH_EXEC || process.env.APPIMAGE
  if (configured) return configured
  // The compiled client's own execPath is the client, not the app. Without a
  // shim telling us where the app is there is nothing to start.
  if (/wolffish-cli/.test(path.basename(process.execPath))) {
    throw new Error(
      'WOLFFISH_EXEC is not set — run `wolffish` through its shim, or export WOLFFISH_EXEC=<path to the Wolffish app binary>'
    )
  }
  return process.execPath
}

function startDaemon(): void {
  const execPath = daemonExecPath()
  const env: Record<string, string | undefined> = { ...process.env, WOLFFISH_HEADLESS: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(execPath, ['--headless', '--no-sandbox'], {
    detached: true,
    stdio: 'ignore',
    env
  })
  child.unref()
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function connect({
  autostart = true,
  quiet = false
}: { autostart?: boolean; quiet?: boolean } = {}): Promise<DaemonClient> {
  const client = new DaemonClient()
  try {
    await client.connect()
    return client
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (!autostart || (code !== 'ENOENT' && code !== 'ECONNREFUSED')) throw error
  }
  if (!quiet) process.stderr.write('starting the Wolffish daemon…\n')
  startDaemon()
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(BOOT_POLL_MS)
    try {
      const fresh = new DaemonClient()
      await fresh.connect()
      return fresh
    } catch {
      /* not up yet */
    }
  }
  throw new Error('the daemon did not answer in time')
}
