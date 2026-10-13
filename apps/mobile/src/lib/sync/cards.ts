import type {
  ApprovalDecision,
  ApprovalDescription,
  AskUserQuestion,
  AskUserResponse,
  DangerLevel
} from '@/lib/conversations/types'
import { attachPlanModeStream } from '@/lib/sync/planMode'
import { tunnelClient } from '@/lib/tunnel/client'
import { Event, Rpc } from '@/lib/tunnel/protocol'
import { useChatRuntime, type ApprovalCardState } from '@/state/chatRuntime'

/**
 * The two cards a running turn can park on: an ask-the-user question, and an
 * approval for a tool call the desktop flagged as dangerous.
 *
 * The desktop holds the turn open — the agent pipeline is literally blocked on
 * a promise over there — and pushes the request here. The phone renders the
 * card, the user acts, and the answer goes back as an RPC that resolves that
 * promise. Which makes the contract short and unforgiving:
 *
 *  - The card is live ONLY while the desktop is still holding it. The desktop
 *    fails every parked request closed (approvals deny, asks cancel) when the
 *    turn ends or the link drops, so `ok: false` from a response means the
 *    turn moved on without this answer — the card comes down rather than
 *    pretending it landed.
 *  - Nothing is queued for later. A decision that arrives after the turn is
 *    over is not a late decision, it is a wrong one, and the offline outbox
 *    that carries settings writes would deliver exactly that.
 *  - Optimism is local and reversible: the card settles the instant the user
 *    taps, and rolls back if the answer never reached the desktop.
 *
 * Cards live in chatRuntime beside the live turn and are dropped when it
 * settles — from then on the stored transcript renders the outcome (an
 * approval persists on the assistant message; an answered question is rebuilt
 * from the tool_call args and the tool_result output).
 */

/** Read one question off the wire. The wire is data — a malformed entry is
 *  dropped rather than trusted, and a card with no questions never opens. */
function sanitizeQuestions(raw: unknown): AskUserQuestion[] {
  if (!Array.isArray(raw)) return []
  const out: AskUserQuestion[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const question = typeof entry.question === 'string' ? entry.question : ''
    const options = Array.isArray(entry.options)
      ? entry.options.flatMap((option) => {
          if (!option || typeof option !== 'object') return []
          const value = option as Record<string, unknown>
          const label = typeof value.label === 'string' ? value.label.trim() : ''
          if (!label) return []
          const description =
            typeof value.description === 'string' ? value.description.trim() : undefined
          return [{ label, ...(description ? { description } : {}) }]
        })
      : []
    if (!question && options.length === 0) continue
    out.push({
      question,
      details: typeof entry.details === 'string' ? entry.details : undefined,
      options,
      allowOther: entry.allowOther !== false,
      otherLabel: typeof entry.otherLabel === 'string' ? entry.otherLabel : undefined,
      otherDescription:
        typeof entry.otherDescription === 'string' ? entry.otherDescription : undefined
    })
  }
  return out
}

function sanitizeDescription(raw: unknown): ApprovalDescription | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const title = typeof value.title === 'string' ? value.title : ''
  const description = typeof value.description === 'string' ? value.description : ''
  if (!title && !description) return undefined
  const risk = value.risk
  return {
    title,
    description,
    command: typeof value.command === 'string' ? value.command : undefined,
    impact: typeof value.impact === 'string' ? value.impact : undefined,
    risk: risk === 'low' || risk === 'high' ? risk : 'medium'
  }
}

const DANGER_LEVELS: DangerLevel[] = ['safe', 'warn', 'confirm', 'destructive', 'block']

/**
 * Subscribe to the parked-card topics. Called from `attachTurnStream` on every
 * connect — handlers are stored per topic, so re-attaching replaces rather
 * than stacks.
 */
export function attachCardStream(): void {
  const tunnel = tunnelClient.active
  if (!tunnel) return
  // Plan mode rides the same stream: a stance flipped on the desktop lands
  // on the phone's switch and chip the same way a parked card does.
  attachPlanModeStream()

  tunnel.onEvent(Event.askRequest, (payload) => {
    const { conversationId, id, toolCallId, questions } = (payload ?? {}) as {
      conversationId?: string
      id?: string
      toolCallId?: string
      questions?: unknown
    }
    if (!conversationId || typeof id !== 'string' || typeof toolCallId !== 'string') return
    const parsed = sanitizeQuestions(questions)
    // A card with nothing to ask would be an empty shell the user cannot
    // dismiss — the desktop's own timeout is what should resolve that turn.
    if (parsed.length === 0) return
    useChatRuntime.getState().putAsk(conversationId, { askId: id, toolCallId, questions: parsed })
  })

  tunnel.onEvent(Event.approvalRequest, (payload) => {
    const { conversationId, id, toolCallId, tool, args, level, reason, description } = (payload ??
      {}) as {
      conversationId?: string
      id?: string
      toolCallId?: string
      tool?: string
      args?: unknown
      level?: unknown
      reason?: unknown
      description?: unknown
    }
    if (!conversationId || typeof id !== 'string' || typeof toolCallId !== 'string') return
    useChatRuntime.getState().putApproval(conversationId, {
      approvalId: id,
      toolCallId,
      tool: typeof tool === 'string' ? tool : 'unknown',
      args: args && typeof args === 'object' ? (args as Record<string, unknown>) : {},
      reason: typeof reason === 'string' ? reason : '',
      level: DANGER_LEVELS.includes(level as DangerLevel) ? (level as DangerLevel) : 'confirm',
      description: sanitizeDescription(description)
    })
  })
}

/**
 * Re-seed the cards a turn is still parked on, from the desktop's own record
 * of them (Rpc.turnMirror) — the recovery path for a phone that joined the
 * turn late. The original pushes are gone for such a phone: a card lives in
 * memory and nothing re-sends it, so a relaunch while a question was open
 * left the desktop parked on a promise this phone could no longer see, let
 * alone answer.
 *
 * Same sanitizers as the push handlers — the wire is data, not policy — and
 * strictly additive: a card already up (with the user's optimistic answer on
 * it, perhaps) is never replaced by the desktop's still-pending copy.
 */
export function seedTurnCards(conversationId: string, asks: unknown, approvals: unknown): void {
  const store = useChatRuntime.getState()
  const current = store.cards[conversationId]
  if (Array.isArray(asks)) {
    for (const raw of asks) {
      if (!raw || typeof raw !== 'object') continue
      const { id, toolCallId, questions } = raw as Record<string, unknown>
      if (typeof id !== 'string' || typeof toolCallId !== 'string') continue
      if (current?.asks[toolCallId]) continue
      const parsed = sanitizeQuestions(questions)
      if (parsed.length === 0) continue
      store.putAsk(conversationId, { askId: id, toolCallId, questions: parsed })
    }
  }
  if (Array.isArray(approvals)) {
    for (const raw of approvals) {
      if (!raw || typeof raw !== 'object') continue
      const { id, toolCallId, tool, args, level, reason, description } = raw as Record<
        string,
        unknown
      >
      if (typeof id !== 'string' || typeof toolCallId !== 'string') continue
      if (current?.approvals[toolCallId]) continue
      store.putApproval(conversationId, {
        approvalId: id,
        toolCallId,
        tool: typeof tool === 'string' ? tool : 'unknown',
        args: args && typeof args === 'object' ? (args as Record<string, unknown>) : {},
        reason: typeof reason === 'string' ? reason : '',
        level: DANGER_LEVELS.includes(level as DangerLevel) ? (level as DangerLevel) : 'confirm',
        description: sanitizeDescription(description)
      })
    }
  }
}

/**
 * Answer a question card. The card shows the answers immediately and the turn
 * on the desktop resumes when this lands; a response the desktop no longer
 * recognises takes the card down instead, and a failed send puts it back the
 * way it was so the user can try again.
 */
export async function respondAsk(
  conversationId: string,
  askId: string,
  toolCallId: string,
  response: AskUserResponse
): Promise<void> {
  const store = useChatRuntime.getState()
  const ask = store.cards[conversationId]?.asks[toolCallId]
  if (!ask || ask.answered) return
  store.putAsk(conversationId, {
    ...ask,
    answered: true,
    answers: response.kind === 'answered' ? response.answers : undefined
  })

  const tunnel = tunnelClient.active
  if (!tunnel || !tunnelClient.connected) {
    useChatRuntime.getState().putAsk(conversationId, { ...ask, answered: false })
    return
  }
  try {
    const result = (await tunnel.rpc(Rpc.askRespond, { id: askId, response })) as { ok?: boolean }
    if (result?.ok === false) useChatRuntime.getState().dropAsk(conversationId, toolCallId)
  } catch {
    // Never delivered — the turn is still parked over there, so the card goes
    // back to being answerable rather than silently swallowing the answer.
    useChatRuntime.getState().putAsk(conversationId, { ...ask, answered: false })
  }
}

/** Approve or deny a flagged tool call, on the same contract as `respondAsk`. */
export async function respondApproval(
  conversationId: string,
  approval: ApprovalCardState,
  decision: ApprovalDecision
): Promise<void> {
  const store = useChatRuntime.getState()
  const current = store.cards[conversationId]?.approvals[approval.toolCallId]
  if (!current || current.decision !== undefined) return
  store.putApproval(conversationId, { ...current, decision })

  const tunnel = tunnelClient.active
  if (!tunnel || !tunnelClient.connected) {
    useChatRuntime.getState().putApproval(conversationId, { ...current, decision: undefined })
    return
  }
  try {
    const result = (await tunnel.rpc(Rpc.approvalRespond, {
      id: approval.approvalId,
      decision
    })) as { ok?: boolean }
    if (result?.ok === false) {
      useChatRuntime.getState().dropApproval(conversationId, approval.toolCallId)
    }
  } catch {
    useChatRuntime.getState().putApproval(conversationId, { ...current, decision: undefined })
  }
}
