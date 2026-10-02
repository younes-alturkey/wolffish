/**
 * The app's conversation title search (filterConversationRows), which the
 * History page and the conversations sheet both narrow their lists with.
 *
 * The cases here are deliberately the SAME table the terminal's side is
 * pinned against (src/cli/test/search.test.ts). The two matchers are separate
 * code in separate languages; the only thing keeping the app's search box and
 * `/conversations release notes` agreeing is that both are held to this list.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx \
 *     src/renderer/src/lib/__tests__/conversation-search.test.ts
 */

import { conversationSearchKeywords, filterConversationRows } from '../conversation-rows'
import type { ConversationRow } from '../conversation-rows'

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
}

const TITLES = [
  'Notes for the 1.0.311 release',
  'Invoice follow-up with the bank',
  'Café menu translation',
  'Untitled'
]

const ROWS: ConversationRow[] = TITLES.map((title, i) => ({
  conversationId: String(i),
  title,
  phase: null,
  channel: null,
  icon: null,
  projectId: null,
  at: 1000 - i,
  updatedAt: 1000 - i,
  indexed: true
}))

const found = (query: string): string[] => filterConversationRows(ROWS, query).map((r) => r.title)

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

function run(): void {
  // ------------------------------------------------------- the empty query
  ok('an empty query is not a filter', same(found(''), TITLES))
  ok('... nor is whitespace', same(found('   '), TITLES))
  ok(
    '... and it hands back the SAME array, so a list with no search box pays nothing',
    filterConversationRows(ROWS, '') === ROWS
  )

  // ---------------------------------------------------------- the keywords
  ok('every keyword must appear', same(found('release notes'), ['Notes for the 1.0.311 release']))
  ok('... in any order', same(found('notes release'), ['Notes for the 1.0.311 release']))
  ok('... and all of them in ONE title', same(found('release invoice'), []))
  ok(
    'a substring of a word still matches it',
    same(found('invo'), ['Invoice follow-up with the bank'])
  )

  // ------------------------------------------------------------ the folding
  ok('case does not decide a match', same(found('CAFE'), ['Café menu translation']))
  ok('... nor do combining marks', same(found('café'), ['Café menu translation']))

  // --------------------------------------------------------- the untitled row
  ok(
    'a conversation whose title has not resolved is findable by its placeholder',
    same(found('untitled'), ['Untitled'])
  )

  // ---------------------------------------------------------- the keyword split
  ok(
    'keywords are the words typed, folded, with the empties dropped',
    same(conversationSearchKeywords('  Café   RELEASE '), ['cafe', 'release'])
  )

  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

run()
