jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * seedActiveRuns — what this phone believes is RUNNING, the moment it connects.
 *
 * Turn lifecycle arrives as pushes and nothing else, so a tunnel that comes up
 * mid-run has already missed the only `turn.status: started` that turn will
 * ever send. Everything downstream reads "running" off the live streams (see
 * conversations/rows.ts), so that gap renders a busy conversation as idle:
 * live composer and no stop, over a turn that has not finished.
 *
 * The seed closes it, and the cases below are all the ways it must not overshoot
 * — a seed that re-opens a finished turn leaves thinking words running forever,
 * and one that re-BEGINS a turn throws away the card the user came back to
 * answer.
 */

jest.mock('@/lib/sync/sync', () => ({ fetchConversationBody: jest.fn(async () => true) }))
jest.mock('@/lib/conversations/cache', () => ({
  invalidateConversation: jest.fn(),
  invalidateConversationList: jest.fn(),
  refetchConversation: jest.fn(async () => undefined),
  conversationHasMessage: () => false
}))
jest.mock('@/lib/i18n', () => ({ __esModule: true, default: { t: (key: string) => key } }))
jest.mock('@/lib/db/database', () => ({ getDb: () => Promise.resolve({}) }))

const mockRpc = jest.fn()
let mockConnected = true
jest.mock('@/lib/tunnel/client', () => ({
  tunnelClient: {
    get active() {
      return { rpc: mockRpc, onEvent: () => undefined }
    },
    get connected() {
      return mockConnected
    }
  }
}))

import { seedActiveRuns } from '@/lib/sync/prompt'
import { Rpc } from '@/lib/tunnel/protocol'
import { useChatRuntime } from '@/state/chatRuntime'
import { useRunStatus } from '@/state/runStatus'

const RUNNING = 'conv-running'

const approval = {
  approvalId: 'ap-1',
  toolCallId: 'call-1',
  tool: 'shell',
  args: { command: 'rm -rf build' },
  reason: 'destructive',
  level: 'destructive' as const
}

beforeEach(() => {
  mockRpc.mockReset()
  mockConnected = true
  useChatRuntime.getState().reset()
  useRunStatus.getState().reset()
})

const streams = (): Record<string, ReturnType<typeof useChatRuntime.getState>['streams'][string]> =>
  useChatRuntime.getState().streams

describe('seedActiveRuns', () => {
  it('opens a live turn for a run this phone never heard start', async () => {
    mockRpc.mockResolvedValue({ conversationIds: [RUNNING] })
    await seedActiveRuns()
    expect(streams()[RUNNING]?.status).toBe('streaming')
  })

  it('re-opens a turn a reconnect only ASSUMED had ended, keeping what it had', async () => {
    // attachTurnStream force-settles on reconnect: it cannot know whether the
    // turn ended while the phone was away. The desktop says it did not.
    useChatRuntime.getState().putStream(RUNNING, {
      message: { id: 'm1', role: 'assistant', content: 'half writ', timestamp: 1 },
      base: { id: 'm1', role: 'assistant', content: 'half writ', timestamp: 1 },
      tail: 'ten',
      user: { id: 'u1', role: 'user', content: 'do it', timestamp: 0 },
      status: 'complete',
      ended: 'assumed'
    })
    useChatRuntime.getState().putApproval(RUNNING, approval)

    mockRpc.mockResolvedValue({ conversationIds: [RUNNING] })
    await seedActiveRuns()

    const live = streams()[RUNNING]
    expect(live?.status).toBe('streaming')
    expect(live?.ended).toBeUndefined()
    // Nothing about the turn is thrown away — it is the SAME turn.
    expect(live?.message.content).toBe('half writ')
    expect(live?.tail).toBe('ten')
    expect(live?.user?.id).toBe('u1')
    // And the card the user reconnected to answer is still up. beginTurn would
    // have cleared it (a fresh turn settles the previous one's questions),
    // which is why re-opening is deliberately not beginning.
    expect(useChatRuntime.getState().cards[RUNNING]?.approvals['call-1']).toBeTruthy()
  })

  it('leaves a turn the desktop CONFIRMED finished alone', async () => {
    // A terminal turn.status landed while the answer was in flight. It is the
    // newer truth; re-opening would put thinking words over a finished turn.
    useChatRuntime.getState().putStream(RUNNING, {
      message: { id: 'm1', role: 'assistant', content: 'done', timestamp: 1 },
      status: 'complete',
      ended: 'desktop'
    })
    mockRpc.mockResolvedValue({ conversationIds: [RUNNING] })
    await seedActiveRuns()
    expect(streams()[RUNNING]?.status).toBe('complete')
    expect(streams()[RUNNING]?.ended).toBe('desktop')
  })

  it('leaves a run that ended DURING the round trip alone', async () => {
    // The nastier shape of the same race: the terminal push arrives before any
    // overlay exists, so it marks only the run store and there is no stream to
    // find. Without the timestamp check the stale answer opens one that nothing
    // will ever close.
    let release: (value: unknown) => void = () => undefined
    mockRpc.mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      })
    )
    const seeding = seedActiveRuns()
    await Promise.resolve()
    useRunStatus.getState().markRun(RUNNING, 'completed')
    release({ conversationIds: [RUNNING] })
    await seeding
    expect(streams()[RUNNING]).toBeUndefined()
  })

  it('still seeds a conversation whose LAST run ended long ago', async () => {
    // The guard above must key on "ended after we asked", not "has ever ended"
    // — a conversation that ran this morning and is running again now is the
    // ordinary case.
    useRunStatus.getState().markRun(RUNNING, 'completed', Date.now() - 60_000)
    mockRpc.mockResolvedValue({ conversationIds: [RUNNING] })
    await seedActiveRuns()
    expect(streams()[RUNNING]?.status).toBe('streaming')
  })

  it('is silent on a desktop too old to answer, and on junk', async () => {
    mockRpc.mockRejectedValue(new Error('unknown method'))
    await expect(seedActiveRuns()).resolves.toBeUndefined()
    expect(streams()).toEqual({})

    mockRpc.mockResolvedValue({ conversationIds: 'nope' })
    await seedActiveRuns()
    expect(streams()).toEqual({})

    mockRpc.mockResolvedValue({ conversationIds: [null, '', 7, RUNNING] })
    await seedActiveRuns()
    expect(Object.keys(streams())).toEqual([RUNNING])
  })

  it('does nothing while disconnected', async () => {
    mockConnected = false
    await seedActiveRuns()
    expect(mockRpc).not.toHaveBeenCalled()
  })
})

/**
 * The turn-so-far recovery (Rpc.turnMirror) — what a phone that JOINED a run
 * late gets to draw. The seed above only ever opened a bare thinking row,
 * which is exactly wrong for the ordinary relaunch case: iOS reclaimed the
 * backgrounded app mid-turn, the user reopens it, and the conversation they
 * were watching — prose, cards, an open question — renders as if it had just
 * started, until a mirror tick that can be minutes away across a long tool
 * call (2026-08-22: twelve minutes of a Gmail sweep, gone from the screen).
 */
describe('seedActiveRuns turn-so-far recovery', () => {
  const SNAPSHOT = {
    message: {
      id: 'm_9_mirror',
      role: 'assistant',
      content: 'half the sweep is done',
      timestamp: 10,
      segments: [{ kind: 'text', turnId: 't', segmentId: 's1', delta: 'half the sweep is done' }]
    },
    userMessage: { id: 'u_9_prompt', role: 'user', content: 'sweep my inbox', timestamp: 5 },
    asks: [
      {
        id: 'ask_9',
        toolCallId: 'call_9',
        questions: [{ question: 'How aggressive?', options: [{ label: 'All of it' }] }]
      }
    ],
    approvals: [
      {
        id: 'ap_9',
        toolCallId: 'call_10',
        tool: 'shell',
        args: { command: 'rm x' },
        level: 'destructive',
        reason: 'deletes things'
      }
    ]
  }

  const route = (turnMirror: (params: unknown) => Promise<unknown> | unknown): void => {
    mockRpc.mockImplementation((method: string, params?: unknown) => {
      if (method === Rpc.activeRuns) return Promise.resolve({ conversationIds: [RUNNING] })
      if (method === Rpc.turnMirror) return Promise.resolve(turnMirror(params))
      return Promise.resolve({})
    })
  }

  it('redraws a relaunched phone from the desktop snapshot — message, prompt and cards', async () => {
    route(() => SNAPSHOT)
    await seedActiveRuns()

    const live = streams()[RUNNING]
    expect(live?.status).toBe('streaming')
    expect(live?.base?.id).toBe('m_9_mirror')
    expect(live?.message.content).toBe('half the sweep is done')
    expect(live?.user?.id).toBe('u_9_prompt')
    const cards = useChatRuntime.getState().cards[RUNNING]
    expect(cards?.asks['call_9']?.askId).toBe('ask_9')
    expect(cards?.asks['call_9']?.questions[0]?.question).toBe('How aggressive?')
    expect(cards?.approvals['call_10']?.approvalId).toBe('ap_9')
    expect(mockRpc).toHaveBeenCalledWith(Rpc.turnMirror, { conversationId: RUNNING })
  })

  it('lets a live push that lands mid-flight win over the answer', async () => {
    let release: (value: unknown) => void = () => undefined
    const held = new Promise((resolve) => {
      release = resolve
    })
    mockRpc.mockImplementation((method: string) => {
      if (method === Rpc.activeRuns) return Promise.resolve({ conversationIds: [RUNNING] })
      return held
    })
    const seeding = seedActiveRuns()
    // Let the seed open its placeholder and issue the turnMirror call...
    await Promise.resolve()
    await Promise.resolve()
    // ...then a mirror push beats the answer home. It is strictly newer.
    useChatRuntime.getState().putStream(RUNNING, {
      message: { id: 'm_live', role: 'assistant', content: 'fresher', timestamp: 20 },
      base: { id: 'm_live', role: 'assistant', content: 'fresher', timestamp: 20 },
      tail: '',
      status: 'streaming'
    })
    release(SNAPSHOT)
    await seeding
    expect(streams()[RUNNING]?.base?.id).toBe('m_live')
    expect(streams()[RUNNING]?.message.content).toBe('fresher')
  })

  it('keeps the placeholder row against an older desktop, junk, or an empty turn', async () => {
    route(() => {
      throw new Error('unknown method')
    })
    await seedActiveRuns()
    expect(streams()[RUNNING]?.status).toBe('streaming')
    expect(streams()[RUNNING]?.base?.id).toBeUndefined()

    useChatRuntime.getState().reset()
    route(() => ({ message: { role: 'assistant' }, asks: 'nope', approvals: 7 }))
    await seedActiveRuns()
    expect(streams()[RUNNING]?.status).toBe('streaming')
    expect(streams()[RUNNING]?.base?.id).toBeUndefined()
    expect(useChatRuntime.getState().cards[RUNNING]).toBeUndefined()

    useChatRuntime.getState().reset()
    route(() => ({ message: null, asks: [], approvals: [] }))
    await seedActiveRuns()
    expect(streams()[RUNNING]?.status).toBe('streaming')
  })

  it('does not fetch for a turn it already has a snapshot of', async () => {
    useChatRuntime.getState().putStream(RUNNING, {
      message: { id: 'm1', role: 'assistant', content: 'kept', timestamp: 1 },
      base: { id: 'm1', role: 'assistant', content: 'kept', timestamp: 1 },
      tail: '',
      status: 'complete',
      ended: 'assumed'
    })
    route(() => {
      throw new Error('should not be called')
    })
    await seedActiveRuns()
    expect(streams()[RUNNING]?.base?.id).toBe('m1')
    expect(mockRpc).not.toHaveBeenCalledWith(Rpc.turnMirror, expect.anything())
  })
})
