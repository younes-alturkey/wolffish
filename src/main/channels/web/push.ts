/**
 * Web Push from first principles — the three RFCs a push service expects,
 * with nothing between them and Node's crypto:
 *
 *   RFC 8291  message encryption (ECDH P-256 + HKDF + AES-128-GCM)
 *   RFC 8188  the `aes128gcm` content coding (header block + one record)
 *   RFC 8292  VAPID — the ES256 JWT that identifies this server to the push
 *             service, so a stolen subscription endpoint is useless without
 *             the private key that lives in config.json
 *
 * Pure: no Electron, no filesystem. `encryptPayload` takes the ephemeral key
 * pair and salt as parameters so the test can replay RFC 8291 Appendix A
 * byte for byte — the only way to know an implementation of this is right is
 * to match the published vector, because a push service answers a wrong body
 * with a 201 and the phone shows nothing.
 */
import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject
} from 'node:crypto'
import https from 'node:https'
import http from 'node:http'

export type VapidKeys = {
  /** Raw uncompressed P-256 point (65 bytes), base64url — what the browser's subscribe() takes. */
  publicKey: string
  /** The 32-byte scalar, base64url. */
  privateKey: string
}

export function generateVapidKeys(): VapidKeys {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = pair.privateKey.export({ format: 'jwk' }) as { d: string; x: string; y: string }
  const raw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url')
  ])
  return { publicKey: raw.toString('base64url'), privateKey: jwk.d }
}

function vapidPrivateKeyObject(keys: VapidKeys): KeyObject {
  const raw = Buffer.from(keys.publicKey, 'base64url')
  if (raw.length !== 65 || raw[0] !== 0x04)
    throw new Error('VAPID public key is not an uncompressed P-256 point')
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: raw.subarray(1, 33).toString('base64url'),
      y: raw.subarray(33, 65).toString('base64url'),
      d: keys.privateKey
    },
    format: 'jwk'
  })
}

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString('base64url')
}

/**
 * The VAPID authorization header for one push endpoint. `aud` is the push
 * service's origin, `exp` at most 24 hours out (12 here), `sub` a contact the
 * push service could write to about abuse.
 */
export function vapidAuthorization(
  keys: VapidKeys,
  endpoint: string,
  subject: string,
  now = Date.now()
): string {
  const url = new URL(endpoint)
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const claims = b64url(
    JSON.stringify({ aud: url.origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })
  )
  const signingInput = `${header}.${claims}`
  const signature = sign('sha256', Buffer.from(signingInput, 'ascii'), {
    key: vapidPrivateKeyObject(keys),
    dsaEncoding: 'ieee-p1363'
  })
  return `vapid t=${signingInput}.${b64url(signature)}, k=${keys.publicKey}`
}

export type PushSubscriptionKeys = { p256dh: string; auth: string }

export type EncryptOptions = {
  /** Ephemeral application-server key pair; generated when omitted. */
  ephemeral?: { privateKey: Buffer; publicKey: Buffer }
  salt?: Buffer
  /** Record size written into the header. Must exceed plaintext + 17. */
  recordSize?: number
}

export type EncryptedPayload = {
  body: Buffer
  /** Intermediate values, exposed for the RFC 8291 vector test. */
  derived: { sharedSecret: Buffer; ikm: Buffer; cek: Buffer; nonce: Buffer }
}

const KEY_INFO_PREFIX = Buffer.from('WebPush: info\0', 'ascii')
const CEK_INFO = Buffer.from('Content-Encoding: aes128gcm\0', 'ascii')
const NONCE_INFO = Buffer.from('Content-Encoding: nonce\0', 'ascii')

/** RFC 8291 §3 + RFC 8188 §2: one record, delimiter 0x02, no padding. */
export function encryptPayload(
  plaintext: Buffer,
  subscription: PushSubscriptionKeys,
  options: EncryptOptions = {}
): EncryptedPayload {
  const uaPublic = Buffer.from(subscription.p256dh, 'base64url')
  const authSecret = Buffer.from(subscription.auth, 'base64url')
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04)
    throw new Error('subscription p256dh is not an uncompressed P-256 point')
  if (authSecret.length !== 16) throw new Error('subscription auth secret must be 16 bytes')

  const ecdh = createECDH('prime256v1')
  let asPublic: Buffer
  if (options.ephemeral) {
    ecdh.setPrivateKey(options.ephemeral.privateKey)
    asPublic = options.ephemeral.publicKey
  } else {
    asPublic = ecdh.generateKeys()
  }
  const sharedSecret = ecdh.computeSecret(uaPublic)
  const keyInfo = Buffer.concat([KEY_INFO_PREFIX, uaPublic, asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32))
  const salt = options.salt ?? randomBytes(16)
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, CEK_INFO, 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, NONCE_INFO, 12))

  const recordSize = options.recordSize ?? 4096
  if (plaintext.length + 17 > recordSize) throw new Error('payload too large for one record')
  const padded = Buffer.concat([plaintext, Buffer.from([0x02])])
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()])

  const header = Buffer.alloc(16 + 4 + 1)
  salt.copy(header, 0)
  header.writeUInt32BE(recordSize, 16)
  header[20] = asPublic.length
  return {
    body: Buffer.concat([header, asPublic, ciphertext]),
    derived: { sharedSecret, ikm, cek, nonce }
  }
}

export type PushDeliveryResult =
  | { ok: true; status: number }
  | { ok: false; status: number; gone: boolean; error: string }

export type PushMessage = {
  payload: Buffer
  ttlSeconds: number
  urgency: 'very-low' | 'low' | 'normal' | 'high'
  /** Collapses earlier undelivered messages with the same topic. */
  topic?: string
}

/**
 * Deliver one encrypted message to one subscription. 404 and 410 mean the
 * subscription is dead and should be dropped; everything else is reported as
 * a transient failure. Never throws.
 */
export function sendWebPush(
  subscription: { endpoint: string; keys: PushSubscriptionKeys },
  message: PushMessage,
  vapid: VapidKeys,
  subject: string
): Promise<PushDeliveryResult> {
  return new Promise((resolve) => {
    let body: Buffer
    let authorization: string
    try {
      body = encryptPayload(message.payload, subscription.keys).body
      authorization = vapidAuthorization(vapid, subscription.endpoint, subject)
    } catch (err) {
      resolve({
        ok: false,
        status: 0,
        gone: false,
        error: err instanceof Error ? err.message : String(err)
      })
      return
    }
    const url = new URL(subscription.endpoint)
    const client = url.protocol === 'http:' ? http : https
    const req = client.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Encoding': 'aes128gcm',
          'Content-Length': body.length,
          TTL: String(message.ttlSeconds),
          Urgency: message.urgency,
          ...(message.topic ? { Topic: message.topic } : {}),
          Authorization: authorization
        },
        timeout: 15_000
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const status = res.statusCode ?? 0
          if (status >= 200 && status < 300) resolve({ ok: true, status })
          else {
            resolve({
              ok: false,
              status,
              gone: status === 404 || status === 410,
              error: `push service answered ${status}: ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`
            })
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('push request timed out')))
    req.on('error', (err) => resolve({ ok: false, status: 0, gone: false, error: err.message }))
    req.end(body)
  })
}

/** The public key as the browser's `applicationServerKey` wants it — the raw point. */
export function vapidApplicationServerKey(keys: VapidKeys): Buffer {
  return Buffer.from(keys.publicKey, 'base64url')
}

/** Parse the key the browser hands back, so a malformed subscription is refused at registration. */
export function validateSubscriptionKeys(keys: unknown): keys is PushSubscriptionKeys {
  if (!keys || typeof keys !== 'object') return false
  const k = keys as Record<string, unknown>
  if (typeof k.p256dh !== 'string' || typeof k.auth !== 'string') return false
  try {
    const point = Buffer.from(k.p256dh, 'base64url')
    const auth = Buffer.from(k.auth, 'base64url')
    if (point.length !== 65 || point[0] !== 0x04 || auth.length !== 16) return false
    createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33).toString('base64url')
      },
      format: 'jwk'
    })
    return true
  } catch {
    return false
  }
}
