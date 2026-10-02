import type { MessageAttachment } from '@main/conversations'
import { interjectionAckText } from '@main/runtime/agent/interjection'

/**
 * The PRE-SEND SLIVER queue for a channel chat.
 *
 * A message that arrives while a chat's turn is running is no longer parked
 * here until the turn ends: it is handed to the RUNNING turn through
 * TurnRunner.interject (see runtime/agent/interjection.ts), and the agent
 * reads it at its next stop point. This module survives for exactly one
 * window that interject cannot cover — the chat is already marked busy by
 * the channel (Telegram's `activeByChat`, WhatsApp's synchronous
 * `dispatchingByJid` claim) but the runner has no lane for its conversation
 * yet: the pre-send stretch where a media download, a transcription or the
 * conversation load is still running before runner.send registers the turn.
 * interject answers `no_live_turn` there, and the message lands here instead.
 *
 * A flush therefore tries interject FIRST for every item (by the time it
 * runs, the turn that was being set up is usually live and will read the
 * message itself) and only dispatches a fresh turn when there is still no
 * live lane. The turn-ended sweep re-uses the same path: an interjection
 * the runner hands back with reason turn_ended/error is re-queued here and
 * flushed by the end-of-turn cleanup, because the sweep fires while the
 * finished lane is still counted and a direct re-interject would park the
 * message on a turn that will never read it.
 *
 * Media is already DOWNLOADED and saved into the conversation's uploads folder
 * before it lands here — and before it is interjected. Channel file handles
 * are short-lived (Telegram's `file_path` expires; WhatsApp's media keys live
 * on the inbound message we no longer hold later), so deferring the fetch
 * would leave a parked photo undeliverable minutes later. `attachments`
 * therefore always carry real on-disk paths, and a flushed message goes
 * through the SAME dispatch → composeAttachmentContext →
 * processHistoryAttachments pipeline an unqueued one does.
 */
export type QueuedMessageBase = {
  /** Stable id for the entry. Diagnostics only — never shown to the user. */
  id: string
  text: string
  attachments: MessageAttachment[]
  /**
   * Voice notes carry the same two flags the unqueued path hands dispatchTurn:
   * the transcript is the prompt and the audio stays out of the LLM history.
   */
  voicePrompt?: boolean
  voiceLang?: string
}

/**
 * Per-chat FIFO of parked messages. Deliberately dumb — ordering and storage
 * only. Every policy decision (when a chat counts as busy, when to drain, what
 * to tell the user) lives in the channel that owns the queue, because those
 * rules differ: Telegram gates on `activeByChat`, WhatsApp on `activeByJid`
 * plus its synchronous `dispatchingByJid` claim.
 *
 * In-memory only. A queue does not survive an app restart or a channel
 * stop/start — same trade the in-app queue makes, and the messages themselves
 * are still sitting in the user's phone chat if they want to resend.
 */
export class ChannelMessageQueue<K, T extends QueuedMessageBase> {
  private readonly byKey = new Map<K, T[]>()

  /** Append and return the resulting depth (what the ack reports). */
  enqueue(key: K, item: T): number {
    const list = this.byKey.get(key)
    if (list) {
      list.push(item)
      return list.length
    }
    this.byKey.set(key, [item])
    return 1
  }

  /**
   * Put an item back at the FRONT. Used only when a flush attempt could not
   * start a turn after all (the chat re-armed under us), so the message keeps
   * its place in line instead of being re-appended behind later arrivals.
   */
  requeue(key: K, item: T): void {
    const list = this.byKey.get(key)
    if (list) list.unshift(item)
    else this.byKey.set(key, [item])
  }

  /** Pop the head, dropping the bucket once empty so the map stays small. */
  shift(key: K): T | undefined {
    const list = this.byKey.get(key)
    if (!list || list.length === 0) return undefined
    const next = list.shift()
    if (list.length === 0) this.byKey.delete(key)
    return next
  }

  size(key: K): number {
    return this.byKey.get(key)?.length ?? 0
  }

  /** Drop everything queued for one chat and report how many were dropped. */
  clear(key: K): number {
    const count = this.byKey.get(key)?.length ?? 0
    this.byKey.delete(key)
    return count
  }

  /** Channel teardown — a stopped bot must not resurrect a stale queue. */
  clearAll(): void {
    this.byKey.clear()
  }
}

/**
 * What the user is told the instant their mid-turn message is accepted into
 * the sliver queue. Deliberately the SAME sentence as the interject ack: from
 * the phone the two are one promise ("I'll read it after the current step"),
 * and which of the two mechanisms carried the message is an implementation
 * detail the user must never be asked to tell apart. Plain text, no Markdown
 * (WhatsApp renders none of it). Reports the file count so the user can see
 * that nothing was dropped.
 */
export function queuedAckText(attachmentCount: number): string {
  return interjectionAckText(attachmentCount)
}

/**
 * Reply to /cancel. `dropped` is the combined count of what was actually
 * taken back: interjections still unread by the running turn plus anything
 * in the sliver queue.
 */
export function queueClearedText(dropped: number): string {
  return dropped === 1 ? '🗑 Dropped 1 unread message.' : `🗑 Dropped ${dropped} unread messages.`
}

/**
 * Reply to /cancel when nothing was queued. `running` points a user who meant
 * "abort what you're doing" at the command that actually does that — /cancel
 * used to be a /stop alias on Telegram, so the habit exists.
 */
export function queueEmptyText(running: boolean): string {
  return running
    ? 'Nothing queued. The task still running is stopped with /stop.'
    : 'Nothing queued.'
}

/**
 * One-line note for a message the running turn never got to read because the
 * user stopped it (/stop → the runner hands the interjection back with reason
 * `canceled`). Never auto-resent: a stop means "drop what you were doing", and
 * the message may well have been part of that. Quotes the start of the text
 * so the user knows WHICH message, since several may have been pending.
 */
export function unreadAfterStopText(text: string, attachmentCount: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  const quoted =
    trimmed.length === 0
      ? attachmentCount === 1
        ? 'your file'
        : attachmentCount > 1
          ? `your ${attachmentCount} files`
          : 'your message'
      : `"${trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed}"`
  return `⏹ Stopped before reading ${quoted}. Resend it if you still want it.`
}

/** Trailing note appended to /stop so a still-queued sliver message is never a surprise. */
export function queuePendingNote(depth: number): string {
  if (depth <= 0) return ''
  return depth === 1
    ? '\n\n1 queued message will run next — /cancel drops it.'
    : `\n\n${depth} queued messages will run next — /cancel drops them.`
}
