/**
 * Reflection sync tests — pins the desktop end of the phone's reflection
 * controls: the wire-patch sanitizer (malformed fields cost themselves, never
 * the patch), the setReflectionConfig handler's contract (sanitized patch in,
 * the desktop's canonical post-write config out), and runReflection's kind
 * gating. The apply/run deps are injected fakes — persistence and brainstem
 * scheduling live with the settings IPC they share.
 *
 * The channel is driven through a fake tunnel that just captures onRpc
 * handlers — no relay, no crypto; those live in their own tests.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/reflection-sync.test.ts
 */

import Module from 'node:module'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// workspaceRoot() reads os.homedir() at module import — override first.
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'wolffish-mobile-reflection-'))
process.env.HOME = SANDBOX

// Shim `electron` so the channel's import graph (safeStorage in keys.ts,
// app in snapshot.ts/workspace.ts) loads outside an Electron process.
const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => os.tmpdir() },
      safeStorage: {
        isEncryptionAvailable: () => false,
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

async function throws(label: string, fn: () => Promise<unknown>, pattern?: RegExp): Promise<void> {
  try {
    await fn()
    ok(label, false, 'did not throw')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ok(label, pattern ? pattern.test(message) : true, message)
  }
}

type RpcHandler = (params: Record<string, unknown>) => Promise<unknown> | unknown

async function run(): Promise<void> {
  const { MobileChannel, sanitizeReflectionPatch } = await import('@main/channels/mobile/channel')
  const { Rpc } = await import('@main/tunnel/protocol')

  // ------------------------------------------------------------- sanitizer
  ok(
    'sanitize: a well-formed patch passes whole',
    JSON.stringify(sanitizeReflectionPatch({ hour: 5, quietHours: 24 })) ===
      '{"hour":5,"quietHours":24}'
  )
  // A retired field on the wire (an older phone still sending the removed
  // `cards` switch) is dropped rather than persisted.
  ok(
    'sanitize: a retired cards field drops',
    !('cards' in sanitizeReflectionPatch({ hour: 5, cards: true }))
  )
  ok('sanitize: hour above 23 drops', sanitizeReflectionPatch({ hour: 24 }).hour === undefined)
  ok('sanitize: negative hour drops', sanitizeReflectionPatch({ hour: -1 }).hour === undefined)
  ok('sanitize: float hour drops', sanitizeReflectionPatch({ hour: 2.5 }).hour === undefined)
  ok('sanitize: hour 0 is a real hour', sanitizeReflectionPatch({ hour: 0 }).hour === 0)
  ok(
    'sanitize: quiet window below 1 drops',
    sanitizeReflectionPatch({ quietHours: 0 }).quietHours === undefined
  )
  ok(
    'sanitize: quiet window above 48 drops',
    sanitizeReflectionPatch({ quietHours: 49 }).quietHours === undefined
  )
  ok(
    'sanitize: a retired scoring map is ignored',
    JSON.stringify(sanitizeReflectionPatch({ scoring: { inapp: true } })) === '{}'
  )
  ok(
    'sanitize: a malformed field costs itself, not the patch',
    JSON.stringify(sanitizeReflectionPatch({ hour: 99, quietHours: 12 })) === '{"quietHours":12}'
  )
  ok(
    'sanitize: junk params become a no-op patch',
    JSON.stringify(sanitizeReflectionPatch(null)) === '{}'
  )

  // ------------------------------------------------- handlers via fake tunnel
  const canonical = { hour: 5, quietHours: 24 }
  const applied: unknown[] = []
  const ran: string[] = []
  const channel = new MobileChannel({
    agent: {},
    runner: {},
    serializeCapabilities: async () => [],
    applyReflectionConfig: async (patch) => {
      applied.push(patch)
      return canonical
    },
    runReflectionJob: async (kind) => {
      ran.push(kind)
      return 'coalesced'
    }
  } as never)

  const handlers = new Map<string, RpcHandler>()
  const fakeTunnel = {
    onRpc: (method: string, handler: RpcHandler) => handlers.set(method, handler),
    emit: () => undefined
  }
  ;(channel as unknown as { registerHandlers: (t: unknown) => void }).registerHandlers(fakeTunnel)
  const call = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const handler = handlers.get(method)
    if (!handler) throw new Error(`no handler registered for ${method}`)
    return Promise.resolve(handler(params))
  }

  // `quietHours: 99` is out of range and `cards` is a retired field an older
  // phone may still send — both must be dropped before the dep sees the patch.
  const answer = await call(Rpc.setReflectionConfig, {
    hour: 5,
    quietHours: 99,
    cards: false
  })
  ok(
    'set: dep receives the sanitized patch only',
    JSON.stringify(applied[0]) === '{"hour":5}',
    JSON.stringify(applied[0])
  )
  ok(
    'set: answers the canonical post-write config verbatim',
    answer === canonical,
    JSON.stringify(answer)
  )

  const runAnswer = (await call(Rpc.runReflection, { kind: 'deepClean' })) as { result: string }
  ok('run: deepClean passes through', ran[0] === 'deepClean')
  ok('run: brainstem state is wrapped as result', runAnswer.result === 'coalesced')
  await call(Rpc.runReflection, { kind: 'anything-else' })
  ok('run: junk kind falls back to the nightly job', ran[1] === 'reflection')

  // A host wired without the deps refuses rather than pretending.
  const bare = new MobileChannel({
    agent: {},
    runner: {},
    serializeCapabilities: async () => []
  } as never)
  const bareHandlers = new Map<string, RpcHandler>()
  ;(bare as unknown as { registerHandlers: (t: unknown) => void }).registerHandlers({
    onRpc: (method: string, handler: RpcHandler) => bareHandlers.set(method, handler),
    emit: () => undefined
  })
  await throws(
    'set: refused when the host serves no reflection',
    () => Promise.resolve(bareHandlers.get(Rpc.setReflectionConfig)?.({ hour: 5 })),
    /not served here/
  )
  await throws(
    'run: refused when the host serves no reflection',
    () => Promise.resolve(bareHandlers.get(Rpc.runReflection)?.({ kind: 'reflection' })),
    /not served here/
  )

  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void run()
