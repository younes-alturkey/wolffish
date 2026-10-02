import { sanitizeFileName } from '@main/uploads/uploads'
import {
  copyFilesInto,
  uniqueFilename,
  type AttachFilesProgress,
  type CopyFilesResult,
  type OwnedFileRef
} from '@main/uploads/owned-copies'
import { workspaceRoot } from '@main/workspace/root'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Files and working directories attached to an AUTOMATION — the same concept
 * projects have, on the store automations actually use.
 *
 * There is no per-automation record anywhere: heartbeat.md IS the store, so
 * both lists ride the job block as leading marker lines (`file: <path>`,
 * `dir: <path>`, repeatable) exactly like `mode:`/`project:`/`icon:`. This
 * module owns the DISK half of that contract — copying attached files into the
 * workspace so an automation can never dangle on a moved original, and sweeping
 * copies whose marker is gone.
 *
 * WHY THE COPIES ARE NOT KEYED BY THE AUTOMATION'S NAME: an automation's
 * identity is its heading, and the heading IS the schedule — changing
 * "Daily (08:00)" to "Daily (09:00)" renames it. A `uploads/automation-<label>/`
 * dir would be orphaned by the single most common edit there is. So the dir is
 * `uploads/automation-<uuid>/`, minted at the FIRST attach and thereafter
 * carried by the marker paths themselves: the automation's own dir is simply
 * the parent of any copy it already owns. Renames, toggles and mode changes
 * never touch it.
 *
 * Working directories are NOT copied — they are references to real folders the
 * automation works in, and they ride the run through the same
 * `workingFolders` channel the in-app composer's folder picker uses.
 */

/** One attached file: an absolute path inside the workspace, plus its name. */
export type AutomationFileRef = OwnedFileRef

const DIR_PREFIX = 'automation-'

function uploadsRoot(): string {
  return path.join(workspaceRoot(), 'uploads')
}

/**
 * True when the path is a copy THIS module made — i.e. it sits directly inside
 * an `uploads/automation-*` dir. Only those are ever deleted; a marker pointing
 * anywhere else (hand-written by the user, or at a shared original) is a
 * reference we never own and never remove.
 */
export function isOwnedAutomationFile(filePath: string): boolean {
  const dir = path.dirname(path.resolve(filePath))
  return path.dirname(dir) === uploadsRoot() && path.basename(dir).startsWith(DIR_PREFIX)
}

/**
 * The dir this automation's copies live in: the one it already owns, else a
 * fresh `automation-<uuid>`. Deriving it from the existing paths is what keeps
 * ownership stable across heading renames — see the module comment.
 */
function dirForAutomation(existingPaths: readonly string[]): string {
  for (const p of existingPaths) {
    if (isOwnedAutomationFile(p)) return path.dirname(path.resolve(p))
  }
  return path.join(uploadsRoot(), `${DIR_PREFIX}${randomUUID()}`)
}

export type AttachAutomationFilesResult = CopyFilesResult

/**
 * Copy sources into this automation's `uploads/automation-<uuid>/` and hand
 * back the refs to write as `file:` markers. The caller owns the markdown half
 * of the transaction: the copies exist first, the markers land right after, and
 * a copy whose marker never arrived is swept by pruneAutomationUploads once it
 * is past the grace window.
 */
export function attachFilesToAutomation(
  existingPaths: readonly string[],
  sourcePaths: readonly string[],
  onProgress?: (progress: AttachFilesProgress) => void
): Promise<AttachAutomationFilesResult> {
  return copyFilesInto(
    dirForAutomation(existingPaths),
    sourcePaths,
    new Set(existingPaths.map((p) => path.basename(p))),
    onProgress
  )
}

/**
 * Adopt an already-staged file as an automation file — the phone's Add-files,
 * whose bytes arrive over the tunnel instead of from a path on this machine.
 *
 * Same destination, naming and ownership as attachFilesToAutomation: the file
 * lands in the dir this automation already owns (or a fresh one), under a name
 * THIS side picks. Only the first step differs — a rename of the staged bytes
 * rather than a copy of a source that stays put. The caller writes the `file:`
 * marker; until it does, the copy is protected by the prune grace window.
 */
export async function adoptUploadedAutomationFile(
  existingPaths: readonly string[],
  stagedPath: string,
  originalName: string
): Promise<AutomationFileRef> {
  const staged = await fs.stat(stagedPath)
  if (!staged.isFile() || staged.size === 0) {
    throw new Error('adoptUploadedAutomationFile: staged upload is empty')
  }
  const dir = dirForAutomation(existingPaths)
  await fs.mkdir(dir, { recursive: true })
  const finalName = await uniqueFilename(dir, sanitizeFileName(originalName))
  const dest = path.join(dir, finalName)
  await fs.rename(stagedPath, dest)
  return { path: dest, name: finalName }
}

/**
 * Delete one attached file's copy. Detach means gone — but only for copies we
 * own; a marker pointing at a file elsewhere on disk is just dropped from the
 * block and the original is left alone.
 */
export async function removeAutomationFile(filePath: string): Promise<void> {
  if (!isOwnedAutomationFile(filePath)) return
  await fs.rm(path.resolve(filePath), { force: true }).catch(() => undefined)
}

/**
 * How long a copy is protected from the sweep below. Long enough that the gap
 * between "bytes copied" and "marker written" (a picker close, then the
 * editor's 600ms autosave) can never be mistaken for an orphan, short enough
 * that a genuine orphan does not outlive the session.
 */
const PRUNE_GRACE_MS = 5 * 60 * 1000

/**
 * Delete copies under `uploads/automation-*` that no automation references any
 * more, and any dir left empty by that.
 *
 * heartbeat.md is the store, and it has FOUR writers (this app's editor, the
 * phone, the agent's automation_* tools, a hand edit in any text editor) — only
 * one of which could plausibly delete a file as it removes a marker. Rather
 * than teach each writer to clean up, ownership is reconciled from the file:
 * whatever heartbeat.md no longer names, we no longer keep. Called on every
 * scheduler reload, so it runs after every writer, whoever they were.
 *
 * The grace window is what makes that safe: a copy is only ever deleted once it
 * is old enough that a marker write for it would already have landed.
 */
export async function pruneAutomationUploads(
  referenced: Iterable<string>,
  nowMs: number = Date.now()
): Promise<number> {
  const keep = new Set<string>()
  for (const p of referenced) keep.add(path.resolve(p))

  const root = uploadsRoot()
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  let removed = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(DIR_PREFIX)) continue
    const dir = path.join(root, entry.name)
    const files = await fs.readdir(dir, { withFileTypes: true }).catch(() => null)
    if (!files) continue
    let left = 0
    for (const file of files) {
      const full = path.join(dir, file.name)
      if (!file.isFile() || keep.has(full)) {
        left += 1
        continue
      }
      const stat = await fs.stat(full).catch(() => null)
      // A copy younger than the grace window may simply be waiting for its
      // marker write — never touch it.
      if (stat && nowMs - stat.mtimeMs < PRUNE_GRACE_MS) {
        left += 1
        continue
      }
      await fs.rm(full, { force: true }).catch(() => undefined)
      removed += 1
    }
    // rmdir only succeeds on an empty dir, which is exactly the guard we want.
    if (left === 0) await fs.rmdir(dir).catch(() => undefined)
  }
  return removed
}
