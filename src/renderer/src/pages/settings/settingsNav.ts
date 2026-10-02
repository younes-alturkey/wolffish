import { createContext } from 'react'

/**
 * Set by Settings around a panel drilled open from a card grid (Services and
 * Models); null everywhere else, so PanelBackChevron (drillNav.tsx) collapses
 * to nothing when the same panel renders outside a drill (a channel sub-tab,
 * and so on).
 */
export const DrillBackContext = createContext<(() => void) | null>(null)

export type TabKey =
  | 'appearance'
  | 'model'
  | 'channels'
  | 'services'
  | 'mcp'
  | 'updates'
  | 'wolffish'
  | 'variables'
  | 'capabilities'
  | 'knowledge'
  | 'usage'
  | 'data'

let nextTab: TabKey | null = null

export function preselectSettingsTab(tab: TabKey): void {
  nextTab = tab
}

export function consumeNextTab(): TabKey | null {
  const t = nextTab
  nextTab = null
  return t
}

type TabRequestListener = (tab: TabKey) => void
let tabRequestListener: TabRequestListener | null = null

/**
 * A mounted Settings page follows tab jumps requested from nested panels
 * (e.g. a capability gate card's "Open Capabilities" button). Returns the
 * unsubscribe.
 */
export function onTabRequest(listener: TabRequestListener): () => void {
  tabRequestListener = listener
  return () => {
    if (tabRequestListener === listener) tabRequestListener = null
  }
}

export function requestSettingsTab(tab: TabKey): void {
  if (tabRequestListener) tabRequestListener(tab)
  else preselectSettingsTab(tab)
}
