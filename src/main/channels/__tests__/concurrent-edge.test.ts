/**
 * End-to-end edge-case tests for CONCURRENT multi-conversation turns, driving
 * the REAL main-process stack — Corpus (turnScope), TurnRunner (per-conversation
 * lanes, titling, lifecycle, keyed relay), turnRouter, ElectronChannel
 * (multi-turn), the conversation titler, and the conversations persistence
 * layer (updateConversation / mergeConversationOnto). Only the LLM `respond`
 * and the model `title` call are stubbed.
 *
 * These cover edge cases the turn-isolation suite doesn't: cancel-one-of-many,
 * error isolation, titling concurrency + title-first ordering + shell/renderer
 * merge, three-writer persistence merge, concurrent distinct-conversation
 * persistence, and the delete-while-active guard.
 *
 * Redirects the workspace to a temp home BEFORE loading the runtime graph so
 * nothing touches the real ~/.wolffish workspace.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/channels/__tests__/concurrent-edge.test.ts
 */

import fs from 'node:fs'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-cedge-'))
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
async function waitFor(cond: () => boolean, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return
    await tick()
  }
  throw new Error('waitFor timed out')
}
function deferred<T = void>(): { promise: Promise<T>; resolve: (v?: T) => void } {
  let resolve!: (v?: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r as (v?: T) => void
  })
  return { promise, resolve }
}

type Sent = { channel: string; payload: Record<string, unknown> }
function makeSender(): {
  sent: Sent[]
  isDestroyed: () => boolean
  send: (c: string, p: unknown) => void
} {
  const sent: Sent[] = []
  return {
    sent,
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) =>
      sent.push({ channel, payload: payload as Sent['payload'] })
  }
}

/** Per-conversation script the fake respond plays out. */
type Script = {
  gate?: Promise<void>
  throwAfterGate?: string
  requestApproval?: boolean
  approvalOutcome?: (d: string) => void
}

async function run(): Promise<void> {
  const { Corpus, runDetached } = await import('@main/runtime/corpus')
  const { TurnRunner } = await import('@main/channels/turn-runner')
  const { turnRouter } = await import('@main/channels/channel')
  const { ElectronChannel } = await import('@main/channels/electron/channel')
  const {
    loadConversation,
    updateConversation,
    mergeConversationOnto,
    createConversation,
    deleteConversation
  } = await import('@main/conversations')

  const stoppedTasks: string[] = []
  const scripts = new Map<string, Script>()
  const respondStarted = new Map<string, ReturnType<typeof deferred>>()

  const corpus = new Corpus({ devLog: false })
  const agent = {
    corpus,
    thalamus: {
      // Titling is now a dedicated title() call: the user's message is the
      // first arg (the titling instructions ride in the system prompt), so the
      // stub echoes a deterministic title straight from that message.
      title: async (userMessage: string): Promise<{ text: string }> => {
        const msg = userMessage.trim().slice(0, 20)
        return { text: `Title ${msg}` }
      }
    },
    motor: {
      stopTask: async (id: string): Promise<void> => {
        stoppedTasks.push(id)
      }
    },
    respond: async (turn: {
      turnId: string
      conversationId: string | null
      history: Array<{ content: string }>
      signal?: AbortSignal
      onSegment: (s: Record<string, unknown>) => void
    }): Promise<{ stopReason: string; toolCalls: number }> => {
      const tag = String(turn.history[turn.history.length - 1]?.content ?? '')
      const script = scripts.get(tag) ?? {}
      corpus.emit('task.created', { taskId: `task_${tag}`, name: tag, stepsTotal: 1 })
      turn.onSegment({ kind: 'text', turnId: turn.turnId, segmentId: 'seg_1', delta: `A[${tag}] ` })
      respondStarted.get(tag)?.resolve()
      if (script.requestApproval) {
        const decision = await turnRouter.dispatchApproval({
          id: `apr_${tag}`,
          toolCall: { id: `call_${tag}`, name: `tool_${tag}`, args: {} },
          level: 'confirm' as const,
          reason: 'test'
        })
        script.approvalOutcome?.(decision)
      }
      if (script.gate) await script.gate
      if (turn.signal?.aborted) {
        turn.onSegment({
          kind: 'turn_end',
          turnId: turn.turnId,
          segmentId: 'seg_2',
          stopReason: 'end_turn',
          iterationCount: 1
        })
        return { stopReason: 'canceled', toolCalls: 0 }
      }
      if (script.throwAfterGate) throw new Error(script.throwAfterGate)
      turn.onSegment({ kind: 'text', turnId: turn.turnId, segmentId: 'seg_3', delta: `B[${tag}]` })
      turn.onSegment({
        kind: 'turn_end',
        turnId: turn.turnId,
        segmentId: 'seg_4',
        stopReason: 'end_turn',
        iterationCount: 1
      })
      return { stopReason: 'end_turn', toolCalls: 0 }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runner = new TurnRunner(agent as any)
  const lifecycle: Array<{ phase: string; conversationId: string | null }> = []
  runner.setLifecycleListener((ev) =>
    lifecycle.push({ phase: ev.phase, conversationId: ev.conversationId })
  )
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channel = new ElectronChannel(agent as any, runner)
  const sender = makeSender()
  const send = (conversationId: string, content: string): { turnId: string } =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    channel.send(sender as any, { history: [{ role: 'user', content }], conversationId } as any)
  // ElectronChannel.send returns only {turnId,ok}; await completion via the
  // runner's active-turn accounting (decremented when a turn's lane settles).
  const awaitIdle = (): Promise<void> => waitFor(() => runner.activeTurnCount() === 0)
  const awaitConv = (cid: string): Promise<void> => waitFor(() => !runner.isConversationActive(cid))

  // ── 1. Cancel ONE of three concurrent conversations — others complete ───
  {
    for (const tag of ['c1a', 'c1b', 'c1c']) {
      scripts.set(tag, { gate: deferred().promise })
      respondStarted.set(tag, deferred())
    }
    const gates = new Map(['c1a', 'c1b', 'c1c'].map((t) => [t, deferred()]))
    for (const t of ['c1a', 'c1b', 'c1c']) scripts.set(t, { gate: gates.get(t)!.promise })
    for (const t of ['c1a', 'c1b', 'c1c']) send(`conv_${t}`, t)
    await Promise.all(['c1a', 'c1b', 'c1c'].map((t) => respondStarted.get(t)!.promise))
    ok(
      'cancel-one: all 3 conversations in flight',
      runner.activeTurnCount() === 3,
      String(runner.activeTurnCount())
    )

    // Cancel only conv_c1b.
    await channel.cancel('conv_c1b')
    ok(
      'cancel-one: only c1b task stopped',
      stoppedTasks.length === 1 && stoppedTasks[0] === 'task_c1b',
      JSON.stringify(stoppedTasks)
    )
    ok(
      'cancel-one: c1a and c1c still active',
      runner.isConversationActive('conv_c1a') && runner.isConversationActive('conv_c1c')
    )

    // Open all gates; c1b was aborted so its respond returns canceled.
    for (const g of gates.values()) g.resolve()
    await awaitIdle()

    const done = (t: string): boolean =>
      sender.sent.some((s) => s.channel === 'chat:done' && s.payload.conversationId === `conv_${t}`)
    ok('cancel-one: c1a completed', done('c1a'))
    ok('cancel-one: c1c completed', done('c1c'))
    const c1aText = sender.sent
      .filter((s) => s.channel === 'chat:segment' && s.payload.conversationId === 'conv_c1a')
      .map((s) => (s.payload as { delta?: string }).delta ?? '')
      .join('')
    ok('cancel-one: c1a transcript intact & uncontaminated', c1aText === 'A[c1a] B[c1a]', c1aText)
    ok(
      'cancel-one: c1b lifecycle is canceled (not done)',
      lifecycle.some((l) => l.conversationId === 'conv_c1b' && l.phase === 'canceled') &&
        !lifecycle.some((l) => l.conversationId === 'conv_c1b' && l.phase === 'done')
    )
  }

  // ── 2. Error in one conversation — the others complete cleanly ──────────
  {
    lifecycle.length = 0
    const gates = new Map(['e1', 'e2', 'e3'].map((t) => [t, deferred()]))
    for (const t of ['e1', 'e2', 'e3']) {
      respondStarted.set(t, deferred())
      scripts.set(t, {
        gate: gates.get(t)!.promise,
        ...(t === 'e2' ? { throwAfterGate: 'boom' } : {})
      })
    }
    for (const t of ['e1', 'e2', 'e3']) send(`conv_${t}`, t)
    await Promise.all(['e1', 'e2', 'e3'].map((t) => respondStarted.get(t)!.promise))
    for (const g of gates.values()) g.resolve()
    await awaitIdle()

    const err = sender.sent.some(
      (s) => s.channel === 'chat:error' && s.payload.conversationId === 'conv_e2'
    )
    ok('error-iso: e2 got chat:error', err)
    ok(
      'error-iso: e2 lifecycle error',
      lifecycle.some((l) => l.conversationId === 'conv_e2' && l.phase === 'error')
    )
    ok(
      'error-iso: e1 and e3 completed (unaffected by e2 throwing)',
      sender.sent.some(
        (s) => s.channel === 'chat:done' && s.payload.conversationId === 'conv_e1'
      ) &&
        sender.sent.some((s) => s.channel === 'chat:done' && s.payload.conversationId === 'conv_e3')
    )
    const e3Text = sender.sent
      .filter((s) => s.channel === 'chat:segment' && s.payload.conversationId === 'conv_e3')
      .map((s) => (s.payload as { delta?: string }).delta ?? '')
      .join('')
    ok('error-iso: e3 transcript whole & uncontaminated', e3Text === 'A[e3] B[e3]', e3Text)
  }

  // ── 3. Concurrent approvals across 3 conversations resolve to their own ─
  {
    const seen: Array<{ tag: string; decision: string }> = []
    const gates = new Map(['a1', 'a2', 'a3'].map((t) => [t, deferred()]))
    for (const t of ['a1', 'a2', 'a3']) {
      respondStarted.set(t, deferred())
      scripts.set(t, {
        gate: gates.get(t)!.promise,
        requestApproval: true,
        approvalOutcome: (d) => seen.push({ tag: t, decision: d })
      })
    }
    for (const t of ['a1', 'a2', 'a3']) send(`conv_${t}`, t)
    await Promise.all(['a1', 'a2', 'a3'].map((t) => respondStarted.get(t)!.promise))
    await waitFor(() => sender.sent.filter((s) => s.channel === 'chat:approvalRequest').length >= 3)
    const cards = sender.sent.filter((s) => s.channel === 'chat:approvalRequest')
    // Each card is stamped with its own conversation.
    for (const t of ['a1', 'a2', 'a3']) {
      const card = cards.find((c) => c.payload.id === `apr_${t}`)
      ok(
        `approvals: ${t} card stamped with its conversation`,
        card?.payload.conversationId === `conv_${t}`,
        JSON.stringify(card?.payload)
      )
    }
    // Answer: a1 approved, a2 denied, a3 approved.
    channel.respondApproval({ id: 'apr_a1', decision: 'approved' })
    channel.respondApproval({ id: 'apr_a2', decision: 'denied' })
    channel.respondApproval({ id: 'apr_a3', decision: 'approved' })
    await waitFor(() => seen.length === 3)
    ok(
      'approvals: each decision landed on the requesting conversation',
      seen.find((s) => s.tag === 'a1')?.decision === 'approved' &&
        seen.find((s) => s.tag === 'a2')?.decision === 'denied' &&
        seen.find((s) => s.tag === 'a3')?.decision === 'approved',
      JSON.stringify(seen)
    )
    for (const g of gates.values()) g.resolve()
    await awaitIdle()
  }

  // ── 4. Titling: two NEW conversations title concurrently, both persisted,
  //     title-first (on disk BEFORE the turn's own segments would persist) ──
  {
    // The fake respond keys on the message content, so key the fixtures on it.
    const msgs = ['hello t1', 'hello t2']
    const gates = new Map(msgs.map((m) => [m, deferred()]))
    for (const m of msgs) {
      respondStarted.set(m, deferred())
      scripts.set(m, { gate: gates.get(m)!.promise })
    }
    send('conv_t1', 'hello t1')
    send('conv_t2', 'hello t2')
    // The titler runs (and persists the shell) BEFORE respond starts — so by
    // the time respond has started, the title is already on disk.
    await Promise.all(msgs.map((m) => respondStarted.get(m)!.promise))
    const c1 = await loadConversation('conv_t1')
    const c2 = await loadConversation('conv_t2')
    ok(
      'titling: conv_t1 persisted with LLM title before processing',
      c1?.title === 'Title hello t1',
      c1?.title
    )
    ok(
      'titling: conv_t2 persisted with a DISTINCT title',
      c2?.title === 'Title hello t2',
      c2?.title
    )
    ok(
      'titling: shells carry the user message',
      c1?.messages.length === 1 && c1?.messages[0].role === 'user'
    )
    for (const g of gates.values()) g.resolve()
    await awaitIdle()
  }

  // ── 5. Titled shell + a renderer-style whole-file save merge ────────────
  //     (renderer messages win; the LLM title on disk survives an 'Untitled')
  {
    const disk = await loadConversation('conv_t1')
    ok('merge-precond: disk has LLM title', disk?.title === 'Title hello t1')
    const rendererCopy = {
      ...createConversation(null),
      id: 'conv_t1',
      title: 'Untitled', // renderer never titles now
      messages: [
        { role: 'user' as const, content: 'hello t1', timestamp: 1 },
        { role: 'assistant' as const, content: 'reply', timestamp: 2 }
      ]
    }
    await updateConversation('conv_t1', (d) => mergeConversationOnto(d, rendererCopy))
    const merged = await loadConversation('conv_t1')
    ok(
      'merge: LLM title survives the renderer Untitled save',
      merged?.title === 'Title hello t1',
      merged?.title
    )
    ok(
      'merge: renderer messages win (2 messages)',
      merged?.messages.length === 2,
      String(merged?.messages.length)
    )
  }

  // ── 6. Three-writer merge on ONE conversation: renderer save + summarizer
  //     summary + a later title — all three fields preserved, no clobber ──
  {
    // Summarizer advances the rolling summary on disk.
    await updateConversation('conv_t1', (d) => {
      if (!d) return null
      d.summary = 'rolling summary'
      d.summarizedThroughMessage = 1
      return d
    })
    // Renderer saves again with a fresh message list but no summary and Untitled.
    const rendererCopy2 = {
      ...createConversation(null),
      id: 'conv_t1',
      title: 'Untitled',
      messages: [
        { role: 'user' as const, content: 'hello t1', timestamp: 1 },
        { role: 'assistant' as const, content: 'reply', timestamp: 2 },
        { role: 'user' as const, content: 'follow up', timestamp: 3 }
      ]
    }
    await updateConversation('conv_t1', (d) => mergeConversationOnto(d, rendererCopy2))
    const m = await loadConversation('conv_t1')
    ok('3-writer: title preserved', m?.title === 'Title hello t1', m?.title)
    ok('3-writer: summary preserved', m?.summary === 'rolling summary', m?.summary ?? '(none)')
    ok(
      '3-writer: renderer messages present (3)',
      m?.messages.length === 3,
      String(m?.messages.length)
    )
  }

  // ── 7. Concurrent persistence to N DIFFERENT conversations — no clobber ─
  {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => {
        const conv = { ...createConversation(null), id: `conv_p${i}`, title: `P${i}` }
        conv.messages.push({ role: 'user', content: `m${i}`, timestamp: i })
        return updateConversation(conv.id, () => conv)
      })
    )
    const loaded = await Promise.all(
      Array.from({ length: 12 }, (_, i) => loadConversation(`conv_p${i}`))
    )
    ok(
      'concurrent-persist: all 12 distinct conversations intact',
      loaded.every((c, i) => c?.title === `P${i}` && c?.messages[0]?.content === `m${i}`),
      loaded.map((c) => c?.title).join(',')
    )
  }

  // ── 8. Delete guard: cannot delete a conversation with an active turn ────
  {
    const gate = deferred()
    respondStarted.set('del', deferred())
    scripts.set('del', { gate: gate.promise })
    send('conv_del', 'del')
    await respondStarted.get('del')!.promise
    ok(
      'delete-guard: conversation reported active while its turn runs',
      runner.isConversationActive('conv_del')
    )
    // (index.ts refuses conversation:delete when isConversationActive — assert the signal it keys on.)
    gate.resolve()
    await awaitConv('conv_del')
    ok('delete-guard: no longer active after completion', !runner.isConversationActive('conv_del'))
    await deleteConversation('conv_del')
    ok('delete-guard: delete succeeds once inactive', (await loadConversation('conv_del')) === null)
  }

  // ── 9. A detached/autonomous burst never leaks into a live turn's sink ──
  {
    const gate = deferred()
    respondStarted.set('leak', deferred())
    scripts.set('leak', { gate: gate.promise })
    send('conv_leak', 'leak')
    await respondStarted.get('leak')!.promise
    // Simulate a heartbeat/procedure autonomous run emitting on the shared bus.
    runDetached(() => {
      corpus.emit('task.created', { taskId: 'auto_hb', name: 'hb', stepsTotal: 1 })
      corpus.emit('llm.response', {
        provider: 'auto',
        model: 'auto',
        role: 'brain',
        inputTokens: 424242,
        outputTokens: 1,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        durationMs: 1
      })
    })
    await tick()
    const leakEvents = sender.sent.filter(
      (s) => s.channel === 'chat:turnEvent' && s.payload.conversationId === 'conv_leak'
    )
    const blob = JSON.stringify(leakEvents)
    ok(
      'autonomous-leak: heartbeat task did not reach the live turn',
      !blob.includes('auto_hb'),
      blob
    )
    ok('autonomous-leak: heartbeat tokens did not reach the live turn', !blob.includes('424242'))
    gate.resolve()
    await awaitConv('conv_leak')
  }

  // ── 10. Lifecycle roll-up: every turn emits started + exactly one terminal
  {
    // Aggregate over the whole run: for each conversation, count started and
    // terminal (done|canceled|error) events. Each must be started once and end
    // exactly once, with no conversation ending more than once.
    const byConv = new Map<string, { started: number; terminal: number }>()
    for (const l of lifecycle) {
      const c = byConv.get(l.conversationId ?? '') ?? { started: 0, terminal: 0 }
      if (l.phase === 'started') c.started++
      if (l.phase === 'done' || l.phase === 'canceled' || l.phase === 'error') c.terminal++
      byConv.set(l.conversationId ?? '', c)
    }
    const wellFormed = [...byConv.values()].every((c) => c.started === 1 && c.terminal === 1)
    ok(
      'lifecycle: every conversation started once and ended exactly once',
      wellFormed,
      JSON.stringify([...byConv.entries()])
    )
  }

  await corpus.stop().catch(() => undefined)
  await fs.promises.rm(TEST_HOME, { recursive: true, force: true }).catch(() => undefined)
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

run().catch((e) => {
  console.error('run() threw:', e)
  process.exit(1)
})
