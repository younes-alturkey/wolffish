import path from 'node:path'

/**
 * Pure per-source parsers for the cortex v2 index. Given a workspace-relative
 * path and its raw content, each builder returns the records (and structured
 * side-rows) to index for that file. No Electron, no sqlite, no fs — every
 * function here is directly testable with `npx tsx`.
 *
 * The index covers EVERYTHING wolffish knows, so retrieval tools can reach
 * every byte on demand: episodes, knowledge, consolidated digests,
 * conversations (including tool calls and their outputs), motor task
 * transcripts and detail logs, basalganglia outcome logs, the usage ledger,
 * corpus event logs, app/extension logs, and generated-file provenance.
 */

/** Where a record came from — the model-facing source taxonomy. */
export type RecordSource =
  | 'episode'
  | 'knowledge'
  | 'consolidated'
  | 'reflection'
  | 'conversation'
  | 'task'
  | 'feedback'
  | 'usage'
  | 'corpus'
  | 'log'
  | 'artifact'
  | 'doc'

export type IngestRecord = {
  source: RecordSource
  /** Stable retrieval handle, e.g. `conversation:<id>#3`, `task:<id>#step2`. */
  ref: string
  /** YYYY-MM-DD day (or YYYY-WNN week bucket) when resolvable. */
  date: string | null
  title: string
  content: string
  /** Small JSON side-channel (channel, role, tool name, byte sizes). */
  meta: string | null
}

export type ConversationRow = {
  id: string
  title: string
  channel: string
  createdAt: number
  updatedAt: number
  messageCount: number
  sizeBytes: number
  sealed: number
  projectId: string | null
  icon: string | null
}

export type UsageRow = {
  ts: string
  provider: string
  model: string
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  cost: number
}

export type ArtifactRow = {
  path: string
  name: string
  dir: string
  size: number
  mtimeMs: number
  kind: string
  conversationId: string | null
}

export type IngestResult = {
  records: IngestRecord[]
  conversation?: ConversationRow
  usageRows?: UsageRow[]
}

// ── Content caps ──────────────────────────────────────────────────────
// Records store a head+tail excerpt; the full bytes stay on disk and are one
// memory_get/conversation_read call away. Caps keep the index proportional to
// the KNOWLEDGE in the workspace, not to raw tool-output volume.

const SECTION_HEAD = 4_000
const SECTION_TAIL = 500
const MESSAGE_HEAD = 2_500
const MESSAGE_TAIL = 400
const TOOL_HEAD = 1_500
const TOOL_TAIL = 400
const LOG_TAIL_BYTES = 16_000
const LOG_CHUNK_LINES = 200
const FEEDBACK_CHUNK_LINES = 80

export function capContent(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 40) return text
  const omitted = text.length - head - tail
  return `${text.slice(0, head)}\n…[${omitted} chars omitted]…\n${text.slice(text.length - tail)}`
}

// ── Path classification ───────────────────────────────────────────────

const ARTIFACT_ROOTS = ['files/', 'uploads/', 'screenshots/', 'speech/']

/**
 * True when a workspace-relative path belongs in the index at all. The
 * watcher and the startup catch-up scan share this predicate.
 */
export function isIndexablePath(rel: string): boolean {
  const norm = rel.split(path.sep).join('/')
  if (norm.includes('/node_modules/')) return false
  if (norm.includes('/.debug/') || norm.includes('/.debug-archive/')) return false
  // Dot-dirs hold installed capability code, not memory.
  if (norm.split('/').some((seg) => seg.startsWith('.'))) return false
  if (norm.startsWith('brain/cortex.db')) return false
  // Secrets and operational state — never indexed.
  if (norm.startsWith('config.json')) return false
  // Inbound channel messages ARE memory — but nothing else under whatsapp/
  // (auth/ holds Baileys credentials). Accepted here explicitly because the
  // generic fall-through below only admits .md files.
  if (norm === 'whatsapp/read-history.json') return true
  if (norm.startsWith('whatsapp/')) return false
  if (norm.startsWith('telegram/')) return false
  if (norm.startsWith('extension/')) return false
  if (norm.startsWith('brain/brainstem/heartbeat-state.json')) return false
  if (norm.startsWith('brain/cerebellum/')) return false

  if (ARTIFACT_ROOTS.some((root) => norm.startsWith(root))) return true
  if (norm.startsWith('brain/conversations/') && norm.endsWith('.json')) return true
  if (norm.startsWith('brain/motor/tasks/') && norm.endsWith('-detail.log')) return true
  if (norm.startsWith('usage/') && norm.endsWith('.md')) return true
  if (norm.startsWith('logs/')) {
    return norm.endsWith('.log') || norm.endsWith('.jsonl')
  }
  return norm.endsWith('.md')
}

/**
 * Artifact trees are indexed as metadata (name/size/kind), never content —
 * media bytes don't belong in an FTS table.
 */
export function isArtifactPath(rel: string): boolean {
  const norm = rel.split(path.sep).join('/')
  return ARTIFACT_ROOTS.some((root) => norm.startsWith(root))
}

const KIND_BY_EXT: Record<string, string> = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.mp4': 'video',
  '.mov': 'video',
  '.webm': 'video',
  '.mp3': 'audio',
  '.ogg': 'audio',
  '.wav': 'audio',
  '.m4a': 'audio',
  '.pdf': 'pdf',
  '.md': 'text',
  '.txt': 'text',
  '.csv': 'data',
  '.json': 'data',
  '.html': 'text',
  '.docx': 'document',
  '.xlsx': 'spreadsheet',
  '.pptx': 'presentation',
  '.zip': 'archive'
}

export function artifactKind(rel: string): string {
  return KIND_BY_EXT[path.extname(rel).toLowerCase()] ?? 'file'
}

/** conv-<id> directories under uploads/screenshots/speech carry provenance. */
export function artifactConversationId(rel: string): string | null {
  const m = /(?:^|\/)conv-([^/]+)\//.exec(rel.split(path.sep).join('/'))
  return m ? m[1] : null
}

export function buildArtifactRow(rel: string, size: number, mtimeMs: number): ArtifactRow {
  const norm = rel.split(path.sep).join('/')
  return {
    path: norm,
    name: path.basename(norm),
    dir: path.dirname(norm),
    size,
    mtimeMs,
    kind: artifactKind(norm),
    conversationId: artifactConversationId(norm)
  }
}

export function buildArtifactRecord(row: ArtifactRow): IngestRecord {
  return {
    source: 'artifact',
    ref: `file:${row.path}`,
    date: formatYmd(new Date(row.mtimeMs)),
    title: row.name,
    content: `${row.name} (${row.kind}, ${row.size} bytes) at ${row.path}`,
    meta: JSON.stringify({ kind: row.kind, size: row.size, conversationId: row.conversationId })
  }
}

// ── Dispatch ──────────────────────────────────────────────────────────

/**
 * Parse one indexable text file into records (+ structured side rows).
 * Artifact-tree files never reach here — they're stat-indexed only.
 */
export function ingestTextFile(rel: string, raw: string, mtimeMs: number): IngestResult {
  const norm = rel.split(path.sep).join('/')

  if (norm.startsWith('brain/conversations/') && norm.endsWith('.json')) {
    return ingestConversation(norm, raw)
  }
  if (norm === 'whatsapp/read-history.json') {
    return { records: ingestWhatsAppHistory(norm, raw) }
  }
  if (norm.startsWith('brain/motor/tasks/')) {
    return { records: ingestTaskFile(norm, raw, mtimeMs) }
  }
  if (norm.startsWith('brain/basalganglia/')) {
    return { records: chunkLines(norm, raw, 'feedback', FEEDBACK_CHUNK_LINES, dateFromName(norm)) }
  }
  if (norm.startsWith('brain/corpus/')) {
    return { records: chunkLines(norm, raw, 'corpus', LOG_CHUNK_LINES, dateFromName(norm)) }
  }
  if (norm.startsWith('usage/')) {
    return ingestUsage(norm, raw, mtimeMs)
  }
  if (norm.startsWith('logs/')) {
    return { records: ingestLog(norm, raw, mtimeMs) }
  }

  const source: RecordSource = norm.startsWith('brain/hippocampus/episodes/')
    ? 'episode'
    : norm.startsWith('brain/hippocampus/knowledge/')
      ? 'knowledge'
      : norm.startsWith('brain/hippocampus/consolidated/')
        ? 'consolidated'
        : norm.startsWith('brain/reflection/')
          ? 'reflection'
          : 'doc'
  return { records: ingestMarkdown(norm, raw, mtimeMs, source) }
}

// ── Markdown (episodes / knowledge / consolidated / docs) ─────────────

export function ingestMarkdown(
  rel: string,
  raw: string,
  mtimeMs: number,
  source: RecordSource
): IngestRecord[] {
  const date = resolveDate(rel, raw, mtimeMs)
  const sections = splitMarkdownByHeader(raw)
  const out: IngestRecord[] = []
  sections.forEach((sec, i) => {
    if (!sec.section && !sec.content) return
    out.push({
      source,
      ref: `file:${rel}#${i}`,
      date,
      title: sec.section || path.basename(rel, path.extname(rel)),
      content: capContent(sec.content, SECTION_HEAD, SECTION_TAIL),
      meta: null
    })
  })
  return out
}

// ── Conversations ─────────────────────────────────────────────────────

type RawSegment = {
  kind?: string
  name?: string
  args?: Record<string, unknown>
  output?: string
  status?: string
  worker?: { id: string; label: string }
}

type RawMessage = {
  role?: string
  content?: string
  timestamp?: number
  segments?: RawSegment[]
}

type RawConversation = {
  id?: string
  title?: string
  channel?: string
  createdAt?: number
  updatedAt?: number
  sealed?: boolean
  projectId?: string
  icon?: string
  messages?: RawMessage[]
}

/**
 * One record per message plus one per tool call (args + result output
 * excerpt). Ref scheme: `conversation:<id>#<msgIdx>` for messages and
 * `conversation:<id>#<msgIdx>.<toolCallSeq>` for tool activity — the
 * conversation_read tool resolves both back to the JSON on disk.
 */
export function ingestConversation(rel: string, raw: string): IngestResult {
  let parsed: RawConversation
  try {
    parsed = JSON.parse(raw) as RawConversation
  } catch {
    return { records: [] }
  }
  const id = parsed.id ?? path.basename(rel, '.json').replace(/^conv-/, '')
  const title = parsed.title ?? '(untitled)'
  const channel = parsed.channel ?? 'electron'
  const messages = Array.isArray(parsed.messages) ? parsed.messages : []
  const records: IngestRecord[] = []

  messages.forEach((msg, msgIdx) => {
    const date = msg.timestamp ? formatYmd(new Date(msg.timestamp)) : null
    const role = msg.role ?? 'user'
    const text =
      typeof msg.content === 'string' && msg.content.trim().length > 0
        ? msg.content
        : role === 'assistant'
          ? collectSegmentText(msg.segments)
          : ''
    if (text.trim().length > 0) {
      records.push({
        source: 'conversation',
        ref: `conversation:${id}#${msgIdx}`,
        date,
        title: `${title} — ${role}`,
        content: capContent(text.trim(), MESSAGE_HEAD, MESSAGE_TAIL),
        meta: JSON.stringify({ channel, role, conversationId: id, msgIdx })
      })
    }
    let toolSeq = 0
    for (const seg of msg.segments ?? []) {
      if (seg.kind === 'tool_call') {
        const argsText = seg.args ? jsonInline(seg.args, 600) : ''
        records.push({
          source: 'conversation',
          ref: `conversation:${id}#${msgIdx}.${toolSeq}`,
          date,
          title: `${seg.name ?? 'tool'} (call)`,
          content: capContent(`${seg.name ?? 'tool'} ${argsText}`, TOOL_HEAD, TOOL_TAIL),
          meta: JSON.stringify({ channel, conversationId: id, msgIdx, tool: seg.name ?? null })
        })
        toolSeq++
      } else if (seg.kind === 'tool_result' && typeof seg.output === 'string' && seg.output) {
        records.push({
          source: 'conversation',
          ref: `conversation:${id}#${msgIdx}.${toolSeq}`,
          date,
          title: `tool result${seg.status ? ` (${seg.status})` : ''}`,
          content: capContent(seg.output, TOOL_HEAD, TOOL_TAIL),
          meta: JSON.stringify({ channel, conversationId: id, msgIdx })
        })
        toolSeq++
      }
    }
  })

  return {
    records,
    conversation: {
      id,
      title,
      channel,
      createdAt: parsed.createdAt ?? 0,
      updatedAt: parsed.updatedAt ?? 0,
      messageCount: messages.length,
      sizeBytes: raw.length,
      sealed: parsed.sealed ? 1 : 0,
      projectId: parsed.projectId ?? null,
      icon: parsed.icon ?? null
    }
  }
}

function collectSegmentText(segments: RawSegment[] | undefined): string {
  if (!Array.isArray(segments)) return ''
  let out = ''
  for (const seg of segments) {
    if (seg.kind === 'text' && typeof (seg as { delta?: string }).delta === 'string') {
      out += (seg as { delta?: string }).delta
    }
  }
  return out
}

// ── WhatsApp inbound history ──────────────────────────────────────────

const WHATSAPP_CHUNK_MESSAGES = 40

type WhatsAppHistoryMsg = {
  fromMe?: boolean
  sender?: string
  text?: string
  timestamp?: number
}

/**
 * whatsapp/read-history.json: a rolling per-chat buffer of the messages seen
 * on the channel (both directions), keyed by JID. Indexed in per-chat chunks
 * so "what did Sana say on WhatsApp" is a memory_search away. Note the
 * buffer itself is rolling (MAX_PER_CHAT in read-history.ts) — the index
 * mirrors what the buffer currently holds; full exchanges wolffish took part
 * in also persist independently in brain/conversations.
 */
export function ingestWhatsAppHistory(rel: string, raw: string): IngestRecord[] {
  let parsed: Record<string, WhatsAppHistoryMsg[]>
  try {
    parsed = JSON.parse(raw) as Record<string, WhatsAppHistoryMsg[]>
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const out: IngestRecord[] = []
  for (const [jid, msgs] of Object.entries(parsed)) {
    if (!Array.isArray(msgs) || msgs.length === 0) continue
    const chatLabel = jid.split('@')[0]
    for (let i = 0; i < msgs.length; i += WHATSAPP_CHUNK_MESSAGES) {
      const chunk = msgs.slice(i, i + WHATSAPP_CHUNK_MESSAGES)
      const lines: string[] = []
      let lastTs = 0
      for (const m of chunk) {
        const text = typeof m.text === 'string' ? m.text.trim() : ''
        if (!text) continue
        if (typeof m.timestamp === 'number' && m.timestamp > lastTs) lastTs = m.timestamp
        const when =
          typeof m.timestamp === 'number'
            ? formatYmd(new Date(m.timestamp * (m.timestamp < 1e12 ? 1000 : 1)))
            : ''
        const who = m.fromMe ? 'me' : (m.sender ?? 'them')
        lines.push(`[${when}] ${who}: ${text}`)
      }
      if (lines.length === 0) continue
      out.push({
        source: 'conversation',
        ref: `file:${rel}#${jid}#${i}`,
        date: lastTs ? formatYmd(new Date(lastTs * (lastTs < 1e12 ? 1000 : 1))) : null,
        title: `WhatsApp chat ${chatLabel} (messages ${i + 1}-${i + chunk.length})`,
        content: capContent(lines.join('\n'), SECTION_HEAD, SECTION_TAIL),
        meta: JSON.stringify({ channel: 'whatsapp', jid })
      })
    }
  }
  return out
}

// ── Motor tasks ───────────────────────────────────────────────────────

export function ingestTaskFile(rel: string, raw: string, mtimeMs: number): IngestRecord[] {
  const base = path.basename(rel)
  const date = formatYmd(new Date(mtimeMs))

  if (rel.endsWith('-detail.log')) {
    const taskId = base.replace(/^TASK-/, '').replace(/-detail\.log$/, '')
    const out: IngestRecord[] = []
    splitMarkdownByHeader(raw).forEach((sec, i) => {
      if (!sec.content) return
      out.push({
        source: 'task',
        ref: `task:${taskId}#detail${i}`,
        date,
        title: sec.section || `TASK-${taskId} detail`,
        content: capContent(sec.content, TOOL_HEAD, TOOL_TAIL),
        meta: JSON.stringify({ taskId, detail: true })
      })
    })
    return out
  }

  const taskId = path.basename(base, '.md').replace(/^TASK-/, '')
  return [
    {
      source: 'task',
      ref: `task:${taskId}`,
      date,
      title: firstLine(raw).replace(/^#\s*/, '') || `TASK-${taskId}`,
      content: capContent(raw, SECTION_HEAD, SECTION_TAIL * 2),
      meta: JSON.stringify({ taskId })
    }
  ]
}

// ── Line-chunked sources (basalganglia / corpus) ──────────────────────

export function chunkLines(
  rel: string,
  raw: string,
  source: RecordSource,
  chunkSize: number,
  date: string | null
): IngestRecord[] {
  const lines = raw.split(/\r?\n/)
  const out: IngestRecord[] = []
  for (let i = 0; i < lines.length; i += chunkSize) {
    const chunk = lines
      .slice(i, i + chunkSize)
      .join('\n')
      .trim()
    if (!chunk) continue
    out.push({
      source,
      ref: `file:${rel}#L${i + 1}`,
      date,
      title: `${path.basename(rel)} (lines ${i + 1}–${Math.min(i + chunkSize, lines.length)})`,
      content: capContent(chunk, SECTION_HEAD, SECTION_TAIL),
      meta: null
    })
  }
  return out
}

// ── Usage ledger ──────────────────────────────────────────────────────

// `- 14:22:05 | DeepSeek | deepseek-v4-pro | in:1234 out:567 cw:0 cr:89012 | $0.0123`
const USAGE_LINE =
  /^-\s*(\d{2}:\d{2}:\d{2})\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*in:(\d+)\s+out:(\d+)(?:\s+cw:(\d+))?(?:\s+cr:(\d+))?\s*\|\s*\$([\d.]+)/

export function ingestUsage(rel: string, raw: string, mtimeMs: number): IngestResult {
  const day = dateFromName(rel)
  const usageRows: UsageRow[] = []
  if (day) {
    for (const line of raw.split(/\r?\n/)) {
      const m = USAGE_LINE.exec(line)
      if (!m) continue
      usageRows.push({
        ts: `${day}T${m[1]}`,
        provider: m[2],
        model: m[3],
        input: Number(m[4]),
        output: Number(m[5]),
        cacheWrite: m[6] ? Number(m[6]) : 0,
        cacheRead: m[7] ? Number(m[7]) : 0,
        cost: Number(m[8])
      })
    }
  }
  const records: IngestRecord[] = [
    {
      source: 'usage',
      ref: `file:${rel}`,
      date: day ?? formatYmd(new Date(mtimeMs)),
      title: path.basename(rel, '.md'),
      content: capContent(raw, SECTION_HEAD, SECTION_TAIL),
      meta: null
    }
  ]
  return { records, usageRows }
}

// ── App / extension logs ──────────────────────────────────────────────

export function ingestLog(rel: string, raw: string, mtimeMs: number): IngestRecord[] {
  // Only the tail is indexed — recent forensics ("why did X fail") is the
  // use case; deep history is still reachable via file_read/memory_get.
  const tail = raw.length > LOG_TAIL_BYTES ? raw.slice(raw.length - LOG_TAIL_BYTES) : raw
  return [
    {
      source: 'log',
      ref: `file:${rel}`,
      date: dateFromName(rel) ?? formatYmd(new Date(mtimeMs)),
      title: path.basename(rel),
      content: tail,
      meta: JSON.stringify({ totalBytes: raw.length })
    }
  ]
}

// ── Shared helpers ────────────────────────────────────────────────────

export type ParsedSection = {
  date: string | null
  section: string
  content: string
}

export function splitMarkdownByHeader(content: string): ParsedSection[] {
  const lines = content.split(/\r?\n/)
  const sections: ParsedSection[] = []
  let currentHeader = ''
  let buffer: string[] = []

  const flush = (): void => {
    const body = buffer.join('\n').trim()
    if (currentHeader.length > 0 || body.length > 0) {
      sections.push({ date: null, section: currentHeader, content: body })
    }
  }

  for (const line of lines) {
    const match = /^##\s+(.*\S)\s*$/.exec(line)
    if (match) {
      flush()
      currentHeader = match[1]
      buffer = []
    } else {
      buffer.push(line)
    }
  }
  flush()
  return sections
}

/**
 * Resolve the `date` for a markdown file. Priority:
 *   1. `…/episodes/YYYY-MM-DD.md` (or any date-stamped filename) → that day
 *   2. `…/consolidated/YYYY-WNN.md` → week bucket
 *   3. YAML frontmatter `date:` field
 *   4. file mtime
 */
export function resolveDate(relPath: string, raw: string, mtimeMs: number): string {
  const base = path.basename(relPath)
  const segments = relPath.split('/')

  const named = dateFromName(relPath)
  if (named) return named

  if (segments.includes('consolidated')) {
    const m = /^(\d{4})-[Ww](\d{1,2})\.md$/.exec(base)
    if (m) return `${m[1]}-W${m[2].padStart(2, '0')}`
  }

  const fm = parseFrontmatterDate(raw)
  if (fm) return fm

  return formatYmd(new Date(mtimeMs))
}

export function dateFromName(relPath: string): string | null {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(path.basename(relPath))
  return m ? m[1] : null
}

function parseFrontmatterDate(raw: string): string | null {
  if (!raw.startsWith('---')) return null
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return null
  const block = raw.slice(3, end)
  const m = /^\s*date\s*:\s*(.+?)\s*$/im.exec(block)
  if (!m) return null
  const value = m[1].trim().replace(/^['"]|['"]$/g, '')
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return formatYmd(d)
}

export function formatYmd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function firstLine(raw: string): string {
  const idx = raw.indexOf('\n')
  return (idx < 0 ? raw : raw.slice(0, idx)).trim()
}

function jsonInline(value: unknown, cap: number): string {
  try {
    const s = JSON.stringify(value)
    return s.length > cap ? s.slice(0, cap) + '…' : s
  } catch {
    return ''
  }
}
