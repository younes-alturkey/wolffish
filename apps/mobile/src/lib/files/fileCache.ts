import { getDb } from '@/lib/db/database'
import { fetchDesktopFileInto } from '@/lib/sync/files'
import { useAppStore } from '@/state/appStore'
import { Directory, File, Paths } from 'expo-file-system'

/**
 * Workspace file cache. Media referenced by conversations keeps the desktop's
 * workspace-relative paths ("uploads/conv-…/photo.png", "files/report.pdf").
 * Files are materialized on demand into Documents/workspace and tracked in
 * the cached_files table; when the cache grows past the budget the least
 * recently used CONVERSATIONS give up their media first — oldest out, recent
 * ones untouched (see lru.ts). A deleted file is simply re-fetched the next
 * time its conversation is opened.
 *
 * The fetch source follows the app's mode. Paired, a path's real bytes come
 * from the desktop's workspace over the tunnel — and only from there: falling
 * back to a CDN sample would cache demo bytes under a real path, which is
 * exactly the lie this branch exists to prevent. Unpaired (demo mode), each
 * path is served the published sample for its file type (see sampleFiles.ts)
 * — nothing is bundled or pushed, and that behavior is unchanged.
 */

import { beginDownload, endDownload, reportDownload } from '@/lib/files/downloadProgress'
import { selectPrunable, type CachedFileRow } from '@/lib/files/lru'
import { sampleUrlFor } from '@/lib/files/sampleFiles'

/** Default budget — release content beyond 50 GB, per product requirement. */
export const DEFAULT_CACHE_BUDGET_BYTES = 50 * 1024 * 1024 * 1024

export type { CachedFileRow }

/** Scratch space for in-progress downloads, outside the tracked cache. */
const DOWNLOAD_DIR = 'downloads'

/**
 * Where a file being sent waits for its real name.
 *
 * An attachment's workspace path is the DESKTOP's to choose — it resolves
 * collisions Finder-style and only answers once the last byte has landed. But
 * the message carrying it is on screen from the tap, so its files need a path
 * to render from before that answer exists. They get one here: still inside
 * the workspace (so every viewer, cache probe and share sheet works unchanged),
 * dot-prefixed so it can never collide with a real `uploads/conv-…` folder, and
 * one directory per file so two pictures with the same name both survive.
 *
 * Deliberately outside the LRU: a staged file must not be prunable between the
 * tap and the commit. Anything left here after a crash is swept at launch.
 */
const STAGING_ROOT = 'uploads/.staging'

function workspaceRoot(): Directory {
  return new Directory(Paths.document, 'workspace')
}

function fileAt(root: Directory, relPath: string): File {
  return new File(root, relPath)
}

function ensureParent(root: Directory, relPath: string): void {
  const parts = relPath.split('/').slice(0, -1)
  if (parts.length === 0) return
  new Directory(root, ...parts).create({ intermediates: true, idempotent: true })
}

async function touch(relPath: string): Promise<void> {
  const db = await getDb()
  await db.runAsync(
    'UPDATE cached_files SET last_access_at = ? WHERE rel_path = ?',
    Date.now(),
    relPath
  )
}

async function record(relPath: string, sizeBytes: number, conversationId?: string): Promise<void> {
  const db = await getDb()
  await db.runAsync(
    `INSERT OR REPLACE INTO cached_files (rel_path, size_bytes, last_access_at, conversation_id)
     VALUES (?, ?, ?, ?)`,
    relPath,
    sizeBytes,
    Date.now(),
    conversationId ?? null
  )
}

/** A filesystem-safe scratch name; the tail keeps the extension intact. */
function scratchFile(relPath: string): File {
  const name = relPath.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-100)
  return new File(new Directory(Paths.cache, DOWNLOAD_DIR), name)
}

/**
 * Write text content directly into the workspace at `relPath` — the demo
 * importer's path for files whose bytes ship inside the bundle (per-path
 * chart specs) instead of resolving to the per-type CDN sample. Deliberately
 * not recorded in cached_files: the LRU must never prune one (the re-fetch
 * would silently swap it for the generic sample), and purgeDemoState deletes
 * the whole workspace directory, so nothing can leak. Returns false on a
 * traversal-shaped path or a failed write.
 */
export function seedWorkspaceFile(relPath: string, content: string): boolean {
  // The bundle is our own content, but a malformed path must not escape the
  // workspace directory.
  const segments = relPath.split('/')
  if (segments.some((part) => part === '' || part === '.' || part === '..')) return false
  try {
    ensureParent(workspaceRoot(), relPath)
    const target = fileAt(workspaceRoot(), relPath)
    if (target.exists) target.delete()
    target.write(content)
    return true
  } catch {
    return false
  }
}

/**
 * What a resolution amounts to. `missing` is AUTHORITATIVE absence — the
 * source of truth answered and said the path does not exist (the desktop's
 * fileStat, or a demo file type with no published sample). A transient
 * failure — the tunnel busy, a timeout, a flap mid-transfer, a full disk —
 * is `{ uri: null, missing: false }`: the file may be fine at the source,
 * and the caller should try again rather than tell the user it was deleted.
 */
export type ResolvedWorkspaceFile = { uri: string | null; missing: boolean }

const TRANSIENT: ResolvedWorkspaceFile = { uri: null, missing: false }
const ABSENT_AT_SOURCE: ResolvedWorkspaceFile = { uri: null, missing: true }

/** In-flight downloads, keyed by workspace-relative path. */
const inFlight = new Map<string, Promise<ResolvedWorkspaceFile>>()

/**
 * Download a path's bytes into the cache. The download lands in scratch space
 * first and is moved into place only once complete: on Android a failed
 * download leaves a partial file behind, and a truncated file sitting at the
 * real path would read as a valid cache hit forever after.
 *
 * Both branches report bytes as they land (see downloadProgress) — this is the
 * single choke point every workspace download passes through, so wrapping it
 * here is what gives every file card in the feed a real progress bar.
 */
async function fetchIntoCache(
  relPath: string,
  conversationId?: string
): Promise<ResolvedWorkspaceFile> {
  beginDownload(relPath)
  try {
    new Directory(Paths.cache, DOWNLOAD_DIR).create({ intermediates: true, idempotent: true })
    const scratch = scratchFile(relPath)

    if (useAppStore.getState().paired) {
      // Paired: the desktop is the only honest source for this path.
      const received = (bytes: number, total: number): void => reportDownload(relPath, bytes, total)
      const outcome = await fetchDesktopFileInto(relPath, scratch, received)
      if (outcome === 'absent') return ABSENT_AT_SOURCE
      if (outcome === 'failed') throw new Error('desktop fetch failed')
    } else {
      // Demo: the published sample for this path's file type. No sample for
      // the type is this mode's authoritative absence.
      const url = sampleUrlFor(relPath)
      if (!url) return ABSENT_AT_SOURCE
      await File.downloadFileAsync(url, scratch, {
        idempotent: true,
        // totalBytes is -1 when the server sent no Content-Length; the store
        // reads that as "no total" and the bar falls back to its blind curve.
        onProgress: ({ bytesWritten, totalBytes }) =>
          reportDownload(relPath, bytesWritten, totalBytes)
      })
    }

    const target = fileAt(workspaceRoot(), relPath)
    ensureParent(workspaceRoot(), relPath)
    await scratch.move(target, { overwrite: true })
    await record(relPath, target.size ?? 0, conversationId)
    void enforceCacheBudget()
    return { uri: target.uri, missing: false }
  } catch {
    // Offline, a timed-out transfer, a full disk — transient by definition:
    // the viewer keeps its loading card and retries, and only a source that
    // ANSWERS "not here" may ever render as deleted.
    //
    // Paired, the partial in scratch is deliberately KEPT: the desktop fetch
    // resumes from it on the next attempt (see fetchDesktopFileInto), which
    // is what lets a big file finish over a link too slow to land it in one
    // go. The demo CDN download cannot resume, so its leftover is deleted —
    // a fresh handle, because move() repoints the one it was given at the
    // destination.
    if (!useAppStore.getState().paired) {
      try {
        const leftover = scratchFile(relPath)
        if (leftover.exists) leftover.delete()
      } catch {
        // Nothing to clean up.
      }
    }
    return TRANSIENT
  } finally {
    endDownload(relPath)
  }
}

/**
 * Synchronous cache probe: the local URI and size when a path's bytes are
 * ALREADY on disk, null otherwise. Never fetches.
 *
 * This is what lets a viewer render at its final size on its first frame.
 * The async resolve below always costs a state transition — placeholder,
 * then card — and a card that changes height one frame after it mounts moves
 * everything under it and drags the feed's scroll position with it. A file the
 * phone already holds (every re-open of a conversation, every chart spec the
 * demo importer seeded) has nothing to wait for, so it should never enter that
 * loading state at all. `exists`/`size` are synchronous on expo-file-system's
 * File, so the probe is a stat, cheap enough to run during render.
 */
export function statCachedFile(relPath: string): { uri: string; sizeBytes: number } | null {
  try {
    const cached = fileAt(workspaceRoot(), relPath)
    if (!cached.exists) return null
    void touch(relPath)
    return { uri: cached.uri, sizeBytes: cached.size ?? 0 }
  } catch {
    // A malformed path, a permissions failure — the async path treats those as
    // "not cached" too, and will produce the per-type missing state.
    return null
  }
}

/**
 * Resolve a workspace-relative path to a local file URI, fetching it into the
 * cache if needed. `missing: true` in the answer means the SOURCE said the
 * file does not exist — the only case a renderer may show its per-type
 * deleted state; a null uri without it is a transient failure the caller
 * retries (see useWorkspaceFile).
 */
export async function resolveWorkspaceFile(
  relPath: string,
  conversationId?: string
): Promise<ResolvedWorkspaceFile> {
  try {
    const cached = fileAt(workspaceRoot(), relPath)
    if (cached.exists) {
      void touch(relPath)
      return { uri: cached.uri, missing: false }
    }

    // A card and its expanded sheet mount together and ask for the same path;
    // one download serves both. A FAILURE is shared the same way — and that
    // is fine now, because a shared failure retries instead of being written
    // on every joined card as "deleted".
    const running = inFlight.get(relPath)
    if (running) return await running

    const fetching = fetchIntoCache(relPath, conversationId).finally(() => {
      inFlight.delete(relPath)
    })
    inFlight.set(relPath, fetching)
    return await fetching
  } catch {
    return TRANSIENT
  }
}

/** Store a locally created file (e.g. a voice recording) into the cache. */
export async function importLocalFile(
  sourceUri: string,
  relPath: string,
  conversationId?: string
): Promise<string | null> {
  try {
    const source = new File(sourceUri)
    if (!source.exists) return null
    ensureParent(workspaceRoot(), relPath)
    const target = fileAt(workspaceRoot(), relPath)
    if (target.exists) target.delete()
    await source.move(target)
    await record(relPath, target.size ?? 0, conversationId)
    return target.uri
  } catch {
    return null
  }
}

export type StagedFile = { relPath: string; uri: string; sizeBytes: number }

/**
 * Move a picked file into the workspace under a staging path, so the message
 * about to carry it can render from the cache like any other attachment.
 *
 * A move, not a copy: the picker already handed us a private copy in the app's
 * cache directory, and the upload reads its bytes from wherever they are. One
 * traversal of the file is enough.
 */
export async function stageOutgoingFile(
  sourceUri: string,
  id: string,
  name: string
): Promise<StagedFile | null> {
  // The name is the user's (or a document provider's) and must not be able to
  // climb out of the staging directory.
  const safeName = name.replace(/[/\\]/g, '_').replace(/\0/g, '_').trim() || 'upload.bin'
  const relPath = `${STAGING_ROOT}/${id}/${safeName}`
  try {
    const source = new File(sourceUri)
    if (!source.exists) return null
    ensureParent(workspaceRoot(), relPath)
    const target = fileAt(workspaceRoot(), relPath)
    if (target.exists) target.delete()
    await source.move(target)
    return { relPath, uri: target.uri, sizeBytes: target.size ?? 0 }
  } catch {
    return null
  }
}

/** Whether a path is one of the staging paths above. */
export function isStagedPath(relPath: string): boolean {
  return relPath.startsWith(`${STAGING_ROOT}/`)
}

/** Drop a staged file whose send never happened. Safe to call twice. */
export function discardStagedFile(relPath: string): void {
  if (!isStagedPath(relPath)) return
  try {
    const file = fileAt(workspaceRoot(), relPath)
    if (file.exists) file.delete()
    // The per-file directory goes too, or staging fills with empty folders.
    const holder = file.parentDirectory
    if (holder.exists) holder.delete()
  } catch {
    // Already gone, or never landed — either way there is nothing to clean.
  }
}

/**
 * Clear the staging area. Called once at launch: nothing can legitimately be
 * mid-send at that moment, so whatever is here belongs to a send that died
 * with the process.
 */
export function sweepStagedFiles(): void {
  try {
    const staging = new Directory(workspaceRoot(), ...STAGING_ROOT.split('/'))
    if (staging.exists) staging.delete()
  } catch {
    // A sweep that fails costs disk, not correctness; the next one retries.
  }
}

export { selectPrunable }

export async function enforceCacheBudget(
  budgetBytes: number = DEFAULT_CACHE_BUDGET_BYTES
): Promise<number> {
  const db = await getDb()
  // conversation_id is part of the release decision, not just bookkeeping: it
  // is what groups a conversation's media so the oldest conversation goes
  // first and a recent one is never broken up (see lru.ts).
  const rows = await db.getAllAsync<CachedFileRow>(
    'SELECT rel_path, size_bytes, last_access_at, conversation_id FROM cached_files'
  )
  const doomed = selectPrunable(rows, budgetBytes)
  for (const row of doomed) {
    try {
      const file = fileAt(workspaceRoot(), row.rel_path)
      if (file.exists) file.delete()
    } catch {
      // Deleting a missing file is fine — the row is what matters.
    }
    await db.runAsync('DELETE FROM cached_files WHERE rel_path = ?', row.rel_path)
  }
  return doomed.length
}

export type CacheUsage = { totalBytes: number; fileCount: number }

export async function getCacheUsage(): Promise<CacheUsage> {
  const db = await getDb()
  const row = await db.getFirstAsync<{ total: number | null; n: number }>(
    'SELECT SUM(size_bytes) AS total, COUNT(*) AS n FROM cached_files'
  )
  return { totalBytes: row?.total ?? 0, fileCount: row?.n ?? 0 }
}
