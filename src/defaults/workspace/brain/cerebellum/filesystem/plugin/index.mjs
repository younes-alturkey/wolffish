import fs from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import { diagnoseFile, formatDiagnostics, shutdownDiagnostics } from './diagnostics.mjs'
import { formatFile } from './format.mjs'
import {
  convertToLineEnding,
  detectLineEnding,
  normalizeLineEndings,
  replace as replaceInContent
} from './replacers.mjs'
import { formatGlob, formatGrep, glob as globFiles, grep as grepFiles } from './search.mjs'
import { countChanges, createUnifiedDiff } from './unified-diff.mjs'

// file_read: the model's window into a file. Line-numbered (`N: text`) so
// edits can quote exact lines and the model can reference `path:line`;
// a default window of 2000 lines / 100 KB from `offset`; long lines
// clipped; any deeper range reachable with offset/limit. Ported from
// OpenCode's read tool, keeping this plugin's streaming ranged reads.
const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MAX_READ_BYTES = 100 * 1024
const READ_CHUNK_BYTES = 1024 * 1024
// A "line" longer than this means a binary or single-line monster — bail
// with guidance instead of buffering the whole file.
const MAX_CARRY_BYTES = 8 * 1024 * 1024
const COUNT_LINES_MAX_BYTES = 64 * 1024 * 1024
const DIR_LIST_LIMIT = 500
const BINARY_EXTS = new Set([
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib',
  '.class', '.jar', '.war', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods',
  '.odp', '.bin', '.dat', '.obj', '.o', '.a', '.lib', '.wasm', '.pyc', '.pyo', '.pdf', '.png',
  '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.icns', '.mp3', '.mp4', '.mov', '.wav',
  '.m4a', '.ogg', '.flac', '.avi', '.mkv', '.sqlite', '.db', '.ttf', '.otf', '.woff', '.woff2'
])

const toolDefinitions = [
  {
    name: 'file_read',
    description:
      'Read a file (line-numbered) or list a directory. offset/limit select a window; default 2000 lines from the top.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path, ~ path, or relative to the working folder' },
        offset: { type: 'number', description: '1-based first line (default 1)' },
        limit: { type: 'number', description: 'Max lines to return (default 2000)' },
        startLine: { type: 'number', description: 'Alias of offset' },
        endLine: { type: 'number', description: 'Last line, inclusive (alternative to limit)' }
      },
      required: ['path']
    }
  },
  {
    name: 'file_edit',
    description:
      'Replace one exact occurrence of `old` with `new` in a file (or every occurrence with replaceAll). Returns the diff.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path, ~ path, or relative to the working folder' },
        old: { type: 'string', description: 'The exact text to replace (empty only to create a new file)' },
        new: { type: 'string', description: 'The replacement text' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence (default false)' }
      },
      required: ['path', 'old', 'new']
    }
  },
  {
    name: 'file_write',
    description: 'Create or overwrite a text file. mode=append appends instead.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path, ~ path, or relative to the working folder' },
        content: { type: 'string', description: 'Text to write' },
        mode: { type: 'string', enum: ['overwrite', 'append'] }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'file_grep',
    description: 'Search file contents with a regex (ripgrep). Returns path, line number and text for up to 100 matches.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex to search for' },
        path: { type: 'string', description: 'Directory (or file) to search; default the working folder' },
        include: { type: 'string', description: 'File glob filter, e.g. "*.ts" or "*.{ts,tsx}"' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'file_glob',
    description: 'Find files by glob pattern (e.g. "src/**/*.ts"). Returns up to 100 absolute paths.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern' },
        path: { type: 'string', description: 'Directory to search; default the working folder' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'file_patch',
    description: 'Deprecated alias of file_edit with replaceAll=true: replace every occurrence of find with replace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path or ~ path' },
        find: { type: 'string', description: 'Literal text to search for' },
        replace: { type: 'string', description: 'Replacement text' }
      },
      required: ['path', 'find', 'replace']
    }
  },
  {
    name: 'image_view',
    description:
      'View an image file — returns the actual pixels in the tool result. max_dimension sets the long edge (default 1024); region crops in ORIGINAL pixels before the resize; format png keeps text and UI crisp, jpeg suits photographs.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path or ~ prefix to the image file' },
        max_dimension: { type: 'integer', description: 'Long edge of the returned view in pixels (default 1024)' },
        region: {
          type: 'object',
          description: 'Crop to inspect, in ORIGINAL image pixels, applied before the resize.',
          properties: {
            x: { type: 'integer', description: 'Left edge in original pixels' },
            y: { type: 'integer', description: 'Top edge in original pixels' },
            width: { type: 'integer', description: 'Crop width in original pixels' },
            height: { type: 'integer', description: 'Crop height in original pixels' }
          },
          required: ['x', 'y', 'width', 'height']
        },
        format: { type: 'string', description: 'jpeg (default) or png', enum: ['jpeg', 'png'] },
        quality: { type: 'integer', description: 'JPEG quality 1-100 (default 75). Ignored for png.' }
      },
      required: ['path']
    }
  }
]

function workspaceRoot() {
  return path.join(homedir(), '.wolffish', 'workspace')
}

// Injected at init: the turn's working folders. With one set, a relative
// path resolves against the FIRST folder — the model works inside the
// project the way it would in a terminal opened there. Without one, the
// legacy base holds: the Wolffish workspace (files/…, uploads/…).
let getWorkingFolders = () => []

function firstWorkingFolder() {
  try {
    const folders = getWorkingFolders()
    if (Array.isArray(folders) && typeof folders[0] === 'string' && folders[0]) return folders[0]
  } catch {
    // fall through
  }
  return null
}

function relativeBase() {
  return firstWorkingFolder() ?? workspaceRoot()
}

// Accept absolute, ~/-relative, and relative paths. Relative paths resolve
// against the working folder when the turn has one, else the workspace root
// (where the agent keeps generated files, matching send_file) — never
// against process cwd (the repo in dev, "/" in a packaged app).
function resolveUserPath(input) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('path is required')
  }
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(homedir(), input.slice(2))
  }
  return path.resolve(relativeBase(), input)
}

/** A path as the user would recognise it: relative to the working folder when inside it. */
function displayPath(abs) {
  const folder = firstWorkingFolder()
  if (folder && abs.startsWith(folder + path.sep)) return path.relative(folder, abs)
  return abs
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function clipLine(text) {
  return text.length > MAX_LINE_LENGTH ? text.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : text
}

/**
 * Count the lines of a file up to COUNT_LINES_MAX_BYTES; null when larger
 * (the footer then says "of ≥N" instead of a total).
 */
async function countLines(target, size) {
  if (size > COUNT_LINES_MAX_BYTES) return null
  const fh = await fs.open(target, 'r')
  try {
    const buf = Buffer.alloc(READ_CHUNK_BYTES)
    let count = 0
    let pos = 0
    let last = 0x0a
    while (true) {
      const { bytesRead } = await fh.read(buf, 0, READ_CHUNK_BYTES, pos)
      if (bytesRead === 0) break
      pos += bytesRead
      for (let i = 0; i < bytesRead; i++) if (buf[i] === 0x0a) count++
      last = buf[bytesRead - 1]
    }
    if (size > 0 && last !== 0x0a) count++
    return count
  } finally {
    await fh.close()
  }
}

/**
 * Stream a 1-based inclusive line range out of a file of any size. Scans
 * in chunks, splits only at newline bytes (a safe boundary in UTF-8), keeps
 * nothing but the requested lines, and stops reading as soon as the range
 * is collected — so a deep range in a multi-GB file costs only the bytes
 * before it, never the whole file.
 */
async function readLineRange(target, startLine, endLine) {
  const fh = await fs.open(target, 'r')
  try {
    const collected = []
    let collectedBytes = 0
    let capped = false
    let lineNo = 1
    let carry = Buffer.alloc(0)
    let pos = 0
    const buf = Buffer.alloc(READ_CHUNK_BYTES)

    const takeLine = (lineBuf) => {
      if (lineNo >= startLine && lineNo <= endLine) {
        const text = clipLine(lineBuf.toString('utf8').replace(/\r$/, ''))
        const size = Buffer.byteLength(text, 'utf8') + 1
        if (collected.length > 0 && collectedBytes + size > MAX_READ_BYTES) {
          capped = true
          return false
        }
        collected.push(text)
        collectedBytes += size
      }
      lineNo++
      return lineNo <= endLine
    }

    outer: while (true) {
      const { bytesRead } = await fh.read(buf, 0, READ_CHUNK_BYTES, pos)
      if (bytesRead === 0) break
      pos += bytesRead
      const chunk = Buffer.concat([carry, buf.subarray(0, bytesRead)])
      let searchFrom = 0
      while (true) {
        const nl = chunk.indexOf(0x0a, searchFrom)
        if (nl === -1) break
        if (!takeLine(chunk.subarray(searchFrom, nl))) break outer
        searchFrom = nl + 1
      }
      carry = Buffer.from(chunk.subarray(searchFrom))
      if (carry.length > MAX_CARRY_BYTES) {
        return {
          error: `A single line in ${target} exceeds ${MAX_CARRY_BYTES / 1024 / 1024}MB — this looks like a binary or single-line file. Use shell tools (head -c, rg, jq) instead of line-based reads.`
        }
      }
    }
    if (!capped && lineNo >= startLine && lineNo <= endLine && carry.length > 0) {
      takeLine(carry)
    }
    return { lines: collected, capped, firstLine: startLine }
  } finally {
    await fh.close()
  }
}

async function isBinaryFile(target, size) {
  if (BINARY_EXTS.has(path.extname(target).toLowerCase())) return true
  if (size === 0) return false
  const fh = await fs.open(target, 'r')
  try {
    const buf = Buffer.alloc(Math.min(4096, size))
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    let nonPrintable = 0
    for (let i = 0; i < bytesRead; i++) {
      const b = buf[i]
      if (b === 0) return true
      if (b < 9 || (b > 13 && b < 32)) nonPrintable++
    }
    return bytesRead > 0 && nonPrintable / bytesRead > 0.3
  } finally {
    await fh.close()
  }
}

async function listDirectory(target, offset) {
  const entries = await fs.readdir(target, { withFileTypes: true })
  const rows = []
  for (const e of entries) {
    let isDir = e.isDirectory()
    if (e.isSymbolicLink()) {
      try {
        isDir = (await fs.stat(path.join(target, e.name))).isDirectory()
      } catch {
        isDir = false
      }
    }
    rows.push(isDir ? `${e.name}/` : e.name)
  }
  rows.sort((a, b) => a.localeCompare(b))
  const start = Math.max(0, offset - 1)
  const shown = rows.slice(start, start + DIR_LIST_LIMIT)
  const lines = [`Directory ${target} (${rows.length} entries)`, ...shown]
  if (start + shown.length < rows.length) {
    lines.push(
      `(Showing ${start + 1}-${start + shown.length} of ${rows.length}. Use offset=${start + shown.length + 1} to continue.)`
    )
  }
  return lines.join('\n')
}

async function didYouMean(target) {
  const dir = path.dirname(target)
  const base = path.basename(target).toLowerCase()
  try {
    const entries = await fs.readdir(dir)
    const near = entries
      .filter((n) => n.toLowerCase().includes(base) || base.includes(n.toLowerCase()))
      .slice(0, 3)
      .map((n) => path.join(dir, n))
    if (near.length > 0) return `\nDid you mean one of these?\n${near.join('\n')}`
    return entries.length > 0
      ? `\nParent directory ${dir} contains: ${entries.slice(0, 40).join(', ')}${entries.length > 40 ? ', …' : ''}`
      : `\nParent directory ${dir} exists but is empty.`
  } catch {
    return `\nParent directory ${dir} does not exist either.`
  }
}

async function readFile(args) {
  const target = resolveUserPath(args?.path)
  let stat
  try {
    stat = await fs.stat(target)
  } catch {
    return { success: false, error: `File not found: ${target}${await didYouMean(target)}` }
  }

  const offsetRaw = typeof args?.offset === 'number' ? args.offset : args?.startLine
  const offset = typeof offsetRaw === 'number' && Number.isFinite(offsetRaw) ? Math.max(1, Math.floor(offsetRaw)) : 1

  if (stat.isDirectory()) {
    try {
      return { success: true, output: await listDirectory(target, offset) }
    } catch (err) {
      return { success: false, error: err?.message ?? String(err) }
    }
  }

  if (await isBinaryFile(target, stat.size)) {
    return {
      success: false,
      retryable: false,
      error: `Cannot read binary file: ${target}. Use image_view for images, the pdf tools for PDFs, or shell tools (file, xxd, ffprobe) for other binaries.`
    }
  }

  let limit
  if (typeof args?.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0) {
    limit = Math.floor(args.limit)
  } else if (typeof args?.endLine === 'number' && Number.isFinite(args.endLine)) {
    limit = Math.max(1, Math.floor(args.endLine) - offset + 1)
  } else {
    limit = DEFAULT_READ_LIMIT
  }
  const endLine = offset + limit - 1

  if (stat.size === 0) return { success: true, output: `${target} is empty (0 lines).` }

  let range
  try {
    range = await readLineRange(target, offset, endLine)
  } catch (err) {
    return { success: false, error: err?.message ?? String(err) }
  }
  if (range.error) return { success: false, error: range.error }

  const total = await countLines(target, stat.size).catch(() => null)
  if (range.lines.length === 0) {
    return {
      success: false,
      retryable: false,
      error: `Offset ${offset} is out of range for ${target}${total !== null ? ` (${total} lines)` : ''}.`
    }
  }
  const last = offset + range.lines.length - 1
  const body = range.lines.map((text, i) => `${offset + i}: ${text}`).join('\n')
  const totalLabel = total !== null ? `${total}` : `≥${last}`
  let footer
  if (range.capped) {
    footer = `(Output capped at ${Math.round(MAX_READ_BYTES / 1024)} KB. Showing lines ${offset}-${last} of ${totalLabel}. Use offset=${last + 1} to continue.)`
  } else if (total !== null && last >= total) {
    footer = offset === 1 ? `(End of file — ${total} lines)` : `(End of file — lines ${offset}-${last} of ${total})`
  } else {
    footer = `(Showing lines ${offset}-${last} of ${totalLabel}. Use offset=${last + 1} to continue.)`
  }
  return { success: true, output: `${body}\n${footer}` }
}

// ---------------------------------------------------------------------------
// Writing and editing
// ---------------------------------------------------------------------------

const BOM = '\uFEFF'

function splitBom(text) {
  return text.startsWith(BOM) ? { bom: true, text: text.slice(1) } : { bom: false, text }
}

async function readTextOrNull(target) {
  try {
    return await fs.readFile(target, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return null
    throw err
  }
}

/**
 * Build the UI diff + counts for a change. Header paths are display paths
 * (relative to the working folder when inside it) so the hunk header reads
 * `--- a/src/foo.ts` rather than an absolute double slash.
 */
function buildDiff(target, before, after, kind) {
  const shown = displayPath(target).replace(/^\/+/, '')
  const b = normalizeLineEndings(before)
  const a = normalizeLineEndings(after)
  const patch = createUnifiedDiff(shown, b, a)
  const { additions, deletions } = countChanges(b, a)
  return { file: target, patch, additions, deletions, kind }
}

/**
 * After-edit diagnostics: the project's own checker on the file just
 * changed (tsserver for TypeScript, eslint when configured, ruff/pyright for
 * Python — see diagnostics.mjs). Errors ride the tool result so the model
 * fixes them now, before running anything; the count rides meta for the
 * card. Never throws, never blocks longer than the checker's own budget.
 */
async function diagnosticsBlock(target) {
  try {
    const result = await diagnoseFile(target, firstWorkingFolder())
    if (!result) return { text: '', count: 0, tool: null }
    return { text: formatDiagnostics(target, result), count: result.errors.length, tool: result.tool }
  } catch {
    return { text: '', count: 0, tool: null }
  }
}

/**
 * The lines around the first change, numbered as they now stand in the
 * file — the model verifies the edit landed by reading this instead of
 * re-reading the file.
 */
function changedRegionSnippet(before, after, maxLines = 40) {
  const b = normalizeLineEndings(before).split('\n')
  const a = normalizeLineEndings(after).split('\n')
  let first = 0
  while (first < a.length && first < b.length && a[first] === b[first]) first++
  let tailA = a.length - 1
  let tailB = b.length - 1
  while (tailA > first && tailB > first && a[tailA] === b[tailB]) {
    tailA--
    tailB--
  }
  const start = Math.max(0, first - 3)
  const end = Math.min(a.length - 1, Math.max(tailA, first) + 3)
  const rows = []
  for (let i = start; i <= end && rows.length < maxLines; i++) rows.push(`${i + 1}: ${clipLine(a[i])}`)
  const more = end - start + 1 - rows.length
  if (more > 0) rows.push(`… (${more} more changed lines not shown)`)
  return rows.join('\n')
}

async function writeFile(args) {
  const target = resolveUserPath(args?.path)
  const content = typeof args?.content === 'string' ? args.content : ''
  const mode = args?.mode === 'append' ? 'append' : 'overwrite'
  try {
    await fs.mkdir(path.dirname(target), { recursive: true })
    const before = await readTextOrNull(target)
    const after = mode === 'append' ? (before ?? '') + content : content
    if (mode === 'append') await fs.appendFile(target, content, 'utf8')
    else await fs.writeFile(target, content, 'utf8')
    const formatted = await formatFile(target, firstWorkingFolder())
    const final = formatted ? await fs.readFile(target, 'utf8') : after
    const kind = before === null ? 'create' : 'overwrite'
    const diff = buildDiff(target, before ?? '', final, kind)
    const bytes = Buffer.byteLength(content, 'utf8')
    const summary =
      mode === 'append'
        ? `Appended ${bytes} bytes to ${target}`
        : `${kind === 'create' ? 'Created' : 'Overwrote'} ${target} (${bytes} bytes, +${diff.additions} −${diff.deletions})`
    const diag = await diagnosticsBlock(target)
    const meta = { diff, label: mode === 'append' ? 'Append' : kind === 'create' ? 'Create' : 'Write' }
    if (diag.tool) meta.diagnostics = { tool: diag.tool, errors: diag.count }
    return {
      success: true,
      output: `${summary}${formatted ? ` — formatted with ${formatted}` : ''}${diag.text}`,
      meta
    }
  } catch (err) {
    return { success: false, error: err?.message ?? String(err) }
  }
}

async function editFile(args) {
  const target = resolveUserPath(args?.path)
  const oldString = typeof args?.old === 'string' ? args.old : ''
  const newString = typeof args?.new === 'string' ? args.new : ''
  const replaceAll = args?.replaceAll === true
  if (oldString === newString) {
    return { success: false, retryable: false, error: 'No changes to apply: old and new are identical.' }
  }
  let source
  try {
    source = await readTextOrNull(target)
  } catch (err) {
    return { success: false, error: err?.message ?? String(err) }
  }

  // Create-file mode: an empty `old` on a path that does not exist.
  if (oldString === '') {
    if (source !== null) {
      return {
        success: false,
        retryable: false,
        error: 'old cannot be empty when editing an existing file. Provide the exact text to replace, or use file_write for an intentional full-file replacement.'
      }
    }
    try {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, newString, 'utf8')
      const formatted = await formatFile(target, firstWorkingFolder())
      const final = formatted ? await fs.readFile(target, 'utf8') : newString
      const diff = buildDiff(target, '', final, 'create')
      const diag = await diagnosticsBlock(target)
      const meta = { diff, label: 'Create' }
      if (diag.tool) meta.diagnostics = { tool: diag.tool, errors: diag.count }
      return {
        success: true,
        output: `Created ${target} (+${diff.additions} lines)${formatted ? ` — formatted with ${formatted}` : ''}${diag.text}`,
        meta
      }
    } catch (err) {
      return { success: false, error: err?.message ?? String(err) }
    }
  }

  if (source === null) {
    return { success: false, retryable: false, error: `File not found: ${target}${await didYouMean(target)}` }
  }
  try {
    const stat = await fs.stat(target)
    if (stat.isDirectory()) {
      return { success: false, retryable: false, error: `Path is a directory, not a file: ${target}` }
    }
  } catch {
    // stat raced; proceed on the content we read
  }

  const { bom, text: contentOld } = splitBom(source)
  const ending = detectLineEnding(contentOld)
  const oldNorm = convertToLineEnding(normalizeLineEndings(oldString), ending)
  const newNorm = convertToLineEnding(normalizeLineEndings(newString), ending)

  let contentNew
  try {
    contentNew = replaceInContent(contentOld, oldNorm, newNorm, replaceAll)
  } catch (err) {
    return { success: false, retryable: false, error: err?.message ?? String(err) }
  }

  try {
    await fs.writeFile(target, (bom ? BOM : '') + contentNew, 'utf8')
  } catch (err) {
    return { success: false, error: err?.message ?? String(err) }
  }
  const formatted = await formatFile(target, firstWorkingFolder())
  const final = formatted ? splitBom(await fs.readFile(target, 'utf8')).text : contentNew
  const diff = buildDiff(target, contentOld, final, 'edit')
  const occurrences = replaceAll ? Math.max(1, contentOld.split(oldNorm).length - 1) : 1
  const diag = await diagnosticsBlock(target)
  const meta = { diff, label: 'Edit' }
  if (diag.tool) meta.diagnostics = { tool: diag.tool, errors: diag.count }
  return {
    success: true,
    output:
      `Edit applied to ${target} (+${diff.additions} −${diff.deletions}${replaceAll ? `, ${occurrences} occurrences` : ''})${formatted ? ` — formatted with ${formatted}` : ''}.\n` +
      `Changed region as it now stands:\n${changedRegionSnippet(contentOld, final)}${diag.text}`,
    meta
  }
}

// Deprecated alias kept for saved procedures, automations and old
// conversations: file_patch replaced EVERY occurrence with no uniqueness
// check. It now routes through file_edit with replaceAll, so it gains the
// diff and the guards.
async function patchFile(args) {
  const find = typeof args?.find === 'string' ? args.find : ''
  if (find.length === 0) return { success: false, error: 'find is required and must be non-empty' }
  return editFile({ path: args?.path, old: find, new: typeof args?.replace === 'string' ? args.replace : '', replaceAll: true })
}

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

async function resolveSearchRoot(input) {
  const base = typeof input === 'string' && input.trim() ? resolveUserPath(input.trim()) : relativeBase()
  const stat = await fs.stat(base).catch(() => null)
  if (!stat) throw new Error(`Path not found: ${base}`)
  return { base, isFile: stat.isFile() }
}

async function grepTool(args) {
  const pattern = typeof args?.pattern === 'string' ? args.pattern : ''
  if (!pattern) return { success: false, error: 'pattern is required' }
  try {
    const { base, isFile } = await resolveSearchRoot(args?.path)
    const cwd = isFile ? path.dirname(base) : base
    const include = typeof args?.include === 'string' && args.include ? args.include : isFile ? path.basename(base) : undefined
    const result = await grepFiles({ cwd, pattern, include })
    return {
      success: true,
      output: formatGrep(result, { pattern }),
      meta: { label: 'Search', cwd, truncated: result.truncated }
    }
  } catch (err) {
    const message = err?.message ?? String(err)
    return { success: false, retryable: !/Invalid regex|Path not found/.test(message), error: message }
  }
}

async function globTool(args) {
  const pattern = typeof args?.pattern === 'string' ? args.pattern : ''
  if (!pattern) return { success: false, error: 'pattern is required' }
  try {
    const { base, isFile } = await resolveSearchRoot(args?.path)
    if (isFile) return { success: false, retryable: false, error: `glob path must be a directory: ${base}` }
    const result = await globFiles({ cwd: base, pattern })
    return { success: true, output: formatGlob(result), meta: { label: 'Find files', cwd: base, truncated: result.truncated } }
  } catch (err) {
    return { success: false, error: err?.message ?? String(err) }
  }
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const IMAGE_VIEW_MAX_DIMENSION = 1024
const IMAGE_VIEW_JPEG_QUALITY = 75

/**
 * Mirrors MAX_INLINE_IMAGE_BYTES in src/main/runtime/tool-images.ts. The
 * runtime silently drops any tool-result image above that cap and leaves
 * a note in its place. The model picks its own dimensions here, so this
 * is the only place that can notice an over-cap encode and step it down
 * instead of letting the picture vanish on the way to the wire.
 */
const IMAGE_VIEW_WIRE_CAP_BYTES = 3 * 1024 * 1024

function imageViewInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? Math.round(value) : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * The model's rectangle intersected with the real image. Returning a
 * clamped rect rather than an error keeps a slightly-off crop useful —
 * sharp's extract() throws on any overflow, which would cost a round trip
 * to fix an off-by-a-few guess about an image the model has only seen
 * downscaled. The caption reports the clamp so the coordinates can be
 * corrected on the next call.
 */
function imageViewRegion(raw, srcWidth, srcHeight) {
  if (!raw || typeof raw !== 'object' || !srcWidth || !srcHeight) return null
  const left = imageViewInt(raw.x, 0, srcWidth - 1, 0)
  const top = imageViewInt(raw.y, 0, srcHeight - 1, 0)
  const width = imageViewInt(raw.width, 1, srcWidth - left, srcWidth - left)
  const height = imageViewInt(raw.height, 1, srcHeight - top, srcHeight - top)
  const asked = {
    left: imageViewInt(raw.x, -1e9, 1e9, 0),
    top: imageViewInt(raw.y, -1e9, 1e9, 0),
    width: imageViewInt(raw.width, -1e9, 1e9, width),
    height: imageViewInt(raw.height, -1e9, 1e9, height)
  }
  const clamped =
    asked.left !== left || asked.top !== top || asked.width !== width || asked.height !== height
  return { left, top, width, height, clamped }
}

/**
 * Attached images are never auto-injected into model context (100%
 * model-led policy) — this tool is how a vision model actually sees one.
 * Downscales via sharp (a lazily-installed runtime dep, same pattern as
 * the pdf capability's pdf-parse) and returns the pixels through the
 * StepResult images channel, exactly like the computer-use screenshot
 * tool. Decode failures (corrupt files, >268-megapixel inputs sharp
 * refuses) come back as clear errors with a shell-tool fallback.
 *
 * Dimensions, crop and encoding are the model's call, not this tool's —
 * a fixed 1024px view cannot resolve a receipt or a code screenshot, and
 * the model is the only party that knows whether this call needs to read
 * fine print or just recognize a scene. The defaults stay at the old
 * behaviour so an unparameterized call is unchanged.
 */
async function imageView(args) {
  const target = resolveUserPath(args?.path)
  let stat
  try {
    stat = await fs.stat(target)
  } catch {
    return { success: false, error: `ENOENT: ${target} not found.` }
  }
  try {
    const sharp = (await import('sharp')).default
    const meta = await sharp(target).metadata()
    const srcWidth = meta.width ?? 0
    const srcHeight = meta.height ?? 0

    const format = args?.format === 'png' ? 'png' : 'jpeg'
    const quality = imageViewInt(args?.quality, 1, 100, IMAGE_VIEW_JPEG_QUALITY)
    const region = imageViewRegion(args?.region, srcWidth, srcHeight)
    // No arbitrary ceiling: `withoutEnlargement` already bounds the request
    // by the source's own resolution, and the step-down below bounds it by
    // what the wire will carry. A cap here would just be a number to argue
    // with later.
    let edge = imageViewInt(args?.max_dimension, 1, 1e6, IMAGE_VIEW_MAX_DIMENSION)

    let buffer
    let info
    let steppedDown = false
    for (let attempt = 0; attempt < 4; attempt++) {
      let pipeline = sharp(target)
      if (region) {
        pipeline = pipeline.extract({
          left: region.left,
          top: region.top,
          width: region.width,
          height: region.height
        })
      }
      pipeline = pipeline.resize(edge, edge, { fit: 'inside', withoutEnlargement: true })
      const encoded = await (format === 'png'
        ? pipeline.png()
        : pipeline.jpeg({ quality })
      ).toBuffer({ resolveWithObject: true })
      buffer = encoded.data
      info = encoded.info
      if (buffer.length <= IMAGE_VIEW_WIRE_CAP_BYTES) break
      steppedDown = true
      // Bytes fall with area, so the long edge scales by the square root of
      // the overshoot; the 0.9 is headroom against a bad estimate on noisy
      // sources. Floor at 256 so a pathological image still returns pixels.
      const ratio = Math.sqrt(IMAGE_VIEW_WIRE_CAP_BYTES / buffer.length) * 0.9
      edge = Math.max(256, Math.floor(Math.max(info.width, info.height) * ratio))
    }

    const original =
      srcWidth && srcHeight ? `${srcWidth}x${srcHeight}` : 'unknown dimensions'
    const regionLabel = region
      ? ` region ${region.left},${region.top} ${region.width}x${region.height}` +
        `${region.clamped ? ' (clamped to image bounds)' : ''};`
      : ''
    const qualityLabel = format === 'jpeg' ? ` q${quality}` : ''
    const stepLabel = steppedDown
      ? `, stepped down from the requested size to stay under the ${IMAGE_VIEW_WIRE_CAP_BYTES / (1024 * 1024)}MB inline limit`
      : ''
    return {
      success: true,
      output:
        `Viewing ${target} — the pixels are attached to this result (original ${original}, ` +
        `${(stat.size / 1024).toFixed(0)}KB;${regionLabel} sent at ${info.width}x${info.height} ` +
        `${format}${qualityLabel}, ${(buffer.length / 1024).toFixed(0)}KB${stepLabel}).\n` +
        `These pixels are in context for THIS turn only — later turns keep this line but not the ` +
        `image. Call image_view again on the same path to see it once more, with a region or a ` +
        `larger max_dimension if you need finer detail.`,
      images: [{ mediaType: format === 'png' ? 'image/png' : 'image/jpeg', data: buffer.toString('base64') }]
    }
  } catch (err) {
    const reason = err?.message ?? String(err)
    return {
      success: false,
      error: `Could not decode ${target} (${String(reason).slice(0, 200)}). Inspect it with shell tools instead (sips -g all, exiftool, ffprobe), or convert/downscale a copy with sips or ffmpeg and view that.`
    }
  }
}

function describeAction(toolName, args) {
  const targetPath = String(args?.path ?? '')
  if (toolName === 'file_read') {
    const start = typeof args?.offset === 'number' ? args.offset : args?.startLine
    const range =
      typeof start === 'number' || typeof args?.limit === 'number' || typeof args?.endLine === 'number'
        ? ` (from line ${start ?? 1})`
        : ''
    return { title: 'Read file', description: `Read ${targetPath}${range}`, risk: 'low' }
  }
  if (toolName === 'file_write') {
    const mode = args?.mode === 'append' ? 'Append to' : 'Write'
    const bytes = typeof args?.content === 'string' ? args.content.length : 0
    return {
      title: `${mode} file`,
      description: `${mode} ${bytes} bytes to ${targetPath}`,
      command: targetPath,
      impact: args?.mode === 'append' ? undefined : 'Overwrites the file if it exists.',
      risk: 'medium'
    }
  }
  if (toolName === 'file_edit' || toolName === 'file_patch') {
    return {
      title: 'Edit file',
      description: `Edit ${targetPath}${args?.replaceAll || toolName === 'file_patch' ? ' (every occurrence)' : ''}`,
      command: targetPath,
      risk: 'medium'
    }
  }
  if (toolName === 'file_grep') {
    return { title: 'Search files', description: `Search for ${String(args?.pattern ?? '')}`, risk: 'low' }
  }
  if (toolName === 'file_glob') {
    return { title: 'Find files', description: `Find ${String(args?.pattern ?? '')}`, risk: 'low' }
  }
  if (toolName === 'image_view') {
    return { title: 'View image', description: `View ${targetPath}`, risk: 'low' }
  }
  return null
}

const plugin = {
  name: 'filesystem',
  tools: toolDefinitions,
  describeAction,
  async init(context) {
    if (typeof context?.getWorkingFolders === 'function') {
      getWorkingFolders = context.getWorkingFolders
    }
  },
  /**
   * Cerebellum.stop() awaits this. The after-edit diagnostics keep a
   * long-lived tsserver per project (diagnostics.mjs); without a destroy hook
   * nothing app-side ever asked them to exit, and they only died because
   * their piped stdin happened to close with us.
   */
  async destroy() {
    await shutdownDiagnostics()
  },
  async execute(toolName, args) {
    switch (toolName) {
      case 'file_read':
        return readFile(args)
      case 'file_write':
        return writeFile(args)
      case 'file_edit':
        return editFile(args)
      case 'file_patch':
        return patchFile(args)
      case 'file_grep':
        return grepTool(args)
      case 'file_glob':
        return globTool(args)
      case 'image_view':
        return imageView(args)
      default:
        return { success: false, error: `filesystem: unknown tool ${toolName}` }
    }
  }
}

export default plugin
