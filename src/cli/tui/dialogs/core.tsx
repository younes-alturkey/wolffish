/**
 * The everyday dialogs: palette, conversations, model, thinking, mode,
 * project, theme, help, pending cards, status, files, keybinds.
 * Every one is the same select list with a different data source.
 */
import { TextAttributes } from '@opentui/core'
import { createSignal, For, onMount, Show, type JSX } from 'solid-js'
import { useApp } from '../context'
import {
  basename,
  bytes,
  money,
  plural,
  relativeTime,
  shortPath,
  tokens,
  truncate
} from '../format'
import { DEFINITIONS, type ActionName } from '../keymap'
import type { PendingCard, ThinkingMode } from '../store'
import { setTheme, theme, THEMES, type ThemeName } from '../theme'
import { ask, confirm, DialogHeader, DialogSelect, type SelectOption } from '../ui/Dialog'

/* ───────────────────────── palette ───────────────────────── */

export function CommandPalette(): JSX.Element {
  const app = useApp()
  const options: SelectOption<string>[] = app.commands
    .all()
    .filter((c) => c.name !== 'palette')
    .map((c) => ({
      title: c.title,
      value: c.name,
      description: c.slash ? `/${c.slash}` : undefined,
      category: c.category,
      footer: c.key ? app.keymap.label(c.key) : undefined
    }))
  return (
    <DialogSelect
      title="Commands"
      options={options}
      placeholder="Search commands"
      onSelect={(o) => {
        app.dialog.clear()
        const command = app.commands.all().find((c) => c.name === o.value)
        void command?.run('')
      }}
    />
  )
}

/* ───────────────────────── conversations ───────────────────────── */

type Meta = {
  id: string
  title: string
  updatedAt: number
  channel?: string
  messageCount: number
  projectId?: string
}

export function ConversationsDialog(): JSX.Element {
  const app = useApp()
  const [state] = app.store
  const [rows, setRows] = createSignal<Meta[]>([])
  const [loading, setLoading] = createSignal(true)
  onMount(() => {
    app.dialog.setSize('large')
    void app.client
      .invoke<Meta[]>('conversation:list')
      .then((list) => setRows([...list].sort((a, b) => b.updatedAt - a.updatedAt)))
      .catch((e) => app.toast.error(e))
      .finally(() => setLoading(false))
  })
  const category = (m: Meta) => {
    const d = new Date(m.updatedAt)
    const today = new Date()
    if (d.toDateString() === today.toDateString()) return 'Today'
    const yesterday = new Date(today.getTime() - 86_400_000)
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
    return d.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric'
    })
  }
  const options = () =>
    rows().map((m) => {
      const running = state.runs.some((r) => r.conversationId === m.id)
      return {
        title: m.title || 'Untitled',
        value: m.id,
        description: running ? '● working' : undefined,
        category: category(m),
        footer: `${m.channel && m.channel !== 'electron' ? m.channel + ' · ' : ''}${plural(m.messageCount, 'msg')} · ${relativeTime(m.updatedAt)}`
      }
    })
  return (
    <DialogSelect
      title="Conversations"
      options={options()}
      loading={loading()}
      current={state.conversationId ?? undefined}
      placeholder="Search by title"
      emptyText="No conversations yet"
      onSelect={(o) => {
        app.dialog.clear()
        void app.actions.openConversation(o.value)
      }}
      actions={[
        {
          key: 'session_rename',
          title: 'rename',
          onTrigger: (o) => {
            void (async () => {
              const title = await ask(app, { title: 'Rename conversation', value: o.title })
              if (title === null) return
              const conv = await app.client
                .invoke<Record<string, unknown>>('conversation:load', o.value)
                .catch(() => null)
              if (!conv) return
              await app.client
                .invoke('conversation:save', { ...conv, title })
                .catch((e) => app.toast.error(e))
              app.toast.success('renamed')
              if (state.conversationId === o.value) app.store[1]('title', title)
              app.dialog.replace(() => <ConversationsDialog />)
            })()
          }
        },
        {
          key: 'dialog_delete',
          title: 'delete',
          confirm: 'press delete again to confirm',
          onTrigger: (o) => {
            void (async () => {
              const result = await app.client
                .invoke<{ ok?: boolean; refused?: string } | void>('conversation:delete', o.value)
                .catch((e) => ({ refused: String(e) }))
              if (result && typeof result === 'object' && 'refused' in result && result.refused)
                app.toast.error(result.refused)
              else app.toast.success('deleted')
              if (state.conversationId === o.value) app.actions.newConversation()
              setRows((r) => r.filter((m) => m.id !== o.value))
            })()
          }
        }
      ]}
      hints={['enter open']}
    />
  )
}

/* ───────────────────────── model ───────────────────────── */

type Provider = {
  id: string
  model: string
  apiKey: string
  models?: string[]
  reasoningModels?: string[]
}

export function ModelDialog(): JSX.Element {
  const app = useApp()
  const [state] = app.store
  const [providers, setProviders] = createSignal<Provider[]>([])
  const [local, setLocal] = createSignal<string[]>([])
  const [loading, setLoading] = createSignal(true)
  onMount(() => {
    void (async () => {
      const list = await app.client.invoke<Provider[]>('provider:list').catch(() => [])
      setProviders(list)
      const installed = await app.client
        .invoke<Array<{ name: string } | string>>('ollama:listInstalled')
        .catch(() => [])
      setLocal((installed ?? []).map((m) => (typeof m === 'string' ? m : m.name)))
      setLoading(false)
    })()
  })
  const recent = () => app.kv.get<Array<{ provider: string; model: string }>>('recentModels', [])
  const options = () => {
    const out: SelectOption<{ provider: string; model: string }>[] = []
    const seen = new Set<string>()
    for (const r of recent()) {
      const key = `${r.provider}/${r.model}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ title: r.model, value: r, description: r.provider, category: 'Recent' })
    }
    for (const p of providers()) {
      const models = p.models && p.models.length ? p.models : p.model ? [p.model] : []
      for (const m of models) {
        const key = `${p.id}/${m}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
          title: m,
          value: { provider: p.id, model: m },
          category: p.id,
          description: p.reasoningModels?.includes(m) ? 'reasoning' : undefined,
          footer: p.apiKey ? undefined : 'no key',
          disabled: !p.apiKey
        })
      }
    }
    for (const m of local()) {
      const key = `local/${m}`
      if (seen.has(key)) continue
      out.push({ title: m, value: { provider: 'local', model: m }, category: 'local (Ollama)' })
    }
    return out
  }
  return (
    <DialogSelect
      title="Switch model"
      options={options()}
      loading={loading()}
      current={
        state.brain.provider && state.brain.model
          ? { provider: state.brain.provider, model: state.brain.model }
          : undefined
      }
      placeholder="Search models"
      emptyText="No models — add a provider key in /settings"
      onSelect={(o) => {
        void (async () => {
          try {
            await app.actions.setBrain(o.value.provider, o.value.model)
            app.kv.set(
              'recentModels',
              [
                o.value,
                ...recent().filter(
                  (r) => r.provider !== o.value.provider || r.model !== o.value.model
                )
              ].slice(0, 8)
            )
            app.toast.success(`brain: ${o.value.provider}/${o.value.model}`)
            if (state.thinkingModes.length > 1) app.dialog.replace(() => <ThinkingDialog />)
            else app.dialog.clear()
          } catch (error) {
            app.toast.error(error)
          }
        })()
      }}
      hints={['enter choose']}
    />
  )
}

/* ───────────────────────── thinking ───────────────────────── */

export function ThinkingDialog(): JSX.Element {
  const app = useApp()
  const [state] = app.store
  const labels: Record<ThinkingMode, string> = {
    off: 'no extended thinking',
    on: 'model decides',
    high: 'deeper reasoning',
    max: 'maximum budget'
  }
  const options = (
    state.thinkingModes.length ? state.thinkingModes : (['off'] as ThinkingMode[])
  ).map((m) => ({
    title: m,
    value: m,
    description: labels[m]
  }))
  return (
    <DialogSelect
      title={`Thinking effort · ${state.brain.model ?? ''}`}
      options={options}
      current={state.thinking}
      onSelect={(o) => {
        app.dialog.clear()
        void app.actions.setThinking(o.value, true)
        app.toast.success(`thinking: ${o.value}`)
      }}
      hints={['saved for this model']}
    />
  )
}

/* ───────────────────────── mode ───────────────────────── */

export function ModeDialog(): JSX.Element {
  const app = useApp()
  const [state] = app.store
  return (
    <DialogSelect
      title="Chat mode"
      options={[
        { title: 'single', value: 'single' as const, description: 'one agent answers' },
        {
          title: 'workflow',
          value: 'workflow' as const,
          description: 'a master delegates to workers'
        }
      ]}
      current={state.chatMode}
      onSelect={(o) => {
        app.dialog.clear()
        void app.actions.setChatMode(o.value)
      }}
    />
  )
}

/* ───────────────────────── project ───────────────────────── */

export function ProjectDialog(): JSX.Element {
  const app = useApp()
  const [state] = app.store
  const [rows, setRows] = createSignal<
    Array<{ id: string; title: string; icon?: string; description?: string }>
  >([])
  const [loading, setLoading] = createSignal(true)
  onMount(() => {
    void app.client
      .invoke<Array<{ id: string; title: string; icon?: string; description?: string }>>(
        'projects:list'
      )
      .then(setRows)
      .catch((e) => app.toast.error(e))
      .finally(() => setLoading(false))
  })
  const options = () => [
    { title: 'none', value: null as string | null, description: 'no project on this conversation' },
    ...rows().map((p) => ({
      title: `${p.icon ? p.icon + ' ' : ''}${p.title}`,
      value: p.id as string | null,
      description: p.description ? truncate(p.description, 40) : undefined
    }))
  ]
  return (
    <DialogSelect
      title="Project"
      options={options()}
      loading={loading()}
      current={state.projectId}
      onSelect={(o) => {
        app.dialog.clear()
        const hit = rows().find((p) => p.id === o.value)
        app.actions.setProject(o.value, hit?.title ?? null)
        app.toast.success(o.value ? `project: ${hit?.title}` : 'no project')
      }}
      hints={['applies to the next message']}
    />
  )
}

/* ───────────────────────── theme ───────────────────────── */

export function ThemeDialog(props: { onChosen: () => void }): JSX.Element {
  const app = useApp()
  const before = theme().name
  return (
    <DialogSelect
      title="Theme"
      options={THEMES.map((t) => ({
        title: t,
        value: t as ThemeName,
        description: t === 'mono' ? 'for terminals without truecolor' : undefined
      }))}
      current={before}
      onMove={(o) => setTheme(o.value)}
      onSelect={(o) => {
        props.onChosen()
        setTheme(o.value)
        app.kv.set('theme', o.value)
        app.dialog.clear()
      }}
      hints={['previews as you move']}
    />
  )
}

/** Open the theme picker, reverting the live preview if it is dismissed. */
export function openThemeDialog(app: ReturnType<typeof useApp>): void {
  const before = theme().name
  let chosen = false
  app.dialog.replace(
    () => <ThemeDialog onChosen={() => (chosen = true)} />,
    () => {
      if (!chosen) setTheme(before)
    }
  )
}

/* ───────────────────────── help / keybinds ───────────────────────── */

export function HelpDialog(): JSX.Element {
  const app = useApp()
  onMount(() => app.dialog.setSize('large'))
  const options = app.commands
    .all()
    .filter((c) => c.slash)
    .map((c) => ({
      title: `/${c.slash}${c.argHint ? ' ' + c.argHint : ''}`,
      value: c.name,
      description: c.description ?? c.title,
      category: c.category,
      footer: c.key ? app.keymap.label(c.key) : undefined
    }))
  return (
    <DialogSelect
      title="Help — slash commands and keys"
      options={options}
      placeholder="Search"
      onSelect={(o) => {
        app.dialog.clear()
        void app.commands
          .all()
          .find((c) => c.name === o.value)
          ?.run('')
      }}
      hints={['/keybinds for every key', 'esc close']}
    />
  )
}

export function KeybindsDialog(): JSX.Element {
  const app = useApp()
  onMount(() => app.dialog.setSize('large'))
  const options = (Object.keys(DEFINITIONS) as ActionName[]).map((name) => ({
    title: DEFINITIONS[name].description,
    value: name,
    description: name,
    footer: app.keymap.label(name) || 'unbound',
    category:
      name.startsWith('input_') || name.startsWith('history_')
        ? 'Editor'
        : name.startsWith('dialog_') || name.startsWith('card_')
          ? 'Dialogs and cards'
          : 'App'
  }))
  return (
    <DialogSelect
      title="Keybinds"
      options={options}
      placeholder="Search"
      onSelect={() => app.dialog.clear()}
      hints={['override with a "keybinds" object in ~/.wolffish/workspace/cli-state.json']}
    />
  )
}

/* ───────────────────────── pending cards ───────────────────────── */

export function PendingDialog(): JSX.Element {
  const app = useApp()
  const [state] = app.store
  const options = () =>
    state.parked.map((card: PendingCard) => ({
      title:
        card.kind === 'approval'
          ? `approve ${card.tool}`
          : `answer ${plural(card.questions.length, 'question')}`,
      value: card.id,
      description: card.kind === 'approval' ? truncate(card.reason, 50) : undefined
    }))
  return (
    <DialogSelect
      title="Parked approvals and questions"
      options={options()}
      emptyText="Nothing is waiting"
      onSelect={(o) => {
        app.dialog.clear()
        const card = state.parked.find((c) => c.id === o.value)
        if (card) app.actions.answerParked(card)
      }}
    />
  )
}

/* ───────────────────────── files ───────────────────────── */

export function FilesDialog(): JSX.Element {
  const app = useApp()
  const [state] = app.store
  const [sizes, setSizes] = createSignal<Record<string, number>>({})
  onMount(() => {
    void (async () => {
      const { statSync } = await import('node:fs')
      const out: Record<string, number> = {}
      for (const f of state.files) {
        try {
          out[f.path] = statSync(f.path).size
        } catch {
          /* gone */
        }
      }
      setSizes(out)
    })()
  })
  const options = () =>
    state.files.map((f) => ({
      title: basename(f.path),
      value: f.index,
      description: shortPath(f.path),
      footer: `${f.kind}${sizes()[f.path] ? ' · ' + bytes(sizes()[f.path]) : ''}`,
      category: 'Delivered this session'
    }))
  const staged = () =>
    state.stagedAttachments.map((p, i) => ({
      title: basename(p),
      value: -(i + 1),
      description: shortPath(p),
      category: 'Staged for the next message'
    }))
  return (
    <DialogSelect
      title="Files"
      options={[...staged(), ...options()]}
      emptyText="No files yet — @path attaches one; the agent's deliveries land here"
      onSelect={(o) => {
        if (o.value < 0) return
        app.dialog.clear()
        const file = state.files.find((f) => f.index === o.value)
        if (file) void openExternal(app, file.path)
      }}
      actions={[
        {
          key: 'dialog_delete',
          title: 'remove',
          onTrigger: (o) => {
            if (o.value < 0) {
              const idx = -o.value - 1
              app.store[1]('stagedAttachments', (s) => s.filter((_, i) => i !== idx))
            }
          }
        }
      ]}
      hints={['enter open with the OS']}
    />
  )
}

export async function openExternal(app: ReturnType<typeof useApp>, target: string): Promise<void> {
  const { spawn } = await import('node:child_process')
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target]
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.unref()
    app.toast.info(`opened ${basename(target)}`)
  } catch (error) {
    app.toast.error(error)
  }
}

/* ───────────────────────── status ───────────────────────── */

export function StatusDialog(): JSX.Element {
  const app = useApp()
  const [status, setStatus] = createSignal<Record<string, any> | null>(null)
  onMount(() => {
    app.dialog.setSize('large')
    void app.client
      .invoke<Record<string, any>>('cli:status', process.env.PATH ?? null)
      .then(setStatus)
      .catch((e) => app.toast.error(e))
  })
  app.dialog.setKeyHandler((key) => {
    if (key.name === 'escape' || key.name === 'return' || key.name === 'q') app.dialog.clear()
  })
  const p = theme
  const Row = (r: { k: string; v: JSX.Element }) => (
    <box flexDirection="row" paddingLeft={3}>
      <text fg={p().muted}>{r.k.padEnd(14)}</text>
      <text fg={p().text}>{r.v}</text>
    </box>
  )
  const Section = (s: { title: string; children: JSX.Element }) => (
    <box flexDirection="column" marginTop={1}>
      <box paddingLeft={3}>
        <text fg={p().accent} attributes={TextAttributes.BOLD}>
          {s.title}
        </text>
      </box>
      {s.children}
    </box>
  )
  return (
    <box flexDirection="column">
      <DialogHeader title="Status" />
      <Show
        when={status()}
        fallback={
          <box paddingLeft={3} marginTop={1}>
            <text fg={p().muted}>Loading…</text>
          </box>
        }
      >
        {(s) => {
          const brain = s().workspace?.config?.llm?.brain ?? {}
          const auto = s().autostart ?? {}
          const pathInfo = s().path ?? {}
          const channels = Array.isArray(s().channels) ? s().channels : []
          const runs = Array.isArray(s().activeRuns) ? s().activeRuns : []
          return (
            <box flexDirection="column">
              <Section title="Daemon">
                <Row k="version" v={String(s().version ?? '')} />
                <Row k="pid" v={String(s().cli?.pid ?? '?')} />
                <Row k="mode" v={s().headless ? 'headless' : 'desktop'} />
                <Row k="platform" v={String(s().platform ?? '')} />
                <Row k="clients" v={String(s().cli?.clients ?? 0)} />
              </Section>
              <Section title="Brain">
                <Row
                  k="model"
                  v={
                    brain.model ? (
                      `${brain.model}  ${brain.providerId ?? ''}`
                    ) : (
                      <span style={{ fg: p().warn }}>not configured</span>
                    )
                  }
                />
                <Row k="mode" v={String(s().workspace?.config?.llm?.mode ?? 'single')} />
              </Section>
              <Section title="Autostart">
                <Row
                  k="registered"
                  v={
                    auto.active ? (
                      <span style={{ fg: p().good }}>yes</span>
                    ) : (
                      <span style={{ fg: p().warn }}>no</span>
                    )
                  }
                />
                <Row k="mechanism" v={String(auto.mechanism ?? 'unknown')} />
                <Show when={auto.warning}>
                  <Row
                    k="warning"
                    v={<span style={{ fg: p().warn }}>{String(auto.warning)}</span>}
                  />
                </Show>
              </Section>
              <Section title="Command">
                <Row
                  k="on PATH"
                  v={
                    pathInfo.installed ? (
                      <span style={{ fg: p().good }}>yes</span>
                    ) : pathInfo.needsPathEntry && pathInfo.profileHasEntry ? (
                      <span style={{ fg: p().warn }}>not yet — open a new terminal</span>
                    ) : (
                      <span style={{ fg: p().bad }}>no — wolffish path install</span>
                    )
                  }
                />
                <Row k="shim" v={shortPath(String(pathInfo.target ?? ''))} />
              </Section>
              <Show when={channels.length > 0}>
                <Section title="Channels">
                  <For each={channels}>
                    {(ch: any) => (
                      <Row
                        k={String(ch.label ?? ch.id)}
                        v={
                          ch.connected ? (
                            <span style={{ fg: p().good }}>connected</span>
                          ) : (
                            <span style={{ fg: p().muted }}>{String(ch.state ?? 'off')}</span>
                          )
                        }
                      />
                    )}
                  </For>
                </Section>
              </Show>
              <Show when={runs.length > 0}>
                <Section title="Running now">
                  <For each={runs}>
                    {(run: any) => (
                      <Row
                        k={String(run.channel ?? '—')}
                        v={String(run.title ?? run.conversationId)}
                      />
                    )}
                  </For>
                </Section>
              </Show>
              <box paddingLeft={3} marginTop={1}>
                <text fg={p().dim}>esc close</text>
              </box>
            </box>
          )
        }}
      </Show>
    </box>
  )
}

/* ───────────────────────── info ───────────────────────── */

export function InfoDialog(): JSX.Element {
  const app = useApp()
  const [state] = app.store
  app.dialog.setKeyHandler((key) => {
    if (key.name === 'escape' || key.name === 'return' || key.name === 'q') app.dialog.clear()
  })
  const p = theme
  const pct = () =>
    state.meter.budget ? Math.round((state.meter.tokens / state.meter.budget) * 100) : 0
  const Row = (r: { k: string; v: string }) => (
    <box flexDirection="row" paddingLeft={3}>
      <text fg={p().muted}>{r.k.padEnd(12)}</text>
      <text fg={p().text}>{r.v}</text>
    </box>
  )
  return (
    <box flexDirection="column">
      <DialogHeader title={state.title ?? 'New conversation'} />
      <box flexDirection="column" marginTop={1}>
        <Row k="messages" v={String(state.feed.length)} />
        <Row
          k="context"
          v={
            state.meter.budget
              ? `${tokens(state.meter.tokens)} / ${tokens(state.meter.budget)} (${pct()}%)`
              : 'unknown'
          }
        />
        <Show when={state.meter.compactionAt}>
          <Row k="compacts at" v={tokens(state.meter.compactionAt ?? 0)} />
        </Show>
        <Show when={state.allTime}>
          <Row
            k="tokens"
            v={`${tokens(state.allTime?.inputTokens)} in · ${tokens(state.allTime?.outputTokens)} out`}
          />
          <Row k="turns" v={String(state.allTime?.turns ?? 0)} />
        </Show>
        <Row k="cost" v={money(state.cost)} />
        <Row
          k="model"
          v={state.brain.model ? `${state.brain.provider}/${state.brain.model}` : '—'}
        />
        <Row k="thinking" v={state.thinking} />
        <Row k="mode" v={state.chatMode + (state.planMode ? ' · plan' : '')} />
        <Show when={state.projectTitle}>
          <Row k="project" v={state.projectTitle ?? ''} />
        </Show>
        <Show when={state.conversationId}>
          <Row k="id" v={state.conversationId ?? ''} />
        </Show>
      </box>
      <box paddingLeft={3} marginTop={1}>
        <text fg={p().dim}>esc close</text>
      </box>
    </box>
  )
}

export { confirm }
