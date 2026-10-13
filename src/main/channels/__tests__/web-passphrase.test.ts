/**
 * The generated master passphrase: the wordlist is clean, twelve words from
 * it pass the same strength policy the panel enforces, the first launch
 * generates one and later launches leave it alone, and the web:* handlers
 * show it, replace it, and forget it once the user sets a password of their
 * own.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/web-passphrase.test.ts
 */
import Module from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// workspaceRoot() reads os.homedir() at module import — override first.
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'wolffish-web-passphrase-'))
process.env.HOME = SANDBOX
process.env.USERPROFILE = SANDBOX
const workspace = path.join(SANDBOX, '.wolffish', 'workspace')
mkdirSync(workspace, { recursive: true })
writeFileSync(path.join(workspace, 'config.json'), '{}\n')

// Shim `electron` so the import graph loads outside an Electron process.
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
  const { PASSPHRASE_WORDS, PASSPHRASE_WORD_COUNT, generatePassphrase, ensureWebUiPassword } =
    await import('@main/channels/web/passphrase')
  const { validatePassword, verifyPassword } = await import('@main/channels/web/auth')
  const { scorePassword } = await import('@main/channels/web/password-strength')
  const { getWebUiConfig, mergeWebUiConfig } = await import('@main/workspace/workspace')
  const { registerWebIpc, toPublicConfig } = await import('@main/channels/web/ipc')

  // ── the wordlist ──────────────────────────────────────────────────────────
  ok('at least 1024 words', PASSPHRASE_WORDS.length >= 1024, String(PASSPHRASE_WORDS.length))
  ok('no duplicates', new Set(PASSPHRASE_WORDS).size === PASSPHRASE_WORDS.length)
  ok(
    'short lowercase words only',
    PASSPHRASE_WORDS.every((w) => /^[a-z]{3,7}$/.test(w))
  )
  ok(
    'twelve words carry at least 120 bits',
    PASSPHRASE_WORD_COUNT * Math.log2(PASSPHRASE_WORDS.length) >= 120
  )

  // ── generation ────────────────────────────────────────────────────────────
  const a = generatePassphrase()
  const b = generatePassphrase()
  ok('twelve words', a.split(' ').length === PASSPHRASE_WORD_COUNT, a)
  ok(
    'every word is from the list',
    a.split(' ').every((w) => PASSPHRASE_WORDS.includes(w))
  )
  ok('two phrases differ', a !== b)
  ok('passes the password policy', validatePassword(a) === null, validatePassword(a) ?? '')
  ok('rated strong', scorePassword(a).level === 'strong')

  // ── defaults and first launch ─────────────────────────────────────────────
  ok('Web UI is on by default', mergeWebUiConfig(undefined).enabled === true)
  ok('no password before first launch', !(await getWebUiConfig()).passwordHash)
  const first = await ensureWebUiPassword()
  ok('first launch generates', first.generated === true)
  const cfg1 = await getWebUiConfig()
  ok(
    'clear passphrase stored',
    typeof cfg1.password === 'string' && cfg1.password.split(' ').length === 12
  )
  ok('hash verifies the passphrase', await verifyPassword(cfg1.password ?? '', cfg1.passwordHash))
  ok(
    'config.json holds it',
    readFileSync(path.join(workspace, 'config.json'), 'utf8').includes(cfg1.password ?? '\u0000')
  )
  const second = await ensureWebUiPassword()
  ok(
    'second launch leaves it alone',
    second.generated === false && (await getWebUiConfig()).password === cfg1.password
  )
  const pub1 = toPublicConfig(cfg1)
  ok(
    'public config says generated and carries neither phrase nor hash',
    pub1.passwordSet && pub1.passwordGenerated && !('password' in pub1) && !('passwordHash' in pub1)
  )

  // ── the handlers, over a stand-in server ──────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlers = new Map<string, (...a: any[]) => any>()
  let revoked = 0
  let applied = 0
  const server = {
    revokeAllSessions: async () => {
      revoked++
    },
    applyConfig: async () => {
      applied++
    },
    status: async () => ({ enabled: true, listening: true })
  }
  const broadcasts: string[] = []
  registerWebIpc({
    handle: (channel, fn) => {
      handlers.set(channel, fn)
    },
    server: server as unknown as import('@main/channels/web/server').WebServer,
    broadcast: (channel) => {
      broadcasts.push(channel)
    },
    syncCapability: () => undefined
  })
  const e = {} as import('electron').IpcMainInvokeEvent
  const reveal = await handlers.get('web:revealPassword')!(e)
  ok('reveal returns the phrase', reveal.password === cfg1.password)
  const regen = await handlers.get('web:regeneratePassword')!(e)
  ok(
    'regenerate returns a new twelve-word phrase',
    regen.password !== cfg1.password && regen.password.split(' ').length === 12
  )
  ok('regenerate signs every browser out and re-applies', revoked === 1 && applied === 1)
  ok('regenerate persisted', (await getWebUiConfig()).password === regen.password)
  ok(
    'regenerate verifies and reports generated',
    (await verifyPassword(regen.password, (await getWebUiConfig()).passwordHash)) &&
      regen.config.passwordGenerated === true
  )
  ok('config change broadcast', broadcasts.includes('web:configChange'))

  await handlers.get('web:setPassword')!(e, 'correct horse battery staple')
  const cfg3 = await getWebUiConfig()
  ok(
    'own password drops the clear phrase and verifies',
    cfg3.password === null &&
      (await verifyPassword('correct horse battery staple', cfg3.passwordHash))
  )
  ok(
    'reveal is null after an own password',
    (await handlers.get('web:revealPassword')!(e)).password === null
  )
  ok(
    'public config: set, not generated',
    toPublicConfig(cfg3).passwordSet && toPublicConfig(cfg3).passwordGenerated === false
  )
  const third = await ensureWebUiPassword()
  ok(
    'launch keeps an own password',
    third.generated === false && (await getWebUiConfig()).passwordHash === cfg3.passwordHash
  )

  await handlers.get('web:setConfig')!(e, { password: 'x', passwordHash: 'y', verbose: true })
  const cfg4 = await getWebUiConfig()
  ok(
    'setConfig strips both password fields',
    cfg4.password === null && cfg4.passwordHash === cfg3.passwordHash && cfg4.verbose === true
  )

  let refused = ''
  try {
    await handlers.get('web:setPassword')!(e, 'password123')
  } catch (err) {
    refused = err instanceof Error ? err.message : String(err)
  }
  ok('weak own password refused', /weak|common/.test(refused), refused)

  console.log(`web-passphrase: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void run().catch((err) => {
  console.error(err)
  process.exit(1)
})
