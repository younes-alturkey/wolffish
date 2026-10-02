/**
 * OOXML style-table reader — the part SheetJS Community withholds.
 *
 * Styles in xlsx are *pooled*: `styles.xml` is ~5 KB whether the sheet has 160
 * cells or 160,000. So the tricky, nested, order-variable documents get real
 * XML parsing (a few milliseconds, bounded), and only the enormous flat sheet
 * XML gets a targeted attribute scan (see `workbook.ts`).
 *
 * Regex is NOT safe here: a greedy `[^>]*` consumes the `/` of a self-closing
 * `<xf …/>` and silently merges adjacent entries, shifting every style index
 * after it while the output still looks entirely plausible.
 */

import {
  DEFAULT_INDEXED_COLORS,
  EMPTY_PALETTE,
  THEME_SLOT_ORDER,
  resolveColor,
  type ColorAttrs,
  type Palette
} from './colors'
import type { BorderSide, CellAlign, CellBorder, CellFont, CellFill, CellStyle } from './types'

/** Parses an XML string to a Document. The renderer passes DOMParser; tests inject one. */
export type XmlParser = (xml: string) => Document

export const domXmlParser: XmlParser = (xml) =>
  new DOMParser().parseFromString(xml, 'application/xml')

// ---------------------------------------------------------------------------
// Small DOM helpers. `getElementsByTagName` matches on the qualified name, so
// namespace prefixes have to be tried explicitly (theme XML uses `a:`).
// ---------------------------------------------------------------------------

function firstTag(parent: Element | Document | null, ...names: string[]): Element | null {
  if (!parent) return null
  for (const n of names) {
    const found = parent.getElementsByTagName(n)
    if (found.length) return found[0]
  }
  return null
}

/** Direct children by local name — pooled tables must not pick up nested matches. */
function children(parent: Element | null, name: string): Element[] {
  if (!parent) return []
  const out: Element[] = []
  for (let n = parent.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && localName(n as Element) === name) out.push(n as Element)
  }
  return out
}

function localName(el: Element): string {
  const n = el.nodeName
  const i = n.indexOf(':')
  return i === -1 ? n : n.slice(i + 1)
}

function attr(el: Element | null, name: string): string | null {
  return el ? el.getAttribute(name) : null
}

/** OOXML booleans: the element's presence means true unless val says otherwise. */
function boolChild(parent: Element, name: string): boolean {
  const el = children(parent, name)[0]
  if (!el) return false
  const v = el.getAttribute('val')
  return v === null || v === '1' || v === 'true'
}

function colorAttrs(el: Element | null): ColorAttrs | null {
  if (!el) return null
  return {
    rgb: el.getAttribute('rgb'),
    theme: el.getAttribute('theme'),
    indexed: el.getAttribute('indexed'),
    tint: el.getAttribute('tint'),
    auto: el.getAttribute('auto')
  }
}

// ---------------------------------------------------------------------------
// Theme palette
// ---------------------------------------------------------------------------

export function parseThemePalette(themeXml: string | null, parseXml: XmlParser): (string | null)[] {
  if (!themeXml) return []
  let doc: Document
  try {
    doc = parseXml(themeXml)
  } catch {
    return []
  }
  const scheme = firstTag(doc, 'a:clrScheme', 'clrScheme')
  if (!scheme) return []
  return THEME_SLOT_ORDER.map((slot) => {
    const node = firstTag(scheme, `a:${slot}`, slot)
    if (!node) return null
    const srgb = firstTag(node, 'a:srgbClr', 'srgbClr')
    if (srgb) return (attr(srgb, 'val') || '').toUpperCase() || null
    // <a:sysClr val="windowText" lastClr="000000"/> — lastClr is the baked value.
    const sys = firstTag(node, 'a:sysClr', 'sysClr')
    if (sys) return (attr(sys, 'lastClr') || '').toUpperCase() || null
    return null
  })
}

// ---------------------------------------------------------------------------
// Style table
// ---------------------------------------------------------------------------

type Xf = {
  fontId: number
  fillId: number
  borderId: number
  numFmtId: string
  align: CellAlign | null
}

export type StyleTable = {
  palette: Palette
  /** Resolve a cellXfs index to a renderable style. Out-of-range falls back to xf 0. */
  resolve: (index: number) => CellStyle | null
  /** Number of cellXfs entries — used by tests and diagnostics. */
  size: number
}

export const EMPTY_STYLE_TABLE: StyleTable = {
  palette: EMPTY_PALETTE,
  resolve: () => null,
  size: 0
}

/** Built-in number formats we need by id; the rest arrive as `<numFmt>` entries. */
const BUILTIN_NUM_FMTS: Record<string, string> = {
  '0': 'General',
  '1': '0',
  '2': '0.00',
  '3': '#,##0',
  '4': '#,##0.00',
  '9': '0%',
  '10': '0.00%',
  '11': '0.00E+00',
  '12': '# ?/?',
  '13': '# ??/??',
  '14': 'm/d/yy',
  '15': 'd-mmm-yy',
  '16': 'd-mmm',
  '17': 'mmm-yy',
  '18': 'h:mm AM/PM',
  '19': 'h:mm:ss AM/PM',
  '20': 'h:mm',
  '21': 'h:mm:ss',
  '22': 'm/d/yy h:mm',
  '37': '#,##0 ;(#,##0)',
  '38': '#,##0 ;[Red](#,##0)',
  '39': '#,##0.00;(#,##0.00)',
  '40': '#,##0.00;[Red](#,##0.00)',
  '45': 'mm:ss',
  '46': '[h]:mm:ss',
  '47': 'mmss.0',
  '48': '##0.0E+0',
  '49': '@'
}

export function parseStyleTable(
  stylesXml: string | null,
  themeXml: string | null,
  parseXml: XmlParser
): StyleTable {
  if (!stylesXml) return EMPTY_STYLE_TABLE

  let doc: Document
  try {
    doc = parseXml(stylesXml)
  } catch {
    return EMPTY_STYLE_TABLE
  }

  const themeColors = parseThemePalette(themeXml, parseXml)

  // styles.xml may override the legacy palette wholesale.
  const indexedEl = firstTag(doc, 'indexedColors')
  const indexed = indexedEl
    ? children(indexedEl, 'rgbColor').map((c) => {
        const v = attr(c, 'rgb') || '000000'
        return (v.length === 8 ? v.slice(2) : v).toUpperCase()
      })
    : DEFAULT_INDEXED_COLORS
  const palette: Palette = {
    theme: themeColors,
    indexed: indexed.length ? indexed : DEFAULT_INDEXED_COLORS
  }

  const fonts: CellFont[] = children(firstTag(doc, 'fonts'), 'font').map((f) => {
    const u = children(f, 'u')[0]
    return {
      bold: boolChild(f, 'b'),
      italic: boolChild(f, 'i'),
      strike: boolChild(f, 'strike'),
      underline: u ? u.getAttribute('val') || 'single' : null,
      size: parseFloat(attr(children(f, 'sz')[0], 'val') || '11') || 11,
      name: attr(children(f, 'name')[0] ?? children(f, 'rFont')[0], 'val'),
      color: resolveColor(colorAttrs(children(f, 'color')[0]), palette),
      vertAlign: attr(children(f, 'vertAlign')[0], 'val')
    }
  })

  const fills: CellFill[] = children(firstTag(doc, 'fills'), 'fill').map((f) => {
    const pf = children(f, 'patternFill')[0]
    const grad = children(f, 'gradientFill')[0]
    if (grad) {
      // Gradients are rare; approximate with the first stop so the cell is not blank.
      const stop = firstTag(grad, 'color')
      return { pattern: 'solid', fg: resolveColor(colorAttrs(stop), palette), bg: null }
    }
    if (!pf) return { pattern: 'none', fg: null, bg: null }
    return {
      pattern: attr(pf, 'patternType') || 'none',
      fg: resolveColor(colorAttrs(children(pf, 'fgColor')[0]), palette),
      bg: resolveColor(colorAttrs(children(pf, 'bgColor')[0]), palette)
    }
  })

  const borders: CellBorder[] = children(firstTag(doc, 'borders'), 'border').map((b) => {
    const side = (name: string): BorderSide | null => {
      const el = children(b, name)[0]
      const style = attr(el, 'style')
      if (!el || !style) return null
      return { style, color: resolveColor(colorAttrs(children(el, 'color')[0]), palette) }
    }
    return { top: side('top'), right: side('right'), bottom: side('bottom'), left: side('left') }
  })

  const numFmts: Record<string, string> = { ...BUILTIN_NUM_FMTS }
  for (const nf of children(firstTag(doc, 'numFmts'), 'numFmt')) {
    const id = attr(nf, 'numFmtId')
    const code = attr(nf, 'formatCode')
    if (id && code != null) numFmts[id] = code
  }

  // Own ids always. Excel's `applyFont`/`applyFill` flags can redirect a cellXfs
  // entry at its named style in cellStyleXfs, but every producer seen in the wild
  // (openpyxl, ExcelJS, SheetJS) omits the flags while still meaning its own ids —
  // and this matches ExcelJS across the whole differential corpus. Inheritance is
  // deliberately not guessed at until there is an Excel-authored fixture to pin it.
  const xfs: Xf[] = children(firstTag(doc, 'cellXfs'), 'xf').map((x) => {
    const a = children(x, 'alignment')[0]
    return {
      fontId: Number(attr(x, 'fontId') || 0),
      fillId: Number(attr(x, 'fillId') || 0),
      borderId: Number(attr(x, 'borderId') || 0),
      numFmtId: attr(x, 'numFmtId') || '0',
      align: a
        ? {
            h: attr(a, 'horizontal'),
            v: attr(a, 'vertical'),
            wrap: attr(a, 'wrapText') === '1' || attr(a, 'wrapText') === 'true',
            indent: Number(attr(a, 'indent') || 0),
            rotate: Number(attr(a, 'textRotation') || 0)
          }
        : null
    }
  })

  const cache = new Map<number, CellStyle | null>()

  const resolve = (index: number): CellStyle | null => {
    if (cache.has(index)) return cache.get(index) ?? null
    const xf = xfs[index] ?? xfs[0]
    let style: CellStyle | null = null
    if (xf) {
      const fmt = numFmts[xf.numFmtId]
      style = {
        font: fonts[xf.fontId] ?? null,
        fill: fills[xf.fillId] ?? null,
        border: borders[xf.borderId] ?? null,
        align: xf.align,
        numFmt: fmt && fmt !== 'General' ? fmt : null
      }
    }
    cache.set(index, style)
    return style
  }

  return { palette, resolve, size: xfs.length }
}
