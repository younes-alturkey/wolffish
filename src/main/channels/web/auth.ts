/**
 * The Web UI's credential and brute-force layer — pure, test-importable.
 *
 * One master password, hashed with scrypt and never stored in the clear. The
 * stored form is self-describing (`scrypt$N$r$p$salt$hash`, base64url) so the
 * cost parameters can be raised later without a migration: verify reads them
 * back from the string it is checking.
 *
 * The rate limiter is the other half of the same posture. The channel is
 * meant to sit on a public IP, so the login route is the one door on the box
 * anyone on the internet can knock on. Failures escalate per address, and a
 * global ceiling keeps a distributed guess from using the per-address budget
 * a thousand times over.
 */
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  scorePassword
} from '@main/channels/web/password-strength'
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'

export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH }

const SCRYPT_N = 1 << 15
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 32
const SALT_BYTES = 16

function scrypt(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password.normalize('NFKC'),
      salt,
      SCRYPT_KEYLEN,
      { N, r, p, maxmem: 256 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key))
    )
  })
}

/**
 * Reject before hashing: the policy lives in password-strength.ts, shared
 * with the panel's meter, so what the field calls "Good" is exactly what is
 * accepted here — and nothing weaker gets past a script that skips the panel.
 */
export function validatePassword(password: string): string | null {
  if (typeof password !== 'string') return 'password is required'
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `password must be at least ${PASSWORD_MIN_LENGTH} characters`
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `password must be at most ${PASSWORD_MAX_LENGTH} characters`
  }
  const strength = scorePassword(password)
  if (!strength.acceptable) {
    const why = strength.hints.includes('common')
      ? 'it is a commonly used password'
      : strength.hints.includes('repeat')
        ? 'it is a repeated or sequential run of characters'
        : 'it needs more length or a mix of letters, numbers and symbols'
    return `password is too weak — ${why}`
  }
  return null
}

export async function hashPassword(password: string): Promise<string> {
  const invalid = validatePassword(password)
  if (invalid) throw new Error(invalid)
  const salt = randomBytes(SALT_BYTES)
  const key = await scrypt(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P)
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    key.toString('base64url')
  ].join('$')
}

/**
 * Constant-time against the stored hash. A malformed stored value verifies
 * false rather than throwing — a corrupt config must fail closed, never open,
 * and never take the login route down with it.
 */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined
): Promise<boolean> {
  if (typeof password !== 'string' || typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return false
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[4], 'base64url')
    expected = Buffer.from(parts[5], 'base64url')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false
  let actual: Buffer
  try {
    actual = await scrypt(password, salt, N, r, p)
  } catch {
    return false
  }
  return timingSafeEqual(actual, expected)
}

/** Opaque session token for the cookie — 256 bits, base64url. */
export function mintSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

export type RateLimitVerdict = { allowed: true } | { allowed: false; retryAfterMs: number }

const WINDOW_MS = 15 * 60_000
const FREE_FAILURES = 5
const MAX_LOCK_MS = 60 * 60_000
const GLOBAL_WINDOW_MS = 60_000
const GLOBAL_MAX_FAILURES = 60

type AddressRecord = { failures: number[]; lockedUntil: number }

/**
 * Five free misses per address per 15 minutes; after that each further miss
 * doubles the lock, from one minute up to an hour. One shared ceiling on top:
 * more than sixty failures a minute across all addresses locks the door for
 * everyone for the rest of that minute.
 */
export class LoginRateLimiter {
  private readonly byAddress = new Map<string, AddressRecord>()
  private globalFailures: number[] = []

  constructor(private readonly now: () => number = Date.now) {}

  check(address: string): RateLimitVerdict {
    const t = this.now()
    this.globalFailures = this.globalFailures.filter((at) => t - at < GLOBAL_WINDOW_MS)
    if (this.globalFailures.length >= GLOBAL_MAX_FAILURES) {
      const oldest = this.globalFailures[0]
      return { allowed: false, retryAfterMs: Math.max(1000, oldest + GLOBAL_WINDOW_MS - t) }
    }
    const record = this.byAddress.get(address)
    if (!record) return { allowed: true }
    if (record.lockedUntil > t) return { allowed: false, retryAfterMs: record.lockedUntil - t }
    return { allowed: true }
  }

  recordFailure(address: string): void {
    const t = this.now()
    this.globalFailures.push(t)
    const record = this.byAddress.get(address) ?? { failures: [], lockedUntil: 0 }
    record.failures = record.failures.filter((at) => t - at < WINDOW_MS)
    record.failures.push(t)
    const over = record.failures.length - FREE_FAILURES
    if (over > 0) {
      const lockMs = Math.min(MAX_LOCK_MS, 60_000 * 2 ** (over - 1))
      record.lockedUntil = t + lockMs
    }
    this.byAddress.set(address, record)
  }

  recordSuccess(address: string): void {
    this.byAddress.delete(address)
  }

  /** Drop records that can no longer influence a verdict. */
  prune(): void {
    const t = this.now()
    for (const [address, record] of this.byAddress) {
      const recent = record.failures.some((at) => t - at < WINDOW_MS)
      if (!recent && record.lockedUntil <= t) this.byAddress.delete(address)
    }
  }
}
