import type { Corpus } from '@main/runtime/corpus'
import type { NoProviderAvailableInfo, StopReason, StreamChunk } from '@main/runtime/thalamus'

/**
 * Wernicke parses the LLM's raw output into something structured.
 *
 * Maps to: Wernicke's area — a region in the left temporal lobe
 * responsible for language comprehension. Damage to it produces fluent
 * but meaningless speech (Wernicke's aphasia): the words come out, but
 * the patient can't decode incoming language. Comprehension is what
 * Wernicke does.
 *
 * In Wolffish, Wernicke consumes the unified stream produced by Thalamus
 * and separates it into final answer text, optional reasoning blocks, and
 * normalized tool calls. The result is a `ParsedResponse` that any other
 * region can consume without caring which provider produced it.
 */

export type ToolCall = {
  id: string
  name: string
  args: Record<string, unknown>
}

export type ParsedResponse = {
  text: string
  toolCalls: ToolCall[]
  thinking?: string
  inputTokens: number
  outputTokens: number
  stopReason: StopReason
  error?: string
  noProviderAvailable?: NoProviderAvailableInfo[]
  providerFailures?: NoProviderAvailableInfo[]
}

export type WernickeOptions = {
  corpus?: Corpus
}

const THINKING_OPEN = '<think>'
const THINKING_CLOSE = '</think>'

export class Wernicke {
  constructor(private options: WernickeOptions = {}) {
    void this.options
  }

  /**
   * Consume a stream of StreamChunks and return a ParsedResponse. Text
   * chunks are concatenated, tool_call chunks are collected, the
   * provider's stop reason and usage are read from the terminal
   * turn_meta chunk, and `<think>...</think>` blocks (Ollama-style
   * reasoning) are pulled out of the visible text into the `thinking`
   * field.
   */
  async parse(stream: AsyncGenerator<StreamChunk>): Promise<ParsedResponse> {
    let text = ''
    let reasoning = ''
    const toolCalls: ToolCall[] = []
    let inputTokens = 0
    let outputTokens = 0
    let stopReason: StopReason = 'unknown'
    let error: string | undefined
    let noProviderAvailable: NoProviderAvailableInfo[] | undefined
    let providerFailures: NoProviderAvailableInfo[] | undefined

    for await (const chunk of stream) {
      if (chunk.type === 'text') {
        text += chunk.text
      } else if (chunk.type === 'reasoning') {
        reasoning += chunk.text
      } else if (chunk.type === 'tool_call') {
        toolCalls.push({ id: chunk.id, name: chunk.name, args: chunk.args })
      } else if (chunk.type === 'turn_meta') {
        stopReason = chunk.stopReason
        if (chunk.usage) {
          inputTokens = chunk.usage.inputTokens
          outputTokens = chunk.usage.outputTokens
        }
      } else if (chunk.type === 'error') {
        error = chunk.message
        if (chunk.failures?.length) {
          providerFailures = chunk.failures
        }
      } else if (chunk.type === 'no_provider_available') {
        noProviderAvailable = chunk.failures
        // Set error so the agent's existing throw-on-error path triggers
        // and the catch handler can promote this into a turn_end with
        // stopReason='no_provider_available'.
        error = chunk.failures.map((f) => f.errorReason).join('; ')
      }
    }

    const { visible, thinking: inlineThinking } = extractThinking(text)

    const thinkingParts = [reasoning.trim(), inlineThinking?.trim()].filter(Boolean)
    const thinking = thinkingParts.length > 0 ? thinkingParts.join('\n') : undefined

    const result: ParsedResponse = {
      text: visible,
      toolCalls,
      inputTokens,
      outputTokens,
      stopReason
    }
    if (thinking) result.thinking = thinking
    if (error) result.error = error
    if (noProviderAvailable) result.noProviderAvailable = noProviderAvailable
    if (providerFailures) result.providerFailures = providerFailures
    return result
  }
}

function extractThinking(raw: string): { visible: string; thinking: string | null } {
  if (!raw.includes(THINKING_OPEN)) return { visible: raw, thinking: null }

  const thinkingParts: string[] = []
  let visible = ''
  let cursor = 0
  while (cursor < raw.length) {
    const open = raw.indexOf(THINKING_OPEN, cursor)
    if (open < 0) {
      visible += raw.slice(cursor)
      break
    }
    visible += raw.slice(cursor, open)
    const close = raw.indexOf(THINKING_CLOSE, open + THINKING_OPEN.length)
    if (close < 0) {
      thinkingParts.push(raw.slice(open + THINKING_OPEN.length))
      cursor = raw.length
      break
    }
    thinkingParts.push(raw.slice(open + THINKING_OPEN.length, close))
    cursor = close + THINKING_CLOSE.length
  }

  const thinking = thinkingParts
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n')
  return { visible: visible.trim(), thinking: thinking.length > 0 ? thinking : null }
}
