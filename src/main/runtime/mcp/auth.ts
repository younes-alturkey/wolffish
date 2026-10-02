/**
 * OAuth support for remote MCP servers, built on the SDK's standard
 * client auth handshake (discovery → dynamic client registration →
 * PKCE authorization-code flow → token refresh).
 *
 * Wolffish is a public OAuth client: no client secret, PKCE only. The
 * browser handoff lands on a loopback HTTP callback whose port is
 * allocated once per server and persisted — the redirect_uri registered
 * with the authorization server must stay byte-identical across app
 * restarts or token exchanges start failing with mismatch errors.
 *
 * The provider is always fully defined (redirectUrl included) even for
 * silent background connects: the SDK's auth() consults redirectUrl
 * before its refresh branch, so an undefined redirectUrl would break
 * silent token refresh, not just interactive sign-in. What IS gated on
 * the interactive flag is the browser launch — a boot-time reconnect
 * must never pop a browser window.
 */
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import http from 'node:http'
import crypto from 'node:crypto'
import type { McpOauthState } from '@main/runtime/mcp/types'

export const CALLBACK_PATH = '/wolffish/mcp/callback'

export type OauthPersistence = {
  /** Read the server's persisted oauth state (fresh, not cached). */
  load: () => Promise<McpOauthState | undefined>
  /**
   * Merge a patch into the persisted state. Must patch strictly by
   * server id and no-op when the server record no longer exists — the
   * SDK calls save mid-connect, and a save racing a user's remove must
   * not resurrect the deleted record.
   */
  save: (patch: Partial<McpOauthState>) => Promise<void>
}

export class WolffishOAuthProvider implements OAuthClientProvider {
  /**
   * While false (silent boot/reconnect attempts), redirectToAuthorization
   * records the URL but never opens the browser. The connection's
   * authorize() flow flips it on for the duration of the interactive
   * sign-in.
   */
  interactive = false
  /** The last authorization URL the SDK asked to open. */
  lastAuthorizationUrl: string | null = null
  /** The state parameter of the in-flight flow, checked at the callback. */
  lastState: string | null = null

  private codeVerifierValue: string | null = null

  constructor(
    private readonly opts: {
      redirectPort: number
      persistence: OauthPersistence
      openExternal: (url: string) => void
    }
  ) {}

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.opts.redirectPort}${CALLBACK_PATH}`
  }

  currentPort(): number {
    return this.opts.redirectPort
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Wolffish',
      client_uri: 'https://wolffi.sh',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    }
  }

  state(): string {
    this.lastState = crypto.randomBytes(16).toString('hex')
    return this.lastState
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const stored = await this.opts.persistence.load()
    return stored?.clientInformation as OAuthClientInformationMixed | undefined
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.opts.persistence.save({
      clientInformation: clientInformation as Record<string, unknown>
    })
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const stored = await this.opts.persistence.load()
    return stored?.tokens as OAuthTokens | undefined
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.opts.persistence.save({ tokens: tokens as Record<string, unknown> })
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.lastAuthorizationUrl = authorizationUrl.toString()
    if (this.interactive) {
      this.opts.openExternal(this.lastAuthorizationUrl)
    }
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.codeVerifierValue = codeVerifier
  }

  codeVerifier(): string {
    if (!this.codeVerifierValue) {
      throw new Error('no PKCE code verifier saved for this authorization flow')
    }
    return this.codeVerifierValue
  }

  /**
   * Self-healing hook the SDK calls when the server rejects our stored
   * credentials (deleted client registration, revoked grant). Without it
   * a stale registration wedges the connection permanently.
   */
  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'
  ): Promise<void> {
    if (scope === 'verifier' || scope === 'all') this.codeVerifierValue = null
    if (scope === 'client' || scope === 'all') {
      await this.opts.persistence.save({ clientInformation: undefined })
    }
    if (scope === 'tokens' || scope === 'all') {
      await this.opts.persistence.save({ tokens: undefined })
    }
  }
}

const CALLBACK_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Wolffish</title></head>
<body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#101014;color:#e8e8ea;font-family:-apple-system,system-ui,sans-serif">
<div style="text-align:center"><div style="font-size:34px;margin-bottom:12px">🐟</div>
<div style="font-size:16px;font-weight:600;margin-bottom:6px">You're connected</div>
<div style="font-size:13px;color:#9a9aa2">You can close this tab and return to Wolffish.</div></div>
</body></html>`

const CALLBACK_ERROR_PAGE = (detail: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>Wolffish</title></head>
<body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#101014;color:#e8e8ea;font-family:-apple-system,system-ui,sans-serif">
<div style="text-align:center;max-width:420px"><div style="font-size:34px;margin-bottom:12px">🐟</div>
<div style="font-size:16px;font-weight:600;margin-bottom:6px">Sign-in didn't complete</div>
<div style="font-size:13px;color:#9a9aa2">${detail} You can close this tab and try again from Wolffish settings.</div></div>
</body></html>`

/**
 * Probe a free loopback port by binding to port 0 and closing.
 * Called once per server at first auth; the result is persisted.
 */
export function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : null
      server.close(() => {
        if (port) resolve(port)
        else reject(new Error('failed to allocate a loopback port'))
      })
    })
  })
}

export type LoopbackResult = { ok: true; code: string } | { ok: false; error: string }

/**
 * Serve the OAuth callback on 127.0.0.1:<port> until a code arrives, the
 * flow times out, or `cancel` fires. Resolves exactly once and always
 * closes the server — a leaked listener would shadow the next flow.
 */
export function waitForCallback(opts: {
  port: number
  /**
   * Getter, not a value: the SDK generates the state parameter after
   * this listener is already armed, so it's resolved at callback time.
   */
  expectedState: () => string | null
  timeoutMs: number
  onCancel?: (cancel: () => void) => void
}): Promise<LoopbackResult> {
  return new Promise((resolve) => {
    let settled = false
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${opts.port}`)
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end()
        return
      }
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      if (error) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(CALLBACK_ERROR_PAGE(`The authorization server reported: ${error}.`))
        finish({ ok: false, error })
        return
      }
      if (!code) {
        res.writeHead(400, { 'content-type': 'text/html' })
        res.end(CALLBACK_ERROR_PAGE('The callback was missing an authorization code.'))
        finish({ ok: false, error: 'authorization callback had no code' })
        return
      }
      const expected = opts.expectedState()
      if (expected && state !== expected) {
        res.writeHead(400, { 'content-type': 'text/html' })
        res.end(CALLBACK_ERROR_PAGE('The callback state did not match this sign-in attempt.'))
        finish({ ok: false, error: 'authorization callback state mismatch' })
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(CALLBACK_PAGE)
      finish({ ok: true, code })
    })
    const timer = setTimeout(() => {
      finish({ ok: false, error: 'sign-in timed out' })
    }, opts.timeoutMs)
    timer.unref()
    const finish = (result: LoopbackResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close()
      resolve(result)
    }
    opts.onCancel?.(() => finish({ ok: false, error: 'sign-in cancelled' }))
    server.once('error', (err) => {
      finish({ ok: false, error: `callback server failed: ${err.message}` })
    })
    server.listen(opts.port, '127.0.0.1')
  })
}

/**
 * Best-effort OAuth token revocation (RFC 7009) for when a remote server is
 * removed — tells the provider "forget this app" so it doesn't accumulate
 * stale "connected" entries on their side. Strictly fire-and-forget:
 * discovers the authorization server's revocation_endpoint from the same
 * metadata used to sign in, POSTs the refresh (then access) token as a
 * public client, and swallows everything. Returns whether a revocation
 * request was actually sent (for tests); callers never need the result.
 *
 * Does nothing when there are no tokens, no discoverable revocation
 * endpoint, or the network is down — removal proceeds regardless.
 */
export async function revokeTokens(
  serverUrl: string,
  oauth: McpOauthState | undefined,
  timeoutMs = 5_000
): Promise<boolean> {
  try {
    const tokens = oauth?.tokens as OAuthTokens | undefined
    if (!tokens) return false
    const clientId = (oauth?.clientInformation as { client_id?: string } | undefined)?.client_id
    if (!clientId) return false

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    const fetchFn: typeof fetch = (input, init) =>
      fetch(input, { ...init, signal: controller.signal })
    // Bounds the one discovery call that can't take our fetchFn.
    const withTimeout = <T>(p: Promise<T>): Promise<T | undefined> =>
      Promise.race([
        p.catch(() => undefined),
        new Promise<undefined>((r) => {
          const to = setTimeout(() => r(undefined), timeoutMs)
          to.unref?.()
        })
      ])
    try {
      const prm = await withTimeout(discoverOAuthProtectedResourceMetadata(serverUrl))
      const asUrl = prm?.authorization_servers?.[0] ?? new URL(serverUrl).origin
      const asMeta = await discoverAuthorizationServerMetadata(asUrl, { fetchFn }).catch(
        () => undefined
      )
      const endpoint = (asMeta as { revocation_endpoint?: string } | undefined)?.revocation_endpoint
      if (!endpoint) return false

      const revokeOne = async (token: string, hint: string): Promise<void> => {
        const body = new URLSearchParams({
          token,
          token_type_hint: hint,
          client_id: clientId
        })
        await fetchFn(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString()
        }).catch(() => undefined)
      }
      // Revoking the refresh token typically cascades to its access tokens;
      // revoke the access token too when present, for servers that don't.
      if (tokens.refresh_token) await revokeOne(tokens.refresh_token, 'refresh_token')
      if (tokens.access_token) await revokeOne(tokens.access_token, 'access_token')
      return true
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return false
  }
}
