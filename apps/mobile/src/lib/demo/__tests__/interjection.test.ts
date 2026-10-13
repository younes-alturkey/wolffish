jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * The mid-turn send with no desktop behind it.
 *
 * Demo runs its agent on this phone, so it is the turn runner AND the inbox:
 * a message sent while a demo turn is thinking parks on that turn and is read
 * at its one stop point, becoming a `user_message` segment on the assistant
 * message exactly as the desktop's does.
 *
 * What it must never do is start a SECOND turn. This module keeps one live
 * stream and one timer per conversation, so two overlapping turns would share
 * both: the first to finish would end the other's overlay and delete its
 * entry, leaving a reply with no card on screen and a Stop that stops nothing.
 * That is why the screen does not exempt demo from the mid-turn path
 * (app/chat.tsx handleSubmit) and why this file exists.
 */

const appended: { conversationId: string; message: Record<string, unknown> }[] = []
jest.mock('@/lib/conversations/repo', () => ({
  appendMessage: jest.fn(async (conversationId: string, message: Record<string, unknown>) => {
    appended.push({ conversationId, message })
  }),
  createConversation: jest.fn(async () => undefined),
  getConversationStats: jest.fn(async () => null),
  updateConversationStats: jest.fn(async () => undefined)
}))
jest.mock('@/lib/conversations/cache', () => ({
  refetchConversation: jest.fn(async () => undefined)
}))
jest.mock('@/lib/i18n', () => ({ __esModule: true, default: { t: (key: string) => key } }))
jest.mock('@/state/runStatus', () => ({ markRun: jest.fn() }))

import {
  demoInterject,
  isTurnActive,
  sendDemoPrompt,
  stopDemoTurn,
  withdrawDemoInterjection
} from '@/lib/demo/agent'
import type { Segment } from '@/lib/conversations/types'
import { useChatRuntime } from '@/state/chatRuntime'

const CONVERSATION = 'conv-demo'
const ID = 'm_1700000000000_abc123'

/** The assistant message the finished turn stored, as segments. */
const storedSegments = (): Segment[] => {
  const assistant = [...appended].reverse().find((row) => row.message.role === 'assistant')
  return (assistant?.message.segments ?? []) as Segment[]
}

const pendingIds = (): string[] =>
  (useChatRuntime.getState().pending[CONVERSATION] ?? []).map((m) => m.id ?? '')

/** Let the turn's timer fire and its async finish settle. */
async function runTurnToEnd(): Promise<void> {
  jest.runOnlyPendingTimers()
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

beforeEach(async () => {
  jest.useFakeTimers()
  appended.length = 0
  useChatRuntime.setState({ streams: {}, pending: {}, draftRestores: {} })
  await sendDemoPrompt({ conversationId: CONVERSATION, text: 'do the thing' })
})

afterEach(() => {
  jest.useRealTimers()
})

describe('parking a message on a running demo turn', () => {
  it('takes it while the turn is thinking and refuses it once there is none', async () => {
    expect(isTurnActive(CONVERSATION)).toBe(true)
    expect(
      demoInterject(CONVERSATION, { messageId: ID, text: 'skip the tests', timestamp: 1 })
    ).toBe(true)

    await runTurnToEnd()
    expect(isTurnActive(CONVERSATION)).toBe(false)
    // Nothing to park it on now — the caller sends it as an ordinary prompt,
    // the same answer the desktop gives with `no_live_turn`.
    expect(demoInterject(CONVERSATION, { messageId: 'm_2', text: 'too late', timestamp: 2 })).toBe(
      false
    )
  })

  it('reads it into the assistant message, ahead of the reply', async () => {
    demoInterject(CONVERSATION, { messageId: ID, text: 'skip the tests', timestamp: 1 })
    await runTurnToEnd()

    const segments = storedSegments()
    const read = segments.find((s) => s.kind === 'user_message')
    expect(read).toMatchObject({ kind: 'user_message', messageId: ID, text: 'skip the tests' })
    // Before the reply text: the user's words at the point they were taken in.
    const kinds = segments.map((s) => s.kind)
    expect(kinds.indexOf('user_message')).toBeLessThan(kinds.indexOf('text'))
  })

  it('takes the pending row down once the turn has read it', async () => {
    useChatRuntime
      .getState()
      .putPending(CONVERSATION, { id: ID, role: 'user', content: 'skip', timestamp: 1 })
    demoInterject(CONVERSATION, { messageId: ID, text: 'skip', timestamp: 1 })
    expect(pendingIds()).toEqual([ID])

    await runTurnToEnd()
    expect(pendingIds()).toEqual([])
  })

  it('never lets a mid-turn message become a second turn', async () => {
    demoInterject(CONVERSATION, { messageId: ID, text: 'skip', timestamp: 1 })
    await runTurnToEnd()
    // One assistant message for the one turn — not two.
    expect(appended.filter((row) => row.message.role === 'assistant')).toHaveLength(1)
  })
})

describe('taking it back before the turn reads it', () => {
  it('hands the words to the composer when the user withdraws it', () => {
    useChatRuntime
      .getState()
      .putPending(CONVERSATION, { id: ID, role: 'user', content: 'skip', timestamp: 1 })
    demoInterject(CONVERSATION, { messageId: ID, text: 'skip', timestamp: 1 })

    const taken = withdrawDemoInterjection(CONVERSATION, ID)
    expect(taken?.text).toBe('skip')
    // Withdrawn twice is not withdrawn twice.
    expect(withdrawDemoInterjection(CONVERSATION, ID)).toBeNull()
  })

  it('gives back everything still parked when the turn is stopped', async () => {
    useChatRuntime
      .getState()
      .putPending(CONVERSATION, { id: ID, role: 'user', content: 'skip', timestamp: 1 })
    demoInterject(CONVERSATION, { messageId: ID, text: 'skip', timestamp: 1 })

    stopDemoTurn(CONVERSATION)
    expect(pendingIds()).toEqual([])
    expect(useChatRuntime.getState().draftRestores[CONVERSATION]).toBe('skip')
    // And it is gone from the inbox, so a later turn cannot read it.
    expect(withdrawDemoInterjection(CONVERSATION, ID)).toBeNull()
  })

  it('keeps a voice note out of the composer — its words are its transcript', () => {
    demoInterject(CONVERSATION, {
      messageId: ID,
      text: '',
      voicePrompt: true,
      timestamp: 1
    })
    stopDemoTurn(CONVERSATION)
    expect(useChatRuntime.getState().draftRestores[CONVERSATION]).toBeUndefined()
  })
})
