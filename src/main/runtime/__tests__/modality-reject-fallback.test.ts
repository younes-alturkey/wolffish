/**
 * Two-stage modality-reject fallback in streamOnce.
 *
 * A vision model that 400/422s on image parts must retry with a ladder:
 *   stage 1 — strip only tool-result images (user attachments stay)
 *   stage 2 — strip everything
 * Bound: initial + two retries, then failed. The session memo is written
 * only after a stripped retry SUCCEEDS, so a false-positive 400 never
 * poisons later turns.
 *
 * No network. Fake provider only.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/modality-reject-fallback.test.ts
 */

import Module from 'node:module'
import type { ChatMessage, ProviderStreamOptions, StreamChunk } from '../thalamus'

// Patch BEFORE any value-import of thalamus.ts — tsx/esbuild hoists static
// `import` to the top of the CJS output, which would load electron first
// and leave net.isOnline undefined. Dynamic import below runs after this.
const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return { net: { isOnline: () => true } }
  }
  return origLoad.apply(this, args)
}

let passed = 0
let failed = 0

function check(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}: expected ${String(expected)}, got ${String(actual)}`)
}

function checkTrue(label: string, actual: unknown): void {
  if (actual) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}`)
}

type Outcome = 'modality400' | 'auth400' | 'ok'

const MODALITY_ERR =
  'xai chat failed: HTTP 400 {"error":{"message":"unknown variant image_url, expected text"}}'
const AUTH_ERR = 'xai chat failed: HTTP 400 {"error":{"message":"invalid api key"}}'

class FakeProvider {
  calls = 0
  payloads: ProviderStreamOptions[] = []
  behavior: Outcome[]

  constructor(behavior: Outcome[]) {
    this.behavior = behavior
  }

  async *stream(options: ProviderStreamOptions): AsyncGenerator<StreamChunk> {
    this.payloads.push(options)
    const i = this.calls
    this.calls += 1
    const outcome = this.behavior[i] ?? this.behavior[this.behavior.length - 1]
    if (outcome === 'modality400') throw new Error(MODALITY_ERR)
    if (outcome === 'auth400') throw new Error(AUTH_ERR)
    yield { type: 'text', text: 'ok' }
    yield {
      type: 'turn_meta',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 }
    }
  }
}

const TINY = { mediaType: 'image/jpeg' as const, data: 'aGVsbG8=' }

const VISUAL_HISTORY: ChatMessage[] = [
  { role: 'user', content: 'what is in this screenshot' },
  {
    role: 'assistant',
    content: '',
    toolUses: [{ id: 'call_1', name: 'image_view', args: { path: '/tmp/a.jpg' } }]
  },
  {
    role: 'tool',
    toolUseId: 'call_1',
    toolName: 'image_view',
    content: 'Viewing /tmp/a.jpg (original 16x16).',
    images: [TINY]
  }
]

/**
 * SYNTHETIC. The user-message image block below is not something the app
 * currently produces — every attachment becomes a text reference note, so
 * tool results are the only real source of visual content. This history
 * exists to cover the stage-2 rung of the ladder, which is therefore
 * unreachable in production today (see the note in thalamus.ts). Passing
 * tests here mean stage 2 is correct if user blocks ever ship, NOT that it
 * runs against a live provider now.
 */
const MIXED_HISTORY: ChatMessage[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'compare this photo to the screenshot' },
      { type: 'image', mediaType: 'image/jpeg', data: 'dXNlcg==' }
    ]
  },
  {
    role: 'assistant',
    content: '',
    toolUses: [{ id: 'call_1', name: 'image_view', args: { path: '/tmp/a.jpg' } }]
  },
  {
    role: 'tool',
    toolUseId: 'call_1',
    toolName: 'image_view',
    content: 'Viewing /tmp/a.jpg (original 16x16).',
    images: [TINY]
  }
]

const TEXT_HISTORY: ChatMessage[] = [
  { role: 'user', content: 'hello' },
  {
    role: 'assistant',
    content: '',
    toolUses: [{ id: 'call_1', name: 'file_read', args: { path: '/tmp/a.txt' } }]
  },
  {
    role: 'tool',
    toolUseId: 'call_1',
    toolName: 'file_read',
    content: 'hello world'
  }
]

function toolOf(opts: ProviderStreamOptions): ChatMessage | undefined {
  return opts.messages.find((m) => m.role === 'tool')
}

function userOf(opts: ProviderStreamOptions): ChatMessage | undefined {
  return opts.messages.find((m) => m.role === 'user')
}

function userHasImage(opts: ProviderStreamOptions): boolean {
  const u = userOf(opts)
  return (
    !!u &&
    u.role === 'user' &&
    typeof u.content !== 'string' &&
    u.content.some((b) => b.type === 'image')
  )
}

function toolHasImages(opts: ProviderStreamOptions): boolean {
  const t = toolOf(opts)
  return !!t && t.role === 'tool' && (t.images?.length ?? 0) > 0
}

async function main(): Promise<void> {
  const { LocalProvider } = await import('../providers/local')
  const { Thalamus, MODALITY_MEMO_REQUESTS } = await import('../thalamus')
  const { isModalityReject, REQUEST_MODALITY_STRIP_REASON, TOOL_RESULT_MODALITY_STRIP_REASON } =
    await import('../vision')

  const makeThalamus = (fake: FakeProvider): InstanceType<typeof Thalamus> => {
    const t = new Thalamus(new LocalProvider(), { testProvider: fake })
    t.setCloudProviders([{ id: 'xai', model: 'grok-4.6', apiKey: 'test-key' }])
    t.setBrain({ providerId: 'xai', model: 'grok-4.6' })
    return t
  }

  type DriveResult = { kinds: string[]; text: string; failed: boolean }

  const drive = async (
    t: InstanceType<typeof Thalamus>,
    messages: ChatMessage[]
  ): Promise<DriveResult> => {
    const kinds: string[] = []
    let text = ''
    let failed = false
    for await (const chunk of t.stream({
      system: 'sys',
      messages,
      thinkingMode: 'off'
    })) {
      kinds.push(chunk.type)
      if (chunk.type === 'text') text += chunk.text
      if (chunk.type === 'no_provider_available') failed = true
    }
    return { kinds, text, failed }
  }

  // ---------------------------------------------------------------------------
  // predicate shared with the live harness
  // ---------------------------------------------------------------------------

  check('predicate: unknown variant is a modality reject', isModalityReject(MODALITY_ERR), true)
  check('predicate: invalid api key is not', isModalityReject(AUTH_ERR), false)
  check(
    'predicate: no multimodal input is a reject',
    isModalityReject('HTTP 400 no multimodal input'),
    true
  )

  // ---------------------------------------------------------------------------
  // 1. modality 400 then success — stage 1 (tool-only) is the cure
  // ---------------------------------------------------------------------------

  {
    const fake = new FakeProvider(['modality400', 'ok'])
    const t = makeThalamus(fake)
    const out = await drive(t, VISUAL_HISTORY)
    check('1: two attempts', fake.calls, 2)
    check('1: turn succeeded', out.failed, false)
    check('1: text arrived', out.text, 'ok')
    checkTrue('1: first attempt still had tool images', toolHasImages(fake.payloads[0]))
    checkTrue('1: second attempt has no tool images', !toolHasImages(fake.payloads[1]))
    const second = toolOf(fake.payloads[1])
    checkTrue(
      '1: second attempt carries the tool-result note, not the text-only wording',
      typeof second?.content === 'string' &&
        second.content.includes(TOOL_RESULT_MODALITY_STRIP_REASON) &&
        !second.content.includes('text-only') &&
        !second.content.includes('can still view')
    )
  }

  // ---------------------------------------------------------------------------
  // 2. every reachable stage rejects → failed, no memo.
  //    Tool-only history: stage 1 leaves nothing visual, so stage 2 is a
  //    no-op and must not fire. Mixed history: both stages run, then fail.
  // ---------------------------------------------------------------------------

  {
    const fake = new FakeProvider(['modality400', 'modality400', 'modality400'])
    const t = makeThalamus(fake)
    const out = await drive(t, VISUAL_HISTORY)
    check('2: tool-only history is two attempts (stage 2 has nothing to strip)', fake.calls, 2)
    check('2: turn failed', out.failed, true)

    fake.behavior = ['ok']
    fake.calls = 0
    fake.payloads = []
    const next = await drive(t, VISUAL_HISTORY)
    check('2: later turn still sends images (memo not written)', fake.calls, 1)
    check('2: later turn succeeded', next.failed, false)
    checkTrue('2: later turn still has tool images', toolHasImages(fake.payloads[0]))
  }

  {
    const fake = new FakeProvider(['modality400', 'modality400', 'modality400'])
    const t = makeThalamus(fake)
    const out = await drive(t, MIXED_HISTORY)
    check('2b: mixed history is at most three calls', fake.calls, 3)
    check('2b: turn failed', out.failed, true)

    fake.behavior = ['ok']
    fake.calls = 0
    fake.payloads = []
    const next = await drive(t, MIXED_HISTORY)
    check('2b: later turn is one attempt (no memo)', fake.calls, 1)
    check('2b: later turn succeeded', next.failed, false)
    checkTrue(
      '2b: later turn still has both images',
      toolHasImages(fake.payloads[0]) && userHasImage(fake.payloads[0])
    )
  }

  // ---------------------------------------------------------------------------
  // 3. non-modality 400 → no retry
  // ---------------------------------------------------------------------------

  {
    const fake = new FakeProvider(['auth400'])
    const t = makeThalamus(fake)
    const out = await drive(t, VISUAL_HISTORY)
    check('3: no retry', fake.calls, 1)
    check('3: turn failed', out.failed, true)
  }

  // ---------------------------------------------------------------------------
  // 4. modality 400 with no visual content → no retry
  // ---------------------------------------------------------------------------

  {
    const fake = new FakeProvider(['modality400'])
    const t = makeThalamus(fake)
    const out = await drive(t, TEXT_HISTORY)
    check('4: no retry when nothing to strip', fake.calls, 1)
    check('4: turn failed', out.failed, true)
  }

  // ---------------------------------------------------------------------------
  // 5. session memo records the curing scope and pre-strips later turns
  // ---------------------------------------------------------------------------

  {
    const fake = new FakeProvider(['modality400', 'ok'])
    const t = makeThalamus(fake)
    await drive(t, VISUAL_HISTORY)
    fake.behavior = ['ok']
    fake.calls = 0
    fake.payloads = []
    const out = await drive(t, VISUAL_HISTORY)
    check('5: pre-strip means one attempt', fake.calls, 1)
    check('5: turn succeeded', out.failed, false)
    checkTrue('5: first attempt already has no tool images', !toolHasImages(fake.payloads[0]))
    const only = toolOf(fake.payloads[0])
    checkTrue(
      '5: first attempt already has the tool-result note',
      typeof only?.content === 'string' &&
        only.content.includes(TOOL_RESULT_MODALITY_STRIP_REASON) &&
        !only.content.includes('can still view')
    )
  }

  // ---------------------------------------------------------------------------
  // 5b. the memo EXPIRES. "Stripping cured the 400" is not proof the model is
  //     blind — a 400 that merely mentions an image (DashScope's sub-10px
  //     complaint) is cured the same way. A permanent memo would silently
  //     blind a fully capable model until relaunch, so images get probed
  //     again after MODALITY_MEMO_REQUESTS requests.
  // ---------------------------------------------------------------------------

  {
    const fake = new FakeProvider(['modality400', 'ok'])
    const t = makeThalamus(fake)
    await drive(t, VISUAL_HISTORY) // arms the memo
    fake.behavior = ['ok']
    // Spend every memoized use; the last one clears the entry.
    for (let i = 0; i < MODALITY_MEMO_REQUESTS; i++) await drive(t, VISUAL_HISTORY)
    checkTrue(
      '5b: still pre-stripping on the last memoized request',
      !toolHasImages(fake.payloads[fake.payloads.length - 1])
    )
    fake.calls = 0
    fake.payloads = []
    const out = await drive(t, VISUAL_HISTORY)
    check('5b: probe turn succeeded', out.failed, false)
    checkTrue('5b: images are sent again once the memo expires', toolHasImages(fake.payloads[0]))
  }

  // ---------------------------------------------------------------------------
  // 6. user-message image SURVIVES a stage-1 (tool-scoped) strip
  // ---------------------------------------------------------------------------

  {
    const fake = new FakeProvider(['modality400', 'ok'])
    const t = makeThalamus(fake)
    const out = await drive(t, MIXED_HISTORY)
    check('6: two attempts', fake.calls, 2)
    check('6: turn succeeded', out.failed, false)
    checkTrue('6: stage 1 dropped tool images', !toolHasImages(fake.payloads[1]))
    checkTrue('6: stage 1 kept the user image', userHasImage(fake.payloads[1]))
    const tool = toolOf(fake.payloads[1])
    checkTrue(
      '6: stage-1 note does not claim the user image was kept-and-stripped',
      typeof tool?.content === 'string' &&
        tool.content.includes(TOOL_RESULT_MODALITY_STRIP_REASON) &&
        !tool.content.includes('can still view')
    )
  }

  // ---------------------------------------------------------------------------
  // 7. stage 2 fires only when stage 1 is also rejected
  // ---------------------------------------------------------------------------

  {
    const fake = new FakeProvider(['modality400', 'modality400', 'ok'])
    const t = makeThalamus(fake)
    const out = await drive(t, MIXED_HISTORY)
    check('7: three attempts (initial + stage1 + stage2)', fake.calls, 3)
    check('7: turn succeeded', out.failed, false)
    checkTrue(
      '7: attempt 0 has both',
      toolHasImages(fake.payloads[0]) && userHasImage(fake.payloads[0])
    )
    checkTrue(
      '7: attempt 1 is tool-only strip (user image stays)',
      !toolHasImages(fake.payloads[1]) && userHasImage(fake.payloads[1])
    )
    checkTrue(
      '7: attempt 2 is full strip (user image gone)',
      !toolHasImages(fake.payloads[2]) && !userHasImage(fake.payloads[2])
    )
    const lastTool = toolOf(fake.payloads[2])
    const lastUser = userOf(fake.payloads[2])
    // Tool images were already removed at stage 1 — stage 2 does not rewrite
    // that note. Both notes stay true for what that call actually removed.
    checkTrue(
      '7: stage-2 tool note is still the tool-result reason (already stripped)',
      typeof lastTool?.content === 'string' &&
        lastTool.content.includes(TOOL_RESULT_MODALITY_STRIP_REASON) &&
        !lastTool.content.includes('can still view')
    )
    checkTrue(
      '7: stage-2 user note is the request reason',
      !!lastUser &&
        lastUser.role === 'user' &&
        typeof lastUser.content !== 'string' &&
        lastUser.content.some(
          (b) => b.type === 'text' && b.text.includes(REQUEST_MODALITY_STRIP_REASON)
        )
    )
  }

  // ---------------------------------------------------------------------------
  // 8. memo records the scope — a later turn pre-strips at that same scope
  // ---------------------------------------------------------------------------

  {
    // Cured at stage 1 → later turn keeps user images, drops tool images.
    const fake = new FakeProvider(['modality400', 'ok'])
    const t = makeThalamus(fake)
    await drive(t, MIXED_HISTORY)
    fake.behavior = ['ok']
    fake.calls = 0
    fake.payloads = []
    const out = await drive(t, MIXED_HISTORY)
    check('8a: pre-strip at tool scope is one attempt', fake.calls, 1)
    check('8a: turn succeeded', out.failed, false)
    checkTrue('8a: later turn has no tool images', !toolHasImages(fake.payloads[0]))
    checkTrue('8a: later turn still has the user image', userHasImage(fake.payloads[0]))
  }

  {
    // Cured at stage 2 → later turn pre-strips everything.
    const fake = new FakeProvider(['modality400', 'modality400', 'ok'])
    const t = makeThalamus(fake)
    await drive(t, MIXED_HISTORY)
    fake.behavior = ['ok']
    fake.calls = 0
    fake.payloads = []
    const out = await drive(t, MIXED_HISTORY)
    check('8b: pre-strip at all scope is one attempt', fake.calls, 1)
    check('8b: turn succeeded', out.failed, false)
    checkTrue(
      '8b: later turn has neither tool nor user images',
      !toolHasImages(fake.payloads[0]) && !userHasImage(fake.payloads[0])
    )
    const only = toolOf(fake.payloads[0])
    checkTrue(
      '8b: later turn already has the request-scope note',
      typeof only?.content === 'string' &&
        only.content.includes(REQUEST_MODALITY_STRIP_REASON) &&
        !only.content.includes('can still view')
    )
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
