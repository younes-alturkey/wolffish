/**
 * Public links, the records: expiry parsing, the path policy, the store's
 * one-record-per-target rule, and the three tools over a fake origin.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/web-public.test.ts
 */
import Module from 'node:module'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
  existsSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'wolffish-web-public-'))
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

async function run(): Promise<void> {
  const {
    PublicShareStore,
    buildWebPublicCapability,
    expiryToMs,
    resolveSharePath,
    shareUrl,
    sharePath
  } = await import('@main/channels/web/public')
  const workspace = path.join(SANDBOX, '.wolffish', 'workspace')
  mkdirSync(path.join(workspace, 'files', 'site', 'css'), { recursive: true })
  mkdirSync(path.join(workspace, 'web', 'tls'), { recursive: true })
  mkdirSync(path.join(SANDBOX, '.ssh'), { recursive: true })
  mkdirSync(path.join(SANDBOX, '.wolffish', 'runtime'), { recursive: true })
  writeFileSync(path.join(workspace, 'files', 'report.pdf'), '%PDF-1.4 fake')
  writeFileSync(path.join(workspace, 'files', 'site', 'index.html'), '<h1>site</h1>')
  writeFileSync(path.join(workspace, 'files', 'site', 'css', 'a.css'), 'h1{}')
  writeFileSync(path.join(workspace, 'web', 'tls', 'key.pem'), 'SECRET')
  writeFileSync(path.join(workspace, 'config.json'), '{}')
  writeFileSync(path.join(SANDBOX, '.ssh', 'id_ed25519'), 'SECRET')
  symlinkSync(
    path.join(workspace, 'web', 'tls', 'key.pem'),
    path.join(workspace, 'files', 'sneaky.pem')
  )

  console.log('step: expiry parsing')
  ok('never → null', expiryToMs('never') === null && expiryToMs(undefined) === null)
  ok('30m', expiryToMs('30m') === 30 * 60_000)
  ok('2h', expiryToMs('2 hours') === 2 * 3_600_000)
  ok('7d', expiryToMs('7d') === 7 * 86_400_000)
  ok('2w', expiryToMs('2w') === 14 * 86_400_000)
  const bad = expiryToMs('soon')
  ok('garbage → error', typeof bad === 'object' && bad !== null && 'error' in bad)

  console.log('step: path policy')
  const file = await resolveSharePath('files/report.pdf')
  ok(
    'relative path resolves against the workspace',
    file.ok && file.kind === 'file' && file.path.endsWith('report.pdf')
  )
  const site = await resolveSharePath(path.join(workspace, 'files', 'site'))
  ok('a folder is a site', site.ok && site.kind === 'site')
  const home = await resolveSharePath('~/.wolffish/workspace/files/report.pdf')
  ok('~ expands', home.ok)
  ok('missing path refused', !(await resolveSharePath('files/nope.txt')).ok)
  ok('tls key refused', !(await resolveSharePath('web/tls/key.pem')).ok)
  ok('the web dir itself refused', !(await resolveSharePath('web')).ok)
  ok('config.json refused', !(await resolveSharePath('config.json')).ok)
  ok('~/.ssh refused', !(await resolveSharePath('~/.ssh/id_ed25519')).ok)
  ok('chromium runtime refused', !(await resolveSharePath('~/.wolffish/runtime')).ok)
  ok('symlink into a forbidden dir refused', !(await resolveSharePath('files/sneaky.pem')).ok)
  ok(
    'a parent of a forbidden dir refused (would contain it)',
    !(await resolveSharePath(workspace)).ok && !(await resolveSharePath('~')).ok
  )

  console.log('step: store')
  let now = 1_000_000
  const storeFile = path.join(workspace, 'web', 'public.json')
  const store = new PublicShareStore(storeFile, () => now)
  const a = await store.create({
    kind: 'file',
    path: file.ok ? file.path : '',
    port: null,
    name: 'Report',
    download: false,
    ttlMs: 3_600_000,
    conversationId: 'conv_1'
  })
  ok('created', !a.existed && a.share.token.length >= 32 && a.share.expiresAt === now + 3_600_000)
  ok('persisted', existsSync(storeFile) && readFileSync(storeFile, 'utf8').includes(a.share.token))
  const again = await store.create({
    kind: 'file',
    path: file.ok ? file.path : '',
    port: null,
    name: 'Report v2',
    download: true,
    ttlMs: null,
    conversationId: null
  })
  ok(
    'same path → same link, fields refreshed',
    again.existed &&
      again.share.token === a.share.token &&
      again.share.name === 'Report v2' &&
      again.share.download &&
      again.share.expiresAt === null
  )
  ok('resolve by token', (await store.resolve(a.share.token))?.id === a.share.id)
  ok('unknown token → null', (await store.resolve('nope')) === null)
  const timed = await store.create({
    kind: 'proxy',
    path: null,
    port: 3000,
    name: 'app',
    download: false,
    ttlMs: 60_000,
    conversationId: null
  })
  now += 60_001
  ok(
    'expired → null and swept',
    (await store.resolve(timed.share.token)) === null && (await store.list()).length === 1
  )
  const revoked = await store.revoke(a.share.id)
  ok('revoke by id', revoked?.id === a.share.id && (await store.resolve(a.share.token)) === null)
  ok('revoke unknown → null', (await store.revoke('zzz')) === null)
  await store.create({
    kind: 'site',
    path: site.ok ? site.path : '',
    port: null,
    name: 's',
    download: false,
    ttlMs: null,
    conversationId: null
  })
  await store.create({
    kind: 'proxy',
    path: null,
    port: 4000,
    name: 'p',
    download: false,
    ttlMs: null,
    conversationId: null
  })
  ok('revokeAll', (await store.revokeAll()) === 2 && (await store.list()).length === 0)
  ok(
    'sharePath shapes',
    sharePath({ token: 'T', kind: 'file' }) === '/p/T' &&
      sharePath({ token: 'T', kind: 'site' }) === '/p/T/'
  )
  ok(
    'shareUrl trims the origin slash',
    shareUrl('http://h:1/', { token: 'T', kind: 'proxy' }) === 'http://h:1/p/T/'
  )

  console.log('step: tools')
  let origin: string | null = 'http://203.0.113.5:8787'
  let changes = 0
  const { capability, plugin } = buildWebPublicCapability({
    store,
    publicOrigin: () => origin,
    onChange: () => changes++
  })
  ok(
    'capability shape',
    capability.name === 'web-public' &&
      capability.tools.map((t) => t.name).join(',') === 'public_link,public_links,public_unlink'
  )
  ok(
    'only public_links is read-only',
    capability.tools
      .filter((t) => t.readOnly)
      .map((t) => t.name)
      .join(',') === 'public_links'
  )
  const link = await plugin.execute(
    'public_link',
    { path: 'files/report.pdf', expires: '24h' },
    {} as never
  )
  ok(
    'publish a file',
    link.success === true &&
      /Published: http:\/\/203\.0\.113\.5:8787\/p\/[A-Za-z0-9_-]+\n/.test(link.output ?? ''),
    link.error ?? link.output
  )
  ok('onChange fired', changes === 1)
  const idMatch = /id ([a-f0-9]{8})/.exec(link.output ?? '')
  const siteLink = await plugin.execute(
    'public_link',
    { path: 'files/site', name: 'My site' },
    {} as never
  )
  ok(
    'publish a site ends with /',
    siteLink.success === true && /\/p\/[A-Za-z0-9_-]+\/\n/.test(siteLink.output ?? ''),
    siteLink.output
  )
  const proxyLink = await plugin.execute('public_link', { port: 5173 }, {} as never)
  ok(
    'publish a port mentions the prefix',
    proxyLink.success === true && /X-Forwarded-Prefix=\/p\//.test(proxyLink.output ?? ''),
    proxyLink.output
  )
  const both = await plugin.execute(
    'public_link',
    { path: 'files/report.pdf', port: 1 },
    {} as never
  )
  ok('path and port together refused', both.success === false)
  const neither = await plugin.execute('public_link', {}, {} as never)
  ok('neither refused', neither.success === false)
  const badPort = await plugin.execute('public_link', { port: 70000 }, {} as never)
  ok('bad port refused', badPort.success === false)
  const badExpiry = await plugin.execute(
    'public_link',
    { path: 'files/report.pdf', expires: 'soon' },
    {} as never
  )
  ok('bad expiry refused', badExpiry.success === false && /expires/.test(badExpiry.error ?? ''))
  const secret = await plugin.execute('public_link', { path: 'web/tls/key.pem' }, {} as never)
  ok('secret refused by the tool', secret.success === false && /secrets/.test(secret.error ?? ''))
  const list = await plugin.execute('public_links', {}, {} as never)
  ok(
    'list shows three',
    list.success === true && /^3 public links:/.test(list.output ?? ''),
    list.output
  )
  const un = await plugin.execute('public_unlink', { id: idMatch?.[1] ?? '' }, {} as never)
  ok('unlink by id', un.success === true && /now answers 404/.test(un.output ?? ''), un.error)
  const unUrl = await plugin.execute(
    'public_unlink',
    { id: /(http:\/\/\S+\/p\/[A-Za-z0-9_-]+\/)/.exec(siteLink.output ?? '')?.[1] ?? '' },
    {} as never
  )
  ok('unlink by url', unUrl.success === true, unUrl.error)
  const unAll = await plugin.execute('public_unlink', { id: 'all' }, {} as never)
  ok('unlink all', unAll.success === true && /Revoked 1/.test(unAll.output ?? ''), unAll.output)
  ok(
    'list empty',
    /No public links/.test((await plugin.execute('public_links', {}, {} as never)).output ?? '')
  )
  origin = null
  const off = await plugin.execute('public_link', { path: 'files/report.pdf' }, {} as never)
  ok(
    'no origin → refused with a reason',
    off.success === false && /not listening/.test(off.error ?? '')
  )

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
