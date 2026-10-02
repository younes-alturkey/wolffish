import { diskWriter } from '@main/io/diskWriter'
import { workspaceRoot } from '@main/workspace/workspace'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Persistent mapping from WhatsApp JIDs to Wolffish conversation IDs.
 * Same JID always resumes the same conversation, so a user who returns
 * picks up where they left off.
 *
 * The map lives at `workspace/whatsapp/chats.json` — a small JSON
 * blob keyed by JID string. Conversations themselves still live in
 * `brain/conversations/`, identical to Electron/Telegram chats.
 */

const FILENAME = 'chats.json'

function whatsappDir(): string {
  return path.join(workspaceRoot(), 'whatsapp')
}

function chatMapPath(): string {
  return path.join(whatsappDir(), FILENAME)
}

type RawMap = Record<string, string>

let cache: Map<string, string> | null = null

async function load(): Promise<Map<string, string>> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(chatMapPath(), 'utf8')
    const parsed = JSON.parse(raw) as RawMap
    const map = new Map<string, string>()
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k === 'string' && k.length > 0 && typeof v === 'string' && v.length > 0) {
        map.set(k, v)
      }
    }
    cache = map
    return map
  } catch {
    cache = new Map()
    return cache
  }
}

async function persist(map: Map<string, string>): Promise<void> {
  const obj: RawMap = {}
  for (const [k, v] of map.entries()) obj[k] = v
  await diskWriter.writeFileAtomic(chatMapPath(), JSON.stringify(obj, null, 2))
}

export async function getConversationIdForJid(jid: string): Promise<string | null> {
  const map = await load()
  return map.get(jid) ?? null
}

export async function setConversationIdForJid(jid: string, conversationId: string): Promise<void> {
  const map = await load()
  map.set(jid, conversationId)
  await persist(map)
}

export async function clearConversationForJid(jid: string): Promise<void> {
  const map = await load()
  if (!map.delete(jid)) return
  await persist(map)
}
