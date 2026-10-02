/**
 * LIVE end-to-end verification of kimi-k3 through wolffish's real pipeline:
 * Thalamus (Brain resolution, reasoning-mode normalization, vision gate) →
 * KimiProvider (request building, SSE parsing, tool assembly) → production
 * Moonshot API — exercised in BOTH wolffish modes (single + workflow).
 *
 * Takes the live key from the MOONSHOT_API_KEY env var. A fetch tap records
 * each outbound request body so the K3 knobs actually sent are asserted at
 * the wire level: reasoning_effort none|high|max, NEVER the K2-era
 * thinking{type} field (deprecated for K3), max_completion_tokens 131072.
 *
 * Run: MOONSHOT_API_KEY=sk-... ELECTRON_RUN_AS_NODE=1 npx electron \
 *        node_modules/tsx/dist/cli.mjs \
 *        src/main/runtime/__tests__/e2e-kimi-k3-live.boot.ts
 * (electron-as-node because thalamus.ts imports electron's net module)
 */
import assert from 'node:assert/strict'
import { LocalProvider } from '@main/runtime/providers/local'
import { Thalamus } from '@main/runtime/thalamus'
import type { ChatMessage, StreamChunk, ToolUse } from '@main/runtime/thalamus'
import { WorkflowSession, type RunAgentTurn } from '@main/runtime/workflow'

const MODEL = 'kimi-k3'

const apiKey = process.env.MOONSHOT_API_KEY
if (!apiKey) {
  console.error('MOONSHOT_API_KEY not set — skipping')
  process.exit(1)
}

// ── wire tap: capture what wolffish actually sends to api.moonshot.ai ────
type WireCall = {
  model: string
  reasoning_effort?: string
  thinking?: unknown
  max_completion_tokens?: number
  max_tokens?: number
  stream?: boolean
}
const wire: WireCall[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.includes('api.moonshot.ai') && typeof init?.body === 'string') {
    const body = JSON.parse(init.body) as WireCall
    wire.push({
      model: body.model,
      reasoning_effort: body.reasoning_effort,
      thinking: body.thinking,
      max_completion_tokens: body.max_completion_tokens,
      max_tokens: body.max_tokens,
      stream: body.stream
    })
  }
  return realFetch(input, init)
}) as typeof fetch

// ── the real Thalamus, Brain pointed at kimi-k3 ──────────────────────────
const thalamus = new Thalamus(new LocalProvider())
thalamus.setCloudProviders([{ id: 'kimi', model: MODEL, apiKey }])
thalamus.setBrain({ providerId: 'kimi', model: MODEL })

type Collected = {
  text: string
  reasoningChars: number
  toolCalls: ToolUse[]
  stopReason: string | null
  activeModel: string | null
  outputTokens: number
  errors: string[]
}

async function drive(options: Parameters<Thalamus['stream']>[0]): Promise<Collected> {
  const out: Collected = {
    text: '',
    reasoningChars: 0,
    toolCalls: [],
    stopReason: null,
    activeModel: null,
    outputTokens: 0,
    errors: []
  }
  for await (const chunk of thalamus.stream(options) as AsyncGenerator<StreamChunk>) {
    if (chunk.type === 'text') out.text += chunk.text
    else if (chunk.type === 'reasoning') out.reasoningChars += chunk.text.length
    else if (chunk.type === 'tool_call')
      out.toolCalls.push({ id: chunk.id, name: chunk.name, args: chunk.args })
    else if (chunk.type === 'turn_meta') {
      out.stopReason = chunk.stopReason
      out.outputTokens = chunk.usage?.outputTokens ?? 0
    } else if (chunk.type === 'active_model') out.activeModel = `${chunk.provider}/${chunk.model}`
    else if (chunk.type === 'error') out.errors.push(chunk.message)
    else if (chunk.type === 'no_provider_available') out.errors.push('no_provider_available')
  }
  return out
}

const SYSTEM = 'You are wolffish, a concise assistant. Follow instructions exactly.'
const RED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC'

let failures = 0
function report(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  PASS ${name}`)
  } catch (err) {
    failures++
    console.log(`  FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function main(): Promise<void> {
  // ════ SINGLE MODE ═══════════════════════════════════════════════════
  console.log('single mode — plain turn (legacy on token → normalized to high)')
  const s1 = await drive({
    system: SYSTEM,
    messages: [{ role: 'user', content: 'Reply with exactly: ready' }],
    thinkingMode: 'on'
  })
  report('resolves to kimi/kimi-k3', () => assert.equal(s1.activeModel, `kimi/${MODEL}`))
  report('no errors', () => assert.deepEqual(s1.errors, []))
  report('text answer', () => assert.match(s1.text.toLowerCase(), /ready/))
  report('reasoning streamed', () => assert.ok(s1.reasoningChars > 0))
  report('clean stop + usage', () => assert.ok(s1.stopReason === 'end_turn' && s1.outputTokens > 0))
  report('wire: on → reasoning_effort high, no thinking field, K3 output ceiling', () => {
    const w = wire.at(-1)
    assert.equal(w?.reasoning_effort, 'high')
    assert.equal(w?.thinking, undefined)
    assert.equal(w?.max_completion_tokens, 131072)
    assert.equal(w?.max_tokens, undefined)
  })

  console.log('single mode — thinking off (brain mode: off → wire reasoning_effort none)')
  const s2 = await drive({
    system: SYSTEM,
    messages: [{ role: 'user', content: 'What is 17+25? Reply with just the number.' }],
    thinkingMode: 'off'
  })
  report('correct answer without reasoning', () => assert.match(s2.text, /42/))
  report('zero reasoning streamed', () => assert.equal(s2.reasoningChars, 0))
  report('wire: reasoning_effort none, no thinking field', () => {
    const w = wire.at(-1)
    assert.equal(w?.reasoning_effort, 'none')
    assert.equal(w?.thinking, undefined)
  })

  console.log('single mode — reasoning math (brain mode: high, native)')
  const s3 = await drive({
    system: SYSTEM,
    messages: [{ role: 'user', content: 'What is 23*29? Reply with just the number.' }],
    thinkingMode: 'high'
  })
  report('correct answer', () => assert.match(s3.text, /667/))
  report('reasoning streamed on high', () => assert.ok(s3.reasoningChars > 0))
  report('wire: reasoning_effort high', () => assert.equal(wire.at(-1)?.reasoning_effort, 'high'))

  console.log('single mode — tool-call round trip')
  const tools = [
    {
      name: 'get_current_time',
      description: 'Get the current time in a timezone',
      parameters: {
        type: 'object',
        properties: { timezone: { type: 'string' } },
        required: ['timezone']
      }
    }
  ]
  const t1 = await drive({
    system: SYSTEM,
    messages: [{ role: 'user', content: 'What time is it in Riyadh right now? Use the tool.' }],
    thinkingMode: 'on',
    tools
  })
  report('emits tool_call', () => {
    assert.equal(t1.toolCalls.length, 1)
    assert.equal(t1.toolCalls[0].name, 'get_current_time')
  })
  report('stop reason tool_use', () => assert.equal(t1.stopReason, 'tool_use'))
  const followup: ChatMessage[] = [
    { role: 'user', content: 'What time is it in Riyadh right now? Use the tool.' },
    { role: 'assistant', content: t1.text, toolUses: t1.toolCalls },
    {
      role: 'tool',
      toolUseId: t1.toolCalls[0]?.id ?? 'call_0',
      toolName: 'get_current_time',
      content: '2026-07-17T14:05:00+03:00'
    }
  ]
  const t2 = await drive({ system: SYSTEM, messages: followup, thinkingMode: 'on', tools })
  report('final answer uses tool result', () => assert.match(t2.text, /14:05|2:05/))
  report('round trip ends cleanly', () => assert.equal(t2.stopReason, 'end_turn'))

  console.log('single mode — vision (image through the thalamus gate)')
  const v1 = await drive({
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'One word: what colour is this image?' },
          { type: 'image', mediaType: 'image/png', data: RED_PNG }
        ]
      }
    ],
    thinkingMode: 'on'
  })
  report('sees the image (vision gate passes k3)', () => assert.match(v1.text.toLowerCase(), /red/))

  // ════ WORKFLOW MODE ═════════════════════════════════════════════════
  // Real WorkflowSession; runAgentTurn feeds each agent through the real
  // thalamus with role 'agent'. K3's registry is [off, high, max], so the
  // master-picked efforts pass through natively: max → wire max, off →
  // wire none.
  console.log('workflow mode — agents with clamped efforts')
  let lastAgentReasoningChars = 0
  const runAgentTurn: RunAgentTurn = async (args) => {
    const res = await drive({
      system:
        'You are a focused wolffish workflow sub-agent. Complete the task in one short reply.',
      messages: args.history,
      thinkingMode: args.effort,
      role: 'agent',
      signal: args.signal
    })
    lastAgentReasoningChars = res.reasoningChars
    args.onLlmCall('kimi', MODEL, {
      inputTokens: 0,
      outputTokens: res.outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0
    })
    return {
      text: res.text,
      stopReason: (res.stopReason ?? 'end_turn') as 'end_turn',
      failed: res.errors.length > 0
    }
  }
  const session = new WorkflowSession(
    'wf_e2e_kimi_k3',
    runAgentTurn,
    () => ({ provider: 'kimi', model: MODEL }),
    () => {}
  )
  session.plan(['verify'], 'kimi-k3 live e2e')

  session.spawn({
    task: 'Reply with exactly: alpha done',
    name: 'alpha',
    phase: 'verify',
    effort: 'max'
  })
  const a = await session.awaitNext()
  assert.ok(a && a.kind === 'landed', 'agent alpha landed')
  report('agent alpha (effort max) completes', () => {
    assert.ok(!a.result.failed)
    assert.match(a.result.text.toLowerCase(), /alpha done/)
  })
  report('wire: agent max → reasoning_effort max', () =>
    assert.equal(wire.at(-1)?.reasoning_effort, 'max')
  )
  report('agent alpha actually reasoned', () => assert.ok(lastAgentReasoningChars > 0))

  session.spawn({
    task: 'Reply with exactly: beta done',
    name: 'beta',
    phase: 'verify',
    effort: 'off'
  })
  const b = await session.awaitNext()
  assert.ok(b && b.kind === 'landed', 'agent beta landed')
  report('agent beta (effort off) completes', () => {
    assert.ok(!b.result.failed)
    assert.match(b.result.text.toLowerCase(), /beta done/)
  })
  report('wire: off → reasoning_effort none', () =>
    assert.equal(wire.at(-1)?.reasoning_effort, 'none')
  )
  report('agent beta: zero reasoning', () => assert.equal(lastAgentReasoningChars, 0))

  const snap = session.snapshot()
  report('workflow snapshot: both agents completed', () => {
    assert.equal(snap.agents.length, 2)
    assert.ok(snap.agents.every((ag) => ag.status === 'completed'))
  })

  report('every wire call: kimi-k3, valid effort, no thinking field, streamed', () => {
    assert.ok(wire.length >= 8)
    for (const w of wire) {
      assert.equal(w.model, MODEL)
      assert.ok(
        w.reasoning_effort === 'max' ||
          w.reasoning_effort === 'high' ||
          w.reasoning_effort === 'none'
      )
      assert.equal(w.thinking, undefined)
      assert.equal(w.stream, true)
    }
  })

  console.log(
    failures === 0
      ? `\nALL PASS — ${wire.length} live kimi-k3 calls through the wolffish pipeline`
      : `\n${failures} FAILURE(S)`
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('harness crashed:', err)
  process.exit(1)
})
