/**
 * Spec → ECharts option. This mapper is where the house chart style lives:
 * thin rounded-end bars, 2px lines with surface-ringed markers, hairline
 * solid gridlines, muted axis text, legend only for 2+ series, themed
 * tooltips, and the fixed palette slots. A minimal agent spec comes out
 * styled; the `echarts` passthrough deep-merges last for full control.
 */
import type { ChartNamedValue, ChartSeries, ChartSpec, ChartUnit } from './spec'
import { CHART_SEQUENTIAL_BLUES, type ChartTheme } from './theme'

type Obj = Record<string, unknown>

/** Objects merge recursively; arrays and primitives replace. */
export function deepMerge(base: Obj, patch: Obj): Obj {
  const out: Obj = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const prev = out[key]
    if (
      typeof prev === 'object' &&
      prev !== null &&
      !Array.isArray(prev) &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      out[key] = deepMerge(prev as Obj, value as Obj)
    } else {
      out[key] = value
    }
  }
  return out
}

export function formatChartValue(value: number, unit?: ChartUnit): string {
  const prefix = unit?.prefix ?? ''
  const suffix = unit?.suffix ?? ''
  const abs = Math.abs(value)
  if (unit?.compact) {
    const decimals = unit.decimals ?? 1
    const compactOne = (v: number, div: number, mark: string): string => {
      const scaled = v / div
      const text = scaled.toFixed(decimals).replace(/\.0+$/, '')
      return `${text}${mark}`
    }
    if (abs >= 1e12) return `${prefix}${compactOne(value, 1e12, 'T')}${suffix}`
    if (abs >= 1e9) return `${prefix}${compactOne(value, 1e9, 'B')}${suffix}`
    if (abs >= 1e6) return `${prefix}${compactOne(value, 1e6, 'M')}${suffix}`
    if (abs >= 1e3) return `${prefix}${compactOne(value, 1e3, 'K')}${suffix}`
  }
  const decimals = unit?.decimals ?? (Number.isInteger(value) ? 0 : 1)
  return `${prefix}${value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  })}${suffix}`
}

function seriesColor(series: ChartSeries, index: number, theme: ChartTheme): string {
  if (typeof series.color === 'string' && series.color.trim().length > 0) return series.color
  if (typeof series.color === 'number' && series.color >= 1 && series.color <= 8) {
    return theme.palette[series.color - 1]
  }
  return theme.palette[index % theme.palette.length]
}

function numericValues(spec: ChartSpec): number[] {
  const values: number[] = []
  for (const series of spec.series) {
    for (const datum of series.data) {
      if (typeof datum === 'number') values.push(datum)
      else if (Array.isArray(datum)) for (const n of datum) values.push(n)
      else if (datum && typeof datum === 'object') values.push((datum as ChartNamedValue).value)
    }
  }
  return values
}

function axisText(theme: ChartTheme): Obj {
  return { color: theme.muted, fontSize: 11, fontFamily: theme.fontFamily }
}

function baseTooltip(spec: ChartSpec, theme: ChartTheme, trigger: 'axis' | 'item'): Obj {
  return {
    trigger,
    backgroundColor: theme.surface,
    borderColor: theme.border,
    borderWidth: 1,
    padding: [8, 12],
    textStyle: { color: theme.fg, fontSize: 12, fontFamily: theme.fontFamily },
    extraCssText: 'box-shadow: 0 4px 16px rgba(0,0,0,0.12); border-radius: 8px;',
    valueFormatter: (value: unknown) =>
      typeof value === 'number' ? formatChartValue(value, spec.unit) : String(value ?? ''),
    ...(trigger === 'axis'
      ? { axisPointer: { type: 'line', lineStyle: { color: theme.border, width: 1 } } }
      : {})
  }
}

function baseLegend(spec: ChartSpec, theme: ChartTheme): Obj {
  const show = spec.legend ?? spec.series.length > 1
  // No `icon` override: ECharts mirrors each series' mark in its legend key
  // (rect for bars/pies, line+marker for lines) — the identity channel the
  // dataviz method wants.
  return {
    show,
    bottom: 0,
    left: 'center',
    itemWidth: 14,
    itemHeight: 9,
    itemGap: 16,
    textStyle: { color: theme.muted, fontSize: 11, fontFamily: theme.fontFamily }
  }
}

/**
 * Estimated rows the bottom legend wraps to at a plot width. ECharts wraps a
 * horizontal legend at layout time, but the grid inset is fixed at option
 * time — an unaccounted second row lands on the x-axis labels (seen at
 * phone-card widths with three long series names). Text is estimated at
 * fontSize 11 as ~7.5px per Latin glyph, ~11px otherwise — calibrated a
 * touch wide against on-device wrapping, so a borderline row wraps in the
 * estimate before it wraps on canvas; the overshoot costs one row of plot
 * height, an underestimate recreates the overlap. Unknown width reports one
 * row, the pre-existing inset.
 */
function legendRows(names: string[], width?: number): number {
  if (!width || width <= 0 || names.length === 0) return 1
  const usable = Math.max(width - 16, 40)
  let rows = 1
  let x = 0
  for (const name of names) {
    let text = 0
    for (const ch of name) text += (ch.codePointAt(0) ?? 0) <= 0x2ff ? 7.5 : 11
    const item = 14 + 5 + Math.ceil(text) // icon + icon-text gap + label
    if (x === 0) x = item
    else if (x + 16 + item <= usable)
      x += 16 + item // itemGap between items
    else {
      rows += 1
      x = item
    }
  }
  return rows
}

const CARTESIAN_TYPES = new Set(['column', 'bar', 'line', 'area', 'scatter'])

/**
 * Rows this spec's bottom legend needs at this width — the resize boundary at
 * which the grid inset (and so the whole option) must be rebuilt. Only
 * cartesian charts inset a grid; every other type reports 1 so width changes
 * never force a rebuild.
 */
export function chartLegendRows(spec: ChartSpec, width?: number): number {
  if (!CARTESIAN_TYPES.has(spec.type)) return 1
  const show = spec.legend ?? spec.series.length > 1
  if (!show) return 1
  return legendRows(
    spec.series.map((series) => series.name),
    width
  )
}

function baseGrid(hasLegend: boolean, legendRowCount = 1): Obj {
  return {
    left: 8,
    right: 16,
    top: 14,
    // One row keeps the long-standing 34; each wrapped row adds its height.
    bottom: hasLegend ? 10 + legendRowCount * 24 : 10,
    containLabel: true
  }
}

function categoryAxis(spec: ChartSpec, theme: ChartTheme, boundaryGap: boolean): Obj {
  return {
    type: 'category',
    data: spec.categories ?? [],
    boundaryGap,
    name: spec.xAxis?.name,
    nameTextStyle: axisText(theme),
    axisTick: { show: false },
    axisLine: { lineStyle: { color: theme.border } },
    axisLabel: { ...axisText(theme), hideOverlap: true }
  }
}

function valueAxis(spec: ChartSpec, theme: ChartTheme): Obj {
  return {
    type: 'value',
    name: spec.yAxis?.name,
    nameTextStyle: axisText(theme),
    min: spec.yAxis?.min,
    max: spec.yAxis?.max,
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: theme.border, width: 1, type: 'solid' } },
    axisLabel: {
      ...axisText(theme),
      formatter: (value: number) =>
        formatChartValue(value, { ...spec.unit, compact: spec.unit?.compact ?? true })
    }
  }
}

/** Round-cap the data end of a bar; square at the baseline. */
function barRadius(horizontal: boolean): number[] {
  return horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0]
}

function cartesianSeries(spec: ChartSpec, theme: ChartTheme): Obj[] {
  const horizontal = spec.type === 'bar'
  return spec.series.map((series, index) => {
    const color = seriesColor(series, index, theme)
    const stack = series.stack ?? (spec.stacked ? 'stack' : undefined)
    if (spec.type === 'column' || spec.type === 'bar') {
      return {
        name: series.name,
        type: 'bar',
        data: series.data,
        stack,
        barMaxWidth: 28,
        itemStyle: {
          color,
          borderRadius: stack ? 0 : barRadius(horizontal),
          // The surface-color border is the 2px-gap effect between touching
          // stack segments; standalone bars get the rounded data-end instead.
          ...(stack ? { borderColor: theme.surface, borderWidth: 1 } : {})
        }
      }
    }
    if (spec.type === 'scatter') {
      return {
        name: series.name,
        type: 'scatter',
        data: series.data,
        symbolSize: (value: unknown) =>
          Array.isArray(value) && typeof value[2] === 'number'
            ? Math.max(8, Math.min(40, Math.sqrt(value[2]) * 4))
            : 10,
        itemStyle: { color, borderColor: theme.surface, borderWidth: 2 }
      }
    }
    // line / area
    const pointCount = series.data.length
    return {
      name: series.name,
      type: 'line',
      data: series.data,
      stack: spec.type === 'area' ? stack : undefined,
      smooth: spec.smooth ? 0.3 : false,
      lineStyle: { color, width: 2 },
      symbol: 'circle',
      symbolSize: 7,
      showSymbol: pointCount <= 30,
      itemStyle: { color, borderColor: theme.surface, borderWidth: 2 },
      ...(spec.type === 'area'
        ? { areaStyle: { color, opacity: spec.stacked || series.stack ? 0.18 : 0.12 } }
        : {}),
      emphasis: { focus: spec.series.length > 1 ? 'series' : 'none' }
    }
  })
}

function cartesianOption(spec: ChartSpec, theme: ChartTheme, width?: number): Obj {
  const horizontal = spec.type === 'bar'
  const boundaryGap = spec.type === 'column' || spec.type === 'bar'
  const legend = baseLegend(spec, theme)
  const category = categoryAxis(spec, theme, boundaryGap)
  const value = valueAxis(spec, theme)
  // Scatter without categories plots numeric x directly.
  const numericX = spec.type === 'scatter' && !spec.categories
  const xAxis = horizontal ? value : numericX ? { ...value, name: spec.xAxis?.name } : category
  const yAxis = horizontal ? category : value
  return {
    color: theme.palette,
    tooltip: baseTooltip(spec, theme, spec.type === 'scatter' ? 'item' : 'axis'),
    legend,
    grid: baseGrid(legend.show === true, chartLegendRows(spec, width)),
    xAxis,
    yAxis,
    series: cartesianSeries(spec, theme)
  }
}

function namedData(series: ChartSeries | undefined): ChartNamedValue[] {
  if (!series) return []
  return series.data.filter(
    (item): item is ChartNamedValue =>
      typeof item === 'object' && item !== null && !Array.isArray(item)
  )
}

function pieOption(spec: ChartSpec, theme: ChartTheme): Obj {
  const donut = spec.type === 'donut'
  const data = namedData(spec.series[0])
  const legend = { ...baseLegend(spec, theme), show: spec.legend ?? data.length > 1 }
  return {
    color: theme.palette,
    tooltip: {
      ...baseTooltip(spec, theme, 'item'),
      formatter: (params: { name: string; value: number; percent: number }) =>
        `${params.name}  <b>${formatChartValue(params.value, spec.unit)}</b>  ·  ${params.percent}%`
    },
    legend,
    series: [
      {
        name: spec.series[0]?.name ?? spec.title,
        type: 'pie',
        radius: donut ? ['52%', '76%'] : '72%',
        center: ['50%', legend.show ? '46%' : '50%'],
        data: [...data].sort((a, b) => b.value - a.value),
        itemStyle: { borderColor: theme.surface, borderWidth: 2 },
        label: {
          color: theme.muted,
          fontSize: 11,
          fontFamily: theme.fontFamily,
          formatter: '{b} · {d}%'
        },
        labelLine: { lineStyle: { color: theme.border } },
        emphasis: { scaleSize: 4 }
      }
    ]
  }
}

function heatmapOption(spec: ChartSpec, theme: ChartTheme): Obj {
  const values = numericValues(spec)
  const min = spec.yAxis?.min ?? Math.min(0, ...values)
  const max = spec.yAxis?.max ?? Math.max(...values, 1)
  return {
    tooltip: {
      ...baseTooltip(spec, theme, 'item'),
      formatter: (params: { value: number[] }) => {
        const [x, y, v] = params.value
        const col = spec.categories?.[x] ?? String(x)
        const row = spec.yCategories?.[y] ?? String(y)
        return `${row} · ${col}  <b>${formatChartValue(v, spec.unit)}</b>`
      }
    },
    grid: { left: 8, right: 16, top: 14, bottom: 56, containLabel: true },
    xAxis: { ...categoryAxis(spec, theme, true), splitArea: { show: false } },
    yAxis: {
      type: 'category',
      data: spec.yCategories ?? [],
      axisTick: { show: false },
      axisLine: { lineStyle: { color: theme.border } },
      axisLabel: axisText(theme)
    },
    visualMap: {
      min,
      max,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      itemHeight: 100,
      calculable: false,
      inRange: { color: [...CHART_SEQUENTIAL_BLUES] },
      textStyle: { color: theme.muted, fontSize: 10, fontFamily: theme.fontFamily },
      formatter: (value: number) => formatChartValue(value, spec.unit)
    },
    series: [
      {
        name: spec.series[0]?.name ?? spec.title,
        type: 'heatmap',
        data: spec.series[0]?.data ?? [],
        itemStyle: { borderColor: theme.surface, borderWidth: 2 },
        label: { show: false },
        emphasis: { itemStyle: { shadowBlur: 6, shadowColor: 'rgba(0,0,0,0.25)' } }
      }
    ]
  }
}

function radarOption(spec: ChartSpec, theme: ChartTheme): Obj {
  const values = numericValues(spec)
  const max = spec.yAxis?.max ?? Math.ceil(Math.max(...values, 1) * 1.15)
  const legend = baseLegend(spec, theme)
  return {
    color: theme.palette,
    tooltip: baseTooltip(spec, theme, 'item'),
    legend,
    radar: {
      indicator: (spec.categories ?? []).map((name) => ({ name, max })),
      radius: '68%',
      axisName: { color: theme.muted, fontSize: 11, fontFamily: theme.fontFamily },
      splitLine: { lineStyle: { color: theme.border } },
      splitArea: { show: false },
      axisLine: { lineStyle: { color: theme.border } }
    },
    series: [
      {
        type: 'radar',
        data: spec.series.map((series, index) => {
          const color = seriesColor(series, index, theme)
          return {
            name: series.name,
            value: series.data.filter((d): d is number => typeof d === 'number'),
            lineStyle: { color, width: 2 },
            itemStyle: { color, borderColor: theme.surface, borderWidth: 2 },
            areaStyle: { color, opacity: 0.12 },
            symbolSize: 6
          }
        })
      }
    ]
  }
}

function gaugeOption(spec: ChartSpec, theme: ChartTheme): Obj {
  const item = namedData(spec.series[0])[0] ?? {
    name: spec.series[0]?.name ?? '',
    value: (spec.series[0]?.data.find((d): d is number => typeof d === 'number') as number) ?? 0
  }
  const max = spec.yAxis?.max ?? 100
  const color = seriesColor(spec.series[0] ?? { name: '', data: [] }, 0, theme)
  return {
    series: [
      {
        type: 'gauge',
        startAngle: 210,
        endAngle: -30,
        min: spec.yAxis?.min ?? 0,
        max,
        progress: { show: true, width: 14, roundCap: true, itemStyle: { color } },
        axisLine: { roundCap: true, lineStyle: { width: 14, color: [[1, theme.deemphasis]] } },
        pointer: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        title: {
          show: true,
          offsetCenter: [0, '32%'],
          color: theme.muted,
          fontSize: 12,
          fontFamily: theme.fontFamily
        },
        detail: {
          offsetCenter: [0, 0],
          color: theme.fg,
          fontSize: 30,
          fontWeight: 700,
          fontFamily: theme.fontFamily,
          formatter: (value: number) => formatChartValue(value, spec.unit)
        },
        data: [{ value: item.value, name: item.name }]
      }
    ]
  }
}

function funnelOption(spec: ChartSpec, theme: ChartTheme): Obj {
  const data = namedData(spec.series[0])
  const legend = { ...baseLegend(spec, theme), show: spec.legend ?? false }
  return {
    color: theme.palette,
    tooltip: baseTooltip(spec, theme, 'item'),
    legend,
    series: [
      {
        name: spec.series[0]?.name ?? spec.title,
        type: 'funnel',
        sort: 'descending',
        gap: 2,
        top: 8,
        bottom: legend.show ? 34 : 8,
        left: '12%',
        width: '76%',
        data,
        itemStyle: { borderColor: theme.surface, borderWidth: 1 },
        label: { show: true, position: 'inside', color: '#ffffff', fontSize: 11 },
        emphasis: { label: { fontSize: 12 } }
      }
    ]
  }
}

export function chartSpecToOption(spec: ChartSpec, theme: ChartTheme, width?: number): Obj {
  let option: Obj
  switch (spec.type) {
    case 'pie':
    case 'donut':
      option = pieOption(spec, theme)
      break
    case 'heatmap':
      option = heatmapOption(spec, theme)
      break
    case 'radar':
      option = radarOption(spec, theme)
      break
    case 'gauge':
      option = gaugeOption(spec, theme)
      break
    case 'funnel':
      option = funnelOption(spec, theme)
      break
    default:
      option = cartesianOption(spec, theme, width)
  }
  option.textStyle = { fontFamily: theme.fontFamily }
  option.animationDuration = 400
  option.animationDurationUpdate = 200
  if (spec.echarts) option = deepMerge(option, spec.echarts)
  return option
}
