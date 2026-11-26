/**
 * The Recently opened section (recentlyOpenedRows), which the History page and
 * the conversations sheet both pin above their date groups.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx \
 *     src/renderer/src/lib/__tests__/conversation-recent.test.ts
 */

import { RECENTLY_OPENED_SHOWN, recentlyOpenedRows } from '../conversation-rows'

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

const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((conversationId) => ({ conversationId }))
const ids = (picked: ReturnType<typeof recentlyOpenedRows>): string =>
  picked.map((p) => `${p.row.conversationId}@${p.position}`).join(',')

ok('shows three by default', RECENTLY_OPENED_SHOWN === 3)

ok(
  'newest open first, positions are places in the full list',
  ids(recentlyOpenedRows(rows, ['e', 'b', 'f', 'a'])) === 'e@5,b@2,f@6',
  ids(recentlyOpenedRows(rows, ['e', 'b', 'f', 'a']))
)

ok(
  'an id not in the list (deleted, other project) gives its slot to the next',
  ids(recentlyOpenedRows(rows, ['gone', 'c', 'zzz', 'a', 'd'])) === 'c@3,a@1,d@4'
)

ok('fewer opens than slots shows what there is', ids(recentlyOpenedRows(rows, ['d'])) === 'd@4')
ok('nothing opened yet shows nothing', recentlyOpenedRows(rows, []).length === 0)
ok('an empty list shows nothing', recentlyOpenedRows([], ['a', 'b']).length === 0)

ok(
  'a repeated id takes one slot',
  ids(recentlyOpenedRows(rows, ['b', 'b', 'c', 'd'])) === 'b@2,c@3,d@4'
)

ok(
  'the rows are not removed from the list they came from',
  recentlyOpenedRows(rows, ['a', 'b', 'c']).length === 3 && rows.length === 6
)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
