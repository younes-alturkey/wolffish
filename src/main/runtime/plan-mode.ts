/**
 * Plan mode per conversation — the one stance every surface shares.
 *
 * A read-only turn that may only write the conversation's plan file
 * (Agent.planMode). It is a choice made for a conversation, not a property
 * of its transcript, so it lives here in memory for the session: the
 * desktop composer's Plan chip and the phone's chat-controls switch both
 * read and write THIS map, and every change fans out to whoever is
 * listening (the renderer windows, the paired phone) so the two never
 * disagree. Nothing is persisted — a relaunch starts every conversation
 * with plan mode off, exactly as the chip did when it was renderer-only.
 */

export type PlanModeChange = { conversationId: string; planMode: boolean }

const stances = new Map<string, boolean>()
const listeners = new Set<(change: PlanModeChange) => void>()

export function getPlanMode(conversationId: string): boolean {
  return stances.get(conversationId) ?? false
}

/** Set one conversation's stance; listeners hear only real changes. */
export function setPlanMode(conversationId: string, planMode: boolean): boolean {
  if (!conversationId) return false
  const current = stances.get(conversationId) ?? false
  if (current === planMode) return current
  if (planMode) stances.set(conversationId, true)
  else stances.delete(conversationId)
  for (const listener of listeners) listener({ conversationId, planMode })
  return planMode
}

export function onPlanModeChange(listener: (change: PlanModeChange) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
