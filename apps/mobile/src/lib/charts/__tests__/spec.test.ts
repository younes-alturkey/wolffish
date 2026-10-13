import { parseChartSpec } from '@/lib/charts/spec'

/**
 * The lenient `.chart.json` parser — a port of the desktop's, so every rule
 * here is a cross-surface contract: a spec that renders on the desktop must
 * parse the same way on the phone, and one that falls back must fall back.
 */

describe('parseChartSpec', () => {
  it('returns null only when nothing could possibly render', () => {
    expect(parseChartSpec('not json')).toBeNull()
    expect(parseChartSpec('[]')).toBeNull()
    expect(parseChartSpec('42')).toBeNull()
    expect(parseChartSpec('{}')).toBeNull()
    expect(parseChartSpec('{"title":"empty","series":[]}')).toBeNull()
    // A series whose data is entirely garbage is dropped, leaving nothing.
    expect(parseChartSpec('{"series":[{"data":["x",{},[1,"y"]]}]}')).toBeNull()
  })

  it('accepts a minimal spec and fills the defaults', () => {
    const spec = parseChartSpec('{"series":[{"data":[1,2,3]}]}')
    expect(spec).toMatchObject({
      type: 'column',
      title: '',
      series: [{ name: 'Series 1', data: [1, 2, 3] }]
    })
  })

  it('normalizes the type, falling back to column for unknown ones', () => {
    expect(parseChartSpec('{"type":"PIE","series":[{"data":[{"value":1}]}]}')?.type).toBe('pie')
    expect(parseChartSpec('{"type":"sankey","series":[{"data":[1]}]}')?.type).toBe('column')
  })

  it('coerces data: numeric strings, gaps, pairs and named values', () => {
    const spec = parseChartSpec(
      JSON.stringify({
        series: [{ data: ['5', null, [1, '2'], { name: 'a', value: '3' }, 'junk'] }]
      })
    )
    expect(spec?.series[0].data).toEqual([5, null, [1, 2], { name: 'a', value: 3 }])
  })

  it('keeps a passthrough-only spec renderable', () => {
    const spec = parseChartSpec('{"echarts":{"series":[{"type":"line","data":[1]}]}}')
    expect(spec).not.toBeNull()
    expect(spec?.series).toEqual([])
    expect(spec?.echarts).toEqual({ series: [{ type: 'line', data: [1] }] })
  })

  it('clamps height to the desktop plot bounds', () => {
    const base = { series: [{ data: [1] }] }
    expect(parseChartSpec(JSON.stringify({ ...base, height: 100 }))?.height).toBe(160)
    expect(parseChartSpec(JSON.stringify({ ...base, height: 9999 }))?.height).toBe(720)
    expect(parseChartSpec(JSON.stringify({ ...base, height: 400 }))?.height).toBe(400)
    expect(parseChartSpec(JSON.stringify(base))?.height).toBeUndefined()
  })

  it('clamps unit decimals into 0–4 and keeps only meaningful unit fields', () => {
    const base = { series: [{ data: [1] }] }
    expect(
      parseChartSpec(JSON.stringify({ ...base, unit: { decimals: 9.6, prefix: '$' } }))?.unit
    ).toEqual({ prefix: '$', decimals: 4 })
    expect(parseChartSpec(JSON.stringify({ ...base, unit: { prefix: '' } }))?.unit).toBeUndefined()
  })

  it('preserves an explicit legend choice and drops a malformed one', () => {
    const base = { series: [{ data: [1] }] }
    expect(parseChartSpec(JSON.stringify({ ...base, legend: false }))?.legend).toBe(false)
    expect(parseChartSpec(JSON.stringify({ ...base, legend: 'yes' }))?.legend).toBeUndefined()
  })

  it('stringifies non-string category labels', () => {
    const spec = parseChartSpec(
      JSON.stringify({ series: [{ data: [1, 2] }], categories: [2024, 2025] })
    )
    expect(spec?.categories).toEqual(['2024', '2025'])
  })

  it('carries series slots, hex colors and stacks through', () => {
    const spec = parseChartSpec(
      JSON.stringify({
        stacked: true,
        series: [
          { name: 'a', data: [1], color: 3, stack: 's1' },
          { name: 'b', data: [2], color: '#123456' }
        ]
      })
    )
    expect(spec?.stacked).toBe(true)
    expect(spec?.series[0]).toMatchObject({ color: 3, stack: 's1' })
    expect(spec?.series[1]).toMatchObject({ color: '#123456' })
  })

  it('coerces axis bounds, including numeric strings', () => {
    const spec = parseChartSpec(
      JSON.stringify({ series: [{ data: [1] }], yAxis: { min: '0', max: 100, name: 'GB' } })
    )
    expect(spec?.yAxis).toEqual({ name: 'GB', min: 0, max: 100 })
  })
})
