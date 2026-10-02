import type { OllamaSnapshot } from '@preload/index'
import { useSyncExternalStore } from 'react'

/**
 * The daemon's state as the composer's model card reads it: a flag that is
 * ALREADY settled when the card opens, never a probe the open triggers. Main
 * watches Ollama in the background and pushes only on change; this module
 * seeds itself from the watch's snapshot the moment the renderer boots and
 * then just mirrors the pushes. So opening the card costs no IPC and no
 * state refresh — the local group is there or it is not, the same way a
 * cloud provider's group is there or it is not by its key.
 *
 * Module-level rather than a provider: one subscription for the whole
 * window, warm before any consumer mounts.
 */
const EMPTY: OllamaSnapshot = { reachable: false, installed: [] }

let snapshot: OllamaSnapshot = EMPTY
const listeners = new Set<() => void>()

function publish(next: OllamaSnapshot): void {
  snapshot = next
  for (const l of listeners) l()
}

// Warm at import: the seed lands during boot, long before the composer is
// on screen. The push subscription lives for the window's lifetime.
if (typeof window !== 'undefined' && window.api?.ollama?.snapshot) {
  void window.api.ollama
    .snapshot()
    .then(publish)
    .catch(() => {})
  window.api.ollama.onChanged(publish)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): OllamaSnapshot {
  return snapshot
}

export function useOllama(): OllamaSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
