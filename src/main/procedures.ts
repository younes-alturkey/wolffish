import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { diskWriter } from '@main/io/diskWriter'
import { sanitizeFileName } from '@main/uploads/uploads'
import {
  buildAttachedFilesOverlay,
  copyFilesInto,
  uniqueFilename,
  type AttachFilesProgress,
  type CopyFilesResult,
  type OwnedFileRef
} from '@main/uploads/owned-copies'
import { currentThinkingModeSetting, readConfig, workspaceRoot } from '@main/workspace/workspace'
import type { ReasoningMode } from '@main/runtime/reasoning'

/**
 * Procedures — saved prompts the user runs on demand from the Procedures page.
 * Inert data (no scheduler, unlike heartbeat): a flat list persisted as a single
 * JSON file under the workspace, read/modified/written through the shared
 * diskWriter so the file is never torn on a concurrent read or a crash.
 */
export type Procedure = {
  id: string
  title: string
  prompt: string
  /**
   * The procedure's own chat mode — stamped with the global mode at creation,
   * user-overridable per procedure. Runs use it over the global setting.
   * Optional: rows saved before the field shipped follow the global mode.
   */
  mode?: 'single' | 'workflow'
  /**
   * The procedure's own reasoning effort — stamped with the chat's selected
   * thinking mode at creation, user-overridable per procedure. Runs use it
   * over the chat setting. Optional: rows saved before the field shipped
   * follow the chat live (exactly the `mode` contract above).
   */
  thinking?: ReasoningMode
  /** Emoji shown on the card; absent (legacy rows) ⇒ the page's default. */
  icon?: string
  /** Project binding — runs get the project overlay and register under it. */
  projectId?: string
  /**
   * Files attached to this procedure. Attaching COPIES the source into
   * `uploads/procedure-<id>/` (uniform with conversation and project uploads),
   * so a procedure can never dangle on a moved or deleted original. Every run
   * is told their name, size and path and reads them with its own tools —
   * content is never injected. Absent on rows saved before the field shipped.
   */
  files?: ProcedureFileRef[]
  /**
   * Working directories this procedure operates in. References, never copies:
   * each run gets a fresh shallow listing of every one, through the same
   * channel the chat composer's folder picker uses.
   */
  directories?: string[]
  createdAt: number
  updatedAt: number
}

/** One attached procedure file (dual decl — see src/preload/index.ts). */
export type ProcedureFileRef = OwnedFileRef

function proceduresFile(): string {
  return path.join(workspaceRoot(), 'brain', 'procedures.json')
}

async function loadProcedures(): Promise<Procedure[]> {
  try {
    const raw = await fs.readFile(proceduresFile(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Procedure[]) : []
  } catch {
    // Missing file / bad JSON — start from an empty list rather than throwing.
    return []
  }
}

async function saveProcedures(procedures: Procedure[]): Promise<void> {
  await diskWriter.writeFileAtomic(proceduresFile(), JSON.stringify(procedures, null, 2))
  // Fires on EVERY committed write, renderer- and agent-originated alike, so
  // an open Procedures page re-fetches when the agent's procedure_* tools
  // mutate the store mid-conversation (or from an autonomous run).
  changedListener?.()
}

let changedListener: (() => void) | null = null
export function setProceduresChangedListener(listener: (() => void) | null): void {
  changedListener = listener
}

// Serialize every read-modify-write so two mutations that race (e.g. a debounced
// auto-save landing next to a delete) can't both fork off the same base list and
// clobber each other. Reads chain here too, so a list() always reflects the
// latest committed write.
let mutationTail: Promise<unknown> = Promise.resolve()
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = mutationTail.then(op, op)
  mutationTail = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export function listProcedures(): Promise<Procedure[]> {
  return serialize(async () => {
    const procedures = await loadProcedures()
    // Most-recently-edited first, so the freshest procedure sits at the top.
    return procedures.slice().sort((a, b) => b.updatedAt - a.updatedAt)
  })
}

export function createProcedure(payload: {
  title: string
  prompt: string
  mode?: 'single' | 'workflow'
  thinking?: ReasoningMode
  icon?: string
  projectId?: string
}): Promise<Procedure> {
  return serialize(async () => {
    const procedures = await loadProcedures()
    const now = Date.now()
    // Default the procedure's mode to whatever the user is running RIGHT NOW —
    // one funnel covers the UI's blank-stub create and the agent's
    // procedure_create alike.
    const globalMode = (await readConfig().catch(() => null))?.llm.mode ?? 'single'
    // The thinking stamp is the same contract: the chat's selected mode at
    // creation, absent only when chat itself has nothing selected (the row
    // then follows chat live, like legacy rows).
    const thinking = payload.thinking ?? (await currentThinkingModeSetting())
    const procedure: Procedure = {
      id: randomUUID(),
      title: payload.title,
      prompt: payload.prompt,
      mode: payload.mode ?? (globalMode === 'workflow' ? 'workflow' : 'single'),
      ...(thinking ? { thinking } : {}),
      // Every procedure carries an emoji from birth (cards + the rail badge);
      // the picker can change it but never remove it.
      icon: payload.icon || '📋',
      ...(payload.projectId ? { projectId: payload.projectId } : {}),
      createdAt: now,
      updatedAt: now
    }
    procedures.push(procedure)
    await saveProcedures(procedures)
    return procedure
  })
}

export function updateProcedure(payload: {
  id: string
  title?: string
  prompt?: string
  mode?: 'single' | 'workflow'
  thinking?: ReasoningMode
  icon?: string
  projectId?: string
  /** Whole-list replace — detached copies WE own are deleted from disk. */
  files?: ProcedureFileRef[]
  /** Whole-list replace. References only, so nothing is deleted. */
  directories?: string[]
}): Promise<Procedure> {
  return serialize(async () => {
    const procedures = await loadProcedures()
    const procedure = procedures.find((p) => p.id === payload.id)
    if (!procedure) throw new Error(`procedure not found: ${payload.id}`)
    if (payload.title !== undefined) procedure.title = payload.title
    if (payload.prompt !== undefined) procedure.prompt = payload.prompt
    if (payload.mode !== undefined) procedure.mode = payload.mode
    if (payload.thinking !== undefined) procedure.thinking = payload.thinking
    if (payload.icon !== undefined) procedure.icon = payload.icon
    // '' unbinds — the field disappears from the JSON rather than storing ''.
    if (payload.projectId !== undefined) procedure.projectId = payload.projectId || undefined
    if (payload.files !== undefined) {
      // Detached files whose copies WE own (inside the procedure's upload dir)
      // are deleted from disk — detach means gone, nothing orphans. A ref
      // pointing anywhere else is a reference we never owned; leave it be.
      const dir = procedureUploadsDir(procedure.id)
      const keep = new Set(payload.files.map((f) => f.path))
      for (const old of procedure.files ?? []) {
        if (keep.has(old.path)) continue
        if (!old.path.startsWith(dir + path.sep)) continue
        await fs.rm(old.path, { force: true }).catch(() => undefined)
      }
      procedure.files = payload.files
    }
    if (payload.directories !== undefined) procedure.directories = payload.directories
    procedure.updatedAt = Date.now()
    await saveProcedures(procedures)
    return procedure
  })
}

export function deleteProcedure(id: string): Promise<void> {
  return serialize(async () => {
    const procedures = await loadProcedures()
    await saveProcedures(procedures.filter((p) => p.id !== id))
    // We own the copies — the procedure's upload dir goes with it.
    await fs.rm(procedureUploadsDir(id), { recursive: true, force: true }).catch(() => undefined)
  })
}

/** Mirrors uploads.ts conversationDirName for the shared uploads/ tree. */
export function procedureDirName(id: string): string {
  return `procedure-${id.replace(/[^A-Za-z0-9._-]/g, '_')}`
}

function procedureUploadsDir(id: string): string {
  return path.join(workspaceRoot(), 'uploads', procedureDirName(id))
}

export type AttachProcedureFilesResult = CopyFilesResult & { procedure: Procedure }

/**
 * Copy sources into `uploads/procedure-<id>/` and attach them — the single
 * chokepoint for the app's file picker and the agent alike, mirroring
 * attachFilesToProject exactly. Serialized on the same mutation tail as every
 * other write here, so a commit landing next to a debounced prompt save cannot
 * fork the base list.
 */
export function attachFilesToProcedure(
  id: string,
  sourcePaths: readonly string[],
  onProgress?: (progress: AttachFilesProgress) => void
): Promise<AttachProcedureFilesResult> {
  return serialize(async () => {
    const procedures = await loadProcedures()
    const procedure = procedures.find((p) => p.id === id)
    if (!procedure) throw new Error(`procedure not found: ${id}`)

    const existing = procedure.files ?? []
    const result = await copyFilesInto(
      procedureUploadsDir(id),
      sourcePaths,
      new Set(existing.map((f) => f.name)),
      onProgress
    )
    if (result.added.length > 0) {
      procedure.files = [...existing, ...result.added]
      procedure.updatedAt = Date.now()
      await saveProcedures(procedures)
    }
    return { ...result, procedure }
  })
}

/**
 * Adopt an already-staged file as a procedure file — the phone's Add-files,
 * whose bytes arrive over the tunnel instead of from a path on this machine.
 * The same destination, naming and ownership as attachFilesToProcedure; only
 * the first step differs (a rename of the staged bytes rather than a copy of a
 * source that stays put). Mirrors adoptUploadedProjectFile.
 */
export function adoptUploadedProcedureFile(
  id: string,
  stagedPath: string,
  originalName: string
): Promise<{ procedure: Procedure; file: ProcedureFileRef }> {
  return serialize(async () => {
    const staged = await fs.stat(stagedPath)
    if (!staged.isFile() || staged.size === 0) {
      throw new Error('adoptUploadedProcedureFile: staged upload is empty')
    }
    const procedures = await loadProcedures()
    const procedure = procedures.find((p) => p.id === id)
    if (!procedure) throw new Error(`procedure not found: ${id}`)

    const dir = procedureUploadsDir(id)
    await fs.mkdir(dir, { recursive: true })
    const finalName = await uniqueFilename(dir, sanitizeFileName(originalName))
    const dest = path.join(dir, finalName)
    await fs.rename(stagedPath, dest)

    const file: ProcedureFileRef = { path: dest, name: finalName }
    procedure.files = [...(procedure.files ?? []), file]
    procedure.updatedAt = Date.now()
    await saveProcedures(procedures)
    return { procedure, file }
  })
}

/**
 * The attached-files block a procedure run's system prompt carries. Same
 * model-led contract as the project overlay — the list, never the content.
 */
export function buildProcedureFilesOverlay(files: readonly string[]): Promise<string> {
  return buildAttachedFilesOverlay(files, 'procedure')
}
