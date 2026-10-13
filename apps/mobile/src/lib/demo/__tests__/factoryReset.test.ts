jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * The factory reset is purgeDemoState plus leaving demo mode — these tests
 * pin the two facts the screen's copy promises: the wipe stops at this
 * device's data, and the phone's own preferences (theme, language, OTA)
 * survive it, the same carve-out the desktop reset makes.
 */

const mockExecSql = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined)

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
      return true
    }
    delete(): void {}
  }
}))

import { factoryResetDevice } from '@/lib/demo/factoryReset'
import { useAppStore } from '@/state/appStore'
import { useDemoConfig } from '@/state/demoConfig'

describe('factory reset (this device only)', () => {
  beforeEach(() => {
    mockExecSql.mockClear().mockResolvedValue(undefined)
  })

  it('wipes the dataset and leaves demo mode', async () => {
    useAppStore.setState({ demoMode: true, demoVersion: 'abc123' })
    useDemoConfig.setState({ brainModel: 'edited-on-this-phone' })

    await factoryResetDevice()

    expect(useAppStore.getState().demoMode).toBe(false)
    expect(useAppStore.getState().demoVersion).toBeNull()
    expect(useDemoConfig.getState().brainModel).toBe('claude-opus-4-8')
    expect(mockExecSql.mock.calls[0][0]).toContain('DELETE FROM conversations')
  })

  it('preserves theme, language and the OTA switch', async () => {
    useAppStore.setState({
      demoMode: true,
      demoVersion: 'abc123',
      theme: 'dark',
      locale: 'ar',
      otaEnabled: false
    })

    await factoryResetDevice()

    const state = useAppStore.getState()
    expect(state.theme).toBe('dark')
    expect(state.locale).toBe('ar')
    expect(state.otaEnabled).toBe(false)
  })

  // purgeDemoState guards every step; the flag flip after it must not be
  // hostage to a wedged database.
  it('still leaves demo mode when the database wipe fails', async () => {
    useAppStore.setState({ demoMode: true })
    mockExecSql.mockRejectedValue(new Error('database is locked'))

    await expect(factoryResetDevice()).resolves.toBeUndefined()

    expect(useAppStore.getState().demoMode).toBe(false)
  })
})
