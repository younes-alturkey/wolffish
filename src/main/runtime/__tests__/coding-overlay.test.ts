/**
 * The coding overlay (prefrontal.buildCodingOverlay): the base doctrine
 * loads from brain/prefrontal/coding.md with HTML comments stripped, the
 * DeepSeek addendum is appended only for that provider, and an unknown or
 * odd provider string never reads outside the prefrontal folder.
 *
 * Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/coding-overlay.test.ts
 */
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'

// deps touch `electron.app` at import time — shim before any app import.
const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => os.tmpdir() },
      net: { isOnline: () => true }
    }
  }
  return origLoad.apply(this, args)
}

let passed = 0
let failed = 0
function ok(name: string, cond: unknown, detail?: unknown): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}`)
    if (detail !== undefined)
      console.log('    ', typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
}

async function main(): Promise<void> {
  const { Prefrontal } = await import('../prefrontal')
  const root = path.join(process.cwd(), 'src/defaults/workspace')
  const prefrontal = new Prefrontal({ workspaceRoot: root })

  const deepseek = await prefrontal.buildCodingOverlay('deepseek')
  ok('base doctrine present', deepseek.includes('<coding>') && deepseek.includes('</coding>'))
  ok(
    'verify loop is in the doctrine',
    deepseek.includes('Narrowest check first') && deepseek.includes('A fix is not done until')
  )
  ok('git rules are in the doctrine', deepseek.includes('Never commit, amend, push'))
  ok(
    'HTML comments are stripped',
    !deepseek.includes('READ ONLY') && !deepseek.includes('<!--'),
    deepseek.slice(0, 200)
  )
  ok('DeepSeek addendum appended for deepseek', deepseek.includes('<coding_deepseek>'))
  ok('overlay starts with a blank-line separator', deepseek.startsWith('\n\n'))

  const anthropic = await prefrontal.buildCodingOverlay('anthropic')
  ok(
    'other providers get the base only',
    anthropic.includes('<coding>') && !anthropic.includes('<coding_deepseek>')
  )
  const none = await prefrontal.buildCodingOverlay(null)
  ok(
    'null provider gets the base only',
    none.includes('<coding>') && !none.includes('<coding_deepseek>')
  )
  const odd = await prefrontal.buildCodingOverlay('../identity/soul')
  ok('a path-shaped provider never reads another file', odd === anthropic)

  const missing = new Prefrontal({ workspaceRoot: path.join(os.tmpdir(), 'no-such-workspace-xyz') })
  ok(
    'a workspace without coding.md yields an empty overlay',
    (await missing.buildCodingOverlay('deepseek')) === ''
  )

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

void main()
