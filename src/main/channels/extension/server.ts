import {
  listConversations,
  logEvent,
  lookupTitle,
  readEvents,
  type ConversationSummary,
  type ExtensionEvent
} from '@main/channels/extension/log'
import {
  applyFix,
  collectFacts,
  composeFindings,
  type BrowserDoctorProbe,
  type DoctorOptions,
  type DoctorReport,
  type DoctorServerView,
  type FixOptions,
  type FixResult
} from '@main/channels/extension/doctor'
import { diskWriter } from '@main/io/diskWriter'
import { wlog } from '@main/workspace/logger'
import {
  getBrowserExtensionConfig,
  getRuntimeExtensionVersion,
  recordExtensionSeen,
  setBrowserExtensionConfig
} from '@main/workspace/workspace'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'

const TAG = 'extension'
/** A client whose last ping is older than this is a dead peer. */
const HEARTBEAT_CHECK_MS = 45_000
/** Sweep cadence — short so zombies linger ~1 sweep, not ~2 check windows. */
const HEARTBEAT_SWEEP_MS = 15_000
/**
 * Every real extension (old or new) sends extension_info immediately on
 * open. A connection that stays silent this long is not an extension —
 * typically the orphaned socket of a reloaded service worker.
 */
const IDENTITY_TIMEOUT_MS = 10_000
/**
 * A full doctor report (with the extension round-trip) is served to the
 * cheap readiness path for this long; a probe-less report half as long.
 */
const DOCTOR_CACHE_MS = 60_000
const READINESS_CACHE_MS = 30_000
/** Origins Chrome/Firefox stamp on extension-initiated sockets. Anything else is a web page. */
const EXTENSION_ORIGIN = /^(chrome|moz)-extension:\/\//

// ─── Debug Logger ───────────────────────────────────────────────────────────

const DEBUG_DIR = join(homedir(), '.wolffish', 'workspace', 'logs', 'extension', '.debug')
let debugReady: Promise<void> | null = null

function ensureDebugDir(): Promise<void> {
  if (!debugReady) debugReady = mkdir(DEBUG_DIR, { recursive: true }).then(() => {})
  return debugReady
}

function debugStamp(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '')
}

function debugFile(): string {
  return join(DEBUG_DIR, `${new Date().toISOString().slice(0, 10)}.log`)
}

async function debug(level: string, msg: string): Promise<void> {
  const line = `${debugStamp()}  ${level.padEnd(5)}  ${msg}\n`
  try {
    await ensureDebugDir()
    await diskWriter.appendLine(debugFile(), line)
  } catch {
    // never let debug logging crash anything
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type ExtensionConnectionStatus = 'stopped' | 'listening' | 'connected' | 'error'

/** One connected browser, as shown in the panel and to the model. */
export interface ExtensionBrowserInfo {
  id: string
  /** Stable per-browser-profile id — survives reloads; lets the panel match a returning browser to its row. */
  instanceId: string | null
  /** Selection key: the browser slug, suffixed -1/-2 when the same browser is connected twice. */
  key: string
  browser: string
  name: string
  version: string | null
  browserVersion: string | null
  os: string | null
  /** Signed-in profile email — distinguishes profiles of the same browser. */
  profileEmail: string | null
  /** chrome.runtime.id — needed for chrome://extensions/?id= links; null on pre-v2 extensions. */
  extensionId: string | null
  /** Connected without a bridge token (pre-v2 extension build). Accepted, but flagged. */
  legacy: boolean
  /** The extension's own on-page overlay switch, as reported at handshake. */
  overlayEnabled: boolean
  connectedAt: number
  lastPing: number
}

export interface ExtensionServerStatus {
  status: ExtensionConnectionStatus
  error: string | null
  extensionVersion: string | null
  port: number
  browsers: ExtensionBrowserInfo[]
}

interface ExtensionClient {
  id: string
  ws: WebSocket
  connectedAt: number
  lastPing: number
  /**
   * null until extension_info arrives. Unidentified clients are invisible —
   * not listed, not routable — and are terminated after IDENTITY_TIMEOUT_MS.
   */
  version: string | null
  /** Stable per-browser-profile id persisted by the extension; null for pre-identity extensions. */
  instanceId: string | null
  browser: string
  name: string
  browserVersion: string | null
  os: string | null
  profileEmail: string | null
  extensionId: string | null
  legacy: boolean
  overlayEnabled: boolean
  identityTimer: ReturnType<typeof setTimeout> | null
}

export interface ExtensionServerOptions {
  /**
   * Refuse sockets without a `chrome-extension://` / `moz-extension://`
   * Origin. Default true; the protocol test opts out because its fake
   * clients are plain `ws` sockets with no origin.
   */
  requireOrigin?: boolean
}

interface PendingCommand {
  resolve: (response: WolffishResponse) => void
  reject: (error: Error) => void
  clientId: string
}

interface WolffishCommand {
  id: string
  type: string
  params: Record<string, unknown>
  /**
   * The conversation this command belongs to. The extension gives each one its
   * own tab group, so two jobs running at once — or back to back — never share
   * a tab, and one job's group title can never be left over the next one's work.
   */
  session?: string
}

interface WolffishResponse {
  id: string
  success: boolean
  data?: unknown
  error?: string
}

export interface SendCommandOptions {
  /** Browser selection query (key, slug, or name fragment). */
  target?: string | null
  /** Conversation whose sticky browser selection applies. */
  conversationId?: string | null
}

// ─── Server ─────────────────────────────────────────────────────────────────

export class ExtensionServer {
  private wss: WebSocketServer | null = null
  private clients = new Map<string, ExtensionClient>()
  private stickyByConversation = new Map<string, string>()
  /**
   * slug → (instanceId → slot number). Slots are assigned once per browser
   * instance and never renumbered or reused while the app runs, so a
   * reloading browser reclaims its own chrome-N key instead of swapping
   * keys with its sibling profile mid-conversation. Survives stop()/start()
   * (port changes) deliberately; resets only with the app.
   */
  private keySlots = new Map<string, Map<string, number>>()
  private status: ExtensionConnectionStatus = 'stopped'
  private statusError: string | null = null
  private pendingCommands = new Map<string, PendingCommand>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private currentConversationId: string | null = null
  /** clientId → conversation last events_sync'd to that client's panel. */
  private syncedByClient = new Map<string, string>()
  /**
   * conversationId → the freshest title the app has told us about. The side
   * panel needs a title per conversation, not the one the app window happens
   * to be showing: a background job runs under its own name. Falls back to the
   * conversation file on disk; bounded because conversations accumulate.
   */
  private titles = new Map<string, string>()
  /**
   * Panel pushes run one at a time. `events_sync` switches a panel to a
   * conversation, so two jobs alternating on one browser must land in the
   * order they were queued — otherwise the panel ends up showing one
   * conversation while the server thinks it shows the other, and the next
   * single event is appended to the wrong timeline.
   */
  private syncChain: Promise<void> = Promise.resolve()
  private currentPort = 23151
  private onStatusChange: ((status: ExtensionServerStatus) => void) | null = null
  private readonly requireOrigin: boolean
  /** Last full doctor report + when it was produced (readiness serves it while fresh). */
  private doctorCache: { report: DoctorReport; at: number; probed: boolean } | null = null
  /** Last handshake refused for a wrong bridge token — the doctor turns a recent one into a finding. */
  private tokenMismatch: { at: number; browser: string } | null = null
  /** Last `browser_debugger_attach` failure — "Another debugger is attached" is a finding while recent. */
  private attachError: { at: number; error: string } | null = null
  /** slug → extensionId of the last browser that identified with one; lets open_extension_details work after a disconnect. */
  private extensionIdBySlug = new Map<string, string>()

  constructor(options: ExtensionServerOptions = {}) {
    this.requireOrigin = options.requireOrigin !== false
  }

  setStatusChangeHandler(handler: (status: ExtensionServerStatus) => void): void {
    this.onStatusChange = handler
  }

  async start(config: { port: number }): Promise<ExtensionServerStatus> {
    void debug('INFO', `start() called: port=${config.port}`)

    if (this.wss) {
      void debug('INFO', 'start() stopping existing server first')
      await this.stop()
    }

    this.currentPort = config.port
    // The bridge exists for the lifetime of the server, not of a client:
    // ext_doctor / ext_fix must be reachable when NOTHING is connected —
    // that is exactly when they are needed — and even when the port is
    // busy (the doctor is how the user learns that). isConnected() keeps
    // answering the real question.
    this.exposeBridge()

    return new Promise((resolve) => {
      try {
        this.wss = new WebSocketServer({ port: config.port, host: '127.0.0.1' })
        void debug('INFO', `WebSocketServer created on 127.0.0.1:${config.port}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.status = 'error'
        this.statusError = message
        wlog.error(TAG, `Failed to create server: ${message}`)
        void debug('ERROR', `WebSocketServer constructor threw: ${message}`)
        resolve(this.getStatus())
        return
      }

      this.wss.on('listening', () => {
        this.status = 'listening'
        this.statusError = null
        wlog.info(TAG, `WebSocket server listening on port ${config.port}`)
        void debug('INFO', `listening on port ${config.port}`)
        this.broadcastStatus()
        resolve(this.getStatus())
      })

      this.wss.on('error', (err: NodeJS.ErrnoException) => {
        const message =
          err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use` : err.message
        this.status = 'error'
        this.statusError = message
        wlog.error(TAG, message)
        void debug('ERROR', `server error: code=${err.code} message=${message}`)
        this.broadcastStatus()
        resolve(this.getStatus())
      })

      this.wss.on('connection', (ws: WebSocket, req) => {
        const origin = req.headers.origin ?? 'none'
        const ua = req.headers['user-agent'] ?? 'none'
        void debug(
          'INFO',
          `new connection: origin=${origin} ua=${ua.slice(0, 80)} readyState=${ws.readyState}`
        )
        // Only an extension may talk to this socket. Browsers stamp
        // extension-initiated WebSockets with the extension's own origin
        // and never let a page forge it, so a missing or foreign Origin is
        // a web page (or a stray local tool) probing the port — drop it
        // before it can learn anything.
        if (this.requireOrigin && !EXTENSION_ORIGIN.test(req.headers.origin ?? '')) {
          void debug('WARN', `refusing connection with origin=${origin} — not an extension`)
          ws.terminate()
          return
        }
        this.handleConnection(ws)
      })
    })
  }

  async stop(): Promise<void> {
    void debug('INFO', 'stop() called')
    this.stopHeartbeat()
    this.rejectAllPending('Server shutting down')

    for (const client of this.clients.values()) {
      client.ws.close()
    }
    this.clients.clear()
    this.stickyByConversation.clear()
    this.syncedByClient.clear()
    this.doctorCache = null
    this.clearBridge()

    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve())
      })
      this.wss = null
    }

    this.status = 'stopped'
    this.statusError = null
    this.broadcastStatus()
    wlog.info(TAG, 'Server stopped')
    void debug('INFO', 'server stopped')
  }

  isConnected(): boolean {
    return this.identifiedClients().length > 0
  }

  getStatus(): ExtensionServerStatus {
    const keys = this.selectionKeys()
    const browsers = this.identifiedClients().map((c) => this.toBrowserInfo(c, keys))
    return {
      status: this.status,
      error: this.statusError,
      extensionVersion: browsers[0]?.version ?? null,
      port: this.currentPort,
      browsers
    }
  }

  setConversationId(id: string | null, title?: string | null): void {
    if (!id) return
    this.currentConversationId = id
    if (title && title !== 'Untitled') this.rememberTitle(id, title)
  }

  /**
   * A conversation was (re)titled. Recorded for whichever conversation it
   * names — including one running in the background, whose title the panel
   * would otherwise show as whatever the app window was last on — and pushed
   * only when some panel is actually showing that conversation.
   */
  updateTitle(id: string, title: string): void {
    if (!id || !title || title === 'Untitled') return
    if (this.titles.get(id) === title) return
    this.rememberTitle(id, title)
    if (!this.isConnected()) return
    if ([...this.syncedByClient.values()].includes(id)) {
      void this.pushEventsSync(id)
    }
  }

  private rememberTitle(id: string, title: string): void {
    this.titles.delete(id)
    this.titles.set(id, title)
    // Insertion-ordered, so the oldest key is the first one out.
    while (this.titles.size > 200) {
      const oldest = this.titles.keys().next().value
      if (oldest === undefined) break
      this.titles.delete(oldest)
    }
  }

  /** The title to show for a conversation: freshest first, then disk, then Untitled. */
  private async titleFor(conversationId: string): Promise<string> {
    const known = this.titles.get(conversationId)
    if (known) return known
    const stored = await lookupTitle(conversationId)
    if (stored && stored !== 'Untitled') this.rememberTitle(conversationId, stored)
    return stored || 'Untitled'
  }

  /** Connected browsers as shown to the model (selection keys included). */
  listBrowsers(): ExtensionBrowserInfo[] {
    return this.getStatus().browsers
  }

  /**
   * Pin a conversation to one connected browser. Throws with a model-facing
   * message when the query matches zero or several browsers.
   */
  useBrowser(query: string, conversationId?: string | null): ExtensionBrowserInfo {
    const convId = conversationId ?? this.currentConversationId
    const client = this.resolveClient(query, convId)
    if (convId) this.stickyByConversation.set(convId, client.id)
    void debug('INFO', `useBrowser: conv=${convId} -> ${client.name} (${client.id})`)
    return this.toBrowserInfo(client, this.selectionKeys())
  }

  async sendCommand(
    type: string,
    params: Record<string, unknown>,
    opts?: SendCommandOptions
  ): Promise<WolffishResponse> {
    const conversationId = opts?.conversationId ?? this.currentConversationId
    const client = this.resolveClient(opts?.target ?? null, conversationId)
    return this.dispatchCommand(client, type, params, conversationId)
  }

  private async dispatchCommand(
    client: ExtensionClient,
    type: string,
    params: Record<string, unknown>,
    // Which conversation owns the browser workspace this lands in. Taken from
    // the caller rather than `currentConversationId`, which is whichever
    // conversation the user last looked at — not necessarily the one running.
    conversationId: string | null = this.currentConversationId
  ): Promise<WolffishResponse> {
    const id = randomUUID()
    const command: WolffishCommand = { id, type, params }
    if (conversationId) command.session = conversationId

    // Logged against the conversation that RAN the command, not the one the
    // app window is showing: a background job's browser activity belongs in
    // its own timeline, under its own name.
    if (conversationId) {
      const event = await logEvent(conversationId, type, params, client.instanceId)

      // Sync state is per client: each browser's panel follows only the
      // conversations that browser executes, so a mid-conversation browser
      // switch re-syncs the new browser instead of leaking single events
      // into whatever its panel showed before.
      if (conversationId !== this.syncedByClient.get(client.id)) {
        this.syncedByClient.set(client.id, conversationId)
        void this.pushEventsSync(conversationId, client)
      } else {
        this.pushEventLogged(client, event)
      }
    }

    // No execution timeout: a command runs for as long as it legitimately
    // needs (e.g. humanized typing of a long body). Pending commands are not
    // orphaned — they are settled when their client's socket closes, the
    // server shuts down, or the same browser instance reconnects, which is
    // the only way a sent command can fail to come back.
    const response = await new Promise<WolffishResponse>((resolve, reject) => {
      this.pendingCommands.set(id, { resolve, reject, clientId: client.id })

      try {
        client.ws.send(JSON.stringify(command))
      } catch (err) {
        this.pendingCommands.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
    // A refused attach is the one debugger failure the user can fix
    // (close DevTools); remember it so the doctor can name it while recent.
    if (type === 'browser_debugger_attach' && !response.success && response.error) {
      if (/another debugger|already attached/i.test(response.error)) {
        this.attachError = { at: Date.now(), error: response.error }
      }
    } else if (type === 'browser_debugger_attach' && response.success) {
      this.attachError = null
    }
    return response
  }

  async runTestScenario(
    target?: string | null
  ): Promise<{ ok: boolean; steps: number; passed: number }> {
    const identified = this.identifiedClients()
    if (identified.length === 0) {
      return { ok: false, steps: 0, passed: 0 }
    }
    let client: ExtensionClient
    try {
      client = target ? this.resolveClient(target, null) : identified[0]
    } catch {
      return { ok: false, steps: 0, passed: 0 }
    }

    void debug('INFO', `running test scenario against ${client.name} (${client.id})`)
    const saved = this.currentConversationId
    const testId = `test-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}`
    this.currentConversationId = testId

    // Push events_sync so the tested browser shows this conversation as active
    void this.pushEventsSync(testId, client)

    const steps: Array<{ type: string; params: Record<string, unknown> }> = [
      { type: 'browser_tab_open', params: { url: 'https://wolffi.sh/extension', active: true } },
      { type: 'browser_get_url', params: {} },
      { type: 'browser_tabs_list', params: {} },
      { type: 'browser_cookies_get', params: { domain: 'wolffi.sh' } },
      { type: 'browser_screenshot', params: {} },
      { type: 'browser_read_page', params: { format: 'markdown' } },
      { type: 'browser_query_selector', params: { selector: 'h1', limit: 1 } },
      { type: 'browser_get_page_info', params: {} },
      { type: 'browser_scroll', params: { direction: 'down', amount: 300 } },
      { type: 'browser_screenshot', params: { fullPage: true } }
    ]

    let passed = 0
    for (const step of steps) {
      try {
        const res = await this.dispatchCommand(client, step.type, step.params, testId)
        if (res.success) passed++
        else void debug('WARN', `test ${step.type}: ${res.error}`)
      } catch (err) {
        void debug('WARN', `test ${step.type} threw: ${err instanceof Error ? err.message : err}`)
      }
    }

    this.currentConversationId = saved
    void debug('INFO', `test scenario complete: ${passed}/${steps.length}`)
    return { ok: passed === steps.length, steps: steps.length, passed }
  }

  sendPortUpdate(port: number): void {
    this.broadcastRaw({ type: 'event', event: 'port_update', data: { port } })
  }

  /** Reload the extension in one browser (by selection query) or all when no target. */
  async requestReload(target?: string | null): Promise<void> {
    try {
      if (target && target.trim()) {
        const client = this.resolveClient(target, null)
        this.sendRaw(client, { type: 'event', event: 'extension_reload', data: {} })
        return
      }
      this.broadcastRaw({ type: 'event', event: 'extension_reload', data: {} })
    } catch {
      // best-effort
    }
  }

  /**
   * Flip the on-page overlay (shadow cursor + pill) for one browser or
   * all. Persisted in config so the choice survives restarts; pushed as an
   * `overlay_config` event so the extension writes its own storage key and
   * the side-panel toggle reflects it.
   */
  async setOverlayEnabled(enabled: boolean, target?: string | null): Promise<void> {
    await setBrowserExtensionConfig({ overlayEnabled: enabled })
    const data = { type: 'event', event: 'overlay_config', data: { enabled } }
    if (target && target.trim()) {
      const client = this.resolveClient(target, null)
      client.overlayEnabled = enabled
      this.sendRaw(client, data)
    } else {
      for (const client of this.identifiedClients()) client.overlayEnabled = enabled
      this.broadcastRaw(data)
    }
    this.broadcastStatus()
  }

  /**
   * Run `browser_doctor` on the browser a command would go to. The doctor
   * calls this through DoctorServerView; it throws the same model-facing
   * routing errors sendCommand does when nothing matches.
   */
  async probeExtension(
    opts: DoctorOptions
  ): Promise<{ browser: ExtensionBrowserInfo; probe: BrowserDoctorProbe }> {
    // resolveClient throws when several browsers are connected and none is
    // sticky — correct for a task command, wrong for a diagnostic: the doctor
    // would then report "could not probe" for the very ambiguity it is there
    // to describe. Fall back to the first identified browser and say which.
    let client: ExtensionClient
    try {
      client = this.resolveClient(
        opts.target ?? null,
        opts.conversationId ?? this.currentConversationId
      )
    } catch (err) {
      const first = this.identifiedClients()[0]
      if (!first) throw err
      client = first
    }
    const params: Record<string, unknown> = {}
    if (typeof opts.tabId === 'number') params.tabId = opts.tabId
    const res = await this.dispatchCommand(
      client,
      'browser_doctor',
      params,
      opts.conversationId ?? this.currentConversationId
    )
    if (!res.success) throw new Error(res.error ?? 'browser_doctor failed')
    return {
      browser: this.toBrowserInfo(client, this.selectionKeys()),
      probe: res.data as BrowserDoctorProbe
    }
  }

  private doctorView(): DoctorServerView {
    return {
      getStatus: () => this.getStatus(),
      probeExtension: (opts) => this.probeExtension(opts),
      lastTokenMismatch: () => this.tokenMismatch,
      lastAttachError: () => this.attachError
    }
  }

  /** Full readiness report: every local probe plus the extension round-trip when a browser is connected. */
  async doctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
    const facts = await collectFacts(this.doctorView(), opts)
    const report = composeFindings(facts)
    this.doctorCache = { report, at: Date.now(), probed: opts.probe !== false }
    void debug('INFO', `doctor: ready=${report.ready} tier=${report.tier} — ${report.summary}`)
    return report
  }

  /** The last report doctor() produced, or null. Consumers that need freshness call doctor(). */
  lastDoctorReport(): DoctorReport | null {
    return this.doctorCache?.report ?? null
  }

  /**
   * Cheap readiness for surfaces that render often (the mobile snapshot):
   * the last full report while fresh, else a probe-less compose — local
   * facts only, one process listing, no extension round-trip.
   */
  async readiness(): Promise<DoctorReport> {
    const cached = this.doctorCache
    if (cached) {
      const ttl = cached.probed ? DOCTOR_CACHE_MS : READINESS_CACHE_MS
      if (Date.now() - cached.at < ttl) return cached.report
    }
    return this.doctor({ probe: false })
  }

  /** Run one doctor fix. Server-side actions: port, reload, resync, openers, and starting a browser. */
  async fix(action: string, opts: FixOptions = {}): Promise<FixResult> {
    void debug('INFO', `fix: ${action} ${JSON.stringify(opts)}`)
    const target = opts.target ?? null
    let extensionId: string | null = opts.extensionId ?? null
    if (!extensionId) {
      const client = this.identifiedClients().find((c) => c.extensionId)
      extensionId = client?.extensionId ?? [...this.extensionIdBySlug.values()][0] ?? null
    }
    const result = await applyFix(
      action,
      {
        restartServer: async (port) => {
          await this.stop()
          await this.start({ port })
        },
        sendPortUpdate: (port) => this.sendPortUpdate(port),
        requestReload: (t) => this.requestReload(t ?? target),
        isExtensionConnected: () => this.identifiedClients().length > 0,
        extensionId
      },
      opts
    )
    this.doctorCache = null
    return result
  }

  private async checkVersionAndReload(client: ExtensionClient): Promise<void> {
    if (!client.version) return
    try {
      const runtimeVersion = await getRuntimeExtensionVersion()
      void debug(
        'INFO',
        `version check: ${client.name}=${client.version} runtime=${runtimeVersion}`
      )
      if (!runtimeVersion) return
      if (client.version !== runtimeVersion) {
        wlog.info(
          TAG,
          `Extension version mismatch on ${client.name}: running=${client.version} runtime=${runtimeVersion} — sending reload`
        )
        void debug('INFO', `sending extension_reload to ${client.name} due to version mismatch`)
        this.sendRaw(client, { type: 'event', event: 'extension_reload', data: {} })
      } else {
        wlog.info(TAG, `Extension version ${client.version} is current on ${client.name}`)
      }
    } catch (err) {
      void debug('ERROR', `version check failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  async getConversations(): ReturnType<typeof listConversations> {
    return listConversations()
  }

  async getConversationEvents(conversationId: string): Promise<ExtensionEvent[]> {
    return readEvents(conversationId)
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private openClients(): ExtensionClient[] {
    return [...this.clients.values()].filter((c) => c.ws.readyState === 1 /* OPEN */)
  }

  /**
   * Clients that completed the extension_info handshake — the only ones
   * listed, routable, and counted as "connected". A freshly accepted socket
   * that hasn't identified yet (or never will — an orphaned pre-reload
   * socket) must not surface as a ghost "Browser" entry.
   */
  private identifiedClients(): ExtensionClient[] {
    return this.openClients().filter((c) => c.version !== null)
  }

  private toBrowserInfo(c: ExtensionClient, keys: Map<string, string>): ExtensionBrowserInfo {
    return {
      id: c.id,
      instanceId: c.instanceId,
      key: keys.get(c.id) ?? c.browser,
      browser: c.browser,
      name: c.name,
      version: c.version,
      browserVersion: c.browserVersion,
      os: c.os,
      profileEmail: c.profileEmail,
      extensionId: c.extensionId,
      legacy: c.legacy,
      overlayEnabled: c.overlayEnabled,
      connectedAt: c.connectedAt,
      lastPing: c.lastPing
    }
  }

  /** Stable per-instance slot for numbered keys; assigned on first sight. */
  private slotFor(client: ExtensionClient): number {
    const instanceKey = client.instanceId ?? `conn:${client.id}`
    let slots = this.keySlots.get(client.browser)
    if (!slots) {
      slots = new Map()
      this.keySlots.set(client.browser, slots)
    }
    const existing = slots.get(instanceKey)
    if (existing !== undefined) return existing
    const next = slots.size === 0 ? 1 : Math.max(...slots.values()) + 1
    slots.set(instanceKey, next)
    return next
  }

  /** clientId → selection key (slug, or slug-N by persistent slot when a slug repeats). */
  private selectionKeys(): Map<string, string> {
    const bySlug = new Map<string, ExtensionClient[]>()
    for (const c of this.identifiedClients()) {
      const group = bySlug.get(c.browser) ?? []
      group.push(c)
      bySlug.set(c.browser, group)
    }
    const keys = new Map<string, string>()
    for (const [slug, group] of bySlug) {
      if (group.length === 1) keys.set(group[0].id, slug)
      else for (const c of group) keys.set(c.id, `${slug}-${this.slotFor(c)}`)
    }
    return keys
  }

  private describeBrowsers(): string {
    const keys = this.selectionKeys()
    return this.identifiedClients()
      .map((c) => {
        const version = c.browserVersion ? ` ${c.browserVersion.split('.')[0]}` : ''
        const profile = c.profileEmail ? ` (${c.profileEmail})` : ''
        return `${c.name}${version}${profile} [${keys.get(c.id) ?? c.browser}]`
      })
      .join(', ')
  }

  /** connected ⇄ listening tracks identified clients; error/stopped are set elsewhere. */
  private refreshConnectionStatus(): void {
    if (!this.wss || this.status === 'error' || this.status === 'stopped') return
    this.status = this.identifiedClients().length > 0 ? 'connected' : 'listening'
  }

  /**
   * Pick the browser a command goes to. Model-facing errors: every throw
   * explains what is connected and how to choose.
   */
  private resolveClient(target: string | null, conversationId: string | null): ExtensionClient {
    const identified = this.identifiedClients()
    if (identified.length === 0) {
      throw new Error('Browser extension is not connected')
    }

    if (target && target.trim()) {
      const q = target.trim().toLowerCase()
      const keys = this.selectionKeys()
      let matches = identified.filter((c) => keys.get(c.id) === q || c.browser === q)
      if (matches.length === 0) {
        matches = identified.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.browser.startsWith(q) ||
            (c.profileEmail ?? '').toLowerCase().includes(q)
        )
      }
      if (matches.length === 1) {
        if (conversationId) this.stickyByConversation.set(conversationId, matches[0].id)
        return matches[0]
      }
      if (matches.length === 0) {
        throw new Error(
          `No connected browser matches "${target}". Connected browsers: ${this.describeBrowsers()}.`
        )
      }
      throw new Error(
        `"${target}" matches more than one connected browser: ${this.describeBrowsers()}. Use the exact key in brackets to disambiguate.`
      )
    }

    if (identified.length === 1) return identified[0]

    if (conversationId) {
      const stickyId = this.stickyByConversation.get(conversationId)
      const sticky = stickyId ? this.clients.get(stickyId) : undefined
      if (sticky && sticky.ws.readyState === 1 && sticky.version !== null) return sticky
    }

    throw new Error(
      `Multiple browsers are connected: ${this.describeBrowsers()}. No browser is selected for this conversation yet — call ext_use_browser with the key in brackets to pick one. If the user's request or the conversation makes the choice obvious, pick it yourself; otherwise ask the user which browser to use.`
    )
  }

  private handleConnection(ws: WebSocket): void {
    const client: ExtensionClient = {
      id: randomUUID(),
      ws,
      connectedAt: Date.now(),
      lastPing: Date.now(),
      version: null,
      instanceId: null,
      browser: 'browser',
      name: 'Browser',
      browserVersion: null,
      os: null,
      profileEmail: null,
      extensionId: null,
      legacy: false,
      overlayEnabled: true,
      identityTimer: null
    }
    this.clients.set(client.id, client)
    this.startHeartbeat()
    // Not yet visible anywhere: status, panel, and routing only pick the
    // client up once extension_info arrives. A socket that never identifies
    // (orphan of a reloaded service worker) is culled here instead of
    // haunting the panel as a version-less "Browser" row.
    client.identityTimer = setTimeout(() => {
      client.identityTimer = null
      if (this.clients.has(client.id) && client.version === null) {
        void debug(
          'WARN',
          `no extension_info after ${IDENTITY_TIMEOUT_MS}ms — terminating ${client.id}`
        )
        wlog.info(TAG, 'Dropping connection that never identified itself')
        client.ws.terminate()
        this.removeClient(client, 'Never identified')
      }
    }, IDENTITY_TIMEOUT_MS)
    void debug('INFO', `handleConnection complete — id=${client.id} readyState=${ws.readyState}`)

    ws.on('message', (data: Buffer | string) => {
      const raw = String(data)
      void debug('RECV', `[${client.name}] ${raw.slice(0, 300)}`)
      this.handleMessage(client, raw)
    })

    ws.on('close', (code: number, reason: Buffer) => {
      const reasonStr = reason.toString()
      void debug(
        'INFO',
        `ws close: id=${client.id} browser=${client.name} code=${code} reason="${reasonStr}"`
      )
      wlog.info(TAG, `WebSocket close: code=${code} reason="${reasonStr}" browser=${client.name}`)
      this.removeClient(client, 'Extension disconnected')
    })

    ws.on('error', (err) => {
      void debug('ERROR', `ws error (${client.name}): ${err.message}`)
      wlog.error(TAG, `WebSocket error: ${err.message}`)
    })

    ws.on('unexpected-response', (_req, res) => {
      void debug('ERROR', `unexpected-response: status=${res.statusCode}`)
      wlog.error(TAG, `Unexpected response: ${res.statusCode}`)
    })
  }

  private removeClient(client: ExtensionClient, reason: string): void {
    if (!this.clients.has(client.id)) return
    const wasIdentified = client.version !== null
    if (client.identityTimer) {
      clearTimeout(client.identityTimer)
      client.identityTimer = null
    }
    this.clients.delete(client.id)
    this.rejectPendingFor(client.id, reason)
    this.syncedByClient.delete(client.id)
    for (const [conv, cid] of this.stickyByConversation) {
      if (cid === client.id) this.stickyByConversation.delete(conv)
    }
    this.refreshConnectionStatus()
    // The bridge stays up: it belongs to the listening server (see start()),
    // so a disconnect must not take ext_doctor away right when it is needed.
    if (this.clients.size === 0) this.stopHeartbeat()
    if (wasIdentified) {
      wlog.info(
        TAG,
        this.identifiedClients().length === 0
          ? 'Extension disconnected'
          : `${client.name} disconnected (${this.identifiedClients().length} remaining)`
      )
      this.broadcastStatus()
    }
    void debug('INFO', `cleanup complete after disconnect of ${client.id}`)
  }

  private handleMessage(client: ExtensionClient, raw: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw) as Record<string, unknown>
    } catch {
      void debug('WARN', `invalid JSON: ${raw.slice(0, 100)}`)
      wlog.warn(TAG, 'Received invalid JSON')
      return
    }

    if (msg.type === 'ping') {
      client.lastPing = Date.now()
      this.sendRaw(client, { type: 'pong' })
      return
    }

    if (msg.type === 'get_conversations') {
      void this.pushConversationsList(client)
      return
    }

    if (msg.type === 'get_conversation_events' && typeof msg.conversationId === 'string') {
      void this.pushConversationEvents(client, msg.conversationId as string)
      return
    }

    if (msg.type === 'extension_info') {
      // Stop the orphan timer synchronously — identification itself awaits
      // the config read for the token check and must not race the cull.
      if (client.identityTimer) {
        clearTimeout(client.identityTimer)
        client.identityTimer = null
      }
      void this.identify(client, msg)
      return
    }

    if (typeof msg.id === 'string') {
      const pending = this.pendingCommands.get(msg.id)
      if (pending) {
        this.pendingCommands.delete(msg.id)
        pending.resolve(msg as unknown as WolffishResponse)
        void debug('INFO', `resolved command ${msg.id}`)
      } else {
        void debug('WARN', `no pending command for id=${msg.id}`)
      }
    }
  }

  /**
   * Complete the handshake. Token validation comes first: a client that
   * presents a token is a v2 build and must present OURS — a mismatch is a
   * copy of the extension this app did not sync (second install, another
   * machine's folder) and is refused before it becomes visible anywhere.
   * No token at all is a pre-v2 build: accepted, flagged legacy, so the
   * doctor can say why newer tools are missing.
   */
  private async identify(client: ExtensionClient, msg: Record<string, unknown>): Promise<void> {
    const browser = typeof msg.browser === 'string' && msg.browser ? msg.browser : client.browser
    const name =
      typeof msg.browserName === 'string' && msg.browserName ? msg.browserName : client.name
    const presented =
      typeof msg.bridgeToken === 'string' && msg.bridgeToken ? msg.bridgeToken : null
    if (presented) {
      let expected: string | undefined
      try {
        expected = (await getBrowserExtensionConfig()).bridgeToken
      } catch {
        expected = undefined
      }
      if (!this.clients.has(client.id)) return // closed while we read config
      if (expected && presented !== expected) {
        void debug('WARN', `bridge token mismatch from ${name} (${client.id}) — terminating`)
        wlog.warn(TAG, `Refused ${name}: its extension folder was not synced by this Wolffish`)
        this.tokenMismatch = { at: Date.now(), browser }
        client.ws.terminate()
        this.removeClient(client, 'bridge token mismatch')
        return
      }
    }
    if (!this.clients.has(client.id)) return

    client.version = (msg.version as string) ?? null
    client.instanceId = typeof msg.instanceId === 'string' ? msg.instanceId : null
    client.browser = browser
    client.name = name
    client.browserVersion = typeof msg.browserVersion === 'string' ? msg.browserVersion : null
    client.os = typeof msg.os === 'string' && msg.os ? msg.os : null
    client.profileEmail =
      typeof msg.profileEmail === 'string' && msg.profileEmail ? msg.profileEmail : null
    client.extensionId =
      typeof msg.extensionId === 'string' && msg.extensionId ? msg.extensionId : null
    client.legacy = presented === null
    client.overlayEnabled = msg.overlayEnabled !== false
    if (client.extensionId) this.extensionIdBySlug.set(client.browser, client.extensionId)
    void debug(
      'INFO',
      `extension_info: version=${client.version} browser=${client.browser} name=${client.name} profile=${client.profileEmail ?? 'none'} instance=${client.instanceId ?? 'none'} ext=${client.extensionId ?? 'none'} legacy=${client.legacy} overlay=${client.overlayEnabled}`
    )
    this.dedupeInstance(client)
    // Claim the instance's key slot now (idempotent) so numbering follows
    // true first-connect order, not whenever duplication first renders.
    this.slotFor(client)
    this.statusError = null
    this.refreshConnectionStatus()
    this.doctorCache = null
    this.broadcastStatus()
    wlog.info(
      TAG,
      `Extension connected: ${client.name} (${this.identifiedClients().length} browser${this.identifiedClients().length === 1 ? '' : 's'})`
    )
    if (client.instanceId) {
      void recordExtensionSeen(client.instanceId, {
        name: client.name,
        browser: client.browser,
        version: client.version,
        profileEmail: client.profileEmail
      }).catch((err) =>
        debug('ERROR', `recordExtensionSeen failed: ${err instanceof Error ? err.message : err}`)
      )
    }
    void this.checkVersionAndReload(client)
  }

  /**
   * The same browser instance reconnecting (service-worker restart, app
   * relaunch) must replace its old socket instead of appearing twice.
   * Sticky conversation selections follow the instance to the new socket.
   */
  private dedupeInstance(client: ExtensionClient): void {
    if (!client.instanceId) return
    for (const other of [...this.clients.values()]) {
      if (other.id === client.id || other.instanceId !== client.instanceId) continue
      void debug('INFO', `replacing stale socket for instance ${client.instanceId} (${other.id})`)
      wlog.info(TAG, `Reconnection from ${client.name} — replacing its previous socket`)
      for (const [conv, cid] of this.stickyByConversation) {
        if (cid === other.id) this.stickyByConversation.set(conv, client.id)
      }
      // terminate, not close: the stale socket's peer is a dead service
      // worker that will never complete a close handshake.
      other.ws.terminate()
      this.removeClient(other, 'Replaced by new connection')
    }
  }

  private sendRaw(client: ExtensionClient, data: unknown): void {
    if (client.ws.readyState === 1 /* OPEN */) {
      const json = JSON.stringify(data)
      void debug('SEND', `[${client.name}] ${json.slice(0, 300)}`)
      client.ws.send(json)
    }
  }

  private broadcastRaw(data: unknown): void {
    for (const client of this.openClients()) {
      this.sendRaw(client, data)
    }
  }

  /** Events the given browser instance executed (null matches pre-identity events). */
  private eventsFor(client: ExtensionClient, events: ExtensionEvent[]): ExtensionEvent[] {
    return events.filter((e) => (e.instanceId ?? null) === client.instanceId)
  }

  /**
   * Conversations this browser instance ran — the side panel scope. Pure
   * filtering on the per-event attribution; no merging. The internal
   * instanceIds field never crosses the wire.
   */
  private async conversationsFor(
    client: ExtensionClient,
    listed?: ConversationSummary[]
  ): Promise<ConversationSummary[]> {
    const all = listed ?? (await listConversations())
    return all
      .filter((c) => (c.instanceIds ?? [null]).includes(client.instanceId))
      .map((c) => {
        const summary = { ...c }
        delete summary.instanceIds
        // A title we were told about this session is fresher than the one on
        // disk — a conversation named seconds ago may not be persisted yet.
        const known = this.titles.get(c.conversationId)
        if (known) summary.title = known
        return summary
      })
  }

  private pushEventsSync(conversationId: string, origin?: ExtensionClient): Promise<void> {
    // Queued rather than run: see `syncChain`.
    const next = this.syncChain.then(() => this.runEventsSync(conversationId, origin))
    this.syncChain = next.catch(() => undefined)
    return next
  }

  private async runEventsSync(conversationId: string, origin?: ExtensionClient): Promise<void> {
    try {
      const title = await this.titleFor(conversationId)
      const events = await readEvents(conversationId)
      // Client-independent, so it is read once rather than once per browser.
      const listed = await listConversations()
      for (const client of this.identifiedClients()) {
        const slice = this.eventsFor(client, events)
        // A browser that never ran this conversation must not have its
        // panel switched to it — only the executing browser (origin) may
        // receive an empty first sync.
        if (slice.length === 0 && client !== origin) continue
        this.sendRaw(client, {
          type: 'event',
          event: 'events_sync',
          data: { conversationId, title, events: slice }
        })
        const conversations = await this.conversationsFor(client, listed)
        const existing = conversations.find((c) => c.conversationId === conversationId)
        if (existing) {
          existing.title = title
        } else if (client === origin) {
          conversations.unshift({
            conversationId,
            title,
            eventCount: slice.length,
            lastTimestamp: Date.now()
          })
        }
        this.sendRaw(client, {
          type: 'event',
          event: 'conversations_list',
          data: conversations
        })
      }
    } catch {
      // best-effort
    }
  }

  private async pushConversationsList(client: ExtensionClient): Promise<void> {
    try {
      const conversations = await this.conversationsFor(client)
      this.sendRaw(client, {
        type: 'event',
        event: 'conversations_list',
        data: conversations
      })
    } catch {
      // best-effort
    }
  }

  private async pushConversationEvents(
    client: ExtensionClient,
    conversationId: string
  ): Promise<void> {
    try {
      const events = this.eventsFor(client, await readEvents(conversationId))
      this.sendRaw(client, {
        type: 'event',
        event: 'conversation_events',
        data: { conversationId, events }
      })
    } catch {
      // best-effort
    }
  }

  private pushEventLogged(client: ExtensionClient, event: ExtensionEvent): void {
    this.sendRaw(client, {
      type: 'event',
      event: 'event_logged',
      data: event
    })
  }

  private exposeBridge(): void {
    ;(globalThis as Record<string, unknown>).__wolffishExtensionBridge = {
      sendCommand: (type: string, params: Record<string, unknown>, opts?: SendCommandOptions) =>
        this.sendCommand(type, params, opts),
      isConnected: () => this.isConnected(),
      getStatus: () => this.getStatus(),
      getConfig: () => getBrowserExtensionConfig(),
      listBrowsers: () => this.listBrowsers(),
      useBrowser: (query: string, conversationId?: string | null) =>
        this.useBrowser(query, conversationId),
      // Lets the plugin heal a STALE loaded extension. The connect-time
      // version check only reloads on a version mismatch, but Chrome can keep
      // running an old service worker whose manifest still matches the synced
      // folder — and the one reliable symptom of that is the extension
      // answering "Unknown command" for a command this build defines.
      requestReload: (target?: string | null) => this.requestReload(target),
      // Readiness + repairs. Reachable with zero clients by design — see
      // start(): the bridge is exposed when the server comes up, not when
      // a browser identifies.
      doctor: (opts?: DoctorOptions) => this.doctor(opts ?? {}),
      fix: (action: string, opts?: FixOptions) => this.fix(action, opts ?? {}),
      setOverlayEnabled: (enabled: boolean, target?: string | null) =>
        this.setOverlayEnabled(enabled, target)
    }
    void debug('INFO', 'bridge exposed on globalThis')
  }

  private clearBridge(): void {
    ;(globalThis as Record<string, unknown>).__wolffishExtensionBridge = null
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(() => {
      for (const client of [...this.clients.values()]) {
        const elapsed = Date.now() - client.lastPing
        if (elapsed > HEARTBEAT_CHECK_MS) {
          void debug('WARN', `heartbeat timeout (${client.name}): ${elapsed}ms since last ping`)
          wlog.warn(TAG, `Extension heartbeat timeout (${client.name}), dropping connection`)
          client.ws.terminate()
          this.removeClient(client, 'Extension disconnected')
        }
      }
    }, HEARTBEAT_SWEEP_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private rejectPendingFor(clientId: string, reason: string): void {
    let count = 0
    for (const [id, pending] of this.pendingCommands) {
      if (pending.clientId !== clientId) continue
      pending.reject(new Error(reason))
      this.pendingCommands.delete(id)
      count++
    }
    if (count > 0)
      void debug('INFO', `rejected ${count} pending commands for ${clientId}: ${reason}`)
  }

  private rejectAllPending(reason: string): void {
    const count = this.pendingCommands.size
    if (count > 0) void debug('INFO', `rejecting ${count} pending commands: ${reason}`)
    for (const [id, pending] of this.pendingCommands) {
      pending.reject(new Error(reason))
      this.pendingCommands.delete(id)
    }
  }

  private broadcastStatus(): void {
    this.onStatusChange?.(this.getStatus())
  }
}
