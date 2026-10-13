/**
 * heartbeat.md, read and written the way the desktop's Automations page reads
 * and writes it.
 *
 * An automation is a markdown heading (the schedule) plus the prompt underneath
 * it; switching one off comments the block out. There is no per-automation
 * record anywhere — the file IS the store, and the desktop's scheduler parses
 * it — so every edit here is "read the whole file, splice one block, write the
 * whole file back", exactly as the desktop's card editor does.
 *
 * This module is a direct port of that page's parser and splicer (wolffish-app
 * src/renderer/src/pages/Heartbeat.tsx), deliberately pure and with no imports:
 * it is the one piece of the feature that manipulates the workspace's own file
 * format, and a divergence between the two implementations would corrupt the
 * file for both screens. Keep the rules below in step with that page and with
 * the engine's own splitMarkers (main/runtime/brainstem.ts).
 */

import type { ReasoningMode } from '@/lib/tunnel/protocol'

/** Recognized schedule kinds, in the engine's own vocabulary. */
export type ScheduleKind =
  'startup' | 'once' | 'every' | 'hourly' | 'daily' | 'weekday' | 'weekly' | 'monthly' | 'cron'

export type ParsedSchedule = {
  type: ScheduleKind
  /** The 5-field expression the engine compiles the heading to; null for
   *  Startup and Once, which are not cron-driven. */
  cron: string | null
  /** Absolute local moment a `Once (…)` heading names. */
  atMs?: number
}

/** One automation block as it stands in the file. */
export type AutomationBlock = {
  /** The heading text — the automation's identity on both screens. */
  label: string
  type: ScheduleKind
  /** False when the block is commented out (switched off). */
  active: boolean
  /** The prompt, with the setting markers stripped. */
  body: string
  cron: string | null
  /** Resolved next fire, or null when there is none to compute. */
  nextRunMs: number | null
  /** File line the heading sits on, and the last line of the block. */
  lineIndex: number
  endLineIndex: number
  /** The `mode:` marker value; null ⇒ follows the workspace's global mode. */
  mode: 'single' | 'workflow' | null
  /** Absolute file line of that marker, for in-place rewrites; null if absent. */
  modeLineIndex: number | null
  /** The `thinking:` marker value; null ⇒ follows the model's thinking mode. */
  thinking: ReasoningMode | null
  /** Absolute file line of that marker, for in-place rewrites; null if absent. */
  thinkingLineIndex: number | null
  /** The `project: <id>` marker — this automation's runs bind to that project. */
  project: string | null
  /** The `icon: <emoji>` marker; null ⇒ the screen's default. */
  icon: string | null
  /**
   * The repeatable `file: <path>` markers — files the desktop copied into the
   * workspace when they were attached there. The run is told their name, size
   * and path and reads them with its own tools; nothing about them is stored
   * on this device, which is why the phone can show and detach them but not
   * add one (the bytes would have to be on the desktop's disk).
   */
  files: string[]
  /** The repeatable `dir: <path>` markers — folders the automation works in. */
  dirs: string[]
}

/** The scheduler's live view of one ACTIVE automation, served by the desktop. */
export type ActiveJob = {
  label: string
  cron: string | null
  nextRunMs: number | null
}

/** Card emoji for an automation that carries no marker of its own. */
export const DEFAULT_AUTOMATION_ICON = '🫀'

const DAY_MAP: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6
}

// The day-anchored forms take LISTS — "Daily (08:00, 14:00, 20:00)",
// "Weekly (Monday, Wednesday, Friday 09:00)", "Monthly (1, 15 09:00)" — so
// "three times a day" is one heading. Mirrors the engine's regexes and its
// cron builder: times sharing a minute fold into one 5-field expression, each
// distinct minute gets its own, and the parts are joined by " ; " (one
// expression is a cross product of its fields, so "08:00, 12:30" can never be
// a single expression).
const TIME_LIST = String.raw`\d{1,2}:\d{2}(?:\s*,\s*\d{1,2}:\d{2})*`
const DAY_NAME =
  'Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sun|Mon|Tue|Wed|Thu|Fri|Sat'
const DAY_LIST = `(?:${DAY_NAME})(?:\\s*,\\s*(?:${DAY_NAME}))*`
const DOM_LIST = String.raw`\d{1,2}(?:\s*,\s*\d{1,2})*`
const DAILY_NIGHTLY_RE = new RegExp(`^(?:Nightly|Daily)\\s*\\((${TIME_LIST})\\)$`, 'i')
const WEEKDAY_RE = new RegExp(`^Weekday\\s*\\((${TIME_LIST})\\)$`, 'i')
const WEEKLY_RE = new RegExp(`^Weekly\\s*\\((${DAY_LIST})\\s+(${TIME_LIST})\\)$`, 'i')
const MONTHLY_RE = new RegExp(`^Monthly\\s*\\((${DOM_LIST})\\s+(${TIME_LIST})\\)$`, 'i')
const CRON_JOIN = ' ; '

function splitCron(expr: string): string[] {
  return expr
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
}

function parseTimeList(list: string): Array<{ hh: number; mm: number }> {
  const seen = new Set<string>()
  const out: Array<{ hh: number; mm: number }> = []
  for (const part of list.split(',')) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(part.trim())
    if (!m) continue
    const key = `${Number(m[1])}:${Number(m[2])}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ hh: Number(m[1]), mm: Number(m[2]) })
  }
  return out.sort((a, b) => a.hh * 60 + a.mm - (b.hh * 60 + b.mm))
}

function parseDayList(list: string): number[] {
  const out = new Set<number>()
  for (const part of list.split(',')) {
    const d = DAY_MAP[part.trim().toLowerCase()]
    if (d !== undefined) out.add(d)
  }
  return [...out].sort((a, b) => a - b)
}

function parseNumberList(list: string): number[] {
  const out = new Set<number>()
  for (const part of list.split(',')) {
    const n = Number(part.trim())
    if (Number.isInteger(n)) out.add(n)
  }
  return [...out].sort((a, b) => a - b)
}

function timesToCron(times: Array<{ hh: number; mm: number }>, dom: string, dow: string): string {
  const byMinute = new Map<number, number[]>()
  for (const t of times) {
    const hours = byMinute.get(t.mm) ?? []
    hours.push(t.hh)
    byMinute.set(t.mm, hours)
  }
  return [...byMinute.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([mm, hours]) => `${mm} ${hours.join(',')} ${dom} * ${dow}`)
    .join(CRON_JOIN)
}

/**
 * A schedule heading → the kind and cron the engine would register for it, or
 * null when the heading is not a schedule at all (which is how a plain `##`
 * section in the file is skipped rather than shown as a broken automation).
 *
 * Mirrors the engine's own parser, including the Once round-trip validity guard
 * — an out-of-range date like month 13 or 25:99 is refused here too, so the
 * screen shows exactly the automations the scheduler would accept.
 */
export function parseSchedule(heading: string): ParsedSchedule | null {
  if (/^Startup$/i.test(heading)) return { type: 'startup', cron: null }

  const once = /^Once\s*\((\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})\)$/i.exec(heading)
  if (once) {
    const y = Number(once[1])
    const mo = Number(once[2])
    const d = Number(once[3])
    const hh = Number(once[4])
    const mi = Number(once[5])
    const dt = new Date(y, mo - 1, d, hh, mi, 0, 0)
    if (
      dt.getFullYear() !== y ||
      dt.getMonth() !== mo - 1 ||
      dt.getDate() !== d ||
      dt.getHours() !== hh ||
      dt.getMinutes() !== mi
    ) {
      return null
    }
    return { type: 'once', cron: null, atMs: dt.getTime() }
  }

  const every = /^Every\s*\((\d+)(m|h)\)$/i.exec(heading)
  if (every) {
    const n = Number(every[1])
    return {
      type: 'every',
      cron: every[2].toLowerCase() === 'm' ? `*/${n} * * * *` : `0 */${n} * * *`
    }
  }

  const hourly = /^Hourly\s*\(:?(\d{1,2})\)$/i.exec(heading)
  if (hourly) return { type: 'hourly', cron: `${Number(hourly[1])} * * * *` }

  const daily = DAILY_NIGHTLY_RE.exec(heading)
  if (daily) return { type: 'daily', cron: timesToCron(parseTimeList(daily[1]), '*', '*') }

  const weekday = WEEKDAY_RE.exec(heading)
  if (weekday) return { type: 'weekday', cron: timesToCron(parseTimeList(weekday[1]), '*', '1-5') }

  const weekly = WEEKLY_RE.exec(heading)
  if (weekly) {
    const days = parseDayList(weekly[1])
    return { type: 'weekly', cron: timesToCron(parseTimeList(weekly[2]), '*', days.join(',')) }
  }

  const monthly = MONTHLY_RE.exec(heading)
  if (monthly) {
    const doms = parseNumberList(monthly[1])
    return { type: 'monthly', cron: timesToCron(parseTimeList(monthly[2]), doms.join(','), '*') }
  }

  const cronMatch = /^Cron\s*\((.+)\)$/i.exec(heading)
  if (cronMatch) return { type: 'cron', cron: splitCron(cronMatch[1]).join(CRON_JOIN) }

  return null
}

/** One cron field expanded to its matching values, or null if it won't parse. */
function parseCronField(field: string, min: number, max: number): number[] | null {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim())
    if (!m) return null
    const step = m[2] ? Number(m[2]) : 1
    if (step < 1) return null
    let lo: number
    let hi: number
    if (m[1] === '*') {
      lo = min
      hi = max
    } else if (m[1].includes('-')) {
      const [a, b] = m[1].split('-')
      lo = Number(a)
      hi = Number(b)
    } else {
      lo = Number(m[1])
      hi = m[2] ? max : lo
    }
    if (lo < min || hi > max || lo > hi) return null
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out.size > 0 ? [...out].sort((a, b) => a - b) : null
}

/**
 * Next fire of a 5-field cron expression, in THIS DEVICE's local time.
 *
 * Used only where the desktop cannot answer: the editor's preview of a schedule
 * that has not been saved yet. Automations fire against the desktop's clock, so
 * a saved automation's next run is always the number the desktop served (see
 * `attachJobs`) — never this. A schedule is a wall-clock statement ("09:00"),
 * which reads the same in either zone; only the "in 14 hours" phrasing of the
 * preview would differ while the two devices are in different zones, and it
 * corrects itself the moment the automation is saved and the card takes the
 * desktop's own value.
 */
export function nextCronMs(expr: string, nowMs: number): number | null {
  // A " ; "-joined multi-expression fires at the earliest of its parts.
  const exprs = splitCron(expr)
  if (exprs.length > 1) {
    const nexts = exprs.map((e) => nextCronMs(e, nowMs)).filter((n): n is number => n !== null)
    return nexts.length > 0 ? Math.min(...nexts) : null
  }
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const minutes = parseCronField(parts[0], 0, 59)
  const hours = parseCronField(parts[1], 0, 23)
  const doms = parseCronField(parts[2], 1, 31)
  const months = parseCronField(parts[3], 1, 12)
  const dowsRaw = parseCronField(parts[4], 0, 7)
  if (!minutes || !hours || !doms || !months || !dowsRaw) return null
  const dows = new Set(dowsRaw.map((d) => d % 7))
  const domAny = parts[2] === '*'
  const dowAny = parts[4] === '*'
  const base = new Date(nowMs)
  for (let dayOffset = 0; dayOffset <= 4 * 366; dayOffset++) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset)
    if (!months.includes(day.getMonth() + 1)) continue
    const domOk = doms.includes(day.getDate())
    const dowOk = dows.has(day.getDay())
    const dayOk = domAny && dowAny ? true : domAny ? dowOk : dowAny ? domOk : domOk || dowOk
    if (!dayOk) continue
    for (const h of hours) {
      for (const m of minutes) {
        const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime()
        if (t > nowMs) return t
      }
    }
  }
  return null
}

/**
 * Per-automation setting markers — the LEADING non-empty body lines, in any
 * order, blank lines allowed between them. Parsed on this side rather than read
 * off the scheduler's snapshot for two reasons the desktop page states too: a
 * switched-off automation never reaches the scheduler and would have no card at
 * all, and the markers must be stripped from the preview or a marker reads as
 * instruction text.
 */
const MODE_MARKER_RE = /^mode:\s*(single|workflow)\s*$/i
// The job's own reasoning effort — canonical tokens, matching the engine's
// THINKING_MARKER_RE (brainstem.ts) and the desktop card's parser.
const THINKING_MARKER_RE = /^thinking:\s*(off|on|high|max)\s*$/i
const PROJECT_MARKER_RE = /^project:\s*(\S+)\s*$/i
const ICON_MARKER_RE = /^icon:\s*(\S+)\s*$/i
// Paths, and repeatable — so these take the whole line, spaces included.
const FILE_MARKER_RE = /^file:\s*(.+?)\s*$/i
const DIR_MARKER_RE = /^dir:\s*(.+?)\s*$/i

/**
 * Drop leading setting-marker lines (and the blanks between them) from a
 * prompt. The editor owns the markers, and it composes fresh ones on top at
 * save time — so a prompt that still carried them would grow a duplicated
 * marker block on every save. The engine strips leading markers before running
 * a job anyway, so they can never be legitimate instruction text.
 */
export function stripLeadingSettings(text: string): string {
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i].trim()
    if (
      line === '' ||
      MODE_MARKER_RE.test(line) ||
      THINKING_MARKER_RE.test(line) ||
      PROJECT_MARKER_RE.test(line) ||
      ICON_MARKER_RE.test(line) ||
      FILE_MARKER_RE.test(line) ||
      DIR_MARKER_RE.test(line)
    ) {
      i++
      continue
    }
    break
  }
  return lines.slice(i).join('\n').trim()
}

/**
 * Every automation in the file, active and inactive, in file order.
 *
 * `nextRunMs` is left to `attachJobs` — this function knows the file, and only
 * the desktop knows when its scheduler will next fire.
 */
export function parseAutomations(markdown: string): AutomationBlock[] {
  const lines = markdown.split('\n')
  const result: AutomationBlock[] = []
  let insideRawComment = false

  for (let i = 0; i < lines.length; i++) {
    // A raw comment block (the file's commented-out examples) is skipped
    // wholesale — only a `<!-- ## …` opener is a switched-off automation.
    if (
      !insideRawComment &&
      /<!--/.test(lines[i]) &&
      !/-->/.test(lines[i]) &&
      !/^<!--\s*##\s+/.test(lines[i])
    ) {
      insideRawComment = true
      continue
    }
    if (insideRawComment) {
      if (/-->/.test(lines[i])) insideRawComment = false
      continue
    }

    const activeLine = lines[i].match(/^##\s+(.+?)\s*$/)
    const inactiveSingle = lines[i].match(/^<!--\s*##\s+(.+?)\s*-->$/)
    // A block-comment opener only when it is not the one-line form, which the
    // pattern above already matched: `<!-- ## Daily (09:00) -->` would match
    // both, and reading it as an opener would swallow everything after it.
    const inactiveBlock = inactiveSingle ? null : lines[i].match(/^<!--\s*##\s+(.+?)\s*$/)
    const heading = activeLine ?? inactiveSingle ?? inactiveBlock
    if (!heading) continue

    const label = heading[1]
    const schedule = parseSchedule(label)
    if (!schedule) continue

    const isBlock = !!inactiveBlock
    const bodyLines: string[] = []
    let endIdx = i
    let mode: 'single' | 'workflow' | null = null
    let modeLineIndex: number | null = null
    let thinking: ReasoningMode | null = null
    let thinkingLineIndex: number | null = null
    let project: string | null = null
    let icon: string | null = null
    const files: string[] = []
    const dirs: string[] = []
    let sawContent = false

    for (let j = i + 1; j < lines.length; j++) {
      if (isBlock && /^\s*-->\s*$/.test(lines[j])) {
        endIdx = j
        break
      }
      // A body ends at the next heading, the next toggle opener, OR the start
      // of any raw comment block. Without that last guard the body swallows the
      // `<!--` opener below it, so deleting or switching off the automation
      // would strip the comment and un-comment the examples it wraps.
      if (/^##\s+/.test(lines[j]) || /^\s*<!--/.test(lines[j])) break
      // Dashed separators are not content (the engine drops them wholesale), so
      // they must not stop the marker scan — a marker after one would be missed
      // and the next save would insert a duplicate.
      if (/^---+\s*$/.test(lines[j])) {
        if (!isBlock) endIdx = j
        continue
      }
      if (!sawContent && lines[j].trim() !== '') {
        const line = lines[j].trim()
        const m = line.match(MODE_MARKER_RE)
        if (m) {
          mode = m[1].toLowerCase() as 'single' | 'workflow'
          modeLineIndex = j
          if (!isBlock) endIdx = j
          continue
        }
        const th = line.match(THINKING_MARKER_RE)
        if (th) {
          thinking = th[1].toLowerCase() as ReasoningMode
          thinkingLineIndex = j
          if (!isBlock) endIdx = j
          continue
        }
        const p = line.match(PROJECT_MARKER_RE)
        if (p) {
          project = p[1]
          if (!isBlock) endIdx = j
          continue
        }
        const ic = line.match(ICON_MARKER_RE)
        if (ic) {
          icon = ic[1]
          if (!isBlock) endIdx = j
          continue
        }
        const f = line.match(FILE_MARKER_RE)
        if (f) {
          files.push(f[1])
          if (!isBlock) endIdx = j
          continue
        }
        const d = line.match(DIR_MARKER_RE)
        if (d) {
          dirs.push(d[1])
          if (!isBlock) endIdx = j
          continue
        }
        sawContent = true
      }
      bodyLines.push(lines[j])
      if (!isBlock && lines[j].trim() !== '') endIdx = j
    }

    result.push({
      label,
      type: schedule.type,
      active: !!activeLine,
      body: bodyLines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim(),
      cron: schedule.cron,
      nextRunMs: schedule.atMs ?? null,
      lineIndex: i,
      endLineIndex: endIdx,
      mode,
      modeLineIndex,
      thinking,
      thinkingLineIndex,
      project,
      icon,
      files,
      dirs
    })
  }

  return result
}

/**
 * Fold the scheduler's live view into parsed blocks: its cron and its next
 * fire, both resolved on the desktop against the clock the automation will
 * actually fire on.
 *
 * Only those two fields. The body and the markers stay as parsed from the
 * CURRENT file — an engine running older marker rules once fed back a body with
 * `project:`/`icon:` lines still embedded in it, the editor composed fresh
 * markers on top, and every save duplicated the marker block.
 */
export function attachJobs(blocks: AutomationBlock[], jobs: ActiveJob[]): AutomationBlock[] {
  const byLabel = new Map(jobs.map((job) => [job.label, job]))
  return blocks.map((block) => {
    const job = byLabel.get(block.label)
    if (!job) return block
    return { ...block, cron: job.cron ?? block.cron, nextRunMs: job.nextRunMs ?? block.nextRunMs }
  })
}

/**
 * Fire order: the automation that runs next comes first. Active ones with no
 * computable moment (Startup, exotic crons) follow, and inactive ones — which
 * never fire — go last; file order within each group, since sort is stable.
 */
export function orderAutomations(blocks: AutomationBlock[]): AutomationBlock[] {
  const rank = (block: AutomationBlock): number =>
    block.active
      ? block.nextRunMs != null
        ? block.nextRunMs
        : Number.MAX_SAFE_INTEGER - 1
      : Number.MAX_SAFE_INTEGER
  return [...blocks].sort((a, b) => rank(a) - rank(b))
}

/** The block this automation was bound to when its editor opened. */
export type BoundBlock = { label: string; active: boolean }

/**
 * Re-locate a bound block in the CURRENT text. Line indices captured when the
 * editor opened go stale after the first autosave, and a block that vanished
 * entirely (edited away from the other screen) resolves to null — the caller
 * then inserts, which preserves the user's work as a new automation rather than
 * discarding it.
 */
export function findBlock(markdown: string, bound: BoundBlock): AutomationBlock | null {
  const blocks = parseAutomations(markdown)
  return (
    blocks.find((b) => b.label === bound.label && b.active === bound.active) ??
    blocks.find((b) => b.label === bound.label) ??
    null
  )
}

export type AutomationDraft = {
  schedule: string
  prompt: string
  icon: string
  projectId: string
  /**
   * The reasoning effort a NEW automation is stamped with — the mode the chat
   * composer is showing when the user taps New, mirroring the desktop's own
   * create contract. Unused when rewriting an existing block: that one carries
   * its own marker through (see settingLines).
   */
  thinking?: ReasoningMode
}

/**
 * Spell a prompt so the file format cannot eat any of it.
 *
 * Three kinds of line carry structural meaning no block body can hold: a
 * `## ` line ENDS the block in every parser of this file (the engine's
 * collectBody, the desktop page, this port) — pasting a prompt with its own
 * `## Prompt` section silently truncated everything after it; a dashed
 * separator line is dropped wholesale; and HTML comment tokens are the on/off
 * wrapper — a stray `<!--` swallows every automation below it from the
 * scheduler's view, and a stray `-->` would cut the wrapper short the day the
 * automation is switched off. Rather than losing user text to any of these,
 * respell each in the closest form every parser already reads as plain body
 * content: one leading space for the line-anchored rules (all of them are
 * anchored at column 0), one inner space for the comment tokens (the engine's
 * comment strip is position-independent, so a prefix cannot defuse those).
 *
 * Ported to the desktop page (wolffish-app src/renderer/src/lib/
 * heartbeat-escape.ts), so both draft editors write the same safe spelling.
 * Only WRITTEN bytes change — parsing stays identical on all sides.
 * Idempotent, so re-saving a parsed body never grows.
 */
export function escapePromptBody(text: string): string {
  return text
    .split('<!--')
    .join('< !--')
    .split('-->')
    .join('-- >')
    .split('\n')
    .map((line) => (/^##\s/.test(line) || /^---+\s*$/.test(line) ? ` ${line}` : line))
    .join('\n')
}

/**
 * The marker lines a written block carries, in the engine's read order.
 *
 * `mode`, `files` and `dirs` come from the block being replaced rather than the
 * draft: this editor does not own any of them (mode is a card switch, and files
 * and folders are attached on the desktop, which is where their bytes and paths
 * live), so a rewrite here must carry them through untouched or a save from the
 * phone would silently strip an automation's attachments.
 */
function settingLines(
  draft: AutomationDraft,
  mode: 'single' | 'workflow' | null,
  thinking: ReasoningMode | null,
  files: readonly string[] = [],
  dirs: readonly string[] = []
): string[] {
  return [
    ...(mode ? [`mode: ${mode}`] : []),
    ...(thinking ? [`thinking: ${thinking}`] : []),
    ...(draft.projectId ? [`project: ${draft.projectId}`] : []),
    // Every automation carries an emoji from birth, so this one is always
    // written; the picker can change it but never remove it.
    `icon: ${draft.icon || DEFAULT_AUTOMATION_ICON}`,
    ...files.map((file) => `file: ${file}`),
    ...dirs.map((dir) => `dir: ${dir}`)
  ]
}

/**
 * Write a draft into the file: replacing the bound block if it is still there,
 * inserting a new one otherwise. Answers the new markdown plus the binding to
 * carry forward, so the next autosave finds the block it just wrote.
 *
 * A replaced block keeps its own on/off state and its `mode:` marker — the
 * editor does not own either (they are the card's switches), and rewriting the
 * block must not silently flip one.
 */
export function writeDraft(
  markdown: string,
  bound: BoundBlock | null,
  draft: AutomationDraft
): { markdown: string; bound: BoundBlock } {
  const promptLines = escapePromptBody(stripLeadingSettings(draft.prompt)).split('\n')
  const target = bound ? findBlock(markdown, bound) : null

  if (target) {
    const markers = [
      ...settingLines(draft, target.mode, target.thinking, target.files, target.dirs),
      ''
    ]
    const block = target.active
      ? [`## ${draft.schedule}`, '', ...markers, ...promptLines]
      : [`<!-- ## ${draft.schedule}`, '', ...markers, ...promptLines, '-->']
    const lines = markdown.split('\n')
    lines.splice(target.lineIndex, target.endLineIndex - target.lineIndex + 1, ...block)
    return {
      markdown: lines.join('\n'),
      bound: { label: draft.schedule, active: target.active }
    }
  }

  // New automations go before the first HTML comment (the examples block) — the
  // same shape the desktop's page and the automations plugin both produce.
  const block = [
    `## ${draft.schedule}`,
    '',
    ...settingLines(draft, null, draft.thinking ?? null),
    '',
    ...promptLines
  ].join('\n')
  const firstComment = markdown.search(/<!--/)
  const next = (
    firstComment >= 0
      ? `${markdown.slice(0, firstComment).replace(/\s+$/, '')}\n\n${block}\n\n${markdown.slice(firstComment)}`
      : `${markdown.replace(/\s+$/, '')}\n\n${block}\n`
  ).replace(/^\n+/, '')
  return { markdown: next, bound: { label: draft.schedule, active: true } }
}

/**
 * Drop one `file:` / `dir:` marker line from an automation's block.
 *
 * A line splice rather than a block rewrite, deliberately: this is the phone's
 * only write to an automation's attachments, and touching exactly the one line
 * that names the path leaves the prompt, the other markers and the on/off
 * wrapper byte-identical. Works for a switched-off automation too — its markers
 * are plain lines inside the comment block.
 *
 * The desktop deletes the copy the marker pointed at: its scheduler reconciles
 * the uploads folder against the file on every reload, so the write this
 * returns is the whole of the phone's half of the job.
 */
export function removeBlockPath(
  markdown: string,
  block: AutomationBlock,
  kind: 'file' | 'dir',
  value: string
): string {
  const lines = markdown.split('\n')
  // Matched through the same regex that PARSED it, not by rebuilding the text —
  // `file:/a/b` and `file:   /a/b` are the same marker to the engine, and a
  // string compare against one spelling would silently no-op on the others.
  const re = kind === 'file' ? FILE_MARKER_RE : DIR_MARKER_RE
  for (let j = block.lineIndex + 1; j <= block.endLineIndex && j < lines.length; j++) {
    const match = lines[j].trim().match(re)
    if (!match || match[1] !== value) continue
    lines.splice(j, 1)
    return lines.join('\n')
  }
  return markdown
}

/**
 * Add a `file:` / `dir:` marker to an automation's block, right after the last
 * marker it already carries.
 *
 * A line splice rather than a block rewrite, for the same reason removeBlockPath
 * is: it leaves the prompt, the other markers and the on/off wrapper
 * byte-identical. Placed after the existing markers so the leading-marker scan
 * still finds it — a line appended below the prompt would read as instruction
 * text, not a setting.
 */
export function addBlockPath(
  markdown: string,
  block: AutomationBlock,
  kind: 'file' | 'dir',
  value: string
): string {
  const lines = markdown.split('\n')
  // Last marker line in the block, else the heading itself: inserting directly
  // under either keeps every marker contiguous from the top of the body.
  let insertAfter = block.lineIndex
  for (let j = block.lineIndex + 1; j <= block.endLineIndex && j < lines.length; j++) {
    const line = lines[j].trim()
    if (line === '') continue
    if (
      MODE_MARKER_RE.test(line) ||
      THINKING_MARKER_RE.test(line) ||
      PROJECT_MARKER_RE.test(line) ||
      ICON_MARKER_RE.test(line) ||
      FILE_MARKER_RE.test(line) ||
      DIR_MARKER_RE.test(line)
    ) {
      insertAfter = j
      continue
    }
    break
  }
  lines.splice(insertAfter + 1, 0, `${kind}: ${value}`)
  return lines.join('\n')
}

/** Switch an automation on or off by commenting its block out (or back in). */
export function toggleBlock(markdown: string, block: AutomationBlock): string {
  const lines = markdown.split('\n')
  if (block.active) {
    if (block.endLineIndex > block.lineIndex) {
      lines[block.lineIndex] = `<!-- ${lines[block.lineIndex]}`
      lines.splice(block.endLineIndex + 1, 0, '-->')
    } else {
      lines[block.lineIndex] = `<!-- ${lines[block.lineIndex]} -->`
    }
    return lines.join('\n')
  }
  lines[block.lineIndex] = lines[block.lineIndex].replace(/^<!--\s*/, '')
  if (/\s*-->$/.test(lines[block.lineIndex])) {
    lines[block.lineIndex] = lines[block.lineIndex].replace(/\s*-->$/, '')
    return lines.join('\n')
  }
  for (let j = block.lineIndex + 1; j < lines.length; j++) {
    if (/^\s*-->\s*$/.test(lines[j])) {
      lines.splice(j, 1)
      break
    }
    if (/^##\s+/.test(lines[j]) || /^<!--\s*##/.test(lines[j])) break
  }
  return lines.join('\n')
}

/**
 * Rewrite (or insert) an automation's `mode:` marker. Works for a switched-off
 * automation too — the marker is a plain line inside the comment block.
 */
export function setBlockMode(
  markdown: string,
  block: AutomationBlock,
  mode: 'single' | 'workflow'
): string {
  const lines = markdown.split('\n')
  if (block.modeLineIndex !== null) {
    lines[block.modeLineIndex] = `mode: ${mode}`
    return lines.join('\n')
  }
  const singleLineDisabled = /^<!--\s*##\s+.+?\s*-->\s*$/.test(lines[block.lineIndex])
  if (singleLineDisabled) {
    // A body-less switched-off automation is a one-line comment; splicing the
    // marker after it would put it OUTSIDE the comment, where the engine's
    // comment strip folds it into the PREVIOUS automation's instructions.
    // Convert to the block-comment form with the marker inside.
    const heading = lines[block.lineIndex].replace(/^<!--\s*/, '').replace(/\s*-->\s*$/, '')
    lines.splice(block.lineIndex, 1, `<!-- ${heading}`, '', `mode: ${mode}`, '-->')
    return lines.join('\n')
  }
  lines.splice(block.lineIndex + 1, 0, '', `mode: ${mode}`)
  return lines.join('\n')
}

/**
 * Rewrite (or insert) an automation's `thinking:` marker. Works for a
 * switched-off automation too — the marker is a plain line inside the comment
 * block. The `setBlockMode` contract exactly, one marker over.
 */
export function setBlockThinking(
  markdown: string,
  block: AutomationBlock,
  thinking: ReasoningMode
): string {
  const lines = markdown.split('\n')
  if (block.thinkingLineIndex !== null) {
    lines[block.thinkingLineIndex] = `thinking: ${thinking}`
    return lines.join('\n')
  }
  const singleLineDisabled = /^<!--\s*##\s+.+?\s*-->\s*$/.test(lines[block.lineIndex])
  if (singleLineDisabled) {
    const heading = lines[block.lineIndex].replace(/^<!--\s*/, '').replace(/\s*-->\s*$/, '')
    lines.splice(block.lineIndex, 1, `<!-- ${heading}`, '', `thinking: ${thinking}`, '-->')
    return lines.join('\n')
  }
  lines.splice(block.lineIndex + 1, 0, '', `thinking: ${thinking}`)
  return lines.join('\n')
}

/** Remove an automation's block, collapsing the blank line it leaves behind. */
export function deleteBlock(markdown: string, block: AutomationBlock): string {
  const lines = markdown.split('\n')
  lines.splice(block.lineIndex, block.endLineIndex - block.lineIndex + 1)
  if (
    lines[block.lineIndex] === '' &&
    (block.lineIndex === 0 || lines[block.lineIndex - 1] === '')
  ) {
    lines.splice(block.lineIndex, 1)
  }
  return lines.join('\n')
}

// ------------------------------------------------------------------- chips

export type ChipKind = 'hourly' | 'daily' | 'weekly' | 'monthly'

export const CHIP_KINDS: readonly ChipKind[] = ['hourly', 'daily', 'weekly', 'monthly']

/** How many runs per period a chip spreads out: once, twice, 3, 4 or 5 times. */
export type ChipTimes = 1 | 2 | 3 | 4 | 5

export const CHIP_TIMES: readonly ChipTimes[] = [1, 2, 3, 4, 5]

/**
 * Which pills a heading lights: the period chip its form belongs to and the
 * number of runs it makes per period, read back off the text itself, so the
 * pills reflect what is in the field — a chip-built heading, a hand-typed one,
 * or an existing automation being edited — rather than the last press. Null
 * when no period chip describes the form (Weekday, Cron, Once, Startup);
 * `times` is null when the count is beyond the pills.
 */
export function chipStateOf(heading: string): { kind: ChipKind; times: ChipTimes | null } | null {
  const asTimes = (n: number): ChipTimes | null =>
    CHIP_TIMES.includes(n as ChipTimes) ? (n as ChipTimes) : null
  if (/^Hourly\s*\(:?\d{1,2}\)$/i.test(heading)) return { kind: 'hourly', times: 1 }
  const every = /^Every\s*\((\d+)m\)$/i.exec(heading)
  if (every) {
    const n = Number(every[1])
    return n > 0 && 60 % n === 0 && 60 / n > 1 ? { kind: 'hourly', times: asTimes(60 / n) } : null
  }
  const daily = DAILY_NIGHTLY_RE.exec(heading)
  if (daily) return { kind: 'daily', times: asTimes(parseTimeList(daily[1]).length) }
  const weekly = WEEKLY_RE.exec(heading)
  if (weekly) {
    const runs = parseDayList(weekly[1]).length * parseTimeList(weekly[2]).length
    return { kind: 'weekly', times: asTimes(runs) }
  }
  const monthly = MONTHLY_RE.exec(heading)
  if (monthly) {
    const runs = parseNumberList(monthly[1]).length * parseTimeList(monthly[2]).length
    return { kind: 'monthly', times: asTimes(runs) }
  }
  return null
}

const EN_WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
] as const

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * A chip's schedule means "…starting about now", so it anchors on now rounded
 * up to the next 5-minute mark: the first run lands within minutes and the
 * preview line immediately confirms the pick. `times` runs are spread evenly
 * across the period, the first one on the anchor: "3 times a day" at 09:10 →
 * Daily (01:10, 09:10, 17:10); "3 times a week" on a Friday → Weekly (Sunday,
 * Tuesday, Friday 09:10); "twice a month" on the 11th → Monthly (11, 25 09:10).
 * Lists come out sorted the way the parser sorts them.
 */
export function chipSchedule(
  kind: ChipKind,
  nowMs: number = Date.now(),
  times: ChipTimes = 1
): string {
  const d = new Date(nowMs)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 5 - (d.getMinutes() % 5))
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  switch (kind) {
    case 'hourly':
      // Several runs an hour is an interval: 60 splits evenly by 2, 3 and 4.
      return times === 1 ? `Hourly (${d.getMinutes()})` : `Every (${60 / times}m)`
    case 'daily': {
      const hours = CHIP_TIMES.slice(0, times)
        .map((i) => (d.getHours() + Math.floor((24 * (i - 1)) / times)) % 24)
        .sort((a, b) => a - b)
      return `Daily (${hours.map((h) => `${pad2(h)}:${pad2(d.getMinutes())}`).join(', ')})`
    }
    case 'weekly': {
      const days = CHIP_TIMES.slice(0, times)
        .map((i) => (d.getDay() + Math.floor((7 * (i - 1)) / times)) % 7)
        .sort((a, b) => a - b)
      return `Weekly (${days.map((day) => EN_WEEKDAYS[day]).join(', ')} ${time})`
    }
    case 'monthly': {
      // Cron skips a day number the month does not have — every day stays
      // within 1–28 so the automation fires every month without exception.
      const doms = CHIP_TIMES.slice(0, times)
        .map((i) => ((Math.min(d.getDate(), 28) - 1 + Math.floor((28 * (i - 1)) / times)) % 28) + 1)
        .sort((a, b) => a - b)
      return `Monthly (${doms.join(', ')} ${time})`
    }
  }
}

/** Guide rows: the syntax literals stay English (they are the file format). */
export const GUIDE_ROWS = [
  { code: 'Startup', key: 'startup' },
  { code: 'Every (30m)', key: 'every' },
  { code: 'Hourly (15)', key: 'hourly' },
  { code: 'Daily (08:00)', key: 'daily' },
  { code: 'Daily (08:00, 14:00, 20:00)', key: 'dailyTimes' },
  { code: 'Nightly (23:00)', key: 'nightly' },
  { code: 'Weekday (09:00)', key: 'weekday' },
  { code: 'Weekly (Monday 09:30)', key: 'weekly' },
  { code: 'Weekly (Monday, Wednesday, Friday 09:30)', key: 'weeklyDays' },
  { code: 'Monthly (1 09:00)', key: 'monthly' },
  { code: 'Monthly (1, 15 09:00)', key: 'monthlyDays' },
  { code: 'Once (2026-08-01 15:00)', key: 'once' },
  { code: 'Cron (0 9 * * 1,3,5)', key: 'cron' }
] as const
