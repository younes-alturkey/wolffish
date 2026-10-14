/**
 * The Web UI channel: the desktop app, served to a browser.
 *
 * The renderer bundle is served as static files and `window.api` — the
 * preload bridge — is replaced in the browser by a WebSocket client that
 * speaks the smallest protocol that could work (the CLI socket's, over ws):
 * `invoke` frames keyed by the SAME channel names the renderer uses over IPC,
 * answered from the SAME handler map index.ts registers every handler in, and
 * `event` frames carrying everything the app broadcasts plus the per-turn
 * stream a chat:send addresses to the connection that sent it. There is no
 * web API surface to keep in sync with the window, because there is no web
 * API surface: a panel that gains a toggle gains it here by construction.
 *
 * What the browser cannot do is handled in two places. Native dialogs and
 * "reveal in Finder" are refused by name (GUI_ONLY) so a tap on a phone never
 * opens a file picker on a VPS; downloads, file URLs, opening a page and PDF
 * export are rewritten (WEB_OVERRIDES) into URLs this server serves. Files
 * come up through one HTTP upload route into a staging folder, from where
 * the app's own save/attach handlers move them exactly as they would a path
 * from a native picker.
 *
 * Security posture, since this listens on a public address by design:
 * master password behind a per-address rate limit, a random session token in
 * an HttpOnly SameSite=Strict cookie, an Origin check on every POST and on
 * the WebSocket upgrade, workspace-contained file routes, and HTTPS in three
 * flavours (tls.ts) with Let's Encrypt the recommended one.
 */
import { LoginRateLimiter, verifyPassword } from '@main/channels/web/auth'
import {
  WebStateStore,
  type PushSubscriptionRecord,
  type WebSession
} from '@main/channels/web/state'
import {
  generateVapidKeys,
  sendWebPush,
  validateSubscriptionKeys,
  type VapidKeys
} from '@main/channels/web/push'
import {
  ChallengeStore,
  LETS_ENCRYPT_PRODUCTION,
  LETS_ENCRYPT_STAGING,
  resolveDirectoryUrl,
  type AcmeStage
} from '@main/channels/web/acme'
import {
  backoffDelayMs,
  hoursRemaining,
  transition,
  type HttpsMeta,
  type HttpsState
} from '@main/channels/web/https-state'
import {
  checkIdentifier,
  defaultPreflightDeps,
  detectPublicIp,
  openFirewallPorts,
  runPreflight,
  selfTestReachability,
  type PreflightDeps,
  type PreflightStep
} from '@main/channels/web/preflight'
import {
  PUBLIC_PATH_PREFIX,
  PublicShareStore,
  sharePath,
  shareUrl,
  type PublicShare
} from '@main/channels/web/public'
import {
  PREVIEW_CSP,
  PREVIEW_PATH_PREFIX,
  PREVIEW_SHIM_MAX_BYTES,
  PreviewGrants,
  previewFile,
  withStorageShim
} from '@main/channels/web/preview'
import {
  WebInbox,
  type WebNotificationAction,
  type WebNotificationRecord
} from '@main/channels/web/inbox'
import { MirrorPacer } from '@main/channels/web/mirror-pacer'
import { TlsManager, type AcmeState, type TlsMaterial } from '@main/channels/web/tls'
import { classifyIdentifier } from '@main/channels/web/x509'
import {
  injectHeadTags,
  manifestJson,
  MANIFEST_PATH,
  SERVICE_WORKER_PATH,
  SERVICE_WORKER_SOURCE
} from '@main/channels/web/assets'
import type { ConversationMessage } from '@main/conversations'
import type { IpcHandler } from '@main/ipc-registry'
import { classifyFile, resolveUploadPath, sanitizeFileName } from '@main/uploads/uploads'
import { workspaceRoot } from '@main/workspace/root'
import {
  WEB_UI_DEFAULT_BIND,
  WEB_UI_DEFAULT_HTTPS_PORT,
  WEB_UI_DEFAULT_PORT,
  type WebUiConfig,
  type WebUiConfigPatch
} from '@main/workspace/workspace'
import { randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { WebSocket, WebSocketServer } from 'ws'

const TAG = '[web]'
const SESSION_COOKIE = 'wf_session'
const SESSION_MAX_AGE_S = 365 * 24 * 3600
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024
const MAX_JSON_BYTES = 64 * 1024
const HEARTBEAT_MS = 30_000
/** Enable and manual renew are each allowed once a minute — the CA rate-limits repeated orders. */
const MANUAL_MIN_INTERVAL_MS = 60_000
const PDF_TTL_MS = 5 * 60_000
const STAGING_PREFIX = 'web-'

/**
 * IPC channels that open something on the SERVER's screen — a native dialog,
 * a Finder window, the OS browser. Refused so a tap on a phone never raises a
 * dialog on a VPS nobody is looking at; the bridge in the browser does the
 * equivalent on its side (a file input, a download, a new tab).
 */
const GUI_ONLY = new Set([
  'upload:pickFile',
  'upload:pickFolder',
  'paths:pickDirectories',
  'projects:pickFiles',
  'procedures:pickFiles',
  'automations:pickFiles',
  'cerebellum:pickImport',
  'upload:revealInFolder',
  'viewer:revealInFolder',
  'voice:revealInFolder',
  'upload:revealPath',
  'diagnostics:reveal',
  'diagnostics:saveCopy',
  'browserExtension:openExtensionFolder',
  'browserExtension:openExtensionsPage',
  'ollama:openInstallPage',
  'ollama:pickModelsFolder',
  'updater:revealInstaller',
  'computerUse:openSettings',
  'spellcheck:replace',
  'spellcheck:addToDictionary',
  'tray-menu:action',
  'tray-menu:close'
])

export type AttachFilesRequest = {
  kind: 'project' | 'procedure' | 'automation'
  id?: string
  existing?: string[]
  paths: string[]
}

export type WebServerDeps = {
  /** The live ipcMain handler registry — see `handle()` in ipc-registry. */
  handlers: Map<string, IpcHandler>
  version: string
  /** The built renderer directory; null while electron-vite serves it in dev. */
  rendererDir: string | null
  /** The Vite dev server origin in dev; null in production. */
  devServerUrl: string | null
  /** PNG icon paths by pixel size, for the manifest and the notification badge. */
  icons: { 128: string; 256: string; 512: string }
  getConfig: () => Promise<WebUiConfig>
  /** Write a config patch; the HTTPS flow applies the mode, ports and identifier it settled on. */
  setConfig: (patch: WebUiConfigPatch) => Promise<void>
  persistVapid: (keys: VapidKeys) => Promise<void>
  stateFile: string
  tlsDir: string
  /** Print HTML to PDF with the app's Chromium; null on a box with nothing to print with. */
  exportPdf: ((html: string) => Promise<Buffer>) | null
  /** The same copy-into-folder helpers the native pickers call after the dialog closes. */
  attachFiles: (request: AttachFilesRequest) => Promise<unknown>
  onStatusChange: () => void
  /** One event per HTTPS state change or preflight/issuance step — the panel's live stepper. */
  onProgress: (event: HttpsProgressEvent) => void
  /**
   * The notification log changed. The app fans it out to its windows and to
   * every browser; without it (tests) the browsers alone are told.
   */
  onNotifications?: (items: WebNotificationRecord[]) => void
  log: (line: string) => void
  warn: (line: string) => void
}

export type HttpsProgressEvent = {
  state: HttpsState
  step: PreflightStep | null
  at: number
}

type HttpsFlow = {
  startedAt: number
  steps: PreflightStep[]
  identifier: string | null
}

export type HttpsEnableInput = {
  ip?: string | null
  domain?: string | null
  /** Let's Encrypt's staging directory — untrusted certificates, generous rate limits. */
  staging?: boolean
}

export type HttpsEnableResult = {
  ok: boolean
  /** The step that stopped the run, when one did. */
  step: PreflightStep | null
  /** The origin to move to, when it worked. */
  url: string | null
}

export type HttpsStatus = {
  state: HttpsState
  mode: 'ip' | 'domain' | null
  identifier: string | null
  identifiers: string[]
  directory: string | null
  staging: boolean
  listeners: { app: number | null; https: number | null; http: number | null }
  lastRenewalAt: number | null
  lastAttemptAt: number | null
  nextCheckAt: number | null
  lastError: string | null
  failures: number
  history: HttpsMeta['history']
  hoursRemaining: number | null
  /** The last enable run's steps, live while it runs, kept after for a reconnecting panel. */
  flow: { startedAt: number; steps: PreflightStep[]; running: boolean } | null
  /** What a browser will conclude: served over TLS, by a trusted issuer, within validity. */
  selfCheck: { https: boolean; trusted: boolean; valid: boolean }
  certificate: {
    source: TlsMaterial['source']
    issuer: string | null
    serial: string | null
    fingerprint256: string | null
    sans: string[]
    notBefore: number | null
    notAfter: number | null
  } | null
}

export type WebUiStatus = {
  enabled: boolean
  listening: boolean
  /** Why it is not listening, when it is not. */
  error: string | null
  scheme: 'http' | 'https'
  port: number
  bind: string
  /** The HTTPS listener's port while one is up, else the configured one in an HTTPS mode. */
  httpsPort: number | null
  httpPort: number | null
  urls: string[]
  localAddresses: string[]
  clients: number
  sessions: number
  subscriptions: number
  passwordSet: boolean
  notificationsEnabled: boolean
  /** The origin public links are handed out at — null while not listening. */
  publicOrigin: string | null
  /** Live public links (channels/web/public). */
  publicLinks: number
  tls: {
    source: TlsMaterial['source'] | null
    notBefore: number | null
    notAfter: number | null
    issuer: string | null
    subjectAltName: string | null
    sans: string[]
    serial: string | null
    fingerprint256: string | null
  }
  acme: AcmeState
  https: HttpsStatus
}

export type NotifyInput = {
  title: string
  body: string
  phase: 'needs_input' | 'failed' | 'completed' | 'started' | 'info'
  urgency: 'normal' | 'high'
  /** Where a tap lands — a path on this origin, e.g. `/?conversation=<id>`. */
  url: string | null
  conversationId: string | null
}

export type NotifyResult = {
  id: string
  /** Browsers that got the in-band frame (they show a toast). */
  inband: number
  /** Push subscriptions the push service accepted the message for. */
  pushed: number
  /** Push subscriptions the push service said no longer exist (dropped). */
  gone: number
  /** Push subscriptions that failed for another reason. */
  failed: number
  errors: string[]
}

type Client = {
  id: string
  ws: WebSocket
  session: WebSession
  address: string
  userAgent: string
  alive: boolean
  sender: { send: (channel: string, payload: unknown) => void; isDestroyed: () => boolean }
  page: PageLink | null
}

/**
 * One loaded page, across the sockets it opens. A turn keeps the sender of
 * the socket that started it, and a phone drops its socket every time it
 * locks: bound to the socket, every later `chat:segment`/`chat:done` went to
 * a closed socket, the page froze mid-answer and stayed "working" forever.
 * Bound to the page, events that land while it is away wait in `outbox` and
 * are flushed, in order, when the same page reconnects.
 */
type PageLink = {
  sessionId: string
  client: Client | null
  outbox: string[]
  outboxBytes: number
  /** When the last socket closed; null while one is open. */
  lostAt: number | null
  /** Gone for good — signed out, away past the grace, or the outbox overflowed. */
  dead: boolean
  reaper: ReturnType<typeof setTimeout> | null
  /**
   * Whether the user is looking at the page (on screen, window focused), as
   * the page last reported. A page with no socket is away whatever this says.
   */
  attended: boolean
  /** The page's own words for a blocked-turn push, in its language. */
  needsUserCopy: NeedsUserCopy
}

type NeedsUserCopy = { approval: string; question: string }

const DEFAULT_NEEDS_USER_COPY: NeedsUserCopy = {
  approval: 'A tool call is waiting for your approval.',
  question: 'Wolffish has a question for you.'
}

/** The events that stop a turn until the user answers — pushed to an away page. */
const NEEDS_USER_CHANNELS: Record<string, keyof NeedsUserCopy> = {
  'chat:approvalRequest': 'approval',
  'chat:askRequest': 'question'
}

/**
 * How long a page that lost its socket is still owed its events. Past this
 * the sender reports destroyed (an approval resolves as denied, exactly as
 * for a closed window) and a reload recovers the turn from main's mirror.
 */
const PAGE_GRACE_MS = 30 * 60_000
const PAGE_OUTBOX_MAX_BYTES = 16 * 1024 * 1024
const PAGE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/

function pageGone(link: PageLink): boolean {
  if (link.dead) return true
  return link.client === null && link.lostAt !== null && Date.now() - link.lostAt > PAGE_GRACE_MS
}

/**
 * A bound server plus every TCP socket it accepted. The sockets are tracked
 * so a stop can destroy them outright: Node's `server.close()` and ws 8's
 * `WebSocketServer.close()` both wait for live connections to end on their
 * own, and a browser holding its socket open would otherwise hold the whole
 * restart — and the port — hostage.
 */
type Listener = {
  server: http.Server | https.Server
  port: number
  bind: string
  sockets: Set<net.Socket>
}

/** How long a stop waits for `server.close()` after destroying every socket. */
const CLOSE_TIMEOUT_MS = 2000

type InvokeContext = { client: Client; request: http.IncomingMessage | null }

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg'
}

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (STATIC_MIME[ext]) return STATIC_MIME[ext]
  const classified = classifyFile(filePath).mimeType
  return classified === 'application/octet-stream' ? 'application/octet-stream' : classified
}

/** Non-internal addresses a browser could reach this box at, IPv4 first. */
export function localAddresses(): string[] {
  const v4: string[] = []
  const v6: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.internal) continue
      if (entry.family === 'IPv4') v4.push(entry.address)
      else if (entry.family === 'IPv6' && !entry.address.startsWith('fe80')) v6.push(entry.address)
    }
  }
  return [...v4, ...v6]
}

function remoteAddress(req: http.IncomingMessage): string {
  const raw = req.socket.remoteAddress ?? ''
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw
}

/** The Cookie header minus one cookie — empty string when nothing is left. */
function stripCookie(header: string | undefined, name: string): string {
  if (!header) return ''
  return header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${name}=`))
    .join('; ')
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
  }
  return out
}

/**
 * A browser navigating to the URL (address bar, a tapped link), as opposed
 * to a fetch, an <img> or a script. Chromium and Firefox say so outright
 * with Sec-Fetch-Mode; Safari is read from its Accept header.
 */
function isNavigation(req: http.IncomingMessage): boolean {
  const mode = req.headers['sec-fetch-mode']
  if (typeof mode === 'string') return mode === 'navigate'
  return String(req.headers.accept ?? '').includes('text/html')
}

/** Same-origin check: the Origin header's host must be the Host we were asked for. */
function sameOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  if (!origin || !host) return false
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_JSON_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  const data = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    ...headers
  })
  res.end(data)
}

/**
 * `/files/a/b c.png` ← the workspace-relative path, each segment encoded. The
 * agent hands out absolute paths too (`resolveUploadPath` admits any path
 * inside the workspace); those are made relative first, so a link never
 * carries the machine's directory layout — or a doubled slash.
 */
function fileUrl(prefix: string, relativePath: string): string {
  const root = workspaceRoot()
  const resolved = path.resolve(root, relativePath)
  const relative = resolved === root ? '' : path.relative(root, resolved)
  return `${prefix}/${relative.split(/[\\/]/).map(encodeURIComponent).join('/')}`
}

/**
 * The most binary data one frame may carry. JSON.stringify of a base64
 * string past ~150 MB kills the process outright — a V8 zone allocation
 * failure, not a catchable error; a 260 MB PDF requested by the chat's PDF
 * card did exactly that — and long before that a phone could not atob the
 * result. Files reach the browser through the file routes instead,
 * streamed and ranged; this cap is what keeps a byte-returning channel
 * from taking the app down.
 */
export const WIRE_BINARY_MAX_BYTES = 32 * 1024 * 1024

/**
 * Buffers cross the wire as `{ $bin: base64 }` — JSON has no bytes, and the
 * renderer wraps every binary result in a Blob, which takes a Uint8Array as
 * happily as the Buffer IPC used to hand it. Throws once a frame's binary
 * payload passes the cap.
 */
function encodeForWire(value: unknown, budget: { bytes: number } = { bytes: 0 }): unknown {
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    budget.bytes += value.byteLength
    if (budget.bytes > WIRE_BINARY_MAX_BYTES)
      throw new Error(
        `${(budget.bytes / 1024 / 1024).toFixed(1)} MB of binary data is too large for the socket ` +
          `(limit ${WIRE_BINARY_MAX_BYTES / 1024 / 1024} MB) — files are fetched over HTTP`
      )
    const bytes =
      value instanceof Uint8Array
        ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        : Buffer.from(value)
    return { $bin: bytes.toString('base64') }
  }
  if (Array.isArray(value)) return value.map((v) => encodeForWire(v, budget))
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Map || value instanceof Set) return encodeForWire([...value], budget)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'function') continue
    out[k] = encodeForWire(v, budget)
  }
  return out
}

function decodeFromWire(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(decodeFromWire)
  const obj = value as Record<string, unknown>
  if (typeof obj.$bin === 'string' && Object.keys(obj).length === 1)
    return Buffer.from(obj.$bin, 'base64')
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) out[k] = decodeFromWire(v)
  return out
}

export class WebServer {
  private config: WebUiConfig | null = null
  /** The plain app port — always up while the channel is on. */
  private main: Listener | null = null
  /** Port 80: challenges and redirects, in an HTTPS mode. */
  private plain: Listener | null = null
  /** The HTTPS listener, in an HTTPS mode. */
  private secure: Listener | null = null
  private wss: WebSocketServer | null = null
  private readonly clients = new Set<Client>()
  private readonly mirrors = new MirrorPacer<Client>({
    isOpen: (client) => client.ws.readyState === WebSocket.OPEN,
    buffered: (client) => client.ws.bufferedAmount,
    send: (client, frame) => this.write(client, frame),
    encode: (payload) => this.frame({ t: 'event', channel: 'conversation:messageMirror', payload })
  })
  private readonly pages = new Map<string, PageLink>()
  private readonly inbox: WebInbox
  private readonly limiter = new LoginRateLimiter()
  private readonly state: WebStateStore
  /** Public links — records that let a request past the sign-in. See public.ts. */
  readonly publicShares: PublicShareStore
  private readonly tls: TlsManager
  private readonly challenges = new ChallengeStore()
  private material: TlsMaterial | null = null
  private error: string | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private renewal: ReturnType<typeof setTimeout> | null = null
  private flow: HttpsFlow | null = null
  private lastFlow: HttpsFlow | null = null
  /** Set by the enable flow: runs once port 80 listens and before the order is placed. */
  private beforeIssue: (() => Promise<void>) | null = null
  private lastEnableAt = 0
  private lastManualRenewAt = 0
  private httpsState: HttpsState = 'disabled'
  private readonly preflightDeps: PreflightDeps
  private statusTimer: ReturnType<typeof setTimeout> | null = null
  private readonly pdfs = new Map<string, { data: Buffer; name: string; expires: number }>()
  /** Sandboxed .html previews for the chat's file cards — see preview.ts. */
  private readonly previews = new PreviewGrants()
  private readonly stagingDir: string
  /** App ports this process already asked the host firewall about. */
  private readonly firewallAsked = new Set<number>()
  private vapid: VapidKeys | null = null
  private starting: Promise<void> | null = null
  /** Signed-in browsers, cached from the last store read so quickStatus() stays synchronous. */
  private sessionCount = 0

  constructor(private readonly deps: WebServerDeps) {
    this.state = new WebStateStore(deps.stateFile)
    this.publicShares = new PublicShareStore(path.join(path.dirname(deps.stateFile), 'public.json'))
    this.inbox = new WebInbox(path.join(path.dirname(deps.stateFile), 'notifications.json'))
    this.tls = new TlsManager(deps.tlsDir, (line) => deps.log(`${TAG} ${line}`))
    this.stagingDir = path.join(workspaceRoot(), 'uploads', '.pending')
    this.preflightDeps = defaultPreflightDeps(() => this.heldPorts())
    void this.tls.getMeta().then((meta) => {
      this.httpsState = meta.state
    })
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  /** Read the config and listen (or stop) accordingly. Safe to call repeatedly. */
  async start(): Promise<void> {
    if (this.starting) return this.starting
    this.starting = this.startInner().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async startInner(): Promise<void> {
    const config = await this.deps.getConfig()
    const port = config.port ?? WEB_UI_DEFAULT_PORT
    const bind = config.bind ?? WEB_UI_DEFAULT_BIND
    // The plain app port survives a config change that does not move it:
    // the browser that pressed Enable HTTPS is connected to it, and that
    // socket is how it watches the steps. Only the TLS and challenge
    // listeners are rebuilt.
    const keepMain =
      config.enabled === true &&
      Boolean(config.passwordHash) &&
      this.main !== null &&
      this.main.port === port &&
      this.main.bind === bind
    await this.stopListeners({ keepMain })
    this.config = config
    this.error = null
    if (!config.enabled) {
      this.emitStatus()
      return
    }
    if (!config.passwordHash) {
      this.error =
        'no master password is set — Settings → Channels → Web UI, or: wolffish web password regenerate'
      this.deps.warn(`${TAG} not starting: ${this.error}`)
      this.emitStatus()
      return
    }
    await this.ensureVapid(config)
    await fs.mkdir(this.stagingDir, { recursive: true }).catch(() => undefined)
    void this.sweepStaging()
    this.sessionCount = (await this.state.listSessions()).length

    const mode = config.https?.mode ?? 'off'
    const httpsPort = config.https?.port ?? WEB_UI_DEFAULT_HTTPS_PORT
    const httpPort = config.https?.httpPort ?? null
    const upgrade = (req: http.IncomingMessage, socket: net.Socket, head: Buffer): void =>
      void this.handleUpgrade(req, socket, head)
    // The plain app port comes up first and stays up whatever happens to
    // HTTPS: it is the port the browser that pressed Enable is connected to,
    // and the one a failed certificate must never take down.
    try {
      if (!this.main) {
        this.main = await this.listen(
          http.createServer((req, res) => void this.handle(req, res)),
          port,
          bind
        )
        if (!this.wss)
          this.wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 })
        this.main.server.on('upgrade', (req, socket, head) =>
          upgrade(req, socket as net.Socket, head)
        )
        void this.openFirewall(this.main.port, bind)
      }
    } catch (err) {
      this.error = describeListenError(err)
      this.deps.warn(`${TAG} ${this.error}`)
      await this.stopListeners()
      this.emitStatus()
      return
    }
    this.material = null
    if (mode !== 'off') {
      try {
        // Port 80 before any certificate work: Let's Encrypt validates over it.
        if (httpPort && httpPort !== port) {
          this.plain = await this.listen(
            http.createServer((req, res) => void this.handlePlain(req, res)),
            httpPort,
            bind
          )
        }
        if (this.beforeIssue) await this.beforeIssue()
        if (mode === 'acme' && !this.flow) {
          const validity = await this.tls.acmeValidity()
          const meta = await this.tls.getMeta()
          await this.setHttpsState(
            transition(meta.state, 'boot', validity !== null && validity.notAfter > Date.now())
          )
        }
        this.material = await this.resolveMaterial(config, (stage, detail) =>
          this.acmeStage(stage, detail)
        )
        const server = https.createServer(
          { cert: this.material.cert, key: this.material.key },
          (req, res) => void this.handle(req, res)
        )
        this.secure = await this.listen(server, httpsPort, bind)
        this.secure.server.on('upgrade', (req, socket, head) =>
          upgrade(req, socket as net.Socket, head)
        )
        if (mode === 'acme') {
          const trusted = this.material.source === 'acme'
          const meta = await this.tls.getMeta()
          await this.setHttpsState(
            transition(meta.state, trusted ? 'issued' : 'issue-fail', false),
            trusted ? {} : { lastError: this.tls.acmeState.lastError }
          )
          void this.scheduleRenewal()
        }
      } catch (err) {
        // HTTPS failing must not take the plain port with it: the panel that
        // explains the failure is served over that port.
        this.error = `HTTPS: ${describeListenError(err)}`
        this.deps.warn(`${TAG} ${this.error}`)
        if (this.secure) await this.closeListener(this.secure)
        this.secure = null
        if (mode === 'acme') await this.setHttpsState('error', { lastError: this.error })
      }
    }

    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => this.sweepClients(), HEARTBEAT_MS)
      this.heartbeat.unref?.()
    }
    this.deps.log(`${TAG} listening on ${this.urls(config).join(', ')}`)
    this.emitStatus()
  }

  private listen(
    server: http.Server | https.Server,
    port: number,
    bind: string
  ): Promise<Listener> {
    return new Promise((resolve, reject) => {
      const sockets = new Set<net.Socket>()
      server.on('connection', (socket: net.Socket) => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
      })
      const onError = (err: Error): void => reject(err)
      server.once('error', onError)
      server.listen(port, bind, () => {
        server.removeListener('error', onError)
        // Keep the daemon honest about a listener dying later.
        server.on('error', (err) => this.deps.warn(`${TAG} listener error: ${err.message}`))
        // Port 0 asks the OS for a free one; the status must name what was bound.
        const address = server.address()
        resolve({
          server,
          port: address && typeof address === 'object' ? address.port : port,
          bind,
          sockets
        })
      })
    })
  }

  private async resolveMaterial(
    config: WebUiConfig,
    onStage?: (stage: AcmeStage, detail: string) => void
  ): Promise<TlsMaterial> {
    const mode = config.https?.mode ?? 'off'
    const addresses = localAddresses()
    if (mode === 'custom') return this.tls.custom(config)
    if (mode === 'acme') {
      try {
        return await this.tls.acme(config, this.challenges, false, onStage)
      } catch (err) {
        // Reachable beats correct: serve self-signed so the panel that shows
        // the ACME error can still be opened from the phone.
        this.deps.warn(
          `${TAG} Let's Encrypt failed (${err instanceof Error ? err.message : String(err)}) — serving a self-signed certificate until it succeeds`
        )
        return this.tls.selfSigned(config, addresses)
      }
    }
    return this.tls.selfSigned(config, addresses)
  }

  /**
   * The next look at the certificate: six hours out normally, sooner after a
   * failure (15 minutes doubling, with jitter). One timer, re-armed after
   * every check, and the time it is armed for is in the status.
   */
  private async scheduleRenewal(): Promise<void> {
    if (this.renewal) clearTimeout(this.renewal)
    this.renewal = null
    if (!this.secure || this.config?.https?.mode !== 'acme') return
    const meta = await this.tls.getMeta()
    const delay = backoffDelayMs(meta.failures)
    await this.tls.setNextCheck(Date.now() + delay)
    this.renewal = setTimeout(() => void this.renewIfDue(), delay)
    this.renewal.unref?.()
  }

  private async renewIfDue(force = false): Promise<void> {
    const config = this.config
    if (!config || config.https?.mode !== 'acme' || !this.secure) return
    const validity = await this.tls.acmeValidity()
    const certValid = validity !== null && validity.notAfter > Date.now()
    const due = force || this.material?.source !== 'acme' || (await this.tls.acmeDue())
    if (!due) {
      void this.scheduleRenewal()
      return
    }
    const before = await this.tls.getMeta()
    await this.setHttpsState(transition(before.state, 'renew', certValid))
    this.emitStatus()
    try {
      const material = await this.tls.acme(config, this.challenges, force, (stage, detail) =>
        this.acmeStage(stage, detail)
      )
      const failed = this.tls.acmeState.state === 'error'
      if (!failed && material.cert !== this.material?.cert) {
        ;(this.secure.server as https.Server).setSecureContext({
          cert: material.cert,
          key: material.key
        })
        this.material = material
        this.deps.log(
          `${TAG} certificate renewed — valid until ${material.notAfter?.toISOString() ?? '?'}`
        )
      }
      const after = await this.tls.getMeta()
      await this.setHttpsState(transition(after.state, failed ? 'issue-fail' : 'issued', certValid))
    } catch (err) {
      this.deps.warn(`${TAG} renewal failed: ${err instanceof Error ? err.message : String(err)}`)
      const after = await this.tls.getMeta()
      await this.setHttpsState(transition(after.state, 'issue-fail', certValid))
    }
    void this.scheduleRenewal()
    this.emitStatus()
  }

  /** The panel's and the CLI's "Renew now" — once a minute at most. */
  async renewCertificate(): Promise<void> {
    if (Date.now() - this.lastManualRenewAt < MANUAL_MIN_INTERVAL_MS)
      throw new Error('wait a minute between manual renewals')
    this.lastManualRenewAt = Date.now()
    await this.renewIfDue(true)
  }

  private async setHttpsState(state: HttpsState, extra: Partial<HttpsMeta> = {}): Promise<void> {
    await this.tls.setState(state, extra)
    this.httpsState = state
  }

  private acmeStage(stage: AcmeStage, detail: string): void {
    const step: PreflightStep =
      stage === 'account'
        ? { id: 'account', status: 'ok', detail, fix: null }
        : stage === 'order' || stage === 'challenge'
          ? { id: 'order', status: 'running', detail, fix: null }
          : stage === 'validated'
            ? { id: 'order', status: 'ok', detail, fix: null }
            : stage === 'finalize'
              ? { id: 'certificate', status: 'running', detail, fix: null }
              : { id: 'certificate', status: 'ok', detail, fix: null }
    this.progress(step)
  }

  /** Record a step on the running flow (replacing an earlier report of the same step) and tell the panel. */
  private progress(step: PreflightStep | null): void {
    const flow = this.flow
    if (flow && step) {
      const i = flow.steps.findIndex((s) => s.id === step.id)
      if (i >= 0) flow.steps[i] = step
      else flow.steps.push(step)
    }
    try {
      this.deps.onProgress({ state: this.httpsState, step, at: Date.now() })
    } catch {
      // a listener's problem is not the server's
    }
  }

  private heldPorts(): number[] {
    return [this.main, this.secure, this.plain].flatMap((l) => (l ? [l.port] : []))
  }

  /** Browsers on a plain port get moved once a trusted certificate is actually being served. */
  private redirectActive(): boolean {
    const mode = this.config?.https?.mode ?? 'off'
    if (mode === 'off' || !this.secure) return false
    return mode !== 'acme' || this.material?.source === 'acme'
  }

  private httpsOrigin(host: string): string {
    const port = this.secure?.port ?? this.config?.https?.port ?? WEB_UI_DEFAULT_HTTPS_PORT
    const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
    return `https://${h}${port === 443 ? '' : `:${port}`}`
  }

  /**
   * The one button: detect (or take) the address, run the preflight with
   * every step reported, switch the config to Let's Encrypt on 443 with
   * port 80 for validation, and come back with the origin to move to — or
   * with the step that stopped it and the fix for it.
   */
  async enableHttps(input: HttpsEnableInput): Promise<HttpsEnableResult> {
    if (this.flow) throw new Error('an HTTPS setup is already running')
    if (Date.now() - this.lastEnableAt < MANUAL_MIN_INTERVAL_MS)
      throw new Error("wait a minute between attempts — Let's Encrypt rate-limits repeated orders")
    this.lastEnableAt = Date.now()
    const config = await this.deps.getConfig()
    const configured = config.https?.acme?.directory
    const directoryValue = input.staging
      ? 'staging'
      : configured === 'staging'
        ? undefined
        : configured
    const directory = resolveDirectoryUrl(directoryValue)
    const publicCa = directory === LETS_ENCRYPT_PRODUCTION || directory === LETS_ENCRYPT_STAGING
    const flow: HttpsFlow = { startedAt: Date.now(), steps: [], identifier: null }
    this.flow = flow
    this.lastFlow = flow
    await this.setHttpsState('preflight', { lastError: null })
    this.progress(null)
    const fail = async (step: PreflightStep): Promise<HttpsEnableResult> => {
      this.progress({ ...step, status: 'fail' })
      await this.setHttpsState('error', { lastError: step.detail })
      this.progress(null)
      this.flow = null
      this.emitStatus()
      return { ok: false, step: { ...step, status: 'fail' }, url: null }
    }

    let wanted = (input.domain ?? '').trim() || (input.ip ?? '').trim()
    if (!wanted) {
      this.progress({
        id: 'public-ip',
        status: 'running',
        detail: 'detecting the public address…',
        fix: null
      })
      const detected = await detectPublicIp(this.preflightDeps)
      wanted = detected.ipv4 ?? detected.ipv6 ?? ''
      if (!wanted) {
        return fail({
          id: 'public-ip',
          status: 'fail',
          detail:
            'Could not detect a public IP address — api.ipify.org and icanhazip.com were both unreachable. Type the address in and try again.',
          fix: null
        })
      }
    }
    const checked = checkIdentifier(wanted, publicCa)
    if (!checked.ok)
      return fail({ id: 'public-ip', status: 'fail', detail: checked.detail, fix: null })
    const identifier = checked.identifier
    flow.identifier = identifier.value

    const port = config.port ?? WEB_UI_DEFAULT_PORT
    const httpsPort = config.https?.port ?? WEB_UI_DEFAULT_HTTPS_PORT
    // Let's Encrypt validates on port 80 and nowhere else. The listener
    // behind it is 80 itself unless the config says otherwise — a box that
    // forwards 80 to a high port with pf or iptables sets that here — and an
    // app port of 80 already answers challenges, so no second listener then.
    const configuredHttp = config.https?.httpPort ?? 80
    const httpPort = configuredHttp === port ? null : configuredHttp
    const bind = config.bind ?? WEB_UI_DEFAULT_BIND
    const preflight = await runPreflight(
      { identifier, httpsPort, httpPort: httpPort ?? port, bind, publicCa },
      this.preflightDeps,
      (step) => this.progress(step)
    )
    if (!preflight.ok) {
      const stopped =
        preflight.steps.find((step) => step.status === 'fail') ??
        preflight.steps[preflight.steps.length - 1]
      return fail(stopped)
    }

    await this.setHttpsState('issuing')
    this.progress(null)
    this.beforeIssue = async () => {
      const token = `selftest-${randomBytes(8).toString('hex')}`
      const answer = randomBytes(16).toString('hex')
      this.challenges.set(token, answer)
      try {
        this.progress({ id: 'reachable', status: 'running', detail: '', fix: null })
        this.progress(await selfTestReachability(this.preflightDeps, identifier, token, answer))
      } finally {
        this.challenges.clear(token)
      }
    }
    try {
      await this.deps.setConfig({
        https: {
          mode: 'acme',
          port: httpsPort,
          httpPort,
          acme: {
            identifiers: [identifier.value],
            email: config.https?.acme?.email,
            directory: directoryValue
          }
        }
      })
      await this.start()
    } finally {
      this.beforeIssue = null
    }

    const trusted = this.material?.source === 'acme' && this.secure !== null
    if (!trusted) {
      return fail({
        id: 'certificate',
        status: 'fail',
        detail:
          this.tls.acmeState.lastError ?? this.error ?? "Let's Encrypt did not issue a certificate",
        fix: null
      })
    }
    await this.setHttpsState('active', { lastError: null })
    this.progress(null)
    this.flow = null
    const url = this.httpsOrigin(identifier.value)
    this.pushBroadcast('web:httpsActive', { url })
    this.emitStatus()
    return { ok: true, step: null, url }
  }

  /** Back to plain HTTP on the app port. The certificate files stay for a later re-enable. */
  async disableHttps(): Promise<WebUiStatus> {
    if (this.flow) throw new Error('an HTTPS setup is running — wait for it to finish')
    await this.deps.setConfig({ https: { mode: 'off' } })
    await this.setHttpsState('disabled', { lastError: null })
    this.lastFlow = null
    await this.start()
    return this.status()
  }

  private async httpsStatus(config: WebUiConfig): Promise<HttpsStatus> {
    const meta = await this.tls.getMeta()
    const mode = config.https?.mode ?? 'off'
    const identifiers = config.https?.acme?.identifiers ?? []
    const first = identifiers[0] ?? null
    const kind = first ? (classifyIdentifier(first)?.type === 'ip' ? 'ip' : 'domain') : null
    const directory = mode === 'acme' ? resolveDirectoryUrl(config.https?.acme?.directory) : null
    const m = this.material
    const flow = this.flow ?? this.lastFlow
    return {
      state:
        mode === 'acme' || meta.state === 'error' || meta.state === 'preflight'
          ? meta.state
          : 'disabled',
      mode: kind,
      identifier: first,
      identifiers,
      directory,
      staging: directory === LETS_ENCRYPT_STAGING,
      listeners: {
        app: this.main?.port ?? null,
        https: this.secure?.port ?? null,
        http: this.plain?.port ?? null
      },
      lastRenewalAt: meta.lastRenewalAt,
      lastAttemptAt: meta.lastAttemptAt,
      nextCheckAt: meta.nextCheckAt,
      lastError: meta.lastError,
      failures: meta.failures,
      history: meta.history,
      hoursRemaining: hoursRemaining(m?.notAfter?.getTime() ?? null),
      flow: flow
        ? { startedAt: flow.startedAt, steps: flow.steps, running: this.flow !== null }
        : null,
      selfCheck: {
        https: this.secure !== null,
        trusted: m?.source === 'acme' || m?.source === 'custom',
        valid: m?.notAfter ? m.notAfter.getTime() > Date.now() : false
      },
      certificate: m
        ? {
            source: m.source,
            issuer: m.issuer,
            serial: m.serial,
            fingerprint256: m.fingerprint256,
            sans: m.sans,
            notBefore: m.notBefore?.getTime() ?? null,
            notAfter: m.notAfter?.getTime() ?? null
          }
        : null
    }
  }

  private async closeListener(listener: Listener): Promise<void> {
    listener.server.closeAllConnections?.()
    for (const socket of listener.sockets) socket.destroy()
    listener.sockets.clear()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS)
      listener.server.close(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private async stopListeners({ keepMain = false }: { keepMain?: boolean } = {}): Promise<void> {
    if (this.renewal) clearTimeout(this.renewal)
    this.renewal = null
    if (!keepMain) {
      if (this.heartbeat) clearInterval(this.heartbeat)
      this.heartbeat = null
      this.disconnectAll('server restarting')
      const wss = this.wss
      this.wss = null
      // No callback awaited: ws 8 only fires it once every client has gone,
      // and the clients are torn down with their sockets just below.
      wss?.close()
    }
    for (const listener of [keepMain ? null : this.main, this.secure, this.plain]) {
      if (listener) await this.closeListener(listener)
    }
    if (!keepMain) this.main = null
    this.secure = null
    this.plain = null
  }

  async stop(): Promise<void> {
    await this.stopListeners()
    this.emitStatus()
  }

  /** Config changed somewhere — re-read and relisten. */
  async applyConfig(): Promise<void> {
    await this.start()
  }

  disconnectAll(reason: string): void {
    for (const client of this.clients) {
      try {
        client.ws.close(1012, reason)
        // The close frame is a courtesy; the socket goes now either way, and
        // the bridge treats an abrupt end exactly like a clean 1012 — reconnect.
        client.ws.terminate()
      } catch {
        // already gone
      }
    }
    this.clients.clear()
  }

  // ─── status ────────────────────────────────────────────────────────────────

  /** The names a browser can reach this box by — the certificate's first, then interfaces. */
  private hostsFor(config: WebUiConfig): string[] {
    const bind = config.bind ?? WEB_UI_DEFAULT_BIND
    return bind === '0.0.0.0' || bind === '::' || bind === ''
      ? [...(config.https?.acme?.identifiers ?? []), ...localAddresses(), 'localhost']
      : [bind]
  }

  private urls(config: WebUiConfig): string[] {
    const hosts = this.hostsFor(config)
    const seen = new Set<string>()
    const out: string[] = []
    const push = (url: string): void => {
      if (seen.has(url)) return
      seen.add(url)
      out.push(url)
    }
    const bracket = (host: string): string =>
      host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
    if (this.secure) {
      const port = this.secure.port
      for (const host of hosts) push(`https://${bracket(host)}${port === 443 ? '' : `:${port}`}`)
    }
    // The plain port is listed while it is a real way in; once it redirects
    // to HTTPS it is not an address to hand out any more.
    if (this.main && !this.redirectActive()) {
      const port = this.main.port
      for (const host of hosts) push(`http://${bracket(host)}${port === 80 ? '' : `:${port}`}`)
    }
    return out
  }

  async status(): Promise<WebUiStatus> {
    const config = this.config ?? (await this.deps.getConfig())
    const sessions = await this.state.listSessions()
    const subscriptions = await this.state.listSubscriptions()
    this.sessionCount = sessions.length
    return {
      enabled: config.enabled === true,
      listening: this.main !== null,
      error: this.error,
      scheme: this.secure ? 'https' : 'http',
      port: this.main?.port ?? config.port ?? WEB_UI_DEFAULT_PORT,
      bind: config.bind ?? WEB_UI_DEFAULT_BIND,
      httpsPort:
        this.secure?.port ??
        ((config.https?.mode ?? 'off') === 'off'
          ? null
          : (config.https?.port ?? WEB_UI_DEFAULT_HTTPS_PORT)),
      httpPort: this.plain?.port ?? config.https?.httpPort ?? null,
      urls: this.main ? this.urls(config) : [],
      localAddresses: localAddresses(),
      clients: this.clients.size,
      sessions: sessions.length,
      subscriptions: subscriptions.length,
      passwordSet: typeof config.passwordHash === 'string' && config.passwordHash.length > 0,
      notificationsEnabled: config.notifications !== false,
      publicOrigin: this.publicOrigin(),
      publicLinks: (await this.publicShares.list()).length,
      tls: {
        source: this.material?.source ?? null,
        notBefore: this.material?.notBefore?.getTime() ?? null,
        notAfter: this.material?.notAfter?.getTime() ?? null,
        issuer: this.material?.issuer ?? null,
        subjectAltName: this.material?.subjectAltName ?? null,
        sans: this.material?.sans ?? [],
        serial: this.material?.serial ?? null,
        fingerprint256: this.material?.fingerprint256 ?? null
      },
      acme: { ...this.tls.acmeState },
      https: await this.httpsStatus(config)
    }
  }

  private emitStatus(): void {
    if (this.statusTimer) return
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null
      try {
        this.deps.onStatusChange()
      } catch {
        // a listener's problem is not the server's
      }
    }, 150)
    this.statusTimer.unref?.()
  }

  clientCount(): number {
    return this.clients.size
  }

  isListening(): boolean {
    return this.main !== null
  }

  /** The synchronous view the channel-status aggregator reads on every agent turn. */
  quickStatus(): {
    enabled: boolean
    listening: boolean
    clients: number
    sessions: number
    error: string | null
  } {
    return {
      enabled: this.config?.enabled === true,
      listening: this.main !== null,
      clients: this.clients.size,
      sessions: this.sessionCount,
      error: this.error
    }
  }

  listSessions(): Promise<WebSession[]> {
    return this.state.listSessions()
  }

  async revokeSession(id: string): Promise<void> {
    await this.state.revokeSession(id)
    for (const client of this.clients) {
      if (client.session.id === id) client.ws.close(4001, 'signed out')
    }
    this.retireSessionPages((sessionId) => sessionId !== id)
    this.sessionCount = (await this.state.listSessions()).length
    this.emitStatus()
  }

  /**
   * Sign every browser out, except — when the change came from a browser —
   * the one that asked. It proved it held the old password a moment ago, and
   * signing it out would hand it a new passphrase it never gets to read.
   *
   * Signed-out sockets close with 4001, which the bridge takes as final and
   * sends to the sign-in page. A plain restart code would have them
   * reconnecting against a 401 forever.
   */
  async revokeAllSessions({ except }: { except?: string } = {}): Promise<void> {
    await this.state.revokeAllSessions({ except })
    this.retireSessionPages((sessionId) => except !== undefined && sessionId === except)
    for (const client of this.clients) {
      if (except !== undefined && client.session.id === except) continue
      try {
        client.ws.close(4001, 'signed out')
      } catch {
        // already gone
      }
      this.forgetClient(client)
    }
    this.sessionCount = (await this.state.listSessions()).length
    this.emitStatus()
  }

  // ─── fan-out ───────────────────────────────────────────────────────────────

  /** An app-wide broadcast — index.ts calls this from `broadcast()`. */
  pushBroadcast(channel: string, payload: unknown): void {
    if (this.clients.size === 0) return
    if (channel === 'conversation:messageMirror') {
      const mirror = payload as { conversationId?: unknown; message?: ConversationMessage }
      if (typeof mirror.conversationId === 'string' && mirror.message) {
        this.mirrors.push(this.clients, mirror.conversationId, mirror.message)
      }
      return
    }
    if (channel === 'conversation:changed') this.mirrors.drop()
    const frame = this.frame({ t: 'event', channel, payload })
    if (!frame) return
    for (const client of this.clients) this.write(client, frame)
  }

  private forgetClient(client: Client): void {
    this.clients.delete(client)
    this.mirrors.forget(client)
  }

  private frame(value: unknown): string | null {
    try {
      return this.encode(value)
    } catch (err) {
      this.deps.log(`${TAG} dropped a frame: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  private encode(value: unknown): string {
    return JSON.stringify(encodeForWire(value))
  }

  private write(client: Client, frame: string): void {
    if (client.ws.readyState !== WebSocket.OPEN) return
    try {
      client.ws.send(frame)
    } catch {
      // the close event will drop the client
    }
  }

  // ─── notifications ─────────────────────────────────────────────────────────

  private async ensureVapid(config: WebUiConfig): Promise<VapidKeys> {
    if (this.vapid) return this.vapid
    const stored = config.push
    if (stored?.vapidPublicKey && stored.vapidPrivateKey) {
      this.vapid = { publicKey: stored.vapidPublicKey, privateKey: stored.vapidPrivateKey }
      return this.vapid
    }
    const keys = generateVapidKeys()
    await this.deps.persistVapid(keys)
    this.vapid = keys
    this.deps.log(`${TAG} generated Web Push (VAPID) keys`)
    return keys
  }

  /**
   * One notification, to every browser that can take one: an in-band frame
   * to each live connection (they show a toast, and a system notification
   * when the page is hidden and no push subscription will cover it) and an
   * encrypted push to every stored subscription, which lands with the
   * browser closed. A subscription the push service reports gone is dropped.
   */
  async notify(input: NotifyInput): Promise<NotifyResult> {
    const id = randomBytes(8).toString('hex')
    const at = Date.now()
    const payload = {
      id,
      title: input.title,
      body: input.body,
      phase: input.phase,
      urgency: input.urgency,
      url: input.url,
      conversationId: input.conversationId,
      at
    }
    const result: NotifyResult = { id, inband: 0, pushed: 0, gone: 0, failed: 0, errors: [] }

    // Logged before it is sent, so a browser that opens its inbox the moment
    // the banner lands finds it there.
    try {
      const added = await this.inbox.record({
        id,
        title: input.title,
        body: input.body,
        phase: input.phase,
        url: input.url,
        conversationId: input.conversationId,
        at
      })
      if (added) await this.announceNotifications()
    } catch (err) {
      this.deps.log(
        `${TAG} could not log a notification: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    const frame = this.frame({ t: 'event', channel: 'web:notify', payload })
    if (frame) {
      for (const client of this.clients) {
        this.write(client, frame)
        result.inband++
      }
    }

    const ttl =
      input.phase === 'needs_input'
        ? 300
        : input.phase === 'started' || input.phase === 'info'
          ? 900
          : 3600
    const subscriptions = await this.state.listSubscriptions()
    const delivery = await this.pushTo(subscriptions, payload, ttl, input.urgency, id)
    return { ...result, ...delivery }
  }

  /** The notification log, newest first. */
  notifications(): Promise<WebNotificationRecord[]> {
    return this.inbox.list()
  }

  /** Read or archive from any browser; every browser gets the new log. */
  async updateNotifications(action: WebNotificationAction): Promise<WebNotificationRecord[]> {
    if (await this.inbox.apply(action)) await this.announceNotifications()
    return this.inbox.list()
  }

  private async announceNotifications(): Promise<void> {
    const items = await this.inbox.list()
    if (this.deps.onNotifications) this.deps.onNotifications(items)
    else this.pushBroadcast('web:notifications', items)
  }

  /** One encrypted push per subscription; a subscription the push service reports gone is dropped. */
  private async pushTo(
    subscriptions: PushSubscriptionRecord[],
    payload: Record<string, unknown>,
    ttlSeconds: number,
    urgency: 'normal' | 'high',
    topic: string
  ): Promise<Pick<NotifyResult, 'pushed' | 'gone' | 'failed' | 'errors'>> {
    const out = { pushed: 0, gone: 0, failed: 0, errors: [] as string[] }
    if (subscriptions.length === 0) return out
    const config = this.config ?? (await this.deps.getConfig())
    const vapid = await this.ensureVapid(config)
    const body = Buffer.from(JSON.stringify(payload))
    await Promise.all(
      subscriptions.map(async (sub: PushSubscriptionRecord) => {
        const delivery = await sendWebPush(
          { endpoint: sub.endpoint, keys: sub.keys },
          { payload: body, ttlSeconds, urgency, topic },
          vapid,
          'mailto:younes@wolffi.sh'
        )
        if (delivery.ok) out.pushed++
        else if (delivery.gone) {
          out.gone++
          await this.state.removeSubscription(sub.endpoint)
        } else {
          out.failed++
          out.errors.push(delivery.error)
        }
      })
    )
    if (out.gone > 0) this.emitStatus()
    return out
  }

  /** The page's report of whether the user is looking at it, plus its copy for a blocked-turn push. */
  private onAttention(client: Client, frame: { attended?: unknown; copy?: unknown }): void {
    const link = client.page
    if (!link || link.client !== client) return
    link.attended = frame.attended === true
    const copy = frame.copy as Partial<NeedsUserCopy> | null | undefined
    const text = (value: unknown, fallback: string): string =>
      typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : fallback
    if (copy && typeof copy === 'object') {
      link.needsUserCopy = {
        approval: text(copy.approval, DEFAULT_NEEDS_USER_COPY.approval),
        question: text(copy.question, DEFAULT_NEEDS_USER_COPY.question)
      }
    }
  }

  /**
   * A turn this page started is blocked on an approval or a question and the
   * user is away from it — a locked phone runs no page code, so the page
   * cannot raise this itself. Only this browser's subscriptions: the other
   * devices did not start the turn and cannot answer its card.
   */
  private async pushNeedsUser(
    link: PageLink,
    kind: keyof NeedsUserCopy,
    event: unknown
  ): Promise<void> {
    try {
      if ((await this.deps.getConfig()).notifications === false) return
      const { id, conversationId } = (event ?? {}) as { id?: unknown; conversationId?: unknown }
      if (typeof id !== 'string' || !id) return
      const cid = typeof conversationId === 'string' && conversationId ? conversationId : null
      const subscriptions = (await this.state.listSubscriptions()).filter(
        (sub) => sub.sessionId === link.sessionId
      )
      // Same id the page counts it under, so the badge counts it once.
      const payload = {
        id: `needs-${id}`,
        title: 'Wolffish',
        body: link.needsUserCopy[kind],
        phase: 'needs_input',
        urgency: 'high',
        url: cid ? `/?conversation=${encodeURIComponent(cid)}` : '/',
        conversationId: cid,
        at: Date.now()
      }
      const topic = randomBytes(8).toString('hex')
      const result = await this.pushTo(subscriptions, payload, 300, 'high', topic)
      for (const error of result.errors) this.deps.log(`${TAG} needs-user push failed: ${error}`)
    } catch (err) {
      this.deps.log(
        `${TAG} needs-user push failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  // ─── HTTP ──────────────────────────────────────────────────────────────────

  /**
   * Port 80: ACME answers; everything else is sent to HTTPS for good once
   * that listener is up, and to the plain app port meanwhile, so a visitor
   * who types the bare address lands somewhere during the first issuance.
   */
  private async handlePlain(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (this.serveChallenge(url.pathname, res)) return
    // A public link is answered on whichever port it arrived at: a redirect
    // to an HTTPS listener with a self-signed certificate would put a browser
    // interstitial between a stranger and the file.
    if (url.pathname.startsWith(PUBLIC_PATH_PREFIX)) {
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('X-Frame-Options', 'DENY')
      res.setHeader('Referrer-Policy', 'no-referrer')
      return this.routePublic(req, res, url)
    }
    const host = (req.headers.host ?? 'localhost').replace(/:\d+$/, '')
    const tail = `${url.pathname}${url.search}`
    if (this.secure) {
      res.writeHead(301, {
        Location: `${this.httpsOrigin(host)}${tail}`,
        'Cache-Control': 'no-store'
      })
    } else {
      const port = this.main?.port ?? this.config?.port ?? WEB_UI_DEFAULT_PORT
      const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
      res.writeHead(302, { Location: `http://${h}:${port}${tail}`, 'Cache-Control': 'no-store' })
    }
    res.end()
  }

  private serveChallenge(pathname: string, res: http.ServerResponse): boolean {
    const m = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]+)$/.exec(pathname)
    if (!m) return false
    const answer = this.challenges.get(m[1])
    if (!answer) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('no such challenge')
      return true
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': Buffer.byteLength(answer)
    })
    res.end(answer)
    return true
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    try {
      await this.route(req, res)
    } catch (err) {
      this.deps.warn(
        `${TAG} ${req.method} ${req.url}: ${err instanceof Error ? err.message : String(err)}`
      )
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' })
      else res.end()
    }
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'
    const p = url.pathname

    if (this.serveChallenge(p, res)) return
    // The plain app port, once a trusted certificate is being served:
    // browsers arriving by address move to HTTPS. API and socket traffic of
    // a page already open keeps working until that page follows the
    // web:httpsActive event it was sent.
    if (
      this.secure &&
      !isEncrypted(req) &&
      this.redirectActive() &&
      method === 'GET' &&
      !p.startsWith('/api/') &&
      !p.startsWith(PUBLIC_PATH_PREFIX) &&
      !p.startsWith(PREVIEW_PATH_PREFIX) &&
      isNavigation(req)
    ) {
      const host = (req.headers.host ?? 'localhost').replace(/:\d+$/, '')
      res.writeHead(301, {
        Location: `${this.httpsOrigin(host)}${p}${url.search}`,
        'Cache-Control': 'no-store'
      })
      res.end()
      return
    }
    if (p === SERVICE_WORKER_PATH)
      return this.serveText(res, SERVICE_WORKER_SOURCE, 'text/javascript; charset=utf-8', {
        'Service-Worker-Allowed': '/',
        'Cache-Control': 'no-cache'
      })
    if (p === MANIFEST_PATH)
      return this.serveText(res, manifestJson(), 'application/manifest+json', {
        'Cache-Control': 'no-cache'
      })
    const icon = /^\/icon-(128|256|512)\.png$/.exec(p)
    if (icon)
      return this.serveFile(req, res, this.deps.icons[Number(icon[1]) as 128 | 256 | 512], {
        download: false,
        cache: 'public, max-age=86400'
      })

    if (p.startsWith('/api/auth/')) return this.routeAuth(req, res, p, method)
    // Public links: the one route a request reaches with no cookie. The
    // token in the path is the whole permission; public.ts owns the records.
    if (p.startsWith(PUBLIC_PATH_PREFIX)) return this.routePublic(req, res, url)
    // Previews carry no cookie either — a sandboxed page's requests cannot.
    // The token was minted for a signed-in session; preview.ts owns them.
    if (p.startsWith(PREVIEW_PATH_PREFIX)) return this.routePreview(req, res, url)

    // Everything below needs a signed-in browser.
    const session = await this.sessionFor(req)
    if (
      p.startsWith('/api/') ||
      p.startsWith('/files/') ||
      p.startsWith('/download/') ||
      p === '/device' ||
      p.startsWith('/pdf/')
    ) {
      if (!session) {
        // A person following a file link (a notification, a pasted URL, a new
        // device) lands on the sign-in page and comes back to the link once
        // signed in; a script or an <img> gets the bare 401 it can act on.
        if (
          !p.startsWith('/api/') &&
          (method === 'GET' || method === 'HEAD') &&
          isNavigation(req)
        ) {
          res.writeHead(302, {
            Location: `/?next=${encodeURIComponent(url.pathname + url.search)}`,
            'Cache-Control': 'no-store'
          })
          res.end()
          return
        }
        return sendJson(res, 401, { ok: false, error: 'not signed in' })
      }
      if (method === 'POST' && !sameOrigin(req))
        return sendJson(res, 403, { ok: false, error: 'cross-origin request refused' })
      if (p === '/api/upload' && method === 'POST') return this.routeUpload(req, res, url)
      if (p === '/api/push/subscribe' && method === 'POST')
        return this.routeSubscribe(req, res, session)
      if (p === '/api/push/unsubscribe' && method === 'POST') return this.routeUnsubscribe(req, res)
      if (p.startsWith('/files/') && (method === 'GET' || method === 'HEAD'))
        return this.routeWorkspaceFile(req, res, p.slice('/files/'.length), false)
      if (p.startsWith('/download/') && (method === 'GET' || method === 'HEAD'))
        return this.routeWorkspaceFile(req, res, p.slice('/download/'.length), true)
      if (p === '/device' && (method === 'GET' || method === 'HEAD'))
        return this.routeDeviceFile(req, res, url.searchParams.get('path') ?? '')
      if (p.startsWith('/pdf/') && method === 'GET')
        return this.routePdf(req, res, p.slice('/pdf/'.length))
      return sendJson(res, 404, { ok: false, error: 'not found' })
    }

    if (method !== 'GET' && method !== 'HEAD')
      return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return this.routeStatic(req, res, p)
  }

  private serveText(
    res: http.ServerResponse,
    text: string,
    type: string,
    headers: Record<string, string> = {}
  ): void {
    const data = Buffer.from(text, 'utf8')
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, ...headers })
    res.end(data)
  }

  // ─── auth routes ───────────────────────────────────────────────────────────

  private async sessionFor(req: http.IncomingMessage): Promise<WebSession | null> {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    if (!token) return null
    return this.state.resolveSession(token)
  }

  private cookie(token: string | null, req: http.IncomingMessage): string {
    const secure = (req.socket as { encrypted?: boolean }).encrypted ? '; Secure' : ''
    if (token === null)
      return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_S}${secure}`
  }

  private async routeAuth(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    p: string,
    method: string
  ): Promise<void> {
    const config = this.config ?? (await this.deps.getConfig())
    if (p === '/api/auth/status' && method === 'GET') {
      const session = await this.sessionFor(req)
      const secure = Boolean((req.socket as { encrypted?: boolean }).encrypted)
      return sendJson(res, 200, {
        authenticated: session !== null,
        passwordSet: Boolean(config.passwordHash),
        version: this.deps.version,
        secure,
        notificationsEnabled: config.notifications !== false,
        vapidPublicKey: session ? (await this.ensureVapid(config)).publicKey : null
      })
    }
    if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    if (!sameOrigin(req))
      return sendJson(res, 403, { ok: false, error: 'cross-origin request refused' })

    if (p === '/api/auth/login') {
      const address = remoteAddress(req)
      const verdict = this.limiter.check(address)
      if (!verdict.allowed) {
        const seconds = Math.ceil(verdict.retryAfterMs / 1000)
        return sendJson(
          res,
          429,
          {
            ok: false,
            error: `too many attempts — try again in ${seconds}s`,
            retryAfterMs: verdict.retryAfterMs
          },
          { 'Retry-After': String(seconds) }
        )
      }
      let body: { password?: unknown }
      try {
        body = (await readJson(req)) as { password?: unknown }
      } catch {
        return sendJson(res, 400, { ok: false, error: 'invalid request' })
      }
      const password = typeof body.password === 'string' ? body.password : ''
      const okPassword = await verifyPassword(password, config.passwordHash)
      if (!okPassword) {
        this.limiter.recordFailure(address)
        this.deps.warn(`${TAG} failed login from ${address}`)
        return sendJson(res, 401, { ok: false, error: 'wrong password' })
      }
      this.limiter.recordSuccess(address)
      const { token } = await this.state.createSession({
        userAgent: String(req.headers['user-agent'] ?? ''),
        address
      })
      this.sessionCount++
      this.deps.log(`${TAG} signed in from ${address}`)
      this.emitStatus()
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': this.cookie(token, req) })
    }

    if (p === '/api/auth/logout') {
      const session = await this.sessionFor(req)
      if (session) {
        await this.state.revokeSession(session.id)
        for (const client of this.clients) {
          if (client.session.id === session.id) client.ws.close(4001, 'signed out')
        }
        this.retireSessionPages((sessionId) => sessionId !== session.id)
        this.sessionCount = Math.max(0, this.sessionCount - 1)
        this.deps.log(`${TAG} signed out: session ${session.id}`)
        this.emitStatus()
      }
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': this.cookie(null, req) })
    }
    return sendJson(res, 404, { ok: false, error: 'not found' })
  }

  // ─── push routes ───────────────────────────────────────────────────────────

  private async routeSubscribe(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    session: WebSession
  ): Promise<void> {
    let body: { endpoint?: unknown; keys?: unknown }
    try {
      body = (await readJson(req)) as { endpoint?: unknown; keys?: unknown }
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid request' })
    }
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint : ''
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 2048)
      return sendJson(res, 400, { ok: false, error: 'bad endpoint' })
    if (!validateSubscriptionKeys(body.keys))
      return sendJson(res, 400, { ok: false, error: 'bad subscription keys' })
    const record = await this.state.upsertSubscription({
      sessionId: session.id,
      endpoint,
      keys: body.keys,
      userAgent: String(req.headers['user-agent'] ?? '')
    })
    this.emitStatus()
    return sendJson(res, 200, { ok: true, id: record.id })
  }

  private async routeUnsubscribe(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    let body: { endpoint?: unknown }
    try {
      body = (await readJson(req)) as { endpoint?: unknown }
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid request' })
    }
    if (typeof body.endpoint === 'string') await this.state.removeSubscription(body.endpoint)
    this.emitStatus()
    return sendJson(res, 200, { ok: true })
  }

  // ─── uploads ───────────────────────────────────────────────────────────────

  /**
   * One route for every file a browser sends up. The bytes land in a staging
   * folder under the workspace with their original name, and the response is
   * the staged path — which the renderer then hands to the exact handler a
   * native picker's path would have gone to (upload:saveFile, the attach
   * helpers, the capability importer). The staged copy is removed once that
   * handler has consumed it (see `consumeStaged`).
   */
  private async routeUpload(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): Promise<void> {
    const declared = Number(req.headers['content-length'] ?? '0')
    if (declared > MAX_UPLOAD_BYTES)
      return sendJson(res, 413, { ok: false, error: 'file too large' })
    let name = 'upload.bin'
    try {
      name = sanitizeFileName(decodeURIComponent(url.searchParams.get('name') ?? ''))
    } catch {
      name = 'upload.bin'
    }
    const dir = path.join(this.stagingDir, `${STAGING_PREFIX}${randomBytes(8).toString('hex')}`)
    await fs.mkdir(dir, { recursive: true })
    const target = path.join(dir, name)
    let size = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_UPLOAD_BYTES && !tooLarge) {
        tooLarge = true
        req.destroy(new Error('file too large'))
      }
    })
    try {
      await pipeline(req, createWriteStream(target))
    } catch (err) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
      if (!res.headersSent)
        sendJson(res, tooLarge ? 413 : 400, {
          ok: false,
          error: tooLarge
            ? 'file too large'
            : `upload failed: ${err instanceof Error ? err.message : String(err)}`
        })
      return
    }
    if (size === 0) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
      return sendJson(res, 400, { ok: false, error: 'empty upload' })
    }
    return sendJson(res, 200, { ok: true, path: target, name, size })
  }

  /**
   * Staged uploads live until the handler that takes them runs. One that
   * never runs — a tab closed between upload and send, a save that failed
   * midway — leaves its folder behind, so anything older than a day goes on
   * every start. A day, not an hour: a send can legitimately follow an
   * upload much later than an hour on a phone that was put down.
   */
  private async sweepStaging(): Promise<void> {
    const cutoff = Date.now() - 24 * 3_600_000
    let names: string[] = []
    try {
      names = await fs.readdir(this.stagingDir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.startsWith(STAGING_PREFIX)) continue
      const dir = path.join(this.stagingDir, name)
      try {
        const stat = await fs.stat(dir)
        if (stat.mtimeMs < cutoff) await fs.rm(dir, { recursive: true, force: true })
      } catch {
        // gone already, or not ours to touch
      }
    }
  }

  private isStaged(p: unknown): p is string {
    return typeof p === 'string' && p.startsWith(this.stagingDir + path.sep + STAGING_PREFIX)
  }

  private async consumeStaged(paths: unknown[]): Promise<void> {
    for (const p of paths) {
      if (!this.isStaged(p)) continue
      await fs.rm(path.dirname(p), { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /**
   * The app port, opened in the host firewall the first time it listens on
   * a public interface — the same helper the HTTPS preflight uses for 80
   * and 443, so a fresh VPS answers on its port without a ufw line typed by
   * hand. Loopback binds and macOS have nothing to open; a refusal is
   * logged with the command, never thrown — the listener is already up.
   */
  private async openFirewall(port: number, bind: string): Promise<void> {
    if (this.firewallAsked.has(port)) return
    this.firewallAsked.add(port)
    if (bind === '127.0.0.1' || bind === '::1' || bind === 'localhost') return
    try {
      const step = await openFirewallPorts(this.preflightDeps, [port])
      if (step.status === 'ok') this.deps.log(`${TAG} firewall: ${step.detail}`)
      else if (step.status === 'warn')
        this.deps.warn(
          `${TAG} firewall: ${step.detail}${step.fix ? ` ${step.fix.text} ${step.fix.commands.join(' ; ')}` : ''}`
        )
    } catch (err) {
      this.deps.warn(`${TAG} firewall: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ─── public links ──────────────────────────────────────────────────────────

  /** `/p/<token>` → the share, and the path under it (`''` at the root). */
  private async resolvePublic(
    pathname: string
  ): Promise<{ share: PublicShare; rest: string; atRoot: boolean } | null> {
    const m = /^\/p\/([A-Za-z0-9_-]{16,128})(\/.*)?$/.exec(pathname)
    if (!m) return null
    const share = await this.publicShares.resolve(m[1])
    if (!share) return null
    return { share, rest: m[2] ?? '', atRoot: m[2] === undefined }
  }

  private async routePublic(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): Promise<void> {
    const method = req.method ?? 'GET'
    const hit = await this.resolvePublic(url.pathname)
    if (!hit) return sendJson(res, 404, { ok: false, error: 'not found' })
    const { share, rest, atRoot } = hit
    this.publicShares.recordHit(share)

    if (share.kind === 'proxy') return this.proxyPublic(req, res, share, rest, url.search)

    if (method !== 'GET' && method !== 'HEAD')
      return sendJson(res, 405, { ok: false, error: 'method not allowed' })

    if (share.kind === 'file') {
      if (rest !== '' && rest !== '/') return sendJson(res, 404, { ok: false, error: 'not found' })
      const download = share.download || url.searchParams.get('download') === '1'
      return this.serveFile(req, res, share.path!, {
        download,
        cache: 'public, max-age=0, must-revalidate'
      })
    }

    // A site: relative links in its pages resolve against the directory
    // URL, so the bare token redirects to the trailing-slash form first.
    if (atRoot) {
      res.writeHead(301, {
        Location: `${sharePath(share)}${url.search}`,
        'Cache-Control': 'no-store'
      })
      res.end()
      return
    }
    let decoded: string
    try {
      decoded = decodeURIComponent(rest)
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad path' })
    }
    if (decoded.includes('\0') || decoded.split('/').includes('..'))
      return sendJson(res, 404, { ok: false, error: 'not found' })
    // The folder is symlink-resolved here as the file below will be, and a
    // share whose folder is gone answers 404 rather than throwing.
    let root: string
    try {
      root = await fs.realpath(share.path!)
    } catch {
      return sendJson(res, 404, { ok: false, error: 'not found' })
    }
    let abs = path.join(root, decoded)
    if (abs !== root && !abs.startsWith(root + path.sep))
      return sendJson(res, 404, { ok: false, error: 'not found' })
    let stat: Awaited<ReturnType<typeof fs.stat>> | null = null
    try {
      stat = await fs.stat(abs)
    } catch {
      stat = null
    }
    if (stat?.isDirectory()) {
      if (!decoded.endsWith('/')) {
        res.writeHead(301, {
          Location: `${sharePath(share)}${rest.slice(1)}/${url.search}`,
          'Cache-Control': 'no-store'
        })
        res.end()
        return
      }
      abs = path.join(abs, 'index.html')
      try {
        stat = await fs.stat(abs)
      } catch {
        stat = null
      }
    }
    if (!stat || !stat.isFile()) {
      // Single-page apps route in the browser: an extension-less miss is
      // the app's own URL, answered with its index.html.
      if (path.extname(decoded) !== '') return sendJson(res, 404, { ok: false, error: 'not found' })
      abs = path.join(root, 'index.html')
      try {
        stat = await fs.stat(abs)
      } catch {
        return sendJson(res, 404, { ok: false, error: 'not found' })
      }
      if (!stat.isFile()) return sendJson(res, 404, { ok: false, error: 'not found' })
    }
    // A symlink inside the folder may point anywhere; what it points at has
    // to be inside the folder too, or it is a way out of the share.
    try {
      const real = await fs.realpath(abs)
      if (real !== root && !real.startsWith(root + path.sep))
        return sendJson(res, 404, { ok: false, error: 'not found' })
    } catch {
      return sendJson(res, 404, { ok: false, error: 'not found' })
    }
    return this.serveFile(req, res, abs, {
      download: false,
      cache: 'public, max-age=0, must-revalidate'
    })
  }

  /**
   * A port on this box, behind the link. The link's own path prefix is
   * stripped and announced as X-Forwarded-Prefix; the app's `Location`
   * answers are put back under it. The sign-in cookie never crosses — the
   * proxied app is somebody else's code.
   */
  private proxyPublic(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    share: PublicShare,
    rest: string,
    search: string
  ): void {
    const prefix = sharePath(share).replace(/\/$/, '')
    if (rest === '') {
      res.writeHead(301, { Location: `${prefix}/${search}`, 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    const headers: Record<string, string | string[] | undefined> = { ...req.headers }
    headers.host = `127.0.0.1:${share.port}`
    headers['x-forwarded-for'] = remoteAddress(req)
    headers['x-forwarded-proto'] = isEncrypted(req) ? 'https' : 'http'
    headers['x-forwarded-host'] = String(req.headers.host ?? '')
    headers['x-forwarded-prefix'] = prefix
    const cookie = stripCookie(req.headers.cookie, SESSION_COOKIE)
    if (cookie) headers.cookie = cookie
    else delete headers.cookie
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: share.port!,
        method: req.method,
        path: `${rest}${search}`,
        headers
      },
      (up) => {
        const out: Record<string, string | string[] | undefined> = { ...up.headers }
        const location = up.headers.location
        if (typeof location === 'string' && location.startsWith('/') && !location.startsWith('//'))
          out.location = `${prefix}${location}`
        res.writeHead(up.statusCode ?? 502, out)
        up.pipe(res)
      }
    )
    upstream.on('error', (err) => {
      if (!res.headersSent)
        sendJson(res, 502, {
          ok: false,
          error: `nothing is answering on port ${share.port} (${err.message})`
        })
      else res.end()
    })
    req.pipe(upstream)
  }

  /** A websocket under a proxied link — raw TCP splice after the upstream's 101. */
  private proxyPublicUpgrade(
    req: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
    share: PublicShare,
    rest: string,
    search: string
  ): void {
    const headers: Record<string, string | string[] | undefined> = { ...req.headers }
    headers.host = `127.0.0.1:${share.port}`
    headers['x-forwarded-for'] = remoteAddress(req)
    headers['x-forwarded-proto'] = isEncrypted(req) ? 'https' : 'http'
    headers['x-forwarded-prefix'] = sharePath(share).replace(/\/$/, '')
    const cookie = stripCookie(req.headers.cookie, SESSION_COOKIE)
    if (cookie) headers.cookie = cookie
    else delete headers.cookie
    const upstream = http.request({
      host: '127.0.0.1',
      port: share.port!,
      method: req.method,
      path: `${rest || '/'}${search}`,
      headers
    })
    upstream.on('upgrade', (up, upSocket, upHead) => {
      const lines = [
        `HTTP/1.1 ${up.statusCode ?? 101} ${up.statusMessage ?? 'Switching Protocols'}`
      ]
      for (const [k, v] of Object.entries(up.headers)) {
        if (v === undefined) continue
        for (const value of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${value}`)
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n')
      if (upHead.length > 0) socket.write(upHead)
      if (head.length > 0) upSocket.write(head)
      socket.pipe(upSocket).pipe(socket)
      socket.on('error', () => upSocket.destroy())
      upSocket.on('error', () => socket.destroy())
    })
    upstream.on('response', (up) => {
      socket.write(
        `HTTP/1.1 ${up.statusCode ?? 502} ${up.statusMessage ?? ''}\r\nConnection: close\r\n\r\n`
      )
      socket.destroy()
    })
    upstream.on('error', () => {
      socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
      socket.destroy()
    })
    upstream.end()
  }

  /**
   * Where public links point. The configured origin wins; otherwise the
   * first address the listeners announce — the certificate's name in an
   * HTTPS mode, else the first reachable interface.
   */
  publicOrigin(): string | null {
    if (!this.main || !this.config) return null
    const configured = this.config.publicOrigin?.trim()
    if (configured) return configured.replace(/\/+$/, '')
    // A self-signed certificate is fine for the user's own browser, which
    // has accepted it once, and wrong for a stranger following a link: the
    // plain port is the address to hand out until the certificate is
    // trusted — even though, for the app itself, that port now redirects.
    const trusted = this.material?.source === 'acme' || this.material?.source === 'custom'
    if (this.secure && !trusted) {
      const host = this.hostsFor(this.config)[0] ?? 'localhost'
      const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
      return `http://${h}${this.main.port === 80 ? '' : `:${this.main.port}`}`
    }
    return this.urls(this.config)[0] ?? null
  }

  async listPublicShares(): Promise<Array<PublicShare & { url: string }>> {
    const origin = this.publicOrigin() ?? ''
    return (await this.publicShares.list()).map((s) => ({ ...s, url: shareUrl(origin, s) }))
  }

  async revokePublicShare(id: string): Promise<boolean> {
    const share = await this.publicShares.revoke(id)
    if (share) this.deps.log(`${TAG} public link ${share.id} revoked`)
    return share !== null
  }

  async revokeAllPublicShares(): Promise<number> {
    const n = await this.publicShares.revokeAll()
    if (n > 0) this.deps.log(`${TAG} ${n} public link${n === 1 ? '' : 's'} revoked`)
    return n
  }

  /**
   * What the system prompt says about this channel — turn-stable facts only
   * (origin, scheme, trust), never counters, so the cached prefix survives
   * a browser signing in or a link being made.
   */
  promptFacts(): { origin: string; scheme: 'http' | 'https'; trusted: boolean } | null {
    const origin = this.publicOrigin()
    if (!origin) return null
    return {
      origin,
      scheme: this.secure ? 'https' : 'http',
      trusted: this.material?.source === 'acme' || this.material?.source === 'custom'
    }
  }

  // ─── file routes ───────────────────────────────────────────────────────────

  /**
   * A private preview (preview.ts). The sandbox header rides every answer —
   * it is what keeps a page opened in a tab of its own out of the app's
   * origin — and CORS is `*` because the sandboxed page's module scripts,
   * fonts and fetches are cross-origin requests from an opaque origin: the
   * token, not the origin, is the permission. A page itself is read whole to
   * carry the storage stand-in an opaque origin lacks.
   */
  private async routePreview(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): Promise<void> {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD')
      return sendJson(res, 405, { ok: false, error: 'method not allowed' })
    const m = /^\/preview\/([A-Za-z0-9_-]{16,128})(\/.*)?$/.exec(url.pathname)
    const grant = m ? this.previews.resolve(m[1]) : null
    const abs = grant && m ? await previewFile(grant, m[2] ?? '') : null
    if (!abs) return sendJson(res, 404, { ok: false, error: 'not found' })
    res.setHeader('Content-Security-Policy', PREVIEW_CSP)
    res.setHeader('Access-Control-Allow-Origin', '*')
    if (method === 'GET' && /\.html?$/i.test(abs)) {
      const { size } = await fs.stat(abs)
      if (size <= PREVIEW_SHIM_MAX_BYTES)
        return this.serveText(
          res,
          withStorageShim(await fs.readFile(abs, 'utf8')),
          'text/html; charset=utf-8',
          { 'Cache-Control': 'private, no-cache', 'X-Frame-Options': 'SAMEORIGIN' }
        )
    }
    return this.serveFile(req, res, abs, { download: false, cache: 'private, no-cache' })
  }

  private async routeWorkspaceFile(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    encoded: string,
    download: boolean
  ): Promise<void> {
    let relative: string
    try {
      relative = encoded.split('/').map(decodeURIComponent).join('/')
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad path' })
    }
    const abs = resolveUploadPath(relative)
    if (!abs) return sendJson(res, 404, { ok: false, error: 'not found' })
    return this.serveFile(req, res, abs, { download, cache: 'private, no-cache' })
  }

  private async routeDeviceFile(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    raw: string
  ): Promise<void> {
    const trimmed = raw.trim()
    let resolved = trimmed
    if (trimmed === '~') resolved = os.homedir()
    else if (trimmed.startsWith('~/')) resolved = path.join(os.homedir(), trimmed.slice(2))
    if (!resolved || !path.isAbsolute(resolved))
      return sendJson(res, 400, { ok: false, error: 'bad path' })
    return this.serveFile(req, res, resolved, { download: true, cache: 'private, no-cache' })
  }

  private async routePdf(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string
  ): Promise<void> {
    const entry = this.pdfs.get(id)
    if (!entry || entry.expires < Date.now()) {
      this.pdfs.delete(id)
      return sendJson(res, 404, { ok: false, error: 'expired' })
    }
    this.pdfs.delete(id)
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': entry.data.length,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
      'Cache-Control': 'no-store'
    })
    res.end(entry.data)
  }

  /** Stream one file with Range support — phones need it for audio and video. */
  private async serveFile(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    abs: string,
    opts: { download: boolean; cache: string }
  ): Promise<void> {
    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      stat = await fs.stat(abs)
    } catch {
      return sendJson(res, 404, { ok: false, error: 'not found' })
    }
    if (!stat.isFile()) return sendJson(res, 404, { ok: false, error: 'not a file' })
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
    const headers: Record<string, string | number> = {
      'Content-Type': mimeFor(abs),
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Last-Modified': stat.mtime.toUTCString(),
      'Cache-Control': opts.cache,
      // The app frames its own files — the feed's PDF card, the HTML viewer —
      // so a file answers SAMEORIGIN where every page answers DENY.
      'X-Frame-Options': 'SAMEORIGIN'
    }
    if (opts.download)
      headers['Content-Disposition'] =
        `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers)
      res.end()
      return
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
    let start = 0
    let end = stat.size - 1
    let status = 200
    if (range && stat.size > 0) {
      const from = range[1] === '' ? NaN : Number(range[1])
      const to = range[2] === '' ? NaN : Number(range[2])
      if (Number.isNaN(from)) {
        start = Math.max(0, stat.size - to)
      } else {
        start = from
        if (!Number.isNaN(to)) end = Math.min(to, stat.size - 1)
      }
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
        res.end()
        return
      }
      status = 206
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`
    }
    headers['Content-Length'] = end - start + 1
    res.writeHead(status, headers)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = createReadStream(abs, { start, end })
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }

  // ─── static / dev proxy ────────────────────────────────────────────────────

  private async routeStatic(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    p: string
  ): Promise<void> {
    if (this.deps.devServerUrl) return this.proxyToDevServer(req, res)
    const root = this.deps.rendererDir
    if (!root) return sendJson(res, 503, { ok: false, error: 'renderer bundle not found' })
    const wantsIndex = p === '/' || p === '/index.html'
    let rel = wantsIndex ? 'index.html' : decodeURIComponent(p.slice(1))
    if (rel.includes('..') || rel.includes('\0'))
      return sendJson(res, 400, { ok: false, error: 'bad path' })
    let abs = path.join(root, rel)
    if (!abs.startsWith(root + path.sep) && abs !== path.join(root, 'index.html'))
      return sendJson(res, 404, { ok: false, error: 'not found' })
    let stat: Awaited<ReturnType<typeof fs.stat>> | null = null
    try {
      stat = await fs.stat(abs)
    } catch {
      stat = null
    }
    if (!stat || !stat.isFile()) {
      // Any unknown path is the app: a deeplink such as /?conversation=… and a
      // reload on a PWA start URL both want index.html.
      if (path.extname(rel) !== '') return sendJson(res, 404, { ok: false, error: 'not found' })
      rel = 'index.html'
      abs = path.join(root, rel)
    }
    if (rel === 'index.html') {
      const html = injectHeadTags(await fs.readFile(abs, 'utf8'))
      return this.serveText(res, html, 'text/html; charset=utf-8', { 'Cache-Control': 'no-cache' })
    }
    const immutable = rel.startsWith('assets/')
    return this.serveFile(req, res, abs, {
      download: false,
      cache: immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'
    })
  }

  /** Dev only: hand the request to electron-vite's dev server so HMR works in the browser too. */
  private proxyToDevServer(req: http.IncomingMessage, res: http.ServerResponse): void {
    const target = new URL(req.url ?? '/', this.deps.devServerUrl!)
    const headers: Record<string, string | string[] | undefined> = {
      ...req.headers,
      host: target.host
    }
    delete headers['accept-encoding']
    const upstream = http.request(target, { method: req.method, headers }, (up) => {
      const isHtml = /text\/html/.test(String(up.headers['content-type'] ?? ''))
      if (isHtml) {
        const chunks: Buffer[] = []
        up.on('data', (c: Buffer) => chunks.push(c))
        up.on('end', () => {
          const html = injectHeadTags(Buffer.concat(chunks).toString('utf8'))
          const out = { ...up.headers }
          delete out['content-length']
          delete out['transfer-encoding']
          res.writeHead(up.statusCode ?? 200, { ...out, 'content-length': Buffer.byteLength(html) })
          res.end(html)
        })
        return
      }
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    })
    upstream.on('error', (err) => {
      if (!res.headersSent)
        sendJson(res, 502, { ok: false, error: `dev server unreachable: ${err.message}` })
      else res.end()
    })
    req.pipe(upstream)
  }

  // ─── WebSocket ─────────────────────────────────────────────────────────────

  private async handleUpgrade(
    req: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname.startsWith(PUBLIC_PATH_PREFIX)) {
      const hit = await this.resolvePublic(url.pathname)
      if (hit && hit.share.kind === 'proxy') {
        this.publicShares.recordHit(hit.share)
        return this.proxyPublicUpgrade(req, socket, head, hit.share, hit.rest, url.search)
      }
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (url.pathname !== '/ws') {
      if (this.deps.devServerUrl) return this.proxyUpgradeToDevServer(req, socket, head)
      socket.destroy()
      return
    }
    const session = await this.sessionFor(req)
    if (!session || !sameOrigin(req) || !this.wss) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req, session))
  }

  /** Vite's HMR socket, in dev — anything that is not our own /ws. */
  private proxyUpgradeToDevServer(
    req: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer
  ): void {
    const target = new URL(req.url ?? '/', this.deps.devServerUrl!)
    target.protocol = 'ws:'
    const protocols = req.headers['sec-websocket-protocol']
    const upstream = new WebSocket(
      target,
      protocols
        ? String(protocols)
            .split(',')
            .map((s) => s.trim())
        : [],
      {
        headers: { host: target.host }
      }
    )
    upstream.on('open', () => {
      const wss = new WebSocketServer({ noServer: true })
      wss.handleUpgrade(req, socket, head, (client) => {
        client.on('message', (data, isBinary) => upstream.send(data, { binary: isBinary }))
        upstream.on('message', (data, isBinary) => client.send(data, { binary: isBinary }))
        client.on('close', () => upstream.close())
        upstream.on('close', () => client.close())
        client.on('error', () => upstream.close())
      })
    })
    upstream.on('error', () => socket.destroy())
  }

  private onConnection(ws: WebSocket, req: http.IncomingMessage, session: WebSession): void {
    const { link, resumed } = this.pageLinkFor(req, session)
    const client: Client = {
      id: randomBytes(6).toString('hex'),
      ws,
      session,
      address: remoteAddress(req),
      userAgent: String(req.headers['user-agent'] ?? ''),
      alive: true,
      sender: {
        send: (channel, payload) => {
          const frame = this.frame({ t: 'event', channel, payload })
          if (!frame) return
          if (link) this.sendToPage(link, frame)
          else this.write(client, frame)
          const kind = NEEDS_USER_CHANNELS[channel]
          if (kind && link && (link.client === null || !link.attended))
            void this.pushNeedsUser(link, kind, payload)
        },
        isDestroyed: () => (link ? pageGone(link) : ws.readyState !== WebSocket.OPEN)
      },
      page: link
    }
    this.clients.add(client)
    ws.on('pong', () => {
      client.alive = true
    })
    ws.on('message', (data) => void this.onFrame(client, data))
    let dropped = false
    const drop = (code?: number): void => {
      this.forgetClient(client)
      if (link && !dropped) this.pageLost(link, client, code === 4001)
      dropped = true
      this.emitStatus()
    }
    ws.on('close', (code) => drop(code))
    ws.on('error', () => drop())
    const hello = this.frame({
      t: 'hello',
      version: this.deps.version,
      pid: process.pid,
      clientId: client.id,
      sessionId: session.id,
      secure: Boolean((req.socket as { encrypted?: boolean }).encrypted),
      notificationsEnabled: this.config?.notifications !== false,
      vapidPublicKey: this.vapid?.publicKey ?? null,
      needsUserPush: true,
      // False on a reconnect whose page was not kept (away past the grace,
      // signed out, overflowed): its turn's events are gone, so it resyncs.
      resumed
    })
    if (hello) this.write(client, hello)
    if (link) this.pageAttached(link, client)
    this.deps.log(`${TAG} browser connected from ${client.address} (session ${session.id})`)
    this.emitStatus()
  }

  /** The page this socket belongs to (`/ws?page=<id>`), reattached when it is a reconnect. */
  private pageLinkFor(
    req: http.IncomingMessage,
    session: WebSession
  ): { link: PageLink | null; resumed: boolean } {
    const pageId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('page')
    if (!pageId || !PAGE_ID_RE.test(pageId)) return { link: null, resumed: false }
    const existing = this.pages.get(pageId)
    // Another session presenting a known page id gets nothing of it.
    if (existing && !existing.dead && existing.sessionId === session.id)
      return { link: existing, resumed: true }
    if (existing) this.retirePage(pageId, existing)
    const link: PageLink = {
      sessionId: session.id,
      client: null,
      outbox: [],
      outboxBytes: 0,
      lostAt: null,
      dead: false,
      reaper: null,
      attended: true,
      needsUserCopy: DEFAULT_NEEDS_USER_COPY
    }
    this.pages.set(pageId, link)
    return { link, resumed: false }
  }

  private pageAttached(link: PageLink, client: Client): void {
    // A second tab can never share a page id, but a reconnect can race the
    // old socket's close: the newest socket is the page.
    link.client = client
    link.lostAt = null
    if (link.reaper) {
      clearTimeout(link.reaper)
      link.reaper = null
    }
    const queued = link.outbox
    link.outbox = []
    link.outboxBytes = 0
    for (const frame of queued) this.write(client, frame)
  }

  private sendToPage(link: PageLink, frame: string): void {
    if (link.dead) return
    const client = link.client
    if (client && client.ws.readyState === WebSocket.OPEN) {
      this.write(client, frame)
      return
    }
    link.outboxBytes += frame.length
    if (link.outboxBytes > PAGE_OUTBOX_MAX_BYTES) {
      // Too far behind to replay faithfully — a gap in the middle of a turn
      // is worse than none. The page recovers by reloading the conversation.
      link.dead = true
      link.outbox = []
      link.outboxBytes = 0
      return
    }
    link.outbox.push(frame)
  }

  private pageLost(link: PageLink, client: Client, signedOut: boolean): void {
    if (link.client !== client) return
    link.client = null
    link.lostAt = Date.now()
    if (signedOut) link.dead = true
    if (link.reaper) clearTimeout(link.reaper)
    link.reaper = setTimeout(() => {
      link.reaper = null
      if (link.client) return
      for (const [id, l] of this.pages) if (l === link) this.retirePage(id, l)
    }, PAGE_GRACE_MS)
    link.reaper.unref?.()
  }

  private retirePage(pageId: string, link: PageLink): void {
    link.dead = true
    link.outbox = []
    link.outboxBytes = 0
    if (link.reaper) clearTimeout(link.reaper)
    link.reaper = null
    if (this.pages.get(pageId) === link) this.pages.delete(pageId)
  }

  /** A signed-out session's pages are owed nothing — not even events queued for them, or its previews. */
  private retireSessionPages(keep: (sessionId: string) => boolean): void {
    for (const [id, link] of [...this.pages]) if (!keep(link.sessionId)) this.retirePage(id, link)
    this.previews.revoke((sessionId) => !keep(sessionId))
  }

  private sweepClients(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        client.ws.terminate()
        this.forgetClient(client)
        continue
      }
      client.alive = false
      try {
        client.ws.ping()
      } catch {
        client.ws.terminate()
        this.forgetClient(client)
      }
    }
  }

  private async onFrame(client: Client, data: WebSocket.RawData): Promise<void> {
    let frame: { t?: string; id?: number; channel?: string; args?: unknown[] }
    try {
      frame = JSON.parse(data.toString()) as typeof frame
    } catch {
      return
    }
    if (frame.t === 'ping') {
      this.write(client, '{"t":"pong"}')
      return
    }
    if (frame.t === 'attention') {
      this.onAttention(client, frame as { attended?: unknown; copy?: unknown })
      return
    }
    if (frame.t !== 'invoke' || typeof frame.id !== 'number' || typeof frame.channel !== 'string')
      return
    const args = Array.isArray(frame.args) ? (decodeFromWire(frame.args) as unknown[]) : []
    const reply = (ok: boolean, body: unknown): void => {
      let out: string
      try {
        out = this.encode(
          ok
            ? { t: 'result', id: frame.id, ok: true, value: body }
            : { t: 'result', id: frame.id, ok: false, error: body }
        )
      } catch (err) {
        // A result that cannot cross the wire answers as an error — never a
        // silent timeout on the other side, never a crash on this one.
        out = JSON.stringify({
          t: 'result',
          id: frame.id,
          ok: false,
          error: err instanceof Error ? err.message : 'unserializable result'
        })
      }
      this.write(client, out)
    }
    try {
      reply(true, await this.invoke(frame.channel, args, { client, request: null }))
    } catch (err) {
      reply(false, err instanceof Error ? err.message : String(err))
    }
  }

  /** The dispatch every frame goes through — overrides first, then the app's own handler map. */
  private async invoke(channel: string, args: unknown[], ctx: InvokeContext): Promise<unknown> {
    if (GUI_ONLY.has(channel))
      throw new Error(`${channel} needs the desktop window — the browser does this on its own side`)
    const override = this.overrides[channel]
    if (override) return override(args, ctx)
    const handler = this.deps.handlers.get(channel)
    if (!handler) throw new Error(`unknown channel: ${channel}`)
    const stagedArgs = this.stagedPathsIn(channel, args)
    try {
      // `webSessionId` names the browser session behind the call, for the
      // handlers that sign sessions out and must spare the caller's.
      return await handler(
        { sender: ctx.client.sender, webSessionId: ctx.client.session.id },
        ...args
      )
    } finally {
      if (stagedArgs.length > 0) await this.consumeStaged(stagedArgs)
    }
  }

  /** Handlers that consume a path argument the upload route staged. */
  private stagedPathsIn(channel: string, args: unknown[]): string[] {
    if (channel === 'upload:saveFile') {
      const p = (args[0] as { sourcePath?: unknown } | undefined)?.sourcePath
      return this.isStaged(p) ? [p] : []
    }
    if (channel === 'cerebellum:importCapability') return this.isStaged(args[0]) ? [args[0]] : []
    return []
  }

  private readonly overrides: Record<
    string,
    (args: unknown[], ctx: InvokeContext) => Promise<unknown>
  > = {
    'upload:fileUrl': async (args) => {
      const relative = typeof args[0] === 'string' ? args[0] : ''
      return resolveUploadPath(relative) ? fileUrl('/files', relative) : null
    },
    'upload:previewUrl': async (args, ctx) => {
      const abs = resolveUploadPath(typeof args[0] === 'string' ? args[0] : '')
      return abs ? this.previews.grant(ctx.client.session.id, abs) : null
    },
    'upload:download': async (args) => {
      const relative = typeof args[0] === 'string' ? args[0] : ''
      return resolveUploadPath(relative)
        ? { ok: true, downloadUrl: fileUrl('/download', relative) }
        : { ok: false }
    },
    'viewer:download': async (args) => {
      const relative = typeof args[0] === 'string' ? args[0] : ''
      return resolveUploadPath(relative)
        ? { ok: true, downloadUrl: fileUrl('/download', relative) }
        : { ok: false }
    },
    'upload:downloadPath': async (args) => {
      const p = typeof args[0] === 'string' ? args[0] : ''
      if (!p) return { ok: false, error: 'invalid path' }
      return { ok: true, downloadUrl: `/device?path=${encodeURIComponent(p)}` }
    },
    'voice:download': async (args) => {
      const p = typeof args[0] === 'string' ? args[0] : ''
      if (!p) return { ok: false }
      return { ok: true, downloadUrl: `/device?path=${encodeURIComponent(p)}` }
    },
    'upload:openExternal': async (args, ctx) => {
      const relative = typeof args[0] === 'string' ? args[0] : ''
      const abs = resolveUploadPath(relative)
      if (!abs) return { ok: false, error: 'invalid path' }
      // A page opens the way its card shows it: sandboxed, assets resolving —
      // never as /files/, where its scripts would run as the app.
      if (/\.(html?|xhtml)$/i.test(abs)) {
        const preview = await this.previews.grant(ctx.client.session.id, abs)
        if (preview) return { ok: true, openUrl: preview }
      }
      return { ok: true, openUrl: fileUrl('/files', relative) }
    },
    'browser:openExternal': async (args) => {
      const url = (args[0] as { url?: unknown } | undefined)?.url
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url))
        return { ok: false, error: 'Only http(s) URLs open outside.' }
      return { ok: true, openUrl: url }
    },
    'mic:checkAccess': async () => 'granted',
    'mic:requestAccess': async () => true,
    'chat:exportPdf': async (args) => {
      const payload = args[0] as { html?: unknown; fileName?: unknown } | undefined
      if (!this.deps.exportPdf)
        return { ok: false, error: 'PDF export is not available on this server' }
      if (typeof payload?.html !== 'string') return { ok: false, error: 'nothing to export' }
      const data = await this.deps.exportPdf(payload.html)
      const id = randomBytes(8).toString('hex')
      const name = String(payload.fileName ?? 'chat.pdf').replace(/[\\/:*?"<>|]/g, '-')
      this.pdfs.set(id, { data, name, expires: Date.now() + PDF_TTL_MS })
      for (const [key, entry] of this.pdfs) if (entry.expires < Date.now()) this.pdfs.delete(key)
      return { ok: true, downloadUrl: `/pdf/${id}` }
    },
    'web:attachFiles': async (args) => {
      const request = args[0] as AttachFilesRequest | undefined
      if (!request || !Array.isArray(request.paths)) throw new Error('attachFiles needs paths')
      try {
        return await this.deps.attachFiles(request)
      } finally {
        await this.consumeStaged(request.paths)
      }
    },
    'web:discardStaged': async (args) => {
      const paths = Array.isArray(args[0]) ? args[0] : []
      await this.consumeStaged(paths)
      return { ok: true }
    }
  }
}

function isEncrypted(req: http.IncomingMessage): boolean {
  return (req.socket as { encrypted?: boolean }).encrypted === true
}

function describeListenError(err: unknown): string {
  const e = err as NodeJS.ErrnoException
  if (e?.code === 'EADDRINUSE')
    return `port ${(e as { port?: number }).port ?? ''} is already in use`.replace('  ', ' ')
  if (e?.code === 'EACCES')
    return 'binding that port needs root (or CAP_NET_BIND_SERVICE on Linux) — pick a port above 1024 or run as a service that has it'
  if (e?.code === 'EADDRNOTAVAIL') return 'that bind address does not belong to this machine'
  return e instanceof Error ? e.message : String(err)
}
