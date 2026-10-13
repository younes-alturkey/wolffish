import { queryClient } from '@/lib/query/queryClient'
import { tunnelClient } from '@/lib/tunnel/client'
import { Rpc, type SyncProcess } from '@/lib/tunnel/protocol'
import { useDemoConfig } from '@/state/demoConfig'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'

/**
 * Managed processes — the desktop's process manager (its Library → Processes
 * tab), read and driven from here on the same contract as projects and
 * procedures (lib/sync/projects.ts): every action goes to the desktop and the
 * stored record is what lands in the cache. Unpaired (demo mode) the rows come
 * from the config snapshot the bundle carries, exactly as procedures do — the
 * tab is workspace content, and a demo without it would be a tab that says
 * the feature does not exist. There is still nowhere for a Stop to land, and
 * the tab goes read-only (useProjectsWritable, which every library tab reads).
 *
 * The desktop's own push (Event.processesChanged) fires on every registry
 * write — a start, a state transition, a stop, an edit — whoever caused it,
 * so a card pressed here and a tool the model ran there both re-list this
 * phone the same way.
 */

export const processKeys = { list: ['processes'] as const }

export function invalidateProcesses(): void {
  void queryClient.invalidateQueries({ queryKey: processKeys.list })
}

async function call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  const tunnel = tunnelClient.active
  if (!tunnel || !tunnelClient.connected) throw new Error('not connected')
  try {
    return (await tunnel.rpc(method, params)) as T
  } catch (error) {
    tunnelClient.reportRpcFailure(error)
    throw error
  }
}

export type ProcessState = SyncProcess['run']['state']
export type ProcessAutostart = SyncProcess['autostart']
export type RestartPolicy = SyncProcess['restart']

export function isLiveState(state: ProcessState): boolean {
  return state === 'starting' || state === 'running' || state === 'stopping'
}

/** Tolerant read of one record — a desktop older than a field sends nothing for it. */
export function normalizeProcess(record: SyncProcess): SyncProcess {
  const run = record.run ?? ({} as SyncProcess['run'])
  return {
    ...record,
    env: record.env ?? {},
    port: record.port ?? { mode: 'none' },
    ready: record.ready ?? {},
    restart: record.restart ?? 'on-failure',
    onQuit: record.onQuit ?? 'keep',
    autostart: record.autostart ?? 'off',
    origin: record.origin ?? { conversationId: null, kind: 'started' },
    run: {
      pid: run.pid ?? null,
      signature: run.signature ?? '',
      osStart: run.osStart ?? null,
      port: run.port ?? null,
      url: run.url ?? null,
      state: run.state ?? 'stopped',
      exitCode: run.exitCode ?? null,
      exitSignal: run.exitSignal ?? null,
      startedAt: run.startedAt ?? null,
      readyAt: run.readyAt ?? null,
      endedAt: run.endedAt ?? null,
      restarts: run.restarts ?? 0,
      logPath: run.logPath ?? null,
      unit: run.unit ?? null,
      adoptedAt: run.adoptedAt ?? null,
      lastError: run.lastError ?? null
    }
  }
}

/** The snapshot's processes — the demo bundle's copy, already in wire shape. */
function snapshotProcesses(): SyncProcess[] {
  return useDemoConfig.getState().snapshotProcesses
}

async function fetchProcesses(): Promise<SyncProcess[]> {
  // Disconnected keeps whatever the cache holds rather than emptying a list
  // the user is looking at; the reconnect's re-list is what corrects it. An
  // EMPTY cached answer falls through to the snapshot on purpose (see
  // procedures.ts: the demo-entry race that otherwise hides the bundle's rows).
  if (!tunnelClient.connected) {
    const cached = queryClient.getQueryData<SyncProcess[]>(processKeys.list)
    return cached?.length ? cached : snapshotProcesses().map(normalizeProcess)
  }
  const answer = await call<{ processes?: SyncProcess[] }>(Rpc.processesList)
  return Array.isArray(answer?.processes) ? answer.processes.map(normalizeProcess) : []
}

export function useProcesses(): UseQueryResult<SyncProcess[]> {
  return useQuery({ queryKey: processKeys.list, queryFn: fetchProcesses, staleTime: 15_000 })
}

/** The desktop's record, in the cache, before its push lands. */
function absorb(incoming: SyncProcess | undefined): void {
  if (!incoming) return
  const record = normalizeProcess(incoming)
  queryClient.setQueryData<SyncProcess[]>(processKeys.list, (current) => {
    const rows = current ?? []
    const index = rows.findIndex((row) => row.name === record.name)
    return index >= 0 ? rows.with(index, record) : [...rows, record]
  })
}

type Outcome = { ok: boolean; error?: string; record?: SyncProcess; warning?: string }

export async function startProcess(input: {
  name: string
  command: string
  cwd?: string
  restart?: RestartPolicy
  onQuit?: 'keep' | 'stop'
  autostart?: ProcessAutostart
}): Promise<Outcome> {
  const answer = await call<Outcome>(Rpc.processStart, input)
  absorb(answer.record)
  invalidateProcesses()
  return answer
}

export async function stopProcess(
  name: string
): Promise<{ ok: boolean; stopped: boolean; error?: string; record?: SyncProcess }> {
  const answer = await call<{
    ok: boolean
    stopped: boolean
    error?: string
    record?: SyncProcess
  }>(Rpc.processStop, { name })
  absorb(answer.record)
  return answer
}

export async function stopAllProcesses(): Promise<Array<{ name: string; stopped: boolean }>> {
  const answer = await call<{ results?: Array<{ name: string; stopped: boolean }> }>(
    Rpc.processStopAll
  )
  invalidateProcesses()
  return Array.isArray(answer?.results) ? answer.results : []
}

export async function restartProcess(name: string): Promise<Outcome> {
  const answer = await call<Outcome>(Rpc.processRestart, { name })
  absorb(answer.record)
  return answer
}

export async function updateProcess(input: {
  name: string
  command?: string
  cwd?: string
  restart?: RestartPolicy
  onQuit?: 'keep' | 'stop'
  autostart?: ProcessAutostart
  newName?: string
}): Promise<Outcome> {
  const answer = await call<Outcome>(Rpc.processUpdate, input)
  if (input.newName && answer.ok) invalidateProcesses()
  else absorb(answer.record)
  return answer
}

export async function removeProcess(name: string): Promise<{ ok: boolean; error?: string }> {
  const answer = await call<{ ok: boolean; error?: string }>(Rpc.processRemove, { name })
  if (answer.ok) {
    queryClient.setQueryData<SyncProcess[]>(processKeys.list, (current) =>
      (current ?? []).filter((row) => row.name !== name)
    )
  }
  return answer
}

export async function readProcessLogs(name: string, lines = 200): Promise<string> {
  const answer = await call<{ text?: string }>(Rpc.processLogs, { name, lines })
  return typeof answer?.text === 'string' ? answer.text : ''
}
