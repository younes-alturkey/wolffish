/**
 * Mid-turn messages on WhatsApp: INTERJECT FIRST through TurnRunner.interject,
 * with the sliver queue (channels/message-queue.ts) kept only for the
 * pre-send window behind the synchronous `dispatchingByJid` claim, where the
 * runner has no lane yet. The Telegram twin lives in message-queue.test.ts;
 * this file pins the same contract on the WhatsApp channel, whose busy gate
 * differs (claim + slot + lane) and whose plain sender is the socket.
 *
 * REAL WhatsAppChannel against a REAL TurnRunner; only agent.respond /
 * thalamus.title and the baileys socket's sendMessage are stubbed. The
 * channel is never start()ed, so no socket, auth dir or network is touched.
 *
 * Covers: a busy jid with a live lane interjects and queues nothing; a busy
 * jid with NO lane (claim held) parks in the sliver queue and the flush
 * interjects the moment the lane goes live; /cancel withdraws pending
 * interjections and reports the combined count; a turn_ended return is
 * re-dispatched as a fresh turn; a /stop return is reported, never resent;
 * events for another channel's messages are ignored.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/channels/__tests__/interjection-channels.test.ts
 */

import fs from 'node:fs'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-interject-wa-'))
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

const JID = '15550001111@s.whatsapp.net'

async function run(): Promise<void> {
  const { Corpus } = await import('@main/runtime/corpus')
  const { TurnRunner } = await import('@main/channels/turn-runner')
  const { WhatsAppChannel } = await import('@main/channels/whatsapp/channel')
  const { getConversationIdForJid } = await import('@main/channels/whatsapp/conversations')
  type InterjectionEvent = import('@main/runtime/agent/interjection').InterjectionEvent
  type Interjection = import('@main/runtime/agent/interjection').Interjection

  const gates = new Map<string, ReturnType<typeof deferred>>()
  const startedGate = new Map<string, ReturnType<typeof deferred>>()
  const responded: string[] = []
  /** Turns (by prompt tag) that read their inbox after the gate — see the Telegram twin. */
  const drainTags = new Set<string>()

  const corpus = new Corpus({ devLog: false })
  const agent = {
    corpus,
    thalamus: { title: async (): Promise<{ text: string }> => ({ text: 'WA Interject' }) },
    motor: { stopTask: async (): Promise<void> => undefined },
    cerebellum: { ensureSystemTool: async (): Promise<void> => undefined },
    respond: async (turn: {
      turnId: string
      onSegment: (s: Record<string, unknown>) => void
      history: Array<{ content: string }>
      signal?: AbortSignal
      takeInterjections?: () => Interjection[]
    }): Promise<{ stopReason: string; toolCalls: number }> => {
      const last = String(turn.history[turn.history.length - 1]?.content ?? '')
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
  const channel = new WhatsAppChannel(agent as any, runner, localProvider as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ch = channel as any

  const outbox: string[] = []
  let sentId = 0
  ch.sock = {
    sendMessage: async (_jid: string, content: { text?: string }) => {
      outbox.push(content.text ?? '')
      return { key: { id: `wa_${++sentId}` } }
    }
  }
  ch.watchInterjections()
  ok('wiring: channel subscribed to the runner', typeof ch.offInterjection === 'function')

  const send = (text: string): Promise<void> => ch.handleInboundMessage(JID, text)
  const acks = (): string[] => outbox.filter((t) => t.includes('Got it'))
  const convId = async (): Promise<string> => (await getConversationIdForJid(JID)) ?? ''
  const pending = async (): Promise<Interjection[]> => runner.pendingInterjections(await convId())
  const reset = (): void => {
    outbox.length = 0
    responded.length = 0
    events.length = 0
    gates.clear()
    startedGate.clear()
    drainTags.clear()
  }

  // ── 1. Busy jid with a live lane: interject, queue nothing ─────────────
  {
    drainTags.add('host')
    gates.set('host', deferred())
    startedGate.set('host', deferred())
    void send('host')
    await startedGate.get('host')!.promise

    await send('steer')
    ok(
      'live: ack is the interject ack',
      acks()[0]?.startsWith("📥 Got it. I'll read it"),
      JSON.stringify(outbox)
    )
    ok('live: nothing in the sliver queue', ch.queue.size(JID) === 0)
    ok('live: pending on the runner', (await pending()).length === 1)
    ok(
      'live: pending event tagged whatsapp',
      events.some((e) => e.state === 'pending' && e.channel === 'whatsapp')
    )
    ok('live: sender record kept', ch.interjectedByMessageId.size === 1)
    ok('live: did not start a turn', runner.activeTurnCount() === 1)

    gates.get('host')!.resolve()
    await waitFor(() => runner.activeTurnCount() === 0, 'host done')
    await tick()
    await tick()
    ok('live: the turn read it', responded.includes('drained:steer'), JSON.stringify(responded))
    ok('live: never re-dispatched', !responded.includes('steer'), JSON.stringify(responded))
    ok('live: sender record released', ch.interjectedByMessageId.size === 0)
  }

  // ── 2. turn_ended return → re-dispatched as a fresh turn, in order ─────
  {
    reset()
    gates.set('no-read', deferred())
    startedGate.set('no-read', deferred())
    void send('no-read')
    await startedGate.get('no-read')!.promise

    await send('late-1')
    await send('late-2')
    ok('sweep: two pending', (await pending()).length === 2)

    gates.get('no-read')!.resolve()
    await waitFor(() => responded.length === 3, 'returned messages re-dispatched')
    ok(
      'sweep: turn_ended returned both',
      events.filter((e) => e.state === 'withdrawn' && e.reason === 'turn_ended').length === 2,
      JSON.stringify(events.map((e) => `${e.state}/${e.reason ?? ''}`))
    )
    ok(
      'sweep: FIFO order preserved',
      responded.join(',') === 'no-read,late-1,late-2',
      responded.join(',')
    )
    await waitFor(() => runner.activeTurnCount() === 0, 'runner idle')
    await tick()
    ok('sweep: no second ack on re-dispatch', acks().length === 2, JSON.stringify(outbox))
    ok('sweep: queue drained', ch.queue.size(JID) === 0)
    ok('sweep: sender records released', ch.interjectedByMessageId.size === 0)
  }

  // ── 3. /cancel withdraws pending interjections + clears the sliver queue ─
  {
    reset()
    gates.set('busy', deferred())
    startedGate.set('busy', deferred())
    void send('busy')
    await startedGate.get('busy')!.promise

    await send('drop-1')
    await send('drop-2')
    ch.queue.enqueue(JID, { id: 'q_sliver', text: 'drop-sliver', attachments: [] })

    await send('/cancel')
    ok('cancel: inbox emptied', (await pending()).length === 0)
    ok('cancel: sliver queue emptied', ch.queue.size(JID) === 0)
    ok(
      'cancel: combined count reported',
      outbox.some((t) => t.includes('Dropped 3 unread messages.')),
      JSON.stringify(outbox.slice(-2))
    )
    ok('cancel: running turn untouched', runner.activeTurnCount() === 1)

    gates.get('busy')!.resolve()
    await waitFor(() => runner.activeTurnCount() === 0, 'runner idle after cancel')
    await sleep(50)
    ok(
      'cancel: nothing dropped ever ran',
      !responded.some((t) => t.startsWith('drop-')),
      JSON.stringify(responded)
    )
    await send('/cancel')
    ok(
      'cancel: empty says so',
      outbox.some((t) => t.includes('Nothing queued'))
    )
  }

  // ── 4. /stop: unread interjection reported, never resent ───────────────
  {
    reset()
    gates.set('stop-me', deferred())
    startedGate.set('stop-me', deferred())
    void send('stop-me')
    await startedGate.get('stop-me')!.promise

    await send('unread-after-stop')
    const stopped = send('/stop')
    gates.get('stop-me')!.resolve()
    await stopped
    ok(
      'stop: returned as canceled',
      events.some((e) => e.state === 'withdrawn' && e.reason === 'canceled'),
      JSON.stringify(events.map((e) => `${e.state}/${e.reason ?? ''}`))
    )
    ok(
      'stop: user told it was not read',
      outbox.some((t) => t.includes('Stopped before reading "unread-after-stop"')),
      JSON.stringify(outbox)
    )
    await waitFor(() => runner.activeTurnCount() === 0, 'runner idle after stop')
    await sleep(100)
    ok('stop: NOT auto-resent', !responded.includes('unread-after-stop'), JSON.stringify(responded))
    ok('stop: sender record released', ch.interjectedByMessageId.size === 0)
  }

  // ── 5. Busy jid with NO lane (claim held): sliver queue, flush interjects ─
  {
    reset()
    const id = await convId()
    // The real pre-send sliver: dispatchTurn's synchronous claim is held
    // while its setup (conversation load, config, persist) runs, before
    // runner.send registers the lane.
    ch.dispatchingByJid.add(JID)
    await send('sliver-msg')
    ok('sliver: not interjected (no lane)', (await pending()).length === 0)
    ok('sliver: parked in the queue', ch.queue.size(JID) === 1)
    ok('sliver: acked the same way', acks().length === 1 && acks()[0].includes('Got it'))
    // The claim is not our running slot, so the flush starts and polls
    // through the setup — see enqueueMessage.
    ok('sliver: flush loop is polling', ch.flushingByJid.has(JID))

    // The setup completes: runner.send registers the lane (what
    // dispatchTurnInner does next), and the turn will read its inbox.
    drainTags.add('host2')
    startedGate.set('host2', deferred())
    gates.set('host2', deferred())
    const handle = runner.send({
      history: [{ role: 'user', content: 'host2' }],
      conversationId: id,
      userMessageId: 'u_host2',
      channel: 'whatsapp',
      makeSink: (sinkCtx: { turnId: string; conversationId: string | null }) => ({
        ...sinkCtx,
        channelId: 'whatsapp',
        onSegment: () => {},
        onTurnEvent: () => {},
        onApprovalRequest: async () => 'denied' as const,
        onDone: () => {},
        onError: () => {},
        onCredentialBlocked: () => {}
      }),
      onTurnStarted: () => {
        ch.dispatchingByJid.delete(JID)
      }
    })
    await startedGate.get('host2')!.promise

    await waitFor(() => ch.queue.size(JID) === 0, 'flush took the sliver item')
    ok(
      'sliver: flush interjected instead of dispatching',
      (await pending()).some((p) => p.text === 'sliver-msg'),
      JSON.stringify(await pending())
    )
    ok('sliver: no second ack from the flush', acks().length === 1, JSON.stringify(outbox))
    ok('sliver: no extra turn started', runner.activeTurnCount() === 1)

    gates.get('host2')!.resolve()
    await handle.done
    await waitFor(() => runner.activeTurnCount() === 0, 'host2 done')
    await tick()
    ok(
      'sliver: the live turn read it',
      responded.includes('drained:sliver-msg') && !responded.includes('sliver-msg'),
      JSON.stringify(responded)
    )
    ok('sliver: flush loop finished', !ch.flushingByJid.has(JID))
  }

  // ── 6. Another channel's events are ignored ────────────────────────────
  {
    reset()
    const id = await convId()
    gates.set('foreign-host', deferred())
    startedGate.set('foreign-host', deferred())
    void send('foreign-host')
    await startedGate.get('foreign-host')!.promise
    // A Telegram message parked on the same conversation's turn.
    const result = runner.interject(id, {
      messageId: 'tg_1',
      text: 'from telegram',
      attachments: [],
      channel: 'telegram',
      sentAt: Date.now()
    })
    ok('foreign: runner accepted it', result.status === 'pending')
    gates.get('foreign-host')!.resolve()
    await waitFor(() => runner.activeTurnCount() === 0, 'foreign host done')
    await sleep(50)
    ok(
      'foreign: swept as turn_ended',
      events.some((e) => e.state === 'withdrawn' && e.channel === 'telegram')
    )
    ok(
      'foreign: WhatsApp did not re-dispatch it',
      !responded.includes('from telegram'),
      JSON.stringify(responded)
    )
    ok('foreign: nothing queued', ch.queue.size(JID) === 0)
    // The turn's own rendered reply reaches the phone; no interjection copy does.
    ok(
      'foreign: no interjection copy sent to the phone',
      !outbox.some((t) => t.includes('Got it') || t.includes('Stopped before reading')),
      JSON.stringify(outbox)
    )
  }

  // ── 7. stop() unsubscribes ─────────────────────────────────────────────
  {
    ch.interjectedByMessageId.set('ghost', { jid: JID })
    ch.unwatchInterjections()
    ok('teardown: unsubscribed', ch.offInterjection === null)
    ok('teardown: sender records cleared', ch.interjectedByMessageId.size === 0)
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
