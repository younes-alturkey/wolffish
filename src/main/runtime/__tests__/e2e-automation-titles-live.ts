/**
 * LIVE end-to-end: what an automation run is titled, through the REAL Agent
 * (processAutonomous) against the user's configured Brain, in a throwaway
 * workspace.
 *
 * A run is titled `<name> · <outcome>`: a name that stays fixed across every
 * run of one automation, and an outcome written from what THIS run reported.
 * Checked here:
 *  - while running, the conversation carries the bare name (no schedule label),
 *  - once done, the outcome is appended on disk, and the `done` lifecycle event
 *    (what the rail and the phone hear) carries that same final title,
 *  - two runs of one instruction share the name, remembered once on disk,
 *  - a `name:` marker and a procedure's own title are used verbatim.
 *
 * Reads the live provider key from ~/.wolffish/workspace/config.json; never
 * mutates the real workspace (homedir is redirected before anything loads).
 *
 * Run (tsx is not a local dependency — point electron at npx's cached copy,
 * found under ~/.npm/_npx/<hash>/node_modules/tsx/dist/cli.mjs):
 *   TSX_TSCONFIG_PATH=tsconfig.node.json ELECTRON_RUN_AS_NODE=1 npx electron <that cli.mjs> \
 *     src/main/runtime/__tests__/e2e-automation-titles-live.ts
 */
import fs from 'node:fs'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-autotitle-live-'))
const REAL_HOME = os.homedir()
;(os as unknown as { homedir: () => string }).homedir = (): string => TEST_HOME

const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  const loaded = origLoad.apply(this, args)
  if (args[0] !== 'electron') return loaded
  const electron = loaded as { app?: unknown; net?: { isOnline?: () => boolean } }
  if (electron.app && electron.net?.isOnline) return loaded
  return {
    ...electron,
    app: electron.app ?? {
      isPackaged: false,
      getAppPath: () => process.cwd(),
      getPath: () => os.tmpdir(),
      getVersion: () => '0.0.0-test',
      getName: () => 'wolffish'
    },
    net: { ...(electron.net ?? {}), isOnline: () => true }
  }
}

type ThalamusT = import('@main/runtime/thalamus').Thalamus
type TurnLifecycleEvent = { phase: string; title: string; conversationId: string }

type Cloud = { id: string; model: string; apiKey: string }
function collectProviders(node: unknown, out: Cloud[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectProviders(item, out)
    return
  }
  if (node && typeof node === 'object') {
    const rec = node as Record<string, unknown>
    if (typeof rec.id === 'string' && typeof rec.apiKey === 'string' && rec.apiKey) {
      out.push({ id: rec.id, model: String(rec.model ?? ''), apiKey: rec.apiKey })
    }
    for (const value of Object.values(rec)) collectProviders(value, out)
  }
}
const configPath = path.join(REAL_HOME, '.wolffish', 'workspace', 'config.json')
let config: Record<string, unknown>
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
} catch {
  console.error(`no config at ${configPath} — cannot run a live check`)
  process.exit(1)
}
const cloud: Cloud[] = []
collectProviders(config, cloud)
const brain = (config.llm as { brain?: { providerId: string; model: string } } | undefined)?.brain
if (cloud.length === 0 || !brain) {
  console.error('no cloud provider / Brain configured — skipping the live check')
  process.exit(1)
}

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    console.log(`  ok   ${label}`)
    return
  }
  failed++
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
}

async function main(): Promise<void> {
  const { ensureWorkspace } = await import('@main/workspace/workspace')
  const { workspaceRoot } = await import('@main/workspace/root')
  const { LocalProvider } = await import('@main/runtime/providers/local')
  const { Thalamus } = await import('@main/runtime/thalamus')
  const { Agent } = await import('@main/runtime/agent')
  const { loadConversation } = await import('@main/conversations')
  const { RUN_TITLE_SEPARATOR } = await import('@main/conversation-titler')

  await ensureWorkspace()
  const thalamus = new Thalamus(new LocalProvider())
  thalamus.setCloudProviders(cloud as unknown as Parameters<ThalamusT['setCloudProviders']>[0])
  thalamus.setBrain(brain as unknown as Parameters<ThalamusT['setBrain']>[0])
  const agent = new Agent({ thalamus, workspaceRoot: workspaceRoot() })
  await agent.init()
  const lifecycle: TurnLifecycleEvent[] = []
  agent.setAutonomousLifecycleListener((ev) => lifecycle.push(ev as TurnLifecycleEvent))
  console.log(`Brain: ${brain!.providerId}/${brain!.model}`)

  const instruction =
    'Pick one prime number between 100 and 300, a different one each run, and explain in two ' +
    'short sentences why it is prime. Do not use any tools.'
  const titles: string[] = []
  for (let i = 1; i <= 2; i++) {
    const r = await agent.processAutonomous({
      instruction,
      jobLabel: 'Daily (07:00)',
      channel: 'heartbeat'
    })
    const disk = await loadConversation(r.conversationId)
    const of = (phase: string): TurnLifecycleEvent | undefined =>
      lifecycle.find((e) => e.conversationId === r.conversationId && e.phase === phase)
    const title = disk?.title ?? ''
    console.log(`  run ${i}: "${of('started')?.title}" -> "${title}"`)
    ok(`run ${i}: started under the bare name`, !of('started')?.title.includes(RUN_TITLE_SEPARATOR))
    ok(`run ${i}: no schedule label`, !title.includes('Daily (07:00)'), title)
    ok(`run ${i}: outcome appended`, title.includes(RUN_TITLE_SEPARATOR), title)
    ok(`run ${i}: done event carries the final title`, of('done')?.title === title)
    ok(`run ${i}: answer kept`, disk?.messages.length === 2)
    titles.push(title)
  }
  const names = titles.map((t) => t.split(RUN_TITLE_SEPARATOR)[0])
  ok('both runs share one name', names[0] === names[1], names.join(' | '))
  const cache = JSON.parse(
    fs.readFileSync(
      path.join(workspaceRoot(), 'brain', 'brainstem', 'automation-names.json'),
      'utf8'
    )
  ) as Array<{ name: string }>
  ok(
    'name remembered once',
    cache.length === 1 && cache[0].name === names[0],
    JSON.stringify(cache)
  )

  const named = await agent.processAutonomous({
    instruction: 'Say the word hello and nothing else. Do not use tools.',
    jobLabel: 'Hourly (00)',
    jobName: 'Hello Check',
    channel: 'heartbeat'
  })
  const namedTitle = (await loadConversation(named.conversationId))?.title ?? ''
  console.log(`  named run -> "${namedTitle}"`)
  ok('a name: marker is used as-is', namedTitle.startsWith('Hello Check'), namedTitle)

  const proc = await agent.processAutonomous({
    instruction: 'Name one planet in our solar system, one word. Do not use tools.',
    jobLabel: 'Planet Picker',
    channel: 'procedure'
  })
  const procTitle = (await loadConversation(proc.conversationId))?.title ?? ''
  console.log(`  procedure run -> "${procTitle}"`)
  ok('a procedure is named by its own title', procTitle.startsWith('Planet Picker'), procTitle)

  fs.rmSync(TEST_HOME, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
