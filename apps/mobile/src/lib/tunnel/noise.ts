/**
 * Noise handshakes for the tunnel — IKpsk2 and XXpsk3.
 *
 * Vendored identically into wolffish-app and wolffish-mobile. Pure JS via
 * @noble so the same code runs in Electron's main process and on Hermes.
 *
 *   IKpsk2   QR pairing and every reconnect. The initiator already holds the
 *            responder's static key (the QR carried it, or it was pinned at
 *            pairing), so this is one round trip.
 *
 *     <- s
 *     ...
 *     -> e, es, s, ss
 *     <- e, ee, se, psk
 *
 *   XXpsk3   Typed-code pairing. A code cannot carry a 64-hex public key, so
 *            both statics are exchanged inside the handshake and pinned there.
 *            One extra message, paid once — afterwards the pair reconnects
 *            with IKpsk2 exactly like a QR pairing.
 *
 *     -> e
 *     <- e, ee, s, es
 *     -> s, se, psk
 *
 * Implemented from the Noise spec's processing rules (§5). The pairing secret
 * enters as the PSK in both patterns, so only a device that saw the QR or the
 * code can complete a handshake — a hostile relay that knows the rendezvous ID
 * still cannot sit in the middle. Ephemeral keys give forward secrecy.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'

export const PROTOCOL_NAME_IK = 'Noise_IKpsk2_25519_ChaChaPoly_SHA256'
export const PROTOCOL_NAME_XX = 'Noise_XXpsk3_25519_ChaChaPoly_SHA256'
export const KEY_LEN = 32
export const TAG_LEN = 16

const EMPTY = new Uint8Array(0)

export type Keypair = { privateKey: Uint8Array; publicKey: Uint8Array }

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function generateKeypair(): Keypair {
  const { secretKey, publicKey } = x25519.keygen()
  return { privateKey: secretKey, publicKey }
}

export function publicKeyFrom(privateKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(privateKey)
}

const dh = (privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array =>
  x25519.getSharedSecret(privateKey, publicKey)

/** Noise HKDF: 1–3 outputs chained from the running chaining key. */
function hkdf(chainingKey: Uint8Array, ikm: Uint8Array, outputs: number): Uint8Array[] {
  const tempKey = hmac(sha256, chainingKey, ikm)
  const o1 = hmac(sha256, tempKey, Uint8Array.of(1))
  if (outputs === 1) return [o1]
  const o2 = hmac(sha256, tempKey, concat(o1, Uint8Array.of(2)))
  if (outputs === 2) return [o1, o2]
  const o3 = hmac(sha256, tempKey, concat(o2, Uint8Array.of(3)))
  return [o1, o2, o3]
}

/** Noise nonce: 4 zero bytes followed by a 64-bit little-endian counter. */
function nonceBytes(counter: bigint): Uint8Array {
  const nonce = new Uint8Array(12)
  new DataView(nonce.buffer).setBigUint64(4, counter, true)
  return nonce
}

/** One direction of the post-handshake transport. */
export class CipherState {
  readonly key: Uint8Array
  private counter = 0n

  constructor(key: Uint8Array) {
    this.key = key
  }

  encrypt(plaintext: Uint8Array, ad: Uint8Array = EMPTY): Uint8Array {
    const out = chacha20poly1305(this.key, nonceBytes(this.counter), ad).encrypt(plaintext)
    this.counter += 1n
    return out
  }

  decrypt(ciphertext: Uint8Array, ad: Uint8Array = EMPTY): Uint8Array {
    const out = chacha20poly1305(this.key, nonceBytes(this.counter), ad).decrypt(ciphertext)
    this.counter += 1n
    return out
  }
}

class SymmetricState {
  h: Uint8Array
  private ck: Uint8Array
  private k: Uint8Array | null = null
  private n = 0n

  constructor(protocolName: string) {
    const name = new TextEncoder().encode(protocolName)
    this.h = name.length <= 32 ? concat(name, new Uint8Array(32 - name.length)) : sha256(name)
    this.ck = this.h.slice()
  }

  mixHash(data: Uint8Array): void {
    this.h = sha256(concat(this.h, data))
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, k] = hkdf(this.ck, ikm, 2)
    this.ck = ck
    this.k = k
    this.n = 0n
  }

  mixKeyAndHash(ikm: Uint8Array): void {
    const [ck, tempH, k] = hkdf(this.ck, ikm, 3)
    this.ck = ck
    this.mixHash(tempH)
    this.k = k
    this.n = 0n
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    if (!this.k) {
      this.mixHash(plaintext)
      return plaintext
    }
    const ciphertext = chacha20poly1305(this.k, nonceBytes(this.n), this.h).encrypt(plaintext)
    this.n += 1n
    this.mixHash(ciphertext)
    return ciphertext
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    if (!this.k) {
      this.mixHash(ciphertext)
      return ciphertext
    }
    const plaintext = chacha20poly1305(this.k, nonceBytes(this.n), this.h).decrypt(ciphertext)
    this.n += 1n
    this.mixHash(ciphertext)
    return plaintext
  }

  split(): CipherState[] {
    return hkdf(this.ck, EMPTY, 2).map((key) => new CipherState(key))
  }
}

export type HandshakeResult = {
  payload: Uint8Array
  send: CipherState
  receive: CipherState
  handshakeHash: Uint8Array
  remoteStaticPublicKey: Uint8Array
}

// ---------------------------------------------------------------- IKpsk2

/** Initiator (mobile) — knows the responder's static key already. */
export class InitiatorIK {
  private readonly s: Keypair
  private readonly rs: Uint8Array
  private readonly psk: Uint8Array
  private readonly state: SymmetricState
  private e!: Keypair

  constructor(opts: {
    staticKeypair: Keypair
    remoteStaticPublicKey: Uint8Array
    psk: Uint8Array
    prologue?: Uint8Array
  }) {
    this.s = opts.staticKeypair
    this.rs = opts.remoteStaticPublicKey
    this.psk = opts.psk
    this.state = new SymmetricState(PROTOCOL_NAME_IK)
    this.state.mixHash(opts.prologue ?? EMPTY)
    this.state.mixHash(this.rs) // pre-message: <- s
  }

  writeMessage1(payload: Uint8Array = EMPTY): Uint8Array {
    this.e = generateKeypair()
    this.state.mixHash(this.e.publicKey)
    this.state.mixKey(dh(this.e.privateKey, this.rs)) // es
    const encryptedStatic = this.state.encryptAndHash(this.s.publicKey)
    this.state.mixKey(dh(this.s.privateKey, this.rs)) // ss
    return concat(this.e.publicKey, encryptedStatic, this.state.encryptAndHash(payload))
  }

  readMessage2(message: Uint8Array): HandshakeResult {
    const re = message.subarray(0, KEY_LEN)
    this.state.mixHash(re)
    this.state.mixKey(dh(this.e.privateKey, re)) // ee
    this.state.mixKey(dh(this.s.privateKey, re)) // se
    this.state.mixKeyAndHash(this.psk) // psk
    const payload = this.state.decryptAndHash(message.subarray(KEY_LEN))
    const [send, receive] = this.state.split()
    return { payload, send, receive, handshakeHash: this.state.h, remoteStaticPublicKey: this.rs }
  }
}

/** Responder (desktop) — learns and pins the initiator's static key. */
export class ResponderIK {
  private readonly s: Keypair
  private readonly psk: Uint8Array
  private readonly state: SymmetricState
  private re!: Uint8Array
  private rs!: Uint8Array
  private e!: Keypair

  constructor(opts: { staticKeypair: Keypair; psk: Uint8Array; prologue?: Uint8Array }) {
    this.s = opts.staticKeypair
    this.psk = opts.psk
    this.state = new SymmetricState(PROTOCOL_NAME_IK)
    this.state.mixHash(opts.prologue ?? EMPTY)
    this.state.mixHash(this.s.publicKey) // pre-message: <- s
  }

  readMessage1(message: Uint8Array): { payload: Uint8Array; remoteStaticPublicKey: Uint8Array } {
    this.re = message.subarray(0, KEY_LEN)
    this.state.mixHash(this.re)
    this.state.mixKey(dh(this.s.privateKey, this.re)) // es
    const encryptedStatic = message.subarray(KEY_LEN, KEY_LEN + KEY_LEN + TAG_LEN)
    this.rs = this.state.decryptAndHash(encryptedStatic)
    this.state.mixKey(dh(this.s.privateKey, this.rs)) // ss
    const payload = this.state.decryptAndHash(message.subarray(KEY_LEN + KEY_LEN + TAG_LEN))
    return { payload, remoteStaticPublicKey: this.rs }
  }

  writeMessage2(payload: Uint8Array = EMPTY): Omit<HandshakeResult, 'payload'> & {
    message: Uint8Array
  } {
    this.e = generateKeypair()
    this.state.mixHash(this.e.publicKey)
    this.state.mixKey(dh(this.e.privateKey, this.re)) // ee
    this.state.mixKey(dh(this.e.privateKey, this.rs)) // se
    this.state.mixKeyAndHash(this.psk) // psk
    const message = concat(this.e.publicKey, this.state.encryptAndHash(payload))
    const [receive, send] = this.state.split() // mirror of the initiator's split
    return {
      message,
      send,
      receive,
      handshakeHash: this.state.h,
      remoteStaticPublicKey: this.rs
    }
  }
}

// ---------------------------------------------------------------- XXpsk3

/** Initiator (mobile) pairing from a typed code — knows no keys in advance. */
export class InitiatorXX {
  private readonly s: Keypair
  private readonly psk: Uint8Array
  private readonly state: SymmetricState
  private e!: Keypair
  private re!: Uint8Array
  private rs!: Uint8Array

  constructor(opts: { staticKeypair: Keypair; psk: Uint8Array; prologue?: Uint8Array }) {
    this.s = opts.staticKeypair
    this.psk = opts.psk
    this.state = new SymmetricState(PROTOCOL_NAME_XX)
    this.state.mixHash(opts.prologue ?? EMPTY)
  }

  /** -> e */
  writeMessage1(payload: Uint8Array = EMPTY): Uint8Array {
    this.e = generateKeypair()
    this.state.mixHash(this.e.publicKey)
    return concat(this.e.publicKey, this.state.encryptAndHash(payload))
  }

  /** <- e, ee, s, es */
  readMessage2(message: Uint8Array): { payload: Uint8Array; remoteStaticPublicKey: Uint8Array } {
    this.re = message.subarray(0, KEY_LEN)
    this.state.mixHash(this.re)
    this.state.mixKey(dh(this.e.privateKey, this.re)) // ee
    const encryptedStatic = message.subarray(KEY_LEN, KEY_LEN + KEY_LEN + TAG_LEN)
    this.rs = this.state.decryptAndHash(encryptedStatic)
    this.state.mixKey(dh(this.e.privateKey, this.rs)) // es
    return {
      payload: this.state.decryptAndHash(message.subarray(KEY_LEN + KEY_LEN + TAG_LEN)),
      remoteStaticPublicKey: this.rs
    }
  }

  /** -> s, se, psk */
  writeMessage3(payload: Uint8Array = EMPTY): Omit<HandshakeResult, 'payload'> & {
    message: Uint8Array
  } {
    const encryptedStatic = this.state.encryptAndHash(this.s.publicKey)
    this.state.mixKey(dh(this.s.privateKey, this.re)) // se
    this.state.mixKeyAndHash(this.psk) // psk
    const message = concat(encryptedStatic, this.state.encryptAndHash(payload))
    const [send, receive] = this.state.split()
    return {
      message,
      send,
      receive,
      handshakeHash: this.state.h,
      remoteStaticPublicKey: this.rs
    }
  }
}

/** Responder (desktop) pairing from a typed code. */
export class ResponderXX {
  private readonly s: Keypair
  private readonly psk: Uint8Array
  private readonly state: SymmetricState
  private e!: Keypair
  private re!: Uint8Array

  constructor(opts: { staticKeypair: Keypair; psk: Uint8Array; prologue?: Uint8Array }) {
    this.s = opts.staticKeypair
    this.psk = opts.psk
    this.state = new SymmetricState(PROTOCOL_NAME_XX)
    this.state.mixHash(opts.prologue ?? EMPTY)
  }

  /** -> e */
  readMessage1(message: Uint8Array): { payload: Uint8Array } {
    this.re = message.subarray(0, KEY_LEN)
    this.state.mixHash(this.re)
    return { payload: this.state.decryptAndHash(message.subarray(KEY_LEN)) }
  }

  /** <- e, ee, s, es */
  writeMessage2(payload: Uint8Array = EMPTY): Uint8Array {
    this.e = generateKeypair()
    this.state.mixHash(this.e.publicKey)
    this.state.mixKey(dh(this.e.privateKey, this.re)) // ee
    const encryptedStatic = this.state.encryptAndHash(this.s.publicKey)
    this.state.mixKey(dh(this.s.privateKey, this.re)) // es
    return concat(this.e.publicKey, encryptedStatic, this.state.encryptAndHash(payload))
  }

  /** -> s, se, psk */
  readMessage3(message: Uint8Array): HandshakeResult {
    const encryptedStatic = message.subarray(0, KEY_LEN + TAG_LEN)
    const rs = this.state.decryptAndHash(encryptedStatic)
    this.state.mixKey(dh(this.e.privateKey, rs)) // se
    this.state.mixKeyAndHash(this.psk) // psk
    const payload = this.state.decryptAndHash(message.subarray(KEY_LEN + TAG_LEN))
    const [receive, send] = this.state.split() // mirror of the initiator's split
    return { payload, send, receive, handshakeHash: this.state.h, remoteStaticPublicKey: rs }
  }
}
