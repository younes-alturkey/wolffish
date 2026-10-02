import { diskWriter } from '@main/io/diskWriter'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Corpus } from '@main/runtime/corpus'

/**
 * BasalGanglia learns from outcomes — what worked, what didn't, what the
 * user approved or rejected.
 *
 * Maps to: the basal ganglia — a cluster of nuclei deep in the brain that
 * handle reward processing and habit formation. Every time you take an
 * action, the basal ganglia compares the result to the prediction and
 * nudges future behavior toward what worked. Skills you do without
 * thinking — typing, driving, the cadence of a familiar conversation —
 * live here.
 *
 * In Wolffish, the basal ganglia tracks every tool call, plan, and user
 * approval/rejection. Over time it builds a feedback log that the
 * prefrontal can read when planning: "the last twelve times I suggested a
 * Conventional Commit message the user accepted it without edits — keep
 * doing that." Growth comes from this loop, not from the model weights.
 */

export type FeedbackOutcome = 'success' | 'failed' | 'denied' | 'approved' | 'blocked'

export type FeedbackEntry = {
  timestamp: Date
  tool: string
  outcome: FeedbackOutcome
  args: Record<string, unknown>
  output?: string
  error?: string
  reason?: string
}

const OUTPUT_PREVIEW_CHARS = 200
// Args are logged for traceability, not for replay — the full fidelity copy
// lives in brain/conversations/*.json. Capping them keeps the day files (and
// anything that reads them, including wolffish_recall) from ballooning when a
// single call carries a large payload (e.g. a 700-char voice_respond text).
const ARGS_PREVIEW_CHARS = 200

// Hard ceiling on the preference digest folded into every system prompt. The
// digest is a learned-behaviour summary, not a transcript — keeping it small
// is the whole point (the raw day files used to dump ~60k tokens into context).
const DIGEST_MAX_CHARS = 2400
// How many recent corrections (denials + failures) the digest enumerates. The
// rest are recoverable on demand via wolffish_recall.
const DIGEST_MAX_CORRECTIONS = 12
const DIGEST_DETAIL_CHARS = 140

/** A single parsed feedback entry with its enclosing day. */
type ParsedEntry = {
  date: string
  time: string
  tool: string
  outcome: FeedbackOutcome
  detail: string
}

export type FeedbackSummary = {
  totalCalls: number
  successCount: number
  failedCount: number
  deniedCount: number
  successRate: number
  topTools: Array<{ tool: string; count: number }>
  topDenied: Array<{ tool: string; count: number }>
}

export type BasalGangliaOptions = {
  workspaceRoot?: string
  corpus?: Corpus
}

const CORPUS_OUTCOME_MAP: Record<FeedbackOutcome, 'success' | 'failure' | 'approved' | 'rejected'> =
  {
    success: 'success',
    approved: 'approved',
    failed: 'failure',
    blocked: 'failure',
    denied: 'rejected'
  }

export class BasalGanglia {
  private workspaceRoot: string | null
  private corpus: Corpus | null

  constructor(options: BasalGangliaOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? null
    this.corpus = options.corpus ?? null
  }

  /**
   * Append a tool-call outcome to today's feedback file. One file per day
   * under brain/basalganglia/YYYY-MM-DD.md, append-only.
   */
  async recordOutcome(entry: FeedbackEntry): Promise<void> {
    if (!this.workspaceRoot) return
    const dir = path.join(this.workspaceRoot, 'brain', 'basalganglia')
    const date = formatDate(entry.timestamp)
    const filepath = path.join(dir, `${date}.md`)

    try {
      await fs.mkdir(dir, { recursive: true })
    } catch {
      return
    }

    const line = renderEntry(entry)
    try {
      // Header decision inside the write queue — concurrent turns' tool
      // outcomes land in one file without duplicate date headers.
      await diskWriter.appendWithInit(filepath, (exists) =>
        exists ? line : `# ${date}\n\n${line}`
      )
    } catch {
      return
    }

    this.corpus?.emit('feedback.recorded', {
      action: entry.tool,
      outcome: CORPUS_OUTCOME_MAP[entry.outcome]
    })
  }

  /**
   * Build a compact, bounded **preference digest** from the last N days of
   * feedback — NOT the raw transcript. The digest carries the learning
   * signal the planner actually needs (reliability stats, habitual tools,
   * and recent corrections to avoid repeating) in ~1-2k tokens instead of
   * the ~60k the verbatim concatenation used to inject on every prompt.
   *
   * Today's file is excluded by default: today's actions are already visible
   * in the live message thread, and excluding them keeps this block
   * byte-stable across a turn's tool-loop iterations so the provider can
   * reuse the cached system-prompt prefix. The full transcript stays on disk
   * and is reachable on demand via wolffish_recall.
   */
  async getPreferences(days = 7, opts: { excludeToday?: boolean } = {}): Promise<string> {
    if (!this.workspaceRoot) return ''
    const dir = path.join(this.workspaceRoot, 'brain', 'basalganglia')
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      return ''
    }

    const todayKey = formatDate(new Date())
    const dated = entries.filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort()
    // Exclude today only when there's prior history to summarise — on a fresh
    // install (today is the only file) an empty digest helps no one.
    const excludeToday = (opts.excludeToday ?? true) && dated.some((n) => n !== `${todayKey}.md`)
    const window = dated.filter((name) => !(excludeToday && name === `${todayKey}.md`)).slice(-days)

    const files: Array<{ date: string; raw: string }> = []
    for (const name of window) {
      try {
        const raw = await fs.readFile(path.join(dir, name), 'utf8')
        if (raw.trim().length > 0) files.push({ date: name.replace(/\.md$/, ''), raw })
      } catch {
        // skip unreadable files
      }
    }
    return summarizePreferences(files)
  }

  /**
   * Aggregate stats across every recorded feedback file. Used by the insula
   * to answer "how am I doing?" and by the brain settings UI.
   */
  async getFeedbackSummary(): Promise<FeedbackSummary> {
    const empty: FeedbackSummary = {
      totalCalls: 0,
      successCount: 0,
      failedCount: 0,
      deniedCount: 0,
      successRate: 0,
      topTools: [],
      topDenied: []
    }
    if (!this.workspaceRoot) return empty

    const dir = path.join(this.workspaceRoot, 'brain', 'basalganglia')
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      return empty
    }

    const toolCounts = new Map<string, number>()
    const deniedCounts = new Map<string, number>()
    let total = 0
    let success = 0
    let failed = 0
    let denied = 0

    for (const name of entries) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue
      let raw: string
      try {
        raw = await fs.readFile(path.join(dir, name), 'utf8')
      } catch {
        continue
      }
      for (const line of raw.split(/\r?\n/)) {
        const parsed = parseEntryLine(line)
        if (!parsed) continue
        total += 1
        toolCounts.set(parsed.tool, (toolCounts.get(parsed.tool) ?? 0) + 1)
        if (parsed.outcome === 'success' || parsed.outcome === 'approved') success += 1
        else if (parsed.outcome === 'failed' || parsed.outcome === 'blocked') failed += 1
        else if (parsed.outcome === 'denied') {
          denied += 1
          deniedCounts.set(parsed.tool, (deniedCounts.get(parsed.tool) ?? 0) + 1)
        }
      }
    }

    return {
      totalCalls: total,
      successCount: success,
      failedCount: failed,
      deniedCount: denied,
      successRate: total === 0 ? 0 : success / total,
      topTools: rank(toolCounts, 5),
      topDenied: rank(deniedCounts, 5)
    }
  }
}

function renderEntry(entry: FeedbackEntry): string {
  const time = formatTime(entry.timestamp)
  const lines = [`- ${time} | ${entry.tool} | ${entry.outcome}`]
  lines.push(`  - Args: ${codeSpan(truncate(jsonInline(entry.args), ARGS_PREVIEW_CHARS))}`)
  if (entry.outcome === 'denied' || entry.outcome === 'blocked') {
    if (entry.reason && entry.reason.trim().length > 0) {
      lines.push(`  - Reason: ${oneLine(entry.reason)}`)
    }
  } else if (entry.outcome === 'failed') {
    if (entry.error && entry.error.trim().length > 0) {
      lines.push(`  - Error: ${truncate(oneLine(entry.error), OUTPUT_PREVIEW_CHARS)}`)
    }
  } else if (entry.output && entry.output.trim().length > 0) {
    lines.push(`  - Output: ${codeSpan(truncate(oneLine(entry.output), OUTPUT_PREVIEW_CHARS))}`)
  }
  return `${lines.join('\n')}\n\n`
}

/**
 * Collapse a window of raw day files into a bounded preference digest.
 * Pure — takes the file contents so it can be unit-tested without disk.
 *
 * The digest has three parts, all size-capped:
 *   1. Reliability line — call count, success rate, most-used tools.
 *   2. Recently-denied line — tools the user rejected (avoid unless asked).
 *   3. Corrections list — the most recent failures/denials with their reason,
 *      so the planner doesn't repeat a known dead end.
 * Successful calls are deliberately NOT enumerated — that was the firehose.
 */
export function summarizePreferences(files: Array<{ date: string; raw: string }>): string {
  const parsed: ParsedEntry[] = []
  for (const f of files) parsed.push(...parseDayEntries(f.date, f.raw))
  if (parsed.length === 0) return ''

  const toolCounts = new Map<string, number>()
  const deniedCounts = new Map<string, number>()
  let success = 0
  for (const e of parsed) {
    toolCounts.set(e.tool, (toolCounts.get(e.tool) ?? 0) + 1)
    if (e.outcome === 'success' || e.outcome === 'approved') success += 1
    else if (e.outcome === 'denied') deniedCounts.set(e.tool, (deniedCounts.get(e.tool) ?? 0) + 1)
  }

  const total = parsed.length
  const rate = Math.round((success / total) * 100)
  const span = files.length
  const topTools = rank(toolCounts, 6)
    .map((t) => `${t.tool} (${t.count})`)
    .join(', ')

  const lines: string[] = [`## Learned preferences (last ${span} day${span === 1 ? '' : 's'})`, '']
  lines.push(`- Reliability: ${total} tool calls, ${rate}% success. Most used: ${topTools}.`)

  const denied = rank(deniedCounts, 5)
  if (denied.length > 0) {
    const list = denied.map((t) => `${t.tool} ×${t.count}`).join(', ')
    lines.push(`- Recently denied (don't repeat unless the user asks again): ${list}.`)
  }

  // Most-recent corrections first. These are the actual learning signal.
  const corrections = parsed
    .filter((e) => e.outcome === 'failed' || e.outcome === 'denied' || e.outcome === 'blocked')
    .reverse()
    .slice(0, DIGEST_MAX_CORRECTIONS)
  if (corrections.length > 0) {
    lines.push('', '### Recent corrections & failures (avoid repeating)')
    for (const c of corrections) {
      const detail = c.detail ? ` — ${truncate(c.detail, DIGEST_DETAIL_CHARS)}` : ''
      lines.push(`- ${c.date} ${c.tool} ${c.outcome}${detail}`)
    }
  }

  lines.push(
    '',
    '(Summary only. For the full step-by-step history of any day, use wolffish_recall.)'
  )

  let out = lines.join('\n')
  if (out.length > DIGEST_MAX_CHARS) out = `${out.slice(0, DIGEST_MAX_CHARS - 1).trimEnd()}…`
  return out
}

/**
 * Parse a day file into structured entries, capturing the reason/error/output
 * detail line that follows each header. Tolerant of malformed input.
 */
function parseDayEntries(date: string, raw: string): ParsedEntry[] {
  const out: ParsedEntry[] = []
  const lines = raw.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const head = parseEntryHeader(lines[i])
    if (!head) continue
    let detail = ''
    // The detail sits on an indented `- Reason:`/`- Error:`/`- Output:` line
    // within the next few lines, before the next entry header.
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      if (parseEntryHeader(lines[j])) break
      const m = /^\s+-\s+(Reason|Error|Output):\s+(.*)$/.exec(lines[j])
      if (m) {
        detail = m[2].replace(/^`+\s?|\s?`+$/g, '').trim()
        break
      }
    }
    out.push({ date, time: head.time, tool: head.tool, outcome: head.outcome, detail })
  }
  return out
}

function parseEntryHeader(
  line: string
): { time: string; tool: string; outcome: FeedbackOutcome } | null {
  const m = /^-\s+(\d{2}:\d{2})\s+\|\s+([^|]+?)\s+\|\s+(\S+)\s*$/.exec(line)
  if (!m) return null
  const outcome = m[3].trim() as FeedbackOutcome
  if (!['success', 'failed', 'denied', 'approved', 'blocked'].includes(outcome)) return null
  return { time: m[1], tool: m[2].trim(), outcome }
}

function parseEntryLine(line: string): { tool: string; outcome: FeedbackOutcome } | null {
  const m = /^-\s+\d{2}:\d{2}\s+\|\s+([^|]+?)\s+\|\s+(\S+)\s*$/.exec(line)
  if (!m) return null
  const tool = m[1].trim()
  const outcomeRaw = m[2].trim() as FeedbackOutcome
  if (!['success', 'failed', 'denied', 'approved', 'blocked'].includes(outcomeRaw)) return null
  return { tool, outcome: outcomeRaw }
}

function jsonInline(value: unknown): string {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return String(value)
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1).trimEnd()}…`
}

// Pick a backtick run one longer than the longest run in the content so the
// span renders cleanly even when the args/output contain backticks.
function codeSpan(content: string): string {
  const longest = (content.match(/`+/g) ?? []).reduce((m, s) => Math.max(m, s.length), 0)
  const fence = '`'.repeat(longest + 1)
  const pad = content.startsWith('`') || content.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${content}${pad}${fence}`
}

function rank(counts: Map<string, number>, limit: number): Array<{ tool: string; count: number }> {
  return [...counts.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
}

function formatDate(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}
