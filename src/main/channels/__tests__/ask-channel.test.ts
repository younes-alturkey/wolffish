/**
 * Stress test for ask_user on the text-only channels (Telegram / WhatsApp).
 *
 * In-app the answers are clicks on one card; on Telegram/WhatsApp the
 * questions are posed one message at a time and each answer is the user's
 * NEXT message — a number picks an option, any other text is "something
 * else". This pins the pieces that make that work:
 *
 *   1. interpretAskReply — the SHARED decision logic both channels use to
 *      classify a reply (option / custom / reprompt). Table-driven, exhaustive.
 *   2. The full round-trip — the real `ask` plugin's execute() driven through a
 *      fake channel that wires the bridge exactly like the real channels do
 *      (handleAskRequest stores the resolver + question queue; each inbound
 *      reply runs through the real interpretAskReply against the CURRENT
 *      question; turn-end / abort resolve canceled). Proves plugin → bridge →
 *      channel replies → resolve → plugin output end to end, for single AND
 *      multi-question asks, including the output format the in-app
 *      QuestionCard re-parses to rebuild answered cards from history.
 *
 * Run: npx tsx src/main/channels/__tests__/ask-channel.test.ts
 */

import { interpretAskReply, parseAskNumber } from '../ask-reply'
// The real ask capability plugin (ES module, same file the runtime loads).
import askPlugin from '../../../defaults/workspace/brain/cerebellum/ask/plugin/index.mjs'

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

// The parser the in-app QuestionCard uses to recover the chosen answers from
// the persisted tool_result (kept in sync with renderer parseAnswers).
// Re-checked here so a Telegram/WhatsApp answer also renders correctly in the
// in-app history card.
type MirrorAnswer = { kind: 'option'; index: number } | { kind: 'custom'; text?: string }
function parseAnswersMirror(output: string, questionCount: number): MirrorAnswer[] | null {
  if (questionCount === 1) {
    const opt = output.match(/selected option (\d+) of \d+/i)
    if (opt) return [{ kind: 'option', index: Number(opt[1]) - 1 }]
    const custom = output.match(/instead instructed:\n([\s\S]*)$/i)
    if (custom) return [{ kind: 'custom', text: custom[1] }]
    return null
  }
  if (!/^The user answered all \d+ questions:/.test(output)) return null
  const body = output.replace(/^The user answered all \d+ questions:\s*/, '')
  const blocks = body.split(/\n\n(?=\d+\. )/)
  if (blocks.length !== questionCount) return null
  const answers: MirrorAnswer[] = []
  for (const block of blocks) {
    const opt = block.match(/→ Selected option (\d+) of \d+/)
    if (opt) {
      answers.push({ kind: 'option', index: Number(opt[1]) - 1 })
      continue
    }
    const custom = block.match(/→ Answered in their own words:\n([\s\S]*)$/)
    if (custom) {
      answers.push({
        kind: 'custom',
        text: custom[1]
          .split('\n')
          .map((line) => line.replace(/^ {3}/, ''))
          .join('\n')
      })
      continue
    }
    return null
  }
  return answers
}

// ── 1. interpretAskReply — exhaustive table ────────────────────────────────
type Case = {
  text: string
  count: number
  allowOther: boolean
  expect: ReturnType<typeof interpretAskReply>
}
const N = 3
const CASES: Case[] = [
  // in-range numbers → option (0-based)
  { text: '1', count: N, allowOther: true, expect: { kind: 'option', index: 0 } },
  { text: '3', count: N, allowOther: true, expect: { kind: 'option', index: 2 } },
  { text: ' 2 ', count: N, allowOther: true, expect: { kind: 'option', index: 1 } },
  { text: '2\n', count: N, allowOther: true, expect: { kind: 'option', index: 1 } },
  { text: '02', count: N, allowOther: true, expect: { kind: 'option', index: 1 } },
  // out-of-range bare numbers → reprompt (a misclick, NOT instructions)
  { text: '0', count: N, allowOther: true, expect: { kind: 'reprompt', reason: 'out-of-range' } },
  { text: '4', count: N, allowOther: true, expect: { kind: 'reprompt', reason: 'out-of-range' } },
  { text: '99', count: N, allowOther: true, expect: { kind: 'reprompt', reason: 'out-of-range' } },
  // free text → custom (allowOther) — including text that CONTAINS a digit
  {
    text: 'sushi please',
    count: N,
    allowOther: true,
    expect: { kind: 'custom', text: 'sushi please' }
  },
  {
    text: 'do option 3 but cheaper',
    count: N,
    allowOther: true,
    expect: { kind: 'custom', text: 'do option 3 but cheaper' }
  },
  { text: '3 of them', count: N, allowOther: true, expect: { kind: 'custom', text: '3 of them' } },
  { text: '  trim me  ', count: N, allowOther: true, expect: { kind: 'custom', text: 'trim me' } },
  // allowOther = false → text / out-of-range both reprompt, in-range still works
  {
    text: 'whatever',
    count: N,
    allowOther: false,
    expect: { kind: 'reprompt', reason: 'need-number' }
  },
  { text: '9', count: N, allowOther: false, expect: { kind: 'reprompt', reason: 'out-of-range' } },
  { text: '2', count: N, allowOther: false, expect: { kind: 'option', index: 1 } },
  // single-option question
  { text: '1', count: 1, allowOther: true, expect: { kind: 'option', index: 0 } },
  { text: '2', count: 1, allowOther: true, expect: { kind: 'reprompt', reason: 'out-of-range' } }
]
for (const c of CASES) {
  const got = interpretAskReply(c.text, c.count, c.allowOther)
  ok(
    `interpret ${JSON.stringify(c.text)} (n=${c.count},other=${c.allowOther})`,
    JSON.stringify(got) === JSON.stringify(c.expect),
    `got ${JSON.stringify(got)} want ${JSON.stringify(c.expect)}`
  )
}

// strict number parser edge cases
ok('parseAskNumber pure', parseAskNumber('7') === 7)
ok('parseAskNumber padded', parseAskNumber('  7  ') === 7)
ok('parseAskNumber text+digit null', parseAskNumber('pick 7') === null)
ok('parseAskNumber empty null', parseAskNumber('') === null)
ok('parseAskNumber 3-digit null', parseAskNumber('100') === null)

// ── 2. Fake text channel mirroring the real handleAskRequest/resolvePendingAsk
type AskOption = { label: string; description?: string }
type AskQuestion = {
  question: string
  details?: string
  options: AskOption[]
  allowOther: boolean
}
type AskAnswer = { kind: 'option'; index: number } | { kind: 'custom'; text: string }
type AskResponse =
  | { kind: 'answered'; answers: AskAnswer[] }
  | { kind: 'canceled' }
  | { kind: 'unsupported' }

class FakeTextChannel {
  sent: string[] = []
  private pending: { questions: AskQuestion[]; current: number; answers: AskAnswer[] } | null = null
  private resolve: ((r: AskResponse) => void) | null = null

  // mirrors channel.handleAskRequest — posts the FIRST question, queues the rest
  onAskUserRequest(req: { questions: AskQuestion[] }): Promise<AskResponse> {
    return new Promise<AskResponse>((resolve) => {
      if (req.questions.length === 0) {
        resolve({ kind: 'canceled' })
        return
      }
      if (this.resolve) this.resolve({ kind: 'canceled' }) // supersede prior
      this.pending = { questions: req.questions, current: 0, answers: [] }
      this.resolve = resolve
      this.postCurrent()
    })
  }

  private postCurrent(): void {
    if (!this.pending) return
    const q = this.pending.questions[this.pending.current]
    this.sent.push(
      `Q${this.pending.current + 1}/${this.pending.questions.length}:${q.question}|opts:${q.options.length}|other:${q.allowOther}`
    )
  }

  // mirrors the inbound handler + channel.resolvePendingAsk (real interpreter,
  // same ordering: the final answer resolves BEFORE the ack goes out)
  reply(text: string): void {
    if (!this.pending || !this.resolve) {
      this.sent.push('no-pending')
      return
    }
    const q = this.pending.questions[this.pending.current]
    const outcome = interpretAskReply(text, q.options.length, q.allowOther)
    if (outcome.kind === 'reprompt') {
      this.sent.push(`reprompt:${outcome.reason}`)
      return
    }
    this.pending.answers.push(
      outcome.kind === 'option'
        ? { kind: 'option', index: outcome.index }
        : { kind: 'custom', text: outcome.text }
    )
    const finished = this.pending.current + 1 >= this.pending.questions.length
    if (finished) {
      const r = this.resolve
      const answers = this.pending.answers
      this.pending = null
      this.resolve = null
      r({ kind: 'answered', answers })
    }
    this.sent.push(
      outcome.kind === 'option'
        ? `ack:option ${outcome.index + 1}: ${q.options[outcome.index].label}`
        : 'ack:custom'
    )
    if (!finished && this.pending) {
      this.pending.current++
      this.postCurrent()
    }
  }

  endTurn(): void {
    if (this.resolve) {
      const r = this.resolve
      this.resolve = null
      this.pending = null
      r({ kind: 'canceled' })
    }
  }

  hasPending(): boolean {
    return this.pending !== null
  }

  pendingIndex(): number {
    return this.pending ? this.pending.current : -1
  }
}

type Plugin = {
  init: (ctx: { askUser: (input: unknown) => Promise<AskResponse> }) => Promise<void>
  execute: (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<{ success: boolean; output?: string; error?: string }>
}
const plugin = askPlugin as unknown as Plugin

// Wire the plugin's askUser to the fake channel, exactly as Cerebellum does
// (inject toolCallId + id, then dispatch to the channel sink).
function wire(channel: FakeTextChannel): void {
  void plugin.init({
    askUser: (input) =>
      channel.onAskUserRequest({
        ...(input as { questions: AskQuestion[] })
        // toolCallId/id are injected by Cerebellum in the real path
      })
  })
}

const OPTS = [
  { label: 'Koyee', description: 'broad menu' },
  { label: 'Seoul', description: 'crowd favorite' }
]

async function run(): Promise<void> {
  // ── legacy single-question args (top-level question/options) ──
  // option pick
  {
    const ch = new FakeTextChannel()
    wire(ch)
    const p = plugin.execute('ask_user', { question: 'Where?', options: OPTS })
    await tick()
    ok('e2e option: question sent', ch.sent[0]?.startsWith('Q1/1:Where?'), ch.sent.join(' | '))
    ch.reply('1')
    const r = await p
    ok('e2e option: success', r.success === true, JSON.stringify(r))
    ok(
      'e2e option: output names choice',
      /option 1 of 2/.test(r.output ?? '') && /Koyee/.test(r.output ?? ''),
      r.output
    )
    const mirrored = parseAnswersMirror(r.output ?? '', 1)
    ok(
      'e2e option: history parse round-trips',
      mirrored?.[0]?.kind === 'option' && mirrored[0].index === 0,
      r.output
    )
  }

  // custom (something else) via free text
  {
    const ch = new FakeTextChannel()
    wire(ch)
    const p = plugin.execute('ask_user', { question: 'Where?', options: OPTS })
    await tick()
    ch.reply('somewhere with sushi')
    const r = await p
    ok('e2e custom: success', r.success === true, JSON.stringify(r))
    ok(
      'e2e custom: output carries text',
      /instead instructed/.test(r.output ?? '') && /sushi/.test(r.output ?? ''),
      r.output
    )
    const mirrored = parseAnswersMirror(r.output ?? '', 1)
    ok(
      'e2e custom: history parse recovers text',
      mirrored?.[0]?.kind === 'custom' && mirrored[0].text === 'somewhere with sushi',
      r.output
    )
  }

  // out-of-range number → reprompt (stays pending), then a valid pick
  {
    const ch = new FakeTextChannel()
    wire(ch)
    const p = plugin.execute('ask_user', { question: 'Where?', options: OPTS })
    await tick()
    ch.reply('9')
    ok('e2e reprompt: still pending after bad number', ch.hasPending() === true)
    ok(
      'e2e reprompt: told to retry',
      ch.sent.some((s) => s.startsWith('reprompt:out-of-range'))
    )
    ch.reply('2')
    const r = await p
    ok(
      'e2e reprompt: resolves on valid retry',
      r.success === true && /option 2 of 2/.test(r.output ?? ''),
      r.output
    )
  }

  // digit-in-text must NOT be read as an option pick → custom
  {
    const ch = new FakeTextChannel()
    wire(ch)
    const p = plugin.execute('ask_user', { question: 'Where?', options: OPTS })
    await tick()
    ch.reply('do 2 but spicier')
    const r = await p
    ok(
      'e2e digit-in-text: treated as custom',
      r.success === true && /instead instructed/.test(r.output ?? ''),
      r.output
    )
  }

  // allowOther:false — free text reprompts, only a number resolves
  {
    const ch = new FakeTextChannel()
    wire(ch)
    const p = plugin.execute('ask_user', {
      question: 'Where?',
      options: OPTS,
      allow_other: false
    })
    await tick()
    ch.reply('neither')
    ok(
      'e2e no-other: text reprompts',
      ch.hasPending() === true && ch.sent.some((s) => s.startsWith('reprompt:need-number'))
    )
    ch.reply('1')
    const r = await p
    ok(
      'e2e no-other: number resolves',
      r.success === true && /option 1 of 2/.test(r.output ?? ''),
      r.output
    )
  }

  // turn ends before the user answers → canceled → graceful failure
  {
    const ch = new FakeTextChannel()
    wire(ch)
    const p = plugin.execute('ask_user', { question: 'Where?', options: OPTS })
    await tick()
    ch.endTurn()
    const r = await p
    ok(
      'e2e turn-end: canceled → failure',
      r.success === false && /dismiss|stop/i.test(r.error ?? ''),
      JSON.stringify(r)
    )
  }

  // user presses stop mid-question → abort signal unblocks execute()
  {
    const ch = new FakeTextChannel()
    wire(ch)
    const ac = new AbortController()
    const p = plugin.execute('ask_user', { question: 'Where?', options: OPTS }, ac.signal)
    await tick()
    ok('e2e abort: pending before abort', ch.hasPending() === true)
    ac.abort()
    const r = await p
    ok('e2e abort: unblocks with failure', r.success === false, JSON.stringify(r))
  }

  // superseding request cancels the prior pending one
  {
    const ch = new FakeTextChannel()
    let resolved: AskResponse | null = null
    const first = ch.onAskUserRequest({
      questions: [{ question: 'first', options: OPTS, allowOther: true }]
    })
    void first.then((r) => {
      resolved = r
    })
    void ch.onAskUserRequest({
      questions: [{ question: 'second', options: OPTS, allowOther: true }]
    })
    await tick()
    ok(
      'supersede: prior resolves canceled',
      resolved !== null && (resolved as AskResponse).kind === 'canceled',
      JSON.stringify(resolved)
    )
    ok('supersede: latest is pending', ch.hasPending() === true)
  }

  // ── multi-question asks (the `questions` array) ──
  const MULTI = {
    questions: [
      {
        question: 'Which database?',
        options: [
          { label: 'SQLite', description: 'file-based' },
          { label: 'PostgreSQL', description: 'heavier' },
          { label: 'MySQL' }
        ]
      },
      { question: 'Deploy where?', options: OPTS },
      { question: 'Seed demo data?', options: [{ label: 'Yes' }, { label: 'No' }] }
    ]
  }

  // sequential flow: option → custom (multiline, with a numbered-list trap) → option
  {
    const ch = new FakeTextChannel()
    wire(ch)
    const p = plugin.execute('ask_user', MULTI)
    await tick()
    ok(
      'multi: first question posted',
      ch.sent[0]?.startsWith('Q1/3:Which database?'),
      ch.sent.join(' | ')
    )
    ch.reply('2')
    ok('multi: advanced to Q2', ch.pendingIndex() === 1, ch.sent.join(' | '))
    ok(
      'multi: Q2 posted after Q1 answered',
      ch.sent.some((s) => s.startsWith('Q2/3:Deploy where?'))
    )
    // Multiline custom answer whose second line starts like a question block —
    // the emitter indents it, so the history parser must NOT split on it.
    ch.reply('my VPS\n2. with docker')
    ok('multi: advanced to Q3', ch.pendingIndex() === 2, ch.sent.join(' | '))
    ch.reply('1')
    const r = await p
    ok('multi: success', r.success === true, JSON.stringify(r))
    ok(
      'multi: output header + all questions present',
      /^The user answered all 3 questions:/.test(r.output ?? '') &&
        /Which database\?/.test(r.output ?? '') &&
        /Deploy where\?/.test(r.output ?? '') &&
        /Seed demo data\?/.test(r.output ?? ''),
      r.output
    )
    ok(
      'multi: option answers name their choice',
      /Selected option 2 of 3: "PostgreSQL" — heavier/.test(r.output ?? '') &&
        /Selected option 1 of 2: "Yes"/.test(r.output ?? ''),
      r.output
    )
    const mirrored = parseAnswersMirror(r.output ?? '', 3)
    ok('multi: history parse finds 3 answers', mirrored !== null && mirrored.length === 3)
    ok(
      'multi: history parse round-trips picks',
      mirrored?.[0]?.kind === 'option' &&
        mirrored[0].index === 1 &&
        mirrored[2]?.kind === 'option' &&
        mirrored[2].index === 0,
      JSON.stringify(mirrored)
    )
    ok(
      'multi: history parse recovers multiline custom text verbatim',
      mirrored?.[1]?.kind === 'custom' && mirrored[1].text === 'my VPS\n2. with docker',
      JSON.stringify(mirrored)
    )
  }

  // reprompt mid-sequence: Q2 stays current until a valid answer arrives
  {
    const ch = new FakeTextChannel()
    wire(ch)
    const p = plugin.execute('ask_user', MULTI)
    await tick()
    ch.reply('1')
    ch.reply('9')
    ok('multi reprompt: still on Q2', ch.pendingIndex() === 1, ch.sent.join(' | '))
    ok(
      'multi reprompt: told to retry',
      ch.sent.some((s) => s.startsWith('reprompt:out-of-range'))
    )
    ch.reply('1')
    ch.reply('2')
    const r = await p
    ok(
      'multi reprompt: completes after retry',
      r.success === true && /Selected option 2 of 2: "No"/.test(r.output ?? ''),
      r.output
    )
  }

  // per-question allow_other: Q2 requires a number, free text reprompts there
  {
    const ch = new FakeTextChannel()
    wire(ch)
    const p = plugin.execute('ask_user', {
      questions: [
        { question: 'Pick one', options: OPTS },
        { question: 'Strict pick', options: OPTS, allow_other: false }
      ]
    })
    await tick()
    ch.reply('whatever works') // Q1 allows custom
    ok('multi other: Q1 custom accepted', ch.pendingIndex() === 1, ch.sent.join(' | '))
    ch.reply('neither') // Q2 does not
    ok(
      'multi other: Q2 free text reprompts',
      ch.hasPending() === true && ch.sent.some((s) => s.startsWith('reprompt:need-number'))
    )
    ch.reply('2')
    const r = await p
    ok(
      'multi other: completes with mixed answers',
      r.success === true &&
        /Answered in their own words:\n {3}whatever works/.test(r.output ?? '') &&
        /Selected option 2 of 2: "Seoul"/.test(r.output ?? ''),
      r.output
    )
  }

  // abort mid-sequence (after Q1 answered) → canceled, partial answers dropped
  {
    const ch = new FakeTextChannel()
    wire(ch)
    const ac = new AbortController()
    const p = plugin.execute('ask_user', MULTI, ac.signal)
    await tick()
    ch.reply('1')
    ok('multi abort: mid-sequence pending', ch.pendingIndex() === 1)
    ac.abort()
    const r = await p
    ok('multi abort: unblocks with failure', r.success === false, JSON.stringify(r))
  }

  // malformed input: empty questions array / a question without options → error
  {
    const ch = new FakeTextChannel()
    wire(ch)
    const r1 = await plugin.execute('ask_user', { questions: [] })
    ok('bad args: empty questions errors', r1.success === false, JSON.stringify(r1))
    const r2 = await plugin.execute('ask_user', {
      questions: [{ question: 'ok', options: OPTS }, { question: 'broken' }]
    })
    ok('bad args: optionless question errors', r2.success === false, JSON.stringify(r2))
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

void run()
