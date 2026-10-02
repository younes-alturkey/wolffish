/**
 * OOXML colour resolution.
 *
 * Three landmines live in here, each of which fails silently:
 *
 *  1. The `rgb` attribute is documented as ARGB, but producers lie about the
 *     alpha byte — openpyxl writes `00RRGGBB` for fully opaque colours. Read as
 *     ARGB that is transparent, and the whole sheet renders blank. Excel itself
 *     ignores alpha on cell fills and fonts, so we drop the byte.
 *
 *  2. SpreadsheetML's `theme="N"` does NOT index the DrawingML `clrScheme` in
 *     document order: the first two entries are swapped. Body text is
 *     `theme="1"` in every Excel-authored file, so getting this backwards
 *     renders black text as white.
 *
 *  3. `tint` is applied on top of the resolved colour, not instead of it.
 */

/** SpreadsheetML theme index order — note lt1/dk1 and lt2/dk2 are swapped vs clrScheme. */
export const THEME_SLOT_ORDER = [
  'lt1',
  'dk1',
  'lt2',
  'dk2',
  'accent1',
  'accent2',
  'accent3',
  'accent4',
  'accent5',
  'accent6',
  'hlink',
  'folHlink'
] as const

/** The legacy 64-entry indexed palette (ECMA-376 §18.8.27). 64/65 are "auto". */
export const DEFAULT_INDEXED_COLORS: readonly string[] = [
  '000000',
  'FFFFFF',
  'FF0000',
  '00FF00',
  '0000FF',
  'FFFF00',
  'FF00FF',
  '00FFFF',
  '000000',
  'FFFFFF',
  'FF0000',
  '00FF00',
  '0000FF',
  'FFFF00',
  'FF00FF',
  '00FFFF',
  '800000',
  '008000',
  '000080',
  '808000',
  '800080',
  '008080',
  'C0C0C0',
  '808080',
  '9999FF',
  '993366',
  'FFFFCC',
  'CCFFFF',
  '660066',
  'FF8080',
  '0066CC',
  'CCCCFF',
  '000080',
  'FF00FF',
  'FFFF00',
  '00FFFF',
  '800080',
  '800000',
  '008080',
  '0000FF',
  '00CCFF',
  'CCFFFF',
  'CCFFCC',
  'FFFF99',
  '99CCFF',
  'FF99CC',
  'CC99FF',
  'FFCC99',
  '3366FF',
  '33CCCC',
  '99CC00',
  'FFCC00',
  'FF9900',
  'FF6600',
  '666699',
  '969696',
  '003366',
  '339966',
  '003300',
  '333300',
  '993300',
  '993366',
  '333399',
  '333333'
]

export type ColorAttrs = {
  rgb?: string | null
  theme?: string | null
  indexed?: string | null
  tint?: string | null
  auto?: string | null
}

export type Palette = {
  /** 12 entries in THEME_SLOT_ORDER; null where the theme omits a slot. */
  theme: (string | null)[]
  /** Overrides DEFAULT_INDEXED_COLORS when styles.xml carries `<indexedColors>`. */
  indexed: readonly string[]
}

export const EMPTY_PALETTE: Palette = { theme: [], indexed: DEFAULT_INDEXED_COLORS }

/** Strip the (unreliable) alpha byte from an 8-digit ARGB value. */
export function stripAlpha(hex: string): string {
  return (hex.length === 8 ? hex.slice(2) : hex).toUpperCase()
}

/**
 * OOXML tint: positive blends toward white, negative scales toward black.
 * `hex` is 6 digits, no leading '#'.
 */
export function applyTint(hex: string, tint: number): string {
  if (!tint) return hex
  const t = Math.max(-1, Math.min(1, tint))
  let out = ''
  for (let i = 0; i < 6; i += 2) {
    const v = parseInt(hex.slice(i, i + 2), 16)
    const next = t > 0 ? v * (1 - t) + 255 * t : v * (1 + t)
    out += Math.max(0, Math.min(255, Math.round(next)))
      .toString(16)
      .padStart(2, '0')
  }
  return out.toUpperCase()
}

/** Resolve one OOXML colour reference to `#RRGGBB`, or null when it says nothing. */
export function resolveColor(attrs: ColorAttrs | null, palette: Palette): string | null {
  if (!attrs) return null
  // `auto="1"` means "let the reader decide" — we hand that back as null so the
  // grid can pick a theme-appropriate ink instead of forcing black.
  if (attrs.auto === '1' || attrs.auto === 'true') return null

  let hex: string | null = null
  if (attrs.rgb) hex = stripAlpha(attrs.rgb)
  else if (attrs.theme != null && attrs.theme !== '')
    hex = palette.theme[Number(attrs.theme)] ?? null
  else if (attrs.indexed != null && attrs.indexed !== '') {
    const i = Number(attrs.indexed)
    // 64 = system foreground, 65 = system background: reader's choice.
    hex = i === 64 || i === 65 ? null : (palette.indexed[i] ?? null)
  }
  if (!hex) return null

  const tint = parseFloat(attrs.tint || '0')
  return '#' + applyTint(hex.toUpperCase(), Number.isFinite(tint) ? tint : 0)
}

// ---------------------------------------------------------------------------
// Contrast — used to keep a document's own ink legible on the app's surface
// ---------------------------------------------------------------------------

function channelLuminance(v: number): number {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance of `#RRGGBB`. */
export function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const r = channelLuminance(parseInt(h.slice(0, 2), 16))
  const g = channelLuminance(parseInt(h.slice(2, 4), 16))
  const b = channelLuminance(parseInt(h.slice(4, 6), 16))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two `#RRGGBB` colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Pick the ink for a cell, given whatever is actually behind it.
 *
 * Four cases, and all four matter:
 *
 *   colour + fill   The file chose both, so it owns the contrast decision and we
 *                   reproduce it exactly, in either theme.
 *   colour, no fill The cell sits on the app's surface — dark in dark mode — and
 *                   a document that hard-codes black body text would vanish.
 *                   Illegible ink falls back to the theme foreground.
 *   fill, no colour The file painted a background but left the text to the
 *                   reader. Excel picks ink that reads on *that fill*, so a pale
 *                   banded row stays black text in dark mode — using the theme
 *                   foreground here would put white on pale blue.
 *   neither         Plain theme surface, so plain theme foreground.
 */
export function resolveInk(
  fontColor: string | null,
  fill: string | null,
  surface: string,
  themeFg: string,
  minRatio = 2.5
): string {
  if (fontColor) {
    if (fill) return fontColor
    return contrastRatio(fontColor, surface) < minRatio ? themeFg : fontColor
  }
  if (!fill) return themeFg
  return luminance(fill) > 0.4 ? '#000000' : '#FFFFFF'
}
