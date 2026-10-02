import {
  normalizeReasoningMode,
  reasoningModesFor,
  type ReasoningMode
} from '@main/runtime/reasoning'
import { useFlow } from '@providers/flow/useFlow'
import { useMemo } from 'react'

/**
 * The chat's reasoning contract, for the Library cards.
 *
 * `modes` is the ordered set the chat's selected model honours — the exact
 * `reasoningModesFor` result the brain button renders — and `current` is the
 * mode chat is showing right now (the per-model pick clamped to `modes`).
 * A card's thinking switch shows its item's own stamp when it has one and
 * `current` when it doesn't (the "rows saved before the field existed follow
 * the chat" contract its sibling `mode` toggle already keeps), and a new item
 * is stamped with `current` at creation.
 *
 * Local-only mirrors chat exactly: no cloud model means no reasoning control
 * there either, so `modes` is empty and the switch renders nothing.
 */
export function useChatReasoning(): {
  modes: ReasoningMode[]
  current: ReasoningMode
} {
  const { status } = useFlow()
  const llm = status?.config?.llm
  return useMemo(() => {
    const localOnly = llm?.localOnly ?? false
    const brain = llm?.brain ?? null
    const providers = llm?.providers ?? []
    const model = localOnly ? (llm?.local?.model ?? null) : (brain?.model ?? null)
    const provider = localOnly ? 'local' : (brain?.providerId ?? null)
    if (localOnly || !provider || !model) return { modes: [], current: 'off' as const }
    const openrouterReasoning =
      provider === 'openrouter'
        ? (providers.find((p) => p.id === 'openrouter')?.reasoningModels?.includes(model) ?? false)
        : false
    const modes = reasoningModesFor(provider, model, { openrouterReasoning })
    return {
      modes,
      current: normalizeReasoningMode(llm?.thinkingModes?.[model], modes)
    }
  }, [llm])
}
