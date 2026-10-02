/**
 * The 42-column sidebar: context, cost, other surfaces working, todos from
 * the latest list, delivered files, and the daemon line. Auto on wide
 * terminals, toggled with the sidebar key.
 */
import { TextAttributes } from '@opentui/core'
import { createMemo, For, Show, type JSX } from 'solid-js'
import { useApp } from '../context'
import { basename, money, plural, tokens, truncate } from '../format'
import { meterTint, theme } from '../theme'

export function Sidebar(): JSX.Element {
  const app = useApp()
  const [state] = app.store
  const p = theme
  const pct = () =>
    state.meter.budget > 0 ? Math.round((state.meter.tokens / state.meter.budget) * 100) : 0
  const todos = createMemo(() => {
    for (let i = state.feed.length - 1; i >= 0; i--) {
      const m = state.feed[i]
      if (m.kind !== 'assistant') continue
      for (let j = m.parts.length - 1; j >= 0; j--) {
        const part = m.parts[j]
        if (part.kind === 'todo') return part.items
      }
    }
    return []
  })
  const bar = () => {
    const width = 36
    const filled = Math.round((Math.min(100, pct()) / 100) * width)
    const tick =
      state.meter.compactionAt && state.meter.budget
        ? Math.round((state.meter.compactionAt / state.meter.budget) * width)
        : -1
    let out = ''
    for (let i = 0; i < width; i++) out += i === tick ? '┆' : i < filled ? '█' : '░'
    return out
  }
  return (
    <box
      width={42}
      flexShrink={0}
      flexDirection="column"
      backgroundColor={p().panel}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      gap={1}
    >
      <box flexDirection="column">
        <text fg={p().text} attributes={TextAttributes.BOLD}>
          {truncate(state.title ?? 'New conversation', 38)}
        </text>
        <Show when={state.conversationId}>
          <text fg={p().dim}>{state.conversationId?.slice(0, 12)}</text>
        </Show>
      </box>
      <box flexDirection="column">
        <text fg={p().text} attributes={TextAttributes.BOLD}>
          Context
        </text>
        <text fg={meterTint(pct())}>{bar()}</text>
        <text fg={p().muted}>
          {tokens(state.meter.tokens)} of {tokens(state.meter.budget)} ·{' '}
          <span style={{ fg: meterTint(pct()) }}>{pct()}%</span>
        </text>
        <Show when={state.meter.compactionAt}>
          <text fg={p().dim}>{`compacts at ${tokens(state.meter.compactionAt ?? 0)}`}</text>
        </Show>
        <text fg={p().muted}>
          {money(state.cost)} spent
          <Show when={state.allTime}>
            <span style={{ fg: p().dim }}>{` · ${plural(state.allTime?.turns ?? 0, 'turn')}`}</span>
          </Show>
        </text>
        <Show when={state.lastTurn}>
          <text
            fg={p().dim}
          >{`last turn ${tokens(state.lastTurn?.input)} in · ${tokens(state.lastTurn?.output)} out`}</text>
        </Show>
      </box>
      <Show when={state.runs.filter((r) => r.conversationId !== state.conversationId).length > 0}>
        <box flexDirection="column">
          <text fg={p().text} attributes={TextAttributes.BOLD}>
            Working elsewhere
          </text>
          <For each={state.runs.filter((r) => r.conversationId !== state.conversationId)}>
            {(run) => (
              <text fg={p().muted}>
                <span style={{ fg: p().accent }}>● </span>
                {truncate(
                  `${run.channel ?? 'app'} · ${run.title ?? run.conversationId.slice(0, 8)}`,
                  36
                )}
              </text>
            )}
          </For>
        </box>
      </Show>
      <Show when={todos().length > 0}>
        <box flexDirection="column">
          <text fg={p().text} attributes={TextAttributes.BOLD}>
            Todo
          </text>
          <For each={todos()}>
            {(item) => {
              const done = item.status === 'completed' || item.status === 'done'
              const active = item.status === 'in_progress' || item.status === 'active'
              return (
                <text fg={done ? p().muted : active ? p().warn : p().text}>
                  {done ? '[✓] ' : active ? '[•] ' : '[ ] '}
                  {truncate(item.content, 32)}
                </text>
              )
            }}
          </For>
        </box>
      </Show>
      <Show when={state.files.length > 0}>
        <box flexDirection="column">
          <text fg={p().text} attributes={TextAttributes.BOLD}>
            Delivered files
          </text>
          <For each={state.files.slice(-8)}>
            {(f) => (
              <text fg={p().muted}>
                <span style={{ fg: p().accent }}>{`${f.index}. `}</span>
                {truncate(basename(f.path), 32)}
              </text>
            )}
          </For>
        </box>
      </Show>
      <box flexGrow={1} />
      <box flexDirection="column">
        <text fg={p().muted}>
          {state.brain.model
            ? `${state.brain.provider ?? ''}/${state.brain.model}`
            : 'no brain configured'}
        </text>
        <text fg={p().muted}>
          <span style={{ fg: state.connection === 'connected' ? p().good : p().warn }}>● </span>
          {`Wolffish ${state.version ?? ''}`}
          <span style={{ fg: p().dim }}>{state.headless ? ' · headless' : ''}</span>
        </text>
      </box>
    </box>
  )
}
