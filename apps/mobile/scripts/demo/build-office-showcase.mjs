#!/usr/bin/env node
/**
 * Build the two office-document conversations into demo/ — the ones that put
 * the .pptx, .xlsx and .docx cards in front of a demo user.
 *
 *   node scripts/demo/build-office-showcase.mjs      # writes into demo/
 *   node scripts/demo/build-demo-bundle.mjs          # pack for the CDN
 *
 * Writes no files: every path resolves to the published sample for its
 * extension (src/lib/files/sampleFiles.ts), downloaded on first view. So a
 * `.pptx` here is the real seven-slide sample deck, and its card really does
 * page through seven slides.
 *
 * Unlike conv-file-showcase, which is a contact sheet of one file per viewer,
 * these read as ordinary work: someone asks for a deck, someone hands over a
 * messy workbook. That is the point — the office cards should look like part
 * of a conversation, not like a test fixture.
 *
 * Between them they cover every path into the office card:
 *   delivered .pptx  → the slide pager  (seven slides)
 *   delivered .xlsx  → the sheet pager  (three named sheets)
 *   delivered .docx  → the document card
 *   ATTACHED  .xlsx  → the same card reached from a user attachment
 *
 * Timestamps anchor off conv-file-showcase (like the chart and code
 * showcases) so the demo's ordering is fixed rather than build-time.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { sampleExtFor } from './sample-exts.mjs'

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const DEMO = process.env.DEMO_OUT ?? path.join(ROOT, 'demo')

/**
 * Hours above conv-file-showcase. Below the code showcase (60 h), which stays
 * the demo's opening conversation, and above the chart showcase (12 h).
 */
const DECK_OFFSET_H = 52
const BOOK_OFFSET_H = 50

const DECK_DIR = 'files/decks'
const BOOK_DIR = 'files/survey'

function send(turnId, index, relPath, kind, note) {
  const toolCallId = `call_${turnId}_${index}`
  return [
    {
      kind: 'tool_call',
      turnId,
      segmentId: `sc_${turnId}_${index}`,
      toolCallId,
      name: 'send_file',
      args: { path: relPath }
    },
    {
      kind: 'tool_result',
      turnId,
      segmentId: `sr_${turnId}_${index}`,
      toolCallId,
      status: 'success',
      output: `${note}\n[wolffish-output: ${relPath} (${kind})]`
    }
  ]
}

function deck(createdAt) {
  const updatedAt = createdAt + 214_000
  const segments = [
    {
      kind: 'reasoning',
      turnId: 't1',
      segmentId: 'r0',
      delta:
        'Seven slides is the right length for a twenty-minute slot. Title, the ' +
        'one-paragraph framing, the traits that matter, the species table, the ' +
        'depth chart, the distribution picture, then a closing note.'
    },
    {
      kind: 'text',
      turnId: 't1',
      segmentId: 's0',
      delta:
        'Built it around the five species in your notes — seven slides, with the ' +
        'depth comparison as a chart rather than another table.\n'
    },
    ...send('t1', 0, `${DECK_DIR}/wolffish-review.pptx`, 'document', 'Deck written.'),
    {
      kind: 'text',
      turnId: 't1',
      segmentId: 's1',
      delta:
        '\nSlide 5 is the one to rehearse: the depth ranges overlap more than the ' +
        'table suggests, and the chart makes that obvious. I also left the ' +
        'species table on slide 4 so you have the numbers on screen if anyone ' +
        'asks.\n'
    },
    ...send('t1', 1, `${DECK_DIR}/talk-track.md`, 'document', 'Speaker notes written.'),
    {
      kind: 'turn_end',
      turnId: 't1',
      segmentId: 'end1',
      stopReason: 'end_turn',
      iterationCount: 3
    }
  ]

  return {
    id: 'deck-showcase',
    title: 'Deck for the wolffish review',
    model: 'claude-opus-4-8',
    channel: 'electron',
    createdAt,
    updatedAt,
    messages: [
      {
        id: 'm_deck_user',
        role: 'user',
        content:
          'Turn my wolffish notes into a short deck for Thursday — seven slides at ' +
          'most, and put the depth numbers in a chart.',
        timestamp: createdAt
      },
      {
        id: 'm_deck_assistant',
        role: 'assistant',
        content: '',
        timestamp: updatedAt,
        segments
      }
    ]
  }
}

function workbook(createdAt) {
  const updatedAt = createdAt + 168_000
  const segments = [
    {
      kind: 'reasoning',
      turnId: 't1',
      segmentId: 'r0',
      delta:
        'Three sheets in the file they sent: species, monthly readings, and a ' +
        'notes tab. The readings tab is the one with the problem — the TOTAL row ' +
        'is inside the data range, so anything that reads the sheet picks it up ' +
        'as a thirteenth month.'
    },
    {
      kind: 'text',
      turnId: 't1',
      segmentId: 's0',
      delta:
        'Found it — the TOTAL row on the Readings sheet sits inside the data ' +
        'range, so every average you computed was pulled toward it. Cleaned ' +
        'version attached, same three sheets.\n'
    },
    ...send('t1', 0, `${BOOK_DIR}/survey-clean.xlsx`, 'document', 'Workbook rewritten.'),
    {
      kind: 'text',
      turnId: 't1',
      segmentId: 's1',
      delta:
        '\nThe Species sheet is unchanged. Readings now stops at December, and I ' +
        'moved the total out to its own row below a blank. Write-up of what ' +
        'changed and why the old averages were off:\n'
    },
    ...send('t1', 1, `${BOOK_DIR}/survey-findings.docx`, 'document', 'Write-up saved.'),
    {
      kind: 'turn_end',
      turnId: 't1',
      segmentId: 'end1',
      stopReason: 'end_turn',
      iterationCount: 4
    }
  ]

  return {
    id: 'workbook-showcase',
    title: 'Survey workbook is off',
    model: 'claude-opus-4-8',
    channel: 'electron',
    createdAt,
    updatedAt,
    messages: [
      {
        id: 'm_book_user',
        role: 'user',
        content:
          'The depth averages in this workbook look wrong to me but I cannot see ' +
          'why. Can you check it?',
        timestamp: createdAt,
        // sizeBytes 0: the size isn't known until the sample is downloaded, and
        // the cards already fall back to the size of the file the cache holds.
        attachments: [
          {
            type: 'document',
            filePath: `${BOOK_DIR}/field-survey.xlsx`,
            originalName: 'field-survey.xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            sizeBytes: 0
          }
        ]
      },
      {
        id: 'm_book_assistant',
        role: 'assistant',
        content: '',
        timestamp: updatedAt,
        segments
      }
    ]
  }
}

async function main() {
  const conversationsDir = path.join(DEMO, 'conversations')
  await fs.mkdir(conversationsDir, { recursive: true })

  const showcaseRaw = await fs.readFile(
    path.join(conversationsDir, 'conv-file-showcase.json'),
    'utf-8'
  )
  const anchor = JSON.parse(showcaseRaw).updatedAt
  if (typeof anchor !== 'number') throw new Error('conv-file-showcase.json has no updatedAt')

  const built = [
    deck(anchor + DECK_OFFSET_H * 3600_000),
    workbook(anchor + BOOK_OFFSET_H * 3600_000)
  ]

  // Every path in these conversations must resolve to a published sample, or
  // the card it was written for renders its unavailable state instead.
  const referenced = new Set()
  for (const conversation of built) {
    const body = JSON.stringify(conversation)
    for (const match of body.matchAll(/[\w./-]+\.(?:pptx|xlsx|docx|md)/g)) referenced.add(match[0])
  }
  const unpublished = [...referenced].filter((name) => !sampleExtFor(name))
  if (unpublished.length) {
    console.warn(`no published sample for: ${unpublished.join(', ')} — will render unavailable`)
  }

  for (const conversation of built) {
    await fs.writeFile(
      path.join(conversationsDir, `conv-${conversation.id}.json`),
      JSON.stringify(conversation)
    )
    console.log(
      `conversation: demo/conversations/conv-${conversation.id}.json` +
        ` — ${new Date(conversation.updatedAt).toISOString()}`
    )
  }
  console.log(`sorts above chart showcase, below code showcase`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
