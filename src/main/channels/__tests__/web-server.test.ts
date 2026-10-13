/**
 * The Web UI server as a browser would meet it: a password behind a rate
 * limit, a cookie that is the only key, an Origin check on every POST and on
 * the socket, invoke frames answered from the handler map with the GUI-only
 * channels refused and the download/file/url channels rewritten, workspace
 * file routes that refuse to leave the workspace and serve byte ranges, one
 * upload route whose staged copy is consumed by the app's own save handler,
 * and notifications fanned in-band to every connected browser.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/web-server.test.ts
 */
import type { IpcHandler } from '@main/ipc-registry'
import Module from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// workspaceRoot() reads os.homedir() at module import — override first.
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'wolffish-web-server-'))
process.env.HOME = SANDBOX
process.env.USERPROFILE = SANDBOX

// Shim `electron` so the import graph loads outside an Electron process.
const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => os.tmpdir(),
        getVersion: () => '0.0.0'
      },
      ipcMain: { handle: () => undefined, on: () => undefined }
    }
  }
  return origLoad.apply(this, args)
}

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
}

type Fetched = { status: number; headers: Headers; text: string; json: () => unknown }
async function call(url: string, init: RequestInit & { cookie?: string } = {}): Promise<Fetched> {
  const headers = new Headers(init.headers ?? {})
  if (init.cookie) headers.set('cookie', init.cookie)
  const res = await fetch(url, { ...init, headers, redirect: 'manual' })
  const text = await res.text()
  return {
    status: res.status,
    headers: res.headers,
    text,
    json: () => {
      try {
        return JSON.parse(text)
      } catch {
        return null
      }
    }
  }
}

async function run(): Promise<void> {
  const { WebServer } = await import('@main/channels/web/server')
  const { hashPassword } = await import('@main/channels/web/auth')
  const { WebSocket } = await import('ws')
  const workspace = path.join(SANDBOX, '.wolffish', 'workspace')
  mkdirSync(path.join(workspace, 'uploads', 'conv_x'), { recursive: true })
  mkdirSync(path.join(workspace, 'web'), { recursive: true })
  writeFileSync(
    path.join(workspace, 'uploads', 'conv_x', 'hello.txt'),
    'hello world, twelve bytes and more'
  )
  const renderer = path.join(SANDBOX, 'renderer')
  mkdirSync(path.join(renderer, 'assets'), { recursive: true })
  writeFileSync(
    path.join(renderer, 'index.html'),
    '<!doctype html><html><head><title>x</title></head><body>app</body></html>'
  )
  writeFileSync(path.join(renderer, 'assets', 'app.js'), 'console.log(1)')
  const icon = path.join(SANDBOX, 'icon.png')
  writeFileSync(icon, Buffer.from('89504e470d0a1a0a', 'hex'))

  const passwordHash = await hashPassword('open sesame 123')
  let config = {
    enabled: true,
    port: 0,
    bind: '127.0.0.1',
    passwordHash,
    https: { mode: 'off' as const, httpPort: null },
    notifications: true,
    verbose: false,
    push: undefined as undefined | { vapidPublicKey: string; vapidPrivateKey: string }
  }
  const handlers = new Map<string, IpcHandler>()
  const seen: Array<{ channel: string; args: unknown[] }> = []
  handlers.set('system:getInfo', async () => ({ platform: 'test', cpuCount: 1 }))
  handlers.set('echo:bin', async (_e, buf: Buffer) => ({
    got: Buffer.isBuffer(buf),
    length: buf.length,
    back: Buffer.from('hi')
  }))
  handlers.set('echo:bigbin', async () => ({ bytes: Buffer.alloc(33 * 1024 * 1024) }))
  handlers.set('echo:bigbin:split', async () => ({
    a: Buffer.alloc(20 * 1024 * 1024),
    b: Buffer.alloc(20 * 1024 * 1024)
  }))
  handlers.set(
    'chat:send',
    async (e: { sender: { send: (c: string, p: unknown) => void } }, payload: unknown) => {
      seen.push({ channel: 'chat:send', args: [payload] })
      e.sender.send('chat:segment', { kind: 'text', delta: 'streamed' })
      return { turnId: 't1', ok: true }
    }
  )
  handlers.set('upload:pickFile', async () => {
    throw new Error('should never be reached')
  })
  let savedFrom: string | null = null
  handlers.set('upload:saveFile', async (_e, payload: { sourcePath: string }) => {
    savedFrom = payload.sourcePath
    return {
      filePath: 'uploads/conv_x/' + path.basename(payload.sourcePath),
      sizeBytes: readFileSync(payload.sourcePath).length
    }
  })
  let heldSender: { send: (c: string, p: unknown) => void; isDestroyed: () => boolean } | null =
    null
  handlers.set(
    'test:holdSender',
    async (e: {
      sender: { send: (c: string, p: unknown) => void; isDestroyed: () => boolean }
    }) => {
      heldSender = e.sender
      return true
    }
  )
  handlers.set('throws', async () => {
    throw new Error('boom')
  })

  let statusChanges = 0
  const server = new WebServer({
    handlers,
    version: '1.2.3',
    rendererDir: renderer,
    devServerUrl: null,
    icons: { 128: icon, 256: icon, 512: icon },
    getConfig: async () => config,
    setConfig: async (patch) => {
      config = {
        ...config,
        ...(patch as Partial<typeof config>),
        https: { ...config.https, ...((patch.https ?? {}) as typeof config.https) }
      }
    },
    onProgress: () => undefined,
    persistVapid: async (keys) => {
      config = {
        ...config,
        push: { vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey }
      }
    },
    stateFile: path.join(workspace, 'web', 'state.json'),
    tlsDir: path.join(workspace, 'web', 'tls'),
    exportPdf: async (html) => Buffer.from(`PDF:${html.length}`),
    attachFiles: async (req) => ({ attached: req.paths.length, kind: req.kind }),
    onStatusChange: () => {
      statusChanges++
    },
    log: () => undefined,
    warn: (line) => console.error('  warn:', line)
  })

  console.log('step: disabled / no password')
  config = { ...config, enabled: false }
  await server.start()
  ok('disabled: not listening', !(await server.status()).listening)
  config = { ...config, enabled: true, passwordHash: null as unknown as string }
  await server.start()
  const noPw = await server.status()
  ok(
    'no password: not listening with a reason',
    !noPw.listening && /password/.test(noPw.error ?? ''),
    noPw.error ?? ''
  )
  config = { ...config, passwordHash }
  await server.start()
  const st = await server.status()
  ok(
    'listening on an OS-picked port',
    st.listening && st.port > 0 && st.urls.every((u) => u.endsWith(`:${st.port}`)),
    JSON.stringify(st)
  )
  const port = st.port
  ok(
    'vapid keys generated and persisted',
    Boolean(config.push?.vapidPublicKey),
    JSON.stringify(config.push)
  )
  const base = `http://127.0.0.1:${port}`

  console.log('step: static + public assets')
  const index = await call(`${base}/`)
  ok('index served', index.status === 200 && index.text.includes('app'))
  ok('index gets the manifest link injected', index.text.includes('rel="manifest"'))
  ok(
    'index has security headers',
    index.headers.get('x-frame-options') === 'DENY' &&
      index.headers.get('x-content-type-options') === 'nosniff'
  )
  const asset = await call(`${base}/assets/app.js`)
  ok(
    'asset served immutable',
    asset.status === 200 && /immutable/.test(asset.headers.get('cache-control') ?? '')
  )
  ok('unknown asset 404', (await call(`${base}/assets/nope.js`)).status === 404)
  ok('deeplink path falls back to index', (await call(`${base}/some/route`)).text.includes('app'))
  ok('traversal refused', (await call(`${base}/..%2f..%2fetc/passwd`)).status !== 200)
  const sw = await call(`${base}/sw.js`)
  ok(
    'service worker served',
    sw.status === 200 &&
      sw.text.includes("addEventListener('push'") &&
      sw.headers.get('service-worker-allowed') === '/'
  )
  const manifest = await call(`${base}/manifest.webmanifest`)
  ok(
    'manifest served',
    manifest.status === 200 && (manifest.json() as { display: string }).display === 'standalone'
  )
  ok('icon served', (await call(`${base}/icon-256.png`)).status === 200)

  console.log('step: auth')
  const status0 = (await call(`${base}/api/auth/status`)).json() as {
    authenticated: boolean
    passwordSet: boolean
    version: string
    vapidPublicKey: string | null
  }
  ok(
    'status: signed out, password set',
    status0.authenticated === false && status0.passwordSet === true && status0.version === '1.2.3'
  )
  ok('status: no vapid key before sign-in', status0.vapidPublicKey === null)
  ok(
    'protected api 401',
    (await call(`${base}/api/push/subscribe`, { method: 'POST' })).status === 401
  )
  ok('files 401', (await call(`${base}/files/uploads/conv_x/hello.txt`)).status === 401)
  // A person following the link gets the sign-in page with the link remembered;
  // a fetch or an <img> keeps getting the bare 401.
  // Raw requests: Node's fetch stamps `Sec-Fetch-Mode: cors` on everything and
  // refuses to let a test set it, so a browser's navigation headers are sent
  // by hand here.
  const rawGet = (
    path: string,
    headers: Record<string, string>
  ): Promise<{ status: number; location: string | null }> =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
        res.resume()
        resolve({ status: res.statusCode ?? 0, location: res.headers.location ?? null })
      })
      req.on('error', reject)
      req.end()
    })
  const nav = await rawGet('/files/uploads/conv_x/hello.txt?v=2', { accept: 'text/html,*/*;q=0.8' })
  ok(
    'navigation to a file redirects to sign-in',
    nav.status === 302 && nav.location === '/?next=%2Ffiles%2Fuploads%2Fconv_x%2Fhello.txt%3Fv%3D2',
    `${nav.status} ${nav.location}`
  )
  const navFetch = await rawGet('/download/uploads/conv_x/hello.txt', {
    'sec-fetch-mode': 'navigate',
    accept: '*/*'
  })
  ok('Sec-Fetch-Mode navigate redirects too', navFetch.status === 302)
  const corsFetch = await rawGet('/files/uploads/conv_x/hello.txt', {
    'sec-fetch-mode': 'cors',
    accept: 'text/html'
  })
  ok('a cors fetch asking for html still gets 401', corsFetch.status === 401)
  const imgFetch = await call(`${base}/files/uploads/conv_x/hello.txt`, {
    headers: { 'sec-fetch-mode': 'no-cors', accept: 'image/*' }
  })
  ok('subresource fetch keeps the 401', imgFetch.status === 401)
  const apiNav = await call(`${base}/api/push/subscribe`, { headers: { accept: 'text/html' } })
  ok('api routes never redirect', apiNav.status === 401)
  ok(
    'ws 401 without cookie',
    await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: base } })
      ws.on('error', () => resolve(true))
      ws.on('open', () => {
        ws.close()
        resolve(false)
      })
    })
  )
  const noOrigin = await call(`${base}/api/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ password: 'open sesame 123' }),
    headers: { 'content-type': 'application/json' }
  })
  ok('login without Origin refused', noOrigin.status === 403, String(noOrigin.status))
  const badOrigin = await call(`${base}/api/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ password: 'open sesame 123' }),
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' }
  })
  ok('login with foreign Origin refused', badOrigin.status === 403)
  const wrong = await call(`${base}/api/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ password: 'nope nope nope' }),
    headers: { 'content-type': 'application/json', origin: base }
  })
  ok('wrong password 401', wrong.status === 401 && !wrong.headers.get('set-cookie'))
  const login = await call(`${base}/api/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ password: 'open sesame 123' }),
    headers: { 'content-type': 'application/json', origin: base }
  })
  ok('login ok', login.status === 200, login.text)
  const setCookie = login.headers.get('set-cookie') ?? ''
  ok(
    'cookie is HttpOnly SameSite=Strict, a year long',
    /wf_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=31536000/.test(
      setCookie
    ),
    setCookie
  )
  ok('cookie not Secure over http', !/Secure/.test(setCookie))
  const cookie = setCookie.split(';')[0]
  const status1 = (await call(`${base}/api/auth/status`, { cookie })).json() as {
    authenticated: boolean
    vapidPublicKey: string | null
  }
  ok('status: signed in', status1.authenticated === true)
  ok(
    'status: vapid key after sign-in',
    typeof status1.vapidPublicKey === 'string' && status1.vapidPublicKey.length > 80
  )
  // ── a password change from a browser spares that browser ──────────────────
  // The server stamps the caller's session on every invoke; a handler that
  // signs "everyone else" out with it as `except` must keep the caller's
  // socket and cookie, close every other browser with 4001 — final, so the
  // bridge goes to the sign-in page instead of reconnecting against a 401
  // forever — and still deliver the reply to the caller.
  handlers.set('test:signOutOthers', async (e: { webSessionId?: string }) => {
    await server.revokeAllSessions({ except: e.webSessionId })
    return { spared: e.webSessionId ?? null }
  })
  const loginB = await call(`${base}/api/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ password: 'open sesame 123' }),
    headers: { 'content-type': 'application/json', origin: base }
  })
  const cookieB = (loginB.headers.get('set-cookie') ?? '').split(';')[0]
  type Frame = Record<string, unknown>
  type Browser = {
    ws: InstanceType<typeof WebSocket>
    next: () => Promise<Frame>
    closed: Promise<number>
  }
  const openSocket = (c: string, page?: string): Promise<Browser> =>
    new Promise((resolve, reject) => {
      const sock = new WebSocket(`ws://127.0.0.1:${port}/ws${page ? `?page=${page}` : ''}`, {
        headers: { origin: base, cookie: c }
      })
      const q: Frame[] = []
      const w: Array<(f: Frame) => void> = []
      sock.on('message', (d) => {
        const f = JSON.parse(d.toString()) as Frame
        const waiter = w.shift()
        if (waiter) waiter(f)
        else q.push(f)
      })
      const closed = new Promise<number>((r) => sock.on('close', (code) => r(code)))
      sock.on('error', reject)
      sock.on('open', () =>
        resolve({
          ws: sock,
          next: () => (q.length > 0 ? Promise.resolve(q.shift()!) : new Promise((r) => w.push(r))),
          closed
        })
      )
    })
  const browserA = await openSocket(cookie)
  const browserB = await openSocket(cookieB)
  ok(
    'both browsers greeted',
    (await browserA.next()).t === 'hello' && (await browserB.next()).t === 'hello'
  )
  browserA.ws.send(JSON.stringify({ t: 'invoke', id: 1, channel: 'test:signOutOthers', args: [] }))
  const spareReply = await browserA.next()
  ok(
    'the caller gets the reply, stamped with its own session',
    spareReply.t === 'result' &&
      spareReply.ok === true &&
      typeof (spareReply.value as { spared: unknown }).spared === 'string',
    JSON.stringify(spareReply)
  )
  ok('the other browser is closed with 4001', (await browserB.closed) === 4001)
  ok('the caller stays connected', browserA.ws.readyState === WebSocket.OPEN)
  const stA = (await call(`${base}/api/auth/status`, { cookie })).json() as {
    authenticated: boolean
  }
  const stB = (await call(`${base}/api/auth/status`, { cookie: cookieB })).json() as {
    authenticated: boolean
  }
  ok(
    'caller cookie still signed in, the other one not',
    stA.authenticated === true && stB.authenticated === false
  )
  browserA.ws.close()

  for (let i = 0; i < 6; i++) {
    await call(`${base}/api/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ password: 'bad' }),
      headers: { 'content-type': 'application/json', origin: base }
    })
  }
  const limited = await call(`${base}/api/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ password: 'open sesame 123' }),
    headers: { 'content-type': 'application/json', origin: base }
  })
  ok(
    'rate limited after repeated failures',
    limited.status === 429 && !!limited.headers.get('retry-after'),
    String(limited.status)
  )
  ok(
    'existing session unaffected by the lock',
    ((await call(`${base}/api/auth/status`, { cookie })).json() as { authenticated: boolean })
      .authenticated
  )

  console.log('step: file routes')
  const file = await call(`${base}/files/uploads/conv_x/hello.txt`, { cookie })
  ok('workspace file served', file.status === 200 && file.text.startsWith('hello world'))
  ok('workspace file content-type', /text\/plain/.test(file.headers.get('content-type') ?? ''))
  ok('workspace file not an attachment', !file.headers.get('content-disposition'))
  ok(
    'workspace file may be framed by the app (PDF card, HTML viewer)',
    file.headers.get('x-frame-options') === 'SAMEORIGIN'
  )
  const download = await call(`${base}/download/uploads/conv_x/hello.txt`, { cookie })
  ok(
    'download is an attachment',
    /attachment; filename\*=UTF-8''hello\.txt/.test(
      download.headers.get('content-disposition') ?? ''
    )
  )
  const ranged = await call(`${base}/files/uploads/conv_x/hello.txt`, {
    cookie,
    headers: { range: 'bytes=6-10' }
  })
  ok(
    'range request → 206',
    ranged.status === 206 &&
      ranged.text === 'world' &&
      /bytes 6-10\/\d+/.test(ranged.headers.get('content-range') ?? ''),
    `${ranged.status} ${ranged.text}`
  )
  const suffix = await call(`${base}/files/uploads/conv_x/hello.txt`, {
    cookie,
    headers: { range: 'bytes=-4' }
  })
  ok('suffix range', suffix.status === 206 && suffix.text === 'more')
  const bad = await call(`${base}/files/uploads/conv_x/hello.txt`, {
    cookie,
    headers: { range: 'bytes=999-' }
  })
  ok('unsatisfiable range → 416', bad.status === 416)
  const etag = file.headers.get('etag') ?? ''
  ok(
    'etag → 304',
    (
      await call(`${base}/files/uploads/conv_x/hello.txt`, {
        cookie,
        headers: { 'if-none-match': etag }
      })
    ).status === 304
  )
  ok(
    'traversal via files refused',
    (await call(`${base}/files/..%2F..%2Fconfig.json`, { cookie })).status === 404
  )
  ok(
    'dotdot segment refused',
    (
      await call(`${base}/files/uploads/../../.wolffish/workspace/uploads/conv_x/hello.txt`, {
        cookie
      })
    ).status !== 200
  )
  ok(
    'missing file 404',
    (await call(`${base}/files/uploads/conv_x/nope.txt`, { cookie })).status === 404
  )
  ok(
    'device route needs absolute path',
    (await call(`${base}/device?path=relative`, { cookie })).status === 400
  )
  ok(
    'device route serves a file',
    (await call(`${base}/device?path=${encodeURIComponent(icon)}`, { cookie })).status === 200
  )

  console.log('step: websocket')
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: base, cookie } })
  // Frames queue until something asks for them, so one that lands before a
  // waiter is registered (the hello, a segment racing its result) is not lost.
  const queue: Array<Record<string, unknown>> = []
  const waiters: Array<(f: Record<string, unknown>) => void> = []
  ws.on('message', (data) => {
    const f = JSON.parse(data.toString()) as Record<string, unknown>
    const w = waiters.shift()
    if (w) w(f)
    else queue.push(f)
  })
  const next = (): Promise<Record<string, unknown>> =>
    queue.length > 0
      ? Promise.resolve(queue.shift()!)
      : new Promise((resolve) => waiters.push(resolve))
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  const hello = await next()
  ok(
    'hello frame',
    hello.t === 'hello' && hello.version === '1.2.3' && hello.secure === false,
    JSON.stringify(hello)
  )
  let id = 0
  const invoke = async (channel: string, ...args: unknown[]): Promise<Record<string, unknown>> => {
    const myId = ++id
    ws.send(JSON.stringify({ t: 'invoke', id: myId, channel, args }))
    const skipped: Array<Record<string, unknown>> = []
    for (;;) {
      const f = await next()
      if (f.t === 'result' && f.id === myId) {
        // Anything that arrived meanwhile (a segment racing its result) is
        // put back, in order, for the waiter that expects it.
        queue.unshift(...skipped)
        return f
      }
      skipped.push(f)
    }
  }
  const info = await invoke('system:getInfo')
  ok(
    'invoke answered from the handler map',
    info.ok === true && (info.value as { platform: string }).platform === 'test',
    JSON.stringify(info)
  )
  const unknown = await invoke('nope:nothing')
  ok(
    'unknown channel errors',
    unknown.ok === false && /unknown channel/.test(String(unknown.error))
  )
  const thrown = await invoke('throws')
  ok('handler error relayed', thrown.ok === false && thrown.error === 'boom')
  const refused = await invoke('upload:pickFile')
  ok(
    'GUI-only channel refused',
    refused.ok === false && /desktop window/.test(String(refused.error)),
    JSON.stringify(refused)
  )
  const bin = await invoke('echo:bin', { $bin: Buffer.from('abc').toString('base64') })
  ok(
    'binary args decoded, results encoded',
    bin.ok === true &&
      (bin.value as { got: boolean; length: number; back: { $bin: string } }).got === true &&
      (bin.value as { length: number }).length === 3 &&
      Buffer.from((bin.value as { back: { $bin: string } }).back.$bin, 'base64').toString() ===
        'hi',
    JSON.stringify(bin)
  )
  // A result too big for one frame answers as an error and the socket
  // lives on — the alternative was a V8 zone OOM that took the app down.
  const big = await invoke('echo:bigbin')
  ok(
    'oversized binary result refused with a reason',
    big.ok === false && /33\.0 MB of binary data is too large/.test(String(big.error)),
    JSON.stringify(big)
  )
  const split = await invoke('echo:bigbin:split')
  ok(
    'binary budget is per frame, not per blob',
    split.ok === false && /40\.0 MB/.test(String(split.error)),
    JSON.stringify(split)
  )
  const alive = await invoke('system:getInfo')
  ok('socket still answers after a refused result', alive.ok === true)
  const url = await invoke('upload:fileUrl', 'uploads/conv_x/hello world.txt')
  ok(
    'fileUrl rewritten to the files route',
    url.value === '/files/uploads/conv_x/hello%20world.txt',
    String(url.value)
  )
  const absolute = path.join(workspace, 'uploads', 'conv_x', 'hello.txt')
  const absUrl = await invoke('upload:fileUrl', absolute)
  ok(
    'fileUrl from an absolute workspace path is workspace-relative',
    absUrl.value === '/files/uploads/conv_x/hello.txt',
    String(absUrl.value)
  )
  const legacy = await call(
    `${base}/files/${absolute.split('/').map(encodeURIComponent).join('/')}`,
    { cookie }
  )
  ok(
    'a link built from an absolute path (old form) is still served',
    legacy.status === 200 && legacy.text.startsWith('hello world'),
    String(legacy.status)
  )
  const dl = await invoke('upload:download', 'uploads/conv_x/hello.txt')
  ok(
    'download rewritten',
    (dl.value as { downloadUrl: string }).downloadUrl === '/download/uploads/conv_x/hello.txt'
  )
  const dev = await invoke('upload:downloadPath', '/tmp/x y.txt')
  ok(
    'device download rewritten',
    (dev.value as { downloadUrl: string }).downloadUrl === '/device?path=%2Ftmp%2Fx%20y.txt'
  )
  const ext = await invoke('browser:openExternal', { url: 'https://example.com/' })
  ok(
    'openExternal becomes an openUrl',
    (ext.value as { openUrl: string }).openUrl === 'https://example.com/'
  )
  const extBad = await invoke('browser:openExternal', { url: 'javascript:alert(1)' })
  ok('openExternal refuses non-http', (extBad.value as { ok: boolean }).ok === false)
  const mic = await invoke('mic:checkAccess')
  ok('mic access granted on web', mic.value === 'granted')
  const pdf = await invoke('chat:exportPdf', { html: '<p>hi</p>', fileName: 'My: chat.pdf' })
  const pdfUrl = (pdf.value as { downloadUrl: string }).downloadUrl
  ok('pdf export rewritten', pdf.ok === true && pdfUrl.startsWith('/pdf/'), JSON.stringify(pdf))
  const pdfRes = await call(`${base}${pdfUrl}`, { cookie })
  ok(
    'pdf downloadable once',
    pdfRes.status === 200 &&
      pdfRes.text === 'PDF:9' &&
      /My- chat\.pdf/.test(decodeURIComponent(pdfRes.headers.get('content-disposition') ?? ''))
  )
  ok('pdf gone after download', (await call(`${base}${pdfUrl}`, { cookie })).status === 404)

  // Per-connection streaming: chat:send's sender is THIS socket. The segment
  // and the result race, so both frames are read and matched by shape.
  const sendId = ++id
  ws.send(
    JSON.stringify({ t: 'invoke', id: sendId, channel: 'chat:send', args: [{ history: [] }] })
  )
  const pair = [await next(), await next()]
  const segment = pair.find((f) => f.t === 'event')
  const sent = pair.find((f) => f.t === 'result' && f.id === sendId)
  ok(
    'segment streamed to the sending socket',
    segment?.channel === 'chat:segment',
    JSON.stringify(pair)
  )
  ok(
    'chat:send answered',
    sent?.ok === true && (sent?.value as { turnId: string }).turnId === 't1',
    JSON.stringify(pair)
  )

  // Broadcasts reach every socket.
  const bcast = next()
  server.pushBroadcast('theme:updated', { dark: true })
  const got = await bcast
  ok(
    'broadcast delivered',
    got.channel === 'theme:updated' && (got.payload as { dark: boolean }).dark === true
  )

  console.log('step: a page keeps its turn across a reconnect')
  // A phone locks mid-answer: the socket that started the turn closes, the
  // turn keeps emitting, and the same page reconnects. Bound to the socket,
  // those events (chat:done included) were lost and the page froze "working".
  const pageA = await openSocket(cookie, 'pageAAAA1111')
  const helloA = await pageA.next()
  ok('first connect of a page is not a resume', helloA.resumed === false, JSON.stringify(helloA))
  pageA.ws.send(JSON.stringify({ t: 'invoke', id: 1, channel: 'test:holdSender', args: [] }))
  await pageA.next()
  pageA.ws.close()
  await pageA.closed
  await new Promise((r) => setTimeout(r, 50))
  const held = heldSender as unknown as {
    send: (c: string, p: unknown) => void
    isDestroyed: () => boolean
  }
  ok('a page away within its grace is not destroyed', held.isDestroyed() === false)
  held.send('chat:segment', { n: 1 })
  held.send('chat:segment', { n: 2 })
  held.send('chat:done', { turnId: 't1' })
  const pageA2 = await openSocket(cookie, 'pageAAAA1111')
  const helloA2 = await pageA2.next()
  ok('the same page reconnecting is a resume', helloA2.resumed === true, JSON.stringify(helloA2))
  const replay = [await pageA2.next(), await pageA2.next(), await pageA2.next()]
  ok(
    'events sent while away arrive in order after the hello',
    replay.map((f) => `${f.channel}:${(f.payload as { n?: number }).n ?? ''}`).join(',') ===
      'chat:segment:1,chat:segment:2,chat:done:',
    JSON.stringify(replay)
  )
  held.send('chat:segment', { n: 3 })
  ok(
    'live events reach the reconnected socket',
    ((await pageA2.next()).payload as { n: number }).n === 3
  )
  const otherPage = await openSocket(cookie, 'pageBBBB2222')
  const helloB = await otherPage.next()
  held.send('chat:segment', { n: 4 })
  ok('a different page is not a resume', helloB.resumed === false)
  ok('the page still gets its events', ((await pageA2.next()).payload as { n: number }).n === 4)
  const stray = await Promise.race([
    otherPage.next().then(() => 'leaked'),
    new Promise((r) => setTimeout(() => r('quiet'), 150))
  ])
  ok("another page never sees this page's events", stray === 'quiet')
  otherPage.ws.close()
  pageA2.ws.close()
  await pageA2.closed

  console.log('step: upload → staged → consumed by upload:saveFile')
  const up = await fetch(`${base}/api/upload?name=${encodeURIComponent('my photo.png')}`, {
    method: 'POST',
    headers: { cookie, origin: base, 'content-type': 'application/octet-stream' },
    body: Buffer.from('PNGDATA')
  })
  const staged = (await up.json()) as { ok: boolean; path: string; name: string; size: number }
  ok(
    'upload staged with its name',
    up.status === 200 &&
      staged.ok &&
      staged.name === 'my photo.png' &&
      staged.size === 7 &&
      existsSync(staged.path),
    JSON.stringify(staged)
  )
  ok(
    'staged under the workspace pending dir',
    staged.path.startsWith(path.join(workspace, 'uploads', '.pending', 'web-'))
  )
  const saved = await invoke('upload:saveFile', {
    conversationId: 'conv_x',
    sourcePath: staged.path
  })
  ok('saveFile got the staged path', saved.ok === true && savedFrom === staged.path)
  ok('staged copy removed after saveFile', !existsSync(staged.path))
  const empty = await fetch(`${base}/api/upload?name=x.txt`, {
    method: 'POST',
    headers: { cookie, origin: base },
    body: ''
  })
  ok('empty upload refused', empty.status === 400)
  const crossUpload = await fetch(`${base}/api/upload?name=x.txt`, {
    method: 'POST',
    headers: { cookie, origin: 'http://evil.example' },
    body: 'x'
  })
  ok('cross-origin upload refused', crossUpload.status === 403)
  const up2 = await fetch(`${base}/api/upload?name=a.txt`, {
    method: 'POST',
    headers: { cookie, origin: base },
    body: 'A'
  })
  const staged2 = (await up2.json()) as { path: string }
  const attached = await invoke('web:attachFiles', {
    kind: 'project',
    id: 'p1',
    paths: [staged2.path]
  })
  ok(
    'attachFiles reaches the helper and consumes the staged copy',
    (attached.value as { attached: number; kind: string }).attached === 1 &&
      !existsSync(staged2.path)
  )

  console.log('step: push subscriptions + notify')
  const badSub = await call(`${base}/api/push/subscribe`, {
    method: 'POST',
    cookie,
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'http://not-https', keys: {} })
  })
  ok('bad subscription refused', badSub.status === 400)
  const goodKeys = {
    p256dh:
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg'
  }
  const sub = await call(`${base}/api/push/subscribe`, {
    method: 'POST',
    cookie,
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'https://push.invalid/endpoint', keys: goodKeys })
  })
  ok('subscription stored', sub.status === 200, sub.text)
  ok('status counts the subscription', (await server.status()).subscriptions === 1)
  const inband = next()
  const notified = await server.notify({
    title: 'T',
    body: 'B',
    phase: 'info',
    urgency: 'normal',
    url: '/?conversation=c1',
    conversationId: 'c1'
  })
  const notifyFrame = await inband
  ok(
    'in-band notify frame',
    notifyFrame.channel === 'web:notify' &&
      (notifyFrame.payload as { title: string; url: string }).title === 'T' &&
      (notifyFrame.payload as { url: string }).url === '/?conversation=c1',
    JSON.stringify(notifyFrame)
  )
  ok(
    'notify counts: 1 in-band, push failed (unreachable endpoint)',
    notified.inband === 1 && notified.pushed === 0 && notified.failed === 1,
    JSON.stringify(notified)
  )
  await call(`${base}/api/push/unsubscribe`, {
    method: 'POST',
    cookie,
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'https://push.invalid/endpoint' })
  })
  ok('unsubscribed', (await server.status()).subscriptions === 0)

  console.log('step: public links')
  mkdirSync(path.join(workspace, 'files', 'site', 'css'), { recursive: true })
  writeFileSync(path.join(workspace, 'files', 'report.txt'), 'public report body')
  writeFileSync(path.join(workspace, 'files', 'site', 'index.html'), '<h1>site</h1>')
  writeFileSync(path.join(workspace, 'files', 'site', 'css', 'a.css'), 'h1{}')
  ok('no public links yet', (await server.status()).publicLinks === 0)
  ok('public origin is the app address', (await server.status()).publicOrigin === base)
  const fileShare = (
    await server.publicShares.create({
      kind: 'file',
      path: path.join(workspace, 'files', 'report.txt'),
      port: null,
      name: 'Report',
      download: false,
      ttlMs: null,
      conversationId: null
    })
  ).share
  const fileUrl = `${base}/p/${fileShare.token}`
  const pubFile = await call(fileUrl)
  ok(
    'file share served with no cookie',
    pubFile.status === 200 && pubFile.text === 'public report body',
    `${pubFile.status}`
  )
  ok('file share is inline by default', !pubFile.headers.get('content-disposition'))
  ok('file share is cacheable publicly', /public/.test(pubFile.headers.get('cache-control') ?? ''))
  ok('file share HEAD', (await call(fileUrl, { method: 'HEAD' })).status === 200)
  ok(
    '?download=1 forces an attachment',
    /attachment/.test(
      (await call(`${fileUrl}?download=1`)).headers.get('content-disposition') ?? ''
    )
  )
  ok('file share refuses a sub-path', (await call(`${fileUrl}/x`)).status === 404)
  ok('file share refuses POST', (await call(fileUrl, { method: 'POST' })).status === 405)
  ok('a wrong token is 404', (await call(`${base}/p/${'x'.repeat(32)}`)).status === 404)
  ok('a short token is 404', (await call(`${base}/p/abc`)).status === 404)
  const listed = await server.listPublicShares()
  ok(
    'listed with url and hits',
    listed.length === 1 && listed[0].url === fileUrl && listed[0].hits >= 5,
    JSON.stringify(listed)
  )

  const siteShare = (
    await server.publicShares.create({
      kind: 'site',
      path: path.join(workspace, 'files', 'site'),
      port: null,
      name: 'Site',
      download: false,
      ttlMs: null,
      conversationId: null
    })
  ).share
  const siteUrl = `${base}/p/${siteShare.token}`
  const bare = await call(siteUrl)
  ok(
    'site bare token redirects to the slash form',
    bare.status === 301 && bare.headers.get('location') === `/p/${siteShare.token}/`
  )
  const siteIndex = await call(`${siteUrl}/`)
  ok('site root is index.html', siteIndex.status === 200 && siteIndex.text === '<h1>site</h1>')
  ok('site asset by relative path', (await call(`${siteUrl}/css/a.css`)).text === 'h1{}')
  const dirRedirect = await call(`${siteUrl}/css`)
  ok(
    'site directory without slash redirects',
    dirRedirect.status === 301 &&
      dirRedirect.headers.get('location') === `/p/${siteShare.token}/css/`
  )
  ok('site missing file is 404', (await call(`${siteUrl}/nope.txt`)).status === 404)
  ok(
    'site extension-less miss falls back to index.html',
    (await call(`${siteUrl}/app/route`)).text === '<h1>site</h1>'
  )
  ok(
    'site traversal refused',
    (await call(`${siteUrl}/..%2f..%2freport.txt`)).status !== 200 &&
      (await call(`${siteUrl}/../report.txt`)).text !== 'public report body'
  )
  ok('site refuses POST', (await call(`${siteUrl}/`, { method: 'POST' })).status === 405)

  // A proxy share: a local app that echoes what it was asked.
  const upstreamSeen: Array<{
    method: string
    url: string
    headers: http.IncomingHttpHeaders
    body: string
  }> = []
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      upstreamSeen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString()
      })
      if (req.url?.startsWith('/go')) {
        res.writeHead(302, { Location: '/landed' })
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Upstream': 'yes' })
      res.end(`upstream ${req.method} ${req.url}`)
    })
  })
  const upstreamWss = new (await import('ws')).WebSocketServer({ server: upstream })
  upstreamWss.on('connection', (sock, req) => {
    sock.on('message', (data) => sock.send(`echo ${req.url} ${data.toString()}`))
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = (upstream.address() as net.AddressInfo).port
  const proxyShare = (
    await server.publicShares.create({
      kind: 'proxy',
      path: null,
      port: upstreamPort,
      name: 'App',
      download: false,
      ttlMs: null,
      conversationId: null
    })
  ).share
  const proxyUrl = `${base}/p/${proxyShare.token}`
  const proxied = await call(`${proxyUrl}/hello?x=1`, { cookie: `wf_session=SECRET; theirs=1` })
  ok(
    'proxy answers',
    proxied.status === 200 &&
      proxied.text === 'upstream GET /hello?x=1' &&
      proxied.headers.get('x-upstream') === 'yes',
    proxied.text
  )
  const upSeen = upstreamSeen[upstreamSeen.length - 1]
  ok(
    'proxy strips the prefix and announces it',
    upSeen.url === '/hello?x=1' && upSeen.headers['x-forwarded-prefix'] === `/p/${proxyShare.token}`
  )
  ok(
    'proxy never forwards the sign-in cookie',
    upSeen.headers.cookie === 'theirs=1',
    String(upSeen.headers.cookie)
  )
  ok(
    'proxy sets forwarded headers',
    upSeen.headers['x-forwarded-proto'] === 'http' &&
      upSeen.headers['x-forwarded-for'] === '127.0.0.1' &&
      upSeen.headers.host === `127.0.0.1:${upstreamPort}`
  )
  const posted = await call(`${proxyUrl}/submit`, {
    method: 'POST',
    body: 'payload=1',
    headers: { 'content-type': 'text/plain' }
  })
  ok(
    'proxy passes a POST body',
    posted.status === 200 && upstreamSeen[upstreamSeen.length - 1].body === 'payload=1'
  )
  const redirected = await call(`${proxyUrl}/go`)
  ok(
    'proxy rewrites an absolute Location under the prefix',
    redirected.status === 302 &&
      redirected.headers.get('location') === `/p/${proxyShare.token}/landed`,
    String(redirected.headers.get('location'))
  )
  const bareProxy = await call(proxyUrl)
  ok(
    'proxy bare token redirects to the slash form',
    bareProxy.status === 301 && bareProxy.headers.get('location') === `/p/${proxyShare.token}/`
  )
  const wsThrough = new WebSocket(`ws://127.0.0.1:${port}/p/${proxyShare.token}/sock`)
  const wsEcho = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws proxy timeout')), 3000)
    wsThrough.on('open', () => wsThrough.send('ping'))
    wsThrough.on('message', (d) => {
      clearTimeout(timer)
      resolve(d.toString())
    })
    wsThrough.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  }).catch((e: Error) => `ERR ${e.message}`)
  ok('proxy carries a websocket', wsEcho === '/sock echo /sock ping'.slice(6), wsEcho)
  wsThrough.close()
  const wsNo = new WebSocket(`ws://127.0.0.1:${port}/p/${fileShare.token}/sock`)
  const wsNoResult = await new Promise<string>((resolve) => {
    wsNo.on('error', (e) => resolve(`error ${e.message}`))
    wsNo.on('open', () => resolve('open'))
  })
  ok('websocket under a file share is refused', /404/.test(wsNoResult), wsNoResult)
  upstream.close()
  const dead = await call(`${proxyUrl}/hello`)
  ok('proxy to a dead port is 502', dead.status === 502)

  ok('status counts links', (await server.status()).publicLinks === 3)
  ok('revoke by id', (await server.revokePublicShare(fileShare.id)) === true)
  ok('revoked link is 404', (await call(fileUrl)).status === 404)
  const expiring = (
    await server.publicShares.create({
      kind: 'file',
      path: path.join(workspace, 'files', 'site', 'css', 'a.css'),
      port: null,
      name: 'short',
      download: false,
      ttlMs: 1,
      conversationId: null
    })
  ).share
  await new Promise((r) => setTimeout(r, 10))
  ok('expired link is 404', (await call(`${base}/p/${expiring.token}`)).status === 404)

  console.log('step: sessions + logout')
  const sessions = await server.listSessions()
  ok('one session listed', sessions.length === 1 && sessions[0].address === '127.0.0.1')
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)))
  const logout = await call(`${base}/api/auth/logout`, {
    method: 'POST',
    cookie,
    headers: { origin: base }
  })
  ok(
    'logout clears the cookie',
    logout.status === 200 && /Max-Age=0/.test(logout.headers.get('set-cookie') ?? '')
  )
  ok('logout closes the socket with 4001', (await closed) === 4001)
  ok(
    'old cookie no longer valid',
    ((await call(`${base}/api/auth/status`, { cookie })).json() as { authenticated: boolean })
      .authenticated === false
  )
  ok('no sessions left', (await server.listSessions()).length === 0)
  ok('status changes were announced', statusChanges > 0)

  // applyConfig rebinds the listeners (port 0 → a new OS port): this runs last.
  console.log('step: public links over the port-80 listener and self-signed HTTPS')
  // Port 0 means "no port-80 listener" to the server, so a free one is picked here.
  const freePort = await new Promise<number>((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const p = (probe.address() as net.AddressInfo).port
      probe.close(() => resolve(p))
    })
  })
  config = {
    ...config,
    https: { mode: 'selfsigned' as never, port: 0, httpPort: freePort } as never
  }
  await server.applyConfig()
  const st2 = await server.status()
  ok(
    'https listening (self-signed)',
    st2.listening && st2.scheme === 'https' && (st2.httpsPort ?? 0) > 0 && (st2.httpPort ?? 0) > 0,
    JSON.stringify({
      scheme: st2.scheme,
      httpsPort: st2.httpsPort,
      httpPort: st2.httpPort,
      error: st2.error
    })
  )
  ok(
    'self-signed: public origin stays plain http',
    st2.publicOrigin === `http://127.0.0.1:${st2.port}`,
    String(st2.publicOrigin)
  )
  const viaHttps = await new Promise<{ status: number; text: string }>((resolve) => {
    const r = https.request(
      {
        host: '127.0.0.1',
        port: st2.httpsPort ?? 0,
        path: `/p/${siteShare.token}/`,
        rejectUnauthorized: false
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() })
        )
      }
    )
    r.on('error', (e) => resolve({ status: -1, text: e.message }))
    r.end()
  })
  ok(
    'public link served over HTTPS with no cookie',
    viaHttps.status === 200 && viaHttps.text === '<h1>site</h1>',
    `${viaHttps.status} ${viaHttps.text}`
  )
  const viaPlain = await call(`http://127.0.0.1:${st2.port}/p/${siteShare.token}/`)
  ok(
    'public link still served on the plain app port',
    viaPlain.status === 200 && viaPlain.text === '<h1>site</h1>',
    `${viaPlain.status}`
  )
  const via80 = await call(`http://127.0.0.1:${st2.httpPort}/p/${siteShare.token}/`)
  ok(
    'public link served directly on the port-80 listener (no redirect)',
    via80.status === 200 && via80.text === '<h1>site</h1>',
    `${via80.status} ${via80.headers.get('location') ?? ''}`
  )
  const other80 = await call(`http://127.0.0.1:${st2.httpPort}/anything`)
  ok('the port-80 listener still redirects everything else', other80.status === 301)
  config = { ...config, https: { mode: 'off' as const, httpPort: null } }
  await server.applyConfig()
  ok('back to http', (await server.status()).scheme === 'http')
  ok(
    'revoke all',
    (await server.revokeAllPublicShares()) === 2 && (await server.status()).publicLinks === 0
  )

  await server.stop()
  ok('stopped', !(await server.status()).listening)
  console.log(`web-server: ${passed} passed, ${failed} failed`)
  // Explicit: a listener or socket left open by a failed step must not keep
  // the process alive forever.
  process.exit(failed > 0 ? 1 : 0)
}

void run().catch((err) => {
  console.error(err)
  process.exit(1)
})
