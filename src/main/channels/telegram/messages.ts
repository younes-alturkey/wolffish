import { diskWriter } from '@main/io/diskWriter'
import { workspaceRoot } from '@main/workspace/workspace'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Persistent per-chat list of Telegram message ids the bot has sent
 * or received. /clear iterates these and asks Telegram to delete
 * each. Lives at `workspace/telegram/message-ids.json` so the
 * tracker survives app restarts — without persistence, a user
 * accumulating a week of messages and then running /clear would
 * only clear what was tracked since the latest launch.
 *
 * Writes are debounced (the chat is chatty; flushing on every
 * track call would thrash the disk) with a final synchronous-ish
 * flush exposed via flushMessageIds() that the channel calls on
 * bot stop. The cache is module-level so the same in-memory state
 * is shared across the channel's lifecycle.
 */

const MAX_PER_CHAT = 500
const FLUSH_DEBOUNCE_MS = 2000

let cache: Map<number, number[]> | null = null
let flushTimer: NodeJS.Timeout | null = null
let dirty = false

function dir(): string {
  return path.join(workspaceRoot(), 'telegram')
}

function filePath(): string {
  return path.join(dir(), 'message-ids.json')
}

/**
 * Read the persisted ids into the in-memory cache. Idempotent —
 * subsequent calls are no-ops once the cache is populated. Called
 * from TelegramChannel.start() so the cache is ready before any
 * track / take.
 */
export async function loadMessageIds(): Promise<void> {
  if (cache) return
  try {
    const raw = await fs.readFile(filePath(), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const m = new Map<number, number[]>()
    for (const [k, v] of Object.entries(parsed)) {
      const id = Number(k)
      if (!Number.isFinite(id) || !Array.isArray(v)) continue
      const ids = v.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
      if (ids.length > 0) {
        m.set(id, ids.slice(-MAX_PER_CHAT))
      }
    }
    cache = m
  } catch {
    cache = new Map()
  }
}

/**
 * Append a message id to the chat's list. FIFO-capped at
 * MAX_PER_CHAT so a long-running bot doesn't grow the file
 * unbounded. Schedules a debounced disk flush.
 */
export function recordMessageId(chatId: number, messageId: number): void {
  if (!cache) return
  if (!Number.isFinite(messageId)) return
  let ids = cache.get(chatId)
  if (!ids) {
    ids = []
    cache.set(chatId, ids)
  }
  ids.push(messageId)
  if (ids.length > MAX_PER_CHAT) {
    ids.splice(0, ids.length - MAX_PER_CHAT)
  }
  scheduleFlush()
}

/**
 * Drain the chat's tracked ids and return them. Used by /clear:
 * caller iterates the result and calls bot.api.deleteMessage for
 * each. Schedules a flush so the empty list lands on disk.
 */
export function takeMessageIdsForChat(chatId: number): number[] {
  if (!cache) return []
  const ids = cache.get(chatId) ?? []
  cache.set(chatId, [])
  scheduleFlush()
  return ids
}

function scheduleFlush(): void {
  dirty = true
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flush()
  }, FLUSH_DEBOUNCE_MS)
  flushTimer.unref?.()
}

/**
 * Force-write any pending changes to disk now. Called on bot stop
 * and app shutdown so the latest tracking lands before the process
 * exits and the next launch reads from a fresh file.
 */
export async function flushMessageIds(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  await flush()
}

async function flush(): Promise<void> {
  if (!cache || !dirty) return
  dirty = false
  const obj: Record<string, number[]> = {}
  for (const [k, v] of cache.entries()) {
    if (v.length > 0) obj[String(k)] = v
  }
  try {
    await diskWriter.writeFileAtomic(filePath(), JSON.stringify(obj))
  } catch {
    // best-effort: a write failure shouldn't crash the bot. Worst
    // case is the in-memory state is correct but disk is stale,
    // and we'll retry on the next scheduleFlush.
  }
}

/** Test hook: drop the cache and any pending timer. */
export function _resetForTesting(): void {
  cache = null
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  dirty = false
}
