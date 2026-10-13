import type { ProviderListEntry } from '@preload/index'
import { useSyncExternalStore } from 'react'

/**
 * The saved cloud providers, already in hand when Settings → Models opens.
 * Over the Web UI every `provider.list()` is a socket round trip, and the
 * card grid and the provider panels used to paint empty (grey badges, no
 * key, no model list) until it came back. Seeded at import and re-read on
 * every `provider:updated`; Settings re-reads it on open too, since a push
 * sent while the socket was down is never replayed.
 */
let cache: ProviderListEntry[] | null = null
let inflight = false
let again = false
const listeners = new Set<() => void>()

export function refreshProviderList(): void {
  if (inflight) {
    again = true
    return
  }
  inflight = true
  void window.api.provider
    .list()
    .then((entries) => {
      cache = entries
      for (const l of listeners) l()
    })
    .catch(() => {})
    .finally(() => {
      inflight = false
      if (again) {
        again = false
        refreshProviderList()
      }
    })
}

if (typeof window !== 'undefined' && window.api) {
  refreshProviderList()
  window.api.provider.onUpdated(() => refreshProviderList())
}

export function getCachedProviderList(): ProviderListEntry[] | null {
  return cache
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): ProviderListEntry[] | null {
  return cache
}

export function useProviderList(): ProviderListEntry[] | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
