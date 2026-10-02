/**
 * The process manager's data model.
 *
 * A DEFINITION is durable and named: the command, where it runs, how it
 * gets its port, and the three policies (restart, on quit, autostart). A
 * RUN is one live instance of that definition — a pid plus the liveness
 * signature that proves the pid still is that process. Restart, autostart
 * and "list everything" all key on the name; the pid is a detail of the
 * current run and is never trusted on its own (pids get reused).
 */

export type ProcessState = 'stopped' | 'starting' | 'running' | 'stopping' | 'exited' | 'crashed'

export type RestartPolicy = 'never' | 'on-failure' | 'always'

/**
 * off      — nothing starts it but a tool call or a button.
 * wolffish — Wolffish starts it when Wolffish starts (any OS, no service
 *            manager; the safe default for "run at login").
 * system   — a per-process LaunchAgent / systemd user unit / Task Scheduler
 *            task, so it runs even when Wolffish does not.
 */
export type ProcessAutostart = 'off' | 'wolffish' | 'system'

export type ProcessPortPolicy =
  | { mode: 'wolffish' }
  | { mode: 'fixed'; port: number; takeover?: boolean }
  | { mode: 'none' }

export type ProcessReadiness = {
  /** Wait for a TCP listener owned by the process tree (default true when a port is allocated). */
  port?: boolean
  /** Wait for this substring / regex source to appear in the log. */
  logMatch?: string
  /** Give up waiting after this long; the process keeps running. Default 30 s. */
  timeoutMs?: number
}

export type ProcessOrigin = {
  conversationId: string | null
  /** started: process_start · shell: shell_exec background=true · adopted: process_adopt */
  kind: 'started' | 'shell' | 'adopted'
}

export type ProcessDefinition = {
  id: string
  /** Model-chosen slug, unique per workspace: web-dev, api, tunnel. */
  name: string
  command: string
  cwd: string
  env: Record<string, string>
  port: ProcessPortPolicy
  ready: ProcessReadiness
  restart: RestartPolicy
  onQuit: 'keep' | 'stop'
  autostart: ProcessAutostart
  origin: ProcessOrigin
  createdAt: number
  updatedAt: number
}

export type ProcessRun = {
  pid: number | null
  /** Substring the live command line must still contain for the pid to be "ours". */
  signature: string
  /** The OS's own start stamp for the pid, recorded right after spawn. */
  osStart: string | null
  port: number | null
  url: string | null
  state: ProcessState
  exitCode: number | null
  exitSignal: string | null
  startedAt: number | null
  readyAt: number | null
  endedAt: number | null
  /** Restarts performed by the supervisor for this definition since the last explicit start. */
  restarts: number
  logPath: string | null
  /** Set when the process is owned by an OS unit (autostart: system). */
  unit: string | null
  /** Set when a relaunch or process_adopt attached to a pid it did not spawn. */
  adoptedAt: number | null
  lastError: string | null
}

export type ProcessRecord = ProcessDefinition & { run: ProcessRun }

/** What the chat card carries: a titled selection of records, replaced whole on every change. */
export type ProcessCardSnapshot = {
  cardId: string
  conversationId: string | null
  turnId: string | null
  title: string | null
  /** The names the card follows; `null` follows every process. */
  names: string[] | null
  processes: ProcessRecord[]
  createdAt: number
  updatedAt: number
}

export type ListeningPort = {
  port: number
  pid: number | null
  command: string | null
}

export type ProcessStartInput = {
  name: string
  command: string
  cwd?: string
  env?: Record<string, string>
  port?: ProcessPortPolicy
  ready?: ProcessReadiness
  restart?: RestartPolicy
  onQuit?: 'keep' | 'stop'
  autostart?: ProcessAutostart
  origin?: ProcessOrigin
  /** Block until ready or timeout (default true). */
  wait?: boolean
}

export type ProcessStartResult =
  | {
      ok: true
      record: ProcessRecord
      ready: boolean
      alreadyRunning: boolean
      tail: string
      warnings: string[]
    }
  | { ok: false; error: string; record?: ProcessRecord; tail?: string }

export function emptyRun(): ProcessRun {
  return {
    pid: null,
    signature: '',
    osStart: null,
    port: null,
    url: null,
    state: 'stopped',
    exitCode: null,
    exitSignal: null,
    startedAt: null,
    readyAt: null,
    endedAt: null,
    restarts: 0,
    logPath: null,
    unit: null,
    adoptedAt: null,
    lastError: null
  }
}

export const LIVE_STATES: ReadonlySet<ProcessState> = new Set(['starting', 'running', 'stopping'])

export function isLive(record: ProcessRecord): boolean {
  return LIVE_STATES.has(record.run.state)
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

export function normalizeName(raw: unknown): string | null {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
  return NAME_RE.test(s) ? s : null
}
