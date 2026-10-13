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
import { wireLogEnabled, wireShape, writeWireLog } from '@main/runtime/providers/wire-log'

// Responses API, not chat/completions. Verified live 2026-10-12: on
// chat/completions gpt-6-astra and gpt-6.1-sol refuse function tools
// outright, and every other gpt-5.4+/5.6/6 model only accepts tools with
// reasoning_effort:none — so the agent loop would run every tool turn with
// reasoning off. Responses takes tools + any effort on all of them, streams
// reasoning summaries, and accepts the top 'max' rung that chat/completions
// 400s on.
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/responses'

// The shared doctrine already asks for a line of prose before each stretch
// of tool work, and DeepSeek/Kimi/Claude follow it; gpt-6.x let a prompt's
// "execute silently" win and ran whole tasks with an empty feed. Restated
// at the very end of the instructions it holds: measured 2026-10-13 on
// gpt-6.1-sol, a progress line on 4/4 tool steps (0/4 without), including
// under a user prompt demanding silence. Static text, so the cached prefix
// is unaffected.
const PROGRESS_NOTES =
  '\n\n<progress_notes>\nThe user watches this conversation live and sees only your visible ' +
  'reply text, never your reasoning or tool calls. Before each batch of tool calls, write one ' +
  'short plain sentence in your visible reply saying what you are about to do (and, after the ' +
  'first step, what the last step turned up). These progress lines are how the app shows ' +
  'work in progress, so they apply even when a task asks for no commentary: that request ' +
  'governs the deliverable and the final message, not these one-line updates. After a ' +
  'tool result, call a different tool or tell the user what you found: never repeat a call ' +
  'whose result you already have.\n</progress_notes>'

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
      instructions:
        options.tools && options.tools.length > 0
          ? options.system + PROGRESS_NOTES
          : options.system,
      input: toResponsesInput(options.messages, this.model),
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
      // store:false keeps nothing server-side, so the model's reasoning is
      // gone by the next call of the tool loop unless the encrypted items
      // ride along. Verified live 2026-10-13 on gpt-6.1-sol: without them
      // it could not recall a value it settled on in its reasoning one tool
      // call earlier (0/4); echoed back, 4/4 — also with a trailing status
      // message after the tool outputs.
      body.include = ['reasoning.encrypted_content']
    }
    if (options.tools && options.tools.length > 0) {
      const universe = options.toolUniverse
      if (universe && universe.length > options.tools.length) {
        // The whole tool list stays byte-stable for the turn and the callable
        // subset moves in tool_choice, which is outside the cached prefix:
        // verified 2026-10-13, changing the allowed set kept 10,497 of 10,500
        // tokens cached and still kept non-allowed tools uncallable. A tool
        // the agent allows but the universe lacks is appended, never dropped.
        const names = new Set(universe.map((t) => t.name))
        const extra = options.tools.filter((t) => !names.has(t.name))
        body.tools = [...universe, ...extra].map(toResponsesTool)
        body.tool_choice = {
          type: 'allowed_tools',
          mode: 'auto',
          tools: options.tools.map((t) => ({ type: 'function', name: t.name }))
        }
      } else {
        body.tools = options.tools.map(toResponsesTool)
      }
    }

    const wire = await wireLogEnabled()
    const startedAt = Date.now()
    const outputShapes: string[] = []
    const logResponse = (status: string, error?: string): void => {
      if (!wire) return
      writeWireLog({
        dir: 'response',
        provider: 'openai',
        model: this.model,
        status,
        output: outputShapes,
        usage: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens },
        durationMs: Date.now() - startedAt,
        ...(error ? { error } : {})
      })
    }
    if (wire) {
      writeWireLog({
        dir: 'request',
        provider: 'openai',
        model: this.model,
        cacheKey: options.cacheKey,
        effort: effort ?? null,
        tools: Array.isArray(body.tools) ? body.tools.length : 0,
        allowed: body.tool_choice ? options.tools?.length : undefined,
        input: (body.input as unknown[]).map(wireShape)
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
      logResponse(`http_${response.status}`, text.slice(0, 300))
      throw new Error(`openai responses failed: HTTP ${response.status} ${text}`.trim())
    }

    let stopReason: StopReason = 'unknown'
    let sawToolCall = false
    let sawText = false
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheCreationTokens = 0
    const replayItems: unknown[] = []

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
      // Prefix tokens written into the cache this call — billed at 1.25× the
      // input rate on the gpt-6/5.6 lines (pricing page, 2026-10-13) and
      // reported separately since then. Ignored, every write was billed as
      // plain input.
      const written = usage.input_tokens_details?.cache_write_tokens
      if (typeof written === 'number' && written > 0) {
        cacheCreationTokens = written
        inputTokens = Math.max(0, inputTokens - written)
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
            sawText = true
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
          outputShapes.push(wireShape(item))
          if (item?.type === 'reasoning') {
            replayItems.push(item)
            break
          }
          // The model's own message items go back verbatim with their
          // `phase` (commentary vs final_answer): replayed as a plain
          // assistant string, a progress note reads to the model as a
          // finished answer.
          if (item?.type === 'message') {
            replayItems.push({
              type: 'message',
              role: 'assistant',
              content: item.content ?? [],
              ...(item.phase ? { phase: item.phase } : {})
            })
            break
          }
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
          // Nothing reached the user yet: throw, so thalamus classifies it
          // like an HTTP failure and retries the transient ones ("Our servers
          // are currently overloaded" arrives as a stream event, and as a
          // terminal error chunk it ended a run 11 s in, 2026-10-13).
          logResponse('failed', message)
          if (!sawText && !sawToolCall) throw new Error(`openai: ${message}`)
          yield { type: 'error', message: `openai: ${message}`, recoverable: false }
          return
        }
        case 'error': {
          const message = parsed.message ?? parsed.error?.message ?? 'stream error'
          this.corpus?.emit('llm.error', { provider: 'openai', error: message })
          logResponse('error', message)
          if (!sawText && !sawToolCall) throw new Error(`openai: ${message}`)
          yield { type: 'error', message: `openai: ${message}`, recoverable: false }
          return
        }
        default:
          break
      }
    }

    logResponse(stopReason)

    if (replayItems.length > 0) {
      yield {
        type: 'provider_reasoning',
        reasoning: { provider: 'openai', model: this.model, items: replayItems }
      }
    }

    yield {
      type: 'turn_meta',
      stopReason,
      usage: {
        inputTokens,
        outputTokens,
        cacheReadTokens: cacheReadTokens || undefined,
        cacheCreationTokens: cacheCreationTokens || undefined
      }
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
    content?: unknown[]
    phase?: string
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
function toResponsesInput(messages: ChatMessage[], model: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      out.push({
        type: 'function_call_output',
        call_id: m.toolUseId,
        // An empty output reads to the model as "nothing happened" and invites
        // the same call again; every function_call gets a meaningful answer.
        output: openaiResponsesToolContent(
          m.content.trim() ? m.content : '(the tool returned no output)',
          m.images,
          m.toolName
        )
      })
      continue
    }
    if (m.role === 'user') {
      // The per-iteration runtime tail goes as developer, not user: a
      // trailing user message pins OpenAI's prompt cache to the system
      // prefix, so every tool-loop iteration re-billed the whole history
      // uncached (measured 2026-10-13, gpt-6.1-sol: cache frozen at the
      // instructions with a user tail, growing every call with developer).
      out.push({
        role: m.volatile ? 'developer' : 'user',
        content: userContentToResponses(m.content)
      })
      continue
    }
    const reasoning = m.providerReasoning
    const replay = reasoning && reasoning.provider === 'openai' && reasoning.model === model
    if (replay) {
      for (const item of reasoning.items) out.push(item as Record<string, unknown>)
    }
    const replayedText =
      replay && reasoning.items.some((i) => (i as { type?: string }).type === 'message')
    if (!replayedText && m.content && m.content.length > 0) {
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
