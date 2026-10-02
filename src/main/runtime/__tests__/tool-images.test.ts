/**
 * Tool-result image wire format — vision models get data-URI bytes,
 * oversized images stay as the tool's text (path already in the caption),
 * text-only models are stripped upstream by stripVisualContent.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/tool-images.test.ts
 */

import type { ChatMessage } from '../thalamus'
import { toAnthropicMessages } from '../providers/anthropic'
import { toOllamaMessages } from '../providers/local'
import { toXAIMessages } from '../providers/xai'
import {
  MAX_INLINE_IMAGE_BYTES,
  anthropicToolContent,
  decodedBase64Bytes,
  openaiCompatToolContent,
  selectInlineImages
} from '../tool-images'
import { stripVisualContent } from '../vision'

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

const TINY = 'aGVsbG8=' // "hello" — 5 decoded bytes
const tinyImg = { mediaType: 'image/jpeg', data: TINY }

// Just over the 3MB decoded cap. Length chosen so decodedBase64Bytes > cap.
const OVERSIZE_CHARS = Math.ceil(((MAX_INLINE_IMAGE_BYTES + 64) * 4) / 3)
const OVERSIZE = 'A'.repeat(OVERSIZE_CHARS - (OVERSIZE_CHARS % 4))
const bigImg = { mediaType: 'image/png', data: OVERSIZE }

// ---------------------------------------------------------------------------
// decodedBase64Bytes / selectInlineImages
// ---------------------------------------------------------------------------

check('decoded: hello', decodedBase64Bytes(TINY), 5)
check('decoded: empty', decodedBase64Bytes(''), 0)
checkTrue(
  'oversize is actually over the cap',
  decodedBase64Bytes(OVERSIZE) > MAX_INLINE_IMAGE_BYTES
)

{
  const { inline, omitted } = selectInlineImages([tinyImg, bigImg, tinyImg])
  check('select: keeps two small', inline.length, 2)
  check('select: omits one large', omitted, 1)
  check('select: first kept is tiny', inline[0], tinyImg)
}

{
  const { inline, omitted } = selectInlineImages([])
  check('select: empty inline', inline.length, 0)
  check('select: empty omitted', omitted, 0)
}

{
  const { inline, omitted } = selectInlineImages([{ mediaType: 'image/png', data: '' }])
  check('select: empty data is skipped, not counted as oversized', omitted, 0)
  check('select: empty data is not inlined', inline.length, 0)
}

check(
  'compat: empty data is a silent no-op, not a too-large note',
  openaiCompatToolContent('caption', [{ mediaType: 'image/png', data: '' }]),
  'caption'
)

// ---------------------------------------------------------------------------
// openaiCompatToolContent
// ---------------------------------------------------------------------------

check('compat: no images is the original string', openaiCompatToolContent('caption'), 'caption')
check(
  'compat: empty images is the original string',
  openaiCompatToolContent('caption', []),
  'caption'
)

{
  const content = openaiCompatToolContent('Viewing /tmp/a.jpg', [tinyImg])
  checkTrue('compat: small image becomes parts', Array.isArray(content))
  const parts = content as Array<Record<string, unknown>>
  check('compat: text + one image', parts.length, 2)
  check('compat: first part is text', (parts[0] as { type: string }).type, 'text')
  check('compat: caption preserved', (parts[0] as { text: string }).text, 'Viewing /tmp/a.jpg')
  const img = parts[1] as { type: string; image_url: { url: string } }
  check('compat: image_url type', img.type, 'image_url')
  check('compat: data URI', img.image_url.url, `data:image/jpeg;base64,${TINY}`)
}

{
  const content = openaiCompatToolContent('Viewing /tmp/huge.png', [bigImg])
  checkTrue('compat: oversized stays a string', typeof content === 'string')
  const text = content as string
  checkTrue('compat: oversized keeps caption', text.startsWith('Viewing /tmp/huge.png'))
  checkTrue('compat: oversized notes the drop', text.includes('too large to send inline'))
  checkTrue('compat: oversized has no data URI', !text.includes('data:image'))
}

{
  const content = openaiCompatToolContent('mixed', [tinyImg, bigImg])
  checkTrue('compat: mixed is parts', Array.isArray(content))
  const parts = content as Array<Record<string, unknown>>
  check('compat: mixed keeps only the small image', parts.length, 2)
  const text = (parts[0] as { text: string }).text
  checkTrue('compat: mixed notes the omitted one', text.includes('1 image omitted'))
  check(
    'compat: mixed data URI is the small one',
    (parts[1] as { image_url: { url: string } }).image_url.url,
    `data:image/jpeg;base64,${TINY}`
  )
}

// ---------------------------------------------------------------------------
// anthropicToolContent
// ---------------------------------------------------------------------------

{
  const content = anthropicToolContent('shot', [tinyImg])
  checkTrue('anthropic: small image becomes blocks', Array.isArray(content))
  const blocks = content as Array<Record<string, unknown>>
  check('anthropic: text + image', blocks.length, 2)
  const img = blocks[1] as { type: string; source: { type: string; data: string } }
  check('anthropic: image type', img.type, 'image')
  check('anthropic: base64 source', img.source.type, 'base64')
  check('anthropic: data is raw base64, not a data URI', img.source.data, TINY)
}

{
  const content = anthropicToolContent('shot', [bigImg])
  checkTrue('anthropic: oversized stays a string', typeof content === 'string')
  checkTrue(
    'anthropic: oversized notes the drop',
    (content as string).includes('too large to send inline')
  )
}

// ---------------------------------------------------------------------------
// toXAIMessages — the original bug: tool-result images were dropped
// ---------------------------------------------------------------------------

const history: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'what is this' },
  {
    role: 'assistant',
    content: '',
    toolUses: [{ id: 'call_1', name: 'image_view', args: { path: '/tmp/a.jpg' } }]
  },
  {
    role: 'tool',
    toolUseId: 'call_1',
    toolName: 'image_view',
    content: 'Viewing /tmp/a.jpg (original 4032x3024, 2305KB; shown at 1024x768).',
    images: [tinyImg]
  }
]

{
  const out = toXAIMessages(history)
  const tool = out.find((m) => m.role === 'tool') as {
    role: string
    tool_call_id: string
    content: unknown
  }
  checkTrue('xai: tool message exists', !!tool)
  check('xai: tool_call_id preserved', tool.tool_call_id, 'call_1')
  checkTrue('xai: content is parts, not a caption string', Array.isArray(tool.content))
  const parts = tool.content as Array<Record<string, unknown>>
  check('xai: text + image_url', parts.length, 2)
  check(
    'xai: data URI lands on the wire',
    (parts[1] as { image_url: { url: string } }).image_url.url.startsWith(
      'data:image/jpeg;base64,'
    ),
    true
  )
}

{
  const oversized: ChatMessage[] = [
    {
      role: 'tool',
      toolUseId: 'call_2',
      toolName: 'ext_screenshot',
      content: 'Screenshot captured (2400x4000, png).\n/tmp/shot.png',
      images: [bigImg]
    }
  ]
  const out = toXAIMessages(oversized)
  const tool = out[0]
  checkTrue('xai oversized: content stays a string', typeof tool.content === 'string')
  checkTrue(
    'xai oversized: caption + path survive',
    (tool.content as string).includes('/tmp/shot.png')
  )
  checkTrue(
    'xai oversized: notes the drop',
    (tool.content as string).includes('too large to send inline')
  )
}

{
  const plain: ChatMessage[] = [
    { role: 'tool', toolUseId: 'call_3', toolName: 'file_read', content: 'hello world' }
  ]
  const out = toXAIMessages(plain)
  check('xai text-only tool: content unchanged', out[0].content, 'hello world')
}

// ---------------------------------------------------------------------------
// toAnthropicMessages — same size gate, Anthropic image blocks
// ---------------------------------------------------------------------------

{
  const out = toAnthropicMessages(history)
  const users = out.filter((m) => m.role === 'user')
  checkTrue('anthropic wire: at least one user turn', users.length > 0)
  let result: Record<string, unknown> | undefined
  for (const user of users) {
    const blocks = Array.isArray(user.content) ? user.content : []
    result = (blocks as Array<Record<string, unknown>>).find((b) => b.type === 'tool_result')
    if (result) break
  }
  checkTrue('anthropic wire: tool_result present', !!result)
  const content = result?.content
  checkTrue('anthropic wire: content is blocks', Array.isArray(content))
  const img = (content as Array<Record<string, unknown>> | undefined)?.find(
    (b) => b.type === 'image'
  )
  checkTrue('anthropic wire: image block present', !!img)
}

// ---------------------------------------------------------------------------
// toOllamaMessages — native `images` array, not a data URI
// ---------------------------------------------------------------------------

{
  const small: ChatMessage[] = [
    {
      role: 'tool',
      toolUseId: 'call_o1',
      toolName: 'image_view',
      content: 'Viewing /tmp/a.jpg',
      images: [tinyImg]
    }
  ]
  const out = toOllamaMessages(small)
  check('ollama small: one message', out.length, 1)
  check('ollama small: role tool', out[0].role, 'tool')
  check('ollama small: content is the caption string', out[0].content, 'Viewing /tmp/a.jpg')
  check('ollama small: tool_name preserved', out[0].tool_name, 'image_view')
  checkTrue('ollama small: images is a raw-base64 array', Array.isArray(out[0].images))
  check('ollama small: one image', (out[0].images as string[]).length, 1)
  check('ollama small: raw base64, not a data URI', (out[0].images as string[])[0], TINY)
  checkTrue('ollama small: no data URI anywhere', !JSON.stringify(out[0]).includes('data:image'))
}

{
  const oversized: ChatMessage[] = [
    {
      role: 'tool',
      toolUseId: 'call_o2',
      toolName: 'ext_screenshot',
      content: 'Screenshot captured (2400x4000, png).\n/tmp/shot.png',
      images: [bigImg]
    }
  ]
  const out = toOllamaMessages(oversized)
  check('ollama oversized: content is a string', typeof out[0].content, 'string')
  checkTrue(
    'ollama oversized: caption + path survive',
    (out[0].content as string).includes('/tmp/shot.png')
  )
  checkTrue(
    'ollama oversized: notes the drop',
    (out[0].content as string).includes('too large to send inline')
  )
  check('ollama oversized: no images key', 'images' in out[0], false)
}

{
  const plain: ChatMessage[] = [
    { role: 'tool', toolUseId: 'call_o3', toolName: 'file_read', content: 'hello world' }
  ]
  const out = toOllamaMessages(plain)
  check(
    'ollama imageless: byte-identical shape',
    JSON.stringify(out[0]),
    JSON.stringify({
      role: 'tool',
      content: 'hello world',
      tool_name: 'file_read'
    })
  )
}

// ---------------------------------------------------------------------------
// text-only models still see the file, never the bytes
// ---------------------------------------------------------------------------

{
  const stripped = stripVisualContent(history)
  const tool = stripped.find((m) => m.role === 'tool')
  if (tool && tool.role === 'tool') {
    check('strip: images gone', tool.images, undefined)
    checkTrue('strip: caption kept', tool.content.startsWith('Viewing /tmp/a.jpg'))
    checkTrue('strip: text-only note added', tool.content.includes('text-only'))
  } else {
    failed++
    console.error('FAIL strip: tool message missing')
  }
}

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
