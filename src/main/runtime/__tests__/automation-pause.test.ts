/**
 * Pausing and resuming an automation through the `automation_*` tools.
 *
 * The routing doctrine sends "turn that job off" to the tools and never to the
 * file — which is only honest if a tool can actually do it. This pins that one
 * can, and that it does it the way the Automations page's own off switch does:
 *
 *  1. automation_list shows paused jobs in place, numbered in file order, and
 *     leaves every other comment (the examples, a user's note, a hand-paused
 *     job that lost its `-->`) opaque
 *  2. pausing only WRAPS the job — the engine stops scheduling it, while the
 *     edit-stamp hash (parseHeartbeatBlocks) sees the very same block, so a
 *     pause is never mistaken for an edit
 *  3. resuming is the exact inverse: the file comes back byte-for-byte
 *  4. both paused forms resume (body-less one-liner, block with markers)
 *  5. a paused job can be edited and deleted without being switched back on,
 *     and cannot be run
 *  6. "false" as a string pauses — it is never read as truthy
 *  7. a paused one-time job whose moment has passed is not resumed as it is
 *     (the reload would retire it unrun) — it takes a new schedule
 *
 * The plugin runs as shipped against a host whose scheduler view is the REAL
 * engine parser, so "stops firing" means the brainstem no longer schedules it.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/automation-pause.test.ts
 */

import fs from 'node:fs'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-automation-pause-'))
;(os as unknown as { homedir: () => string }).homedir = (): string => TEST_HOME

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
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
}

type ToolResult = { success: boolean; output?: string; error?: string }
type Plugin = {
  init: (context: unknown) => Promise<void>
  execute: (tool: string, args?: Record<string, unknown>) => Promise<ToolResult>
}

const EXAMPLES = [
  '<!--',
  '## Daily (07:00)',
  'An example the user can uncomment — never a job, never listed.',
  '-->'
].join('\n')

const FIXTURE = [
  '# Heartbeat',
  '',
  'Prose the user wrote about their jobs.',
  '',
  '---',
  '',
  '## Daily (08:00)',
  '',
  'name: Morning digest',
  'icon: 📰',
  '',
  'Summarize the overnight news.',
  '',
  '<!-- ## Hourly (15) -->',
  '',
  '## Weekly (Monday 09:30)',
  '',
  'Plan the week.',
  '',
  '<!-- ## Every (2h)',
  '',
  'name: Inbox sweep',
  '',
  'Check the inbox.',
  '-->',
  '',
  '<!-- ## just a note the user left -->',
  '',
  EXAMPLES,
  ''
].join('\n')

async function run(): Promise<void> {
  const { parseHeartbeat, parseHeartbeatBlocks, previewSchedule } =
    await import('@main/runtime/brainstem')

  let file = FIXTURE
  let writes = 0
  const ran: string[] = []
  const scheduled = (): string[] => parseHeartbeat(file).map((s) => s.label)
  const host = {
    getGlobalMode: async () => 'single' as const,
    readHeartbeat: async () => file,
    writeHeartbeat: async (raw: string) => {
      file = raw
      writes++
      return { ok: true, jobs: [] }
    },
    listJobs: () =>
      parseHeartbeat(file).map((s) => ({
        id: s.id,
        cron: s.cron,
        label: s.label,
        body: s.body,
        human: '',
        running: false,
        lastRunAt: null,
        lastStatus: null,
        mode: s.mode ?? null,
        thinking: null
      })),
    previewSchedule: (heading: string) => previewSchedule(heading),
    getRunningJobs: () => [],
    runJobNow: (id: string) => {
      ran.push(id)
      return { ok: true, started: true }
    }
  }

  const pluginUrl = new URL(
    '../../../defaults/workspace/brain/cerebellum/automations/plugin/index.mjs',
    import.meta.url
  )
  const plugin = ((await import(pluginUrl.href)) as { default: Plugin }).default
  await plugin.init({ automations: host })
  const call = (tool: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
    plugin.execute(tool, args)

  // ── 1. The list: paused rows in place, other comments opaque ────────────
  {
    const listed = await call('automation_list')
    const out = listed.output ?? ''
    ok('list succeeds', listed.success, listed.error)
    ok('list counts active and paused jobs', out.includes('## Automations (4, 2 paused)'), out)
    ok(
      'jobs are numbered in file order, paused ones in place',
      out.includes('1. **Morning digest** (Daily (08:00))') &&
        out.includes('2. **Hourly (15)** — ⏸ **paused**') &&
        out.includes('3. **Weekly (Monday 09:30)**') &&
        out.includes('4. **Inbox sweep** (Every (2h)) — ⏸ **paused**'),
      out
    )
    ok(
      'the examples block and a non-schedule comment are never listed',
      !out.includes('Daily (07:00)') && !out.includes('just a note'),
      out
    )
  }

  // ── 2. Pausing only wraps ───────────────────────────────────────────────
  const stampsBefore = JSON.stringify(parseHeartbeatBlocks(file))
  {
    const paused = await call('automation_edit', { identifier: '1', enabled: false })
    ok('pause succeeds', paused.success, paused.error)
    ok(
      'a paused job stops being scheduled',
      !scheduled().includes('Daily (08:00)'),
      scheduled().join()
    )
    ok(
      'the pause writes the page’s block form around the job',
      file.includes(
        '<!-- ## Daily (08:00)\n\nname: Morning digest\nicon: 📰\n\nSummarize the overnight news.\n-->'
      ),
      file
    )
    ok(
      'a pause is not an edit — the edit-stamp blocks are unchanged',
      JSON.stringify(parseHeartbeatBlocks(file)) === stampsBefore
    )
    const listed = (await call('automation_list')).output ?? ''
    ok(
      'the paused job keeps its number',
      listed.includes('1. **Morning digest** (Daily (08:00)) — ⏸ **paused**'),
      listed
    )
    const before = writes
    const again = await call('automation_edit', { identifier: '1', enabled: false })
    ok(
      'pausing a paused job is a no-op, not a write',
      again.success && (again.output ?? '').includes('already paused') && writes === before,
      again.output
    )
  }

  // ── 3. Resuming is the exact inverse ────────────────────────────────────
  {
    const resumed = await call('automation_edit', { identifier: 'Daily (08:00)', enabled: true })
    ok('resume succeeds', resumed.success, resumed.error)
    ok('resuming restores the file byte-for-byte', file === FIXTURE, file)
    ok('a resumed job is scheduled again', scheduled().includes('Daily (08:00)'))
  }

  // ── 4. Both paused forms resume ─────────────────────────────────────────
  {
    const single = await call('automation_edit', { identifier: '2', enabled: true })
    ok('a body-less paused job resumes', single.success, single.error)
    ok(
      'the one-liner becomes an active heading',
      file.includes('\n## Hourly (15)\n') && scheduled().includes('Hourly (15)'),
      file
    )
    const block = await call('automation_edit', { identifier: '4', enabled: true })
    ok('a block paused job resumes', block.success, block.error)
    const sweep = parseHeartbeat(file).find((s) => s.label === 'Every (2h)')
    ok(
      'its markers and body survive the resume',
      sweep?.name === 'Inbox sweep' && sweep?.body === 'Check the inbox.',
      JSON.stringify(sweep)
    )
    file = FIXTURE
  }

  // ── 5. A paused job: edit keeps it paused; delete; no run ───────────────
  {
    const edited = await call('automation_edit', {
      identifier: '4',
      instruction: 'Check the inbox and flag anything urgent.'
    })
    ok('editing a paused job succeeds', edited.success, edited.error)
    ok(
      'the edit stays inside the comment — the job is still paused',
      !scheduled().includes('Every (2h)') &&
        file.includes(
          '<!-- ## Every (2h)\n\nname: Inbox sweep\n\nCheck the inbox and flag anything urgent.\n-->'
        ),
      file
    )
    const runPaused = await call('automation_run', { identifier: '4' })
    ok(
      'a paused job cannot be run',
      !runPaused.success && (runPaused.error ?? '').includes('paused') && ran.length === 0,
      runPaused.error
    )
    const deleted = await call('automation_delete', { identifier: '4' })
    ok('deleting a paused job succeeds', deleted.success, deleted.error)
    ok(
      'the paused job is gone and every other comment is intact',
      !file.includes('Every (2h)') &&
        file.includes('<!-- ## Hourly (15) -->') &&
        file.includes('<!-- ## just a note the user left -->') &&
        file.includes(EXAMPLES),
      file
    )
    file = FIXTURE
  }

  // ── 6. A string "false" pauses ──────────────────────────────────────────
  {
    const paused = await call('automation_edit', { identifier: '3', enabled: 'false' })
    ok(
      '"false" as a string pauses the job',
      paused.success && !scheduled().includes('Weekly (Monday 09:30)'),
      paused.error ?? file
    )
    const bogus = await call('automation_edit', { identifier: '3', enabled: 'maybe' })
    ok('a value that is neither is refused', !bogus.success, bogus.output)
    file = FIXTURE
  }

  // ── 7. A stale paused one-time job needs a new time ─────────────────────
  {
    file = FIXTURE.replace(
      '<!-- ## Hourly (15) -->',
      '<!-- ## Once (2020-01-01 09:00)\n\nDo it once.\n-->'
    )
    const snapshot = file
    const before = writes
    const refused = await call('automation_edit', { identifier: '2', enabled: true })
    ok(
      'a past one-time job is not resumed as it is',
      !refused.success &&
        (refused.error ?? '').includes('already passed') &&
        writes === before &&
        file === snapshot,
      refused.error
    )
    const rescheduled = await call('automation_edit', {
      identifier: '2',
      enabled: true,
      schedule: 'In (2h)'
    })
    ok('resuming it with a new schedule works', rescheduled.success, rescheduled.error)
    const once = parseHeartbeat(file).find((s) => s.kind === 'once')
    ok(
      'it is scheduled for the new time with its instruction',
      !!once &&
        typeof once.runAt === 'number' &&
        once.runAt > Date.now() &&
        once.body === 'Do it once.',
      JSON.stringify(once)
    )
  }

  // The examples survive every operation above untouched.
  ok('the examples block is never rewritten', file.includes(EXAMPLES))

  // ── 8. A hand-paused job that lost its `-->` never wakes the examples ───
  {
    // The comment now runs from `<!-- ## Weekly …` to the examples' own `-->`.
    file = FIXTURE.replace('## Weekly (Monday 09:30)', '<!-- ## Weekly (Monday 09:30)')
    const snapshot = file
    const listed = (await call('automation_list')).output ?? ''
    ok(
      'a comment spanning more than one job is not listed as a paused job',
      !listed.includes('Weekly (Monday 09:30)') && !listed.includes('Daily (07:00)'),
      listed
    )
    const resumed = await call('automation_edit', {
      identifier: 'Weekly (Monday 09:30)',
      enabled: true
    })
    ok(
      'it cannot be resumed — so the examples are never switched on',
      !resumed.success && file === snapshot && !scheduled().includes('Daily (07:00)'),
      resumed.output ?? file
    )
    file = FIXTURE
  }

  // ── 9. automation_check knows paused from absent ────────────────────────
  {
    file = FIXTURE.replace('## Daily (08:00)', '<!-- ## Daily (08:00)')
      .replace('Summarize the overnight news.\n', 'Summarize the overnight news.\n-->\n')
      .replace(
        '## Weekly (Monday 09:30)\n\nPlan the week.',
        '<!-- ## Weekly (Monday 09:30)\n\nPlan the week.\n-->'
      )
    ok('the fixture now schedules nothing', scheduled().length === 0, scheduled().join())
    const checked = (await call('automation_check')).output ?? ''
    ok(
      'with every job paused, check says paused — not "none configured"',
      checked.includes('No automations are scheduled — 4 are paused') &&
        !checked.includes('No automations are configured'),
      checked
    )
    file = FIXTURE
  }

  console.log(`${passed} passed, ${failed} failed`)
  fs.rmSync(TEST_HOME, { recursive: true, force: true })
  if (failed > 0) process.exitCode = 1
}

void run()
