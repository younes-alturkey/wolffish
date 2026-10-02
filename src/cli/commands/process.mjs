/**
 * `wolffish process …` — the managed-process registry from the terminal.
 *
 * Every verb rides the app's own `processes:*` IPC handlers, the same calls
 * the Library tab and the chat card make, so a `stop` here and a Stop button
 * there are one function. A headless install has no other window onto what
 * its agent left running, which is why this verb exists at all.
 */
import {
  c,
  confirm,
  err,
  heading,
  icon,
  keyValue,
  out,
  relativeTime,
  shortPath,
  table
} from '../lib/ui.mjs'

const USAGE = `
${c.bold('wolffish process')} — long-lived processes Wolffish manages

  wolffish process                      list them
  wolffish process show <name>          definition, run, log tail
  wolffish process start <name> -- <command…>   start one (use {port} for the port)
  wolffish process stop <name>|--all    stop
  wolffish process restart <name>       stop and start again
  wolffish process logs <name> [-n 100] read the log tail
  wolffish process autostart <name> off|wolffish|system
  wolffish process rm <name>            stop, remove its login entry, forget it
  wolffish process ports                who listens on what
`

function isLive(r) {
  return r.run.state === 'starting' || r.run.state === 'running' || r.run.state === 'stopping'
}

function stateIcon(r) {
  return isLive(r) ? icon.ok() : r.run.state === 'crashed' ? icon.fail() : c.gray('○')
}

function where(r) {
  return r.run.url ?? (r.run.port ? `:${r.run.port}` : '')
}

async function list(client) {
  const records = await client.invoke('processes:list')
  if (!records.length) {
    out(
      c.gray(
        '  no managed processes — the agent starts them with process_start, or: wolffish process start <name> -- <command>'
      )
    )
    return 0
  }
  const now = Date.now()
  table(
    ['', 'name', 'state', 'where', 'since', 'autostart', 'command'],
    records.map((r) => [
      stateIcon(r),
      r.name,
      r.run.state + (r.run.exitCode !== null && !isLive(r) ? ` (${r.run.exitCode})` : ''),
      where(r),
      isLive(r) && r.run.startedAt
        ? relativeTime(r.run.startedAt, now)
        : r.run.endedAt
          ? c.gray(relativeTime(r.run.endedAt, now))
          : '',
      r.autostart === 'off' ? c.gray('off') : r.autostart,
      c.gray(r.command.length > 48 ? r.command.slice(0, 45) + '…' : r.command)
    ])
  )
  return 0
}

async function show(client, name) {
  const records = await client.invoke('processes:list')
  const r = records.find((x) => x.name === name)
  if (!r) return missing(name)
  heading(`${stateIcon(r)} ${r.name}`)
  keyValue([
    [
      'state',
      r.run.state + (r.run.exitCode !== null && !isLive(r) ? ` (exit ${r.run.exitCode})` : '')
    ],
    ['pid', r.run.pid ?? '—'],
    ['where', where(r) || '—'],
    ['command', r.command],
    ['cwd', shortPath(r.cwd)],
    ['restart', r.restart],
    ['on quit', r.onQuit],
    ['autostart', r.autostart + (r.run.unit ? ` (unit ${r.run.unit})` : '')],
    ['origin', r.origin.kind + (r.origin.conversationId ? ` · ${r.origin.conversationId}` : '')],
    ['log', r.run.logPath ? shortPath(r.run.logPath) : '—'],
    ['note', r.run.lastError ?? '—']
  ])
  const tail = await client.invoke('processes:logs', { name, lines: 20 })
  if (tail) {
    out()
    out(c.gray('  last lines'))
    for (const line of tail.split('\n')) out(`  ${line}`)
  }
  return 0
}

function missing(name) {
  err(`no process named ${c.bold(name)} — ${c.gray('wolffish process')} lists them`)
  return 1
}

export async function processCommand(client, args, flags = {}) {
  const [verb, ...rest] = args
  if (!verb || verb === 'ls' || verb === 'list') return list(client)
  if (verb === 'help' || verb === '--help') {
    out(USAGE)
    return 0
  }
  if (verb === 'ports') {
    const ports = await client.invoke('processes:ports')
    if (!ports.length) {
      out(c.gray('  no TCP listeners found'))
      return 0
    }
    table(
      ['port', 'owner', 'pid'],
      ports.map((p) => [
        String(p.port),
        p.managed ? `${c.bold(p.managed)} ${c.gray('(wolffish)')}` : (p.command ?? '?'),
        p.pid ?? ''
      ])
    )
    return 0
  }
  if (verb === 'show') {
    if (!rest[0]) return usageError()
    return show(client, rest[0])
  }
  if (verb === 'start') {
    const name = rest[0]
    const sep = rest.indexOf('--')
    const command = (sep >= 0 ? rest.slice(sep + 1) : rest.slice(1)).join(' ').trim()
    if (!name || !command) return usageError()
    const result = await client.invoke('processes:start', {
      name,
      command,
      cwd: typeof flags.cwd === 'string' ? flags.cwd : process.cwd(),
      wait: true
    })
    if (!result.ok) {
      err(result.error)
      return 1
    }
    const r = result.record
    out(
      `${icon.ok()} started ${c.bold(r.name)}${where(r) ? ` on ${where(r)}` : ''} ${c.gray(`pid ${r.run.pid}`)}`
    )
    if (r.run.logPath) out(c.gray(`  log: ${shortPath(r.run.logPath)}`))
    return 0
  }
  if (verb === 'stop') {
    if (rest[0] === '--all' || flags.all) {
      const results = await client.invoke('processes:stopAll')
      if (!results.length) out(c.gray('  nothing was running'))
      for (const r of results)
        out(
          `${r.stopped ? icon.ok() : c.gray('○')} ${r.name}${r.stopped ? '' : c.gray(' was not running')}`
        )
      return 0
    }
    if (!rest[0]) return usageError()
    const res = await client.invoke('processes:stop', { name: rest[0] })
    if (!res.ok) {
      err(res.error ?? 'stop failed')
      return 1
    }
    out(
      res.stopped
        ? `${icon.ok()} stopped ${c.bold(rest[0])}`
        : c.gray(`  ${rest[0]} was not running`)
    )
    return 0
  }
  if (verb === 'restart') {
    if (!rest[0]) return usageError()
    const res = await client.invoke('processes:restart', { name: rest[0] })
    if (!res.ok) {
      err(res.error ?? 'restart failed')
      return 1
    }
    out(
      `${icon.ok()} restarted ${c.bold(rest[0])}${where(res.record) ? ` on ${where(res.record)}` : ''}`
    )
    return 0
  }
  if (verb === 'logs' || verb === 'log') {
    if (!rest[0]) return usageError()
    const n = Number(flags.n ?? flags.lines ?? 100) || 100
    const text = await client.invoke('processes:logs', { name: rest[0], lines: n })
    out(text || c.gray('  (log is empty)'))
    return 0
  }
  if (verb === 'autostart') {
    const [name, mode] = rest
    if (!name || !['off', 'wolffish', 'system'].includes(mode ?? '')) return usageError()
    const res = await client.invoke('processes:update', { name, autostart: mode })
    if (!res.ok) {
      err(res.error ?? 'update failed')
      return 1
    }
    out(
      `${icon.ok()} ${c.bold(name)} autostart: ${mode}${res.warning ? c.gray(` — ${res.warning}`) : ''}`
    )
    return 0
  }
  if (verb === 'rm' || verb === 'remove') {
    if (!rest[0]) return usageError()
    if (!flags.yes && !flags.y) {
      const ok = await confirm(`stop and forget ${c.bold(rest[0])}?`)
      if (!ok) return 1
    }
    const res = await client.invoke('processes:remove', { name: rest[0] })
    if (!res.ok) {
      err(res.error ?? 'remove failed')
      return 1
    }
    out(`${icon.ok()} removed ${c.bold(rest[0])}`)
    return 0
  }
  return usageError()
}

function usageError() {
  err(`usage:${USAGE}`)
  return 1
}
