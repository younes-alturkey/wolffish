/**
 * The Let's Encrypt feature's state machine and its clock, kept pure so the
 * transitions and the renewal timing can be tested without a server, a CA
 * or a wall clock.
 *
 *   disabled → preflight → issuing → active ⇄ renewing
 *                  ↓           ↓                 ↓ (failed AND expired)
 *                error       error             error
 *
 * `error` means no trusted certificate is being served — the self-signed
 * fallback is. A renewal that fails while the current certificate is still
 * valid is not an error state: the box keeps serving, the attempt is
 * recorded, and the next check comes sooner.
 */
export type HttpsState = 'disabled' | 'preflight' | 'issuing' | 'active' | 'renewing' | 'error'

export type HttpsEvent =
  | 'enable'
  | 'preflight-ok'
  | 'preflight-fail'
  | 'renew'
  | 'issued'
  | 'issue-fail'
  | 'disable'
  | 'boot'

/**
 * The next state. Unknown combinations keep the state they are in, so a late
 * event from an abandoned flow cannot drag a healthy server backwards.
 */
export function transition(state: HttpsState, event: HttpsEvent, certValid: boolean): HttpsState {
  switch (event) {
    case 'disable':
      return 'disabled'
    case 'enable':
      return 'preflight'
    case 'boot':
      return certValid ? 'active' : 'issuing'
    case 'preflight-ok':
      return state === 'preflight' ? 'issuing' : state
    case 'preflight-fail':
      return state === 'preflight' ? 'error' : state
    case 'renew':
      if (state === 'active') return 'renewing'
      if (state === 'error' || state === 'disabled') return 'issuing'
      return state
    case 'issued':
      return 'active'
    case 'issue-fail':
      if (state === 'issuing') return 'error'
      if (state === 'renewing') return certValid ? 'active' : 'error'
      return state
  }
}

export const RENEWAL_CHECK_MS = 6 * 3_600_000
export const RENEW_WITHIN_MS = 72 * 3_600_000
export const BACKOFF_BASE_MS = 15 * 60_000
export const BACKOFF_MAX_MS = RENEWAL_CHECK_MS
export const HISTORY_LIMIT = 20

/**
 * Renew with 72 hours left, or with a third of the lifetime left for longer
 * certificates — 30 days of a 90-day one, which is what the CA recommends.
 * For a 160-hour IP certificate that is a renewal about 3.7 days in, which
 * leaves three days of six-hourly retries before anything expires.
 */
export function renewalDue(notBefore: Date, notAfter: Date, now: Date = new Date()): boolean {
  const lifetime = notAfter.getTime() - notBefore.getTime()
  if (lifetime <= 0) return true
  const remaining = notAfter.getTime() - now.getTime()
  return remaining < Math.max(RENEW_WITHIN_MS, lifetime / 3)
}

/**
 * How long to wait before the next attempt after `failures` consecutive
 * failures: the regular check interval when nothing failed, otherwise 15
 * minutes doubling to the regular interval, each with ±50% jitter so a fleet
 * that failed together does not retry together.
 */
export function backoffDelayMs(failures: number, random: () => number = Math.random): number {
  if (failures <= 0) return RENEWAL_CHECK_MS
  const base = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS)
  return Math.min(Math.round(base * (0.5 + random())), BACKOFF_MAX_MS)
}

export type RenewalOutcome = 'issued' | 'renewed' | 'failed'

export type RenewalAttempt = {
  at: number
  outcome: RenewalOutcome
  error: string | null
  /** The new certificate's expiry on success. */
  notAfter: number | null
  identifiers: string[]
  durationMs: number
}

/** What is persisted beside the certificate, and what the status reports. */
export type HttpsMeta = {
  state: HttpsState
  lastError: string | null
  lastRenewalAt: number | null
  lastAttemptAt: number | null
  nextCheckAt: number | null
  /** Consecutive failures, reset by a success — the backoff's input. */
  failures: number
  history: RenewalAttempt[]
}

export const EMPTY_HTTPS_META: HttpsMeta = Object.freeze({
  state: 'disabled',
  lastError: null,
  lastRenewalAt: null,
  lastAttemptAt: null,
  nextCheckAt: null,
  failures: 0,
  history: []
}) as HttpsMeta

/** The meta after one attempt: counters moved, the attempt kept (newest last, at most 20). */
export function recordAttempt(meta: HttpsMeta, attempt: RenewalAttempt): HttpsMeta {
  const failed = attempt.outcome === 'failed'
  return {
    ...meta,
    lastAttemptAt: attempt.at,
    lastError: failed ? attempt.error : null,
    lastRenewalAt: failed ? meta.lastRenewalAt : attempt.at,
    failures: failed ? meta.failures + 1 : 0,
    history: [...meta.history, attempt].slice(-HISTORY_LIMIT)
  }
}

/** When the scheduler should look again, given the failure streak. */
export function planNextCheck(
  meta: HttpsMeta,
  now: number = Date.now(),
  random: () => number = Math.random
): number {
  return now + backoffDelayMs(meta.failures, random)
}

export function hoursRemaining(notAfter: number | null, now: number = Date.now()): number | null {
  if (notAfter === null) return null
  return Math.max(0, Math.round(((notAfter - now) / 3_600_000) * 10) / 10)
}

/** A stored meta file from any version, made whole. */
export function normalizeMeta(raw: unknown): HttpsMeta {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<HttpsMeta>
  const states: HttpsState[] = ['disabled', 'preflight', 'issuing', 'active', 'renewing', 'error']
  return {
    state: states.includes(r.state as HttpsState) ? (r.state as HttpsState) : 'disabled',
    lastError: typeof r.lastError === 'string' ? r.lastError : null,
    lastRenewalAt: typeof r.lastRenewalAt === 'number' ? r.lastRenewalAt : null,
    lastAttemptAt: typeof r.lastAttemptAt === 'number' ? r.lastAttemptAt : null,
    nextCheckAt: typeof r.nextCheckAt === 'number' ? r.nextCheckAt : null,
    failures: typeof r.failures === 'number' && r.failures >= 0 ? Math.floor(r.failures) : 0,
    history: Array.isArray(r.history)
      ? (r.history as RenewalAttempt[])
          .filter((a) => a && typeof a.at === 'number')
          .slice(-HISTORY_LIMIT)
      : []
  }
}
