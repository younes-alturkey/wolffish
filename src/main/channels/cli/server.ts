/**
 * The local control socket the `wolffish` command talks to.
 *
 * Deliberately the smallest protocol that could work: newline-delimited JSON
 * carrying exactly two things — an `invoke` (request/response, keyed by the
 * SAME channel names the renderer uses over IPC) and an `event` stream
 * (everything the app already broadcasts, plus the CLI channel's own turn
 * frames). There is no bespoke CLI API surface to keep in sync with the UI,
 * because there is no bespoke CLI API surface: index.ts registers every
 * handler through a map, and this server reaches into that map.
 *
 * Transport is a unix domain socket (`~/.wolffish/cli.sock`) or a Windows
 * named pipe. Both are single-user by construction — the socket is created
 * 0600 inside the user's own home, and a named pipe defaults to the creating
 * account — so authentication is the filesystem's job and there is no token to
 * leak, no port to expose, and nothing reachable from the network. That last
 * point is the whole reason this is not an HTTP server: a VPS install must not
 * grow a listening port by accident.
 *
 * A handful of IPC channels are meaningless without a window (native file
 * pickers, "reveal in Finder", "open this URL in a browser"). Forwarding them
 * would hang a terminal on a dialog nobody can see, so they are refused by
 * name with a message naming the CLI equivalent — see GUI_ONLY below.
 */
import type { CliChannel, CliEvent } from '@main/channels/cli/channel'
import { diskWriter } from '@main/io/diskWriter'
import { wlog } from '@main/workspace/logger'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const TAG = '[cli]'

/** Wire protocol version. Bumped only on a breaking frame change. */
export const CLI_PROTOCOL_VERSION = 1

export type CliInvokeHandler = (event: unknown, ...args: unknown[]) => unknown

/**
 * IPC channels that only mean something with a window attached. Each maps to
 * the CLI's own way of doing the same job, so the error is a redirection
 * rather than a dead end.
 */
const GUI_ONLY: Record<string, string> = {
  'upload:pickFile': 'pass file paths instead: wolffish -f <path>, or /attach <path> in the REPL',
  'upload:pickFolder': 'pass the folder path instead',
  'projects:pickFiles': 'use: wolffish project files add <id> <path…>',
  'ollama:pickModelsFolder': 'use: wolffish settings local — "Where models are stored"',
  // These name `wolffish view`, not `wolffish open` — there is no `open`
  // command, and a redirection to a command that does not exist is a dead end
  // wearing the costume of a helpful error.
  'upload:revealInFolder': 'use: wolffish view <path>',
  'viewer:revealInFolder': 'use: wolffish view <path>',
  'voice:revealInFolder': 'use: wolffish view <path>',
  'diagnostics:reveal': 'the archive path is printed by: wolffish conversations diagnose <id>',
  'browserExtension:openExtensionFolder':
    'the path is printed by: wolffish settings browserExtension',
  'browserExtension:openExtensionsPage': 'open the browser extensions page yourself',
  'ollama:openInstallPage': 'install Ollama from ollama.com, then run: ollama serve',
  'spellcheck:replace': 'renderer-only',
  'spellcheck:addToDictionary': 'renderer-only',
  'tray-menu:action': 'renderer-only',
  'tray-menu:close': 'renderer-only'
}

type Frame =
  | { id: number; t: 'invoke'; channel: string; args?: unknown[] }
  | { t: 'subscribe' }
  | { t: 'ping' }

export type CliServerDeps = {
  /** The live ipcMain handler registry — see `handle()` in index.ts. */
  handlers: Map<string, CliInvokeHandler>
  channel: CliChannel
  /** App version, for the hello frame's compatibility check. */
  version: string
}

export class CliServer {
  private server: net.Server | null = null
  private readonly sockets = new Set<net.Socket>()
  private unsubscribeChannel: (() => void) | null = null
  private listening = false

  constructor(private readonly deps: CliServerDeps) {}

  /**
   * `~/.wolffish/cli.sock`, or the Windows named pipe. `WOLFFISH_SOCKET`
   * overrides it — the client reads the same variable, so the two can be
   * pointed at a scratch endpoint together and never at different ones.
   */
  static socketPath(): string {
    if (process.env.WOLFFISH_SOCKET) return process.env.WOLFFISH_SOCKET
    if (process.platform === 'win32') return '\\\\.\\pipe\\wolffish-cli'
    return path.join(os.homedir(), '.wolffish', 'cli.sock')
  }

  isListening(): boolean {
    return this.listening
  }

  /** Number of attached clients — what `wolffish status` reports. */
  clientCount(): number {
    return this.sockets.size
  }

  async start(): Promise<void> {
    if (this.server) return
    const socketPath = CliServer.socketPath()

    if (process.platform !== 'win32') {
      await fs.mkdir(path.dirname(socketPath), { recursive: true })
      // A socket file left behind by a crash makes bind fail with EADDRINUSE.
      // It is safe to remove: a LIVE listener would have been found by the
      // single-instance lock long before we got here.
      if (existsSync(socketPath)) await fs.rm(socketPath, { force: true })
    }

    const server = net.createServer((socket) => this.onConnection(socket))
    this.server = server

    /**
     * The permission is set BEFORE the socket exists, not after.
     *
     * `listen()` creates the node with the process umask — 0755 on a default
     * Linux box — and the chmod that followed left a window in which any local
     * user could connect and drive the agent. Narrow, but on a shared VPS it is
     * a window into someone's whole account, and it opens on every start.
     * `process.umask` is the only way to influence the mode at creation, so it
     * is tightened around the listen and restored immediately.
     */
    const previousUmask = process.platform === 'win32' ? null : process.umask(0o177)
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
    } finally {
      if (previousUmask !== null) process.umask(previousUmask)
    }

    if (process.platform !== 'win32') {
      // Belt and braces, and the one that must be LOUD if it fails: a socket
      // left group- or world-writable is an unauthenticated control channel,
      // so a failure here is logged rather than swallowed.
      try {
        await fs.chmod(socketPath, 0o600)
      } catch (error) {
        wlog.error(
          TAG,
          `could not restrict ${socketPath} to this user (${String(error)}) — other local users may be able to drive Wolffish`
        )
      }
    }

    this.listening = true
    this.unsubscribeChannel = this.deps.channel.subscribe((event) => this.pushTurn(event))
    // A pid file so the client can tell "no daemon" from "daemon wedged", and
    // can offer to start one rather than printing a bare ECONNREFUSED.
    await diskWriter
      .writeFileAtomic(CliServer.pidPath(), String(process.pid))
      .catch(() => undefined)
    wlog.info(TAG, `listening on ${socketPath}`)
  }

  static pidPath(): string {
    return path.join(os.homedir(), '.wolffish', 'cli.pid')
  }

  async stop(): Promise<void> {
    this.unsubscribeChannel?.()
    this.unsubscribeChannel = null
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    const server = this.server
    this.server = null
    this.listening = false
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (process.platform !== 'win32') {
      await fs.rm(CliServer.socketPath(), { force: true }).catch(() => undefined)
    }
    await fs.rm(CliServer.pidPath(), { force: true }).catch(() => undefined)
  }

  /**
   * Relay one app-wide broadcast to every attached client. index.ts calls this
   * from `broadcast()`, the single chokepoint that already fans out to windows
   * and the phone — so a setting saved anywhere reaches the terminal too,
   * with no per-setting wiring.
   */
  pushBroadcast(channel: string, payload: unknown): void {
    this.writeAll({ t: 'event', channel, payload })
  }

  private pushTurn(event: CliEvent): void {
    this.writeAll({ t: 'turn', event })
  }

  private writeAll(frame: unknown): void {
    if (this.sockets.size === 0) return
    let line: string
    try {
      line = JSON.stringify(frame) + '\n'
    } catch {
      // A payload that won't serialize (a cycle, a Buffer graph) must not take
      // the daemon down — drop the frame and keep the stream alive.
      return
    }
    for (const socket of this.sockets) {
      if (socket.destroyed) continue
      socket.write(line)
    }
  }

  private onConnection(socket: net.Socket): void {
    this.sockets.add(socket)
    socket.setNoDelay(true)

    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      // Frames are newline-delimited; a partial tail stays in the buffer.
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line.length > 0) void this.onFrame(socket, line)
        index = buffer.indexOf('\n')
      }
    })

    const drop = (): void => {
      this.sockets.delete(socket)
    }
    socket.on('close', drop)
    socket.on('error', drop)

    this.write(socket, {
      t: 'hello',
      protocol: CLI_PROTOCOL_VERSION,
      version: this.deps.version,
      pid: process.pid,
      platform: process.platform
    })
  }

  private write(socket: net.Socket, frame: unknown): void {
    if (socket.destroyed) return
    try {
      socket.write(JSON.stringify(frame) + '\n')
    } catch {
      // client vanished mid-write
    }
  }

  private async onFrame(socket: net.Socket, line: string): Promise<void> {
    let frame: Frame
    try {
      frame = JSON.parse(line) as Frame
    } catch {
      return
    }
    if (frame.t === 'ping') {
      this.write(socket, { t: 'pong' })
      return
    }
    if (frame.t === 'subscribe') return
    if (frame.t !== 'invoke') return

    const { id, channel, args = [] } = frame
    const guiOnly = GUI_ONLY[channel]
    if (guiOnly) {
      this.write(socket, {
        id,
        t: 'result',
        ok: false,
        error: `${channel} needs a window — ${guiOnly}`
      })
      return
    }

    const handler = this.deps.handlers.get(channel)
    if (!handler) {
      this.write(socket, { id, t: 'result', ok: false, error: `unknown channel: ${channel}` })
      return
    }

    try {
      /**
       * A stub event stands in for IpcMainInvokeEvent, rather than `null`.
       *
       * `null` was chosen on the reasoning that the only handlers reading the
       * event were refused above — and that stopped being true the moment one
       * wasn't. `google:authAdd` calls `event.sender.send` from a child
       * process's stdout listener, so a terminal asking to authorize an
       * account raised an uncaught TypeError in the MAIN PROCESS, with nothing
       * around it to catch. (That handler now broadcasts, but the class of bug
       * is one careless `event.sender` away from returning.)
       *
       * `send` therefore routes to the same broadcast every attached client is
       * already listening on: a handler that wanted to push something at the
       * caller gets its wish, and no handler can take the daemon down by
       * assuming a window.
       */
      const stubEvent = {
        sender: {
          send: (pushChannel: string, payload: unknown) => this.pushBroadcast(pushChannel, payload),
          isDestroyed: () => false
        }
      }
      const value = await handler(stubEvent, ...args)
      this.write(socket, { id, t: 'result', ok: true, value })
    } catch (err) {
      this.write(socket, {
        id,
        t: 'result',
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
}
