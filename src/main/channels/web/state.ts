/**
 * What the Web UI remembers between visits: the signed-in browsers and their
 * push subscriptions. One JSON file under the workspace, written atomically,
 * separate from config.json because it changes on every visit and holds
 * nothing a user would want to hand-edit.
 *
 * A session is a browser that has typed the master password once. Its cookie
 * carries a random token; only the token's SHA-256 is stored here, so the file
 * itself grants nothing. Sessions slide: each visit extends them, and one that
 * has not been seen for a year expires. Logging out deletes the session and
 * every push subscription registered under it — a signed-out browser must not
 * keep receiving the agent's notifications.
 */
import { diskWriter } from '@main/io/diskWriter'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { mintSessionToken } from '@main/channels/web/auth'

export type WebSession = {
  /** Public id, safe to show in the panel and to revoke by. */
  id: string
  /** SHA-256 (hex) of the cookie token. */
  tokenHash: string
  createdAt: number
  lastSeenAt: number
  userAgent: string
  address: string
}

export type PushSubscriptionRecord = {
  id: string
  sessionId: string
  endpoint: string
  keys: { p256dh: string; auth: string }
  userAgent: string
  createdAt: number
}

type WebState = {
  version: 1
  sessions: WebSession[]
  subscriptions: PushSubscriptionRecord[]
}

/** Sliding expiry — a browser not seen for this long has to sign in again. */
export const SESSION_TTL_MS = 365 * 24 * 60 * 60_000
/** lastSeenAt is written at most this often per session, not on every frame. */
const TOUCH_INTERVAL_MS = 5 * 60_000

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export class WebStateStore {
  private state: WebState | null = null
  private loading: Promise<WebState> | null = null
  private writes: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now
  ) {}

  private async load(): Promise<WebState> {
    if (this.state) return this.state
    if (!this.loading) {
      this.loading = (async () => {
        let parsed: Partial<WebState> | null = null
        try {
          parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<WebState>
        } catch {
          parsed = null
        }
        const state: WebState = {
          version: 1,
          sessions: Array.isArray(parsed?.sessions) ? parsed.sessions : [],
          subscriptions: Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : []
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

  /** Expired sessions go, and the subscriptions that belonged to them with them. */
  private sweep(state: WebState): boolean {
    const t = this.now()
    const before = state.sessions.length + state.subscriptions.length
    state.sessions = state.sessions.filter((s) => t - s.lastSeenAt < SESSION_TTL_MS)
    const live = new Set(state.sessions.map((s) => s.id))
    state.subscriptions = state.subscriptions.filter((p) => live.has(p.sessionId))
    return state.sessions.length + state.subscriptions.length !== before
  }

  async createSession(meta: { userAgent: string; address: string }): Promise<{
    token: string
    session: WebSession
  }> {
    const state = await this.load()
    const token = mintSessionToken()
    const t = this.now()
    const session: WebSession = {
      id: randomBytes(6).toString('hex'),
      tokenHash: hashSessionToken(token),
      createdAt: t,
      lastSeenAt: t,
      userAgent: meta.userAgent.slice(0, 300),
      address: meta.address
    }
    state.sessions.push(session)
    this.sweep(state)
    await this.persist()
    return { token, session }
  }

  /**
   * The session a cookie token names, or null. A hit refreshes lastSeenAt
   * (throttled) so the sliding expiry sees activity without a disk write per
   * request.
   */
  async resolveSession(token: string | null | undefined): Promise<WebSession | null> {
    if (!token || typeof token !== 'string' || token.length > 512) return null
    const state = await this.load()
    const hash = hashSessionToken(token)
    const session = state.sessions.find((s) => s.tokenHash === hash) ?? null
    if (!session) return null
    const t = this.now()
    if (t - session.lastSeenAt >= SESSION_TTL_MS) {
      await this.revokeSession(session.id)
      return null
    }
    if (t - session.lastSeenAt >= TOUCH_INTERVAL_MS) {
      session.lastSeenAt = t
      void this.persist()
    }
    return session
  }

  async revokeSession(id: string): Promise<void> {
    const state = await this.load()
    state.sessions = state.sessions.filter((s) => s.id !== id)
    state.subscriptions = state.subscriptions.filter((p) => p.sessionId !== id)
    await this.persist()
  }

  async revokeAllSessions({ except }: { except?: string } = {}): Promise<void> {
    const state = await this.load()
    state.sessions = state.sessions.filter((s) => except !== undefined && s.id === except)
    state.subscriptions = state.subscriptions.filter(
      (p) => except !== undefined && p.sessionId === except
    )
    await this.persist()
  }

  async listSessions(): Promise<WebSession[]> {
    const state = await this.load()
    if (this.sweep(state)) void this.persist()
    return state.sessions.map((s) => ({ ...s }))
  }

  /** One subscription per endpoint; a re-subscribe from the same browser replaces it. */
  async upsertSubscription(input: {
    sessionId: string
    endpoint: string
    keys: { p256dh: string; auth: string }
    userAgent: string
  }): Promise<PushSubscriptionRecord> {
    const state = await this.load()
    const existing = state.subscriptions.find((p) => p.endpoint === input.endpoint)
    const record: PushSubscriptionRecord = {
      id: existing?.id ?? randomBytes(6).toString('hex'),
      sessionId: input.sessionId,
      endpoint: input.endpoint,
      keys: { p256dh: input.keys.p256dh, auth: input.keys.auth },
      userAgent: input.userAgent.slice(0, 300),
      createdAt: existing?.createdAt ?? this.now()
    }
    state.subscriptions = [
      ...state.subscriptions.filter((p) => p.endpoint !== input.endpoint),
      record
    ]
    await this.persist()
    return record
  }

  async removeSubscription(endpoint: string): Promise<void> {
    const state = await this.load()
    const before = state.subscriptions.length
    state.subscriptions = state.subscriptions.filter((p) => p.endpoint !== endpoint)
    if (state.subscriptions.length !== before) await this.persist()
  }

  async listSubscriptions(): Promise<PushSubscriptionRecord[]> {
    const state = await this.load()
    return state.subscriptions.map((p) => ({ ...p, keys: { ...p.keys } }))
  }
}
