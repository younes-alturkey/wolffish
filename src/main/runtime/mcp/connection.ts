/**
 * One MCP server's connection lifecycle. Owns the SDK client/transport,
 * silent reconnection, passive health checks, tool discovery, and the
 * cerebellum registration for exactly one server. A connection can fail
 * in any way it likes — nothing here ever throws out of the public
 * surface, and no failure touches any other connection or the app.
 *
 * Lifecycle model (mirrors the WhatsApp channel's discipline):
 * - Every mutation bumps `epoch`; every async tail re-checks it, so a
 *   stale heartbeat/list_changed/reconnect can never act on a newer
 *   connection's state.
 * - connect() is single-flight — concurrent boot/test/timer entries
 *   share one attempt.
 * - Backoff is driven ONLY by transport close and failed health checks.
 *   Transport onerror is log-only: the StreamableHTTP transport fires it
 *   for non-fatal noise (a missing GET/SSE endpoint, a single failed
 *   request) while the connection is perfectly usable.
 * - On transient disconnects the capability STAYS registered: tool calls
 *   return a retryable "network error" result, giving a mid-turn blip a
 *   bounded recovery window and keeping the provider prompt cache
 *   stable. The capability is unregistered only when the server is
 *   genuinely gone for the user: remove, disable, needs-auth, or a
 *   parked stdio command that keeps dying on spawn.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import os from 'node:os'
import type { Capability, ToolExecutionResult, WolffishPlugin } from '@main/runtime/cerebellum'
import {
  buildDescription,
  buildMcpCapability,
  normalizeCallResult,
  toolsToDescriptors,
  unreachableError,
  type McpCallResult,
  type McpToolInfo
} from '@main/runtime/mcp/capability'
import { mcpCapabilityName, parseCommandLine } from '@main/runtime/mcp/naming'
import {
  allocateLoopbackPort,
  waitForCallback,
  WolffishOAuthProvider,
  type OauthPersistence
} from '@main/runtime/mcp/auth'
import type {
  McpHeader,
  McpServerConfig,
  McpServerSnapshot,
  McpTestResult
} from '@main/runtime/mcp/types'

const BACKOFF_INITIAL_MS = 1_000
const BACKOFF_FACTOR = 2
const BACKOFF_MAX_MS = 120_000
const BACKOFF_JITTER = 0.25
/**
 * stdio commands that keep failing are deterministic (typo, missing
 * runtime) far more often than transient — after this many consecutive
 * failed connects the connection parks silently until the user acts.
 * Remote servers keep retrying forever; a URL going dark IS transient.
 */
const STDIO_PARK_AFTER_FAILURES = 5

/** Generous initialize window: stdio servers may download data on first run. */
const CONNECT_TIMEOUT_STDIO_MS = 300_000
const CONNECT_TIMEOUT_HTTP_MS = 60_000

const CALL_TIMEOUT_MS = 120_000
const CALL_MAX_TOTAL_MS = 600_000

const HEARTBEAT_INTERVAL_MS = 60_000
const HEARTBEAT_TIMEOUT_MS = 10_000

const AUTH_FLOW_TIMEOUT_MS = 5 * 60_000

const STDERR_TAIL_CHARS = 4_000

type InternalState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'backoff'
  | 'needs-auth'
  | 'parked'
  | 'disabled'

export type McpConnectionDeps = {
  config: McpServerConfig
  appVersion: string
  register: (capability: Capability, plugin: WolffishPlugin) => void
  unregister: (name: string) => void
  /** Called after every observable state change (debounced by caller). */
  notify: () => void
  oauthPersistence: OauthPersistence
  openExternal: (url: string) => void
  /** Persist a newly allocated OAuth loopback port. */
  saveRedirectPort: (port: number) => Promise<void>
  /** Test seam: replaces transport construction entirely. */
  transportFactory?: () => Transport | Promise<Transport>
  /** Test seam: override health-check cadence. */
  heartbeatIntervalMs?: number
  /** Test seam: shrink reconnect backoff so failure paths run in ms. */
  backoffInitialMs?: number
}

export class McpConnection {
  private state: InternalState = 'idle'
  private epoch = 0
  private client: Client | null = null
  private transport: Transport | null = null
  private connectPromise: Promise<void> | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private refreshDebounce: NodeJS.Timeout | null = null
  private attempt = 0
  private consecutiveFailures = 0
  private lastError: string | null = null
  private connectPhase: string | null = null
  private lastConnectedAt: number | null = null
  private stderrTail = ''
  private nameMap = new Map<string, string>()
  private toolHash: string | null = null
  private registered = false
  private serverName: string | null = null
  private serverVersion: string | null = null
  private serverHasTools = false
  private preferSse = false
  private interactiveAuth = false
  private cancelAuthCallback: (() => void) | null = null
  private authProvider: WolffishOAuthProvider | null = null

  constructor(private readonly deps: McpConnectionDeps) {}

  get id(): string {
    return this.deps.config.id
  }

  get capabilityName(): string {
    return mcpCapabilityName(this.deps.config.slug)
  }

  /** Live stdio child pid, for the synchronous last-resort quit sweep. */
  get childPid(): number | null {
    const transport = this.transport
    if (transport instanceof StdioClientTransport) return transport.pid ?? null
    return null
  }

  start(): void {
    if (!this.deps.config.enabled) {
      this.state = 'disabled'
      this.deps.notify()
      return
    }
    void this.connect()
  }

  /** Keep the in-memory config snapshot in step with what was persisted. */
  updateEnabled(enabled: boolean): void {
    this.deps.config.enabled = enabled
  }

  /**
   * Apply a new custom-header set (the manager has already persisted
   * it). Headers ride the transport, so an enabled connection tears
   * down and reconnects with fresh failure accounting — a needs-auth
   * server whose new headers work comes straight up as connected,
   * without ever entering the OAuth sign-in flow. The reconnect is
   * deliberately NOT awaited: a stalled server would otherwise hold the
   * IPC reply (and the settings Save button) for the full connect
   * timeout; status flows through notify as usual.
   */
  async setHeaders(headers: McpHeader[] | undefined): Promise<void> {
    this.deps.config.headers = headers
    if (!this.deps.config.enabled) return
    await this.stop()
    this.consecutiveFailures = 0
    this.attempt = 0
    void this.connect()
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
      this.consecutiveFailures = 0
      this.attempt = 0
      if (this.state === 'disabled') this.state = 'idle'
      await this.connect()
    } else {
      await this.stop()
      this.state = 'disabled'
      this.deps.notify()
    }
  }

  /**
   * Deliberate teardown: remove/disable/app shutdown. Bounded — the SDK
   * escalates stdin EOF → SIGTERM → SIGKILL over ~4s for stdio children.
   */
  async stop(): Promise<void> {
    this.epoch++
    this.interactiveAuth = false
    this.cancelAuthCallback?.()
    this.cancelAuthCallback = null
    this.clearTimers()
    this.unregisterCapability()
    const client = this.client
    this.client = null
    this.transport = null
    this.connectPromise = null
    this.connectPhase = null
    this.state = 'idle'
    if (client) await client.close().catch(() => undefined)
  }

  snapshot(): McpServerSnapshot {
    const cfg = this.deps.config
    const state: McpServerSnapshot['state'] =
      this.state === 'connected'
        ? 'connected'
        : this.state === 'connecting'
          ? 'connecting'
          : this.state === 'needs-auth'
            ? 'needs-auth'
            : this.state === 'disabled'
              ? 'disabled'
              : 'offline'
    return {
      id: cfg.id,
      name: cfg.name,
      slug: cfg.slug,
      transport: cfg.transport,
      target: cfg.transport === 'http' ? (cfg.url ?? '') : (cfg.command ?? ''),
      enabled: cfg.enabled,
      state,
      toolCount: this.registered ? this.nameMap.size : 0,
      toolNames: this.registered ? [...this.nameMap.keys()] : [],
      headers: cfg.transport === 'http' ? cfg.headers : undefined,
      serverName: this.serverName ?? undefined,
      serverVersion: this.serverVersion ?? undefined,
      error: this.lastError ?? undefined,
      progress: state === 'connecting' ? (this.connectPhase ?? undefined) : undefined,
      lastConnectedAt: this.lastConnectedAt ?? undefined
    }
  }

  /**
   * User-invoked check. Doubles as the "kick a parked/backed-off
   * connection right now" action: a deliberate click resets the silent
   * failure accounting.
   */
  async test(): Promise<McpTestResult> {
    const started = Date.now()
    if (this.state === 'needs-auth') {
      return { ok: false, error: 'authorization required — sign in first' }
    }
    if (this.state === 'disabled') {
      return { ok: false, error: 'connection is disabled' }
    }
    if (this.state === 'connected' && this.client) {
      const epoch = this.epoch
      const client = this.client
      try {
        let toolCount = this.nameMap.size
        if (this.serverHasTools) {
          const tools = await this.listAllTools(client, HEARTBEAT_TIMEOUT_MS)
          toolCount = tools.length
        } else {
          await client.ping({ timeout: HEARTBEAT_TIMEOUT_MS })
        }
        return { ok: true, toolCount, durationMs: Date.now() - started }
      } catch (err) {
        if (epoch === this.epoch) this.forceDisconnect(errorMessage(err))
        return { ok: false, error: errorMessage(err), durationMs: Date.now() - started }
      }
    }
    // Offline in some form — user action retries immediately.
    this.consecutiveFailures = 0
    this.attempt = 0
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.state === 'parked' || this.state === 'idle' || this.state === 'backoff') {
      this.state = 'idle'
    }
    await this.connect()
    if (this.state === 'connected') {
      return { ok: true, toolCount: this.nameMap.size, durationMs: Date.now() - started }
    }
    return {
      ok: false,
      error: this.lastError ?? 'connection failed',
      durationMs: Date.now() - started
    }
  }

  /**
   * Interactive OAuth sign-in (remote servers). Opens the system
   * browser, waits on the loopback callback, exchanges the code, then
   * reconnects with the stored tokens. Silent reconnects never end up
   * here — they park in needs-auth and wait for this user action.
   */
  async authorize(): Promise<{ ok: boolean; error?: string }> {
    const cfg = this.deps.config
    if (cfg.transport !== 'http' || !cfg.url) {
      return { ok: false, error: 'only remote servers use OAuth sign-in' }
    }
    if (this.hasCustomAuthorization()) {
      // The custom header would override any token a sign-in obtains, so
      // the flow can never help — point the user at the actual fix.
      return {
        ok: false,
        error:
          'this connection authenticates with a custom Authorization header — update it under Headers instead of signing in'
      }
    }
    // Silence all background activity for the duration of the flow.
    this.epoch++
    const flowEpoch = this.epoch
    this.clearTimers()
    const oldClient = this.client
    this.client = null
    this.transport = null
    this.connectPromise = null
    if (oldClient) await oldClient.close().catch(() => undefined)
    this.interactiveAuth = true
    this.state = 'connecting'
    this.setPhase('opening the browser for sign-in')
    try {
      const provider = await this.ensureAuthProvider()
      provider.interactive = true
      const port = provider.currentPort()
      const callback = waitForCallback({
        port,
        expectedState: () => provider.lastState,
        timeoutMs: AUTH_FLOW_TIMEOUT_MS,
        onCancel: (cancel) => {
          this.cancelAuthCallback = cancel
        }
      })
      const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
        authProvider: provider,
        // Same headers as regular connects: if they satisfy the server,
        // this probe succeeds and sign-in ends without a browser trip.
        fetch: this.scopedHeaderFetch()
      })
      const client = this.buildClient()
      let needsCode = false
      try {
        await client.connect(transport, { timeout: CONNECT_TIMEOUT_HTTP_MS })
        // Tokens were already valid — no browser round-trip needed.
        await client.close().catch(() => undefined)
      } catch (err) {
        if (!isUnauthorizedError(err)) {
          this.cancelAuthCallback?.()
          throw err
        }
        needsCode = true
      }
      if (needsCode) {
        this.setPhase('waiting for sign-in to finish in the browser')
        const result = await callback
        this.cancelAuthCallback = null
        if (!result.ok) {
          // Epoch guard: a setHeaders/stop that superseded this flow owns
          // the state now — report the failure without stamping over it.
          if (this.epoch === flowEpoch) {
            this.state = 'needs-auth'
            this.connectPhase = null
            this.lastError = result.error
            this.deps.notify()
          }
          return { ok: false, error: result.error }
        }
        // finishAuth must run on the SAME transport that saw the 401 —
        // it carries the resource metadata/scope from WWW-Authenticate.
        await transport.finishAuth(result.code)
      } else {
        this.cancelAuthCallback?.()
        this.cancelAuthCallback = null
      }
      provider.interactive = false
      this.interactiveAuth = false
      // Fresh transport for the real connection: a transport that has
      // been through connect()+close() cannot be started again.
      await this.connect()
      if (this.currentState() === 'connected') return { ok: true }
      return { ok: false, error: this.lastError ?? 'connection failed after sign-in' }
    } catch (err) {
      const message = errorMessage(err)
      if (this.epoch === flowEpoch) {
        this.state = 'needs-auth'
        this.connectPhase = null
        this.lastError = message
        this.deps.notify()
      }
      return { ok: false, error: message }
    } finally {
      this.interactiveAuth = false
      if (this.authProvider) this.authProvider.interactive = false
      this.cancelAuthCallback?.()
      this.cancelAuthCallback = null
    }
  }

  // ---------------------------------------------------------------- connect

  private connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise
    // A silent attempt (timer/boot) must never interleave with a live
    // interactive sign-in — it would clobber the flow's PKCE verifier.
    if (this.interactiveAuth) return Promise.resolve()
    const run = this.connectOnce().finally(() => {
      this.connectPromise = null
    })
    this.connectPromise = run
    return run
  }

  private async connectOnce(): Promise<void> {
    const cfg = this.deps.config
    this.epoch++
    const epoch = this.epoch
    this.state = 'connecting'
    this.setPhase('[1/3] establishing connection')
    try {
      const transport = await this.buildTransport()
      const client = this.buildClient()
      client.onerror = (err) => {
        // Log-only: StreamableHTTP fires onerror for recoverable noise.
        this.lastError = errorMessage(err)
      }
      const timeout = cfg.transport === 'stdio' ? CONNECT_TIMEOUT_STDIO_MS : CONNECT_TIMEOUT_HTTP_MS
      // For stdio this step also spawns the server process; a first run may
      // sit here while the server bootstraps (downloads data, warms caches).
      this.setPhase(
        cfg.transport === 'stdio'
          ? '[2/3] starting the server process + MCP handshake (initialize)'
          : '[2/3] MCP handshake (initialize)'
      )
      await client.connect(transport, { timeout })
      if (epoch !== this.epoch) {
        await client.close().catch(() => undefined)
        return
      }
      // Attach the drop detector only now: a failed connect closes its own
      // transport (the SDK Client closes it while rejecting), and an early
      // onclose here would hijack that failure into a generic backoff before
      // the catch below can classify it (auth vs SSE-fallback vs transient).
      client.onclose = () => this.onClientClose(epoch)
      this.client = client
      this.transport = transport
      await this.afterConnected(epoch, client)
    } catch (err) {
      if (epoch !== this.epoch) return
      await this.handleConnectFailure(err)
    }
  }

  /**
   * Live connect-progress line shown in the card's code block while the
   * state is `connecting`. Each transition notifies so the UI tracks the
   * handshake step by step; cleared on any terminal state.
   */
  private setPhase(phase: string | null): void {
    if (this.connectPhase === phase) return
    this.connectPhase = phase
    this.deps.notify()
  }

  private async buildTransport(): Promise<Transport> {
    if (this.deps.transportFactory) return this.deps.transportFactory()
    const cfg = this.deps.config
    if (cfg.transport === 'stdio') {
      const argv = parseCommandLine(cfg.command ?? '')
      if (argv.length === 0) throw new Error('no command configured')
      const transport = new StdioClientTransport({
        command: argv[0],
        args: argv.slice(1),
        env: cfg.env && Object.keys(cfg.env).length > 0 ? cfg.env : undefined,
        stderr: 'pipe',
        cwd: os.homedir()
      })
      // Consume stderr immediately — an unread pipe backpressures a
      // chatty server once the 16KB buffer fills.
      transport.stderr?.on('data', (chunk: Buffer) => {
        this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS)
      })
      return transport
    }
    if (!cfg.url) throw new Error('no URL configured')
    const url = new URL(cfg.url)
    // A user-supplied Authorization header means the user owns auth for
    // this server: leave the whole OAuth machinery detached so stored
    // tokens can never fight the header (the SDK would otherwise refresh
    // + retry on 401 and trip its circuit breaker instead of parking in
    // needs-auth). A plain 401 is classified in handleConnectFailure.
    const provider = this.hasCustomAuthorization() ? undefined : await this.ensureAuthProvider()
    const fetchFn = this.scopedHeaderFetch()
    if (this.preferSse) {
      return new SSEClientTransport(url, { authProvider: provider, fetch: fetchFn })
    }
    return new StreamableHTTPClientTransport(url, { authProvider: provider, fetch: fetchFn })
  }

  private customHeaderRecord(): Record<string, string> | undefined {
    const headers = this.deps.config.headers
    if (!headers || headers.length === 0) return undefined
    const record: Record<string, string> = {}
    for (const header of headers) {
      const key = header.key.trim()
      if (!key) continue
      record[key] = header.value
    }
    return Object.keys(record).length > 0 ? record : undefined
  }

  private hasCustomAuthorization(): boolean {
    const record = this.customHeaderRecord()
    if (!record) return false
    return Object.keys(record).some((key) => key.toLowerCase() === 'authorization')
  }

  /**
   * The user's custom headers as a transport `fetch` override, NOT a
   * requestInit: requestInit would also ride the SDK's auth flows to
   * whatever third-party authorization-server host discovery finds,
   * leaking sensitive values off the server's origin. This injects
   * strictly same-origin, and Headers.set() replaces case-insensitively,
   * so a user auth header beats a stored OAuth token no matter how the
   * user capitalized it.
   */
  private scopedHeaderFetch():
    | ((url: string | URL, init?: RequestInit) => Promise<Response>)
    | undefined {
    const record = this.customHeaderRecord()
    const base = this.deps.config.url
    if (!record || !base) return undefined
    const origin = new URL(base).origin
    return (url, init) => {
      const target = new URL(String(url))
      if (target.origin !== origin) return fetch(url, init)
      const headers = new Headers(init?.headers)
      for (const [key, value] of Object.entries(record)) headers.set(key, value)
      return fetch(url, { ...init, headers })
    }
  }

  private buildClient(): Client {
    return new Client({ name: 'wolffish', version: this.deps.appVersion }, { capabilities: {} })
  }

  private async afterConnected(epoch: number, client: Client): Promise<void> {
    this.attempt = 0
    this.consecutiveFailures = 0
    this.lastError = null
    this.lastConnectedAt = Date.now()
    const info = client.getServerVersion()
    this.serverName = info?.name ?? null
    this.serverVersion = info?.version ?? null
    this.serverHasTools = Boolean(client.getServerCapabilities()?.tools)
    if (this.serverHasTools) {
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        this.scheduleToolRefresh(epoch)
      })
      this.setPhase('[3/3] discovering tools (tools/list)')
      await this.refreshTools(epoch, client)
      if (epoch !== this.epoch) return
    } else {
      // Nothing callable to advertise; a resources/prompts-only server
      // just sits connected with zero tools.
      this.unregisterCapability()
    }
    this.state = 'connected'
    this.connectPhase = null
    if (this.deps.config.transport === 'http') this.scheduleHeartbeat()
    this.deps.notify()
  }

  private async handleConnectFailure(err: unknown): Promise<void> {
    const cfg = this.deps.config
    this.connectPhase = null
    // Beyond the SDK's UnauthorizedError (OAuth redirect needed), a raw
    // HTTP 401 is also terminal: it reaches here when no authProvider is
    // attached (custom Authorization header) or when the SDK's circuit
    // breaker fires after a token refresh that a custom header keeps
    // overriding. Retrying silently would just spam the server — park in
    // needs-auth, whose card also points at the configured headers.
    if (isUnauthorizedError(err) || isHttp401Error(err)) {
      this.state = 'needs-auth'
      this.lastError = 'authorization required'
      this.unregisterCapability()
      this.deps.notify()
      return
    }
    if (
      cfg.transport === 'http' &&
      !this.preferSse &&
      isStreamableHttpError(err) &&
      (err.code === 404 || err.code === 405) &&
      !isJsonRpcErrorBody(errorMessage(err))
    ) {
      // Legacy SSE-only server (bare 404/405 on the streamable POST). Other
      // statuses mean other problems — 401 is auth, 400 is protocol — and a
      // down server is a network TypeError, never a status. A 404 whose body
      // IS a JSON-RPC error (e.g. "Session not found" from a load balancer
      // that broke session affinity mid-handshake) comes from a live
      // streamable server — that's a transient failure for the backoff path
      // below, not a signal to demote the transport.
      // Defer the retry: we're still inside connectOnce here, so
      // this.connectPromise is set and a synchronous connect() would
      // short-circuit on the single-flight guard and never actually
      // reconnect. setImmediate runs after connectOnce's finally clears
      // connectPromise; the epoch guard drops it if a stop() intervened.
      this.preferSse = true
      const epoch = this.epoch
      setImmediate(() => {
        if (this.epoch === epoch) void this.connect()
      })
      return
    }
    if (cfg.transport === 'http' && this.preferSse) {
      // The SSE fallback failed too — alternate back to streamable on the
      // next attempt so a mistaken demotion can never stick permanently. A
      // genuine SSE-only server just flips straight back on the wasted try.
      this.preferSse = false
    }
    const message = errorMessage(err)
    this.lastError = this.stderrTail ? `${message}\n${lastLines(this.stderrTail, 3)}` : message
    this.consecutiveFailures++
    if (cfg.transport === 'stdio' && this.consecutiveFailures >= STDIO_PARK_AFTER_FAILURES) {
      // Deterministically-broken command: stop respawning it (npx/uvx
      // would re-download forever). A Test click or restart re-arms.
      this.state = 'parked'
      this.unregisterCapability()
      this.deps.notify()
      return
    }
    this.state = 'backoff'
    this.scheduleReconnect()
    this.deps.notify()
  }

  private onClientClose(epoch: number): void {
    if (epoch !== this.epoch) return
    // The transport is gone (child exited / stream closed). Keep the
    // capability registered: tools answer with a retryable network error
    // while we quietly reconnect, and the prompt surface stays stable.
    this.epoch++
    this.client = null
    this.transport = null
    this.clearHealthTimers()
    if (this.state === 'connected') this.lastError = 'connection closed'
    this.state = 'backoff'
    this.scheduleReconnect()
    this.deps.notify()
  }

  /** Health-check failure or explicit poke: drop and re-enter backoff. */
  private forceDisconnect(reason: string): void {
    this.epoch++
    const client = this.client
    this.client = null
    this.transport = null
    this.clearHealthTimers()
    if (client) void client.close().catch(() => undefined)
    this.lastError = reason
    this.state = 'backoff'
    this.scheduleReconnect()
    this.deps.notify()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    const initial = this.deps.backoffInitialMs ?? BACKOFF_INITIAL_MS
    const base = Math.min(initial * BACKOFF_FACTOR ** this.attempt, BACKOFF_MAX_MS)
    const jitter = base * BACKOFF_JITTER * (Math.random() * 2 - 1)
    const delay = Math.max(0, Math.round(base + jitter))
    this.attempt++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  // ------------------------------------------------------------ tools

  private scheduleToolRefresh(epoch: number): void {
    if (this.refreshDebounce) clearTimeout(this.refreshDebounce)
    this.refreshDebounce = setTimeout(() => {
      this.refreshDebounce = null
      const client = this.client
      if (epoch !== this.epoch || !client) return
      void this.refreshTools(epoch, client).catch(() => undefined)
    }, 300)
    this.refreshDebounce.unref?.()
  }

  private async listAllTools(client: Client, timeout?: number): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(
        cursor ? { cursor } : {},
        timeout ? { timeout } : undefined
      )
      for (const tool of page.tools) {
        tools.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown> | undefined
        })
      }
      cursor = page.nextCursor
    } while (cursor)
    return tools
  }

  /**
   * Discover the tool list and (re)register the capability when it
   * actually changed — an unchanged surface after a reconnect keeps the
   * registration (and the provider prompt cache) untouched.
   */
  private async refreshTools(epoch: number, client: Client): Promise<void> {
    const tools = await this.listAllTools(client)
    if (epoch !== this.epoch) return
    const hash = JSON.stringify(tools)
    if (hash === this.toolHash && this.registered) return
    const cfg = this.deps.config
    const { descriptors, nameMap } = toolsToDescriptors(cfg.slug, tools)
    this.nameMap = nameMap
    this.toolHash = hash
    const description = buildDescription({
      displayName: cfg.name,
      serverName: this.serverName ?? undefined,
      instructions: client.getInstructions()
    })
    const { capability, plugin } = buildMcpCapability({
      slug: cfg.slug,
      description,
      descriptors,
      nameMap,
      callTool: (original, args, signal) => this.proxyCall(original, args, signal)
    })
    this.deps.register(capability, plugin)
    this.registered = true
    this.deps.notify()
  }

  private unregisterCapability(): void {
    if (!this.registered) return
    this.deps.unregister(this.capabilityName)
    this.registered = false
    this.toolHash = null
  }

  /**
   * The plugin's execute path. Routes to whatever client is currently
   * live — the registration survives reconnects, so this must resolve
   * the client at call time, not capture one.
   */
  private async proxyCall(
    originalName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<ToolExecutionResult> {
    const client = this.state === 'connected' ? this.client : null
    if (!client) {
      return { success: false, error: unreachableError(this.deps.config.slug) }
    }
    try {
      const result = await client.callTool({ name: originalName, arguments: args }, undefined, {
        signal,
        timeout: CALL_TIMEOUT_MS,
        maxTotalTimeout: CALL_MAX_TOTAL_MS,
        // Both are required for long-running tools: without an onprogress
        // callback the SDK never requests progress notifications and the
        // reset flag is a silent no-op.
        resetTimeoutOnProgress: true,
        onprogress: () => {}
      })
      return normalizeCallResult(result as McpCallResult, originalName)
    } catch (err) {
      if (this.state !== 'connected' || this.client !== client) {
        // The connection dropped mid-call — surface the retryable form.
        return { success: false, error: unreachableError(this.deps.config.slug) }
      }
      return { success: false, error: errorMessage(err) }
    }
  }

  // ------------------------------------------------------------ health

  private scheduleHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer)
    const interval = this.deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null
      void this.runHeartbeat()
    }, interval)
    this.heartbeatTimer.unref?.()
  }

  /**
   * Passive-ish health for remote servers: reuse cheap existing calls
   * (tools/list when the server has tools — which doubles as a tool-list
   * diff for servers that never send list_changed — else ping). Chained
   * scheduling, never setInterval: a slow check must not stack.
   */
  private async runHeartbeat(): Promise<void> {
    const client = this.client
    const epoch = this.epoch
    if (this.state !== 'connected' || !client) return
    try {
      if (this.serverHasTools) {
        const tools = await this.listAllTools(client, HEARTBEAT_TIMEOUT_MS)
        if (epoch !== this.epoch) return
        const hash = JSON.stringify(tools)
        if (hash !== this.toolHash) await this.refreshTools(epoch, client)
      } else {
        await client.ping({ timeout: HEARTBEAT_TIMEOUT_MS })
      }
      if (epoch !== this.epoch) return
      this.scheduleHeartbeat()
    } catch (err) {
      if (epoch !== this.epoch) return
      this.forceDisconnect(`health check failed: ${errorMessage(err)}`)
    }
  }

  // ------------------------------------------------------------ auth

  private async ensureAuthProvider(): Promise<WolffishOAuthProvider> {
    if (this.authProvider) return this.authProvider
    const stored = await this.deps.oauthPersistence.load()
    let port = stored?.redirectPort
    if (!port) {
      port = await allocateLoopbackPort()
      await this.deps.saveRedirectPort(port)
    }
    this.authProvider = new WolffishOAuthProvider({
      redirectPort: port,
      persistence: this.deps.oauthPersistence,
      openExternal: this.deps.openExternal
    })
    return this.authProvider
  }

  // ------------------------------------------------------------ misc

  /**
   * Read the state through a method boundary — inside long flows TS
   * pins `this.state` to the last literal assigned in that scope and
   * can't see that awaited calls (connect) mutate it.
   */
  private currentState(): InternalState {
    return this.state
  }

  private clearHealthTimers(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.refreshDebounce) {
      clearTimeout(this.refreshDebounce)
      this.refreshDebounce = null
    }
  }

  private clearTimers(): void {
    this.clearHealthTimers()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * The SDK's StreamableHTTPError message embeds the HTTP response body. A body
 * that is a JSON-RPC error was produced by a live streamable MCP server (e.g.
 * "Session not found" when a load balancer breaks session affinity), so a
 * 404 carrying one must NOT be read as "this server only speaks legacy SSE".
 */
function isJsonRpcErrorBody(message: string): boolean {
  return message.includes('"jsonrpc"')
}

/**
 * SDK error-class checks that tolerate dual module identities. Loaders that
 * resolve the SDK's esm and cjs builds side by side (tsx in dev/tests) hand
 * us instances whose class object differs from the one this module imported,
 * so a bare `instanceof` silently misses — the constructor NAME survives
 * either way (with a possible bundler `$1` suffix, hence startsWith).
 */
function isUnauthorizedError(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true
  return err instanceof Error && err.constructor.name.startsWith('UnauthorizedError')
}

function isStreamableHttpError(err: unknown): err is Error & { code?: number } {
  if (err instanceof StreamableHTTPError) return true
  return err instanceof Error && err.constructor.name.startsWith('StreamableHTTPError')
}

/**
 * A transport error that carries HTTP status 401. StreamableHTTPError
 * covers the POST path and the SDK's 401-after-auth circuit breaker;
 * SseError (same dual-module-identity caveat as above) covers the
 * legacy SSE GET.
 */
function isHttp401Error(err: unknown): boolean {
  if (isStreamableHttpError(err)) return err.code === 401
  if (err instanceof Error && err.constructor.name.startsWith('SseError')) {
    return (err as Error & { code?: number }).code === 401
  }
  return false
}

function lastLines(text: string, count: number): string {
  const lines = text.trimEnd().split('\n')
  return lines.slice(-count).join('\n')
}
