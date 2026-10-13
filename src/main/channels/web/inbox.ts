/**
 * The Web UI's notification log — every `notify_web` this box sent, kept so
 * a browser can read it again after the banner is gone, with the same two
 * flags the phone's log carries (apps/mobile/src/state/notifications.ts):
 *
 *  - `read` is about attention. Every notification arrives unread, and only
 *    the user answers it: a Mark as read, a tap that opens it, or archiving.
 *    Looking at the page is NOT reading — the OS badge clears on a glance,
 *    this does not.
 *  - `archived` is about the inbox. One-way, and archiving reads at the same
 *    time, so the archive is a finished pile rather than a second inbox.
 *
 * Unlike the phone, nothing has to be reconstructed at arrival: the server
 * mints every notification itself, so it writes the record before it sends
 * the push, and every signed-in browser reads the one log. A browser marking
 * one read marks it read on all of them.
 */
import { diskWriter } from '@main/io/diskWriter'
import fs from 'node:fs/promises'
import path from 'node:path'

export type WebNotificationPhase = 'completed' | 'failed' | 'needs_input' | 'started' | 'info'

export type WebNotificationRecord = {
  id: string
  title: string
  body: string
  phase: WebNotificationPhase
  /** Where a tap goes — `/?conversation=<id>`, or `/`. */
  url: string | null
  /** The conversation it is about, or null for a general one. */
  conversationId: string | null
  /** When it was sent. */
  at: number
  read: boolean
  archived: boolean
}

export type WebNotificationAction =
  | { kind: 'read'; id: string }
  | { kind: 'archive'; id: string }
  | { kind: 'readAll' }
  | { kind: 'archiveAll' }
  | { kind: 'readConversation'; conversationId: string }
  | { kind: 'archiveConversation'; conversationId: string }

/** Newest first, capped — the phone keeps the same number. */
const LIMIT = 300

const PHASES = new Set<WebNotificationPhase>([
  'completed',
  'failed',
  'needs_input',
  'started',
  'info'
])

function ordered(items: WebNotificationRecord[]): WebNotificationRecord[] {
  return [...items].sort((a, b) => b.at - a.at).slice(0, LIMIT)
}

function valid(value: unknown): value is WebNotificationRecord {
  const r = value as Partial<WebNotificationRecord> | null
  return (
    !!r &&
    typeof r.id === 'string' &&
    typeof r.title === 'string' &&
    typeof r.body === 'string' &&
    typeof r.at === 'number' &&
    PHASES.has(r.phase as WebNotificationPhase)
  )
}

/**
 * Flip `read` — and with `archive`, `archived` — on the records `matches`
 * names. Null when nothing changed, so a no-op writes nothing and tells
 * nobody.
 */
function settle(
  items: WebNotificationRecord[],
  matches: (record: WebNotificationRecord) => boolean,
  archive: boolean
): WebNotificationRecord[] | null {
  let changed = false
  const next = items.map((record) => {
    if (!matches(record)) return record
    if (record.read && (!archive || record.archived)) return record
    changed = true
    return { ...record, read: true, archived: archive ? true : record.archived }
  })
  return changed ? next : null
}

export function applyNotificationAction(
  items: WebNotificationRecord[],
  action: WebNotificationAction
): WebNotificationRecord[] | null {
  switch (action.kind) {
    case 'read':
      return settle(items, (r) => r.id === action.id, false)
    case 'archive':
      return settle(items, (r) => r.id === action.id, true)
    case 'readAll':
      return settle(items, (r) => !r.archived, false)
    case 'archiveAll':
      return settle(items, (r) => !r.archived, true)
    case 'readConversation':
      return settle(items, (r) => r.conversationId === action.conversationId, false)
    case 'archiveConversation':
      return settle(items, (r) => r.conversationId === action.conversationId, true)
    default:
      return null
  }
}

/** A renderer's action, checked field by field — it crossed a socket. */
export function parseNotificationAction(value: unknown): WebNotificationAction | null {
  const a = value as { kind?: unknown; id?: unknown; conversationId?: unknown } | null
  if (!a || typeof a.kind !== 'string') return null
  const id = typeof a.id === 'string' && a.id ? a.id : null
  const cid = typeof a.conversationId === 'string' && a.conversationId ? a.conversationId : null
  switch (a.kind) {
    case 'read':
    case 'archive':
      return id ? { kind: a.kind, id } : null
    case 'readAll':
    case 'archiveAll':
      return { kind: a.kind }
    case 'readConversation':
    case 'archiveConversation':
      return cid ? { kind: a.kind, conversationId: cid } : null
    default:
      return null
  }
}

export class WebInbox {
  private items: WebNotificationRecord[] | null = null
  private loading: Promise<WebNotificationRecord[]> | null = null
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async list(): Promise<WebNotificationRecord[]> {
    if (this.items) return this.items
    this.loading ??= (async () => {
      let parsed: unknown = null
      try {
        parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
      } catch {
        parsed = null
      }
      const raw = (parsed as { items?: unknown } | null)?.items
      this.items = ordered(
        (Array.isArray(raw) ? raw : []).filter(valid).map((r) => ({
          ...r,
          url: typeof r.url === 'string' ? r.url : null,
          conversationId: typeof r.conversationId === 'string' ? r.conversationId : null,
          read: r.read === true || r.archived === true,
          archived: r.archived === true
        }))
      )
      return this.items
    })()
    return this.loading
  }

  /** A new notification, unread. Idempotent by id. */
  async record(input: Omit<WebNotificationRecord, 'read' | 'archived'>): Promise<boolean> {
    const items = await this.list()
    if (items.some((r) => r.id === input.id)) return false
    this.items = ordered([{ ...input, read: false, archived: false }, ...items])
    await this.persist()
    return true
  }

  /** Apply one action; false when it changed nothing. */
  async apply(action: WebNotificationAction): Promise<boolean> {
    const next = applyNotificationAction(await this.list(), action)
    if (!next) return false
    this.items = next
    await this.persist()
    return true
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, items: this.items ?? [] })
    this.writes = this.writes
      .then(async () => {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true })
        await diskWriter.writeFileAtomic(this.filePath, snapshot)
      })
      .catch(() => undefined)
    return this.writes
  }
}
