import {
  conversationDirName,
  loadConversation,
  type ConversationFile,
  type ConversationMessage
} from '@main/conversations'
import { diskWriter } from '@main/io/diskWriter'
import type { Segment } from '@main/runtime/broca'
import { runDetached } from '@main/runtime/corpus'
import { workspaceRoot } from '@main/workspace/root'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Per-conversation diagnostic export — the "something went wrong here, send it
 * to the developer" button.
 *
 * Deterministic by design: a fixed list of collectors runs in a fixed order,
 * every one of them best-effort (a missing or unreadable source is a warning,
 * never a failure), and the result is a single zip under
 * `workspace/diagnostics/`. Nothing here mutates app state — it only reads,
 * with ONE exception: the archive it writes.
 *
 * What goes in is everything a developer needs to reconstruct the failure
 * without the user's machine: the conversation itself, the corpus event log
 * (both the full days it spans AND a slice filtered to this conversation's
 * turn scope), the task transcripts those turns spawned, the memory the agent
 * was working from, the prompts it actually built, and the redacted config.
 *
 * What stays out: secrets (every credential-shaped config value is replaced by
 * a length marker, never the value) and media bytes (attachments are listed in
 * a manifest; only small text-ish ones are copied). Both are deliberate — the
 * bundle is meant to be forwardable.
 */

/** Ordered collection stages. The overlay renders one localized line per key. */
export const DIAGNOSTIC_STEPS = [
  'conversation',
  'logs',
  'tasks',
  'memory',
  'context',
  'settings',
  'attachments',
  'opinion',
  'archive'
] as const

export type DiagnosticStep = (typeof DIAGNOSTIC_STEPS)[number]

export type DiagnosticProgress = {
  conversationId: string
  step: DiagnosticStep
  /** 1-based position of `step` in DIAGNOSTIC_STEPS. */
  index: number
  total: number
  /** Files gathered so far — the count shown next to the bar. */
  files: number
}

/** Why the model opinion isn't in the bundle (absent when it is). */
export type OpinionSkipReason = 'no-model' | 'local-only' | 'failed' | 'empty'

export type DiagnosticGroup = { key: string; count: number }

export type DiagnosticResult = {
  ok: boolean
  error?: string
  conversationId: string
  conversationTitle: string
  /** Archive basename, e.g. `wolffish-diagnostics-2026-07-25_00-16-04.zip`. */
  fileName: string
  /** Absolute path of the saved archive. */
  zipPath: string
  /** Path relative to the workspace root — `diagnostics/<fileName>`. */
  relativePath: string
  sizeBytes: number
  fileCount: number
  durationMs: number
  /** True when a model wrote an opinion into the bundle. */
  modelOpinion: boolean
  opinionSkipped?: OpinionSkipReason
  groups: DiagnosticGroup[]
  warnings: string[]
}

/**
 * The minimal LLM surface the optional opinion needs — the same shape the
 * titler and summarizer take (system prompt + one user turn, non-streaming,
 * no tools). Satisfied by `Thalamus.diagnose`.
 */
export interface DiagnosticLLM {
  diagnose(
    prompt: string,
    systemPrompt: string,
    signal?: AbortSignal
  ): Promise<{ text: string; provider: string; model: string }>
}

export type DiagnosticEnv = {
  appVersion: string
  packaged: boolean
  provider: string | null
  model: string | null
  chatMode: string | null
  locale: string | null
}

export type DiagnosticOptions = {
  conversationId: string
  env: DiagnosticEnv
  /** Omit (or pass null) to skip the model opinion entirely. */
  llm?: DiagnosticLLM | null
  /** Maps a called tool back to the capability that owns it, so its SKILL.md rides along. */
  toolCapability?: (toolName: string) => string | undefined
  /**
   * Installed capabilities. `dir` is the absolute capability folder (empty for
   * in-process ones, which have no SKILL.md on disk) — taken from the live
   * registry rather than reconstructed, because official capabilities live in
   * DOT-prefixed folders and user ones don't.
   */
  capabilities?: Array<{ name: string; dir: string }>
  onProgress?: (progress: DiagnosticProgress) => void
  signal?: AbortSignal
}

/** Per-file ceiling. A pathological log can't turn the bundle into a download problem. */
const MAX_FILE_BYTES = 25 * 1024 * 1024
/** Attachment copies are text-only and small — the manifest covers the rest. */
const MAX_ATTACHMENT_COPY_BYTES = 256 * 1024
const COPYABLE_ATTACHMENT_EXT = new Set([
  '.txt',
  '.md',
  '.json',
  '.csv',
  '.tsv',
  '.log',
  '.yaml',
  '.yml',
  '.xml',
  '.html',
  '.srt',
  '.vtt'
])
/** Prompt snapshots outside the conversation's window, kept as recent-context fallback. */
const FALLBACK_SNAPSHOTS = 5
/** Widest span of daily logs to pull, however old the conversation is. */
const MAX_LOG_DAYS = 30
/** Input ceiling for the opinion call — lean by construction, never an exhaustive replay. */
const OPINION_MAX_CHARS = 60_000
/**
 * Wall-clock ceiling on that call. The opinion is the one stage that waits on a
 * remote service, and it is optional by construction — so a provider that stalls
 * costs the bundle a section, not the whole export. Without this the overlay
 * (which cannot be dismissed while collecting) is held hostage by a hung socket.
 */
const OPINION_TIMEOUT_MS = 90_000
/** Per-message excerpt inside that transcript. */
const OPINION_PER_MESSAGE_CHARS = 1_500

type ZipEntry = { name: string; data: string | Buffer }

/**
 * Accumulates the bundle in memory. Entries are added under numbered folders
 * so the archive reads in the order a developer would open it.
 */
class Bundle {
  readonly entries: ZipEntry[] = []
  readonly warnings: string[] = []
  private readonly counts = new Map<string, number>()

  add(group: string, name: string, data: string | Buffer): void {
    this.entries.push({ name, data })
    this.counts.set(group, (this.counts.get(group) ?? 0) + 1)
  }

  warn(message: string): void {
    // Bounded: a broken directory shouldn't produce thousands of lines.
    if (this.warnings.length < 50) this.warnings.push(message)
  }

  /** Copy one source file in, or record why it couldn't be copied. */
  async copy(group: string, absPath: string, name: string): Promise<boolean> {
    try {
      const stat = await fs.stat(absPath)
      if (!stat.isFile()) return false
      if (stat.size > MAX_FILE_BYTES) {
        this.warn(`skipped ${name} — ${formatBytes(stat.size)} exceeds the per-file limit`)
        return false
      }
      this.add(group, name, await fs.readFile(absPath))
      return true
    } catch {
      return false
    }
  }

  groups(): DiagnosticGroup[] {
    return [...this.counts.entries()].map(([key, count]) => ({ key, count }))
  }

  count(group: string): number {
    return this.counts.get(group) ?? 0
  }
}

export function diagnosticsDir(): string {
  return path.join(workspaceRoot(), 'diagnostics')
}

/**
 * Collect everything relevant to one conversation and write it to a zip under
 * `workspace/diagnostics/`. Resolves with `ok: false` and a message rather
 * than throwing — the overlay renders the failure instead of vanishing.
 */
export async function exportConversationDiagnostics(
  options: DiagnosticOptions
): Promise<DiagnosticResult> {
  const startedAt = Date.now()
  const { conversationId, env } = options
  const root = workspaceRoot()
  const bundle = new Bundle()
  let step = 0

  const progress = (name: DiagnosticStep): void => {
    step += 1
    options.onProgress?.({
      conversationId,
      step: name,
      index: step,
      total: DIAGNOSTIC_STEPS.length,
      files: bundle.entries.length
    })
  }

  const fail = (error: string): DiagnosticResult => ({
    ok: false,
    error,
    conversationId,
    conversationTitle: '',
    fileName: '',
    zipPath: '',
    relativePath: '',
    sizeBytes: 0,
    fileCount: 0,
    durationMs: Date.now() - startedAt,
    modelOpinion: false,
    groups: [],
    warnings: bundle.warnings
  })

  // 1. The conversation itself — the spine everything else is filtered against.
  progress('conversation')
  const conversation = await loadConversation(conversationId).catch(() => null)
  if (!conversation) {
    return fail(`conversation ${conversationId} could not be read`)
  }
  const convFile = path.join(
    root,
    'brain',
    'conversations',
    `${conversationDirName(conversationId)}.json`
  )
  if (!(await bundle.copy('conversation', convFile, '01_conversation/conversation.json'))) {
    // The file may not exist yet (a live in-app conversation persists at end of
    // turn) — serialize what's in memory rather than shipping nothing.
    bundle.add(
      'conversation',
      '01_conversation/conversation.json',
      JSON.stringify(conversation, null, 2)
    )
  }
  const metrics = computeMetrics(conversation)
  bundle.add(
    'conversation',
    '01_conversation/transcript.md',
    renderTranscript(conversation, conversationId)
  )
  const span = conversationSpan(conversation)
  const dates = datesInSpan(span)

  // 2. Logs — the full daily corpus/app logs the conversation spans, plus a
  //    slice of the corpus filtered to this conversation's own turn scope.
  progress('logs')
  const corpusDir = path.join(root, 'brain', 'corpus')
  const corpusNames = await listDir(corpusDir)
  const convBlocks: string[] = []
  for (const name of corpusNames.filter((n) =>
    matchesDate(n, dates, /^(\d{4}-\d{2}-\d{2})\.log\.md$/)
  )) {
    const abs = path.join(corpusDir, name)
    await bundle.copy('logs', abs, `02_logs/corpus/${name}`)
    const raw = await readTextFile(abs)
    if (raw) convBlocks.push(...filterCorpusBlocks(raw, conversationId))
  }
  if (convBlocks.length > 0) {
    bundle.add(
      'logs',
      '02_logs/corpus-this-conversation.md',
      `# Corpus events for conversation ${conversationId}\n\n` +
        `Every logged event whose turn scope names this conversation, in order.\n\n` +
        convBlocks.join('\n')
    )
  } else {
    bundle.warn('no corpus events are attributed to this conversation (log retention is 7 days)')
  }

  const appLogsDir = path.join(root, 'logs')
  for (const name of (await listDir(appLogsDir)).filter((n) =>
    matchesDate(n, dates, /^(\d{4}-\d{2}-\d{2})\.log$/)
  )) {
    await bundle.copy('logs', path.join(appLogsDir, name), `02_logs/app/${name}`)
  }

  const extensionLogsDir = path.join(root, 'logs', 'extension')
  for (const name of (await listDir(extensionLogsDir)).filter((n) =>
    matchesDate(n, dates, /^(\d{4}-\d{2}-\d{2})\./)
  )) {
    await bundle.copy('logs', path.join(extensionLogsDir, name), `02_logs/extension/${name}`)
  }

  // The token/cost ledgers for those days, plus the per-provider running
  // totals. The conversation's own stats say what THIS chat spent; these say
  // what else the machine was doing at the time, which is how you tell a
  // conversation-level problem from a provider- or quota-level one.
  const usageDailyDir = path.join(root, 'usage', 'daily')
  for (const name of (await listDir(usageDailyDir)).filter((n) =>
    matchesDate(n, dates, /^(\d{4}-\d{2}-\d{2})\.md$/)
  )) {
    await bundle.copy('logs', path.join(usageDailyDir, name), `02_logs/usage/daily/${name}`)
  }
  const usageProvidersDir = path.join(root, 'usage', 'providers')
  for (const name of (await listDir(usageProvidersDir)).filter((n) => n.endsWith('.md'))) {
    await bundle.copy('logs', path.join(usageProvidersDir, name), `02_logs/usage/providers/${name}`)
  }

  // 3. Task transcripts — the tool-by-tool record of what the agent ran. Task
  //    ids come from the conversation's own corpus slice, so a bundle never
  //    picks up another conversation's runs.
  progress('tasks')
  const taskIds = extractTaskIds(convBlocks)
  const tasksDir = path.join(root, 'brain', 'motor', 'tasks')
  const taskRollup: TaskRollup = { tasks: 0, steps: 0, failures: [] }
  for (const id of taskIds) {
    const abs = path.join(tasksDir, `TASK-${id}.md`)
    if (!(await bundle.copy('tasks', abs, `03_tasks/TASK-${id}.md`))) continue
    const raw = await readTextFile(abs)
    if (!raw) continue
    const parsed = parseTaskSteps(id, raw)
    taskRollup.tasks += 1
    taskRollup.steps += parsed.steps
    taskRollup.failures.push(...parsed.failures)
  }
  if (taskIds.length > 0 && bundle.count('tasks') === 0) {
    bundle.warn(`${taskIds.length} task id(s) referenced but no transcript files were found`)
  }

  // The failures, alone, in full, with their arguments — the first file anyone
  // diagnosing this should open. They exist in conversation.json too, but
  // buried under megabytes of successful turns. Written here rather than with
  // the rest of 01_conversation because it also carries the failed task steps
  // just collected — a worker's failure exists nowhere in the conversation's
  // own segments.
  bundle.add(
    'conversation',
    '01_conversation/failures.md',
    renderFailures(metrics, conversation, taskRollup)
  )

  // 4. Memory the agent was reading from during those days.
  progress('memory')
  const episodesDir = path.join(root, 'brain', 'hippocampus', 'episodes')
  for (const name of (await listDir(episodesDir)).filter((n) =>
    matchesDate(n, dates, /^(\d{4}-\d{2}-\d{2})\.md$/)
  )) {
    await bundle.copy('memory', path.join(episodesDir, name), `04_memory/episodes/${name}`)
  }
  const consolidatedDir = path.join(root, 'brain', 'hippocampus', 'consolidated')
  for (const name of (await listDir(consolidatedDir)).sort().slice(-2)) {
    await bundle.copy('memory', path.join(consolidatedDir, name), `04_memory/consolidated/${name}`)
  }
  const knowledgeDir = path.join(root, 'brain', 'hippocampus', 'knowledge')
  for (const name of (await listDir(knowledgeDir)).filter((n) => n.endsWith('.md'))) {
    await bundle.copy('memory', path.join(knowledgeDir, name), `04_memory/knowledge/${name}`)
  }

  // 5. Context — the instructions and prompts that shaped every turn.
  progress('context')
  const contextFiles: Array<[string, string]> = [
    ['brain/prefrontal/agents.core.md', '05_context/agents.core.md'],
    ['brain/prefrontal/agents.md', '05_context/agents.md'],
    ['brain/identity/soul.md', '05_context/soul.md'],
    ['brain/identity/user.md', '05_context/user.md'],
    ['brain/identity/workflow.md', '05_context/workflow.md'],
    ['brain/identity/workflow-agent.md', '05_context/workflow-agent.md'],
    ['brain/brainstem/heartbeat.md', '05_context/heartbeat.md']
  ]
  for (const [rel, name] of contextFiles) {
    await bundle.copy('context', path.join(root, rel), name)
  }

  const debugDir = path.join(root, 'brain', 'prefrontal', '.debug')
  const snapshots = (await listDir(debugDir)).filter((n) => n.endsWith('.md')).sort()
  const inWindow = snapshots.filter((n) => snapshotInSpan(n, span))
  for (const name of inWindow.length > 0 ? inWindow : snapshots.slice(-FALLBACK_SNAPSHOTS)) {
    await bundle.copy('context', path.join(debugDir, name), `05_context/prompt-snapshots/${name}`)
  }
  if (inWindow.length === 0 && snapshots.length > 0) {
    bundle.warn(
      'no prompt snapshot falls inside this conversation — the most recent ones are included instead'
    )
  }

  // The SKILL.md of every capability this conversation actually called: the
  // tool contract the model was working against is usually where a "why did it
  // do that" question ends up.
  const toolNames = calledToolNames(conversation)
  const capabilities = new Set<string>()
  for (const tool of toolNames) {
    const cap = options.toolCapability?.(tool)
    if (cap) capabilities.add(cap)
  }
  const capabilityDirs = new Map(
    (options.capabilities ?? []).filter((c) => c.dir).map((c) => [c.name, c.dir])
  )
  for (const cap of capabilities) {
    const dir = capabilityDirs.get(cap)
    if (!dir) continue // in-process capability — no SKILL.md on disk
    await bundle.copy(
      'context',
      path.join(dir, 'SKILL.md'),
      `05_context/capabilities/${cap}.SKILL.md`
    )
  }

  // 6. Settings — redacted config, compaction bookkeeping, the bound project.
  progress('settings')
  const configRaw = await readTextFile(path.join(root, 'config.json'))
  if (configRaw) {
    try {
      bundle.add(
        'settings',
        '06_settings/config.redacted.json',
        JSON.stringify(redactSecrets(JSON.parse(configRaw)), null, 2)
      )
    } catch {
      bundle.warn('config.json could not be parsed — omitted rather than shipped unredacted')
    }
  }
  await bundle.copy(
    'settings',
    path.join(root, 'brain', 'brainstem', 'compaction-meta.json'),
    '06_settings/compaction-meta.json'
  )
  if (conversation.projectId) {
    const project = await findProject(root, conversation.projectId)
    if (project) {
      bundle.add('settings', '06_settings/project.json', JSON.stringify(project, null, 2))
    }
  }

  // 7. Attachments — names, sizes and types always; bytes only for small text.
  progress('attachments')
  const attachmentReport = await collectAttachments(bundle, root, conversationId, conversation)

  // 8. The optional model opinion. Cloud-only, one call, no tools, no
  //    conversation created — the same side-call shape as the titler.
  progress('opinion')
  let opinionSkipped: OpinionSkipReason | undefined
  let modelOpinion = false
  if (!options.llm) {
    opinionSkipped = env.provider ? 'local-only' : 'no-model'
  } else {
    const opinion = await runOpinion(options.llm, {
      conversation,
      conversationId,
      env,
      metrics,
      taskRollup,
      corpusBlocks: convBlocks,
      signal: opinionSignal(options.signal)
    })
    if (opinion.text) {
      bundle.add('opinion', '08_analysis/model-opinion.md', opinion.text)
      modelOpinion = true
    } else {
      opinionSkipped = opinion.reason
      bundle.warn(
        opinion.reason === 'empty'
          ? 'the model returned an empty opinion — the bundle is complete without it'
          : 'the model opinion call failed — the bundle is complete without it'
      )
    }
  }

  // 9. README + manifest, then the archive itself.
  progress('archive')
  const environment = buildEnvironment(
    env,
    (options.capabilities ?? []).map((c) => c.name)
  )
  bundle.add('summary', '00_ENVIRONMENT.json', JSON.stringify(environment, null, 2))
  bundle.add(
    'summary',
    '00_METRICS.md',
    [
      `# Metrics — ${conversation.title || 'Untitled'}`,
      '',
      renderMetrics(metrics, taskRollup),
      '',
      '## Corpus event counts (this conversation only)',
      '',
      ...countCorpusEvents(convBlocks).map(([name, count]) => `- ${name}: ${count}`),
      '',
      "Token, cost and timing figures come from the conversation's own persisted stats.",
      'The daily ledgers in `02_logs/usage/` show what the rest of the machine spent',
      'over the same days.',
      ''
    ].join('\n')
  )
  bundle.add(
    'summary',
    '00_README.md',
    renderReadme({
      conversation,
      conversationId,
      environment,
      metrics,
      taskRollup,
      // +1 for the README this call is producing, which isn't in `entries` yet.
      entries: bundle.entries,
      extraRootFiles: 1,
      warnings: bundle.warnings,
      taskIds,
      capabilities: [...capabilities],
      attachmentReport,
      modelOpinion
    })
  )

  const stamp = fileStamp(new Date())
  const fileName = `wolffish-diagnostics-${conversationDirName(conversationId)}-${stamp}.zip`
  const zipPath = path.join(diagnosticsDir(), fileName)
  try {
    const JSZip = (await import('jszip')).default
    const zip = new JSZip()
    for (const entry of bundle.entries) zip.file(entry.name, entry.data)
    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    })
    await diskWriter.writeFileAtomic(zipPath, buffer)
    return {
      ok: true,
      conversationId,
      conversationTitle: conversation.title,
      fileName,
      zipPath,
      relativePath: `diagnostics/${fileName}`,
      sizeBytes: buffer.byteLength,
      fileCount: bundle.entries.length,
      durationMs: Date.now() - startedAt,
      modelOpinion,
      ...(opinionSkipped ? { opinionSkipped } : {}),
      groups: bundle.groups(),
      warnings: bundle.warnings
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}

/** Copy a finished archive to a user-chosen path. */
export async function copyDiagnosticArchive(from: string, to: string): Promise<void> {
  await fs.copyFile(from, to)
}

// ---------------------------------------------------------------------------
// collection helpers
// ---------------------------------------------------------------------------

async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir)
  } catch {
    return []
  }
}

async function readTextFile(absPath: string): Promise<string | null> {
  try {
    return await fs.readFile(absPath, 'utf8')
  } catch {
    return null
  }
}

type Span = { from: number; to: number }

/**
 * The wall-clock window the conversation covers. Widened by an hour on both
 * ends: the turn that failed writes its log lines slightly after the message
 * timestamp, and a conversation created just before midnight spills into the
 * next day's file.
 */
function conversationSpan(conversation: ConversationFile): Span {
  const stamps = [
    conversation.createdAt,
    conversation.updatedAt,
    ...conversation.messages.map((m) => m.timestamp)
  ].filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0)
  const now = Date.now()
  const from = stamps.length > 0 ? Math.min(...stamps) : now
  const to = stamps.length > 0 ? Math.max(...stamps) : now
  const HOUR = 60 * 60 * 1000
  return { from: from - HOUR, to: Math.min(now, to + HOUR) }
}

// ---------------------------------------------------------------------------
// metrics — the numbers a developer asks for first
// ---------------------------------------------------------------------------

type FailedCall = {
  index: number
  tool: string
  args: unknown
  status: string
  error: string
  output: string
  timestamp: number | null
  durationMs: number | null
}

type TaskStepFailure = {
  taskId: string
  step: number
  tool: string
  /** Inline JSON exactly as the task transcript recorded it — already one line. */
  args: string
  error: string
}

/**
 * What the copied task transcripts (`03_tasks/`) add up to. Kept OUT of
 * {@link Metrics} on purpose: metrics describe the conversation transcript, and
 * a turn's own task steps duplicate its segments — summing the two views would
 * double-count every conversation-level failure. A spawned worker's steps, by
 * contrast, exist ONLY here: workers never write into the conversation, which
 * is how a bundle used to report "FAILED: 0" over a failed worker step.
 */
type TaskRollup = {
  tasks: number
  steps: number
  failures: TaskStepFailure[]
}

type Metrics = {
  messages: number
  userMessages: number
  toolCalls: number
  failures: FailedCall[]
  /** Model(s) that ACTUALLY ran turns, most-used first — not the one selected today. */
  modelsUsed: Array<{ provider: string; model: string; calls: number }>
  stats: ConversationFile['stats']
  /** Tool wall-clock derived from toolTimings, since stats only totals API time. */
  slowestTools: Array<{ tool: string; ms: number }>
  toolMs: number
  /** Rolling-summary state — changes what the model actually saw. */
  summarized: { active: boolean; throughMessage: number | null }
  stopReasons: Record<string, number>
}

/**
 * Everything numeric the bundle can derive from the conversation alone. Pulled
 * out once because three consumers need it: the metrics file, the README's
 * at-a-glance block, and the model's prompt — which is the one that matters,
 * because "time, context, tokens" is exactly the frame a diagnosis needs and
 * the raw transcript never states any of it.
 */
function computeMetrics(conversation: ConversationFile): Metrics {
  const failures: FailedCall[] = []
  const models = new Map<string, { provider: string; model: string; calls: number }>()
  const toolDurations = new Map<string, number>()
  const stopReasons: Record<string, number> = {}
  let toolCalls = 0
  let toolMs = 0

  for (const [index, message] of conversation.messages.entries()) {
    const names = toolNamesById(message)
    const argsById = new Map<string, unknown>()
    for (const segment of message.segments ?? []) {
      if (segment.kind === 'tool_call') argsById.set(segment.toolCallId, segment.args)
    }
    for (const segment of message.segments ?? []) {
      if (segment.kind === 'active_model') {
        const key = `${segment.provider}/${segment.model}`
        const entry = models.get(key) ?? {
          provider: segment.provider,
          model: segment.model,
          calls: 0
        }
        entry.calls += 1
        models.set(key, entry)
      } else if (segment.kind === 'turn_end') {
        stopReasons[segment.stopReason] = (stopReasons[segment.stopReason] ?? 0) + 1
      } else if (segment.kind === 'tool_result') {
        toolCalls += 1
        const timing = message.toolTimings?.[segment.toolCallId]
        const durationMs =
          timing && timing.endedAt && timing.startedAt ? timing.endedAt - timing.startedAt : null
        const tool = names.get(segment.toolCallId) ?? '(unknown tool)'
        if (durationMs !== null) {
          toolMs += durationMs
          toolDurations.set(tool, Math.max(toolDurations.get(tool) ?? 0, durationMs))
        }
        if (segment.error || segment.status !== 'success') {
          failures.push({
            index: index + 1,
            tool,
            args: argsById.get(segment.toolCallId),
            status: segment.status,
            error: segment.error ?? '',
            output: segment.output,
            timestamp: message.timestamp ?? null,
            durationMs
          })
        }
      }
    }
  }

  return {
    messages: conversation.messages.length,
    userMessages: conversation.messages.filter((m) => m.role === 'user').length,
    toolCalls,
    failures,
    modelsUsed: [...models.values()].sort((a, b) => b.calls - a.calls),
    stats: conversation.stats ?? null,
    slowestTools: [...toolDurations.entries()]
      .map(([tool, ms]) => ({ tool, ms }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 10),
    toolMs,
    summarized: {
      active: !!conversation.summary,
      throughMessage: conversation.summarizedThroughMessage ?? null
    },
    stopReasons
  }
}

/** The metrics block, in the compact form both the file and the prompt use. */
function renderMetrics(metrics: Metrics, taskRollup: TaskRollup): string {
  const s = metrics.stats
  const lines: string[] = []
  lines.push(
    `- messages: ${metrics.messages} (${metrics.userMessages} from the user)`,
    `- tool calls: ${metrics.toolCalls}, of which FAILED: ${metrics.failures.length}`
  )
  if (taskRollup.tasks > 0) {
    // A separate count on purpose: a turn's own steps duplicate the tool calls
    // above, but a spawned worker's steps appear ONLY in this line.
    lines.push(
      `- task steps: ${taskRollup.steps} across ${taskRollup.tasks} task(s), ` +
        `of which FAILED: ${taskRollup.failures.length}`
    )
  }
  if (metrics.modelsUsed.length > 0) {
    lines.push(
      `- models that actually ran: ${metrics.modelsUsed
        .map((m) => `${m.model} (${m.provider}) ×${m.calls}`)
        .join(', ')}`
    )
  }
  if (s?.allTime) {
    const a = s.allTime
    lines.push(
      `- turns: ${a.turns}, API calls: ${a.apiCalls}`,
      `- wall clock: ${formatDuration(a.processingMs)} total, ${formatDuration(a.apiMs)} of it waiting on the model` +
        (metrics.toolMs > 0 ? `, ${formatDuration(metrics.toolMs)} in tools` : ''),
      `- tokens: ${a.inputTokens.toLocaleString()} in, ${a.outputTokens.toLocaleString()} out, ` +
        `${a.cacheReadTokens.toLocaleString()} cache read, ${a.cacheCreationTokens.toLocaleString()} cache write`,
      `- cost: $${a.cost.toFixed(4)}`
    )
  } else {
    lines.push('- no per-turn stats recorded on this conversation')
  }
  if (s?.meter) {
    const m = s.meter
    const pct = m.contextBudget > 0 ? Math.round((m.contextTokens / m.contextBudget) * 100) : 0
    lines.push(
      `- context at last turn: ${m.contextTokens.toLocaleString()} of ${m.contextBudget.toLocaleString()} tokens ` +
        `(${pct} percent)${m.compactionAt ? `, compaction triggers at ${m.compactionAt.toLocaleString()}` : ''}` +
        `${m.model ? ` — budgeted for ${m.model}` : ''}`
    )
  }
  if (s?.lastTurn) {
    const l = s.lastTurn
    lines.push(
      `- last turn: ${formatDuration(l.elapsedMs)} (${formatDuration(l.apiMs)} API), ` +
        `${l.apiCalls} API calls, ${l.toolCalls} tool calls, ` +
        `${l.inputTokens.toLocaleString()} in / ${l.outputTokens.toLocaleString()} out, $${l.cost.toFixed(4)}, ` +
        `on ${l.model ?? '?'} (${l.provider ?? '?'})`
    )
  }
  const stops = Object.entries(metrics.stopReasons)
  if (stops.length > 0) {
    lines.push(`- turn end reasons: ${stops.map(([k, v]) => `${k} ×${v}`).join(', ')}`)
  }
  if (metrics.summarized.active) {
    lines.push(
      `- ROLLING SUMMARY ACTIVE: messages before #${metrics.summarized.throughMessage ?? '?'} ` +
        `were replayed to the model as a summary, not verbatim`
    )
  }
  if (metrics.slowestTools.length > 0) {
    lines.push(
      `- slowest tools: ${metrics.slowestTools
        .slice(0, 5)
        .map((t) => `${t.tool} ${formatDuration(t.ms)}`)
        .join(', ')}`
    )
  }
  return lines.join('\n')
}

/**
 * Every failed tool call in full — arguments and untruncated error. The
 * conversation JSON has all of this, but a 2 MB file with seven failures in it
 * is not a report, and the whole point of the bundle is that the developer
 * doesn't have to go looking. Failed TASK steps ride along at the end for the
 * same reason: a worker's failure is in no conversation segment at all.
 */
function renderFailures(
  metrics: Metrics,
  conversation: ConversationFile,
  taskRollup: TaskRollup
): string {
  const lines: string[] = [
    `# Failed tool calls — ${metrics.failures.length}` +
      (taskRollup.failures.length > 0 ? ` (failed task steps: ${taskRollup.failures.length})` : ''),
    '',
    `Conversation: ${conversation.title || 'Untitled'}`,
    ''
  ]
  if (metrics.failures.length === 0 && taskRollup.failures.length === 0) {
    lines.push(
      '_No tool call in this conversation reported a failure._',
      '',
      'If something still went wrong, the fault is not a failing tool — look at',
      '`01_conversation/transcript.md` for wrong-but-successful calls, at the turn end',
      'reasons in `00_METRICS.md`, and at `02_logs/corpus-this-conversation.md`.',
      ''
    )
    return lines.join('\n')
  }
  if (metrics.failures.length === 0) {
    lines.push(
      '_No tool call in the conversation transcript reported a failure — the failures',
      'below happened inside task steps._',
      ''
    )
  }
  for (const [i, failure] of metrics.failures.entries()) {
    lines.push(
      `## ${i + 1}. \`${failure.tool}\` — ${failure.status}`,
      '',
      `- message: #${failure.index}${failure.timestamp ? ` at ${new Date(failure.timestamp).toISOString()}` : ''}`,
      ...(failure.durationMs !== null ? [`- ran for: ${formatDuration(failure.durationMs)}`] : []),
      '',
      '**Arguments**',
      '',
      '```json',
      truncate(safeJson(failure.args) || '(none)', 4000),
      '```',
      '',
      '**Error**',
      '',
      '```',
      truncate(failure.error || failure.output || '(no error text)', 4000),
      '```',
      ''
    )
  }
  if (taskRollup.failures.length > 0) {
    lines.push(
      `## Failed task steps — ${taskRollup.failures.length}`,
      '',
      "Steps that failed inside this conversation's tasks (its own turns and any",
      'spawned workers). A failed step here may repeat a failure above — the same',
      "call seen from the task's side — but a worker's failed step appears ONLY",
      'here: workers never write into the conversation transcript. The full',
      'step-by-step records are in `03_tasks/`.',
      ''
    )
    for (const f of taskRollup.failures) {
      lines.push(
        `### TASK-${f.taskId} — step ${f.step}: \`${f.tool}\``,
        '',
        `- transcript: \`03_tasks/TASK-${f.taskId}.md\``,
        '',
        '**Arguments**',
        '',
        '```json',
        truncate(f.args || '(none)', 4000),
        '```',
        '',
        '**Error**',
        '',
        '```',
        truncate(f.error || '(no error text)', 4000),
        '```',
        ''
      )
    }
  }
  return lines.join('\n')
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

/**
 * Every date string the span touches, in BOTH local and UTC form — corpus and
 * episode files are named by local date, the app log by UTC date, and a
 * bundle that guessed wrong would silently omit the day that mattered.
 */
function datesInSpan(span: Span): Set<string> {
  const out = new Set<string>()
  const DAY = 24 * 60 * 60 * 1000
  const start = Math.max(span.from, span.to - MAX_LOG_DAYS * DAY)
  for (let t = start; t <= span.to + DAY; t += DAY) {
    const d = new Date(t)
    out.add(localDate(d))
    out.add(d.toISOString().slice(0, 10))
  }
  // The loop steps by whole days and can overshoot the final boundary.
  const end = new Date(span.to)
  out.add(localDate(end))
  out.add(end.toISOString().slice(0, 10))
  return out
}

function localDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

function matchesDate(name: string, dates: Set<string>, pattern: RegExp): boolean {
  const m = pattern.exec(name)
  return m ? dates.has(m[1]) : false
}

/** `2026-07-25_00-16-04.123.md` → epoch ms, or null when the name isn't a stamp. */
function snapshotTime(name: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.(\d{3})\.md$/.exec(name)
  if (!m) return null
  const [, y, mo, d, h, mi, s, ms] = m
  return new Date(+y, +mo - 1, +d, +h, +mi, +s, +ms).getTime()
}

function snapshotInSpan(name: string, span: Span): boolean {
  const t = snapshotTime(name)
  return t !== null && t >= span.from && t <= span.to
}

/**
 * The corpus daily log is a sequence of `## <time> [<scope>]` blocks. Keep the
 * ones whose scope names this conversation — the attribution always ends with
 * ` conv <id>]`, so anchoring on that can't match a longer id by prefix.
 */
function filterCorpusBlocks(raw: string, conversationId: string): string[] {
  const needle = ` conv ${conversationId}]`
  const out: string[] = []
  // Split on block starts, keeping the delimiter with the block that follows.
  const parts = raw.split(/\n(?=## )/)
  for (const part of parts) {
    const header = part.slice(0, part.indexOf('\n') === -1 ? part.length : part.indexOf('\n'))
    if (header.startsWith('## ') && header.includes(needle)) out.push(part.trimEnd())
  }
  return out
}

/**
 * The event NAME on a corpus block's payload line (`- tool.failed → {…}`).
 * Reading the name is the only reliable way to classify a block: matching the
 * block TEXT for words like "timeout" or "error" matches every successful
 * shell call that happens to carry a `"timeout":15000` argument, which is how
 * a "failures" section fills up with things that worked.
 */
function corpusEventName(block: string): string | null {
  const m = /\n-\s+([A-Za-z][A-Za-z0-9_.]*)\s+→/.exec(block)
  return m ? m[1] : null
}

/** Test seam for {@link failureBlocks} — the classifier is the thing worth pinning. */
export function failureBlocksForTest(blocks: string[]): string[] {
  return failureBlocks(blocks)
}

/** Blocks whose EVENT is a failure — the real signal in the log. */
function failureBlocks(blocks: string[]): string[] {
  return blocks.filter((block) => {
    const name = corpusEventName(block)
    return name !== null && /\.(failed|error|stopped|denied|timeout|rejected)$/.test(name)
  })
}

/** Event-name histogram for the metrics file — cheap shape-of-the-run signal. */
function countCorpusEvents(blocks: string[]): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const block of blocks) {
    const name = corpusEventName(block)
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

/** Task ids referenced by this conversation's own corpus events. */
function extractTaskIds(blocks: string[]): string[] {
  const ids = new Set<string>()
  for (const block of blocks) {
    for (const m of block.matchAll(/"taskId":"([A-Za-z0-9_-]+)"/g)) ids.add(m[1])
  }
  return [...ids]
}

/**
 * Steps and failed steps of one task transcript (motor's renderTranscript
 * format). Parsed from the markdown because the markdown IS the persistence —
 * motor keeps no structured task file — and per STEP, not per task status: a
 * worker that stumbles mid-run and recovers still ends SUCCEEDED, which is
 * exactly the failure a status check would hide.
 */
function parseTaskSteps(
  taskId: string,
  raw: string
): { steps: number; failures: TaskStepFailure[] } {
  let steps = 0
  const failures: TaskStepFailure[] = []
  for (const chunk of raw.split(/\n(?=### Step \d+: )/)) {
    const head = /^### Step (\d+): (\S+)/.exec(chunk)
    if (!head) continue
    steps += 1
    if (!/^- \*\*Result:\*\* failed$/m.test(chunk)) continue
    failures.push({
      taskId,
      step: Number(head[1]),
      tool: head[2],
      args: /^- \*\*Args:\*\* `(.*)`$/m.exec(chunk)?.[1] ?? '',
      // The error line is the last thing before the Result line, and may span
      // lines — capture up to the Result marker rather than one line.
      error: (/\n- \*\*Error:\*\* ([\s\S]*?)\n- \*\*Result:\*\*/.exec(chunk)?.[1] ?? '').trim()
    })
  }
  return { steps, failures }
}

/** Distinct tool names called anywhere in the conversation's segments. */
function calledToolNames(conversation: ConversationFile): string[] {
  const names = new Set<string>()
  for (const message of conversation.messages) {
    for (const segment of message.segments ?? []) {
      if (segment.kind === 'tool_call') names.add(segment.name)
    }
  }
  return [...names]
}

/**
 * A tool_result segment carries only the `toolCallId` it answers — the tool's
 * NAME lives on the matching tool_call. Both readers below (transcript, model
 * prompt) need the name on the result line, so pair them up first.
 */
function toolNamesById(message: ConversationMessage): Map<string, string> {
  const byId = new Map<string, string>()
  for (const segment of message.segments ?? []) {
    if (segment.kind === 'tool_call') byId.set(segment.toolCallId, segment.name)
  }
  return byId
}

/** One transcript/prompt line per tool segment, or null for everything else. */
function toolLine(
  segment: Segment,
  names: Map<string, string>,
  limits: { args: number; output: number; error: number }
): string | null {
  if (segment.kind === 'tool_call') {
    return `[tool call] ${segment.name} ${truncate(safeJson(segment.args), limits.args)}`
  }
  if (segment.kind === 'tool_result') {
    const name = names.get(segment.toolCallId) ?? '(unknown tool)'
    if (segment.error) {
      return `[tool ${segment.status}] ${name}: ${truncate(segment.error, limits.error)}`
    }
    return `[tool ${segment.status}] ${name}: ${truncate(segment.output, limits.output)}`
  }
  return null
}

type AttachmentReport = { listed: number; copied: number; bytes: number }

/**
 * Attachments are inventoried, not shipped. Media bytes are the one thing that
 * would blow up a bundle meant to be emailed, and a filename + type + size is
 * what a diagnosis actually needs. Small text-ish files are the exception —
 * they're cheap and frequently the input that broke something.
 */
async function collectAttachments(
  bundle: Bundle,
  root: string,
  conversationId: string,
  conversation: ConversationFile
): Promise<AttachmentReport> {
  const dirName = conversationDirName(conversationId)
  const report: AttachmentReport = { listed: 0, copied: 0, bytes: 0 }
  const lines: string[] = ['# Attachments', '']

  for (const [label, base] of [
    ['uploads', 'uploads'],
    ['voice notes', 'voice'],
    ['speech', 'speech']
  ] as const) {
    const dir = path.join(root, base, dirName)
    const names = (await listDir(dir)).sort()
    if (names.length === 0) continue
    lines.push(`## ${label} (${base}/${dirName})`, '')
    for (const name of names) {
      let size = 0
      try {
        const stat = await fs.stat(path.join(dir, name))
        if (!stat.isFile()) continue
        size = stat.size
      } catch {
        continue
      }
      report.listed += 1
      report.bytes += size
      const ext = path.extname(name).toLowerCase()
      const copyable = COPYABLE_ATTACHMENT_EXT.has(ext) && size <= MAX_ATTACHMENT_COPY_BYTES
      if (copyable) {
        const ok = await bundle.copy(
          'attachments',
          path.join(dir, name),
          `07_attachments/${base}/${name}`
        )
        if (ok) report.copied += 1
      }
      lines.push(`- ${name} — ${formatBytes(size)}${copyable ? ' (copied)' : ''}`)
    }
    lines.push('')
  }

  // What the transcript itself claims was attached, including files that have
  // since been deleted from disk — a mismatch between the two lists is itself
  // a finding.
  const referenced = conversation.messages.flatMap((m) => m.attachments ?? [])
  if (referenced.length > 0) {
    lines.push('## referenced by the transcript', '')
    for (const a of referenced) {
      lines.push(`- ${a.originalName} — ${a.type}, ${a.mimeType}, ${formatBytes(a.sizeBytes)}`)
      lines.push(`  \`${a.filePath}\``)
    }
    lines.push('')
  }

  if (report.listed === 0 && referenced.length === 0) {
    lines.push('_No attachments on this conversation._', '')
  } else {
    lines.push(
      `_Media bytes are deliberately excluded. ${report.copied} small text file(s) copied; ` +
        `${report.listed} file(s) on disk totalling ${formatBytes(report.bytes)}._`,
      ''
    )
  }

  bundle.add('attachments', '07_attachments/MANIFEST.md', lines.join('\n'))
  return report
}

async function findProject(root: string, projectId: string): Promise<unknown | null> {
  const raw = await readTextFile(path.join(root, 'brain', 'projects.json'))
  if (!raw) return null
  try {
    const list: unknown = JSON.parse(raw)
    if (!Array.isArray(list)) return null
    return list.find((p) => (p as { id?: string })?.id === projectId) ?? null
  } catch {
    return null
  }
}

/**
 * Replace every credential-shaped value with a length marker. Keyed on the
 * FIELD NAME rather than the value's shape, so a new provider's secret is
 * redacted the day it's added as long as it's named like one — and the
 * surrounding structure (which providers are configured, which model) stays
 * readable, because that's what a diagnosis needs.
 */
const SECRET_KEY_RE =
  /(api[-_]?key|secret|token|password|passphrase|credential|cookie|private[-_]?key|client[-_]?id|session|auth)/i

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(key)) {
        out[key] =
          typeof val === 'string' && val.length > 0
            ? `[redacted — ${val.length} chars]`
            : val === null || val === undefined || val === ''
              ? val
              : '[redacted]'
      } else {
        out[key] = redactSecrets(val)
      }
    }
    return out
  }
  return value
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function buildEnvironment(env: DiagnosticEnv, capabilityNames: string[]): Record<string, unknown> {
  return {
    generatedAt: new Date().toISOString(),
    app: {
      version: env.appVersion,
      packaged: env.packaged,
      locale: env.locale,
      chatMode: env.chatMode
    },
    model: { provider: env.provider, model: env.model },
    system: {
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      cpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      chrome: process.versions.chrome ?? null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    },
    capabilities: capabilityNames.slice().sort()
  }
}

/** A readable replay of the conversation, so the JSON isn't the only way in. */
function renderTranscript(conversation: ConversationFile, conversationId: string): string {
  const lines: string[] = [
    `# ${conversation.title || 'Untitled'}`,
    '',
    `- id: ${conversationId}`,
    `- channel: ${conversation.channel ?? 'electron'}`,
    `- model: ${conversation.model ?? '(unset)'}`,
    `- created: ${isoOrUnknown(conversation.createdAt)}`,
    `- updated: ${isoOrUnknown(conversation.updatedAt)}`,
    `- messages: ${conversation.messages.length}`,
    ''
  ]
  for (const [i, message] of conversation.messages.entries()) {
    lines.push(`## ${i + 1}. ${message.role} — ${isoOrUnknown(message.timestamp)}`, '')
    if (message.content.trim()) lines.push(message.content.trim(), '')
    const names = toolNamesById(message)
    for (const segment of message.segments ?? []) {
      const line = toolLine(segment, names, { args: 500, output: 500, error: 800 })
      if (!line) continue
      // Wall-clock per call, joined from toolTimings by toolCallId — "which
      // call took four minutes" is a question the raw transcript can't answer.
      const timing =
        segment.kind === 'tool_result' ? message.toolTimings?.[segment.toolCallId] : undefined
      const took =
        timing?.startedAt && timing?.endedAt
          ? ` _(${formatDuration(timing.endedAt - timing.startedAt)})_`
          : ''
      lines.push(`- ${line}${took}`)
    }
    if (message.stopReason) lines.push(`- stop reason: ${message.stopReason}`)
    if (message.error) lines.push(`- **error:** ${message.error}`)
    lines.push('')
  }
  return lines.join('\n')
}

function renderReadme(args: {
  conversation: ConversationFile
  conversationId: string
  environment: Record<string, unknown>
  metrics: Metrics
  taskRollup: TaskRollup
  entries: ZipEntry[]
  extraRootFiles: number
  warnings: string[]
  taskIds: string[]
  capabilities: string[]
  attachmentReport: AttachmentReport
  modelOpinion: boolean
}): string {
  const { conversation, conversationId, environment, entries, metrics } = args
  const app = environment.app as { version?: string }
  const model = environment.model as { provider?: string | null; model?: string | null }
  const system = environment.system as { platform?: string; osRelease?: string }
  const byFolder = new Map<string, number>([['(root)', args.extraRootFiles]])
  for (const entry of entries) {
    const top = entry.name.includes('/') ? entry.name.split('/')[0] : '(root)'
    byFolder.set(top, (byFolder.get(top) ?? 0) + 1)
  }

  const lines: string[] = [
    '# Wolffish diagnostic bundle',
    '',
    `Generated ${new Date().toISOString()} by Wolffish ${app.version ?? '?'} on ${system?.platform ?? '?'} ${system?.osRelease ?? ''}`.trim() +
      '.',
    '',
    '## Conversation',
    '',
    `- **Title:** ${conversation.title || 'Untitled'}`,
    `- **Id:** ${conversationId}`,
    `- **Channel:** ${conversation.channel ?? 'electron'}`,
    `- **Created:** ${isoOrUnknown(conversation.createdAt)}`,
    `- **Last updated:** ${isoOrUnknown(conversation.updatedAt)}`,
    ...(conversation.projectId ? [`- **Project:** ${conversation.projectId}`] : []),
    // The model SELECTED now is routinely not the model that ran the turns —
    // this conversation may predate a model switch. Both are reported, and
    // which is which is stated, because conflating them sends a diagnosis
    // after the wrong provider's behaviour.
    `- **Model selected at export time:** ${model.model ?? '(none)'} (${model.provider ?? 'none'})`,
    ...(args.taskIds.length > 0
      ? [`- **Tasks:** ${args.taskIds.map((id) => `TASK-${id}`).join(', ')}`]
      : []),
    ...(args.capabilities.length > 0
      ? [`- **Capabilities used:** ${args.capabilities.sort().join(', ')}`]
      : []),
    '',
    '## At a glance',
    '',
    renderMetrics(metrics, args.taskRollup),
    '',
    `Full breakdown in \`00_METRICS.md\`.`,
    ''
  ]

  // Task-step failures are listed alongside the conversation's own, but the
  // heading keeps the two counts apart: a turn's own steps duplicate its tool
  // calls, so one summed number would double-count every conversation-level
  // failure — while a worker's failed step exists ONLY as a task step.
  const taskFailures = args.taskRollup.failures
  if (metrics.failures.length > 0 || taskFailures.length > 0) {
    const heading =
      taskFailures.length > 0
        ? metrics.failures.length > 0
          ? `## Failures (tool calls: ${metrics.failures.length}, task steps: ${taskFailures.length})`
          : `## Failures (task steps: ${taskFailures.length})`
        : `## Failures (${metrics.failures.length})`
    lines.push(heading, '', 'Full arguments and error text in `01_conversation/failures.md`.', '')
    const items = [
      ...metrics.failures.map(
        (failure) =>
          `- **\`${failure.tool}\`** (message #${failure.index}) — ${truncate(
            (failure.error || failure.output || failure.status).replace(/\s+/g, ' ').trim(),
            160
          )}`
      ),
      ...taskFailures.map(
        (f) =>
          `- **\`${f.tool}\`** (TASK-${f.taskId}, step ${f.step}) — ${truncate(
            (f.error || 'failed').replace(/\s+/g, ' ').trim(),
            160
          )}`
      )
    ]
    lines.push(...items.slice(0, 12))
    if (items.length > 12) {
      lines.push(`- …and ${items.length - 12} more.`)
    }
    lines.push('')
  } else {
    lines.push(
      '## Failures',
      '',
      'No tool call reported a failure. If something still went wrong it is a',
      'wrong-but-successful call, a prompt/context problem, or a UI-side issue —',
      'start from `01_conversation/transcript.md` and the turn end reasons above.',
      ''
    )
  }

  lines.push('## Contents', '', '| Folder | Files | What it is |', '| --- | --- | --- |')

  const descriptions: Record<string, string> = {
    '(root)': 'This readme, the metrics roll-up and the environment snapshot',
    '01_conversation': 'Raw conversation, readable transcript, and the failures on their own',
    '02_logs':
      'Corpus + app logs for the days it spans, the slice for THIS conversation, usage ledgers',
    '03_tasks': 'Tool-by-tool task transcripts this conversation spawned',
    '04_memory': 'Episodes, consolidated memory and knowledge files in play',
    '05_context': 'Operating instructions, identity, prompt snapshots, capability contracts',
    '06_settings': 'Redacted config, compaction bookkeeping, bound project',
    '07_attachments': 'Attachment manifest (media bytes excluded) and small text attachments',
    '08_analysis': "The model's own opinion on what went wrong"
  }
  for (const [folder, count] of [...byFolder.entries()].sort()) {
    lines.push(`| \`${folder}\` | ${count} | ${descriptions[folder] ?? ''} |`)
  }

  lines.push(
    '',
    '## Notes',
    '',
    '- Every credential in `06_settings/config.redacted.json` is replaced by a length marker — no secrets are in this archive.',
    '- Attachment media is listed, not included. See `07_attachments/MANIFEST.md`.',
    `- Corpus logs are kept for 7 days, so an older conversation may have no event log.`,
    args.modelOpinion
      ? "- `08_analysis/model-opinion.md` is the model's unverified first read, not a verdict."
      : '- No model opinion is included in this bundle.'
  )

  if (args.warnings.length > 0) {
    lines.push('', '## Collection warnings', '')
    for (const warning of args.warnings) lines.push(`- ${warning}`)
  }

  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// the optional model opinion
// ---------------------------------------------------------------------------

/**
 * The opinion is a READ, not an action. The model gets the transcript and the
 * error signals and writes what it thinks went wrong — it has no tools, writes
 * no files, and creates no conversation. One call, reasoning off (Thalamus
 * already clamps that for side-calls), retried internally like every other
 * side-call. If it fails, the bundle ships without it.
 */
const OPINION_SYSTEM =
  `You are Wolffish performing a self-diagnostic. The user hit an unknown problem in the ` +
  `conversation below and is sending a diagnostic bundle to the developer.\n\n` +
  `Write YOUR OWN opinion of what went wrong. You have no tools and must not attempt any ` +
  `action — no file access, no commands, no fixes applied. Only analysis.\n\n` +
  `You are given, in this order: a metrics block (timing, tokens, context use, cost, models ` +
  `that actually ran), every failed tool call with its arguments and error, the failure events ` +
  `from the log, and then the transcript — whose MIDDLE may be elided. The failures and metrics ` +
  `are complete; treat them as your primary evidence and the transcript as context.\n\n` +
  `Structure your answer with these markdown sections and nothing else:\n` +
  `## What the user was trying to do\n` +
  `## What actually happened\n` +
  `## Most likely cause\n` +
  `## Evidence (quote the specific tool call, error, metric or message)\n` +
  `## What I'd check first\n\n` +
  `Rules: be concrete and short — under 500 words total. Name specific tools, arguments and ` +
  `error strings from the material. Cite the numbers when they matter (a turn that took minutes, ` +
  `context near its budget, a model you did not expect). Where you are guessing, say so in that ` +
  `line. If nothing actually looks wrong, say that plainly instead of inventing a fault.`

/**
 * The caller's abort (if any) OR the timeout, whichever fires first. An aborted
 * call lands in runOpinion's catch and skips the section — the same path a
 * provider error already takes.
 */
function opinionSignal(caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(OPINION_TIMEOUT_MS)
  return caller ? AbortSignal.any([caller, timeout]) : timeout
}

async function runOpinion(
  llm: DiagnosticLLM,
  args: {
    conversation: ConversationFile
    conversationId: string
    env: DiagnosticEnv
    metrics: Metrics
    taskRollup: TaskRollup
    corpusBlocks: string[]
    signal?: AbortSignal
  }
): Promise<{ text: string; reason?: never } | { text: null; reason: OpinionSkipReason }> {
  const prompt = buildOpinionPrompt(args)
  try {
    // Sealed background scope: the opinion's spend lands on the ledger but is
    // never relayed into a live turn's context meter (same as the titler).
    const { text, provider, model } = await runDetached(() =>
      llm.diagnose(prompt, OPINION_SYSTEM, args.signal)
    )
    const body = text.trim()
    // A model that answered with nothing is a different story from one that
    // couldn't be reached, and the overlay says so.
    if (!body) return { text: null, reason: 'empty' }
    return {
      text: [
        '# Model opinion',
        '',
        `Written by \`${model}\` (${provider}) at ${new Date().toISOString()}.`,
        '',
        "> This is the model's own unverified reading of the conversation. It ran as a single",
        '> side-call with no tools and no ability to change anything. Treat it as a lead, not a',
        '> conclusion.',
        '',
        body,
        ''
      ].join('\n')
    }
  } catch {
    return { text: null, reason: 'failed' }
  }
}

/**
 * The material the opinion call sees, assembled EVIDENCE-FIRST.
 *
 * The obvious construction — concatenate everything, cut to fit — is wrong,
 * and wrong in the way that looks fine: on a real conversation (30 messages,
 * 150 tool calls, 7 failures) a plain tail-slice kept a mid-run stretch of
 * successful `telegram_send` calls and dropped every single failure. The model
 * would then have been asked what went wrong while holding no evidence that
 * anything had — an invitation to invent one.
 *
 * So the budget is spent in priority order and the sections that carry the
 * diagnosis are assembled first and never truncated as a group:
 *   1. environment + metrics (time, tokens, context, cost — small, always in)
 *   2. every failed tool call, with arguments and error
 *   3. failure-classified log events
 *   4. the transcript, with whatever budget is left, truncated in the MIDDLE
 *      (the opening states the goal, the end states the outcome; the middle is
 *      the part you can lose).
 */
function buildOpinionPrompt(args: {
  conversation: ConversationFile
  conversationId: string
  env: DiagnosticEnv
  metrics: Metrics
  taskRollup: TaskRollup
  corpusBlocks: string[]
}): string {
  const { conversation, env, metrics, taskRollup } = args
  const head = [
    `Wolffish ${env.appVersion} on ${process.platform}, mode ${env.chatMode ?? 'single'}, ` +
      `channel ${conversation.channel ?? 'electron'}.`,
    `Model selected now: ${env.model ?? '(none)'} (${env.provider ?? 'none'}) — ` +
      `note this may NOT be the model that ran the turns below.`,
    `Conversation "${conversation.title || 'Untitled'}", last active ${isoOrUnknown(conversation.updatedAt)}.`,
    '',
    '## Metrics',
    '',
    renderMetrics(metrics, taskRollup),
    ''
  ].join('\n')

  const evidence: string[] = []
  if (metrics.failures.length > 0) {
    evidence.push(`## Failed tool calls (${metrics.failures.length}) — the primary evidence`, '')
    for (const [i, failure] of metrics.failures.entries()) {
      evidence.push(
        `${i + 1}. ${failure.tool} — ${failure.status}` +
          (failure.durationMs !== null ? ` after ${formatDuration(failure.durationMs)}` : '') +
          ` (message #${failure.index})`,
        `   args: ${truncate(safeJson(failure.args) || '(none)', 600)}`,
        `   error: ${truncate((failure.error || failure.output || '(no error text)').trim(), 900)}`
      )
    }
    evidence.push('')
  }
  if (taskRollup.failures.length > 0) {
    evidence.push(
      `## Failed task steps (${taskRollup.failures.length}) — inside this conversation's tasks`,
      '',
      'A step here may repeat a failed tool call above; a WORKER task step appears',
      'only here, never in the transcript below.',
      ''
    )
    for (const [i, f] of taskRollup.failures.entries()) {
      evidence.push(
        `${i + 1}. ${f.tool} — failed (TASK-${f.taskId}, step ${f.step})`,
        `   args: ${truncate(f.args || '(none)', 600)}`,
        `   error: ${truncate((f.error || '(no error text)').trim(), 900)}`
      )
    }
    evidence.push('')
  }
  if (metrics.failures.length === 0 && taskRollup.failures.length === 0) {
    evidence.push(
      '## Failed tool calls',
      '',
      'None. No tool reported a failure, so if something went wrong it is a',
      'wrong-but-successful call, a context/prompt problem, or outside the agent loop.',
      ''
    )
  }

  // Classified by EVENT NAME, not by the word "error" appearing anywhere in the
  // block — a text match pulls in every successful shell call carrying a
  // `"timeout": 15000` argument and buries the real failures under them.
  const failureEvents = failureBlocks(args.corpusBlocks)
  if (failureEvents.length > 0) {
    evidence.push(
      `## Failure events in the log (${failureEvents.length}, most recent last)`,
      '',
      ...failureEvents.slice(-30).map((block) => truncate(block, 800)),
      ''
    )
  }

  const body: string[] = ['## Transcript', '']
  for (const [index, message] of conversation.messages.entries()) {
    body.push(`### #${index + 1} ${message.role} — ${isoOrUnknown(message.timestamp)}`)
    if (message.content.trim()) {
      body.push(truncate(message.content.trim(), OPINION_PER_MESSAGE_CHARS))
    }
    const names = toolNamesById(message)
    for (const segment of message.segments ?? []) {
      const line = toolLine(segment, names, { args: 300, output: 200, error: 600 })
      if (line) body.push(line)
    }
    if (message.stopReason) body.push(`[stop reason] ${message.stopReason}`)
    if (message.error) body.push(`[message error] ${message.error}`)
    body.push('')
  }

  const fixed = `${head}\n${evidence.join('\n')}`
  const remaining = OPINION_MAX_CHARS - fixed.length
  return `${fixed}\n${middleTruncate(body.join('\n'), Math.max(remaining, 4_000))}`
}

/**
 * Trim from the MIDDLE, keeping ~60% of the budget at the start and the rest at
 * the end. A conversation states its goal at the top and its outcome at the
 * bottom; a head- or tail-only cut throws away one of the two.
 */
function middleTruncate(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.6)
  const tail = max - head
  const omitted = text.length - head - tail
  return (
    `${text.slice(0, head)}\n\n` +
    `[…${omitted.toLocaleString()} characters of middle turns omitted for length — ` +
    `the failures above are complete…]\n\n` +
    `${text.slice(text.length - tail)}`
  )
}

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

function isoOrUnknown(ms: number | undefined): string {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0
    ? new Date(ms).toISOString()
    : '(unknown)'
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}… [${text.length - max} more chars]`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** `2026-07-25_00-16-04` — sortable, filename-safe, local time. */
function fileStamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  )
}
