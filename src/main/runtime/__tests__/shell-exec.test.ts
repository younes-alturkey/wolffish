/**
 * The shell capability's execution contract (src/defaults/workspace/brain/
 * cerebellum/shell/plugin/index.mjs): default cwd from the working folder,
 * ANSI stripping, exit-code classification, tail-biased truncation with the
 * full output spilled to <workspace>/tool-output/, the watcher guard with
 * its force override, background jobs with log capture + shell_jobs +
 * shell_stop, and the structured meta every result carries.
 *
 * Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/shell-exec.test.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

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

type Result = {
  success: boolean
  output?: string
  error?: string
  exitCode?: number | null
  retryable?: boolean
  meta?: {
    exitCode?: number | null
    durationMs?: number
    label?: string
    cwd?: string
    truncated?: boolean
    outputPath?: string
  }
}
type Plugin = {
  init: (ctx: unknown) => Promise<void>
  execute: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<Result>
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  if (process.platform === 'win32') {
    console.log('POSIX-only test; skipping on Windows')
    process.exit(0)
  }
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-shell-'))
  const ROOT = fs.realpathSync(TMP)
  const WORKSPACE = path.join(ROOT, 'workspace')
  const PROJECT = path.join(ROOT, 'project')
  fs.mkdirSync(WORKSPACE, { recursive: true })
  fs.mkdirSync(PROJECT, { recursive: true })

  const shell = (
    await import(
      pathToFileURL(
        path.join(process.cwd(), 'src/defaults/workspace/brain/cerebellum/shell/plugin/index.mjs')
      ).href
    )
  ).default as Plugin
  await shell.init({ sudo: null, workspaceRoot: WORKSPACE, getWorkingFolders: () => [PROJECT] })
  const run = (args: Record<string, unknown>): Promise<Result> => shell.execute('shell_exec', args)

  console.log('basics')
  {
    const r = await run({ command: 'echo hi' })
    ok('echo succeeds with its output', r.success && r.output === 'hi', r)
    ok(
      'meta carries exit code, duration, cwd and a label',
      r.meta?.exitCode === 0 &&
        typeof r.meta?.durationMs === 'number' &&
        r.meta?.cwd === PROJECT &&
        typeof r.meta?.label === 'string',
      r.meta
    )
    const pwd = await run({ command: 'pwd' })
    ok('default cwd is the working folder', pwd.output === PROJECT, pwd)
    const esc = String.fromCharCode(27)
    const ansi = await run({
      command: `printf '${esc}[32mgreen${esc}[0m and ${esc}]8;;http://x${String.fromCharCode(7)}link${esc}]8;;${String.fromCharCode(7)}'`
    })
    ok(
      'ANSI colour and OSC sequences are stripped',
      ansi.success && ansi.output === 'green and link',
      JSON.stringify(ansi.output)
    )
    const order = await run({ command: 'echo one; echo two >&2; echo three' })
    // stdout and stderr are separate pipes, so their relative order is
    // best-effort; what the capture guarantees is that both streams land in
    // one output and each stream keeps its own order.
    const lines = (order.output ?? '').split('\n')
    ok(
      'stdout and stderr are combined, each in its own order',
      lines.length === 3 && lines.includes('two') && lines.indexOf('one') < lines.indexOf('three'),
      JSON.stringify(order.output)
    )
  }

  console.log('exit codes')
  {
    const one = await run({ command: 'false' })
    ok(
      'exit 1 with no output is a clean no-match result',
      one.success && one.output?.includes('no matches') && one.meta?.exitCode === 1,
      one
    )
    const three = await run({ command: 'echo boom >&2; exit 3' })
    ok(
      'exit 3 is a failure naming the code and carrying the output',
      !three.success &&
        three.error?.includes('exited with code 3') &&
        three.error.includes('boom') &&
        three.output === 'boom' &&
        three.meta?.exitCode === 3,
      three
    )
    const missing = await run({ command: 'definitely_not_a_command_xyz' })
    ok(
      'a missing command is a failure with exit 127',
      !missing.success && missing.exitCode === 127,
      missing
    )
  }

  console.log('truncation + spill')
  {
    const big = await run({ command: 'seq 1 6000' })
    ok('a long output is marked truncated', big.success && big.meta?.truncated === true, big.meta)
    ok(
      'the result keeps the TAIL (last line present, first line absent)',
      big.output?.includes('\n6000') &&
        !/^1\n/.test(big.output ?? '') &&
        !big.output?.includes('\n1\n2\n'),
      big.output?.slice(0, 200)
    )
    ok(
      'the result names the spill file',
      big.output?.startsWith('...output truncated...') &&
        big.output.includes('Full output saved to: ') &&
        !!big.meta?.outputPath,
      big.output?.slice(0, 200)
    )
    const spilled = big.meta?.outputPath ? fs.readFileSync(big.meta.outputPath, 'utf8') : ''
    ok(
      'the spill file holds the full output',
      spilled.startsWith('1\n2\n') &&
        spilled.trim().endsWith('6000') &&
        big.meta?.outputPath?.startsWith(path.join(WORKSPACE, 'tool-output')),
      big.meta?.outputPath
    )
    const small = await run({ command: 'seq 1 100' })
    ok(
      'a short output is not truncated and not spilled',
      small.meta?.truncated === false &&
        !small.meta?.outputPath &&
        small.output?.startsWith('1\n2\n'),
      small.meta
    )
  }

  console.log('watcher guard')
  {
    const dev = await run({ command: 'npm run dev' })
    ok(
      'a dev server in the foreground is refused before it runs',
      !dev.success &&
        dev.retryable === false &&
        dev.error?.includes('background=true') &&
        dev.error.includes('force=true'),
      dev.error
    )
    const watch = await run({ command: 'tail -f /dev/null' })
    ok(
      'tail -f is refused too',
      !watch.success && watch.error?.includes('background=true'),
      watch.error
    )
    const forced = await run({ command: 'tail -f /dev/null', force: true, timeout: 400 })
    ok(
      'force=true runs it (and the timeout proves it ran)',
      !forced.success && forced.error?.includes('timed out'),
      forced.error
    )
    const fine = await run({ command: 'vitest run --version' })
    ok(
      'vitest run is not a watcher shape (it just may fail to exist here)',
      !fine.error?.includes('background=true'),
      fine.error
    )
  }

  console.log('background jobs')
  {
    const bg = await run({ command: 'while true; do echo tick; sleep 0.1; done', background: true })
    const pid = Number(/PID: (\d+)/.exec(bg.output ?? '')?.[1])
    ok(
      'background returns a PID and a log path',
      bg.success &&
        Number.isInteger(pid) &&
        pid > 0 &&
        bg.output?.includes('Output log: ') &&
        bg.output.includes(`shell_stop(pid=${pid})`),
      bg.output
    )
    const logPath = /Output log: (\S+)/.exec(bg.output ?? '')?.[1] ?? ''
    await sleep(600)
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
    ok('the log file captures the process output', log.includes('tick'), {
      logPath,
      log: log.slice(0, 40)
    })
    const jobs = await shell.execute('shell_jobs', {})
    ok(
      'shell_jobs lists it as running with its log',
      jobs.success && jobs.output?.includes(`PID ${pid} (running`) && jobs.output.includes(logPath),
      jobs.output
    )
    const stop = await shell.execute('shell_stop', { pid })
    ok('shell_stop stops it', stop.success && stop.output?.includes(`Stopped PID ${pid}`), stop)
    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    ok('the process is gone', !alive)
    const again = await shell.execute('shell_stop', { pid })
    ok(
      'stopping a dead PID is a clean no-op',
      again.success && again.output?.includes('not running'),
      again
    )
    const none = await shell.execute('shell_jobs', {})
    ok(
      'the job list is empty afterwards',
      none.success && none.output?.includes('No background jobs'),
      none
    )
    const bad = await shell.execute('shell_stop', {})
    ok('shell_stop without a pid explains itself', !bad.success && bad.error?.includes('pid'), bad)
  }

  console.log('abort')
  {
    const controller = new AbortController()
    const p = run({ command: 'sleep 5; echo late' })
    setTimeout(() => controller.abort(), 100)
    const aborted = await shell.execute(
      'shell_exec',
      { command: 'sleep 5; echo late' },
      controller.signal
    )
    ok(
      'an aborted command reports Stopped by user',
      !aborted.success && aborted.error === 'Stopped by user.',
      aborted
    )
    void p
  }

  fs.rmSync(TMP, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

void main()
