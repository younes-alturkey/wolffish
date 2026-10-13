/**
 * LIVE end-to-end verification of an OpenAI model through wolffish's real
 * pipeline: Thalamus (Brain resolution, agent-role reasoning clamp, retry
 * policy) → OpenAIProvider (Responses API request building, SSE parsing,
 * tool assembly) → production OpenAI API — in BOTH wolffish modes (single +
 * workflow).
 *
 * The provider moved from chat/completions to /v1/responses on 2026-10-12
 * because the gpt-6 line refuses function tools on chat/completions
 * (gpt-6-astra / gpt-6.1-sol outright; the rest only with effort none).
 * This harness pins the two things that migration must keep true: tools +
 * reasoning on the same turn, and the canonical [on, high, max] scale
 * landing on the rung each family accepts (medium / high / max|xhigh) —
 * asserted at the wire via a fetch tap, not inferred.
 *
 * Key comes from OPENAI_API_KEY — never from ~/.wolffish (that folder is a
 * build artifact and tests must not read it). OPENAI_E2E_MODEL picks the
 * model (default gpt-6.1-sol, an always-on reasoner; gpt-6-sol exercises the
 * 'off' rung).
 *
 * Run: OPENAI_API_KEY=... TSX_TSCONFIG_PATH=tsconfig.node.json \
 *        ELECTRON_RUN_AS_NODE=1 npx electron <tsx>/dist/cli.mjs \
 *        src/main/runtime/__tests__/e2e-openai-live.boot.ts
 * (electron-as-node because thalamus.ts imports electron's net module)
 */
import assert from 'node:assert/strict'
import { LocalProvider } from '@main/runtime/providers/local'
import { reasoningModesFor } from '@main/runtime/reasoning'
import { Thalamus } from '@main/runtime/thalamus'
import type { ChatMessage, StreamChunk, ToolUse } from '@main/runtime/thalamus'
import { WorkflowSession, type RunAgentTurn } from '@main/runtime/workflow'

const MODEL = process.env.OPENAI_E2E_MODEL ?? 'gpt-6.1-sol'

const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) {
  console.error('set OPENAI_API_KEY to run this harness')
  process.exit(1)
}

// ── wire tap: capture what wolffish actually sends to api.openai.com ─────
type WireCall = {
  url: string
  model: string
  effort?: string
  max_output_tokens?: number
  stream?: boolean
  tools?: number
  inputTypes: string[]
}
const wire: WireCall[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.includes('api.openai.com') && typeof init?.body === 'string') {
    const body = JSON.parse(init.body) as {
      model: string
      reasoning?: { effort?: string }
      max_output_tokens?: number
      stream?: boolean
      tools?: unknown[]
      input?: Array<{ type?: string; role?: string }>
    }
    wire.push({
      url,
      model: body.model,
      effort: body.reasoning?.effort,
      max_output_tokens: body.max_output_tokens,
      stream: body.stream,
      tools: body.tools?.length,
      inputTypes: (body.input ?? []).map((i) => i.type ?? i.role ?? '?')
    })
  }
  return realFetch(input, init)
}) as typeof fetch

// ── the real Thalamus, Brain pointed at MODEL ────────────────────────────
const thalamus = new Thalamus(new LocalProvider())
thalamus.setCloudProviders([{ id: 'openai', model: MODEL, apiKey }])
thalamus.setBrain({ providerId: 'openai', model: MODEL })

const modes = reasoningModesFor('openai', MODEL)
const alwaysOn = modes.length > 0 && !modes.includes('off')
const topRung = /^gpt-(6|5\.6)/.test(MODEL) ? 'max' : /^gpt-5\.[245]/.test(MODEL) ? 'xhigh' : 'high'
const onRung = 'medium'

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
// 256x256 solid red PNG (RGB, zlib-compressed). OpenAI validates the PNG
// structure — a hand-trimmed stub that xAI tolerates is rejected here — and
// the smaller models misname a 32px swatch, so the fixture is full-size.
const RED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAB+0lEQVR42u3TQQkAAAjAwPUvrX8reHAJBmsK3pIAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgAJMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAyAASTAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADADHAllMDvLkz2XNAAAAAElFTkSuQmCC'

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
  console.log(`registry — ${MODEL} exposes [${modes.join(', ')}]`)
  report('model is a reasoner with a high rung', () => assert.ok(modes.includes('high')))

  console.log(`single mode — plain turn (brain mode: on → wire effort ${onRung})`)
  const s1 = await drive({
    system: SYSTEM,
    messages: [{ role: 'user', content: 'Reply with exactly: ready' }],
    thinkingMode: 'on'
  })
  report(`resolves to openai/${MODEL}`, () => assert.equal(s1.activeModel, `openai/${MODEL}`))
  report('no errors', () => assert.deepEqual(s1.errors, []))
  report('text answer', () => assert.match(s1.text.toLowerCase(), /ready/))
  report('clean stop + usage', () => assert.ok(s1.stopReason === 'end_turn' && s1.outputTokens > 0))
  report('wire: /v1/responses, streaming, effort medium', () => {
    const w = wire.at(-1)
    assert.ok(w?.url.endsWith('/v1/responses'), w?.url)
    assert.equal(w?.stream, true)
    assert.equal(w?.effort, onRung)
    assert.ok((w?.max_output_tokens ?? 0) >= 100_000)
  })

  console.log('single mode — high effort math')
  const s2 = await drive({
    system: SYSTEM,
    messages: [{ role: 'user', content: 'What is 23*29? Reply with just the number.' }],
    thinkingMode: 'high'
  })
  report('correct answer', () => assert.match(s2.text, /667/))
  report('wire: effort high', () => assert.equal(wire.at(-1)?.effort, 'high'))

  console.log(`single mode — max effort (canonical max → wire ${topRung})`)
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
  report('no errors at max', () => assert.deepEqual(s3.errors, []))
  // 2026 = 2 × 1013, and 1013 is prime (no factor ≤ 31) → exactly 2.
  report('correct answer', () => assert.match(s3.text, /\b2\b/))
  report(`wire: effort ${topRung}`, () => assert.equal(wire.at(-1)?.effort, topRung))
  // Summaries only appear once the model has reasoned enough to summarise —
  // the API returns an empty summary on short chains — so this is
  // informational, not a gate.
  console.log(`  info reasoning summary chars at max: ${s3.reasoningChars}`)

  if (!alwaysOn) {
    console.log('single mode — off (wire effort none)')
    const s4 = await drive({
      system: SYSTEM,
      messages: [{ role: 'user', content: 'Reply with exactly: quiet' }],
      thinkingMode: 'off'
    })
    report('no errors at off', () => assert.deepEqual(s4.errors, []))
    report('wire: effort none', () => assert.equal(wire.at(-1)?.effort, 'none'))
    report('no reasoning streamed', () => assert.equal(s4.reasoningChars, 0))
  }

  // The whole reason for the Responses migration: tools AND reasoning on
  // one request. On chat/completions this exact call 400s for every gpt-6.
  console.log('single mode — tool-call round trip with reasoning on')
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
    thinkingMode: 'high',
    tools
  })
  report('no errors with tools + effort high', () => assert.deepEqual(t1.errors, []))
  report('emits tool_call', () => {
    assert.equal(t1.toolCalls.length, 1)
    assert.equal(t1.toolCalls[0].name, 'get_current_time')
  })
  report('stop reason tool_use', () => assert.equal(t1.stopReason, 'tool_use'))
  report('wire: tools sent alongside effort high', () => {
    const w = wire.at(-1)
    assert.equal(w?.tools, 1)
    assert.equal(w?.effort, 'high')
  })
  const followup: ChatMessage[] = [
    { role: 'user', content: 'What time is it in Riyadh right now? Use the tool.' },
    { role: 'assistant', content: t1.text, toolUses: t1.toolCalls },
    {
      role: 'tool',
      toolUseId: t1.toolCalls[0]?.id ?? 'call_0',
      toolName: 'get_current_time',
      content: '2026-10-12T21:37:00+03:00'
    }
  ]
  const t2 = await drive({ system: SYSTEM, messages: followup, thinkingMode: 'high', tools })
  report('final answer uses tool result', () => assert.match(t2.text, /21:37|9:37/))
  report('round trip ends cleanly', () => assert.equal(t2.stopReason, 'end_turn'))
  report('wire: history replayed as function_call + function_call_output items', () => {
    const w = wire.at(-1)
    assert.deepEqual(w?.inputTypes, ['user', 'function_call', 'function_call_output'])
  })

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
  report('no errors with image input', () => assert.deepEqual(v1.errors, []))
  report('sees the image', () => assert.match(v1.text.toLowerCase(), /red|orange|pink/))

  // ════ WORKFLOW MODE ═════════════════════════════════════════════════
  // Real WorkflowSession; runAgentTurn feeds each agent through the real
  // thalamus with role 'agent', which clamps the master's chosen effort to
  // the model's registry entry before the request is built.
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
    args.onLlmCall('openai', MODEL, {
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
    'wf_e2e_openai',
    runAgentTurn,
    () => ({ provider: 'openai', model: MODEL }),
    () => {}
  )
  session.plan(['verify'], `${MODEL} live e2e`)

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
  report(`wire: max survives as ${topRung} for agent`, () =>
    assert.equal(wire.at(-1)?.effort, topRung)
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
  const offRung = alwaysOn ? onRung : 'none'
  report(`wire: off ${alwaysOn ? 'clamped to on → ' : '→ '}${offRung} for agent`, () =>
    assert.equal(wire.at(-1)?.effort, offRung)
  )

  const snap = session.snapshot()
  report('workflow snapshot: both agents completed', () => {
    assert.equal(snap.agents.length, 2)
    assert.ok(snap.agents.every((ag) => ag.status === 'completed'))
  })

  report(`every wire call targeted ${MODEL} on /v1/responses with a valid rung`, () => {
    assert.ok(wire.length >= 8, `only ${wire.length} wire calls`)
    const valid = new Set(['none', 'medium', 'high', 'xhigh', 'max'])
    for (const w of wire) {
      assert.equal(w.model, MODEL)
      assert.ok(w.url.endsWith('/v1/responses'), w.url)
      assert.ok(valid.has(w.effort ?? ''), `bad effort ${w.effort}`)
      assert.equal(w.stream, true)
    }
  })

  console.log(
    failures === 0
      ? `\nALL PASS — ${wire.length} live ${MODEL} calls through the wolffish pipeline`
      : `\n${failures} FAILURE(S)`
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('harness crashed:', err)
  process.exit(1)
})
