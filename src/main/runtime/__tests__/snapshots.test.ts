/**
 * Per-turn file snapshots (src/main/runtime/snapshots.ts): capture before
 * the first change records original bytes (or absence), a second capture
 * in the same turn is a no-op, list is newest-first, revert restores edited
 * files and deletes created ones (whole turn or one path), oversized files
 * are skipped with a note, and old turns are pruned.
 *
 * Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/snapshots.test.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SNAPSHOT_TURNS_KEPT, SnapshotStore } from '../snapshots'

let passed = 0
let failed = 0
function ok(name: string, cond: unknown, detail?: unknown): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}`)
    if (detail !== undefined)
      console.log('    ', typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-snap-'))
  const project = path.join(root, 'project')
  fs.mkdirSync(project, { recursive: true })
  const a = path.join(project, 'a.txt')
  const b = path.join(project, 'b.txt')
  const created = path.join(project, 'new.txt')
  fs.writeFileSync(a, 'A original\n')
  fs.writeFileSync(b, 'B original\n')
  const store = new SnapshotStore(root)

  await store.capture('conv', 'turn-1', a)
  fs.writeFileSync(a, 'A changed\n')
  await store.capture('conv', 'turn-1', a) // second touch — must not overwrite the original
  fs.writeFileSync(a, 'A changed twice\n')
  await store.capture('conv', 'turn-1', created)
  fs.writeFileSync(created, 'brand new\n')

  const turns = await store.list('conv')
  ok('one turn listed', turns.length === 1 && turns[0].turnId === 'turn-1', turns)
  ok(
    'edited file recorded with its bytes',
    turns[0].files[a]?.blob !== null && turns[0].files[a]?.size === 11,
    turns[0].files
  )
  ok(
    'created file recorded as absent',
    turns[0].files[created]?.blob === null && turns[0].files[created]?.size === 0,
    turns[0].files
  )
  ok('b was never captured', !turns[0].files[b])

  const one = await store.revert('conv', 'turn-1', a)
  ok(
    'revert of one path restores only it',
    one.restored.length === 1 &&
      fs.readFileSync(a, 'utf8') === 'A original\n' &&
      fs.existsSync(created),
    one
  )
  fs.writeFileSync(a, 'A changed again\n')
  const all = await store.revert('conv', 'turn-1')
  ok(
    'revert of the turn restores edits and deletes created files',
    fs.readFileSync(a, 'utf8') === 'A original\n' &&
      !fs.existsSync(created) &&
      all.deleted.length === 1,
    all
  )
  ok('the snapshot survives a revert (re-revertable)', (await store.list('conv')).length === 1)

  await store.capture('conv', 'turn-2', b)
  fs.writeFileSync(b, 'B changed\n')
  const two = await store.list('conv')
  ok(
    'newest turn first',
    two[0].turnId === 'turn-2' && two[1].turnId === 'turn-1',
    two.map((t) => t.turnId)
  )
  const wrong = await store.revert('conv', 'turn-2', a)
  ok(
    'reverting a path a turn did not touch does nothing',
    wrong.restored.length === 0 && wrong.deleted.length === 0
  )

  const big = path.join(project, 'big.bin')
  fs.writeFileSync(big, Buffer.alloc(9 * 1024 * 1024))
  await store.capture('conv', 'turn-3', big)
  const three = await store.list('conv')
  ok(
    'oversized files are recorded as skipped',
    three[0].files[big]?.skipped?.includes('larger'),
    three[0].files[big]
  )
  const skip = await store.revert('conv', 'turn-3')
  ok(
    'reverting a skipped file reports it',
    skip.skipped.length === 1 && skip.restored.length === 0,
    skip
  )

  for (let i = 0; i < SNAPSHOT_TURNS_KEPT + 5; i++) {
    fs.writeFileSync(a, `v${i}\n`)
    await store.capture('conv', `bulk-${i}`, a)
    await new Promise((r) => setTimeout(r, 2))
  }
  const kept = await store.list('conv')
  ok(
    'old turns are pruned to the retention window',
    kept.length <= SNAPSHOT_TURNS_KEPT,
    kept.length
  )

  ok(
    'capture never throws on an unreadable path',
    await store.capture('conv', 't', path.join(root, 'nope', 'x')).then(() => true)
  )
  ok('list of an unknown conversation is empty', (await store.list('other')).length === 0)

  fs.rmSync(root, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

void main()
