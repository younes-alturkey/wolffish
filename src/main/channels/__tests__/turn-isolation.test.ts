/**
 * Isolation tests for concurrent turns sharing one Agent + corpus bus.
 *
 * Turns now run CONCURRENTLY: the TurnRunner serializes turns per
 * conversation (one ordered transcript each) and runs different
 * conversations in parallel — 3 in-app + WhatsApp + Telegram at once is the
 * design target. Everything that used to rely on "one turn at a time" is
 * keyed by turn identity instead:
 *
 *  - `turnScope` (AsyncLocalStorage<TurnScope>) is entered around every
 *    foreground turn (TurnRunner) and around sealed background runs
 *    (processAutonomous, summarizers — `autonomous: true`). Corpus emits are
 *    synchronous (mitt), so a relay listener reads the EMITTER's scope and
 *    relays only its own turn's events, drops other turns' and every
 *    autonomous emit, and stays fail-open for scope-less emits.
 *  - `turnRouter` registers each turn's sink under its turnId; approval /
 *    ask_user dispatch resolves the requesting turn through the same ALS.
 *  - ElectronChannel tracks turns per conversation: chat:cancel(conversationId)
 *    aborts only that conversation's turn; a resend preempts only its own
 *    conversation; end-of-turn drains only that turn's pending resolvers.
 *
 * This exercises the REAL Corpus, TurnRunner, TurnRouter and ElectronChannel.
 * The only shim is a minimal `electron` module (deps touch `electron.app` at
 * import time); the isolation logic under test never calls into it.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/channels/__tests__/turn-isolation.test.ts
 */

import fs from 'node:fs'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'

// Redirect the workspace to a throwaway temp dir BEFORE the runtime graph
// loads: TurnRunner now titles conversations (a persisted step), and
// conversations.ts derives its path from os.homedir() — without this the test
// would write junk conversation shells into the real ~/.wolffish workspace.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-turntest-'))
;(os as unknown as { homedir: () => string }).homedir = (): string => TEST_HOME

// Shim `electron` so importing the runtime graph doesn't crash outside an
// Electron process. Must run before the dynamic imports below.
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

type Sent = {
  channel: string
  payload: {
    turnId?: string
    conversationId?: string | null
    id?: string
    type?: string
    payload?: Record<string, unknown>
  }
}
function makeSender(): {
  sent: Sent[]
  isDestroyed: () => boolean
  send: (c: string, p: unknown) => void
} {
  const sent: Sent[] = []
  return {
    sent,
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => {
      sent.push({ channel, payload: payload as Sent['payload'] })
    }
  }
}

async function run(): Promise<void> {
  const { Corpus, turnScope, runDetached } = await import('@main/runtime/corpus')
  const { TurnRunner } = await import('@main/channels/turn-runner')
  const { turnRouter } = await import('@main/channels/channel')
  const { ElectronChannel } = await import('@main/channels/electron/channel')

  // ── 1. turnScope is visible to a synchronously-dispatched listener ──────
  // Everything rests on: corpus emit is synchronous (mitt), so a listener
  // runs in the emitter's async context and reads the emitter's scope —
  // regardless of which turn registered the listener.
  {
    const c = new Corpus({ devLog: false })

    let sawAutonomous: boolean | undefined
    let sawTurnId: string | null | undefined
    let sawOutside: unknown = 'unset'
    c.on('safety.approved', () => {
      const s = turnScope.getStore()
      sawAutonomous = s?.autonomous
      sawTurnId = s?.turnId
    })
    c.on('safety.denied', () => {
      sawOutside = turnScope.getStore()
    })

    runDetached(() => c.emit('safety.approved', { id: '1' }))
    ok('scope: detached emit reads autonomous=true', sawAutonomous === true)

    turnScope.run({ turnId: 'turn_X', conversationId: 'conv_X', autonomous: false }, () =>
      c.emit('safety.approved', { id: '2' })
    )
    ok('scope: foreground emit reads its turnId', sawTurnId === 'turn_X', String(sawTurnId))

    c.emit('safety.denied', { id: '3' })
    ok('scope: emit outside any run reads store=undefined', sawOutside === undefined)
  }

  // ── 2. Concurrent-turn relay + router isolation through the real stack ──
  {
    const corpus = new Corpus({ devLog: false })
    const stoppedTasks: string[] = []
    const startedA = deferred<void>()
    const startedB = deferred<void>()
    const gateA = deferred<void>()
    const gateB = deferred<void>()
    const approvalsSeen: Array<{ turn: string; decision: string }> = []

    // Fake Agent driving TWO overlapping foreground turns (the runner wraps
    // each respond in its turnScope) plus a background burst. Each respond
    // emits its own task/tool/llm events, requests an approval mid-flight,
    // and parks on a gate so the other turn provably overlaps.
    const agent = {
      corpus,
      // TurnRunner titles a new conversation via a pure LLM call before
      // responding — stub it so titling is deterministic (and hermetic: the
      // temp-home redirect above keeps its persist out of the real workspace).
      thalamus: { title: async (): Promise<{ text: string }> => ({ text: 'Test Title' }) },
      motor: {
        stopTask: async (id: string): Promise<void> => {
          stoppedTasks.push(id)
        }
      },
      respond: async (turn: {
        turnId: string
        conversationId: string | null
        history: Array<{ content: string }>
      }): Promise<unknown> => {
        const tag = turn.history[0]?.content === 'first' ? 'A' : 'B'
        const task = tag === 'A' ? 'task_A' : 'task_B'
        corpus.emit('task.created', { taskId: task, name: tag, stepsTotal: 1 })
        corpus.emit('llm.response', {
          provider: tag,
          model: `${tag}-model`,
          role: 'brain',
          inputTokens: tag === 'A' ? 111 : 222,
          outputTokens: 5,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          durationMs: 1
        })
        if (tag === 'A') startedA.resolve()
        else startedB.resolve()
        // Approval dispatched from INSIDE this turn's async context — the
        // router must resolve it to THIS turn's sink even while the other
        // turn is live.
        const decision = await turnRouter.dispatchApproval({
          id: `apr_${tag}`,
          toolCall: { id: `call_${tag}`, name: `tool_${tag}`, args: {} },
          level: 'confirm' as const,
          reason: 'test'
        })
        approvalsSeen.push({ turn: tag, decision })
        await (tag === 'A' ? gateA.promise : gateB.promise)
        corpus.emit('tool.completed', { taskId: task, tool: `tool_${tag}`, durationMs: 1 })
        return { stopReason: 'end_turn' as const, toolCalls: 1 }
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = new TurnRunner(agent as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channel = new ElectronChannel(agent as any, runner)
    const sender = makeSender()

    const sendAny = (payload: unknown): { turnId: string; ok: true } =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel.send(sender as any, payload as any)
    const a = sendAny({ history: [{ role: 'user', content: 'first' }], conversationId: 'conv_A' })
    const b = sendAny({ history: [{ role: 'user', content: 'second' }], conversationId: 'conv_B' })

    // Different conversations run CONCURRENTLY: both responds get in-flight
    // while neither gate has opened.
    await startedA.promise
    await startedB.promise
    ok('parallel: two conversations are in flight simultaneously', true)
    ok(
      'parallel: runner reports both conversations active',
      runner.isConversationActive('conv_A') && runner.isConversationActive('conv_B')
    )

    // A background autonomous burst while both turns stream.
    runDetached(() => {
      corpus.emit('task.created', { taskId: 'auto_task', name: 'hb', stepsTotal: 1 })
      corpus.emit('llm.response', {
        provider: 'auto',
        model: 'auto-model',
        role: 'brain',
        inputTokens: 999,
        outputTokens: 888,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        durationMs: 9
      })
    })

    // Approval cards: exactly one per turn, each stamped with its own turn
    // and conversation. Answer A approved, B denied — cross-resolution would
    // flip these.
    await waitFor(
      () => sender.sent.filter((s) => s.channel === 'chat:approvalRequest').length === 2
    )
    const approvalEvents = sender.sent.filter((s) => s.channel === 'chat:approvalRequest')
    const aCard = approvalEvents.find((e) => e.payload.id === 'apr_A')
    const bCard = approvalEvents.find((e) => e.payload.id === 'apr_B')
    ok(
      'router: A approval card stamped with A turn+conversation',
      aCard?.payload.turnId === a.turnId && aCard?.payload.conversationId === 'conv_A',
      JSON.stringify(aCard?.payload)
    )
    ok(
      'router: B approval card stamped with B turn+conversation',
      bCard?.payload.turnId === b.turnId && bCard?.payload.conversationId === 'conv_B',
      JSON.stringify(bCard?.payload)
    )
    channel.respondApproval({ id: 'apr_A', decision: 'approved' })
    channel.respondApproval({ id: 'apr_B', decision: 'denied' })
    await waitFor(() => approvalsSeen.length === 2)
    ok(
      'router: decisions land on the requesting turns',
      approvalsSeen.some((x) => x.turn === 'A' && x.decision === 'approved') &&
        approvalsSeen.some((x) => x.turn === 'B' && x.decision === 'denied'),
      JSON.stringify(approvalsSeen)
    )

    // Relay: each turn's events only, autonomous burst nowhere.
    const eventsFor = (turnId: string): Sent[] =>
      sender.sent.filter((s) => s.channel === 'chat:turnEvent' && s.payload.turnId === turnId)
    const blobA = JSON.stringify(eventsFor(a.turnId))
    const blobB = JSON.stringify(eventsFor(b.turnId))
    ok('relay: A saw its own task', blobA.includes('task_A'))
    ok('relay: A saw none of B', !blobA.includes('task_B') && !blobA.includes('222'), blobA)
    ok('relay: B saw its own task', blobB.includes('task_B'))
    ok('relay: B saw none of A', !blobB.includes('task_A') && !blobB.includes('111'), blobB)
    ok(
      'relay: autonomous burst leaked nowhere',
      !blobA.includes('auto_task') && !blobB.includes('auto_task') && !blobA.includes('999')
    )
    ok(
      'relay: every A event carries conv_A',
      eventsFor(a.turnId).every((e) => e.payload.conversationId === 'conv_A')
    )

    // Per-conversation cancel: stopping conv_B must abort only B's task.
    await channel.cancel('conv_B')
    ok(
      'cancel: conv_B cancel stops task_B only',
      stoppedTasks.length === 1 && stoppedTasks[0] === 'task_B',
      JSON.stringify(stoppedTasks)
    )
    ok('cancel: A still live after B canceled', runner.isConversationActive('conv_A'))

    gateA.resolve()
    gateB.resolve()
    await waitFor(
      () =>
        sender.sent.filter((s) => s.channel === 'chat:done' || s.channel === 'chat:error').length >=
        2
    )
    const doneA = sender.sent.find(
      (s) => s.channel === 'chat:done' && s.payload.turnId === a.turnId
    )
    ok(
      'done: A completes with its conversation stamped',
      doneA?.payload.conversationId === 'conv_A'
    )
    await waitFor(() => !runner.isConversationActive('conv_A'))
    ok('teardown: no conversations left active', runner.activeTurnCount() === 0)
  }

  // ── 3. Same-conversation turns still serialize ───────────────────────────
  {
    const corpus = new Corpus({ devLog: false })
    const order: string[] = []
    const gate1 = deferred<void>()
    const agent = {
      corpus,
      thalamus: { title: async (): Promise<{ text: string }> => ({ text: 'Test Title' }) },
      motor: { stopTask: async (): Promise<void> => undefined },
      respond: async (turn: { history: Array<{ content: string }> }): Promise<unknown> => {
        const tag = turn.history[0]?.content
        order.push(`start_${tag}`)
        if (tag === 'one') await gate1.promise
        order.push(`end_${tag}`)
        return { stopReason: 'end_turn' as const, toolCalls: 0 }
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = new TurnRunner(agent as any)
    const noopSink = (turnId: string): import('@main/channels/channel').TurnSink => ({
      channelId: 'electron',
      turnId,
      conversationId: 'conv_S',
      onSegment: () => undefined,
      onTurnEvent: () => undefined,
      onApprovalRequest: async () => 'denied' as const,
      onDone: () => undefined,
      onError: () => undefined,
      onCredentialBlocked: () => undefined
    })
    const h1 = runner.send({
      history: [{ role: 'user', content: 'one' }],
      conversationId: 'conv_S',
      makeSink: ({ turnId }) => noopSink(turnId)
    })
    const h2 = runner.send({
      history: [{ role: 'user', content: 'two' }],
      conversationId: 'conv_S',
      makeSink: ({ turnId }) => noopSink(turnId)
    })
    await waitFor(() => order.includes('start_one'))
    await tick()
    ok(
      'serialize: second turn of the SAME conversation waits',
      !order.includes('start_two'),
      JSON.stringify(order)
    )
    gate1.resolve()
    await h1.done
    await h2.done
    ok(
      'serialize: strict FIFO within one conversation',
      JSON.stringify(order) === JSON.stringify(['start_one', 'end_one', 'start_two', 'end_two']),
      JSON.stringify(order)
    )
  }

  // ── 3b. A hung titler cannot wedge the turn (title-first deadline) ───────
  // Titling is awaited BEFORE respond; a hung/stuck provider must not block
  // the turn forever. With a short deadline the titling is aborted and the
  // turn proceeds untitled (re-titled on a later turn).
  {
    const corpus = new Corpus({ devLog: false })
    let responded = false
    let startedTitle: string | null | undefined = 'unset'
    const agent = {
      corpus,
      // title() hangs until its abort signal fires — mirrors a real provider
      // fetch that only unwinds when the deadline aborts the signal.
      thalamus: {
        title: (_msg: string, _system: string, signal?: AbortSignal): Promise<{ text: string }> =>
          new Promise((_resolve, reject) => {
            if (signal?.aborted) return reject(new Error('aborted'))
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
      },
      motor: { stopTask: async (): Promise<void> => undefined },
      respond: async (): Promise<unknown> => {
        responded = true
        return { stopReason: 'end_turn' as const, toolCalls: 0 }
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = new TurnRunner(agent as any)
    runner.setTitleTimeout(30)
    runner.setLifecycleListener((ev) => {
      if (ev.phase === 'started') startedTitle = ev.title ?? null
    })
    const noopSink = (turnId: string): import('@main/channels/channel').TurnSink => ({
      channelId: 'electron',
      turnId,
      conversationId: 'conv_T',
      onSegment: () => undefined,
      onTurnEvent: () => undefined,
      onApprovalRequest: async () => 'denied' as const,
      onDone: () => undefined,
      onError: () => undefined,
      onCredentialBlocked: () => undefined
    })
    const h = runner.send({
      history: [{ role: 'user', content: 'hello with a hung titler' }],
      conversationId: 'conv_T',
      makeSink: ({ turnId }) => noopSink(turnId)
    })
    await h.done
    await waitFor(() => runner.activeTurnCount() === 0)
    ok('title-timeout: respond ran despite a hung titler', responded)
    ok('title-timeout: turn proceeded untitled', !startedTitle, String(startedTitle))
    ok('title-timeout: no turns left active', runner.activeTurnCount() === 0)
  }

  // ── 4. The target scenario: 3 in-app + 1 WhatsApp + 1 Telegram at once ──
  // Five concurrent turns through ONE runner: three via the real
  // ElectronChannel (distinct conversations) and two via runner.send with
  // channel-shaped sinks (per-chat sink objects, the way WhatsApp/Telegram
  // dispatch). All five must overlap, stream isolated ordered segments, and
  // complete gracefully.
  {
    const corpus = new Corpus({ devLog: false })
    const gates = new Map<string, ReturnType<typeof deferred<void>>>()
    const started = new Map<string, ReturnType<typeof deferred<void>>>()
    const TAGS = ['app1', 'app2', 'app3', 'wa', 'tg'] as const
    for (const tag of TAGS) {
      gates.set(tag, deferred<void>())
      started.set(tag, deferred<void>())
    }

    const agent = {
      corpus,
      thalamus: { title: async (): Promise<{ text: string }> => ({ text: 'Test Title' }) },
      motor: { stopTask: async (): Promise<void> => undefined },
      respond: async (turn: {
        turnId: string
        conversationId: string | null
        history: Array<{ content: string }>
        onSegment: (seg: {
          kind: string
          turnId: string
          segmentId: string
          delta?: string
          stopReason?: string
          iterationCount?: number
        }) => void
      }): Promise<unknown> => {
        const tag = turn.history[0]?.content ?? '?'
        corpus.emit('task.created', { taskId: `task_${tag}`, name: tag, stepsTotal: 1 })
        turn.onSegment({
          kind: 'text',
          turnId: turn.turnId,
          segmentId: 'seg_1',
          delta: `hello from ${tag} `
        })
        started.get(tag)?.resolve()
        await gates.get(tag)?.promise
        turn.onSegment({
          kind: 'text',
          turnId: turn.turnId,
          segmentId: 'seg_2',
          delta: `and goodbye from ${tag}`
        })
        turn.onSegment({
          kind: 'turn_end',
          turnId: turn.turnId,
          segmentId: 'seg_3',
          stopReason: 'end_turn',
          iterationCount: 1
        })
        return { stopReason: 'end_turn' as const, toolCalls: 0 }
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = new TurnRunner(agent as any)
    const lifecycle: Array<{ phase: string; conversationId: string | null; channel: string }> = []
    runner.setLifecycleListener((ev) =>
      lifecycle.push({ phase: ev.phase, conversationId: ev.conversationId, channel: ev.channel })
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channel = new ElectronChannel(agent as any, runner)
    const sender = makeSender()

    // Three in-app conversations through the real Electron channel.
    for (const tag of ['app1', 'app2', 'app3']) {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      channel.send(
        sender as any,
        {
          history: [{ role: 'user', content: tag }],
          conversationId: `conv_${tag}`
        } as any
      )
      /* eslint-enable @typescript-eslint/no-explicit-any */
    }
    // One WhatsApp-shaped and one Telegram-shaped turn: per-chat sinks that
    // accumulate segments, exactly how the channels persist them.
    const channelFeeds = new Map<string, string[]>()
    for (const [tag, channelId] of [
      ['wa', 'whatsapp'],
      ['tg', 'telegram']
    ] as const) {
      channelFeeds.set(tag, [])
      runner.send({
        history: [{ role: 'user', content: tag }],
        conversationId: `conv_${tag}`,
        channel: channelId,
        makeSink: ({ turnId }) => ({
          channelId,
          turnId,
          conversationId: `conv_${tag}`,
          onSegment: (seg) => {
            if (seg.kind === 'text') channelFeeds.get(tag)?.push(seg.delta)
          },
          onTurnEvent: () => undefined,
          onApprovalRequest: async () => 'denied' as const,
          onDone: () => channelFeeds.get(tag)?.push('<done>'),
          onError: (e) => channelFeeds.get(tag)?.push(`<error:${e}>`),
          onCredentialBlocked: () => undefined
        })
      })
    }

    // ALL FIVE turns must be in flight simultaneously before any completes.
    await Promise.all(TAGS.map((tag) => started.get(tag)!.promise))
    ok(
      'five-turn: all 5 turns (3 app + wa + tg) in flight simultaneously',
      runner.activeTurnCount() === 5,
      String(runner.activeTurnCount())
    )

    // Release in scrambled order; every turn must complete gracefully.
    for (const tag of ['wa', 'app2', 'tg', 'app1', 'app3']) {
      gates.get(tag)?.resolve()
    }
    await waitFor(() => runner.activeTurnCount() === 0)

    // In-app: each conversation's segments arrived whole, ordered, and only
    // under its own conversationId.
    for (const tag of ['app1', 'app2', 'app3']) {
      const segs = sender.sent.filter(
        (s) => s.channel === 'chat:segment' && s.payload.conversationId === `conv_${tag}`
      )
      const text = segs
        .map((s) => (s.payload as unknown as { delta?: string }).delta ?? '')
        .join('')
      ok(
        `five-turn: ${tag} feed is whole and uncontaminated`,
        text === `hello from ${tag} and goodbye from ${tag}`,
        text
      )
      const done = sender.sent.some(
        (s) => s.channel === 'chat:done' && s.payload.conversationId === `conv_${tag}`
      )
      ok(`five-turn: ${tag} completed gracefully`, done)
    }
    // Channels: same isolation through their own sinks.
    for (const tag of ['wa', 'tg']) {
      const feed = channelFeeds.get(tag)!.join('')
      ok(
        `five-turn: ${tag} feed is whole and uncontaminated`,
        feed === `hello from ${tag} and goodbye from ${tag}<done>`,
        feed
      )
    }
    // Lifecycle broadcast: 5 started + 5 done, each with its conversation.
    const startedEvents = lifecycle.filter((l) => l.phase === 'started')
    const doneEvents = lifecycle.filter((l) => l.phase === 'done')
    ok(
      'five-turn: lifecycle broadcast saw 5 starts and 5 clean completions',
      startedEvents.length === 5 && doneEvents.length === 5,
      JSON.stringify({ started: startedEvents.length, done: doneEvents.length })
    )
    ok(
      'five-turn: lifecycle events carry channel identities',
      new Set(startedEvents.map((l) => l.channel)).size === 3
    )
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

void run()
