/**
 * Mid-turn user messages ("interjections").
 *
 * A message the user sends while a turn is still running used to be parked
 * by every surface — the in-app composer, the terminal, the phone, the
 * Telegram/WhatsApp queues — until the turn ended, then dispatched as its
 * own turn. That was the wrong shape: the user is steering the work that is
 * happening NOW ("skip the tests folder", "actually use the other file"),
 * and a message that only lands after the run finishes steers nothing.
 *
 * The TurnRunner keeps a per-conversation inbox; the agent loop drains it at
 * exactly two stop points (see Agent.runRespond → deliverInterjections):
 *
 *  1. the top of every iteration, before the next model call — this covers
 *     a message that arrived during the previous tool batch AND one that
 *     arrived before the very first call;
 *  2. the branch where the model produced no tool calls and the turn would
 *     otherwise end — the turn stays alive and the model answers the new
 *     message instead of the surface starting a fresh turn.
 *
 * Never inside a tool batch: every tool_use id the model emitted must be
 * answered in the immediately following user turn, so a batch always runs to
 * completion before a message is read. A delivered message is a REAL
 * `role: 'user'` entry in the model's messages (merged into the same user
 * turn as the batch's tool results on Anthropic-shaped wires) and a
 * `user_message` segment in the transcript — so it persists, replays into
 * the next turn's history, mirrors to the other surfaces and exports, all
 * through the paths that already exist.
 *
 * This module is runtime-side on purpose: the channel layer imports the type
 * from here, never the other way round (runtime must not depend on channels).
 */

import type { ChatMessage } from '@main/runtime/thalamus'
import type { MessageAttachment, ConversationChannel } from '@main/conversations'
import { composeAttachmentContext } from '@main/uploads/compose-attachments'

export type Interjection = {
  /**
   * Stable id minted by the sending surface — the same contract as a
   * turn's userMessageId. The `user_message` segment carries it, so the
   * sender can retire its optimistic "pending" bubble when the delivered
   * copy arrives, and the id-keyed transcript merge never duplicates it.
   */
  messageId: string
  text: string
  /** Always real on-disk paths (the channel-queue rule): media is saved before it lands here. */
  attachments: MessageAttachment[]
  /** Voice notes: the transcript is the prompt; the audio stays out of the LLM history. */
  voicePrompt?: boolean
  voiceLang?: string
  /** Which surface sent it — the ack and the withdraw go back there. */
  channel: ConversationChannel
  sentAt: number
}

export type InterjectResult =
  | {
      status: 'pending'
      /**
       * Resolves TRUE once the message is parked on disk (channels/
       * interjection-store.ts) and can therefore survive a crash, a quit or a
       * dropped connection — and FALSE if that write failed. It never rejects,
       * because most callers never await it and an unhandled rejection would
       * be worse than a dropped guarantee; but it does not pretend either, so
       * a caller that acks on the strength of durability can say so honestly
       * and log when the guarantee did not hold.
       *
       * The accept itself stays synchronous — Telegram and WhatsApp rely on
       * `pending` being emitted inside interject(), before any terminal event
       * can fire — so the durability is offered rather than imposed: a caller
       * that answers the user asynchronously (the phone's RPC) awaits this
       * before saying "got it", and everyone else ignores it.
       */
      durable: Promise<boolean>
    }
  | { status: 'no_live_turn' }

/**
 * The verdict alone — what crosses a process or wire boundary. `durable` is a
 * live promise and cannot be structured-cloned over IPC or serialized to a
 * phone, so every boundary narrows to this.
 */
export type InterjectVerdict = { status: InterjectResult['status'] }

/**
 * Why a pending interjection left the inbox without being read.
 *  - `user`: withdrawn by the sender (the X on the pending bubble).
 *  - `canceled`: the turn was stopped — the sender restores its draft.
 *  - `turn_ended`: the turn finished naturally in the sliver between the
 *    agent's final drain and the lane closing — the sender re-sends it as a
 *    fresh turn.
 *  - `error`: the turn died — same as turn_ended for the sender.
 */
export type InterjectionWithdrawReason = 'user' | 'canceled' | 'turn_ended' | 'error'

/**
 * How a run that does NOT ride a TurnRunner lane borrows the inbox.
 *
 * Automations, procedures and heartbeat jobs call `agent.respond()` directly
 * (Agent.processAutonomous), so nothing registered them as live and
 * `interject()` refused every message aimed at them — the one kind of run a
 * user most wants to steer, since it works unattended for minutes at a time.
 * The bridge is the three calls that make such a run an ordinary inbox
 * citizen; main implements it against the TurnRunner, because the runner owns
 * the Agent and this module may not depend on the channel layer.
 */
export type AutonomousInterjectionBridge = {
  /** The run owns this conversation now — accept messages for it. */
  open(conversationId: string): void
  /** The agent loop's stop-point drain, identical to a lane turn's. */
  take(conversationId: string, turnId: string): Interjection[]
  /** The run is over: sweep whatever it never read back to its senders. */
  close(conversationId: string, reason: InterjectionWithdrawReason): void
}

/**
 * Lifecycle of one interjection, broadcast to every surface watching the
 * conversation (its own channel, NOT chat:turnState — the renderer maps any
 * unknown turn phase to "failed").
 */
export type InterjectionEvent = {
  conversationId: string
  messageId: string
  channel: ConversationChannel
  text: string
  attachments: MessageAttachment[]
  voicePrompt?: boolean
  voiceLang?: string
  state: 'pending' | 'delivered' | 'withdrawn'
  reason?: InterjectionWithdrawReason
}

/**
 * The runtime-tail notice for the ONE iteration that delivers a message.
 * Rides the volatile tail (after every cache breakpoint) like every other
 * notice, so it never perturbs the cached prefix. The user's message itself
 * carries the content; this only tells the model how to treat a user turn
 * that showed up in the middle of its own work.
 */
export const INTERJECTION_NOTICE =
  'A new message from the user arrived while you were working — it is the most recent user text above, ' +
  'sent mid-task. Read it before choosing your next step: it may narrow, redirect or cancel the plan. ' +
  'Acknowledge it in one short line in your next visible reply and adjust; never restart work it does not affect.'

/**
 * Build the model-facing user message for a delivered interjection. Mirrors
 * the renderer's textHistory and the channels' dispatch shape exactly: a
 * voice note becomes a `<voice_note>` block (audio never reaches the LLM),
 * attachments become the model-led `<attachments>` reference list. The
 * `attachments` field rides along so processHistoryAttachments can attach
 * the same on-demand file notes it gives a first message.
 */
export function interjectionToHistoryMessage(
  item: Pick<Interjection, 'text' | 'attachments' | 'voicePrompt' | 'voiceLang'>
): ChatMessage & { attachments?: MessageAttachment[] } {
  if (item.voicePrompt) {
    const langAttr = item.voiceLang ? ` lang="${item.voiceLang}"` : ''
    return { role: 'user', content: `<voice_note${langAttr}>\n${item.text}` }
  }
  const content = composeAttachmentContext(item.text, item.attachments)
  const msg: ChatMessage & { attachments?: MessageAttachment[] } = { role: 'user', content }
  if (item.attachments.length > 0) msg.attachments = item.attachments
  return msg
}

/** What a phone chat is told the instant its mid-turn message is accepted. Plain text, no Markdown. */
export function interjectionAckText(attachmentCount: number): string {
  const files =
    attachmentCount === 0
      ? ''
      : attachmentCount === 1
        ? ' with 1 file'
        : ` with ${attachmentCount} files`
  return `📥 Got it${files}. I'll read it after the current step.`
}
