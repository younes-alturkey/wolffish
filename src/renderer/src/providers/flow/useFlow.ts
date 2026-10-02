import { createContext, useContext } from 'react'
import type {
  ApprovalDecision,
  ApprovalDescription,
  AskUserAnswer,
  AskUserQuestion,
  DangerLevel,
  DataAnalytics,
  MessageAttachment,
  Segment,
  SegmentTurnEndReason,
  SystemInfo,
  WorkspaceStatus
} from '@preload/index'

export type Screen =
  | 'welcome'
  | 'low-disk-space'
  | 'ollama-setup'
  | 'chat'
  | 'settings'
  | 'viewer'
  | 'history'
  | 'changelog'
  | 'library'
  | 'customization'

export type ChatRole = 'user' | 'assistant'

export type ApprovalCardState = {
  approvalId: string
  toolCallId: string
  tool: string
  args: Record<string, unknown>
  reason: string
  level: DangerLevel
  description?: ApprovalDescription
  decision?: ApprovalDecision
}

/**
 * Live state for an ask-the-user question card, keyed by toolCallId on the
 * assistant message (like approvals). Carries the questions the agent posed
 * plus the user's optimistic answers (stamped when the card submits) so the
 * card reflects the choices the instant the last one is clicked, before the
 * tool_result lands. Not persisted — a resumed conversation rebuilds the
 * answered card from the tool_call args + tool_result segments instead.
 */
export type AskCardState = {
  askId: string
  toolCallId: string
  questions: AskUserQuestion[]
  /** Filled on submit — answers[i] answers questions[i]. */
  answers?: AskUserAnswer[]
  answered?: boolean
}

export type AssistantStatus = 'streaming' | 'complete' | 'error'

export type UserMessage = {
  id: string
  kind?: 'message'
  role: 'user'
  content: string
  attachments?: MessageAttachment[]
  /**
   * Carried through from the persisted message (see ConversationMessage in
   * src/main/conversations.ts). The transcript IS the prompt, so the audio
   * attachment must never be re-exposed to the LLM — textHistory reads this
   * to emit a `<voice_note>` entry instead of composing the attachment back
   * in. Round-tripping it matters now that a channel conversation full of
   * voice notes can be continued from the app.
   */
  voicePrompt?: boolean
  /** Whisper's detected language for a voicePrompt message (ISO 639-1). */
  voiceLang?: string
  /**
   * A user-role message the app wrote, not the person (the Continue after a
   * stalled provider call). Rides history as a user turn; renders as a note.
   */
  systemAside?: boolean
  /** Set while a voice recording is being transcribed, so the bubble
   * can render an animated placeholder until the transcript arrives. */
  transcribing?: boolean
  timestamp?: number
}

export type ToolTiming = {
  startedAt: number
  endedAt?: number
}

export type AssistantMessage = {
  id: string
  kind?: 'message'
  role: 'assistant'
  segments: Segment[]
  /**
   * Per-tool-call approval state, keyed by toolCallId. Approvals sit on
   * the assistant message rather than as standalone chat entries so the
   * card can render inline next to its tool_call segment, preserving the
   * natural flow of the response instead of breaking it with a card
   * floating above or below the bubble.
   */
  approvals?: Record<string, ApprovalCardState>
  /**
   * Per-tool-call ask-the-user state, keyed by toolCallId. Mirrors
   * `approvals`: the question card renders inline next to its tool_call
   * segment while the agent loop is paused waiting for the user's answer.
   */
  asks?: Record<string, AskCardState>
  /**
   * Wall-clock timestamps captured when tool_call / tool_result segments
   * arrive in the renderer. Used purely to display elapsed time on the
   * tool card; not persisted to history.
   */
  toolTimings?: Record<string, ToolTiming>
  status: AssistantStatus
  stopReason?: SegmentTurnEndReason
  error?: string
  timestamp?: number
}

export type ChatMessage = UserMessage | AssistantMessage

/**
 * A procedure queued for auto-send into a fresh chat (the Play button).
 * Carries the procedure's own chat mode so the run honors its stamp — the
 * override rides THIS object into the single send, never renderer state.
 */
export type PendingProcedure = {
  prompt: string
  mode?: 'single' | 'workflow'
  /**
   * The procedure's own reasoning stamp — the override rides THIS object into
   * the single send, never renderer state (the mode contract).
   */
  thinking?: 'off' | 'on' | 'high' | 'max'
  /** The procedure's emoji — stamped on the run's conversation for the rail badge. */
  icon?: string
  /**
   * The procedure's attached files and working folders. Both are seeded onto
   * the conversation this run creates — the folders into the composer's own
   * picker, the files as the run's model-led reference list — so a Play run
   * sees exactly what a detached `procedure_run` of it would, and so does
   * every follow-up turn the user types into that conversation.
   */
  files?: string[]
  directories?: string[]
}

export type FlowContextValue = {
  screen: Screen
  status: WorkspaceStatus | null
  /**
   * Navigate to a screen. Optional `returnTo` records where a follow-up
   * "Continue" should land — e.g. opening ollama-setup from Settings →
   * Models → Ollama sets returnTo='settings' so completing setup returns to
   * the panel it was opened from. Pass `null` to clear.
   */
  goTo: (screen: Screen, returnTo?: Screen | null) => void
  /** Where the user should land after the current screen's primary action. */
  returnTo: Screen | null
  dataAnalytics: DataAnalytics | null
  systemInfo: SystemInfo | null
  refreshData: () => Promise<void>
  refreshStatus: () => Promise<void>
  /**
   * Re-run the launch routing decision. Used by gating screens (e.g.
   * low-disk-space) so that once the blocking condition clears, the user
   * lands on whatever screen they would have started on.
   */
  revalidateScreen: () => Promise<void>
  /**
   * Close the low-disk warning for the rest of this session and route to
   * the screen the user would have started on. Not persisted — the warning
   * comes back on the next launch if space is still low. Past this point
   * disk-full errors are on the user; they were warned.
   */
  dismissDiskGate: () => Promise<void>
}

export const FlowContext = createContext<FlowContextValue | null>(null)

export function useFlow(): FlowContextValue {
  const ctx = useContext(FlowContext)
  if (!ctx) throw new Error('useFlow must be used within a FlowProvider')
  return ctx
}
