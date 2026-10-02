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

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'

function maxTokensFor(model: string): number {
  const m = model.toLowerCase()
  if (m.includes('claude-opus') || m.includes('claude-sonnet')) return 32768
  if (m.includes('gpt-5')) return 65536
  if (m.includes('gpt-4o')) return 16384
  if (m.includes('gpt-4.1')) return 32768
  if (m.includes('/o4') || m.includes('/o3') || m.startsWith('o4') || m.startsWith('o3'))
    return 65536
  if (m.includes('deepseek')) return 32768
  if (m.includes('grok')) return 32768
  if (m.includes('gemini')) return 65536
  if (m.includes('llama')) return 16384
  if (m.includes('qwen')) return 32768
  if (m.includes('mistral')) return 32768
  return 16384
}

function isReasoningModel(model: string): boolean {
  return /^(openai\/o[134]|openai\/gpt-5|deepseek\/deepseek-r|google\/gemini.*thinking|anthropic\/claude.*opus)/i.test(
    model
  )
}

// These OpenRouter endpoints reason mandatorily — reasoning_effort:'none' (and
// reasoning:{enabled:false}) return HTTP 400 "Reasoning is mandatory ... cannot
// be disabled". For "off" we send the minimum 'low' instead of disabling.
// Verified live: openai/gpt-5* and o-series + deepseek-r are mandatory.
function reasoningMandatory(model: string): boolean {
  return /^(openai\/(o[134]|gpt-5)|deepseek\/deepseek-r)/i.test(model)
}

export class OpenRouterProvider {
  private reasoningSet: Set<string>

  constructor(
    private apiKey: string,
    private model: string,
    private endpoint: string = OPENROUTER_ENDPOINT,
    reasoningModels?: string[]
  ) {
    this.reasoningSet = new Set(reasoningModels ?? [])
  }

  private supportsReasoning(): boolean {
    if (this.reasoningSet.has(this.model)) return true
    return isReasoningModel(this.model)
  }

  async *stream(options: ProviderStreamOptions): AsyncGenerator<StreamChunk> {
    // Anthropic models honor per-block cache_control passed through
    // OpenRouter (verbatim Anthropic syntax), so the stable system prefix
    // gets an explicit breakpoint with the volatile <runtime> block split
    // off — mirroring the direct-Anthropic provider. Message-level
    // breakpoints are not sent: OpenRouter's pass-through for tool-role
    // content parts is undocumented, and a misplace would silently disable
    // caching. Other models rely on byte-stable prefixes (automatic).
    const systemContent = this.model.startsWith('anthropic/')
      ? buildCachedSystemParts(options.system)
      : options.system
    const messages = [
      { role: 'system' as const, content: systemContent } as Record<string, unknown>,
      ...toOpenRouterMessages(options.messages)
    ]

    const maxOutput = maxTokensFor(this.model)
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
      stream_options: { include_usage: true }
    }

    if (this.supportsReasoning()) {
      body.max_completion_tokens = maxOutput
      const effort = effortFromMode(options.thinkingMode)
      const isAnthropic = this.model.startsWith('anthropic/')

      if (effort === 'off') {
        if (isAnthropic) {
          // Anthropic via OpenRouter: no reasoning object = thinking disabled
        } else {
          body.reasoning_effort = reasoningMandatory(this.model) ? 'low' : 'none'
        }
      } else {
        // OpenRouter normalises effort to low|medium|high; high and max both
        // resolve to 'high' (the routed model can't expose a distinct max here).
        if (isAnthropic) {
          body.reasoning = { effort: 'high' }
        } else {
          body.reasoning_effort = 'high'
        }
        body.include_reasoning = true
      }
    } else {
      body.max_tokens = maxOutput
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map(toOpenRouterTool)
    }

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        'HTTP-Referer': 'https://wolffish.app',
        'X-Title': 'Wolffish'
      },
      body: JSON.stringify(body),
      signal: options.signal
    })

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '')
      throw new Error(`openrouter chat failed: HTTP ${response.status} ${text}`.trim())
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

      let parsed: OpenRouterEvent
      try {
        parsed = JSON.parse(event.data) as OpenRouterEvent
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        yield {
          type: 'error',
          message: `openrouter stream parse failed: ${detail}`,
          recoverable: false
        }
        return
      }

      if (parsed.usage) {
        if (typeof parsed.usage.prompt_tokens === 'number') inputTokens = parsed.usage.prompt_tokens
        if (typeof parsed.usage.completion_tokens === 'number')
          outputTokens = parsed.usage.completion_tokens
        const cached = parsed.usage.prompt_tokens_details?.cached_tokens
        if (typeof cached === 'number' && cached > 0) {
          cacheReadTokens = cached
          inputTokens = inputTokens - cached
        }
      }

      const choice = parsed.choices?.[0]
      if (!choice) continue
      const delta = choice.delta

      if (delta) {
        const reasoningText = delta.reasoning_content ?? delta.reasoning
        if (typeof reasoningText === 'string' && reasoningText.length > 0) {
          yield { type: 'reasoning', text: reasoningText }
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

type OpenRouterEvent = {
  choices?: Array<{
    delta?: {
      reasoning_content?: string
      reasoning?: string
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

/**
 * Split the system prompt so the stable prefix carries an explicit cache
 * breakpoint and the volatile `<runtime>` block stays uncached — the same
 * scheme as the direct Anthropic provider, in OpenAI content-part form.
 */
function buildCachedSystemParts(system: string): unknown[] {
  const marker = '<runtime>'
  const idx = system.lastIndexOf(marker)
  if (idx > 0) {
    return [
      { type: 'text', text: system.slice(0, idx).trimEnd(), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: system.slice(idx) }
    ]
  }
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
}

function toOpenRouterTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }
}

function userContentToOpenRouter(content: string | UserContentBlock[]): string | unknown[] {
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

function toOpenRouterMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
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
      out.push({ role: 'user', content: userContentToOpenRouter(m.content) })
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
