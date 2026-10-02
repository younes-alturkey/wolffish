import { wlog } from '@main/workspace/logger'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  detectShell,
  listeningPorts,
  ownProcessTree,
  pidExists,
  processInfo,
  signalTree,
  spawnDetached,
  treeOf,
  type Spawned
} from './platform'
import { allocateBandPort, commandWantsPort, fillPort, portOwner } from './ports'
import { ProcessRegistry } from './registry'
import {
  installUnit,
  removeUnit,
  setProcessFilesRoot,
  unitRestart,
  unitState,
  unitStop
} from './service-units'
import {
  emptyRun,
  isLive,
  normalizeName,
  type ListeningPort,
  type ProcessCardSnapshot,
  type ProcessDefinition,
  type ProcessRecord,
  type ProcessStartInput,
  type ProcessStartResult
} from './types'

const TAG = '[processes]'

/** Shell's tail rules: the last 2000 lines / 50 KB of a log, ANSI stripped. */
const LOG_TAIL_LINES = 2000
const LOG_TAIL_BYTES = 50 * 1024
const LOG_ROTATE_BYTES = 20 * 1024 * 1024
const READY_DEFAULT_TIMEOUT_MS = 30_000
const STOP_DEFAULT_GRACE_MS = 3000
const LIVENESS_POLL_MS = 5000
const RESTART_MAX_IN_WINDOW = 5
const RESTART_WINDOW_MS = 120_000

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g
const URL_RE =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[a-z0-9.-]+):(\d{2,5})(?:\/\S*)?/i

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

export function tailBound(
  text: string,
  maxLines = LOG_TAIL_LINES,
  maxBytes = LOG_TAIL_BYTES
): string {
  if (!text) return ''
  const lines = text.split('\n')
  const kept = lines.slice(-maxLines)
  let joined = kept.join('\n')
  while (Buffer.byteLength(joined, 'utf8') > maxBytes && kept.length > 1) {
    kept.shift()
    joined = kept.join('\n')
  }
  return (
    (lines.length > kept.length ? `…(${lines.length - kept.length} earlier lines omitted)\n` : '') +
    joined
  )
}

type CardHandle = {
  cardId: string
  conversationId: string | null
  turnId: string | null
  title: string | null
  names: string[] | null
  createdAt: number
}

/**
 * The process manager: one persisted registry of long-lived processes, the
 * spawn/liveness/stop primitives from platform.ts, a readiness watcher, a
 * restart supervisor, login units for `autostart: system`, and the card
 * snapshots the chat draws. Everything the model, the Library page, the CLI
 * and the phone see goes through this one object; none of them holds its
 * own list.
 *
 * Lifetimes: a child is spawned detached and unref'd, so it survives the
 * tool call, the turn and Wolffish itself. While Wolffish runs, the child
 * handle's exit event is the fast path; every other liveness question (a
 * relaunch, an adopted pid, a unit-owned job) is answered by pid + the OS
 * start stamp recorded at spawn, never by the pid alone.
 */
export class ProcessManager {
  readonly registry: ProcessRegistry
  private readonly logsRoot: string
  private children = new Map<string, Extract<Spawned, { pid: number }>>()
  private restartTimes = new Map<string, number[]>()
  private restartTimers = new Map<string, NodeJS.Timeout>()
  private stopping = new Set<string>()
  /** Names whose spawn is in flight — the window in which the registry does not yet say "starting". */
  private starting = new Set<string>()
  private pollTimer: NodeJS.Timeout | null = null
  private quitting = false

  private cards = new Map<string, CardHandle>()
  private turnEmitters = new Map<string, (snapshot: ProcessCardSnapshot) => void>()
  private cardListeners = new Set<(snapshot: ProcessCardSnapshot) => void>()
  private changedListeners = new Set<(record: ProcessRecord | null) => void>()
  private crashListeners = new Set<(record: ProcessRecord) => void>()

  constructor(workspaceRoot: string) {
    this.registry = new ProcessRegistry(workspaceRoot)
    this.logsRoot = path.join(workspaceRoot, 'files', 'processes')
    setProcessFilesRoot(this.logsRoot)
    this.registry.onChanged((record) => {
      for (const cb of this.changedListeners) {
        try {
          cb(record)
        } catch {
          // listener's problem
        }
      }
      if (record) this.refreshCardsFor(record.name)
      else this.refreshCardsFor(null)
    })
  }

  // ───────────────────────────────────────────── lifecycle

  async init(): Promise<void> {
    await this.registry.load()
    await this.reconcile()
    this.pollTimer = setInterval(() => void this.pollLiveness(), LIVENESS_POLL_MS)
    this.pollTimer.unref?.()
    // Tier A autostart: everything marked `wolffish` that is not alive
    // starts now, in parallel, without holding up the app.
    for (const record of this.registry.list()) {
      if (record.autostart === 'wolffish' && !isLive(record)) {
        void this.startRecord(record, { wait: true }).catch((err) =>
          wlog.warn(
            TAG,
            `autostart ${record.name} failed: ${err instanceof Error ? err.message : String(err)}`
          )
        )
      }
    }
  }

  /** Fire-and-forget: `onQuit: stop` records get the graceful signal. Never awaited by the quit path. */
  shutdown(): void {
    this.quitting = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    for (const timer of this.restartTimers.values()) clearTimeout(timer)
    for (const record of this.registry.list()) {
      if (record.onQuit === 'stop' && isLive(record) && !record.run.unit && record.run.pid) {
        void signalTree(record.run.pid, 'SIGTERM')
      }
    }
  }

  onChanged(listener: (record: ProcessRecord | null) => void): () => void {
    this.changedListeners.add(listener)
    return () => this.changedListeners.delete(listener)
  }

  /** An unexpected exit the supervisor did not (or will no longer) repair. */
  onCrash(listener: (record: ProcessRecord) => void): () => void {
    this.crashListeners.add(listener)
    return () => this.crashListeners.delete(listener)
  }

  // ───────────────────────────────────────────── reads

  list(): ProcessRecord[] {
    return this.registry.list()
  }

  get(name: string): ProcessRecord | null {
    return this.registry.get(name)
  }

  logPathFor(name: string): string {
    return path.join(this.logsRoot, name, 'current.log')
  }

  /** The last `lines` of a log (bounded like shell output), optionally filtered. */
  async logs(name: string, opts: { lines?: number; grep?: string } = {}): Promise<string> {
    const record = this.registry.get(name)
    const logPath = record?.run.logPath ?? this.logPathFor(name)
    let text = await this.readTail(logPath, 512 * 1024)
    if (!text) return ''
    if (opts.grep) {
      let re: RegExp
      try {
        re = new RegExp(opts.grep, 'i')
      } catch {
        re = new RegExp(opts.grep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      }
      text = text
        .split('\n')
        .filter((l) => re.test(l))
        .join('\n')
    }
    return tailBound(text, Math.max(1, Math.min(opts.lines ?? 100, LOG_TAIL_LINES)))
  }

  /** The OS's listeners, each annotated with the managed process on it (when any). */
  async ports(): Promise<Array<ListeningPort & { managed: string | null; wolffishOwn: boolean }>> {
    const [listeners, own] = await Promise.all([listeningPorts(), ownProcessTree()])
    const byPid = new Map<number, string>()
    for (const r of this.registry.list()) if (r.run.pid && isLive(r)) byPid.set(r.run.pid, r.name)
    // A listener may belong to a child of the managed pid (npm → node).
    const out: Array<ListeningPort & { managed: string | null; wolffishOwn: boolean }> = []
    for (const l of listeners) {
      let managed = l.pid ? (byPid.get(l.pid) ?? null) : null
      if (!managed && l.port) {
        const byPort = this.registry.list().find((r) => isLive(r) && r.run.port === l.port)
        managed = byPort?.name ?? null
      }
      out.push({ ...l, managed, wolffishOwn: l.pid !== null && own.has(l.pid) })
    }
    return out.sort((a, b) => a.port - b.port)
  }

  /** One line per process for the runtime tail — empty string when nothing is worth saying. */
  noticeText(conversationId: string | null, now = Date.now()): string {
    const lines: string[] = []
    for (const r of this.registry.list()) {
      const mine = r.origin.conversationId && r.origin.conversationId === conversationId
      const who = mine ? 'this chat' : r.origin.kind === 'adopted' ? 'adopted' : 'another chat'
      if (isLive(r)) {
        const where = r.run.url ?? (r.run.port ? `:${r.run.port}` : '')
        const age = r.run.startedAt ? humanAge(now - r.run.startedAt) : ''
        lines.push(
          `${r.name} ${r.run.state}${where ? ` ${where}` : ''}${age ? ` (${age}, ${who})` : ` (${who})`}`
        )
      } else if (
        r.run.state === 'crashed' &&
        r.run.endedAt &&
        now - r.run.endedAt < 24 * 3600_000
      ) {
        const ago = humanAge(now - r.run.endedAt)
        lines.push(
          `${r.name} crashed exit ${r.run.exitCode ?? '?'}, ${ago} ago${r.run.lastError ? `, ${r.run.lastError}` : ''} (${who})`
        )
      }
    }
    if (lines.length === 0) return ''
    return `Processes (process_list for detail, process_logs to read one): ${lines.join(' · ')}`
  }

  // ───────────────────────────────────────────── start

  async start(input: ProcessStartInput): Promise<ProcessStartResult> {
    const name = normalizeName(input.name)
    if (!name) {
      return {
        ok: false,
        error:
          'name must be a slug: lowercase letters, digits, dots, dashes (e.g. web-dev, api, tunnel).'
      }
    }
    const command = String(input.command ?? '').trim()
    if (!command) return { ok: false, error: 'command is required.' }
    const cwd = resolveCwd(input.cwd)
    try {
      await fs.access(cwd)
    } catch {
      return { ok: false, error: `cwd does not exist or is not accessible: ${cwd}` }
    }

    const existing = this.registry.get(name)
    const sameDefinition = !!existing && existing.command === command && existing.cwd === cwd
    if (existing) {
      const sameThing = sameDefinition
      if (isLive(existing) && (await this.isAlive(existing))) {
        if (sameThing) {
          return {
            ok: true,
            record: existing,
            ready: existing.run.state === 'running',
            alreadyRunning: true,
            tail: await this.logs(name, { lines: 20 }),
            warnings: []
          }
        }
        return {
          ok: false,
          record: existing,
          error:
            `"${name}" is already running a different command (${existing.command} in ${existing.cwd}). ` +
            'Pick another name, or process_update / process_stop it first.'
        }
      }
      if (!sameThing && existing.origin.kind !== 'shell') {
        // A stopped definition being redefined: allowed, but say so in the result.
      }
    }

    const definition: ProcessDefinition = {
      id: existing?.id ?? randomUUID(),
      name,
      command,
      cwd,
      // A different command is a new definition: its port policy, readiness
      // rule and env come from the call, not from what the old command had.
      // (Inheriting them left a redefined `{port}` command with the old
      // "none" policy — `{port}` unfilled — or the old band port.)
      env: input.env ?? (sameDefinition ? existing?.env : undefined) ?? {},
      port:
        input.port ??
        (sameDefinition ? existing?.port : undefined) ??
        (commandWantsPort(command) ? { mode: 'wolffish' } : { mode: 'none' }),
      ready: input.ready ?? (sameDefinition ? existing?.ready : undefined) ?? {},
      restart: input.restart ?? existing?.restart ?? 'on-failure',
      onQuit: input.onQuit ?? existing?.onQuit ?? 'keep',
      autostart: input.autostart ?? existing?.autostart ?? 'off',
      origin: input.origin ?? existing?.origin ?? { conversationId: null, kind: 'started' },
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now()
    }
    const record: ProcessRecord = { ...definition, run: { ...emptyRun(), restarts: 0 } }
    await this.registry.upsert(record)
    this.restartTimes.delete(name)
    return this.startRecord(record, { wait: input.wait !== false })
  }

  /**
   * Spawn a definition's command: allocate the port, open the log, spawn
   * detached, record the OS start stamp, then (optionally) wait for readiness.
   */
  private async startRecord(
    record: ProcessRecord,
    opts: { wait: boolean; keepPort?: number | null; isRestart?: boolean }
  ): Promise<ProcessStartResult> {
    const name = record.name
    // One spawn per name at a time. A crashed record's supervisor holds a
    // backoff timer; a process_start that redefines the name while it is
    // pending used to race it — two copies of the new command, one dying on
    // the port, the record blamed for the loser's exit and restarted again
    // while the winner ran on untracked. The timer goes, and the spawn
    // window (seconds on Windows) is held so the timer's own path skips it.
    const pending = this.restartTimers.get(name)
    if (pending) {
      clearTimeout(pending)
      this.restartTimers.delete(name)
    }
    if (this.starting.has(name)) {
      return { ok: false, error: `"${name}" is already being started; wait for it.`, record }
    }
    this.starting.add(name)
    try {
      return await this.startRecordInner(record, opts)
    } finally {
      this.starting.delete(name)
    }
  }

  private async startRecordInner(
    record: ProcessRecord,
    opts: { wait: boolean; keepPort?: number | null; isRestart?: boolean }
  ): Promise<ProcessStartResult> {
    const name = record.name
    const warnings: string[] = []
    const listeners = await listeningPorts()

    // ── Port
    let port: number | null = null
    if (record.port.mode === 'wolffish') {
      if (opts.keepPort && !listeners.some((l) => l.port === opts.keepPort)) port = opts.keepPort
      else port = await allocateBandPort(name, record.cwd, listeners)
      if (port === null)
        return { ok: false, error: 'No free port in the Wolffish band (20000-20999).' }
    } else if (record.port.mode === 'fixed') {
      port = record.port.port
      const owner = await portOwner(port, listeners)
      if (owner) {
        const managed = this.registry
          .list()
          .find((r) => r.name !== name && isLive(r) && r.run.port === port)
        if (managed) {
          return {
            ok: false,
            error: `Port ${port} is held by the Wolffish-managed process "${managed.name}". Reuse it (process_status) or stop it first.`
          }
        }
        if (!record.port.takeover) {
          return {
            ok: false,
            error:
              `Port ${port} is in use by ${owner.command ?? 'another process'}${owner.pid ? ` (pid ${owner.pid})` : ''}. ` +
              'Choose another port ({port} takes one from the Wolffish band), or pass port.takeover=true only if the user asked for that exact port.'
          }
        }
        if (!owner.pid) {
          return {
            ok: false,
            error: `Port ${port} is in use but the owner cannot be identified; refusing to take it over.`
          }
        }
        // Takeover: graceful, then wait for the listener to vanish.
        await signalTree(owner.pid, 'SIGTERM')
        for (let i = 0; i < 30 && (await portOwner(port)); i++) await sleep(200)
        if (await portOwner(port)) {
          await signalTree(owner.pid, 'SIGKILL')
          for (let i = 0; i < 20 && (await portOwner(port)); i++) await sleep(200)
        }
        if (await portOwner(port)) return { ok: false, error: `Port ${port} could not be freed.` }
        warnings.push(`Took over port ${port} from ${owner.command ?? 'pid ' + owner.pid}.`)
      }
    }

    // ── Log
    const logPath = this.logPathFor(name)
    await fs.mkdir(path.dirname(logPath), { recursive: true })
    await this.rotateLog(logPath)
    // Readiness scans only what THIS run writes: a previous run's "Local:"
    // line in the same file must not make a restart look ready in 0.0 s.
    const logStart = await this.fileSize(logPath)
    let logFd: fs.FileHandle | null = null
    try {
      logFd = await fs.open(logPath, 'a')
      await logFd.write(
        `\n──── ${new Date().toISOString()} start${opts.isRestart ? ' (restart)' : ''}: ${record.command}\n`
      )
    } catch {
      logFd = null
      warnings.push('Could not open the log file; output is not captured.')
    }

    // ── Spawn
    const shell = await detectShell()
    const command = port ? fillPort(record.command, port) : record.command
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NO_COLOR: process.env.NO_COLOR ?? '1',
      FORCE_COLOR: process.env.FORCE_COLOR ?? '0',
      ...record.env
    }
    if (port) env.PORT = String(port)
    const spawned = await spawnDetached(shell, command, {
      cwd: record.cwd,
      env,
      logFd: logFd?.fd ?? null,
      logPath: logFd ? logPath : null,
      signature: signatureOf(record.command)
    })
    await logFd?.close().catch(() => undefined)
    if ('error' in spawned) {
      const failed = await this.registry.mutate(name, (cur) => ({
        ...cur,
        run: {
          ...cur.run,
          state: 'crashed',
          lastError: spawned.error,
          endedAt: Date.now(),
          logPath
        }
      }))
      return { ok: false, error: spawned.error, record: failed ?? record }
    }
    // Listen for the exit BEFORE the registry write below: a one-shot can
    // finish during that await, and a listener attached afterwards would miss
    // it, leaving a dead pid marked running for the whole readiness wait.
    let earlyExit: { code: number | null; signal: NodeJS.Signals | null } | null = null
    let recorded = false
    spawned.child.once('exit', (code, signal) => {
      if (recorded) void this.onChildExit(name, spawned.pid, code, signal)
      else earlyExit = { code, signal }
    })
    const info = await processInfo(spawned.pid)
    const startedAt = Date.now()
    const started = await this.registry.mutate(name, (cur) => ({
      ...cur,
      run: {
        ...cur.run,
        pid: spawned.pid,
        signature: signatureOf(record.command),
        osStart: info?.startedAt ?? null,
        port,
        url: null,
        state: 'starting',
        exitCode: null,
        exitSignal: null,
        startedAt,
        readyAt: null,
        endedAt: null,
        logPath,
        unit: null,
        adoptedAt: null,
        lastError: null
      }
    }))
    this.children.set(name, spawned)
    recorded = true
    if (earlyExit) {
      const { code, signal } = earlyExit as { code: number | null; signal: NodeJS.Signals | null }
      await this.onChildExit(name, spawned.pid, code, signal)
    }

    if (!opts.wait) {
      return {
        ok: true,
        record: started ?? record,
        ready: false,
        alreadyRunning: false,
        tail: '',
        warnings
      }
    }
    return this.awaitReady(name, spawned.pid, warnings, logStart)
  }

  private async awaitReady(
    name: string,
    pid: number,
    warnings: string[],
    logStart = 0
  ): Promise<ProcessStartResult> {
    const record = this.registry.get(name)
    if (!record) return { ok: false, error: `"${name}" vanished while starting.` }
    const timeoutMs = Math.max(1000, record.ready.timeoutMs ?? READY_DEFAULT_TIMEOUT_MS)
    const wantPort = record.ready.port ?? record.port.mode !== 'none'
    const logMatch = record.ready.logMatch ? safeRegex(record.ready.logMatch) : null
    const deadline = Date.now() + timeoutMs
    let lastListeners = 0
    let discoveredPort: number | null = null
    let discoveredUrl: string | null = null
    let ready = false
    let readyBy = ''

    while (Date.now() < deadline) {
      const cur = this.registry.get(name)
      if (!cur || cur.run.pid !== pid) break
      if (
        cur.run.state === 'crashed' ||
        cur.run.state === 'exited' ||
        cur.run.state === 'stopped'
      ) {
        const tail = await this.logs(name, { lines: 40 })
        if (cur.run.state === 'exited' && cur.run.exitCode === 0) {
          // A command that finished cleanly before it was "ready" was a
          // one-shot, not a server: report it as done with its output, and
          // forget the definition — it had no port, never became ready and
          // cannot be restarted, so a record would only be list noise. The
          // log file stays.
          await this.registry.remove(name)
          return {
            ok: true,
            record: cur,
            ready: false,
            alreadyRunning: false,
            tail,
            warnings: [
              ...warnings,
              'finished (exit 0) before any readiness signal — a one-shot command, not a server.'
            ]
          }
        }
        return {
          ok: false,
          record: cur,
          tail,
          error: `"${name}" exited before it was ready (exit ${cur.run.exitCode ?? cur.run.exitSignal ?? '?'}). Read the log tail below.`
        }
      }
      const fresh = await this.readFrom(cur.run.logPath ?? this.logPathFor(name), logStart)
      const clean = stripAnsi(fresh.length > 64 * 1024 ? fresh.slice(-64 * 1024) : fresh)
      const urlMatch = URL_RE.exec(clean)
      if (urlMatch) {
        discoveredUrl = urlMatch[0].replace(/[),.;'"]+$/, '')
        discoveredPort = Number(urlMatch[1])
      }
      if (logMatch && logMatch.test(clean)) {
        ready = true
        readyBy = 'log'
      } else if (!logMatch && urlMatch) {
        ready = true
        readyBy = 'url'
      }
      if (
        !ready &&
        wantPort &&
        Date.now() - lastListeners > (process.platform === 'win32' ? 2000 : 800)
      ) {
        lastListeners = Date.now()
        const tree = new Set([pid, ...(await treeOf(pid).catch(() => [] as number[]))])
        const listeners = await listeningPorts()
        const mine = listeners.filter((l) => l.pid !== null && tree.has(l.pid))
        const onAllocated = cur.run.port ? mine.find((l) => l.port === cur.run.port) : undefined
        const hit = onAllocated ?? mine[0]
        if (hit) {
          ready = true
          readyBy = 'port'
          if (!discoveredPort) discoveredPort = hit.port
        }
      }
      if (
        !ready &&
        !wantPort &&
        !logMatch &&
        Date.now() - (cur.run.startedAt ?? 0) > Math.min(3000, timeoutMs / 2)
      ) {
        // Nothing to wait for: three seconds alive is "up" — if it IS alive.
        // A pid that already died waits for its exit event to land instead.
        if (!pidExists(pid)) {
          await sleep(300)
          continue
        }
        ready = true
        readyBy = 'alive'
      }
      if (ready) break
      await sleep(300)
    }

    const cur = this.registry.get(name)
    if (!cur) return { ok: false, error: `"${name}" vanished while starting.` }
    if (cur.run.pid !== pid || !isLive(cur)) {
      return {
        ok: false,
        record: cur,
        tail: await this.logs(name, { lines: 40 }),
        error: `"${name}" is not running.`
      }
    }
    const port = discoveredPort ?? cur.run.port
    if (cur.run.port && discoveredPort && discoveredPort !== cur.run.port) {
      warnings.push(
        `Asked for port ${cur.run.port} but the process reports ${discoveredPort}; using what it reports.`
      )
    }
    const url = discoveredUrl ?? (port ? `http://localhost:${port}` : null)
    // Readiness not observed is a warning, not a state: the process is alive,
    // so it is running — `readyAt` stays null to say nobody saw it come up.
    const updated = await this.registry.mutate(name, (c) => ({
      ...c,
      run: {
        ...c.run,
        state: 'running',
        readyAt: ready ? Date.now() : c.run.readyAt,
        port,
        url: ready ? url : c.run.url
      }
    }))
    if (!ready) {
      warnings.push(
        `Readiness was not observed within ${Math.round(timeoutMs / 1000)} s (${wantPort ? 'no listener' : 'no match'} yet); the process is still running — process_status can wait longer.`
      )
    } else if (readyBy) {
      wlog.info(TAG, `${name} ready by ${readyBy}${port ? ` on ${port}` : ''}`)
    }
    return {
      ok: true,
      record: updated ?? cur,
      ready,
      alreadyRunning: false,
      tail: await this.logs(name, { lines: 20 }),
      warnings
    }
  }

  private async onChildExit(
    name: string,
    pid: number,
    code: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> {
    // A late exit from a previous run (Windows delivers it a beat after the
    // pid is gone) must not drop the handle of the run that replaced it.
    if (this.children.get(name)?.pid === pid) this.children.delete(name)
    const record = this.registry.get(name)
    if (!record || record.run.pid !== pid) return
    // On Windows the exit we hear is the launcher's, and the launcher dies
    // with Wolffish's job at quit while the command it started lives on. An
    // exit that lands during shutdown says nothing about the command, so the
    // record keeps its live state and the relaunch reconcile re-tests the pid.
    if (this.quitting) return
    // stop() may have already closed the run out ("stopped") before the exit
    // event arrives: that exit is confirmation, not a crash — reading it as
    // one would hand an on-failure record to the supervisor, which then
    // re-spawns a process nobody asked for next to the one restart() started.
    const wasStopping =
      this.stopping.has(name) || record.run.state === 'stopping' || record.run.state === 'stopped'
    const state = wasStopping ? 'stopped' : code === 0 ? 'exited' : 'crashed'
    const updated = await this.registry.mutate(name, (cur) => ({
      ...cur,
      run: { ...cur.run, state, exitCode: code, exitSignal: signal, endedAt: Date.now() }
    }))
    if (!updated || wasStopping) return
    this.superviseAfterExit(updated)
  }

  private superviseAfterExit(record: ProcessRecord): void {
    const crashed = record.run.state === 'crashed'
    const wants = record.restart === 'always' || (record.restart === 'on-failure' && crashed)
    if (!wants) {
      if (crashed) this.fireCrash(record)
      return
    }
    const now = Date.now()
    const times = (this.restartTimes.get(record.name) ?? []).filter(
      (t) => now - t < RESTART_WINDOW_MS
    )
    if (times.length >= RESTART_MAX_IN_WINDOW) {
      void this.registry
        .mutate(record.name, (cur) => ({
          ...cur,
          run: {
            ...cur.run,
            state: 'crashed',
            lastError: `restarts stopped after ${RESTART_MAX_IN_WINDOW} exits in ${RESTART_WINDOW_MS / 60000} minutes`
          }
        }))
        .then((r) => r && this.fireCrash(r))
      return
    }
    times.push(now)
    this.restartTimes.set(record.name, times)
    const delay = Math.min(30_000, 1000 * 2 ** Math.max(0, times.length - 1))
    const timer = setTimeout(() => {
      this.restartTimers.delete(record.name)
      const cur = this.registry.get(record.name)
      if (!cur || isLive(cur) || this.starting.has(cur.name) || this.quitting) return
      void this.registry
        .mutate(cur.name, (c) => ({ ...c, run: { ...c.run, restarts: c.run.restarts + 1 } }))
        .then(
          (c) => c && this.startRecord(c, { wait: true, keepPort: c.run.port, isRestart: true })
        )
        .catch((err) =>
          wlog.warn(
            TAG,
            `restart ${record.name} failed: ${err instanceof Error ? err.message : String(err)}`
          )
        )
    }, delay)
    timer.unref?.()
    this.restartTimers.set(record.name, timer)
  }

  private fireCrash(record: ProcessRecord): void {
    for (const cb of this.crashListeners) {
      try {
        cb(record)
      } catch {
        // listener's problem
      }
    }
  }

  // ───────────────────────────────────────────── stop / restart / update / remove

  async stop(
    name: string,
    opts: { signal?: 'SIGTERM' | 'SIGINT'; graceMs?: number } = {}
  ): Promise<{ ok: boolean; stopped: boolean; error?: string; record?: ProcessRecord }> {
    const record = this.registry.get(name)
    if (!record) return { ok: false, stopped: false, error: `No process named "${name}".` }
    const timer = this.restartTimers.get(name)
    if (timer) {
      clearTimeout(timer)
      this.restartTimers.delete(name)
    }
    if (record.run.unit) {
      try {
        await unitStop(name)
      } catch (err) {
        return {
          ok: false,
          stopped: false,
          error: err instanceof Error ? err.message : String(err),
          record
        }
      }
      const updated = await this.registry.mutate(name, (cur) => ({
        ...cur,
        run: { ...cur.run, state: 'stopped', pid: null, endedAt: Date.now() }
      }))
      return { ok: true, stopped: true, record: updated ?? record }
    }
    if (!isLive(record) || !record.run.pid || !(await this.isAlive(record))) {
      const updated = isLive(record)
        ? await this.registry.mutate(name, (cur) => ({
            ...cur,
            run: { ...cur.run, state: 'stopped', endedAt: cur.run.endedAt ?? Date.now() }
          }))
        : record
      return { ok: true, stopped: false, record: updated ?? record }
    }
    const pid = record.run.pid
    this.stopping.add(name)
    await this.registry.mutate(name, (cur) => ({ ...cur, run: { ...cur.run, state: 'stopping' } }))
    const grace = Math.max(0, opts.graceMs ?? STOP_DEFAULT_GRACE_MS)
    await signalTree(pid, opts.signal ?? 'SIGTERM')
    const deadline = Date.now() + grace
    while (Date.now() < deadline && pidExists(pid)) await sleep(100)
    if (pidExists(pid)) {
      await signalTree(pid, 'SIGKILL')
      for (let i = 0; i < 30 && pidExists(pid); i++) await sleep(100)
    }
    this.stopping.delete(name)
    const gone = !pidExists(pid)
    const updated = await this.registry.mutate(name, (cur) =>
      cur.run.pid === pid
        ? {
            ...cur,
            run: {
              ...cur.run,
              state: gone ? 'stopped' : cur.run.state,
              endedAt: gone ? Date.now() : cur.run.endedAt
            }
          }
        : cur
    )
    return {
      ok: gone,
      stopped: gone,
      error: gone ? undefined : `pid ${pid} is still alive after SIGKILL.`,
      record: updated ?? record
    }
  }

  async stopAll(): Promise<Array<{ name: string; stopped: boolean }>> {
    const out: Array<{ name: string; stopped: boolean }> = []
    for (const r of this.registry.list()) {
      if (!isLive(r)) continue
      const res = await this.stop(r.name)
      out.push({ name: r.name, stopped: res.stopped })
    }
    return out
  }

  async restart(name: string): Promise<ProcessStartResult> {
    const record = this.registry.get(name)
    if (!record) return { ok: false, error: `No process named "${name}".` }
    if (record.origin.kind === 'adopted' && !record.command) {
      return {
        ok: false,
        error: `"${name}" was adopted without a command; it cannot be restarted from here.`
      }
    }
    if (record.run.unit) {
      try {
        await unitRestart(name)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err), record }
      }
      await sleep(1500)
      await this.refreshUnit(record)
      const cur = this.registry.get(name) ?? record
      return {
        ok: true,
        record: cur,
        ready: cur.run.state === 'running',
        alreadyRunning: false,
        tail: await this.logs(name, { lines: 20 }),
        warnings: []
      }
    }
    const keepPort = record.run.port
    const stopped = await this.stop(name)
    if (!stopped.ok)
      return { ok: false, error: stopped.error ?? 'stop failed', record: stopped.record }
    this.restartTimes.delete(name)
    const fresh = await this.registry.mutate(name, (cur) => ({
      ...cur,
      run: { ...cur.run, restarts: 0 }
    }))
    return this.startRecord(fresh ?? record, { wait: true, keepPort, isRestart: true })
  }

  async update(
    name: string,
    patch: Partial<
      Pick<
        ProcessDefinition,
        'command' | 'cwd' | 'env' | 'port' | 'ready' | 'restart' | 'onQuit' | 'autostart'
      >
    > & {
      newName?: string
    }
  ): Promise<{ ok: boolean; error?: string; record?: ProcessRecord; warning?: string }> {
    let record = this.registry.get(name)
    if (!record) return { ok: false, error: `No process named "${name}".` }
    if (patch.cwd !== undefined) {
      const cwd = resolveCwd(patch.cwd)
      try {
        await fs.access(cwd)
      } catch {
        return { ok: false, error: `cwd does not exist: ${cwd}` }
      }
      patch = { ...patch, cwd }
    }
    let warning: string | undefined
    const previousAutostart = record.autostart
    const wantsAutostart = patch.autostart !== undefined && patch.autostart !== record.autostart
    const { newName, ...rawFields } = patch
    // Callers pass `undefined` for "not this field"; spreading that would erase
    // the command/cwd/policy (a live unit install once crashed on
    // `undefined.replace`). Only defined fields land.
    const fields = Object.fromEntries(Object.entries(rawFields).filter(([, v]) => v !== undefined))
    const nextName = newName ? normalizeName(newName) : null
    if (newName && !nextName) return { ok: false, error: 'newName must be a slug.' }
    if (nextName && nextName !== name && this.registry.get(nextName))
      return { ok: false, error: `"${nextName}" already exists.` }

    // Leaving `system`: the unit goes first, while its name still matches.
    if (wantsAutostart && record.autostart === 'system') {
      await removeUnit(name).catch((err) => {
        warning = `Could not remove the login unit: ${err instanceof Error ? err.message : String(err)}`
      })
      await this.registry.mutate(name, (cur) => ({
        ...cur,
        run: {
          ...cur.run,
          unit: null,
          state: cur.run.pid && pidExists(cur.run.pid) ? cur.run.state : 'stopped'
        }
      }))
    }
    const merged = await this.registry.mutate(name, (cur) => ({
      ...cur,
      ...fields,
      updatedAt: Date.now()
    }))
    record = merged ?? record
    if (nextName && nextName !== name) {
      const renamed: ProcessRecord = { ...record, name: nextName }
      // Windows refuses to move a folder while the running command holds its
      // log open; the record then keeps pointing at the log that is really
      // being written, and the next start lands in the new folder.
      const moved = await fs
        .rename(path.join(this.logsRoot, name), path.join(this.logsRoot, nextName))
        .then(() => true)
        .catch(() => false)
      renamed.run = {
        ...renamed.run,
        logPath: renamed.run.logPath
          ? moved
            ? this.logPathFor(nextName)
            : renamed.run.logPath
          : null
      }
      await this.registry.remove(name)
      const child = this.children.get(name)
      if (child) {
        this.children.delete(name)
        this.children.set(nextName, child)
      }
      await this.registry.upsert(renamed)
      record = renamed
    }
    if (wantsAutostart && patch.autostart === 'system') {
      const blocked = protectedFolderNote(record.cwd)
      if (blocked) {
        await this.registry.mutate(record.name, (cur) => ({ ...cur, autostart: previousAutostart }))
        return { ok: false, error: blocked, record: this.registry.get(record.name) ?? record }
      }
      // Our own detached copy would fight the unit's copy for the port.
      const wasLive = isLive(record) && !record.run.unit
      if (wasLive) await this.stop(record.name)
      const logPath = this.logPathFor(record.name)
      try {
        const state = await installUnit({ ...record, run: { ...record.run, logPath } }, logPath)
        const unit = record.name
        await this.registry.mutate(record.name, (cur) => ({
          ...cur,
          run: {
            ...cur.run,
            unit,
            logPath,
            state: state.running ? 'running' : cur.run.state === 'running' ? 'running' : 'stopped',
            pid: state.pid ?? cur.run.pid,
            startedAt: state.running ? Date.now() : cur.run.startedAt
          }
        }))
        if (state.warning) warning = state.warning
      } catch (err) {
        // Put things back the way they were: the previous autostart level,
        // and the copy we stopped a moment ago.
        const restored = await this.registry.mutate(record.name, (cur) => ({
          ...cur,
          autostart: previousAutostart
        }))
        if (wasLive && restored)
          await this.startRecord(restored, {
            wait: true,
            keepPort: restored.run.port,
            isRestart: true
          }).catch(() => undefined)
        return {
          ok: false,
          error:
            `Login unit install failed: ${err instanceof Error ? err.message : String(err)}. ` +
            `autostart is back to "${previousAutostart}"${wasLive ? ' and the process was started again' : ''}. ` +
            'autostart "wolffish" (start whenever Wolffish starts) needs no OS unit and is the usual answer.',
          record: this.registry.get(record.name) ?? record
        }
      }
    }
    return { ok: true, record: this.registry.get(record.name) ?? record, warning }
  }

  async remove(
    name: string,
    opts: { keepLogs?: boolean } = {}
  ): Promise<{ ok: boolean; error?: string }> {
    const record = this.registry.get(name)
    if (!record) return { ok: false, error: `No process named "${name}".` }
    if (isLive(record)) await this.stop(name)
    if (record.run.unit || record.autostart === 'system')
      await removeUnit(name).catch(() => undefined)
    this.restartTimes.delete(name)
    await this.registry.remove(name)
    if (!opts.keepLogs)
      await fs
        .rm(path.join(this.logsRoot, name), { recursive: true, force: true })
        .catch(() => undefined)
    return { ok: true }
  }

  // ───────────────────────────────────────────── adopt

  async adopt(input: {
    name: string
    pid?: number
    port?: number
    match?: string
    conversationId?: string | null
    logPath?: string
  }): Promise<{ ok: boolean; error?: string; record?: ProcessRecord }> {
    const name = normalizeName(input.name)
    if (!name) return { ok: false, error: 'name must be a slug.' }
    if (this.registry.get(name) && isLive(this.registry.get(name) as ProcessRecord)) {
      return { ok: false, error: `"${name}" is already a running managed process.` }
    }
    let pid = Number(input.pid) || 0
    let port: number | null = null
    if (!pid && input.port) {
      const owner = await portOwner(Number(input.port))
      if (!owner?.pid)
        return {
          ok: false,
          error: `Nothing is listening on port ${input.port} (or its owner cannot be identified).`
        }
      pid = owner.pid
      port = owner.port
    }
    if (!pid && input.match) {
      const found = await findByCommand(input.match)
      if (!found)
        return { ok: false, error: `No process whose command line contains "${input.match}".` }
      pid = found
    }
    if (!pid) return { ok: false, error: 'Pass pid, port, or match (a command-line substring).' }
    if ((await ownProcessTree()).has(pid)) {
      return {
        ok: false,
        error: `pid ${pid} is Wolffish itself (or the runner that launched it), not a user process — process_ports marks these.`
      }
    }
    const info = await processInfo(pid)
    if (!info) return { ok: false, error: `pid ${pid} is not running.` }
    if (this.registry.list().some((r) => r.name !== name && isLive(r) && r.run.pid === pid)) {
      return { ok: false, error: `pid ${pid} is already managed.` }
    }
    if (!port) {
      const listeners = await listeningPorts()
      const tree = new Set([pid, ...(await treeOf(pid).catch(() => [] as number[]))])
      port = listeners.find((l) => l.pid !== null && tree.has(l.pid))?.port ?? null
    }
    const existing = this.registry.get(name)
    const record: ProcessRecord = {
      id: existing?.id ?? randomUUID(),
      name,
      command: info.commandLine ?? existing?.command ?? '',
      cwd: existing?.cwd ?? homedir(),
      env: existing?.env ?? {},
      port: port ? { mode: 'fixed', port } : { mode: 'none' },
      ready: existing?.ready ?? {},
      restart: 'never',
      onQuit: 'keep',
      autostart: 'off',
      origin: { conversationId: input.conversationId ?? null, kind: 'adopted' },
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      run: {
        ...emptyRun(),
        pid,
        signature: signatureOf(info.commandLine ?? ''),
        osStart: info.startedAt,
        port,
        url: port ? `http://localhost:${port}` : null,
        state: 'running',
        startedAt: Date.now(),
        readyAt: Date.now(),
        logPath: input.logPath ?? null,
        adoptedAt: Date.now()
      }
    }
    await this.registry.upsert(record)
    return { ok: true, record }
  }

  // ───────────────────────────────────────────── status waits

  /** Block until a state or a log line shows up, or the timeout passes. Returns the record either way. */
  async waitFor(
    name: string,
    cond: { state?: string; logMatch?: string; timeoutMs?: number }
  ): Promise<{ record: ProcessRecord | null; matched: boolean; matchedBy: string | null }> {
    const deadline = Date.now() + Math.max(500, Math.min(cond.timeoutMs ?? 60_000, 3_600_000))
    const re = cond.logMatch ? safeRegex(cond.logMatch) : null
    const startSize = re ? await this.fileSize(this.registry.get(name)?.run.logPath) : 0
    while (Date.now() < deadline) {
      const cur = this.registry.get(name)
      if (!cur) return { record: null, matched: false, matchedBy: null }
      if (cond.state && cur.run.state === cond.state)
        return { record: cur, matched: true, matchedBy: 'state' }
      if (re && cur.run.logPath) {
        const text = stripAnsi(await this.readFrom(cur.run.logPath, startSize))
        if (re.test(text)) return { record: cur, matched: true, matchedBy: 'log' }
      }
      if (!cond.state && !re) return { record: cur, matched: true, matchedBy: null }
      await sleep(400)
    }
    return { record: this.registry.get(name), matched: false, matchedBy: null }
  }

  // ───────────────────────────────────────────── liveness / reconcile

  private async isAlive(record: ProcessRecord): Promise<boolean> {
    const pid = record.run.pid
    if (!pid) return false
    if (this.children.has(record.name) && pidExists(pid)) return true
    const info = await processInfo(pid)
    if (!info) return false
    if (record.run.osStart && info.startedAt) return info.startedAt === record.run.osStart
    if (record.run.signature && info.commandLine)
      return info.commandLine.includes(record.run.signature)
    return true
  }

  private async refreshUnit(record: ProcessRecord): Promise<void> {
    const state = await unitState(record.name)
    await this.registry.mutate(record.name, (cur) => ({
      ...cur,
      run: {
        ...cur.run,
        pid: state.pid ?? (state.running ? cur.run.pid : null),
        state: state.running
          ? 'running'
          : cur.run.state === 'stopping'
            ? 'stopped'
            : state.installed
              ? 'stopped'
              : cur.run.state,
        lastError: state.warning
      }
    }))
  }

  /**
   * Relaunch reconcile: every record with a run is re-tested by pid + OS
   * start stamp. Alive is adopted (`adoptedAt`), dead is closed out. Unit
   * records ask the service manager. NOTHING is killed here.
   */
  async reconcile(): Promise<void> {
    // A finished one-shot — exited 0, never ready, no port — is noise in
    // every list whoever started it; nothing can restart it and its log said
    // what it said. Keyed on that shape, not on origin, so records that
    // finished while Wolffish was closed (or predate this rule) go too.
    await this.pruneStale()
    for (const record of this.registry.list()) {
      if (record.run.unit || record.autostart === 'system') {
        if (record.autostart === 'system' && !record.run.unit) {
          await this.registry.mutate(record.name, (cur) => ({
            ...cur,
            run: { ...cur.run, unit: cur.name }
          }))
        }
        await this.refreshUnit(this.registry.get(record.name) ?? record).catch(() => undefined)
        continue
      }
      if (!isLive(record)) continue
      const alive = await this.isAlive(record)
      await this.registry.mutate(record.name, (cur) => ({
        ...cur,
        run: alive
          ? { ...cur.run, state: 'running', adoptedAt: Date.now() }
          : {
              ...cur.run,
              state: cur.run.state === 'stopping' ? 'stopped' : 'exited',
              endedAt: cur.run.endedAt ?? Date.now(),
              lastError:
                cur.run.state === 'stopping' ? null : 'ended while Wolffish was not running'
            }
      }))
    }
  }

  /** Periodic liveness for runs we do not hold a child handle for (adopted, relaunched, unit-owned). */
  private async pruneStale(): Promise<void> {
    for (const record of this.registry.list()) {
      if (isStaleRecord(record)) await this.registry.remove(record.name)
    }
  }

  private async pollLiveness(): Promise<void> {
    if (this.quitting) return
    await this.pruneStale()
    for (const record of this.registry.list()) {
      if (!isLive(record)) continue
      if (this.children.has(record.name)) continue
      if (record.run.unit) {
        await this.refreshUnit(record).catch(() => undefined)
        continue
      }
      if (await this.isAlive(record)) continue
      const updated = await this.registry.mutate(record.name, (cur) =>
        cur.run.pid === record.run.pid && isLive(cur)
          ? {
              ...cur,
              run: {
                ...cur.run,
                state:
                  this.stopping.has(cur.name) || cur.run.state === 'stopping'
                    ? 'stopped'
                    : 'exited',
                endedAt: Date.now()
              }
            }
          : cur
      )
      if (updated && updated.run.state === 'exited' && updated.origin.kind !== 'adopted')
        this.superviseAfterExit(updated)
    }
  }

  // ───────────────────────────────────────────── cards

  /** A live turn's broca receives card snapshots for cards opened in that turn. */
  registerTurnEmitter(turnId: string, emit: (snapshot: ProcessCardSnapshot) => void): () => void {
    this.turnEmitters.set(turnId, emit)
    return () => this.turnEmitters.delete(turnId)
  }

  /** Post-turn card updates (broadcast + conversation-file write-through live in main). */
  onCard(listener: (snapshot: ProcessCardSnapshot) => void): () => void {
    this.cardListeners.add(listener)
    return () => this.cardListeners.delete(listener)
  }

  isOwningTurnLive(cardId: string): boolean {
    const card = this.cards.get(cardId)
    return Boolean(card?.turnId && this.turnEmitters.has(card.turnId))
  }

  openCard(input: {
    conversationId: string | null
    turnId: string | null
    title?: string | null
    names: string[] | null
  }): ProcessCardSnapshot {
    const handle: CardHandle = {
      cardId: `proc_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`,
      conversationId: input.conversationId,
      turnId: input.turnId,
      title: input.title ?? null,
      names: input.names,
      createdAt: Date.now()
    }
    this.cards.set(handle.cardId, handle)
    const snapshot = this.cardSnapshot(handle)
    this.emitCard(snapshot)
    return snapshot
  }

  private cardSnapshot(handle: CardHandle): ProcessCardSnapshot {
    const all = this.registry.list()
    const processes = handle.names
      ? handle.names
          .map((n) => all.find((r) => r.name === n))
          .filter((r): r is ProcessRecord => Boolean(r))
      : all
    return {
      cardId: handle.cardId,
      conversationId: handle.conversationId,
      turnId: handle.turnId,
      title: handle.title,
      names: handle.names,
      processes,
      createdAt: handle.createdAt,
      updatedAt: Date.now()
    }
  }

  private refreshCardsFor(name: string | null): void {
    for (const handle of this.cards.values()) {
      if (name && handle.names && !handle.names.includes(name)) continue
      this.emitCard(this.cardSnapshot(handle))
    }
  }

  private emitCard(snapshot: ProcessCardSnapshot): void {
    const handle = this.cards.get(snapshot.cardId)
    const emit = handle?.turnId ? this.turnEmitters.get(handle.turnId) : undefined
    if (emit) {
      try {
        emit(snapshot)
      } catch {
        // broca guard
      }
    }
    for (const cb of this.cardListeners) {
      try {
        cb(snapshot)
      } catch {
        // listener's problem
      }
    }
  }

  // ───────────────────────────────────────────── files

  private async rotateLog(logPath: string): Promise<void> {
    try {
      const st = await fs.stat(logPath)
      if (st.size < LOG_ROTATE_BYTES) return
      await fs.rm(`${logPath}.2`, { force: true }).catch(() => undefined)
      await fs.rename(`${logPath}.1`, `${logPath}.2`).catch(() => undefined)
      await fs.rename(logPath, `${logPath}.1`)
    } catch {
      // no log yet
    }
  }

  private async fileSize(p: string | null | undefined): Promise<number> {
    if (!p) return 0
    try {
      return (await fs.stat(p)).size
    } catch {
      return 0
    }
  }

  private async readFrom(p: string, offset: number): Promise<string> {
    try {
      const fh = await fs.open(p, 'r')
      try {
        const size = (await fh.stat()).size
        const start = Math.max(0, Math.min(offset, size))
        const len = Math.min(size - start, 512 * 1024)
        if (len <= 0) return ''
        const buf = Buffer.alloc(len)
        await fh.read(buf, 0, len, start)
        return buf.toString('utf8')
      } finally {
        await fh.close()
      }
    } catch {
      return ''
    }
  }

  private async readTail(p: string | null | undefined, maxBytes: number): Promise<string> {
    if (!p) return ''
    try {
      const fh = await fs.open(p, 'r')
      try {
        const size = (await fh.stat()).size
        const start = Math.max(0, size - maxBytes)
        const len = size - start
        if (len <= 0) return ''
        const buf = Buffer.alloc(len)
        await fh.read(buf, 0, len, start)
        return stripAnsi(buf.toString('utf8'))
      } finally {
        await fh.close()
      }
    } catch {
      return ''
    }
  }
}

// ───────────────────────────────────────────── helpers

/** Exited 0 without ever being ready or holding a port: a command, not a service. */
export function isFinishedOneShot(record: ProcessRecord): boolean {
  return (
    !isLive(record) &&
    record.run.state === 'exited' &&
    record.run.exitCode === 0 &&
    record.run.port === null &&
    record.run.unit === null
  )
}

const STALE_AFTER_MS = 3_600_000

/**
 * Records nothing can act on any more: a finished one-shot (its "readiness"
 * was only "alive for a while" or a URL it printed), or an adopted process
 * that ended (there is no command to start again). Kept for an hour so a
 * turn that is still looking at it finds it, then dropped; the log stays.
 */
function isStaleRecord(record: ProcessRecord, now = Date.now()): boolean {
  if (isLive(record) || !record.run.endedAt || now - record.run.endedAt < STALE_AFTER_MS)
    return false
  return isFinishedOneShot(record) || record.origin.kind === 'adopted'
}

/**
 * macOS keeps Desktop, Documents and Downloads behind TCC: a launchd agent
 * (which runs /bin/sh, not Wolffish) is denied there with "can't open input
 * file" / "Operation not permitted" at every login. Wolffish itself already
 * holds that access, so the `wolffish` level works where `system` cannot.
 */
function protectedFolderNote(cwd: string): string | null {
  if (process.platform !== 'darwin') return null
  const home = homedir()
  for (const dir of ['Desktop', 'Documents', 'Downloads']) {
    const root = path.join(home, dir)
    if (cwd === root || cwd.startsWith(root + path.sep)) {
      return (
        `A macOS login unit cannot read ${path.join('~', dir)} (TCC blocks launchd there), so "system" autostart would fail at every login. ` +
        'Use autostart "wolffish" — Wolffish already has access and starts the process whenever it starts — or move the project out of that folder first.'
      )
    }
  }
  return null
}

function resolveCwd(input: string | undefined): string {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) return homedir()
  if (raw === '~') return homedir()
  if (raw.startsWith('~/')) return path.join(homedir(), raw.slice(2))
  return path.resolve(raw)
}

/** A short token from the command for the (secondary) command-line check. */
function signatureOf(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? ''
  return path.basename(first).slice(0, 40)
}

function safeRegex(source: string): RegExp {
  try {
    return new RegExp(source, 'i')
  } catch {
    return new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }
}

export function humanAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

async function findByCommand(needle: string): Promise<number | null> {
  const { execFile } = await import('node:child_process')
  const text = await new Promise<string>((resolve) => {
    if (process.platform === 'win32') {
      execFile(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }'
        ],
        { timeout: 15000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        (err, out) => resolve(err ? '' : String(out))
      )
    } else {
      execFile(
        'ps',
        ['-axo', 'pid=,command='],
        { timeout: 8000, maxBuffer: 16 * 1024 * 1024 },
        (err, out) => resolve(err ? '' : String(out))
      )
    }
  })
  const lower = needle.toLowerCase()
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    if (pid === process.pid) continue
    if (m[2].toLowerCase().includes(lower) && !m[2].includes('ps -axo')) return pid
  }
  return null
}
