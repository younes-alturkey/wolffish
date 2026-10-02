import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@components/core/toast/useToast'

/**
 * Passive network-status notifications. The offline toast is a STICKY
 * warning — offline is a persistent state, not a moment, so it stays up
 * (top of the window, explicit close button) until the user dismisses it
 * or the connection returns, at which point it is swapped for a brief
 * success toast. Fires only on real transitions (plus once at mount if the
 * app starts offline) — the restore toast never shows unless an offline
 * one preceded it, so a fresh online launch is silent.
 */
export function useNetworkToasts(): void {
  const { t } = useTranslation()
  const toast = useToast()
  // Id of the live offline toast; null when online (or the user closed it).
  const offlineToastRef = useRef<number | null>(null)
  const offlineRef = useRef(false)

  useEffect(() => {
    const notifyOffline = (): void => {
      if (offlineRef.current) return
      offlineRef.current = true
      offlineToastRef.current = toast.show({
        tone: 'warning',
        message: t('common.networkOffline'),
        sticky: true,
        placement: 'top'
      })
    }
    const notifyOnline = (): void => {
      if (!offlineRef.current) return
      offlineRef.current = false
      if (offlineToastRef.current !== null) {
        toast.dismiss(offlineToastRef.current)
        offlineToastRef.current = null
      }
      // The restore notice appears where the offline one lived — top — so the
      // swap reads as one state resolving, not two unrelated toasts.
      toast.show({ tone: 'success', message: t('common.networkRestored'), placement: 'top' })
    }
    if (!navigator.onLine) notifyOffline()
    window.addEventListener('offline', notifyOffline)
    window.addEventListener('online', notifyOnline)
    return () => {
      window.removeEventListener('offline', notifyOffline)
      window.removeEventListener('online', notifyOnline)
    }
  }, [toast, t])
}
