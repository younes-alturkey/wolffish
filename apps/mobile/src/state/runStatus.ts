import {
  TERMINAL_FRESH_WINDOW_MS,
  type ConversationRun,
  type TerminalRunPhase
} from '@/lib/conversations/rows'
import { create } from 'zustand'

/**
 * How the last turn in each conversation ENDED — success, error, stopped —
 * for as long as that is still news.
 *
 * The desktop keeps the whole lifecycle here (its `runStatuses`); the phone
 * keeps only the terminal half, because "is a turn running right now" is
 * already answered, more reliably, by chatRuntime's live streams — see
 * lib/conversations/rows.ts for why that split matters.
 *
 * In memory only. A tint that survived a relaunch would be reporting on a run
 * the user has no memory of, and there is nothing to restore it FROM: the
 * desktop announces transitions, not history.
 */

export type RunStatusState = {
  runs: Record<string, ConversationRun>
  /** Record how a turn ended. `at` is injectable so tests need no clock. */
  markRun: (conversationId: string, phase: TerminalRunPhase, at?: number) => void
  /** Forget one conversation — it was deleted, or its history was replaced. */
  dropRun: (conversationId: string) => void
  reset: () => void
}

export const useRunStatus = create<RunStatusState>()((set) => ({
  runs: {},
  markRun: (conversationId, phase, at = Date.now()) =>
    set((state) => {
      // Entries past the tint window can never render again, so the write that
      // adds one also takes the dead ones out — the map stays the size of "what
      // ran recently" rather than growing with every conversation touched in a
      // long session.
      const runs: Record<string, ConversationRun> = {}
      for (const [id, run] of Object.entries(state.runs)) {
        if (at - run.at <= TERMINAL_FRESH_WINDOW_MS) runs[id] = run
      }
      runs[conversationId] = { phase, at }
      return { runs }
    }),
  dropRun: (conversationId) =>
    set((state) => {
      if (!state.runs[conversationId]) return state
      const { [conversationId]: _gone, ...runs } = state.runs
      return { runs }
    }),
  reset: () => set({ runs: {} })
}))

/** Record a terminal phase outside React (tunnel handlers, the demo agent). */
export function markRun(conversationId: string, phase: TerminalRunPhase): void {
  useRunStatus.getState().markRun(conversationId, phase)
}
