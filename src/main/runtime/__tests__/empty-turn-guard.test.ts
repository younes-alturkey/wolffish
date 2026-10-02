/**
 * Empty-turn guard tests — pins the guardrail that intercepts a silent empty
 * end_turn (no tool calls, empty text) and injects a bounded number of "nudge"
 * messages to keep the loop going, instead of ending the turn on nothing.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx src/main/runtime/__tests__/empty-turn-guard.test.ts
 *
 * Imports stay on Electron-free leaf modules. The guard is a pure helper
 * (emptyTurnNudge); ParsedResponse inputs are manufactured via Wernicke.parse
 * over a fake StreamChunk generator, exactly matching what runRespond sees, so
 * the test also pins the parser contract the guard depends on.
 */

import { Wernicke, type ParsedResponse } from '../wernicke'
import type { StreamChunk } from '../thalamus'
import { emptyTurnNudge, MAX_EMPTY_TURN_NUDGES } from '../agent/empty-turn-guard'

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

async function* fakeStream(chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const c of chunks) yield c
}

const wernicke = new Wernicke()

// Empty end_turn: no text, no tool calls, end_turn — optionally with reasoning.
function emptyEndTurn(withReasoning = false): Promise<ParsedResponse> {
  const chunks: StreamChunk[] = []
  if (withReasoning) chunks.push({ type: 'reasoning', text: 'let me continue and add the rest' })
  chunks.push({
    type: 'turn_meta',
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 0 }
  })
  return wernicke.parse(fakeStream(chunks))
}

// A turn that produced a tool call (iteration 1 in the real repro).
function toolCallTurn(): Promise<ParsedResponse> {
  return wernicke.parse(
    fakeStream([
      { type: 'tool_call', id: 'call_1', name: 'read_file', args: { path: 'a.txt' } },
      { type: 'turn_meta', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } }
    ])
  )
}

// A normal, legitimate end_turn that produced real text.
function textEndTurn(): Promise<ParsedResponse> {
  return wernicke.parse(
    fakeStream([
      { type: 'text', text: 'All done.' },
      { type: 'turn_meta', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 3 } }
    ])
  )
}

async function main(): Promise<void> {
  // Sanity: the fake stream really does parse to an empty end_turn.
  const empty = await emptyEndTurn()
  ok(
    'empty end_turn parses to no text / no tools',
    empty.text === '' && empty.toolCalls.length === 0
  )
  ok('empty end_turn keeps stopReason end_turn', empty.stopReason === 'end_turn')

  // 1. A first empty end_turn produces the aside, and nothing else. The
  //    assistant placeholder that used to lead it — a literal `(continuing)`,
  //    a parenthesized stand-in for an empty turn written in the model's own
  //    voice one message before it replied — is the shape that leaked back out
  //    to users as `(no output)` / `(no content)`. It must never come back:
  //    Anthropic no longer needs the filler (toAnthropicMessages merges a user
  //    message into the preceding user turn), and no other wire ever did.
  const nudge = emptyTurnNudge(empty, 0)
  ok('first empty end_turn produces a nudge', nudge !== null)
  ok('nudge is the user aside alone', nudge?.length === 1)
  ok('no assistant turn is interposed', !nudge?.some((m) => m.role === 'assistant'))
  ok(
    'nudge[0] is a non-empty user prompt',
    nudge?.[0].role === 'user' &&
      typeof nudge[0].content === 'string' &&
      (nudge[0].content as string).length > 0
  )
  // The nudge asked a silent model to type nothing and thereby taught it what
  // to type: it printed the offending note as the example not to write, and a
  // model reaches for the nearest token. Pin that the copy never names one.
  const nudgeText = (nudge?.[0].content as string) ?? ''
  ok(
    'nudge never prints a stand-in for silence',
    !/\(\s*no output\s*\)|\(\s*nothing to add\s*\)/i.test(nudgeText),
    nudgeText
  )
  ok(
    'nudge names the producible exit and the trailing-marker shape',
    /close_turn/.test(nudgeText) && /trailing marker/.test(nudgeText),
    nudgeText
  )
  // The eloquent variant: a model that agrees silence is right and then writes
  // a reasoned parenthetical saying so (observed live: a bracketed sentence
  // explaining that the recap above was the reply and the phone notice was
  // already sent). Arguing the case well is not an exemption, so the nudge has
  // to deny the side-channel premise outright and say what parentheses ARE for.
  ok(
    'nudge denies the parenthesis side channel and names its legitimate use',
    /side channel/.test(nudgeText) && /real asides/.test(nudgeText),
    nudgeText
  )
  ok(
    'nothing injected carries a tool call (no orphaned tool_use)',
    nudge?.every((m) => m.role !== 'assistant' || m.toolUses === undefined) === true
  )

  // 2. Reasoning: there is no assistant turn to hang it on any more. Only the
  //    OpenAI-shaped reasoning wires echo reasoningContent back at all, and
  //    what is dropped is the thinking of a call that produced nothing.
  const emptyWithReasoning = await emptyEndTurn(true)
  const reasoningNudge = emptyTurnNudge(emptyWithReasoning, 0)
  ok(
    'a reasoning-only empty turn still injects the aside alone',
    reasoningNudge?.length === 1 && reasoningNudge[0].role === 'user'
  )

  // 3. A turn that produced a tool call is NOT an empty turn — never nudged.
  const withTool = await toolCallTurn()
  ok('tool-call turn is never nudged', emptyTurnNudge(withTool, 0) === null)

  // 4. A turn with real text is a legitimate end — never nudged.
  const withText = await textEndTurn()
  ok('text end_turn is never nudged', emptyTurnNudge(withText, 0) === null)

  // 5. Bounded: once the cap is reached, stop (no off-by-one at the boundary).
  ok('no nudge once the cap is reached', emptyTurnNudge(empty, MAX_EMPTY_TURN_NUDGES) === null)
  ok('nudge cap is small', MAX_EMPTY_TURN_NUDGES >= 1 && MAX_EMPTY_TURN_NUDGES <= 3)

  // 6. Repeated empty turns nudge exactly MAX_EMPTY_TURN_NUDGES times, then give up.
  let nudges = 0
  for (let count = 0; count < MAX_EMPTY_TURN_NUDGES + 2; count++) {
    if (emptyTurnNudge(empty, count) !== null) nudges++
  }
  ok(
    'bounded to exactly MAX_EMPTY_TURN_NUDGES nudges',
    nudges === MAX_EMPTY_TURN_NUDGES,
    String(nudges)
  )

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
