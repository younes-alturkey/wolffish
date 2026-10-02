/**
 * The two cards a turn run FOR THE PHONE can park on: an approval for a
 * flagged tool call, and an ask-the-user question.
 *
 * Both are promises the agent pipeline is blocked on. That is the whole risk
 * surface: the phone is not a window that is always there, so every way a
 * request can stop being answerable has to resolve it — the answer, the end of
 * the turn, an abort, a dropped tunnel, a stopped channel. Miss one and the
 * turn hangs forever with no way to reach it. These assertions are that list.
 *
 * The second contract is the record. An approval persists on the assistant
 * message, and the decision the agent actually acted on has to be the decision
 * the saved transcript shows — including the denial nobody made, when a turn
 * ends with the card still up.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/mobile-parked-cards.test.ts
 */

import Module from 'node:module'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// workspaceRoot() reads os.homedir() at module import — override first.
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'wolffish-mobile-cards-'))
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
  onApprovalRequest: (req: unknown) => Promise<string>
  onAskUserRequest?: (req: unknown) => Promise<{ kind: string; answers?: unknown }>
  onDone: () => void
}

const settle = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Has a promise resolved yet? The parked-ness of a request IS the behavior. */
async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending')
  const winner = await Promise.race([promise, settle(20).then(() => marker)])
  return winner === marker
}

async function run(): Promise<void> {
  const { MobileChannel } = await import('@main/channels/mobile/channel')
  const { Rpc, Event } = await import('@main/tunnel/protocol')
  const { loadConversation } = await import('@main/conversations')

  const pushes: Push[] = []
  const handlers = new Map<string, RpcHandler>()
  const fakeTunnel = {
    connected: true,
    onRpc: (method: string, handler: RpcHandler) => handlers.set(method, handler),
    emit: (topic: string, payload: Record<string, unknown>) => pushes.push({ topic, payload })
  }

  const sinks = new Map<string, SinkLike>()
  let nextTurnId = 0
  const channel = new MobileChannel({
    agent: {},
    runner: {
      send: ({
        conversationId,
        makeSink
      }: {
        conversationId: string
        makeSink: (a: { turnId: string; conversationId: string | null }) => SinkLike
      }) => {
        const turnId = `turn_${++nextTurnId}`
        sinks.set(conversationId, makeSink({ turnId, conversationId }))
        return { turnId, controller: new AbortController() }
      }
    },
    serializeCapabilities: async () => []
  } as never)
  ;(channel as unknown as { registerHandlers: (t: unknown) => void }).registerHandlers(fakeTunnel)
  ;(channel as unknown as { tunnel: unknown }).tunnel = fakeTunnel

  const call = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const handler = handlers.get(method)
    if (!handler) throw new Error(`no handler registered for ${method}`)
    return Promise.resolve(handler(params))
  }

  /** Start a turn from the phone and hand back its sink. */
  const startTurn = async (text: string): Promise<{ id: string; sink: SinkLike }> => {
    const sent = (await call(Rpc.sendMessage, { conversationId: null, text })) as {
      conversationId: string
    }
    await settle(50) // continueSend runs after the reply is on the wire
    const sink = sinks.get(sent.conversationId)
    if (!sink) throw new Error('the runner never received a sink')
    return { id: sent.conversationId, sink }
  }

  const approvalRequest = (id: string, toolCallId = 'call_1'): unknown => ({
    id,
    toolCall: { id: toolCallId, name: 'shell_run', args: { command: 'rm -rf build' } },
    level: 'destructive',
    reason: 'matched a destructive pattern',
    description: {
      title: 'Delete files',
      description: 'Removes the build directory',
      command: 'rm -rf build',
      impact: 'This cannot be undone.',
      risk: 'high'
    }
  })

  // ------------------------------------------------ an approval reaches the phone
  const first = await startTurn('clean the build')
  pushes.length = 0
  const decision = first.sink.onApprovalRequest(approvalRequest('appr_1'))
  await settle()

  const requested = pushes.find((p) => p.topic === Event.approvalRequest)
  ok('an approval is put to the phone', requested !== undefined)
  ok('... naming the conversation it belongs to', requested?.payload.conversationId === first.id)
  ok('... with the request id the phone answers with', requested?.payload.id === 'appr_1')
  ok('... anchored to its tool call', requested?.payload.toolCallId === 'call_1')
  ok(
    '... carrying what the card renders',
    requested?.payload.tool === 'shell_run' &&
      requested?.payload.level === 'destructive' &&
      (requested?.payload.description as { risk?: string } | undefined)?.risk === 'high'
  )
  ok('the turn is parked until the phone answers', await isPending(decision))

  // The phone approves.
  const answered = (await call(Rpc.approvalRespond, { id: 'appr_1', decision: 'approved' })) as {
    ok: boolean
  }
  ok('the answer is accepted', answered.ok === true)
  ok('the pipeline gets the decision the user made', (await decision) === 'approved')

  // Anything that is not the exact word is a denial — the wire is data.
  const second = first.sink.onApprovalRequest(approvalRequest('appr_2', 'call_2'))
  await settle()
  await call(Rpc.approvalRespond, { id: 'appr_2', decision: 'yes-please' })
  ok('an unrecognized decision is a denial', (await second) === 'denied')

  // And a decision for nothing pending says so, rather than silently vanishing.
  const late = (await call(Rpc.approvalRespond, { id: 'appr_1', decision: 'approved' })) as {
    ok: boolean
  }
  ok('a decision that arrives too late is refused', late.ok === false)

  // ---------------------------------------------------- the saved record agrees
  first.sink.onSegment({ kind: 'text', turnId: 'turn_1', segmentId: 's1', delta: 'Cleaning.' })
  first.sink.onDone()
  await settle(80)
  const saved = await loadConversation(first.id)
  const assistant = saved?.messages.find((m) => m.role === 'assistant')
  const approvals = assistant?.approvals ?? {}
  ok(
    'the approval persists on the assistant message, keyed by tool call',
    approvals.call_1 !== undefined,
    JSON.stringify(Object.keys(approvals))
  )
  ok(
    'the saved decision is the one the agent acted on',
    approvals.call_1?.decision === 'approved' && approvals.call_2?.decision === 'denied',
    JSON.stringify([approvals.call_1?.decision, approvals.call_2?.decision])
  )

  // ------------------------------------------------------- an ask, answered
  const asked = await startTurn('where should this go')
  const askRequest = {
    id: 'ask_1',
    toolCallId: 'call_ask',
    questions: [
      {
        question: 'Which database?',
        options: [{ label: 'Postgres' }, { label: 'SQLite' }],
        allowOther: true
      }
    ]
  }
  pushes.length = 0
  const response = asked.sink.onAskUserRequest?.(askRequest)
  await settle()
  const askPush = pushes.find((p) => p.topic === Event.askRequest)
  ok('the question is put to the phone', askPush?.payload.id === 'ask_1')
  ok('... anchored to its tool call', askPush?.payload.toolCallId === 'call_ask')
  ok(
    '... with the questions the card renders',
    (askPush?.payload.questions as unknown[] | undefined)?.length === 1
  )
  ok('the turn is parked until it is answered', await isPending(response as Promise<unknown>))

  await call(Rpc.askRespond, {
    id: 'ask_1',
    response: { kind: 'answered', answers: [{ kind: 'option', index: 1 }] }
  })
  const resolved = await response
  ok(
    'the pipeline gets the answer',
    resolved?.kind === 'answered' &&
      JSON.stringify(resolved.answers) === JSON.stringify([{ kind: 'option', index: 1 }]),
    JSON.stringify(resolved)
  )

  // A malformed answer list cannot be trusted to line up with the questions,
  // and a mislabeled answer is worse than none — it reads as a cancel.
  const second_ask = asked.sink.onAskUserRequest?.({ ...askRequest, id: 'ask_2' })
  await settle()
  await call(Rpc.askRespond, {
    id: 'ask_2',
    response: { kind: 'answered', answers: [{ kind: 'option', index: 'first' }] }
  })
  ok('a malformed answer is read as a cancel', (await second_ask)?.kind === 'canceled')

  // ------------------------------------------- a turn that ends still holding one
  const abandoned = await startTurn('do something risky')
  const orphan = abandoned.sink.onApprovalRequest(approvalRequest('appr_3', 'call_3'))
  const orphanAsk = abandoned.sink.onAskUserRequest?.({ ...askRequest, id: 'ask_3' })
  await settle()
  abandoned.sink.onSegment({ kind: 'text', turnId: 'turn_3', segmentId: 's1', delta: 'Trying.' })
  abandoned.sink.onDone()
  await settle(80)
  ok('an approval nobody answered is denied when the turn ends', (await orphan) === 'denied')
  ok(
    'an unanswered question is canceled when the turn ends',
    (await orphanAsk)?.kind === 'canceled'
  )
  const abandonedSaved = await loadConversation(abandoned.id)
  const abandonedAssistant = abandonedSaved?.messages.find((m) => m.role === 'assistant')
  ok(
    'the transcript records the denial nobody made',
    abandonedAssistant?.approvals?.call_3?.decision === 'denied',
    JSON.stringify(abandonedAssistant?.approvals)
  )

  // ---------------------------------------------------- the phone goes away
  const dropped = await startTurn('another risky one')
  const stranded = dropped.sink.onApprovalRequest(approvalRequest('appr_4', 'call_4'))
  const strandedAsk = dropped.sink.onAskUserRequest?.({ ...askRequest, id: 'ask_4' })
  await settle()
  ok('both are parked while the phone is there', await isPending(stranded))
  ;(
    channel as unknown as { drainTurnRequests: (t: string | null, r: string) => void }
  ).drainTurnRequests(null, 'phone disconnected')
  ok('a lost link denies the approval rather than hanging', (await stranded) === 'denied')
  ok('... and cancels the question', (await strandedAsk)?.kind === 'canceled')

  // ------------------------------------------------- nothing on the other end
  ;(channel as unknown as { tunnel: unknown }).tunnel = { ...fakeTunnel, connected: false }
  const offline = await startTurn('risky with no phone')
  const deniedOffline = await offline.sink.onApprovalRequest(approvalRequest('appr_5', 'call_5'))
  ok('with no phone connected an approval fails closed', deniedOffline === 'denied')
  const degraded = await offline.sink.onAskUserRequest?.({ ...askRequest, id: 'ask_5' })
  ok(
    'with no phone connected the question degrades to plain text, not a cancel',
    degraded?.kind === 'unsupported',
    degraded?.kind
  )

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void run().catch((error) => {
  console.error(error)
  process.exit(1)
})
