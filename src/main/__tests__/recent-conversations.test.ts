/**
 * The main-side Recently opened store (src/main/recent-conversations.ts): one
 * list for the desktop window and every Web UI browser, newest open first.
 *
 * Redirects the workspace to a temp home BEFORE loading anything, so the real
 * ~/.wolffish is never touched.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/__tests__/recent-conversations.test.ts
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-recent-'))
;(os as unknown as { homedir: () => string }).homedir = (): string => TEST_HOME

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

async function run(): Promise<void> {
  const { listRecentConversations, markConversationOpened, forgetRecentConversation } =
    await import('@main/recent-conversations')
  const store = path.join(TEST_HOME, '.wolffish', 'workspace', 'brain', 'recent-conversations.json')

  ok('empty before anything is opened', (await listRecentConversations()).length === 0)

  await markConversationOpened('a')
  await markConversationOpened('b')
  const third = await markConversationOpened('c')
  ok('newest first', third.ids.join(',') === 'c,b,a', third.ids.join(','))
  ok('a new open is a change', third.changed)

  const reopen = await markConversationOpened('a')
  ok('reopening moves it to the front, no duplicate', reopen.ids.join(',') === 'a,c,b')

  const same = await markConversationOpened('a')
  ok('reopening the front one is not a change', !same.changed && same.ids.join(',') === 'a,c,b')

  ok('persisted to the workspace', fs.existsSync(store))
  ok('read back from disk', (await listRecentConversations()).join(',') === 'a,c,b')

  const bad = await markConversationOpened('../../etc/passwd')
  ok('a malformed id is ignored', !bad.changed && bad.ids.join(',') === 'a,c,b')

  const forgot = await forgetRecentConversation('c')
  ok('a deleted conversation is forgotten', forgot.changed && forgot.ids.join(',') === 'a,b')
  const forgotAgain = await forgetRecentConversation('c')
  ok('forgetting an unknown id is not a change', !forgotAgain.changed)

  for (let i = 0; i < 20; i++) await markConversationOpened(`conv-${i}`)
  const capped = await listRecentConversations()
  ok('kept list is capped', capped.length === 12, String(capped.length))
  ok('the cap drops the oldest', capped[0] === 'conv-19' && !capped.includes('a'))

  await Promise.all(['x', 'y', 'z'].map((id) => markConversationOpened(id)))
  const raced = await listRecentConversations()
  ok(
    'concurrent opens all land',
    ['x', 'y', 'z'].every((id) => raced.slice(0, 3).includes(id)),
    raced.slice(0, 3).join(',')
  )

  fs.writeFileSync(store, '{not json')
  ok('a corrupt file reads as empty', (await listRecentConversations()).length === 0)
  const healed = await markConversationOpened('fresh')
  ok('and the next open rewrites it', healed.ids.join(',') === 'fresh')

  fs.rmSync(TEST_HOME, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

void run()
