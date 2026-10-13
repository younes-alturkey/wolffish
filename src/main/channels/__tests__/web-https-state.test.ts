/**
 * The HTTPS state machine and renewal clock: every transition in the table,
 * the ones that must be ignored, the renewal thresholds for short-lived and
 * 90-day certificates, backoff growth with bounded jitter, and the attempt
 * log's counters and cap.
 *
 * Standalone — run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/web-https-state.test.ts
 */
export {}

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

async function run(): Promise<void> {
  const {
    transition,
    renewalDue,
    backoffDelayMs,
    recordAttempt,
    planNextCheck,
    hoursRemaining,
    normalizeMeta,
    EMPTY_HTTPS_META,
    RENEWAL_CHECK_MS,
    BACKOFF_BASE_MS,
    BACKOFF_MAX_MS,
    HISTORY_LIMIT
  } = await import('@main/channels/web/https-state')

  // ── transitions ────────────────────────────────────────────────────────────
  ok('enable starts preflight', transition('disabled', 'enable', false) === 'preflight')
  ok('preflight passes to issuing', transition('preflight', 'preflight-ok', false) === 'issuing')
  ok('preflight failure is an error', transition('preflight', 'preflight-fail', false) === 'error')
  ok('issued from issuing is active', transition('issuing', 'issued', false) === 'active')
  ok(
    'issue failure with no cert is an error',
    transition('issuing', 'issue-fail', false) === 'error'
  )
  ok('renew from active is renewing', transition('active', 'renew', true) === 'renewing')
  ok('renewal success is active', transition('renewing', 'issued', true) === 'active')
  ok(
    'renewal failure with a valid cert stays active',
    transition('renewing', 'issue-fail', true) === 'active'
  )
  ok(
    'renewal failure with an expired cert is an error',
    transition('renewing', 'issue-fail', false) === 'error'
  )
  ok('renew-now from error issues afresh', transition('error', 'renew', false) === 'issuing')
  ok('disable from anywhere', transition('renewing', 'disable', true) === 'disabled')
  ok('boot with a valid cert is active', transition('renewing', 'boot', true) === 'active')
  ok('boot without one issues', transition('disabled', 'boot', false) === 'issuing')
  ok(
    'late preflight-ok is ignored once active',
    transition('active', 'preflight-ok', true) === 'active'
  )
  ok(
    'late issue-fail is ignored once active',
    transition('active', 'issue-fail', true) === 'active'
  )
  ok('renew while issuing is ignored', transition('issuing', 'renew', false) === 'issuing')

  // ── renewal thresholds ─────────────────────────────────────────────────────
  const h = 3_600_000
  const t0 = new Date('2026-10-01T00:00:00Z')
  const short = { nb: t0, na: new Date(t0.getTime() + 160 * h) }
  ok('fresh 160h cert is not due', !renewalDue(short.nb, short.na, new Date(t0.getTime() + 1 * h)))
  ok(
    '160h cert with 73h left is not due',
    !renewalDue(short.nb, short.na, new Date(short.na.getTime() - 73 * h))
  )
  ok(
    '160h cert with 71h left is due',
    renewalDue(short.nb, short.na, new Date(short.na.getTime() - 71 * h))
  )
  const long = { nb: t0, na: new Date(t0.getTime() + 90 * 24 * h) }
  ok(
    '90-day cert with 31 days left is not due',
    !renewalDue(long.nb, long.na, new Date(long.na.getTime() - 31 * 24 * h))
  )
  ok(
    '90-day cert with 29 days left is due (a third of the lifetime)',
    renewalDue(long.nb, long.na, new Date(long.na.getTime() - 29 * 24 * h))
  )
  ok('expired cert is due', renewalDue(short.nb, short.na, new Date(short.na.getTime() + h)))
  ok('nonsense lifetime is due', renewalDue(short.na, short.nb))

  // ── backoff ────────────────────────────────────────────────────────────────
  ok('no failures: the regular check', backoffDelayMs(0) === RENEWAL_CHECK_MS)
  ok('first failure: 15 minutes at mid jitter', backoffDelayMs(1, () => 0.5) === BACKOFF_BASE_MS)
  ok('second failure doubles', backoffDelayMs(2, () => 0.5) === BACKOFF_BASE_MS * 2)
  ok('fifth failure is four hours', backoffDelayMs(5, () => 0.5) === BACKOFF_BASE_MS * 16)
  ok('capped at the check interval', backoffDelayMs(20, () => 0.5) === BACKOFF_MAX_MS)
  ok('jitter floor is half', backoffDelayMs(1, () => 0) === BACKOFF_BASE_MS / 2)
  ok('jitter ceiling is one and a half', backoffDelayMs(1, () => 1) === BACKOFF_BASE_MS * 1.5)
  ok('jitter never exceeds the cap', backoffDelayMs(10, () => 1) === BACKOFF_MAX_MS)
  let monotone = true
  for (let i = 1; i < 8; i++)
    if (backoffDelayMs(i, () => 0.5) > backoffDelayMs(i + 1, () => 0.5)) monotone = false
  ok('backoff never shrinks as failures grow', monotone)

  // ── history ────────────────────────────────────────────────────────────────
  let meta = EMPTY_HTTPS_META
  meta = recordAttempt(meta, {
    at: 1000,
    outcome: 'issued',
    error: null,
    notAfter: 999_999,
    identifiers: ['203.0.113.9'],
    durationMs: 1200
  })
  ok(
    'issued sets lastRenewalAt and clears error',
    meta.lastRenewalAt === 1000 && meta.lastError === null
  )
  meta = recordAttempt(meta, {
    at: 2000,
    outcome: 'failed',
    error: 'boom',
    notAfter: null,
    identifiers: ['203.0.113.9'],
    durationMs: 50
  })
  meta = recordAttempt(meta, {
    at: 3000,
    outcome: 'failed',
    error: 'boom again',
    notAfter: null,
    identifiers: ['203.0.113.9'],
    durationMs: 50
  })
  ok('failures count consecutively', meta.failures === 2)
  ok('last error is the latest', meta.lastError === 'boom again')
  ok('lastRenewalAt untouched by failures', meta.lastRenewalAt === 1000)
  ok('lastAttemptAt moves', meta.lastAttemptAt === 3000)
  ok('next check backs off', planNextCheck(meta, 3000, () => 0.5) === 3000 + BACKOFF_BASE_MS * 2)
  meta = recordAttempt(meta, {
    at: 4000,
    outcome: 'renewed',
    error: null,
    notAfter: 5_000_000,
    identifiers: ['203.0.113.9'],
    durationMs: 900
  })
  ok('success resets the streak', meta.failures === 0 && meta.lastError === null)
  ok(
    'next check is the regular interval again',
    planNextCheck(meta, 4000) === 4000 + RENEWAL_CHECK_MS
  )
  for (let i = 0; i < 30; i++)
    meta = recordAttempt(meta, {
      at: 10_000 + i,
      outcome: 'renewed',
      error: null,
      notAfter: 1,
      identifiers: [],
      durationMs: 1
    })
  ok('history capped', meta.history.length === HISTORY_LIMIT)
  ok('history keeps the newest', meta.history[meta.history.length - 1].at === 10_029)

  // ── misc ───────────────────────────────────────────────────────────────────
  ok(
    'hours remaining rounds to a tenth',
    hoursRemaining(1_000_000 + 90 * 60_000, 1_000_000) === 1.5
  )
  ok('hours remaining floors at zero', hoursRemaining(0, 10) === 0)
  ok('null stays null', hoursRemaining(null) === null)
  const n = normalizeMeta({ state: 'bogus', failures: -3, history: [{ at: 'x' }, { at: 5 }] })
  ok(
    'normalize repairs a damaged file',
    n.state === 'disabled' && n.failures === 0 && n.history.length === 1 && n.history[0].at === 5
  )
  ok('normalize of garbage is the empty meta', normalizeMeta(null).state === 'disabled')

  console.log(`web-https-state: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void run().catch((err) => {
  console.error(err)
  process.exit(1)
})
