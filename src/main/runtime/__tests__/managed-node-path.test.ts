/**
 * The no-root Node that node_install provisions must be on PATH at every
 * launch, not only inside the node plugin's own call: on a VPS with no system
 * Node, each restart left npm invisible and every capability with npm
 * dependencies (web-search, filesystem) failed "npm command not found".
 *
 * Standalone. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/runtime/__tests__/managed-node-path.test.ts
 */
import Module from 'node:module'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => os.tmpdir() }
    }
  }
  return origLoad.apply(this, args)
}

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: unknown): void {
  if (cond) passed++
  else {
    failed++
    console.error(`FAIL ${label}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`)
  }
}

async function run(): Promise<void> {
  const { appendManagedNodeToPath } = await import('@main/runtime/cerebellum')
  const home = mkdtempSync(path.join(os.tmpdir(), 'wf-home-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  const sep = process.platform === 'win32' ? ';' : ':'
  const binDir =
    process.platform === 'win32'
      ? path.join(home, '.wolffish', 'bin', 'node')
      : path.join(home, '.wolffish', 'bin', 'node', 'bin')
  const before = ['/usr/bin', '/bin'].join(sep)

  process.env.PATH = before
  appendManagedNodeToPath()
  ok('nothing is added before Node is provisioned', process.env.PATH === before, process.env.PATH)

  mkdirSync(binDir, { recursive: true })
  const exe = path.join(binDir, process.platform === 'win32' ? 'node.exe' : 'node')
  writeFileSync(exe, '')
  chmodSync(exe, 0o755)
  appendManagedNodeToPath()
  const entries = (process.env.PATH ?? '').split(sep)
  ok('the managed Node dir is on PATH', entries.includes(binDir), entries)
  ok('it goes last, so a system Node still wins', entries[entries.length - 1] === binDir, entries)
  appendManagedNodeToPath()
  ok(
    'adding it again is a no-op',
    (process.env.PATH ?? '').split(sep).filter((e) => e === binDir).length === 1
  )

  console.log(`managed-node-path: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void run().catch((err) => {
  console.error('test harness crashed:', err)
  process.exit(1)
})
