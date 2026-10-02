/**
 * The two cards that replace the prompt: an approval and an ask-the-user
 * question. Keyboard first: arrows or h/l move, enter confirms, esc denies.
 */
import { TextAttributes } from '@opentui/core'
import { useTerminalDimensions } from '@opentui/solid'
import { createSignal, For, Show, type JSX } from 'solid-js'
import { useApp } from '../context'
import { truncate } from '../format'
import type { AskQuestion, PendingCard } from '../store'
import { theme } from '../theme'

/* ───────────────────────── approval ───────────────────────── */

export function ApprovalCard(props: {
  card: Extract<PendingCard, { kind: 'approval' }>
}): JSX.Element {
  const app = useApp()
  const p = theme
  const dims = useTerminalDimensions()
  const options = ['Allow once', 'Allow always', 'Deny'] as const
  const [index, setIndex] = createSignal(0)
  const [full, setFull] = createSignal(false)
  const args = () => {
    const raw = props.card.args ?? {}
    const entries = Object.entries(raw)
    if (entries.length === 0) return ''
    if (entries.length === 1 && typeof entries[0][1] === 'string') return entries[0][1]
    return JSON.stringify(raw, null, 2)
  }
  const confirmChoice = () => {
    const choice = options[index()]
    if (choice === 'Deny') void app.actions.respondApproval(props.card.id, 'denied')
    else void app.actions.respondApproval(props.card.id, 'approved', choice === 'Allow always')
  }
  app.cardKeys = (key) => {
    const fire = app.keymap.resolve(key, [
      'card_left',
      'card_right',
      'dialog_select',
      'dialog_close',
      'card_fullscreen'
    ])
    if (fire === 'pending') return true
    if (fire === 'card_left') setIndex((i) => (i + options.length - 1) % options.length)
    else if (fire === 'card_right') setIndex((i) => (i + 1) % options.length)
    else if (fire === 'dialog_select') confirmChoice()
    else if (fire === 'dialog_close') void app.actions.respondApproval(props.card.id, 'denied')
    else if (fire === 'card_fullscreen') setFull((f) => !f)
    else if (key.name === 'y') void app.actions.respondApproval(props.card.id, 'approved')
    else if (key.name === 'a') void app.actions.respondApproval(props.card.id, 'approved', true)
    else if (key.name === 'n') void app.actions.respondApproval(props.card.id, 'denied')
    else return false
    return true
  }
  const narrow = () => dims().width < 80
  return (
    <box
      flexDirection="column"
      border={['left']}
      borderStyle="single"
      borderColor={p().warn}
      backgroundColor={p().panel}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      maxHeight={full() ? dims().height - 2 : 16}
    >
      <text fg={p().warn} attributes={TextAttributes.BOLD}>
        {'△ Approval needed'}
        <span
          style={{ fg: p().muted }}
        >{`   ${props.card.tool}${props.card.parked ? '  (parked earlier)' : ''}`}</span>
      </text>
      <Show when={props.card.reason}>
        <box marginTop={1}>
          <text fg={p().text} wrapMode="word">
            {props.card.reason}
          </text>
        </box>
      </Show>
      <Show when={args()}>
        <box
          marginTop={1}
          backgroundColor={p().element}
          paddingLeft={1}
          paddingRight={1}
          maxHeight={full() ? dims().height - 10 : 6}
          overflow="hidden"
        >
          <text fg={p().muted} wrapMode="word">
            {full() ? args() : truncate(args(), 600)}
          </text>
        </box>
      </Show>
      <box
        marginTop={1}
        flexDirection={narrow() ? 'column' : 'row'}
        gap={1}
        justifyContent="space-between"
        alignItems={narrow() ? 'flex-start' : 'center'}
      >
        <box flexDirection={narrow() ? 'column' : 'row'} gap={1}>
          <For each={options}>
            {(label, i) => (
              <box
                paddingLeft={2}
                paddingRight={2}
                backgroundColor={
                  index() === i() ? (label === 'Deny' ? p().bad : p().accent) : p().element
                }
                onMouseUp={() => {
                  setIndex(i())
                  confirmChoice()
                }}
              >
                <text fg={index() === i() ? p().accentFg : p().text}>{label}</text>
              </box>
            )}
          </For>
        </box>
        <text
          fg={p().dim}
        >{`${app.keymap.label('card_fullscreen')} fullscreen  ←→ select  enter confirm  y/a/n`}</text>
      </box>
    </box>
  )
}

/* ───────────────────────── question ───────────────────────── */

type Answer = { kind: 'option'; index: number } | { kind: 'custom'; text: string } | null

export function QuestionCard(props: { card: Extract<PendingCard, { kind: 'ask' }> }): JSX.Element {
  const app = useApp()
  const p = theme
  const questions = () => props.card.questions
  const [tab, setTab] = createSignal(0)
  const [cursor, setCursor] = createSignal(0)
  const [answers, setAnswers] = createSignal<Answer[]>(questions().map(() => null))
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal('')
  const many = () => questions().length > 1
  const confirmTab = () => (many() ? questions().length : -1)
  const q = (): AskQuestion | undefined => questions()[tab()]
  const opts = () =>
    Array.isArray(q()?.options)
      ? (q()!.options as Array<{ label?: string; description?: string } | string>)
      : []
  const allowCustom = () => q()?.custom !== false
  const rowCount = () => opts().length + (allowCustom() ? 1 : 0)

  const submit = () => {
    const all = answers()
    void app.actions.respondAsk(props.card.id, {
      kind: 'answered',
      answers: all.map((a) => a ?? { kind: 'custom', text: '' })
    })
  }
  const choose = () => {
    const i = cursor()
    if (i < opts().length) {
      setAnswers((a) => a.map((x, j) => (j === tab() ? { kind: 'option', index: i } : x)))
      advance()
    } else {
      setEditing(true)
      const current = answers()[tab()]
      setDraft(current?.kind === 'custom' ? current.text : '')
    }
  }
  const advance = () => {
    if (!many()) return submit()
    setTab((t) => Math.min(t + 1, confirmTab()))
    setCursor(0)
  }

  app.cardKeys = (key) => {
    if (editing()) {
      if (key.name === 'escape') {
        setEditing(false)
        return true
      }
      if (key.name === 'return') {
        const text = draft().trim()
        setAnswers((a) =>
          a.map((x, j) => (j === tab() ? (text ? { kind: 'custom', text } : null) : x))
        )
        setEditing(false)
        if (text) advance()
        return true
      }
      if (key.name === 'backspace') {
        setDraft((d) => d.slice(0, -1))
        return true
      }
      if (key.sequence && !key.ctrl && !key.meta && key.sequence >= ' ')
        setDraft((d) => d + key.sequence)
      return true
    }
    if (key.name === 'escape') {
      void app.actions.respondAsk(props.card.id, { kind: 'canceled' })
      return true
    }
    if (tab() === confirmTab()) {
      if (key.name === 'return') submit()
      else if (key.name === 'left' || key.name === 'h' || (key.name === 'tab' && key.shift))
        setTab((t) => Math.max(0, t - 1))
      return true
    }
    if (key.name === 'tab' || key.name === 'right' || key.name === 'l') {
      if (many()) setTab((t) => Math.min(t + 1, confirmTab()))
      return true
    }
    if (key.name === 'left' || key.name === 'h') {
      if (many()) setTab((t) => Math.max(0, t - 1))
      return true
    }
    if (key.name === 'up' || key.name === 'k') setCursor((c) => (c + rowCount() - 1) % rowCount())
    else if (key.name === 'down' || key.name === 'j') setCursor((c) => (c + 1) % rowCount())
    else if (key.name === 'return') choose()
    else if (/^[1-9]$/.test(key.name)) {
      const n = Number(key.name) - 1
      if (n < rowCount()) {
        setCursor(n)
        choose()
      }
    } else return false
    return true
  }

  return (
    <box
      flexDirection="column"
      border={['left']}
      borderStyle="single"
      borderColor={p().accent}
      backgroundColor={p().panel}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
    >
      <Show when={many()}>
        <box flexDirection="row" gap={2}>
          <For each={questions()}>
            {(item, i) => (
              <text
                fg={tab() === i() ? p().accent : answers()[i()] ? p().good : p().muted}
                attributes={tab() === i() ? TextAttributes.BOLD : TextAttributes.NONE}
                onMouseUp={() => setTab(i())}
              >
                {truncate(item.header ?? item.question ?? `Question ${i() + 1}`, 24)}
              </text>
            )}
          </For>
          <text
            fg={tab() === confirmTab() ? p().accent : p().muted}
            attributes={tab() === confirmTab() ? TextAttributes.BOLD : TextAttributes.NONE}
          >
            Confirm
          </text>
        </box>
      </Show>
      <Show when={tab() !== confirmTab() && q()}>
        <box marginTop={many() ? 1 : 0} flexDirection="column">
          <text fg={p().text} attributes={TextAttributes.BOLD} wrapMode="word">
            {q()?.question ?? q()?.header ?? 'Question'}
          </text>
          <box marginTop={1} flexDirection="column">
            <For each={opts()}>
              {(option, i) => {
                const label = typeof option === 'string' ? option : (option.label ?? '')
                const desc = typeof option === 'string' ? '' : (option.description ?? '')
                const chosen = () =>
                  answers()[tab()]?.kind === 'option' &&
                  (answers()[tab()] as { index: number }).index === i()
                return (
                  <box
                    flexDirection="column"
                    onMouseUp={() => {
                      setCursor(i())
                      choose()
                    }}
                  >
                    <text
                      fg={cursor() === i() ? p().accent : p().text}
                      attributes={cursor() === i() ? TextAttributes.BOLD : TextAttributes.NONE}
                    >
                      <span style={{ fg: p().muted }}>{`${i() + 1}. `}</span>
                      {label}
                      <Show when={chosen()}>
                        <span style={{ fg: p().good }}>{'  ✓'}</span>
                      </Show>
                    </text>
                    <Show when={desc}>
                      <box paddingLeft={3}>
                        <text fg={p().muted} wrapMode="word">
                          {desc}
                        </text>
                      </box>
                    </Show>
                  </box>
                )
              }}
            </For>
            <Show when={allowCustom()}>
              <box
                flexDirection="column"
                onMouseUp={() => {
                  setCursor(opts().length)
                  choose()
                }}
              >
                <text
                  fg={cursor() === opts().length ? p().accent : p().text}
                  attributes={
                    cursor() === opts().length ? TextAttributes.BOLD : TextAttributes.NONE
                  }
                >
                  <span style={{ fg: p().muted }}>{`${opts().length + 1}. `}</span>
                  Type your own answer
                  <Show when={answers()[tab()]?.kind === 'custom'}>
                    <span style={{ fg: p().good }}>
                      {'  ✓ ' + truncate((answers()[tab()] as { text: string }).text, 40)}
                    </span>
                  </Show>
                </text>
                <Show when={editing()}>
                  <box paddingLeft={3} backgroundColor={p().element} marginTop={0}>
                    <text fg={p().text}>
                      {draft()}
                      <span style={{ fg: p().accent }}>▏</span>
                    </text>
                  </box>
                </Show>
              </box>
            </Show>
          </box>
        </box>
      </Show>
      <Show when={tab() === confirmTab()}>
        <box marginTop={1} flexDirection="column">
          <text fg={p().text} attributes={TextAttributes.BOLD}>
            Review
          </text>
          <For each={questions()}>
            {(item, i) => {
              const a = () => answers()[i()]
              const text = () => {
                const ans = a()
                if (!ans) return '(not answered)'
                if (ans.kind === 'custom') return ans.text
                const o = (item.options ?? [])[ans.index]
                return typeof o === 'string' ? o : (o?.label ?? '')
              }
              return (
                <text fg={a() ? p().text : p().bad}>
                  <span style={{ fg: p().muted }}>
                    {(item.header ?? item.question ?? `Q${i() + 1}`) + ': '}
                  </span>
                  {text()}
                </text>
              )
            }}
          </For>
        </box>
      </Show>
      <box marginTop={1}>
        <text fg={p().dim}>
          {editing()
            ? 'enter commit · esc cancel'
            : tab() === confirmTab()
              ? 'enter submit · ← back · esc dismiss'
              : `${many() ? 'tab next · ' : ''}↑↓ move · 1-9 pick · enter choose · esc dismiss`}
        </text>
      </box>
    </box>
  )
}
