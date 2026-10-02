/**
 * MCP subsystem tests: naming/namespacing, schema conversion, result
 * normalization, cerebellum registration (raw schema passthrough,
 * generation bumps, reload survival), and a live McpConnection driven
 * against a REAL MCP server over the SDK's in-memory linked transport —
 * connect, discover, call, error, disconnect-degrade, silent reconnect,
 * list_changed refresh, stdio parking, and teardown.
 *
 * Standalone — no vitest/jest in this repo.
 * Run: npx tsx --tsconfig tsconfig.node.json src/main/runtime/__tests__/mcp.test.ts
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

async function run(): Promise<void> {
  const naming = await import('@main/runtime/mcp/naming')
  const capability = await import('@main/runtime/mcp/capability')

  // tsx compiles the app modules to CJS in this harness, so connection.ts
  // resolves the SDK's dist/cjs build — while a test-side `await import(...)`
  // of the SDK resolves dist/esm. Same code, two class identities: an error
  // constructed from the esm build never satisfies the connection's
  // `instanceof` checks. Construct SDK error instances from the SAME (cjs)
  // build the connection sees. (The bundled app has a single build, so this
  // is purely a test-harness concern.)
  const { createRequire } = await import('node:module')
  const requireCjs = createRequire(process.cwd() + '/package.json')

  // ------------------------------------------------------------ naming
  check('slugify basic', naming.slugify('Tafsir Center!'), 'tafsir-center')
  check('slugify arabic-only falls back', naming.slugify('تفسير'), 'server')
  check('slugify collapses dashes', naming.slugify('a -- b'), 'a-b')
  check('deconflict appends suffix', naming.deconflictSlug('shell', new Set(['shell'])), 'shell-2')
  check('deconflict avoids reserved', naming.deconflictSlug('telegram', new Set()), 'telegram-2')
  check(
    'deconflict avoids mcp- capability form',
    naming.deconflictSlug('tafsir', new Set(['mcp-tafsir'])),
    'tafsir-2'
  )

  const nsMap = naming.namespaceToolNames('tafsir-x', ['fetch_ayah', 'weird name!'])
  check('namespace prefixes with underscored slug', nsMap.get('tafsir_x_fetch_ayah'), 'fetch_ayah')
  check('namespace sanitizes illegal chars', nsMap.get('tafsir_x_weird_name_'), 'weird name!')

  const longMap = naming.namespaceToolNames('server', [
    'a'.repeat(80),
    'a'.repeat(80) + 'b' // truncates to the same 64 chars → needs suffix
  ])
  const longNames = [...longMap.keys()]
  ok(
    'namespace caps at 64 chars',
    longNames.every((n) => n.length <= 64)
  )
  ok('namespace dedupes truncation collisions', new Set(longNames).size === 2)

  check('detect http', naming.detectTransport('https://mcp.tafsir.net/mcp'), 'http')
  check('detect stdio', naming.detectTransport('uvx tafsir-mcp'), 'stdio')
  check(
    'parse quoted args',
    naming.parseCommandLine('npx -y srv --db "my data/db.sqlite" --x \'a b\''),
    ['npx', '-y', 'srv', '--db', 'my data/db.sqlite', '--x', 'a b']
  )
  check('parse escapes shell-significant chars', naming.parseCommandLine('run a\\ b'), [
    'run',
    'a b'
  ])
  check(
    'parse preserves Windows path separators',
    naming.parseCommandLine('server.exe C:\\Users\\me\\db.sqlite'),
    ['server.exe', 'C:\\Users\\me\\db.sqlite']
  )
  check(
    'derive name skips runners',
    naming.deriveDisplayName('uvx tafsir-mcp', 'stdio'),
    'tafsir-mcp'
  )
  check(
    'derive name skips npx flags and takes the basename',
    naming.deriveDisplayName('npx -y @scope/some-server', 'stdio'),
    'some-server'
  )
  check(
    'derive name from url host',
    naming.deriveDisplayName('https://mcp.tafsir.net/mcp', 'http'),
    'mcp.tafsir.net'
  )

  // ------------------------------------------------- schema conversion
  const { descriptors, nameMap } = capability.toolsToDescriptors('srv', [
    {
      name: 'search',
      description: 'Search things',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'the query' },
          limit: { type: 'integer', minimum: 1, default: 10 },
          mode: { anyOf: [{ type: 'string' }, { type: 'number' }] }
        },
        required: ['query']
      }
    },
    { name: 'no_args', description: 'Takes nothing', inputSchema: { type: 'object' } }
  ])
  check(
    'descriptor names namespaced',
    descriptors.map((d) => d.name),
    ['srv_search', 'srv_no_args']
  )
  check('nameMap routes back', nameMap.get('srv_search'), 'search')
  const search = descriptors[0]
  ok('required from schema required array', search.parameters.query.required === true)
  ok('absent from required array → optional', search.parameters.limit.required === false)
  check(
    'raw schema passes through verbatim (default, minimum survive)',
    search.parameters.limit.raw,
    { type: 'integer', minimum: 1, default: 10 }
  )
  check('union schemas survive verbatim', search.parameters.mode.raw, {
    anyOf: [{ type: 'string' }, { type: 'number' }]
  })
  check('schema without properties → zero params', Object.keys(descriptors[1].parameters), [])

  ok(
    'unreachable error classifies as network (motor NETWORK_RE)',
    /network error/i.test(capability.unreachableError('srv'))
  )

  const desc = capability.buildDescription({
    displayName: 'Tafsir',
    serverName: 'Tafsir MCP',
    instructions: 'X'.repeat(3000)
  })
  ok('description caps instructions', desc.length < 2500)
  ok('description keeps identity line', desc.includes('"Tafsir" (Tafsir MCP)'))

  // ------------------------------------------------ result normalization
  const norm = capability.normalizeCallResult(
    {
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
        { type: 'resource_link', uri: 'file:///x', name: 'x' },
        { type: 'audio', data: 'BBBB', mimeType: 'audio/wav' }
      ]
    },
    'tool'
  )
  ok('normalize joins text', norm.success && norm.output!.includes('hello'))
  check('normalize maps image mimeType→mediaType', norm.images, [
    { mediaType: 'image/jpeg', data: 'AAAA' }
  ])
  ok('normalize renders resource_link', norm.output!.includes('file:///x'))
  ok('normalize notes audio', norm.output!.includes('audio/wav'))

  const structured = capability.normalizeCallResult(
    { content: [], structuredContent: { a: 1 } },
    'tool'
  )
  ok('structuredContent fallback', structured.success && structured.output!.includes('"a": 1'))

  const errored = capability.normalizeCallResult({ content: [], isError: true }, 'mytool')
  ok('isError with empty text still has message', errored.success === false && !!errored.error)

  const errWithText = capability.normalizeCallResult(
    { content: [{ type: 'text', text: 'boom' }], isError: true },
    'mytool'
  )
  ok(
    'isError surfaces the text detail',
    errWithText.success === false && errWithText.error === 'boom'
  )

  const errWithImage = capability.normalizeCallResult(
    { content: [{ type: 'image', data: 'AAA', mimeType: 'image/png' }], isError: true },
    'mytool'
  )
  ok(
    'isError with only an image notes it (not "no message")',
    errWithImage.success === false && /image/i.test(errWithImage.error ?? '')
  )

  // ------------------------------------------- cerebellum registration
  const { Cerebellum } = await import('@main/runtime/cerebellum')
  const cerebellum = new Cerebellum({})
  await cerebellum.loadAll()

  let callToolCalls = 0
  const built = capability.buildMcpCapability({
    slug: 'srv',
    description: 'desc',
    descriptors,
    nameMap,
    callTool: async (original, args) => {
      callToolCalls++
      return { success: true, output: `${original}:${JSON.stringify(args)}` }
    }
  })
  const gen0 = cerebellum.getGeneration()
  cerebellum.registerInProcessCapability(built.capability, built.plugin)
  ok('register bumps generation', cerebellum.getGeneration() === gen0 + 1)

  const defs = cerebellum.getToolDefinitions()
  const searchDef = defs.find((d) => d.name === 'srv_search')
  ok('registered tool reaches getToolDefinitions', !!searchDef)
  const params = searchDef!.parameters as {
    properties: Record<string, unknown>
    required: string[]
  }
  check('toJSONSchema passes raw property schema verbatim', params.properties.limit, {
    type: 'integer',
    minimum: 1,
    default: 10
  })
  check('toJSONSchema top-level required honors booleans', params.required, ['query'])
  ok(
    'capability index lists the capability',
    cerebellum.getCapabilityIndex().includes('- mcp-srv (')
  )

  const execResult = await cerebellum.executeTool('srv_search', { query: 'x' })
  ok(
    'executeTool routes to MCP plugin',
    execResult.success && execResult.output === 'search:{"query":"x"}'
  )
  ok('plugin was called through the registry', callToolCalls === 1)

  await cerebellum.reload()
  ok(
    'reload preserves in-process capability',
    cerebellum.getToolDefinitions().some((d) => d.name === 'srv_search')
  )

  const genBefore = cerebellum.getGeneration()
  cerebellum.unregisterInProcessCapability('mcp-srv')
  ok('unregister bumps generation', cerebellum.getGeneration() === genBefore + 1)
  const unknown = await cerebellum.executeTool('srv_search', { query: 'x' })
  ok(
    'after unregister tool is unknown',
    unknown.success === false && /unknown tool/.test(unknown.error!)
  )

  // ------------------------------------- live connection (in-memory MCP)
  const { McpConnection } = await import('@main/runtime/mcp/connection')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const { z } = await import('zod')

  type ServerHandle = { server: InstanceType<typeof McpServer>; close: () => Promise<void> }
  let liveServer: ServerHandle | null = null
  let factoryCalls = 0

  const makeServer = async (): Promise<unknown> => {
    factoryCalls++
    const server = new McpServer(
      { name: 'Test Server', version: '9.9.9' },
      { instructions: 'TEST INSTRUCTIONS' }
    )
    server.registerTool(
      'echo',
      { description: 'Echo text back', inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] })
    )
    server.registerTool('boom', { description: 'Always fails' }, async () => ({
      content: [{ type: 'text', text: 'it broke' }],
      isError: true
    }))
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    liveServer = { server, close: () => serverSide.close() }
    return clientSide
  }

  const registered: Array<{
    capability: { name: string; description: string; tools: unknown[] }
    plugin: {
      execute: (
        n: string,
        a: Record<string, unknown>
      ) => Promise<{ success: boolean; output?: string; error?: string }>
    }
  }> = []
  let unregisterCalls = 0
  const phasesSeen: string[] = []
  const connection = new McpConnection({
    config: {
      id: 'test-1',
      name: 'Test Server',
      slug: 'testsrv',
      transport: 'http',
      url: 'http://in-memory.invalid/mcp',
      enabled: true
    },
    appVersion: '0.0.0-test',
    register: (cap, plugin) =>
      registered.push({ capability: cap as never, plugin: plugin as never }),
    unregister: () => {
      unregisterCalls++
    },
    // Every phase transition notifies — record the connect-progress lines
    // the UI would render (in-memory connects are too fast to poll).
    notify: () => {
      const snap = connection.snapshot()
      if (snap.state === 'connecting' && snap.progress) phasesSeen.push(snap.progress)
    },
    openExternal: () => {},
    oauthPersistence: { load: async () => undefined, save: async () => {} },
    saveRedirectPort: async () => {},
    transportFactory: () => makeServer() as never,
    backoffInitialMs: 50
  })

  const testResult = await connection.test()
  ok('connection test connects', testResult.ok === true)
  check('connection reports tool count', testResult.toolCount, 2)
  check('snapshot state connected', connection.snapshot().state, 'connected')
  ok(
    'connecting exposes handshake progress in the snapshot',
    phasesSeen.some((p) => /\[\d\/\d\]/.test(p))
  )
  ok('progress clears once connected', connection.snapshot().progress === undefined)
  check('snapshot server name from initialize', connection.snapshot().serverName, 'Test Server')
  ok('capability registered once', registered.length === 1)
  check('capability name', registered[0]?.capability.name, 'mcp-testsrv')
  ok(
    'server instructions ride the description',
    registered[0]?.capability.description.includes('TEST INSTRUCTIONS') ?? false
  )
  check('snapshot tool names', connection.snapshot().toolNames, ['testsrv_echo', 'testsrv_boom'])

  const echo = await registered[0]!.plugin.execute('testsrv_echo', { text: 'hi' })
  ok('live tool call round-trips', echo.success === true && echo.output === 'echo:hi')
  const boom = await registered[0]!.plugin.execute('testsrv_boom', {})
  ok('isError surfaces as failure', boom.success === false && boom.error === 'it broke')
  const missing = await registered[0]!.plugin.execute('testsrv_nope', {})
  ok('unknown namespaced tool is a structured failure', missing.success === false)

  // Server dies → silent degradation: capability stays registered,
  // calls fail with the retryable network wording, state goes offline.
  await liveServer!.close()
  await sleep(30)
  check('snapshot offline after server death', connection.snapshot().state, 'offline')
  ok('capability NOT unregistered on transient drop', unregisterCalls === 0)
  const whileDown = await registered[0]!.plugin.execute('testsrv_echo', { text: 'x' })
  ok(
    'calls while down return retryable network error',
    whileDown.success === false && /network error/.test(whileDown.error!)
  )

  // …and it recovers on its own (backoff timer → factory makes a new pair).
  await sleep(400)
  check('reconnects silently', connection.snapshot().state, 'connected')
  ok('reconnect used a fresh transport', factoryCalls >= 2)
  ok('unchanged tool list does not re-register (cache stays warm)', registered.length === 1)
  const echo2 = await registered[0]!.plugin.execute('testsrv_echo', { text: 'again' })
  ok('calls work after silent recovery', echo2.success === true && echo2.output === 'echo:again')

  // Tool list changes at runtime → list_changed → re-registration.
  liveServer!.server.registerTool('extra', { description: 'Added later' }, async () => ({
    content: [{ type: 'text', text: 'extra!' }]
  }))
  await sleep(700) // list_changed notification + 300ms debounce + refresh
  ok('list_changed triggers re-registration', registered.length === 2)
  check('refreshed registration carries the new tool', registered[1]?.capability.tools.length, 3)

  await connection.stop()
  ok('stop unregisters the capability', unregisterCalls === 1)

  // ------------------------------------- SSE fallback (legacy servers)
  // First connect attempt gets a 404 on the streamable POST (a legacy
  // SSE-only server); the connection must fall back and reach connected
  // WITHOUT a manual Test — regression guard for the re-entrancy bug where
  // the deferred retry never fired.
  const { StreamableHTTPError } = requireCjs('@modelcontextprotocol/sdk/client/streamableHttp.js')
  let sseAttempts = 0
  const sseConn = new McpConnection({
    config: {
      id: 'sse-1',
      name: 'Legacy',
      slug: 'legacy',
      transport: 'http',
      url: 'http://legacy.invalid/mcp',
      enabled: true
    },
    appVersion: '0.0.0-test',
    register: () => {},
    unregister: () => {},
    notify: () => {},
    openExternal: () => {},
    oauthPersistence: { load: async () => undefined, save: async () => {} },
    saveRedirectPort: async () => {},
    transportFactory: async () => {
      sseAttempts++
      if (sseAttempts === 1) throw new StreamableHTTPError(404, 'no streamable endpoint')
      const server = new McpServer({ name: 'Legacy', version: '1.0.0' })
      server.registerTool('ping', { description: 'ping' }, async () => ({
        content: [{ type: 'text', text: 'pong' }]
      }))
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
      await server.connect(serverSide)
      return clientSide as never
    }
  })
  sseConn.start()
  let ssnap = sseConn.snapshot()
  for (let i = 0; i < 40 && ssnap.state !== 'connected'; i++) {
    await sleep(100)
    ssnap = sseConn.snapshot()
  }
  ok('SSE fallback reconnects without manual Test', ssnap.state === 'connected')
  ok('SSE fallback used two transport attempts', sseAttempts >= 2)
  ok('bare 404 demotes to SSE', (sseConn as unknown as { preferSse: boolean }).preferSse === true)
  await sseConn.stop()

  // A 404 whose body is a JSON-RPC error ("Session not found" — a live
  // streamable server behind a load balancer without session affinity, as
  // seen on mcp.tafsir.net) must NOT demote the transport to SSE: it takes
  // the normal backoff path, keeps its error visible, and reconnects on
  // streamable when routing luck improves.
  let lbAttempts = 0
  const lbConn = new McpConnection({
    config: {
      id: 'lb-1',
      name: 'Flaky LB',
      slug: 'flakylb',
      transport: 'http',
      url: 'http://flakylb.invalid/mcp',
      enabled: true
    },
    appVersion: '0.0.0-test',
    register: () => {},
    unregister: () => {},
    notify: () => {},
    openExternal: () => {},
    oauthPersistence: { load: async () => undefined, save: async () => {} },
    saveRedirectPort: async () => {},
    transportFactory: async () => {
      lbAttempts++
      if (lbAttempts <= 2) {
        throw new StreamableHTTPError(
          404,
          'Error POSTing to endpoint: {"jsonrpc":"2.0","id":"server-error","error":{"code":-32600,"message":"Session not found"}}'
        )
      }
      const server = new McpServer({ name: 'Flaky LB', version: '1.0.0' })
      server.registerTool('ping', { description: 'ping' }, async () => ({
        content: [{ type: 'text', text: 'pong' }]
      }))
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
      await server.connect(serverSide)
      return clientSide as never
    },
    backoffInitialMs: 20
  })
  lbConn.start()
  // Sample tightly: with a 20ms backoff the third (successful) attempt lands
  // fast, so record whether the backoff-with-error state was EVER observed.
  let everBackoffWithError = false
  let lbSnap = lbConn.snapshot()
  for (let i = 0; i < 400 && lbSnap.state !== 'connected'; i++) {
    await sleep(10)
    lbSnap = lbConn.snapshot()
    if (lbSnap.state === 'offline' && /Session not found/.test(lbSnap.error ?? '')) {
      everBackoffWithError = true
    }
  }
  ok('session-loss 404 takes the backoff path (offline + visible error)', everBackoffWithError)
  ok(
    'session-loss 404 does NOT demote to SSE',
    (lbConn as unknown as { preferSse: boolean }).preferSse === false
  )
  ok('session-loss server reconnects on streamable after retries', lbSnap.state === 'connected')
  await lbConn.stop()

  // A failed SSE attempt resets the preference so a mistaken demotion can
  // never stick: attempt 1 bare-405 (→ SSE), attempt 2 fails (→ back to
  // streamable), attempt 3 connects.
  let altAttempts = 0
  const altConn = new McpConnection({
    config: {
      id: 'alt-1',
      name: 'Alternating',
      slug: 'alt',
      transport: 'http',
      url: 'http://alt.invalid/mcp',
      enabled: true
    },
    appVersion: '0.0.0-test',
    register: () => {},
    unregister: () => {},
    notify: () => {},
    openExternal: () => {},
    oauthPersistence: { load: async () => undefined, save: async () => {} },
    saveRedirectPort: async () => {},
    transportFactory: async () => {
      altAttempts++
      if (altAttempts === 1) throw new StreamableHTTPError(405, 'method not allowed')
      if (altAttempts === 2) throw new Error('sse stream refused')
      const server = new McpServer({ name: 'Alternating', version: '1.0.0' })
      server.registerTool('ping', { description: 'ping' }, async () => ({
        content: [{ type: 'text', text: 'pong' }]
      }))
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
      await server.connect(serverSide)
      return clientSide as never
    },
    backoffInitialMs: 20
  })
  altConn.start()
  let altSnap = altConn.snapshot()
  for (let i = 0; i < 40 && altSnap.state !== 'connected'; i++) {
    await sleep(100)
    altSnap = altConn.snapshot()
  }
  ok('failed SSE attempt alternates back and still connects', altSnap.state === 'connected')
  ok(
    'preferSse was reset after the SSE failure',
    (altConn as unknown as { preferSse: boolean }).preferSse === false
  )
  await altConn.stop()

  // ------------------------------------------------- stdio parking
  let brokenAttempts = 0
  const broken = new McpConnection({
    config: {
      id: 'test-2',
      name: 'Broken',
      slug: 'broken',
      transport: 'stdio',
      command: 'definitely-not-a-real-binary-xyz',
      enabled: true
    },
    appVersion: '0.0.0-test',
    register: () => {},
    unregister: () => {},
    notify: () => {},
    openExternal: () => {},
    oauthPersistence: { load: async () => undefined, save: async () => {} },
    saveRedirectPort: async () => {},
    transportFactory: () => {
      brokenAttempts++
      throw new Error('spawn definitely-not-a-real-binary-xyz ENOENT')
    },
    backoffInitialMs: 5
  })
  broken.start()
  await sleep(600)
  check('broken stdio command parks as offline', broken.snapshot().state, 'offline')
  const attemptsAtPark = brokenAttempts
  ok('parks after bounded attempts (no infinite respawn)', attemptsAtPark === 5)
  await sleep(300)
  ok('parked connection stops retrying', brokenAttempts === attemptsAtPark)
  ok('parked snapshot carries the error detail', /ENOENT/.test(broken.snapshot().error ?? ''))
  await broken.stop()

  // -------------------------------------- stdio env-var credentials (real spawn)
  // The plain-credentials auth option for local servers: a REAL stdio MCP
  // server process (no transportFactory — this exercises parseCommandLine +
  // StdioClientTransport spawn) that refuses to start without TEST_API_KEY
  // and, when given one, exposes a tool that echoes it back — proving the
  // configured env actually reaches the child.
  const fsp = await import('node:fs/promises')
  const pathMod = await import('node:path')
  const sdkEsm = pathMod.join(
    process.cwd(),
    'node_modules/@modelcontextprotocol/sdk/dist/esm/server'
  )
  const envServerScript = pathMod.join(os.tmpdir(), `wolffish-mcp-env-test-${process.pid}.mjs`)
  await fsp.writeFile(
    envServerScript,
    [
      `import { McpServer } from ${JSON.stringify('file://' + sdkEsm + '/mcp.js')}`,
      `import { StdioServerTransport } from ${JSON.stringify('file://' + sdkEsm + '/stdio.js')}`,
      `const key = process.env.TEST_API_KEY`,
      `if (!key) { console.error('missing TEST_API_KEY'); process.exit(1) }`,
      `const server = new McpServer({ name: 'EnvGuarded', version: '1.0.0' })`,
      `server.registerTool('whoami', { description: 'echo the api key' }, async () => ({`,
      `  content: [{ type: 'text', text: 'key=' + key }]`,
      `}))`,
      `await server.connect(new StdioServerTransport())`
    ].join('\n')
  )
  const envCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(envServerScript)}`

  const envRegistered: Array<{
    plugin: {
      execute: (
        n: string,
        a: Record<string, unknown>
      ) => Promise<{ success: boolean; output?: string }>
    }
  }> = []
  const envConn = new McpConnection({
    config: {
      id: 'env-1',
      name: 'Env Guarded',
      slug: 'envsrv',
      transport: 'stdio',
      command: envCommand,
      env: { TEST_API_KEY: 'sekrit-123' },
      enabled: true
    },
    appVersion: '0.0.0-test',
    register: (_cap, plugin) => envRegistered.push({ plugin: plugin as never }),
    unregister: () => {},
    notify: () => {},
    openExternal: () => {},
    oauthPersistence: { load: async () => undefined, save: async () => {} },
    saveRedirectPort: async () => {},
    backoffInitialMs: 50
  })
  envConn.start()
  let envSnap = envConn.snapshot()
  for (let i = 0; i < 100 && envSnap.state !== 'connected'; i++) {
    await sleep(100)
    envSnap = envConn.snapshot()
  }
  check('env-credentialed stdio server connects (real process)', envSnap.state, 'connected')
  const whoami = await envRegistered[0]?.plugin.execute('envsrv_whoami', {})
  ok(
    'configured env vars reach the spawned server',
    whoami?.success === true && whoami.output === 'key=sekrit-123'
  )
  await envConn.stop()

  // Without the credential the same server refuses to start — it must park
  // silently (bounded respawns), never crash anything.
  const noEnvConn = new McpConnection({
    config: {
      id: 'env-2',
      name: 'Env Missing',
      slug: 'envmiss',
      transport: 'stdio',
      command: envCommand,
      enabled: true
    },
    appVersion: '0.0.0-test',
    register: () => {},
    unregister: () => {},
    notify: () => {},
    openExternal: () => {},
    oauthPersistence: { load: async () => undefined, save: async () => {} },
    saveRedirectPort: async () => {},
    backoffInitialMs: 20
  })
  noEnvConn.start()
  let noEnvSnap = noEnvConn.snapshot()
  for (let i = 0; i < 200; i++) {
    await sleep(50)
    noEnvSnap = noEnvConn.snapshot()
    if (noEnvSnap.state === 'offline' && /TEST_API_KEY|closed/i.test(noEnvSnap.error ?? '')) break
  }
  check('missing credential parks the server as offline', noEnvSnap.state, 'offline')
  ok(
    'the stderr tail surfaces the missing-credential hint',
    /TEST_API_KEY/.test(noEnvSnap.error ?? '')
  )
  await noEnvConn.stop()
  await fsp.rm(envServerScript, { force: true })

  // ---------------------------------------------- OAuth client provider
  const auth = await import('@main/runtime/mcp/auth')
  const { UnauthorizedError } = requireCjs('@modelcontextprotocol/sdk/client/auth.js')

  // In-memory persistence mirroring patchMcpServerOauth's merge/delete rules.
  const makePersistence = (): {
    load: () => Promise<Record<string, unknown> | undefined>
    save: (patch: Record<string, unknown>) => Promise<void>
    state: Record<string, unknown>
  } => {
    const state: Record<string, unknown> = {}
    return {
      state,
      load: async () => state,
      save: async (patch) => {
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) delete state[k]
          else state[k] = v
        }
      }
    }
  }

  const persistence = makePersistence()
  let openedUrl: string | null = null
  const provider = new auth.WolffishOAuthProvider({
    redirectPort: 51837,
    persistence: persistence as never,
    openExternal: (url) => {
      openedUrl = url
    }
  })

  ok(
    'redirectUrl is always defined + stable',
    provider.redirectUrl === 'http://127.0.0.1:51837/wolffish/mcp/callback'
  )
  const meta = provider.clientMetadata
  ok('clientMetadata is a public PKCE client', meta.token_endpoint_auth_method === 'none')
  ok(
    'clientMetadata grants code + refresh',
    JSON.stringify(meta.grant_types) === JSON.stringify(['authorization_code', 'refresh_token'])
  )
  ok(
    'clientMetadata redirect_uris includes the callback',
    (meta.redirect_uris ?? []).includes(provider.redirectUrl)
  )

  const st = provider.state()
  ok(
    'state() returns a token and records it',
    typeof st === 'string' && st.length > 0 && provider.lastState === st
  )

  provider.saveCodeVerifier('verifier-123')
  ok('codeVerifier round-trips', provider.codeVerifier() === 'verifier-123')

  await provider.saveTokens({
    access_token: 'at',
    token_type: 'bearer',
    refresh_token: 'rt'
  } as never)
  const loadedTokens = (await provider.tokens()) as { access_token?: string } | undefined
  ok('tokens persist + load back', loadedTokens?.access_token === 'at')
  await provider.saveClientInformation({ client_id: 'cid' } as never)
  const loadedClient = (await provider.clientInformation()) as { client_id?: string } | undefined
  ok('client information persists + loads back', loadedClient?.client_id === 'cid')

  // Silent (non-interactive) redirect must NOT open a browser.
  provider.interactive = false
  provider.redirectToAuthorization(new URL('https://auth.example/authorize?x=1'))
  ok(
    'silent redirect records the URL but does not open a browser',
    openedUrl === null && provider.lastAuthorizationUrl === 'https://auth.example/authorize?x=1'
  )
  // Interactive redirect opens the browser.
  provider.interactive = true
  provider.redirectToAuthorization(new URL('https://auth.example/authorize?x=2'))
  ok('interactive redirect opens the browser', openedUrl === 'https://auth.example/authorize?x=2')

  // Self-healing credential invalidation.
  await provider.invalidateCredentials('tokens')
  ok('invalidate(tokens) clears tokens', (await provider.tokens()) === undefined)
  ok('invalidate(tokens) keeps client info', (await provider.clientInformation()) !== undefined)
  await provider.invalidateCredentials('all')
  ok('invalidate(all) clears client info too', (await provider.clientInformation()) === undefined)

  // ---------------------------------------------- loopback callback server
  const port1 = await auth.allocateLoopbackPort()
  const okFlow = auth.waitForCallback({ port: port1, expectedState: () => 'xyz', timeoutMs: 5000 })
  await sleep(60)
  const okRes = await fetch(
    `http://127.0.0.1:${port1}${auth.CALLBACK_PATH}?code=the-code&state=xyz`
  )
  const okResult = await okFlow
  ok(
    'callback captures the auth code on success',
    okResult.ok === true && (okResult as { code: string }).code === 'the-code'
  )
  ok('callback returns a 200 confirmation page', okRes.status === 200)

  const port2 = await auth.allocateLoopbackPort()
  const errFlow = auth.waitForCallback({ port: port2, expectedState: () => 'xyz', timeoutMs: 5000 })
  await sleep(60)
  await fetch(`http://127.0.0.1:${port2}${auth.CALLBACK_PATH}?error=access_denied&state=xyz`).catch(
    () => {}
  )
  const errResult = await errFlow
  ok(
    'callback surfaces an OAuth error and settles',
    errResult.ok === false && /access_denied/.test((errResult as { error: string }).error)
  )

  const port3 = await auth.allocateLoopbackPort()
  const mismatchFlow = auth.waitForCallback({
    port: port3,
    expectedState: () => 'expected',
    timeoutMs: 5000
  })
  await sleep(60)
  await fetch(`http://127.0.0.1:${port3}${auth.CALLBACK_PATH}?code=c&state=wrong`).catch(() => {})
  const mismatchResult = await mismatchFlow
  ok(
    'callback rejects a state mismatch (CSRF guard) and settles',
    mismatchResult.ok === false && /state/.test((mismatchResult as { error: string }).error)
  )

  // A 401 during connect (UnauthorizedError, constructed from the cjs build
  // so the connection's instanceof matches) parks the connection in
  // needs-auth and does NOT retry silently — only a user sign-in fixes auth.
  let authAttempts = 0
  const authConn = new McpConnection({
    config: {
      id: 'auth-1',
      name: 'Guarded',
      slug: 'guarded',
      transport: 'http',
      url: 'https://guarded.invalid/mcp',
      enabled: true
    },
    appVersion: '0.0.0-test',
    register: () => {},
    unregister: () => {},
    notify: () => {},
    openExternal: () => {},
    oauthPersistence: { load: async () => undefined, save: async () => {} },
    saveRedirectPort: async () => {},
    transportFactory: () => {
      authAttempts++
      throw new UnauthorizedError('authorization required')
    },
    backoffInitialMs: 20
  })
  authConn.start()
  await sleep(150)
  check(
    'an UnauthorizedError parks the connection in needs-auth',
    authConn.snapshot().state,
    'needs-auth'
  )
  const attemptsAtAuth = authAttempts
  await sleep(250)
  ok(
    'needs-auth does NOT silently retry (only user sign-in fixes it)',
    authAttempts === attemptsAtAuth
  )
  await authConn.stop()

  // authorize() only makes sense for remote (URL) servers — a stdio server
  // rejects it outright, no browser opened.
  const stdioAuthConn = new McpConnection({
    config: {
      id: 'sa',
      name: 'Local',
      slug: 'local2',
      transport: 'stdio',
      command: 'true',
      enabled: true
    },
    appVersion: '0.0.0-test',
    register: () => {},
    unregister: () => {},
    notify: () => {},
    openExternal: () => {},
    oauthPersistence: { load: async () => undefined, save: async () => {} },
    saveRedirectPort: async () => {}
  })
  const authResult = await stdioAuthConn.authorize()
  ok(
    'authorize() refuses a non-remote server (no browser handoff)',
    authResult.ok === false && /remote|OAuth/i.test(authResult.error ?? '')
  )
  await stdioAuthConn.stop()

  console.log(`${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

void run().catch((err) => {
  console.error('test harness crashed:', err)
  process.exit(1)
})
