/**
 * A headless boot on macOS must never ask the keychain anything.
 *
 * `safeStorage.isEncryptionAvailable()` creates the app's "Safe Storage"
 * keychain item on first use, and with the login keychain locked or missing
 * (SSH, a background shell, a scratch HOME) that SecItemAdd parks the main
 * thread on an authorization dialog nobody can see: boot logs stop after
 * `[boot] headless`, 0% CPU, the CLI socket accepts and never answers. The
 * probe used to run on every boot through getStatus() → storageBackend(),
 * pairing or not. Here the shim's probe THROWS, so any touch fails loudly.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/mobile-keys-headless.test.ts
 */
import Module from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// workspaceRoot() reads os.homedir() at module import — override first.
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'wolffish-keys-headless-'))
process.env.HOME = SANDBOX
Object.defineProperty(process, 'platform', { value: 'darwin' })

let probes = 0
let probeBlocks = true
const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => os.tmpdir(),
        getVersion: () => '0.0.0-test'
      },
      safeStorage: {
        isEncryptionAvailable: () => {
          probes++
          if (probeBlocks) throw new Error('keychain prompt — the main thread would hang here')
          return false
        },
        encryptString: (s: string) => Buffer.from(s),
        decryptString: (b: Buffer) => b.toString()
      }
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
  const keys = await import('@main/channels/mobile/keys')
  const file = path.join(SANDBOX, '.wolffish', 'workspace', 'mobile', 'pairing.json')
  keys.configureKeystore({ headless: true })

  // ------------------------------------- a file sealed by a windowed session
  mkdirSync(path.dirname(file), { recursive: true })
  const sealed = JSON.stringify({ enc: true, data: Buffer.from('nope').toString('base64') })
  writeFileSync(file, sealed)
  ok('a sealed file reads as no pairing without a probe', (await keys.loadPairing()) === null)
  let refused: string | null = null
  await keys.saveRelayUrl('wss://example.invalid').catch((e: Error) => (refused = e.message))
  ok('writing over a sealed file is refused', refused !== null && /sealed/.test(refused))
  ok('the sealed file is untouched', readFileSync(file, 'utf8') === sealed)
  ok('no keychain probe so far', probes === 0, `probes=${probes}`)

  // ----------------------------------------------- the fresh-runtime boot
  writeFileSync(file, '')
  const { unlinkSync } = await import('node:fs')
  unlinkSync(file)
  const backend = keys.storageBackend()
  ok('the privacy card says plaintext', backend.backend === 'plaintext' && !backend.available)
  ok('no pairing on a fresh runtime', (await keys.loadPairing()) === null)
  ok('no relay override on a fresh runtime', (await keys.loadRelayUrl()) === null)
  const identity = await keys.loadIdentity()
  ok('an identity is minted', identity.publicKey.length === 32)
  const envelope = JSON.parse(readFileSync(file, 'utf8')) as { enc: boolean; data: string }
  ok('the file is written in the clear and says so', envelope.enc === false)
  ok('the clear file carries the identity', JSON.parse(envelope.data).identity.publicKey.length > 0)
  const again = await keys.loadIdentity()
  ok('the identity is reused', Buffer.from(again.publicKey).equals(Buffer.from(identity.publicKey)))
  ok('still no keychain probe', probes === 0, `probes=${probes}`)

  // ------------------------------------------- a windowed boot still asks
  probeBlocks = false
  keys.configureKeystore({ headless: false })
  ok('with a window the backend is probed', keys.storageBackend().backend === 'unavailable')
  ok('the probe ran exactly once', probes === 1, `probes=${probes}`)

  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void run()
