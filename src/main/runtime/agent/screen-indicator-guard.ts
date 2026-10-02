import type { ChatMessage } from '@main/runtime/thalamus'
import type { ParsedResponse } from '@main/runtime/wernicke'

/**
 * The computer-use screen indicator — the blue edge glow plus the centered
 * "Wolffish is capturing your screen" pill — is raised and lowered by the
 * model alone: `computer_glow_on` before the first capture,
 * `computer_glow_off` as the last action of the session. Nothing shows it
 * for the model and nothing hides it while a session is alive.
 *
 * That lifecycle is deliberate, but one half of it is a claim made on the
 * user's own screen rather than a piece of agent state: while the indicator
 * is up, the user is being told they are being watched. The moment the turn
 * ends, that claim is simply false — and it stays on screen forever, because
 * there is no idle timer. Observed live: a computer-use task finished
 * cleanly, the model wrote its summary, and the pill stayed up.
 *
 * So the indicator gets three layers, weakest first, each one only firing
 * where the previous could not:
 *
 *   1. NOTICE   While the indicator is up, SCREEN_INDICATOR_NOTICE rides the
 *               runtime tail on every iteration — the same observe-and-notify
 *               vehicle as the phone/voice reminders, after every cache
 *               breakpoint. Prevention: the rule is restated at the request's
 *               most salient position, where a turn that went well cannot
 *               lose it to a 25k-token prompt.
 *   2. NUDGE    A turn may not END with an indicator it raised. When the
 *               model stops calling tools while the glow is up,
 *               indicatorNudge injects a system aside and the loop runs
 *               again, so the model closes it itself — model-led, just later
 *               than it should have been. Bounded by
 *               MAX_SCREEN_INDICATOR_NUDGES so it can never spin.
 *   3. FAILSAFE The Agent's finally clears it when the turn is over for real
 *               and no model step can happen any more (cancel, error, or a
 *               spent nudge budget). Not an idle timer and never mid-session:
 *               it is the harness refusing to leave a false statement on a
 *               user's screen after the agent that made it has stopped
 *               running.
 *
 * The counterpart on the other end lives in the plugin: the capture and input
 * tools refuse to run until the indicator is up (or has proved unavailable),
 * so "watched without the signal" is impossible rather than merely forbidden.
 */

/** Raises the indicator. Model-called; also the plugin's gate opener. */
export const SCREEN_INDICATOR_ON_TOOL = 'computer_glow_on'

/** Lowers it. Model-called, and the Agent's terminal failsafe. */
export const SCREEN_INDICATOR_OFF_TOOL = 'computer_glow_off'

/**
 * How many times the loop will send the turn back for a forgotten
 * `computer_glow_off` before letting it end and clearing the indicator
 * itself. Two, for the same reason as MAX_EMPTY_TURN_NUDGES: enough to
 * recover a model that simply forgot, not enough to argue with one that
 * won't — and the failsafe makes the user-visible outcome identical either
 * way, so spending more calls here buys nothing.
 */
export const MAX_SCREEN_INDICATOR_NUDGES = 2

/**
 * Runtime-tail line, present on every iteration while the indicator is up.
 * Names what the user is actually seeing (not "the glow", which means
 * nothing to a model reading its own telemetry) and states the one exit,
 * including the two cases the model is most likely to treat as exceptions:
 * giving up, and handing back mid-task.
 */
export const SCREEN_INDICATOR_NOTICE =
  'SCREEN INDICATOR: ON — the user currently sees a blue glow around their display and a notice reading "Wolffish is capturing your screen". ' +
  'Only computer_glow_off takes it down; nothing clears it for you, and there is no timer. ' +
  'Call it the moment you stop looking at or touching their screen — as the LAST action of this turn, whether you finished the task, gave up on it, or are handing back so the user can do something. ' +
  'A turn that ends with it still up tells them they are being watched when they are not.'

/**
 * What the model's last screen action was and what it said should happen —
 * the plugin reports it on every input tool's result (`meta.computerUse.lastAction`).
 * Carried in the runtime tail so the model's next step VERIFIES before it
 * plans: the verify step and the plan step are one forward pass, and the
 * intent they check against is right here instead of a dozen messages up.
 */
export type LastComputerAction = {
  tool: string
  target: string | null
  expect: string | null
  summary: string
}

/**
 * The nudge, injected when the model ends its turn with an indicator up.
 *
 * Written for a model that believes it is already done: the reply is gone,
 * so the only thing left is the tool call, and the fastest honest way out is
 * to make it. It offers the genuine alternative too (keep working) so the
 * nudge can never talk a model out of an unfinished task, and it names the
 * producible exit (`close_turn`) for the case where there is genuinely
 * nothing left to say — without one, a model that cannot emit a zero-token
 * content channel manufactures a second closing message or a stand-in for
 * silence. The stand-in warning is the same lesson empty-turn-guard paid for
 * twice: describe the class, never print a member of it, or the model learns
 * the literal and types it.
 */
const SCREEN_INDICATOR_NUDGE_TEXT =
  '[System: You are ending your turn, but the screen indicator is still ON — the user is still being shown ' +
  '"Wolffish is capturing your screen" even though you have stopped. Only computer_glow_off clears it; nothing ' +
  'else will, ever. Call computer_glow_off now. (If you are in fact not finished with their screen, carry on with ' +
  'the task instead — but no turn may end with the indicator up.) Your reply has already been delivered to the ' +
  'user and cannot be unsent, so if there is something they still need to hear, say it — and if they genuinely ' +
  'need nothing further, call `close_turn` to end the turn cleanly. That is offered, not ordered: how the turn ' +
  'ends is yours to decide. What is never an ending is a typed stand-in for the silence — a bracketed note, a ' +
  'lone punctuation mark, a word or set phrase meaning "empty" or "nothing further" in ANY language — since ' +
  'anything you write is delivered to them verbatim, in whatever script you wrote it.]'

// ─── Every indicator, one registry ─────────────────────────────────────────
//
// The mobile driving indicator ("Wolffish is driving iPhone 16 Pro", a frame
// around the simulator or emulator window) makes the same claim on the
// user's screen with the same lifecycle, so it rides the same three layers.
// The Agent tracks a SET of indicator ids this run raised; every layer below
// iterates the registry instead of naming computer-use.

export const MOBILE_INDICATOR_ON_TOOL = 'mobile_indicator_on'
export const MOBILE_INDICATOR_OFF_TOOL = 'mobile_indicator_off'

export const MOBILE_INDICATOR_NOTICE =
  'DRIVING INDICATOR: ON — the user currently sees a blue frame around their simulator/emulator window and a notice reading "Wolffish is driving <device>". ' +
  'Only mobile_indicator_off takes it down; nothing clears it for you, and there is no timer. ' +
  'Call it the moment you stop looking at or touching the device — as the LAST action of this turn, whether you finished the task, gave up on it, or are handing back so the user can do something. ' +
  'A turn that ends with it still up tells them their device is being driven when it is not.'

const MOBILE_INDICATOR_NUDGE_TEXT =
  '[System: You are ending your turn, but the driving indicator is still ON — the user is still being shown ' +
  '"Wolffish is driving <device>" around their simulator even though you have stopped. Only mobile_indicator_off clears it; nothing ' +
  'else will, ever. Call mobile_indicator_off now. (If you are in fact not finished with their device, carry on with ' +
  'the task instead — but no turn may end with the indicator up.) Your reply has already been delivered to the ' +
  'user and cannot be unsent, so if there is something they still need to hear, say it — and if they genuinely ' +
  'need nothing further, call `close_turn` to end the turn cleanly. That is offered, not ordered: how the turn ' +
  'ends is yours to decide. What is never an ending is a typed stand-in for the silence — a bracketed note, a ' +
  'lone punctuation mark, a word or set phrase meaning "empty" or "nothing further" in ANY language — since ' +
  'anything you write is delivered to them verbatim, in whatever script you wrote it.]'

export type IndicatorSpec = {
  id: 'screen' | 'mobile'
  onTool: string
  offTool: string
  notice: string
  nudge: string
  /** Which tool-result meta key carries `lastAction` for this indicator. */
  metaKey: 'computerUse' | 'mobile'
  /** The verify wording appended after LAST ACTION. */
  verify: string
}

export const INDICATORS: IndicatorSpec[] = [
  {
    id: 'screen',
    onTool: SCREEN_INDICATOR_ON_TOOL,
    offTool: SCREEN_INDICATOR_OFF_TOOL,
    notice: SCREEN_INDICATOR_NOTICE,
    nudge: SCREEN_INDICATOR_NUDGE_TEXT,
    metaKey: 'computerUse',
    verify:
      'Before your next action, check on a fresh capture (or computer_read_element) that this actually happened; ' +
      'if it did not, re-aim or take another route rather than repeating it.'
  },
  {
    id: 'mobile',
    onTool: MOBILE_INDICATOR_ON_TOOL,
    offTool: MOBILE_INDICATOR_OFF_TOOL,
    notice: MOBILE_INDICATOR_NOTICE,
    nudge: MOBILE_INDICATOR_NUDGE_TEXT,
    metaKey: 'mobile',
    verify:
      'Before your next action, check on the proof patch or a fresh mobile_snapshot that this actually happened; ' +
      'if "Changed: NO", re-aim from a fresh snapshot rather than repeating it.'
  }
]

export const INDICATOR_OFF_TOOLS = new Set(INDICATORS.map((i) => i.offTool))

export type LastIndicatorAction = LastComputerAction & { indicator: IndicatorSpec['id'] }

/**
 * Fold one completed tool call into the set of indicators this run has up.
 * Successful calls only — a `computer_glow_on` that failed put nothing on
 * screen, and a `computer_glow_off` that failed took nothing down. Pure —
 * returns a new Set.
 */
export function trackIndicators(
  state: ReadonlySet<string>,
  toolName: string,
  ok: boolean
): Set<string> {
  const next = new Set(state)
  if (!ok) return next
  for (const spec of INDICATORS) {
    if (toolName === spec.onTool) next.add(spec.id)
    if (toolName === spec.offTool) next.delete(spec.id)
  }
  return next
}

/**
 * The runtime-tail text for every indicator that is up, each with its own
 * last action when the last action belongs to it. Undefined when none is up.
 */
export function indicatorNoticeText(
  state: ReadonlySet<string>,
  last: LastIndicatorAction | null | undefined
): string | undefined {
  const parts: string[] = []
  for (const spec of INDICATORS) {
    if (!state.has(spec.id)) continue
    if (last && last.indicator === spec.id) {
      const expect = last.expect ? ` Expected: ${last.expect}.` : ''
      parts.push(
        `${spec.notice} LAST ${spec.id === 'screen' ? 'SCREEN' : 'DEVICE'} ACTION: ${last.summary}.${expect} ${spec.verify}`
      )
    } else {
      parts.push(spec.notice)
    }
  }
  return parts.length ? parts.join(' ') : undefined
}

/**
 * The last action carried by a tool result's meta, for whichever indicator
 * produced it. Pure.
 */
export function lastIndicatorActionFrom(
  meta: Record<string, unknown> | undefined
): LastIndicatorAction | null {
  for (const spec of INDICATORS) {
    const bucket = meta?.[spec.metaKey]
    if (!bucket || typeof bucket !== 'object') continue
    const la = (bucket as { lastAction?: unknown }).lastAction
    if (!la || typeof la !== 'object') continue
    const rec = la as Record<string, unknown>
    if (typeof rec.summary !== 'string') continue
    return {
      indicator: spec.id,
      tool: typeof rec.tool === 'string' ? rec.tool : 'action',
      target: typeof rec.target === 'string' ? rec.target : null,
      expect: typeof rec.expect === 'string' ? rec.expect : null,
      summary: rec.summary
    }
  }
  return null
}

/**
 * The nudge for the first indicator still up when the model ends its turn,
 * or null. The caller logs `offTool` so the transcript names what was asked
 * for. Bounded by MAX_SCREEN_INDICATOR_NUDGES so it can never spin.
 */
export function indicatorNudge(
  state: ReadonlySet<string>,
  parsed: Pick<ParsedResponse, 'stopReason' | 'text' | 'toolCalls' | 'thinking'>,
  nudgeCount: number,
  maxNudges: number = MAX_SCREEN_INDICATOR_NUDGES
): { messages: ChatMessage[]; offTool: string } | null {
  if (nudgeCount >= maxNudges) return null
  if (parsed.stopReason !== 'end_turn' || parsed.toolCalls.length > 0) return null
  const spec = INDICATORS.find((i) => state.has(i.id))
  if (!spec) return null
  const user: ChatMessage = { role: 'user', content: spec.nudge }
  const delivered = parsed.text.trim()
  if (!delivered) return { messages: [user], offTool: spec.offTool }
  const assistant: ChatMessage = { role: 'assistant', content: delivered }
  if (parsed.thinking) assistant.reasoningContent = parsed.thinking
  return { messages: [assistant, user], offTool: spec.offTool }
}

/** The off tools to call for every indicator still up (the failsafe). Pure. */
export function indicatorOffTools(state: ReadonlySet<string>): string[] {
  return INDICATORS.filter((i) => state.has(i.id)).map((i) => i.offTool)
}

/**
 * Fold one completed tool call into the "is the indicator up?" flag.
 *
 * Turn-local by design. A global "is the glow window alive" probe would be
 * wrong twice over: with concurrent conversations one turn would see — and
 * the failsafe would then clear — an indicator another conversation is
 * actively using, and a glow raised by an earlier turn is not this turn's to
 * answer for. Tracking only what THIS run raised keeps every layer scoped to
 * the session that owns it.
 *
 * Only successful calls move the flag: a `computer_glow_on` that failed put
 * nothing on screen, and a `computer_glow_off` that failed took nothing down.
 */
