/**
 * Spreadsheet viewer model — the shape the grid renders.
 *
 * Built by `workbook.ts` from two sources that each do what they are good at:
 *   - SheetJS (already bundled) for values, number-formatted text, merges,
 *     hyperlinks and formulas;
 *   - our own OOXML reader (`styles.ts`) for fonts, fills, borders and
 *     alignment, which SheetJS Community does not expose.
 *
 * Deliberately sparse: `cells` is keyed `"row:col"` so a 1M-row sheet costs
 * memory proportional to the cells that actually exist.
 */

export type BorderSide = {
  /** OOXML border style: thin | medium | thick | hair | dashed | dotted | double … */
  style: string
  color: string | null
}

export type CellBorder = {
  top: BorderSide | null
  right: BorderSide | null
  bottom: BorderSide | null
  left: BorderSide | null
}

export type CellFont = {
  bold: boolean
  italic: boolean
  strike: boolean
  /** OOXML underline value ('single' | 'double' | …) or null when not underlined. */
  underline: string | null
  /** Points. */
  size: number
  name: string | null
  /** Resolved to `#RRGGBB`, or null when the file leaves it to the reader. */
  color: string | null
  /** 'superscript' | 'subscript' | null */
  vertAlign: string | null
}

export type CellFill = {
  /** OOXML patternType. 'none' and 'solid' are the only ones we paint. */
  pattern: string
  fg: string | null
  bg: string | null
}

export type CellAlign = {
  /** left | center | right | justify | fill | centerContinuous | distributed */
  h: string | null
  /** top | center | bottom | justify | distributed  (OOXML spells the middle one 'center') */
  v: string | null
  wrap: boolean
  indent: number
  /** Degrees, 0–180 in OOXML (180 = 90° down). */
  rotate: number
}

export type CellStyle = {
  font: CellFont | null
  fill: CellFill | null
  border: CellBorder | null
  align: CellAlign | null
  /** Resolved format code, e.g. '0.0%' or '#,##0.00;[Red](#,##0.00)'. */
  numFmt: string | null
}

export type CellType = 'n' | 's' | 'b' | 'e' | 'd' | 'z'

export type SheetCell = {
  /** A1-style address. */
  a: string
  /** 0-based. */
  r: number
  c: number
  /** Display text, already run through the number format. */
  text: string
  /** Underlying value, for the value bar and for copy. */
  raw: string | number | boolean | null
  type: CellType
  style: CellStyle | null
  link: string | null
  formula: string | null
  /** Number format asked for [Red] and the value is negative. */
  negRed: boolean
}

export type Merge = { r1: number; c1: number; r2: number; c2: number }

export type SheetModel = {
  name: string
  /** Used range, 0-based exclusive bounds. */
  rows: number
  cols: number
  cells: Map<string, SheetCell>
  colWidthsPx: number[]
  rowHeightsPx: number[]
  merges: Merge[]
  /** Frozen pane split, in cells. */
  freeze: { x: number; y: number } | null
  gridlines: boolean
  tabColor: string | null
  /** True when the used range was clipped by `maxRows`/`maxCols`. */
  clipped: boolean
  /**
   * Styles Excel put on a whole row or column rather than on each cell — banded
   * tables and formatted columns live here, including for positions that have no
   * cell element at all. The grid falls back to these when a cell has no style.
   */
  rowStyles: Map<number, CellStyle>
  colStyles: Map<number, CellStyle>
  /** The sheet itself is right-to-left (`<sheetView rightToLeft="1">`). */
  rtl: boolean
}

/**
 * How much of the file's own formatting survived:
 *   full   — .xlsx/.xlsm, styles read from the package
 *   values — .xls, values and number formats only (no styles.xml to read)
 *   plain  — .csv, values only
 */
export type FidelityTier = 'full' | 'values' | 'plain'

export type WorkbookModel = {
  sheets: SheetModel[]
  tier: FidelityTier
}

export const cellKey = (r: number, c: number): string => `${r}:${c}`
