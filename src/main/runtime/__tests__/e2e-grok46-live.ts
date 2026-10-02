/**
 * LIVE end-to-end verification of grok-4.6 through wolffish's real pipeline:
 * Thalamus (Brain resolution, agent-role reasoning clamp, retry policy) →
 * XAIProvider (request building, SSE parsing, tool assembly) → production
 * xAI API — exercised in BOTH wolffish modes (single + workflow).
 *
 * grok-4.6 carries the same five-rung effort ladder as 4.5 —
 * minimal|low|medium|high|xhigh, no 'none' — so the canonical [on, high, max]
 * scale must land on low / high / xhigh at the wire. That mapping is the point
 * of this harness: a fetch tap records every outbound body so the effort
 * actually sent per mode is asserted at the wire level, not inferred.
 *
 * Key comes from XAI_API_KEY — never from ~/.wolffish (that folder is a build
 * artifact and tests must not read it).
 *
 * Run: XAI_API_KEY=... TSX_TSCONFIG_PATH=tsconfig.node.json \
 *        ELECTRON_RUN_AS_NODE=1 npx electron <tsx>/dist/cli.mjs \
 *        src/main/runtime/__tests__/e2e-grok46-live.boot.ts
 * (electron-as-node because thalamus.ts imports electron's net module)
 */
import assert from 'node:assert/strict'
import { LocalProvider } from '@main/runtime/providers/local'
import { reasoningModesFor } from '@main/runtime/reasoning'
import { Thalamus } from '@main/runtime/thalamus'
import type { ChatMessage, StreamChunk, ToolUse } from '@main/runtime/thalamus'
import { WorkflowSession, type RunAgentTurn } from '@main/runtime/workflow'

const MODEL = 'grok-4.6'

const apiKey = process.env.XAI_API_KEY
if (!apiKey) {
  console.error('set XAI_API_KEY to run this harness')
  process.exit(1)
}

// ── wire tap: capture what wolffish actually sends to api.x.ai ───────────
type WireCall = {
  model: string
  reasoning_effort?: string
  max_completion_tokens?: number
  max_tokens?: number
  stream?: boolean
}
const wire: WireCall[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.includes('api.x.ai') && typeof init?.body === 'string') {
    const body = JSON.parse(init.body) as WireCall
    wire.push({
      model: body.model,
      reasoning_effort: body.reasoning_effort,
      max_completion_tokens: body.max_completion_tokens,
      max_tokens: body.max_tokens,
      stream: body.stream
    })
  }
  return realFetch(input, init)
}) as typeof fetch

// ── the real Thalamus, Brain pointed at grok-4.6 ─────────────────────────
const thalamus = new Thalamus(new LocalProvider())
thalamus.setCloudProviders([{ id: 'xai', model: MODEL, apiKey }])
thalamus.setBrain({ providerId: 'xai', model: MODEL })

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
  // ════ REGISTRY ══════════════════════════════════════════════════════
  console.log('registry — the brain button reads the same source the wire does')
  report('grok-4.6 exposes [on, high, max]', () =>
    assert.deepEqual(reasoningModesFor('xai', MODEL), ['on', 'high', 'max'])
  )

  // ════ SINGLE MODE ═══════════════════════════════════════════════════
  console.log('single mode — plain turn (brain mode: on → wire effort low)')
  const s1 = await drive({
    system: SYSTEM,
    messages: [{ role: 'user', content: 'Reply with exactly: ready' }],
    thinkingMode: 'on'
  })
  report('resolves to xai/grok-4.6', () => assert.equal(s1.activeModel, `xai/${MODEL}`))
  report('no errors', () => assert.deepEqual(s1.errors, []))
  report('text answer', () => assert.match(s1.text.toLowerCase(), /ready/))
  report('reasoning streamed (always-on)', () => assert.ok(s1.reasoningChars > 0))
  report('clean stop + usage', () => assert.ok(s1.stopReason === 'end_turn' && s1.outputTokens > 0))
  report('wire: effort low, max_completion_tokens, no max_tokens', () => {
    const w = wire.at(-1)
    assert.equal(w?.reasoning_effort, 'low')
    assert.equal(w?.max_completion_tokens, 65536)
    assert.equal(w?.max_tokens, undefined)
  })

  console.log('single mode — high effort math')
  const s2 = await drive({
    system: SYSTEM,
    messages: [{ role: 'user', content: 'What is 23*29? Reply with just the number.' }],
    thinkingMode: 'high'
  })
  report('correct answer', () => assert.match(s2.text, /667/))
  report('wire: effort high', () => assert.equal(wire.at(-1)?.reasoning_effort, 'high'))

  // The rung 4.5's integration never had: canonical 'max' must reach the wire
  // as 'xhigh' (xAI 400s on a literal 'max'), so a 400 here IS the failure.
  console.log('single mode — max effort (canonical max → wire xhigh)')
  const s3 = await drive({
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: 'How many distinct primes divide 2026? Reply with just the number.'
      }
    ],
    thinkingMode: 'max'
  })
  report('no errors at max (xhigh accepted)', () => assert.deepEqual(s3.errors, []))
  // 2026 = 2 × 1013, and 1013 is prime (no factor ≤ 31) → exactly 2.
  report('correct answer', () => assert.match(s3.text, /\b2\b/))
  report('wire: effort xhigh', () => assert.equal(wire.at(-1)?.reasoning_effort, 'xhigh'))

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
      content: '2026-08-13T21:37:00+03:00'
    }
  ]
  const t2 = await drive({ system: SYSTEM, messages: followup, thinkingMode: 'on', tools })
  report('final answer uses tool result', () => assert.match(t2.text, /21:37|9:37/))
  report('round trip ends cleanly', () => assert.equal(t2.stopReason, 'end_turn'))

  console.log('single mode — vision (image block)')
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
  report('sees the image', () => assert.match(v1.text.toLowerCase(), /red/))

  // ════ WORKFLOW MODE ═════════════════════════════════════════════════
  // Real WorkflowSession; runAgentTurn feeds each agent through the real
  // thalamus with role 'agent', which clamps the master's chosen effort to
  // the model's registry entry before the request is built. grok-4.6 now
  // honours 'max' (→ xhigh) but still has no 'off' rung.
  console.log('workflow mode — agents with clamped efforts')
  const runAgentTurn: RunAgentTurn = async (args) => {
    const res = await drive({
      system:
        'You are a focused wolffish workflow sub-agent. Complete the task in one short reply.',
      messages: args.history,
      thinkingMode: args.effort,
      role: 'agent',
      signal: args.signal
    })
    args.onLlmCall('xai', MODEL, {
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
    'wf_e2e_grok46',
    runAgentTurn,
    () => ({ provider: 'xai', model: MODEL }),
    () => {}
  )
  session.plan(['verify'], 'grok-4.6 live e2e')

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
  report('wire: max survives as xhigh for agent', () =>
    assert.equal(wire.at(-1)?.reasoning_effort, 'xhigh')
  )

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
  report('wire: off clamped to on → low for agent', () =>
    assert.equal(wire.at(-1)?.reasoning_effort, 'low')
  )

  const snap = session.snapshot()
  report('workflow snapshot: both agents completed', () => {
    assert.equal(snap.agents.length, 2)
    assert.ok(snap.agents.every((ag) => ag.status === 'completed'))
  })

  report('every wire call targeted grok-4.6 with a valid ladder rung', () => {
    // 6 single-mode turns (on, high, max, tool call, tool result, vision)
    // + 2 workflow agents.
    assert.ok(wire.length >= 8, `only ${wire.length} wire calls`)
    const valid = new Set(['low', 'high', 'xhigh'])
    for (const w of wire) {
      assert.equal(w.model, MODEL)
      assert.ok(valid.has(w.reasoning_effort ?? ''), `bad effort ${w.reasoning_effort}`)
      assert.equal(w.stream, true)
    }
  })
  report('all three rungs were exercised', () => {
    const seen = new Set(wire.map((w) => w.reasoning_effort))
    for (const rung of ['low', 'high', 'xhigh']) assert.ok(seen.has(rung), `never sent ${rung}`)
  })

  console.log(
    failures === 0
      ? `\nALL PASS — ${wire.length} live grok-4.6 calls through the wolffish pipeline`
      : `\n${failures} FAILURE(S)`
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('harness crashed:', err)
  process.exit(1)
})
