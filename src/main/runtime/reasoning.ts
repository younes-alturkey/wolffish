/**
 * Reasoning capability registry.
 *
 * Sibling to `vision.ts`: a pure, dependency-free module of model
 * predicates that BOTH the main process (provider request builders) and the
 * renderer (the brain button) import. It declares, per model, the ordered
 * set of reasoning modes the provider actually honours, and translates the
 * single canonical scale into the per-provider request parameters.
 *
 * Canonical scale (ordered, the brain button cycles in this order):
 *   ['off', 'high', 'max']  effort models   (off / high effort / max effort)
 *   ['off', 'high']         coarse effort   (off / on, no distinct max)
 *   ['off', 'on']           binary toggle   (off / on, no effort levels)
 *   ['on', 'high']          always-on effort (cannot be disabled; low/high knob)
 *   ['on']                  always-on       (cannot be disabled; UI shows it locked)
 *   []                      unsupported     (no reasoning at all)
 *
 * Keep this file free of node/electron imports — it is bundled into the
 * renderer through the `@main` alias.
 */

export type ReasoningMode = 'off' | 'on' | 'high' | 'max'

/** Extra runtime signals for providers whose capability is data-driven. */
export type ReasoningContext = {
  /** OpenRouter: the routed model is in the provider's reasoningModels list. */
  openrouterReasoning?: boolean
  /** Ollama: detected `think` capability for this pulled model. */
  ollamaThink?: 'effort' | 'binary' | null
}

/**
 * The ordered reasoning modes a given provider+model honours. This is the
 * Phase-2 starting spec; entries are corrected against live API behaviour
 * during verification.
 */
export function reasoningModesFor(
  provider: string,
  model: string,
  ctx: ReasoningContext = {}
): ReasoningMode[] {
  const m = model.toLowerCase()
  switch (provider) {
    // ── Anthropic ──────────────────────────────────────────────────────
    // Extended thinking via thinking.type + budget_tokens (verified live;
    // output_config.effort is NOT a thinking control). Haiku's small output
    // ceiling caps the budget so high==max → [off, high]; every other Claude
    // (opus/sonnet/fable) gets a distinct larger max budget → [off, high, max].
    case 'anthropic':
      return m.includes('haiku') ? ['off', 'high'] : ['off', 'high', 'max']

    // ── OpenAI ─────────────────────────────────────────────────────────
    // reasoning_effort none|high|max(xhigh); none = off (verified: 0 / 61 / 84
    // reasoning_tokens on gpt-5.5). The non-reasoning *-chat-latest variants do
    // not reason. NOTE: chat/completions rejects reasoning_effort + tools (400),
    // so the provider strips effort on tool turns — effort applies to tool-less
    // turns only until/unless the Responses API is adopted.
    case 'openai':
      if (m.includes('chat-latest')) return []
      if (/^gpt-5/.test(m)) return ['off', 'high', 'max']
      if (/^(o1|o3|o4)/.test(m)) return ['off', 'high', 'max']
      return []

    // ── xAI (Grok) ─────────────────────────────────────────────────────
    // Verified live 2026-08-13 by sweeping reasoning_effort across every model
    // in the catalogue. The knob is a FIVE-rung ladder, not a low/high pair:
    // minimal|low|medium|high|xhigh. 'max' is not an xAI value at all (400
    // "Invalid reasoning effort" — the enum is genuinely validated: 'banana'
    // and 'LOW' 400 the same way), so the canonical 'max' rides xhigh.
    //   grok-4.6 / grok-4.5  ladder minus 'none' → ALWAYS-ON [on, high, max]
    //                        ('none' → 400 "does not support ... `none`")
    //   grok-4.3             full ladder incl. 'none' → [off, high, max]
    //   grok-4.20-* / grok-build  reject the parameter outright → always-on [on]
    //   -non-reasoning variants and grok-3 base → [] (never reason)
    case 'xai':
      if (m.includes('non-reasoning')) return []
      if (m.includes('grok-4.6') || m.includes('grok-4.5')) return ['on', 'high', 'max']
      if (m.includes('grok-4.3')) return ['off', 'high', 'max']
      if (m.includes('grok-3-mini')) return ['off', 'high']
      if (m.includes('grok-build') || /grok-4/.test(m)) return ['on']
      return []

    // ── Qwen ───────────────────────────────────────────────────────────
    // qwen3.x: enable_thinking + thinking_budget = effort [off,high,max]
    // (verified: false→0, budget controls depth). qwq/qvq are ALWAYS-ON
    // reasoners — enable_thinking is ignored (qwq still reasons with false) → [on].
    case 'qwen':
      if (/^(qwq|qvq)/.test(m)) return ['on']
      if (/^qwen3/.test(m)) return ['off', 'high', 'max']
      return []

    // ── DeepSeek ───────────────────────────────────────────────────────
    // Effort is REAL on the v4 line — but only as the TOP-LEVEL
    // `reasoning_effort` field (enum none|minimal|low|medium|high|xhigh|max).
    // Nested inside `thinking` it is silently dropped, because `thinking` is
    // validated on `type` alone and ignores unknown members. The provider
    // nested it until 2026-08-13, which is why an earlier sweep here recorded
    // "high vs max <0.3% apart": neither value ever reached the model.
    // Re-measured live on deepseek-v4-pro with the field top-level (zebra
    // puzzle, 64k cap, n=2): none→0 chars, high→~40k, max→~80k with both max
    // runs above every other level's best. Effort is a ceiling the model need
    // not spend, so high and max converge on easy turns and separate on hard
    // ones. thinking.type stays the master switch (disabled→0 regardless).
    case 'deepseek':
      return ['off', 'high', 'max']

    // ── Z.ai / GLM ─────────────────────────────────────────────────────
    // PER-MODEL: glm-5.2 honours effort (reasoning_effort high|max); glm-4.6
    // and glm-4.5-air are binary on/off.
    case 'zai':
      if (/glm-5/.test(m)) return ['off', 'high', 'max']
      return ['off', 'on']

    // ── Kimi / Moonshot ────────────────────────────────────────────────
    // Binary via thinking{type}; k2.x-code variants reason always-on.
    // K3 takes reasoning_effort none|high|max. 'none' genuinely disables
    // (verified live 2026-07-17 despite docs saying K3 can't be); 'high'
    // is accepted but currently indistinct from 'max' — Moonshot ships
    // only max today with "more levels coming soon", so high is exposed
    // for forward-compat (DeepSeek precedent) and starts differentiating
    // the day real lower levels land.
    case 'kimi':
      if (m.includes('k2.7') && m.includes('code')) return ['on']
      if (m.startsWith('kimi-k3')) return ['off', 'high', 'max']
      if (m.startsWith('kimi-k2')) return ['off', 'on']
      return []

    // ── MiniMax ────────────────────────────────────────────────────────
    // Binary via thinking.type; reasoning_effort IGNORED. Verified live: only
    // M3 honours thinking.type:disabled (off→0 reasoning). M2.x (M2/M2.1/M2.5/
    // M2.7 + highspeed) ALWAYS reason — disabled is ignored — so always-on [on].
    // Video models (MiniMax-H3, Hailuo) fall through to [] on purpose: no
    // chat, no thinking, no effort — the brain button renders "not supported".
    case 'minimax':
      if (/minimax-m[3-9]/i.test(model)) return ['off', 'on']
      if (/minimax-m/i.test(model)) return ['on']
      return []

    // ── MiMo / Xiaomi ──────────────────────────────────────────────────
    // Binary via enable_thinking (defaults ON). No effort/budget.
    case 'mimo':
      if (/tts|voiceclone|voicedesign|asr/.test(m)) return []
      return ['off', 'on']

    // ── Stepfun ────────────────────────────────────────────────────────
    // step-3.x always reasons — always-on, UI locked, never send a disable.
    case 'stepfun':
      return ['on']

    // ── OpenRouter ─────────────────────────────────────────────────────
    // Capability tracks the routed model (reasoningModels metadata). Effort is
    // normalised to low|medium|high upstream, so there is no distinct max here.
    case 'openrouter':
      return ctx.openrouterReasoning ? ['off', 'high'] : []

    // ── Ollama (local) ─────────────────────────────────────────────────
    // Detected per pulled model: newer reasoning models take think low|med|high
    // (effort), older take think true/false (binary), the rest none.
    case 'local':
      if (ctx.ollamaThink === 'effort') return ['off', 'high', 'max']
      if (ctx.ollamaThink === 'binary') return ['off', 'on']
      return []

    default:
      return []
  }
}

// ── Canonical-token helpers used by the provider request builders ────────
// These are tolerant of legacy persisted tokens (none/basic/extended/fast/
// budget) so an un-migrated config still produces correct requests.

const OFF_TOKENS = new Set(['off', 'none'])

/** Whether reasoning should be on. Undefined defaults to ON (prior behaviour). */
export function thinkingEnabled(mode: string | undefined): boolean {
  if (mode == null) return true
  return !OFF_TOKENS.has(mode)
}

/** Collapse any token to the coarse effort level a provider consumes. */
export function effortFromMode(mode: string | undefined): 'off' | 'high' | 'max' {
  if (mode == null) return 'high'
  if (OFF_TOKENS.has(mode)) return 'off'
  if (mode === 'max') return 'max'
  return 'high'
}

// ── Persisted-value normalisation (legacy migration + clamp) ─────────────

const LEGACY_INTENT: Record<string, ReasoningMode> = {
  none: 'off',
  off: 'off',
  basic: 'on', // old UI used 'basic' as the default "thinking on" value
  on: 'on',
  high: 'high',
  extended: 'high',
  fast: 'on',
  budget: 'on',
  max: 'max'
}

function firstOn(modes: ReasoningMode[]): ReasoningMode {
  return modes.find((x) => x !== 'off') ?? modes[0]
}

/**
 * Coerce a persisted/raw mode into a value valid for THIS model's modes.
 * Handles legacy tokens and clamps to the nearest available canonical mode.
 * The default when nothing is persisted is "thinking on" (matching prior
 * behaviour): undefined → on/high.
 */
export function normalizeReasoningMode(
  raw: string | undefined,
  modes: ReasoningMode[]
): ReasoningMode {
  if (modes.length === 0) return 'off'
  const want: ReasoningMode = (raw != null && LEGACY_INTENT[raw]) || 'on'
  if (modes.includes(want)) return want
  if (want === 'off') return firstOn(modes) // always-on model: no off
  // on ↔ high are equivalent "default thinking"; max degrades to high then on.
  if (want === 'on') return modes.includes('high') ? 'high' : firstOn(modes)
  if (want === 'high') return modes.includes('on') ? 'on' : firstOn(modes)
  // want === 'max'
  return modes.includes('high') ? 'high' : modes.includes('on') ? 'on' : firstOn(modes)
}
