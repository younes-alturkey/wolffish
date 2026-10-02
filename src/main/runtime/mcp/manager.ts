/**
 * The MCP connection manager: one McpConnection per configured server,
 * config persistence, and the cerebellum registration seam. Constructed
 * once in main/index.ts; every IPC handler and the boot path go through
 * here. Failures stay inside individual connections — the manager never
 * throws out of its public surface.
 */
import crypto from 'node:crypto'
import type { Capability, WolffishPlugin } from '@main/runtime/cerebellum'
import { revokeTokens } from '@main/runtime/mcp/auth'
import { McpConnection } from '@main/runtime/mcp/connection'
import {
  deconflictSlug,
  deriveDisplayName,
  detectTransport,
  parseCommandLine,
  slugify
} from '@main/runtime/mcp/naming'
import type {
  McpAddInput,
  McpAddResult,
  McpConfig,
  McpHeader,
  McpServerConfig,
  McpServerSnapshot,
  McpTestResult
} from '@main/runtime/mcp/types'
import {
  addMcpServer,
  getMcpConfig,
  patchMcpServerOauth,
  removeMcpServer,
  updateMcpServer
} from '@main/workspace/workspace'

/** How long mcp:add waits for the first connect before returning "connecting". */
const ADD_SETTLE_CAP_MS = 8_000

/** RFC 7230 token — what fetch's Headers accepts as a header name. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
/**
 * ByteString-safe values: tab + printable ASCII + Latin-1. Anything a
 * fetch Headers object rejects (NUL, other controls, any code point
 * above U+00FF — including invisible zero-width characters riding along
 * with a pasted token) must be caught HERE, or it only surfaces as a
 * Headers constructor throw deep inside the silent reconnect loop.
 */
const HEADER_VALUE_RE = /^[\t\x20-\x7E\x80-\xFF]*$/

type HeaderCheck = { ok: true; headers?: McpHeader[] } | { ok: false; error: string }

/**
 * Trim and validate user-entered headers BEFORE they are persisted.
 * Blank rows are dropped; `ok` with `headers: undefined` means "nothing
 * left to store". Duplicate names (case-insensitive, matching how HTTP
 * treats them) are rejected rather than silently last-one-wins.
 */
function sanitizeHeaders(headers: McpHeader[] | undefined): HeaderCheck {
  if (!headers || headers.length === 0) return { ok: true, headers: undefined }
  const clean: McpHeader[] = []
  const seen = new Set<string>()
  for (const header of headers) {
    const key = (header.key ?? '').trim()
    const value = (header.value ?? '').trim()
    if (!key && !value) continue
    if (!HEADER_NAME_RE.test(key)) {
      return { ok: false, error: `invalid header name: "${key || '(empty)'}"` }
    }
    if (!HEADER_VALUE_RE.test(value)) {
      return {
        ok: false,
        error: `header "${key}" value contains line breaks, control characters, or non-Latin-1 text (check for invisible characters if it was pasted)`
      }
    }
    const lower = key.toLowerCase()
    if (seen.has(lower)) {
      return { ok: false, error: `duplicate header: "${key}"` }
    }
    seen.add(lower)
    clean.push({ key, value, sensitive: header.sensitive === true })
  }
  return { ok: true, headers: clean.length > 0 ? clean : undefined }
}

export type McpManagerDeps = {
  register: (capability: Capability, plugin: WolffishPlugin) => void
  unregister: (name: string) => void
  openExternal: (url: string) => void
  appVersion: string
  onStatusChange: (snapshots: McpServerSnapshot[]) => void
  /**
   * Capability names currently loaded in the cerebellum, consulted when
   * choosing a new server's slug. Channel capabilities that register
   * lazily are covered by the reserved-slug list instead.
   */
  takenCapabilityNames: () => Set<string>
}

export class McpManager {
  private connections = new Map<string, McpConnection>()
  private started = false
  private notifyTimer: NodeJS.Timeout | null = null

  constructor(private readonly deps: McpManagerDeps) {}

  /**
   * Connect every enabled server. Called once at boot, and ONLY in the
   * instance that owns the workspace lock (index.ts gates this). So
   * `started` doubles as "this instance owns MCP" — the mutating actions
   * below refuse when it's false, keeping a non-owning instance (e.g. a
   * dev build running alongside a packaged one) from spawning duplicate
   * child processes or writing the shared config out from under the owner.
   */
  start(config: McpConfig | undefined): void {
    if (this.started) return
    this.started = true
    for (const server of config?.servers ?? []) {
      const connection = this.createConnection(server)
      this.connections.set(server.id, connection)
      connection.start()
    }
  }

  private get owns(): boolean {
    return this.started
  }

  private static readonly NOT_OWNER =
    'MCP connections are managed by another running instance of Wolffish'

  /** Deliberate teardown (app shutdown, factory reset). Bounded, parallel. */
  async stop(): Promise<void> {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer)
      this.notifyTimer = null
    }
    await Promise.allSettled([...this.connections.values()].map((c) => c.stop()))
  }

  /**
   * Synchronous last-resort child sweep for app 'will-quit' — the idle
   * quit path never runs the async drain, and Node does not kill child
   * processes on parent exit.
   */
  killAllSync(): void {
    for (const connection of this.connections.values()) {
      const pid = connection.childPid
      if (!pid) continue
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // already gone
      }
    }
  }

  snapshot(): McpServerSnapshot[] {
    return [...this.connections.values()].map((c) => c.snapshot())
  }

  async add(input: McpAddInput): Promise<McpAddResult> {
    if (!this.owns) return { ok: false, error: McpManager.NOT_OWNER }
    const target = input.target?.trim()
    if (!target) return { ok: false, error: 'enter a command or URL' }
    const kind = detectTransport(target)
    if (kind === 'http') {
      try {
        void new URL(target)
      } catch {
        return { ok: false, error: 'that URL is not valid' }
      }
    } else if (parseCommandLine(target).length === 0) {
      return { ok: false, error: 'enter a command or URL' }
    }
    const headerCheck = sanitizeHeaders(kind === 'http' ? input.headers : undefined)
    if (!headerCheck.ok) return { ok: false, error: headerCheck.error }
    const name = input.name?.trim() || deriveDisplayName(target, kind)
    const existing = await getMcpConfig()
    const taken = new Set<string>([
      ...this.deps.takenCapabilityNames(),
      ...existing.servers.map((s) => s.slug)
    ])
    const slug = deconflictSlug(slugify(name), taken)
    const server: McpServerConfig = {
      id: crypto.randomUUID(),
      name,
      slug,
      transport: kind,
      command: kind === 'stdio' ? target : undefined,
      env:
        kind === 'stdio' && input.env && Object.keys(input.env).length > 0 ? input.env : undefined,
      url: kind === 'http' ? target : undefined,
      headers: headerCheck.headers,
      enabled: true
    }
    await addMcpServer(server)
    const connection = this.createConnection(server)
    this.connections.set(server.id, connection)
    // Kick the first connect and give it a short window to settle so the
    // UI's first paint is truthful (connected/needs-auth), but never
    // block an add on a slow server — it keeps connecting in background.
    await Promise.race([
      connection.test().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, ADD_SETTLE_CAP_MS))
    ])
    this.notifySoon()
    return { ok: true, server: connection.snapshot() }
  }

  async remove(id: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.owns) return { ok: false, error: McpManager.NOT_OWNER }
    // Capture the record BEFORE removeMcpServer wipes it — a remote server
    // signed in with OAuth gets its tokens revoked at the provider so it
    // doesn't leave a stale "connected" app there. Fire-and-forget: never
    // awaited, never blocks or fails the removal.
    const record = (await getMcpConfig()).servers.find((s) => s.id === id)
    const connection = this.connections.get(id)
    if (connection) {
      this.connections.delete(id)
      await connection.stop().catch(() => undefined)
    }
    await removeMcpServer(id)
    if (record?.transport === 'http' && record.url && record.oauth?.tokens) {
      void revokeTokens(record.url, record.oauth).catch(() => undefined)
    }
    this.notifySoon()
    return { ok: true }
  }

  async setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    if (!this.owns) return { ok: false, error: McpManager.NOT_OWNER }
    const connection = this.connections.get(id)
    if (!connection) return { ok: false, error: 'unknown connection' }
    await updateMcpServer(id, { enabled })
    connection.updateEnabled(enabled)
    await connection.setEnabled(enabled)
    this.notifySoon()
    return { ok: true }
  }

  /**
   * Replace a remote server's custom headers: persist, then reconnect
   * with the new set. Sending the full list every time (never a merge)
   * keeps removal trivial — an empty list clears the field entirely.
   */
  async setHeaders(id: string, headers: McpHeader[]): Promise<{ ok: boolean; error?: string }> {
    if (!this.owns) return { ok: false, error: McpManager.NOT_OWNER }
    const connection = this.connections.get(id)
    if (!connection) return { ok: false, error: 'unknown connection' }
    const record = (await getMcpConfig()).servers.find((s) => s.id === id)
    if (record?.transport !== 'http') {
      return { ok: false, error: 'headers apply to remote (URL) servers only' }
    }
    const check = sanitizeHeaders(headers)
    if (!check.ok) return { ok: false, error: check.error }
    await updateMcpServer(id, { headers: check.headers })
    // Re-check after the config I/O awaits: a remove() that fully landed
    // in that window already stopped this connection, and reviving it
    // here would resurrect a deleted server as an untracked zombie.
    if (this.connections.get(id) !== connection) {
      return { ok: false, error: 'unknown connection' }
    }
    await connection.setHeaders(check.headers)
    this.notifySoon()
    return { ok: true }
  }

  async test(id: string): Promise<McpTestResult> {
    if (!this.owns) return { ok: false, error: McpManager.NOT_OWNER }
    const connection = this.connections.get(id)
    if (!connection) return { ok: false, error: 'unknown connection' }
    const result = await connection.test()
    this.notifySoon()
    return result
  }

  async authorize(id: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.owns) return { ok: false, error: McpManager.NOT_OWNER }
    const connection = this.connections.get(id)
    if (!connection) return { ok: false, error: 'unknown connection' }
    const result = await connection.authorize()
    this.notifySoon()
    return result
  }

  private createConnection(server: McpServerConfig): McpConnection {
    const id = server.id
    return new McpConnection({
      config: server,
      appVersion: this.deps.appVersion,
      register: this.deps.register,
      unregister: this.deps.unregister,
      notify: () => this.notifySoon(),
      openExternal: this.deps.openExternal,
      oauthPersistence: {
        load: async () => {
          const config = await getMcpConfig()
          return config.servers.find((s) => s.id === id)?.oauth
        },
        // patchMcpServerOauth no-ops when the record is gone, so a save
        // landing mid-connect can never resurrect a removed server.
        save: (patch) => patchMcpServerOauth(id, patch)
      },
      saveRedirectPort: async (port) => {
        await patchMcpServerOauth(id, { redirectPort: port })
      }
    })
  }

  /** Coalesce bursts of connection events into one renderer push. */
  private notifySoon(): void {
    if (this.notifyTimer) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      this.deps.onStatusChange(this.snapshot())
    }, 50)
    this.notifyTimer.unref?.()
  }
}
