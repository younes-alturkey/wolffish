/**
 * Tests for the heartbeat per-job "Edited …" stamps (brainstem.ts):
 * parseHeartbeatBlocks (the section scan mirroring the Automations page's
 * parseSidebarJobs) and the reload-diff meta store behind
 * getHeartbeatEditStamps / adoptHeartbeatEditStamps.
 *
 * Contract under test:
 *  - the commented-out examples block never parses as jobs
 *  - active + disabled (single-line and block) forms all parse; invalid
 *    schedule headings don't
 *  - an enable/disable toggle does NOT change a job's hashed block (no
 *    restamp), while body and marker (mode:) edits DO
 *  - first sight of a job seeds its stamp from the file's mtime; unchanged
 *    jobs keep their stamp across reloads AND across a process restart;
 *    changed jobs restamp; deleted jobs drop out
 *  - adoptHeartbeatEditStamps overrides stamps for existing labels only
 *
 * Redirects the workspace to a temp home BEFORE loading the runtime graph so
 * nothing touches the real ~/.wolffish workspace.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/heartbeat-edit-stamps.test.ts
 */

import fs from 'node:fs'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-heartbeat-meta-'))
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function run(): Promise<void> {
  const { parseHeartbeatBlocks, Brainstem } = await import('@main/runtime/brainstem')

  // ── parseHeartbeatBlocks: section grammar ──────────────────────────────
  {
    const defaults = fs.readFileSync(
      path.join(process.cwd(), 'src/defaults/workspace/brain/brainstem/heartbeat.md'),
      'utf8'
    )
    ok('default file: examples block yields no jobs', parseHeartbeatBlocks(defaults).length === 0)
  }

  const active = [
    '# Heartbeat',
    '',
    '## Daily (08:00)',
    '',
    'mode: workflow',
    'icon: X',
    '',
    'Morning routine.',
    'Do the thing.',
    '',
    '## Every (30m)',
    '',
    'Poll the queue.',
    '',
    '<!--',
    'EXAMPLES',
    '## Weekly (Monday 09:00)',
    'never parsed',
    '-->',
    ''
  ].join('\n')
  const a = parseHeartbeatBlocks(active)
  ok(
    'active labels parsed (raw comment skipped)',
    a.map((b) => b.label).join('|') === 'Daily (08:00)|Every (30m)',
    a.map((b) => b.label).join('|')
  )

  // Toggle-off in the exact block-comment form the page's handleToggle writes.
  const toggled = active
    .replace('## Daily (08:00)', '<!-- ## Daily (08:00)')
    .replace('Do the thing.\n', 'Do the thing.\n-->\n')
  const tB = parseHeartbeatBlocks(toggled)
  ok('disabled job still parsed', tB.map((b) => b.label).join('|') === 'Daily (08:00)|Every (30m)')
  ok('toggle keeps the hashed block byte-identical', tB[0].block === a[0].block)
  ok('toggle leaves the neighbor block alone', tB[1].block === a[1].block)

  const single = parseHeartbeatBlocks('<!-- ## Hourly (15) -->\n')
  ok(
    'single-line disabled form parses with empty block',
    single.length === 1 && single[0].label === 'Hourly (15)' && single[0].block === ''
  )

  ok(
    'body edit changes the block',
    parseHeartbeatBlocks(active.replace('Do the thing.', 'Do the OTHER thing.'))[0].block !==
      a[0].block
  )
  ok(
    'marker edit changes the block',
    parseHeartbeatBlocks(active.replace('mode: workflow', 'mode: single'))[0].block !== a[0].block
  )
  ok(
    'dashed separator is not content',
    parseHeartbeatBlocks(active.replace('Morning routine.', 'Morning routine.\n---'))[0].block ===
      a[0].block
  )
  ok(
    'invalid schedule heading is not a job',
    parseHeartbeatBlocks('## Daily (99:99)\n\nx\n').length === 0
  )

  // ── reload-diff meta store ─────────────────────────────────────────────
  const root = path.join(TEST_HOME, 'workspace')
  const beatDir = path.join(root, 'brain', 'brainstem')
  fs.mkdirSync(beatDir, { recursive: true })
  const beatPath = path.join(beatDir, 'heartbeat.md')

  const v1 = [
    '## Daily (08:00)',
    '',
    'Morning routine.',
    '',
    '## Weekly (Monday 09:00)',
    '',
    'Weekly plan.',
    ''
  ].join('\n')
  fs.writeFileSync(beatPath, v1)
  const mtime1 = Math.round(fs.statSync(beatPath).mtimeMs)

  const b = new Brainstem({ workspaceRoot: root })
  await b.startScheduler(false)
  const seed = await b.getHeartbeatEditStamps()
  ok(
    'first sight seeds every job from file mtime',
    seed['Daily (08:00)'] === mtime1 && seed['Weekly (Monday 09:00)'] === mtime1,
    JSON.stringify({ seed, mtime1 })
  )
  ok(
    'meta store persisted beside the heartbeat file',
    fs.existsSync(path.join(beatDir, 'heartbeat-meta.json'))
  )

  // Toggle Daily off — file mtime moves, stamps must NOT.
  await sleep(15)
  fs.writeFileSync(
    beatPath,
    v1
      .replace('## Daily (08:00)', '<!-- ## Daily (08:00)')
      .replace('Morning routine.\n', 'Morning routine.\n-->\n')
  )
  await b.reloadScheduler()
  const afterToggle = await b.getHeartbeatEditStamps()
  ok(
    'toggle does not restamp',
    afterToggle['Daily (08:00)'] === mtime1 && afterToggle['Weekly (Monday 09:00)'] === mtime1,
    JSON.stringify({ afterToggle, mtime1 })
  )

  // Edit Weekly's body — only Weekly restamps (to the new mtime).
  await sleep(15)
  fs.writeFileSync(beatPath, v1.replace('Weekly plan.', 'Weekly plan, revised.'))
  await b.reloadScheduler()
  const mtime2 = Math.round(fs.statSync(beatPath).mtimeMs)
  const afterEdit = await b.getHeartbeatEditStamps()
  ok(
    'body edit restamps only the edited job',
    afterEdit['Daily (08:00)'] === mtime1 &&
      afterEdit['Weekly (Monday 09:00)'] === mtime2 &&
      mtime2 > mtime1,
    JSON.stringify({ afterEdit, mtime1, mtime2 })
  )

  // Delete Daily — its stamp drops out.
  await sleep(15)
  fs.writeFileSync(
    beatPath,
    ['## Weekly (Monday 09:00)', '', 'Weekly plan, revised.', ''].join('\n')
  )
  await b.reloadScheduler()
  const afterDelete = await b.getHeartbeatEditStamps()
  ok(
    'deleted job drops its stamp',
    !('Daily (08:00)' in afterDelete) && afterDelete['Weekly (Monday 09:00)'] === mtime2,
    JSON.stringify(afterDelete)
  )

  // Adoption: existing label overridden, unknown label ignored.
  const adopted = await b.adoptHeartbeatEditStamps({
    'Weekly (Monday 09:00)': 12345,
    'Ghost (job)': 1
  })
  ok(
    'adoption overrides existing labels only',
    adopted['Weekly (Monday 09:00)'] === 12345 && !('Ghost (job)' in adopted),
    JSON.stringify(adopted)
  )

  await b.stopScheduler()

  // Restart: a fresh instance re-reads the persisted store — unchanged jobs
  // keep their (adopted) stamps instead of reseeding from mtime.
  const b2 = new Brainstem({ workspaceRoot: root })
  await b2.startScheduler(false)
  const afterRestart = await b2.getHeartbeatEditStamps()
  ok(
    'stamps survive a restart for unchanged jobs',
    afterRestart['Weekly (Monday 09:00)'] === 12345,
    JSON.stringify(afterRestart)
  )
  await b2.stopScheduler()

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void run().then(
  () => undefined,
  (err) => {
    console.error(err)
    process.exitCode = 1
  }
)
