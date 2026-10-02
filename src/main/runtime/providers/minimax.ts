import type {
  ChatMessage,
  ProviderStreamOptions,
  StopReason,
  StreamChunk,
  ToolDefinition,
  UserContentBlock
} from '@main/runtime/thalamus'
import { thinkingEnabled } from '@main/runtime/reasoning'
import { openaiCompatToolContent } from '@main/runtime/tool-images'

const MINIMAX_ENDPOINT = 'https://api.minimaxi.chat/v1/chat/completions'

function maxCompletionTokens(model: string): number {
  const m = model.toLowerCase()
  if (m.includes('-m3')) return 65536
  if (m.includes('-m2')) return 65536
  return 16384
}

export class MiniMaxProvider {
  constructor(
    private apiKey: string,
    private model: string,
    private endpoint: string = MINIMAX_ENDPOINT
  ) {}

  async *stream(options: ProviderStreamOptions): AsyncGenerator<StreamChunk> {
    const messages = [
      { role: 'system' as const, content: options.system } as Record<string, unknown>,
      ...toMessages(options.messages)
    ]

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_completion_tokens: maxCompletionTokens(this.model),
      stream: true,
      stream_options: { include_usage: true }
    }

    // MiniMax thinking is binary; reasoning_effort is IGNORED (never sent).
    // 'adaptive' = model decides depth (the on-value), 'disabled' = no thinking.
    if (thinkingEnabled(options.thinkingMode)) {
      body.thinking = { type: 'adaptive' }
    } else {
      body.thinking = { type: 'disabled' }
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map(toTool)
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
      throw new Error(`minimax chat failed: HTTP ${response.status} ${text}`.trim())
    }

    type ToolBuffer = { id: string; name: string; argsBuffer: string }
    const tools = new Map<number, ToolBuffer>()
    let stopReason: StopReason = 'unknown'
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0

    // MiniMax embeds reasoning in <think>...</think> tags within the content
    // field. Some models also provide a separate `delta.reasoning` field.
    let inThink = false

    for await (const event of readSSE(response.body)) {
      if (!event.data) continue
      if (event.data === '[DONE]') break

      let parsed: MiniMaxEvent
      try {
        parsed = JSON.parse(event.data) as MiniMaxEvent
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        yield {
          type: 'error',
          message: `minimax stream parse failed: ${detail}`,
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
        // If the model provides a dedicated reasoning field, use it directly.
        if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) {
          yield { type: 'reasoning', text: delta.reasoning }
        }

        // Process content — strip <think> tags, route to reasoning or text.
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          let content = delta.content

          // Handle <think> open tag
          const openIdx = content.indexOf('<think>')
          if (openIdx >= 0) {
            // Text before <think> is regular text
            const before = content.slice(0, openIdx)
            if (before.length > 0 && !inThink) {
              yield { type: 'text', text: before }
            }
            content = content.slice(openIdx + 7) // skip '<think>'
            inThink = true
          }

          // Handle </think> close tag
          const closeIdx = content.indexOf('</think>')
          if (closeIdx >= 0) {
            // Text before </think> is reasoning (only if no dedicated reasoning field)
            if (!delta.reasoning) {
              const reasoning = content.slice(0, closeIdx).replace(/^\n/, '')
              if (reasoning.length > 0) {
                yield { type: 'reasoning', text: reasoning }
              }
            }
            // Text after </think> is regular text
            const after = content.slice(closeIdx + 8).replace(/^\n/, '') // skip '</think>'
            if (after.length > 0) {
              yield { type: 'text', text: after }
            }
            inThink = false
            continue
          }

          // No tag boundaries in this chunk
          if (inThink) {
            // Inside think block — yield as reasoning only if no dedicated field
            if (!delta.reasoning && content.length > 0) {
              yield { type: 'reasoning', text: content }
            }
          } else {
            // Regular text
            yield { type: 'text', text: content }
          }
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

type MiniMaxEvent = {
  choices?: Array<{
    delta?: {
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
    completion_tokens_details?: { reasoning_tokens?: number }
  }
}

function toTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }
}

function userContentToMiniMax(content: string | UserContentBlock[]): string | unknown[] {
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
    }
  }
  if (parts.length === 1 && (content[0] as UserContentBlock).type === 'text') {
    return (content[0] as Extract<UserContentBlock, { type: 'text' }>).text
  }
  return parts
}

function toMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
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
      out.push({ role: 'user', content: userContentToMiniMax(m.content) })
      continue
    }
    if (m.toolUses && m.toolUses.length > 0) {
      const msg: Record<string, unknown> = {
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
      }
      out.push(msg)
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
