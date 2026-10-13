jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

import AsyncStorage from '@react-native-async-storage/async-storage'
import { useAppStore, whenHydrated } from '@/state/appStore'

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('appStore', () => {
  beforeEach(() => {
    useAppStore.setState({ theme: 'system', locale: null })
    ;(AsyncStorage.setItem as jest.Mock).mockClear()
  })

  it('starts with system theme and no explicit locale', () => {
    expect(useAppStore.getState().theme).toBe('system')
    expect(useAppStore.getState().locale).toBeNull()
  })

  it('hydrates from storage', async () => {
    await expect(whenHydrated()).resolves.toBeUndefined()
  })

  it('updates theme synchronously', () => {
    useAppStore.getState().setTheme('dark')
    expect(useAppStore.getState().theme).toBe('dark')
  })

  it('updates locale synchronously', () => {
    useAppStore.getState().setLocale('ar')
    expect(useAppStore.getState().locale).toBe('ar')
  })

  it('persists only the data slice under the wolffish.app key', async () => {
    useAppStore.getState().setTheme('light')
    await flush()
    const calls = (AsyncStorage.setItem as jest.Mock).mock.calls.filter(
      ([key]) => key === 'wolffish.app'
    )
    expect(calls.length).toBeGreaterThan(0)
    const lastPayload = JSON.parse(calls[calls.length - 1][1] as string) as {
      state: Record<string, unknown>
    }
    expect(lastPayload.state).toEqual({
      theme: 'light',
      locale: null,
      demoMode: false,
      paired: false,
      demoVersion: null,
      otaEnabled: true
    })
    // Functions (setters) must never be serialized.
    expect(Object.keys(lastPayload.state).sort()).toEqual([
      'demoMode',
      'demoVersion',
      'locale',
      'otaEnabled',
      'paired',
      'theme'
    ])
  })

  it('turns OTA updates off and on', () => {
    expect(useAppStore.getState().otaEnabled).toBe(true)
    useAppStore.getState().setOtaEnabled(false)
    expect(useAppStore.getState().otaEnabled).toBe(false)
    useAppStore.getState().setOtaEnabled(true)
    expect(useAppStore.getState().otaEnabled).toBe(true)
  })

  it('migrates a v3 blob without re-running the v2 demo reset', () => {
    const migrate = useAppStore.persist.getOptions().migrate
    const stored = {
      theme: 'dark',
      locale: 'ar',
      demoMode: true,
      demoVersion: 'abc123'
    }
    // v4 only added otaEnabled. Falling through to the v3 branch here would
    // null demoVersion and send a device that already holds the dataset back
    // through the whole download.
    expect(migrate?.({ ...stored }, 3)).toMatchObject({ demoVersion: 'abc123', demoMode: true })
    // A pre-v3 blob still loses the retired flag and re-imports.
    expect(migrate?.({ ...stored, demoImported: true }, 2)).toMatchObject({ demoVersion: null })
    expect(migrate?.({ ...stored, demoImported: true }, 2)).not.toHaveProperty('demoImported')
  })
})
