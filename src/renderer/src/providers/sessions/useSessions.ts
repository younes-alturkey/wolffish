import type { ConversationFile } from '@preload/index'
import type { ChatMessage, PendingProcedure } from '@providers/flow/useFlow'
import { createContext, useContext } from 'react'

/**
 * One open chat session = one mounted <Chat> instance. Conversations now run
 * CONCURRENTLY: every session keeps its own feed, composer, meter, timeline
 * and in-flight turn; the active one is visible, the rest stay mounted but
 * hidden (the same keepalive trick Chat already used across navigation).
 * Switching conversations means switching sessions — live state is never
 * torn down under a running turn.
 */
export type SessionDescriptor = {
  /** Stable React key for the mounted Chat instance. */
  key: string
  /** Conversation to open (null = fresh chat). */
  initialConversationId: string | null
  /** Pre-mapped feed messages for an opened conversation. */
  initialMessages: ChatMessage[] | null
  /** A procedure queued to auto-send into this (fresh) session. */
  procedure: PendingProcedure | null
  /** Project this session's conversation runs inside (null = plain chat). */
  projectId: string | null
  /**
   * Source emoji stamped on conversations this session creates (a played
   * procedure's icon). Durable — survives the one-shot procedure consumption,
   * so the end-of-turn save still carries it.
   */
  icon: string | null
}

/** What a Chat instance reports back about itself. */
export type SessionInfo = {
  conversationId: string | null
  streaming: boolean
  /**
   * Unsent composer state (draft text, staged attachments, a voice take or
   * in-flight transcription). Dirty sessions are never evicted — eviction
   * would silently destroy work the user hasn't sent yet.
   */
  dirty: boolean
}

/**
 * Live/last-known run state per conversation, driven by the main process's
 * chat:turnState broadcast — which fires for EVERY channel's turns (in-app,
 * WhatsApp, Telegram), so the sidebar chips cover them all.
 */
export type ConversationRunPhase = 'processing' | 'completed' | 'failed' | 'stopped'

export type ConversationRunStatus = {
  phase: ConversationRunPhase
  channel: string
  title: string | null
  /** Wall-clock of the last phase change (ordering/staleness). */
  at: number
}

export type ChatSessionsValue = {
  sessions: SessionDescriptor[]
  activeSessionKey: string
  /** The visible session's conversation id (null = fresh chat). */
  activeConversationId: string | null
  /** Per-conversation run status for this app session, keyed by conversation id. */
  runStatuses: Record<string, ConversationRunStatus>
  /** Open a brand-new chat session (or refocus an existing empty idle one). */
  newSession: (opts?: { procedure?: PendingProcedure; projectId?: string | null }) => void
  /**
   * The active project — chat runs in "project mode" while set: fresh
   * sessions bind to it, the rail filters to its conversations, and the
   * composer/new-button/hero swap to project chrome. Cleared on exit.
   */
  activeProject: import('@preload/index').Project | null
  setActiveProject: (project: import('@preload/index').Project | null) => void
  /**
   * Open a conversation: activates the live session already holding it (its
   * in-flight stream and state intact), or spawns a session seeded with the
   * loaded file + pre-mapped messages.
   */
  openConversation: (conversation: ConversationFile, messages: ChatMessage[]) => void
  activateSession: (key: string) => void
  /**
   * Activate the live session already holding this conversation, WITHOUT
   * loading from disk. Returns true if one existed and was focused. This is
   * how a still-processing in-app conversation is reopened: it has no file on
   * disk yet (the renderer persists only at end of turn), so a load-first
   * open path would dead-end — but its live session is always mounted.
   */
  activateConversation: (conversationId: string) => boolean
  /** Chat instances report their conversation id + liveness here. */
  reportSession: (key: string, info: SessionInfo) => void
  /**
   * Synchronously mark a session as mid-send (from the moment Enter is pressed
   * until the turn is in flight). Eviction spares it — a fresh session must
   * window.api.conversation.create() on disk before `streaming` flips, and
   * evicting it during that await would drop the whole turn.
   */
  markSending: (key: string, sending: boolean) => void
  /**
   * One-shot consumption of a session's queued procedure: nulls it on the
   * descriptor the moment the auto-send fires, so a remounted instance can
   * never execute the procedure a second time.
   */
  consumeProcedure: (key: string) => void
  /**
   * Drop the session holding this conversation (after a delete) so its
   * instance unmounts and can never re-persist the removed file. Ensures at
   * least one session remains.
   */
  closeConversation: (conversationId: string) => void
}

export const ChatSessionsContext = createContext<ChatSessionsValue | null>(null)

export function useSessions(): ChatSessionsValue {
  const ctx = useContext(ChatSessionsContext)
  if (!ctx) throw new Error('useSessions must be used within a ChatSessionsProvider')
  return ctx
}
