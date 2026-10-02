/**
 * Is there a terminal on the other end, and how wide is it?
 *
 * Everywhere but packaged Windows this is just `process.stdout.isTTY`, and
 * these helpers answer exactly that. Windows is the exception, and it is not a
 * small one: the shipped binary is GUI-subsystem, so the CLI runs in a process
 * that is not attached to a console. libuv cannot classify its handles, and
 * `isTTY` is `undefined` on a machine where the user is very much sitting at a
 * terminal typing at us.
 *
 * Trusting `isTTY` there gets every downstream decision wrong at once — colour
 * off, ASCII glyphs, prompts refusing to prompt, spinners disabled, width
 * guessed at 80. So on Windows the answer is passed IN, by the one process in
 * the chain that is attached to the console and therefore actually knows:
 * wolffish-cli.exe (build/win-cli-launcher/wolffish-cli.cs).
 *
 * The env vars are set only by that launcher, only for the handles it verified
 * are consoles, and never when the user redirected or piped — so `wolffish ...
 * > notes.md` and `wolffish ... | findstr` still see a plain non-terminal and
 * still get clean, colourless, ASCII output.
 */

/** stdout goes to a terminal, so colour and cursor tricks are safe. */
export function stdoutIsTty() {
  return process.stdout.isTTY === true || process.env.WOLFFISH_TTY_STDOUT === '1'
}

/** stderr goes to a terminal. */
export function stderrIsTty() {
  return process.stderr.isTTY === true || process.env.WOLFFISH_TTY_STDOUT === '1'
}

/**
 * Someone is there to answer a prompt.
 *
 * NOT the same as "stdin is a TTY stream". Under the Windows launcher stdin is
 * a real pipe carrying cooked console input, so raw mode is genuinely
 * unavailable — anything that needs `setRawMode` must keep testing
 * `process.stdin.isTTY` directly. This answers the different, more common
 * question: will a line ever arrive if we ask for one?
 */
export function stdinIsTty() {
  return process.stdin.isTTY === true || process.env.WOLFFISH_TTY_STDIN === '1'
}

/**
 * True only for a stdin that can be switched to raw mode.
 *
 * Keystroke-level reads (masked passwords, single-key menus) need this rather
 * than {@link stdinIsTty}, and it is deliberately never true under the Windows
 * launcher: the pipe cannot do raw mode, and pretending otherwise throws.
 */
export function stdinIsRawCapable() {
  return process.stdin.isTTY === true
}

const S_IFMT = 0o170000
const S_IFIFO = 0o010000

/**
 * Is this `stat.mode` a pipe?
 *
 * Exists because `stat.isFIFO()` cannot answer it on Windows. Node only defines
 * S_IFIFO on platforms that have it, and `checkModeProperty` returns false for
 * a constant it does not have — so isFIFO() is false for every pipe that has
 * ever existed on Windows. Verified against plain node.exe, not just the
 * packaged binary: `type x | node -e "fs.fstatSync(0).isFIFO()"` is false while
 * the mode is 0o10000, which is exactly S_IFIFO.
 *
 * The consequence was silent and total: `type log.txt | wolffish -p "why?"`
 * dropped the file and asked the model an empty question.
 */
export function modeIsFifo(mode) {
  return (mode & S_IFMT) === S_IFIFO
}

/**
 * Terminal width, or null when there is no terminal to measure.
 *
 * COLUMNS comes from the launcher, which read it off the console. Callers keep
 * their own fallbacks — this only reports what is known.
 */
export function terminalColumns() {
  if (process.stdout.columns) return process.stdout.columns
  const fromEnv = Number.parseInt(process.env.COLUMNS ?? '', 10)
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : null
}
