import type { Corpus } from '@main/runtime/corpus'
import type {
  ChatMessage,
  ProviderStreamOptions,
  StopReason,
  StreamChunk,
  ToolDefinition,
  UserContentBlock
} from '@main/runtime/thalamus'
import { effortFromMode } from '@main/runtime/reasoning'
import { openaiCompatToolContent } from '@main/runtime/tool-images'

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions'

// Per-model output ceilings — the highest value the API accepts for each
// family. Cost is irrelevant; we never want a reply truncated by a
// conservative cap.
function maxTokensFor(model: string): number {
  const m = model.toLowerCase()
  if (m.startsWith('gpt-5')) return 65536
  if (m.startsWith('gpt-4.1')) return 32768
  if (m.startsWith('gpt-4o')) return 16384
  if (m.startsWith('o4')) return 65536
  if (m.startsWith('o3')) return 65536
  if (m.startsWith('o1-mini')) return 32768
  if (m.startsWith('o1')) return 32768
  if (m.startsWith('gpt-4-turbo')) return 4096
  if (m.startsWith('gpt-4')) return 8192
  if (m.startsWith('gpt-3.5')) return 4096
  return 16384
}

// Reasoning models (o-series, gpt-5) require `max_completion_tokens` and
// reject the legacy `max_tokens` field. Older chat models still take
// `max_tokens`. Detection is by model-name prefix.
function isReasoningModel(model: string): boolean {
  return /^(o1|o3|o4|gpt-5)/i.test(model)
}

export class OpenAIProvider {
  constructor(
    private apiKey: string,
    private model: string,
    private endpoint: string = OPENAI_ENDPOINT,
    private corpus: Corpus | null = null
  ) {}

  async *stream(options: ProviderStreamOptions): AsyncGenerator<StreamChunk> {
    const messages = [
      { role: 'system' as const, content: options.system } as Record<string, unknown>,
      ...toOpenAIMessages(options.messages)
    ]

    const maxOutput = maxTokensFor(this.model)
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
      // Ask OpenAI to append a final usage chunk so we can populate
      // turn_meta with API-reported token counts instead of guessing.
      stream_options: { include_usage: true }
    }
    // Cache-shard routing hint. Agentic loops exceed ~15 req/min on one
    // prefix, which overflows to machines with cold caches; a stable
    // per-conversation key keeps the task on its warm shard.
    if (options.cacheKey) {
      body.prompt_cache_key = options.cacheKey
    }
    if (isReasoningModel(this.model)) {
      body.max_completion_tokens = maxOutput

      // OpenAI reasoning: reasoning_effort controls depth.
      // off → 'none' (disabled), high → 'high', max → 'xhigh' (maximum).
      const effort = effortFromMode(options.thinkingMode)
      body.reasoning_effort = effort === 'off' ? 'none' : effort === 'max' ? 'xhigh' : 'high'
    } else {
      body.max_tokens = maxOutput
    }
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map(toOpenAITool)
    }

    if (body.tools && body.reasoning_effort) {
      delete body.reasoning_effort
      this.corpus?.emit('llm.reasoning_effort.stripped', {
        model: this.model,
        reason: 'tools present'
      })
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
      throw new Error(`openai chat failed: HTTP ${response.status} ${text}`.trim())
    }

    type ToolBuffer = { id: string; name: string; argsBuffer: string }
    const tools = new Map<number, ToolBuffer>()
    let stopReason: StopReason = 'unknown'
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0

    for await (const event of readSSE(response.body)) {
      if (!event.data) continue
      if (event.data === '[DONE]') break

      let parsed: OpenAIEvent
      try {
        parsed = JSON.parse(event.data) as OpenAIEvent
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        yield {
          type: 'error',
          message: `openai stream parse failed: ${detail}`,
          recoverable: false
        }
        return
      }

      if (parsed.usage) {
        if (typeof parsed.usage.prompt_tokens === 'number') inputTokens = parsed.usage.prompt_tokens
        if (typeof parsed.usage.completion_tokens === 'number')
          outputTokens = parsed.usage.completion_tokens
        // OpenAI reports cached tokens inside prompt_tokens (inclusive).
        // Separate them so the cost formula can apply the 50% discount.
        const cached = parsed.usage.prompt_tokens_details?.cached_tokens
        if (typeof cached === 'number' && cached > 0) {
          cacheReadTokens = cached
          inputTokens = inputTokens - cached // uncached only, matching Anthropic convention
        }
      }

      const choice = parsed.choices?.[0]
      if (!choice) continue
      const delta = choice.delta

      if (delta) {
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          yield { type: 'reasoning', text: delta.reasoning_content }
        }
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          yield { type: 'text', text: delta.content }
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            const idx = call.index ?? 0
            let buf = tools.get(idx)
            if (!buf) {
              buf = { id: call.id ?? generateToolId(), name: '', argsBuffer: '' }
              tools.set(idx, buf)
            }
            if (call.id) buf.id = call.id
            if (call.function?.name) buf.name = call.function.name
            if (typeof call.function?.arguments === 'string') {
              buf.argsBuffer += call.function.arguments
            }
          }
        }
      }

      const finish = choice.finish_reason
      if (finish === 'tool_calls' || finish === 'stop' || finish === 'length') {
        for (const buf of tools.values()) {
          if (!buf.name) continue
          const args = buf.argsBuffer.length > 0 ? safeParseJSON(buf.argsBuffer) : {}
          yield { type: 'tool_call', id: buf.id, name: buf.name, args: args ?? {} }
        }
        tools.clear()
        stopReason = mapFinishReason(finish)
      } else if (typeof finish === 'string' && finish.length > 0) {
        stopReason = mapFinishReason(finish)
      }
    }

    yield {
      type: 'turn_meta',
      stopReason,
      usage: { inputTokens, outputTokens, cacheReadTokens: cacheReadTokens || undefined }
    }
  }
}

function mapFinishReason(s: string): StopReason {
  switch (s) {
    case 'stop':
      return 'end_turn'
    case 'tool_calls':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return 'end_turn'
    default:
      return 'unknown'
  }
}

type OpenAIEvent = {
  choices?: Array<{
    delta?: {
      reasoning_content?: string
      content?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

function toOpenAITool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }
}

function userContentToOpenAI(content: string | UserContentBlock[]): string | unknown[] {
  if (typeof content === 'string') return content
  const parts: unknown[] = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${block.mediaType};base64,${block.data}` }
      })
    } else if (block.type === 'document') {
      parts.push({
        type: 'file',
        file: {
          filename: 'document.pdf',
          file_data: `data:${block.mediaType};base64,${block.data}`
        }
      })
    }
  }
  if (parts.length === 1 && (content[0] as UserContentBlock).type === 'text') {
    return (content[0] as Extract<UserContentBlock, { type: 'text' }>).text
  }
  return parts
}

function toOpenAIMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: m.toolUseId,
        content: openaiCompatToolContent(m.content, m.images, m.toolName)
      })
      continue
    }
    if (m.role === 'user') {
      out.push({ role: 'user', content: userContentToOpenAI(m.content) })
      continue
    }
    if (m.toolUses && m.toolUses.length > 0) {
      out.push({
        role: 'assistant',
        content: m.content && m.content.length > 0 ? m.content : null,
        tool_calls: m.toolUses.map((use) => ({
          id: use.id,
          type: 'function',
          function: {
            name: use.name,
            arguments: JSON.stringify(use.args)
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
