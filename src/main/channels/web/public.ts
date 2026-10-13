/**
 * Public links — the one door past the master password, opened by the agent.
 *
 * Everything the Web UI serves is behind the sign-in: a `/files/…` URL is
 * useless to anyone the user has not handed the passphrase. That is right
 * for the app and wrong for the thing the app produces — a report to
 * forward, a page built for someone else, a download for a colleague, a web
 * app running on this box that a client should click through. Each of those
 * becomes a public link here: a share record naming a file, a folder served
 * as a static site, or a local port reverse-proxied, reachable at
 * `/p/<token>` with no cookie, where the token is 192 random bits and the
 * whole capability.
 *
 * The registry IS the whitelist: nothing is public unless a record says so,
 * a revoked record is gone from the next request on, and an expired one
 * answers 404. The agent owns the records through the `web-public` tools;
 * the panel and the CLI list and revoke them. A few paths can never be
 * shared — the Web UI's own state (TLS keys, sessions, this file), the
 * workspace config with its secrets, Chromium's profile and the user's SSH
 * directory — because a link to them would hand out the keys to the box.
 */
import { diskWriter } from '@main/io/diskWriter'
import type {
  Capability,
  SkillToolDescriptor,
  ToolExecutionResult,
  WolffishPlugin
} from '@main/runtime/cerebellum'
import { turnScope } from '@main/runtime/corpus'
import { workspaceRoot } from '@main/workspace/root'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const WEB_PUBLIC_CAPABILITY_NAME = 'web-public'
export const PUBLIC_PATH_PREFIX = '/p/'

export type PublicShareKind = 'file' | 'site' | 'proxy'

export type PublicShare = {
  /** Short public id — what the panel, the CLI and public_unlink name. */
  id: string
  /** The URL path segment. Unguessable; knowing it is the whole permission. */
  token: string
  kind: PublicShareKind
  /** Absolute, symlink-resolved path for `file` and `site`; null for `proxy`. */
  path: string | null
  /** The local port a `proxy` share forwards to; null otherwise. */
  port: number | null
  name: string
  /** `file` only: answer with Content-Disposition: attachment by default. */
  download: boolean
  createdAt: number
  expiresAt: number | null
  hits: number
  lastHitAt: number | null
  conversationId: string | null
}

export type PublicShareInput = {
  path?: string | null
  port?: number | null
  name?: string | null
  download?: boolean
  /** Milliseconds from now; null or undefined means no expiry. */
  ttlMs?: number | null
  conversationId?: string | null
}

type PublicState = {
  version: 1
  shares: PublicShare[]
}

const TOKEN_BYTES = 24
const HIT_WRITE_INTERVAL_MS = 30_000
const NAME_MAX = 120

export function expiryToMs(raw: unknown): number | null | { error: string } {
  if (raw === undefined || raw === null) return null
  const text = String(raw).trim().toLowerCase()
  if (text === '' || text === 'never' || text === 'none' || text === '0') return null
  const m =
    /^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/.exec(
      text
    )
  if (!m) return { error: `expires must be like "30m", "2h", "7d", "2w" or "never" — got "${raw}"` }
  const n = Number(m[1])
  const unit = m[2][0]
  const ms =
    unit === 'm'
      ? n * 60_000
      : unit === 'h'
        ? n * 3_600_000
        : unit === 'd'
          ? n * 86_400_000
          : n * 7 * 86_400_000
  if (!Number.isFinite(ms) || ms <= 0) return { error: 'expires must be a positive duration' }
  return Math.round(ms)
}

/**
 * Directories whose contents must never be public, however the request is
 * phrased. Resolved once; compared against the symlink-resolved share path.
 */
export async function forbiddenRoots(): Promise<string[]> {
  const workspace = workspaceRoot()
  const home = os.homedir()
  const raw = [
    path.join(workspace, 'web'),
    path.join(workspace, 'config.json'),
    path.join(path.dirname(workspace), 'runtime'),
    path.join(home, '.ssh'),
    path.join(home, '.gnupg'),
    path.join(home, '.aws'),
    path.join(home, '.config', 'gcloud')
  ]
  // Both sides of the comparison are symlink-resolved: macOS keeps the temp
  // and home trees behind links (/var → /private/var), and an unresolved
  // root would never match the resolved share path.
  return Promise.all(raw.map((p) => fs.realpath(p).catch(() => p)))
}

function isWithin(target: string, root: string): boolean {
  if (target === root) return true
  const rel = path.relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export function expandHome(p: string): string {
  const trimmed = p.trim()
  if (trimmed === '~') return os.homedir()
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2))
  return trimmed
}

/**
 * Where a share may point. Relative paths resolve against the workspace
 * (the agent writes its outputs under `files/`), `~` against the home
 * directory, and the result is symlink-resolved before the policy check so
 * a link into a forbidden directory is caught by what it points at.
 */
export async function resolveSharePath(
  raw: string
): Promise<{ ok: true; path: string; kind: 'file' | 'site' } | { ok: false; error: string }> {
  const expanded = expandHome(raw)
  if (!expanded || expanded.includes('\0')) return { ok: false, error: 'path is required' }
  const abs = path.isAbsolute(expanded) ? expanded : path.resolve(workspaceRoot(), expanded)
  let real: string
  try {
    real = await fs.realpath(abs)
  } catch {
    return { ok: false, error: `nothing exists at ${abs}` }
  }
  for (const root of await forbiddenRoots()) {
    if (isWithin(real, root) || isWithin(root, real))
      return {
        ok: false,
        error: `${real} cannot be made public — it holds (or contains) the app's own secrets`
      }
  }
  const stat = await fs.stat(real)
  if (stat.isDirectory()) return { ok: true, path: real, kind: 'site' }
  if (stat.isFile()) return { ok: true, path: real, kind: 'file' }
  return { ok: false, error: `${real} is neither a file nor a folder` }
}

export class PublicShareStore {
  private state: PublicState | null = null
  private loading: Promise<PublicState> | null = null
  private writes: Promise<void> = Promise.resolve()
  private lastHitWrite = 0

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now
  ) {}

  private async load(): Promise<PublicState> {
    if (this.state) return this.state
    if (!this.loading) {
      this.loading = (async () => {
        let parsed: Partial<PublicState> | null = null
        try {
          parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<PublicState>
        } catch {
          parsed = null
        }
        const state: PublicState = {
          version: 1,
          shares: Array.isArray(parsed?.shares)
            ? parsed.shares.filter(
                (s): s is PublicShare =>
                  typeof s?.id === 'string' &&
                  typeof s?.token === 'string' &&
                  typeof s?.kind === 'string'
              )
            : []
        }
        this.state = state
        return state
      })()
    }
    return this.loading
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2)
    this.writes = this.writes
      .then(async () => {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true })
        await diskWriter.writeFileAtomic(this.filePath, snapshot)
      })
      .catch(() => undefined)
    return this.writes
  }

  private sweep(state: PublicState): boolean {
    const t = this.now()
    const before = state.shares.length
    state.shares = state.shares.filter((s) => s.expiresAt === null || s.expiresAt > t)
    return state.shares.length !== before
  }

  async list(): Promise<PublicShare[]> {
    const state = await this.load()
    if (this.sweep(state)) void this.persist()
    return state.shares.map((s) => ({ ...s }))
  }

  /** The live share a token names, or null — expired and revoked both read as null. */
  async resolve(token: string | null | undefined): Promise<PublicShare | null> {
    if (!token || typeof token !== 'string' || token.length > 128) return null
    const state = await this.load()
    const share = state.shares.find((s) => s.token === token) ?? null
    if (!share) return null
    if (share.expiresAt !== null && share.expiresAt <= this.now()) {
      this.sweep(state)
      void this.persist()
      return null
    }
    return share
  }

  recordHit(share: PublicShare): void {
    share.hits++
    share.lastHitAt = this.now()
    if (this.now() - this.lastHitWrite >= HIT_WRITE_INTERVAL_MS) {
      this.lastHitWrite = this.now()
      void this.persist()
    }
  }

  /**
   * One live record per target: sharing the same file or port again returns
   * the existing link (its expiry refreshed when a new one was asked for),
   * so a repeated call never scatters a second URL for the same thing.
   */
  async create(input: {
    kind: PublicShareKind
    path: string | null
    port: number | null
    name: string
    download: boolean
    ttlMs: number | null
    conversationId: string | null
  }): Promise<{ share: PublicShare; existed: boolean }> {
    const state = await this.load()
    this.sweep(state)
    const t = this.now()
    const existing = state.shares.find(
      (s) =>
        s.kind === input.kind &&
        (input.kind === 'proxy' ? s.port === input.port : s.path === input.path)
    )
    if (existing) {
      existing.name = input.name
      existing.download = input.download
      existing.expiresAt = input.ttlMs === null ? null : t + input.ttlMs
      await this.persist()
      return { share: { ...existing }, existed: true }
    }
    const share: PublicShare = {
      id: randomBytes(4).toString('hex'),
      token: randomBytes(TOKEN_BYTES).toString('base64url'),
      kind: input.kind,
      path: input.path,
      port: input.port,
      name: input.name,
      download: input.download,
      createdAt: t,
      expiresAt: input.ttlMs === null ? null : t + input.ttlMs,
      hits: 0,
      lastHitAt: null,
      conversationId: input.conversationId
    }
    state.shares.push(share)
    await this.persist()
    return { share: { ...share }, existed: false }
  }

  async revoke(id: string): Promise<PublicShare | null> {
    const state = await this.load()
    const share = state.shares.find((s) => s.id === id || s.token === id) ?? null
    if (!share) return null
    state.shares = state.shares.filter((s) => s !== share)
    await this.persist()
    return { ...share }
  }

  async revokeAll(): Promise<number> {
    const state = await this.load()
    const n = state.shares.length
    state.shares = []
    await this.persist()
    return n
  }
}

export function sharePath(share: Pick<PublicShare, 'token' | 'kind'>): string {
  return share.kind === 'file'
    ? `${PUBLIC_PATH_PREFIX}${share.token}`
    : `${PUBLIC_PATH_PREFIX}${share.token}/`
}

export function shareUrl(origin: string, share: Pick<PublicShare, 'token' | 'kind'>): string {
  return `${origin.replace(/\/+$/, '')}${sharePath(share)}`
}

function sanitizeName(raw: unknown, fallback: string): string {
  const text =
    typeof raw === 'string'
      ? raw
          // eslint-disable-next-line no-control-regex
          .replace(/[\x00-\x1f\x7f]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, NAME_MAX)
      : ''
  return text || fallback
}

function describeExpiry(share: PublicShare, now: number): string {
  if (share.expiresAt === null) return 'no expiry'
  const left = share.expiresAt - now
  if (left <= 0) return 'expired'
  const h = left / 3_600_000
  if (h < 1) return `expires in ${Math.max(1, Math.round(left / 60_000))} min`
  if (h < 48) return `expires in ${Math.round(h)} h`
  return `expires in ${Math.round(h / 24)} d`
}

export type PublicToolDeps = {
  store: PublicShareStore
  /** The origin links are handed out at — null while the channel is not listening. */
  publicOrigin: () => string | null
  onChange: () => void
}

function success(output: string): ToolExecutionResult {
  return { success: true, output }
}

function failure(error: string): ToolExecutionResult {
  return { success: false, error, retryable: false }
}

export function buildWebPublicCapability(deps: PublicToolDeps): {
  capability: Capability
  plugin: WolffishPlugin
} {
  const tools: SkillToolDescriptor[] = [
    {
      name: 'public_link',
      description: `Publish a file, a folder (served as a static website) or a local HTTP port (reverse-proxied) at a PUBLIC URL on this Wolffish server — one that works for anyone who has it, with NO sign-in. Everything else the Web UI serves (/files/… links, the app itself) is behind the master password, so this is THE way to hand something to a person who is not the user: a report to forward, a download for a colleague, a page or web app you built, a dashboard a client should open. The URL carries an unguessable token; knowing it is the whole permission, so share only what is meant to leave this box, and prefer an expiry for anything sensitive. Call it on your own initiative when the task implies sharing, publishing, "send this to", "a link for", "put this online", "let them download" — do not wait to be asked for a link by name — and put the returned URL in your reply. Sharing the same path or port again returns the same URL. A folder is served as a site: / is its index.html, assets resolve relatively, paths without an extension fall back to index.html for single-page apps. A port is proxied under the link's path, so the app behind it must use RELATIVE asset URLs or honour X-Forwarded-Prefix — absolute "/static/…" paths break; websockets are forwarded too. Pass EITHER path OR port.`,
      parameters: {
        path: {
          type: 'string',
          description:
            'The file or folder to publish — absolute, ~/…, or relative to the workspace (e.g. files/report.pdf, files/site). Symlinks are resolved. Omit when publishing a port.',
          required: false
        },
        port: {
          type: 'number',
          description:
            'A local HTTP server on this machine (127.0.0.1:<port>) to expose — a dev server, a dashboard, an app you started. Omit when publishing a path.',
          required: false
        },
        name: {
          type: 'string',
          description:
            'A short label for the panel and the link list — "Q3 report", "Portfolio site". Defaults to the file or folder name.',
          required: false
        },
        expires: {
          type: 'string',
          description:
            'How long the link stays live: "30m", "2h", "7d", "2w" or "never" (default). Expired links answer 404. Give sensitive material an expiry.',
          required: false
        },
        download: {
          type: 'boolean',
          description:
            'Files only: true makes the browser save the file instead of showing it. Default false (a PDF, image or page opens in the browser; the link also accepts ?download=1).',
          required: false
        }
      }
    },
    {
      name: 'public_links',
      readOnly: true,
      description:
        'List every public link currently live on this server — id, URL, what it serves, how many times it was opened, when it expires. Use it before publishing to reuse a link, and to audit what is exposed.',
      parameters: {}
    },
    {
      name: 'public_unlink',
      description:
        'Revoke a public link by id (from public_links or the public_link result) or "all". From the next request on the URL answers 404; the file or folder itself is untouched. Revoke a link when the user asks, when the task that needed it is over, or when what it serves should no longer be public.',
      parameters: {
        id: {
          type: 'string',
          description: 'The link id, its full URL, or "all".',
          required: true
        }
      }
    }
  ]

  const capability: Capability = {
    name: WEB_PUBLIC_CAPABILITY_NAME,
    dir: '<in-process>',
    description: `Public links on this Wolffish server: public_link publishes a file, a folder as a static site, or a local port as a reverse proxy at an unguessable URL that needs NO sign-in — the way to hand something to anyone who is not the user. public_links lists them, public_unlink revokes. Present only while the Web UI is listening.`,
    triggers: {
      keywords: [
        'public link',
        'share',
        'publish',
        'download link',
        'host',
        'website',
        'expose',
        'url for',
        'send this to'
      ]
    },
    tools,
    body: '',
    hasPlugin: true,
    status: 'ok',
    requires: [],
    packages: {},
    npmDependencies: {}
  }

  const plugin: WolffishPlugin = {
    name: WEB_PUBLIC_CAPABILITY_NAME,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: toJsonSchema(t.parameters)
    })),
    execute: async (toolName, args) => {
      if (toolName === 'public_link') return publicLink(deps, args)
      if (toolName === 'public_links') return publicLinks(deps)
      if (toolName === 'public_unlink') return publicUnlink(deps, args)
      return failure(`unknown web-public tool: ${toolName}`)
    }
  }

  return { capability, plugin }
}

function describeShare(share: PublicShare, origin: string, now: number): string {
  const what =
    share.kind === 'proxy'
      ? `proxy → 127.0.0.1:${share.port}`
      : share.kind === 'site'
        ? `site ← ${share.path}`
        : `file ← ${share.path}${share.download ? ' (download)' : ''}`
  return `${share.id}  ${shareUrl(origin, share)}  "${share.name}"  ${what}  ${share.hits} open${share.hits === 1 ? '' : 's'}  ${describeExpiry(share, now)}`
}

async function publicLink(
  deps: PublicToolDeps,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const origin = deps.publicOrigin()
  if (!origin)
    return failure(
      'the Web UI is not listening right now, so there is no public address to publish at — check channel_status, or ask the user to turn the Web UI on'
    )
  const rawPath = typeof args.path === 'string' ? args.path.trim() : ''
  const rawPort = args.port
  const port =
    typeof rawPort === 'number'
      ? rawPort
      : typeof rawPort === 'string' && rawPort.trim()
        ? Number(rawPort)
        : null
  if (rawPath && port !== null)
    return failure('invalid argument: pass either path or port, not both')
  if (!rawPath && port === null) return failure('invalid argument: path or port is required')
  const ttl = expiryToMs(args.expires)
  if (ttl !== null && typeof ttl === 'object') return failure(`invalid argument: ${ttl.error}`)
  const download = args.download === true || args.download === 'true'
  const conversationId = turnScope.getStore()?.conversationId ?? null

  let created: { share: PublicShare; existed: boolean }
  if (port !== null) {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return failure(
        `invalid argument: port must be an integer between 1 and 65535 — got ${String(rawPort)}`
      )
    created = await deps.store.create({
      kind: 'proxy',
      path: null,
      port,
      name: sanitizeName(args.name, `port ${port}`),
      download: false,
      ttlMs: ttl,
      conversationId
    })
  } else {
    const resolved = await resolveSharePath(rawPath)
    if (!resolved.ok) return failure(resolved.error)
    created = await deps.store.create({
      kind: resolved.kind,
      path: resolved.path,
      port: null,
      name: sanitizeName(args.name, path.basename(resolved.path)),
      download: resolved.kind === 'file' && download,
      ttlMs: ttl,
      conversationId
    })
  }
  deps.onChange()
  const { share, existed } = created
  const url = shareUrl(origin, share)
  const lines = [
    `${existed ? 'Already public — same link' : 'Published'}: ${url}`,
    `id ${share.id} · ${share.kind} · "${share.name}" · ${describeExpiry(share, Date.now())}`
  ]
  if (share.kind === 'file')
    lines.push(
      share.download
        ? 'Opens as a download. Without the attachment: not available for this link — publish again with download=false.'
        : `Opens in the browser; ${url}?download=1 forces a download.`
    )
  if (share.kind === 'site')
    lines.push(
      'Served as a static site: / is index.html, every file under the folder is reachable by its relative path, extension-less paths fall back to index.html.'
    )
  if (share.kind === 'proxy')
    lines.push(
      `Requests are forwarded to http://127.0.0.1:${share.port} with the link path stripped and X-Forwarded-Prefix=${sharePath(share).replace(/\/$/, '')}. The app must use relative asset URLs (or honour that prefix) — absolute /… paths break behind the proxy. Verify once by fetching the link.`
    )
  lines.push(
    'Anyone with this URL can open it — no sign-in. Revoke with public_unlink when it should stop.'
  )
  return success(lines.join('\n'))
}

async function publicLinks(deps: PublicToolDeps): Promise<ToolExecutionResult> {
  const shares = await deps.store.list()
  const origin = deps.publicOrigin() ?? ''
  if (shares.length === 0) return success('No public links are live.')
  const now = Date.now()
  return success(
    [
      `${shares.length} public link${shares.length === 1 ? '' : 's'}:`,
      ...shares.map((s) => describeShare(s, origin, now))
    ].join('\n')
  )
}

async function publicUnlink(
  deps: PublicToolDeps,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const raw = typeof args.id === 'string' ? args.id.trim() : ''
  if (!raw) return failure('invalid argument: id is required (a link id, its URL, or "all")')
  if (raw === 'all') {
    const n = await deps.store.revokeAll()
    deps.onChange()
    return success(
      n === 0 ? 'No public links were live.' : `Revoked ${n} public link${n === 1 ? '' : 's'}.`
    )
  }
  const m = /\/p\/([A-Za-z0-9_-]+)\/?/.exec(raw)
  const key = m ? m[1] : raw
  const share = await deps.store.revoke(key)
  if (!share) return failure(`no public link matches "${raw}" — public_links shows what is live`)
  deps.onChange()
  return success(`Revoked ${share.id} ("${share.name}") — ${sharePath(share)} now answers 404.`)
}

function toJsonSchema(parameters: SkillToolDescriptor['parameters']): {
  type: 'object'
  properties: Record<string, { type: string; description: string; enum?: string[] }>
  required: string[]
} {
  const properties: Record<string, { type: string; description: string; enum?: string[] }> = {}
  const required: string[] = []
  for (const [name, spec] of Object.entries(parameters)) {
    properties[name] = {
      type: spec.type ?? 'string',
      description: spec.description ?? '',
      ...(spec.enum ? { enum: spec.enum } : {})
    }
    if (spec.required) required.push(name)
  }
  return { type: 'object', properties, required }
}
