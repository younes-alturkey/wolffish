/**
 * wolffish — the terminal client, compiled with Bun.
 *
 * Three doors, decided here:
 *   wolffish                      the TUI (raw TTY, no prompt given)
 *   wolffish -p "…" / piped       one shot: stream, print, exit
 *   wolffish <verb> …             the app's screens as commands
 *
 * The verbs and the one-shot path are the classic modules under commands/
 * and lib/, unchanged; the TUI is tui/. All three share one socket client.
 */
import { connect, daemonExecPath, daemonPid } from './lib/client'
// The classic CLI, kept for every verb and for one-shot mode.
import { dispatch, oneShot, parseArgs, readStdin, USAGE } from './wolffish.mjs'
import { c, err, out, setColor, withProgress, wrapText } from './lib/ui.mjs'
import { resolveConversationId, resolveProjectId } from './commands/workspace.mjs'

declare const WOLFFISH_CLI_VERSION: string | undefined

for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error?.code === 'EPIPE') process.exit(0)
    throw error
  })
}

async function main(): Promise<number> {
  const { flags, rest } = parseArgs(process.argv.slice(2)) as {
    flags: Record<string, any>
    rest: string[]
  }
  const [command, ...args] = rest

  if (command === 'help' || command === '--help' || command === '-h') {
    out(USAGE)
    return 0
  }
  if (command === 'version' || command === '--version') {
    const client = await connect({ autostart: false }).catch(() => null)
    const own = typeof WOLFFISH_CLI_VERSION === 'string' ? WOLFFISH_CLI_VERSION : 'dev'
    if (!client) {
      out(`wolffish ${own} (daemon not running)`)
      return 0
    }
    out(`wolffish ${client.hello?.version ?? own}`)
    client.close()
    return 0
  }

  const noAutostart = new Set(['status', 'service', 'path'])
  const attemptedStart = !noAutostart.has(command)
  let client
  try {
    client = await connect({ autostart: attemptedStart, quiet: flags.json })
  } catch {
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
            : 'This command reports on the agent rather than starting one. Any other command starts it — try: wolffish settings'
        ),
        2
      )
    )
    return 1
  }

  flags.verbose = await client
    .invoke<{ verbose?: boolean }>('cli:getConfig')
    .then((cfg) => cfg?.verbose === true)
    .catch(() => false)
  if (flags.tools !== null) flags.verbose = flags.tools

  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true
  const piped = !process.stdin.isTTY

  // The TUI: no verb, no -p, a real terminal on both ends.
  if (
    (command === undefined || command === 'resume') &&
    !flags.prompt &&
    interactive &&
    !piped &&
    process.env.WOLFFISH_CLASSIC !== '1'
  ) {
    const { runTui } = await import('./tui/app')
    let conversationId: string | null = flags.conversation ?? null
    if (command === 'resume' && args[0]) {
      conversationId = (await resolveConversationId(client, args[0])) ?? null
      if (!conversationId) {
        err(c.red(`no conversation matching "${args[0]}"`))
        client.close()
        return 1
      }
    }
    if (command === 'resume' && !args[0] && !conversationId) {
      // `wolffish resume` with nothing: open the picker inside the TUI.
      process.env.WOLFFISH_OPEN_CONVERSATIONS = '1'
    }
    try {
      await runTui(client, {
        conversationId,
        projectId: flags.project ?? null,
        plan: flags.plan === true,
        attachments: flags.files ?? []
      })
    } finally {
      client.close()
    }
    return 0
  }

  // One shot: an explicit prompt, or context on stdin.
  if (command === undefined) {
    const stdin = await readStdin()
    if (!flags.prompt && !stdin) {
      out(USAGE)
      client.close()
      return 2
    }
    const code = await oneShot(client, '', flags)
    client.close()
    return code
  }

  try {
    const chat = command === 'resume'
    return await dispatch(chat ? client : withProgress(client), command, args, flags)
  } finally {
    const owns = new Set(['resume', 'pair', 'conversations', 'conversation', 'history', 'chats'])
    if (!owns.has(command)) client.close()
  }
}

void setColor
void resolveProjectId

main()
  .then((code) => {
    process.exitCode = code ?? 0
    setTimeout(() => process.exit(process.exitCode), 10).unref()
  })
  .catch((error) => {
    err(c.red(error?.message ?? String(error)))
    process.exit(1)
  })
