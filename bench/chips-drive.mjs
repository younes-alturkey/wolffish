#!/usr/bin/env node
/**
 * Drive one turn against the running app that edits files in two folders of
 * a scratch project, so the folder chips over the transcript can be checked
 * live and after a reopen. Prints the conversation id and the project dir.
 *
 *   node bench/chips-drive.mjs
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const src = path.join(here, 'tasks', 'unicode-slug', 'project')
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chips-drive-')))
fs.cpSync(src, dir, { recursive: true })
await execFileP('git', ['init', '-q', '-b', 'main'], { cwd: dir })
await execFileP('git', ['-c', 'user.email=b@b', '-c', 'user.name=b', 'add', '-A'], { cwd: dir })
await execFileP('git', ['-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'start'], { cwd: dir })

const { connect } = await import(pathToFileURL(path.join(repo, 'src/cli/lib/client.mjs')).href)
const client = await connect({ autostart: false, quiet: true })
const calls = []
let turnId = null
const done = new Promise((resolve) => {
  const timer = setTimeout(() => resolve('timeout'), 600_000)
  const off = client.onTurn((event) => {
    if (turnId && event.turnId && event.turnId !== turnId) return
    if (event.t === 'segment' && event.segment.kind === 'tool_call') calls.push(event.segment.name)
    if (event.t === 'approvalRequest') client.invoke('cli:approvalRespond', { id: event.id, decision: 'approved' }).catch(() => undefined)
    if (event.t === 'done' || event.t === 'error') { clearTimeout(timer); off(); resolve(event.t) }
  })
})
const text = [
  'Two tiny edits, using file_edit only, then stop:',
  '1. In src/slug.js add the comment line `// slug helpers` as the very first line.',
  '2. In test/slug.test.js add the comment line `// slug tests` as the very first line.',
  'Do not run any commands and do not touch any other file.'
].join('\n')
const started = await client.invoke('cli:send', { text, workingFolders: [dir] })
turnId = started.turnId
const outcome = await done
const { stdout } = await execFileP('git', ['status', '--porcelain'], { cwd: dir })
console.log(JSON.stringify({ outcome, conversationId: started.conversationId, dir, calls, dirty: stdout.trim().split('\n').filter(Boolean) }))
client.close()
process.exit(0)
