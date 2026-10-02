/**
 * LIVE wire probe — does a vision-capable provider accept image parts
 * *inside a `role: tool` message*? User-message vision does not imply
 * this. The seven newly-enabled encoders (kimi, mimo, minimax, qwen,
 * stepfun, xai, zai) started sending those parts without a live call.
 *
 * Drives the REAL provider class (request builder + SSE parser) against
 * the production API. A fetch tap asserts the outbound tool message
 * actually carries a data-URI `image_url` part, then the stream is
 * collected: HTTP 400 / image-part reject = FAIL; any other completion
 * (including a wrong colour guess) = ACCEPT.
 *
 * Keys come from env vars — never from ~/.wolffish (that folder is a
 * build artifact and tests must not read it).
 *
 * Do NOT run this from an agent turn. One provider at a time:
 *
 *   XAI_API_KEY=... PROVIDER=xai \
 *     TSX_TSCONFIG_PATH=tsconfig.node.json \
 *     ELECTRON_RUN_AS_NODE=1 npx electron node_modules/tsx/dist/cli.mjs \
 *     src/main/runtime/__tests__/e2e-tool-result-images-live.boot.ts
 *
 *   MOONSHOT_API_KEY=... PROVIDER=kimi \
 *     TSX_TSCONFIG_PATH=tsconfig.node.json \
 *     ELECTRON_RUN_AS_NODE=1 npx electron node_modules/tsx/dist/cli.mjs \
 *     src/main/runtime/__tests__/e2e-tool-result-images-live.boot.ts
 *
 *   QWEN_API_KEY=... PROVIDER=qwen \
 *     TSX_TSCONFIG_PATH=tsconfig.node.json \
 *     ELECTRON_RUN_AS_NODE=1 npx electron node_modules/tsx/dist/cli.mjs \
 *     src/main/runtime/__tests__/e2e-tool-result-images-live.boot.ts
 *
 *   MINIMAX_API_KEY=... PROVIDER=minimax \
 *     TSX_TSCONFIG_PATH=tsconfig.node.json \
 *     ELECTRON_RUN_AS_NODE=1 npx electron node_modules/tsx/dist/cli.mjs \
 *     src/main/runtime/__tests__/e2e-tool-result-images-live.boot.ts
 *
 *   MIMO_API_KEY=... PROVIDER=mimo \
 *     TSX_TSCONFIG_PATH=tsconfig.node.json \
 *     ELECTRON_RUN_AS_NODE=1 npx electron node_modules/tsx/dist/cli.mjs \
 *     src/main/runtime/__tests__/e2e-tool-result-images-live.boot.ts
 *
 *   STEPFUN_API_KEY=... PROVIDER=stepfun \
 *     TSX_TSCONFIG_PATH=tsconfig.node.json \
 *     ELECTRON_RUN_AS_NODE=1 npx electron node_modules/tsx/dist/cli.mjs \
 *     src/main/runtime/__tests__/e2e-tool-result-images-live.boot.ts
 *
 *   ZAI_API_KEY=... PROVIDER=zai \
 *     TSX_TSCONFIG_PATH=tsconfig.node.json \
 *     ELECTRON_RUN_AS_NODE=1 npx electron node_modules/tsx/dist/cli.mjs \
 *     src/main/runtime/__tests__/e2e-tool-result-images-live.boot.ts
 *
 * electron-as-node because thalamus.ts imports electron's net module.
 */
import assert from 'node:assert/strict'
import { KimiProvider } from '@main/runtime/providers/kimi'
import { MiniMaxProvider } from '@main/runtime/providers/minimax'
import { MimoProvider } from '@main/runtime/providers/mimo'
import { QwenProvider } from '@main/runtime/providers/qwen'
import { StepfunProvider } from '@main/runtime/providers/stepfun'
import { XAIProvider } from '@main/runtime/providers/xai'
import { ZaiProvider } from '@main/runtime/providers/zai'
import type {
  ChatMessage,
  ProviderStreamOptions,
  StreamChunk,
  ToolDefinition
} from '@main/runtime/thalamus'
import { isModalityReject } from '@main/runtime/vision'

type Streamer = { stream(o: ProviderStreamOptions): AsyncGenerator<StreamChunk> }

type Target = {
  id: string
  env: string
  model: string
  host: string
  make: (key: string) => Streamer
}

const TARGETS: Target[] = [
  {
    id: 'xai',
    env: 'XAI_API_KEY',
    model: 'grok-4.6',
    host: 'api.x.ai',
    make: (k) => new XAIProvider(k, 'grok-4.6')
  },
  {
    id: 'kimi',
    env: 'MOONSHOT_API_KEY',
    model: 'kimi-k3',
    host: 'api.moonshot.ai',
    make: (k) => new KimiProvider(k, 'kimi-k3')
  },
  {
    id: 'qwen',
    env: 'QWEN_API_KEY',
    model: 'qwen3.8-max',
    host: 'dashscope-intl.aliyuncs.com',
    make: (k) => new QwenProvider(k, 'qwen3.8-max')
  },
  {
    id: 'minimax',
    env: 'MINIMAX_API_KEY',
    model: 'minimax-vl-01',
    host: 'api.minimaxi.chat',
    make: (k) => new MiniMaxProvider(k, 'minimax-vl-01')
  },
  {
    id: 'mimo',
    env: 'MIMO_API_KEY',
    model: 'mimo-vl-7b',
    host: 'api.xiaomimimo.com',
    make: (k) => new MimoProvider(k, 'mimo-vl-7b')
  },
  {
    id: 'stepfun',
    env: 'STEPFUN_API_KEY',
    model: 'step-1v-32k',
    host: 'api.stepfun.ai',
    make: (k) => new StepfunProvider(k, 'step-1v-32k')
  },
  {
    id: 'zai',
    env: 'ZAI_API_KEY',
    model: 'glm-4.6v',
    host: 'api.z.ai',
    make: (k) => new ZaiProvider(k, 'glm-4.6v')
  }
]

// 16x16 solid red PNG — DashScope 400s on images under 10px, which can
// masquerade as a modality reject. Same probe as e2e-v4flash-qwen38-live.
const RED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII='

const TOOL: ToolDefinition = {
  name: 'image_view',
  description: 'View an image file and return its pixels.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path']
  }
}

type WireCall = {
  url: string
  status?: number
  toolContent: unknown
}

const wire: WireCall[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  let toolContent: unknown
  if (typeof init?.body === 'string') {
    try {
      const body = JSON.parse(init.body) as {
        messages?: Array<{ role?: string; content?: unknown }>
      }
      const tool = body.messages?.find((m) => m.role === 'tool')
      toolContent = tool?.content
    } catch {
      // ignore unparseable bodies
    }
  }
  const rec: WireCall = { url, toolContent }
  wire.push(rec)
  const res = await realFetch(input, init)
  rec.status = res.status
  return res
}) as typeof fetch

type RunResult = {
  text: string
  errors: string[]
  stopReason: string | null
}

async function run(provider: Streamer, opts: ProviderStreamOptions): Promise<RunResult> {
  const out: RunResult = { text: '', errors: [], stopReason: null }
  try {
    for await (const chunk of provider.stream(opts)) {
      if (chunk.type === 'text') out.text += chunk.text
      else if (chunk.type === 'turn_meta') out.stopReason = chunk.stopReason
      else if (chunk.type === 'error') out.errors.push(chunk.message)
    }
  } catch (err) {
    out.errors.push(err instanceof Error ? err.message : String(err))
  }
  return out
}

function resolveTarget(): Target {
  const id = (process.env.PROVIDER ?? '').trim()
  if (!id) {
    console.error('set PROVIDER to one of: ' + TARGETS.map((t) => t.id).join(', '))
    process.exit(1)
  }
  const target = TARGETS.find((t) => t.id === id)
  if (!target) {
    console.error(`unknown PROVIDER=${id}`)
    process.exit(1)
  }
  return target
}

async function main(): Promise<void> {
  const target = resolveTarget()
  const apiKey = process.env[target.env]
  if (!apiKey) {
    console.error(`set ${target.env} to run this harness`)
    process.exit(1)
  }

  const callId = 'call_probe_1'
  const history: ChatMessage[] = [
    {
      role: 'user',
      content: 'Look at the attached screenshot and reply with one word: the dominant colour.'
    },
    {
      role: 'assistant',
      content: '',
      toolUses: [{ id: callId, name: 'image_view', args: { path: '/tmp/probe.png' } }]
    },
    {
      role: 'tool',
      toolUseId: callId,
      toolName: 'image_view',
      content: 'Viewing /tmp/probe.png (original 16x16, 1KB; shown at 16x16).',
      images: [{ mediaType: 'image/png', data: RED_PNG }]
    }
  ]

  console.log(`tool-result image probe — ${target.id}/${target.model}`)
  const result = await run(target.make(apiKey), {
    system: 'You are a concise assistant. Follow instructions exactly.',
    messages: history,
    tools: [TOOL],
    thinkingMode: 'off'
  })

  const relevant = wire.filter((w) => w.url.includes(target.host))
  const last = relevant.at(-1)

  let failures = 0
  const report = (name: string, fn: () => void): void => {
    try {
      fn()
      console.log(`  PASS ${name}`)
    } catch (err) {
      failures++
      console.log(`  FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  report('posted to the provider host', () => {
    assert.ok(relevant.length > 0, 'no request reached ' + target.host)
  })
  report('tool content is an array of parts (not a caption string)', () => {
    assert.ok(Array.isArray(last?.toolContent), 'expected parts array on the wire')
  })
  report('wire carries a data-URI image_url part', () => {
    const parts = last?.toolContent as Array<Record<string, unknown>>
    const img = parts.find((p) => p.type === 'image_url') as
      | { image_url?: { url?: string } }
      | undefined
    const url = img?.image_url?.url ?? ''
    assert.ok(url.startsWith('data:image/png;base64,'), 'missing data URI')
    assert.ok(url.includes(RED_PNG), 'payload is not the probe PNG')
  })
  report('provider accepted the tool-result image (no HTTP/image reject)', () => {
    if (last?.status && last.status >= 400) {
      throw new Error(`HTTP ${last.status}`)
    }
    const joined = result.errors.join(' | ')
    if (isModalityReject(joined)) {
      throw new Error(joined.slice(0, 240))
    }
    if (result.errors.length > 0 && result.text.length === 0) {
      throw new Error(joined.slice(0, 240))
    }
  })

  console.log(
    `  note: text=${JSON.stringify(result.text.slice(0, 80))} stop=${result.stopReason} http=${last?.status ?? '?'}`
  )

  if (failures > 0) process.exit(1)
  console.log('accepted — tool-result image parts are legal for this model')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
