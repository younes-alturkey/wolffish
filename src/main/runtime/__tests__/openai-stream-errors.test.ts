/**
 * OpenAIProvider stream errors: an `error` / `response.failed` event that
 * arrives before anything reached the user is THROWN, so thalamus retries
 * the transient ones exactly like an HTTP 5xx ("Our servers are currently
 * overloaded" ended a run 11 s in, 2026-10-13). After text or a tool call
 * has gone out it stays a terminal error chunk — a retry would replay it.
 * Also: reasoning and message items come back as one provider_reasoning
 * chunk, and replay sends them verbatim (phase included) for the same model
 * only, with the volatile tail as a developer message.
 *
 * Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx \
 *     src/main/runtime/__tests__/openai-stream-errors.test.ts
 */
import { OpenAIProvider } from '../providers/openai'
import type { ChatMessage, StreamChunk } from '../thalamus'

let passed = 0
let failed = 0
function ok(name: string, cond: boolean, detail?: unknown): void {
  if (cond) passed++
  else {
    failed++
    console.log(`  ✗ ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

let lastBody: Record<string, unknown> = {}
function serve(events: unknown[]): void {
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    lastBody = JSON.parse(init?.body ?? '{}')
    const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
    return new Response(text, { status: 200 })
  }) as typeof fetch
}

async function collect(
  messages: ChatMessage[] = [{ role: 'user', content: 'hi' }],
  model = 'gpt-6.1-sol'
): Promise<{ chunks: StreamChunk[]; thrown: string | null }> {
  const provider = new OpenAIProvider('k', model)
  const chunks: StreamChunk[] = []
  try {
    for await (const c of provider.stream({
      system: 's',
      messages,
      tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
      thinkingMode: 'high'
    })) {
      chunks.push(c)
    }
    return { chunks, thrown: null }
  } catch (err) {
    return { chunks, thrown: err instanceof Error ? err.message : String(err) }
  }
}

const overloaded = { type: 'error', message: 'Our servers are currently overloaded.' }

async function main(): Promise<void> {
  serve([overloaded])
  const early = await collect()
  ok('an error before any output throws', early.thrown?.includes('overloaded') === true, early)

  serve([{ type: 'response.failed', response: { error: { message: 'server_error' } } }])
  const failedEarly = await collect()
  ok('response.failed before any output throws', failedEarly.thrown !== null, failedEarly)

  serve([{ type: 'response.output_text.delta', delta: 'Checking FDA…' }, overloaded])
  const late = await collect()
  ok('after text it is a terminal chunk, not a throw', late.thrown === null)
  ok(
    'the terminal chunk carries the message',
    late.chunks.some((c) => c.type === 'error' && c.message.includes('overloaded'))
  )

  const reasoningItem = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' }
  const messageItem = {
    type: 'message',
    id: 'msg_1',
    role: 'assistant',
    phase: 'commentary',
    content: [{ type: 'output_text', text: 'Checking FDA first.' }]
  }
  serve([
    { type: 'response.output_item.done', item: reasoningItem },
    { type: 'response.output_text.delta', delta: 'Checking FDA first.' },
    { type: 'response.output_item.done', item: messageItem },
    {
      type: 'response.output_item.done',
      item: { type: 'function_call', call_id: 'c1', name: 't', arguments: '{}' }
    },
    { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } }
  ])
  const ok1 = await collect()
  ok(
    'include asks for encrypted reasoning',
    JSON.stringify(lastBody.include) === '["reasoning.encrypted_content"]'
  )
  ok(
    'instructions carry the progress-notes rule when tools are sent',
    String(lastBody.instructions).includes('<progress_notes>')
  )
  const state = ok1.chunks.find((c) => c.type === 'provider_reasoning')
  const items = state?.type === 'provider_reasoning' ? state.reasoning.items : []
  ok('reasoning + message items captured in order', items.length === 2, items)
  ok(
    'the message item keeps its phase and drops its id',
    (items[1] as { phase?: string; id?: string })?.phase === 'commentary' &&
      (items[1] as { id?: string })?.id === undefined,
    items[1]
  )

  const history: ChatMessage[] = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: 'Checking FDA first.',
      toolUses: [{ id: 'c1', name: 't', args: {} }],
      providerReasoning: state?.type === 'provider_reasoning' ? state.reasoning : undefined
    },
    { role: 'tool', toolUseId: 'c1', toolName: 't', content: 'ok' },
    { role: 'user', content: '<runtime>2</runtime>', volatile: true }
  ]
  serve([{ type: 'response.completed', response: {} }])
  await collect(history)
  const input = lastBody.input as Array<Record<string, unknown>>
  ok(
    'replay order: user, reasoning, message (phase), function_call, output, developer tail',
    JSON.stringify(input.map((i) => i.type ?? i.role)) ===
      JSON.stringify([
        'user',
        'reasoning',
        'message',
        'function_call',
        'function_call_output',
        'developer'
      ]),
    input.map((i) => i.type ?? i.role)
  )
  ok(
    'the prose is not sent twice',
    !input.some((i) => i.role === 'assistant' && typeof i.content === 'string')
  )

  await collect(history, 'gpt-6-luna')
  const other = lastBody.input as Array<Record<string, unknown>>
  ok(
    'another model gets plain prose and no reasoning items',
    !other.some((i) => i.type === 'reasoning') &&
      other.some((i) => i.role === 'assistant' && i.content === 'Checking FDA first.'),
    other.map((i) => i.type ?? i.role)
  )

  // Tool universe: the whole list ships as `tools` (stable prefix), the
  // callable subset rides tool_choice.allowed_tools.
  {
    const def = (
      name: string
    ): { name: string; description: string; parameters: Record<string, unknown> } => ({
      name,
      description: name,
      parameters: { type: 'object' }
    })
    const universe = ['a', 'b', 'c', 'd'].map(def)
    serve([{ type: 'response.completed', response: {} }])
    const provider = new OpenAIProvider('k', 'gpt-6.1-sol')
    for await (const _ of provider.stream({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [def('a'), def('z')],
      toolUniverse: universe
    }))
      void _
    const names = (lastBody.tools as Array<{ name: string }>).map((t) => t.name)
    ok(
      'universe ships as tools, an allowed tool it lacks is appended',
      names.join() === 'a,b,c,d,z',
      names
    )
    const choice = lastBody.tool_choice as {
      type: string
      mode: string
      tools: Array<{ name: string }>
    }
    ok(
      'the callable subset rides allowed_tools',
      choice?.type === 'allowed_tools' &&
        choice.mode === 'auto' &&
        choice.tools.map((t) => t.name).join() === 'a,z',
      choice
    )

    serve([{ type: 'response.completed', response: {} }])
    for await (const _ of provider.stream({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [def('a')]
    }))
      void _
    ok(
      'without a universe: the exposed set, no tool_choice',
      (lastBody.tools as unknown[]).length === 1 && lastBody.tool_choice === undefined
    )
  }

  console.log(`${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void main()
