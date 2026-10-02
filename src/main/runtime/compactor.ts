import { type ChatMessage, type Thalamus, type ToolDefinition } from '@main/runtime/thalamus'
import { estimateImageTokens, selectInlineImages } from '@main/runtime/tool-images'

// ---------------------------------------------------------------------------
// Smart Context Compaction
// ---------------------------------------------------------------------------
// When the accumulated messages[] approach 75% of the active model's context
// window, this module compacts messages in-place to fit. Strategy:
//
//   1. Select targets (all message types, protect recent 3 per role + first prompt)
//   2. Strip images from all tool results
//   3. Proportional truncation in-place (instant, no LLM call)
//   4. One LLM call: summarize original content into a conversation summary
//   5. Inject summary + continuation nudge into messages[]
//
// Previous approach used N individual LLM calls (one per target) — slow
// (~6 min for 9 targets). New approach: instant truncation + 1 summary call.
// ---------------------------------------------------------------------------

// Conservative chars-to-token ratio. Different providers and content types
// tokenize at wildly different densities:
//   - English prose: ~4 chars/token
//   - JSON/HTML:     ~1.5-2.5 chars/token
//   - DeepSeek JSON: ~1.2-1.8 chars/token
// We use 1.5 because the cost of underestimation (context overflow → hard 400
// that crashes the turn) vastly exceeds overestimation (an extra compaction
// pass that preserves the conversation). Previous value of 2 was too optimistic
// for non-English-optimized tokenizers on structured content.
const CHARS_PER_TOKEN = 1.5

/**
 * Trigger compaction when payload exceeds this fraction of the input budget.
 * Exported so the context meter can draw the real trigger point instead of
 * inventing its own thresholds — one denominator story everywhere.
 */
export const COMPACTION_THRESHOLD = 0.75
/** Compact down to this fraction — leaves headroom for the model to keep working. */
const COMPACTION_TARGET = 0.5
/** Number of most-recent messages per role to protect from compaction. */
const PROTECT_RECENT = 3
/** Minimum content size worth compacting (chars). */
const MIN_COMPACTION_SIZE = 500
/** Truncation keeps this fraction of the original as a head excerpt. */
const HEAD_RATIO = 0.15
/** Max chars for the head excerpt. */
const HEAD_CAP = 6000
/** Truncation keeps this fraction of the original as a tail excerpt. */
const TAIL_RATIO = 0.08
/** Max chars for the tail excerpt. */
const TAIL_CAP = 3000
/** Effective retention ratio for savings projection (~23% of original). */
const COMPACTION_RATIO = 0.25

/** Metadata about a single compacted message. */
export type CompactionTarget = {
  /** Index in the messages array. */
  index: number
  /** Original char length of the content. */
  originalChars: number
  /** Estimated tokens of the original content. */
  originalTokens: number
  /** The tool name (for tool results), or role label. */
  toolName?: string
}

/** Result of a compaction pass. */
export type CompactionResult = {
  /** Per-target metadata for the compaction card. */
  targets: Array<
    CompactionTarget & {
      /** Chars after compaction. */
      compactedChars: number
      /** Which method performed the compaction. */
      compactedBy: string
    }
  >
  /** Total tokens saved. */
  tokensSaved: number
  /** One-shot conversation summary, or null if the LLM call failed. */
  summary: { text: string; model: string } | null
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Estimate tokens for the tool definitions sent via the API `tools` parameter.
 * These JSON schemas count as input tokens but are separate from the system
 * prompt and messages. Ignoring them creates a blind spot that can cause
 * context overflow on tool-heavy workspaces (150+ tools = 50-100k tokens).
 */
export function estimateToolTokens(tools?: ToolDefinition[]): number {
  if (!tools || tools.length === 0) return 0
  let chars = 0
  for (const t of tools) {
    chars += t.name.length + t.description.length + JSON.stringify(t.parameters).length
    chars += 40
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

export function estimatePayloadTokens(
  systemPrompt: string,
  messages: ChatMessage[],
  tools?: ToolDefinition[]
): number {
  let chars = systemPrompt.length
  for (const m of messages) {
    switch (m.role) {
      case 'system':
        chars += m.content.length
        break
      case 'user':
        if (typeof m.content === 'string') {
          chars += m.content.length
        } else {
          for (const block of m.content) {
            if (block.type === 'text') chars += block.text.length
            else if (block.type === 'image' || block.type === 'document')
              chars += block.data.length * 0.75
          }
        }
        break
      case 'assistant':
        chars += m.content.length
        if (m.reasoningContent) chars += m.reasoningContent.length
        if (m.toolUses) {
          for (const tu of m.toolUses) {
            chars += tu.name.length + JSON.stringify(tu.args).length
          }
        }
        break
      case 'tool':
        chars += m.content.length
        if (m.images) {
          // chars, not tokens — the whole accumulator is divided by 4 below.
          for (const img of selectInlineImages(m.images, m.toolName).inline)
            chars += estimateImageTokens(img) * 4
        }
        break
    }
    chars += 30
  }
  const contentTokens = Math.ceil(chars / CHARS_PER_TOKEN)
  const toolTokens = estimateToolTokens(tools)
  return contentTokens + toolTokens
}

/** Get the text content length of a message (for candidate sizing). */
function messageContentLength(m: ChatMessage): number {
  switch (m.role) {
    case 'user':
      if (typeof m.content === 'string') return m.content.length
      return m.content.reduce((sum, b) => sum + (b.type === 'text' ? b.text.length : 0), 0)
    case 'assistant':
      return m.content.length + (m.reasoningContent?.length ?? 0)
    case 'tool':
      return m.content.length
    default:
      return 0
  }
}

// ---------------------------------------------------------------------------
// Target selection
// ---------------------------------------------------------------------------

/**
 * Select messages for compaction in priority order:
 *   1. Tool results (largest first, skip errors + last 3)
 *   2. Older assistant messages (oldest first, skip last 3)
 *   3. Older user messages (oldest first, skip first + last 3)
 *
 * Picks greedily until projected savings cover the excess between
 * `currentTokens` and `targetTokens`.
 */
export function selectCompactionTargets(
  messages: ChatMessage[],
  currentTokens: number,
  targetTokens: number
): CompactionTarget[] {
  const excess = currentTokens - targetTokens
  if (excess <= 0) return []

  // --- Collect protected indices ---
  const protectedIndices = new Set<number>()

  // Always protect messages[0] (the original task prompt)
  if (messages.length > 0) protectedIndices.add(0)

  // Protect last N per role
  let toolCount = 0
  let assistantCount = 0
  let userCount = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i].role
    if (role === 'tool' && toolCount < PROTECT_RECENT) {
      protectedIndices.add(i)
      toolCount++
    } else if (role === 'assistant' && assistantCount < PROTECT_RECENT) {
      protectedIndices.add(i)
      assistantCount++
    } else if (role === 'user' && userCount < PROTECT_RECENT) {
      protectedIndices.add(i)
      userCount++
    }
  }

  // --- Pass 1: tool results (largest first) ---
  const toolCandidates: CompactionTarget[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== 'tool') continue
    if (m.isError) continue
    if (protectedIndices.has(i)) continue
    if (m.content.length <= MIN_COMPACTION_SIZE) continue
    toolCandidates.push({
      index: i,
      originalChars: m.content.length,
      originalTokens: Math.ceil(m.content.length / CHARS_PER_TOKEN),
      toolName: m.toolName
    })
  }
  toolCandidates.sort((a, b) => b.originalTokens - a.originalTokens)

  const selected: CompactionTarget[] = []
  let projectedSavings = 0

  for (const c of toolCandidates) {
    if (projectedSavings >= excess) break
    selected.push(c)
    projectedSavings += Math.floor(c.originalTokens * (1 - COMPACTION_RATIO))
  }

  if (projectedSavings >= excess) return selected

  // --- Pass 2: older assistant messages (oldest first) ---
  for (let i = 0; i < messages.length; i++) {
    if (projectedSavings >= excess) break
    const m = messages[i]
    if (m.role !== 'assistant') continue
    if (protectedIndices.has(i)) continue
    const len = messageContentLength(m)
    if (len <= MIN_COMPACTION_SIZE) continue
    const tokens = Math.ceil(len / CHARS_PER_TOKEN)
    selected.push({
      index: i,
      originalChars: len,
      originalTokens: tokens,
      toolName: 'assistant'
    })
    projectedSavings += Math.floor(tokens * (1 - COMPACTION_RATIO))
  }

  if (projectedSavings >= excess) return selected

  // --- Pass 3: older user messages (oldest first, skip index 0) ---
  for (let i = 0; i < messages.length; i++) {
    if (projectedSavings >= excess) break
    const m = messages[i]
    if (m.role !== 'user') continue
    if (protectedIndices.has(i)) continue
    const len = messageContentLength(m)
    if (len <= MIN_COMPACTION_SIZE) continue
    const tokens = Math.ceil(len / CHARS_PER_TOKEN)
    selected.push({
      index: i,
      originalChars: len,
      originalTokens: tokens,
      toolName: 'user'
    })
    projectedSavings += Math.floor(tokens * (1 - COMPACTION_RATIO))
  }

  return selected
}

// ---------------------------------------------------------------------------
// Proportional truncation
// ---------------------------------------------------------------------------

/**
 * Truncate content proportionally — keeps a generous head and tail with a
 * clear label showing what was removed. The head shows the beginning of the
 * content (usually the most informative), the tail shows the end (recent
 * state), and the label gives the original size so the model knows content
 * was lost.
 */
function proportionalTruncate(content: string): string {
  const headChars = Math.min(Math.floor(content.length * HEAD_RATIO), HEAD_CAP)
  const tailChars = Math.min(Math.floor(content.length * TAIL_RATIO), TAIL_CAP)

  if (content.length <= headChars + tailChars + 200) return content

  const head = content.slice(0, headChars)
  const tail = content.slice(-tailChars)
  const omitted = content.length - headChars - tailChars
  return (
    head +
    `\n\n[TRUNCATED — ${content.length.toLocaleString()} chars original, ` +
    `${omitted.toLocaleString()} chars omitted, ` +
    `showing first ${headChars.toLocaleString()} + last ${tailChars.toLocaleString()} chars]\n\n` +
    tail
  )
}

/** Fixed head+tail fallback for edge cases. */
export function truncateFallback(content: string): string {
  const headChars = 2000
  const tailChars = 800

  if (content.length <= headChars + tailChars + 100) return content

  const head = content.slice(0, headChars)
  const tail = content.slice(-tailChars)
  const omitted = content.length - headChars - tailChars
  return (
    head + `\n\n[…${omitted} chars compacted — summary unavailable, showing head+tail]\n\n` + tail
  )
}

// ---------------------------------------------------------------------------
// Summary prompt builder
// ---------------------------------------------------------------------------

function buildSummaryPrompt(
  targets: CompactionTarget[],
  originals: Map<number, string>,
  messages: ChatMessage[]
): string {
  let totalOriginalChars = 0
  for (const o of originals.values()) totalOriginalChars += o.length

  let prompt =
    `TASK: Produce a structured conversation summary after context compaction.\n\n` +
    `CONTEXT: A conversation between a user and an AI assistant has been truncated ` +
    `to fit within the model's context window. The truncated messages retain their ` +
    `first and last portions. This summary captures information lost during truncation.\n\n` +
    `INSTRUCTIONS:\n` +
    `1. Read ALL sections of original content below\n` +
    `2. Produce a summary with these EXACT headers:\n` +
    `   TASK: What the user originally asked for (one sentence)\n` +
    `   PROGRESS: Numbered list of completed steps with key results. For batch/iterative work: ALWAYS start with the overall total (e.g., "15/53 processed total"), then break down per group with status labels (e.g., "account-a@x.com: 8/8 COMPLETE; account-b@x.com: 7/45 IN PROGRESS"). List every completed item's ID per group.\n` +
    `   REMAINING: Numbered list of what still needs to be done. For batch work: state total remaining (e.g., "38/53 remaining"), then list every unprocessed item ID per group.\n` +
    `   DATA: Key values extracted from content — names, emails, dates, IDs, numbers, URLs, errors.\n` +
    `   DECISIONS: Any decisions or confirmations made during the conversation\n` +
    `   CONTINUATION: Quote or paraphrase the assistant's last stated plan — what it said it would do next, in its own words. If the assistant announced a next batch, listed upcoming items, or described its next action, capture that verbatim. This is what the model will read to pick up exactly where it left off.\n\n` +
    `RULES:\n` +
    `- Include EVERY name, email, date, ID, URL, number, error code from the original\n` +
    `- For lists of items (emails, files, records), enumerate EACH one with key fields\n` +
    `- For batch/iterative tasks, split items into PROCESSED (with IDs) and UNPROCESSED (with IDs) in PROGRESS/REMAINING — the model needs to know exactly where to resume\n` +
    `- Do NOT fabricate data not present in the original content\n` +
    `- Do NOT use markdown formatting\n` +
    `- Keep it dense and factual\n\n` +
    `--- ORIGINAL CONTENT (${targets.length} sections, ${totalOriginalChars.toLocaleString()} chars total) ---\n\n`

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]
    const m = messages[t.index]
    const original = originals.get(t.index) ?? ''
    const roleLabel =
      m.role === 'tool'
        ? `tool result from ${(m as { toolName?: string }).toolName ?? 'unknown'}`
        : m.role
    prompt +=
      `=== Section ${i + 1}: ${roleLabel} (${t.originalChars.toLocaleString()} chars) ===\n` +
      original +
      '\n\n'
  }

  return prompt
}

// ---------------------------------------------------------------------------
// Continuation nudge builder
// ---------------------------------------------------------------------------

function buildContinuationNudge(summary: { text: string; model: string } | null): string {
  if (summary) {
    return (
      `[Compaction Summary]\n\n` +
      `${summary.text}\n\n` +
      `[Post-compaction instructions]\n` +
      `Context was compacted. The summary above is your source of truth for everything ` +
      `that happened before this point. To continue:\n` +
      `- Read the CONTINUATION section — it contains what you said you would do next. Do that.\n` +
      `- The DATA section has every account, ID, URL, and value you already fetched. Use it directly — do NOT re-call tools to rediscover information that is already in the summary.\n` +
      `- The PROGRESS section lists completed work. Do NOT repeat any of it.\n` +
      `- The REMAINING section lists pending work. Pick up from there.\n` +
      `- Do NOT produce final output until ALL steps of the current task are complete.`
    )
  }

  return (
    `[Compaction Notice: Context was compacted by truncating older messages ` +
    `(showing first and last portions of each). A conversation summary could not ` +
    `be generated. Review the truncated content carefully to reconstruct what has ` +
    `been completed and what remains. If you were in the middle of a multi-step ` +
    `task, continue where you left off. Do NOT produce final output until ALL ` +
    `steps of the current task are complete.]`
  )
}

// ---------------------------------------------------------------------------
// Main compaction orchestrator
// ---------------------------------------------------------------------------

/**
 * If the system prompt + messages exceed 75% of the model's input budget,
 * compact messages **in-place** using proportional truncation + one-shot
 * LLM summary.
 *
 * Flow:
 *   1. Strip images from all tool results
 *   2. Select targets across all message types
 *   3. Save original content for summary generation
 *   4. Truncate all targets in-place (instant)
 *   5. One LLM call to summarize originals (5 retries with backoff)
 *   6. Inject summary + continuation nudge as a user message
 *
 * Returns null when no compaction is needed (payload fits within 75%).
 */
/**
 * Effective payload size for the compaction trigger. Provider-billed
 * tokens from the previous call (uncached + cache reads) are ground truth
 * and replace the char heuristic entirely once available — the 1.5
 * chars/token worst-case ratio overestimates real usage ~2.5x on mixed
 * content and used to fire compaction at 39% of the actual window (a 45s
 * stall observed in the 2026-06-11 run). The char estimate still rules
 * the first call of a turn, and a 25%-of-estimate floor catches the rare
 * case where a single iteration appends far more than the last call saw.
 * A genuine overflow that outruns both is caught by the hard-400 force
 * path, which is the designed escape hatch.
 */
export function effectivePayloadTokens(charEstimate: number, lastKnownInputTokens: number): number {
  if (lastKnownInputTokens <= 0) return charEstimate
  return Math.max(lastKnownInputTokens, Math.ceil(charEstimate * 0.25))
}

export async function compactOverflow(
  thalamus: Thalamus,
  systemPrompt: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
  options?: {
    tools?: ToolDefinition[]
    lastKnownInputTokens?: number
    force?: boolean
    /**
     * Budget of the model actually serving this turn — a workflow subagent
     * on a per-agent model must compact against ITS window, not the Brain's.
     * Omitted ⇒ the active (Brain/local) budget.
     */
    inputBudget?: number
    onStarted?: (targetsCount: number, currentTokens: number, inputBudget: number) => void
  }
): Promise<CompactionResult | null> {
  const inputBudget = options?.inputBudget ?? thalamus.getContextBudget()

  const charEstimate = estimatePayloadTokens(systemPrompt, messages, options?.tools)

  const lastKnown = options?.lastKnownInputTokens ?? 0
  const currentTokens = effectivePayloadTokens(charEstimate, lastKnown)

  const threshold = Math.floor(inputBudget * COMPACTION_THRESHOLD)
  const needsCompaction = options?.force || currentTokens > threshold
  console.log(
    `[compactor] charEstimate=${charEstimate} lastKnown=${lastKnown} ` +
      `effective=${currentTokens} budget=${inputBudget} ` +
      `threshold=${threshold} (${(COMPACTION_THRESHOLD * 100).toFixed(0)}%) ` +
      `messages=${messages.length} sysChars=${systemPrompt.length} ` +
      `tools=${options?.tools?.length ?? 0} force=${!!options?.force} ` +
      `needsCompaction=${needsCompaction}`
  )
  if (!needsCompaction) return null

  // Target: compact to COMPACTION_TARGET of budget
  const targetTokens = Math.floor(inputBudget * COMPACTION_TARGET)
  const targets = selectCompactionTargets(messages, currentTokens, targetTokens)
  if (targets.length === 0) return null

  options?.onStarted?.(targets.length, currentTokens, inputBudget)

  const tokensBefore = currentTokens

  // Step 1: Strip images from ALL tool results (before anything else)
  for (const m of messages) {
    if (m.role === 'tool' && m.images && m.images.length > 0) {
      ;(m as { images: undefined }).images = undefined
      if (!m.content.startsWith('[Screenshot')) {
        m.content = `[Screenshot analyzed — image omitted from context]\n${m.content}`
      }
    }
  }

  // Step 2: Save original content before truncation
  const originals = new Map<number, string>()
  for (const t of targets) {
    const m = messages[t.index]
    if (m.role === 'tool') {
      originals.set(t.index, m.content)
    } else if (m.role === 'assistant') {
      originals.set(t.index, m.content)
    } else if (m.role === 'user') {
      originals.set(t.index, typeof m.content === 'string' ? m.content : '')
    }
  }

  // Step 3: Truncate all targets in-place (instant, no LLM call)
  const results: Array<CompactionTarget & { compactedChars: number; compactedBy: string }> = []
  for (const target of targets) {
    const m = messages[target.index]
    const original = originals.get(target.index) ?? ''
    const truncated = proportionalTruncate(original)

    if (m.role === 'tool') {
      messages[target.index] = { ...m, content: truncated } as ChatMessage
    } else if (m.role === 'assistant') {
      messages[target.index] = {
        ...m,
        content: truncated,
        reasoningContent: undefined
      } as ChatMessage
    } else if (m.role === 'user') {
      messages[target.index] = { ...m, content: truncated } as ChatMessage
    }

    results.push({
      ...target,
      compactedChars: truncated.length,
      compactedBy: 'truncate'
    })
  }

  // Step 4: One LLM call for conversation summary
  let summary: { text: string; model: string } | null = null
  try {
    const summaryPrompt = buildSummaryPrompt(targets, originals, messages)
    const result = await thalamus.summarize(summaryPrompt, signal)
    summary = { text: result.text, model: result.model }
  } catch (err) {
    console.log(`[compactor] Summary failed, continuing with truncation only: ${err}`)
    summary = null
  }

  // Step 5: Inject summary + continuation nudge
  messages.push({
    role: 'user',
    content: buildContinuationNudge(summary)
  })

  const tokensAfter = estimatePayloadTokens(systemPrompt, messages, options?.tools)
  const tokensSaved = Math.max(0, tokensBefore - tokensAfter)

  return { targets: results, tokensSaved, summary }
}
