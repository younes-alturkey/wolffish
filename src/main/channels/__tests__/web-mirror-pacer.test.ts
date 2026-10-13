/**
 * MirrorPacer — live run mirrors to browsers are fitted under the wire
 * budget, paced by their size, collapsed to the newest snapshot while a
 * browser is not due or its socket is backed up, and discarded once the
 * conversation is saved.
 *
 * Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx \
 *     src/main/channels/__tests__/web-mirror-pacer.test.ts
 */
import type { ConversationMessage } from '../../conversations'
import { MirrorPacer, WEB_MIRROR_MAX_BYTES } from '../web/mirror-pacer'

let passed = 0
let failed = 0
function ok(name: string, cond: boolean, detail?: unknown): void {
  if (cond) passed++
  else {
    failed++
    console.log(`  ✗ ${name}`, detail === undefined ? '' : JSON.stringify(detail))
  }
}

type FakeClient = { id: string; buffered: number; open: boolean; sent: string[] }
const client = (id: string): FakeClient => ({ id, buffered: 0, open: true, sent: [] })

let clock = 1_000
const pacer = new MirrorPacer<FakeClient>({
  isOpen: (c) => c.open,
  buffered: (c) => c.buffered,
  send: (c, frame) => c.sent.push(frame),
  encode: (payload) =>
    JSON.stringify({ t: 'event', channel: 'conversation:messageMirror', payload }),
  now: () => clock
})

function message(id: string, output: string, text = 'working'): ConversationMessage {
  return {
    id,
    role: 'assistant',
    content: text,
    timestamp: 1,
    segments: [
      {
        kind: 'tool_call',
        turnId: 't',
        segmentId: 's1',
        toolCallId: 'c1',
        name: 'web_design',
        args: {}
      },
      { kind: 'tool_result', turnId: 't', segmentId: 's2', toolCallId: 'c1', status: 'ok', output },
      { kind: 'text', turnId: 't', segmentId: 's3', delta: text }
    ]
  } as unknown as ConversationMessage
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const a = client('a')
  pacer.push([a], 'conv', message('m', 'small'))
  ok('a small snapshot goes out at once', a.sent.length === 1)

  const huge = 'x'.repeat(5 * 1024 * 1024)
  clock += 10_000
  pacer.push([a], 'conv', message('m', huge, 'still working'))
  ok('a 5 MB snapshot goes out', a.sent.length === 2)
  ok(
    'and is fitted under the budget',
    Buffer.byteLength(a.sent[1]) <= WEB_MIRROR_MAX_BYTES + 4096,
    Buffer.byteLength(a.sent[1])
  )
  ok('the live prose survives the fit', a.sent[1].includes('still working'))

  pacer.push([a], 'conv', message('m', huge, 'newer'))
  pacer.push([a], 'conv', message('m', huge, 'newest'))
  ok('a big snapshot holds the next one back', a.sent.length === 2)
  clock += 2_000
  await sleep(1_600)
  ok('only the newest waiting snapshot goes out', a.sent.length === 3, a.sent.length)
  ok('it is the newest', a.sent[2]?.includes('newest') && !a.sent[2]?.includes('"newer"'))

  clock += 10_000
  const b = client('b')
  b.buffered = 2 * 1024 * 1024
  pacer.push([b], 'conv', message('m', 'small', 'congested'))
  ok('a backed-up socket waits', b.sent.length === 0)
  b.buffered = 0
  await sleep(300)
  ok('and receives the snapshot once it drains', b.sent.length === 1)

  clock += 10_000
  const c = client('c')
  c.buffered = 2 * 1024 * 1024
  pacer.push([c], 'conv', message('m', 'small', 'stale'))
  pacer.drop()
  c.buffered = 0
  await sleep(300)
  ok('a saved conversation discards the waiting snapshot', c.sent.length === 0)

  const d = client('d')
  d.open = false
  pacer.push([d], 'conv', message('m', 'small'))
  ok('a closed socket gets nothing', d.sent.length === 0)

  console.log(`${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void main()
