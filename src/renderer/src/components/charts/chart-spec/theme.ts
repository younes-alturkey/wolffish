/**
 * Chart theme — the fixed series palette plus chrome tokens read from the
 * app's CSS custom properties, so charts always match the current theme.
 *
 * The categorical slots are a validated set (colorblind-safe adjacent-pair
 * separation in BOTH modes, checked with a CVD simulator — not eyeballed).
 * The order IS the safety mechanism: series are assigned slots in order,
 * never cycled, never re-sorted. The same slots are documented for the agent
 * in the dataviz capability's manual.md — keep the two in sync.
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

function cssVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = styles.getPropertyValue(name).trim()
  return value.length > 0 ? value : fallback
}

/**
 * Read the current chart theme from the document. Called per render pass (the
 * plot re-reads when the app theme flips), so it must stay cheap.
 */
export function readChartTheme(isDark: boolean): ChartTheme {
  const styles = getComputedStyle(document.documentElement)
  return {
    isDark,
    palette: [...(isDark ? CHART_PALETTE_DARK : CHART_PALETTE_LIGHT)],
    fg: cssVar(styles, '--color-fg', isDark ? '#ffffff' : '#0d1117'),
    muted: cssVar(styles, '--color-muted', isDark ? '#8b95a7' : '#5b6778'),
    border: cssVar(styles, '--color-border', isDark ? '#2a313c' : '#d5dde5'),
    surface: cssVar(styles, '--color-surface', isDark ? '#161b22' : '#ffffff'),
    deemphasis: isDark ? CHART_DEEMPHASIS.dark : CHART_DEEMPHASIS.light,
    fontFamily:
      cssVar(styles, '--font-sans', '').replace(/^["']|["']$/g, '') ||
      'system-ui, -apple-system, sans-serif'
  }
}
