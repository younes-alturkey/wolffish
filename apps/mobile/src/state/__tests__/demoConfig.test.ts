jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

import {
  useDemoConfig,
  type CompactionRunRecord,
  type ConfigSnapshot,
  type DemoProvider
} from '@/state/demoConfig'

/** The minimum a snapshot must carry — every compaction field is optional. */
function snapshot(compaction?: ConfigSnapshot['compaction']): ConfigSnapshot {
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
        staleHours: '3',
        verbose: false,
        hideAutomations: true
      },
      whatsapp: {
        enabled: false,
        allowedNumbers: '',
        autoRefresh: true,
        staleHours: '3',
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
      launchAtStartup: false,
      bypassPermissions: false,
      blockCredentials: false,
      weekStartsOn: 1,
      updatesEnabled: true
    },
    compaction
  }
}

const DAILY_RUN: CompactionRunRecord = {
  at: 1785070814089,
  durationMs: 14041,
  provider: 'deepseek',
  model: 'deepseek-v4-pro',
  inputTokens: 10000,
  outputTokens: 637,
  output: 'Here are the key long-term facts from today’s log…'
}

describe('demoConfig compaction', () => {
  beforeEach(() => {
    useDemoConfig.setState({
      compactionDailyHour: 23,
      compactionWeeklyDay: 0,
      compactionWeeklyHour: 23,
      compactionRuns: { daily: null, weekly: null, reflection: null, deepClean: null }
    })
  })

  it('has no runs until a snapshot brings some', () => {
    expect(useDemoConfig.getState().compactionRuns).toEqual({
      daily: null,
      weekly: null,
      reflection: null,
      deepClean: null
    })
  })

  it('ingests the schedule and both run records', () => {
    useDemoConfig.getState().applySnapshot(
      snapshot({
        dailyHour: 16,
        weeklyDay: 5,
        weeklyHour: 17,
        runs: {
          daily: DAILY_RUN,
          weekly: {
            at: 1784901600107,
            durationMs: 21,
            provider: null,
            model: null,
            inputTokens: null,
            outputTokens: null,
            output: 'Week in review: 291 logged turns…'
          }
        }
      })
    )
    const state = useDemoConfig.getState()
    expect(state.compactionDailyHour).toBe(16)
    expect(state.compactionWeeklyDay).toBe(5)
    expect(state.compactionWeeklyHour).toBe(17)
    expect(state.compactionRuns.daily).toEqual(DAILY_RUN)
    expect(state.compactionRuns.weekly?.model).toBeNull()
  })

  // A bundle published before the cards shipped has no `compaction` key: the
  // schedule must fall back to the defaults rather than land on NaN.
  it('falls back to the defaults when the snapshot predates compaction', () => {
    useDemoConfig.getState().applySnapshot(snapshot())
    const state = useDemoConfig.getState()
    expect(state.compactionDailyHour).toBe(23)
    expect(state.compactionWeeklyDay).toBe(0)
    expect(state.compactionWeeklyHour).toBe(23)
    expect(state.compactionRuns).toEqual({
      daily: null,
      weekly: null,
      reflection: null,
      deepClean: null
    })
  })

  it('keeps a job that has never run null while the other has a record', () => {
    useDemoConfig.getState().applySnapshot(snapshot({ dailyHour: 4, runs: { daily: DAILY_RUN } }))
    const state = useDemoConfig.getState()
    expect(state.compactionDailyHour).toBe(4)
    expect(state.compactionWeeklyHour).toBe(23)
    expect(state.compactionRuns.daily?.at).toBe(DAILY_RUN.at)
    expect(state.compactionRuns.weekly).toBeNull()
  })
})

describe('demoConfig local engine', () => {
  it('takes Ollama’s state and models folder from the snapshot', () => {
    const base = snapshot()
    useDemoConfig.getState().applySnapshot({
      ...base,
      llm: { ...base.llm, local: { enabled: true, model: 'gemma4:e2b', running: true } },
      preferences: { ...base.preferences, ollamaModelsFolder: '/Users/demo/.ollama/models' }
    })
    const state = useDemoConfig.getState()
    expect(state.ollamaRunning).toBe(true)
    expect(state.localModel).toBe('gemma4:e2b')
    expect(state.ollamaModelsFolder).toBe('/Users/demo/.ollama/models')
  })

  // A bundle published before the local card reported engine state carries no
  // `running`: "not running" is the only honest reading of a probe nobody ran,
  // and a stale true from a previous sync must not survive the new snapshot.
  it('falls back to not running when the bundle predates the flag', () => {
    useDemoConfig.setState({ ollamaRunning: true })
    useDemoConfig.getState().applySnapshot(snapshot())
    const state = useDemoConfig.getState()
    expect(state.ollamaRunning).toBe(false)
    expect(state.ollamaModelsFolder).toBe('')
  })

  it('offers every model the desktop has pulled', () => {
    const base = snapshot()
    useDemoConfig.getState().applySnapshot({
      ...base,
      llm: {
        ...base.llm,
        local: {
          enabled: true,
          model: 'gemma4:e2b',
          running: true,
          models: ['deepseek-r1:8b', 'gemma4:e2b', 'qwen3.5:9b']
        }
      }
    })
    expect(useDemoConfig.getState().localModels).toEqual([
      'deepseek-r1:8b',
      'gemma4:e2b',
      'qwen3.5:9b'
    ])
  })

  // A bundle from before the tag list shipped still has to open on something:
  // the chosen model alone, never an empty sheet.
  it('falls back to the chosen model when the bundle carries no list', () => {
    const base = snapshot()
    useDemoConfig.getState().applySnapshot({
      ...base,
      llm: { ...base.llm, local: { enabled: true, model: 'gemma4:e2b' } }
    })
    expect(useDemoConfig.getState().localModels).toEqual(['gemma4:e2b'])
  })

  // Engine down, nothing pulled, or a snapshot with neither: the picker has
  // no options and the card says so instead of rendering an empty control.
  it('offers nothing when there is no model and no list', () => {
    useDemoConfig.setState({ localModels: ['stale:7b'] })
    useDemoConfig.getState().applySnapshot(snapshot())
    expect(useDemoConfig.getState().localModels).toEqual([])
  })
})

/** A snapshot carrying one provider, with whatever key state the case needs. */
function withProvider(provider: DemoProvider): ConfigSnapshot {
  const base = snapshot()
  return { ...base, llm: { ...base.llm, providers: [provider] } }
}

describe('demoConfig provider keys', () => {
  it('carries the bundle key through to the Model panel', () => {
    const apiKey = 'xai-zyThW2ITW8goiJ8sQhDuCfdA0jXk1pGKKEIvl9PnoS5Lsx'
    useDemoConfig
      .getState()
      .applySnapshot(withProvider({ id: 'xai', model: 'grok-5', hasKey: true, apiKey, models: [] }))
    expect(useDemoConfig.getState().providers[0]?.apiKey).toBe(apiKey)
  })

  // Bundles published before keys shipped carry hasKey but no apiKey — the
  // field must render empty rather than the string "undefined".
  it('leaves the key unset when the bundle predates it', () => {
    useDemoConfig
      .getState()
      .applySnapshot(withProvider({ id: 'zai', model: 'glm-5', hasKey: true, models: [] }))
    const [provider] = useDemoConfig.getState().providers
    expect(provider?.hasKey).toBe(true)
    expect(provider?.apiKey ?? '').toBe('')
  })
})

describe('demoConfig browser extension', () => {
  const extService = () =>
    useDemoConfig.getState().services.find((service) => service.key === 'browserExtension')

  it('lists every connected browser with profile, version and OS', () => {
    const base = snapshot()
    useDemoConfig.getState().applySnapshot({
      ...base,
      services: {
        ...base.services,
        browserExtension: {
          port: 23151,
          connected: true,
          browsers: [
            {
              browser: 'chrome',
              name: 'Google Chrome',
              browserVersion: '138.0.7204.97',
              os: 'macOS',
              profileEmail: 'work@company.com'
            },
            {
              browser: 'edge',
              name: 'Microsoft Edge',
              browserVersion: '139.0.3405.86',
              os: 'macOS'
            }
          ]
        }
      }
    })
    const service = extService()
    expect(service?.connected).toBe(true)
    expect(service?.connections).toEqual([
      { label: 'Google Chrome', detail: 'work@company.com · v138 · macOS' },
      { label: 'Microsoft Edge', detail: 'v139 · macOS' }
    ])
  })

  // The readiness verdict rides the same snapshot. A desktop older than
  // 1.0.300 sends none at all, and the phone must read that as "nothing to
  // say" rather than as a broken browser — the row hides itself on exactly
  // that shape, so getting this default wrong shows a permanently grey row.
  it('carries the desktop readiness verdict, and stays quiet without one', () => {
    const base = snapshot()
    useDemoConfig.getState().applySnapshot({
      ...base,
      services: {
        ...base.services,
        browserExtension: {
          port: 23151,
          connected: true,
          readiness: { ready: false, tier: 'degraded', blockers: 2, top: 'Site access is limited' }
        }
      }
    })
    expect(useDemoConfig.getState().extensionReadiness).toEqual({
      ready: false,
      tier: 'degraded',
      blockers: 2,
      top: 'Site access is limited'
    })

    useDemoConfig.getState().applySnapshot(snapshot())
    expect(useDemoConfig.getState().extensionReadiness).toEqual({
      ready: false,
      tier: 'none',
      blockers: 0,
      top: null
    })
  })

  // Bundles published before multi-browser shipped carry no browsers list —
  // the panel must fall back to the old single synthesized row, not vanish.
  it('falls back to the port row when the bundle predates multi-browser', () => {
    useDemoConfig.getState().applySnapshot(snapshot())
    const service = extService()
    expect(service?.connected).toBe(false)
    expect(service?.connections).toEqual([{ label: 'Chrome extension', detail: 'port 23151' }])
  })

  // `connected` omitted but browsers present: presence of connections is the
  // only honest reading.
  it('infers connected from a non-empty browsers list', () => {
    const base = snapshot()
    useDemoConfig.getState().applySnapshot({
      ...base,
      services: {
        ...base.services,
        browserExtension: {
          browsers: [{ browser: 'brave', name: 'Brave', browserVersion: '1.81.132', os: 'macOS' }]
        }
      }
    })
    expect(extService()?.connected).toBe(true)
  })
})

describe('demoConfig desktop data', () => {
  const FULL_DATA = {
    freeDiskBytes: 549673246720,
    totalDiskBytes: 994662584320,
    workspaceBytes: 4704356511,
    hippocampusBytes: 2557774,
    corpusBytes: 10337812,
    prefrontalBytes: 87647713,
    ramBytes: 185303040,
    totalRamBytes: 17179869184,
    // 0 is a real reading (an idle app), not a missing one — it must survive.
    cpuPercent: 0,
    cpuCount: 12
  }

  it('ingests the desktop Data-panel numbers', () => {
    useDemoConfig.getState().applySnapshot({ ...snapshot(), data: FULL_DATA })
    expect(useDemoConfig.getState().desktopData).toEqual(FULL_DATA)
  })

  // A bundle published before the Data screen's desktop card shipped has no
  // `data` key — and a stale figure from a previous sync must not survive the
  // refresh either.
  it('goes back to all-null when the bundle predates the block', () => {
    useDemoConfig.getState().applySnapshot({ ...snapshot(), data: FULL_DATA })
    useDemoConfig.getState().applySnapshot(snapshot())
    const data = useDemoConfig.getState().desktopData
    expect(data.workspaceBytes).toBeNull()
    expect(data.freeDiskBytes).toBeNull()
    expect(data.cpuCount).toBeNull()
  })

  // Hand-edited or truncated bundle: one corrupt field costs itself alone,
  // never the whole desktop card.
  it('drops a malformed figure without costing the rest', () => {
    useDemoConfig.getState().applySnapshot({
      ...snapshot(),
      data: {
        ...FULL_DATA,
        workspaceBytes: Number.NaN,
        ramBytes: -5,
        totalRamBytes: 'lots' as unknown as number
      }
    })
    const data = useDemoConfig.getState().desktopData
    expect(data.workspaceBytes).toBeNull()
    expect(data.ramBytes).toBeNull()
    expect(data.totalRamBytes).toBeNull()
    expect(data.corpusBytes).toBe(FULL_DATA.corpusBytes)
    expect(data.cpuPercent).toBe(0)
  })
})

describe('demoConfig reflection', () => {
  beforeEach(() => {
    useDemoConfig.setState({
      reflectionHour: 3,
      reflectionQuietHours: 12
    })
  })

  it('ingests the schedule and quiet gate', () => {
    useDemoConfig.getState().applySnapshot({
      ...snapshot(),
      reflection: {
        hour: 2,
        quietHours: 24
      }
    })
    const state = useDemoConfig.getState()
    expect(state.reflectionHour).toBe(2)
    expect(state.reflectionQuietHours).toBe(24)
  })

  // A bundle/desktop from before reflection shipped carries no `reflection`
  // key: the desktop defaults (3 AM / 12 h) must land, and a stale
  // non-default from a previous sync must not survive the new snapshot.
  it('falls back to the desktop defaults when the snapshot predates reflection', () => {
    useDemoConfig.setState({ reflectionHour: 22 })
    useDemoConfig.getState().applySnapshot(snapshot())
    const state = useDemoConfig.getState()
    expect(state.reflectionHour).toBe(3)
    expect(state.reflectionQuietHours).toBe(12)
  })

  it('carries the reflection and deep-clean run records beside compaction’s', () => {
    useDemoConfig.getState().applySnapshot(
      snapshot({
        runs: {
          daily: DAILY_RUN,
          reflection: { ...DAILY_RUN, output: 'Reviewed 3 conversation(s). Playbook updated.' },
          deepClean: { ...DAILY_RUN, output: 'No changes needed.' }
        }
      })
    )
    const state = useDemoConfig.getState()
    expect(state.compactionRuns.reflection?.output).toContain('Playbook updated')
    expect(state.compactionRuns.deepClean?.output).toBe('No changes needed.')
    expect(state.compactionRuns.weekly).toBeNull()
  })

  it('keeps the desktop timezone when the snapshot carries one, null otherwise', () => {
    useDemoConfig.getState().applySnapshot({
      ...snapshot(),
      desktop: { version: '1.0.20', platform: 'macOS', timezone: 'Asia/Riyadh', syncedAt: null }
    })
    expect(useDemoConfig.getState().desktop.timezone).toBe('Asia/Riyadh')
    useDemoConfig.getState().applySnapshot(snapshot())
    expect(useDemoConfig.getState().desktop.timezone).toBeNull()
  })
})

describe('demoConfig desktop changelog', () => {
  it('keeps well-formed months, newest first, and drops the rest', () => {
    useDemoConfig.getState().applySnapshot({
      ...snapshot(),
      changelog: { months: ['2026-05', '2026-08', 'not-a-month', '2026-08', '2026-07'] }
    })
    expect(useDemoConfig.getState().desktopChangelogMonths).toEqual([
      '2026-08',
      '2026-07',
      '2026-05'
    ])
  })

  it('clears the months when a snapshot stops carrying them', () => {
    useDemoConfig.getState().applySnapshot({
      ...snapshot(),
      changelog: { months: ['2026-08'] }
    })
    // A desktop from before notes synced (or a republished bundle without
    // them) must not leave last sync's months on the What's-new tab.
    useDemoConfig.getState().applySnapshot(snapshot())
    expect(useDemoConfig.getState().desktopChangelogMonths).toEqual([])
  })
})
