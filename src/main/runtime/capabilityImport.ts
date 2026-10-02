import { diskWriter } from '@main/io/diskWriter'
import yaml from 'js-yaml'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { SkillFrontmatter } from './cerebellum'

/**
 * Import a user-supplied capability into brain/cerebellum/.
 *
 * The Cerebellum settings panel lets the user drop a capability onto the
 * app, the same way the Google Workspace panel takes a creds.json. Three
 * shapes are accepted:
 *
 *  1. A single SKILL.md          — a pure skill (procedure, no plugin).
 *  2. A folder                   — SKILL.md plus optional plugin/, assets,
 *                                  package.json, etc. (a full capability).
 *  3. A .zip                     — the same folder, compressed.
 *
 * Whatever the shape, the flow is identical: stage in a throwaway temp dir,
 * validate hard (but permissively — we accept anything the Cerebellum loader
 * would accept, and reject early anything it would silently choke on), and
 * only then copy the validated tree into the workspace. A failed import never
 * leaves a half-written capability folder behind, because nothing touches
 * brain/cerebellum/ until every check has passed.
 *
 * All validation errors are returned as a human-readable `error` string
 * (never thrown), so the panel can surface exactly what went wrong — the same
 * way the model picker shows install failures.
 */

export type CapabilityImportSource = 'skill' | 'folder' | 'zip'

export type CapabilityImportResult =
  | {
      ok: true
      name: string
      folderName: string
      source: CapabilityImportSource
      hasPlugin: boolean
      toolCount: number
    }
  | { ok: false; error: string }

export type ImportCapabilityOptions = {
  /** Absolute path to the dropped/picked SKILL.md, folder, or .zip. */
  sourcePath: string
  /** Absolute path to <workspace>/brain/cerebellum. */
  cerebellumDir: string
  /** Names of capabilities already loaded (for the uniqueness check). */
  existingNames: Set<string>
}

// Generous caps — a capability is code + a markdown file, not a media bundle.
// These exist to stop a pathological drop (a 4 GB zip, a folder with a
// million files) from hanging the import, not to police legitimate skills.
const MAX_SKILL_MD_BYTES = 1024 * 1024 // 1 MB
const MAX_TOTAL_BYTES = 50 * 1024 * 1024 // 50 MB
const MAX_FILES = 5000
// How deep to look for the SKILL.md inside a dropped folder/zip. A zip of a
// folder nests one level (my-skill/SKILL.md); some tools add an extra wrapper.
const SKILL_SEARCH_DEPTH = 3
// A clean capability folder name: starts alphanumeric, then alphanumerics,
// hyphen, or underscore. No dots (would clash with bundled .git/.browser
// hidden caps), no slashes, no spaces — keeps the on-disk layout predictable
// and forecloses path traversal via a crafted `name`.
const FOLDER_NAME = /^[a-z0-9][a-z0-9_-]*$/

const PLUGIN_ENTRY_FILES = ['index.mjs', 'index.js', 'index.cjs']

/** Junk we never copy into a capability folder. */
function isJunk(base: string): boolean {
  const lower = base.toLowerCase()
  return (
    lower === 'node_modules' || // reinstalled lazily by the cerebellum
    lower === '.git' ||
    lower === '.ds_store' ||
    lower === '__macosx' || // mac zip cruft
    lower === '.wolffish-installed' || // npm-install marker
    // The tested-state marker is earned by a real successful call in THIS
    // install — an imported copy must never arrive pre-claimed as tested.
    lower === '.wolffish-tested'
  )
}

/**
 * A validation failure with a message safe to show the user. Thrown
 * internally, caught at the top of importCapability and turned into
 * `{ ok: false, error }`.
 */
class ImportError extends Error {}

export async function importCapability(
  opts: ImportCapabilityOptions
): Promise<CapabilityImportResult> {
  const { sourcePath, cerebellumDir, existingNames } = opts
  let staging: string | null = null

  try {
    const kind = await detectKind(sourcePath)

    // Resolve the directory that actually contains the SKILL.md (the "skill
    // root"). For a single .md there is no root — we carry the content alone.
    let skillRoot: string | null = null
    let skillContent: string

    if (kind === 'skill') {
      skillContent = await readSkillFile(sourcePath)
    } else {
      staging = await fs.mkdtemp(path.join(os.tmpdir(), 'wolffish-cap-import-'))
      if (kind === 'zip') {
        await extractZip(sourcePath, staging)
      } else {
        // folder: enforce the caps up front, then mirror it into staging so
        // the rest of the pipeline is identical to the zip path.
        await measureTree(sourcePath)
        await copyTree(sourcePath, staging)
      }
      skillRoot = await locateSkillRoot(staging)
      skillContent = await readSkillFile(path.join(skillRoot, 'SKILL.md'))
    }

    // ---- Validate the SKILL.md (frontmatter + body) -----------------------
    const { frontmatter, body } = parseSkillMd(skillContent)
    if (!frontmatter) {
      throw new ImportError(
        'SKILL.md must begin with a YAML frontmatter block delimited by --- on its own lines.'
      )
    }
    const name = validateFrontmatter(frontmatter, body)

    // ---- Validate the plugin (if any) -------------------------------------
    let hasPlugin = false
    if (skillRoot) {
      hasPlugin = await validatePlugin(skillRoot)
    }
    const toolCount = Array.isArray(frontmatter.tools) ? frontmatter.tools.length : 0

    // A plugin's tools can never fire without the plugin code to back them.
    if (toolCount > 0 && !hasPlugin && kind !== 'skill') {
      throw new ImportError(
        `SKILL.md declares ${toolCount} tool(s) but the capability has no plugin/ folder to execute them.`
      )
    }

    // ---- Resolve a safe, unique destination -------------------------------
    const folderName = slugify(name)
    if (!folderName || !FOLDER_NAME.test(folderName)) {
      throw new ImportError(
        `Could not derive a valid folder name from "${name}". Use letters, numbers, hyphens, or underscores.`
      )
    }
    if (existingNames.has(name)) {
      throw new ImportError(
        `A capability named "${name}" already exists. Rename it in the SKILL.md frontmatter, or remove the existing one first.`
      )
    }
    const destDir = path.join(cerebellumDir, folderName)
    if (await pathExists(destDir)) {
      throw new ImportError(
        `A capability folder "${folderName}" already exists. Remove it first, then re-import.`
      )
    }

    // ---- Commit: nothing below here may fail validation -------------------
    await fs.mkdir(cerebellumDir, { recursive: true })
    if (skillRoot) {
      await copyTree(skillRoot, destDir, { excludeSkillMd: true })
    } else {
      await fs.mkdir(destDir, { recursive: true })
    }
    // Always (re)write SKILL.md from the validated content so the on-disk file
    // is named exactly "SKILL.md" (the loader is case-sensitive on Linux) and
    // carries precisely what we validated — no surprises from a stray
    // lowercase skill.md or a second copy in the tree.
    await diskWriter.writeFileAtomic(path.join(destDir, 'SKILL.md'), skillContent)

    return { ok: true, name, folderName, source: kind, hasPlugin, toolCount }
  } catch (err) {
    const message =
      err instanceof ImportError ? err.message : err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  } finally {
    if (staging) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
    }
  }
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

export type CapabilityDeleteOutcome = { ok: true } | { ok: false; error: string }

export type DeleteCapabilityOptions = {
  /** Capability name (for error messages). */
  name: string
  /** Absolute path of the capability folder on disk (the loader's cap.dir). */
  dir: string
  /** Absolute path to <workspace>/brain/cerebellum. */
  cerebellumDir: string
  /** True for bundled capabilities — never deletable. */
  isOfficial: boolean
  /** True for in-process core channels — never deletable. */
  isInProcess: boolean
}

/**
 * Delete a user-imported capability by nuking its folder. Three guards stand
 * between a click and `rm -rf`:
 *
 *   1. Built-in (in-process) capabilities are refused — they have no folder.
 *   2. Official (bundled) capabilities are refused — wiping one would break a
 *      core feature, and it would just reappear on next workspace sync anyway.
 *   3. The folder must be a *direct child* of brain/cerebellum/ — a single
 *      path segment, no "..", no absolute path, no nested separators. This
 *      forecloses removing anything outside the capabilities directory even if
 *      a malformed cap.dir somehow reached us.
 *
 * Only after all three pass do we recursively remove the folder.
 */
export async function deleteCapabilityFolder(
  opts: DeleteCapabilityOptions
): Promise<CapabilityDeleteOutcome> {
  const { name, dir, cerebellumDir, isOfficial, isInProcess } = opts

  if (isInProcess) {
    return { ok: false, error: `"${name}" is a built-in capability and can't be deleted.` }
  }
  if (isOfficial) {
    return { ok: false, error: `"${name}" is an official capability and can't be deleted.` }
  }

  const rel = path.relative(cerebellumDir, dir)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || /[/\\]/.test(rel)) {
    return {
      ok: false,
      error: `Refusing to delete "${name}": it is not a user-imported capability folder.`
    }
  }

  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Kind detection
// ---------------------------------------------------------------------------

async function detectKind(sourcePath: string): Promise<CapabilityImportSource> {
  let stat: import('node:fs').Stats
  try {
    stat = await fs.stat(sourcePath)
  } catch {
    throw new ImportError(
      `Could not read "${sourcePath}". The file may have been moved or deleted.`
    )
  }

  if (stat.isDirectory()) return 'folder'

  if (stat.isFile()) {
    const base = path.basename(sourcePath).toLowerCase()
    if (base.endsWith('.zip')) return 'zip'
    if (base.endsWith('.md')) return 'skill'
    throw new ImportError(
      'Unsupported file. Drop a SKILL.md, a capability folder, or a .zip archive.'
    )
  }

  throw new ImportError(
    'Unsupported item. Drop a SKILL.md, a capability folder, or a .zip archive.'
  )
}

// ---------------------------------------------------------------------------
// SKILL.md parsing + validation
// ---------------------------------------------------------------------------

async function readSkillFile(skillPath: string): Promise<string> {
  let stat: import('node:fs').Stats
  try {
    stat = await fs.stat(skillPath)
  } catch {
    throw new ImportError('No SKILL.md found.')
  }
  if (!stat.isFile()) throw new ImportError('SKILL.md is not a file.')
  if (stat.size === 0) throw new ImportError('SKILL.md is empty.')
  if (stat.size > MAX_SKILL_MD_BYTES) {
    throw new ImportError(
      `SKILL.md is too large (${formatBytes(stat.size)}; limit ${formatBytes(MAX_SKILL_MD_BYTES)}).`
    )
  }
  return fs.readFile(skillPath, 'utf8')
}

/**
 * Split a SKILL.md into its YAML frontmatter and markdown body. Mirrors the
 * cerebellum loader's parser exactly so anything we accept here loads there
 * — including a tolerated leading UTF-8 BOM, which some editors prepend.
 */
export function parseSkillMd(raw: string): {
  frontmatter: SkillFrontmatter | null
  body: string
} {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  if (!text.startsWith('---')) return { frontmatter: null, body: text.trim() }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { frontmatter: null, body: text.trim() }
  const yamlBlock = text.slice(3, end).trim()
  const body = text.slice(end + 4).trim()
  let parsed: unknown
  try {
    parsed = yaml.load(yamlBlock)
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err)
    throw new ImportError(`SKILL.md frontmatter is not valid YAML: ${detail}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { frontmatter: null, body }
  }
  return { frontmatter: parsed as SkillFrontmatter, body }
}

/**
 * Enforce the contract the cerebellum loader assumes. Returns the validated
 * capability name. Permissive: every field except `name` is optional, exactly
 * as the loader treats them — but when a field IS present we check its shape,
 * because a malformed `triggers`/`tools` slips past the loader and only
 * explodes later at match/execute time.
 */
function validateFrontmatter(fm: SkillFrontmatter, body: string): string {
  if (typeof fm.name !== 'string' || fm.name.trim().length === 0) {
    throw new ImportError('SKILL.md frontmatter is missing a "name".')
  }
  const name = fm.name.trim()

  if (fm.description !== undefined && typeof fm.description !== 'string') {
    throw new ImportError('SKILL.md "description" must be a string.')
  }

  if (fm.triggers !== undefined) {
    if (!Array.isArray(fm.triggers) || fm.triggers.some((t) => typeof t !== 'string')) {
      throw new ImportError('SKILL.md "triggers" must be a list of strings.')
    }
  }

  if (fm.requires !== undefined) {
    if (!Array.isArray(fm.requires) || fm.requires.some((r) => typeof r !== 'string')) {
      throw new ImportError('SKILL.md "requires" must be a list of strings.')
    }
  }

  if (fm.tools !== undefined) {
    if (!Array.isArray(fm.tools)) {
      throw new ImportError('SKILL.md "tools" must be a list.')
    }
    fm.tools.forEach((tool, i) => {
      if (!tool || typeof tool !== 'object') {
        throw new ImportError(`SKILL.md tool #${i + 1} is not an object.`)
      }
      if (typeof tool.name !== 'string' || tool.name.trim().length === 0) {
        throw new ImportError(`SKILL.md tool #${i + 1} is missing a "name".`)
      }
    })
  }

  const toolCount = Array.isArray(fm.tools) ? fm.tools.length : 0
  if (body.trim().length === 0 && toolCount === 0) {
    throw new ImportError('SKILL.md has no content — it needs a body, tools, or both.')
  }

  return name
}

/**
 * Confirm a plugin/ folder (if present) has a usable entry file. A capability
 * with no plugin/ is a valid pure skill; a plugin/ with no entry is a broken
 * import we reject up front rather than letting it fail silently at load.
 */
async function validatePlugin(skillRoot: string): Promise<boolean> {
  const pluginDir = path.join(skillRoot, 'plugin')
  let stat: import('node:fs').Stats
  try {
    stat = await fs.stat(pluginDir)
  } catch {
    return false // no plugin/ — pure skill, fine
  }
  if (!stat.isDirectory()) return false

  for (const entry of PLUGIN_ENTRY_FILES) {
    if (await pathExists(path.join(pluginDir, entry))) return true
  }
  throw new ImportError(
    `The plugin/ folder has no entry file (expected one of: ${PLUGIN_ENTRY_FILES.join(', ')}).`
  )
}

// ---------------------------------------------------------------------------
// Folder / zip handling
// ---------------------------------------------------------------------------

/**
 * Find the directory containing the SKILL.md inside a staged folder/zip.
 * Searches the root first, then descends up to SKILL_SEARCH_DEPTH so a zip of
 * a folder (my-skill/SKILL.md) or a doubly-wrapped archive still resolves.
 * Exactly one SKILL.md must exist — zero is "nothing to import", more than one
 * is ambiguous, and both are clearer to reject than to guess at.
 */
async function locateSkillRoot(root: string): Promise<string> {
  const found: string[] = []
  await walkForSkill(root, 0, found)
  if (found.length === 0) {
    throw new ImportError('No SKILL.md found in the dropped item.')
  }
  if (found.length > 1) {
    throw new ImportError(
      `Found ${found.length} SKILL.md files — a capability must contain exactly one.`
    )
  }
  return path.dirname(found[0])
}

async function walkForSkill(dir: string, depth: number, found: string[]): Promise<void> {
  if (depth > SKILL_SEARCH_DEPTH || found.length > 1) return
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    // Match SKILL.md case-insensitively so a stray skill.md from a careless
    // zip still imports; we always rewrite the canonical-cased file on commit.
    if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') {
      found.push(path.join(dir, entry.name))
      continue
    }
    if (entry.isDirectory() && !isJunk(entry.name)) {
      await walkForSkill(path.join(dir, entry.name), depth + 1, found)
    }
  }
}

/**
 * Unzip into destDir with two guards: zip-slip (an entry name that escapes
 * destDir via ../ or an absolute path) and the size/file caps. Both abort the
 * whole import — a malicious or corrupt archive should never write a byte
 * outside the staging dir.
 *
 * JSZip already collapses leading `../` segments when it reads an archive, so
 * the slip check below is defense-in-depth: it catches anything a future JSZip
 * (or a hand-crafted central directory) might let through, rather than being
 * the sole line of defense.
 */
async function extractZip(zipPath: string, destDir: string): Promise<void> {
  const JSZip = (await import('jszip')).default
  let zip: Awaited<ReturnType<typeof JSZip.loadAsync>>
  try {
    const raw = await fs.readFile(zipPath)
    zip = await JSZip.loadAsync(raw)
  } catch {
    throw new ImportError('Could not open the .zip — it may be corrupt or not a real archive.')
  }

  let totalBytes = 0
  let fileCount = 0

  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (isJunkPath(entryName)) continue

    const dest = path.join(destDir, entryName)
    const rel = path.relative(destDir, dest)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new ImportError(`The .zip contains an unsafe path ("${entryName}") and was rejected.`)
    }
    // An entry that resolves to destDir itself (e.g. a "/" root marker JSZip
    // can emit after normalizing a traversal) has no file to write — skip it.
    if (rel === '') continue

    if (entry.dir) {
      await fs.mkdir(dest, { recursive: true })
      continue
    }

    fileCount += 1
    if (fileCount > MAX_FILES) {
      throw new ImportError(`The .zip has too many files (limit ${MAX_FILES}).`)
    }

    const content = await entry.async('nodebuffer')
    totalBytes += content.length
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new ImportError(
        `The .zip is too large uncompressed (limit ${formatBytes(MAX_TOTAL_BYTES)}).`
      )
    }

    await diskWriter.writeFileAtomic(dest, content)
  }

  if (fileCount === 0) {
    throw new ImportError('The .zip is empty.')
  }
}

/** Does this zip entry path live inside a junk dir (node_modules, __MACOSX…)? */
function isJunkPath(entryName: string): boolean {
  return entryName.split(/[/\\]/).some((seg) => seg.length > 0 && isJunk(seg))
}

/**
 * Walk a folder summing bytes and counting files, aborting the moment either
 * cap is exceeded. Run before copying a dropped folder so we never start a
 * copy we'd have to roll back. node_modules and friends are skipped — they're
 * never copied, so they shouldn't count against the budget.
 */
async function measureTree(dir: string): Promise<void> {
  let totalBytes = 0
  let fileCount = 0

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > 32) return // defensive: pathological nesting / symlink loop
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (isJunk(entry.name)) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
      } else if (entry.isFile()) {
        fileCount += 1
        if (fileCount > MAX_FILES) {
          throw new ImportError(`The folder has too many files (limit ${MAX_FILES}).`)
        }
        const st = await fs.stat(full).catch(() => null)
        if (st) {
          totalBytes += st.size
          if (totalBytes > MAX_TOTAL_BYTES) {
            throw new ImportError(
              `The folder is too large (limit ${formatBytes(MAX_TOTAL_BYTES)}).`
            )
          }
        }
      }
    }
  }

  await walk(dir, 0)
  if (fileCount === 0) {
    throw new ImportError('The folder has no files to import.')
  }
}

/**
 * Recursively copy src → dest, skipping junk (node_modules, .git, …) and,
 * optionally, any case-variant of SKILL.md (the caller rewrites the canonical
 * one). Uses fs.cp so it works across filesystems (staging lives in the OS
 * temp dir, the destination in the user's home).
 */
async function copyTree(
  src: string,
  dest: string,
  opts: { excludeSkillMd?: boolean } = {}
): Promise<void> {
  await fs.cp(src, dest, {
    recursive: true,
    force: true,
    filter: (from) => {
      const base = path.basename(from)
      if (isJunk(base)) return false
      if (opts.excludeSkillMd && base.toLowerCase() === 'skill.md') return false
      return true
    }
  })
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Turn a capability name into a safe folder slug: lowercase, non-alphanumerics
 * collapse to single hyphens, leading/trailing separators trimmed, capped at
 * 64 chars. "My Cool Skill!" → "my-cool-skill".
 */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, 64)
    .replace(/-+$/, '')
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
}
