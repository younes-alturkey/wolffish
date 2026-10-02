/**
 * The tunnel endpoint — the same class both apps run.
 *
 * Vendored identically into wolffish-app and wolffish-mobile. It deliberately
 * touches no platform API beyond `WebSocket` and `crypto.getRandomValues`,
 * both of which exist in Electron's main process and on Hermes, so the file
 * needs no adapter on either side. Filesystem work (file transfer) lives
 * outside this class for the same reason.
 *
 * Responsibilities: connect to the relay, run the Noise handshake, keep the
 * socket alive, reconnect with backoff, and carry RPC + events. Everything
 * handed to the socket is ciphertext; the relay sees opaque records.
 */
import {
  CloseCode,
  FrameType,
  KEEPALIVE_MS,
  KEEPALIVE_REQUEST,
  KEEPALIVE_RESPONSE,
  PEER_GONE,
  PEER_PRESENT,
  PROTOCOL_VERSION,
  RecordType,
  type EventTopic,
  type RpcMethod
} from './protocol'
import {
  CipherState,
  InitiatorIK,
  InitiatorXX,
  ResponderIK,
  ResponderXX,
  type Keypair
} from './noise'
import { fingerprint, toHex } from './pairing'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * How long to wait for the relay to accept a socket before giving up and
 * retrying. Generous enough for a slow mobile network to complete a TLS
 * handshake, short enough that a portal or a vanished network becomes a
 * retry rather than a permanent hang.
 */
const CONNECT_TIMEOUT_MS = 15_000

/** How often listeners hear about counter-only movement. Fast enough that a
 *  panel's numbers feel live; slow enough that a file transfer cannot turn
 *  state listeners into a per-frame workload. */
const COUNTER_NOTIFY_MS = 300

/**
 * Silence that means the socket is dead regardless of what the OS reports.
 *
 * Two and a half keepalive intervals: one answer may be lost to a blip
 * without tearing a working link down, but a genuinely half-open socket is
 * caught inside a minute rather than lasting until something else notices.
 *
 * The backstop, not the detector — see PING_ANSWER_MS.
 */
const LIVENESS_TIMEOUT_MS = KEEPALIVE_MS * 2.5

/**
 * How long the relay may take to answer a keepalive before its socket is
 * declared dead.
 *
 * A keepalive is a REQUEST and the relay answers it from the edge, without
 * waking anything — so silence after one is not slowness, it is a socket with
 * nothing behind it. Measuring the answer rather than the silence is what
 * makes this fast: LIVENESS_TIMEOUT_MS above dates from the last inbound
 * frame of ANY kind, so a link that died thirty seconds into a background is
 * still trusted for the best part of a minute after the app returns — a
 * connection that reads fine and answers nothing, which is the worst state
 * available.
 *
 * Generous on purpose. Ten seconds is an eternity for an edge-answered ping
 * and still leaves room for a phone whose JS thread is busy decrypting a file
 * chunk; a false positive costs one reconnect, which is under a second.
 */
const PING_ANSWER_MS = 10_000

/**
 * The same question asked on returning to the foreground, with a much shorter
 * fuse: the user is watching, and every path out of here is fast.
 */
const WAKE_ANSWER_MS = 2_500

/**
 * The second ask, after a first deadline passes in silence.
 *
 * One missed answer is not proof of death. Both runtimes can sit on a busy
 * thread long enough for a deadline to fire with its answer already queued
 * behind it — after a stall, expired timers run ahead of unprocessed socket
 * messages on Node and Hermes alike — and a phone decrypting a file chunk or
 * a desktop mid-run is exactly when that happens. Killing a healthy link on
 * that evidence is what turned a busy moment into a reconnect-and-resync in
 * the middle of active use. So the deadlines that guard a standing link ask
 * twice: a fresh keepalive on this short fuse, and only silence to BOTH is
 * fatal. A genuinely dead socket costs three extra seconds to catch — nothing
 * against a backstop of a minute — and a live one stops being executed for
 * the crime of being busy.
 */
const ANSWER_RETRY_MS = 3_000

/** Ceiling on the reconnect backoff when a caller names none. */
const MAX_BACKOFF_MS = 30_000

export type TunnelRole = 'host' | 'guest'
export type PairingMode = 'qr' | 'code'

export type TunnelStatus =
  | 'idle'
  | 'connecting'
  | 'waiting-for-peer'
  | 'handshaking'
  | 'connected'
  | 'reconnecting'
  | 'error'

/** What the Relay screen and the desktop Mobile panel render. */
export type TunnelState = {
  status: TunnelStatus
  /** Peer socket present on the relay (independent of a completed handshake). */
  peerPresent: boolean
  relayUrl: string
  /** Short forms only — never the full key material. */
  rendezvous: string | null
  ownKey: string | null
  peerKey: string | null
  /** Both sides show the same value when the session is genuinely shared. */
  session: string | null
  connectedAt: number | null
  lastError: string | null
  reconnects: number
  framesSent: number
  framesReceived: number
  bytesSent: number
  bytesReceived: number
}

export class TunnelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TunnelError'
  }
}

export class Disconnected extends TunnelError {
  constructor(reason: string) {
    super(`tunnel disconnected: ${reason}`)
    this.name = 'Disconnected'
  }
}

/** Handlers deal in already-parsed JSON; each side narrows its own params. */
type RpcHandler = (params: Record<string, unknown>) => Promise<unknown> | unknown
type EventHandler = (payload: unknown) => void
/** Relay-authored control frames (push plane), dispatched by their `type`. */
type ControlHandler = (frame: Record<string, unknown>) => void

export type TunnelOptions = {
  role: TunnelRole
  relayUrl: string
  rid: string
  staticKeypair: Keypair
  pairingSecret: Uint8Array
  /** Known for the QR route and for every reconnect; absent only while a typed
   * code pairs for the first time, which is what XXpsk3 is for. */
  peerStaticPublicKey?: Uint8Array | null
  /** Identity payload exchanged inside the handshake. */
  identity?: Record<string, unknown>
  /** Verbose channel logging, mirroring the desktop's other channels. */
  verbose?: boolean
  log?: (line: string) => void
  /** Reconnect automatically. The desktop parks and should; a phone reconnects
   * when it returns to the foreground. */
  autoReconnect?: boolean
  /**
   * How long to wait at the rendezvous for the other device, or null to wait
   * indefinitely.
   *
   * A host parks: the phone is away most of the day and that is the ordinary
   * state, not a failure. Timing out tears the socket down and backs off,
   * which empties the rendezvous exactly when the phone might arrive — both
   * sides then cycle independently and can keep missing each other. A guest
   * mid-pairing is the opposite case: the desktop is supposed to be there
   * right now, so a bounded wait is the honest answer.
   */
  peerWaitMs?: number | null
  /**
   * Ceiling on the exponential backoff between reconnect attempts.
   *
   * The default suits a desktop: it runs for days, nobody is watching it, and
   * a relay blip across a fleet must not become a stampede. A phone is the
   * opposite on every count — it only runs while it is on screen, with the
   * user looking at the very thing that will not connect — so it passes
   * something far shorter. Half a minute of waiting is indistinguishable from
   * broken to whoever is holding it.
   */
  maxBackoffMs?: number
}

export class Tunnel {
  private ws: WebSocket | null = null
  private sendCipher: CipherState | null = null
  private receiveCipher: CipherState | null = null
  private handshakeDone = false
  private handshakeInbox: ((message: Uint8Array) => void) | null = null
  private handshakeQueue: Uint8Array[] = []
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private counterFlushTimer: ReturnType<typeof setTimeout> | null = null
  /** Deadline for the answer to the keepalive that is currently outstanding. */
  private answerTimer: ReturnType<typeof setTimeout> | null = null
  /** When anything last arrived on this socket — the watchdog's evidence. */
  private lastInboundAt = 0
  /**
   * How many messages have arrived, ever. Counted rather than timed because
   * the answer deadline asks "did anything come back since I asked", and
   * millisecond timestamps cannot tell "nothing arrived" from "it arrived
   * within the same millisecond" — a distinction that decides whether a
   * healthy socket is torn down.
   */
  private inbound = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private rpcHandlers = new Map<string, RpcHandler>()
  private eventHandlers = new Map<string, EventHandler>()
  private controlHandlers = new Map<string, ControlHandler>()
  private stateListeners = new Set<(state: TunnelState) => void>()
  private nextRpcId = 1
  private stopped = false
  private attempt = 0
  /** Bumped by every cycle() so a superseded run can tell it has been. */
  private cycleGeneration = 0
  /**
   * Which handshake this tunnel is running, remembered from start().
   *
   * Every path that re-dials on its own — a scheduled retry, a wake probe, a
   * socket that stopped answering — used to hardcode 'qr'. That is right for
   * every connection a paired device ever makes, and wrong for exactly one:
   * the first run of a code pairing, which is XX precisely because there is no
   * pinned key yet. Re-dialling that as IK asks for a key nobody has, and the
   * pairing fails with "re-pair this device" rather than reconnecting.
   */
  private mode: PairingMode = 'qr'

  /** Learned during a code pairing; the caller persists it for later IK runs. */
  peerStaticPublicKey: Uint8Array | null

  private state: TunnelState

  constructor(private readonly options: TunnelOptions) {
    this.peerStaticPublicKey = options.peerStaticPublicKey ?? null
    this.state = {
      status: 'idle',
      peerPresent: false,
      relayUrl: options.relayUrl,
      rendezvous: fingerprint(options.rid),
      ownKey: fingerprint(toHex(options.staticKeypair.publicKey)),
      peerKey: this.peerStaticPublicKey ? fingerprint(toHex(this.peerStaticPublicKey)) : null,
      session: null,
      connectedAt: null,
      lastError: null,
      reconnects: 0,
      framesSent: 0,
      framesReceived: 0,
      bytesSent: 0,
      bytesReceived: 0
    }
  }

  // ------------------------------------------------------------------ state

  getState(): TunnelState {
    return { ...this.state }
  }

  onState(listener: (state: TunnelState) => void): () => void {
    this.stateListeners.add(listener)
    listener(this.getState())
    return () => this.stateListeners.delete(listener)
  }

  private patch(next: Partial<TunnelState>): void {
    this.state = { ...this.state, ...next }
    // A real transition flushes immediately and supersedes any pending
    // counter tick — its snapshot already carries the newest numbers.
    if (this.counterFlushTimer) {
      clearTimeout(this.counterFlushTimer)
      this.counterFlushTimer = null
    }
    this.notifyState()
  }

  /**
   * Counters only — no listener storm.
   *
   * The transfer path calls this once per frame, and notifying listeners at
   * frame rate is what melted the desktop: every tick re-ran channel state
   * handlers that log to disk, rewrite pairing.json and broadcast over IPC —
   * thousands of encrypt+write cycles that starved the event loop until RPCs
   * timed out. The phone read "connected", asked for a sync, and the answer
   * never came back in time. State stays exact; listeners hear about it at
   * most a few times a second.
   */
  private patchCounters(next: Partial<TunnelState>): void {
    this.state = { ...this.state, ...next }
    if (this.counterFlushTimer) return
    this.counterFlushTimer = setTimeout(() => {
      this.counterFlushTimer = null
      this.notifyState()
    }, COUNTER_NOTIFY_MS)
  }

  private notifyState(): void {
    const snapshot = this.getState()
    for (const listener of this.stateListeners) listener(snapshot)
  }

  private log(line: string): void {
    if (this.options.verbose) this.options.log?.(`[tunnel:${this.options.role}] ${line}`)
  }

  // -------------------------------------------------------------- lifecycle

  /** Connect and hand-shake, retrying until `stop()` when autoReconnect is on. */
  async start(mode: PairingMode = 'qr'): Promise<void> {
    this.stopped = false
    this.mode = mode
    // cycle() outlives the first connection now — it loops sessions on one
    // socket for as long as the link stays up — so awaiting it outright
    // resolves only when the connection DIES. Every caller that awaits
    // start() (pairing, the reconnect button) would hang precisely while
    // everything worked, holding its busy flag forever. Resolve at the first
    // settle instead: connected, the first scheduled retry, stop() — or
    // parked, for the caller that chose to park. A null peerWaitMs makes
    // waiting-for-peer the steady state, reached in seconds and held for as
    // long as the peer is away; a caller awaiting arrival there would hang
    // launch resume and busy flags for hours. Bounded waits keep the old
    // contract — their timeout turns parking into a settle soon enough.
    const settled = new Promise<void>((resolve) => {
      let done = false
      const unsubscribe = this.onState((state) => {
        if (done) return
        if (
          this.stopped ||
          state.status === 'connected' ||
          state.status === 'reconnecting' ||
          state.status === 'error' ||
          (state.status === 'waiting-for-peer' && this.options.peerWaitMs === null)
        ) {
          done = true
          // Deferred: onState replays synchronously inside subscription, so
          // unsubscribing here would mutate the listener set mid-iteration.
          queueMicrotask(unsubscribe)
          resolve()
        }
      })
    })
    void this.cycle(mode).catch(() => undefined)
    await settled
  }

  private async cycle(mode: PairingMode): Promise<void> {
    if (this.stopped) return
    // Which run of this loop is the live one. A cycle can be superseded while
    // it is parked deep inside a handshake nobody will answer — the wake probe
    // and retryNow both replace one mid-flight — and the stale run must not
    // report ITS failure afterwards: that patches a working tunnel back to
    // 'reconnecting' and tears down the socket its successor just built.
    const generation = ++this.cycleGeneration
    const current = (): boolean => this.cycleGeneration === generation && !this.stopped
    try {
      await this.openSocket()
      const socket = this.ws
      // One socket, many sessions. A peer that leaves and returns brings a
      // fresh handshake, so this loops back to listening for one rather than
      // ending the cycle — which would vacate the rendezvous and hand both
      // sides a window in which to miss each other. The guard is socket
      // identity: once this socket is replaced or closed, the loop is over.
      while (current() && this.ws === socket) {
        // Not `??`: null means park indefinitely and must reach waitForPeer
        // intact. Only an absent option falls back to the parameter's bounded
        // default.
        await this.waitForPeer(this.options.peerWaitMs)
        if (!current() || this.ws !== socket) return
        await this.performHandshake(mode)
        if (!current() || this.ws !== socket) return
        this.attempt = 0
        this.patch({ status: 'connected', connectedAt: Date.now(), lastError: null })
        this.log('connected')
        await this.waitForPeerGone()
        if (!current() || this.ws !== socket) return
        this.log('peer left — listening for its return')
      }
      return
    } catch (error) {
      // Superseded mid-flight: this run's failure is history, and announcing
      // it would knock its successor's live socket back into 'reconnecting'.
      if (!current()) return
      const message = error instanceof Error ? error.message : String(error)
      this.patch({
        status: this.options.autoReconnect ? 'reconnecting' : 'error',
        lastError: message
      })
      this.log(`cycle failed: ${message}`)
      this.teardownSocket()
      if (this.options.autoReconnect && !this.stopped) this.scheduleReconnect(mode)
      else throw error
    }
  }

  /** Exponential backoff with jitter — a relay blip must not become a stampede. */
  private scheduleReconnect(mode: PairingMode): void {
    if (this.reconnectTimer) return
    this.attempt += 1
    const ceiling = this.options.maxBackoffMs ?? MAX_BACKOFF_MS
    const base = Math.min(ceiling, 500 * 2 ** Math.min(this.attempt, 6))
    const delay = base / 2 + Math.random() * (base / 2)
    this.log(`reconnecting in ${Math.round(delay)}ms (attempt ${this.attempt})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.patch({ reconnects: this.state.reconnects + 1 })
      void this.cycle(mode)
    }, delay)
  }

  private openSocket(): Promise<void> {
    this.patch({ status: 'connecting' })
    const url = `${this.options.relayUrl}/t/${this.options.rid}?role=${this.options.role}`
    const socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'
    this.ws = socket

    return new Promise((resolve, reject) => {
      // A dial that neither opens nor errors is the ordinary shape of a
      // captive portal, or of a network that vanished mid-connect. Without a
      // deadline this promise never settles: the cycle never ends, no
      // reconnect is ever scheduled, and the link is dead with nothing left
      // running to revive it. Everything else here retries; this one hangs.
      const timer = setTimeout(() => {
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onError)
        try {
          socket.close()
        } catch {
          /* already gone */
        }
        reject(new TunnelError('the relay did not answer'))
      }, CONNECT_TIMEOUT_MS)
      const onOpen = (): void => {
        clearTimeout(timer)
        socket.removeEventListener('error', onError)
        this.attachSocket(socket)
        resolve()
      }
      const onError = (): void => {
        clearTimeout(timer)
        socket.removeEventListener('open', onOpen)
        reject(new TunnelError('could not reach the relay'))
      }
      socket.addEventListener('open', onOpen, { once: true })
      socket.addEventListener('error', onError, { once: true })
    })
  }

  private attachSocket(socket: WebSocket): void {
    // Every handler below is scoped to THIS socket and checks that it is
    // still the live one before touching shared state.
    //
    // Close events arrive asynchronously, so a socket torn down a moment ago
    // can deliver its close *after* its replacement is connected. Unguarded,
    // that stale handler forced the tunnel back to 'reconnecting' and queued
    // a cycle that dropped the healthy socket — a loop with no fixed point,
    // and the reason a phone could sit reconnecting forever with a desktop
    // sitting right there waiting for it.
    const isCurrent = (): boolean => this.ws === socket

    // A previous interval must never outlive its socket: it shares
    // lastInboundAt, so a leaked one can declare a healthy connection dead.
    this.stopKeepalive()

    socket.addEventListener('message', (event) => {
      if (!isCurrent()) return
      this.onMessage(event.data)
    })
    socket.addEventListener('close', (event) => {
      if (!isCurrent()) {
        this.log(`stale socket closed (${(event as CloseEvent).code}) — ignored`)
        return
      }
      this.log(`socket closed (${(event as CloseEvent).code})`)
      this.abortInFlight(`code ${(event as CloseEvent).code}`)
      this.handshakeDone = false
      this.sendCipher = null
      this.receiveCipher = null
      this.stopKeepalive()
      // Drop the reference first: it is what every guard reads, and what
      // tells the session loop below that this socket is finished.
      this.ws = null
      // Unblock anything parked on this socket, or the loop waits forever on
      // a peer that can no longer arrive.
      this.releaseWaiters()
      if (!this.stopped) {
        this.patch({ status: 'reconnecting', peerPresent: false, session: null })
        if (this.options.autoReconnect) this.scheduleReconnect(this.mode)
      }
    })
    this.lastInboundAt = Date.now()
    this.keepaliveTimer = setInterval(() => {
      if (!isCurrent()) return
      if (socket.readyState !== 1) return
      // A send-only keepalive proves nothing. Half-open sockets are the
      // normal result of a phone changing network — the OS still reports
      // OPEN while there is no longer anything on the other end, so frames
      // leave into nowhere and the app sits "connected" forever. Anything
      // inbound counts as proof of life; silence past a few intervals means
      // the pipe is gone and only a fresh socket will fix it.
      if (Date.now() - this.lastInboundAt > LIVENESS_TIMEOUT_MS) {
        this.log('relay stopped answering — reconnecting')
        this.dropAndDial('the relay stopped answering')
        return
      }
      socket.send(KEEPALIVE_REQUEST)
      // And hold it to an answer. The silence rule above is the backstop; on
      // its own it can take the best part of two minutes to fire, because the
      // window it measures started at the last frame rather than at this ping.
      // Two strikes, not one: nobody is waiting on this deadline, so the
      // seconds a retry costs are free, and a busy thread must not read as a
      // dead relay — see ANSWER_RETRY_MS.
      this.expectAnswer(socket, PING_ANSWER_MS, 'the relay did not answer its keepalive', true)
    }, KEEPALIVE_MS)
  }

  /**
   * Require something inbound within `withinMs` of now, or declare the socket
   * dead and dial a fresh one.
   *
   * Anything at all counts — the relay's `pong`, a presence notice, a frame
   * from the peer — because the question is whether the pipe still carries
   * bytes, not which bytes. One deadline is outstanding at a time: a later
   * call supersedes an earlier one, which is what lets the wake probe ask the
   * same question on a much shorter fuse.
   *
   * `retryOnce` makes the verdict two-strike: a first silence sends one more
   * keepalive on a short fuse instead of tearing down, and only silence to
   * both is fatal. The frames a stall left queued are processed before the
   * retry fuse burns, so a link that was merely busy answers for itself.
   */
  private expectAnswer(
    socket: WebSocket,
    withinMs: number,
    reason: string,
    retryOnce = false
  ): void {
    this.clearAnswerDeadline()
    const before = this.inbound
    this.answerTimer = setTimeout(() => {
      this.answerTimer = null
      if (this.stopped || this.ws !== socket) return
      if (this.inbound !== before) return
      if (retryOnce && socket.readyState === 1) {
        this.log(`${reason} — asking once more before giving up`)
        try {
          socket.send(KEEPALIVE_REQUEST)
        } catch {
          this.dropAndDial(reason)
          return
        }
        this.expectAnswer(socket, ANSWER_RETRY_MS, reason)
        return
      }
      this.log(`${reason} — reconnecting`)
      this.dropAndDial(reason)
    }, withinMs)
  }

  private clearAnswerDeadline(): void {
    if (this.answerTimer) clearTimeout(this.answerTimer)
    this.answerTimer = null
  }

  /**
   * This socket is known dead: replace it now rather than backing off.
   *
   * Backoff exists to space out attempts that FAILED. Nothing failed here —
   * a connection that was working stopped existing — so the ladder is reset
   * and the dial goes out immediately. If the network really is gone the dial
   * fails on its own terms and schedules a proper retry from there.
   */
  private dropAndDial(reason: string): void {
    if (this.stopped) return
    this.patch({ status: 'reconnecting', peerPresent: false, session: null, lastError: reason })
    this.teardownSocket()
    // Whatever the old cycle was parked on can never arrive now; released so
    // it unwinds instead of holding the socket it was waiting for.
    this.releaseWaiters()
    if (!this.options.autoReconnect) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.attempt = 0
    void this.cycle(this.mode)
  }

  private waitForPeer(timeoutMs: number | null = 60_000): Promise<void> {
    if (this.state.peerPresent) return Promise.resolve()
    this.patch({ status: 'waiting-for-peer' })
    return new Promise((resolve, reject) => {
      // null means park here: hold the socket and let the relay say when the
      // peer arrives. Keepalive keeps the connection healthy meanwhile.
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              this.peerWaiter = null
              reject(new TunnelError('the other device did not arrive'))
            }, timeoutMs)
      this.peerWaiter = () => {
        if (timer) clearTimeout(timer)
        this.peerWaiter = null
        resolve()
      }
    })
  }

  private peerWaiter: (() => void) | null = null
  private peerGoneWaiter: (() => void) | null = null

  /**
   * Resolves when the peer leaves, so the session loop can go back to
   * listening for its next handshake on the same socket.
   */
  private waitForPeerGone(): Promise<void> {
    if (!this.state.peerPresent) return Promise.resolve()
    return new Promise((resolve) => {
      this.peerGoneWaiter = () => {
        this.peerGoneWaiter = null
        resolve()
      }
    })
  }

  /** Unblock both parks — used when the socket underneath them is gone. */
  private releaseWaiters(): void {
    const waiting = this.peerWaiter
    const gone = this.peerGoneWaiter
    this.peerWaiter = null
    this.peerGoneWaiter = null
    waiting?.()
    gone?.()
  }

  stop(): void {
    this.stopped = true
    this.releaseWaiters()
    if (this.counterFlushTimer) clearTimeout(this.counterFlushTimer)
    this.counterFlushTimer = null
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.teardownSocket()
    this.patch({ status: 'idle', peerPresent: false, session: null, connectedAt: null })
  }

  private teardownSocket(): void {
    this.stopKeepalive()
    try {
      this.ws?.close(1000, 'done')
    } catch {
      /* already gone */
    }
    this.ws = null
    this.handshakeDone = false
    this.sendCipher = null
    this.receiveCipher = null
    this.handshakeQueue = []
    this.handshakeInbox = null
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer)
    this.keepaliveTimer = null
    // The outstanding answer belonged to the socket being retired; left armed
    // it would fire against its replacement's lastInboundAt.
    this.clearAnswerDeadline()
  }

  // -------------------------------------------------------------- handshake

  private async performHandshake(mode: PairingMode): Promise<void> {
    this.patch({ status: 'handshaking' })
    const identity = encoder.encode(
      JSON.stringify({ ...(this.options.identity ?? {}), proto: PROTOCOL_VERSION })
    )
    const psk = this.options.pairingSecret
    const s = this.options.staticKeypair

    // A code pairing runs XX only until both keys are pinned; every run after
    // that is IK, exactly like a QR pairing.
    const useXX = mode === 'code' && !this.peerStaticPublicKey

    if (this.options.role === 'guest') {
      if (useXX) {
        const initiator = new InitiatorXX({ staticKeypair: s, psk })
        const reply = this.expectHandshake()
        this.sendRecord(initiator.writeMessage1(identity), RecordType.HANDSHAKE)
        const incoming = initiator.readMessage2(await reply)
        const out = initiator.writeMessage3(identity)
        this.sendRecord(out.message, RecordType.HANDSHAKE)
        this.adoptSession(out.send, out.receive, out.handshakeHash, incoming.remoteStaticPublicKey)
      } else {
        const rs = this.peerStaticPublicKey
        if (!rs) throw new TunnelError('no pinned desktop key — re-pair this device')
        const initiator = new InitiatorIK({ staticKeypair: s, remoteStaticPublicKey: rs, psk })
        const reply = this.expectHandshake()
        this.sendRecord(initiator.writeMessage1(identity), RecordType.HANDSHAKE)
        const result = initiator.readMessage2(await reply)
        this.adoptSession(result.send, result.receive, result.handshakeHash, rs)
      }
      return
    }

    if (useXX) {
      const responder = new ResponderXX({ staticKeypair: s, psk })
      responder.readMessage1(await this.expectHandshake())
      const third = this.expectHandshake()
      this.sendRecord(responder.writeMessage2(identity), RecordType.HANDSHAKE)
      const result = responder.readMessage3(await third)
      this.adoptSession(
        result.send,
        result.receive,
        result.handshakeHash,
        result.remoteStaticPublicKey
      )
      return
    }

    const responder = new ResponderIK({ staticKeypair: s, psk })
    const incoming = responder.readMessage1(await this.expectHandshake())
    if (
      this.peerStaticPublicKey &&
      toHex(incoming.remoteStaticPublicKey) !== toHex(this.peerStaticPublicKey)
    ) {
      throw new TunnelError('the phone presented a different key than the one paired')
    }
    const out = responder.writeMessage2(identity)
    this.sendRecord(out.message, RecordType.HANDSHAKE)
    this.adoptSession(out.send, out.receive, out.handshakeHash, incoming.remoteStaticPublicKey)
  }

  private adoptSession(
    send: CipherState,
    receive: CipherState,
    handshakeHash: Uint8Array,
    peerKey: Uint8Array
  ): void {
    this.sendCipher = send
    this.receiveCipher = receive
    this.handshakeDone = true
    this.peerStaticPublicKey = peerKey
    this.patch({
      peerKey: fingerprint(toHex(peerKey)),
      session: fingerprint(toHex(handshakeHash))
    })
  }

  private expectHandshake(timeoutMs = 30_000): Promise<Uint8Array> {
    const queued = this.handshakeQueue.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      // Only ever clear the slot while it is still OURS — the same identity
      // guard the socket handlers use, and for the same reason.
      //
      // An abandoned handshake leaves its timeout armed: the cycle it belonged
      // to was replaced (a wake probe, a keepalive that went unanswered, a
      // retry), and nothing cancels a timer nobody is waiting on any more.
      // Half a minute later it used to fire and null whatever inbox it found —
      // by then, its SUCCESSOR's. The reply the successor was waiting for then
      // arrived to an empty slot, queued behind nobody, and that handshake hung
      // to its own timeout: thirty seconds of a reconnect that had already
      // reached the relay and had everything it needed.
      const inbox = (message: Uint8Array): void => {
        clearTimeout(timer)
        if (this.handshakeInbox === inbox) this.handshakeInbox = null
        resolve(message)
      }
      const timer = setTimeout(() => {
        if (this.handshakeInbox === inbox) this.handshakeInbox = null
        reject(new TunnelError('handshake timed out'))
      }, timeoutMs)
      this.handshakeInbox = inbox
    })
  }

  // ---------------------------------------------------------------- transport

  private onMessage(data: unknown): void {
    // Every inbound byte, of any kind, is the liveness signal the watchdog
    // reads — keepalive answers, relay notices and real frames alike.
    this.lastInboundAt = Date.now()
    this.inbound += 1
    if (typeof data === 'string') {
      if (data === KEEPALIVE_RESPONSE) return
      if (data === PEER_PRESENT) {
        this.patch({ peerPresent: true })
        this.log('peer present')
        this.peerWaiter?.()
      } else if (data === PEER_GONE) {
        // The session died with the peer. Saying 'connected' with nobody
        // there is the lie that makes the peer's return look like a fault —
        // it reads as a drop from connected back into handshaking, when it
        // is simply the reconnect this side never admitted it was waiting
        // for. Say waiting, and clear the keys the departed peer held: the
        // returning device always brings a new session anyway.
        const hadSession = this.handshakeDone
        this.handshakeDone = false
        this.sendCipher = null
        this.receiveCipher = null
        this.patch({
          peerPresent: false,
          session: null,
          status: this.stopped ? this.state.status : 'waiting-for-peer'
        })
        this.log('peer gone')
        // Our socket is fine, but anything in flight is going nowhere: the
        // relay drops frames with no peer to receive them.
        this.abortInFlight('peer gone')
        // Re-arm in place. A handshake is only *listened for* from inside
        // performHandshake, which returned when this session came up — so
        // without this the peer's next handshake queues with nobody to
        // answer it and the link never forms again. The session loop in
        // cycle() goes back to listening, and it does so WITHOUT dropping
        // the socket: leaving the rendezvous, even for the moment a
        // reconnect takes, is exactly when the other device arrives and
        // finds nobody home.
        if (hadSession) this.peerGoneWaiter?.()
      }
      return
    }

    const record = new Uint8Array(data as ArrayBuffer)
    this.patchCounters({
      framesReceived: this.state.framesReceived + 1,
      bytesReceived: this.state.bytesReceived + record.length
    })
    const kind = record[0]
    const body = record.subarray(1)

    if (kind === RecordType.CONTROL) {
      // Relay-authored plaintext JSON (push control plane) — valid with or
      // without a session, since it exists precisely for when the peer is
      // away. Malformed control frames cost themselves, never the socket.
      try {
        const frame = JSON.parse(decoder.decode(body)) as Record<string, unknown>
        if (frame && typeof frame.type === 'string') this.controlHandlers.get(frame.type)?.(frame)
      } catch {
        this.log('undecodable control frame — dropped')
      }
      return
    }

    if (kind === RecordType.TRANSPORT) {
      if (!this.handshakeDone || !this.receiveCipher) return // straggler from a past session
      let plaintext: Uint8Array
      try {
        plaintext = this.receiveCipher.decrypt(body)
      } catch {
        this.log('frame failed authentication — dropped')
        return
      }
      void this.onFrame(plaintext)
      return
    }

    if (kind !== RecordType.HANDSHAKE) return
    if (this.handshakeDone) {
      // A handshake record on a live session means the peer restarted — which
      // is what a returning device sends, often before this side has finished
      // tearing the old session down. Drop the stale keys and take it.
      //
      // This is also the ONLY warning some reconnections give. The relay
      // replaces a same-role socket without a peer-gone notice, so a phone
      // that comes back on a fresh socket leaves this side's peerPresent
      // untouched — no peer-gone, no close, just this record. Clearing the
      // keys and stopping there was the bug behind "connected, but every
      // request says not connected": the status still claimed connected, RPCs
      // were rejected for want of a session, and the loop stayed parked
      // waiting for a departure that had already happened without notice.
      // Say what is true and wake the loop so it listens for the handshake
      // queued just below.
      this.handshakeDone = false
      this.sendCipher = null
      this.receiveCipher = null
      this.log('peer restarted the session')
      if (!this.stopped) this.patch({ status: 'handshaking', session: null })
      this.peerGoneWaiter?.()
    }
    if (this.handshakeInbox) this.handshakeInbox(body)
    else this.handshakeQueue.push(body)
  }

  private sendRecord(payload: Uint8Array, kind: number): void {
    const socket = this.ws
    if (!socket || socket.readyState !== 1) throw new Disconnected('socket closed')
    const record = new Uint8Array(1 + payload.length)
    record[0] = kind
    record.set(payload, 1)
    socket.send(record)
    this.patchCounters({
      framesSent: this.state.framesSent + 1,
      bytesSent: this.state.bytesSent + record.length
    })
  }

  private sendFrame(type: number, message: unknown): void {
    if (!this.sendCipher) throw new Disconnected('no session')
    const body = encoder.encode(JSON.stringify(message ?? {}))
    const frame = new Uint8Array(1 + body.length)
    frame[0] = type
    frame.set(body, 1)
    this.sendRecord(this.sendCipher.encrypt(frame), RecordType.TRANSPORT)
  }

  private async onFrame(frame: Uint8Array): Promise<void> {
    const type = frame[0]
    const body = frame.subarray(1)
    const message = body.length ? JSON.parse(decoder.decode(body)) : {}

    switch (type) {
      case FrameType.RPC_REQ: {
        const handler = this.rpcHandlers.get(message.method)
        if (!handler) {
          this.sendFrame(FrameType.RPC_RES, {
            id: message.id,
            ok: false,
            error: `no handler for ${message.method}`
          })
          return
        }
        try {
          const result = await handler(message.params)
          this.sendFrame(FrameType.RPC_RES, { id: message.id, ok: true, result })
        } catch (error) {
          this.sendFrame(FrameType.RPC_RES, {
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })
        }
        return
      }
      case FrameType.RPC_RES: {
        const waiter = this.pending.get(message.id)
        if (!waiter) return
        this.pending.delete(message.id)
        if (message.ok) waiter.resolve(message.result)
        else waiter.reject(new TunnelError(message.error))
        return
      }
      case FrameType.EVENT: {
        this.eventHandlers.get(message.topic)?.(message.payload)
        this.eventHandlers.get('*')?.(message)
        return
      }
      default:
        this.log(`unhandled frame type 0x${type.toString(16)}`)
    }
  }

  private abortInFlight(reason: string): void {
    for (const { reject } of this.pending.values()) reject(new Disconnected(reason))
    this.pending.clear()
  }

  // ---------------------------------------------------------------- rpc/events

  onRpc(method: RpcMethod | string, handler: RpcHandler): void {
    this.rpcHandlers.set(method, handler)
  }

  onEvent(topic: EventTopic | '*', handler: EventHandler): void {
    this.eventHandlers.set(topic, handler)
  }

  /** Handle a relay-authored control frame of the given `type`. One handler
   *  per type, replaced on re-registration — same contract as onEvent. */
  onControl(type: string, handler: ControlHandler): void {
    this.controlHandlers.set(type, handler)
  }

  /**
   * Send a plaintext control frame TO THE RELAY (push registration, notify,
   * ack). Control frames deliberately skip the session cipher — the relay
   * must read them, and they must work while the peer is away — so nothing
   * that belongs to the sealed data plane may ever travel through here.
   * Requires only an open socket, not a completed handshake.
   */
  sendControl(frame: Record<string, unknown>): void {
    this.sendRecord(encoder.encode(JSON.stringify(frame)), RecordType.CONTROL)
  }

  rpc<T = unknown>(
    method: RpcMethod | string,
    params: unknown = {},
    timeoutMs = 30_000
  ): Promise<T> {
    if (!this.handshakeDone) return Promise.reject(new Disconnected('not connected'))
    const id = this.nextRpcId++
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new TunnelError(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
    })
    this.sendFrame(FrameType.RPC_REQ, { id, method, params })
    return promise
  }

  emit(topic: EventTopic | string, payload: unknown): void {
    if (!this.handshakeDone) return // presence, not delivery: acks own that
    this.sendFrame(FrameType.EVENT, { topic, payload })
  }

  get connected(): boolean {
    return this.handshakeDone && this.state.peerPresent
  }

  /**
   * Bytes handed to the socket but not yet flushed out of this process — the
   * local hop only. The relay forwards frames fire-and-forget, so whatever it
   * is holding for a slow peer is invisible from here; a caller pacing its
   * own sends must treat zero as "my uplink is clear", never "the peer has
   * caught up". Zero whenever no socket is up.
   */
  get outboundBufferedBytes(): number {
    return this.ws?.bufferedAmount ?? 0
  }

  /**
   * Is this tunnel still working on staying up?
   *
   * True while connected, while a retry is queued, and while a dial or
   * handshake is in flight — including parked at the rendezvous waiting for
   * the other device, which is the normal resting state, not a fault. False
   * means nothing is going to happen without help, and the caller should
   * build a new one rather than trust this object to recover.
   */
  get alive(): boolean {
    if (this.stopped) return false
    if (this.connected || this.reconnectTimer !== null) return true
    return (
      this.state.status === 'connecting' ||
      this.state.status === 'handshaking' ||
      this.state.status === 'waiting-for-peer'
    )
  }

  /**
   * Stop waiting out the backoff and try now. Returning to the app is new
   * information — the user is here and the network usually just came back —
   * and sitting through the remaining 30 seconds of a doubling delay is the
   * difference between "instant" and "broken" to whoever is looking at it.
   *
   * Only acts on a queued retry, so it can never start a second cycle
   * alongside one already running.
   */
  retryNow(): void {
    if (this.stopped || this.reconnectTimer === null) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.attempt = 0
    this.log('retrying now')
    void this.cycle(this.mode)
  }

  /**
   * The app came back. Find out whether this link survived, rather than
   * assuming either way, and take the shortest route to connected.
   *
   * The assumption is what made returning slow. iOS suspends JS mid-flight, so
   * the socket is torn down by the OS with nobody left running to notice:
   * `readyState` still says OPEN, the state still says connected, and the
   * first thing anyone learns is an RPC that never answers. The keepalive
   * eventually catches it, but "eventually" is one interval plus a timeout
   * window that started before the app went away — the ten-odd seconds of
   * nothing that a return sometimes costs.
   *
   * So: skip a queued backoff (the user being here is evidence the network is
   * back), replace a tunnel that is not working on anything, and hold an open
   * socket to a fast answer. All three are cheap and none of them wait.
   *
   * `patient` widens the probe's verdict to two strikes (see ANSWER_RETRY_MS)
   * for the callers nobody is watching — a network-type flap, an RPC that
   * failed. Those fire in the middle of active use, where a busy thread can
   * miss one fuse and a false kill costs a visible reconnect-and-resync. The
   * foreground return stays one-strike: the user is looking at the screen,
   * and the socket in question is the one iOS habitually kills — grace there
   * would mostly be spent waiting on a zombie.
   */
  refresh(patient = false): void {
    if (this.stopped) return
    // A retry queued behind a backoff: the wait is now pointless.
    if (this.reconnectTimer !== null) {
      this.retryNow()
      return
    }
    const socket = this.ws
    if (!socket || socket.readyState !== 1) {
      // A dial or handshake genuinely in flight is left to finish — it is
      // already the fastest thing available. Anything else has no socket and
      // nothing queued, which is a tunnel that will never recover by itself.
      if (this.state.status === 'connecting' || this.state.status === 'handshaking') return
      this.dropAndDial('woke with no live socket')
      return
    }
    try {
      socket.send(KEEPALIVE_REQUEST)
    } catch {
      this.dropAndDial('the socket refused a keepalive')
      return
    }
    this.expectAnswer(socket, WAKE_ANSWER_MS, 'no answer to the wake probe', patient)
  }
}

export { Event, Rpc } from './protocol'
export { CloseCode }
