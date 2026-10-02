/**
 * Closing-message guard — the runtime tells the model when a turn is about to
 * say its wrap-up a second time; it never rewrites, strips or suppresses a
 * character of model output, and it never buys an extra model call.
 *
 * The failure it exists for was observed live (conversation
 * `2026-09-19_23-33-18_452-d73f7b`, turn 3): the model wrote a complete closing
 * answer, called `notify_phone`, and then — in the iteration that tool call
 * opened — wrote the same answer again, reworded. The user got two closing
 * paragraphs. Same facts, same structure, different words.
 *
 * That is a turn-boundary protocol failure, not random repetition, and it was
 * manufactured by the copy: agents.core.md said the wrap-up comes AFTER
 * `send_file`, that `notify_phone` is the closing beat, and that a silent tool
 * call as the last action is a failure. A tool call never ends an iteration, it
 * OPENS one — so a model that follows all three lands in a fresh iteration whose
 * only exit is producing text, having been told twice that something follows the
 * tool. It closed again. That was a legal reading of the prompt as written.
 *
 * The copy is reconciled now (see agents.core.md and the notify_phone tool
 * description — "this tool never earns a second reply"). This guard covers the
 * residual: the model that still does it, and any other turn-closing tool.
 *
 * THREE LAYERS, same shape as screen-indicator-guard, weakest first:
 *
 *   1. NOTICE   Not a layer here — the copy is the prevention layer, and it now
 *               lives in the prompt and in the tool description, which is the
 *               binding site (the tool schema is injected on every call,
 *               adjacent to the loop it must break out of).
 *   2. ADVISORY Armed when a closing tool lands, drained into the NEXT model
 *               call of the same turn — a call the model was going to make
 *               anyway, so it costs zero extra requests. It reports two facts
 *               the model cannot see for itself: the reply before the tool is
 *               already delivered and unrecallable, and a second telling of it
 *               is the same news twice. The model decides the ending.
 *   3. (deliberately none) No suppression, no stripping, no synthetic empty
 *               turn. Doing any of that would make the runtime the author of the
 *               user's message, and a similarity test loose enough to be useful
 *               is loose enough to silently eat a genuine follow-up. Silence on
 *               a real finding costs the user information with no error — the
 *               worst failure shape available. The model is told; the model
 *               decides. That is the same doctrine as control-token-guard.
 *
 * Zero extra API calls is the design constraint, not an accident: the notice
 * rides the existing volatile runtime tail (see prefrontal's `runtime` block,
 * after every cache breakpoint), so it neither perturbs the cached prefix nor
 * triggers a request that would not otherwise happen. Contrast the nudge family
 * (empty-turn, todo, indicator), which each spend a model call to recover a
 * failure. This one spends nothing: at the moment it fires, the model is
 * already composing the duplicate.
 */

/**
 * Tools that CLOSE a turn rather than advance it. After one of these, more prose
 * is a second close, not a continuation.
 *
 * `send_file` belongs on the list for the same reason as the other two:
 * agents.core.md has always told the model its wrap-up comes AFTER `send_file`,
 * so the identical double-close has been latent on every document-producing turn
 * since that line was written — same bug, different tool, just less visible
 * because a file-producing turn is rarer than a notifying one.
 */
export const TURN_CLOSING_TOOLS: ReadonlySet<string> = new Set([
  'notify_phone',
  'voice_respond',
  'send_file'
])

/**
 * The runtime-tail line. Reports, never orders: it hands over the two facts the
 * model cannot observe and leaves the ending to it.
 *
 * Copy rules this text obeys, both learned the hard way elsewhere in this
 * directory:
 *
 *  - It never ORDERS silence as a bare instruction. todo-guard's header records
 *    what that costs: a model told to say nothing, unable to emit a zero-token
 *    content channel, types a set phrase for "empty" instead and the user gets
 *    Chinese at the end of an English conversation. So silence is offered as one
 *    of the honest exits, with the other (say whatever is NEW) named first and
 *    the decision left to the model.
 *  - It never prints a stand-in for silence. control-token-guard and
 *    empty-turn-guard both record that printing one is how the model learns it.
 *    This text describes the class — "a bracketed status note, a lone
 *    punctuation mark, a set phrase meaning 'empty'" — and names no member.
 *
 * `closingTool` is the tool that landed, so the model knows which news is
 * already out and does not have to infer it from its own history.
 */
function closingAlreadyDeliveredNotice(closingTool: string): string {
  return (
    `CLOSING MESSAGE ALREADY DELIVERED: you already wrote this turn's wrap-up and closed it with \`${closingTool}\`. ` +
    'That reply went to the user the moment it streamed — nothing can unsend it or move it — so a second telling of the ' +
    'same news is the user reading the same paragraph twice on screen. ' +
    'If you have something genuinely NEW to add, say that and only that. Otherwise this turn is finished, and the ' +
    'correct close is to call `close_turn` — that is the way to end a turn in this runtime, and it is a complete and ' +
    'valid ending. ' +
    'The one thing that is never an ending is a typed stand-in for that silence: a bracketed status note, a lone ' +
    'punctuation mark, a written statement that you are saying nothing further, or a set phrase meaning "empty" in any ' +
    'language. Those are messages, not silence, and everything you write is delivered to the user verbatim as its own ' +
    'bubble.'
  )
}

/**
 * Per-turn state the guard reads. Turn-scoped and created fresh for each turn by
 * the Agent — the failure is intra-turn (two closes inside ONE turn), so nothing
 * here outlives the turn and no cross-turn memory is needed or wanted.
 */
export type ClosingGuardState = {
  /**
   * The turn-closing tool that landed most recently, or null when none has.
   * Set on a successful call; cleared is not needed, since the guard only ever
   * asks "has a close happened", and the earliest one is as good as the latest.
   */
  closingTool: string | null
  /**
   * True once the notice has been drained, so a long turn cannot be lectured
   * twice for the same close. The copy is the fix; this is one sentence of
   * backup, not a running argument.
   */
  noticeSpent: boolean
}

export function createClosingGuardState(): ClosingGuardState {
  return { closingTool: null, noticeSpent: false }
}

/**
 * Record a successful turn-closing tool call. Called from the Agent's tool
 * result path, so the state reflects what actually landed — a `notify_phone`
 * that failed to send is not a close and must not arm the notice.
 *
 * Every closing tool is idempotent here on purpose: `send_file` followed by
 * `notify_phone` is the CORRECT closing sequence (write-up → file → push), not
 * two closes, and the guard's job is only to know that the wrap-up has been
 * spoken for.
 */
export function recordClosingTool(state: ClosingGuardState, toolName: string): void {
  if (TURN_CLOSING_TOOLS.has(toolName)) state.closingTool = toolName
}

/**
 * The notice to ride this call's runtime tail, or undefined when there is
 * nothing to say. Returns it at most once per turn.
 *
 * Why this is not a nudge, in one line: the failure is a duplicate MESSAGE, and
 * the message has already streamed to the user by the time any guard can see it.
 * Re-prompting cannot unsend it, so the only two honest moves are (a) tell the
 * model before it writes the duplicate, or (b) eat a genuine follow-up silently.
 * (a) is this function; (b) is excluded by doctrine.
 */
export function closingNotice(state: ClosingGuardState): string | undefined {
  if (!state.closingTool || state.noticeSpent) return undefined
  state.noticeSpent = true
  return closingAlreadyDeliveredNotice(state.closingTool)
}
