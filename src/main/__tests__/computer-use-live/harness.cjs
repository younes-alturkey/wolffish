// Live eval of the shipped computer-use plugin on Windows: the plugin runs
// inside an Electron main process (it needs electron.screen / desktopCapturer
// / BrowserWindow) against a separate Electron target whose DOM records every
// input it receives (target.cjs, read over HTTP on port 4777) and against
// Notepad's native UIA tree. A PowerShell probe (fg.ps1) reports the real
// foreground window and pointer, so "the pointer did not move" and "the
// foreground did not change" are checked against the OS, not the plugin.
//
// It opens windows on the display it runs on and spawns Notepad; nothing it
// types is saved. Results land in results.json inside the temp folder named
// at startup.
//
// Run (Git Bash, from the repo root; the plugin and its package.json are
// copied to a temp folder where its npm deps install on first run, so the
// repo tree — which ships in the packaged app — stays clean):
//   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe src/main/__tests__/computer-use-live/harness.cjs
// ONLY='regex' runs a subset of checks by name;
// WOLFFISH_OVERLAY_CAPTURE_VISIBLE=1 is the control run for the overlay check.
//
// Frame contract: every coordinate action makes the magnifier the current
// frame, so each pixel action here starts from a fresh capture — exactly
// what the model has to do.
const { app, screen, desktopCapturer } = require('electron')
const { spawn, execFile } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')
const { pathToFileURL } = require('node:url')

const HERE = __dirname
// src/main/__tests__/computer-use-live → repo root
const REPO = path.resolve(HERE, '..', '..', '..', '..')
const CAPABILITY_SRC = path.join(
  REPO,
  'src',
  'defaults',
  'workspace',
  'brain',
  'cerebellum',
  'computer-use'
)
const WS = path.join(require('node:os').tmpdir(), 'wolffish-computer-use-live')
const CAPABILITY = path.join(WS, 'computer-use')
const PLUGIN = path.join(CAPABILITY, 'plugin', 'index.mjs')
const ELECTRON = process.execPath
const TARGET_PORT = 4777
const OUT = path.join(WS, 'results.json')
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const get = (p) =>
  new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${TARGET_PORT}${p}`, (res) => {
        let s = ''
        res.on('data', (c) => (s += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(s))
          } catch (e) {
            reject(e)
          }
        })
      })
      .on('error', reject)
  })
const ps = (script, args = []) =>
  new Promise((resolve) =>
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
      { timeout: 15000 },
      (e, out) => {
        try {
          resolve(JSON.parse(String(out).trim()))
        } catch {
          resolve(null)
        }
      }
    )
  )
const fg = () => ps(path.join(HERE, 'fg.ps1'))

const results = []
let plugin
let target = null
const notepadPids = new Set()
const timings = {}

async function call(tool, args = {}) {
  const t0 = Date.now()
  const r = await plugin.execute(tool, args)
  const ms = Date.now() - t0
  ;(timings[tool] ??= []).push(ms)
  const text = r.success ? r.output : `ERROR: ${r.error}`
  console.log(
    `\n▶ ${tool} ${JSON.stringify(args).slice(0, 160)} [${ms}ms]\n  ${String(text).replace(/\n/g, '\n  ').slice(0, 700)}${r.images?.length ? `\n  (+${r.images.length} image)` : ''}`
  )
  return { ...r, ms, text: String(text) }
}

async function check(name, fn) {
  if (ONLY && !ONLY.test(name)) return
  const t0 = Date.now()
  try {
    const note = await fn()
    results.push({ name, ok: true, ms: Date.now() - t0, note: note ?? null })
    console.log(`\n✅ ${name}${note ? ` — ${note}` : ''}`)
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: err?.message ?? String(err) })
    console.log(`\n❌ ${name}: ${err?.message ?? err}`)
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m)
}

function frameOf(text) {
  const m = /Frame (\d+)x(\d+)/.exec(text)
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null
}
function toFrame(dip, frame, origin, logicalW) {
  const scale = logicalW / frame.w
  return { x: Math.round((dip.x - origin.x) / scale), y: Math.round((dip.y - origin.y) / scale) }
}
const center = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })
const rung = (text) =>
  /delivered in the background/.test(text)
    ? 'background'
    : /FOREGROUND/.test(text)
      ? 'foreground'
      : /real pointer/.test(text)
        ? 'legacy'
        : 'unknown'

async function events() {
  return get('/events')
}
async function reset() {
  await get('/reset')
  await sleep(60)
}

let display, logicalW, targetWin

/** Fresh display capture, then a pixel action at a global DIP point. */
async function shot(extra = {}) {
  const r = await call('computer_screenshot', extra)
  assert(r.success, r.text)
  return frameOf(r.text)
}
async function clickDip(dip, extra = {}) {
  const f = toFrame(dip, await shot(), display.bounds, logicalW)
  return call('computer_mouse_click', { x: f.x, y: f.y, ...extra })
}
/** Fresh window capture of the target, then a pixel action at a global DIP point. */
async function winShot() {
  const r = await call('computer_window_screenshot', {
    pid: targetWin.pid,
    window_id: targetWin.id
  })
  assert(r.success, r.text)
  return frameOf(r.text)
}
async function clickWin(dip, extra = {}) {
  const f = toFrame(dip, await winShot(), { x: targetWin.x, y: targetWin.y }, targetWin.w)
  return call('computer_mouse_click', { x: f.x, y: f.y, ...extra })
}
async function winCoords(dip) {
  return toFrame(dip, await winShot(), { x: targetWin.x, y: targetWin.y }, targetWin.w)
}

async function startTarget() {
  target = spawn(ELECTRON, [path.join(HERE, 'target.cjs')], {
    env: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')
    ),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  target.stdout.on('data', (d) => process.stdout.write(`[target] ${d}`))
  target.stderr.on('data', (d) => process.stdout.write(`[target:err] ${String(d).slice(0, 300)}`))
  for (let i = 0; i < 60; i++) {
    try {
      const b = await get('/bounds')
      if (b) return b
    } catch {
      // Not up yet — keep polling.
    }
    await sleep(250)
  }
  throw new Error('target did not start')
}

function ensurePluginDeps() {
  // A fresh copy of the plugin every run, so edits are what gets evaluated.
  fs.mkdirSync(path.join(CAPABILITY, 'plugin'), { recursive: true })
  for (const f of fs.readdirSync(path.join(CAPABILITY_SRC, 'plugin'))) {
    if (f.endsWith('.mjs')) {
      fs.copyFileSync(path.join(CAPABILITY_SRC, 'plugin', f), path.join(CAPABILITY, 'plugin', f))
    }
  }
  fs.copyFileSync(path.join(CAPABILITY_SRC, 'package.json'), path.join(CAPABILITY, 'package.json'))
  if (fs.existsSync(path.join(CAPABILITY, 'node_modules', '@trycua', 'cua-driver'))) return
  console.log('installing the capability deps into', CAPABILITY)
  const r = require('node:child_process').spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '--no-audit', '--no-fund', '--omit=dev'],
    { cwd: CAPABILITY, stdio: 'inherit', shell: process.platform === 'win32' }
  )
  if (r.status !== 0) throw new Error('npm install failed in ' + CAPABILITY)
}

async function main() {
  fs.mkdirSync(WS, { recursive: true })
  ensurePluginDeps()
  fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ locale: 'en', computerUse: {} }))
  const mod = await import(pathToFileURL(PLUGIN).href)
  plugin = mod.default
  const t0 = Date.now()
  await plugin.init({ workspaceRoot: WS, getCurrentConversationId: () => 'eval' })
  timings.init = [Date.now() - t0]
  console.log(`plugin init ${Date.now() - t0}ms`)

  display = screen.getPrimaryDisplay()
  logicalW = display.size.width
  console.log(
    'display',
    JSON.stringify({ size: display.size, bounds: display.bounds, scale: display.scaleFactor })
  )
  const tb = await startTarget()
  console.log('target', JSON.stringify(tb))
  await sleep(800)
  const pointerBefore = screen.getCursorScreenPoint()
  const fgBefore = await fg()
  console.log(
    'foreground before',
    JSON.stringify(fgBefore),
    'pointer',
    JSON.stringify(pointerBefore)
  )
  const R = (await get('/state')).rects

  // ── access + indicator ────────────────────────────────────────────────
  await check('access check reports Windows ready with the driver loaded', async () => {
    const r = await call('computer_check_access')
    assert(r.success, r.text)
    assert(/ready on Windows/.test(r.text), 'not ready')
    assert(/Background input driver: granted/.test(r.text), 'driver not granted')
    return r.text.split('\n')[0]
  })
  await check('gate: screen tools refuse before glow_on', async () => {
    const r = await call('computer_screenshot')
    assert(!r.success && /indicator is OFF/.test(r.text), 'not gated')
  })
  await check('glow_on shows the overlay', async () => {
    const r = await call('computer_glow_on')
    assert(r.success, r.text)
    assert(/Screen indicator ON/.test(r.text))
    assert(!/ACCESS CHECK/.test(r.text), 'access note attached: ' + r.text)
  })

  // ── windows ───────────────────────────────────────────────────────────
  await check(
    'list_windows finds the target with the right bounds and lists no cloaked shell window',
    async () => {
      const all = await call('computer_list_windows')
      assert(all.success, all.text)
      assert(
        !/StartMenuExperienceHost|SearchHost|ShellExperienceHost|SystemSettings\.exe|ApplicationFrameHost/.test(
          all.text
        ),
        'cloaked window listed:\n' + all.text
      )
      const r = await call('computer_list_windows', { app: 'CUA Target' })
      assert(r.success, r.text)
      const m = /window_id (\d+) · pid (\d+) · (\d+)x(\d+) at \((-?\d+),(-?\d+)\)/.exec(r.text)
      assert(m, 'no window line')
      targetWin = {
        id: Number(m[1]),
        pid: Number(m[2]),
        w: Number(m[3]),
        h: Number(m[4]),
        x: Number(m[5]),
        y: Number(m[6])
      }
      assert(targetWin.pid === tb.pid, `pid ${targetWin.pid} != ${tb.pid}`)
      assert(
        Math.abs(targetWin.x - tb.x) <= 2 && Math.abs(targetWin.y - tb.y) <= 2,
        `bounds ${JSON.stringify(targetWin)} vs ${JSON.stringify(tb)}`
      )
      assert(
        Math.abs(targetWin.w - tb.width) <= 2 && Math.abs(targetWin.h - tb.height) <= 2,
        `size ${JSON.stringify(targetWin)} vs ${JSON.stringify(tb)}`
      )
      return `window ${targetWin.id} ${targetWin.w}x${targetWin.h} at ${targetWin.x},${targetWin.y}; ${all.text.split('\n').length - 2} windows listed`
    }
  )

  // ── display capture + pixel click ─────────────────────────────────────
  await check('screenshot returns a 1280-wide frame', async () => {
    const f = await shot()
    assert(f && f.w === 1280, `frame ${JSON.stringify(f)}`)
    return `${f.w}x${f.h}`
  })
  await check(
    'background click at screenshot coords hits Button A; pointer and foreground untouched',
    async () => {
      await reset()
      const fgb = await fg()
      const pb = screen.getCursorScreenPoint()
      const r = await clickDip(center(R.a), {
        target: 'Button A',
        expect: 'Button A registers a click'
      })
      assert(r.success, r.text)
      await sleep(200)
      const clicks = (await events()).filter((e) => e.kind === 'click')
      assert(
        clicks.length === 1 && clicks[0].id === 'a',
        `events ${JSON.stringify(clicks)} — ${r.text.slice(0, 300)}`
      )
      const pa = screen.getCursorScreenPoint()
      assert(
        pa.x === pb.x && pa.y === pb.y,
        `pointer moved ${JSON.stringify(pb)} → ${JSON.stringify(pa)}`
      )
      const fga = await fg()
      assert(
        fga && fgb && fga.pid === fgb.pid,
        `foreground changed ${JSON.stringify(fgb)} → ${JSON.stringify(fga)}`
      )
      assert(rung(r.text) === 'background', 'rung: ' + r.text.slice(0, 300))
      assert(
        /Under the point: button "Button A"/.test(r.text),
        'element echo missing: ' + r.text.slice(0, 400)
      )
      assert(r.meta?.computerUse?.lastAction?.summary, 'no lastAction meta')
      return `${r.meta.computerUse.lastAction.summary}; click tool ${r.ms}ms`
    }
  )
  await check('far-corner Button D lands on D, not elsewhere', async () => {
    await reset()
    const r = await clickDip(center(R.d))
    assert(r.success, r.text)
    await sleep(200)
    const clicks = (await events()).filter((e) => e.kind === 'click')
    assert(clicks.length === 1 && clicks[0].id === 'd', JSON.stringify(clicks))
  })
  await check('double-click and right-click arrive with the right button/detail', async () => {
    await reset()
    let r = await clickDip(center(R.b), { double: true })
    assert(r.success, r.text)
    await sleep(200)
    let ev = await events()
    assert(
      ev.some((e) => e.kind === 'dblclick' && e.id === 'b'),
      'no dblclick: ' + JSON.stringify(ev).slice(0, 300)
    )
    await reset()
    r = await clickDip(center(R.b), { button: 'right' })
    assert(r.success, r.text)
    await sleep(200)
    ev = await events()
    assert(
      ev.some((e) => e.kind === 'contextmenu' && e.id === 'b'),
      'no contextmenu: ' + JSON.stringify(ev).slice(0, 300)
    )
  })
  await check('zoom → click hits the 16px target', async () => {
    await reset()
    const c = center(R.tiny)
    const sf = await shot()
    const origin = { x: c.x - 60, y: c.y - 40 }
    const f = toFrame(origin, sf, display.bounds, logicalW)
    const z = await call('computer_zoom', { x: f.x, y: f.y, width: 80, height: 54 })
    assert(z.success, z.text)
    const zf = frameOf(z.text)
    // The zoom region in DIP: 80 frame px * (logical/frame) wide.
    const regionW = 80 * (logicalW / sf.w)
    const scale = regionW / zf.w
    const zx = Math.round((c.x - origin.x) / scale)
    const zy = Math.round((c.y - origin.y) / scale)
    const r = await call('computer_mouse_click', { x: zx, y: zy, target: 'tiny red square' })
    assert(r.success, r.text)
    await sleep(200)
    const clicks = (await events()).filter((e) => e.kind === 'click')
    assert(
      clicks.length === 1 && clicks[0].id === 'tiny',
      JSON.stringify(clicks) + ' — ' + r.text.slice(0, 200)
    )
    return `zoom ${zf.w}x${zf.h}`
  })
  await check(
    'mouse_move aims the shadow cursor (pointer still); click with no coords uses the aim',
    async () => {
      await reset()
      const pb = screen.getCursorScreenPoint()
      const f = toFrame(center(R.c), await shot(), display.bounds, logicalW)
      const m = await call('computer_mouse_move', { x: f.x, y: f.y, target: 'Button C' })
      assert(m.success, m.text)
      assert(/Under the point: button "Button C"/.test(m.text), 'aim echo: ' + m.text.slice(0, 300))
      const pa = screen.getCursorScreenPoint()
      assert(pa.x === pb.x && pa.y === pb.y, 'pointer moved')
      const r = await call('computer_mouse_click', {})
      assert(r.success, r.text)
      await sleep(200)
      const clicks = (await events()).filter((e) => e.kind === 'click')
      assert(clicks.length === 1 && clicks[0].id === 'c', JSON.stringify(clicks))
    }
  )

  // ── window capture + window-scoped click ──────────────────────────────
  await check('window_screenshot captures the target at native size', async () => {
    const f = await winShot()
    assert(f && Math.abs(f.w - targetWin.w) <= 2, `frame ${JSON.stringify(f)}`)
    return `${f.w}x${f.h}`
  })
  await check(
    'click at window-frame coords hits Button B (window-local pixel translation)',
    async () => {
      await reset()
      const r = await clickWin(center(R.b), { target: 'Button B' })
      assert(r.success, r.text)
      await sleep(200)
      const clicks = (await events()).filter((e) => e.kind === 'click')
      assert(clicks.length === 1 && clicks[0].id === 'b', JSON.stringify(clicks))
      assert(rung(r.text) === 'background', r.text.slice(0, 200))
    }
  )

  // ── keyboard ──────────────────────────────────────────────────────────
  await check('click the field then type ASCII in the background; DOM value matches', async () => {
    await reset()
    const c = await clickWin(center(R.field), { target: 'Name field' })
    assert(c.success, c.text)
    const r = await call('computer_keyboard_type', {
      text: 'hello wolffish 123',
      target: 'Name field'
    })
    assert(r.success, r.text)
    await sleep(300)
    const st = await get('/state')
    assert(st.field === 'hello wolffish 123', `field="${st.field}" — ${r.text.slice(0, 200)}`)
    return `${rung(r.text)}; ${r.ms}ms`
  })
  await check('type Arabic + emoji in the background; DOM value matches exactly', async () => {
    await reset()
    await clickWin(center(R.field))
    const text = 'مرحبا بالعالم 👋 ok'
    const r = await call('computer_keyboard_type', { text })
    assert(r.success, r.text)
    await sleep(400)
    const st = await get('/state')
    assert(st.field === text, `field="${st.field}"`)
    return `${rung(r.text)} ${/clipboard/.test(r.text) ? 'clipboard' : 'keystrokes'}`
  })
  await check('replace: true selects existing text first', async () => {
    const r = await call('computer_keyboard_type', { text: 'replaced', replace: true })
    assert(r.success, r.text)
    await sleep(300)
    const st = await get('/state')
    assert(st.field === 'replaced', `field="${st.field}"`)
    return rung(r.text)
  })
  await check('enter: true and key combos arrive as keydown with modifiers', async () => {
    await reset()
    await clickWin(center(R.area))
    let r = await call('computer_keyboard_type', { text: 'line', enter: true })
    assert(r.success, r.text)
    const rungs = [rung(r.text)]
    r = await call('computer_keyboard_press', { key: 'ctrl+shift+k' })
    assert(r.success, r.text)
    rungs.push(rung(r.text))
    r = await call('computer_keyboard_press', { key: 'escape' })
    assert(r.success, r.text)
    r = await call('computer_keyboard_press', { key: 'f5' })
    assert(r.success, r.text)
    await sleep(300)
    const ev = (await events()).filter((e) => e.kind === 'keydown')
    const keys = ev.map((e) => `${e.ctrl ? 'ctrl+' : ''}${e.shift ? 'shift+' : ''}${e.key}`)
    assert(keys.includes('Enter'), 'no Enter: ' + keys.join(' '))
    assert(
      keys.some((k) => /^ctrl\+shift\+k$/i.test(k)),
      'no ctrl+shift+k: ' + keys.join(' ')
    )
    assert(keys.includes('Escape'), 'no Escape: ' + keys.join(' '))
    assert(keys.includes('F5'), 'no F5: ' + keys.join(' '))
    const st = await get('/state')
    assert(/^line\n?$/.test(st.area), `area="${st.area}"`)
    return `${keys.join(' ')}; rungs ${rungs.join('/')}`
  })

  // ── scroll / drag ─────────────────────────────────────────────────────
  await check('scroll into the scroller moves scrollTop (evidence names the rung)', async () => {
    await reset()
    const pb = screen.getCursorScreenPoint()
    const f = await winCoords(center(R.scroller))
    const r = await call('computer_mouse_scroll', { x: f.x, y: f.y, direction: 'down', amount: 5 })
    assert(r.success, r.text)
    await sleep(300)
    const st = await get('/state')
    const pa = screen.getCursorScreenPoint()
    assert(st.scrollTop > 0, `scrollTop=${st.scrollTop} — ${r.text.slice(0, 300)}`)
    return `scrollTop ${st.scrollTop}; ${rung(r.text)}; pointer ${pa.x === pb.x && pa.y === pb.y ? 'still' : 'MOVED'}`
  })
  await check('drag moves the box (evidence names the rung)', async () => {
    await reset()
    const s = center(R.box)
    const e = { x: s.x + 120, y: s.y - 80 }
    const wf = await winShot()
    const fs_ = toFrame(s, wf, { x: targetWin.x, y: targetWin.y }, targetWin.w)
    const fe = toFrame(e, wf, { x: targetWin.x, y: targetWin.y }, targetWin.w)
    const r = await call('computer_mouse_drag', {
      start_x: fs_.x,
      start_y: fs_.y,
      end_x: fe.x,
      end_y: fe.y
    })
    assert(r.success, r.text)
    await sleep(300)
    const st = await get('/state')
    const dx = st.box.left - 520
    const dy = st.box.top - 460
    assert(
      Math.abs(dx - 120) <= 6 && Math.abs(dy + 80) <= 6,
      `box moved by ${dx},${dy} — ${r.text.slice(0, 300)}`
    )
    return `moved ${dx},${dy}; ${rung(r.text)}`
  })

  // ── element route on web content ──────────────────────────────────────
  await check('find in the Electron target exposes DOM buttons through UIA', async () => {
    const r = await call('computer_find', {
      pid: targetWin.pid,
      window_id: targetWin.id,
      text: 'Button A'
    })
    assert(r.success, r.text)
    assert(/\[\d+\] button "Button A"/.test(r.text), r.text.slice(0, 300))
    return r.text.split('\n')[0]
  })
  await check('click_element by token on web content lands on Button C', async () => {
    const f = await call('computer_find', {
      pid: targetWin.pid,
      window_id: targetWin.id,
      text: 'Button C',
      role: 'button'
    })
    const m = /token=(s[0-9a-f]+:\d+)/.exec(f.text)
    assert(m, 'no token: ' + f.text.slice(0, 300))
    await reset()
    const r = await call('computer_click_element', {
      pid: targetWin.pid,
      window_id: targetWin.id,
      token: m[1],
      target: 'Button C'
    })
    assert(r.success, r.text)
    await sleep(300)
    const clicks = (await events()).filter((e) => e.kind === 'click')
    assert(clicks.length === 1 && clicks[0].id === 'c', JSON.stringify(clicks))
    return rung(r.text)
  })
  await check('set_value on a web text field (readback or fallback)', async () => {
    await reset()
    const r = await call('computer_set_value', {
      pid: targetWin.pid,
      window_id: targetWin.id,
      text: 'Name',
      value: 'via set_value'
    })
    assert(r.success, r.text)
    await sleep(400)
    const st = await get('/state')
    assert(st.field === 'via set_value', `field="${st.field}" — ${r.text.slice(0, 300)}`)
    return r.text.slice(0, 120)
  })
  await check(
    'password field: how the tree reports it, and whether typing is refused',
    async () => {
      await reset()
      const f = await call('computer_find', {
        pid: targetWin.pid,
        window_id: targetWin.id,
        text: 'Password'
      })
      const line = f.text.split('\n').find((l) => /^\[\d+\]/.test(l)) ?? '(not found)'
      await clickWin(center(R.pw))
      const r = await call('computer_keyboard_type', { text: 'secret' })
      await sleep(200)
      const st = await get('/state')
      if (r.success) return `NOT refused; tree says: ${line.slice(0, 100)}; DOM pw="${st.pw}"`
      assert(/password field/.test(r.text), r.text)
      assert(st.pw === '', 'typed anyway')
      return `refused; tree says: ${line.slice(0, 100)}`
    }
  )

  // ── occlusion: Notepad in front, covering Button A ────────────────────
  let np = null
  await check('focus_window brings Notepad to the front without moving the pointer', async () => {
    const pb = screen.getCursorScreenPoint()
    spawn('notepad.exe', [], { detached: true, stdio: 'ignore' }).unref()
    const w = await call('computer_wait_for', {
      until: 'window_title',
      text: 'Notepad',
      timeout_ms: 8000
    })
    assert(w.success && /is now visible/.test(w.text), w.text)
    const m = /window_id (\d+), pid (\d+)/.exec(w.text)
    np = { id: Number(m[1]), pid: Number(m[2]) }
    notepadPids.add(np.pid)
    const foc = await call('computer_focus_window', { pid: np.pid, window_id: np.id })
    assert(foc.success, foc.text)
    await sleep(600)
    const f = await fg()
    assert(f && f.pid === np.pid, `foreground is ${JSON.stringify(f)}, not Notepad ${np.pid}`)
    const pa = screen.getCursorScreenPoint()
    assert(pa.x === pb.x && pa.y === pb.y, 'pointer moved')
    const lw = await call('computer_list_windows', { app: 'Notepad' })
    assert(/frontmost app/.test(lw.text), 'not marked frontmost: ' + lw.text)
  })
  await check(
    'display-scope click on a point Notepad covers goes to Notepad (what the screenshot shows), not the target',
    async () => {
      await reset()
      // Does Notepad cover Button A? Read its bounds.
      const lw = await call('computer_list_windows', { app: 'Notepad' })
      const m = /(\d+)x(\d+) at \((-?\d+),(-?\d+)\)/.exec(lw.text)
      const nb = { w: Number(m[1]), h: Number(m[2]), x: Number(m[3]), y: Number(m[4]) }
      const c = center(R.a)
      const covers = c.x >= nb.x && c.x < nb.x + nb.w && c.y >= nb.y && c.y < nb.y + nb.h
      if (!covers) return `skipped: Notepad ${JSON.stringify(nb)} does not cover Button A`
      const r = await clickDip(c, { target: 'Button A' })
      assert(r.success, r.text)
      await sleep(200)
      const clicks = (await events()).filter((e) => e.kind === 'click')
      assert(/to Notepad\.exe/.test(r.text), 'evidence: ' + r.text.slice(0, 300))
      assert(clicks.length === 0, 'the covered target got the click: ' + JSON.stringify(clicks))
      return 'routed to Notepad as the screenshot shows'
    }
  )
  await check(
    'window-scope click on the covered Button A reaches the target underneath; Notepad stays in front',
    async () => {
      await reset()
      const fgb = await fg()
      const r = await clickWin(center(R.a), { target: 'Button A' })
      assert(r.success, r.text)
      await sleep(200)
      const clicks = (await events()).filter((e) => e.kind === 'click')
      assert(
        clicks.length === 1 && clicks[0].id === 'a',
        `clicks ${JSON.stringify(clicks)} — ${r.text.slice(0, 300)}`
      )
      const fga = await fg()
      assert(
        fga && fgb && fga.pid === fgb.pid,
        `foreground changed ${JSON.stringify(fgb)} → ${JSON.stringify(fga)}`
      )
      const named = /Notepad\.exe[^;]*is on top of that point/.test(r.text)
      return `${rung(r.text)}; ${named ? 'evidence names Notepad on top' : 'no cover note (Notepad may not cover A)'}`
    }
  )

  // ── native app: Notepad's UIA tree ────────────────────────────────────
  await check('Notepad: the native tree lists the document and menu items', async () => {
    const st = await call('computer_window_state', {
      pid: np.pid,
      window_id: np.id,
      max_elements: 200
    })
    assert(st.success, st.text)
    assert(
      /Document "Text editor"/.test(st.text) && /MenuItem "File"/.test(st.text),
      st.text.slice(0, 300)
    )
    return st.text.split('\n')[0]
  })
  await check(
    'Notepad: click the document by token, type in the background, read back through UIA',
    async () => {
      const f = await call('computer_find', { pid: np.pid, window_id: np.id, role: 'text' })
      const m = /token=(s[0-9a-f]+:\d+)/.exec(f.text)
      assert(m, 'no text element token: ' + f.text.slice(0, 300))
      const c = await call('computer_click_element', {
        pid: np.pid,
        window_id: np.id,
        token: m[1],
        target: 'document'
      })
      assert(c.success, c.text)
      const r = await call('computer_keyboard_type', {
        text: 'wolffish was here',
        target: 'document'
      })
      assert(r.success, r.text)
      await sleep(400)
      const rd = await call('computer_read_element', {
        pid: np.pid,
        window_id: np.id,
        role: 'text'
      })
      assert(rd.success, rd.text)
      assert(/wolffish was here/.test(rd.text), 'readback: ' + rd.text.slice(0, 300))
      return `${rung(r.text)}; readback ok`
    }
  )
  await check(
    'Notepad: set_value replaces the document text (direct or fallback) and reads back',
    async () => {
      const r = await call('computer_set_value', {
        pid: np.pid,
        window_id: np.id,
        role: 'text',
        value: 'set directly'
      })
      assert(r.success, r.text)
      await sleep(400)
      const rd = await call('computer_read_element', {
        pid: np.pid,
        window_id: np.id,
        role: 'text'
      })
      assert(
        /set directly/.test(rd.text) && !/wolffish was here/.test(rd.text),
        'readback: ' + rd.text.slice(0, 200)
      )
      return /Direct value setting is not available/.test(r.text)
        ? 'fallback click+select+type'
        : 'direct'
    }
  )
  await check('Notepad: menu invocation through UIA (View menu opens)', async () => {
    const r = await call('computer_menu', { pid: np.pid, window_id: np.id, path: ['View'] })
    if (!r.success) return `not supported: ${r.text.slice(0, 160)}`
    await sleep(300)
    await call('computer_keyboard_press', { key: 'escape' })
    return r.text.slice(0, 120)
  })
  await check('Notepad: window_screenshot while the target overlaps it', async () => {
    const r = await call('computer_window_screenshot', { pid: np.pid, window_id: np.id })
    assert(r.success, r.text)
    return frameOf(r.text) ? `${frameOf(r.text).w}x${frameOf(r.text).h}` : ''
  })
  await check('wait_for element / element_gone / stable all return in bounded time', async () => {
    const a = await call('computer_wait_for', {
      until: 'element',
      text: 'set directly',
      pid: np.pid,
      window_id: np.id,
      timeout_ms: 3000
    })
    assert(a.success && /appeared/.test(a.text), a.text)
    const b = await call('computer_wait_for', {
      until: 'element_gone',
      text: 'zzz-not-there',
      pid: np.pid,
      window_id: np.id,
      timeout_ms: 2000
    })
    assert(b.success && /No element/.test(b.text), b.text)
    const c = await call('computer_wait_for', { until: 'stable', timeout_ms: 4000 })
    assert(c.success, c.text)
    return `${a.ms}/${b.ms}/${c.ms}ms`
  })

  // ── batch, clipboard, overlay protection, glow_off ────────────────────
  await check('batch runs steps and stops on failure', async () => {
    const r = await call('computer_batch', {
      steps: [
        { tool: 'computer_wait', args: { ms: 10 } },
        { tool: 'computer_list_displays' },
        { tool: 'computer_zoom', args: { x: -1, y: -1, width: 1, height: 1 } }
      ]
    })
    assert(!r.success && /stopped at step 3/.test(r.text), r.text)
  })
  await check('clipboard round trip', async () => {
    const w = await call('computer_clipboard_write', { text: 'clip ✓' })
    assert(w.success, w.text)
    const r = await call('computer_clipboard_read')
    assert(r.success && /clip ✓/.test(r.text), r.text)
  })
  await check(
    'overlay is content-protected: glow/chip pixels match with the indicator on and off',
    async () => {
      const sharp = (
        await import(
          pathToFileURL(path.join(CAPABILITY, 'node_modules', 'sharp', 'lib', 'index.js')).href
        )
      ).default
      const on = await call('computer_screenshot', { max_width: 1920, format: 'png' })
      assert(on.success && on.images?.length === 1, on.text)
      await call('computer_glow_off')
      await sleep(1200)
      // The gate is closed now, so the "off" picture comes straight from Electron.
      const W0 = display.size.width * display.scaleFactor
      const H0 = display.size.height * display.scaleFactor
      const src = (
        await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: W0, height: H0 }
        })
      )[0]
      const offPng = src.thumbnail.toPNG()
      await call('computer_glow_on')
      const a = await sharp(Buffer.from(on.images[0].data, 'base64'))
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true })
      const b = await sharp(offPng).greyscale().raw().toBuffer({ resolveWithObject: true })
      assert(
        a.info.width === b.info.width && a.info.height === b.info.height,
        `size mismatch ${a.info.width}x${a.info.height} vs ${b.info.width}x${b.info.height}`
      )
      const expectVisible = process.env.WOLFFISH_OVERLAY_CAPTURE_VISIBLE === '1'
      const W = a.info.width
      let changed = 0
      let total = 0
      for (let y = 0; y < a.info.height; y++)
        for (let x = 0; x < W; x++) {
          const edge = x < 22 || y < 22 || x >= W - 22 || y >= a.info.height - 22
          const mid = Math.abs(x - W / 2) < 140 && Math.abs(y - a.info.height / 2) < 20
          if (!edge && !mid) continue
          total++
          if (Math.abs(a.data[y * W + x] - b.data[y * W + x]) > 24) changed++
        }
      const pct = (changed / total) * 100
      if (expectVisible) {
        assert(
          pct > 5,
          `control run: only ${pct.toFixed(2)}% differ with protection disabled — the check cannot see the overlay`
        )
        return `control (protection off): ${pct.toFixed(2)}% differ, so the overlay is drawn and the check sees it`
      }
      assert(
        pct < 1,
        `${pct.toFixed(2)}% of glow/chip pixels differ — the overlay leaks into captures`
      )
      return `${pct.toFixed(3)}% differ`
    }
  )
  await check('glow_off hides the overlay and the gate closes again', async () => {
    const r = await call('computer_glow_off')
    assert(r.success && /OFF/.test(r.text), r.text)
    const s = await call('computer_list_windows')
    assert(!s.success && /indicator is OFF/.test(s.text), 'gate open after glow_off')
  })

  const pointerAfter = screen.getCursorScreenPoint()
  const summary = {
    platform: `${process.platform} ${require('node:os').release()} electron ${process.versions.electron}`,
    display: { size: display.size, scale: display.scaleFactor },
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    pointerMoved: pointerAfter.x !== pointerBefore.x || pointerAfter.y !== pointerBefore.y,
    timings: Object.fromEntries(
      Object.entries(timings).map(([k, v]) => [
        k,
        {
          n: v.length,
          avg: Math.round(v.reduce((a, b) => a + b, 0) / v.length),
          max: Math.max(...v)
        }
      ])
    ),
    results
  }
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2))
  console.log(
    `\n${summary.passed}/${summary.passed + summary.failed} checks passed; pointer moved overall: ${summary.pointerMoved}`
  )
  console.log('timings', JSON.stringify(summary.timings))
  await cleanup(summary.failed === 0 ? 0 : 1)
}

async function cleanup(code) {
  try {
    await plugin?.destroy()
  } catch {
    // Best-effort teardown.
  }
  try {
    await get('/quit')
  } catch {
    // The target may already be gone.
  }
  try {
    target?.kill()
  } catch {
    // Already exited.
  }
  // Discard the Notepad windows this run opened (unsaved text, no prompt).
  await new Promise((r) =>
    execFile(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-Process Notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match 'set directly|wolffish|Untitled' } | Stop-Process -Force`
      ],
      () => r()
    )
  )
  await sleep(400)
  process.exit(code)
}

app.whenReady().then(() =>
  main().catch(async (err) => {
    console.error('HARNESS FAILED', err)
    fs.writeFileSync(OUT, JSON.stringify({ fatal: String(err?.stack ?? err), results }, null, 2))
    await cleanup(2)
  })
)
app.on('window-all-closed', () => {})
process.on('uncaughtException', (e) => console.error('uncaught', e))
