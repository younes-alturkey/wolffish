import i18n from '@/lib/i18n'
import * as SecureStore from 'expo-secure-store'
import { DEFAULT_RELAY_URL, Rpc, type PairingPayload } from '@/lib/tunnel/protocol'
import { generateKeypair, type Keypair } from '@/lib/tunnel/noise'
import {
  decodePairingPayload,
  fromBase64Url,
  fromHex,
  rendezvousId,
  secretFromCode,
  toBase64Url,
  toHex
} from '@/lib/tunnel/pairing'
import { Tunnel, type TunnelState } from '@/lib/tunnel/tunnel'
import {
  attachNotificationHandlers,
  getPhoneId,
  refreshPushRegistration
} from '@/lib/notifications/push'
import * as Device from 'expo-device'
import Constants from 'expo-constants'
import { Platform } from 'react-native'

/**
 * The phone's single tunnel to the paired desktop.
 *
 * One instance for the app's lifetime: pairing writes keys to the OS keystore,
 * and every later launch restores them and reconnects without asking the user
 * anything. The phone is the `guest` — it dials in when the app is in the
 * foreground and vanishes when iOS suspends it, so every return re-handshakes
 * with fresh session keys. That is normal, not an error, and the reconnect
 * loop in Tunnel treats it that way.
 *
 * Nothing here touches conversations or config: this module owns the
 * connection, `lib/sync` owns what travels over it.
 */

/** Keystore keys. Small values only — SecureStore rejects large payloads. */
/** How long a pairing attempt waits for the desktop before failing. Long
 *  enough to cover a slow relay, short enough that a mistyped code is not a
 *  minute of silence. Only pairing is bounded — see connect(). */
const PAIRING_PEER_WAIT_MS = 45_000

const KEY_IDENTITY = 'wolffish.tunnel.identity'
const KEY_PAIRING = 'wolffish.tunnel.pairing'

/**
 * Ceiling on this device's reconnect backoff — far below the transport's own
 * default, which is written for a desktop that runs unattended for days.
 *
 * The phone only runs while it is on screen. Every second of backoff is a
 * second someone spends looking at a card that says "reconnecting" and doing
 * nothing about it, and one phone retrying cannot stampede anything.
 */
const PHONE_MAX_BACKOFF_MS = 8_000

export type StoredPairing = {
  /** Base64url — the shared secret the rendezvous ID derives from. */
  secret: string
  /** The desktop's static public key, hex. Known from the QR, or learned
   * during a code pairing's XX handshake and pinned then. */
  peerPublicKey: string | null
  relayUrl: string
  method: 'qr' | 'code'
  pairedAt: number
}

type StoredIdentity = { privateKey: string; publicKey: string }

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await SecureStore.getItemAsync(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  await SecureStore.setItemAsync(key, JSON.stringify(value), {
    // The tunnel reconnects on foreground, so the keys only need to be
    // readable while the device is unlocked.
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
  })
}

/** This device's long-lived keypair, minted on first use. */
export async function loadIdentity(): Promise<Keypair> {
  const stored = await readJson<StoredIdentity>(KEY_IDENTITY)
  if (stored) {
    return {
      privateKey: fromBase64Url(stored.privateKey),
      publicKey: fromBase64Url(stored.publicKey)
    }
  }
  const keypair = generateKeypair()
  await writeJson(KEY_IDENTITY, {
    privateKey: toBase64Url(keypair.privateKey),
    publicKey: toBase64Url(keypair.publicKey)
  })
  return keypair
}

export async function loadPairing(): Promise<StoredPairing | null> {
  return readJson<StoredPairing>(KEY_PAIRING)
}

export async function savePairing(pairing: StoredPairing): Promise<void> {
  await writeJson(KEY_PAIRING, pairing)
}

/**
 * Forget the desktop. The device identity survives, so re-pairing with the
 * same or a different desktop is a scan away — and demo mode is reachable
 * again the moment this returns.
 */
export async function forgetPairing(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_PAIRING).catch(() => undefined)
}

export type ConnectionListener = (state: TunnelState) => void

class TunnelClient {
  private tunnel: Tunnel | null = null
  private listeners = new Set<ConnectionListener>()
  private lastState: TunnelState | null = null
  /**
   * The connect() currently building a tunnel, so two callers cannot each
   * build one. Both keystore reads inside connect() are awaits, and every
   * caller here is fire-and-forget — launch, foreground, an RPC that failed —
   * so overlapping calls are ordinary rather than exceptional. Unguarded, the
   * second one stops the first's socket a moment after it opened, which
   * spends the head start the early dial exists to buy.
   */
  private connecting: Promise<void> | null = null
  /** Bumped by every connect(), so one superseded mid-await knows to stand
   *  down instead of stopping the tunnel that replaced it. */
  private generation = 0

  get state(): TunnelState | null {
    return this.lastState
  }

  get connected(): boolean {
    return this.tunnel?.connected ?? false
  }

  /** The live tunnel, for `lib/sync` to issue RPCs and subscribe to events. */
  get active(): Tunnel | null {
    return this.tunnel
  }

  /**
   * An RPC failed in a way that means the session is gone, not that the
   * desktop said no. Kick the tunnel rather than leaving the user to press a
   * button that will fail the same way — a stale session cannot recover by
   * being asked again over the same dead keys.
   */
  reportRpcFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    if (!/not connected|timed out|socket closed|peer gone/i.test(message)) return
    if (this.tunnel?.connected) return
    // refresh() rather than retryNow(): the tunnel may have no retry queued at
    // all — an open socket with a dead session behind it answers nothing and
    // schedules nothing, which is precisely the state a failing RPC reports.
    // Patient: nobody is watching this probe, and the thread that just timed
    // an RPC out may simply be busy — a false kill here costs a visible
    // reconnect for nothing.
    this.tunnel?.refresh(true)
  }

  subscribe(listener: ConnectionListener): () => void {
    this.listeners.add(listener)
    if (this.lastState) listener(this.lastState)
    return () => this.listeners.delete(listener)
  }

  private publish(state: TunnelState): void {
    this.lastState = state
    for (const listener of this.listeners) listener(state)
  }

  /**
   * Pair from a scanned QR. The payload carries the desktop's public key, so
   * this is IKpsk2 — one round trip and the desktop is already waiting.
   */
  async pairWithQr(scanned: string): Promise<void> {
    const payload = decodePairingPayload(scanned)
    await this.pairWith(payload, 'qr')
  }

  /**
   * Pair from a typed code. The code carries only the secret, so the first
   * handshake is XXpsk3 and the desktop's key is learned and pinned inside it.
   * The relay must be supplied separately for the same reason — a desktop on
   * a self-hosted relay shows its address beside the code.
   */
  async pairWithCode(code: string, relayUrl = DEFAULT_RELAY_URL): Promise<void> {
    const secret = secretFromCode(code) // throws on a malformed code
    await this.pairWith({ v: 1, relay: relayUrl, ps: toBase64Url(secret) }, 'code')
  }

  private async pairWith(payload: PairingPayload, method: 'qr' | 'code'): Promise<void> {
    const pairing: StoredPairing = {
      secret: payload.ps,
      peerPublicKey: payload.pk ?? null,
      relayUrl: payload.relay || DEFAULT_RELAY_URL,
      method,
      pairedAt: Date.now()
    }
    await savePairing(pairing)
    await this.dial(pairing, method, PAIRING_PEER_WAIT_MS)
    // connect() resolves on the first settle, success or scheduled retry —
    // so success has to be checked, not assumed. Without this a failed
    // attempt (wrong code, desktop asleep) resolved cleanly, the sheet
    // closed as if paired, and the first sync then failed with a message
    // about a desktop nobody had reached.
    if (!this.tunnel?.connected) {
      this.tunnel?.stop()
      this.tunnel = null
      throw new Error(i18n.t('pair.failed'))
    }
    // A code pairing learns the desktop's key during the handshake; persist it
    // so every later launch can use the cheaper IK path.
    const learned = this.tunnel?.peerStaticPublicKey
    if (learned && !pairing.peerPublicKey) {
      await savePairing({ ...pairing, peerPublicKey: toHex(learned) })
    }
  }

  /**
   * Make sure a stored pairing is connected, or on its way to being. Returns
   * false only when nothing is paired.
   *
   * The old version returned early whenever a tunnel *object* existed, which
   * quietly made this a no-op for the one case it was written for: a tunnel
   * that had stopped trying. Existing is not the same as working. A live one
   * is checked and nudged; a wedged one is replaced.
   *
   * Safe to call as often as anything likes — launch, every foreground, after
   * a failed RPC. A connect already under way is joined rather than raced.
   *
   * `patient` is passed through to the probe (see Tunnel.refresh): true for
   * callers nobody is watching — a network-type flap mid-use — false for the
   * foreground return, where the user is looking and the socket is the one
   * iOS habitually kills.
   */
  async resume(patient = false): Promise<boolean> {
    const joined = await this.joinConnect()
    if (joined !== null) return joined
    const existing = this.tunnel
    if (existing?.alive) {
      // Not merely "still trying": verify it, because the state that costs the
      // most is the one that looks healthiest — see Tunnel.refresh.
      existing.refresh(patient)
      return true
    }
    const pairing = await loadPairing()
    if (!pairing) return false
    // The keystore read above is a window in which another caller may have
    // started one.
    const raced = await this.joinConnect()
    if (raced !== null) return raced
    await this.dial(pairing, 'qr')
    return true
  }

  /**
   * Wait out a connect already in flight, if there is one — its outcome is
   * this caller's answer too. Null means there was nothing to join. Its
   * failure is swallowed here because it belongs to whoever started it.
   */
  private async joinConnect(): Promise<boolean | null> {
    const pending = this.connecting
    if (!pending) return null
    await pending.catch(() => undefined)
    return this.tunnel !== null
  }

  /** connect(), single-flighted — see `connecting`. */
  private dial(
    pairing: StoredPairing,
    mode: 'qr' | 'code',
    peerWaitMs: number | null = null
  ): Promise<void> {
    const run = this.connect(pairing, mode, peerWaitMs).finally(() => {
      if (this.connecting === run) this.connecting = null
    })
    this.connecting = run
    return run
  }

  /**
   * `peerWaitMs` is how long to wait at the rendezvous before calling it a
   * failure. Pairing passes a bound — the desktop is meant to be there this
   * very moment, and a wrong code should say so quickly. Every later connect
   * parks instead: the desktop may be asleep, and cycling would only make the
   * two devices take turns missing each other.
   */
  private async connect(
    pairing: StoredPairing,
    mode: 'qr' | 'code',
    peerWaitMs: number | null = null
  ): Promise<void> {
    const generation = ++this.generation
    const identity = await loadIdentity()
    // A newer connect started while the keystore read was in flight — a
    // pairing overtaking a background resume, most of all. That one owns the
    // tunnel now, and the `stop()` below would tear its socket down.
    if (generation !== this.generation) return
    const secret = fromBase64Url(pairing.secret)

    this.tunnel?.stop()
    const tunnel = new Tunnel({
      role: 'guest',
      relayUrl: pairing.relayUrl,
      rid: rendezvousId(secret),
      staticKeypair: identity,
      pairingSecret: secret,
      peerStaticPublicKey: pairing.peerPublicKey ? fromHex(pairing.peerPublicKey) : null,
      identity: {
        device: 'wolffish-mobile',
        platform: 'ios',
        deviceName: Device.deviceName ?? Device.modelName ?? 'iPhone'
      },
      autoReconnect: true,
      peerWaitMs,
      maxBackoffMs: PHONE_MAX_BACKOFF_MS
    })
    this.tunnel = tunnel
    // No log is kept here on purpose. The desktop is the source of truth for
    // the relay's history, and it records every connection event per day; the
    // phone holds live state for its own screens and nothing more.
    tunnel.onState((state) => this.publish(state))
    // In-band notification delivery + acks ride this tunnel's control frames.
    attachNotificationHandlers(tunnel)
    await tunnel.start(mode)

    // Announce this device so the desktop's Mobile panel can label it: the
    // name it answers to, plus what it is. Every field is optional on the
    // wire — an older desktop simply ignores what it does not read.
    // `deviceId` is the stable phoneId the desktop stamps into notify frames;
    // it is minted here and never derived from the identity key.
    await tunnel
      .rpc(Rpc.hello, {
        deviceName: Device.deviceName ?? Device.modelName ?? 'Phone',
        platform: Platform.OS,
        model: Device.modelName ?? null,
        osVersion: Device.osVersion ?? null,
        appVersion: Constants.expoConfig?.version ?? null,
        deviceId: await getPhoneId().catch(() => undefined)
      })
      .catch(() => undefined)

    // Register (or clear) this device's push token with the relay — the
    // "on successful pairing" and "on reconnect" halves of the contract;
    // useConnection covers the app-foreground half. Fire-and-forget: a
    // token failure must never block pairing or startup.
    void refreshPushRegistration()
  }

  /** Drop the connection but keep the pairing — used when backgrounding. */
  suspend(): void {
    // Ahead of the teardown: a connect() still inside its keystore reads would
    // otherwise finish afterwards and hand back the tunnel just dropped.
    this.generation += 1
    this.connecting = null
    this.tunnel?.stop()
    this.tunnel = null
  }

  /** Disconnect and forget, returning the app to its unpaired state. */
  async disconnect(): Promise<void> {
    this.generation += 1
    this.connecting = null
    this.tunnel?.stop()
    this.tunnel = null
    this.lastState = null
    await forgetPairing()
  }
}

/**
 * Canonical form for a relay address typed on the code route — the QR route
 * never needs one, its payload carries the relay. Accepts the https:// page
 * URL of a relay and bare hosts; returns `wss://host[/path]` with no trailing
 * slash, or null for empty input (= the default relay). Throws when the input
 * cannot name a relay. Mirrors the desktop's normalizeRelayUrl by hand —
 * Hermes has no reliable WHATWG URL to lean on.
 */
export function normalizeRelayUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)?.[1]?.toLowerCase() ?? null
  if (scheme !== null && !['ws', 'wss', 'http', 'https'].includes(scheme))
    throw new Error(`not a relay URL: ${raw}`)
  const rest = scheme === null ? trimmed : trimmed.slice(scheme.length + '://'.length)
  const wsScheme = scheme === 'ws' || scheme === 'http' ? 'ws' : 'wss'
  // Query and fragment can't survive — the tunnel appends `/t/<rid>` — and a
  // trailing slash would double up; a path prefix passes through untouched.
  const body = rest.split(/[?#]/)[0].replace(/\/+$/, '')
  if (!body || body.startsWith('/') || /\s/.test(body)) throw new Error(`not a relay URL: ${raw}`)
  // A scheme-less input must look like a host (a dot or a port) — otherwise a
  // pairing code pasted into the wrong field becomes wss://K7M9-2QXR.
  if (scheme === null && !/[.:]/.test(body.split('/')[0]))
    throw new Error(`not a relay URL: ${raw}`)
  return `${wsScheme}://${body}`
}

/** Characters in a pairing code, and the size of its first group. Mirrors
 *  CODE_CHARS in pairing.ts — that file is vendored byte-identical with the
 *  desktop, so this display concern lives here instead. The round-trip test
 *  fails loudly if the two ever drift. */
const CODE_LENGTH = 8
const CODE_GROUP = 4

/** Everything `normalizeCode` accepts, minus its length check: upper case,
 *  dashes and spaces dropped, and the look-alike substitutions. */
function foldCode(input: string): string {
  return String(input)
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V')
}

/**
 * Tidy a finished pairing code for display: `k7m9 2qxr` → `K7M9-2QXR`.
 *
 * Post-processing, not live formatting — call it when the user leaves the
 * field, never on every keystroke. Rewriting mid-entry fights whoever is
 * typing: the caret jumps, backspace stalls on a re-inserted dash, and a
 * half-typed code gets "corrected" into something they did not write.
 *
 * Input that is not exactly one code comes back only trimmed. Truncating an
 * over-long paste to eight characters would silently invent a different code;
 * leaving it be lets `pairingCodeIssue` say what is actually wrong.
 */
export function formatPairingCode(input: string): string {
  const folded = foldCode(input)
  if (folded.length !== CODE_LENGTH || /[^0-9A-Z]/.test(folded)) return input.trim()
  return `${folded.slice(0, CODE_GROUP)}-${folded.slice(CODE_GROUP)}`
}

/**
 * Drops the group separator in as the fourth character lands, so the field
 * reads `K7M9-2QXR` without anyone typing the dash.
 *
 * Forward-only, and that is the whole trick: it fires solely when the value
 * grew, so backspacing over the dash removes it for good instead of having it
 * reinstated under the caret. Everything else about the value is left alone —
 * case and the rest of the shape are settled later, on the way out.
 */
export function autoDashPairingCode(next: string, previous: string): string {
  if (next.length <= previous.length) return next
  if (next.includes('-')) return next
  const folded = next.replace(/\s/g, '')
  return folded.length === CODE_GROUP ? `${next}-` : next
}

/** Why a typed code cannot be used, or null when it can. */
export type PairingCodeIssue = 'empty' | 'character' | 'length'

/**
 * Validates what the user typed, in any spelling: dashes and spaces optional,
 * case-insensitive, O/0 and I/L/1 and U/V interchangeable — exactly what
 * `normalizeCode` will accept at submit time, so the button never enables a
 * code that pairing then rejects.
 */
export function pairingCodeIssue(input: string): PairingCodeIssue | null {
  const folded = foldCode(input)
  if (folded.length === 0) return 'empty'
  // Checked before length: "which character is wrong" is the more useful
  // complaint when the code is both mistyped and the wrong size.
  if (/[^0-9A-Z]/.test(folded)) return 'character'
  if (folded.length !== CODE_LENGTH) return 'length'
  return null
}

export const tunnelClient = new TunnelClient()
