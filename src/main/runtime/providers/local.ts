import { DEFAULT_ENDPOINT, showModel, type OllamaShowResponse } from '@main/ollama'
import type {
  ChatMessage,
  ProviderStreamOptions,
  StopReason,
  StreamChunk,
  ToolDefinition
} from '@main/runtime/thalamus'
import { thinkingEnabled } from '@main/runtime/reasoning'
import { inlineOmittedNote, selectInlineImages } from '@main/runtime/tool-images'

export type { ChatMessage }

/**
 * num_ctx to fall back to when /api/show doesn't report the model's context
 * length. Well above Ollama's 4096 default so a normal prompt isn't starved.
 * The real value is the model's own max context, fetched per model.
 */
const FALLBACK_LOCAL_CONTEXT = 16_384

/**
 * LocalProvider is a thin wrapper around the Ollama HTTP API. The provider
 * holds the currently-selected model name and endpoint. There's no load/unload
 * — Ollama loads on first request and evicts on its own.
 */
export class LocalProvider {
  private model: string | null = null
  private endpoint: string = DEFAULT_ENDPOINT
  private visionCache = new Map<string, boolean>()
  private thinkingCache = new Map<string, boolean>()
  private contextCache = new Map<string, number>()

  configure(model: string | null, endpoint: string = DEFAULT_ENDPOINT): void {
    if (model !== this.model) {
      this.visionCache.clear()
      this.thinkingCache.clear()
      this.contextCache.clear()
    }
    this.model = model
    this.endpoint = endpoint
    // Warm the context-window cache so the synchronous Thalamus budget getters
    // reflect the real window on the very first turn. Fire-and-forget — the
    // per-request num_ctx in stream() is resolved independently, so this is
    // purely an early-warm optimization.
    if (model) void this.resolveContextWindow().catch(() => undefined)
  }

  get isReady(): boolean {
    return this.model !== null
  }

  get currentModel(): string | null {
    return this.model
  }

  get currentEndpoint(): string {
    return this.endpoint
  }

  /**
   * Determine whether the active local model supports vision input.
   * Queries Ollama's /api/show for the model's `capabilities` array (newer
   * Ollama versions return this) and looks for "vision". Falls back to
   * model-name pattern matching when /api/show doesn't expose
   * capabilities. Defaults to false on any uncertainty — better to refuse
   * uploads than silently drop them.
   */
  async supportsVision(): Promise<boolean> {
    const model = this.model
    if (!model) return false
    const cached = this.visionCache.get(model)
    if (cached !== undefined) return cached

    const info = await safeShowModel(model, this.endpoint)
    // Ollama unreachable: use the name heuristic for THIS call but don't cache
    // it — a down-state guess would pin the answer for the whole session, since
    // nothing re-queries once the cache warms. Retry on the next call instead.
    if (!info) return isLikelyVisionByName(model)

    const supports = Array.isArray(info.capabilities)
      ? info.capabilities.includes('vision')
      : isLikelyVisionByName(model)
    this.visionCache.set(model, supports)
    return supports
  }

  /**
   * Whether the active local model is a reasoning model. Reads Ollama's
   * /api/show `capabilities` array and looks for "thinking". Newer reasoning
   * models accept a top-level `think` field on /api/chat; non-reasoning models
   * don't, so we gate on this to avoid sending an unsupported param.
   */
  async supportsThinking(): Promise<boolean> {
    const model = this.model
    if (!model) return false
    const cached = this.thinkingCache.get(model)
    if (cached !== undefined) return cached

    const info = await safeShowModel(model, this.endpoint)
    // Ollama unreachable: don't cache. Caching `false` here would silently
    // strip reasoning from a thinking-capable model for the rest of the
    // session if Ollama happened to be down when the cache was first warmed.
    if (!info) return false

    const supports = Array.isArray(info.capabilities)
      ? info.capabilities.includes('thinking')
      : false
    this.thinkingCache.set(model, supports)
    return supports
  }

  /**
   * The num_ctx to request for the active model: the model's own max context,
   * fetched from /api/show (`<arch>.context_length`), with a fallback when it
   * isn't reported. Without an explicit num_ctx Ollama defaults to 4096 — small
   * enough that Wolffish's system prompt fills the whole window and the model
   * can emit only one token before a `done_reason: "length"` stop (which the
   * agent loop then mistakes for output truncation and retries forever).
   * Running at the model's real max means the prompt fits with room to answer.
   * Cached per model (stable for the session so Ollama's KV prefix cache holds).
   */
  async resolveContextWindow(): Promise<number> {
    const model = this.model
    if (!model) return FALLBACK_LOCAL_CONTEXT
    const cached = this.contextCache.get(model)
    if (cached !== undefined) return cached

    const info = await safeShowModel(model, this.endpoint)
    // Couldn't reach Ollama (it's down or still starting up). Return the
    // fallback for THIS call but DON'T cache it. Caching a down-state value
    // was the bug: a warm fired while Ollama was closed pinned every later
    // turn — and the context meter — to the 16k fallback, because nothing
    // re-queries once the cache holds a value. Leaving it uncached makes the
    // next call (e.g. the turn that actually starts the conversation, or the
    // capabilities probe) re-hit /api/show and pick up the model's real window.
    if (!info) return FALLBACK_LOCAL_CONTEXT

    // Reached Ollama: the answer is authoritative, so cache it. A real trained
    // context_length, or the fallback when the model genuinely doesn't report
    // one — both are deterministic, so the cached num_ctx stays stable across
    // turns (Ollama reuses its KV prefix only while num_ctx is unchanged).
    const trained = readContextLength(info)
    const window = trained && trained > 0 ? trained : FALLBACK_LOCAL_CONTEXT
    this.contextCache.set(model, window)
    return window
  }

  /**
   * Last resolved context window for the active model, or null if it hasn't
   * been queried yet. Lets the synchronous Thalamus budget getters reflect the
   * real local window once the cache is warm, without forcing them async.
   */
  cachedContextWindow(): number | null {
    if (!this.model) return null
    return this.contextCache.get(this.model) ?? null
  }

  async *stream(options: ProviderStreamOptions): AsyncGenerator<StreamChunk> {
    if (!this.model) throw new Error('no local model selected')

    const messages = [
      { role: 'system' as const, content: options.system } as Record<string, unknown>,
      ...toOllamaMessages(options.messages)
    ]

    const numCtx = await this.resolveContextWindow()

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
      options: {
        // num_predict: -1 tells Ollama to generate until the model itself
        // stops or the context window fills. Without this, Ollama applies
        // its default cap (128 tokens) and truncates replies mid-thought.
        num_predict: -1,
        // num_ctx sizes the context window (and the KV cache). Without it,
        // Ollama defaults to 4096 — smaller than our system prompt — so the
        // prompt fills the window and the model can emit only one token
        // before stopping with done_reason "length". See resolveContextWindow.
        num_ctx: numCtx
      },
      // Hold the model (and its KV cache) in memory across tool-loop
      // iterations. The 5-minute default can evict mid-task whenever a
      // single step runs long, forcing a full prefill of the entire
      // conversation on the next call.
      keep_alive: '30m'
    }
    // Ollama reasoning toggle: send `think` only for models that advertise the
    // capability. Binary on/off — off explicitly suppresses thinking output.
    if (await this.supportsThinking()) {
      body.think = thinkingEnabled(options.thinkingMode)
    }
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map(toOllamaTool)
    }

    const response = await fetch(new URL('/api/chat', this.endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: options.signal
    })

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '')
      throw new Error(`ollama chat failed: HTTP ${response.status} ${text}`.trim())
    }

    let inputTokens = 0
    let outputTokens = 0
    let stopReason: StopReason = 'end_turn'

    for await (const line of readNDJSON(response.body)) {
      let parsed: OllamaChunk
      try {
        parsed = JSON.parse(line) as OllamaChunk
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        yield {
          type: 'error',
          message: `ollama stream parse failed: ${detail}`,
          recoverable: false
        }
        return
      }
      if (parsed.error) throw new Error(parsed.error)

      const content = parsed.message?.content
      if (typeof content === 'string' && content.length > 0) {
        yield { type: 'text', text: content }
      }

      const toolCalls = parsed.message?.tool_calls
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          const name = tc.function?.name
          if (!name) continue
          const args =
            typeof tc.function?.arguments === 'string'
              ? safeParseJSON(tc.function.arguments)
              : (tc.function?.arguments ?? {})
          yield {
            type: 'tool_call',
            id: tc.id ?? generateToolId(),
            name,
            args: args ?? {}
          }
        }
      }

      if (parsed.done) {
        if (typeof parsed.eval_count === 'number') outputTokens = parsed.eval_count
        if (typeof parsed.prompt_eval_count === 'number') inputTokens = parsed.prompt_eval_count
        stopReason = parsed.done_reason === 'length' ? 'max_tokens' : 'end_turn'
      }
    }

    yield { type: 'turn_meta', stopReason, usage: { inputTokens, outputTokens } }
  }
}

export const localProvider = new LocalProvider()

type OllamaChunk = {
  message?: {
    role?: string
    content?: string
    tool_calls?: Array<{
      id?: string
      function?: { name?: string; arguments?: string | Record<string, unknown> }
    }>
  }
  error?: string
  done?: boolean
  done_reason?: string
  eval_count?: number
  prompt_eval_count?: number
}

function toOllamaTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }
}

export function toOllamaMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      const { inline, omitted } = selectInlineImages(m.images ?? [], m.toolName, true)
      const msg: Record<string, unknown> = {
        role: 'tool',
        content: omitted > 0 ? m.content + inlineOmittedNote(omitted) : m.content,
        tool_name: m.toolName
      }
      if (inline.length > 0) {
        msg.images = inline.map((img) => img.data)
      }
      out.push(msg)
      continue
    }
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        out.push({ role: 'user', content: m.content })
      } else {
        const texts: string[] = []
        const images: string[] = []
        for (const block of m.content) {
          if (block.type === 'text') texts.push(block.text)
          else if (block.type === 'image') images.push(block.data)
          else if (block.type === 'document') texts.push('[PDF document attached]')
        }
        const msg: Record<string, unknown> = { role: 'user', content: texts.join('\n') }
        if (images.length > 0) msg.images = images
        out.push(msg)
      }
      continue
    }
    if (m.toolUses && m.toolUses.length > 0) {
      out.push({
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolUses.map((use) => ({
          function: {
            name: use.name,
            arguments: use.args
          }
        }))
      })
    } else {
      out.push({ role: 'assistant', content: m.content })
    }
  }
  return out
}

function safeParseJSON(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function generateToolId(): string {
  return `tool_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Pull `<arch>.context_length` out of an /api/show model_info bag. Ollama keys
 * it by architecture family (e.g. `gemma4.context_length`,
 * `llama.context_length`), so we scan for any *.context_length entry.
 */
function readContextLength(info: OllamaShowResponse | null): number | null {
  const mi = info?.model_info
  if (!mi) return null
  // The text model's context_length, not a sub-encoder's (gemma's audio/vision
  // towers carry their own `*.context_length`).
  for (const [key, value] of Object.entries(mi)) {
    if (
      key.endsWith('.context_length') &&
      !key.includes('.vision.') &&
      !key.includes('.audio.') &&
      typeof value === 'number'
    ) {
      return value
    }
  }
  return null
}

/**
 * /api/show that never throws: any failure (Ollama down, HTTP error, bad JSON)
 * resolves to null. A null return means "couldn't determine" — callers use it to
 * decide whether to cache. A real response (even one missing a field) is
 * authoritative and cacheable; a null is transient and must NOT be cached, or a
 * probe made while Ollama is down would pin a wrong answer for the whole session.
 */
async function safeShowModel(model: string, endpoint: string): Promise<OllamaShowResponse | null> {
  try {
    return await showModel(model, endpoint)
  } catch {
    return null
  }
}

function isLikelyVisionByName(model: string): boolean {
  return /vision|-vl|multimodal|llava|moondream|bakllava|gemma3|llama3\.2-vision/i.test(model)
}

async function* readNDJSON(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx = buffer.indexOf('\n')
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line) yield line
        idx = buffer.indexOf('\n')
      }
    }
    const tail = buffer.trim()
    if (tail) yield tail
  } finally {
    reader.releaseLock()
  }
}
