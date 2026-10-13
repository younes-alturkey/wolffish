import { getDb } from '@/lib/db/database'
import type {
  ConversationChannel,
  ConversationFile,
  ConversationMessage,
  ConversationMeta,
  ConversationStats
} from '@/lib/conversations/types'

/**
 * SQLite-backed conversation repository — the mobile mirror of the desktop's
 * conversations directory. Metadata lives in columns (instant list queries at
 * hundreds of conversations); everything message-shaped beyond the core
 * columns rides in payload_json so unknown future fields round-trip intact.
 */

type ConversationRow = {
  id: string
  title: string
  model: string | null
  channel: string | null
  icon: string | null
  project_id: string | null
  sealed: number
  created_at: number
  updated_at: number
  message_count: number
  stats_json: string | null
  summary: string | null
}

type MessageRow = {
  id: string
  role: string
  content: string
  timestamp: number
  payload_json: string | null
}

type MessagePayload = Omit<ConversationMessage, 'id' | 'role' | 'content' | 'timestamp'>

function rowToMeta(row: ConversationRow): ConversationMeta {
  return {
    id: row.id,
    title: row.title,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    channel: (row.channel as ConversationChannel | null) ?? undefined,
    projectId: row.project_id ?? undefined,
    icon: row.icon ?? undefined,
    messageCount: row.message_count
  }
}

function rowToMessage(row: MessageRow): ConversationMessage {
  let payload: MessagePayload = {}
  if (row.payload_json) {
    try {
      payload = JSON.parse(row.payload_json) as MessagePayload
    } catch {
      // Corrupt payload — keep the core fields rather than dropping the message.
    }
  }
  return {
    ...payload,
    id: row.id,
    role: row.role === 'user' ? 'user' : 'assistant',
    content: row.content,
    timestamp: row.timestamp
  }
}

function messagePayload(message: ConversationMessage): string | null {
  const { id: _id, role: _role, content: _content, timestamp: _timestamp, ...rest } = message
  const keys = Object.keys(rest) as Array<keyof MessagePayload>
  const payload: Record<string, unknown> = {}
  for (const key of keys) {
    if (rest[key] !== undefined) payload[key] = rest[key]
  }
  return Object.keys(payload).length > 0 ? JSON.stringify(payload) : null
}

export async function listConversations(): Promise<ConversationMeta[]> {
  const db = await getDb()
  const rows = await db.getAllAsync<ConversationRow>(
    'SELECT * FROM conversations ORDER BY updated_at DESC'
  )
  return rows.map(rowToMeta)
}

export async function countConversations(): Promise<number> {
  const db = await getDb()
  const row = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM conversations')
  return row?.n ?? 0
}

export async function getConversation(id: string): Promise<ConversationFile | null> {
  const db = await getDb()
  const row = await db.getFirstAsync<ConversationRow>(
    'SELECT * FROM conversations WHERE id = ?',
    id
  )
  if (!row) return null
  const messageRows = await db.getAllAsync<MessageRow>(
    'SELECT id, role, content, timestamp, payload_json FROM messages WHERE conversation_id = ? ORDER BY seq ASC',
    id
  )
  // Opening a conversation marks it recently used — the release policy in
  // lib/files spares recently opened conversations' media.
  void db.runAsync('UPDATE conversations SET last_opened_at = ? WHERE id = ?', Date.now(), id)

  let stats: ConversationStats | null = null
  if (row.stats_json) {
    try {
      stats = JSON.parse(row.stats_json) as ConversationStats
    } catch {
      stats = null
    }
  }
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    messages: messageRows.map(rowToMessage),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    channel: (row.channel as ConversationChannel | null) ?? undefined,
    projectId: row.project_id ?? undefined,
    icon: row.icon ?? undefined,
    sealed: row.sealed === 1,
    stats,
    summary: row.summary
  }
}

/** Insert or fully replace a conversation (demo import + sync ingestion). */
export async function upsertConversation(file: ConversationFile): Promise<void> {
  const db = await getDb()
  await db.withExclusiveTransactionAsync(async (tx) => {
    await tx.runAsync(
      `INSERT OR REPLACE INTO conversations
        (id, title, model, channel, icon, project_id, sealed, created_at, updated_at,
         message_count, stats_json, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      file.id,
      file.title,
      file.model,
      file.channel ?? null,
      file.icon ?? null,
      file.projectId ?? null,
      file.sealed ? 1 : 0,
      file.createdAt,
      file.updatedAt,
      file.messages.length,
      file.stats ? JSON.stringify(file.stats) : null,
      file.summary ?? null
    )
    await tx.runAsync('DELETE FROM messages WHERE conversation_id = ?', file.id)
    let seq = 0
    for (const message of file.messages) {
      await tx.runAsync(
        `INSERT INTO messages (conversation_id, seq, id, role, content, timestamp, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        file.id,
        seq,
        message.id ?? `m_${message.timestamp}_${seq}`,
        message.role,
        message.content,
        message.timestamp,
        messagePayload(message)
      )
      seq += 1
    }
  })
}

/** Append one message (send flow). Bumps updated_at + message_count. */
export async function appendMessage(
  conversationId: string,
  message: ConversationMessage
): Promise<void> {
  const db = await getDb()
  await db.withExclusiveTransactionAsync(async (tx) => {
    const row = await tx.getFirstAsync<{ next: number }>(
      'SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM messages WHERE conversation_id = ?',
      conversationId
    )
    const seq = row?.next ?? 0
    await tx.runAsync(
      `INSERT INTO messages (conversation_id, seq, id, role, content, timestamp, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      conversationId,
      seq,
      message.id ?? `m_${message.timestamp}_${seq}`,
      message.role,
      message.content,
      message.timestamp,
      messagePayload(message)
    )
    await tx.runAsync(
      'UPDATE conversations SET updated_at = ?, message_count = message_count + 1 WHERE id = ?',
      message.timestamp,
      conversationId
    )
  })
}

/**
 * Replace the conversation's stats block. The desktop rewrites the whole
 * block at each turn fold (channels/turn-stats.ts), so this is a whole-value
 * write too — the caller reads, accumulates, and hands back the new block.
 */
export async function updateConversationStats(
  conversationId: string,
  stats: ConversationStats
): Promise<void> {
  const db = await getDb()
  await db.runAsync(
    'UPDATE conversations SET stats_json = ? WHERE id = ?',
    JSON.stringify(stats),
    conversationId
  )
}

/** File a conversation under a project, or unfile it with null. */
export async function setConversationProject(
  conversationId: string,
  projectId: string | null
): Promise<void> {
  const db = await getDb()
  await db.runAsync(
    'UPDATE conversations SET project_id = ? WHERE id = ?',
    projectId,
    conversationId
  )
}

/** Read just the stats block — the accumulate-then-write path's first half. */
export async function getConversationStats(
  conversationId: string
): Promise<ConversationStats | null> {
  const db = await getDb()
  const row = await db.getFirstAsync<{ stats_json: string | null }>(
    'SELECT stats_json FROM conversations WHERE id = ?',
    conversationId
  )
  if (!row?.stats_json) return null
  try {
    return JSON.parse(row.stats_json) as ConversationStats
  } catch {
    return null
  }
}

/**
 * Live-mirror upsert: a mid-turn message snapshot from the desktop replaces
 * its earlier self by message id, or appends on first sight — the phone-side
 * twin of the desktop renderer's mirror reconciliation ("same stable id, so
 * upsert never duplicates"). The end-of-turn refetch then overwrites the
 * whole body with the authoritative copy under the same id.
 */
export async function upsertMessage(
  conversationId: string,
  message: ConversationMessage
): Promise<'appended' | 'replaced' | 'skipped'> {
  if (!message.id) return 'skipped'
  const db = await getDb()
  const result = await db.runAsync(
    `UPDATE messages SET content = ?, timestamp = ?, payload_json = ?
     WHERE conversation_id = ? AND id = ?`,
    message.content,
    message.timestamp,
    messagePayload(message),
    conversationId,
    message.id
  )
  if ((result?.changes ?? 0) > 0) return 'replaced'
  await appendMessage(conversationId, message)
  return 'appended'
}

/** Replace one message in place (streaming placeholder → final persist). */
export async function replaceMessage(
  conversationId: string,
  message: ConversationMessage
): Promise<void> {
  if (!message.id) return
  const db = await getDb()
  await db.runAsync(
    `UPDATE messages SET content = ?, timestamp = ?, payload_json = ?
     WHERE conversation_id = ? AND id = ?`,
    message.content,
    message.timestamp,
    messagePayload(message),
    conversationId,
    message.id
  )
}

export async function createConversation(file: ConversationFile): Promise<void> {
  await upsertConversation(file)
}

export async function renameConversation(id: string, title: string): Promise<void> {
  const db = await getDb()
  await db.runAsync('UPDATE conversations SET title = ? WHERE id = ?', title, id)
}

/**
 * Conversations created at or after a cutoff — the desktop's
 * countConversationsSince, answered from the same column the list sorts on.
 * The Usage screen pairs this with the ledger rows the config snapshot
 * carries; everything else on that screen comes from those rows.
 */
export async function countConversationsSince(cutoffMs: number): Promise<number> {
  const db = await getDb()
  const row = await db.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) AS n FROM conversations WHERE created_at >= ?',
    cutoffMs
  )
  return row?.n ?? 0
}

export async function deleteConversation(id: string): Promise<void> {
  const db = await getDb()
  await db.withExclusiveTransactionAsync(async (tx) => {
    await tx.runAsync('DELETE FROM messages WHERE conversation_id = ?', id)
    await tx.runAsync('DELETE FROM conversations WHERE id = ?', id)
  })
}
