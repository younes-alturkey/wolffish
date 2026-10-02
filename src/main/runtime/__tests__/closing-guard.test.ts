/**
 * The closing-message contract: a turn that already wrote its wrap-up and closed
 * it with a turn-closing tool must not tell the user the same news twice.
 *
 * Observed live — conversation `2026-09-19_23-33-18_452-d73f7b`, turn 3: the
 * model wrote a full closing answer, called `notify_phone`, then wrote the same
 * answer again, reworded, in the iteration that tool call opened. Two closing
 * paragraphs, one screen.
 *
 * The fix is copy-led (the prompt and the tool description, which is the binding
 * site), with this guard as the residual: one advisory line on the runtime tail,
 * into a model call that was already happening. No suppression, no extra request.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/closing-guard.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  closingNotice,
  createClosingGuardState,
  recordClosingTool,
  TURN_CLOSING_TOOLS
} from '../agent/closing-guard'
import { formatRuntimeStatus } from '../outbound'

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
    console.error(`❌ ${name}`)
    throw err
  }
}

check('the closing tools are the three that end a turn', () => {
  // send_file is on the list for the same reason as the other two: agents.core.md
  // tells the model its wrap-up comes AFTER send_file, so the identical
  // double-close has been latent on every document-producing turn.
  assert.ok(TURN_CLOSING_TOOLS.has('notify_phone'))
  assert.ok(TURN_CLOSING_TOOLS.has('voice_respond'))
  assert.ok(TURN_CLOSING_TOOLS.has('send_file'))
  assert.equal(TURN_CLOSING_TOOLS.has('file_read'), false)
  assert.equal(TURN_CLOSING_TOOLS.has('todo_write'), false)
})

check('no notice before a closing tool lands', () => {
  const state = createClosingGuardState()
  assert.equal(closingNotice(state), undefined)
})

check('a landed closing tool arms the notice exactly once', () => {
  const state = createClosingGuardState()
  recordClosingTool(state, 'notify_phone')
  const first = closingNotice(state)
  assert.ok(first, 'the notice must fire after a close')
  assert.ok(first.includes('notify_phone'), 'the notice must name the tool that landed')
  assert.ok(first.includes('CLOSING MESSAGE ALREADY DELIVERED'))
  // Spent: one sentence of backup, not a running argument.
  assert.equal(closingNotice(state), undefined, 'the notice must not repeat within a turn')
})

check('a non-closing tool never arms the notice', () => {
  const state = createClosingGuardState()
  recordClosingTool(state, 'file_read')
  recordClosingTool(state, 'shell_exec')
  assert.equal(closingNotice(state), undefined)
})

check('a send_file then notify_phone sequence still arms (the correct closing order)', () => {
  // write-up → file → push is ONE close, not two. The guard only needs to know
  // the wrap-up is spoken for, so the later tool simply replaces the earlier.
  const state = createClosingGuardState()
  recordClosingTool(state, 'send_file')
  recordClosingTool(state, 'notify_phone')
  const notice = closingNotice(state)
  assert.ok(notice)
  assert.ok(notice.includes('notify_phone'))
})

check('the notice reports and never orders — it offers both honest exits', () => {
  const state = createClosingGuardState()
  recordClosingTool(state, 'notify_phone')
  const text = closingNotice(state) ?? ''
  // Names the new-information exit FIRST, so silence is a choice, not an order.
  // todo-guard's header records the cost of a bare order to stay silent: a model
  // that cannot emit a zero-token channel types a placeholder instead, and the
  // user gets it verbatim in whatever language the model thinks in.
  assert.ok(text.includes('genuinely NEW'), 'the "say what is new" exit must be named first')
  assert.ok(text.includes('close_turn'), 'the producible exit must be named as the close')
})

check('the notice never prints a stand-in for silence', () => {
  const state = createClosingGuardState()
  recordClosingTool(state, 'notify_phone')
  const text = closingNotice(state) ?? ''
  // control-token-guard and empty-turn-guard both record that PRINTING a
  // stand-in is how the model learns it. The text describes the class only.
  for (const literal of [
    '(no output)',
    '(no content)',
    '[Empty response]',
    '空空如也',
    '`."`',
    '`…`'
  ]) {
    assert.equal(text.includes(literal), false, `must not print the stand-in ${literal}`)
  }
  assert.ok(text.includes('bracketed status note'), 'the class must still be described')
})

check('the runtime tail carries the closing notice', () => {
  const rendered = formatRuntimeStatus({
    iteration: 4,
    toolsCalled: 6,
    renderCounters: true,
    deliveredFiles: [],
    online: true,
    closing: closingNotice(armed())
  })
  assert.ok(rendered.includes('CLOSING MESSAGE ALREADY DELIVERED'), rendered)
})

function armed(): ReturnType<typeof createClosingGuardState> {
  const state = createClosingGuardState()
  recordClosingTool(state, 'notify_phone')
  return state
}

check('the agent loop wires the guard (record on success, notice on the tail)', () => {
  const src = read('src/main/runtime/agent/Agent.ts')
  assert.ok(
    src.includes('if (result.ok) recordClosingTool(closingGuard, call.name)'),
    'the tool-result path must record a landed close'
  )
  assert.ok(
    src.includes(
      "const closingNoticeText = turn.role === 'agent' ? undefined : closingNotice(closingGuard)"
    ),
    'the tail must be fed exactly once per iteration'
  )
  // closingNotice() SPENDS the notice, so it may be CALLED exactly once per
  // iteration — a second live call site would drain it into a discarded value and
  // the tail would carry an empty string, silently. The variable it produces is
  // what both tail objects read, so count the calls, not the references.
  const drains = src.split(': closingNotice(closingGuard)').length - 1
  assert.equal(drains, 1, 'closingNotice must be called exactly once (its result is reused)')
  const refs = src.split('closingNoticeText').length - 1
  assert.ok(refs >= 3, 'the notice must reach the runtime tail (declaration + both tail objects)')
})

check('the copy carries the rule in the prompt and in the binding tool description', () => {
  const core = read('src/defaults/workspace/brain/prefrontal/agents.core.md')
  assert.ok(
    core.includes('never earns a second reply'),
    'agents.core.md must say notify_phone never earns a second reply'
  )
  assert.ok(
    core.includes('One wrap-up per turn'),
    'agents.core.md must state the one-wrap-up rule that reconciles the four end-of-turn lines'
  )
  // The binding site: the tool schema is injected on every call, adjacent to the
  // loop it must break out of. A copy fix that edits only agents.core.md does
  // not work — this assertion is what stops a future edit from dropping it.
  const tools = read('src/main/channels/mobile/tools.ts')
  assert.ok(
    tools.includes('THIS TOOL NEVER EARNS A SECOND REPLY'),
    'the notify_phone tool description must carry the prohibition'
  )
  const tts = read('src/defaults/workspace/brain/cerebellum/text-to-speech/SKILL.md')
  assert.ok(
    tts.includes("TURN'S CLOSE"),
    'the voice_respond description must say the memo is the close'
  )
})

console.log(`\n${n} checks`)
