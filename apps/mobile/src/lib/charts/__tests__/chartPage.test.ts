import { parseChartSpec, type ChartSpec } from '@/lib/charts/spec'
import { CHART_SEQUENTIAL_BLUES, chartThemeFor } from '@/lib/charts/theme'

/**
 * The chart page runtime (assets/charts/chart-page.webjs) carries the option
 * builder — the port of the desktop's toOption.ts, and the one place the
 * house chart style lives on mobile. It ships as a WebView asset, so jest
 * exercises it the same way the page does: evaluate the file, feed it parsed
 * specs and the real theme, and assert on the option it would hand ECharts.
 *
 * The runtime is environment-guarded: evaluated without a `document` it only
 * exports its internals, which is exactly what this harness uses.
 *
 * Node's fs/path are reached through jest's `require` and typed locally —
 * the app tsconfig deliberately carries no node types.
 */

declare const require: (id: string) => any
declare const __dirname: string
const { readFileSync } = require('fs') as {
  readFileSync: (path: string, encoding: string) => string
}
const { join } = require('path') as { join: (...parts: string[]) => string }

type Obj = Record<string, any>

type Internals = {
  deepMerge: (base: Obj, patch: Obj) => Obj
  formatChartValue: (value: number, unit?: Obj) => string
  chartSpecToOption: (spec: ChartSpec, theme: Obj, width?: number) => Obj
  chartLegendRows: (spec: ChartSpec, width?: number) => number
  adaptOptionForWidth: (option: Obj, spec: ChartSpec, width: number) => Obj
}

const source = readFileSync(
  join(__dirname, '..', '..', '..', '..', 'assets', 'charts', 'chart-page.webjs'),
  'utf8'
)

function loadInternals(): Internals {
  const sandbox: Obj = {}
  new Function('window', 'document', source)(sandbox, undefined)
  return sandbox.__wolffishChartInternals as Internals
}

const { deepMerge, formatChartValue, chartSpecToOption, chartLegendRows, adaptOptionForWidth } =
  loadInternals()
const light = chartThemeFor(false)
const dark = chartThemeFor(true)

function spec(json: Obj): ChartSpec {
  const parsed = parseChartSpec(JSON.stringify(json))
  if (!parsed) throw new Error('fixture spec did not parse')
  return parsed
}

describe('the published chart sample', () => {
  it('demo/samples/wolffish-sample.chart.json parses and renders', () => {
    // The spec every demo `.chart.json` path resolves to — if this stops
    // parsing, every demo chart card silently becomes a plain file card.
    const text = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'demo', 'samples', 'wolffish-sample.chart.json'),
      'utf8'
    )
    const sample = parseChartSpec(text)
    expect(sample).not.toBeNull()
    const option = chartSpecToOption(sample as ChartSpec, light)
    expect(option.series).toHaveLength(2)
    expect(option.legend.show).toBe(true)
  })
})

describe('formatChartValue', () => {
  it('matches the desktop formatter, compact and plain', () => {
    expect(formatChartValue(12400, { compact: true })).toBe('12.4K')
    expect(formatChartValue(2_000_000, { compact: true })).toBe('2M')
    expect(formatChartValue(3_400_000_000, { compact: true })).toBe('3.4B')
    expect(formatChartValue(1.5e12, { compact: true })).toBe('1.5T')
    expect(formatChartValue(-1200, { compact: true, prefix: '$' })).toBe('$-1.2K')
    expect(formatChartValue(1234)).toBe('1,234')
    expect(formatChartValue(12.5)).toBe('12.5')
    expect(formatChartValue(3, { decimals: 2, suffix: ' GB' })).toBe('3.00 GB')
  })
})

describe('deepMerge', () => {
  it('merges objects recursively; arrays and primitives replace', () => {
    expect(
      deepMerge({ grid: { left: 8, top: 14 }, color: ['a'] }, { grid: { left: 99 }, color: ['b'] })
    ).toEqual({ grid: { left: 99, top: 14 }, color: ['b'] })
  })
})

describe('chartSpecToOption', () => {
  it('assigns palette slots in order, honors explicit slots and hex colors', () => {
    const option = chartSpecToOption(
      spec({
        series: [
          { data: [1] },
          { data: [2], color: 5 },
          { data: [3], color: '#123456' },
          { data: [4], color: 99 }
        ]
      }),
      light
    )
    const colors = option.series.map((s: Obj) => s.itemStyle.color)
    expect(colors[0]).toBe(light.palette[0])
    expect(colors[1]).toBe(light.palette[4])
    expect(colors[2]).toBe('#123456')
    // An out-of-range slot falls back to the series' own position.
    expect(colors[3]).toBe(light.palette[3])
  })

  it('shows the legend only for 2+ series unless the spec forces it', () => {
    const one = chartSpecToOption(spec({ series: [{ data: [1] }] }), light)
    expect(one.legend.show).toBe(false)
    expect(one.grid.bottom).toBe(10)
    const two = chartSpecToOption(spec({ series: [{ data: [1] }, { data: [2] }] }), light)
    expect(two.legend.show).toBe(true)
    expect(two.grid.bottom).toBe(34)
    const forced = chartSpecToOption(spec({ legend: true, series: [{ data: [1] }] }), light)
    expect(forced.legend.show).toBe(true)
  })

  it('styles columns per the house marks: capped width, rounded data end', () => {
    const option = chartSpecToOption(spec({ series: [{ data: [1, 2] }] }), light)
    expect(option.series[0]).toMatchObject({
      type: 'bar',
      barMaxWidth: 28,
      itemStyle: { borderRadius: [3, 3, 0, 0] }
    })
  })

  it('flips axes and bar radius for horizontal bars', () => {
    const option = chartSpecToOption(spec({ type: 'bar', series: [{ data: [1] }] }), light)
    expect(option.xAxis.type).toBe('value')
    expect(option.yAxis.type).toBe('category')
    expect(option.series[0].itemStyle.borderRadius).toEqual([0, 3, 3, 0])
  })

  it('separates stacked segments with a surface-colored border', () => {
    const option = chartSpecToOption(
      spec({ stacked: true, series: [{ data: [1] }, { data: [2] }] }),
      dark
    )
    for (const series of option.series) {
      expect(series.stack).toBe('stack')
      expect(series.itemStyle.borderColor).toBe(dark.surface)
      expect(series.itemStyle.borderRadius).toBe(0)
    }
  })

  it('draws 2px lines with surface-ringed markers, hidden past 30 points', () => {
    const short = chartSpecToOption(spec({ type: 'line', series: [{ data: [1, 2, 3] }] }), light)
    expect(short.series[0]).toMatchObject({
      type: 'line',
      lineStyle: { width: 2 },
      symbolSize: 7,
      showSymbol: true,
      itemStyle: { borderColor: light.surface, borderWidth: 2 }
    })
    const long = chartSpecToOption(
      spec({ type: 'line', series: [{ data: Array.from({ length: 31 }, (_, i) => i) }] }),
      light
    )
    expect(long.series[0].showSymbol).toBe(false)
  })

  it('fills areas faintly, denser when stacked', () => {
    const single = chartSpecToOption(spec({ type: 'area', series: [{ data: [1] }] }), light)
    expect(single.series[0].areaStyle.opacity).toBe(0.12)
    const stacked = chartSpecToOption(
      spec({ type: 'area', stacked: true, series: [{ data: [1] }, { data: [2] }] }),
      light
    )
    expect(stacked.series[0].areaStyle.opacity).toBe(0.18)
  })

  it('sizes scatter symbols by the optional third value, clamped 8–40', () => {
    const option = chartSpecToOption(
      spec({ type: 'scatter', series: [{ data: [[1, 2, 100]] }] }),
      light
    )
    const size = option.series[0].symbolSize
    expect(size([1, 2, 100])).toBe(40)
    expect(size([1, 2, 1])).toBe(8)
    expect(size([1, 2, 9])).toBe(12)
    expect(size([1, 2])).toBe(10)
    // Without categories the x axis is numeric.
    expect(option.xAxis.type).toBe('value')
  })

  it('sorts pie slices by value and centers per legend presence', () => {
    const withLegend = chartSpecToOption(
      spec({
        type: 'pie',
        series: [
          {
            data: [
              { name: 'small', value: 1 },
              { name: 'big', value: 9 }
            ]
          }
        ]
      }),
      light
    )
    expect(withLegend.series[0].data.map((d: Obj) => d.name)).toEqual(['big', 'small'])
    expect(withLegend.legend.show).toBe(true)
    expect(withLegend.series[0].center).toEqual(['50%', '46%'])
    const single = chartSpecToOption(
      spec({ type: 'donut', series: [{ data: [{ name: 'only', value: 1 }] }] }),
      light
    )
    expect(single.legend.show).toBe(false)
    expect(single.series[0].center).toEqual(['50%', '50%'])
    expect(single.series[0].radius).toEqual(['52%', '76%'])
  })

  it('maps heatmaps onto the sequential blues with a data-driven range', () => {
    const option = chartSpecToOption(
      spec({
        type: 'heatmap',
        categories: ['Mon', 'Tue'],
        yCategories: ['AM', 'PM'],
        series: [
          {
            data: [
              [0, 0, 2],
              [1, 1, 8]
            ]
          }
        ]
      }),
      light
    )
    expect(option.visualMap.min).toBe(0)
    expect(option.visualMap.max).toBe(8)
    expect(option.visualMap.inRange.color).toEqual([...CHART_SEQUENTIAL_BLUES])
  })

  it('headroom-scales the radar axis and defaults the gauge to 0–100', () => {
    const radar = chartSpecToOption(
      spec({ type: 'radar', categories: ['a', 'b'], series: [{ data: [10, 20] }] }),
      light
    )
    expect(radar.radar.indicator).toEqual([
      { name: 'a', max: 23 },
      { name: 'b', max: 23 }
    ])
    const gauge = chartSpecToOption(
      spec({ type: 'gauge', series: [{ data: [{ name: 'CPU', value: 63 }] }] }),
      light
    )
    expect(gauge.series[0]).toMatchObject({ min: 0, max: 100, data: [{ name: 'CPU', value: 63 }] })
    expect(gauge.series[0].axisLine.lineStyle.color).toEqual([[1, light.deemphasis]])
  })

  it('confines tooltips (the mobile deviation) and themes them', () => {
    const option = chartSpecToOption(spec({ series: [{ data: [1] }] }), dark)
    expect(option.tooltip).toMatchObject({
      confine: true,
      backgroundColor: dark.surface,
      borderColor: dark.border
    })
    expect(option.textStyle.fontFamily).toBe(dark.fontFamily)
    expect(option.animationDuration).toBe(400)
  })

  it('hides pie labels at card width only when the legend carries identity', () => {
    const donut = spec({
      type: 'donut',
      series: [
        {
          data: [
            { name: 'a', value: 1 },
            { name: 'b', value: 2 }
          ]
        }
      ]
    })
    // Narrow host: labels off, ring grows into the reclaimed gutter.
    const narrow = adaptOptionForWidth(chartSpecToOption(donut, light), donut, 340)
    expect(narrow.series[0].label.show).toBe(false)
    expect(narrow.series[0].labelLine.show).toBe(false)
    expect(narrow.series[0].radius).toEqual(['58%', '84%'])
    // Wide host: the desktop's outside labels stay.
    const wide = adaptOptionForWidth(chartSpecToOption(donut, light), donut, 700)
    expect(wide.series[0].label.show).toBeUndefined()
    // legend: false is the author's call — identity must stay on the slices.
    const noLegend = spec({
      type: 'pie',
      legend: false,
      series: [
        {
          data: [
            { name: 'a', value: 1 },
            { name: 'b', value: 2 }
          ]
        }
      ]
    })
    const kept = adaptOptionForWidth(chartSpecToOption(noLegend, light), noLegend, 340)
    expect(kept.series[0].label.show).toBeUndefined()
    // Passthrough specs are full-control — never adapted.
    const passthrough = spec({
      type: 'donut',
      echarts: { series: [] },
      series: [
        {
          data: [
            { name: 'a', value: 1 },
            { name: 'b', value: 2 }
          ]
        }
      ]
    })
    const untouched = adaptOptionForWidth(chartSpecToOption(passthrough, light), passthrough, 340)
    expect(untouched.series[0]?.label?.show).toBeUndefined()
    // Cartesian types keep their geometry regardless of width.
    const line = spec({ type: 'line', series: [{ data: [1, 2] }] })
    expect(adaptOptionForWidth(chartSpecToOption(line, light), line, 340).series[0].type).toBe(
      'line'
    )
  })

  it('reserves a grid row per wrapped legend row at narrow widths', () => {
    // The on-device repro (2026-08-04): three long series names on a ~370pt
    // plot wrap the bottom legend to two rows, and a single-row grid inset
    // put the top row on the x-axis labels.
    const long = spec({
      type: 'area',
      series: [
        { name: 'Auto-archived', data: [1] },
        { name: 'Drafted reply', data: [2] },
        { name: 'Flagged for me', data: [3] }
      ]
    })
    expect(chartLegendRows(long, 370)).toBe(2)
    expect(chartSpecToOption(long, light, 370).grid.bottom).toBe(58)
    // The same names fit one row on a wide desktop plot.
    expect(chartLegendRows(long, 700)).toBe(1)
    expect(chartSpecToOption(long, light, 700).grid.bottom).toBe(34)
    // Unknown width keeps the pre-existing single-row inset.
    expect(chartSpecToOption(long, light).grid.bottom).toBe(34)

    // The showcase's shortened names stay on one row at the same width.
    const short = spec({
      type: 'area',
      series: [
        { name: 'Archived', data: [1] },
        { name: 'Replied', data: [2] },
        { name: 'Flagged', data: [3] }
      ]
    })
    expect(chartSpecToOption(short, light, 370).grid.bottom).toBe(34)

    // No legend, no inset — width is irrelevant.
    const single = spec({ series: [{ data: [1] }] })
    expect(chartSpecToOption(single, light, 200).grid.bottom).toBe(10)
    expect(chartLegendRows(single, 200)).toBe(1)
    // Non-cartesian types never inset a grid, whatever the width.
    const donut = spec({
      type: 'donut',
      series: [
        {
          data: [
            { name: 'a long slice name', value: 1 },
            { name: 'another long slice name', value: 2 }
          ]
        }
      ]
    })
    expect(chartLegendRows(donut, 200)).toBe(1)
  })

  it('deep-merges the echarts passthrough last, winning field-by-field', () => {
    const option = chartSpecToOption(
      spec({ series: [{ data: [1] }], echarts: { grid: { left: 99 }, animation: false } }),
      light
    )
    expect(option.grid.left).toBe(99)
    expect(option.grid.top).toBe(14)
    expect(option.animation).toBe(false)
  })
})
