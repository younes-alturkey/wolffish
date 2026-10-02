/**
 * Types shared by the in-app browser's snapshot layer.
 *
 * Ported from wolffish-extension (chrome-extension/src/background/
 * cdp-session.ts and packages/shared/lib/wolffish/types.ts), extension
 * 0.1.66. Copied rather than imported: a `typeof import` of a sibling repo
 * broke CI typecheck once already, and the extension's shared package pulls
 * chrome.* types this process does not have.
 */

/** The one seam: a CDP sender for the tab this session belongs to. */
export type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>

export type Rect = { x: number; y: number; width: number; height: number }

export type FillKind = 'select' | 'checkbox' | 'radio' | 'textarea' | 'input' | 'contenteditable'

export interface UidRef {
  backendNodeId: number
  loaderId: string
  frameId?: string
}

/** What findInSnapshot scores against: the kept nodes of the latest snapshot. */
export interface SnapshotNode {
  uid: string
  role: string
  name: string
  tag: string
  backendNodeId: number
  id: string
  ariaLabel: string
}

export interface DialogState {
  type: string
  message: string
  defaultPrompt: string
  url: string
}

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'

export interface ConsoleEntry {
  seq: number
  level: ConsoleLevel
  text: string
  /** Where it came from: a console.* call, an uncaught exception, or the browser log. */
  source: 'console' | 'exception' | 'log'
  url?: string
  line?: number
  timestamp: number
}

export interface SnapshotSession {
  send: CdpSend
  /** Main-frame loader id — changes on every navigation, which invalidates every uid. */
  loaderId: string
  /** Monotonic per session. In the extension this lived in chrome.storage so it
   *  survived service-worker death; main-process state does not die that way,
   *  so an integer is enough. */
  snapshotSeq: number
  hasSnapshot: boolean
  uidMap: Map<string, UidRef>
  /** Reverse of uidMap keyed `${loaderId}:${backendNodeId}` so a re-snapshot keeps old uids. */
  uidByNode: Map<string, string>
  snapshotNodes: SnapshotNode[]
  dialog: DialogState | null
  console: ConsoleEntry[]
  consoleSeq: number
  /** Where the synthetic cursor last rested; the bezier glide starts here. */
  cursor: { x: number; y: number }
}

export interface TakeSnapshotResult {
  snapshot: string
  url: string
  title: string
  nodeCount: number
  snapshotId: number
}

export interface FoundElement {
  uid: string
  tag: string
  role: string
  text: string
  score: number
  center: { x: number; y: number }
  rect: Rect
}
