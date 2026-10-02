/**
 * The live plot for a `.chart.json` spec. Owns the ECharts instance:
 * selective chart/component registration (tree-shaken core build), resize
 * via ResizeObserver, and full re-theme when the app flips light/dark.
 * Chrome colors come from the CSS custom properties at render time, so the
 * plot always matches the surface it sits on.
 */
import { useTheme } from '@providers/theme/useTheme'
import * as echarts from 'echarts/core'
import {
  BarChart,
  FunnelChart,
  GaugeChart,
  HeatmapChart,
  LineChart,
  PieChart,
  RadarChart,
  ScatterChart
} from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChartSpec } from './spec'
import { readChartTheme } from './theme'
import { chartLegendRows, chartSpecToOption } from './toOption'

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  HeatmapChart,
  RadarChart,
  GaugeChart,
  FunnelChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  VisualMapComponent,
  MarkLineComponent,
  MarkAreaComponent,
  CanvasRenderer
])

export type ChartSpecPlotProps = {
  spec: ChartSpec
  className?: string
  /** Latest live instance (for PNG export); called with null on dispose. */
  onInstance?: (chart: echarts.EChartsType | null) => void
}

export function ChartSpecPlot({
  spec,
  className,
  onInstance
}: ChartSpecPlotProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<echarts.EChartsType | null>(null)
  const { isDark } = useTheme()

  // The plot width the option was built for. Updated only when the legend
  // would wrap to a different row count at the new width (chartLegendRows),
  // so an ordinary resize costs one chart.resize(), not an option rebuild —
  // but a bottom legend that wraps gets its extra rows reserved in the grid
  // instead of landing on the x-axis labels.
  const [plotWidth, setPlotWidth] = useState<number | undefined>(undefined)
  // The observer below outlives every spec swap, so it reads the current spec
  // through a ref. Written in a layout effect — before the browser can deliver
  // a ResizeObserver callback for this frame — so the observer never gates on
  // a stale legend.
  const specRef = useRef(spec)
  useLayoutEffect(() => {
    specRef.current = spec
  }, [spec])

  const option = useMemo(
    () => chartSpecToOption(spec, readChartTheme(isDark), plotWidth),
    [spec, isDark, plotWidth]
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const chart = echarts.init(host)
    chartRef.current = chart
    onInstance?.(chart)
    const observer = new ResizeObserver(() => {
      chart.resize()
      const width = host.clientWidth
      setPlotWidth((prev) =>
        chartLegendRows(specRef.current, width) === chartLegendRows(specRef.current, prev)
          ? prev
          : width
      )
    })
    observer.observe(host)
    return () => {
      observer.disconnect()
      chartRef.current = null
      onInstance?.(null)
      chart.dispose()
    }
    // The instance lives for the component's lifetime; option updates flow
    // through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A spec swap can change the legend's names while the width stays put —
  // re-gate against the current host width so the new legend's rows are
  // reserved without waiting for a resize.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const width = host.clientWidth
    setPlotWidth((prev) =>
      chartLegendRows(spec, width) === chartLegendRows(spec, prev) ? prev : width
    )
  }, [spec])

  useEffect(() => {
    // notMerge replaces the whole option — stale series never linger when the
    // spec or theme changes.
    chartRef.current?.setOption(option, { notMerge: true })
  }, [option])

  return <div ref={hostRef} className={className} />
}
