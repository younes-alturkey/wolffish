/**
 * MCP OAuth end-to-end: drives the REAL McpConnection (real SDK client
 * transports, real WolffishOAuthProvider, real loopback callback server)
 * against a local OAuth-protected MCP server built in this file — a
 * spec-shaped authorization server (protected-resource metadata, AS
 * metadata, dynamic client registration, PKCE S256 authorization-code +
 * refresh grants) fronting a bearer-gated streamable MCP endpoint.
 *
 * The injected `openExternal` plays the user's browser, so the whole
 * button-auth flow runs unattended:
 *   1. silent boot connect  → needs-auth, NO browser, NO retry loop
 *   2. authorize()          → browser handoff → code → token → connected
 *   3. tool call            → works with the bearer token
 *   4. "restart"            → silent connect reuses persisted tokens
 *   5. expired access token → silent refresh grant, still no browser
 *
 * Standalone — no vitest/jest in this repo.
 * Run: npx tsx --tsconfig tsconfig.node.json src/main/runtime/__tests__/mcp-oauth.test.ts
 */
import Module from 'node:module'
import crypto from 'node:crypto'
import http from 'node:http'
import os from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'

// deps touch `electron.app` at import time — shim before any app import.
const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => os.tmpdir() }
    }
  }
  return origLoad.apply(this, args)
}

let passed = 0
let failed = 0

function ok(label: string, cond: boolean): void {
  if (cond) {
    passed++
  } else {
    failed++
    console.error(`FAIL ${label}`)
  }
}

function check<T>(label: string, actual: T, expected: T): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  if (same) {
    passed++
  } else {
    failed++
    console.error(
      `FAIL ${label}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`
    )
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * A minimal but spec-shaped OAuth 2.1 authorization server + bearer-gated
 * streamable MCP resource, all on one local port. Tracks counters so the
 * test can assert exactly which grants and endpoints were exercised.
 */
async function buildOAuthMcpServer(): Promise<{
  origin: string
  counters: {
    registrations: number
    authorizeHits: number
    codeGrants: number
    refreshGrants: number
    unauthorizedMcpPosts: number
    revocations: number
  }
  revokedTokens: () => string[]
  invalidateAccessTokens: () => void
  close: () => void
}> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const { StreamableHTTPServerTransport } =
    await import('@modelcontextprotocol/sdk/server/streamableHttp.js')

  const counters = {
    registrations: 0,
    authorizeHits: 0,
    codeGrants: 0,
    refreshGrants: 0,
    unauthorizedMcpPosts: 0,
    revocations: 0
  }
  const revoked: string[] = []
  const clients = new Map<string, { redirectUris: string[] }>()
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>()
  const validAccess = new Set<string>()
  const validRefresh = new Set<string>()
  const transports = new Map<string, InstanceType<typeof StreamableHTTPServerTransport>>()

  let origin = ''

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', origin)
      const path = url.pathname

      // --- discovery -----------------------------------------------------
      if (path.startsWith('/.well-known/oauth-protected-resource')) {
        return json(res, 200, {
          resource: `${origin}/mcp`,
          authorization_servers: [origin]
        })
      }
      if (path.startsWith('/.well-known/oauth-authorization-server')) {
        return json(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          revocation_endpoint: `${origin}/revoke`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none']
        })
      }

      // --- dynamic client registration ------------------------------------
      if (path === '/register' && req.method === 'POST') {
        counters.registrations++
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>
        const clientId = `client-${crypto.randomBytes(6).toString('hex')}`
        clients.set(clientId, { redirectUris: (body.redirect_uris as string[]) ?? [] })
        return json(res, 201, {
          client_id: clientId,
          redirect_uris: body.redirect_uris,
          grant_types: body.grant_types,
          response_types: body.response_types,
          token_endpoint_auth_method: 'none',
          client_name: body.client_name
        })
      }

      // --- authorization endpoint (the "browser" page) ---------------------
      if (path === '/authorize' && req.method === 'GET') {
        counters.authorizeHits++
        const clientId = url.searchParams.get('client_id') ?? ''
        const redirectUri = url.searchParams.get('redirect_uri') ?? ''
        const challenge = url.searchParams.get('code_challenge') ?? ''
        const state = url.searchParams.get('state') ?? ''
        const client = clients.get(clientId)
        if (
          url.searchParams.get('response_type') !== 'code' ||
          !client ||
          !client.redirectUris.includes(redirectUri) ||
          !challenge ||
          url.searchParams.get('code_challenge_method') !== 'S256'
        ) {
          return json(res, 400, { error: 'invalid_request' })
        }
        const code = `code-${crypto.randomBytes(8).toString('hex')}`
        codes.set(code, { challenge, redirectUri, clientId })
        const target = new URL(redirectUri)
        target.searchParams.set('code', code)
        if (state) target.searchParams.set('state', state)
        res.writeHead(302, { location: target.toString() })
        return res.end()
      }

      // --- token endpoint ---------------------------------------------------
      if (path === '/token' && req.method === 'POST') {
        const params = new URLSearchParams(await readBody(req))
        const grant = params.get('grant_type')
        if (grant === 'authorization_code') {
          const code = params.get('code') ?? ''
          const verifier = params.get('code_verifier') ?? ''
          const stored = codes.get(code)
          if (!stored) return json(res, 400, { error: 'invalid_grant' })
          const hashed = crypto.createHash('sha256').update(verifier).digest('base64url')
          if (hashed !== stored.challenge) {
            return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE mismatch' })
          }
          if ((params.get('redirect_uri') ?? '') !== stored.redirectUri) {
            return json(res, 400, {
              error: 'invalid_grant',
              error_description: 'redirect mismatch'
            })
          }
          codes.delete(code)
          counters.codeGrants++
          const access = `at-${crypto.randomBytes(12).toString('hex')}`
          const refresh = `rt-${crypto.randomBytes(12).toString('hex')}`
          validAccess.add(access)
          validRefresh.add(refresh)
          return json(res, 200, {
            access_token: access,
            token_type: 'bearer',
            expires_in: 3600,
            refresh_token: refresh
          })
        }
        if (grant === 'refresh_token') {
          const refresh = params.get('refresh_token') ?? ''
          if (!validRefresh.has(refresh)) return json(res, 400, { error: 'invalid_grant' })
          counters.refreshGrants++
          const access = `at-${crypto.randomBytes(12).toString('hex')}`
          validAccess.add(access)
          return json(res, 200, {
            access_token: access,
            token_type: 'bearer',
            expires_in: 3600,
            refresh_token: refresh
          })
        }
        return json(res, 400, { error: 'unsupported_grant_type' })
      }

      // --- revocation endpoint (RFC 7009) ----------------------------------
      if (path === '/revoke' && req.method === 'POST') {
        counters.revocations++
        const params = new URLSearchParams(await readBody(req))
        const token = params.get('token') ?? ''
        if (token) {
          revoked.push(token)
          validAccess.delete(token)
          validRefresh.delete(token)
        }
        // RFC 7009: always 200, even for unknown tokens.
        res.writeHead(200)
        return res.end()
      }

      // --- the bearer-gated MCP resource ------------------------------------
      if (path === '/mcp') {
        const authz = req.headers.authorization ?? ''
        const token = authz.startsWith('Bearer ') ? authz.slice(7) : ''
        if (!validAccess.has(token)) {
          if (req.method === 'POST') counters.unauthorizedMcpPosts++
          res.writeHead(401, {
            'content-type': 'application/json',
            'www-authenticate': `Bearer realm="mcp", error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource"`
          })
          return res.end(JSON.stringify({ error: 'unauthorized' }))
        }
        const sessionId = req.headers['mcp-session-id'] as string | undefined
        if (sessionId && transports.has(sessionId)) {
          const body = req.method === 'POST' ? JSON.parse(await readBody(req)) : undefined
          return transports.get(sessionId)!.handleRequest(req, res, body)
        }
        if (req.method === 'POST') {
          // New session (initialize).
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (id: string) => {
              transports.set(id, transport)
            }
          })
          const mcp = new McpServer({ name: 'Guarded Test Server', version: '1.0.0' })
          mcp.registerTool(
            'secret_echo',
            { description: 'Echo back proof of access' },
            async () => ({
              content: [{ type: 'text', text: 'access granted' }]
            })
          )
          await mcp.connect(transport)
          const body = JSON.parse(await readBody(req))
          return transport.handleRequest(req, res, body)
        }
        res.writeHead(400)
        return res.end()
      }

      res.writeHead(404)
      res.end()
    })().catch(() => {
      try {
        res.writeHead(500)
        res.end()
      } catch {
        // response already sent
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  origin = `http://127.0.0.1:${port}`

  return {
    origin,
    counters,
    revokedTokens: () => [...revoked],
    invalidateAccessTokens: () => validAccess.clear(),
    close: () => {
      server.closeAllConnections?.()
      server.close()
    }
  }
}

async function run(): Promise<void> {
  const { McpConnection } = await import('@main/runtime/mcp/connection')
  const authServer = await buildOAuthMcpServer()
  const { origin, counters } = authServer

  // In-memory persistence with patchMcpServerOauth's merge/delete semantics
  // — shared across connection instances to simulate app restarts.
  const persisted: Record<string, unknown> = {}
  const persistence = {
    load: async () => persisted as never,
    save: async (patch: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete persisted[k]
        else persisted[k] = v
      }
    }
  }

  // The fake browser: follow the authorization redirect back to Wolffish's
  // loopback callback, exactly as a user approving in their browser would.
  const browserVisits: string[] = []
  let lastCallbackUrl: string | null = null
  const openExternal = (url: string): void => {
    browserVisits.push(url)
    void (async () => {
      const authRes = await fetch(url, { redirect: 'manual' })
      const location = authRes.headers.get('location')
      if (location) {
        lastCallbackUrl = location
        await fetch(location)
      }
    })()
  }

  const makeConnection = (
    id: string,
    registered: { count: number }
  ): InstanceType<typeof McpConnection> =>
    new McpConnection({
      config: {
        id,
        name: 'Guarded',
        slug: 'guarded',
        transport: 'http',
        url: `${origin}/mcp`,
        enabled: true
      },
      appVersion: '0.0.0-test',
      register: () => {
        registered.count++
      },
      unregister: () => {},
      notify: () => {},
      openExternal,
      oauthPersistence: persistence as never,
      saveRedirectPort: async (port) => {
        await persistence.save({ redirectPort: port })
      },
      backoffInitialMs: 30
    })

  // ------------------------------------------------ 1. silent boot connect
  const reg1 = { count: 0 }
  const conn = makeConnection('oauth-1', reg1)
  conn.start()
  let snap = conn.snapshot()
  for (let i = 0; i < 100 && snap.state !== 'needs-auth'; i++) {
    await sleep(20)
    snap = conn.snapshot()
  }
  check('silent connect lands in needs-auth', snap.state, 'needs-auth')
  ok('silent connect never opened a browser', browserVisits.length === 0)
  ok('dynamic client registration happened once', counters.registrations === 1)
  ok('client registration was persisted', persisted.clientInformation !== undefined)
  const postsAtNeedsAuth = counters.unauthorizedMcpPosts
  await sleep(400)
  ok(
    'needs-auth does not retry in the background',
    counters.unauthorizedMcpPosts === postsAtNeedsAuth
  )

  // ------------------------------------------------ 2. interactive sign-in
  const authResult = await conn.authorize()
  ok('authorize() succeeds end-to-end', authResult.ok === true)
  ok('the browser was opened exactly once', browserVisits.length === 1)
  ok(
    'the browser URL was the AS authorize endpoint',
    browserVisits[0]!.startsWith(`${origin}/authorize?`)
  )
  ok(
    'the AS redirected to the Wolffish loopback callback',
    /^http:\/\/127\.0\.0\.1:\d+\/wolffish\/mcp\/callback\?/.test(lastCallbackUrl ?? '')
  )
  ok('PKCE code grant was exchanged once', counters.codeGrants === 1)
  ok('tokens were persisted', persisted.tokens !== undefined)
  ok('no second client registration (reused persisted one)', counters.registrations === 1)
  check('connection is connected after sign-in', conn.snapshot().state, 'connected')
  ok(
    'the guarded tools were discovered + registered',
    reg1.count === 1 && conn.snapshot().toolCount === 1
  )

  // ------------------------------------------------ 3. authenticated tool call
  const call = await (
    conn as unknown as {
      proxyCall: (
        n: string,
        a: Record<string, unknown>
      ) => Promise<{ success: boolean; output?: string }>
    }
  ).proxyCall('secret_echo', {})
  ok(
    'tool call works with the bearer token',
    call.success === true && call.output === 'access granted'
  )
  await conn.stop()

  // ------------------------------------------------ 4. restart with tokens
  const reg2 = { count: 0 }
  const conn2 = makeConnection('oauth-2', reg2)
  conn2.start()
  snap = conn2.snapshot()
  for (let i = 0; i < 100 && snap.state !== 'connected'; i++) {
    await sleep(20)
    snap = conn2.snapshot()
  }
  check('restart: silent connect with persisted tokens', snap.state, 'connected')
  ok('restart: no browser involved', browserVisits.length === 1)
  ok('restart: no new code grant', counters.codeGrants === 1)
  await conn2.stop()

  // ------------------------------------------------ 5. expired token → refresh
  authServer.invalidateAccessTokens()
  const reg3 = { count: 0 }
  const conn3 = makeConnection('oauth-3', reg3)
  conn3.start()
  snap = conn3.snapshot()
  for (let i = 0; i < 150 && snap.state !== 'connected'; i++) {
    await sleep(20)
    snap = conn3.snapshot()
  }
  check('expired access token: reconnects via silent refresh', snap.state, 'connected')
  ok('refresh grant was used exactly once', counters.refreshGrants === 1)
  ok('refresh: still no browser', browserVisits.length === 1)
  ok('refresh: no new authorization round', counters.authorizeHits === 1)
  const refreshedCall = await (
    conn3 as unknown as {
      proxyCall: (
        n: string,
        a: Record<string, unknown>
      ) => Promise<{ success: boolean; output?: string }>
    }
  ).proxyCall('secret_echo', {})
  ok('tool call works after refresh', refreshedCall.success === true)
  await conn3.stop()

  // ------------------------------------------------ 6. revoke on remove
  const { revokeTokens } = await import('@main/runtime/mcp/auth')
  const stored = persisted.tokens as { refresh_token?: string; access_token?: string } | undefined
  const sent = await revokeTokens(`${origin}/mcp`, {
    tokens: persisted.tokens as never,
    clientInformation: persisted.clientInformation as never
  })
  ok('revokeTokens reports a revocation was sent', sent === true)
  ok('provider recorded the revocation request(s)', counters.revocations >= 1)
  ok(
    'the refresh token was the one revoked',
    !!stored?.refresh_token && authServer.revokedTokens().includes(stored.refresh_token)
  )
  // Safe no-op when there's nothing to revoke — never throws.
  const noneSent = await revokeTokens(`${origin}/mcp`, undefined)
  ok('revokeTokens is a safe no-op with no tokens', noneSent === false)
  const unreachable = await revokeTokens('http://127.0.0.1:1/mcp', {
    tokens: { access_token: 'x', token_type: 'bearer' } as never,
    clientInformation: { client_id: 'c' } as never
  })
  ok('revokeTokens swallows an unreachable provider', unreachable === false)

  authServer.close()
  console.log(`${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

void run().catch((err) => {
  console.error('test harness crashed:', err)
  process.exit(1)
})
