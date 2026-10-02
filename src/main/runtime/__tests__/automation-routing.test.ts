/**
 * Automations are managed by tools, never by hand — the invariant is the
 * OPERATION, not the file. The prompt has to carry it in three places at once,
 * because the failure it prevents is silent: a job written straight into
 * heartbeat.md skips schedule validation, the live scheduler reload, the
 * per-job setting markers and the edit stamps, so the Automations page and the
 * running scheduler disagree with the file until the next writer overwrites it.
 *
 * Two rules are pinned here beyond the copy:
 *
 *  1. heartbeat.md stays an ordinary file. The rule is about automation
 *     OPERATIONS, not about forbidding writes to a path — a copy edit that
 *     turns it back into a blanket ban is its own bug, and this asserts the
 *     carve-out survives.
 *  2. The bundled `automations` capability MUST declare a `version`. Capability
 *     sync to an existing install is version-gated (migrateOfficialCapabilities
 *     skips a null version), so dropping it makes every edit below inert on
 *     every machine that already ran the app — which is exactly how a fully
 *     corrected prompt ships to nobody.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/automation-routing.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as loadYaml } from 'js-yaml'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..', '..')
const read = (rel: string): string => readFileSync(path.join(REPO, rel), 'utf8')

let n = 0
const check = (name: string, fn: () => void): void => {
  try {
    fn()
    n++
    console.log(`✅ ${name}`)
  } catch (err) {
    n++
    console.log(`❌ ${name}: ${(err as Error).message}`)
    process.exitCode = 1
  }
}

const CORE = 'src/defaults/workspace/brain/prefrontal/agents.core.md'
const SKILL = 'src/defaults/workspace/brain/cerebellum/automations/SKILL.md'
const HEARTBEAT = 'src/defaults/workspace/brain/brainstem/heartbeat.md'
const GUIDE = 'src/defaults/AGENTS.md'

check('the core contract says an automation OP is a tool call', () => {
  const core = read(CORE)
  assert.ok(
    core.includes('Every operation on an automation is a tool call'),
    'agents.core.md must state that every operation on an automation is a tool call'
  )
  // The scope line. Without it the bullet reads as a file ban, which is the
  // over-correction this rule is deliberately not.
  assert.ok(
    core.includes('That governs the OPERATION, not the file'),
    'agents.core.md must scope the rule to the operation, not the path'
  )
})

check('the core contract scopes routing by operation, not by file', () => {
  const core = read(CORE)
  assert.ok(
    core.includes('The OPERATION decides, not the file'),
    'the management-capabilities paragraph must name the operation as the trigger'
  )
  assert.ok(
    core.includes('Reaching for a file to do what a tool does'),
    'the paragraph must still name the failure it exists to stop'
  )
})

check('the capability body says managing an automation is always a tool call', () => {
  const body = read(SKILL)
  assert.ok(
    body.includes('Managing an automation is always a tool call'),
    'SKILL.md must lead with the always-a-tool-call rule'
  )
  for (const tool of [
    'automation_create',
    'automation_edit',
    'automation_delete',
    'automation_run',
    'automation_list',
    'automation_check'
  ]) {
    assert.ok(
      body.includes(`\`${tool}\``),
      `SKILL.md must name ${tool} among the tools that manage a job`
    )
  }
  // The carve-out, same as the core contract.
  assert.ok(
    body.includes('That governs the operation, not the file'),
    'SKILL.md must keep the file usable as a file'
  )
})

check('the capability advertises a version, so the edit reaches an install', () => {
  const raw = read(SKILL)
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(raw)
  assert.ok(fm, 'SKILL.md must open with frontmatter')
  const parsed = loadYaml(fm[1]) as Record<string, unknown>
  const version = parsed.version
  assert.ok(
    typeof version === 'string' && version.length > 0,
    'SKILL.md must declare a version — capability sync is version-gated, and a null version ships this copy nowhere'
  )
})

check('the capability frontmatter still parses and keeps its identity', () => {
  const raw = read(SKILL)
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(raw)
  const parsed = loadYaml(fm![1]) as Record<string, unknown>
  assert.equal(parsed.name, 'automations')
  const description = String(parsed.description ?? '')
  assert.ok(
    description.includes('ONLY supported way to change an automation'),
    'the model-facing description must carry the rule — it is what surfaces the capability on a match'
  )
  const triggers = (parsed.triggers ?? []) as string[]
  for (const trigger of ['heartbeat.md', 'the heartbeat file', 'brainstem', 'my automations']) {
    assert.ok(
      triggers.includes(trigger),
      `trigger "${trigger}" must survive — it is the routing hook`
    )
  }
})

check('no model-facing description bans the file outright', () => {
  // The descriptions are what the model reads when the capability surfaces —
  // and they used to say "a file you READ, never one you WRITE", contradicting
  // the carve-out in every other copy of the rule. Scope them to OPERATIONS.
  const raw = read(SKILL)
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(raw)
  const parsed = loadYaml(fm![1]) as {
    description: string
    tools: Array<{ name: string; description: string }>
  }
  const texts = [parsed.description, ...parsed.tools.map((tool) => tool.description)]
  for (const banned of [
    'never one you WRITE',
    'never rewrite heartbeat.md',
    'is a file you READ'
  ]) {
    assert.ok(
      !texts.some((text) => text.includes(banned)),
      `"${banned}" is a blanket file ban — the rule governs the operation, not the file`
    )
  }
  assert.ok(
    parsed.description.includes('never change a job by editing it'),
    'the capability description must scope the rule to changing a job'
  )
})

check('pausing and resuming have a tool, in the schema and in the plugin', () => {
  // The doctrine routes "turn that job off" to the tools, so a tool must be
  // able to do it — otherwise the only moves left are refusing or DELETING.
  const raw = read(SKILL)
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(raw)
  const parsed = loadYaml(fm![1]) as {
    tools: Array<{
      name: string
      description: string
      parameters: Record<string, { type: string }>
    }>
  }
  const edit = parsed.tools.find((tool) => tool.name === 'automation_edit')
  assert.ok(edit, 'automation_edit must be declared')
  assert.equal(
    edit!.parameters.enabled?.type,
    'boolean',
    'automation_edit must declare a boolean `enabled`'
  )
  assert.ok(/PAUSE/.test(edit!.description), 'automation_edit must say it pauses and resumes')

  // The plugin carries its own copy of the schema — the two must agree.
  const plugin = read('src/defaults/workspace/brain/cerebellum/automations/plugin/index.mjs')
  const editDef = plugin.slice(
    plugin.indexOf("name: 'automation_edit'"),
    plugin.indexOf("name: 'automation_delete'")
  )
  assert.ok(
    /enabled:\s*\{\s*type:\s*'boolean'/.test(editDef),
    "the plugin's automation_edit definition must declare the same boolean `enabled`"
  )
  assert.ok(
    read(SKILL).includes('Pausing and resuming are tool calls too'),
    'the capability body must route pausing and resuming to automation_edit'
  )
})

check('the heartbeat file header routes management to the tools', () => {
  const beat = read(HEARTBEAT)
  assert.ok(
    beat.includes('manage these jobs with the `automation_*` tools, always'),
    'heartbeat.md must tell a reader that management is always a tool call'
  )
  assert.ok(
    beat.includes("That's about the operation, not the file"),
    'heartbeat.md must not read as a blanket ban on editing itself'
  )
  // The leading prose is read as prose, not parsed as jobs: a stray `## ` line
  // in the header would register as an automation. Guard the shape.
  const header = beat.slice(0, beat.indexOf('\n---'))
  assert.ok(
    !/^## /m.test(header),
    'the heartbeat header must not contain a "## " line — the parser reads one as a job heading'
  )
})

check('the orientation guide routes scheduling through the tools', () => {
  const guide = read(GUIDE)
  assert.ok(
    guide.includes('automation operations go through the `automation_*` tools'),
    'the quick-reference row must route scheduling through the tools'
  )
  assert.ok(
    guide.includes('Managing a job always goes through the `.automations` tools'),
    'the background-jobs section must say managing a job always goes through the tools'
  )
  assert.ok(
    !guide.includes('Add a `##` job to `brain/brainstem/heartbeat.md`'),
    'the recipe must no longer instruct a hand-added job heading'
  )
})

console.log(`\n${n - (process.exitCode ? 1 : 0)}/${n} checks passed`)
if (process.exitCode) process.exit(1)
