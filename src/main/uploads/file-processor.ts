// uploads.ts is deliberately Electron-free (its workspaceRoot comes from
// workspace/root, not workspace.ts), which keeps this module loadable under
// plain node despite the static import — what lets the policy tests exercise
// processAttachmentAbsolute directly.
import { resolveUploadPath } from '@main/uploads/uploads'
import fs from 'node:fs/promises'
import path from 'node:path'

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string }
  | { type: 'document'; mediaType: 'application/pdf'; data: string }

export type ProcessedAttachment = {
  originalName: string
  fileType: 'image' | 'pdf' | 'document' | 'archive'
  blocks: ContentBlock[]
}

export type FileProcessorOptions = {
  /**
   * Whether the active model accepts image content parts. It only changes
   * the WORDING of the image note: vision models are told to pull pixels
   * on demand with image_view; text-only models are told they cannot see
   * the image but can still operate on the file with tools.
   */
  supportsVision: boolean
}

// ── 100% model-led attachments ───────────────────────────────────────────
//
// NO attachment content is ever auto-injected into model context. Every
// file becomes a compact reference note — name, absolute path, type facts
// (page count, dimensions, size) — plus the exact tools to read it, and
// the model decides what to load and when: pdf_info/pdf_search/pdf_read,
// file_read line ranges, image_view for pixels, document/spreadsheet
// tools, shell.
//
// Why: whole-file injection was the choke. A 3,000-page PDF extracts to
// ~5-11M chars (~1.4-2.8M tokens — no context window holds it) and its
// base64 document block is tens of MB, so providers rejected or timed out
// after minutes of upload and retries and the turn looked hung. Reference
// notes make that structurally impossible while tools keep every byte
// reachable.
//
// The thresholds below choose a note's VERBOSITY tier, never whether
// content is inlined: small files get a short "read it with X" note, big
// files get the full traversal workflow plus the no-skip contract.
const PDF_SMALL_MAX_PAGES = 15
/** Above this, even the page-count probe (a full read into RAM) is skipped. */
const PDF_PROBE_MAX_BYTES = 256 * 1024 * 1024
/** Text/office files at or below this size count as "small" for note tier. */
const DOC_SMALL_MAX_BYTES = 64 * 1024

const NEVER_SKIP_NOTE =
  'Never guess or claim knowledge of parts you have not read or searched. For questions about the whole file, work through it in slices until you have genuinely covered it — the tools reach every byte.'

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const DOCUMENT_EXTS = new Set([
  '.docx',
  '.xlsx',
  '.xls',
  '.csv',
  '.tsv',
  '.txt',
  '.md',
  '.json',
  '.pptx',
  '.html',
  '.htm'
])
// Zip only, matching the archive capability's own scope. Must stay in sync
// with uploads.ts ARCHIVE_EXTS and validation.ts ALLOWED_ARCHIVE_EXTS.
const ARCHIVE_EXTS = new Set(['.zip'])

/**
 * Document mimetypes → the extension whose extractor handles them. Used as a
 * fallback when a file arrives with no usable filename extension — inbound
 * channel media (WhatsApp/Telegram) whose sender omitted or stripped the
 * extension. Without this an extension-less docx/xlsx/pptx would reach the
 * model as an opaque path with no extracted text, the same silent drop the
 * channel fix set out to prevent (the PDF case is already handled by the
 * dedicated application/pdf branch).
 */
const DOC_EXT_BY_MIME: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/csv': '.csv',
  'text/tab-separated-values': '.tsv',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/json': '.json',
  'text/html': '.html'
}

export async function processAttachment(
  relativePath: string,
  mimeType: string,
  originalName: string,
  options: FileProcessorOptions
): Promise<ProcessedAttachment | null> {
  const abs = await resolveUploadPath(relativePath)
  if (!abs) return null
  return processAttachmentAbsolute(abs, mimeType, originalName, options)
}

/** Same as processAttachment but on an already-resolved absolute path. */
export async function processAttachmentAbsolute(
  abs: string,
  mimeType: string,
  originalName: string,
  options: FileProcessorOptions
): Promise<ProcessedAttachment | null> {
  const ext = path.extname(originalName).toLowerCase()

  if (IMAGE_MIMES.has(mimeType)) {
    if (!options.supportsVision) return imageAsTextNote(abs, originalName)
    return imageReferenceNote(abs, originalName)
  }

  if (mimeType === 'application/pdf') {
    return processPdf(abs, originalName)
  }

  if (DOCUMENT_EXTS.has(ext)) {
    return processDocument(abs, originalName, ext)
  }

  if (ARCHIVE_EXTS.has(ext) || mimeType === 'application/zip') {
    return processArchive(abs, originalName)
  }

  // Extension-less document fallback: classifyFile preserves the sender's
  // mimetype, so map that back to the extractor's extension and process by
  // content (mammoth/xlsx/jszip read the bytes, not the name). Covers inbound
  // channel files that arrived without a usable filename extension.
  const docExt = DOC_EXT_BY_MIME[mimeType.split(';')[0].trim().toLowerCase()]
  if (docExt) {
    return processDocument(abs, originalName, docExt)
  }

  if (mimeType.startsWith('audio/')) return null
  if (mimeType.startsWith('video/')) return null

  return null
}

/**
 * Text-only models never receive image bytes (their APIs hard-reject image
 * parts), but the upload is accepted like any other file: instead of a
 * base64 block the model gets this note naming the file on disk, so it can
 * still operate on it with tools — and knows to tell the user it can't see
 * the pixels. Mirrors the <video_instructions> pattern in
 * compose-attachments.ts.
 */
function imageAsTextNote(absPath: string, originalName: string): ProcessedAttachment {
  return {
    originalName,
    fileType: 'image',
    blocks: [
      {
        type: 'text',
        text: `[Image attached: ${originalName} — saved at ${absPath}]\nThe active model is text-only and cannot view this image, but the file is on disk and fully workable. Use your shell tool to inspect or operate on it: metadata via ffprobe/exiftool/sips, conversions/resizes/crops via ffmpeg, plus any move/copy/rename or other file operations the user asks for. Let the user know you can't see the image's content but can still work on the file.`
      }
    ]
  }
}

/**
 * Vision models never get auto-injected pixels either — they get a note
 * with the facts and pull the image on demand with image_view (which
 * downscales and returns the pixels in the tool result). Metadata is probed
 * from the header only; a probe failure just yields a sparser note — the
 * image_view tool reports decode errors precisely when actually used.
 */
async function imageReferenceNote(
  absPath: string,
  originalName: string
): Promise<ProcessedAttachment> {
  const facts: string[] = []
  try {
    const stat = await fs.stat(absPath)
    try {
      const sharp = (await import('sharp')).default
      const meta = await sharp(absPath).metadata()
      if (meta.width && meta.height) facts.push(`${meta.width}x${meta.height}`)
    } catch {
      // undecodable header — size alone still helps
    }
    facts.push(sizeLabel(stat.size))
  } catch {
    // stat failure: note still carries name + path
  }
  const factsLabel = facts.length > 0 ? ` — ${facts.join(', ')}` : ''
  return {
    originalName,
    fileType: 'image',
    blocks: [
      {
        type: 'text',
        text:
          `[Image attached: ${originalName}${factsLabel} — not loaded into context]\n` +
          `Path: ${absPath}\n` +
          `View it with image_view (returns the pixels, downscaled) whenever its content matters — never describe or answer questions about an image you have not actually viewed. Shell tools (sips/exiftool/ffmpeg) can inspect or transform the file itself.`
      }
    ]
  }
}

function sizeLabel(sizeBytes: number): string {
  const mb = sizeBytes / 1024 / 1024
  return mb >= 1 ? `${mb.toFixed(1)}MB` : `${Math.ceil(sizeBytes / 1024)}KB`
}

/**
 * Every PDF becomes a reference note — small ones get a one-liner naming
 * the exact pdf_read call that returns the whole document; big ones get
 * the full navigation workflow plus the no-skip contract. The page count
 * is probed via a lazy xref-only load so the note states real facts.
 */
async function processPdf(absPath: string, originalName: string): Promise<ProcessedAttachment> {
  const stat = await fs.stat(absPath)
  // Probe the page count even for huge files (the note should say "3,012
  // pages", not shrug) — but not above the RAM-spike ceiling.
  const probeSkipped = stat.size > PDF_PROBE_MAX_BYTES
  const pageCount = probeSkipped ? null : await probePdfPageCount(absPath)

  if (pageCount !== null && pageCount <= PDF_SMALL_MAX_PAGES) {
    return {
      originalName,
      fileType: 'pdf',
      blocks: [
        {
          type: 'text',
          text:
            `[PDF attached: ${originalName} — ${pageCount} page${pageCount === 1 ? '' : 's'}, ${sizeLabel(stat.size)} — not loaded into context]\n` +
            `Path: ${absPath}\n` +
            `Read it in full with pdf_read (pages="1-${pageCount}") before answering anything about its contents; pdf_search finds text across it.`
        }
      ]
    }
  }

  return pdfReferenceNote(absPath, originalName, stat.size, pageCount, probeSkipped)
}

/** Page count via a lazy xref-only load — ~200ms even for thousands of pages. */
async function probePdfPageCount(absPath: string): Promise<number | null> {
  type LazyParser = {
    load: () => Promise<void>
    doc?: { numPages?: number }
    destroy?: () => Promise<void>
  }
  let parser: LazyParser | null = null
  try {
    const raw = await fs.readFile(absPath)
    const { PDFParse } = await import('pdf-parse')
    parser = new PDFParse({ data: new Uint8Array(raw) }) as unknown as LazyParser
    await parser.load()
    return parser.doc?.numPages ?? null
  } catch {
    return null
  } finally {
    await parser?.destroy?.().catch(() => undefined)
  }
}

function pdfReferenceNote(
  absPath: string,
  originalName: string,
  sizeBytes: number,
  pageCount: number | null,
  probeSkipped: boolean
): ProcessedAttachment {
  const pagesLabel =
    pageCount !== null
      ? `${pageCount.toLocaleString()} pages`
      : probeSkipped
        ? 'page count not probed at this size (pdf_info reports it)'
        : 'page count unreadable (possibly encrypted or corrupt — the PDF tools will report the exact error)'
  return {
    originalName,
    fileType: 'pdf',
    blocks: [
      {
        type: 'text',
        text:
          `[PDF attached: ${originalName} — ${pagesLabel}, ${sizeLabel(sizeBytes)} — not loaded into context]\n` +
          `Path: ${absPath}\n` +
          `This document is too large to inject whole, but every page is reachable through your PDF tools, and you are expected to actually consult it before answering anything about it:\n` +
          `- pdf_info: structure, outline, and text density (start here)\n` +
          `- pdf_search: exhaustive full-document text search with authoritative match counts\n` +
          `- pdf_read: exact text of any page range, e.g. pages="120-140"\n` +
          NEVER_SKIP_NOTE
      }
    ]
  }
}

async function processDocument(
  absPath: string,
  originalName: string,
  ext: string
): Promise<ProcessedAttachment> {
  const stat = await fs.stat(absPath)
  return documentReferenceNote(absPath, originalName, stat.size, ext)
}

/**
 * Per-format tool guidance. Small files get the one exact call that reads
 * them whole; big files get the traversal workflow plus the no-skip
 * contract. Guidance only ever names tools that actually exist for the
 * format: xlsx has no document_read support, and pptx is read through the
 * presentation capability rather than document_read.
 */
function documentReferenceNote(
  absPath: string,
  originalName: string,
  sizeBytes: number,
  ext: string
): ProcessedAttachment {
  const small = sizeBytes <= DOC_SMALL_MAX_BYTES
  let guidance: string
  if (ext === '.docx') {
    guidance = small
      ? `Read it in full with document_read before answering anything about its contents.`
      : `- document_read extracts the text (results are capped per call)\n` +
        `- For a document this size, document_convert it to .txt once, then search that file with rg and page through it with file_read startLine/endLine`
  } else if (ext === '.xlsx' || ext === '.xls') {
    guidance = small
      ? `Read it with spreadsheet_read before answering anything about its contents; use your spreadsheet/python tools for any analysis.`
      : `- spreadsheet_read pages through sheets; for real analysis (aggregation, stats, pivots) load it with your spreadsheet or python tools — never eyeball thousands of rows\n` +
        `- spreadsheet_convert to .csv turns it into plain text you can slice with shell tools (head, rg, awk)`
  } else if (ext === '.pptx') {
    guidance = small
      ? `Read it with presentation_read before answering anything about its contents — it returns every slide's text and speaker notes in order.`
      : `- presentation_read pages through the deck; pass from_slide/to_slide to work through a long one in batches\n` +
        `- Editing it? presentation_read FIRST, then presentation_modify (replace_text is exact-match), then presentation_validate`
  } else if (ext === '.csv' || ext === '.tsv') {
    guidance = small
      ? `Read it in full with file_read before answering anything about its contents; use your python or spreadsheet tools for any analysis.`
      : `- Slice it with shell tools first: head/tail for a preview, wc -l for row count, rg/awk for filtering\n` +
        `- For real analysis (aggregation, stats, pivots), load it with your python or spreadsheet tools — never eyeball thousands of rows\n` +
        `- file_read with startLine/endLine pages through any region exactly`
  } else {
    guidance = small
      ? `Read it in full with file_read before answering anything about its contents.`
      : `- file_read with startLine/endLine reads any exact line range\n` +
        `- Search it with your shell tool: rg -n "pattern" finds every occurrence with line numbers (authoritative counts), sed -n '100,160p' prints a range\n` +
        `- wc -lc gives you its true size before you plan the traversal`
  }

  const preamble = small
    ? ''
    : `This file is large, and all of it is reachable through your tools — you are expected to actually consult it before answering anything about it:\n`
  const tail = small ? '' : `\n${NEVER_SKIP_NOTE}`

  return {
    originalName,
    fileType: 'document',
    blocks: [
      {
        type: 'text',
        text:
          `[File attached: ${originalName} — ${sizeLabel(sizeBytes)} — not loaded into context]\n` +
          `Path: ${absPath}\n` +
          `${preamble}${guidance}${tail}`
      }
    ]
  }
}

/**
 * An uploaded archive is the one attachment where the RIGHT first move is
 * usually to ask. Nothing is unpacked (a zip can hold thousands of files and
 * gigabytes, and extracting is a side effect on the user's disk), so the note
 * names the archive tools and — crucially — tells the model to look before it
 * acts and to ask when the user's message didn't say what they want done.
 * Same 100% model-led contract as every other attachment: no content injected,
 * every byte reachable through tools.
 */
async function processArchive(absPath: string, originalName: string): Promise<ProcessedAttachment> {
  const stat = await fs.stat(absPath)
  return {
    originalName,
    fileType: 'archive',
    blocks: [
      {
        type: 'text',
        text:
          `[Archive attached: ${originalName} — ${sizeLabel(stat.size)} — nothing unpacked, no contents in context]\n` +
          `Path: ${absPath}\n` +
          `Work it with your archive tools — they need no shell and unpack nothing until you say so:\n` +
          `- archive_list reads only the index (entry paths, sizes, layout) — cheap at any size, and the ONLY way to know what is in here\n` +
          `- archive_read pulls one text file straight out of it, no extraction\n` +
          `- archive_extract unpacks everything, or just the entries you name, to a folder\n` +
          `Start with archive_list. Then: if the user's message already says what they want (unzip it, read the README, pull out the CSVs), do that. ` +
          `If it does not — an archive dropped in with no instructions — do NOT extract by default: tell them in one line what is inside and ask what they want done with it.\n` +
          NEVER_SKIP_NOTE
      }
    ]
  }
}

export type MessageAttachmentInput = {
  type: string
  filePath: string
  originalName: string
  mimeType: string
  sizeBytes: number
}

// Processed-attachment cache: processHistoryAttachments re-runs for EVERY
// user message with attachments on EVERY turn — without this, each turn
// re-runs the note probes (PDF page count = a full file read + xref parse,
// image dimensions = a header decode) for every attachment in the recent
// window. Keyed on (path, mtime, options) so a changed file re-probes;
// bounded LRU so entries don't accumulate.
const PROCESSED_CACHE_MAX = 60
const processedCache = new Map<string, ContentBlock[]>()

async function processAttachmentCached(
  att: MessageAttachmentInput,
  options: FileProcessorOptions
): Promise<ContentBlock[]> {
  let mtimeMs = 0
  const abs = await resolveUploadPath(att.filePath)
  if (abs) {
    try {
      mtimeMs = Math.floor((await fs.stat(abs)).mtimeMs)
    } catch {
      mtimeMs = 0
    }
  }
  const key = `${att.filePath}|${mtimeMs}|${options.supportsVision ? 1 : 0}`
  const hit = processedCache.get(key)
  if (hit) {
    // refresh LRU position
    processedCache.delete(key)
    processedCache.set(key, hit)
    return hit
  }
  const result = await processAttachment(att.filePath, att.mimeType, att.originalName, options)
  const blocks = result?.blocks ?? []
  processedCache.set(key, blocks)
  if (processedCache.size > PROCESSED_CACHE_MAX) {
    const oldest = processedCache.keys().next().value
    if (oldest !== undefined) processedCache.delete(oldest)
  }
  return blocks
}

export async function processAttachments(
  attachments: MessageAttachmentInput[],
  options: FileProcessorOptions
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = []

  for (const att of attachments) {
    blocks.push(...(await processAttachmentCached(att, options)))
  }

  return blocks
}
