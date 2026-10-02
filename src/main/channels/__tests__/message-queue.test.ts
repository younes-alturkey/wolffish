/**
 * Channel mid-turn messages on Telegram: INTERJECT FIRST (the message joins
 * the running turn through TurnRunner.interject), with the sliver queue in
 * channels/message-queue.ts kept only for the pre-send window where the chat
 * is marked busy but the runner has no lane yet.
 *
 * Two layers under test:
 *  - ChannelMessageQueue + its copy helpers (pure unit).
 *  - The REAL TelegramChannel driven against a REAL TurnRunner, with only
 *    agent.respond / thalamus.title and the grammY bot api stubbed. That is
 *    where the bugs actually live: the turn-ended sweep fires while the
 *    finished lane is still counted, the flush rides the same end-of-turn
 *    cleanup that releases the per-chat slot, and it has to survive the
 *    microtask window where the slot is free but the runner lane is not.
 *
 * Covers: a busy chat with a live lane interjects and queues nothing; the
 * turn drains the message when it reads its inbox (no re-dispatch); a turn
 * that never read it hands it back (turn_ended) and the channel re-runs it
 * as a fresh turn in order; media riding an interjection / the sliver queue
 * onto the persisted user message; /cancel withdraws pending interjections;
 * /stop reports the unread message and does NOT resend it; a busy chat with
 * NO lane parks in the sliver queue and its flush interjects first; the
 * queue is cleared on /new; and the two regressions (no "still busy" cry on a
 * long healthy turn, a rejected render chain still releases the chat).
 *
 * Redirects the workspace to a temp home BEFORE loading the runtime graph so
 * nothing touches the real ~/.wolffish workspace.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/channels/__tests__/message-queue.test.ts
 */

import fs from 'node:fs'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-mqueue-'))
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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, label: string, tries = 2000): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return
    await tick()
  }
  throw new Error(`waitFor timed out: ${label}`)
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r as () => void
  })
  return { promise, resolve }
}

const CHAT_ID = 4242
const USER_ID = 7

async function run(): Promise<void> {
  // ── Layer 1: the queue container + copy ────────────────────────────────
  {
    const {
      ChannelMessageQueue,
      queuedAckText,
      queueClearedText,
      queueEmptyText,
      queuePendingNote,
      unreadAfterStopText
    } = await import('@main/channels/message-queue')
    const { interjectionAckText } = await import('@main/runtime/agent/interjection')

    type Item = { id: string; text: string; attachments: [] }
    const q = new ChannelMessageQueue<number, Item>()
    const mk = (t: string): Item => ({ id: t, text: t, attachments: [] })

    ok('queue: empty size 0', q.size(1) === 0)
    ok('queue: enqueue returns depth 1', q.enqueue(1, mk('a')) === 1)
    ok('queue: enqueue returns depth 2', q.enqueue(1, mk('b')) === 2)
    ok('queue: other key isolated', q.size(2) === 0)
    ok('queue: FIFO head is a', q.shift(1)?.text === 'a')
    q.requeue(1, mk('a'))
    ok('queue: requeue restores head', q.shift(1)?.text === 'a', 'requeue must unshift, not push')
    ok('queue: b still queued', q.size(1) === 1)
    ok('queue: clear reports count', q.clear(1) === 1)
    ok('queue: clear empties', q.size(1) === 0)
    ok('queue: shift on empty is undefined', q.shift(1) === undefined)
    q.enqueue(9, mk('z'))
    q.clearAll()
    ok('queue: clearAll wipes every key', q.size(9) === 0)

    // The sliver ack IS the interject ack — one promise, two carriers.
    ok('copy: sliver ack = interject ack', queuedAckText(0) === interjectionAckText(0))
    ok('copy: ack says got it', queuedAckText(0).includes("Got it. I'll read it after"))
    ok('copy: no depth talk', !/next in line|waiting/.test(queuedAckText(0)))
    ok('copy: no /cancel pitch in the ack', !queuedAckText(0).includes('/cancel'))
    ok('copy: 1 file singular', queuedAckText(1).includes('with 1 file.'))
    ok('copy: 2 files plural', queuedAckText(2).includes('with 2 files'))
    ok('copy: cleared singular', queueClearedText(1).includes('Dropped 1 unread message.'))
    ok('copy: cleared plural', queueClearedText(4).includes('Dropped 4 unread messages.'))
    ok('copy: empty + running points at /stop', queueEmptyText(true).includes('/stop'))
    ok('copy: empty + idle stays terse', queueEmptyText(false) === 'Nothing queued.')
    ok('copy: no pending note at 0', queuePendingNote(0) === '')
    ok('copy: pending note at 2', queuePendingNote(2).includes('2 queued messages will run next'))
    ok(
      'copy: stop note quotes the text',
      unreadAfterStopText('skip the tests', 0) ===
        '⏹ Stopped before reading "skip the tests". Resend it if you still want it.',
      unreadAfterStopText('skip the tests', 0)
    )
    ok(
      'copy: stop note truncates long text',
      unreadAfterStopText('x'.repeat(100), 0).includes(`"${'x'.repeat(60)}…"`),
      unreadAfterStopText('x'.repeat(100), 0)
    )
    ok('copy: stop note names a lone file', unreadAfterStopText('', 1).includes('your file'))
    ok('copy: stop note counts files', unreadAfterStopText('  ', 3).includes('your 3 files'))
    ok('copy: stop note plain fallback', unreadAfterStopText('', 0).includes('your message'))
  }

  // ── Layer 2: real TelegramChannel + real TurnRunner ────────────────────
  const { Corpus } = await import('@main/runtime/corpus')
  const { TurnRunner } = await import('@main/channels/turn-runner')
  const { TelegramChannel } = await import('@main/channels/telegram/channel')
  const { loadConversation } = await import('@main/conversations')
  const { getConversationIdForChat } = await import('@main/channels/telegram/conversations')
  type InterjectionEvent = import('@main/runtime/agent/interjection').InterjectionEvent
  type Interjection = import('@main/runtime/agent/interjection').Interjection

  /** Prompt text → gate that holds that turn open until we release it. */
  const gates = new Map<string, ReturnType<typeof deferred>>()
  /** Prompt text, in the order respond() actually saw it. */
  const responded: string[] = []
  const startedGate = new Map<string, ReturnType<typeof deferred>>()
  /**
   * Turns (by prompt tag) that play the agent loop's stop point: after the
   * gate releases they pull the inbox and record each message as
   * `drained:<text>`. Every other turn never reads its inbox, so whatever
   * was interjected comes back from the runner's sweep with turn_ended.
   */
  const drainTags = new Set<string>()

  const corpus = new Corpus({ devLog: false })
  const agent = {
    corpus,
    thalamus: { title: async (): Promise<{ text: string }> => ({ text: 'Queue Test' }) },
    motor: { stopTask: async (): Promise<void> => undefined },
    respond: async (turn: {
      turnId: string
      onSegment: (s: Record<string, unknown>) => void
      history: Array<{ content: string }>
      signal?: AbortSignal
      takeInterjections?: () => Interjection[]
    }): Promise<{ stopReason: string; toolCalls: number }> => {
      const last = String(turn.history[turn.history.length - 1]?.content ?? '')
      // The dispatched content is the composed attachment context, so match on
      // the prompt PREFIX rather than equality.
      const tag = last.split('\n')[0].trim()
      responded.push(tag)
      turn.onSegment({ kind: 'text', turnId: turn.turnId, segmentId: 's1', delta: `ok:${tag}` })
      startedGate.get(tag)?.resolve()
      const gate = gates.get(tag)
      if (gate) await gate.promise
      if (drainTags.has(tag)) {
        for (const item of turn.takeInterjections?.() ?? []) responded.push(`drained:${item.text}`)
      }
      turn.onSegment({
        kind: 'turn_end',
        turnId: turn.turnId,
        segmentId: 's2',
        stopReason: turn.signal?.aborted ? 'canceled' : 'end_turn',
        iterationCount: 1
      })
      return { stopReason: turn.signal?.aborted ? 'canceled' : 'end_turn', toolCalls: 0 }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runner = new TurnRunner(agent as any)
  const events: InterjectionEvent[] = []
  runner.onInterjection((ev) => events.push(ev))
  const localProvider = { isReady: false }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channel = new TelegramChannel(agent as any, runner, localProvider as any)

  /** Everything the bot sent to the chat, in order. */
  const outbox: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ch = channel as any
  let messageId = 1000
  const api = {
    sendMessage: async (_chatId: number, text: string) => {
      outbox.push(text)
      return { message_id: ++messageId }
    },
    sendChatAction: async (): Promise<boolean> => true
  }
  ch.bot = { api }
  ch.allowedUserIds = new Set([USER_ID])
  // What start() does; the harness never launches a bot.
  ch.watchInterjections()
  ok('wiring: channel subscribed to the runner', typeof ch.offInterjection === 'function')

  const ctx = {
    from: { id: USER_ID },
    chat: { id: CHAT_ID },
    message: { text: '', message_id: 1 },
    api
  }
  const send = (text: string): Promise<void> =>
    ch.handleTextMessage({ ...ctx, message: { text, message_id: ++messageId } })

  const acks = (): string[] => outbox.filter((t) => t.includes('Got it'))
  const convId = async (): Promise<string> => (await getConversationIdForChat(CHAT_ID)) ?? ''
  const pending = async (): Promise<Interjection[]> => runner.pendingInterjections(await convId())
  const convMessages = async (): Promise<
    Array<{ role: string; content: string; attachments?: unknown[] }>
  > => {
    const id = await getConversationIdForChat(CHAT_ID)
    if (!id) return []
    const conv = await loadConversation(id)
    return (conv?.messages ?? []) as Array<{
      role: string
      content: string
      attachments?: unknown[]
    }>
  }
  const reset = (): void => {
    outbox.length = 0
    responded.length = 0
    events.length = 0
    gates.clear()
    startedGate.clear()
    drainTags.clear()
  }

  // ── 1. Mid-turn messages INTERJECT; a turn that never read them hands ──
  //      them back, and the channel re-runs them in order as fresh turns.
  {
    gates.set('first', deferred())
    startedGate.set('first', deferred())
    void send('first')
    await startedGate.get('first')!.promise

    await send('second')
    await send('third')

    ok('interject: two acks emitted', acks().length === 2, JSON.stringify(outbox))
    // sendPlain prefixes a bidi mark and entity-escapes the apostrophe in
    // "I'll", so match the unescaped tail of the sentence.
    ok(
      'interject: ack is the interject ack',
      acks()[0]?.includes('Got it. I') === true &&
        acks()[0]?.includes('read it after the current step') === true,
      acks()[0]
    )
    ok('interject: nothing in the sliver queue', ch.queue.size(CHAT_ID) === 0)
    ok('interject: both pending on the runner', (await pending()).length === 2)
    ok(
      'interject: sender records kept for both',
      ch.interjectedByMessageId.size === 2,
      String(ch.interjectedByMessageId.size)
    )
    ok(
      'interject: pending events tagged telegram',
      events.filter((e) => e.state === 'pending' && e.channel === 'telegram').length === 2
    )
    ok('interject: neither ran yet', responded.length === 1, JSON.stringify(responded))
    ok('interject: no busy decline sent', !outbox.some((t) => t.includes('Hold on')))

    gates.get('first')!.resolve()
    await waitFor(() => responded.length === 3, 'returned messages re-dispatched')
    ok(
      'sweep: turn_ended returned both',
      events.filter((e) => e.state === 'withdrawn' && e.reason === 'turn_ended').length === 2,
      JSON.stringify(events.map((e) => `${e.state}/${e.reason ?? ''}`))
    )
    ok(
      'sweep: FIFO order preserved on re-dispatch',
      responded.join(',') === 'first,second,third',
      responded.join(',')
    )
    await waitFor(() => runner.activeTurnCount() === 0, 'runner idle')
    await tick()
    ok('sweep: no second ack on re-dispatch', acks().length === 2, JSON.stringify(outbox))
    ok('sweep: sender records released', ch.interjectedByMessageId.size === 0)
    ok('sweep: sliver queue drained', ch.queue.size(CHAT_ID) === 0)

    const msgs = await convMessages()
    const userTexts = msgs.filter((m) => m.role === 'user').map((m) => m.content)
    ok(
      'sweep: all three persisted in order',
      userTexts.join(',') === 'first,second,third',
      userTexts.join(',')
    )
  }

  // ── 2. A turn that READS the message answers it in place: no re-dispatch ─
  {
    reset()
    drainTags.add('host')
    gates.set('host', deferred())
    startedGate.set('host', deferred())
    void send('host')
    await startedGate.get('host')!.promise

    await send('steer')
    ok('drain: pending on the runner', (await pending()).length === 1)

    gates.get('host')!.resolve()
    await waitFor(() => runner.activeTurnCount() === 0, 'host turn done')
    await tick()
    await tick()
    ok('drain: the turn read it', responded.includes('drained:steer'), JSON.stringify(responded))
    ok('drain: never re-dispatched', !responded.includes('steer'), JSON.stringify(responded))
    ok(
      'drain: delivered event, no withdraw',
      events.some((e) => e.state === 'delivered') && !events.some((e) => e.state === 'withdrawn'),
      JSON.stringify(events.map((e) => e.state))
    )
    ok('drain: sender record released on delivery', ch.interjectedByMessageId.size === 0)
    ok('drain: nothing queued', ch.queue.size(CHAT_ID) === 0)
  }

  // ── 3. Media rides an interjection AND survives the sliver queue ────────
  {
    reset()
    gates.set('busy2', deferred())
    startedGate.set('busy2', deferred())
    void send('busy2')
    await startedGate.get('busy2')!.promise

    // Stands in for a downloaded photo: the media handlers save the blob and
    // hand the resulting attachment to parkMessage exactly like this.
    const attachment = {
      id: 'att_1',
      type: 'image',
      filePath: '/tmp/queued-photo.png',
      originalName: 'queued-photo.png',
      mimeType: 'image/png',
      sizeBytes: 1234
    }
    await ch.parkMessage(CHAT_ID, {
      id: 'q_media',
      userId: USER_ID,
      ctx,
      text: 'look at this',
      attachments: [attachment]
    })
    ok('media: interjected, not queued', ch.queue.size(CHAT_ID) === 0)
    ok('media: ack counts the file', acks()[0]?.includes('with 1 file'), acks()[0])
    ok('media: attachment rides the interjection', (await pending())[0]?.attachments.length === 1)
    // The sliver path with the same payload — a direct enqueue is what the
    // no_live_turn branch does.
    await ch.enqueueMessage(CHAT_ID, {
      id: 'q_media_sliver',
      userId: USER_ID,
      ctx,
      text: 'and this',
      attachments: [attachment]
    })
    ok('media: sliver ack reads the same', acks()[1]?.includes('with 1 file'), acks()[1])
    ok('media: sliver item queued', ch.queue.size(CHAT_ID) === 1)

    gates.get('busy2')!.resolve()
    await waitFor(
      () => responded.includes('look at this') && responded.includes('and this'),
      'both media turns ran'
    )
    await waitFor(() => runner.activeTurnCount() === 0, 'runner idle after media')
    await tick()

    const msgs = await convMessages()
    for (const text of ['look at this', 'and this']) {
      const m = msgs.find((x) => x.role === 'user' && x.content === text)
      ok(`media: "${text}" persisted with its attachment`, m?.attachments?.length === 1)
    }
  }

  // ── 4. /cancel withdraws pending interjections; the running turn is untouched ─
  {
    reset()
    gates.set('busy3', deferred())
    startedGate.set('busy3', deferred())
    void send('busy3')
    await startedGate.get('busy3')!.promise

    await send('drop-me-1')
    await send('drop-me-2')
    ok('cancel: two pending', (await pending()).length === 2)

    await send('/cancel')
    ok('cancel: inbox emptied', (await pending()).length === 0)
    ok('cancel: sliver queue empty', ch.queue.size(CHAT_ID) === 0)
    ok(
      'cancel: reports the combined count',
      outbox.some((t) => t.includes('Dropped 2 unread messages.')),
      JSON.stringify(outbox.slice(-2))
    )
    ok(
      'cancel: withdrawn with reason user',
      events.filter((e) => e.state === 'withdrawn' && e.reason === 'user').length === 2
    )
    ok('cancel: sender records released', ch.interjectedByMessageId.size === 0)
    ok('cancel: running turn untouched', runner.activeTurnCount() === 1)

    gates.get('busy3')!.resolve()
    await waitFor(() => runner.activeTurnCount() === 0, 'runner idle after cancel')
    await tick()
    ok(
      'cancel: dropped messages never ran',
      !responded.includes('drop-me-1') && !responded.includes('drop-me-2'),
      JSON.stringify(responded)
    )

    await send('/cancel')
    ok(
      'cancel: nothing pending says so',
      outbox.some((t) => t.includes('Nothing queued')),
      JSON.stringify(outbox.slice(-1))
    )
  }

  // ── 5. /stop: an unread interjection is REPORTED, never resent; a sliver ─
  //      item still advances (it is a turn of its own, like the in-app queue).
  {
    reset()
    gates.set('busy4', deferred())
    startedGate.set('busy4', deferred())
    void send('busy4')
    await startedGate.get('busy4')!.promise

    await send('after-stop')
    ok('stop: pending on the turn', (await pending()).length === 1)
    // A sliver item parked directly (what a lost pre-send race leaves).
    ch.queue.enqueue(CHAT_ID, {
      id: 'q_sliver',
      userId: USER_ID,
      ctx,
      text: 'sliver-after-stop',
      attachments: []
    })

    const stopped = send('/stop')
    // The gate keeps respond() parked until the abort is observed; release it
    // so the aborted turn can unwind exactly as a real cancel does.
    gates.get('busy4')!.resolve()
    await stopped
    ok(
      'stop: unread interjection returned as canceled',
      events.some((e) => e.state === 'withdrawn' && e.reason === 'canceled'),
      JSON.stringify(events.map((e) => `${e.state}/${e.reason ?? ''}`))
    )
    ok(
      'stop: user told the message was not read',
      outbox.some((t) => t.includes('Stopped before reading "after-stop"')),
      JSON.stringify(outbox)
    )
    ok(
      'stop: reply still flags the sliver queue',
      outbox.some((t) => t.includes('queued message will run next')),
      JSON.stringify(outbox.filter((t) => t.includes('Stop')))
    )
    await waitFor(() => responded.includes('sliver-after-stop'), 'sliver item advanced past stop')
    await waitFor(() => runner.activeTurnCount() === 0, 'runner idle after stop')
    await sleep(100)
    ok(
      'stop: interjection NOT auto-resent',
      !responded.includes('after-stop'),
      JSON.stringify(responded)
    )
    ok('stop: sender record released', ch.interjectedByMessageId.size === 0)
    ok('stop: sliver queue drained, not dropped', ch.queue.size(CHAT_ID) === 0)
  }

  // ── 6. Busy chat with NO lane: sliver queue, and its flush interjects first ─
  {
    reset()
    const id = await convId()
    // The pre-send sliver: our per-chat slot is claimed (a turn is being set
    // up) but runner.send has not registered the lane. Modelled by a bare
    // slot that carries only what parkMessage reads.
    ch.activeByChat.set(CHAT_ID, { conversation: { id } })
    await send('sliver-msg')
    ok('sliver: not interjected (no lane)', (await pending()).length === 0)
    ok('sliver: parked in the queue', ch.queue.size(CHAT_ID) === 1)
    ok('sliver: acked the same way', acks().length === 1 && acks()[0].includes('Got it'))
    ok(
      'sliver: no flush behind our own slot',
      !ch.flushingByChat.has(CHAT_ID),
      'enqueue must not start a wait on the map that just admitted the message'
    )
    ch.activeByChat.delete(CHAT_ID)

    // The turn being set up goes live and will read its inbox.
    drainTags.add('host2')
    gates.set('host2', deferred())
    startedGate.set('host2', deferred())
    void send('host2')
    await startedGate.get('host2')!.promise

    // What the end-of-turn cleanup (or the setup's own release) would do.
    ch.flushQueue(CHAT_ID)
    await waitFor(() => ch.queue.size(CHAT_ID) === 0, 'flush took the sliver item')
    ok(
      'sliver: flush interjected instead of dispatching',
      (await pending()).some((p) => p.text === 'sliver-msg'),
      JSON.stringify(await pending())
    )
    ok('sliver: no second ack from the flush', acks().length === 1, JSON.stringify(outbox))
    ok('sliver: no extra turn started', runner.activeTurnCount() === 1)

    gates.get('host2')!.resolve()
    await waitFor(() => runner.activeTurnCount() === 0, 'host2 done')
    await tick()
    ok(
      'sliver: the live turn read it',
      responded.includes('drained:sliver-msg') && !responded.includes('sliver-msg'),
      JSON.stringify(responded)
    )
  }

  // ── 7. /new clears the queue — it must not flush into a NEW conversation ──
  {
    reset()
    const before = await getConversationIdForChat(CHAT_ID)

    // No turn running: park directly, the way a lost race would.
    ch.queue.enqueue(CHAT_ID, {
      id: 'q1',
      userId: USER_ID,
      ctx,
      text: 'stale-1',
      attachments: []
    })
    ch.queue.enqueue(CHAT_ID, {
      id: 'q2',
      userId: USER_ID,
      ctx,
      text: 'stale-2',
      attachments: []
    })

    await send('/new')
    const after = await getConversationIdForChat(CHAT_ID)
    ok('new: rotated to a fresh conversation', !!after && after !== before, `${before} -> ${after}`)
    ok('new: queue cleared', ch.queue.size(CHAT_ID) === 0)
    ok(
      'new: reply says the queue was dropped',
      outbox.some((t) => t.includes('queued messages were dropped')),
      JSON.stringify(outbox.slice(0, 2))
    )
    await tick()
    ok(
      'new: stale messages never ran',
      !responded.includes('stale-1') && !responded.includes('stale-2'),
      JSON.stringify(responded)
    )
  }

  // ── 8. A LONG turn must not produce a "still busy" warning ─────────────
  // The old regression: enqueueMessage fired a flush whose wait polls the very
  // map that admitted the message, so on a long turn it could only expire and
  // cry wolf. Now the message is an interjection and there is no flush at
  // all — but the sliver path still exists, so the guard stays under test.
  {
    reset()
    // 3 attempts × (60ms wait + 50ms backoff) ⇒ the old code warns by ~330ms.
    channel.setQueueFlushWait(60)

    gates.set('long-turn', deferred())
    startedGate.set('long-turn', deferred())
    void send('long-turn')
    await startedGate.get('long-turn')!.promise

    await send('behind-a-long-turn')
    ok('long: interjected', (await pending()).length === 1)
    ok('long: nothing queued', ch.queue.size(CHAT_ID) === 0)
    ok('long: no flush loop spins behind our own turn', !ch.flushingByChat.has(CHAT_ID))

    // Outlive the old budget several times over.
    await sleep(600)
    ok(
      'long: no "still busy" warning while the turn is healthy',
      !outbox.some((t) => t.includes('Still busy')),
      JSON.stringify(outbox)
    )
    ok('long: still pending, not dropped', (await pending()).length === 1)
    ok('long: did not run early', !responded.includes('behind-a-long-turn'))
    ok('long: the ack is still the only thing said', acks().length === 1, JSON.stringify(outbox))

    gates.get('long-turn')!.resolve()
    await waitFor(() => responded.includes('behind-a-long-turn'), 'returned message re-ran')
    await waitFor(() => runner.activeTurnCount() === 0, 'runner idle after long turn')
    ok(
      'long: end-of-turn re-dispatch, still no warning',
      !outbox.some((t) => t.includes('Still busy')),
      JSON.stringify(outbox)
    )

    // The other direction: with no turn of ours running there is no cleanup
    // coming, so a sliver enqueue MUST flush itself.
    outbox.length = 0
    responded.length = 0
    await ch.enqueueMessage(CHAT_ID, {
      id: 'q_no_turn',
      userId: USER_ID,
      ctx,
      text: 'nobody-is-running',
      attachments: []
    })
    await waitFor(() => responded.includes('nobody-is-running'), 'idle-chat enqueue self-flushed')
    ok('idle: enqueue on a free chat still flushes itself', true)
    await waitFor(() => runner.activeTurnCount() === 0, 'runner idle after self-flush')

    channel.setQueueFlushWait(30_000)
  }

  // ── 9. A REJECTED render chain still releases the chat and re-runs ─────
  // The cleanup hangs off the render chain, so a rejected chain used to skip
  // it entirely: activeByChat leaked, the chat read as busy forever, and every
  // later message parked behind a turn that was already over.
  {
    reset()

    gates.set('doomed-chain', deferred())
    startedGate.set('doomed-chain', deferred())
    void send('doomed-chain')
    await startedGate.get('doomed-chain')!.promise

    // Poison this turn's render chain the way a throwing renderSegment /
    // scheduleMirror link would. The extra .catch only marks the rejection
    // handled for Node — `rejected` itself stays rejected, which is the point.
    const rejected = Promise.reject(new Error('render link blew up'))
    rejected.catch(() => undefined)
    ch.activeByChat.get(CHAT_ID).renderChain = rejected

    await send('after-a-broken-chain')
    ok('broken chain: interjected', (await pending()).length === 1)

    gates.get('doomed-chain')!.resolve()
    await waitFor(() => !ch.activeByChat.has(CHAT_ID), 'per-chat slot released despite rejection')
    ok('broken chain: slot released, chat not wedged', !ch.activeByChat.has(CHAT_ID))
    await waitFor(
      () => responded.includes('after-a-broken-chain'),
      'returned message re-ran despite rejection'
    )
    ok('broken chain: returned message still ran', responded.includes('after-a-broken-chain'))
    await waitFor(() => runner.activeTurnCount() === 0, 'runner idle after broken chain')
  }

  // ── 10. stop() unsubscribes and forgets sender records ─────────────────
  {
    ch.interjectedByMessageId.set('ghost', { chatId: CHAT_ID, userId: USER_ID, ctx })
    ch.unwatchInterjections()
    ok('teardown: unsubscribed', ch.offInterjection === null)
    ok('teardown: sender records cleared', ch.interjectedByMessageId.size === 0)
    ch.watchInterjections()
    ch.watchInterjections()
    ok('teardown: re-watch is idempotent', typeof ch.offInterjection === 'function')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

run()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true })
  })
