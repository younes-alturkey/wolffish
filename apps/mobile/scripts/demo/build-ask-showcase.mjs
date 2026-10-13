#!/usr/bin/env node
/**
 * Build the ask-the-user conversation into demo/ — one `ask_user` card carrying
 * twenty questions.
 *
 *   node scripts/demo/build-ask-showcase.mjs        # writes into demo/
 *   node scripts/demo/build-demo-bundle.mjs         # pack for the CDN
 *
 * Twenty is not decoration. A one-question card is the easy case; the multi
 * card is a different component path — the scrolling chip row, the tick on an
 * answered chip, auto-advance to the next unanswered question, one submit at
 * the end, and the per-question summary footer — and only a card with enough
 * questions to overflow the row exercises the horizontal scroll and the
 * keep-the-active-chip-in-view effect.
 *
 * Nothing about the ANSWERS is persisted beyond the tool result's text, on
 * either platform, so the card is rebuilt from `args` + `output` when the
 * conversation is read back. That makes the output format load-bearing: it has
 * to match the `ask` plugin's stable wording exactly or QuestionCard's parser
 * returns null and the card falls back to printing raw text. The emitter below
 * is the format, and src/components/chat/QuestionCard.tsx `parseAnswers` is the
 * reader — keep the two in step.
 *
 * Timestamps anchor off conv-file-showcase so the showcases keep a fixed order
 * at the top of the list; re-run this whenever that one is regenerated.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const DEMO = process.env.DEMO_OUT ?? path.join(ROOT, 'demo')
const CONV_ID = 'ask-showcase'
/** Hours above the file showcase — see build-chart-showcase for the convention. */
const ANCHOR_OFFSET_H = 36

const MODEL = 'claude-opus-4-8'
const TOOL_CALL_ID = 'call_setup_interview'

/**
 * The interview. `answer` is a 1-based option number, or a string for the
 * free-text escape hatch — both of which the emitter below renders in the
 * plugin's own wording.
 *
 * Deliberately varied: some questions carry `details`, some suppress the
 * free-text option entirely (`allowOther: false`), one renames it, and the
 * option lists run from two to five entries — every shape the card draws.
 */
const QUESTIONS = [
  {
    question: 'How should the morning brief reach you?',
    details: 'It is built at 07:30 either way — this is only about delivery.',
    options: [
      { label: 'Telegram', description: 'One message, readable on the lock screen.' },
      { label: 'A PDF plus a short Telegram summary', description: 'The magazine layout.' },
      { label: 'In the app only', description: 'Nothing pushed anywhere.' }
    ],
    allowOther: true,
    answer: 2
  },
  {
    question: 'How long should it be?',
    options: [
      { label: 'Under 150 words' },
      { label: 'Around half a page' },
      { label: 'As long as the day warrants' }
    ],
    allowOther: false,
    answer: 1
  },
  {
    question: 'What counts as worth reporting?',
    options: [
      { label: 'Anything that shipped', description: 'Releases, launches, API changes.' },
      { label: 'Anything that changes a decision this week' },
      { label: 'Everything, and I will skim' }
    ],
    allowOther: true,
    answer: 2
  },
  {
    question: 'Funding rounds and hiring news?',
    options: [{ label: 'Cut them entirely' }, { label: 'One line, at the bottom' }],
    allowOther: false,
    answer: 1
  },
  {
    question: 'How many sources before a claim goes in?',
    details: 'A press release does not count as one — the filing behind it does.',
    options: [{ label: 'One is enough if it is primary' }, { label: 'Two, both named' }],
    allowOther: false,
    answer: 2
  },
  {
    question: 'Which language should the brief be written in?',
    options: [
      { label: 'English' },
      { label: 'Arabic' },
      { label: 'Match whichever language I asked in' }
    ],
    allowOther: false,
    answer: 1
  },
  {
    question: 'When should the workday be considered over?',
    options: [{ label: '17:00' }, { label: '18:00' }, { label: '20:00' }],
    allowOther: true,
    answer: 2
  },
  {
    question: 'May I schedule things before 09:00?',
    options: [
      { label: 'Never' },
      { label: 'Only if I asked for that time specifically' },
      { label: 'Yes, whenever it fits' }
    ],
    allowOther: false,
    answer: 2
  },
  {
    question: 'What should happen on a quiet hour?',
    details: 'The hourly deploy check, when nothing is wrong.',
    options: [
      { label: 'Send nothing', description: 'Silence means healthy.' },
      { label: 'A short all-clear' }
    ],
    allowOther: false,
    answer: 1
  },
  {
    question: 'Where do phone notifications belong?',
    options: [
      { label: 'Failures and questions only' },
      { label: 'Anything an automation produced' },
      { label: 'Nothing — I will open the app' }
    ],
    allowOther: false,
    answer: 1
  },
  {
    question: 'How should I handle a task that turns out bigger than asked?',
    options: [
      { label: 'Do it and say what changed' },
      { label: 'Stop and check first' },
      { label: 'Do the asked part, list the rest' }
    ],
    allowOther: true,
    answer: 1
  },
  {
    question: 'Confirm before sending a message to another person?',
    options: [{ label: 'Always' }, { label: 'Only outside my contacts' }],
    allowOther: false,
    answer: 1
  },
  {
    question: 'Default run mode for new procedures?',
    details: 'Workflow spawns sub-agents; single is one conversation start to finish.',
    options: [{ label: 'Single' }, { label: 'Workflow' }, { label: 'Decide per procedure' }],
    allowOther: false,
    answer: 3
  },
  {
    question: 'How much should the feed show mid-turn?',
    options: [
      { label: 'Just the answer' },
      { label: 'Every tool call and activity card' },
      { label: 'Clean on the phone, verbose on the desktop' }
    ],
    allowOther: false,
    answer: 3
  },
  {
    question: 'When the nightly reflection scores a turn, whose scores count?',
    options: [
      { label: 'Mine only' },
      { label: 'Mine plus the model’s own review' },
      { label: 'The model’s review only' }
    ],
    allowOther: false,
    answer: 2
  },
  {
    question: 'Which day should the weekly review land on?',
    options: [
      { label: 'Thursday evening' },
      { label: 'Sunday morning' },
      { label: 'Monday 09:00' }
    ],
    allowOther: false,
    answer: 2
  },
  {
    question: 'What should the weekly review lead with?',
    options: [
      { label: 'What shipped' },
      { label: 'What slipped' },
      { label: 'What is blocking something else' },
      { label: 'What changed since the last review' }
    ],
    allowOther: true,
    answer: 4
  },
  {
    question: 'How long should a receipt stay in the workspace after filing?',
    options: [
      { label: 'Delete it once the row is written' },
      { label: 'Keep it 30 days' },
      { label: 'Keep everything' }
    ],
    allowOther: false,
    answer: 2
  },
  {
    question: 'What should I do when two instructions in your Soul file disagree?',
    options: [
      { label: 'Follow the more specific one' },
      { label: 'Follow the later one' },
      { label: 'Stop and ask' }
    ],
    allowOther: true,
    answer: 3
  },
  {
    question: 'Anything else I should hold onto before I write this down?',
    details: 'Whatever you type here goes into the User document verbatim.',
    options: [
      { label: 'Nothing — write it up' },
      { label: 'Show me the diff first' },
      { label: 'Let me add something' }
    ],
    allowOther: true,
    otherLabel: 'Add a standing fact',
    otherDescription: 'Type it and it lands in brain/identity/user.md.',
    answer:
      'Tuesdays are cleaning mornings — Sohel comes around 09:00, so nothing at the flat before 11.'
  }
]

/**
 * The `ask` plugin's numbered multi-question summary, verbatim. Custom answers
 * are indented three spaces so an answer that starts with "1. " cannot fake a
 * question boundary in the reader's split — that indentation IS the guard, and
 * parseAnswers strips exactly three spaces back off.
 */
function renderOutput(questions) {
  const blocks = questions.map((question, index) => {
    const head = `${index + 1}. ${question.question}`
    if (typeof question.answer === 'number') {
      return `${head}\n   → Selected option ${question.answer} of ${question.options.length}`
    }
    const body = question.answer
      .split('\n')
      .map((line) => `   ${line}`)
      .join('\n')
    return `${head}\n   → Answered in their own words:\n${body}`
  })
  return `The user answered all ${questions.length} questions:\n\n${blocks.join('\n\n')}`
}

/** The tool_call args, in the plugin's own snake_case wire shape. */
function renderArgs(questions) {
  return {
    questions: questions.map((question) => ({
      question: question.question,
      ...(question.details ? { details: question.details } : {}),
      options: question.options,
      allow_other: question.allowOther,
      ...(question.otherLabel ? { other_label: question.otherLabel } : {}),
      ...(question.otherDescription ? { other_description: question.otherDescription } : {})
    }))
  }
}

async function main() {
  await fs.mkdir(path.join(DEMO, 'conversations'), { recursive: true })

  const showcaseRaw = await fs.readFile(
    path.join(DEMO, 'conversations', 'conv-file-showcase.json'),
    'utf8'
  )
  const anchor = JSON.parse(showcaseRaw).updatedAt
  if (typeof anchor !== 'number') throw new Error('conv-file-showcase.json has no updatedAt')
  const updatedAt = anchor + ANCHOR_OFFSET_H * 3600_000
  const createdAt = updatedAt - 9 * 60_000

  const output = renderOutput(QUESTIONS)

  const segments = [
    {
      kind: 'active_model',
      turnId: 't1',
      segmentId: 's0',
      provider: 'anthropic',
      model: MODEL
    },
    {
      kind: 'text',
      turnId: 't1',
      segmentId: 's1',
      delta:
        'Before I rewrite anything, twenty questions. Most are one tap; the last one is open.\n'
    },
    {
      kind: 'tool_call',
      turnId: 't1',
      segmentId: 's2',
      toolCallId: TOOL_CALL_ID,
      name: 'ask_user',
      args: renderArgs(QUESTIONS)
    },
    {
      kind: 'tool_result',
      turnId: 't1',
      segmentId: 's3',
      toolCallId: TOOL_CALL_ID,
      status: 'success',
      output
    },
    {
      kind: 'text',
      turnId: 't1',
      segmentId: 's4',
      delta:
        'Written. Here is what changed:\n\n' +
        '**brain/identity/soul.md** — brief capped at 150 words, funding and hiring cut, two ' +
        'named sources per claim, English regardless of the question’s language. On a ' +
        'contradiction inside this file I stop and ask rather than resolving it myself.\n\n' +
        '**brain/identity/user.md** — day ends 18:00, nothing scheduled before 09:00 unless you ' +
        'named the time, and Tuesday mornings are blocked until 11:00.\n\n' +
        '**brain/prefrontal/agents.md** — a task that grows gets done and reported, messages to ' +
        'other people are always confirmed, and the weekly review moves to Sunday morning and ' +
        'leads with what changed since the last one.\n\n' +
        'Two answers I did **not** write down as rules, because they are settings rather than ' +
        'instructions: the run mode stays per-procedure, and the feed stays clean on the phone ' +
        'and verbose on the desktop. Both are switches in Settings, and putting them in a ' +
        'markdown file would give you two places to change one thing.'
    },
    {
      kind: 'turn_end',
      turnId: 't1',
      segmentId: 's5',
      stopReason: 'end_turn',
      iterationCount: 2
    }
  ]

  const conversation = {
    id: CONV_ID,
    title: 'Set up the way I actually work',
    model: MODEL,
    channel: 'electron',
    createdAt,
    updatedAt,
    messages: [
      {
        id: 'm_ask_user',
        role: 'user',
        content:
          'Interview me and write the answers into my Soul, User and Agents files. Ask ' +
          'everything you need in one go — I would rather do this once.',
        timestamp: createdAt
      },
      {
        id: 'm_ask_assistant',
        role: 'assistant',
        content: '',
        timestamp: updatedAt,
        segments,
        // The clock runs while the card sits open — most of this turn is the
        // user reading twenty questions, not the model working.
        toolTimings: {
          [TOOL_CALL_ID]: { startedAt: createdAt + 6_000, endedAt: updatedAt - 8_000 }
        },
        stopReason: 'end_turn'
      }
    ],
    stats: {
      allTime: {
        turns: 1,
        toolCalls: 1,
        apiCalls: 2,
        inputTokens: 9_814,
        outputTokens: 2_473,
        cost: 0.0684,
        provider: 'anthropic',
        model: MODEL,
        elapsedMs: 9 * 60_000,
        endedAt: updatedAt
      },
      meter: { contextTokens: 12_287, contextBudget: 200_000, model: MODEL }
    },
    ratings: [{ messageId: 'm_ask_assistant', score: 10, at: updatedAt + 95_000, source: 'inapp' }]
  }

  await fs.writeFile(
    path.join(DEMO, 'conversations', `conv-${CONV_ID}.json`),
    JSON.stringify(conversation)
  )

  const custom = QUESTIONS.filter((question) => typeof question.answer === 'string').length
  console.log(`questions:    ${QUESTIONS.length} (${custom} answered in their own words)`)
  console.log(`sorts above file showcase: updatedAt ${new Date(updatedAt).toISOString()}`)
  console.log(`conversation: demo/conversations/conv-${CONV_ID}.json`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
