/**
 * Live E2E probe — official DeepSeek V4-Flash (0731 build) + Qwen 3.8 Max
 * (DashScope drop of 2026-08-03).
 *
 * Drives the REAL provider classes (request builder + SSE parser + history
 * replay) against the live APIs, one call per reasoning mode plus a two-turn
 * tool round-trip, and an image probe to settle vision support. Keys are read
 * from the local Wolffish config and never printed.
 *
 * Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx \
 *     src/main/runtime/__tests__/e2e-v4flash-qwen38-live.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DeepSeekProvider } from '@main/runtime/providers/deepseek'
import { QwenProvider } from '@main/runtime/providers/qwen'
import type {
  ChatMessage,
  ProviderStreamOptions,
  StreamChunk,
  ThinkingMode,
  ToolDefinition
} from '@main/runtime/thalamus'

type Streamer = { stream(o: ProviderStreamOptions): AsyncGenerator<StreamChunk> }

type RunResult = {
  reasoningChars: number
  text: string
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }
  stopReason?: string
}

const SYSTEM = 'You are a helpful assistant. Be brief.'
const MATH_PROMPT = 'What is 17 * 23? Reply with only the number.'
const PUZZLE_PROMPT =
  'Three friends live in houses 1-3. Ann is not in house 1. Ben is directly right of Cal. ' +
  'Who lives in which house? One short sentence.'

// 16x16 solid red PNG — settles accept-vs-reject and dominant color.
// (A 1x1 probe is ambiguous: DashScope vision models 400 on dimensions
// under 10px, which reads as a reject when the modality actually works.)
const RED_PIXEL_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII='

const TIME_TOOL: ToolDefinition = {
  name: 'get_time',
  description: 'Get the current local time for an IANA timezone.',
  parameters: {
    type: 'object',
    properties: { timezone: { type: 'string', description: 'IANA timezone id' } },
    required: ['timezone']
  }
}

function keys(): { deepseek: string; qwen: string } {
  const cfgPath = path.join(os.homedir(), '.wolffish', 'workspace', 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
    llm: { providers: Array<{ id: string; apiKey?: string }> }
  }
  const find = (id: string): string => {
    const k = cfg.llm.providers.find((p) => p.id === id)?.apiKey
    if (!k) throw new Error(`no ${id} key in local config`)
    return k
  }
  return { deepseek: find('deepseek'), qwen: find('qwen') }
}

async function run(provider: Streamer, opts: ProviderStreamOptions): Promise<RunResult> {
  const res: RunResult = { reasoningChars: 0, text: '', toolCalls: [] }
  for await (const chunk of provider.stream(opts)) {
    if (chunk.type === 'reasoning') res.reasoningChars += chunk.text.length
    else if (chunk.type === 'text') res.text += chunk.text
    else if (chunk.type === 'tool_call')
      res.toolCalls.push({ id: chunk.id, name: chunk.name, args: chunk.args })
    else if (chunk.type === 'turn_meta') {
      res.stopReason = chunk.stopReason
      if (chunk.usage) res.usage = chunk.usage
    } else if (chunk.type === 'error') throw new Error(chunk.message)
  }
  return res
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let failures = 0
const findings: string[] = []

function report(label: string, r: RunResult, expect?: 'zero' | 'nonzero'): void {
  const u = r.usage
    ? ` in=${r.usage.inputTokens} out=${r.usage.outputTokens} cached=${r.usage.cacheReadTokens ?? 0}`
    : ''
  const verdictOk =
    expect === undefined || (expect === 'zero' ? r.reasoningChars === 0 : r.reasoningChars > 0)
  const mark = expect === undefined ? '·' : verdictOk ? 'PASS' : 'FAIL'
  if (!verdictOk) failures++
  console.log(
    `[${label}] ${mark} reasoning=${r.reasoningChars}ch stop=${r.stopReason}${u} text=${JSON.stringify(r.text.slice(0, 90))}`
  )
}

async function modeSweep(name: string, make: () => Streamer, modes: ThinkingMode[]): Promise<void> {
  for (const mode of modes) {
    const prompt = mode === 'off' ? MATH_PROMPT : PUZZLE_PROMPT
    try {
      const r = await run(make(), {
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
        thinkingMode: mode
      })
      report(`${name} ${mode}`, r, mode === 'off' ? 'zero' : 'nonzero')
    } catch (err) {
      failures++
      console.log(`[${name} ${mode}] FAIL ${(err as Error).message.slice(0, 300)}`)
    }
    await sleep(1500)
  }
}

async function toolRoundTrip(name: string, make: () => Streamer): Promise<void> {
  try {
    const ask: ChatMessage = { role: 'user', content: 'What time is it in Riyadh? Use the tool.' }
    const t1 = await run(make(), {
      system: SYSTEM,
      messages: [ask],
      tools: [TIME_TOOL],
      thinkingMode: 'high'
    })
    if (t1.toolCalls.length === 0) {
      failures++
      console.log(`[${name} tools] FAIL turn1 produced no tool_call (text=${t1.text.slice(0, 80)})`)
      return
    }
    const call = t1.toolCalls[0]
    await sleep(1500)
    const t2 = await run(make(), {
      system: SYSTEM,
      messages: [
        ask,
        {
          role: 'assistant',
          content: t1.text,
          toolUses: [{ id: call.id, name: call.name, args: call.args }],
          reasoningContent: undefined
        } as ChatMessage,
        {
          role: 'tool',
          toolUseId: call.id,
          toolName: call.name,
          content: '2026-08-03T14:05:00+03:00'
        }
      ],
      tools: [TIME_TOOL],
      thinkingMode: 'high'
    })
    const ok = t2.text.length > 0
    if (!ok) failures++
    console.log(
      `[${name} tools] ${ok ? 'PASS' : 'FAIL'} turn1 call=${call.name}(${JSON.stringify(call.args)}) turn2 text=${JSON.stringify(t2.text.slice(0, 90))}`
    )
  } catch (err) {
    failures++
    console.log(`[${name} tools] FAIL ${(err as Error).message.slice(0, 300)}`)
  }
  await sleep(1500)
}

async function visionProbe(name: string, make: () => Streamer): Promise<void> {
  try {
    const r = await run(make(), {
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is the dominant color of this image? One word.' },
            { type: 'image', mediaType: 'image/png', data: RED_PIXEL_B64 }
          ]
        }
      ],
      thinkingMode: 'off'
    })
    findings.push(
      `${name} vision: ACCEPTED image part — answer ${JSON.stringify(r.text.slice(0, 40))}`
    )
    console.log(`[${name} vision] accepted — text=${JSON.stringify(r.text.slice(0, 60))}`)
  } catch (err) {
    findings.push(`${name} vision: REJECTED image part — ${(err as Error).message.slice(0, 140)}`)
    console.log(`[${name} vision] rejected — ${(err as Error).message.slice(0, 200)}`)
  }
  await sleep(1500)
}

async function main(): Promise<void> {
  const k = keys()
  const ds = (): Streamer => new DeepSeekProvider(k.deepseek, 'deepseek-v4-flash')
  const qw = (): Streamer => new QwenProvider(k.qwen, 'qwen3.8-max')

  console.log('— DeepSeek deepseek-v4-flash (official 0731) —')
  await modeSweep('ds', ds, ['off', 'high', 'max'])
  await toolRoundTrip('ds', ds)
  await visionProbe('ds', ds)

  console.log('— Qwen qwen3.8-max —')
  await modeSweep('qwen', qw, ['off', 'high', 'max'])
  await toolRoundTrip('qwen', qw)
  await visionProbe('qwen', qw)

  console.log('— findings —')
  for (const f of findings) console.log('  ' + f)
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
