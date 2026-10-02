/**
 * `wolffish status`, `wolffish service …`, `wolffish path …`.
 *
 * These three exist because a headless install has questions a desktop never
 * asks: is the agent actually running, will it come back after a reboot, and
 * can the shell even find this command. All three fail quietly by nature — a
 * daemon that isn't running looks like a hang, autostart that didn't register
 * looks fine until the reboot, and a missing PATH entry looks like the CLI was
 * never installed — so each one reports what is TRUE, not what was requested.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { c, heading, icon, keyValue, out, shortPath, table, wrapText } from '../lib/ui.mjs'
import { daemonPid } from '../lib/client.mjs'
import { editorSummary } from '../lib/editor.mjs'

/**
 * Every key-shaped value in the status snapshot, replaced.
 *
 * `cli:status` carries the whole workspace config, which includes every
 * provider API key and the Telegram bot token in clear. `--json` is the form
 * people pipe into a file, paste into an issue, or leave in a CI log, and on a
 * shared VPS that is the entire credential set leaving the box. The rest of
 * the CLI already masks — `settings list` does — so this brings the one
 * command that did not into line.
 *
 * Keyed on the NAME rather than the value: a redactor that guesses from shape
 * misses a short key and mangles an unrelated hash.
 */
const SECRET_KEY = /(apikey|api_key|token|password|secret|clientsecret|refresh_token)$/i

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (!value || typeof value !== 'object') return value
  const copy = {}
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY.test(key) && typeof entry === 'string' && entry.length > 0) {
      copy[key] = `${entry.slice(0, 4)}${'•'.repeat(8)}`
    } else {
      copy[key] = redactSecrets(entry)
    }
  }
  return copy
}

export async function status(client, { json, raw = false } = {}) {
  // Our PATH, not the daemon's — a service-managed daemon has a minimal one
  // and would report every working shim as missing.
  const snapshot = await client.invoke('cli:status', process.env.PATH ?? null)
  if (json) {
    out(JSON.stringify(raw ? snapshot : redactSecrets(snapshot), null, 2))
    return 0
  }

  heading(`Wolffish ${c.gray(snapshot.version ?? '')}`)
  keyValue([
    ['daemon', `${icon.ok()} running ${c.gray(`pid ${snapshot.cli?.pid ?? '?'}`)}`],
    [
      'mode',
      snapshot.headless ? c.cyan('headless') : c.cyan('desktop') + c.gray(' (window available)')
    ],
    ['clients', String(snapshot.cli?.clients ?? 0)],
    ['platform', String(snapshot.platform ?? '')]
  ])

  // The brain lives at workspace.config.llm.brain — `{ providerId, model }`.
  // Reading `workspace.model` / `workspace.brain`, as this did, found nothing
  // on every machine there has ever been, so a fully configured install was
  // told to go and configure itself.
  const brain = snapshot.workspace?.config?.llm?.brain ?? null
  const local = snapshot.workspace?.config?.llm?.local ?? null
  heading('Brain')
  keyValue([
    [
      'model',
      brain?.model
        ? `${c.bold(String(brain.model))}${brain.providerId ? c.gray(`  ${brain.providerId}`) : ''}`
        : c.yellow('not configured')
    ],
    ['mode', c.gray(String(snapshot.workspace?.config?.llm?.mode ?? 'single'))],
    ...(local?.enabled
      ? [['local', c.gray(`${local.model ?? '?'} · ${local.provider ?? ''}`)]]
      : [])
  ])
  if (!brain?.model)
    out(c.gray('    wolffish keys set anthropic && wolffish brain anthropic <model>'))

  heading('Autostart')
  const auto = snapshot.autostart ?? {}
  keyValue([
    ['registered', auto.active ? c.green('yes') : c.yellow('no')],
    ['mechanism', c.gray(String(auto.mechanism ?? 'unknown'))],
    ...(auto.location ? [['location', c.gray(shortPath(auto.location))]] : [])
  ])
  if (auto.warning) {
    out()
    out(`  ${icon.warn()} ${c.yellow(wrapText(auto.warning, 0).trim())}`)
  }
  if (!auto.active) out(c.gray('    enable with: wolffish service install'))

  heading('Command')
  const p = snapshot.path ?? {}
  const editor = editorSummary()
  keyValue([
    ['on PATH', p.installed ? c.green('yes') : c.red('no')],
    ['shim', c.gray(shortPath(p.target ?? ''))],
    ...(p.resolved ? [['resolves to', c.gray(shortPath(p.resolved))]] : []),
    // Which editor an "Edit …" menu entry will open. It used to be whatever
    // `$EDITOR` said and nothing when that was unset, which was most machines —
    // so this is now both answerable and always a real answer.
    ['editor', `${editor.name} ${c.gray(`· ${editor.detail}`)}`]
  ])
  if (!p.installed) {
    out()
    if (p.needsPathEntry && p.profileHasEntry)
      out(`  ${icon.ok()} ${c.green('in your shell profile — open a new terminal')}`)
    else out(`  ${icon.warn()} ${c.yellow('run: wolffish path install')}`)
  }

  const channels = Array.isArray(snapshot.channels) ? snapshot.channels : []
  if (channels.length > 0) {
    heading('Channels')
    table(
      ['channel', 'state', 'detail'],
      channels.map((ch) => [
        ch.label ?? ch.id,
        ch.connected ? c.green('connected') : c.gray(ch.state ?? 'off'),
        c.gray(String(ch.detail ?? ''))
      ])
    )
  }

  const runs = snapshot.activeRuns ?? []
  if (runs.length > 0) {
    heading(`Running now ${c.gray(`(${runs.length})`)}`)
    table(
      ['conversation', 'channel', 'title'],
      runs.map((run) => [
        c.gray(String(run.conversationId).slice(0, 8)),
        run.channel ?? '—',
        run.title ?? c.gray('Untitled')
      ])
    )
  }
  out()
  return 0
}

export async function service(client, args) {
  const [sub, ...rest] = args

  if (!sub || sub === 'status') {
    const state = await client.invoke('service:status')
    heading('Autostart')
    keyValue([
      ['registered', state.active ? c.green('yes') : c.yellow('no')],
      ['mechanism', c.gray(state.mechanism)],
      ['run mode', c.gray(state.mode)],
      ...(state.location ? [['location', c.gray(shortPath(state.location))]] : [])
    ])
    if (state.warning) {
      out()
      out(`  ${icon.warn()} ${c.yellow(state.warning)}`)
    }
    out()
    return state.active ? 0 : 1
  }

  if (sub === 'install') {
    // `--headless` is the declaration that this machine is a server. It
    // decides between a login item / .desktop entry and a real service unit,
    // and it is persisted so a later status check asks the same question.
    const mode = rest.includes('--headless') || rest.includes('headless') ? 'headless' : undefined
    const state = await client.invoke('service:install', mode)
    if (!state.active) {
      out(`${icon.fail()} ${c.red('could not register autostart')}`)
      if (state.warning) out(wrapText(c.gray(state.warning), 2))
      return 1
    }
    out(`${icon.ok()} autostart registered ${c.gray(`(${state.mechanism})`)}`)
    if (state.location) out(c.gray(`  ${shortPath(state.location)}`))
    if (state.warning) out(`  ${icon.warn()} ${c.yellow(state.warning)}`)
    return 0
  }

  if (sub === 'uninstall') {
    const state = await client.invoke('service:uninstall')
    out(`${icon.ok()} autostart removed ${c.gray(`(${state.mechanism})`)}`)
    return 0
  }

  if (sub === 'start') {
    out(c.gray('  the daemon starts on demand — any wolffish command brings it up'))
    return 0
  }

  if (sub === 'stop') {
    const pid = daemonPid()
    if (!pid) {
      out(c.gray('  not running'))
      return 0
    }
    /**
     * The pid file outlives a crash, and pids are recycled.
     *
     * Signalling whatever now holds that number is not a theoretical worry on
     * a busy server — it is how `wolffish service stop` kills someone else's
     * process. The socket is the check that costs nothing: a daemon that
     * answers is the daemon, and a pid file with nothing behind it is stale by
     * definition.
     */
    const live = await client.invoke('cli:status').catch(() => null)
    if (!live) {
      out(c.yellow('  the pid file is stale — nothing is answering on the socket'))
      out(c.gray(`  not signalling pid ${pid}; it may belong to something else now`))
      return 1
    }
    if (live.cli?.pid && live.cli.pid !== pid) {
      out(c.yellow(`  the pid file says ${pid} but the daemon answering is ${live.cli.pid}`))
      out(c.gray('  stopping the one that answered'))
      process.kill(live.cli.pid, 'SIGTERM')
      out(`${icon.ok()} sent SIGTERM to pid ${live.cli.pid}`)
      return 0
    }
    process.kill(pid, 'SIGTERM')
    out(`${icon.ok()} sent SIGTERM to pid ${pid}`)
    return 0
  }

  if (sub === 'logs') {
    return tailLogs(rest)
  }

  out(c.red(`unknown: wolffish service ${sub}`))
  out(c.gray('  status | install [--headless] | uninstall | stop | logs'))
  return 2
}

/**
 * The tail of today's log — the first thing anyone reaches for on a server.
 *
 * The file is picked HERE rather than inside a shell pipeline. The pipeline
 * version (`ls … | head -1 | xargs tail`) had two failure modes that both look
 * like a hang: with no log file yet, `xargs` runs `tail` with no argument, and
 * GNU tail then reads stdin forever — the terminal simply stops, with no
 * output and no error. And `sh -lc` sources a login profile, so anything a
 * user's `.profile` prints lands in the middle of their logs.
 */
async function tailLogs(args) {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const dir = path.join(home, '.wolffish', 'workspace', 'logs')

  let newest = null
  try {
    const entries = await fs.readdir(dir)
    const logs = await Promise.all(
      entries
        .filter((name) => name.endsWith('.log'))
        .map(async (name) => {
          const full = path.join(dir, name)
          const stat = await fs.stat(full).catch(() => null)
          return stat ? { full, at: stat.mtimeMs } : null
        })
    )
    newest = logs.filter(Boolean).sort((a, b) => b.at - a.at)[0]?.full ?? null
  } catch {
    newest = null
  }

  if (!newest) {
    out(c.yellow('  no log file yet'))
    out(c.gray(`  they appear in ${shortPath(dir)} once the daemon has written one`))
    return 1
  }

  const follow = args.includes('-f') || args.includes('--follow')
  if (process.platform === 'win32') {
    // No tail to lean on. Print the tail ourselves; -f is not offered rather
    // than pretended at.
    const text = await fs.readFile(newest, 'utf8').catch(() => '')
    const lines = text.split('\n')
    out(lines.slice(-200).join('\n'))
    if (follow) out(c.gray(`  (following is not supported here — the file is ${newest})`))
    return 0
  }

  const child = spawn('tail', follow ? ['-f', newest] : ['-n', '200', newest], {
    stdio: 'inherit'
  })
  return new Promise((resolve) => {
    child.on('error', () => {
      out(c.gray(`  could not run tail — the file is ${newest}`))
      resolve(1)
    })
    child.on('close', (code) => resolve(code ?? 0))
  })
}

/**
 * `wolffish path` — the command's own installation.
 *
 * Worth its own verb because the failure mode is invisible: without the shim
 * on PATH, every other command in this document is unreachable and the shell
 * says only "command not found", which points at nothing.
 */
export async function pathCommand(client, args) {
  const [sub] = args

  if (!sub || sub === 'status') {
    const state = await client.invoke('cli:pathStatus', process.env.PATH ?? null)
    heading('Command')
    keyValue([
      ['on PATH', state.installed ? c.green('yes') : c.red('no')],
      ['shim', c.gray(shortPath(state.target))],
      ['resolves to', state.resolved ? c.gray(shortPath(state.resolved)) : c.gray('nothing')]
    ])
    if (state.shadowedBy) {
      out()
      out(
        `  ${icon.warn()} ${c.yellow(`"wolffish" currently runs ${shortPath(state.shadowedBy)}`)}`
      )
      out(
        wrapText(
          c.gray(
            'That is the app binary the package manager linked, so the command opens the desktop app instead of this CLI. Put the shim earlier on PATH, or replace that link.'
          ),
          4
        )
      )
    }
    if (state.needsPathEntry && state.profileHasEntry) {
      out()
      out(`  ${icon.ok()} ${c.green('its folder is in your shell profile — open a new terminal')}`)
    } else if (state.needsPathEntry && state.profileHint) {
      out()
      out(`  ${icon.warn()} ${c.yellow('the shim exists but its folder is not on PATH')}`)
      out(`  ${c.bold(state.profileHint)}`)
    }
    if (!state.installed && !state.needsPathEntry) {
      out()
      out(c.gray('  install with: wolffish path install'))
    }
    out()
    return state.installed ? 0 : 1
  }

  if (sub === 'install') {
    const state = await client.invoke('cli:installPath')
    if (state.error) {
      out(`${icon.fail()} ${c.red(state.error)}`)
      return 1
    }
    out(`${icon.ok()} installed ${c.gray(shortPath(state.target))}`)
    if (state.needsPathEntry && state.profileHasEntry) {
      out(
        `${icon.ok()} added to your shell profile — open a new terminal and \`wolffish\` is there`
      )
      return 0
    }
    if (state.needsPathEntry && state.profileHint) {
      out()
      out(`${icon.warn()} ${c.yellow('one more step — that folder is not on your PATH:')}`)
      out(`  ${c.bold(state.profileHint)}`)
      out(c.gray('  then restart your shell'))
      return 1
    }
    if (state.shadowedBy) {
      out(
        `${icon.warn()} ${c.yellow(`another "wolffish" is earlier on PATH: ${shortPath(state.shadowedBy)}`)}`
      )
      return 1
    }
    return 0
  }

  if (sub === 'uninstall') {
    await client.invoke('cli:uninstallPath')
    out(`${icon.ok()} removed`)
    return 0
  }

  out(c.red(`unknown: wolffish path ${sub}`))
  out(c.gray('  status | install | uninstall'))
  return 2
}
