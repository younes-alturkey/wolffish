import path from 'node:path'
import { diskWriter } from '@main/io/diskWriter'
import { workspaceRoot } from '@main/workspace/root'
import type { Interjection, InterjectionWithdrawReason } from '@main/runtime/agent/interjection'

/**
 * The durable home of a mid-turn user message.
 *
 * A message the user sends while a turn runs (see runtime/agent/interjection.ts)
 * used to live in exactly two volatile places: the TurnRunner's in-memory inbox
 * and the sending surface's own optimistic row. Nothing else. That is fine for
 * Telegram and WhatsApp — the message is still sitting in the user's own chat
 * app, so a lost one can be re-read and re-sent — but the phone app and the
 * in-app composer are NOT a second copy: the pending bubble is React state, and
 * the `delivered` push takes it down. So any of these lost the user's words
 * outright, silently, with no trace on either screen:
 *
 *  - the desktop quit, crashed or restarted between accept and delivery;
 *  - the turn ended in the sliver before the agent's last drain and the phone
 *    was backgrounded, relaunched or off the tunnel when the hand-back push
 *    went out (nothing desktop-side re-dispatched a phone message — Telegram
 *    and WhatsApp both did);
 *  - the run was stopped and the surface that would have restored the draft
 *    was not listening;
 *  - the agent read it but the segment never reached the transcript.
 *
 * This module is the answer, and it is deliberately dumb: an append-only park
 * keyed by conversation, written before a message is ever acknowledged and
 * released only when the message provably has another home. Every decision
 * about WHAT that home is lives in the reconciler (interjection-reconciler.ts),
 * which is the part that can be improved without touching durability.
 *
 * ONE file, not one per conversation: the park holds a handful of short
 * messages for a few seconds at a time, the whole-file RMW rides diskWriter's
 * per-path queue (so concurrent parks never lose each other), and a single
 * path means startup recovery is one read rather than a directory scan.
 */

/** Why a parked message is sitting here rather than moving. */
export type ParkDisposition =
  /** Normal: still waiting to be read, or read and awaiting transcript proof. */
  | 'live'
  /**
   * Waiting for a PERSON, not for the machine. Never auto-dispatched; handed
   * back to whichever surface next opens the conversation, so the words return
   * to a composer instead of sitting on disk unseen. Two ways in, and `reason`
   * tells them apart:
   *
   *  - `canceled` — the run was STOPPED before the agent read it. Re-sending
   *    would restart work the user just aborted, so it is theirs to re-send.
   *  - `turn_ended` / `error` with no dispatcher for the sending channel — the
   *    turn ended unread and nothing in this process can put the message back
   *    on the wire (the in-app composer and the terminal register none; the
   *    phone's is gone while its channel is stopped). Held rather than left
   *    live, because a `live` message nobody can dispatch is one nobody ever
   *    sees again.
   */
  | 'held'

export type ParkedInterjection = Interjection & {
  conversationId: string
  /** 'pending' until the agent drains it, 'delivered' once it has. Advisory —
   *  the reconciler decides by looking at the transcript, not at this. */
  state: 'pending' | 'delivered'
  disposition: ParkDisposition
  /** The turn that read it, for forensics on a message that lost its segment. */
  turnId?: string
  /** When the agent read it — the clock the transcript-proof grace runs on. */
  deliveredAt?: number
  /** Why it stopped moving, when it did (mirrors the withdraw reason). */
  reason?: InterjectionWithdrawReason
  parkedAt: number
}

type ParkFile = {
  /** conversationId → parked messages, oldest first. */
  items: Record<string, ParkedInterjection[]>
}

function parkPath(): string {
  return path.join(workspaceRoot(), 'brain', 'interjections.json')
}

function parse(raw: string | null): ParkFile {
  if (!raw) return { items: {} }
  try {
    const value = JSON.parse(raw) as Partial<ParkFile>
    const items = value?.items
    if (!items || typeof items !== 'object') return { items: {} }
    const out: Record<string, ParkedInterjection[]> = {}
    for (const [id, list] of Object.entries(items)) {
      if (Array.isArray(list) && list.length > 0) out[id] = list as ParkedInterjection[]
    }
    return { items: out }
  } catch {
    // A corrupt park must never wedge a turn: an unreadable file is an empty
    // one, and the next write re-creates it.
    return { items: {} }
  }
}

/**
 * Which conversations currently hold something, once anything here has read or
 * written the file. The reconciler is woken by `conversation.indexed`, which
 * fires on EVERY conversation write — including the mid-turn checkpoint's, at
 * up to one per 750ms through a long tool-heavy run — and the answer is "the
 * park is empty" in nearly every one of those. Without this, each of those
 * wake-ups is a file read; with it, the overwhelmingly common case costs
 * nothing at all.
 *
 * This process is the park's only writer, so the cache cannot go stale under
 * us. It is a MISS-only cache: null means "not read yet, go and look".
 */
let keys: Set<string> | null = null

function remember(file: ParkFile): ParkFile {
  keys = new Set(Object.keys(file.items))
  return file
}

/** True when the park is known to hold nothing for this conversation. */
function knownEmpty(conversationId: string): boolean {
  return keys !== null && !keys.has(conversationId)
}

/**
 * Mutate the park inside its write queue. Returns without writing when the
 * mutation changed nothing, so a no-op release costs one read.
 */
async function mutate(change: (file: ParkFile) => boolean): Promise<void> {
  await diskWriter.update(parkPath(), (raw) => {
    const file = parse(raw)
    if (!change(file)) {
      remember(file)
      return null
    }
    for (const [id, list] of Object.entries(file.items)) {
      if (list.length === 0) delete file.items[id]
    }
    remember(file)
    return JSON.stringify(file, null, 2)
  })
}

/**
 * Park a message BEFORE the sender is told it was accepted. Awaited by
 * TurnRunner.interject for exactly that reason: an ack the user has seen must
 * never describe a message that exists only in RAM.
 *
 * Idempotent by message id — a re-park (a retried RPC, a cold-start re-seed)
 * updates the record rather than duplicating it.
 */
export async function parkInterjection(conversationId: string, item: Interjection): Promise<void> {
  const record: ParkedInterjection = {
    ...item,
    conversationId,
    state: 'pending',
    disposition: 'live',
    parkedAt: Date.now()
  }
  await mutate((file) => {
    const list = file.items[conversationId] ?? []
    const at = list.findIndex((i) => i.messageId === item.messageId)
    if (at >= 0) list[at] = { ...list[at], ...record, parkedAt: list[at].parkedAt }
    else list.push(record)
    file.items[conversationId] = list
    return true
  })
}

/** Note that the agent has read these — the transcript is now expected to carry them. */
export async function markInterjectionsDelivered(
  conversationId: string,
  messageIds: string[],
  turnId: string
): Promise<void> {
  if (messageIds.length === 0) return
  const ids = new Set(messageIds)
  await mutate((file) => {
    const list = file.items[conversationId]
    if (!list) return false
    let changed = false
    for (let i = 0; i < list.length; i++) {
      if (!ids.has(list[i].messageId)) continue
      if (list[i].state === 'delivered' && list[i].turnId === turnId) continue
      list[i] = { ...list[i], state: 'delivered', turnId, deliveredAt: Date.now() }
      changed = true
    }
    return changed
  })
}

/**
 * Mark what a terminal sweep did to a message. `canceled` holds it (the user
 * stopped the run — resending it unasked would restart work they just
 * aborted); every other reason leaves it live for the reconciler to re-home.
 */
export async function markInterjectionWithdrawn(
  conversationId: string,
  messageId: string,
  reason: InterjectionWithdrawReason
): Promise<void> {
  await mutate((file) => {
    const list = file.items[conversationId]
    if (!list) return false
    const at = list.findIndex((i) => i.messageId === messageId)
    if (at < 0) return false
    const disposition: ParkDisposition = reason === 'canceled' ? 'held' : 'live'
    if (list[at].disposition === disposition && list[at].reason === reason) return false
    list[at] = { ...list[at], disposition, reason }
    return true
  })
}

/**
 * Let a message go. The ONLY two reasons: it provably has another home (a
 * transcript entry, or a turn that carried it), or the user took it back.
 * Nothing else may call this — a park released on a guess is the bug this
 * module exists to make impossible.
 */
export async function releaseInterjection(
  conversationId: string,
  messageId: string
): Promise<void> {
  await mutate((file) => {
    const list = file.items[conversationId]
    if (!list) return false
    const next = list.filter((i) => i.messageId !== messageId)
    if (next.length === list.length) return false
    file.items[conversationId] = next
    return true
  })
}

/**
 * Let go of a HELD message, because a surface has just handed its words back
 * to the user (into a composer, as a draft). Scoped to `held` on purpose: it is
 * the only disposition where "someone has it now" can be asserted by a
 * renderer, and a blanket release would let a stray call throw away a message
 * still waiting on its transcript proof.
 */
export async function releaseHeldInterjection(
  conversationId: string,
  messageId: string
): Promise<boolean> {
  let released = false
  await mutate((file) => {
    const list = file.items[conversationId]
    if (!list) return false
    const at = list.findIndex((i) => i.messageId === messageId && i.disposition === 'held')
    if (at < 0) return false
    list.splice(at, 1)
    file.items[conversationId] = list
    released = true
    return true
  })
  return released
}

/**
 * Stop a message moving on its own and wait for a person instead. Called when
 * the reconciler finds no dispatcher for its channel — see ParkDisposition —
 * so it is surfaced by the cold-start listing rather than kept `live` forever
 * on a re-send that can never happen. Idempotent.
 */
export async function holdInterjection(conversationId: string, messageId: string): Promise<void> {
  await mutate((file) => {
    const list = file.items[conversationId]
    if (!list) return false
    const at = list.findIndex((i) => i.messageId === messageId)
    if (at < 0 || list[at].disposition === 'held') return false
    list[at] = { ...list[at], disposition: 'held' }
    return true
  })
}

/** Everything parked for one conversation, oldest first. */
export async function parkedInterjections(conversationId: string): Promise<ParkedInterjection[]> {
  // The hot path: called on every conversation save, and almost always for a
  // conversation with nothing parked. Answered from memory when we already
  // know the file holds nothing for it — see `keys`.
  if (knownEmpty(conversationId)) return []
  const file = await readPark()
  return file.items[conversationId] ?? []
}

/** Every conversation with something parked — startup recovery's entry point. */
export async function parkedConversationIds(): Promise<string[]> {
  const file = await readPark()
  return Object.keys(file.items)
}

/** Drop a deleted conversation's park along with its transcript. */
export async function forgetConversationPark(conversationId: string): Promise<void> {
  await mutate((file) => {
    if (!file.items[conversationId]) return false
    delete file.items[conversationId]
    return true
  })
}

async function readPark(): Promise<ParkFile> {
  const fs = await import('node:fs/promises')
  try {
    return remember(parse(await fs.readFile(parkPath(), 'utf8')))
  } catch {
    // No file yet is a legitimate empty park — and now a KNOWN one, so the
    // reads this saves are every wake-up on a machine that has never parked
    // a message. A read that failed for any other reason self-corrects on the
    // next write, since every mutate refreshes the cache from the real file.
    return remember({ items: {} })
  }
}
