/**
 * Cortex v2 tests: ingest parsers (conversations incl. tool calls, tasks,
 * usage ledger, logs, artifacts), path classification, schema-versioned
 * init, incremental catch-up, record-level search with source/date filters,
 * conversation enumeration, usage aggregation, artifact provenance, and the
 * legacy path-level search staying restricted to curated markdown sources.
 *
 * Standalone — no vitest/jest in this repo. better-sqlite3 is built for the
 * Electron ABI, so this runs under electron-as-node:
 *   npx esbuild --bundle src/main/runtime/__tests__/cortex-v2.test.ts \
 *     --platform=node --format=cjs --external:electron --external:better-sqlite3 \
 *     --alias:@main=./src/main --outfile=/tmp/cortex-v2.test.cjs \
 *   && ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron /tmp/cortex-v2.test.cjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

function check<T>(label: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  if (same) {
    passed++
  } else {
    failed++
    console.error(
      `FAIL ${label}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`
    )
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

  // ── isIndexablePath classification ──────────────────────────────────
  ok('episodes indexable', ingest.isIndexablePath('brain/hippocampus/episodes/2026-07-01.md'))
  ok(
    'conversation indexable',
    ingest.isIndexablePath('brain/conversations/conv-2026-07-01_10-00-00_000-abc123.json')
  )
  ok('task detail log indexable', ingest.isIndexablePath('brain/motor/tasks/TASK-x1-detail.log'))
  ok('usage indexable', ingest.isIndexablePath('usage/daily/2026-07-01.md'))
  ok('app log indexable', ingest.isIndexablePath('logs/2026-07-01.log'))
  ok('extension jsonl indexable', ingest.isIndexablePath('logs/extension/conv-abc.jsonl'))
  ok('artifact indexable', ingest.isIndexablePath('files/report.pdf'))
  ok('uploads artifact indexable', ingest.isIndexablePath('uploads/conv-abc/photo.png'))
  ok('config excluded', !ingest.isIndexablePath('config.json'))
  ok('config.bak excluded', !ingest.isIndexablePath('config.json.bak'))
  ok('whatsapp auth excluded', !ingest.isIndexablePath('whatsapp/auth/creds.json'))
  ok('whatsapp read-history indexable', ingest.isIndexablePath('whatsapp/read-history.json'))
  ok('telegram maps excluded', !ingest.isIndexablePath('telegram/chats.json'))
  ok('cerebellum code excluded', !ingest.isIndexablePath('brain/cerebellum/shell/SKILL.md'))
  ok('dot-dir excluded', !ingest.isIndexablePath('brain/cerebellum/.shell/SKILL.md'))
  ok('.debug excluded', !ingest.isIndexablePath('brain/prefrontal/.debug/2026-07-01.md'))
  ok('.debug-archive excluded', !ingest.isIndexablePath('brain/prefrontal/.debug-archive/x.md'))
  ok('node_modules excluded', !ingest.isIndexablePath('files/proj/node_modules/pkg/readme.md'))
  ok('heartbeat-state excluded', !ingest.isIndexablePath('brain/brainstem/heartbeat-state.json'))
  ok('cortex.db excluded', !ingest.isIndexablePath('brain/cortex.db'))
  ok('run-history indexable', ingest.isIndexablePath('brain/brainstem/run-history.md'))

  // ── Fixture workspace ───────────────────────────────────────────────
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-v2-'))

  write(
    root,
    'brain/hippocampus/episodes/2026-07-01.md',
    '## 10:15 — Booked the flight plan\n\nUser: send my flight plan to the pilot\nTools: file_read (ok)\nResponse: sent the Riyadh flight plan PDF.\n\n## 11:00 — Weather check\n\nUser: weather in Jeddah\nResponse: sunny.\n'
  )
  write(
    root,
    'brain/hippocampus/knowledge/preferences.md',
    '## Email style\n\n- Prefers concise emails signed "Y".\n'
  )
  const convId = '2026-07-01_12-00-00_000-fp1234'
  write(
    root,
    `brain/conversations/conv-${convId}.json`,
    JSON.stringify({
      id: convId,
      title: 'Flight plan delivery',
      channel: 'telegram',
      createdAt: 1751360400000,
      updatedAt: 1751364000000,
      sealed: false,
      icon: '🛩️',
      messages: [
        { role: 'user', content: 'send me the flight plan', timestamp: 1751360400000 },
        {
          role: 'assistant',
          content: 'Here is the flight plan.',
          timestamp: 1751360460000,
          segments: [
            { kind: 'text', turnId: 't1', segmentId: 's1', delta: 'Here is the flight plan.' },
            {
              kind: 'tool_call',
              turnId: 't1',
              segmentId: 's2',
              toolCallId: 'tc1',
              name: 'file_read',
              args: { path: '/tmp/flightplan-OERK.pdf' }
            },
            {
              kind: 'tool_result',
              turnId: 't1',
              segmentId: 's3',
              toolCallId: 'tc1',
              status: 'success',
              output: 'FLIGHT PLAN OERK to OEJN departure 0800Z cruise FL350 squawk 4021'
            }
          ]
        }
      ]
    })
  )
  write(
    root,
    'brain/motor/tasks/TASK-abc123.md',
    '# Task: Compress the vacation video\n\n- **ID:** TASK-abc123\n- **Status:** SUCCEEDED\n- **Created:** 2026-07-01T09:00:00.000Z\n- **Updated:** 2026-07-01T09:05:00.000Z\n- **Steps:** 2/2 succeeded\n\n## Steps\n\n### Step 1: ffmpeg_run ✓\n- **Args:** `{"input":"vacation.mp4"}`\n- **Result:** succeeded\n'
  )
  write(
    root,
    'brain/motor/tasks/TASK-abc123-detail.log',
    '# Task Detail Log: TASK-abc123\n\n## Step 1: ffmpeg_run\n```\nframe=999 encoded vacation.mp4 to h265 successfully bitrate=2000k\n```\n'
  )
  write(
    root,
    'brain/basalganglia/2026-07-01.md',
    '- 10:15 | file_read | ok\n  Args: {"path":"/tmp/flightplan-OERK.pdf"}\n  Output: FLIGHT PLAN OERK...\n'
  )
  write(
    root,
    'usage/daily/2026-07-01.md',
    '# 2026-07-01\n\n- 00:15:24 | DeepSeek | deepseek-v4-pro | in:97956 out:476 cw:0 cr:303616 | $0.045666\n- 04:16:00 | DeepSeek | deepseek-v4-flash | in:1000 out:100 | $0.001000\n'
  )
  write(
    root,
    'logs/2026-07-01.log',
    'boot ok\ntelegram connected\nmcp zapier session error E_SESSION\n'
  )
  write(root, 'files/quarterly-report.pdf', 'PDFBYTES')
  write(root, 'uploads/conv-2026-07-01_12-00-00_000-fp1234/flightplan.pdf', 'PDFBYTES2')
  write(root, 'brain/prefrontal/.debug/should-not-index.md', 'nope')
  write(root, 'config.json', '{"secret":"nope"}')
  write(
    root,
    'whatsapp/read-history.json',
    JSON.stringify({
      '966555000111@s.whatsapp.net': [
        {
          id: 'w1',
          jid: '966555000111@s.whatsapp.net',
          fromMe: false,
          sender: 'Sana',
          text: 'remember the picnic basket for Friday',
          timestamp: 1751364000
        },
        {
          id: 'w2',
          jid: '966555000111@s.whatsapp.net',
          fromMe: true,
          sender: 'me',
          text: 'noted — basket, juice, frisbee',
          timestamp: 1751364060
        }
      ]
    })
  )

  const dbPath = path.join(root, 'brain', 'cortex.db')
  const cortex = new Cortex({ workspaceRoot: root, dbPath })
  await cortex.init()

  // ── Legacy path-level search: curated sources only ──────────────────
  const pathHits = cortex.search('flight plan pilot Riyadh')
  ok(
    'path search finds episode',
    pathHits.some((h) => h.path.includes('episodes/2026-07-01.md'))
  )
  ok(
    'path search never returns conversation JSONs',
    pathHits.every((h) => !h.path.endsWith('.json'))
  )
  const better = cortex.search('flight plan pilot Riyadh')
  ok(
    'scores in (0,1]',
    better.every((h) => h.score > 0 && h.score <= 1)
  )

  // ── Record-level search across everything ───────────────────────────
  const toolHits = cortex.searchRecords('squawk cruise FL350', {})
  ok(
    'tool_result output searchable',
    toolHits.some((h) => h.ref.startsWith(`conversation:${convId}#1.`))
  )
  const convOnly = cortex.searchRecords('flight plan', { sources: ['conversation'] })
  ok(
    'source filter works',
    convOnly.length > 0 && convOnly.every((h) => h.source === 'conversation')
  )
  const dateFiltered = cortex.searchRecords('flight plan', { after: '2026-07-02' })
  ok(
    'date filter excludes older',
    dateFiltered.every((h) => (h.date ?? '') >= '2026-07-02')
  )
  const detailHits = cortex.searchRecords('h265 bitrate', { sources: ['task'] })
  ok(
    'task detail log searchable',
    detailHits.some((h) => h.ref.startsWith('task:abc123#detail'))
  )
  const logHits = cortex.searchRecords('E_SESSION zapier', { sources: ['log'] })
  ok('app log tail searchable', logHits.length > 0)
  const waHits = cortex.searchRecords('picnic basket Friday', { sources: ['conversation'] })
  ok(
    'whatsapp inbound history searchable',
    waHits.some((h) => h.ref.includes('whatsapp/read-history'))
  )
  const feedbackHits = cortex.searchRecords('flightplan OERK', { sources: ['feedback'] })
  ok('basalganglia searchable', feedbackHits.length > 0)

  // ── Refs / conversation read path ───────────────────────────────────
  const convRecords = cortex.getRecordsByRef(`conversation:${convId}#`)
  ok('conversation records by ref-prefix', convRecords.length >= 3)
  ok(
    'ref content is capped excerpt not raw JSON',
    convRecords.every((r) => !r.content.startsWith('{'))
  )

  // ── Conversation enumeration ────────────────────────────────────────
  const convs = cortex.listConversations({})
  check('one conversation listed', convs.length, 1)
  check('conversation channel', convs[0]?.channel, 'telegram')
  check('conversation msg count', convs[0]?.messageCount, 2)
  // The list fast path feeds the rail's number-chip badge straight from this
  // row — a missing icon column is why the badge only showed on a cold index.
  check('conversation icon', convs[0]?.icon, '🛩️')
  const byChannel = cortex.listConversations({ channel: 'whatsapp' })
  check('channel filter empty', byChannel.length, 0)

  // ── Conversation count (usage:getStats fast path) ───────────────────
  // The fixture's createdAt is 1751360400000 and its updatedAt is an hour
  // later, which is what separates these from listConversations({ after }):
  // that filters on updated_at, so a cutoff between the two would wrongly
  // count this conversation as created in the window.
  check('count since epoch', cortex.countConversationsSince(0), 1)
  check('count at exact createdAt', cortex.countConversationsSince(1751360400000), 1)
  check('count after createdAt', cortex.countConversationsSince(1751360400001), 0)
  check(
    'count keyed on created_at not updated_at',
    cortex.countConversationsSince(1751364000000),
    0
  )
  // An empty table means "nothing indexed yet", not "zero conversations" — it
  // must return null so usage:getStats falls back to the disk scan instead of
  // reporting a confident 0. A never-init'd cortex must do the same, not throw.
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-empty-'))
  const emptyCortex = new Cortex({
    workspaceRoot: emptyRoot,
    dbPath: path.join(emptyRoot, 'empty.db')
  })
  check('cold cortex counts null before init', emptyCortex.countConversationsSince(0), null)
  await emptyCortex.init()
  check('empty table counts null, not 0', emptyCortex.countConversationsSince(0), null)
  // Windows keeps the db file locked while the handle is open — rmSync EBUSYs.
  emptyCortex.close()
  fs.rmSync(emptyRoot, { recursive: true, force: true })

  // ── Usage ledger ────────────────────────────────────────────────────
  const usage = cortex.usageSummary({})
  check('usage request count', usage.requests, 2)
  check('usage input tokens', usage.inputTokens, 98956)
  ok('usage cost aggregated', Math.abs(usage.cost - 0.046666) < 1e-9)
  ok('usage by-model present', usage.byModel.length === 2)

  // ── Artifacts + provenance ──────────────────────────────────────────
  const artifacts = cortex.searchArtifacts({ query: 'flightplan' })
  check('artifact found by name', artifacts.length, 1)
  check('artifact provenance', artifacts[0]?.conversationId, convId)
  const reports = cortex.searchArtifacts({ kind: 'pdf' })
  check('artifact kind filter', reports.length, 2)
  const artifactRecords = cortex.searchRecords('quarterly report', { sources: ['artifact'] })
  ok('artifact name searchable via FTS', artifactRecords.length > 0)

  // ── Tasks table (fixed parser) ──────────────────────────────────────
  const coverage = cortex.coverage()
  ok('coverage has sources', coverage.recordsBySource.length >= 5)
  check('coverage conversations', coverage.conversations, 1)
  check('coverage artifacts', coverage.artifacts, 2)

  // ── Excluded files never indexed ────────────────────────────────────
  const secretHits = cortex.searchRecords('secret nope', {})
  check('config.json not indexed', secretHits.length, 0)

  // ── Incremental catch-up ────────────────────────────────────────────
  cortex.close()
  // modify one file + add one + remove one while "the app is closed"
  write(
    root,
    'brain/hippocampus/knowledge/preferences.md',
    '## Email style\n\n- Prefers concise emails signed "Y".\n- Always CC the assistant on invoices.\n'
  )
  write(
    root,
    'brain/hippocampus/episodes/2026-07-02.md',
    '## 09:00 — Zeta protocol\n\nUser: run zeta\n'
  )
  fs.unlinkSync(path.join(root, 'logs/2026-07-01.log'))

  const cortex2 = new Cortex({ workspaceRoot: root, dbPath })
  await cortex2.init()
  ok('catch-up indexed changed file', cortex2.searchRecords('invoices CC assistant', {}).length > 0)
  ok('catch-up indexed new file', cortex2.searchRecords('zeta protocol', {}).length > 0)
  check('catch-up dropped removed file', cortex2.searchRecords('E_SESSION zapier', {}).length, 0)

  // ── Watcher-style single-file index/remove ──────────────────────────
  write(root, 'files/new-artifact.png', 'PNG')
  await cortex2.indexFile(path.join(root, 'files/new-artifact.png'))
  ok('indexFile adds artifact', cortex2.searchArtifacts({ query: 'new-artifact' }).length === 1)
  await cortex2.removeFile(path.join(root, 'files/new-artifact.png'))
  check('removeFile drops artifact', cortex2.searchArtifacts({ query: 'new-artifact' }).length, 0)
  cortex2.close()

  fs.rmSync(root, { recursive: true, force: true })

  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void run().catch((err) => {
  console.error('test harness crashed:', err)
  process.exit(1)
})
