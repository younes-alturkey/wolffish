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

const XAI_ENDPOINT = 'https://api.x.ai/v1/chat/completions'

function maxTokensFor(model: string): number {
  const m = model.toLowerCase()
  if (m.includes('grok-4.3') || m.includes('grok-4.20')) return 65536
  if (m.includes('grok-4')) return 65536
  if (m.includes('grok-build')) return 65536
  if (m.includes('grok-3')) return 65536
  return 65536
}

// Verified live 2026-08-13 by sweeping the enum on every catalogue model.
// reasoning_effort is a FIVE-rung ladder — minimal|low|medium|high|xhigh —
// and the enum is strictly validated (unknown values 400). 'max' is NOT one
// of its values; xhigh is the top rung.
//   grok-4.6 / grok-4.5  ladder minus 'none' (400s on 'none' and 'max')
//   grok-4.3             full ladder including 'none'
//   grok-3-mini          legacy line, no longer in the catalogue
//   grok-4.20-* / grok-build  400 ("does not support reasoningEffort") if the
//                        param is sent at all — always-on, no knob
//   -non-reasoning variants don't reason at all.
function supportsReasoningEffort(model: string): boolean {
  const m = model.toLowerCase()
  return (
    m.includes('grok-4.6') ||
    m.includes('grok-4.5') ||
    m.includes('grok-4.3') ||
    m.includes('grok-3-mini')
  )
}

/** Models whose ladder has no 'none' rung — reasoning cannot be switched off. */
function alwaysOnEffort(model: string): boolean {
  const m = model.toLowerCase()
  return m.includes('grok-4.6') || m.includes('grok-4.5')
}

/** Canonical modes that mean "the high rung" (incl. the legacy token). */
const HIGH_TOKENS = new Set(['high', 'extended'])

/**
 * Canonical reasoning mode → xAI wire effort. The canonical scale's three
 * on-rungs land on low / high / xhigh. `thinkingMode` arrives already clamped
 * to the model's registry entry, so 'off' only reaches a model that has a
 * 'none' rung — but always-on models fall back to their lowest real rung
 * rather than 400 if an un-normalized 'off' ever slips through.
 */
function xaiEffort(mode: string | undefined, alwaysOn: boolean): string {
  const effort = effortFromMode(mode)
  if (effort === 'off') return alwaysOn ? 'low' : 'none'
  if (effort === 'max') return 'xhigh'
  // effortFromMode collapses 'on' and 'high' into one bucket — split them back
  // apart so the middle rung of the canonical scale survives onto the wire.
  return mode == null || HIGH_TOKENS.has(mode) ? 'high' : 'low'
}

function reasons(model: string): boolean {
  const m = model.toLowerCase()
  if (m.includes('non-reasoning')) return false
  return supportsReasoningEffort(m) || m.includes('grok-build') || /^grok-4/.test(m)
}

export class XAIProvider {
  constructor(
    private apiKey: string,
    private model: string,
    private endpoint: string = XAI_ENDPOINT
  ) {}

  async *stream(options: ProviderStreamOptions): AsyncGenerator<StreamChunk> {
    const messages = [
      { role: 'system' as const, content: options.system } as Record<string, unknown>,
      ...toXAIMessages(options.messages)
    ]

    const maxOutput = maxTokensFor(this.model)
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
      stream_options: { include_usage: true }
    }

    if (reasons(this.model)) {
      body.max_completion_tokens = maxOutput
      if (supportsReasoningEffort(this.model)) {
        body.reasoning_effort = xaiEffort(options.thinkingMode, alwaysOnEffort(this.model))
      }
    } else {
      body.max_tokens = maxOutput
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map(toXAITool)
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
      throw new Error(`xai chat failed: HTTP ${response.status} ${text}`.trim())
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

      let parsed: XAIEvent
      try {
        parsed = JSON.parse(event.data) as XAIEvent
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        yield {
          type: 'error',
          message: `xai stream parse failed: ${detail}`,
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

type XAIEvent = {
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

function toXAITool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }
}

function userContentToXAI(content: string | UserContentBlock[]): string | unknown[] {
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

export function toXAIMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
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
      out.push({ role: 'user', content: userContentToXAI(m.content) })
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
