/**
 * Wolffish chart spec — the `.chart.json` contract between the agent and the
 * in-app interactive chart card. The agent authors a spec file (documented in
 * the dataviz capability's manual.md — keep the two in sync) and delivers it
 * with send_file; the renderer draws it via ECharts with the app theme.
 *
 * Parsing is deliberately lenient (strip-with-note philosophy): unknown
 * fields are ignored, values are coerced where safe, and only a spec with no
 * renderable content at all returns null (the card then falls back to a
 * plain file card).
 */

export const CHART_SPEC_TYPES = [
  'column',
  'bar',
  'line',
  'area',
  'pie',
  'donut',
  'scatter',
  'heatmap',
  'radar',
  'gauge',
  'funnel'
] as const

export type ChartSpecType = (typeof CHART_SPEC_TYPES)[number]

/** One named value, used by pie/donut/gauge/funnel series data. */
export type ChartNamedValue = { name: string; value: number }

export type ChartSeries = {
  name: string
  /**
   * Cartesian types: numbers (null = gap). Scatter: [x, y] or [x, y, size]
   * pairs. Pie/donut/gauge/funnel: { name, value } items. Heatmap:
   * [colIndex, rowIndex, value] triples.
   */
  data: Array<number | null | number[] | ChartNamedValue>
  /** Palette slot 1–8, or a raw hex color. Omit to auto-assign slots in order. */
  color?: number | string
  /** Series sharing a stack id stack together (columns/bars/areas). */
  stack?: string
}

export type ChartUnit = {
  prefix?: string
  suffix?: string
  decimals?: number
  /** Render 12400 as 12.4K / 1.2M / 3.4B. */
  compact?: boolean
}

export type ChartAxis = { name?: string; min?: number; max?: number }

export type ChartSpec = {
  type: ChartSpecType
  title: string
  subtitle?: string
  footnote?: string
  /** X labels (cartesian), indicator names (radar), column labels (heatmap). */
  categories?: string[]
  /** Heatmap row labels. */
  yCategories?: string[]
  series: ChartSeries[]
  stacked?: boolean
  smooth?: boolean
  unit?: ChartUnit
  xAxis?: ChartAxis
  yAxis?: ChartAxis
  /** Force the legend on/off; default shows it only for 2+ series. */
  legend?: boolean
  /** Plot height in px (default 320). */
  height?: number
  /** Raw ECharts option deep-merged last — the full-control escape hatch. */
  echarts?: Record<string, unknown>
}

const MIN_HEIGHT = 160
const MAX_HEIGHT = 720

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined
}

function asNumber(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined
  return v.map((item) => (typeof item === 'string' ? item : String(item ?? '')))
}

function asAxis(v: unknown): ChartAxis | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const o = v as Record<string, unknown>
  const axis: ChartAxis = {}
  const name = asString(o.name)
  if (name) axis.name = name
  const min = asNumber(o.min)
  if (min !== undefined) axis.min = min
  const max = asNumber(o.max)
  if (max !== undefined) axis.max = max
  return Object.keys(axis).length > 0 ? axis : undefined
}

function asDatum(v: unknown): number | null | number[] | ChartNamedValue | undefined {
  if (v === null) return null
  const n = asNumber(v)
  if (n !== undefined) return n
  if (Array.isArray(v)) {
    const nums = v.map(asNumber)
    if (nums.every((item): item is number => item !== undefined)) return nums
    return undefined
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    const value = asNumber(o.value)
    if (value !== undefined) return { name: asString(o.name) ?? '', value }
  }
  return undefined
}

function asSeries(v: unknown, index: number): ChartSeries | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (!Array.isArray(o.data)) return null
  const data = o.data
    .map(asDatum)
    .filter((item): item is number | null | number[] | ChartNamedValue => item !== undefined)
  if (data.length === 0) return null
  const series: ChartSeries = {
    name: asString(o.name) ?? `Series ${index + 1}`,
    data
  }
  if (typeof o.color === 'number' || typeof o.color === 'string') series.color = o.color
  const stack = asString(o.stack)
  if (stack) series.stack = stack
  return series
}

/**
 * Parse a `.chart.json` file's text into a renderable spec, or null when it
 * cannot possibly render (invalid JSON, no series data and no `echarts`
 * passthrough). A passthrough-only spec is legal — the model gets full
 * ECharts control while the card still supplies theme + chrome.
 */
export function parseChartSpec(text: string): ChartSpec | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>

  const typeRaw = asString(o.type)?.toLowerCase()
  const type = (CHART_SPEC_TYPES as readonly string[]).includes(typeRaw ?? '')
    ? (typeRaw as ChartSpecType)
    : 'column'

  const series = Array.isArray(o.series)
    ? o.series.map(asSeries).filter((s): s is ChartSeries => s !== null)
    : []

  const passthrough =
    typeof o.echarts === 'object' && o.echarts !== null && !Array.isArray(o.echarts)
      ? (o.echarts as Record<string, unknown>)
      : undefined

  if (series.length === 0 && !passthrough) return null

  const spec: ChartSpec = {
    type,
    title: asString(o.title) ?? '',
    series
  }
  const subtitle = asString(o.subtitle)
  if (subtitle) spec.subtitle = subtitle
  const footnote = asString(o.footnote)
  if (footnote) spec.footnote = footnote
  const categories = asStringArray(o.categories)
  if (categories) spec.categories = categories
  const yCategories = asStringArray(o.yCategories)
  if (yCategories) spec.yCategories = yCategories
  if (o.stacked === true) spec.stacked = true
  if (o.smooth === true) spec.smooth = true
  if (typeof o.legend === 'boolean') spec.legend = o.legend
  if (typeof o.unit === 'object' && o.unit !== null) {
    const u = o.unit as Record<string, unknown>
    const unit: ChartUnit = {}
    const prefix = asString(u.prefix)
    if (prefix) unit.prefix = prefix
    const suffix = asString(u.suffix)
    if (suffix) unit.suffix = suffix
    const decimals = asNumber(u.decimals)
    if (decimals !== undefined) unit.decimals = Math.max(0, Math.min(4, Math.round(decimals)))
    if (u.compact === true) unit.compact = true
    if (Object.keys(unit).length > 0) spec.unit = unit
  }
  const xAxis = asAxis(o.xAxis)
  if (xAxis) spec.xAxis = xAxis
  const yAxis = asAxis(o.yAxis)
  if (yAxis) spec.yAxis = yAxis
  const height = asNumber(o.height)
  if (height !== undefined) spec.height = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, height))
  if (passthrough) spec.echarts = passthrough
  return spec
}
