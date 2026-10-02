#!/usr/bin/env node
/**
 * Wolffish CLI — the terminal surface.
 *
 * Runs as a plain Node process (under `ELECTRON_RUN_AS_NODE` from the app's own
 * binary, so nothing extra has to be installed) and talks to the Wolffish
 * daemon over a local socket. It holds no agent state of its own: every command
 * below is a call into the same IPC handlers the desktop windows use, which is
 * what makes "everything you can do in the app" true rather than aspirational.
 *
 * Exit codes are meant for scripts: 0 success, 1 the thing failed or is not in
 * the state you asked about, 2 you used the command wrong.
 */
import { fstatSync } from 'node:fs'
import { modeIsFifo } from './lib/tty.mjs'
import { connect, daemonExecPath, daemonPid, DaemonClient } from './lib/client.mjs'

/**
 * `wolffish status | head -3` is a normal thing to type, and it used to end in
 * a Node stack trace and exit 1.
 *
 * When the reader on the other side of a pipe closes early, the next write
 * raises EPIPE — and an EPIPE with no listener is an unhandled 'error' event,
 * which crashes the process and prints twenty lines of internals over whatever
 * the user was actually reading. Every well-behaved CLI treats it as "the
 * reader has seen enough" and leaves quietly, so this one does too. Registered
 * before anything can write.
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error?.code === 'EPIPE') process.exit(0)
    throw error
  })
}
import {
  c,
  err,
  g,
  heading,
  icon,
  out,
  setColor,
  table,
  withProgress,
  wrapText
} from './lib/ui.mjs'
import { runTurn } from './lib/turn.mjs'
import { repl } from './commands/repl.mjs'
import {
  brain,
  capabilities,
  getSetting,
  manageKeys,
  setSetting,
  variables
} from './commands/settings.mjs'
import { listAllSettings, listPages, settingsBrowser } from './commands/settings-browser.mjs'
import {
  automations,
  browseFiles,
  conversations,
  customizations,
  editWorkspaceFile,
  procedures,
  projects,
  resolveConversationId,
  resolveProjectId,
  usage,
  viewFile
} from './commands/workspace.mjs'
import { pathCommand, service, status } from './commands/service.mjs'
import { processCommand } from './commands/process.mjs'
import { pair } from './commands/pair.mjs'

/**
 * The top level is the app's own nav, and nothing else.
 *
 * Chat, the five screens (conversations, projects, procedures, automations,
 * settings), the workspace, and the three machine verbs a headless box needs.
 * Everything that used to sit up here — config, keys, brain, capabilities,
 * vars, usage, soul/user/agents — was a second taxonomy to learn on top of the
 * one the window already teaches, so each is now reached where its screen is.
 * The old words still dispatch (see ALIASES); they are simply not the ones
 * anyone is told to learn.
 */
const USAGE = `
${c.bold('wolffish')} — your agent, in the terminal

${c.gray('CHAT')}
  wolffish                          open a session
  wolffish "<prompt>"               ask once, print, exit
  wolffish -p "<prompt>" -f a.pdf   attach files by path
  wolffish -p "…" --project <id>   ask inside a project
  wolffish -p "…" --plan           plan mode: read-only turn that only writes its plan file
  cat log.txt | wolffish -p "why?"  pipe context in
  wolffish resume [id]              continue a past conversation

${c.gray('THE APP, IN THE TERMINAL')}
  wolffish conversations            list · show · resume · diagnose · rm
  wolffish conversations -s <words> only the titles carrying every word
  wolffish conversations show <id>  read it back ${c.gray('· --tools · --clean · --last <n>')}
  wolffish projects                 browse ${c.gray('·')} new ${c.gray('·')} show ${c.gray('·')} edit ${c.gray('·')} copy ${c.gray('·')} paste ${c.gray('·')} rename ${c.gray('·')} rm
  wolffish procedures               browse ${c.gray('·')} new ${c.gray('·')} run ${c.gray('·')} edit ${c.gray('·')} copy ${c.gray('·')} paste ${c.gray('·')} mode ${c.gray('·')} rm
  wolffish automations              browse ${c.gray('·')} show <label> ${c.gray('·')} run <label> ${c.gray('·')} edit ${c.gray('·')} copy ${c.gray('·')} paste
  wolffish customizations           soul · user · agents ${c.gray('(view; edit · copy · paste <name>)')}
  wolffish settings                 page ${g.chevron} card ${g.chevron} setting, interactively

${c.gray('FILES AND FOLDERS — projects, procedures and automations alike')}
  wolffish <thing> files <id>              what it carries
  wolffish <thing> files <id> add <path…>  attach (copied into the workspace)
  wolffish <thing> files <id> rm <name…>   detach
  wolffish <thing> dirs <id> add <path…>   work in a folder
  wolffish <thing> dirs <id> rm <path…>    stop working in it

${c.gray('SETTINGS, DIRECTLY')}
  wolffish settings <page> [card]   e.g. settings channels telegram
  wolffish settings <name>          e.g. settings notion
  wolffish settings list [filter]   read them all, tokens redacted
  wolffish settings set <id> <val>  change one, for scripts

${c.gray('WORKSPACE')}
  wolffish files                    walk it — folders open, files open
  wolffish view <path>              read one
  wolffish edit <path>              change one

${c.gray('MACHINE')}
  wolffish status                   daemon, brain, autostart, channels
  wolffish cancel [id|--all]        stop a running turn, on any channel
  wolffish service <install|status|uninstall|stop|logs>
  wolffish process                  what the agent keeps running ${c.gray('· show · start · stop · restart · logs · autostart · rm · ports')}
  wolffish path <status|install>    make "wolffish" resolvable
  wolffish pair <phone|whatsapp|telegram>
    ${c.gray('on a box with no screen: pair phone --code, pair whatsapp --number')}

${c.gray('FLAGS')}
  --tools / --clean  show or hide tool calls, overriding the saved setting
  --last <n>         with show: only the most recent n turns
  --search / -s <words>  with conversations: narrow to the titles matching
  --json           machine-readable output where it applies
  --yes            auto-approve tool approvals for this run
  --raw            with view: print credentials instead of masking them
  --no-color       plain text

${c.gray('Anything not listed is treated as a prompt.')}
`

function parseArgs(argv) {
  const flags = {
    json: false,
    yes: false,
    long: false,
    all: false,
    raw: false,
    limit: null,
    prompt: null,
    files: [],
    conversation: null,
    project: null,
    /** Plan mode: a read-only turn that only writes the conversation's plan file. */
    plan: false,
    /** `conversations --search <words>`: narrow the listing by title. */
    search: null,
    /**
     * Null means "whatever `channels.cli.verbose` says". `--tools` and
     * `--clean` are a per-COMMAND override, which is the thing the stored
     * setting alone could not express: wanting the tool calls for one
     * transcript used to mean flipping a global preference and flipping it
     * back, and that preference also governs live turns.
     */
    tools: null,
    last: null
  }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') flags.json = true
    else if (arg === '--yes' || arg === '-y') flags.yes = true
    else if (arg === '--long' || arg === '-l') flags.long = true
    else if (arg === '--all' || arg === '-a') flags.all = true
    else if (arg === '--raw') flags.raw = true
    else if (arg === '--tools' || arg === '--verbose' || arg === '-v') flags.tools = true
    else if (arg === '--clean' || arg === '--quiet') flags.tools = false
    else if (arg === '--last') flags.last = Number.parseInt(argv[++i] ?? '', 10)
    else if (arg === '--limit') flags.limit = Number.parseInt(argv[++i] ?? '', 10)
    else if (arg === '--no-color') setColor(false)
    else if (arg === '-p' || arg === '--prompt') flags.prompt = argv[++i] ?? null
    else if (arg === '-f' || arg === '--file') flags.files.push(argv[++i])
    else if (arg === '-c' || arg === '--conversation') flags.conversation = argv[++i] ?? null
    else if (arg === '--project') flags.project = argv[++i] ?? null
    else if (arg === '--search' || arg === '-s') flags.search = argv[++i] ?? null
    else if (arg === '--plan') flags.plan = true
    else rest.push(arg)
  }
  return { flags, rest }
}

/**
 * Prompt context piped in, if any — lets `cat log | wolffish -p "why?"` work.
 *
 * Only reads when stdin is genuinely a PIPE. Testing `isTTY` alone is not
 * enough: stdin redirected from a terminal-less parent (a shell script, a
 * service manager, a CI job) is neither a TTY nor a pipe that will ever reach
 * EOF, and reading it there hangs the command forever with no output.
 *
 * The Windows launcher makes the pipe test insufficient in the other
 * direction. There stdin IS a pipe — but one carrying live keystrokes from a
 * console, not piped-in context, and it reaches EOF only when the user closes
 * the terminal. Reading it would hang exactly the interactive session it was
 * meant to serve, so the launcher's own flag settles it first.
 */
async function readStdin() {
  if (process.stdin.isTTY || process.env.WOLFFISH_TTY_STDIN === '1') return ''
  try {
    const stat = fstatSync(0)
    // `modeIsFifo`, not `stat.isFIFO()` — the latter is false for every pipe on
    // Windows. See its definition in lib/tty.mjs.
    if (!modeIsFifo(stat.mode) && !stat.isFile()) return ''
  } catch {
    return ''
  }
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8').trim()
}

async function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2))
  const [command, ...args] = rest

  if (command === 'help' || command === '--help' || command === '-h') {
    out(USAGE)
    return 0
  }
  if (command === 'version' || command === '--version') {
    const client = await connect({ autostart: false }).catch(() => null)
    if (!client) {
      out('wolffish (daemon not running)')
      return 0
    }
    const info = client.hello
    out(`wolffish ${info?.version ?? ''}`.trim())
    client.close()
    return 0
  }

  // These read the machine's own state, so they must report "not running"
  // rather than quietly starting a daemon to answer the question.
  const noAutostart = new Set(['status', 'service', 'path'])
  // Whether this command was even willing to start a daemon, which decides
  // what a failure to reach one MEANS. These three report ON the agent, so
  // launching one to answer "is it running?" would make the answer always yes.
  const attemptedStart = !noAutostart.has(command)
  let client
  try {
    client = await connect({ autostart: attemptedStart, quiet: flags.json })
  } catch {
    // Nothing suggested from here may be a command that needs a daemon —
    // which is every `service` and `path` subcommand, because dispatch happens
    // after this connect. That rules out `service logs` and `service stop`, the
    // two anyone would reach for, so these point at a pid and a binary instead:
    // a kill and a foreground run work with no daemon at all. (`service logs`
    // and `service stop` read a file and signal a pid; neither needs the
    // connection they are gated behind. Worth unpicking, but not from here.)
    const pid = daemonPid()
    if (pid) {
      err(c.red('Could not reach the Wolffish daemon.'))
      err(
        wrapText(
          c.gray(
            `A process is registered but its socket is unreachable. Stop it with: kill ${pid} — then run any command again.`
          ),
          2
        )
      )
      return 1
    }
    err(c.red('The Wolffish daemon is not running.'))
    err(
      wrapText(
        c.gray(
          attemptedStart
            ? `It could not be started either. Run it in the foreground to see why: ${daemonExecPath()} --headless --no-sandbox`
            : // NOT "e.g. wolffish status": status is one of the three that
              // will not start one either, so the old advice sent people in a
              // circle. Name something that actually does it.
              'This command reports on the agent rather than starting one. Any other command starts it — try: wolffish settings'
        ),
        2
      )
    )
    return 1
  }

  // `await` the dispatch rather than returning its promise: a bare
  // `return fn()` inside try/finally runs the finally BEFORE the promise
  // settles, which closed the socket out from under every in-flight request.
  // Feed verbosity from the stored setting rather than a flag, so the terminal
  // behaves the same however it was launched and there is one place to change
  // it (`wolffish settings`, or /verbose in a session).
  flags.verbose = await client
    .invoke('cli:getConfig')
    .then((cfg) => cfg?.verbose === true)
    .catch(() => false)
  // An explicit flag beats the stored preference, for this command only.
  if (flags.tools !== null) flags.verbose = flags.tools

  try {
    // Everything except the chat paths talks to the daemon through a client
    // that shows a spinner when a call is slow enough to notice. The chat
    // paths get the raw client: a turn already draws its own, naming the tool
    // it is running, and two spinners on one line is worse than none.
    const chat = command === undefined || command === 'resume'
    return await dispatch(chat ? client : withProgress(client), command, args, flags)
  } finally {
    // The REPL and the pairing watchers own their own lifetime; everything
    // else is done the moment its command returns. `conversations` is in the
    // list because `conversations resume <id>` lands in the REPL too.
    const OWNS_ITS_LIFETIME = new Set([
      'resume',
      'pair',
      'conversations',
      'conversation',
      'history',
      'chats',
      undefined
    ])
    if (!OWNS_ITS_LIFETIME.has(command)) client.close()
  }
}

/**
 * Words that used to be top-level commands, rewritten to where they live now.
 *
 * They keep working — muscle memory, scripts and every README that quoted them
 * are all real — but they are not advertised, because the point of the shorter
 * top level is that there is ONE name for each thing, and it is the one the
 * window uses. Only pure renames belong here: a legacy verb with a grammar of
 * its own (`keys set …`, `brain <provider> <model>`) keeps its own case below,
 * since prefixing its arguments would change what it means.
 */
const ALIASES = new Map([
  ['ls', ['conversations']],
  ['list', ['conversations']],
  ['show', ['conversations', 'show']],
  ['rm', ['conversations', 'rm']],
  ['delete', ['conversations', 'rm']],
  ['conversation', ['conversations']],
  ['history', ['conversations']],
  ['chats', ['conversations']],
  ['project', ['projects']],
  ['procedure', ['procedures']],
  ['automation', ['automations']],
  ['heartbeat', ['automations']],
  ['documents', ['customizations']],
  ['docs', ['customizations']],
  ['soul', ['customizations', 'soul']],
  ['user', ['customizations', 'user']],
  ['agents', ['customizations', 'agents']],
  ['setting', ['settings']]
])

async function dispatch(client, command, args, flags) {
  switch (command) {
    case undefined: {
      // `-p` is an explicit one-shot even with no positional prompt, and a
      // pipe on stdin is one implicitly: a script that pipes into wolffish
      // must never land in an interactive prompt it cannot answer.
      if (flags.prompt) return oneShot(client, '', flags)
      const piped = await readStdin()
      if (piped) return oneShot(client, piped, flags)
      return repl(client, { conversationId: flags.conversation, verbose: flags.verbose })
    }

    // ── The app's screens ──────────────────────────────────────────────────
    case 'conversations':
      return conversations(client, args, flags, (id) =>
        repl(client, { conversationId: id, verbose: flags.verbose })
      )

    case 'projects':
      return projects(client, args, { json: flags.json })

    case 'procedures':
      return procedures(client, args, { verbose: flags.verbose, json: flags.json })

    case 'automations':
      return automations(client, args, { json: flags.json })

    case 'customizations':
    case 'customization':
      return customizations(client, args, { json: flags.json })

    /**
     * One word for every setting. `settings` alone browses page → card → row;
     * a page, a card or any other word jumps or searches; `get`/`set`/`list`
     * are the non-interactive surface scripts want. Splitting reading from
     * writing across two commands (`config` and `settings`) was one name too
     * many for one screen.
     */
    case 'settings': {
      if (args[0] === 'get') {
        if (!args[1]) return usageError('wolffish settings get <id>')
        return getSetting(client, args[1], { json: flags.json })
      }
      if (args[0] === 'set') {
        if (!args[1] || args[2] === undefined)
          return usageError('wolffish settings set <id> <value>')
        return setSetting(client, args[1], args.slice(2).join(' '))
      }
      if (args[0] === 'list' || args[0] === 'all') {
        return listAllSettings(client, {
          group: args[1],
          json: flags.json,
          long: flags.long
        })
      }
      if (args[0] === 'pages') return listPages(client)
      return settingsBrowser(client, args, { json: flags.json })
    }

    // ── Chat entry points ──────────────────────────────────────────────────
    case 'resume': {
      const id = args[0] ? await resolveConversationId(client, args[0]) : null
      if (args[0] && !id) {
        err(c.red(`no conversation matching "${args[0]}"`))
        return 1
      }
      return repl(client, { conversationId: id, verbose: flags.verbose })
    }

    // ── Workspace ──────────────────────────────────────────────────────────
    case 'files':
    case 'file':
      return browseFiles(client, args[0])

    case 'view':
    case 'cat':
      if (!args[0]) return usageError('wolffish view <workspace path>')
      // Credentials are masked unless `--raw` says otherwise — see redact() in
      // workspace.mjs for why a viewer needs that when the rest of the CLI
      // already masks everything else. `--json` wraps the file in a record
      // rather than being quietly swallowed: it used to only turn paging off,
      // so `wolffish view x --json | jq` got raw file text and a parse error.
      return viewFile(client, args[0], {
        paged: !flags.json,
        secrets: flags.raw,
        json: flags.json
      })

    case 'edit':
      if (!args[0]) return usageError('wolffish edit <workspace path>')
      return editWorkspaceFile(client, args[0])

    // ── Machine ────────────────────────────────────────────────────────────
    case 'status':
      // `--raw` means the same here as it does for `view`: print credentials
      // instead of masking them.
      return status(client, { json: flags.json, raw: flags.raw })

    /**
     * Stop a running turn — any channel's.
     *
     * `wolffish status` lists everything running on the box, including
     * automations and channel replies. On a machine with no window that list
     * was unactionable: there was no Stop button anywhere, and the only way out
     * of a runaway automation was killing the daemon.
     */
    case 'cancel': {
      // `--all` is eaten by the flag parser before it can reach args, so the
      // flag is what this reads — `args[0] === '--all'` would never be true.
      if (!args[0] && !flags.all) {
        const snapshot = await client.invoke('cli:status').catch(() => null)
        const runs = snapshot?.activeRuns ?? []
        if (runs.length === 0) {
          out(c.gray('  nothing is running'))
          return 0
        }
        heading(`Running now ${c.gray(`(${runs.length})`)}`)
        table(
          ['conversation', 'channel', 'title'],
          runs.map((run) => [
            c.gray(String(run.conversationId).slice(0, 8)),
            run.channel ?? '—',
            run.title ?? c.gray('Untitled')
          ])
        )
        out()
        out(c.gray('  wolffish cancel <id>   ·   wolffish cancel --all'))
        return 0
      }
      if (flags.all || args[0] === 'all') {
        const snapshot = await client.invoke('cli:status').catch(() => null)
        const runs = snapshot?.activeRuns ?? []
        if (runs.length === 0) {
          out(c.gray('  nothing is running'))
          return 0
        }
        let stopped = 0
        for (const run of runs) {
          const result = await client
            .invoke('cli:cancel', run.conversationId)
            .catch(() => ({ canceled: false }))
          if (result?.canceled) stopped++
        }
        out(`${icon.ok()} stopped ${stopped} of ${runs.length}`)
        return stopped === runs.length ? 0 : 1
      }
      const id = await resolveConversationId(client, args[0])
      if (!id) {
        err(c.red(`no conversation matching "${args[0]}"`))
        return 1
      }
      const result = await client.invoke('cli:cancel', id).catch(() => ({ canceled: false }))
      if (!result?.canceled) {
        out(c.gray('  that conversation was not running'))
        return 1
      }
      out(`${icon.ok()} stopped ${c.gray(id)}`)
      return 0
    }

    case 'service':
      return service(client, args)

    case 'process':
    case 'processes':
      return processCommand(client, args, flags)

    case 'path':
      return pathCommand(client, args)

    case 'pair':
      return pair(client, args)

    // ── Retired verbs, still honoured ──────────────────────────────────────
    // Each kept its own grammar, so each keeps its own case. Their homes are
    // now cards inside `wolffish settings`.
    case 'config':
      return dispatch(
        client,
        'settings',
        args[0] === 'get' || args[0] === 'set' ? args : ['list', ...args],
        flags
      )

    case 'keys':
      return manageKeys(client, args)

    case 'brain':
      return brain(client, args)

    case 'capabilities':
    case 'caps':
      return capabilities(client, args)

    case 'vars':
    case 'variables':
      return variables(client, args)

    case 'usage':
      return usage(client, args[0] ?? 'this_month', { json: flags.json })

    default: {
      const alias = ALIASES.get(command)
      if (alias) {
        const [target, ...prefix] = alias
        return dispatch(client, target, [...prefix, ...args], flags)
      }
      /**
       * Anything unrecognized is a prompt, so `wolffish "why is the disk full"`
       * works without remembering -p.
       *
       * With ONE exception: a single bare word, close to a command that exists.
       * `wolffish setings` is a typo, not a question, and sending it as a
       * prompt spends a real turn and real money to be told the agent does not
       * understand. Multi-word input is always a prompt — that is what people
       * actually type — and `-p` forces the prompt for the single-word case.
       */
      const typo = args.length === 0 && !flags.prompt ? nearestCommand(command) : null
      if (typo) {
        err(c.red(`unknown command: ${command}`))
        err(c.gray(`  did you mean: wolffish ${typo}`))
        err(c.gray(`  to ask it as a question instead: wolffish -p "${command}"`))
        return 2
      }
      const text = [command, ...args].join(' ')
      return oneShot(client, text, flags)
    }
  }
}

/** Every word the dispatcher answers to, advertised or not. */
const COMMANDS = [
  'help',
  'version',
  'conversations',
  'projects',
  'procedures',
  'automations',
  'customizations',
  'settings',
  'resume',
  'files',
  'view',
  'edit',
  'status',
  'cancel',
  'service',
  'path',
  'pair',
  'config',
  'keys',
  'brain',
  'capabilities',
  'vars',
  'usage',
  ...ALIASES.keys()
]

/**
 * The closest command to what was typed, or null if nothing is close.
 *
 * Levenshtein with a tight budget: one or two characters for a short word,
 * three for a long one. Loose matching here would be worse than none — it would
 * refuse to answer genuine one-word questions like "status?" or "why" — so the
 * bar is "this is a misspelling of a real command", not "this vaguely rhymes".
 */
function nearestCommand(word) {
  const target = String(word).toLowerCase()
  if (target.length < 3) return null
  const budget = target.length <= 5 ? 1 : target.length <= 9 ? 2 : 3
  let best = null
  let bestScore = Infinity
  for (const candidate of COMMANDS) {
    const score = distance(target, candidate)
    if (score < bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return bestScore > 0 && bestScore <= budget ? best : null
}

function distance(a, b) {
  const rows = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let previous = rows[0]
    rows[0] = i
    for (let j = 1; j <= b.length; j++) {
      const swap = rows[j]
      rows[j] = Math.min(rows[j] + 1, rows[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = swap
    }
  }
  return rows[b.length]
}

async function oneShot(client, text, flags) {
  const piped = await readStdin()
  const prompt = [flags.prompt, text, piped].filter(Boolean).join('\n\n').trim()
  if (!prompt) return usageError('wolffish -p "<prompt>"')

  /**
   * `--yes` flips an APP-WIDE, PERSISTED safety setting, so putting it back is
   * not optional and "put back false" is not correct either.
   *
   * Two things were wrong with the first version. It restored the literal
   * `false` rather than what was there before, so one `--yes` run silently
   * turned OFF a bypass the user had deliberately left ON. And it restored only
   * on the happy path: a Ctrl-C, a dropped SSH session or a crashed turn left
   * every surface — this terminal, the desktop, the phone — running with
   * approvals disabled, permanently and invisibly. The restore is therefore
   * both value-preserving and attached to the ways this process can die.
   */
  let restoreBypass = null
  if (flags.yes) {
    const before = await client
      .invoke('cli:status')
      .then((snapshot) => snapshot?.workspace?.config?.safety?.bypassPermissions === true)
      .catch(() => false)
    await client.invoke('runtime:setBypassPermissions', true).catch(() => undefined)
    restoreBypass = () =>
      client.invoke('runtime:setBypassPermissions', before).catch(() => undefined)
    const onDeath = () => {
      void restoreBypass()
      // Give the write a moment to reach the daemon; the socket is the only
      // way back and an immediate exit would cut it mid-flight.
      setTimeout(() => process.exit(130), 150)
    }
    process.once('SIGINT', onDeath)
    process.once('SIGTERM', onDeath)
    process.once('SIGHUP', onDeath)
  }
  /**
   * `--project` binds the turn to a project, the way opening a project in the
   * app does — its instructions and its attached files come along. `cli:send`
   * has taken projectId all along; the flag was simply never wired, so the one
   * feature a project exists for was unreachable from a terminal.
   */
  const projectId = flags.project ? await resolveProjectId(client, flags.project) : null
  if (flags.project && !projectId) {
    err(c.red(`no project matching "${flags.project}"`))
    return 1
  }
  const result = await runTurn(
    client,
    {
      text: prompt,
      conversationId: flags.conversation,
      projectId,
      planMode: flags.plan === true,
      attachmentPaths: flags.files.length ? flags.files : undefined
    },
    { verbose: flags.verbose }
  ).catch((error) => ({ error: error?.message ?? String(error) }))
  if (restoreBypass) await restoreBypass()
  if (result.error) return 1
  if (!flags.json) {
    out()
    out(c.gray(`  wolffish resume ${result.conversationId}`))
  }
  return 0
}

function usageError(line) {
  err(c.red(`usage: ${line}`))
  return 2
}

/**
 * Run as a program only when this file IS the program. The compiled TUI
 * client imports this module for its verbs (parseArgs, dispatch, oneShot)
 * and must not start a second main().
 */
const isEntry = (() => {
  try {
    const arg = process.argv[1] ?? ''
    return arg.endsWith('wolffish.mjs')
  } catch {
    return false
  }
})()

if (isEntry)
  main()
    .then((code) => {
      process.exitCode = code ?? 0
      // The socket keeps the event loop alive; commands that finished have
      // nothing left to wait for.
      if (process.exitCode !== undefined)
        setTimeout(() => process.exit(process.exitCode), 10).unref()
    })
    .catch((error) => {
      err(`${icon.fail()} ${c.red(error?.message ?? String(error))}`)
      process.exit(1)
    })

export {
  DaemonClient,
  heading,
  table,
  parseArgs,
  dispatch,
  readStdin,
  oneShot,
  USAGE,
  nearestCommand
}
