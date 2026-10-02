/**
 * Every command the TUI knows, registered against the palette, the slash
 * completer, the keymap and /help at once.
 */
import type { AppContext } from './context'
import { basename } from './format'
import {
  CommandPalette,
  ConversationsDialog,
  FilesDialog,
  HelpDialog,
  InfoDialog,
  KeybindsDialog,
  ModeDialog,
  ModelDialog,
  openExternal,
  openThemeDialog,
  PendingDialog,
  ProjectDialog,
  StatusDialog,
  ThinkingDialog
} from './dialogs/core'
import {
  AutomationsDialog,
  newProject,
  ProceduresDialog,
  ProjectsDialog,
  RunsDialog,
  TasksDialog
} from './dialogs/library'
import { openSettings } from './dialogs/settings'
import { UsageDialog } from './dialogs/usage'
import { runClassic } from './dialogs/classic'
import { confirm } from './ui/Dialog'
import { pressEnter } from './legacy'
import type { ThinkingMode } from './store'

export function registerCommands(app: AppContext): void {
  const { commands, dialog, actions, store, toast } = app
  const [state, set] = store
  const open = (element: () => import('solid-js').JSX.Element) => dialog.replace(element)

  commands.register(
    /* ───────── chat ───────── */
    {
      name: 'palette',
      title: 'Command palette',
      category: 'View',
      key: 'command_palette',
      run: () => open(() => CommandPalette())
    },
    {
      name: 'help',
      title: 'Help',
      category: 'View',
      slash: 'help',
      aliases: ['?'],
      key: 'help_show',
      description: 'slash commands and keys',
      run: () => open(() => HelpDialog())
    },
    {
      name: 'keybinds',
      title: 'Keybinds',
      category: 'View',
      slash: 'keybinds',
      aliases: ['keys-list'],
      description: 'every key and what it does',
      run: () => open(() => KeybindsDialog())
    },
    {
      name: 'new',
      title: 'New conversation',
      category: 'Chat',
      slash: 'new',
      aliases: ['clear'],
      key: 'session_new',
      description: 'start fresh',
      run: () => actions.newConversation()
    },
    {
      name: 'conversations',
      title: 'Conversations',
      category: 'Chat',
      slash: 'conversations',
      aliases: ['resume', 'list', 'ls', 'switch', 'history'],
      key: 'session_list',
      description: 'open, rename, delete',
      run: () => open(() => ConversationsDialog())
    },
    {
      name: 'read',
      title: 'Read a conversation without switching',
      category: 'Chat',
      slash: 'read',
      argHint: '<id>',
      description: 'print a transcript on the plain terminal',
      run: (args) =>
        runClassic(app, 'conversations', ['show', ...args.split(/\s+/).filter(Boolean)])
    },
    {
      name: 'info',
      title: 'Conversation info',
      category: 'Chat',
      slash: 'info',
      aliases: ['about'],
      key: 'session_info',
      description: 'context, tokens, cost',
      run: () => open(() => InfoDialog())
    },
    {
      name: 'rename',
      title: 'Rename conversation',
      category: 'Chat',
      slash: 'rename',
      argHint: '<title>',
      key: 'session_rename',
      enabled: () => state.conversationId !== null,
      run: async (args) => {
        const { ask } = await import('./ui/Dialog')
        const title =
          args.trim() ||
          (await ask(app, { title: 'Rename conversation', value: state.title ?? '' }))
        if (!title || !state.conversationId) return
        const conv = await app.client
          .invoke<Record<string, unknown>>('conversation:load', state.conversationId)
          .catch(() => null)
        if (!conv) return
        await app.client
          .invoke('conversation:save', { ...conv, title })
          .catch((e) => toast.error(e))
        set('title', title)
        toast.success('renamed')
      }
    },
    {
      name: 'cancel',
      title: 'Stop the running turn',
      category: 'Chat',
      slash: 'cancel',
      aliases: ['stop'],
      enabled: () => state.working,
      run: () => actions.cancel()
    },
    {
      name: 'pending',
      title: 'Parked approvals',
      category: 'Chat',
      slash: 'pending',
      description: 'answer cards left from an earlier session',
      run: () => open(() => PendingDialog())
    },
    {
      name: 'copy',
      title: 'Copy last answer',
      category: 'Chat',
      slash: 'copy',
      key: 'session_copy',
      description: 'to the clipboard',
      run: async () => {
        const last = [...state.feed].reverse().find((m) => m.kind === 'assistant')
        const text =
          last && last.kind === 'assistant'
            ? last.parts
                .filter((p) => p.kind === 'text')
                .map((p) => (p as { text: string }).text)
                .join('\n\n')
            : ''
        if (!text) return toast.warning('nothing to copy yet')
        const { copyToClipboard } = await import('../lib/clipboard.mjs')
        try {
          await copyToClipboard(text)
          toast.success('copied')
        } catch (error) {
          toast.error(error)
        }
      }
    },
    {
      name: 'export',
      title: 'Export transcript',
      category: 'Chat',
      slash: 'export',
      argHint: '[path]',
      key: 'session_export',
      description: 'markdown to a file',
      enabled: () => state.conversationId !== null,
      run: async (args) => {
        if (!state.conversationId) return
        const fs = await import('node:fs/promises')
        const path = await import('node:path')
        const conv = await app.client
          .invoke<Record<string, any>>('conversation:load', state.conversationId)
          .catch(() => null)
        if (!conv) return toast.error('could not load the conversation')
        const lines: string[] = [
          `# ${conv.title ?? 'Conversation'}`,
          '',
          `Exported ${new Date().toISOString()}`,
          ''
        ]
        for (const m of conv.messages ?? []) {
          lines.push(
            m.role === 'user' ? '## You' : '## Wolffish',
            '',
            String(m.content ?? '')
              .replace(/^\[wolffish-(output|path):.*$/gm, '')
              .trim(),
            ''
          )
        }
        const target =
          args.trim() || path.join(process.cwd(), `wolffish-${state.conversationId.slice(0, 8)}.md`)
        await fs.writeFile(target, lines.join('\n'), 'utf8')
        toast.success(`exported to ${target}`)
      }
    },
    {
      name: 'diagnose',
      title: 'Diagnostic bundle',
      category: 'Chat',
      slash: 'diagnose',
      aliases: ['diagnostics'],
      description: 'zip everything about this conversation',
      enabled: () => state.conversationId !== null,
      run: () => runClassic(app, 'conversations', ['diagnose', state.conversationId ?? ''])
    },
    {
      name: 'thinking',
      title: 'Show or hide reasoning',
      category: 'View',
      slash: 'thinking',
      key: 'session_thinking',
      run: () => {
        set('showThinking', (s) => !s)
        app.kv.set('showThinking', state.showThinking)
        toast.info(state.showThinking ? 'reasoning shown' : 'reasoning collapsed')
      }
    },
    {
      name: 'verbose',
      title: 'Show or hide tool details',
      category: 'View',
      slash: 'verbose',
      aliases: ['tools'],
      argHint: '[on|off]',
      key: 'session_tools',
      run: (args) => {
        const on = args.trim() === 'on' ? true : args.trim() === 'off' ? false : !state.verbose
        void actions.setVerbose(on)
        toast.info(on ? 'verbose on' : 'verbose off')
      }
    },
    {
      name: 'sidebar',
      title: 'Toggle sidebar',
      category: 'View',
      slash: 'sidebar',
      run: () => {
        set('sidebar', (s) => !s)
        app.kv.set('sidebar', state.sidebar)
      }
    },
    {
      name: 'theme',
      title: 'Theme',
      category: 'View',
      slash: 'theme',
      key: 'theme_list',
      run: () => openThemeDialog(app)
    },

    /* ───────── controls ───────── */
    {
      name: 'model',
      title: 'Switch model',
      category: 'Controls',
      slash: 'model',
      aliases: ['brain'],
      argHint: '[provider model]',
      key: 'model_list',
      run: async (args) => {
        const [provider, model] = args.trim().split(/\s+/)
        if (provider && model) {
          try {
            await actions.setBrain(provider, model)
            toast.success(`brain: ${provider}/${model}`)
          } catch (error) {
            toast.error(error)
          }
          return
        }
        open(() => ModelDialog())
      }
    },
    {
      name: 'think',
      title: 'Thinking effort',
      category: 'Controls',
      slash: 'think',
      aliases: ['effort', 'reasoning'],
      argHint: '[off|on|high|max]',
      key: 'thinking_cycle',
      run: (args) => {
        const modes = state.thinkingModes
        const word = args.trim() as ThinkingMode
        if (word && modes.includes(word)) {
          void actions.setThinking(word, true)
          toast.success(`thinking: ${word}`)
          return
        }
        if (modes.length <= 1) return toast.info('this model has no thinking control')
        if (!word && dialog.open()) return
        // From the key: cycle. From the slash with no arg: pick.
        if (args === '' && !dialog.open()) {
          const i = modes.indexOf(state.thinking)
          const next = modes[(i + 1) % modes.length]
          void actions.setThinking(next, true)
          toast.info(`thinking: ${next}`)
          return
        }
        open(() => ThinkingDialog())
      }
    },
    {
      name: 'think-pick',
      title: 'Choose thinking effort',
      category: 'Controls',
      hidden: true,
      run: () => open(() => ThinkingDialog())
    },
    {
      name: 'mode',
      title: 'Chat mode',
      category: 'Controls',
      slash: 'mode',
      argHint: '[single|workflow]',
      run: (args) => {
        const word = args.trim()
        if (word === 'single' || word === 'workflow') return void actions.setChatMode(word)
        open(() => ModeDialog())
      }
    },
    {
      name: 'plan',
      title: 'Toggle plan mode',
      category: 'Controls',
      slash: 'plan',
      argHint: '[on|off]',
      key: 'plan_toggle',
      description: 'read-only turns that only write the plan file',
      run: (args) => {
        const on = args.trim() === 'on' ? true : args.trim() === 'off' ? false : !state.planMode
        void actions.setPlanMode(on)
        toast.info(on ? 'plan mode on' : 'plan mode off')
      }
    },
    {
      name: 'project',
      title: 'Bind a project',
      category: 'Controls',
      slash: 'project',
      argHint: '[name|none]',
      key: 'project_list',
      run: async (args) => {
        const word = args.trim()
        if (word === 'none' || word === 'off') return actions.setProject(null, null)
        if (word) {
          const projects = await app.client
            .invoke<Array<{ id: string; title: string }>>('projects:list')
            .catch(() => [])
          const hit = projects.find(
            (p) =>
              p.id === word ||
              p.title.toLowerCase() === word.toLowerCase() ||
              p.title.toLowerCase().includes(word.toLowerCase())
          )
          if (hit) return actions.setProject(hit.id, hit.title)
          toast.warning(`no project matching "${word}"`)
        }
        open(() => ProjectDialog())
      }
    },

    /* ───────── files ───────── */
    {
      name: 'attach',
      title: 'Attach a file',
      category: 'Files',
      slash: 'attach',
      argHint: '<path…>',
      key: 'attach_file',
      description: 'stage files for the next message (@path works too)',
      run: async (args) => {
        const fs = await import('node:fs')
        const path = await import('node:path')
        const home = process.env.HOME ?? ''
        const parts = args.match(/"[^"]+"|'[^']+'|\S+/g) ?? []
        if (parts.length === 0) return toast.info('type @ to pick a file, or /attach <path>')
        for (const raw of parts) {
          const cleaned = raw.replace(/^['"]|['"]$/g, '').replace(/^~/, home)
          const full = path.resolve(process.cwd(), cleaned)
          if (!fs.existsSync(full)) {
            toast.error(`not found: ${cleaned}`)
            continue
          }
          if (!state.stagedAttachments.includes(full)) set('stagedAttachments', (s) => [...s, full])
          toast.success(`attached ${basename(full)}`)
        }
      }
    },
    {
      name: 'files',
      title: 'Files',
      category: 'Files',
      slash: 'files',
      aliases: ['staged'],
      description: 'delivered and staged files',
      run: () => open(() => FilesDialog())
    },
    {
      name: 'open',
      title: 'Open a delivered file',
      category: 'Files',
      slash: 'open',
      argHint: '<n>',
      run: (args) => {
        const n = Number.parseInt(args, 10)
        const file = state.files.find((f) => f.index === n)
        if (!file) return open(() => FilesDialog())
        void openExternal(app, file.path)
      }
    },
    {
      name: 'save',
      title: 'Save a delivered file elsewhere',
      category: 'Files',
      slash: 'save',
      argHint: '<n> <dest>',
      run: async (args) => {
        const [n, ...rest] = args.trim().split(/\s+/)
        const file = state.files.find((f) => f.index === Number.parseInt(n, 10))
        const dest = rest.join(' ')
        if (!file || !dest) return toast.warning('usage: /save <n> <destination>')
        const fs = await import('node:fs/promises')
        const path = await import('node:path')
        let target = path.resolve(dest.replace(/^~/, process.env.HOME ?? ''))
        try {
          const stat = await fs.stat(target).catch(() => null)
          if (stat?.isDirectory()) target = path.join(target, basename(file.path))
          await fs.copyFile(file.path, target)
          toast.success(`saved to ${target}`)
        } catch (error) {
          toast.error(error)
        }
      }
    },
    {
      name: 'workspace',
      title: 'Browse the workspace',
      category: 'Files',
      slash: 'workspace',
      aliases: ['ws'],
      argHint: '[path]',
      run: (args) => runClassic(app, 'files', args ? [args] : [])
    },
    {
      name: 'view',
      title: 'View a workspace file',
      category: 'Files',
      slash: 'view',
      aliases: ['cat'],
      argHint: '<path>',
      run: (args) => runClassic(app, 'view', [args])
    },
    {
      name: 'edit',
      title: 'Edit a workspace file',
      category: 'Files',
      slash: 'edit',
      argHint: '<path>',
      run: (args) => runClassic(app, 'edit', [args])
    },
    {
      name: 'editor',
      title: 'Open the draft in $EDITOR',
      category: 'Files',
      slash: 'editor',
      key: 'editor_open',
      run: async () => {
        const { editText } = await import('../lib/editor.mjs')
        const draft = app.prompt?.getText() ?? ''
        await app.suspend(async () => {
          const result = await editText(draft, 'prompt.md', { label: 'prompt' as unknown as null })
          if (typeof result === 'string') app.prompt?.setText(result)
        })
      }
    },

    /* ───────── library ───────── */
    {
      name: 'projects',
      title: 'Projects',
      category: 'Library',
      slash: 'projects',
      argHint: '[new <title>]',
      run: (args) => {
        if (args.trim().startsWith('new')) return newProject(app)
        open(() => ProjectsDialog())
      }
    },
    {
      name: 'procedures',
      title: 'Procedures',
      category: 'Library',
      slash: 'procedures',
      run: (args) =>
        args.trim()
          ? runClassic(app, 'procedures', args.split(/\s+/))
          : open(() => ProceduresDialog())
    },
    {
      name: 'automations',
      title: 'Automations',
      category: 'Library',
      slash: 'automations',
      aliases: ['heartbeat'],
      run: (args) =>
        args.trim()
          ? runClassic(app, 'automations', args.split(/\s+/))
          : open(() => AutomationsDialog())
    },
    {
      name: 'runs',
      title: 'Running now',
      category: 'Library',
      slash: 'runs',
      description: 'turns and automations in flight',
      run: () => open(() => RunsDialog())
    },
    {
      name: 'tasks',
      title: 'Background tasks',
      category: 'Library',
      slash: 'tasks',
      description: 'generation tasks in this conversation',
      run: () => open(() => TasksDialog())
    },
    {
      name: 'customizations',
      title: 'Customizations',
      category: 'Library',
      slash: 'customizations',
      aliases: ['docs', 'soul', 'user', 'agents'],
      argHint: '[soul|user|agents]',
      description: 'soul · user · agents documents',
      run: (args) => runClassic(app, 'customizations', args.split(/\s+/).filter(Boolean))
    },

    /* ───────── settings ───────── */
    {
      name: 'settings',
      title: 'Settings',
      category: 'Settings',
      slash: 'settings',
      aliases: ['config'],
      argHint: '[page|name]',
      key: 'settings_open',
      run: (args) => openSettings(app, args)
    },
    {
      name: 'set',
      title: 'Set a setting directly',
      category: 'Settings',
      slash: 'set',
      argHint: '<id> <value>',
      run: async (args) => {
        const [id, ...rest] = args.trim().split(/\s+/)
        if (!id || rest.length === 0) return toast.warning('usage: /set <id> <value>')
        try {
          await app.client.invoke('cli:setSetting', { id, value: rest.join(' ') })
          toast.success(`${id} saved`)
          void actions.refreshSnapshot()
        } catch (error) {
          toast.error(error)
        }
      }
    },
    {
      name: 'keys',
      title: 'Provider keys',
      category: 'Settings',
      slash: 'keys',
      description: 'list, add or test API keys',
      run: (args) => runClassic(app, 'keys', args.split(/\s+/).filter(Boolean))
    },
    {
      name: 'capabilities',
      title: 'Capabilities',
      category: 'Settings',
      slash: 'capabilities',
      aliases: ['caps'],
      run: (args) => runClassic(app, 'capabilities', args.split(/\s+/).filter(Boolean))
    },
    {
      name: 'vars',
      title: 'Prompt variables',
      category: 'Settings',
      slash: 'vars',
      aliases: ['variables'],
      run: (args) => runClassic(app, 'vars', args.split(/\s+/).filter(Boolean))
    },
    {
      name: 'mcp',
      title: 'MCP servers',
      category: 'Settings',
      slash: 'mcp',
      run: () => openSettings(app, 'servers')
    },

    /* ───────── machine ───────── */
    {
      name: 'status',
      title: 'Status',
      category: 'Machine',
      slash: 'status',
      key: 'status_open',
      description: 'daemon, brain, channels, runs',
      run: () => open(() => StatusDialog())
    },
    {
      name: 'usage',
      title: 'Usage',
      category: 'Machine',
      slash: 'usage',
      argHint: '[range]',
      key: 'usage_open',
      description: 'tokens and cost',
      run: (args) => open(() => UsageDialog({ range: args.trim() || undefined }))
    },
    {
      name: 'pair',
      title: 'Pair a channel',
      category: 'Machine',
      slash: 'pair',
      argHint: '<phone|whatsapp|telegram>',
      run: (args) => runClassic(app, 'pair', args.split(/\s+/).filter(Boolean))
    },
    {
      name: 'logs',
      title: 'Daemon log tail',
      category: 'Machine',
      slash: 'logs',
      run: () => runClassic(app, 'service', ['logs'])
    },
    {
      name: 'service',
      title: 'Service',
      category: 'Machine',
      slash: 'service',
      argHint: '<status|install|uninstall|stop>',
      run: (args) => runClassic(app, 'service', args.split(/\s+/).filter(Boolean))
    },
    {
      name: 'restart',
      title: 'Restart the daemon',
      category: 'Machine',
      slash: 'restart',
      description: 'stop it; the next command starts it again',
      run: async () => {
        const ok = await confirm(app, {
          title: 'Restart the daemon',
          message:
            'Stops the running Wolffish process. Automations and channels pause until it comes back on the next command.',
          confirmLabel: 'stop',
          danger: true
        })
        if (!ok) return
        await runClassic(app, 'service', ['stop'])
      }
    },
    {
      name: 'exit',
      title: 'Exit',
      category: 'Machine',
      slash: 'exit',
      aliases: ['quit', 'q'],
      key: 'app_exit',
      description: 'leave — the agent keeps running',
      run: () => app.exit()
    }
  )

  void pressEnter
}
