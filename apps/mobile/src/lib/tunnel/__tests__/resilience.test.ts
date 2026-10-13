import { Tunnel } from '@/lib/tunnel/tunnel'
import { generateKeypair } from '@/lib/tunnel/noise'

/**
 * Staying connected, which is a different problem from getting connected.
 *
 * Every case here is one where the link is gone but nothing says so: a dial
 * that never resolves, a socket the OS still calls OPEN with nothing behind
 * it, a tunnel object that stopped trying. They share a symptom — the app
 * looks connected, or looks like it is about to be, forever — and none of
 * them recover on their own. What is asserted is not that a connection
 * succeeds, but that failure always leaves something scheduled to try again.
 */

type Listener = (event: unknown) => void

class FakeSocket {
  static last: FakeSocket | null = null
  readyState = 0
  binaryType = ''
  sent: unknown[] = []
  closed = false
  private listeners = new Map<string, Listener[]>()

  constructor(public url: string) {
    FakeSocket.last = this
  }

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== fn)
    )
  }

  send(data: unknown): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.readyState = 3
  }

  emit(type: string, event: unknown = {}): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event)
  }

  /** Complete the connection the way a real relay would. */
  open(): void {
    this.readyState = 1
    this.emit('open')
  }
}

const globals = globalThis as unknown as { WebSocket: unknown }
const realWebSocket = globals.WebSocket

function makeTunnel(over: Partial<ConstructorParameters<typeof Tunnel>[0]> = {}): Tunnel {
  return new Tunnel({
    role: 'guest',
    relayUrl: 'wss://relay.test',
    rid: 'a'.repeat(64),
    staticKeypair: generateKeypair(),
    pairingSecret: new Uint8Array(32),
    peerStaticPublicKey: null,
    autoReconnect: true,
    peerWaitMs: null,
    ...over
  })
}

/** Let a chain of awaits inside the tunnel settle. */
async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
}

beforeEach(() => {
  jest.useFakeTimers()
  FakeSocket.last = null
  globals.WebSocket = FakeSocket
})

afterEach(() => {
  jest.clearAllTimers()
  jest.useRealTimers()
  globals.WebSocket = realWebSocket
})

describe('a dial that never answers', () => {
  it('gives up and schedules another attempt instead of hanging forever', () => {
    const tunnel = makeTunnel()
    void tunnel.start()
    const first = FakeSocket.last
    expect(first).not.toBeNull()

    // Neither 'open' nor 'error' ever fires — a captive portal, or a network
    // that disappeared mid-connect. Before the deadline existed this promise
    // never settled and nothing was left running to retry.
    jest.advanceTimersByTime(20_000)

    expect(first?.closed).toBe(true)
    expect(tunnel.alive).toBe(true)
  })
})

describe('a socket that stops answering', () => {
  it('tears down and retries rather than trusting readyState', () => {
    const tunnel = makeTunnel()
    void tunnel.start()
    const socket = FakeSocket.last
    socket?.open()

    // The OS still reports OPEN — the usual half-open socket after a network
    // change — so the keepalive keeps writing into nothing.
    jest.advanceTimersByTime(30_000)
    expect(socket?.sent.length).toBeGreaterThan(0)

    // Past the liveness window with nothing inbound, the link is declared
    // dead and replaced. Without this the app sits "connected" indefinitely.
    jest.advanceTimersByTime(60_000)
    expect(socket?.closed).toBe(true)
    expect(tunnel.alive).toBe(true)
  })

  it('keeps a working link alive when answers keep arriving', () => {
    const tunnel = makeTunnel()
    void tunnel.start()
    const socket = FakeSocket.last
    socket?.open()

    // A reply on every interval: the watchdog must never fire on a healthy
    // connection, or it would sever exactly the links it exists to protect.
    for (let i = 0; i < 10; i += 1) {
      jest.advanceTimersByTime(25_000)
      socket?.emit('message', { data: 'pong' })
    }

    expect(socket?.closed).toBe(false)
  })
})

describe('a keepalive that goes unanswered', () => {
  /**
   * The silence rule alone dates its window from the last inbound frame of any
   * kind, so how fast it fires depends on when the link happened to die — a
   * socket lost thirty seconds into a background is still trusted for the best
   * part of a minute after the app comes back. Holding each ping to an answer
   * makes detection depend on nothing but the ping.
   *
   * The verdict is two-strike: one silence earns a second ping on a short
   * fuse, and only silence to both is fatal. A busy thread can sit on a
   * deadline long enough for it to fire with the answer already queued behind
   * it, and one missed fuse must not execute a healthy link mid-use.
   */
  it('is fatal well before the silence window would have fired', () => {
    const tunnel = makeTunnel()
    void tunnel.start()
    const socket = FakeSocket.last
    socket?.open()

    // First keepalive goes out at 25s; nothing ever comes back.
    jest.advanceTimersByTime(25_000)
    expect(socket?.sent.filter((data) => data === 'ping').length).toBe(1)
    expect(socket?.closed).toBe(false)

    // The first deadline passes in silence: not fatal yet — one more ping
    // goes out on a short fuse instead.
    jest.advanceTimersByTime(10_500)
    expect(socket?.sent.filter((data) => data === 'ping').length).toBe(2)
    expect(socket?.closed).toBe(false)

    // Silence to the second ask is the verdict — and the whole judgement
    // still lands long before the 62.5s of silence the backstop waits for.
    jest.advanceTimersByTime(3_000)
    expect(socket?.closed).toBe(true)
    expect(FakeSocket.last).not.toBe(socket)
  })

  it('accepts any inbound frame as the answer, not just a pong', () => {
    const tunnel = makeTunnel()
    void tunnel.start()
    const socket = FakeSocket.last
    socket?.open()

    jest.advanceTimersByTime(25_000)
    // A peer notice is proof the pipe carries bytes, which is the whole
    // question. Anything that reaches us counts.
    socket?.emit('message', { data: 'peer-present' })
    jest.advanceTimersByTime(13_500)

    expect(socket?.closed).toBe(false)
    expect(tunnel.alive).toBe(true)
  })

  it('keeps a link whose answer arrives late, inside the second ask', () => {
    const tunnel = makeTunnel()
    void tunnel.start()
    const socket = FakeSocket.last
    socket?.open()

    // The stall scenario: the deadline fires before the queued answer is
    // processed. The retry fuse is exactly the window in which those queued
    // frames run.
    jest.advanceTimersByTime(25_000)
    jest.advanceTimersByTime(10_500)
    expect(socket?.sent.filter((data) => data === 'ping').length).toBe(2)
    socket?.emit('message', { data: 'pong' })
    jest.advanceTimersByTime(3_000)

    // The link was merely busy, and it stays exactly where it was.
    expect(socket?.closed).toBe(false)
    expect(FakeSocket.last).toBe(socket)
  })
})

describe('refresh — the app coming back', () => {
  /**
   * The ten seconds of nothing this whole path exists to remove.
   *
   * iOS suspends JS mid-flight and the OS drops the socket with nobody left
   * running to notice, so a returning app finds `readyState` still OPEN, the
   * state still 'connected', and no timer close enough to catch it. Probing
   * turns "wait for a watchdog whose window started before the background"
   * into one round trip.
   */
  it('replaces a socket that no longer answers, in seconds', async () => {
    const tunnel = makeTunnel()
    void tunnel.start()
    const socket = FakeSocket.last
    socket?.open()
    await flush()

    tunnel.refresh()
    // The probe goes out immediately...
    expect(socket?.sent.filter((data) => data === 'ping').length).toBe(1)
    expect(socket?.closed).toBe(false)

    // ...and the socket has a couple of seconds to prove itself.
    jest.advanceTimersByTime(3_000)
    expect(socket?.closed).toBe(true)
    expect(FakeSocket.last).not.toBe(socket)
    expect(tunnel.alive).toBe(true)
  })

  it('leaves a socket that answers exactly where it was', async () => {
    const tunnel = makeTunnel()
    void tunnel.start()
    const socket = FakeSocket.last
    socket?.open()
    await flush()

    tunnel.refresh()
    socket?.emit('message', { data: 'pong' })
    jest.advanceTimersByTime(3_000)

    // Nothing torn down, nothing redialled: the link was fine and a needless
    // reconnect would cost a handshake for no reason.
    expect(socket?.closed).toBe(false)
    expect(FakeSocket.last).toBe(socket)
  })

  /**
   * The patient probe — what a network-type flap or a failed RPC runs. Those
   * fire mid-use with nobody watching a card, so one missed fuse asks again
   * rather than executing a socket that may only have been busy; the urgent
   * foreground probe above keeps its one-strike speed.
   */
  it('asks twice before replacing when told to be patient', async () => {
    const tunnel = makeTunnel()
    void tunnel.start()
    const socket = FakeSocket.last
    socket?.open()
    await flush()

    tunnel.refresh(true)
    expect(socket?.sent.filter((data) => data === 'ping').length).toBe(1)

    // First fuse burns in silence: a second ask, not a teardown.
    jest.advanceTimersByTime(3_000)
    expect(socket?.sent.filter((data) => data === 'ping').length).toBe(2)
    expect(socket?.closed).toBe(false)

    // An answer inside the second fuse keeps the link exactly where it was.
    socket?.emit('message', { data: 'pong' })
    jest.advanceTimersByTime(3_000)
    expect(socket?.closed).toBe(false)
    expect(FakeSocket.last).toBe(socket)
  })

  it('still replaces a patient probe answered by nothing at all', async () => {
    const tunnel = makeTunnel()
    void tunnel.start()
    const socket = FakeSocket.last
    socket?.open()
    await flush()

    tunnel.refresh(true)
    jest.advanceTimersByTime(3_000)
    jest.advanceTimersByTime(3_000)

    // Silence to both asks is a dead pipe, patience or not.
    expect(socket?.closed).toBe(true)
    expect(FakeSocket.last).not.toBe(socket)
  })

  it('skips a queued backoff rather than probing nothing', async () => {
    const tunnel = makeTunnel()
    void tunnel.start()
    const first = FakeSocket.last
    first?.emit('error', {})
    await flush()

    tunnel.refresh()

    expect(FakeSocket.last).not.toBe(first)
  })

  it('does nothing to a dial still in flight', () => {
    const tunnel = makeTunnel()
    void tunnel.start()
    const first = FakeSocket.last

    // Mid-dial is already the fastest thing available; restarting it would
    // throw away the connection about to complete.
    tunnel.refresh()

    expect(FakeSocket.last).toBe(first)
    expect(first?.closed).toBe(false)
  })

  it('stays quiet once stopped', () => {
    const tunnel = makeTunnel()
    void tunnel.start()
    FakeSocket.last?.open()
    tunnel.stop()
    const socket = FakeSocket.last

    tunnel.refresh()
    jest.advanceTimersByTime(10_000)

    expect(FakeSocket.last).toBe(socket)
    expect(tunnel.alive).toBe(false)
  })
})

describe('backoff', () => {
  /**
   * The ceiling is the caller's to set because the two callers are opposites:
   * a desktop retries unattended for days and must not stampede a relay, while
   * a phone only runs with someone looking at the card that says it is not
   * connected. Half a minute of that is indistinguishable from broken.
   */
  it('honours a caller-supplied ceiling', async () => {
    const tunnel = makeTunnel({ maxBackoffMs: 8_000 })
    void tunnel.start()

    // Six consecutive failures is where the default ladder tops out at 30s.
    for (let round = 0; round < 6; round += 1) {
      FakeSocket.last?.emit('error', {})
      await flush()
      jest.advanceTimersByTime(8_000)
      await flush()
    }

    // Still retrying, and each wait stayed inside the ceiling — a 15-30s one
    // would have left the last few rounds with no dial at all.
    expect(tunnel.getState().reconnects).toBeGreaterThanOrEqual(5)
  })
})

describe('a side parked at the rendezvous', () => {
  /**
   * peerWaitMs: null is the parked host's contract: sit at the rendezvous for
   * as long as it takes, because the phone being away is the ordinary state,
   * not a failure. A `??` at the call site quietly turned null into a minute —
   * the host then cycled (wait, throw, tear down, back off) and was absent
   * from the rendezvous during every backoff gap, which is exactly when the
   * phone tends to arrive. This pins the contract: past the old one-minute
   * mark the same socket is still open, still waiting, still keeping alive.
   */
  it('outlasts the old 60s default on one socket when peerWaitMs is null', async () => {
    const tunnel = makeTunnel()
    void tunnel.start()
    const socket = FakeSocket.last
    socket?.open()
    for (let i = 0; i < 4; i += 1) await Promise.resolve()
    expect(tunnel.getState().status).toBe('waiting-for-peer')

    // 150 parked seconds, answering every keepalive. The flushes matter: the
    // old timeout rejected into a microtask, so a synchronous advance never
    // saw the teardown it caused.
    for (let round = 0; round < 6; round += 1) {
      jest.advanceTimersByTime(25_000)
      socket?.emit('message', { data: 'pong' })
      for (let i = 0; i < 6; i += 1) await Promise.resolve()
    }

    // Same socket, never closed, no replacement dialled — and the keepalive
    // kept proving the wait alive the whole time.
    expect(socket?.closed).toBe(false)
    expect(FakeSocket.last).toBe(socket)
    expect(tunnel.getState().status).toBe('waiting-for-peer')
    expect(socket?.sent.filter((data) => data === 'ping').length).toBeGreaterThanOrEqual(6)
  })

  /**
   * Parking is a settled outcome, not a pending one. Reaching the rendezvous
   * IS this tunnel's steady state — the peer may be hours away — so a caller
   * awaiting start() must get its answer here. Before this settled, launch
   * resume and the reconnect button's busy flag hung for as long as the
   * desktop stayed asleep.
   */
  it('start() resolves once parked, not when the peer eventually arrives', async () => {
    const tunnel = makeTunnel()
    let resolved = false
    const started = tunnel.start().then(() => {
      resolved = true
    })

    FakeSocket.last?.open()
    for (let i = 0; i < 8; i += 1) await Promise.resolve()

    expect(tunnel.getState().status).toBe('waiting-for-peer')
    expect(resolved).toBe(true)
    await started
    expect(tunnel.alive).toBe(true)
  })
})

describe('alive', () => {
  it('is false once stopped, so a caller knows to build a new one', () => {
    const tunnel = makeTunnel()
    void tunnel.start()
    FakeSocket.last?.open()
    expect(tunnel.alive).toBe(true)

    tunnel.stop()
    expect(tunnel.alive).toBe(false)
  })
})

describe('retryNow', () => {
  it('does nothing when no retry is queued, so it cannot start a second cycle', () => {
    const tunnel = makeTunnel()
    void tunnel.start()
    const socket = FakeSocket.last
    socket?.open()

    tunnel.retryNow()

    // Same socket, no second dial.
    expect(FakeSocket.last).toBe(socket)
  })

  it('skips the remaining backoff when one is queued', async () => {
    const tunnel = makeTunnel()
    void tunnel.start()
    const first = FakeSocket.last
    first?.emit('error', {})
    // The rejection reaches the cycle's catch — and so schedules the retry —
    // a few microtasks later; without this the assertion races it.
    for (let i = 0; i < 6; i += 1) await Promise.resolve()

    // A retry is now pending behind a delay. Foregrounding should not wait
    // it out — the user is here and the network probably just came back.
    tunnel.retryNow()

    expect(FakeSocket.last).not.toBe(first)
  })
})

describe('a socket that was replaced', () => {
  /**
   * The loop with no fixed point. Close events arrive asynchronously, so a
   * socket torn down a moment ago delivers its close *after* the replacement
   * is already live. Unguarded, that stale handler forced the tunnel back to
   * reconnecting and queued a cycle that dropped the healthy socket — which
   * is a phone stuck reconnecting while the desktop sits there waiting.
   */
  it('cannot knock the live connection back into reconnecting', async () => {
    const tunnel = makeTunnel()
    void tunnel.start()
    const first = FakeSocket.last
    first?.emit('error', {})
    for (let i = 0; i < 6; i += 1) await Promise.resolve()

    tunnel.retryNow()
    const second = FakeSocket.last
    expect(second).not.toBe(first)
    second?.open()
    for (let i = 0; i < 4; i += 1) await Promise.resolve()

    // The replaced socket finally reports its close, late.
    first?.emit('close', { code: 1006 })

    // The live socket is untouched and no replacement was dialled.
    expect(second?.closed).toBe(false)
    expect(FakeSocket.last).toBe(second)
  })

  it('ignores late frames from a replaced socket', async () => {
    const tunnel = makeTunnel()
    void tunnel.start()
    const first = FakeSocket.last
    first?.emit('error', {})
    for (let i = 0; i < 6; i += 1) await Promise.resolve()
    tunnel.retryNow()
    const second = FakeSocket.last
    second?.open()

    // A frame from the dead socket must not be mistaken for proof that the
    // live one is healthy, nor mutate the session it does not belong to.
    expect(() => first?.emit('message', { data: 'peer-present' })).not.toThrow()
    expect(FakeSocket.last).toBe(second)
  })

  it('runs one keepalive at a time, however many sockets came before', async () => {
    const tunnel = makeTunnel()
    void tunnel.start()
    const first = FakeSocket.last
    first?.open()
    first?.emit('close', { code: 1006 })
    for (let i = 0; i < 6; i += 1) await Promise.resolve()

    jest.advanceTimersByTime(1_000)
    const second = FakeSocket.last
    expect(second).not.toBe(first)
    second?.open()

    // Only the live socket may be pinged. A leaked interval from the first
    // one shares lastInboundAt and would eventually declare this one dead.
    const before = first?.sent.length ?? 0
    jest.advanceTimersByTime(26_000)
    expect(first?.sent.length).toBe(before)
    expect(second!.sent.length).toBeGreaterThan(0)
  })
})

describe('a peer that reconnects without a peer-gone notice', () => {
  /**
   * The relay replaces a same-role socket without announcing a departure, so
   * a returning phone gives this side nothing but a handshake record on what
   * it still believes is a live session. Left unhandled that produced the
   * worst pairing of states available: a status reading "connected" while
   * every request was rejected for having no session, and a session loop
   * parked waiting for a departure that had already happened in silence.
   */
  it('never advertises a link it would refuse to use', async () => {
    const tunnel = makeTunnel()
    let status: string | null = null
    tunnel.onState((state) => {
      status = state.status
      // The invariant, checked on every single transition rather than once at
      // the end: a tunnel may not read "connected" while rejecting requests
      // for having no session. That pairing is what the user saw as
      // "connected, but sync says it cannot reach your desktop".
      if (state.status === 'connected') expect(tunnel.connected).toBe(true)
    })

    void tunnel.start()
    const socket = FakeSocket.last
    socket?.open()
    for (let i = 0; i < 4; i += 1) await Promise.resolve()
    socket?.emit('message', { data: 'peer-present' })
    for (let i = 0; i < 6; i += 1) await Promise.resolve()

    expect(status).not.toBeNull()
    // And it is still working on it, rather than wedged.
    expect(tunnel.alive).toBe(true)
  })
})

describe('start()', () => {
  /**
   * The session loop keeps cycle() running for as long as the link is up, so
   * awaiting it outright resolves only when the connection dies. Every caller
   * that awaits start() — pairing, the reconnect button — held its busy flag
   * for exactly as long as everything worked: buttons disabled, status
   * connected, nothing pressable. start() must resolve at the first settle.
   */
  it('resolves on the first scheduled retry rather than blocking', async () => {
    const tunnel = makeTunnel()
    let resolved = false
    const started = tunnel.start().then(() => {
      resolved = true
    })

    FakeSocket.last?.emit('error', {})
    for (let i = 0; i < 8; i += 1) await Promise.resolve()

    expect(resolved).toBe(true)
    await started
    // And the retry it settled on is still queued — early resolution must
    // not have cost the reconnect.
    expect(tunnel.alive).toBe(true)
  })

  it('resolves when stopped mid-dial, so no caller hangs on a cancel', async () => {
    const tunnel = makeTunnel()
    const started = tunnel.start()
    tunnel.stop()
    await expect(started).resolves.toBeUndefined()
  })
})
