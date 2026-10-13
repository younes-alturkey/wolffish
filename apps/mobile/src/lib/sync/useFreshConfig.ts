import { refreshConfig } from '@/lib/sync/sync'
import { tunnelClient } from '@/lib/tunnel/client'
import { useAppStore } from '@/state/appStore'
import { useFocusEffect } from 'expo-router'
import { useCallback } from 'react'

/**
 * Pull the desktop's current settings whenever a screen that renders them
 * comes into focus.
 *
 * The desktop is edited too, and this phone is asleep for most of the day, so
 * a settings screen opened from a cold start would otherwise show whatever the
 * last sync captured. Refreshing on focus is the cheapest way to be right:
 * one small RPC, only for the screen actually being looked at, and the store
 * updates in place so what is already on screen never flashes.
 *
 * A no-op in demo mode and while disconnected — demo config comes from the
 * saved snapshot and must not be touched.
 */
export function useFreshConfig(): void {
  const paired = useAppStore((state) => state.paired)

  useFocusEffect(
    useCallback(() => {
      if (!paired || !tunnelClient.connected) return
      void refreshConfig().catch(() => undefined)
    }, [paired])
  )
}
