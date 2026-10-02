import type { Segment } from '@preload/index'

/**
 * The folders a conversation has changed files in — derived from the
 * persisted segment stream, never from live turn state, so the chips over the
 * transcript are the same while a turn streams, after it ends, and when the
 * conversation is reopened from history.
 *
 * A file counts as changed when a file-changing tool call (file_edit,
 * file_write, file_patch) completed successfully on it. The path comes from
 * the result's diff when the tool recorded one (already absolute — the plugin
 * resolved it against the working folder), and from the call's own `path`
 * argument otherwise, resolved against the first working folder when relative.
 * Failed and denied calls changed nothing and are skipped.
 *
 * Every changed file is then charged to ONE project folder — the repository
 * root above it, else its manifest's folder, else the working folder or
 * workspace/home container it sits in — so the strip never carries a chain of
 * nested directories and two projects whose trees share a shape never leave
 * two chips that read the same. That resolution needs the filesystem, so main
 * owns it (upload.projectFolders, src/main/uploads/project-folders.ts); this
 * module scans the segments and groups the files by what main answered.
 */

export type TouchedFolder = {
  /** Absolute directory path of the project — what opens when the chip is clicked. */
  path: string
  /** Short display name: the project folder's own name. */
  label: string
  /** Distinct files changed anywhere under this folder; 0 for a folder that is
   *  attached to the conversation but has no changes yet. */
  files: number
}

const FILE_CHANGING_TOOLS: ReadonlySet<string> = new Set(['file_edit', 'file_write', 'file_patch'])

type SegmentMessage = { role: string; segments?: Segment[] }

const SEP_RE = /[\\/]+/

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

function isAbsolute(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:\//.test(p) || p.startsWith('~/')
}

function dirname(p: string): string {
  const idx = p.lastIndexOf('/')
  if (idx <= 0) return idx === 0 ? '/' : ''
  return p.slice(0, idx)
}

function basename(p: string): string {
  const parts = p.split(SEP_RE).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

function joinPath(base: string, rel: string): string {
  const parts = `${normalize(base)}/${rel.replace(/\\/g, '/')}`.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' && out.length > 0) continue
    if (part === '.') continue
    if (part === '..') {
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/') || '/'
}

/** The file each successful file-changing call touched, in stream order. */
export function collectChangedFiles(
  messages: SegmentMessage[],
  workingFolders: string[]
): string[] {
  const files: string[] = []
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.segments) continue
    const results = new Map<string, Extract<Segment, { kind: 'tool_result' }>>()
    for (const seg of message.segments) {
      if (seg.kind === 'tool_result') results.set(seg.toolCallId, seg)
    }
    for (const seg of message.segments) {
      if (seg.kind !== 'tool_call' || !FILE_CHANGING_TOOLS.has(seg.name)) continue
      const result = results.get(seg.toolCallId)
      if (!result || result.status !== 'success') continue
      const fromDiff = result.meta?.diff?.file
      const raw =
        typeof fromDiff === 'string' && fromDiff
          ? fromDiff
          : typeof seg.args.path === 'string'
            ? seg.args.path
            : ''
      if (!raw) continue
      const abs = isAbsolute(raw)
        ? normalize(raw)
        : workingFolders[0]
          ? joinPath(workingFolders[0], raw)
          : ''
      if (abs) files.push(abs)
    }
  }
  return files
}

/** The distinct directories the changed files live in, first-seen order — what
 *  main is asked to resolve to projects. */
export function changedDirectories(files: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const file of files) {
    const dir = dirname(file)
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    out.push(dir)
  }
  return out
}

/**
 * One chip per project: the changed files grouped by the project folder
 * `projectFor` resolves their directory to, in first-seen order, each counting
 * its distinct files. A directory `projectFor` has no answer for yet (main has
 * not replied) contributes nothing rather than a chip that would re-label
 * itself a moment later.
 */
export function groupTouchedFolders(
  files: readonly string[],
  projectFor: (dir: string) => string | undefined
): TouchedFolder[] {
  const byProject = new Map<string, Set<string>>()
  for (const file of files) {
    const dir = dirname(file)
    if (!dir) continue
    const project = projectFor(dir)
    if (!project) continue
    const set = byProject.get(project) ?? new Set<string>()
    set.add(file)
    byProject.set(project, set)
  }
  const out: TouchedFolder[] = []
  for (const [project, set] of byProject) {
    out.push({ path: project, label: basename(project), files: set.size })
  }
  return out
}

/**
 * The strip itself: every attached working folder, in the order it was
 * attached, followed by every project the conversation changed files in that
 * is not already on the strip. One chip per path — an attached repo that was
 * then edited is ONE chip, in its attached position, carrying the count.
 *
 * Each working folder appears as the project it opens (`projectFor` — the
 * repository it sits in, or itself), which is what makes the two halves meet
 * on the same path: attach `wolffish-app/src/renderer`, edit a page under it,
 * and the strip shows `wolffish-app` once. Two spellings of one folder — a
 * trailing slash, a `~` — resolve to the same path and collapse the same way.
 *
 * Attached-and-unchanged chips live only as long as the folder stays attached
 * (they are recomputed from the current list); a changed folder's chip comes
 * from the segments and so outlives its removal.
 */
export function folderChips(
  workingFolders: readonly string[],
  touched: readonly TouchedFolder[],
  projectFor: (dir: string) => string | undefined
): TouchedFolder[] {
  const out: TouchedFolder[] = []
  const at = new Map<string, number>()
  for (const folder of workingFolders) {
    const project = folder ? projectFor(folder) : undefined
    if (!project || at.has(project)) continue
    at.set(project, out.length)
    out.push({ path: project, label: basename(project), files: 0 })
  }
  for (const chip of touched) {
    const index = at.get(chip.path)
    if (index !== undefined) {
      out[index] = { ...out[index], files: chip.files }
      continue
    }
    at.set(chip.path, out.length)
    out.push(chip)
  }
  return out
}
