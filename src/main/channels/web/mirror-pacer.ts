import type { ConversationMessage } from '@main/conversations'
import { fitMirrorMessage } from '@main/channels/mirror-budget'

/**
 * Live mirrors of an in-flight run (an automation, a Telegram turn) to the
 * browsers watching it.
 *
 * `conversation:messageMirror` carries the WHOLE assistant message, every
 * tool payload included, every 500 ms. Pushed raw, a long automation's
 * snapshot grew past 4 MB and went out once or twice a second (seen on the
 * VPS 2026-10-13): the socket backed up, the tab spent its time re-parsing
 * megabytes, and the feed stopped moving until a reload. The phone link has
 * fitted and paced the same snapshots since 2026-08; this is that recipe for
 * the browser socket:
 *
 * - fit: each snapshot is trimmed under WEB_MIRROR_MAX_BYTES (old tool
 *   payloads shortened, the live edge kept whole — mirror-budget.ts);
 * - pace: a snapshot's size sets the earliest moment of the next one for
 *   that browser and conversation, so small turns keep the 500 ms cadence
 *   and a huge one slows to its byte budget;
 * - latest wins: while a browser is not due or its socket is backed up,
 *   only the newest snapshot waits (each one is a superset of the last).
 *
 * `drop()` discards waiting snapshots: called when a conversation is saved
 * (`conversation:changed`), so a stale in-progress snapshot can never land
 * on top of the saved message the page has just reloaded.
 */

export const WEB_MIRROR_MAX_BYTES = 384 * 1024
const WEB_MIRROR_BYTES_PER_SEC = 256 * 1024
const WEB_MIRROR_BACKLOG_MAX_BYTES = 1024 * 1024
const WEB_MIRROR_RETRY_MS = 250

type Slot = {
  nextAt: number
  pending: { frame: string; bytes: number } | null
  timer: ReturnType<typeof setTimeout> | null
}

export type MirrorPacerDeps<C> = {
  isOpen: (client: C) => boolean
  buffered: (client: C) => number
  send: (client: C, frame: string) => void
  encode: (payload: { conversationId: string; message: ConversationMessage }) => string | null
  now?: () => number
}

export class MirrorPacer<C> {
  private slots = new Map<C, Map<string, Slot>>()

  constructor(private deps: MirrorPacerDeps<C>) {}

  push(clients: Iterable<C>, conversationId: string, message: ConversationMessage): void {
    const fitted = fitMirrorMessage(message, WEB_MIRROR_MAX_BYTES)
    if (!fitted) return
    const frame = this.deps.encode({ conversationId, message: fitted })
    if (!frame) return
    const bytes = Buffer.byteLength(frame)
    for (const client of clients) {
      const slot = this.slot(client, conversationId)
      slot.pending = { frame, bytes }
      this.flush(client, conversationId, slot)
    }
  }

  drop(conversationId?: string): void {
    for (const perClient of this.slots.values()) {
      for (const [id, slot] of perClient) {
        if (conversationId !== undefined && id !== conversationId) continue
        slot.pending = null
        if (slot.timer) clearTimeout(slot.timer)
        slot.timer = null
      }
    }
  }

  forget(client: C): void {
    const perClient = this.slots.get(client)
    if (!perClient) return
    for (const slot of perClient.values()) if (slot.timer) clearTimeout(slot.timer)
    this.slots.delete(client)
  }

  private slot(client: C, conversationId: string): Slot {
    let perClient = this.slots.get(client)
    if (!perClient) {
      perClient = new Map()
      this.slots.set(client, perClient)
    }
    let slot = perClient.get(conversationId)
    if (!slot) {
      slot = { nextAt: 0, pending: null, timer: null }
      perClient.set(conversationId, slot)
    }
    return slot
  }

  private flush(client: C, conversationId: string, slot: Slot): void {
    if (!slot.pending) return
    if (!this.deps.isOpen(client)) {
      this.forget(client)
      return
    }
    const now = (this.deps.now ?? Date.now)()
    const congested = this.deps.buffered(client) > WEB_MIRROR_BACKLOG_MAX_BYTES
    if (now < slot.nextAt || congested) {
      if (!slot.timer) {
        const wait = congested ? WEB_MIRROR_RETRY_MS : Math.max(slot.nextAt - now, 0)
        slot.timer = setTimeout(() => {
          slot.timer = null
          this.flush(client, conversationId, slot)
        }, wait)
      }
      return
    }
    const { frame, bytes } = slot.pending
    slot.pending = null
    slot.nextAt = now + (bytes / WEB_MIRROR_BYTES_PER_SEC) * 1000
    this.deps.send(client, frame)
  }
}
