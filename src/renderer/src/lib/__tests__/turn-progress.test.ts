/**
 * The clean feed's live status line: newest of reasoning-summary title and
 * tool call wins, worker segments are ignored, targets are compact.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx \
 *     src/renderer/src/lib/__tests__/turn-progress.test.ts
 */

import type { Segment } from '@preload/index'
import { turnProgress } from '../turn-progress/turnProgress'

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++
    return
  }
  failed++
  console.log(`  ✗ ${label}`, detail === undefined ? '' : JSON.stringify(detail))
}

const reasoning = (delta: string, worker = false): Segment =>
  ({
    kind: 'reasoning',
    turnId: 't',
    segmentId: `r${Math.random()}`,
    delta,
    ...(worker ? { worker: { id: 'w', label: 'w' } } : {})
  }) as Segment
const call = (name: string, args: Record<string, unknown>, worker = false): Segment =>
  ({
    kind: 'tool_call',
    turnId: 't',
    segmentId: `c${Math.random()}`,
    toolCallId: `id${Math.random()}`,
    name,
    args,
    ...(worker ? { worker: { id: 'w', label: 'w' } } : {})
  }) as Segment

ok('nothing yet → null', turnProgress([]) === null)

const thought = turnProgress([
  call('web_fetch', { url: 'https://www.fda.gov/safety' }),
  reasoning(
    '**Scanning regulators**\n\nChecking FDA.\n\n**Weighing the MHRA alert**\n\nIt is a recall.'
  )
])
ok(
  'latest summary title wins over an older call',
  thought?.kind === 'thought' && thought.text === 'Weighing the MHRA alert',
  thought
)

const visit = turnProgress([
  reasoning('**Plan**'),
  call('browser_navigate', { url: 'https://www.gov.uk/drug-device-alerts' })
])
ok(
  'newer call wins, url shows as host',
  visit?.kind === 'tool' && visit.verb === 'visit' && visit.target === 'gov.uk',
  visit
)

const search = turnProgress([call('memory_search', { query: 'anesthesia_brief_ledger' })])
ok(
  'query → search',
  search?.kind === 'tool' &&
    search.verb === 'search' &&
    search.target === 'anesthesia_brief_ledger',
  search
)

const file = turnProgress([
  call('browser_pdf', { path: '/root/.wolffish/workspace/files/brief.pdf' })
])
ok(
  'path → file basename',
  file?.kind === 'tool' && file.verb === 'file' && file.target === 'brief.pdf',
  file
)

const bare = turnProgress([call('pdf_design', {})])
ok(
  'no target → tool name',
  bare?.kind === 'tool' && bare.verb === 'use' && bare.target === 'pdf design',
  bare
)

const untitled = turnProgress([
  call('shell_exec', { command: 'date -u\necho hi' }),
  reasoning('plain thinking, no title')
])
ok(
  'untitled reasoning falls through to the call',
  untitled?.kind === 'tool' && untitled.verb === 'run' && untitled.target === 'date -u',
  untitled
)

const load = turnProgress([call('tool_activate', { capability: 'pdf-design' })])
ok(
  'capability → load',
  load?.kind === 'tool' && load.verb === 'load' && load.target === 'pdf design',
  load
)

const workers = turnProgress([
  call('web_fetch', { url: 'https://a.org' }),
  call('web_fetch', { url: 'https://b.org' }, true),
  reasoning('**Worker title**', true)
])
ok('worker segments ignored', workers?.kind === 'tool' && workers.target === 'a.org', workers)

console.log(`${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
