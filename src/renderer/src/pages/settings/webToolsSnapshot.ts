import type {
  BraveConfig,
  BraveStatus,
  DeepSeekSearchConfig,
  DeepSeekSearchStatus,
  WebToolsConfig
} from '@preload/index'

/** Everything the Web Search and Web Fetch panels paint from. */
export type WebToolsSnapshot = {
  tools: WebToolsConfig
  brave: BraveConfig
  braveStatus: BraveStatus
  deepseek: DeepSeekSearchConfig
  deepseekStatus: DeepSeekSearchStatus
}

// Module-level cache, same pattern as googleSnapshot: Settings.tsx prefetches
// on mount, so by the time a panel opens its first paint already has the
// priority list and toggles instead of skeletons resolving a beat later.
let snapshotCache: WebToolsSnapshot | null = null
let inflightSnapshot: Promise<WebToolsSnapshot> | null = null

async function fetchSnapshot(): Promise<WebToolsSnapshot> {
  const [tools, brave, braveStatus, deepseek, deepseekStatus] = await Promise.all([
    window.api.webTools.getConfig(),
    window.api.brave.getConfig(),
    window.api.brave.status(),
    window.api.deepseekSearch.getConfig(),
    window.api.deepseekSearch.status()
  ])
  const snapshot: WebToolsSnapshot = { tools, brave, braveStatus, deepseek, deepseekStatus }
  snapshotCache = snapshot
  return snapshot
}

export function prefetchWebTools(): Promise<WebToolsSnapshot> {
  if (inflightSnapshot) return inflightSnapshot
  inflightSnapshot = fetchSnapshot().finally(() => {
    inflightSnapshot = null
  })
  return inflightSnapshot
}

export function getCachedWebTools(): WebToolsSnapshot | null {
  return snapshotCache
}

/** The services:changed payloads that can change anything in the snapshot. */
export const WEB_TOOLS_SERVICES: ReadonlySet<string> = new Set([
  'webTools',
  'brave',
  'deepseekSearch'
])
