jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * "File was deleted or unavailable" must mean the file is GONE — never that
 * one transfer had a bad moment.
 *
 * The reported bug (2026-08-25): after the sync batch multiplied background
 * transfers, a fileRead timing out behind a busy socket resolved to null,
 * and useWorkspaceFile pinned that as `missing` for the life of the mount —
 * a permanent "deleted" card over a file that was fine, cleared only by
 * reopening the conversation or restarting the app. These pin the fix: a
 * transient failure keeps the loading card and retries on backoff (and on
 * the tunnel's connect edge); only an authoritative "not here" from the
 * source may render as missing.
 */

const mockResolve = jest.fn<
  Promise<{ uri: string | null; missing: boolean }>,
  [string, string | undefined]
>()
const mockStat = jest.fn((relPath: string): { uri: string; sizeBytes: number } | null => {
  void relPath
  return null
})
jest.mock('@/lib/files/fileCache', () => ({
  resolveWorkspaceFile: (relPath: string, conversationId?: string) =>
    mockResolve(relPath, conversationId),
  statCachedFile: (relPath: string) => mockStat(relPath)
}))

const mockListeners = new Set<(state: { status: string }) => void>()
let mockConnected = true
jest.mock('@/lib/tunnel/client', () => ({
  tunnelClient: {
    get connected() {
      return mockConnected
    },
    subscribe: (listener: (state: { status: string }) => void) => {
      mockListeners.add(listener)
      listener({ status: mockConnected ? 'connected' : 'connecting' })
      return () => mockListeners.delete(listener)
    }
  }
}))

import { renderHook, waitFor } from '@testing-library/react-native'
import { useWorkspaceFile } from '@/lib/files/useWorkspaceFile'

const PATH = 'uploads/conv-x/photo.png'

beforeEach(() => {
  jest.useFakeTimers()
  mockResolve.mockReset()
  mockStat.mockClear()
  mockStat.mockReturnValue(null)
  mockListeners.clear()
  mockConnected = true
})

afterEach(() => {
  jest.useRealTimers()
})

const emitConnection = (status: string): void => {
  for (const listener of [...mockListeners]) listener({ status })
}

describe('useWorkspaceFile under transfer failure', () => {
  it('a transient failure keeps loading and heals on the backoff retry', async () => {
    // First attempt: the transfer broke (timeout, flap) — NOT missing.
    mockResolve.mockResolvedValueOnce({ uri: null, missing: false })
    // The retry finds the file (and the cache now holds it).
    mockResolve.mockResolvedValue({ uri: `file:///cache/${PATH}`, missing: false })

    const { result } = await renderHook(() => useWorkspaceFile(PATH, 'conv-x'))

    await waitFor(() => expect(mockResolve).toHaveBeenCalledTimes(1))
    // The one assertion the bug violated: a failed transfer must NOT say
    // deleted — the card stays in its loading state.
    expect(result.current.missing).toBe(false)
    expect(result.current.loading).toBe(true)

    await jest.advanceTimersByTimeAsync(2_000)
    await waitFor(() => expect(result.current.uri).toBe(`file:///cache/${PATH}`))
    expect(result.current.missing).toBe(false)
    expect(result.current.loading).toBe(false)
  })

  it('an authoritative "not here" renders missing immediately, with no retry churn', async () => {
    mockResolve.mockResolvedValue({ uri: null, missing: true })

    const { result } = await renderHook(() => useWorkspaceFile(PATH, 'conv-x'))

    await waitFor(() => expect(result.current.missing).toBe(true))
    expect(result.current.loading).toBe(false)

    // Truly deleted is a settled fact — nothing keeps polling for it.
    await jest.advanceTimersByTimeAsync(120_000)
    expect(mockResolve).toHaveBeenCalledTimes(1)
  })

  it('after the backoff is spent, the connect edge retries with a fresh round', async () => {
    mockResolve.mockResolvedValue({ uri: null, missing: false })

    const { result } = await renderHook(() => useWorkspaceFile(PATH, 'conv-x'))
    await waitFor(() => expect(mockResolve).toHaveBeenCalledTimes(1))

    // Burn through the whole backoff ladder: 2s, 6s, 15s.
    await jest.advanceTimersByTimeAsync(2_000)
    await waitFor(() => expect(mockResolve).toHaveBeenCalledTimes(2))
    await jest.advanceTimersByTimeAsync(6_000)
    await waitFor(() => expect(mockResolve).toHaveBeenCalledTimes(3))
    await jest.advanceTimersByTimeAsync(15_000)
    await waitFor(() => expect(mockResolve).toHaveBeenCalledTimes(4))

    // Spent: time alone brings nothing more…
    await jest.advanceTimersByTimeAsync(120_000)
    expect(mockResolve).toHaveBeenCalledTimes(4)
    expect(result.current.loading).toBe(true)
    expect(result.current.missing).toBe(false)

    // …but the tunnel coming back is a fresh reason to try, and this time
    // the file arrives.
    mockResolve.mockResolvedValue({ uri: `file:///cache/${PATH}`, missing: false })
    mockConnected = false
    emitConnection('connecting')
    mockConnected = true
    emitConnection('connected')
    await waitFor(() => expect(result.current.uri).toBe(`file:///cache/${PATH}`))
  })
})
