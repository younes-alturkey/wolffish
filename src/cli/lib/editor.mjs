/**
 * Editing text, on any machine — with or without an `$EDITOR`.
 *
 * Every "edit" in this CLI (a project's instructions, a procedure's prompt,
 * heartbeat.md, Soul/User/Agents, any workspace file) used to end at one line:
 * `no $EDITOR set`. That is the default state of a fresh macOS shell, a Docker
 * image and most VPS logins, so on a typical machine roughly half the menu
 * entries printed an error and returned — which is exactly what "I press the
 * number and nothing happens" looks like from the outside.
 *
 * So editing now has four tiers, in order:
 *
 *   1. `$WOLFFISH_EDITOR` — an explicit choice made FOR this CLI, honoured
 *      verbatim, flags and all.
 *   2. The friendly default: `nano` on macOS and Linux, `notepad` (then
 *      Microsoft's nano-like `edit`) on Windows. Deliberately AHEAD of
 *      `$EDITOR`: that variable is usually set once, years ago, to vim — and
 *      landing someone who just pressed "Edit the prompt" inside a modal
 *      editor they cannot leave is the exact dead end this order removes.
 *      Anyone who wants vim here says so with `$WOLFFISH_EDITOR`.
 *   3. `$VISUAL` / `$EDITOR` — respected when the default editor is not
 *      installed, because a configured editor still beats a guessed one.
 *   4. A built-in line editor. No spawn, no terminal handover, no dependency —
 *      it works inside an SSH session on a box with nothing installed, and it
 *      borrows the session's own line reader like every other prompt here.
 *
 * Tier 4 is the one that makes the promise true rather than probable.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { accessSync, constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { c, g, handOverTerminal, icon, interactive, out, question, wrapText } from './ui.mjs'

/**
 * The default editors — the ones opened even when `$EDITOR` says otherwise.
 *
 * `nano` is modeless, labels its own keys on screen, and ships with macOS and
 * effectively every Linux. On Windows, `notepad` is the everyone-knows-it
 * choice and — being a GUI app — works even under the launcher, where the CLI
 * process has no console of its own; `edit` is Microsoft's new nano-like
 * terminal editor (in the box from Windows 11 24H2) and steps in where notepad
 * is somehow absent (Server Core).
 */
const DEFAULTS = process.platform === 'win32' ? ['notepad', 'edit'] : ['nano']

/**
 * Editors worth opening when neither the default nor `$EDITOR` resolves.
 *
 * Modal editors come last: someone who has not chosen an editor is unlikely to
 * know `:wq`, and landing them in vim is its own kind of dead end. GUI editors
 * (`code`, `subl`) are deliberately absent — without `--wait` they return
 * instantly and the edit is silently lost, and guessing that flag on someone's
 * behalf is how a save turns into a no-op. Name one in `$WOLFFISH_EDITOR` and
 * it is honoured verbatim, flags and all.
 */
const FALLBACKS = process.platform === 'win32' ? [] : ['micro', 'pico', 'vim', 'vi', 'ed']

/** `which`, without the subprocess. */
function onPath(command) {
  if (command.includes('/') || command.includes('\\')) {
    try {
      accessSync(command, constants.X_OK)
      return command
    } catch {
      return null
    }
  }
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        /* keep looking */
      }
    }
  }
  return null
}

/**
 * Which editor this machine will use, and where the choice came from.
 * Returns null only when nothing at all is installed — then the built-in
 * editor takes over.
 */
export function resolveEditor() {
  const forced = (process.env.WOLFFISH_EDITOR ?? '').trim()
  if (forced) {
    const [bin, ...args] = forced.split(/\s+/)
    return { bin, args, name: forced, chosen: true, source: '$WOLFFISH_EDITOR' }
  }
  // The friendly default OUTRANKS $EDITOR — see the header. nano on POSIX,
  // notepad/edit on Windows, and the resolve order is what makes that true.
  for (const candidate of DEFAULTS) {
    if (onPath(candidate)) {
      return { bin: candidate, args: [], name: candidate, chosen: false, source: 'default' }
    }
  }
  const configured = (process.env.VISUAL || process.env.EDITOR || '').trim()
  if (configured) {
    const [bin, ...args] = configured.split(/\s+/)
    const source = process.env.VISUAL?.trim() ? '$VISUAL' : '$EDITOR'
    return { bin, args, name: configured, chosen: true, source }
  }
  for (const candidate of FALLBACKS) {
    if (onPath(candidate)) {
      return { bin: candidate, args: [], name: candidate, chosen: false, source: 'detected' }
    }
  }
  return null
}

/** Said once per process, not once per edit — it is a hint, not a warning. */
let announced = false

/**
 * Hand `content` to an editor and return what came back.
 *
 * Returns null for "nothing changed" — no editor and no way to ask, or the
 * user cancelled. Callers must treat null as a no-op and never as "save an
 * empty file", which is the difference between a cancelled edit and a wiped
 * document.
 */
export async function editText(content, fileName, { label = null } = {}) {
  const editor = resolveEditor()

  if (!editor) {
    if (!interactive()) {
      out(c.red('  no editor available and nothing to ask on'))
      out(c.gray('  set one with: export EDITOR=nano'))
      return null
    }
    return inlineEdit(content, { label: label ?? fileName })
  }

  if (!editor.chosen && !announced) {
    announced = true
    // $WOLFFISH_EDITOR, not $EDITOR: the default now outranks $EDITOR, so
    // pointing at the variable this resolver no longer prefers would be a hint
    // that does not work.
    out(c.gray(`  opening ${editor.name} — set $WOLFFISH_EDITOR to use a different one`))
  }

  const scratch = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), 'wolffish-')),
    fileName || 'edit.md'
  )
  await fs.writeFile(scratch, content ?? '', 'utf8')

  // The editor takes the whole terminal, so readline stands down first and
  // gets raw mode back afterwards — otherwise the session returns from vim
  // with a prompt that echoes nothing.
  const startedAt = Date.now()
  const code = await handOverTerminal(
    () =>
      new Promise((resolve) => {
        const child = spawn(editor.bin, [...editor.args, scratch], { stdio: 'inherit' })
        child.on('close', resolve)
        // ENOENT here means `$EDITOR` names something that is not installed.
        // Falling through to the built-in beats reporting a failed edit for a
        // choice the user made months ago in a different shell.
        child.on('error', () => resolve('spawn-failed'))
      })
  )

  if (code === 'spawn-failed') {
    out(c.yellow(`  could not run "${editor.name}"`))
    await fs.rm(path.dirname(scratch), { recursive: true, force: true }).catch(() => undefined)
    if (!interactive()) return null
    return inlineEdit(content, { label: label ?? fileName })
  }
  if (code !== 0) {
    out(c.yellow('  editor exited non-zero — nothing saved'))
    await fs.rm(path.dirname(scratch), { recursive: true, force: true }).catch(() => undefined)
    return null
  }

  let edited = await fs.readFile(scratch, 'utf8')

  // Windows 11's tabbed Notepad: launched while another window is open, the
  // new process hands the file to the existing window and exits at once — so
  // "the editor closed" is true and "the user finished editing" is not, and
  // the unchanged file would read as a silent no-op edit. An instant exit with
  // nothing changed is that handoff's exact signature; wait for the human.
  if (
    /(^|[\\/])notepad(\.exe)?$/i.test(editor.bin) &&
    Date.now() - startedAt < 1500 &&
    edited === (content ?? '') &&
    interactive()
  ) {
    out(c.yellow('  notepad opened the file in an already-open window'))
    await question(`  ${c.dim('save and close it there, then press Enter')}: `)
    edited = await fs.readFile(scratch, 'utf8').catch(() => edited)
  }

  await fs.rm(path.dirname(scratch), { recursive: true, force: true }).catch(() => undefined)
  return edited
}

const INLINE_HELP = [
  ['<text>', 'append a line — just type'],
  [':s <n> <text>', 'replace line n'],
  [':i <n> <text>', 'insert before line n'],
  [':d <n>[-<m>]', 'delete a line, or a range'],
  [':clear', 'start from an empty document'],
  [':show', 'print it again, numbered'],
  [':save', 'save and close'],
  [':cancel', 'discard every change'],
  ['::<text>', 'append a line that really does start with a colon']
]

/**
 * The built-in editor: line-addressed, no screen control, no dependencies.
 *
 * Line-addressed rather than full-screen on purpose. A full-screen editor needs
 * raw mode, cursor addressing and its own key handling, and this surface has
 * exactly one line reader that the REPL already owns (see `setLineReader`) —
 * competing with it is what made nested prompts swallow keystrokes before.
 * Addressing lines by number needs none of that, and it is the one editing
 * model that behaves identically over a flaky SSH link.
 *
 * Typing plain text appends, because the overwhelmingly common case here is
 * writing a prompt or a set of instructions from scratch, and a document you
 * write top to bottom should not need a command per line. Pasting a block just
 * works: each pasted line is one append.
 */
export async function inlineEdit(content, { label = 'document' } = {}) {
  let lines = String(content ?? '').split('\n')
  // A trailing newline is one empty line, and showing it as an editable row is
  // confusing — it comes back on save.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const original = lines.join('\n')

  out()
  out(`  ${c.bold(`Editing ${label}`)} ${c.gray('· no $EDITOR, so this is the built-in one')}`)
  showLines(lines)
  showHelp()

  for (;;) {
    // Ends in `: ` like every other prompt, with no marker of its own: inside
    // a session the borrowed reader paints the blue input bar at the start of
    // the line, and a second marker dangling before the cursor read as clutter.
    const answer = await question(`  ${c.dim(':save when done, :cancel to discard')}: `)
    const line = answer ?? ''
    const trimmed = line.trim()

    if (trimmed === ':cancel' || trimmed === ':q' || trimmed === ':quit') {
      out(c.gray('  discarded'))
      return null
    }
    if (trimmed === ':save' || trimmed === ':w' || trimmed === ':wq' || trimmed === ':x') {
      const next = lines.join('\n')
      return next === original ? original : next + '\n'
    }
    if (trimmed === ':help' || trimmed === ':?' || trimmed === '?') {
      showHelp()
      continue
    }
    if (trimmed === ':show' || trimmed === ':p' || trimmed === ':l') {
      showLines(lines)
      continue
    }
    if (trimmed === ':clear') {
      lines = []
      out(c.gray('  empty — type the new text, one line at a time'))
      continue
    }

    const del = trimmed.match(/^:d\s+(\d+)(?:\s*-\s*(\d+))?$/)
    if (del) {
      const from = Number.parseInt(del[1], 10)
      const to = del[2] ? Number.parseInt(del[2], 10) : from
      if (from < 1 || to > lines.length || to < from) {
        out(c.red(`  no such line — there ${lines.length === 1 ? 'is' : 'are'} ${lines.length}`))
        continue
      }
      lines.splice(from - 1, to - from + 1)
      out(c.gray(`  deleted ${to - from + 1} ${to === from ? 'line' : 'lines'}`))
      showLines(lines)
      continue
    }

    const set = trimmed.match(/^:s\s+(\d+)\s?([\s\S]*)$/)
    if (set) {
      const index = Number.parseInt(set[1], 10)
      if (index < 1 || index > lines.length) {
        out(c.red(`  no such line — there ${lines.length === 1 ? 'is' : 'are'} ${lines.length}`))
        continue
      }
      lines[index - 1] = set[2]
      showLines(lines)
      continue
    }

    const insert = trimmed.match(/^:i\s+(\d+)\s?([\s\S]*)$/)
    if (insert) {
      const index = Number.parseInt(insert[1], 10)
      if (index < 1 || index > lines.length + 1) {
        out(c.red(`  no such line — there ${lines.length === 1 ? 'is' : 'are'} ${lines.length}`))
        continue
      }
      lines.splice(index - 1, 0, insert[2])
      showLines(lines)
      continue
    }

    if (/^:[a-z?]/i.test(trimmed)) {
      out(c.red(`  unknown command: ${trimmed.split(/\s/)[0]}`))
      showHelp()
      continue
    }

    // `::foo` is how you append a line that genuinely starts with a colon.
    lines.push(line.startsWith('::') ? line.slice(1) : line)
  }
}

/**
 * The document, numbered, so `:s 4` has something to refer to.
 *
 * Long documents print their head and tail rather than scrolling the whole
 * thing past every command — the numbers are what matter, and `:show` after a
 * `:d` should not repaint four hundred lines.
 */
function showLines(lines) {
  out()
  if (lines.length === 0) {
    out(c.gray('    (empty)'))
    out()
    return
  }
  const width = String(lines.length).length
  const print = (index) => {
    const text = lines[index]
    out(`  ${c.gray(String(index + 1).padStart(width))}  ${text === '' ? c.gray('·') : text}`)
  }
  if (lines.length <= 40) {
    lines.forEach((_, index) => print(index))
  } else {
    for (let i = 0; i < 20; i++) print(i)
    out(c.gray(`  ${' '.repeat(width)}  ${g.dot.repeat(3)} ${lines.length - 35} more lines`))
    for (let i = lines.length - 15; i < lines.length; i++) print(i)
  }
  out()
}

function showHelp() {
  const width = Math.max(...INLINE_HELP.map(([key]) => key.length))
  for (const [key, description] of INLINE_HELP) {
    out(`    ${c.cyan(key.padEnd(width))}  ${c.gray(description)}`)
  }
  out()
}

/**
 * What `wolffish status` and the CLI settings card say about editing, so
 * "which editor will this use?" is answerable before something opens.
 */
export function editorSummary() {
  const editor = resolveEditor()
  if (!editor)
    return { name: 'built-in', detail: 'nothing installed — the built-in editor is used' }
  return {
    name: editor.name,
    detail:
      editor.source === 'default'
        ? 'the default — set $WOLFFISH_EDITOR to change'
        : editor.chosen
          ? `from ${editor.source}`
          : 'detected — set $WOLFFISH_EDITOR to change'
  }
}

/** The one-line explanation printed wherever an edit is offered. */
export function editorHint() {
  const { name, detail } = editorSummary()
  return wrapText(c.gray(`edits open in ${name} (${detail})`), 2)
}

export { icon }
