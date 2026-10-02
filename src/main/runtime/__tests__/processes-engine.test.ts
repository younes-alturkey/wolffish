/**
 * The process manager's contract (src/main/processes): the persisted
 * registry, port arbitration from the Wolffish band, detached spawn with a
 * captured log, readiness by listener and by log line, liveness by pid + OS
 * start stamp (a reused pid is not "ours"), stop with tree kill, restart on
 * the same port, adopt by pid / port, the relaunch reconcile (a second
 * manager over the same workspace adopts what the first left running and
 * NEVER kills it), the restart supervisor, and the card snapshots.
 *
 * Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/processes-engine.test.ts
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-proc-'))
  const WORKSPACE = fs.realpathSync(TMP)
  fs.mkdirSync(path.join(WORKSPACE, 'brain'), { recursive: true })
  const { ProcessManager, tailBound } = await import('../../processes/manager')
  const { bandCandidate, allocateBandPort, BAND_START, BAND_SIZE } =
    await import('../../processes/ports')
  const { isPortFree, processInfo, listeningPorts, pidExists } =
    await import('../../processes/platform')

  const serverJs = path.join(WORKSPACE, 'server.js')
  fs.writeFileSync(
    serverJs,
    `const http=require('http');const port=Number(process.env.PORT||process.argv[2]||0);
const s=http.createServer((q,r)=>r.end('hi '+process.pid));
s.listen(port,'127.0.0.1',()=>console.log('listening http://localhost:'+s.address().port+'/'));
process.on('SIGTERM',()=>{console.log('bye');process.exit(0)});
setInterval(()=>{},1000);`
  )
  const crashJs = path.join(WORKSPACE, 'crash.js')
  fs.writeFileSync(crashJs, `console.log('boom');process.exit(3)`)

  console.log('\n— ports')
  const cand = bandCandidate('web-dev', WORKSPACE)
  ok(
    'band candidate is inside 20000-20999',
    cand >= BAND_START && cand < BAND_START + BAND_SIZE,
    cand
  )
  ok('candidate is deterministic', bandCandidate('web-dev', WORKSPACE) === cand)
  ok(
    'candidate differs per name',
    bandCandidate('api', WORKSPACE) !== cand || bandCandidate('api2', WORKSPACE) !== cand
  )
  // Hold the candidate with a real socket: the allocator must walk past it.
  const holder = net.createServer()
  await new Promise<void>((r) => holder.listen(cand, '127.0.0.1', () => r()))
  const allocated = await allocateBandPort('web-dev', WORKSPACE)
  ok('allocator skips a bound port', allocated !== null && allocated !== cand, { cand, allocated })
  ok('isPortFree is false on the held port', !(await isPortFree(cand)))
  const listeners = await listeningPorts()
  ok(
    'OS listener table sees the held port',
    listeners.some((l) => l.port === cand),
    listeners.length
  )
  holder.close()

  console.log('\n— tail bound')
  const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n')
  const t = tailBound(big)
  ok(
    'tail keeps the last 2000 lines',
    t.includes('line 2999') && !t.includes('line 999\n') && t.startsWith('…(')
  )

  console.log('\n— start / ready / stop')
  const m1 = new ProcessManager(WORKSPACE)
  await m1.init()
  ok('empty registry', m1.list().length === 0)
  const started = await m1.start({
    name: 'web-dev',
    command: `node ${serverJs} {port}`,
    cwd: WORKSPACE,
    wait: true
  })
  ok('start ok', started.ok, started)
  if (!started.ok) throw new Error('start failed')
  const rec = started.record
  ok('ready observed', started.ready && rec.run.state === 'running', rec.run)
  ok('port from the band', rec.run.port !== null && rec.run.port >= BAND_START, rec.run.port)
  ok(
    'url discovered from log',
    rec.run.url === `http://localhost:${rec.run.port}/` ||
      rec.run.url === `http://localhost:${rec.run.port}`,
    rec.run.url
  )
  ok(
    'pid recorded with OS start stamp',
    typeof rec.run.pid === 'number' && !!rec.run.osStart,
    rec.run
  )
  ok(
    'log path under files/processes',
    rec.run.logPath?.includes(path.join('files', 'processes', 'web-dev')),
    rec.run.logPath
  )
  ok('registry file written', fs.existsSync(path.join(WORKSPACE, 'brain', 'processes.json')))
  const logs = await m1.logs('web-dev', { lines: 5 })
  ok('logs contain the listening line', logs.includes('listening'), logs)
  const again = await m1.start({
    name: 'web-dev',
    command: `node ${serverJs} {port}`,
    cwd: WORKSPACE
  })
  ok('same name + command is reused, not duplicated', again.ok && again.alreadyRunning, again)
  const conflict = await m1.start({
    name: 'web-dev',
    command: `node ${serverJs} 0`,
    cwd: WORKSPACE
  })
  ok(
    'same name + different command is refused',
    !conflict.ok && /different command/.test(conflict.ok ? '' : conflict.error)
  )
  const managedPorts = await m1.ports()
  ok(
    'ports() marks the managed listener',
    managedPorts.some((p) => p.port === rec.run.port && p.managed === 'web-dev')
  )
  const notice = m1.noticeText(null)
  ok('tail notice names the process', notice.includes('web-dev running'), notice)

  console.log('\n— cards')
  const seen: unknown[] = []
  m1.onCard((s) => seen.push(s))
  const card = m1.openCard({ conversationId: 'c1', turnId: null, names: ['web-dev'] })
  ok(
    'card snapshot carries the record',
    card.processes.length === 1 && card.processes[0].name === 'web-dev'
  )
  ok('card emitted on open', seen.length === 1)

  console.log('\n— restart keeps port')
  const oldPid = rec.run.pid as number
  const restarted = await m1.restart('web-dev')
  ok('restart ok', restarted.ok, restarted)
  ok('restart kept the port', restarted.ok && restarted.record.run.port === rec.run.port)
  ok('restart changed the pid', restarted.ok && restarted.record.run.pid !== oldPid)
  ok('old pid is gone', !pidExists(oldPid))
  ok('card refreshed after restart', seen.length >= 2, seen.length)

  console.log('\n— relaunch reconcile (second manager over the same workspace)')
  const m2 = new ProcessManager(WORKSPACE)
  await m2.init()
  const r2 = m2.get('web-dev')
  ok(
    'second manager adopted the running process',
    r2?.run.state === 'running' && !!r2.run.adoptedAt,
    r2?.run
  )
  ok(
    'adopted pid still alive (nothing killed at reconcile)',
    r2?.run.pid !== null && pidExists(r2?.run.pid as number)
  )
  const stop2 = await m2.stop('web-dev')
  ok('second manager can stop it', stop2.ok && stop2.stopped, stop2)
  ok('port freed after stop', await isPortFree(rec.run.port as number))
  ok('state stopped', m2.get('web-dev')?.run.state === 'stopped')

  console.log('\n— liveness: pid reuse')
  const info = await processInfo(process.pid)
  ok('processInfo answers for a live pid', !!info?.startedAt, info)
  ok('processInfo null for a dead pid', (await processInfo(oldPid)) === null)

  // m1 and m2 are done: retire their liveness polls now. Left running, their
  // stale in-memory copies of the registry see m3's later stops as crashes
  // and their supervisors re-spawn records m3 has already removed — a leak
  // this test would otherwise leave behind (and, on Windows, trip over when
  // it deletes the workspace). The app runs exactly one manager.
  m1.shutdown()
  m2.shutdown()

  console.log('\n— readiness by logMatch and exit-before-ready')
  const m3 = new ProcessManager(WORKSPACE)
  await m3.init()
  const byLog = await m3.start({
    name: 'srv2',
    command: `node ${serverJs} {port}`,
    cwd: WORKSPACE,
    ready: { logMatch: 'listening', port: false }
  })
  ok('ready by log line', byLog.ok && byLog.ready, byLog)
  const crashed = await m3.start({
    name: 'crasher',
    command: `node ${crashJs}`,
    cwd: WORKSPACE,
    restart: 'never'
  })
  ok(
    'exit before ready is reported as a failure',
    !crashed.ok && /exited before/.test(crashed.ok ? '' : crashed.error),
    crashed
  )
  ok(
    'crashed state with exit code',
    m3.get('crasher')?.run.state === 'crashed' && m3.get('crasher')?.run.exitCode === 3,
    m3.get('crasher')?.run
  )
  const waited = await m3.waitFor('crasher', { state: 'crashed', timeoutMs: 1000 })
  ok('waitFor state matches', waited.matched && waited.matchedBy === 'state')

  console.log('\n— adopt by pid and by port')
  const foreign = spawn('node', [serverJs, '0'], {
    cwd: WORKSPACE,
    stdio: ['ignore', 'pipe', 'ignore']
  })
  const foreignPort = await new Promise<number>((resolve) => {
    foreign.stdout.on('data', (d) => {
      const m = /localhost:(\d+)/.exec(String(d))
      if (m) resolve(Number(m[1]))
    })
  })
  const adopted = await m3.adopt({ name: 'theirs', port: foreignPort })
  ok('adopt by port', adopted.ok && adopted.record?.run.pid === foreign.pid, adopted)
  ok(
    'adopted origin + restart never',
    adopted.record?.origin.kind === 'adopted' && adopted.record?.restart === 'never'
  )
  const stopped = await m3.stop('theirs')
  ok('adopted process stops', stopped.ok && stopped.stopped)
  await sleep(200)
  ok('foreign pid gone', !pidExists(foreign.pid as number))

  console.log("\n— one-shots and Wolffish's own tree")
  const oneShot = await m3.start({
    name: 'oneshot',
    command: 'echo hello-one-shot',
    cwd: WORKSPACE,
    restart: 'never'
  })
  ok(
    'an exit-0 one-shot is reported as finished, not failed',
    oneShot.ok &&
      !oneShot.ready &&
      oneShot.record.run.state === 'exited' &&
      oneShot.tail.includes('hello-one-shot'),
    oneShot
  )
  ok('a finished one-shot leaves no record behind', m3.get('oneshot') === null)
  ok(
    'its log survives',
    fs.existsSync(path.join(WORKSPACE, 'files', 'processes', 'oneshot', 'current.log'))
  )
  // A stale one-shot record (pre-rule, or finished while the app was closed) is pruned at reconcile.
  const { emptyRun } = await import('../../processes/types')
  await m3.registry.upsert({
    id: 'stale',
    name: 'stale-probe',
    command: 'ls',
    cwd: WORKSPACE,
    env: {},
    port: { mode: 'none' },
    ready: {},
    restart: 'never',
    onQuit: 'keep',
    autostart: 'off',
    origin: { conversationId: null, kind: 'started' },
    createdAt: 1,
    updatedAt: 1,
    run: { ...emptyRun(), state: 'exited', exitCode: 0, endedAt: Date.now() - 7_200_000 }
  })
  await m3.reconcile()
  ok(
    'reconcile prunes a stale finished one-shot regardless of origin',
    m3.get('stale-probe') === null
  )
  const selfAdopt = await m3.adopt({ name: 'me', pid: process.pid })
  ok(
    'adopting our own pid is refused',
    !selfAdopt.ok && /Wolffish itself/.test(selfAdopt.error ?? ''),
    selfAdopt
  )

  console.log('\n— fixed port: busy foreign owner is refused without takeover')
  const hold2 = net.createServer()
  const heldPort = await new Promise<number>((r) =>
    hold2.listen(0, '127.0.0.1', () => r((hold2.address() as net.AddressInfo).port))
  )
  const refused = await m3.start({
    name: 'fixed',
    command: `node ${serverJs} {port}`,
    cwd: WORKSPACE,
    port: { mode: 'fixed', port: heldPort }
  })
  ok(
    'busy fixed port refused',
    !refused.ok && /in use/.test(refused.ok ? '' : refused.error),
    refused
  )
  hold2.close()

  console.log('\n— update: undefined fields never clobber, readiness ignores the previous run')
  const clobber = await m3.update('srv2', { command: undefined, cwd: undefined, restart: 'never' })
  ok(
    'undefined patch fields keep command and cwd',
    clobber.ok &&
      clobber.record?.command.includes('server.js') &&
      clobber.record?.cwd === WORKSPACE,
    clobber.record
  )
  const srvPid = m3.get('srv2')?.run.pid as number
  await m3.stop('srv2')
  const stale = await m3.start({
    name: 'srv2',
    command: `node ${serverJs} {port}`,
    cwd: WORKSPACE,
    ready: { logMatch: 'NEVER_PRINTED_LINE', port: false, timeoutMs: 1500 }
  })
  ok(
    "a previous run's log line does not satisfy readiness",
    stale.ok && !stale.ready && stale.record.run.pid !== srvPid,
    stale
  )
  if (process.platform === 'darwin') {
    const desk = await m3.update('srv2', {
      autostart: 'system',
      cwd: path.join(os.homedir(), 'Desktop')
    })
    ok(
      'system autostart under ~/Desktop is refused with the wolffish alternative',
      !desk.ok && /wolffish/.test(desk.error ?? '') && m3.get('srv2')?.autostart === 'off',
      desk
    )
    await m3.update('srv2', { cwd: WORKSPACE })
  }

  console.log('\n— update / rename / remove')
  const up = await m3.update('srv2', { restart: 'always', newName: 'srv-renamed' })
  ok(
    'update + rename',
    up.ok && up.record?.name === 'srv-renamed' && up.record.restart === 'always',
    up
  )
  ok('old name gone', m3.get('srv2') === null)
  // Windows cannot move a folder whose log the running command holds open;
  // the record then keeps the log that is actually being written.
  ok(
    'renamed log dir moved',
    process.platform === 'win32'
      ? !!up.record?.run.logPath && fs.existsSync(up.record.run.logPath)
      : fs.existsSync(path.join(WORKSPACE, 'files', 'processes', 'srv-renamed', 'current.log'))
  )
  const rm = await m3.remove('srv-renamed')
  ok('remove stops and forgets', rm.ok && m3.get('srv-renamed') === null)
  await sleep(300)
  ok(
    'removed process pid gone',
    !(byLog.ok && byLog.record.run.pid && pidExists(byLog.record.run.pid))
  )
  ok('log dir deleted', !fs.existsSync(path.join(WORKSPACE, 'files', 'processes', 'srv-renamed')))

  console.log('\n— supervisor: on-failure restart with backoff')
  const flakyJs = path.join(WORKSPACE, 'flaky.js')
  fs.writeFileSync(
    flakyJs,
    `const fs=require('fs');const f=process.env.FLAG;if(!fs.existsSync(f)){fs.writeFileSync(f,'1');console.log('first run dies');process.exit(1)}console.log('second run ok');setInterval(()=>{},1000)`
  )
  const flag = path.join(WORKSPACE, 'flag')
  const flaky = await m3.start({
    name: 'flaky',
    command: `node ${flakyJs}`,
    cwd: WORKSPACE,
    env: { FLAG: flag },
    restart: 'on-failure',
    ready: { port: false, timeoutMs: 1500 }
  })
  ok('first run crashed', !flaky.ok, flaky)
  // Backoff 1 s, then the "alive for 3 s" readiness rule for a process with
  // no port and no log match — so ~4.5 s until it reports running.
  await sleep(6000)
  const f2 = m3.get('flaky')
  ok('supervisor restarted it', f2?.run.state === 'running' && f2.run.restarts === 1, f2?.run)
  await m3.remove('flaky')

  console.log('\n— redefining a crashed name cancels its pending restart')
  const bad = await m3.start({
    name: 'redo',
    command: `node ${crashJs}`,
    cwd: WORKSPACE,
    restart: 'on-failure',
    ready: { port: false, timeoutMs: 1500 }
  })
  ok('bad command crashed', !bad.ok, bad)
  // The supervisor now holds a 1 s backoff timer for "redo". Redefine it
  // before that fires: exactly one copy of the new command must run.
  const good = await m3.start({
    name: 'redo',
    command: `node ${serverJs} {port}`,
    cwd: WORKSPACE,
    restart: 'on-failure'
  })
  ok('new command started and is ready', good.ok && good.ready, good)
  await sleep(3500)
  const redo = m3.get('redo')
  const redoListeners = (await listeningPorts()).filter((l) => l.port === redo?.run.port)
  ok(
    'still running with no supervisor restart',
    redo?.run.state === 'running' && redo.run.restarts === 0,
    redo?.run
  )
  ok('one listener on its port', redoListeners.length === 1, redoListeners)
  await m3.remove('redo')

  await m3.stopAll()
  m1.shutdown()
  m2.shutdown()
  m3.shutdown()
  // Windows releases a killed tree's log handles a beat after taskkill returns.
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
