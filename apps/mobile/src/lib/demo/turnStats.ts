import type { ConversationStats, ConversationTurnStats } from '@/lib/conversations/types'

/**
 * Demo-mode usage accounting — the numbers behind the context meter.
 *
 * Demo turns never call a provider, so nothing reports usage; without this the
 * meter reads 0 / 0 forever and the card that is supposed to demonstrate the
 * desktop's telemetry demonstrates nothing. So the turn is priced the way a
 * real one would be: the prompt is measured, the window fills, the first turn
 * writes the cache and every later turn reads it back, and the roll-up
 * accumulates exactly like channels/turn-stats.ts folds a real turn.
 *
 * Shapes and thresholds are the desktop's, not inventions: `compactionAt` is
 * COMPACTION_THRESHOLD (0.75) of the window minus the model's output reserve —
 * the rule that produces the 1,000,000 / 725,424 pair seen throughout the
 * imported dataset.
 */

/** ~4 characters per token — the ratio the desktop's own estimator uses. */
const CHARS_PER_TOKEN = 4

/** Attachments arrive as tokenized blocks; a flat, plausible per-file cost. */
const TOKENS_PER_ATTACHMENT = 820

/**
 * Every conversation opens with the system prompt: identity, capability
 * catalog, variables, tool schemas. Measured against the imported dataset,
 * whose smallest real readings land just above this.
 */
const SYSTEM_PROMPT_TOKENS = 12_400

/** Desktop compactor.ts COMPACTION_THRESHOLD. */
const COMPACTION_THRESHOLD = 0.75

/**
 * Context window and the reserve held back for the model's own output, per
 * model. Both numbers are read off the imported conversations (their meters
 * carry the pairs the desktop wrote), so the demo's readings sit on the same
 * scale as the real ones. Unknown models get the common 128k/32k shape.
 */
const MODEL_WINDOWS: Record<string, { window: number; reserve: number }> = {
  'deepseek-v4-pro': { window: 1_000_000, reserve: 32_768 },
  'kimi-k3': { window: 1_048_576, reserve: 131_072 },
  'kimi-k2.5': { window: 262_144, reserve: 32_768 },
  'glm-5.2': { window: 1_000_000, reserve: 65_536 },
  'glm-5': { window: 200_000, reserve: 32_768 },
  'claude-opus-4-8': { window: 200_000, reserve: 32_768 },
  'claude-sonnet-5': { window: 1_000_000, reserve: 65_536 },
  'gpt-5.6': { window: 400_000, reserve: 32_768 },
  'grok-5': { window: 256_000, reserve: 32_768 },
  'qwen4-max': { window: 262_144, reserve: 32_768 },
  'qwen4:8b': { window: 131_072, reserve: 32_768 },
  'gemma4:e2b': { window: 131_072, reserve: 32_768 }
}

const DEFAULT_WINDOW = { window: 131_072, reserve: 32_768 }

/** Per-million-token prices, blended from the imported turns' cost/usage. */
const RATES = {
  input: 0.3,
  cacheRead: 0.03,
  cacheWrite: 0.375,
  output: 1.1
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / CHARS_PER_TOKEN))
}

export function contextWindowFor(model: string | null | undefined): {
  window: number
  reserve: number
} {
  return (model ? MODEL_WINDOWS[model] : undefined) ?? DEFAULT_WINDOW
}

/** The tick on the meter's bar: where auto-compaction kicks in. */
export function compactionAtFor(model: string | null | undefined): number {
  const { window, reserve } = contextWindowFor(model)
  return Math.floor((window - reserve) * COMPACTION_THRESHOLD)
}

export function priceTurn(turn: {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}): number {
  return (
    (turn.inputTokens * RATES.input +
      turn.outputTokens * RATES.output +
      turn.cacheReadTokens * RATES.cacheRead +
      turn.cacheCreationTokens * RATES.cacheWrite) /
    1_000_000
  )
}

export type DemoTurnInput = {
  promptText: string
  attachmentCount: number
  replyText: string
  provider: string
  model: string
  /** Wall time the demo turn actually took. */
  elapsedMs: number
  endedAt: number
}

/**
 * Fold one demo turn into the conversation's stats block: previous stats in,
 * new stats out. The first turn writes the window to cache; later turns read
 * it back, which is what makes the cache rows in the card carry real shape
 * (and the "% came from cache" line climb) as a demo conversation grows.
 */
export function foldDemoTurn(
  previous: ConversationStats | null | undefined,
  input: DemoTurnInput
): ConversationStats {
  const contextBefore = previous?.meter?.contextTokens ?? SYSTEM_PROMPT_TOKENS
  const firstTurn = (previous?.allTime?.turns ?? 0) === 0

  const promptTokens =
    estimateTokens(input.promptText) + input.attachmentCount * TOKENS_PER_ATTACHMENT
  const outputTokens = estimateTokens(input.replyText)

  // Fresh input is the prompt; the window behind it is either being written to
  // the cache (first turn) or read back from it (every turn after).
  const inputTokens = promptTokens
  const cacheCreationTokens = firstTurn ? contextBefore : 0
  const cacheReadTokens = firstTurn ? 0 : contextBefore

  const lastTurn: ConversationTurnStats = {
    endedAt: input.endedAt,
    elapsedMs: input.elapsedMs,
    apiMs: Math.round(input.elapsedMs * 0.82),
    apiCalls: 1,
    toolCalls: 0,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cost: priceTurn({ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }),
    provider: input.provider,
    model: input.model
  }

  const before = previous?.allTime
  const allTime = {
    turns: (before?.turns ?? 0) + 1,
    apiCalls: (before?.apiCalls ?? 0) + 1,
    toolCalls: before?.toolCalls ?? 0,
    inputTokens: (before?.inputTokens ?? 0) + inputTokens,
    outputTokens: (before?.outputTokens ?? 0) + outputTokens,
    cacheReadTokens: (before?.cacheReadTokens ?? 0) + cacheReadTokens,
    cacheCreationTokens: (before?.cacheCreationTokens ?? 0) + cacheCreationTokens,
    cost: (before?.cost ?? 0) + (lastTurn.cost ?? 0),
    processingMs: (before?.processingMs ?? 0) + input.elapsedMs,
    elapsedMs: (before?.elapsedMs ?? 0) + input.elapsedMs,
    apiMs: (before?.apiMs ?? 0) + (lastTurn.apiMs ?? 0),
    endedAt: input.endedAt,
    provider: input.provider,
    model: input.model
  }

  const { window } = contextWindowFor(input.model)
  return {
    allTime,
    lastTurn,
    meter: {
      contextTokens: Math.min(contextBefore + promptTokens + outputTokens, window),
      contextBudget: window,
      compactionAt: compactionAtFor(input.model),
      model: input.model
    }
  }
}
