/**
 * Write-time escape for automation prompt bodies (escapePromptBody, applied in
 * the Heartbeat page's persistDraft) — the desktop port of the phone's fix.
 *
 * heartbeat.md's block grammar cannot hold three kinds of line in a body: a
 * `## ` line ends the block in every parser, a dashed separator is dropped
 * wholesale, and HTML comment tokens splice into the on/off wrapper — a stray
 * `<!--` swallows every automation below it. So a pasted prompt with its own
 * `## Prompt` sections silently lost everything after the first one, at
 * display AND at run time.
 *
 * Covered here:
 *  - the escape respells exactly the grammar lines, nothing else, idempotent
 *    (expected strings match the phone's tests byte for byte — the two repos'
 *    writers must produce the same safe spelling)
 *  - the escaped body survives the ENGINE's parsers (parseHeartbeat /
 *    parseHeartbeatBlocks) with every section intact and no sibling swallowed
 *  - the raw spelling still parses exactly as it always did (the control that
 *    proves the bug is real and that parsing did not change — only written
 *    bytes)
 *  - the automations plugin's checkInstruction (the third writer, model-facing)
 *    REJECTS the same three token classes instead of escaping — its contract is
 *    reject-with-rephrase — and accepts the editors' escaped spelling, so an
 *    automation_edit round-trip of a user-authored prompt never bounces
 *
 * Redirects the workspace to a temp home BEFORE loading the runtime graph so
 * nothing touches the real ~/.wolffish workspace.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/__tests__/heartbeat-escape.test.ts
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { escapePromptBody } from '../../renderer/src/lib/heartbeat-escape'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-hb-escape-'))
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

function check(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`PASS  ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}\n      ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** The shape that bit for real: a pasted doc with its own `## ` sections. */
const PASTED = [
  '# Automation — Daily Quiz',
  '',
  '**Schedule:** every day at 07:00',
  '',
  '## Prompt',
  '',
  'You are running unattended. Build the quiz and send it.',
  '',
  '---',
  '',
  '## When he replies',
  '',
  'Grade cold. <!-- no praise -->'
].join('\n')

/**
 * A heartbeat.md in the shape the page's persistDraft writes: the job block is
 * `## label`, blank, marker lines, blank, prompt lines — followed by a sibling
 * active job and a switched-off block, the automations a stray comment token
 * would swallow.
 */
function heartbeatFile(promptBody: string): string {
  return [
    '# Heartbeat',
    '',
    '## Daily (07:00)',
    '',
    'icon: 🩺',
    '',
    ...promptBody.split('\n'),
    '',
    '## Hourly (:30)',
    '',
    'icon: 🔔',
    '',
    'Ping the channel.',
    '',
    '<!-- ## Nightly (23:00)',
    '',
    'Old job, switched off.',
    '-->',
    ''
  ].join('\n')
}

async function run(): Promise<void> {
  const { parseHeartbeat, parseHeartbeatBlocks } = await import('@main/runtime/brainstem')

  // ── escapePromptBody: the pure respelling ──────────────────────────────

  check('respells the lines the block grammar would eat, and only those', () => {
    assert.equal(
      escapePromptBody(
        [
          '# Title',
          '## Prompt',
          '##No space is not a heading',
          'Plain line.',
          '---',
          '### Deeper headings are already safe'
        ].join('\n')
      ),
      [
        '# Title',
        ' ## Prompt',
        '##No space is not a heading',
        'Plain line.',
        ' ---',
        '### Deeper headings are already safe'
      ].join('\n')
    )
  })

  check('defuses comment tokens anywhere — the engine strips them position-blind', () => {
    assert.equal(escapePromptBody('keep <!-- this --> visible'), 'keep < !-- this -- > visible')
    assert.equal(escapePromptBody('<!--\nalone\n-->'), '< !--\nalone\n-- >')
  })

  check('is idempotent, so re-saving a parsed body never grows', () => {
    const once = escapePromptBody('## Prompt\n---\n<!-- x -->')
    assert.equal(escapePromptBody(once), once)
  })

  // ── the raw spelling: the bug this guards against, and the parse baseline ──

  check('control: a raw pasted prompt truncates at its own `## ` section', () => {
    const jobs = parseHeartbeat(heartbeatFile(PASTED))
    const daily = jobs.find((j) => j.label === 'Daily (07:00)')
    assert.ok(daily, 'daily job parsed')
    assert.ok(!daily.body.includes('When he replies'), 'everything after `## Prompt` is lost')
    assert.ok(daily.body.includes('**Schedule:**'), 'the part before the first `## ` survives')
  })

  check('control: a stray `<!--` swallows the automations below it', () => {
    const jobs = parseHeartbeat(heartbeatFile('Do the thing.\n<!-- unpaired'))
    // The comment strip runs from the stray opener to the NEXT closer — which
    // is the switched-off block's `-->` — taking the Hourly job with it.
    assert.equal(
      jobs.find((j) => j.label === 'Hourly (:30)'),
      undefined
    )
  })

  // ── the escaped spelling: every section survives every engine parser ───

  check('escaped body round-trips through parseHeartbeat intact', () => {
    const jobs = parseHeartbeat(heartbeatFile(escapePromptBody(PASTED)))
    const daily = jobs.find((j) => j.label === 'Daily (07:00)')
    assert.ok(daily, 'daily job parsed')
    // The run-time body is the escaped prompt byte for byte: markers split
    // off, nothing truncated, nothing dropped, nothing comment-stripped.
    assert.equal(daily.body, escapePromptBody(PASTED))
    assert.ok(daily.body.includes('## When he replies'))
    assert.ok(daily.body.includes('Grade cold.'))
  })

  check('escaped body swallows no sibling automation', () => {
    const jobs = parseHeartbeat(heartbeatFile(escapePromptBody(PASTED)))
    const hourly = jobs.find((j) => j.label === 'Hourly (:30)')
    assert.equal(hourly?.body, 'Ping the channel.')
  })

  check('escaped body survives the block scan (edit stamps, disabled jobs)', () => {
    const blocks = parseHeartbeatBlocks(heartbeatFile(escapePromptBody(PASTED)))
    assert.deepEqual(
      blocks.map((b) => b.label),
      ['Daily (07:00)', 'Hourly (:30)', 'Nightly (23:00)']
    )
    const daily = blocks.find((b) => b.label === 'Daily (07:00)')
    assert.ok(daily!.block.includes('## When he replies'), 'sections survive the scan')
    assert.ok(daily!.block.includes(' ---'), 'the escaped separator is content, not dropped')
  })

  // ── the plugin's guard: the model-facing writer rejects, not escapes ───

  // Lifted from the shipping .mjs byte-for-byte (the plugin exports its tool
  // surface, not its internals) so this pins the real guard.
  const pluginSrc = fs.readFileSync(
    new URL(
      '../../defaults/workspace/brain/cerebellum/automations/plugin/index.mjs',
      import.meta.url
    ),
    'utf8'
  )
  const fnStart = pluginSrc.indexOf('function checkInstruction')
  const fnEnd = pluginSrc.indexOf('\n}', fnStart)
  assert.ok(fnStart >= 0 && fnEnd > fnStart, 'checkInstruction found in plugin source')
  const { checkInstruction } = (await import(
    `data:text/javascript,${encodeURIComponent(`export ${pluginSrc.slice(fnStart, fnEnd + 2)}`)}`
  )) as { checkInstruction: (instruction: string) => string | null }

  check('the plugin rejects all three token classes the editors escape', () => {
    assert.ok(checkInstruction('## Prompt\nbody'), 'heading rejected')
    assert.ok(checkInstruction('part one\n---\npart two'), 'dashed separator rejected')
    assert.ok(checkInstruction('keep <!-- this --> hidden'), 'comment token rejected')
  })

  check('the plugin does not over-reject: dashes that are content stay legal', () => {
    assert.equal(checkInstruction('Compute a -- b, then a --- b.\n--- draft note follows'), null)
  })

  check('the plugin accepts the escaped spelling, so an edit round-trip never bounces', () => {
    assert.equal(checkInstruction(escapePromptBody(PASTED)), null)
  })

  fs.rmSync(TEST_HOME, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

void run()
