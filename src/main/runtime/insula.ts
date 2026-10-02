/**
 * Insula provides self-awareness — the agent's sense of its own state.
 *
 * Maps to: the insular cortex — the region behind interoception, the felt
 * sense of what's happening inside the body. It's how you know you're
 * tired, anxious, or full without anyone telling you. It also underwrites
 * metacognition: noticing that you noticed something.
 *
 * In Wolffish, the insula reads from motor (task history), basal ganglia
 * (learned preferences), hippocampus (recent conversations), and
 * hypothalamus (current health) to answer questions like "what have I
 * been doing lately?" or "what do I know about myself?". The introspect
 * capability gives the LLM an on-demand way to query the same data.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import type { BasalGanglia, FeedbackSummary } from '@main/runtime/basalganglia'
import type { Corpus } from '@main/runtime/corpus'
import type { Hippocampus } from '@main/runtime/hippocampus'
import type { HealthReport, Hypothalamus } from '@main/runtime/hypothalamus'

export type AgentStatus = {
  uptimeSeconds: number
  activeProvider: string | null
  activeModel: string | null
  capabilities: string[]
  ramUsedBytes: number
  ramTotalBytes: number
  ramUsagePercent: number
  diskFreeBytes: number | null
  cortexDbBytes: number | null
  health: HealthReport | null
}

export type PerformanceReport = {
  windowDays: number
  tasksToday: number
  tasksTodaySucceeded: number
  tasksTodayFailed: number
  tasksTodayStopped: number
  tasksTotal: number
  tasksSucceeded: number
  tasksFailed: number
  tasksStopped: number
  successRate: number
  totalToolCalls: number
  topTools: Array<{ tool: string; count: number }>
  topDenied: Array<{ tool: string; count: number }>
  avgTaskDurationMs: number | null
}

export type ConversationSummary = {
  windowDays: number
  episodeCount: number
  todaysTopics: string[]
  knowledgeFiles: Array<{ name: string; hasContent: boolean }>
  feedbackToday: number
  feedbackTotal: number
}

export type InsulaOptions = {
  corpus?: Corpus
  workspaceRoot?: string
  hypothalamus?: Hypothalamus
  basalganglia?: BasalGanglia
  hippocampus?: Hippocampus
}

export class Insula {
  private workspaceRoot: string | null
  private hypothalamus: Hypothalamus | null
  private basalganglia: BasalGanglia | null
  private hippocampus: Hippocampus | null

  constructor(options: InsulaOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? null
    this.hypothalamus = options.hypothalamus ?? null
    this.basalganglia = options.basalganglia ?? null
    this.hippocampus = options.hippocampus ?? null
  }

  /**
   * Snapshot of the agent right now — uptime, provider, capabilities, and
   * a live RAM/disk reading via hypothalamus.
   */
  async getStatus(): Promise<AgentStatus> {
    const health = (await this.hypothalamus?.getHealth().catch(() => null)) ?? null
    const r = health?.resources

    return {
      uptimeSeconds: r?.uptimeSeconds ?? 0,
      activeProvider: r?.activeProvider ?? null,
      activeModel: r?.activeModel ?? null,
      capabilities: r?.capabilityNames ?? [],
      ramUsedBytes: r?.ramUsedBytes ?? 0,
      ramTotalBytes: r?.ramTotalBytes ?? 0,
      ramUsagePercent: r?.ramUsagePercent ?? 0,
      diskFreeBytes: r?.diskFreeBytes ?? null,
      cortexDbBytes: health?.workspace.cortexDbBytes ?? null,
      health
    }
  }

  /**
   * Aggregate task and tool stats over a rolling window.
   */
  async getPerformanceReport(windowDays = 7): Promise<PerformanceReport> {
    const summary: FeedbackSummary = (await this.basalganglia
      ?.getFeedbackSummary()
      .catch(() => null)) ?? {
      totalCalls: 0,
      successCount: 0,
      failedCount: 0,
      deniedCount: 0,
      successRate: 0,
      topTools: [],
      topDenied: []
    }

    const taskStats = await this.readTaskStats()

    return {
      windowDays,
      tasksToday: taskStats.today.total,
      tasksTodaySucceeded: taskStats.today.succeeded,
      tasksTodayFailed: taskStats.today.failed,
      tasksTodayStopped: taskStats.today.stopped,
      tasksTotal: taskStats.allTime.total,
      tasksSucceeded: taskStats.allTime.succeeded,
      tasksFailed: taskStats.allTime.failed,
      tasksStopped: taskStats.allTime.stopped,
      successRate:
        taskStats.allTime.total > 0
          ? taskStats.allTime.succeeded / taskStats.allTime.total
          : summary.successRate,
      totalToolCalls: summary.totalCalls,
      topTools: summary.topTools,
      topDenied: summary.topDenied,
      avgTaskDurationMs: taskStats.avgDurationMs
    }
  }

  /**
   * Summarize recent conversation topics + knowledge file coverage.
   */
  async getConversationSummary(windowDays = 7): Promise<ConversationSummary> {
    const episodes = (await this.hippocampus?.getRecentEpisodes(windowDays).catch(() => [])) ?? []
    const todayKey = formatDate(new Date())
    const today = episodes.find((ep) => ep.date === todayKey)
    const todaysTopics = today ? extractTopics(today.content) : []

    const knowledgeFiles = await this.readKnowledgeFileSummary()
    const feedback = await this.countFeedback()

    return {
      windowDays,
      episodeCount: episodes.length,
      todaysTopics,
      knowledgeFiles,
      feedbackToday: feedback.today,
      feedbackTotal: feedback.total
    }
  }

  /**
   * Compose a markdown introspection report combining status, performance,
   * and recent conversations. The introspect plugin uses the same shape;
   * this method exists for callers that want to format from typed data.
   */
  async reflect(): Promise<string> {
    const [status, performance, summary] = await Promise.all([
      this.getStatus(),
      this.getPerformanceReport(),
      this.getConversationSummary()
    ])

    const parts: string[] = []
    parts.push(renderStatus(status))
    parts.push(renderPerformance(performance))
    parts.push(renderConversation(summary))
    return parts.join('\n\n')
  }

  private async readTaskStats(): Promise<{
    today: { total: number; succeeded: number; failed: number; stopped: number }
    allTime: { total: number; succeeded: number; failed: number; stopped: number }
    avgDurationMs: number | null
  }> {
    const empty = { total: 0, succeeded: 0, failed: 0, stopped: 0 }
    const result = {
      today: { ...empty },
      allTime: { ...empty },
      avgDurationMs: null as number | null
    }
    if (!this.workspaceRoot) return result

    const dir = path.join(this.workspaceRoot, 'brain', 'motor', 'tasks')
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      return result
    }

    const todayKey = formatDate(new Date())
    let durationSum = 0
    let durationCount = 0

    for (const name of entries) {
      if (!/^TASK-[A-Za-z0-9._-]+\.md$/.test(name)) continue
      let raw: string
      try {
        raw = await fs.readFile(path.join(dir, name), 'utf8')
      } catch {
        continue
      }

      const status = (/\*\*Status:\*\*\s*([A-Za-z]+)/i.exec(raw)?.[1] ?? '').toLowerCase()
      const createdRaw = /\*\*Created:\*\*\s*([\d:\-T.Z]+)/i.exec(raw)?.[1]
      const updatedRaw = /\*\*Updated:\*\*\s*([\d:\-T.Z]+)/i.exec(raw)?.[1]
      const created = createdRaw ? new Date(createdRaw) : null
      const updated = updatedRaw ? new Date(updatedRaw) : null

      result.allTime.total += 1
      if (status === 'succeeded') result.allTime.succeeded += 1
      else if (status === 'failed') result.allTime.failed += 1
      else if (status === 'stopped') result.allTime.stopped += 1

      if (created && formatDate(created) === todayKey) {
        result.today.total += 1
        if (status === 'succeeded') result.today.succeeded += 1
        else if (status === 'failed') result.today.failed += 1
        else if (status === 'stopped') result.today.stopped += 1
      }

      if (created && updated && status !== 'running') {
        const ms = updated.getTime() - created.getTime()
        if (Number.isFinite(ms) && ms >= 0) {
          durationSum += ms
          durationCount += 1
        }
      }
    }

    result.avgDurationMs = durationCount > 0 ? durationSum / durationCount : null
    return result
  }

  private async readKnowledgeFileSummary(): Promise<Array<{ name: string; hasContent: boolean }>> {
    if (!this.workspaceRoot) return []
    const dir = path.join(this.workspaceRoot, 'brain', 'hippocampus', 'knowledge')
    const names = ['projects', 'people', 'preferences', 'technical', 'decisions']
    const out: Array<{ name: string; hasContent: boolean }> = []
    for (const name of names) {
      let raw: string
      try {
        raw = await fs.readFile(path.join(dir, `${name}.md`), 'utf8')
      } catch {
        out.push({ name, hasContent: false })
        continue
      }
      const body = raw.replace(/^#[^\n]*\n+/, '').trim()
      out.push({ name, hasContent: body.length > 0 })
    }
    return out
  }

  private async countFeedback(): Promise<{ today: number; total: number }> {
    if (!this.workspaceRoot) return { today: 0, total: 0 }
    const dir = path.join(this.workspaceRoot, 'brain', 'basalganglia')
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      return { today: 0, total: 0 }
    }
    const todayKey = formatDate(new Date())
    let today = 0
    let total = 0
    for (const name of entries) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue
      let raw: string
      try {
        raw = await fs.readFile(path.join(dir, name), 'utf8')
      } catch {
        continue
      }
      const count = countFeedbackEntries(raw)
      total += count
      if (name === `${todayKey}.md`) today += count
    }
    return { today, total }
  }
}

function extractTopics(episodeMarkdown: string): string[] {
  const out: string[] = []
  for (const line of episodeMarkdown.split(/\r?\n/)) {
    const m = /^##\s+\d{2}:\d{2}\s+—\s+(.+?)\s*$/.exec(line)
    if (m) out.push(m[1].trim())
  }
  return out
}

function countFeedbackEntries(raw: string): number {
  let count = 0
  for (const line of raw.split(/\r?\n/)) {
    if (/^-\s+\d{2}:\d{2}\s+\|/.test(line)) count += 1
  }
  return count
}

function formatDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const mins = Math.floor(seconds / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  const remMins = mins % 60
  if (hours < 24) return `${hours}h ${remMins}m`
  const days = Math.floor(hours / 24)
  const remHours = hours % 24
  return `${days}d ${remHours}h`
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

function renderStatus(s: AgentStatus): string {
  const lines: string[] = ['## Wolffish Status', '']
  lines.push(`- **Uptime:** ${formatUptime(s.uptimeSeconds)}`)
  if (s.activeProvider) {
    lines.push(`- **Provider:** ${s.activeProvider} / ${s.activeModel ?? 'unknown'}`)
  } else {
    lines.push(`- **Provider:** none`)
  }
  const caps = s.capabilities.length === 0 ? 'none' : s.capabilities.join(', ')
  lines.push(`- **Capabilities:** ${caps} (${s.capabilities.length} loaded)`)
  if (s.ramTotalBytes > 0) {
    lines.push(
      `- **RAM:** ${formatBytes(s.ramUsedBytes)} / ${formatBytes(s.ramTotalBytes)} (${formatPercent(s.ramUsagePercent)})`
    )
  }
  if (s.diskFreeBytes !== null) {
    lines.push(`- **Disk:** ${formatBytes(s.diskFreeBytes)} free`)
  }
  if (s.cortexDbBytes !== null) {
    lines.push(`- **cortex.db:** ${formatBytes(s.cortexDbBytes)}`)
  }
  return lines.join('\n')
}

function renderPerformance(p: PerformanceReport): string {
  const lines: string[] = ['## Performance', '']
  lines.push(
    `- **Tasks today:** ${p.tasksToday} (${p.tasksTodaySucceeded} succeeded, ${p.tasksTodayFailed} failed, ${p.tasksTodayStopped} stopped)`
  )
  lines.push(`- **Tasks all time:** ${p.tasksTotal}`)
  lines.push(`- **Success rate:** ${formatPercent(p.successRate)}`)
  lines.push(`- **Total tool calls:** ${p.totalToolCalls}`)
  if (p.topTools.length > 0) {
    const used = p.topTools.map((t) => `${t.tool} (${t.count})`).join(', ')
    lines.push(`- **Most used:** ${used}`)
  }
  if (p.topDenied.length > 0) {
    const denied = p.topDenied.map((t) => `${t.tool} x${t.count}`).join(', ')
    lines.push(`- **Denied:** ${denied}`)
  }
  if (p.avgTaskDurationMs !== null) {
    lines.push(`- **Avg task duration:** ${(p.avgTaskDurationMs / 1000).toFixed(1)}s`)
  }
  return lines.join('\n')
}

function renderConversation(c: ConversationSummary): string {
  const lines: string[] = ['## Memory', '']
  lines.push(`- **Episodes:** ${c.episodeCount} days recorded`)
  if (c.todaysTopics.length > 0) {
    lines.push(`- **Today's topics:** ${c.todaysTopics.join(', ')}`)
  } else {
    lines.push(`- **Today's topics:** (none yet)`)
  }
  if (c.knowledgeFiles.length > 0) {
    const summary = c.knowledgeFiles
      .map((kf) => `${kf.name} (${kf.hasContent ? 'has content' : 'empty'})`)
      .join(', ')
    lines.push(`- **Knowledge files:** ${summary}`)
  }
  lines.push(`- **Feedback entries:** ${c.feedbackToday} today, ${c.feedbackTotal} total`)
  return lines.join('\n')
}
