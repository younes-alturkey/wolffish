jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * The capability toggle write path — the one settings edit the Capabilities
 * screen performs against the desktop, riding the outbox echo-guard.
 *
 * Every failure mode here is silent by nature: a switch that flips locally
 * but never lands on the desktop looks exactly like a successful edit until
 * the next sync quietly undoes it, and a snapshot raced against the flip
 * would undo it immediately. So what is pinned is who gets written when —
 * demo edits stay local, paired edits go over the wire, disconnected edits
 * are refused — plus the guard itself: while a toggle is unacknowledged the
 * 'capabilities' key must read as keep-local, and a failed or refused send
 * must end in a corrective refresh, never a silent claim.
 */

const mockRpc = jest.fn()
const mockReportRpcFailure = jest.fn()
let mockConnected = true

jest.mock('@/lib/tunnel/client', () => ({
  tunnelClient: {
    get active() {
      return mockConnected ? { rpc: mockRpc, connected: true } : null
    },
    get connected() {
      return mockConnected
    },
    reportRpcFailure: (error: unknown) => mockReportRpcFailure(error)
  }
}))

const mockStore = {
  capabilities: {} as Record<string, boolean>,
  setMapEntry: jest.fn((key: string, name: string, enabled: boolean) => {
    mockStore.capabilities[name] = enabled
  }),
  applySnapshot: jest.fn()
}

jest.mock('@/state/demoConfig', () => ({
  useDemoConfig: { getState: () => mockStore },
  refreshConfigSnapshot: jest.fn()
}))

let mockPaired = true

jest.mock('@/state/appStore', () => ({
  useAppStore: { getState: () => ({ paired: mockPaired }) }
}))

jest.mock('@/lib/db/database', () => ({ getDb: jest.fn() }))
jest.mock('@/lib/conversations/cache', () => ({
  invalidateConversation: jest.fn(),
  invalidateConversationList: jest.fn()
}))

import { setCapabilityEnabled } from '@/lib/sync/sync'
import {
  captureOutboxState,
  outboxKeysToKeepLocal,
  resetOutboxForTests,
  setOutboxRefreshHook
} from '@/lib/sync/outbox'

/** Let the fire-and-forget send chain settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** A promise the test resolves by hand, to hold an RPC in flight. */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const refreshSpy = jest.fn()

beforeEach(() => {
  mockStore.capabilities = {}
  mockStore.setMapEntry.mockClear()
  mockRpc.mockReset()
  mockReportRpcFailure.mockClear()
  refreshSpy.mockClear()
  mockConnected = true
  mockPaired = true
  resetOutboxForTests()
  setOutboxRefreshHook(refreshSpy)
})

describe('setCapabilityEnabled', () => {
  it('keeps demo-mode edits local and off the wire', async () => {
    mockPaired = false
    setCapabilityEnabled('web-search', false)
    await flush()

    expect(mockStore.capabilities['web-search']).toBe(false)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(outboxKeysToKeepLocal(captureOutboxState())).toEqual([])
  })

  it('applies optimistically and sends the toggle to the desktop', async () => {
    mockRpc.mockResolvedValue({ ok: true, enabled: false })
    setCapabilityEnabled('web-search', false)

    // The switch must answer the finger before the wire answers the switch.
    expect(mockStore.capabilities['web-search']).toBe(false)
    await flush()
    expect(mockRpc).toHaveBeenCalledWith('desktop.capabilities.set', {
      name: 'web-search',
      enabled: false
    })
    // Acknowledged and quiet — a fresh refresh may overwrite again.
    expect(outboxKeysToKeepLocal(captureOutboxState())).toEqual([])
    expect(refreshSpy).not.toHaveBeenCalled()
  })

  it('shields the key from a raced snapshot for the whole dirty window', async () => {
    const gate = deferred<{ ok: boolean; enabled: boolean }>()
    mockRpc.mockReturnValue(gate.promise)

    // A refresh that started BEFORE the flip…
    const beforeEdit = captureOutboxState()
    setCapabilityEnabled('web-search', false)
    // …and one that started while the send is in flight…
    const midFlight = captureOutboxState()

    expect(outboxKeysToKeepLocal(beforeEdit)).toEqual(['capabilities'])
    expect(outboxKeysToKeepLocal(midFlight)).toEqual(['capabilities'])

    gate.resolve({ ok: true, enabled: false })
    await flush()
    // Even a fetch that spanned the settlement reads as raced — only one that
    // both starts and finishes in a quiet window may overwrite.
    expect(outboxKeysToKeepLocal(midFlight)).toEqual(['capabilities'])
    expect(outboxKeysToKeepLocal(captureOutboxState())).toEqual([])
  })

  it('coalesces a double-flip into first state out, final state next', async () => {
    const first = deferred<{ ok: boolean; enabled: boolean }>()
    mockRpc.mockReturnValueOnce(first.promise).mockResolvedValue({ ok: true, enabled: true })

    setCapabilityEnabled('web-search', false)
    setCapabilityEnabled('web-search', true)

    expect(mockRpc).toHaveBeenCalledTimes(1)
    first.resolve({ ok: true, enabled: false })
    await flush()

    expect(mockRpc).toHaveBeenCalledTimes(2)
    expect(mockRpc).toHaveBeenLastCalledWith('desktop.capabilities.set', {
      name: 'web-search',
      enabled: true
    })
    expect(outboxKeysToKeepLocal(captureOutboxState())).toEqual([])
  })

  it('abandons the claim and asks for a refresh when the send fails', async () => {
    mockRpc.mockRejectedValue(new Error('desktop.capabilities.set timed out'))
    setCapabilityEnabled('web-search', false)
    await flush()

    // No retry: the desktop is the source of truth, and the corrective
    // refresh puts its state back under the switch.
    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(mockReportRpcFailure).toHaveBeenCalled()
    expect(outboxKeysToKeepLocal(captureOutboxState())).toEqual([])
  })

  it('asks for a refresh when the desktop refuses the flip', async () => {
    // A locked core capability answers enabled: true whatever was asked.
    mockRpc.mockResolvedValue({ ok: true, enabled: true })
    setCapabilityEnabled('memory', false)
    await flush()

    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(outboxKeysToKeepLocal(captureOutboxState())).toEqual([])
  })

  it('refuses while paired but disconnected — the desktop owns these values', async () => {
    mockConnected = false
    mockStore.capabilities['web-search'] = true
    setCapabilityEnabled('web-search', false)
    await flush()

    expect(mockStore.capabilities['web-search']).toBe(true)
    expect(mockStore.setMapEntry).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })
})
