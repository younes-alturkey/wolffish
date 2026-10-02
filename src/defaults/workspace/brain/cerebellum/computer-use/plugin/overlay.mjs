/**
 * The screen indicator: a blue glow along the edges of the controlled
 * display, a centered "Wolffish is capturing your screen" pill, and — new —
 * a SHADOW CURSOR: an arrow that glides to wherever the agent is about to
 * act, pulses on the press, and parks there afterwards, so the person can
 * always see where Wolffish is working while their own pointer stays free.
 *
 * One transparent, click-through, content-protected BrowserWindow per
 * display. Content protection keeps the whole layer out of every capture
 * (macOS sharingType none, Windows WDA_EXCLUDEFROMCAPTURE); Linux has no
 * such flag, so there the window hides for the instant of a display-scope
 * capture (window-scope captures never include it).
 *
 * Lifecycle stays model-owned (computer_glow_on / computer_glow_off — see
 * index.mjs and agent/screen-indicator-guard.ts). What this module adds on
 * top is PRESENCE: `wanted` records that the model turned the indicator on,
 * and `ensureAlive` recreates the window when the OS destroyed it (a display
 * unplugged, a sleep/wake) so "on" always means visibly on. There is still
 * no timer: only computer_glow_off, the turn-end nudge and the Agent's
 * post-turn failsafe take it down.
 *
 * Ordering rule for the cursor (borrowed from open-codex's virtual cursor):
 * animate to the point FIRST, post the input, THEN pulse. The person sees
 * cause before effect.
 */

let electronScreen = null
let electronBrowserWindow = null
let log = () => {}
let getLocale = () => 'en'

const OVERLAY_FADE_MS = 650
const WINDOW_TITLE = 'wolffish-screen-glow'

// Test hook: an eval that wants to SEE the overlay in a capture (to prove the
// glow and shadow cursor render where they should) opts out of content
// protection. Never set in production; the default keeps captures clean.
const CAPTURE_VISIBLE = process.env.WOLFFISH_OVERLAY_CAPTURE_VISIBLE === '1'

const overlay = {
  win: null,
  displayId: null,
  assertBounds: null,
  wantedBounds: null,
  locale: null,
  // The model turned the indicator on and has not turned it off.
  wanted: false,
  // Set when the model's own computer_glow_on could not put anything on
  // screen. Opens the gate for that session; cleared by glow_off.
  unavailable: false,
  // Last shadow-cursor placement, global logical coordinates.
  cursor: null,
  listeners: false
}

const OVERLAY_TEXT = {
  en: { dir: 'ltr', text: 'Wolffish is capturing your screen' },
  ar: { dir: 'rtl', text: 'وولفيش يلتقط شاشتك' }
}

export function initOverlay({ electron, locale, logger }) {
  electronScreen = electron?.screen ?? null
  electronBrowserWindow = electron?.BrowserWindow ?? null
  if (typeof locale === 'function') getLocale = locale
  if (typeof logger === 'function') log = logger
  // A plugin reload orphans any glow the previous generation left on
  // screen — with no idle timer, it would otherwise stay up forever.
  try {
    for (const w of electronBrowserWindow?.getAllWindows?.() ?? []) {
      if (w.getTitle?.() === WINDOW_TITLE) w.destroy()
    }
  } catch {
    // Cosmetic only.
  }
  if (electronScreen && !overlay.listeners) {
    overlay.listeners = true
    // Display topology changed under a live indicator: rebuild it on a
    // display that still exists, so "on" never means "on a display that is
    // gone".
    const rebuild = () => {
      if (!overlay.wanted) return
      try {
        const displays = electronScreen.getAllDisplays()
        const still = displays.find((d) => d.id === overlay.displayId)
        if (!still || !overlay.win || overlay.win.isDestroyed()) {
          hideOverlay(true, { keepWanted: true })
          showOverlay(still ?? electronScreen.getPrimaryDisplay())
        } else {
          showOverlay(still)
        }
      } catch {
        // Cosmetic only.
      }
    }
    try {
      electronScreen.on('display-removed', rebuild)
      electronScreen.on('display-added', rebuild)
      electronScreen.on('display-metrics-changed', rebuild)
    } catch {
      // Older Electron without these events — presence assertion still covers it.
    }
  }
}

function overlayHtml(locale) {
  const t = OVERLAY_TEXT[locale] ?? OVERLAY_TEXT.en
  const edges = (a, b) =>
    `linear-gradient(to bottom, rgba(59,130,246,${a}), rgba(59,130,246,${b}) 55%, rgba(59,130,246,0)),` +
    `linear-gradient(to top, rgba(59,130,246,${a}), rgba(59,130,246,${b}) 55%, rgba(59,130,246,0)),` +
    `linear-gradient(to right, rgba(59,130,246,${a}), rgba(59,130,246,${b}) 55%, rgba(59,130,246,0)),` +
    `linear-gradient(to left, rgba(59,130,246,${a}), rgba(59,130,246,${b}) 55%, rgba(59,130,246,0))`
  const layer =
    'position:fixed;inset:0;background-repeat:no-repeat;' +
    'background-size:100% 22px,100% 22px,22px 100%,22px 100%;' +
    'background-position:top,bottom,left,right;'
  // The cursor: a classic arrow with a white body and dark outline (legible
  // on any background), a soft blue halo, a press ring, a keyboard badge for
  // typing/hotkeys, and a fuzzy disc for approximate placements. The label
  // under it names the target the model passed.
  const arrow =
    '<svg id="arrow" width="28" height="36" viewBox="0 0 28 36"><path d="M2 2 L2 28 L9 21 L14 33 L19 31 L14 19 L24 19 Z" fill="#FFFFFF" stroke="#0B1A3A" stroke-width="2" stroke-linejoin="round"/></svg>'
  const kbd =
    '<svg id="kbd" width="30" height="20" viewBox="0 0 30 20"><rect x="1" y="1" width="28" height="18" rx="4" fill="#FFFFFF" stroke="#0B1A3A" stroke-width="2"/><rect x="5" y="5" width="4" height="3" fill="#0B1A3A"/><rect x="11" y="5" width="4" height="3" fill="#0B1A3A"/><rect x="17" y="5" width="4" height="3" fill="#0B1A3A"/><rect x="7" y="11" width="16" height="3" fill="#0B1A3A"/></svg>'
  const html =
    `<!doctype html><html dir="${t.dir}"><head><meta charset="utf-8"><style>` +
    'html,body{margin:0;width:100vw;height:100vh;background:transparent;overflow:hidden;pointer-events:none}' +
    'body{opacity:0;animation:fi .45s ease-out forwards}' +
    'body.bye{animation:fo .6s ease-in forwards}' +
    `#base{${layer}background-image:${edges(0.4, 0.12)}}` +
    `#breathe{${layer}background-image:${edges(0.62, 0.2)};opacity:0;animation:br 3.2s ease-in-out infinite}` +
    `#pulse{${layer}background-image:${edges(0.9, 0.34)};opacity:0}` +
    '#pulse.on{animation:pu .8s ease-out}' +
    '#chip{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);display:flex;align-items:center;gap:8px;' +
    'padding:7px 16px;border-radius:999px;background:rgba(8,15,33,.42);' +
    'backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);' +
    'border:1px solid rgba(96,165,250,.3);color:rgba(226,236,255,.62);' +
    "font:500 13px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;letter-spacing:.2px}" +
    '#dot{width:7px;height:7px;border-radius:50%;background:#60A5FA;box-shadow:0 0 8px 2px rgba(96,165,250,.55);' +
    'animation:db 2.4s ease-in-out infinite}' +
    // Shadow cursor. #cur is translated so its (0,0) is the hotspot: the
    // arrow tip sits at the container origin; the halo, ring and badge are
    // centered on it; the label hangs below.
    '#cur{position:fixed;left:0;top:0;width:0;height:0;transform:translate(-100px,-100px);will-change:transform;display:none}' +
    '#cur.show{display:block}' +
    '#halo{position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;background:rgba(59,130,246,.28);' +
    'box-shadow:0 0 14px 4px rgba(59,130,246,.35)}' +
    '#arrow{position:absolute;left:-2px;top:-2px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}' +
    '#kbd{position:absolute;left:-15px;top:-10px;display:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}' +
    '#blob{position:absolute;left:-16px;top:-16px;width:32px;height:32px;border-radius:50%;background:rgba(59,130,246,.35);' +
    'border:2px dashed rgba(255,255,255,.85);display:none}' +
    '#cur.kind-keyboard #arrow{display:none}#cur.kind-keyboard #kbd{display:block}' +
    '#cur.kind-approximate #arrow{display:none}#cur.kind-approximate #blob{display:block}' +
    '#ring{position:absolute;left:-18px;top:-18px;width:36px;height:36px;border-radius:50%;border:3px solid #60A5FA;opacity:0}' +
    '#ring.on{animation:rg .55s ease-out}' +
    '#lbl{position:absolute;left:14px;top:30px;white-space:nowrap;padding:3px 8px;border-radius:6px;background:rgba(8,15,33,.7);' +
    "color:#E4ECFF;font:500 11px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;max-width:260px;overflow:hidden;text-overflow:ellipsis}" +
    '#lbl:empty{display:none}' +
    '@keyframes fi{to{opacity:1}}' +
    '@keyframes fo{to{opacity:0}}' +
    '@keyframes br{0%,100%{opacity:.12}50%{opacity:1}}' +
    '@keyframes pu{0%{opacity:.95}100%{opacity:0}}' +
    '@keyframes db{0%,100%{opacity:.45}50%{opacity:1}}' +
    '@keyframes rg{0%{opacity:.9;transform:scale(.5)}100%{opacity:0;transform:scale(1.8)}}' +
    '</style></head><body>' +
    '<div id="base"></div><div id="breathe"></div><div id="pulse"></div>' +
    `<div id="chip"><div id="dot"></div><span>${t.text}</span></div>` +
    `<div id="cur"><div id="halo"></div><div id="ring"></div>${arrow}${kbd}<div id="blob"></div><div id="lbl"></div></div>` +
    '<scr' +
    'ipt>' +
    'window.pulse=function(){var p=document.getElementById("pulse");p.classList.remove("on");void p.offsetWidth;p.classList.add("on")};' +
    'window.bye=function(){document.body.classList.add("bye")};' +
    'window.cursorTo=function(x,y,kind,label,ms){var c=document.getElementById("cur");c.className="show kind-"+(kind||"pointer");' +
    'document.getElementById("lbl").textContent=label||"";' +
    'c.style.transition=ms>0?"transform "+ms+"ms cubic-bezier(.3,.9,.35,1)":"none";' +
    'void c.offsetWidth;c.style.transform="translate("+x+"px,"+y+"px)";return true};' +
    'window.cursorPulse=function(){var r=document.getElementById("ring");r.classList.remove("on");void r.offsetWidth;r.classList.add("on");return true};' +
    'window.cursorHide=function(){document.getElementById("cur").className="";return true};' +
    'window.cursorState=function(){var c=document.getElementById("cur");var m=/translate\\(([-\\d.]+)px, ?([-\\d.]+)px\\)/.exec(c.style.transform||"");' +
    'return {shown:c.classList.contains("show"),kind:(c.className.match(/kind-(\\w+)/)||[])[1]||null,x:m?Number(m[1]):null,y:m?Number(m[2]):null,label:document.getElementById("lbl").textContent}};' +
    '</scr' +
    'ipt></body></html>'
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

export function hideOverlay(immediate = false, { keepWanted = false } = {}) {
  const win = overlay.win
  overlay.win = null
  overlay.displayId = null
  overlay.assertBounds = null
  overlay.wantedBounds = null
  overlay.locale = null
  overlay.cursor = null
  if (!keepWanted) overlay.wanted = false
  if (!win || win.isDestroyed()) return
  const destroy = () => {
    try {
      if (!win.isDestroyed()) win.destroy()
    } catch {
      // Already gone.
    }
  }
  if (immediate || process.platform === 'linux') {
    destroy()
    return
  }
  try {
    win.webContents.executeJavaScript('window.bye && window.bye()').catch(() => {})
    const t = setTimeout(destroy, OVERLAY_FADE_MS + 150)
    if (typeof t.unref === 'function') t.unref()
  } catch {
    destroy()
  }
}

function createOverlayWindow(display) {
  const b = display.bounds
  const win = new electronBrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
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
    // Without this, macOS constrainFrameRect re-clamps the frameless window
    // to a screen's visible frame some time after show (verified live: the
    // bottom border went missing). The snap-back below heals any move the
    // OS still makes.
    enableLargerThanScreen: true,
    roundedCorners: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setIgnoreMouseEvents(true)
  if (!CAPTURE_VISIBLE) win.setContentProtection(true)
  win.loadURL(overlayHtml(getLocale()))
  win.showInactive()
  const wanted = { x: b.x, y: b.y, width: b.width, height: b.height }
  const snap = () => {
    try {
      if (win.isDestroyed()) return
      const cur = win.getBounds()
      if (cur.x !== wanted.x || cur.y !== wanted.y || cur.width !== wanted.width || cur.height !== wanted.height) {
        win.setBounds(wanted)
      }
    } catch {
      // Cosmetic only.
    }
  }
  win.setBounds(wanted)
  win.on('move', snap)
  win.on('resize', snap)
  overlay.win = win
  overlay.displayId = display.id
  overlay.assertBounds = snap
  overlay.wantedBounds = wanted
  overlay.locale = getLocale()
  log(`[computer-use] screen glow shown on display ${display.id} (${display.bounds.width}x${display.bounds.height})`)
}

/**
 * Show the glow on the given display (or move it there). Returns whether it
 * is showing. Never throws — overlay trouble must not fail a tool call.
 */
export function showOverlay(display) {
  try {
    if (!electronBrowserWindow || !display) return false
    const locale = getLocale()
    const db = display.bounds
    const geometryChanged =
      overlay.wantedBounds &&
      overlay.displayId === display.id &&
      (overlay.wantedBounds.x !== db.x ||
        overlay.wantedBounds.y !== db.y ||
        overlay.wantedBounds.width !== db.width ||
        overlay.wantedBounds.height !== db.height)
    if (overlay.win && (overlay.win.isDestroyed() || overlay.displayId !== display.id || geometryChanged)) {
      hideOverlay(true, { keepWanted: true })
    }
    if (!overlay.win) {
      createOverlayWindow(display)
    } else {
      overlay.assertBounds?.()
      if (overlay.locale !== locale && !overlay.win.isDestroyed()) {
        overlay.locale = locale
        const t = OVERLAY_TEXT[locale] ?? OVERLAY_TEXT.en
        overlay.win.webContents
          .executeJavaScript(
            `document.documentElement.setAttribute('dir', ${JSON.stringify(t.dir)});` +
              `var s = document.querySelector('#chip span'); if (s) s.textContent = ${JSON.stringify(t.text)};`
          )
          .catch(() => {})
      }
    }
    overlay.wanted = true
    return !!overlay.win
  } catch (err) {
    log(`[computer-use] screen glow failed: ${err?.message ?? String(err)}`)
    return false
  }
}

/** True when the window is alive on screen right now. */
export function overlayAlive() {
  return !!(overlay.win && !overlay.win.isDestroyed())
}

export function overlayWanted() {
  return overlay.wanted
}

export function overlayUnavailable() {
  return overlay.unavailable
}

export function setOverlayUnavailable(value) {
  overlay.unavailable = !!value
}

/**
 * Presence assertion, called by the gate before every capture or input
 * tool: the model turned the indicator on, so it must be visibly on. If the
 * OS destroyed the window meanwhile, recreate it instead of acting unseen.
 */
export function ensureOverlayAlive() {
  if (!overlay.wanted) return overlayAlive()
  if (overlayAlive()) return true
  try {
    const displays = electronScreen?.getAllDisplays?.() ?? []
    const target = displays.find((d) => d.id === overlay.displayId) ?? electronScreen?.getPrimaryDisplay?.()
    if (!target) return false
    log('[computer-use] screen glow window was gone while the indicator is on — recreating it')
    return showOverlay(target)
  } catch {
    return false
  }
}

/** While on, keep the glow over the display being controlled. Never creates it. */
export function followOverlay(display) {
  if (!overlay.wanted) return
  if (!display) return
  showOverlay(display)
}

export function followOverlayAtPoint(point) {
  try {
    if (!electronScreen || !point) return
    followOverlay(electronScreen.getDisplayNearestPoint(point))
  } catch {
    // Cosmetic only.
  }
}

export function pulseOverlay() {
  try {
    if (overlayAlive()) overlay.win.webContents.executeJavaScript('window.pulse && window.pulse()').catch(() => {})
  } catch {
    // Cosmetic only.
  }
}

/** Linux has no content protection: hide for the instant of a display capture. */
export async function overlayBeforeCapture() {
  if (process.platform !== 'linux' || CAPTURE_VISIBLE) return
  try {
    if (overlayAlive() && overlay.win.isVisible()) {
      overlay.win.hide()
      await new Promise((r) => setTimeout(r, 90))
    }
  } catch {
    // Cosmetic only.
  }
}

export function overlayAfterCapture() {
  if (process.platform !== 'linux' || CAPTURE_VISIBLE) return
  try {
    if (overlayAlive()) overlay.win.showInactive()
  } catch {
    // Cosmetic only.
  }
}

// ─── Shadow cursor ──────────────────────────────────────────────────────

const GLIDE_MIN_MS = 140
const GLIDE_MAX_MS = 340

/** Distance-scaled glide time, like a hand moving a mouse. Pure. */
export function glideDuration(fromPoint, toPoint) {
  if (!fromPoint) return GLIDE_MIN_MS
  const d = Math.hypot(toPoint.x - fromPoint.x, toPoint.y - fromPoint.y)
  return Math.round(Math.max(GLIDE_MIN_MS, Math.min(GLIDE_MAX_MS, GLIDE_MIN_MS + d * 0.25)))
}

/**
 * Glide the shadow cursor to a global logical point on whichever display
 * holds it. Resolves after the glide so the caller posts the input only
 * once the cursor has arrived. `kind` is pointer | keyboard | approximate.
 */
export async function cursorTo(point, { kind = 'pointer', label = '', animate = true } = {}) {
  try {
    if (!overlay.wanted || !electronScreen) return false
    const display = electronScreen.getDisplayNearestPoint(point)
    followOverlay(display)
    if (!overlayAlive()) return false
    const local = { x: point.x - display.bounds.x, y: point.y - display.bounds.y }
    const from = overlay.cursor && overlay.cursor.displayId === display.id ? overlay.cursor : null
    const ms = animate ? glideDuration(from, point) : 0
    overlay.cursor = { ...point, displayId: display.id, kind, label }
    const safeLabel = String(label ?? '').slice(0, 80)
    await overlay.win.webContents.executeJavaScript(
      `window.cursorTo && window.cursorTo(${Math.round(local.x)}, ${Math.round(local.y)}, ${JSON.stringify(kind)}, ${JSON.stringify(safeLabel)}, ${ms})`
    )
    if (ms > 0) await new Promise((r) => setTimeout(r, ms + 20))
    return true
  } catch {
    return false
  }
}

export function cursorPulse() {
  try {
    if (overlayAlive()) overlay.win.webContents.executeJavaScript('window.cursorPulse && window.cursorPulse()').catch(() => {})
  } catch {
    // Cosmetic only.
  }
}

export function cursorHide() {
  overlay.cursor = null
  try {
    if (overlayAlive()) overlay.win.webContents.executeJavaScript('window.cursorHide && window.cursorHide()').catch(() => {})
  } catch {
    // Cosmetic only.
  }
}

/** Where the shadow cursor is parked (global logical), for tests and forensics. */
export function cursorPosition() {
  return overlay.cursor ? { x: overlay.cursor.x, y: overlay.cursor.y, kind: overlay.cursor.kind } : null
}

/** Reads the page-side cursor state (for the e2e harness). */
export async function cursorDomState() {
  if (!overlayAlive()) return null
  try {
    return await overlay.win.webContents.executeJavaScript('window.cursorState && window.cursorState()')
  } catch {
    return null
  }
}

export function overlayDisplayId() {
  return overlay.displayId
}

/** Plugin teardown: nothing may outlive the process that drew it. */
export function destroyOverlay() {
  hideOverlay(true)
}
