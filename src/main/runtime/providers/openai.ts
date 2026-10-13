import type { Corpus } from '@main/runtime/corpus'
import type {
  ChatMessage,
  ProviderStreamOptions,
  StopReason,
  StreamChunk,
  ToolDefinition,
  UserContentBlock
} from '@main/runtime/thalamus'
import {
  normalizeReasoningMode,
  reasoningModesFor,
  type ReasoningMode
} from '@main/runtime/reasoning'
import { openaiResponsesToolContent } from '@main/runtime/tool-images'

// Responses API, not chat/completions. Verified live 2026-10-12: on
// chat/completions gpt-6-astra and gpt-6.1-sol refuse function tools
// outright, and every other gpt-5.4+/5.6/6 model only accepts tools with
// reasoning_effort:none — so the agent loop would run every tool turn with
// reasoning off. Responses takes tools + any effort on all of them, streams
// reasoning summaries, and accepts the top 'max' rung that chat/completions
// 400s on.
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/responses'

/**
 * Per-model output ceiling, as reported by the API itself
 * ("This model supports at most N completion tokens", 2026-10-12). We ask
 * for the full ceiling — cost is irrelevant; a reply must never be
 * truncated by a conservative cap. thalamus reserves this much of the
 * context window for output, so it must stay the single source of truth.
 */
export function openaiMaxOutputTokens(model: string): number {
  const m = model.toLowerCase()
  if (m.startsWith('gpt-6') || m.startsWith('gpt-5') || m.startsWith('chat-latest')) return 128_000
  if (/^o[134]/.test(m)) return 100_000
  if (m.startsWith('gpt-4.1')) return 32_768
  if (m.startsWith('gpt-4o')) return 16_384
  if (m.startsWith('gpt-4-turbo')) return 4_096
  if (m.startsWith('gpt-4')) return 4_096
  return 16_384
}

// The top effort rung differs per family (all verified live on
// /v1/responses): gpt-6* and gpt-5.6* take 'max'; gpt-5.2/5.4/5.5 stop at
// 'xhigh' and 400 on 'max'; gpt-5/5.1/o-series stop at 'high'.
function topEffort(model: string): 'max' | 'xhigh' | 'high' {
  const m = model.toLowerCase()
  if (m.startsWith('gpt-6') || m.startsWith('gpt-5.6')) return 'max'
  if (/^gpt-5\.[245]/.test(m)) return 'xhigh'
  return 'high'
}

/**
 * Canonical mode → `reasoning.effort`. Null when the model takes no
 * reasoning field at all (gpt-4.x, gpt-4o, chat-latest 400 on its mere
 * presence). thalamus clamps `thinkingMode` to the model's registry, and
 * the clamp is repeated here (as xai.ts does) so a caller that skips it
 * can't send 'none' to an always-on model and 400 the turn. 'on' is the
 * provider default (medium) — the always-on models' lowest exposed setting.
 */
function responsesEffort(model: string, mode: ReasoningMode | undefined): string | null {
  const modes = reasoningModesFor('openai', model)
  if (modes.length === 0) return null
  switch (normalizeReasoningMode(mode, modes)) {
    case 'off':
      return 'none'
    case 'on':
      return 'medium'
    case 'max':
      return topEffort(model)
    case 'high':
    default:
      return 'high'
  }
}

export class OpenAIProvider {
  constructor(
    private apiKey: string,
    private model: string,
    private endpoint: string = OPENAI_ENDPOINT,
    private corpus: Corpus | null = null
  ) {}

  async *stream(options: ProviderStreamOptions): AsyncGenerator<StreamChunk> {
    const body: Record<string, unknown> = {
      model: this.model,
      instructions: options.system,
      input: toResponsesInput(options.messages),
      stream: true,
      store: false,
      max_output_tokens: openaiMaxOutputTokens(this.model)
    }
    // Cache-shard routing hint. Agentic loops exceed ~15 req/min on one
    // prefix, which overflows to machines with cold caches; a stable
    // per-conversation key keeps the task on its warm shard.
    if (options.cacheKey) {
      body.prompt_cache_key = options.cacheKey
    }
    const effort = responsesEffort(this.model, options.thinkingMode)
    if (effort) {
      // summary:auto streams the model's reasoning summary as it thinks —
      // the only reasoning text OpenAI exposes; raw chain-of-thought stays
      // server-side.
      body.reasoning = { effort, summary: 'auto' }
    }
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map(toResponsesTool)
    }

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: options.signal
    })

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '')
      throw new Error(`openai responses failed: HTTP ${response.status} ${text}`.trim())
    }

    let stopReason: StopReason = 'unknown'
    let sawToolCall = false
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0

    const applyUsage = (usage: ResponsesUsage | undefined): void => {
      if (!usage) return
      if (typeof usage.input_tokens === 'number') inputTokens = usage.input_tokens
      if (typeof usage.output_tokens === 'number') outputTokens = usage.output_tokens
      // input_tokens is inclusive of cache hits. Separate them so the cost
      // formula can apply the cached-input rate (Anthropic convention:
      // inputTokens = uncached only).
      const cached = usage.input_tokens_details?.cached_tokens
      if (typeof cached === 'number' && cached > 0) {
        cacheReadTokens = cached
        inputTokens = inputTokens - cached
      }
    }

    for await (const event of readSSE(response.body)) {
      if (!event.data) continue

      let parsed: ResponsesEvent
      try {
        parsed = JSON.parse(event.data) as ResponsesEvent
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        yield {
          type: 'error',
          message: `openai stream parse failed: ${detail}`,
          recoverable: false
        }
        return
      }

      switch (parsed.type) {
        case 'response.output_text.delta':
          if (typeof parsed.delta === 'string' && parsed.delta.length > 0) {
            yield { type: 'text', text: parsed.delta }
          }
          break
        case 'response.reasoning_summary_text.delta':
          if (typeof parsed.delta === 'string' && parsed.delta.length > 0) {
            yield { type: 'reasoning', text: parsed.delta }
          }
          break
        // Arguments stream as deltas too, but the done item carries the
        // complete string — one authoritative source beats reassembly.
        case 'response.output_item.done': {
          const item = parsed.item
          if (item?.type === 'function_call' && item.name) {
            sawToolCall = true
            const args = item.arguments ? safeParseJSON(item.arguments) : {}
            yield {
              type: 'tool_call',
              id: item.call_id ?? item.id ?? generateToolId(),
              name: item.name,
              args: args ?? {}
            }
          }
          break
        }
        case 'response.completed':
          applyUsage(parsed.response?.usage)
          stopReason = sawToolCall ? 'tool_use' : 'end_turn'
          break
        case 'response.incomplete':
          applyUsage(parsed.response?.usage)
          stopReason =
            parsed.response?.incomplete_details?.reason === 'max_output_tokens'
              ? 'max_tokens'
              : sawToolCall
                ? 'tool_use'
                : 'end_turn'
          break
        case 'response.failed': {
          applyUsage(parsed.response?.usage)
          const message = parsed.response?.error?.message ?? 'response failed'
          this.corpus?.emit('llm.error', { provider: 'openai', error: message })
          yield { type: 'error', message: `openai: ${message}`, recoverable: false }
          return
        }
        case 'error': {
          const message = parsed.message ?? parsed.error?.message ?? 'stream error'
          this.corpus?.emit('llm.error', { provider: 'openai', error: message })
          yield { type: 'error', message: `openai: ${message}`, recoverable: false }
          return
        }
        default:
          break
      }
    }

    yield {
      type: 'turn_meta',
      stopReason,
      usage: { inputTokens, outputTokens, cacheReadTokens: cacheReadTokens || undefined }
    }
  }
}

type ResponsesUsage = {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  output_tokens_details?: { reasoning_tokens?: number }
}

type ResponsesEvent = {
  type: string
  delta?: string
  item?: {
    type?: string
    id?: string
    call_id?: string
    name?: string
    arguments?: string
  }
  response?: {
    status?: string
    usage?: ResponsesUsage
    incomplete_details?: { reason?: string }
    error?: { message?: string }
  }
  // `error` events carry the message at the top level; some wrap it.
  message?: string
  error?: { message?: string }
}

function toResponsesTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false
  }
}

function userContentToResponses(content: string | UserContentBlock[]): string | unknown[] {
  if (typeof content === 'string') return content
  if (content.length === 1 && content[0].type === 'text') return content[0].text
  const parts: unknown[] = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'input_text', text: block.text })
    } else if (block.type === 'image') {
      parts.push({
        type: 'input_image',
        image_url: `data:${block.mediaType};base64,${block.data}`,
        detail: 'auto'
      })
    } else if (block.type === 'document') {
      parts.push({
        type: 'input_file',
        filename: 'document.pdf',
        file_data: `data:${block.mediaType};base64,${block.data}`
      })
    }
  }
  return parts
}

/**
 * History → Responses `input` items. The system prompt travels as
 * `instructions`, so system messages are skipped here. Tool calls become
 * standalone `function_call` items keyed by call_id, and tool results
 * `function_call_output` items — the call_id is the only link between
 * them, so it must round-trip the id the model (or any provider the
 * conversation ran on before) issued.
 */
function toResponsesInput(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      out.push({
        type: 'function_call_output',
        call_id: m.toolUseId,
        output: openaiResponsesToolContent(m.content, m.images, m.toolName)
      })
      continue
    }
    if (m.role === 'user') {
      out.push({ role: 'user', content: userContentToResponses(m.content) })
      continue
    }
    if (m.content && m.content.length > 0) {
      out.push({ role: 'assistant', content: m.content })
    }
    for (const use of m.toolUses ?? []) {
      out.push({
        type: 'function_call',
        call_id: use.id,
        name: use.name,
        arguments: JSON.stringify(use.args)
      })
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
  return `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

async function* readSSE(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx = buffer.indexOf('\n\n')
      while (idx >= 0) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        let event = 'message'
        const dataLines: string[] = []
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
        }
        const data = dataLines.join('\n')
        yield { event, data }
        idx = buffer.indexOf('\n\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export type { ChatMessage }
