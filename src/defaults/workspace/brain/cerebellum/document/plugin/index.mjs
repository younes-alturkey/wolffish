import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  ImageRun, PageBreak, AlignmentType, WidthType, BorderStyle, Header, Footer,
  TableOfContents, NumberFormat, PageNumber, ExternalHyperlink,
  LevelFormat, ShadingType, VerticalAlign, convertInchesToTwip, PageOrientation,
  LineRuleType
} from 'docx'
import mammoth from 'mammoth'
import TurndownService from 'turndown'
import AdmZip from 'adm-zip'


const toolDefinitions = [
  {
    name: 'doc_design',
    description: 'Load the Word document design manual.',
    parameters: { type: 'object', properties: { document: { type: 'string' } } }
  },
  {
    name: 'document_validate',
    description: 'Check a .docx for the faults that make Word refuse or repair it.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'document_render',
    description: 'Render a .docx to PDF for visual inspection.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, output_dir: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['path'] }
  },
  {
    name: 'document_read',
    description: 'Read any document file and extract content as text, HTML, or Markdown.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the document' },
        format: { type: 'string', enum: ['text', 'html', 'markdown'] }
      },
      required: ['path']
    }
  },
  {
    name: 'document_create',
    description: 'Create a professional .docx document with headings, paragraphs, tables, images, lists.',
    parameters: {
      type: 'object',
      properties: {
        output_path: { type: 'string', description: 'Absolute path for the output .docx' },
        content: { type: 'string', description: 'JSON array of content blocks' },
        options: { type: 'string', description: 'Optional JSON document options' }
      },
      required: ['output_path', 'content']
    }
  },
  {
    name: 'document_modify',
    description: 'Edit an existing .docx — find-and-replace, insert, append content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to source .docx' },
        output_path: { type: 'string', description: 'Absolute path for output' },
        operations: { type: 'string', description: 'JSON array of operations' }
      },
      required: ['path', 'output_path', 'operations']
    }
  },
  {
    name: 'document_template',
    description: 'Fill a .docx template using {{placeholder}} syntax.',
    parameters: {
      type: 'object',
      properties: {
        template_path: { type: 'string', description: 'Absolute path to .docx template' },
        output_path: { type: 'string', description: 'Absolute path for filled output' },
        data: { type: 'string', description: 'JSON object mapping placeholders to values' },
        options: { type: 'string', description: 'Optional JSON: {list_separator?}' }
      },
      required: ['template_path', 'output_path', 'data']
    }
  },
  {
    name: 'document_convert',
    description: 'Convert between document formats (docx, html, markdown, text, pdf).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to source document' },
        output_path: { type: 'string', description: 'Absolute path for output (extension sets format)' }
      },
      required: ['path', 'output_path']
    }
  },
  {
    name: 'document_merge',
    description: 'Merge multiple documents into a single .docx.',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'string', description: 'JSON array of document paths' },
        output_path: { type: 'string', description: 'Absolute path for merged output' },
        page_break_between: { type: 'string', description: '"true" or "false"' }
      },
      required: ['paths', 'output_path']
    }
  },
  {
    name: 'document_toc',
    description: 'Generate a table of contents for a .docx document.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to source .docx' },
        output_path: { type: 'string', description: 'Absolute path for output' },
        depth: { type: 'number', description: 'Max heading depth (1-6, default 3)' },
        title: { type: 'string', description: 'TOC title' }
      },
      required: ['path', 'output_path']
    }
  },
  {
    name: 'document_metadata',
    description: 'Read or set document metadata (author, title, subject, keywords).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to .docx file' },
        action: { type: 'string', enum: ['read', 'set'] },
        output_path: { type: 'string', description: 'Output path (required for set)' },
        metadata: { type: 'string', description: 'JSON metadata object (required for set)' }
      },
      required: ['path', 'action']
    }
  },
  {
    name: 'document_compare',
    description: 'Compare two documents and return a structured diff.',
    parameters: {
      type: 'object',
      properties: {
        path_a: { type: 'string', description: 'First document path' },
        path_b: { type: 'string', description: 'Second document path' },
        format: { type: 'string', enum: ['text', 'html'] }
      },
      required: ['path_a', 'path_b']
    }
  },
  {
    name: 'document_extract_images',
    description: 'Extract all images from a .docx file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to .docx file' },
        output_dir: { type: 'string', description: 'Directory for extracted images' }
      },
      required: ['path', 'output_dir']
    }
  }
]

// ── The style sheet ───────────────────────────────────────────────────────
// A Word document is good or bad on one axis before any other: whether its
// formatting lives in NAMED STYLES or is painted onto each paragraph. Direct
// formatting is what makes a .docx that cannot be restyled, whose headings do
// not reach the navigation pane or a table of contents, and that fights every
// house template it is pasted into. So the engine owns a style sheet and the
// blocks only ever reference it — the same inversion the deck engine makes
// with geometry.
//
// Palettes are the eight contrast-tested themes from `pdf-design/themes.md`,
// so a Word document, its PDF sibling and a deck come out of one system.

const DOC_THEMES = {
  steel:    { ink: '16202E', ink2: '3D4A5C', muted: '5B6878', hairline: 'E2E6EB', accent: '1D4ED8', accentDeep: '16307A', wash: 'EEF2FB' },
  teal:     { ink: '12211F', ink2: '354A47', muted: '5A6F6C', hairline: 'E0E8E6', accent: '0F766E', accentDeep: '134E4A', wash: 'ECF6F4' },
  forest:   { ink: '15211A', ink2: '3A4A41', muted: '5D6F64', hairline: 'E3E9E4', accent: '15803D', accentDeep: '14532D', wash: 'EDF6EF' },
  indigo:   { ink: '1A1A2E', ink2: '3F3F5C', muted: '63637E', hairline: 'E4E4EE', accent: '4338CA', accentDeep: '312E81', wash: 'EEF0FC' },
  plum:     { ink: '221A2B', ink2: '493D55', muted: '6D6480', hairline: 'E9E4EF', accent: '7E22CE', accentDeep: '581C87', wash: 'F5EEFC' },
  claret:   { ink: '241419', ink2: '4F3941', muted: '6F6068', hairline: 'ECE2E5', accent: '86174A', accentDeep: '5C0F33', wash: 'FBEEF4' },
  rust:     { ink: '26180F', ink2: '4F3A2C', muted: '6F6055', hairline: 'ECE2DA', accent: '7C2D12', accentDeep: '5A1F0C', wash: 'FBF0E9' },
  graphite: { ink: '0F172A', ink2: '334155', muted: '5B6779', hairline: 'E2E8F0', accent: '334155', accentDeep: '1E293B', wash: 'F1F5F9' }
}
const DOC_SEMANTIC = { good: '166534', warn: 'B45309', bad: 'B91C1C' }
const DEFAULT_DOC_THEME = 'steel'

// Page sizes in twips (1440 = 1 inch).
const PAGE_SIZES = {
  a4: { width: 11906, height: 16838 },
  letter: { width: 12240, height: 15840 },
  legal: { width: 12240, height: 20160 }
}

/** Normalise a colour to the bare 6-digit form OOXML wants. */
function docHex(value, fallback) {
  if (value == null || value === '') return fallback
  const v = String(value).trim().replace(/^#/, '').toUpperCase()
  if (/^[0-9A-F]{3}$/.test(v)) return v.split('').map((c) => c + c).join('')
  if (!/^[0-9A-F]{6}$/.test(v)) throw new Error(`colour "${value}" is not a 6-digit hex value`)
  return v
}

function resolveDocTheme(spec) {
  const named = String(spec.theme || DEFAULT_DOC_THEME).toLowerCase()
  const base = DOC_THEMES[named]
  if (!base && !spec.tokens) {
    throw new Error(`unknown theme "${spec.theme}" — use one of ${Object.keys(DOC_THEMES).join(', ')}, or pass a full tokens object`)
  }
  const merged = { ...(base || DOC_THEMES[DEFAULT_DOC_THEME]), ...(spec.tokens || {}) }
  const out = {}
  for (const [k, v] of Object.entries(merged)) out[k] = docHex(v)
  return out
}

/**
 * Build the document's style sheet. Heading ids are the BUILT-IN ones
 * (Heading1…) on purpose: Word's navigation pane, the table of contents and
 * every house template key off those, and a custom heading style is invisible
 * to all three unless it also carries an outline level.
 */
function buildStyles(t, fonts, scale) {
  const body = { font: fonts.body, size: scale.body, color: t.ink }
  const heading = (size, color, spacingBefore, spacingAfter, extra = {}) => ({
    run: { font: fonts.display, size, bold: true, color },
    paragraph: {
      spacing: { before: spacingBefore, after: spacingAfter },
      keepNext: true, keepLines: true, outlineLevel: undefined, ...extra
    }
  })
  return {
    default: {
      document: { run: body, paragraph: { spacing: { after: 160, line: LINE_BODY }, widowControl: true } },
      // Three levels told apart by size and weight alone is the default-Word
      // look, and it is what a document is judged on in its first second. H1
      // carries a hairline; H3 is not a small H2 but the eyebrow voice —
      // body size, caps, letterspaced (Butterick: 5-12% extra tracking on caps).
      heading1: heading(scale.h1, t.ink, 440, 200, {
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: t.hairline, space: 8 } }
      }),
      heading2: heading(scale.h2, t.accentDeep, 360, 140),
      heading3: {
        run: { font: fonts.body, size: scale.body, bold: true, color: t.ink2, allCaps: true, characterSpacing: 20 },
        paragraph: { spacing: { before: 320, after: 120 }, keepNext: true, keepLines: true }
      }
    },
    paragraphStyles: [
      {
        id: 'WfTitle', name: 'Wf Title', basedOn: 'Normal', next: 'WfSubtitle', quickFormat: true,
        run: { font: fonts.display, size: scale.title, bold: true, color: t.ink },
        paragraph: { spacing: { before: 0, after: 120 }, keepNext: true }
      },
      {
        id: 'WfSubtitle', name: 'Wf Subtitle', basedOn: 'Normal', next: 'WfBody', quickFormat: true,
        run: { font: fonts.body, size: scale.subtitle, color: t.ink2 },
        paragraph: { spacing: { after: 240 } }
      },
      {
        id: 'WfEyebrow', name: 'Wf Eyebrow', basedOn: 'Normal', next: 'WfTitle', quickFormat: true,
        run: { font: fonts.body, size: scale.eyebrow, bold: true, color: t.accent, characterSpacing: 30, allCaps: true },
        paragraph: { spacing: { after: 80 }, keepNext: true }
      },
      {
        id: 'WfBody', name: 'Wf Body', basedOn: 'Normal', next: 'WfBody', quickFormat: true,
        run: body, paragraph: { spacing: { after: 160, line: LINE_BODY }, widowControl: true }
      },
      {
        id: 'WfLead', name: 'Wf Lead', basedOn: 'Normal', next: 'WfBody', quickFormat: true,
        run: { font: fonts.body, size: scale.lead, color: t.ink2 },
        paragraph: { spacing: { after: 220, line: LINE_LEAD }, widowControl: true }
      },
      {
        id: 'WfQuote', name: 'Wf Quote', basedOn: 'Normal', next: 'WfBody', quickFormat: true,
        run: { font: fonts.display, size: scale.quote, italics: true, color: t.ink },
        paragraph: {
          spacing: { before: 200, after: 200, line: LINE_BODY },
          indent: { left: 420 },
          border: { left: { style: BorderStyle.SINGLE, size: 18, space: 14, color: t.accent } }
        }
      },
      {
        id: 'WfCaption', name: 'Wf Caption', basedOn: 'Normal', next: 'WfBody', quickFormat: true,
        run: { font: fonts.body, size: scale.caption, color: t.muted },
        paragraph: { spacing: { before: 60, after: 200 } }
      },
      {
        id: 'WfTableHeader', name: 'Wf Table Header', basedOn: 'Normal', next: 'WfBody',
        run: { font: fonts.body, size: scale.eyebrow, bold: true, color: t.muted, allCaps: true, characterSpacing: 18 },
        paragraph: { spacing: { before: 0, after: 80 } }
      },
      {
        id: 'WfTableCell', name: 'Wf Table Cell', basedOn: 'Normal', next: 'WfBody',
        run: { font: fonts.body, size: scale.tableCell, color: t.ink },
        paragraph: { spacing: { before: 0, after: 0, line: 276 } }
      },
      {
        id: 'WfMetaLabel', name: 'Wf Meta Label', basedOn: 'Normal', next: 'WfMetaValue',
        run: { font: fonts.body, size: scale.eyebrow, bold: true, color: t.muted, allCaps: true, characterSpacing: 24 },
        paragraph: { spacing: { before: 0, after: 40 }, keepNext: true }
      },
      {
        id: 'WfMetaValue', name: 'Wf Meta Value', basedOn: 'Normal', next: 'WfBody',
        run: { font: fonts.body, size: scale.tableCell, bold: true, color: t.ink },
        paragraph: { spacing: { before: 0, after: 0 } }
      },
      {
        id: 'WfTocHeading', name: 'Wf Toc Heading', basedOn: 'Normal', next: 'WfBody', quickFormat: true,
        // Looks like Heading 1 but is NOT one: a TOC titled with a real
        // heading style appears as the first line of its own contents.
        run: { font: fonts.display, size: scale.h1, bold: true, color: t.ink },
        paragraph: { spacing: { before: 0, after: 200 }, keepNext: true }
      },
      {
        id: 'WfFooter', name: 'Wf Footer', basedOn: 'Normal', next: 'WfFooter',
        run: { font: fonts.body, size: scale.footer, color: t.muted },
        paragraph: { spacing: { before: 0, after: 0 } }
      }
    ]
  }
}

// Line spacing in 240ths of a line. 288 (120%) is the floor of the readable
// range, not the middle of it — 312 is 130%, 336 is 140% for the standfirst.
const LINE_BODY = 312
const LINE_LEAD = 336

/** Half-point sizes. Word measures type in half-points, so every value doubles. */
function typeScale(base) {
  const b = Number(base) || 11
  return {
    title: Math.round(b * 2.9) * 2, subtitle: Math.round(b * 1.27) * 2, eyebrow: Math.round(b * 0.82) * 2,
    h1: Math.round(b * 1.65) * 2, h2: Math.round(b * 1.3) * 2, h3: Math.round(b * 1.09) * 2,
    body: b * 2, lead: Math.round(b * 1.14) * 2, quote: Math.round(b * 1.18) * 2,
    caption: Math.round(b * 0.86) * 2, tableHead: Math.round(b * 0.91) * 2,
    tableCell: Math.round(b * 0.91) * 2, footer: Math.round(b * 0.82) * 2
  }
}

const DOC_NUMBERING = {
  config: [
    {
      reference: 'wf-bullets',
      levels: [
        { level: 0, format: LevelFormat.BULLET, text: '\u2022', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 420, hanging: 260 } } } },
        { level: 1, format: LevelFormat.BULLET, text: '\u2013', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 780, hanging: 260 } } } }
      ]
    },
    {
      reference: 'wf-numbers',
      levels: [
        { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 420, hanging: 260 } } } },
        { level: 1, format: LevelFormat.LOWER_LETTER, text: '%2.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 780, hanging: 260 } } } }
      ]
    }
  ]
}

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

/** Existence probe (throws ENOENT early with a clean message); never a size gate. */
async function checkFileSize(filePath) {
  const stat = await fs.stat(filePath)
  return stat.size
}

function getExt(filePath) {
  return path.extname(filePath).toLowerCase()
}

const HEADING_LEVELS = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6
}

const ALIGNMENTS = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED
}

function htmlToMarkdown(html) {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  return td.turndown(html)
}

function markdownToHtml(md) {
  let html = md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>')

  // Wrap loose lines in paragraphs
  const lines = html.split('\n')
  const result = []
  for (const line of lines) {
    if (line.trim() === '') {
      result.push('')
    } else if (!line.startsWith('<')) {
      result.push(`<p>${line}</p>`)
    } else {
      result.push(line)
    }
  }
  return result.join('\n')
}

async function documentRead(args) {
  const filePath = resolvePath(args.path)
  const outputFormat = args.format || 'text'

  try {
    await checkFileSize(filePath)
  } catch (err) {
    return { success: false, error: err.message }
  }

  const ext = getExt(filePath)

  try {
    if (ext === '.docx') {
      const buffer = await fs.readFile(filePath)
      if (outputFormat === 'html') {
        const result = await mammoth.convertToHtml({ buffer })
        return { success: true, output: JSON.stringify({ format: 'html', content: result.value, messages: result.messages }) }
      } else if (outputFormat === 'markdown') {
        const result = await mammoth.convertToHtml({ buffer })
        const md = htmlToMarkdown(result.value)
        return { success: true, output: JSON.stringify({ format: 'markdown', content: md }) }
      } else {
        const result = await mammoth.extractRawText({ buffer })
        return { success: true, output: JSON.stringify({ format: 'text', content: result.value }) }
      }
    } else if (ext === '.html' || ext === '.htm') {
      const content = await fs.readFile(filePath, 'utf8')
      if (outputFormat === 'html') {
        return { success: true, output: JSON.stringify({ format: 'html', content }) }
      } else if (outputFormat === 'markdown') {
        return { success: true, output: JSON.stringify({ format: 'markdown', content: htmlToMarkdown(content) }) }
      } else {
        const text = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        return { success: true, output: JSON.stringify({ format: 'text', content: text }) }
      }
    } else if (ext === '.md' || ext === '.markdown') {
      const content = await fs.readFile(filePath, 'utf8')
      if (outputFormat === 'markdown') {
        return { success: true, output: JSON.stringify({ format: 'markdown', content }) }
      } else if (outputFormat === 'html') {
        return { success: true, output: JSON.stringify({ format: 'html', content: markdownToHtml(content) }) }
      } else {
        const text = content.replace(/[#*_`\[\]()]/g, '').trim()
        return { success: true, output: JSON.stringify({ format: 'text', content: text }) }
      }
    } else if (ext === '.txt' || ext === '.rtf') {
      const content = await fs.readFile(filePath, 'utf8')
      return { success: true, output: JSON.stringify({ format: 'text', content }) }
    } else {
      return { success: false, error: `Unsupported format: ${ext}. Supported: .docx, .html, .md, .txt, .rtf` }
    }
  } catch (err) {
    if (err.code === 'ENOENT') return { success: false, error: `File not found: ${filePath}` }
    if (err.code === 'EBUSY' || err.code === 'EPERM') return { success: false, error: 'File is open in another application' }
    return { success: false, error: `Read failed: ${err.message}` }
  }
}

// ── Block renderers ───────────────────────────────────────────────────────
// Each returns an array of docx children. The caller picks a block type and
// supplies content; nothing here takes a size, a colour or an indent from the
// caller — those come from the style sheet.

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'auto' }

/**
 * The house table system (pdf-design 5.6, so a report and its PDF match):
 * letterspaced caps column heads, a stronger rule under the header, hairline
 * rules between rows, NO vertical rules, no zebra, no fills. Vertical rules
 * and stripes are what make a Word table look like a 2007 spreadsheet.
 */
function hairlineBorders(color) {
  const line = { style: BorderStyle.SINGLE, size: 4, color }
  return { top: NO_BORDER, bottom: line, left: NO_BORDER, right: NO_BORDER, insideHorizontal: line, insideVertical: NO_BORDER }
}

// Left margin 0 puts the first column's text on the body text edge; the gap
// between columns is the previous cell's right margin.
function cellMargins() {
  return { top: 90, bottom: 90, left: 0, right: 220 }
}

/**
 * A figure, not prose: currency, percentages, counts, deltas. Numbers are
 * right-aligned so digits line up against each other — the single change
 * that makes a data table readable.
 */
function isNumericCell(value) {
  const v = String(value ?? '').trim()
  if (!v || v === '—' || v === '-') return false
  return /^[-+(]?\s*[$€£¥]?\s*\d[\d,.\u00a0 ]*\s*(%|pp|bps|k|m|bn|x)?\s*\)?$/i.test(v)
}

function renderTable(block, ctx) {
  const { t, contentWidth } = ctx
  const headers = Array.isArray(block.headers) ? block.headers.map((h) => String(h ?? '')) : []
  const rows = Array.isArray(block.rows) ? block.rows : []
  const colCount = headers.length || (rows[0] ? rows[0].length : 0)
  if (!colCount) return []

  // Both the table AND every cell need an explicit DXA width, and the column
  // widths must sum to the table width — percentage widths break in other
  // editors, and a missing cell width lets Word re-flow the grid on open.
  const declared = Array.isArray(block.column_widths) && block.column_widths.length === colCount
    ? block.column_widths.map(Number)
    : null
  const total = declared ? declared.reduce((a, b) => a + b, 0) : colCount
  const widths = declared
    ? declared.map((w) => Math.round((w / total) * contentWidth))
    : Array.from({ length: colCount }, () => Math.round(contentWidth / colCount))
  widths[widths.length - 1] = contentWidth - widths.slice(0, -1).reduce((a, b) => a + b, 0)

  // A column is numeric when most of its filled cells are figures. Decided
  // per column, not per cell, so one "n/a" does not left-align a whole column.
  const numericColumn = Array.from({ length: colCount }, (_, i) => {
    const values = rows.map((row) => (Array.isArray(row) ? row[i] : row)).filter((v) => String(v ?? '').trim() !== '')
    if (!values.length) return false
    return values.filter(isNumericCell).length / values.length >= 0.6
  })
  const align = (i) => (numericColumn[i] ? AlignmentType.RIGHT : undefined)

  const tableRows = []
  if (headers.length) {
    tableRows.push(new TableRow({
      tableHeader: true,
      cantSplit: true,
      children: headers.map((h, i) => new TableCell({
        width: { size: widths[i], type: WidthType.DXA },
        margins: cellMargins(),
        // The header's own rule, heavier than the row hairlines. A cell
        // border beats the table border, which is how one row gets it.
        borders: { bottom: { style: BorderStyle.SINGLE, size: 12, color: t.ink }, top: NO_BORDER, left: NO_BORDER, right: NO_BORDER },
        verticalAlign: VerticalAlign.BOTTOM,
        children: [new Paragraph({ text: h, style: 'WfTableHeader', alignment: align(i) })]
      }))
    }))
  }
  rows.forEach((row) => {
    const cells = Array.isArray(row) ? row : [row]
    tableRows.push(new TableRow({
      cantSplit: true,
      children: widths.map((w, i) => new TableCell({
        width: { size: w, type: WidthType.DXA },
        margins: cellMargins(),
        verticalAlign: VerticalAlign.TOP,
        children: [new Paragraph({ text: String(cells[i] ?? ''), style: 'WfTableCell', alignment: align(i) })]
      }))
    }))
  })

  const out = [new Table({
    rows: tableRows,
    width: { size: contentWidth, type: WidthType.DXA },
    columnWidths: widths,
    borders: hairlineBorders(t.hairline)
  })]
  if (block.caption) out.push(new Paragraph({ text: String(block.caption), style: 'WfCaption' }))
  else out.push(new Paragraph({ text: '', spacing: { after: 120 } }))
  return out
}

/**
 * A callout is a one-cell table: Word has no native box, and a shaded
 * paragraph cannot carry padding. Semantic tones sit on paper behind a
 * coloured left rule rather than a tinted ground — a tinted warning and a
 * tinted note are the same colour to the eye at this saturation.
 */
function renderCallout(block, ctx) {
  const { t, contentWidth } = ctx
  const tone = String(block.tone || 'info').toLowerCase()
  const rule = tone === 'good' ? DOC_SEMANTIC.good
    : tone === 'warn' ? DOC_SEMANTIC.warn
      : tone === 'bad' ? DOC_SEMANTIC.bad
        : t.accent
  const children = []
  if (block.title) {
    children.push(new Paragraph({
      children: [new TextRun({ text: String(block.title), bold: true, color: rule })],
      spacing: { after: 60 }
    }))
  }
  for (const line of splitProse(block.text)) {
    children.push(new Paragraph({ text: line, style: 'WfBody', spacing: { after: 0 } }))
  }
  return [
    new Table({
      width: { size: contentWidth, type: WidthType.DXA },
      columnWidths: [contentWidth],
      borders: {
        top: NO_BORDER, bottom: NO_BORDER, right: NO_BORDER,
        left: { style: BorderStyle.SINGLE, size: 18, color: rule },
        insideHorizontal: NO_BORDER, insideVertical: NO_BORDER
      },
      rows: [new TableRow({
        children: [new TableCell({
          width: { size: contentWidth, type: WidthType.DXA },
          margins: { top: 140, bottom: 140, left: 200, right: 200 },
          shading: tone === 'info' ? { type: ShadingType.CLEAR, fill: t.wash, color: 'auto' } : undefined,
          children
        })]
      })]
    }),
    new Paragraph({ text: '', spacing: { after: 160 } })
  ]
}

function renderList(block, ctx, reference) {
  const items = Array.isArray(block.items) ? block.items : []
  return items.map((item) => {
    const isObj = item && typeof item === 'object'
    return new Paragraph({
      children: [new TextRun({ text: String(isObj ? item.text : item), bold: Boolean(isObj && item.bold) })],
      style: 'WfBody',
      numbering: { reference, level: Math.min(1, Number(isObj ? item.level : 0) || 0) },
      spacing: { after: 80 }
    })
  })
}

async function renderImage(block, ctx) {
  const imgPath = resolvePath(block.path)
  const data = await fs.readFile(imgPath)
  const ext = path.extname(imgPath).toLowerCase().replace('.', '')
  const type = ext === 'jpeg' ? 'jpg' : ext
  if (!['png', 'jpg', 'gif', 'bmp'].includes(type)) {
    throw new Error(`image ${path.basename(imgPath)}: .${ext} is not an image type Word embeds — use png or jpg`)
  }
  const width = Number(block.width) || 560
  const height = Number(block.height) || Math.round(width * 0.62)
  const out = [new Paragraph({
    children: [new ImageRun({ data, type, transformation: { width, height } })],
    alignment: ALIGNMENTS[block.alignment] || AlignmentType.CENTER,
    spacing: { before: 120, after: block.caption ? 40 : 200 }
  })]
  if (block.caption) out.push(new Paragraph({ text: String(block.caption), style: 'WfCaption', alignment: AlignmentType.CENTER }))
  return out
}

/** An empty paragraph of exact height — the only reliable vertical spacer. */
function exactSpacer(height) {
  return new Paragraph({ children: [], spacing: { before: 0, after: 0, line: height, lineRule: LineRuleType.EXACT } })
}

/**
 * The cover's meta block. Given a list, it is a label/value row across a
 * hairline — who it is for, when, what scope — which is what a designed
 * cover carries. A plain string still renders as caption lines under the
 * same hairline, so older documents keep working.
 */
function renderCoverMeta(meta, ctx) {
  const { t, contentWidth } = ctx
  const items = Array.isArray(meta) ? meta.filter((m) => m != null && m !== '').slice(0, 4) : null
  if (!items || !items.length) {
    return [
      exactSpacer(320),
      new Paragraph({
        text: '', spacing: { before: 0, after: 160 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: t.hairline, space: 1 } }
      }),
      ...proseParagraphs(meta, { style: 'WfCaption' })
    ]
  }
  const widths = Array.from({ length: items.length }, () => Math.floor(contentWidth / items.length))
  widths[widths.length - 1] = contentWidth - widths.slice(0, -1).reduce((a, b) => a + b, 0)
  const cells = items.map((item, i) => {
    const isObj = item && typeof item === 'object'
    const label = isObj ? item.label : null
    const value = isObj ? item.value : item
    const children = []
    if (label) children.push(new Paragraph({ text: String(label), style: 'WfMetaLabel' }))
    children.push(...splitProse(value).map((line) => new Paragraph({ text: line, style: 'WfMetaValue' })))
    return new TableCell({
      width: { size: widths[i], type: WidthType.DXA },
      margins: { top: 140, bottom: 0, left: 0, right: 200 },
      children
    })
  })
  return [
    exactSpacer(320),
    new Table({
      rows: [new TableRow({ children: cells })],
      width: { size: contentWidth, type: WidthType.DXA },
      columnWidths: widths,
      borders: {
        top: { style: BorderStyle.SINGLE, size: 4, color: t.hairline },
        bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER,
        insideHorizontal: NO_BORDER, insideVertical: NO_BORDER
      }
    }),
    new Paragraph({ text: '', spacing: { after: 0 } })
  ]
}

function renderDivider(ctx) {
  // A paragraph bottom border, never a one-row table: a table rule breaks
  // text flow and shows as an empty row in outline and accessibility views.
  return [new Paragraph({
    text: '',
    spacing: { before: 160, after: 200 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: ctx.t.hairline, space: 1 } }
  })]
}

/**
 * Prose fields accept newlines. OOXML has no newline inside a text run — a raw
 * one collapses to a space and an escaped one prints as a visible backslash-n
 * — so every multi-line field becomes real paragraphs. Applied uniformly
 * because a field that behaves differently from its neighbour is a trap.
 */
function splitProse(text) {
  return String(text ?? '')
    .replace(/\\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, i, all) => line !== '' || all.length === 1)
}

function proseParagraphs(text, opts) {
  return splitProse(text).map((line) => new Paragraph({ ...opts, text: line }))
}

async function renderBlock(block, ctx) {
  const type = String(block.type || 'paragraph').toLowerCase()
  switch (type) {
    case 'cover': {
      const out = []
      // A cover whose first line sits on the top margin reads as page one of
      // a memo. Word has no vertical centring in the flow, so the title block
      // is dropped by a fixed rule of exact height.
      // `false` pins the block to the top margin. An explicit number is
      // honoured exactly — zero included, and clamped at zero so a negative
      // cannot silently drop the spacer instead of removing it. Only an
      // absent or unparseable value falls back to the default drop.
      const askedTop = block.top_space
      const topNumber = Number(askedTop)
      const topSpace =
        askedTop === false
          ? 0
          : askedTop == null || askedTop === '' || !Number.isFinite(topNumber)
            ? 2100
            : Math.max(0, topNumber)
      if (topSpace > 0) out.push(exactSpacer(topSpace))
      if (block.eyebrow) out.push(new Paragraph({ text: String(block.eyebrow), style: 'WfEyebrow' }))
      out.push(new Paragraph({ text: String(block.title ?? ''), style: 'WfTitle' }))
      out.push(new Paragraph({
        text: '', spacing: { before: 40, after: 200 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: ctx.t.accent, space: 1 } }
      }))
      if (block.subtitle) out.push(...proseParagraphs(block.subtitle, { style: 'WfSubtitle' }))
      if (block.meta) out.push(...renderCoverMeta(block.meta, ctx))
      if (block.page_break !== false) out.push(new Paragraph({ children: [new PageBreak()] }))
      return out
    }
    case 'heading':
      return [new Paragraph({
        text: String(block.text ?? ''),
        heading: HEADING_LEVELS[block.level || 1] || HeadingLevel.HEADING_1,
        alignment: ALIGNMENTS[block.alignment] || undefined
      })]
    case 'lead':
      return proseParagraphs(block.text, { style: 'WfLead' })
    case 'paragraph':
      return splitProse(block.text).map((line) => new Paragraph({
        children: [new TextRun({ text: line, bold: Boolean(block.bold), italics: Boolean(block.italic) })],
        style: 'WfBody',
        alignment: ALIGNMENTS[block.alignment] || undefined,
        bidirectional: Boolean(block.rtl)
      }))
    case 'bullets':
    case 'list':
      return renderList({ items: block.items || block.text }, ctx, block.ordered ? 'wf-numbers' : 'wf-bullets')
    case 'numbered':
      return renderList(block, ctx, 'wf-numbers')
    case 'table':
      return renderTable(block, ctx)
    case 'callout':
      return renderCallout(block, ctx)
    case 'quote': {
      const out = proseParagraphs(block.text, { style: 'WfQuote' })
      if (block.attribution) out.push(new Paragraph({ text: String(block.attribution), style: 'WfCaption', indent: { left: 420 } }))
      return out
    }
    case 'caption':
      return proseParagraphs(block.text, { style: 'WfCaption' })
    case 'image':
      return renderImage(block, ctx)
    case 'divider':
      return renderDivider(ctx)
    case 'toc':
      // The break after the contents is right for a report and wrong for a
      // three-page brief, where it spends a whole page on four lines.
      return [
        new Paragraph({ text: String(block.title || 'Contents'), style: 'WfTocHeading' }),
        new TableOfContents(String(block.title || 'Contents'), { hyperlink: true, headingStyleRange: '1-3' }),
        ...(block.page_break === false ? [] : [new Paragraph({ children: [new PageBreak()] })])
      ]
    case 'page_break':
    case 'pagebreak':
      return [new Paragraph({ children: [new PageBreak()] })]
    default:
      throw new Error(`unknown block type "${block.type}" — use one of cover, heading, lead, paragraph, bullets, numbered, table, callout, quote, caption, image, divider, toc, page_break`)
  }
}

async function documentCreate(args) {
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
  if (!Array.isArray(content) || !content.length) {
    return { success: false, error: 'content must be a non-empty JSON array of blocks' }
  }

  let t
  try { t = resolveDocTheme(options) } catch (err) { return { success: false, error: err.message } }

  const fonts = {
    display: String(options.font_display || options.default_font || 'Cambria'),
    body: String(options.font_body || options.default_font || 'Calibri')
  }
  const scale = typeScale(options.base_size || options.default_size || 11)
  const paper = PAGE_SIZES[String(options.page || 'a4').toLowerCase()] || PAGE_SIZES.a4
  const landscape = String(options.orientation || '').toLowerCase() === 'landscape'
  const margin = Math.round(convertInchesToTwip(Number(options.margin_inches) || 1.25))
  // Landscape takes PORTRAIT dimensions plus the orientation flag — the
  // library swaps them itself, and passing swapped values silently squares up.
  const pageWidth = paper.width
  const contentWidth = (landscape ? paper.height : paper.width) - margin * 2

  const ctx = { t, fonts, scale, contentWidth }
  const children = []
  try {
    for (const [i, block] of content.entries()) {
      try {
        children.push(...(await renderBlock(block, ctx)))
      } catch (err) {
        return { success: false, error: `block ${i + 1} (${block?.type ?? 'unknown'}): ${err instanceof Error ? err.message : String(err)}` }
      }
    }
  } catch (err) {
    return { success: false, error: `Failed to build document: ${err.message}` }
  }

  const footerText = options.footer ? String(options.footer) : ''
  const hasCover = content.some((b) => String(b?.type).toLowerCase() === 'cover')
  const runningHeader = options.header
    ? new Header({ children: [new Paragraph({ text: String(options.header), style: 'WfFooter' })] })
    : undefined
  const runningFooter = options.page_numbers === false && !footerText
    ? undefined
    : new Footer({
        children: [new Paragraph({
          style: 'WfFooter',
          tabStops: [{ type: 'right', position: contentWidth }],
          border: { top: { style: BorderStyle.SINGLE, size: 4, color: t.hairline, space: 8 } },
          children: [
            new TextRun({ text: footerText }),
            new TextRun({ text: '\t' }),
            ...(options.page_numbers === false ? [] : [new TextRun({ children: [PageNumber.CURRENT] })])
          ]
        })]
      })
  const section = {
    properties: {
      // A cover with a page number and a running head on it is not a cover.
      // titlePage gives page one its own (empty) header and footer, and
      // starting the count at zero makes the first content page "1".
      titlePage: hasCover,
      page: {
        size: { width: pageWidth, height: paper.height, orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT },
        margin: { top: margin, right: margin, bottom: margin, left: margin },
        ...(hasCover ? { pageNumbers: { start: 0 } } : {})
      }
    },
    headers: runningHeader
      ? { default: runningHeader, ...(hasCover ? { first: new Header({ children: [] }) } : {}) }
      : undefined,
    footers: runningFooter
      ? { default: runningFooter, ...(hasCover ? { first: new Footer({ children: [] }) } : {}) }
      : undefined,
    children
  }

  try {
    const doc = new Document({
      title: options.title ? String(options.title) : undefined,
      creator: options.author ? String(options.author) : 'Wolffish',
      description: options.description ? String(options.description) : undefined,
      styles: buildStyles(t, fonts, scale),
      numbering: DOC_NUMBERING,
      features: { updateFields: content.some((b) => String(b?.type).toLowerCase() === 'toc') },
      sections: [section]
    })
    const buffer = await Packer.toBuffer(doc)
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, buffer)

    const used = [...new Set(content.map((b) => String(b?.type || 'paragraph').toLowerCase()))]
    const lines = [
      `Wrote ${content.length} blocks to ${outputPath} (theme ${options.theme || DEFAULT_DOC_THEME}, ${String(options.page || 'a4').toLowerCase()}${landscape ? ' landscape' : ''}).`,
      'Formatting lives in named Word styles (WfBody, WfLead, Heading 1-3, …), so the reader can restyle the whole document from the Styles pane and the headings reach the navigation pane and any table of contents.'
    ]
    if (used.includes('toc')) {
      lines.push('The table of contents is a field: Word fills it on open (updateFields is set). It reads empty until then — that is expected, not a fault.')
    }
    lines.push('', 'Not done yet: run document_validate on this file, and document_render + pdf_render_pages + image_view to look at it.')
    return {
      success: true,
      output: `${lines.join('\n')}\n\n${JSON.stringify({ path: outputPath, size: buffer.length, blocks: content.length, block_types: used, theme: options.theme || DEFAULT_DOC_THEME }, null, 2)}`
    }
  } catch (err) {
    return { success: false, error: `Failed to create document: ${err.message}` }
  }
}

// ── Editing the packed XML ────────────────────────────────────────────────
// Three things make a naive find/replace on word/document.xml wrong, and all
// three were reproduced before this was written:
//
//  1. Word splits a visible phrase across many <w:r> runs (revision ids,
//     spell-check state, language marks), so the string you can SEE usually
//     does not exist contiguously in the XML. A raw replace matches nothing
//     and reports success.
//  2. A replacement containing & or < lands unescaped and the document stops
//     being well-formed — Word then refuses to open it or offers to repair.
//  3. A raw replace also rewrites TAG NAMES AND ATTRIBUTE VALUES, so replacing
//     a word that happens to appear in w:val="…" silently breaks a style
//     reference.
//
// So: merge same-format runs first, then edit only inside <w:t> text nodes,
// escaping what goes in.

const DOC_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }

function unescapeXmlText(value) {
  return String(value)
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => DOC_ENTITIES[m])
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
}

/**
 * Coalesce adjacent runs that carry identical formatting so the text they
 * hold becomes findable. Content and rendering are unchanged — only the run
 * boundaries move.
 */
function mergeRuns(xml) {
  let merged = 0
  const out = xml.replace(/<w:p(?: [^>]*)?>[\s\S]*?<\/w:p>/g, (para) => {
    const runs = [...para.matchAll(/<w:r(?: [^>]*)?>[\s\S]*?<\/w:r>/g)]
    if (runs.length < 2) return para
    let next = para
    for (let i = runs.length - 1; i > 0; i -= 1) {
      const a = runs[i - 1][0]
      const b = runs[i][0]
      // Only plain text runs, and only when the properties match exactly.
      if (!/<w:t(?: [^>]*)?>/.test(a) || !/<w:t(?: [^>]*)?>/.test(b)) continue
      if (/<w:(?:br|drawing|tab|fldChar|instrText|footnoteReference|commentReference)\b/.test(a + b)) continue
      const pa = /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(a)?.[0] ?? ''
      const pb = /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(b)?.[0] ?? ''
      if (pa !== pb) continue
      const ta = [...a.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join('')
      const tb = [...b.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join('')
      const fused = `<w:r>${pa}<w:t xml:space="preserve">${ta}${tb}</w:t></w:r>`
      if (!next.includes(a + b)) continue
      next = next.replace(a + b, fused)
      runs[i - 1] = [fused]
      merged += 1
    }
    return next
  })
  return { xml: out, merged }
}

/** Replace inside <w:t> nodes only, escaping what goes in. */
function replaceInTextNodes(xml, find, replace, { caseSensitive = false, regex = false } = {}) {
  let hits = 0
  const out = xml.replace(/(<w:t(?: [^>]*)?>)([\s\S]*?)(<\/w:t>)/g, (whole, open, inner, close) => {
    const plain = unescapeXmlText(inner)
    let next
    if (regex) {
      const re = new RegExp(find, caseSensitive ? 'g' : 'gi')
      if (!re.test(plain)) return whole
      re.lastIndex = 0
      next = plain.replace(re, replace)
    } else {
      const hay = caseSensitive ? plain : plain.toLowerCase()
      const needle = caseSensitive ? find : find.toLowerCase()
      if (!hay.includes(needle)) return whole
      next = ''
      let i = 0
      for (;;) {
        const at = (caseSensitive ? plain : plain.toLowerCase()).indexOf(needle, i)
        if (at === -1) { next += plain.slice(i); break }
        next += plain.slice(i, at) + replace
        i = at + find.length
      }
    }
    hits += 1
    // A text node that gains or keeps leading/trailing space needs the
    // preserve hint, or Word collapses it.
    const openTag = /xml:space=/.test(open) ? open : open.replace('<w:t', '<w:t xml:space="preserve"')
    return `${openTag}${escapeXml(next)}${close}`
  })
  return { xml: out, hits }
}

async function documentModify(args) {
  const filePath = resolvePath(args.path)
  const outputPath = resolvePath(args.output_path)
  let operations
  try {
    operations = parseJsonParam(args.operations, 'operations')
  } catch (err) {
    return { success: false, error: err.message }
  }

  try {
    await checkFileSize(filePath)
    const zip = new AdmZip(filePath)
    let documentXml = zip.readAsText('word/document.xml')
    const log = []
    let mergedRuns = 0
    let mergedOnce = false

    for (const op of operations) {
      switch (op.type) {
        case 'find_replace': {
          const find = String(op.find ?? '')
          if (!find) throw new Error('find_replace: find is required')
          const replace = String(op.replace ?? '')
          if (!mergedOnce) {
            const m = mergeRuns(documentXml)
            documentXml = m.xml
            mergedRuns += m.merged
            mergedOnce = true
          }
          const res = replaceInTextNodes(documentXml, find, replace, {
            caseSensitive: Boolean(op.case_sensitive),
            regex: Boolean(op.regex)
          })
          documentXml = res.xml
          log.push(res.hits
            ? `replaced "${find}" in ${res.hits} text run${res.hits === 1 ? '' : 's'}`
            : `WARNING: "${find}" matched nothing — read the document with document_read and check the exact wording`)
          break
        }
        case 'append': {
          // Insert before closing </w:body>
          const text = op.content || op.text || ''
          const paragraph = `<w:p><w:pPr><w:pStyle w:val="WfBody"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
          documentXml = documentXml.replace('</w:body>', `${paragraph}</w:body>`)
          log.push('appended a paragraph')
          break
        }
        case 'insert': {
          const text = op.content || op.text || ''
          const paragraph = `<w:p><w:pPr><w:pStyle w:val="WfBody"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
          // Insert at beginning of body
          documentXml = documentXml.replace('<w:body>', `<w:body>${paragraph}`)
          log.push('inserted a paragraph at the top')
          break
        }
      }
    }

    zip.updateFile('word/document.xml', Buffer.from(documentXml, 'utf8'))
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    zip.writeZip(outputPath)

    const lines = [outputPath, ...log.map((l) => `- ${l}`)]
    if (mergedRuns) lines.push(`- coalesced ${mergedRuns} split run${mergedRuns === 1 ? '' : 's'} so the text was findable (formatting unchanged)`)
    lines.push('', 'Run document_validate on the result before sending it.')
    return { success: true, output: lines.join('\n') }
  } catch (err) {
    if (err.code === 'ENOENT') return { success: false, error: `File not found: ${filePath}` }
    if (err.code === 'EBUSY' || err.code === 'EPERM') return { success: false, error: 'File is open in another application' }
    return { success: false, error: `Modify failed: ${err.message}` }
  }
}

async function documentTemplate(args) {
  const templatePath = resolvePath(args.template_path)
  const outputPath = resolvePath(args.output_path)
  let data, options
  try {
    data = parseJsonParam(args.data, 'data')
  } catch (err) {
    return { success: false, error: err.message }
  }
  try {
    options = args.options ? parseJsonParam(args.options, 'options') : {}
  } catch {
    options = {}
  }

  try {
    await checkFileSize(templatePath)
    const zip = new AdmZip(templatePath)
    let documentXml = zip.readAsText('word/document.xml')

    const listSeparator = options.list_separator || ', '

    for (const [key, value] of Object.entries(data)) {
      const placeholder = `{{${key}}}`
      let replacement
      if (Array.isArray(value)) {
        replacement = value.join(listSeparator)
      } else {
        replacement = String(value)
      }
      // Replace in XML — the placeholder might be split across runs
      // First try simple replacement
      const escapedPlaceholder = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      documentXml = documentXml.replace(new RegExp(escapedPlaceholder, 'g'), escapeXml(replacement))

      // Handle case where {{ and }} are in separate XML runs
      const splitPattern = new RegExp(
        `\\{\\{</w:t></w:r><w:r[^>]*><w:t[^>]*>${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</w:t></w:r><w:r[^>]*><w:t[^>]*>\\}\\}`,
        'g'
      )
      documentXml = documentXml.replace(splitPattern, escapeXml(replacement))
    }

    zip.updateFile('word/document.xml', Buffer.from(documentXml, 'utf8'))
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    zip.writeZip(outputPath)

    return {
      success: true,
      output: JSON.stringify({
        path: outputPath,
        placeholdersFilled: Object.keys(data).length
      })
    }
  } catch (err) {
    if (err.code === 'ENOENT') return { success: false, error: `Template not found: ${templatePath}` }
    return { success: false, error: `Template fill failed: ${err.message}` }
  }
}

async function documentConvert(args) {
  const filePath = resolvePath(args.path)
  const outputPath = resolvePath(args.output_path)
  const srcExt = getExt(filePath)
  const dstExt = getExt(outputPath)

  try {
    await checkFileSize(filePath)
    await fs.mkdir(path.dirname(outputPath), { recursive: true })

    if (srcExt === '.docx' && dstExt === '.html') {
      const buffer = await fs.readFile(filePath)
      const result = await mammoth.convertToHtml({ buffer })
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Document</title></head><body>${result.value}</body></html>`
      await fs.writeFile(outputPath, html, 'utf8')
    } else if (srcExt === '.docx' && (dstExt === '.md' || dstExt === '.markdown')) {
      const buffer = await fs.readFile(filePath)
      const result = await mammoth.convertToHtml({ buffer })
      const md = htmlToMarkdown(result.value)
      await fs.writeFile(outputPath, md, 'utf8')
    } else if (srcExt === '.docx' && dstExt === '.txt') {
      const buffer = await fs.readFile(filePath)
      const result = await mammoth.extractRawText({ buffer })
      await fs.writeFile(outputPath, result.value, 'utf8')
    } else if ((srcExt === '.html' || srcExt === '.htm') && dstExt === '.docx') {
      const html = await fs.readFile(filePath, 'utf8')
      const textContent = html.replace(/<[^>]+>/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
      const paragraphs = textContent.split('\n').filter((l) => l.trim()).map(
        (line) => new Paragraph({ text: line.trim() })
      )
      const doc = new Document({ sections: [{ children: paragraphs }] })
      const buffer = await Packer.toBuffer(doc)
      await fs.writeFile(outputPath, buffer)
    } else if ((srcExt === '.md' || srcExt === '.markdown') && dstExt === '.docx') {
      const md = await fs.readFile(filePath, 'utf8')
      const lines = md.split('\n')
      const children = []
      for (const line of lines) {
        if (line.startsWith('### ')) {
          children.push(new Paragraph({ text: line.slice(4), heading: HeadingLevel.HEADING_3 }))
        } else if (line.startsWith('## ')) {
          children.push(new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_2 }))
        } else if (line.startsWith('# ')) {
          children.push(new Paragraph({ text: line.slice(2), heading: HeadingLevel.HEADING_1 }))
        } else if (line.startsWith('- ') || line.startsWith('* ')) {
          children.push(new Paragraph({ text: `• ${line.slice(2)}`, indent: { left: 720 } }))
        } else if (line.trim()) {
          const text = line.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/`(.+?)`/g, '$1')
          children.push(new Paragraph({ text }))
        }
      }
      const doc = new Document({ sections: [{ children }] })
      const buffer = await Packer.toBuffer(doc)
      await fs.writeFile(outputPath, buffer)
    } else if ((srcExt === '.html' || srcExt === '.htm') && (dstExt === '.md' || dstExt === '.markdown')) {
      const html = await fs.readFile(filePath, 'utf8')
      const md = htmlToMarkdown(html)
      await fs.writeFile(outputPath, md, 'utf8')
    } else if ((srcExt === '.md' || srcExt === '.markdown') && (dstExt === '.html' || dstExt === '.htm')) {
      const md = await fs.readFile(filePath, 'utf8')
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${markdownToHtml(md)}</body></html>`
      await fs.writeFile(outputPath, html, 'utf8')
    } else if (srcExt === '.docx' && dstExt === '.pdf') {
      // docx->pdf: read content, create PDF via the pdf capability
      // Since we can't call another plugin directly, we extract text and create a basic PDF
      return {
        success: false,
        error: 'docx->pdf conversion requires the pdf capability. Use document_read to extract content, then pdf_create to build the PDF.'
      }
    } else {
      return { success: false, error: `Unsupported conversion: ${srcExt} → ${dstExt}` }
    }

    const stat = await fs.stat(outputPath)
    return {
      success: true,
      output: JSON.stringify({
        path: outputPath,
        from: srcExt.slice(1),
        to: dstExt.slice(1),
        size: stat.size
      })
    }
  } catch (err) {
    if (err.code === 'ENOENT') return { success: false, error: `File not found: ${filePath}` }
    if (err.code === 'EBUSY' || err.code === 'EPERM') return { success: false, error: 'File is open in another application' }
    return { success: false, error: `Convert failed: ${err.message}` }
  }
}

async function documentMerge(args) {
  let paths
  try {
    paths = parseJsonParam(args.paths, 'paths')
  } catch (err) {
    return { success: false, error: err.message }
  }
  const outputPath = resolvePath(args.output_path)
  const pageBreak = args.page_break_between !== 'false'

  try {
    const allChildren = []

    for (let i = 0; i < paths.length; i++) {
      const filePath = resolvePath(paths[i])
      await checkFileSize(filePath)
      const ext = getExt(filePath)

      let text
      if (ext === '.docx') {
        const buffer = await fs.readFile(filePath)
        const result = await mammoth.extractRawText({ buffer })
        text = result.value
      } else {
        text = await fs.readFile(filePath, 'utf8')
      }

      const lines = text.split('\n')
      for (const line of lines) {
        if (line.trim()) {
          allChildren.push(new Paragraph({ text: line }))
        }
      }

      if (pageBreak && i < paths.length - 1) {
        allChildren.push(new Paragraph({ children: [new PageBreak()] }))
      }
    }

    const doc = new Document({ sections: [{ children: allChildren }] })
    const buffer = await Packer.toBuffer(doc)
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, buffer)

    return {
      success: true,
      output: JSON.stringify({
        path: outputPath,
        mergedFiles: paths.length,
        size: buffer.length
      })
    }
  } catch (err) {
    return { success: false, error: `Merge failed: ${err.message}` }
  }
}

async function documentToc(args) {
  const filePath = resolvePath(args.path)
  const outputPath = resolvePath(args.output_path)
  const depth = args.depth || 3
  const title = args.title || 'Table of Contents'

  try {
    await checkFileSize(filePath)
    const buffer = await fs.readFile(filePath)
    const htmlResult = await mammoth.convertToHtml({ buffer })
    const html = htmlResult.value

    // Extract headings from HTML
    const headingRegex = /<h([1-6])[^>]*>(.*?)<\/h\1>/gi
    const headings = []
    let match
    while ((match = headingRegex.exec(html)) !== null) {
      const level = parseInt(match[1], 10)
      if (level <= depth) {
        const text = match[2].replace(/<[^>]+>/g, '')
        headings.push({ level, text })
      }
    }

    // Read original text
    const textResult = await mammoth.extractRawText({ buffer })
    const lines = textResult.value.split('\n').filter((l) => l.trim())

    // Build new document with TOC + original content
    const children = []
    children.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }))
    children.push(new Paragraph({ text: '' }))

    for (const h of headings) {
      const indent = (h.level - 1) * 360
      children.push(new Paragraph({
        text: `${'  '.repeat(h.level - 1)}${h.text}`,
        indent: { left: indent }
      }))
    }

    children.push(new Paragraph({ children: [new PageBreak()] }))

    for (const line of lines) {
      children.push(new Paragraph({ text: line }))
    }

    const doc = new Document({ sections: [{ children }] })
    const outputBuffer = await Packer.toBuffer(doc)
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, outputBuffer)

    return {
      success: true,
      output: JSON.stringify({
        path: outputPath,
        headingsFound: headings.length,
        depth
      })
    }
  } catch (err) {
    return { success: false, error: `TOC generation failed: ${err.message}` }
  }
}

async function documentMetadata(args) {
  const filePath = resolvePath(args.path)

  try {
    await checkFileSize(filePath)
    const zip = new AdmZip(filePath)

    if (args.action === 'read') {
      const coreXml = zip.readAsText('docProps/core.xml') || ''
      const metadata = {}
      const extract = (tag) => {
        const match = coreXml.match(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 's'))
        return match ? match[1].trim() : null
      }
      metadata.title = extract('dc:title')
      metadata.author = extract('dc:creator')
      metadata.subject = extract('dc:subject')
      metadata.description = extract('dc:description')
      metadata.keywords = extract('cp:keywords')
      metadata.created = extract('dcterms:created')
      metadata.modified = extract('dcterms:modified')
      metadata.lastModifiedBy = extract('cp:lastModifiedBy')

      return { success: true, output: JSON.stringify({ metadata }) }
    }

    if (args.action === 'set') {
      if (!args.output_path) return { success: false, error: 'output_path required for set action' }
      if (!args.metadata) return { success: false, error: 'metadata required for set action' }

      let metadata
      try {
        metadata = parseJsonParam(args.metadata, 'metadata')
      } catch (err) {
        return { success: false, error: err.message }
      }

      let coreXml = zip.readAsText('docProps/core.xml') || ''

      const setTag = (xml, tag, value) => {
        const re = new RegExp(`<${tag}[^>]*>.*?</${tag}>`, 's')
        if (re.test(xml)) {
          return xml.replace(re, `<${tag}>${escapeXml(value)}</${tag}>`)
        }
        return xml.replace('</cp:coreProperties>', `<${tag}>${escapeXml(value)}</${tag}></cp:coreProperties>`)
      }

      if (metadata.title) coreXml = setTag(coreXml, 'dc:title', metadata.title)
      if (metadata.author) coreXml = setTag(coreXml, 'dc:creator', metadata.author)
      if (metadata.subject) coreXml = setTag(coreXml, 'dc:subject', metadata.subject)
      if (metadata.description) coreXml = setTag(coreXml, 'dc:description', metadata.description)
      if (metadata.keywords) coreXml = setTag(coreXml, 'cp:keywords', metadata.keywords)

      zip.updateFile('docProps/core.xml', Buffer.from(coreXml, 'utf8'))
      const outputPath = resolvePath(args.output_path)
      await fs.mkdir(path.dirname(outputPath), { recursive: true })
      zip.writeZip(outputPath)

      return {
        success: true,
        output: JSON.stringify({ path: outputPath, metadataSet: Object.keys(metadata) })
      }
    }

    return { success: false, error: `Unknown action: ${args.action}` }
  } catch (err) {
    if (err.code === 'ENOENT') return { success: false, error: `File not found: ${filePath}` }
    return { success: false, error: `Metadata operation failed: ${err.message}` }
  }
}

async function documentCompare(args) {
  const pathA = resolvePath(args.path_a)
  const pathB = resolvePath(args.path_b)
  const format = args.format || 'text'

  try {
    const getContent = async (filePath) => {
      const ext = getExt(filePath)
      if (ext === '.docx') {
        const buffer = await fs.readFile(filePath)
        const result = await mammoth.extractRawText({ buffer })
        return result.value
      }
      return await fs.readFile(filePath, 'utf8')
    }

    const textA = await getContent(pathA)
    const textB = await getContent(pathB)

    const linesA = textA.split('\n')
    const linesB = textB.split('\n')

    // Simple line-by-line diff
    const additions = []
    const deletions = []
    const modifications = []

    const maxLen = Math.max(linesA.length, linesB.length)
    for (let i = 0; i < maxLen; i++) {
      const a = linesA[i]
      const b = linesB[i]
      if (a === undefined) {
        additions.push({ line: i + 1, content: b })
      } else if (b === undefined) {
        deletions.push({ line: i + 1, content: a })
      } else if (a !== b) {
        modifications.push({ line: i + 1, from: a, to: b })
      }
    }

    const diff = { additions, deletions, modifications, totalChanges: additions.length + deletions.length + modifications.length }

    if (format === 'html') {
      let html = '<div class="diff">'
      for (const d of deletions) html += `<p style="color:red;text-decoration:line-through">- ${escapeXml(d.content)}</p>`
      for (const a of additions) html += `<p style="color:green">+ ${escapeXml(a.content)}</p>`
      for (const m of modifications) html += `<p style="color:orange">~ ${escapeXml(m.from)} → ${escapeXml(m.to)}</p>`
      html += '</div>'
      diff.html = html
    }

    return { success: true, output: JSON.stringify(diff, null, 2) }
  } catch (err) {
    if (err.code === 'ENOENT') return { success: false, error: `File not found` }
    return { success: false, error: `Compare failed: ${err.message}` }
  }
}

async function documentExtractImages(args) {
  const filePath = resolvePath(args.path)
  const outputDir = resolvePath(args.output_dir)

  try {
    await checkFileSize(filePath)
    const zip = new AdmZip(filePath)
    await fs.mkdir(outputDir, { recursive: true })

    const entries = zip.getEntries()
    const extracted = []

    for (const entry of entries) {
      if (entry.entryName.startsWith('word/media/')) {
        const filename = path.basename(entry.entryName)
        const outPath = path.join(outputDir, filename)
        const data = entry.getData()
        await fs.writeFile(outPath, data)
        extracted.push({ path: outPath, name: filename, size: data.length })
      }
    }

    return {
      success: true,
      output: JSON.stringify({
        outputDir,
        imagesExtracted: extracted.length,
        images: extracted
      })
    }
  } catch (err) {
    if (err.code === 'ENOENT') return { success: false, error: `File not found: ${filePath}` }
    return { success: false, error: `Image extraction failed: ${err.message}` }
  }
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// ── document_validate ─────────────────────────────────────────────────────

const DOC_PLACEHOLDER = /\b(lorem|ipsum|TODO|FIXME|TBD|\[insert[^\]]*\]|xxxx+|your (?:name|title|company) here)\b/i

async function documentValidate(args) {
  const filePath = resolvePath(args.path)
  try {
    await fs.access(filePath)
    let zip
    try {
      zip = new AdmZip(filePath)
    } catch (err) {
      return { success: true, output: `INVALID — ${path.basename(filePath)} is not readable as a .docx (${err.message})` }
    }
    const names = new Set(zip.getEntries().map((e) => e.entryName))
    const errors = []
    const warnings = []

    for (const required of ['[Content_Types].xml', 'word/document.xml', '_rels/.rels']) {
      if (!names.has(required)) errors.push(`missing required part ${required}`)
    }
    if (errors.length) {
      return { success: true, output: `INVALID — ${path.basename(filePath)}\n${errors.map((e) => `  ERROR   ${e}`).join('\n')}` }
    }

    // Well-formedness, cheaply: balanced paragraph and run elements plus a
    // bare-ampersand scan, which is how a naive find/replace breaks a file.
    const doc = zip.readAsText('word/document.xml')
    for (const [tag, label] of [['w:p', 'paragraph'], ['w:r', 'run'], ['w:tbl', 'table'], ['w:tc', 'cell']]) {
      const opens = (doc.match(new RegExp(`<${tag}(?: [^>]*)?>`, 'g')) || []).length
      const closes = (doc.match(new RegExp(`</${tag}>`, 'g')) || []).length
      if (opens !== closes) errors.push(`word/document.xml: ${opens} ${label} element(s) opened, ${closes} closed — the XML is malformed`)
    }
    const bareAmp = doc.match(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g)
    if (bareAmp) errors.push(`word/document.xml: ${bareAmp.length} unescaped "&" — Word will refuse this file or offer to repair it`)
    for (const bad of ['<', '>']) void bad

    // Relationships must resolve, or Word reports the file as corrupt.
    for (const e of zip.getEntries()) {
      if (!/(^|\/)_rels\/.+\.rels$/.test(e.entryName)) continue
      const base = e.entryName.replace(/_rels\/[^/]+$/, '')
      for (const m of zip.readAsText(e).matchAll(/<Relationship\b[^>]*\/>/g)) {
        if (/TargetMode="External"/.test(m[0])) continue
        const target = /Target="([^"]+)"/.exec(m[0])?.[1]
        if (!target) continue
        const resolved = target.startsWith('/')
          ? target.slice(1)
          : path.posix.normalize(path.posix.join(base, target)).replace(/^\//, '')
        if (!names.has(resolved)) errors.push(`${e.entryName}: target "${target}" resolves to ${resolved}, which is not in the package`)
      }
    }

    const ct = zip.readAsText('[Content_Types].xml')
    if (!ct.includes('word/document.xml')) warnings.push('[Content_Types].xml has no override for word/document.xml')

    // Every style a paragraph references must exist, or Word silently falls
    // back to Normal and the document loses its design.
    const styleIds = new Set()
    if (names.has('word/styles.xml')) {
      for (const m of zip.readAsText('word/styles.xml').matchAll(/w:styleId="([^"]+)"/g)) styleIds.add(m[1])
    }
    const referenced = new Set([...doc.matchAll(/<w:pStyle w:val="([^"]+)"\/>/g)].map((m) => m[1]))
    const missing = [...referenced].filter((id) => !styleIds.has(id))
    if (missing.length) errors.push(`paragraph style(s) referenced but not defined: ${missing.join(', ')}`)

    if (referenced.size === 0) {
      warnings.push('no paragraph carries a named style — the document is direct-formatted, so nobody can restyle it and its headings reach neither the navigation pane nor a table of contents')
    }
    if (doc.includes('TOC \\h') || doc.includes('TOC \\o')) {
      const settings = names.has('word/settings.xml') ? zip.readAsText('word/settings.xml') : ''
      if (!/updateFields/.test(settings)) {
        warnings.push('the document has a table-of-contents field but settings.xml does not set updateFields — it will open blank')
      }
    }

    const text = [...doc.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => unescapeXmlText(m[1])).join(' ')
    if (!text.trim()) warnings.push('the document body carries no text')
    const ph = DOC_PLACEHOLDER.exec(text)
    if (ph) warnings.push(`leftover placeholder text — "${ph[0]}"`)

    const ok = errors.length === 0
    const head = ok
      ? `VALID — ${path.basename(filePath)}: ${(doc.match(/<w:p(?: [^>]*)?>/g) || []).length} paragraphs, ${referenced.size} named style(s) in use, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`
      : `INVALID — ${path.basename(filePath)}: ${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`
    const out = [head]
    for (const e of errors) out.push(`  ERROR   ${e}`)
    for (const w of warnings) out.push(`  WARNING ${w}`)
    if (ok && !warnings.length) out.push('  Structure, relationships, content types and style references all check out.')
    out.push('', ok
      ? 'Structure is sound. That is not the same as reading right — render it and look at the pages before you send it.'
      : 'Fix these in the generator or the modify call, not by hand-editing the packed XML, then validate again.')
    return { success: true, output: out.join('\n') }
  } catch (err) {
    return { success: false, error: `document_validate: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// ── document_render ───────────────────────────────────────────────────────

const DOC_SOFFICE = {
  darwin: ['/Applications/LibreOffice.app/Contents/MacOS/soffice', '/opt/homebrew/bin/soffice', '/usr/local/bin/soffice'],
  linux: ['/usr/bin/soffice', '/usr/local/bin/soffice', '/snap/bin/libreoffice', '/usr/bin/libreoffice'],
  win32: ['C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe']
}

async function findDocSoffice() {
  for (const candidate of DOC_SOFFICE[process.platform] ?? []) {
    try { await fs.access(candidate); return candidate } catch { /* next */ }
  }
  return null
}

function runDocProcess(cmd, cmdArgs, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: -1, err: `${err}\ntimed out after ${timeoutMs}ms` }) }, timeoutMs)
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, err: e.message }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, err }) })
  })
}

async function documentRender(args) {
  const filePath = resolvePath(args.path)
  try {
    await fs.access(filePath)
  } catch {
    return { success: false, error: `document_render: ${filePath} does not exist` }
  }
  const soffice = await findDocSoffice()
  if (!soffice) {
    return {
      success: false,
      error: 'document_render: LibreOffice is not installed, so the document cannot be rendered to pages here.\n' +
        'Two honest ways forward:\n' +
        '  1. Ask the user to install it (`brew install --cask libreoffice` on macOS) — then this tool works.\n' +
        '  2. Ship without a visual pass: run document_validate, read it back with document_read, and SAY in your reply that you verified structure and content but could not look at the rendered pages.\n' +
        'Do not claim a document is visually checked when it was not. Note that a table of contents is a field LibreOffice does not fill either — a blank TOC in the render is expected; Word fills it on open.'
    }
  }
  const outDir = resolvePath(args.output_dir || path.dirname(filePath))
  await fs.mkdir(outDir, { recursive: true })
  const profile = path.join(os.tmpdir(), `wolffish-soffice-doc-${process.pid}`)
  const { code, err } = await runDocProcess(soffice, [
    `-env:UserInstallation=file://${profile}`,
    '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', outDir, filePath
  ], Number(args.timeout_ms) || 120000)
  const pdfPath = path.join(outDir, `${path.basename(filePath, path.extname(filePath))}.pdf`)
  try {
    await fs.access(pdfPath)
  } catch {
    return { success: false, error: `document_render: LibreOffice exited ${code} without producing a PDF.\n${err.trim().slice(0, 600)}` }
  }
  return {
    success: true,
    output: `${pdfPath}\n\nNow LOOK at it: pdf_render_pages on this PDF, then image_view on each page. ` +
      'Widowed headings, a table that splits across a page break, and text overflowing a table cell are the defects that never show in the source.'
  }
}

// ── doc_design ────────────────────────────────────────────────────────────

const DOC_MANUAL_URL = new URL('../manual.md', import.meta.url)

async function docDesign() {
  try {
    const manual = await fs.readFile(DOC_MANUAL_URL, 'utf8')
    return { success: true, output: manual.trimEnd() }
  } catch (err) {
    return { success: false, error: `doc_design: could not read manual.md (${err instanceof Error ? err.message : String(err)})` }
  }
}

function describeAction(toolName, args) {
  const targetPath = String(args?.path || args?.output_path || args?.template_path || '')
  const basename = path.basename(targetPath)
  switch (toolName) {
    case 'document_read': return { title: 'Read Document', description: `Read ${basename}`, risk: 'low' }
    case 'document_create': return { title: 'Create Document', description: `Create ${basename}`, command: targetPath, risk: 'medium' }
    case 'document_modify': return { title: 'Modify Document', description: `Edit ${basename}`, command: targetPath, risk: 'medium' }
    case 'document_template': return { title: 'Fill Template', description: `Fill template ${basename}`, command: targetPath, risk: 'medium' }
    case 'document_convert': return { title: 'Convert Document', description: `Convert ${basename}`, command: targetPath, risk: 'medium' }
    case 'document_merge': return { title: 'Merge Documents', description: `Merge into ${basename}`, command: targetPath, risk: 'medium' }
    case 'document_toc': return { title: 'Generate TOC', description: `Add TOC to ${basename}`, command: targetPath, risk: 'medium' }
    case 'document_metadata': return { title: args?.action === 'read' ? 'Read Metadata' : 'Set Metadata', description: `${args?.action} metadata for ${basename}`, risk: args?.action === 'read' ? 'low' : 'medium' }
    case 'document_compare': return { title: 'Compare Documents', description: `Compare ${path.basename(String(args?.path_a || ''))} with ${path.basename(String(args?.path_b || ''))}`, risk: 'low' }
    case 'document_extract_images': return { title: 'Extract Images', description: `Extract images from ${basename}`, risk: 'low' }
    case 'document_validate': return { title: 'Validate Document', description: `Check ${basename}`, risk: 'low' }
    case 'document_render': return { title: 'Render Document', description: `Render ${basename} to PDF`, command: targetPath, risk: 'low' }
    default: return null
  }
}

const plugin = {
  name: 'document',
  tools: toolDefinitions,
  describeAction,
  async execute(toolName, args) {
    switch (toolName) {
      case 'document_read': return documentRead(args)
      case 'document_create': return documentCreate(args)
      case 'document_modify': return documentModify(args)
      case 'document_template': return documentTemplate(args)
      case 'document_convert': return documentConvert(args)
      case 'document_merge': return documentMerge(args)
      case 'document_toc': return documentToc(args)
      case 'document_metadata': return documentMetadata(args)
      case 'document_compare': return documentCompare(args)
      case 'document_extract_images': return documentExtractImages(args)
      case 'document_validate': return documentValidate(args)
      case 'document_render': return documentRender(args)
      case 'doc_design': return docDesign()
      default: return { success: false, error: `document: unknown tool ${toolName}` }
    }
  }
}

export default plugin
