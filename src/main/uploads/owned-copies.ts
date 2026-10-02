import { copyFileWithProgress } from '@main/uploads/copy-progress'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Attaching a file to a thing that OUTLIVES a conversation — a project, an
 * automation, a procedure — copies it into the workspace rather than
 * remembering where it was. That is one rule with three callers, and this is
 * the rule: the copy loop, the collision naming, the batch-wide progress
 * shape, and the model-led block the run's system prompt carries.
 *
 * The one thing NOT here is where the copies live. Each owner answers that
 * differently (a project and a procedure key their dir by their stable id; an
 * automation cannot, because its identity is its schedule heading) — see
 * `src/main/automations/files.ts` for why.
 */

/** One attached file: an absolute path inside the workspace, plus its name. */
export type OwnedFileRef = {
  path: string
  name: string
}

/**
 * One tick of an attach batch. `copiedBytes`/`totalBytes` span the WHOLE batch
 * (not the current file), so a dialog draws a single bar that only moves
 * forward instead of N bars that restart per file.
 */
export type AttachFilesProgress = {
  /** 1-based position of the file being copied. */
  index: number
  total: number
  name: string
  copiedBytes: number
  totalBytes: number
}

export type CopyFilesResult = {
  added: OwnedFileRef[]
  /** Sources whose basename is already attached — not copied again. */
  skipped: string[]
  /** Sources that don't exist on disk — never attached. */
  missing: string[]
}

/** Finder-style " (1)" collision suffixing — mirrors uploads.ts uniqueFilename. */
export async function uniqueFilename(dir: string, originalName: string): Promise<string> {
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

export function resolveTilde(input: string): string {
  const home = os.homedir()
  if (input === '~') return home
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(home, input.slice(2))
  return path.resolve(input)
}

/**
 * Copy `sources` into `dir`, skipping names already taken by `knownNames` and
 * reporting batch-wide byte progress. Creates the directory; leaves the store
 * write to the caller, which is what lets each owner keep its own serialized
 * read-modify-write.
 */
export async function copyFilesInto(
  dir: string,
  sources: readonly string[],
  knownNames: ReadonlySet<string>,
  onProgress?: (progress: AttachFilesProgress) => void
): Promise<CopyFilesResult> {
  await fs.mkdir(dir, { recursive: true })
  const taken = new Set(knownNames)
  const added: OwnedFileRef[] = []
  const skipped: string[] = []
  const missing: string[] = []

  // Progress denominator: one cheap stat pass up front (only when someone is
  // listening). Sources that fail to stat contribute nothing here and land in
  // `missing` below, so the two passes agree.
  let totalBytes = 0
  if (onProgress) {
    for (const raw of sources) {
      const st = await fs.stat(resolveTilde(String(raw))).catch(() => null)
      if (st?.isFile()) totalBytes += st.size
    }
  }
  let copiedBytes = 0

  for (const [i, raw] of sources.entries()) {
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
            total: sources.length,
            name: baseName,
            copiedBytes: copiedBytes + fileCopied,
            totalBytes
          })
      : undefined
    if (taken.has(baseName)) {
      skipped.push(source)
      // It counted toward the denominator in the pre-pass — credit it now or
      // the bar can never reach the end.
      copiedBytes += stat.size
      report?.(0)
      continue
    }
    const finalName = await uniqueFilename(dir, baseName)
    const dest = path.join(dir, finalName)
    report?.(0)
    await copyFileWithProgress(source, dest, stat.size, report)
    copiedBytes += stat.size
    taken.add(finalName)
    added.push({ path: dest, name: finalName })
  }

  return { added, skipped, missing }
}

/**
 * The attached-files block appended to the system prompt of a run that has
 * them. 100% model-led, exactly like the project overlay: the model is told
 * what it has and where, and reads with its own tools — content is never
 * injected.
 *
 * Working directories are deliberately NOT here: they ride the run's
 * `workingFolders`, which renders a fresh shallow listing into the volatile
 * tail each iteration (a directory's contents change under the run; a stale
 * listing pinned in the system prompt would lie).
 */
export async function buildAttachedFilesOverlay(
  files: readonly string[],
  owner: 'automation' | 'procedure'
): Promise<string> {
  if (files.length === 0) return ''
  const lines: string[] = []
  lines.push('<attached_files>')
  lines.push(
    `This ${owner} has ${files.length} attached file${files.length === 1 ? '' : 's'}. ` +
      'Content is never auto-loaded — consult them with your tools (pdf_info/pdf_search/pdf_read for PDFs, ' +
      'file_read line ranges, image_view for images, spreadsheet/document tools) before answering anything ' +
      'that depends on them, and attach or send them when the task calls for it:'
  )
  for (const file of files) {
    let fact = 'missing from disk'
    try {
      const stat = await fs.stat(file)
      const mb = stat.size / 1024 / 1024
      fact = mb >= 1 ? `${mb.toFixed(1)}MB` : `${Math.ceil(stat.size / 1024)}KB`
    } catch {
      // keep "missing from disk" — the run should say so, not guess
    }
    lines.push(`- ${path.basename(file)} (${fact}) at ${file}`)
  }
  lines.push(
    'Never guess or claim knowledge of file contents you have not read or searched this run.'
  )
  lines.push('</attached_files>')
  return `\n\n${lines.join('\n')}`
}

/**
 * A working-directory path the user named, resolved and checked. Both the
 * desktop's folder picker and the phone's typed path land here, so "that
 * folder does not exist on this machine" is one answer with one wording.
 */
export async function resolveWorkingDirectory(
  input: string
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const trimmed = String(input ?? '').trim()
  if (!trimmed) return { ok: false, error: 'Give a folder path.' }
  const resolved = resolveTilde(trimmed)
  const stat = await fs.stat(resolved).catch(() => null)
  if (!stat) return { ok: false, error: `No such folder on this machine: ${resolved}` }
  if (!stat.isDirectory()) return { ok: false, error: `That is a file, not a folder: ${resolved}` }
  return { ok: true, path: resolved }
}
