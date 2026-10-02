/**
 * Behavior tests for the turn-end countdown manager (runtime/countdown.ts):
 * arm → turn end starts the clock → the executor runs the armed target;
 * a Stop drops it; Abort stops it; a second arm supersedes the first; and a
 * pending countdown found at init is rewritten as aborted.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/countdown.test.ts
 */
import fs from 'node:fs'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-countdown-'))
;(os as unknown as { homedir: () => string }).homedir = (): string => TEST_HOME

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
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const { CountdownManager, COUNTDOWN_MIN_SECONDS } = await import('@main/runtime/countdown')
  const { WORKSPACE_ROOT } = await import('@main/workspace/root')
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true })

  // ── fire path ────────────────────────────────────────────────────────
  {
    const m = new CountdownManager()
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
    m.setExecutor(async (tool, args) => {
      calls.push({ tool, args })
      ok('executor sees isFiring() true', m.isFiring())
      return { success: true, output: 'Restarting now.\nsecond line' }
    })
    const seen: string[] = []
    m.onSnapshot((s) => seen.push(s.status))
    const turnSeen: string[] = []
    const off = m.registerTurnEmitter('turn_1', (s) => turnSeen.push(s.status))

    const armed = await m.arm('conv_1', 'turn_1', {
      label: 'Restart this Mac',
      seconds: 1,
      tool: 'system_power',
      args: { action: 'restart', immediate: true }
    })
    ok('arm succeeds', armed.ok)
    if (!armed.ok) return
    ok('seconds clamped to the floor', armed.snapshot.seconds === COUNTDOWN_MIN_SECONDS)
    ok('armed snapshot rode the turn emitter', turnSeen.join() === 'armed')
    ok('pending() is the armed one', m.pending()?.countdownId === armed.snapshot.countdownId)
    ok('nothing fired while the turn runs', calls.length === 0)

    off()
    m.turnEnded('turn_1', true)
    const counting = m.get(armed.snapshot.countdownId)
    ok('turn end starts the clock', counting?.status === 'counting' && counting.fireAt !== null)
    ok(
      'deadline is seconds out',
      counting?.fireAt !== null &&
        counting !== null &&
        counting.fireAt - Date.now() > (COUNTDOWN_MIN_SECONDS - 1) * 1000
    )
    await sleep(COUNTDOWN_MIN_SECONDS * 1000 + 400)
    ok('executor ran the armed target once', calls.length === 1, JSON.stringify(calls))
    ok(
      'target tool + args passed verbatim',
      calls[0]?.tool === 'system_power' && calls[0]?.args.immediate === true
    )
    const fired = m.get(armed.snapshot.countdownId)
    ok(
      'status fired with first output line',
      fired?.status === 'fired' && fired.result === 'Restarting now.'
    )
    ok('isFiring() back to false', !m.isFiring())
    ok(
      'snapshot listeners saw every transition',
      seen.join() === 'armed,counting,fired,fired',
      seen.join()
    )
    ok('no pending after fire', m.pending() === null)
  }

  // ── stop drops it ────────────────────────────────────────────────────
  {
    const m = new CountdownManager()
    let ran = 0
    m.setExecutor(async () => {
      ran += 1
      return { success: true }
    })
    const armed = await m.arm('conv_2', 'turn_2', { label: 'X', seconds: 1, tool: 't', args: {} })
    ok('arm ok', armed.ok)
    m.turnEnded('turn_2', false)
    await sleep(50)
    const snap = armed.ok ? m.get(armed.snapshot.countdownId) : null
    ok('stopped turn → aborted by stop', snap?.status === 'aborted' && snap.abortedBy === 'stop')
    await sleep(COUNTDOWN_MIN_SECONDS * 1000 + 200)
    ok('nothing ran after a stop', ran === 0)
  }

  // ── abort while counting ─────────────────────────────────────────────
  {
    const m = new CountdownManager()
    let ran = 0
    m.setExecutor(async () => {
      ran += 1
      return { success: true }
    })
    const armed = await m.arm('conv_3', 'turn_3', { label: 'X', seconds: 1, tool: 't', args: {} })
    if (!armed.ok) return
    m.turnEnded('turn_3', true)
    const res = await m.abort(armed.snapshot.countdownId, 'user')
    ok('abort ok while counting', res.ok)
    ok('aborted by user', m.get(armed.snapshot.countdownId)?.abortedBy === 'user')
    const again = await m.abort(armed.snapshot.countdownId, 'user')
    ok('second abort refused', !again.ok)
    await sleep(COUNTDOWN_MIN_SECONDS * 1000 + 200)
    ok('nothing ran after abort', ran === 0)
  }

  // ── supersede ────────────────────────────────────────────────────────
  {
    const m = new CountdownManager()
    const a = await m.arm('conv_4', 'turn_4', { label: 'A', seconds: 1, tool: 't', args: {} })
    const b = await m.arm('conv_4', 'turn_4', { label: 'B', seconds: 1, tool: 't', args: {} })
    ok('first superseded', a.ok && m.get(a.snapshot.countdownId)?.abortedBy === 'superseded')
    ok('second is the pending one', b.ok && m.pending()?.countdownId === b.snapshot.countdownId)
  }

  // ── executor failure ─────────────────────────────────────────────────
  {
    const m = new CountdownManager()
    m.setExecutor(async () => ({ success: false, error: 'boom' }))
    const armed = await m.arm('conv_5', 'turn_5', { label: 'X', seconds: 1, tool: 't', args: {} })
    if (!armed.ok) return
    m.turnEnded('turn_5', true)
    await sleep(COUNTDOWN_MIN_SECONDS * 1000 + 300)
    const snap = m.get(armed.snapshot.countdownId)
    ok('failed target → failed with error', snap?.status === 'failed' && snap.error === 'boom')
  }

  // ── relaunch reconciliation ──────────────────────────────────────────
  {
    const registry = path.join(WORKSPACE_ROOT, 'countdowns.json')
    fs.writeFileSync(
      registry,
      JSON.stringify({
        version: 1,
        countdowns: [
          {
            countdownId: 'cd_stale',
            conversationId: null,
            turnId: 'turn_x',
            label: 'Stale',
            seconds: 10,
            status: 'counting',
            armedAt: 1,
            fireAt: 2,
            endedAt: null,
            target: { tool: 't', args: {} }
          }
        ]
      })
    )
    const m = new CountdownManager()
    await m.init()
    const snap = m.get('cd_stale')
    ok(
      'pending at init → aborted by relaunch',
      snap?.status === 'aborted' && snap.abortedBy === 'relaunch'
    )
    ok('no pending after init', m.pending() === null)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  fs.rmSync(TEST_HOME, { recursive: true, force: true })
  process.exit(failed === 0 ? 0 : 1)
}

void main()
