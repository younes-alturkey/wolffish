#!/usr/bin/env node
/**
 * Plan-mode smoke test against the running app: send a planning request for
 * a bench task with planMode=true and assert the turn only observed — every
 * mutating call was refused, the plan file was written, the project is
 * untouched. Then send the follow-up executing turn (planMode=false) and
 * check the switch note let it edit.
 *
 *   node bench/plan-smoke.mjs [task=unicode-slug]
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
const task = process.argv[2] ?? 'unicode-slug'

const src = path.join(here, 'tasks', task, 'project')
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `plan-smoke-${task}-`)))
fs.cpSync(src, dir, { recursive: true })
await execFileP('git', ['init', '-q', '-b', 'main'], { cwd: dir })
await execFileP('git', ['-c', 'user.email=b@b', '-c', 'user.name=b', 'add', '-A'], { cwd: dir })
await execFileP('git', ['-c', 'user.email=b@b', '-c', 'user.name=b', 'commit', '-q', '-m', 'start'], { cwd: dir })

const { connect } = await import(pathToFileURL(path.join(repo, 'src/cli/lib/client.mjs')).href)
const client = await connect({ autostart: false, quiet: true })

const prompt = fs.readFileSync(path.join(here, 'tasks', task, 'TASK.md'), 'utf8').trim()

async function turn(text, planMode, conversationId) {
  const calls = []
  const results = []
  let turnId = null
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 1_500_000)
    const off = client.onTurn((event) => {
      if (turnId && event.turnId && event.turnId !== turnId) return
      if (event.t === 'segment' && event.segment.kind === 'tool_call') calls.push(event.segment)
      if (event.t === 'segment' && event.segment.kind === 'tool_result') results.push(event.segment)
      if (event.t === 'approvalRequest') client.invoke('cli:approvalRespond', { id: event.id, decision: 'approved' }).catch(() => undefined)
      // A plan that asks the user a design question is doing its job; answer
      // every question with the task's own wording so the turn can finish.
      if (event.t === 'askRequest') {
        const questions = Array.isArray(event.questions) ? event.questions : []
        const answers = questions.map(() => ({ kind: 'custom', text: `Decide it yourself from the task statement: ${prompt.split('\n')[0]}` }))
        client.invoke('cli:askRespond', { id: event.id, response: { kind: 'answered', answers } }).catch(() => undefined)
      }
      if (event.t === 'done' || event.t === 'error') {
        clearTimeout(timer)
        off()
        resolve(event.t)
      }
    })
  })
  const started = await client.invoke('cli:send', { text, workingFolders: [dir], planMode, conversationId })
  turnId = started.turnId
  const outcome = await done
  return { outcome, calls, results, conversationId: started.conversationId }
}

console.log(`plan turn on ${dir}`)
const plan = await turn(`${prompt}\n\nDo not change anything yet — I want a plan first.`, true)
const byId = new Map(plan.results.map((r) => [r.toolCallId, r]))
const refused = plan.calls.filter((c) => byId.get(c.toolCallId)?.status === 'denied')
const mutating = plan.calls.filter((c) => ['file_edit', 'file_write', 'file_patch'].includes(c.name))
const planWrites = mutating.filter((c) => String(c.args.path).includes('/files/plans/'))
const { stdout: status } = await execFileP('git', ['status', '--porcelain'], { cwd: dir })
console.log(`  outcome=${plan.outcome} calls=${plan.calls.length} refused=${refused.length} planWrites=${planWrites.length} projectDirty=${JSON.stringify(status.trim())}`)
for (const c of refused) console.log(`    refused: ${c.name} ${JSON.stringify(c.args).slice(0, 80)}`)
const plansDir = path.join(os.homedir(), '.wolffish/workspace/files/plans')
const planFiles = fs.existsSync(plansDir)
  ? fs.readdirSync(plansDir).filter((f) => f.includes(plan.conversationId.replace(/[^a-z0-9_-]/gi, '_')))
  : []
console.log(`  plan file present: ${planFiles.length > 0} ${planFiles[0] ?? ''}`)
const ok1 = plan.outcome === 'done' && status.trim() === '' && planFiles.length > 0
console.log(ok1 ? '  PASS plan turn: project untouched, plan written' : '  FAIL plan turn')

console.log('execute turn')
const exec = await turn('Plan mode is off now — execute the plan.', false, plan.conversationId)
const { stdout: status2 } = await execFileP('git', ['status', '--porcelain'], { cwd: dir })
const edited = exec.calls.filter((c) => ['file_edit', 'file_write'].includes(c.name) && !String(c.args.path).includes('/files/plans/'))
console.log(`  outcome=${exec.outcome} calls=${exec.calls.length} edits=${edited.length} projectDirty=${JSON.stringify(status2.trim().split('\n').filter(Boolean))}`)
const verify = await new Promise((resolve) => execFile('bash', [path.join(here, 'tasks', task, 'verify.sh'), dir], (e, out, err) => resolve(`${out}${err}`)))
console.log(`  ${/VERDICT: [^\n]*/.exec(verify)?.[0] ?? 'no verdict'}`)
console.log(exec.outcome === 'done' && edited.length > 0 ? '  PASS execute turn: edits applied after the switch' : '  FAIL execute turn')
client.close()
process.exit(0)
