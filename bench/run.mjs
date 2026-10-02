#!/usr/bin/env node
/**
 * Parity benchmark harness: run one bench task through Wolffish (the running
 * dev app, over the CLI daemon socket) or OpenCode (the installed `opencode`
 * CLI), then grade the result with the task's verify.sh.
 *
 *   node bench/run.mjs <task|all> <wolffish|opencode> [--model deepseek-flash] [--timeout 900]
 *
 * Wolffish: needs the app running (dev or packaged) — the harness sends the
 * task prompt as a fresh conversation with the copied project as its working
 * folder and waits for the turn to end. OpenCode: needs `opencode` on PATH
 * and DEEPSEEK_API_KEY (read from the Wolffish config when unset, so both
 * harnesses use the same key and the same wire model id).
 *
 * Each run gets its own copy of the project in a temp dir with `git init` so
 * the agent sees a real repo. Results land in bench/results/*.json and a
 * one-line summary prints per run.
 */
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const tasksDir = path.join(here, 'tasks')
const resultsDir = path.join(here, 'results')

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const positional = args.filter(
  (a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--'))
)
const [taskArg, agent] = positional
const MODEL = flag('model', 'deepseek-flash')
const TIMEOUT_S = Number(flag('timeout', '900'))

if (!taskArg || !['wolffish', 'opencode'].includes(agent ?? '')) {
  console.error(
    'usage: node bench/run.mjs <task|all> <wolffish|opencode> [--model id] [--timeout s]'
  )
  process.exit(2)
}

function deepseekKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.wolffish/workspace/config.json'), 'utf8')
    )
    return (cfg.llm?.providers ?? []).find((p) => p.id === 'deepseek')?.apiKey ?? ''
  } catch {
    return ''
  }
}

async function prepare(task) {
  const src = path.join(tasksDir, task, 'project')
  if (!fs.existsSync(src)) throw new Error(`no such task: ${task}`)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${task}-${agent}-`))
  fs.cpSync(src, dir, { recursive: true })
  await execFileP('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  await execFileP(
    'git',
    ['-c', 'user.email=bench@wolffi.sh', '-c', 'user.name=bench', 'add', '-A'],
    { cwd: dir }
  )
  await execFileP(
    'git',
    [
      '-c',
      'user.email=bench@wolffi.sh',
      '-c',
      'user.name=bench',
      'commit',
      '-q',
      '-m',
      'task start'
    ],
    {
      cwd: dir
    }
  )
  return fs.realpathSync(dir)
}

async function verify(task, dir) {
  const script = path.join(tasksDir, task, 'verify.sh')
  return new Promise((resolve) => {
    execFile(
      'bash',
      [script, dir],
      { timeout: 120_000, env: { ...process.env } },
      (err, stdout, stderr) => {
        const out = `${stdout}\n${stderr}`
        const verdict =
          /VERDICT: (PASS|FAIL[^\n]*)/.exec(out)?.[1] ?? `NO VERDICT (exit ${err?.code ?? 0})`
        resolve({ pass: verdict.startsWith('PASS'), verdict, output: out.slice(-3000) })
      }
    )
  })
}

async function changedFiles(dir) {
  const { stdout } = await execFileP('git', ['status', '--porcelain'], { cwd: dir })
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3))
}

// ── Wolffish over the CLI daemon socket ─────────────────────────────────
async function runWolffish(prompt, dir) {
  const { connect } = await import(pathToFileURL(path.join(repo, 'src/cli/lib/client.mjs')).href)
  const client = await connect({ autostart: false, quiet: true })
  const stats = {
    toolCalls: 0,
    tools: {},
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    text: '',
    errors: [],
    events: {}
  }
  let turnId = null
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => {
      stats.errors.push(`timeout after ${TIMEOUT_S}s`)
      if (turnId) client.invoke('cli:cancel', null).catch(() => undefined)
      resolve()
    }, TIMEOUT_S * 1000)
    const off = client.onTurn((event) => {
      if (turnId && event.turnId && event.turnId !== turnId) return
      stats.events[event.t] = (stats.events[event.t] ?? 0) + 1
      if (event.t === 'segment') {
        const seg = event.segment
        if (seg?.kind === 'tool_call') {
          stats.toolCalls++
          stats.tools[seg.name] = (stats.tools[seg.name] ?? 0) + 1
        } else if (seg?.kind === 'text') stats.text += seg.delta
      } else if (event.t === 'turnEvent') {
        if (event.type === 'turn.usage' || event.type === 'llm.response') {
          const p = event.payload ?? {}
          const inTok = p.inputTokens ?? p.promptTokens ?? 0
          const outTok = p.outputTokens ?? p.completionTokens ?? 0
          if (inTok || outTok) {
            stats.llmCalls++
            stats.inputTokens += inTok
            stats.outputTokens += outTok
          }
        }
      } else if (event.t === 'approvalRequest') {
        // Benchmarks run unattended: approve like a user watching a coding
        // agent would for the safe patterns the tasks can hit.
        client
          .invoke('cli:approvalRespond', { id: event.id, decision: 'approved' })
          .catch(() => undefined)
      } else if (event.t === 'askRequest') {
        client
          .invoke('cli:askRespond', { id: event.id, response: { kind: 'canceled' } })
          .catch(() => undefined)
        stats.errors.push('agent asked a question (auto-cancelled)')
      } else if (event.t === 'done' || event.t === 'error') {
        if (event.t === 'error') stats.errors.push(event.error)
        clearTimeout(timer)
        off()
        resolve()
      }
    })
  })
  const started = await client.invoke('cli:send', { text: prompt, workingFolders: [dir] })
  turnId = started.turnId
  stats.conversationId = started.conversationId
  await done
  client.close()
  return stats
}

// ── OpenCode CLI ─────────────────────────────────────────────────────────
async function runOpencode(prompt, dir) {
  const key = deepseekKey()
  if (!key) throw new Error('DEEPSEEK_API_KEY not set and not found in the Wolffish config')
  const stats = {
    toolCalls: 0,
    tools: {},
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    text: '',
    errors: [],
    events: {}
  }
  const configPath = path.join(here, 'opencode.json')
  await new Promise((resolve) => {
    const child = spawn(
      'opencode',
      ['run', '--format', 'json', '--auto', '-m', `deepseek/${MODEL}`, '--dir', dir, prompt],
      {
        cwd: dir,
        env: { ...process.env, DEEPSEEK_API_KEY: key, OPENCODE_CONFIG: configPath, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    const timer = setTimeout(() => {
      stats.errors.push(`timeout after ${TIMEOUT_S}s`)
      child.kill('SIGKILL')
    }, TIMEOUT_S * 1000)
    let buf = ''
    const raw = []
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString()
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('{')) continue
        try {
          const ev = JSON.parse(line)
          raw.push(ev)
          const type = ev.type ?? ev.event ?? 'unknown'
          stats.events[type] = (stats.events[type] ?? 0) + 1
          const part = ev.part ?? ev.properties?.part ?? ev
          if (part?.type === 'tool' || type === 'tool_use' || type === 'tool') {
            const name = part?.tool ?? part?.name ?? ev.tool ?? ev.name ?? 'tool'
            const status = part?.state?.status
            if (!status || status === 'completed' || status === 'error') {
              stats.toolCalls++
              stats.tools[name] = (stats.tools[name] ?? 0) + 1
            }
          }
          if (part?.type === 'text' && typeof part.text === 'string') stats.text = part.text
          const tokens = part?.tokens ?? ev.tokens ?? ev.usage
          if (tokens && (tokens.input || tokens.output)) {
            stats.llmCalls++
            stats.inputTokens += (tokens.input ?? 0) + (tokens.cache?.read ?? 0)
            stats.outputTokens += tokens.output ?? 0
          }
        } catch {
          // not JSON
        }
      }
    })
    let err = ''
    child.stderr.on('data', (c) => (err += c.toString()))
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) stats.errors.push(`opencode exited ${code}: ${err.slice(-500)}`)
      stats.rawEvents = raw.length
      fs.mkdirSync(resultsDir, { recursive: true })
      fs.writeFileSync(
        path.join(resultsDir, `last-opencode-events.jsonl`),
        raw.map((r) => JSON.stringify(r)).join('\n')
      )
      resolve()
    })
  })
  return stats
}

async function runOne(task) {
  const prompt = fs.readFileSync(path.join(tasksDir, task, 'TASK.md'), 'utf8').trim()
  const dir = await prepare(task)
  const startedAt = Date.now()
  let stats
  try {
    stats = agent === 'wolffish' ? await runWolffish(prompt, dir) : await runOpencode(prompt, dir)
  } catch (err) {
    stats = {
      toolCalls: 0,
      tools: {},
      llmCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      text: '',
      errors: [String(err?.message ?? err)],
      events: {}
    }
  }
  const durationMs = Date.now() - startedAt
  const graded = await verify(task, dir)
  const changed = await changedFiles(dir).catch(() => [])
  const record = {
    task,
    agent,
    model: MODEL,
    dir,
    startedAt: new Date(startedAt).toISOString(),
    durationMs,
    pass: graded.pass,
    verdict: graded.verdict,
    toolCalls: stats.toolCalls,
    tools: stats.tools,
    llmCalls: stats.llmCalls,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    changedFiles: changed,
    errors: stats.errors,
    events: stats.events,
    conversationId: stats.conversationId ?? null,
    finalText: stats.text.slice(-2000),
    verifyOutput: graded.output
  }
  fs.mkdirSync(resultsDir, { recursive: true })
  const file = path.join(
    resultsDir,
    `${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}-${task}-${agent}.json`
  )
  fs.writeFileSync(file, JSON.stringify(record, null, 2))
  console.log(
    `${graded.pass ? 'PASS' : 'FAIL'}  ${task.padEnd(22)} ${agent.padEnd(9)} ${(durationMs / 1000).toFixed(0).padStart(4)}s  tools=${String(stats.toolCalls).padStart(3)}  in=${stats.inputTokens}  out=${stats.outputTokens}  ${graded.verdict}${stats.errors.length ? `  errors=${stats.errors.join(' | ').slice(0, 160)}` : ''}`
  )
  return record
}

const tasks =
  taskArg === 'all'
    ? fs
        .readdirSync(tasksDir)
        .filter((t) => fs.existsSync(path.join(tasksDir, t, 'TASK.md')))
        .sort()
    : [taskArg]
const records = []
for (const t of tasks) records.push(await runOne(t))
const passes = records.filter((r) => r.pass).length
console.log(`\n${agent}: ${passes}/${records.length} passed`)
process.exit(0)
