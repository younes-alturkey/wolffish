// Ground-truth target: a separate Electron process whose DOM records every
// input it receives. The harness reads that record over HTTP.
const { app, BrowserWindow } = require('electron')
const http = require('node:http')

const PORT = Number(process.env.TARGET_PORT || 4777)
const X = Number(process.env.TARGET_X || 300)
const Y = Number(process.env.TARGET_Y || 150)
const W = 900
const H = 700

const html = `<!doctype html><html><head><meta charset="utf-8"><title>CUA Target</title>
<style>
  html,body{margin:0;width:100vw;height:100vh;background:#f4f4f8;font:14px system-ui;overflow:hidden;user-select:none}
  .btn{position:absolute;display:flex;align-items:center;justify-content:center;background:#2b6cb0;color:#fff;border:0;border-radius:6px;font-size:16px}
  #a{left:60px;top:60px;width:140px;height:60px}
  #b{left:60px;top:160px;width:140px;height:60px}
  #c{left:700px;top:60px;width:140px;height:60px}
  #d{left:700px;top:560px;width:140px;height:60px}
  #tiny{left:420px;top:100px;width:16px;height:16px;border-radius:0;background:#c53030;font-size:9px}
  #field{position:absolute;left:60px;top:280px;width:300px;height:32px;font-size:16px;padding:4px}
  #area{position:absolute;left:60px;top:340px;width:300px;height:80px;font-size:14px}
  #pw{position:absolute;left:60px;top:450px;width:200px;height:28px}
  #scroller{position:absolute;left:420px;top:200px;width:240px;height:200px;overflow:auto;background:#fff;border:1px solid #999}
  #scroller div{height:2000px;background:linear-gradient(#fff,#88a)}
  #box{position:absolute;left:520px;top:460px;width:60px;height:60px;background:#d69e2e;border-radius:8px;cursor:grab}
  #chk{position:absolute;left:420px;top:600px;transform:scale(1.6)}
  #status{position:absolute;left:60px;top:640px;font:12px monospace;color:#333}
</style></head><body>
<button class="btn" id="a">Button A</button>
<button class="btn" id="b">Button B</button>
<button class="btn" id="c">Button C</button>
<button class="btn" id="d">Button D</button>
<button class="btn" id="tiny" title="tiny"></button>
<input id="field" placeholder="Name" aria-label="Name">
<textarea id="area" aria-label="Notes"></textarea>
<input id="pw" type="password" placeholder="Password" aria-label="Password">
<div id="scroller"><div></div></div>
<div id="box" role="img" aria-label="Drag box"></div>
<input id="chk" type="checkbox" aria-label="Agree">
<div id="status"></div>
<script>
  window.__events = []
  const push = (e) => { window.__events.push({ t: Date.now(), ...e }); document.getElementById('status').textContent = JSON.stringify(e) }
  for (const id of ['a','b','c','d','tiny']) {
    const el = document.getElementById(id)
    el.addEventListener('click', (ev) => push({ kind: 'click', id, button: ev.button, x: ev.clientX, y: ev.clientY, detail: ev.detail, shift: ev.shiftKey, ctrl: ev.ctrlKey, alt: ev.altKey }))
    el.addEventListener('dblclick', (ev) => push({ kind: 'dblclick', id }))
    el.addEventListener('contextmenu', (ev) => { ev.preventDefault(); push({ kind: 'contextmenu', id, x: ev.clientX, y: ev.clientY }) })
    el.addEventListener('auxclick', (ev) => push({ kind: 'auxclick', id, button: ev.button }))
  }
  document.addEventListener('mousedown', (ev) => push({ kind: 'mousedown', target: ev.target.id || ev.target.tagName, x: ev.clientX, y: ev.clientY, button: ev.button }), true)
  document.addEventListener('keydown', (ev) => push({ kind: 'keydown', key: ev.key, code: ev.code, ctrl: ev.ctrlKey, shift: ev.shiftKey, alt: ev.altKey, meta: ev.metaKey, target: document.activeElement?.id || null }), true)
  document.addEventListener('wheel', (ev) => push({ kind: 'wheel', dx: ev.deltaX, dy: ev.deltaY, target: ev.target.id || (ev.target.parentElement && ev.target.parentElement.id) || ev.target.tagName }), { capture: true, passive: true })
  document.getElementById('chk').addEventListener('change', (ev) => push({ kind: 'change', id: 'chk', checked: ev.target.checked }))
  window.addEventListener('focus', () => push({ kind: 'window-focus' }))
  window.addEventListener('blur', () => push({ kind: 'window-blur' }))
  document.addEventListener('focusin', (ev) => push({ kind: 'focusin', id: ev.target.id }))
  // Drag box with pointer events.
  const box = document.getElementById('box')
  let drag = null
  box.addEventListener('pointerdown', (ev) => { drag = { dx: ev.clientX - box.offsetLeft, dy: ev.clientY - box.offsetTop }; box.setPointerCapture(ev.pointerId); push({ kind: 'dragstart', x: ev.clientX, y: ev.clientY }) })
  box.addEventListener('pointermove', (ev) => { if (!drag) return; box.style.left = (ev.clientX - drag.dx) + 'px'; box.style.top = (ev.clientY - drag.dy) + 'px' })
  box.addEventListener('pointerup', (ev) => { if (!drag) return; drag = null; push({ kind: 'dragend', x: ev.clientX, y: ev.clientY, left: box.offsetLeft, top: box.offsetTop }) })
  window.__state = () => {
    const r = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return { x: window.screenX + b.left, y: window.screenY + b.top, width: b.width, height: b.height } }
    return {
      focused: document.hasFocus(),
      active: document.activeElement?.id || null,
      field: document.getElementById('field').value,
      area: document.getElementById('area').value,
      pw: document.getElementById('pw').value,
      scrollTop: document.getElementById('scroller').scrollTop,
      box: { left: box.offsetLeft, top: box.offsetTop },
      checked: document.getElementById('chk').checked,
      screen: { x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight, iw: window.innerWidth, ih: window.innerHeight, dpr: window.devicePixelRatio },
      rects: Object.fromEntries(['a','b','c','d','tiny','field','area','pw','scroller','box','chk'].map((id) => [id, r(id)]))
    }
  }
  window.__reset = () => { window.__events = []; document.getElementById('field').value=''; document.getElementById('area').value=''; document.getElementById('pw').value=''; document.getElementById('scroller').scrollTop=0; box.style.left='520px'; box.style.top='460px'; document.getElementById('chk').checked=false; document.activeElement && document.activeElement.blur(); return true }
</script></body></html>`

app.whenReady().then(() => {
  const win = new BrowserWindow({
    x: X,
    y: Y,
    width: W,
    height: H,
    useContentSize: true,
    frame: false,
    title: 'CUA Target',
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  win.setTitle('CUA Target')
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    try {
      if (req.url === '/events')
        return send(200, await win.webContents.executeJavaScript('window.__events'))
      if (req.url === '/state')
        return send(200, await win.webContents.executeJavaScript('window.__state()'))
      if (req.url === '/reset')
        return send(200, await win.webContents.executeJavaScript('window.__reset()'))
      if (req.url === '/bounds')
        return send(200, {
          ...win.getBounds(),
          content: win.getContentBounds(),
          focused: win.isFocused(),
          pid: process.pid,
          id: win.getMediaSourceId()
        })
      if (req.url === '/quit') {
        send(200, { ok: true })
        setTimeout(() => app.quit(), 50)
        return
      }
      send(404, { error: 'no' })
    } catch (err) {
      send(500, { error: String(err) })
    }
  })
  server.listen(PORT, '127.0.0.1', () =>
    console.log(`target ready pid=${process.pid} port=${PORT}`)
  )
})
app.on('window-all-closed', () => app.quit())
