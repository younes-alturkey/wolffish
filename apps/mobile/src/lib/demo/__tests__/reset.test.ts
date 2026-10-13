jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * The purge is what makes "new demo version" mean the same thing on a phone
 * that already entered demo mode as on a fresh install. Every miss here is
 * silent: an old conversation that survives a refresh looks exactly like a
 * real one, and the only way to notice is to compare the device against the
 * CDN by hand. These tests pin the full surface — and the ordering that keeps
 * a half-finished wipe recoverable.
 */

const mockExecSql = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined)
const mockDeleted: string[] = []
const mockMissing = new Set<string>()

jest.mock('@/lib/db/database', () => ({
  getDb: () => Promise.resolve({ execAsync: (sql: string) => mockExecSql(sql) })
}))

jest.mock('expo-file-system', () => ({
  Paths: { document: 'file:///doc', cache: 'file:///cache' },
  Directory: class {
    uri: string
    constructor(root: string, name: string) {
      this.uri = `${root}/${name}`
    }
    get exists(): boolean {
      return !mockMissing.has(this.uri)
    }
    delete(): void {
      mockDeleted.push(this.uri)
    }
  }
}))

import AsyncStorage from '@react-native-async-storage/async-storage'
import { purgeDemoState } from '@/lib/demo/reset'
import { QUERY_CACHE_KEY, queryClient } from '@/lib/query/queryClient'
import { useAppStore } from '@/state/appStore'
import { useChatRuntime } from '@/state/chatRuntime'
import { useDemoConfig } from '@/state/demoConfig'

describe('demo state purge', () => {
  beforeEach(() => {
    mockExecSql.mockClear().mockResolvedValue(undefined)
    mockDeleted.length = 0
    mockMissing.clear()
  })

  it('clears the version first, so an interrupted wipe reads as "nothing imported"', async () => {
    const order: string[] = []
    useAppStore.setState({ demoVersion: 'old-version' })
    mockExecSql.mockImplementation(() => {
      order.push(`version:${useAppStore.getState().demoVersion}`)
      return Promise.resolve()
    })

    await purgeDemoState()

    // The version is already null by the time the first destructive step runs.
    expect(order).toEqual(['version:null'])
    expect(useAppStore.getState().demoVersion).toBeNull()
  })

  it('drops every conversation, message and cached-file row', async () => {
    await purgeDemoState()
    const sql = mockExecSql.mock.calls[0][0]
    expect(sql).toContain('DELETE FROM messages')
    expect(sql).toContain('DELETE FROM conversations')
    expect(sql).toContain('DELETE FROM cached_files')
  })

  it('deletes the media cache, the saved snapshot and the download scratch', async () => {
    await purgeDemoState()
    expect(mockDeleted).toEqual([
      'file:///doc/workspace',
      'file:///doc/demo',
      'file:///cache/downloads'
    ])
  })

  it('skips a directory that is not there', async () => {
    mockMissing.add('file:///doc/demo')
    await purgeDemoState()
    expect(mockDeleted).toEqual(['file:///doc/workspace', 'file:///cache/downloads'])
  })

  it('resets the config store, including edits made on this device', async () => {
    useDemoConfig.setState({
      brainModel: 'edited-by-hand',
      thinkingMode: 'max',
      capabilityInfo: {
        gone: {
          description: 'from the old bundle',
          official: true,
          core: false,
          hasPlugin: false,
          toolCount: 0,
          requires: []
        }
      },
      projects: [
        {
          id: 'p1',
          title: 'deleted upstream',
          icon: '📦',
          instructions: '',
          files: [],
          createdAt: 0,
          updatedAt: 0
        }
      ]
    })

    await purgeDemoState()

    const state = useDemoConfig.getState()
    expect(state.brainModel).toBe('claude-opus-4-8')
    expect(state.thinkingMode).toBe('high')
    expect(state.capabilityInfo).toEqual({})
    expect(state.projects).toEqual([])
    expect(state.desktop).toEqual({
      version: null,
      platform: null,
      syncedAt: null,
      timezone: null
    })
  })

  it('drops in-flight streams that point at conversations being replaced', async () => {
    useChatRuntime.getState().startStream('c1', {
      id: 'm1',
      role: 'assistant',
      content: 'mid-turn',
      timestamp: 1
    })
    useChatRuntime.getState().setPendingProject('p1')

    await purgeDemoState()

    expect(useChatRuntime.getState().streams).toEqual({})
    expect(useChatRuntime.getState().pendingProjectId).toBeNull()
  })

  it('clears the query cache in memory and on disk', async () => {
    queryClient.setQueryData(['data-usage'], { cache: { totalBytes: 1, fileCount: 1 } })
    await AsyncStorage.setItem(QUERY_CACHE_KEY, '{"stale":true}')

    await purgeDemoState()

    expect(queryClient.getQueryData(['data-usage'])).toBeUndefined()
    expect(await AsyncStorage.getItem(QUERY_CACHE_KEY)).toBeNull()
  })

  it('finishes the wipe even when the database refuses', async () => {
    mockExecSql.mockRejectedValue(new Error('database is locked'))
    await expect(purgeDemoState()).resolves.toBeUndefined()
    expect(mockDeleted).toHaveLength(3)
    expect(useDemoConfig.getState().capabilityInfo).toEqual({})
  })
})
