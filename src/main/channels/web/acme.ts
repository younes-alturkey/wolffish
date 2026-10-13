/**
 * An ACME v2 client (RFC 8555) that is exactly as large as the Web UI needs:
 * one account, one order at a time, HTTP-01 only, ES256 everywhere.
 *
 * Why in-process rather than "install certbot": the point of the channel is
 * a browser on a phone reaching a VPS by its bare IP address, with
 * notifications — which a browser only allows on a trusted HTTPS origin.
 * Let's Encrypt issues certificates for IP addresses (RFC 8738 identifiers,
 * the `shortlived` profile, 160-hour lifetime), so the app can hold a
 * trusted certificate for its own address with no DNS, no domain and no
 * second tool to install — as long as it renews on its own every few days,
 * which is what `shouldRenew` and the server's timer are for.
 *
 * Pure of Electron and of the filesystem: the caller passes a challenge
 * store the HTTP listener consults, and gets PEM back. The test drives it
 * against Pebble, Let's Encrypt's own test server, which is the independent
 * route for a protocol implementation.
 */
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign,
  type KeyObject
} from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import {
  classifyIdentifier,
  createCertificateRequest,
  generateTlsKey,
  privateKeyToPem,
  type SanIdentifier
} from '@main/channels/web/x509'

export const LETS_ENCRYPT_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory'
export const LETS_ENCRYPT_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory'

/** `production` / `staging` shorthands, or a directory URL as typed. */
export function resolveDirectoryUrl(value: string | undefined): string {
  const v = (value ?? '').trim()
  if (!v || v === 'production') return LETS_ENCRYPT_PRODUCTION
  if (v === 'staging') return LETS_ENCRYPT_STAGING
  return v
}

/** The profile IP identifiers require; hostnames alone take the CA's default. */
export const SHORTLIVED_PROFILE = 'shortlived'

export type AcmeDirectory = {
  newNonce: string
  newAccount: string
  newOrder: string
  meta?: { termsOfService?: string; profiles?: Record<string, string> }
}

export type AcmeAccount = {
  /** PKCS#8 PEM of the account key. */
  keyPem: string
  /** The account URL — the `kid` every later request is signed under. */
  url: string
  directory: string
}

export type AcmeIssued = {
  certPem: string
  keyPem: string
  notBefore: Date
  notAfter: Date
  identifiers: SanIdentifier[]
  profile: string | null
}

/** What the HTTP listener serves at /.well-known/acme-challenge/<token>. */
export class ChallengeStore {
  private readonly responses = new Map<string, string>()
  set(token: string, keyAuthorization: string): void {
    this.responses.set(token, keyAuthorization)
  }
  get(token: string): string | null {
    return this.responses.get(token) ?? null
  }
  clear(token: string): void {
    this.responses.delete(token)
  }
}

export type AcmeLogger = (line: string) => void

/** Where an issuance is, for a progress display: one callback per milestone. */
export type AcmeStage = 'account' | 'order' | 'challenge' | 'validated' | 'finalize' | 'certificate'

export type AcmeClientOptions = {
  directoryUrl: string
  challenges: ChallengeStore
  /** Extra trusted root for the ACME API itself — Pebble's test CA. */
  ca?: string
  log?: AcmeLogger
  /** Polling cadence, shortened by the test. */
  pollIntervalMs?: number
  pollTimeoutMs?: number
  /** Called at each milestone of issue(); the panel's stepper listens. */
  onStage?: (stage: AcmeStage, detail: string) => void
}

type Problem = { type?: string; detail?: string; status?: number }

export class AcmeError extends Error {
  constructor(
    message: string,
    readonly problem: Problem | null = null,
    readonly status = 0
  ) {
    super(message)
  }
}

type Response = { status: number; headers: http.IncomingHttpHeaders; body: Buffer }

function request(
  url: string,
  init: {
    method: 'GET' | 'HEAD' | 'POST'
    headers?: Record<string, string>
    body?: Buffer
    ca?: string
  }
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const client = u.protocol === 'http:' ? http : https
    const req = client.request(
      u,
      {
        method: init.method,
        headers: { 'User-Agent': 'wolffish-web-ui-acme/1', ...(init.headers ?? {}) },
        ...(init.ca ? { ca: init.ca } : {}),
        timeout: 30_000
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks)
          })
        )
      }
    )
    req.on('timeout', () => req.destroy(new Error(`${init.method} ${url} timed out`)))
    req.on('error', reject)
    req.end(init.body)
  })
}

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString('base64url')
}

/** RFC 7638 thumbprint of a P-256 key — members in lexicographic order, no whitespace. */
export function jwkThumbprint(jwk: { crv: string; kty: string; x: string; y: string }): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })
  return createHash('sha256').update(canonical, 'utf8').digest('base64url')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class AcmeClient {
  private directory: AcmeDirectory | null = null
  private nonce: string | null = null
  private readonly log: AcmeLogger
  private readonly pollIntervalMs: number
  private readonly pollTimeoutMs: number

  constructor(private readonly options: AcmeClientOptions) {
    this.log = options.log ?? (() => undefined)
    this.pollIntervalMs = options.pollIntervalMs ?? 2000
    this.pollTimeoutMs = options.pollTimeoutMs ?? 5 * 60_000
  }

  async getDirectory(): Promise<AcmeDirectory> {
    if (this.directory) return this.directory
    const res = await request(this.options.directoryUrl, { method: 'GET', ca: this.options.ca })
    if (res.status !== 200)
      throw new AcmeError(`directory fetch failed with ${res.status}`, null, res.status)
    const dir = JSON.parse(res.body.toString('utf8')) as AcmeDirectory
    if (!dir.newNonce || !dir.newAccount || !dir.newOrder)
      throw new AcmeError('directory is missing endpoints')
    this.directory = dir
    return dir
  }

  private async freshNonce(): Promise<string> {
    if (this.nonce) {
      const n = this.nonce
      this.nonce = null
      return n
    }
    const dir = await this.getDirectory()
    const res = await request(dir.newNonce, { method: 'HEAD', ca: this.options.ca })
    const nonce = res.headers['replay-nonce']
    if (typeof nonce !== 'string') throw new AcmeError('newNonce returned no Replay-Nonce')
    return nonce
  }

  private rememberNonce(res: Response): void {
    const nonce = res.headers['replay-nonce']
    if (typeof nonce === 'string') this.nonce = nonce
  }

  /**
   * One signed POST (or POST-as-GET when payload is null). A `badNonce`
   * rejection is retried with the nonce the rejection itself carried — the
   * one case RFC 8555 §6.5 says must be retried silently.
   */
  private async signedPost(
    url: string,
    key: KeyObject,
    payload: Record<string, unknown> | null,
    auth: { jwk: Record<string, string> } | { kid: string },
    accept?: string
  ): Promise<Response> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const nonce = await this.freshNonce()
      const protectedHeader = { alg: 'ES256', nonce, url, ...auth }
      const protectedB64 = b64url(JSON.stringify(protectedHeader))
      const payloadB64 = payload === null ? '' : b64url(JSON.stringify(payload))
      const signature = sign('sha256', Buffer.from(`${protectedB64}.${payloadB64}`, 'ascii'), {
        key,
        dsaEncoding: 'ieee-p1363'
      })
      const body = Buffer.from(
        JSON.stringify({
          protected: protectedB64,
          payload: payloadB64,
          signature: b64url(signature)
        })
      )
      const res = await request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/jose+json', ...(accept ? { Accept: accept } : {}) },
        body,
        ca: this.options.ca
      })
      this.rememberNonce(res)
      if (res.status >= 400) {
        let problem: Problem | null = null
        try {
          problem = JSON.parse(res.body.toString('utf8')) as Problem
        } catch {
          problem = null
        }
        if (problem?.type?.endsWith(':badNonce') && attempt < 9) {
          this.log(`badNonce from ${url} — retrying`)
          continue
        }
        const detail =
          problem?.detail ?? (res.body.toString('utf8').slice(0, 200) || 'ACME request failed')
        throw new AcmeError(`${detail} (${res.status})`, problem, res.status)
      }
      return res
    }
    throw new AcmeError('too many badNonce retries')
  }

  /** Create the account, or find the existing one for this key. */
  async ensureAccount(existing: AcmeAccount | null, email?: string): Promise<AcmeAccount> {
    const dir = await this.getDirectory()
    if (existing && existing.directory === this.options.directoryUrl) {
      return existing
    }
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const jwkFull = pair.publicKey.export({ format: 'jwk' }) as {
      kty: string
      crv: string
      x: string
      y: string
    }
    const jwk = { kty: jwkFull.kty, crv: jwkFull.crv, x: jwkFull.x, y: jwkFull.y }
    const contact = email && email.trim() ? { contact: [`mailto:${email.trim()}`] } : {}
    const res = await this.signedPost(
      dir.newAccount,
      pair.privateKey,
      { termsOfServiceAgreed: true, ...contact },
      { jwk }
    )
    const url = res.headers.location
    if (typeof url !== 'string') throw new AcmeError('newAccount returned no Location')
    this.log(`account ${res.status === 201 ? 'created' : 'found'}: ${url}`)
    this.options.onStage?.('account', res.status === 201 ? 'account created' : 'account found')
    return { keyPem: privateKeyToPem(pair.privateKey), url, directory: this.options.directoryUrl }
  }

  /**
   * Order, prove, finalize, download. The TLS key is generated fresh per
   * certificate — a 6-day certificate does not need a long-lived key.
   */
  async issue(account: AcmeAccount, identifiers: SanIdentifier[]): Promise<AcmeIssued> {
    if (identifiers.length === 0) throw new AcmeError('no identifiers to certify')
    const dir = await this.getDirectory()
    const accountKey = createPrivateKey(account.keyPem)
    const auth = { kid: account.url }
    const jwkFull = accountKey.export({ format: 'jwk' }) as {
      kty: string
      crv: string
      x: string
      y: string
    }
    const thumbprint = jwkThumbprint({
      kty: jwkFull.kty,
      crv: jwkFull.crv,
      x: jwkFull.x,
      y: jwkFull.y
    })

    // IP identifiers are only issued under the short-lived profile; a mixed
    // order takes it too (the profile allows DNS names as well).
    const wantsIp = identifiers.some((id) => id.type === 'ip')
    const profiles = dir.meta?.profiles ?? {}
    const profile = wantsIp ? SHORTLIVED_PROFILE : null
    if (profile && Object.keys(profiles).length > 0 && !(profile in profiles)) {
      throw new AcmeError(
        `this CA offers no "${profile}" profile (it has: ${Object.keys(profiles).join(', ')}) — IP address certificates need it`
      )
    }

    const orderRes = await this.signedPost(
      dir.newOrder,
      accountKey,
      {
        identifiers: identifiers.map((id) => ({ type: id.type, value: id.value })),
        ...(profile ? { profile } : {})
      },
      auth
    )
    const orderUrl = orderRes.headers.location
    if (typeof orderUrl !== 'string') throw new AcmeError('newOrder returned no Location')
    let order = JSON.parse(orderRes.body.toString('utf8')) as {
      status: string
      authorizations: string[]
      finalize: string
      certificate?: string
    }
    this.log(
      `order ${orderUrl} (${order.status}, ${order.authorizations.length} authorizations${profile ? `, profile ${profile}` : ''})`
    )
    this.options.onStage?.(
      'order',
      `order placed${profile ? ` (${profile} profile)` : ''}, ${order.authorizations.length} ${order.authorizations.length === 1 ? 'identifier' : 'identifiers'} to prove`
    )

    const tokens: string[] = []
    try {
      for (const authzUrl of order.authorizations) {
        const authzRes = await this.signedPost(authzUrl, accountKey, null, auth)
        const authz = JSON.parse(authzRes.body.toString('utf8')) as {
          status: string
          identifier: { type: string; value: string }
          challenges: Array<{ type: string; url: string; token: string; status: string }>
        }
        if (authz.status === 'valid') {
          this.log(`${authz.identifier.value}: already authorized`)
          continue
        }
        const challenge = authz.challenges.find((c) => c.type === 'http-01')
        if (!challenge)
          throw new AcmeError(`${authz.identifier.value}: the CA offered no http-01 challenge`)
        const keyAuthorization = `${challenge.token}.${thumbprint}`
        this.options.challenges.set(challenge.token, keyAuthorization)
        tokens.push(challenge.token)
        await this.signedPost(challenge.url, accountKey, {}, auth)
        this.log(`${authz.identifier.value}: http-01 challenge accepted, waiting for validation`)
        this.options.onStage?.(
          'challenge',
          `${authz.identifier.value}: waiting for the CA to fetch the challenge over port 80`
        )
        await this.poll(
          authzUrl,
          accountKey,
          auth,
          (status) => status === 'valid',
          (status, body) => {
            if (status === 'invalid') {
              const failed = (body as { challenges?: Array<{ error?: Problem }> }).challenges?.find(
                (c) => c.error
              )
              throw new AcmeError(
                `${authz.identifier.value}: validation failed — ${failed?.error?.detail ?? 'the CA could not reach the challenge'}`,
                failed?.error ?? null
              )
            }
          }
        )
        this.log(`${authz.identifier.value}: validated`)
        this.options.onStage?.('validated', `${authz.identifier.value}: validated`)
      }
    } finally {
      for (const token of tokens) this.options.challenges.clear(token)
    }

    const tlsKey = generateTlsKey()
    const csr = createCertificateRequest(tlsKey, identifiers)
    await this.signedPost(order.finalize, accountKey, { csr: b64url(csr) }, auth)
    this.options.onStage?.('finalize', 'certificate request submitted')
    order = (await this.poll(
      orderUrl,
      accountKey,
      auth,
      (status) => status === 'valid',
      (status, body) => {
        if (status === 'invalid') {
          throw new AcmeError(
            `order failed — ${(body as { error?: Problem }).error?.detail ?? 'unknown reason'}`
          )
        }
      }
    )) as typeof order
    if (!order.certificate) throw new AcmeError('order is valid but names no certificate')
    const certRes = await this.signedPost(
      order.certificate,
      accountKey,
      null,
      auth,
      'application/pem-certificate-chain'
    )
    const certPem = certRes.body.toString('utf8')
    if (!certPem.includes('-----BEGIN CERTIFICATE-----'))
      throw new AcmeError('certificate download was not PEM')
    const { X509Certificate } = await import('node:crypto')
    const leaf = new X509Certificate(certPem)
    this.log(`certificate issued: ${leaf.subjectAltName ?? leaf.subject}, expires ${leaf.validTo}`)
    this.options.onStage?.('certificate', `issued, valid until ${leaf.validTo}`)
    return {
      certPem,
      keyPem: privateKeyToPem(tlsKey.privateKey),
      notBefore: new Date(leaf.validFrom),
      notAfter: new Date(leaf.validTo),
      identifiers,
      profile
    }
  }

  private async poll(
    url: string,
    key: KeyObject,
    auth: { kid: string },
    done: (status: string) => boolean,
    inspect: (status: string, body: unknown) => void
  ): Promise<unknown> {
    const deadline = Date.now() + this.pollTimeoutMs
    for (;;) {
      const res = await this.signedPost(url, key, null, auth)
      const body = JSON.parse(res.body.toString('utf8')) as { status: string }
      inspect(body.status, body)
      if (done(body.status)) return body
      if (Date.now() > deadline)
        throw new AcmeError(`timed out waiting on ${url} (last status: ${body.status})`)
      const retryAfter = Number(res.headers['retry-after'])
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 30_000)
          : this.pollIntervalMs
      )
    }
  }
}

/**
 * Renew once a third of the lifetime is left: for a 160-hour certificate that
 * is about 53 hours out, so a box that was offline for a weekend still has a
 * valid certificate on Monday and two days of retries ahead of it.
 */
export function shouldRenew(notBefore: Date, notAfter: Date, now = new Date()): boolean {
  const lifetime = notAfter.getTime() - notBefore.getTime()
  if (lifetime <= 0) return true
  return notAfter.getTime() - now.getTime() < lifetime / 3
}

/** Parse the panel's identifier list; invalid entries are reported, not dropped silently. */
export function parseIdentifiers(raw: string[]): {
  identifiers: SanIdentifier[]
  invalid: string[]
} {
  const identifiers: SanIdentifier[] = []
  const invalid: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const id = classifyIdentifier(entry)
    if (!id) {
      if (entry.trim()) invalid.push(entry)
      continue
    }
    const key = `${id.type}:${id.value}`
    if (seen.has(key)) continue
    seen.add(key)
    identifiers.push(id)
  }
  return { identifiers, invalid }
}
