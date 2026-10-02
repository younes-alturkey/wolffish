import { useConversationBrowser } from '@components/common/browser-card/useConversationBrowser'
import { BrowserSheet } from '@components/common/browser-sheet/BrowserSheet'
import { ConversationsSheet } from '@components/common/floating-chrome/ConversationsSheet'
import { glassButtonClass } from '@components/common/floating-chrome/glass'
import { NewChatButton } from '@components/common/new-chat-button/NewChatButton'
import { ProjectDialog } from '@components/common/project-dialog/ProjectDialog'
import { cn } from '@lib/utils/cn'
import { isMac } from '@lib/utils/platform'
import { useSessions } from '@providers/sessions/useSessions'
import { Globe02Icon, Menu01Icon } from 'hugeicons-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * The chat screen's floating chrome — the desktop port of the mobile app's
 * two glass discs laid over the transcript (no rails, no header):
 *
 * - Leading disc: opens the ConversationsSheet (all pages + the full
 *   conversations list).
 * - Trailing disc: New chat (click) with the projects hover card, exactly the
 *   control that used to ride the composer's end edge. In project mode the
 *   disc swaps to the project's emoji and opens the manage dialog (edit /
 *   files / new conversation / exit) — the same conditional the composer slot
 *   carried.
 * - Beside it, the browser disc: Wolffish's own browser, expanded, for the
 *   active conversation — the user's way in (sign in somewhere by hand, look
 *   at what the model opened, start a page for it).
 *
 * Rendered ONCE at app level (inside the chatVisible gate that held the old
 * conversations rail), never per Chat instance: the sheet holds list state
 * and the dialog holds draft state, and `activeProject` in the sessions
 * provider is by construction the ACTIVE session's project.
 */
export function FloatingChrome(): React.JSX.Element {
  const { t } = useTranslation()
  const { newSession, activeProject, setActiveProject, activeConversationId, runStatuses } =
    useSessions()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)
  // The browser disc exists only for a conversation that has a browser: no
  // tabs, no disc. The model (or a restored card) is what opens one.
  const conversationBrowser = useConversationBrowser({ conversationId: activeConversationId })
  const hasBrowser = conversationBrowser.tabs.length > 0
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  // The dialog's `busy` lock (instructions/files frozen under a running turn):
  // the active conversation's live phase is the app-level equivalent of the
  // old per-session `streaming` flag. Exiting is deliberately not part of the
  // lock — it only switches what the window shows, and the project's running
  // turn keeps going in its own session.
  const busy =
    activeConversationId !== null && runStatuses[activeConversationId]?.phase === 'processing'

  return (
    <>
      {/* macOS clears the traffic lights at top-12; Windows/Linux keep their
          native titlebar above the webview and sit at top-6. Left and right
          are the same everywhere — px-4 — so the discs attach the same
          distance from the window edges on every platform. */}
      <div
        className={cn(
          'pointer-events-none fixed inset-x-0 z-30 flex items-center justify-between px-4',
          isMac ? 'top-12' : 'top-6'
        )}
      >
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          title={t('chat.conversations')}
          aria-label={t('chat.conversations')}
          className={glassButtonClass}
        >
          <Menu01Icon size={18} />
        </button>
        <div className="flex items-center gap-2">
          {hasBrowser && (
            <button
              type="button"
              onClick={() => setBrowserOpen(true)}
              title={t('chat.browser.open')}
              aria-label={t('chat.browser.open')}
              className={glassButtonClass}
            >
              <Globe02Icon size={18} />
            </button>
          )}
          {activeProject ? (
            <button
              type="button"
              onClick={() => setProjectDialogOpen(true)}
              title={activeProject.title.trim() || t('projects.untitled')}
              aria-label={t('projects.project')}
              className={glassButtonClass}
            >
              <span aria-hidden className="text-base leading-none">
                {activeProject.icon || '📁'}
              </span>
            </button>
          ) : (
            <NewChatButton
              onNew={() => newSession()}
              onNewInProject={(projectId) => newSession({ projectId })}
            />
          )}
        </div>
      </div>
      {sheetOpen && <ConversationsSheet onClose={() => setSheetOpen(false)} />}
      {browserOpen && hasBrowser && (
        <BrowserSheet conversationId={activeConversationId} onClose={() => setBrowserOpen(false)} />
      )}
      <ProjectDialog
        project={projectDialogOpen ? activeProject : null}
        onClose={() => setProjectDialogOpen(false)}
        onChanged={setActiveProject}
        busy={busy}
        onNewConversation={(p) => {
          setProjectDialogOpen(false)
          newSession({ projectId: p.id })
        }}
        // Close = leave project mode and land in a fresh plain chat, right
        // here — no detour to the Projects page. newSession() without a
        // projectId both spawns/refocuses the blank session and clears the
        // active project (syncProjectFor(null)). Stays available under a
        // running turn: the project's session stays mounted, so its stream
        // and the conversation itself are untouched.
        onExitProject={() => {
          setProjectDialogOpen(false)
          newSession()
        }}
      />
    </>
  )
}
