/**
 * Dialogs: a replace-only stack (multi-step flows chain by replacing and
 * resolving promises), a dimmed backdrop, a flat panel in the top third of
 * the screen, escape to close. Plus the three generic bodies every picker is
 * built from: a fuzzy select list, a text prompt, and a confirm.
 */
import { RGBA, type KeyEvent } from '@opentui/core'
import { useKeyboard, useTerminalDimensions } from '@opentui/solid'
import fuzzysort from 'fuzzysort'
import { createEffect, createMemo, createSignal, For, on, Show, type JSX } from 'solid-js'
import { useApp } from '../context'
import { truncate } from '../format'
import type { ActionName } from '../keymap'
import { theme } from '../theme'

export type DialogSize = 'medium' | 'large' | 'xlarge'

type Entry = { element: () => JSX.Element; onClose?: () => void }

export type DialogManager = {
  open: () => boolean
  replace: (element: () => JSX.Element, onClose?: () => void) => void
  clear: () => void
  size: () => DialogSize
  setSize: (size: DialogSize) => void
  /** The active dialog's key handler; the app routes keys here while open. */
  setKeyHandler: (handler: ((key: KeyEvent) => void) | null) => void
  handleKey: (key: KeyEvent) => void
}

export function createDialogManager(): DialogManager {
  const [entry, setEntry] = createSignal<Entry | null>(null)
  const [size, setSize] = createSignal<DialogSize>('medium')
  let handler: ((key: KeyEvent) => void) | null = null
  return {
    open: () => entry() !== null,
    replace: (element, onClose) => {
      const previous = entry()
      previous?.onClose?.()
      handler = null
      setSize('medium')
      setEntry({ element, onClose })
    },
    clear: () => {
      const previous = entry()
      setEntry(null)
      handler = null
      setSize('medium')
      previous?.onClose?.()
    },
    size,
    setSize,
    setKeyHandler: (fn) => {
      handler = fn
    },
    handleKey: (key) => handler?.(key)
  }
}

export function DialogHost(props: {
  manager: DialogManager
  entry: () => Entry | null
}): JSX.Element {
  const dims = useTerminalDimensions()
  const width = () => {
    const s = props.manager.size()
    const max = dims().width - 2
    return Math.min(max, s === 'xlarge' ? 116 : s === 'large' ? 88 : 60)
  }
  return (
    <Show when={props.entry()}>
      {(entry) => (
        <box
          position="absolute"
          top={0}
          left={0}
          width={dims().width}
          height={dims().height}
          zIndex={3000}
          alignItems="center"
          paddingTop={Math.max(1, Math.floor(dims().height / 5))}
          backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
          onMouseUp={() => props.manager.clear()}
        >
          <box
            width={width()}
            backgroundColor={theme().panel}
            paddingTop={1}
            paddingBottom={1}
            flexDirection="column"
            onMouseUp={(e: { stopPropagation: () => void }) => e.stopPropagation()}
          >
            {entry().element()}
          </box>
        </box>
      )}
    </Show>
  )
}

/* ───────────────────────── header ───────────────────────── */

export function DialogHeader(props: { title: string; right?: string }): JSX.Element {
  return (
    <box flexDirection="row" paddingLeft={3} paddingRight={3} justifyContent="space-between">
      <text fg={theme().text} attributes={1}>
        {props.title}
      </text>
      <text fg={theme().muted}>{props.right ?? 'esc'}</text>
    </box>
  )
}

/* ───────────────────────── select ───────────────────────── */

export type SelectOption<T = unknown> = {
  title: string
  value: T
  description?: string
  category?: string
  footer?: string
  disabled?: boolean
  /** Extra muted lines under the row. */
  details?: string[]
}

export type SelectAction<T> = {
  key: ActionName
  title: string
  onTrigger: (option: SelectOption<T>) => void
  /** Show a confirmation state on the row before firing (delete). */
  confirm?: string
}

export type DialogSelectProps<T> = {
  title: string
  options: SelectOption<T>[]
  placeholder?: string
  current?: T
  emptyText?: string
  onSelect: (option: SelectOption<T>) => void
  onMove?: (option: SelectOption<T>) => void
  actions?: SelectAction<T>[]
  hints?: string[]
  /** Skip the built-in fuzzy filter; caller filters on onFilter. */
  onFilter?: (query: string) => void
  loading?: boolean
}

export function DialogSelect<T>(props: DialogSelectProps<T>): JSX.Element {
  const app = useApp()
  const dims = useTerminalDimensions()
  const [query, setQuery] = createSignal('')
  const [index, setIndex] = createSignal(0)
  const [armed, setArmed] = createSignal<SelectAction<T> | null>(null)
  const [actionIndex, setActionIndex] = createSignal(-1)

  const filtered = createMemo(() => {
    const q = query().trim()
    const enabled = props.options.filter((o) => !o.disabled)
    if (props.onFilter || q.length === 0) return enabled
    const results = fuzzysort.go(q, enabled, {
      keys: ['title', 'description', 'category'],
      scoreFn: (r) => r[0].score * 2 + r[1].score + r[2].score * 0.5
    })
    return results.map((r) => r.obj)
  })

  // Rows are options grouped by category, in insertion order, unless filtering.
  type Row = { header: string } | { option: SelectOption<T>; i: number }
  const rows = createMemo<Row[]>(() => {
    const list = filtered()
    if (query().trim().length > 0) return list.map((option, i) => ({ option, i }))
    const out: Row[] = []
    let last: string | undefined
    list.forEach((option, i) => {
      const category = option.category ?? ''
      if (category && category !== last) {
        out.push({ header: category })
        last = category
      }
      out.push({ option, i })
    })
    return out
  })

  createEffect(on(filtered, () => setIndex(0)))
  createEffect(() => {
    if (props.current === undefined) return
    const i = filtered().findIndex((o) => JSON.stringify(o.value) === JSON.stringify(props.current))
    if (i >= 0) setIndex(i)
  })
  createEffect(() => {
    const option = filtered()[index()]
    if (option) props.onMove?.(option)
  })

  const maxRows = () => Math.max(3, Math.floor(dims().height / 2) - 6)
  const scrollTop = createMemo(() => {
    const i = rows().findIndex((r) => 'option' in r && r.i === index())
    const half = Math.floor(maxRows() / 2)
    const start = Math.max(0, Math.min(i - half, rows().length - maxRows()))
    return start
  })
  const visible = createMemo(() => rows().slice(scrollTop(), scrollTop() + maxRows()))

  const move = (delta: number) => {
    const n = filtered().length
    if (n === 0) return
    setIndex((i) => (((i + delta) % n) + n) % n)
    setArmed(null)
    setActionIndex(-1)
  }

  app.dialog.setKeyHandler((key) => {
    const km = app.keymap
    const selected = filtered()[index()]
    const actions = props.actions ?? []
    const fire = km.resolve(key, [
      'dialog_close',
      'dialog_prev',
      'dialog_next',
      'dialog_page_up',
      'dialog_page_down',
      'dialog_select',
      'dialog_action',
      ...actions.map((a) => a.key)
    ])
    if (fire === 'pending') return
    if (fire === 'dialog_close') {
      if (armed()) {
        setArmed(null)
        return
      }
      app.dialog.clear()
      return
    }
    if (fire === 'dialog_prev') return move(-1)
    if (fire === 'dialog_next') return move(1)
    if (fire === 'dialog_page_up') return move(-10)
    if (fire === 'dialog_page_down') return move(10)
    if (fire === 'dialog_action' && actions.length > 0) {
      setActionIndex((i) => (i + 1 >= actions.length ? -1 : i + 1))
      return
    }
    if (fire === 'dialog_select') {
      const focusedAction = actionIndex() >= 0 ? actions[actionIndex()] : null
      if (focusedAction && selected) return triggerAction(focusedAction, selected)
      if (selected) props.onSelect(selected)
      return
    }
    if (fire && selected) {
      const action = actions.find((a) => a.key === fire)
      if (action) return triggerAction(action, selected)
    }
    // Anything else edits the query.
    if (key.name === 'backspace') {
      setQuery((q) => q.slice(0, -1))
      props.onFilter?.(query())
      return
    }
    if (
      key.sequence &&
      key.sequence.length === 1 &&
      !key.ctrl &&
      !key.meta &&
      key.sequence >= ' '
    ) {
      setQuery((q) => q + key.sequence)
      props.onFilter?.(query())
    }
  })

  const triggerAction = (action: SelectAction<T>, option: SelectOption<T>) => {
    if (action.confirm && armed() !== action) {
      setArmed(action)
      return
    }
    setArmed(null)
    setActionIndex(-1)
    action.onTrigger(option)
  }

  const p = theme
  return (
    <box flexDirection="column">
      <DialogHeader title={props.title} />
      <box paddingLeft={3} paddingRight={3} marginTop={1} flexDirection="row">
        <text fg={query().length ? p().text : p().dim}>
          {query().length ? query() : (props.placeholder ?? 'Search')}
        </text>
        <text fg={p().accent}>▏</text>
      </box>
      <box flexDirection="column" marginTop={1} minHeight={1}>
        <Show when={props.loading}>
          <text fg={p().muted} paddingLeft={3}>
            {'  Loading…'}
          </text>
        </Show>
        <Show when={!props.loading && filtered().length === 0}>
          <box paddingLeft={3}>
            <text fg={p().muted}>{props.emptyText ?? 'No results'}</text>
          </box>
        </Show>
        <For each={visible()}>
          {(row) =>
            'header' in row ? (
              <box paddingLeft={3} marginTop={visible().indexOf(row) === 0 ? 0 : 1}>
                <text fg={p().accent} attributes={1}>
                  {row.header}
                </text>
              </box>
            ) : (
              <SelectRow
                option={row.option}
                active={row.i === index()}
                current={
                  props.current !== undefined &&
                  JSON.stringify(row.option.value) === JSON.stringify(props.current)
                }
                armed={row.i === index() ? armed() : null}
                width={Math.min(
                  dims().width - 2,
                  app.dialog.size() === 'xlarge' ? 116 : app.dialog.size() === 'large' ? 88 : 60
                )}
                onClick={() => {
                  setIndex(row.i)
                  props.onSelect(row.option)
                }}
              />
            )
          }
        </For>
      </box>
      <Show when={(props.actions?.length ?? 0) > 0 || (props.hints?.length ?? 0) > 0}>
        <box
          flexDirection="row"
          paddingLeft={3}
          paddingRight={3}
          marginTop={1}
          gap={2}
          flexWrap="wrap"
        >
          <For each={props.actions ?? []}>
            {(action, i) => (
              <text
                fg={actionIndex() === i() ? p().accentFg : p().text}
                bg={actionIndex() === i() ? p().accent : undefined}
              >
                {action.title}{' '}
                <span style={{ fg: actionIndex() === i() ? p().accentFg : p().muted }}>
                  {app.keymap.label(action.key)}
                </span>
              </text>
            )}
          </For>
          <For each={props.hints ?? []}>{(hint) => <text fg={p().muted}>{hint}</text>}</For>
        </box>
      </Show>
    </box>
  )
}

function SelectRow<T>(props: {
  option: SelectOption<T>
  active: boolean
  current: boolean
  armed: SelectAction<T> | null
  width: number
  onClick: () => void
}): JSX.Element {
  const p = theme
  const bg = () => (props.armed ? p().bad : props.active ? p().accent : undefined)
  const fg = () => (props.active || props.armed ? p().accentFg : p().text)
  const room = () => Math.max(10, props.width - 8 - (props.option.footer?.length ?? 0) - 2)
  return (
    <box flexDirection="column" onMouseUp={props.onClick}>
      <box
        flexDirection="row"
        paddingLeft={1}
        paddingRight={3}
        backgroundColor={bg()}
        justifyContent="space-between"
      >
        <text fg={fg()} attributes={props.active ? 1 : 0}>
          <span style={{ fg: props.active ? p().accentFg : p().accent }}>
            {props.current ? '● ' : '  '}
          </span>
          {props.armed ? props.armed.confirm : truncate(props.option.title, room())}
          <Show when={!props.armed && props.option.description}>
            <span style={{ fg: props.active ? p().accentFg : p().muted }}>
              {'  ' + props.option.description}
            </span>
          </Show>
        </text>
        <Show when={props.option.footer}>
          <text fg={props.active ? p().accentFg : p().muted}>{props.option.footer}</text>
        </Show>
      </box>
      <For each={props.option.details ?? []}>
        {(line) => (
          <box paddingLeft={5}>
            <text fg={p().muted}>{truncate(line, props.width - 8)}</text>
          </box>
        )}
      </For>
    </box>
  )
}

/* ───────────────────────── prompt ───────────────────────── */

export function DialogPrompt(props: {
  title: string
  value?: string
  placeholder?: string
  hidden?: boolean
  hint?: string
  onSubmit: (value: string) => void
}): JSX.Element {
  const app = useApp()
  const [value, setValue] = createSignal(props.value ?? '')
  const [cursor, setCursor] = createSignal((props.value ?? '').length)
  app.dialog.setKeyHandler((key) => {
    if (key.name === 'escape') return app.dialog.clear()
    if (key.name === 'return') return props.onSubmit(value())
    if (key.name === 'backspace') {
      if (cursor() === 0) return
      setValue((v) => v.slice(0, cursor() - 1) + v.slice(cursor()))
      setCursor((c) => c - 1)
      return
    }
    if (key.name === 'left') return setCursor((c) => Math.max(0, c - 1))
    if (key.name === 'right') return setCursor((c) => Math.min(value().length, c + 1))
    if (key.name === 'home' || (key.ctrl && key.name === 'a')) return setCursor(0)
    if (key.name === 'end' || (key.ctrl && key.name === 'e')) return setCursor(value().length)
    if (key.ctrl && key.name === 'u') {
      setValue('')
      setCursor(0)
      return
    }
    if (key.sequence && !key.ctrl && !key.meta && key.sequence.length >= 1 && key.sequence >= ' ') {
      setValue((v) => v.slice(0, cursor()) + key.sequence + v.slice(cursor()))
      setCursor((c) => c + key.sequence.length)
    }
  })
  const shown = () => (props.hidden ? '•'.repeat(value().length) : value())
  return (
    <box flexDirection="column">
      <DialogHeader title={props.title} />
      <box
        paddingLeft={3}
        paddingRight={3}
        marginTop={1}
        backgroundColor={theme().element}
        height={3}
        flexDirection="row"
        alignItems="center"
      >
        <text fg={value().length ? theme().text : theme().dim}>
          {value().length ? shown().slice(0, cursor()) : (props.placeholder ?? 'Type here')}
          <span style={{ fg: theme().accent }}>▏</span>
          {shown().slice(cursor())}
        </text>
      </box>
      <box paddingLeft={3} marginTop={1}>
        <text fg={theme().muted}>{props.hint ?? 'enter submit · esc cancel'}</text>
      </box>
    </box>
  )
}

/* ───────────────────────── confirm ───────────────────────── */

export function DialogConfirm(props: {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onResult: (ok: boolean) => void
}): JSX.Element {
  const app = useApp()
  const [active, setActive] = createSignal<'cancel' | 'confirm'>('cancel')
  app.dialog.setKeyHandler((key) => {
    if (key.name === 'escape') return props.onResult(false)
    if (
      key.name === 'left' ||
      key.name === 'right' ||
      key.name === 'tab' ||
      key.name === 'h' ||
      key.name === 'l'
    ) {
      setActive((a) => (a === 'cancel' ? 'confirm' : 'cancel'))
      return
    }
    if (key.name === 'return') return props.onResult(active() === 'confirm')
    if (key.name === 'y') return props.onResult(true)
    if (key.name === 'n') return props.onResult(false)
  })
  const p = theme
  const Button = (b: { id: 'cancel' | 'confirm'; label: string }) => (
    <box
      paddingLeft={2}
      paddingRight={2}
      backgroundColor={
        active() === b.id
          ? props.danger && b.id === 'confirm'
            ? p().bad
            : p().accent
          : p().element
      }
      onMouseUp={() => props.onResult(b.id === 'confirm')}
    >
      <text fg={active() === b.id ? p().accentFg : p().text}>{b.label}</text>
    </box>
  )
  return (
    <box flexDirection="column">
      <DialogHeader title={props.title} />
      <box paddingLeft={3} paddingRight={3} marginTop={1}>
        <text fg={p().muted} wrapMode="word">
          {props.message}
        </text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" gap={1} paddingRight={3} marginTop={1}>
        <Button id="cancel" label={props.cancelLabel ?? 'cancel'} />
        <Button id="confirm" label={props.confirmLabel ?? 'confirm'} />
      </box>
    </box>
  )
}

/** Promise helpers, so flows read top to bottom. */
export function ask(
  app: ReturnType<typeof useApp>,
  props: Omit<Parameters<typeof DialogPrompt>[0], 'onSubmit'>
): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false
    app.dialog.replace(
      () => (
        <DialogPrompt
          {...props}
          onSubmit={(value) => {
            done = true
            app.dialog.clear()
            resolve(value)
          }}
        />
      ),
      () => {
        if (!done) resolve(null)
      }
    )
  })
}

export function confirm(
  app: ReturnType<typeof useApp>,
  props: Omit<Parameters<typeof DialogConfirm>[0], 'onResult'>
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    app.dialog.replace(
      () => (
        <DialogConfirm
          {...props}
          onResult={(ok) => {
            done = true
            app.dialog.clear()
            resolve(ok)
          }}
        />
      ),
      () => {
        if (!done) resolve(false)
      }
    )
  })
}

export function alert(
  app: ReturnType<typeof useApp>,
  title: string,
  message: string
): Promise<void> {
  return new Promise((resolve) => {
    app.dialog.replace(
      () => <DialogAlert title={title} message={message} onOk={() => app.dialog.clear()} />,
      () => resolve()
    )
  })
}

export function DialogAlert(props: {
  title: string
  message: string
  onOk: () => void
}): JSX.Element {
  const app = useApp()
  app.dialog.setKeyHandler((key) => {
    if (key.name === 'escape' || key.name === 'return') props.onOk()
  })
  return (
    <box flexDirection="column">
      <DialogHeader title={props.title} />
      <box paddingLeft={3} paddingRight={3} marginTop={1}>
        <text fg={theme().muted} wrapMode="word">
          {props.message}
        </text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingRight={3} marginTop={1}>
        <box
          paddingLeft={2}
          paddingRight={2}
          backgroundColor={theme().accent}
          onMouseUp={props.onOk}
        >
          <text fg={theme().accentFg}>ok</text>
        </box>
      </box>
    </box>
  )
}

// Silence unused-import lint for useKeyboard in builds that tree-shake.
void useKeyboard
