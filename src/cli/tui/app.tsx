/**
 * The TUI: renderer, providers, routes, and the one global key router.
 *
 * Key routing, in order: a dialog if one is open; a pending card if one is
 * showing; otherwise the session (registry keybinds first, then the prompt).
 * Global listeners run before the focused textarea sees a key, so anything
 * consumed here is preventDefault()ed and never reaches the editor.
 */
import {
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
  type ScrollBoxRenderable
} from '@opentui/core'
import { render, useKeyboard, useTerminalDimensions } from '@opentui/solid'
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
  type JSX
} from 'solid-js'
import { produce } from 'solid-js/store'
import type { DaemonClient } from '../lib/client'
import { CommandRegistry } from './commands'
import { Context, type AppContext, type PromptHandle, type Scope } from './context'
import { Keymap, type Overrides } from './keymap'
import { registerCommands } from './register'
import { createAppStore } from './store'
import { createActions } from './sync'
import { createSyntaxStyle } from './syntax'
import { setTheme, theme, type ThemeName } from './theme'
import { withSuspendedRenderer } from './legacy'
import { createDialogManager, DialogHost } from './ui/Dialog'
import { createToastManager, ToastView } from './ui/Toast'
import { Feed } from './components/Feed'
import { Home } from './components/Home'
import { Prompt } from './components/Prompt'
import { ApprovalCard, QuestionCard } from './components/Cards'
import { Sidebar } from './components/Sidebar'

export type TuiOptions = {
  conversationId?: string | null
  initialPrompt?: string | null
  attachments?: string[]
  projectId?: string | null
  plan?: boolean
}

export async function runTui(client: DaemonClient, options: TuiOptions = {}): Promise<void> {
  const renderer = await createCliRenderer({
    targetFps: 60,
    gatherStats: false,
    exitOnCtrlC: false,
    useKittyKeyboard: {},
    autoFocus: false,
    openConsoleOnError: false,
    useMouse: process.env.WOLFFISH_NO_MOUSE !== '1',
    screenMode: 'alternate-screen',
    consoleOptions: { keyBindings: [{ name: 'y', ctrl: true, action: 'copy-selection' }] }
  })
  client.autoReconnect = true

  // Pick the palette from the terminal before first paint so nothing flashes.
  const mode = (await renderer.waitForThemeMode(800).catch(() => null)) ?? 'dark'

  let exitReason: string | undefined
  const done = new Promise<void>((resolve) => {
    renderer.once('destroy', () => resolve())
  })
  const exit = (reason?: string) => {
    exitReason = reason
    if (!renderer.isDestroyed) {
      renderer.setTerminalTitle('')
      renderer.destroy()
    }
  }
  process.on('SIGHUP', () => exit())

  await render(
    () => (
      <App renderer={renderer} client={client} options={options} exit={exit} themeMode={mode} />
    ),
    renderer
  )
  await done
  if (exitReason) process.stderr.write(exitReason + '\n')
}

function App(props: {
  renderer: CliRenderer
  client: DaemonClient
  options: TuiOptions
  exit: (reason?: string) => void
  themeMode: 'dark' | 'light'
}): JSX.Element {
  const store = createAppStore()
  const [state, set] = store
  const toast = createToastManager()
  const dialog = createDialogManager()
  const commands = new CommandRegistry()
  const [kvState, setKvState] = createSignal<Record<string, unknown>>({})
  const [kvReady, setKvReady] = createSignal(false)
  const [entry, setEntry] = createSignal<{
    element: () => JSX.Element
    onClose?: () => void
  } | null>(null)

  const actions = createActions({
    client: props.client,
    store,
    notify: (message, variant = 'info') => toast.show({ message, variant })
  })

  const kv: AppContext['kv'] = {
    get: (key, fallback) => (kvState()[key] as typeof fallback) ?? fallback,
    set: (key, value) => {
      setKvState((s) => ({ ...s, [key]: value }))
      void props.client.invoke('cli:kvSet', { [key]: value }).catch(() => undefined)
    }
  }

  let keymap = new Keymap()
  const scope = createMemo<Scope>(() =>
    dialog.open() ? 'dialog' : state.card ? 'card' : 'session'
  )

  const app: AppContext = {
    renderer: props.renderer,
    client: props.client,
    store,
    keymap,
    dialog,
    toast,
    actions,
    commands,
    scope,
    kv,
    exit: props.exit,
    cardKeys: null,
    promptKeys: null,
    prompt: null as PromptHandle | null,
    scroll: null,
    suspend: (run) => withSuspendedRenderer(props.renderer, run)
  }

  // Dialog entries are tracked through a signal so the host re-renders.
  const originalReplace = dialog.replace
  const originalClear = dialog.clear
  dialog.replace = (element, onClose) => {
    originalReplace(element, onClose)
    setEntry({ element, onClose })
  }
  dialog.clear = () => {
    originalClear()
    setEntry(null)
    app.prompt?.focus()
  }

  registerCommands(app)

  /* ───────── bootstrap ───────── */
  onMount(() => {
    void (async () => {
      const saved: Record<string, unknown> =
        (await props.client.invoke<Record<string, unknown>>('cli:kvGet').catch(() => ({}))) ?? {}
      setKvState(saved ?? {})
      setKvReady(true)
      const themeName =
        (saved?.theme as ThemeName | undefined) ??
        (props.themeMode === 'light' ? 'wolffish-light' : 'wolffish-dark')
      setTheme(themeName)
      if (saved?.keybinds && typeof saved.keybinds === 'object') {
        keymap = new Keymap(saved.keybinds as Overrides)
        app.keymap = keymap
      }
      set('showThinking', saved?.showThinking === true)
      set('sidebar', saved?.sidebar === true)
      await actions.bootstrap()
      if (props.options.projectId) {
        const projects = await props.client
          .invoke<Array<{ id: string; title: string }>>('projects:list')
          .catch(() => [])
        const hit = projects.find(
          (p) => p.id === props.options.projectId || p.title === props.options.projectId
        )
        if (hit) actions.setProject(hit.id, hit.title)
      }
      if (props.options.plan) void actions.setPlanMode(true)
      if (props.options.conversationId) await actions.openConversation(props.options.conversationId)
      if (props.options.attachments?.length) set('stagedAttachments', props.options.attachments)
      if (props.options.initialPrompt) void actions.send(props.options.initialPrompt)
    })()
  })
  onCleanup(() => actions.dispose())

  createEffect(() => {
    const title = state.title ? `Wolffish · ${state.title.slice(0, 40)}` : 'Wolffish'
    props.renderer.setTerminalTitle(title)
  })
  createEffect(() => {
    const bg = theme().background
    if (bg) props.renderer.setBackgroundColor(bg)
  })

  /* ───────── the key router ───────── */
  useKeyboard((key: KeyEvent) => {
    const consume = () => {
      key.preventDefault()
      key.stopPropagation()
    }
    // Exit is global but only when the prompt is empty (ctrl+c clears first).
    const current = scope()
    if (current === 'dialog') {
      dialog.handleKey(key)
      consume()
      return
    }
    if (current === 'card') {
      if (app.cardKeys?.(key)) consume()
      return
    }
    // Session: registry keybinds, then the prompt.
    const fired = keymap.resolve(key, [
      ...commands.keyed(),
      'app_exit',
      'messages_page_up',
      'messages_page_down',
      'messages_first',
      'messages_last',
      'tool_expand',
      'countdown_abort',
      'session_sidebar'
    ])
    if (fired === 'pending') {
      consume()
      return
    }
    if (fired === 'app_exit') {
      const text = app.prompt?.getText() ?? ''
      if (key.ctrl && key.name === 'c' && text.trim().length > 0) {
        // Let the prompt's clear handle it.
      } else {
        consume()
        props.exit()
        return
      }
    } else if (fired === 'messages_page_up') return void (consume(), app.scroll?.('up'))
    else if (fired === 'messages_page_down') return void (consume(), app.scroll?.('down'))
    else if (fired === 'messages_first') return void (consume(), app.scroll?.('top'))
    else if (fired === 'messages_last') return void (consume(), app.scroll?.('bottom'))
    else if (fired === 'session_sidebar') {
      consume()
      set('sidebar', (s) => !s)
      kv.set('sidebar', state.sidebar)
      return
    } else if (fired === 'tool_expand') {
      consume()
      toggleLastTool()
      return
    } else if (fired === 'countdown_abort') {
      const id = activeCountdownId()
      if (id) {
        consume()
        void props.client.invoke('countdown:abort', { countdownId: id }).catch(() => undefined)
        toast.info('countdown aborted')
        return
      }
    } else if (fired) {
      const command = commands.byKey(fired)
      if (command) {
        consume()
        void command.run('')
        return
      }
    }
    if (app.promptKeys?.(key)) consume()
  })

  const toggleLastTool = () => {
    for (let i = state.feed.length - 1; i >= 0; i--) {
      const m = state.feed[i]
      if (m.kind !== 'assistant') continue
      for (let j = m.parts.length - 1; j >= 0; j--) {
        const part = m.parts[j]
        if (part.kind === 'tool' && (part.output || part.meta)) {
          set(
            'feed',
            i,
            produce((m) => {
              if (m.kind !== 'assistant') return
              const t = m.parts[j]
              if (t.kind === 'tool') t.expanded = !t.expanded
            })
          )
          return
        }
      }
    }
  }
  const activeCountdownId = (): string | null => {
    for (let i = state.feed.length - 1; i >= 0; i--) {
      const m = state.feed[i]
      if (m.kind !== 'assistant') continue
      for (const part of m.parts) {
        if (part.kind === 'countdown') {
          const s = part.snapshot as Record<string, unknown>
          const status = String(s.status ?? '')
          if (status === 'armed' || status === 'counting') return String(s.countdownId ?? '')
        }
      }
    }
    return null
  }

  return (
    <Context.Provider value={app}>
      <Show
        when={kvReady()}
        fallback={
          <box paddingLeft={2} paddingTop={1}>
            <text fg={theme().muted}>connecting…</text>
          </box>
        }
      >
        <Screen />
      </Show>
      <DialogHost manager={dialog} entry={entry} />
      <ToastView manager={toast} />
    </Context.Provider>
  )
}

function Screen(): JSX.Element {
  const app = useAppInternal()
  const [state] = app.store
  const dims = useTerminalDimensions()
  const syntax = createSyntaxStyle(app.renderer)
  const wide = () => dims().width > 120
  const sidebarVisible = () =>
    state.sidebar || (wide() && state.conversationId !== null && state.feed.length > 0)
  const contentWidth = () => dims().width - (sidebarVisible() ? 42 : 0) - 4
  let feedBox: ScrollBoxRenderable | undefined
  app.scroll = (how) => {
    if (!feedBox) return
    const page = Math.max(1, Math.floor(dims().height / 2))
    if (how === 'up') feedBox.scrollBy(-page)
    else if (how === 'down') feedBox.scrollBy(page)
    else if (how === 'top') feedBox.scrollTo(0)
    else feedBox.scrollTo(feedBox.scrollHeight)
  }
  const p = theme
  return (
    <box flexDirection="row" width={dims().width} height={dims().height}>
      <box flexGrow={1} flexDirection="column" paddingBottom={0}>
        <box
          flexDirection="row"
          paddingLeft={2}
          paddingRight={2}
          justifyContent="space-between"
          height={1}
        >
          <text fg={p().muted} wrapMode="none">
            <span style={{ fg: p().accent }}>⋈ </span>
            {state.title ? state.title.slice(0, Math.max(10, contentWidth() - 30)) : 'Wolffish'}
          </text>
          <text fg={p().dim} wrapMode="none">
            {state.runs.filter((r) => r.conversationId !== state.conversationId).length > 0
              ? `${state.runs.filter((r) => r.conversationId !== state.conversationId).length} working elsewhere · `
              : ''}
            {state.connection === 'connected' ? `v${state.version ?? ''}` : state.connection}
          </text>
        </box>
        <Show
          when={state.feed.length > 0}
          fallback={
            <box flexGrow={1} justifyContent="center">
              <Home />
            </box>
          }
        >
          <Feed
            syntax={syntax}
            width={contentWidth}
            ref={(r) => {
              feedBox = r
            }}
          />
        </Show>
        <box
          flexShrink={0}
          flexDirection="column"
          paddingLeft={2}
          paddingRight={2}
          paddingBottom={0}
        >
          <Show when={state.card?.kind === 'approval'}>
            <ApprovalCard card={state.card as never} />
          </Show>
          <Show when={state.card?.kind === 'ask'}>
            <QuestionCard card={state.card as never} />
          </Show>
          <Show when={!state.card}>
            <Prompt onSubmit={() => app.scroll?.('bottom')} />
          </Show>
        </box>
      </box>
      <Show when={sidebarVisible()}>
        <Sidebar />
      </Show>
    </box>
  )
}

// Local alias so Screen can use the context without a circular import.
import { useApp as useAppInternal } from './context'
