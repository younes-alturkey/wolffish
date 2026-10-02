/**
 * The prompt card: a growing textarea, the meta row (mode · model · thinking
 * · plan · project) and the hint row (working state, elapsed, context meter,
 * cost, palette hint). Slash and @path completion pop up above the card.
 *
 * Keys are handled in the global handler that App routes here, which runs
 * BEFORE the textarea sees the event — so Enter submits, Shift+Enter (kitty)
 * / Ctrl+Enter / Alt+Enter / Ctrl+J insert a newline, and everything else
 * falls through to the editor.
 */
import type { KeyEvent, TextareaRenderable } from '@opentui/core'
import { TextAttributes } from '@opentui/core'
import { usePaste, useTerminalDimensions } from '@opentui/solid'
import fuzzysort from 'fuzzysort'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
  type JSX
} from 'solid-js'
import { existsSync, statSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { useApp } from '../context'
import { basename, money, stopwatch, titlecase, tokens, truncate } from '../format'
import { meterTint, theme } from '../theme'
import { Scanner } from '../ui/Spinner'

const HISTORY_MAX = 50
const PASTE_LINES = 3
const PASTE_CHARS = 150

type Completion = { display: string; description: string; apply: () => void; complete?: () => void }

function rank(display: string, query: string): number {
  const name = display.slice(1).split(' ')[0].toLowerCase()
  const q = query.toLowerCase()
  if (name === q) return 0
  if (name.startsWith(q)) return 1
  return 2
}

export function Prompt(props: { onSubmit?: () => void }): JSX.Element {
  const app = useApp()
  const [state, set] = app.store
  const p = theme
  const dims = useTerminalDimensions()
  let textarea: TextareaRenderable | undefined
  const [text, setText] = createSignal('')
  const [cursorLine, setCursorLine] = createSignal(0)
  const [historyIndex, setHistoryIndex] = createSignal(-1)
  const [historyDraft, setHistoryDraft] = createSignal('')
  const [completions, setCompletions] = createSignal<Completion[]>([])
  const [completionIndex, setCompletionIndex] = createSignal(0)
  const [interruptArmedAt, setInterruptArmedAt] = createSignal(0)
  const pastes = new Map<string, string>()
  let pasteCounter = 0

  const history = () => app.kv.get<string[]>('history', [])
  const pushHistory = (entry: string) => {
    const trimmed = entry.trim()
    if (!trimmed) return
    const list = history().filter((h) => h !== trimmed)
    list.unshift(trimmed)
    app.kv.set('history', list.slice(0, HISTORY_MAX))
  }

  /* ───────── elapsed clock ───────── */
  const [now, setNow] = createSignal(Date.now())
  const tick = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(tick))
  const elapsed = () => (state.sendAt ? stopwatch(now() - state.sendAt) : '')

  /* ───────── expose to commands ───────── */
  app.prompt = {
    getText: () => textarea?.plainText ?? text(),
    setText: (value) => {
      if (!textarea) return
      textarea.setText(value)
      textarea.gotoBufferEnd()
      setText(value)
    },
    insert: (value) => {
      textarea?.insertText(value)
      setText(textarea?.plainText ?? '')
    },
    focus: () => textarea?.focus(),
    clear: () => {
      textarea?.clear()
      setText('')
      pastes.clear()
    }
  }

  /* ───────── completions ───────── */
  const refreshCompletions = () => {
    const value = textarea?.plainText ?? text()
    const line = value.split('\n')[cursorLine()] ?? ''
    if (value.startsWith('/') && !value.includes('\n') && !/\s/.test(value.slice(1))) {
      const query = value.slice(1)
      const all = app.commands.slashes()
      const list = query
        ? fuzzysort.go(query, all, { keys: ['display', 'description'] }).map((r) => r.obj)
        : all
      // Exact and prefix matches first, then fuzzy order.
      const ranked = [...list].sort((a, b) => rank(a.display, query) - rank(b.display, query))
      setCompletions(
        ranked.slice(0, 10).map((s) => ({
          display: s.display,
          description: s.description,
          // Enter runs the command (a picker opens when it needs an argument);
          // Tab only completes the text so an argument can be typed.
          apply: () => {
            app.prompt?.setText(`/${s.command.slash}`)
            setCompletions([])
            void submit()
          },
          complete: () => {
            app.prompt?.setText(`/${s.command.slash}${s.command.argHint ? ' ' : ''}`)
            setCompletions([])
          }
        }))
      )
      setCompletionIndex(0)
      return
    }
    const at = line.match(/(?:^|\s)@([^\s@]*)$/)
    if (at) {
      const query = at[1]
      setCompletions(
        pathCompletions(query).map((entry) => ({
          display: entry.display,
          description: entry.isDir ? 'folder' : 'file',
          apply: () => {
            if (!textarea) return
            // Replace the @token with a staged attachment (files) or descend (folders).
            const full = textarea.plainText
            const start = full.lastIndexOf('@' + query)
            if (entry.isDir) {
              textarea.setText(
                full.slice(0, start) + '@' + entry.path + '/' + full.slice(start + query.length + 1)
              )
              textarea.gotoBufferEnd()
              setText(textarea.plainText)
              refreshCompletions()
              return
            }
            textarea.setText(
              (full.slice(0, start) + full.slice(start + query.length + 1)).replace(/\s+$/, '') +
                ' '
            )
            textarea.gotoBufferEnd()
            setText(textarea.plainText)
            if (!state.stagedAttachments.includes(entry.path))
              set('stagedAttachments', (s) => [...s, entry.path])
            app.toast.info(`attached ${basename(entry.path)}`)
            setCompletions([])
          }
        }))
      )
      setCompletionIndex(0)
      return
    }
    setCompletions([])
  }

  /* ───────── paste ───────── */
  usePaste((event) => {
    if (app.scope() !== 'session' || !textarea) return
    event.preventDefault?.()
    const raw = Buffer.from(event.bytes).toString('utf8').replace(/\r\n?/g, '\n')
    const trimmed = raw.trim()
    // A pasted path attaches the file.
    const candidate = trimmed
      .replace(/^file:\/\//, '')
      .replace(/^['"]|['"]$/g, '')
      .replace(/\\ /g, ' ')
    if (!trimmed.includes('\n') && candidate.length < 512 && existsSync(candidate)) {
      try {
        if (statSync(candidate).isFile()) {
          if (!state.stagedAttachments.includes(candidate))
            set('stagedAttachments', (s) => [...s, candidate])
          app.toast.info(`attached ${basename(candidate)}`)
          return
        }
      } catch {
        /* fall through */
      }
    }
    const lines = raw.split('\n').length
    if (lines >= PASTE_LINES || raw.length > PASTE_CHARS) {
      pasteCounter += 1
      const key = `[Pasted ~${lines} lines #${pasteCounter}]`
      pastes.set(key, raw)
      textarea.insertText(key)
    } else {
      textarea.insertText(raw)
    }
    setText(textarea.plainText)
  })

  const expandPastes = (value: string) => {
    let out = value
    for (const [key, full] of pastes) out = out.split(key).join(full)
    return out
  }

  /* ───────── submit ───────── */
  const submit = async () => {
    if (!textarea) return
    const raw = textarea.plainText
    const value = expandPastes(raw).trim()
    if (!value && state.stagedAttachments.length === 0) return
    if (value === 'exit' || value === 'quit' || value === ':q') return app.exit()
    const slash = app.commands.slash(value)
    if (slash) {
      app.prompt?.clear()
      pushHistory(raw.trim())
      setHistoryIndex(-1)
      try {
        await slash.command.run(slash.args)
      } catch (error) {
        app.toast.error(error)
      }
      return
    }
    app.prompt?.clear()
    pushHistory(raw.trim())
    setHistoryIndex(-1)
    await app.actions.send(value)
    props.onSubmit?.()
  }

  /* ───────── keys ───────── */
  app.promptKeys = (key: KeyEvent): boolean => {
    if (!textarea) return false
    const km = app.keymap
    const list = completions()
    if (list.length > 0) {
      if (key.name === 'escape') {
        setCompletions([])
        return true
      }
      if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
        setCompletionIndex((i) => (i + list.length - 1) % list.length)
        return true
      }
      if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
        setCompletionIndex((i) => (i + 1) % list.length)
        return true
      }
      if (key.name === 'return') {
        list[completionIndex()]?.apply()
        return true
      }
      if (key.name === 'tab') {
        const item = list[completionIndex()]
        if (item?.complete) item.complete()
        else item?.apply()
        return true
      }
    }
    const fired = km.resolve(key, [
      'input_submit',
      'input_newline',
      'input_clear',
      'history_previous',
      'history_next',
      'session_interrupt',
      'mode_cycle'
    ])
    if (fired === 'pending') return true
    switch (fired) {
      case 'input_submit':
        void submit()
        return true
      case 'input_newline':
        textarea.newLine()
        setText(textarea.plainText)
        return true
      case 'input_clear': {
        const current = textarea.plainText
        if (current.trim().length === 0) return false
        if (current.trim().length >= 20) pushHistory(current)
        app.prompt?.clear()
        return true
      }
      case 'history_previous': {
        if (textarea.cursorOffset !== 0 && textarea.plainText.length > 0) return false
        const h = history()
        if (h.length === 0) return false
        const next = Math.min(historyIndex() + 1, h.length - 1)
        if (historyIndex() === -1) setHistoryDraft(textarea.plainText)
        setHistoryIndex(next)
        app.prompt?.setText(h[next])
        return true
      }
      case 'history_next': {
        if (historyIndex() === -1) return false
        if (textarea.cursorOffset < textarea.plainText.length) return false
        const next = historyIndex() - 1
        setHistoryIndex(next)
        app.prompt?.setText(next === -1 ? historyDraft() : history()[next])
        return true
      }
      case 'session_interrupt': {
        if (!state.working) return false
        // A mid-turn message of ours still unread comes back first: Escape
        // takes the LAST one back into the prompt. Only with none left does
        // Escape mean "interrupt the turn".
        if (state.pending.some((row) => row.mine)) {
          void app.actions.withdrawPending()
          return true
        }
        const armedAt = interruptArmedAt()
        if (armedAt && Date.now() - armedAt < 5000) {
          setInterruptArmedAt(0)
          void app.actions.cancel()
        } else setInterruptArmedAt(Date.now())
        return true
      }
      case 'mode_cycle':
        void app.actions.setChatMode(state.chatMode === 'single' ? 'workflow' : 'single')
        return true
      default:
        return false
    }
  }

  createEffect(on(text, () => refreshCompletions()))
  // A send that never reached the daemon, or a mid-turn message taken back,
  // comes home as the draft — appended on its own line when something is
  // already being typed, never dropped.
  createEffect(() => {
    const draft = state.restoreDraft
    if (!draft) return
    set('restoreDraft', null)
    if (!textarea) return
    const current = textarea.plainText
    app.prompt?.setText(current.trim().length === 0 ? draft : `${current}\n${draft}`)
  })

  /* ───────── layout ───────── */
  const maxHeight = () => Math.max(6, Math.floor(dims().height / 3))
  const popupColumn = () =>
    Math.min(40, Math.max(...completions().map((c) => c.display.length), 8) + 3)
  const pct = () =>
    state.meter.budget > 0 ? Math.round((state.meter.tokens / state.meter.budget) * 100) : 0
  const interruptHint = () =>
    state.pending.some((row) => row.mine)
      ? 'esc takes back'
      : interruptArmedAt() && Date.now() - interruptArmedAt() < 5000
        ? 'esc again to interrupt'
        : 'esc interrupt'
  const placeholder = () =>
    state.working ? 'Message while it works…' : state.conversationId ? 'Reply…' : 'Ask anything…'
  const border = () => (state.working ? p().accent : p().border)

  return (
    <box flexDirection="column">
      <Show when={completions().length > 0}>
        <box
          flexDirection="column"
          backgroundColor={p().element}
          paddingLeft={2}
          paddingRight={2}
          marginBottom={0}
          maxHeight={10}
        >
          <For each={completions()}>
            {(c, i) => (
              <box
                flexDirection="row"
                backgroundColor={i() === completionIndex() ? p().accent : undefined}
                onMouseUp={c.apply}
              >
                <text fg={i() === completionIndex() ? p().accentFg : p().text}>
                  {c.display.padEnd(popupColumn())}
                  <span style={{ fg: i() === completionIndex() ? p().accentFg : p().muted }}>
                    {truncate(c.description, Math.max(10, dims().width - popupColumn() - 8))}
                  </span>
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
      <Show when={state.stagedAttachments.length > 0}>
        <box flexDirection="row" gap={1} paddingLeft={2} flexWrap="wrap">
          <For each={state.stagedAttachments}>
            {(file) => (
              <text onMouseUp={() => set('stagedAttachments', (s) => s.filter((x) => x !== file))}>
                <span style={{ fg: p().accentFg, bg: p().accent }}>{' ◆ '}</span>
                <span style={{ fg: p().text, bg: p().element }}>{` ${basename(file)} `}</span>
              </text>
            )}
          </For>
          <text fg={p().dim}>{'/staged to review'}</text>
        </box>
      </Show>
      <box
        flexDirection="column"
        border={['left']}
        borderStyle="single"
        borderColor={border()}
        paddingLeft={1}
        paddingRight={1}
      >
        <textarea
          ref={(r: TextareaRenderable) => {
            textarea = r
          }}
          width="100%"
          minHeight={1}
          maxHeight={maxHeight()}
          placeholder={placeholder()}
          placeholderColor={p().dim}
          textColor={p().text}
          focusedTextColor={p().text}
          cursorColor={p().accent}
          wrapMode="word"
          focused={app.scope() === 'session'}
          onContentChange={(event: unknown) => {
            setText(typeof event === 'string' ? event : (textarea?.plainText ?? ''))
          }}
          onCursorChange={(c: { line: number }) => {
            setCursorLine(c.line)
          }}
        />
        <box flexDirection="row" justifyContent="space-between" marginTop={0}>
          <text fg={p().muted} wrapMode="none">
            <span style={{ fg: state.chatMode === 'workflow' ? p().warn : p().accent, bold: true }}>
              {titlecase(state.chatMode)}
            </span>
            {' · '}
            <Show
              when={state.brain.model}
              fallback={<span style={{ fg: p().warn }}>no model — /model</span>}
            >
              <span style={{ fg: p().dim }}>
                {state.brain.provider ? state.brain.provider + '/' : ''}
              </span>
              <span style={{ fg: p().text }}>{state.brain.model}</span>
            </Show>
            <Show when={state.thinkingModes.length > 1}>
              {' · '}
              <span
                style={{
                  fg: state.thinking === 'off' ? p().dim : p().warn,
                  bold: !!(state.thinking === 'off' ? TextAttributes.NONE : TextAttributes.BOLD)
                }}
              >
                {state.thinking === 'off' ? 'thinking off' : `thinking ${state.thinking}`}
              </span>
            </Show>
            <Show when={state.planMode}>
              {' · '}
              <span style={{ fg: p().good, bold: true }}>plan</span>
            </Show>
            <Show when={state.projectTitle}>
              {' · '}
              <span style={{ fg: p().dim }}>project </span>
              <span style={{ fg: p().text }}>{truncate(state.projectTitle ?? '', 24)}</span>
            </Show>
            <Show when={state.localOnly}>
              <span style={{ fg: p().warn }}>{' · local only'}</span>
            </Show>
          </text>
          <text fg={p().dim} wrapMode="none">
            {state.verbose ? 'verbose' : ''}
          </text>
        </box>
      </box>
      <box
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={1}
        paddingRight={1}
        gap={2}
      >
        <box flexDirection="row" gap={1} flexShrink={1} flexGrow={1} overflow="hidden">
          <Show
            when={state.working}
            fallback={
              <text fg={p().dim} wrapMode="none">
                {state.connection === 'connected'
                  ? state.conversationId
                    ? truncate(state.title ?? '', 40)
                    : `${app.keymap.label('command_palette')} commands`
                  : state.connection}
              </text>
            }
          >
            <Scanner />
            <text fg={p().text} wrapMode="none">
              {truncate(state.activity ?? 'Thinking', 32)}
              <span style={{ fg: p().muted }}>{' · ' + elapsed()}</span>
              <span style={{ fg: p().dim }}>{'   ' + interruptHint()}</span>
            </text>
          </Show>
        </box>
        <text fg={p().muted} wrapMode="none" flexShrink={0}>
          <Show when={state.pending.length > 0}>
            <span style={{ fg: p().warn }}>{`${state.pending.length} pending · `}</span>
          </Show>
          <Show when={state.meter.budget > 0}>
            <span style={{ fg: p().dim }}>ctx </span>
            {tokens(state.meter.tokens)}
            <span style={{ fg: p().dim }}>/{tokens(state.meter.budget)} </span>
            <span style={{ fg: meterTint(pct()) }}>{pct()}%</span>
            {' · '}
          </Show>
          {money(state.cost)}
          <Show when={state.working && dims().width >= 100}>
            <span style={{ fg: p().dim }}>
              {'   ' + app.keymap.label('command_palette') + ' commands'}
            </span>
          </Show>
        </text>
      </box>
    </box>
  )
}

/* ───────────────────────── @path completion ───────────────────────── */

type PathEntry = { display: string; path: string; isDir: boolean }

function pathCompletions(query: string): PathEntry[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const expanded = query.startsWith('~') ? path.join(home, query.slice(1)) : query
  const absolute = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(process.cwd(), expanded || '.')
  const dir = query.endsWith('/') || query === '' ? absolute : path.dirname(absolute)
  const prefix = query.endsWith('/') || query === '' ? '' : path.basename(absolute).toLowerCase()
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out: PathEntry[] = []
  for (const name of entries) {
    if (name.startsWith('.') && !prefix.startsWith('.')) continue
    if (prefix && !name.toLowerCase().startsWith(prefix)) continue
    const full = path.join(dir, name)
    let isDir = false
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    const shown = full.startsWith(home) ? '~' + full.slice(home.length) : full
    out.push({ display: shown + (isDir ? '/' : ''), path: full, isDir })
    if (out.length >= 10) break
  }
  return out.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.display.localeCompare(b.display))
}

export const promptMemo = createMemo
