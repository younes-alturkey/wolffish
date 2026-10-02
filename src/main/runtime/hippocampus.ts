import { diskWriter } from '@main/io/diskWriter'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Corpus } from '@main/runtime/corpus'

/**
 * Hippocampus is the memory layer.
 *
 * Maps to: the hippocampus — a seahorse-shaped structure deep in the
 * temporal lobe responsible for forming new memories, consolidating them
 * during sleep, and threading them into the cortex's long-term store.
 * Damage it and you can still remember the past, but you can't form
 * anything new (the famous Patient H.M. case).
 *
 * In Wolffish memory works in three stages, the same way the brain
 * does it:
 *   1. Episodes — daily logs in hippocampus/episodes/YYYY-MM-DD.md
 *   2. Consolidated — weekly summaries in hippocampus/consolidated/YYYY-WNN.md
 *   3. Knowledge — long-lived facts in hippocampus/knowledge/*.md
 * The nightly heartbeat consolidates and promotes; nothing important is
 * ever lost, but day-to-day chatter doesn't drown out long-term context.
 */

export type ToolOutcome = 'success' | 'failed' | 'denied' | 'blocked'

export type TurnToolCall = {
  name: string
  argsSummary: string
  outcome: ToolOutcome
}

export type TurnSummary = {
  timestamp: Date
  userMessage: string
  toolCalls: TurnToolCall[]
  assistantResponse: string
  /**
   * Where the turn originated ('heartbeat', 'procedure', 'worker',
   * 'telegram', …). Rendered into the episode header so machine-generated
   * entries are distinguishable from real user activity — both for recall
   * filtering and for the nightly consolidation.
   */
  origin?: string
}

export type Episode = {
  date: string
  content: string
}

export type KnowledgeFile = 'projects' | 'people' | 'preferences' | 'technical' | 'decisions'

export type ConsolidationRange = 'daily' | 'weekly'

export type HippocampusOptions = {
  workspaceRoot?: string
  corpus?: Corpus
}

const RESPONSE_PREVIEW_CHARS = 200
const HEADLINE_PREVIEW_CHARS = 80
// Episodes are a log of WHAT happened, not a verbatim archive — the full
// message lives in brain/conversations/*.json and is reachable via
// wolffish_recall. Capping the user line keeps a single giant prompt (e.g. a
// multi-KB "role" brief) from bloating the history section of every future
// system prompt for the next two days.
const USER_PREVIEW_CHARS = 280

export class Hippocampus {
  private workspaceRoot: string | null
  private corpus: Corpus | null

  constructor(options: HippocampusOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? null
    this.corpus = options.corpus ?? null
  }

  /**
   * Append a turn summary to today's episode file. Creates the file with
   * a date header if it doesn't exist yet.
   */
  async appendEpisode(turn: TurnSummary): Promise<void> {
    if (!this.workspaceRoot) return
    const dir = path.join(this.workspaceRoot, 'brain', 'hippocampus', 'episodes')
    const date = formatDate(turn.timestamp)
    const filename = `${date}.md`
    const filepath = path.join(dir, filename)

    try {
      await fs.mkdir(dir, { recursive: true })
    } catch {
      return
    }

    // Header decision runs INSIDE the file's write queue (appendWithInit) —
    // two turns finishing in the same instant used to both probe a missing
    // file and write duplicate `# date` headers.
    const block = renderTurn(turn)
    try {
      await diskWriter.appendWithInit(filepath, (exists) =>
        exists ? block : `# ${date}\n\n${block}`
      )
    } catch {
      return
    }

    this.corpus?.emit('memory.episodeSaved', {
      date,
      section: headline(turn.userMessage)
    })
  }

  /**
   * Read the most recent episode files in chronological order. The
   * window includes today even if today's file is empty.
   */
  async getRecentEpisodes(days = 2): Promise<Episode[]> {
    if (!this.workspaceRoot) return []
    const dir = path.join(this.workspaceRoot, 'brain', 'hippocampus', 'episodes')
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      return []
    }

    const dated = entries
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .sort()
      .slice(-days)

    const out: Episode[] = []
    for (const name of dated) {
      try {
        const raw = await fs.readFile(path.join(dir, name), 'utf8')
        const content = raw.trim()
        if (content.length === 0) continue
        out.push({ date: name.replace(/\.md$/, ''), content })
      } catch {
        // skip unreadable files
      }
    }
    return out
  }

  /**
   * Read today's episode file. Returns null if it doesn't exist or is empty.
   */
  async getTodayEpisode(): Promise<Episode | null> {
    return this.getEpisode(formatDate(new Date()))
  }

  /**
   * Read a specific day's episode file by ISO date (YYYY-MM-DD).
   */
  async getEpisode(date: string): Promise<Episode | null> {
    if (!this.workspaceRoot) return null
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
    const filepath = path.join(this.workspaceRoot, 'brain', 'hippocampus', 'episodes', `${date}.md`)
    try {
      const raw = await fs.readFile(filepath, 'utf8')
      const content = raw.trim()
      if (content.length === 0) return null
      return { date, content }
    } catch {
      return null
    }
  }

  /**
   * Append a long-lived fact to one of the knowledge files. Used at the
   * end of consolidation when something graduates from "noise of the
   * week" into "true about the user".
   */
  async promoteToKnowledge(file: KnowledgeFile, fact: string, topic?: string): Promise<void> {
    if (!this.workspaceRoot) return
    const filepath = path.join(
      this.workspaceRoot,
      'brain',
      'hippocampus',
      'knowledge',
      `${file}.md`
    )
    const trimmed = fact.trim()
    if (trimmed.length === 0) return
    const line = trimmed.startsWith('-') ? trimmed : `- ${trimmed}`

    try {
      await fs.mkdir(path.dirname(filepath), { recursive: true })
    } catch {
      return
    }

    // RMW inside the file's write queue: the dedup check and the write are
    // one atomic step, so two concurrent promotions of the same fact can't
    // both pass the check and write duplicate bullets.
    let wrote = false
    try {
      await diskWriter.update(filepath, (raw) => {
        const existing = raw ?? `# ${capitalize(file)}\n\n`
        // Dedup: the nightly consolidation re-derives the same facts night
        // after night — without this, knowledge files silently fill with
        // duplicate bullets (observed live in preferences.md).
        if (existing.split(/\r?\n/).some((l) => l.trim() === line)) return null
        wrote = true
        return Hippocampus.fileEntry(existing, line, topic)
      })
    } catch {
      return
    }
    if (!wrote) return

    this.corpus?.emit('memory.knowledgeUpdated', { file, fact: trimmed })
  }

  /**
   * Place one entry in a knowledge file — the single placement rule shared by
   * every writer (memory_save's quick note, the knowledge capability's filed
   * add, the nightly promotions).
   *
   * With a topic, the entry lands at the end of that `## Topic` section, which
   * is created if it doesn't exist. WITHOUT one it lands in the PREAMBLE, above
   * the first topic — never appended at end-of-file. That last part is the
   * whole point: in a file organized by topic, an end-of-file append reads as
   * belonging to whichever topic happens to be last, so "Sana started a new
   * job" filed with no topic used to end up under `## Omar (brother)`. An
   * unfiled note has to claim nothing; the nightly curator files it properly.
   */
  static fileEntry(content: string, line: string, topic?: string): string {
    const body = content.replace(/\s+$/, '')
    const lines = body.split('\n')
    const wanted = topic?.trim() ?? ''

    if (wanted) {
      const headingAt = lines.findIndex(
        (l) => l.trim().toLowerCase() === `## ${wanted}`.toLowerCase()
      )
      if (headingAt === -1) return `${body}\n\n## ${wanted}\n${line}\n`
      let end = lines.length
      for (let i = headingAt + 1; i < lines.length; i += 1) {
        if (/^#{1,2}\s/.test(lines[i])) {
          end = i
          break
        }
      }
      // Land after the section's last real entry, not after its trailing blank
      // line, so the entry can't drift under the next heading.
      while (end > headingAt + 1 && lines[end - 1].trim() === '') end -= 1
      lines.splice(end, 0, line)
      return `${lines.join('\n')}\n`
    }

    const firstTopic = lines.findIndex((l) => /^##\s/.test(l))
    if (firstTopic === -1) return `${body}\n${line}\n`
    let at = firstTopic
    while (at > 0 && lines[at - 1].trim() === '') at -= 1
    lines.splice(at, 0, line)
    return `${lines.join('\n')}\n`
  }

  /**
   * Guarantee the `## Entity` structure the memory map depends on. The
   * curator prompts mandate sections, but structure is a mechanical
   * invariant — deepseek-v4-pro was observed flattening small files to
   * bullet lists no matter how loudly the prompt insisted — so a flat
   * rewrite gets its `- **Label** — fact` bullets promoted to sections in
   * code instead of betting on model discipline. Files that already carry
   * `##` headings pass through untouched.
   */
  static normalizeKnowledgeStructure(body: string): string {
    const lines = body.split('\n')
    if (lines.some((l) => /^## /.test(l))) return body
    const out: string[] = []
    let promoted = 0
    for (const line of lines) {
      const m = /^- \*\*(.+?)\*\*\s*[—:–-]?\s*(.*)$/.exec(line)
      if (m) {
        const label = m[1].trim().replace(/[:：]\s*$/, '')
        if (out.length > 0 && out[out.length - 1].trim() !== '') out.push('')
        out.push(`## ${label}`)
        if (m[2].trim()) out.push(`- ${m[2].trim()}`)
        promoted += 1
      } else {
        out.push(line)
      }
    }
    return promoted > 0 ? out.join('\n') : body
  }

  /** Read one knowledge file's current content (null when missing/empty). */
  async getKnowledgeFile(file: KnowledgeFile): Promise<string | null> {
    if (!this.workspaceRoot) return null
    const filepath = path.join(
      this.workspaceRoot,
      'brain',
      'hippocampus',
      'knowledge',
      `${file}.md`
    )
    try {
      const raw = await fs.readFile(filepath, 'utf8')
      return raw.trim().length > 0 ? raw : null
    } catch {
      return null
    }
  }

  /**
   * Replace a knowledge file wholesale — the curatorial write path. The
   * nightly compaction and the monthly deep clean REWRITE these files (merge
   * duplicates, resolve contradictions, restructure under `## Entity`
   * headers) instead of appending bullets; promoteToKnowledge stays the
   * append path for one-off memory_save facts, which the next rewrite folds
   * into structure. The previous content is kept as `<file>.md.bak` so a bad
   * LLM rewrite is one copy away from restored.
   */
  async replaceKnowledgeFile(file: KnowledgeFile, content: string): Promise<void> {
    if (!this.workspaceRoot) return
    const trimmed = content.trim()
    if (trimmed.length === 0) return
    const filepath = path.join(
      this.workspaceRoot,
      'brain',
      'hippocampus',
      'knowledge',
      `${file}.md`
    )
    const headed = trimmed.startsWith('#') ? trimmed : `# ${capitalize(file)}\n\n${trimmed}`
    const body = Hippocampus.normalizeKnowledgeStructure(headed)

    let previous: string | null = null
    try {
      previous = await fs.readFile(filepath, 'utf8')
    } catch {
      previous = null
    }
    if (previous && previous.trim().length > 0 && previous.trim() !== body) {
      try {
        await diskWriter.update(`${filepath}.bak`, () => previous)
      } catch {
        // Backup is best-effort; the rewrite itself must still land.
      }
    }
    try {
      await diskWriter.update(filepath, () => `${body}\n`)
    } catch {
      return
    }
    this.corpus?.emit('memory.knowledgeRewritten', { file, bytes: body.length })
  }

  /**
   * Write a weekly digest to consolidated/YYYY-WNN.md. Used by the
   * nightly compaction job in brainstem.
   */
  async writeConsolidated(weekKey: string, content: string): Promise<void> {
    if (!this.workspaceRoot) return
    if (!/^\d{4}-W\d{2}$/.test(weekKey)) return
    const dir = path.join(this.workspaceRoot, 'brain', 'hippocampus', 'consolidated')
    const filepath = path.join(dir, `${weekKey}.md`)
    try {
      await fs.mkdir(dir, { recursive: true })
    } catch {
      return
    }
    try {
      await diskWriter.update(filepath, (raw) => {
        const existing = raw ?? ''
        const header = existing.length === 0 ? `# ${weekKey}\n\n` : ''
        const sep = existing.length > 0 && !existing.endsWith('\n\n') ? '\n\n' : ''
        return `${existing}${header}${sep}${content.trim()}\n`
      })
    } catch {
      return
    }
    this.corpus?.emit('memory.consolidated', { week: weekKey })
  }
}

function renderTurn(turn: TurnSummary): string {
  const time = formatTime(turn.timestamp)
  const origin = turn.origin && turn.origin !== 'electron' ? ` [${turn.origin}]` : ''
  const head = `## ${time}${origin} — ${headline(turn.userMessage)}\n`
  const userLine = `- **User:** ${truncate(oneLine(turn.userMessage), USER_PREVIEW_CHARS) || '(empty)'}\n`
  const toolLine =
    turn.toolCalls.length > 0
      ? `- **Tools:** ${turn.toolCalls.map(formatToolCall).join(', ')}\n`
      : `- **Tools:** none\n`
  const responsePreview = truncate(oneLine(turn.assistantResponse), RESPONSE_PREVIEW_CHARS)
  const responseLine = `- **Response:** ${responsePreview || '(empty)'}\n\n`
  return head + userLine + toolLine + responseLine
}

function formatToolCall(call: TurnToolCall): string {
  const args = call.argsSummary ? ` ${call.argsSummary}` : ''
  return `${call.name}${args} (${call.outcome})`
}

function headline(text: string): string {
  const collapsed = oneLine(text)
  return truncate(collapsed, HEADLINE_PREVIEW_CHARS) || '(empty)'
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1).trimEnd()}…`
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

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1)
}
