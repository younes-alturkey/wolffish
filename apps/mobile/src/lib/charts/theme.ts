import { tokensFor } from '@/lib/theme/colors'

/**
 * Chart theme — the fixed series palette plus chrome tokens, mirroring
 * wolffish-app `src/renderer/src/components/charts/chart-spec/theme.ts`.
 * The desktop reads its chrome from CSS custom properties at render time;
 * mobile's tokens are static (lib/theme/colors.ts mirrors the same
 * global.css values), so this resolves to identical colors.
 *
 * The categorical slots are a validated set (colorblind-safe adjacent-pair
 * separation in BOTH modes, checked with a CVD simulator — not eyeballed).
 * The order IS the safety mechanism: series are assigned slots in order,
 * never cycled, never re-sorted. Keep the palettes byte-identical to the
 * desktop's — they are the same contract the agent's dataviz manual documents.
 */

export const CHART_PALETTE_LIGHT = [
  '#2a78d6', // 1 blue
  '#eb6834', // 2 orange
  '#1baf7a', // 3 aqua
  '#eda100', // 4 yellow
  '#e87ba4', // 5 magenta
  '#008300', // 6 green
  '#4a3aa7', // 7 violet
  '#e34948' // 8 red
] as const

export const CHART_PALETTE_DARK = [
  '#3987e5', // 1 blue
  '#d95926', // 2 orange
  '#199e70', // 3 aqua
  '#c98500', // 4 yellow
  '#d55181', // 5 magenta
  '#008300', // 6 green
  '#9085e9', // 7 violet
  '#e66767' // 8 red
] as const

/** One-hue magnitude ramp (heatmaps, sequential fills), light → dark. */
export const CHART_SEQUENTIAL_BLUES = [
  '#cde2fb',
  '#9ec5f4',
  '#6da7ec',
  '#3987e5',
  '#256abf',
  '#184f95',
  '#0d366b'
] as const

/** Context / "Other" series and unfilled tracks. */
export const CHART_DEEMPHASIS = { light: '#c9cdd4', dark: '#4a4f58' } as const

/**
 * The family name declared by the chart page's inline @font-face (the app's
 * IBM Plex Sans Arabic regular weight), with the desktop's fallback stack.
 */
export const CHART_FONT_FAMILY = "'IBM Plex Sans Arabic', system-ui, -apple-system, sans-serif"

export type ChartTheme = {
  isDark: boolean
  palette: string[]
  /** Primary text (values, emphasized labels). */
  fg: string
  /** Secondary text (axis labels, legend, captions). */
  muted: string
  /** Hairline gridlines and axis lines. */
  border: string
  /** Card surface — also the gap/ring color separating touching marks. */
  surface: string
  deemphasis: string
  fontFamily: string
}

/** The chart theme for the active scheme — cheap enough to call per render. */
export function chartThemeFor(isDark: boolean): ChartTheme {
  const tokens = tokensFor(isDark)
  return {
    isDark,
    palette: [...(isDark ? CHART_PALETTE_DARK : CHART_PALETTE_LIGHT)],
    fg: tokens.fg,
    muted: tokens.muted,
    border: tokens.border,
    surface: tokens.surface,
    deemphasis: isDark ? CHART_DEEMPHASIS.dark : CHART_DEEMPHASIS.light,
    fontFamily: CHART_FONT_FAMILY
  }
}
