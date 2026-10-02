/**
 * Behavior tests for check-ins (runtime/check-in.ts): a call that finishes
 * before its delay settles normally; one that runs past it is PARKED, still
 * running, with a STILL RUNNING report carrying its progress and handle;
 * call_wait blocks again and returns the real result once it lands; call_stop
 * aborts the call's own controller; the runtime-tail notice names parked
 * calls until they are read; the universal arg is split off the call's args;
 * a turn's Stop takes its parked calls with it.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/check-in.test.ts
 */
import Module from 'node:module'
import os from 'node:os'

const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => os.tmpdir() }
    }
  }
  return origLoad.apply(this, args)
}

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    console.log(`  ok  ${label}`)
  } else {
    failed++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function main(): Promise<void> {
  const { CheckInManager, splitCheckInArg, CHECK_IN_ARG } = await import('@main/runtime/check-in')
  type StepResult = import('@main/runtime/motor').StepResult

  console.log('splitCheckInArg')
  {
    const a = splitCheckInArg({ command: 'ls', [CHECK_IN_ARG]: 30 })
    ok(
      'splits the seconds off',
      a.seconds === 30 && !(CHECK_IN_ARG in a.args) && a.args.command === 'ls'
    )
    const b = splitCheckInArg({ command: 'ls' })
    ok('untouched args pass through by reference', b.seconds === null && b.args !== null)
    const c = splitCheckInArg({ command: 'ls', [CHECK_IN_ARG]: 'nope' })
    ok(
      'garbage value = no override, still stripped',
      c.seconds === null && !(CHECK_IN_ARG in c.args)
    )
  }

  const base = {
    conversationKey: 'conv-1',
    turnId: 'turn-1',
    name: 'shell_exec',
    argsSummary: 'command=find ~ -name x'
  }
  const slow = (
    ms: number,
    result: StepResult
  ): { promise: Promise<StepResult>; controller: AbortController } => {
    const controller = new AbortController()
    const promise = new Promise<StepResult>((resolve) => {
      const t = setTimeout(() => resolve(result), ms)
      controller.signal.addEventListener('abort', () => {
        clearTimeout(t)
        resolve({ ok: false, output: 'Stopped by user.', attempts: 1 })
      })
    })
    return { promise, controller }
  }

  console.log('race: fast call settles')
  {
    const m = new CheckInManager()
    const fast = slow(50, { ok: true, output: 'done', attempts: 1 })
    const out = await m.race({ ...base, ...fast, toolCallId: 'tc1', seconds: 1 })
    ok('settled with the real result', out.kind === 'settled' && out.result.output === 'done')
    ok('nothing parked', m.list('conv-1').length === 0)
  }

  console.log('race: slow call parks, still running')
  {
    const m = new CheckInManager()
    let progressReads = 0
    m.setProgressSource((id) =>
      id === 'tc2' ? () => (progressReads++, 'Output rate: 0 B/s.\n./a\n./b') : null
    )
    const emitted: string[] = []
    m.registerTurnEmitter('turn-1', (r) => emitted.push(r.state))
    const s = slow(3500, { ok: true, output: 'found it', attempts: 1, meta: { exitCode: 0 } })
    const out = await m.race({ ...base, ...s, toolCallId: 'tc2', seconds: 1 })
    ok('checked in', out.kind === 'checked_in')
    if (out.kind !== 'checked_in') return
    ok('handle minted', /^call-\d+$/.test(out.record.handle))
    ok(
      'text says STILL RUNNING with the handle',
      out.text.includes('STILL RUNNING') && out.text.includes(out.record.handle)
    )
    ok('text carries the progress', out.text.includes('./b') && progressReads === 1)
    ok('text offers both moves', out.text.includes('call_stop') && out.text.includes('call_wait'))
    ok('still running in the registry', m.get(out.record.handle)?.state === 'running')
    ok('notice names it', (m.noticeText('conv-1') ?? '').includes('still running'))
    ok('notice is per conversation', m.noticeText('conv-other') === undefined)

    // wait again, shorter than the remaining time → second check-in
    const again = await m.wait(out.record.handle, 'conv-1', 1)
    ok('second wait checks in again', again.kind === 'checked_in' && again.record.checkIns === 2)
    ok(
      'second report is numbered',
      again.kind === 'checked_in' && again.text.includes('check-in 2')
    )

    // wait long enough → finished with the real result
    const fin = await m.wait(out.record.handle, 'conv-1', 10)
    ok(
      'final wait returns the real result',
      fin.kind === 'finished' && fin.result.output === 'found it'
    )
    ok('emitter saw the landing', emitted.includes('finished'))
    ok('read result leaves the registry', m.get(out.record.handle) === null)
    ok('notice clears once read', m.noticeText('conv-1') === undefined)
  }

  console.log('finished-unread: notice and late read')
  {
    const m = new CheckInManager()
    const s = slow(1600, { ok: true, output: 'late', attempts: 1 })
    const out = await m.race({ ...base, ...s, toolCallId: 'tc3', seconds: 1 })
    ok('parked', out.kind === 'checked_in')
    if (out.kind !== 'checked_in') return
    await new Promise((r) => setTimeout(r, 900))
    ok('finished unread shows in the notice', (m.noticeText('conv-1') ?? '').includes('finished'))
    const fin = await m.wait(out.record.handle, 'conv-1', 1)
    ok('late read returns it immediately', fin.kind === 'finished' && fin.result.output === 'late')
    ok(
      'wrong conversation cannot read it',
      (await m.wait(out.record.handle, 'conv-2', 1)).kind === 'unknown'
    )
  }

  console.log('stop')
  {
    const m = new CheckInManager()
    const s = slow(10_000, { ok: true, output: 'never', attempts: 1 })
    const out = await m.race({ ...base, ...s, toolCallId: 'tc4', seconds: 1 })
    ok('parked', out.kind === 'checked_in')
    if (out.kind !== 'checked_in') return
    const stopped = m.stop(out.record.handle, 'conv-1')
    ok('stop ok', stopped.ok)
    ok('controller aborted', s.controller.signal.aborted)
    const fin = await m.wait(out.record.handle, 'conv-1', 1)
    ok(
      'wait after stop returns the partial result',
      fin.kind === 'finished' && fin.record.state === 'stopped'
    )
    ok(
      "call_stop marks the stop as the model's",
      fin.kind === 'finished' && fin.record.stoppedBy === 'model'
    )
    ok('stopping an unknown handle fails cleanly', !m.stop('call-999', 'conv-1').ok)
    ok('cross-conversation stop refused', !m.stop(out.record.handle, 'conv-2').ok)
  }

  console.log('abortTurn')
  {
    const m = new CheckInManager()
    const a = slow(10_000, { ok: true, output: 'a', attempts: 1 })
    const b = slow(10_000, { ok: true, output: 'b', attempts: 1 })
    await m.race({ ...base, ...a, toolCallId: 'tc5', seconds: 1 })
    await m.race({ ...base, ...b, toolCallId: 'tc6', seconds: 1, turnId: 'turn-2' })
    m.abortTurn('turn-1')
    ok("the stopped turn's call aborted", a.controller.signal.aborted)
    ok(
      'a turn Stop marks the call as stopped by the user',
      m.list('conv-1').some((r) => r.toolCallId === 'tc5' && r.stoppedBy === 'user')
    )
    ok("another turn's call untouched", !b.controller.signal.aborted)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void main()
