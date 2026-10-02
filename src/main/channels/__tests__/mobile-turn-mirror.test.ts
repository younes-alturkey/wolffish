/**
 * What the Mobile channel PUTS ON THE WIRE while it runs a turn for the phone.
 *
 * The phone's own tests pin how it renders what arrives; this pins what
 * arrives. Between them is the contract that was broken: this channel used to
 * push a bare `{turnId, kind}` on every tool segment — "re-read the
 * conversation" — while the assistant message it was announcing was still only
 * in memory. The phone obeyed, fetched the transcript from before the turn, and
 * the reply it was streaming vanished until the end-of-turn save.
 *
 * So the assertions are about the push stream itself: that mid-turn pushes
 * carry the message rather than ask for a fetch, that they carry the id the
 * turn will be SAVED under (the phone replaces by id — anything else shows the
 * answer twice), that the phone's own message id is honoured, and that the
 * clean-feed setting still decides what a live push may contain.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/mobile-turn-mirror.test.ts
 */

import Module from 'node:module'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// workspaceRoot() reads os.homedir() at module import — override first.
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'wolffish-mobile-mirror-'))
process.env.HOME = SANDBOX

// Shim `electron` so the channel's import graph loads outside an Electron process.
const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => os.tmpdir() },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (s: string) => Buffer.from(s),
        decryptString: (b: Buffer) => b.toString()
      }
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

type RpcHandler = (params: Record<string, unknown>) => Promise<unknown> | unknown
type Push = { topic: string; payload: Record<string, unknown> }
type SinkLike = {
  onSegment: (segment: unknown) => void
  onTurnEvent: (type: string, payload: unknown) => void
  onDone: () => void
}

/** Wait for the sink's throttled mirror timer to fire. */
function afterThrottle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 600))
}

async function run(): Promise<void> {
  const { MobileChannel } = await import('@main/channels/mobile/channel')
  const { Rpc, Event } = await import('@main/tunnel/protocol')
  const { loadConversation } = await import('@main/conversations')

  const pushes: Push[] = []
  const handlers = new Map<string, RpcHandler>()
  const fakeTunnel = {
    onRpc: (method: string, handler: RpcHandler) => handlers.set(method, handler),
    emit: (topic: string, payload: Record<string, unknown>) => pushes.push({ topic, payload })
  }

  // The runner hands the channel back its own sink so the test can drive the
  // turn segment by segment, exactly as a real turn would. Kept per
  // conversation: several sends run below and each makes its own.
  const sinks = new Map<string, SinkLike>()
  // Every option the channel hands the runner, per send — the plan-mode
  // stance the phone stamps on a send has to reach the turn as `planMode`.
  const sendOpts: Array<{ conversationId: string; planMode?: boolean }> = []
  const channel = new MobileChannel({
    agent: {},
    runner: {
      send: ({
        conversationId,
        planMode,
        makeSink
      }: {
        conversationId: string
        planMode?: boolean
        makeSink: (a: { turnId: string; conversationId: string | null }) => SinkLike
      }) => {
        sendOpts.push({ conversationId, planMode })
        sinks.set(conversationId, makeSink({ turnId: 'turn_1', conversationId: null }))
        return { turnId: 'turn_1', controller: new AbortController() }
      }
    },
    serializeCapabilities: async () => []
  } as never)
  // The other half of the mirror: the same snapshots, into THIS machine's
  // window (index.ts wires this to the conversation:messageMirror broadcast).
  const windowMirrors: Array<{ conversationId: string; content: string; segments: number }> = []
  ;(
    channel as unknown as {
      setMessageMirror: (
        l: (id: string, m: { content?: string; segments?: unknown[] } | null) => void
      ) => void
    }
  ).setMessageMirror((conversationId, message) => {
    if (!message) return
    windowMirrors.push({
      conversationId,
      content: message.content ?? '',
      segments: message.segments?.length ?? 0
    })
  })
  ;(channel as unknown as { registerHandlers: (t: unknown) => void }).registerHandlers(fakeTunnel)
  // The tunnel is normally set when one connects; the push helpers read it.
  ;(channel as unknown as { tunnel: unknown }).tunnel = fakeTunnel

  const call = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const handler = handlers.get(method)
    if (!handler) throw new Error(`no handler registered for ${method}`)
    return Promise.resolve(handler(params))
  }
  const appended = (): Push[] => pushes.filter((p) => p.topic === Event.messageAppended)

  // ----------------------------------------------------- the phone sends one
  const PHONE_MESSAGE_ID = 'm_1754300000000_abc123'
  const sent = (await call(Rpc.sendMessage, {
    conversationId: null,
    messageId: PHONE_MESSAGE_ID,
    text: 'render me a chart'
  })) as { conversationId: string }
  ok('send answers with a conversation id', typeof sent.conversationId === 'string')

  // continueSend runs after the reply is on the wire.
  await new Promise((resolve) => setTimeout(resolve, 50))

  const created = await loadConversation(sent.conversationId)
  ok('a new conversation is stamped as started on mobile', created?.channel === 'mobile')
  ok(
    'a send without the field runs the turn with plan mode off',
    sendOpts.at(-1)?.planMode === false,
    JSON.stringify(sendOpts.at(-1))
  )

  // The phone's chat controls stamp `planMode: true` on a send; the turn must
  // run read-only. Anything but a literal true stays off — the wire is data.
  const planned = (await call(Rpc.sendMessage, {
    conversationId: sent.conversationId,
    text: 'plan it first',
    planMode: true
  })) as { conversationId: string }
  await new Promise((resolve) => setTimeout(resolve, 50))
  ok(
    'planMode: true on the send reaches the runner',
    sendOpts.at(-1)?.conversationId === planned.conversationId &&
      sendOpts.at(-1)?.planMode === true,
    JSON.stringify(sendOpts.at(-1))
  )
  await call(Rpc.sendMessage, {
    conversationId: sent.conversationId,
    text: 'and a hostile value',
    planMode: 'yes'
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  ok('a non-boolean planMode is off', sendOpts.at(-1)?.planMode === false)

  // The stance itself is shared: a set from the phone answers with the
  // applied value, is readable back, and fans out as Event.planMode — the
  // desktop chip and the phone switch settle on one answer. A send stamps it
  // too, so the chip follows a phone that flipped it at the send.
  pushes.length = 0
  const setOn = (await call(Rpc.planModeSet, {
    conversationId: sent.conversationId,
    planMode: true
  })) as { planMode: boolean }
  ok('planModeSet answers with the applied stance', setOn.planMode === true)
  ok(
    'planModeSet fans out as Event.planMode',
    pushes.some(
      (p) =>
        p.topic === Event.planMode &&
        p.payload.conversationId === sent.conversationId &&
        p.payload.planMode === true
    ),
    JSON.stringify(pushes.map((p) => p.topic))
  )
  const got = (await call(Rpc.planModeGet, { conversationId: sent.conversationId })) as {
    planMode: boolean
  }
  ok('planModeGet reads it back', got.planMode === true)
  pushes.length = 0
  await call(Rpc.sendMessage, {
    conversationId: sent.conversationId,
    text: 'no plan',
    planMode: false
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  ok(
    'a send without the stance turns it off and says so',
    pushes.some((p) => p.topic === Event.planMode && p.payload.planMode === false) &&
      (
        (await call(Rpc.planModeGet, { conversationId: sent.conversationId })) as {
          planMode: boolean
        }
      ).planMode === false
  )
  ok(
    "the prompt is saved under the phone's own id",
    created?.messages[0]?.id === PHONE_MESSAGE_ID,
    created?.messages[0]?.id
  )

  // A phone that predates the field still works — the desktop mints one.
  const legacy = (await call(Rpc.sendMessage, {
    conversationId: null,
    text: 'no id from me'
  })) as { conversationId: string }
  await new Promise((resolve) => setTimeout(resolve, 50))
  const legacyConv = await loadConversation(legacy.conversationId)
  ok(
    'a prompt with no id still gets one',
    /^m_\d+_[0-9a-f]{6}$/.test(legacyConv?.messages[0]?.id ?? ''),
    legacyConv?.messages[0]?.id
  )
  // A malformed id is refused rather than stored.
  const hostile = (await call(Rpc.sendMessage, {
    conversationId: null,
    messageId: '../../etc/passwd',
    text: 'hello'
  })) as { conversationId: string }
  await new Promise((resolve) => setTimeout(resolve, 50))
  const hostileConv = await loadConversation(hostile.conversationId)
  ok(
    'a malformed message id is not adopted',
    hostileConv?.messages[0]?.id !== '../../etc/passwd',
    hostileConv?.messages[0]?.id
  )

  const turn = sinks.get(sent.conversationId)
  if (!turn) {
    ok('the runner received a sink for the first send', false)
    return
  }

  // --------------------------------------------------- the turn writes itself
  pushes.length = 0
  turn.onSegment({ kind: 'text', turnId: 'turn_1', segmentId: 's1', delta: 'Working on it.' })
  const firstText = appended()
  ok('the first segment mirrors immediately', firstText.length === 1)
  const mirrored = firstText[0]?.payload.message as { id?: string; content?: string } | undefined
  ok('a mid-turn push carries the message, not a request to fetch', mirrored?.id !== undefined)
  ok('... with the text so far', mirrored?.content === 'Working on it.')
  const MIRROR_ID = mirrored?.id
  ok(
    'text also streams as deltas for token-by-token rendering',
    pushes.some((p) => p.topic === Event.messageDelta && p.payload.text === 'Working on it.')
  )

  // Tool mechanics are held back from a live push while the feed is clean...
  pushes.length = 0
  turn.onSegment({
    kind: 'tool_call',
    turnId: 'turn_1',
    segmentId: 's2',
    toolCallId: 'c1',
    name: 'chart_render',
    args: {}
  })
  await afterThrottle()
  const clean = appended().at(-1)?.payload.message as { segments?: Array<{ kind: string }> }
  ok(
    'clean feed: a tool call is not pushed live',
    (clean?.segments ?? []).every((s) => s.kind !== 'tool_call'),
    JSON.stringify(clean?.segments?.map((s) => s.kind))
  )

  // ... but the options card IS pushed: its ENTIRE content rides the call's
  // args and there is no result to fall back on, so holding the call back
  // would leave the phone with nothing to draw until the turn persisted.
  pushes.length = 0
  turn.onSegment({
    kind: 'tool_call',
    turnId: 'turn_1',
    segmentId: 's2a',
    toolCallId: 'c2',
    name: 'offer_options',
    args: {
      options: [
        { title: 'A', content: 'x' },
        { title: 'B', content: 'y' }
      ]
    }
  })
  await afterThrottle()
  const withOptions = appended().at(-1)?.payload.message as {
    segments?: Array<{ kind: string; name?: string }>
  }
  ok(
    'clean feed: the offer_options call IS pushed live',
    (withOptions?.segments ?? []).some((s) => s.kind === 'tool_call' && s.name === 'offer_options'),
    JSON.stringify(withOptions?.segments?.map((s) => s.kind))
  )

  // The user's OWN mid-turn message is not tool mechanics and is never held
  // back: the phone takes its pending bubble down the instant the `delivered`
  // push lands, so a clean feed that filtered this out made the words the user
  // had just typed vanish from the screen for the rest of the run.
  pushes.length = 0
  turn.onSegment({
    kind: 'user_message',
    turnId: 'turn_1',
    segmentId: 's2b',
    messageId: 'm_1_aaaaaa',
    text: 'actually, use the other file',
    timestamp: Date.now()
  })
  await afterThrottle()
  const withUserMessage = appended().at(-1)?.payload.message as {
    segments?: Array<{ kind: string }>
  }
  ok(
    'clean feed: a mid-turn user message IS pushed live',
    (withUserMessage?.segments ?? []).some((s) => s.kind === 'user_message'),
    JSON.stringify(withUserMessage?.segments?.map((s) => s.kind))
  )

  // ... and included once the Mobile panel's switch is on.
  await channel.setVerbose(true)
  pushes.length = 0
  turn.onSegment({
    kind: 'tool_result',
    turnId: 'turn_1',
    segmentId: 's3',
    toolCallId: 'c1',
    status: 'success',
    output: 'chart.json'
  })
  await afterThrottle()
  const verbose = appended().at(-1)?.payload.message as { segments?: Array<{ kind: string }> }
  ok(
    'verbose: the tool call and its result both ride the mirror',
    (verbose?.segments ?? []).some((s) => s.kind === 'tool_call') &&
      (verbose?.segments ?? []).some((s) => s.kind === 'tool_result'),
    JSON.stringify(verbose?.segments?.map((s) => s.kind))
  )

  // -------------------------------------------------------------- the turn ends
  // The usage events the runner relays into every sink. The renderer folds
  // these into the context-meter `stats` for its own turns; a turn started on
  // the phone has no renderer, so the channel must fold them itself or the
  // app reopens the conversation with a blank meter.
  turn.onTurnEvent('context.built', {
    tokenCount: 1200,
    tokenBudget: 200000,
    compactionAt: 150000,
    sectionsIncluded: []
  })
  turn.onTurnEvent('llm.response', {
    provider: 'anthropic',
    model: 'claude-test',
    role: 'brain',
    inputTokens: 1000,
    outputTokens: 50,
    cacheCreationTokens: 200,
    cacheReadTokens: 300,
    durationMs: 800
  })
  turn.onTurnEvent('turn.usage', {
    provider: 'anthropic',
    model: 'claude-test',
    role: 'brain',
    iterations: 1,
    toolCalls: 2,
    inputTokens: 1000,
    outputTokens: 50,
    cacheCreationTokens: 200,
    cacheReadTokens: 300,
    cacheHitRate: 0.2,
    cost: 0.0123
  })
  // The last words of a reply land INSIDE the 500ms throttle — the common case
  // for a short answer, and for the tail of any answer. The mirror that would
  // have carried them is a trailing timer, and `onDone` releases the turn's
  // slot before it can fire, so nothing was ever sent: the window kept the
  // snapshot from before (for a fast reply, the very first one — a model chip
  // with no prose, drawn as an empty bubble) and the phone's own
  // refetch-on-refresh hid the hole from every test we had.
  turn.onSegment({ kind: 'text', turnId: 'turn_1', segmentId: 's4', delta: ' Nearly' })
  turn.onSegment({ kind: 'text', turnId: 'turn_1', segmentId: 's4', delta: ' done.' })
  const windowMirrorsBeforeDone = windowMirrors.length
  pushes.length = 0
  turn.onDone()
  await new Promise((resolve) => setTimeout(resolve, 100))
  const saved = await loadConversation(sent.conversationId)
  const assistant = saved?.messages.find((m) => m.role === 'assistant')
  ok('the reply is persisted', assistant !== undefined)
  ok(
    'the finished turn is mirrored into this window once more at the end',
    windowMirrors.length === windowMirrorsBeforeDone + 1,
    `${windowMirrorsBeforeDone} → ${windowMirrors.length}`
  )
  ok(
    '... carrying exactly what was saved, not the snapshot before the last words',
    windowMirrors.at(-1)?.content === assistant?.content &&
      windowMirrors.at(-1)?.segments === (assistant?.segments?.length ?? 0),
    `${JSON.stringify(windowMirrors.at(-1))} vs ${JSON.stringify(assistant?.content)}`
  )
  ok('the context-meter stats are persisted with the reply', saved?.stats != null)
  ok(
    'the meter reads the last brain call (in + cacheRead + cacheWrite)',
    saved?.stats?.meter?.contextTokens === 1500 &&
      saved?.stats?.meter?.contextBudget === 200000 &&
      saved?.stats?.meter?.compactionAt === 150000 &&
      saved?.stats?.meter?.model === 'claude-test',
    JSON.stringify(saved?.stats?.meter)
  )
  ok(
    'last-turn + all-time roll-ups are folded',
    saved?.stats?.lastTurn?.apiCalls === 1 &&
      saved?.stats?.lastTurn?.toolCalls === 2 &&
      saved?.stats?.lastTurn?.cost === 0.0123 &&
      saved?.stats?.allTime.turns === 1 &&
      saved?.stats?.allTime.inputTokens === 1000,
    JSON.stringify(saved?.stats)
  )
  ok(
    'the saved message carries the id the phone was shown all turn',
    assistant?.id === MIRROR_ID,
    `${assistant?.id} vs ${MIRROR_ID}`
  )
  ok(
    'the end of the turn is announced after the save',
    pushes.some((p) => p.topic === Event.turnStatus && p.payload.state === 'done')
  )

  /** Close one pacing generation: mirrors are byte-paced per turn (a big
   *  snapshot buys a wait before the next), and every scenario below stands
   *  alone — as in production, where a turn boundary clears the pace record
   *  and its pending flush. The GLOBAL rail deliberately keeps charging
   *  across boundaries (bytes already on the wire don't vanish with a turn),
   *  so scenario isolation resets it by hand. */
  const endTurn = (id: string): void => {
    channel.pushTurnStatus(id, 'done')
    ;(channel as unknown as { mirrorRail: { sentAt: number; sentBytes: number } }).mirrorRail = {
      sentAt: 0,
      sentBytes: 0
    }
  }

  // ------------------------------------------------------- the oversize guard
  // An event is one frame; a push past the relay's record cap closes the
  // tunnel rather than arriving late. Too big is TRIMMED to fit — withholding
  // was the old degrade, and it is how a long tool-heavy turn went dark on
  // the phone for its whole remaining runtime.
  endTurn('conv-x')
  pushes.length = 0
  channel.pushMessageAppended('conv-x', {
    id: 'm_1_aaaaaa',
    role: 'assistant',
    content: 'x'.repeat(512 * 1024)
  })
  const guarded = appended().at(-1)
  const guardedMessage = guarded?.payload.message as { id?: string; content?: string } | undefined
  ok(
    'an oversized mirror is trimmed and sent, never withheld',
    guardedMessage !== undefined && guardedMessage.id === 'm_1_aaaaaa',
    JSON.stringify(Object.keys(guarded?.payload ?? {}))
  )
  ok(
    '... under the wire budget',
    Buffer.byteLength(JSON.stringify(guardedMessage ?? {})) <= 384 * 1024,
    String(Buffer.byteLength(JSON.stringify(guardedMessage ?? {})))
  )

  // The bulk of a real oversized snapshot is tool payloads — a few huge ones
  // (a gmail dump) get their long strings capped, and when sheer COUNT is the
  // problem the oldest payloads are elided outright while the newest stay
  // whole: the live edge is what the user is watching. Card structure (every
  // segment, in order) survives both.
  endTurn('conv-x')
  pushes.length = 0
  const bigResult = (n: number, size: number): Record<string, unknown> => ({
    kind: 'tool_result',
    turnId: 't',
    segmentId: `sr${n}`,
    toolCallId: `c${n}`,
    status: 'success',
    output: `payload-${n} ` + 'y'.repeat(size)
  })
  channel.pushMessageAppended('conv-x', {
    id: 'm_1_aaaaaa',
    role: 'assistant',
    content: 'the prose stays',
    segments: [bigResult(1, 200 * 1024), bigResult(2, 200 * 1024), bigResult(3, 200 * 1024)]
  })
  const trimmed = appended().at(-1)?.payload.message as {
    content?: string
    segments?: Array<{ kind: string; segmentId: string; output?: string }>
  }
  ok(
    'a trimmed mirror keeps every segment in order',
    (trimmed?.segments ?? []).map((s) => s.segmentId).join(',') === 'sr1,sr2,sr3',
    JSON.stringify(trimmed?.segments?.map((s) => s.segmentId))
  )
  ok('... and the prose untouched', trimmed?.content === 'the prose stays')
  ok(
    '... with each huge payload capped, its head readable',
    (trimmed?.segments ?? []).every(
      (s) => (s.output ?? '').startsWith('payload-') && (s.output ?? '').length < 4096
    ),
    JSON.stringify(trimmed?.segments?.map((s) => (s.output ?? '').length))
  )

  endTurn('conv-x')
  pushes.length = 0
  const many = Array.from({ length: 300 }, (_, i) => bigResult(i, 2_000))
  channel.pushMessageAppended('conv-x', {
    id: 'm_1_aaaaaa',
    role: 'assistant',
    content: 'still the prose',
    segments: many
  })
  const elided = appended().at(-1)?.payload.message as {
    segments?: Array<{ segmentId: string; output?: string }>
  }
  ok(
    'when count is the bulk, every card still survives',
    elided?.segments?.length === 300,
    String(elided?.segments?.length)
  )
  ok(
    '... newest payloads whole, oldest elided',
    (elided?.segments?.at(-1)?.output ?? '').startsWith('payload-299') &&
      (elided?.segments?.at(-1)?.output ?? '').length > 1_500 &&
      (elided?.segments?.[0]?.output ?? '').includes('shortened to fit the phone'),
    JSON.stringify([
      elided?.segments?.[0]?.output?.slice(0, 32),
      elided?.segments?.at(-1)?.output?.slice(0, 16)
    ])
  )

  // ------------------------------------------------------------- the prompt
  // The half that was missing. A turn run on the desktop keeps its user
  // message in the renderer's feed and writes it to disk only at the fold, so
  // the mirror is the only thing that can put it on a phone before the turn
  // ends — and a phone that pairs mid-turn sees nothing but mirror ticks.
  const PROMPT = { id: 'm_9_ccccc1', role: 'user', content: 'make me a pdf', timestamp: 9 }

  endTurn('conv-x')
  pushes.length = 0
  channel.pushMessageAppended(
    'conv-x',
    { id: 'm_1_aaaaaa', role: 'assistant', content: 'working' },
    PROMPT
  )
  const withPrompt = appended().at(-1)
  ok(
    'a mirror carries the prompt beside the answer',
    (withPrompt?.payload.userMessage as { id?: string } | undefined)?.id === PROMPT.id,
    JSON.stringify(withPrompt?.payload.userMessage)
  )

  endTurn('conv-x')
  pushes.length = 0
  channel.pushMessageAppended(
    'conv-x',
    { id: 'm_1_aaaaaa', role: 'assistant', content: 'x'.repeat(512 * 1024) },
    PROMPT
  )
  const degraded = appended().at(-1)
  ok(
    'an oversized mirror still carries the prompt beside its trimmed message',
    (degraded?.payload.message as { id?: string } | undefined)?.id === 'm_1_aaaaaa' &&
      (degraded?.payload.userMessage as { id?: string } | undefined)?.id === PROMPT.id,
    JSON.stringify(Object.keys(degraded?.payload ?? {}))
  )

  pushes.length = 0
  channel.pushMessageAppended('conv-x', undefined, PROMPT)
  const promptOnly = appended().at(-1)
  ok(
    'a prompt-only tick is a nudge plus the prompt',
    promptOnly?.payload.message === undefined &&
      (promptOnly?.payload.userMessage as { id?: string } | undefined)?.id === PROMPT.id
  )

  pushes.length = 0
  channel.pushMessageAppended('conv-x', undefined)
  ok(
    'a bare nudge stays bare — no empty prompt field on the wire',
    appended().at(-1) !== undefined && !('userMessage' in (appended().at(-1)?.payload ?? {}))
  )

  // ---------------------------------------------------------- mirror pacing
  // The rail's byte budget. The 500ms throttle bounds mirrors in TIME; the
  // pacing bounds them in BYTES — a snapshot's own size sets the earliest
  // moment of the next send, so a monster turn cannot put 768 KB/s on a
  // socket the phone drains at link speed for minutes after the turn ended.
  // Ordinary turns (snapshots under ~24 KB) never hit it: their window is
  // shorter than the throttle that already spaces them.
  const paceMsg = (label: string, pad: number): Record<string, unknown> => ({
    id: 'm_1_pace01',
    role: 'assistant',
    content: `${label} ` + 'p'.repeat(pad)
  })

  // The oversize scenarios above charged the global rail with a 384 KB send.
  endTurn('conv-x')
  pushes.length = 0
  // ~30 KB buys a ~940ms window at 32 KB/s.
  channel.pushMessageAppended('conv-pace', paceMsg('first', 30 * 1024))
  ok('the first mirror of a turn goes out immediately', appended().length === 1)
  channel.pushMessageAppended('conv-pace', paceMsg('second', 30 * 1024))
  channel.pushMessageAppended('conv-pace', paceMsg('third', 30 * 1024))
  ok(
    'ticks inside the pace window are deferred, not queued behind each other',
    appended().length === 1,
    String(appended().length)
  )
  await new Promise((resolve) => setTimeout(resolve, 1400))
  const paced = appended()
  ok(
    'the trailing flush sends the NEWEST snapshot once the window opens',
    paced.length === 2 &&
      ((paced.at(-1)?.payload.message as { content?: string })?.content ?? '').startsWith('third'),
    JSON.stringify([
      paced.length,
      (paced.at(-1)?.payload.message as { content?: string })?.content?.slice(0, 12)
    ])
  )
  ok(
    'a deferred tick still refreshes the rejoin cache ahead of its send',
    channel.turnMirrorFor('conv-pace')?.content?.startsWith('third') === true
  )

  endTurn('conv-pace')
  pushes.length = 0
  channel.pushMessageAppended('conv-park', paceMsg('big', 300 * 1024))
  channel.pushMessageAppended('conv-park', paceMsg('anchor', 100), undefined, { urgent: true })
  ok(
    "an urgent flush — a parked card's anchor — never waits out the pacing",
    appended().length === 2 &&
      ((appended().at(-1)?.payload.message as { content?: string })?.content ?? '').startsWith(
        'anchor'
      ),
    String(appended().length)
  )

  endTurn('conv-park')
  pushes.length = 0
  channel.pushMessageAppended('conv-end', paceMsg('one', 30 * 1024))
  channel.pushMessageAppended('conv-end', paceMsg('two', 30 * 1024))
  endTurn('conv-end')
  await new Promise((resolve) => setTimeout(resolve, 1400))
  ok(
    'a turn boundary drops the pending flush — no mirror lands after done',
    appended().length === 1,
    String(appended().length)
  )

  // Two conversations share ONE socket: the rail's budget is global, so a
  // second turn's mirror queues behind the first's bytes instead of doubling
  // the rate — the two-concurrent-automations case.
  endTurn('conv-end')
  pushes.length = 0
  channel.pushMessageAppended('conv-twin-a', paceMsg('atlas', 30 * 1024))
  channel.pushMessageAppended('conv-twin-b', paceMsg('borealis', 30 * 1024))
  ok(
    'concurrent conversations split the byte budget — the second defers',
    appended().length === 1,
    String(appended().length)
  )
  await new Promise((resolve) => setTimeout(resolve, 1400))
  const twins = appended()
  ok(
    "... and the second conversation's snapshot follows once the rail is clear",
    twins.length === 2 &&
      ((twins.at(-1)?.payload.message as { content?: string })?.content ?? '').startsWith(
        'borealis'
      ),
    String(twins.length)
  )
  endTurn('conv-twin-a')
  endTurn('conv-twin-b')

  // A congested local socket defers even a first, window-open mirror; the
  // flush retries until the buffer drains.
  const realTunnel = (channel as unknown as { tunnel: unknown }).tunnel
  ;(channel as unknown as { tunnel: unknown }).tunnel = {
    ...fakeTunnel,
    outboundBufferedBytes: 600 * 1024
  }
  pushes.length = 0
  channel.pushMessageAppended('conv-gate', paceMsg('gated', 1024))
  ok('a congested socket defers even a fresh mirror', appended().length === 0)
  ok(
    '... which still refreshes the rejoin cache',
    channel.turnMirrorFor('conv-gate')?.content?.startsWith('gated') === true
  )
  ;(channel as unknown as { tunnel: unknown }).tunnel = realTunnel
  await new Promise((resolve) => setTimeout(resolve, 600))
  ok(
    '... and the flush delivers it once the buffer drains',
    appended().length === 1,
    String(appended().length)
  )
  endTurn('conv-gate')

  // The delta-hole guard. A snapshot resets the phone's tail on the promise
  // that it contains every delta sent before it. The trailing flush would
  // break that promise whenever deltas kept streaming after its snapshot was
  // cached — so it must skip instead, and let the next fresh tick send.
  pushes.length = 0
  channel.pushMessageAppended('conv-hole', paceMsg('alpha', 30 * 1024))
  channel.pushMessageDelta('conv-hole', 'word ', 1)
  channel.pushMessageAppended('conv-hole', paceMsg('beta', 30 * 1024))
  channel.pushMessageDelta('conv-hole', 'more ', 2)
  await new Promise((resolve) => setTimeout(resolve, 1400))
  ok(
    'a cached snapshot older than the newest delta is never flushed',
    appended().length === 1,
    String(appended().length)
  )
  channel.pushMessageAppended('conv-hole', paceMsg('gamma', 30 * 1024))
  const holed = appended()
  ok(
    '... and the next fresh tick sends immediately into the open window',
    holed.length === 2 &&
      ((holed.at(-1)?.payload.message as { content?: string })?.content ?? '').startsWith('gamma'),
    String(holed.length)
  )
  endTurn('conv-hole')

  // ------------------------------------------------ the turn-so-far (rejoin)
  // Pushes only describe what happens next. A phone that joins — or, the
  // ordinary case, RELAUNCHES after iOS reclaimed it — mid-turn has missed
  // every one of them, and across a long tool call the next tick is minutes
  // away. Rpc.turnMirror is the recovery: the newest snapshot, the prompt it
  // answers, and the cards the turn is parked on, from the cache every mirror
  // tick maintains.
  ;(channel as unknown as { tunnel: unknown }).tunnel = { ...fakeTunnel, connected: true }
  const rendererTicks: Array<{ conversationId: string; message: { content?: string } }> = []
  channel.setMessageMirror((conversationId, message) => {
    if (message) rendererTicks.push({ conversationId, message })
  })
  const sent2 = (await call(Rpc.sendMessage, {
    conversationId: null,
    messageId: 'm_1754300000001_abc124',
    text: 'sweep my inbox'
  })) as { conversationId: string }
  await new Promise((resolve) => setTimeout(resolve, 50))
  const turn2 = sinks.get(sent2.conversationId)
  if (!turn2) {
    ok('the runner received a sink for the second send', false)
    return
  }
  turn2.onSegment({ kind: 'text', turnId: 'turn_1', segmentId: 's1', delta: 'Scanning.' })
  const soFar = (await call(Rpc.turnMirror, { conversationId: sent2.conversationId })) as {
    message: { id?: string; content?: string } | null
    userMessage?: { content?: string }
    asks: unknown[]
  }
  ok(
    'turnMirror serves the turn-so-far mid-turn',
    soFar.message?.content === 'Scanning.',
    JSON.stringify(soFar.message)
  )
  ok(
    'the renderer-side accessor answers from the same cache',
    channel.turnMirrorFor(sent2.conversationId)?.content === 'Scanning.',
    JSON.stringify(channel.turnMirrorFor(sent2.conversationId))
  )
  ok(
    '... with the prompt the turn is answering',
    soFar.userMessage?.content === 'sweep my inbox',
    JSON.stringify(soFar.userMessage)
  )
  ok(
    'a phone-run turn also mirrors into the renderer, in full',
    rendererTicks.some(
      (tick) => tick.conversationId === sent2.conversationId && tick.message.content === 'Scanning.'
    ),
    JSON.stringify(rendererTicks.length)
  )

  // Park the turn on a question: the card must be re-servable, because a
  // relaunched phone lost the original push and nothing re-sends it — the
  // desktop would otherwise wait on an answer no one can see to give.
  const asked = (
    turn2 as unknown as {
      onAskUserRequest: (req: unknown) => Promise<{ kind: string }>
    }
  ).onAskUserRequest({
    id: 'ask_test_1',
    toolCallId: 'call_ask_1',
    questions: [{ question: 'How aggressive?', options: [] }]
  })
  const parked = (await call(Rpc.turnMirror, { conversationId: sent2.conversationId })) as {
    asks: Array<{ id?: string; toolCallId?: string; questions?: unknown[] }>
  }
  ok(
    'a parked question rides the turn-so-far',
    parked.asks.length === 1 &&
      parked.asks[0]?.id === 'ask_test_1' &&
      parked.asks[0]?.toolCallId === 'call_ask_1',
    JSON.stringify(parked.asks)
  )
  await call(Rpc.askRespond, { id: 'ask_test_1', response: { kind: 'canceled' } })
  await asked

  turn2.onDone()
  await new Promise((resolve) => setTimeout(resolve, 100))
  const afterFold = (await call(Rpc.turnMirror, { conversationId: sent2.conversationId })) as {
    message: unknown
    asks: unknown[]
  }
  ok(
    'a finished turn has no turn-so-far — the stored body is the truth now',
    afterFold.message === null && afterFold.asks.length === 0,
    JSON.stringify(afterFold)
  )
  ok(
    '... and the renderer-side accessor agrees',
    channel.turnMirrorFor(sent2.conversationId) === null
  )

  // ---------------------------------------------------- oversize body serving
  // A finished tool-heavy turn can outgrow the relay's one-frame record cap,
  // and an inline answer past it does not arrive late — it closes the tunnel,
  // after which every open of the conversation kills the link again. Chunked
  // pickup serves the COMPLETE body in fileRead-shaped windows; a phone too
  // old to ask for chunks gets it trimmed to one frame instead.
  const WIRE_CEILING = 768 * 1024
  const inline = (await call(Rpc.conversationBody, {
    id: sent2.conversationId,
    chunked: true
  })) as { chunked?: boolean; messages?: unknown[] }
  ok(
    'a small body is served inline even when the phone offers to chunk',
    inline.chunked === undefined && Array.isArray(inline.messages),
    JSON.stringify(Object.keys(inline))
  )

  const { updateConversation } = await import('@main/conversations')
  const BIG = 'y'.repeat(900 * 1024)
  await updateConversation(sent2.conversationId, (disk) => {
    if (!disk) return null
    disk.messages.push({
      id: 'm_9999999_bigone',
      role: 'assistant',
      content: BIG,
      timestamp: Date.now()
    })
    return disk
  })
  const spooled = (await call(Rpc.conversationBody, {
    id: sent2.conversationId,
    chunked: true
  })) as { chunked?: boolean; bodyId?: string; sizeBytes?: number; updatedAt?: number }
  ok(
    'an oversize body answers a spool handle instead of one giant frame',
    spooled.chunked === true &&
      typeof spooled.bodyId === 'string' &&
      (spooled.sizeBytes ?? 0) > WIRE_CEILING,
    JSON.stringify(spooled)
  )
  let assembled = Buffer.alloc(0)
  let windowsUnderCap = true
  while (assembled.length < (spooled.sizeBytes ?? 0)) {
    const chunk = (await call(Rpc.conversationBodyChunk, {
      bodyId: spooled.bodyId,
      offset: assembled.length,
      length: 256 * 1024
    })) as { data: string; sizeBytes: number }
    const bytes = Buffer.from(chunk.data, 'base64url')
    if (bytes.length === 0) break
    if (bytes.length > 256 * 1024) windowsUnderCap = false
    assembled = Buffer.concat([assembled, bytes])
  }
  ok('every window stays under the chunk cap', windowsUnderCap)
  ok(
    'the windows reassemble to exactly the promised size',
    assembled.length === spooled.sizeBytes,
    `${assembled.length} vs ${spooled.sizeBytes}`
  )
  const pulledBody = JSON.parse(assembled.toString('utf8')) as {
    messages?: Array<{ id?: string; content?: string }>
  }
  ok(
    'the reassembled body is the COMPLETE conversation, nothing trimmed',
    pulledBody.messages?.at(-1)?.content === BIG,
    String(pulledBody.messages?.at(-1)?.content?.length)
  )

  const legacyBody = (await call(Rpc.conversationBody, { id: sent2.conversationId })) as {
    chunked?: boolean
    messages?: Array<{ content?: string }>
  }
  ok(
    'a phone that cannot chunk gets the body trimmed to one frame, never a dead tunnel',
    legacyBody.chunked === undefined &&
      Array.isArray(legacyBody.messages) &&
      Buffer.byteLength(JSON.stringify(legacyBody)) <= WIRE_CEILING,
    String(Buffer.byteLength(JSON.stringify(legacyBody)))
  )

  const missing = await call(Rpc.conversationBodyChunk, {
    bodyId: 'no-such-spool',
    offset: 0
  }).then(
    () => null,
    (error: Error) => error.message
  )
  ok(
    'an expired or unknown spool is an error, not silence',
    typeof missing === 'string' && missing.includes('no-such-spool'),
    String(missing)
  )

  // ------------------------------------------- what the in-app channel mirrors
  // The renderer sends the LLM's copy of the prompt: the typed text dressed in
  // an <attachments> block, and for a voice note wrapped again in <voice_note>.
  // What reaches the phone has to be what the fold will save, or the bubble
  // shows markup for the length of the turn and then silently changes.
  const { ElectronChannel } = await import('@main/channels/electron/channel')
  type MirrorCall = { message: unknown; userMessage?: { content?: string; voicePrompt?: boolean } }
  const inAppMirrors: MirrorCall[] = []
  const inApp = new ElectronChannel(
    {} as never,
    {
      send: () => ({ turnId: 'turn_e', controller: new AbortController(), done: Promise.resolve() })
    } as never
  )
  inApp.setMessageMirror((_id, message, userMessage) => inAppMirrors.push({ message, userMessage }))

  const inAppSend = (content: string): MirrorCall | undefined => {
    inAppMirrors.length = 0
    inApp.send({} as never, {
      history: [{ role: 'user', content }],
      conversationId: 'conv-e',
      userMessageId: 'm_9_ccccc1'
    })
    return inAppMirrors.at(-1)
  }

  const plain = inAppSend('make me a pdf')
  ok(
    'the prompt is mirrored at send, before a single token',
    plain?.message === null && plain?.userMessage?.content === 'make me a pdf',
    JSON.stringify(plain)
  )

  const dressed = inAppSend(
    'here is the file\n\n<attachments>\nThe user attached 1 file to this message:\n  - a.pdf (type=file)\n</attachments>'
  )
  ok(
    'the model-facing attachment block is stripped back off',
    dressed?.userMessage?.content === 'here is the file',
    JSON.stringify(dressed?.userMessage?.content)
  )

  const spoken = inAppSend('<voice_note lang="en">\nread me the plan')
  ok(
    'a voice note mirrors its transcript, not its wrapper',
    spoken?.userMessage?.content === 'read me the plan' &&
      spoken?.userMessage?.voicePrompt === true,
    JSON.stringify(spoken?.userMessage)
  )

  inAppMirrors.length = 0
  inApp.send({} as never, { history: [{ role: 'user', content: 'x' }], conversationId: 'conv-e' })
  ok('no id, no mirrored prompt — an undroppable row is worse than none', inAppMirrors.length === 0)

  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
