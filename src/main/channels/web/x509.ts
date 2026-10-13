/**
 * Just enough ASN.1/DER to mint what the Web UI's TLS needs without shelling
 * out to an `openssl` that a Windows box does not have: a self-signed
 * certificate for the fallback mode, and a PKCS#10 request for the ACME path.
 * Node signs and exports keys but builds neither, so the two structures are
 * assembled here byte by byte (RFC 5280 and RFC 2986 respectively).
 *
 * ECDSA P-256 throughout — small keys, fast handshakes on a phone, and the
 * key type Let's Encrypt's short-lived profile is happiest with.
 *
 * Pure: no Electron, no filesystem. The test parses the output back with
 * Node's own X509Certificate and with openssl, which is the independent route
 * that keeps a byte-level builder honest.
 */
import {
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject
} from 'node:crypto'
import net from 'node:net'

// ─── DER primitives ──────────────────────────────────────────────────────────

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  let v = n
  while (v > 0) {
    bytes.unshift(v & 0xff)
    v >>>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(body.length), body])
}

export const der = {
  seq: (...children: Buffer[]): Buffer => tlv(0x30, Buffer.concat(children)),
  set: (...children: Buffer[]): Buffer => tlv(0x31, Buffer.concat(children)),
  int: (value: number | Buffer): Buffer => {
    let body: Buffer
    if (typeof value === 'number') {
      if (!Number.isInteger(value) || value < 0)
        throw new Error('der.int: non-negative integers only')
      const bytes: number[] = []
      let v = value
      do {
        bytes.unshift(v & 0xff)
        v = Math.floor(v / 256)
      } while (v > 0)
      body = Buffer.from(bytes)
    } else {
      body = value
    }
    // A positive INTEGER whose first byte has the high bit set needs a leading
    // zero, or it reads back as negative.
    if (body.length === 0 || body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body])
    return tlv(0x02, body)
  },
  bool: (value: boolean): Buffer => tlv(0x01, Buffer.from([value ? 0xff : 0x00])),
  null: (): Buffer => Buffer.from([0x05, 0x00]),
  oid: (dotted: string): Buffer => {
    const parts = dotted.split('.').map((p) => Number(p))
    if (parts.length < 2 || parts.some((p) => !Number.isInteger(p) || p < 0)) {
      throw new Error(`der.oid: bad OID ${dotted}`)
    }
    const bytes: number[] = [parts[0] * 40 + parts[1]]
    for (const part of parts.slice(2)) {
      const chunk: number[] = []
      let v = part
      do {
        chunk.unshift(v & 0x7f)
        v = Math.floor(v / 128)
      } while (v > 0)
      for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80
      bytes.push(...chunk)
    }
    return tlv(0x06, Buffer.from(bytes))
  },
  utf8: (text: string): Buffer => tlv(0x0c, Buffer.from(text, 'utf8')),
  ia5: (text: string): Buffer => tlv(0x16, Buffer.from(text, 'ascii')),
  octet: (body: Buffer): Buffer => tlv(0x04, body),
  /** BIT STRING with no unused bits — what signatures and public keys carry. */
  bits: (body: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), body])),
  /** A named-bit-list BIT STRING (KeyUsage) with the given single bytes and unused-bit count. */
  bitsRaw: (unusedBits: number, body: Buffer): Buffer =>
    tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), body])),
  /** `[n] EXPLICIT` — constructed, context-specific. */
  explicit: (n: number, body: Buffer): Buffer => tlv(0xa0 | n, body),
  /** `[n] IMPLICIT` around a primitive value (a GeneralName string, an IP). */
  implicit: (n: number, body: Buffer): Buffer => tlv(0x80 | n, body),
  /** `[n] IMPLICIT` around a constructed value (the CSR attribute set). */
  implicitConstructed: (n: number, body: Buffer): Buffer => tlv(0xa0 | n, body),
  time: (date: Date): Buffer => {
    const pad = (n: number): string => String(n).padStart(2, '0')
    const year = date.getUTCFullYear()
    const rest =
      pad(date.getUTCMonth() + 1) +
      pad(date.getUTCDate()) +
      pad(date.getUTCHours()) +
      pad(date.getUTCMinutes()) +
      pad(date.getUTCSeconds()) +
      'Z'
    // UTCTime covers 1950–2049; later dates must be GeneralizedTime.
    if (year >= 1950 && year < 2050)
      return tlv(0x17, Buffer.from(String(year).slice(2) + rest, 'ascii'))
    return tlv(0x18, Buffer.from(String(year) + rest, 'ascii'))
  }
}

// ─── OIDs ────────────────────────────────────────────────────────────────────

const OID = {
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  extensionRequest: '1.2.840.113549.1.9.14'
}

// ─── Names and SANs ──────────────────────────────────────────────────────────

function name(attrs: Array<[oid: string, value: string]>): Buffer {
  return der.seq(...attrs.map(([oid, value]) => der.set(der.seq(der.oid(oid), der.utf8(value)))))
}

/** Textual IPv6 → 16 bytes. Handles `::` compression and an embedded IPv4 tail. */
export function ipv6ToBytes(text: string): Buffer {
  let addr = text.trim()
  const zone = addr.indexOf('%')
  if (zone >= 0) addr = addr.slice(0, zone)
  const out = Buffer.alloc(16)
  let tail: number[] = []
  const lastColon = addr.lastIndexOf(':')
  const lastGroup = addr.slice(lastColon + 1)
  if (lastGroup.includes('.')) {
    const v4 = lastGroup.split('.').map((p) => Number(p))
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      throw new Error(`bad IPv4 tail in ${text}`)
    }
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]]
    addr = addr.slice(0, lastColon) + ':0:0'
  }
  const halves = addr.split('::')
  if (halves.length > 2) throw new Error(`bad IPv6 address ${text}`)
  const parse = (s: string): number[] =>
    s === '' ? [] : s.split(':').map((g) => parseInt(g || '0', 16))
  const head = parse(halves[0])
  const rest = halves.length === 2 ? parse(halves[1]) : []
  const groups =
    halves.length === 2
      ? [...head, ...new Array(8 - head.length - rest.length).fill(0), ...rest]
      : head
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) {
    throw new Error(`bad IPv6 address ${text}`)
  }
  if (tail.length) {
    groups[6] = tail[0]
    groups[7] = tail[1]
  }
  groups.forEach((g, i) => out.writeUInt16BE(g, i * 2))
  return out
}

export type SanIdentifier = { type: 'dns'; value: string } | { type: 'ip'; value: string }

/** Classify a user-typed identifier: an IP (v4 or v6) or, failing that, a hostname. */
export function classifyIdentifier(raw: string): SanIdentifier | null {
  const value = raw.trim().replace(/^\[|\]$/g, '')
  if (!value) return null
  if (net.isIP(value)) return { type: 'ip', value: value.toLowerCase() }
  if (
    /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
      value
    )
  ) {
    return { type: 'dns', value: value.toLowerCase() }
  }
  return null
}

function generalName(id: SanIdentifier): Buffer {
  if (id.type === 'dns') return der.implicit(2, Buffer.from(id.value, 'ascii'))
  const bytes = net.isIPv4(id.value)
    ? Buffer.from(id.value.split('.').map((p) => Number(p)))
    : ipv6ToBytes(id.value)
  return der.implicit(7, bytes)
}

function extension(oid: string, critical: boolean, value: Buffer): Buffer {
  return der.seq(der.oid(oid), ...(critical ? [der.bool(true)] : []), der.octet(value))
}

function leafExtensions(sans: SanIdentifier[]): Buffer[] {
  return [
    extension(OID.basicConstraints, true, der.seq()),
    // digitalSignature only — the one bit an ECDSA TLS server key uses.
    extension(OID.keyUsage, true, der.bitsRaw(7, Buffer.from([0x80]))),
    extension(OID.extKeyUsage, false, der.seq(der.oid(OID.serverAuth))),
    extension(OID.subjectAltName, false, der.seq(...sans.map(generalName)))
  ]
}

const ECDSA_SHA256 = der.seq(der.oid(OID.ecdsaWithSha256))

// ─── Keys ────────────────────────────────────────────────────────────────────

export function generateTlsKey(): { privateKey: KeyObject; publicKey: KeyObject } {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return { privateKey: pair.privateKey, publicKey: pair.publicKey }
}

export function privateKeyToPem(key: KeyObject): string {
  return key.export({ type: 'pkcs8', format: 'pem' }) as string
}

export function privateKeyFromPem(pem: string): KeyObject {
  return createPrivateKey(pem)
}

function spki(publicKey: KeyObject): Buffer {
  return publicKey.export({ type: 'spki', format: 'der' }) as Buffer
}

function signDer(tbs: Buffer, privateKey: KeyObject): Buffer {
  return sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' })
}

function pem(label: string, body: Buffer): string {
  const b64 = body.toString('base64').replace(/(.{64})/g, '$1\n')
  return `-----BEGIN ${label}-----\n${b64.trimEnd()}\n-----END ${label}-----\n`
}

// ─── Self-signed certificate ─────────────────────────────────────────────────

export type SelfSignedOptions = {
  sans: SanIdentifier[]
  /** Subject/issuer CN — defaults to the first identifier. */
  commonName?: string
  validDays?: number
  now?: Date
}

/**
 * A v3 leaf certificate signed by its own key. Browsers warn about it exactly
 * once per profile and then serve the page; that is the whole deal, and the
 * panel says so.
 */
export function createSelfSignedCertificate(
  keys: { privateKey: KeyObject; publicKey: KeyObject },
  options: SelfSignedOptions
): { certPem: string; keyPem: string; notAfter: Date } {
  if (options.sans.length === 0) throw new Error('a certificate needs at least one identifier')
  const now = options.now ?? new Date()
  // Backdated an hour so a phone with a slightly fast clock still accepts it.
  const notBefore = new Date(now.getTime() - 60 * 60_000)
  const notAfter = new Date(now.getTime() + (options.validDays ?? 397) * 24 * 60 * 60_000)
  const cn = options.commonName ?? options.sans[0].value
  const subject = name([
    [OID.commonName, cn],
    [OID.organization, 'Wolffish Web UI']
  ])
  const serial = randomBytes(16)
  serial[0] &= 0x7f
  const tbs = der.seq(
    der.explicit(0, der.int(2)),
    der.int(serial),
    ECDSA_SHA256,
    subject,
    der.seq(der.time(notBefore), der.time(notAfter)),
    subject,
    spki(keys.publicKey),
    der.explicit(3, der.seq(...leafExtensions(options.sans)))
  )
  const certificate = der.seq(tbs, ECDSA_SHA256, der.bits(signDer(tbs, keys.privateKey)))
  return {
    certPem: pem('CERTIFICATE', certificate),
    keyPem: privateKeyToPem(keys.privateKey),
    notAfter
  }
}

// ─── PKCS#10 request ─────────────────────────────────────────────────────────

/**
 * A certificate request carrying the identifiers as a subjectAltName
 * extension request and an EMPTY subject — the CA fills the subject from the
 * SANs, and Let's Encrypt's short-lived profile issues without a CN at all.
 * Returned as DER, which ACME's finalize wants base64url-encoded.
 */
export function createCertificateRequest(
  keys: { privateKey: KeyObject; publicKey: KeyObject },
  sans: SanIdentifier[]
): Buffer {
  if (sans.length === 0) throw new Error('a request needs at least one identifier')
  const extensions = der.seq(
    extension(OID.subjectAltName, false, der.seq(...sans.map(generalName)))
  )
  const attributes = der.implicitConstructed(
    0,
    der.seq(der.oid(OID.extensionRequest), der.set(extensions))
  )
  const info = der.seq(der.int(0), der.seq(), spki(keys.publicKey), attributes)
  return der.seq(info, ECDSA_SHA256, der.bits(signDer(info, keys.privateKey)))
}

export function csrToPem(csr: Buffer): string {
  return pem('CERTIFICATE REQUEST', csr)
}
