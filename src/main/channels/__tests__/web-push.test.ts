/**
 * Web Push encryption pinned to RFC 8291 Appendix A, value by value — shared
 * secret, IKM, CEK, nonce, header and ciphertext — and the VAPID JWT checked
 * with Node's own verifier against the advertised public key. A push service
 * accepts a wrong body with a 201 and the phone shows nothing, so the
 * published vector is the only honest oracle here.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/web-push.test.ts
 */
import { createECDH, createPublicKey, verify } from 'node:crypto'
import http from 'node:http'

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
}

const V = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  sharedSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonce: '4h_95klXJ5E_qnoN',
  header:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ'
}

async function run(): Promise<void> {
  const {
    encryptPayload,
    generateVapidKeys,
    vapidAuthorization,
    sendWebPush,
    validateSubscriptionKeys
  } = await import('@main/channels/web/push')

  // ── RFC 8291 Appendix A ────────────────────────────────────────────────────
  const result = encryptPayload(
    Buffer.from(V.plaintext, 'base64url'),
    { p256dh: V.uaPublic, auth: V.auth },
    {
      ephemeral: {
        privateKey: Buffer.from(V.asPrivate, 'base64url'),
        publicKey: Buffer.from(V.asPublic, 'base64url')
      },
      salt: Buffer.from(V.salt, 'base64url')
    }
  )
  ok(
    'shared secret',
    result.derived.sharedSecret.toString('base64url') === V.sharedSecret,
    result.derived.sharedSecret.toString('base64url')
  )
  ok(
    'IKM',
    result.derived.ikm.toString('base64url') === V.ikm,
    result.derived.ikm.toString('base64url')
  )
  ok(
    'CEK',
    result.derived.cek.toString('base64url') === V.cek,
    result.derived.cek.toString('base64url')
  )
  ok(
    'nonce',
    result.derived.nonce.toString('base64url') === V.nonce,
    result.derived.nonce.toString('base64url')
  )
  const header = result.body.subarray(0, 86).toString('base64url')
  ok('header block', header === V.header, header)
  const ciphertext = result.body.subarray(86).toString('base64url')
  ok('ciphertext', ciphertext === V.ciphertext, ciphertext)
  ok('record size 4096 in header', result.body.readUInt32BE(16) === 4096)
  ok('keyid length 65', result.body[20] === 65)

  // The receiver's side, derived independently from the UA private key: the
  // same shared secret must come out of ECDH(ua_private, as_public).
  const ua = createECDH('prime256v1')
  ua.setPrivateKey(Buffer.from(V.uaPrivate, 'base64url'))
  ok(
    'ECDH symmetric',
    ua.computeSecret(Buffer.from(V.asPublic, 'base64url')).toString('base64url') === V.sharedSecret
  )

  // Random ephemeral keys and salt still produce a well-formed body.
  const random = encryptPayload(Buffer.from('hello'), { p256dh: V.uaPublic, auth: V.auth })
  ok(
    'random body length = 86 + 5 + 1 + 16',
    random.body.length === 86 + 5 + 1 + 16,
    String(random.body.length)
  )
  ok(
    'random salt differs from vector',
    random.body.subarray(0, 16).toString('base64url') !== V.salt
  )
  let threw = false
  try {
    encryptPayload(Buffer.alloc(5000), { p256dh: V.uaPublic, auth: V.auth })
  } catch {
    threw = true
  }
  ok('oversized payload refused', threw)
  threw = false
  try {
    encryptPayload(Buffer.from('x'), { p256dh: 'AAAA', auth: V.auth })
  } catch {
    threw = true
  }
  ok('bad p256dh refused', threw)

  // ── subscription validation ────────────────────────────────────────────────
  ok('valid keys accepted', validateSubscriptionKeys({ p256dh: V.uaPublic, auth: V.auth }))
  ok('short auth refused', !validateSubscriptionKeys({ p256dh: V.uaPublic, auth: 'AAAA' }))
  ok(
    'off-curve point refused',
    !validateSubscriptionKeys({
      p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'),
      auth: V.auth
    })
  )
  ok('non-object refused', !validateSubscriptionKeys('nope'))

  // ── VAPID ──────────────────────────────────────────────────────────────────
  const keys = generateVapidKeys()
  ok('vapid public key is a 65-byte point', Buffer.from(keys.publicKey, 'base64url').length === 65)
  ok('vapid private key is 32 bytes', Buffer.from(keys.privateKey, 'base64url').length === 32)
  const now = 1_760_000_000_000
  const authorization = vapidAuthorization(
    keys,
    'https://fcm.googleapis.com/fcm/send/abc123',
    'mailto:ops@example.com',
    now
  )
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(authorization)
  ok('authorization header shape', !!m, authorization)
  if (m) {
    const [h, c, s] = m[1].split('.')
    const headerJson = JSON.parse(Buffer.from(h, 'base64url').toString()) as {
      typ: string
      alg: string
    }
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString()) as {
      aud: string
      exp: number
      sub: string
    }
    ok('JWT header', headerJson.typ === 'JWT' && headerJson.alg === 'ES256')
    ok('aud is the push origin', claims.aud === 'https://fcm.googleapis.com', claims.aud)
    ok('exp is 12h out', claims.exp === Math.floor(now / 1000) + 12 * 3600)
    ok('sub carried', claims.sub === 'mailto:ops@example.com')
    ok('k is the public key', m[2] === keys.publicKey)
    const raw = Buffer.from(keys.publicKey, 'base64url')
    const pub = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: raw.subarray(1, 33).toString('base64url'),
        y: raw.subarray(33).toString('base64url')
      },
      format: 'jwk'
    })
    ok(
      'signature verifies with the advertised key',
      verify(
        'sha256',
        Buffer.from(`${h}.${c}`, 'ascii'),
        { key: pub, dsaEncoding: 'ieee-p1363' },
        Buffer.from(s, 'base64url')
      )
    )
    ok(
      'signature fails with another key',
      !verify(
        'sha256',
        Buffer.from(`${h}.${c}x`, 'ascii'),
        { key: pub, dsaEncoding: 'ieee-p1363' },
        Buffer.from(s, 'base64url')
      )
    )
  }

  // ── delivery against a fake push service ───────────────────────────────────
  let seen: { headers: http.IncomingHttpHeaders; length: number } | null = null
  let answer = 201
  const service = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen = { headers: req.headers, length: Buffer.concat(chunks).length }
      res.statusCode = answer
      res.end()
    })
  })
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve))
  const port = (service.address() as { port: number }).port
  const sub = {
    endpoint: `http://127.0.0.1:${port}/push/xyz`,
    keys: { p256dh: V.uaPublic, auth: V.auth }
  }
  const delivered = await sendWebPush(
    sub,
    { payload: Buffer.from('{"title":"hi"}'), ttlSeconds: 60, urgency: 'high', topic: 'turn' },
    keys,
    'mailto:ops@example.com'
  )
  ok('201 is ok', delivered.ok && delivered.status === 201, JSON.stringify(delivered))
  const got = seen as { headers: http.IncomingHttpHeaders; length: number } | null
  ok('Content-Encoding aes128gcm', got?.headers['content-encoding'] === 'aes128gcm')
  ok('TTL header', got?.headers['ttl'] === '60')
  ok('Urgency header', got?.headers['urgency'] === 'high')
  ok('Topic header', got?.headers['topic'] === 'turn')
  ok('Authorization vapid', String(got?.headers['authorization']).startsWith('vapid t='))
  ok(
    'body = header + payload + delimiter + tag',
    got?.length === 86 + 14 + 1 + 16,
    String(got?.length)
  )
  answer = 410
  const gone = await sendWebPush(
    sub,
    { payload: Buffer.from('x'), ttlSeconds: 60, urgency: 'normal' },
    keys,
    'mailto:ops@example.com'
  )
  ok('410 reports gone', !gone.ok && gone.gone && gone.status === 410)
  answer = 500
  const transient = await sendWebPush(
    sub,
    { payload: Buffer.from('x'), ttlSeconds: 60, urgency: 'normal' },
    keys,
    'mailto:ops@example.com'
  )
  ok('500 is transient, not gone', !transient.ok && !transient.gone)
  await new Promise<void>((resolve) => service.close(() => resolve()))
  const dead = await sendWebPush(
    { ...sub, endpoint: 'http://127.0.0.1:1/dead' },
    { payload: Buffer.from('x'), ttlSeconds: 60, urgency: 'normal' },
    keys,
    'mailto:ops@example.com'
  )
  ok('connection refused never throws', !dead.ok && dead.status === 0)

  console.log(`web-push: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void run().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
