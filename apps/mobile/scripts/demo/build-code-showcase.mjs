#!/usr/bin/env node
/**
 * Build the code-activity conversation into demo/.
 *
 * Two things the clean feed always shows, whatever the verbose preference
 * says, are exercised here in every state they have:
 *
 *  - the COMPACT ROW a code tool earns (ToolCard compact — desktop
 *    CODE_ACTIVITY_TOOLS): an edit with its +N −M that opens to the red/green
 *    diff, a shell run with its exit code and elapsed time, a failed run (red
 *    pill, exit 1, the error block), a multi-line command (first line on the
 *    row, whole command when opened), a long run ("1m 12s"), a truncated
 *    output with its spill file, an append with a diff of its own;
 *  - the TASK LIST card (TodoCard): one checklist per turn at the position of
 *    its first write, replaced in place by every later write, so the card
 *    shows the turn's latest state — all done in the first turn, parked
 *    mid-way in the second, where the agent stops to ask.
 *
 * Every fact on those rows rides the tool_result's `meta` (desktop
 * ToolResultMeta): the diffs are produced by the desktop's own unified-diff
 * module (vendored under scripts/demo/vendor) from authored before/after
 * texts, the shell labels are the ones the desktop's describeCommand gives
 * these exact commands (checked once against tokenize.mjs), and the output
 * strings follow the filesystem and shell plugins' formats. The transcript
 * also carries the todo_write tool_call/tool_result pairs the desktop
 * persists next to each `todo` segment — hidden on the clean feed, chips on
 * the verbose one.
 *
 *   node scripts/demo/build-code-showcase.mjs   # writes into demo/
 *   node scripts/demo/build-demo-bundle.mjs     # pack for the CDN
 *
 * Timestamps anchor off conv-file-showcase so the showcases keep a fixed
 * order at the top of the list (this one sits above the voice showcase);
 * re-run this whenever that one is regenerated.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { countChanges, createUnifiedDiff } from './vendor/unified-diff.mjs'

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const DEMO = process.env.DEMO_OUT ?? path.join(ROOT, 'demo')
const CONV_ID = 'code-showcase'
/** Hours above the file showcase — the voice showcase sits at +48. */
const ANCHOR_OFFSET_H = 60

const MODEL = 'claude-opus-4-8'
const PROJECT = '/Users/younes/dev/wolffish'
const SPILL = '/Users/younes/.wolffish/workspace/tool-output/shell-2026-08-08T06-31-52-114Z.txt'

// ---------------------------------------------------------------------------
// The files the turn touches, as authored before/after texts. Diffs, counts,
// line numbers in the jest output and the "changed region" snippets are all
// computed from these, so the transcript never contradicts itself.
// ---------------------------------------------------------------------------

const PACER_BEFORE = `import type { StreamDelta } from './types'

/**
 * Paces a burst of stream deltas into frames: everything that lands within
 * one window is flushed together, and a trailing timer catches the last
 * delta of a burst so nothing waits for the next one.
 */
export class Pacer {
  private pending: StreamDelta[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private deadline = 0

  constructor(
    private readonly windowMs: number,
    private readonly flush: (deltas: StreamDelta[]) => void
  ) {}

  push(delta: StreamDelta): void {
    this.pending.push(delta)
    if (this.timer) return
    this.deadline = Date.now() + this.windowMs
    this.timer = setTimeout(() => this.fire(), this.windowMs)
  }

  private fire(): void {
    this.timer = null
    // A timer that fires late has missed its frame; the next push re-arms.
    if (Date.now() > this.deadline + this.windowMs) return
    const batch = this.pending
    this.pending = []
    this.flush(batch)
  }
}
`

const PACER_AFTER = PACER_BEFORE.replace(
  `    private readonly flush: (deltas: StreamDelta[]) => void
  ) {}`,
  `    private readonly flush: (deltas: StreamDelta[]) => void,
    /** The clock the deadline is read from — tests hand in the fake timer's. */
    private readonly now: () => number = Date.now
  ) {}`
).replaceAll('Date.now() ', 'this.now() ')

const TEST_BEFORE = `import { Pacer } from '../pacer'

describe('Pacer', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('flushes a burst as one frame', () => {
    const flush = jest.fn()
    const pacer = new Pacer(48, flush)
    pacer.push({ seq: 1, text: 'a' })
    pacer.push({ seq: 2, text: 'b' })
    jest.advanceTimersByTime(48)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledWith([
      { seq: 1, text: 'a' },
      { seq: 2, text: 'b' }
    ])
  })

  it('flushes the trailing delta after 48ms', () => {
    const flush = jest.fn()
    const pacer = new Pacer(48, flush)
    pacer.push({ seq: 1, text: 'a' })
    jest.advanceTimersByTime(48)
    pacer.push({ seq: 2, text: 'b' })
    jest.advanceTimersByTime(48)
    expect(flush).toHaveBeenLastCalledWith([{ seq: 2, text: 'b' }])
  })
})
`

// The first attempt passes the fake clock's VALUE, not the clock — the run
// that follows fails on it, and the second edit is the correction.
const TEST_WRONG = TEST_BEFORE.replaceAll(
  'new Pacer(48, flush)',
  'new Pacer(48, flush, jest.now())'
)
const TEST_AFTER = TEST_WRONG.replaceAll('jest.now())', '() => jest.now())')

const CHANGELOG_BEFORE = `# Changelog

## Unreleased

- Composer: the attachment tray keeps its order across a reconnect.
- History: conversations filed under a deleted project fall back to Inbox.

## 1.0.18

- Release branch cut; media tests run again with FFmpeg 7.1.1.
`
const CHANGELOG_APPEND =
  '- Stream pacer: the trailing flush read the wall clock under fake timers and skipped\n' +
  '  frames on slow CI runners; the clock is injected now (#412).\n'

// ---------------------------------------------------------------------------
// Desktop output formats, ported so the transcript reads as the real thing.
// ---------------------------------------------------------------------------

/** filesystem plugin changedRegionSnippet: the edited region as it now stands. */
function changedRegionSnippet(before, after, maxLines = 40) {
  const b = before.split('\n')
  const a = after.split('\n')
  let first = 0
  while (first < a.length && first < b.length && a[first] === b[first]) first++
  let tailA = a.length - 1
  let tailB = b.length - 1
  while (tailA > first && tailB > first && a[tailA] === b[tailB]) {
    tailA--
    tailB--
  }
  const start = Math.max(0, first - 3)
  const end = Math.min(a.length - 1, Math.max(tailA, first) + 3)
  const rows = []
  for (let i = start; i <= end && rows.length < maxLines; i++) rows.push(`${i + 1}: ${a[i]}`)
  const more = end - start + 1 - rows.length
  if (more > 0) rows.push(`… (${more} more changed lines not shown)`)
  return rows.join('\n')
}

/** The relative path the desktop puts in the `--- a/` header (inside the working folder). */
function shown(absolute) {
  return absolute.startsWith(`${PROJECT}/`) ? absolute.slice(PROJECT.length + 1) : absolute
}

/** A file_edit result: the tool's output line plus the meta the row renders. */
function editResult(absolute, before, after, { replaceAll = false, occurrences = 1 } = {}) {
  const patch = createUnifiedDiff(shown(absolute), before, after)
  const { additions, deletions } = countChanges(before, after)
  return {
    output:
      `Edit applied to ${absolute} (+${additions} −${deletions}` +
      `${replaceAll ? `, ${occurrences} occurrences` : ''}).\n` +
      `Changed region as it now stands:\n${changedRegionSnippet(before, after)}`,
    meta: {
      diff: { file: absolute, patch, additions, deletions, kind: 'edit' },
      label: 'Edit'
    }
  }
}

/** A file_write mode=append result. */
function appendResult(absolute, before, appended) {
  const after = before + appended
  const patch = createUnifiedDiff(shown(absolute), before, after)
  const { additions, deletions } = countChanges(before, after)
  return {
    output: `Appended ${Buffer.byteLength(appended, 'utf8')} bytes to ${absolute}`,
    meta: {
      diff: { file: absolute, patch, additions, deletions, kind: 'overwrite' },
      label: 'Append'
    }
  }
}

/** 1-based line of the first line containing `needle`. */
function lineOf(text, needle) {
  const index = text.split('\n').findIndex((line) => line.includes(needle))
  if (index < 0) throw new Error(`no line contains ${needle}`)
  return index + 1
}

/** A shell_exec result: output + the meta every run carries (shell plugin finalize). */
function shellResult({ label, output, exitCode, durationMs, cwd = PROJECT, outputPath }) {
  const meta = { label, cwd, durationMs, exitCode, truncated: !!outputPath }
  if (outputPath) meta.outputPath = outputPath
  return { output, meta }
}

/** todo_write's own success output — the list echoed back with its tally. */
function todoOutput(items) {
  const inProgress = items.filter((t) => t.status === 'in_progress').length
  const done = items.filter((t) => t.status === 'completed').length
  return `${items.length} todos (${done} completed, ${inProgress} in progress)\n${JSON.stringify(items, null, 2)}`
}

/** The pretty jest failure the wrong edit produces; line numbers from the real text. */
function jestFailure() {
  const line = lineOf(PACER_AFTER, 'this.deadline = this.now()')
  const lines = PACER_AFTER.split('\n')
  const at = (n) => `${String(n).padStart(6)} | ${lines[n - 1]}`
  return (
    'FAIL src/lib/stream/__tests__/pacer.test.ts\n' +
    '  Pacer\n' +
    '    ✕ flushes a burst as one frame (4 ms)\n' +
    '    ✕ flushes the trailing delta after 48ms (1 ms)\n' +
    '\n' +
    '  ● Pacer › flushes a burst as one frame\n' +
    '\n' +
    '    TypeError: this.now is not a function\n' +
    '\n' +
    `${at(line - 2)}\n${at(line - 1)}\n` +
    `    > ${String(line).padStart(2)} | ${lines[line - 1]}\n` +
    '         |                          ^\n' +
    `${at(line + 1)}\n` +
    '\n' +
    `      at Pacer.push (src/lib/stream/pacer.ts:${line}:26)\n` +
    `      at Object.<anonymous> (src/lib/stream/__tests__/pacer.test.ts:${lineOf(TEST_WRONG, 'pacer.push({ seq: 1')}:11)\n` +
    '\n' +
    'Test Suites: 1 failed, 1 passed, 2 total\n' +
    'Tests:       2 failed, 8 passed, 10 total\n' +
    'Snapshots:   0 total\n' +
    'Time:        6.204 s'
  )
}

// ---------------------------------------------------------------------------
// The two turns, as an ordered script of steps.
// ---------------------------------------------------------------------------

const PACER = `${PROJECT}/src/lib/stream/pacer.ts`
const PACER_TEST = `${PROJECT}/src/lib/stream/__tests__/pacer.test.ts`
const CHANGELOG = `${PROJECT}/CHANGELOG.md`

const T1_ITEMS = [
  'Reproduce the flake locally',
  'Find the race in the pacer',
  'Fix it and cover it with a test',
  'Run the full suite'
]

/** The task list after `done` items, with the next one in progress. */
function todo(labels, done, { priority } = {}) {
  return labels.map((content, index) => ({
    content,
    status: index < done ? 'completed' : index === done ? 'in_progress' : 'pending',
    ...(priority && index === priority ? { priority: 'high' } : {})
  }))
}

const REPRO_COMMAND =
  'for i in $(seq 1 20); do\n' +
  '  npx jest src/lib/stream/__tests__/pacer.test.ts --silent 2>&1 | tail -1\n' +
  'done | sort | uniq -c'

const TURN_1 = [
  { todo: todo(T1_ITEMS, 0, { priority: 3 }) },
  { text: 'Reproducing first — a flake that only shows on CI is almost always timing.\n' },
  {
    tool: 'shell_exec',
    args: { command: REPRO_COMMAND, cwd: PROJECT },
    ...shellResult({
      label: 'Run tests',
      exitCode: 0,
      durationMs: 48_300,
      output:
        '     16 Tests:       9 passed, 9 total\n' +
        '      4 Tests:       1 failed, 8 passed, 9 total'
    })
  },
  { todo: todo(T1_ITEMS, 1, { priority: 3 }) },
  {
    text:
      '4 runs in 20, same test every time: `flushes the trailing delta after 48ms`. ' +
      'Reading the pacer.\n'
  },
  {
    tool: 'file_read',
    args: { path: shown(PACER) },
    output: PACER_BEFORE.split('\n')
      .slice(0, -1)
      .map((line, i) => `${i + 1}: ${line}`)
      .join('\n'),
    meta: { label: 'Read' }
  },
  {
    tool: 'file_grep',
    args: { pattern: 'Date\\.now', path: 'src/lib/stream' },
    output:
      `${PACER}:${lineOf(PACER_BEFORE, 'this.deadline = Date.now()')}:    this.deadline = Date.now() + this.windowMs\n` +
      `${PACER}:${lineOf(PACER_BEFORE, 'if (Date.now() >')}:    if (Date.now() > this.deadline + this.windowMs) return`,
    meta: { label: 'Search', cwd: `${PROJECT}/src/lib/stream`, truncated: false }
  },
  {
    text:
      'Found it. `Pacer` reads `Date.now()` when it arms the trailing flush and again when the ' +
      'timer fires, but the test drives time with fake timers — so on a slow runner the wall ' +
      'clock has already moved past the deadline by the time the timer fires, and the flush is ' +
      'skipped as stale.\n\nFix: hand the pacer its clock, defaulting to `Date.now`, and let the ' +
      "test pass the fake timer's.\n"
  },
  { todo: todo(T1_ITEMS, 2, { priority: 3 }) },
  {
    tool: 'file_edit',
    args: {
      path: shown(PACER),
      old: '    private readonly flush: (deltas: StreamDelta[]) => void\n  ) {}',
      new:
        '    private readonly flush: (deltas: StreamDelta[]) => void,\n' +
        "    /** The clock the deadline is read from — tests hand in the fake timer's. */\n" +
        '    private readonly now: () => number = Date.now\n  ) {}'
    },
    ...editResult(
      PACER,
      PACER_BEFORE,
      PACER_BEFORE.replace(
        '    private readonly flush: (deltas: StreamDelta[]) => void\n  ) {}',
        '    private readonly flush: (deltas: StreamDelta[]) => void,\n' +
          "    /** The clock the deadline is read from — tests hand in the fake timer's. */\n" +
          '    private readonly now: () => number = Date.now\n  ) {}'
      )
    )
  },
  {
    tool: 'file_edit',
    args: { path: shown(PACER), old: 'Date.now() ', new: 'this.now() ', replaceAll: true },
    ...editResult(
      PACER,
      PACER_BEFORE.replace(
        '    private readonly flush: (deltas: StreamDelta[]) => void\n  ) {}',
        '    private readonly flush: (deltas: StreamDelta[]) => void,\n' +
          "    /** The clock the deadline is read from — tests hand in the fake timer's. */\n" +
          '    private readonly now: () => number = Date.now\n  ) {}'
      ),
      PACER_AFTER,
      { replaceAll: true, occurrences: 2 }
    )
  },
  {
    tool: 'file_edit',
    args: {
      path: shown(PACER_TEST),
      old: 'new Pacer(48, flush)',
      new: 'new Pacer(48, flush, jest.now())',
      replaceAll: true
    },
    ...editResult(PACER_TEST, TEST_BEFORE, TEST_WRONG, { replaceAll: true, occurrences: 2 })
  },
  {
    tool: 'shell_exec',
    args: { command: 'npx jest src/lib/stream --silent', cwd: PROJECT },
    status: 'failed',
    ...shellResult({
      label: 'Run tests',
      exitCode: 1,
      durationMs: 6_800,
      output:
        'Command exited with code 1: 2 tests failed in pacer.test.ts — ' +
        'TypeError: this.now is not a function'
    }),
    error: jestFailure()
  },
  {
    text:
      'My mistake — `jest.now()` is the clock’s *value*; the pacer wants the clock. ' +
      'Wrapping it.\n'
  },
  {
    tool: 'file_edit',
    args: {
      path: shown(PACER_TEST),
      old: 'jest.now())',
      new: '() => jest.now())',
      replaceAll: true
    },
    ...editResult(PACER_TEST, TEST_WRONG, TEST_AFTER, { replaceAll: true, occurrences: 2 })
  },
  {
    tool: 'shell_exec',
    args: { command: 'npx jest src/lib/stream --silent', cwd: PROJECT },
    ...shellResult({
      label: 'Run tests',
      exitCode: 0,
      durationMs: 7_100,
      output:
        'Test Suites: 2 passed, 2 total\n' +
        'Tests:       10 passed, 10 total\n' +
        'Snapshots:   0 total\n' +
        'Time:        6.412 s'
    })
  },
  { todo: todo(T1_ITEMS, 3, { priority: 3 }) },
  {
    text: 'Green, twenty runs out of twenty this time. Now the whole suite and the type check.\n'
  },
  {
    tool: 'shell_exec',
    args: { command: 'npm test -- --silent 2>&1', cwd: PROJECT },
    ...shellResult({
      label: 'Run tests',
      exitCode: 0,
      durationMs: 72_400,
      outputPath: SPILL,
      output:
        '...output truncated...\n\n' +
        `Full output saved to: ${SPILL}\n` +
        'Use file_grep to search it or file_read with startLine/endLine to view specific sections.\n\n' +
        'PASS src/lib/sync/__tests__/overlays.test.ts\n' +
        'PASS src/lib/conversations/__tests__/segments.test.ts\n' +
        'PASS src/components/chat/__tests__/Composer.test.tsx\n' +
        'PASS src/lib/stream/__tests__/pacer.test.ts\n\n' +
        'Test Suites: 63 passed, 63 total\n' +
        'Tests:       641 passed, 641 total\n' +
        'Snapshots:   0 total\n' +
        'Time:        71.88 s'
    })
  },
  {
    tool: 'shell_exec',
    args: { command: 'npx tsc --noEmit', cwd: PROJECT },
    ...shellResult({ label: 'Type-check', exitCode: 0, durationMs: 21_600, output: '(no output)' })
  },
  { todo: todo(T1_ITEMS, 4, { priority: 3 }) },
  {
    text:
      'Fixed.\n\n' +
      '- **Cause** — `Pacer` compared a fake-timer deadline against the real wall clock. ' +
      'On a busy CI runner the two drift past the 48 ms window and the trailing flush is ' +
      'dropped as stale. Locally it reproduced 4 times in 20.\n' +
      '- **Fix** — the clock is a constructor argument now (`now: () => number`, default ' +
      "`Date.now`), and the test hands in the fake timer's. Two lines in the pacer, two in " +
      'the test.\n' +
      '- **Verified** — the pacer test 20/20, the full suite (641 tests) and `tsc` all pass.\n\n' +
      'One thing I did not do: touch the other timer in `src/lib/stream/reveal.ts`. It reads ' +
      '`Date.now()` the same way but its test does not use fake timers, so it cannot flake ' +
      'for this reason — worth the same treatment when you are next in there.'
  }
]

const T2_ITEMS = ['Add the changelog entry', 'Commit the fix', 'Push the branch']

const TURN_2 = [
  { todo: todo(T2_ITEMS, 0) },
  {
    tool: 'file_write',
    args: { path: shown(CHANGELOG), content: CHANGELOG_APPEND, mode: 'append' },
    ...appendResult(CHANGELOG, CHANGELOG_BEFORE, CHANGELOG_APPEND)
  },
  { todo: todo(T2_ITEMS, 1) },
  {
    tool: 'shell_exec',
    args: { command: 'git status --short', cwd: PROJECT },
    ...shellResult({
      label: 'Check git status',
      exitCode: 0,
      durationMs: 180,
      output:
        ' M CHANGELOG.md\n' +
        ' M README.md\n' +
        ' M src/lib/stream/__tests__/pacer.test.ts\n' +
        ' M src/lib/stream/pacer.ts'
    })
  },
  {
    text:
      'Changelog entry is in. Before I commit: `README.md` is modified too, and that is not ' +
      'mine — it was already dirty when I started. Commit it together with the fix, or leave ' +
      'it out?'
  }
]

// ---------------------------------------------------------------------------
// Assemble: segments, timings, stats. Deterministic — no clock reads.
// ---------------------------------------------------------------------------

function buildTurn(turnId, steps, startAt, ids) {
  const segments = []
  const toolTimings = {}
  let cursor = startAt
  let calls = 0
  const seg = () => `s${ids.segment++}`

  segments.push({
    kind: 'active_model',
    turnId,
    segmentId: seg(),
    provider: 'anthropic',
    model: MODEL
  })

  for (const step of steps) {
    if (step.text !== undefined) {
      // A few seconds of generation per reply.
      segments.push({ kind: 'text', turnId, segmentId: seg(), delta: step.text })
      cursor += 2_400 + step.text.length * 12
      continue
    }
    if (step.todo) {
      const toolCallId = `call_cs_${ids.call++}`
      segments.push({
        kind: 'tool_call',
        turnId,
        segmentId: seg(),
        toolCallId,
        name: 'todo_write',
        args: { todos: step.todo }
      })
      segments.push({
        kind: 'tool_result',
        turnId,
        segmentId: seg(),
        toolCallId,
        status: 'success',
        output: todoOutput(step.todo)
      })
      segments.push({ kind: 'todo', turnId, segmentId: seg(), items: step.todo })
      toolTimings[toolCallId] = { startedAt: cursor, endedAt: cursor + 40 }
      cursor += 1_900
      calls++
      continue
    }
    const toolCallId = `call_cs_${ids.call++}`
    segments.push({
      kind: 'tool_call',
      turnId,
      segmentId: seg(),
      toolCallId,
      name: step.tool,
      args: step.args
    })
    const durationMs = step.meta?.durationMs ?? 140 + ((ids.call * 7919) % 460)
    segments.push({
      kind: 'tool_result',
      turnId,
      segmentId: seg(),
      toolCallId,
      status: step.status ?? 'success',
      output: step.output,
      ...(step.error ? { error: step.error } : {}),
      ...(step.meta ? { meta: step.meta } : {})
    })
    toolTimings[toolCallId] = { startedAt: cursor, endedAt: cursor + durationMs }
    cursor += durationMs + 3_100
    calls++
    // The model chip returns after every tool round, as the desktop emits it.
    segments.push({
      kind: 'active_model',
      turnId,
      segmentId: seg(),
      provider: 'anthropic',
      model: MODEL
    })
  }
  segments.push({
    kind: 'turn_end',
    turnId,
    segmentId: seg(),
    stopReason: 'end_turn',
    iterationCount: calls + 1
  })
  return { segments, toolTimings, endedAt: cursor, calls }
}

async function main() {
  await fs.mkdir(path.join(DEMO, 'conversations'), { recursive: true })

  const showcaseRaw = await fs.readFile(
    path.join(DEMO, 'conversations', 'conv-file-showcase.json'),
    'utf8'
  )
  const anchor = JSON.parse(showcaseRaw).updatedAt
  if (typeof anchor !== 'number') throw new Error('conv-file-showcase.json has no updatedAt')

  const ids = { segment: 0, call: 0 }
  const createdAt = anchor + ANCHOR_OFFSET_H * 3600_000
  const turn1 = buildTurn('t1', TURN_1, createdAt + 1_500, ids)
  const turn2At = turn1.endedAt + 140_000
  const turn2 = buildTurn('t2', TURN_2, turn2At + 1_200, ids)
  const updatedAt = turn2.endedAt

  const conversation = {
    id: CONV_ID,
    title: 'Fix the flaky pacer test',
    model: MODEL,
    channel: 'electron',
    createdAt,
    updatedAt,
    messages: [
      {
        id: 'm_code_user_1',
        role: 'user',
        content:
          'CI keeps failing on the pacer test, roughly one run in five. Find out why and fix ' +
          'it properly — run the suite before you hand it back.',
        timestamp: createdAt
      },
      {
        id: 'm_code_assistant_1',
        role: 'assistant',
        content: '',
        timestamp: createdAt,
        segments: turn1.segments,
        toolTimings: turn1.toolTimings,
        stopReason: 'end_turn'
      },
      {
        id: 'm_code_user_2',
        role: 'user',
        content: 'Nice. Add a changelog line and push it.',
        timestamp: turn2At
      },
      {
        id: 'm_code_assistant_2',
        role: 'assistant',
        content: '',
        timestamp: turn2At,
        segments: turn2.segments,
        toolTimings: turn2.toolTimings,
        stopReason: 'end_turn'
      }
    ],
    stats: {
      allTime: {
        turns: 2,
        toolCalls: turn1.calls + turn2.calls,
        apiCalls: turn1.calls + turn2.calls + 2,
        inputTokens: 61_240,
        outputTokens: 4_118,
        cacheReadTokens: 188_920,
        cacheCreationTokens: 9_412,
        cost: 0.2874,
        provider: 'anthropic',
        model: MODEL,
        elapsedMs: updatedAt - createdAt,
        endedAt: updatedAt
      },
      lastTurn: {
        endedAt: updatedAt,
        elapsedMs: updatedAt - turn2At,
        apiCalls: turn2.calls + 1,
        toolCalls: turn2.calls,
        inputTokens: 9_860,
        outputTokens: 402,
        cacheReadTokens: 41_120,
        cacheCreationTokens: 0,
        cost: 0.0312,
        provider: 'anthropic',
        model: MODEL
      },
      meter: { contextTokens: 52_318, contextBudget: 200_000, model: MODEL }
    },
    ratings: [{ messageId: 'm_code_assistant_1', score: 10, at: turn2At - 30_000, source: 'inapp' }]
  }

  await fs.writeFile(
    path.join(DEMO, 'conversations', `conv-${CONV_ID}.json`),
    JSON.stringify(conversation)
  )

  const edits = [...TURN_1, ...TURN_2].filter((s) => s.meta?.diff).length
  const runs = [...TURN_1, ...TURN_2].filter((s) => s.tool === 'shell_exec').length
  const lists = [...TURN_1, ...TURN_2].filter((s) => s.todo).length
  console.log(`code activity: ${edits} diffs, ${runs} shell runs, ${lists} task-list writes`)
  console.log(`sorts above voice showcase: updatedAt ${new Date(updatedAt).toISOString()}`)
  console.log(`conversation: demo/conversations/conv-${CONV_ID}.json`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
