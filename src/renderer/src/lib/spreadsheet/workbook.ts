/**
 * Workbook reader — joins two parsers, each doing what it is good at.
 *
 *   SheetJS  →  values, number-formatted text, merges, hyperlinks, formulas.
 *               All the fiddly value semantics (shared strings, inline strings,
 *               date serials) already work and are not worth reimplementing.
 *
 *   ours     →  fonts, fills, borders, alignment, real column geometry, frozen
 *               panes, gridline visibility — none of which SheetJS Community
 *               exposes.
 *
 * The join is the per-cell style index, which only exists in the raw sheet XML.
 * That document can be tens of megabytes, so it gets a targeted attribute scan
 * (~11 ms for 160k cells) rather than a DOM parse (~1450 ms for the same file).
 * The small pooled documents — styles.xml, theme1.xml — get real XML parsing,
 * because that is where correctness is won and they are ~5 KB regardless of how
 * big the sheet is.
 */

import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import { resolveColor } from './colors'
import { displayText, formatColor } from './format'
import {
  DEFAULT_COL_WIDTH_CH,
  DEFAULT_ROW_HEIGHT_PT,
  colWidthToPx,
  maxDigitWidth,
  rowHeightToPx
} from './metrics'
import {
  EMPTY_STYLE_TABLE,
  domXmlParser,
  parseStyleTable,
  type StyleTable,
  type XmlParser
} from './styles'
import {
  cellKey,
  type CellStyle,
  type FidelityTier,
  type Merge,
  type SheetCell,
  type SheetModel,
  type WorkbookModel
} from './types'

export type ReadOptions = {
  /** Clip the used range. Chat cards ask for a small slice; the full viewer asks for more. */
  maxRows?: number
  maxCols?: number
  /** Injected so tests can run under Node with xmldom. Defaults to DOMParser. */
  parseXml?: XmlParser
}

const DEFAULT_MAX_ROWS = 20000
const DEFAULT_MAX_COLS = 256

// ---------------------------------------------------------------------------
// Raw sheet-XML scans
//
// Regex is safe here and only here: these are flat, uniform tags whose *whole*
// text we capture before reading attributes off it. (The trap that bites is
// using a greedy `[^>]*` to delimit an element's *content* — see styles.ts.)
// ---------------------------------------------------------------------------

const TAG_ATTR = /([a-zA-Z:]+)="([^"]*)"/g

function tagAttrs(tagText: string): Record<string, string> {
  const out: Record<string, string> = {}
  TAG_ATTR.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG_ATTR.exec(tagText))) out[m[1]] = m[2]
  return out
}

function scanTags(xml: string, name: string): Record<string, string>[] {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?/?>`, 'g')
  const out: Record<string, string>[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) out.push(tagAttrs(m[0]))
  return out
}

/** One element, parsed properly — for the handful of singleton settings tags. */
function firstTagAttrs(xml: string, name: string): Record<string, string> | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?/?>`).exec(xml)
  return m ? tagAttrs(m[0]) : null
}

// ---------------------------------------------------------------------------
// Package layout
// ---------------------------------------------------------------------------

type SheetPart = { name: string; path: string }

async function readSheetParts(zip: JSZip, parseXml: XmlParser): Promise<SheetPart[]> {
  const wbFile = zip.file('xl/workbook.xml')
  const relFile = zip.file('xl/_rels/workbook.xml.rels')
  if (!wbFile || !relFile) return []

  const [wbXml, relXml] = await Promise.all([wbFile.async('string'), relFile.async('string')])

  const rels = new Map<string, string>()
  for (const r of scanTags(relXml, 'Relationship')) {
    if (r.Id && r.Target) rels.set(r.Id, r.Target)
  }

  // workbook.xml is small; parse it properly so sheet names with entities
  // (&amp;, &#39;) come back decoded rather than raw.
  let doc: Document | null = null
  try {
    doc = parseXml(wbXml)
  } catch {
    doc = null
  }

  const out: SheetPart[] = []
  const elements = doc ? Array.from(doc.getElementsByTagName('sheet')) : []
  const raw = scanTags(wbXml, 'sheet')

  const count = elements.length || raw.length
  for (let i = 0; i < count; i++) {
    const name = elements[i]?.getAttribute('name') ?? raw[i]?.name ?? `Sheet${i + 1}`
    const rid =
      elements[i]?.getAttribute('r:id') ?? elements[i]?.getAttribute('id') ?? raw[i]?.['r:id']
    const target = rid ? rels.get(rid) : undefined
    const path = target
      ? target.startsWith('/')
        ? target.slice(1)
        : `xl/${target.replace(/^\.\//, '')}`
      : `xl/worksheets/sheet${i + 1}.xml`
    out.push({ name, path })
  }
  return out
}

// ---------------------------------------------------------------------------
// Per-sheet geometry + style indices, read from the raw sheet XML
// ---------------------------------------------------------------------------

type SheetChrome = {
  styleByAddr: Map<string, number>
  rowStyle: Map<number, number>
  rowHeightPx: Map<number, number>
  hiddenRows: Set<number>
  colStyle: Map<number, number>
  colWidthPx: Map<number, number>
  hiddenCols: Set<number>
  defaultColWidthPx: number
  defaultRowHeightPx: number
  freeze: { x: number; y: number } | null
  gridlines: boolean
  tabColor: string | null
  rtl: boolean
}

function readSheetChrome(xml: string, styles: StyleTable, mdw: number): SheetChrome {
  const styleByAddr = new Map<string, number>()
  const rowStyle = new Map<number, number>()
  const rowHeightPx = new Map<number, number>()
  const hiddenRows = new Set<number>()
  const colStyle = new Map<number, number>()
  const colWidthPx = new Map<number, number>()
  const hiddenCols = new Set<number>()

  // Cells — the hot loop.
  const cellRe = /<c(?:\s[^>]*)?\/?>/g
  let m: RegExpExecArray | null
  while ((m = cellRe.exec(xml))) {
    const text = m[0]
    // Cheap pre-filter: most cells in a plain sheet carry no style index.
    if (text.indexOf(' s="') === -1) continue
    const a = tagAttrs(text)
    if (a.r && a.s != null) styleByAddr.set(a.r, Number(a.s))
  }

  for (const a of scanTags(xml, 'row')) {
    const r = Number(a.r)
    if (!Number.isFinite(r)) continue
    const idx = r - 1
    // A row-level style only applies when the row says so.
    if (a.s != null && (a.customFormat === '1' || a.customFormat === 'true')) {
      rowStyle.set(idx, Number(a.s))
    }
    if (a.ht != null) rowHeightPx.set(idx, rowHeightToPx(parseFloat(a.ht)))
    if (a.hidden === '1' || a.hidden === 'true') hiddenRows.add(idx)
  }

  const colsBlock = /<cols>[\s\S]*?<\/cols>/.exec(xml)?.[0] ?? ''
  for (const a of scanTags(colsBlock, 'col')) {
    const min = Number(a.min)
    const max = Number(a.max)
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue
    const width = a.width != null ? parseFloat(a.width) : null
    const px = width != null ? colWidthToPx(width, mdw) : null
    const hidden = a.hidden === '1' || a.hidden === 'true'
    // Spans can be enormous (min=1 max=16384); only materialise a sane range.
    const upper = Math.min(max, min + 1023)
    for (let c = min; c <= upper; c++) {
      const idx = c - 1
      if (px != null) colWidthPx.set(idx, px)
      if (a.style != null) colStyle.set(idx, Number(a.style))
      if (hidden) hiddenCols.add(idx)
    }
  }

  const fmt = firstTagAttrs(xml, 'sheetFormatPr')
  const defaultColWidthCh = fmt?.defaultColWidth
    ? parseFloat(fmt.defaultColWidth)
    : DEFAULT_COL_WIDTH_CH
  const defaultRowHeightPt = fmt?.defaultRowHeight
    ? parseFloat(fmt.defaultRowHeight)
    : DEFAULT_ROW_HEIGHT_PT

  const view = firstTagAttrs(xml, 'sheetView')
  const pane = firstTagAttrs(xml, 'pane')
  const freeze =
    pane && (pane.state === 'frozen' || pane.state === 'frozenSplit')
      ? { x: Number(pane.xSplit || 0) || 0, y: Number(pane.ySplit || 0) || 0 }
      : null

  const tabColorAttrs = firstTagAttrs(xml, 'tabColor')

  return {
    styleByAddr,
    rowStyle,
    rowHeightPx,
    hiddenRows,
    colStyle,
    colWidthPx,
    hiddenCols,
    defaultColWidthPx: colWidthToPx(defaultColWidthCh, mdw),
    defaultRowHeightPx: rowHeightToPx(defaultRowHeightPt),
    freeze: freeze && (freeze.x || freeze.y) ? freeze : null,
    gridlines: view?.showGridLines !== '0' && view?.showGridLines !== 'false',
    tabColor: tabColorAttrs
      ? resolveColor(
          {
            rgb: tabColorAttrs.rgb,
            theme: tabColorAttrs.theme,
            indexed: tabColorAttrs.indexed,
            tint: tabColorAttrs.tint
          },
          styles.palette
        )
      : null,
    rtl: view?.rightToLeft === '1' || view?.rightToLeft === 'true'
  }
}

// ---------------------------------------------------------------------------
// Model assembly
// ---------------------------------------------------------------------------

function buildSheet(
  name: string,
  ws: XLSX.WorkSheet | undefined,
  chrome: SheetChrome | null,
  styles: StyleTable,
  mdw: number,
  maxRows: number,
  maxCols: number
): SheetModel {
  const emptyChrome: SheetChrome = chrome ?? {
    styleByAddr: new Map(),
    rowStyle: new Map(),
    rowHeightPx: new Map(),
    hiddenRows: new Set(),
    colStyle: new Map(),
    colWidthPx: new Map(),
    hiddenCols: new Set(),
    defaultColWidthPx: colWidthToPx(DEFAULT_COL_WIDTH_CH, mdw),
    defaultRowHeightPx: rowHeightToPx(DEFAULT_ROW_HEIGHT_PT),
    freeze: null,
    gridlines: true,
    tabColor: null,
    rtl: false
  }

  const ref = ws?.['!ref']
  const range = ref ? XLSX.utils.decode_range(ref) : { s: { r: 0, c: 0 }, e: { r: -1, c: -1 } }
  const usedRows = Math.max(0, range.e.r + 1)
  const usedCols = Math.max(0, range.e.c + 1)
  const rows = Math.min(usedRows, maxRows)
  const cols = Math.min(usedCols, maxCols)
  const clipped = usedRows > rows || usedCols > cols

  const cells = new Map<string, SheetCell>()
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const addr = XLSX.utils.encode_cell({ r, c })
      const raw = ws?.[addr] as XLSX.CellObject | undefined
      const styleIndex = emptyChrome.styleByAddr.get(addr)
      if (!raw && styleIndex == null) continue

      const style =
        styleIndex != null
          ? styles.resolve(styleIndex)
          : resolveInherited(r, c, emptyChrome, styles)

      const type = (raw?.t ?? 'z') as SheetCell['type']
      const numFmt = style?.numFmt ?? (raw?.z as string | undefined) ?? null
      const value = raw?.v ?? null
      const text = raw ? displayText(raw.w, value, numFmt) : ''
      if (!text && styleIndex == null) continue

      cells.set(cellKey(r, c), {
        a: addr,
        r,
        c,
        text,
        raw: (value ?? null) as SheetCell['raw'],
        type,
        style,
        link: (raw?.l as { Target?: string } | undefined)?.Target ?? null,
        formula: (raw?.f as string | undefined) ?? null,
        negRed: formatColor(numFmt, value) === '#FF0000' && typeof value === 'number' && value < 0
      })
    }
  }

  // A .csv or a .xls carries no <col> geometry, so every column would fall back
  // to Excel's 8.43-character default and any long value would render as
  // `#####`. Faithful for a workbook that really asked for that width; useless
  // as a preview of a file that never specified one. Size those to content.
  const autoWidths = chrome ? null : autoSizeColumns(cells, rows, cols, mdw)

  const colWidthsPx: number[] = []
  for (let c = 0; c < cols; c++) {
    colWidthsPx.push(
      emptyChrome.hiddenCols.has(c)
        ? 0
        : (emptyChrome.colWidthPx.get(c) ?? autoWidths?.[c] ?? emptyChrome.defaultColWidthPx)
    )
  }
  const rowHeightsPx: number[] = []
  for (let r = 0; r < rows; r++) {
    rowHeightsPx.push(
      emptyChrome.hiddenRows.has(r)
        ? 0
        : (emptyChrome.rowHeightPx.get(r) ?? emptyChrome.defaultRowHeightPx)
    )
  }

  const merges: Merge[] = (ws?.['!merges'] ?? [])
    .map((m) => ({ r1: m.s.r, c1: m.s.c, r2: m.e.r, c2: m.e.c }))
    .filter((m) => m.r1 < rows && m.c1 < cols)

  return {
    name,
    rows,
    cols,
    cells,
    colWidthsPx,
    rowHeightsPx,
    merges,
    freeze: emptyChrome.freeze,
    gridlines: emptyChrome.gridlines,
    tabColor: emptyChrome.tabColor,
    clipped,
    rowStyles: mapStyles(emptyChrome.rowStyle, styles),
    colStyles: mapStyles(emptyChrome.colStyle, styles),
    rtl: emptyChrome.rtl
  }
}

/** Widest rendered text per column, in pixels, clamped to a readable range. */
function autoSizeColumns(
  cells: Map<string, SheetCell>,
  rows: number,
  cols: number,
  mdw: number
): number[] {
  const MIN = 56
  const MAX = 320
  const widest = new Array<number>(cols).fill(0)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const text = cells.get(cellKey(r, c))?.text
      if (text) widest[c] = Math.max(widest[c], text.length)
    }
  }
  // Excel's own conversion, so the result lines up with the `#####` threshold.
  return widest.map((chars) => Math.max(MIN, Math.min(MAX, colWidthToPx(chars + 1, mdw))))
}

function mapStyles(src: Map<number, number>, styles: StyleTable): Map<number, CellStyle> {
  const out = new Map<number, CellStyle>()
  for (const [k, idx] of src) {
    const s = styles.resolve(idx)
    if (s) out.set(k, s)
  }
  return out
}

/**
 * A cell's style is not always on the cell: Excel bands whole rows and formats
 * whole columns, and the style then lives on `<row s= customFormat="1">` or
 * `<col style=>`. First hit wins: cell → row → column → default.
 */
function resolveInherited(
  r: number,
  c: number,
  chrome: SheetChrome,
  styles: StyleTable
): CellStyle | null {
  const rowIdx = chrome.rowStyle.get(r)
  if (rowIdx != null) return styles.resolve(rowIdx)
  const colIdx = chrome.colStyle.get(c)
  if (colIdx != null) return styles.resolve(colIdx)
  return null
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function tierFor(fileName: string): FidelityTier {
  const ext = fileName.toLowerCase().split('.').pop() ?? ''
  if (ext === 'xlsx' || ext === 'xlsm' || ext === 'xltx') return 'full'
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') return 'plain'
  return 'values'
}

export async function readWorkbook(
  buffer: ArrayBuffer,
  fileName: string,
  options: ReadOptions = {}
): Promise<WorkbookModel> {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS
  const maxCols = options.maxCols ?? DEFAULT_MAX_COLS
  const parseXml = options.parseXml ?? domXmlParser
  const tier = tierFor(fileName)
  const bytes = new Uint8Array(buffer)

  const wb = XLSX.read(bytes, { type: 'array', cellStyles: true })

  // .xls and .csv have no styles.xml to read — values and number formats only.
  if (tier !== 'full') {
    const mdw = maxDigitWidth(null, 11)
    return {
      tier,
      sheets: wb.SheetNames.map((name) =>
        buildSheet(name, wb.Sheets[name], null, EMPTY_STYLE_TABLE, mdw, maxRows, maxCols)
      )
    }
  }

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    const mdw = maxDigitWidth(null, 11)
    return {
      tier: 'values',
      sheets: wb.SheetNames.map((name) =>
        buildSheet(name, wb.Sheets[name], null, EMPTY_STYLE_TABLE, mdw, maxRows, maxCols)
      )
    }
  }

  const [stylesXml, themeXml] = await Promise.all([
    zip.file('xl/styles.xml')?.async('string') ?? Promise.resolve(null),
    zip.file('xl/theme/theme1.xml')?.async('string') ?? Promise.resolve(null)
  ])

  const styles = parseStyleTable(stylesXml, themeXml, parseXml)

  // The workbook's normal font (cellXfs[0]) sets the max-digit-width that every
  // column measurement in the file is expressed in.
  const normal = styles.resolve(0)?.font
  const mdw = maxDigitWidth(normal?.name ?? null, normal?.size ?? 11)

  const parts = await readSheetParts(zip, parseXml)
  const sheets: SheetModel[] = []

  for (const part of parts) {
    const file = zip.file(part.path)
    const xml = file ? await file.async('string') : null
    const chrome = xml ? readSheetChrome(xml, styles, mdw) : null
    sheets.push(buildSheet(part.name, wb.Sheets[part.name], chrome, styles, mdw, maxRows, maxCols))
  }

  // A package we could not map back to workbook.xml still beats showing nothing.
  if (!sheets.length) {
    return {
      tier: 'values',
      sheets: wb.SheetNames.map((name) =>
        buildSheet(name, wb.Sheets[name], null, styles, mdw, maxRows, maxCols)
      )
    }
  }

  return { tier, sheets }
}
