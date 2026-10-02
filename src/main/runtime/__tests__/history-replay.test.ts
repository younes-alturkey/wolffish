/**
 * History-replay tests: rolling-summary replay window (summary preamble +
 * mark slice), stale tool-result stubbing with recovery pointers, and the
 * summarizer's message-size accounting.
 *
 * Standalone — no vitest/jest in this repo.
 * Run: npx tsx --tsconfig tsconfig.node.json src/main/runtime/__tests__/history-replay.test.ts
 */
import Module from 'node:module'
import os from 'node:os'

const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => os.tmpdir() }
    }
  }
  return origLoad.apply(this, args)
}

let passed = 0
let failed = 0

function ok(label: string, cond: boolean): void {
  if (cond) {
    passed++
  } else {
    failed++
    console.error(`FAIL ${label}`)
  }
}

async function run(): Promise<void> {
  const { replayWindow, stubStaleToolResults } = await import('@main/channels/channel')
  const { messageSizeChars } = await import('@main/conversation-summarizer')

  // ── replayWindow ────────────────────────────────────────────────────
  const msgs = Array.from({ length: 10 }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `message ${i}`,
    timestamp: i
  }))

  const noSummary = replayWindow({ id: 'c1', messages: msgs })
  ok(
    'no summary → full passthrough',
    noSummary.messages.length === 10 && noSummary.preamble.length === 0
  )

  const windowed = replayWindow({
    id: 'c1',
    messages: msgs,
    summary: 'earlier stuff happened',
    summarizedThroughMessage: 6
  })
  ok(
    'mark slices messages',
    windowed.messages.length === 4 && windowed.messages[0].content === 'message 6'
  )
  ok('slice starts on a user message', windowed.messages[0].role === 'user')
  ok(
    'preamble is user+assistant pair',
    windowed.preamble.length === 2 && windowed.preamble[0].role === 'user'
  )
  ok(
    'preamble names the recovery tool',
    typeof windowed.preamble[0].content === 'string' &&
      windowed.preamble[0].content.includes('conversation_read("c1")') &&
      windowed.preamble[0].content.includes('earlier stuff happened')
  )

  const badMark = replayWindow({
    id: 'c1',
    messages: msgs,
    summary: 'x',
    summarizedThroughMessage: 99
  })
  ok(
    'out-of-range mark → passthrough',
    badMark.messages.length === 10 && badMark.preamble.length === 0
  )

  // ── stubStaleToolResults ────────────────────────────────────────────
  const big = 'X'.repeat(5000)
  const history = [
    { role: 'user' as const, content: 'first ask' },
    {
      role: 'assistant' as const,
      content: 'working',
      toolUses: [{ id: 't1', name: 'ext_read_page', args: {} }]
    },
    { role: 'tool' as const, toolUseId: 't1', toolName: 'ext_read_page', content: big },
    { role: 'user' as const, content: 'second ask' },
    {
      role: 'assistant' as const,
      content: 'more',
      toolUses: [{ id: 't2', name: 'shell_exec', args: {} }]
    },
    { role: 'tool' as const, toolUseId: 't2', toolName: 'shell_exec', content: big },
    { role: 'user' as const, content: 'third ask' },
    {
      role: 'assistant' as const,
      content: 'final',
      toolUses: [{ id: 't3', name: 'file_read', args: {} }]
    },
    { role: 'tool' as const, toolUseId: 't3', toolName: 'file_read', content: big }
  ]
  const stubbed = stubStaleToolResults(history, 'conv-99')
  const t1 = stubbed[2] as { content: string }
  const t2 = stubbed[5] as { content: string }
  const t3 = stubbed[8] as { content: string }
  ok(
    'old large result stubbed',
    t1.content.length < 300 && t1.content.includes('conversation_read("conv-99")')
  )
  ok(
    'stub names the tool and size',
    t1.content.includes('ext_read_page') && t1.content.includes('5000')
  )
  ok('last-2-exchange results protected', t2.content === big && t3.content === big)

  const smallHistory = [
    { role: 'user' as const, content: 'a' },
    { role: 'tool' as const, toolUseId: 'x', toolName: 'y', content: 'tiny' },
    { role: 'user' as const, content: 'b' },
    { role: 'user' as const, content: 'c' }
  ]
  const smallStubbed = stubStaleToolResults(smallHistory, 'conv-1')
  ok('small results never stubbed', (smallStubbed[1] as { content: string }).content === 'tiny')

  // ── messageSizeChars ────────────────────────────────────────────────
  const size = messageSizeChars({
    role: 'assistant',
    content: 'abc',
    timestamp: 0,
    segments: [
      { kind: 'text', turnId: 't', segmentId: 's1', delta: '12345' },
      {
        kind: 'tool_result',
        turnId: 't',
        segmentId: 's2',
        toolCallId: 'tc',
        status: 'success',
        output: '1234567890'
      }
    ]
  })
  ok('messageSizeChars counts content+segments', size === 3 + 5 + 10)

  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void run().catch((err) => {
  console.error('test harness crashed:', err)
  process.exit(1)
})
