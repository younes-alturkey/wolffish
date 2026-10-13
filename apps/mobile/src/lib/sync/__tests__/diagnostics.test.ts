/**
 * The Debug button's export, from the phone's side.
 *
 * The collecting is the desktop's and is tested there. What only exists here is
 * the ORCHESTRATION, and every case below is an outcome that has to reach the
 * overlay as a renderable result rather than as a thrown error — an overlay
 * that cannot be dismissed until the run settles must always get something to
 * settle on.
 *
 * The load-bearing one is the last: a failed TRANSFER is not a failed export.
 * The archive exists on the desktop either way, and telling the user their
 * bundle failed when it is sitting in their workspace sends them round the
 * whole loop again for nothing.
 */

const mockRpc = jest.fn()
let mockConnected = true
jest.mock('@/lib/tunnel/client', () => ({
  tunnelClient: {
    get active() {
      return mockConnected ? { rpc: mockRpc, onEvent: jest.fn(), connected: true } : null
    },
    get connected() {
      return mockConnected
    },
    reportRpcFailure: jest.fn()
  }
}))

const mockFetchInto = jest.fn()
jest.mock('@/lib/sync/files', () => ({
  fetchDesktopFileInto: (...args: unknown[]) => mockFetchInto(...args)
}))

jest.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache' },
  Directory: class {
    exists = false
    delete = jest.fn()
  },
  File: class {
    uri = 'file:///cache/diagnostics/bundle.zip'
  }
}))

import { exportDiagnostics, type DiagnosticPhase } from '@/lib/sync/diagnostics'
import type { DiagnosticResult } from '@/lib/tunnel/protocol'

function ready(over: Partial<DiagnosticResult> = {}): DiagnosticResult {
  return {
    ok: true,
    conversationId: 'conv-1',
    conversationTitle: 'A conversation',
    fileName: 'bundle.zip',
    zipPath: '/Users/x/workspace/diagnostics/bundle.zip',
    relativePath: 'diagnostics/bundle.zip',
    sizeBytes: 2048,
    fileCount: 12,
    durationMs: 4200,
    modelOpinion: true,
    groups: [{ key: 'logs', count: 3 }],
    warnings: [],
    ...over
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockConnected = true
  mockFetchInto.mockResolvedValue('done')
})

describe('exportDiagnostics', () => {
  it('collects on the desktop, then brings the archive down', async () => {
    mockRpc.mockResolvedValue(ready())
    const phases: DiagnosticPhase['kind'][] = []

    const done = await exportDiagnostics('conv-1', (phase) => phases.push(phase.kind))

    expect(mockRpc).toHaveBeenCalledWith('desktop.diagnostics.export', {
      conversationId: 'conv-1'
    })
    // The archive is pulled by its WORKSPACE-relative path — the desktop's
    // absolute one means nothing on a phone.
    expect(mockFetchInto.mock.calls[0][0]).toBe('diagnostics/bundle.zip')
    expect(phases).toEqual(['collecting', 'downloading'])
    expect(done.result.ok).toBe(true)
    expect(done.uri).toBe('file:///cache/diagnostics/bundle.zip')
  })

  it('reports a refused RPC as a result, never as a throw', async () => {
    mockRpc.mockRejectedValue(new Error('this desktop cannot export diagnostics'))

    const done = await exportDiagnostics('conv-1', () => undefined)

    expect(done.result.ok).toBe(false)
    expect(done.result.error).toBe('this desktop cannot export diagnostics')
    expect(done.uri).toBeNull()
    expect(mockFetchInto).not.toHaveBeenCalled()
  })

  it('says so without touching the wire when nothing is connected', async () => {
    mockConnected = false

    const done = await exportDiagnostics('conv-1', () => undefined)

    expect(done.result.ok).toBe(false)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('passes the desktop’s own failure straight through', async () => {
    mockRpc.mockResolvedValue(
      ready({ ok: false, error: 'another diagnostic export is already running', relativePath: '' })
    )

    const done = await exportDiagnostics('conv-1', () => undefined)

    expect(done.result.error).toBe('another diagnostic export is already running')
    expect(done.uri).toBeNull()
    expect(mockFetchInto).not.toHaveBeenCalled()
  })

  it('keeps a successful export whose transfer failed — the bundle still exists', async () => {
    mockRpc.mockResolvedValue(ready())
    mockFetchInto.mockResolvedValue('failed')

    const done = await exportDiagnostics('conv-1', () => undefined)

    // ok, because it IS ok: it was built and it is on the desktop. Only the
    // share step is missing, and only `uri` says so.
    expect(done.result.ok).toBe(true)
    expect(done.result.relativePath).toBe('diagnostics/bundle.zip')
    expect(done.uri).toBeNull()
  })

  it('sizes the download bar from the first frame', async () => {
    mockRpc.mockResolvedValue(ready({ sizeBytes: 2048 }))
    const phases: DiagnosticPhase[] = []

    await exportDiagnostics('conv-1', (phase) => phases.push(phase))

    const first = phases.find((phase) => phase.kind === 'downloading')
    // Total before any bytes: a bar that learns its denominator late jumps.
    expect(first).toEqual({ kind: 'downloading', receivedBytes: 0, totalBytes: 2048 })
  })
})
