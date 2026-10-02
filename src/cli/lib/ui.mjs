/**
 * Terminal presentation: colour, boxes, tables, spinners, prompts.
 *
 * Two rules shape everything here. Colour is opt-out (NO_COLOR, a non-TTY
 * stdout, or `--no-color`), because the CLI is expected to be piped into
 * things. And every "card" the desktop chat draws has a line-shaped
 * equivalent, so a conversation reads the same in a terminal as it does in the
 * app — the same information, the same order, without the chrome.
 */
import { stdinIsRawCapable, stdinIsTty, stdoutIsTty, terminalColumns } from './tty.mjs'
import { setConsoleEcho } from './console-ctl.mjs'
import { readMultilineRaw } from './composer.mjs'
import os from 'node:os'

const FORCE_COLOR = process.env.FORCE_COLOR === '1'
const NO_COLOR =
  process.env.NO_COLOR !== undefined ||
  process.env.TERM === 'dumb' ||
  process.argv.includes('--no-color')

let colorEnabled = FORCE_COLOR || (!NO_COLOR && stdoutIsTty())

export function setColor(enabled) {
  colorEnabled = enabled
}

/** Whether ANSI colour is actually going to be emitted. */
export function colorOn() {
  return colorEnabled === true
}

/**
 * Whether this console can draw the box-drawing, braille and geometric glyphs
 * the renderer would like to use.
 *
 * Everywhere except Windows: yes. On Windows the honest default is NO, because
 * the failure is silent and ugly — a legacy conhost running codepage 437 or
 * 850 receives Node's UTF-8 bytes and prints mojibake, and even where the
 * codepage is right a console font without braille prints boxes. Windows
 * Terminal and the VS Code terminal are the two that reliably cope, and both
 * announce themselves.
 *
 * `WOLFFISH_UNICODE=1` forces it on for a console that copes but is not
 * detected (ConEmu, a `chcp 65001` session); `=0` forces it off anywhere.
 *
 * The bias is deliberate: ASCII always renders. Mojibake never does.
 */
function detectUnicode() {
  if (process.env.WOLFFISH_UNICODE === '1') return true
  if (process.env.WOLFFISH_UNICODE === '0') return false
  if (process.platform !== 'win32') return true
  if (process.env.WT_SESSION) return true // Windows Terminal
  if (process.env.TERM_PROGRAM === 'vscode') return true
  return false
}

let unicodeEnabled = detectUnicode()

/** Re-run detection. Exists for the platform test, which fakes process.platform. */
export function detectUnicodeForTest() {
  return detectUnicode()
}

export function setUnicode(enabled) {
  unicodeEnabled = enabled
}

export function unicodeOk() {
  return unicodeEnabled
}

/**
 * Structural glyphs, with an ASCII twin for every one.
 *
 * Only the shapes that carry MEANING or hold alignment are here — a box that
 * should be a corner, a bullet that should be a bullet. Prose punctuation is
 * handled at the output chokepoint instead (see `out`), so a stray em dash in
 * a string somebody adds later cannot slip through.
 */
const GLYPHS = {
  unicode: {
    bullet: ['•', '◦', '▪'],
    hline: '─',
    boxTop: '┌',
    boxSide: '│',
    boxBottom: '└',
    quote: '▏',
    image: '▣',
    input: '▌',
    chevron: '›',
    current: '●',
    ok: '✓',
    warn: '!',
    fail: '✗',
    dot: '·',
    tool: '⏺',
    file: '◆',
    ask: '?',
    gate: '▲',
    spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  },
  ascii: {
    bullet: ['*', '-', '+'],
    hline: '-',
    boxTop: '+',
    boxSide: '|',
    boxBottom: '+',
    quote: '|',
    image: '[img]',
    input: '>',
    chevron: '>',
    current: '*',
    ok: '+',
    warn: '!',
    fail: 'x',
    dot: '-',
    tool: '>',
    file: '#',
    ask: '?',
    gate: '!',
    spinner: ['-', '\\', '|', '/']
  }
}

/** The active glyph set. Read through a getter so setUnicode takes effect. */
export const g = new Proxy(
  {},
  {
    get: (_t, key) => (unicodeEnabled ? GLYPHS.unicode : GLYPHS.ascii)[key]
  }
)

/**
 * Prose punctuation that is not in any legacy Windows codepage. Applied at the
 * one place everything is written, so no individual string has to remember.
 */
const TRANSLITERATE = [
  [/[\u2014\u2013]/g, '-'],
  [/\u2026/g, '...'],
  [/[\u2018\u2019]/g, "'"],
  [/[\u201c\u201d]/g, '"'],
  [/\u00b7/g, '-'],
  [/\u2192/g, '->'],
  [/\u203a/g, '>'],
  [/\u2039/g, '<']
]

/** Make a string safe for this console. A no-op wherever Unicode is fine. */
export function safe(text) {
  if (unicodeEnabled) return text
  let out = String(text)
  for (const [pattern, replacement] of TRANSLITERATE) out = out.replace(pattern, replacement)
  // Anything still outside Latin-1 would print as a box; a question mark at
  // least keeps the column count honest.
  // eslint-disable-next-line no-control-regex
  return out.replace(/[^\x00-\xff]/g, '?')
}

const CODES = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
}

function wrap(code, text) {
  if (!colorEnabled) return text
  return `${code}${text}${CODES.reset}`
}

export const c = {
  bold: (t) => wrap(CODES.bold, t),
  dim: (t) => wrap(CODES.dim, t),
  italic: (t) => wrap(CODES.italic, t),
  red: (t) => wrap(CODES.red, t),
  green: (t) => wrap(CODES.green, t),
  yellow: (t) => wrap(CODES.yellow, t),
  blue: (t) => wrap(CODES.blue, t),
  magenta: (t) => wrap(CODES.magenta, t),
  cyan: (t) => wrap(CODES.cyan, t),
  gray: (t) => wrap(CODES.gray, t)
}

export function width() {
  return Math.max(40, Math.min(terminalColumns() || 100, 120))
}

/**
 * The terminal as it actually is — no clamping.
 *
 * `width()` clamps to 40–120 because prose wants a readable measure whatever
 * the window is doing. Anything that has to FIT rather than wrap needs the
 * real numbers: a QR asked to draw itself in a 30-column window must know it
 * has 30, not the 40 the prose clamp would report, and rows matter as much as
 * columns because a code that scrolls is a code that cannot be scanned.
 */
export function terminalSize() {
  return {
    columns: terminalColumns() || 80,
    // LINES, like COLUMNS, is the Windows launcher reporting a console this
    // process cannot measure for itself.
    rows: process.stdout.rows || Number.parseInt(process.env.LINES ?? '', 10) || 24
  }
}

export function out(text = '') {
  process.stdout.write(safe(text) + '\n')
}

/**
 * Run something that PRINTS, and get its output as lines instead.
 *
 * Patched at `process.stdout.write` rather than at `out()`, because the
 * markdown stream deliberately bypasses `out()` to place its own newlines —
 * capturing one level up is the only place that sees everything a renderer
 * emits. Restored in a finally, so a throw inside the callback cannot leave
 * the terminal writing into an array.
 *
 * Exists so a transcript can be paged. The renderers write as they go (that is
 * what makes streaming possible), which left every "show me this conversation"
 * path dumping an unbounded wall of text past the top of the window.
 */
export function captureOutput(run) {
  const chunks = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
    return true
  }
  try {
    run()
  } finally {
    process.stdout.write = original
  }
  const text = chunks.join('')
  // A trailing newline would otherwise become a phantom blank final line.
  return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
}

export function err(text = '') {
  process.stderr.write(safe(text) + '\n')
}

/**
 * Visible length — in terminal COLUMNS, not JavaScript string units.
 *
 * `.length` counts UTF-16 code units, which is wrong in both directions and
 * for most of the world's text. An emoji or a rarer CJK ideograph is a
 * surrogate pair, so it counts 2 and occupies 2 — right by accident. But a
 * common CJK or Hangul character counts 1 and occupies 2, so an Arabic,
 * Chinese or Japanese table drifted a column per character until the borders
 * no longer lined up with anything; and a combining accent counts 1 and
 * occupies 0, drifting the other way.
 *
 * The ranges below are the East Asian Wide/Fullwidth blocks and the emoji
 * planes — the ones that are double-width in every terminal — plus zero for
 * combining marks and variation selectors. Not a full UAX #11 implementation,
 * which would be a table the size of this file; this covers what actually
 * appears in a chat.
 */
export function visibleLength(text) {
  // eslint-disable-next-line no-control-regex
  const plain = String(text).replace(/\x1b\[[0-9;]*m/g, '')
  let columns = 0
  for (const char of plain) {
    const code = char.codePointAt(0)
    // Combining marks, zero-width joiners and variation selectors take no room.
    if (
      (code >= 0x0300 && code <= 0x036f) ||
      (code >= 0x0483 && code <= 0x0489) ||
      (code >= 0x064b && code <= 0x065f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0xfe00 && code <= 0xfe0f) ||
      (code >= 0xfe20 && code <= 0xfe2f)
    ) {
      continue
    }
    columns += isWide(code) ? 2 : 1
  }
  return columns
}

function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303e) || // CJK radicals, Kangxi, punctuation
    (code >= 0x3041 && code <= 0x33ff) || // Hiragana … CJK compatibility
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0xa000 && code <= 0xa4cf) || // Yi
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xfe30 && code <= 0xfe6f) || // CJK compatibility forms
    (code >= 0xff00 && code <= 0xff60) || // Fullwidth forms
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) || // emoji
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd) // CJK Extension B and beyond
  )
}

export function pad(text, size) {
  const gap = size - visibleLength(text)
  return gap > 0 ? text + ' '.repeat(gap) : text
}

/** Wrap prose to the terminal, honouring an indent on continuation lines. */
export function wrapText(text, indent = 0, max = width()) {
  const limit = Math.max(20, max - indent)
  const prefix = ' '.repeat(indent)
  const lines = []
  for (const paragraph of String(text).split('\n')) {
    if (paragraph.trim().length === 0) {
      lines.push('')
      continue
    }
    let current = ''
    for (const word of paragraph.split(/\s+/)) {
      if (current.length === 0) current = word
      else if (current.length + 1 + word.length <= limit) current += ' ' + word
      else {
        lines.push(prefix + current)
        current = word
      }
    }
    if (current) lines.push(prefix + current)
  }
  return lines.join('\n')
}

/**
 * The wordmark, in whichever alphabet this console can actually draw.
 *
 * Two variants because the installers already have two: install.sh prints the
 * box-drawing form, install.ps1 prints the hash form, for exactly this reason.
 * Reusing both keeps the CLI and the installer looking like one product on
 * each platform rather than one product on POSIX and mojibake on Windows.
 */
const WORDMARK_UNICODE = [
  '  \u2566 \u2566\u2554\u2550\u2557\u2566  \u2554\u2550\u2557\u2554\u2550\u2557\u2566\u2554\u2550\u2557\u2566 \u2566',
  '  \u2551\u2551\u2551\u2551 \u2551\u2551  \u2560\u2563 \u2560\u2563 \u2551\u255a\u2550\u2557\u2560\u2550\u2563',
  '  \u255a\u2569\u255d\u255a\u2550\u255d\u2569\u2550\u255d\u255a  \u255a  \u2569\u255a\u2550\u255d\u2569 \u2569'
]

const WORDMARK_ASCII = [
  '  #   # ##### #     ##### ##### ##### ##### #   #',
  '  #   # #   # #     #     #       #   #     #   #',
  '  # # # #   # #     ####  ####    #   ##### #####',
  '  ## ## #   # #     #     #       #       # #   #',
  '  #   # ##### ##### #     #     ##### ##### #   #'
]

export function wordmark() {
  return unicodeEnabled ? WORDMARK_UNICODE : WORDMARK_ASCII
}

export function heading(text) {
  out()
  out(c.bold(text))
  out(c.gray(g.hline.repeat(Math.min(visibleLength(text) + 8, width()))))
}

export function keyValue(rows, { indent = 2 } = {}) {
  const keyWidth = Math.max(...rows.map(([k]) => visibleLength(k)), 0)
  for (const [key, value] of rows) {
    out(' '.repeat(indent) + c.gray(pad(key, keyWidth)) + '  ' + value)
  }
}

export function table(headers, rows, { indent = 2 } = {}) {
  if (rows.length === 0) return
  const widths = headers.map((h, i) =>
    Math.max(visibleLength(h), ...rows.map((r) => visibleLength(String(r[i] ?? ''))))
  )
  out(' '.repeat(indent) + headers.map((h, i) => c.gray(pad(h, widths[i]))).join('  '))
  for (const row of rows) {
    out(' '.repeat(indent) + row.map((cell, i) => pad(String(cell ?? ''), widths[i])).join('  '))
  }
}

export function bytes(n) {
  const size = Number(n)
  if (!Number.isFinite(size)) return '—'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function relativeTime(ms) {
  const delta = Date.now() - Number(ms)
  if (!Number.isFinite(delta)) return '—'
  const minutes = Math.round(delta / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(Number(ms)).toISOString().slice(0, 10)
}

/** Shorten a path for display — `~` for home, and no runaway middles. */
export function shortPath(p) {
  if (typeof p !== 'string') return String(p ?? '')
  const home = os.homedir()
  let text = p.startsWith(home) ? '~' + p.slice(home.length) : p
  const max = Math.max(30, width() - 30)
  if (text.length > max) {
    const tail = text.slice(-(max - 4))
    text = '…/' + tail.replace(/^[^/\\]*[/\\]/, '')
  }
  return text
}

/** A spinner that quietly does nothing when stdout isn't a terminal. */
export function spinner(label) {
  const frames = g.spinner
  if (!stdoutIsTty()) {
    // Piped or redirected: a spinner would write thousands of carriage
    // returns into the captured output. The no-op keeps every call site free
    // of `if (isTTY)` branches.
    const noop = () => undefined
    return { update: noop, stop: noop }
  }
  let index = 0
  let text = label
  const tick = () => {
    process.stdout.write(`\r${c.cyan(frames[index++ % frames.length])} ${c.dim(safe(text))}\x1b[K`)
  }
  const timer = setInterval(tick, 80)
  timer.unref?.()
  tick()
  return {
    update(next) {
      text = next
    },
    stop() {
      clearInterval(timer)
      process.stdout.write('\r\x1b[K')
    }
  }
}

/**
 * Whoever owns stdin right now.
 *
 * The REPL creates a readline in terminal mode, which puts the TTY into RAW
 * mode and keeps its own listener on stdin — and `rl.pause()` undoes neither.
 * A nested prompt that reads stdin directly under those conditions is broken
 * two ways at once: Enter arrives as `\r` rather than `\n` (so the read never
 * completes), and readline buffers the same keystrokes as lines, replaying
 * them as chat input the moment the nested prompt returns. That second one is
 * not theoretical — it sent real messages to a live agent.
 *
 * So the REPL registers its readline here and every nested prompt borrows it.
 * One consumer, one line discipline.
 */
let owner = null

export function setLineReader(readline) {
  owner = readline
}

/** True when someone can actually answer a prompt. */
export function interactive() {
  return owner !== null || stdinIsTty()
}

/**
 * A command, spelled the way THIS surface spells it.
 *
 * The same listing is printed by `wolffish projects` and by `/projects`, and
 * its footer has to tell you what to type next. "wolffish projects edit <id>"
 * is wrong advice inside a session — there is no shell there — and "/projects
 * edit <id>" is wrong advice at a shell prompt. The line reader is the tell:
 * if one is registered, a session is reading.
 */
export function cmd(rest) {
  return owner ? `/${rest}` : `wolffish ${rest}`
}

/**
 * Give the terminal away for a moment — to `$EDITOR`, or anything else that
 * takes over the screen — and take it back afterwards.
 *
 * A full-screen editor sets its own termios. Spawning one while readline holds
 * the TTY in raw mode leaves the two disagreeing about who owns the keyboard,
 * and what comes back is a prompt that echoes nothing or doubles every
 * keystroke. Standing readline down first, and restoring raw mode after, is
 * the whole of the handover.
 */
export async function handOverTerminal(run) {
  // Raw-capable, not merely interactive: under the Windows launcher stdin is a
  // pipe, so there is no termios to hand over and setRawMode would throw.
  const raw = stdinIsRawCapable()
  // The composer's terminal modes (bracketed paste, kitty keys) are part of
  // the handover too: nano must not receive key encodings it never asked for.
  owner?.suspendInput?.()
  owner?.pause()
  if (raw) process.stdin.setRawMode(false)
  try {
    return await run()
  } finally {
    if (raw && owner) process.stdin.setRawMode(true)
    owner?.resume()
    owner?.resumeInput?.()
    owner?.prompt?.(true)
  }
}

/**
 * What to say while a call is in flight.
 *
 * Plain words, not the channel name. A spinner reading "describe settings" is
 * this code's vocabulary leaking onto the screen — the reader is waiting for a
 * menu, so it says menu. Anything not named here is just "Loading…", which is
 * always true; a wrong specific label is worse than a right vague one.
 */
const PROGRESS_LABELS = {
  'cli:describeSettings': 'Loading menu',
  'cli:settingGroups': 'Loading menu',
  'cli:setSetting': 'Saving',
  'usage:getSummary': 'Loading usage',
  'usage:getStats': 'Loading usage',
  'data:getAnalytics': 'Reading disk usage',
  'updater:check': 'Checking for updates',
  'conversation:list': 'Loading conversations',
  'conversation:load': 'Loading conversation'
}

const progressLabel = (channel) => `${PROGRESS_LABELS[channel] ?? 'Loading'}...`

/**
 * How long a call may take before it is worth saying so. Below this the
 * spinner would be a flash of noise on every keystroke — most of these calls
 * are a local socket round-trip and land in single-digit milliseconds.
 */
const PROGRESS_AFTER_MS = 150

/**
 * The daemon client, with a spinner on every call that takes long enough to
 * notice.
 *
 * The terminal already does this for a running turn; the rest of the CLI did
 * not, so a settings page backed by a slow service (a Google account list, an
 * extension probe, a usage query over a long ledger) printed nothing at all
 * and read as a hang. Turns keep their OWN spinner — they get the raw client —
 * because theirs names the tool, which is better than naming the channel.
 */
export function withProgress(client) {
  return {
    get hello() {
      return client.hello
    },
    invoke: (channel, ...args) => {
      let working = null
      const timer = setTimeout(() => {
        working = spinner(progressLabel(channel))
      }, PROGRESS_AFTER_MS)
      const done = () => {
        clearTimeout(timer)
        working?.stop()
      }
      return client.invoke(channel, ...args).then(
        (value) => {
          done()
          return value
        },
        (error) => {
          done()
          throw error
        }
      )
    },
    onTurn: (listener) => client.onTurn(listener),
    onEvent: (listener) => client.onEvent(listener),
    close: () => client.close()
  }
}

/** Read one line, with the prompt on stderr so stdout stays pipeable. */
export async function question(prompt, { hidden = false } = {}) {
  // Borrowed readline: it already owns the terminal, its own history and its
  // own echo.
  if (owner && !hidden) {
    return new Promise((resolve) => {
      owner.question(safe(prompt), (answer) => resolve(answer))
    })
  }
  // A hidden prompt inside a session MUST also go through the borrowed reader.
  //
  // The obvious alternative — pause readline and read the raw stream — does not
  // work, and failed silently in the worst possible place. `rl.pause()` pauses
  // the input stream but leaves readline's keypress listener attached, and the
  // raw path then calls `stdin.resume()`, which puts the stream back in flowing
  // mode and hands every keystroke straight back to readline. Measured, typing
  // a bot token into `/settings → Telegram → Enter the bot token` printed
  // `bot token (hidden): CANARYTOKEN99` in clear.
  //
  // The reader owns the echo, so the reader is the only thing that can suppress
  // it: `hidden` is passed through and the REPL mutes its own writer for the
  // duration. See setLineReader in repl.mjs.
  if (owner && hidden) {
    return new Promise((resolve) => {
      owner.question(safe(prompt), (answer) => resolve(answer), { hidden: true })
    })
  }
  // Masking without raw mode: under the Windows launcher stdin is a pipe and
  // the CONSOLE is echoing, so ask the launcher to stop. Awaited before the
  // prompt is printed — echo has to be off BEFORE the first keystroke, not
  // shortly after it.
  let consoleMasked = false
  if (hidden && !stdinIsRawCapable()) consoleMasked = await setConsoleEcho(false)

  return new Promise((resolve) => {
    const stdin = process.stdin
    owner?.pause()
    // Neither masking route available: say so rather than quietly echoing a
    // secret into the scrollback, which is the one outcome this prompt exists
    // to prevent.
    if (hidden && !stdinIsRawCapable() && !consoleMasked) {
      process.stderr.write(`\n${c.yellow('(input will be visible in this terminal)')}\n`)
    }
    process.stderr.write(safe(prompt))
    if (hidden && stdinIsRawCapable()) {
      // Raw mode so nothing echoes — used for API keys and bot tokens, which
      // must not end up in a scrollback buffer or a screen recording.
      stdin.setRawMode(true)
      let value = ''
      const onData = (chunk) => {
        const char = chunk.toString('utf8')
        if (char === '\r' || char === '\n' || char === '\x04') {
          stdin.setRawMode(false)
          stdin.removeListener('data', onData)
          stdin.pause()
          process.stderr.write('\n')
          owner?.resume()
          resolve(value)
          return
        }
        if (char === '\x03') {
          stdin.setRawMode(false)
          process.stderr.write('\n')
          process.exit(130)
        }
        if (char === '\x7f' || char === '\b') {
          value = value.slice(0, -1)
          return
        }
        value += char
      }
      stdin.resume()
      stdin.on('data', onData)
      return
    }
    let buffer = ''
    const onData = (chunk) => {
      buffer += chunk.toString('utf8')
      // EITHER terminator. A cooked terminal sends `\n`; a terminal left in
      // raw mode by something else sends a bare `\r`, and waiting only for
      // `\n` there is a prompt that never returns — which is exactly how this
      // hung inside the REPL.
      const index = buffer.search(/[\r\n]/)
      if (index < 0) return
      stdin.removeListener('data', onData)
      stdin.pause()
      if (consoleMasked) {
        // The Enter was never echoed either, so the cursor is still sitting
        // after the prompt.
        void setConsoleEcho(true)
        process.stderr.write('\n')
      }
      owner?.resume()
      resolve(buffer.slice(0, index))
    }
    stdin.resume()
    stdin.on('data', onData)
  })
}

export async function confirm(prompt, fallback = false) {
  if (!stdinIsTty()) return fallback
  const answer = (await question(`${prompt} ${c.dim(fallback ? '[Y/n]' : '[y/N]')} `))
    .trim()
    .toLowerCase()
  if (answer === '') return fallback
  return answer === 'y' || answer === 'yes'
}

/**
 * What to tell someone before a multi-line prompt opens, for the input this
 * terminal actually has. Raw terminals get the composer (Shift+Enter, safe
 * paste); the Windows launcher's cooked pipe cannot see keystrokes, so there a
 * lone `.` line is the full stop — the one convention that works over any
 * line-based input.
 */
export function multilineHint() {
  return stdinIsRawCapable()
    ? 'paste, or type — Shift+Enter (or Ctrl+J) starts a new line, Enter saves, blank cancels'
    : 'paste or type lines — finish with a single "." on its own line, a blank first line cancels'
}

/**
 * Read a whole multi-line text — a prompt, a set of instructions — as ONE
 * answer. Returns the text, or null when the user backed out.
 *
 * Four inputs, one contract:
 *  - a session on a raw terminal: the composer already makes `question()`
 *    multi-line (paste lands whole, Shift+Enter breaks lines, Enter submits);
 *  - a session on the launcher's cooked pipe: the session's reader collects
 *    lines until a lone `.` (see the multiline ask in repl.mjs);
 *  - a bare shell prompt on a raw terminal: a throwaway composer;
 *  - piped stdin: read to EOF, so `cat new-prompt.md | wolffish … paste <id>`
 *    is a one-liner.
 */
export async function questionMultiline(prompt) {
  const meaningful = (answer) =>
    answer != null && String(answer).trim().length > 0 ? String(answer) : null
  if (owner && stdinIsRawCapable()) return meaningful(await question(prompt))
  if (owner) {
    return new Promise((resolve) => {
      owner.question(safe(prompt), (answer) => resolve(meaningful(answer)), { multiline: true })
    })
  }
  if (stdinIsRawCapable()) {
    return meaningful(
      await readMultilineRaw(safe(prompt), { contPrompt: () => c.gray(`${g.dot} `) })
    )
  }
  return meaningful(await readMultilineCooked(prompt))
}

/**
 * The no-composer collector: whole lines until a lone `.`, a blank first line
 * (only when someone is TYPING — a piped file legitimately starts blank), or
 * end of input. Keeps its own carry buffer across reads, because a pasted
 * block arrives as one chunk holding many lines and the single-line reader
 * above would drop everything after the first terminator.
 */
async function readMultilineCooked(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin
    const typed = stdinIsTty()
    process.stderr.write(safe(prompt))
    let buffer = ''
    const lines = []
    const finish = (value) => {
      stdin.removeListener('data', onData)
      stdin.removeListener('end', onEnd)
      stdin.pause()
      resolve(value)
    }
    const onEnd = () => {
      if (buffer.length > 0) lines.push(buffer)
      finish(lines.join('\n'))
    }
    const onData = (chunk) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const index = buffer.search(/[\r\n]/)
        if (index < 0) return
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + (buffer.slice(index, index + 2) === '\r\n' ? 2 : 1))
        if (typed && lines.length === 0 && line.trim() === '') {
          finish(null)
          return
        }
        if (line.trim() === '.') {
          finish(lines.join('\n'))
          return
        }
        lines.push(line)
      }
    }
    stdin.on('data', onData)
    stdin.on('end', onEnd)
    stdin.resume()
  })
}

export const icon = {
  ok: () => c.green(g.ok),
  warn: () => c.yellow(g.warn),
  fail: () => c.red(g.fail),
  dot: () => c.gray(g.dot),
  tool: () => c.cyan(g.tool),
  file: () => c.magenta(g.file),
  ask: () => c.yellow(g.ask),
  gate: () => c.yellow(g.gate),
  arrow: () => c.gray(g.chevron)
}
