import type {
  ChatMessage,
  ProviderStreamOptions,
  StopReason,
  StreamChunk,
  ToolDefinition,
  UserContentBlock
} from '@main/runtime/thalamus'
import { effortFromMode } from '@main/runtime/reasoning'
import { anthropicToolContent } from '@main/runtime/tool-images'

const ANTHROPIC_VERSION = '2023-06-01'
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages'

// Per-model output ceilings — the highest value the API accepts for each
// family. Cost is irrelevant; the goal is to never have a turn truncated
// by max_tokens that the model itself wouldn't have ended.
function maxTokensFor(model: string): number {
  const m = model.toLowerCase()
  if (m.includes('fable')) return 128000
  if (m.includes('opus-4')) return 32000
  if (m.includes('sonnet-4')) return 64000
  if (m.includes('haiku-4')) return 8192
  if (m.includes('3-7-sonnet') || m.includes('3.7-sonnet')) return 64000
  if (m.includes('3-5-sonnet') || m.includes('3.5-sonnet')) return 8192
  if (m.includes('3-5-haiku') || m.includes('3.5-haiku')) return 8192
  if (m.includes('opus')) return 4096
  if (m.includes('sonnet')) return 8192
  if (m.includes('haiku')) return 4096
  return 16384
}

/**
 * Cache breakpoint marker. The 1h TTL costs 2x base on writes (vs 1.25x
 * for the 5m default) but keeps the prefix warm through tasks whose
 * individual steps outlast five minutes.
 */
export type AnthropicCacheControl = { type: 'ephemeral'; ttl?: '1h' }

export class AnthropicProvider {
  constructor(
    private apiKey: string,
    private model: string,
    private endpoint: string = ANTHROPIC_ENDPOINT,
    private maxTokens: number = maxTokensFor(model),
    private cacheTtl: '5m' | '1h' = '5m'
  ) {}

  async *stream(options: ProviderStreamOptions): AsyncGenerator<StreamChunk> {
    const cc: AnthropicCacheControl =
      this.cacheTtl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' }
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: buildSystemBlocks(options.system, cc),
      messages: toAnthropicMessages(options.messages, cc),
      stream: true
    }

    // Anthropic extended thinking — per-model, verified live:
    //  • Newest models (opus-4-8/4-7, fable) REJECT thinking.type:enabled (HTTP
    //    400); they require thinking.type:adaptive + output_config.effort, and
    //    effort alone (without adaptive) produces no thinking.
    //  • 4-6 and earlier (sonnet-4-6, opus-4-6, opus-4-5/4-1, sonnet-4-5, haiku)
    //    use the classic thinking.type:enabled + budget_tokens (max gets a
    //    larger budget, capped to the model's output ceiling — so small-ceiling
    //    Haiku can't exceed high and is [off, high] in the registry).
    //  • off is thinking.type:disabled on every model.
    const m = this.model.toLowerCase()
    const adaptiveOnly = m.includes('opus-4-8') || m.includes('opus-4-7') || m.includes('fable')
    const effort = effortFromMode(options.thinkingMode)
    if (effort === 'off') {
      body.thinking = { type: 'disabled' }
    } else if (adaptiveOnly) {
      body.thinking = { type: 'adaptive' }
      body.output_config = { effort }
    } else {
      const budget =
        effort === 'max'
          ? Math.min(32768, this.maxTokens - 1024)
          : Math.min(10240, this.maxTokens - 1024)
      body.thinking = { type: 'enabled', budget_tokens: budget }
    }

    if (options.tools && options.tools.length > 0) {
      const tools = options.tools.map(toAnthropicTool)
      ;(tools[tools.length - 1] as Record<string, unknown>).cache_control = cc
      body.tools = tools
    }

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: options.signal
    })

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '')
      throw new Error(`anthropic chat failed: HTTP ${response.status} ${text}`.trim())
    }

    type ToolBlock = { id: string; name: string; jsonBuffer: string }
    const toolBlocks = new Map<number, ToolBlock>()
    let inputTokens = 0
    let outputTokens = 0
    let cacheCreationTokens = 0
    let cacheReadTokens = 0
    let stopReason: StopReason = 'unknown'

    for await (const event of readSSE(response.body)) {
      if (!event.data) continue
      let parsed: AnthropicEvent
      try {
        parsed = JSON.parse(event.data) as AnthropicEvent
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        yield {
          type: 'error',
          message: `anthropic stream parse failed: ${detail}`,
          recoverable: false
        }
        return
      }

      if (parsed.type === 'message_start') {
        const usage = parsed.message?.usage
        if (typeof usage?.input_tokens === 'number') inputTokens = usage.input_tokens
        if (typeof usage?.output_tokens === 'number') outputTokens = usage.output_tokens
        if (typeof usage?.cache_creation_input_tokens === 'number')
          cacheCreationTokens = usage.cache_creation_input_tokens
        if (typeof usage?.cache_read_input_tokens === 'number')
          cacheReadTokens = usage.cache_read_input_tokens
        continue
      }

      if (parsed.type === 'content_block_start' && parsed.content_block) {
        if (parsed.content_block.type === 'tool_use') {
          toolBlocks.set(parsed.index ?? 0, {
            id: parsed.content_block.id ?? generateToolId(),
            name: parsed.content_block.name ?? '',
            jsonBuffer: ''
          })
        }
        continue
      }

      if (parsed.type === 'content_block_delta' && parsed.delta) {
        if (parsed.delta.type === 'thinking_delta' && typeof parsed.delta.thinking === 'string') {
          yield { type: 'reasoning', text: parsed.delta.thinking }
        } else if (parsed.delta.type === 'text_delta' && typeof parsed.delta.text === 'string') {
          yield { type: 'text', text: parsed.delta.text }
        } else if (
          parsed.delta.type === 'input_json_delta' &&
          typeof parsed.delta.partial_json === 'string'
        ) {
          const block = toolBlocks.get(parsed.index ?? 0)
          if (block) block.jsonBuffer += parsed.delta.partial_json
        }
        continue
      }

      if (parsed.type === 'content_block_stop') {
        const block = toolBlocks.get(parsed.index ?? 0)
        if (block && block.name) {
          const args = block.jsonBuffer.length > 0 ? safeParseJSON(block.jsonBuffer) : {}
          yield { type: 'tool_call', id: block.id, name: block.name, args: args ?? {} }
          toolBlocks.delete(parsed.index ?? 0)
        }
        continue
      }

      if (parsed.type === 'message_delta') {
        if (typeof parsed.delta?.stop_reason === 'string') {
          stopReason = mapStopReason(parsed.delta.stop_reason)
        }
        if (typeof parsed.usage?.output_tokens === 'number') {
          outputTokens = parsed.usage.output_tokens
        }
        continue
      }

      if (parsed.type === 'message_stop') {
        yield {
          type: 'turn_meta',
          stopReason,
          usage: { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens }
        }
        continue
      }

      if (parsed.type === 'error') {
        const message = parsed.error?.message ?? 'anthropic stream error'
        throw new Error(message)
      }
    }
  }
}

type AnthropicEvent = {
  type: string
  index?: number
  content_block?: { type?: string; id?: string; name?: string }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    partial_json?: string
    stop_reason?: string
    stop_sequence?: string | null
  }
  error?: { message?: string }
  message?: {
    id?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
  usage?: { input_tokens?: number; output_tokens?: number }
}

function mapStopReason(s: string): StopReason {
  switch (s) {
    case 'end_turn':
      return 'end_turn'
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
      return 'max_tokens'
    case 'stop_sequence':
      return 'stop_sequence'
    default:
      return 'unknown'
  }
}

function toAnthropicTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters
  }
}

type AnthropicMessage = { role: 'user' | 'assistant'; content: string | unknown[] }

/**
 * Always-array form of userContentToAnthropic, for merging a user message
 * into an existing user turn (tool results + a mid-turn message, or two
 * user messages back to back). Empty text yields no block — the API rejects
 * empty text blocks.
 */
function toAnthropicBlocks(content: string | UserContentBlock[]): unknown[] {
  if (typeof content === 'string')
    return content.length > 0 ? [{ type: 'text', text: content }] : []
  const converted = userContentToAnthropic(content)
  return Array.isArray(converted) ? converted : []
}

function userContentToAnthropic(content: string | UserContentBlock[]): string | unknown[] {
  if (typeof content === 'string') return content
  const blocks: unknown[] = []
  for (const block of content) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: block.mediaType, data: block.data }
      })
    } else if (block.type === 'document') {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: block.mediaType, data: block.data }
      })
    }
  }
  return blocks.length === 1 && (content[0] as UserContentBlock).type === 'text'
    ? (content[0] as Extract<UserContentBlock, { type: 'text' }>).text
    : blocks
}

export function toAnthropicMessages(
  messages: ChatMessage[],
  cc: AnthropicCacheControl = { type: 'ephemeral' }
): AnthropicMessage[] {
  // Anthropic requires alternating user/assistant turns. Tool results live
  // inside user-role messages as `tool_result` content blocks. We coalesce
  // consecutive tool messages into a single user turn to keep that invariant.
  const out: AnthropicMessage[] = []
  let pendingToolResults: unknown[] = []
  let volatileText: string | null = null

  const flushToolResults = (): void => {
    if (pendingToolResults.length === 0) return
    out.push({ role: 'user', content: pendingToolResults })
    pendingToolResults = []
  }

  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'user' && m.volatile) {
      // The outbound-only runtime status tail. Held back and appended
      // after breakpoint placement so its per-iteration churn sits
      // strictly after every cache marker.
      volatileText = typeof m.content === 'string' ? m.content : ''
      continue
    }
    if (m.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: m.toolUseId,
        content: anthropicToolContent(m.content, m.images, m.toolName),
        ...(m.isError ? { is_error: true } : {})
      })
      continue
    }
    if (m.role === 'user') {
      // A user message right after tool results is a MID-TURN message (see
      // agent/interjection.ts): it joins the same user turn as those
      // results — tool_result blocks first, then the text — which is the
      // order the API requires and keeps the cached prefix an append. A
      // user message right after another user message (an interjection
      // delivered before the first model call) merges the same way.
      const blocks = toAnthropicBlocks(m.content)
      if (pendingToolResults.length > 0) {
        pendingToolResults.push(...blocks)
        flushToolResults()
        continue
      }
      const last = out[out.length - 1]
      if (last && last.role === 'user') {
        const prev =
          typeof last.content === 'string'
            ? last.content.length > 0
              ? [{ type: 'text', text: last.content }]
              : []
            : last.content
        last.content = [...prev, ...blocks]
        continue
      }
      out.push({ role: 'user', content: userContentToAnthropic(m.content) })
      continue
    }
    flushToolResults()
    // assistant
    if (m.toolUses && m.toolUses.length > 0) {
      const blocks: unknown[] = []
      if (m.content && m.content.length > 0) {
        blocks.push({ type: 'text', text: m.content })
      }
      for (const use of m.toolUses) {
        blocks.push({
          type: 'tool_use',
          id: use.id,
          name: use.name,
          input: use.args
        })
      }
      out.push({ role: 'assistant', content: blocks })
    } else {
      out.push({ role: 'assistant', content: m.content })
    }
  }
  flushToolResults()

  // Moving breakpoint: the final content block of the stable history. Each
  // iteration this extends the cached prefix by exactly the new messages —
  // the previous iteration's entry is found by the API's backward walk
  // (≤20 blocks) and read as a hit, then the extension is written.
  markFinalBlock(out, cc)

  // Anchor breakpoint: the last user turn that precedes at least one more
  // message. Backstop for iterations that append more than the lookback
  // window can cover (e.g. a 15-tool batch), and for cross-turn replay.
  for (let i = out.length - 2; i >= 0; i--) {
    if (out[i].role === 'user') {
      const msg = out[i]
      if (typeof msg.content === 'string') {
        if (msg.content.length > 0) {
          msg.content = [{ type: 'text', text: msg.content, cache_control: cc }]
        }
      } else if (Array.isArray(msg.content) && msg.content.length > 0) {
        const lastBlock = msg.content[msg.content.length - 1] as Record<string, unknown>
        if (!lastBlock.cache_control) lastBlock.cache_control = cc
      }
      break
    }
  }

  // Volatile runtime status renders strictly after every breakpoint. It
  // merges into the trailing user turn (alternation must hold), and blocks
  // after a breakpoint never affect that breakpoint's prefix hash.
  if (volatileText && volatileText.length > 0) {
    appendVolatileText(out, volatileText)
  }

  return out
}

/**
 * Place the moving cache breakpoint on the last non-empty content block.
 * Skips backward over empty messages — Anthropic rejects empty text
 * blocks, so an empty trailing assistant message can't carry the marker.
 */
function markFinalBlock(out: AnthropicMessage[], cc: AnthropicCacheControl): void {
  for (let i = out.length - 1; i >= 0; i--) {
    const msg = out[i]
    if (typeof msg.content === 'string') {
      if (msg.content.length === 0) continue
      msg.content = [{ type: 'text', text: msg.content, cache_control: cc }]
      return
    }
    if (Array.isArray(msg.content) && msg.content.length > 0) {
      ;(msg.content[msg.content.length - 1] as Record<string, unknown>).cache_control = cc
      return
    }
  }
}

function appendVolatileText(out: AnthropicMessage[], text: string): void {
  const last = out[out.length - 1]
  if (last && last.role === 'user') {
    if (typeof last.content === 'string') {
      const blocks: unknown[] =
        last.content.length > 0 ? [{ type: 'text', text: last.content }] : []
      blocks.push({ type: 'text', text })
      last.content = blocks
    } else {
      last.content = [...last.content, { type: 'text', text }]
    }
    return
  }
  out.push({ role: 'user', content: [{ type: 'text', text }] })
}

/**
 * Split the system prompt so the stable prefix gets cached and the volatile
 * `<runtime>` block (which changes every iteration) sits in its own uncached
 * content block. Without this, every iteration invalidates the entire system
 * prompt cache — the single biggest cost driver in agentic loops.
 */
function buildSystemBlocks(
  system: string,
  cc: AnthropicCacheControl = { type: 'ephemeral' }
): unknown[] {
  const marker = '<runtime>'
  const idx = system.lastIndexOf(marker)
  if (idx > 0) {
    const stable = system.slice(0, idx).trimEnd()
    const volatile = system.slice(idx)
    return [
      { type: 'text', text: stable, cache_control: cc },
      { type: 'text', text: volatile }
    ]
  }
  return [{ type: 'text', text: system, cache_control: cc }]
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
  return `toolu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
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
