/**
 * The empty screen: the wordmark, what the daemon is running, and the three
 * hints that matter before the first message.
 */
import { TextAttributes } from '@opentui/core'
import { For, Show, type JSX } from 'solid-js'
import { useApp } from '../context'
import { truncate } from '../format'
import { theme } from '../theme'

export const WORDMARK = [
  '╦ ╦╔═╗╦  ╔═╗╔═╗╦╔═╗╦ ╦',
  '║║║║ ║║  ╠╣ ╠╣ ║╚═╗╠═╣',
  '╚╩╝╚═╝╩═╝╚  ╚  ╩╚═╝╩ ╩'
]

export function Home(): JSX.Element {
  const app = useApp()
  const [state] = app.store
  const p = theme
  const connected = () => state.channels.filter((c) => c.connected)
  return (
    <box flexDirection="column" alignItems="center" paddingTop={1} gap={1}>
      <box flexDirection="column">
        <For each={WORDMARK}>{(line) => <text fg={p().accent}>{line}</text>}</For>
      </box>
      <box flexDirection="column" alignItems="center">
        <text fg={p().muted}>
          your agent, in the terminal
          <span style={{ fg: p().dim }}>{state.version ? `  ·  v${state.version}` : ''}</span>
          <span style={{ fg: p().dim }}>{state.headless ? '  ·  headless' : ''}</span>
        </text>
        <Show when={connected().length > 0}>
          <text fg={p().muted}>
            <span style={{ fg: p().good }}>● </span>
            {connected()
              .map((c) => c.label ?? c.id)
              .join(', ')}
          </text>
        </Show>
        <Show when={!state.brain.model}>
          <text fg={p().warn}>no model configured — /model to choose one, /settings for keys</text>
        </Show>
      </box>
      <Show when={state.runs.length > 0}>
        <box flexDirection="column" alignItems="center">
          <For each={state.runs}>
            {(run) => (
              <text fg={p().muted}>
                <span style={{ fg: p().accent }}>● </span>
                {`${run.channel ?? 'app'} is answering — ${truncate(run.title ?? run.conversationId.slice(0, 8), 48)}`}
              </text>
            )}
          </For>
        </box>
      </Show>
      <Show when={state.parked.length > 0}>
        <text fg={p().warn} attributes={TextAttributes.BOLD}>
          {`${state.parked.length} approval${state.parked.length === 1 ? '' : 's'} waiting — /pending`}
        </text>
      </Show>
      <box flexDirection="column" alignItems="center" marginTop={1}>
        <text fg={p().dim}>
          {`${app.keymap.label('command_palette')} commands   ${app.keymap.label('session_list')} conversations   ${app.keymap.label('settings_open')} settings   /help`}
        </text>
        <text fg={p().dim}>
          shift+enter new line · @path attaches · /name runs a command · esc esc stops a turn
        </text>
      </box>
    </box>
  )
}
