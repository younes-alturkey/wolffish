import { diskWriter } from '@main/io/diskWriter'
import type { Segment, SegmentTurnEndReason } from '@main/runtime/broca'
import { keepLatestBrowserCard } from './runtime/browser-card'
import type { NoProviderAvailableInfo } from '@main/runtime/thalamus'
import { workspaceRoot } from '@main/workspace/root'
import type { PersistedApproval, PersistedToolTiming } from '@preload/index'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export type MessageAttachmentType = 'audio' | 'video' | 'image' | 'pdf' | 'other'

export type MessageAttachment = {
  type: MessageAttachmentType
  /** Path relative to workspace root, e.g. "uploads/conv-2026-05-01_14-30-45/photo.png". */
  filePath: string
  originalName: string
  mimeType: string
  sizeBytes: number
  width?: number
  height?: number
  durationSeconds?: number
}

export type ConversationMessage = {
  /**
   * Stable per-message identity, unique within one conversation (shape
   * `m_<ts>_<rand>` — the renderer's cryptoId and mintMessageId below both
   * produce it). THE reconciliation key: mergeConversationOnto unions two
   * copies of a transcript by id, which is what lets two writers append
   * different messages at the same index (a Telegram message landing while
   * an in-app turn runs) without one clobbering the other — counts and
   * content can't tell divergence from agreement, ids can. Optional only
   * for files written before the field shipped — a straggler (e.g. a
   * restored backup) degrades to the merge's positional pairing, the
   * pre-id rules — and every writer stamps one at creation. When one
   * logical message has several pre-persist writers (the renderer's send,
   * the titler shell), they must all stamp the SAME id — see userMessageId
   * threading in turn-runner.ts.
   */
  id?: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  attachments?: MessageAttachment[]
  /**
   * True when this user message originated from a transcribed voice
   * note (Telegram's press-and-hold mic). The transcript IS the
   * prompt — the audio attachment is preserved on disk for chat
   * replay only and must NOT be re-exposed to the LLM as additional
   * context. The Telegram history builder reads this flag to decide
   * whether to emit the attachments + `<attachments>` metadata block
   * to the agent. Absent / false on every other message kind,
   * including non-voice audio uploads (those go through the normal
   * media path and DO surface to the LLM).
   */
  voicePrompt?: boolean
  /**
   * For a voice-note user message, the language Whisper detected in the
   * audio (ISO 639-1, e.g. "en", "ar"). Threaded into the `<voice_note
   * lang="…">` history tag so the model has a deterministic signal of
   * which language to reply in — Whisper's detection beats the model
   * guessing from a short transcript. Absent when detection returned
   * nothing or for non-voice messages.
   */
  voiceLang?: string
  /**
   * A user-role message the app wrote (the "Continue" after a stalled
   * provider call): history-wise a user turn, rendered as a muted note.
   */
  systemAside?: boolean
  /**
   * Full segment stream for assistant messages — text deltas, tool
   * calls, tool results, active_model chips, turn_end. Saved by the
   * Electron channel (via the renderer's persistConversation) and
   * the Telegram channel both, so the in-app history view replays
   * the exact sequence the user saw, with tool cards, approvals,
   * and timing intact.
   */
  segments?: Segment[]
  approvals?: Record<string, PersistedApproval>
  toolTimings?: Record<string, PersistedToolTiming>
  stopReason?: SegmentTurnEndReason
  error?: string
  /**
   * Set on an assistant message written by a MID-TURN checkpoint — the turn
   * was still running when this copy hit disk (see channels/turn-checkpoint.ts).
   * Cleared by the checkpoint's own final flush and absent from every fold the
   * renderer or a channel writes, so it survives exactly one way: the process
   * died before the turn ended. That makes it the honest marker for "this
   * answer is as far as the run got", and the only field the checkpoint's
   * upsert refuses to preserve from disk.
   */
  interrupted?: boolean
}

/**
 * Where the conversation originated. `electron` is the in-app chat;
 * `telegram` is the Telegram bot. Optional for backward compatibility
 * with conversation files written before the field shipped — those
 * are treated as `electron` by default.
 */
export type ConversationChannel =
  | 'electron'
  | 'telegram'
  | 'whatsapp'
  | 'mobile'
  | 'cli'
  | 'heartbeat'
  | 'procedure'

export type TimelineEntry = {
  id: string
  timestamp: number
  kind: string
  summary?: string
  detail?: string
}

/** Frozen roll-up of the most recent completed turn (dual decl — see src/preload/index.ts). */
export type ConversationTurnStats = {
  endedAt: number
  elapsedMs: number
  apiMs: number
  apiCalls: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  cost: number
  provider: string | null
  model: string | null
}

/**
 * Persisted per-conversation tokenomics (dual decl — see src/preload/index.ts).
 * Written by the renderer alongside messages; the context-meter card restores
 * from it on reopen so all-time totals, the last turn's elapsed/token split
 * and the meter reading survive restarts.
 */
export type ConversationStats = {
  allTime: {
    processingMs: number
    apiMs: number
    turns: number
    apiCalls: number
    toolCalls: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    cost: number
  }
  lastTurn: ConversationTurnStats | null
  meter: {
    contextTokens: number
    contextBudget: number
    compactionAt?: number | null
    model?: string | null
  } | null
}

export type ConversationFile = {
  id: string
  title: string
  model: string | null
  messages: ConversationMessage[]
  createdAt: number
  updatedAt: number
  channel?: ConversationChannel
  /** Binds this conversation to a project — its turns get the project overlay. */
  projectId?: string
  /** Source emoji (automation/procedure icon) for the rail's number-chip badge. */
  icon?: string
  sealed?: boolean
  workingFolder?: string[] | null
  /**
   * Reference files this conversation's turns are told about (name, size,
   * path) and read with their own tools — never injected. Seeded by a
   * procedure's Play button from the procedure's own attachments, so a run
   * started in chat sees exactly what a detached run of it would.
   */
  contextFiles?: string[] | null
  /** Legacy meter snapshot — superseded by `stats.meter`, still read as a fallback. */
  contextMeter?: { contextTokens: number; contextBudget: number } | null
  stats?: ConversationStats | null
  timeline?: TimelineEntry[]
  /**
   * Rolling prefix summary of messages[0..summarizedThroughMessage-1],
   * written by the post-turn summarizer when a conversation outgrows
   * verbatim replay. Both rebuild paths (renderer textHistory + channel
   * assistantSegmentsToHistory) replay `summary + messages from the mark`
   * instead of the whole transcript — a long conversation pays ONE
   * summarization ever (until it grows again), not a fresh compaction LLM
   * call every turn. Summarized turns stay on disk and indexed:
   * conversation_read retrieves them verbatim.
   */
  summary?: string | null
  /**
   * First message index NOT covered by `summary` (always a user message).
   * Legacy positional form — superseded by `summarizedThroughMessageId` but
   * still written alongside it (and still read as the fallback when the id
   * is absent or doesn't resolve). See resolveSummaryMarkIndex.
   */
  summarizedThroughMessage?: number | null
  /**
   * Id of the first message NOT covered by `summary`. The id form survives
   * what the index form can't: an id-keyed merge may insert messages BEFORE
   * the mark (a diverged writer reconciled in), which silently shifts a
   * positional mark and corrupts what the rolling summary claims to cover.
   * Written by the summarizer with every new mark; consumers resolve it via
   * resolveSummaryMarkIndex and fall back to the numeric mark for files the
   * summarizer hasn't touched since the field shipped.
   */
  summarizedThroughMessageId?: string | null
}

export type ConversationMeta = {
  id: string
  title: string
  updatedAt: number
  channel?: ConversationChannel
  projectId?: string
  /** Source emoji (automation/procedure icon) for the rail's number-chip badge. */
  icon?: string
  /**
   * Number of saved messages on the conversation. Surfaced so list
   * views (Telegram /resume, /delete picker) can show it without
   * having to load each file separately.
   */
  messageCount: number
}

function conversationsDir(): string {
  return path.join(workspaceRoot(), 'brain', 'conversations')
}

/**
 * The single source of truth for the per-conversation directory name.
 * The conversation file itself is `${conversationDirName(id)}.json`, and
 * uploads/voice/speech directories are `<dir>/${conversationDirName(id)}/`
 * so a quick glance at any of them tells you the same conversation.
 *
 * Defensive replacement of unsafe characters: ids are timestamps in normal
 * use, but we treat them as untrusted in case the format changes later or
 * a foreign id leaks in from outside.
 */
export function conversationDirName(id: string): string {
  const safe = (id ?? '').replace(/[^A-Za-z0-9._-]/g, '_')
  return `conv-${safe}`
}

function filePathForId(id: string): string {
  return path.join(conversationsDir(), `${conversationDirName(id)}.json`)
}

/**
 * The conversation id a stored filename names, or null for anything else in
 * the directory (upload/voice subdirectories, strays). Exported for the
 * corpus's post-write signal: `conversation.indexed` carries a workspace-
 * relative PATH, and the mobile push it feeds needs the id back out of it.
 */
export function idFromFilename(filename: string): string | null {
  const match = filename.match(/^conv-(.+)\.json$/)
  return match ? match[1] : null
}

function generateId(): string {
  const now = new Date()
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0')
  const stamp = [
    now.getFullYear(),
    '-',
    pad(now.getMonth() + 1),
    '-',
    pad(now.getDate()),
    '_',
    pad(now.getHours()),
    '-',
    pad(now.getMinutes()),
    '-',
    pad(now.getSeconds())
  ].join('')
  // The id IS the on-disk filename, so it MUST be unique. A second-resolution
  // timestamp alone collides whenever two conversations are created in the same
  // second — e.g. a procedure/automation run firing while a live chat is open —
  // and the second save silently overwrites the first (destroying a whole
  // conversation). Append milliseconds + a random suffix so collisions can't
  // happen; the readable timestamp prefix is kept for human-legible filenames.
  return `${stamp}_${pad(now.getMilliseconds(), 3)}-${randomBytes(3).toString('hex')}`
}

/**
 * Mint a message id — same `m_<ts>_<rand>` shape the renderer's cryptoId
 * produces, so ids look identical no matter which writer stamped them.
 * Uniqueness scope is one conversation: the random suffix keeps two
 * messages minted in the same millisecond distinct.
 */
export function mintMessageId(timestamp?: number): string {
  return `m_${timestamp ?? Date.now()}_${randomBytes(3).toString('hex')}`
}

/**
 * Resolve a conversation's rolling-summary mark to an index into `messages`:
 * the id form wins when it resolves (it survives id-keyed merges that insert
 * messages before the boundary), the legacy numeric form is the fallback.
 * Callers keep their existing out-of-range guards — a mark at/beyond the
 * array degrades to full replay, never to everything-skipped.
 */
export function resolveSummaryMarkIndex(
  messages: ConversationMessage[],
  mark: number | null | undefined,
  markId: string | null | undefined
): number {
  if (markId) {
    const idx = messages.findIndex((m) => m.id === markId)
    if (idx >= 0) return idx
  }
  return mark ?? 0
}

export async function countConversationsSince(sinceMs: number): Promise<number> {
  const dir = conversationsDir()
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return 0
  }
  let count = 0
  for (const entry of entries) {
    const id = idFromFilename(entry)
    if (!id) continue
    try {
      const raw = await fs.readFile(path.join(dir, entry), 'utf8')
      const conv = JSON.parse(raw) as ConversationFile
      if (conv.createdAt >= sinceMs) count++
    } catch {
      continue
    }
  }
  return count
}

export async function listConversations(): Promise<ConversationMeta[]> {
  const dir = conversationsDir()
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }

  const metas: ConversationMeta[] = []
  for (const entry of entries) {
    const id = idFromFilename(entry)
    if (!id) continue
    try {
      const raw = await fs.readFile(path.join(dir, entry), 'utf8')
      const conv = JSON.parse(raw) as ConversationFile
      metas.push({
        id: conv.id,
        title: conv.title,
        updatedAt: conv.updatedAt,
        channel: conv.channel,
        projectId: conv.projectId,
        icon: conv.icon,
        messageCount: conv.messages?.length ?? 0
      })
    } catch {
      continue
    }
  }

  metas.sort((a, b) => b.updatedAt - a.updatedAt)
  return metas
}

export async function loadConversation(id: string): Promise<ConversationFile | null> {
  try {
    const raw = await fs.readFile(filePathForId(id), 'utf8')
    const conv = JSON.parse(raw) as ConversationFile
    migrateSegments(conv)
    return conv
  } catch {
    return null
  }
}

/**
 * Timestamp of the newest persisted message in a conversation, EXCLUDING the
 * message with `excludeMessageId` — the turn runner's "when did we last talk"
 * probe behind the conversation-resumed runtime notice.
 *
 * The exclusion is what makes the answer uniform across writers: channels
 * persist the CURRENT inbound message before dispatching its turn (so the
 * newest message on disk is the one being answered, gap ≈ 0), while the in-app
 * renderer persists only at end of turn (so it isn't there yet). Passing the
 * turn's own userMessageId skips it wherever it happens to be, leaving the
 * genuine previous exchange either way. Missing file, empty transcript, or a
 * transcript that is only the current message → null (no previous exchange).
 */
export async function lastConversationMessageAt(
  id: string,
  excludeMessageId?: string
): Promise<number | null> {
  const conv = await loadConversation(id)
  if (!conv) return null
  let latest = 0
  for (const m of conv.messages ?? []) {
    if (excludeMessageId && m.id === excludeMessageId) continue
    if (typeof m.timestamp === 'number' && m.timestamp > latest) latest = m.timestamp
  }
  return latest > 0 ? latest : null
}

/**
 * Normalize legacy segment shapes so the renderer never needs to
 * check for old field names.
 *
 * - `providerError` (singular object) → `providerErrors` (array)
 */
function migrateSegments(conv: ConversationFile): void {
  for (const msg of conv.messages) {
    if (!msg.segments) continue
    for (const seg of msg.segments) {
      if (seg.kind !== 'turn_end') continue
      const raw = seg as Record<string, unknown>
      if (raw.providerError && !seg.providerErrors) {
        seg.providerErrors = [raw.providerError as NoProviderAvailableInfo]
        delete raw.providerError
      }
    }
  }
}

export async function saveConversation(conv: ConversationFile): Promise<void> {
  // Whole-file saves from EVERY writer (channels' end-of-turn copies,
  // autonomous runs) ride the same merge policy as the renderer's
  // conversation:save — inside the file's write queue, so a stale full copy
  // can never shrink the transcript or clobber the fields other writers own
  // (title, summary, channel — see mergeConversationOnto).
  await updateConversation(conv.id, (disk) => mergeConversationOnto(disk, conv))
}

/**
 * Read-modify-write a conversation INSIDE its file's write queue, so
 * concurrent writers (a channel's end-of-turn append, the summarizer, the
 * renderer's whole-file save) can never lose each other's changes by both
 * loading the same stale copy. `mutate` gets the freshest on-disk state
 * (null when the file doesn't exist yet) and returns what to persist — or
 * null to skip the write. Unparseable files surface as null too, so a
 * mutate can choose to rebuild rather than crash.
 */
export async function updateConversation(
  id: string,
  mutate: (current: ConversationFile | null) => ConversationFile | null
): Promise<void> {
  await diskWriter.update(filePathForId(id), (raw) => {
    let current: ConversationFile | null = null
    if (raw !== null) {
      try {
        current = JSON.parse(raw) as ConversationFile
        migrateSegments(current)
      } catch {
        current = null
      }
    }
    const next = mutate(current)
    if (next === null) return null
    return JSON.stringify(next, null, 2)
  })
}

/**
 * Merge two copies of one transcript by MESSAGE ID — the union that lets two
 * writers append different messages at the same index (a Telegram message
 * landing while an in-app turn runs) without either clobbering the other.
 * Counts can't tell that divergence from agreement; ids can.
 *
 * Invariants (property-tested in channels/__tests__/message-id-merge.test.ts):
 *  - no message present on either side is ever dropped,
 *  - no duplicate ids in the output (corrupt duplicate inputs are deduped,
 *    first occurrence wins),
 *  - a message on BOTH sides (same id) keeps the INCOMING copy — content
 *    rewrites stay caller-owned, exactly today's titler-shell-vs-renderer
 *    semantics,
 *  - disk order is the spine; an incoming-only message is placed right after
 *    its anchor — the nearest incoming message before it that the disk also
 *    holds (the paired-prefix boundary when there is none) — and BEFORE any
 *    disk-only messages that follow the same anchor. Tail rule: with no
 *    shared anchor in the tails, incoming-only messages precede disk-only
 *    ones, so a renderer save that raced a channel append yields
 *    `common prefix + renderer turn + channel message` — the feed the
 *    renderer already shows stays a positional prefix of the file, which is
 *    what keeps its disk-tail sync an append.
 *
 * Id-less messages (written before ids shipped) are NEVER matched by content
 * or timestamp — both were tried and both shipped corruption (one
 * permanently duplicated the opening message of 17 real conversations).
 * Positional pairing is allowed only along the common prefix while both
 * sides agree on (role, id-absence) — or carry the same id; at the first
 * mismatch every remaining id-less message is treated as distinct.
 */
function mergeMessages(
  disk: ConversationMessage[],
  incoming: ConversationMessage[]
): ConversationMessage[] {
  // Fully id-less on both sides (pre-id file + pre-id caller copy): keep the
  // legacy semantics verbatim — the caller's array wins wholesale, except a
  // SHRINK, which marks a stale copy (a remounted Chat re-seeded from an old
  // session descriptor; 2026-07-17: a completed retry turn was erased exactly
  // that way). Turns append and deletes remove whole files, so no legitimate
  // writer ever shrinks a transcript.
  const anyId = disk.some((m) => m.id) || incoming.some((m) => m.id)
  if (!anyId) return incoming.length < disk.length ? disk : incoming

  // Corrupt-input guard: a duplicate id WITHIN one side keeps its first
  // occurrence only, so the union below can treat ids as keys.
  const dedupe = (arr: ConversationMessage[]): ConversationMessage[] => {
    const seen = new Set<string>()
    const out: ConversationMessage[] = []
    for (const m of arr) {
      if (m.id) {
        if (seen.has(m.id)) continue
        seen.add(m.id)
      }
      out.push(m)
    }
    return out
  }
  const d = dedupe(disk)
  const inc = dedupe(incoming)

  // Paired prefix: same id, or same role with ids absent on BOTH sides.
  let p = 0
  while (p < d.length && p < inc.length) {
    const a = d[p]
    const b = inc[p]
    if (a.role !== b.role) break
    if (a.id && b.id && a.id === b.id) {
      p++
      continue
    }
    if (!a.id && !b.id) {
      p++
      continue
    }
    break
  }
  const out: ConversationMessage[] = inc.slice(0, p)

  // Id-union of the tails: disk order as spine, incoming-only messages
  // grouped under the nearest preceding shared anchor ('' = the prefix
  // boundary) and emitted right after it.
  const dTail = d.slice(p)
  const iTail = inc.slice(p)
  const dTailIds = new Set<string>()
  for (const m of dTail) if (m.id) dTailIds.add(m.id)
  const incomingById = new Map<string, ConversationMessage>()
  for (const m of iTail) if (m.id) incomingById.set(m.id, m)

  const groups = new Map<string, ConversationMessage[]>()
  let anchor = ''
  for (const m of iTail) {
    if (m.id && dTailIds.has(m.id)) {
      anchor = m.id
      continue
    }
    const group = groups.get(anchor)
    if (group) group.push(m)
    else groups.set(anchor, [m])
  }

  const headGroup = groups.get('')
  if (headGroup) out.push(...headGroup)
  for (const dm of dTail) {
    if (dm.id && incomingById.has(dm.id)) {
      out.push(incomingById.get(dm.id)!)
      const followers = groups.get(dm.id)
      if (followers) out.push(...followers)
    } else {
      out.push(dm)
    }
  }
  return out
}

/**
 * Where one side's rolling summary reaches in the MERGED transcript, plus
 * the id that pins that boundary. Resolution order: the side's mark id, then
 * the id of the message its numeric mark pointed at in its OWN array, then
 * the raw numeric mark (id-less transition files). Null when the side has no
 * summary coverage at all.
 */
function summaryCoverage(
  side: ConversationFile,
  mergedMessages: ConversationMessage[]
): { idx: number; id: string | null } | null {
  if (!side.summary) return null
  if (side.summarizedThroughMessageId) {
    const idx = mergedMessages.findIndex((m) => m.id === side.summarizedThroughMessageId)
    if (idx >= 0) return { idx, id: side.summarizedThroughMessageId }
  }
  const mark = side.summarizedThroughMessage ?? 0
  if (mark <= 0) return null
  const uncovered = side.messages[mark]
  if (uncovered?.id) {
    const idx = mergedMessages.findIndex((m) => m.id === uncovered.id)
    if (idx >= 0) return { idx, id: uncovered.id! }
  }
  return { idx: mark, id: null }
}

/**
 * Merge a full in-memory copy over the on-disk state, preserving the fields
 * that OTHER writers own when the incoming copy is staler than the disk:
 *  - `messages` is an id-keyed union (see mergeMessages): appends from both
 *    sides survive, same-id content rewrites stay caller-owned, and fully
 *    id-less inputs keep the legacy caller-wins-except-shrink rule,
 *  - the conversation's channel — its provenance — is never cleared,
 *  - the rolling prefix summary (written by the post-turn summarizer) wins
 *    by whichever side's mark covers MORE of the merged transcript, and the
 *    kept mark is re-anchored onto the merged array (both the id and the
 *    numeric index) so an insertion before the boundary can't silently
 *    shift what the summary claims to cover,
 *  - a real on-disk title beats an incoming 'Untitled'.
 * Everything else — stats, timeline — belongs to the caller's copy.
 */
export function mergeConversationOnto(
  disk: ConversationFile | null,
  incoming: ConversationFile
): ConversationFile {
  if (!disk) return incoming
  const merged: ConversationFile = { ...incoming }
  merged.messages = keepLatestBrowserCard(mergeMessages(disk.messages, incoming.messages))
  // `channel` belongs to whichever writer created the conversation; a caller
  // that simply doesn't carry it must not erase it. The renderer's load-failure
  // fallback (ensureConversationId) builds a copy with no channel at all, and
  // letting that through would silently reclassify a Telegram conversation as
  // in-app: gone from /resume, wrong icon in the rail, mapping left dangling.
  if (disk.channel && !incoming.channel) merged.channel = disk.channel
  // Same provenance rule for the project binding: a writer that doesn't carry
  // it (titler shell, channel end-of-turn copies) must not strip it.
  if (disk.projectId && !incoming.projectId) merged.projectId = disk.projectId
  // And for the source-emoji stamp (automation/procedure icon on the rail badge).
  if (disk.icon && !incoming.icon) merged.icon = disk.icon
  const diskCov = summaryCoverage(disk, merged.messages)
  const incomingCov = summaryCoverage(incoming, merged.messages)
  const winner =
    diskCov && (!incomingCov || diskCov.idx > incomingCov.idx)
      ? { side: disk, cov: diskCov }
      : incomingCov
        ? { side: incoming, cov: incomingCov }
        : null
  if (winner) {
    merged.summary = winner.side.summary
    merged.summarizedThroughMessage = winner.cov.idx
    merged.summarizedThroughMessageId = winner.cov.id ?? merged.messages[winner.cov.idx]?.id ?? null
  }
  if (incoming.title === 'Untitled' && disk.title && disk.title !== 'Untitled') {
    merged.title = disk.title
  }
  return merged
}

export async function deleteConversation(id: string): Promise<void> {
  await diskWriter.deleteFile(filePathForId(id))

  // Clean up the per-conversation media folders so a deleted chat doesn't
  // leave orphan files on disk. Best-effort: any folder that's missing or
  // unreadable is silently skipped.
  const dir = conversationDirName(id)
  const root = workspaceRoot()
  for (const subroot of ['uploads', 'voice', 'speech', path.join('generations', 'video')]) {
    await fs.rm(path.join(root, subroot, dir), { recursive: true, force: true }).catch(() => {
      // best-effort
    })
  }
}

export function createConversation(model: string | null): ConversationFile {
  const now = Date.now()
  return {
    id: generateId(),
    title: 'Untitled',
    model,
    messages: [],
    createdAt: now,
    updatedAt: now
  }
}

// Conversation titling is no longer a heuristic here — a pure LLM call to the
// chosen model produces the title up front, in the TurnRunner, before a turn
// processes (see conversation-titler.ts). This module stays the pure data
// layer.
