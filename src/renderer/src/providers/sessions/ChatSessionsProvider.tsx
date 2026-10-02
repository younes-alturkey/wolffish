import type { ConversationFile, Project } from '@preload/index'
import type { ChatMessage, PendingProcedure } from '@providers/flow/useFlow'
import {
  ChatSessionsContext,
  type ChatSessionsValue,
  type ConversationRunStatus,
  type SessionDescriptor,
  type SessionInfo
} from '@providers/sessions/useSessions'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

/**
 * Sessions kept mounted at most. Streaming sessions and the active one are
 * never evicted, so the cap can be exceeded while many turns run — it only
 * bounds how many finished, backgrounded feeds linger in memory.
 */
const MAX_SESSIONS = 6

let sessionCounter = 0
function nextKey(): string {
  sessionCounter += 1
  return `session_${sessionCounter}_${Date.now().toString(36)}`
}

export function ChatSessionsProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionDescriptor[]>(() => [
    {
      key: nextKey(),
      initialConversationId: null,
      initialMessages: null,
      procedure: null,
      projectId: null,
      icon: null
    }
  ])
  const [activeSessionKey, setActiveSessionKey] = useState(() => sessions[0].key)
  // Project mode: the loaded project the visible chat runs inside. Opening a
  // conversation always re-derives it from that conversation's binding (a
  // plain conversation exits project mode — the filtered rail must never hide
  // what was just opened), so the mode can't go stale or contradict the feed.
  const [activeProject, setActiveProjectState] = useState<Project | null>(null)
  // Ref mirror written ONLY through the setter (callback context, never
  // render), so sync-time comparisons don't chase stale closures. The seq
  // token invalidates in-flight async syncs: every direct set bumps it, so
  // a stale projects.list() resolution (open project conv → immediately open
  // a plain one, or exit-project racing a pending sync) can never resurrect
  // a project over what the user just switched to.
  const activeProjectRef = useRef<Project | null>(null)
  const projectSyncSeq = useRef(0)
  const setActiveProject = useCallback((project: Project | null) => {
    projectSyncSeq.current += 1
    activeProjectRef.current = project
    setActiveProjectState(project)
  }, [])
  const syncProjectFor = useCallback(
    (projectId: string | null | undefined) => {
      const id = projectId ?? null
      if (id === (activeProjectRef.current?.id ?? null)) return
      if (!id) {
        setActiveProject(null)
        return
      }
      projectSyncSeq.current += 1
      const seq = projectSyncSeq.current
      void window.api.projects
        .list()
        .then((all) => {
          if (projectSyncSeq.current !== seq) return
          setActiveProject(all.find((p) => p.id === id) ?? null)
        })
        .catch(() => {})
    },
    [setActiveProject]
  )
  const [runStatuses, setRunStatuses] = useState<Record<string, ConversationRunStatus>>({})
  // Live info reported by each mounted Chat instance. State drives renders
  // (activeConversationId below); the ref mirror keeps reads synchronous
  // inside callbacks (eviction / open-routing decisions) without stale
  // closures.
  const [infos, setInfos] = useState<ReadonlyMap<string, SessionInfo>>(new Map())
  const infosRef = useRef(new Map<string, SessionInfo>())
  // conversationId → sessionKey, maintained imperatively so open-routing is
  // race-free (state closures lag; this map never does). Entries are removed
  // whenever their session is evicted or closed.
  const openConversationsRef = useRef(new Map<string, string>())
  // Sessions currently mid-send (Enter pressed, turn not yet streaming). Held
  // synchronously so eviction can spare them during the fresh-session
  // conversation.create() await.
  const sendingKeysRef = useRef(new Set<string>())

  const markSending = useCallback((key: string, sending: boolean) => {
    if (sending) sendingKeysRef.current.add(key)
    else sendingKeysRef.current.delete(key)
  }, [])

  const unregisterSessionKey = useCallback((key: string) => {
    infosRef.current.delete(key)
    sendingKeysRef.current.delete(key)
    for (const [cid, sessionKey] of openConversationsRef.current.entries()) {
      if (sessionKey === key) openConversationsRef.current.delete(cid)
    }
  }, [])

  // Cold-start seed: chat:turnState carries TRANSITIONS only, and this app
  // keeps running (channels included) with no window at all — so a window
  // opened, reopened from the tray, or reloaded while a Telegram/WhatsApp
  // turn is in flight never saw its 'started' and would render the
  // conversation idle. Ask main what's running right now.
  useEffect(() => {
    let cancelled = false
    void window.api.chat
      .activeRuns()
      .then((runs) => {
        if (cancelled || runs.length === 0) return
        setRunStatuses((prev) => {
          const next = { ...prev }
          for (const run of runs) {
            // A live event that landed while this call was in flight is
            // strictly fresher than the snapshot — never overwrite it (the
            // run may already have finished).
            if (next[run.conversationId]) continue
            next[run.conversationId] = {
              phase: 'processing',
              channel: run.channel,
              title: run.title,
              at: Date.now()
            }
          }
          return next
        })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Turn lifecycle across ALL channels (in-app, WhatsApp, Telegram) — the
  // single source for the sidebar's status chips.
  useEffect(() => {
    return window.api.chat.onTurnState((ev) => {
      if (!ev.conversationId) return
      const phase: ConversationRunStatus['phase'] =
        ev.phase === 'started'
          ? 'processing'
          : ev.phase === 'done'
            ? 'completed'
            : ev.phase === 'canceled'
              ? 'stopped'
              : 'failed'
      setRunStatuses((prev) => ({
        ...prev,
        [ev.conversationId as string]: {
          phase,
          channel: ev.channel,
          title: ev.title ?? prev[ev.conversationId as string]?.title ?? null,
          at: Date.now()
        }
      }))
    })
  }, [])

  const reportSession = useCallback((key: string, info: SessionInfo) => {
    const prev = infosRef.current.get(key)
    if (
      prev &&
      prev.conversationId === info.conversationId &&
      prev.streaming === info.streaming &&
      prev.dirty === info.dirty
    ) {
      return
    }
    infosRef.current.set(key, info)
    if (info.conversationId) openConversationsRef.current.set(info.conversationId, key)
    setInfos(new Map(infosRef.current))
  }, [])

  const consumeProcedure = useCallback((key: string) => {
    setSessions((prev) =>
      prev.map((s) => (s.key === key && s.procedure ? { ...s, procedure: null } : s))
    )
  }, [])

  /**
   * Drop finished background sessions beyond the cap. Never evicts the
   * active session, one with a live stream, or one holding unsent composer
   * state (draft/attachments/voice take) — that state is irreplaceable; a
   * finished clean session's transcript reloads from disk on demand.
   */
  const evictIfNeeded = useCallback(
    (list: SessionDescriptor[], activeKey: string): SessionDescriptor[] => {
      if (list.length <= MAX_SESSIONS) return list
      const out = [...list]
      for (let i = 0; i < out.length && out.length > MAX_SESSIONS; i++) {
        const s = out[i]
        if (s.key === activeKey) continue
        if (sendingKeysRef.current.has(s.key)) continue
        const info = infosRef.current.get(s.key)
        if (info?.streaming || info?.dirty) continue
        unregisterSessionKey(s.key)
        out.splice(i, 1)
        i -= 1
      }
      return out
    },
    [unregisterSessionKey]
  )

  const newSession = useCallback(
    (opts?: { procedure?: PendingProcedure; projectId?: string | null }) => {
      const procedure = opts?.procedure ?? null
      const projectId = opts?.projectId ?? null
      // Entering a plain fresh chat exits project mode; a project New keeps it.
      syncProjectFor(projectId)
      if (!procedure) {
        // Reuse an existing empty idle session instead of stacking blanks —
        // clicking New Chat twice should land on the same fresh composer.
        // Scoped per project: a project New never adopts a plain blank (its
        // sends must carry the binding) and vice versa.
        const blank = sessions.find((s) => {
          const info = infosRef.current.get(s.key)
          return (
            s.initialConversationId === null &&
            s.procedure === null &&
            s.projectId === projectId &&
            (!info || (info.conversationId === null && !info.streaming))
          )
        })
        if (blank) {
          setActiveSessionKey(blank.key)
          return
        }
      }
      const descriptor: SessionDescriptor = {
        key: nextKey(),
        initialConversationId: null,
        initialMessages: null,
        procedure,
        projectId,
        icon: procedure?.icon ?? null
      }
      setSessions((prev) => evictIfNeeded([...prev, descriptor], descriptor.key))
      setActiveSessionKey(descriptor.key)
    },
    [sessions, evictIfNeeded, syncProjectFor]
  )

  const openConversation = useCallback(
    (conversation: ConversationFile, messages: ChatMessage[]) => {
      // A live session already holding this conversation wins — activating it
      // preserves its in-flight stream, meter and composer exactly as left.
      // The imperative registry (not the render-time `sessions` closure) is
      // the dedupe authority: two rapid opens of the same conversation both
      // await their load first, and the second's closure predates the
      // first's state commit — the registry doesn't.
      // Opening a project-bound conversation activates its project; a plain
      // one exits project mode. Runs on every open path (rail, History).
      syncProjectFor(conversation.projectId)
      const existingKey = openConversationsRef.current.get(conversation.id)
      if (existingKey) {
        setActiveSessionKey(existingKey)
        return
      }
      for (const s of sessions) {
        const info = infosRef.current.get(s.key)
        const cid = info?.conversationId ?? s.initialConversationId
        if (cid === conversation.id) {
          openConversationsRef.current.set(conversation.id, s.key)
          setActiveSessionKey(s.key)
          return
        }
      }
      const descriptor: SessionDescriptor = {
        key: nextKey(),
        initialConversationId: conversation.id,
        initialMessages: messages,
        procedure: null,
        projectId: conversation.projectId ?? null,
        icon: conversation.icon ?? null
      }
      openConversationsRef.current.set(conversation.id, descriptor.key)
      setSessions((prev) => evictIfNeeded([...prev, descriptor], descriptor.key))
      setActiveSessionKey(descriptor.key)
    },
    [sessions, evictIfNeeded, syncProjectFor]
  )

  const activateSession = useCallback((key: string) => {
    setActiveSessionKey(key)
  }, [])

  const activateConversation = useCallback(
    (conversationId: string): boolean => {
      const focus = (key: string): void => {
        // Live activation skips the disk load, so derive the project binding
        // from the session's own descriptor to keep the mode in sync.
        const s = sessions.find((x) => x.key === key)
        syncProjectFor(s?.projectId ?? null)
        setActiveSessionKey(key)
      }
      const existingKey = openConversationsRef.current.get(conversationId)
      if (existingKey) {
        focus(existingKey)
        return true
      }
      // Fall back to a live-info scan (a session whose id was reported but
      // not yet mirrored into the ref, e.g. right after a fresh send).
      for (const s of sessions) {
        const info = infosRef.current.get(s.key)
        const cid = info?.conversationId ?? s.initialConversationId
        if (cid === conversationId) {
          openConversationsRef.current.set(conversationId, s.key)
          focus(s.key)
          return true
        }
      }
      return false
    },
    [sessions, syncProjectFor]
  )

  const closeConversation = useCallback(
    (conversationId: string) => {
      // The conversation is gone — its run status must not haunt the sidebar
      // as a ghost row for the rest of the app session.
      setRunStatuses((prev) => {
        if (!(conversationId in prev)) return prev
        const next = { ...prev }
        delete next[conversationId]
        return next
      })
      const target = sessions.find((s) => {
        const info = infosRef.current.get(s.key)
        return (info?.conversationId ?? s.initialConversationId) === conversationId
      })
      if (!target) return
      unregisterSessionKey(target.key)
      setSessions((prev) => {
        const remaining = prev.filter((s) => s.key !== target.key)
        if (remaining.length === 0) {
          const blank: SessionDescriptor = {
            key: nextKey(),
            initialConversationId: null,
            initialMessages: null,
            procedure: null,
            projectId: null,
            icon: null
          }
          setActiveSessionKey(blank.key)
          return [blank]
        }
        setActiveSessionKey((active) =>
          active === target.key ? remaining[remaining.length - 1].key : active
        )
        return remaining
      })
    },
    [sessions, unregisterSessionKey]
  )

  // A conversation deleted anywhere — in-app History (already handled locally)
  // OR a channel /delete (which never touches the renderer) — must drop its
  // lingering run-status so the sidebar doesn't synthesize a ghost row.
  useEffect(() => {
    return window.api.conversation.onDeleted(({ id }) => closeConversation(id))
  }, [closeConversation])

  const activeConversationId =
    infos.get(activeSessionKey)?.conversationId ??
    sessions.find((s) => s.key === activeSessionKey)?.initialConversationId ??
    null

  const value = useMemo<ChatSessionsValue>(
    () => ({
      sessions,
      activeSessionKey,
      activeConversationId,
      runStatuses,
      newSession,
      openConversation,
      activateSession,
      activateConversation,
      reportSession,
      markSending,
      consumeProcedure,
      closeConversation,
      activeProject,
      setActiveProject
    }),
    [
      sessions,
      activeSessionKey,
      activeConversationId,
      runStatuses,
      newSession,
      openConversation,
      activateSession,
      activateConversation,
      reportSession,
      markSending,
      consumeProcedure,
      closeConversation,
      activeProject,
      setActiveProject
    ]
  )

  return <ChatSessionsContext.Provider value={value}>{children}</ChatSessionsContext.Provider>
}
