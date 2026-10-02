/**
 * RAS is the attention filter that decides what makes it into context.
 *
 * Maps to: the reticular activating system — a network in the brainstem
 * that controls arousal and gates which sensory signals reach the cortex.
 * Without it, every breath, every distant car horn, every stray itch would
 * compete for attention. The RAS scores incoming signals against the
 * organism's current goal and lets only the relevant ones through.
 *
 * In Wolffish, RAS scores candidate context fragments (memory excerpts,
 * skill descriptions, knowledge files) against the current message and
 * allocates the available token budget across categories. If the budget is
 * tight, low-scoring fragments are dropped before they reach the LLM.
 */

export type ContextCategory = 'identity' | 'prefrontal' | 'memory' | 'skills' | 'history'

export type ContextCandidate = {
  category: ContextCategory
  source: string
  content: string
}

export type ScoredCandidate = ContextCandidate & {
  score: number
  tokens: number
}

export type BudgetAllocation = Record<ContextCategory, number>

export type RASOptions = {
  totalBudgetTokens?: number
}

export const DEFAULT_BUDGET_TOKENS = 8000

// Memory candidates must clear this score floor or they get dropped before
// hitting the budget. Without it, common-word matches ("tell", "me") cause
// FTS5 hits to leak into context for queries unrelated to the workspace.
export const MEMORY_RELEVANCE_THRESHOLD = 0.25

// Upper bound on the token budget handed to context assembly, independent of
// how large the model's context window is. Modern models advertise windows of
// 200k–1M tokens; spending all of that on a system prompt that is rebuilt on
// every tool-loop iteration is what choked the runtime (a 114k-token prompt
// re-sent dozens of times per task). The discretionary pool (memory, history,
// skills) is capped here; mandatory identity/prefrontal/tools are never
// trimmed, and the live conversation gets the rest of the window.
export const MAX_ASSEMBLY_BUDGET_TOKENS = 48_000

// No single scored candidate may occupy more than this. A genuinely huge file
// is head+tail trimmed with a marker pointing at wolffish_recall, rather than
// either swallowing the whole budget or being dropped wholesale. Generous on
// purpose — real memory/knowledge files sit well under it, so quality is not
// degraded; it only bites pathological blobs.
export const PER_CANDIDATE_MAX_TOKENS = 6_000

// Below this, a leftover budget slice is too small to carry useful signal —
// skip rather than inject a meaningless fragment.
const MIN_CANDIDATE_TOKENS = 256

// Cap on keywords used for relevance scoring. A huge pasted message must not
// turn keyword-overlap scoring into an unbounded per-candidate scan; the most
// discriminating ~48 terms are plenty for an overlap heuristic.
const SCORING_MAX_KEYWORDS = 48

/**
 * Clamp the model-derived context budget down to the assembly ceiling. Keeps
 * the system prompt lean and stable regardless of the active model's window.
 */
export function clampAssemblyBudget(modelBudget: number): number {
  if (!Number.isFinite(modelBudget) || modelBudget <= 0) return MAX_ASSEMBLY_BUDGET_TOKENS
  return Math.min(modelBudget, MAX_ASSEMBLY_BUDGET_TOKENS)
}

const BUDGET_RATIOS: BudgetAllocation = {
  identity: 0.15,
  prefrontal: 0.1,
  memory: 0.3,
  skills: 0.2,
  history: 0.25
}

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'can',
  'may',
  'might',
  'this',
  'that',
  'it',
  'i',
  'you',
  'we',
  'they',
  'my',
  'your',
  'our',
  'and',
  'or',
  'but',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'from'
])

export class RAS {
  private totalBudget: number

  constructor(options: RASOptions = {}) {
    this.totalBudget = options.totalBudgetTokens ?? DEFAULT_BUDGET_TOKENS
  }

  /**
   * Score a piece of content against a message on [0, 1] using keyword
   * overlap. Stop words are excluded so common glue doesn't dominate the
   * signal.
   */
  scoreRelevance(message: string, content: string): number {
    return scoreAgainstKeywords(tokenize(message).slice(0, SCORING_MAX_KEYWORDS), content)
  }

  /**
   * Rough byte-to-token estimate: 1 token ~ 4 characters. Good enough for
   * budget arithmetic — exact counts aren't worth a tokenizer dependency.
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
  }

  /**
   * Split a total token budget across categories using the default
   * 15/10/30/20/25 split. Hypothalamus may adjust the ratios later (M6).
   */
  allocateBudget(totalTokens: number = this.totalBudget): BudgetAllocation {
    return {
      identity: Math.floor(totalTokens * BUDGET_RATIOS.identity),
      prefrontal: Math.floor(totalTokens * BUDGET_RATIOS.prefrontal),
      memory: Math.floor(totalTokens * BUDGET_RATIOS.memory),
      skills: Math.floor(totalTokens * BUDGET_RATIOS.skills),
      history: Math.floor(totalTokens * BUDGET_RATIOS.history)
    }
  }

  /**
   * Score every candidate, sort by relevance, and trim until the per-
   * category budget is exhausted. Identity and prefrontal candidates
   * bypass scoring — they're always included.
   */
  filterContext(
    message: string,
    candidates: ContextCandidate[],
    budget: BudgetAllocation = this.allocateBudget()
  ): ScoredCandidate[] {
    // Tokenize the message ONCE (capped), then reuse the keyword set across
    // every candidate. Previously scoreRelevance re-tokenized the full message
    // per candidate, so cost scaled with (message length × candidate count) —
    // the same synchronous-main-thread-work-scales-with-input smell as the
    // cortex freeze, just smaller. Capping + hoisting keeps the scan flat.
    const keywords = tokenize(message).slice(0, SCORING_MAX_KEYWORDS)
    const scored: ScoredCandidate[] = candidates.map((c) => ({
      ...c,
      score:
        c.category === 'identity' || c.category === 'prefrontal'
          ? 1
          : scoreAgainstKeywords(keywords, c.content),
      tokens: this.estimateTokens(c.content)
    }))

    const byCategory = new Map<ContextCategory, ScoredCandidate[]>()
    for (const item of scored) {
      const list = byCategory.get(item.category) ?? []
      list.push(item)
      byCategory.set(item.category, list)
    }

    const out: ScoredCandidate[] = []
    for (const [category, items] of byCategory) {
      const cap = budget[category] ?? 0
      // identity + prefrontal are mandatory; if the cap is too small,
      // include them anyway — pruning them defeats the point.
      const mandatory = category === 'identity' || category === 'prefrontal'
      items.sort((a, b) => b.score - a.score)

      let used = 0
      for (const item of items) {
        if (mandatory) {
          out.push(item)
          used += item.tokens
          continue
        }
        if (category === 'memory' && item.score < MEMORY_RELEVANCE_THRESHOLD) continue
        if (item.score <= 0) continue

        // How much room is left in this category, capped per-candidate so one
        // relevant-but-huge file can't crowd out everything behind it.
        const room = Math.min(cap - used, PER_CANDIDATE_MAX_TOKENS)
        if (room < MIN_CANDIDATE_TOKENS) continue

        if (item.tokens <= room) {
          out.push(item)
          used += item.tokens
          continue
        }

        // Oversized: keep the highest-signal head+tail, mark the cut, and
        // point the model at recall for the rest. Beats dropping it entirely.
        const content = truncateToTokens(item.content, room)
        const tokens = this.estimateTokens(content)
        out.push({ ...item, content, tokens })
        used += tokens
      }
    }

    return out
  }
}

/**
 * Trim content to roughly `maxTokens` by keeping a head and a smaller tail,
 * separated by a marker that tells the model content was elided and how to
 * retrieve it. ~4 chars/token, mirroring estimateTokens.
 */
function truncateToTokens(content: string, maxTokens: number): string {
  const maxChars = Math.max(maxTokens * 4, 400)
  if (content.length <= maxChars) return content
  const marker = '\n\n[… trimmed to fit context — use wolffish_recall for the full content …]\n\n'
  const room = maxChars - marker.length
  const headChars = Math.floor(room * 0.7)
  const tailChars = room - headChars
  return content.slice(0, headChars) + marker + content.slice(content.length - tailChars)
}

// Keyword-overlap score: fraction of the (pre-tokenized, capped) keyword set
// that appears in the content. Shared by scoreRelevance and filterContext so
// the keyword set can be computed once and reused across candidates.
function scoreAgainstKeywords(keywords: string[], content: string): number {
  if (keywords.length === 0) return 0
  const haystack = content.toLowerCase()
  let hits = 0
  for (const kw of keywords) {
    if (haystack.includes(kw)) hits++
  }
  return hits / keywords.length
}

function tokenize(message: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const tokens = message
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
  for (const t of tokens) {
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}
