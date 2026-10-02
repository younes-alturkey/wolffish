/**
 * Corpus is the event bus that connects every brain region.
 *
 * Maps to: the corpus callosum — the thick band of fibers connecting the two
 * hemispheres of the brain. It carries signals between regions so that
 * perception, memory, planning, and motor control can act in concert without
 * any single region knowing the others' internals.
 *
 * In Wolffish, modules publish typed events (`task.completed`,
 * `memory.episodeSaved`, `safety.blocked`, ...) and other modules subscribe.
 * The bus is for "this happened" notifications — when something needs a
 * direct request/response (prefrontal asks cortex for search results), call
 * the module directly.
 */

import { diskWriter } from '@main/io/diskWriter'
import mitt, { type Emitter, type Handler } from 'mitt'
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * The identity of the turn whose async call tree we are inside. Corpus events
 * are emitted SYNCHRONOUSLY (mitt), so a listener runs inside the emitter's
 * async context and can read this at emit time to tell WHICH turn an event
 * originated from. Two consumers:
 *
 *  - The TurnRunner enters a scope (`autonomous: false`, real turnId +
 *    conversationId) around every foreground channel turn, and its per-turn
 *    relay listeners drop any event whose emitter scope names a DIFFERENT
 *    turn — with concurrent conversations, this is what keeps one turn's
 *    meter/token/task events out of every other turn's sink.
 *  - Sealed background runs (Agent.processAutonomous for heartbeat
 *    automations and procedure runs, the post-turn conversation summarizer,
 *    brainstem side-emits) enter an `autonomous: true` scope, which every
 *    relay drops unconditionally — background runs must never write into a
 *    live chat's timeline or hijack its active task id.
 *
 * Fail-open: no scope (`undefined`) ⇒ an emit from outside any turn (IPC
 * handlers, watchers); relays forward those as they always have. Workflow
 * subagent turns intentionally DON'T open their own scope — they run inside
 * the master's async context, so their usage events relay to the master's
 * sink, which is how the workflow card accounts agent spend.
 */
export type TurnScope = {
  turnId: string | null
  conversationId: string | null
  /** True for sealed background runs that must never reach a live sink. */
  autonomous: boolean
}

export const turnScope = new AsyncLocalStorage<TurnScope>()

/** Run `fn` inside an anonymous sealed-background scope (no turn identity). */
export function runDetached<T>(fn: () => T): T {
  return turnScope.run({ turnId: null, conversationId: null, autonomous: true }, fn)
}

export type CorpusEvents = {
  'message.received': { content: string; timestamp: string }
  'message.classified': {
    type: 'question' | 'command' | 'conversation'
    complexity: 'simple' | 'complex'
  }

  'context.built': {
    tokenCount: number
    tokenBudget: number
    // Token count at which auto-compaction triggers for the active model —
    // the renderer draws it as a tick on the context meter so the visible
    // meter and the compaction trigger share one denominator story.
    compactionAt?: number
    sectionsIncluded: string[]
  }

  'tools.filtered': { total: number; kept: number; dropped: string[] }

  'llm.request': { provider: string; model: string }
  'llm.response': {
    provider: string
    model: string
    // Who consumed these tokens: the Brain's own turn loop, a workflow
    // worker, a summarization side-call (compaction / conversation summarizer /
    // memory compaction), or a conversation-titling call. Titling is its OWN
    // role — a title is not a summary. The renderer routes on this — only
    // 'brain' calls feed the context meter; the rest are itemized separately.
    role: 'brain' | 'worker' | 'summary' | 'title'
    inputTokens: number
    outputTokens: number
    cacheCreationTokens: number
    cacheReadTokens: number
    durationMs: number
    // Set for role:'summary' only — brain/worker cost arrives via the
    // per-turn `turn.usage` roll-up instead.
    cost?: number
  }
  'llm.error': { provider: string; error: string }
  'llm.fallback': { from: string; to: string; reason: string }
  'llm.retry': { provider: string; attempt: number; delayMs: number; errorClass: string }
  'llm.reasoning_effort.stripped': { model: string; reason: string }
  // Whole-turn roll-up emitted once per agent turn, with the cache split
  // priced separately so caching wins are measurable from the corpus log.
  'turn.usage': {
    provider: string
    model: string
    role: 'brain' | 'worker'
    iterations: number
    toolCalls: number
    inputTokens: number
    outputTokens: number
    cacheCreationTokens: number
    cacheReadTokens: number
    cacheHitRate: number
    cost: number
  }

  'tool.called': { taskId: string; tool: string; args: Record<string, unknown> }
  'tool.completed': { taskId: string; tool: string; durationMs: number }
  'tool.failed': { taskId: string; tool: string; error: string; attempt: number }

  'task.created': { taskId: string; name: string; stepsTotal: number }
  'task.stepCompleted': { taskId: string; step: number; total: number }
  'task.completed': { taskId: string; durationMs: number }
  'task.failed': { taskId: string; failedAt: number; error: string }
  'task.stopped': { taskId: string; stoppedAt: number }

  'dependency.checking': { capability: string; dependency: string }
  'dependency.missing': { capability: string; dependency: string }
  'dependency.satisfied': { capability: string; dependency: string; cached: boolean }
  'dependency.installing': { capability: string; dependency: string }
  'dependency.approved': { capability: string; dependency: string }
  'dependency.denied': { capability: string; dependency: string }
  'dependency.installed': { capability: string; dependency: string }
  'dependency.failed': { capability: string; dependency: string; error: string }

  'dependency.npm.installing': { capability: string; deps: string[] }
  'dependency.npm.installed': { capability: string }
  'dependency.npm.failed': { capability: string; error?: string }
  /** A Wolffish-authored skill passed its first real tool call since creation/edit. */
  'capability.tested': { capability: string }

  'security.credentialBlocked': { type: string; messageDiscarded: true }

  'safety.allowed': { tool: string; args: Record<string, unknown> }
  'safety.blocked': { tool: string; args: Record<string, unknown>; reason: string }
  'safety.confirmNeeded': {
    id: string
    tool: string
    args: Record<string, unknown>
    reason: string
  }
  'safety.approved': { id: string }
  'safety.denied': { id: string }
  'safety.autoApproved': {
    id: string
    tool: string
    args: Record<string, unknown>
    level: string
    reason: string
  }

  'compaction.started': { messagesCount: number; force?: boolean }
  'compaction.applied': { tokensSaved: number; targetsCount: number }

  'memory.episodeSaved': { date: string; section: string }
  'memory.consolidated': { week: string }
  'memory.knowledgeUpdated': { file: string; fact: string }
  'memory.knowledgeRewritten': { file: string; bytes: number }

  /**
   * The agent amended one of its own long-term surfaces through the
   * `knowledge` capability (playbook, custom instructions, identity, or a
   * curated knowledge file). Distinct from the memory.* events above, which
   * are the automated consolidation path — this one is model-initiated.
   */
  'knowledge.edited': { target: string; rel: string; op: string; bytes: number }

  'reflection.reviewed': {
    conversation: string
    selfScore: number | null
  }
  'reflection.playbookUpdated': { day: string; bytes: number }
  'reflection.deepCleaned': { changedFiles: string[] }

  'feedback.recorded': {
    action: string
    outcome: 'success' | 'failure' | 'approved' | 'rejected'
  }

  'health.warning': { resource: string; usage: number; threshold: number }
  'health.critical': { resource: string; message: string }

  'index.reindexStarted': { startedAt: number; total: number }
  'index.reindexProgress': { done: number; total: number }
  'index.reindexed': { filesCount: number; durationMs: number }

  'brainstem.jobStarted': { job: string; type: string; label: string; timestamp: string }
  'brainstem.jobCompleted': {
    job: string
    type: string
    label: string
    timestamp: string
    durationMs: number
  }
  'brainstem.jobFailed': {
    job: string
    type: string
    label: string
    timestamp: string
    error: string
  }
  'brainstem.jobSkipped': { job: string; label: string; reason: string }
  'brainstem.jobCoalesced': { job: string; label: string }
  'brainstem.jobCatchup': { job: string; label: string; missedAt: string }
  'brainstem.schedulerReloaded': { jobs: number; timestamp: string }

  'usage.recorded': {
    provider: string
    model: string
    inputTokens: number
    outputTokens: number
    cacheCreationTokens: number
    cacheReadTokens: number
    cost: number
  }

  'voice.generating': { voice: string; textLength: number }
  'voice.generated': { filePath: string; sizeBytes: number; textLength: number }
  'voice.failed': { error: string }

  'upload.started': { originalName: string; type: string; sizeBytes: number }
  'upload.completed': { filePath: string; type: string; sizeBytes: number }
  'upload.failed': { error: string }
  'upload.deleted': { filePath: string }

  'stt.dep.checking': { dependency: string }
  'stt.dep.installing': { dependency: string; note?: string }
  'stt.dep.ready': { dependency: string }
  'stt.dep.failed': { dependency: string; error: string }
  'stt.transcribing': { filePath: string; model: string }
  'stt.transcribed': { language: string; segmentCount: number; textLength: number }
  'stt.failed': { error: string }
  'stt.detecting': { filePath: string }
  'stt.detected': { language: string; confidence: number }

  'telegram.started': { allowedUserCount: number }
  'telegram.stopped': { reason?: string }
  'telegram.statusChanged': Record<string, never>
  'telegram.error': {
    kind: 'token' | 'network' | 'rate_limit' | 'send' | 'unknown'
    message: string
  }
  'telegram.media.received': {
    chatId: number
    userId: number
    type: string
    filePath: string
    sizeBytes: number
  }

  'whatsapp.started': Record<string, never>
  'whatsapp.stopped': { reason?: string }
  'whatsapp.statusChanged': Record<string, never>
  'whatsapp.qr': { qr: string }
  /** Linking by phone number produced its eight-character code. */
  'whatsapp.pairingCode': { code: string }
  'whatsapp.loggedOut': Record<string, never>
  'whatsapp.error': {
    kind: 'auth' | 'network' | 'crypto' | 'stream' | 'unknown'
    message: string
  }
  'whatsapp.message.received': { remoteJid: string; body: string }
  'whatsapp.media.received': {
    remoteJid: string
    type: string
    filePath: string
    sizeBytes: number
  }
  'whatsapp.message.sent': { remoteJid: string }

  'conversation.changed': { conversationId: string | null; title?: string | null }
  /**
   * A conversation was deleted (from the in-app History OR a channel's /delete
   * flow). Relayed to the renderer so the sidebar can prune its live run-status
   * for it — otherwise a channel-side delete (which never touches the renderer)
   * leaves a ghost row synthesized from the lingering status.
   */
  'conversation.deleted': { id: string }
  /**
   * A conversation file was (re)indexed or removed by the incremental cortex
   * watcher — i.e. the list-visible set may have changed. Fires AFTER the row
   * is written, so a refetch is always fresh. Relayed to the renderer so the
   * conversations rail and History refresh for EVERY create/rename/delete path,
   * including ones that emit no turn lifecycle (autonomous heartbeat/procedure
   * runs, create-without-turn, the sensitive-data gate).
   */
  'conversation.indexed': { rel: string }
}

export type CorpusEvent = keyof CorpusEvents
export type CorpusListener<K extends CorpusEvent> = Handler<CorpusEvents[K]>
export type CorpusUnsubscribe = () => void

export type CorpusOptions = {
  workspaceRoot?: string
  flushIntervalMs?: number
  retentionDays?: number
  devLog?: boolean
}

type BufferedEvent = {
  name: CorpusEvent
  payload: unknown
  timestamp: Date
  /** Emitting turn's identity, captured at emit time (sync mitt dispatch). */
  scope?: TurnScope
}

// Batch event writes so a chatty turn doesn't fsync once per emit. 2s
// keeps the on-disk log close enough to live for tail-style debugging
// while still amortizing many events per write. Lost events on a hard
// crash are bounded to <2s of activity, which is acceptable for a log.
const FLUSH_INTERVAL_MS = 2000
const RETENTION_DAYS = 7

/**
 * `is.dev` (`!app.isPackaged`) without a hard electron dependency: corpus is
 * imported by plain-node test harnesses (via channels/channel.ts), where
 * @electron-toolkit/utils crashes at import time. Guarded require keeps the
 * exact same answer inside Electron and falls back to false outside it.
 */
function isDevRuntime(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { is } = require('@electron-toolkit/utils') as { is: { dev: boolean } }
    return is.dev
  } catch {
    return false
  }
}

export class Corpus {
  private emitter: Emitter<CorpusEvents> = mitt<CorpusEvents>()
  private buffer: BufferedEvent[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private readonly logsDir: string | null
  private readonly flushIntervalMs: number
  private readonly retentionDays: number
  private readonly devLog: boolean

  constructor(options: CorpusOptions = {}) {
    this.logsDir = options.workspaceRoot
      ? path.join(options.workspaceRoot, 'brain', 'corpus')
      : null
    this.flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS
    this.retentionDays = options.retentionDays ?? RETENTION_DAYS
    this.devLog = options.devLog ?? isDevRuntime()

    this.emitter.on('*', (type, payload) => {
      const timestamp = new Date()
      // Mitt dispatch is synchronous, so this reads the EMITTER's turn scope —
      // stamping every buffered event with the turn/conversation it came from
      // keeps the daily log forensically readable when turns run concurrently.
      const scope = turnScope.getStore()
      this.buffer.push({ name: type as CorpusEvent, payload, timestamp, scope })
      if (this.devLog) {
        console.log(`[${formatTimestamp(timestamp)}] ${String(type)}`, payload)
      }
    })

    if (this.logsDir) {
      void this.purgeOldLogs()
      this.flushTimer = setInterval(() => void this.flush(), this.flushIntervalMs)
      this.flushTimer.unref?.()
    }
  }

  emit<K extends CorpusEvent>(event: K, payload: CorpusEvents[K]): void {
    this.emitter.emit(event, payload)
  }

  on<K extends CorpusEvent>(event: K, listener: CorpusListener<K>): CorpusUnsubscribe {
    this.emitter.on(event, listener)
    return () => this.emitter.off(event, listener)
  }

  off<K extends CorpusEvent>(event: K, listener: CorpusListener<K>): void {
    this.emitter.off(event, listener)
  }

  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    await this.flush()
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0 || !this.logsDir) return
    const items = this.buffer.splice(0, this.buffer.length)

    try {
      await fs.mkdir(this.logsDir, { recursive: true })
    } catch {
      return
    }

    const grouped = new Map<string, string[]>()
    for (const item of items) {
      const date = formatDate(item.timestamp)
      const filename = `${date}.log.md`
      const attribution = item.scope
        ? ` [${item.scope.autonomous ? 'bg' : 'turn'}${item.scope.turnId ? ` ${item.scope.turnId}` : ''}${item.scope.conversationId ? ` conv ${item.scope.conversationId}` : ''}]`
        : ''
      const block = `## ${formatTimestamp(item.timestamp)}${attribution}\n- ${item.name} → ${safeStringify(item.payload)}\n\n`
      const list = grouped.get(filename) ?? []
      list.push(block)
      grouped.set(filename, list)
    }

    for (const [filename, blocks] of grouped) {
      const filepath = path.join(this.logsDir, filename)
      const date = filename.replace(/\.log\.md$/, '')
      const body = blocks.join('')
      try {
        // Header decision inside the write queue — a concurrent flush from
        // another Corpus instance can't race it into duplicate headers.
        await diskWriter.appendWithInit(filepath, (exists) =>
          exists ? body : `# ${date}\n\n${body}`
        )
      } catch {
        // best-effort: drop on persistent IO failure rather than retry-loop
      }
    }
  }

  private async purgeOldLogs(): Promise<void> {
    if (!this.logsDir) return
    let entries: string[]
    try {
      entries = await fs.readdir(this.logsDir)
    } catch {
      return
    }
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000
    for (const name of entries) {
      if (!/^\d{4}-\d{2}-\d{2}\.log\.md$/.test(name)) continue
      const filepath = path.join(this.logsDir, name)
      try {
        const stat = await fs.stat(filepath)
        if (stat.mtimeMs < cutoff) {
          await fs.unlink(filepath)
        }
      } catch {
        // skip unreadable entries
      }
    }
  }
}

function formatDate(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatTimestamp(d: Date): string {
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  const seconds = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${hours}:${minutes}:${seconds}.${ms}`
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
