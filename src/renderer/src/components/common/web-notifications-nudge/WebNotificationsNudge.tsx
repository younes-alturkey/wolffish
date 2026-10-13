import { useToast } from '@components/core/toast/useToast'
import { cn } from '@lib/utils/cn'
import {
  armFirstGesturePrompt,
  needsHomeScreenInstall,
  notificationState,
  onNotificationState,
  registerToastSink,
  requestNotificationPermission,
  type NotificationState
} from '@lib/web-bridge/notifications'
import { Notification03Icon } from 'hugeicons-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

const DISMISSED_KEY = 'wolffish.web.notificationsNudgeDismissed'
const INSTALL_DISMISSED_KEY = 'wolffish.web.homeScreenNudgeDismissed'

function flag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function raise(key: string): void {
  try {
    localStorage.setItem(key, '1')
  } catch {
    // private mode: the strip simply returns next visit
  }
}

/**
 * Web only. Browsers only grant notification permission from a user gesture,
 * so the first tap after sign-in asks (armFirstGesturePrompt) and this strip
 * is the fallback for a prompt the user closed: shown while permission is
 * undecided on a secure origin, dismissable, gone for good once granted or
 * refused. On an iPhone or iPad that is not running from the Home Screen —
 * where Safari has no notifications at all — it says what to do instead.
 * It also hands the toast system to the notifications module, so an
 * in-band notification shows inside the app.
 */
export function WebNotificationsNudge(): React.JSX.Element | null {
  const { t } = useTranslation()
  const toast = useToast()
  const [state, setState] = useState<NotificationState>(() => notificationState())
  const [dismissed, setDismissed] = useState(() => flag(DISMISSED_KEY))
  const [installDismissed, setInstallDismissed] = useState(() => flag(INSTALL_DISMISSED_KEY))
  const [needsInstall] = useState(() => needsHomeScreenInstall())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    registerToastSink(({ message, tone, sticky, onClick }) =>
      toast.show({ message, tone, sticky, onClick, durationMs: 8000 })
    )
    const off = onNotificationState(setState)
    return () => {
      registerToastSink(null)
      off()
    }
  }, [toast])

  // The first tap asks; a granted prompt gets the same confirmation the
  // button gives.
  useEffect(() => {
    if (dismissed || !state.supported || state.permission !== 'default') return
    return armFirstGesturePrompt((next) => {
      setState(next)
      if (next.permission === 'granted') {
        toast.show({ message: t('web.notifications.enabled'), tone: 'success' })
      }
    })
  }, [dismissed, state.supported, state.permission, toast, t])

  const strip =
    'pointer-events-auto fixed inset-x-4 top-20 z-30 mx-auto flex max-w-xl rounded-2xl px-4 py-3 bg-surface border-border text-fg border text-sm shadow-lg'
  const dismissButton =
    'text-muted hover:text-fg shrink-0 cursor-pointer rounded-lg px-2 py-1.5 text-xs'

  if (needsInstall && !installDismissed) {
    return (
      <div role="status" data-notifications-nudge className={cn(strip, 'items-center gap-3')}>
        <Notification03Icon size={18} className="text-muted shrink-0" />
        <span className="min-w-0 flex-1 leading-snug">{t('web.notifications.iosInstall')}</span>
        <button
          type="button"
          onClick={() => {
            setInstallDismissed(true)
            raise(INSTALL_DISMISSED_KEY)
          }}
          aria-label={t('common.dismiss')}
          className={dismissButton}
        >
          {t('common.dismiss')}
        </button>
      </div>
    )
  }

  if (!state.supported || state.permission !== 'default' || dismissed) return null

  return (
    <div
      role="status"
      data-notifications-nudge
      className={cn(strip, 'flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-3')}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
        <Notification03Icon size={18} className="text-muted mt-px shrink-0 sm:mt-0" />
        <span className="min-w-0 flex-1 leading-snug">{t('web.notifications.nudge')}</span>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void requestNotificationPermission()
              .then((next) => {
                setState(next)
                if (next.permission === 'granted') {
                  toast.show({ message: t('web.notifications.enabled'), tone: 'success' })
                }
              })
              .finally(() => setBusy(false))
          }}
          className="bg-primary text-primary-fg shrink-0 cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium hover:brightness-110"
        >
          {t('web.notifications.enable')}
        </button>
        <button
          type="button"
          onClick={() => {
            setDismissed(true)
            raise(DISMISSED_KEY)
          }}
          aria-label={t('common.dismiss')}
          className={dismissButton}
        >
          {t('common.dismiss')}
        </button>
      </div>
    </div>
  )
}
