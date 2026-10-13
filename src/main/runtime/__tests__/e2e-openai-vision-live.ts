/**
 * LIVE vision sweep for the OpenAI catalogue: does every model the picker
 * offers actually read an image when wolffish sends one, and do the
 * vision.ts gates (`cloudModelSupportsVision`,
 * `cloudModelSupportsToolResultImages`) agree with the API on each?
 *
 * Production shape first: each model is driven through the REAL Thalamus
 * (gates, image pruning, reject ladder) → OpenAIProvider (Responses API
 * request builder, SSE parser) with
 *   - a user image            — `input_image` part in a user message
 *   - a tool-result image     — `input_image` inside `function_call_output`,
 *     the path image_view / screenshots take. User-message vision does not
 *     imply this one (o1 500s on it).
 * Both must come back naming what is in the fixture, and the wire must
 * carry the data-URI part wherever the gate says the model can see.
 *
 * Then the negative gates are checked against the raw provider (no
 * Thalamus, so nothing is stripped): a gated-off model must actually be
 * rejected / broken by the API — if it answers, the gate is too strict.
 *
 * Fixture: fixtures/openai-vision-probe.jpg, 640x320 JPEG q70 — big text
 * "WOLFFISH 4271" and a green circle. Flat synthetic swatches are NOT a
 * valid probe: gpt-6-luna names a solid #FF0000 "purple"/"black" and a
 * red/green/blue stripe image "blue, blue, blue" (2026-10-13, every run)
 * while reading real screenshots and this fixture perfectly.
 *
 * Also lists /v1/models ids in the gpt/o families that the catalogue does
 * not carry, plus catalogue ids with a `shutdown_date`.
 *
 * Key from OPENAI_API_KEY — never from ~/.wolffish. OPENAI_E2E_MODELS
 * (comma-separated) narrows the sweep.
 *
 * Run: OPENAI_API_KEY=... TSX_TSCONFIG_PATH=tsconfig.node.json \
 *        ELECTRON_RUN_AS_NODE=1 npx electron <tsx>/dist/cli.mjs \
 *        src/main/runtime/__tests__/e2e-openai-vision-live.boot.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LocalProvider } from '@main/runtime/providers/local'
import { OpenAIProvider } from '@main/runtime/providers/openai'
import { Thalamus } from '@main/runtime/thalamus'
import type {
  ChatMessage,
  ProviderStreamOptions,
  StreamChunk,
  ToolDefinition
} from '@main/runtime/thalamus'
import {
  cloudModelSupportsToolResultImages,
  cloudModelSupportsVision,
  isModalityReject
} from '@main/runtime/vision'

const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) {
  console.error('set OPENAI_API_KEY to run this harness')
  process.exit(1)
}

// Mirrors the openai block of renderer/pages/settings/modelCatalog.ts.
const CATALOG = [
  'gpt-6.1-sol',
  'gpt-6-luna',
  'gpt-6-sol',
  'gpt-6-astra',
  'gpt-5.6-luna',
  'gpt-5.6-terra',
  'gpt-5.6-sol',
  'chat-latest',
  'gpt-5.5',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.4',
  'gpt-5.2',
  'gpt-5.1',
  'gpt-5-nano',
  'gpt-5-mini',
  'gpt-5',
  'gpt-4.1-nano',
  'gpt-4.1-mini',
  'gpt-4.1',
  'o4-mini',
  'o3',
  'o3-mini',
  'o1',
  'gpt-4o-mini',
  'gpt-4o',
  'gpt-4-turbo',
  'gpt-4'
]
const MODELS = (process.env.OPENAI_E2E_MODELS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const SWEEP = MODELS.length > 0 ? MODELS : CATALOG

const PROBE_JPEG = readFileSync(join(__dirname, 'fixtures', 'openai-vision-probe.jpg')).toString(
  'base64'
)
const IMAGE = { mediaType: 'image/jpeg', data: PROBE_JPEG }
const QUESTION =
  'Transcribe the large text in this image exactly, then name the colour and shape of the figure in it. One line.'
const SEES = (text: string): boolean =>
  /4271/.test(text) && /green/i.test(text) && /circle/i.test(text)
const SYSTEM = 'You are a concise assistant. Follow instructions exactly.'

const TOOL: ToolDefinition = {
  name: 'image_view',
  description: 'View an image file and return its pixels.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path']
  }
}

// ── wire tap: per request, did the input carry an input_image part? ─────
type Wire = { model: string; userImage: boolean; toolImage: boolean; status?: number }
const wire: Wire[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  let rec: Wire | null = null
  if (url.includes('api.openai.com/v1/responses') && typeof init?.body === 'string') {
    const body = JSON.parse(init.body) as {
      model: string
      input?: Array<{ type?: string; role?: string; content?: unknown; output?: unknown }>
    }
    const hasImage = (parts: unknown): boolean =>
      Array.isArray(parts) &&
      parts.some(
        (p) =>
          p?.type === 'input_image' &&
          typeof p.image_url === 'string' &&
          p.image_url.startsWith('data:image/jpeg;base64,')
      )
    rec = {
      model: body.model,
      userImage: (body.input ?? []).some((i) => i.role === 'user' && hasImage(i.content)),
      toolImage: (body.input ?? []).some(
        (i) => i.type === 'function_call_output' && hasImage(i.output)
      )
    }
    wire.push(rec)
  }
  const res = await realFetch(input, init)
  if (rec) rec.status = res.status
  return res
}) as typeof fetch

type Streamer = { stream(o: ProviderStreamOptions): AsyncGenerator<StreamChunk> }
type Run = { text: string; errors: string[] }
async function run(streamer: Streamer, opts: ProviderStreamOptions): Promise<Run> {
  const out: Run = { text: '', errors: [] }
  try {
    for await (const chunk of streamer.stream(opts)) {
      if (chunk.type === 'text') out.text += chunk.text
      else if (chunk.type === 'error') out.errors.push(chunk.message)
      else if (chunk.type === 'no_provider_available') out.errors.push('no_provider_available')
    }
  } catch (err) {
    out.errors.push(err instanceof Error ? err.message : String(err))
  }
  return out
}

function thalamusFor(model: string): Streamer {
  const t = new Thalamus(new LocalProvider())
  t.setCloudProviders([{ id: 'openai', model, apiKey: apiKey as string }])
  t.setBrain({ providerId: 'openai', model })
  return t as unknown as Streamer
}

type Verdict = 'SEES' | 'BLIND' | 'REJECT' | 'ERROR'
function verdict(r: Run): Verdict {
  if (r.errors.length > 0) return isModalityReject(r.errors.join(' | ')) ? 'REJECT' : 'ERROR'
  return SEES(r.text) ? 'SEES' : 'BLIND'
}

const userProbe = (): ChatMessage[] => [
  {
    role: 'user',
    content: [
      { type: 'text', text: QUESTION },
      { type: 'image', ...IMAGE }
    ]
  }
]

const toolProbe = (): ChatMessage[] => [
  { role: 'user', content: `Use image_view on /tmp/probe.jpg. ${QUESTION}` },
  {
    role: 'assistant',
    content: '',
    toolUses: [{ id: 'call_probe_1', name: 'image_view', args: { path: '/tmp/probe.jpg' } }]
  },
  {
    role: 'tool',
    toolUseId: 'call_probe_1',
    toolName: 'image_view',
    content: 'Viewing /tmp/probe.jpg (original 640x320, 14KB; shown at 640x320).',
    images: [IMAGE]
  }
]

type Row = {
  model: string
  vision: boolean
  toolImages: boolean
  user: Verdict
  tool: Verdict
  userWire: boolean
  toolWire: boolean
  rawUser?: Verdict
  rawTool?: Verdict
  notes: string[]
}

async function probe(model: string): Promise<Row> {
  const vision = cloudModelSupportsVision('openai', model)
  const toolImages = cloudModelSupportsToolResultImages('openai', model)
  const notes: string[] = []
  const note = (label: string, r: Run): void => {
    notes.push(`${label}: ${r.errors[0]?.slice(0, 160) ?? JSON.stringify(r.text.slice(0, 100))}`)
  }

  const b1 = wire.length
  const u = await run(thalamusFor(model), {
    system: SYSTEM,
    messages: userProbe(),
    thinkingMode: 'on'
  })
  const userWire = wire.slice(b1).some((w) => w.model === model && w.userImage)
  const b2 = wire.length
  const t = await run(thalamusFor(model), {
    system: SYSTEM,
    messages: toolProbe(),
    tools: [TOOL],
    thinkingMode: 'on'
  })
  const toolWire = wire.slice(b2).some((w) => w.model === model && w.toolImage)
  const row: Row = {
    model,
    vision,
    toolImages,
    user: verdict(u),
    tool: verdict(t),
    userWire,
    toolWire,
    notes
  }
  if (vision && row.user !== 'SEES') note('user', u)
  if (toolImages && row.tool !== 'SEES') note('tool', t)

  // Negative gates: prove the API really refuses what the gate withholds.
  const raw = new OpenAIProvider(apiKey as string, model)
  if (!vision) {
    const r = await run(raw, { system: SYSTEM, messages: userProbe(), thinkingMode: 'on' })
    row.rawUser = verdict(r)
    note('raw user', r)
  }
  if (vision && !toolImages) {
    const r = await run(raw, {
      system: SYSTEM,
      messages: toolProbe(),
      tools: [TOOL],
      thinkingMode: 'on'
    })
    row.rawTool = verdict(r)
    note('raw tool', r)
  }
  return row
}

type ModelInfo = { id: string; shutdown_date?: string | null }
async function listModels(): Promise<ModelInfo[]> {
  const res = await realFetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` }
  })
  if (!res.ok) return []
  const json = (await res.json()) as { data?: ModelInfo[] }
  return json.data ?? []
}

async function main(): Promise<void> {
  const rows: Row[] = []
  const queue = [...SWEEP]
  const workers = Array.from({ length: 3 }, async () => {
    while (queue.length > 0) {
      const model = queue.shift() as string
      const row = await probe(model)
      rows.push(row)
      const gate = row.vision ? (row.toolImages ? 'vision' : 'user-only') : 'text'
      console.log(
        `  ${row.model.padEnd(14)} gate=${gate.padEnd(9)} user=${row.user.padEnd(6)} tool=${row.tool.padEnd(6)}` +
          (row.rawUser ? ` rawUser=${row.rawUser}` : '') +
          (row.rawTool ? ` rawTool=${row.rawTool}` : '') +
          (row.notes.length ? '  ' + row.notes.join(' ; ') : '')
      )
    }
  })
  console.log(`openai vision sweep — ${SWEEP.length} models, user + tool-result image each`)
  await Promise.all(workers)

  let failures = 0
  const fail = (msg: string): void => {
    failures++
    console.log(`  FAIL ${msg}`)
  }
  console.log('\nchecks')
  for (const r of rows.sort((a, b) => SWEEP.indexOf(a.model) - SWEEP.indexOf(b.model))) {
    if (r.user === 'ERROR' || r.tool === 'ERROR') {
      fail(`${r.model}: non-modality error through thalamus — ${r.notes.join(' ; ')}`)
    }
    if (r.vision) {
      if (!r.userWire) fail(`${r.model}: user request lacked an input_image data-URI part`)
      if (r.user !== 'SEES') fail(`${r.model}: did not read the user image (${r.user})`)
    } else {
      if (r.userWire || r.toolWire) fail(`${r.model}: text-only gate let an image onto the wire`)
      if (r.rawUser === 'SEES')
        fail(`${r.model}: gate says text-only but the API read the image — gate too strict`)
    }
    if (r.toolImages) {
      if (!r.toolWire) fail(`${r.model}: function_call_output lacked an input_image data-URI part`)
      if (r.tool !== 'SEES') fail(`${r.model}: did not read the tool-result image (${r.tool})`)
    } else if (r.vision) {
      if (r.toolWire) fail(`${r.model}: tool-image gate let an image into function_call_output`)
      if (r.rawTool === 'SEES' || r.rawTool === 'BLIND') {
        fail(
          `${r.model}: gate withholds tool images but the API accepted them (${r.rawTool}) — gate too strict`
        )
      }
    }
  }
  if (failures === 0)
    console.log('  PASS every catalogue model matches the vision gates on both probes')

  const models = await listModels()
  const ids = models.map((m) => m.id)
  const family = ids.filter((id) => /^(gpt-|o\d|chat-latest|chatgpt)/.test(id))
  const unknown = family.filter((id) => !CATALOG.includes(id)).sort()
  const missing = CATALOG.filter((id) => !ids.includes(id))
  const retiring = models
    .filter((m) => CATALOG.includes(m.id) && m.shutdown_date)
    .map((m) => `${m.id}@${m.shutdown_date}`)
  console.log(`\n/v1/models: ${ids.length} ids, ${family.length} in the gpt/o families`)
  if (missing.length)
    console.log(`  catalogue ids the account does not list: ${missing.join(', ')}`)
  if (retiring.length) console.log(`  catalogue ids with a shutdown_date: ${retiring.join(', ')}`)
  console.log(`  family ids not in the catalogue (${unknown.length}): ${unknown.join(', ')}`)

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('harness crashed:', err)
  process.exit(1)
})
