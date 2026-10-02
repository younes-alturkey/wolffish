/**
 * The computer-use screen indicator contract, both ends of it.
 *
 * The indicator ("Wolffish is capturing your screen") is the one piece of
 * agent state that lives on the USER's display, so its two failure modes are
 * both trust failures rather than bugs: captured without the signal up, or
 * left up after the agent stopped. The model owns both tool calls; these are
 * the layers that make forgetting either one impossible.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/screen-indicator.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  indicatorNudge,
  indicatorNoticeText,
  lastIndicatorActionFrom,
  MAX_SCREEN_INDICATOR_NUDGES,
  SCREEN_INDICATOR_NOTICE,
  SCREEN_INDICATOR_OFF_TOOL,
  SCREEN_INDICATOR_ON_TOOL,
  trackIndicators
} from '../agent/screen-indicator-guard'
import { formatRuntimeStatus } from '../outbound'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// src/main/runtime/__tests__ -> repo root
const REPO = path.resolve(HERE, '..', '..', '..', '..')
const read = (rel: string): string => readFileSync(path.join(REPO, rel), 'utf8')

const CAP = 'src/defaults/workspace/brain/cerebellum/computer-use'
const PLUGIN_REL = `${CAP}/plugin/index.mjs`
const skill = read(`${CAP}/SKILL.md`)
const agentSrc = read('src/main/runtime/agent/Agent.ts')

type GateState = { indicatorOn: boolean; unavailable: boolean }
type GateReason = (tool: string, state: GateState) => string | null

let n = 0
const check = (name: string, fn: () => void | Promise<void>): Promise<void> =>
  Promise.resolve()
    .then(fn)
    .then(() => {
      n++
      console.log(`✅ ${name}`)
    })
    .catch((err: unknown) => {
      n++
      console.log(`❌ ${name}: ${(err as Error).message}`)
      process.exitCode = 1
    })

type Ended = {
  stopReason: 'end_turn'
  text: string
  toolCalls: never[]
  thinking: string | undefined
}
const endTurn = (text: string, thinking?: string): Ended => ({
  stopReason: 'end_turn',
  text,
  toolCalls: [],
  thinking
})

async function run(): Promise<void> {
  // The plugin's top level imports nothing but node:fs/promises and
  // node:path — electron, nut-js and sharp all load inside init() — so the
  // real module imports here and the real gate rule runs, not a copy of it.
  const mod = (await import(pathToFileURL(path.join(REPO, PLUGIN_REL)).href)) as {
    indicatorGateReason: GateReason
    INDICATOR_REQUIRED: Set<string>
  }
  const gate = mod.indicatorGateReason
  const required = mod.INDICATOR_REQUIRED

  // ── 1. the "on" end: nothing sees or touches the screen unannounced ─────

  await check('every capture and input tool is refused while the indicator is off', () => {
    const state = { indicatorOn: false, unavailable: false }
    for (const tool of required) {
      const reason = gate(tool, state)
      assert.ok(reason, `${tool} must be gated`)
      assert.ok(
        reason.includes('computer_glow_on'),
        `${tool}'s refusal must name the tool that fixes it`
      )
      assert.ok(reason.includes(tool), `${tool}'s refusal must say which call did not run`)
    }
  })

  await check('the gated set is exactly the tools that see or control the screen', () => {
    assert.deepEqual(
      [...required].sort(),
      [
        'computer_click_element',
        'computer_find',
        'computer_focus_window',
        'computer_hover',
        'computer_key_down',
        'computer_key_up',
        'computer_keyboard_press',
        'computer_keyboard_type',
        'computer_list_windows',
        'computer_menu',
        'computer_mouse_click',
        'computer_mouse_down',
        'computer_mouse_drag',
        'computer_mouse_move',
        'computer_mouse_scroll',
        'computer_mouse_up',
        'computer_read_element',
        'computer_screenshot',
        'computer_set_value',
        'computer_wait_for',
        'computer_window_screenshot',
        'computer_window_state',
        'computer_zoom'
      ],
      'gating more would break the escape hatch; gating less would leak a capture'
    )
  })

  await check('listing displays, waiting and the glow tools themselves stay open', () => {
    const state = { indicatorOn: false, unavailable: false }
    for (const tool of [
      'computer_list_displays',
      'computer_wait',
      'computer_check_access',
      'computer_clipboard_read',
      'computer_clipboard_write',
      SCREEN_INDICATOR_ON_TOOL,
      SCREEN_INDICATOR_OFF_TOOL
    ]) {
      assert.equal(gate(tool, state), null, `${tool} must never be gated`)
    }
  })

  await check('with the indicator up, every tool runs', () => {
    const state = { indicatorOn: true, unavailable: false }
    for (const tool of required) assert.equal(gate(tool, state), null, tool)
  })

  await check('a machine that cannot draw the indicator is not locked out of computer use', () => {
    // overlay.unavailable is set by the model's OWN failed computer_glow_on,
    // which tells it to say so — the gate must not turn that into a dead end.
    const state = { indicatorOn: false, unavailable: true }
    for (const tool of required) assert.equal(gate(tool, state), null, tool)
  })

  // ── 1b. the same rule through the REAL plugin.execute chokepoint ────────
  //
  // The pure rule above is the contract; this is the wiring. No Electron is
  // needed: the gate runs before any handler, and computer_glow_on's own
  // no-Electron failure is exactly what opens the escape hatch — so the whole
  // session shape (refused → glow_on fails → allowed through → glow_off →
  // refused again) is observable here.

  const plugin = (
    mod as unknown as {
      default: { execute: (t: string, a?: Record<string, unknown>) => Promise<{ error?: string }> }
    }
  ).default

  await check('execute() refuses a capture before the indicator is up', async () => {
    const r = await plugin.execute('computer_screenshot', {})
    assert.ok(r.error?.includes('Screen indicator is OFF'), r.error)
  })

  await check('a failed computer_glow_on opens the gate for that session only', async () => {
    const on = await plugin.execute(SCREEN_INDICATOR_ON_TOOL, {})
    assert.ok(on.error, 'no Electron here, so the glow genuinely cannot be shown')
    const after = await plugin.execute('computer_screenshot', {})
    assert.ok(
      !after.error?.includes('Screen indicator is OFF'),
      'the model was told to carry on without the indicator — the gate must let it'
    )
    await plugin.execute(SCREEN_INDICATOR_OFF_TOOL, {})
    const next = await plugin.execute('computer_screenshot', {})
    assert.ok(
      next.error?.includes('Screen indicator is OFF'),
      'the next session must prove availability for itself, not inherit an open gate'
    )
  })

  // ── 2. the "off" end: tracking what THIS run raised ─────────────────────

  await check('a successful glow_on raises the flag and glow_off lowers it', () => {
    let on = new Set<string>()
    on = trackIndicators(on, SCREEN_INDICATOR_ON_TOOL, true)
    assert.ok(on.has('screen'))
    on = trackIndicators(on, 'computer_screenshot', true)
    assert.ok(on.has('screen'), 'unrelated tools must not move the flag')
    on = trackIndicators(on, SCREEN_INDICATOR_OFF_TOOL, true)
    assert.ok(!on.has('screen'))
  })

  await check('failed calls move nothing — a glow that never appeared is not up', () => {
    assert.equal(trackIndicators(new Set(), SCREEN_INDICATOR_ON_TOOL, false).size, 0)
    assert.ok(trackIndicators(new Set(['screen']), SCREEN_INDICATOR_OFF_TOOL, false).has('screen'))
  })

  // ── 3. the turn-end nudge ───────────────────────────────────────────────

  await check('a turn ending with the indicator up is sent back to close it', () => {
    const nudge = indicatorNudge(new Set(['screen']), endTurn('Done — I filed the expense.'), 0)
    assert.ok(nudge, 'must nudge')
    assert.equal(nudge.messages.length, 2)
    assert.equal(nudge.messages[0].role, 'assistant')
    assert.equal(
      nudge.messages[0].content,
      'Done — I filed the expense.',
      'the real reply is echoed back: it already streamed to the user'
    )
    assert.equal(nudge.messages[1].role, 'user')
    assert.ok(String(nudge.messages[1].content).includes(SCREEN_INDICATOR_OFF_TOOL))
    assert.equal(nudge.offTool, SCREEN_INDICATOR_OFF_TOOL)
    assert.equal(
      nudge.messages[0].role === 'assistant' ? nudge.messages[0].toolUses : null,
      undefined,
      'an unmatched tool call would break every adapter'
    )
  })

  await check('an empty reply gets the aside alone — no invented placeholder', () => {
    // The `(continuing)` filler that used to stand in here was a parenthesized
    // stand-in for an empty turn in the model's own voice, and it leaked back
    // out to users as `(no output)` / `(no content)`. Anthropic no longer needs
    // it: toAnthropicMessages merges a user message into the preceding turn.
    const nudge = indicatorNudge(new Set(['screen']), endTurn('   '), 0)
    assert.ok(nudge)
    assert.equal(nudge.messages.length, 1)
    assert.equal(nudge.messages[0].role, 'user')
  })

  await check('reasoning content is carried through, as the max_tokens continuation does', () => {
    const nudge = indicatorNudge(new Set(['screen']), endTurn('ok', 'thought'), 0)
    assert.ok(nudge)
    const assistant = nudge.messages[0]
    assert.equal(assistant.role, 'assistant')
    assert.equal(assistant.role === 'assistant' ? assistant.reasoningContent : null, 'thought')
  })

  await check('no indicator, no nudge — the ordinary turn is untouched', () => {
    assert.equal(indicatorNudge(new Set(), endTurn('Here you go.'), 0), null)
  })

  await check('a model still calling tools is not interrupted', () => {
    const parsed = {
      stopReason: 'end_turn' as const,
      text: '',
      toolCalls: [{ id: '1', name: 'computer_mouse_click', args: {} }],
      thinking: undefined
    }
    assert.equal(indicatorNudge(new Set(['screen']), parsed, 0), null)
  })

  await check('a non-end_turn stop is not a finished turn', () => {
    const parsed = { stopReason: 'max_tokens' as const, text: 'cut off', toolCalls: [] as never[] }
    assert.equal(indicatorNudge(new Set(['screen']), parsed, 0), null)
  })

  await check('the nudge is bounded — it can never spin', () => {
    assert.ok(indicatorNudge(new Set(['screen']), endTurn('x'), MAX_SCREEN_INDICATOR_NUDGES - 1))
    assert.equal(
      indicatorNudge(new Set(['screen']), endTurn('x'), MAX_SCREEN_INDICATOR_NUDGES),
      null
    )
  })

  // ── 4. the every-iteration notice ───────────────────────────────────────

  await check('the notice rides the volatile tail while the indicator is up', () => {
    const tail = formatRuntimeStatus(
      { iteration: 4, toolsCalled: 9, screenIndicator: SCREEN_INDICATOR_NOTICE },
      new Date('2026-09-13T10:00:00Z')
    )
    assert.ok(tail.includes(SCREEN_INDICATOR_OFF_TOOL), 'the tail must name the one exit')
  })

  await check('the last screen action rides the notice so the next step verifies it', () => {
    const la = lastIndicatorActionFrom({
      computerUse: {
        lastAction: {
          tool: 'click',
          target: 'Save',
          expect: 'the dialog closes',
          summary: 'click "Save": background, unverifiable, no visible change'
        }
      }
    })
    assert.ok(la, 'meta shape must parse')
    assert.equal(la.indicator, 'screen', 'the action maps to its indicator')
    const text = indicatorNoticeText(new Set(['screen']), la) ?? ''
    assert.ok(text.startsWith(SCREEN_INDICATOR_NOTICE), 'the standing notice comes first')
    assert.ok(
      text.includes('no visible change') && text.includes('the dialog closes'),
      'evidence and expectation both ride'
    )
    assert.equal(
      indicatorNoticeText(new Set(['screen']), null),
      SCREEN_INDICATOR_NOTICE,
      'no action, no extra line'
    )
    assert.equal(lastIndicatorActionFrom({ diff: 'x' }), null, 'unrelated meta is ignored')
    assert.equal(lastIndicatorActionFrom(undefined), null)
  })

  await check('a turn that never touched the screen pays nothing', () => {
    const tail = formatRuntimeStatus({ iteration: 4, toolsCalled: 9 }, new Date())
    assert.ok(!tail.includes('SCREEN INDICATOR'))
  })

  // ── 5. the surfaces that must agree ─────────────────────────────────────

  await check('the model is TOLD both halves are enforced, in the frontmatter', () => {
    // The SKILL.md body never reaches the model — only the frontmatter tool
    // descriptions do — so the contract has to be stated there or not at all.
    const frontmatter = skill.slice(0, skill.indexOf('\n---', 4))
    const glowOn = frontmatter.slice(frontmatter.indexOf(`name: ${SCREEN_INDICATOR_ON_TOOL}`))
    assert.ok(
      /REFUSES|refuses/.test(glowOn.slice(0, 2000)),
      'computer_glow_on must say the capture tools refuse without it'
    )
    const glowOff = frontmatter.slice(frontmatter.indexOf(`name: ${SCREEN_INDICATOR_OFF_TOOL}`))
    assert.ok(
      /handed straight back/.test(glowOff.slice(0, 2000)),
      'computer_glow_off must say a turn ending with it up comes back'
    )
    assert.ok(
      skill.includes('refuses to run until it does'),
      'computer_screenshot must say it is gated'
    )
  })

  await check('the Agent clears an indicator its own turn left up, on every exit path', () => {
    const finallyBlock = agentSrc.slice(agentSrc.indexOf('    } finally {'))
    assert.ok(
      finallyBlock.includes('if (indicatorsOn.size > 0)') &&
        finallyBlock.includes('indicatorOffTools(indicatorsOn)') &&
        finallyBlock.includes('executeTool(offTool'),
      'the failsafe must live in finally — cancel and error reach no other exit'
    )
    // The failsafe iterates the registry, so the mobile driving indicator is
    // cleared by the same clause without being named in Agent.ts.
    assert.ok(
      !finallyBlock.includes('SCREEN_INDICATOR_OFF_TOOL') &&
        !finallyBlock.includes('mobile_indicator_off'),
      'the failsafe must not name one indicator — every registered one is cleared'
    )
  })

  console.log(`\n${n} checks run`)
}

void run()
