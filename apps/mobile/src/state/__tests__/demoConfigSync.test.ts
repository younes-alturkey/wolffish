jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

const mockRpc = jest.fn()
const mockConnection = { connected: true }

jest.mock('@/lib/tunnel/client', () => ({
  tunnelClient: {
    get connected() {
      return mockConnection.connected
    },
    get active() {
      return mockConnection.connected ? { rpc: mockRpc, connected: true } : null
    },
    reportRpcFailure: jest.fn(),
    subscribe: jest.fn(() => () => undefined)
  }
}))

import { resetOutboxForTests } from '@/lib/sync/outbox'
import { Rpc } from '@/lib/tunnel/protocol'
import { useAppStore } from '@/state/appStore'
import {
  applyVariablesPush,
  refreshConfigSnapshot,
  setConfigValue,
  useDemoConfig,
  type ConfigSnapshot,
  type DemoVariable
} from '@/state/demoConfig'

/**
 * The store half of variables sync: what a snapshot may and may not overwrite,
 * and when an edit leaves the phone at all. The failure modes pinned here are
 * the invisible ones — a draft row vanishing because an unrelated usage tick
 * refreshed config, or a keystroke undone by a snapshot that was already in
 * the air when it was typed.
 */

/** Smallest snapshot the applier accepts, with knobs where the tests look. */
function snapshotWith(overrides: {
  variables?: ConfigSnapshot['variables']
  brainModel?: string
}): ConfigSnapshot {
  return {
    capabilities: [],
    mcpServers: [],
    variables: overrides.variables ?? [],
    services: {
      google: { status: 'active', projectId: 'proj' },
      github: [],
      notion: [],
      braveEnabled: true,
      memesEnabled: true,
      sttModel: 'stt',
      ttsVoice: 'voice',
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
        hideAutomations: false
      },
      whatsapp: {
        enabled: false,
        allowedNumbers: '',
        autoRefresh: true,
        staleHours: '12',
        verbose: false,
        hideAutomations: false
      }
    },
    llm: {
      brainProvider: 'anthropic',
      brainModel: overrides.brainModel ?? 'claude-opus-4-8',
      chatMode: 'single',
      localOnly: false,
      restrictPowerfulModels: true,
      local: { enabled: false, model: null },
      providers: []
    },
    preferences: {
      launchAtStartup: false,
      bypassPermissions: false,
      blockCredentials: false,
      weekStartsOn: 1,
      updatesEnabled: true
    }
  }
}

const named = (name: string, value = 'v'): DemoVariable => ({ name, value, sensitive: false })

describe('demoConfig variables sync', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    resetOutboxForTests()
    mockRpc.mockReset()
    mockRpc.mockResolvedValue({ ok: true })
    mockConnection.connected = true
    useAppStore.setState({ paired: true })
    useDemoConfig.setState({ variables: [] })
  })

  afterEach(() => {
    jest.useRealTimers()
    useAppStore.setState({ paired: false })
  })

  it('applies snapshot variables and carries local nameless drafts along', () => {
    useDemoConfig.setState({
      variables: [named('OLD'), { name: '', value: 'half-typed', sensitive: true }]
    })
    useDemoConfig.getState().applySnapshot(snapshotWith({ variables: [named('FROM_DESKTOP')] }))
    expect(useDemoConfig.getState().variables).toEqual([
      named('FROM_DESKTOP'),
      { name: '', value: 'half-typed', sensitive: true }
    ])
  })

  it('keepLocal leaves the named key untouched while the rest of the snapshot applies', () => {
    useDemoConfig.setState({ variables: [named('MINE', 'local-truth')] })
    useDemoConfig
      .getState()
      .applySnapshot(
        snapshotWith({ variables: [named('THEIRS')], brainModel: 'claude-sonnet-5' }),
        {
          keepLocal: ['variables']
        }
      )
    expect(useDemoConfig.getState().variables).toEqual([named('MINE', 'local-truth')])
    expect(useDemoConfig.getState().brainModel).toBe('claude-sonnet-5')
  })

  it('a snapshot fetched across an edit keeps the edit; the next quiet one applies', async () => {
    // The fetch is already in the air when the user types.
    let resolveFetch!: (value: unknown) => void
    mockRpc.mockImplementationOnce(() => new Promise((resolve) => (resolveFetch = resolve)))
    const raced = refreshConfigSnapshot()
    setConfigValue('variables', [named('TYPED')])
    resolveFetch(snapshotWith({ variables: [named('STALE')] }))
    await raced
    expect(useDemoConfig.getState().variables).toEqual([named('TYPED')])

    // Let the outbox deliver and settle, then a fresh fetch applies normally.
    await jest.advanceTimersByTimeAsync(400)
    mockRpc.mockResolvedValueOnce(snapshotWith({ variables: [named('TYPED')] }))
    await refreshConfigSnapshot()
    expect(useDemoConfig.getState().variables).toEqual([named('TYPED')])
  })

  it('connected edits write through: named rows only, one coalesced send', async () => {
    setConfigValue('variables', [named('A'), { name: '', value: '', sensitive: false }])
    setConfigValue('variables', [named('AB'), { name: '', value: '', sensitive: false }])
    await jest.advanceTimersByTimeAsync(400)
    const sends = mockRpc.mock.calls.filter(([method]) => method === Rpc.variablesSet)
    expect(sends).toEqual([[Rpc.variablesSet, { variables: [named('AB')] }]])
    // The store itself keeps the draft row — only the wire filters it.
    expect(useDemoConfig.getState().variables).toEqual([
      named('AB'),
      { name: '', value: '', sensitive: false }
    ])
  })

  it('demo mode keeps edits local and never touches the wire', async () => {
    useAppStore.setState({ paired: false })
    mockConnection.connected = false
    setConfigValue('variables', [named('DEMO_ONLY')])
    await jest.advanceTimersByTimeAsync(400)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(useDemoConfig.getState().variables).toEqual([named('DEMO_ONLY')])
  })

  it('paired but disconnected refuses the edit — the read-only contract', async () => {
    mockConnection.connected = false
    setConfigValue('variables', [named('SHOULD_NOT_LAND')])
    await jest.advanceTimersByTimeAsync(400)
    expect(useDemoConfig.getState().variables).toEqual([])
    expect(mockRpc).not.toHaveBeenCalled()
  })

  // The targeted variables.changed push — the payload goes straight into the
  // store, so these pin the same contract the snapshot path has: desktop rows
  // land, drafts survive, legacy shapes normalize, and a push racing this
  // phone's own typing loses to it.
  it('a variables push lands directly and keeps local drafts', () => {
    useDemoConfig.setState({
      variables: [named('STALE'), { name: '', value: 'half-typed', sensitive: false }]
    })
    applyVariablesPush([
      named('FROM_DESKTOP'),
      // One generation of drift: {key, value} rows still render.
      { key: 'LEGACY', value: 'old-shape' } as unknown as DemoVariable
    ])
    expect(useDemoConfig.getState().variables).toEqual([
      named('FROM_DESKTOP'),
      { name: 'LEGACY', value: 'old-shape', sensitive: false },
      { name: '', value: 'half-typed', sensitive: false }
    ])
  })

  it('a variables push arriving mid-edit loses to the edit', async () => {
    // Typing in progress: the local edit queued but not yet acknowledged.
    let resolveSend!: (value: unknown) => void
    mockRpc.mockImplementationOnce(() => new Promise((resolve) => (resolveSend = resolve)))
    setConfigValue('variables', [named('TYPED_HERE')])

    applyVariablesPush([named('PUSHED_MEANWHILE')])
    expect(useDemoConfig.getState().variables).toEqual([named('TYPED_HERE')])

    // Acknowledged — the dirty window closes and the next push lands.
    await jest.advanceTimersByTimeAsync(400)
    resolveSend({ ok: true })
    await jest.advanceTimersByTimeAsync(0)
    applyVariablesPush([named('PUSHED_AFTER')])
    expect(useDemoConfig.getState().variables).toEqual([named('PUSHED_AFTER')])
  })

  it('a malformed variables push changes nothing', () => {
    useDemoConfig.setState({ variables: [named('KEEP')] })
    applyVariablesPush({ not: 'an array' })
    applyVariablesPush(undefined)
    expect(useDemoConfig.getState().variables).toEqual([named('KEEP')])
  })
})
