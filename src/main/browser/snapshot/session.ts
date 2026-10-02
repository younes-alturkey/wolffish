/**
 * Per-tab CDP session state for the in-app browser: the uid maps the
 * snapshot layer reads, the console ring the model can ask for, and the one
 * event that invalidates all of it — a main-frame navigation.
 *
 * Ported from wolffish-extension chrome-extension/src/background/
 * cdp-session.ts (extension 0.1.66), minus everything that existed only
 * because a service worker dies: the chrome.storage mirror, restoreSessions,
 * the attach/detach registry. A main-process object lives as long as its tab.
 * The network ring is also left out — the console is what a dev-server
 * preview needs; a request log can be added when a use case asks for it.
 */
import type {
  CdpSend,
  ConsoleEntry,
  ConsoleLevel,
  SnapshotSession
} from '@main/browser/snapshot/types'

/** Enabled once per tab, in this order, before anything else is asked of it. */
export const CDP_DOMAINS = [
  'Page.enable',
  'Runtime.enable',
  'Log.enable',
  'DOM.enable',
  'Accessibility.enable'
]

/** Console entries kept per tab; older ones fall off the front. */
const CONSOLE_RING = 500

export const createSnapshotSession = (send: CdpSend): SnapshotSession => ({
  send,
  loaderId: '',
  snapshotSeq: 0,
  hasSnapshot: false,
  uidMap: new Map(),
  uidByNode: new Map(),
  snapshotNodes: [],
  dialog: null,
  console: [],
  consoleSeq: 0,
  cursor: { x: 0, y: 0 }
})

export const enableDomains = async (send: CdpSend): Promise<void> => {
  for (const method of CDP_DOMAINS) await send(method)
}

export const currentLoaderId = async (send: CdpSend): Promise<string> => {
  try {
    const tree = (await send('Page.getFrameTree')) as {
      frameTree?: { frame?: { loaderId?: string } }
    }
    return tree.frameTree?.frame?.loaderId ?? ''
  } catch {
    return ''
  }
}

/** A new document: every uid and message belonged to the old one. */
export const resetForNavigation = (session: SnapshotSession, loaderId: string): void => {
  session.loaderId = loaderId
  session.uidMap.clear()
  session.uidByNode.clear()
  session.snapshotNodes = []
  session.console = []
  session.dialog = null
}

// ─── Console ─────────────────────────────────────────────────────────────────

interface RemoteObjectLike {
  type: string
  subtype?: string
  value?: unknown
  description?: string
  unserializableValue?: string
}

interface StackTraceLike {
  callFrames?: { functionName?: string; url?: string; lineNumber?: number; columnNumber?: number }[]
}

const remoteText = (o: RemoteObjectLike): string => {
  if (o.unserializableValue !== undefined) return o.unserializableValue
  if (o.type === 'string') return String(o.value ?? '')
  if (o.value !== undefined)
    return typeof o.value === 'object' ? JSON.stringify(o.value) : String(o.value)
  return o.description ?? o.type
}

const LEVEL_MAP: Record<string, ConsoleLevel> = {
  log: 'log',
  info: 'info',
  warning: 'warn',
  warn: 'warn',
  error: 'error',
  debug: 'debug',
  verbose: 'debug'
}

const levelOf = (raw: string): ConsoleLevel => LEVEL_MAP[raw] ?? 'log'

const push = (session: SnapshotSession, entry: Omit<ConsoleEntry, 'seq'>): void => {
  session.console.push({ seq: ++session.consoleSeq, ...entry })
  while (session.console.length > CONSOLE_RING) session.console.shift()
}

const onConsoleApiCalled = (session: SnapshotSession, p: Record<string, unknown>): void => {
  const e = p as {
    type: string
    args?: RemoteObjectLike[]
    timestamp: number
    stackTrace?: StackTraceLike
  }
  const top = e.stackTrace?.callFrames?.[0]
  push(session, {
    level: levelOf(e.type),
    text: (e.args ?? []).map(remoteText).join(' '),
    source: 'console',
    url: top?.url || undefined,
    line: top ? (top.lineNumber ?? 0) + 1 : undefined,
    timestamp: e.timestamp
  })
}

const onExceptionThrown = (session: SnapshotSession, p: Record<string, unknown>): void => {
  const e = p as {
    timestamp: number
    exceptionDetails: {
      text: string
      url?: string
      lineNumber?: number
      exception?: RemoteObjectLike
    }
  }
  const d = e.exceptionDetails
  const text = d.exception?.description ?? (d.exception ? remoteText(d.exception) : d.text)
  push(session, {
    level: 'error',
    text,
    source: 'exception',
    url: d.url,
    line: d.lineNumber !== undefined ? d.lineNumber + 1 : undefined,
    timestamp: e.timestamp
  })
}

const onLogEntry = (session: SnapshotSession, p: Record<string, unknown>): void => {
  const e = p as {
    entry: {
      source: string
      level: string
      text: string
      timestamp: number
      url?: string
      lineNumber?: number
    }
  }
  const entry = e.entry
  push(session, {
    level: levelOf(entry.level),
    text:
      entry.source && entry.source !== 'javascript'
        ? `[${entry.source}] ${entry.text}`
        : entry.text,
    source: 'log',
    url: entry.url,
    line: entry.lineNumber !== undefined ? entry.lineNumber + 1 : undefined,
    timestamp: entry.timestamp
  })
}

const onFrameNavigated = (session: SnapshotSession, p: Record<string, unknown>): void => {
  const e = p as { frame: { id: string; parentId?: string; loaderId: string; url: string } }
  if (e.frame.parentId) return
  resetForNavigation(session, e.frame.loaderId)
}

const onDialogOpening = (session: SnapshotSession, p: Record<string, unknown>): void => {
  const e = p as { url: string; message: string; type: string; defaultPrompt?: string }
  session.dialog = {
    type: e.type,
    message: e.message,
    defaultPrompt: e.defaultPrompt ?? '',
    url: e.url
  }
}

const EVENT_HANDLERS: Record<
  string,
  (session: SnapshotSession, params: Record<string, unknown>) => void
> = {
  'Page.javascriptDialogOpening': onDialogOpening,
  'Page.javascriptDialogClosed': (session) => {
    session.dialog = null
  },
  'Page.frameNavigated': onFrameNavigated,
  'Runtime.consoleAPICalled': onConsoleApiCalled,
  'Runtime.exceptionThrown': onExceptionThrown,
  'Log.entryAdded': onLogEntry
}

/** Route one CDP event into the session. Unknown methods are ignored. */
export const handleSessionEvent = (
  session: SnapshotSession,
  method: string,
  params: Record<string, unknown>
): void => {
  EVENT_HANDLERS[method]?.(session, params)
}
