import { diskWriter } from '@main/io/diskWriter'
import { workspaceRoot } from '@main/workspace/workspace'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Persistent mapping from Telegram chat IDs to Wolffish conversation
 * IDs. Same chat ID always resumes the same conversation, so a user
 * who returns to a chat picks up where they left off.
 *
 * The map lives at `workspace/telegram/chats.json` — a small JSON
 * blob keyed by stringified chat id. Conversations themselves still
 * live in `brain/conversations/`, identical to Electron-created chats.
 */

const FILENAME = 'chats.json'

function telegramDir(): string {
  return path.join(workspaceRoot(), 'telegram')
}

function chatMapPath(): string {
  return path.join(telegramDir(), FILENAME)
}

type RawMap = Record<string, string>

let cache: Map<number, string> | null = null

async function load(): Promise<Map<number, string>> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(chatMapPath(), 'utf8')
    const parsed = JSON.parse(raw) as RawMap
    const map = new Map<number, string>()
    for (const [k, v] of Object.entries(parsed)) {
      const id = Number(k)
      if (Number.isFinite(id) && typeof v === 'string' && v.length > 0) {
        map.set(id, v)
      }
    }
    cache = map
    return map
  } catch {
    cache = new Map()
    return cache
  }
}

async function persist(map: Map<number, string>): Promise<void> {
  const obj: RawMap = {}
  for (const [k, v] of map.entries()) obj[String(k)] = v
  await diskWriter.writeFileAtomic(chatMapPath(), JSON.stringify(obj, null, 2))
}

export async function getConversationIdForChat(chatId: number): Promise<string | null> {
  const map = await load()
  return map.get(chatId) ?? null
}

export async function setConversationIdForChat(
  chatId: number,
  conversationId: string
): Promise<void> {
  const map = await load()
  map.set(chatId, conversationId)
  await persist(map)
}

export async function clearConversationForChat(chatId: number): Promise<void> {
  const map = await load()
  if (!map.delete(chatId)) return
  await persist(map)
}

/** Used by tests to forget the in-process cache. */
export function _resetCacheForTesting(): void {
  cache = null
}
