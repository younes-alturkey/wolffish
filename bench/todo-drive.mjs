#!/usr/bin/env node
/**
 * Drive the interrupted-task-list scenario against the running app: turn 1
 * writes a checklist and stops with items unfinished (what an interrupted
 * run leaves behind); turn 2 is told to finish the work. The second turn's
 * todo_write must carry the first turn's list id, so the earlier card
 * resolves in place — checked on the persisted conversation.
 *
 *   node bench/todo-drive.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const { connect } = await import(pathToFileURL(path.join(repo, 'src/cli/lib/client.mjs')).href)
const client = await connect({ autostart: false, quiet: true })

async function turn(text, conversationId) {
  const calls = []
  let turnId = null
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 600_000)
    const off = client.onTurn((event) => {
      if (turnId && event.turnId && event.turnId !== turnId) return
      if (event.t === 'segment' && event.segment.kind === 'tool_call') calls.push({ name: event.segment.name, args: event.segment.args })
      if (event.t === 'approvalRequest') client.invoke('cli:approvalRespond', { id: event.id, decision: 'approved' }).catch(() => undefined)
      if (event.t === 'done' || event.t === 'error') { clearTimeout(timer); off(); resolve(event.t) }
    })
  })
  const started = await client.invoke('cli:send', { text, conversationId })
  turnId = started.turnId
  return { outcome: await done, turnId, conversationId: started.conversationId, calls }
}

const t1 = await turn([
  'Use todo_write to create a task list with exactly these three items, in this order:',
  '1. "Name three primary colours" — status in_progress',
  '2. "Name three secondary colours" — status pending',
  '3. "Name one tertiary colour" — status pending',
  'Then answer item 1 only (name three primary colours) and STOP — do not do items 2 and 3, do not update the list again, do not call any other tool. This simulates an interrupted run.'
].join('\n'))
console.log(JSON.stringify({ turn: 1, outcome: t1.outcome, turnId: t1.turnId, calls: t1.calls.map((c) => c.name) }))

const t2 = await turn('Continue: finish the remaining items of that task list and mark them done in the list.', t1.conversationId)
console.log(JSON.stringify({ turn: 2, outcome: t2.outcome, turnId: t2.turnId, calls: t2.calls.map((c) => c.name) }))

const file = path.join(os.homedir(), '.wolffish/workspace/brain/conversations', `conv-${t1.conversationId}.json`)
const conv = JSON.parse(fs.readFileSync(file, 'utf8'))
const todos = conv.messages.flatMap((m, i) => (m.segments ?? []).filter((s) => s.kind === 'todo').map((s) => ({ message: i, turnId: s.turnId, listId: s.listId ?? null, items: s.items.map((t) => `${t.status}:${t.content.slice(0, 22)}`) })))
console.log(JSON.stringify({ conversationId: t1.conversationId, title: conv.title, todos }, null, 1))
const cont = todos.filter((t) => t.listId === t1.turnId)
console.log(cont.length > 0 && cont.at(-1).items.every((i) => i.startsWith('completed') || i.startsWith('cancelled')) ? 'PASS: turn 2 resolved the turn-1 list in place' : 'FAIL: turn 2 did not continue the turn-1 list')
client.close()
process.exit(0)
