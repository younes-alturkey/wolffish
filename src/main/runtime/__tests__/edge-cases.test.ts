/**
 * Edge-case sweep for the lean-context architecture: fresh/empty workspaces,
 * corrupt and malformed inputs, unicode search, boundary marks in replay,
 * degenerate histories, and prompt assembly with missing files. Everything
 * here must degrade gracefully — no throws, no wedged states.
 *
 * Standalone — no vitest/jest in this repo. better-sqlite3 needs Electron's
 * ABI, so run bundled under electron-as-node:
 *   npx esbuild --bundle src/main/runtime/__tests__/edge-cases.test.ts \
 *     --platform=node --format=cjs --external:electron --external:better-sqlite3 \
 *     --alias:@main=./src/main --outfile=node_modules/.cache/wolffish-tests/edge.cjs \
 *   && ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/.cache/wolffish-tests/edge.cjs
 */
import Module from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

async function run(): Promise<void> {
  const { Cortex } = await import('@main/runtime/cortex')
  const ingest = await import('@main/runtime/cortexIngest')
  const { Prefrontal } = await import('@main/runtime/prefrontal')
  const { Cerebellum } = await import('@main/runtime/cerebellum')
  const { replayWindow, stubStaleToolResults } = await import('@main/channels/channel')
  const { messageSizeChars } = await import('@main/conversation-summarizer')

  // ── 1. Fresh/empty workspace: everything degrades to empty, not throws ──
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-empty-'))
  const emptyDb = path.join(empty, 'brain', 'cortex.db')
  const cortexEmpty = new Cortex({ workspaceRoot: empty, dbPath: emptyDb })
  await cortexEmpty.init()
  ok('empty workspace: init survives', true)
  ok('empty workspace: search empty', cortexEmpty.search('anything').length === 0)
  ok('empty workspace: records empty', cortexEmpty.searchRecords('anything', {}).length === 0)
  ok('empty workspace: conversations empty', cortexEmpty.listConversations({}).length === 0)
  ok('empty workspace: usage zeroed', cortexEmpty.usageSummary({}).requests === 0)
  const covEmpty = cortexEmpty.coverage()
  ok('empty workspace: coverage zeroed', covEmpty.conversations === 0 && covEmpty.artifacts === 0)
  await cortexEmpty.catchUp()
  ok('empty workspace: second catchUp no-op', true)
  cortexEmpty.close()

  // Prompt assembly on the empty workspace: no identity files, no cortex —
  // still assembles a usable prompt (contract-less but never throws).
  const cerebellumEmpty = new Cerebellum({ workspaceRoot: empty })
  await cerebellumEmpty.loadAll()
  const prefrontalEmpty = new Prefrontal({ workspaceRoot: empty, cerebellum: cerebellumEmpty })
  const bare = await prefrontalEmpty.buildSystemPrompt(
    'hello',
    { iteration: 1, toolsCalled: 0, renderCounters: false },
    undefined,
    { conversationId: 'edge' }
  )
  ok('empty workspace: prompt assembles', bare.length > 50)
  ok('empty workspace: discovery still core', /tool_search/.test(bare))

  // ── 2. Corrupt / malformed inputs never crash ingest ────────────────
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-corrupt-'))
  write(root, 'brain/conversations/conv-broken.json', '{ this is not json !!!')
  write(root, 'brain/conversations/conv-nomsg.json', JSON.stringify({ id: 'nomsg', title: 'x' }))
  write(root, 'whatsapp/read-history.json', '["array", "not", "object"]')
  write(root, 'usage/daily/2026-07-04.md', '# garbage\n- not | a | valid | line\n- | | |\n')
  write(root, 'brain/hippocampus/episodes/2026-07-04.md', '')
  write(root, 'brain/hippocampus/knowledge/technical.md', 'no headers at all, just prose text')
  write(
    root,
    'brain/hippocampus/episodes/2026-07-03.md',
    '## 10:00 — سؤال عن الرحمن الرحيم\n- **User:** ما الفرق بين الرحمن والرحيم\n'
  )
  const db2 = path.join(root, 'brain', 'cortex.db')
  const cortex2 = new Cortex({ workspaceRoot: root, dbPath: db2 })
  await cortex2.init()
  ok(
    'corrupt conv json: no crash, no records',
    cortex2.getRecordsByRef('conversation:broken').length === 0
  )
  ok('conv without messages: listed harmlessly', cortex2.listConversations({}).length <= 2)
  ok(
    'array read-history: no crash',
    cortex2.getRecordsByRef('file:whatsapp/read-history.json').length === 0
  )
  ok('garbage usage lines: zero ledger rows', cortex2.usageSummary({}).requests === 0)
  ok('headerless md: single record', cortex2.searchRecords('prose text', {}).length >= 1)
  const arabic = cortex2.searchRecords('الرحمن', {})
  ok('arabic FTS search works', arabic.length >= 1)
  cortex2.close()

  // ── 3. WhatsApp ingest edge shapes ───────────────────────────────────
  ok(
    'wa: seconds and ms timestamps both resolve',
    (() => {
      const recs = ingest.ingestWhatsAppHistory(
        'whatsapp/read-history.json',
        JSON.stringify({
          'x@s.whatsapp.net': [
            { fromMe: false, sender: 'A', text: 'seconds ts', timestamp: 1751364000 },
            { fromMe: true, sender: 'me', text: 'ms ts', timestamp: 1751364000000 }
          ]
        })
      )
      return recs.length === 1 && /^\d{4}-\d{2}-\d{2}$/.test(recs[0].date ?? '')
    })()
  )
  ok(
    'wa: empty texts and empty chats skipped',
    ingest.ingestWhatsAppHistory(
      'whatsapp/read-history.json',
      JSON.stringify({ 'a@x': [{ text: '' }, { text: '   ' }], 'b@x': [] })
    ).length === 0
  )

  // ── 4. capContent boundaries ─────────────────────────────────────────
  const exact = 'x'.repeat(4000 + 500 + 40)
  ok('capContent: at threshold untouched', ingest.capContent(exact, 4000, 500) === exact)
  const over = 'h'.repeat(4000) + 'M'.repeat(100) + 't'.repeat(500)
  const capped = ingest.capContent(over, 4000, 500)
  ok(
    'capContent: over threshold marks omission',
    /chars omitted/.test(capped) && capped.length < over.length + 40
  )

  // ── 5. Replay boundary marks ─────────────────────────────────────────
  const msgs = Array.from({ length: 4 }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `m${i}`,
    timestamp: i
  }))
  ok(
    'replayWindow: mark === length → passthrough',
    replayWindow({ id: 'c', messages: msgs, summary: 's', summarizedThroughMessage: 4 }).preamble
      .length === 0
  )
  ok(
    'replayWindow: negative-ish mark (0) → passthrough',
    replayWindow({ id: 'c', messages: msgs, summary: 's', summarizedThroughMessage: 0 }).preamble
      .length === 0
  )
  ok(
    'replayWindow: null summary with mark → passthrough',
    replayWindow({ id: 'c', messages: msgs, summary: null, summarizedThroughMessage: 2 }).preamble
      .length === 0
  )

  // Degenerate histories for the stub pass: no users at all / tools only.
  const toolsOnly = [
    { role: 'tool' as const, toolUseId: 't', toolName: 'x', content: 'Y'.repeat(5000) }
  ]
  const stubbed = stubStaleToolResults(toolsOnly, 'c')
  ok(
    'stub: no-user history leaves content intact',
    (stubbed[0] as { content: string }).content.length === 5000
  )

  // ── 6. Summarizer accounting on degenerate messages ──────────────────
  ok(
    'messageSizeChars: missing fields → 0',
    messageSizeChars({ role: 'user', content: '', timestamp: 0 }) === 0
  )

  // ── 7. Discovery edge inputs ─────────────────────────────────────────
  const cb = new Cerebellum({})
  await cb.loadAll()
  const emptyQ = await cb.executeTool('tool_search', { query: '' })
  ok('tool_search: empty query errors instructively', emptyQ.success === false)
  const shortQ = await cb.executeTool('tool_search', { query: 'a b' })
  ok('tool_search: sub-3-char terms degrade to no-match message', shortQ.success === true)
  const activateGhost = cb.activateCapability('does-not-exist')
  ok('activate unknown capability: clean error', activateGhost.ok === false)

  // ── 8. Artifact classification oddities ──────────────────────────────
  ok('artifact: no extension → kind file', ingest.artifactKind('files/README') === 'file')
  ok(
    'artifact: nested conv provenance',
    ingest.artifactConversationId('uploads/conv-2026-07-01_x-abc/deep/dir/img.png') ===
      '2026-07-01_x-abc'
  )
  ok(
    'artifact: no provenance outside conv dirs',
    ingest.artifactConversationId('files/report.pdf') === null
  )

  fs.rmSync(empty, { recursive: true, force: true })
  fs.rmSync(root, { recursive: true, force: true })

  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void run().catch((err) => {
  console.error('test harness crashed:', err)
  process.exit(1)
})
