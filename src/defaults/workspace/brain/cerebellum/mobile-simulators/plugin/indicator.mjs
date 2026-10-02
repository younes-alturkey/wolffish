// The driving indicator: the computer-use screen glow, scoped to the one
// window the agent is driving. A transparent, click-through, content-
// protected, always-on-top BrowserWindow sits over the simulator or
// emulator window, follows it when the person drags or resizes it, shows a
// pill naming the device, and draws a ripple wherever a touch is injected
// (a stroke for swipes) — AXe and adb inject HID events, so nothing else on
// the host moves and this is the only trace the person would see.
//
// Lifecycle is model-owned, exactly like computer-use: mobile_indicator_on
// first, mobile_indicator_off last; no idle timer; the Agent's guard carries
// the tail notice, the turn-end nudge and the failsafe. Seeing and touching
// tools refuse to run while it is down (unless it proved unavailable).
import { locateDeviceWindow } from './windows.mjs'

let electronScreen = null
let BrowserWindow = null
let log = () => {}
let getLocale = () => 'en'

const WINDOW_TITLE = 'wolffish-mobile-glow'
const FADE_MS = 600
const FOLLOW_MS = 500
const MARGIN = 8
const TITLE_BAR = process.platform === 'darwin' ? 28 : process.platform === 'win32' ? 31 : 0
const CAPTURE_VISIBLE = process.env.WOLFFISH_OVERLAY_CAPTURE_VISIBLE === '1'

const TEXT = {
  en: { dir: 'ltr', text: (name) => `Wolffish is driving ${name}` },
  ar: { dir: 'rtl', text: (name) => `وولفيش يقود ${name}` }
}

const state = {
  wanted: false,
  unavailable: false,
  // deviceId -> { win, target, bounds, screenRect, timer, locale }
  byDevice: new Map()
}

export function initIndicator({ electron, locale, logger } = {}) {
  electronScreen = electron?.screen ?? null
  BrowserWindow = electron?.BrowserWindow ?? null
  if (typeof locale === 'function') getLocale = locale
  if (typeof logger === 'function') log = logger
  try {
    for (const w of BrowserWindow?.getAllWindows?.() ?? []) if (w.getTitle?.() === WINDOW_TITLE) w.destroy()
  } catch {
    // cosmetic
  }
}

function html(locale, name) {
  const t = TEXT[locale] ?? TEXT.en
  const edges = (a, b) =>
    `linear-gradient(to bottom, rgba(59,130,246,${a}), rgba(59,130,246,${b}) 55%, rgba(59,130,246,0)),` +
    `linear-gradient(to top, rgba(59,130,246,${a}), rgba(59,130,246,${b}) 55%, rgba(59,130,246,0)),` +
    `linear-gradient(to right, rgba(59,130,246,${a}), rgba(59,130,246,${b}) 55%, rgba(59,130,246,0)),` +
    `linear-gradient(to left, rgba(59,130,246,${a}), rgba(59,130,246,${b}) 55%, rgba(59,130,246,0))`
  const layer = 'position:fixed;inset:0;background-repeat:no-repeat;background-size:100% 14px,100% 14px,14px 100%,14px 100%;background-position:top,bottom,left,right;border-radius:14px;'
  const doc =
    `<!doctype html><html dir="${t.dir}"><head><meta charset="utf-8"><style>` +
    'html,body{margin:0;width:100vw;height:100vh;background:transparent;overflow:hidden;pointer-events:none}' +
    'body{opacity:0;animation:fi .4s ease-out forwards}body.bye{animation:fo .55s ease-in forwards}' +
    '#frame{position:fixed;inset:0;border:2px solid rgba(96,165,250,.85);border-radius:14px;box-shadow:0 0 0 1px rgba(8,15,33,.35) inset}' +
    `#base{${layer}background-image:${edges(0.45, 0.14)}}` +
    `#breathe{${layer}background-image:${edges(0.7, 0.22)};opacity:0;animation:br 3.2s ease-in-out infinite}` +
    `#pulse{${layer}background-image:${edges(0.95, 0.36)};opacity:0}#pulse.on{animation:pu .7s ease-out}` +
    '#chip{position:fixed;left:50%;top:10px;transform:translateX(-50%);display:flex;align-items:center;gap:7px;padding:5px 12px;border-radius:999px;' +
    'background:rgba(8,15,33,.55);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid rgba(96,165,250,.35);color:rgba(226,236,255,.85);' +
    "font:500 12px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;white-space:nowrap;max-width:90%;overflow:hidden;text-overflow:ellipsis}" +
    '#dot{width:6px;height:6px;border-radius:50%;background:#60A5FA;box-shadow:0 0 8px 2px rgba(96,165,250,.6);animation:db 2.4s ease-in-out infinite}' +
    '.rip{position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid #60A5FA;box-shadow:0 0 12px rgba(59,130,246,.7);opacity:0;animation:rg .7s ease-out forwards;pointer-events:none}' +
    '.rip.hold{animation:hold 1.1s ease-out forwards}' +
    '.dotp{position:fixed;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;background:#60A5FA;opacity:0;animation:dp .7s ease-out forwards}' +
    'svg.stroke{position:fixed;inset:0;width:100%;height:100%;overflow:visible}' +
    '@keyframes fi{to{opacity:1}}@keyframes fo{to{opacity:0}}@keyframes br{0%,100%{opacity:.12}50%{opacity:1}}@keyframes pu{0%{opacity:.95}100%{opacity:0}}' +
    '@keyframes db{0%,100%{opacity:.45}50%{opacity:1}}@keyframes rg{0%{opacity:.95;transform:scale(.35)}100%{opacity:0;transform:scale(1.6)}}' +
    '@keyframes hold{0%{opacity:.95;transform:scale(.5)}70%{opacity:.9;transform:scale(1)}100%{opacity:0;transform:scale(1.3)}}' +
    '@keyframes dp{0%{opacity:1}100%{opacity:0}}' +
    '</style></head><body><div id="frame"></div><div id="base"></div><div id="breathe"></div><div id="pulse"></div>' +
    `<div id="chip"><div id="dot"></div><span id="name">${t.text(escapeHtml(name))}</span></div>` +
    '<scr' +
    'ipt>' +
    'window.pulse=function(){var p=document.getElementById("pulse");p.classList.remove("on");void p.offsetWidth;p.classList.add("on")};' +
    'window.bye=function(){document.body.classList.add("bye")};' +
    'window.setName=function(t,dir){document.getElementById("name").textContent=t;document.documentElement.setAttribute("dir",dir)};' +
    'window.ripple=function(x,y,hold){var r=document.createElement("div");r.className="rip"+(hold?" hold":"");r.style.left=x+"px";r.style.top=y+"px";document.body.appendChild(r);' +
    'var d=document.createElement("div");d.className="dotp";d.style.left=x+"px";d.style.top=y+"px";document.body.appendChild(d);setTimeout(function(){r.remove();d.remove()},1300);return true};' +
    'window.stroke=function(x1,y1,x2,y2){var ns="http://www.w3.org/2000/svg";var s=document.createElementNS(ns,"svg");s.setAttribute("class","stroke");' +
    'var l=document.createElementNS(ns,"line");l.setAttribute("x1",x1);l.setAttribute("y1",y1);l.setAttribute("x2",x2);l.setAttribute("y2",y2);l.setAttribute("stroke","#60A5FA");l.setAttribute("stroke-width","4");l.setAttribute("stroke-linecap","round");l.setAttribute("stroke-dasharray","8 6");' +
    'var len=Math.hypot(x2-x1,y2-y1);l.style.strokeDasharray=len;l.style.strokeDashoffset=len;l.style.transition="stroke-dashoffset .5s ease-out";s.appendChild(l);document.body.appendChild(s);' +
    'void l.getBoundingClientRect();l.style.strokeDashoffset=0;window.ripple(x1,y1,false);setTimeout(function(){window.ripple(x2,y2,false)},450);setTimeout(function(){s.remove()},1200);return true};' +
    'window.state=function(){return {name:document.getElementById("name").textContent,ripples:document.querySelectorAll(".rip").length}};' +
    '</scr' +
    'ipt></body></html>'
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(doc)
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

/** Window rect (native window units) -> Electron DIP rect. */
function toDip(rect) {
  if (process.platform === 'win32' && electronScreen?.screenToDipRect) {
    try {
      return electronScreen.screenToDipRect(null, { x: rect.x, y: rect.y, width: rect.w, height: rect.h })
    } catch {
      // fall through
    }
  }
  return { x: rect.x, y: rect.y, width: rect.w, height: rect.h }
}

/**
 * Where the device screen sits inside the host window (DIP), and the scale
 * from device units to DIP. iOS Simulator with chrome shows the screen at
 * WindowScale centered in the content area; without chrome the screen fills
 * the content width. The emulator fills the content width. Pure.
 */
export function screenRectInWindow(dip, geometry, { chrome = true, windowScale = null, titleBar = TITLE_BAR } = {}) {
  const cw = dip.width
  const ch = Math.max(1, dip.height - titleBar)
  const cx = dip.x
  const cy = dip.y + titleBar
  const dev = geometry.native
  let s
  if (chrome && windowScale && Number.isFinite(windowScale)) {
    // Simulator draws the screen at exactly WindowScale points per point
    // inside a bezel; the bezel fills the rest of the window.
    s = windowScale
    if (dev.w * s > cw || dev.h * s > ch) s = Math.min(cw / dev.w, ch / dev.h)
  } else {
    s = Math.min(cw / dev.w, ch / dev.h)
  }
  const w = dev.w * s
  const h = dev.h * s
  return { x: cx + (cw - w) / 2, y: cy + (ch - h) / 2, w, h, scale: s }
}

function entryFor(target) {
  return state.byDevice.get(target.id) ?? null
}

function destroyEntry(entry, immediate) {
  if (!entry) return
  if (entry.timer) clearInterval(entry.timer)
  entry.timer = null
  const win = entry.win
  entry.win = null
  if (!win || win.isDestroyed()) return
  const kill = () => {
    try {
      if (!win.isDestroyed()) win.destroy()
    } catch {
      // gone
    }
  }
  if (immediate || process.platform === 'linux') return kill()
  try {
    win.webContents.executeJavaScript('window.bye && window.bye()').catch(() => {})
    const t = setTimeout(kill, FADE_MS + 100)
    if (typeof t.unref === 'function') t.unref()
  } catch {
    kill()
  }
}

function createWindow(entry, dip) {
  const bounds = { x: Math.round(dip.x - MARGIN), y: Math.round(dip.y - MARGIN), width: Math.round(dip.width + 2 * MARGIN), height: Math.round(dip.height + 2 * MARGIN) }
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    fullscreenable: false,
    show: false,
    title: WINDOW_TITLE,
    enableLargerThanScreen: true,
    roundedCorners: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setIgnoreMouseEvents(true)
  if (!CAPTURE_VISIBLE) win.setContentProtection(true)
  win.loadURL(html(getLocale(), entry.target.name))
  win.showInactive()
  win.setBounds(bounds)
  entry.win = win
  entry.bounds = bounds
  entry.locale = getLocale()
  log(`[mobile] driving indicator shown over ${entry.target.name} at ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`)
}

function applyWindowRect(entry, rect, geometry) {
  const dip = toDip(rect)
  entry.dip = dip
  entry.screenRect = geometry ? screenRectInWindow(dip, geometry, entry.mapping ?? {}) : null
  const bounds = { x: Math.round(dip.x - MARGIN), y: Math.round(dip.y - MARGIN), width: Math.round(dip.width + 2 * MARGIN), height: Math.round(dip.height + 2 * MARGIN) }
  if (!entry.win || entry.win.isDestroyed()) {
    createWindow(entry, dip)
    return
  }
  const cur = entry.bounds
  if (!cur || cur.x !== bounds.x || cur.y !== bounds.y || cur.width !== bounds.width || cur.height !== bounds.height) {
    try {
      entry.win.setBounds(bounds)
      entry.bounds = bounds
      if (!entry.win.isVisible()) entry.win.showInactive()
    } catch {
      // cosmetic
    }
  }
}

async function follow(entry) {
  if (!state.wanted || entry.stopped) return
  try {
    const loc = await locateDeviceWindow(entry.target)
    if (loc.window) {
      entry.missing = 0
      applyWindowRect(entry, loc.window, entry.geometry)
    } else {
      entry.missing = (entry.missing ?? 0) + 1
      if (entry.missing >= 2 && entry.win && !entry.win.isDestroyed() && entry.win.isVisible()) entry.win.hide()
    }
  } catch {
    // cosmetic
  }
}

/**
 * Raise the indicator over the device's window. Returns `{ shown, where, note }`.
 * Never throws. `geometry` is `{ native:{w,h}, unit, pxPerUnit }` for the
 * ripple mapping; `mapping` carries `{ chrome, windowScale }` on iOS.
 */
export async function indicatorShow(target, { geometry = null, mapping = null } = {}) {
  if (!BrowserWindow) return { shown: false, note: 'Electron is not available in this process' }
  let entry = entryFor(target)
  if (!entry) {
    entry = { target, win: null, bounds: null, dip: null, screenRect: null, geometry, mapping, timer: null, missing: 0, stopped: false }
    state.byDevice.set(target.id, entry)
  }
  if (geometry) entry.geometry = geometry
  if (mapping) entry.mapping = mapping
  entry.stopped = false
  const loc = await locateDeviceWindow(target)
  if (!loc.window) {
    return { shown: false, note: loc.ambiguous ? `${loc.candidates.length} ${target.platform === 'ios' ? 'Simulator' : 'emulator'} windows found and none is titled for ${target.name}` : loc.note ?? `no ${target.platform === 'ios' ? 'Simulator' : 'emulator'} window is on screen for ${target.name}`, via: loc.via }
  }
  state.wanted = true
  applyWindowRect(entry, loc.window, entry.geometry)
  if (!entry.timer) {
    entry.timer = setInterval(() => follow(entry), FOLLOW_MS)
    if (typeof entry.timer.unref === 'function') entry.timer.unref()
  }
  return { shown: !!entry.win, where: entry.bounds, via: loc.via, note: loc.note }
}

/** Take every indicator down. */
export function indicatorHide({ immediate = false } = {}) {
  state.wanted = false
  for (const entry of state.byDevice.values()) {
    entry.stopped = true
    destroyEntry(entry, immediate)
  }
  state.byDevice.clear()
}

export function indicatorOn() {
  return state.wanted
}

export function indicatorAlive(target) {
  const e = target ? entryFor(target) : [...state.byDevice.values()][0]
  return !!(e?.win && !e.win.isDestroyed())
}

export function indicatorUnavailable() {
  return state.unavailable
}

export function setIndicatorUnavailable(v) {
  state.unavailable = !!v
}

/** Update the mapping inputs after a geometry change (rotation). */
export function indicatorGeometry(target, geometry, mapping) {
  const e = entryFor(target)
  if (!e) return
  e.geometry = geometry
  if (mapping) e.mapping = mapping
  if (e.dip) e.screenRect = screenRectInWindow(e.dip, geometry, e.mapping ?? {})
}

/** Device units -> overlay-local px. Null when the window is unknown. */
export function toOverlayPoint(target, p) {
  const e = entryFor(target)
  if (!e?.screenRect || !e.bounds) return null
  const r = e.screenRect
  return { x: r.x + p.x * r.scale - e.bounds.x, y: r.y + p.y * r.scale - e.bounds.y }
}

/** Draw where a touch landed. `hold` for long presses. Fire-and-forget. */
export function ripple(target, point, { hold = false } = {}) {
  const e = entryFor(target)
  if (!e?.win || e.win.isDestroyed()) return false
  const lp = toOverlayPoint(target, point)
  if (!lp) return false
  e.win.webContents.executeJavaScript(`window.ripple && window.ripple(${Math.round(lp.x)}, ${Math.round(lp.y)}, ${hold ? 'true' : 'false'})`).catch(() => {})
  return true
}

export function stroke(target, from, to) {
  const e = entryFor(target)
  if (!e?.win || e.win.isDestroyed()) return false
  const a = toOverlayPoint(target, from)
  const b = toOverlayPoint(target, to)
  if (!a || !b) return false
  e.win.webContents.executeJavaScript(`window.stroke && window.stroke(${Math.round(a.x)}, ${Math.round(a.y)}, ${Math.round(b.x)}, ${Math.round(b.y)})`).catch(() => {})
  return true
}

export function pulse(target) {
  const e = target ? entryFor(target) : null
  const wins = e ? [e] : [...state.byDevice.values()]
  for (const w of wins) {
    try {
      if (w.win && !w.win.isDestroyed()) w.win.webContents.executeJavaScript('window.pulse && window.pulse()').catch(() => {})
    } catch {
      // cosmetic
    }
  }
}

/** Presence assertion before a gated tool: "on" must mean visibly on. */
export async function ensureIndicator(target, opts) {
  if (!state.wanted) return false
  if (indicatorAlive(target)) return true
  const r = await indicatorShow(target, opts)
  return r.shown
}

export async function indicatorDomState(target) {
  const e = entryFor(target)
  if (!e?.win || e.win.isDestroyed()) return null
  try {
    return await e.win.webContents.executeJavaScript('window.state && window.state()')
  } catch {
    return null
  }
}

export function indicatorEntry(target) {
  const e = entryFor(target)
  return e ? { bounds: e.bounds, screenRect: e.screenRect, dip: e.dip } : null
}

export function destroyIndicator() {
  indicatorHide({ immediate: true })
}
