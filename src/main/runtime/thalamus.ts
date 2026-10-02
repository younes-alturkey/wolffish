import type { Corpus } from '@main/runtime/corpus'
import { shapeOutbound } from '@main/runtime/outbound'
import { AnthropicProvider } from '@main/runtime/providers/anthropic'
import { DeepSeekProvider } from '@main/runtime/providers/deepseek'
import { KimiProvider } from '@main/runtime/providers/kimi'
import { LocalProvider } from '@main/runtime/providers/local'
import { MimoProvider } from '@main/runtime/providers/mimo'
import { MiniMaxProvider } from '@main/runtime/providers/minimax'
import { OpenAIProvider } from '@main/runtime/providers/openai'
import { OpenRouterProvider } from '@main/runtime/providers/openrouter'
import { QwenProvider } from '@main/runtime/providers/qwen'
import { StepfunProvider } from '@main/runtime/providers/stepfun'
// Safe runtime import: usage.ts only imports the ProviderId TYPE from here.
import { calculateCost } from '@main/runtime/usage'
import { XAIProvider } from '@main/runtime/providers/xai'
import { ZaiProvider } from '@main/runtime/providers/zai'
import {
  cloudModelSupportsVision,
  hasVisualContent,
  isModalityReject,
  limitToolResultImages,
  REQUEST_MODALITY_STRIP_REASON,
  stripVisualContent,
  TOOL_RESULT_MODALITY_STRIP_REASON,
  type VisualStripScope
} from '@main/runtime/vision'
import { estimateImageTokens, selectInlineImages } from '@main/runtime/tool-images'
import { normalizeReasoningMode, reasoningModesFor } from '@main/runtime/reasoning'
import { net } from 'electron'

export type ToolUse = {
  id: string
  name: string
  args: Record<string, unknown>
}

export type UserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string }
  | { type: 'document'; mediaType: 'application/pdf'; data: string }

export type ToolResultImage = {
  mediaType: string
  data: string
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | {
      role: 'user'
      content: string | UserContentBlock[]
      /**
       * Marks a synthetic outbound-only message (the per-iteration runtime
       * status tail). Never present on internal history — it is appended to
       * the structural clone right before provider dispatch. Providers must
       * never place a cache breakpoint on a volatile message: its content
       * changes every call, so a breakpoint there would never match again.
       */
      volatile?: boolean
    }
  | { role: 'assistant'; content: string; toolUses?: ToolUse[]; reasoningContent?: string }
  | {
      role: 'tool'
      toolUseId: string
      toolName: string
      content: string
      isError?: boolean
      images?: ToolResultImage[]
    }

export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'openrouter'
  | 'deepseek'
  | 'mimo'
  | 'kimi'
  | 'minimax'
  | 'xai'
  | 'qwen'
  | 'stepfun'
  | 'zai'
  | 'local'

export type ToolDefinition = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

// Canonical reasoning scale lives in reasoning.ts. ThinkingMode is kept as an
// alias so the many existing references continue to resolve.
export type { ReasoningMode } from '@main/runtime/reasoning'
export type ThinkingMode = import('@main/runtime/reasoning').ReasoningMode

export type ProviderStreamOptions = {
  system: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  signal?: AbortSignal
  thinkingMode?: ThinkingMode
  /**
   * Per-iteration loop-position report (live tool counters). Appended to
   * the outbound structural clone as a final volatile user message so
   * everything before it stays a byte-stable, cacheable prefix. The
   * internal messages array is never touched.
   */
  volatileStatus?: string
  /**
   * Enables deterministic outbound truncation in the structural clone:
   * superseded page-state reads, byte-equal duplicate results, and stale
   * screenshots collapse to self-describing stubs. Internal history is
   * never touched. See outbound.ts for the exact (conservative) rules.
   */
  truncateOutbound?: boolean
  /**
   * Stable per-conversation key passed to providers that support cache
   * routing hints (OpenAI `prompt_cache_key`). Keeps all calls of a task
   * on the same cache shard — without it, sustained tool loops above
   * ~15 req/min on one prefix overflow to cold machines.
   */
  cacheKey?: string
  /**
   * Turn role for this call. 'agent' marks a workflow subagent (its effort is
   * clamped to the resolved model's reasoning support and it gets NO retry
   * budget — the master owns retries); 'summary' resolves like the Brain but
   * stamps the emitted llm.response with role:'summary' so summarization
   * side-calls are itemized as overhead. Per-call, so it's concurrency-safe.
   */
  role?: 'master' | 'agent' | 'summary'
  /**
   * Explicit provider+model for this call — the master's per-agent choice in
   * workflow mode. Resolved against the connected cloud providers; when the
   * provider isn't connected the call fails with a deterministic error (no
   * silent fallback — the failure is the master's signal to pick again).
   * Omitted ⇒ the Brain / local resolution.
   */
  modelOverride?: { provider: ProviderId; model: string }
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'unknown'

export type StreamUsage = {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
}

export type NoProviderAvailableInfo = {
  provider: string
  providerLogo: string
  statusCode: number | null
  errorReason: string
  errorDetail: string | null
  retriesAttempted: number
  totalDurationMs: number
}

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  // provider/model are stamped by thalamus on relay so the agent can record
  // which model actually served the call (for usage capture and labelling).
  | {
      type: 'turn_meta'
      stopReason: StopReason
      usage?: StreamUsage
      provider?: ProviderId
      model?: string
    }
  | { type: 'error'; message: string; recoverable: boolean; failures?: NoProviderAvailableInfo[] }
  | { type: 'active_model'; provider: ProviderId; model: string }
  | { type: 'no_provider_available'; failures: NoProviderAvailableInfo[] }

export type CloudProviderConfig = {
  id:
    | 'anthropic'
    | 'openai'
    | 'openrouter'
    | 'deepseek'
    | 'mimo'
    | 'kimi'
    | 'minimax'
    | 'xai'
    | 'qwen'
    | 'stepfun'
    | 'zai'
  model: string
  apiKey: string
  models?: string[]
  reasoningModels?: string[]
  // Anthropic cache breakpoint TTL. '1h' costs 2x base on cache writes but
  // survives tasks whose individual steps outlast the 5-minute default
  // (slow browser automation, long shell commands). Anthropic-only.
  cacheTtl?: '5m' | '1h'
}

/**
 * The single user-chosen cloud model — the Brain. Sole source of truth for
 * which cloud provider+model runs when not in local-only mode.
 */
export type BrainSelection = { providerId: CloudProviderConfig['id']; model: string }

export type ProviderHealth = {
  id: ProviderId
  healthy: boolean
  failCount: number
  cooldownUntil: number
}

export type ThalamusOptions = {
  corpus?: Corpus
  /**
   * Test-only: when set, cloud instantiate() returns this streamer instead
   * of constructing a real vendor client. Production never passes this.
   */
  testProvider?: {
    stream(options: ProviderStreamOptions): AsyncGenerator<StreamChunk>
  }
  /**
   * How long a cloud stream may go without ANY chunk before the call is
   * declared dead (see STREAM_STALL_MS). Tests shorten it; production keeps
   * the default.
   */
  stallTimeoutMs?: number
}

/**
 * A cloud call that produces no chunk at all for this long is dead, not
 * slow: a healthy stream shows its first token within seconds, and long
 * reasoning still streams thinking deltas. Observed 2026-09-15 on
 * deepseek-flash: one call sat silent for 10m23s and returned a single
 * token, another for 4m10s and returned nothing — and the driver session
 * underneath computer use expired while the loop waited. The watchdog aborts
 * the request, ends the turn with the `stalled` reason (the error card offers
 * Continue), and never retries on its own: five minutes of silence is the
 * person's call to make, not a backoff ladder's.
 *
 * Five minutes, not less, because reasoning-only silences are real: a
 * provider that does not stream its thinking (OpenAI's o-series through chat
 * completions) can legitimately sit quiet for a couple of minutes on a hard
 * problem. The local model is exempt entirely — Ollama says nothing while it
 * evaluates a long prompt, and on a slow machine that alone can pass five
 * minutes.
 */
export const STREAM_STALL_MS = 5 * 60_000
export const STREAM_STALL_REASON = 'stalled'

// How many requests a proven modality strip stays memoized before the next
// one probes with images again. See toolResultModalityRejects for why it
// expires at all rather than lasting the session.
export const MODALITY_MEMO_REQUESTS = 20

// Per-model cooldown after consecutive failures, exposed via getHealth()
// for diagnostics only. Resolution never skips the Brain because it is in
// cooldown — every turn re-tries the same selected model, and the retry
// budget below absorbs the actual back-off. Steps escalate so a
// genuinely-broken provider stays visibly degraded for longer.
const COOLDOWN_STEPS_MS = [30_000, 60_000, 120_000, 300_000]

// ~3 minutes total. The selected cloud model retries on transient failures
// (overloaded, rate-limited, gateway errors) with this schedule before the
// turn fails honestly. Slow but non-erroring streams never trip this —
// there's no per-call deadline, so a long response doesn't fail early.
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 90_000]

const PROVIDER_LOGO: Record<ProviderId, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  openrouter: 'openrouter',
  deepseek: 'deepseek',
  mimo: 'mimo',
  kimi: 'kimi',
  minimax: 'minimax',
  xai: 'xai',
  qwen: 'qwen',
  stepfun: 'stepfun',
  zai: 'zai',
  local: 'ollama'
}

// Short English labels surfaced to the local fallback model via the
// <provider> notice in its runtime block. They aren't i18n keys —
// nothing translates them — they're plain-text hints the model can
// quote or paraphrase when explaining the situation to the user.
const STATUS_REASON_LABEL: Record<number, string> = {
  400: 'bad request',
  401: 'authentication failed',
  403: 'forbidden',
  404: 'model not found',
  429: 'rate-limited',
  500: 'server error',
  502: 'gateway error',
  503: 'unavailable',
  504: 'timeout',
  529: 'overloaded'
}

type ErrorClass = 'transient' | 'hard' | 'offline' | 'stall' | 'unknown'

type ProviderFailure = {
  provider: ProviderId
  statusCode: number | null
  errorClass: ErrorClass
  reasonKey: string
  rawMessage: string | null
  retries: number
  durationMs: number
}

interface StreamableProvider {
  stream(options: ProviderStreamOptions): AsyncGenerator<StreamChunk>
}

type CascadeEntry = {
  id: ProviderId
  model: string
  provider: StreamableProvider
}

/**
 * Thalamus is the sensory gateway — every input passes through it before
 * it reaches any other region.
 *
 * Maps to: the thalamus — a pair of egg-shaped nuclei that sit on top of
 * the brainstem and relay almost every sensory signal (sight, sound,
 * touch, taste — everything except smell) up to the cortex. Nothing
 * reaches conscious processing without being routed by the thalamus first.
 *
 * In Wolffish, Thalamus resolves the single user-chosen model — the Brain
 * (one cloud provider+model) when cloud is active, or the local Ollama model
 * when the chat switcher is in local-only mode. It retries the same model on
 * transient failures and exposes a single async-generator interface so
 * downstream regions don't need to know which provider is responding. Model
 * resolution lives behind one seam (resolveEntry) so a different resolver
 * can swap in without touching any caller.
 */
export class Thalamus {
  private cloudProviders: CloudProviderConfig[] = []
  private brain: BrainSelection | null = null
  private health = new Map<ProviderId, ProviderHealth>()
  private corpus: Corpus | null
  private localOnly = false
  private testProvider: StreamableProvider | null
  private readonly stallTimeoutMs: number
  /**
   * provider:model → the strip scope that actually cured a modality 400,
   * plus how many more requests it applies to. Written only after a
   * stripped retry succeeds, so a strip that did not cure never poisons
   * later turns.
   *
   * It expires because "the strip cured it" is not proof the model is
   * blind. A 400 whose text merely CONTAINS the word image trips
   * MODALITY_REJECT_PATTERN, and removing the picture cures that too —
   * DashScope's documented sub-10px complaint is exactly this shape, and
   * image_view can produce a sub-10px view since it never upscales. Left
   * permanent, one such 400 would blind a fully-capable model for the rest
   * of the session, silently. Expiring re-probes with images every
   * MODALITY_MEMO_REQUESTS requests: a genuinely text-only-in-tool-results
   * provider costs one extra retry per cycle, while a false positive heals
   * itself instead of degrading every answer until relaunch.
   */
  private toolResultModalityRejects = new Map<
    string,
    { scope: VisualStripScope; remaining: number }
  >()

  constructor(
    private local: LocalProvider,
    options: ThalamusOptions = {}
  ) {
    this.corpus = options.corpus ?? null
    this.testProvider = options.testProvider ?? null
    this.stallTimeoutMs = options.stallTimeoutMs ?? STREAM_STALL_MS
  }

  setCorpus(corpus: Corpus): void {
    this.corpus = corpus
  }

  setCloudProviders(providers: CloudProviderConfig[]): void {
    this.cloudProviders = providers.filter((p) => p.apiKey && p.model)
  }

  getCloudProviders(): CloudProviderConfig[] {
    return [...this.cloudProviders]
  }

  /**
   * Set the Brain — the single user-chosen cloud provider+model that runs
   * when not in local-only mode. Null clears it (no cloud model selected).
   */
  setBrain(brain: BrainSelection | null): void {
    this.brain = brain ? { ...brain } : null
  }

  setLocalOnly(value: boolean): void {
    this.localOnly = value
  }

  /**
   * The provider that would handle the next turn — the Brain's provider, or
   * 'local' in local-only mode. Null when nothing is selected/ready.
   */
  getActiveProvider(): ProviderId | null {
    return this.resolveEntry()?.id ?? null
  }

  /**
   * Model name that getActiveProvider() points at. Null when nothing is
   * selected/ready.
   */
  getActiveModel(): string | null {
    return this.resolveEntry()?.model ?? null
  }

  getLocalModelName(): string | null {
    return this.local.currentModel
  }

  /**
   * Whether the active local model supports image input. Queries
   * Ollama's /api/show on first call and caches the result. Returns
   * false when no local model is configured.
   */
  async localSupportsVision(): Promise<boolean> {
    return this.local.supportsVision()
  }

  /**
   * Per-entry multimodal gate. Vision blocks can reach a text-only entry
   * via replayed history or tool-result screenshots — and text-only APIs
   * reject the whole request with HTTP 400 when they see an image part
   * (DeepSeek: `unknown variant image_url, expected text`). Strip rather
   * than fail: the model gets a note about what was removed instead.
   */
  private async guardVisualContent(
    entry: CascadeEntry,
    options: ProviderStreamOptions
  ): Promise<ProviderStreamOptions> {
    if (!hasVisualContent(options.messages)) return options
    // Long screen-control sessions accumulate dozens of near-identical
    // screenshots; models mis-ground clicks on stale frames and the images
    // dominate cost. Keep only the newest few (batched, cache-friendly).
    const limited = limitToolResultImages(options.messages)
    if (limited !== options.messages) options = { ...options, messages: limited }
    const vision =
      entry.id === 'local'
        ? await this.local.supportsVision()
        : cloudModelSupportsVision(entry.id, entry.model)
    if (!vision) {
      return { ...options, messages: stripVisualContent(options.messages) }
    }
    const memoKey = `${entry.id}:${entry.model}`
    const memo = this.toolResultModalityRejects.get(memoKey)
    if (memo) {
      // Spend one use, then let the next request probe with images again.
      memo.remaining -= 1
      if (memo.remaining <= 0) this.toolResultModalityRejects.delete(memoKey)
      const memoScope = memo.scope
      const reason =
        memoScope === 'tool' ? TOOL_RESULT_MODALITY_STRIP_REASON : REQUEST_MODALITY_STRIP_REASON
      return {
        ...options,
        messages: stripVisualContent(options.messages, reason, memoScope)
      }
    }
    return options
  }

  /**
   * Context-window size (input tokens) for the model that would handle the
   * next turn — i.e. the resolved active model. Returns a conservative
   * 8 000 when nothing is selected/ready.
   */
  getActiveContextWindow(): number {
    const entry = this.resolveEntry()
    if (!entry) return 8_000
    return this.windowForEntry(entry)
  }

  /**
   * Async sibling of {@link getActiveContextWindow}. For local models this
   * awaits the real window Ollama reports (warming the LocalProvider cache)
   * rather than returning the name-based estimate while the cache is still
   * cold. Used by the model:capabilities IPC so the renderer's context meter
   * gets the true window the instant a model is switched — not a stale
   * fallback that would otherwise never be corrected (nothing re-fetches once
   * the cache warms). Cloud models resolve synchronously, as before.
   */
  async resolveActiveContextWindow(): Promise<number> {
    const entry = this.resolveEntry()
    if (!entry) return 8_000
    if (entry.id === 'local') return this.local.resolveContextWindow()
    return this.windowForEntry(entry)
  }

  /**
   * Token budget for context assembly. Subtracts the model's output ceiling
   * from the context window so the combined input+max_tokens never exceeds
   * the model's limit. For Anthropic (separate input/output budgets) the
   * deduction is zero.
   */
  getContextBudget(): number {
    const entry = this.resolveEntry()
    if (!entry) return 8_000
    const window = this.windowForEntry(entry)
    const outputReserve = maxOutputForModel(entry.model)
    return Math.max(window - outputReserve, Math.floor(window * 0.5))
  }

  /**
   * Context window for an explicit per-agent model choice, falling back to
   * the active model when null. Workflow subagents on overridden models must
   * be budgeted against THEIR window, not the Brain's — an 8k-window agent
   * budgeted as a 200k brain overflows with a 400 instead of compacting.
   */
  getContextWindowFor(sel: { provider: ProviderId; model: string } | null): number {
    if (!sel) return this.getActiveContextWindow()
    return contextWindowForModel(sel.model)
  }

  /** Budget sibling of {@link getContextWindowFor} — window minus output reserve. */
  getContextBudgetFor(sel: { provider: ProviderId; model: string } | null): number {
    if (!sel) return this.getContextBudget()
    const window = contextWindowForModel(sel.model)
    const outputReserve = maxOutputForModel(sel.model)
    return Math.max(window - outputReserve, Math.floor(window * 0.5))
  }

  /**
   * Spawn-time validation for a master-supplied model choice. Returns an
   * error string when the provider isn't connected (immediate, deterministic
   * tool error), null when the choice is streamable. A model id missing from
   * the provider's cached catalog is deliberately accepted — the catalog can
   * lag the provider; a genuinely dead id surfaces as that agent's failure.
   */
  validateModelChoice(sel: { provider: ProviderId; model: string }): string | null {
    if (sel.provider === 'local') {
      return 'per-agent model choices are cloud only — omit the model to run the agent on your own model'
    }
    const cfg = this.cloudProviders.find((p) => p.id === sel.provider)
    if (!cfg) {
      const connected = this.cloudProviders.map((p) => p.id).join(', ') || 'none'
      return `provider "${sel.provider}" is not connected (connected: ${connected}) — pick a model from <workflow_models> or omit for your own model`
    }
    return null
  }

  /**
   * Context window for a resolved entry. Cloud models map by name; local
   * models use the real window Ollama reports for the model (cached by the
   * LocalProvider after the first /api/show), falling back to the name-based
   * estimate until that cache is warm. Without this a local model whose name
   * isn't recognized would be budgeted at the 8 000 fallback even though it
   * may have a far larger (or smaller) real window.
   */
  private windowForEntry(entry: CascadeEntry): number {
    if (entry.id === 'local') {
      return this.local.cachedContextWindow() ?? contextWindowForModel(entry.model)
    }
    return contextWindowForModel(entry.model)
  }

  /**
   * Raw LLM call for conversation-level summarization during compaction.
   * Takes a complete prompt (no hardcoded instruction)
   * and uses 5 retries with escalating backoff for resilience.
   *
   * If the prompt exceeds the model's context window, it is split into parts,
   * each summarized separately, and the results merged.
   */
  async summarize(
    prompt: string,
    signal?: AbortSignal
  ): Promise<{ text: string; provider: string; model: string }> {
    const promptTokens = Math.ceil(prompt.length / 4)

    const entry = this.resolveEntry()
    if (!entry) throw new Error('No summarization provider available')

    const modelWindow = contextWindowForModel(entry.model)
    const maxOutput = maxOutputForModel(entry.model)
    const available = modelWindow - maxOutput

    if (promptTokens <= available) {
      const result = await this.completeSingle(entry, '', prompt, 'summary', signal)
      if (result) return result
      throw new Error('Summarization provider failed')
    }

    const charsPerPart = Math.max(available * 4 - 500, 4000)
    const parts: string[] = []
    for (let i = 0; i < prompt.length; i += charsPerPart) {
      parts.push(prompt.slice(i, i + charsPerPart))
    }

    const summaries = await Promise.all(
      parts.map((part) => this.completeSingle(entry, '', part, 'summary', signal))
    )
    const valid = summaries.filter(Boolean) as {
      text: string
      provider: string
      model: string
    }[]
    if (valid.length === parts.length) {
      return {
        text: valid.map((s) => s.text).join('\n\n'),
        provider: valid[0].provider,
        model: valid[0].model
      }
    }
    throw new Error('Summarization provider failed')
  }

  /**
   * Title a conversation. This is a dedicated TITLING call — NOT a summarize:
   * the caller's titling instructions ride in the SYSTEM prompt and the user's
   * message is the user turn, so the model is asked to name the conversation
   * rather than compress it. Shares completeSingle's 5× retry so titling is as
   * resilient as everything else; throws only if every attempt fails (the
   * titler treats that as unreachable and falls back to a plain slice).
   */
  async title(
    userMessage: string,
    systemPrompt: string,
    signal?: AbortSignal
  ): Promise<{ text: string; provider: string; model: string }> {
    const entry = this.resolveEntry()
    if (!entry) throw new Error('No titling provider available')
    const result = await this.completeSingle(entry, systemPrompt, userMessage, 'title', signal)
    if (result) return result
    throw new Error('Titling provider failed')
  }

  /**
   * One-shot analysis call for the diagnostic export: a system prompt plus the
   * conversation material as the user turn, exactly like {@link title}. No
   * tools, no streaming, no conversation created — the model only writes its
   * opinion of what went wrong, and the caller drops that text into the
   * diagnostic archive.
   *
   * Tagged role:'summary' rather than a role of its own, deliberately: this is
   * the same utility side-call family as summarization (Brain, reasoning off,
   * off every conversation's context meter), and a fourth role would have to
   * be threaded through the corpus event, the ledger and the meter's
   * side-spend split to buy nothing a reader of the ledger needs.
   */
  async diagnose(
    material: string,
    systemPrompt: string,
    signal?: AbortSignal
  ): Promise<{ text: string; provider: string; model: string }> {
    const entry = this.resolveEntry()
    if (!entry) throw new Error('No diagnostic provider available')
    const result = await this.completeSingle(entry, systemPrompt, material, 'summary', signal)
    if (result) return result
    throw new Error('Diagnostic provider failed')
  }

  /**
   * The reasoning modes THIS entry's model actually honours — the same source
   * of truth the Brain button reads. Providers assume `thinkingMode` arrives
   * already clamped to this list (see xai.ts's grok-4.5 branch), so every
   * caller that synthesizes a mode rather than passing the user's own must
   * run it through here first.
   */
  private reasoningModesForEntry(entry: CascadeEntry): ThinkingMode[] {
    const openrouterReasoning =
      entry.id === 'openrouter'
        ? (this.cloudProviders
            .find((p) => p.id === 'openrouter')
            ?.reasoningModels?.includes(entry.model) ?? false)
        : false
    return reasoningModesFor(entry.id, entry.model, { openrouterReasoning })
  }

  /**
   * Single non-streaming completion with 5 retries and escalating backoff
   * (1s, 2s, 4s, 8s, 16s). `system` may be '' (plain summarize during
   * compaction) or a task prompt (titling). `role` tags the emitted spend so
   * the ledger itemizes titling distinctly from summarization — a title is not
   * a summary — while both stay OFF a conversation's context meter (overhead).
   */
  private async completeSingle(
    entry: CascadeEntry,
    system: string,
    prompt: string,
    role: 'summary' | 'title',
    signal?: AbortSignal
  ): Promise<{ text: string; provider: string; model: string } | null> {
    const msgs: ChatMessage[] = [{ role: 'user', content: prompt }]
    const delays = [1000, 2000, 4000, 8000, 16000]

    // Titling and summarizing are utility side-calls on the configured Brain,
    // not judgement calls: reasoning buys nothing and costs everything. This
    // path never goes through stream()'s normalization, so an undefined
    // thinkingMode used to hit effortFromMode()'s 'high' default — every
    // title was a high-effort reasoning call (measured: p50 11.4s, p90 22.2s,
    // ~30% over the caller's 15s deadline, which then expired and left the
    // conversation permanently 'Untitled'), and compaction summaries paid the
    // same tax. Both roles now run with reasoning OFF — quick, cheap, and
    // independent of the user's per-model reasoning selection — clamped
    // through the same registry stream() uses, because providers assume a
    // normalized mode: an always-on reasoner (grok-4.5, qwq, k2-code) rejects
    // a raw 'off' and gets its lowest valid mode instead.
    const stream: ProviderStreamOptions = {
      system,
      messages: msgs,
      signal,
      thinkingMode: normalizeReasoningMode('off', this.reasoningModesForEntry(entry))
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      if (signal?.aborted) return null
      const startedAt = Date.now()
      try {
        let text = ''
        let usage: StreamUsage | null = null
        for await (const chunk of entry.provider.stream(stream)) {
          if (chunk.type === 'text') text += chunk.text
          else if (chunk.type === 'turn_meta' && chunk.usage) usage = chunk.usage
        }
        if (text.length > 0) {
          // Side-call spend is real billed tokens. Emit it tagged with this
          // call's own `role` ('summary' or 'title') so the ledger listener
          // records it and the renderer can itemize it as overhead — without
          // it feeding the context meter (naming or compressing a conversation
          // is not conversation context). Cost rides along so the renderer's
          // all-time totals stay cost-complete for this spend too.
          if (usage) {
            this.emit('llm.response', {
              provider: entry.id,
              model: entry.model,
              role,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheCreationTokens: usage.cacheCreationTokens ?? 0,
              cacheReadTokens: usage.cacheReadTokens ?? 0,
              durationMs: Date.now() - startedAt,
              cost: calculateCost(
                entry.id,
                entry.model,
                usage.inputTokens,
                usage.outputTokens,
                usage.cacheCreationTokens,
                usage.cacheReadTokens
              )
            })
          }
          return { text, provider: entry.id, model: entry.model }
        }
        // Completed, but said nothing. Nothing threw, so the catch below never
        // runs and the emit above is inside the truthy branch — this attempt
        // would otherwise leave no trace at all, which is the same blind spot
        // the catch exists to close. It is also the expected shape of
        // "reasoning crowded out the answer", the failure thinkingMode:'off'
        // targets, so it is exactly what we want to be able to see.
        this.emit('llm.error', {
          provider: entry.id,
          error: `${role} ${entry.model} (attempt ${attempt + 1}/5): empty completion`
        })
      } catch (err) {
        // Titling/summarizing calls entry.provider.stream() directly, so it
        // bypasses streamOnce() where the llm.error emits live — and the usage
        // emit above only fires on SUCCESS. A failed or timed-out title was
        // therefore invisible everywhere: no corpus event, no ledger row, and
        // titleFromMessage swallows the throw. The literal 'Untitled' on disk
        // was the only tell, which is how this bug survived nine days — and now
        // that a deadline degrades to a readable slice, there'd be no tell at
        // all. Emit so a silently-degrading title stays measurable.
        //
        // Safe to emit: llm.error has no UI consumer and is NOT in
        // TURN_RELAYED_EVENTS, so it lands in the corpus log and nowhere else —
        // a titling hiccup must never surface as an error in the user's chat.
        // Deliberately does NOT markFailed(): one slow title is not evidence
        // the provider is unhealthy for the turn that's about to run.
        // The abort REASON rides along so the log separates a titling deadline
        // (a degradation worth counting) from a user pressing stop (expected
        // noise) — they unwind identically otherwise. Read off the signal
        // rather than importing the titler's constant, which would point this
        // module at the app layer.
        const why = signal?.aborted ? `, aborted: ${String(signal.reason)}` : ''
        this.emit('llm.error', {
          provider: entry.id,
          error: `${role} ${entry.model} (attempt ${attempt + 1}/5${why}): ${
            err instanceof Error ? err.message : String(err)
          }`
        })
        if (attempt >= 4) return null
        await sleep(delays[attempt], signal)
      }
    }
    return null
  }

  /**
   * Stream a turn through the resolved active model.
   *
   * The selected cloud model (the Brain) gets a retry budget
   * (`RETRY_DELAYS_MS`) for transient failures (overloaded, rate-limited,
   * gateway errors); hard failures (auth, not-found) fail the turn
   * immediately. There is no cascade and no automatic substitution — the
   * chosen model runs, or the turn fails honestly. When the model is
   * permanently unavailable thalamus yields a single
   * `no_provider_available` chunk so the renderer can surface a structured
   * retry card. When nothing is selected (no Brain and not in local-only
   * mode, or no local model loaded) it yields a plain `error` chunk. The
   * local model never gets the retry budget. Once any text has streamed the
   * choice is committed — failures past that point surface as a committed
   * error rather than retrying.
   */
  async *stream(options: ProviderStreamOptions): AsyncGenerator<StreamChunk> {
    const entry = options.modelOverride
      ? this.resolveOverride(options.modelOverride)
      : this.resolveEntry()
    if (!entry) {
      const message = options.modelOverride
        ? `provider "${options.modelOverride.provider}" is not connected — the requested model ${options.modelOverride.model} cannot stream`
        : this.localOnly
          ? 'no local model loaded — pick one in the model picker'
          : 'no model selected — choose a model in the chat composer or switch to local'
      this.emit('llm.error', { provider: 'none', error: message })
      yield { type: 'error', message, recoverable: false }
      return
    }

    // Announce who's handling this turn so the renderer can show a chip.
    yield { type: 'active_model', provider: entry.id, model: entry.model }

    // Agent effort is chosen by the master, which can't know each agent
    // model's reasoning support (it differs widely: none / always-on / graded).
    // Clamp it to what THIS model actually offers — same source of truth as the
    // Brain button — so an unsupported pick degrades gracefully (max→high→on; a
    // non-reasoning model → off) instead of being sent verbatim and erroring.
    let opts = options
    if (options.role === 'agent') {
      const modes = this.reasoningModesForEntry(entry)
      opts = { ...options, thinkingMode: normalizeReasoningMode(options.thinkingMode, modes) }
    } else if (options.role === 'summary') {
      // Summarization side-calls that stream (the nightly memory compaction
      // job) mirror completeSingle's policy: reasoning OFF, on the configured
      // Brain, never the user's chat reasoning selection — utility work
      // should be quick and cheap. Normalized so an always-on reasoner
      // degrades to its lowest valid mode instead of erroring on a raw 'off'.
      const modes = this.reasoningModesForEntry(entry)
      opts = { ...options, thinkingMode: normalizeReasoningMode('off', modes) }
    }

    // Same-model retry: the cloud Brain (master / single) gets the transient
    // retry budget. AGENTS do NOT — an agent is single-shot and any failure
    // surfaces immediately to the master, which owns all agent retry decisions
    // end-to-end (re-run, re-scope, or report). The local model never retries
    // either (Ollama errors are local and effectively permanent).
    const retry = entry.id !== 'local' && options.role !== 'agent'
    const result = yield* this.streamOnce(entry, opts, { retry })
    if (result.kind === 'success') return
    if (result.kind === 'committed-error') {
      const failures = result.failure ? [toInfo(result.failure)] : undefined
      yield { type: 'error', message: result.message, recoverable: false, failures }
      return
    }
    // kind === 'failed' — the one selected model is permanently unavailable.
    yield { type: 'no_provider_available', failures: [toInfo(result.failure)] }
  }

  private async *streamOnce(
    entry: CascadeEntry,
    options: ProviderStreamOptions,
    cfg: { retry: boolean }
  ): AsyncGenerator<
    StreamChunk,
    | { kind: 'success' }
    | { kind: 'committed-error'; message: string; failure?: ProviderFailure }
    | { kind: 'failed'; failure: ProviderFailure }
  > {
    let guarded = await this.guardVisualContent(entry, shapeOutbound(options))
    const overallStartedAt = Date.now()
    let attempt = 0
    let lastFailure: ProviderFailure | null = null
    let modalityStage: 0 | 1 | 2 = 0

    while (true) {
      if (options.signal?.aborted) {
        return {
          kind: 'failed',
          failure: lastFailure ?? {
            provider: entry.id,
            statusCode: null,
            errorClass: 'unknown',
            reasonKey: 'unavailable',
            rawMessage: null,
            retries: attempt,
            durationMs: Date.now() - overallStartedAt
          }
        }
      }

      // Offline halts the cloud retries early; local can still try.
      if (entry.id !== 'local' && !net.isOnline()) {
        return {
          kind: 'failed',
          failure: {
            provider: entry.id,
            statusCode: null,
            errorClass: 'offline',
            reasonKey: 'offline',
            rawMessage: null,
            retries: attempt,
            durationMs: Date.now() - overallStartedAt
          }
        }
      }

      this.emit('llm.request', { provider: entry.id, model: entry.model })

      const startedAt = Date.now()
      let textEmitted = false
      let inputTokens = 0
      let outputTokens = 0
      let cacheCreationTokens = 0
      let cacheReadTokens = 0

      // Stall watchdog: a dead cloud stream aborts itself instead of hanging
      // the turn until the provider gives up. Re-armed on EVERY chunk, so a
      // slow-but-alive stream never trips it. Local is exempt (see
      // STREAM_STALL_MS).
      const stall = new AbortController()
      const stallMs = entry.id === 'local' ? 0 : this.stallTimeoutMs
      let stallTimer: ReturnType<typeof setTimeout> | null = null
      const armStall = (): void => {
        if (stallMs <= 0) return
        if (stallTimer) clearTimeout(stallTimer)
        stallTimer = setTimeout(() => stall.abort(new Error(STREAM_STALL_REASON)), stallMs)
      }
      const disarmStall = (): void => {
        if (stallTimer) clearTimeout(stallTimer)
        stallTimer = null
      }
      const request: ProviderStreamOptions =
        stallMs > 0
          ? {
              ...guarded,
              signal: options.signal
                ? AbortSignal.any([options.signal, stall.signal])
                : stall.signal
            }
          : guarded

      try {
        armStall()
        for await (const chunk of entry.provider.stream(request)) {
          armStall()
          if (chunk.type === 'text') {
            textEmitted = true
          } else if (chunk.type === 'turn_meta') {
            if (chunk.usage) {
              inputTokens = chunk.usage.inputTokens
              outputTokens = chunk.usage.outputTokens
              cacheCreationTokens = chunk.usage.cacheCreationTokens ?? 0
              cacheReadTokens = chunk.usage.cacheReadTokens ?? 0
            }
            // Stamp the entry that actually served this call so the agent
            // can pin the next iteration to it (active_model only names
            // the cascade head, which may not be who answered).
            yield { ...chunk, provider: entry.id, model: entry.model }
            continue
          }
          yield chunk
        }

        disarmStall()
        this.markHealthy(entry.id)
        if (modalityStage === 1 || modalityStage === 2) {
          this.toolResultModalityRejects.set(`${entry.id}:${entry.model}`, {
            scope: modalityStage === 1 ? 'tool' : 'all',
            remaining: MODALITY_MEMO_REQUESTS
          })
        }
        const durationMs = Date.now() - startedAt
        this.emit('llm.response', {
          provider: entry.id,
          model: entry.model,
          // Subagent calls keep the 'worker' wire value — renderer meter
          // routing and persisted stats predate the workflow rename.
          role:
            options.role === 'agent' ? 'worker' : options.role === 'summary' ? 'summary' : 'brain',
          inputTokens,
          outputTokens,
          cacheCreationTokens,
          cacheReadTokens,
          durationMs
        })
        return { kind: 'success' }
      } catch (err) {
        disarmStall()
        if (stall.signal.aborted && !options.signal?.aborted) {
          // The watchdog fired: the provider went silent for the whole
          // window. No retry — the turn ends on the `stalled` reason and the
          // person decides (the error card's Continue). Checked before the
          // generic abort branch, which would otherwise read our own abort
          // as the user's Stop.
          const minutes = Math.round(stallMs / 60_000)
          const detail = `no response from ${entry.id} for ${minutes} minute${minutes === 1 ? '' : 's'}`
          this.markFailed(entry.id)
          this.emit('llm.error', { provider: entry.id, error: `${STREAM_STALL_REASON}: ${detail}` })
          return {
            kind: 'failed',
            failure: {
              provider: entry.id,
              statusCode: null,
              errorClass: 'stall',
              reasonKey: STREAM_STALL_REASON,
              rawMessage: detail,
              retries: attempt,
              durationMs: Date.now() - overallStartedAt
            }
          }
        }
        const message = err instanceof Error ? err.message : String(err)
        this.markFailed(entry.id)
        this.emit('llm.error', { provider: entry.id, error: message })

        if (textEmitted) {
          // Provider had already streamed bytes to the user — committing
          // to a different provider mid-turn would be incoherent.
          const classified = classifyError(err)
          return {
            kind: 'committed-error',
            message,
            failure: {
              provider: entry.id,
              statusCode: classified.statusCode,
              errorClass: classified.errorClass,
              reasonKey: reasonKeyFor(classified.statusCode, message),
              rawMessage: extractProviderDetail(message) ?? message,
              retries: attempt,
              durationMs: Date.now() - overallStartedAt
            }
          }
        }
        if (isAbortError(err)) {
          return { kind: 'committed-error', message }
        }

        const classified = classifyError(err)
        lastFailure = {
          provider: entry.id,
          statusCode: classified.statusCode,
          errorClass: classified.errorClass,
          reasonKey: reasonKeyFor(classified.statusCode, message),
          rawMessage: extractProviderDetail(message) ?? message,
          retries: attempt,
          durationMs: Date.now() - overallStartedAt
        }

        // Two-stage modality ladder. Stage 1 strips only tool-result
        // images (user attachments stay). Stage 2 strips everything.
        // Bound: initial + two retries, then failed. Memo is written
        // on success, not here — a strip that didn't cure must not
        // poison the session.
        const status = classified.statusCode
        const modalityHit =
          (status === 400 || status === 422) &&
          isModalityReject(message) &&
          hasVisualContent(guarded.messages)
        if (modalityHit && modalityStage === 0) {
          modalityStage = 1
          const detail = extractProviderDetail(message) ?? message
          console.log(
            `[thalamus] modality reject on ${entry.id}/${entry.model} — retrying without tool-result images: ${detail}`
          )
          guarded = {
            ...guarded,
            messages: stripVisualContent(
              guarded.messages,
              TOOL_RESULT_MODALITY_STRIP_REASON,
              'tool'
            )
          }
          continue
        }
        // Stage 2 is forward-compat and unreachable today: it needs a user
        // image/document block to still be present after stage 1 stripped the
        // tool images, and nothing in the app produces one — every attachment
        // becomes a text reference note (uploads/file-processor.ts), so the
        // only visual content that ever exists is a tool result. It stays
        // because anthropic.ts already decodes native image/document blocks,
        // so the day user blocks are produced this arms itself. Kept rather
        // than deleted; the test covering it builds a synthetic user block.
        if (modalityHit && modalityStage === 1) {
          modalityStage = 2
          const detail = extractProviderDetail(message) ?? message
          console.log(
            `[thalamus] modality reject on ${entry.id}/${entry.model} after tool-only strip — retrying without any images: ${detail}`
          )
          guarded = {
            ...guarded,
            messages: stripVisualContent(guarded.messages, REQUEST_MODALITY_STRIP_REASON, 'all')
          }
          continue
        }

        // Hard errors aren't worth retrying on the same provider.
        if (classified.errorClass === 'hard' || !cfg.retry) {
          return { kind: 'failed', failure: lastFailure }
        }

        // Transient: back off and try again on the same provider.
        if (attempt >= RETRY_DELAYS_MS.length) {
          return { kind: 'failed', failure: lastFailure }
        }
        const delay = RETRY_DELAYS_MS[attempt]
        attempt += 1
        this.emit('llm.retry', {
          provider: entry.id,
          attempt,
          delayMs: delay,
          errorClass: classified.errorClass
        })
        const slept = await sleep(delay, options.signal)
        if (!slept) {
          return {
            kind: 'failed',
            failure: {
              ...lastFailure,
              retries: attempt,
              durationMs: Date.now() - overallStartedAt
            }
          }
        }
      }
    }
  }

  /**
   * Snapshot of health for the resolved active model, for diagnostics.
   */
  getHealth(): ProviderHealth[] {
    const entry = this.resolveEntry()
    if (!entry) return []
    const state = this.health.get(entry.id)
    return [
      state ?? {
        id: entry.id,
        healthy: true,
        failCount: 0,
        cooldownUntil: 0
      }
    ]
  }

  /**
   * The resolution seam — the ONE place that answers "which provider+model
   * handles this request". Local-only mode resolves to the local model; the
   * Brain otherwise; null when nothing is selected/ready. Swapping the
   * resolution policy means swapping only this method body — callers never change.
   */
  private resolveEntry(): CascadeEntry | null {
    if (this.localOnly) {
      if (!this.local.isReady) return null
      return { id: 'local', model: this.local.currentModel ?? 'local', provider: this.local }
    }
    if (!this.brain) return null
    const cfg = this.cloudProviders.find((p) => p.id === this.brain!.providerId)
    if (!cfg) return null
    return this.instantiate(cfg, this.brain.model)
  }

  /**
   * Resolve an explicit per-agent model choice (workflow mode) — a pure cloud
   * selection, independent of localOnly. Null when the provider isn't
   * connected; the caller surfaces that as a deterministic error, never a
   * silent fallback.
   */
  private resolveOverride(sel: { provider: ProviderId; model: string }): CascadeEntry | null {
    if (sel.provider === 'local') return null
    const cfg = this.cloudProviders.find((p) => p.id === sel.provider)
    if (!cfg) return null
    return this.instantiate(cfg, sel.model)
  }

  /** Construct the provider client for one cloud config + the Brain's model. */
  private instantiate(cfg: CloudProviderConfig, model: string): CascadeEntry {
    if (this.testProvider) {
      return { id: cfg.id, model, provider: this.testProvider }
    }
    switch (cfg.id) {
      case 'anthropic':
        return {
          id: 'anthropic',
          model,
          provider: new AnthropicProvider(cfg.apiKey, model, undefined, undefined, cfg.cacheTtl)
        }
      case 'openai':
        return {
          id: 'openai',
          model,
          provider: new OpenAIProvider(cfg.apiKey, model, undefined, this.corpus)
        }
      case 'deepseek':
        return { id: 'deepseek', model, provider: new DeepSeekProvider(cfg.apiKey, model) }
      case 'mimo':
        return { id: 'mimo', model, provider: new MimoProvider(cfg.apiKey, model) }
      case 'kimi':
        return { id: 'kimi', model, provider: new KimiProvider(cfg.apiKey, model) }
      case 'minimax':
        return { id: 'minimax', model, provider: new MiniMaxProvider(cfg.apiKey, model) }
      case 'xai':
        return { id: 'xai', model, provider: new XAIProvider(cfg.apiKey, model) }
      case 'qwen':
        return { id: 'qwen', model, provider: new QwenProvider(cfg.apiKey, model) }
      case 'stepfun':
        return { id: 'stepfun', model, provider: new StepfunProvider(cfg.apiKey, model) }
      case 'zai':
        return { id: 'zai', model, provider: new ZaiProvider(cfg.apiKey, model) }
      case 'openrouter':
        return {
          id: 'openrouter',
          model,
          provider: new OpenRouterProvider(cfg.apiKey, model, undefined, cfg.reasoningModels)
        }
      default: {
        const _exhaustive: never = cfg.id
        throw new Error(`unknown provider: ${String(_exhaustive)}`)
      }
    }
  }

  private markHealthy(id: ProviderId): void {
    this.health.set(id, { id, healthy: true, failCount: 0, cooldownUntil: 0 })
  }

  private markFailed(id: ProviderId): void {
    const prev = this.health.get(id)
    const failCount = (prev?.failCount ?? 0) + 1
    const stepIdx = Math.min(failCount - 1, COOLDOWN_STEPS_MS.length - 1)
    const cooldown = COOLDOWN_STEPS_MS[stepIdx]
    this.health.set(id, {
      id,
      healthy: false,
      failCount,
      cooldownUntil: Date.now() + cooldown
    })
  }

  private emit<K extends 'llm.request' | 'llm.response' | 'llm.error' | 'llm.retry'>(
    event: K,
    payload: K extends 'llm.request'
      ? { provider: string; model: string }
      : K extends 'llm.response'
        ? {
            provider: string
            model: string
            role: 'brain' | 'worker' | 'summary' | 'title'
            inputTokens: number
            outputTokens: number
            cacheCreationTokens: number
            cacheReadTokens: number
            durationMs: number
            cost?: number
          }
        : K extends 'llm.error'
          ? { provider: string; error: string }
          : { provider: string; attempt: number; delayMs: number; errorClass: string }
  ): void {
    if (!this.corpus) return
    if (event === 'llm.request') {
      this.corpus.emit('llm.request', payload as { provider: string; model: string })
    } else if (event === 'llm.response') {
      this.corpus.emit(
        'llm.response',
        payload as {
          provider: string
          model: string
          role: 'brain' | 'worker' | 'summary' | 'title'
          inputTokens: number
          outputTokens: number
          cacheCreationTokens: number
          cacheReadTokens: number
          durationMs: number
          cost?: number
        }
      )
    } else if (event === 'llm.error') {
      this.corpus.emit('llm.error', payload as { provider: string; error: string })
    } else {
      this.corpus.emit(
        'llm.retry',
        payload as { provider: string; attempt: number; delayMs: number; errorClass: string }
      )
    }
  }
}

/** Map an internal provider failure to the renderer-facing error card shape. */
function toInfo(f: ProviderFailure): NoProviderAvailableInfo {
  return {
    provider: f.provider,
    providerLogo: PROVIDER_LOGO[f.provider],
    statusCode: f.statusCode,
    errorReason: f.reasonKey,
    errorDetail: f.rawMessage,
    retriesAttempted: f.retries,
    totalDurationMs: f.durationMs
  }
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = (err as { name?: string }).name
  return name === 'AbortError'
}

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504, 529])
// 413 (payload too large) is hard: retrying re-uploads the same oversized
// body through the whole backoff ladder — minutes of silent hang for a
// request that can never succeed. Same for 422 (unprocessable payload).
const HARD_STATUSES = new Set([400, 401, 403, 404, 413, 422])

function classifyError(err: unknown): { statusCode: number | null; errorClass: ErrorClass } {
  const message = err instanceof Error ? err.message : String(err)
  const status = parseHttpStatus(message)
  if (status !== null) {
    if (TRANSIENT_STATUSES.has(status)) return { statusCode: status, errorClass: 'transient' }
    if (HARD_STATUSES.has(status)) return { statusCode: status, errorClass: 'hard' }
    return { statusCode: status, errorClass: 'unknown' }
  }
  // Fetch-level network errors look like TypeError or AbortError; the
  // ECONNRESET / ETIMEDOUT family also surfaces as transient.
  if (/overloaded|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|fetch failed|timeout/i.test(message)) {
    return { statusCode: null, errorClass: 'transient' }
  }
  return { statusCode: null, errorClass: 'unknown' }
}

function parseHttpStatus(message: string): number | null {
  const match = /HTTP\s+(\d{3})/.exec(message)
  return match ? Number(match[1]) : null
}

function reasonKeyFor(statusCode: number | null, rawMessage?: string): string {
  if (statusCode !== null && STATUS_REASON_LABEL[statusCode]) {
    return STATUS_REASON_LABEL[statusCode]
  }
  if (rawMessage && /timeout/i.test(rawMessage)) {
    return 'timeout'
  }
  return 'unavailable'
}

function extractProviderDetail(raw: string): string | null {
  const jsonStart = raw.indexOf('{')
  if (jsonStart === -1) return null
  try {
    const parsed = JSON.parse(raw.slice(jsonStart))
    const msg = parsed?.error?.message ?? parsed?.message
    return typeof msg === 'string' ? msg : null
  } catch {
    return null
  }
}

export function contextWindowForModel(model: string): number {
  const m = model.toLowerCase()
  // Claude Fable 5 and 4.6+ — Fable 5, Opus 4.6/4.7/4.8, Sonnet 4.6 have 1M windows
  if (m.includes('fable')) return 1_000_000
  if (m.includes('opus-4-8') || m.includes('opus-4-7') || m.includes('opus-4-6')) return 1_000_000
  if (m.includes('sonnet-4-6')) return 1_000_000
  // Claude 4.0–4.5 and Haiku — 200k
  if (m.includes('opus-4') || m.includes('sonnet-4')) return 200_000
  if (m.includes('haiku-4')) return 200_000
  // Claude 3.x
  if (m.includes('3-7-sonnet') || m.includes('3.7-sonnet')) return 200_000
  if (m.includes('3-5-sonnet') || m.includes('3.5-sonnet')) return 200_000
  if (m.includes('3-5-haiku') || m.includes('3.5-haiku')) return 200_000
  if (m.includes('opus') || m.includes('sonnet') || m.includes('haiku')) return 200_000
  // DeepSeek — `deepseek-flash` (V4.1-Flash) has no version in its id, and
  // the retired deepseek-chat / deepseek-reasoner aliases are served by it
  if (m.includes('deepseek-v4') || /^deepseek-(flash|chat|reasoner)$/.test(m)) return 1_000_000
  // Xiaomi Mimo
  if (m.includes('mimo-v2.5')) return 1_000_000
  if (m.includes('mimo-v2')) return 256_000
  if (m.includes('mimo')) return 256_000
  // Kimi / Moonshot
  if (m.includes('kimi-k3')) return 1_048_576
  if (m.includes('kimi-k2')) return 262_144
  if (m.includes('moonshot-v1-128k')) return 131_072
  if (m.includes('moonshot-v1-32k')) return 32_768
  if (m.includes('moonshot-v1-8k')) return 8_192
  if (m.includes('moonshot')) return 131_072
  // MiniMax
  if (m.includes('minimax-m3')) return 1_000_000
  if (m.includes('minimax-m2')) return 200_000
  // Qwen Cloud
  if (m.includes('qwen3.8')) return 1_000_000
  if (m.includes('qwen3.7-max') || m.includes('qwen3.7-plus')) return 1_000_000
  if (m.includes('qwen3.6')) return 1_000_000
  if (m.includes('qwen3.5-plus') || m.includes('qwen3.5-flash')) return 1_000_000
  if (m.includes('qwen3-max') || m.includes('qwen3-coder')) return 131_072
  if (m.includes('qwen-max') || m.includes('qwen-plus')) return 131_072
  if (m.includes('qwen-turbo') || m.includes('qwen-flash')) return 131_072
  // Stepfun
  if (m.includes('step-3')) return 128_000
  if (m.includes('step-2-16k')) return 16_000
  if (m.includes('step-2')) return 128_000
  if (m.includes('step-1-200k')) return 200_000
  if (m.includes('step-1-128k')) return 128_000
  if (m.includes('step-1')) return 64_000
  // Z.ai / GLM (Zhipu). Specific versions before the bare-family checks
  // since "glm-5" is a substring of glm-5.1 / glm-5.2 / glm-5-turbo.
  if (m.includes('glm-5.2')) return 1_000_000
  if (m.includes('glm-5.1')) return 204_800
  if (m.includes('glm-5-turbo')) return 204_800
  if (m.includes('glm-5')) return 204_800
  if (m.includes('glm-4.7')) return 204_800
  if (m.includes('glm-4.6')) return 204_800
  if (m.includes('glm-4.5')) return 131_072
  if (m.includes('glm')) return 131_072
  // OpenRouter — model IDs are prefixed with provider slug (e.g. "anthropic/claude-…")
  // so the checks above for bare model names won't match. Catch the common ones here.
  if (m.includes('anthropic/claude')) return 200_000
  if (m.includes('openai/gpt-5') || m.includes('openai/gpt-4.1')) return 1_000_000
  if (m.includes('openai/gpt-4o')) return 128_000
  if (m.includes('openai/o3') || m.includes('openai/o4')) return 200_000
  if (m.includes('google/gemini-2')) return 1_000_000
  if (m.includes('deepseek/deepseek')) return 128_000
  if (m.includes('meta-llama/')) return 131_072
  if (m.includes('mistralai/')) return 131_072
  if (m.includes('qwen/')) return 131_072
  // xAI / Grok — verified against GET /v1/models `context_length` (2026-08-13).
  if (m.includes('grok-4.6') || m.includes('grok-4.5')) return 500_000
  if (m.includes('grok-4.3') || m.includes('grok-4.20')) return 1_000_000
  if (m.includes('grok-build')) return 256_000
  if (m.includes('grok-4')) return 256_000
  if (m.includes('grok-3')) return 131_072
  if (m.includes('grok-2')) return 131_072
  // OpenAI
  if (m.includes('gpt-5.4') || m.includes('gpt-5.5')) return 1_000_000
  if (m.includes('gpt-5')) return 400_000
  if (m.includes('gpt-4.1')) return 1_000_000
  if (m.includes('gpt-4o')) return 128_000
  if (m.includes('gpt-4')) return 128_000
  if (m.includes('o1-mini')) return 128_000
  if (m.includes('o1')) return 128_000
  if (m.includes('o3') || m.includes('o4')) return 200_000
  if (m.includes('gpt-3.5')) return 16_000
  return 8_000
}

/**
 * Max output tokens (max_tokens / max_completion_tokens) that the provider
 * sends for a given model. Used by getContextBudget() to reserve space.
 * For Anthropic the input/output budgets are independent so this returns 0.
 */
function maxOutputForModel(model: string): number {
  const m = model.toLowerCase()
  // Anthropic — input and output windows are separate
  if (m.includes('opus-4') || m.includes('sonnet-4') || m.includes('haiku-4')) return 0
  if (m.includes('claude')) return 0
  if (/3\.[57]-(sonnet|haiku)/.test(m)) return 0
  // DeepSeek — must match maxTokensFor in providers/deepseek.ts (65,536 for
  // the v4 line; the API cap is 384K but we request 64K).
  if (m.includes('deepseek-v4') || /^deepseek-(flash|chat|reasoner)$/.test(m)) return 65_536
  // Xiaomi Mimo
  if (m.includes('mimo-v2.5-pro')) return 65_536
  if (m.includes('mimo')) return 32_768
  // Kimi / Moonshot
  if (m.includes('kimi-k3')) return 131_072
  if (m.includes('kimi-k2')) return 65_536
  if (m.includes('moonshot-v1-128k')) return 16_384
  if (m.includes('moonshot-v1-32k')) return 8_192
  if (m.includes('moonshot-v1-8k')) return 4_096
  if (m.includes('moonshot')) return 8_192
  // MiniMax
  if (m.includes('minimax-m3')) return 65_536
  if (m.includes('minimax-m2')) return 32_768
  // Qwen
  if (m.includes('qwen3.8')) return 131_072
  if (m.includes('qwen3.7') || m.includes('qwen3.6') || m.includes('qwen3.5')) return 65_536
  if (m.includes('qwen3')) return 32_768
  if (m.includes('qwen-plus')) return 32_768
  if (m.includes('qwen')) return 8_192
  // Stepfun
  if (m.includes('step-3')) return 32_768
  if (m.includes('step-2') || m.includes('step-1')) return 8_192
  // Z.ai / GLM — uniform 65,536 output budget (under every model's cap:
  // glm-4.5/4.5-air = 98,304, glm-4.6+ = 131,072). Matches maxTokensFor
  // in providers/zai.ts.
  if (m.includes('glm')) return 65_536
  // xAI / Grok
  if (
    m.includes('grok-4.6') ||
    m.includes('grok-4.5') ||
    m.includes('grok-4.3') ||
    m.includes('grok-4.20')
  )
    return 65_536
  if (m.includes('grok-4') || m.includes('grok-build')) return 32_768
  if (m.includes('grok')) return 32_768
  // OpenAI
  if (m.includes('gpt-5')) return 65_536
  if (m.includes('gpt-4.1')) return 32_768
  if (m.includes('gpt-4o') || m.includes('gpt-4')) return 16_384
  if (m.includes('o1')) return 32_768
  if (m.includes('o3') || m.includes('o4')) return 65_536
  // OpenRouter prefixed models — match provider slug patterns
  if (m.includes('anthropic/')) return 0
  if (m.includes('openai/gpt-5')) return 65_536
  if (m.includes('openai/o3') || m.includes('openai/o4')) return 65_536
  if (m.includes('openai/gpt-4.1')) return 32_768
  if (m.includes('openai/gpt-4o')) return 16_384
  if (m.includes('deepseek/')) return 32_768
  if (m.includes('google/gemini')) return 65_536
  return 32_768
}

/**
 * Rough token estimate for a messages array. Uses the same 1-token ≈ 4-chars
 * heuristic as RAS.estimateTokens(). Accounts for all text content in
 * user, assistant, tool, and system messages plus base64 image payloads
 * (≈0.75 bytes per token after base64 overhead).
 */
export function estimateMessageTokens(messages: ChatMessage[]): number {
  let chars = 0
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
            else if (block.type === 'image') chars += estimateImageTokens(block) * 4
            else if (block.type === 'document') chars += block.data.length * 0.75
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
          for (const img of selectInlineImages(m.images, m.toolName).inline)
            chars += estimateImageTokens(img) * 4
        }
        break
    }
  }
  return Math.ceil(chars / 4)
}

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
