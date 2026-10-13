import { queryClient } from '@/lib/query/queryClient'
import { tunnelClient } from '@/lib/tunnel/client'
import { useDesktopReachable } from '@/lib/tunnel/useTunnelStatus'
import { Rpc, type ReasoningMode, type SyncProject } from '@/lib/tunnel/protocol'
import { useAppStore } from '@/state/appStore'
import { useChatRuntime } from '@/state/chatRuntime'
import { useDemoConfig } from '@/state/demoConfig'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { File, FileMode } from 'expo-file-system'
import { CHUNK_SIZE } from '@/lib/tunnel/protocol'
import { toBase64Url } from '@/lib/tunnel/pairing'
import { importLocalFile } from '@/lib/files/fileCache'

/**
 * Projects — the desktop's `brain/projects.json`, read and WRITTEN from here.
 *
 * Every mutation goes straight to the desktop and the answer is what lands in
 * the cache: the store is one JSON file with one mutation tail on that side, so
 * the value it hands back is the value both screens hold. Nothing is optimistic
 * except a project's own editor drafts, which are the user's keystrokes and
 * belong on screen before any round trip.
 *
 * Unpaired (demo mode) the projects still come from the config snapshot the
 * bundle carries, so the screen renders — but there is nowhere for a write to
 * land, and the screen says so rather than pretending (see `projectsWritable`).
 */

export const projectKeys = { list: ['projects'] as const }

export function invalidateProjects(): void {
  void queryClient.invalidateQueries({ queryKey: projectKeys.list })
}

/**
 * Fill in fields a DESKTOP OLDER THAN THIS PHONE would not have sent.
 *
 * The wire type declares `directories` required, and the current desktop always
 * sends it — but the phone updates independently of the desktop it is paired
 * with, so "required" describes the contract, not what arrives. Everything
 * downstream maps over these arrays; one absent field is a screen that renders
 * nothing at all.
 */
function normalize(project: SyncProject): SyncProject {
  return {
    ...project,
    files: project.files ?? [],
    directories: project.directories ?? [],
    // Absent on a desktop older than the thinking field, and on the demo
    // bundle published before it — null is "follow the model", which is what
    // such a desktop does.
    thinking: project.thinking ?? null
  }
}

async function fetchProjects(): Promise<SyncProject[]> {
  const tunnel = tunnelClient.active
  if (!tunnel || !tunnelClient.connected) {
    // Not an error: an unpaired phone has the snapshot's copy, and a paired one
    // that cannot reach its desktop keeps whatever the cache holds. Throwing
    // would empty a list the user is looking at.
    return snapshotProjects()
  }
  try {
    const answer = (await tunnel.rpc(Rpc.projectsList)) as { projects?: SyncProject[] }
    return Array.isArray(answer?.projects) ? answer.projects.map(normalize) : []
  } catch (error) {
    tunnelClient.reportRpcFailure(error)
    throw error
  }
}

/**
 * The snapshot's project list, as the chat's project picker reads it. Shaped
 * into the wire type so demo mode and paired mode render one thing — the
 * snapshot's entries carry every field except a file path form, which they
 * already store workspace-relative.
 */
function snapshotProjects(): SyncProject[] {
  return useDemoConfig.getState().projects.map((project) => ({
    id: project.id,
    title: project.title,
    icon: project.icon,
    instructions: project.instructions,
    files: project.files ?? [],
    directories: project.directories ?? [],
    thinking: null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  }))
}

export function useProjects(): UseQueryResult<SyncProject[]> {
  return useQuery({
    queryKey: projectKeys.list,
    queryFn: fetchProjects,
    // The desktop announces every write (projects.changed), so polling would
    // only duplicate what the push already delivers.
    staleTime: 30_000
  })
}

/**
 * The project chat is working inside, or null — project mode, DERIVED.
 *
 * The runtime holds only the id (see chatRuntime.activeProjectId); the row comes
 * from the same list every other screen reads. That is what makes an edit made
 * on the DESKTOP land on the composer's emoji and the chat hero at the same
 * moment it lands on the Projects list — one push, one cache write, one render.
 * Holding a copy of the row instead left project mode showing the old title
 * until something happened to rewrite it.
 *
 * A project deleted while it was active resolves to null, which is the honest
 * answer: chat drops its project chrome rather than showing a project whose
 * instructions no turn will receive.
 */
export function useActiveProject(): SyncProject | null {
  const activeProjectId = useChatRuntime((state) => state.activeProjectId)
  const { data: projects } = useProjects()
  if (!activeProjectId) return null
  return projects?.find((project) => project.id === activeProjectId) ?? null
}

/**
 * Can a write land right now? Paired and connected — nothing else. These are the
 * desktop's files, and an edit with nowhere to go would sit on screen looking
 * applied until the next refresh silently undid it (the same rule
 * useSettingsReadOnly states for config).
 *
 * The predicate itself is `useDesktopReachable`, which several screens now need
 * for the same reason; this keeps the name the workspace screens read by.
 */
export function useProjectsWritable(): boolean {
  return useDesktopReachable()
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
 * Write the answer into the cache immediately, then invalidate.
 *
 * The immediate write is what keeps a dialog from flashing its pre-save state:
 * the desktop's `projects.changed` push arrives moments after the reply and
 * triggers a re-list, but between the two the cache would still hold the old
 * row. Both land the same value — the desktop's — so the order cannot matter.
 */
function absorb(incoming: SyncProject): SyncProject {
  const project = normalize(incoming)
  queryClient.setQueryData<SyncProject[]>(projectKeys.list, (current) => {
    const rows = current ?? []
    const index = rows.findIndex((row) => row.id === project.id)
    const next = index >= 0 ? rows.with(index, project) : [project, ...rows]
    // Newest-edited first, exactly as the desktop lists them.
    return [...next].sort((a, b) => b.updatedAt - a.updatedAt)
  })
  return project
}

export async function createProject(input: {
  title: string
  icon?: string
  instructions?: string
}): Promise<SyncProject> {
  const answer = await call<{ project: SyncProject }>(Rpc.projectCreate, input)
  return absorb(answer.project)
}

export async function updateProject(input: {
  id: string
  title?: string
  icon?: string
  instructions?: string
  /**
   * The project's own reasoning effort. Sent only when the user picked one on
   * the card; omitted leaves the desktop's stamp alone.
   */
  thinking?: ReasoningMode
  files?: Array<{ path: string; name: string }>
  /**
   * Whole-list replace. References only, so nothing is deleted — but a path
   * that is not a folder on the DESKTOP is REFUSED: the call rejects with the
   * reason, which is the dialog's validation.
   */
  directories?: string[]
}): Promise<SyncProject> {
  const answer = await call<{ project: SyncProject }>(Rpc.projectUpdate, input)
  return absorb(answer.project)
}

export async function deleteProject(id: string): Promise<void> {
  await call<{ ok: boolean }>(Rpc.projectDelete, { id })
  queryClient.setQueryData<SyncProject[]>(projectKeys.list, (current) =>
    (current ?? []).filter((row) => row.id !== id)
  )
}

/**
 * Upload one file into a project, chunk by chunk — the phone's Add-files.
 *
 * The desktop owns the workspace, so it owns the name: the bytes land in
 * `uploads/project-<id>/` under a name IT picks (collisions rename
 * Finder-style), which is exactly what happens when a file is added from the
 * desktop's own dialog. The staged bytes are then moved to that path locally,
 * so the file the user just sent opens from the cache instead of being
 * downloaded straight back.
 *
 * `onProgress` reports bytes sent, which is what lets the dialog draw the same
 * real bar the desktop's copy-progress card draws rather than a spinner.
 */
export async function uploadProjectFile(
  projectId: string,
  localUri: string,
  name: string,
  mimeType: string | null,
  onProgress?: (sentBytes: number, totalBytes: number) => void
): Promise<SyncProject> {
  const source = new File(localUri)
  if (!source.exists) throw new Error(`no file at ${localUri}`)
  const sizeBytes = source.size ?? 0
  if (sizeBytes <= 0) throw new Error(`empty file at ${localUri}`)

  const begin = await call<{ uploadId: string }>(Rpc.uploadBegin, {
    name,
    mimeType,
    sizeBytes,
    projectId
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

  const answer = await call<{ project: SyncProject; filePath?: string }>(Rpc.uploadCommit, {
    uploadId: begin.uploadId
  })
  if (answer.filePath) {
    // A cache hit rather than an immediate re-download of what was just sent.
    // Best-effort: a failure here costs one download later, never the upload.
    await importLocalFile(localUri, answer.filePath).catch(() => null)
  }
  return absorb(answer.project)
}
