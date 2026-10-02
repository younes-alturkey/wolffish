/**
 * Cross-channel run visibility + cancel (TurnRunner.activeRuns /
 * cancelConversation).
 *
 * Why these exist: chat:turnState is a BROADCAST of TRANSITIONS, and this
 * app keeps running with no window at all — Telegram/WhatsApp turns fire
 * headless. A renderer window opened (or reopened from the tray) mid-run
 * therefore never saw 'started', and the in-app chat rendered the
 * conversation as a fresh, ready-to-send one: composer live, model
 * switchable, no stop. activeRuns() is the cold-start snapshot that closes
 * that hole; cancelConversation() is what makes the in-app Stop button real
 * for a run the app is only watching.
 *
 * Exercises the REAL TurnRunner. The agent is stubbed (respond parks on a
 * gate so a run is observably in flight), and a title is passed in so the
 * titler — the one step that would touch disk or an LLM — is skipped.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/channels/__tests__/active-runs.test.ts
 */

import fs from 'node:fs'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'

// Same hermetic setup as turn-isolation.test.ts: redirect the workspace and
// shim `electron` BEFORE the runtime graph loads.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-activeruns-'))
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
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
async function waitFor(cond: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return
    await tick()
  }
  throw new Error('waitFor timed out')
}
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function run(): Promise<void> {
  const { Corpus } = await import('@main/runtime/corpus')
  const { TurnRunner } = await import('@main/channels/turn-runner')
  type Lifecycle = import('@main/channels/turn-runner').TurnLifecycleEvent

  const corpus = new Corpus({ devLog: false })
  const started = deferred<void>()
  const gate = deferred<void>()
  const aborted: string[] = []

  const agent = {
    corpus,
    respond: async (turn: {
      turnId: string
      conversationId: string | null
      signal?: AbortSignal
    }): Promise<unknown> => {
      started.resolve()
      turn.signal?.addEventListener('abort', () => {
        aborted.push(turn.turnId)
        gate.resolve()
      })
      await gate.promise
      return turn.signal?.aborted
        ? { stopReason: 'canceled' as const, toolCalls: 0 }
        : { stopReason: 'end_turn' as const, toolCalls: 0 }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runner = new TurnRunner(agent as any)
  const lifecycle: Lifecycle[] = []
  runner.setLifecycleListener((ev) => lifecycle.push(ev))

  // A Telegram sink — the point of the feature is that this run is visible
  // (and cancelable) from a surface that does NOT own it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makeSink = (ctx: { turnId: string; conversationId: string | null }): any => ({
    ...ctx,
    channelId: 'telegram',
    onSegment: () => {},
    onTurnEvent: () => {},
    onApprovalRequest: async () => 'denied' as const,
    onDone: () => {},
    onError: () => {},
    onCredentialBlocked: () => {}
  })

  const sendTelegram = (conversationId: string, content: string): { done: Promise<void> } =>
    runner.send({
      history: [{ role: 'user', content }],
      conversationId,
      // Pre-titled: skips the titler entirely, so no LLM call and no disk write.
      conversationTitle: 'Live Run',
      makeSink
    })

  const handle = sendTelegram('conv_tg', 'hello from telegram')
  await started.promise

  // ── 1. A live channel run is visible to a window that never saw 'started' ──
  {
    const runs = runner.activeRuns()
    ok('activeRuns: lists the running conversation', runs.length === 1, JSON.stringify(runs))
    ok('activeRuns: carries the owning channel', runs[0]?.channel === 'telegram', runs[0]?.channel)
    ok('activeRuns: carries the title', runs[0]?.title === 'Live Run', String(runs[0]?.title))
    ok(
      'activeRuns: names the conversation',
      runs[0]?.conversationId === 'conv_tg',
      runs[0]?.conversationId
    )
  }

  // ── 2. A turn QUEUED behind it counts as running too ────────────────────
  // The renderer must lock the composer for a queued turn as well — it is
  // work the conversation owes, and Stop has to be able to reach it.
  {
    const queued = sendTelegram('conv_tg', 'second message')
    await tick()
    const runs = runner.activeRuns()
    ok(
      'activeRuns: one entry per conversation, not per turn',
      runs.length === 1,
      String(runs.length)
    )

    // ── 3. Cross-channel cancel reaches BOTH (running + queued) ────────────
    const canceled = runner.cancelConversation('conv_tg')
    ok('cancel: reports it hit a live run', canceled)
    await handle.done
    await queued.done
    ok('cancel: aborted the in-flight turn', aborted.length >= 1, String(aborted.length))
  }

  // ── 4. Cleared once settled — a stale entry would lock the composer ─────
  await waitFor(() => runner.activeRuns().length === 0)
  ok('activeRuns: empty after the lane drains', runner.activeRuns().length === 0)
  ok('activeRuns: matches isConversationActive', !runner.isConversationActive('conv_tg'))
  ok(
    'lifecycle: a terminal event always follows (the renderer unlocks on it)',
    lifecycle.filter((e) => e.phase !== 'started').length === 2,
    JSON.stringify(lifecycle.map((e) => e.phase))
  )

  // ── 5. Unknown conversation → false, so the caller can fall through ─────
  ok('cancel: no live run reports false', runner.cancelConversation('conv_missing') === false)

  console.log(`\n${passed} passed, ${failed} failed`)
  fs.rmSync(TEST_HOME, { recursive: true, force: true })
  process.exit(failed === 0 ? 0 : 1)
}

void run().catch((err) => {
  console.error(err)
  fs.rmSync(TEST_HOME, { recursive: true, force: true })
  process.exit(1)
})
