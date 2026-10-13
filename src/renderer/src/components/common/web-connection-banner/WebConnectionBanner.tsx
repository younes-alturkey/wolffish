import { webTransport } from '@lib/web-bridge/boot'
import { isWebUpdatePending } from '@lib/web-bridge/pending-update'
import type { ConnectionState } from '@lib/web-bridge/transport'
import { RefreshIcon } from 'hugeicons-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/** A socket gap shorter than this is a phone's lock screen, not an outage. */
const NOTICE_DELAY_MS = 1500

/**
 * Web only: says so when the socket to the app is gone and being retried,
 * so a page does not sit on its last state looking alive. Leaves on its
 * own when the socket is back; a reconnect to a restarted app reloads the
 * page instead (boot.ts), which takes the banner with it.
 */
export function WebConnectionBanner(): React.JSX.Element | null {
  const { t } = useTranslation()
  const [lost, setLost] = useState(false)

  useEffect(() => {
    const transport = webTransport()
    if (!transport) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = transport.onConnection((state: ConnectionState) => {
      if (state === 'open') {
        if (timer) clearTimeout(timer)
        timer = null
        setLost(false)
        return
      }
      if (state === 'signed-out' || timer) return
      timer = setTimeout(() => {
        timer = null
        setLost(true)
      }, NOTICE_DELAY_MS)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [])

  // An announced restart has the closing overlay saying so already.
  if (!lost || webTransport()?.restartExpected) return null
  return (
    <div
      role="status"
      aria-live="assertive"
      className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center px-4"
    >
      <div className="flex items-center gap-2 rounded-full border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-900 shadow-lg dark:border-amber-700 dark:bg-amber-900/80 dark:text-amber-100">
        <RefreshIcon size={14} className="animate-spin" aria-hidden />
        <span className="whitespace-nowrap">
          {isWebUpdatePending() ? t('web.connection.updating') : t('web.connection.lost')}
        </span>
      </div>
    </div>
  )
}
