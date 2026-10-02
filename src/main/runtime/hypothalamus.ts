/**
 * Hypothalamus monitors internal state and broadcasts when something is
 * out of range.
 *
 * Maps to: the hypothalamus — the brain's homeostasis controller. It
 * watches body temperature, hunger, thirst, blood pressure, sleep
 * pressure, and a dozen other variables, and triggers corrective behavior
 * the moment one drifts. You don't decide to sweat; the hypothalamus
 * decides for you.
 *
 * In Wolffish, the hypothalamus tracks the agent's internal vital signs:
 * remaining context window, RAM, disk, capability count, cortex.db size,
 * provider availability. When a value crosses a threshold it broadcasts on
 * the corpus event bus so other modules and the renderer can react.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { Cerebellum } from '@main/runtime/cerebellum'
import type { Corpus, CorpusEvent, CorpusEvents, CorpusUnsubscribe } from '@main/runtime/corpus'
import type { Device } from '@main/runtime/device'
import type { ProviderId, Thalamus } from '@main/runtime/thalamus'

export type HealthLevel = 'ok' | 'warning' | 'critical'

export type ResourceUsage = {
  ramTotalBytes: number
  ramUsedBytes: number
  ramFreeBytes: number
  ramUsagePercent: number
  diskFreeBytes: number | null
  cpuLoadAverage: number[]
  platform: NodeJS.Platform
  arch: string
  release: string
  uptimeSeconds: number
  contextTokensUsed: number
  contextTokensBudget: number
  contextUsagePercent: number
  activeProvider: ProviderId | null
  activeModel: string | null
  capabilitiesLoaded: number
  capabilityNames: string[]
}

export type WorkspaceStats = {
  episodeCount: number
  feedbackCount: number
  taskTotal: number
  taskSucceeded: number
  taskFailed: number
  taskStopped: number
  cortexDbBytes: number | null
  knowledgeFiles: Array<{ name: string; hasContent: boolean }>
}

export type HealthReport = {
  level: HealthLevel
  resources: ResourceUsage
  workspace: WorkspaceStats
  warnings: string[]
  timestamp: number
}

export type HypothalamusOptions = {
  corpus?: Corpus
  workspaceRoot?: string
  cerebellum?: Cerebellum
  thalamus?: Thalamus
  device?: Device
  intervalMs?: number
  getContextBudget?: () => number
  getActiveModel?: () => string | null
}

const DEFAULT_INTERVAL_MS = 60_000
const DEFAULT_CONTEXT_BUDGET = 8000

const RAM_WARNING_RATIO = 0.85
const RAM_CRITICAL_RATIO = 0.95
const DISK_WARNING_BYTES = 1_000_000_000 // 1 GB
const DISK_CRITICAL_BYTES = 200_000_000 // 200 MB
const CONTEXT_WARNING_RATIO = 0.8
const CORTEX_DB_WARNING_BYTES = 1_000_000_000 // 1 GB

const KNOWLEDGE_FILES = ['projects', 'people', 'preferences', 'technical', 'decisions'] as const

export class Hypothalamus {
  private corpus: Corpus | null
  private workspaceRoot: string | null
  private cerebellum: Cerebellum | null
  private thalamus: Thalamus | null
  private device: Device | null
  private intervalMs: number
  private getContextBudget: () => number
  private getActiveLocalModel: () => string | null

  private timer: NodeJS.Timeout | null = null
  private startedAt: number
  private lastContextTokens = 0
  private corpusUnsub: CorpusUnsubscribe | null = null

  constructor(options: HypothalamusOptions = {}) {
    this.corpus = options.corpus ?? null
    this.workspaceRoot = options.workspaceRoot ?? null
    this.cerebellum = options.cerebellum ?? null
    this.thalamus = options.thalamus ?? null
    this.device = options.device ?? null
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
    this.getContextBudget = options.getContextBudget ?? (() => DEFAULT_CONTEXT_BUDGET)
    this.getActiveLocalModel = options.getActiveModel ?? (() => null)
    this.startedAt = Date.now()

    if (this.corpus) {
      this.corpusUnsub = this.corpus.on('context.built', (payload) => {
        this.lastContextTokens = payload.tokenCount
      })
    }
  }

  /**
   * Start the periodic monitor loop. Idempotent.
   */
  init(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.monitor().catch(() => undefined)
    }, this.intervalMs)
    this.timer.unref?.()
  }

  /**
   * Stop the monitor loop and unsubscribe from corpus.
   */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.corpusUnsub) {
      this.corpusUnsub()
      this.corpusUnsub = null
    }
  }

  /**
   * Sample resources, evaluate thresholds, and emit warnings on corpus.
   * Returns the same report `getHealth()` would return.
   */
  async monitor(): Promise<HealthReport> {
    const report = await this.getHealth()
    return report
  }

  /**
   * Produce a one-shot health report.
   */
  async getHealth(): Promise<HealthReport> {
    const resources = await this.getResourceUsage()
    const workspace = await this.getWorkspaceStats()
    const warnings: string[] = []
    let level: HealthLevel = 'ok'

    if (resources.ramUsagePercent >= RAM_CRITICAL_RATIO) {
      level = 'critical'
      const msg = `RAM at ${formatPercent(resources.ramUsagePercent)}`
      warnings.push(`ram critical — ${msg}`)
      this.broadcastState('health.critical', { resource: 'ram', message: msg })
    } else if (resources.ramUsagePercent >= RAM_WARNING_RATIO) {
      if (level === 'ok') level = 'warning'
      warnings.push(`ram high — ${formatPercent(resources.ramUsagePercent)}`)
      this.broadcastState('health.warning', {
        resource: 'ram',
        usage: resources.ramUsagePercent,
        threshold: RAM_WARNING_RATIO
      })
    }

    if (resources.diskFreeBytes !== null) {
      if (resources.diskFreeBytes < DISK_CRITICAL_BYTES) {
        level = 'critical'
        const msg = `${formatBytes(resources.diskFreeBytes)} free`
        warnings.push(`disk critical — ${msg}`)
        this.broadcastState('health.critical', { resource: 'disk', message: msg })
      } else if (resources.diskFreeBytes < DISK_WARNING_BYTES) {
        if (level === 'ok') level = 'warning'
        warnings.push(`disk low — ${formatBytes(resources.diskFreeBytes)} free`)
        this.broadcastState('health.warning', {
          resource: 'disk',
          usage: resources.diskFreeBytes,
          threshold: DISK_WARNING_BYTES
        })
      }
    }

    if (resources.contextUsagePercent >= CONTEXT_WARNING_RATIO) {
      if (level === 'ok') level = 'warning'
      warnings.push(`context tokens at ${formatPercent(resources.contextUsagePercent)}`)
      this.broadcastState('health.warning', {
        resource: 'context',
        usage: resources.contextUsagePercent,
        threshold: CONTEXT_WARNING_RATIO
      })
    }

    if (workspace.cortexDbBytes !== null && workspace.cortexDbBytes >= CORTEX_DB_WARNING_BYTES) {
      if (level === 'ok') level = 'warning'
      warnings.push(`cortex.db ${formatBytes(workspace.cortexDbBytes)}`)
      this.broadcastState('health.warning', {
        resource: 'cortex_db',
        usage: workspace.cortexDbBytes,
        threshold: CORTEX_DB_WARNING_BYTES
      })
    }

    return {
      level,
      resources,
      workspace,
      warnings,
      timestamp: Date.now()
    }
  }

  /**
   * Sample current resource usage without raising any alerts.
   *
   * RAM totals/free and disk free come from Device when injected so
   * macOS reports real memory pressure (vm_stat-derived available
   * memory) rather than the misleading os.freemem() ratio. The
   * fallback path keeps standalone usage working without Device.
   */
  async getResourceUsage(): Promise<ResourceUsage> {
    let total: number
    let free: number
    let diskFree: number | null
    if (this.device) {
      const info = await this.device.getInfo()
      total = info.ramTotalBytes
      free = info.ramFreeBytes
      diskFree = info.disk?.freeBytes ?? null
    } else {
      total = os.totalmem()
      free = os.freemem()
      diskFree = await this.detectFreeDisk()
    }
    const used = total - free
    const providers = this.getProviderInfo()
    const capabilityNames = (this.cerebellum?.getCapabilities() ?? [])
      .filter((c) => c.status === 'ok' && !this.cerebellum!.isDisabled(c.name))
      .map((c) => c.name)

    return {
      ramTotalBytes: total,
      ramUsedBytes: used,
      ramFreeBytes: free,
      ramUsagePercent: total > 0 ? used / total : 0,
      diskFreeBytes: diskFree,
      cpuLoadAverage: os.loadavg(),
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      contextTokensUsed: this.lastContextTokens,
      contextTokensBudget: this.getContextBudget(),
      contextUsagePercent:
        this.getContextBudget() > 0 ? this.lastContextTokens / this.getContextBudget() : 0,
      activeProvider: providers.active?.id ?? null,
      activeModel: providers.active?.model ?? null,
      capabilitiesLoaded: capabilityNames.length,
      capabilityNames
    }
  }

  /**
   * File counts and sizes for the workspace. Best-effort — missing
   * directories return zero/null.
   */
  async getWorkspaceStats(): Promise<WorkspaceStats> {
    const empty: WorkspaceStats = {
      episodeCount: 0,
      feedbackCount: 0,
      taskTotal: 0,
      taskSucceeded: 0,
      taskFailed: 0,
      taskStopped: 0,
      cortexDbBytes: null,
      knowledgeFiles: []
    }
    if (!this.workspaceRoot) return empty
    const root = this.workspaceRoot

    const [episodeCount, feedbackCount, taskStats, cortexDbBytes, knowledgeFiles] =
      await Promise.all([
        countMatchingFiles(
          path.join(root, 'brain', 'hippocampus', 'episodes'),
          /^\d{4}-\d{2}-\d{2}\.md$/
        ),
        countMatchingFiles(path.join(root, 'brain', 'basalganglia'), /^\d{4}-\d{2}-\d{2}\.md$/),
        readTaskStats(path.join(root, 'brain', 'motor', 'tasks')),
        fileSize(path.join(root, 'brain', 'cortex.db')),
        readKnowledgeFileSummary(path.join(root, 'brain', 'hippocampus', 'knowledge'))
      ])

    return {
      episodeCount,
      feedbackCount,
      taskTotal: taskStats.total,
      taskSucceeded: taskStats.succeeded,
      taskFailed: taskStats.failed,
      taskStopped: taskStats.stopped,
      cortexDbBytes,
      knowledgeFiles
    }
  }

  /**
   * Publish an event on corpus. Public so callers (e.g. the agent) can
   * piggy-back on the same channel for diagnostic broadcasts.
   */
  broadcastState<K extends CorpusEvent>(event: K, payload: CorpusEvents[K]): void {
    this.corpus?.emit(event, payload)
  }

  private async detectFreeDisk(): Promise<number | null> {
    try {
      const target = this.workspaceRoot ?? os.homedir()
      const stats = await fs.statfs(target)
      return stats.bavail * stats.bsize
    } catch {
      return null
    }
  }

  private getProviderInfo(): {
    active: { id: ProviderId; model: string } | null
  } {
    if (!this.thalamus) return { active: null }
    const id = this.thalamus.getActiveProvider()
    if (!id) return { active: null }
    if (id === 'local') {
      return { active: { id, model: this.getActiveLocalModel() ?? 'local' } }
    }
    const model = this.thalamus.getActiveModel()
    return { active: model ? { id, model } : null }
  }
}

async function countMatchingFiles(dir: string, pattern: RegExp): Promise<number> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return 0
  }
  return entries.filter((name) => pattern.test(name)).length
}

type TaskStats = { total: number; succeeded: number; failed: number; stopped: number }

async function readTaskStats(dir: string): Promise<TaskStats> {
  const stats: TaskStats = { total: 0, succeeded: 0, failed: 0, stopped: 0 }
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return stats
  }
  for (const name of entries) {
    if (!/^TASK-[A-Za-z0-9._-]+\.md$/.test(name)) continue
    let raw: string
    try {
      raw = await fs.readFile(path.join(dir, name), 'utf8')
    } catch {
      continue
    }
    stats.total += 1
    const status = (/\*\*Status:\*\*\s*([A-Za-z]+)/i.exec(raw)?.[1] ?? '').toLowerCase()
    if (status === 'succeeded') stats.succeeded += 1
    else if (status === 'failed') stats.failed += 1
    else if (status === 'stopped') stats.stopped += 1
  }
  return stats
}

async function fileSize(filepath: string): Promise<number | null> {
  try {
    const stat = await fs.stat(filepath)
    return stat.size
  } catch {
    return null
  }
}

async function readKnowledgeFileSummary(
  dir: string
): Promise<Array<{ name: string; hasContent: boolean }>> {
  const out: Array<{ name: string; hasContent: boolean }> = []
  for (const name of KNOWLEDGE_FILES) {
    const filepath = path.join(dir, `${name}.md`)
    let raw: string
    try {
      raw = await fs.readFile(filepath, 'utf8')
    } catch {
      out.push({ name, hasContent: false })
      continue
    }
    const body = raw.replace(/^#[^\n]*\n+/, '').trim()
    out.push({ name, hasContent: body.length > 0 })
  }
  return out
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
