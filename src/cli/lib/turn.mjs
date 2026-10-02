/**
 * Running one turn from the terminal: stream it, answer its cards, and know
 * when it is over.
 *
 * Two behaviours are deliberate and worth stating.
 *
 * DETACH IS NOT CANCEL. Ctrl-C asks the daemon to stop the turn; it does not
 * kill the daemon, and quitting the client entirely leaves the turn running.
 * That is the point of the split — an SSH drop mid-task loses the view, not
 * the work.
 *
 * APPROVALS PARK. If this client goes away with an approval outstanding, the
 * daemon keeps it pending so a reattaching terminal (or the phone) can answer.
 * A denial-on-disconnect would silently refuse a tool call because a network
 * hiccup happened, which on a long unattended task is the worst possible
 * default.
 */
import { c, icon, interactive, out, question, spinner, wrapText } from './ui.mjs'
import { TurnRenderer } from './render.mjs'

/** Approve-all, remembered for this client session only. */
const alwaysApproved = new Set()

export async function runTurn(client, payload, { verbose = false, fileOffset = 0 } = {}) {
  const renderer = new TurnRenderer({ verbose, fileOffset })
  let turnId = null
  let conversationId = payload.conversationId ?? null
  let finished = false
  let failure = null

  /**
   * A live "still working" line while nothing else is on screen.
   *
   * The gap it fills is the one that reads as a hang: between pressing enter
   * and the first token there is a title call, context assembly and the
   * provider's own latency — and with verbose off, a turn that spends a minute
   * inside tools prints nothing at all until it is done. The spinner is
   * whatever the agent is doing right now (the tool name, or the model), which
   * is also the answer to "is it stuck?".
   *
   * It stops the moment real output appears and restarts when the turn goes
   * quiet again, so it never fights the token stream for the same line. On a
   * non-TTY it is a no-op by construction (see ui.spinner).
   */
  let working = null
  const startWorking = (label) => {
    if (finished) return
    if (working) working.update(label)
    else working = spinner(label)
  }
  const stopWorking = () => {
    working?.stop()
    working = null
  }

  /**
   * Cards are answered ONE AT A TIME, in arrival order.
   *
   * The turn stream is dispatched without awaiting its listeners, and a card
   * is answered by claiming the session's next line — a single slot. Two
   * approvals issued in the same tick (a parallel tool step is enough) both
   * claimed it, the second overwrote the first, and the first request was
   * never answered at all: the turn sat waiting on a decision the terminal had
   * silently dropped, with the question still on screen.
   */
  let cardQueue = Promise.resolve()
  const askInTurn = (run) => {
    cardQueue = cardQueue.then(run, run)
    return cardQueue
  }

  let resolveDone = null
  const done = new Promise((resolve) => {
    resolveDone = resolve
    const offTurn = client.onTurn(async (event) => {
      // Frames for another conversation (a Telegram run, an automation) share
      // this socket — the terminal must only render its own turn.
      if (turnId && event.turnId && event.turnId !== turnId) return

      switch (event.t) {
        case 'segment':
          // Prose and cards own the screen while they arrive; the spinner
          // comes back for the silence after a tool call is issued.
          stopWorking()
          renderer.segment(event.segment)
          // Tool names are informative — "running shell" answers "is it
          // stuck?". The model name is not: it never changes mid-turn and the
          // banner already states it, so that case just says Thinking.
          if (event.segment?.kind === 'tool_call') startWorking(event.segment.name)
          else if (event.segment?.kind === 'active_model') startWorking('Thinking')
          return
        case 'turnEvent':
          renderer.turnEvent(event.type, event.payload)
          return
        case 'approvalRequest':
          // The prompt owns stdin — a spinner writing over it would garble
          // the question the user has to answer.
          stopWorking()
          await askInTurn(() => handleApproval(client, event))
          if (!finished) startWorking('Thinking')
          return
        case 'askRequest':
          stopWorking()
          await askInTurn(() => handleAsk(client, event))
          if (!finished) startWorking('Thinking')
          return
        case 'credentialBlocked':
          out(`${icon.gate()} ${c.yellow(`message discarded — it looked like a ${event.type}`)}`)
          return
        case 'done':
          finished = true
          stopWorking()
          offTurn()
          resolve()
          return
        case 'error':
          failure = event.error
          finished = true
          stopWorking()
          renderer.error(event.error)
          offTurn()
          resolve()
          return
        default:
          return
      }
    })
  })

  /**
   * The turn ends when the daemon says so — or when the daemon stops being
   * there.
   *
   * `done` resolved only on a `done`/`error` frame, so a daemon restart, a
   * crash, or a socket dropped mid-turn left the session awaiting a promise
   * that could no longer be settled: a spinner turning forever under a prompt
   * that never came back, with no message and no exit. The client already
   * detects the close; it simply had nobody listening.
   */
  const previousOnClose = client.onClose
  client.onClose = () => {
    previousOnClose?.()
    if (finished) return
    finished = true
    failure = 'lost the connection to the daemon — the turn may still be running'
    stopWorking()
    renderer.error(failure)
    resolveDone?.()
  }

  // Up before the send resolves: the title call alone can be a second or
  // more on a new conversation, and that is exactly the silence that reads as
  // a hang.
  startWorking('Thinking')

  /**
   * Cancel is armed BEFORE the send, not after.
   *
   * Registering it afterwards left a window — the title call, context
   * assembly, the first provider round trip — in which Ctrl-C did nothing to
   * the turn. That window is seconds long and is precisely when someone
   * realises they sent the wrong thing.
   */
  const onInterrupt = () => {
    if (finished) return
    stopWorking()
    out()
    out(c.yellow('  stopping…'))
    // `conversationId` may still be null if the send has not answered yet;
    // an unscoped cancel stops whatever this client started, which in that
    // window is exactly the turn being asked about.
    void client.invoke('cli:cancel', conversationId).catch(() => undefined)
  }
  process.on('SIGINT', onInterrupt)

  try {
    let started
    try {
      started = await client.invoke('cli:send', payload)
    } catch (error) {
      // A send that throws used to escape before the try/finally below,
      // leaving the spinner running over whatever printed next.
      stopWorking()
      renderer.error(error?.message ?? String(error))
      return {
        conversationId,
        turnId: null,
        files: renderer.deliveries(),
        error: error?.message ?? String(error)
      }
    }
    turnId = started.turnId
    conversationId = started.conversationId
    await done
  } finally {
    // Belt and braces: a spinner left running would keep rewriting the line
    // under the next prompt.
    stopWorking()
    process.removeListener('SIGINT', onInterrupt)
    client.onClose = previousOnClose
    renderer.endTurn()
  }

  return { conversationId, turnId, files: renderer.deliveries(), error: failure }
}

/**
 * The approval card, as a blocking prompt. Fails CLOSED on a non-interactive
 * stdin: a piped `wolffish -p` cannot answer, and auto-approving a flagged
 * call because nobody was watching is exactly the wrong direction. Use
 * `--yes`, or turn on bypass-permissions deliberately.
 */
export async function handleApproval(client, event) {
  const label = `${event.tool}`
  if (alwaysApproved.has(event.tool)) {
    await client.invoke('cli:approvalRespond', { id: event.id, decision: 'approved' })
    return
  }
  out()
  out(`${icon.gate()} ${c.bold('Approval needed')} ${c.gray(label)}`)
  if (event.reason) out(wrapText(c.gray(event.reason), 2))
  const args = event.args ? JSON.stringify(event.args) : ''
  if (args && args !== '{}') out(wrapText(c.gray(args.slice(0, 600)), 2))

  if (!interactive()) {
    out(c.red('  no terminal to ask — denied. Re-run interactively, or pass --yes.'))
    await client.invoke('cli:approvalRespond', { id: event.id, decision: 'denied' })
    return
  }

  const answer = (
    await question(`  ${c.bold('approve?')} ${c.dim('[y]es / [n]o / [a]lways this tool')} `)
  )
    .trim()
    .toLowerCase()
  if (answer === 'a' || answer === 'always') {
    alwaysApproved.add(event.tool)
    await client.invoke('cli:approvalRespond', { id: event.id, decision: 'approved' })
    return
  }
  const decision = answer === 'y' || answer === 'yes' ? 'approved' : 'denied'
  await client.invoke('cli:approvalRespond', { id: event.id, decision })
  if (decision === 'denied') out(c.gray('  denied'))
}

/**
 * The ask-the-user card. Each question takes a number (a listed option) or
 * free text (the card's custom field), matching the desktop's two answer
 * shapes exactly — the model receives the same structure either way.
 */
export async function handleAsk(client, event) {
  const questions = Array.isArray(event.questions) ? event.questions : []
  if (questions.length === 0 || !interactive()) {
    await client.invoke('cli:askRespond', { id: event.id, response: { kind: 'canceled' } })
    return
  }
  out()
  const answers = []
  for (const [index, q] of questions.entries()) {
    out(`${icon.ask()} ${c.bold(q.question ?? q.header ?? `Question ${index + 1}`)}`)
    const options = Array.isArray(q.options) ? q.options : []
    options.forEach((option, i) => {
      out(`   ${c.cyan(String(i + 1))}. ${option.label ?? option}`)
      if (option.description) out(wrapText(c.gray(option.description), 6))
    })
    const hint = options.length > 0 ? `1-${options.length}, or type your own` : 'type your answer'
    const reply = (await question(`  ${c.dim(hint)}: `)).trim()
    if (reply.length === 0) {
      await client.invoke('cli:askRespond', { id: event.id, response: { kind: 'canceled' } })
      return
    }
    const picked = Number.parseInt(reply, 10)
    if (
      options.length > 0 &&
      Number.isFinite(picked) &&
      picked >= 1 &&
      picked <= options.length &&
      String(picked) === reply
    ) {
      answers.push({ kind: 'option', index: picked - 1 })
    } else {
      answers.push({ kind: 'custom', text: reply })
    }
  }
  await client.invoke('cli:askRespond', {
    id: event.id,
    response: { kind: 'answered', answers }
  })
}

/**
 * Redraw and answer one PARKED card — an approval or an ask whose terminal
 * went away before it could reply. The frame is the one the daemon stored, so
 * the question reads exactly as it did when it was first asked.
 */
export async function answerParked(client, row) {
  if (row.kind === 'ask') return handleAsk(client, row.frame)
  return handleApproval(client, row.frame)
}

export function markAlwaysApproved(tool) {
  alwaysApproved.add(tool)
}
