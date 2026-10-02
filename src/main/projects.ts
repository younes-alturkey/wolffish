import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { diskWriter } from '@main/io/diskWriter'
import { normalizeReasoningMode, type ReasoningMode } from '@main/runtime/reasoning'
import { copyFileWithProgress } from '@main/uploads/copy-progress'
import { sanitizeFileName } from '@main/uploads/uploads'
import { workspaceRoot } from '@main/workspace/root'
import { currentThinkingModeSetting } from '@main/workspace/workspace'

/**
 * Projects — glorified conversations: a maintained set of instructions plus a
 * list of files, from which the user spawns fresh conversations that all share
 * that base. Inert data exactly like procedures (no scheduler): a flat list in
 * one JSON file under the workspace, all mutations serialized through the
 * shared diskWriter. Conversations bind to a project via the `projectId`
 * stamped on their file; the turn pipeline overlays the project context via
 * buildProjectOverlay below.
 */
export type ProjectFileRef = {
  /**
   * Absolute path INSIDE the workspace: attaching copies the source into
   * `uploads/project-<id>/` (uniform with conversation uploads), so a
   * project can never dangle on a moved/deleted original. Legacy refs from
   * before copy-on-attach may still point outside; importOutsideProjectFiles
   * migrates them on launch.
   */
  path: string
  name: string
}

export type Project = {
  id: string
  title: string
  /** Emoji icon (native emoji set — universal across OSes). */
  icon: string
  instructions: string
  files: ProjectFileRef[]
  /**
   * Working directories every turn inside this project operates in.
   * References, never copies: each turn gets a FRESH shallow listing of every
   * one (the same channel the chat composer's folder picker uses), so the
   * model sees the folder as it is now rather than as it was when the project
   * was set up. Absent on rows saved before the field shipped.
   */
  directories?: string[]
  /**
   * The project's own reasoning effort — stamped with the chat's selected
   * thinking mode at creation, user-overridable per project. Conversations
   * inside the project run their turns at it. Optional: projects saved
   * before the field shipped follow the chat live (the `mode` contract on
   * procedures and automations).
   */
  thinking?: ReasoningMode
  createdAt: number
  updatedAt: number
}

function projectsFile(): string {
  return path.join(workspaceRoot(), 'brain', 'projects.json')
}

async function loadProjects(): Promise<Project[]> {
  try {
    const raw = await fs.readFile(projectsFile(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Project[]) : []
  } catch {
    // Missing file / bad JSON — start from an empty list rather than throwing.
    return []
  }
}

async function saveProjects(projects: Project[]): Promise<void> {
  await diskWriter.writeFileAtomic(projectsFile(), JSON.stringify(projects, null, 2))
  // Fires on EVERY committed write, renderer- and agent-originated alike, so
  // an open Projects page re-fetches when the agent's project_* tools mutate
  // the store mid-conversation (or from an autonomous run).
  changedListener?.()
}

let changedListener: (() => void) | null = null
export function setProjectsChangedListener(listener: (() => void) | null): void {
  changedListener = listener
}

// Serialize every read-modify-write (same discipline as procedures.ts) so a
// debounced auto-save racing a delete can't fork the same base list.
let mutationTail: Promise<unknown> = Promise.resolve()
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = mutationTail.then(op, op)
  mutationTail = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export function listProjects(): Promise<Project[]> {
  return serialize(async () => {
    const projects = await loadProjects()
    return projects.slice().sort((a, b) => b.updatedAt - a.updatedAt)
  })
}

export function getProject(id: string): Promise<Project | null> {
  return serialize(async () => {
    const projects = await loadProjects()
    return projects.find((p) => p.id === id) ?? null
  })
}

export function createProject(payload: {
  title: string
  icon?: string
  instructions?: string
  thinking?: ReasoningMode
}): Promise<Project> {
  return serialize(async () => {
    const projects = await loadProjects()
    const now = Date.now()
    // The thinking stamp mirrors the procedures store: the chat's selected
    // mode at creation, absent only when chat itself has nothing selected
    // (the project then follows chat live, like the mode contract).
    const thinking = payload.thinking ?? (await currentThinkingModeSetting())
    const project: Project = {
      id: randomUUID(),
      title: payload.title,
      icon: payload.icon ?? '📁',
      instructions: payload.instructions ?? '',
      files: [],
      ...(thinking ? { thinking } : {}),
      createdAt: now,
      updatedAt: now
    }
    projects.push(project)
    await saveProjects(projects)
    return project
  })
}

export function updateProject(payload: {
  id: string
  title?: string
  icon?: string
  instructions?: string
  thinking?: ReasoningMode
  files?: ProjectFileRef[]
  /** Whole-list replace. References only, so nothing is deleted from disk. */
  directories?: string[]
}): Promise<Project> {
  return serialize(async () => {
    const projects = await loadProjects()
    const project = projects.find((p) => p.id === payload.id)
    if (!project) throw new Error(`project not found: ${payload.id}`)
    if (payload.title !== undefined) project.title = payload.title
    if (payload.icon !== undefined) project.icon = payload.icon
    if (payload.instructions !== undefined) project.instructions = payload.instructions
    if (payload.thinking !== undefined) project.thinking = payload.thinking
    if (payload.files !== undefined) {
      // Detached files whose copies WE own (inside the project's upload dir)
      // are deleted from disk — detach means gone, nothing orphans. Legacy
      // outside-workspace refs are never touched.
      const dir = projectUploadsDir(project.id)
      const keep = new Set(payload.files.map((f) => f.path))
      for (const old of project.files) {
        if (keep.has(old.path)) continue
        if (!old.path.startsWith(dir + path.sep)) continue
        await fs.rm(old.path, { force: true }).catch(() => undefined)
      }
      project.files = payload.files
    }
    if (payload.directories !== undefined) project.directories = payload.directories
    project.updatedAt = Date.now()
    await saveProjects(projects)
    return project
  })
}

export function deleteProject(id: string): Promise<void> {
  return serialize(async () => {
    const projects = await loadProjects()
    await saveProjects(projects.filter((p) => p.id !== id))
    // We own the copies — the project's upload dir goes with it.
    await fs.rm(projectUploadsDir(id), { recursive: true, force: true }).catch(() => undefined)
  })
}

/** Mirrors uploads.ts conversationDirName for the shared uploads/ tree. */
export function projectDirName(id: string): string {
  return `project-${id.replace(/[^A-Za-z0-9._-]/g, '_')}`
}

function projectUploadsDir(id: string): string {
  return path.join(workspaceRoot(), 'uploads', projectDirName(id))
}

/** Finder-style " (1)" collision suffixing — mirrors uploads.ts uniqueFilename. */
async function uniqueFilename(dir: string, originalName: string): Promise<string> {
  const ext = path.extname(originalName)
  const stem = path.basename(originalName, ext)
  let candidate = originalName
  let counter = 0
  while (
    await fs.access(path.join(dir, candidate)).then(
      () => true,
      () => false
    )
  ) {
    counter += 1
    candidate = `${stem} (${counter})${ext}`
    if (counter > 9999) break
  }
  return candidate
}

function resolveTilde(input: string): string {
  const home = os.homedir()
  if (input === '~') return home
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(home, input.slice(2))
  return path.resolve(input)
}

/**
 * One tick of a project file-add. `copiedBytes`/`totalBytes` span the WHOLE
 * batch (not the current file), so the dialog draws a single bar that only
 * moves forward instead of N bars that restart per file.
 */
export type AttachFilesProgress = {
  /** 1-based position of the file being copied. */
  index: number
  total: number
  name: string
  copiedBytes: number
  totalBytes: number
}

export type AttachFilesResult = {
  project: Project
  added: ProjectFileRef[]
  /** Sources whose basename is already attached — not copied again. */
  skipped: string[]
  /** Sources that don't exist on disk — never attached. */
  missing: string[]
}

/**
 * Copy sources into `uploads/project-<id>/` and attach them — the single
 * chokepoint for BOTH the app's file picker and the agent's
 * project_add_files. Uniform with conversation uploads: same tree, same
 * collision naming, real copies so the project owns its files.
 */
export function attachFilesToProject(
  id: string,
  sourcePaths: string[],
  onProgress?: (progress: AttachFilesProgress) => void
): Promise<AttachFilesResult> {
  return serialize(async () => {
    const projects = await loadProjects()
    const project = projects.find((p) => p.id === id)
    if (!project) throw new Error(`project not found: ${id}`)

    const dir = projectUploadsDir(id)
    await fs.mkdir(dir, { recursive: true })
    const knownNames = new Set(project.files.map((f) => f.name))
    const added: ProjectFileRef[] = []
    const skipped: string[] = []
    const missing: string[] = []

    // Progress denominator: one cheap stat pass up front (only when someone
    // is listening). Sources that fail to stat contribute nothing here and
    // land in `missing` below, so the two passes agree.
    let totalBytes = 0
    if (onProgress) {
      for (const raw of sourcePaths) {
        const st = await fs.stat(resolveTilde(String(raw))).catch(() => null)
        if (st?.isFile()) totalBytes += st.size
      }
    }
    let copiedBytes = 0

    for (const [i, raw] of sourcePaths.entries()) {
      const source = resolveTilde(String(raw))
      const stat = await fs.stat(source).catch(() => null)
      if (!stat || !stat.isFile()) {
        missing.push(source)
        continue
      }
      const baseName = path.basename(source)
      const report = onProgress
        ? (fileCopied: number): void =>
            onProgress({
              index: i + 1,
              total: sourcePaths.length,
              name: baseName,
              copiedBytes: copiedBytes + fileCopied,
              totalBytes
            })
        : undefined
      if (knownNames.has(baseName)) {
        skipped.push(source)
        // It counted toward the denominator in the pre-pass — credit it now
        // or the bar can never reach the end.
        copiedBytes += stat.size
        report?.(0)
        continue
      }
      const finalName = await uniqueFilename(dir, baseName)
      const dest = path.join(dir, finalName)
      report?.(0)
      await copyFileWithProgress(source, dest, stat.size, report)
      copiedBytes += stat.size
      knownNames.add(finalName)
      added.push({ path: dest, name: finalName })
    }

    if (added.length > 0) {
      project.files = [...project.files, ...added]
      project.updatedAt = Date.now()
      await saveProjects(projects)
    }
    return { project, added, skipped, missing }
  })
}

/**
 * Adopt an already-staged file as a project file — the phone's Add-files, whose
 * bytes arrive over the tunnel instead of from a path on this machine.
 *
 * The same destination, naming and ownership as attachFilesToProject: the file
 * lands in `uploads/project-<id>/` under a name THIS side picks (collisions
 * rename Finder-style), so detaching later deletes a copy we own. Only the
 * first step differs — a rename of the staged bytes rather than a copy of a
 * source that stays put — which is exactly what saveUploadFromFile does for a
 * conversation upload, and why both go through one sanitizer.
 *
 * Serialized on the same mutation tail as every other write here, so a commit
 * landing next to a debounced instructions save cannot fork the base list.
 */
export function adoptUploadedProjectFile(
  id: string,
  stagedPath: string,
  originalName: string
): Promise<{ project: Project; file: ProjectFileRef }> {
  return serialize(async () => {
    const staged = await fs.stat(stagedPath)
    if (!staged.isFile() || staged.size === 0) {
      throw new Error('adoptUploadedProjectFile: staged upload is empty')
    }
    const projects = await loadProjects()
    const project = projects.find((p) => p.id === id)
    if (!project) throw new Error(`project not found: ${id}`)

    const dir = projectUploadsDir(id)
    await fs.mkdir(dir, { recursive: true })
    const finalName = await uniqueFilename(dir, sanitizeFileName(originalName))
    const dest = path.join(dir, finalName)
    await fs.rename(stagedPath, dest)

    const file: ProjectFileRef = { path: dest, name: finalName }
    project.files = [...project.files, file]
    project.updatedAt = Date.now()
    await saveProjects(projects)
    return { project, file }
  })
}

/**
 * Launch migration (idempotent, called from cleanupWorkspace): pull any
 * legacy outside-workspace project file INTO the project's upload dir so
 * everything lives inside wolffish. Missing sources are left as-is — the
 * overlay and project_view already surface them plainly.
 */
export function importOutsideProjectFiles(): Promise<void> {
  return serialize(async () => {
    const root = workspaceRoot()
    const projects = await loadProjects()
    let changed = false
    for (const project of projects) {
      for (const file of project.files) {
        if (file.path.startsWith(root + path.sep)) continue
        const stat = await fs.stat(file.path).catch(() => null)
        if (!stat || !stat.isFile()) continue
        const dir = projectUploadsDir(project.id)
        await fs.mkdir(dir, { recursive: true })
        const finalName = await uniqueFilename(dir, file.name)
        const dest = path.join(dir, finalName)
        await fs.copyFile(file.path, dest)
        file.path = dest
        file.name = finalName
        project.updatedAt = Date.now()
        changed = true
      }
    }
    if (changed) await saveProjects(projects)
  })
}

/** Channel-facing one-line label: icon + quoted title. */
export function projectLabel(project: Project): string {
  return `${project.icon || '📁'} “${project.title.trim() || 'Untitled'}”`
}

/**
 * The project context block appended to the system prompt of every turn that
 * runs inside the project. 100% model-led file access: instructions are
 * user-authored prompt text (injected verbatim — they ARE context), but file
 * CONTENT is never injected — the model gets the list with per-file facts and
 * reads via its tools, exactly like chat attachments.
 *
 * Turn-stable by construction (one string computed before the loop), so it
 * never perturbs the pinned-prompt cache within a turn; across turns it only
 * changes when the project itself is edited.
 */
export async function buildProjectOverlay(projectId: string | null): Promise<string> {
  if (!projectId) return ''
  const project = await getProject(projectId).catch(() => null)
  if (!project) return ''

  const lines: string[] = []
  lines.push('<project>')
  lines.push(
    `This conversation runs inside the project ${project.icon} "${project.title}". Follow the project instructions below in every reply of this conversation.`
  )
  if (project.instructions.trim()) {
    lines.push('<project_instructions>')
    lines.push(project.instructions.trim())
    lines.push('</project_instructions>')
  }
  if (project.files.length > 0) {
    lines.push(
      `Project files (${project.files.length}) — content is never auto-loaded; consult them with your tools (pdf_info/pdf_search/pdf_read for PDFs, file_read line ranges, image_view for images, spreadsheet/document tools) before answering anything that depends on them:`
    )
    for (const file of project.files) {
      let fact = 'missing from disk'
      try {
        const stat = await fs.stat(file.path)
        const mb = stat.size / 1024 / 1024
        fact = mb >= 1 ? `${mb.toFixed(1)}MB` : `${Math.ceil(stat.size / 1024)}KB`
      } catch {
        // keep "missing from disk" — the model should tell the user, not guess
      }
      lines.push(`- ${file.name} (${fact}) at ${file.path}`)
    }
    lines.push(
      'Never guess or claim knowledge of file contents you have not read or searched this conversation.'
    )
  }
  if ((project.directories?.length ?? 0) > 0) {
    // Named, not listed: the CONTENTS ride the volatile tail (see
    // projectWorkingFolders below and renderWorkingFolders in Agent.ts), which
    // re-reads them every iteration. A listing pinned here would go stale
    // inside a single turn the moment the run wrote a file.
    lines.push(
      `Working folders for this project — assume paths the user mentions are relative to these, and do this project's file work in them:`
    )
    for (const dir of project.directories ?? []) lines.push(`- ${dir}`)
  }
  lines.push('</project>')
  return `\n\n${lines.join('\n')}`
}

/**
 * A project's working directories, for the turn's `workingFolders`.
 *
 * Resolved main-side at turn assembly rather than stamped on the conversation,
 * so every surface gets them for free — in-app chat, a channel turn, an
 * automation or procedure bound to the project — and editing the project moves
 * them for conversations already running inside it.
 */
export async function projectWorkingFolders(projectId: string | null): Promise<string[]> {
  if (!projectId) return []
  const project = await getProject(projectId).catch(() => null)
  return project?.directories ?? []
}

/**
 * A project's own reasoning effort, canonicalized for turn assembly. Null
 * when unset — the turn then follows the chat's thinking mode, exactly as a
 * turn outside a project does. Resolved live per turn (never stamped onto
 * conversations) so editing the project moves the effort for every
 * conversation already running inside it, the working-folders contract.
 */
export async function projectThinking(projectId: string | null): Promise<ReasoningMode | null> {
  if (!projectId) return null
  const project = await getProject(projectId).catch(() => null)
  const raw = project?.thinking
  if (!raw) return null
  // Full canonical scale here; the per-model clamp happens at stream assembly
  // (thalamus) where the model's own modes are known.
  return normalizeReasoningMode(raw, ['off', 'on', 'high', 'max'])
}
