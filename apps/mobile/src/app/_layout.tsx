if (__DEV__) {
  // Initialize Reactotron before anything else in development.
  require('@/ReactotronConfig')
  // RN's Animated emits this once at launch from library internals (navigation
  // timing — not our code; the only app Animated lives in ConversationsSheet,
  // which hasn't mounted yet). Left alone it pops a LogBox notification that
  // renders as a BLANK white card in this setup — RN 0.86 paints the message
  // white-on-white — so the first thing a fresh install shows is an empty
  // warning toast. The text still reaches the Metro terminal either way.
  require('react-native').LogBox.ignoreLogs([
    'Sending `onAnimatedValueUpdate` with no listeners registered.'
  ])
}

// Must load before anything touches @noble: Hermes has no crypto.getRandomValues,
// and X25519 key generation calls it the moment a pairing starts.
import 'react-native-get-random-values'

import '../global.css'
import '@/lib/i18n'

import { ChartSnapshotHost } from '@/components/chat/ChartSnapshotHost'
import { ActiveOverlays } from '@/components/overlays/ActiveOverlays'
import { ConnectionOverlay } from '@/components/pairing/ConnectionOverlay'
import { UpdateNotice } from '@/components/updates/UpdateNotice'
import { sweepStagedFiles } from '@/lib/files/fileCache'
import { useOtaUpdates } from '@/lib/updates/useOtaUpdates'
import { ToastProvider } from '@/providers/toast/ToastProvider'
import { LocaleProvider } from '@/providers/locale/LocaleProvider'
import { ThemeProvider } from '@/providers/theme/ThemeProvider'
import { useTheme, useTokens } from '@/providers/theme/useTheme'
import {
  asyncStoragePersister,
  PERSIST_MAX_AGE_MS,
  queryClient,
  shouldPersistQuery
} from '@/lib/query/queryClient'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { dialStoredPairing, useConnection } from '@/lib/sync/useConnection'
import { initNotifications } from '@/lib/notifications/push'

SplashScreen.preventAutoHideAsync()

// Before the first render, not after it. A paired phone's slowest moment used
// to be its own startup: the dial waited for two providers to restore from
// disk and for React to mount, so the relay round trip began after everything
// else had finished. Started here it runs alongside them, and the connection
// is usually up by the time there is a screen to show it on.
dialStoredPairing()

function AppShell(): React.JSX.Element {
  const { isDark } = useTheme()
  const tokens = useTokens()
  useOtaUpdates()
  // Restores a stored pairing at launch and on every foreground.
  useConnection()

  useEffect(() => {
    // Providers gate rendering until theme + locale are restored, so the
    // first frame here is already correct — safe to reveal.
    void SplashScreen.hideAsync()
    // Files staged for a message that was still uploading when the app died.
    // Nothing can legitimately be mid-send at launch, so anything left is
    // orphaned bytes — see fileCache STAGING_ROOT.
    sweepStagedFiles()
    // Foreground display, tap routing (warm + cold start) and token-rotation
    // re-registration for model-initiated notifications. Idempotent; without
    // the handler, notifications arriving while the app is open are silently
    // swallowed.
    initNotifications()
  }, [])

  return (
    <>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: tokens.bg }
        }}
      >
        {/* Launching a paired phone straight into chat is a restoration, not
            a navigation: sliding in reads as the app going somewhere when it
            is only showing where the user already was. Silenced for that one
            arrival — the `boot` flag the entry screen's redirect carries —
            so opening a conversation from History keeps its usual push. */}
        <Stack.Screen
          name="chat"
          options={({ route }) => ({
            animation:
              (route.params as { boot?: string } | undefined)?.boot === '1' ? 'none' : 'default'
          })}
        />
      </Stack>
      <UpdateNotice />
      {/* A memory rebuild on the desktop, over whatever screen is showing —
          app-wide because it blocks that whole machine, and a desktop that
          has stopped answering is news wherever the user happens to be. Above
          the screens but below the blocking overlays: a phone that has lost
          the tunnel has no rebuild to report anyway (it is cleared on the
          drop), so the two never compete for the same space. */}
      <ActiveOverlays />
      {/* Above every screen: without the tunnel a paired app can only show a
          stale copy and refuse every action. One card for the whole episode —
          reconnecting, then the catch-up every reconnect runs, then gone —
          so a drop never interrupts twice. */}
      <ConnectionOverlay />
      {/* Invisible, and null until the first chart card asks for a snapshot —
          the one ECharts runtime every inline chart in the app shares. */}
      <ChartSnapshotHost />
    </>
  )
}

export default function RootLayout(): React.JSX.Element {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister: asyncStoragePersister,
        maxAge: PERSIST_MAX_AGE_MS,
        dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery }
      }}
    >
      <ThemeProvider>
        <LocaleProvider>
          <ToastProvider>
            <AppShell />
          </ToastProvider>
        </LocaleProvider>
      </ThemeProvider>
    </PersistQueryClientProvider>
  )
}
