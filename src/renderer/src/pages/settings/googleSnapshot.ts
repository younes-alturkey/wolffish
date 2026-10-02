import type { GoogleBinaryStatus, GoogleConfig, GoogleStatus } from '@preload/index'

export type GoogleSnapshot = {
  binary: GoogleBinaryStatus
  config: GoogleConfig
  status: GoogleStatus
  accounts: string[]
}

// Module-level cache so the second time Settings is opened in a session
// the panel has its data already and renders without a flash. Settings.tsx
// calls `prefetchGooglePanel()` on mount so the fetch is in flight before
// the user even clicks the Google Workspace tab.
let snapshotCache: GoogleSnapshot | null = null
let inflightSnapshot: Promise<GoogleSnapshot> | null = null

async function fetchSnapshot(): Promise<GoogleSnapshot> {
  const [binary, config, status] = await Promise.all([
    window.api.google.checkBinary(),
    window.api.google.getConfig(),
    window.api.google.status()
  ])
  const accounts = binary.gogInstalled
    ? await window.api.google.listAccounts().catch(() => [] as string[])
    : []
  const snapshot: GoogleSnapshot = { binary, config, status, accounts }
  snapshotCache = snapshot
  return snapshot
}

export function prefetchGooglePanel(): Promise<GoogleSnapshot> {
  if (inflightSnapshot) return inflightSnapshot
  inflightSnapshot = fetchSnapshot().finally(() => {
    inflightSnapshot = null
  })
  return inflightSnapshot
}

export function getCachedGoogleSnapshot(): GoogleSnapshot | null {
  return snapshotCache
}
