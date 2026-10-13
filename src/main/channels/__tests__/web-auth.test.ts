/**
 * The Web UI's credential layer: scrypt hashing round-trips, refuses what it
 * must, and never throws on garbage; the login limiter escalates per address
 * and has a global ceiling; the state store persists sessions and push
 * subscriptions atomically and expires them together.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/web-auth.test.ts
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
  const { hashPassword, verifyPassword, validatePassword, LoginRateLimiter, mintSessionToken } =
    await import('@main/channels/web/auth')
  const { WebStateStore, hashSessionToken, SESSION_TTL_MS } =
    await import('@main/channels/web/state')

  // ── passwords ──────────────────────────────────────────────────────────────
  const hash = await hashPassword('correct horse battery')
  ok('hash is self-describing scrypt', hash.startsWith('scrypt$32768$8$1$'), hash)
  ok('verify accepts the password', await verifyPassword('correct horse battery', hash))
  ok('verify rejects a wrong password', !(await verifyPassword('correct horse batterx', hash)))
  ok('verify rejects empty', !(await verifyPassword('', hash)))
  ok('verify rejects null stored', !(await verifyPassword('x', null)))
  ok('verify rejects garbage stored', !(await verifyPassword('x', 'not$a$hash')))
  ok(
    'verify rejects tampered params',
    !(await verifyPassword('correct horse battery', hash.replace('$8$', '$0$')))
  )
  ok(
    'two hashes of one password differ (salted)',
    (await hashPassword('correct horse battery')) !== hash
  )
  ok(
    'NFKC-normalized input verifies',
    await verifyPassword('correct horse battery'.normalize('NFKD'), hash)
  )
  ok('short password refused', validatePassword('short') !== null)
  ok('eight digits refused (too short, one class)', validatePassword('12345678') !== null)
  ok('common password refused', /commonly used/.test(validatePassword('password123') ?? ''))
  ok('sequential run refused', /sequential/.test(validatePassword('abcdefghijkl') ?? ''))
  ok('weak mix refused', /too weak/.test(validatePassword('aaaaaaaaaa1') ?? ''))
  ok('three-class 12-char accepted', validatePassword('Wolffish2026!') === null)
  ok('long two-class passphrase accepted', validatePassword('correct horse battery') === null)

  // ── strength meter (the same scorer the panel shows) ──────────────────────
  const { scorePassword, PASSWORD_MIN_LENGTH } =
    await import('@main/channels/web/password-strength')
  ok('min length is 10', PASSWORD_MIN_LENGTH === 10)
  ok(
    'empty is weak with a length hint',
    JSON.stringify(scorePassword('')) ===
      JSON.stringify({ score: 0, level: 'weak', hints: ['length'], acceptable: false })
  )
  ok(
    'password123 scores 0 as common',
    scorePassword('password123').score === 0 && scorePassword('password123').hints[0] === 'common'
  )
  ok('P@ssw0rd!! normalizes to a common one', scorePassword('P@ssw0rd!!').level === 'weak')
  ok('12345678 is weak', scorePassword('12345678').level === 'weak')
  ok('nine lowercase is fair-ish but unacceptable', !scorePassword('abcxyzqwe').acceptable)
  ok('Wolffish2026! is strong', scorePassword('Wolffish2026!').level === 'strong')
  ok(
    'correct horse battery is good',
    scorePassword('correct horse battery').level === 'good' &&
      scorePassword('correct horse battery').acceptable
  )
  ok('acceptable passwords carry no hints', scorePassword('Wolffish2026!').hints.length === 0)
  ok('short strong mix hints length', scorePassword('Ab1!').hints.includes('length'))
  ok(
    'long single-class hints mix',
    scorePassword('abcdefghijkzzz').hints.includes('mix') ||
      !scorePassword('abcdefghijkzzz').acceptable
  )
  let threw = false
  try {
    await hashPassword('short')
  } catch {
    threw = true
  }
  ok('hashPassword refuses a short password', threw)
  const tokenA = mintSessionToken()
  ok('session token is 43 chars base64url', /^[A-Za-z0-9_-]{43}$/.test(tokenA), tokenA)
  ok('tokens are unique', tokenA !== mintSessionToken())

  // ── rate limiter ───────────────────────────────────────────────────────────
  let clock = 1_000_000
  const limiter = new LoginRateLimiter(() => clock)
  for (let i = 0; i < 5; i++) {
    ok(`attempt ${i + 1} allowed`, limiter.check('10.0.0.1').allowed)
    limiter.recordFailure('10.0.0.1')
  }
  ok('sixth attempt still allowed (five free)', limiter.check('10.0.0.1').allowed)
  limiter.recordFailure('10.0.0.1')
  const locked = limiter.check('10.0.0.1')
  ok('locked after the sixth failure', !locked.allowed)
  ok(
    'first lock is one minute',
    !locked.allowed && locked.retryAfterMs === 60_000,
    JSON.stringify(locked)
  )
  ok('another address is unaffected', limiter.check('10.0.0.2').allowed)
  clock += 60_001
  ok('lock expires', limiter.check('10.0.0.1').allowed)
  limiter.recordFailure('10.0.0.1')
  const locked2 = limiter.check('10.0.0.1')
  ok(
    'second lock doubles',
    !locked2.allowed && locked2.retryAfterMs === 120_000,
    JSON.stringify(locked2)
  )
  limiter.recordSuccess('10.0.0.1')
  ok('success clears the address', limiter.check('10.0.0.1').allowed)
  for (let i = 0; i < 60; i++) limiter.recordFailure(`10.1.0.${i}`)
  ok('global ceiling locks everyone', !limiter.check('10.9.9.9').allowed)
  clock += 60_001
  ok('global ceiling lifts after a minute', limiter.check('10.9.9.9').allowed)
  clock += 16 * 60_000
  limiter.prune()
  ok('prune does not throw and keeps allowing', limiter.check('10.0.0.1').allowed)

  // ── state store ────────────────────────────────────────────────────────────
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wolffish-web-state-'))
  const file = path.join(dir, 'nested', 'state.json')
  let now = 5_000_000
  const store = new WebStateStore(file, () => now)
  const { token, session } = await store.createSession({ userAgent: 'UA/1', address: '1.2.3.4' })
  ok('session id is public and short', /^[0-9a-f]{12}$/.test(session.id))
  ok('token hash stored, token not', session.tokenHash === hashSessionToken(token))
  const onDisk = JSON.parse(readFileSync(file, 'utf8')) as {
    sessions: Array<{ tokenHash: string }>
  }
  ok('file written atomically to a nested dir', onDisk.sessions.length === 1)
  ok('plain token never on disk', !readFileSync(file, 'utf8').includes(token))
  ok('resolve by token', (await store.resolveSession(token))?.id === session.id)
  ok(
    'resolve rejects a wrong token',
    (await store.resolveSession(token.slice(0, -1) + 'x')) === null
  )
  ok('resolve rejects empty', (await store.resolveSession('')) === null)

  const sub = await store.upsertSubscription({
    sessionId: session.id,
    endpoint: 'https://push.example/abc',
    keys: { p256dh: 'p', auth: 'a' },
    userAgent: 'UA/1'
  })
  ok('subscription stored', (await store.listSubscriptions()).length === 1)
  const sub2 = await store.upsertSubscription({
    sessionId: session.id,
    endpoint: 'https://push.example/abc',
    keys: { p256dh: 'p2', auth: 'a2' },
    userAgent: 'UA/1'
  })
  ok(
    're-subscribe replaces, keeps id',
    sub2.id === sub.id && (await store.listSubscriptions()).length === 1
  )
  ok('new keys kept', (await store.listSubscriptions())[0].keys.p256dh === 'p2')

  // A second process reading the same file sees the same state.
  const reopened = new WebStateStore(file, () => now)
  ok(
    'reopened store resolves the session',
    (await reopened.resolveSession(token))?.id === session.id
  )

  await store.revokeSession(session.id)
  ok('revoked session no longer resolves', (await store.resolveSession(token)) === null)
  ok('revoking a session drops its subscriptions', (await store.listSubscriptions()).length === 0)

  const second = await store.createSession({ userAgent: 'UA/2', address: '5.6.7.8' })
  await store.upsertSubscription({
    sessionId: second.session.id,
    endpoint: 'https://push.example/def',
    keys: { p256dh: 'p', auth: 'a' },
    userAgent: 'UA/2'
  })
  now += SESSION_TTL_MS + 1
  ok('expired session no longer resolves', (await store.resolveSession(second.token)) === null)
  ok('expired session swept from the list', (await store.listSessions()).length === 0)
  ok(
    'sweep drops the expired session subscriptions',
    (await store.listSubscriptions()).length === 0
  )

  await store.createSession({ userAgent: 'UA/3', address: '9.9.9.9' })
  await store.createSession({ userAgent: 'UA/4', address: '9.9.9.9' })
  await store.revokeAllSessions()
  ok('revokeAll empties', (await store.listSessions()).length === 0)

  const keep = await store.createSession({ userAgent: 'UA/5', address: '9.9.9.9' })
  await store.createSession({ userAgent: 'UA/6', address: '9.9.9.9' })
  await store.revokeAllSessions({ except: keep.session.id })
  const left = await store.listSessions()
  ok(
    'revokeAll with except keeps only that session',
    left.length === 1 && left[0].id === keep.session.id
  )

  console.log(`web-auth: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void run().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
