jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }))
jest.mock('expo-device', () => ({ isDevice: true }))
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.0.33', extra: { eas: { projectId: 'proj' } } } }
}))
jest.mock('expo-secure-store', () => ({
  getItemAsync: async () => 'a'.repeat(32),
  setItemAsync: async () => undefined,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlocked'
}))

/** The token call the platform may never answer — resolved by the test, or
 *  left hanging exactly as a stuck APNs registration leaves it. */
let tokenResolve: ((value: { data: string }) => void) | null = null
let tokenCalls = 0

jest.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: () => ({ remove: () => undefined }),
  addPushTokenListener: () => ({ remove: () => undefined }),
  setNotificationHandler: () => undefined,
  getLastNotificationResponse: () => null,
  clearLastNotificationResponse: () => undefined,
  getPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
  requestPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
  setNotificationChannelAsync: async () => undefined,
  setBadgeCountAsync: async () => undefined,
  getPresentedNotificationsAsync: async () => [],
  AndroidImportance: { HIGH: 4 },
  getExpoPushTokenAsync: () => {
    tokenCalls += 1
    return new Promise((resolve) => {
      tokenResolve = resolve
    })
  }
}))

/**
 * Registration is the phone's whole claim on being reachable: the relay drops
 * a notify for a phoneId it has no record of BEFORE it looks at any delivery
 * path, live socket included. So a registration that never goes out costs the
 * user every notification, not just the ones needing a push token — which is
 * exactly what a stuck iOS token call used to do.
 */
type Push = typeof import('@/lib/notifications/push')

function loadPush(): Push {
  let module!: Push
  jest.isolateModules(() => {
    module = require('@/lib/notifications/push')
  })
  return module
}

function fakeTunnel(): { sendControl: jest.Mock; onControl: jest.Mock } {
  return { sendControl: jest.fn(), onControl: jest.fn() }
}

function registrations(tunnel: { sendControl: jest.Mock }): Record<string, unknown>[] {
  return tunnel.sendControl.mock.calls
    .map(([frame]) => frame as Record<string, unknown>)
    .filter((frame) => frame.type === 'register_push')
}

/** Drain microtasks until the token call is reached — the device id and the
 *  permission check sit in front of it, each its own await. */
async function whenTokenRequested(): Promise<void> {
  for (let tick = 0; tick < 50 && tokenCalls === 0; tick += 1) await Promise.resolve()
}

beforeEach(() => {
  tokenResolve = null
  tokenCalls = 0
})

describe('push registration', () => {
  it('registers with a null token when the platform never hands one over', async () => {
    jest.useFakeTimers()
    try {
      const push = loadPush()
      const tunnel = fakeTunnel()
      push.attachNotificationHandlers(tunnel as never)

      const done = push.refreshPushRegistration()
      // The token promise is deliberately left hanging — a stuck APNs
      // registration, or a permission dialog the user never answers.
      await whenTokenRequested()
      expect(tokenCalls).toBe(1)
      expect(registrations(tunnel)).toHaveLength(0)

      await jest.advanceTimersByTimeAsync(10_000)
      await done

      const sent = registrations(tunnel)
      expect(sent).toHaveLength(1)
      expect(sent[0].expoPushToken).toBeNull()
      expect(sent[0].phoneId).toBe('a'.repeat(32))
    } finally {
      jest.useRealTimers()
    }
  })

  it('re-registers with the real token once it arrives', async () => {
    const push = loadPush()
    const tunnel = fakeTunnel()
    push.attachNotificationHandlers(tunnel as never)

    const first = push.refreshPushRegistration()
    await whenTokenRequested()
    tokenResolve?.({ data: 'ExponentPushToken[abc]' })
    await first

    expect(registrations(tunnel)[0].expoPushToken).toBe('ExponentPushToken[abc]')
  })

  it('does not latch the in-flight guard when there is no tunnel yet', async () => {
    const push = loadPush()

    // A foreground before the tunnel exists: nothing to send on, so nothing
    // is sent — and crucially the guard must not keep this no-op forever.
    await push.refreshPushRegistration()

    const tunnel = fakeTunnel()
    push.attachNotificationHandlers(tunnel as never)
    const done = push.refreshPushRegistration()
    await whenTokenRequested()
    tokenResolve?.({ data: 'ExponentPushToken[abc]' })
    await done

    expect(registrations(tunnel)).toHaveLength(1)
  })
})
