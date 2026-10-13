/**
 * LIVE: the OpenAI provider keeps a tool loop's reasoning and its prompt
 * cache — the two things the Responses migration had lost (2026-10-13).
 *
 * 1. Reasoning survives a tool round-trip. With store:false, nothing lives
 *    server-side, so unless the encrypted reasoning items are echoed back
 *    the model starts every iteration of the agent loop blank. Probe: the
 *    model privately picks a 6-digit number, commits only its digit sum
 *    through a tool, and after the tool result must name the number. The
 *    answer has to match the committed sum (a guess almost never does).
 * 2. The prompt cache grows across iterations even though every request
 *    ends with the volatile runtime tail. A trailing user message froze the
 *    cache at the instructions; the provider now sends it as developer.
 *
 * 3. The model narrates: a visible progress line on every tool step, even
 *    under a prompt that says "execute silently" (the provider restates
 *    the doctrine's progress-notes rule), and its phased message items
 *    replay without error.
 *
 * 4. With a tool universe pinned, the cache keeps growing across an
 *    allowed-tools change, and a tool outside allowed_tools is never called.
 *
 * All run through the real OpenAIProvider + Wernicke with the agent's own
 * message shapes (providerReasoning on the assistant turn, `volatile` tail).
 *
 * Run: OPENAI_API_KEY=... TSX_TSCONFIG_PATH=tsconfig.node.json \
 *        npx tsx src/main/runtime/__tests__/e2e-openai-reasoning-live.ts
 * OPENAI_E2E_MODEL picks the model (default gpt-6.1-sol).
 */
import { OpenAIProvider } from '@main/runtime/providers/openai'
import type { ChatMessage, ToolDefinition } from '@main/runtime/thalamus'
import { Wernicke, type ParsedResponse } from '@main/runtime/wernicke'

const MODEL = process.env.OPENAI_E2E_MODEL ?? 'gpt-6.1-sol'
const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) {
  console.error('set OPENAI_API_KEY to run this harness')
  process.exit(1)
}

let passed = 0
let failed = 0
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) passed++
  else failed++
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const provider = new OpenAIProvider(apiKey, MODEL)
const wernicke = new Wernicke()
let lastCached = 0
let lastInput = 0

async function call(
  system: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  cacheKey?: string,
  toolUniverse?: ToolDefinition[]
): Promise<ParsedResponse> {
  const stream = provider.stream({
    system,
    messages,
    tools,
    toolUniverse,
    thinkingMode: 'high',
    cacheKey
  })
  async function* tap(): ReturnType<typeof provider.stream> {
    for await (const chunk of stream) {
      if (chunk.type === 'turn_meta' && chunk.usage) {
        lastCached = chunk.usage.cacheReadTokens ?? 0
        lastInput = chunk.usage.inputTokens + lastCached
      }
      yield chunk
    }
  }
  const parsed = await wernicke.parse(tap())
  if (parsed.error) throw new Error(parsed.error)
  return parsed
}

function assistantOf(parsed: ParsedResponse): ChatMessage {
  const msg: ChatMessage = {
    role: 'assistant',
    content: parsed.text,
    toolUses: parsed.toolCalls.map((t) => ({ id: t.id, name: t.name, args: t.args }))
  }
  if (parsed.providerReasoning) msg.providerReasoning = parsed.providerReasoning
  return msg
}

async function recall(run: number): Promise<void> {
  const tools: ToolDefinition[] = [
    {
      name: 'commit',
      description: 'Commit the digit sum of the number you privately picked.',
      parameters: {
        type: 'object',
        properties: { digit_sum: { type: 'integer' } },
        required: ['digit_sum']
      }
    }
  ]
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content:
        'Privately, in your head only, pick a random 6-digit number. Never write it in visible text ' +
        'or a tool argument. Call commit with the sum of its digits (the sum only). After the tool ' +
        'returns, reply with ONLY the 6-digit number, or FORGOT if you cannot recall it.'
    }
  ]
  const first = await call('You are a test subject. Follow the user exactly.', messages, tools)
  const commit = first.toolCalls.find((t) => t.name === 'commit')
  if (!commit) {
    ok(`recall #${run}: model called commit`, false, first.text.slice(0, 80))
    return
  }
  ok(`recall #${run}: reasoning items captured`, !!first.providerReasoning?.items.length)
  messages.push(assistantOf(first))
  messages.push({ role: 'tool', toolUseId: commit.id, toolName: 'commit', content: 'committed' })
  messages.push({ role: 'user', content: '<runtime>Tool iteration 2.</runtime>', volatile: true })
  const second = await call('You are a test subject. Follow the user exactly.', messages, tools)
  const answer = second.text.match(/\d{6}/)?.[0]
  const sum = Number(commit.args.digit_sum)
  const answerSum = answer ? [...answer].reduce((a, d) => a + Number(d), 0) : -1
  ok(
    `recall #${run}: answer matches the committed digit sum`,
    answerSum === sum,
    `sum=${sum} answer=${second.text.trim().slice(0, 20)}`
  )
}

async function cacheGrowth(): Promise<void> {
  const system =
    'You are a careful research agent.\n' +
    Array.from({ length: 400 }, (_, i) => `Rule ${i}: follow procedure ${i * 7} precisely.`).join(
      '\n'
    )
  const tools: ToolDefinition[] = [
    {
      name: 'read_source',
      description: 'Read source number n.',
      parameters: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] }
    }
  ]
  const history: ChatMessage[] = [
    {
      role: 'user',
      content:
        'Call read_source for n=1, then 2, then 3, then 4, one call per step, never in parallel. ' +
        'After the fourth, reply DONE.'
    }
  ]
  const cacheKey = `e2e-cache-${Date.now()}`
  const cached: number[] = []
  for (let it = 1; it <= 5; it++) {
    const outbound: ChatMessage[] = [
      ...history,
      { role: 'user', content: `<runtime>Tool iteration ${it}.</runtime>`, volatile: true }
    ]
    const parsed = await call(system, outbound, tools, cacheKey)
    cached.push(lastCached)
    console.log(`    iteration ${it}: input=${lastInput} cached=${lastCached}`)
    if (parsed.toolCalls.length === 0) break
    history.push(assistantOf(parsed))
    for (const tc of parsed.toolCalls) {
      history.push({
        role: 'tool',
        toolUseId: tc.id,
        toolName: tc.name,
        content: `Source ${tc.args.n}: ` + 'lorem ipsum dolor sit amet '.repeat(300)
      })
    }
  }
  const grew = cached.slice(2).every((c, i) => c > cached[i + 1])
  ok(
    'cache grows every iteration despite the volatile tail',
    cached.length >= 4 && grew,
    cached.join(' → ')
  )
}

async function narration(): Promise<void> {
  const tools: ToolDefinition[] = [
    {
      name: 'fetch_page',
      description: 'Fetch a web page by URL and return its text.',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
    }
  ]
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content:
        'Execute silently: no intro, no status commentary. Check https://fda.gov/safety, then ' +
        'https://ema.europa.eu, then https://gov.uk/drug-device-alerts, one fetch per step, then ' +
        'summarise in two lines what changed this week.'
    }
  ]
  let steps = 0
  let narrated = 0
  for (let it = 1; it <= 6; it++) {
    const parsed = await call('You are an autonomous research agent.', messages, tools)
    if (parsed.toolCalls.length === 0) {
      ok(
        'final answer after the tool steps',
        parsed.text.trim().length > 0,
        parsed.text.slice(0, 60)
      )
      break
    }
    steps++
    if (parsed.text.trim()) narrated++
    console.log(`    step ${it}: ${JSON.stringify(parsed.text.trim().slice(0, 80))}`)
    messages.push(assistantOf(parsed))
    for (const tc of parsed.toolCalls) {
      messages.push({
        role: 'tool',
        toolUseId: tc.id,
        toolName: tc.name,
        content: `Page ${tc.args.url}: no new alerts in 48 hours except a class 2 propofol lot recall.`
      })
    }
  }
  ok('a progress line on every tool step', steps >= 2 && narrated === steps, `${narrated}/${steps}`)
}

async function scenarios(): Promise<void> {
  // Plain chat, no tools: text must arrive as a stream, not one final blob.
  {
    let deltas = 0
    let text = ''
    for await (const c of provider.stream({
      system: 'Be concise.',
      messages: [
        { role: 'user', content: 'In four short sentences, explain what a prompt cache is.' }
      ],
      thinkingMode: 'on'
    })) {
      if (c.type === 'text') {
        deltas++
        text += c.text
      }
    }
    ok(
      'no-tools chat streams text in many deltas',
      deltas > 5 && text.length > 80,
      `${deltas} deltas`
    )
  }

  const weather: ToolDefinition = {
    name: 'get_weather',
    description: 'Current weather for a city.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
  }
  const runLoop = async (
    prompt: string,
    tools: ToolDefinition[],
    answer: (name: string, args: Record<string, unknown>) => { content: string; isError?: boolean }
  ): Promise<{ steps: number[]; final: string; calls: number }> => {
    const messages: ChatMessage[] = [{ role: 'user', content: prompt }]
    const steps: number[] = []
    let calls = 0
    for (let i = 0; i < 6; i++) {
      const parsed = await call('You are a helpful agent.', messages, tools)
      if (parsed.toolCalls.length === 0) return { steps, final: parsed.text, calls }
      steps.push(parsed.toolCalls.length)
      calls += parsed.toolCalls.length
      messages.push(assistantOf(parsed))
      for (const tc of parsed.toolCalls) {
        const r = answer(tc.name, tc.args)
        messages.push({
          role: 'tool',
          toolUseId: tc.id,
          toolName: tc.name,
          content: r.content,
          isError: r.isError
        })
      }
    }
    return { steps, final: '', calls }
  }

  const single = await runLoop('What is the weather in Riyadh right now?', [weather], () => ({
    content: 'Riyadh: 41°C, clear, wind 12 km/h'
  }))
  ok(
    'single tool call, then an answer that uses it',
    single.calls === 1 && /41/.test(single.final),
    `calls=${single.calls} final=${single.final.slice(0, 60)}`
  )

  const parallel = await runLoop(
    'Get the current weather in Riyadh, Tokyo and Oslo, then tell me which is warmest.',
    [weather],
    (_n, args) => ({
      content: `${String(args.city)}: ${{ Riyadh: 41, Tokyo: 22, Oslo: 6 }[String(args.city)] ?? 15}°C`
    })
  )
  ok(
    'parallel calls in one step, then an answer',
    parallel.steps[0] >= 3 && /riyadh/i.test(parallel.final),
    `steps=${JSON.stringify(parallel.steps)} final=${parallel.final.slice(0, 60)}`
  )

  const failing = await runLoop('What is the weather in Riyadh right now?', [weather], () => ({
    content: 'ERROR: weather service unavailable (HTTP 503)',
    isError: true
  }))
  ok(
    'a failing tool ends in an honest answer, not a loop',
    failing.final.length > 0 && failing.calls <= 3,
    `calls=${failing.calls} final=${failing.final.slice(0, 70)}`
  )

  // Abort mid-stream: the stream must stop promptly once the signal fires.
  {
    const controller = new AbortController()
    const startedAt = Date.now()
    let sawText = false
    let aborted = false
    try {
      for await (const c of provider.stream({
        system: 'Be thorough.',
        messages: [{ role: 'user', content: 'Write 600 words about the history of anaesthesia.' }],
        thinkingMode: 'on',
        signal: controller.signal
      })) {
        if (c.type === 'text' && !sawText) {
          sawText = true
          setTimeout(() => controller.abort(), 300)
        }
      }
    } catch (err) {
      aborted = err instanceof Error && /abort/i.test(err.name + err.message)
    }
    ok(
      'abort mid-stream stops the stream',
      sawText && aborted,
      `after ${Date.now() - startedAt} ms`
    )
  }
}

async function universeCache(): Promise<void> {
  // 120 realistic-size dummy tools stand in for the capability universe; the
  // agent's exposed subset grows mid-loop the way tool_activate grows it.
  const def = (name: string, description: string): ToolDefinition => ({
    name,
    description,
    parameters: { type: 'object', properties: { n: { type: 'integer' } } }
  })
  const universe: ToolDefinition[] = [
    def('read_source', 'Read source number n.'),
    def('summarize_source', 'Summarize source number n.'),
    ...Array.from({ length: 120 }, (_, i) =>
      def(`cap${Math.floor(i / 10)}_tool${i % 10}`, 'Does one specific job well. '.repeat(10))
    )
  ]
  const system = 'You are an agent.\n' + 'Policy line. '.repeat(600)
  const cacheKey = `e2e-universe-${Date.now()}`
  const history: ChatMessage[] = [
    {
      role: 'user',
      content:
        'Call read_source for n=1, then n=2, then summarize_source for n=1 and n=2, one call ' +
        'per step. Then reply DONE.'
    }
  ]
  const cached: number[] = []
  let allowed = [universe[0]]
  for (let it = 1; it <= 5; it++) {
    // The second capability "activates" after the first step.
    if (it === 2) allowed = [universe[0], universe[1]]
    const stream = provider.stream({
      system,
      messages: [
        ...history,
        { role: 'user', content: `<runtime>step ${it}</runtime>`, volatile: true }
      ],
      tools: allowed,
      toolUniverse: universe,
      thinkingMode: 'on',
      cacheKey
    })
    async function* tap(): ReturnType<typeof provider.stream> {
      for await (const c of stream) {
        if (c.type === 'turn_meta' && c.usage) lastCached = c.usage.cacheReadTokens ?? 0
        yield c
      }
    }
    const parsed = await wernicke.parse(tap())
    if (parsed.error) throw new Error(parsed.error)
    cached.push(lastCached)
    if (parsed.toolCalls.length === 0) break
    history.push(assistantOf(parsed))
    for (const tc of parsed.toolCalls) {
      history.push({
        role: 'tool',
        toolUseId: tc.id,
        toolName: tc.name,
        content: `ok ${tc.args.n}`
      })
    }
  }
  ok(
    'cache keeps growing across an allowed-tools change',
    cached.length >= 3 && cached.slice(2).every((c, i) => c > cached[i + 1]),
    cached.join(' → ')
  )

  const blocked = await call(
    system,
    [{ role: 'user', content: 'Call cap5_tool3 with n=1 right now.' }],
    [universe[0]],
    undefined,
    universe
  ).catch((err: Error) => ({ toolCalls: [], text: err.message }) as unknown as ParsedResponse)
  ok(
    'a tool outside allowed_tools is never called',
    !blocked.toolCalls.some((t) => t.name === 'cap5_tool3'),
    blocked.toolCalls.map((t) => t.name).join() || blocked.text.slice(0, 60)
  )
}

async function main(): Promise<void> {
  console.log(`OpenAI reasoning + cache — ${MODEL}`)
  for (let run = 1; run <= 3; run++) await recall(run)
  await cacheGrowth()
  await narration()
  await scenarios()
  await universeCache()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
