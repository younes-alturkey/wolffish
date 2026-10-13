import { REASONING_MODES, type ReasoningMode } from '@/lib/tunnel/protocol'
import { useConfigValue } from '@/state/demoConfig'
import { useMemo } from 'react'

/**
 * The chat's reasoning contract, for the Library cards.
 *
 * `modes` is the ordered set the SELECTED model honours — the desktop's own
 * registry result, which rides the config snapshot (`llm.reasoningModes`), so
 * a card can only ever offer a mode that model would actually accept. `current`
 * is the mode chat is showing right now (the per-model pick clamped to `modes`).
 *
 * A card's switch shows its item's own stamp when it has one and `current` when
 * it does not — the same live-fallback contract the item's `mode` already keeps
 * — and a new item is stamped with `current` at creation.
 *
 * A desktop (or demo bundle) older than `reasoningModes` sends no list; falling
 * back to the full canonical scale there is deliberate: `thinkingMode` may
 * already hold any of the four, and hiding one the user had chosen would make
 * the card disagree with the composer.
 */
export function useChatReasoning(): {
  modes: ReasoningMode[]
  current: ReasoningMode
} {
  const rawModes = useConfigValue('reasoningModes')
  const thinkingMode = useConfigValue('thinkingMode')

  return useMemo(() => {
    const modes = (
      Array.isArray(rawModes) && rawModes.length > 0 ? rawModes : REASONING_MODES
    ).filter((mode): mode is ReasoningMode => (REASONING_MODES as readonly string[]).includes(mode))
    const wanted = thinkingMode as ReasoningMode
    const current = modes.includes(wanted)
      ? wanted
      : // Off is the safe direction to land on when the stored pick is not one
        // this model offers: it never silently spends reasoning the user did
        // not ask for.
        modes.includes('high')
        ? 'high'
        : (modes[0] ?? 'off')
    return { modes, current }
  }, [rawModes, thinkingMode])
}
