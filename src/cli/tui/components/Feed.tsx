/**
 * The feed: user messages, assistant messages, and one renderer per part
 * kind — the terminal mirror of the app's chat. Verbose off hides tool rows
 * that completed cleanly and shows prose, deliveries, cards and errors.
 */
import type { ScrollBoxRenderable, SyntaxStyle } from '@opentui/core'
import { TextAttributes } from '@opentui/core'
import {
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
  type Accessor,
  type JSX
} from 'solid-js'
import { useApp } from '../context'
import {
  basename,
  bytes,
  clock,
  collapseOutput,
  duration,
  plural,
  shortPath,
  summarizeArgs,
  truncate
} from '../format'
import type { AssistantMessage, Attachment, Part, UserMessage } from '../store'
import { theme } from '../theme'
import { Spinner } from '../ui/Spinner'

export type FeedProps = {
  syntax: Accessor<SyntaxStyle>
  width: Accessor<number>
  ref?: (box: ScrollBoxRenderable) => void
}

export function Feed(props: FeedProps): JSX.Element {
  const app = useApp()
  const [state] = app.store
  return (
    <scrollbox
      ref={props.ref}
      flexGrow={1}
      stickyScroll={true}
      stickyStart="bottom"
      scrollY={true}
      scrollX={false}
      paddingLeft={2}
      paddingRight={2}
      verticalScrollbarOptions={{ visible: false }}
      contentOptions={{ gap: 1, flexDirection: 'column' }}
    >
      <box height={1} />
      <For each={state.feed}>
        {(item) => (
          <Switch>
            <Match when={item.kind === 'user'}>
              <UserRow
                text={(item as UserMessage).text}
                attachments={(item as UserMessage).attachments}
                timestamp={(item as UserMessage).timestamp}
              />
            </Match>
            <Match when={item.kind === 'assistant'}>
              <AssistantRow
                message={item as AssistantMessage}
                syntax={props.syntax}
                width={props.width}
              />
            </Match>
          </Switch>
        )}
      </For>
      {/* Mid-turn messages the agent has not read yet: below the streaming
          reply, where they will land once read (as a user row inside it). */}
      <Show when={state.pending.length > 0}>
        <For each={state.pending}>
          {(row) => (
            <UserRow
              text={row.text}
              attachments={row.attachments.map((path) => ({ name: basename(path), path }))}
              tag="READ AT NEXT STEP"
            />
          )}
        </For>
      </Show>
    </scrollbox>
  )
}

/* ───────────────────────── user ───────────────────────── */

/**
 * One user bubble. Three callers share it: a feed-level message (with its
 * clock), a mid-turn message the agent already read (inline in the assistant
 * row, with its clock), and one still waiting (a dim tag instead).
 */
function UserRow(props: {
  text: string
  attachments: Attachment[]
  timestamp?: number
  tag?: string
}): JSX.Element {
  const p = theme
  return (
    <box
      flexDirection="column"
      border={['left']}
      borderStyle="single"
      borderColor={p().user}
      backgroundColor={p().panel}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
    >
      <text fg={p().text} wrapMode="word">
        {props.text}
      </text>
      <Show when={props.attachments.length > 0}>
        <box flexDirection="row" gap={1} marginTop={1} flexWrap="wrap">
          <For each={props.attachments}>
            {(a) => (
              <text>
                <span style={{ fg: p().accentFg, bg: p().accent }}>{` ${a.type ?? 'file'} `}</span>
                <span style={{ fg: p().text, bg: p().element }}>{` ${a.name} `}</span>
              </text>
            )}
          </For>
        </box>
      </Show>
      <box marginTop={1} flexDirection="row" justifyContent="flex-end">
        <text fg={p().dim}>
          {props.tag ?? (props.timestamp !== undefined ? clock(props.timestamp) : '')}
        </text>
      </box>
    </box>
  )
}

/* ───────────────────────── assistant ───────────────────────── */

function AssistantRow(props: {
  message: AssistantMessage
  syntax: Accessor<SyntaxStyle>
  width: Accessor<number>
}): JSX.Element {
  const app = useApp()
  const [state] = app.store
  const p = theme
  const live = () => !props.message.endedAt
  const visibleParts = createMemo(() =>
    props.message.parts.filter((part) => {
      if (part.kind === 'tool') {
        const status: string = part.status
        return state.verbose || status !== 'ok' || part.files.length > 0 || part.paths.length > 0
      }
      if (part.kind === 'reasoning') return true
      return true
    })
  )
  const footer = () => {
    const m = props.message
    if (live()) return null
    const bits: string[] = []
    if (m.provider || m.model) bits.push([m.provider, m.model].filter(Boolean).join('/'))
    if (m.iterations) bits.push(plural(m.iterations, 'iteration'))
    if (m.endedAt && m.startedAt && m.endedAt > m.startedAt)
      bits.push(duration(m.endedAt - m.startedAt))
    if (
      m.stopReason &&
      m.stopReason !== 'end_turn' &&
      m.stopReason !== 'stop' &&
      m.stopReason !== 'completed'
    )
      bits.push(m.stopReason.replace(/_/g, ' '))
    if (m.interrupted) bits.push('interrupted')
    return bits.join(' · ')
  }
  return (
    <box flexDirection="column" gap={0}>
      <Show
        when={
          props.message.reasoningContent && !props.message.parts.some((x) => x.kind === 'reasoning')
        }
      >
        <ReasoningPart
          text={props.message.reasoningContent ?? ''}
          done={true}
          startedAt={0}
          endedAt={0}
          syntax={props.syntax}
        />
      </Show>
      <For each={visibleParts()}>
        {(part) => (
          <Switch>
            <Match when={part.kind === 'text'}>
              <box paddingLeft={3} marginTop={1}>
                <markdown
                  content={(part as { text: string }).text}
                  syntaxStyle={props.syntax()}
                  streaming={live()}
                  fg={p().text}
                />
              </box>
            </Match>
            <Match when={part.kind === 'reasoning'}>
              <ReasoningPart
                text={(part as { text: string }).text}
                done={!!(part as { endedAt?: number }).endedAt}
                startedAt={(part as { startedAt: number }).startedAt}
                endedAt={(part as { endedAt?: number }).endedAt ?? 0}
                syntax={props.syntax}
              />
            </Match>
            <Match when={part.kind === 'tool'}>
              <ToolPart
                part={part as Extract<Part, { kind: 'tool' }>}
                messageId={props.message.id}
                syntax={props.syntax}
                width={props.width}
              />
            </Match>
            <Match when={part.kind === 'todo'}>
              <TodoPart items={(part as Extract<Part, { kind: 'todo' }>).items} />
            </Match>
            <Match when={part.kind === 'options'}>
              <OptionsPart
                part={part as Extract<Part, { kind: 'options' }>}
                syntax={props.syntax}
              />
            </Match>
            <Match when={part.kind === 'workflow'}>
              <WorkflowPart snapshot={(part as Extract<Part, { kind: 'workflow' }>).snapshot} />
            </Match>
            <Match when={part.kind === 'task'}>
              <TaskPart snapshot={(part as Extract<Part, { kind: 'task' }>).snapshot} />
            </Match>
            <Match when={part.kind === 'process'}>
              <ProcessPart snapshot={(part as Extract<Part, { kind: 'process' }>).snapshot} />
            </Match>
            <Match when={part.kind === 'countdown'}>
              <CountdownPart snapshot={(part as Extract<Part, { kind: 'countdown' }>).snapshot} />
            </Match>
            <Match when={part.kind === 'wait'}>
              <WaitPart snapshot={(part as Extract<Part, { kind: 'wait' }>).snapshot} />
            </Match>
            <Match when={part.kind === 'browser'}>
              <BrowserPart snapshot={(part as Extract<Part, { kind: 'browser' }>).snapshot} />
            </Match>
            <Match when={part.kind === 'compaction'}>
              <CompactionPart part={part as Extract<Part, { kind: 'compaction' }>} />
            </Match>
            <Match when={part.kind === 'user'}>
              <box marginTop={1}>
                <UserRow
                  text={(part as Extract<Part, { kind: 'user' }>).text}
                  attachments={(part as Extract<Part, { kind: 'user' }>).attachments}
                  timestamp={(part as Extract<Part, { kind: 'user' }>).timestamp}
                />
              </box>
            </Match>
            <Match when={part.kind === 'provider_errors'}>
              <box paddingLeft={3} marginTop={1} flexDirection="column">
                <For each={(part as Extract<Part, { kind: 'provider_errors' }>).errors}>
                  {(e) => (
                    <text fg={p().bad}>
                      {'✗ '}
                      {String(e.provider ?? '')} {String(e.model ?? '')}:{' '}
                      {String(e.error ?? e.message ?? 'provider unavailable')}
                    </text>
                  )}
                </For>
              </box>
            </Match>
          </Switch>
        )}
      </For>
      <Show when={props.message.error}>
        <box
          border={['left']}
          borderStyle="single"
          borderColor={p().bad}
          backgroundColor={p().panel}
          paddingLeft={2}
          paddingTop={0}
          marginTop={1}
        >
          <text fg={p().bad} wrapMode="word">
            {props.message.error}
          </text>
        </box>
      </Show>
      <Show when={footer()}>
        <box paddingLeft={3} marginTop={1} flexDirection="row">
          <text fg={p().muted}>
            <span style={{ fg: props.message.error ? p().bad : p().good }}>▣</span>
            {'  '}
            {footer()}
          </text>
        </box>
      </Show>
    </box>
  )
}

/* ───────────────────────── reasoning ───────────────────────── */

function ReasoningPart(props: {
  text: string
  done: boolean
  startedAt: number
  endedAt: number
  syntax: Accessor<SyntaxStyle>
}): JSX.Element {
  const app = useApp()
  const [state] = app.store
  const p = theme
  const [open, setOpen] = createSignal(false)
  const visible = () => state.showThinking || open()
  const body = () => props.text.replace('[REDACTED]', '').trim()
  const label = () => {
    if (!props.done) return 'Thinking'
    const ms = props.endedAt && props.startedAt ? props.endedAt - props.startedAt : 0
    return ms > 0 ? `Thought · ${duration(ms)}` : 'Thought'
  }
  return (
    <box flexDirection="column" paddingLeft={3} marginTop={1}>
      <box flexDirection="row" onMouseUp={() => setOpen((o) => !o)}>
        <Show
          when={!props.done}
          fallback={<text fg={p().warn}>{(visible() ? '▾ ' : '▸ ') + label()}</text>}
        >
          <Spinner color={p().warn}>{label()}</Spinner>
        </Show>
        <Show when={props.done && !visible()}>
          <text fg={p().dim}>{'   ' + app.keymap.label('session_thinking') + ' to expand'}</text>
        </Show>
      </box>
      <Show when={visible() && body().length > 0}>
        <box paddingLeft={2} marginTop={0}>
          <code
            content={body()}
            filetype="markdown"
            syntaxStyle={props.syntax()}
            fg={p().muted}
            streaming={!props.done}
            drawUnstyledText={false}
          />
        </box>
      </Show>
    </box>
  )
}

/* ───────────────────────── tools ───────────────────────── */

const ICONS: Record<string, string> = {
  shell: '$',
  bash: '$',
  file_read: '→',
  read_file: '→',
  file_write: '←',
  write_file: '←',
  file_edit: '←',
  edit_file: '←',
  apply_patch: '%',
  glob: '✱',
  grep: '✱',
  search: '✱',
  web_fetch: '%',
  fetch: '%',
  web_search: '◈',
  browser: '◈',
  send_file: '◆',
  show_path: '▸',
  todo_write: '⚙',
  ask_user: '?',
  task: '│'
}

function toolIcon(name: string): string {
  if (ICONS[name]) return ICONS[name]
  for (const [key, icon] of Object.entries(ICONS)) if (name.includes(key)) return icon
  return '⚙'
}

function ToolPart(props: {
  part: Extract<Part, { kind: 'tool' }>
  messageId: string
  syntax: Accessor<SyntaxStyle>
  width: Accessor<number>
}): JSX.Element {
  const app = useApp()
  const [state, set] = app.store
  const p = theme
  const color = () =>
    props.part.status === 'running'
      ? p().text
      : props.part.status === 'error'
        ? p().bad
        : props.part.status === 'stopped'
          ? p().warn
          : p().muted
  const attrs = () =>
    props.part.status === 'denied' ? TextAttributes.STRIKETHROUGH : TextAttributes.NONE
  const isShell = () => /shell|bash|exec|command/.test(props.part.name)
  const diff = () => {
    const meta = props.part.meta ?? {}
    const d = (meta.diff as string | undefined) ?? (meta.patch as string | undefined)
    return typeof d === 'string' && d.includes('@@') ? d : null
  }
  const room = () => Math.max(20, props.width() - 8)
  const preview = createMemo(() => {
    const output = props.part.output ?? ''
    if (!output) return null
    const maxLines = isShell() ? 10 : 3
    return props.part.expanded
      ? { output, overflow: false }
      : collapseOutput(output, maxLines, maxLines * room())
  })
  const showBlock = () =>
    state.verbose && (preview() !== null || diff() !== null) && props.part.status !== 'running'
  const toggle = () => {
    set('feed', (feed) =>
      feed.map((m) =>
        m.kind === 'assistant' && m.id === props.messageId
          ? {
              ...m,
              parts: m.parts.map((x) =>
                x.kind === 'tool' && x.id === props.part.id ? { ...x, expanded: !x.expanded } : x
              )
            }
          : m
      )
    )
  }
  const argText = () => summarizeArgs(props.part.args, Math.floor(room() / 2))
  return (
    <box flexDirection="column" paddingLeft={3}>
      <box flexDirection="row" onMouseUp={toggle}>
        <Show
          when={props.part.status === 'running'}
          fallback={<text fg={color()}>{toolIcon(props.part.name) + ' '}</text>}
        >
          <Spinner color={p().text} />
          <text> </text>
        </Show>
        <text fg={color()} attributes={attrs()} wrapMode="none">
          {props.part.name}
          <span style={{ fg: p().dim }}>{argText() ? '  ' + argText() : ''}</span>
          <Show when={props.part.worker}>
            <span style={{ fg: p().dim }}>{`  ⟨${props.part.worker}⟩`}</span>
          </Show>
          <Show
            when={
              props.part.status !== 'running' &&
              props.part.durationMs !== undefined &&
              state.verbose
            }
          >
            <span style={{ fg: p().dim }}>{'  ' + duration(props.part.durationMs)}</span>
          </Show>
          <Show when={props.part.status === 'denied'}>
            <span style={{ fg: p().muted }}>{'  denied'}</span>
          </Show>
          <Show when={props.part.status === 'checked_in'}>
            <span style={{ fg: p().muted }}>{'  still running'}</span>
          </Show>
          <Show when={props.part.status === 'stopped'}>
            <span style={{ fg: p().warn }}>
              {(props.part.meta?.stoppedBy as string | undefined) === 'user'
                ? '  stopped by you'
                : (props.part.meta?.stoppedBy as string | undefined) === 'model'
                  ? '  stopped by wolffish (call_stop)'
                  : '  stopped'}
            </span>
          </Show>
        </text>
      </box>
      <Show when={props.part.status === 'error' && props.part.error}>
        <box paddingLeft={3}>
          <text fg={p().bad} wrapMode="word">
            {truncate(props.part.error ?? '', 400)}
          </text>
        </box>
      </Show>
      <Show when={showBlock()}>
        <box
          flexDirection="column"
          marginTop={0}
          marginBottom={0}
          border={['left']}
          borderStyle="single"
          borderColor={p().border}
          backgroundColor={p().panel}
          paddingLeft={2}
          paddingRight={1}
          onMouseUp={toggle}
        >
          <Show when={diff()}>
            <diff
              diff={diff() ?? ''}
              view={props.width() > 120 ? 'split' : 'unified'}
              syntaxStyle={props.syntax()}
              filetype={filetypeOf(props.part.args)}
              showLineNumbers={true}
              addedBg={p().diffAdded}
              removedBg={p().diffRemoved}
              fg={p().text}
            />
          </Show>
          <Show when={!diff() && preview()}>
            <text fg={p().muted} wrapMode="word">
              {preview()?.output}
            </text>
            <Show when={preview()?.overflow || props.part.expanded}>
              <text fg={p().dim}>
                {props.part.expanded
                  ? 'click or ' + app.keymap.label('tool_expand') + ' to collapse'
                  : 'click or ' + app.keymap.label('tool_expand') + ' to expand'}
              </text>
            </Show>
          </Show>
        </box>
      </Show>
      <For each={props.part.files}>
        {(f) => (
          <box
            flexDirection="row"
            paddingLeft={0}
            onMouseUp={() =>
              app.actions &&
              void app.client.invoke('viewer:openExternal', f.path).catch(() => undefined)
            }
          >
            <text fg={p().accent}>
              {'◆ '}
              <span style={{ fg: p().text }}>{basename(f.path)}</span>
              <span
                style={{ fg: p().dim }}
              >{`  ${f.kind}  ${shortPath(f.path)}  /open ${f.index}`}</span>
            </text>
          </box>
        )}
      </For>
      <For each={props.part.paths}>
        {(f) => (
          <text fg={p().accent}>
            {'▸ '}
            <span style={{ fg: p().text }}>{shortPath(f.path)}</span>
            <span style={{ fg: p().dim }}>{`  ${f.kind}`}</span>
          </text>
        )}
      </For>
    </box>
  )
}

function filetypeOf(args: Record<string, unknown>): string | undefined {
  const p = String(args.path ?? args.file ?? args.filePath ?? '')
  const ext = p.split('.').pop()?.toLowerCase()
  if (!ext) return undefined
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    md: 'markdown',
    zig: 'zig'
  }
  return map[ext]
}

/* ───────────────────────── cards ───────────────────────── */

function Card(props: {
  title: string
  color?: ReturnType<typeof theme>['accent']
  children: JSX.Element
}): JSX.Element {
  const p = theme
  return (
    <box
      flexDirection="column"
      marginTop={1}
      border={['left']}
      borderStyle="single"
      borderColor={props.color ?? p().border}
      backgroundColor={p().panel}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={0}
      paddingBottom={0}
      marginLeft={3}
    >
      <text fg={p().muted} attributes={TextAttributes.BOLD}>
        {props.title}
      </text>
      {props.children}
    </box>
  )
}

/**
 * The model's copy-and-paste options card (offer_options). A row of lettered
 * tabs on top — click one to switch — and the selected option's body
 * underneath, rendered as markdown. "copy" puts the RAW content on the system
 * clipboard (the same 4-tier path /copy uses), which is this surface's copy
 * button. The tabs WRAP rather than scrolling sideways: the app's card scrolls
 * its row horizontally, but a terminal has no hidden horizontal overflow to
 * scroll into, so wrapping is how the same row stays fully reachable here.
 *
 * Purely presentational, like the app's card: nothing is sent back, and the
 * whole thing is rebuilt from the tool call's args on a reload.
 */
function OptionsPart(props: {
  part: Extract<Part, { kind: 'options' }>
  syntax: Accessor<SyntaxStyle>
}): JSX.Element {
  const app = useApp()
  const p = theme
  const [active, setActive] = createSignal(0)
  const options = () => props.part.options
  const current = () => options()[Math.min(active(), options().length - 1)]
  // A `language` means the content is raw code, so it is fenced HERE rather
  // than by the model — with a fence long enough to survive content that
  // carries backtick fences of its own.
  const body = (): string => {
    const option = current()
    if (!option?.language) return option?.content ?? ''
    const longest = (option.content.match(/`{3,}/g) ?? []).reduce(
      (max, run) => Math.max(max, run.length),
      2
    )
    const fence = '`'.repeat(Math.max(3, longest + 1))
    return `${fence}${option.language}\n${option.content}\n${fence}`
  }
  const copy = async (): Promise<void> => {
    const text = current()?.content ?? ''
    if (!text) return
    const { copyToClipboard } = await import('../../lib/clipboard.mjs')
    try {
      await copyToClipboard(text)
      app.toast.success(`copied option ${current()?.letter ?? ''}`.trim())
    } catch (error) {
      app.toast.error(error)
    }
  }
  return (
    <Card title={props.part.title ?? `${options().length} options to copy`} color={p().accent}>
      <box flexDirection="row" gap={2} flexWrap="wrap">
        <For each={options()}>
          {(option, i) => (
            <text
              fg={active() === i() ? p().accent : p().muted}
              attributes={active() === i() ? TextAttributes.BOLD : TextAttributes.NONE}
              onMouseUp={() => setActive(i())}
            >
              {`${option.letter} ${truncate(option.title, 24)}`}
            </text>
          )}
        </For>
        <text fg={p().dim} onMouseUp={() => void copy()}>
          {'  copy'}
        </text>
      </box>
      <Show when={current()?.description}>
        <text fg={p().muted} wrapMode="word">
          {current()?.description}
        </text>
      </Show>
      <markdown content={body()} syntaxStyle={props.syntax()} fg={p().text} />
    </Card>
  )
}

function TodoPart(props: { items: Array<{ content: string; status: string }> }): JSX.Element {
  const p = theme
  const done = () =>
    props.items.filter((i) => i.status === 'completed' || i.status === 'done').length
  return (
    <Card title={`Todo  ${done()}/${props.items.length}`}>
      <For each={props.items}>
        {(item) => {
          const status = item.status
          const mark =
            status === 'completed' || status === 'done'
              ? '[✓]'
              : status === 'in_progress' || status === 'active'
                ? '[•]'
                : '[ ]'
          const color =
            status === 'completed' || status === 'done'
              ? p().good
              : status === 'in_progress' || status === 'active'
                ? p().warn
                : p().muted
          return (
            <text fg={color} wrapMode="word">
              {mark}{' '}
              <span
                style={{ fg: status === 'completed' || status === 'done' ? p().muted : p().text }}
              >
                {item.content}
              </span>
            </text>
          )
        }}
      </For>
    </Card>
  )
}

function WorkflowPart(props: { snapshot: Record<string, unknown> }): JSX.Element {
  const p = theme
  const agents = () =>
    Array.isArray(props.snapshot.agents)
      ? (props.snapshot.agents as Array<Record<string, unknown>>)
      : []
  const phase = () => String(props.snapshot.phase ?? props.snapshot.status ?? '')
  const dot = (status: string) =>
    status === 'running'
      ? p().accent
      : status === 'completed'
        ? p().good
        : status === 'failed'
          ? p().bad
          : status === 'cancelled'
            ? p().warn
            : p().dim
  return (
    <Card title={`Workflow${phase() ? ' · ' + phase() : ''}`} color={p().accent}>
      <For each={agents()}>
        {(a) => (
          <text fg={p().text}>
            <span style={{ fg: dot(String(a.status ?? '')) }}>● </span>
            {String(a.name ?? a.role ?? 'agent')}
            <span
              style={{ fg: p().muted }}
            >{`  ${String(a.status ?? '')}${a.task ? ' · ' + truncate(String(a.task), 60) : ''}`}</span>
          </text>
        )}
      </For>
      <Show when={agents().length === 0}>
        <text fg={p().muted}>{String(props.snapshot.summary ?? 'starting…')}</text>
      </Show>
    </Card>
  )
}

function TaskPart(props: { snapshot: Record<string, unknown> }): JSX.Element {
  const app = useApp()
  const p = theme
  const status = () => String(props.snapshot.status ?? '')
  const taskId = () => String(props.snapshot.taskId ?? '')
  const running = () =>
    status() === 'running' ||
    status() === 'queued' ||
    status() === 'processing' ||
    status() === 'pending'
  const progress = () =>
    typeof props.snapshot.progress === 'number'
      ? Math.round(
          (props.snapshot.progress as number) * ((props.snapshot.progress as number) <= 1 ? 100 : 1)
        )
      : null
  return (
    <Card
      title={`Task · ${String(props.snapshot.kind ?? props.snapshot.type ?? 'generation')}`}
      color={running() ? p().accent : status() === 'failed' ? p().bad : p().good}
    >
      <box flexDirection="row" gap={1}>
        <Show
          when={running()}
          fallback={
            <text fg={status() === 'failed' ? p().bad : p().good}>
              {status() === 'failed' ? '✗' : '✓'}
            </text>
          }
        >
          <Spinner />
        </Show>
        <text fg={p().text}>
          {String(props.snapshot.label ?? props.snapshot.prompt ?? props.snapshot.title ?? '')}
          <span
            style={{ fg: p().muted }}
          >{`  ${status()}${progress() !== null ? ` · ${progress()}%` : ''}`}</span>
        </text>
      </box>
      <Show when={props.snapshot.error}>
        <text fg={p().bad}>{String(props.snapshot.error)}</text>
      </Show>
      <Show when={running() && taskId()}>
        <text
          fg={p().dim}
          onMouseUp={() => void app.client.invoke('task:cancel', { taskId: taskId() })}
        >
          {'/tasks to cancel'}
        </text>
      </Show>
    </Card>
  )
}

function CountdownPart(props: { snapshot: Record<string, unknown> }): JSX.Element {
  const app = useApp()
  const p = theme
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 500)
  onCleanup(() => clearInterval(timer))
  const status = () => String(props.snapshot.status ?? '')
  const fireAt = () =>
    typeof props.snapshot.fireAt === 'number' ? (props.snapshot.fireAt as number) : null
  const seconds = () => Number(props.snapshot.seconds ?? 0)
  const remaining = () => (fireAt() ? Math.max(0, (fireAt() as number) - now()) : seconds() * 1000)
  const active = () => status() === 'armed' || status() === 'counting'
  const label = () => String(props.snapshot.label ?? 'countdown')
  const target = () => {
    const t = props.snapshot.target as { tool?: string } | undefined
    return t?.tool ? ` → ${t.tool}` : ''
  }
  const color = () =>
    active()
      ? p().warn
      : status() === 'aborted'
        ? p().muted
        : status() === 'failed'
          ? p().bad
          : p().good
  return (
    <Card title={`Countdown · ${label()}${target()}`} color={color()}>
      <Show
        when={active()}
        fallback={
          <text fg={p().muted}>
            {status()}
            {props.snapshot.result ? ` · ${String(props.snapshot.result)}` : ''}
            {props.snapshot.error ? ` · ${String(props.snapshot.error)}` : ''}
            {props.snapshot.abortedBy ? ` · by ${String(props.snapshot.abortedBy)}` : ''}
          </text>
        }
      >
        <text fg={p().text}>
          {status() === 'armed' ? 'starts when this reply ends · ' : 'fires in '}
          <span style={{ fg: p().warn, bold: true }}>{Math.ceil(remaining() / 1000)}s</span>
          <span style={{ fg: p().dim }}>
            {'   ' + app.keymap.label('countdown_abort') + ' aborts'}
          </span>
        </text>
      </Show>
    </Card>
  )
}

/**
 * The live process card in the terminal: one line per process with its
 * state, port or URL and uptime. The buttons the desktop card has are the
 * `wolffish process stop|restart <name>` verbs here, so the hint names them.
 */
function ProcessPart(props: { snapshot: Record<string, unknown> }): JSX.Element {
  const p = theme
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 30_000)
  onCleanup(() => clearInterval(timer))
  const list = () =>
    Array.isArray(props.snapshot.processes)
      ? (props.snapshot.processes as Array<Record<string, unknown>>)
      : []
  const title = () =>
    String(props.snapshot.title ?? (list().length === 1 ? 'Process' : 'Processes'))
  const live = (state: string) =>
    state === 'starting' || state === 'running' || state === 'stopping'
  const running = () =>
    list().filter((r) => live(String((r.run as Record<string, unknown>)?.state ?? ''))).length
  const age = (ms: number) => {
    const s = Math.max(0, Math.round(ms / 1000))
    if (s < 60) return `${s}s`
    const m = Math.round(s / 60)
    if (m < 60) return `${m}m`
    const h = Math.round(m / 60)
    return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
  }
  const color = () =>
    running() > 0
      ? p().good
      : list().some((r) => (r.run as Record<string, unknown>)?.state === 'crashed')
        ? p().bad
        : p().muted
  return (
    <Card title={`${title()} · ${running()}/${list().length} running`} color={color()}>
      <For each={list()}>
        {(r) => {
          const run = (r.run ?? {}) as Record<string, unknown>
          const state = String(run.state ?? '')
          const where = run.url ? String(run.url) : run.port ? `:${run.port}` : ''
          const stamp =
            live(state) && typeof run.startedAt === 'number'
              ? `up ${age(now() - (run.startedAt as number))}`
              : typeof run.endedAt === 'number'
                ? `${age(now() - (run.endedAt as number))} ago`
                : ''
          return (
            <text>
              <span
                style={{ fg: live(state) ? p().good : state === 'crashed' ? p().bad : p().muted }}
              >
                {'● '}
              </span>
              <span style={{ fg: p().text, bold: true }}>{String(r.name)}</span>
              <span
                style={{ fg: p().muted }}
              >{` ${state}${run.exitCode !== null && run.exitCode !== undefined && !live(state) ? ` (exit ${run.exitCode})` : ''}`}</span>
              <span style={{ fg: p().accent }}>{where ? ` ${where}` : ''}</span>
              <span style={{ fg: p().dim }}>{stamp ? ` · ${stamp}` : ''}</span>
            </text>
          )
        }}
      </For>
      <text fg={p().dim}>{'wolffish process stop|restart|logs <name>'}</text>
    </Card>
  )
}

/**
 * The blocking-wait card in the terminal. No input of its own — typing in
 * the CLI composer is already a mid-turn message, which is exactly what ends
 * a wait, so the hint points there instead of inventing a second control.
 */
function WaitPart(props: { snapshot: Record<string, unknown> }): JSX.Element {
  const p = theme
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 500)
  onCleanup(() => clearInterval(timer))
  const status = () => String(props.snapshot.status ?? '')
  const waiting = () => status() === 'waiting'
  const endsAt = () =>
    typeof props.snapshot.endsAt === 'number' ? (props.snapshot.endsAt as number) : 0
  const remaining = () => Math.max(0, endsAt() - now())
  const reason = () => String(props.snapshot.reason ?? 'waiting')
  const color = () => (waiting() ? p().warn : status() === 'canceled' ? p().muted : p().good)
  return (
    <Card title={`Wait · ${reason()}`} color={color()}>
      <Show
        when={waiting()}
        fallback={
          <text fg={p().muted}>
            {status() === 'elapsed'
              ? 'waited out'
              : status() === 'interrupted'
                ? 'woken early by your message'
                : 'stopped'}
          </text>
        }
      >
        <text fg={p().text}>
          {'continues in '}
          <span style={{ fg: p().warn, bold: true }}>{formatWaitRemaining(remaining())}</span>
          <span style={{ fg: p().dim }}>{'   send a message to continue now'}</span>
        </text>
      </Show>
    </Card>
  )
}

/** "1h 4m" / "12m" / "45s" — matches the desktop card's shape. */
function formatWaitRemaining(ms: number): string {
  const s = Math.ceil(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.ceil(s / 60)}m`
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  return m ? `${h}h ${m}m` : `${h}h`
}

/**
 * A page open in Wolffish's own browser. The desktop draws the live page;
 * a terminal can only say where it is and whether it loaded — the card's
 * one-line record, matching what the PDF export prints.
 */
function BrowserPart(props: { snapshot: Record<string, unknown> }): JSX.Element {
  const p = theme
  const url = () => String(props.snapshot.url ?? '')
  const title = () => String(props.snapshot.title || url() || 'page')
  const state = () => String(props.snapshot.loadState ?? '')
  const error = () => {
    const e = props.snapshot.error as { message?: string } | null | undefined
    return e?.message ? String(e.message) : ''
  }
  const color = () => (error() ? p().warn : state() === 'loading' ? p().dim : p().good)
  return (
    <Card title={`Browser · ${title()}`} color={color()}>
      <text fg={p().muted}>
        {url()}
        <Show when={error()}>
          <span style={{ fg: p().warn }}>{`   ${error()}`}</span>
        </Show>
        <Show when={!error() && state() === 'loading'}>
          <span style={{ fg: p().dim }}>{'   loading…'}</span>
        </Show>
      </text>
    </Card>
  )
}

function CompactionPart(props: { part: Extract<Part, { kind: 'compaction' }> }): JSX.Element {
  const p = theme
  return (
    <box paddingLeft={3} marginTop={1}>
      <Show
        when={props.part.phase === 'started'}
        fallback={
          <text fg={p().muted}>
            {'⇣ compacted '}
            {plural(props.part.targetsCount ?? 0, 'result')}
            {props.part.tokensSaved
              ? ` · ${props.part.tokensSaved.toLocaleString('en-US')} tokens reclaimed`
              : ''}
            {props.part.durationMs ? ` · ${duration(props.part.durationMs)}` : ''}
          </text>
        }
      >
        <Spinner
          color={p().muted}
        >{`compacting ${plural(props.part.targetsCount ?? 0, 'result')}…`}</Spinner>
      </Show>
    </box>
  )
}

export function fileSize(n: number | undefined): string {
  return n ? bytes(n) : ''
}
