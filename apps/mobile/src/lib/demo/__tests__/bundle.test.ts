// Node types for this file only. The app's tsconfig deliberately limits
// `types` to jest — pulling Node's globals in project-wide would type
// `process`, `Buffer` and friends in a React Native app that does not have
// them. This test genuinely reads files off disk, so it asks for them here.
/// <reference types="node" />

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

import { parseAutomations, parseSchedule } from '@/lib/automations/heartbeat'
import { parseUnifiedDiff } from '@/components/chat/DiffView'
import { CODE_ACTIVITY_TOOLS, buildRenderBlocks } from '@/lib/conversations/segments'
import type { ConversationFile, Segment } from '@/lib/conversations/types'
import { sampleExtFor } from '@/lib/files/sampleFiles'
import {
  USAGE_TIME_RANGES,
  computeUsageStats,
  computeUsageSummary,
  rangeCutoff
} from '@/lib/usage/stats'
import { parseAnswers, parseQuestionsFromArgs } from '@/components/chat/QuestionCard'
import { CUSTOMIZATION_MAX_BYTES, utf8Bytes, type ConfigSnapshot } from '@/state/demoConfig'
import type { DemoNotification } from '@/lib/demo/importer'
import { NOTIFY_PHASES, NOTIFY_TITLE_MAX, parseDeeplink } from '@/lib/tunnel/protocol'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

/**
 * The committed demo dataset, checked against the contracts that render it.
 *
 * demo/ is hand-maintained content, not generated output, so nothing else stops
 * a section from drifting out of the shape its screen reads — a heading the
 * scheduler's grammar rejects, a procedure bound to a project that was deleted,
 * a customization document past the wire ceiling. Every one of those fails
 * silently on a device: the screen renders, just empty or short, which is
 * exactly the failure demo mode exists to prevent.
 *
 * Deliberately reads the file from disk rather than importing a fixture — the
 * bytes under test are the bytes the bundle publishes.
 */

const DEMO_DIR = path.join(__dirname, '../../../../demo')

const snapshot = JSON.parse(
  readFileSync(path.join(DEMO_DIR, 'config-snapshot.json'), 'utf8')
) as ConfigSnapshot

function showcase(name: string): ConversationFile {
  return JSON.parse(
    readFileSync(path.join(DEMO_DIR, 'conversations', `conv-${name}.json`), 'utf8')
  ) as ConversationFile
}

function everyConversation(): Array<{ file: string; conversation: ConversationFile }> {
  const dir = path.join(DEMO_DIR, 'conversations')
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({
      file,
      conversation: JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as ConversationFile
    }))
}

describe('demo config snapshot', () => {
  const projectIds = new Set((snapshot.projects ?? []).map((project) => project.id))

  it('carries every workspace section the new screens read', () => {
    expect(snapshot.projects?.length).toBeGreaterThan(0)
    expect(snapshot.procedures?.length).toBeGreaterThan(0)
    expect(snapshot.automations?.markdown).toBeTruthy()
    expect(snapshot.customization?.soul).toBeTruthy()
    expect(snapshot.customization?.user).toBeTruthy()
    expect(snapshot.customization?.agents).toBeTruthy()
  })

  describe('customization', () => {
    it('fits the wire ceiling every document is saved under', () => {
      for (const doc of ['soul', 'user', 'agents'] as const) {
        expect(utf8Bytes(snapshot.customization?.[doc] ?? '')).toBeLessThanOrEqual(
          CUSTOMIZATION_MAX_BYTES
        )
      }
    })

    it('declares nothing oversized — the bundle sends all three whole', () => {
      expect(snapshot.customization?.oversized ?? []).toEqual([])
    })
  })

  describe('procedures', () => {
    it('are complete rows, uniquely identified', () => {
      const ids = new Set<string>()
      for (const procedure of snapshot.procedures ?? []) {
        expect(procedure.id).toBeTruthy()
        expect(procedure.title.trim()).toBeTruthy()
        expect(procedure.prompt.trim()).toBeTruthy()
        expect(procedure.icon).toBeTruthy()
        expect([null, 'single', 'workflow']).toContain(procedure.mode)
        expect(procedure.updatedAt).toBeGreaterThanOrEqual(procedure.createdAt)
        expect(ids.has(procedure.id)).toBe(false)
        ids.add(procedure.id)
      }
    })

    it('bind only to projects the snapshot still carries', () => {
      for (const procedure of snapshot.procedures ?? []) {
        if (procedure.projectId) expect(projectIds.has(procedure.projectId)).toBe(true)
      }
    })

    it('cover both run modes and both binding states', () => {
      const rows = snapshot.procedures ?? []
      expect(rows.some((row) => row.mode === 'single')).toBe(true)
      expect(rows.some((row) => row.mode === 'workflow')).toBe(true)
      expect(rows.some((row) => row.projectId)).toBe(true)
      expect(rows.some((row) => !row.projectId)).toBe(true)
    })
  })

  describe('heartbeat', () => {
    const blocks = parseAutomations(snapshot.automations?.markdown ?? '')

    it('parses into automations the scheduler would accept', () => {
      expect(blocks.length).toBeGreaterThanOrEqual(6)
      for (const block of blocks) {
        expect(parseSchedule(block.label)).not.toBeNull()
        expect(block.body.trim()).toBeTruthy()
      }
    })

    it('shows both switch states', () => {
      expect(blocks.some((block) => block.active)).toBe(true)
      expect(blocks.some((block) => !block.active)).toBe(true)
    })

    it('gives every active cron-driven block a computable next fire', () => {
      // `null` here is what puts a card on the bare "Active" line instead of a
      // schedule — the demo must never ship one, since the phone resolves the
      // moment from this cron when no desktop is running.
      for (const block of blocks) {
        if (!block.active || block.type === 'startup') continue
        expect(block.cron).toBeTruthy()
      }
    })

    it('binds only to projects the snapshot still carries', () => {
      for (const block of blocks) {
        if (block.project) expect(projectIds.has(block.project)).toBe(true)
      }
    })

    it('stamps only labels the file actually contains', () => {
      const labels = new Set(blocks.map((block) => block.label))
      for (const label of Object.keys(snapshot.automations?.stamps ?? {})) {
        expect(labels.has(label)).toBe(true)
      }
    })

    it('claims no run in flight — there is no desktop behind a bundle', () => {
      expect(snapshot.automations?.jobs ?? []).toEqual([])
    })
  })
})

describe('approval showcase', () => {
  const conversation = showcase('approval-showcase')
  const assistant = conversation.messages.find((message) => message.role === 'assistant')!
  const blocks = buildRenderBlocks(assistant)

  it('anchors every persisted approval on a tool block that renders it', () => {
    // The card is drawn by the `tool` block whose toolCallId the approvals map
    // names. An approval with no matching call would fall through to the
    // orphan list, which only the LIVE row renders — so it would vanish.
    const toolCallIds = new Set(
      blocks.flatMap((block) => (block.type === 'tool' ? [block.call.toolCallId] : []))
    )
    const approvals = Object.values(assistant.approvals ?? {})
    expect(approvals.length).toBeGreaterThan(0)
    for (const approval of approvals) {
      expect(toolCallIds.has(approval.toolCallId)).toBe(true)
      expect(approval.description?.risk).toBeTruthy()
    }
  })

  it('shows both outcomes, each settled', () => {
    const decisions = Object.values(assistant.approvals ?? {}).map((approval) => approval.decision)
    expect(decisions).toContain('approved')
    expect(decisions).toContain('denied')
    // An undecided record renders Approve/Deny disabled — a dead control is
    // worse in a demo than no control, so the dataset ships none.
    expect(decisions.every((decision) => decision !== undefined)).toBe(true)
  })

  it('keys its approvals by the toolCallId they carry', () => {
    for (const [key, approval] of Object.entries(assistant.approvals ?? {})) {
      expect(key).toBe(approval.toolCallId)
    }
  })
})

describe('ask showcase', () => {
  const conversation = showcase('ask-showcase')
  const assistant = conversation.messages.find((message) => message.role === 'assistant')!
  const question = buildRenderBlocks(assistant).find((block) => block.type === 'question')

  it('renders as a question card with twenty questions', () => {
    expect(question).toBeDefined()
    if (question?.type !== 'question') throw new Error('unreachable')
    const parsed = parseQuestionsFromArgs(question.call.args, { label: '', description: '' })
    expect(parsed).toHaveLength(20)
    for (const item of parsed) {
      expect(item.question.trim()).toBeTruthy()
      expect(item.options.length).toBeGreaterThanOrEqual(2)
    }
    // Both shapes of the free-text escape hatch, since they draw differently.
    expect(parsed.some((item) => item.allowOther)).toBe(true)
    expect(parsed.some((item) => !item.allowOther)).toBe(true)
  })

  it('has an output the card can parse back into per-question answers', () => {
    if (question?.type !== 'question') throw new Error('unreachable')
    // The whole point: nothing about the answers is persisted beyond this
    // string, so a format drift here silently degrades the card to raw text.
    const answers = parseAnswers(question.result?.output, 20)
    expect(answers).not.toBeNull()
    expect(answers).toHaveLength(20)
    expect(answers!.some((answer) => answer.kind === 'custom')).toBe(true)
    for (const answer of answers!) {
      if (answer.kind !== 'option') continue
      expect(answer.index).toBeGreaterThanOrEqual(0)
    }
  })

  it('never points an answer past the options it was picked from', () => {
    if (question?.type !== 'question') throw new Error('unreachable')
    const parsed = parseQuestionsFromArgs(question.call.args, { label: '', description: '' })
    const answers = parseAnswers(question.result?.output, 20)!
    answers.forEach((answer, index) => {
      if (answer.kind !== 'option') return
      expect(answer.index).toBeLessThan(parsed[index].options.length)
    })
  })
})

describe('voice showcase', () => {
  const conversation = showcase('voice-showcase')

  it('is the dataset row that carries the phone badge', () => {
    expect(conversation.channel).toBe('mobile')
  })

  it('marks every user turn as a voice prompt with audio behind it', () => {
    const prompts = conversation.messages.filter((message) => message.role === 'user')
    expect(prompts.length).toBeGreaterThanOrEqual(4)
    for (const prompt of prompts) {
      // `voicePrompt` is what stops the bubble printing the transcript back
      // under the player; the transcript still has to BE there, because it is
      // what the model received and what titling reads.
      expect(prompt.voicePrompt).toBe(true)
      expect(prompt.content.trim()).toBeTruthy()
      expect(prompt.attachments?.[0]?.type).toBe('audio')
    }
    // Transcript language and app language are independent — both are shown.
    const langs = new Set(prompts.map((prompt) => prompt.voiceLang))
    expect(langs.has('en')).toBe(true)
    expect(langs.has('ar')).toBe(true)
  })

  it('renders spoken replies as audio cards', () => {
    const audio = conversation.messages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => buildRenderBlocks(message))
      .filter((block) => block.type === 'file' && block.kind === 'audio')
    expect(audio.length).toBeGreaterThan(0)
  })

  it('references only file types the CDN publishes a sample for', () => {
    const paths = conversation.messages.flatMap((message) => [
      ...(message.attachments ?? []).map((attachment) => attachment.filePath),
      ...buildRenderBlocks(message).flatMap((block) =>
        block.type === 'file' || block.type === 'media' ? [block.relPath] : []
      )
    ])
    expect(paths.length).toBeGreaterThan(0)
    for (const relPath of paths) expect(sampleExtFor(relPath)).not.toBeNull()
  })
})

describe('the dataset as a whole', () => {
  const dataset = everyConversation()
  const projectIds = new Set((snapshot.projects ?? []).map((project) => project.id))

  it('is the size the bundle expects', () => {
    expect(dataset.length).toBeGreaterThan(150)
  })

  it('names only channels the badge can draw', () => {
    // Kept in step with ChannelBadge's switch by hand; a glyph added there and
    // not here is a badge the dataset never proves it can draw.
    const known = new Set([
      'electron',
      'telegram',
      'whatsapp',
      'mobile',
      'cli',
      'heartbeat',
      'procedure'
    ])
    const seen = new Set<string>()
    for (const { conversation } of dataset) {
      if (!conversation.channel) continue
      expect(known.has(conversation.channel)).toBe(true)
      seen.add(conversation.channel)
    }
    // Every glyph ChannelBadge can draw has at least one row wearing it, so the
    // demo actually exercises the badge rather than merely permitting it (the
    // terminal one is the hand-written "Workspace disk breakdown" row).
    for (const channel of known) expect(`${channel}:${seen.has(channel)}`).toBe(`${channel}:true`)
  })

  it('binds conversations only to projects the snapshot still carries', () => {
    for (const { file, conversation } of dataset) {
      if (!conversation.projectId) continue
      expect(`${file}:${conversation.projectId}`).toBe(
        `${file}:${projectIds.has(conversation.projectId) ? conversation.projectId : 'MISSING'}`
      )
    }
  })
})

describe('usage ledger', () => {
  const days = snapshot.usage?.days ?? []
  const last = days[days.length - 1]?.date ?? ''

  /** Every month a viewer could open this in, from publication to the last row. */
  const viewingMonths = (): Date[] => {
    const out: Date[] = []
    const end = new Date(`${last}T12:00:00`)
    for (const d = new Date(2026, 7, 6); d <= end; d.setMonth(d.getMonth() + 1)) {
      out.push(new Date(d.getFullYear(), d.getMonth(), Math.min(d.getDate(), 28), 12))
    }
    return out
  }

  it('spans far enough back that every cutoff bites', () => {
    // rangeCutoff is a lower bound only, so ranges differ ONLY when the ledger
    // has rows on the far side of each one. These three windows are what make
    // all-time beat YTD, YTD beat 6 months, and 6 months beat 3 months.
    expect(days.some((day) => day.date < '2026-01-01')).toBe(true)
    expect(days.some((day) => day.date >= '2026-01-01' && day.date < '2026-02-01')).toBe(true)
    expect(days.some((day) => day.date >= '2026-02-01' && day.date < '2026-05-01')).toBe(true)
  })

  it('keeps the curated June/July rows', () => {
    // The folded real ledger the whole dataset is shaped to look like.
    // build-usage-ledger.mjs preserves this window; nothing may regenerate it.
    const curated = days.filter((day) => day.date >= '2026-06-01' && day.date <= '2026-07-31')
    expect(curated).toHaveLength(45)
  })

  it('runs a row a day for eighteen months past publication', () => {
    // `today` and `this_month` read the DEVICE clock, which keeps moving after
    // the bundle is published — and a month past the last row draws a blank
    // calendar, which reads as a dataset that died rather than one the clock
    // has not reached.
    const have = new Set(days.map((day) => day.date))
    const missing: string[] = []
    for (
      const date = new Date(2026, 7, 1);
      date <= new Date(2028, 1, 29);
      date.setDate(date.getDate() + 1)
    ) {
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      if (!have.has(key)) missing.push(key)
    }
    expect(missing).toEqual([])
  })

  it('leaves no month of the run empty', () => {
    const months = new Set(days.map((day) => day.date.slice(0, 7)))
    const missing: string[] = []
    for (
      const date = new Date(2025, 10, 1);
      date <= new Date(2028, 1, 1);
      date.setMonth(date.getMonth() + 1)
    ) {
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      if (!months.has(key)) missing.push(key)
    }
    expect(missing).toEqual([])
  })

  it('widens strictly, on every month it could be opened in', () => {
    // Compared BY CUTOFF, not by the order the pills sit in: `6_months` reaches
    // into the previous year, so from January to June it is WIDER than
    // year-to-date, and every July the two cutoffs are the same date and the
    // totals have to match exactly. Asserting pill order would demand a dataset
    // that lies about what the ranges mean.
    for (const now of viewingMonths()) {
      // Ascending cutoff = WIDEST first, so each total must be strictly
      // smaller than the one before it.
      const ordered = [...USAGE_TIME_RANGES].sort((a, b) =>
        rangeCutoff(a, now).localeCompare(rangeCutoff(b, now))
      )
      const label = now.toISOString().slice(0, 7)
      let previous: number | null = null
      let previousCut: string | null = null
      for (const range of ordered) {
        const cost = computeUsageStats(days, range, now).totalCost
        const cut = rangeCutoff(range, now)
        if (previous !== null) {
          const ok = cut === previousCut ? cost === previous : cost < previous
          expect(`${label} ${range} ok=${ok}`).toBe(`${label} ${range} ok=true`)
        }
        previous = cost
        previousCut = cut
      }
    }
  })

  it('lights up providers that are dark in the narrower ranges', () => {
    // Widening the range is not only more days: the Brain moved from Claude to
    // DeepSeek in the spring, so reaching back past it brings whole cards in.
    const now = new Date(2026, 11, 6, 12)
    const live = (range: (typeof USAGE_TIME_RANGES)[number]): number =>
      computeUsageSummary(days, range, now).providers.filter((p) => p.totalCost > 0).length
    expect(live('6_months')).toBeGreaterThan(live('3_months'))
  })

  it('spreads the top-spend day across the wide ranges', () => {
    // The deep-research anchors exist for this card: without them the curated
    // 23 July run is the priciest day in the whole ledger and every wide range
    // points at it.
    //
    // What is NOT claimed is four distinct days at every viewing month, and it
    // is worth saying why so nobody over-fits the anchors chasing it. A range's
    // top day is the biggest in its widest new shell, and one anchor sits in
    // several shells at once — three months on, the day that gave 6 months its
    // own answer has slid into the 3-month window. Guaranteeing four would take
    // an anchor per shell per month, each sized against its neighbours, growing
    // as you go back. Two claims hold instead, and they are the ones that carry
    // the card:
    for (const now of viewingMonths()) {
      const label = now.toISOString().slice(0, 7)
      const top = (range: (typeof USAGE_TIME_RANGES)[number]): string | undefined =>
        computeUsageStats(days, range, now).topSpendDay?.date
      // All time always names a day of its own — the 2025 anchor, which no
      // later range can reach.
      const others = ['3_months', '6_months', 'ytd'] as const
      expect(`${label}:${others.map(top).includes(top('all_time'))}`).toBe(`${label}:false`)
      // And no range ever comes back without one.
      const all = [...others, 'all_time'] as const
      expect(`${label}:${all.every((range) => !!top(range))}`).toBe(`${label}:true`)
    }
    // At publication — the months this bundle is actually demoed in — all four
    // differ, which is what the anchors were placed for.
    for (const month of [7, 8]) {
      const now = new Date(2026, month, 6, 12)
      const wide = ['3_months', '6_months', 'ytd', 'all_time'] as const
      const dates = wide.map((range) => computeUsageStats(days, range, now).topSpendDay?.date)
      expect(`${month}:${new Set(dates).size}`).toBe(`${month}:4`)
    }
  })

  it('never leaves the range a demo opens on empty', () => {
    for (const now of viewingMonths()) {
      const label = now.toISOString().slice(0, 7)
      expect(`${label}:${computeUsageStats(days, 'today', now).messages > 0}`).toBe(`${label}:true`)
      expect(`${label}:${computeUsageStats(days, 'this_month', now).messages > 0}`).toBe(
        `${label}:true`
      )
    }
  })
})

/**
 * The code-activity contract: a code tool's compact row draws its exit code,
 * elapsed time, label and +N −M from the tool_result's `meta`, and the task
 * list card draws from `todo` segments — so a result without meta is a row
 * with nothing on it, and a turn without a todo is a turn with no card.
 * Both fail silently on a device, which is what these guard against.
 */
type ToolResultSegment = Extract<Segment, { kind: 'tool_result' }>
type TodoSegment = Extract<Segment, { kind: 'todo' }>

/** Every rendered (non-worker) tool_result of a conversation, with its call. */
function toolResults(conversation: ConversationFile): Array<{
  call: Extract<Segment, { kind: 'tool_call' }>
  result: ToolResultSegment
}> {
  const out: Array<{
    call: Extract<Segment, { kind: 'tool_call' }>
    result: ToolResultSegment
  }> = []
  for (const message of conversation.messages) {
    const segments = (message.segments ?? []).filter(
      (segment) => !('worker' in segment && segment.worker)
    )
    const calls = new Map(
      segments
        .filter(
          (segment): segment is Extract<Segment, { kind: 'tool_call' }> =>
            segment.kind === 'tool_call'
        )
        .map((segment) => [segment.toolCallId, segment])
    )
    for (const segment of segments) {
      if (segment.kind !== 'tool_result') continue
      const call = calls.get(segment.toolCallId)
      if (call) out.push({ call, result: segment })
    }
  }
  return out
}

describe('code showcase', () => {
  const conversation = showcase('code-showcase')
  const results = toolResults(conversation)
  const blocks = conversation.messages
    .filter((message) => message.role === 'assistant')
    .map((message) => buildRenderBlocks(message))

  it('sits above every other showcase', () => {
    for (const { file, conversation: other } of everyConversation()) {
      if (other.id === conversation.id) continue
      expect(`${file}:${other.updatedAt < conversation.updatedAt}`).toBe(`${file}:true`)
    }
  })

  it('shows one task list per turn — finished in the first, parked in the second', () => {
    const lists = blocks.map((turn) => turn.filter((block) => block.type === 'todo'))
    expect(lists.map((list) => list.length)).toEqual([1, 1])
    const [first, second] = lists.map((list) => list[0])
    if (first.type !== 'todo' || second.type !== 'todo') throw new Error('not todo blocks')
    expect(first.items.every((item) => item.status === 'completed')).toBe(true)
    expect(second.items.map((item) => item.status)).toEqual(['completed', 'in_progress', 'pending'])
  })

  it('carries every edit as a diff the row can open', () => {
    const edits = results.filter(({ call }) => /^file_(edit|write)$/.test(call.name))
    expect(edits.length).toBeGreaterThanOrEqual(5)
    for (const { result } of edits) {
      const diff = result.meta?.diff
      expect(diff?.patch.startsWith('--- a/')).toBe(true)
      const lines = parseUnifiedDiff(diff!.patch)
      expect(lines.filter((line) => line.kind === 'add').length).toBe(diff!.additions)
      expect(lines.filter((line) => line.kind === 'del').length).toBe(diff!.deletions)
    }
    expect(new Set(edits.map(({ result }) => result.meta?.label))).toEqual(
      new Set(['Edit', 'Append'])
    )
  })

  it('shows a run in every state the row has', () => {
    const runs = results.filter(({ call }) => call.name === 'shell_exec')
    const codes = runs.map(({ result }) => result.meta?.exitCode)
    expect(codes).toContain(0)
    expect(codes).toContain(1)
    const failed = runs.find(({ result }) => result.status === 'failed')
    expect(failed?.result.error).toContain('TypeError')
    expect(runs.some(({ result }) => (result.meta?.durationMs ?? 0) > 60_000)).toBe(true)
    expect(runs.some(({ result }) => result.meta?.truncated && result.meta.outputPath)).toBe(true)
    expect(runs.some(({ call }) => String(call.args.command).includes('\n'))).toBe(true)
    for (const { result } of runs) {
      expect(typeof result.meta?.label).toBe('string')
      expect(typeof result.meta?.durationMs).toBe('number')
    }
  })

  it('keeps the todo_write chips the desktop persists next to each card', () => {
    const writes = results.filter(({ call }) => call.name === 'todo_write')
    const cards = conversation.messages.flatMap((message) =>
      (message.segments ?? []).filter((segment): segment is TodoSegment => segment.kind === 'todo')
    )
    expect(writes.length).toBe(cards.length)
    expect(writes.length).toBe(7)
  })
})

describe('code activity across the dataset', () => {
  const dataset = everyConversation()

  it('gives every shell run the meta its compact row is drawn from', () => {
    let runs = 0
    for (const { file, conversation } of dataset) {
      for (const { call, result } of toolResults(conversation)) {
        if (call.name !== 'shell_exec') continue
        runs++
        const meta = result.meta
        const shape = `${typeof meta?.label}/${typeof meta?.durationMs}/${typeof meta?.exitCode}`
        expect(`${file}:${call.toolCallId}:${shape}`).toBe(
          `${file}:${call.toolCallId}:string/number/${meta?.exitCode === null ? 'object' : 'number'}`
        )
        if (result.status === 'success')
          expect(meta?.exitCode === 0 || meta?.exitCode === 1).toBe(true)
        if (meta?.truncated) expect(typeof meta.outputPath).toBe('string')
      }
    }
    expect(runs).toBeGreaterThan(400)
  })

  it('gives every successful file write and patch a diff that parses', () => {
    let diffs = 0
    for (const { file, conversation } of dataset) {
      for (const { call, result } of toolResults(conversation)) {
        if (!/^file_(write|patch|edit)$/.test(call.name) || result.status !== 'success') continue
        diffs++
        const diff = result.meta?.diff
        expect(`${file}:${call.toolCallId}:${typeof diff?.patch}`).toBe(
          `${file}:${call.toolCallId}:string`
        )
        const lines = parseUnifiedDiff(diff!.patch)
        expect(lines.filter((line) => line.kind === 'add').length).toBe(diff!.additions)
        expect(lines.filter((line) => line.kind === 'del').length).toBe(diff!.deletions)
      }
    }
    expect(diffs).toBeGreaterThan(8)
  })

  it('keeps a task list on every turn with three or more steps, in a coherent state', () => {
    let lists = 0
    const withLists = new Set<string>()
    for (const { file, conversation } of dataset) {
      for (const message of conversation.messages) {
        if (message.role !== 'assistant') continue
        for (const block of buildRenderBlocks(message)) {
          if (block.type !== 'todo') continue
          lists++
          withLists.add(file)
          expect(block.items.length).toBeGreaterThanOrEqual(3)
          expect(block.items.length).toBeLessThanOrEqual(6)
          // The desktop's rule: exactly one in progress while work remains.
          const inProgress = block.items.filter((item) => item.status === 'in_progress').length
          expect(`${file}:${block.key}:${inProgress}`).toMatch(/:[01]$/)
          for (const item of block.items) expect(item.content.trim().length).toBeGreaterThan(0)
        }
      }
    }
    expect(lists).toBeGreaterThan(100)
    // "Most conversations" is the brief: every conversation that does real
    // multi-step work, which is over half the dataset.
    expect(withLists.size).toBeGreaterThan(dataset.length / 2)
  })

  it('names only the code tools the clean feed keeps as compact rows', () => {
    expect([...CODE_ACTIVITY_TOOLS]).toEqual(
      expect.arrayContaining(['shell_exec', 'file_write', 'file_patch', 'file_edit'])
    )
  })
})

describe('demo notifications', () => {
  /**
   * The notification log the bundle seeds. Every card on the notifications
   * page is a card the user can TAP, so the failure this guards is a dead
   * one: a deeplink naming a conversation the dataset does not carry (or a
   * route this build does not have) opens nothing at all, and looks exactly
   * like a broken feature rather than missing content.
   *
   * The wire limits matter for the same reason the desktop enforces them —
   * demo copy that a real notify_phone call would be refused for is copy the
   * tour shows and the product cannot send.
   */
  const log = JSON.parse(readFileSync(path.join(DEMO_DIR, 'notifications.json'), 'utf8')) as {
    notifications: DemoNotification[]
  }

  const ids = new Set(everyConversation().map(({ conversation }) => conversation.id))

  it('is a curated list with something in every state the page renders', () => {
    expect(log.notifications.length).toBeGreaterThanOrEqual(8)
    const unread = log.notifications.filter((entry) => !entry.read)
    const archived = log.notifications.filter((entry) => entry.archived)
    // Unread is what puts the count on the sheet's Notifications row, and the
    // archive tab has to open on something.
    expect(unread.length).toBeGreaterThanOrEqual(2)
    expect(archived.length).toBeGreaterThanOrEqual(1)
    // Archived is always read — the store enforces it, and curated data that
    // disagreed would be silently corrected on import rather than rendered.
    for (const entry of archived) expect(entry.read).toBe(true)
    // Every phase tint the page can draw is worth showing at least once.
    expect(new Set(log.notifications.map((entry) => entry.phase)).size).toBeGreaterThanOrEqual(3)
  })

  it('belongs to a conversation that ships with it', () => {
    // The badge comes from HERE, not from the deeplink — which is why a
    // notification may name a conversation and no destination at all.
    for (const entry of log.notifications) {
      if (entry.conversationId === null) continue
      expect(`${entry.id} → ${entry.conversationId}`).toBe(
        `${entry.id} → ${ids.has(entry.conversationId) ? entry.conversationId : 'MISSING'}`
      )
    }
  })

  it('opens something real from every card that offers to open anything', () => {
    for (const entry of log.notifications) {
      // A null deeplink is a notification the model sent without a
      // destination — notify_phone permits it, and most mid-run ones are like
      // that. A tap just opens the app; the card is still worth reading.
      if (entry.deeplink === null) continue
      const target = parseDeeplink(entry.deeplink)
      // Resolvable by this build's own route table, not just well-formed.
      expect(`${entry.id}:${entry.deeplink}`).toEqual(expect.stringContaining('wolffish://'))
      expect(target).not.toBeNull()
      if (target?.route === 'chat') {
        // A link that names a conversation must name the one it came from, or
        // the tap and the badge send the user to different places.
        expect(entry.conversationId).toBe(target.conversationId)
      }
    }
  })

  it('shows what a real run leaves behind — one conversation, several of them', () => {
    // The pattern the counts exist for: a long task notifies at the start, at
    // a finding, when it blocks, and at the end. The conversation row adds
    // those up, so the dataset has to contain a run that produced more than
    // one — and the mid-run ones carry no deeplink, which is what used to make
    // them invisible to that row.
    const byConversation = new Map<string, number>()
    for (const entry of log.notifications) {
      if (!entry.conversationId) continue
      byConversation.set(entry.conversationId, (byConversation.get(entry.conversationId) ?? 0) + 1)
    }
    const busiest = Math.max(...byConversation.values())
    expect(busiest).toBeGreaterThanOrEqual(3)
    expect(log.notifications.some((entry) => entry.deeplink === null)).toBe(true)
  })

  it('stays inside the limits a real notification is held to', () => {
    const seen = new Set<string>()
    for (const entry of log.notifications) {
      expect(seen.has(entry.id)).toBe(false)
      seen.add(entry.id)
      expect(entry.title.trim().length).toBeGreaterThan(0)
      expect(entry.title.length).toBeLessThanOrEqual(NOTIFY_TITLE_MAX)
      expect(entry.body.trim().length).toBeGreaterThan(0)
      expect(NOTIFY_PHASES).toContain(entry.phase)
    }
  })

  it('is dated inside the run it came out of', () => {
    const spans = new Map(
      everyConversation().map(({ conversation }) => [
        conversation.id,
        { from: conversation.createdAt, to: conversation.updatedAt }
      ])
    )
    for (const entry of log.notifications) {
      expect(Number.isFinite(entry.at)).toBe(true)
      if (!entry.conversationId) continue
      const span = spans.get(entry.conversationId)
      expect(span).toBeDefined()
      // A notification fires when the run reaches a phase, so a 'started' or a
      // mid-run 'needs_input' legitimately predates the conversation's LAST
      // turn — but never its first, and never long after its last. Outside
      // that window the card's relative time and the conversation row's tell
      // different stories about the same run.
      expect(entry.at).toBeGreaterThanOrEqual(span!.from)
      expect(entry.at - span!.to).toBeLessThan(10 * 60_000)
    }
  })
})
