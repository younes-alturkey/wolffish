import { refetchConversation } from '@/lib/conversations/cache'
import {
  appendMessage,
  createConversation,
  getConversationStats,
  updateConversationStats
} from '@/lib/conversations/repo'
import { coalesceTextSegments } from '@/lib/conversations/segments'
import type { ConversationMessage, MessageAttachment, Segment } from '@/lib/conversations/types'
import { mintConversationId, mintMessageId } from '@/lib/conversations/types'
import { foldDemoTurn } from '@/lib/demo/turnStats'
import { useChatRuntime } from '@/state/chatRuntime'
import { markRun } from '@/state/runStatus'
import { useDemoConfig } from '@/state/demoConfig'
import i18n from '@/lib/i18n'

/**
 * Demo-mode agent. Replays the desktop turn lifecycle against local state:
 * optimistic user append → streaming assistant placeholder → text deltas →
 * turn_end → whole-message persist. When the real Durable Object / WebRTC
 * transport lands, this module is the seam it replaces — the stores, feed and
 * composer are transport-agnostic.
 */

/** The demo agent "thinks" this long before answering with the demo card. */
const DEMO_THINKING_MS = 3000
const DEMO_PROVIDER = 'wolffish'
const DEMO_MODEL = 'wolffish-demo'

/**
 * The brain the demo turn is attributed to — the provider and model the
 * picker has lit, by the desktop runtime's own rule (`localOnly` routes to
 * Ollama, otherwise the cloud brain). Nothing is called, but the turn is
 * stamped and priced under it, so switching models moves the context meter's
 * window exactly as it does on the desktop.
 */
function activeBrain(): { provider: string; model: string } {
  const config = useDemoConfig.getState()
  if (config.localOnly && config.localModel) {
    return { provider: 'local', model: config.localModel }
  }
  if (config.brainModel) return { provider: config.brainProvider, model: config.brainModel }
  return { provider: DEMO_PROVIDER, model: DEMO_MODEL }
}

/**
 * The project a chat about to be created belongs to. Consumed once: the
 * pending pick is for the NEXT new conversation, not every later one.
 */
function takePendingProject(): string | undefined {
  const { pendingProjectId, setPendingProject } = useChatRuntime.getState()
  if (!pendingProjectId) return undefined
  setPendingProject(null)
  return pendingProjectId
}

type ActiveTurn = { timer: ReturnType<typeof setTimeout> | null }
const activeTurns = new Map<string, ActiveTurn>()

export function isTurnActive(conversationId: string): boolean {
  return activeTurns.has(conversationId)
}

/**
 * MID-TURN MESSAGES, demo-side — the desktop's turn-runner inbox, on this
 * phone. A message sent while a demo turn is thinking parks here and the turn
 * reads it at its one stop point (`finish` below), where it becomes a
 * `user_message` segment on the assistant message, exactly as the desktop's
 * does. The demo never runs a second turn for it: two turns in one
 * conversation would share this module's single live stream and single
 * `activeTurns` entry, and the first to finish would end the other's overlay.
 */
type DemoInterjection = {
  messageId: string
  text: string
  attachments?: MessageAttachment[]
  voicePrompt?: boolean
  timestamp: number
}
const demoInboxes = new Map<string, DemoInterjection[]>()

/**
 * Park a message on the running demo turn. False when there is no turn to
 * park it on — the caller sends it as an ordinary demo prompt, the same
 * answer `Rpc.interject` gives with `no_live_turn`.
 */
export function demoInterject(conversationId: string, message: DemoInterjection): boolean {
  if (!activeTurns.has(conversationId)) return false
  demoInboxes.set(conversationId, [...(demoInboxes.get(conversationId) ?? []), message])
  return true
}

/** Take one back before the turn reads it — the pending bubble's X. */
export function withdrawDemoInterjection(
  conversationId: string,
  messageId: string
): DemoInterjection | null {
  const inbox = demoInboxes.get(conversationId)
  const found = inbox?.find((message) => message.messageId === messageId)
  if (!inbox || !found) return null
  const next = inbox.filter((message) => message.messageId !== messageId)
  if (next.length === 0) demoInboxes.delete(conversationId)
  else demoInboxes.set(conversationId, next)
  return found
}

/** Everything parked for one conversation, taken off the list. */
function takeDemoInbox(conversationId: string): DemoInterjection[] {
  const inbox = demoInboxes.get(conversationId) ?? []
  demoInboxes.delete(conversationId)
  return inbox
}

/** The `user_message` segments a read inbox becomes, in arrival order. */
function interjectionSegments(turnId: string, read: DemoInterjection[]): Segment[] {
  return read.map((message, index) => ({
    kind: 'user_message',
    turnId,
    segmentId: `seg_u${index}`,
    messageId: message.messageId,
    text: message.text,
    ...(message.attachments && message.attachments.length > 0
      ? { attachments: message.attachments }
      : {}),
    ...(message.voicePrompt ? { voicePrompt: true } : {}),
    timestamp: message.timestamp
  }))
}

/** Desktop titling fallback: an 80-char slice of the first prompt. */
export function deriveTitle(text: string, attachments?: MessageAttachment[]): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  if (trimmed) return trimmed.length > 80 ? `${trimmed.slice(0, 80)}` : trimmed
  const named = attachments?.find((attachment) => attachment.originalName)
  return named?.originalName ?? 'Untitled'
}

function buildDemoReply(): string {
  const heading = i18n.t('demo.reply.heading')
  const body = i18n.t('demo.reply.body')
  const outro = i18n.t('demo.reply.outro')
  return `**${heading}**\n\n${body}\n\n${outro}`
}

/** Mint + persist an empty conversation up front (voice notes need the id
 * before the recording file can be filed under uploads/conv-<id>/). */
export async function ensureDemoConversation(title: string): Promise<string> {
  const now = Date.now()
  const id = mintConversationId(new Date(now))
  const projectId = takePendingProject()
  await createConversation({
    id,
    title,
    model: activeBrain().model,
    messages: [],
    createdAt: now,
    updatedAt: now,
    ...(projectId ? { projectId } : {})
  })
  return id
}

export type SendDemoPromptInput = {
  conversationId: string | null
  text: string
  attachments?: MessageAttachment[]
  voicePrompt?: boolean
  voiceLang?: string
  /** The id the caller's optimistic bubble already renders under. Storing the
   * message under the same id is what lets the feed swap the bubble for the
   * stored copy instead of drawing both — see buildFeed's dedupe. */
  messageId?: string
}

/**
 * Send a prompt in demo mode. Returns the conversation id (freshly minted for
 * a new chat) synchronously-ish so the UI can navigate immediately.
 */
export async function sendDemoPrompt(input: SendDemoPromptInput): Promise<string> {
  const now = Date.now()
  let conversationId = input.conversationId

  if (!conversationId) {
    const projectId = takePendingProject()
    conversationId = mintConversationId(new Date(now))
    await createConversation({
      id: conversationId,
      title: deriveTitle(input.text, input.attachments),
      model: activeBrain().model,
      messages: [],
      createdAt: now,
      updatedAt: now,
      ...(projectId ? { projectId } : {})
    })
  }

  const userMessage: ConversationMessage = {
    id: input.messageId ?? mintMessageId(now),
    role: 'user',
    content: input.text,
    timestamp: now,
    ...(input.attachments && input.attachments.length > 0
      ? { attachments: input.attachments }
      : {}),
    ...(input.voicePrompt ? { voicePrompt: true } : {}),
    ...(input.voiceLang ? { voiceLang: input.voiceLang } : {})
  }
  await appendMessage(conversationId, userMessage)
  // Stored copy first, live row second — the same contract `finish` keeps for
  // the reply. A send with files or a voice note publishes its bubble on the
  // live turn before calling here, and startAssistantTurn's stream replaces
  // that overlay; the query must already hold the stored copy, or the bubble
  // is in neither place for the frames between.
  await refetchConversation(conversationId)

  startAssistantTurn(conversationId, {
    text: input.text,
    attachmentCount: input.attachments?.length ?? 0
  })
  return conversationId
}

/**
 * The demo turn: the feed shows the typed thinking indicator for a few
 * seconds, then a demo-mode card lands explaining that no new messages are
 * processed offline. The prompt comes along because the turn is also priced
 * and folded into the conversation's stats — see turnStats.ts.
 */
function startAssistantTurn(
  conversationId: string,
  prompt: { text: string; attachmentCount: number }
): void {
  const runtime = useChatRuntime.getState()
  const brain = activeBrain()
  const startedAt = Date.now()
  const turnId = `turn_${startedAt}`
  const messageId = mintMessageId()

  runtime.startStream(conversationId, {
    id: messageId,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    segments: []
  })

  const turn: ActiveTurn = { timer: null }
  activeTurns.set(conversationId, turn)

  const finish = async (): Promise<void> => {
    activeTurns.delete(conversationId)
    const reply = buildDemoReply()
    // The stop point: whatever was sent mid-turn is read now, and lands in
    // the assistant message ahead of the reply — the user's words at the
    // point they were taken in, which is also what retires their pending
    // bubble (conversations/feed.ts checks the transcript for the id).
    const read = takeDemoInbox(conversationId)
    const segments: Segment[] = [
      {
        kind: 'active_model',
        turnId,
        segmentId: 'seg_0',
        provider: brain.provider,
        model: brain.model
      },
      ...interjectionSegments(turnId, read),
      { kind: 'text', turnId, segmentId: 'seg_1', delta: reply },
      {
        kind: 'turn_end',
        turnId,
        segmentId: 'seg_2',
        stopReason: 'end_turn',
        iterationCount: 1
      }
    ]
    const finalMessage: ConversationMessage = {
      id: messageId,
      role: 'assistant',
      content: reply,
      timestamp: Date.now(),
      segments: coalesceTextSegments(segments),
      stopReason: 'end_turn'
    }
    await appendMessage(conversationId, finalMessage)

    // Fold the turn into the conversation's stats the way the desktop does at
    // turn end, so the context meter has something real to draw. Stats are
    // decoration: a failure here must never cost the message.
    try {
      const endedAt = Date.now()
      const previous = await getConversationStats(conversationId)
      await updateConversationStats(
        conversationId,
        foldDemoTurn(previous, {
          promptText: prompt.text,
          attachmentCount: prompt.attachmentCount,
          replyText: reply,
          provider: brain.provider,
          model: brain.model,
          elapsedMs: Math.max(1, endedAt - startedAt),
          endedAt
        })
      )
    } catch {
      /* meter stays at its last reading */
    }

    // Stored copy first, live row second. The feed drops a live row as soon as
    // the transcript carries its id (they share one), so the swap is invisible
    // either way — but releasing it before the query has re-read would leave
    // the reply in neither place for a frame. Same contract as a paired turn.
    await refetchConversation(conversationId)
    // The stored copy now carries their segments, so the pending rows come
    // down — the demo's stand-in for the desktop's `delivered` push. Dropped
    // after the refetch for the same reason the live row is: the bubble must
    // exist in the transcript before it stops existing beside it.
    for (const message of read) {
      useChatRuntime.getState().dropPending(conversationId, message.messageId)
    }
    useChatRuntime.getState().endStream(conversationId)
    // The same terminal record a paired turn gets from the desktop's
    // turn.status, so the conversations sheet tints this row identically with
    // or without a desktop behind it.
    markRun(conversationId, 'completed')
  }

  turn.timer = setTimeout(() => void finish(), DEMO_THINKING_MS)
}

/** The red Stop button — cancel the pending demo turn without a reply. */
export function stopDemoTurn(conversationId: string): void {
  const turn = activeTurns.get(conversationId)
  if (!turn) return
  if (turn.timer) clearTimeout(turn.timer)
  activeTurns.delete(conversationId)
  // A turn stopped before its stop point never read what was waiting for it.
  // Those are still messages the user wrote and never sent, so they go back
  // to the composer — the desktop's `withdrawn` (reason `canceled`) by hand,
  // since nothing pushes here.
  const runtime = useChatRuntime.getState()
  for (const message of takeDemoInbox(conversationId)) {
    runtime.dropPending(conversationId, message.messageId)
    if (message.text && !message.voicePrompt) {
      runtime.restoreDraft(conversationId, message.text)
    }
  }
  runtime.endStream(conversationId)
  markRun(conversationId, 'stopped')
}
