/**
 * Behavior tests for blocking waits (runtime/wait.ts) and the `wait` tool
 * that drives them: the card is emitted BEFORE the block, a mid-turn message
 * ends the wait early, a Stop cancels it, one conversation cannot stack two,
 * and the two snapshots collapse to ONE persisted card.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/wait.test.ts
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
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function main(): Promise<void> {
  const { WaitManager } = await import('@main/runtime/wait')
  const { upsertWaitSegment } = await import('@main/runtime/broca')
  const { turnScope } = await import('@main/runtime/corpus')
  type Snap = import('@main/runtime/broca').WaitSnapshot

  const TURN = 'turn_1'
  const CONV = 'conv_1'

  function harness(): { waits: InstanceType<typeof WaitManager>; seen: Snap[]; stop: () => void } {
    const waits = new WaitManager()
    const seen: Snap[] = []
    const stop = waits.registerTurnEmitter(TURN, (s) => seen.push(s))
    return { waits, seen, stop }
  }

  function inTurn<T>(fn: () => T): T {
    return turnScope.run({ turnId: TURN, conversationId: CONV, autonomous: false }, fn)
  }

  // 1. The card goes out BEFORE the block, and the terminal snapshot follows.
  {
    const { waits, seen } = harness()
    const run = inTurn(() => waits.start({ reason: 'Letting the build finish', seconds: 0.2 }))
    ok('waiting card emitted synchronously', seen.length === 1, `saw ${seen.length}`)
    ok('card says waiting', seen[0]?.status === 'waiting')
    ok('card carries the reason', seen[0]?.reason === 'Letting the build finish')
    ok('card carries the conversation', seen[0]?.conversationId === CONV)
    ok('deadline is start + duration', seen[0]?.endsAt === seen[0]?.startedAt + 200)
    const result = await run
    ok('elapsed', result.ok && result.outcome.status === 'elapsed', JSON.stringify(result))
    ok('two snapshots total', seen.length === 2, `saw ${seen.length}`)
    ok('terminal says elapsed', seen[1]?.status === 'elapsed')
    ok('same waitId on both', seen[0]?.waitId === seen[1]?.waitId)

    // The persisted feed holds ONE card, in the terminal state.
    const segments: import('@main/runtime/broca').Segment[] = []
    for (const snapshot of seen) {
      upsertWaitSegment(segments, { kind: 'wait', turnId: TURN, segmentId: 's', snapshot })
    }
    ok('one persisted card', segments.length === 1, `got ${segments.length}`)
    ok(
      'persisted card is the terminal one',
      segments[0]?.kind === 'wait' && segments[0].snapshot.status === 'elapsed'
    )
  }

  // 2. A mid-turn message ends a long wait at once.
  {
    const { waits, seen } = harness()
    const started = Date.now()
    const run = inTurn(() => waits.start({ reason: 'Waiting an hour', seconds: 3600 }))
    ok('long wait is pending', waits.pending(CONV)?.status === 'waiting')
    const broke = waits.interrupt(CONV, 'actually, skip it')
    ok('interrupt reports it cut one short', broke)
    const result = await run
    ok('interrupted', result.ok && result.outcome.status === 'interrupted', JSON.stringify(result))
    ok('returned in well under the hour', Date.now() - started < 2000)
    ok('terminal card records the message', seen[1]?.interruptedBy === 'actually, skip it')
    ok('no wait pending afterwards', waits.pending(CONV) === null)
    ok('a second interrupt is a no-op', waits.interrupt(CONV) === false)
  }

  // 3. Stop cancels a wait in flight.
  {
    const { waits } = harness()
    const ac = new AbortController()
    const run = inTurn(() => waits.start({ reason: 'Waiting', seconds: 3600 }, ac.signal))
    ac.abort()
    const result = await run
    ok(
      'canceled by Stop',
      result.ok && result.outcome.status === 'canceled',
      JSON.stringify(result)
    )
    ok('lane is free after a Stop', waits.pending(CONV) === null)
  }

  // 4. One wait per conversation; bad input is refused rather than slept through.
  {
    const { waits } = harness()
    const run = inTurn(() => waits.start({ reason: 'First', seconds: 3600 }))
    const second = await inTurn(() => waits.start({ reason: 'Second', seconds: 5 }))
    ok('a second wait is refused', !second.ok)
    waits.interrupt(CONV)
    await run
    const noSeconds = await inTurn(() => waits.start({ reason: 'x', seconds: 0 }))
    ok('zero seconds refused', !noSeconds.ok)
    const noReason = await inTurn(() => waits.start({ reason: '   ', seconds: 5 }))
    ok('blank reason refused', !noReason.ok)
  }

  // 4b. Two conversationless runs are two lanes, not one. They all keyed as
  // '' before, so the second was refused as a duplicate of the first.
  {
    const waits = new WaitManager()
    const a = turnScope.run({ turnId: 't_a', conversationId: null, autonomous: true }, () =>
      waits.start({ reason: 'A', seconds: 3600 })
    )
    const b = turnScope.run({ turnId: 't_b', conversationId: null, autonomous: true }, () =>
      waits.start({ reason: 'B', seconds: 3600 })
    )
    ok('a conversationless run does not block another', waits.pending(null) === null)
    // Neither has settled, so neither was refused outright; cancel both.
    const settled = await Promise.race([
      Promise.all([a, b]).then(() => 'both'),
      new Promise((r) => setTimeout(() => r('still waiting'), 50))
    ])
    ok('both are genuinely blocked, not errored', settled === 'still waiting', String(settled))
  }

  // 5. The tool itself: arg shapes, and what the model is told.
  {
    const plugin = (
      await import('../../../defaults/workspace/brain/cerebellum/utilities/plugin/index.mjs')
    ).default as {
      init: (ctx: unknown) => Promise<void>
      execute: (
        name: string,
        args: Record<string, unknown>,
        signal?: AbortSignal
      ) => Promise<{ success: boolean; output?: string; error?: string }>
    }
    const calls: { seconds: number; reason: string }[] = []
    await plugin.init({
      wait: {
        start: async (input: { seconds: number; reason: string }) => {
          calls.push(input)
          return {
            ok: true as const,
            outcome: { status: 'elapsed' as const, waitedSeconds: input.seconds }
          }
        }
      }
    })
    await plugin.execute('wait', { reason: 'r', hours: 1 })
    ok('hours convert to seconds', calls[0]?.seconds === 3600, JSON.stringify(calls[0]))
    await plugin.execute('wait', { reason: 'r', minutes: 2, seconds: 30 })
    ok('different units add up', calls[1]?.seconds === 150, JSON.stringify(calls[1]))
    // A live deepseek-flash run sent { seconds: 240, minutes: 4 } for ONE
    // four-minute wait and naive addition made it eight. Restatement is not
    // a composite.
    await plugin.execute('wait', { reason: 'r', seconds: 240, minutes: 4, hours: 0 })
    ok('a restated duration is not doubled', calls[2]?.seconds === 240, JSON.stringify(calls[2]))
    await plugin.execute('wait', { reason: 'r', seconds: 3600, minutes: 60, hours: 1 })
    ok(
      'a thrice-restated duration is counted once',
      calls[3]?.seconds === 3600,
      JSON.stringify(calls[3])
    )
    await plugin.execute('wait', { reason: 'r', hours: 1, minutes: 30 })
    ok('a real composite still adds', calls[4]?.seconds === 5400, JSON.stringify(calls[4]))
    const elapsedOut = await plugin.execute('wait', { reason: 'r', seconds: 5 })
    ok(
      'an elapsed wait carries the same rule',
      /before you write your closing line/.test(elapsedOut.output ?? ''),
      elapsedOut.output
    )
    ok(
      'and names the non-verbal outcomes too',
      /an action/.test(elapsedOut.output ?? '') && !/\bsay it\b/.test(elapsedOut.output ?? ''),
      elapsedOut.output
    )
    const noDuration = await plugin.execute('wait', { reason: 'r' })
    ok('missing duration is an error, not a no-op sleep', !noDuration.success)
    ok('the error says there is no maximum', /no maximum/i.test(noDuration.error ?? ''))
    const noReason = await plugin.execute('wait', { seconds: 5 })
    ok('missing reason is refused', !noReason.success)

    const interrupted = await (async () => {
      await plugin.init({
        wait: {
          start: async () => ({
            ok: true as const,
            outcome: {
              status: 'interrupted' as const,
              waitedSeconds: 12,
              interruptedBy: 'stop that'
            }
          })
        }
      })
      return plugin.execute('wait', { reason: 'r', seconds: 60 })
    })()
    ok('an interrupted wait still succeeds', interrupted.success)
    ok(
      'and tells the model the message follows',
      /follows this result/i.test(interrupted.output ?? ''),
      interrupted.output
    )
    // A live run answered the original ask TWICE: the old wording said the
    // message superseded the wait "unless they say otherwise", and a message
    // that says "continue" lands in exactly that branch — leaving two
    // mandates open, both of which the model satisfied.
    ok(
      'and tells it to act exactly once',
      /[Nn]ever both, and never twice/.test(interrupted.output ?? ''),
      interrupted.output
    )
    ok(
      'without a supersede-unless branch to fall into',
      !/unless they say otherwise/i.test(interrupted.output ?? ''),
      interrupted.output
    )
    // The second live shape: answer, call notify_phone, then a wrap-up line
    // that re-says the answer. Both outcomes now put the answer last.
    ok(
      'and to finish its tool calls before the closing line',
      /before you write your closing line/.test(interrupted.output ?? ''),
      interrupted.output
    )
    // The wait is followed by WORK as often as by words — a deploy, a
    // re-check, a file — so neither outcome may speak of "saying" it.
    ok(
      'and never frames the outcome as something to say',
      !/\bsay it\b|\bANSWER ONCE\b/.test(interrupted.output ?? ''),
      interrupted.output
    )
  }
}

void main().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
})
