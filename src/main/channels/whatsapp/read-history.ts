import type { WhatsAppBufferedMessage } from '@main/channels/whatsapp/tools'
import { diskWriter } from '@main/io/diskWriter'
import { workspaceRoot } from '@main/workspace/workspace'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Disk persistence for the WhatsApp per-chat read buffer (see
 * WhatsAppChannel.readBuffer, which backs whatsapp_read). The in-memory
 * buffer stays the source of truth at runtime; this layer just seeds it on
 * start and saves it back, so captured history survives app restarts instead
 * of resetting every launch.
 *
 * Lives at `workspace/whatsapp/read-history.json`, alongside the auth folder.
 * Bounded by the same caps as the in-memory buffer so the file can't grow
 * without limit, and writes are debounced (WhatsApp is chatty — flushing on
 * every message would thrash the disk), mirroring telegram/messages.ts.
 *
 * Still only holds traffic seen while connected — there is no pre-connect
 * history; persistence just accumulates the connected windows over time.
 */

// Mirror WhatsAppChannel.READ_BUFFER_MAX_PER_CHAT / READ_BUFFER_MAX_CHATS.
const MAX_PER_CHAT = 100
const MAX_CHATS = 200
const FLUSH_DEBOUNCE_MS = 2000

let flushTimer: NodeJS.Timeout | null = null
let pending: Map<string, WhatsAppBufferedMessage[]> | null = null
// Bumped by deleteReadHistory(). A flush() snapshots it before its awaits and
// aborts the write if it changed — so a debounced flush racing a logout-delete
// can't recreate the file after it's been removed.
let epoch = 0

function dir(): string {
  return path.join(workspaceRoot(), 'whatsapp')
}

function filePath(): string {
  return path.join(dir(), 'read-history.json')
}

/**
 * Read persisted history into a fresh Map. Validates each record and applies
 * the caps defensively. A missing or corrupt file yields an empty Map — never
 * throws, so a bad file can't block channel startup.
 */
export async function loadReadHistory(): Promise<Map<string, WhatsAppBufferedMessage[]>> {
  const out = new Map<string, WhatsAppBufferedMessage[]>()
  try {
    const raw = await fs.readFile(filePath(), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const [jid, value] of Object.entries(parsed)) {
      if (out.size >= MAX_CHATS) break
      if (!Array.isArray(value)) continue
      const msgs: WhatsAppBufferedMessage[] = []
      for (const item of value) {
        const m = item as Partial<WhatsAppBufferedMessage>
        if (
          typeof m?.id === 'string' &&
          typeof m?.jid === 'string' &&
          typeof m?.fromMe === 'boolean' &&
          typeof m?.sender === 'string' &&
          typeof m?.text === 'string' &&
          typeof m?.timestamp === 'number' &&
          Number.isFinite(m.timestamp)
        ) {
          msgs.push({
            id: m.id,
            jid: m.jid,
            fromMe: m.fromMe,
            sender: m.sender,
            text: m.text,
            timestamp: m.timestamp
          })
        }
      }
      if (msgs.length > 0) out.set(jid, msgs.slice(-MAX_PER_CHAT))
    }
  } catch {
    // missing or corrupt file — start empty
  }
  return out
}

/**
 * Schedule a debounced write of the current buffer. The buffer is held by
 * reference, so the flush always serializes the latest state when it fires.
 */
export function scheduleReadHistoryFlush(buffer: Map<string, WhatsAppBufferedMessage[]>): void {
  pending = buffer
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flush()
  }, FLUSH_DEBOUNCE_MS)
  flushTimer.unref?.()
}

/**
 * Write the buffer to disk now, cancelling any pending debounced flush.
 * Called on channel stop so the latest captures land before teardown.
 */
export async function flushReadHistory(
  buffer: Map<string, WhatsAppBufferedMessage[]>
): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  pending = buffer
  await flush()
}

async function flush(): Promise<void> {
  const buffer = pending
  if (!buffer) return
  // Snapshot the epoch so a deleteReadHistory() landing while we await disk I/O
  // (a debounced flush racing a logout) aborts our write instead of recreating
  // the just-deleted file.
  const myEpoch = epoch
  const obj: Record<string, WhatsAppBufferedMessage[]> = {}
  for (const [jid, msgs] of buffer) {
    if (msgs.length > 0) obj[jid] = msgs.slice(-MAX_PER_CHAT)
  }
  try {
    if (myEpoch !== epoch) return
    await diskWriter.writeFileAtomic(filePath(), JSON.stringify(obj))
  } catch {
    // best-effort: a write failure must not crash the channel; the in-memory
    // buffer stays correct and the next scheduleReadHistoryFlush retries.
  }
}

/**
 * Delete the persisted history (and cancel any pending flush). Called on
 * logout so a different linked account can't surface the old one's messages.
 */
export async function deleteReadHistory(): Promise<void> {
  // Bump first so any in-flight flush() aborts its write (see flush()).
  epoch++
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  pending = null
  try {
    // Route through the diskWriter's per-path queue (NOT a raw fs.rm) so the
    // delete is FIFO-ordered AFTER any flush() write already enqueued for this
    // path — otherwise an in-flight atomic write could land after the rm and
    // resurrect the just-logged-out history. The epoch guard skips writes when
    // it can; this guarantees ordering when one slips through.
    await diskWriter.deleteFile(filePath())
  } catch {
    // best-effort
  }
}

/** Test hook: drop the module-level timer/reference. */
export function _resetForTesting(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  pending = null
}
