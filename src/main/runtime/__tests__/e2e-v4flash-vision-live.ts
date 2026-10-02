/**
 * Live E2E probe — DeepSeek V4-Flash-Vision-Exp (released 2026-08-21).
 *
 * Settles, against the live API through the REAL DeepSeekProvider class:
 *   1. /models — does `deepseek-v4-flash-vision-exp` exist on this account?
 *   2. Reasoning contract — thinking off→0 chars, high→nonzero (same knobs
 *      as the text v4 line, or the provider-wide reasoning.ts case is wrong).
 *   3. User-message image — 16x16 red PNG accepted and actually SEEN
 *      (answer must name the color, not merely 200-OK).
 *   4. Tool-result image — the computer-use path through
 *      openaiCompatToolContent: a screenshot-shaped tool result carrying the
 *      PNG, model must read the color out of it.
 *   5. Regression — plain deepseek-v4-flash still hard-rejects image parts,
 *      so the conservative text-only default for the rest of the lineup
 *      stays correct.
 *
 * Keys are read from the local Wolffish config and never printed.
 *
 * Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx \
 *     src/main/runtime/__tests__/e2e-v4flash-vision-live.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DeepSeekProvider } from '@main/runtime/providers/deepseek'
import type {
  ChatMessage,
  ProviderStreamOptions,
  StreamChunk,
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

const VISION_MODEL = 'deepseek-v4-flash-vision-exp'
const TEXT_MODEL = 'deepseek-v4-flash'

const SYSTEM = 'You are a helpful assistant. Be brief.'
const MATH_PROMPT = 'What is 17 * 23? Reply with only the number.'
const PUZZLE_PROMPT =
  'Three friends live in houses 1-3. Ann is not in house 1. Ben is directly right of Cal. ' +
  'Who lives in which house? One short sentence.'

// 16x16 solid red PNG — settles accept-vs-reject and dominant color.
// (A 1x1 probe is ambiguous: some vision stacks 400 on tiny dimensions,
// which reads as a modality reject when the modality actually works.)
const RED_PIXEL_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII='

const SCREENSHOT_TOOL: ToolDefinition = {
  name: 'computer_screenshot',
  description: 'Capture a screenshot of the current screen and return it as an image.',
  parameters: { type: 'object', properties: {} }
}

function key(): string {
  const cfgPath = path.join(os.homedir(), '.wolffish', 'workspace', 'config.json')
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
    llm: { providers: Array<{ id: string; apiKey?: string }> }
  }
  const k = cfg.llm.providers.find((p) => p.id === 'deepseek')?.apiKey
  if (!k) throw new Error('no deepseek key in local config')
  return k
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

function report(label: string, ok: boolean, detail: string): void {
  if (!ok) failures++
  console.log(`[${label}] ${ok ? 'PASS' : 'FAIL'} ${detail}`)
}

async function listModels(apiKey: string): Promise<string[]> {
  const res = await fetch('https://api.deepseek.com/models', {
    headers: { Authorization: `Bearer ${apiKey}` }
  })
  if (!res.ok) throw new Error(`GET /models → HTTP ${res.status}`)
  const body = (await res.json()) as { data?: Array<{ id: string }> }
  return (body.data ?? []).map((m) => m.id).sort()
}

async function main(): Promise<void> {
  const k = key()
  const vis = (): Streamer => new DeepSeekProvider(k, VISION_MODEL)
  const txt = (): Streamer => new DeepSeekProvider(k, TEXT_MODEL)

  // 1. Model exists on the account.
  const ids = await listModels(k)
  console.log(`/models → ${ids.join(', ')}`)
  report(
    'models',
    ids.includes(VISION_MODEL),
    `${VISION_MODEL} listed=${ids.includes(VISION_MODEL)}`
  )

  // 2. Reasoning contract (off→0, high→nonzero) on the vision model.
  try {
    const off = await run(vis(), {
      system: SYSTEM,
      messages: [{ role: 'user', content: MATH_PROMPT }],
      thinkingMode: 'off'
    })
    report(
      'vision-exp off',
      off.reasoningChars === 0 && off.text.includes('391'),
      `reasoning=${off.reasoningChars}ch text=${JSON.stringify(off.text.slice(0, 40))}`
    )
  } catch (err) {
    report('vision-exp off', false, (err as Error).message.slice(0, 200))
  }
  await sleep(1500)

  try {
    const high = await run(vis(), {
      system: SYSTEM,
      messages: [{ role: 'user', content: PUZZLE_PROMPT }],
      thinkingMode: 'high'
    })
    report(
      'vision-exp high',
      high.reasoningChars > 0,
      `reasoning=${high.reasoningChars}ch text=${JSON.stringify(high.text.slice(0, 60))}`
    )
  } catch (err) {
    report('vision-exp high', false, (err as Error).message.slice(0, 200))
  }
  await sleep(1500)

  // 3. User-message image: accepted AND seen.
  try {
    const r = await run(vis(), {
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
    report('vision-exp image', /red/i.test(r.text), `text=${JSON.stringify(r.text.slice(0, 60))}`)
  } catch (err) {
    report('vision-exp image', false, `rejected — ${(err as Error).message.slice(0, 200)}`)
  }
  await sleep(1500)

  // 4. Tool-result image (computer-use path via openaiCompatToolContent).
  try {
    const ask: ChatMessage = {
      role: 'user',
      content: 'Take a screenshot and tell me the dominant color of my screen. One word answer.'
    }
    const t1 = await run(vis(), {
      system: SYSTEM,
      messages: [ask],
      tools: [SCREENSHOT_TOOL],
      thinkingMode: 'off'
    })
    if (t1.toolCalls.length === 0) {
      report('vision-exp tool-img', false, `turn1 no tool_call (text=${t1.text.slice(0, 60)})`)
    } else {
      const call = t1.toolCalls[0]
      await sleep(1500)
      const t2 = await run(vis(), {
        system: SYSTEM,
        messages: [
          ask,
          {
            role: 'assistant',
            content: t1.text,
            toolUses: [{ id: call.id, name: call.name, args: call.args }]
          } as ChatMessage,
          {
            role: 'tool',
            toolUseId: call.id,
            toolName: call.name,
            content: 'Screenshot captured.',
            images: [{ mediaType: 'image/png', data: RED_PIXEL_B64 }]
          } as ChatMessage
        ],
        tools: [SCREENSHOT_TOOL],
        thinkingMode: 'off'
      })
      report(
        'vision-exp tool-img',
        /red/i.test(t2.text),
        `text=${JSON.stringify(t2.text.slice(0, 60))}`
      )
    }
  } catch (err) {
    report('vision-exp tool-img', false, (err as Error).message.slice(0, 250))
  }
  await sleep(1500)

  // 5. Regression: the plain text model must still reject image parts.
  try {
    const r = await run(txt(), {
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
    report(
      'v4-flash still-rejects',
      false,
      `ACCEPTED (text=${r.text.slice(0, 60)}) — lineup changed!`
    )
  } catch (err) {
    report(
      'v4-flash still-rejects',
      true,
      `rejected as expected — ${(err as Error).message.slice(0, 120)}`
    )
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exitCode = 1
})
