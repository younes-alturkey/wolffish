/**
 * The Web UI's notification log: arrival is unread and idempotent, only an
 * action reads, archiving reads too and is one-way, the bulk actions spare
 * what is already archived, a conversation's actions reach only it, the log
 * survives a reload and stays capped, and an action that crossed a socket is
 * checked before it touches anything.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/web-inbox.test.ts
 */
import { WebInbox, parseNotificationAction } from '@main/channels/web/inbox'
import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

const dir = mkdtempSync(path.join(os.tmpdir(), 'wolffish-web-inbox-'))
const file = path.join(dir, 'web', 'notifications.json')

function arrival(
  id: string,
  conversationId: string | null,
  at: number
): Parameters<WebInbox['record']>[0] {
  return {
    id,
    title: `T ${id}`,
    body: `B ${id}`,
    phase: 'completed' as const,
    url: conversationId ? `/?conversation=${conversationId}` : '/',
    conversationId,
    at
  }
}

async function main(): Promise<void> {
  const inbox = new WebInbox(file)
  ok('a missing file is an empty log', (await inbox.list()).length === 0)

  console.log('step: arrival')
  ok('first sighting is recorded', await inbox.record(arrival('a', 'c1', 1)))
  await inbox.record(arrival('b', 'c1', 2))
  await inbox.record(arrival('c', 'c2', 3))
  await inbox.record(arrival('d', null, 4))
  ok('a repeat id is not recorded twice', !(await inbox.record(arrival('a', 'c1', 9))))
  let items = await inbox.list()
  ok('newest first', items.map((r) => r.id).join() === 'd,c,b,a', items.map((r) => r.id).join())
  ok(
    'everything arrives unread',
    items.every((r) => !r.read && !r.archived)
  )

  console.log('step: one at a time')
  ok('read', await inbox.apply({ kind: 'read', id: 'a' }))
  ok('reading it again changes nothing', !(await inbox.apply({ kind: 'read', id: 'a' })))
  ok('an unknown id changes nothing', !(await inbox.apply({ kind: 'read', id: 'zzz' })))
  await inbox.apply({ kind: 'archive', id: 'b' })
  items = await inbox.list()
  const b = items.find((r) => r.id === 'b')!
  ok('archiving reads at the same time', b.read && b.archived)

  console.log('step: a conversation')
  await inbox.record(arrival('e', 'c1', 5))
  await inbox.apply({ kind: 'readConversation', conversationId: 'c1' })
  items = await inbox.list()
  ok(
    'reads only that conversation',
    items.find((r) => r.id === 'e')!.read && !items.find((r) => r.id === 'c')!.read
  )
  await inbox.apply({ kind: 'archiveConversation', conversationId: 'c2' })
  items = await inbox.list()
  ok(
    'archives only that conversation',
    items
      .filter((r) => r.archived)
      .map((r) => r.id)
      .sort()
      .join() === 'b,c'
  )

  console.log('step: everything')
  ok('read all', await inbox.apply({ kind: 'readAll' }))
  items = await inbox.list()
  ok(
    'nothing unread',
    items.every((r) => r.read)
  )
  ok('read all files nothing', items.filter((r) => r.archived).length === 2)
  await inbox.apply({ kind: 'archiveAll' })
  items = await inbox.list()
  ok(
    'archive all files the rest',
    items.every((r) => r.archived && r.read)
  )

  console.log('step: persistence')
  const reopened = new WebInbox(file)
  const back = await reopened.list()
  ok(
    'a fresh instance reads the same log',
    back.length === 5 && back.every((r) => r.archived && r.read),
    JSON.stringify(back)
  )
  const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { version: number; items: unknown[] }
  ok('versioned on disk', onDisk.version === 1 && onDisk.items.length === 5)

  console.log('step: the cap')
  const capped = new WebInbox(path.join(dir, 'capped.json'))
  for (let i = 0; i < 305; i++) await capped.record(arrival(`n${i}`, 'c1', i))
  const kept = await capped.list()
  ok('keeps the newest 300', kept.length === 300 && kept[0].id === 'n304' && kept[299].id === 'n5')

  console.log('step: actions from the wire')
  ok('read needs an id', parseNotificationAction({ kind: 'read' }) === null)
  ok(
    'a conversation action needs its id',
    parseNotificationAction({ kind: 'archiveConversation' }) === null
  )
  ok('an unknown kind is refused', parseNotificationAction({ kind: 'deleteEverything' }) === null)
  ok(
    'garbage is refused',
    parseNotificationAction('read') === null && parseNotificationAction(null) === null
  )
  const parsed = parseNotificationAction({ kind: 'archive', id: 'x', extra: 1 })
  ok(
    'a good one keeps only its own fields',
    JSON.stringify(parsed) === '{"kind":"archive","id":"x"}'
  )

  console.log(`web-inbox: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
