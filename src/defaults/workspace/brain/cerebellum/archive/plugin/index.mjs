// Archive — work with .zip archives without ever shelling out: inspect the
// index, read a single file straight out of the archive, unpack all or part
// of it, and pack files/folders into a new zip.
//
// NO size gates anywhere — the model decides what to operate on. adm-zip
// works in memory (a create/extract holds the archive's bytes in RAM), so
// multi-GB trees are the one honest limit; the SKILL.md routes those to
// shell `zip -r` / `unzip` instead of refusing them here.
//
// Non-zip archives (tar, tgz, gz, bz2, xz, 7z, rar) are detected by MAGIC
// BYTES, not by extension, and rejected with the exact shell command that
// does handle them — a wrong extension never turns into a cryptic library
// error.
//
// Tools:
//   - archive_list:    entry index, sizes, layout (reads the directory only)
//   - archive_read:    one entry's text, no extraction
//   - archive_extract: unpack all/selected entries to a folder
//   - archive_create:  pack files/folders into a new .zip

import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'

/** Entry rows printed per archive_list call before paging kicks in. */
const LIST_DEFAULT_LIMIT = 100
const LIST_MAX_LIMIT = 1000
/** Characters returned per archive_read call. Always reported, never silent. */
const READ_MAX_CHARS = 40000
/** Bytes sniffed for NUL when deciding "is this entry text?". */
const BINARY_SNIFF_BYTES = 8192

// Archiver cruft that carries no user content. Skipped on extract and
// counted in the report — never silently dropped.
const JUNK_SEGMENTS = new Set(['__MACOSX', '.DS_Store', 'Thumbs.db'])

/** Thrown for every expected failure — caught once and returned as `error`. */
class ArchiveError extends Error {}

function workspaceRoot() {
  return path.join(os.homedir(), '.wolffish', 'workspace')
}

// Accept absolute, ~/-relative, and workspace-relative paths. Relative paths
// resolve against the workspace root — that's where uploads (uploads/…) and
// generated files (files/…) live. Mirrors the utilities plugin.
function resolveInput(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  const p = raw.trim()
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  if (path.isAbsolute(p)) return p
  return path.resolve(workspaceRoot(), p)
}

function sizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * "78% compressed", or nothing at all when compression didn't help — a tiny
 * archive is genuinely BIGGER than its contents (zip headers), and printing
 * "0% compressed" next to "241 B (23 B unpacked)" reads like a bug.
 */
function compressionNote(rawBytes, packedBytes) {
  if (rawBytes <= 0 || packedBytes >= rawBytes) return ''
  return `, ${Math.round((1 - packedBytes / rawBytes) * 100)}% compressed`
}

function dateLabel(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return ''
  return value.toISOString().slice(0, 10)
}

/**
 * Accept a JSON array, a comma/newline separated list, or a single value,
 * and return a clean string array. Models pass all three shapes.
 */
function toList(value) {
  if (value == null) return []
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  const raw = String(value).trim()
  if (!raw) return []
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean)
    } catch {
      // Not JSON after all — fall through to separator splitting.
    }
  }
  return raw
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter(Boolean)
}

/**
 * One pattern → predicate. A pattern containing * or ? is treated as a glob
 * (matched against the whole entry path AND its basename, so "*.ts" hits
 * "src/deep/file.ts"); anything else is a case-insensitive substring match.
 * Deliberately simple — the model can always fall back to listing everything.
 */
function matcherFor(pattern) {
  const p = pattern.trim()
  if (!p) return () => true
  if (p.includes('*') || p.includes('?')) {
    const source = p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
    const re = new RegExp(`^${source}$`, 'i')
    return (entryPath) => re.test(entryPath) || re.test(path.basename(entryPath))
  }
  const needle = p.toLowerCase()
  return (entryPath) => entryPath.toLowerCase().includes(needle)
}

function anyMatcher(patterns) {
  if (patterns.length === 0) return null
  const matchers = patterns.map(matcherFor)
  return (entryPath) => matchers.some((m) => m(entryPath))
}

function isJunkPath(entryPath) {
  return entryPath.split(/[/\\]/).some((seg) => JUNK_SEGMENTS.has(seg))
}

/**
 * Would this entry write outside the folder it is extracted into? adm-zip
 * hands entry names back verbatim — verified: it does NOT strip `../` — so
 * this is the only thing between a crafted archive and the user's home
 * directory. Resolved against a sentinel root so archive_list can report the
 * exact same verdict archive_extract will enforce (a harmless inner `..`
 * that still lands inside must not be flagged).
 */
const SENTINEL_ROOT = path.resolve(path.sep, '__wolffish_archive_root__')
function escapesRoot(entryName, root = SENTINEL_ROOT) {
  const rel = path.relative(root, path.join(root, entryName.replace(/\\/g, '/')))
  return rel.startsWith('..') || path.isAbsolute(rel)
}

/**
 * Reject non-zip archives by their magic bytes and name the tool that DOES
 * handle them. Extensions lie (a .zip that is really a tarball, a .bin that
 * is really a zip), so the signature is the authority — and a precise
 * "use tar -xzf" beats adm-zip's "No END header found".
 */
async function assertZipFormat(abs) {
  let head = Buffer.alloc(0)
  let tarMagic = ''
  let handle
  try {
    handle = await fs.open(abs, 'r')
    const buf = Buffer.alloc(266)
    const { bytesRead } = await handle.read(buf, 0, 266, 0)
    head = buf.subarray(0, bytesRead)
    if (bytesRead >= 262) tarMagic = buf.subarray(257, 262).toString('latin1')
  } catch {
    return // Unreadable header — let AdmZip surface the real IO error.
  } finally {
    await handle?.close().catch(() => {})
  }

  const name = path.basename(abs)
  const starts = (...bytes) =>
    head.length >= bytes.length && bytes.every((b, i) => head[i] === b)

  // PK\x03\x04 (normal), PK\x05\x06 (empty), PK\x07\x08 (spanned).
  if (starts(0x50, 0x4b)) return

  if (starts(0x1f, 0x8b)) {
    throw new ArchiveError(
      `${name} is gzip, not zip. These tools are zip-only — use your shell tool instead: ` +
        `\`tar -tzf "${abs}"\` to list, \`tar -xzf "${abs}" -C <output_dir>\` to unpack ` +
        `(for a plain single-file .gz: \`gunzip -c "${abs}" > <output_file>\`).`
    )
  }
  if (starts(0x42, 0x5a, 0x68)) {
    throw new ArchiveError(
      `${name} is bzip2, not zip. Use your shell tool: \`tar -tjf "${abs}"\` to list, ` +
        `\`tar -xjf "${abs}" -C <output_dir>\` to unpack.`
    )
  }
  if (starts(0xfd, 0x37, 0x7a, 0x58, 0x5a)) {
    throw new ArchiveError(
      `${name} is xz, not zip. Use your shell tool: \`tar -tJf "${abs}"\` to list, ` +
        `\`tar -xJf "${abs}" -C <output_dir>\` to unpack.`
    )
  }
  if (starts(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) {
    throw new ArchiveError(
      `${name} is a 7-Zip archive, not zip. Use your shell tool: \`7z l "${abs}"\` to list, ` +
        `\`7z x "${abs}" -o<output_dir>\` to unpack (install p7zip first if 7z is missing).`
    )
  }
  if (starts(0x52, 0x61, 0x72, 0x21)) {
    throw new ArchiveError(
      `${name} is a RAR archive, not zip. Use your shell tool: \`unar -o <output_dir> "${abs}"\` ` +
        `(or \`unrar x\`) — install unar first if it is missing.`
    )
  }
  if (tarMagic === 'ustar') {
    throw new ArchiveError(
      `${name} is a tar archive, not zip. Use your shell tool: \`tar -tf "${abs}"\` to list, ` +
        `\`tar -xf "${abs}" -C <output_dir>\` to unpack.`
    )
  }

  throw new ArchiveError(
    `${name} is not a zip archive (no PK signature at the start of the file). ` +
      `If it should be one it is truncated or corrupt; check it with \`file "${abs}"\`.`
  )
}

/** Open an archive for reading: resolve, verify it exists, verify it is a zip. */
async function openArchive(rawPath) {
  const abs = resolveInput(rawPath)
  if (!abs) throw new ArchiveError('path is required (path to the .zip archive)')

  let st
  try {
    st = await fs.stat(abs)
  } catch {
    throw new ArchiveError(`archive not found: ${abs}`)
  }
  if (st.isDirectory()) {
    throw new ArchiveError(
      `${abs} is a folder, not an archive. To pack it into a zip, use archive_create.`
    )
  }
  await assertZipFormat(abs)

  let zip
  try {
    zip = new AdmZip(abs)
  } catch (err) {
    throw new ArchiveError(
      `could not open ${path.basename(abs)}: ${err?.message ?? err}. The file may be truncated or corrupt.`
    )
  }
  return { zip, abs, sizeBytes: st.size }
}

/** Entries sorted by path so paging and filtering are stable across calls. */
function sortedEntries(zip) {
  return zip.getEntries().slice().sort((a, b) => a.entryName.localeCompare(b.entryName))
}

function archiveStats(entries) {
  let files = 0
  let dirs = 0
  let rawBytes = 0
  let packedBytes = 0
  let encrypted = 0
  let unsafe = 0
  const topLevel = new Set()
  for (const e of entries) {
    // Same verdict archive_extract will reach, reported here so the model can
    // warn the user about a hostile archive before touching it.
    if (escapesRoot(e.entryName)) unsafe += 1
    const first = e.entryName.split('/')[0]
    if (first && !JUNK_SEGMENTS.has(first)) {
      topLevel.add(e.entryName.includes('/') ? `${first}/` : first)
    }
    if (e.isDirectory) {
      dirs += 1
      continue
    }
    files += 1
    rawBytes += e.header.size
    packedBytes += e.header.compressedSize
    if (e.header.encrypted) encrypted += 1
  }
  return { files, dirs, rawBytes, packedBytes, encrypted, unsafe, topLevel: [...topLevel].sort() }
}

/**
 * Resolve the entry the model asked for. Exact match wins; then
 * case-insensitive; then a unique path-suffix match, so "README.md" finds
 * "project-main/README.md" (what a model naturally types after seeing a
 * listing). Ambiguity is reported, never guessed.
 */
function resolveEntry(entries, wanted) {
  if (wanted == null) throw new ArchiveError('entry is required (a path from archive_list)')
  const target = String(wanted).trim().replace(/^\.\//, '').replace(/\\/g, '/')
  if (!target) throw new ArchiveError('entry is required (a path from archive_list)')

  const files = entries.filter((e) => !e.isDirectory)
  const exact = files.find((e) => e.entryName === target)
  if (exact) return { entry: exact, note: '' }

  const lower = target.toLowerCase()
  const ci = files.filter((e) => e.entryName.toLowerCase() === lower)
  if (ci.length === 1) return { entry: ci[0], note: `(matched "${ci[0].entryName}")\n` }

  const suffix = files.filter(
    (e) => e.entryName.toLowerCase().endsWith(`/${lower}`) || e.entryName.toLowerCase() === lower
  )
  if (suffix.length === 1) return { entry: suffix[0], note: `(matched "${suffix[0].entryName}")\n` }
  if (suffix.length > 1) {
    const shown = suffix.slice(0, 10).map((e) => `  ${e.entryName}`).join('\n')
    throw new ArchiveError(
      `"${target}" matches ${suffix.length} entries — pass the full path:\n${shown}` +
        (suffix.length > 10 ? `\n  …and ${suffix.length - 10} more` : '')
    )
  }

  // Folder, not file. Checked by PREFIX as well as by directory entry: plenty
  // of zips carry no directory entries at all, so "project/src" would
  // otherwise come back as "no such entry" while its files sit right there.
  const asDir = target.replace(/\/$/, '')
  const dirHit =
    entries.some((e) => e.isDirectory && e.entryName.replace(/\/$/, '') === asDir) ||
    files.some((e) => e.entryName.startsWith(`${asDir}/`))
  if (dirHit) {
    throw new ArchiveError(
      `"${target}" is a folder inside the archive, not a file. List what's in it with ` +
        `archive_list(filter: "${target}/") or unpack it with archive_extract(entries: "${target}/*").`
    )
  }
  throw new ArchiveError(
    `no entry "${target}" in the archive. Run archive_list to see the exact paths.`
  )
}

/** Read one entry's bytes, translating adm-zip's password failures. */
function readEntryBuffer(zip, entry, password) {
  try {
    const buf = password ? zip.readFile(entry, password) : zip.readFile(entry)
    if (!buf) throw new Error('empty result')
    return buf
  } catch (err) {
    if (entry.header.encrypted) {
      throw new ArchiveError(
        `"${entry.entryName}" is encrypted and could not be decrypted${password ? ' with that password' : ' (no password given)'}. ` +
          `Pass \`password\`. If it keeps failing the archive likely uses AES encryption, which this tool cannot read — ` +
          `unpack it with your shell tool instead: \`unzip -P <password> "<archive>" -d <output_dir>\`.`
      )
    }
    throw new ArchiveError(`could not read "${entry.entryName}": ${err?.message ?? err}`)
  }
}

function looksBinary(buf) {
  const scan = buf.subarray(0, Math.min(buf.length, BINARY_SNIFF_BYTES))
  return scan.includes(0)
}

// ── archive_list ─────────────────────────────────────────────────────────

async function archiveList(args) {
  const { zip, abs, sizeBytes } = await openArchive(args?.path)
  const entries = sortedEntries(zip)
  const stats = archiveStats(entries)

  const lines = []
  lines.push(`Archive: ${path.basename(abs)} — ${sizeLabel(sizeBytes)} on disk`)
  lines.push(`Path: ${abs}`)
  if (entries.length === 0) {
    lines.push('The archive is empty — it contains no entries.')
    return { success: true, output: lines.join('\n') }
  }

  lines.push(
    `Contents: ${stats.files} file${stats.files === 1 ? '' : 's'}, ${stats.dirs} folder${stats.dirs === 1 ? '' : 's'} — ` +
      `${sizeLabel(stats.rawBytes)} unpacked${compressionNote(stats.rawBytes, stats.packedBytes)}`
  )
  if (stats.topLevel.length > 0) {
    const head = stats.topLevel.slice(0, 12).join('  ')
    lines.push(
      `Top level: ${head}${stats.topLevel.length > 12 ? `  …and ${stats.topLevel.length - 12} more` : ''}`
    )
  }
  if (stats.encrypted > 0) {
    lines.push(
      `${stats.encrypted} entr${stats.encrypted === 1 ? 'y is' : 'ies are'} encrypted — archive_read/archive_extract need \`password\`.`
    )
  }
  if (stats.unsafe > 0) {
    lines.push(
      `WARNING: ${stats.unsafe} entr${stats.unsafe === 1 ? 'y uses' : 'ies use'} a path that escapes the destination folder (".." or absolute). ` +
        `archive_extract will refuse this archive outright. Tell the user — a normal archive never does this.`
    )
  }

  const filter = typeof args?.filter === 'string' ? args.filter.trim() : ''
  const match = filter ? matcherFor(filter) : null
  const rows = entries.filter((e) => !e.isDirectory && (!match || match(e.entryName)))

  const rawLimit = Number(args?.limit)
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(1, Math.trunc(rawLimit)), LIST_MAX_LIMIT)
    : LIST_DEFAULT_LIMIT
  const rawOffset = Number(args?.offset)
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0
  const page = rows.slice(offset, offset + limit)

  lines.push('')
  if (rows.length === 0) {
    lines.push(`No file entries match filter "${filter}". Drop the filter to see everything.`)
    return { success: true, output: lines.join('\n') }
  }
  lines.push(
    filter
      ? `Files matching "${filter}": ${rows.length} (showing ${offset + 1}-${offset + page.length})`
      : `Files: ${rows.length} (showing ${offset + 1}-${offset + page.length})`
  )

  const width = Math.min(90, Math.max(...page.map((e) => e.entryName.length)))
  for (const e of page) {
    const flag = e.header.encrypted ? ' [encrypted]' : ''
    const when = dateLabel(e.header.time)
    lines.push(
      `  ${e.entryName.padEnd(width)}  ${sizeLabel(e.header.size).padStart(9)}  ${when}${flag}`
    )
  }

  const shownEnd = offset + page.length
  if (shownEnd < rows.length) {
    lines.push(
      `  … ${rows.length - shownEnd} more not shown — page with offset:${shownEnd}, or narrow with filter (e.g. "*.ts", "src/").`
    )
  }
  lines.push('')
  lines.push('Nothing has been unpacked. archive_read pulls one file out; archive_extract unpacks.')
  return { success: true, output: lines.join('\n') }
}

// ── archive_read ─────────────────────────────────────────────────────────

async function archiveRead(args) {
  const { zip, abs } = await openArchive(args?.path)
  const entries = sortedEntries(zip)
  const { entry, note } = resolveEntry(entries, args?.entry)
  const password = typeof args?.password === 'string' && args.password ? args.password : null

  const buf = readEntryBuffer(zip, entry, password)
  const header = `${entry.entryName} — ${sizeLabel(entry.header.size)} — inside ${path.basename(abs)}\n${note}`

  if (buf.length === 0) {
    return { success: true, output: `${header}The file is empty (0 bytes).` }
  }
  if (looksBinary(buf)) {
    return {
      success: true,
      output:
        `${header}This entry is binary, so there is no text to return. ` +
        `Unpack it with archive_extract (entries: "${entry.entryName}"), then open the extracted file with the right tool ` +
        `— image_view for images, pdf_info/pdf_read for PDFs, document_read/spreadsheet_read for office files.`
    }
  }

  let text = buf.toString('utf8')
  const allLines = text.split('\n')
  // A trailing newline yields a phantom empty last element — 5 lines of text
  // would otherwise be reported (and paged) as 6.
  if (allLines.length > 1 && allLines[allLines.length - 1] === '') allLines.pop()
  const totalLines = allLines.length
  const startLine = Number.isFinite(Number(args?.start_line))
    ? Math.max(1, Math.trunc(Number(args.start_line)))
    : 1
  const endLine = Number.isFinite(Number(args?.end_line))
    ? Math.max(startLine, Math.trunc(Number(args.end_line)))
    : null
  const sliced = startLine > 1 || endLine !== null
  if (sliced) text = allLines.slice(startLine - 1, endLine ?? undefined).join('\n')

  const notes = []
  notes.push(`${totalLines} line${totalLines === 1 ? '' : 's'} total`)
  if (sliced) notes.push(`showing ${startLine}-${endLine ?? totalLines}`)

  let capped = false
  if (text.length > READ_MAX_CHARS) {
    text = text.slice(0, READ_MAX_CHARS)
    capped = true
  }

  const tail = capped
    ? `\n\n[Capped at ${READ_MAX_CHARS} characters — the rest was NOT returned. Continue with start_line/end_line.]`
    : ''
  return {
    success: true,
    output: `${header}(${notes.join(', ')})\n\n${text}${tail}`
  }
}

// ── archive_extract ──────────────────────────────────────────────────────

/**
 * Pick a destination that doesn't clobber an existing folder: a folder named
 * after the archive, beside it. Uploads are the exception — workspace/uploads/
 * is the upload store, so an uploaded zip unpacks into workspace/files/ instead
 * of littering it.
 */
async function defaultOutputDir(archiveAbs) {
  const stem = path.basename(archiveAbs, path.extname(archiveAbs))
  const uploadsDir = path.join(workspaceRoot(), 'uploads')
  const parent =
    path.dirname(archiveAbs) === uploadsDir
      ? path.join(workspaceRoot(), 'files')
      : path.dirname(archiveAbs)
  let dest = path.join(parent, stem)
  let suffix = 0
  while (existsSync(dest)) {
    suffix += 1
    dest = path.join(parent, `${stem}_${suffix}`)
  }
  return dest
}

async function archiveExtract(args) {
  const { zip, abs } = await openArchive(args?.path)
  const entries = sortedEntries(zip)
  if (entries.length === 0) throw new ArchiveError(`${path.basename(abs)} is empty — nothing to extract.`)

  const password = typeof args?.password === 'string' && args.password ? args.password : null
  const selectors = toList(args?.entries)
  const selected = anyMatcher(selectors)

  const requested = args?.output_dir
  const destRoot = requested ? resolveInput(requested) : await defaultOutputDir(abs)
  if (!destRoot) throw new ArchiveError('output_dir must be a path')

  // Pass 1 — plan. Every entry is checked BEFORE a single byte is written, so
  // a refusal means nothing landed on disk no matter where the hostile entry
  // sits in the archive. adm-zip hands back entry names verbatim (verified: it
  // does NOT strip ../), so this check is the only thing standing between a
  // crafted archive and the user's home directory.
  const plan = []
  let junk = 0
  let skippedByFilter = 0

  for (const entry of entries) {
    const entryPath = entry.entryName.replace(/\\/g, '/')
    if (isJunkPath(entryPath)) {
      junk += 1
      continue
    }
    if (selected && !selected(entryPath)) {
      skippedByFilter += 1
      continue
    }

    if (escapesRoot(entryPath, destRoot)) {
      throw new ArchiveError(
        `refused: the archive contains an unsafe path ("${entry.entryName}") that would write outside ${destRoot}. Nothing was extracted — this archive is malformed or hostile.`
      )
    }
    const dest = path.join(destRoot, entryPath)
    if (path.relative(destRoot, dest) === '') continue
    plan.push({ entry, entryPath, dest })
  }

  // Pass 2 — write.
  const written = []
  let bytes = 0
  let dirsMade = 0
  for (const { entry, entryPath, dest } of plan) {
    if (entry.isDirectory) {
      await fs.mkdir(dest, { recursive: true })
      dirsMade += 1
      continue
    }
    // Symlink entries are written as plain files holding their target text —
    // deliberate: an extracted symlink is an escape hatch around the guard above.
    const buf = readEntryBuffer(zip, entry, password)
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.writeFile(dest, buf)
    written.push(entryPath)
    bytes += buf.length
  }

  if (written.length === 0 && dirsMade > 0) {
    // Folder-only archive: the folders DID land, so reporting "nothing was
    // extracted" would be false.
    return {
      success: true,
      output: `Created ${dirsMade} empty folder${dirsMade === 1 ? '' : 's'} under ${destRoot} — the archive holds no files, only folder entries.`
    }
  }
  if (written.length === 0) {
    if (selectors.length > 0) {
      throw new ArchiveError(
        `no entries matched ${selectors.map((s) => `"${s}"`).join(', ')} — run archive_list to see the exact paths. Nothing was extracted.`
      )
    }
    throw new ArchiveError(`nothing to extract from ${path.basename(abs)} (no file entries).`)
  }

  const top = [...new Set(written.map((p) => (p.includes('/') ? `${p.split('/')[0]}/` : p)))].sort()
  const lines = []
  lines.push(
    `Extracted ${written.length} file${written.length === 1 ? '' : 's'} (${sizeLabel(bytes)}) to ${destRoot}`
  )
  lines.push(`Contains: ${top.slice(0, 12).join('  ')}${top.length > 12 ? `  …and ${top.length - 12} more` : ''}`)
  if (selectors.length > 0) {
    lines.push(`Left in the archive: ${skippedByFilter} entr${skippedByFilter === 1 ? 'y' : 'ies'} that did not match your selection.`)
  }
  if (junk > 0) {
    lines.push(`Skipped ${junk} archiver cruft entr${junk === 1 ? 'y' : 'ies'} (__MACOSX / .DS_Store / Thumbs.db).`)
  }
  lines.push('')
  lines.push(
    'The files are on disk but the user has not seen them: show_path the folder for an openable card, or send_file a specific file.'
  )
  return { success: true, output: lines.join('\n') }
}

// ── archive_create ───────────────────────────────────────────────────────

/** Every file under `dir`, as absolute paths. */
async function walkFiles(dir) {
  const out = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    const dirents = await fs.readdir(current, { withFileTypes: true })
    for (const dirent of dirents) {
      const full = path.join(current, dirent.name)
      // Symlinks are not followed: a link into /etc would silently pull system
      // files into the user's archive.
      if (dirent.isSymbolicLink()) continue
      if (dirent.isDirectory()) stack.push(full)
      else if (dirent.isFile()) out.push(full)
    }
  }
  return out
}

async function archiveCreate(args) {
  const outRaw = args?.output_path
  const outPath = resolveInput(outRaw)
  if (!outPath) throw new ArchiveError('output_path is required (where to write the .zip)')
  if (path.extname(outPath).toLowerCase() !== '.zip') {
    throw new ArchiveError(`output_path must end in .zip (got "${path.basename(outPath)}")`)
  }

  const inputs = toList(args?.paths)
  if (inputs.length === 0) {
    throw new ArchiveError('paths is required (the files/folders to pack, as a JSON array or comma-separated list)')
  }

  const baseDir = args?.base_dir ? resolveInput(args.base_dir) : null
  const excluded = anyMatcher(toList(args?.exclude))

  // Collect (absolutePath → entryName) pairs first so nothing is written
  // until every input is known-good.
  const items = []
  let excludedCount = 0
  for (const raw of inputs) {
    const abs = resolveInput(raw)
    if (!abs) continue
    let st
    try {
      st = await fs.stat(abs)
    } catch {
      throw new ArchiveError(`not found: ${abs} — nothing was written.`)
    }

    const entryFor = (filePath) => {
      if (baseDir) {
        const rel = path.relative(baseDir, filePath)
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          throw new ArchiveError(`${filePath} is not inside base_dir (${baseDir}) — nothing was written.`)
        }
        return rel.split(path.sep).join('/')
      }
      if (st.isDirectory()) {
        // Keep the folder itself as the archive's root so unpacking produces a
        // folder instead of spraying files into the user's cwd.
        const rel = path.relative(abs, filePath)
        return [path.basename(abs), ...rel.split(path.sep)].join('/')
      }
      return path.basename(filePath)
    }

    const files = st.isDirectory() ? await walkFiles(abs) : [abs]
    for (const file of files) {
      const entryName = entryFor(file)
      if (excluded && excluded(entryName)) {
        excludedCount += 1
        continue
      }
      items.push({ file, entryName })
    }
  }

  if (items.length === 0) {
    throw new ArchiveError(
      excludedCount > 0
        ? `every candidate file (${excludedCount}) was removed by \`exclude\` — nothing was written.`
        : 'no files to pack (the inputs are empty folders) — nothing was written.'
    )
  }

  const seen = new Set()
  const zip = new AdmZip()
  let rawBytes = 0
  for (const { file, entryName } of items) {
    // Two inputs can collide on one entry name (same basename from different
    // folders). Disambiguate instead of letting the second silently win.
    let name = entryName
    let suffix = 0
    while (seen.has(name)) {
      suffix += 1
      const ext = path.extname(entryName)
      name = `${entryName.slice(0, entryName.length - ext.length)}_${suffix}${ext}`
    }
    seen.add(name)
    const buf = await fs.readFile(file)
    rawBytes += buf.length
    zip.addFile(name, buf)
  }

  const replaced = existsSync(outPath)
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  try {
    zip.writeZip(outPath)
  } catch (err) {
    throw new ArchiveError(`could not write ${outPath}: ${err?.message ?? err}`)
  }

  const finalSize = (await fs.stat(outPath)).size

  const lines = []
  lines.push(
    `Created ${outPath} — ${items.length} file${items.length === 1 ? '' : 's'}, ` +
      `${sizeLabel(finalSize)} (${sizeLabel(rawBytes)} unpacked${compressionNote(rawBytes, finalSize)})`
  )
  if (replaced) lines.push('An existing file at that path was replaced.')
  if (excludedCount > 0) lines.push(`Excluded ${excludedCount} file${excludedCount === 1 ? '' : 's'} by your \`exclude\` patterns.`)
  // Observe and notify — never silently drop these; the model (and user) decide.
  const heavy = ['node_modules', '.git', 'venv', '__pycache__', 'dist', 'build'].filter((dir) =>
    items.some(({ entryName }) => entryName.split('/').includes(dir))
  )
  if (heavy.length > 0) {
    lines.push(
      `Included ${heavy.join(', ')} — if that wasn't intended, re-run with exclude: "${heavy.join(',')}".`
    )
  }
  lines.push('')
  lines.push('Nothing is delivered automatically — send_file this archive if the user should receive it.')
  return { success: true, output: lines.join('\n') }
}

function describeAction(toolName, args) {
  const target = String(args?.path ?? args?.output_path ?? '')
  const base = target ? path.basename(target) : 'archive'
  switch (toolName) {
    case 'archive_list':
      return { title: 'List archive', description: `Read the contents index of ${base}`, risk: 'low' }
    case 'archive_read':
      return {
        title: 'Read from archive',
        description: `Read ${String(args?.entry ?? 'a file')} out of ${base}`,
        risk: 'low'
      }
    case 'archive_extract':
      return {
        title: 'Extract archive',
        description: `Unpack ${base}${args?.output_dir ? ` into ${args.output_dir}` : ''}`,
        // `command` is the path row on the approval card — omit it rather than
        // render an empty one when the destination is the default.
        ...(args?.output_dir ? { command: String(args.output_dir) } : {}),
        risk: 'medium'
      }
    case 'archive_create':
      return {
        title: 'Create archive',
        description: `Pack ${toList(args?.paths).length || 'the given'} item(s) into ${base}`,
        command: target,
        risk: 'medium'
      }
    default:
      return null
  }
}

const toolDefinitions = [
  {
    name: 'archive_list',
    description:
      'List what is inside a .zip without unpacking it — entry paths, sizes, dates, layout, and totals. Reads only the archive index, so it is fast on any size.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the .zip archive' },
        filter: { type: 'string', description: 'Glob ("*.ts") or substring ("src/") to narrow the listing' },
        limit: { type: 'number', description: 'Rows to show, 1-1000 (default 100)' },
        offset: { type: 'number', description: 'Row to start from, for paging' }
      },
      required: ['path']
    }
  },
  {
    name: 'archive_read',
    description:
      'Read one text file straight out of a .zip without extracting anything to disk.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the .zip archive' },
        entry: { type: 'string', description: 'Entry path inside the archive' },
        start_line: { type: 'number', description: 'First line to return (1-based)' },
        end_line: { type: 'number', description: 'Last line to return' },
        password: { type: 'string', description: 'Password, if the archive is encrypted' }
      },
      required: ['path', 'entry']
    }
  },
  {
    name: 'archive_extract',
    description: 'Unzip an archive — all of it, or only the entries you select — into a folder on disk.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the .zip archive' },
        output_dir: { type: 'string', description: 'Destination folder (default: a new folder beside the archive)' },
        entries: { type: 'string', description: 'Optional entry paths/globs to extract instead of everything' },
        password: { type: 'string', description: 'Password, if the archive is encrypted' }
      },
      required: ['path']
    }
  },
  {
    name: 'archive_create',
    description: 'Zip files and/or folders into a new .zip archive.',
    parameters: {
      type: 'object',
      properties: {
        output_path: { type: 'string', description: 'Path for the new .zip' },
        paths: { type: 'string', description: 'JSON array or comma-separated list of files/folders to pack' },
        base_dir: { type: 'string', description: 'Folder the entry paths are made relative to' },
        exclude: { type: 'string', description: 'Glob/substring patterns to leave out (e.g. "node_modules,.git")' }
      },
      required: ['output_path', 'paths']
    }
  }
]

const plugin = {
  name: 'archive',
  tools: toolDefinitions,
  describeAction,
  async execute(toolName, args) {
    try {
      switch (toolName) {
        case 'archive_list':
          return await archiveList(args)
        case 'archive_read':
          return await archiveRead(args)
        case 'archive_extract':
          return await archiveExtract(args)
        case 'archive_create':
          return await archiveCreate(args)
        default:
          return { success: false, error: `archive: unknown tool ${toolName}` }
      }
    } catch (err) {
      if (err instanceof ArchiveError) return { success: false, error: err.message }
      return { success: false, error: `archive: ${err?.message ?? String(err)}` }
    }
  }
}

export default plugin
