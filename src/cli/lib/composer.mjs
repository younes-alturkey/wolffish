/**
 * Multi-line input on top of the session's own readline.
 *
 * Readline is a LINE editor: Enter submits, and a pasted newline IS an Enter.
 * That made the chat prompt unusable for anything longer than a sentence — a
 * pasted prompt fired its first line at the agent before the paste had even
 * finished, and Shift+Enter was just Enter. This module fixes both without
 * replacing readline, because readline is load-bearing here: the whole nested
 * prompt system (see setLineReader in ui.mjs) rides one reader, and a second
 * input implementation is exactly the two-readers bug this CLI already fought.
 *
 * How it works: readline in terminal mode is driven by 'keypress' events on
 * stdin. The composer takes that listener over and forwards almost everything —
 * except:
 *
 *   BRACKETED PASTE. The terminal is asked to wrap pastes in \x1b[200~ … 201~
 *   (near-universal support), and Node's own decoder names the markers
 *   `paste-start`/`paste-end` (verified on Node 22 and 24, the two runtimes
 *   this CLI ships on). Everything between them is captured and INSERTED —
 *   newlines become soft line breaks, never submissions. The whole paste is on
 *   screen when it lands, and nothing is sent until Enter.
 *
 *   SHIFT+ENTER. A plain terminal sends the same \r for Enter and Shift+Enter,
 *   so the terminal is also asked for the kitty keyboard protocol's
 *   disambiguation tier (\x1b[>1u — supported by iTerm2 3.5+, kitty, WezTerm,
 *   Ghostty, Alacritty, foot; ignored harmlessly elsewhere), which makes
 *   Shift+Enter arrive as \x1b[13;2u. Alt/Option+Enter (\x1b\r — also what
 *   Claude Code's terminal-setup binds Shift+Enter to in VS Code and iTerm2)
 *   and Ctrl+J (a bare \n in raw mode) mean the same thing everywhere, so a
 *   terminal without the protocol still has two working chords.
 *
 *   xterm's modifyOtherKeys is deliberately NOT enabled: Node's keypress
 *   decoder mis-parses its \x1b[27;2;13~ encoding into literal "13~" keystrokes
 *   (measured), so asking for it would corrupt input on the terminals that
 *   honour it.
 *
 * A soft line break "freezes" the current row: the text stays on screen exactly
 * as typed, a continuation prompt opens below, and the frozen rows join the
 * live one with real newlines when Enter finally submits. Nothing is ever
 * abbreviated — a fifty-line paste is fifty visible rows.
 *
 * Raw-capable stdin only. Under the Windows launcher stdin is a cooked pipe
 * with no keypress stream at all; the REPL covers that path separately by
 * joining same-instant line bursts (a paste) into one message.
 */
import readline from 'node:readline'

/** Ask for bracketed paste + the kitty disambiguation tier. */
const MODES_ON = '\x1b[?2004h\x1b[>1u'
/** Pop the kitty flags and stop bracketing pastes — the reverse, in reverse order. */
const MODES_OFF = '\x1b[<u\x1b[?2004l'

/**
 * If the process dies without popping the kitty flags, the user's SHELL starts
 * receiving \x1b[27u for every Escape press. One exit handler per process,
 * armed the first time any composer enables the modes; writes are synchronous
 * on a TTY during 'exit', which is what makes this reliable.
 */
let exitResetArmed = false
function armExitReset(stream) {
  if (exitResetArmed) return
  exitResetArmed = true
  process.on('exit', () => {
    try {
      if (stream.isTTY) stream.write(MODES_OFF)
    } catch {
      /* the terminal is gone — nothing to reset */
    }
  })
}

/** The Shift+Enter family: every sequence that means "new line, not send". */
function isNewlineKey(key) {
  const seq = key?.sequence ?? ''
  // kitty protocol: Enter with shift (2), ctrl (5), or both (6).
  if (seq === '\x1b[13;2u' || seq === '\x1b[13;5u' || seq === '\x1b[13;6u') return true
  // ESC+CR — Alt/Option+Enter natively, and the Shift+Enter binding
  // terminal-setup tools write into iTerm2 / VS Code / Windows Terminal.
  if (key?.name === 'return' && key.meta === true) return true
  // Ctrl+J: a bare \n where Enter is \r. Works in every raw-mode terminal.
  if (key?.name === 'enter' && key.meta !== true && key.ctrl !== true) return true
  return false
}

/**
 * Pasted text, made safe to hold in a line buffer. Newlines survive (they are
 * the point); tabs become spaces because readline's column math cannot place a
 * cursor after a tab; everything else in C0 — including any escape sequences a
 * hostile paste might carry — is stripped rather than replayed at the terminal.
 */
export function sanitizePaste(raw) {
  return (
    String(raw)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\t/g, '    ')
      // CSI/OSC sequences first (they need their ESC), then the stray C0 bytes.
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b(?:\[[0-9;?<>=]*[A-Za-z~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  )
}

/**
 * Attach the composer to a terminal-mode readline whose input is a raw-capable
 * TTY. Returns the handle the REPL drives; `detach()` restores readline's own
 * listener untouched.
 *
 * @param rl        a readline.Interface created with `terminal: true`
 * @param options.contPrompt      () => string — the continuation-row prompt
 * @param options.isBusy          () => boolean — swallow soft newlines and
 *                                flatten pastes while true (a streaming turn or
 *                                a hidden ask owns the screen then)
 * @param options.onRestorePrompt () => void — put the caller's own prompt back
 *                                after a compose finishes or is abandoned
 */
export function attachComposer(rl, { contPrompt, isBusy, onRestorePrompt } = {}) {
  const input = rl.input
  const output = rl.output
  const composeLines = []
  /** Non-null while between paste-start and paste-end. */
  let pasting = null
  /** A paste whose end marker never arrives must not leave the keyboard dead. */
  let pasteWatchdog = null
  let enabled = false

  // Readline registered exactly one keypress listener when it was constructed;
  // take whatever is there (this attaches immediately after createInterface,
  // before anything else can listen) and forward through it.
  const forwardTo = input.listeners('keypress')
  for (const listener of forwardTo) input.removeListener('keypress', listener)
  const forward = (s, key) => {
    for (const listener of forwardTo) listener(s, key)
  }

  const busy = () => isBusy?.() === true

  /**
   * Split the live line at the cursor: everything left of it freezes on screen
   * as a finished row, everything right of it becomes the new live row under a
   * continuation prompt. This is "insert a newline at the cursor", drawn with
   * readline's own paint calls so wrapped rows and wide characters stay right.
   */
  const insertNewline = () => {
    const line = typeof rl.line === 'string' ? rl.line : ''
    const cursor = Number.isFinite(rl.cursor) ? rl.cursor : line.length
    const left = line.slice(0, cursor)
    const right = line.slice(cursor)
    // Show only the frozen half, cursor parked at its end…
    rl.line = left
    rl.cursor = left.length
    rl._refreshLine()
    // …step off the row so it stays on screen exactly as typed…
    output.write('\n')
    composeLines.push(left)
    // …and open the continuation row with whatever was right of the cursor.
    rl.line = right
    rl.cursor = 0
    rl.prevRows = 0
    rl.setPrompt(contPrompt?.() ?? '')
    rl.prompt(true)
  }

  /** A finished capture: insert it wholesale, newlines as soft breaks. */
  const acceptPaste = (raw) => {
    const text = sanitizePaste(raw)
    if (!text) return
    if (busy()) {
      // The screen belongs to a streaming turn (or a hidden ask): there is no
      // way to draw rows now, so the paste lands flattened in the buffer and
      // is visible — and editable — the moment the prompt comes back.
      rl.write(text.replace(/\n+/g, ' '))
      return
    }
    const segments = text.split('\n')
    rl.write(segments[0])
    for (let i = 1; i < segments.length; i++) {
      insertNewline()
      if (segments[i]) rl.write(segments[i])
    }
  }

  const endPasteWatchdog = () => {
    if (pasteWatchdog) clearTimeout(pasteWatchdog)
    pasteWatchdog = null
  }
  const armPasteWatchdog = () => {
    endPasteWatchdog()
    // Real pastes stream without pause; two silent seconds mid-capture means
    // the end marker is never coming. Flush what arrived rather than eating
    // every keystroke from here on.
    pasteWatchdog = setTimeout(() => {
      const raw = pasting
      pasting = null
      if (raw) acceptPaste(raw)
    }, 2000)
    pasteWatchdog.unref?.()
  }

  const onKeypress = (s, key) => {
    if (pasting !== null) {
      if (key?.name === 'paste-end' || key?.sequence === '\x1b[201~') {
        endPasteWatchdog()
        const raw = pasting
        pasting = null
        acceptPaste(raw)
        return
      }
      pasting += typeof s === 'string' && s.length > 0 ? s : (key?.sequence ?? '')
      armPasteWatchdog()
      return
    }
    if (key?.name === 'paste-start' || key?.sequence === '\x1b[200~') {
      pasting = ''
      armPasteWatchdog()
      return
    }
    if (isNewlineKey(key)) {
      if (!busy()) insertNewline()
      return
    }
    forward(s, key)
  }
  input.on('keypress', onKeypress)

  return {
    /** Turn the terminal modes on. Call once the prompt is about to paint. */
    enable() {
      if (enabled || output.isTTY !== true) return
      enabled = true
      output.write(MODES_ON)
      armExitReset(output)
    },
    /** Turn them off — the session is over. */
    disable() {
      if (!enabled) return
      enabled = false
      if (output.isTTY === true) output.write(MODES_OFF)
    },
    /**
     * A full-screen program (the editor) is about to own the terminal; it must
     * not inherit kitty-mode key encodings it never asked for.
     */
    suspend() {
      if (enabled && output.isTTY === true) output.write(MODES_OFF)
    },
    resume() {
      if (enabled && output.isTTY === true) output.write(MODES_ON)
    },
    /** Frozen rows are waiting to join the live one. */
    isActive() {
      return composeLines.length > 0
    },
    /**
     * Enter arrived: join the frozen rows to the submitted line and hand back
     * the whole message. Also fixes history — readline banked only the last
     * row, which as a recalled "message" would be a fragment of what was sent.
     */
    finish(lastLine) {
      if (composeLines.length === 0) return lastLine
      const full = composeLines.join('\n') + '\n' + lastLine
      composeLines.length = 0
      onRestorePrompt?.()
      if (Array.isArray(rl.history) && rl.history[0] === lastLine) {
        const flat = full.replace(/\s*\n\s*/g, ' ').trim()
        if (flat) rl.history[0] = flat
        else rl.history.shift()
      }
      return full
    },
    /** Ctrl-C mid-compose: drop the whole draft and start clean. */
    abandon() {
      const had = composeLines.length
      composeLines.length = 0
      pasting = null
      endPasteWatchdog()
      // The draft includes the LIVE row. Leaving its text in readline's buffer
      // spliced it into the next thing typed — measured: "/help" submitted as
      // "/helpBBBROW" after a discarded compose, which turned the command into
      // a chat message.
      rl.line = ''
      rl.cursor = 0
      onRestorePrompt?.()
      return had
    },
    /** Put readline's own listener back exactly as it was. */
    detach() {
      endPasteWatchdog()
      input.removeListener('keypress', onKeypress)
      for (const listener of forwardTo) input.on('keypress', listener)
    }
  }
}

/**
 * One multi-line read OUTSIDE a session — `wolffish procedures paste <id>` at a
 * plain shell prompt. Borrows nothing (there is nothing to borrow); builds a
 * throwaway terminal readline, composes on it, and puts everything back.
 *
 * Returns the text, or null when the user backed out (Ctrl-C, Ctrl-D, or an
 * immediate empty Enter).
 */
export async function readMultilineRaw(promptText, { contPrompt } = {}) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 0,
    prompt: promptText
  })
  const composer = attachComposer(rl, {
    contPrompt: contPrompt ?? (() => ''),
    isBusy: () => false,
    onRestorePrompt: () => {}
  })
  composer.enable()
  try {
    return await new Promise((resolve) => {
      rl.on('line', (line) => resolve(composer.finish(line)))
      rl.on('close', () => resolve(null))
      rl.on('SIGINT', () => {
        composer.abandon()
        process.stdout.write('\n')
        resolve(null)
      })
      rl.prompt()
    })
  } finally {
    composer.disable()
    composer.detach()
    rl.close()
  }
}
