/**
 * Where the Web UI's certificate comes from, for each of the three HTTPS
 * modes, and when it gets replaced.
 *
 *   selfsigned  minted in-process (x509.ts) for every address this box has,
 *               kept on disk and reminted when it nears expiry or an address
 *               it was not issued for appears
 *   custom      two files the user points at — read, never written
 *   acme        asked of Let's Encrypt (acme.ts) for the configured IPs and
 *               hostnames, persisted, renewed by the server's six-hourly
 *               check once 72 hours (or a third of the lifetime) are left;
 *               the feature's state, its attempt log and the time of the next
 *               check live in acme.state.json beside the certificate
 *
 * Everything lives under ~/.wolffish/workspace/web/tls — inside the one tree
 * the app is allowed to write. Keys are 0600 on POSIX and, best effort, owner
 * only on Windows.
 */
import {
  AcmeClient,
  ChallengeStore,
  LETS_ENCRYPT_PRODUCTION,
  LETS_ENCRYPT_STAGING,
  parseIdentifiers,
  resolveDirectoryUrl,
  type AcmeAccount,
  type AcmeLogger,
  type AcmeStage
} from '@main/channels/web/acme'
import {
  EMPTY_HTTPS_META,
  normalizeMeta,
  recordAttempt,
  renewalDue,
  type HttpsMeta,
  type HttpsState,
  type RenewalAttempt
} from '@main/channels/web/https-state'
import {
  classifyIdentifier,
  createSelfSignedCertificate,
  generateTlsKey,
  type SanIdentifier
} from '@main/channels/web/x509'
import { diskWriter } from '@main/io/diskWriter'
import type { WebUiConfig } from '@main/workspace/workspace'
import { execFile } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export type TlsSource = 'selfsigned' | 'custom' | 'acme'

export type TlsMaterial = {
  cert: string
  key: string
  source: TlsSource
  notBefore: Date | null
  notAfter: Date | null
  issuer: string | null
  subjectAltName: string | null
  /** The names in the SAN list, without their type prefixes. */
  sans: string[]
  serial: string | null
  /** SHA-256 of the DER certificate, colon-separated, as browsers show it. */
  fingerprint256: string | null
}

export type AcmeState = {
  state: 'idle' | 'issuing' | 'ok' | 'error'
  lastError: string | null
  lastAttemptAt: number | null
  lastIssuedAt: number | null
  notAfter: number | null
  identifiers: string[]
  directory: string
}

type AcmeMeta = {
  identifiers: SanIdentifier[]
  directory: string
  issuedAt: number
  notBefore: number
  notAfter: number
}

const SELF_SIGNED_DAYS = 397
/** Remint a self-signed certificate with this long left — well before any browser complains. */
const SELF_SIGNED_RENEW_DAYS = 30

export class TlsManager {
  private acmeInFlight: Promise<TlsMaterial> | null = null
  readonly acmeState: AcmeState = {
    state: 'idle',
    lastError: null,
    lastAttemptAt: null,
    lastIssuedAt: null,
    notAfter: null,
    identifiers: [],
    directory: resolveDirectoryUrl(undefined)
  }

  constructor(
    private readonly dir: string,
    private readonly log: AcmeLogger
  ) {}

  private file(name: string): string {
    return path.join(this.dir, name)
  }

  private async write(name: string, data: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    await diskWriter.writeFileAtomic(this.file(name), data)
    if (name.endsWith('key.pem') || name.endsWith('account.json')) {
      await restrictToOwner(this.file(name))
    }
  }

  // ─── state, persisted beside the certificate ───────────────────────────────

  private meta: HttpsMeta | null = null

  async getMeta(): Promise<HttpsMeta> {
    if (this.meta) return this.meta
    const raw = await this.read('acme.state.json')
    let parsed: unknown = null
    try {
      parsed = raw ? JSON.parse(raw) : null
    } catch {
      parsed = null
    }
    this.meta = parsed ? normalizeMeta(parsed) : { ...EMPTY_HTTPS_META, history: [] }
    return this.meta
  }

  private async saveMeta(next: HttpsMeta): Promise<HttpsMeta> {
    this.meta = next
    await this.write('acme.state.json', JSON.stringify(next, null, 2))
    return next
  }

  async setState(state: HttpsState, extra: Partial<HttpsMeta> = {}): Promise<HttpsMeta> {
    const current = await this.getMeta()
    if (current.state === state && Object.keys(extra).length === 0) return current
    return this.saveMeta({ ...current, ...extra, state })
  }

  async record(attempt: RenewalAttempt): Promise<HttpsMeta> {
    return this.saveMeta(recordAttempt(await this.getMeta(), attempt))
  }

  async setNextCheck(at: number | null): Promise<HttpsMeta> {
    const current = await this.getMeta()
    if (current.nextCheckAt === at) return current
    return this.saveMeta({ ...current, nextCheckAt: at })
  }

  private async read(name: string): Promise<string | null> {
    try {
      return await fs.readFile(this.file(name), 'utf8')
    } catch {
      return null
    }
  }

  // ─── self-signed ───────────────────────────────────────────────────────────

  /**
   * The SAN list a self-signed certificate must cover: every address a
   * browser might type, so the one warning the user clicks through is for the
   * address they actually used.
   */
  private selfSignedSans(config: WebUiConfig, localAddresses: string[]): SanIdentifier[] {
    const raw = [
      ...localAddresses,
      '127.0.0.1',
      '::1',
      'localhost',
      ...(config.https?.acme?.identifiers ?? [])
    ]
    return parseIdentifiers(raw).identifiers
  }

  async selfSigned(config: WebUiConfig, localAddresses: string[]): Promise<TlsMaterial> {
    const sans = this.selfSignedSans(config, localAddresses)
    const certPem = await this.read('selfsigned.cert.pem')
    const keyPem = await this.read('selfsigned.key.pem')
    if (certPem && keyPem) {
      try {
        const parsed = new X509Certificate(certPem)
        const daysLeft = (new Date(parsed.validTo).getTime() - Date.now()) / 86_400_000
        const covers = sans.every((id) =>
          id.type === 'ip'
            ? parsed.checkIP(id.value) !== undefined
            : parsed.checkHost(id.value) !== undefined
        )
        if (daysLeft > SELF_SIGNED_RENEW_DAYS && covers) {
          return describe(certPem, keyPem, 'selfsigned')
        }
        this.log(
          covers
            ? `self-signed certificate expires in ${Math.round(daysLeft)} days — reminting`
            : 'self-signed certificate does not cover every current address — reminting'
        )
      } catch {
        this.log('stored self-signed certificate is unreadable — reminting')
      }
    }
    const minted = createSelfSignedCertificate(generateTlsKey(), {
      sans,
      validDays: SELF_SIGNED_DAYS
    })
    await this.write('selfsigned.cert.pem', minted.certPem)
    await this.write('selfsigned.key.pem', minted.keyPem)
    this.log(`self-signed certificate minted for ${sans.map((s) => s.value).join(', ')}`)
    return describe(minted.certPem, minted.keyPem, 'selfsigned')
  }

  // ─── custom ────────────────────────────────────────────────────────────────

  async custom(config: WebUiConfig): Promise<TlsMaterial> {
    const certPath = config.https?.custom?.certPath?.trim()
    const keyPath = config.https?.custom?.keyPath?.trim()
    if (!certPath || !keyPath)
      throw new Error('custom HTTPS needs both a certificate file and a key file')
    const cert = await fs.readFile(certPath, 'utf8')
    const key = await fs.readFile(keyPath, 'utf8')
    const material = describe(cert, key, 'custom')
    if (!material.cert.includes('BEGIN CERTIFICATE'))
      throw new Error(`${certPath} is not a PEM certificate`)
    return material
  }

  // ─── acme ──────────────────────────────────────────────────────────────────

  private async loadAcme(): Promise<{ material: TlsMaterial; meta: AcmeMeta } | null> {
    const cert = await this.read('acme.cert.pem')
    const key = await this.read('acme.key.pem')
    const metaRaw = await this.read('acme.meta.json')
    if (!cert || !key || !metaRaw) return null
    try {
      const meta = JSON.parse(metaRaw) as AcmeMeta
      return { material: describe(cert, key, 'acme'), meta }
    } catch {
      return null
    }
  }

  private async loadAccount(): Promise<AcmeAccount | null> {
    const raw = await this.read('acme.account.json')
    if (!raw) return null
    try {
      return JSON.parse(raw) as AcmeAccount
    } catch {
      return null
    }
  }

  private acmeIdentifiers(config: WebUiConfig, directory: string): SanIdentifier[] {
    const { identifiers, invalid } = parseIdentifiers(config.https?.acme?.identifiers ?? [])
    if (invalid.length > 0) throw new Error(`not an IP address or hostname: ${invalid.join(', ')}`)
    if (identifiers.length === 0) {
      throw new Error("Let's Encrypt needs at least one public IP address or hostname to certify")
    }
    // The public-reachability rules are Let's Encrypt's. A private CA of the
    // user's own (or the test CA) may well certify a loopback address.
    const publicCa = directory === LETS_ENCRYPT_PRODUCTION || directory === LETS_ENCRYPT_STAGING
    if (!publicCa) return identifiers
    for (const id of identifiers) {
      if (id.type === 'ip' && isPrivateAddress(id.value)) {
        throw new Error(
          `${id.value} is a private address — Let's Encrypt can only certify addresses it can reach from the internet`
        )
      }
      if (id.type === 'dns' && (id.value === 'localhost' || id.value.endsWith('.local'))) {
        throw new Error(`${id.value} is not a public hostname`)
      }
    }
    return identifiers
  }

  /**
   * The current ACME certificate if it is still comfortably valid for the
   * configured identifiers, else a fresh one. A failed issuance keeps serving
   * the previous certificate (if any) and reports the error; with nothing to
   * serve it throws, and the server falls back to self-signed so the UI stays
   * reachable while the panel shows what went wrong.
   */
  acme(
    config: WebUiConfig,
    challenges: ChallengeStore,
    force = false,
    onStage?: (stage: AcmeStage, detail: string) => void
  ): Promise<TlsMaterial> {
    if (this.acmeInFlight) return this.acmeInFlight
    this.acmeInFlight = this.acmeInner(config, challenges, force, onStage).finally(() => {
      this.acmeInFlight = null
    })
    return this.acmeInFlight
  }

  private async acmeInner(
    config: WebUiConfig,
    challenges: ChallengeStore,
    force: boolean,
    onStage?: (stage: AcmeStage, detail: string) => void
  ): Promise<TlsMaterial> {
    const directory = resolveDirectoryUrl(config.https?.acme?.directory)
    this.acmeState.directory = directory
    let identifiers: SanIdentifier[]
    try {
      identifiers = this.acmeIdentifiers(config, directory)
    } catch (err) {
      this.acmeState.state = 'error'
      this.acmeState.lastError = err instanceof Error ? err.message : String(err)
      const existing = await this.loadAcme()
      if (existing) return existing.material
      throw err
    }
    this.acmeState.identifiers = identifiers.map((i) => i.value)

    const existing = await this.loadAcme()
    const sameSet =
      existing &&
      existing.meta.directory === directory &&
      sameIdentifiers(existing.meta.identifiers, identifiers)
    if (existing && sameSet && !force) {
      const notBefore = new Date(existing.meta.notBefore)
      const notAfter = new Date(existing.meta.notAfter)
      if (!renewalDue(notBefore, notAfter)) {
        this.acmeState.state = 'ok'
        this.acmeState.notAfter = notAfter.getTime()
        this.acmeState.lastIssuedAt = existing.meta.issuedAt
        return existing.material
      }
      this.log('ACME certificate is within its renewal window — renewing')
    }

    this.acmeState.state = 'issuing'
    this.acmeState.lastAttemptAt = Date.now()
    this.acmeState.lastError = null
    const started = Date.now()
    const names = identifiers.map((i) => i.value)
    try {
      const client = new AcmeClient({ directoryUrl: directory, challenges, log: this.log, onStage })
      const account = await client.ensureAccount(
        await this.loadAccount(),
        config.https?.acme?.email
      )
      await this.write('acme.account.json', JSON.stringify(account, null, 2))
      const issued = await client.issue(account, identifiers)
      const meta: AcmeMeta = {
        identifiers,
        directory,
        issuedAt: Date.now(),
        notBefore: issued.notBefore.getTime(),
        notAfter: issued.notAfter.getTime()
      }
      await this.write('acme.cert.pem', issued.certPem)
      await this.write('acme.key.pem', issued.keyPem)
      await this.write('acme.meta.json', JSON.stringify(meta, null, 2))
      this.acmeState.state = 'ok'
      this.acmeState.lastIssuedAt = meta.issuedAt
      this.acmeState.notAfter = meta.notAfter
      await this.record({
        at: Date.now(),
        // A new identifier set is a first issuance, not a renewal of the old one.
        outcome: existing && sameSet ? 'renewed' : 'issued',
        error: null,
        notAfter: meta.notAfter,
        identifiers: names,
        durationMs: Date.now() - started
      })
      return describe(issued.certPem, issued.keyPem, 'acme')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.acmeState.state = 'error'
      this.acmeState.lastError = message
      this.log(`ACME issuance failed: ${message}`)
      await this.record({
        at: Date.now(),
        outcome: 'failed',
        error: message,
        notAfter: null,
        identifiers: names,
        durationMs: Date.now() - started
      })
      if (existing && new Date(existing.meta.notAfter).getTime() > Date.now()) {
        this.acmeState.notAfter = existing.meta.notAfter
        return existing.material
      }
      throw err
    }
  }

  /** True when the stored ACME certificate is due (or past due) for renewal. */
  async acmeDue(): Promise<boolean> {
    const existing = await this.loadAcme()
    if (!existing) return true
    return renewalDue(new Date(existing.meta.notBefore), new Date(existing.meta.notAfter))
  }

  /** The stored ACME certificate's validity, for the status without reading PEMs twice. */
  async acmeValidity(): Promise<{ notBefore: number; notAfter: number } | null> {
    const existing = await this.loadAcme()
    return existing
      ? { notBefore: existing.meta.notBefore, notAfter: existing.meta.notAfter }
      : null
  }
}

/**
 * Owner-only permissions on a key file. POSIX is one chmod; Windows has no
 * mode bits, so the inheritance is cut and the current user granted full
 * control through icacls — best effort, a failure is not a reason to refuse
 * to serve.
 */
async function restrictToOwner(file: string): Promise<void> {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME ?? os.userInfo().username
    await new Promise<void>((resolve) => {
      execFile(
        'icacls',
        [file, '/inheritance:r', '/grant:r', `${user}:F`],
        { windowsHide: true, timeout: 5000 },
        () => resolve()
      )
    })
    return
  }
  await fs.chmod(file, 0o600).catch(() => undefined)
}

function describe(cert: string, key: string, source: TlsSource): TlsMaterial {
  let notBefore: Date | null = null
  let notAfter: Date | null = null
  let issuer: string | null = null
  let subjectAltName: string | null = null
  let serial: string | null = null
  let fingerprint256: string | null = null
  try {
    const parsed = new X509Certificate(cert)
    notBefore = new Date(parsed.validFrom)
    notAfter = new Date(parsed.validTo)
    issuer =
      parsed.issuer
        .split('\n')
        .find((l) => l.startsWith('CN='))
        ?.slice(3) ?? parsed.issuer
    subjectAltName = parsed.subjectAltName ?? null
    serial = parsed.serialNumber
    fingerprint256 = parsed.fingerprint256
  } catch {
    // reported as unknown rather than refused — Node's TLS will say if it is unusable
  }
  const sans = (subjectAltName ?? '')
    .split(',')
    .map((part) => part.trim().replace(/^(IP Address|DNS):/, ''))
    .filter(Boolean)
  return {
    cert,
    key,
    source,
    notBefore,
    notAfter,
    issuer,
    subjectAltName,
    sans,
    serial,
    fingerprint256
  }
}

function sameIdentifiers(a: SanIdentifier[], b: SanIdentifier[]): boolean {
  const key = (list: SanIdentifier[]): string =>
    list
      .map((i) => `${i.type}:${i.value}`)
      .sort()
      .join(',')
  return key(a) === key(b)
}

/** RFC 1918 / link-local / loopback — nothing a public CA can validate. */
export function isPrivateAddress(ip: string): boolean {
  const id = classifyIdentifier(ip)
  if (!id || id.type !== 'ip') return false
  const v = id.value
  if (v.includes(':')) {
    const lower = v.toLowerCase()
    return (
      lower === '::1' ||
      lower.startsWith('fe80:') ||
      lower.startsWith('fc') ||
      lower.startsWith('fd')
    )
  }
  const [a, b] = v.split('.').map((n) => Number(n))
  return (
    a === 10 ||
    a === 127 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}
