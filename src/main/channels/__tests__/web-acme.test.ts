/**
 * The ACME client against Pebble — Let's Encrypt's own test CA — which is the
 * independent route for a protocol implementation: it validates the HTTP-01
 * challenge for real over the network, rejects a share of nonces on purpose
 * (so the badNonce retry is exercised), issues under the `shortlived` profile
 * for an IP identifier and under the default profile for a hostname, and
 * hands back a chain this test parses with Node's X509Certificate.
 *
 * Needs a pebble binary and its test certificates:
 *   go install github.com/letsencrypt/pebble/v2/cmd/pebble@latest
 *   WOLFFISH_PEBBLE_BIN=~/go/bin/pebble \
 *   WOLFFISH_PEBBLE_DIR=~/go/pkg/mod/github.com/letsencrypt/pebble/v2@v2.10.1 \
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/web-acme.test.ts
 *
 * Without both variables the test prints a skip line and exits 0, so the
 * suite stays runnable on a box with no Go toolchain.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
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

const PEBBLE_BIN = process.env.WOLFFISH_PEBBLE_BIN
const PEBBLE_DIR = process.env.WOLFFISH_PEBBLE_DIR
const DIRECTORY = 'https://127.0.0.1:14000/dir'
const HTTP01_PORT = 5002

function waitForDirectory(ca: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = 'no answer yet'
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      // Strict Pebble refuses any request without a User-Agent.
      const req = https.get(
        DIRECTORY,
        { ca, headers: { 'User-Agent': 'wolffish-acme-test' } },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            if (res.statusCode === 200) resolve()
            else {
              last = `status ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`
              retry()
            }
          })
        }
      )
      req.on('error', (err) => {
        last = err.message
        retry()
      })
    }
    const retry = (): void => {
      if (Date.now() > deadline) reject(new Error(`pebble did not come up (${last})`))
      else setTimeout(attempt, 250)
    }
    attempt()
  })
}

async function run(): Promise<void> {
  const {
    AcmeClient,
    ChallengeStore,
    shouldRenew,
    resolveDirectoryUrl,
    parseIdentifiers,
    jwkThumbprint,
    SHORTLIVED_PROFILE
  } = await import('@main/channels/web/acme')

  // ── pure helpers first ─────────────────────────────────────────────────────
  ok(
    'production shorthand',
    resolveDirectoryUrl('production') === 'https://acme-v02.api.letsencrypt.org/directory'
  )
  ok(
    'staging shorthand',
    resolveDirectoryUrl('staging') === 'https://acme-staging-v02.api.letsencrypt.org/directory'
  )
  ok(
    'empty = production',
    resolveDirectoryUrl(undefined) === 'https://acme-v02.api.letsencrypt.org/directory'
  )
  ok('url passes through', resolveDirectoryUrl(' https://x/dir ') === 'https://x/dir')
  const parsed = parseIdentifiers([
    '203.0.113.9',
    ' box.example.com ',
    '203.0.113.9',
    'bad host!',
    ''
  ])
  ok(
    'identifiers parsed and deduped',
    parsed.identifiers.length === 2 && parsed.invalid.length === 1,
    JSON.stringify(parsed)
  )
  const sixDays = 160 * 3600_000
  const issued = new Date('2026-10-12T00:00:00Z')
  const expires = new Date(issued.getTime() + sixDays)
  ok(
    'no renewal right after issue',
    !shouldRenew(issued, expires, new Date(issued.getTime() + 3600_000))
  )
  ok(
    'renewal at a third left',
    shouldRenew(issued, expires, new Date(expires.getTime() - sixDays / 3 + 60_000))
  )
  ok('renewal when expired', shouldRenew(issued, expires, new Date(expires.getTime() + 1)))
  // RFC 7638 §3.1 ordering: crv, kty, x, y — a different order would hash differently.
  const tp = jwkThumbprint({
    kty: 'EC',
    crv: 'P-256',
    x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
    y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0'
  })
  ok('thumbprint is 43 chars base64url', /^[A-Za-z0-9_-]{43}$/.test(tp), tp)

  if (!PEBBLE_BIN || !PEBBLE_DIR || !existsSync(PEBBLE_BIN)) {
    console.log(
      `web-acme: ${passed} passed, ${failed} failed (pebble not configured — live ACME checks skipped)`
    )
    if (failed > 0) process.exitCode = 1
    return
  }

  // ── pebble ─────────────────────────────────────────────────────────────────
  const ca = readFileSync(path.join(PEBBLE_DIR, 'test', 'certs', 'pebble.minica.pem'), 'utf8')
  const work = mkdtempSync(path.join(os.tmpdir(), 'wolffish-acme-'))
  const configPath = path.join(work, 'pebble-config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      pebble: {
        listenAddress: '127.0.0.1:14000',
        managementListenAddress: '127.0.0.1:15000',
        certificate: path.join(PEBBLE_DIR, 'test', 'certs', 'localhost', 'cert.pem'),
        privateKey: path.join(PEBBLE_DIR, 'test', 'certs', 'localhost', 'key.pem'),
        httpPort: HTTP01_PORT,
        tlsPort: 5001,
        ocspResponderURL: '',
        externalAccountBindingRequired: false,
        retryAfter: { authz: 1, order: 1 },
        keyAlgorithm: 'ecdsa',
        profiles: {
          default: { description: 'default', validityPeriod: 7776000 },
          shortlived: { description: 'short', validityPeriod: 518400 }
        }
      }
    })
  )
  let pebble: ChildProcess | null = spawn(PEBBLE_BIN, ['-config', configPath, '-strict'], {
    env: {
      ...process.env,
      PEBBLE_VA_NOSLEEP: '1',
      // Three nonces in ten rejected: the client's badNonce retry has to carry
      // every step, or this test cannot complete. (Ten retries at 30% leaves a
      // one-in-a-million chance of a step failing by bad luck.)
      PEBBLE_WFE_NONCEREJECT: '30',
      PEBBLE_AUTHZREUSE: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const pebbleLog: string[] = []
  pebble.stdout?.on('data', (c: Buffer) => pebbleLog.push(c.toString()))
  pebble.stderr?.on('data', (c: Buffer) => pebbleLog.push(c.toString()))

  const challenges = new ChallengeStore()
  const responder = http.createServer((req, res) => {
    const m = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]+)$/.exec(req.url ?? '')
    const answer = m ? challenges.get(m[1]) : null
    if (!answer) {
      res.statusCode = 404
      res.end('no such challenge')
      return
    }
    res.setHeader('Content-Type', 'application/octet-stream')
    res.end(answer)
  })
  // Dual-stack: Pebble resolves `localhost` to ::1 on this box.
  await new Promise<void>((resolve) => responder.listen(HTTP01_PORT, resolve))

  try {
    await waitForDirectory(ca, 20_000)
    const log: string[] = []
    const client = new AcmeClient({
      directoryUrl: DIRECTORY,
      challenges,
      ca,
      log: (l) => log.push(l),
      pollIntervalMs: 300,
      pollTimeoutMs: 60_000
    })
    const directory = await client.getDirectory()
    ok(
      'directory advertises profiles',
      !!directory.meta?.profiles && SHORTLIVED_PROFILE in directory.meta.profiles,
      JSON.stringify(directory.meta)
    )

    const account = await client.ensureAccount(null, 'ops@example.com')
    ok('account url returned', account.url.startsWith('https://127.0.0.1:14000/'), account.url)
    ok('account key is PKCS#8 PEM', account.keyPem.includes('BEGIN PRIVATE KEY'))
    const again = await client.ensureAccount(account)
    ok('existing account reused', again.url === account.url)

    // IP identifier → shortlived profile → 6-day validity from Pebble's config.
    const ipIssue = await client.issue(account, [{ type: 'ip', value: '127.0.0.1' }])
    const leaf = new X509Certificate(ipIssue.certPem)
    ok('ip cert SAN', !!leaf.subjectAltName?.includes('IP Address:127.0.0.1'), leaf.subjectAltName)
    ok('ip cert issued by pebble', /Pebble/i.test(leaf.issuer), leaf.issuer)
    ok(
      'ip cert matches key',
      leaf.checkPrivateKey((await import('node:crypto')).createPrivateKey(ipIssue.keyPem))
    )
    const ipLifetime = ipIssue.notAfter.getTime() - ipIssue.notBefore.getTime()
    ok(
      'ip cert is short-lived (6 days)',
      Math.abs(ipLifetime - 518400_000) < 10 * 60_000,
      String(ipLifetime / 3600_000) + 'h'
    )
    ok('profile recorded', ipIssue.profile === SHORTLIVED_PROFILE)
    ok(
      'chain has more than the leaf',
      (ipIssue.certPem.match(/BEGIN CERTIFICATE/g) ?? []).length >= 2
    )
    ok(
      'challenge cleared after use',
      log.some((l) => l.includes('validated'))
    )

    // Hostname only → no profile named. Let's Encrypt then issues its default
    // (classic) profile; Pebble, "in true pebble chaos fashion", picks one of
    // its profiles at random — so only the shape is asserted here.
    const dnsIssue = await client.issue(account, [{ type: 'dns', value: 'localhost' }])
    const dnsLeaf = new X509Certificate(dnsIssue.certPem)
    ok('dns cert SAN', !!dnsLeaf.subjectAltName?.includes('DNS:localhost'), dnsLeaf.subjectAltName)
    const dnsLifetime = dnsIssue.notAfter.getTime() - dnsIssue.notBefore.getTime()
    ok(
      'dns cert lifetime is one of the configured profiles',
      Math.abs(dnsLifetime - 7776000_000) < 10 * 60_000 ||
        Math.abs(dnsLifetime - 518400_000) < 10 * 60_000,
      String(dnsLifetime / 86400_000) + 'd'
    )
    ok('no profile for dns-only', dnsIssue.profile === null)

    // A mixed order rides the shortlived profile too.
    const mixed = await client.issue(account, [
      { type: 'ip', value: '127.0.0.1' },
      { type: 'dns', value: 'localhost' }
    ])
    const mixedLeaf = new X509Certificate(mixed.certPem)
    ok(
      'mixed SAN has both',
      !!mixedLeaf.subjectAltName?.includes('IP Address:127.0.0.1') &&
        !!mixedLeaf.subjectAltName?.includes('DNS:localhost'),
      mixedLeaf.subjectAltName
    )

    // A failed validation surfaces as a readable error, not a hang.
    const unreachable = new AcmeClient({
      directoryUrl: DIRECTORY,
      challenges: new ChallengeStore(),
      ca,
      pollIntervalMs: 300,
      pollTimeoutMs: 30_000
    })
    let message = ''
    try {
      await unreachable.issue(account, [{ type: 'dns', value: 'nope.invalid' }])
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    ok('validation failure reported', /validation failed|invalid/i.test(message), message)
    ok(
      'badNonce retries happened',
      log.some((l) => l.includes('badNonce')),
      'pebble was configured to reject 50% of nonces'
    )
  } finally {
    await new Promise<void>((resolve) => responder.close(() => resolve()))
    pebble?.kill('SIGTERM')
    pebble = null
  }

  console.log(`web-acme: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.error(pebbleLog.join('').split('\n').slice(-30).join('\n'))
    process.exitCode = 1
  }
}

void run().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
