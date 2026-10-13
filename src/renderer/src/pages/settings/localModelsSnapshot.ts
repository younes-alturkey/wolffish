import type { ModelEntry, OllamaModelDetail, OllamaTag, SystemInfo } from '@preload/index'

export type LocalModelsSnapshot = {
  system: SystemInfo
  catalog: readonly ModelEntry[]
  installed: OllamaTag[]
  available: OllamaModelDetail[]
  modelsFolder: string
}

// What the Ollama panel (ModelPicker) needs before it can draw anything —
// five round trips, one of them a disk scan. Settings prefetches it on open
// and the panel seeds from the last result, so drilling into Ollama paints
// at once instead of a blank page; the panel still re-reads on mount.
let cache: LocalModelsSnapshot | null = null
let inflight: Promise<LocalModelsSnapshot> | null = null

export function loadLocalModels(): Promise<LocalModelsSnapshot> {
  if (inflight) return inflight
  inflight = Promise.all([
    window.api.system.getInfo(),
    window.api.workspace.getModelCatalog(),
    window.api.ollama.listInstalled(),
    window.api.ollama.scanAvailable(),
    window.api.ollama.getModelsFolder()
  ])
    .then(([system, catalog, installed, available, modelsFolder]) => {
      cache = { system, catalog, installed, available, modelsFolder }
      return cache
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export function getCachedLocalModels(): LocalModelsSnapshot | null {
  return cache
}

/** Keeps the seed true when the panel re-reads a piece on its own (a finished pull, a new folder). */
export function patchLocalModels(patch: Partial<LocalModelsSnapshot>): void {
  if (cache) cache = { ...cache, ...patch }
}
