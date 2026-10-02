/**
 * Task lists that outlive their turn. A turn interrupted mid-work leaves a
 * checklist with unfinished items on the user's screen; the next turn
 * inherits that list (openTodoList), its todo_write carries the original
 * list id (emitTodo), and every renderer draws each list once, at the turn
 * that created it, in its latest state (latestTodoLists) — so the earlier
 * card resolves in place instead of a second checklist appearing.
 */
import {
  Broca,
  latestTodoLists,
  openTodoList,
  todoListId,
  upsertTodoSegment,
  type Segment,
  type TodoItem
} from '../broca'

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: unknown): void {
  if (cond) passed++
  else {
    failed++
    console.error(`FAIL ${label}${detail !== undefined ? `\n     ${JSON.stringify(detail)}` : ''}`)
  }
}

type TodoSegment = Extract<Segment, { kind: 'todo' }>
const todo = (
  turnId: string,
  segmentId: string,
  items: TodoItem[],
  listId?: string
): TodoSegment => ({
  kind: 'todo',
  turnId,
  segmentId,
  items,
  ...(listId ? { listId } : {})
})
const text = (turnId: string, id: string): Segment => ({
  kind: 'text',
  turnId,
  segmentId: id,
  delta: 'x'
})

function main(): void {
  const a: TodoItem[] = [
    { content: 'inventory', status: 'completed' },
    { content: 'research', status: 'in_progress' },
    { content: 'write', status: 'pending' }
  ]
  const aDone: TodoItem[] = a.map((i) => ({ ...i, status: 'completed' as const }))

  ok('a creating write owns its list', todoListId(todo('t1', 's1', a)) === 't1')
  ok('a continuation names the original list', todoListId(todo('t2', 's9', aDone, 't1')) === 't1')

  // Turn 1 wrote the list and was interrupted; turn 2 continues it.
  const turn1 = [text('t1', 'x1'), todo('t1', 's1', a)]
  ok(
    'the interrupted turn leaves an open list',
    JSON.stringify(openTodoList([turn1])) === JSON.stringify({ listId: 't1', items: a })
  )
  const turn2 = [text('t2', 'x2'), todo('t2', 's2', aDone, 't1')]
  const latest = latestTodoLists([turn1, undefined, turn2])
  ok('the latest state of the list is the continuation write', latest.get('t1') === aDone)
  ok('the continuation adds no list of its own', latest.size === 1)
  ok('a settled list is not open', openTodoList([turn1, turn2]) === null)

  // A fresh list in turn 3 while t1 is settled; then it is the open one.
  const b: TodoItem[] = [{ content: 'deploy', status: 'in_progress' }]
  const turn3 = [todo('t3', 's3', b)]
  const open = openTodoList([turn1, turn2, turn3])
  ok('the most recent unfinished list is the open one', open?.listId === 't3' && open.items === b)
  ok('lists keep separate identities', latestTodoLists([turn1, turn2, turn3]).size === 2)

  // Within one turn, writes replace each other by turnId (the same card).
  const segs: Segment[] = [text('t4', 'x4')]
  upsertTodoSegment(segs, todo('t4', 's4a', a, 't1'))
  upsertTodoSegment(segs, todo('t4', 's4b', aDone, 't1'))
  ok(
    'two writes in one turn fold into one segment',
    segs.filter((s) => s.kind === 'todo').length === 1
  )
  ok(
    'the fold keeps the list id',
    segs.some((s) => s.kind === 'todo' && s.listId === 't1' && s.items === aDone)
  )

  // emitTodo stamps the list id only when it differs from the turn.
  const emitted: Segment[] = []
  const broca = new Broca()
  broca.beginTurn('t5', (s) => emitted.push(s))
  broca.emitTodo('t5', a, 't5')
  broca.emitTodo('t5', aDone, 't1')
  const [own, cont] = emitted.filter((s) => s.kind === 'todo') as Array<
    Extract<Segment, { kind: 'todo' }>
  >
  ok('own list: no listId on the wire', own !== undefined && !('listId' in own))
  ok('continued list: listId rides the segment', cont?.listId === 't1')

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}
main()
