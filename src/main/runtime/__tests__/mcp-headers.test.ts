/**
 * MCP custom-header tests: a REAL streamable-HTTP MCP server behind an
 * `x-api-key` guard, driven through McpConnection over actual sockets.
 *
 * Covers the whole feature contract:
 * - headers ride every request (connect + tools/list), so a correct
 *   key connects outright with ZERO OAuth activity — no metadata
 *   discovery, no browser;
 * - a missing/wrong key degrades to needs-auth exactly like before;
 * - a live setHeaders() on a needs-auth connection reconnects straight
 *   to connected, still without entering the sign-in flow;
 * - manager-level sanitizeHeaders behavior via McpManager.add validation.
 *
 * Standalone — no vitest/jest in this repo.
 * Run: npx tsx --tsconfig tsconfig.node.json src/main/runtime/__tests__/mcp-headers.test.ts
 */
import Module from 'node:module'
import os from 'node:os'

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

async function main(): Promise<void> {
  const http = await import('node:http')
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const { StreamableHTTPServerTransport } =
    await import('@modelcontextprotocol/sdk/server/streamableHttp.js')
  const { z } = await import('zod')
  const { McpConnection } = await import('@main/runtime/mcp/connection')
  type McpHeader = import('@main/runtime/mcp/types').McpHeader

  let oauthDiscoveryHits = 0
  let browserOpens = 0

  // ---- the guarded MCP server ---------------------------------------
  // Stateless streamable-HTTP: a FRESH McpServer + transport per request
  // (a shared stateless transport rejects the second initialize).
  const guard = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    // A real OAuth-capable server: metadata + registration are public,
    // so a headerless 401 walks the SDK's silent auth to the redirect
    // step and parks in needs-auth (the pre-headers behavior).
    if (path.startsWith('/.well-known/')) {
      oauthDiscoveryHits++
      if (path === '/.well-known/oauth-authorization-server') {
        const base = `http://127.0.0.1:${port}`
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            registration_endpoint: `${base}/register`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none']
          })
        )
        return
      }
      res.writeHead(404).end()
      return
    }
    if (path === '/register') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ...JSON.parse(body || '{}'), client_id: 'test-client' }))
      })
      return
    }
    // Two accepted credentials: the API key, or EXACTLY the user's PAT.
    // A stored stale OAuth token that merged into the Authorization
    // header ("Bearer stale, Bearer good-token") fails this check, so
    // the override contract is what these tests actually discriminate.
    const authed =
      req.headers['x-api-key'] === 'sesame' || req.headers['authorization'] === 'Bearer good-token'
    if (!authed) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'missing or bad credentials' }))
      return
    }
    const mcp = new McpServer({ name: 'Guarded', version: '1.0.0' })
    mcp.registerTool(
      'echo',
      { description: 'Echo text back', inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: 'text' as const, text }] })
    )
    const serverTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void serverTransport.close()
      void mcp.close()
    })
    void mcp.connect(serverTransport).then(() => serverTransport.handleRequest(req, res))
  })
  await new Promise<void>((resolve) => guard.listen(0, '127.0.0.1', resolve))
  const address = guard.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const url = `http://127.0.0.1:${port}/mcp`

  /** Poll a condition — setHeaders() reconnects in the background. */
  const waitFor = async (cond: () => boolean, ms = 10_000): Promise<boolean> => {
    const start = Date.now()
    while (Date.now() - start < ms) {
      if (cond()) return true
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return cond()
  }

  // The most recently registered capability plugin — lets the test
  // drive a REAL namespaced tool call end-to-end through proxyCall,
  // proving the custom header rides tools/call POSTs too.
  type RegisteredPlugin = {
    execute: (
      toolName: string,
      args: Record<string, unknown>
    ) => Promise<{ success: boolean; output?: string; error?: string }>
  }
  let lastPlugin: RegisteredPlugin | null = null

  const makeConnection = (
    headers?: McpHeader[],
    initialOauth?: Record<string, unknown>
  ): InstanceType<typeof McpConnection> => {
    let oauthState: Record<string, unknown> = initialOauth ?? {}
    return new McpConnection({
      config: {
        id: 'hdr-1',
        name: 'Guarded',
        slug: 'guarded',
        transport: 'http',
        url,
        headers,
        enabled: true
      },
      appVersion: '0.0.0-test',
      register: (_capability, plugin) => {
        lastPlugin = plugin as unknown as RegisteredPlugin
      },
      unregister: () => {},
      notify: () => {},
      openExternal: () => {
        browserOpens++
      },
      oauthPersistence: {
        load: async () => oauthState,
        save: async (patch) => {
          oauthState = { ...oauthState, ...patch }
        }
      },
      saveRedirectPort: async () => {},
      backoffInitialMs: 50
    })
  }

  // 1. Correct header: connected, tools discovered, zero OAuth activity.
  const good = makeConnection([{ key: 'X-Api-Key', value: 'sesame', sensitive: true }])
  const goodResult = await good.test()
  ok('with header: test ok', goodResult.ok === true)
  ok('with header: state connected', good.snapshot().state === 'connected')
  ok('with header: tool discovered', good.snapshot().toolCount === 1)
  ok('with header: snapshot carries headers', good.snapshot().headers?.length === 1)
  ok('with header: no oauth discovery hit', oauthDiscoveryHits === 0)
  ok('with header: no browser opened', browserOpens === 0)
  // End-to-end tool call through the registered capability: the
  // tools/call POST must carry the header (the guard 401s it otherwise).
  const call = await lastPlugin!.execute('guarded_echo', { text: 'ping-through-header' })
  ok('with header: real tool call succeeds', call.success === true)
  ok(
    'with header: tool call round-trips output',
    String(call.output ?? '').includes('ping-through-header')
  )
  await good.stop()

  // 2. No header: the 401 walks the silent OAuth path to the redirect
  //    step and parks in needs-auth — without ever opening a browser.
  const bad = makeConnection(undefined)
  await bad.test()
  ok('no header: state needs-auth', bad.snapshot().state === 'needs-auth')
  ok('no header: oauth discovery attempted', oauthDiscoveryHits > 0)
  ok('no header: no browser opened', browserOpens === 0)

  // 3. Live header fix on the needs-auth connection: straight to
  //    connected — the sign-in flow is never entered. setHeaders kicks
  //    the reconnect in the background, so poll for the settle.
  await bad.setHeaders([{ key: 'x-api-key', value: 'sesame' }])
  await waitFor(() => bad.snapshot().state === 'connected')
  ok('setHeaders: state connected', bad.snapshot().state === 'connected')
  ok('setHeaders: tool discovered', bad.snapshot().toolCount === 1)
  ok('setHeaders: no browser opened', browserOpens === 0)

  // 4. Clearing headers reconnects and degrades back to needs-auth.
  await bad.setHeaders(undefined)
  await waitFor(() => bad.snapshot().state === 'needs-auth')
  ok('cleared headers: state needs-auth again', bad.snapshot().state === 'needs-auth')
  await bad.stop()

  // 5. A custom Authorization header — typed lowercase — replaces stored
  //    (stale) OAuth tokens outright: the provider stays detached and
  //    Headers.set() is case-insensitive, so the server sees exactly
  //    "Bearer good-token", never a merged double credential.
  const pat = makeConnection([{ key: 'authorization', value: 'Bearer good-token' }], {
    tokens: { access_token: 'stale-token', token_type: 'Bearer' }
  })
  const patResult = await pat.test()
  ok('custom auth: test ok despite stale stored tokens', patResult.ok === true)
  ok('custom auth: state connected', pat.snapshot().state === 'connected')
  // Sign-in is refused outright — it could never beat the custom header.
  const patAuth = await pat.authorize()
  ok(
    'custom auth: authorize() points at Headers instead',
    patAuth.ok === false && /custom Authorization header/.test(patAuth.error ?? '')
  )
  ok('custom auth: no browser opened', browserOpens === 0)
  await pat.stop()

  // 6. A WRONG custom Authorization header parks in needs-auth (raw 401
  //    with no provider attached), not in an endless backoff loop.
  const wrong = makeConnection([{ key: 'Authorization', value: 'Bearer nope' }])
  await wrong.test()
  ok('wrong custom auth: state needs-auth', wrong.snapshot().state === 'needs-auth')
  await wrong.stop()

  guard.close()

  // 5. Manager-level validation: invalid names / multiline values are
  //    rejected BEFORE persistence — both adds below return at the
  //    header check, ahead of any config read/write, so this test never
  //    touches the real workspace config on disk.
  const { McpManager } = await import('@main/runtime/mcp/manager')
  const manager = new McpManager({
    register: () => {},
    unregister: () => {},
    openExternal: () => {},
    appVersion: '0.0.0-test',
    onStatusChange: () => {},
    takenCapabilityNames: () => new Set()
  })
  manager.start({ servers: [] })
  const badName = await manager.add({
    target: 'http://127.0.0.1:9/never',
    headers: [{ key: 'bad header', value: 'x' }]
  })
  ok(
    'add rejects invalid header name',
    badName.ok === false && /invalid header name/.test(badName.error)
  )
  const badValue = await manager.add({
    target: 'http://127.0.0.1:9/never',
    headers: [{ key: 'X-Ok', value: 'a\nb' }]
  })
  ok(
    'add rejects multiline header value',
    badValue.ok === false && /line breaks|control/.test(badValue.error)
  )
  const zwsp = await manager.add({
    target: 'http://127.0.0.1:9/never',
    headers: [{ key: 'X-Ok', value: 'tok\u200bpasted' }]
  })
  ok(
    'add rejects invisible non-Latin-1 value (would throw inside fetch Headers)',
    zwsp.ok === false && /non-Latin-1/.test(zwsp.error)
  )
  const dup = await manager.add({
    target: 'http://127.0.0.1:9/never',
    headers: [
      { key: 'X-Token', value: 'a' },
      { key: 'x-token', value: 'b' }
    ]
  })
  ok(
    'add rejects case-insensitive duplicate names',
    dup.ok === false && /duplicate/.test(dup.error)
  )
  await manager.stop()

  console.log(`${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
