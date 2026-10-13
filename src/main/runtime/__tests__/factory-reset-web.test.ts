/**
 * Factory reset keeps the Web UI's `web/` folder — its signed-in browsers and
 * its TLS certificate — and still wipes everything else.
 *
 * Silent if wrong: a wiped `web/` signs out the browser that asked for the
 * reset and swaps the certificate under it, and nothing errors on the server.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/runtime/__tests__/factory-reset-web.test.ts
 */
import Module from 'node:module'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'wolffish-factory-reset-'))
process.env.HOME = SANDBOX

const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => SANDBOX,
        getVersion: () => '0.0.0-test'
      }
    }
  }
  return origLoad.apply(this, args)
}

let failed = 0
function ok(label: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${label}`)
  else {
    failed += 1
    console.error(`  ✗ ${label}`)
  }
}

async function main(): Promise<void> {
  const { ensureWorkspace, factoryReset } = await import('@main/workspace/workspace')
  const root = path.join(SANDBOX, '.wolffish', 'workspace')
  await ensureWorkspace()
  await fs.mkdir(path.join(root, 'web', 'tls'), { recursive: true })
  await fs.writeFile(path.join(root, 'web', 'state.json'), '{"sessions":["kept"]}')
  await fs.writeFile(path.join(root, 'web', 'tls', 'cert.pem'), 'CERT')
  await fs.writeFile(path.join(root, 'wiped.txt'), 'gone')

  await factoryReset()

  ok(
    'sessions survive',
    readFileSync(path.join(root, 'web', 'state.json'), 'utf8').includes('kept')
  )
  ok(
    'certificate survives',
    readFileSync(path.join(root, 'web', 'tls', 'cert.pem'), 'utf8') === 'CERT'
  )
  ok('other data is wiped', !existsSync(path.join(root, 'wiped.txt')))
  ok('config is laid back down', existsSync(path.join(root, 'config.json')))
  ok('no parking folder left behind', !existsSync(path.join(SANDBOX, '.wolffish', '.reset-web')))

  await fs.rm(path.join(root, 'web'), { recursive: true, force: true })
  await factoryReset()
  ok('a workspace with no web/ resets cleanly', existsSync(path.join(root, 'config.json')))

  await fs.rm(SANDBOX, { recursive: true, force: true })
  if (failed) process.exit(1)
}

void main()
