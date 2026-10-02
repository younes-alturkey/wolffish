import { cn } from '@lib/utils/cn'
import type { ConversationRunPhase } from '@providers/sessions/useSessions'

/**
 * Shared numbered status-chip styling for conversations — used by both the
 * right-side conversations rail and the standalone Conversations page so they
 * stay identical.
 */

/**
 * Geometry: ONE fixed circle size for every chip — a `1` and a `4444` render
 * identically. The text is small enough (tabular-nums) that up to four digits
 * fit inside the fixed 24px circle without changing its size.
 */
export const CONVERSATION_CHIP_BASE =
  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[8px] font-semibold tabular-nums'

/** The focused/hovered tint — a subtle primary fill on the number chip. */
const CHIP_PRIMARY = 'border-primary/40 bg-primary/15 text-primary'

/**
 * Color per run phase. `processing` pulses in the primary color while the turn
 * streams; a freshly finished run keeps its terminal color (success / danger /
 * warning) while the row is fresh — buildConversationRows expires the phase to
 * null past TERMINAL_FRESH_WINDOW_MS, so an old row reads neutral like any
 * conversation that hasn't run this session. The active row's chip — and, when
 * the row lives in a `group`, any chip on hover (group-hover beats the base
 * color by specificity) — takes the subtle primary tint instead of a heavy
 * background.
 */
export function conversationChipClasses(
  phase: ConversationRunPhase | null,
  isActive: boolean
): string {
  const hover = 'group-hover:border-primary/40 group-hover:bg-primary/15 group-hover:text-primary'
  if (isActive) {
    return cn(CHIP_PRIMARY, phase === 'processing' && 'animate-pulse', hover)
  }
  const base = ((): string => {
    switch (phase) {
      case 'processing':
        return `${CHIP_PRIMARY} animate-pulse`
      case 'completed':
        return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
      case 'failed':
        return 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
      case 'stopped':
        return 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
      default:
        return 'border-border text-muted'
    }
  })()
  return cn(base, hover)
}
