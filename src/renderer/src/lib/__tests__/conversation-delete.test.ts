/**
 * The tombstone a conversation delete leaves behind — what keeps a row from
 * flashing back between the confirm and the index catching up.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx \
 *     src/renderer/src/lib/__tests__/conversation-delete.test.ts
 */

import type { ConversationMeta } from '@preload/index'
import { requestConversationDelete, settleConversationDeletes } from '../conversation-delete'

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

const meta = (id: string): ConversationMeta =>
  ({ id, title: id, updatedAt: 1, createdAt: 1 }) as unknown as ConversationMeta

type DeleteReply = { ok: boolean }
let reply: () => Promise<DeleteReply> = () => Promise.resolve({ ok: true })
// The module reads window.api lazily, per call, so a stub installed after the
// import is what it sees.
;(globalThis as unknown as { window: unknown }).window = {
  api: { conversation: { delete: () => reply() } }
}

async function main(): Promise<void> {
  // A delete in flight hides its row from every fetched list.
  {
    let resolve: (r: DeleteReply) => void = () => undefined
    reply = () => new Promise((r) => (resolve = r))
    const outcome = requestConversationDelete('a')
    const settled = settleConversationDeletes([meta('a'), meta('b')])
    ok(
      'in-flight delete is filtered out of a fetched list',
      settled.map((m) => m.id).join() === 'b'
    )
    resolve({ ok: true })
    ok('resolves deleted', (await outcome) === 'deleted')
    // The file is gone but the index still lists the row: still hidden.
    ok(
      'after success, a list that still carries the row keeps hiding it',
      settleConversationDeletes([meta('a'), meta('b')])
        .map((m) => m.id)
        .join() === 'b'
    )
    // The index caught up: the tombstone retires, and a later list that
    // somehow carries the id again (a re-import) is no longer filtered.
    ok(
      'a list without the id retires the tombstone',
      settleConversationDeletes([meta('b')]).length === 1
    )
    ok('retired tombstone no longer filters', settleConversationDeletes([meta('a')]).length === 1)
  }

  // A refusal (turn still running) lifts the tombstone so the row comes back.
  {
    reply = () => Promise.resolve({ ok: false })
    const outcome = await requestConversationDelete('c')
    ok('refusal resolves busy', outcome === 'busy')
    ok('busy lifts the tombstone', settleConversationDeletes([meta('c')]).length === 1)
  }

  // The call itself failing (socket dropped) never throws, and lifts the tombstone.
  {
    reply = () => Promise.reject(new Error('connection lost'))
    const outcome = await requestConversationDelete('d')
    ok('rejection resolves failed', outcome === 'failed')
    ok('failure lifts the tombstone', settleConversationDeletes([meta('d')]).length === 1)
  }

  // Untouched lists come back as the same array — no churn for the common case.
  {
    const list = [meta('x')]
    ok('no tombstones → identity', settleConversationDeletes(list) === list)
  }

  console.log(`conversation-delete: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
