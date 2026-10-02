/**
 * Geometry and typography — the part that decides whether a sheet renders the
 * same on macOS, Windows and Linux.
 *
 * Excel stores a column width in "characters", not pixels, and converts with
 *
 *     px = trunc(((256·w + trunc(128/MDW)) / 256) · MDW)
 *
 * where MDW is the *maximum digit width* of the workbook's normal font. SheetJS
 * hardcodes MDW = 6; Calibri 11 at 96 DPI is 7, so every column in a typical
 * workbook comes out ~14% too narrow (a 44-unit column renders 264px instead of
 * 308px) — enough on its own to break wrap-text layout.
 *
 * We measure MDW at runtime against the font that actually resolved on *this*
 * machine, which is both more accurate than a table and self-correcting when a
 * face is missing.
 */

/** Points → CSS pixels at the 96 DPI that OOXML assumes. */
export const PT_TO_PX = 96 / 72

/** Excel's default row height, in points. */
export const DEFAULT_ROW_HEIGHT_PT = 15

/** Excel's default column width, in characters. */
export const DEFAULT_COL_WIDTH_CH = 8.43

/**
 * Metric-compatible substitutions for the Office core fonts. Carlito, Caladea
 * and the Liberation family are OFL-licensed clones with identical advance
 * widths, so a file laid out in Calibri wraps in the same places wherever one of
 * them is installed. Keys are compared case-insensitively.
 */
const FONT_SUBSTITUTIONS: Record<string, string[]> = {
  calibri: ['Calibri', 'Carlito', 'Liberation Sans'],
  cambria: ['Cambria', 'Caladea', 'Liberation Serif'],
  arial: ['Arial', 'Liberation Sans', 'Helvetica'],
  helvetica: ['Helvetica', 'Liberation Sans', 'Arial'],
  'times new roman': ['Times New Roman', 'Liberation Serif', 'Times'],
  'courier new': ['Courier New', 'Liberation Mono', 'Courier'],
  consolas: ['Consolas', 'Liberation Mono', 'Menlo'],
  verdana: ['Verdana', 'DejaVu Sans'],
  tahoma: ['Tahoma', 'DejaVu Sans'],
  georgia: ['Georgia', 'Liberation Serif']
}

const GENERIC_SANS = 'ui-sans-serif, system-ui, sans-serif'

/** Build a CSS font stack for an OOXML font name, with metric-compatible fallbacks. */
export function fontStack(name: string | null | undefined): string {
  const requested = (name || '').trim()
  if (!requested) return `Calibri, Carlito, ${GENERIC_SANS}`
  const subs = FONT_SUBSTITUTIONS[requested.toLowerCase()]
  const chain = subs ? subs.slice() : [requested]
  return `${chain.map((f) => (/\s/.test(f) ? `'${f}'` : f)).join(', ')}, ${GENERIC_SANS}`
}

// ---------------------------------------------------------------------------
// Maximum digit width
// ---------------------------------------------------------------------------

const mdwCache = new Map<string, number>()

/** Fallback when there is no canvas (tests, SSR): Calibri 11 at 96 DPI. */
export const FALLBACK_MDW = 7

let measureCanvas: HTMLCanvasElement | null = null

/**
 * Maximum digit width in pixels for a font at a size, measured against whatever
 * face actually resolved. Excel rounds MDW to a whole pixel.
 */
export function maxDigitWidth(fontName: string | null, sizePt: number): number {
  const stack = fontStack(fontName)
  const key = `${stack}@${sizePt}`
  const cached = mdwCache.get(key)
  if (cached != null) return cached

  let mdw = FALLBACK_MDW
  try {
    if (typeof document !== 'undefined') {
      if (!measureCanvas) measureCanvas = document.createElement('canvas')
      const ctx = measureCanvas.getContext('2d')
      if (ctx) {
        ctx.font = `${sizePt}pt ${stack}`
        let widest = 0
        for (let d = 0; d <= 9; d++) widest = Math.max(widest, ctx.measureText(String(d)).width)
        if (widest > 0) mdw = Math.max(1, Math.round(widest))
      }
    }
  } catch {
    // Keep the fallback — a wrong-but-consistent MDW beats a crash.
  }

  mdwCache.set(key, mdw)
  return mdw
}

/** Exposed for tests; also lets a theme change re-measure. */
export function clearMetricsCache(): void {
  mdwCache.clear()
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

/** Excel's documented character-width → pixel conversion. */
export function colWidthToPx(widthCh: number, mdw: number): number {
  const m = mdw > 0 ? mdw : FALLBACK_MDW
  return Math.trunc(((256 * widthCh + Math.trunc(128 / m)) / 256) * m)
}

export function rowHeightToPx(heightPt: number): number {
  return Math.round(heightPt * PT_TO_PX)
}

/**
 * How many characters fit in a column — used to decide when a number has to
 * render as `#####`, the way Excel does.
 */
export function colCharCapacity(widthPx: number, mdw: number): number {
  const m = mdw > 0 ? mdw : FALLBACK_MDW
  // Excel reserves ~5px of cell padding (2px each side plus the gridline).
  return Math.max(0, Math.floor((widthPx - 5) / m))
}
