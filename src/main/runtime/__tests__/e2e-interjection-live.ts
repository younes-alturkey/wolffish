/**
 * LIVE end-to-end: does a message sent MID-TURN actually reach the running
 * agent, land in the model's context at the right place, and change what
 * the model does next?
 *
 * The unit tests prove the inbox, the drain points and the adapter merge.
 * This one runs the REAL Agent through the REAL TurnRunner against the
 * user's configured Brain, in a throwaway workspace, and interjects from the
 * outside at each of the three moments the feature promises:
 *
 *  1. DURING A TOOL BATCH — the model is told to read three files one call
 *     at a time; after the first tool_result lands we interject "skip the
 *     third file, end with PINEAPPLE". Pass: the `user_message` segment sits
 *     after a tool_result and before the next active_model; the very next
 *     provider call carries it as a user entry after the tool messages with
 *     the runtime notice in the volatile tail; the third file is never read
 *     after delivery; the final reply ends with the marker.
 *  2. BEFORE THE FIRST MODEL CALL — interject in the same tick as send().
 *     Pass: the first provider call already carries both user texts (two
 *     user entries back to back — the OpenAI-shaped wire accepts them, the
 *     Anthropic adapter merges them) and the reply honours the second.
 *  3. DURING THE CLOSING REPLY — the model is asked for a long plain answer
 *     with no tools; we interject on the first text delta. Pass: the turn
 *     does NOT end — the segment stream shows text, then user_message, then a
 *     second active_model and text containing the marker; one turn, one
 *     'done'.
 *
 * Reads the live provider key from ~/.wolffish/workspace/config.json; never
 * mutates the real workspace (homedir is redirected before anything loads).
 *
 * Run (tsx is not a local dependency — point electron at npx's cached copy,
 * found under ~/.npm/_npx/<hash>/node_modules/tsx/dist/cli.mjs):
 *   TSX_TSCONFIG_PATH=tsconfig.node.json ELECTRON_RUN_AS_NODE=1 npx electron <that cli.mjs> \
 *     src/main/runtime/__tests__/e2e-interjection-live.ts
 */
import fs from 'node:fs'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-interject-live-'))
const REAL_HOME = os.homedir()
;(os as unknown as { homedir: () => string }).homedir = (): string => TEST_HOME

const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  const loaded = origLoad.apply(this, args)
  if (args[0] !== 'electron') return loaded
  const electron = loaded as { app?: unknown; net?: { isOnline?: () => boolean } }
  if (electron.app && electron.net?.isOnline) return loaded
  return {
    ...electron,
    app: electron.app ?? {
      isPackaged: false,
      getAppPath: () => process.cwd(),
      getPath: () => os.tmpdir(),
      getVersion: () => '0.0.0-test',
      getName: () => 'wolffish'
    },
    net: { ...(electron.net ?? {}), isOnline: () => true }
  }
}

type Segment = import('@main/runtime/broca').Segment
type ProviderStreamOptions = import('@main/runtime/thalamus').ProviderStreamOptions
type ChatMessage = import('@main/runtime/thalamus').ChatMessage
type ThalamusT = import('@main/runtime/thalamus').Thalamus
type TurnRunnerT = import('@main/channels/turn-runner').TurnRunner

// ── live credentials, read-only, from the REAL workspace ─────────────────
type Cloud = { id: string; model: string; apiKey: string }
function collectProviders(node: unknown, out: Cloud[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectProviders(item, out)
    return
  }
  if (node && typeof node === 'object') {
    const rec = node as Record<string, unknown>
    if (typeof rec.id === 'string' && typeof rec.apiKey === 'string' && rec.apiKey) {
      out.push({ id: rec.id, model: String(rec.model ?? ''), apiKey: rec.apiKey })
    }
    for (const value of Object.values(rec)) collectProviders(value, out)
  }
}
const configPath = path.join(REAL_HOME, '.wolffish', 'workspace', 'config.json')
let config: Record<string, unknown>
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
} catch {
  console.error(`no config at ${configPath} — cannot run a live check`)
  process.exit(1)
}
const cloud: Cloud[] = []
collectProviders(config, cloud)
const brain = (config.llm as { brain?: { providerId: string; model: string } } | undefined)?.brain
if (cloud.length === 0 || !brain) {
  console.error('no cloud provider / Brain configured — skipping the live check')
  process.exit(1)
}

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    console.log(`  ok   ${label}`)
    return
  }
  failed++
  console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
async function waitFor(cond: () => boolean, ms = 120_000): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('waitFor timed out')
}
const textOf = (segments: Segment[]): string =>
  segments
    .filter((s): s is Extract<Segment, { kind: 'text' }> => s.kind === 'text')
    .map((s) => s.delta)
    .join('')

async function main(): Promise<void> {
  const { ensureWorkspace } = await import('@main/workspace/workspace')
  const { workspaceRoot } = await import('@main/workspace/root')
  const { LocalProvider } = await import('@main/runtime/providers/local')
  const { Thalamus } = await import('@main/runtime/thalamus')
  const { Agent } = await import('@main/runtime/agent')
  const { TurnRunner } = await import('@main/channels/turn-runner')
  type InterjectionEvent = import('@main/runtime/agent/interjection').InterjectionEvent

  await ensureWorkspace()

  const thalamus = new Thalamus(new LocalProvider())
  thalamus.setCloudProviders(cloud as unknown as Parameters<ThalamusT['setCloudProviders']>[0])
  thalamus.setBrain(brain as unknown as Parameters<ThalamusT['setBrain']>[0])
  // Every provider call this process makes, in order — the model-context
  // truth the assertions read (messages + volatile tail), not the DOM.
  const calls: ProviderStreamOptions[] = []
  const realStream = thalamus.stream.bind(thalamus)
  thalamus.stream = ((options: ProviderStreamOptions) => {
    // Snapshot: the agent mutates ONE messages array in place across
    // iterations, so a by-reference record would show every call carrying
    // the final history.
    calls.push({ ...options, messages: [...options.messages] })
    return realStream(options)
  }) as typeof thalamus.stream

  const agent = new Agent({ thalamus, workspaceRoot: workspaceRoot() })
  await agent.init()
  const runner = new TurnRunner(agent)
  const events: InterjectionEvent[] = []
  runner.onInterjection((ev) => events.push(ev))

  console.log(`Brain: ${brain!.providerId}/${brain!.model}`)

  // The fixture: three files with names that exist nowhere else.
  const dir = path.join(TEST_HOME, 'reads')
  fs.mkdirSync(dir, { recursive: true })
  const A = path.join(dir, 'alpha-7f21.txt')
  const B = path.join(dir, 'bravo-9c04.txt')
  const C = path.join(dir, 'charlie-3e88.txt')
  fs.writeFileSync(A, 'alpha '.repeat(40))
  fs.writeFileSync(B, 'bravo '.repeat(40))
  fs.writeFileSync(C, 'charlie '.repeat(40))

  type Run = { segments: Segment[]; done: boolean; error: string | null }
  const run = (
    conversationId: string,
    prompt: string,
    onSegment?: (s: Segment, r: Run) => void
  ): Run & { handle: ReturnType<TurnRunnerT['send']> } => {
    const r: Run = { segments: [], done: false, error: null }
    const handle = runner.send({
      history: [{ role: 'user', content: prompt }],
      conversationId,
      conversationTitle: 'Live interjection',
      channel: 'electron',
      makeSink: (ctx) => ({
        ...ctx,
        channelId: 'electron',
        onSegment: (s) => {
          r.segments.push(s)
          onSegment?.(s, r)
        },
        onTurnEvent: () => {},
        onApprovalRequest: async () => 'approved' as const,
        onDone: () => {
          r.done = true
        },
        onError: (e) => {
          r.error = e
          r.done = true
        },
        onCredentialBlocked: () => {}
      })
    })
    return Object.assign(r, { handle })
  }
  const userMsgAt = (segments: Segment[]): number =>
    segments.findIndex((s) => s.kind === 'user_message')

  // ── 1. during a tool batch ─────────────────────────────────────────────
  console.log('\n1. message during a tool batch')
  {
    const callsBefore = calls.length
    let interjected = false
    const r = run(
      'conv_batch',
      `Read these three files ONE AT A TIME, each with its own separate file_read call — never batch two reads in one response: ${A} then ${B} then ${C}. After every read, in one short line say which file you just read. When all reads are done, reply with the total number of characters across the files you read.`,
      (s) => {
        if (interjected || s.kind !== 'tool_result') return
        interjected = true
        const res = runner.interject('conv_batch', {
          messageId: 'live_m1',
          text: 'Change of plan: do NOT read the charlie file at all. Read only alpha and bravo, then end your final reply with the single word PINEAPPLE.',
          attachments: [],
          channel: 'electron',
          sentAt: Date.now()
        })
        ok('interject accepted while the batch runs', res.status === 'pending')
      }
    )
    await waitFor(() => r.done)
    ok('turn ended cleanly', r.error === null, r.error ?? undefined)
    const i = userMsgAt(r.segments)
    ok('a user_message segment was emitted', i >= 0)
    const before = r.segments.slice(0, i)
    const after = r.segments.slice(i + 1)
    ok(
      'it sits after a tool_result',
      before.length > 0 && before[before.length - 1].kind === 'tool_result',
      before[before.length - 1]?.kind
    )
    ok(
      'and before the next active_model',
      after.length > 0 && after[0].kind === 'active_model',
      after[0]?.kind
    )
    ok(
      'charlie was never read after the message landed',
      !after.some((s) => s.kind === 'tool_call' && JSON.stringify(s.args).includes('charlie-3e88'))
    )
    const finalText = textOf(after)
    ok(
      'the reply ends with the marker',
      /PINEAPPLE\W*$/i.test(finalText.trim()),
      finalText.slice(-200)
    )
    // Provider-call truth: the first call AFTER delivery.
    const deliveredEv = events.find((e) => e.messageId === 'live_m1' && e.state === 'delivered')
    ok('delivered event fired', deliveredEv !== undefined)
    const postCalls = calls.slice(callsBefore)
    const carrying = postCalls.find((c) =>
      c.messages.some(
        (m: ChatMessage) => m.role === 'user' && String(m.content).includes('PINEAPPLE')
      )
    )
    ok('a provider call carries the message as a user entry', carrying !== undefined)
    if (carrying) {
      const msgs = carrying.messages as ChatMessage[]
      const idx = msgs.findIndex(
        (m) => m.role === 'user' && String(m.content).includes('PINEAPPLE')
      )
      ok(
        "right after the batch's tool messages",
        idx > 0 && msgs[idx - 1].role === 'tool',
        msgs[idx - 1]?.role
      )
      ok(
        "with the runtime notice in that call's volatile tail",
        typeof carrying.volatileStatus === 'string' &&
          carrying.volatileStatus.includes('arrived while you were working')
      )
      const next = postCalls[postCalls.indexOf(carrying) + 1]
      ok(
        'and the notice is gone on the following call',
        next === undefined ||
          !(next.volatileStatus ?? '').includes('arrived while you were working')
      )
    }
    console.log(
      `  ── final reply ──\n${finalText.trim().split('\n').slice(-4).join('\n').replace(/^/gm, '  │ ')}`
    )
  }

  // ── 2. before the first model call ─────────────────────────────────────
  console.log('\n2. message before the first model call')
  {
    const callsBefore = calls.length
    const r = run('conv_first', 'Reply with exactly the single word HELLO and nothing else.')
    const res = runner.interject('conv_first', {
      messageId: 'live_m2',
      text: 'Actually, reply with exactly the single word GOODBYE instead, nothing else.',
      attachments: [],
      channel: 'electron',
      sentAt: Date.now()
    })
    ok('interject accepted right after send()', res.status === 'pending')
    await waitFor(() => r.done)
    ok('turn ended cleanly', r.error === null, r.error ?? undefined)
    const first = calls[callsBefore]
    const users = (first?.messages ?? []).filter(
      (m: ChatMessage) => m.role === 'user' && !('volatile' in m && m.volatile)
    )
    ok('first provider call carries both user texts', users.length === 2, String(users.length))
    const i = userMsgAt(r.segments)
    ok(
      'user_message segment precedes the first active_model',
      i >= 0 && r.segments.slice(0, i).every((s) => s.kind !== 'active_model')
    )
    const text = textOf(r.segments)
    ok(
      'the reply honours the later message',
      /GOODBYE/i.test(text) && !/HELLO/i.test(text),
      text.trim()
    )
  }

  // ── 3. during the closing reply ────────────────────────────────────────
  console.log('\n3. message during the closing reply')
  {
    let interjected = false
    const r = run(
      'conv_reply',
      'Without using any tools, write a plain 250-word description of how a bicycle chain transfers power. No headings, no lists — just prose.',
      (s) => {
        if (interjected || s.kind !== 'text') return
        interjected = true
        const res = runner.interject('conv_reply', {
          messageId: 'live_m3',
          text: 'One more thing once you are done: add a final line that says exactly MANGO.',
          attachments: [],
          channel: 'electron',
          sentAt: Date.now()
        })
        ok('interject accepted while the reply streams', res.status === 'pending')
      }
    )
    await waitFor(() => r.done)
    ok('turn ended cleanly', r.error === null, r.error ?? undefined)
    const i = userMsgAt(r.segments)
    ok('a user_message segment was emitted', i >= 0)
    const after = r.segments.slice(i + 1)
    ok(
      'the turn continued: an active_model follows it',
      after.some((s) => s.kind === 'active_model')
    )
    ok(
      'the continuation carries the marker',
      /MANGO/.test(textOf(after)),
      textOf(after).slice(-120)
    )
    ok('exactly one turn_end', r.segments.filter((s) => s.kind === 'turn_end').length === 1)
    const delivered = events.find((e) => e.messageId === 'live_m3' && e.state === 'delivered')
    ok(
      'delivered, not bounced',
      delivered !== undefined &&
        !events.some((e) => e.messageId === 'live_m3' && e.state === 'withdrawn')
    )
  }

  // ── 4. an AUTONOMOUS run (automation / procedure / heartbeat) ──────────
  // The case that was broken: these runs call agent.respond() directly rather
  // than riding a TurnRunner lane, so nothing registered them as live, the
  // inbox refused every message aimed at them, and the sending window — which
  // reads `busy` for them all the same — put a bubble up and took it straight
  // back down. Proven here through the real bridge main wires.
  console.log('\n4. message during an autonomous run')
  {
    agent.setAutonomousInterjections({
      open: (conversationId) => runner.openOffLaneRun(conversationId),
      take: (conversationId, turnId) => runner.drainInterjections(conversationId, turnId),
      close: (conversationId, reason) => runner.closeOffLaneRun(conversationId, reason)
    })
    // An autonomous run has no sink of its own to hand us — it streams
    // through the message mirror, which is exactly what an open window
    // watches. Interject off that, the way a user would.
    // Typed up front: assigned only inside the mirror callback, which TS
    // narrows to `never` if the annotation is left to inference.
    const mirror: { message: { segments?: Segment[] } | null } = { message: null }
    let interjected = false
    agent.setAutonomousMessageMirror((cid, message) => {
      if (message) mirror.message = message as unknown as { segments?: Segment[] }
      if (interjected || !message) return
      if (!(message.segments ?? []).some((s) => s.kind === 'tool_result')) return
      interjected = true
      const res = runner.interject(cid, {
        messageId: 'live_m4',
        text: 'Change of plan: do NOT read the bravo file. End your final reply with the single word PAPAYA.',
        attachments: [],
        channel: 'electron',
        sentAt: Date.now()
      })
      ok('autonomous: interject accepted mid-run', res.status === 'pending')
    })
    const result = await agent
      .processAutonomous({
        instruction: `Read these two files ONE AT A TIME, each with its own separate file_read call: ${A} then ${B}. After each read, say in one short line which file you just read. Then reply with the total number of characters across them.`,
        channel: 'heartbeat',
        jobLabel: 'live-interjection-autonomous'
      })
      .catch((err) => {
        ok('autonomous: run finished without throwing', false, String(err))
        return null
      })
    ok('autonomous: something was steerable mid-run', interjected)
    // The transcript is the proof the user's own diagnostic export showed as
    // EMPTY before this fix: zero user_message segments on the run's message.
    const segments: Segment[] = (mirror.message?.segments ?? []) as Segment[]
    const i = userMsgAt(segments)
    ok('autonomous: a user_message segment reached the transcript', i >= 0)
    ok(
      'autonomous: the run read it and carried on',
      i >= 0 && segments.slice(i + 1).some((s) => s.kind === 'active_model')
    )
    ok(
      'autonomous: the reply honours the mid-run message',
      /PAPAYA/i.test(result?.response ?? textOf(segments)),
      (result?.response ?? textOf(segments)).slice(-160)
    )
    ok(
      'autonomous: delivered, not bounced',
      events.some((e) => e.messageId === 'live_m4' && e.state === 'delivered') &&
        !events.some((e) => e.messageId === 'live_m4' && e.state === 'withdrawn')
    )
    ok(
      'autonomous: the inbox closes with the run',
      result !== null && !runner.hasOffLaneRun(result.conversationId)
    )
  }

  await tick()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
