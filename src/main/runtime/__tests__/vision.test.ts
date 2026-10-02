/**
 * Vision capability gate tests — the well-known-family check that keeps
 * image blocks away from text-only model APIs (the DeepSeek HTTP 400
 * `unknown variant image_url` class of failure), plus the strip helpers
 * that replace visual content with an explanatory note.
 *
 * Run: npx tsx src/main/runtime/__tests__/vision.test.ts
 */

import type { ChatMessage } from '../thalamus'
import {
  cloudModelSupportsVision,
  hasVisualContent,
  isModalityReject,
  limitToolResultImages,
  REQUEST_MODALITY_STRIP_REASON,
  stripVisualContent,
  TEXT_ONLY_STRIP_REASON,
  TOOL_RESULT_MODALITY_STRIP_REASON
} from '../vision'

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

// ---------------------------------------------------------------------------
// cloudModelSupportsVision
// ---------------------------------------------------------------------------

const CASES: Array<[provider: string, model: string, vision: boolean]> = [
  // deepseek — deepseek-flash (V4.1-Flash, 2026-09-11) sees images and the
  // retired ids alias to it; deepseek-v4-pro is the last text-only model
  // and now answers images with a silent guess instead of a 400
  ['deepseek', 'deepseek-v4-pro', false],
  ['deepseek', 'deepseek-flash', true],
  ['deepseek', 'deepseek-v4-flash', true],
  ['deepseek', 'deepseek-chat', true],
  ['deepseek', 'deepseek-reasoner', true],
  ['deepseek', 'deepseek-v4-flash-vision-exp', true],
  // anthropic — every Claude chat model accepts images
  ['anthropic', 'claude-sonnet-4-5', true],
  ['anthropic', 'claude-fable-5', true],
  ['anthropic', 'claude-haiku-4-5-20251001', true],
  // openai — vision families with text-only exceptions
  ['openai', 'gpt-4o', true],
  ['openai', 'gpt-4o-mini', true],
  ['openai', 'gpt-4.1', true],
  ['openai', 'gpt-4-turbo', true],
  ['openai', 'gpt-5', true],
  ['openai', 'chatgpt-4o-latest', true],
  ['openai', 'o3', true],
  ['openai', 'o4-mini', true],
  ['openai', 'o3-mini', false],
  ['openai', 'o1-mini', false],
  ['openai', 'o1-preview', false],
  ['openai', 'gpt-3.5-turbo', false],
  ['openai', 'gpt-4', false],
  ['openai', 'gpt-4-0613', false],
  ['openai', 'gpt-4-32k', false],
  // xai — grok-4 onward is multimodal; older lines need the vision marker
  ['xai', 'grok-4.6', true],
  ['xai', 'grok-4.5', true],
  ['xai', 'grok-4', true],
  ['xai', 'grok-4-fast-non-reasoning', true],
  ['xai', 'grok-2-vision-1212', true],
  ['xai', 'grok-3-mini', false],
  // kimi / moonshot — k2.5+/k3 natively multimodal (verified live);
  // pre-k2.5 and bare moonshot-v1 are text-only
  ['kimi', 'kimi-k3', true],
  ['kimi', 'kimi-k2.7-code', true],
  ['kimi', 'kimi-k2.7-code-highspeed', true],
  ['kimi', 'kimi-k2.6', true],
  ['kimi', 'kimi-k2.5', true],
  ['kimi', 'kimi-k2-0905-preview', false],
  ['kimi', 'moonshot-v1-auto', false],
  ['kimi', 'moonshot-v1-8k-vision-preview', true],
  ['kimi', 'kimi-vl-a3b-thinking', true],
  // qwen — qwen3.8-max natively multimodal (verified live 2026-08-03);
  // earlier bare qwen3.x lines stay text-only.
  ['qwen', 'qwen3.8-max', true],
  ['qwen', 'qwen3.7-max', false],
  ['qwen', 'qwen-max', false],
  ['qwen', 'qwen-plus', false],
  ['qwen', 'qwen2.5-vl-72b-instruct', true],
  ['qwen', 'qwen-omni-turbo', true],
  ['qwen', 'qvq-max', true],
  // minimax
  ['minimax', 'minimax-m2', false],
  ['minimax', 'minimax-vl-01', true],
  // mimo
  ['mimo', 'mimo-7b-rl', false],
  ['mimo', 'mimo-vl-7b', true],
  // stepfun
  ['stepfun', 'step-2-16k', false],
  ['stepfun', 'step-1v-32k', true],
  ['stepfun', 'step-1.5v-mini', true],
  ['stepfun', 'step-1o-turbo-vision', true],
  // zai / GLM — bare chat models are text-only (verified live: glm-5.2
  // rejects image parts); only the glm-*v variants are multimodal
  ['zai', 'glm-4.5', false],
  ['zai', 'glm-4.5-air', false],
  ['zai', 'glm-4.6', false],
  ['zai', 'glm-5.2', false],
  ['zai', 'glm-5-turbo', false],
  ['zai', 'glm-4.5v', true],
  ['zai', 'glm-4.6v', true],
  ['zai', 'glm-5v-turbo', true],
  // openrouter — namespaced ids route to family rules
  ['openrouter', 'anthropic/claude-opus-4.1', true],
  ['openrouter', 'google/gemini-2.5-flash', true],
  ['openrouter', 'openai/gpt-4o', true],
  ['openrouter', 'openai/o3-mini', false],
  ['openrouter', 'x-ai/grok-4', true],
  ['openrouter', 'meta-llama/llama-3.2-90b-vision-instruct', true],
  ['openrouter', 'mistralai/pixtral-large-2411', true],
  ['openrouter', 'deepseek/deepseek-chat-v3.1', false],
  ['openrouter', 'moonshotai/kimi-k2', false],
  ['openrouter', 'moonshotai/kimi-k3', true],
  ['openrouter', 'moonshotai/kimi-k2.6', true],
  // unknown providers default to text-only unless the name says otherwise
  ['someprovider', 'shiny-new-model', false],
  ['someprovider', 'shiny-vl-9000', true],
  ['someprovider', 'shiny-omni', true]
]

for (const [provider, model, expected] of CASES) {
  check(`${provider}/${model}`, cloudModelSupportsVision(provider, model), expected)
}

// ---------------------------------------------------------------------------
// hasVisualContent / stripVisualContent
// ---------------------------------------------------------------------------

const textOnly: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi' },
  { role: 'user', content: [{ type: 'text', text: 'block text' }] }
]

check('hasVisualContent: text-only', hasVisualContent(textOnly), false)
check('strip: text-only returns same reference', stripVisualContent(textOnly), textOnly)

const withVisuals: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  {
    role: 'user',
    content: [
      { type: 'text', text: 'make a proposal' },
      { type: 'image', mediaType: 'image/jpeg', data: 'aGVsbG8=' },
      { type: 'image', mediaType: 'image/jpeg', data: 'aGVsbG8=' },
      { type: 'document', mediaType: 'application/pdf', data: 'aGVsbG8=' }
    ]
  },
  { role: 'assistant', content: 'ok' },
  {
    role: 'tool',
    toolUseId: 't1',
    toolName: 'screenshot',
    content: 'took a screenshot',
    images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }]
  }
]

check('hasVisualContent: with visuals', hasVisualContent(withVisuals), true)

const stripped = stripVisualContent(withVisuals)
check('strip: returns new array', stripped !== withVisuals, true)
check('strip: nothing visual remains', hasVisualContent(stripped), false)

const strippedUser = stripped[1]
if (strippedUser.role === 'user' && typeof strippedUser.content !== 'string') {
  const blocks = strippedUser.content
  check('strip: user keeps text + one note', blocks.length, 2)
  check(
    'strip: user blocks are all text',
    blocks.every((b) => b.type === 'text'),
    true
  )
  const note = blocks[1]
  const noteText = note.type === 'text' ? note.text : ''
  check('strip: note counts images', noteText.includes('2 images'), true)
  check('strip: note counts documents', noteText.includes('1 PDF document'), true)
  check('strip: note points at attachments', noteText.includes('<attachments>'), true)
} else {
  failed++
  console.error('FAIL strip: user message lost its block content')
}

const strippedTool = stripped[3]
if (strippedTool.role === 'tool') {
  check('strip: tool images removed', strippedTool.images, undefined)
  check(
    'strip: tool content keeps original text',
    strippedTool.content.startsWith('took a screenshot'),
    true
  )
  check('strip: tool content gains note', strippedTool.content.includes('omitted'), true)
} else {
  failed++
  console.error('FAIL strip: tool message changed role')
}

check('strip: untouched messages keep identity', stripped[0] === withVisuals[0], true)
check('strip: assistant message keeps identity', stripped[2] === withVisuals[2], true)
check('strip: original input not mutated', hasVisualContent(withVisuals), true)
check(
  'strip: default reason is text-only',
  strippedTool.role === 'tool' && strippedTool.content.includes(TEXT_ONLY_STRIP_REASON),
  true
)

{
  const toolOnly = stripVisualContent(withVisuals, TOOL_RESULT_MODALITY_STRIP_REASON, 'tool')
  const toolMsg = toolOnly[3]
  const userMsg = toolOnly[1]
  check(
    'strip tool-scope: tool images gone',
    toolMsg.role === 'tool' && toolMsg.images === undefined,
    true
  )
  check(
    'strip tool-scope: tool note is the tool-result reason',
    toolMsg.role === 'tool' &&
      toolMsg.content.includes(TOOL_RESULT_MODALITY_STRIP_REASON) &&
      !toolMsg.content.includes('can still view') &&
      !toolMsg.content.includes('text-only'),
    true
  )
  check(
    'strip tool-scope: user image blocks survive',
    userMsg.role === 'user' &&
      typeof userMsg.content !== 'string' &&
      userMsg.content.some((b) => b.type === 'image'),
    true
  )
  check('strip tool-scope: still has visuals (the user ones)', hasVisualContent(toolOnly), true)
}

{
  const all = stripVisualContent(withVisuals, REQUEST_MODALITY_STRIP_REASON, 'all')
  const toolMsg = all[3]
  const userMsg = all[1]
  check('strip all-scope: nothing visual remains', hasVisualContent(all), false)
  check(
    'strip all-scope: tool note is the request reason',
    toolMsg.role === 'tool' &&
      toolMsg.content.includes(REQUEST_MODALITY_STRIP_REASON) &&
      !toolMsg.content.includes('can still view') &&
      !toolMsg.content.includes('user message'),
    true
  )
  check(
    'strip all-scope: user note is the request reason',
    userMsg.role === 'user' &&
      typeof userMsg.content !== 'string' &&
      userMsg.content.some(
        (b) => b.type === 'text' && b.text.includes(REQUEST_MODALITY_STRIP_REASON)
      ),
    true
  )
}

check('modality predicate: unknown variant', isModalityReject('unknown variant image_url'), true)
check('modality predicate: invalid api key', isModalityReject('invalid api key'), false)

// ---------------------------------------------------------------------------
// limitToolResultImages — batched retention of the newest tool images
// ---------------------------------------------------------------------------

{
  const img = { mediaType: 'image/png', data: 'x' }
  const shot = (i: number, images: number): ChatMessage => ({
    role: 'tool',
    toolUseId: `t${i}`,
    toolName: 'computer_screenshot',
    content: `shot ${i}`,
    images: Array.from({ length: images }, () => ({ ...img }))
  })
  const userWithImage: ChatMessage = {
    role: 'user',
    content: [
      { type: 'text', text: 'look' },
      { type: 'image', mediaType: 'image/png', data: 'u' }
    ]
  }

  const countToolImages = (ms: ChatMessage[]): number =>
    ms.reduce((n, m) => n + (m.role === 'tool' ? (m.images?.length ?? 0) : 0), 0)

  // keep=6, batch=4: 9 total images → droppable 3 < batch → untouched (same ref)
  const nine = [userWithImage, ...Array.from({ length: 9 }, (_, i) => shot(i, 1))]
  check(
    'limit: below batch threshold is a no-op (same reference)',
    limitToolResultImages(nine),
    nine
  )

  // 10 total → droppable 4 → exactly the 4 oldest dropped, newest 6 kept
  const ten = [userWithImage, ...Array.from({ length: 10 }, (_, i) => shot(i, 1))]
  const pruned = limitToolResultImages(ten)
  check('limit: 10 images prune to 6', countToolImages(pruned), 6)
  check(
    'limit: oldest dropped first with a note',
    pruned[1].role === 'tool' &&
      pruned[1].images === undefined &&
      pruned[1].content.includes('omitted to keep context lean'),
    true
  )
  check(
    'limit: newest untouched, no note',
    pruned[10].role === 'tool' &&
      pruned[10].images?.length === 1 &&
      !pruned[10].content.includes('omitted'),
    true
  )
  check(
    'limit: user images never touched',
    pruned[0].role === 'user' &&
      typeof pruned[0].content !== 'string' &&
      pruned[0].content.some((b) => b.type === 'image'),
    true
  )

  // 13 total → droppable 7 → still only one batch (4) dropped, 9 remain
  const thirteen = [...Array.from({ length: 13 }, (_, i) => shot(i, 1))]
  check('limit: batches amortize (13 → 9)', countToolImages(limitToolResultImages(thirteen)), 9)

  // 14 total → droppable 8 → two batches dropped, 6 remain
  const fourteen = [...Array.from({ length: 14 }, (_, i) => shot(i, 1))]
  check('limit: next boundary (14 → 6)', countToolImages(limitToolResultImages(fourteen)), 6)

  // multi-image tool result split across the drop boundary keeps the tail
  const multi = [shot(0, 3), shot(1, 3), shot(2, 3), shot(3, 3)] // 12 total → drop 4 → 8 remain
  const multiPruned = limitToolResultImages(multi)
  check('limit: multi-image drop count', countToolImages(multiPruned), 8)
  check(
    'limit: boundary message keeps its newer images',
    multiPruned[1].role === 'tool' && multiPruned[1].images?.length === 2,
    true
  )

  // determinism: same history prunes to byte-identical shape
  check(
    'limit: deterministic over identical histories',
    JSON.stringify(limitToolResultImages(ten)) === JSON.stringify(limitToolResultImages(ten)),
    true
  )
}

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
