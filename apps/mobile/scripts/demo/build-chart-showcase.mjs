#!/usr/bin/env node
/**
 * Build the "one of every chart type" conversation into demo/ — the
 * dataviz counterpart of build-file-showcase.mjs, for exercising the chart
 * card end-to-end on a device.
 *
 * Unlike the file showcase, the chart bytes cannot come from the published
 * per-type samples: every `.chart.json` path resolves to the same sample
 * spec, which would draw the same column chart eleven times. Instead each
 * spec ships INSIDE the conversation under `files` (relPath → text) — the
 * demo importer materializes them into the workspace at import time (see
 * DemoConversationFile in src/lib/demo/importer.ts), so every card renders
 * its own spec, offline, with nothing extra published.
 *
 *   node scripts/demo/build-chart-showcase.mjs        # writes into demo/
 *   node scripts/demo/build-demo-bundle.mjs           # pack for the CDN
 *
 * Timestamps are derived from the committed file showcase (+12 h), not from
 * the clock: this conversation must sort ABOVE "File type showcase" — the
 * previous top of the list — and a deterministic offset keeps re-running this
 * script byte-identical, the same hygiene the bundle build relies on. If you
 * ever regenerate the file showcase (which stamps Date.now()), re-run this
 * script after it so the gallery stays on top.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const DEMO = process.env.DEMO_OUT ?? path.join(ROOT, 'demo')
const CHARTS_DIR = 'files/charts'
const CONV_ID = 'chart-showcase'

/** Hour × weekday activity grid — rows Mon..Sun, columns 12am..8pm. */
const ACTIVITY = [
  [3, 15, 34, 41, 29, 12],
  [2, 16, 38, 44, 31, 10],
  [4, 15, 30, 39, 27, 14],
  [2, 17, 36, 46, 33, 11],
  [3, 16, 28, 35, 22, 9],
  [5, 14, 9, 12, 8, 7],
  [4, 15, 6, 9, 11, 16]
]

/**
 * One spec per entry of CHART_SPEC_TYPES (src/lib/charts/spec.ts), in the
 * spec's order, each leaning on different spec features: stacks, units,
 * null gaps, bubble sizes, palette-slot colors, axis bounds.
 */
const CHARTS = [
  [
    'focus-hours.chart.json',
    {
      type: 'column',
      title: 'Deep work by week',
      subtitle: 'Focus blocks vs meetings · last six weeks',
      categories: ['Jun 22', 'Jun 29', 'Jul 6', 'Jul 13', 'Jul 20', 'Jul 27'],
      series: [
        { name: 'Deep work', data: [14, 17, 15, 19, 21, 18] },
        { name: 'Meetings', data: [8, 6, 9, 5, 4, 6] }
      ],
      unit: { suffix: 'h' },
      footnote: 'Merged from calendar + screen time each night.'
    }
  ],
  [
    'capability-runs.chart.json',
    {
      type: 'bar',
      title: 'Capability runs — July',
      subtitle: 'Invocations per capability',
      categories: ['Memory', 'Browser', 'Calendar', 'Files', 'Research', 'Email triage'],
      series: [{ name: 'Runs', data: [73, 98, 164, 231, 286, 412] }],
      unit: { compact: true }
    }
  ],
  [
    'api-spend.chart.json',
    {
      type: 'line',
      title: 'API spend per day',
      subtitle: 'July 1–14',
      categories: [
        'Jul 1',
        'Jul 2',
        'Jul 3',
        'Jul 4',
        'Jul 5',
        'Jul 6',
        'Jul 7',
        'Jul 8',
        'Jul 9',
        'Jul 10',
        'Jul 11',
        'Jul 12',
        'Jul 13',
        'Jul 14'
      ],
      series: [
        {
          name: 'Spend',
          data: [1.84, 2.31, 1.62, 2.9, 3.44, 1.18, 0.96, null, 2.75, 3.1, 2.42, 1.88, 3.65, 2.2]
        }
      ],
      unit: { prefix: '$', decimals: 2 },
      footnote: 'Jul 8 — machine asleep, no runs.'
    }
  ],
  [
    'inbox-flow.chart.json',
    {
      type: 'area',
      title: 'Inbox flow',
      subtitle: 'Messages per week by outcome',
      categories: ['Jun 22', 'Jun 29', 'Jul 6', 'Jul 13', 'Jul 20', 'Jul 27'],
      // Long names on purpose: at phone width the bottom legend wraps to a
      // second row, exercising the grid's legend-row reservation (legendRows
      // in chart-page.webjs) — the wrap is part of the showcase.
      series: [
        { name: 'Auto-archived', data: [96, 104, 88, 112, 120, 101] },
        { name: 'Drafted reply', data: [22, 18, 25, 21, 19, 24] },
        { name: 'Flagged for me', data: [11, 9, 14, 8, 7, 10] }
      ],
      stacked: true,
      smooth: true
    }
  ],
  [
    'workspace-storage.chart.json',
    {
      type: 'pie',
      title: 'Workspace storage',
      subtitle: 'What Wolffish keeps on disk',
      series: [
        {
          name: 'Storage',
          data: [
            { name: 'Media', value: 48 },
            { name: 'Documents', value: 23 },
            { name: 'Code', value: 12 },
            { name: 'Datasets', value: 9 },
            { name: 'Other', value: 6 }
          ]
        }
      ],
      unit: { suffix: ' GB' }
    }
  ],
  [
    'model-usage.chart.json',
    {
      type: 'donut',
      title: 'Requests by model',
      subtitle: 'July · all channels',
      series: [
        {
          name: 'Requests',
          data: [
            { name: 'Haiku 4.5', value: 6570 },
            { name: 'Sonnet 4.6', value: 3921 },
            { name: 'Opus 4.8', value: 1284 },
            { name: 'Local (Llama)', value: 842 }
          ]
        }
      ],
      unit: { compact: true }
    }
  ],
  [
    'turn-latency.chart.json',
    {
      type: 'scatter',
      title: 'Turn latency vs context',
      subtitle: 'One point per turn · bubble = tokens out',
      series: [
        {
          name: 'Chat',
          data: [
            [12, 1.9, 26],
            [18, 2.2, 31],
            [24, 2, 18],
            [36, 2.8, 44],
            [48, 3.1, 39],
            [64, 3.9, 52],
            [80, 4.6, 61],
            [96, 5.2, 47],
            [118, 6.4, 72],
            [142, 7.8, 66]
          ]
        },
        {
          name: 'Background jobs',
          data: [
            [8, 1.2, 12],
            [22, 1.8, 16],
            [40, 2.6, 21],
            [70, 3.8, 25],
            [105, 5.1, 30],
            [150, 6.9, 34]
          ]
        }
      ],
      xAxis: { name: 'Context (K tokens)' },
      yAxis: { name: 'Latency (s)' }
    }
  ],
  [
    'activity-heatmap.chart.json',
    {
      type: 'heatmap',
      title: 'When Wolffish works',
      subtitle: 'Runs by hour × weekday · July',
      categories: ['12am', '4am', '8am', '12pm', '4pm', '8pm'],
      yCategories: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      series: [
        {
          name: 'Runs',
          data: ACTIVITY.flatMap((row, r) => row.map((value, c) => [c, r, value]))
        }
      ],
      unit: { suffix: ' runs' },
      footnote: 'The 4am column is the nightly batch.'
    }
  ],
  [
    'capability-fitness.chart.json',
    {
      type: 'radar',
      title: 'Capability fitness',
      subtitle: 'Success rate by area',
      categories: ['Research', 'Coding', 'Writing', 'Scheduling', 'Recall', 'Browsing'],
      series: [
        { name: 'This month', data: [86, 74, 91, 88, 79, 68] },
        { name: 'Last month', data: [78, 70, 85, 84, 71, 60] }
      ],
      yAxis: { max: 100 },
      unit: { suffix: '%' }
    }
  ],
  [
    'context-window.chart.json',
    {
      type: 'gauge',
      title: 'Context window',
      subtitle: 'This conversation',
      series: [{ name: 'Context', color: 3, data: [{ name: 'of 200K used', value: 68 }] }],
      unit: { suffix: '%' },
      footnote: 'Compaction kicks in at 85%.'
    }
  ],
  [
    'task-pipeline.chart.json',
    {
      type: 'funnel',
      title: 'Task pipeline — July',
      subtitle: 'Captured → shipped',
      series: [
        {
          name: 'Tasks',
          data: [
            { name: 'Captured', value: 214 },
            { name: 'Triaged', value: 178 },
            { name: 'Planned', value: 122 },
            { name: 'In progress', value: 74 },
            // "Done", not "Shipped": the narrowest tier clips longer labels.
            { name: 'Done', value: 58 }
          ]
        }
      ]
    }
  ]
]

async function main() {
  await fs.mkdir(path.join(DEMO, 'conversations'), { recursive: true })

  // Anchor above the previous top of the list, deterministically (see header).
  const showcaseRaw = await fs.readFile(
    path.join(DEMO, 'conversations', 'conv-file-showcase.json'),
    'utf8'
  )
  const anchor = JSON.parse(showcaseRaw).updatedAt
  if (typeof anchor !== 'number') throw new Error('conv-file-showcase.json has no updatedAt')
  const updatedAt = anchor + 12 * 3600_000
  const createdAt = updatedAt - 60_000

  const rel = (name) => `${CHARTS_DIR}/${name}`
  const segments = [
    {
      kind: 'text',
      turnId: 't1',
      segmentId: 's0',
      delta: 'One of each — every chart type I can draw. Tap any card to explore it live.\n'
    }
  ]
  const files = {}
  CHARTS.forEach(([name, spec], index) => {
    files[rel(name)] = JSON.stringify(spec, null, 2)
    segments.push({
      kind: 'tool_call',
      turnId: 't1',
      segmentId: `sc${index}`,
      toolCallId: `call_${index}`,
      name: 'send_file',
      args: { path: rel(name) }
    })
    segments.push({
      kind: 'tool_result',
      turnId: 't1',
      segmentId: `sr${index}`,
      toolCallId: `call_${index}`,
      status: 'success',
      output: `Sent ${name}.\n[wolffish-output: ${rel(name)} (chart)]`
    })
  })
  segments.push({
    kind: 'text',
    turnId: 't1',
    segmentId: 's1',
    delta:
      'That is the full set — column, bar, line, area, pie, donut, scatter, heatmap, radar, gauge, and funnel. Flip any card to its data view to see the spec it was drawn from.\n'
  })
  segments.push({
    kind: 'turn_end',
    turnId: 't1',
    segmentId: 'end',
    stopReason: 'end_turn',
    iterationCount: 1
  })

  const conversation = {
    id: CONV_ID,
    title: 'Chart showcase',
    model: 'claude-opus-4-8',
    channel: 'electron',
    createdAt,
    updatedAt,
    messages: [
      {
        id: 'm_charts_user',
        role: 'user',
        content: 'Draw me one of every chart type you support.',
        timestamp: createdAt
      },
      {
        id: 'm_charts_assistant',
        role: 'assistant',
        content: '',
        timestamp: updatedAt,
        segments
      }
    ],
    files
  }

  await fs.writeFile(
    path.join(DEMO, 'conversations', `conv-${CONV_ID}.json`),
    JSON.stringify(conversation)
  )

  const bytes = Object.values(files).reduce((sum, text) => sum + Buffer.byteLength(text), 0)
  console.log(`charts: ${CHARTS.length} specs, ${(bytes / 1024).toFixed(1)} KB inline`)
  console.log(`sorts above file showcase: updatedAt ${new Date(updatedAt).toISOString()}`)
  console.log(`conversation: demo/conversations/conv-${CONV_ID}.json`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
