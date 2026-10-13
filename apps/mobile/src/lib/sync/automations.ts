import { queryClient } from '@/lib/query/queryClient'
import { toBase64Url } from '@/lib/tunnel/pairing'
import { tunnelClient } from '@/lib/tunnel/client'
import {
  CHUNK_SIZE,
  Rpc,
  RUN_KINDS,
  type AutomationJob,
  type AutomationQueuedRun,
  type AutomationRun,
  type AutomationRuns,
  type RunKind
} from '@/lib/tunnel/protocol'
import { File, FileMode } from 'expo-file-system'
import { useDemoConfig } from '@/state/demoConfig'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'

/**
 * Automations — the desktop's `brain/brainstem/heartbeat.md`.
 *
 * The file is the store, so this module carries no per-automation write: it
 * reads the whole file (plus the scheduler's live view of it) and writes the
 * whole file back. All the block surgery in between is
 * lib/automations/heartbeat.ts, which is pure and tested; this file is only the
 * wire and the cache.
 *
 * Writes are SERIALIZED through one chain, deliberately. Every edit is a
 * read-modify-write of one file, and two of them in flight against the same
 * snapshot would silently drop the earlier one — the desktop's own page
 * serializes its card saves for exactly this reason. The chain also re-reads the
 * newest markdown before each splice, so an edit made on the desktop between
 * two of this screen's saves is not clobbered.
 */

export type AutomationsSnapshot = {
  /** heartbeat.md verbatim. */
  markdown: string
  /** The scheduler's ACTIVE jobs — cron and next fire, resolved on the desktop. */
  jobs: AutomationJob[]
  /** Per-label "Edited …" stamps, maintained writer-agnostically on that side. */
  stamps: Record<string, number>
  runs: AutomationRuns
}

const EMPTY: AutomationsSnapshot = {
  markdown: '',
  jobs: [],
  stamps: {},
  runs: { running: [], queued: [] }
}

export const automationKeys = { snapshot: ['automations'] as const }

// ------------------------------------------------------------------ the pool

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** An unknown kind reads as an automation — the gating then treats it as one. */
function runKind(value: unknown): RunKind {
  return (RUN_KINDS as readonly string[]).includes(text(value)) ? (value as RunKind) : 'automation'
}

/** A run off the wire, or null if it is not one. Every field but `id` defaults. */
function readRun(row: unknown): AutomationRun | null {
  const source = row as Partial<AutomationRun> | null
  const id = text(source?.id)
  if (!id) return null
  return { id, label: text(source?.label), kind: runKind(source?.kind) }
}

function readQueued(row: unknown): AutomationQueuedRun | null {
  const source = row as Partial<AutomationQueuedRun> | null
  const id = text(source?.id)
  if (!id) return null
  return { id, label: text(source?.label), kind: runKind(source?.kind) }
}

/**
 * The run pool off the wire — the `automations.runs` push and the `runs` half
 * of an automationsRead answer. Normalized rather than trusted: an older
 * desktop sends rows without `kind`, and a row with no id is not a run.
 */
export function readRuns(payload: unknown): AutomationRuns {
  const source = payload as { running?: unknown; queued?: unknown } | null
  const running = Array.isArray(source?.running) ? source.running : []
  const queued = Array.isArray(source?.queued) ? source.queued : []
  return {
    running: running.map(readRun).filter((row): row is AutomationRun => row !== null),
    queued: queued.map(readQueued).filter((row): row is AutomationQueuedRun => row !== null)
  }
}

export function invalidateAutomations(): void {
  void queryClient.invalidateQueries({ queryKey: automationKeys.snapshot })
}

/**
 * Fold a run-pool push into the cached snapshot without a refetch. The push
 * carries the whole pool, so this is the state — and it fires several times per
 * run, which is why it must not cost an RPC each time.
 */
export function applyRunsPush(runs: AutomationRuns): void {
  queryClient.setQueryData<AutomationsSnapshot>(automationKeys.snapshot, (current) =>
    current ? { ...current, runs } : current
  )
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

/**
 * The heartbeat the config snapshot carries — the demo bundle's copy of the
 * file, the scheduler's view of it, and its edit stamps. Peer of projects.ts
 * snapshotProjects: an unpaired phone renders workspace content from the
 * bundle rather than showing an empty screen it cannot fill.
 *
 * `runs` is deliberately never seeded. A run is something happening on a
 * machine this one cannot see right now, and an empty pool is the only honest
 * answer with no desktop behind it.
 */
function snapshotAutomations(): AutomationsSnapshot {
  const { markdown, jobs, stamps } = useDemoConfig.getState().snapshotAutomations
  if (!markdown && jobs.length === 0) return EMPTY
  return { markdown, jobs, stamps, runs: { running: [], queued: [] } }
}

async function readSnapshot(): Promise<AutomationsSnapshot> {
  if (!tunnelClient.connected) {
    // A cached file wins, so a paired phone that lost its link keeps the
    // heartbeat it was reading. An EMPTY one falls through to the snapshot:
    // this query can run before applyConfigSnapshot lands on demo entry, and a
    // cached blank would be read straight back by the screen's own refetch.
    const cached = queryClient.getQueryData<AutomationsSnapshot>(automationKeys.snapshot)
    return cached?.markdown ? cached : snapshotAutomations()
  }
  const answer = await call<Partial<AutomationsSnapshot>>(Rpc.automationsRead)
  return {
    markdown: typeof answer?.markdown === 'string' ? answer.markdown : '',
    jobs: Array.isArray(answer?.jobs) ? answer.jobs : [],
    stamps: answer?.stamps && typeof answer.stamps === 'object' ? answer.stamps : {},
    runs: readRuns(answer?.runs)
  }
}

export function useAutomations(): UseQueryResult<AutomationsSnapshot> {
  return useQuery({
    queryKey: automationKeys.snapshot,
    queryFn: readSnapshot,
    // The desktop pushes automations.changed on every scheduler reload, which is
    // every write to the file from any writer.
    staleTime: 30_000
  })
}

/** The freshest markdown this device has — the cache, which every write updates. */
function cachedMarkdown(): string {
  return queryClient.getQueryData<AutomationsSnapshot>(automationKeys.snapshot)?.markdown ?? ''
}

let writeChain: Promise<unknown> = Promise.resolve()

/**
 * Splice the file and write it back, one edit at a time.
 *
 * `edit` receives the markdown as it stands on the DESKTOP right now — re-read
 * inside the chain, never captured when the button was pressed — so an edit made
 * there between two of this screen's saves survives. It answers the new file, or
 * null to abandon the edit (the block it was going to touch is gone).
 *
 * The cache is updated from the value actually written, so cards repaint in the
 * same frame the write is dispatched rather than a round trip later; the
 * automations.changed push that follows confirms with the desktop's own read.
 */
export function editAutomations(
  edit: (markdown: string) => string | null
): Promise<{ markdown: string } | null> {
  const run = writeChain.then(async () => {
    // A stale cache would splice into text the desktop has moved on from. This
    // is one small RPC per edit, and edits are user gestures, not a stream.
    const fresh = tunnelClient.connected ? (await readSnapshot()).markdown : cachedMarkdown()
    const next = edit(fresh)
    if (next === null) return null
    await call<{ ok: boolean }>(Rpc.automationsWrite, { markdown: next })
    queryClient.setQueryData<AutomationsSnapshot>(automationKeys.snapshot, (current) =>
      current ? { ...current, markdown: next } : { ...EMPTY, markdown: next }
    )
    // Jobs, stamps and the run pool are the scheduler's, and it has only just
    // been handed the new file — the push it fires on reload is what refreshes
    // them, so nothing is fetched here.
    return { markdown: next }
  })
  writeChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/** Replace the file wholesale — the markdown view's Save. */
export async function writeAutomations(markdown: string): Promise<void> {
  await editAutomations(() => markdown)
}

export type RunResult = { ok: boolean; started: boolean; error?: string }

/**
 * Run one automation now. Goes through the very pool a scheduled fire uses (up
 * to three at once, overflow queued), so `started: false` with `ok: true` means
 * queued or coalesced into a run already going — which is what the card's note
 * says rather than reporting a failure.
 */
export async function runAutomation(label: string): Promise<RunResult> {
  return call<RunResult>(Rpc.automationRun, { label })
}

/**
 * Upload one file into an automation, chunk by chunk — the phone's Add-files.
 *
 * An automation has no id (heartbeat.md is the store), so `existing` — the
 * `file:` paths it already holds — is what tells the desktop which folder it
 * owns. The answer is the ABSOLUTE path the desktop chose, because that is what
 * a `file:` marker holds; writing that marker is the caller's job, through
 * editAutomations like every other block edit.
 */
export async function uploadAutomationFile(
  existing: readonly string[],
  localUri: string,
  name: string,
  mimeType: string | null,
  onProgress?: (sentBytes: number, totalBytes: number) => void
): Promise<{ path: string; name: string }> {
  const source = new File(localUri)
  if (!source.exists) throw new Error(`no file at ${localUri}`)
  const sizeBytes = source.size ?? 0
  if (sizeBytes <= 0) throw new Error(`empty file at ${localUri}`)

  const begin = await call<{ uploadId: string }>(Rpc.uploadBegin, {
    name,
    mimeType,
    sizeBytes,
    automationFiles: existing
  })
  // Published before the first chunk so the bar is sized from its first frame.
  onProgress?.(0, sizeBytes)

  const handle = source.open(FileMode.ReadOnly)
  try {
    let offset = 0
    while (offset < sizeBytes) {
      const bytes = handle.readBytes(Math.min(CHUNK_SIZE, sizeBytes - offset))
      if (bytes.length === 0) throw new Error('local file truncated mid-upload')
      await call(Rpc.uploadChunk, { uploadId: begin.uploadId, offset, data: toBase64Url(bytes) })
      offset += bytes.length
      onProgress?.(offset, sizeBytes)
    }
  } finally {
    handle.close()
  }

  return call<{ path: string; name: string }>(Rpc.uploadCommit, { uploadId: begin.uploadId })
}

/**
 * Resolve a typed folder path against the DESKTOP's filesystem. Rejects with
 * that side's own message when the path names nothing or is not a folder —
 * which is the screen's validation, since a phone cannot check.
 */
export async function resolveDirectory(input: string): Promise<string> {
  const answer = await call<{ path: string }>(Rpc.resolveDirectory, { path: input })
  return answer.path
}
