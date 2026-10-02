/**
 * The interactive session — `wolffish` with no arguments.
 *
 * The important thing this is NOT: the process that runs Wolffish. The agent
 * lives in the daemon. This is a viewport, so closing it (or losing the SSH
 * connection that hosts it) leaves automations, channels and any turn in
 * flight running, and reopening reattaches to whatever is live.
 */
import path from 'node:path'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import readline from 'node:readline'
import os from 'node:os'
import {
  c,
  g,
  heading,
  icon,
  keyValue,
  out,
  pad,
  question,
  relativeTime,
  setLineReader,
  table,
  withProgress,
  wordmark,
  wrapText
} from '../lib/ui.mjs'
import { answerParked, runTurn } from '../lib/turn.mjs'
import { setSetting } from './settings.mjs'
import { listAllSettings, settingsBrowser } from './settings-browser.mjs'
import {
  automations,
  browseFiles,
  customizations,
  editWorkspaceFile,
  exportDiagnostics,
  procedures,
  projects,
  resolveConversationId,
  shortConversationId,
  showConversation,
  usage,
  viewFile
} from './workspace.mjs'
import { pair } from './pair.mjs'
import { service } from './service.mjs'
import { basename } from '../lib/render.mjs'
import { filterConversationsByTitle } from '../lib/search.mjs'
import { stdinIsRawCapable, stdinIsTty, stdoutIsTty } from '../lib/tty.mjs'
import { setConsoleEcho } from '../lib/console-ctl.mjs'
import { attachComposer } from '../lib/composer.mjs'

/** Conversations per page. Enough to scan without scrolling a normal window. */
const PAGE_SIZE = 25

/**
 * The commands, grouped the way the terminal's own help is.
 *
 * Two things are deliberately NOT here. `/help` — you are reading the list, so
 * naming the command that printed it is a line that can only tell you what you
 * already did. And `/more` — it means nothing until a listing is on screen,
 * and the listing's own footer offers it at exactly that moment. A top-level
 * menu should hold the things you can do FROM HERE.
 */
const SLASH_HELP = [
  ['CHAT', null],
  ['/new', 'start a fresh conversation'],
  ['/resume [id]', 'continue a past one'],
  ['/show [tools|clean] [n]', 'read this conversation back — paged'],
  ['/info', 'title, context used, cost'],
  ['/cancel', 'stop the running turn'],
  ['/pending', 'answer approvals parked by an earlier session'],

  ['CONVERSATIONS', null],
  ['/conversations [words]', 'list them, newest first — words narrow by title'],
  ['/read <n|id>', 'read one without leaving this conversation'],
  ['/switch <n|id>', 'talk to one, by its number or id'],

  ['FILES', null],
  ['/attach <path…>', 'stage files for the next message'],
  ['/files', 'what this session has delivered'],
  ['/open <n>', 'open one with the OS'],
  ['/save <n> <dest>', 'copy one somewhere else'],
  ['/workspace [path]', 'walk the workspace — folders open, files open'],
  ['/view <path>', 'read a workspace file'],
  ['/edit <path>', 'change a workspace file'],

  ['WORKSPACE', null],
  ['/projects', 'browse them — open one to edit, attach files, set folders'],
  ['/procedures', 'browse them — open one to run, edit, attach files'],
  ['/automations', 'browse them — open one to run or attach files'],
  ['/customizations', 'soul · user · agents (edit <name> to change)'],

  ['SETTINGS', null],
  ['/settings', 'browse everything: page, card, setting'],
  ['/settings <name>', 'jump straight to one, e.g. /settings telegram'],
  ['/settings list', 'print every setting and its value'],
  ['/set <id> <value>', 'change one directly'],
  ['/model', 'show or switch the brain'],
  ['/mode single|workflow', 'switch chat mode'],
  ['/verbose on|off', 'tool-by-tool output'],

  ['THIS MACHINE', null],
  ['/status', 'daemon, brain, channels'],
  ['/diagnose', 'zip up everything about this conversation'],
  ['/pair <phone|whatsapp|telegram>', 'link a channel'],
  ['/usage [range]', 'tokens and cost'],
  ['/logs', 'the tail of the daemon log'],
  ['/exit', 'leave (the agent keeps running)']
]

export async function repl(client, { conversationId = null, verbose = false } = {}) {
  const state = {
    conversationId,
    verbose,
    pendingAttachments: [],
    files: [],
    // Title of the conversation being talked to, shown in the prompt so the
    // terminal never leaves you guessing which transcript you are appending
    // to — the one thing a chat window shows for free and a REPL does not.
    title: null,
    // Everything `/conversations` + `/more` have shown so far, in order. Numbering is
    // cumulative on purpose: after `/more`, `/switch 3` must still mean the
    // third row the user read, not the third row of the newest page.
    listing: [],
    pageSize: PAGE_SIZE,
    // The words `/conversations` was last narrowed by, '' for the whole list.
    // Held on the state rather than passed down, so `/more` pages through the
    // SAME search instead of silently widening back out at the page boundary.
    filter: ''
  }

  const [snapshot, cliConfig, status] = await Promise.all([
    client.invoke('cli:snapshot').catch(() => ({})),
    client.invoke('cli:getConfig').catch(() => ({})),
    client.invoke('cli:status').catch(() => ({}))
  ])
  state.verbose = verbose || cliConfig?.verbose === true
  if (state.conversationId) state.title = await titleOf(client, state.conversationId)

  printBanner({ snapshot, state, status, version: client.hello?.version })

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    // Through the glyph proxy, not a literal '›'. A legacy console on codepage
    // 437 renders that UTF-8 as `ÔÇ║`, and the prompt is the one string on
    // screen at all times — it was the entire visible output of a session that
    // printed nothing else.
    prompt: c.blue(`${g.chevron} `),
    historySize: 500,
    // Genuinely `isTTY`, not stdinIsTty(): terminal mode means readline drives
    // raw-mode line editing, and under the Windows launcher stdin is a pipe
    // that cannot do raw mode. Line mode there is not a downgrade in practice —
    // the launcher forwards COOKED console input, so Windows' own editing
    // (backspace, F3, F7 history) has already been applied to every line.
    terminal: process.stdin.isTTY === true
  })

  /**
   * Every nested prompt — the settings browser, the workspace menus, a pairing
   * flow — borrows the session's own line stream rather than reading stdin.
   *
   * Reading stdin directly is broken two ways under a terminal-mode readline:
   * raw mode delivers Enter as `\r` (so the read never completes) and readline
   * banks the same keystrokes as lines, replaying them as chat input after —
   * which sent real messages to a live agent once.
   *
   * `rl.question()` is NOT the fix either, and this is the subtle part: the
   * session loop below is `for await (const line of rl)`, and while that async
   * iterator owns the interface a question callback never fires. The prompt
   * paints and the keystroke goes to the iterator, so every menu looked alive
   * and answered nothing.
   *
   * So the nested prompt does not compete with the loop — it CLAIMS the next
   * line from it. One reader, one line discipline, and the loop is the only
   * thing that ever touches the input.
   */
  let pendingAsk = null
  /**
   * Lines that arrive while a menu flow is BETWEEN questions.
   *
   * A menu answer resolves its promise as a microtask, and the flow's next
   * question registers only after that continuation runs — often a daemon
   * round-trip later. A second line typed into that gap (a double-tapped
   * Enter, a number typed while the list is still loading) found `pendingAsk`
   * empty and fell through to the session queue, where it replayed as CHAT
   * the moment the menu closed. Measured on `/customizations`: the menu
   * reprinted as if Enter had done nothing, and a stray "2" then went to the
   * live agent as a message nobody wrote.
   *
   * So while a command is being pumped, unclaimed lines wait HERE instead.
   * The flow's next question consumes them in the order they were typed —
   * a double Enter walks two menu levels up, exactly as it reads — and
   * whatever is left when the command finishes dies with the menu rather
   * than becoming a message.
   */
  let askBacklog = []
  /**
   * A secret typed at a nested prompt must not be echoed — and this is the only
   * place that can stop it.
   *
   * `question(…, { hidden: true })` in ui.mjs used to pause readline and read
   * the raw stream itself. That does not work: `rl.pause()` leaves readline's
   * keypress listener attached, and resuming the stream hands it every
   * keystroke anyway. Measured, a bot token typed at `/settings → Telegram →
   * Enter the bot token` appeared in clear in the scrollback.
   *
   * The reader has to stay the reader, so the echo is muted at its source
   * instead. `_writeToOutput` is what readline paints the line with; replacing
   * it for the duration means the interface still edits, still emits the line,
   * and draws nothing while it does.
   */
  let hiddenAsk = false
  /** A turn is streaming — declared here because the composer reads it. */
  let running = false

  /**
   * The multi-line composer: bracketed paste and Shift+Enter, on top of this
   * same readline. Only where stdin can do raw mode — under the Windows
   * launcher the input is a cooked pipe with no keystrokes to intercept, and
   * pasted blocks are joined further down instead (see the burst join in the
   * line handler).
   */
  const composer =
    process.stdin.isTTY === true
      ? attachComposer(rl, {
          contPrompt: () => c.gray(`${g.dot} `),
          // While a turn streams the renderer owns the screen, and during a
          // hidden ask nothing may paint at all — soft newlines would draw
          // rows into both, so they are inert until the prompt is back.
          isBusy: () => running || hiddenAsk,
          onRestorePrompt: () => applyPrompt()
        })
      : null
  composer?.enable()

  /** Resolve one line typed at a nested prompt, restoring whatever it muted. */
  const concludeAsk = (ask, answer, { silent = false } = {}) => {
    pendingAsk = null
    if (ask.hidden) {
      hiddenAsk = false
      delete rl._writeToOutput
      if (!stdinIsRawCapable()) void setConsoleEcho(true)
      // The Enter that ended the line was swallowed with everything else.
      if (!silent) process.stderr.write('\n')
      // History is the second copy of a secret people forget about — it is
      // one arrow-up away, and it is written to disk by nothing here but is
      // visible for the rest of the session.
      if (typeof answer === 'string' && Array.isArray(rl.history) && rl.history[0] === answer) {
        rl.history.shift()
      }
    }
    // The ask borrowed the prompt slot; the next repaint is chat's again.
    applyPrompt()
    ask.resolve(answer)
  }

  /**
   * One line, delivered to the ask that is waiting for it.
   *
   * Single-line asks resolve immediately. A MULTILINE ask (the cooked-input
   * form of "paste a new prompt" — raw terminals get the composer instead)
   * collects lines until a lone `.`, cancelling on a blank first line; the ask
   * stays pending between lines, which is exactly what lets a pasted block's
   * burst of line events land inside ONE answer instead of leaking into the
   * menus behind it.
   */
  const feedAskLine = (line) => {
    const ask = pendingAsk
    if (!ask.multiline) {
      concludeAsk(ask, line)
      return
    }
    if (ask.collected.length === 0 && line.trim() === '') {
      concludeAsk(ask, null)
      return
    }
    if (line.trim() === '.') {
      concludeAsk(ask, ask.collected.join('\n'))
      return
    }
    ask.collected.push(line)
  }

  setLineReader({
    question: (prompt, resolve, { hidden = false, multiline = false } = {}) => {
      // One INPUT LINE, loudly marked: a thick blue bar at column 0, the
      // question inline after it, and the cursor right where the answer goes —
      // immediately after the colon. The bar replaces the question's own
      // indent; it is the "type here" signal, bolder than the chat chevron
      // because it follows a dense menu rather than an empty screen.
      const ask = `${c.blue(g.input)} ${prompt.replace(/^\s+/, '').replace(/\n$/, '')}`
      // Typed ahead of the question: answer it immediately, and print the
      // pair so the transcript still shows what was asked and what answered.
      // Never for hidden asks — a secret is typed at its own prompt or not
      // at all.
      if (!hidden && askBacklog.length > 0) {
        if (multiline) {
          // The parked lines flow into the collector in typed order — the
          // very burst a cooked-mode paste produces.
          out(ask)
          pendingAsk = { resolve, hidden: false, multiline: true, collected: [] }
          while (askBacklog.length > 0 && pendingAsk) feedAskLine(askBacklog.shift())
          return
        }
        out(`${ask}${askBacklog[0]}`)
        resolve(askBacklog.shift())
        return
      }
      if (hidden) {
        // Mute FIRST, synchronously, before anything invites typing.
        hiddenAsk = true
        rl._writeToOutput = () => {}

        // Muting the writer is only half the answer, and on Windows it is the
        // half that does nothing: under the launcher readline is not in
        // terminal mode, so it never painted the line — the CONSOLE echoes it.
        // Ask the launcher to stop, and if it cannot, say so instead of
        // letting the token land in the scrollback believing it is hidden.
        //
        // The prompt is printed only AFTER that round-trip returns. Printing it
        // first and masking after leaves a window — a named-pipe connect, so
        // milliseconds, but unbounded if the server is between accepts — in
        // which the user has been asked for a secret and the console is still
        // echoing. Nobody types before the prompt appears, so withholding it is
        // what makes the gap unreachable. ui.mjs orders it the same way.
        //
        // No trailing newline on `ask`: the answer is invisible, so the prompt
        // stays on its own line with the cursor after it, the way every
        // password prompt in a shell behaves.
        if (!stdinIsRawCapable()) {
          void (async () => {
            const masked = await setConsoleEcho(false)
            if (!masked) process.stderr.write(`\n${c.yellow('(input will be visible)')}\n`)
            process.stderr.write(ask)
          })()
        } else {
          process.stderr.write(ask)
        }
      } else if (running) {
        // Mid-turn cards (an approval, an ask) arrive while the readline
        // writer is muted to keep repaints off the token stream — a prompt
        // painted through it would be invisible. Print the question directly.
        out(prompt.replace(/\n$/, ''))
      } else {
        // The question becomes the PROMPT, not a printed line. `out()` ends in
        // a newline, which parked the cursor at column 0 of a bare line below
        // the question — no marker, nothing blinking after the colon — so a
        // menu waiting for a number looked exactly like a menu that had hung.
        // Handing the question to readline keeps cursor and question on ONE
        // line, and a backspace now repaints the question rather than
        // reaching for the chat prompt.
        //
        // The cursor is on a fresh row here — the menu above was just printed.
        // Readline may still believe it sits below the previous ask's row (a
        // ^C-claimed ask resets nothing, and a long answer wraps), and
        // repainting from that belief walks UP a row and clears the menu's
        // own hint line. Say where we are.
        rl.prevRows = 0
        rl.setPrompt(ask)
        rl.prompt(true)
      }
      pendingAsk = { resolve, hidden, multiline, collected: [] }
    },
    pause: () => rl.pause(),
    resume: () => rl.resume(),
    prompt: () => rl.prompt(true),
    // The editor handover in ui.mjs stands these down alongside raw mode, so a
    // spawned nano never inherits the composer's terminal key encodings.
    suspendInput: () => composer?.suspend(),
    resumeInput: () => composer?.resume()
  })

  /**
   * Runs started elsewhere (an automation, a Telegram message, the app window)
   * are announced here rather than silently interleaving — the terminal is one
   * view of a shared agent, not the only one.
   *
   * Printed with a repaint, because an unsolicited line has to give the
   * terminal back. `out()` writes at the cursor, which mid-typing is the
   * middle of the user's own half-finished sentence: the notice lands inside
   * it and the line they were composing is scattered across two rows with no
   * way to tell which characters are theirs. Clearing the line, printing, then
   * redrawing the prompt with `rl.prompt(true)` puts their text back exactly
   * as they left it. Suppressed entirely while a turn streams — the renderer
   * owns the screen then, and a notice in the middle of the answer is the same
   * problem one layer up.
   */
  client.onEvent((channel, payload) => {
    if (channel !== 'chat:turnState') return
    if (!payload?.conversationId || payload.conversationId === state.conversationId) return
    if (payload.phase !== 'started') return
    if (payload.channel === 'cli') return
    if (running) return
    if (stdoutIsTty()) process.stdout.write('\r\x1b[K')
    out(
      c.gray(
        `  ${icon.dot()} ${payload.channel ?? 'another surface'} started a turn — ${payload.title ?? 'Untitled'}`
      )
    )
    rl.prompt(true)
  })

  /**
   * An approval left unanswered by a client that went away is PARKED, not
   * denied — so the first thing a returning session has to do is ask about it.
   * Without this the daemon holds a turn on a decision nobody can see: the
   * conversation is simply stuck, and `wolffish status` reports it as running.
   */
  void client
    .invoke('cli:pendingRequests')
    .then((pending) => {
      const rows = Array.isArray(pending) ? pending : (pending?.requests ?? [])
      if (!rows.length) return
      if (stdoutIsTty()) process.stdout.write('\r\x1b[K')
      out()
      out(
        `${icon.gate()} ${c.yellow(`${rows.length} request${rows.length === 1 ? '' : 's'} waiting from an earlier session`)}`
      )
      for (const row of rows) {
        out(
          c.gray(
            `   ${row.tool ?? row.kind ?? 'request'} ${shortConversationId(row.conversationId ?? '')}`
          )
        )
      }
      out(c.gray('   answer them with: /pending'))
      rl.prompt(true)
    })
    .catch(() => undefined)

  /** Slash commands say what they are waiting on; turns already do. */
  const progress = withProgress(client)

  /**
   * The prompt carries the conversation you are in. Without it the REPL looks
   * identical whether the next message continues a long thread or starts a
   * fresh one — the single most consequential thing about a chat, and the one
   * a window shows for free in its title bar.
   */
  const applyPrompt = () => {
    // The conversation name sits on its OWN line above the input, not inline
    // with it. Inline, a long title eats the width you type into and moves the
    // cursor column every time you switch — and the name is context you glance
    // at, not something you want your text starting after.
    // g.chevron, never a literal — see the prompt on createInterface above.
    // These two were missed the first time and they are the ones that actually
    // repaint, so a console on codepage 437 still printed `ÔÇ║` at every turn.
    const chevron = c.blue(`${g.chevron} `)
    if (!state.conversationId) {
      rl.setPrompt(chevron)
      return
    }
    const label = truncate(state.title ?? shortConversationId(state.conversationId), 60)
    rl.setPrompt(`${c.gray(label)}\n${chevron}`)
  }

  applyPrompt()

  rl.prompt()

  /**
   * The session runs off readline's `line` EVENT, not `for await (const line
   * of rl)`.
   *
   * The async iterator looks like the tidier loop and is the reason every
   * nested menu was dead: while the loop body awaits, the iterator has PAUSED
   * the input, so a keystroke typed at a menu is not merely unread — it is
   * never parsed into a line at all. It sits in the stream until the body
   * returns, and then arrives as chat.
   *
   * Events keep flowing regardless of what the body is doing, which is exactly
   * what a nested prompt needs. The queue restores the one property the
   * iterator gave for free: lines are handled strictly one at a time.
   */
  const queue = []
  let pumping = false
  let finished = null
  const done = new Promise((resolve) => {
    finished = resolve
  })

  /**
   * The launcher's cooked pipe delivers a pasted block as one chunk that
   * readline splits into a synchronous burst of line events — which used to
   * mean "send the first line as a message, drop the rest at the busy guard".
   * Lines landing in the same instant are one paste, so they are joined back
   * into one message. Gated to the launcher's interactive console (stdin is a
   * TTY by proxy but not raw-capable): a genuinely piped script keeps its
   * line-at-a-time semantics untouched.
   */
  const joinPastedBursts = process.stdin.isTTY !== true && stdinIsTty()
  let burst = null

  rl.on('line', (line) => {
    // A finished compose joins its frozen rows to this line before ANYTHING
    // reads it — whatever consumes the line must see the whole message, never
    // just its last row.
    if (composer?.isActive()) line = composer.finish(line)
    // A menu is waiting — it claims this line, and the session never sees it.
    // Checked before anything else, including the blank guard: blank is a
    // meaningful answer to a menu ("go back"), and swallowing it here is what
    // would make the one key every menu documents do nothing.
    if (pendingAsk) {
      feedAskLine(line)
      return
    }
    // No question is waiting, but a command is mid-stride — its next question
    // is a microtask or a round-trip away. Park the line for it; the
    // alternative was the chat queue, which is how menu keys became messages.
    // Mid-turn (`running`) the queue is still right: those lines get the
    // "still working" guard, not a menu.
    if (pumping && !running) {
      askBacklog.push(line)
      return
    }
    if (joinPastedBursts) {
      if (burst) {
        burst.push(line)
        return
      }
      burst = [line]
      setImmediate(() => {
        const joined = burst.join('\n')
        burst = null
        dispatchLine(joined)
      })
      return
    }
    dispatchLine(line)
  })

  /**
   * A line typed while a turn is running is a MID-TURN MESSAGE, not the next
   * turn: the daemon parks it for the agent's next stop point (see
   * runtime/agent/interjection.ts) and the work in flight reads it there. It
   * cannot travel through the pump — the pump is busy inside the running
   * turn's handleLine and would only surface the line after the reply, when
   * there is nothing left to steer. `no_live_turn` means the turn ended under
   * us: the line becomes an ordinary next turn. Slash commands keep their old
   * path; they act on the session, not the work.
   */
  function dispatchLine(line) {
    const text = line.trim()
    if (running && text.length > 0 && !text.startsWith('/')) {
      void interjectLine(text)
      return
    }
    queue.push(line)
    void pump()
  }

  async function interjectLine(text) {
    let result = null
    try {
      result = await client.invoke('cli:interject', {
        conversationId: state.conversationId,
        messageId: `i_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        text,
        attachmentPaths: state.pendingAttachments.length ? state.pendingAttachments : undefined
      })
    } catch (error) {
      out(`${icon.fail()} ${c.red(error?.message ?? String(error))}`)
      return
    }
    if (result?.status === 'pending') {
      state.pendingAttachments = []
      out(c.gray('  read at the next step'))
      return
    }
    queue.push(text)
    void pump()
  }

  /**
   * Ctrl-C, owned here.
   *
   * Without a listener on the interface, readline's fallback for ^C is
   * `process.kill(pid, 'SIGINT')` — so the banner's "Ctrl-C stops a turn" was
   * really "Ctrl-C ends the session", and mid-turn it did not even manage
   * that (see the mute above). Claiming the signal makes one key mean one
   * thing at every depth: abandon what is in front of you, and never the
   * session unless there is nothing left to abandon.
   */
  let interruptedAt = 0
  rl.on('SIGINT', () => {
    if (running) {
      out()
      out(c.yellow('  stopping…'))
      void client.invoke('cli:cancel', state.conversationId).catch(() => undefined)
      return
    }
    if (pendingAsk) {
      // A menu or a card is waiting. Answer it with the same blank that means
      // "go back" everywhere else, rather than tearing the session down under
      // a prompt the user simply changed their mind about. ^C abandons what
      // was typed ahead along with the prompt it was aimed at — frozen compose
      // rows included, since they were being typed INTO this ask.
      askBacklog = []
      composer?.abandon()
      const ask = pendingAsk
      concludeAsk(ask, ask.multiline ? null : '', { silent: true })
      out()
      // The out() above moved to a fresh row; without this, the next repaint
      // still thinks it owns the abandoned ask's rows and clears over them.
      rl.prevRows = 0
      return
    }
    if (composer?.isActive()) {
      // A half-composed message is on screen. ^C means "never mind", not
      // "leave" — drop the frozen rows and hand back a clean prompt.
      composer.abandon()
      out()
      out(c.gray('  (discarded the unsent lines)'))
      rl.prevRows = 0
      rl.prompt()
      return
    }
    // Nothing to abandon. One press clears the line and says so; a second
    // within two seconds is the deliberate "I mean it" that leaves.
    const now = Date.now()
    if (now - interruptedAt < 2000) {
      out()
      out(c.gray('  detached — the agent keeps running'))
      finished?.()
      return
    }
    interruptedAt = now
    rl.write(null, { ctrl: true, name: 'u' })
    out()
    out(c.gray('  (Ctrl-C again to leave, Ctrl-D to leave now)'))
    rl.prompt()
  })

  rl.on('close', () => finished?.())

  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (queue.length > 0) {
        const line = queue.shift()
        if ((await handleLine(line)) === 'exit') {
          finished?.()
          return
        }
      }
    } finally {
      pumping = false
    }
  }

  async function handleLine(line) {
    const input = line.trim()
    if (input.length === 0) {
      rl.prompt()
      return null
    }
    if (running) {
      // Normally unreachable — dispatchLine routes mid-turn lines before the
      // pump — but a line that does land here mid-turn is still a message
      // for the running turn, never a second concurrent turn racing stdout.
      void interjectLine(input)
      return null
    }

    if (input.startsWith('/')) {
      // A command that throws must cost the command, not the session. These
      // reach live services, and an unwound session is a terminal that stops
      // answering with no explanation.
      let result = null
      try {
        // Slash commands get the spinner-wrapped client; turns keep the raw one
        // and draw their own, which names the tool rather than the channel.
        result = await handleSlash(progress, state, input)
      } catch (error) {
        out(`${icon.fail()} ${c.red(error?.message ?? String(error))}`)
      }
      // The command is over; anything still parked was aimed at its menus.
      // Blank overshoot Enters die silently, but words are worth a receipt —
      // silently eating typed text reads as the session dropping input.
      if (askBacklog.length > 0) {
        const dropped = askBacklog.filter((line) => line.trim().length > 0)
        askBacklog = []
        if (dropped.length > 0) {
          out(
            c.gray(
              `  ${icon.dot()} ignored ${c.dim(truncate(dropped.join(' · '), 40))} — typed while no prompt was waiting`
            )
          )
        }
      }
      if (result === 'exit') return 'exit'
      // Anything that changed which conversation we are in has to redraw the
      // prompt before it is printed, or the next line names the previous one.
      if (result === 'reprompt') applyPrompt()
      rl.prompt()
      return null
    }

    running = true
    /**
     * The reader stays ATTACHED while a turn streams — muted, not paused.
     *
     * `rl.pause()` was the obvious way to keep readline's prompt redraw off
     * the token stream, and it broke the banner's own promise. A paused
     * interface does not read the input at all, so Ctrl-C during a turn was
     * not delivered: it sat in the stream buffer, the turn ran to completion
     * as if nothing had happened, and then — with the prompt back — the
     * buffered ^C arrived and killed the session. Measured on a live turn:
     * a Ctrl-C six seconds in produced the full forty-line answer, then exit.
     *
     * Muting the writer keeps the screen clean while leaving the keystrokes
     * flowing, so the SIGINT handler below actually gets its chance. Lines
     * typed mid-turn still reach `handleLine`, which says the turn is busy.
     */
    const writeLine = rl._writeToOutput?.bind(rl)
    rl._writeToOutput = () => {}
    try {
      const result = await runTurn(
        client,
        {
          text: input,
          conversationId: state.conversationId,
          attachmentPaths: state.pendingAttachments.length ? state.pendingAttachments : undefined
        },
        // The session's list is what /open and /save index, so the numbers
        // printed beside a delivered file have to continue it.
        { verbose: state.verbose, fileOffset: state.files.length }
      )
      const isNew = state.conversationId !== result.conversationId
      state.conversationId = result.conversationId
      state.pendingAttachments = []
      state.files.push(...result.files)
      // The title is written by the titler DURING the turn, so it only exists
      // to be read once the turn is over. Fetch it for a conversation this
      // turn created, so the prompt names it from the very next line.
      if (isNew || !state.title) state.title = await titleOf(client, result.conversationId)
    } catch (error) {
      out(`${icon.fail()} ${c.red(error.message)}`)
    } finally {
      running = false
      if (writeLine) rl._writeToOutput = writeLine
      else delete rl._writeToOutput
      applyPrompt()
      out()
      rl.prompt()
    }
    return null
  }

  await done
  // Hand the terminal back the way it was found — bracketed paste off, kitty
  // keys popped — before readline lets go of raw mode.
  composer?.disable()
  rl.close()
  return 0
}

/**
 * The same wordmark the installer prints, so the two read as one product.
 * Kept as a plain constant rather than generated: it is three lines, and a
 * figlet dependency for three lines is not a trade worth making.
 */
/**
 * What a session opens with.
 *
 * More than a greeting, because a terminal has no chrome: everything a chat
 * window shows around the edges — which model answers, which mode, which
 * conversation, whether the channels are up, whether anything is already
 * running elsewhere — has to be said once, here, or it is invisible. The
 * alternative is a user typing into a session whose brain is unconfigured and
 * finding out a turn later.
 *
 * Skipped entirely when stdout is not a terminal: a banner in piped output is
 * noise in somebody's file.
 */
function printBanner({ snapshot, state, status, version }) {
  if (!stdoutIsTty()) return

  out()
  for (const line of wordmark()) out(c.cyan(line))
  out()

  const brainProvider = snapshot?.llm?.brainProvider
  const brainModel = snapshot?.llm?.brainModel
  const mode = snapshot?.llm?.chatMode ?? 'single'
  const localOnly = snapshot?.llm?.localOnly === true

  const rows = []
  rows.push([
    'brain',
    brainModel
      ? `${c.bold(brainModel)}${brainProvider ? c.gray(` · ${brainProvider}`) : ''}`
      : c.yellow('not configured — wolffish settings')
  ])
  rows.push([
    'mode',
    c.gray(mode) +
      (localOnly ? c.yellow(' · local only') : '') +
      (state.verbose ? c.gray(' · verbose') : '')
  ])

  // Which transcript the next line joins. The single most consequential fact
  // about a chat, and the one a window shows for free in its title bar.
  rows.push([
    'conversation',
    state.conversationId
      ? `${state.title ?? c.gray(shortConversationId(state.conversationId))}`
      : c.gray('new')
  ])

  const channels = (status?.channels ?? []).filter((ch) => ch.connected)
  if (channels.length > 0) {
    rows.push(['channels', c.green(channels.map((ch) => ch.label ?? ch.id).join(', '))])
  }

  rows.push([
    'daemon',
    `${c.green('running')}${status?.cli?.pid ? c.gray(` · pid ${status.cli.pid}`) : ''}` +
      (status?.headless ? c.gray(' · headless') : '') +
      (version ? c.gray(` · v${version}`) : '')
  ])

  keyValue(rows, { indent: 2 })

  // A turn already in flight somewhere else is the one piece of state that
  // makes the prompt lie — you would type into a conversation the agent is
  // mid-answer on and wonder why it queued.
  const runs = (status?.activeRuns ?? []).filter((run) => run.conversationId)
  if (runs.length > 0) {
    out()
    for (const run of runs) {
      out(
        c.gray(`  ${icon.dot()} ${run.channel ?? 'a surface'} is answering — `) +
          c.gray(run.title ?? shortConversationId(run.conversationId))
      )
    }
  }

  out()
  out(c.gray('  /help  commands      /settings  configure      /conversations  past chats'))
  // Only promised where the composer actually runs — under the launcher's
  // cooked pipe there are no keystrokes to read, so the promise would be false.
  if (process.stdin.isTTY === true) {
    out(c.gray('  Shift+Enter starts a new line · pasting multi-line text is safe — Enter sends'))
  }
  out(c.gray('  Ctrl-C stops a turn · Ctrl-D leaves · the agent keeps running without you'))
  out()
}

/**
 * One slash command.
 *
 * It no longer takes the readline: every prompt it can reach borrows the
 * session's own reader through `setLineReader`, so there is nothing here to
 * pause, resume, or hand around.
 */
async function handleSlash(client, state, input) {
  const [command, ...args] = input.slice(1).split(/\s+/)

  switch (command) {
    case 'help':
    case '?': {
      heading('Commands')
      // Rendered by hand rather than through `table`, because the groups are
      // the point: a flat 20-row grid is the thing this replaced.
      const width = Math.max(...SLASH_HELP.filter(([, d]) => d).map(([cmd]) => cmd.length))
      for (const [cmd, description] of SLASH_HELP) {
        if (!description) {
          out()
          out('  ' + c.gray(cmd))
          continue
        }
        out(`    ${c.cyan(pad(cmd, width))}  ${c.gray(description)}`)
      }
      out()
      return null
    }

    case 'exit':
    case 'quit':
      out(c.gray('  detached — the agent keeps running'))
      return 'exit'

    case 'new':
      state.conversationId = null
      state.title = null
      state.pendingAttachments = []
      out(c.gray('  new conversation'))
      return 'reprompt'

    /**
     * List conversations, newest first, numbered. The numbers are what
     * `/switch` takes — a full id is 20-odd characters nobody wants to retype,
     * and an 8-char prefix still has to be read off the screen correctly.
     *
     * A bare number is still the page size, because `/conversations 50` has
     * always meant "show me fifty". Anything else is a title search: the words
     * you remember, in any order. `/conversations` with nothing clears it, so
     * the way back to the whole list is the command you already know.
     */
    case 'conversations':
    case 'conversation':
    case 'list':
    case 'ls': {
      const onlyNumber = args.length === 1 && /^\d+$/.test(args[0])
      const size = onlyNumber ? Number.parseInt(args[0], 10) : NaN
      state.pageSize = Number.isFinite(size) && size > 0 ? size : PAGE_SIZE
      state.filter = onlyNumber ? '' : args.join(' ').trim()
      state.listing = []
      return printPage(client, state, 0)
    }

    /** Next page, continuing the numbering so earlier picks stay valid. */
    case 'more':
    case 'm':
      if (state.listing.length === 0) {
        out(c.gray('  nothing listed yet — /conversations first'))
        return null
      }
      return printPage(client, state, state.listing.length)

    /** Select by the number the listing printed, or by an id prefix. */
    /**
     * Read ANY past conversation without moving into it.
     *
     * `/show` covers the one you are in; the only way to read another was
     * `/switch` — which re-points the session, clears staged attachments, and
     * means the next thing you type appends to a conversation you opened to
     * READ. That is a real state change for a glance, and on a terminal-only
     * install it is the only way to look something up mid-task.
     *
     * Deliberately a second verb rather than an overload of `/show`: `/show 3`
     * already means "the last three turns of this conversation", and making
     * the same number sometimes mean "row 3 of the listing" would be a coin
     * flip on every use. `/read` takes what `/switch` takes — a row number or
     * an id — and the two read as the pair they are.
     */
    case 'read':
    case 'peek': {
      const target = args[0]
      if (!target) {
        out(c.red('  usage: /read <number|id> [tools|clean] [n]'))
        out(c.gray('  numbers come from /conversations · reads without switching'))
        return null
      }
      let id = null
      const index = Number.parseInt(target, 10)
      if (Number.isFinite(index) && String(index) === target) {
        const row = state.listing[index - 1]
        if (!row) {
          out(c.red(`  no conversation ${index} — run /conversations first`))
          return null
        }
        id = row.id
      } else {
        id = await resolveConversationId(client, target)
        if (!id) {
          out(c.red(`  no conversation matching "${target}"`))
          return null
        }
      }
      let verbose = state.verbose
      let last = null
      for (const arg of args.slice(1)) {
        const word = String(arg).toLowerCase()
        if (word === 'tools' || word === 'verbose' || word === 'full') verbose = true
        else if (word === 'clean' || word === 'quiet' || word === 'plain') verbose = false
        else if (/^\d+$/.test(word)) last = Number.parseInt(word, 10)
      }
      await showConversation(client, id, { verbose, last, showTools: '/show tools' })
      // Say plainly that nothing moved — otherwise the transcript on screen
      // reads exactly like the one /switch would have left there.
      out(
        c.gray(
          `  ${icon.dot()} read-only — you are still in ${state.title ? truncate(state.title, 40) : 'this conversation'} · /switch ${target} to move`
        )
      )
      return null
    }

    case 'switch':
    case 'use': {
      const arg = args[0]
      if (!arg) {
        out(c.red('  usage: /switch <number|id>'))
        return null
      }
      const index = Number.parseInt(arg, 10)
      let picked = null
      if (Number.isFinite(index) && String(index) === arg) {
        picked = state.listing[index - 1] ?? null
        if (!picked) {
          out(c.red(`  no conversation ${index} — run /conversations first`))
          return null
        }
      } else {
        const id = await resolveConversationId(client, arg)
        if (!id) {
          out(c.red(`  no conversation matching "${arg}"`))
          return null
        }
        picked = { id, title: await titleOf(client, id) }
      }
      state.conversationId = picked.id
      state.title = picked.title ?? null
      state.pendingAttachments = []
      await printConversationSummary(client, picked.id)
      return 'reprompt'
    }

    case 'attach': {
      if (args.length === 0) {
        out(c.red('  usage: /attach <path…>'))
        return null
      }
      for (const raw of args) {
        const resolved = expandPath(raw)
        try {
          const stat = await fs.stat(resolved)
          if (!stat.isFile()) {
            out(c.red(`  not a file: ${raw}`))
            continue
          }
          state.pendingAttachments.push(resolved)
          out(`  ${icon.ok()} ${basename(resolved)}`)
        } catch {
          out(c.red(`  not found: ${raw}`))
        }
      }
      return null
    }

    case 'files': {
      if (state.files.length === 0) {
        out(c.gray('  nothing delivered yet'))
        return null
      }
      table(
        ['#', 'file', 'path'],
        state.files.map((file, i) => [String(i + 1), basename(file.path), c.gray(file.path)])
      )
      return null
    }

    case 'open': {
      const index = Number.parseInt(args[0] ?? '', 10) - 1
      const file = state.files[index]
      if (!file) {
        out(c.red('  usage: /open <n> — see /files'))
        return null
      }
      openWithOs(file.path)
      return null
    }

    case 'save': {
      const index = Number.parseInt(args[0] ?? '', 10) - 1
      const file = state.files[index]
      const dest = args[1]
      if (!file || !dest) {
        out(c.red('  usage: /save <n> <destination>'))
        return null
      }
      const target = expandPath(dest)
      const finalPath = (await isDirectory(target))
        ? path.join(target, basename(file.path))
        : target
      await fs.copyFile(file.path, finalPath)
      out(`  ${icon.ok()} ${finalPath}`)
      return null
    }

    case 'verbose': {
      const value = args[0]
      if (value !== 'on' && value !== 'off') {
        out(c.gray(`  verbose is ${state.verbose ? 'on' : 'off'} — /verbose on|off`))
        return null
      }
      state.verbose = value === 'on'
      await client.invoke('cli:setConfig', { verbose: state.verbose }).catch(() => undefined)
      out(c.gray(`  verbose ${value}`))
      return null
    }

    case 'mode': {
      const value = args[0]
      if (value !== 'single' && value !== 'workflow') {
        out(c.red('  usage: /mode single|workflow'))
        return null
      }
      await setSetting(client, 'model.mode', value)
      return null
    }

    case 'model': {
      const snapshot = await client.invoke('cli:snapshot').catch(() => ({}))
      if (args.length === 0) {
        out(c.gray(`  ${snapshot?.llm?.brainProvider ?? '—'}/${snapshot?.llm?.brainModel ?? '—'}`))
        out(c.gray('  /model <provider> <model> to switch'))
        return null
      }
      const [providerId, model] = args
      if (!providerId || !model) {
        out(c.red('  usage: /model <provider> <model>'))
        return null
      }
      await client.invoke('provider:setBrain', { providerId, model })
      out(`  ${icon.ok()} ${providerId}/${model}`)
      return null
    }

    /**
     * The app's other screens, in the session. Same functions the top-level
     * `wolffish projects` / `procedures` / `automations` / `customizations`
     * run —
     * one implementation, reachable from wherever you happen to be.
     */
    case 'projects':
    case 'project':
      await projects(client, args)
      return null

    case 'procedures':
    case 'procedure':
      // A run streams a turn; the session adopts the conversation it created,
      // so the prompt above the input names what you are now talking to.
      await procedures(client, args, {
        verbose: state.verbose,
        onRun: async (conversationId) => {
          state.conversationId = conversationId
          state.title = await titleOf(client, conversationId)
        }
      })
      return 'reprompt'

    case 'automations':
    case 'automation':
      await automations(client, args)
      return null

    case 'customizations':
    case 'customization':
    case 'documents':
    case 'docs':
      await customizations(client, args)
      return null

    case 'soul':
    case 'user':
    case 'agents':
      await customizations(client, [command])
      return null

    /**
     * The workspace, from inside a session. `/files` already means "what has
     * this session delivered", which is a different and more frequent
     * question — so the tree gets its own word rather than overloading that one.
     */
    case 'workspace':
    case 'ws':
      await browseFiles(client, args[0])
      return null

    case 'view':
    case 'cat':
      if (!args[0]) {
        out(c.red('  usage: /view <workspace path>'))
        return null
      }
      await viewFile(client, args.join(' '))
      return null

    case 'edit':
      if (!args[0]) {
        out(c.red('  usage: /edit <workspace path>'))
        return null
      }
      await editWorkspaceFile(client, args.join(' '))
      return null

    /**
     * No pause: the browser's prompts come through THIS readline (see
     * `setLineReader` above), so pausing it would stop the very input it is
     * waiting on. The `rl.question` callback takes the next line before the
     * session loop's iterator can see it, which is what keeps a keystroke
     * meant for a menu out of the chat.
     */
    case 'settings':
    case 'setting':
      if (args[0] === 'list' || args[0] === 'all') {
        await listAllSettings(client, { group: args[1] })
        return null
      }
      await settingsBrowser(client, args)
      return null

    case 'config':
      await listAllSettings(client, { group: args[0] })
      return null

    case 'set': {
      const [id, ...valueParts] = args
      if (!id || valueParts.length === 0) {
        out(c.red('  usage: /set <id> <value>'))
        return null
      }
      await setSetting(client, id, valueParts.join(' '))
      return null
    }

    case 'info':
    case 'about': {
      if (!state.conversationId) {
        out(c.gray('  no conversation yet — send a message or /switch to one'))
        return null
      }
      await printConversationSummary(client, state.conversationId)
      return null
    }

    case 'status': {
      const { status } = await import('./service.mjs')
      await status(client, {})
      return null
    }

    case 'cancel':
      await client.invoke('cli:cancel', state.conversationId).catch(() => undefined)
      out(c.gray('  cancel requested'))
      return null

    /**
     * Read this conversation back — the whole thing, or its tail, with or
     * without the tool calls.
     *
     * `/show` follows the session's own verbosity, so it matches the feed you
     * have been watching. `/show tools` and `/show clean` override it for this
     * reading alone, which is the thing the stored setting could not express:
     * you want the tool calls for the ONE turn that went wrong, not forever.
     * A number takes the last n turns, because that is almost always the
     * question — and it is paged either way, so a long history stops at a
     * screenful instead of scrolling off the top.
     */
    case 'show':
    case 'transcript': {
      if (!state.conversationId) {
        out(c.gray('  nothing yet — send a message first'))
        return null
      }
      let verbose = state.verbose
      let last = null
      for (const arg of args) {
        const word = String(arg).toLowerCase()
        if (word === 'tools' || word === 'verbose' || word === 'full') verbose = true
        else if (word === 'clean' || word === 'quiet' || word === 'plain') verbose = false
        else if (/^\d+$/.test(word)) last = Number.parseInt(word, 10)
        else {
          out(c.red(`  "${arg}"?`))
          out(c.gray('  /show [tools|clean] [n]   e.g. /show tools 3'))
          return null
        }
      }
      await showConversation(client, state.conversationId, {
        verbose,
        last,
        // In a session the way to see them is a slash command, not a flag.
        showTools: '/show tools'
      })
      return null
    }

    /**
     * The four things a session could reach only by leaving it.
     *
     * On a headless box the session IS the app, so "quit, run a command, come
     * back" is not a small ask — it drops the conversation you were in. Each
     * of these is the same function the top-level verb runs.
     */
    /**
     * Answer what an earlier session walked away from.
     *
     * An approval outstanding when a client disappears PARKS rather than
     * failing closed — the right call, but it left the turn frozen with no
     * route back to the question. This redraws the parked card and answers it.
     */
    case 'pending': {
      const rows = await client.invoke('cli:pendingRequests').catch(() => [])
      const list = Array.isArray(rows) ? rows : (rows?.requests ?? [])
      if (list.length === 0) {
        out(c.gray('  nothing is waiting'))
        return null
      }
      for (const row of list) {
        if (!row?.frame) continue
        await answerParked(client, row)
      }
      return null
    }

    case 'diagnose':
    case 'diagnostics':
      if (!state.conversationId) {
        out(c.gray('  nothing to bundle yet — say something first'))
        return null
      }
      await exportDiagnostics(client, state.conversationId)
      return null

    case 'pair':
      await pair(client, args)
      return null

    case 'usage':
      await usage(client, args[0] ?? 'this_month', {})
      return null

    case 'logs':
      await service(client, ['logs', ...args])
      return null

    case 'resume': {
      if (args[0]) {
        const resolved = await resolveConversationId(client, args[0])
        if (!resolved) {
          out(c.red(`  no conversation matching "${args[0]}"`))
          return null
        }
        state.conversationId = resolved
        state.title = await titleOf(client, resolved)
        await printConversationSummary(client, resolved)
        return 'reprompt'
      }
      const conversations = (await client.invoke('conversation:list')).slice(0, 15)
      if (conversations.length === 0) {
        out(c.gray('  no past conversations'))
        return null
      }
      conversations.forEach((conv, i) => {
        out(
          `  ${c.cyan(String(i + 1).padStart(2))}. ${String(conv.title ?? 'Untitled').slice(0, 56)} ${c.gray(conv.channel ?? '')}`
        )
      })
      const pick = (await question(`  ${c.dim('number, or blank to cancel')}: `)).trim()
      const index = Number.parseInt(pick, 10) - 1
      if (!Number.isFinite(index) || !conversations[index]) return null
      state.conversationId = conversations[index].id
      state.title = conversations[index].title ?? null
      await printConversationSummary(client, conversations[index].id)
      return 'reprompt'
    }

    default:
      out(c.red(`  unknown command: /${command}`))
      out(c.gray('  /help for the list'))
      return null
  }
}

/**
 * Print one page and append it to the running listing.
 *
 * Fetches the whole index each time rather than paging server-side: the list
 * is a single indexed query the app already makes for its own sidebar, and
 * re-reading it means a conversation created since the last page (by the app,
 * a channel, an automation) shows up rather than being missed by a stale
 * offset.
 */
async function printPage(client, state, offset) {
  const everything = await client.invoke('conversation:list')
  if (everything.length === 0) {
    out(c.gray('  no conversations yet'))
    return null
  }
  const all = filterConversationsByTitle(everything, state.filter)
  if (all.length === 0) {
    out(c.gray(`  nothing matches "${state.filter}" · /conversations for all ${everything.length}`))
    return null
  }
  const rows = all.slice(offset, offset + state.pageSize)
  if (rows.length === 0) {
    out(c.gray(`  that's all ${all.length}`))
    return null
  }
  state.listing = all.slice(0, offset + rows.length)

  out()
  rows.forEach((conv, i) => {
    const n = offset + i + 1
    // The bullet marks where you are, so the listing doubles as "which one am I in?"
    const marker = conv.id === state.conversationId ? c.green(g.current) : ' '
    const badge = conv.channel && conv.channel !== 'electron' ? c.gray(` ${conv.channel}`) : ''
    out(
      `  ${marker} ${c.cyan(String(n).padStart(3))}. ` +
        `${truncate(conv.title ?? 'Untitled', 46).padEnd(46)}` +
        `${c.gray(relativeTime(conv.updatedAt))}${badge}`
    )
  })
  out()

  const shown = state.listing.length
  const more = all.length - shown
  out(
    c.gray(`  ${offset + 1}-${shown} of ${all.length}`) +
      // Say WHICH list the count is of — an unannounced 4-of-4 after a search
      // reads as "you only have four conversations".
      (state.filter ? c.gray(` matching "${state.filter}"`) : '') +
      (more > 0 ? c.gray(` · /more for ${Math.min(more, state.pageSize)} more`) : '') +
      // Both verbs, because the numbers are the affordance and a bare number
      // typed here is a MESSAGE — the list has to say what to prefix it with,
      // and reading is the commoner intent of the two.
      c.gray(' · /read <n> to look · /switch <n> to move')
  )
  return null
}

/**
 * What you just joined: the FULL title (untruncated — the prompt above the
 * input is the abbreviated one, and this is the place to read the whole
 * thing), how much of the model's context the transcript already occupies,
 * and what it has cost so far.
 *
 * Context is the number that changes a decision. A conversation at 85% is one
 * that is about to compact, and knowing that before you type is the difference
 * between continuing here and starting fresh — the terminal's equivalent of
 * the app's context meter.
 */
async function printConversationSummary(client, conversationId) {
  const conv = await client.invoke('conversation:load', conversationId).catch(() => null)
  if (!conv) {
    out(c.gray(`  → ${shortConversationId(conversationId)}`))
    return
  }

  out()
  out('  ' + c.bold(conv.title ?? 'Untitled'))

  const rows = []
  const messages = conv.messages?.length ?? 0
  rows.push(['messages', String(messages)])

  const meter = conv.stats?.meter ?? conv.contextMeter ?? null
  if (meter?.contextTokens && meter?.contextBudget) {
    const pct = Math.round((meter.contextTokens / meter.contextBudget) * 100)
    // Tint the number itself: past ~75% the next turn may compact, and that is
    // worth noticing without reading the percentage.
    const tint = pct >= 90 ? c.red : pct >= 75 ? c.yellow : c.gray
    rows.push([
      'context',
      `${formatTokens(meter.contextTokens)} / ${formatTokens(meter.contextBudget)} ${tint(`(${pct}%)`)}`
    ])
  }

  const all = conv.stats?.allTime
  if (all) {
    if (all.inputTokens || all.outputTokens) {
      rows.push([
        'tokens',
        `${formatTokens(all.inputTokens)} in · ${formatTokens(all.outputTokens)} out` +
          (all.cacheReadTokens ? c.gray(` · ${formatTokens(all.cacheReadTokens)} cached`) : '')
      ])
    }
    if (all.turns) rows.push(['turns', String(all.turns)])
    if (all.cost) rows.push(['cost', `$${Number(all.cost).toFixed(4)}`])
  }

  if (conv.model) rows.push(['model', conv.model])
  if (conv.channel && conv.channel !== 'electron') rows.push(['started in', conv.channel])
  rows.push(['updated', relativeTime(conv.updatedAt)])
  rows.push(['id', conv.id])

  keyValue(rows, { indent: 2 })
  out()
}

/** Compact token counts — 12.4k reads faster than 12400 at a glance. */
function formatTokens(n) {
  const value = Number(n)
  if (!Number.isFinite(value)) return '—'
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/** One line's worth of a title, with an ellipsis rather than a hard cut. */
function truncate(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : value.slice(0, max - 1) + '…'
}

/**
 * A conversation's stored title. Read from the index rather than the file:
 * the list is a single indexed query, and the title is the only field needed.
 * Null on any failure — the caller falls back to the id, which always exists.
 */
async function titleOf(client, conversationId) {
  try {
    const all = await client.invoke('conversation:list')
    const found = all.find((conv) => conv.id === conversationId)
    const title = found?.title
    return title && title !== 'Untitled' ? title : null
  } catch {
    return null
  }
}

function expandPath(raw) {
  const trimmed = raw.trim()
  if (trimmed === '~') return os.homedir()
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2))
  return path.resolve(trimmed)
}

async function isDirectory(target) {
  try {
    return (await fs.stat(target)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Hand a delivered file to the desktop. On a headless box there is nothing to
 * hand it to, so say where the file is instead of failing silently — the phone
 * (or scp) is the way to actually look at it there.
 */
function openWithOs(target) {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    out(c.gray(`  no desktop session here — the file is at ${target}`))
    return
  }
  try {
    const child = spawn(opener, [target], {
      detached: true,
      stdio: 'ignore',
      shell: process.platform === 'win32'
    })
    child.unref()
    out(c.gray(`  opened ${basename(target)}`))
  } catch {
    out(c.gray(`  could not open it — the file is at ${target}`))
  }
}

export { wrapText }
