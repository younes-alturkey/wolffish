import type { Amygdala } from '@main/runtime/amygdala'
import type { Cerebellum, WolffishPlugin } from '@main/runtime/cerebellum'
import { turnScope } from '@main/runtime/corpus'
import { humanAge, type ProcessManager } from './manager'
import { allocateBandPort } from './ports'
import {
  isLive,
  type ProcessAutostart,
  type ProcessPortPolicy,
  type ProcessRecord,
  type RestartPolicy
} from './types'

/**
 * The `processes` capability — the model-facing half of the process manager.
 *
 * Eleven tools over one registry. Every result ends with the next sensible
 * call so the model never has to remember the tool set, and the two rules
 * that must always hold — "anything that should outlive this call goes
 * through process_start" and "a busy port belongs to whoever is on it" — are
 * in the tool descriptions, which are the only part of a capability the
 * model always sees.
 *
 * Gating mirrors the shell: the command of a process_start is matched
 * against the amygdala's danger/confirm patterns exactly as a shell_exec of
 * the same text would be. Three actions are confirm-level in their own
 * right — taking over a foreign port, stopping an adopted process, and
 * installing a login unit — and prompt through the same approval card.
 */

export const PROCESS_TOOLS = [
  'process_start',
  'process_list',
  'process_status',
  'process_logs',
  'process_stop',
  'process_restart',
  'process_update',
  'process_remove',
  'process_adopt',
  'process_ports',
  'process_show'
] as const

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function portPolicyFrom(
  args: Record<string, unknown>,
  command: string
): ProcessPortPolicy | undefined {
  const raw = args.port
  if (raw === undefined || raw === null)
    return /\{port\}/i.test(command) ? { mode: 'wolffish' } : undefined
  if (raw === 'wolffish' || raw === 'auto') return { mode: 'wolffish' }
  if (raw === 'none' || raw === false) return { mode: 'none' }
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0)
    return { mode: 'fixed', port: raw, takeover: args.takeover === true }
  if (typeof raw === 'string' && /^\d+$/.test(raw))
    return { mode: 'fixed', port: Number(raw), takeover: args.takeover === true }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    if (o.mode === 'none') return { mode: 'none' }
    if (o.mode === 'fixed' || typeof o.port === 'number' || typeof o.value === 'number') {
      const port = Number(o.port ?? o.value)
      if (Number.isInteger(port) && port > 0)
        return { mode: 'fixed', port, takeover: o.takeover === true || args.takeover === true }
    }
    return { mode: 'wolffish' }
  }
  return undefined
}

function restartFrom(v: unknown): RestartPolicy | undefined {
  return v === 'never' || v === 'on-failure' || v === 'always' ? v : undefined
}

function autostartFrom(v: unknown): ProcessAutostart | undefined {
  if (v === true) return 'wolffish'
  if (v === false) return 'off'
  return v === 'off' || v === 'wolffish' || v === 'system' ? v : undefined
}

export function describeRecord(r: ProcessRecord, now = Date.now()): string {
  const where = r.run.url ?? (r.run.port ? `port ${r.run.port}` : '')
  const age =
    isLive(r) && r.run.startedAt
      ? humanAge(now - r.run.startedAt)
      : r.run.endedAt
        ? `ended ${humanAge(now - r.run.endedAt)} ago`
        : ''
  const bits = [
    `${r.name}: ${r.run.state}${r.run.exitCode !== null && !isLive(r) ? ` (exit ${r.run.exitCode})` : ''}`,
    r.run.pid && isLive(r) ? `pid ${r.run.pid}` : '',
    where,
    age,
    r.run.restarts ? `${r.run.restarts} restarts` : '',
    r.autostart !== 'off' ? `autostart ${r.autostart}` : '',
    r.origin.kind === 'adopted' ? 'adopted' : ''
  ].filter(Boolean)
  return bits.join(' · ')
}

/**
 * The log a name left behind when its record is gone: a one-shot that exited 0
 * is dropped from the registry at once, but its log file stays, and the call
 * that follows "it has already finished" is nearly always for that log.
 */
async function keptLog(
  manager: ProcessManager,
  name: string,
  lines: number,
  grep?: string
): Promise<string | null> {
  const text = await manager.logs(name, { lines, grep })
  return text.trim() ? text : null
}

function describeFull(r: ProcessRecord): string {
  const lines = [
    describeRecord(r),
    `  command: ${r.command}`,
    `  cwd: ${r.cwd}`,
    `  policy: restart ${r.restart} · ${r.onQuit} on quit · autostart ${r.autostart}${r.run.unit ? ` (unit ${r.run.unit})` : ''}`,
    r.run.logPath ? `  log: ${r.run.logPath}` : '  log: none',
    r.run.lastError ? `  note: ${r.run.lastError}` : ''
  ]
  return lines.filter(Boolean).join('\n')
}

export function registerProcessesCapability(
  cerebellum: Cerebellum,
  amygdala: Amygdala,
  manager: ProcessManager
): void {
  const scopeOf = (): { conversationId: string | null; turnId: string | null } => {
    const scope = turnScope.getStore()
    return {
      conversationId: scope?.conversationId ?? cerebellum.getCurrentConversationId(),
      turnId: scope?.turnId ?? null
    }
  }

  const confirm = async (
    title: string,
    description: string,
    reason: string
  ): Promise<string | null> => {
    if (amygdala.isBypassingPermissions()) return null
    const decision = await amygdala.requestApproval({
      toolCall: {
        id: `proc_${Date.now().toString(36)}`,
        name: 'processes',
        args: { action: title }
      },
      level: 'confirm',
      reason,
      description: { title, description, risk: 'medium' },
      sessionKey: scopeOf().conversationId ?? 'processes'
    })
    return decision === 'denied' ? `Denied by user: ${reason}` : null
  }

  const defaultCwd = (): string => cerebellum.getWorkingFolders()[0] ?? ''

  const plugin: WolffishPlugin = {
    name: 'processes',
    tools: [],
    isReadOnlyCall: (name) =>
      name === 'process_list' ||
      name === 'process_status' ||
      name === 'process_logs' ||
      name === 'process_ports' ||
      name === 'process_show',
    describeAction: (name, args) => {
      if (name === 'process_start') {
        return {
          title: 'Start a managed process',
          description: `${str(args?.name)}: ${str(args?.command)}`,
          command: str(args?.command),
          risk: 'medium'
        }
      }
      if (name === 'process_stop')
        return {
          title: 'Stop a managed process',
          description: args?.all ? 'Stop every managed process' : `Stop ${str(args?.name)}`,
          risk: 'low'
        }
      if (name === 'process_remove')
        return {
          title: 'Remove a managed process',
          description: `Stop and forget ${str(args?.name)}`,
          risk: 'low'
        }
      return {
        title: 'Process manager',
        description: `${name} ${str(args?.name)}`.trim(),
        risk: 'low'
      }
    },
    execute: async (toolName, rawArgs) => {
      const args = (rawArgs ?? {}) as Record<string, unknown>
      const name = str(args.name)
      switch (toolName) {
        case 'process_start': {
          const command = str(args.command)
          if (!command) return { success: false, error: 'command is required.' }
          // The same gate a shell_exec of this text would face.
          const match = amygdala.match({ id: 'proc_gate', name: 'shell_exec', args: { command } })
          if (match?.level === 'block')
            return { success: false, error: `Blocked by safety policy: ${match.reason}` }
          if (
            (match?.level === 'confirm' || match?.level === 'destructive') &&
            !amygdala.isBypassingPermissions()
          ) {
            const decision = await amygdala.requestApproval({
              toolCall: { id: 'proc_gate', name: 'process_start', args: { name, command } },
              level: match.level,
              reason: match.reason,
              description: {
                title: 'Start a managed process',
                description: `${name}: ${command}`,
                command,
                risk: 'high'
              },
              sessionKey: scopeOf().conversationId ?? 'processes'
            })
            if (decision === 'denied')
              return { success: false, error: `Denied by user: ${match.reason}` }
          }
          const port = portPolicyFrom(args, command)
          if (port?.mode === 'fixed' && port.takeover) {
            const denied = await confirm(
              'Take over a port',
              `Stop whatever is listening on port ${port.port} so "${name}" can use it.`,
              'stops a process Wolffish did not start'
            )
            if (denied) return { success: false, error: denied }
          }
          const autostart = autostartFrom(args.autostart)
          if (autostart === 'system') {
            const denied = await confirm(
              'Install a login unit',
              `Register "${name}" with the OS so it runs at login even when Wolffish is closed.`,
              'writes a login unit'
            )
            if (denied) return { success: false, error: denied }
          }
          const scope = scopeOf()
          const ready =
            args.ready && typeof args.ready === 'object'
              ? (args.ready as Record<string, unknown>)
              : {}
          const result = await manager.start({
            name,
            command,
            cwd: str(args.cwd) || defaultCwd() || undefined,
            env:
              args.env && typeof args.env === 'object'
                ? (args.env as Record<string, string>)
                : undefined,
            port,
            ready: {
              port: typeof ready.port === 'boolean' ? ready.port : undefined,
              logMatch: str(ready.logMatch) || undefined,
              timeoutMs:
                typeof ready.timeoutMs === 'number'
                  ? ready.timeoutMs
                  : typeof args.timeoutMs === 'number'
                    ? args.timeoutMs
                    : undefined
            },
            restart: restartFrom(args.restart),
            onQuit: args.onQuit === 'stop' ? 'stop' : args.onQuit === 'keep' ? 'keep' : undefined,
            autostart,
            origin: { conversationId: scope.conversationId, kind: 'started' },
            wait: args.wait !== false
          })
          if (!result.ok) {
            return {
              success: false,
              retryable: false,
              error: result.error,
              output: result.tail ? `Last log lines:\n${result.tail}` : undefined,
              meta: { label: 'Start process', outputPath: result.record?.run.logPath ?? undefined }
            }
          }
          if (autostart === 'system') {
            const up = await manager.update(name, { autostart: 'system' })
            if (!up.ok) result.warnings.push(up.error ?? 'login unit install failed')
            else if (up.warning) result.warnings.push(up.warning)
          }
          const r = manager.get(name) ?? result.record
          // wait=false returns before any output exists; a command that died
          // in the meantime still has its last words in the log.
          const tail = result.tail || (!isLive(r) ? await manager.logs(name, { lines: 20 }) : '')
          const head = result.alreadyRunning
            ? `"${name}" is already running${r.run.url ? ` on ${r.run.url}` : ''} (since ${r.run.startedAt ? new Date(r.run.startedAt).toLocaleTimeString() : '?'}); reusing it.`
            : `Started ${name} (pid ${r.run.pid})${r.run.url ? ` on ${r.run.url}` : r.run.port ? ` on port ${r.run.port}` : ''}${result.ready ? `, ready in ${r.run.readyAt && r.run.startedAt ? ((r.run.readyAt - r.run.startedAt) / 1000).toFixed(1) : '?'} s` : ' (readiness not observed yet)'}.`
          const out = [
            head,
            `  cwd: ${r.cwd}`,
            `  command: ${r.command}`,
            r.run.logPath ? `  log: ${r.run.logPath}` : '',
            `  policy: restart ${r.restart} · ${r.onQuit} on quit · autostart ${r.autostart}`,
            ...result.warnings.map((w) => `  warning: ${w}`),
            tail ? `Last lines:\n${tail}` : '',
            !isLive(r)
              ? `It has already finished${tail ? '' : ' without writing any output'}. For a one-off command like this, shell_exec returns the output directly; process_start is for things that keep running.`
              : r.run.url
                ? `Next: preview_open ${r.run.url} to show it. After a rebuild, process_status name=${name} waitFor={logMatch} then preview_reload. It keeps running after this turn; process_stop only when the user is done with it.`
                : `Next: process_logs name=${name} to read its output; process_status name=${name} waitFor={state:"exited"} to wait for it to finish. It keeps running after this turn.`
          ]
          return {
            success: true,
            output: out.filter(Boolean).join('\n'),
            meta: { label: 'Start process', cwd: r.cwd, outputPath: r.run.logPath ?? undefined }
          }
        }
        case 'process_list': {
          const filter = str(args.filter) || 'all'
          const scope = scopeOf()
          let list = manager.list()
          if (filter === 'mine')
            list = list.filter((r) => r.origin.conversationId === scope.conversationId)
          else if (filter === 'running') list = list.filter(isLive)
          else if (filter === 'finished') list = list.filter((r) => !isLive(r))
          else if (filter !== 'all')
            list = list.filter((r) => r.cwd.startsWith(filter) || r.name.includes(filter))
          const finishedOneShots =
            filter === 'all'
              ? list.filter((r) => r.origin.kind === 'shell' && !isLive(r)).length
              : 0
          if (finishedOneShots)
            list = list.filter((r) => !(r.origin.kind === 'shell' && !isLive(r)))
          if (list.length === 0)
            return {
              success: true,
              output:
                'No managed processes' +
                (filter !== 'all' ? ` match "${filter}"` : '') +
                '. process_start creates one.'
            }
          return {
            success: true,
            output:
              list.map((r) => describeRecord(r)).join('\n') +
              (finishedOneShots
                ? `\n(${finishedOneShots} finished background command${finishedOneShots === 1 ? '' : 's'} hidden; filter="finished" shows them)`
                : '') +
              '\n\nprocess_status name=<name> for detail, process_show to put a card in the chat.'
          }
        }
        case 'process_status': {
          if (!name) return { success: false, error: 'name is required.' }
          const wait =
            args.waitFor && typeof args.waitFor === 'object'
              ? (args.waitFor as Record<string, unknown>)
              : null
          let record = manager.get(name)
          if (!record) {
            const kept = await keptLog(manager, name, 40)
            if (kept)
              return {
                success: true,
                output: `"${name}" finished (exit 0) before it was ready and its record was dropped as a one-shot; nothing is running under that name. Its log was kept — last lines:\n${kept}`,
                meta: { label: 'Process status', outputPath: manager.logPathFor(name) }
              }
            return {
              success: false,
              error: `No process named "${name}". process_list shows what exists.`
            }
          }
          let waitNote = ''
          if (wait && (str(wait.state) || str(wait.logMatch))) {
            const res = await manager.waitFor(name, {
              state: str(wait.state) || undefined,
              logMatch: str(wait.logMatch) || undefined,
              timeoutMs: typeof wait.timeoutMs === 'number' ? wait.timeoutMs : undefined
            })
            record = res.record
            if (!record) return { success: false, error: `"${name}" was removed while waiting.` }
            waitNote = res.matched
              ? `Matched by ${res.matchedBy ?? 'condition'}.`
              : 'Timed out waiting; current state below.'
          }
          const ports = (await manager.ports()).filter((p) => p.managed === name)
          const tail = await manager.logs(name, { lines: 40 })
          const out = [
            waitNote,
            describeFull(record),
            ports.length ? `  listening: ${ports.map((p) => p.port).join(', ')}` : '',
            tail ? `Last 40 lines:\n${tail}` : '(no log output yet)'
          ]
          return {
            success: true,
            output: out.filter(Boolean).join('\n'),
            meta: { label: 'Process status', outputPath: record.run.logPath ?? undefined }
          }
        }
        case 'process_logs': {
          if (!name) return { success: false, error: 'name is required.' }
          const record = manager.get(name)
          const lines = typeof args.lines === 'number' ? args.lines : 100
          if (!record) {
            // A finished one-shot is forgotten by the registry but its log
            // stays on disk: the natural next call after "it has already
            // finished" must still answer.
            const kept = await keptLog(manager, name, lines, str(args.grep) || undefined)
            if (kept)
              return {
                success: true,
                output: `("${name}" already finished; its record was dropped, this is its kept log)\n${kept}`,
                meta: { label: 'Process log', outputPath: manager.logPathFor(name) }
              }
            return { success: false, error: `No process named "${name}".` }
          }
          if (!record.run.logPath)
            return { success: true, output: `"${name}" has no log (adopted without one).` }
          const text = await manager.logs(name, {
            lines,
            grep: str(args.grep) || undefined
          })
          return {
            success: true,
            output: text || '(log is empty)',
            meta: { label: 'Process log', outputPath: record.run.logPath }
          }
        }
        case 'process_stop': {
          if (args.all === true) {
            const results = await manager.stopAll()
            if (results.length === 0) return { success: true, output: 'Nothing was running.' }
            return {
              success: true,
              output: results
                .map((r) => `${r.name}: ${r.stopped ? 'stopped' : 'was not running'}`)
                .join('\n')
            }
          }
          if (!name) return { success: false, error: 'Pass name, or all=true.' }
          const record = manager.get(name)
          if (!record) return { success: false, error: `No process named "${name}".` }
          if (record.origin.kind === 'adopted' && isLive(record)) {
            const denied = await confirm(
              'Stop an adopted process',
              `Stop "${name}" (${record.command.slice(0, 80)}), which Wolffish did not start.`,
              'stops a process Wolffish did not start'
            )
            if (denied) return { success: false, error: denied }
          }
          const res = await manager.stop(name, {
            signal: args.signal === 'SIGINT' ? 'SIGINT' : undefined,
            graceMs: typeof args.graceMs === 'number' ? args.graceMs : undefined
          })
          if (!res.ok) return { success: false, error: res.error ?? 'stop failed' }
          return {
            success: true,
            output: res.stopped ? `Stopped ${name}.` : `${name} was not running.`,
            meta: { label: 'Stop process' }
          }
        }
        case 'process_restart': {
          if (!name) return { success: false, error: 'name is required.' }
          const res = await manager.restart(name)
          if (!res.ok)
            return {
              success: false,
              error: res.error,
              output: res.tail ? `Last log lines:\n${res.tail}` : undefined
            }
          const r = res.record
          return {
            success: true,
            output: [
              `Restarted ${name}${r.run.url ? ` on ${r.run.url}` : ''}${res.ready ? '' : ' (readiness not observed yet)'}.`,
              ...res.warnings.map((w) => `  warning: ${w}`),
              res.tail ? `Last lines:\n${res.tail}` : ''
            ]
              .filter(Boolean)
              .join('\n'),
            meta: { label: 'Restart process', outputPath: r.run.logPath ?? undefined }
          }
        }
        case 'process_update': {
          if (!name) return { success: false, error: 'name is required.' }
          const autostart = autostartFrom(args.autostart)
          if (autostart === 'system') {
            const denied = await confirm(
              'Install a login unit',
              `Register "${name}" with the OS so it runs at login even when Wolffish is closed.`,
              'writes a login unit'
            )
            if (denied) return { success: false, error: denied }
          }
          const command = str(args.command)
          const res = await manager.update(name, {
            command: command || undefined,
            cwd: str(args.cwd) || undefined,
            env:
              args.env && typeof args.env === 'object'
                ? (args.env as Record<string, string>)
                : undefined,
            port: portPolicyFrom(args, command || manager.get(name)?.command || ''),
            restart: restartFrom(args.restart),
            onQuit: args.onQuit === 'stop' ? 'stop' : args.onQuit === 'keep' ? 'keep' : undefined,
            autostart,
            newName: str(args.newName) || undefined
          })
          if (!res.ok) return { success: false, error: res.error ?? 'update failed' }
          const r = res.record as ProcessRecord
          const applyNow =
            args.apply === 'now' && isLive(r) && (command || args.cwd || args.env || args.port)
          let restartNote = ''
          if (applyNow) {
            const rr = await manager.restart(r.name)
            restartNote = rr.ok
              ? ` Restarted with the new definition${rr.record.run.url ? ` on ${rr.record.run.url}` : ''}.`
              : ` Restart failed: ${rr.error}`
          } else if (isLive(r) && (command || args.cwd || args.env || args.port)) {
            restartNote =
              ' The running copy keeps its old definition until process_restart (or pass apply="now").'
          }
          return {
            success: true,
            output: `Updated ${r.name}.${restartNote}${res.warning ? ` Note: ${res.warning}` : ''}\n${describeFull(manager.get(r.name) ?? r)}`,
            meta: { label: 'Update process' }
          }
        }
        case 'process_remove': {
          if (!name) return { success: false, error: 'name is required.' }
          const record = manager.get(name)
          if (!record) return { success: false, error: `No process named "${name}".` }
          if (record.origin.kind === 'adopted' && isLive(record)) {
            const denied = await confirm(
              'Stop an adopted process',
              `Stop and forget "${name}", which Wolffish did not start.`,
              'stops a process Wolffish did not start'
            )
            if (denied) return { success: false, error: denied }
          }
          const res = await manager.remove(name, { keepLogs: args.keepLogs === true })
          if (!res.ok) return { success: false, error: res.error ?? 'remove failed' }
          return {
            success: true,
            output: `Removed ${name}${record.run.unit ? ' and its login unit' : ''}.`,
            meta: { label: 'Remove process' }
          }
        }
        case 'process_adopt': {
          if (!name) return { success: false, error: 'name is required.' }
          const res = await manager.adopt({
            name,
            pid: typeof args.pid === 'number' ? args.pid : undefined,
            port: typeof args.port === 'number' ? args.port : undefined,
            match: str(args.match) || undefined,
            conversationId: scopeOf().conversationId,
            logPath: str(args.logPath) || undefined
          })
          if (!res.ok || !res.record) return { success: false, error: res.error ?? 'adopt failed' }
          return {
            success: true,
            output: `Adopted ${name}: ${describeFull(res.record)}\nIt is listed and stoppable like any managed process; restart is off because Wolffish did not start it.`,
            meta: { label: 'Adopt process' }
          }
        }
        case 'process_ports': {
          const list = await manager.ports()
          const one = typeof args.port === 'number' ? args.port : null
          const rows = (one ? list.filter((p) => p.port === one) : list).map(
            (p) =>
              `${p.port}: ${p.managed ? `Wolffish-managed "${p.managed}"` : p.wolffishOwn ? `Wolffish app itself (${p.command ?? 'process'}) — not the user's, not adoptable` : (p.command ?? 'unknown')}${p.pid ? ` (pid ${p.pid})` : ''}`
          )
          let suggestion = ''
          if (args.suggest === true) {
            const port = await allocateBandPort(name || 'suggest', defaultCwd() || 'x', list)
            suggestion = port
              ? `\nFree Wolffish-band port: ${port}`
              : '\nNo free port in the Wolffish band.'
          }
          if (one && rows.length === 0)
            return { success: true, output: `Port ${one} is free.${suggestion}` }
          return {
            success: true,
            output: (rows.length ? rows.join('\n') : 'No TCP listeners found.') + suggestion
          }
        }
        case 'process_show': {
          const scope = scopeOf()
          const names = Array.isArray(args.names)
            ? args.names.map((n) => String(n)).filter(Boolean)
            : name
              ? [name]
              : null
          if (names) {
            const missing = names.filter((n) => !manager.get(n))
            if (missing.length)
              return {
                success: false,
                error: `No process named ${missing.map((m) => `"${m}"`).join(', ')}.`
              }
          }
          const snapshot = manager.openCard({
            conversationId: scope.conversationId,
            turnId: scope.turnId,
            title: str(args.title) || null,
            names
          })
          const count = snapshot.processes.length
          return {
            success: true,
            output: `Card shown (${count} process${count === 1 ? '' : 'es'}). It updates live and has Stop / Restart buttons; do not repeat its contents in prose beyond one line.`,
            meta: { label: 'Process card' }
          }
        }
        default:
          return { success: false, error: `processes: unknown tool ${toolName}` }
      }
    }
  }

  cerebellum.registerInProcessCapability(
    {
      name: 'processes',
      dir: '',
      description:
        'Long-lived processes that outlive the tool call, the turn and the app: dev servers, watchers, tunnels, databases, bundlers, simulators, long scripts. Start, list, read logs, stop, restart, edit, remove, adopt, arbitrate ports, run at login, and show a live card in the chat.',
      triggers: {
        keywords: [
          'dev server',
          'npm run dev',
          'keep running',
          'background process',
          'port',
          'localhost',
          'restart the server',
          'autostart',
          'tunnel',
          'watcher'
        ]
      },
      tools: [
        {
          name: 'process_start',
          description:
            "Start a process that must keep running after this call returns — a dev server, watcher, tunnel, database, bundler, long script. NEVER shell_exec for these. Name it after what it is (web-dev, api, tunnel). Put {port} in the command the way THAT tool takes a port — Next.js: `npm run dev -- -p {port}`; Vite/Astro/SvelteKit: `npm run dev -- --port {port} --strictPort`; Django: `manage.py runserver {port}`; uvicorn/Flask: `--port {port}`; anything else: PORT env is set too. Read package.json scripts first: a flag one framework takes another rejects (`--strictPort` is Vite-only): Wolffish fills it with a free port from its own band (20000-20999) and also sets PORT, so it never collides with the user's own servers on 3000/5173/8000. A busy port belongs to whoever is on it: pass a fixed `port` only when the user asked for that exact port, and `takeover=true` only when they asked you to replace what is on it (asks for confirmation). Blocks until the process is ready (a listener appears or the log prints a URL / `ready.logMatch`), up to 30 s, and returns pid, port, URL, log path and the last lines. If a process with this name already runs the same command it is reused, never duplicated. It keeps running after the turn ends; leave it up while the user is working on it and stop it only when it was just for a check. On Windows the command runs through cmd.exe in a hidden console of its own (chain with `&&`, quote paths with double quotes; PowerShell syntax belongs in a .ps1 run as `powershell -File`).",
          parameters: {
            name: {
              type: 'string',
              required: true,
              description: 'Slug: web-dev, api, tunnel, db. Unique per workspace.'
            },
            command: {
              type: 'string',
              required: true,
              description: 'The shell command, with {port} where the port goes.'
            },
            cwd: {
              type: 'string',
              required: false,
              description: 'Working directory. Omit to run in the first working folder.'
            },
            env: { type: 'object', required: false, description: 'Extra environment variables.' },
            port: {
              type: 'string',
              required: false,
              description:
                '"wolffish" (default when {port} is in the command): a free port from the Wolffish band. A number: that exact port, only when the user asked for it. "none": no port.'
            },
            takeover: {
              type: 'boolean',
              required: false,
              description:
                'With a fixed port that is busy: stop its owner first. Only when the user asked. Confirmed.'
            },
            ready: {
              type: 'object',
              required: false,
              description:
                '{ logMatch?: regex the log must print, port?: boolean, timeoutMs?: number }. Default: a listener or a URL in the log, 30 s.'
            },
            restart: {
              type: 'string',
              required: false,
              description:
                'never | on-failure (default) | always. The supervisor restarts with backoff while Wolffish runs.'
            },
            onQuit: {
              type: 'string',
              required: false,
              description:
                'keep (default): survives Wolffish quitting. stop: stopped when Wolffish quits.'
            },
            autostart: {
              type: 'string',
              required: false,
              description:
                '"off" (default) · "wolffish": started whenever Wolffish starts — the right level for "keep it running", "start it on its own", "at login" (Wolffish itself launches at login) · "system": an OS login unit that runs even when Wolffish is closed (confirmed); only when the user says it must run without Wolffish. On macOS a login unit cannot read Desktop, Documents or Downloads, so a project there needs "wolffish". On Windows it is a per-user Task Scheduler logon task — never register one by hand with schtasks. Most users never need this: get the process running and shown first, and treat login registration as a separate, last step only when it was asked for.'
            },
            wait: {
              type: 'boolean',
              required: false,
              description: 'false returns immediately without waiting for readiness.'
            }
          }
        },
        {
          name: 'process_list',
          readOnly: true,
          description:
            'Every managed process — name, state, pid, port or URL, uptime, autostart, which chat started it. Call it before starting anything: it may already be up.',
          parameters: {
            filter: {
              type: 'string',
              required: false,
              description:
                'all (default; finished background commands are folded into a count) · mine · running · finished · a path or name fragment.'
            }
          }
        },
        {
          name: 'process_status',
          readOnly: true,
          description:
            'Full detail for one process plus its listening ports and the last 40 log lines. With waitFor it BLOCKS until a state or a log line appears — how you wait for a rebuild to finish before preview_reload, or for a script to exit, without polling.',
          parameters: {
            name: { type: 'string', required: true, description: 'The process name.' },
            waitFor: {
              type: 'object',
              required: false,
              description:
                '{ state?: "running"|"exited"|"crashed"|"stopped", logMatch?: regex, timeoutMs?: number (default 60000) }. Waits for whichever comes first.'
            }
          }
        },
        {
          name: 'process_logs',
          readOnly: true,
          description:
            'The tail of a process log (last 2000 lines / 50 KB max, ANSI stripped), optionally filtered by a regex. The full file path is in the result for file_read.',
          parameters: {
            name: { type: 'string', required: true, description: 'The process name.' },
            lines: {
              type: 'number',
              required: false,
              description: 'How many lines from the end. Default 100.'
            },
            grep: {
              type: 'string',
              required: false,
              description: 'Only lines matching this regex (case-insensitive).'
            }
          }
        },
        {
          name: 'process_stop',
          description:
            'Stop a managed process (graceful signal, then hard after the grace period, whole process tree). A process under a login unit is stopped through the OS so it does not come straight back. Stopping an adopted process asks for confirmation.',
          parameters: {
            name: { type: 'string', required: false, description: 'The process name.' },
            all: { type: 'boolean', required: false, description: 'Stop every managed process.' },
            signal: {
              type: 'string',
              required: false,
              description: 'SIGTERM (default) or SIGINT for tools that flush on interrupt.'
            },
            graceMs: {
              type: 'number',
              required: false,
              description: 'Grace before the hard kill. Default 3000.'
            }
          }
        },
        {
          name: 'process_restart',
          description:
            'Stop and start a process again with its current definition, keeping its port when still free, and wait for readiness. Use after a dependency change or a config edit that the dev server does not pick up by itself.',
          parameters: { name: { type: 'string', required: true, description: 'The process name.' } }
        },
        {
          name: 'process_update',
          description:
            'Edit a process definition: command, cwd, env, port policy, restart, onQuit, autostart, or rename. Changing autostart to "system" installs an OS login unit (confirmed); changing it away removes the unit. A running copy keeps the old definition until process_restart, or pass apply="now".',
          parameters: {
            name: { type: 'string', required: true, description: 'The process name.' },
            command: {
              type: 'string',
              required: false,
              description: 'New command (may contain {port}).'
            },
            cwd: { type: 'string', required: false, description: 'New working directory.' },
            env: { type: 'object', required: false, description: 'Replacement env map.' },
            port: {
              type: 'string',
              required: false,
              description: '"wolffish" | a number | "none".'
            },
            restart: {
              type: 'string',
              required: false,
              description: 'never | on-failure | always.'
            },
            onQuit: { type: 'string', required: false, description: 'keep | stop.' },
            autostart: {
              type: 'string',
              required: false,
              description:
                '"off" | "wolffish" (start with Wolffish; covers at-login for a user who launches Wolffish at login) | "system" (OS login unit, runs without Wolffish; not for projects under Desktop/Documents/Downloads on macOS). If a level fails, the error names the level that works — change it here before building units by hand.'
            },
            newName: {
              type: 'string',
              required: false,
              description: 'Rename (the log directory moves with it).'
            },
            apply: {
              type: 'string',
              required: false,
              description: '"now" restarts a running process with the new definition.'
            }
          }
        },
        {
          name: 'process_remove',
          description:
            'Stop a process if running, remove its login unit if any, and delete its definition and logs. The only tool that forgets a process.',
          parameters: {
            name: { type: 'string', required: true, description: 'The process name.' },
            keepLogs: {
              type: 'boolean',
              required: false,
              description: 'Leave the log directory in place.'
            }
          }
        },
        {
          name: 'process_adopt',
          description:
            "Track a process Wolffish did not start — the user's own dev server, a simulator or emulator, a daemon — by pid, by the port it listens on, or by a command-line substring. Adopted processes are listed, stoppable (with confirmation) and shown on cards; restart is off because there is no command to rerun.",
          parameters: {
            name: { type: 'string', required: true, description: 'Slug for the adopted process.' },
            pid: { type: 'number', required: false, description: 'Its pid.' },
            port: { type: 'number', required: false, description: 'A port it listens on.' },
            match: {
              type: 'string',
              required: false,
              description: 'A substring of its command line.'
            },
            logPath: {
              type: 'string',
              required: false,
              description: 'A log file to read for it, if one exists.'
            }
          }
        },
        {
          name: 'process_ports',
          readOnly: true,
          description:
            'Every TCP listener on this machine with its owner, marked when Wolffish manages it. The call to make before any "port is busy" decision. suggest=true also returns a free port from the Wolffish band.',
          parameters: {
            port: { type: 'number', required: false, description: 'Report just this port.' },
            suggest: {
              type: 'boolean',
              required: false,
              description: 'Also return a free Wolffish-band port.'
            }
          }
        },
        {
          name: 'process_show',
          readOnly: true,
          description:
            'Put a live process card in the chat: one process (name) or several (names), or every managed process when neither is given. The card shows state, port/URL, uptime and has Stop and Restart buttons the user can press, and it updates itself as things change. Show it when the user would want to see or control what is running — after starting a dev server for them, when they ask what is running, when something crashed. Do not show one for a process you only started to check something and will stop yourself.',
          parameters: {
            name: { type: 'string', required: false, description: 'One process to show.' },
            names: {
              type: 'array',
              required: false,
              items: { type: 'string' },
              description: 'Several processes to show on one card.'
            },
            title: {
              type: 'string',
              required: false,
              description: "Optional card title in the user's words."
            }
          }
        }
      ],
      body: '',
      hasPlugin: true,
      status: 'ok',
      requires: [],
      packages: {},
      npmDependencies: {}
    },
    plugin
  )
}
