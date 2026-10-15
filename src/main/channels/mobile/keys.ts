/**
 * Pairing identity for the mobile channel.
 *
 * The desktop keeps one long-lived X25519 keypair and, per paired phone, the
 * pairing secret both devices derive their rendezvous ID from plus the phone's
 * pinned public key. Everything here is stored encrypted at rest through
 * Electron's `safeStorage`, which is Keychain on macOS, DPAPI on Windows, and
 * libsecret/kwallet on Linux.
 *
 * The Linux caveat is documented rather than engineered around: with no secret
 * store available Electron falls back to a hardcoded password, so the panel
 * surfaces the backend in use and lets the user judge. A device whose home
 * directory an attacker can already read has larger problems than these keys.
 */
import { generateKeypair, type Keypair } from '@main/tunnel/noise'
import { fromBase64Url, rendezvousId, toBase64Url, toHex } from '@main/tunnel/pairing'
import { wlog } from '@main/workspace/logger'
import { workspaceRoot } from '@main/workspace/root'
import { safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** One paired phone. The desktop pairs with one at a time today. */
export type MobilePairing = {
  /** Base64url; the shared secret both sides derive the rendezvous ID from. */
  secret: string
  /** The phone's static public key, hex — pinned on first handshake. */
  peerPublicKey: string | null
  /** How this pairing was established, for the panel. */
  method: 'qr' | 'code'
  pairedAt: number
  /** Last time a handshake completed, so the panel can show "last seen". */
  lastSeenAt: number | null
  /** Free-text label; the phone sends its device name at handshake. */
  deviceName: string | null
  /** What the phone is, as it describes itself at handshake. All optional —
   *  a phone on an older build sends only its name. */
  platform?: 'ios' | 'android' | null
  model?: string | null
  osVersion?: string | null
  appVersion?: string | null
  /**
   * The phone's stable device id, learned from its hello. This is the ONLY
   * routing identity the desktop ever stamps into a notify frame — the model
   * never supplies it. Null until a phone new enough to send one connects;
   * notifications are refused until then.
   */
  phoneId?: string | null
}

export type MobileIdentity = {
  /** Desktop's own static key, base64url. */
  privateKey: string
  publicKey: string
}

type StoredState = {
  identity: MobileIdentity
  pairing: MobilePairing | null
  /** Power-user relay override; null/absent means the built-in default. */
  relayUrl?: string | null
}

function stateFile(): string {
  return path.join(workspaceRoot(), 'mobile', 'pairing.json')
}

/**
 * Whether this process may touch the OS keystore at all.
 *
 * On macOS the keystore is the login keychain, and
 * `safeStorage.isEncryptionAvailable()` is not a cheap query there: on first
 * use it creates the app's "Safe Storage" item, and when the keychain is
 * locked or missing — a launch over SSH, from a background shell, under a
 * fresh account — that SecItemAdd blocks the main thread on an authorization
 * dialog nobody can see (`sample` shows the boot parked in
 * SecItemAdd → makeLoginAuthUI at 0% CPU, right after `[cli] ipc registered`).
 * A headless boot has no one to answer such a dialog, so it never asks: the
 * pairing file is written in the clear, a keychain-sealed file is reported
 * rather than opened, and the panel's privacy card says `plaintext`. DPAPI and
 * the Linux stores never prompt, so those platforms keep theirs.
 */
let keystoreOffLimits = false

export function configureKeystore(opts: { headless: boolean }): void {
  keystoreOffLimits = opts.headless && process.platform === 'darwin'
}

/**
 * Encrypt when the platform can, and say so in the envelope. A file written on
 * a machine with a working keystore must not silently become unreadable, and a
 * file written without one must not masquerade as protected.
 */
function seal(plain: string): string {
  if (keystoreOffLimits || !safeStorage.isEncryptionAvailable()) {
    return JSON.stringify({ enc: false, data: plain })
  }
  return JSON.stringify({
    enc: true,
    data: safeStorage.encryptString(plain).toString('base64')
  })
}

function parseEnvelope(raw: string): { enc: boolean; data: string } | null {
  try {
    return JSON.parse(raw) as { enc: boolean; data: string }
  } catch {
    return null
  }
}

function open(raw: string): string | null {
  try {
    const envelope = parseEnvelope(raw)
    if (!envelope) return null
    if (!envelope.enc) return envelope.data
    if (keystoreOffLimits || !safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(Buffer.from(envelope.data, 'base64'))
  } catch {
    return null
  }
}

let cache: StoredState | null = null

/**
 * A sealed file this boot cannot open — paired with a window, launched
 * headless. Writes refuse while it stands: every write starts from a fresh
 * identity when `read` comes back empty, and that would silently replace the
 * user's pairing with a key-less plaintext one.
 */
let sealedUnreadable = false
let sealedWarned = false

/**
 * All writes pass through one chain. `write` is a plain whole-file
 * fs.writeFile, and two of them racing interleave bytes — the connection
 * storm proved it can happen hundreds of times a second, and a torn file
 * here is the pairing itself. Reads stay unserialized: they hit the cache.
 */
let writeChain: Promise<void> = Promise.resolve()

async function read(): Promise<StoredState | null> {
  if (cache) return cache
  let raw: string
  try {
    raw = await fs.readFile(stateFile(), 'utf8')
  } catch {
    sealedUnreadable = false
    return null
  }
  const plain = open(raw)
  if (!plain) {
    sealedUnreadable = parseEnvelope(raw)?.enc === true
    if (sealedUnreadable && !sealedWarned) {
      sealedWarned = true
      wlog.warn(
        'mobile',
        `${stateFile()} is sealed with the OS keystore, which this boot does not use — ` +
          `the stored pairing stays on disk but is unavailable until Wolffish runs with a window`
      )
    }
    return null
  }
  try {
    cache = JSON.parse(plain) as StoredState
  } catch {
    return null
  }
  sealedUnreadable = false
  return cache
}

async function write(state: StoredState): Promise<void> {
  if (sealedUnreadable) {
    throw new Error(
      `${stateFile()} is sealed with the OS keystore, which this boot does not use — ` +
        `run Wolffish with a window once, or delete the file to pair afresh`
    )
  }
  cache = state
  const file = stateFile()
  const run = async (): Promise<void> => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, seal(JSON.stringify(state)), { mode: 0o600 })
  }
  const chained = writeChain.then(run, run)
  // The chain must survive a failed write or every later write is skipped.
  writeChain = chained.catch(() => undefined)
  await chained
}

/** The desktop's own keypair, minted once and reused for every pairing. */
export async function loadIdentity(): Promise<Keypair> {
  const state = await read()
  if (state?.identity) {
    return {
      privateKey: fromBase64Url(state.identity.privateKey),
      publicKey: fromBase64Url(state.identity.publicKey)
    }
  }
  const keypair = generateKeypair()
  await write({
    identity: {
      privateKey: toBase64Url(keypair.privateKey),
      publicKey: toBase64Url(keypair.publicKey)
    },
    pairing: state?.pairing ?? null,
    relayUrl: state?.relayUrl ?? null
  })
  return keypair
}

export async function loadPairing(): Promise<MobilePairing | null> {
  return (await read())?.pairing ?? null
}

export async function savePairing(pairing: MobilePairing): Promise<void> {
  // loadIdentity() mints and persists a keypair when none exists, so re-reading
  // afterwards always finds one — the pairing is never written key-less.
  await loadIdentity()
  const state = await read()
  if (!state) throw new Error('mobile identity unavailable')
  await write({ identity: state.identity, pairing, relayUrl: state.relayUrl ?? null })
}

export async function updatePairing(patch: Partial<MobilePairing>): Promise<MobilePairing | null> {
  const current = await loadPairing()
  if (!current) return null
  const next = { ...current, ...patch }
  await savePairing(next)
  return next
}

/** Forget the phone. The desktop identity survives so re-pairing is cheap. */
export async function clearPairing(): Promise<void> {
  const state = await read()
  if (!state) return
  await write({ identity: state.identity, pairing: null, relayUrl: state.relayUrl ?? null })
}

/** The stored relay override, or null when the default applies. */
export async function loadRelayUrl(): Promise<string | null> {
  return (await read())?.relayUrl ?? null
}

/** Persist (or clear, with null) the relay override. Survives unpairing. */
export async function saveRelayUrl(url: string | null): Promise<void> {
  // loadIdentity() mints and persists a keypair when none exists, so the
  // override is never written into a key-less file.
  await loadIdentity()
  const state = await read()
  if (!state) throw new Error('mobile identity unavailable')
  await write({ identity: state.identity, pairing: state.pairing ?? null, relayUrl: url })
}

/** Rendezvous ID for the stored pairing, or null when nothing is paired. */
export function ridForPairing(pairing: MobilePairing): string {
  return rendezvousId(fromBase64Url(pairing.secret))
}

export function secretBytes(pairing: MobilePairing): Uint8Array {
  return fromBase64Url(pairing.secret)
}

export function peerKeyBytes(pairing: MobilePairing): Uint8Array | null {
  return pairing.peerPublicKey ? hexToBytes(pairing.peerPublicKey) : null
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export { toHex }

/**
 * Which platform store is protecting the file, for the panel's privacy card.
 * `basic_text` on Linux means no keystore was found and the bytes are
 * effectively in the clear — worth telling the user rather than hiding.
 */
export function storageBackend(): { available: boolean; backend: string } {
  if (keystoreOffLimits) return { available: false, backend: 'plaintext' }
  const available = safeStorage.isEncryptionAvailable()
  let backend = available ? 'os-keystore' : 'unavailable'
  if (process.platform === 'linux') {
    try {
      backend = safeStorage.getSelectedStorageBackend()
    } catch {
      backend = available ? 'os-keystore' : 'unavailable'
    }
  } else if (process.platform === 'darwin') {
    backend = available ? 'keychain' : 'unavailable'
  } else if (process.platform === 'win32') {
    backend = available ? 'dpapi' : 'unavailable'
  }
  return { available, backend }
}
