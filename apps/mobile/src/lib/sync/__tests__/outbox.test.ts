const mockRpc = jest.fn()
const mockConnection = { connected: true }
const mockReportRpcFailure = jest.fn()

jest.mock('@/lib/tunnel/client', () => ({
  tunnelClient: {
    get connected() {
      return mockConnection.connected
    },
    get active() {
      return mockConnection.connected ? { rpc: mockRpc, connected: true } : null
    },
    // Called lazily: the factory evaluates before this file's consts do.
    reportRpcFailure: (error: unknown) => mockReportRpcFailure(error)
  }
}))

import {
  captureOutboxState,
  outboxKeysToKeepLocal,
  pushVariables,
  resetOutboxForTests,
  setOutboxRefreshHook
} from '@/lib/sync/outbox'
import { Rpc } from '@/lib/tunnel/protocol'

/**
 * The outbox is what makes phone edits deterministic: a typing burst becomes
 * few whole-array writes, always the newest, one on the wire at a time — and
 * a snapshot that raced a write is forbidden from undoing it. Every case here
 * pins one of those promises, because each fails silently: a lost keystroke
 * or a value that snaps back mid-edit looks like nothing in a log.
 */
describe('outbox variables push', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    resetOutboxForTests()
    mockRpc.mockReset()
    mockReportRpcFailure.mockReset()
    mockConnection.connected = true
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  const row = (name: string, value = 'v'): { name: string; value: string; sensitive: boolean } => ({
    name,
    value,
    sensitive: false
  })

  it('coalesces a burst into one send carrying the last array', async () => {
    mockRpc.mockResolvedValue({ ok: true })
    pushVariables([row('A')])
    pushVariables([row('AB')])
    pushVariables([row('ABC')])
    await jest.advanceTimersByTimeAsync(400)
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith(Rpc.variablesSet, { variables: [row('ABC')] })
  })

  it('keeps one send in flight; an edit made meanwhile goes out after the ack', async () => {
    let resolveFirst!: (value: unknown) => void
    mockRpc.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
    mockRpc.mockResolvedValue({ ok: true })

    pushVariables([row('FIRST')])
    await jest.advanceTimersByTimeAsync(400)
    expect(mockRpc).toHaveBeenCalledTimes(1)

    // The user keeps typing while the first array is on the wire.
    pushVariables([row('SECOND')])
    await jest.advanceTimersByTimeAsync(400)
    expect(mockRpc).toHaveBeenCalledTimes(1) // still — one in flight

    resolveFirst({ ok: true })
    await jest.advanceTimersByTimeAsync(400)
    expect(mockRpc).toHaveBeenCalledTimes(2)
    expect(mockRpc).toHaveBeenLastCalledWith(Rpc.variablesSet, { variables: [row('SECOND')] })
    // Latest write acknowledged — nothing left to protect.
    expect(outboxKeysToKeepLocal(captureOutboxState())).toEqual([])
  })

  it('never sends nameless drafts, but an emptied list still travels', async () => {
    mockRpc.mockResolvedValue({ ok: true })
    pushVariables([row('KEEP'), row(''), row('   ')])
    await jest.advanceTimersByTimeAsync(400)
    expect(mockRpc).toHaveBeenLastCalledWith(Rpc.variablesSet, { variables: [row('KEEP')] })

    // Deleting the last named row must reach the desktop as an empty array —
    // otherwise a delete on the phone silently never happens over there.
    pushVariables([row('')])
    await jest.advanceTimersByTimeAsync(400)
    expect(mockRpc).toHaveBeenLastCalledWith(Rpc.variablesSet, { variables: [] })
  })

  it('protects the key from snapshots while dirty and across a mid-fetch settle', async () => {
    let resolveSend!: (value: unknown) => void
    mockRpc.mockImplementationOnce(() => new Promise((resolve) => (resolveSend = resolve)))

    // A fetch that started before the edit must not overwrite it…
    const beforeEdit = captureOutboxState()
    pushVariables([row('X')])
    expect(outboxKeysToKeepLocal(beforeEdit)).toContain('variables')

    // …and one that started while dirty stays blocked even if the send is
    // acknowledged before the fetch lands: the epoch moved, so the snapshot
    // may predate the write.
    await jest.advanceTimersByTimeAsync(400)
    const duringFlight = captureOutboxState()
    resolveSend({ ok: true })
    await jest.advanceTimersByTimeAsync(0)
    expect(outboxKeysToKeepLocal(duringFlight)).toContain('variables')

    // A fetch bracketing a quiet window applies desktop truth normally.
    expect(outboxKeysToKeepLocal(captureOutboxState())).toEqual([])
  })

  it('on failure abandons the claim and asks for a refresh instead of retrying', async () => {
    const refresh = jest.fn()
    setOutboxRefreshHook(refresh)
    mockRpc.mockRejectedValueOnce(new Error('desktop said no'))

    pushVariables([row('DOOMED')])
    await jest.advanceTimersByTimeAsync(400)

    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(mockReportRpcFailure).toHaveBeenCalledTimes(1)
    // The claim is gone — the refresh the hook asked for may overwrite.
    expect(outboxKeysToKeepLocal(captureOutboxState())).toEqual([])
  })

  it('does nothing while disconnected, and abandons cleanly on a mid-wait drop', async () => {
    mockConnection.connected = false
    pushVariables([row('OFFLINE')])
    await jest.advanceTimersByTimeAsync(400)
    expect(mockRpc).not.toHaveBeenCalled()

    // Connected at edit time, gone by flush time: the send is abandoned and
    // the key released — reconnect reconciles from the desktop.
    mockConnection.connected = true
    pushVariables([row('DROPPED')])
    mockConnection.connected = false
    await jest.advanceTimersByTimeAsync(400)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(outboxKeysToKeepLocal(captureOutboxState())).toEqual([])
  })
})
