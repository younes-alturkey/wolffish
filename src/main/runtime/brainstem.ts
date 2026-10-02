import { pruneAutomationUploads } from '@main/automations/files'
import { diskWriter } from '@main/io/diskWriter'
import type { Agent } from '@main/runtime/agent'
import { runDetached, type Corpus } from '@main/runtime/corpus'
import type { ReasoningMode } from '@main/runtime/reasoning'
import { currentThinkingModeSetting } from '@main/workspace/workspace'
import type { Cortex } from '@main/runtime/cortex'
import { isIndexablePath } from '@main/runtime/cortexIngest'
import type { Hippocampus, KnowledgeFile } from '@main/runtime/hippocampus'
import { parseFileBlocks, runDeepClean, runNightlyReflection } from '@main/runtime/reflection'
import type { ChatMessage, Thalamus } from '@main/runtime/thalamus'
import {
  DEFAULT_COMPACTION,
  DEFAULT_REFLECTION,
  type CompactionConfig,
  type ReflectionConfig
} from '@main/workspace/workspace'
import cron, { type ScheduledTask } from 'node-cron'
import { createHash } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Brainstem runs the autonomic background work — the things that keep
 * the agent alive without anyone deciding to do them.
 *
 * Maps to: the brainstem — the stalk that connects the brain to the
 * spinal cord. It runs heart rate, breathing, blood pressure, the
 * sleep-wake cycle. You don't have to think about any of it; the
 * brainstem just runs it, and if it stops, you stop.
 *
 * In Wolffish, Brainstem owns three background concerns: a file
 * watcher that drives cortex reindexing, a cron scheduler that fires
 * jobs declared in brainstem/heartbeat.md, and the nightly compaction
 * job that summarizes the day's episodes and promotes the worthwhile
 * facts into long-term knowledge.
 */

export type ScheduleKind =
  | 'daily'
  | 'weekly'
  | 'every'
  | 'hourly'
  | 'weekday'
  | 'monthly'
  | 'startup'
  | 'cron'
  | 'once'

export type BrainstemJob = {
  id: string
  type: ScheduleKind
  cron: string | null
  label: string
  body: string
  /** One node-cron task per ";"-joined expression in `cron`; empty otherwise. */
  tasks: ScheduledTask[]
  /** Epoch ms a one-time ('once') job fires; null for recurring/startup jobs. */
  runAt?: number | null
  /**
   * The job's own chat mode (its `mode: …` marker line). Overrides the
   * global mode for this job's runs; absent ⇒ follows the global mode.
   */
  mode?: 'single' | 'workflow' | null
  /**
   * The job's own reasoning effort (its `thinking: …` marker line). The
   * runs use it; absent ⇒ follows the chat's selected thinking mode.
   */
  thinking?: ReasoningMode | null
  /** Project binding (`project: <id>` marker) — runs get the project overlay. */
  project?: string | null
  /** Emoji (`icon: …` marker) stamped on the run's conversation for the rail badge. */
  icon?: string | null
  /** Display name (`name: …` marker); absent ⇒ the schedule heading stands in. */
  name?: string | null
  /** Attached files (`file: …` markers) — listed to the run, never injected. */
  files?: string[]
  /** Working directories (`dir: …` markers) — listed fresh into the run's tail. */
  dirs?: string[]
}

export type CompactionResult = {
  date: string
  promoted: number
  skipped: boolean
  reason?: string
}

/**
 * Last completed run of a compaction job, persisted for the settings panel.
 * Skipped fires (no episode, too few entries, LLM error) never overwrite the
 * record — the card always shows the last run that actually produced output,
 * and its timestamp keeps staleness honest.
 */
export type CompactionRunRecord = {
  /** Epoch ms when the run finished. */
  at: number
  durationMs: number
  /** Model that served the run — null for the weekly digest (no LLM call). */
  provider: string | null
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  /** The run's raw output: daily summary text / weekly digest line. */
  output: string
}

export type CompactionRunKind = 'daily' | 'weekly' | 'reflection' | 'deepClean'

export type CompactionRuns = {
  daily: CompactionRunRecord | null
  weekly: CompactionRunRecord | null
  /** Nightly reflection pass — optional keys so pre-feature meta files parse. */
  reflection?: CompactionRunRecord | null
  /** Monthly adversarial deep clean. */
  deepClean?: CompactionRunRecord | null
}

const RUN_KINDS: readonly CompactionRunKind[] = ['daily', 'weekly', 'reflection', 'deepClean']

export type BrainstemOptions = {
  workspaceRoot?: string
  corpus?: Corpus
  cortex?: Cortex
  hippocampus?: Hippocampus
  thalamus?: Thalamus
  watcherDebounceMs?: number
  agent?: Agent
}

const KNOWLEDGE_FILES: readonly KnowledgeFile[] = [
  'projects',
  'people',
  'preferences',
  'technical',
  'decisions'
]

/**
 * Compaction v2 — the CURATOR, not an extractor. The old pass was stateless
 * (never saw the existing knowledge), so it re-derived the same facts night
 * after night and appended every paraphrase as a new bullet: after three
 * months the wife's phone number sat in people.md thirteen times, sub-headers
 * were stripped so facts glued onto the wrong person, and contradictions
 * ("black coffee" vs "coffee with cardamom") accumulated instead of
 * resolving. v2 receives the CURRENT files plus the day's log and rewrites
 * the files — one entity, one section, growing richer over time, the way
 * someone who lives with you accumulates one coherent picture rather than a
 * pile of sticky notes.
 */
const COMPACTION_SYSTEM_PROMPT = `You are the nightly memory curator of a personal AI agent. You maintain five long-term knowledge files about the agent's user and their world. You receive the CURRENT content of all five files plus ONE day of conversation logs, and you produce the complete UPDATED files.

You are a curator, not a logger:
- MERGE, never duplicate. Each person, project, or topic gets ONE "## Entity" section whose bullets grow richer over time. If today's log restates something a file already holds, the file stays as it was — do not add a paraphrase.
- RESOLVE contradictions: newest evidence wins; keep one bullet, drop the stale one (date the change when the reversal itself matters).
- DELETE junk you encounter: contentless bullets, one-off session trivia, orphan fragments attached to the wrong entity, telemetry masquerading as knowledge.
- Facts must be attributed to the right entity. Never attach a fact to a person unless the log clearly supports it.
- Provenance discipline: entries in the log marked as heartbeat/procedure automations or [worker] sub-agents are the agent's own machinery. A worker's prompt is agent-authored — never derive user preferences from it. An automation's prompt was authored by the user when they set it up — its existence is already recorded elsewhere, so record only genuinely NEW durable insight from such runs, never restatements of the schedule itself.
- What belongs: durable facts about the user (habits, likes, dislikes, temperament, people in their life, ongoing projects, decisions, technical environment). What does not: how the agent should behave (that lives in the agent's playbook, not here), secrets/keys/tokens/passwords, anything true only today.
- Size is NOT a constraint — never drop a true, durable fact to save space. Files may grow indefinitely; your only duty is that they stay CLEAN: unique, attributed, current.

File shapes — STRUCTURE IS MANDATORY: every entity/topic is a "## Section" heading with its bullets underneath. Never emit a flat bullet list under the "# Header" — the agent's memory map surfaces the "##" headings, so a flat file is invisible to it. Skeleton every file must follow:

# People
<!-- People mentioned in conversations, relationships, roles -->
## Sana (wife)
- WhatsApp \`+9665…\`. Enjoys a daily funny-romantic meme; formats tracked to avoid repeats.
## Mom
- SMS bank alerts forwarded via …

- projects.md, people.md: one "## Entity" section per project/person.
- preferences.md: "## Topic" sections (e.g. "## Communication", "## Content", "## Lifestyle").
- technical.md: "## Area" sections (environment, pipelines, integrations).
- decisions.md: "## YYYY-MM" sections, newest first, one bullet per standing decision.

Output format — marker line of five equals signs, file name, five equals signs, then the COMPLETE file content:

===== summary =====
<3-6 bullets: what changed in the files tonight — the settings card shows this>
===== projects.md =====
===== people.md =====
===== preferences.md =====
===== technical.md =====
===== decisions.md =====

Output ALL five files whenever anything changes (unchanged files repeated verbatim). If the day's log adds nothing durable and the files need no cleanup, output exactly:
NO CHANGES
<one line saying why>`

const NOTHING_TO_PROMOTE = /^\s*NO CHANGES\b|nothing to promote/i

/** Episode input budget for the compaction call (chars ≈ tokens×4). */
const COMPACTION_EPISODE_MAX_CHARS = 160_000

/** Middle-truncate: openings carry the ask, endings carry the resolution. */
function capMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.6)
  const tail = max - head - 60
  return `${text.slice(0, head)}\n…[${text.length - max} chars of mid-day log omitted]…\n${text.slice(text.length - tail)}`
}

const DEFAULT_DEBOUNCE_MS = 500

/**
 * Debounce for append-heavy streams (corpus event log, app logs) — indexed
 * for retrieval but never worth re-parsing on every 2-second flush.
 */
const SLOW_INDEX_DEBOUNCE_MS = 60_000
const MIN_EPISODE_ENTRIES_FOR_COMPACTION = 3

// How far back a missed run may be and still fire as a catch-up on launch.
// Older misses are retired without running. Collapse + this window bound the
// catch-up flush to roughly "one run per automation", so no hard cap is needed.
const CATCHUP_WINDOW_MS = 24 * 60 * 60 * 1000
// Cadence at which the live "last seen" heartbeat tick is persisted, so the
// next launch can tell how long the app was down and which fires it missed.
const TICK_INTERVAL_MS = 60 * 1000
// setTimeout's max delay (~24.8 days). A one-time job further out than this is
// rejected at create time, so this is just a safety guard.
const MAX_TIMER_MS = 2 ** 31 - 1

// ── Schedule heading regexes ──────────────────────────────────────────
// The day-anchored forms take LISTS, so "three times a day" is one heading
// rather than three: "Daily (08:00, 14:00, 20:00)", "Weekday (09:00, 17:00)",
// "Weekly (Monday, Wednesday, Friday 09:00)", "Monthly (1, 15 09:00)". A
// single value is the one-item list, so every pre-list heading still parses
// byte-for-byte. Day names accept the full word or its 3-letter start.
const TIME_LIST = String.raw`\d{1,2}:\d{2}(?:\s*,\s*\d{1,2}:\d{2})*`
const DAY_NAME =
  'Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sun|Mon|Tue|Wed|Thu|Fri|Sat'
const DAY_LIST = `(?:${DAY_NAME})(?:\\s*,\\s*(?:${DAY_NAME}))*`
const DOM_LIST = String.raw`\d{1,2}(?:\s*,\s*\d{1,2})*`
const STARTUP_RE = /^Startup$/i
const EVERY_RE = /^Every\s*\((\d+)(m|h)\)$/i
const HOURLY_RE = /^Hourly\s*\(:?(\d{1,2})\)$/i
const ONCE_RE = /^Once\s*\((\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})\)$/i
const DAILY_NIGHTLY_RE = new RegExp(`^(?:Nightly|Daily)\\s*\\((${TIME_LIST})\\)$`, 'i')
const WEEKDAY_RE = new RegExp(`^Weekday\\s*\\((${TIME_LIST})\\)$`, 'i')
const WEEKLY_RE = new RegExp(`^Weekly\\s*\\((${DAY_LIST})\\s+(${TIME_LIST})\\)$`, 'i')
const MONTHLY_RE = new RegExp(`^Monthly\\s*\\((${DOM_LIST})\\s+(${TIME_LIST})\\)$`, 'i')
const CRON_RE = /^Cron\s*\((.+)\)$/i

const DAY_OF_WEEK: Record<string, number> = {
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

/**
 * A job's `cron` may hold SEVERAL 5-field expressions joined by ";". One
 * expression is a cross product of its fields, so "08:00, 12:30, 18:00" — two
 * different minutes — cannot be one expression ("0,30 8,12,18" would also fire
 * 08:30 and 12:00). The friendly forms group their times by minute and emit
 * one expression per group; the scheduler registers one node-cron task per
 * expression, and every next-run / catch-up computation folds over the parts.
 */
export const CRON_JOIN = ' ; '
export function splitCron(expr: string): string[] {
  return expr
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
}

type HHMM = { hh: number; mm: number }

/** "08:00, 14:00" → [{8,0},{14,0}], de-duplicated and sorted by wall-clock. */
function parseTimeList(list: string): HHMM[] {
  const seen = new Set<string>()
  const out: HHMM[] = []
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

/** "Monday, Wed" → [1, 3] (de-duplicated, ascending, Sunday = 0). */
function parseDayList(list: string): number[] {
  const out = new Set<number>()
  for (const part of list.split(',')) {
    const d = DAY_OF_WEEK[part.trim().toLowerCase()]
    if (d !== undefined) out.add(d)
  }
  return [...out].sort((a, b) => a - b)
}

/** "1, 15" → [1, 15] (de-duplicated, ascending; range is checked by cron). */
function parseNumberList(list: string): number[] {
  const out = new Set<number>()
  for (const part of list.split(',')) {
    const n = Number(part.trim())
    if (Number.isInteger(n)) out.add(n)
  }
  return [...out].sort((a, b) => a - b)
}

/**
 * Times × the day fields → the ";"-joined cron. Times sharing a minute fold
 * into one expression (`0 8,14,20 * * *`); each distinct minute gets its own.
 */
function timesToCron(times: HHMM[], dom: string, dow: string): string {
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

export type ParsedSchedule = {
  id: string
  kind: ScheduleKind
  cron: string | null
  label: string
  body: string
  /** Epoch ms a one-time ('once') schedule fires; undefined for recurring. */
  runAt?: number | null
  /** Per-job chat mode from the `mode: …` marker line; absent ⇒ global. */
  mode?: 'single' | 'workflow' | null
  /** Per-job reasoning effort from the `thinking: …` marker; absent ⇒ chat. */
  thinking?: ReasoningMode | null
  /** Project id from the `project: …` marker line; absent ⇒ no binding. */
  project?: string | null
  /** Emoji from the `icon: …` marker line; absent ⇒ none. */
  icon?: string | null
  /**
   * Display name from the `name: …` marker line; absent ⇒ none. The heading
   * (the schedule) stays the job's IDENTITY — this is only what the UIs show.
   */
  name?: string | null
  /** Attached file paths from the repeatable `file: …` marker lines. */
  files?: string[]
  /** Working directory paths from the repeatable `dir: …` marker lines. */
  dirs?: string[]
}

/**
 * Which family a pooled run belongs to. The pool is shared: an automation from
 * heartbeat.md, the built-in compaction and reflection jobs, and a
 * model-triggered procedure all queue through the same three slots. Only the
 * ids tell them apart, and those ids are this scheduler's naming — so the
 * split is resolved here, once, and travels with the snapshot instead of being
 * re-derived by every surface that reads the pool (the Automations pages on
 * both devices skip `procedure` by it when gating their play buttons).
 */
export type RunFamily = 'automation' | 'compaction' | 'reflection' | 'procedure'

/** The family a job id names. See registerCompaction/registerReflection. */
export function runFamily(id: string): RunFamily {
  if (id.startsWith('procedure:')) return 'procedure'
  if (id.startsWith('compaction-')) return 'compaction'
  if (id.startsWith('reflection-')) return 'reflection'
  return 'automation'
}

/**
 * The identity the run pool holds a slot under and coalesces fires on.
 *
 * NOT the job id, for automations. parseHeartbeat numbers ids POSITIONALLY per
 * kind (`daily`, `daily-2`, `every-3`) in file order, so every id below an
 * edit shifts the moment a same-kind job is added, removed, or toggled off.
 * A run in flight deliberately survives a scheduler reload — which means a
 * mid-run edit can hand a RUNNING job's id to a DIFFERENT automation, and from
 * then on every fire of that other job coalesces into a run that was never its
 * own: it reports "already running", never starts, and stays that way until
 * the impostor finishes. The heading LABEL is the identity that survives a
 * reload — jobStatuses already keys its history on it for exactly this reason.
 * The built-in families mint their own unique, stable ids and keep them.
 *
 * The id still travels in the snapshot (RunningJobInfo.id) — it is what routes
 * live log entries to the right card — so only pool bookkeeping moves here.
 */
function runKey(schedule: ParsedSchedule): string {
  return runFamily(schedule.id) === 'automation' ? `label:${schedule.label}` : schedule.id
}

export type RunningJobInfo = {
  id: string
  label: string
  body: string
  startedAt: number
  /** The run's own mode (stamped marker / procedure field); null ⇒ global. */
  mode: 'single' | 'workflow' | null
  /** Which family this run belongs to — see runFamily. */
  family: RunFamily
}

export type QueuedJobInfo = {
  id: string
  label: string
  /** The job's own mode (stamped marker / procedure field); null ⇒ global. */
  mode: 'single' | 'workflow' | null
  queuedAt: number
  /** Which family this run belongs to — see runFamily. */
  family: RunFamily
}

/** Live state of the run pool: every in-flight run plus the FIFO overflow. */
export type RunsSnapshot = {
  running: RunningJobInfo[]
  queued: QueuedJobInfo[]
}

/**
 * Last-run bookkeeping for a single heartbeat job, surfaced to the
 * `automations` capability via the AutomationsHost bridge so the agent can
 * answer "is anything running, and how did the last runs go?" without a
 * separate event store. Updated in runOne; reset on scheduler reload is
 * deliberately NOT done — history survives an edit so the model can still see
 * the previous run after the user tweaks a schedule.
 */
export type JobRunStatus = {
  lastRunAt: number | null
  lastStatus: 'completed' | 'failed' | 'skipped' | null
  lastError?: string
  lastDurationMs?: number
  runCount: number
}

/** Result of validating a proposed schedule heading against the engine. */
export type SchedulePreview =
  | { ok: true; kind: ScheduleKind; cron: string | null; human: string; runAt?: number | null }
  | { ok: false; error: string }

export type JobLogEntry = {
  id: string
  timestamp: number
  kind: 'text' | 'tool_call' | 'tool_result' | 'started' | 'completed' | 'failed' | 'skipped'
  summary: string
}

export type BrainstemListener = {
  onJobStarted?: (info: RunningJobInfo) => void
  onJobEnded?: (payload: { id: string; status: 'completed' | 'failed'; error?: string }) => void
  onJobLog?: (entry: JobLogEntry) => void
  /** The run pool changed: a run started or ended, or the queue moved. */
  onRunsChanged?: (snapshot: RunsSnapshot) => void
  /** A compaction-family job finished and its last-run record updated. */
  onCompactionRun?: (payload: { kind: CompactionRunKind }) => void
}

/**
 * How many jobs may run concurrently. Overflow fires wait in the FIFO queue
 * and are surfaced to the renderer as "queued" (they keep their coalescing:
 * a job already running or waiting never takes a second slot).
 */
export const MAX_CONCURRENT_JOBS = 3

export class Brainstem {
  private workspaceRoot: string | null
  private corpus: Corpus | null
  private cortex: Cortex | null
  private hippocampus: Hippocampus | null
  private thalamus: Thalamus | null
  private agent: Agent | null
  private watcher: FSWatcher | null = null
  private jobs = new Map<string, BrainstemJob>()
  private pendingIndex = new Map<string, NodeJS.Timeout>()
  // Up to MAX_CONCURRENT_JOBS jobs run at once through `running` (keyed by
  // job id, insertion order = start order). An overflow fire is QUEUED (not
  // dropped) in FIFO order, and coalesced per job id so a slow job can't
  // build a backlog of its own ticks.
  private running = new Map<string, RunningJobInfo>()
  private queue: Array<{
    schedule: ParsedSchedule
    handler: () => Promise<void>
    onComplete?: () => void
    queuedAt: number
  }> = []
  // One-time ('once') jobs: pending fire timers keyed by job id, and the labels
  // that have already fired this session (so a reload can't re-arm or re-run a
  // one-shot before its self-deletion from the file lands).
  private onceTimers = new Map<string, NodeJS.Timeout>()
  private firedOnce = new Set<string>()
  // Persisted "last seen" tick, used on the next launch to detect downtime and
  // replay (collapsed) the recurring fires that were missed while down.
  private tickTimer: NodeJS.Timeout | null = null
  private compactionTasks: ScheduledTask[] = []
  private compactionConfig: CompactionConfig = DEFAULT_COMPACTION
  private reflectionTasks: ScheduledTask[] = []
  private reflectionConfig: ReflectionConfig = DEFAULT_REFLECTION
  // Missed-fire sweep for the self-improvement jobs. node-cron can't fire
  // while the machine sleeps, and reflection defaults to 3 AM — on a laptop
  // most fires would be missed entirely. The sweep re-checks on launch and
  // every half hour, and enqueues any job whose most recent scheduled fire
  // has no completed run on record. Runs record even on failure, so a broken
  // provider can't put this in a hot retry loop — the next DUE fire retries,
  // and unreviewed conversations carry over on their own.
  private selfImproveSweep: NodeJS.Timeout | null = null
  private selfImproveKickoff: NodeJS.Timeout | null = null
  private readonly debounceMs: number
  private listener: BrainstemListener | null = null
  // Per-job last-run bookkeeping, keyed by the job's heading LABEL — the stable
  // identity across reloads. (Job ids like `every-2` are positional and shift
  // when a same-kind job is added or removed, which would misattribute one
  // job's run history to another after an edit/delete.)
  private jobStatuses = new Map<string, JobRunStatus>()
  // Serializes scheduler reloads so a bridge-driven write and the file
  // watcher firing on that same write can't interleave their stop/start.
  private reloadInFlight: Promise<void> = Promise.resolve()
  // Per-job "last edited" stamps, keyed by heading label and persisted to
  // brainstem/heartbeat-meta.json. Maintained by DIFF at every scheduler
  // (re)load — the one point every writer funnels through (card editor,
  // markdown editor, the automations plugin, external edits, once-job
  // self-deletes) — so an edit stamps the job no matter who made it. The
  // stored hash is what change detection compares against; editedAt is the
  // heartbeat file's mtime at the moment the change was observed, which is
  // also honest for edits made while the app was closed. Null until first
  // loaded from disk.
  private heartbeatMeta: Record<string, { editedAt: number; hash: string }> | null = null
  // Last-run records for the two compaction jobs, persisted to
  // brainstem/compaction-meta.json so the settings panel can show what the
  // last daily/weekly pass actually did. Null until first loaded from disk.
  private compactionRuns: CompactionRuns | null = null

  constructor(options: BrainstemOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? null
    this.corpus = options.corpus ?? null
    this.cortex = options.cortex ?? null
    this.hippocampus = options.hippocampus ?? null
    this.thalamus = options.thalamus ?? null
    this.agent = options.agent ?? null
    this.debounceMs = options.watcherDebounceMs ?? DEFAULT_DEBOUNCE_MS
  }

  setAgent(agent: Agent): void {
    this.agent = agent
  }

  setListener(listener: BrainstemListener | null): void {
    this.listener = listener
  }

  /** Every in-flight run, oldest first (Map insertion order = start order). */
  getRunningJobs(): RunningJobInfo[] {
    return [...this.running.values()]
  }

  /** The FIFO overflow: jobs accepted while all run slots were busy. */
  getQueuedJobs(): QueuedJobInfo[] {
    return this.queue.map((q) => ({
      id: q.schedule.id,
      label: q.schedule.label,
      mode: q.schedule.mode ?? null,
      queuedAt: q.queuedAt,
      family: runFamily(q.schedule.id)
    }))
  }

  async init(): Promise<void> {
    await this.startWatcher()
    // startScheduler reads the persisted last-seen tick to compute catch-up, so
    // it must run before startTicking overwrites that tick with "now".
    await this.startScheduler()
    this.startTicking()
    this.startCompactionScheduler()
    this.startReflectionScheduler()
    this.startSelfImprovementSweep()
  }

  async stop(): Promise<void> {
    await this.stopAll()
  }

  async stopAll(): Promise<void> {
    this.stopSelfImprovementSweep()
    this.stopReflectionScheduler()
    this.stopCompactionScheduler()
    this.stopTicking()
    // Record a final tick so a clean shutdown is the downtime boundary.
    await this.saveState({ lastTickAt: Date.now() })
    await this.stopScheduler()
    await this.stopWatcher()
  }

  /**
   * ONE recursive watcher over the whole workspace, not a per-path watcher
   * library.
   *
   * This used to be `chokidar.watch(<the eight roots>)`, which registers a
   * kernel watch per file: on a workspace of ~23k files that is ~23k open
   * descriptors in the main process, and the fd table fills to the process
   * cap. Past that point the failure is not "the watcher is slow" — it is
   * that `child_process.spawn` starts failing with EBADF, because libuv can
   * no longer get descriptors for the child's stdio. Every spawned tool dies
   * at once (gogcli, tar, ffmpeg, python, git), and each one reports it as
   * its own local problem: Google Workspace says gogcli "is not installed"
   * because `gog --version` won't run. The bug is invisible where it fires
   * and only shows up where it lands.
   *
   * `fs.watch(root, { recursive: true })` is one FSEvents stream on macOS
   * (ReadDirectoryChangesW on Windows) — 11 descriptors for the same tree,
   * flat in workspace size, and it covers directories created after start,
   * which the per-root form would miss on a fresh workspace.
   */
  async startWatcher(): Promise<void> {
    if (this.watcher) return
    if (!this.workspaceRoot) return

    const workspaceRoot = this.workspaceRoot
    let watcher: FSWatcher
    try {
      watcher = watch(workspaceRoot, { recursive: true, persistent: true }, (_event, name) => {
        if (!name) return
        const rel = name.toString()
        // Only the trees the cortex indexes: brain/ (memory, conversations,
        // tasks) plus the workspace-level trees the retrieval tools cover —
        // usage ledger, app/extension logs, and the artifact trees
        // (metadata-only ingest). diskWriter can't see plugin/shell writes,
        // so this watcher is the one ingest trigger that catches everything.
        const top = rel.split(/[\\/]/)[0]
        if (!WATCHED_ROOTS.has(top)) return
        const filepath = path.join(workspaceRoot, rel)
        if (isHeartbeatFile(filepath)) void this.reloadScheduler()
        // macOS coalesces creates, writes and deletes into one event type, so
        // the event never says which it was — 'auto' resolves it by existence
        // when the debounce fires, which is also the only moment the answer is
        // still true.
        this.scheduleIndex(filepath, 'auto')
      })
    } catch {
      return
    }
    watcher.on('error', () => {})
    this.watcher = watcher
  }

  async stopWatcher(): Promise<void> {
    for (const timer of this.pendingIndex.values()) clearTimeout(timer)
    this.pendingIndex.clear()
    if (!this.watcher) return
    try {
      this.watcher.close()
    } catch {
      // best-effort
    }
    this.watcher = null
  }

  /**
   * Build the cron schedule from heartbeat.md. `runStartup` fires the one-shot
   * `## Startup` jobs; it is true only on the initial start (from init()) and
   * false on every reload (from performReload). Without that gate a Startup
   * job — contractually "runs once on launch, never again until restart" —
   * would re-fire every time any automation is created/edited/deleted, since
   * each write reloads the scheduler.
   */
  async startScheduler(runStartup = true): Promise<void> {
    if (this.jobs.size > 0) return
    if (!this.workspaceRoot) return

    const heartbeatPath = path.join(this.workspaceRoot, 'brain', 'brainstem', 'heartbeat.md')
    let raw: string
    try {
      raw = await fs.readFile(heartbeatPath, 'utf8')
    } catch {
      return
    }

    // Refresh the per-job edit stamps from this exact snapshot of the file —
    // every write path lands here (init or reload), so the stamps can never
    // miss an edit regardless of which surface made it.
    await this.updateHeartbeatMeta(raw, heartbeatPath).catch(() => {})
    // Same reasoning for the attached-file copies: reconcile what we keep on
    // disk against what the file still names, so a `file:` marker removed by
    // ANY writer (this app, the phone, the agent's tools, a hand edit) takes
    // its copy with it. Fire-and-forget — a sweep must never delay the
    // scheduler, and it re-runs on the next reload anyway.
    void pruneAutomationUploads(referencedAutomationFiles(raw)).catch(() => undefined)

    const schedules = parseHeartbeat(raw)
    const startupJobs: ParsedSchedule[] = []

    for (const schedule of schedules) {
      if (schedule.kind === 'startup') {
        startupJobs.push(schedule)
        this.jobs.set(schedule.id, {
          id: schedule.id,
          type: schedule.kind,
          cron: null,
          label: schedule.label,
          body: schedule.body,
          tasks: [],
          mode: schedule.mode ?? null,
          thinking: schedule.thinking ?? null,
          project: schedule.project ?? null,
          icon: schedule.icon ?? null,
          name: schedule.name ?? null,
          files: schedule.files ?? [],
          dirs: schedule.dirs ?? []
        })
        continue
      }

      // One-time jobs use a setTimeout for their exact moment, not cron, and
      // self-delete from the file after firing. Registered for visibility.
      if (schedule.kind === 'once') {
        this.jobs.set(schedule.id, {
          id: schedule.id,
          type: schedule.kind,
          cron: null,
          label: schedule.label,
          body: schedule.body,
          tasks: [],
          runAt: schedule.runAt ?? null,
          mode: schedule.mode ?? null,
          thinking: schedule.thinking ?? null,
          project: schedule.project ?? null,
          icon: schedule.icon ?? null,
          name: schedule.name ?? null,
          files: schedule.files ?? [],
          dirs: schedule.dirs ?? []
        })
        this.scheduleOnce(schedule, runStartup)
        continue
      }

      if (!schedule.cron) continue
      const handler = this.handlerFor(schedule.kind, schedule)
      if (!handler) continue

      // One task per expression. A multi-time heading registers several; the
      // queue coalesces per job id, so two parts landing on the same minute
      // still run the job once.
      const tasks: ScheduledTask[] = []
      try {
        for (const expr of splitCron(schedule.cron)) {
          tasks.push(
            cron.schedule(expr, async () => {
              this.enqueue(schedule, handler)
            })
          )
        }
      } catch {
        for (const t of tasks) {
          try {
            t.stop()
          } catch {
            // best-effort
          }
        }
        continue
      }
      this.jobs.set(schedule.id, {
        id: schedule.id,
        type: schedule.kind,
        cron: schedule.cron,
        label: schedule.label,
        body: schedule.body,
        tasks,
        mode: schedule.mode ?? null,
        thinking: schedule.thinking ?? null,
        project: schedule.project ?? null,
        icon: schedule.icon ?? null,
        name: schedule.name ?? null,
        files: schedule.files ?? [],
        dirs: schedule.dirs ?? []
      })
    }

    // On the initial start only: replay (collapsed) the recurring fires missed
    // while the app was down, then fire the one-shot Startup jobs. Neither runs
    // on a reload triggered by an edit.
    if (runStartup) {
      await this.runCatchUp(schedules)
      for (const startup of startupJobs) {
        const handler = this.handlerFor(startup.kind, startup)
        if (!handler) continue
        this.enqueue(startup, handler)
      }
    }
  }

  async stopScheduler(): Promise<void> {
    for (const job of this.jobs.values()) {
      for (const task of job.tasks) {
        try {
          await task.stop()
        } catch {
          // best-effort
        }
      }
    }
    for (const timer of this.onceTimers.values()) clearTimeout(timer)
    this.onceTimers.clear()
    this.jobs.clear()
  }

  /**
   * Re-read brainstem/heartbeat.md and rebuild the cron schedule. Public so
   * the `automations` capability can apply an edit live in the same turn, and
   * serialized so this call and the workspace watcher firing on the same write
   * can't interleave their stop/start (which could double-register a job).
   */
  async reloadScheduler(): Promise<void> {
    const next = this.reloadInFlight.catch(() => {}).then(() => this.performReload())
    this.reloadInFlight = next
    await next
  }

  private async performReload(): Promise<void> {
    await this.stopScheduler()
    await this.startScheduler(false)
    this.corpus?.emit('brainstem.schedulerReloaded', {
      jobs: this.jobs.size,
      timestamp: new Date().toISOString()
    })
  }

  getActiveJobs(): Array<{
    id: string
    type: ScheduleKind
    cron: string | null
    label: string
    body: string
    mode: 'single' | 'workflow' | null
    /** The job's own reasoning effort (`thinking:` marker); null ⇒ chat. */
    thinking: ReasoningMode | null
    /** Project binding (`project:` marker); null ⇒ unbound. */
    project: string | null
    /** Emoji from the `icon:` marker; null ⇒ none. */
    icon: string | null
    /** Display name from the `name:` marker; null ⇒ the heading stands in. */
    name: string | null
    /** Attached file paths (`file:` markers). */
    files: string[]
    /** Working directories (`dir:` markers). */
    dirs: string[]
    /** The absolute moment a `once` job fires; null for every cron kind. */
    runAt: number | null
  }> {
    // The registered jobs carry every marker, and the runner honours them —
    // but this projection used to drop project/icon/files/dirs, so every
    // consumer of `heartbeat:getJobs` (the terminal's automation card and
    // list) rendered "project none", no icon and zero attachments over a job
    // whose markers were plainly in the file. Project the whole job.
    return [...this.jobs.values()].map((j) => ({
      id: j.id,
      type: j.type,
      cron: j.cron,
      label: j.label,
      body: j.body,
      mode: j.mode ?? null,
      thinking: j.thinking ?? null,
      project: j.project ?? null,
      icon: j.icon ?? null,
      name: j.name ?? null,
      files: j.files ?? [],
      dirs: j.dirs ?? [],
      runAt: j.runAt ?? null
    }))
  }

  // ── Per-job edit stamps ─────────────────────────────────────────────

  private heartbeatMetaPath(): string | null {
    if (!this.workspaceRoot) return null
    return path.join(this.workspaceRoot, 'brain', 'brainstem', 'heartbeat-meta.json')
  }

  private async ensureHeartbeatMeta(): Promise<Record<string, { editedAt: number; hash: string }>> {
    if (this.heartbeatMeta) return this.heartbeatMeta
    const metaPath = this.heartbeatMetaPath()
    const meta: Record<string, { editedAt: number; hash: string }> = {}
    if (metaPath) {
      try {
        const parsed: unknown = JSON.parse(await fs.readFile(metaPath, 'utf8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [label, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!value || typeof value !== 'object') continue
            const entry = value as { editedAt?: unknown; hash?: unknown }
            if (typeof entry.editedAt !== 'number' || !Number.isFinite(entry.editedAt)) continue
            if (typeof entry.hash !== 'string') continue
            meta[label] = { editedAt: entry.editedAt, hash: entry.hash }
          }
        }
      } catch {
        // Missing/corrupt store — the next diff reseeds it from the file.
      }
    }
    this.heartbeatMeta = meta
    return meta
  }

  private async persistHeartbeatMeta(): Promise<void> {
    const metaPath = this.heartbeatMetaPath()
    if (!metaPath || !this.heartbeatMeta) return
    try {
      await diskWriter.writeFileAtomic(metaPath, JSON.stringify(this.heartbeatMeta, null, 2))
    } catch {
      // Display-only metadata — losing a write is acceptable.
    }
  }

  // ── Compaction last-run records ─────────────────────────────────────

  private compactionRunsPath(): string | null {
    if (!this.workspaceRoot) return null
    return path.join(this.workspaceRoot, 'brain', 'brainstem', 'compaction-meta.json')
  }

  private async ensureCompactionRuns(): Promise<CompactionRuns> {
    if (this.compactionRuns) return this.compactionRuns
    const runs: CompactionRuns = { daily: null, weekly: null, reflection: null, deepClean: null }
    const runsPath = this.compactionRunsPath()
    if (runsPath) {
      try {
        const parsed: unknown = JSON.parse(await fs.readFile(runsPath, 'utf8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const kind of RUN_KINDS) {
            const value = (parsed as Record<string, unknown>)[kind]
            if (!value || typeof value !== 'object') continue
            const r = value as Record<string, unknown>
            if (typeof r.at !== 'number' || !Number.isFinite(r.at)) continue
            if (typeof r.durationMs !== 'number' || !Number.isFinite(r.durationMs)) continue
            if (typeof r.output !== 'string') continue
            runs[kind] = {
              at: r.at,
              durationMs: r.durationMs,
              provider: typeof r.provider === 'string' ? r.provider : null,
              model: typeof r.model === 'string' ? r.model : null,
              inputTokens: typeof r.inputTokens === 'number' ? r.inputTokens : null,
              outputTokens: typeof r.outputTokens === 'number' ? r.outputTokens : null,
              output: r.output
            }
          }
        }
      } catch {
        // Missing/corrupt store — reseeded by the next completed run.
      }
    }
    this.compactionRuns = runs
    return runs
  }

  async getCompactionRuns(): Promise<CompactionRuns> {
    const runs = await this.ensureCompactionRuns()
    return {
      daily: runs.daily,
      weekly: runs.weekly,
      reflection: runs.reflection ?? null,
      deepClean: runs.deepClean ?? null
    }
  }

  private async recordCompactionRun(
    kind: CompactionRunKind,
    record: CompactionRunRecord
  ): Promise<void> {
    const runs = await this.ensureCompactionRuns()
    runs[kind] = record
    const runsPath = this.compactionRunsPath()
    if (runsPath) {
      try {
        await diskWriter.writeFileAtomic(runsPath, JSON.stringify(runs, null, 2))
      } catch {
        // Display-only metadata — losing a write is acceptable.
      }
    }
    this.listener?.onCompactionRun?.({ kind })
  }

  /**
   * Diff the file's job blocks against the stored hashes: a new or changed
   * block (body, markers — but NOT the enabled/disabled toggle, which keeps
   * the inner lines intact) gets stamped with the file's mtime; entries whose
   * label vanished are dropped, so a rename reads as a fresh edit. On the
   * very first run (no store yet) every job seeds from the file's mtime —
   * from then on unchanged jobs keep their stamps forever.
   */
  private async updateHeartbeatMeta(raw: string, heartbeatPath: string): Promise<void> {
    if (!this.heartbeatMetaPath()) return
    const meta = await this.ensureHeartbeatMeta()
    let mtimeMs = Date.now()
    try {
      mtimeMs = (await fs.stat(heartbeatPath)).mtimeMs
    } catch {
      // File vanished between read and stat — "now" is the best stamp left.
    }
    const next: Record<string, { editedAt: number; hash: string }> = {}
    let changed = false
    for (const { label, block } of parseHeartbeatBlocks(raw)) {
      const hash = createHash('sha1').update(block).digest('hex')
      const prev = meta[label]
      if (prev && prev.hash === hash) {
        next[label] = prev
      } else {
        next[label] = { editedAt: Math.round(mtimeMs), hash }
        changed = true
      }
    }
    if (Object.keys(meta).length !== Object.keys(next).length) changed = true
    this.heartbeatMeta = next
    if (changed) await this.persistHeartbeatMeta()
  }

  /** Label → editedAt map the Automations page renders "Edited …" from. */
  async getHeartbeatEditStamps(): Promise<Record<string, number>> {
    const meta = await this.ensureHeartbeatMeta()
    return Object.fromEntries(Object.entries(meta).map(([label, e]) => [label, e.editedAt]))
  }

  /**
   * One-shot migration: the renderer donates the per-job stamps it kept in
   * localStorage (from the era when only in-app card edits were tracked).
   * Those are per-job precise, so they beat the coarse whole-file mtime this
   * store seeds with; labels that no longer exist are ignored. Returns the
   * refreshed map so the caller can render it in the same round-trip.
   */
  async adoptHeartbeatEditStamps(stamps: Record<string, number>): Promise<Record<string, number>> {
    const meta = await this.ensureHeartbeatMeta()
    let changed = false
    for (const [label, editedAt] of Object.entries(stamps)) {
      if (typeof editedAt !== 'number' || !Number.isFinite(editedAt)) continue
      const entry = meta[label]
      if (!entry || entry.editedAt === Math.round(editedAt)) continue
      meta[label] = { ...entry, editedAt: Math.round(editedAt) }
      changed = true
    }
    if (changed) await this.persistHeartbeatMeta()
    return this.getHeartbeatEditStamps()
  }

  async runCompaction(date?: string, jobId?: string): Promise<CompactionResult> {
    const targetDate = date ?? formatDate(new Date())
    const log = (kind: JobLogEntry['kind'], summary: string): void => {
      if (jobId) {
        this.listener?.onJobLog?.({ id: jobId, timestamp: Date.now(), kind, summary })
      }
    }

    if (!this.hippocampus || !this.thalamus) {
      return { date: targetDate, promoted: 0, skipped: true, reason: 'not configured' }
    }

    log('text', `Fetching episode for ${targetDate}`)
    const episode = await this.hippocampus.getEpisode(targetDate)
    if (!episode) {
      log('text', 'No episode found — skipping')
      return { date: targetDate, promoted: 0, skipped: true, reason: 'no episode' }
    }

    const entryCount = countEpisodeEntries(episode.content)
    if (entryCount < MIN_EPISODE_ENTRIES_FOR_COMPACTION) {
      log('text', `Only ${entryCount} entries — skipping`)
      return { date: targetDate, promoted: 0, skipped: true, reason: 'too few entries' }
    }

    log('text', `Analyzing ${entryCount} episode entries`)

    // v2 is stateful: the model sees the CURRENT files so it can merge and
    // clean instead of re-extracting. Episode capped so a heavy day (500KB of
    // automation logs) can't blow the context; head+tail survive a cut.
    const currentFiles: string[] = []
    for (const file of KNOWLEDGE_FILES) {
      const raw = await this.hippocampus.getKnowledgeFile(file)
      currentFiles.push(`===== ${file}.md =====\n${raw?.trim() || '(empty)'}`)
    }
    const material =
      `CURRENT KNOWLEDGE FILES:\n\n${currentFiles.join('\n\n')}\n\n` +
      `TODAY'S LOG (${targetDate}):\n\n${capMiddle(episode.content, COMPACTION_EPISODE_MAX_CHARS)}`

    const messages: ChatMessage[] = [{ role: 'user', content: material }]

    let response = ''
    let runProvider: string | null = null
    let runModel: string | null = null
    let runInputTokens: number | null = null
    let runOutputTokens: number | null = null
    const startedAt = Date.now()
    const thalamus = this.thalamus
    try {
      // role:'summary' stamps the emitted llm.response as summarization
      // overhead (itemized, never fed into a conversation's context meter,
      // recorded to the usage ledger by the agent's summary listener); the
      // sealed-scope wrapper keeps the emit out of any live turn's
      // relay — this cron can fire mid-chat and previously overwrote the
      // live meter with the compaction prompt's token count.
      await runDetached(async () => {
        for await (const chunk of thalamus.stream({
          system: COMPACTION_SYSTEM_PROMPT,
          messages,
          role: 'summary'
        })) {
          if (chunk.type === 'text') response += chunk.text
          else if (chunk.type === 'active_model') {
            runProvider = chunk.provider
            runModel = chunk.model
          } else if (chunk.type === 'turn_meta' && chunk.usage) {
            runInputTokens = chunk.usage.inputTokens
            runOutputTokens = chunk.usage.outputTokens
          } else if (chunk.type === 'error') throw new Error(chunk.message)
        }
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { date: targetDate, promoted: 0, skipped: true, reason: `llm error: ${message}` }
    }

    // Both success exits below record the run for the settings panel; failed
    // and skipped fires above never do, so the card keeps the last real run.
    const recordRun = (): Promise<void> =>
      this.recordCompactionRun('daily', {
        at: Date.now(),
        durationMs: Date.now() - startedAt,
        provider: runProvider,
        model: runModel,
        inputTokens: runInputTokens,
        outputTokens: runOutputTokens,
        output: response.trim()
      })

    if (NOTHING_TO_PROMOTE.test(response.trim())) {
      log('text', 'Nothing to promote')
      await this.hippocampus.writeConsolidated(
        weekKey(targetDate),
        summaryHeader(targetDate, response)
      )
      await recordRun()
      return { date: targetDate, promoted: 0, skipped: false, reason: 'nothing to promote' }
    }

    // v2 path: complete-file blocks. Each present, sane block replaces its
    // file (previous content kept as .md.bak by the hippocampus). The
    // summary block — not the whole response — is what lands in the weekly
    // consolidated file and the settings card.
    const blocks = parseFileBlocks(response)
    let promoted = 0
    let consolidatedNote: string
    const hasFileBlocks = KNOWLEDGE_FILES.some((f) => blocks.has(`${f}.md`))
    if (hasFileBlocks) {
      for (const file of KNOWLEDGE_FILES) {
        const next = blocks.get(`${file}.md`)
        if (!next || next === '(empty)') continue
        const current = (await this.hippocampus.getKnowledgeFile(file))?.trim() ?? ''
        if (next.trim() === current) continue
        if (next.length < 20) continue
        await this.hippocampus.replaceKnowledgeFile(file, next)
        promoted += 1
        log('tool_result', `Rewrote ${file}.md`)
      }
      consolidatedNote = blocks.get('summary') ?? `Curated ${promoted} knowledge file(s).`
      log('text', `Curated ${promoted} knowledge file${promoted === 1 ? '' : 's'}`)
    } else {
      // Fallback: the model answered in the legacy "# projects.md + bullets"
      // shape. Append-with-dedup keeps the night's facts rather than losing
      // them; the next successful v2 run folds them into structure.
      const sections = parsePromotionSections(response)
      for (const [file, facts] of sections) {
        for (const fact of facts) {
          await this.hippocampus.promoteToKnowledge(file, fact)
          promoted += 1
          log('tool_result', `Promoted fact to ${file}`)
        }
      }
      consolidatedNote = response
      log(
        'text',
        `Promoted ${promoted} fact${promoted === 1 ? '' : 's'} to knowledge (legacy format)`
      )
    }

    await this.hippocampus.writeConsolidated(
      weekKey(targetDate),
      summaryHeader(targetDate, consolidatedNote)
    )

    await recordRun()
    return { date: targetDate, promoted, skipped: false }
  }

  /**
   * Queue a job to run. Up to MAX_CONCURRENT_JOBS run at once; an overflow
   * fire is QUEUED rather than dropped. Coalesced per job id — if this job is
   * already running or already waiting in the queue, the new fire is folded
   * into the pending one (so a slow recurring job can never accumulate a
   * backlog of its own ticks). Returns where the fire landed: 'running' (a
   * free slot took it immediately), 'queued' (all slots busy), or 'coalesced'.
   */
  private enqueue(
    schedule: ParsedSchedule,
    handler: () => Promise<void>,
    onComplete?: () => void
  ): 'running' | 'queued' | 'coalesced' {
    const key = runKey(schedule)
    if (this.running.has(key) || this.queue.some((q) => runKey(q.schedule) === key)) {
      this.corpus?.emit('brainstem.jobCoalesced', { job: schedule.id, label: schedule.label })
      this.listener?.onJobLog?.({
        id: schedule.id,
        timestamp: Date.now(),
        kind: 'skipped',
        summary: `Coalesced "${schedule.label}" — it's already running or queued`
      })
      return 'coalesced'
    }
    const item = { schedule, handler, onComplete, queuedAt: Date.now() }
    this.queue.push(item)
    this.pump()
    // Whether a slot TOOK it — not whether it is still in flight. A run that
    // dies in its own first tick (a handler that throws before its first
    // await, an announcement that throws) has already released the slot by
    // the time we get here, and asking `running` would call that "queued":
    // a wait that will never end, on a run that already reported its failure.
    // Membership of the queue is the exact question, and it cannot race.
    return this.queue.includes(item) ? 'queued' : 'running'
  }

  /**
   * Fill free run slots from the queue. Synchronous (runOne registers the run
   * in `running` before its first await), so there is no window where a job is
   * neither queued nor running and a same-id fire could slip past coalescing.
   * Every pass ends by pushing the fresh pool snapshot to the listener — the
   * Automations pages' play buttons track transitions without polling.
   */
  private pump(): void {
    while (this.queue.length > 0 && this.running.size < MAX_CONCURRENT_JOBS) {
      const item = this.queue.shift()!
      void this.startRun(item)
    }
    this.listener?.onRunsChanged?.({
      running: this.getRunningJobs(),
      queued: this.getQueuedJobs()
    })
  }

  private async startRun(item: {
    schedule: ParsedSchedule
    handler: () => Promise<void>
    onComplete?: () => void
  }): Promise<void> {
    try {
      await this.runOne(item.schedule, item.handler)
    } catch {
      // runOne swallows handler errors itself — this only fires if a listener
      // callback threw. Never let that become an unhandled rejection or skip
      // the pump below.
    } finally {
      try {
        item.onComplete?.()
      } catch {
        // an onComplete (e.g. once self-delete) must not break the pool
      }
      this.pump()
    }
  }

  private async runOne(schedule: ParsedSchedule, handler: () => Promise<void>): Promise<void> {
    const start = Date.now()
    const info: RunningJobInfo = {
      id: schedule.id,
      label: schedule.label,
      body: schedule.body,
      startedAt: start,
      mode: schedule.mode ?? null,
      family: runFamily(schedule.id)
    }
    const key = runKey(schedule)
    this.running.set(key, info)
    // From here to the `finally` that frees the slot, EVERYTHING runs inside
    // the try. The announcements below are external code — a corpus listener,
    // an IPC broadcast to windows that may be tearing down — and a throw from
    // any of them used to escape before the try was entered, which skipped the
    // release and leaked the slot for the life of the process. Three of those
    // and the pool is permanently full: every later fire reports "queued" and
    // waits behind runs that ended long ago.
    try {
      this.corpus?.emit('brainstem.jobStarted', {
        job: schedule.id,
        type: schedule.kind,
        label: schedule.label,
        timestamp: new Date(start).toISOString()
      })
      this.listener?.onJobStarted?.(info)
      this.listener?.onJobLog?.({
        id: schedule.id,
        timestamp: start,
        kind: 'started',
        summary: `Started "${schedule.label}"`
      })
      await handler()
      this.corpus?.emit('brainstem.jobCompleted', {
        job: schedule.id,
        type: schedule.kind,
        label: schedule.label,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - start
      })
      this.listener?.onJobEnded?.({ id: schedule.id, status: 'completed' })
      this.listener?.onJobLog?.({
        id: schedule.id,
        timestamp: Date.now(),
        kind: 'completed',
        summary: `Completed "${schedule.label}" in ${Math.round((Date.now() - start) / 1000)}s`
      })
      this.recordStatus(schedule, {
        lastStatus: 'completed',
        lastRunAt: Date.now(),
        lastDurationMs: Date.now() - start,
        bumpRun: true
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.corpus?.emit('brainstem.jobFailed', {
        job: schedule.id,
        type: schedule.kind,
        label: schedule.label,
        timestamp: new Date().toISOString(),
        error: message
      })
      this.listener?.onJobEnded?.({ id: schedule.id, status: 'failed', error: message })
      this.listener?.onJobLog?.({
        id: schedule.id,
        timestamp: Date.now(),
        kind: 'failed',
        summary: `Failed "${schedule.label}": ${message}`
      })
      this.recordStatus(schedule, {
        lastStatus: 'failed',
        lastError: message,
        lastRunAt: Date.now(),
        lastDurationMs: Date.now() - start,
        bumpRun: true
      })
    } finally {
      this.running.delete(key)
    }
  }

  // ── One-time ('once') jobs ────────────────────────────────────────────

  /**
   * Arm a one-time job: a setTimeout for its exact moment. If the moment is
   * already past, fire a single catch-up run when it's within the catch-up
   * window AND this is the initial start (not a reload); otherwise retire it
   * unrun. `firedOnce` guards against a reload re-arming a one-shot that has
   * already fired but not yet self-deleted from the file.
   */
  private scheduleOnce(schedule: ParsedSchedule, runStartup: boolean): void {
    if (this.firedOnce.has(schedule.label)) return
    const handler = this.handlerFor('once', schedule)
    if (!handler) return
    const runAt = schedule.runAt ?? 0
    const delay = runAt - Date.now()
    if (delay > MAX_TIMER_MS) {
      // A single setTimeout can't span more than ~24.8 days (e.g. a 28-day
      // "In (28d)" / far "Once (...)"). Re-arm at the ceiling and recompute the
      // remaining delay then — chained until it's within range.
      const timer = setTimeout(() => {
        this.onceTimers.delete(schedule.id)
        this.scheduleOnce(schedule, false)
      }, MAX_TIMER_MS)
      if (typeof timer.unref === 'function') timer.unref()
      this.onceTimers.set(schedule.id, timer)
      return
    }
    if (delay > 0) {
      const timer = setTimeout(() => this.fireOnce(schedule, handler), delay)
      if (typeof timer.unref === 'function') timer.unref()
      this.onceTimers.set(schedule.id, timer)
      return
    }
    const overdueBy = Date.now() - runAt
    if (runStartup && overdueBy <= CATCHUP_WINDOW_MS) {
      this.corpus?.emit('brainstem.jobCatchup', {
        job: schedule.id,
        label: schedule.label,
        missedAt: new Date(runAt).toISOString()
      })
      this.fireOnce(schedule, handler)
    } else {
      // Stale (older than the window) or hit on a reload: drop it from the file
      // without firing.
      void this.retireOnce(schedule.label)
    }
  }

  private fireOnce(schedule: ParsedSchedule, handler: () => Promise<void>): void {
    this.onceTimers.delete(schedule.id)
    if (this.firedOnce.has(schedule.label)) return
    this.firedOnce.add(schedule.label)
    // Self-delete once the run actually completes (not before — so a queued
    // one-shot that hasn't run yet stays in the file and survives a reload).
    this.enqueue(schedule, handler, () => void this.retireOnce(schedule.label))
  }

  /** Remove a one-time job's entry from heartbeat.md, then reload. */
  private async retireOnce(label: string): Promise<void> {
    if (!this.workspaceRoot) return
    const p = path.join(this.workspaceRoot, 'brain', 'brainstem', 'heartbeat.md')
    try {
      // RMW inside the file's write queue: a self-retire firing while the
      // automations tool (or the user's editor) writes the same file must
      // strip from the FRESH contents, not a stale pre-write copy — the
      // stale-copy path silently resurrected or dropped sibling jobs.
      await diskWriter.update(p, (raw) => {
        if (raw === null) return null
        const next = stripHeartbeatHeading(raw, label)
        return next !== raw ? next : null
      })
    } catch {
      // best-effort — worst case the entry lingers and is retired next launch
    }
    await this.reloadScheduler()
  }

  // ── Downtime catch-up ─────────────────────────────────────────────────

  /**
   * On the initial start, replay the recurring fires missed while the app was
   * down — collapsed to ONE run per job (a 3-hour outage of an "every 15m" job
   * is a single catch-up, not twelve), and only for fires within the catch-up
   * window. One-time jobs handle their own catch-up in scheduleOnce.
   */
  private async runCatchUp(schedules: ParsedSchedule[]): Promise<void> {
    const now = Date.now()
    const state = await this.loadState()
    const downtimeStart = state?.lastTickAt ?? now
    // Advance the tick immediately so a crash mid-flush can't re-flush the same
    // misses on the next launch.
    await this.saveState({ lastTickAt: now })
    const windowStart = Math.max(downtimeStart, now - CATCHUP_WINDOW_MS)
    if (windowStart >= now) return // fresh install or no measurable gap

    for (const s of schedules) {
      if (s.kind === 'startup' || s.kind === 'once' || !s.cron) continue
      const lastFire = mostRecentCronOccurrence(s.cron, now, CATCHUP_WINDOW_MS)
      // Missed iff the most recent scheduled fire happened during the downtime
      // window (after we went down, within 24h).
      if (lastFire !== null && lastFire > windowStart) {
        const handler = this.handlerFor(s.kind, s)
        if (!handler) continue
        this.corpus?.emit('brainstem.jobCatchup', {
          job: s.id,
          label: s.label,
          missedAt: new Date(lastFire).toISOString()
        })
        this.enqueue(s, handler)
      }
    }
  }

  private statePath(): string | null {
    return this.workspaceRoot
      ? path.join(this.workspaceRoot, 'brain', 'brainstem', 'heartbeat-state.json')
      : null
  }

  private async loadState(): Promise<{ lastTickAt: number } | null> {
    const p = this.statePath()
    if (!p) return null
    try {
      const parsed = JSON.parse(await fs.readFile(p, 'utf8'))
      return typeof parsed?.lastTickAt === 'number' ? { lastTickAt: parsed.lastTickAt } : null
    } catch {
      return null
    }
  }

  private async saveState(state: { lastTickAt: number }): Promise<void> {
    const p = this.statePath()
    if (!p) return
    try {
      await diskWriter.writeFileAtomic(p, JSON.stringify(state))
    } catch {
      // best-effort — a missed tick just means a slightly wider downtime window
    }
  }

  private startTicking(): void {
    this.stopTicking()
    void this.saveState({ lastTickAt: Date.now() })
    this.tickTimer = setInterval(
      () => void this.saveState({ lastTickAt: Date.now() }),
      TICK_INTERVAL_MS
    )
    if (typeof this.tickTimer.unref === 'function') this.tickTimer.unref()
  }

  private stopTicking(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  /**
   * Merge a status patch into a job's last-run record, keyed by the job's
   * heading label (stable across reloads). `bumpRun` increments the run
   * counter (set on a real run, not a skip).
   */
  private recordStatus(
    schedule: { id: string; label: string },
    patch: Partial<JobRunStatus> & { bumpRun?: boolean }
  ): void {
    const prev = this.jobStatuses.get(schedule.label) ?? {
      lastRunAt: null,
      lastStatus: null,
      runCount: 0
    }
    const { bumpRun, ...rest } = patch
    const next: JobRunStatus = {
      ...prev,
      ...rest,
      runCount: prev.runCount + (bumpRun ? 1 : 0)
    }
    this.jobStatuses.set(schedule.label, next)
  }

  /**
   * Last-run status for every job that has run (or been skipped) this session,
   * keyed by job LABEL. Backs the `automations` capability's status view.
   */
  getJobStatuses(): Record<string, JobRunStatus> {
    const out: Record<string, JobRunStatus> = {}
    for (const [key, value] of this.jobStatuses) {
      out[key] = { ...value }
    }
    return out
  }

  /**
   * Run a heartbeat job on demand, identified by its id (e.g. "every-2") or its
   * exact heading label (e.g. "Every (5m)"). Goes through the very same pool a
   * cron fire uses (up to MAX_CONCURRENT_JOBS at once, overflow queued) and
   * produces the same sealed conversation + listener events. Fire-and-forget:
   * returns as soon as the run is accepted; started=false means it's waiting.
   *
   * `state` says WHICH kind of waiting, because the two are different promises
   * to the person who pressed the button: 'queued' will run on its own once a
   * slot frees, 'coalesced' will not — this fire was folded into a run of the
   * same job that is already in flight. `running` is how many runs hold the
   * pool right now, so a caller can say what the wait is actually behind
   * (compaction, reflection and procedure runs share these slots and draw no
   * card by default, which is why a full pool reads as "nothing is running").
   */
  runJobNow(idOrLabel: string): {
    ok: boolean
    started: boolean
    state?: 'running' | 'queued' | 'coalesced'
    running?: number
    error?: string
  } {
    const job = this.findJob(idOrLabel)
    if (!job) {
      return { ok: false, started: false, error: `No automation matches "${idOrLabel}".` }
    }
    if (job.body.trim().length === 0) {
      return {
        ok: false,
        started: false,
        error: `Automation "${job.label}" has no instruction body.`
      }
    }
    const handler = this.handlerFor(job.type, job)
    if (!handler)
      return {
        ok: false,
        started: false,
        error: `Automation "${job.label}" has no runnable handler.`
      }
    const schedule: ParsedSchedule = {
      id: job.id,
      kind: job.type,
      cron: job.cron,
      label: job.label,
      body: job.body,
      runAt: job.runAt ?? null,
      mode: job.mode ?? null,
      thinking: job.thinking ?? null,
      project: job.project ?? null,
      icon: job.icon ?? null,
      files: job.files ?? [],
      dirs: job.dirs ?? []
    }
    const state = this.enqueue(schedule, handler)
    const running = this.running.size
    if (state === 'coalesced') {
      return {
        ok: true,
        started: false,
        state,
        running,
        error: `"${job.label}" is already running or queued — it'll run shortly.`
      }
    }
    return { ok: true, started: state === 'running', state, running }
  }

  /**
   * Run an ad-hoc instruction NOW as a detached background job — used by the
   * `procedures` capability so a saved procedure runs exactly like a triggered
   * automation: through this same bounded run pool (up to MAX_CONCURRENT_JOBS
   * at once, overflow queued, coalesced per key), as a sealed autonomous
   * conversation that lands in history. `key` dedupes re-runs of the same
   * procedure — a second run while one is in flight is coalesced rather than
   * run twice. Fire-and-forget: returns once accepted.
   */
  runDetached(
    instruction: string,
    label: string,
    key: string,
    mode?: 'single' | 'workflow' | null,
    icon?: string | null,
    project?: string | null,
    files?: string[],
    dirs?: string[],
    thinking?: ReasoningMode | null
  ): { ok: boolean; started: boolean; error?: string } {
    if (!this.agent) return { ok: false, started: false, error: 'The agent is not ready yet.' }
    if (instruction.trim().length === 0) {
      return { ok: false, started: false, error: `"${label}" has no instruction to run.` }
    }
    // `kind: 'once'` here is cosmetic — it only labels the corpus jobStarted
    // event's `type`. The real one-time self-delete (retireOnce → rewrites
    // heartbeat.md) is wired ONLY as the enqueue `onComplete` in fireOnce, which
    // this path never touches. Do NOT add an onComplete or route detached runs
    // through scheduleOnce, or a procedure run would start editing heartbeat.md.
    const schedule: ParsedSchedule = {
      id: key,
      kind: 'once',
      cron: null,
      label,
      body: instruction,
      runAt: null,
      mode: mode ?? null,
      thinking: thinking ?? null
    }
    const state = this.enqueue(schedule, () =>
      this.runHeartbeatJob(
        instruction,
        label,
        'procedure',
        mode,
        thinking,
        project,
        icon,
        key,
        files,
        dirs
      )
    )
    if (state === 'coalesced') {
      return {
        ok: true,
        started: false,
        error: `"${label}" is already running or queued — it'll run shortly.`
      }
    }
    return { ok: true, started: state === 'running' }
  }

  /** Resolve a job by id first, then by exact (case-insensitive) label. */
  private findJob(idOrLabel: string): BrainstemJob | undefined {
    const needle = idOrLabel.trim()
    const byId = this.jobs.get(needle)
    if (byId) return byId
    const lower = needle.toLowerCase()
    for (const job of this.jobs.values()) {
      if (job.label.toLowerCase() === lower) return job
    }
    return undefined
  }

  private handlerFor(
    _kind: ScheduleKind,
    source: {
      id: string
      body: string
      label: string
      mode?: 'single' | 'workflow' | null
      thinking?: ReasoningMode | null
      project?: string | null
      icon?: string | null
      files?: string[]
      dirs?: string[]
    }
  ): (() => Promise<void>) | null {
    if (source.body.trim().length === 0) return null
    return () =>
      this.runHeartbeatJob(
        source.body,
        source.label,
        'heartbeat',
        source.mode,
        source.thinking,
        source.project,
        source.icon,
        source.id,
        source.files,
        source.dirs
      )
  }

  private async runHeartbeatJob(
    instruction: string,
    label: string,
    channel: 'heartbeat' | 'procedure' = 'heartbeat',
    mode?: 'single' | 'workflow' | null,
    thinking?: ReasoningMode | null,
    project?: string | null,
    icon?: string | null,
    jobId?: string,
    files?: string[],
    dirs?: string[]
  ): Promise<void> {
    if (!this.agent) return
    // Concurrency is handled by the run pool, so this just runs the turn.
    // `channel` stamps the sealed conversation so a procedure run reads as a
    // procedure (not an automation) in history; `project` binds the run to a
    // project (overlay + conversation registration) and `icon` stamps the
    // conversation's rail-badge emoji. `jobId` stamps the run's live log
    // entries so the renderer can route them to the right concurrent card.
    // `files`/`dirs` are the automation's own attachments: the files are
    // listed to the model (never injected), the dirs ride the same
    // working-folders channel the in-app composer's folder picker uses.
    const startedAt = Date.now()
    try {
      await this.agent.processAutonomous({
        instruction,
        jobLabel: label,
        jobId,
        channel,
        mode: mode ?? undefined,
        // The job's own stamp wins; a job saved before the marker existed
        // follows the chat's selected mode live — the same contract the card
        // switch displays (stamp ?? chat).
        thinkingMode: thinking ?? (await currentThinkingModeSetting()),
        projectId: project ?? undefined,
        icon: icon ?? undefined,
        contextFiles: files && files.length > 0 ? files : undefined,
        workingFolders: dirs && dirs.length > 0 ? dirs : undefined
      })
      await this.appendRunHistory(label, channel, 'ok', Date.now() - startedAt)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await this.appendRunHistory(label, channel, 'error', Date.now() - startedAt, msg)
      throw err
    }
  }

  /**
   * Persist every automation/procedure run outcome to
   * brain/brainstem/run-history.md. The in-memory job state only knows about
   * THIS session, and corpus event logs purge after 7 days — this file is the
   * durable, indexed answer to "why did last week's job fail?".
   */
  private async appendRunHistory(
    label: string,
    channel: string,
    status: 'ok' | 'error',
    durationMs: number,
    error?: string
  ): Promise<void> {
    if (!this.workspaceRoot) return
    const p = path.join(this.workspaceRoot, 'brain', 'brainstem', 'run-history.md')
    const ts = new Date().toISOString()
    const seconds = (durationMs / 1000).toFixed(1)
    const suffix = error ? ` | ${error.replace(/\s+/g, ' ').slice(0, 300)}` : ''
    try {
      await diskWriter.appendLine(
        p,
        `- ${ts} | ${channel} | ${label} | ${status} | ${seconds}s${suffix}`
      )
    } catch {
      // best-effort: history must never break a job run
    }
  }

  private async runWeeklyReview(jobId?: string): Promise<void> {
    const log = (kind: JobLogEntry['kind'], summary: string): void => {
      if (jobId) {
        this.listener?.onJobLog?.({ id: jobId, timestamp: Date.now(), kind, summary })
      }
    }

    if (!this.hippocampus) return
    const today = new Date()
    const startedAt = Date.now()
    log('text', 'Fetching recent episodes')
    const recent = await this.hippocampus.getRecentEpisodes(7)
    if (recent.length === 0) {
      log('text', 'No episodes found — skipping')
      return
    }
    log('text', `Consolidating ${recent.length} episode${recent.length === 1 ? '' : 's'}`)
    // The daily compaction job already appends its LLM-distilled summary of
    // each day into this week's consolidated file. Re-appending the RAW 7-day
    // episode concatenation on top of that (the old behavior) only polluted
    // the file — and the index — with a giant low-quality record. The weekly
    // pass now writes a compact coverage line instead.
    const dates = recent.map((ep) => ep.date)
    const entryCount = recent.reduce(
      (sum, ep) => sum + (ep.content.match(/^## /gm)?.length ?? 0),
      0
    )
    const digest = `Week in review: ${entryCount} logged turns across ${dates.length} active day${dates.length === 1 ? '' : 's'} (${dates[0]} → ${dates[dates.length - 1]}). Daily summaries above; full logs in episodes/.`
    await this.hippocampus.writeConsolidated(weekKey(formatDate(today)), digest)
    log('text', 'Weekly digest written')
    // No LLM call in the weekly pass — provider/model/tokens stay null and
    // the panel card shows just the digest, duration, and timestamp.
    await this.recordCompactionRun('weekly', {
      at: Date.now(),
      durationMs: Date.now() - startedAt,
      provider: null,
      model: null,
      inputTokens: null,
      outputTokens: null,
      output: digest
    })
  }

  // ── Config-driven compaction scheduler ────────────────────────────────

  private startCompactionScheduler(): void {
    this.stopCompactionScheduler()
    const cfg = this.compactionConfig

    // Daily compaction
    const dailyCron = `0 ${cfg.dailyHour} * * *`
    try {
      this.compactionTasks.push(
        cron.schedule(dailyCron, () => {
          this.enqueue(
            {
              id: 'compaction-daily',
              kind: 'daily',
              cron: dailyCron,
              label: 'Daily compaction',
              body: "Curate today's episodes into the long-term knowledge files — merge, dedupe, and update."
            },
            () => this.runCompaction(undefined, 'compaction-daily').then(() => undefined)
          )
        })
      )
    } catch {
      /* invalid cron — shouldn't happen with validated hours */
    }

    // Weekly consolidation
    const weeklyCron = `0 ${cfg.weeklyHour} * * ${cfg.weeklyDay}`
    try {
      this.compactionTasks.push(
        cron.schedule(weeklyCron, () => {
          this.enqueue(
            {
              id: 'compaction-weekly',
              kind: 'weekly',
              cron: weeklyCron,
              label: 'Weekly consolidation',
              body: "Consolidate the past week's episodes into a digest."
            },
            () => this.runWeeklyReview('compaction-weekly')
          )
        })
      )
    } catch {
      /* invalid cron */
    }
  }

  private stopCompactionScheduler(): void {
    for (const task of this.compactionTasks) {
      try {
        task.stop()
      } catch {
        /* best-effort */
      }
    }
    this.compactionTasks = []
  }

  setCompactionConfig(config: CompactionConfig): void {
    this.compactionConfig = config
    this.startCompactionScheduler()
  }

  getCompactionConfig(): CompactionConfig {
    return { ...this.compactionConfig }
  }

  // ── Reflection & deep clean (self-improvement jobs) ───────────────────

  setReflectionConfig(config: ReflectionConfig): void {
    this.reflectionConfig = config
    this.startReflectionScheduler()
  }

  getReflectionConfig(): ReflectionConfig {
    return { ...this.reflectionConfig }
  }

  private startReflectionScheduler(): void {
    this.stopReflectionScheduler()
    const cfg = this.reflectionConfig
    // The nightly reflection is a CORE feature — it always schedules; only
    // its hour is configurable. The learning loop has no off switch.
    const nightlyCron = `0 ${cfg.hour} * * *`
    try {
      this.reflectionTasks.push(
        cron.schedule(nightlyCron, () => this.enqueueReflection(nightlyCron))
      )
    } catch {
      /* invalid cron — shouldn't happen with validated hours */
    }
    // First of the month, one hour after reflection so the two never
    // contend. Core like the nightly pass — no off switch.
    const monthlyCron = `0 ${(cfg.hour + 1) % 24} 1 * *`
    try {
      this.reflectionTasks.push(
        cron.schedule(monthlyCron, () => this.enqueueDeepClean(monthlyCron))
      )
    } catch {
      /* invalid cron */
    }
  }

  private stopReflectionScheduler(): void {
    for (const task of this.reflectionTasks) {
      try {
        task.stop()
      } catch {
        /* best-effort */
      }
    }
    this.reflectionTasks = []
  }

  private enqueueReflection(cronExpr: string | null): 'running' | 'queued' | 'coalesced' {
    return this.enqueue(
      {
        id: 'reflection-nightly',
        kind: 'daily',
        cron: cronExpr,
        label: 'Nightly reflection',
        body: 'Review settled conversations — wins, failures — and fold the lessons into the playbook.'
      },
      () => this.runReflectionJob('reflection-nightly')
    )
  }

  private enqueueDeepClean(cronExpr: string | null): 'running' | 'queued' | 'coalesced' {
    return this.enqueue(
      {
        id: 'reflection-deepclean',
        kind: 'monthly',
        cron: cronExpr,
        label: 'Deep reflection',
        body: 'Deep reflection: challenge the playbook and knowledge files — merge duplicates, prune stale or contradicted entries.'
      },
      () => this.runDeepCleanJob('reflection-deepclean')
    )
  }

  /** Manual "run now" from the settings panel. */
  runReflectionNow(): 'running' | 'queued' | 'coalesced' {
    return this.enqueueReflection(null)
  }

  runDeepCleanNow(): 'running' | 'queued' | 'coalesced' {
    return this.enqueueDeepClean(null)
  }

  private async runReflectionJob(jobId?: string): Promise<void> {
    const log = (kind: JobLogEntry['kind'], summary: string): void => {
      if (jobId) {
        this.listener?.onJobLog?.({ id: jobId, timestamp: Date.now(), kind, summary })
      }
    }
    if (!this.thalamus || !this.workspaceRoot) return
    const startedAt = Date.now()
    try {
      const result = await runNightlyReflection(
        {
          workspaceRoot: this.workspaceRoot,
          thalamus: this.thalamus,
          corpus: this.corpus,
          log: (s) => log('text', s)
        },
        this.reflectionConfig.quietHours
      )
      await this.recordCompactionRun('reflection', {
        at: Date.now(),
        durationMs: Date.now() - startedAt,
        provider: result.provider,
        model: result.model,
        inputTokens: result.inputTokens > 0 ? result.inputTokens : null,
        outputTokens: result.outputTokens > 0 ? result.outputTokens : null,
        output: result.output
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log('text', `Reflection failed: ${message}`)
      // Record the failure too: it bounds the missed-fire sweep to one
      // attempt per scheduled fire, and unreviewed conversations simply
      // carry over to the next night.
      await this.recordCompactionRun('reflection', {
        at: Date.now(),
        durationMs: Date.now() - startedAt,
        provider: null,
        model: null,
        inputTokens: null,
        outputTokens: null,
        output: `Failed: ${message}`
      })
    }
  }

  private async runDeepCleanJob(jobId?: string): Promise<void> {
    const log = (kind: JobLogEntry['kind'], summary: string): void => {
      if (jobId) {
        this.listener?.onJobLog?.({ id: jobId, timestamp: Date.now(), kind, summary })
      }
    }
    if (!this.thalamus || !this.workspaceRoot || !this.hippocampus) return
    const startedAt = Date.now()
    try {
      const result = await runDeepClean({
        workspaceRoot: this.workspaceRoot,
        thalamus: this.thalamus,
        hippocampus: this.hippocampus,
        corpus: this.corpus,
        log: (s) => log('text', s)
      })
      await this.recordCompactionRun('deepClean', {
        at: Date.now(),
        durationMs: Date.now() - startedAt,
        provider: result.provider,
        model: result.model,
        inputTokens: result.inputTokens > 0 ? result.inputTokens : null,
        outputTokens: result.outputTokens > 0 ? result.outputTokens : null,
        output: result.output
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log('text', `Deep clean failed: ${message}`)
      await this.recordCompactionRun('deepClean', {
        at: Date.now(),
        durationMs: Date.now() - startedAt,
        provider: null,
        model: null,
        inputTokens: null,
        outputTokens: null,
        output: `Failed: ${message}`
      })
    }
  }

  private startSelfImprovementSweep(): void {
    this.stopSelfImprovementSweep()
    this.selfImproveKickoff = setTimeout(() => void this.sweepMissedSelfImprovement(), 90_000)
    this.selfImproveSweep = setInterval(() => void this.sweepMissedSelfImprovement(), 30 * 60_000)
  }

  private stopSelfImprovementSweep(): void {
    if (this.selfImproveKickoff) clearTimeout(this.selfImproveKickoff)
    if (this.selfImproveSweep) clearInterval(this.selfImproveSweep)
    this.selfImproveKickoff = null
    this.selfImproveSweep = null
  }

  private async sweepMissedSelfImprovement(): Promise<void> {
    const cfg = this.reflectionConfig
    let runs: CompactionRuns
    try {
      runs = await this.ensureCompactionRuns()
    } catch {
      return
    }
    const now = new Date()
    {
      const due = new Date(now)
      due.setHours(cfg.hour, 0, 0, 0)
      if (due.getTime() > now.getTime()) due.setDate(due.getDate() - 1)
      if ((runs.reflection?.at ?? 0) < due.getTime()) this.enqueueReflection(null)
    }
    {
      // Most recent 1st-of-month fire at (hour+1). Skip until reflection has
      // ever produced something — auditing an empty memory buys nothing.
      if (!runs.reflection && !runs.deepClean) return
      const hour = (cfg.hour + 1) % 24
      let due = new Date(now.getFullYear(), now.getMonth(), 1, hour, 0, 0, 0)
      if (due.getTime() > now.getTime()) {
        due = new Date(now.getFullYear(), now.getMonth() - 1, 1, hour, 0, 0, 0)
      }
      if ((runs.deepClean?.at ?? 0) < due.getTime()) this.enqueueDeepClean(null)
    }
  }

  private scheduleIndex(filepath: string, action: 'index' | 'remove' | 'auto'): void {
    if (!this.cortex) return
    if (!this.workspaceRoot) return
    if (shouldIgnoreWatch(filepath)) return
    const rel = path.relative(this.workspaceRoot, filepath).split(path.sep).join('/')
    if (rel.startsWith('..')) return
    if (!isIndexablePath(rel)) return

    // Append-heavy streams (corpus event log flushes every 2s, app logs) get
    // a long debounce so the indexer isn't thrashed by every flush; knowledge
    // and conversation writes stay near-realtime.
    const slow = rel.startsWith('brain/corpus/') || rel.startsWith('logs/')
    const debounce = slow ? SLOW_INDEX_DEBOUNCE_MS : this.debounceMs

    const existing = this.pendingIndex.get(filepath)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.pendingIndex.delete(filepath)
      void this.dispatchIndex(filepath, action)
    }, debounce)
    this.pendingIndex.set(filepath, timer)
  }

  private async dispatchIndex(
    filepath: string,
    action: 'index' | 'remove' | 'auto'
  ): Promise<void> {
    if (!this.cortex) return
    try {
      // 'auto' asks the disk instead of trusting the event: a file created and
      // deleted inside one debounce window must not be indexed, and a delete
      // the platform reported as a generic change must still remove the row.
      const resolved =
        action === 'auto'
          ? await fs
              .access(filepath)
              .then(() => 'index' as const)
              .catch(() => 'remove' as const)
          : action
      if (resolved === 'remove') await this.cortex.removeFile(filepath)
      else await this.cortex.indexFile(filepath)
    } catch {
      // a single failed index shouldn't break the watcher loop
    }
  }
}

// ── File-watcher ignore rules ─────────────────────────────────────────

/**
 * Top-level workspace directories the cortex indexes. The watcher runs on the
 * workspace root, so everything else under it (generations/, diagnostics/,
 * runtime scratch) is dropped on the first path segment.
 */
const WATCHED_ROOTS = new Set([
  'brain',
  'usage',
  'logs',
  'files',
  'uploads',
  'screenshots',
  'speech',
  'whatsapp'
])

/**
 * Hot-path rejects for watcher events: files that change constantly and are
 * never index-worthy (the heartbeat tick, the index's own db files, Baileys
 * credential churn). Broad structural pruning — dot-dirs, node_modules — is
 * isIndexablePath's job, which scheduleIndex applies to the workspace-relative
 * path right after this.
 */
function shouldIgnoreWatch(filepath: string): boolean {
  const normalized = filepath.replace(/\\/g, '/')
  // The heartbeat "last seen" tick is rewritten every minute — never react to it.
  if (normalized.endsWith('/brain/brainstem/heartbeat-state.json')) return true
  // Per-job edit stamps, rewritten by the scheduler on every heartbeat edit —
  // display metadata, never index-worthy.
  if (normalized.endsWith('/brain/brainstem/heartbeat-meta.json')) return true
  // Compaction last-run records — display metadata for the settings panel.
  if (normalized.endsWith('/brain/brainstem/compaction-meta.json')) return true
  if (normalized.endsWith('cortex.db')) return true
  if (normalized.endsWith('cortex.db-wal') || normalized.endsWith('cortex.db-shm')) return true
  if (normalized.includes('/.debug/') || normalized.includes('/.debug-archive/')) return true
  // Baileys credential churn — high write frequency, never indexable.
  if (normalized.includes('/whatsapp/auth')) return true
  if (normalized.includes('/node_modules/') || normalized.endsWith('/node_modules')) return true
  const base = path.basename(normalized)
  if (base.startsWith('.')) return true
  return false
}

function isHeartbeatFile(filepath: string): boolean {
  return filepath.replace(/\\/g, '/').endsWith('/brain/brainstem/heartbeat.md')
}

// ── Heartbeat parser ──────────────────────────────────────────────────

export function parseHeartbeat(raw: string): ParsedSchedule[] {
  const out: ParsedSchedule[] = []
  const stripped = raw.replace(/<!--[\s\S]*?-->/g, '')
  const lines = stripped.split(/\r?\n/)
  const idCounters = new Map<string, number>()

  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^##\s+(.+?)\s*$/)
    if (!heading) continue

    const headingText = heading[1]
    const { body, mode, thinking, project, icon, name, files, dirs } = splitMarkers(
      collectBody(lines, i + 1)
    )
    const parsed = matchSchedule(headingText)

    if (!parsed) continue

    const count = (idCounters.get(parsed.kind) ?? 0) + 1
    idCounters.set(parsed.kind, count)
    const id = count > 1 ? `${parsed.kind}-${count}` : parsed.kind

    out.push({
      id,
      kind: parsed.kind,
      cron: parsed.cron,
      label: headingText,
      body,
      runAt: parsed.runAt ?? null,
      mode,
      thinking,
      project,
      icon,
      name,
      files,
      dirs
    })
  }

  return out
}

/**
 * Every job block in the file — ACTIVE and DISABLED alike — as (label, block
 * text) pairs for edit-stamp hashing. parseHeartbeat can't serve this: it
 * strips HTML comments wholesale, so toggled-off jobs vanish. This mirrors
 * the Automations page's section scan (Heartbeat.tsx parseSidebarJobs):
 * a raw `<!--` line that isn't a `<!-- ##` toggle opens an opaque comment
 * (the examples block), and jobs come in three forms — `## label`,
 * `<!-- ## label -->` (body-less disabled), `<!-- ## label` … `-->` (block
 * disabled). The block text keeps marker lines (a mode/project/icon change
 * IS an edit) and drops the comment wrappers, so an enable/disable toggle —
 * which only wraps, never rewrites — hashes identically. Keep in sync with
 * the renderer's scan.
 */
export function parseHeartbeatBlocks(raw: string): Array<{ label: string; block: string }> {
  const lines = raw.split(/\r?\n/)
  const out: Array<{ label: string; block: string }> = []
  let insideRawComment = false

  for (let i = 0; i < lines.length; i++) {
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
    const inactiveBlock = !inactiveSingle && lines[i].match(/^<!--\s*##\s+(.+?)\s*$/)
    if (!activeLine && !inactiveSingle && !inactiveBlock) continue

    const label = (activeLine ?? inactiveSingle ?? inactiveBlock)![1]
    if (!matchSchedule(label)) continue

    const isBlock = !!inactiveBlock
    const blockLines: string[] = []
    if (!inactiveSingle) {
      for (let j = i + 1; j < lines.length; j++) {
        if (isBlock && /^\s*-->\s*$/.test(lines[j])) break
        if (!isBlock && (/^##\s+/.test(lines[j]) || /^\s*<!--/.test(lines[j]))) break
        // Dashed separators are not content (the engine drops them wholesale).
        if (/^---+\s*$/.test(lines[j])) continue
        blockLines.push(lines[j])
      }
    }
    out.push({
      label,
      block: blockLines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    })
  }

  return out
}

/**
 * A job's optional per-job settings ride its LEADING body lines as plain
 * markers — `mode: single|workflow`, `project: <id>`, `icon: <emoji>`, plus the
 * repeatable `file: <path>` and `dir: <path>` — in any order, with blank lines
 * allowed between them (headings are the schedule+label identity, and HTML
 * comments are stripped wholesale before parsing — neither can carry them). The
 * markers are split OFF the body here so they never leak into the instruction
 * the model receives. The renderer's Automations-page parser, the phone's port
 * of it, and the automations plugin's block parser mirror this rule — keep all
 * four in sync.
 */
export const MODE_MARKER_RE = /^mode:\s*(single|workflow)\s*$/i
export const THINKING_MARKER_RE = /^thinking:\s*(off|on|high|max)\s*$/i
export const PROJECT_MARKER_RE = /^project:\s*(\S+)\s*$/i
export const ICON_MARKER_RE = /^icon:\s*(\S+)\s*$/i
/**
 * The automation's display name. Free text (spaces and all), so it takes
 * `(.+?)` like the path markers below rather than a single token. The heading
 * remains the identity the scheduler keys on — this only names the job for
 * the people reading it.
 */
export const NAME_MARKER_RE = /^name:\s*(.+?)\s*$/i
/**
 * Attached files and working directories, both REPEATABLE — an automation can
 * carry several of each, so these accumulate instead of last-one-wins. Their
 * value is a whole path, spaces and all, which is why they take `(.+?)` where
 * the settings above take a single token.
 */
export const FILE_MARKER_RE = /^file:\s*(.+?)\s*$/i
export const DIR_MARKER_RE = /^dir:\s*(.+?)\s*$/i

export function splitMarkers(body: string): {
  body: string
  mode: 'single' | 'workflow' | null
  thinking: ReasoningMode | null
  project: string | null
  icon: string | null
  name: string | null
  files: string[]
  dirs: string[]
} {
  const lines = body.split('\n')
  let mode: 'single' | 'workflow' | null = null
  let thinking: ReasoningMode | null = null
  let project: string | null = null
  let icon: string | null = null
  let name: string | null = null
  const files: string[] = []
  const dirs: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i].trim()
    if (line === '') {
      i++
      continue
    }
    const m = line.match(MODE_MARKER_RE)
    if (m) {
      mode = m[1].toLowerCase() as 'single' | 'workflow'
      i++
      continue
    }
    const t = line.match(THINKING_MARKER_RE)
    if (t) {
      thinking = t[1].toLowerCase() as ReasoningMode
      i++
      continue
    }
    const p = line.match(PROJECT_MARKER_RE)
    if (p) {
      project = p[1]
      i++
      continue
    }
    const ic = line.match(ICON_MARKER_RE)
    if (ic) {
      icon = ic[1]
      i++
      continue
    }
    const nm = line.match(NAME_MARKER_RE)
    if (nm) {
      name = nm[1]
      i++
      continue
    }
    const f = line.match(FILE_MARKER_RE)
    if (f) {
      files.push(f[1])
      i++
      continue
    }
    const d = line.match(DIR_MARKER_RE)
    if (d) {
      dirs.push(d[1])
      i++
      continue
    }
    break
  }
  return {
    body: lines.slice(i).join('\n').trim(),
    mode,
    thinking,
    project,
    icon,
    name,
    files,
    dirs
  }
}

/**
 * Every file path heartbeat.md still names, across ACTIVE and switched-off
 * automations alike. parseHeartbeat can't serve this — it strips HTML comments
 * wholesale, so a disabled automation's attachments would read as unreferenced
 * and be swept the moment someone toggled it off.
 */
export function referencedAutomationFiles(raw: string): string[] {
  return parseHeartbeatBlocks(raw).flatMap((b) => splitMarkers(b.block).files)
}

/** Back-compat shim over {@link splitMarkers} for mode-only callers. */
export function splitModeMarker(body: string): {
  body: string
  mode: 'single' | 'workflow' | null
} {
  const { body: rest, mode } = splitMarkers(body)
  return { body: rest, mode }
}

function collectBody(lines: string[], startIndex: number): string {
  const bodyLines: string[] = []
  for (let j = startIndex; j < lines.length; j++) {
    if (/^##\s+/.test(lines[j])) break
    if (/^---+\s*$/.test(lines[j])) continue
    bodyLines.push(lines[j])
  }
  return bodyLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function matchSchedule(
  text: string
): { kind: ScheduleKind; cron: string | null; runAt?: number } | null {
  // A friendly form whose built cron is out of range (e.g. "Every (0m)" →
  // "*/0 * * * *", "Daily (99:99)") must be REJECTED here, not accepted and
  // then silently dropped when cron.schedule throws on the next reload —
  // otherwise the model is told a "ghost" job is scheduled when it never fires.
  // Validating the built expression against the same node-cron the scheduler
  // uses keeps previewSchedule honest. Returns null on an invalid range.
  const withCron = (
    kind: ScheduleKind,
    expr: string
  ): { kind: ScheduleKind; cron: string } | null => {
    const parts = splitCron(expr)
    return parts.length > 0 && parts.every((p) => cron.validate(p)) ? { kind, cron: expr } : null
  }

  // Startup — no cron, runs once on init
  if (STARTUP_RE.test(text)) {
    return { kind: 'startup', cron: null }
  }

  // Once (YYYY-MM-DD HH:MM) — fires a single time, then self-deletes. The local
  // wall-clock time is resolved to an absolute epoch; an out-of-range date/time
  // (e.g. month 13, 25:99) is rejected by checking the constructed Date's parts
  // round-trip, mirroring the range guard on the recurring forms.
  const once = ONCE_RE.exec(text)
  if (once) {
    const y = Number(once[1])
    const mo = Number(once[2])
    const d = Number(once[3])
    const hh = Number(once[4])
    const mm = Number(once[5])
    const dt = new Date(y, mo - 1, d, hh, mm, 0, 0)
    if (
      dt.getFullYear() !== y ||
      dt.getMonth() !== mo - 1 ||
      dt.getDate() !== d ||
      dt.getHours() !== hh ||
      dt.getMinutes() !== mm
    ) {
      return null
    }
    return { kind: 'once', cron: null, runAt: dt.getTime() }
  }

  // Every (Nm) or Every (Nh)
  const every = EVERY_RE.exec(text)
  if (every) {
    const n = Number(every[1])
    const unit = every[2].toLowerCase()
    return unit === 'm' ? withCron('every', `*/${n} * * * *`) : withCron('every', `0 */${n} * * *`)
  }

  // Hourly (:MM) or Hourly (MM)
  const hourly = HOURLY_RE.exec(text)
  if (hourly) {
    const mm = Number(hourly[1])
    return withCron('hourly', `${mm} * * * *`)
  }

  // Daily (HH:MM[, HH:MM…]) or Nightly (…) — both parse as 'daily'
  const daily = DAILY_NIGHTLY_RE.exec(text)
  if (daily) {
    return withCron('daily', timesToCron(parseTimeList(daily[1]), '*', '*'))
  }

  // Weekday (HH:MM[, HH:MM…])
  const weekday = WEEKDAY_RE.exec(text)
  if (weekday) {
    return withCron('weekday', timesToCron(parseTimeList(weekday[1]), '*', '1-5'))
  }

  // Weekly (Day[, Day…] HH:MM[, HH:MM…])
  const weekly = WEEKLY_RE.exec(text)
  if (weekly) {
    const days = parseDayList(weekly[1])
    return withCron('weekly', timesToCron(parseTimeList(weekly[2]), '*', days.join(',')))
  }

  // Monthly (DD[, DD…] HH:MM[, HH:MM…])
  const monthly = MONTHLY_RE.exec(text)
  if (monthly) {
    const doms = parseNumberList(monthly[1])
    return withCron('monthly', timesToCron(parseTimeList(monthly[2]), doms.join(','), '*'))
  }

  // Cron (raw expression — or several, joined by ";")
  const cronMatch = CRON_RE.exec(text)
  if (cronMatch) {
    const parts = splitCron(cronMatch[1])
    if (parts.length > 0 && parts.every((p) => cron.validate(p))) {
      return { kind: 'cron', cron: parts.join(CRON_JOIN) }
    }
    return null
  }

  return null
}

/**
 * Every valid schedule heading form, in one place. Shared by previewSchedule's
 * error message and the automations capability's docs so the syntax can never
 * drift between what the engine accepts and what the agent is told to write.
 */
export const SCHEDULE_SYNTAX_HELP =
  'Valid forms (the text inside the ## heading): one-time → "Once (2026-06-27 14:30)" ' +
  '(runs once then deletes itself); recurring → "Startup" · "Every (5m)" / "Every (2h)" · ' +
  '"Hourly (30)" · "Daily (08:00)" or "Nightly (23:00)" · "Weekday (09:00)" · ' +
  '"Weekly (Monday 09:30)" · "Monthly (1 09:00)" · "Cron (0 9 * * 1,3,5)". ' +
  'Several times a day/week/month = a comma list in the same heading: ' +
  '"Daily (08:00, 14:00, 20:00)" · "Weekday (09:00, 17:00)" · ' +
  '"Weekly (Monday, Wednesday, Friday 09:00)" · "Monthly (1, 15 09:00)" ' +
  '(days and times can both be lists; every listed day runs at every listed time).'

/**
 * Validate a proposed schedule heading exactly the way the scheduler will
 * parse it (single source of truth — wraps matchSchedule), and describe it in
 * plain English. The automations capability calls this before writing the file
 * so a malformed schedule is rejected with help, not silently dropped on the
 * next reload.
 */
export function previewSchedule(heading: string): SchedulePreview {
  const text = heading.trim().replace(/^#+\s*/, '')
  if (!text) return { ok: false, error: `Empty schedule. ${SCHEDULE_SYNTAX_HELP}` }
  const matched = matchSchedule(text)
  if (!matched) {
    return { ok: false, error: `"${heading}" is not a valid schedule. ${SCHEDULE_SYNTAX_HELP}` }
  }
  return {
    ok: true,
    kind: matched.kind,
    cron: matched.cron,
    runAt: matched.runAt ?? null,
    human: humanizeSchedule(text, matched.kind)
  }
}

function pad2(s: string | number): string {
  return String(Number(s)).padStart(2, '0')
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** "a", "a and b", "a, b and c". */
function joinAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** A time list as written → "08:00, 14:00 and 20:00" (sorted, de-duplicated). */
function humanTimes(list: string): string {
  return joinAnd(parseTimeList(list).map((t) => `${pad2(t.hh)}:${pad2(t.mm)}`))
}

function humanizeSchedule(text: string, kind: ScheduleKind): string {
  switch (kind) {
    case 'startup':
      return 'once, immediately when Wolffish starts'
    case 'once': {
      const m = ONCE_RE.exec(text)
      return m
        ? `once on ${m[1]}-${pad2(m[2])}-${pad2(m[3])} at ${pad2(m[4])}:${m[5]} (then it deletes itself)`
        : 'once at a set time'
    }
    case 'every': {
      const m = EVERY_RE.exec(text)
      if (!m) return 'on a repeating interval'
      const n = Number(m[1])
      const unit = m[2].toLowerCase()
      return unit === 'm'
        ? `every ${n} minute${n === 1 ? '' : 's'}`
        : `every ${n} hour${n === 1 ? '' : 's'}`
    }
    case 'hourly': {
      const m = HOURLY_RE.exec(text)
      return m ? `every hour at :${pad2(m[1])}` : 'every hour'
    }
    case 'daily': {
      const m = DAILY_NIGHTLY_RE.exec(text)
      return m ? `every day at ${humanTimes(m[1])}` : 'every day'
    }
    case 'weekday': {
      const m = WEEKDAY_RE.exec(text)
      return m ? `every weekday (Mon–Fri) at ${humanTimes(m[1])}` : 'every weekday'
    }
    case 'weekly': {
      const m = WEEKLY_RE.exec(text)
      if (!m) return 'once a week'
      const days = parseDayList(m[1]).map((d) => DAY_NAMES[d])
      return `every ${joinAnd(days)} at ${humanTimes(m[2])}`
    }
    case 'monthly': {
      const m = MONTHLY_RE.exec(text)
      if (!m) return 'once a month'
      const days = parseNumberList(m[1])
      return `on day${days.length > 1 ? 's' : ''} ${joinAnd(days.map(String))} of each month at ${humanTimes(m[2])}`
    }
    case 'cron': {
      const m = CRON_RE.exec(text)
      return m ? `on cron schedule "${splitCron(m[1]).join(CRON_JOIN)}"` : 'on a cron schedule'
    }
    default:
      return ''
  }
}

// ── Cron occurrence math (downtime catch-up, next-run display) ────────

/** One 5-field cron field expanded to its values: `*`, `a`, `a-b`, `*\/n`, lists. */
function cronFieldValues(field: string, min: number, max: number): number[] | null {
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
 * Next fire of a job's cron in local time, or null when it can't be
 * computed. Full 5-field support (lists, ranges, steps, the standard
 * dom-OR-dow rule, a 4-year day scan); a ";"-joined multi-expression yields
 * the earliest of its parts. The renderer and the phone carry a copy of this
 * scanner for unsaved drafts — keep them in step.
 */
export function nextCronMs(expr: string, nowMs: number): number | null {
  const parts = splitCron(expr)
  if (parts.length > 1) {
    const nexts = parts.map((p) => nextCronMs(p, nowMs)).filter((n): n is number => n !== null)
    return nexts.length > 0 ? Math.min(...nexts) : null
  }
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const minutes = cronFieldValues(fields[0], 0, 59)
  const hours = cronFieldValues(fields[1], 0, 23)
  const doms = cronFieldValues(fields[2], 1, 31)
  const months = cronFieldValues(fields[3], 1, 12)
  const dowsRaw = cronFieldValues(fields[4], 0, 7)
  if (!minutes || !hours || !doms || !months || !dowsRaw) return null
  const dows = new Set(dowsRaw.map((d) => d % 7))
  const domAny = fields[2] === '*'
  const dowAny = fields[4] === '*'
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
 * The most recent time the 5-field cron expression fired at or before `now`,
 * scanning back minute-by-minute up to `maxBackMs`. Returns its epoch ms, or
 * null if it didn't fire in that window. Same field semantics as node-cron, so
 * catch-up agrees with the live scheduler.
 */
export function mostRecentCronOccurrence(
  cronStr: string,
  now: number,
  maxBackMs: number
): number | null {
  const start = new Date(now)
  start.setSeconds(0, 0)
  const minutes = Math.ceil(maxBackMs / 60000) + 1
  for (let i = 0; i <= minutes; i++) {
    const d = new Date(start.getTime() - i * 60000)
    if (cronMatches(cronStr, d)) return d.getTime()
  }
  return null
}

export function cronMatches(cronStr: string, d: Date): boolean {
  // A ";"-joined multi-expression matches when any part does.
  const parts = splitCron(cronStr)
  if (parts.length > 1) return parts.some((p) => cronMatches(p, d))
  const f = cronStr.trim().split(/\s+/)
  if (f.length !== 5) return false
  const dow = d.getDay() // 0 = Sunday
  return (
    cronFieldMatch(f[0], d.getMinutes(), 0, 59) &&
    cronFieldMatch(f[1], d.getHours(), 0, 23) &&
    cronFieldMatch(f[2], d.getDate(), 1, 31) &&
    cronFieldMatch(f[3], d.getMonth() + 1, 1, 12) &&
    // cron allows both 0 and 7 for Sunday
    (cronFieldMatch(f[4], dow, 0, 7) || (dow === 0 && cronFieldMatch(f[4], 7, 0, 7)))
  )
}

/** Match one cron field: `*`, `a`, `a-b`, `a,b`, `*\/n`, `a-b/n`, and lists. */
function cronFieldMatch(field: string, value: number, min: number, max: number): boolean {
  for (const part of field.split(',')) {
    if (part === '*' || part === '*/1') return true
    let range = part
    let step = 1
    const slash = part.indexOf('/')
    if (slash >= 0) {
      step = parseInt(part.slice(slash + 1), 10)
      range = part.slice(0, slash)
      if (!Number.isFinite(step) || step < 1) continue
    }
    let lo: number
    let hi: number
    if (range === '*') {
      lo = min
      hi = max
    } else if (range.includes('-')) {
      const [a, b] = range.split('-')
      lo = parseInt(a, 10)
      hi = parseInt(b, 10)
    } else {
      lo = parseInt(range, 10)
      hi = lo
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue
    if (value < lo || value > hi) continue
    if ((value - lo) % step === 0) return true
  }
  return false
}

// ── Heartbeat file editing (one-time job self-deletion) ───────────────

/** Collapse 3+ newlines to 2, but only OUTSIDE HTML comments (keep examples). */
function tidyOutsideComments(raw: string): string {
  const re = /<!--[\s\S]*?-->/g
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    out += raw.slice(last, m.index).replace(/\n{3,}/g, '\n\n')
    out += m[0]
    last = m.index + m[0].length
  }
  out += raw.slice(last).replace(/\n{3,}/g, '\n\n')
  return out
}

/**
 * Remove the active `## <label>` block (heading + body, up to the next heading,
 * comment, or EOF) from a heartbeat.md, leaving the commented examples and
 * surrounding prose intact. Used to self-delete a fired one-time job. Returns
 * the original string unchanged when the label isn't found.
 */
function stripHeartbeatHeading(raw: string, label: string): string {
  const ranges: Array<[number, number]> = []
  const re = /<!--[\s\S]*?-->/g
  let cm: RegExpExecArray | null
  while ((cm = re.exec(raw)) !== null) ranges.push([cm.index, cm.index + cm[0].length])
  const inComment = (pos: number): boolean => ranges.some(([s, e]) => pos >= s && pos < e)

  const heads: Array<{ start: number; lineEnd: number; isTarget: boolean }> = []
  let offset = 0
  for (const line of raw.split('\n')) {
    const hm = /^##\s+(.+?)\s*$/.exec(line)
    if (hm && !inComment(offset)) {
      heads.push({ start: offset, lineEnd: offset + line.length + 1, isTarget: hm[1] === label })
    }
    offset += line.length + 1
  }
  for (let i = 0; i < heads.length; i++) {
    if (!heads[i].isTarget) continue
    let end = i + 1 < heads.length ? heads[i + 1].start : raw.length
    for (const [s] of ranges) if (s >= heads[i].lineEnd && s < end) end = s
    return tidyOutsideComments(raw.slice(0, heads[i].start) + raw.slice(end))
  }
  return raw
}

// ── Compaction helpers ────────────────────────────────────────────────

function parsePromotionSections(response: string): Map<KnowledgeFile, string[]> {
  const result = new Map<KnowledgeFile, string[]>()
  const lines = response.split(/\r?\n/)
  let current: KnowledgeFile | null = null
  for (const raw of lines) {
    const line = raw.trim()
    const header = matchKnowledgeHeader(line)
    if (header) {
      current = header
      if (!result.has(current)) result.set(current, [])
      continue
    }
    if (!current) continue
    if (line.length === 0) continue
    if (line.startsWith('-') || line.startsWith('*')) {
      const fact = line.replace(/^[-*]\s*/, '').trim()
      if (fact.length > 0 && !/^nothing to promote$/i.test(fact)) {
        result.get(current)!.push(fact)
      }
    }
  }
  return result
}

function matchKnowledgeHeader(line: string): KnowledgeFile | null {
  const m = /^#{1,4}\s+(.+?)\s*$/.exec(line)
  if (!m) return null
  const stripped = m[1].toLowerCase().replace(/\.md$/, '').replace(/[`*_]/g, '').trim()
  for (const file of KNOWLEDGE_FILES) {
    if (stripped === file) return file
  }
  return null
}

function countEpisodeEntries(content: string): number {
  let count = 0
  for (const line of content.split(/\r?\n/)) {
    if (/^##\s+\d{2}:\d{2}\s+/.test(line)) count += 1
  }
  return count
}

function summaryHeader(date: string, body: string): string {
  return `## Compaction for ${date}\n\n${body.trim()}`
}

function weekKey(dateStr: string): string {
  const d = parseDateString(dateStr)
  if (!d) return formatWeekKey(new Date())
  return formatWeekKey(d)
}

function parseDateString(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

function formatWeekKey(d: Date): string {
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = target.getUTCDay() || 7
  target.setUTCDate(target.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1))
  const weekNum = Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${target.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`
}

function formatDate(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
