import { useEffect, useState } from 'react'
import { ThemeProvider } from '@providers/theme/ThemeProvider'
import { LocaleProvider } from '@providers/locale/LocaleProvider'
import { FlowProvider } from '@providers/flow/FlowProvider'
import { useFlow, type Screen } from '@providers/flow/useFlow'
import { ChatSessionsProvider } from '@providers/sessions/ChatSessionsProvider'
import { useSessions } from '@providers/sessions/useSessions'
import { FloatingChrome } from '@components/common/floating-chrome/FloatingChrome'
import { ToastProvider } from '@components/core/toast/ToastProvider'
import { InputContextMenu } from '@components/core/InputContextMenu'
import { useNetworkToasts } from '@hooks/use-network-toasts/useNetworkToasts'
import { ClosingOverlay } from '@components/common/closing-overlay/ClosingOverlay'
import { ReindexActiveOverlay } from '@components/common/reindex-active-overlay/ReindexActiveOverlay'
import { Onboarding } from '@pages/Onboarding'
import { LowDiskSpace } from '@pages/LowDiskSpace'
import { OllamaSetup } from '@pages/OllamaSetup'
import { Chat } from '@pages/Chat'
import { Settings } from '@pages/settings/Settings'
import { ViewerPage } from '@pages/ViewerPage'
import { History } from '@pages/History'
import { Changelog } from '@pages/Changelog'
import { Library } from '@pages/Library'
import { Customization } from '@pages/Customization'

// The one-time cortex reindex (after an app update) blocks every turn, so
// while it runs the chat screen is swapped for its own overlay. (Background
// automation/procedure runs do NOT block and draw nothing over the app — the
// Automations page reports them.) Tracked here — not inside Chat — so the overlay
// renders once at app level and the floating chrome hides behind the same
// chatVisible gate. When Chat owned this state the old conversations rail (a
// fixed z-30 element gated only at app level) kept floating over the overlay,
// and every mounted session rendered its own duplicate copy.
function useReindexActive(): boolean {
  const [active, setActive] = useState(false)
  useEffect(() => {
    let cancelled = false
    window.api.reindex
      .getStatus()
      .then((s) => {
        if (!cancelled) setActive(!!s)
      })
      .catch(() => {})
    const offStarted = window.api.reindex.onStarted(() => setActive(true))
    const offEnded = window.api.reindex.onEnded(() => setActive(false))
    return () => {
      cancelled = true
      offStarted()
      offEnded()
    }
  }, [])
  return active
}

// Screens the user can reach WHILE holding live conversations. Chat sessions
// stay mounted for the whole set so navigating anywhere and back never tears
// live state down — with concurrent sessions, an unmount would silently
// reset every feed to its open-time seed and orphan in-flight turns.
// ollama-setup is included because it is reachable mid-session (Settings →
// Models → Ollama → set up); only the pre-conversation launch screens
// (welcome, low-disk-space) stay out — no session can exist there yet. The
// model picker has no screen of its own: it renders as the Ollama panel
// inside Settings, never as a step the app routes anyone through.
const CHAT_KEEPALIVE_SCREENS = new Set<Screen>([
  'chat',
  'settings',
  'viewer',
  'history',
  'changelog',
  'library',
  'customization',
  'ollama-setup'
])

// Every screen EXCEPT chat, which is rendered persistently by Screens() so its
// live state (context meter, timeline, scroll, in-flight stream) survives
// navigation instead of reloading on every return.
function NonChatScreen({ screen }: { screen: Screen }): React.JSX.Element | null {
  switch (screen) {
    case 'welcome':
      return <Onboarding />
    case 'low-disk-space':
      return <LowDiskSpace />
    case 'ollama-setup':
      return <OllamaSetup />
    case 'chat':
      return null
    case 'settings':
      return <Settings />
    case 'viewer':
      return <ViewerPage />
    case 'history':
      return <History />
    case 'changelog':
      return <Changelog />
    case 'library':
      return <Library />
    case 'customization':
      return <Customization />
  }
}

// Global network-status notifier — mounted once inside ToastProvider so the
// drop/restore toasts show on every screen, not just the ones that track
// connectivity themselves.
function NetworkToasts(): null {
  useNetworkToasts()
  return null
}

function Screens(): React.JSX.Element {
  const { screen } = useFlow()
  const { sessions, activeSessionKey } = useSessions()
  const reindexActive = useReindexActive()
  // Keep every chat SESSION mounted (just hidden) across main-app navigation.
  // One <Chat> instance per open session: each owns its own feed, composer,
  // meter and in-flight turn, so conversations stream concurrently and
  // switching between them never tears live state down. `contents` makes the
  // active wrapper layout-invisible so the chat view renders exactly as it
  // would unwrapped; `hidden` (display:none) takes the rest out of layout
  // without unmounting — no reload, no reset, no flash.
  //
  // Critically, staying mounted is what keeps a background conversation's
  // output from being lost: an electron conversation is persisted only by its
  // renderer instance, so unmounting a Chat mid-turn would drop the turn
  // before it saves. Mounted-but-hidden, each Chat still receives its own
  // turn's events (demuxed by conversationId/turnId) and persists them.
  const chatMounted = CHAT_KEEPALIVE_SCREENS.has(screen)
  // !reindexActive: while the reindex overlay is up, the chat (and with it the
  // conversations rail below) hides — display:none, never unmounted, so live
  // state survives the rebuild.
  const chatVisible = chatMounted && screen === 'chat' && !reindexActive
  return (
    <>
      {reindexActive && screen === 'chat' ? (
        <ReindexActiveOverlay />
      ) : (
        <NonChatScreen screen={screen} />
      )}
      {chatMounted &&
        sessions.map((session) => {
          const show = chatVisible && session.key === activeSessionKey
          return (
            <div key={session.key} className={show ? 'contents' : 'hidden'}>
              <Chat sessionKey={session.key} visible={show} descriptor={session} />
            </div>
          )
        })}
      {/* ONE app-level floating chrome (glass discs + conversations sheet +
          project dialog) — mounted whenever the chat is, hidden (not
          unmounted) when it isn't. Same discipline as the old conversations
          rail: rendering per-Chat-instance would duplicate state and reset it
          on every conversation switch. A single persistent instance never
          remounts. */}
      {chatMounted && (
        <div className={chatVisible ? 'contents' : 'hidden'}>
          <FloatingChrome />
        </div>
      )}
    </>
  )
}

// Electron's default action for a file dropped anywhere in the window is to
// navigate to it (file://…), which blanks the app. Registered dropzones handle
// their own drops; this guard swallows every other drop so a near-miss can't
// hijack the window. React's onDrop handlers still fire — they run on the root
// container during bubbling, before this window-level listener.
function useGlobalDropGuard(): void {
  useEffect(() => {
    const prevent = (e: DragEvent): void => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault()
      }
    }
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])
}

function App(): React.JSX.Element {
  useGlobalDropGuard()
  return (
    <ThemeProvider>
      <LocaleProvider>
        <ToastProvider>
          <NetworkToasts />
          <FlowProvider>
            <ChatSessionsProvider>
              <div className="app-titlebar" aria-hidden />
              <Screens />
              <ClosingOverlay />
              <InputContextMenu />
            </ChatSessionsProvider>
          </FlowProvider>
        </ToastProvider>
      </LocaleProvider>
    </ThemeProvider>
  )
}

export default App
