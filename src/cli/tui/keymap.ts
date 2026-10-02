/**
 * Keybinds as one declarative table.
 *
 * Every action has a default chord list and a description; the palette, the
 * hint rows and `/help` all read this table, so a binding is never spelled
 * in two places. A user override lives under `keybinds` in the daemon-owned
 * cli-state.json and replaces the default list wholesale ("none" unbinds).
 *
 * Chord grammar: `ctrl+x m` is a two-key sequence with a leader; `shift+return`
 * is one key with modifiers. Leader sequences resolve within 2 s.
 */
import type { KeyEvent } from '@opentui/core'

export type KeyName = string

export type KeyStroke = {
  name: string
  ctrl: boolean
  shift: boolean
  meta: boolean
  super: boolean
}

export const LEADER = 'ctrl+x'
export const LEADER_TIMEOUT_MS = 2000

export type BindingDefinition = { default: string; description: string }

export const DEFINITIONS = {
  app_exit: { default: 'ctrl+c,ctrl+d,<leader>q', description: 'Exit' },
  command_palette: { default: 'ctrl+p', description: 'Command palette' },
  help_show: { default: '<leader>?,f1', description: 'Help' },
  session_interrupt: { default: 'escape', description: 'Interrupt the turn' },
  session_new: { default: '<leader>n', description: 'New conversation' },
  session_list: { default: '<leader>l', description: 'Conversations' },
  session_rename: { default: 'ctrl+r', description: 'Rename conversation' },
  session_info: { default: '<leader>i', description: 'Conversation info' },
  session_compact: { default: '<leader>c', description: 'Compact context' },
  session_export: { default: '<leader>x', description: 'Export transcript' },
  session_copy: { default: '<leader>y', description: 'Copy last answer' },
  session_sidebar: { default: '<leader>b', description: 'Toggle sidebar' },
  session_thinking: { default: '<leader>r', description: 'Show or hide reasoning' },
  session_tools: { default: '<leader>v', description: 'Show or hide tool details' },
  model_list: { default: '<leader>m', description: 'Switch model' },
  thinking_cycle: { default: 'ctrl+t', description: 'Cycle thinking effort' },
  mode_cycle: { default: 'tab', description: 'Cycle chat mode' },
  plan_toggle: { default: '<leader>p', description: 'Toggle plan mode' },
  project_list: { default: '<leader>j', description: 'Bind a project' },
  settings_open: { default: '<leader>o', description: 'Settings' },
  usage_open: { default: '<leader>d', description: 'Usage' },
  status_open: { default: '<leader>s', description: 'Status' },
  theme_list: { default: '<leader>t', description: 'Theme' },
  editor_open: { default: '<leader>e', description: 'Open in $EDITOR' },
  attach_file: { default: '<leader>f', description: 'Attach a file' },
  messages_page_up: { default: 'pageup', description: 'Scroll up a page' },
  messages_page_down: { default: 'pagedown', description: 'Scroll down a page' },
  messages_first: { default: 'ctrl+g', description: 'Scroll to top' },
  messages_last: { default: 'ctrl+alt+g', description: 'Scroll to bottom' },
  tool_expand: { default: 'ctrl+o', description: 'Expand or collapse last tool output' },
  input_submit: { default: 'return', description: 'Send' },
  input_newline: {
    default: 'shift+return,ctrl+return,alt+return,ctrl+j',
    description: 'New line'
  },
  input_clear: { default: 'ctrl+c', description: 'Clear the draft' },
  history_previous: { default: 'up', description: 'Previous prompt' },
  history_next: { default: 'down', description: 'Next prompt' },
  dialog_close: { default: 'escape', description: 'Close' },
  dialog_prev: { default: 'up,ctrl+p', description: 'Previous item' },
  dialog_next: { default: 'down,ctrl+n', description: 'Next item' },
  dialog_select: { default: 'return', description: 'Choose' },
  dialog_page_up: { default: 'pageup', description: 'Page up' },
  dialog_page_down: { default: 'pagedown', description: 'Page down' },
  dialog_delete: { default: 'ctrl+d', description: 'Delete' },
  dialog_action: { default: 'tab', description: 'Next action' },
  card_left: { default: 'left,h', description: 'Previous option' },
  card_right: { default: 'right,l', description: 'Next option' },
  card_fullscreen: { default: 'ctrl+f', description: 'Fullscreen' },
  countdown_abort: { default: '<leader>a', description: 'Abort countdown' }
} as const satisfies Record<string, BindingDefinition>

export type ActionName = keyof typeof DEFINITIONS

/** Parse `ctrl+shift+a` into a stroke. */
export function parseStroke(text: string): KeyStroke {
  const parts = text.toLowerCase().split('+')
  const stroke: KeyStroke = { name: '', ctrl: false, shift: false, meta: false, super: false }
  for (const part of parts) {
    if (part === 'ctrl' || part === 'control') stroke.ctrl = true
    else if (part === 'shift') stroke.shift = true
    else if (part === 'alt' || part === 'meta' || part === 'option') stroke.meta = true
    else if (part === 'super' || part === 'cmd') stroke.super = true
    else stroke.name = aliasKey(part)
  }
  return stroke
}

function aliasKey(name: string): string {
  switch (name) {
    case 'enter':
      return 'return'
    case 'esc':
      return 'escape'
    case 'pgup':
      return 'pageup'
    case 'pgdn':
    case 'pgdown':
      return 'pagedown'
    case 'del':
      return 'delete'
    case 'space':
      return 'space'
    default:
      return name
  }
}

/** A chord is one or more strokes in sequence. */
export type Chord = KeyStroke[]

export function parseChord(text: string): Chord {
  return text
    .trim()
    .split(/\s+/)
    .map((token) => (token === '<leader>' ? LEADER : token))
    .flatMap((token) => (token.includes(' ') ? token.split(' ') : [token]))
    .map(parseStroke)
}

export function parseBindings(spec: string): Chord[] {
  if (spec === 'none' || spec.trim() === '') return []
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace('<leader>', `${LEADER} `))
    .map(parseChord)
}

export function keyMatches(stroke: KeyStroke, event: KeyEvent): boolean {
  const name = event.name === ' ' ? 'space' : event.name
  if (stroke.name !== name) return false
  if (stroke.ctrl !== !!event.ctrl) return false
  if (stroke.shift !== !!event.shift) return false
  if (stroke.meta !== !!event.meta) return false
  if (stroke.super !== !!event.super) return false
  return true
}

export type Overrides = Partial<Record<ActionName, string>>

export class Keymap {
  private table = new Map<ActionName, Chord[]>()
  private pending: KeyStroke[] = []
  private pendingAt = 0

  constructor(overrides: Overrides = {}) {
    for (const [name, def] of Object.entries(DEFINITIONS) as [ActionName, BindingDefinition][]) {
      const spec = overrides[name] ?? def.default
      this.table.set(name, parseBindings(spec))
    }
  }

  chords(action: ActionName): Chord[] {
    return this.table.get(action) ?? []
  }

  /** First binding, formatted for a hint: `ctrl+x m`. */
  label(action: ActionName): string {
    const chord = this.chords(action)[0]
    if (!chord) return ''
    return formatChord(chord)
  }

  /** True when a leader sequence is waiting for its second key. */
  get leaderPending(): boolean {
    return this.pending.length > 0 && Date.now() - this.pendingAt < LEADER_TIMEOUT_MS
  }

  clearPending(): void {
    this.pending = []
  }

  /**
   * Resolve a key event against a set of candidate actions. Returns the
   * action that fired, `'pending'` when the key started a sequence, or null.
   */
  resolve(event: KeyEvent, candidates: ActionName[]): ActionName | 'pending' | null {
    if (this.pending.length > 0 && Date.now() - this.pendingAt >= LEADER_TIMEOUT_MS) {
      this.pending = []
    }
    const sequence = [...this.pending]
    let prefixed = false
    for (const action of candidates) {
      for (const chord of this.chords(action)) {
        if (chord.length < sequence.length + 1) continue
        let ok = true
        for (let i = 0; i < sequence.length; i++) {
          if (!strokeEquals(chord[i], sequence[i])) {
            ok = false
            break
          }
        }
        if (!ok) continue
        if (!keyMatches(chord[sequence.length], event)) continue
        if (chord.length === sequence.length + 1) {
          this.pending = []
          return action
        }
        prefixed = true
      }
    }
    if (prefixed) {
      this.pending = [...sequence, strokeOf(event)]
      this.pendingAt = Date.now()
      return 'pending'
    }
    if (this.pending.length > 0) {
      // A sequence that led nowhere: drop it and let the key fall through.
      this.pending = []
    }
    return null
  }
}

function strokeOf(event: KeyEvent): KeyStroke {
  return {
    name: event.name === ' ' ? 'space' : event.name,
    ctrl: !!event.ctrl,
    shift: !!event.shift,
    meta: !!event.meta,
    super: !!event.super
  }
}

function strokeEquals(a: KeyStroke, b: KeyStroke): boolean {
  return (
    a.name === b.name &&
    a.ctrl === b.ctrl &&
    a.shift === b.shift &&
    a.meta === b.meta &&
    a.super === b.super
  )
}

export function formatStroke(stroke: KeyStroke): string {
  const parts: string[] = []
  if (stroke.ctrl) parts.push('ctrl')
  if (stroke.meta) parts.push('alt')
  if (stroke.shift) parts.push('shift')
  if (stroke.super) parts.push('super')
  const name =
    stroke.name === 'return'
      ? 'enter'
      : stroke.name === 'escape'
        ? 'esc'
        : stroke.name === 'pageup'
          ? 'pgup'
          : stroke.name === 'pagedown'
            ? 'pgdn'
            : stroke.name
  parts.push(name)
  return parts.join('+')
}

export function formatChord(chord: Chord): string {
  return chord.map(formatStroke).join(' ')
}
