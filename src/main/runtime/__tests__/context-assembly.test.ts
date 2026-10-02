/**
 * Context-assembly optimization tests — the system-prompt side of context
 * (prefrontal/RAS/basalganglia/hippocampus), distinct from the messages-side
 * compaction covered by context-optimization.test.ts.
 *
 * Covers:
 *   - basalganglia.summarizePreferences: bounded digest, keeps the learning
 *     signal (reliability + denials + corrections), drops the success firehose.
 *   - ras.clampAssemblyBudget: model window never dictates assembly size.
 *   - ras.filterContext: oversized candidates are truncated-to-fit (with a
 *     recall marker), not dropped wholesale; small ones pass through whole.
 *   - hippocampus renderTurn (via appendEpisode): verbatim user messages are
 *     capped so a multi-KB prompt can't bloat the history section.
 *
 * Run: npx tsx src/main/runtime/__tests__/context-assembly.test.ts
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { summarizePreferences } from '../basalganglia'
import { BasalGanglia } from '../basalganglia'
import { toFtsMatchQuery, FTS_MAX_TERMS } from '../cortexQuery'
import { Device } from '../device'
import { Hippocampus } from '../hippocampus'
import {
  clampAssemblyBudget,
  MAX_ASSEMBLY_BUDGET_TOKENS,
  PER_CANDIDATE_MAX_TOKENS,
  RAS,
  type ContextCandidate
} from '../ras'

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

function ok(label: string, cond: boolean): void {
  check(label, cond, true)
}

// ---------------------------------------------------------------------------
// summarizePreferences — bounded digest, learning signal preserved
// ---------------------------------------------------------------------------

// Build a realistic day file: lots of successes (the old firehose) plus the
// signal that matters — one denial and one failure with a reason.
function dayFile(date: string, successes: number): string {
  const lines = [`# ${date}`, '']
  for (let i = 0; i < successes; i++) {
    lines.push(
      `- 07:${String(10 + (i % 40)).padStart(2, '0')} | web_search | success`,
      '  - Args: `{"query":"saudi news june 2026"}`',
      '  - Output: `{"provider":"brave","results":[{"title":"Long verbose output that used to be dumped verbatim into every single prompt and cost ~60k tokens across the window"}]}`',
      ''
    )
  }
  lines.push(
    '- 09:00 | shell_exec | denied',
    '  - Args: `{"command":"rm -rf /tmp/x"}`',
    '  - Reason: destructive command rejected by user',
    '',
    '- 09:05 | web_fetch | failed',
    '  - Args: `{"url":"https://www.reuters.com/x"}`',
    '  - Error: HTTP 401 Forbidden — paywalled site',
    ''
  )
  return lines.join('\n')
}

const digest = summarizePreferences([
  { date: '2026-06-20', raw: dayFile('2026-06-20', 30) },
  { date: '2026-06-21', raw: dayFile('2026-06-21', 30) }
])

ok('digest: non-empty', digest.length > 0)
ok('digest: bounded under cap', digest.length <= 2400)
ok('digest: reports reliability', /Reliability: \d+ tool calls, \d+% success/.test(digest))
ok('digest: names most-used tool', digest.includes('web_search'))
ok('digest: surfaces the denial', digest.toLowerCase().includes('denied'))
ok('digest: surfaces the failure reason', digest.includes('401') || digest.includes('paywalled'))
ok('digest: surfaces destructive correction', digest.toLowerCase().includes('destructive'))
// The whole point: successful-call OUTPUT bodies are NOT echoed back.
ok('digest: drops the success firehose', !digest.includes('Long verbose output'))
ok('digest: points at recall for detail', digest.toLowerCase().includes('wolffish_recall'))

// Token win: a 60-success window would be tens of KB raw; the digest is tiny.
const rawConcat = dayFile('2026-06-20', 30) + '\n\n' + dayFile('2026-06-21', 30)
ok('digest: an order of magnitude smaller than raw', digest.length < rawConcat.length / 8)

check('digest: empty input → empty string', summarizePreferences([]), '')

// ---------------------------------------------------------------------------
// clampAssemblyBudget — the model window never dictates assembly size
// ---------------------------------------------------------------------------

check(
  'clamp: 1M window clamped to ceiling',
  clampAssemblyBudget(1_000_000),
  MAX_ASSEMBLY_BUDGET_TOKENS
)
check('clamp: small window passes through', clampAssemblyBudget(8_000), 8_000)
check('clamp: zero/garbage → ceiling', clampAssemblyBudget(0), MAX_ASSEMBLY_BUDGET_TOKENS)
check('clamp: NaN → ceiling', clampAssemblyBudget(Number.NaN), MAX_ASSEMBLY_BUDGET_TOKENS)

// ---------------------------------------------------------------------------
// RAS.filterContext — per-candidate truncation, not wholesale drop
// ---------------------------------------------------------------------------

const ras = new RAS()
const budget = ras.allocateBudget(clampAssemblyBudget(967_232))

// A genuinely huge, highly-relevant memory blob (~200k chars ≈ 50k tokens).
const hugeContent = 'world cup standings goals ' + 'x'.repeat(200_000)
const fat: ContextCandidate = {
  category: 'memory',
  source: 'brain/basalganglia/firehose.md',
  content: hugeContent
}
const small: ContextCandidate = {
  category: 'memory',
  source: 'brain/hippocampus/knowledge/projects.md',
  content: 'world cup project: track standings and goals for the user'
}

const filtered = ras.filterContext(
  'what are the world cup standings and goals',
  [fat, small],
  budget
)
const fatOut = filtered.find((c) => c.source === fat.source)
const smallOut = filtered.find((c) => c.source === small.source)

ok('ras: oversized candidate retained (not dropped)', Boolean(fatOut))
ok('ras: oversized candidate truncated', (fatOut?.content.length ?? 0) < hugeContent.length)
ok(
  'ras: truncated candidate within per-candidate cap',
  (fatOut?.tokens ?? Infinity) <= PER_CANDIDATE_MAX_TOKENS + 50
)
ok('ras: truncation marker points at recall', fatOut?.content.includes('wolffish_recall') ?? false)
ok('ras: small relevant candidate kept whole', smallOut?.content === small.content)

// Total memory must respect the (clamped) category cap.
const memTokens = filtered.filter((c) => c.category === 'memory').reduce((s, c) => s + c.tokens, 0)
ok('ras: memory total within category cap', memTokens <= budget.memory)

// Mandatory categories are never truncated even when large.
const bigIdentity: ContextCandidate = {
  category: 'identity',
  source: 'brain/identity/soul.md',
  content: 'I am Wolffish. '.repeat(10_000)
}
const idOut = ras.filterContext(
  'hi',
  [bigIdentity],
  ras.allocateBudget(clampAssemblyBudget(967_232))
)
ok('ras: mandatory identity kept whole', idOut[0]?.content === bigIdentity.content)

// ---------------------------------------------------------------------------
// hippocampus renderTurn — verbatim user message capped in episodes
// ---------------------------------------------------------------------------

async function testHippo(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-hippo-'))
  try {
    const hippo = new Hippocampus({ workspaceRoot: root })
    const giantPrompt =
      'ROLE: You are Wolffish in full autonomous agent mode. ' + 'y'.repeat(20_000)
    await hippo.appendEpisode({
      timestamp: new Date(),
      userMessage: giantPrompt,
      toolCalls: [{ name: 'web_search', argsSummary: '', outcome: 'success' }],
      assistantResponse: 'done'
    })
    const ep = await hippo.getTodayEpisode()
    // The episode for that day must exist but the giant prompt must be capped.
    const userLine = (ep?.content ?? '').split('\n').find((l) => l.startsWith('- **User:**')) ?? ''
    ok('hippo: episode written', (ep?.content.length ?? 0) > 0)
    ok('hippo: user line capped well under the raw prompt', userLine.length < 400)
    ok('hippo: cap leaves a truncation marker', userLine.includes('…'))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// basalganglia.getPreferences — excludes today, stays bounded, on real shape
// ---------------------------------------------------------------------------

async function testBasalGanglia(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-bg-'))
  try {
    const dir = path.join(root, 'brain', 'basalganglia')
    await fs.mkdir(dir, { recursive: true })
    const today = new Date()
    const y = today.getFullYear()
    const m = String(today.getMonth() + 1).padStart(2, '0')
    const d = String(today.getDate()).padStart(2, '0')
    const todayKey = `${y}-${m}-${d}`
    await fs.writeFile(path.join(dir, '2026-06-20.md'), dayFile('2026-06-20', 20), 'utf8')
    await fs.writeFile(
      path.join(dir, `${todayKey}.md`),
      `# ${todayKey}\n\n- 08:00 | secret_today_tool | success\n  - Args: \`{}\`\n  - Output: \`ok\`\n`,
      'utf8'
    )
    const bg = new BasalGanglia({ workspaceRoot: root })
    const prefs = await bg.getPreferences(7)
    ok('bg: digest produced from disk', prefs.length > 0)
    ok(
      'bg: today excluded from digest (lives in live thread)',
      !prefs.includes('secret_today_tool')
    )
    ok('bg: digest bounded', prefs.length <= 2400)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// device.getBlockBody — cached-prefix stability (no volatile free RAM/disk)
// ---------------------------------------------------------------------------

async function testDevice(): Promise<void> {
  const device = new Device()
  const a = await device.getBlockBody()
  const b = await device.getBlockBody()
  // The block sits inside the provider-cached system-prompt prefix (before the
  // <runtime> breakpoint), so it must be byte-stable across calls — any
  // free-RAM/free-disk figure would change between turns and bust the cache.
  ok('device: block is byte-stable across calls', a === b)
  ok('device: reports total RAM (static fact kept)', /ram: .*total/.test(a))
  ok('device: omits volatile free figures', !/free/i.test(a))
}

// ---------------------------------------------------------------------------
// toFtsMatchQuery — bounded query (the fix for the 6-minute main-thread freeze)
// ---------------------------------------------------------------------------

// A long multi-section prompt like the one that froze the app: ~1,400 tokens.
const hugePrompt = (
  'You are my World Cup analyst. Research EVERYTHING about the FIFA World Cup 2026 — ' +
  'every team, every player, every match, every stat — and build one print-ready PDF. ' +
  'group standings goals assists yellow red cards possession fixtures win probability. '
).repeat(40)

const hugeQuery = toFtsMatchQuery(hugePrompt) ?? ''
const hugeTermCount = hugeQuery ? hugeQuery.split(' OR ').length : 0

ok('fts: huge prompt produced a query', hugeQuery.length > 0)
ok('fts: term count capped at the max', hugeTermCount <= FTS_MAX_TERMS)
ok('fts: terms are quoted', /^"[^"]+"( OR "[^"]+")*$/.test(hugeQuery))
// the old code emitted ~1,400 OR-terms for the real prompt; this is the regression guard
ok('fts: nowhere near the old unbounded ~1,400 terms', hugeTermCount < 100)

// dedupe + stopwords + min-length
const q = toFtsMatchQuery('the World World cup CUP a an of to PDF pdf goalkeeper') ?? ''
const terms = q.split(' OR ').map((t) => t.replace(/"/g, ''))
ok('fts: deduped (world once)', terms.filter((t) => t === 'world').length === 1)
ok('fts: stop words dropped (the/of/to gone)', !terms.includes('the') && !terms.includes('to'))
ok('fts: sub-3-char tokens dropped (a/an gone)', !terms.includes('a') && !terms.includes('an'))
ok('fts: case-folded dedupe (cup once)', terms.filter((t) => t === 'cup').length === 1)
ok('fts: real keywords kept', terms.includes('goalkeeper') && terms.includes('pdf'))

check('fts: empty input → null', toFtsMatchQuery('   '), null)
check('fts: only stop words → null', toFtsMatchQuery('the a of to is are'), null)

async function main(): Promise<void> {
  await testHippo()
  await testBasalGanglia()
  await testDevice()
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
