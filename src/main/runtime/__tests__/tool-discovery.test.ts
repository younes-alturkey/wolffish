/**
 * Tool-discovery tests against the REAL Cerebellum (no hand-copied mirrors):
 * core-set exposure, conversation-scoped activation + version isolation,
 * tool_search / tool_activate, transparent auto-activation on call, LRU
 * eviction invisibility, capability-index shape (loaded markers, grouped
 * collapse), and prompt/param derivation from one predicate.
 *
 * Standalone — no vitest/jest in this repo.
 * Run: npx tsx --tsconfig tsconfig.node.json src/main/runtime/__tests__/tool-discovery.test.ts
 */
import Module from 'node:module'
import os from 'node:os'

// deps touch `electron.app` at import time — shim before any app import.
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

function ok(label: string, cond: boolean): void {
  if (cond) {
    passed++
  } else {
    failed++
    console.error(`FAIL ${label}`)
  }
}

async function run(): Promise<void> {
  const { Cerebellum, CORE_CAPABILITIES } = await import('@main/runtime/cerebellum')
  type Cap = Parameters<InstanceType<typeof Cerebellum>['registerInProcessCapability']>[0]

  const cerebellum = new Cerebellum({})
  await cerebellum.loadAll() // no workspaceRoot → registers only tool-discovery

  const makeCap = (name: string, toolNames: string[], description = `${name} things`): Cap => ({
    name,
    dir: '',
    description,
    triggers: { keywords: [name] },
    tools: toolNames.map((t) => ({
      name: t,
      description: `${t} tool for ${name}`,
      parameters: {}
    })),
    body: '',
    hasPlugin: true,
    status: 'ok',
    requires: [],
    packages: {},
    npmDependencies: {}
  })
  const stubPlugin = (
    name: string
  ): {
    name: string
    tools: never[]
    execute: () => Promise<{ success: boolean; output: string }>
  } => ({
    name,
    tools: [],
    execute: async () => ({ success: true, output: `${name} ran` })
  })

  // one core cap, two discoverable caps
  cerebellum.registerInProcessCapability(makeCap('shell', ['shell_exec']), stubPlugin('shell'))
  cerebellum.registerInProcessCapability(
    makeCap('ffmpeg', ['ffmpeg_run', 'ffmpeg_check'], 'convert resize compress video audio media'),
    stubPlugin('ffmpeg')
  )
  cerebellum.registerInProcessCapability(
    makeCap('github', ['github_issue_create'], 'github repos issues pull requests'),
    stubPlugin('github')
  )

  // ── Core vs discoverable exposure ───────────────────────────────────
  ok('shell is core', CORE_CAPABILITIES.has('shell'))
  const convA = 'conv-a'
  const defsA = cerebellum.getToolDefinitions(undefined, { conversationId: convA })
  const namesA = new Set(defsA.map((d) => d.name))
  ok('core tools exposed', namesA.has('shell_exec'))
  ok('discovery tools exposed', namesA.has('tool_search') && namesA.has('tool_activate'))
  ok('non-core tools NOT exposed before activation', !namesA.has('ffmpeg_run'))
  ok(
    'management view still returns everything',
    cerebellum.getToolDefinitions().some((d) => d.name === 'ffmpeg_run')
  )

  // ── Capability index ────────────────────────────────────────────────
  const index = cerebellum.getCapabilityIndex(undefined, convA)
  ok('index lists unloaded ffmpeg', /- ffmpeg \(2 tools\)/.test(index))
  ok('index marks core as loaded', /- shell \(1 tools\).*\[loaded\]/.test(index))
  ok('index has no schemas', !index.includes('parameters'))

  // ── tool_search activates for THIS conversation only ────────────────
  const v0a = cerebellum.getToolsetVersion(convA)
  const v0b = cerebellum.getToolsetVersion('conv-b')
  const search = await cerebellum.runWithConversation(convA, () =>
    cerebellum.executeTool('tool_search', { query: 'resize a video' })
  )
  ok('tool_search succeeds', search.success === true)
  ok('tool_search reports activation', /Activated `ffmpeg`/.test(search.output ?? ''))
  const defsA2 = cerebellum.getToolDefinitions(undefined, { conversationId: convA })
  ok(
    'ffmpeg exposed after search',
    defsA2.some((d) => d.name === 'ffmpeg_run')
  )
  ok('conv-a version bumped', cerebellum.getToolsetVersion(convA) > v0a)
  ok(
    'conv-b version UNCHANGED (no cross-invalidation)',
    cerebellum.getToolsetVersion('conv-b') === v0b
  )
  ok(
    'conv-b still lean',
    !cerebellum
      .getToolDefinitions(undefined, { conversationId: 'conv-b' })
      .some((d) => d.name === 'ffmpeg_run')
  )

  // ── tool_activate explicit ──────────────────────────────────────────
  const act = await cerebellum.runWithConversation(convA, () =>
    cerebellum.executeTool('tool_activate', { capability: 'github' })
  )
  ok('tool_activate succeeds', act.success === true && /github_issue_create/.test(act.output ?? ''))
  const badAct = await cerebellum.executeTool('tool_activate', { capability: 'nope' })
  ok(
    'tool_activate unknown name errors instructively',
    badAct.success === false && /tool_search/.test(badAct.error ?? '')
  )

  // ── Unknown tool: deterministic instructive error ───────────────────
  const unknown = await cerebellum.executeTool('quantum_flux', {})
  ok(
    'unknown tool error mentions tool_search',
    unknown.success === false && /tool_search/.test(unknown.error ?? '')
  )

  // ── Transparent auto-activation on direct call ──────────────────────
  cerebellum.registerInProcessCapability(
    makeCap('notion', ['notion_read'], 'notion pages databases'),
    stubPlugin('notion')
  )
  const before = cerebellum.getToolDefinitions(undefined, { conversationId: 'conv-c' })
  ok('notion not exposed to conv-c', !before.some((d) => d.name === 'notion_read'))
  const call = await cerebellum.runWithConversation('conv-c', () =>
    cerebellum.executeTool('notion_read', {})
  )
  ok('direct call to unexposed tool executes', call.success === true)
  const after = cerebellum.getToolDefinitions(undefined, { conversationId: 'conv-c' })
  ok(
    'capability auto-activated by the call',
    after.some((d) => d.name === 'notion_read')
  )

  // ── LRU eviction is invisible (auto-reactivation) ───────────────────
  for (let i = 0; i < 12; i++) {
    cerebellum.registerInProcessCapability(
      makeCap(`bulk${i}`, [`bulk${i}_go`]),
      stubPlugin(`bulk${i}`)
    )
    cerebellum.activateCapability(`bulk${i}`, 'conv-lru')
  }
  const lruDefs = cerebellum.getToolDefinitions(undefined, { conversationId: 'conv-lru' })
  const bulkExposed = lruDefs.filter((d) => d.name.startsWith('bulk')).length
  ok('LRU caps active set at 10', bulkExposed === 10)
  ok('oldest was evicted', !lruDefs.some((d) => d.name === 'bulk0_go'))
  const revived = await cerebellum.runWithConversation('conv-lru', () =>
    cerebellum.executeTool('bulk0_go', {})
  )
  ok('evicted tool still executes (invisible eviction)', revived.success === true)
  ok(
    'and re-exposes after the call',
    cerebellum
      .getToolDefinitions(undefined, { conversationId: 'conv-lru' })
      .some((d) => d.name === 'bulk0_go')
  )

  // ── Grouped collapse past the index line cap ────────────────────────
  const big = new Cerebellum({})
  await big.loadAll()
  for (let i = 0; i < 75; i++) {
    big.registerInProcessCapability(
      makeCap(`cap${String(i).padStart(2, '0')}`, [`cap${i}_a`, `cap${i}_b`]),
      stubPlugin(`cap${i}`)
    )
  }
  const bigIndex = big.getCapabilityIndex(undefined, 'x')
  ok(
    'index collapses remainder to grouped count',
    /…plus \d+ more capabilities \(\d+ tools\)/.test(bigIndex)
  )
  // 60 listed capabilities, the always-listed in-process core rows
  // (tool-discovery, todo, changes) and the grouped remainder line.
  ok('index stays bounded', bigIndex.split('\n').length <= 65)

  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void run().catch((err) => {
  console.error('test harness crashed:', err)
  process.exit(1)
})
