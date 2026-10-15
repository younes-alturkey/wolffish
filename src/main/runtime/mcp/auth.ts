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
 *
 * A sign-in started from the Web UI cannot use the loopback: the consent
 * page opens in a browser that may be on another machine, and its
 * redirect has to land where that browser can reach — the Web UI's own
 * origin, on the same callback path. For the length of that flow the
 * provider's redirectUrl is overridden with that URL, the authorization
 * URL is handed back instead of opened here, and the code arrives
 * through the web server (`createRelayCallback`) rather than a loopback
 * listener. Every redirect URI a flow uses must be in the client's
 * registration, so the registration is redone — with the longer list —
 * the first time a flow brings a redirect the stored one lacks.
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
import type { McpAuthCallbackParams, McpOauthState } from '@main/runtime/mcp/types'

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
  /**
   * A browser-started flow's redirect — the Web UI's callback — for the
   * length of that flow; null means the loopback.
   */
  redirectOverride: string | null = null
  /**
   * Where a browser-started flow's authorization URL goes instead of
   * the system browser: back to the browser that asked.
   */
  onAuthorizationUrl: ((url: string) => void) | null = null

  private codeVerifierValue: string | null = null
  /** The redirect URIs of the stored registration, refreshed on every read of it. */
  private knownRedirectUris: string[] = []

  constructor(
    private readonly opts: {
      redirectPort: number
      persistence: OauthPersistence
      openExternal: (url: string) => void
    }
  ) {}

  get loopbackRedirectUrl(): string {
    return `http://127.0.0.1:${this.opts.redirectPort}${CALLBACK_PATH}`
  }

  get redirectUrl(): string {
    return this.redirectOverride ?? this.loopbackRedirectUrl
  }

  currentPort(): number {
    return this.opts.redirectPort
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Wolffish',
      client_uri: 'https://github.com/younes-alturkey/wolffish',
      redirect_uris: this.redirectUrisToRegister(),
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    }
  }

  state(): string {
    this.lastState = crypto.randomBytes(16).toString('hex')
    return this.lastState
  }

  /**
   * Every redirect this client has registered plus the one this flow
   * needs, loopback first. The list only grows, so a browser at a second
   * origin does not throw the first one's registration away.
   */
  private redirectUrisToRegister(): string[] {
    return [...new Set([this.loopbackRedirectUrl, ...this.knownRedirectUris, this.redirectUrl])]
  }

  /**
   * The stored registration — unless it was made without this flow's
   * redirect URI, in which case there is none: the SDK registers again
   * with the longer list. The tokens go with it, they belong to the old
   * client_id, and this only happens on the way into an interactive
   * sign-in that replaces them anyway (silent connects use the
   * loopback, which every registration has).
   */
  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const stored = await this.opts.persistence.load()
    const info = stored?.clientInformation as OAuthClientInformationMixed | undefined
    if (!info) return undefined
    const registered = stored?.redirectUris ?? [this.loopbackRedirectUrl]
    this.knownRedirectUris = registered
    if (!registered.includes(this.redirectUrl)) {
      await this.opts.persistence.save({ clientInformation: undefined, tokens: undefined })
      return undefined
    }
    return info
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    const redirectUris = this.redirectUrisToRegister()
    this.knownRedirectUris = redirectUris
    await this.opts.persistence.save({
      clientInformation: clientInformation as Record<string, unknown>,
      redirectUris
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
    if (!this.interactive) return
    if (this.onAuthorizationUrl) this.onAuthorizationUrl(this.lastAuthorizationUrl)
    else this.opts.openExternal(this.lastAuthorizationUrl)
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
      this.knownRedirectUris = []
      await this.opts.persistence.save({ clientInformation: undefined, redirectUris: undefined })
    }
    if (scope === 'tokens' || scope === 'all') {
      await this.opts.persistence.save({ tokens: undefined })
    }
  }
}

const PAGE_STYLE =
  'margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#101014;color:#e8e8ea;font-family:-apple-system,system-ui,sans-serif'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The page the browser lands on after the authorization server sends it
 * back. The loopback shows the "close this tab" line; the Web UI, which
 * has somewhere to go, adds a way back to its settings.
 */
export function renderCallbackPage(
  outcome: { ok: true } | { ok: false; detail: string },
  backHref: string | null = null
): string {
  const back = backHref
    ? `<a href="${escapeHtml(backHref)}" style="display:inline-block;margin-top:18px;padding:8px 14px;border-radius:8px;background:#2a2a32;color:#e8e8ea;text-decoration:none;font-size:13px">Back to Wolffish</a>`
    : ''
  const body = outcome.ok
    ? `<div style="font-size:16px;font-weight:600;margin-bottom:6px">You're connected</div>
<div style="font-size:13px;color:#9a9aa2">You can close this tab and return to Wolffish.</div>`
    : `<div style="font-size:16px;font-weight:600;margin-bottom:6px">Sign-in didn't complete</div>
<div style="font-size:13px;color:#9a9aa2">${escapeHtml(outcome.detail)} You can close this tab and try again from Wolffish settings.</div>`
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wolffish</title></head>
<body style="${PAGE_STYLE}">
<div style="text-align:center;max-width:420px;padding:0 24px"><div style="font-size:34px;margin-bottom:12px">🐟</div>
${body}${back}</div>
</body></html>`
}

const CALLBACK_PAGE = renderCallbackPage({ ok: true })
const CALLBACK_ERROR_PAGE = (detail: string): string => renderCallbackPage({ ok: false, detail })

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
 * The Web UI's stand-in for the loopback listener: the same promise, fed
 * by `deliver` when the web server's callback route sees the browser
 * come back. Only a callback carrying this flow's state is taken — a
 * stray hit on a public route must not cancel a sign-in in progress, so
 * anything else is reported as unmatched and leaves the flow waiting.
 */
export type RelayCallback = {
  result: Promise<LoopbackResult>
  /** True when the callback belonged to this flow and settled it. */
  deliver: (params: McpAuthCallbackParams) => boolean
  cancel: () => void
}

export function createRelayCallback(opts: {
  expectedState: () => string | null
  timeoutMs: number
}): RelayCallback {
  let settled = false
  let finish: (result: LoopbackResult) => void = () => undefined
  const result = new Promise<LoopbackResult>((resolve) => {
    const timer = setTimeout(
      () => finish({ ok: false, error: 'sign-in timed out' }),
      opts.timeoutMs
    )
    timer.unref()
    finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
  })
  return {
    result,
    deliver: (params) => {
      if (settled) return false
      const expected = opts.expectedState()
      if (!expected || params.state !== expected) return false
      if (params.error) finish({ ok: false, error: params.error })
      else if (!params.code) finish({ ok: false, error: 'authorization callback had no code' })
      else finish({ ok: true, code: params.code })
      return true
    },
    cancel: () => finish({ ok: false, error: 'sign-in cancelled' })
  }
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
