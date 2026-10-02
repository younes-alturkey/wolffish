/**
 * A mid-turn user message is never dropped.
 *
 * Before this, an accepted message lived in exactly two volatile places — the
 * TurnRunner's in-memory inbox and the sending surface's optimistic row — and
 * every way of losing both at once lost the user's words with no trace on any
 * screen: a desktop that quit or crashed before the agent read it, a turn that
 * ended in the sliver before the last drain while the phone was backgrounded
 * or off the tunnel, a Stop nobody was connected to hear, a delivery whose
 * segment never reached the transcript.
 *
 * What is pinned here is the INVARIANT, not any one of those paths: an
 * accepted message is, at every instant, either in the live inbox, parked on
 * disk, or present in the transcript — and it leaves the park only by finding
 * a home or by the user taking it back.
 *
 * Exercises the REAL TurnRunner, the REAL park (a temp homedir, diskWriter and
 * all) and the REAL reconciler, with a stubbed agent. Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/channels/__tests__/interjection-durability.test.ts
 */

import fs from 'node:fs'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-interject-durable-'))
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
    console.log(`✅ ${label}`)
    return
  }
  failed++
  console.error(`❌ ${label}${detail ? `: ${detail}` : ''}`)
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
async function settle(cond: () => Promise<boolean>, tries = 400): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await cond()) return true
    await tick()
  }
  return false
}
async function waitFor(cond: () => boolean, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return
    await tick()
  }
  throw new Error('waitFor timed out')
}

async function main(): Promise<void> {
  const { TurnRunner } = await import('@main/channels/turn-runner')
  const store = await import('@main/channels/interjection-store')
  const reconciler = await import('@main/channels/interjection-reconciler')
  const { saveConversation, loadConversation, createConversation } =
    await import('@main/conversations')
  const { fitMirrorMessage } = await import('@main/channels/mirror-budget')
  const { mintMessageId } = await import('@main/conversations')

  // ── A stubbed agent that parks inside respond() until released ───────────
  // Same shape as interjection-runner.test.ts: respond takes ONE options bag
  // and the test plays the loop's stop point by calling the threaded pull.
  const { Corpus } = await import('@main/runtime/corpus')
  const corpus = new Corpus({ devLog: false })
  type Item = import('@main/runtime/agent/interjection').Interjection
  let gate = deferred<void>()
  let started = deferred<void>()
  let drain: (() => Item[]) | null = null
  let sawInterjections: Item[] = []
  // The sliver race: a turn that ends WITHOUT ever reaching a stop point, so
  // the inbox is never drained and the lane's sweep is what finds the message.
  let skipDrain = false
  const agent = {
    corpus,
    respond: async (turn: {
      signal?: AbortSignal
      takeInterjections?: () => Item[]
    }): Promise<unknown> => {
      drain = turn.takeInterjections ?? null
      started.resolve()
      turn.signal?.addEventListener('abort', () => gate.resolve())
      await gate.promise
      sawInterjections = skipDrain ? [] : (drain?.() ?? [])
      return turn.signal?.aborted
        ? { stopReason: 'canceled' as const, toolCalls: 0 }
        : { stopReason: 'end_turn' as const, toolCalls: 0 }
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runner = new TurnRunner(agent as any)
  runner.setTitleTimeout(10)

  const sink = (turnId: string, conversationId: string | null): Record<string, unknown> => ({
    channelId: 'mobile',
    turnId,
    conversationId,
    onSegment: () => undefined,
    onTurnEvent: () => undefined,
    onApprovalRequest: async () => 'denied',
    onAskUserRequest: async () => ({ kind: 'unsupported' }),
    onDone: () => undefined,
    onError: () => undefined,
    onCredentialBlocked: () => undefined
  })

  const deps: import('@main/channels/interjection-reconciler').ReconcilerDeps = {
    isConversationActive: (id) => runner.isConversationActive(id),
    liveInboxIds: (id) => runner.liveInterjectionIds(id),
    log: () => undefined
  }

  const item = (text: string): Parameters<typeof runner.interject>[1] => ({
    messageId: mintMessageId(),
    text,
    attachments: [],
    channel: 'mobile',
    sentAt: Date.now()
  })

  // ── 1. Accepting parks it on disk BEFORE the sender is told ──────────────
  const convA = await createConversation('test-model')
  await saveConversation(convA)
  gate = deferred<void>()
  started = deferred<void>()
  let handle = runner.send({
    history: [{ role: 'user', content: 'go' }],
    conversationId: convA.id,
    makeSink: ({ turnId, conversationId }) => sink(turnId, conversationId ?? null) as never
  })
  await started.promise

  const first = item('ACTUALLY use the other file')
  const result = runner.interject(convA.id, first)
  ok('accepted while a turn runs', result.status === 'pending')
  if (result.status === 'pending') await result.durable
  let parked = await store.parkedInterjections(convA.id)
  ok(
    'parked on disk at accept — survives a crash from this instant on',
    parked.length === 1 && parked[0].messageId === first.messageId,
    JSON.stringify(parked)
  )

  // ── 2. Delivery alone does NOT release it — the transcript must prove it ──
  gate.resolve()
  await handle.done.catch(() => undefined)
  await waitFor(() => sawInterjections.length === 1)
  ok('the agent read it', sawInterjections[0]?.messageId === first.messageId)
  await settle(async () => {
    const list = await store.parkedInterjections(convA.id)
    return list[0]?.state === 'delivered'
  })
  parked = await store.parkedInterjections(convA.id)
  ok(
    'still parked after delivery — no transcript proof yet',
    parked.length === 1 && parked[0].state === 'delivered',
    JSON.stringify(parked)
  )

  // ── 3. The reconciler releases it once the segment is on disk ────────────
  await reconciler.reconcileConversation(convA.id, deps)
  parked = await store.parkedInterjections(convA.id)
  ok('a delivered message with no segment yet is kept, not released', parked.length === 1)

  const withSegment = await loadConversation(convA.id)
  if (!withSegment) throw new Error('conversation vanished')
  withSegment.messages.push({
    id: mintMessageId(),
    role: 'assistant',
    content: 'done',
    timestamp: Date.now(),
    segments: [
      {
        kind: 'user_message',
        turnId: 't',
        segmentId: 's1',
        messageId: first.messageId,
        text: first.text,
        timestamp: Date.now()
      }
    ]
  } as never)
  await saveConversation(withSegment)
  await reconciler.reconcileConversation(convA.id, deps)
  parked = await store.parkedInterjections(convA.id)
  ok('released once the user_message segment is in the transcript', parked.length === 0)

  // ── 4. Never read, turn over: the reconciler re-sends it as a turn ───────
  const convB = await createConversation('test-model')
  await saveConversation(convB)
  gate = deferred<void>()
  started = deferred<void>()
  handle = runner.send({
    history: [{ role: 'user', content: 'go' }],
    conversationId: convB.id,
    makeSink: ({ turnId, conversationId }) => sink(turnId, conversationId ?? null) as never
  })
  await started.promise
  const orphan = item('and skip the tests folder')
  const accepted = runner.interject(convB.id, orphan)
  if (accepted.status === 'pending') await accepted.durable
  // The turn ends without ever reaching a stop point — the real sliver race —
  // so the lane's end-of-turn sweep is what finds the message.
  skipDrain = true
  gate.resolve()
  await handle.done.catch(() => undefined)
  await waitFor(() => !runner.isConversationActive(convB.id))
  const swept = await settle(async () => {
    const list = await store.parkedInterjections(convB.id)
    return list[0]?.reason === 'turn_ended'
  })
  ok('the lane sweep records an unread message as turn_ended, still parked', swept)
  skipDrain = false

  const dispatched: string[] = []
  const off = reconciler.registerInterjectionDispatcher('mobile', async (parkedItem) => {
    dispatched.push(parkedItem.messageId)
    // What a real dispatcher does first: persist the message as a real user
    // message, then start a turn.
    const conv = await loadConversation(convB.id)
    if (!conv) return false
    conv.messages.push({
      id: parkedItem.messageId,
      role: 'user',
      content: parkedItem.text,
      timestamp: Date.now()
    } as never)
    await saveConversation(conv)
    return true
  })
  await reconciler.reconcileConversation(convB.id, deps)
  ok('an unread message is re-sent as a fresh turn', dispatched[0] === orphan.messageId)
  ok(
    'released once the dispatcher owns it',
    (await store.parkedInterjections(convB.id)).length === 0
  )

  // ── 4b. The park's fast path answers from memory once it knows ──────────
  // The reconciler is woken by every conversation save — including the
  // mid-turn checkpoint's, up to one per 750ms through a long run — and the
  // park is empty in nearly all of them. Those wake-ups must not each be a
  // file read.
  const fsp = await import('node:fs/promises')
  const quiet = await createConversation('test-model')
  await saveConversation(quiet)
  let reads = 0
  const realRead = fsp.default.readFile
  ;(fsp.default as unknown as { readFile: unknown }).readFile = ((...a: unknown[]) => {
    if (typeof a[0] === 'string' && a[0].endsWith('interjections.json')) reads++
    return (realRead as (...x: unknown[]) => unknown)(...a)
  }) as typeof realRead
  for (let i = 0; i < 20; i++) await reconciler.reconcileConversation(quiet.id, deps)
  ;(fsp.default as unknown as { readFile: unknown }).readFile = realRead
  ok('20 wake-ups on a conversation with nothing parked cost no reads', reads === 0, `${reads}`)

  // ── 5. A refused dispatch KEEPS the message — a retry, never a loss ──────
  off()
  const convC = await createConversation('test-model')
  await saveConversation(convC)
  const stubborn = item('one more thing')
  await store.parkInterjection(convC.id, stubborn)
  await store.markInterjectionWithdrawn(convC.id, stubborn.messageId, 'error')
  let refusals = 0
  const offRefuse = reconciler.registerInterjectionDispatcher('mobile', async () => {
    refusals++
    return false
  })
  await reconciler.reconcileConversation(convC.id, deps)
  // Not on every save: a channel that is down must not be hammered once per
  // transcript write for as long as the app runs.
  await reconciler.reconcileConversation(convC.id, deps)
  ok('a refused dispatch is not retried immediately', refusals === 1)
  reconciler.setInterjectionRetryInterval(0)
  await reconciler.reconcileConversation(convC.id, deps)
  ok('a refused dispatch is retried once the gap has passed', refusals === 2)
  reconciler.setInterjectionRetryInterval(15_000)
  ok(
    'and the message stays parked through every refusal',
    (await store.parkedInterjections(convC.id)).length === 1
  )
  offRefuse()

  // ── 6. A STOPPED run holds its message — never resent, never destroyed ───
  const convD = await createConversation('test-model')
  await saveConversation(convD)
  const stopped = item('wait, cancel that')
  await store.parkInterjection(convD.id, stopped)
  await store.markInterjectionWithdrawn(convD.id, stopped.messageId, 'canceled')
  let dispatchedAfterStop = 0
  const offStop = reconciler.registerInterjectionDispatcher('mobile', async () => {
    dispatchedAfterStop++
    return true
  })
  await reconciler.reconcileConversation(convD.id, deps)
  ok('a stopped run never auto-resends its message', dispatchedAfterStop === 0)
  ok(
    'but the words are still there for the next surface that opens the chat',
    (await store.parkedInterjections(convD.id)).length === 1
  )
  ok(
    'and only a held message can be released that way',
    (await store.releaseHeldInterjection(convD.id, stopped.messageId)) === true &&
      (await store.parkedInterjections(convD.id)).length === 0
  )
  offStop()

  // ── 6b. No dispatcher at all: HELD, not left live and unseen ────────────
  // The in-app composer and the terminal register no dispatcher (their own
  // windows re-send while open), and the phone's is gone while its channel is
  // stopped. A message nothing can re-send must still come back to a person.
  const convF = await createConversation('test-model')
  await saveConversation(convF)
  const orphanChannel = {
    ...item('from a surface that cannot re-send'),
    channel: 'electron' as const
  }
  await store.parkInterjection(convF.id, orphanChannel)
  await store.markInterjectionWithdrawn(convF.id, orphanChannel.messageId, 'turn_ended')
  await reconciler.reconcileConversation(convF.id, deps)
  const orphaned = await store.parkedInterjections(convF.id)
  ok(
    'a message with no dispatcher is HELD, not left live',
    orphaned.length === 1 && orphaned[0].disposition === 'held',
    JSON.stringify(orphaned.map((i) => i.disposition))
  )
  ok(
    'and is therefore offered back to the next surface that opens the chat',
    (await store.releaseHeldInterjection(convF.id, orphanChannel.messageId)) === true
  )
  ok('which is what finally lets it go', (await store.parkedInterjections(convF.id)).length === 0)

  // ── 7. A deliberate withdraw is the one release that needs no home ───────
  const convE = await createConversation('test-model')
  await saveConversation(convE)
  gate = deferred<void>()
  started = deferred<void>()
  handle = runner.send({
    history: [{ role: 'user', content: 'go' }],
    conversationId: convE.id,
    makeSink: ({ turnId, conversationId }) => sink(turnId, conversationId ?? null) as never
  })
  await started.promise
  const unsent = item('never mind')
  const unsentResult = runner.interject(convE.id, unsent)
  if (unsentResult.status === 'pending') await unsentResult.durable
  ok('taken back', runner.withdrawInterjection(convE.id, unsent.messageId, 'user'))
  ok(
    'a withdrawn message leaves the park — the user unsent it',
    await settle(async () => (await store.parkedInterjections(convE.id)).length === 0)
  )
  gate.resolve()
  await handle.done.catch(() => undefined)

  // ── 8. The wire trimmer may never delete what the user said ──────────────
  const segments: unknown[] = [
    {
      kind: 'user_message',
      turnId: 't',
      segmentId: 'u1',
      messageId: 'm_1_aaaaaa',
      text: 'use the other file',
      timestamp: 1
    }
  ]
  for (let i = 0; i < 4000; i++) {
    segments.push({
      kind: 'tool_call',
      turnId: 't',
      segmentId: `c${i}`,
      toolCallId: `tc${i}`,
      name: 'shell',
      args: { command: 'x'.repeat(500) }
    })
    segments.push({
      kind: 'tool_result',
      turnId: 't',
      segmentId: `r${i}`,
      toolCallId: `tc${i}`,
      status: 'ok',
      output: 'x'.repeat(500)
    })
  }
  const huge = {
    id: 'a1',
    role: 'assistant' as const,
    content: 'done',
    timestamp: 2,
    segments
  }
  let survivedEvery = true
  for (const cap of [1024 * 1024, 256 * 1024, 64 * 1024, 16 * 1024]) {
    const fitted = fitMirrorMessage(huge as never, cap)
    const kept = (fitted?.segments ?? []).filter((s) => s.kind === 'user_message').length
    if (kept !== 1) survivedEvery = false
  }
  ok('the user’s mid-turn message survives the wire trimmer at every budget', survivedEvery)

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
