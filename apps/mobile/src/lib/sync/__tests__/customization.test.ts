jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * Soul, User and Agents over the config sync.
 *
 * These three documents are the first thing the phone edits that a person
 * would notice losing: a variable typed twice costs a retype, a soul.md
 * overwritten by a raced snapshot costs the writing. And every failure mode is
 * quiet — a save that never reached the desktop looks exactly like one that
 * did until the next refresh puts the old text back, and a snapshot landing
 * mid-edit reverts the card without a word.
 *
 * So what is pinned here is the sync contract rather than the screen: what a
 * snapshot may and may not overwrite, that a save rides Rpc.configSet under the
 * outbox's dirty window, that a refusal reverts honestly instead of leaving a
 * claim, and that an oversized document is stopped on this side rather than
 * being written locally and rejected on the wire.
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

let mockPaired = true

jest.mock('@/state/appStore', () => ({
  useAppStore: { getState: () => ({ paired: mockPaired }) }
}))

import {
  CUSTOMIZATION_MAX_BYTES,
  saveCustomizationDoc,
  useDemoConfig,
  utf8Bytes,
  type ConfigSnapshot
} from '@/state/demoConfig'
import { captureOutboxState, outboxKeysToKeepLocal, resetOutboxForTests } from '@/lib/sync/outbox'

/** A promise the test resolves by hand, to hold an RPC in flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/**
 * The smallest snapshot applySnapshot accepts — every required section, no
 * more. The customization section is what each test varies.
 */
function snapshotWith(customization?: ConfigSnapshot['customization']): ConfigSnapshot {
  return {
    capabilities: [],
    mcpServers: [],
    variables: [],
    services: {
      google: { status: 'inactive', projectId: '' },
      github: [],
      notion: [],
      braveEnabled: false,
      memesEnabled: false,
      sttModel: 'base',
      ttsVoice: 'af_bella',
      ttsSpeed: '1.0',
      screenshotMaxWidth: '1280',
      screenshotFormat: 'jpeg'
    },
    channels: {
      telegram: {
        enabled: false,
        allowedUserIds: '',
        autoRefresh: true,
        staleHours: '12',
        verbose: false,
        hideAutomations: true
      },
      whatsapp: {
        enabled: false,
        allowedNumbers: '',
        autoRefresh: true,
        staleHours: '12',
        verbose: false,
        hideAutomations: true
      }
    },
    llm: {
      brainProvider: 'anthropic',
      brainModel: 'claude-opus-4-8',
      chatMode: 'single',
      localOnly: false,
      restrictPowerfulModels: true,
      local: { enabled: false, model: null },
      providers: []
    },
    preferences: {
      launchAtStartup: true,
      bypassPermissions: false,
      blockCredentials: true,
      weekStartsOn: 1,
      updatesEnabled: true
    },
    ...(customization ? { customization } : {})
  }
}

const apply = (customization?: ConfigSnapshot['customization']): void =>
  useDemoConfig.getState().applySnapshot(snapshotWith(customization))

beforeEach(() => {
  mockRpc.mockReset()
  mockReportRpcFailure.mockClear()
  mockConnected = true
  mockPaired = true
  resetOutboxForTests()
  useDemoConfig.getState().reset()
})

describe('snapshot ingest', () => {
  it('lands all three documents verbatim', () => {
    apply({ soul: '# Soul\nbe brief', user: '# User\nYounes', agents: '# Agents\nno force push' })

    const state = useDemoConfig.getState()
    expect(state.soulMarkdown).toBe('# Soul\nbe brief')
    expect(state.userMarkdown).toBe('# User\nYounes')
    expect(state.agentsMarkdown).toBe('# Agents\nno force push')
    expect(state.customizationOversized).toEqual([])
  })

  it('lands an empty document — a file with nothing in it is not a missing one', () => {
    apply({ soul: 'written', user: '', agents: '' })

    expect(useDemoConfig.getState().soulMarkdown).toBe('written')
    expect(useDemoConfig.getState().userMarkdown).toBe('')
  })

  it('leaves the documents alone when the whole section is absent', () => {
    apply({ soul: 'from the desktop', user: 'u', agents: 'a' })
    // A bundle or desktop from before customization synced must not blank
    // three cards that describe a workspace it simply did not report on.
    apply(undefined)

    expect(useDemoConfig.getState().soulMarkdown).toBe('from the desktop')
  })

  it('keeps the last known text for an oversized document, and flags it', () => {
    apply({ soul: 'the copy this phone has', user: 'u', agents: 'a' })
    apply({ user: 'u', agents: 'a', oversized: ['soul'] })

    const state = useDemoConfig.getState()
    // No text was sent, so nothing replaces it — but the card must know not to
    // offer an editor over a document it cannot have whole.
    expect(state.soulMarkdown).toBe('the copy this phone has')
    expect(state.customizationOversized).toEqual(['soul'])
  })

  it('ignores names that are not documents in the oversized list', () => {
    apply({ soul: 's', user: 'u', agents: 'a', oversized: ['soul', 'heartbeat', ''] })

    expect(useDemoConfig.getState().customizationOversized).toEqual(['soul'])
  })
})

describe('saveCustomizationDoc', () => {
  it('applies optimistically and writes through Rpc.configSet', async () => {
    mockRpc.mockResolvedValue({ ok: true })

    await expect(saveCustomizationDoc('soul', '# Soul\nanswer first')).resolves.toBe('saved')

    expect(useDemoConfig.getState().soulMarkdown).toBe('# Soul\nanswer first')
    expect(mockRpc).toHaveBeenCalledWith('desktop.config.set', {
      settings: { soulMarkdown: '# Soul\nanswer first' }
    })
  })

  it('maps each document to its own config key', async () => {
    mockRpc.mockResolvedValue({ ok: true })

    await saveCustomizationDoc('user', 'u')
    await saveCustomizationDoc('agents', 'a')

    expect(mockRpc).toHaveBeenNthCalledWith(1, 'desktop.config.set', {
      settings: { userMarkdown: 'u' }
    })
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'desktop.config.set', {
      settings: { agentsMarkdown: 'a' }
    })
  })

  it('shields the document from a raced snapshot for the whole round trip', async () => {
    const gate = deferred<{ ok: boolean }>()
    mockRpc.mockReturnValue(gate.promise)

    // A refresh that started BEFORE the save…
    const beforeEdit = captureOutboxState()
    const saving = saveCustomizationDoc('soul', 'the new soul')
    // …and one that started while the write was in flight…
    const midFlight = captureOutboxState()

    expect(outboxKeysToKeepLocal(beforeEdit)).toEqual(['soulMarkdown'])
    expect(outboxKeysToKeepLocal(midFlight)).toEqual(['soulMarkdown'])

    // …and the snapshot each of them would apply cannot put the old text back.
    useDemoConfig
      .getState()
      .applySnapshot(snapshotWith({ soul: 'the old soul', user: '', agents: '' }), {
        keepLocal: outboxKeysToKeepLocal(beforeEdit) as Array<'soulMarkdown'>
      })
    expect(useDemoConfig.getState().soulMarkdown).toBe('the new soul')

    gate.resolve({ ok: true })
    await saving
    // Settled, and only a fetch that both starts and finishes in the quiet
    // window that follows may overwrite the document again.
    expect(outboxKeysToKeepLocal(midFlight)).toEqual(['soulMarkdown'])
    expect(outboxKeysToKeepLocal(captureOutboxState())).toEqual([])
  })

  it('reverts to desktop truth when the desktop refuses the write', async () => {
    apply({ soul: 'what the desktop holds', user: '', agents: '' })
    mockRpc.mockImplementation((method: string) => {
      if (method === 'desktop.config.set') return Promise.reject(new Error('not editable'))
      return Promise.resolve(snapshotWith({ soul: 'what the desktop holds', user: '', agents: '' }))
    })

    await expect(saveCustomizationDoc('soul', 'a soul the desktop rejected')).resolves.toBe(
      'failed'
    )

    // No retry and no lingering claim: the optimistic text is replaced by the
    // snapshot the failure path pulls, so the card stops describing a save
    // that never happened.
    expect(mockRpc).toHaveBeenCalledWith('desktop.config.snapshot')
    expect(useDemoConfig.getState().soulMarkdown).toBe('what the desktop holds')
    expect(outboxKeysToKeepLocal(captureOutboxState())).toEqual([])
  })

  it('refuses an oversized document without writing it anywhere', async () => {
    apply({ soul: 'small', user: '', agents: '' })
    const huge = 'x'.repeat(CUSTOMIZATION_MAX_BYTES + 1)

    await expect(saveCustomizationDoc('soul', huge)).resolves.toBe('too-large')

    // Not sent, and not left in this mirror looking saved either — the desktop
    // would reject it, and a local copy of a rejected document is a lie.
    expect(mockRpc).not.toHaveBeenCalled()
    expect(useDemoConfig.getState().soulMarkdown).toBe('small')
  })

  it('measures the ceiling in UTF-8 bytes, not characters', async () => {
    mockRpc.mockResolvedValue({ ok: true })
    // Well under the ceiling by length, over it by bytes: Arabic is 2 bytes a
    // letter, so a document counted by characters would sail past the desktop's
    // limit and come back as an opaque failed write.
    const arabic = 'ن'.repeat(CUSTOMIZATION_MAX_BYTES / 2 + 1)

    expect(arabic.length).toBeLessThan(CUSTOMIZATION_MAX_BYTES)
    await expect(saveCustomizationDoc('soul', arabic)).resolves.toBe('too-large')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('keeps demo-mode edits local and off the wire', async () => {
    mockPaired = false

    await expect(saveCustomizationDoc('soul', 'my own soul')).resolves.toBe('saved')

    expect(useDemoConfig.getState().soulMarkdown).toBe('my own soul')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('refuses while paired but disconnected — the desktop owns the file', async () => {
    apply({ soul: 'desktop text', user: '', agents: '' })
    mockConnected = false

    await expect(saveCustomizationDoc('soul', 'an edit with nowhere to land')).resolves.toBe(
      'failed'
    )

    expect(useDemoConfig.getState().soulMarkdown).toBe('desktop text')
    expect(mockRpc).not.toHaveBeenCalled()
  })
})

describe('utf8Bytes', () => {
  it('counts ASCII, Arabic and astral characters the way the wire does', () => {
    // The three widths that matter, plus a surrogate pair counted once.
    expect(utf8Bytes('abc')).toBe(3)
    expect(utf8Bytes('نص')).toBe(4)
    expect(utf8Bytes('€')).toBe(3)
    expect(utf8Bytes('🐟')).toBe(4)
    expect(utf8Bytes('a🐟ن')).toBe(7)
  })
})
