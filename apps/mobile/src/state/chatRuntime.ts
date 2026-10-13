import type {
  ApprovalDecision,
  ApprovalDescription,
  AskUserAnswer,
  AskUserQuestion,
  ConversationMessage,
  DangerLevel,
  ConversationChannel
} from '@/lib/conversations/types'
import type { SyncProject } from '@/lib/tunnel/protocol'
import { create } from 'zustand'

/**
 * The project chat is working inside. Structurally the wire project, so whatever
 * the Projects screen or the composer's dialog last saved drops straight in.
 */
export type ActiveProject = SyncProject

/**
 * Live streaming state — the in-flight turn per conversation.
 *
 * Deliberately NOT persisted, and deliberately NOT written to SQLite while it
 * runs: the durable transcript is whatever the desktop has saved, and this
 * store only carries the turn currently being written. That split is what
 * makes the feed monotone. A mid-turn write to SQLite means the body fetch
 * that follows can DELETE it again (the desktop persists an assistant message
 * once, at the end of the turn), and every one of those windows was a row
 * appearing and then vanishing on screen.
 *
 * One entry covers a whole turn, from both ends of it:
 *
 *   user       the prompt this phone just sent, shown from the instant Send is
 *              pressed — before the RPC has even returned a conversation id.
 *   message    the assistant message being written. Empty ⇒ the feed shows the
 *              typed thinking words, exactly as demo mode does.
 *   base/tail  see prompt.ts: `base` is the last full snapshot the desktop
 *              pushed, `tail` the text deltas received since. `message` is the
 *              two composed, and is the only field the feed reads.
 *
 * Both messages carry the ids the desktop will persist them under, so the feed
 * can drop each one the moment the stored transcript contains it — no
 * sequencing, no window where a row is in neither place or in both.
 */

export type StreamStatus = 'streaming' | 'complete' | 'error'

export type LiveStream = {
  message: ConversationMessage
  status: StreamStatus
  /** The prompt that started this turn, while the stored body lacks it. */
  user?: ConversationMessage
  /** Paired mode only — the newest full message snapshot from the desktop. */
  base?: ConversationMessage
  /** Paired mode only — text deltas received after `base`. */
  tail?: string
  /**
   * Where the turn was started — 'cli', 'telegram', 'heartbeat', … Carried so
   * a conversation known ONLY from a running turn can still wear its origin
   * badge. Without it a chat started in a terminal appeared in the list with
   * no glyph at all until the desktop pushed its metadata, which on a slow
   * link is the whole time anyone is watching it happen.
   */
  channel?: ConversationChannel | null
  /**
   * WHY this turn stopped being 'streaming' — which is not the same question as
   * whether it is over, and the difference is the whole reason this field
   * exists.
   *
   *   'desktop'  a terminal `turn.status` for this very turn. The turn IS over.
   *   'assumed'  nobody said so. Set by the reconnect re-settle, which clears
   *              the streaming flag on every turn it may have missed the end of
   *              while the phone was away — a guess that is right often enough
   *              to be worth making and wrong often enough to be worth marking.
   *
   * Anything that reads a non-streaming turn as FINISHED has to check this.
   * The since-retired rating bar is the one that taught us: it took 'not
   * streaming' for 'done', so every reconnect during a live turn — a
   * backgrounded phone coming back is the common one — flashed end-of-turn
   * chrome over a turn still being written, until the next frame arrived and
   * put it away again.
   *
   * Undefined while streaming, and dropped by every putLive: a turn that is
   * being written again is not a turn that ended.
   */
  ended?: 'desktop' | 'assumed'
}

/**
 * A flagged tool call the desktop is holding for this phone's decision. Mirrors
 * the desktop renderer's ApprovalCardState field for field, because it IS that
 * state — pushed over the tunnel instead of over IPC. `decision` is stamped the
 * moment the user taps, before the desktop answers, so the card settles at the
 * tap; the stored transcript carries the same record once the turn is saved.
 */
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
 * A live ask-the-user card. Never persisted — a card replayed from history is
 * rebuilt from the tool_call args plus the tool_result output, exactly as on
 * the desktop — so this exists only for the window in which the turn is parked
 * waiting for an answer, plus the optimistic beat after the user submits.
 */
export type AskCardState = {
  askId: string
  toolCallId: string
  questions: AskUserQuestion[]
  /** Filled on submit — answers[i] answers questions[i]. */
  answers?: AskUserAnswer[]
  answered?: boolean
}

/**
 * The cards one conversation's running turn is parked on, keyed by toolCallId
 * so each renders against its own tool_call segment.
 *
 * Deliberately a sibling of `streams` rather than a field on one: the live
 * message is REPLACED wholesale by every mirror snapshot the desktop pushes,
 * and a card living inside it would be wiped twice a second. These are dropped
 * when the turn settles, at which point the stored transcript renders the
 * outcome instead.
 */
export type ConversationCards = {
  asks: Record<string, AskCardState>
  approvals: Record<string, ApprovalCardState>
}

/**
 * The key a chat with no conversation yet files its plan stance under. A fresh
 * chat gets its id only when the first send creates the conversation on the
 * desktop, so the toggle needs a key before then; sendPrompt moves the stance
 * under the real id once it exists (adoptPlanMode).
 */
export const NEW_CHAT_PLAN_KEY = '\u0000new-chat'

/**
 * The key a mid-turn message files under while the chat it was written in
 * has no conversation id yet — the round trip in which a first send mints
 * one. The screen moves the rows under the real id the moment it has it
 * (movePending) and hands each one to the desktop then.
 */
export const NEW_CHAT_PENDING_KEY = '\u0000new-chat-pending'

export type ChatRuntimeState = {
  streams: Record<string, LiveStream>
  cards: Record<string, ConversationCards>
  /**
   * MID-TURN MESSAGES per conversation — sent while a turn was running and
   * not yet read by the agent. Each is the user's own message under the id
   * this phone minted for it (or the id another surface minted, when the
   * desktop reports one of theirs), drawn as a pending bubble after the live
   * assistant row (conversations/feed.ts).
   *
   * A sibling of `streams`, not a field on one, for the same reason the cards
   * are: the live entry is replaced wholesale by every mirror snapshot and
   * by every putLive, and a list riding on it would be wiped twice a second.
   * It also has to outlive the entry — a pending row exists from the tap,
   * which for a chat with no id yet is before any stream does — and must NOT
   * be dropped when the turn's overlay is (endStream): the desktop, not the
   * overlay, says when a message stops being pending (Event.interjection).
   */
  pending: Record<string, ConversationMessage[]>
  /** Put one pending row up, or replace the one with the same id in place. */
  putPending: (key: string, message: ConversationMessage) => void
  /** Replace a conversation's whole pending list — the cold-start seed. */
  setPending: (key: string, messages: ConversationMessage[]) => void
  dropPending: (key: string, messageId: string) => void
  clearPending: (key: string) => void
  /** Re-file rows written before the conversation had an id under the id it now has. */
  movePending: (from: string, to: string) => void
  /**
   * Text handed BACK to the composer: a mid-turn message withdrawn (by the
   * user, or by the turn being stopped) is the user's draft again, not a
   * message that was sent. Keyed like `pending`; the composer of the chat
   * that key names takes it on its next render (takeDraftRestore) and
   * appends it to whatever is being typed.
   */
  draftRestores: Record<string, string>
  restoreDraft: (key: string, text: string) => void
  takeDraftRestore: (key: string) => void
  /**
   * PLAN MODE per conversation — the desktop composer's Plan chip, mirrored:
   * a stance for the next turns (read-only, the agent only writes its plan
   * file) rather than a property of the transcript. In memory for the
   * session, keyed by conversation id or NEW_CHAT_PLAN_KEY, never persisted
   * and never synced: it rides each send as `planMode` on the wire.
   */
  planModes: Record<string, boolean>
  setPlanMode: (conversationId: string | null, value: boolean) => void
  /** The fresh chat's stance follows the conversation its first send created. */
  adoptPlanMode: (conversationId: string) => void
  /**
   * Project a new chat will be filed under. A conversation does not exist
   * until its first message, so a project picked before then has nothing to
   * be stamped on yet — it waits here and the agent applies it at creation,
   * the desktop's "new chat in this project" without the extra screen.
   */
  pendingProjectId: string | null
  setPendingProject: (projectId: string | null) => void
  /**
   * PROJECT MODE: the project the chat screen is currently working inside — the
   * desktop's `activeProject`. Distinct from `pendingProjectId`, which is one
   * new chat's filing: this one persists across conversations, replaces the
   * composer's menu button with the project's emoji, and files every new chat
   * started while it is set.
   *
   * The ID, deliberately, not the project. It was the whole object first, and
   * that made project mode a SECOND COPY of a row the query cache already holds:
   * an edit made on the desktop refreshed the list and left this copy behind, so
   * the composer's emoji and the chat hero kept showing the old title until
   * something happened to rewrite them. Holding the id means every consumer
   * reads the one list (see useActiveProject) and a desktop edit lands on all of
   * them in the same render as the list itself.
   *
   * In memory only, exactly like the desktop's: project mode is a thing you are
   * doing right now, and a relaunch into a project the user has since forgotten
   * about would be a surprise, not a restoration.
   */
  activeProjectId: string | null
  /** Takes the project (or its id) for the caller's convenience; stores the id. */
  setActiveProject: (project: ActiveProject | string | null) => void
  /**
   * A prompt handed to the chat screen to send as a fresh conversation — a
   * procedure's Run.
   *
   * Through the store rather than a navigation param, because the screen it is
   * for is already on the stack: the run pops back to it, and a param attached to
   * a pop is not something to rely on. The chat screen consumes this (clearing it
   * as it does) once it has actually reset to an empty chat, which is what keeps
   * the prompt out of whatever conversation happened to be open.
   */
  pendingPrompt: string | null
  setPendingPrompt: (prompt: string | null) => void
  startStream: (conversationId: string, message: ConversationMessage) => void
  updateStream: (conversationId: string, message: ConversationMessage) => void
  /** Whole-value upsert — the paired path rebuilds the entry on every event. */
  putStream: (conversationId: string, stream: LiveStream) => void
  endStream: (conversationId: string) => void
  /** Put one card up, or replace it — keyed by its tool call. */
  putAsk: (conversationId: string, ask: AskCardState) => void
  putApproval: (conversationId: string, approval: ApprovalCardState) => void
  /** Take one card down — it was answered somewhere else, or never landed. */
  dropAsk: (conversationId: string, toolCallId: string) => void
  dropApproval: (conversationId: string, toolCallId: string) => void
  /** Every card for a conversation, dropped together when its turn settles. */
  clearCards: (conversationId: string) => void
  /** Drop every stream and pending binding — a demo refresh replaces the
   *  conversations these point at (lib/demo/reset). */
  reset: () => void
}

const NO_CARDS: ConversationCards = { asks: {}, approvals: {} }

export const useChatRuntime = create<ChatRuntimeState>()((set) => ({
  streams: {},
  cards: {},
  pending: {},
  putPending: (key, message) =>
    set((state) => {
      const current = state.pending[key] ?? []
      const index = current.findIndex((m) => m.id === message.id)
      const next =
        index >= 0 ? current.map((m, i) => (i === index ? message : m)) : [...current, message]
      return { pending: { ...state.pending, [key]: next } }
    }),
  setPending: (key, messages) =>
    set((state) => {
      if (messages.length === 0) {
        if (!state.pending[key]) return state
        const { [key]: _gone, ...rest } = state.pending
        return { pending: rest }
      }
      return { pending: { ...state.pending, [key]: messages } }
    }),
  dropPending: (key, messageId) =>
    set((state) => {
      const current = state.pending[key]
      if (!current?.some((m) => m.id === messageId)) return state
      const next = current.filter((m) => m.id !== messageId)
      if (next.length === 0) {
        const { [key]: _gone, ...rest } = state.pending
        return { pending: rest }
      }
      return { pending: { ...state.pending, [key]: next } }
    }),
  clearPending: (key) =>
    set((state) => {
      if (!state.pending[key]) return state
      const { [key]: _gone, ...rest } = state.pending
      return { pending: rest }
    }),
  movePending: (from, to) =>
    set((state) => {
      const moving = state.pending[from]
      if (!moving || from === to) return state
      const { [from]: _gone, ...rest } = state.pending
      return { pending: { ...rest, [to]: [...(rest[to] ?? []), ...moving] } }
    }),
  draftRestores: {},
  restoreDraft: (key, text) =>
    set((state) => {
      if (!text) return state
      const current = state.draftRestores[key]
      return {
        draftRestores: { ...state.draftRestores, [key]: current ? `${current}\n${text}` : text }
      }
    }),
  takeDraftRestore: (key) =>
    set((state) => {
      if (!state.draftRestores[key]) return state
      const { [key]: _gone, ...rest } = state.draftRestores
      return { draftRestores: rest }
    }),
  planModes: {},
  setPlanMode: (conversationId, value) =>
    set((state) => ({
      planModes: { ...state.planModes, [conversationId ?? NEW_CHAT_PLAN_KEY]: value }
    })),
  adoptPlanMode: (conversationId) =>
    set((state) => {
      const { [NEW_CHAT_PLAN_KEY]: stance, ...rest } = state.planModes
      if (stance === undefined) return state
      return { planModes: { ...rest, [conversationId]: stance } }
    }),
  pendingProjectId: null,
  setPendingProject: (pendingProjectId) => set({ pendingProjectId }),
  activeProjectId: null,
  // Entering a project clears any per-chat pick: the project mode IS the filing
  // now, and leaving it must not leave the last new chat pointed somewhere else.
  setActiveProject: (project) =>
    set({
      activeProjectId: typeof project === 'string' ? project : (project?.id ?? null),
      pendingProjectId: null
    }),
  pendingPrompt: null,
  setPendingPrompt: (pendingPrompt) => set({ pendingPrompt }),
  startStream: (conversationId, message) =>
    set((state) => ({
      streams: { ...state.streams, [conversationId]: { message, status: 'streaming' } }
    })),
  updateStream: (conversationId, message) =>
    set((state) => {
      const current = state.streams[conversationId]
      if (!current) return state
      return {
        streams: { ...state.streams, [conversationId]: { ...current, message } }
      }
    }),
  putStream: (conversationId, stream) =>
    set((state) => ({ streams: { ...state.streams, [conversationId]: stream } })),
  endStream: (conversationId) =>
    set((state) => {
      if (!state.streams[conversationId]) return state
      const { [conversationId]: _gone, ...rest } = state.streams
      return { streams: rest }
    }),
  putAsk: (conversationId, ask) =>
    set((state) => {
      const current = state.cards[conversationId] ?? NO_CARDS
      return {
        cards: {
          ...state.cards,
          [conversationId]: {
            ...current,
            asks: { ...current.asks, [ask.toolCallId]: ask }
          }
        }
      }
    }),
  putApproval: (conversationId, approval) =>
    set((state) => {
      const current = state.cards[conversationId] ?? NO_CARDS
      return {
        cards: {
          ...state.cards,
          [conversationId]: {
            ...current,
            approvals: { ...current.approvals, [approval.toolCallId]: approval }
          }
        }
      }
    }),
  dropAsk: (conversationId, toolCallId) =>
    set((state) => {
      const current = state.cards[conversationId]
      if (!current?.asks[toolCallId]) return state
      const { [toolCallId]: _gone, ...asks } = current.asks
      return { cards: { ...state.cards, [conversationId]: { ...current, asks } } }
    }),
  dropApproval: (conversationId, toolCallId) =>
    set((state) => {
      const current = state.cards[conversationId]
      if (!current?.approvals[toolCallId]) return state
      const { [toolCallId]: _gone, ...approvals } = current.approvals
      return { cards: { ...state.cards, [conversationId]: { ...current, approvals } } }
    }),
  clearCards: (conversationId) =>
    set((state) => {
      if (!state.cards[conversationId]) return state
      const { [conversationId]: _gone, ...rest } = state.cards
      return { cards: rest }
    }),
  reset: () =>
    set({
      streams: {},
      cards: {},
      pending: {},
      draftRestores: {},
      planModes: {},
      pendingProjectId: null,
      activeProjectId: null,
      pendingPrompt: null
    })
}))

/** One conversation's live cards, or the shared empty pair. A stable
 *  reference for both, so a subscribing component only re-renders when a
 *  card actually moves. */
export function cardsFor(conversationId: string | undefined): ConversationCards {
  if (!conversationId) return NO_CARDS
  return useChatRuntime.getState().cards[conversationId] ?? NO_CARDS
}

/** Selector form of `cardsFor`, for components. */
export function selectCards(
  conversationId: string | undefined
): (state: ChatRuntimeState) => ConversationCards {
  return (state) => (conversationId ? state.cards[conversationId] : undefined) ?? NO_CARDS
}

/** Read one conversation's live turn outside React (event handlers, tests). */
export function liveStreamFor(conversationId: string): LiveStream | undefined {
  return useChatRuntime.getState().streams[conversationId]
}

const NO_PENDING: ConversationMessage[] = []

/** Selector for one conversation's pending mid-turn rows — a stable empty
 *  array when there are none, so a subscriber re-renders only on a change. */
export function selectPending(
  key: string | null | undefined
): (state: ChatRuntimeState) => ConversationMessage[] {
  return (state) => (key ? state.pending[key] : undefined) ?? NO_PENDING
}

/** The same, outside React. */
export function pendingFor(key: string | null | undefined): ConversationMessage[] {
  return selectPending(key)(useChatRuntime.getState())
}

/** One conversation's plan stance (the fresh chat's when there is no id). */
export function selectPlanMode(
  conversationId: string | null | undefined
): (state: ChatRuntimeState) => boolean {
  return (state) => state.planModes[conversationId ?? NEW_CHAT_PLAN_KEY] ?? false
}

/** The same, outside React — what the send path stamps on the wire. */
export function planModeFor(conversationId: string | null | undefined): boolean {
  return selectPlanMode(conversationId)(useChatRuntime.getState())
}
