import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PDFDocument, StandardFonts, rgb, degrees, PageSizes } from 'pdf-lib'

// NO size gates anywhere — the model decides what to operate on. Write ops
// (pdf-lib) attempt whatever they're given: they either succeed or surface
// pdf-lib's own error for the model to route around (python/shell). The
// known residual: pdf-lib inflates documents in RAM, so a multi-GB input
// could pressure the main process — accepted; refusing up front was worse.

const toolDefinitions = [
  {
    name: 'pdf_info',
    description:
      'Inspect a PDF before reading it: page count, file size, metadata, outline/bookmarks with page numbers, and sampled text density (detects scanned/image PDFs). Fast on any size — call this FIRST for documents longer than a few pages, then navigate with pdf_search and pdf_read.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the PDF file' }
      },
      required: ['path']
    }
  },
  {
    name: 'pdf_read',
    description:
      'Extract text from specific pages of a PDF. Reads ONLY the requested pages (lazy extraction with caching — a deep page in a 3,000-page PDF costs milliseconds). Without "pages" it returns just the first 5 pages and says how to continue; results are capped per call and the cap is always reported, never silently truncated. For whole-document questions, work through the document in ranges (e.g. "1-40", "41-80") or locate content with pdf_search first.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the PDF file' },
        pages: {
          type: 'string',
          description: 'Page selection like "12", "1-5", "80-" (to end), or "1-3,10,50-60"'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'pdf_search',
    description:
      'Search the text of a PDF exhaustively — EVERY page in scope is extracted and scanned, so the reported total match count is authoritative (0 means the text genuinely does not occur). Returns matches with page numbers and snippets, plus the distribution across pages. Works on any file size. Use this to locate content in large documents instead of paging through them; then pdf_read the matching pages. The FIRST search on a huge document does a one-time extraction that can take a while (tell the user before starting it); every search after is near-instant from cache.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the PDF file' },
        query: { type: 'string', description: 'Text to find (literal by default)' },
        regex: { type: 'boolean', description: 'Treat query as a regular expression' },
        case_sensitive: { type: 'boolean', description: 'Match case exactly (default false)' },
        pages: {
          type: 'string',
          description: 'Optional page scope like "1-500" (default: the whole document)'
        },
        max_results: {
          type: 'number',
          description: 'Max matches to display, 1-100 (default 40); the true total is always reported'
        }
      },
      required: ['path', 'query']
    }
  },
  {
    name: 'pdf_create',
    description: 'Create a new PDF with text, headings, images, tables, page numbers.',
    parameters: {
      type: 'object',
      properties: {
        output_path: { type: 'string', description: 'Absolute path for the output PDF' },
        content: { type: 'string', description: 'JSON array of content blocks' },
        options: { type: 'string', description: 'Optional JSON page options' }
      },
      required: ['output_path', 'content']
    }
  },
  {
    name: 'pdf_merge',
    description: 'Merge multiple PDF files into a single PDF.',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'string', description: 'JSON array of PDF paths' },
        output_path: { type: 'string', description: 'Absolute path for the merged PDF' },
        page_ranges: { type: 'string', description: 'Optional JSON array of page ranges per file' }
      },
      required: ['paths', 'output_path']
    }
  },
  {
    name: 'pdf_split',
    description: 'Split a PDF into multiple files by page ranges.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the source PDF' },
        ranges: { type: 'string', description: 'JSON array of page ranges' },
        output_dir: { type: 'string', description: 'Absolute path to output directory' }
      },
      required: ['path', 'ranges', 'output_dir']
    }
  },
  {
    name: 'pdf_modify',
    description: 'Add watermark, headers, footers, or page numbers to a PDF.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the source PDF' },
        output_path: { type: 'string', description: 'Absolute path for the output PDF' },
        modifications: { type: 'string', description: 'JSON object with modifications' }
      },
      required: ['path', 'output_path', 'modifications']
    }
  },
  {
    name: 'pdf_form',
    description: 'Read or fill form fields in a PDF.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the PDF' },
        action: { type: 'string', enum: ['read', 'fill'] },
        output_path: { type: 'string', description: 'Output path (required for fill)' },
        fields: { type: 'string', description: 'JSON object of field name->value pairs' }
      },
      required: ['path', 'action']
    }
  },
  {
    name: 'pdf_secure',
    description: 'Encrypt or decrypt a PDF with a password.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the source PDF' },
        output_path: { type: 'string', description: 'Absolute path for the output PDF' },
        action: { type: 'string', enum: ['encrypt', 'decrypt'] },
        password: { type: 'string', description: 'Password' },
        permissions: { type: 'string', description: 'Optional JSON array of permissions' }
      },
      required: ['path', 'output_path', 'action', 'password']
    }
  },
  {
    name: 'pdf_extract_images',
    description:
      'Save the photos/raster figures embedded in specific PDF pages as real PNG or JPEG files. ALWAYS pass "pages" — omitting it walks the whole document, which on a big book means thousands of files and a very long run. Skips sub-80px fragments by default. If a page reports no embedded images, its figure is vector art: use pdf_render_pages instead.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the PDF' },
        output_dir: { type: 'string', description: 'Directory to save extracted images' },
        pages: {
          type: 'string',
          description: 'Page selection like "84", "84-85", "1-3,10,50-60". Omit for every page.'
        },
        format: { type: 'string', enum: ['png', 'jpg'] },
        min_size: {
          type: 'number',
          description: 'Skip images narrower or shorter than this many pixels (default 80, 0 keeps everything)'
        }
      },
      required: ['path', 'output_dir']
    }
  },
  {
    name: 'pdf_render_pages',
    description:
      'Render whole PDF pages to PNG/JPEG images — the way to SHOW someone a figure, chart, algorithm, or scanned page. Works for vector figures, which pdf_extract_images cannot return because they are drawn rather than embedded. Page-scoped and fast on any file size.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the PDF' },
        pages: {
          type: 'string',
          description: 'Page selection like "84", "84-85", "1-3,10". Required.'
        },
        output_dir: { type: 'string', description: 'Directory to save the rendered pages' },
        scale: {
          type: 'number',
          description: 'Zoom factor; 1 = 72dpi, 2 = 144dpi (default), max 8. Raise it for small print.'
        },
        format: { type: 'string', enum: ['png', 'jpg'] }
      },
      required: ['path', 'pages', 'output_dir']
    }
  },
  {
    name: 'pdf_compress',
    description: 'Reduce PDF file size by removing unused objects.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the source PDF' },
        output_path: { type: 'string', description: 'Absolute path for the compressed PDF' },
        quality: { type: 'string', enum: ['low', 'medium', 'high'] }
      },
      required: ['path', 'output_path']
    }
  }
]

function parseJsonParam(value, name) {
  if (value == null) return undefined
  if (typeof value === 'object') return value
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch {
      throw new Error(`Invalid JSON in ${name} parameter`)
    }
  }
  throw new Error(`Expected object or JSON string for ${name}, got ${typeof value}`)
}

function resolvePath(input) {
  if (!input || typeof input !== 'string') throw new Error('path is required')
  if (input === '~') return os.homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2))
  }
  return path.resolve(input)
}

function parsePageRanges(rangeStr, totalPages) {
  if (!rangeStr) return Array.from({ length: totalPages }, (_, i) => i)
  const indices = []
  const parts = rangeStr.split(',').map((s) => s.trim())
  for (const part of parts) {
    if (part.includes('-')) {
      const [startStr, endStr] = part.split('-')
      const start = Math.max(1, parseInt(startStr, 10)) - 1
      const end = Math.min(totalPages, parseInt(endStr, 10)) - 1
      for (let i = start; i <= end; i++) indices.push(i)
    } else {
      const idx = parseInt(part, 10) - 1
      if (idx >= 0 && idx < totalPages) indices.push(idx)
    }
  }
  return indices
}

/** Existence probe (throws ENOENT early with a clean message); never a size gate. */
async function checkFileSize(filePath) {
  const stat = await fs.stat(filePath)
  return stat.size
}

function getPageSize(name) {
  const sizes = {
    A4: PageSizes.A4,
    Letter: PageSizes.Letter,
    Legal: PageSizes.Legal
  }
  return sizes[name] || PageSizes.A4
}

function parseColor(colorStr) {
  if (!colorStr) return rgb(0, 0, 0)
  if (colorStr.startsWith('#') && colorStr.length === 7) {
    const r = parseInt(colorStr.slice(1, 3), 16) / 255
    const g = parseInt(colorStr.slice(3, 5), 16) / 255
    const b = parseInt(colorStr.slice(5, 7), 16) / 255
    return rgb(r, g, b)
  }
  const named = { red: rgb(1, 0, 0), blue: rgb(0, 0, 1), green: rgb(0, 0.5, 0), gray: rgb(0.5, 0.5, 0.5), grey: rgb(0.5, 0.5, 0.5) }
  return named[colorStr.toLowerCase()] || rgb(0, 0, 0)
}

// ---------------------------------------------------------------------------
// Read-side engine: lazy per-page extraction with a page-text cache.
//
// A 3,000-page PDF extracts ~5-11M chars (~1.4-2.8M tokens) — no context
// window holds that, and extracting every page on every call is pure waste
// (measured: full extraction ~5s for 3k pages; a single lazy page ~4ms;
// doc open ~200ms). So: doc handles are transient per call, only the pages
// a call actually needs are extracted, and extracted text is cached across
// calls keyed by (path, size, mtime). pdf_search is the one deliberately
// exhaustive operation — it extracts ALL pages once (yielding to the event
// loop between batches so the app stays responsive), then every later
// search or read on that document is served from cache.
// ---------------------------------------------------------------------------

// The READ path (info/read/search) has NO size cap: model-led means the
// model reads whatever the user attached, and text extraction's footprint
// is a transient file buffer plus the cached page text — a 250MB two-volume
// textbook is a normal input here, not an edge case.
const READ_CHAR_BUDGET = 45_000 // per pdf_read call; keeps results under motor's 100k cap
const SEARCH_MAX_SHOWN = 40
const SEARCH_HARD_CAP = 100
const EXTRACT_YIELD_EVERY = 8 // pages between event-loop yields on bulk extraction
const PAGE_CACHE_MAX_DOCS = 3

/** absPath -> { size, mtimeMs, totalPages, pages: (string|undefined)[] } */
const pageCache = new Map()

async function statForCache(filePath) {
  return fs.stat(filePath)
}

function cacheEntryFor(filePath, stat, totalPages) {
  const hit = pageCache.get(filePath)
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
    // refresh LRU position
    pageCache.delete(filePath)
    pageCache.set(filePath, hit)
    return hit
  }
  const entry = {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    totalPages,
    pages: new Array(totalPages)
  }
  pageCache.delete(filePath)
  pageCache.set(filePath, entry)
  while (pageCache.size > PAGE_CACHE_MAX_DOCS) {
    const oldest = pageCache.keys().next().value
    if (oldest === undefined) break
    pageCache.delete(oldest)
  }
  return entry
}

let pdfAssetDirs

/**
 * pdf.js ships its own data files — base-14 font substitutes, CJK CMaps, ICC
 * profiles, and the wasm decoders (JPEG 2000, JBIG2) — and does NOT find them
 * on its own outside a browser. Without them: standard-font text renders wrong
 * or not at all, CJK and encoded text extracts as gibberish, and JPX images
 * fail to decode outright. In Node, pdf.js loads each one with
 * fs.readFile(url + filename), so these must be plain directory paths with a
 * trailing separator — NOT file:// URLs.
 *
 * The separator must be a literal '/' on EVERY platform, never path.sep.
 * pdf.js validates each of these with `val.endsWith("/")` and throws
 * `Invalid factory url: "…" must include trailing slash` otherwise — so on
 * Windows a path.sep-terminated path killed every read, search and render in
 * this plugin while POSIX (where path.sep IS '/') looked perfectly healthy.
 * A trailing '/' after Windows backslashes is safe: pdf.js only concatenates
 * the filename onto it and hands the result to fs.readFile, which accepts
 * mixed separators on Windows.
 *
 * Best-effort: if the layout ever moves, reading still works exactly as it did
 * before, just without the extras.
 */
function pdfAssetOptions() {
  if (pdfAssetDirs !== undefined) return pdfAssetDirs
  pdfAssetDirs = {}
  try {
    const entry = fileURLToPath(import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'))
    const root = path.dirname(path.dirname(path.dirname(entry))) // …/build → …/legacy → …/pdfjs-dist
    const dir = (name) => `${path.join(root, name)}/`
    const dirs = {
      standardFontDataUrl: dir('standard_fonts'),
      cMapUrl: dir('cmaps'),
      cMapPacked: true,
      iccUrl: dir('iccs'),
      wasmUrl: dir('wasm')
    }
    // Re-assert pdf.js's own invariant before handing these over. If a future
    // path change ever violates it again, degrade to the built-in behaviour
    // (slightly worse text/image fidelity) instead of throwing on every call.
    const urls = Object.entries(dirs).filter(([, v]) => typeof v === 'string')
    if (urls.every(([, v]) => v.endsWith('/'))) pdfAssetDirs = dirs
  } catch {
    // leave empty — pdf.js falls back to its built-in behaviour
  }
  return pdfAssetDirs
}

/** Open a transient pdf-parse handle. Caller MUST call destroy() (use try/finally). */
async function openPdf(filePath) {
  const buffer = await fs.readFile(filePath).catch((err) => {
    if (err.code === 'ENOENT') throw new Error(`File not found: ${filePath}`)
    if (err.code === 'EBUSY' || err.code === 'EPERM')
      throw new Error('File is open in another application')
    throw err
  })
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: new Uint8Array(buffer), ...pdfAssetOptions() })
  await parser.load()
  if (!parser.doc || !parser.doc.numPages) throw new Error('PDF has no readable pages')
  return parser
}

/** Extract one page's text preserving line breaks where pdf.js reports them. */
async function extractPageText(doc, pageNumber) {
  const page = await doc.getPage(pageNumber)
  const content = await page.getTextContent()
  let out = ''
  for (const item of content.items) {
    out += item.str
    out += item.hasEOL ? '\n' : ' '
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim()
}

/**
 * Ensure the given 1-based page numbers are extracted into the cache entry.
 * Yields to the event loop every few pages so a bulk extraction (search over
 * thousands of pages) never freezes the app.
 */
async function ensurePages(doc, entry, pageNumbers) {
  let sinceYield = 0
  for (const p of pageNumbers) {
    if (entry.pages[p - 1] !== undefined) continue
    entry.pages[p - 1] = await extractPageText(doc, p)
    sinceYield++
    if (sinceYield >= EXTRACT_YIELD_EVERY) {
      sinceYield = 0
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
}

/** Parse "1-3,5,80-" into sorted unique 1-based page numbers, clamped to the doc. */
function parsePageSelection(rangeStr, totalPages) {
  if (!rangeStr || !String(rangeStr).trim()) return null
  const selected = new Set()
  for (const rawPart of String(rangeStr).split(',')) {
    const part = rawPart.trim()
    if (!part) continue
    const m = /^(\d+)?\s*-\s*(\d+)?$/.exec(part)
    if (m && (m[1] || m[2])) {
      const start = Math.max(1, m[1] ? parseInt(m[1], 10) : 1)
      const end = Math.min(totalPages, m[2] ? parseInt(m[2], 10) : totalPages)
      for (let i = start; i <= end; i++) selected.add(i)
      continue
    }
    const single = parseInt(part, 10)
    if (Number.isFinite(single) && single >= 1 && single <= totalPages) selected.add(single)
  }
  if (selected.size === 0) {
    throw new Error(
      `Invalid page selection "${rangeStr}". Use forms like "12", "1-5", "80-" (to end), or "1-3,10,50-60". This document has ${totalPages} pages.`
    )
  }
  return [...selected].sort((a, b) => a - b)
}

function describePageList(pages) {
  if (pages.length === 0) return 'none'
  const runs = []
  let runStart = pages[0]
  let prev = pages[0]
  for (let i = 1; i <= pages.length; i++) {
    const cur = pages[i]
    if (cur !== prev + 1) {
      runs.push(runStart === prev ? `${runStart}` : `${runStart}-${prev}`)
      runStart = cur
    }
    prev = cur
  }
  return runs.join(', ')
}

async function pdfRead(args) {
  const filePath = resolvePath(args.path)
  let parser
  try {
    const stat = await statForCache(filePath)
    parser = await openPdf(filePath)
    const doc = parser.doc
    const totalPages = doc.numPages
    const entry = cacheEntryFor(filePath, stat, totalPages)

    let requested = parsePageSelection(args.pages, totalPages)
    let defaulted = false
    if (!requested) {
      // No range given: never dump the whole document. Serve the first pages
      // and tell the model exactly how to continue.
      requested = []
      for (let i = 1; i <= Math.min(5, totalPages); i++) requested.push(i)
      defaulted = totalPages > 5
    }

    // Fill the cache for requested pages, honoring the per-call char budget.
    const served = []
    let servedChars = 0
    let budgetStopPage = null
    for (const p of requested) {
      await ensurePages(doc, entry, [p])
      const text = entry.pages[p - 1] ?? ''
      if (served.length > 0 && servedChars + text.length > READ_CHAR_BUDGET) {
        budgetStopPage = p
        break
      }
      served.push(p)
      servedChars += text.length
    }

    const sections = served.map((p) => {
      const text = entry.pages[p - 1] ?? ''
      return `--- Page ${p} of ${totalPages} ---\n${text.length > 0 ? text : '(no extractable text on this page)'}`
    })

    const footer = []
    footer.push(
      `[Read ${served.length} page${served.length === 1 ? '' : 's'} (${describePageList(served)}) of ${totalPages} total — ${servedChars.toLocaleString()} chars.]`
    )
    if (defaulted) {
      footer.push(
        `[No "pages" given, so only the first ${served.length} pages were returned. Pass pages="6-10" etc. to continue, pdf_search to find content, or pdf_info for structure.]`
      )
    }
    if (budgetStopPage !== null) {
      const remaining = requested.filter((p) => !served.includes(p))
      footer.push(
        `[Stopped at the per-call size limit before page ${budgetStopPage}. Not yet returned from your selection: pages ${describePageList(remaining)} — call pdf_read again with that range to continue. Nothing was skipped silently.]`
      )
    }

    return { success: true, output: `${sections.join('\n\n')}\n\n${footer.join('\n')}` }
  } catch (err) {
    return { success: false, error: `Failed to read PDF: ${err.message}` }
  } finally {
    if (parser) await parser.destroy?.().catch(() => undefined)
  }
}

function buildSnippet(pageText, matchIndex, matchLength) {
  const RADIUS = 110
  const start = Math.max(0, matchIndex - RADIUS)
  const end = Math.min(pageText.length, matchIndex + matchLength + RADIUS)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < pageText.length ? '…' : ''
  const snippet = pageText.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${prefix}${snippet}${suffix}`
}

async function pdfSearch(args) {
  const filePath = resolvePath(args.path)
  const rawQuery = typeof args.query === 'string' ? args.query : ''
  if (!rawQuery.trim()) return { success: false, error: 'query is required and must be non-empty' }

  const caseSensitive = args.case_sensitive === true || args.case_sensitive === 'true'
  const isRegex = args.regex === true || args.regex === 'true'
  let pattern
  try {
    const source = isRegex ? rawQuery : rawQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    pattern = new RegExp(source, caseSensitive ? 'g' : 'gi')
  } catch (err) {
    return { success: false, error: `Invalid regex: ${err.message}` }
  }

  const maxShownRaw = parseInt(args.max_results, 10)
  const maxShown = Number.isFinite(maxShownRaw)
    ? Math.min(Math.max(1, maxShownRaw), SEARCH_HARD_CAP)
    : SEARCH_MAX_SHOWN

  let parser
  try {
    const stat = await statForCache(filePath)
    parser = await openPdf(filePath)
    const doc = parser.doc
    const totalPages = doc.numPages
    const entry = cacheEntryFor(filePath, stat, totalPages)

    const scope = parsePageSelection(args.pages, totalPages) ??
      Array.from({ length: totalPages }, (_, i) => i + 1)

    // Exhaustive by design: every page in scope is extracted and scanned.
    await ensurePages(doc, entry, scope)

    let totalMatches = 0
    const perPageCounts = new Map()
    const shown = []
    for (const p of scope) {
      const text = entry.pages[p - 1] ?? ''
      pattern.lastIndex = 0
      let m
      while ((m = pattern.exec(text)) !== null) {
        totalMatches++
        perPageCounts.set(p, (perPageCounts.get(p) ?? 0) + 1)
        if (shown.length < maxShown) {
          shown.push({ page: p, snippet: buildSnippet(text, m.index, m[0].length || 1) })
        }
        if (m[0].length === 0) pattern.lastIndex++ // zero-width match guard
      }
    }

    const scopeLabel =
      scope.length === totalPages
        ? `all ${totalPages} pages`
        : `pages ${describePageList(scope)} (${scope.length} of ${totalPages} pages)`

    const lines = []
    lines.push(
      `Searched ${scopeLabel} of ${path.basename(filePath)} for ${isRegex ? `regex /${rawQuery}/` : `"${rawQuery}"`}${caseSensitive ? ' (case-sensitive)' : ''}.`
    )
    lines.push(`Total matches: ${totalMatches} across ${perPageCounts.size} page${perPageCounts.size === 1 ? '' : 's'}. Every page in scope was fully scanned — a count of 0 means the text truly does not occur there.`)

    if (totalMatches > 0) {
      lines.push('')
      for (const s of shown) lines.push(`p.${s.page}: ${s.snippet}`)
      if (totalMatches > shown.length) {
        const topPages = [...perPageCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([p, n]) => `p.${p}×${n}`)
          .join(', ')
        lines.push('')
        lines.push(
          `[Showing first ${shown.length} of ${totalMatches} matches. Distribution (top pages): ${topPages}. Narrow with the "pages" parameter or a more specific query, then pdf_read the relevant pages.]`
        )
      }
    }

    return { success: true, output: lines.join('\n') }
  } catch (err) {
    return { success: false, error: `Failed to search PDF: ${err.message}` }
  } finally {
    if (parser) await parser.destroy?.().catch(() => undefined)
  }
}

async function resolveOutline(doc, maxEntries) {
  const outline = await doc.getOutline?.().catch(() => null)
  if (!outline || outline.length === 0) return []
  const flat = []
  const walk = async (items, depth) => {
    for (const item of items) {
      if (flat.length >= maxEntries) return
      let pageNumber = null
      try {
        let dest = item.dest
        if (typeof dest === 'string') dest = await doc.getDestination(dest)
        if (Array.isArray(dest) && dest[0]) {
          pageNumber = (await doc.getPageIndex(dest[0])) + 1
        }
      } catch {
        pageNumber = null
      }
      flat.push({ depth, title: String(item.title ?? '').trim(), page: pageNumber })
      if (item.items?.length && depth < 3) await walk(item.items, depth + 1)
    }
  }
  await walk(outline, 1)
  return flat
}

async function pdfInfo(args) {
  const filePath = resolvePath(args.path)
  let parser
  try {
    const stat = await statForCache(filePath)
    parser = await openPdf(filePath)
    const doc = parser.doc
    const totalPages = doc.numPages
    const entry = cacheEntryFor(filePath, stat, totalPages)

    const info = parser.getInfo?.() || {}
    const meta = [
      info.Title ? `title: ${info.Title}` : null,
      info.Author ? `author: ${info.Author}` : null,
      info.Subject ? `subject: ${info.Subject}` : null,
      info.Producer ? `producer: ${info.Producer}` : null
    ].filter(Boolean)

    // Sample up to 24 evenly spaced pages for text density — enough to tell
    // a text PDF from a scanned one without extracting the whole document.
    const sampleCount = Math.min(24, totalPages)
    const samplePages = []
    for (let i = 0; i < sampleCount; i++) {
      samplePages.push(1 + Math.floor((i * (totalPages - 1)) / Math.max(1, sampleCount - 1)))
    }
    const uniqueSamples = [...new Set(samplePages)]
    await ensurePages(doc, entry, uniqueSamples)
    let sampledChars = 0
    let emptySampled = 0
    for (const p of uniqueSamples) {
      const len = (entry.pages[p - 1] ?? '').length
      sampledChars += len
      if (len < 20) emptySampled++
    }
    const avgChars = Math.round(sampledChars / uniqueSamples.length)
    const estimatedTotalChars = avgChars * totalPages

    const outlineEntries = await resolveOutline(doc, 60)

    const lines = []
    lines.push(`${path.basename(filePath)} — ${totalPages} pages, ${(stat.size / 1024 / 1024).toFixed(1)}MB`)
    if (meta.length > 0) lines.push(meta.join(' | '))
    lines.push(
      `Text density: about ${avgChars.toLocaleString()} chars/page (sampled ${uniqueSamples.length} pages evenly), roughly ${estimatedTotalChars.toLocaleString()} chars (~${Math.round(estimatedTotalChars / 4).toLocaleString()} tokens) across the whole document.`
    )
    if (emptySampled > uniqueSamples.length / 2) {
      lines.push(
        `WARNING: ${emptySampled} of ${uniqueSamples.length} sampled pages have no extractable text — this is likely a scanned/image PDF. Text tools cannot see its content; tell the user plainly instead of guessing, and consider pdf_extract_images plus OCR.`
      )
    }
    if (outlineEntries.length > 0) {
      lines.push('')
      lines.push('Outline:')
      for (const o of outlineEntries) {
        lines.push(`${'  '.repeat(o.depth - 1)}- ${o.title}${o.page ? ` (p.${o.page})` : ''}`)
      }
    } else {
      lines.push('No embedded outline/bookmarks.')
    }
    lines.push('')
    lines.push(
      `Navigate it with pdf_search (exhaustive across all pages) and pdf_read with page ranges — never assume content you have not read or searched.`
    )

    return { success: true, output: lines.join('\n') }
  } catch (err) {
    return { success: false, error: `Failed to inspect PDF: ${err.message}` }
  } finally {
    if (parser) await parser.destroy?.().catch(() => undefined)
  }
}

async function pdfCreate(args) {
  const outputPath = resolvePath(args.output_path)
  let content, options
  try {
    content = parseJsonParam(args.content, 'content')
  } catch (err) {
    return { success: false, error: err.message }
  }
  try {
    options = args.options ? parseJsonParam(args.options, 'options') : {}
  } catch (err) {
    return { success: false, error: err.message }
  }

  try {
    const pdfDoc = await PDFDocument.create()
    const pageSize = getPageSize(options.page_size || 'A4')
    const isLandscape = options.orientation === 'landscape'
    const [baseW, baseH] = pageSize
    const [pageW, pageH] = isLandscape ? [baseH, baseW] : [baseW, baseH]
    const margins = options.margins || { top: 72, bottom: 72, left: 72, right: 72 }
    const fontSize = options.font_size || 12
    const lineHeight = options.line_height || 1.5

    let font
    if (options.font_path) {
      try {
        const fontBytes = await fs.readFile(resolvePath(options.font_path))
        font = await pdfDoc.embedFont(fontBytes)
      } catch {
        font = await pdfDoc.embedFont(StandardFonts.Helvetica)
      }
    } else {
      font = await pdfDoc.embedFont(StandardFonts.Helvetica)
    }
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

    let currentPage = pdfDoc.addPage([pageW, pageH])
    let yPos = pageH - margins.top
    const contentWidth = pageW - margins.left - margins.right

    function ensureSpace(needed) {
      if (yPos - needed < margins.bottom) {
        currentPage = pdfDoc.addPage([pageW, pageH])
        yPos = pageH - margins.top
      }
    }

    function drawWrappedText(text, textFont, textSize, x, maxWidth, options = {}) {
      const words = text.split(' ')
      let line = ''
      const lines = []
      for (const word of words) {
        const testLine = line ? `${line} ${word}` : word
        const width = textFont.widthOfTextAtSize(testLine, textSize)
        if (width > maxWidth && line) {
          lines.push(line)
          line = word
        } else {
          line = testLine
        }
      }
      if (line) lines.push(line)

      for (const l of lines) {
        const lHeight = textSize * lineHeight
        ensureSpace(lHeight)
        let drawX = x
        if (options.alignment === 'center') {
          const lWidth = textFont.widthOfTextAtSize(l, textSize)
          drawX = x + (maxWidth - lWidth) / 2
        } else if (options.alignment === 'right') {
          const lWidth = textFont.widthOfTextAtSize(l, textSize)
          drawX = x + maxWidth - lWidth
        }
        currentPage.drawText(l, {
          x: drawX,
          y: yPos,
          size: textSize,
          font: textFont,
          color: options.color || rgb(0, 0, 0)
        })
        yPos -= lHeight
      }
    }

    for (const block of content) {
      switch (block.type) {
        case 'heading': {
          const level = block.level || 1
          const headingSizes = { 1: 24, 2: 20, 3: 16 }
          const hSize = headingSizes[level] || 14
          const spacing = hSize * 0.8
          ensureSpace(hSize + spacing)
          yPos -= spacing / 2
          drawWrappedText(block.text || '', boldFont, hSize, margins.left, contentWidth, { alignment: block.alignment })
          yPos -= spacing / 2
          break
        }
        case 'paragraph': {
          const pSize = block.fontSize || fontSize
          const pFont = block.bold ? boldFont : font
          drawWrappedText(block.text || '', pFont, pSize, margins.left, contentWidth, { alignment: block.alignment })
          yPos -= pSize * 0.5
          break
        }
        case 'image': {
          if (block.path) {
            try {
              const imgPath = resolvePath(block.path)
              const imgBytes = await fs.readFile(imgPath)
              let image
              const ext = path.extname(imgPath).toLowerCase()
              if (ext === '.png') {
                image = await pdfDoc.embedPng(imgBytes)
              } else {
                image = await pdfDoc.embedJpg(imgBytes)
              }
              const imgWidth = block.width || Math.min(image.width, contentWidth)
              const scale = imgWidth / image.width
              const imgHeight = block.height || image.height * scale
              ensureSpace(imgHeight)
              currentPage.drawImage(image, {
                x: margins.left,
                y: yPos - imgHeight,
                width: imgWidth,
                height: imgHeight
              })
              yPos -= imgHeight + 10
            } catch (err) {
              drawWrappedText(`[Image error: ${err.message}]`, font, fontSize, margins.left, contentWidth)
            }
          }
          break
        }
        case 'table': {
          const headers = block.headers || []
          const rows = block.rows || []
          const colCount = headers.length || (rows[0] ? rows[0].length : 0)
          if (colCount === 0) break
          const colWidth = contentWidth / colCount
          const rowHeight = fontSize * 2
          const totalRows = (headers.length ? 1 : 0) + rows.length
          ensureSpace(rowHeight * Math.min(totalRows, 3))

          if (headers.length) {
            for (let i = 0; i < headers.length; i++) {
              currentPage.drawText(String(headers[i]).slice(0, 40), {
                x: margins.left + i * colWidth + 4,
                y: yPos - fontSize,
                size: fontSize,
                font: boldFont
              })
            }
            yPos -= rowHeight
          }
          for (const row of rows) {
            ensureSpace(rowHeight)
            for (let i = 0; i < Math.min(row.length, colCount); i++) {
              currentPage.drawText(String(row[i]).slice(0, 40), {
                x: margins.left + i * colWidth + 4,
                y: yPos - fontSize,
                size: fontSize,
                font
              })
            }
            yPos -= rowHeight
          }
          yPos -= 10
          break
        }
        case 'page_break': {
          currentPage = pdfDoc.addPage([pageW, pageH])
          yPos = pageH - margins.top
          break
        }
        case 'header': {
          const pages = pdfDoc.getPages()
          for (const pg of pages) {
            pg.drawText(block.text || '', {
              x: margins.left,
              y: pageH - 30,
              size: block.fontSize || 9,
              font,
              color: rgb(0.4, 0.4, 0.4)
            })
          }
          break
        }
        case 'footer': {
          const pages = pdfDoc.getPages()
          for (const pg of pages) {
            pg.drawText(block.text || '', {
              x: margins.left,
              y: 30,
              size: block.fontSize || 9,
              font,
              color: rgb(0.4, 0.4, 0.4)
            })
          }
          break
        }
      }
    }

    if (options.page_numbers) {
      const pages = pdfDoc.getPages()
      const total = pages.length
      for (let i = 0; i < total; i++) {
        const pg = pages[i]
        const format = (options.page_numbers.format || 'Page {n} of {total}')
          .replace('{n}', String(i + 1))
          .replace('{total}', String(total))
        const numFont = font
        const numSize = options.page_numbers.fontSize || 9
        const textWidth = numFont.widthOfTextAtSize(format, numSize)
        let x = pageW / 2 - textWidth / 2
        if (options.page_numbers.position === 'bottom-right') {
          x = pageW - margins.right - textWidth
        }
        pg.drawText(format, { x, y: 20, size: numSize, font: numFont, color: rgb(0.4, 0.4, 0.4) })
      }
    }

    const pdfBytes = await pdfDoc.save()
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, pdfBytes)

    return {
      success: true,
      output: JSON.stringify({
        path: outputPath,
        pages: pdfDoc.getPageCount(),
        size: pdfBytes.length
      })
    }
  } catch (err) {
    return { success: false, error: `Failed to create PDF: ${err.message}` }
  }
}

async function pdfMerge(args) {
  let paths, pageRanges
  try {
    paths = parseJsonParam(args.paths, 'paths')
  } catch (err) {
    return { success: false, error: err.message }
  }
  try {
    pageRanges = args.page_ranges ? parseJsonParam(args.page_ranges, 'page_ranges') : null
  } catch (err) {
    return { success: false, error: err.message }
  }

  const outputPath = resolvePath(args.output_path)
  const tempFiles = []

  try {
    const mergedDoc = await PDFDocument.create()

    for (let i = 0; i < paths.length; i++) {
      const filePath = resolvePath(paths[i])
      await checkFileSize(filePath)
      const bytes = await fs.readFile(filePath)
      const srcDoc = await PDFDocument.load(bytes)
      const totalPages = srcDoc.getPageCount()
      const rangeStr = pageRanges ? pageRanges[i] || '' : ''
      const indices = rangeStr ? parsePageRanges(rangeStr, totalPages) : Array.from({ length: totalPages }, (_, j) => j)
      const copiedPages = await mergedDoc.copyPages(srcDoc, indices)
      for (const page of copiedPages) {
        mergedDoc.addPage(page)
      }
    }

    const mergedBytes = await mergedDoc.save()
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, mergedBytes)

    return {
      success: true,
      output: JSON.stringify({
        path: outputPath,
        pages: mergedDoc.getPageCount(),
        size: mergedBytes.length,
        sources: paths.length
      })
    }
  } catch (err) {
    return { success: false, error: `Failed to merge PDFs: ${err.message}` }
  } finally {
    for (const f of tempFiles) {
      try { await fs.unlink(f) } catch {}
    }
  }
}

async function pdfSplit(args) {
  const filePath = resolvePath(args.path)
  const outputDir = resolvePath(args.output_dir)
  let ranges
  try {
    ranges = parseJsonParam(args.ranges, 'ranges')
  } catch (err) {
    return { success: false, error: err.message }
  }

  try {
    await checkFileSize(filePath)
    const bytes = await fs.readFile(filePath)
    const srcDoc = await PDFDocument.load(bytes)
    const totalPages = srcDoc.getPageCount()
    await fs.mkdir(outputDir, { recursive: true })

    const outputs = []
    for (let i = 0; i < ranges.length; i++) {
      const indices = parsePageRanges(ranges[i], totalPages)
      const newDoc = await PDFDocument.create()
      const copiedPages = await newDoc.copyPages(srcDoc, indices)
      for (const page of copiedPages) {
        newDoc.addPage(page)
      }
      const newBytes = await newDoc.save()
      const baseName = path.basename(filePath, '.pdf')
      const outPath = path.join(outputDir, `${baseName}_part${i + 1}.pdf`)
      await fs.writeFile(outPath, newBytes)
      outputs.push({ path: outPath, pages: newDoc.getPageCount(), size: newBytes.length })
    }

    return {
      success: true,
      output: JSON.stringify({ files: outputs, totalParts: outputs.length })
    }
  } catch (err) {
    return { success: false, error: `Failed to split PDF: ${err.message}` }
  }
}

async function pdfModify(args) {
  const filePath = resolvePath(args.path)
  const outputPath = resolvePath(args.output_path)
  let modifications
  try {
    modifications = parseJsonParam(args.modifications, 'modifications')
  } catch (err) {
    return { success: false, error: err.message }
  }

  try {
    await checkFileSize(filePath)
    const bytes = await fs.readFile(filePath)
    const pdfDoc = await PDFDocument.load(bytes)
    const pages = pdfDoc.getPages()
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica)

    if (modifications.watermark) {
      const wm = modifications.watermark
      const wmText = wm.text || 'WATERMARK'
      const wmSize = wm.fontSize || 60
      const wmOpacity = wm.opacity ?? 0.3
      const wmRotation = wm.rotation ?? 45
      const wmColor = parseColor(wm.color)

      for (const page of pages) {
        const { width, height } = page.getSize()
        const textWidth = font.widthOfTextAtSize(wmText, wmSize)
        page.drawText(wmText, {
          x: width / 2 - textWidth / 2,
          y: height / 2,
          size: wmSize,
          font,
          color: wmColor,
          opacity: wmOpacity,
          rotate: degrees(wmRotation)
        })
      }
    }

    if (modifications.header) {
      const h = modifications.header
      for (const page of pages) {
        const { height } = page.getSize()
        page.drawText(h.text || '', {
          x: 72,
          y: height - 30,
          size: h.fontSize || 9,
          font,
          color: rgb(0.3, 0.3, 0.3)
        })
      }
    }

    if (modifications.footer) {
      const f = modifications.footer
      for (const page of pages) {
        page.drawText(f.text || '', {
          x: 72,
          y: 30,
          size: f.fontSize || 9,
          font,
          color: rgb(0.3, 0.3, 0.3)
        })
      }
    }

    if (modifications.page_numbers) {
      const pn = modifications.page_numbers
      const total = pages.length
      for (let i = 0; i < total; i++) {
        const page = pages[i]
        const { width } = page.getSize()
        const format = (pn.format || 'Page {n} of {total}')
          .replace('{n}', String(i + 1))
          .replace('{total}', String(total))
        const numSize = pn.fontSize || 9
        const textWidth = font.widthOfTextAtSize(format, numSize)
        let x = width / 2 - textWidth / 2
        if (pn.position === 'bottom-right') {
          x = width - 72 - textWidth
        }
        page.drawText(format, { x, y: 20, size: numSize, font, color: rgb(0.3, 0.3, 0.3) })
      }
    }

    const modifiedBytes = await pdfDoc.save()
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, modifiedBytes)

    return {
      success: true,
      output: JSON.stringify({
        path: outputPath,
        pages: pages.length,
        size: modifiedBytes.length,
        applied: Object.keys(modifications)
      })
    }
  } catch (err) {
    return { success: false, error: `Failed to modify PDF: ${err.message}` }
  }
}

async function pdfForm(args) {
  const filePath = resolvePath(args.path)

  try {
    await checkFileSize(filePath)
    const bytes = await fs.readFile(filePath)
    const pdfDoc = await PDFDocument.load(bytes)
    const form = pdfDoc.getForm()

    if (args.action === 'read') {
      const fields = form.getFields()
      const fieldData = fields.map((field) => {
        const name = field.getName()
        const type = field.constructor.name
        let value = null
        try {
          if (field.getText) value = field.getText()
          else if (field.isChecked) value = field.isChecked()
          else if (field.getSelected) value = field.getSelected()
        } catch {}
        return { name, type, value }
      })
      return { success: true, output: JSON.stringify({ fields: fieldData, count: fieldData.length }) }
    }

    if (args.action === 'fill') {
      if (!args.output_path) return { success: false, error: 'output_path required for fill action' }
      if (!args.fields) return { success: false, error: 'fields required for fill action' }

      let fields
      try {
        fields = parseJsonParam(args.fields, 'fields')
      } catch (err) {
        return { success: false, error: err.message }
      }

      for (const [name, value] of Object.entries(fields)) {
        try {
          const field = form.getTextField(name)
          field.setText(String(value))
        } catch {
          try {
            const field = form.getCheckBox(name)
            if (value) field.check()
            else field.uncheck()
          } catch {
            try {
              const field = form.getDropdown(name)
              field.select(String(value))
            } catch {}
          }
        }
      }

      const outputPath = resolvePath(args.output_path)
      const filledBytes = await pdfDoc.save()
      await fs.mkdir(path.dirname(outputPath), { recursive: true })
      await fs.writeFile(outputPath, filledBytes)

      return {
        success: true,
        output: JSON.stringify({ path: outputPath, filledFields: Object.keys(fields).length })
      }
    }

    return { success: false, error: `Unknown action: ${args.action}` }
  } catch (err) {
    return { success: false, error: `Form operation failed: ${err.message}` }
  }
}

async function pdfSecure(args) {
  const filePath = resolvePath(args.path)
  const outputPath = resolvePath(args.output_path)

  try {
    await checkFileSize(filePath)
    const bytes = await fs.readFile(filePath)

    if (args.action === 'encrypt') {
      const pdfDoc = await PDFDocument.load(bytes)
      const encryptedBytes = await pdfDoc.save({
        userPassword: args.password,
        ownerPassword: args.password
      })
      await fs.mkdir(path.dirname(outputPath), { recursive: true })
      await fs.writeFile(outputPath, encryptedBytes)
      return {
        success: true,
        output: JSON.stringify({ path: outputPath, action: 'encrypted', size: encryptedBytes.length })
      }
    }

    if (args.action === 'decrypt') {
      const pdfDoc = await PDFDocument.load(bytes, { password: args.password })
      const decryptedBytes = await pdfDoc.save()
      await fs.mkdir(path.dirname(outputPath), { recursive: true })
      await fs.writeFile(outputPath, decryptedBytes)
      return {
        success: true,
        output: JSON.stringify({ path: outputPath, action: 'decrypted', size: decryptedBytes.length })
      }
    }

    return { success: false, error: `Unknown action: ${args.action}` }
  } catch (err) {
    if (err.message.includes('password')) {
      return { success: false, error: 'Incorrect password or password-protected PDF' }
    }
    return { success: false, error: `Security operation failed: ${err.message}` }
  }
}

// ---------------------------------------------------------------------------
// Raster side: image extraction and page rendering.
//
// Both run on the SAME pdf.js engine as the read path (pdf-parse), never on
// pdf-lib. Three reasons, all measured on a real 250MB, 3,000+ page book with
// over half a million indirect objects and tens of thousands of images:
//
//  1. CORRECTNESS. pdf-lib has no image API. The old extractor walked every
//     indirect object and wrote each image stream's RAW bytes to "<n>.png" —
//     but a PDF image stream is not a PNG, it is the *encoded samples*
//     (FlateDecode zlib, DCTDecode JPEG, CCITT/JBIG2 fax, JPX...). Naming zlib
//     output ".png" yields a file nothing can open. On that book it wrote
//     over 32,000 files of which ZERO were valid images. pdf.js DECODES to pixels;
//     the canvas re-encodes to a real PNG/JPEG.
//  2. SCOPE. pdf-lib has to inflate the whole document before it can enumerate
//     anything, so there was no way to ask for one page — every call did the
//     entire book (~13s of parse into a 1.3GB heap, then tens of thousands of
//     individual file writes, which is where the wall-clock really goes; on
//     Windows with real-time AV scanning that alone runs for hours). pdf.js
//     parses lazily: rendering one page of that same book takes ~0.3s.
//  3. NOTHING TO SHOW ANYWAY. A typeset figure is usually DRAWN — vectors and
//     text — so extraction returns nothing for it no matter how well it works.
//     That is why pdf_render_pages exists and why extraction points at it.
//
// So everything here is page-at-a-time: decode one page, write its images,
// release the page, yield to the event loop, check the abort signal, repeat.
// Nothing accumulates across pages except a short manifest of what was written.
// ---------------------------------------------------------------------------

const IMAGE_MIN_SIZE_DEFAULT = 80 // px; below this it's a glyph/rule/bullet, not a figure
const IMAGE_RESOLVE_TIMEOUT_MS = 20_000
const RENDER_SCALE_DEFAULT = 2 // 144 dpi — legible for figures without huge files
const RENDER_SCALE_MAX = 8
const RASTER_LIST_LIMIT = 50 // files named in the result; the rest are counted

let pdfjsPromise

/**
 * pdf.js, imported through the SAME specifier pdf-parse uses so Node's module
 * cache hands back one shared instance. It's a transitive dependency of
 * pdf-parse (hoisted into this capability's node_modules) and deliberately NOT
 * declared in package.json: adding a dep changes the install marker and forces
 * an `npm install` on next use, which would break this tool for anyone offline.
 */
function loadPdfjs() {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs').catch((err) => {
    pdfjsPromise = undefined
    throw new Error(
      `pdf.js unavailable (${err.message}). Delete this capability's node_modules directory so its dependencies reinstall.`
    )
  })
  return pdfjsPromise
}

let canvasModulePromise

/** A drawing surface pdf.js can render onto. Caller MUST call release(). */
async function createRasterCanvas(doc, width, height) {
  const w = Math.max(1, Math.ceil(width))
  const h = Math.max(1, Math.ceil(height))
  const factory = doc?.canvasFactory
  if (typeof factory?.create === 'function') {
    const made = factory.create(w, h)
    return { canvas: made.canvas, context: made.context, release: () => factory.destroy?.(made) }
  }
  canvasModulePromise ??= import('@napi-rs/canvas')
  const { createCanvas } = await canvasModulePromise
  const canvas = createCanvas(w, h)
  return { canvas, context: canvas.getContext('2d'), release: () => undefined }
}

function encodeCanvas(canvas, format) {
  const ext = format === 'jpg' ? 'jpg' : 'png'
  const raw = canvas.toBuffer(ext === 'jpg' ? 'image/jpeg' : 'image/png')
  return { buffer: Buffer.isBuffer(raw) ? raw : Buffer.from(raw), ext }
}

/** Let the Electron main process serve IPC/paint between units of work. */
function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Which object store holds an image, by pdf.js's own rule: ids minted for a
 * document-wide (multi-page) image are prefixed "g_" and land in commonObjs,
 * everything else is page-local. Do NOT decide this with `has()` — that only
 * reports what has already SETTLED, so a shared image still in flight looks
 * absent from commonObjs, and asking page.objs for it registers a callback
 * against data that will never arrive there: a permanent hang.
 */
function storeFor(page, name) {
  return name.startsWith('g_') ? page.commonObjs : page.objs
}

/**
 * pdf.js hands image objects over a callback that may never fire if the image
 * failed to decode. Without a timeout that is an unkillable hang inside the
 * main process — the exact failure this rewrite exists to remove. The timer is
 * deliberately NOT unref'd: an unref'd timer cannot fire when it is the only
 * thing left pending, which is precisely the case it has to cover.
 */
function resolveImageObject(objs, name, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`image "${name}" did not decode within ${timeoutMs}ms`))
    }, timeoutMs)
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    try {
      objs.get(name, (img) =>
        img ? finish(resolve, img) : finish(reject, new Error(`image "${name}" is empty`))
      )
    } catch (err) {
      finish(reject, err)
    }
  })
}

function asBytes(data) {
  if (data instanceof Uint8Array) return data
  if (data instanceof Uint8ClampedArray) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return null
}

/**
 * Which pixel layout `src` is in. pdf.js normally tags this on `img.kind`, but
 * inline images and some masks arrive untagged — infer those from bytes/pixel.
 */
function pixelMode(img, src, ImageKind) {
  if (img.kind === ImageKind.RGBA_32BPP) return 'rgba'
  if (img.kind === ImageKind.RGB_24BPP) return 'rgb'
  if (img.kind === ImageKind.GRAYSCALE_1BPP) return 'gray1'
  const pixels = img.width * img.height
  if (!pixels) return null
  const bpp = src.length / pixels
  if (Math.abs(bpp - 4) < 0.05) return 'rgba'
  if (Math.abs(bpp - 3) < 0.05) return 'rgb'
  if (Math.abs(bpp - 1) < 0.05) return 'gray8'
  if (bpp > 0 && bpp <= 0.2) return 'gray1' // 1bpp is ~0.125 bytes/pixel
  return null
}

/** Paint a decoded pdf.js image onto a fresh canvas. null when undecodable. */
async function paintImage(doc, img, ImageKind) {
  const { width, height } = img
  if (!(width > 0) || !(height > 0)) return null
  const made = await createRasterCanvas(doc, width, height)
  try {
    if (img.bitmap) {
      made.context.drawImage(img.bitmap, 0, 0)
      return made
    }
    const src = asBytes(img.data)
    if (!src) {
      made.release()
      return null
    }
    const mode = pixelMode(img, src, ImageKind)
    if (!mode) {
      made.release()
      return null
    }

    const imageData = made.context.createImageData(width, height)
    const dest = imageData.data // RGBA bytes — written byte-wise, so endian-safe
    if (mode === 'rgba') {
      dest.set(src.subarray(0, Math.min(src.length, dest.length)))
    } else if (mode === 'rgb') {
      for (let i = 0, o = 0; o < dest.length; i += 3, o += 4) {
        dest[o] = src[i]
        dest[o + 1] = src[i + 1]
        dest[o + 2] = src[i + 2]
        dest[o + 3] = 255
      }
    } else if (mode === 'gray8') {
      for (let i = 0, o = 0; o < dest.length; i += 1, o += 4) {
        dest[o] = dest[o + 1] = dest[o + 2] = src[i]
        dest[o + 3] = 255
      }
    } else {
      // 1 bit per pixel. pdf.js pads every ROW to a byte boundary, so walking
      // the bits as one continuous stream shears the image diagonally whenever
      // width % 8 !== 0 — index per row instead.
      const rowBytes = (width + 7) >> 3
      for (let y = 0; y < height; y++) {
        const row = y * rowBytes
        for (let x = 0; x < width; x++) {
          const value = (src[row + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0
          const o = (y * width + x) * 4
          dest[o] = dest[o + 1] = dest[o + 2] = value
          dest[o + 3] = 255
        }
      }
    }
    made.context.putImageData(imageData, 0, 0)
    return made
  } catch {
    made.release()
    return null
  }
}

function allPages(totalPages) {
  return Array.from({ length: totalPages }, (_, i) => i + 1)
}

/** Too small to be a figure — a glyph, rule, bullet or hairline. */
function belowFloor(width, height, minSize) {
  return minSize > 0 && (width < minSize || height < minSize)
}

function describeBytes(bytes) {
  return bytes < 1024 ? `${bytes}B` : `${Math.round(bytes / 1024)}KB`
}

/** Name the written files, but never dump thousands of paths into the context. */
function listWritten(written, outputDir) {
  const lines = []
  for (const w of written.slice(0, RASTER_LIST_LIMIT)) {
    lines.push(`  p.${w.page}  ${w.file}  (${w.width}x${w.height}, ${describeBytes(w.bytes)})`)
  }
  if (written.length > RASTER_LIST_LIMIT) {
    lines.push(
      `  …and ${written.length - RASTER_LIST_LIMIT} more in ${outputDir} — list them with wolffish_list_files.`
    )
  }
  return lines
}

async function pdfExtractImages(args, signal) {
  const filePath = resolvePath(args.path)
  const outputDir = resolvePath(args.output_dir)
  const format = args.format === 'jpg' || args.format === 'jpeg' ? 'jpg' : 'png'
  const rawMin = Number(args.min_size)
  const minSize = Number.isFinite(rawMin) && rawMin >= 0 ? rawMin : IMAGE_MIN_SIZE_DEFAULT

  let parser
  try {
    const pdfjs = await loadPdfjs()
    parser = await openPdf(filePath) // its own ENOENT/EBUSY messages beat a raw stat error
    const doc = parser.doc
    const totalPages = doc.numPages
    const selected = parsePageSelection(args.pages, totalPages) ?? allPages(totalPages)
    await fs.mkdir(outputDir, { recursive: true })

    const written = []
    const emptyPages = []
    // Two dedup layers, because one bitmap can reach us under several names.
    // `seenIds` catches a repeat placement before any work happens (cheap, but
    // pdf.js re-ids the same XObject per page until it decides to cache it
    // document-wide, so it only catches some). `seenHashes` compares the actual
    // encoded pixels afterwards, which catches everything — the same figure on
    // facing pages, and the icon a book embeds separately on 900 pages.
    const seenIds = new Set()
    const seenHashes = new Set()
    let skippedSmall = 0
    let duplicates = 0
    let failed = 0
    let stoppedAt = null

    for (const pageNum of selected) {
      if (signal?.aborted) {
        stoppedAt = pageNum
        break
      }
      const page = await doc.getPage(pageNum)
      try {
        const ops = await page.getOperatorList()
        let indexOnPage = 0 // files written FOR this page — drives the filenames
        let rasterOnPage = 0 // image XObjects PRESENT — drives the vector-art hint
        for (let i = 0; i < ops.fnArray.length; i++) {
          const fn = ops.fnArray[i]
          const inline = fn === pdfjs.OPS.paintInlineImageXObject
          if (!inline && fn !== pdfjs.OPS.paintImageXObject) continue
          if (signal?.aborted) {
            stoppedAt = pageNum // set here too: aborting on the LAST page would
            break //              otherwise look like a clean finish
          }
          const opArgs = ops.argsArray[i] ?? []
          rasterOnPage++

          // Inline images (BI/ID/EI) come through already decoded, as the
          // operand itself rather than a name to look up — pdf.js only routes
          // an image this way when width + height < 200, so these are the
          // page's smallest decorations. (Runs of them get merged into
          // paintInlineImageXObjectGroup, which is left alone for the same
          // reason: nothing that small is the figure anyone asked for.)
          let img = null
          let key = null
          if (inline) {
            img = opArgs[0]
            if (!(img?.width > 0) || !(img?.height > 0)) {
              failed++
              continue
            }
            if (belowFloor(img.width, img.height, minSize)) {
              skippedSmall++
              continue
            }
          } else {
            key = opArgs[0]
            if (typeof key !== 'string') {
              failed++
              continue
            }
            // /Width and /Height ride along in the operator args, so a fragment
            // can be rejected on two integer comparisons instead of a full
            // decode + re-encode. On a typeset book that is thousands of
            // glyphs, rules and bullets never touched.
            const [, declaredWidth, declaredHeight] = opArgs
            if (
              typeof declaredWidth === 'number' &&
              typeof declaredHeight === 'number' &&
              belowFloor(declaredWidth, declaredHeight, minSize)
            ) {
              skippedSmall++
              continue
            }
            // The same XObject gets painted repeatedly (a figure reused on
            // facing pages, a running-header logo). Decode + encode it once.
            if (seenIds.has(key)) {
              duplicates++
              continue
            }
            seenIds.add(key)
          }

          let made
          try {
            if (!inline) {
              img = await resolveImageObject(storeFor(page, key), key, IMAGE_RESOLVE_TIMEOUT_MS)
            }
            if (!(img?.width > 0) || !(img?.height > 0)) {
              failed++
              continue
            }
            // Authoritative check: the decoded size wins over the declared one.
            if (belowFloor(img.width, img.height, minSize)) {
              skippedSmall++
              continue
            }
            made = await paintImage(doc, img, pdfjs.ImageKind)
            if (!made) {
              failed++
              continue
            }
            const { buffer, ext } = encodeCanvas(made.canvas, format)
            const hash = crypto.createHash('sha1').update(buffer).digest('hex')
            if (seenHashes.has(hash)) {
              duplicates++
              continue
            }
            seenHashes.add(hash)
            indexOnPage++
            const file = `p${String(pageNum).padStart(4, '0')}-img${indexOnPage}-${img.width}x${img.height}.${ext}`
            await fs.writeFile(path.join(outputDir, file), buffer)
            written.push({
              page: pageNum,
              file,
              width: img.width,
              height: img.height,
              bytes: buffer.length
            })
          } catch {
            // One undecodable image must never abort the run.
            failed++
          } finally {
            made?.release()
          }
        }
        // Only pages that hold NO image XObject at all — not pages whose images
        // were merely deduped or size-filtered. Saying "vector art" about a page
        // that does have a picture would send the model down the wrong path.
        if (rasterOnPage === 0) emptyPages.push(pageNum)
      } finally {
        page.cleanup() // drop this page's decoded objects before the next one
      }
      await yieldToEventLoop()
    }

    const scope =
      selected.length === totalPages
        ? `all ${totalPages} pages`
        : `page${selected.length === 1 ? '' : 's'} ${describePageList(selected)}`
    const lines = []
    lines.push(
      `${written.length} image${written.length === 1 ? '' : 's'} extracted from ${path.basename(filePath)} (${scope}) → ${outputDir}`
    )
    if (stoppedAt !== null) {
      lines.push(`STOPPED by the user at page ${stoppedAt}. The images listed below were written.`)
    }
    const notes = []
    if (skippedSmall > 0) {
      notes.push(
        `${skippedSmall} below ${minSize}px (glyphs/rules/bullets — pass min_size to change or 0 to keep them)`
      )
    }
    if (duplicates > 0) {
      notes.push(
        `${duplicates} repeat placement${duplicates === 1 ? '' : 's'} of an image already written`
      )
    }
    if (failed > 0) notes.push(`${failed} could not be decoded`)
    if (notes.length > 0) lines.push(`Skipped: ${notes.join('; ')}.`)

    if (written.length > 0) {
      lines.push('')
      lines.push(...listWritten(written, outputDir))
      lines.push('')
      lines.push('These are real PNG/JPEG files. Use send_file to show one to the user.')
    }

    // The single most useful thing to say when someone asked for a figure: a
    // page can look full of figures and yield nothing here, because the figure
    // is DRAWN — vector lines and text, with no stored image to pull out (or
    // only the sub-80px fragments a typeset page is littered with). Extraction
    // can never return that figure; rendering the page always can. Say so
    // whenever the caller ended up with nothing, not just on the tidy case.
    if (written.length === 0) {
      lines.push('')
      lines.push(
        `Nothing to extract here — this page range stores no picture big enough to be a figure. ` +
          `If you are after a figure, chart, diagram, algorithm, or table, it is drawn on the page rather than ` +
          `embedded in it: use pdf_render_pages on ${describePageList(selected.slice(0, 8))} to get an image of it.`
      )
    } else if (emptyPages.length > 0 && emptyPages.length <= 20) {
      lines.push('')
      lines.push(
        `No embedded raster images on page${emptyPages.length === 1 ? '' : 's'} ${describePageList(emptyPages)}. ` +
          `Figures there are drawn as vectors and text, so nothing can be "extracted" from them — ` +
          `render the page instead with pdf_render_pages to get a picture of the figure.`
      )
    } else if (emptyPages.length > 20) {
      lines.push('')
      lines.push(
        `${emptyPages.length} of the ${selected.length} pages have no embedded raster images (their figures are vector art). ` +
          `Use pdf_render_pages for those.`
      )
    }

    if (stoppedAt !== null) return { success: false, error: lines.join('\n') }
    return { success: true, output: lines.join('\n') }
  } catch (err) {
    return { success: false, error: `Image extraction failed: ${err.message}` }
  } finally {
    if (parser) await parser.destroy?.().catch(() => undefined)
  }
}

async function pdfRenderPages(args, signal) {
  const filePath = resolvePath(args.path)
  const outputDir = resolvePath(args.output_dir)
  const format = args.format === 'jpg' || args.format === 'jpeg' ? 'jpg' : 'png'
  const rawScale = Number(args.scale)
  const scale =
    Number.isFinite(rawScale) && rawScale > 0
      ? Math.min(rawScale, RENDER_SCALE_MAX)
      : RENDER_SCALE_DEFAULT

  let parser
  try {
    await loadPdfjs() // same failure message as extraction when pdf.js is missing
    parser = await openPdf(filePath)
    const doc = parser.doc
    const totalPages = doc.numPages
    const selected = parsePageSelection(args.pages, totalPages)
    if (!selected) {
      throw new Error(
        `pages is required — name the pages to render, e.g. "84" or "84-85". This document has ${totalPages} pages.`
      )
    }
    await fs.mkdir(outputDir, { recursive: true })

    const written = []
    let stoppedAt = null

    for (const pageNum of selected) {
      if (signal?.aborted) {
        stoppedAt = pageNum
        break
      }
      const page = await doc.getPage(pageNum)
      try {
        const viewport = page.getViewport({ scale })
        const made = await createRasterCanvas(doc, viewport.width, viewport.height)
        try {
          // PDF pages have no background of their own; without this the render
          // is transparent (and would come out black as a JPEG).
          made.context.fillStyle = '#ffffff'
          made.context.fillRect(0, 0, made.canvas.width, made.canvas.height)
          await page.render({ canvasContext: made.context, viewport, canvas: made.canvas }).promise
          const { buffer, ext } = encodeCanvas(made.canvas, format)
          const file = `page-${String(pageNum).padStart(4, '0')}.${ext}`
          await fs.writeFile(path.join(outputDir, file), buffer)
          written.push({
            page: pageNum,
            file,
            width: made.canvas.width,
            height: made.canvas.height,
            bytes: buffer.length
          })
        } finally {
          made.release()
        }
      } finally {
        page.cleanup()
      }
      await yieldToEventLoop()
    }

    const lines = []
    lines.push(
      `Rendered ${written.length} page${written.length === 1 ? '' : 's'} of ${path.basename(filePath)} at ${scale}x (${Math.round(scale * 72)} dpi) → ${outputDir}`
    )
    if (stoppedAt !== null) {
      lines.push(`STOPPED by the user at page ${stoppedAt}. The pages listed below were written.`)
    }
    if (written.length > 0) {
      lines.push('')
      lines.push(...listWritten(written, outputDir))
      lines.push('')
      lines.push(
        'Each file is a full page image — the figure is on it, along with the rest of the page. ' +
          'Use send_file to show it to the user, and image_view if you need to read it yourself.'
      )
    }
    if (stoppedAt !== null) return { success: false, error: lines.join('\n') }
    return { success: true, output: lines.join('\n') }
  } catch (err) {
    return { success: false, error: `Page render failed: ${err.message}` }
  } finally {
    if (parser) await parser.destroy?.().catch(() => undefined)
  }
}

async function pdfCompress(args) {
  const filePath = resolvePath(args.path)
  const outputPath = resolvePath(args.output_path)

  try {
    const originalSize = await checkFileSize(filePath)
    const bytes = await fs.readFile(filePath)
    const pdfDoc = await PDFDocument.load(bytes)

    // pdf-lib's save() with certain options can reduce size:
    // - useObjectStreams compresses internal structure
    // - We remove metadata for more aggressive compression
    const saveOptions = { useObjectStreams: true }

    if (args.quality === 'low') {
      // Most aggressive: strip metadata
      pdfDoc.setTitle('')
      pdfDoc.setAuthor('')
      pdfDoc.setSubject('')
      pdfDoc.setKeywords([])
      pdfDoc.setProducer('')
      pdfDoc.setCreator('')
    }

    const compressedBytes = await pdfDoc.save(saveOptions)
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, compressedBytes)

    const savings = ((1 - compressedBytes.length / originalSize) * 100).toFixed(1)

    return {
      success: true,
      output: JSON.stringify({
        path: outputPath,
        originalSize,
        compressedSize: compressedBytes.length,
        savings: `${savings}%`
      })
    }
  } catch (err) {
    return { success: false, error: `Compression failed: ${err.message}` }
  }
}

function describeAction(toolName, args) {
  const targetPath = String(args?.path || args?.output_path || '')
  const basename = path.basename(targetPath)
  switch (toolName) {
    case 'pdf_info':
      return { title: 'Inspect PDF', description: `Read structure of ${basename}`, risk: 'low' }
    case 'pdf_read':
      return { title: 'Read PDF', description: `Extract text from ${basename}${args?.pages ? ` (pages ${args.pages})` : ''}`, risk: 'low' }
    case 'pdf_search':
      return { title: 'Search PDF', description: `Search ${basename} for "${String(args?.query ?? '').slice(0, 60)}"`, risk: 'low' }
    case 'pdf_create':
      return { title: 'Create PDF', description: `Create ${basename}`, command: targetPath, risk: 'medium' }
    case 'pdf_merge':
      return { title: 'Merge PDFs', description: `Merge PDFs into ${basename}`, command: targetPath, risk: 'medium' }
    case 'pdf_split':
      return { title: 'Split PDF', description: `Split ${basename} into parts`, risk: 'medium' }
    case 'pdf_modify':
      return { title: 'Modify PDF', description: `Add modifications to ${basename}`, command: targetPath, risk: 'medium' }
    case 'pdf_form':
      return { title: args?.action === 'read' ? 'Read Form' : 'Fill Form', description: `${args?.action === 'read' ? 'Read' : 'Fill'} form in ${basename}`, risk: args?.action === 'read' ? 'low' : 'medium' }
    case 'pdf_secure':
      return { title: `${args?.action === 'encrypt' ? 'Encrypt' : 'Decrypt'} PDF`, description: `${args?.action} ${basename}`, command: targetPath, risk: 'medium' }
    case 'pdf_extract_images':
      return { title: 'Extract Images', description: `Extract images from ${basename}${args?.pages ? ` (pages ${args.pages})` : ' (every page)'}`, risk: 'low' }
    case 'pdf_render_pages':
      return { title: 'Render Pages', description: `Render ${basename} pages ${args?.pages ?? ''} to images`.trim(), risk: 'low' }
    case 'pdf_compress':
      return { title: 'Compress PDF', description: `Compress ${basename}`, command: targetPath, risk: 'medium' }
    default:
      return null
  }
}

const plugin = {
  name: 'pdf',
  tools: toolDefinitions,
  describeAction,
  async execute(toolName, args, signal) {
    switch (toolName) {
      case 'pdf_info': return pdfInfo(args)
      case 'pdf_read': return pdfRead(args)
      case 'pdf_search': return pdfSearch(args)
      case 'pdf_create': return pdfCreate(args)
      case 'pdf_merge': return pdfMerge(args)
      case 'pdf_split': return pdfSplit(args)
      case 'pdf_modify': return pdfModify(args)
      case 'pdf_form': return pdfForm(args)
      case 'pdf_secure': return pdfSecure(args)
      case 'pdf_extract_images': return pdfExtractImages(args, signal)
      case 'pdf_render_pages': return pdfRenderPages(args, signal)
      case 'pdf_compress': return pdfCompress(args)
      default: return { success: false, error: `pdf: unknown tool ${toolName}` }
    }
  }
}

export default plugin
