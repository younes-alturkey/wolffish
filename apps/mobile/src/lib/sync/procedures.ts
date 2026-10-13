import { importLocalFile } from '@/lib/files/fileCache'
import { queryClient } from '@/lib/query/queryClient'
import { tunnelClient } from '@/lib/tunnel/client'
import { toBase64Url } from '@/lib/tunnel/pairing'
import {
  CHUNK_SIZE,
  Rpc,
  type ReasoningMode,
  type SyncProcedure,
  type SyncProjectFile
} from '@/lib/tunnel/protocol'
import { useDemoConfig } from '@/state/demoConfig'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { File, FileMode } from 'expo-file-system'

/**
 * Procedures — the desktop's `brain/procedures.json`, read and written from
 * here on the same contract as projects (lib/sync/projects.ts): every write
 * goes to the desktop and the stored row is what lands in the cache.
 *
 * Unpaired (demo mode) the rows come from the config snapshot the bundle
 * carries, exactly as projects do — the screen is workspace CONTENT, and an
 * empty one says the workspace has no procedures rather than that this phone
 * has no desktop. There is still nowhere for a write to land, and the screen
 * says so (useProjectsWritable, which both screens read).
 */

export const procedureKeys = { list: ['procedures'] as const }

export function invalidateProcedures(): void {
  void queryClient.invalidateQueries({ queryKey: procedureKeys.list })
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
 * The snapshot's procedures — the demo bundle's copy, already in wire shape.
 * Peer of projects.ts snapshotProjects, and read on the same terms.
 */
function snapshotProcedures(): SyncProcedure[] {
  return useDemoConfig.getState().snapshotProcedures
}

async function fetchProcedures(): Promise<SyncProcedure[]> {
  // Disconnected keeps whatever the cache holds rather than emptying a list the
  // user is looking at; the reconnect's re-list is what corrects it.
  //
  // An EMPTY cached answer falls through to the snapshot on purpose. Demo entry
  // races: this query can run before applyConfigSnapshot has landed, caching
  // the empty list — and since the screen's own refetch would then read that
  // same empty cache back, the bundle's rows would never appear at all.
  if (!tunnelClient.connected) {
    const cached = queryClient.getQueryData<SyncProcedure[]>(procedureKeys.list)
    return cached?.length ? cached : snapshotProcedures()
  }
  const answer = await call<{ procedures?: SyncProcedure[] }>(Rpc.proceduresList)
  return Array.isArray(answer?.procedures) ? answer.procedures.map(normalize) : []
}

export function useProcedures(): UseQueryResult<SyncProcedure[]> {
  return useQuery({ queryKey: procedureKeys.list, queryFn: fetchProcedures, staleTime: 30_000 })
}

/** See projects.ts normalize — a desktop older than this phone sends neither. */
function normalize(procedure: SyncProcedure): SyncProcedure {
  return {
    ...procedure,
    files: procedure.files ?? [],
    directories: procedure.directories ?? [],
    // Absent on a desktop older than the thinking field, and on the demo
    // bundle published before it — null is "follow the model".
    thinking: procedure.thinking ?? null
  }
}

/** See projects.ts absorb — the desktop's row, in the cache, before the push. */
function absorb(incoming: SyncProcedure): SyncProcedure {
  const procedure = normalize(incoming)
  queryClient.setQueryData<SyncProcedure[]>(procedureKeys.list, (current) => {
    const rows = current ?? []
    const index = rows.findIndex((row) => row.id === procedure.id)
    const next = index >= 0 ? rows.with(index, procedure) : [procedure, ...rows]
    return [...next].sort((a, b) => b.updatedAt - a.updatedAt)
  })
  return procedure
}

export async function createProcedure(input: {
  title: string
  prompt: string
  mode?: 'single' | 'workflow'
  thinking?: ReasoningMode
  icon?: string
  projectId?: string
}): Promise<SyncProcedure> {
  const answer = await call<{ procedure: SyncProcedure }>(Rpc.procedureCreate, input)
  return absorb(answer.procedure)
}

export async function updateProcedure(input: {
  id: string
  title?: string
  prompt?: string
  mode?: 'single' | 'workflow'
  /**
   * The procedure's own reasoning effort. Sent only when the user picked one on
   * the card; omitted leaves the desktop's stamp alone.
   */
  thinking?: ReasoningMode
  icon?: string
  /** '' unbinds the project, exactly as the desktop's setter reads it. */
  projectId?: string
  /**
   * Whole-list replaces. Dropping a file DELETES the desktop's copy, so send
   * these only when the list actually changed. A directory that is not a
   * folder on the desktop is REFUSED — the call rejects with the reason, which
   * is the screen's validation.
   */
  files?: SyncProjectFile[]
  directories?: string[]
}): Promise<SyncProcedure> {
  const answer = await call<{ procedure: SyncProcedure }>(Rpc.procedureUpdate, input)
  return absorb(answer.procedure)
}

export async function deleteProcedure(id: string): Promise<void> {
  await call<{ ok: boolean }>(Rpc.procedureDelete, { id })
  queryClient.setQueryData<SyncProcedure[]>(procedureKeys.list, (current) =>
    (current ?? []).filter((row) => row.id !== id)
  )
}

/**
 * Upload one file into a procedure, chunk by chunk — the phone's Add-files.
 *
 * A byte-for-byte peer of uploadProjectFile (lib/sync/projects.ts): the desktop
 * owns the workspace so it owns the name, the bytes land in
 * `uploads/procedure-<id>/`, and the stored procedure it answers with is what
 * lands in the cache. `onProgress` reports bytes sent, which is what lets the
 * dialog draw the same real bar the desktop's copy-progress card draws.
 */
export async function uploadProcedureFile(
  procedureId: string,
  localUri: string,
  name: string,
  mimeType: string | null,
  onProgress?: (sentBytes: number, totalBytes: number) => void
): Promise<SyncProcedure> {
  const source = new File(localUri)
  if (!source.exists) throw new Error(`no file at ${localUri}`)
  const sizeBytes = source.size ?? 0
  if (sizeBytes <= 0) throw new Error(`empty file at ${localUri}`)

  const begin = await call<{ uploadId: string }>(Rpc.uploadBegin, {
    name,
    mimeType,
    sizeBytes,
    procedureId
  })
  // Published before the first chunk so the bar is sized from its first frame.
  onProgress?.(0, sizeBytes)

  const handle = source.open(FileMode.ReadOnly)
  try {
    let offset = 0
    while (offset < sizeBytes) {
      const bytes = handle.readBytes(Math.min(CHUNK_SIZE, sizeBytes - offset))
      if (bytes.length === 0) throw new Error('local file truncated mid-upload')
      await call(Rpc.uploadChunk, {
        uploadId: begin.uploadId,
        offset,
        data: toBase64Url(bytes)
      })
      offset += bytes.length
      onProgress?.(offset, sizeBytes)
    }
  } finally {
    handle.close()
  }

  const answer = await call<{ procedure: SyncProcedure; filePath?: string }>(Rpc.uploadCommit, {
    uploadId: begin.uploadId
  })
  if (answer.filePath) {
    // A cache hit rather than an immediate re-download of what was just sent.
    // Best-effort: a failure here costs one download later, never the upload.
    await importLocalFile(localUri, answer.filePath).catch(() => null)
  }
  return absorb(answer.procedure)
}
