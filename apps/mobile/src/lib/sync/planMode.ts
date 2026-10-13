import { tunnelClient } from '@/lib/tunnel/client'
import { Event, Rpc } from '@/lib/tunnel/protocol'
import { NEW_CHAT_PLAN_KEY, useChatRuntime } from '@/state/chatRuntime'

/**
 * Plan mode, kept in step with the desktop.
 *
 * The desktop holds one stance per conversation (its main process — the
 * composer chip reads it too). The phone mirrors it in chatRuntime.planModes:
 * a push (Event.planMode) lands whenever either side changes it, the chat
 * screen reads it once when a conversation opens (seedPlanMode), and the
 * composer's Plan chip writes through (setPlanModeSynced) — optimistically,
 * with the desktop's answer as the final word. A chat with no conversation
 * yet keeps its stance local until the first send creates one; the send
 * stamps it, and the desktop adopts it from there.
 */

export function attachPlanModeStream(): void {
  const tunnel = tunnelClient.active
  if (!tunnel) return
  tunnel.onEvent(Event.planMode, (payload) => {
    const { conversationId, planMode } = (payload ?? {}) as {
      conversationId?: unknown
      planMode?: unknown
    }
    if (typeof conversationId !== 'string' || !conversationId) return
    useChatRuntime.getState().setPlanMode(conversationId, planMode === true)
  })
}

/** Read the desktop's stance for a conversation the screen just opened. */
export async function seedPlanMode(conversationId: string): Promise<void> {
  const tunnel = tunnelClient.active
  if (!tunnel || !tunnelClient.connected) return
  try {
    const answer = (await tunnel.rpc(Rpc.planModeGet, { conversationId })) as {
      planMode?: unknown
    } | null
    useChatRuntime.getState().setPlanMode(conversationId, answer?.planMode === true)
  } catch {
    // Offline or an older desktop without the RPC: the local stance stands.
  }
}

/**
 * Flip the stance: local first so the chip answers the tap, then the
 * desktop. Its answer (or the push it sends back) is authoritative; a write
 * the desktop never got is rolled back so the two never disagree.
 */
export async function setPlanModeSynced(
  conversationId: string | null,
  planMode: boolean
): Promise<void> {
  const runtime = useChatRuntime.getState()
  const previous = runtime.planModes[conversationId ?? NEW_CHAT_PLAN_KEY] ?? false
  runtime.setPlanMode(conversationId, planMode)
  if (!conversationId) return
  const tunnel = tunnelClient.active
  if (!tunnel || !tunnelClient.connected) return
  try {
    const answer = (await tunnel.rpc(Rpc.planModeSet, { conversationId, planMode })) as {
      planMode?: unknown
    } | null
    if (answer && typeof answer.planMode === 'boolean') {
      useChatRuntime.getState().setPlanMode(conversationId, answer.planMode)
    }
  } catch {
    useChatRuntime.getState().setPlanMode(conversationId, previous)
  }
}
