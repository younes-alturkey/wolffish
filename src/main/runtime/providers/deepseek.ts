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

const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions'

function maxTokensFor(model: string): number {
  const m = model.toLowerCase()
  // `deepseek-flash` (= V4.1-Flash) carries no version number, so match it
  // by name; the retired deepseek-chat / deepseek-reasoner / v4-flash ids
  // all resolve to it server-side.
  if (/^deepseek-(flash|chat|reasoner)$/.test(m)) return 65536
  if (m.includes('v4-pro')) return 65536
  if (m.includes('v4-flash')) return 65536
  return 16384
}

export class DeepSeekProvider {
  constructor(
    private apiKey: string,
    private model: string,
    private endpoint: string = DEEPSEEK_ENDPOINT
  ) {}

  async *stream(options: ProviderStreamOptions): AsyncGenerator<StreamChunk> {
    const messages = [
      { role: 'system' as const, content: options.system } as Record<string, unknown>,
      ...toMessages(options.messages)
    ]

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: maxTokensFor(this.model),
      stream: true,
      stream_options: { include_usage: true }
    }

    // DeepSeek reasoning has TWO knobs that live at DIFFERENT levels:
    //   thinking.type      — master switch (adaptive|enabled|disabled). When
    //                        disabled the model emits zero reasoning no matter
    //                        what effort asks for.
    //   reasoning_effort   — TOP-LEVEL field, enum
    //                        none|minimal|low|medium|high|xhigh|max.
    // Nesting effort inside `thinking` (what we did until 2026-08-13) is
    // silently dropped: `thinking` is strictly validated on `type` — a bad
    // type 400s — but ignores unknown members, so no error was ever raised
    // and the effort control never reached the model. Verified live against
    // deepseek-v4-pro: nested `reasoning_effort: "banana"` returns 200, while
    // the same value top-level 400s with the enum above.
    const effort = effortFromMode(options.thinkingMode)
    if (effort === 'off') {
      body.thinking = { type: 'disabled' }
    } else {
      body.thinking = { type: 'enabled' }
      body.reasoning_effort = effort
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map(toTool)
    }

    const controller = new AbortController()
    let connectionTimedOut = false
    const timer = setTimeout(() => {
      connectionTimedOut = true
      controller.abort()
    }, 180_000)
    if (options.signal) {
      if (options.signal.aborted) {
        clearTimeout(timer)
        controller.abort(options.signal.reason)
      } else {
        options.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            controller.abort(options.signal!.reason)
          },
          { once: true }
        )
      }
    }

    let response: Response
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      clearTimeout(timer)
    } catch (err) {
      clearTimeout(timer)
      if (connectionTimedOut) {
        throw new Error(
          'deepseek: connection timeout — the provider did not respond within 3 minutes'
        )
      }
      throw err
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '')
      throw new Error(`deepseek chat failed: HTTP ${response.status} ${text}`.trim())
    }

    type ToolBuffer = { id: string; name: string; argsBuffer: string }
    const tools = new Map<number, ToolBuffer>()
    let stopReason: StopReason = 'unknown'
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0

    for await (const event of readSSE(response.body, 180_000)) {
      if (!event.data) continue
      if (event.data === '[DONE]') break

      let parsed: DeepSeekEvent
      try {
        parsed = JSON.parse(event.data) as DeepSeekEvent
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        yield {
          type: 'error',
          message: `deepseek stream parse failed: ${detail}`,
          recoverable: false
        }
        return
      }

      if (parsed.usage) {
        if (typeof parsed.usage.prompt_tokens === 'number') inputTokens = parsed.usage.prompt_tokens
        if (typeof parsed.usage.completion_tokens === 'number')
          outputTokens = parsed.usage.completion_tokens
        const cached = parsed.usage.prompt_cache_hit_tokens
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

type DeepSeekEvent = {
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
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
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

function userContentToDeepSeek(content: string | UserContentBlock[]): string | unknown[] {
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
  // DeepSeek (OpenAI-style) rejects the whole request with HTTP 400 if a
  // `tool_call_id` appears more than once, or if a tool result references an
  // id that was never declared. Replayed history can contain such anomalies
  // (e.g. a synthetic install call recorded twice), so we repair the stream
  // here: keep the first declaration/result for each id and drop duplicates
  // and orphans. Well-formed histories pass through unchanged.
  const declaredCallIds = new Set<string>()
  const resultedCallIds = new Set<string>()
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      const id = m.toolUseId
      if (!id || !declaredCallIds.has(id) || resultedCallIds.has(id)) continue
      resultedCallIds.add(id)
      // DeepSeek's API is text-only today, so the thalamus vision gate
      // strips tool images before they reach this encoder — but the day
      // DeepSeek ships a vision model, flipping the vision.ts allowlist is
      // all it takes for screenshots to flow (same shape as every other
      // OpenAI-compat provider here).
      out.push({
        role: 'tool',
        tool_call_id: id,
        content: openaiCompatToolContent(m.content, m.images, m.toolName)
      })
      continue
    }
    if (m.role === 'user') {
      out.push({ role: 'user', content: userContentToDeepSeek(m.content) })
      continue
    }
    if (m.toolUses && m.toolUses.length > 0) {
      const uniqueUses = m.toolUses.filter((use) => {
        if (declaredCallIds.has(use.id)) return false
        declaredCallIds.add(use.id)
        return true
      })
      const msg: Record<string, unknown> =
        uniqueUses.length > 0
          ? {
              role: 'assistant',
              content: m.content && m.content.length > 0 ? m.content : null,
              tool_calls: uniqueUses.map((use) => ({
                id: use.id,
                type: 'function',
                function: {
                  name: use.name,
                  arguments: JSON.stringify(use.args)
                }
              }))
            }
          : // Every tool call was a duplicate — drop the (invalid) empty
            // tool_calls array but keep any text so the turn isn't lost.
            { role: 'assistant', content: m.content && m.content.length > 0 ? m.content : '' }
      if (m.reasoningContent) msg.reasoning_content = m.reasoningContent
      out.push(msg)
    } else {
      const msg: Record<string, unknown> = { role: 'assistant', content: m.content }
      if (m.reasoningContent) msg.reasoning_content = m.reasoningContent
      out.push(msg)
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
  body: ReadableStream<Uint8Array>,
  firstChunkTimeoutMs = 180_000
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let streaming = false

  const readWithTimeout = (): Promise<ReadableStreamReadResult<Uint8Array>> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `deepseek: no data received within ${firstChunkTimeoutMs / 1000}s — aborting stalled request`
            )
          ),
        firstChunkTimeoutMs
      )
      reader.read().then(
        (result) => {
          clearTimeout(timer)
          resolve(result)
        },
        (err) => {
          clearTimeout(timer)
          reject(err)
        }
      )
    })

  try {
    while (true) {
      const { done, value } = streaming ? await reader.read() : await readWithTimeout()
      if (done) break
      streaming = true
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
