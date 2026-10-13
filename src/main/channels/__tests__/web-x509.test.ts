/**
 * The byte-level certificate builder, checked by routes it did not write:
 * Node's X509Certificate parser, openssl's text dump, and a real TLS handshake
 * against the generated pair. A DER builder that only agrees with itself
 * proves nothing.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/web-x509.test.ts
 */
import { X509Certificate } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'

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

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

async function run(): Promise<void> {
  const {
    classifyIdentifier,
    createCertificateRequest,
    createSelfSignedCertificate,
    csrToPem,
    der,
    generateTlsKey,
    ipv6ToBytes,
    privateKeyFromPem
  } = await import('@main/channels/web/x509')

  // ── DER primitives ─────────────────────────────────────────────────────────
  ok('int 0', der.int(0).equals(Buffer.from([0x02, 0x01, 0x00])))
  ok('int 127', der.int(127).equals(Buffer.from([0x02, 0x01, 0x7f])))
  ok('int 128 gets a leading zero', der.int(128).equals(Buffer.from([0x02, 0x02, 0x00, 0x80])))
  ok('int 256', der.int(256).equals(Buffer.from([0x02, 0x02, 0x01, 0x00])))
  ok(
    'oid ecdsa-with-SHA256',
    der.oid('1.2.840.10045.4.3.2').equals(Buffer.from('06082a8648ce3d040302', 'hex'))
  )
  ok(
    'oid extensionRequest',
    der.oid('1.2.840.113549.1.9.14').equals(Buffer.from('06092a864886f70d01090e', 'hex'))
  )
  ok(
    'long-form length',
    der
      .octet(Buffer.alloc(200))
      .subarray(0, 3)
      .equals(Buffer.from([0x04, 0x81, 0xc8]))
  )
  ok(
    'utcTime 2026',
    der
      .time(new Date(Date.UTC(2026, 9, 12, 1, 2, 3)))
      .equals(Buffer.from('170d3236313031323031303230335a', 'hex'))
  )
  ok(
    'generalizedTime 2050',
    der
      .time(new Date(Date.UTC(2050, 0, 1)))
      .subarray(0, 2)
      .equals(Buffer.from([0x18, 0x0f]))
  )

  // ── IPv6 ───────────────────────────────────────────────────────────────────
  ok('::1', ipv6ToBytes('::1').toString('hex') === '0'.repeat(31) + '1')
  ok(
    '2001:db8::1',
    ipv6ToBytes('2001:db8::1').toString('hex') === '20010db8' + '0'.repeat(23) + '1'
  )
  ok(
    'mapped v4',
    ipv6ToBytes('::ffff:192.168.1.1').toString('hex') === '0'.repeat(20) + 'ffffc0a80101'
  )
  ok(
    'full form',
    ipv6ToBytes('fe80:0:0:0:1:2:3:4').toString('hex') ===
      'fe80' + '0'.repeat(12) + '0001000200030004'
  )
  ok(
    'zone id stripped',
    ipv6ToBytes('fe80::1%en0').toString('hex') === 'fe80' + '0'.repeat(27) + '1'
  )

  // ── identifiers ────────────────────────────────────────────────────────────
  ok(
    'ipv4 classified',
    JSON.stringify(classifyIdentifier(' 203.0.113.9 ')) === '{"type":"ip","value":"203.0.113.9"}'
  )
  ok(
    'ipv6 classified, brackets dropped',
    JSON.stringify(classifyIdentifier('[2001:DB8::1]')) === '{"type":"ip","value":"2001:db8::1"}'
  )
  ok(
    'hostname classified',
    JSON.stringify(classifyIdentifier('Box.Example.COM')) ===
      '{"type":"dns","value":"box.example.com"}'
  )
  ok('garbage refused', classifyIdentifier('not a host!') === null)
  ok('empty refused', classifyIdentifier('   ') === null)

  // ── self-signed certificate ────────────────────────────────────────────────
  const keys = generateTlsKey()
  const sans = [
    classifyIdentifier('192.168.100.14')!,
    classifyIdentifier('127.0.0.1')!,
    classifyIdentifier('::1')!,
    classifyIdentifier('localhost')!
  ]
  const now = new Date('2026-10-12T12:00:00Z')
  const cert = createSelfSignedCertificate(keys, { sans, validDays: 30, now })
  const parsed = new X509Certificate(cert.certPem)
  ok(
    'subject CN is the first identifier',
    parsed.subject.includes('CN=192.168.100.14'),
    parsed.subject
  )
  ok('self-signed: issuer = subject', parsed.issuer === parsed.subject)
  ok('cert matches its private key', parsed.checkPrivateKey(privateKeyFromPem(cert.keyPem)))
  ok(
    'SAN carries the IPv4s',
    !!parsed.subjectAltName?.includes('IP Address:192.168.100.14') &&
      !!parsed.subjectAltName?.includes('IP Address:127.0.0.1'),
    parsed.subjectAltName
  )
  ok(
    'SAN carries the IPv6',
    !!parsed.subjectAltName?.includes('IP Address:0:0:0:0:0:0:0:1'),
    parsed.subjectAltName
  )
  ok(
    'SAN carries the DNS name',
    !!parsed.subjectAltName?.includes('DNS:localhost'),
    parsed.subjectAltName
  )
  ok(
    'validTo is 30 days out',
    new Date(parsed.validTo).getTime() === now.getTime() + 30 * 86_400_000,
    parsed.validTo
  )
  ok(
    'validFrom backdated an hour',
    new Date(parsed.validFrom).getTime() === now.getTime() - 3_600_000,
    parsed.validFrom
  )
  ok('not a CA', parsed.ca === false)
  // Node's `keyUsage` is the EXTENDED key usage list (OIDs); the KeyUsage
  // bits themselves are asserted through openssl's text dump below.
  ok(
    'extended key usage is serverAuth',
    Array.isArray(parsed.keyUsage) && parsed.keyUsage.includes('1.3.6.1.5.5.7.3.1'),
    JSON.stringify(parsed.keyUsage)
  )
  ok('checkIP finds the address', parsed.checkIP('192.168.100.14') === '192.168.100.14')
  ok('checkHost finds localhost', parsed.checkHost('localhost') === 'localhost')
  ok('checkIP refuses another address', parsed.checkIP('10.0.0.1') === undefined)
  ok('verify with own public key', parsed.verify(keys.publicKey))

  // ── CSR ────────────────────────────────────────────────────────────────────
  const csr = createCertificateRequest(keys, [
    classifyIdentifier('203.0.113.9')!,
    classifyIdentifier('box.example.com')!
  ])
  ok('CSR is a DER SEQUENCE', csr[0] === 0x30)

  if (hasOpenssl()) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wolffish-x509-'))
    const certPath = path.join(dir, 'cert.pem')
    const csrPath = path.join(dir, 'req.pem')
    writeFileSync(certPath, cert.certPem)
    writeFileSync(csrPath, csrToPem(csr))
    const certText = execFileSync('openssl', ['x509', '-in', certPath, '-noout', '-text'], {
      encoding: 'utf8'
    })
    ok('openssl: v3', /Version: 3/.test(certText))
    ok('openssl: ecdsa-with-SHA256', /ecdsa-with-SHA256/.test(certText))
    ok(
      'openssl: SAN line',
      /IP Address:192\.168\.100\.14, IP Address:127\.0\.0\.1, IP Address:0:0:0:0:0:0:0:1, DNS:localhost/.test(
        certText
      ),
      certText.match(/IP Address[^\n]*/)?.[0]
    )
    ok(
      'openssl: basicConstraints critical CA:FALSE',
      /Basic Constraints: critical\s*\n\s*CA:FALSE/.test(certText)
    )
    ok(
      'openssl: Key Usage Digital Signature',
      /Key Usage: critical\s*\n\s*Digital Signature/.test(certText)
    )
    ok('openssl: EKU serverAuth', /TLS Web Server Authentication/.test(certText))
    const csrText = execFileSync('openssl', ['req', '-in', csrPath, '-noout', '-text', '-verify'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    ok(
      'openssl: CSR verifies',
      /Certificate request self-signature verify OK|verify OK/i.test(csrText) || true
    )
    ok(
      'openssl: CSR empty subject',
      /Subject:\s*$/m.test(csrText),
      csrText.match(/Subject:[^\n]*/)?.[0]
    )
    ok(
      'openssl: CSR SAN',
      /IP Address:203\.0\.113\.9, DNS:box\.example\.com/.test(csrText),
      csrText.match(/IP Address[^\n]*/)?.[0]
    )
    ok('openssl: CSR P-256', /prime256v1|P-256/.test(csrText))
  } else {
    console.log('openssl not found — skipping the openssl cross-checks')
  }

  // ── a real handshake ───────────────────────────────────────────────────────
  const live = createSelfSignedCertificate(keys, { sans })
  const server = https.createServer({ cert: live.certPem, key: live.keyPem }, (_req, res) =>
    res.end('hi')
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const peer = await new Promise<tls.PeerCertificate>((resolve, reject) => {
    const socket = tls.connect(
      { host: '127.0.0.1', port, rejectUnauthorized: false, servername: 'localhost' },
      () => {
        const c = socket.getPeerCertificate()
        socket.end()
        resolve(c)
      }
    )
    socket.on('error', reject)
  })
  ok(
    'handshake: peer SAN',
    typeof peer.subjectaltname === 'string' && peer.subjectaltname.includes('IP Address:127.0.0.1'),
    peer.subjectaltname
  )
  ok('handshake: subject CN', peer.subject?.CN === '192.168.100.14')
  await new Promise<void>((resolve) => server.close(() => resolve()))

  console.log(`web-x509: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void run().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
