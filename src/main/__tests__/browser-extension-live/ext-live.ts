/**
 * Live end-to-end harness for the browser extension (see README.md).
 *
 * Real ExtensionServer + real extension build + throwaway Chromium. Every
 * check is a wire round trip or a page-side assertion; nothing is mocked
 * except Electron. HOME is a scratch dir (enforced by the boot shim).
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

import { readEvents } from '../../channels/extension/log'
import { ExtensionServer } from '../../channels/extension/server'
import { ensureBridgeToken, extensionFolderPath } from '../../workspace/workspace'

const PORT = Number(process.env.WOLFFISH_E2E_PORT ?? 23191)
const HEADED = process.env.WOLFFISH_E2E_HEADED === '1'
const PW_ROOT = process.env.WOLFFISH_PW_ROOT ?? '/tmp/wf-pw'
const EXT_DIST = path.resolve(process.env.WOLFFISH_EXT_DIST ?? '../wolffish-extension/dist')

/** The slice of Playwright's surface this harness uses. */
interface Page {
  url: () => string
  goto: (url: string) => Promise<unknown>
  evaluate: <T>(fn: () => T) => Promise<T>
  close: () => Promise<void>
}
interface BrowserContext {
  serviceWorkers: () => Array<{ evaluate: (script: string) => Promise<unknown> }>
  pages: () => Page[]
  newPage: () => Promise<Page>
  close: () => Promise<void>
}

type Check = { name: string; run: () => Promise<void> }
const checks: Check[] = []
const check = (name: string, run: () => Promise<void>): void => {
  checks.push({ name, run })
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const until = async (
  pred: () => boolean | Promise<boolean>,
  ms: number,
  what: string
): Promise<void> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await pred()) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

// ─── Fixture page ──────────────────────────────────────────────────────────

const FIXTURE_HTML = `<!doctype html><html><head><title>WF Fixture</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<h1>Wolffish fixture</h1>
<nav aria-label="Main"><a id="link-terms" href="/terms">Terms</a></nav>
<main>
<form id="form" action="/submitted" method="get">
  <label for="email">Email</label><input id="email" name="email" type="email" placeholder="you@example.com" required>
  <label for="notes">Notes</label><textarea id="notes" name="notes"></textarea>
  <label for="plan">Plan</label>
  <select id="plan" name="plan"><option value="f">Free</option><option value="p">Pro</option></select>
  <label><input id="agree" name="agree" type="checkbox"> I agree</label>
  <div id="editor" contenteditable="true" aria-label="Editor"></div>
  <input id="file" name="file" type="file">
  <button id="btn" type="button">Press me</button>
  <button id="submit" type="submit">Submit</button>
</form>
<button id="alert-btn" type="button" onclick="setTimeout(()=>alert('wf-alert'),30)">Alert</button>
<button id="fetch-btn" type="button" onclick="fetch('/api/ping').then(r=>r.text()).then(t=>console.log('wf-hello '+t))">Fetch</button>
<a id="dl" href="/file.txt" download="wf-download.txt">Download</a>
<iframe id="frame" src="/frame" title="Inner"></iframe>
<div id="late" hidden>Late text arrived</div>
<div id="tall" style="height:3000px;background:linear-gradient(#fff,#ccc)"></div>
<p id="bottom">The very bottom</p>
</main>
<script>
document.getElementById('btn').addEventListener('click', () => { document.getElementById('btn').dataset.clicked = '1'; document.body.appendChild(document.createElement('p')).textContent = 'clicked'; })
setTimeout(() => { document.getElementById('late').hidden = false }, 1500)
</script>
</body></html>`

const startFixture = (): Promise<{ server: Server; port: number }> =>
  new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? '/'
      if (url === '/api/ping') {
        res.setHeader('content-type', 'text/plain')
        res.end('pong')
      } else if (url === '/file.txt') {
        res.setHeader('content-type', 'text/plain')
        res.end('hello file')
      } else if (url === '/frame') {
        res.setHeader('content-type', 'text/html')
        res.end('<html><body><button id="inner">Inner button</button></body></html>')
      } else if (url === '/terms') {
        res.setHeader('content-type', 'text/html')
        res.end('<html><head><title>Terms</title></head><body><h1>Terms page</h1></body></html>')
      } else if (url.startsWith('/submitted')) {
        res.setHeader('content-type', 'text/html')
        res.end('<html><head><title>Submitted</title></head><body><h1>Submitted</h1></body></html>')
      } else {
        res.setHeader('content-type', 'text/html')
        res.end(FIXTURE_HTML)
      }
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 })
    })
  })

// ─── Main ──────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  assert.ok(existsSync(path.join(EXT_DIST, 'manifest.json')), `no extension build at ${EXT_DIST}`)
  // Playwright lives in a scratch folder outside this repo (see README), so it
  // is resolved at runtime, not compiled against.
  const pwRequire = createRequire(path.join(PW_ROOT, 'package.json'))
  const { chromium } = pwRequire('playwright') as {
    chromium: {
      launchPersistentContext: (
        dir: string,
        opts: Record<string, unknown>
      ) => Promise<BrowserContext>
    }
  }

  // Scratch workspace: the runtime extension folder is what the server
  // version-checks against, and where the bridge token is written.
  const extFolder = extensionFolderPath()
  await fs.mkdir(extFolder, { recursive: true })
  await fs.cp(EXT_DIST, extFolder, { recursive: true, force: true })
  const token = await ensureBridgeToken()
  assert.ok(token.length >= 32, 'bridge token written')

  const fixture = await startFixture()
  const base = `http://127.0.0.1:${fixture.port}`

  const server = new ExtensionServer()
  const started = await server.start({ port: PORT })
  assert.equal(started.status, 'listening', `server listening: ${started.error ?? ''}`)

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-ext-e2e-'))
  const context = await chromium.launchPersistentContext(userDataDir, {
    // The headless *shell* cannot load extensions; the full Chromium can, in
    // both headed and new-headless mode. Branded Chrome 137+ dropped
    // --load-extension entirely, which is why this uses Playwright's build.
    channel: 'chromium',
    headless: !HEADED,
    args: [
      `--disable-extensions-except=${extFolder}`,
      `--load-extension=${extFolder}`,
      '--no-first-run'
    ],
    viewport: { width: 1200, height: 800 }
  })

  // Point the extension at this harness's port. A running Wolffish app owns
  // the default 23151, so the harness must never use it — and the extension
  // dials that default once, at browser start, before we can say otherwise.
  // Re-assert the port until the extension lands here: an MV3 worker can be
  // asleep when the first write goes in, and the write is what wakes it.
  await until(() => context.serviceWorkers().length > 0, 20000, 'extension service worker')
  const setPort = async (): Promise<void> => {
    const worker = context.serviceWorkers()[0]
    if (!worker) return
    await worker
      .evaluate(`chrome.storage.local.set({ 'wolffish-connection-config': { port: ${PORT} } })`)
      .catch(() => {})
  }
  const deadline = Date.now() + 60_000
  while (!server.isConnected() && Date.now() < deadline) {
    await setPort()
    await sleep(2000)
  }
  assert.ok(server.isConnected(), 'extension connected on the harness port')

  const send = async (
    type: string,
    params: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> => {
    const res = await server.sendCommand(type, params)
    if (!res.success) throw new Error(`${type}: ${res.error}`)
    return (res.data ?? {}) as Record<string, unknown>
  }
  const sendRaw = (
    type: string,
    params: Record<string, unknown> = {}
  ): Promise<{ success: boolean; data?: unknown; error?: string }> =>
    server.sendCommand(type, params)
  const pageOf = async (urlPart: string): Promise<Page> => {
    await until(
      () => context.pages().some((p) => p.url().includes(urlPart)),
      10000,
      `page ${urlPart}`
    )
    return context.pages().find((p) => p.url().includes(urlPart))!
  }

  let tabId = 0
  let snapshotText = ''
  const uidOf = (line: RegExp): string => {
    const m = snapshotText.split('\n').find((l) => line.test(l))
    assert.ok(m, `snapshot line matching ${line} in:\n${snapshotText}`)
    return /uid=([^\s]+)/.exec(m!)![1]
  }
  /** Re-snapshot, then resolve uids against it. uids belong to one page state. */
  const freshUid = async (line: RegExp): Promise<string> => {
    const r = await send('browser_take_snapshot', { tabId })
    snapshotText = String(r.snapshot)
    return uidOf(line)
  }

  // ── Handshake + transport ─────────────────────────────────────────────
  check('handshake carries extensionId, token match, overlay flag', async () => {
    const b = server.getStatus().browsers[0]
    assert.ok(b, 'one browser')
    assert.match(String(b.extensionId), /^[a-p]{32}$/)
    assert.equal(b.legacy, false)
    assert.equal(b.overlayEnabled, true)
  })

  check('a socket with a foreign origin is dropped', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, {
      headers: { origin: 'https://evil.example' }
    })
    const closed = new Promise<void>((r) => ws.on('close', () => r()))
    ws.on('error', () => {})
    await Promise.race([
      closed,
      sleep(3000).then(() => assert.fail('foreign origin stayed connected'))
    ])
  })

  check('a wrong bridge token is terminated, a missing one is legacy', async () => {
    const bad = new WebSocket(`ws://127.0.0.1:${PORT}`, {
      headers: { origin: 'chrome-extension://abc' }
    })
    await new Promise<void>((r) => bad.on('open', () => r()))
    bad.send(
      JSON.stringify({
        type: 'extension_info',
        version: '0.0.1',
        instanceId: 'bad',
        browser: 'chrome',
        browserName: 'X',
        bridgeToken: 'nope'
      })
    )
    await Promise.race([
      new Promise<void>((r) => bad.on('close', () => r())),
      sleep(3000).then(() => assert.fail('bad token stayed connected'))
    ])
    const legacy = new WebSocket(`ws://127.0.0.1:${PORT}`, {
      headers: { origin: 'chrome-extension://abc' }
    })
    await new Promise<void>((r) => legacy.on('open', () => r()))
    legacy.send(
      JSON.stringify({
        type: 'extension_info',
        version: '0.0.1',
        instanceId: 'legacy',
        browser: 'edge',
        browserName: 'Legacy'
      })
    )
    await until(
      () => server.getStatus().browsers.some((b) => b.instanceId === 'legacy'),
      3000,
      'legacy listed'
    )
    const row = server.getStatus().browsers.find((b) => b.instanceId === 'legacy')
    assert.equal(row?.legacy, true)
    legacy.close()
    await until(
      () => !server.getStatus().browsers.some((b) => b.instanceId === 'legacy'),
      3000,
      'legacy gone'
    )
  })

  // ── Doctor with a healthy browser ─────────────────────────────────────
  check('doctor reports no blockers with a healthy browser', async () => {
    const report = await server.doctor({})
    const blockers = report.findings.filter((f) => f.severity === 'blocker')
    assert.deepEqual(
      blockers.map((f) => f.id),
      [],
      `blockers: ${JSON.stringify(blockers)}`
    )
    assert.equal(report.ready, true)
    assert.ok(report.summary.length > 10)
  })

  // ── Page + DOM snapshot (no session yet) ──────────────────────────────
  check('navigate lands on the fixture', async () => {
    const r = await send('browser_navigate', { url: `${base}/` })
    tabId = Number(r.tabId)
    assert.ok(tabId > 0)
    assert.equal(r.title, 'WF Fixture')
  })

  check('dom snapshot has uids, roles and text', async () => {
    const r = await send('browser_take_snapshot', {})
    snapshotText = String(r.snapshot)
    assert.equal(r.source, 'dom')
    assert.match(snapshotText, /uid=\d+_\d+ heading "Wolffish fixture" level=1/)
    assert.match(snapshotText, /uid=\d+_\d+ textbox "Email"/)
    assert.match(snapshotText, /uid=\d+_\d+ button "Press me"/)
    assert.match(snapshotText, /uid=\d+_\d+ link "Terms" .*href="\/terms"/)
    assert.match(snapshotText, /combobox "Plan"/)
    assert.match(snapshotText, /checkbox "I agree"/)
    assert.match(snapshotText, /button "Inner button"/)
    assert.ok(Number(r.nodeCount) > 8)
  })

  check('dom-path click by uid works and reports aftermath', async () => {
    const uid = await freshUid(/button "Press me"/)
    const r = await send('browser_click', { uid })
    assert.equal(r.success, true)
    assert.equal(r.domChanged, true, `aftermath: ${JSON.stringify(r)}`)
    const v = await send('browser_execute_js', {
      code: `document.getElementById('btn').dataset.clicked`
    })
    assert.equal(v.result, '1')
  })

  check('fullPage screenshot without a session is an explicit error', async () => {
    const res = await sendRaw('browser_screenshot', { fullPage: true })
    assert.equal(res.success, false)
    assert.match(String(res.error), /need the debugger/i)
  })

  // ── CDP session ───────────────────────────────────────────────────────
  check('attach a per-tab session', async () => {
    const r = await send('browser_debugger_attach', { tabId })
    assert.equal(r.success, true)
    const st = await send('browser_debugger_status', {})
    assert.ok((st.tabs as number[]).includes(tabId), `tabs: ${JSON.stringify(st.tabs)}`)
  })

  check('cdp snapshot is stable across two takes', async () => {
    const a = await send('browser_take_snapshot', {})
    assert.equal(a.source, 'cdp')
    snapshotText = String(a.snapshot)
    assert.match(snapshotText, /uid=\d+_\d+ button "Press me"/)
    const b = await send('browser_take_snapshot', {})
    const uidA = uidOf(/button "Press me"/)
    snapshotText = String(b.snapshot)
    const uidB = uidOf(/button "Press me"/)
    assert.equal(uidA, uidB, 'uid stable for an unchanged node')
    assert.ok(
      !/\*uid=\d+_\d+ button "Press me"/.test(snapshotText),
      'unchanged node not marked new'
    )
    assert.ok(!/inlinetextbox/.test(snapshotText), 'accessibility text fragments are filtered out')
    assert.ok(!/ ""/.test(snapshotText), 'unnamed nodes omit the empty name')
    assert.match(snapshotText, /^uid=\d+_\d+ RootWebArea "WF Fixture"/m)
  })

  check('fill: text, select by label, checkbox, contenteditable', async () => {
    await send('browser_fill', { uid: await freshUid(/textbox "Email"/), value: 'a@b.co' })
    await send('browser_fill', { uid: uidOf(/combobox "Plan"/), value: 'Pro' })
    await send('browser_fill', { uid: uidOf(/checkbox "I agree"/), value: 'true' })
    await send('browser_fill', { uid: uidOf(/textbox "Editor"/), value: 'edited' })
    const v = await send('browser_execute_js', {
      code: `JSON.stringify([email.value, plan.value, agree.checked, editor.textContent])`
    })
    assert.equal(v.result, JSON.stringify(['a@b.co', 'p', true, 'edited']))
    const bad = await sendRaw('browser_fill', { uid: uidOf(/checkbox "I agree"/), value: 'yes' })
    assert.match(String(bad.error), /"true" or "false"/)
  })

  check('fill_form fills several and reports partial failures', async () => {
    const r = await send('browser_fill_form', {
      elements: [
        { uid: await freshUid(/textbox "Email"/), value: 'c@d.co' },
        { selector: '#does-not-exist', value: 'x' }
      ]
    })
    assert.equal(r.filled, 1)
    assert.equal((r.failures as unknown[]).length, 1)
  })

  check('find scores the submit button first', async () => {
    const r = await send('browser_find', { query: 'submit' })
    const first = (r.elements as Array<Record<string, unknown>>)[0]
    assert.ok(first, 'a match')
    assert.equal(first.role, 'button')
    assert.match(String(first.text), /Submit/)
  })

  check('type: non-ASCII lands through the CDP path', async () => {
    const notes = await freshUid(/textbox "Notes"/)
    await send('browser_type', {
      uid: notes,
      text: 'مرحبا 👋 ok',
      clearFirst: true,
      humanize: false
    })
    const v = await send('browser_get_value', { uid: notes })
    assert.equal(v.value, 'مرحبا 👋 ok')
  })

  check('cdp screenshot: viewport, fullPage, and uid clip', async () => {
    const vp = await send('browser_screenshot', {})
    assert.equal(vp.mode, 'cdp')
    // Not exactly 1200: a headed window's scrollbar narrows the layout viewport.
    assert.ok(Number(vp.cssWidth) > 1100 && Number(vp.cssWidth) <= 1200, `cssWidth ${vp.cssWidth}`)
    const full = await send('browser_screenshot', { fullPage: true })
    assert.ok(Number(full.cssHeight) > 2500, `fullPage css height ${full.cssHeight}`)
    const clip = await send('browser_screenshot', { uid: await freshUid(/button "Press me"/) })
    assert.ok(
      Number(clip.cssHeight) < 100 && Number(clip.cssWidth) < 400,
      `clip ${clip.cssWidth}x${clip.cssHeight}`
    )
  })

  check('overlay: present on the touched tab, absent on an untouched one', async () => {
    const page = await pageOf(`127.0.0.1:${fixture.port}`)
    const present = await page.evaluate(() => !!document.querySelector('wolffish-overlay'))
    assert.equal(present, true, 'overlay host mounted on the driven tab')
    const other = await context.newPage()
    await other.goto(`${base}/terms`)
    await sleep(300)
    const absent = await other.evaluate(() => !!document.querySelector('wolffish-overlay'))
    assert.equal(absent, false, 'no overlay on a tab Wolffish never touched')
    await other.close()
  })

  check('a navigation keeps its own document request', async () => {
    // Page.frameNavigated arrives after the document request is recorded, so a
    // naive clear-on-navigate loses it — and a page with no subresources then
    // lists nothing at all. Re-navigate with the session attached and check.
    await send('browser_navigate', { url: `${base}/terms`, tabId })
    await sleep(400)
    const list = await send('browser_list_network_requests', { tabId })
    const doc = (list.requests as Array<Record<string, unknown>>).find((r) =>
      String(r.url).endsWith('/terms')
    )
    assert.ok(doc, `document request kept: ${JSON.stringify(list.requests)}`)
    await send('browser_navigate', { url: `${base}/`, tabId })
    await sleep(300)
  })

  check('network ring lists the fetch and returns its body', async () => {
    await send('browser_click', { selector: '#fetch-btn' })
    await sleep(500)
    const list = await send('browser_list_network_requests', {})
    const ping = (list.requests as Array<Record<string, unknown>>).find((r) =>
      String(r.url).endsWith('/api/ping')
    )
    assert.ok(ping, `ping request in ${JSON.stringify(list.requests).slice(0, 300)}`)
    const one = await send('browser_get_network_request', { reqid: ping!.reqid })
    assert.equal((one.response as Record<string, unknown>).body, 'pong')
  })

  check('console ring captures console.log', async () => {
    const list = await send('browser_list_console_messages', {})
    const hit = (list.messages as Array<Record<string, unknown>>).find((m) =>
      String(m.text).includes('wf-hello pong')
    )
    assert.ok(hit, `console messages: ${JSON.stringify(list.messages).slice(0, 300)}`)
  })

  check('a JS dialog is answered by the browser and never wedges the tab', async () => {
    // With a debugger attached Chrome answers JS dialogs itself (it reports
    // hasBrowserHandler and closes them within milliseconds), so the tab keeps
    // working rather than freezing. Verified in both headless and headed.
    await send('browser_execute_js', { code: `setTimeout(() => alert('wf-alert'), 30); 'armed'` })
    await sleep(600)
    const after = await send('browser_click', { selector: '#btn' })
    assert.equal(after.success, true, 'the tab still takes input after an alert')
    const h = await send('browser_handle_dialog', { action: 'accept' })
    assert.equal(h.success, true, 'handle_dialog answers honestly when nothing is open')
  })

  check('emulate viewport then clear', async () => {
    const r = await send('browser_emulate', { viewport: '390x844x3,mobile,touch' })
    assert.equal((r.state as Record<string, unknown>).viewport, '390x844x3,mobile,touch')
    const w = await send('browser_execute_js', { code: `window.innerWidth` })
    assert.equal(w.result, 390)
    await send('browser_emulate', { viewport: '' })
    const w2 = await send('browser_execute_js', { code: `window.innerWidth` })
    assert.ok(Number(w2.result) > 1100, `cleared viewport back to ${w2.result}`)
  })

  check('file upload by path', async () => {
    const tmp = path.join(os.tmpdir(), 'wf-upload.txt')
    await fs.writeFile(tmp, 'x')
    const r = await send('browser_file_upload', { selector: '#file', filePaths: [tmp] })
    assert.equal(r.via, 'paths')
    const name = await send('browser_execute_js', {
      code: `document.getElementById('file').files[0]?.name`
    })
    assert.equal(name.result, 'wf-upload.txt')
  })

  check('wait_for text resolves when late text appears', async () => {
    const r = await send('browser_wait_for', {
      text: ['nothing here', 'Late text arrived'],
      timeout: 5000
    })
    assert.equal(r.found, true)
    assert.equal(r.matched, 'Late text arrived')
  })

  check('download reports completion and the final path', async () => {
    const r = await send('browser_download', {
      url: `${base}/file.txt`,
      filename: 'wf-download.txt',
      waitMs: 15000
    })
    assert.equal(r.state, 'complete', JSON.stringify(r))
    assert.ok(String(r.filename).length > 0, 'a final path is reported')
  })

  check('click on a link reports navigation in the aftermath', async () => {
    const r = await send('browser_click', { uid: await freshUid(/link "Terms"/) })
    assert.ok(r.navigated, `navigated: ${JSON.stringify(r)}`)
    assert.match(String((r.navigated as Record<string, unknown>).url), /\/terms$/)
    const stale = await sendRaw('browser_click', { uid: uidOf(/link "Terms"/) })
    assert.equal(stale.success, false)
    assert.match(String(stale.error), /Take a new snapshot|No snapshot/)
  })

  check('detach clears the session and snapshots fall back to dom', async () => {
    await send('browser_debugger_detach', { tabId })
    const st = await send('browser_debugger_status', {})
    assert.deepEqual(st.tabs, [])
    const r = await send('browser_take_snapshot', {})
    assert.equal(r.source, 'dom')
  })

  // ── One workspace per conversation ────────────────────────────────────
  // Fresh ids per run: the scratch HOME survives between runs, and an event
  // log left by an earlier run would answer for this one.
  const RUN = Date.now().toString(36)
  const CONV_X = `conv-x-${RUN}`
  const CONV_LI = `conv-li-${RUN}`
  const CONV_UI = `conv-ui-${RUN}`

  check('each conversation gets its own tab group, tab and title', async () => {
    const worker = context.serviceWorkers()[0]
    const sendAs = async (
      conversationId: string,
      type: string,
      params: Record<string, unknown> = {}
    ): Promise<Record<string, unknown>> => {
      const res = await server.sendCommand(type, params, { conversationId })
      if (!res.success) throw new Error(`${type} as ${conversationId}: ${res.error}`)
      return (res.data ?? {}) as Record<string, unknown>
    }
    const groupOf = async (id: number): Promise<number> =>
      Number(await worker.evaluate(`chrome.tabs.get(${id}).then(t => t.groupId)`))
    const titleOf = async (groupId: number): Promise<string> =>
      String(await worker.evaluate(`chrome.tabGroups.get(${groupId}).then(g => g.title)`))

    // The app window sits on a third conversation the whole time: nothing
    // below may be attributed to it.
    server.setConversationId(CONV_UI, 'What the user has open')

    // Job 1 opens its page and says what it is doing. The navigate names no
    // tab: it has to find job 1's own.
    const x = Number((await sendAs(CONV_X, 'browser_tab_open', {})).tabId)
    const wentX = await sendAs(CONV_X, 'browser_navigate', { url: `${base}/` })
    assert.equal(wentX.tabId, x, 'job 1 navigates its own tab')
    const labelled = await sendAs(CONV_X, 'browser_set_activity', {
      emoji: '📣',
      text: 'Posting on X'
    })
    assert.equal(labelled.applied, true)
    const xGroup = await groupOf(x)
    assert.ok(xGroup >= 0, 'job 1 tab sits in a group')
    assert.equal(await titleOf(xGroup), '📣 Posting on X')

    // Job 2 arrives. Its own tab, its own group, and a title of its own — the
    // regression is that it used to open under "📣 Posting on X".
    const li = Number((await sendAs(CONV_LI, 'browser_tab_open', {})).tabId)
    assert.notEqual(li, x)
    const wentLi = await sendAs(CONV_LI, 'browser_navigate', { url: `${base}/terms` })
    assert.equal(wentLi.tabId, li, "job 2 navigates its own tab, not job 1's")
    const liGroup = await groupOf(li)
    assert.ok(liGroup >= 0 && liGroup !== xGroup, `separate groups: ${xGroup} vs ${liGroup}`)
    assert.equal(await titleOf(liGroup), 'Wolffish')

    // Job 2 labelling its own work leaves job 1's title alone.
    await sendAs(CONV_LI, 'browser_set_activity', { emoji: '💼', text: 'Posting on LinkedIn' })
    assert.equal(await titleOf(xGroup), '📣 Posting on X')
    assert.equal(await titleOf(liGroup), '💼 Posting on LinkedIn')

    // A command that names no tab lands in the sending job's own tab.
    assert.match(String((await sendAs(CONV_X, 'browser_get_url')).url), /127\.0\.0\.1:\d+\/$/)
    assert.match(String((await sendAs(CONV_LI, 'browser_get_url')).url), /\/terms$/)

    // Both are Wolffish's own tabs, whichever job is asking.
    const tabs = (await sendAs(CONV_X, 'browser_tabs_list')).tabs as Array<Record<string, unknown>>
    for (const id of [x, li]) {
      assert.equal(tabs.find((t) => t.id === id)?.wolffish, true, `tab ${id} flagged wolffish`)
    }

    // Resetting one job's label restores its own group title, not the other's.
    await sendAs(CONV_X, 'browser_set_activity', {})
    assert.equal(await titleOf(xGroup), 'Wolffish')
    assert.equal(await titleOf(liGroup), '💼 Posting on LinkedIn')
  })

  check("each job's events are logged under the job, not the open window", async () => {
    const titlesOf = async (id: string): Promise<string[]> =>
      (await readEvents(id)).map((e) => e.title)
    const x = await titlesOf(CONV_X)
    const li = await titlesOf(CONV_LI)

    // Each job's own commands, and only its own.
    assert.ok(
      x.some((t) => /Tab group: 📣 Posting on X/.test(t)),
      `job 1 events: ${JSON.stringify(x)}`
    )
    assert.ok(
      li.some((t) => /Tab group: 💼 Posting on LinkedIn/.test(t)),
      `job 2 events: ${JSON.stringify(li)}`
    )
    assert.ok(!x.some((t) => /LinkedIn/.test(t)), 'job 2 did not write into job 1')
    assert.ok(!li.some((t) => /Posting on X/.test(t)), 'job 1 did not write into job 2')
    assert.ok(
      li.some((t) => /\/terms/.test(t)) && !x.some((t) => /\/terms/.test(t)),
      'the navigations landed in their own logs'
    )

    // And nothing at all went to the conversation the app window was showing.
    assert.deepEqual(await readEvents(CONV_UI), [], 'the open window caught no events')
  })

  check('doctor with no browser names the blocker', async () => {
    await context.close()
    await until(() => !server.isConnected(), 10000, 'browser to disconnect')
    const report = await server.doctor({})
    assert.equal(report.ready, false)
    assert.ok(
      report.findings.some((f) => f.id === 'no_browser_connected'),
      JSON.stringify(report.findings.map((f) => f.id))
    )
  })

  let failed = 0
  for (const c of checks) {
    try {
      await c.run()
      console.log(`ok   ${c.name}`)
    } catch (err) {
      failed++
      console.log(`FAIL ${c.name}\n     ${err instanceof Error ? err.message : String(err)}`)
      if (process.env.WOLFFISH_E2E_CONTINUE !== '1') break
    }
  }

  try {
    await context.close()
  } catch {
    // already closed by the last check
  }
  await server.stop()
  fixture.server.close()
  console.log(failed === 0 ? `\nall ${checks.length} checks passed` : `\n${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
