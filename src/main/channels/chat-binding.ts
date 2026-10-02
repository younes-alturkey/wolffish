import type { ConversationFile } from '@main/conversations'

/**
 * Shared logic behind "the chat you message should be pointed at the
 * conversation doing the messaging" (WhatsApp + Telegram).
 *
 * When the agent sends to a channel out of band — a heartbeat reporting a
 * finished job, an in-app conversation notifying you — the user's reply used to
 * land in whatever conversation that chat was last left on, so the reply
 * arrived with no idea what it was answering. Binding the chat to the sending
 * conversation closes that: you reply, and you're in the conversation that
 * messaged you.
 *
 * Only the map key differs between the channels (a numeric chat id vs a JID
 * that has to be resolved to its inbound form), so the sequencing lives here
 * and each channel supplies its own IO — the same split `conversation-picker.ts`
 * uses for `/resume`.
 */

export type ChatBindingIO = {
  /** The conversation this chat is currently bound to, if any. */
  getBoundConversationId: () => Promise<string | null>
  setBoundConversationId: (conversationId: string) => Promise<void>
  updateConversation: (
    id: string,
    mutate: (disk: ConversationFile | null) => ConversationFile | null
  ) => Promise<void>
}

/** Why a bind did or didn't happen. Returned so tests can tell the cases apart. */
export type BindResult =
  /** No conversation in scope — a detached run. Nothing to bind. */
  | 'no-turn'
  /** The chat is already on this conversation. No writes at all. */
  | 'already-bound'
  | 'bound'

/**
 * Bind a chat to `conversationId`, or explain why not.
 *
 * The early return on 'already-bound' is the common case — a channel turn
 * replying into its own chat — and it has to stay a true no-op: binding writes
 * the conversation file (below), so re-binding on every send would rewrite the
 * map and restart the idle clock on a chat nobody actually moved.
 *
 * Deliberately does NOT require the conversation to exist on disk yet. An
 * automation writes its conversation shell before the run starts
 * (Agent.processAutonomous), so the file is normally there — but binding must
 * not depend on that: the write is best-effort, and an in-app turn's user
 * message still reaches disk only at the fold. Nothing needs the guard either:
 * a map entry pointing at an id that never materializes self-heals, because
 * loadOrCreateConversation falls through to a fresh conversation when the id
 * won't load.
 */
export async function bindChatToConversation(
  conversationId: string | null | undefined,
  io: ChatBindingIO
): Promise<BindResult> {
  if (!conversationId) return 'no-turn'
  if ((await io.getBoundConversationId()) === conversationId) return 'already-bound'

  // Restart the idle clock. Both channels rotate a conversation idle for
  // staleHours into a fresh one on the next inbound message — which would
  // bounce the reply we're inviting straight back out of the conversation we
  // just bound it to, undoing this. Same reason /resume bumps it. A no-op when
  // the file isn't written yet, which is fine: a conversation that new can't be
  // stale, and its own end-of-run save stamps updatedAt anyway.
  await io.updateConversation(conversationId, (disk) => {
    if (!disk) return null
    disk.updatedAt = Date.now()
    return disk
  })
  // Bump before remapping so a failed write leaves the old mapping intact.
  await io.setBoundConversationId(conversationId)
  return 'bound'
}
