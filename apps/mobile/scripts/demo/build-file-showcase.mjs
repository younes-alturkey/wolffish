#!/usr/bin/env node
/**
 * Build a "one file of every supported type" conversation into demo/, for
 * exercising the chat file viewers end-to-end on a device.
 *
 * Writes no files: every path below resolves to the published sample for its
 * extension (src/lib/files/sampleFiles.ts), downloaded on first view. So this
 * script emits a single conversation JSON and nothing else, and each card shows
 * a real file of that type — the same one for every user.
 *
 *   node scripts/demo/build-file-showcase.mjs        # writes into demo/
 *   node scripts/demo/build-demo-bundle.mjs          # pack for the CDN
 *
 * The conversation delivers each file exactly the way the desktop does — a
 * send_file tool result carrying a `[wolffish-output: <path> (<kind>)]` marker
 * — and attaches a few on the user side, so both render paths are covered.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { sampleExtFor } from './sample-exts.mjs'

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const DEMO = process.env.DEMO_OUT ?? path.join(ROOT, 'demo')
const SHOWCASE_DIR = 'files/showcase'
const CONV_ID = 'file-showcase'

/** Kind as the send_file marker spells it, per extension. */
const MARKER_KIND = {
  png: 'image',
  jpg: 'image',
  gif: 'image',
  svg: 'image',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  pdf: 'document',
  docx: 'document',
  xlsx: 'document',
  pptx: 'document',
  csv: 'document',
  tsv: 'document',
  txt: 'document',
  md: 'document',
  html: 'document'
}

/**
 * One file per viewer the dispatch table in FileBlock can reach: image, video,
 * audio, pdf, svg, html, markdown, text, code, sheet, and the generic card that
 * hands an Office document to the system viewer. Names are the natural ones a
 * delivered file would carry — the sample behind each is chosen by extension.
 */
const DELIVERED = [
  'photo.png',
  'scan.jpg',
  'loop.gif',
  'logo.svg',
  'clip.mp4',
  'recording.mov',
  'capture.webm',
  'voice.mp3',
  'tone.wav',
  'reply.ogg',
  'report.pdf',
  'summary.docx',
  'sales.xlsx',
  'deck.pptx',
  'report.md',
  'notes.txt',
  'page.html',
  'app.ts',
  'data.json',
  'regions.csv',
  'regions.tsv',
  // Last on purpose: the showcase closes on the interactive chart card.
  'wolffish-observations.chart.json'
]

/** Attached by the user rather than delivered — the other render path. */
const ATTACHED = [
  ['scan.jpg', 'image'],
  ['report.pdf', 'pdf'],
  ['regions.csv', 'other'],
  ['report.md', 'other'],
  ['voice.mp3', 'audio']
]

async function main() {
  await fs.mkdir(path.join(DEMO, 'conversations'), { recursive: true })

  const unpublished = DELIVERED.filter((name) => !sampleExtFor(name))
  if (unpublished.length) {
    console.warn(`no published sample for: ${unpublished.join(', ')} — will render unavailable`)
  }

  const now = Date.now()
  const rel = (name) => `${SHOWCASE_DIR}/${name}`
  const kindOf = (name) => {
    // The chart card's double extension — path.extname only sees `.json`,
    // but the desktop marks `.chart.json` deliveries as (chart).
    if (name.toLowerCase().endsWith('.chart.json')) return 'chart'
    return MARKER_KIND[path.extname(name).slice(1).toLowerCase()] ?? 'file'
  }

  const segments = [
    {
      kind: 'text',
      turnId: 't1',
      segmentId: 's0',
      delta: 'Here is one of every file type I can deliver.\n'
    }
  ]
  DELIVERED.forEach((name, index) => {
    const id = `call_${index}`
    segments.push({
      kind: 'tool_call',
      turnId: 't1',
      segmentId: `sc${index}`,
      toolCallId: id,
      name: 'send_file',
      args: { path: rel(name) }
    })
    segments.push({
      kind: 'tool_result',
      turnId: 't1',
      segmentId: `sr${index}`,
      toolCallId: id,
      status: 'success',
      output: `Sent ${name}.\n[wolffish-output: ${rel(name)} (${kindOf(name)})]`
    })
  })
  segments.push({
    kind: 'turn_end',
    turnId: 't1',
    segmentId: 'end',
    stopReason: 'end_turn',
    iterationCount: 1
  })

  // A type with no published sample proves the per-type "unavailable" states
  // still render — .zip is the one the CDN has no sample for.
  segments.splice(1, 0, {
    kind: 'tool_call',
    turnId: 't1',
    segmentId: 'sc-missing',
    toolCallId: 'call_missing',
    name: 'send_file',
    args: { path: `${SHOWCASE_DIR}/bundle.zip` }
  })
  segments.splice(2, 0, {
    kind: 'tool_result',
    turnId: 't1',
    segmentId: 'sr-missing',
    toolCallId: 'call_missing',
    status: 'success',
    output: `[wolffish-output: ${SHOWCASE_DIR}/bundle.zip (file)]`
  })

  const conversation = {
    id: CONV_ID,
    title: 'File type showcase',
    model: 'claude-opus-4-8',
    channel: 'electron',
    createdAt: now - 60_000,
    updatedAt: now,
    messages: [
      {
        id: 'm_showcase_user',
        role: 'user',
        content: 'Send me one of every file type you support.',
        timestamp: now - 60_000,
        // sizeBytes 0: the size isn't known until the sample is downloaded, and
        // the cards already fall back to the size of the file the cache holds.
        attachments: ATTACHED.map(([name, type]) => ({
          type,
          filePath: rel(name),
          originalName: name,
          mimeType: 'application/octet-stream',
          sizeBytes: 0
        }))
      },
      {
        id: 'm_showcase_assistant',
        role: 'assistant',
        content: '',
        timestamp: now,
        segments
      }
    ]
  }

  await fs.writeFile(
    path.join(DEMO, 'conversations', `conv-${CONV_ID}.json`),
    JSON.stringify(conversation)
  )

  console.log(`showcase: ${DELIVERED.length} delivered + ${ATTACHED.length} attached, 0 bytes`)
  console.log(`conversation: demo/conversations/conv-${CONV_ID}.json`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
