/**
 * Pairing: QR payloads, typed codes, rendezvous IDs, and key fingerprints.
 *
 * Vendored identically into wolffish-app and wolffish-mobile.
 *
 * Two ways in, one end state. A QR carries the desktop's public key so the
 * handshake is IKpsk2 in one round trip. A typed code cannot carry 64 hex
 * characters, so it carries only the secret and the handshake is XXpsk3, which
 * exchanges both statics inside itself. After either route both devices hold
 * pinned keys and every reconnect is IKpsk2.
 */
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { PAIRING_PREFIX, type PairingPayload } from './protocol'

const encoder = new TextEncoder()

// ------------------------------------------------------------------ base64url

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/**
 * base64url without `btoa`/`atob` — React Native does not polyfill either, and
 * this file has to behave the same in Electron's main process and on Hermes.
 */
export function toBase64Url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = i + 1 < bytes.length ? bytes[i + 1] : undefined
    const c = i + 2 < bytes.length ? bytes[i + 2] : undefined
    out += B64[a >> 2]
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)]
    if (b === undefined) break
    out += B64[((b & 15) << 2) | ((c ?? 0) >> 6)]
    if (c === undefined) break
    out += B64[c & 63]
  }
  return out
}

export function fromBase64Url(value: string): Uint8Array {
  const clean = value.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8))
  let bits = 0
  let acc = 0
  let index = 0
  for (const character of clean) {
    const digit = B64.indexOf(character)
    if (digit < 0) throw new Error('malformed base64url')
    acc = (acc << 6) | digit
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[index++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, index)
}

export function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

// -------------------------------------------------------------- rendezvous ID

/**
 * The meeting point both devices derive independently. 256 bits, unguessable,
 * and the only fact about a pairing the relay ever learns.
 */
export function rendezvousId(pairingSecret: Uint8Array): string {
  return toHex(hmac(sha256, pairingSecret, encoder.encode('rid-v1')))
}

// -------------------------------------------------------------- typed codes

/** Crockford base32: no I, L, O or U, so a code survives being read aloud. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_CHARS = 8 // 40 bits
export const CODE_TTL_MS = 3 * 60 * 1000

/** A fresh pairing code formatted for reading: `K7M9-2QXR`. */
export function generateCode(randomBytes: (length: number) => Uint8Array): string {
  const bytes = randomBytes(CODE_CHARS)
  let code = ''
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length]
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/**
 * Accepts what a human actually types: lower case, missing or extra dashes,
 * spaces, and the classic look-alike substitutions.
 */
export function normalizeCode(input: string): string {
  const folded = String(input)
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V')
  if (folded.length !== CODE_CHARS) throw new Error(`a pairing code is ${CODE_CHARS} characters`)
  for (const character of folded) {
    if (!ALPHABET.includes(character)) throw new Error(`"${character}" is not a pairing character`)
  }
  return folded
}

/** The 32-byte pairing secret a code stands for. Same role as the QR's secret. */
export function secretFromCode(code: string): Uint8Array {
  return hmac(sha256, encoder.encode('wolffish-pair-code-v1'), encoder.encode(normalizeCode(code)))
}

export function codeIsLive(issuedAt: number, now: number): boolean {
  return now - issuedAt < CODE_TTL_MS
}

// ------------------------------------------------------------------ QR payload

export function encodePairingPayload(payload: PairingPayload): string {
  return PAIRING_PREFIX + toBase64Url(encoder.encode(JSON.stringify(payload)))
}

export function decodePairingPayload(text: string): PairingPayload {
  const trimmed = text.trim()
  if (!trimmed.startsWith(PAIRING_PREFIX)) throw new Error('not a Wolffish pairing code')
  const json = new TextDecoder().decode(fromBase64Url(trimmed.slice(PAIRING_PREFIX.length)))
  const payload = JSON.parse(json) as PairingPayload
  if (!payload.ps || !payload.relay) throw new Error('malformed pairing payload')
  return payload
}

// ----------------------------------------------------------------- fingerprints

/**
 * Short, human-comparable form of a key or transcript hash: `2d5b…231d`.
 *
 * Both apps show these side by side so a user can see at a glance that the two
 * devices agree on which keys are in play — the same reassurance a messaging
 * app's safety-number screen gives, without asking anyone to read 64 characters.
 */
export function fingerprint(hexOrBytes: string | Uint8Array): string {
  const hex = typeof hexOrBytes === 'string' ? hexOrBytes : toHex(hexOrBytes)
  if (hex.length <= 8) return hex
  return `${hex.slice(0, 4)}…${hex.slice(-4)}`
}
