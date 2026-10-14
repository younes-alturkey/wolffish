/**
 * The whole Let's Encrypt path through the real server: the Web UI starts in
 * `acme` mode against Pebble (Let's Encrypt's test CA), answers the HTTP-01
 * challenge on its own plain listener, comes up on HTTPS with the certificate
 * Pebble issued, and renews it on demand. This is the integration proof for
 * the headline feature — a trusted certificate on a bare IP address with no
 * DNS — minus only the public internet between the CA and the box.
 *
 * Needs a pebble binary, its test certificates, and Node told to trust
 * Pebble's own API certificate:
 *   WOLFFISH_PEBBLE_BIN=~/go/bin/pebble \
 *   WOLFFISH_PEBBLE_DIR=~/go/pkg/mod/github.com/letsencrypt/pebble/v2@v2.10.1 \
 *   NODE_EXTRA_CA_CERTS=$WOLFFISH_PEBBLE_DIR/test/certs/pebble.minica.pem \
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/web-acme-server.test.ts
 *
 * Without the variables it prints a skip line and exits 0.
 */
import Module from 'node:module'
import { spawn, type ChildProcess } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'

const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'wolffish-web-acme-'))
process.env.HOME = SANDBOX
process.env.USERPROFILE = SANDBOX

const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => os.tmpdir(),
        getVersion: () => '0.0.0'
      },
      ipcMain: { handle: () => undefined, on: () => undefined }
    }
  }
  return origLoad.apply(this, args)
}

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

function get(
  url: string,
  ca?: string
): Promise<{ status: number; body: string; cert: import('node:tls').PeerCertificate | null }> {
  return new Promise((resolve, reject) => {
    // A fresh connection every time: a kept-alive socket would keep showing
    // the certificate it was opened with, long after the server swapped it.
    const req = https.get(
      url,
      {
        ...(ca ? { ca } : {}),
        agent: false,
        headers: { 'User-Agent': 'wolffish-acme-server-test' }
      },
      (res) => {
        // The socket detaches from the response once it ends; read the peer
        // certificate while it is still attached.
        const cert =
          (res.socket as import('node:tls').TLSSocket | null)?.getPeerCertificate?.() ?? null
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            cert
          })
        )
      }
    )
    req.on('error', reject)
  })
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no answer yet'
  for (;;) {
    const good = await check().catch((err) => {
      lastError = err instanceof Error ? err.message : String(err)
      return false
    })
    if (good) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label} (${lastError})`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

async function run(): Promise<void> {
  if (!PEBBLE_BIN || !PEBBLE_DIR || !existsSync(PEBBLE_BIN) || !process.env.NODE_EXTRA_CA_CERTS) {
    console.log('web-acme-server: pebble not configured — skipped')
    return
  }
  const { WebServer } = await import('@main/channels/web/server')
  const { hashPassword } = await import('@main/channels/web/auth')

  const workspace = path.join(SANDBOX, '.wolffish', 'workspace')
  mkdirSync(path.join(workspace, 'web'), { recursive: true })
  const renderer = path.join(SANDBOX, 'renderer')
  mkdirSync(renderer, { recursive: true })
  writeFileSync(
    path.join(renderer, 'index.html'),
    '<!doctype html><html><head></head><body>app</body></html>'
  )
  const icon = path.join(SANDBOX, 'icon.png')
  writeFileSync(icon, Buffer.from('89504e470d0a1a0a', 'hex'))

  const configPath = path.join(SANDBOX, 'pebble-config.json')
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
      PEBBLE_WFE_NONCEREJECT: '10',
      PEBBLE_AUTHZREUSE: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const pebbleLog: string[] = []
  pebble.stdout?.on('data', (c: Buffer) => pebbleLog.push(c.toString()))
  pebble.stderr?.on('data', (c: Buffer) => pebbleLog.push(c.toString()))

  const logs: string[] = []
  const passwordHash = await hashPassword('open sesame 123')
  let config = {
    enabled: true,
    port: 0,
    bind: '127.0.0.1',
    passwordHash,
    https: {
      mode: 'acme' as const,
      port: 0,
      httpPort: HTTP01_PORT,
      acme: { identifiers: ['127.0.0.1'], email: 'ops@example.com', directory: DIRECTORY }
    },
    notifications: true,
    verbose: false
  }
  const server = new WebServer({
    handlers: new Map(),
    version: '1.2.3',
    rendererDir: renderer,
    devServerUrl: null,
    icons: { 128: icon, 256: icon, 512: icon },
    ogImage: icon,
    getConfig: async () => config,
    setConfig: async (patch) => {
      config = {
        ...config,
        ...(patch as Partial<typeof config>),
        https: { ...config.https, ...((patch.https ?? {}) as typeof config.https) }
      }
    },
    onProgress: () => undefined,
    persistVapid: async () => undefined,
    stateFile: path.join(workspace, 'web', 'state.json'),
    tlsDir: path.join(workspace, 'web', 'tls'),
    exportPdf: null,
    attachFiles: async () => ({}),
    onStatusChange: () => undefined,
    log: (line) => logs.push(line),
    warn: (line) => logs.push(`WARN ${line}`)
  })

  try {
    await waitFor(async () => (await get(DIRECTORY)).status === 200, 20_000, 'pebble')
    const root = (await get('https://127.0.0.1:15000/roots/0')).body
    ok('pebble root fetched', root.includes('BEGIN CERTIFICATE'))

    await server.start()
    const status = await server.status()
    ok(
      'listening over https',
      status.listening && status.scheme === 'https',
      JSON.stringify({ listening: status.listening, error: status.error, logs })
    )
    ok(
      'served certificate came from the CA',
      status.tls.source === 'acme',
      JSON.stringify(status.tls)
    )
    ok('acme state ok', status.acme.state === 'ok', JSON.stringify(status.acme))
    ok('http-01 listener on the configured port', status.httpPort === HTTP01_PORT)
    ok(
      'tls notAfter ~6 days out (shortlived profile)',
      !!status.tls.notAfter &&
        Math.abs(status.tls.notAfter - Date.now() - 518400_000) < 10 * 60_000,
      String(status.tls.notAfter)
    )

    ok(
      'plain app port and https port are distinct listeners',
      status.port > 0 && status.httpsPort !== null && status.httpsPort !== status.port,
      `${status.port} / ${status.httpsPort}`
    )
    ok('https state is active', status.https.state === 'active', String(status.https.state))
    ok(
      'first attempt recorded as issued',
      status.https.history.length === 1 && status.https.history[0].outcome === 'issued',
      JSON.stringify(status.https.history)
    )
    ok(
      'status carries serial, fingerprint and SANs',
      !!status.tls.serial &&
        /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(status.tls.fingerprint256 ?? '') &&
        status.tls.sans.includes('127.0.0.1'),
      JSON.stringify(status.tls)
    )
    ok(
      'self-check: https, trusted issuer, valid',
      status.https.selfCheck.https && status.https.selfCheck.trusted && status.https.selfCheck.valid
    )
    ok(
      'next check is scheduled within the regular interval',
      status.https.nextCheckAt !== null &&
        status.https.nextCheckAt > Date.now() &&
        status.https.nextCheckAt - Date.now() <= 6 * 3_600_000
    )
    ok(
      'hours remaining about 144',
      status.https.hoursRemaining !== null && Math.abs(status.https.hoursRemaining - 144) < 1,
      String(status.https.hoursRemaining)
    )
    const answer = await get(`https://127.0.0.1:${status.httpsPort}/api/auth/status`, root)
    ok(
      'https answers with the Pebble-issued certificate',
      answer.status === 200 && /Pebble/i.test(String(answer.cert?.issuer?.CN ?? '')),
      `${answer.status} ${JSON.stringify(answer.cert?.issuer)}`
    )
    ok(
      'SAN carries the IP',
      String(answer.cert?.subjectaltname ?? '').includes('IP Address:127.0.0.1'),
      String(answer.cert?.subjectaltname)
    )
    const firstSerial = answer.cert?.serialNumber
    ok('auth status says secure', (JSON.parse(answer.body) as { secure: boolean }).secure === true)

    // The plain listener redirects browsers and still answers challenges.
    const redirect = await new Promise<{ status: number; location: string }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: HTTP01_PORT, path: '/anything?x=1', method: 'GET' },
        (res) => {
          res.resume()
          resolve({ status: res.statusCode ?? 0, location: String(res.headers.location ?? '') })
        }
      )
      req.on('error', reject)
      req.end()
    })
    ok(
      'plain listener redirects to https for good',
      redirect.status === 301 &&
        redirect.location === `https://127.0.0.1:${status.httpsPort}/anything?x=1`,
      JSON.stringify(redirect)
    )

    // Persisted: a second manager instance would load the same certificate.
    const tlsDir = path.join(workspace, 'web', 'tls')
    ok(
      'certificate persisted',
      existsSync(path.join(tlsDir, 'acme.cert.pem')) &&
        existsSync(path.join(tlsDir, 'acme.key.pem')) &&
        existsSync(path.join(tlsDir, 'acme.account.json'))
    )
    const meta = JSON.parse(readFileSync(path.join(tlsDir, 'acme.meta.json'), 'utf8')) as {
      identifiers: Array<{ value: string }>
      directory: string
    }
    ok(
      'meta names the identifier and directory',
      meta.identifiers[0]?.value === '127.0.0.1' && meta.directory === DIRECTORY
    )

    // Forced renewal swaps the certificate in place — no restart, new serial.
    // The manual-renew rate limit is a minute; the test is not that patient.
    ;(server as unknown as { lastManualRenewAt: number }).lastManualRenewAt = 0
    await server.renewCertificate()
    const renewed = await server.status()
    ok(
      'renewal recorded',
      renewed.https.history.length === 2 && renewed.https.history[1].outcome === 'renewed',
      JSON.stringify(renewed.https.history)
    )
    ok('state back to active after renewal', renewed.https.state === 'active')
    const after = await get(`https://127.0.0.1:${status.httpsPort}/api/auth/status`, root)
    ok(
      'renewed certificate served without a restart',
      after.status === 200 && after.cert?.serialNumber !== firstSerial,
      `${firstSerial} → ${after.cert?.serialNumber}; acme=${JSON.stringify(renewed.acme)}; logs=${JSON.stringify(logs.slice(-6))}`
    )
    ok(
      'renewal logged',
      logs.some((l) => /certificate renewed/.test(l))
    )
    const leaf = new X509Certificate(readFileSync(path.join(tlsDir, 'acme.cert.pem'), 'utf8'))
    ok(
      'persisted leaf is the renewed one',
      leaf.serialNumber.toLowerCase() === String(after.cert?.serialNumber ?? '').toLowerCase()
    )
  } finally {
    await server.stop()
    pebble?.kill('SIGTERM')
    pebble = null
  }

  console.log(`web-acme-server: ${passed} passed, ${failed} failed`)
  if (failed > 0) console.error(pebbleLog.join('').split('\n').slice(-20).join('\n'))
  process.exit(failed > 0 ? 1 : 0)
}

void run().catch((err) => {
  console.error(err)
  process.exit(1)
})
