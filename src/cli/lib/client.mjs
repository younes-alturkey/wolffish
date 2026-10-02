/**
 * The socket half of the CLI: connect, invoke, listen, and — when nothing is
 * listening — start the daemon.
 *
 * Autostart is the part worth reading. A client that spawns the daemon as an
 * ordinary child would tie the agent's life to the terminal, so closing the
 * SSH session would kill the automations, the channels, and any turn in
 * flight. Detached + `unref()` is what makes `wolffish` a viewport onto a
 * process that outlives it, which is the entire premise of running on a VPS.
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

/**
 * `WOLFFISH_SOCKET` overrides the endpoint. It exists so the client and the
 * daemon can be exercised against each other in a test without touching a
 * real install — both sides read the same variable, so they can never be
 * pointed at different places.
 */
export const SOCKET_PATH =
  process.env.WOLFFISH_SOCKET ||
  (process.platform === 'win32'
    ? '\\\\.\\pipe\\wolffish-cli'
    : path.join(os.homedir(), '.wolffish', 'cli.sock'))

const PID_PATH = path.join(os.homedir(), '.wolffish', 'cli.pid')

/**
 * How long one handler call may take before the client gives up. Generous:
 * some handlers install a binary or walk the whole workspace. It exists to
 * turn "hangs forever" into an error with a fix in it, not to police latency.
 */
const INVOKE_TIMEOUT_MS = 180_000

/** How long to wait for a daemon we just started to answer. */
const BOOT_TIMEOUT_MS = 45_000
const BOOT_POLL_MS = 250

export class DaemonClient {
  constructor() {
    this.socket = null
    this.nextId = 1
    this.pending = new Map()
    this.turnListeners = new Set()
    this.eventListeners = new Set()
    this.hello = null
    this.onClose = null
    this.buffer = ''
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(SOCKET_PATH)
      let settled = false
      socket.setNoDelay(true)

      socket.on('connect', () => {
        this.socket = socket
        // The daemon sends `hello` immediately; wait for it (briefly) so
        // callers that read `client.hello` — the version command, any future
        // protocol check — don't race a frame already on the wire.
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
      socket.on('data', (chunk) => this.#ingest(chunk))
      socket.on('close', () => {
        this.socket = null
        // Anything still waiting will never be answered — reject rather than
        // leave a command hanging forever on a daemon that went away.
        for (const [, entry] of this.pending) {
          entry.reject(new Error('lost connection to the Wolffish daemon'))
        }
        this.pending.clear()
        if (this.onClose) this.onClose()
      })
    })
  }

  #ingest(chunk) {
    this.buffer += chunk.toString('utf8')
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line) this.#dispatch(line)
      index = this.buffer.indexOf('\n')
    }
  }

  #dispatch(line) {
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      return
    }
    if (frame.t === 'hello') {
      this.hello = frame
      if (this.onHello) this.onHello()
      return
    }
    if (frame.t === 'result') {
      const entry = this.pending.get(frame.id)
      if (!entry) return
      this.pending.delete(frame.id)
      if (frame.ok) entry.resolve(frame.value)
      else entry.reject(new Error(frame.error || 'request failed'))
      return
    }
    if (frame.t === 'turn') {
      for (const listener of this.turnListeners) listener(frame.event)
      return
    }
    if (frame.t === 'event') {
      for (const listener of this.eventListeners) listener(frame.channel, frame.payload)
    }
  }

  /**
   * Call one of the app's IPC handlers by name.
   *
   * Bounded, because the failure it guards against is invisible: a daemon that
   * is WEDGED rather than dead holds an open socket and never answers, and an
   * unbounded promise turns that into a command that prints nothing and never
   * returns — indistinguishable from slow work. The ceiling is generous
   * (handlers here install binaries, walk the workspace and talk to providers)
   * and the message names the recovery, because the only cure is a restart.
   *
   * A rejection also has to CLEAR the pending entry: a late answer arriving
   * after the timeout would otherwise resolve a promise nobody holds and leak
   * the entry for the life of the process.
   */
  invoke(channel, ...args) {
    if (!this.socket) return Promise.reject(new Error('not connected'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(
          new Error(
            `the daemon did not answer "${channel}" within ${Math.round(INVOKE_TIMEOUT_MS / 1000)}s — it may be wedged (wolffish service stop, then run any command again)`
          )
        )
      }, INVOKE_TIMEOUT_MS)
      // `unref` so a pending call never keeps a finished command alive.
      timer.unref?.()
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
      this.socket.write(JSON.stringify({ id, t: 'invoke', channel, args }) + '\n')
    })
  }

  onTurn(listener) {
    this.turnListeners.add(listener)
    return () => this.turnListeners.delete(listener)
  }

  onEvent(listener) {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  close() {
    if (this.socket) this.socket.destroy()
    this.socket = null
  }
}

/** The pid of a daemon that claims to be running, if the file says so. */
export function daemonPid() {
  try {
    const pid = Number.parseInt(readFileSync(PID_PATH, 'utf8').trim(), 10)
    if (!Number.isFinite(pid) || pid <= 0) return null
    process.kill(pid, 0)
    return pid
  } catch (err) {
    // EPERM means it exists and belongs to someone else — still running.
    if (err && err.code === 'EPERM') return null
    return null
  }
}

export function socketExists() {
  if (process.platform === 'win32') return true
  return existsSync(SOCKET_PATH)
}

/**
 * Launch the daemon and wait until it answers. Detached, with stdio thrown
 * away: this process must be able to exit — or be killed with the terminal —
 * without taking the agent down with it.
 */
/**
 * The binary a daemon gets started from. Exported because the error shown when
 * one cannot be started has to name it: the path differs per install (a .deb
 * puts it in /opt, an AppImage is the image itself), and "run it yourself to
 * see the error" is useless without saying which `it`.
 */
export function daemonExecPath() {
  return process.env.WOLFFISH_EXEC || process.env.APPIMAGE || process.execPath
}

export async function startDaemon({ quiet = false } = {}) {
  // APPIMAGE before execPath, and it is not a preference. Under an AppImage
  // this process IS the image, mounted at a /tmp path that the runtime unmounts
  // the moment this process exits — and this child is meant to outlive it by
  // days. Spawning execPath would hand the daemon a filesystem scheduled for
  // demolition, which reads as the agent dying seconds after any command that
  // had to start it. Launching the .AppImage instead gives the daemon its own
  // mount, owned by its own process.
  const execPath = daemonExecPath()
  const args = []
  // Under ELECTRON_RUN_AS_NODE the binary is a plain node, so the app's own
  // entry has to be named. Unset it for the child: the daemon needs the real
  // Electron runtime (app.whenReady, the channels, the protocol handler).
  const env = { ...process.env, WOLFFISH_HEADLESS: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  args.push('--headless')
  // Chromium aborts as root unless this is on the command line — the check runs
  // before any of the app's own code, so the switch main appends at startup is
  // read too late. A VPS logs you in as root, which makes this the difference
  // between `wolffish` working there and dying with a FATAL nobody sees, since
  // the daemon is spawned detached with its output thrown away.
  args.push('--no-sandbox')

  // ASCII, not an ellipsis character. This is the earliest thing the CLI ever
  // prints — before ui.mjs is necessarily loaded, and on a console whose
  // codepage has not been established — and a lone U+2026 written straight to
  // stderr bypasses the transliteration chokepoint that keeps the rest safe.
  if (!quiet) process.stderr.write('Starting the Wolffish daemon...\n')
  const child = spawn(execPath, args, {
    detached: true,
    stdio: 'ignore',
    env
  })
  child.unref()

  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, BOOT_POLL_MS))
    const client = new DaemonClient()
    try {
      await client.connect()
      return client
    } catch {
      client.close()
    }
  }
  throw new Error('the daemon did not come up in time — check the logs with: wolffish service logs')
}

/**
 * Connect, starting the daemon if needed. `autostart: false` is for commands
 * that should report "not running" rather than silently launch one — `status`
 * and the service verbs.
 */
export async function connect({ autostart = true, quiet = false } = {}) {
  const client = new DaemonClient()
  try {
    await client.connect()
    return client
  } catch (err) {
    client.close()
    if (!autostart) throw err
    return startDaemon({ quiet })
  }
}
