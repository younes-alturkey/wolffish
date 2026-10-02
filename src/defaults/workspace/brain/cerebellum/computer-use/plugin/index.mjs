import fs from 'node:fs/promises'
import path from 'node:path'

import * as driver from './driver.mjs'
import * as overlay from './overlay.mjs'
import * as elements from './elements.mjs'
import { buildAccessReport, probeAccess } from './access.mjs'

/**
 * Computer use, v3. Three ideas on top of the verified-aim loop (frame
 * contract, native zoom, magnifier proof, change detection):
 *
 *  1. BACKGROUND INPUT through a native driver (driver.mjs): clicks, keys
 *     and scrolls are posted to the target WINDOW without moving the
 *     person's pointer or raising the window. When a background route does
 *     not exist for an app, the driver says so with a code and the plugin
 *     escalates one rung — foreground delivery with the pointer restored —
 *     and, only if that is impossible too, the legacy foreground synthesis
 *     (nut-js). Every result names the rung that ran.
 *  2. A SHADOW CURSOR in the screen indicator (overlay.mjs): the person sees
 *     where Wolffish is about to act before it acts, while their own pointer
 *     stays theirs.
 *  3. A SECOND GROUNDING ROUTE (elements.mjs): the target window's
 *     accessibility tree — find by text, click by token, read a field — and,
 *     on every pixel click, the element under the point echoed back so the
 *     model can check its aim against what it meant.
 *
 * Coordinates are still the frame contract: the model reads pixels off the
 * latest image; the plugin owns every translation (downscale, DPI, monitor
 * offsets, window-local capture pixels for the driver).
 */

let nutMouse, nutKeyboard, nutButton, nutPoint, nutStraightTo
let nutReady = false
let electron = null
let electronScreen, electronDesktopCapturer, electronClipboard, electronBrowserWindow
let sharp
let permissionError = null
let workspaceRoot = ''
let getConversationId = () => null
let screenshotCounter = 0

const DEFAULT_MAX_WIDTH = 1280
const DEFAULT_FORMAT = 'jpeg'
const JPEG_QUALITY = 85
const MIN_REQ_WIDTH = 480
const MAX_REQ_WIDTH = 2560
const MAX_IMAGE_B64_BYTES = 1.2 * 1024 * 1024
const B64_RATIO = 4 / 3

// Magnifier patch: the close-up returned after an action so the model can
// verify exactly where it landed. Logical pixels, rendered at 3x.
const MAG_W = 200
const MAG_H = 125
const MAG_SCALE = 3

const ZOOM_MAX_OUT = 1200
const ZOOM_WIDE_OUT = 1600
const ZOOM_MAX_OUT_H = 1600
const ZOOM_MAX_FACTOR = 4
const ZOOM_TARGET_FACTOR = 2

const CHANGE_PATCH_MIN_PCT = 0.2
const CHANGE_DISPLAY_MIN_PCT = 0.2

// A real-pointer move larger than this during a foreground action means the
// person is using the mouse: the action may not have landed where intended.
const INTERRUPT_PX = 24

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * A refusal the model must fix by changing its call, never by repeating it:
 * coordinates off the frame, an unknown key, a missing argument, a closed
 * gate. `retryable: false` stops the tool loop's own retry ladder, which
 * otherwise spends three attempts (observed: 18 s per miss) on an answer
 * that cannot change.
 */
const refuse = (error) => ({ success: false, error, retryable: false })

// ─── Per-conversation session state ─────────────────────────────────────
//
// frame      — the coordinate frame the model is working in (latest image)
// aim        — where the shadow cursor is parked (global DIP), the point
//              "click with no coordinates" presses
// lastTarget — the window the last action went to (typing goes there)
// lastAction — what the model just did and expected (runtime-tail verify)

const sessions = new Map()

function sessionKey() {
  return getConversationId() ?? 'global'
}

function session() {
  const k = sessionKey()
  let s = sessions.get(k)
  if (!s) {
    s = { frame: null, aim: null, lastTarget: null, lastAction: null, lastCapture: null }
    sessions.set(k, s)
  }
  return s
}

function currentFrame() {
  return session().frame
}

function setFrame(frame) {
  const s = session()
  s.frame = frame
  if (frame.kind === 'screenshot' || frame.kind === 'window screenshot') {
    s.lastCapture = { kind: frame.kind, width: frame.width, height: frame.height }
  }
}

// ─── nut-js key vocabulary (legacy rung) ────────────────────────────────

const KEY_MAP = {
  enter: 'Return',
  return: 'Return',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  space: 'Space',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  pgup: 'PageUp',
  pgdn: 'PageDown',
  insert: 'Insert',
  capslock: 'CapsLock',
  f1: 'F1',
  f2: 'F2',
  f3: 'F3',
  f4: 'F4',
  f5: 'F5',
  f6: 'F6',
  f7: 'F7',
  f8: 'F8',
  f9: 'F9',
  f10: 'F10',
  f11: 'F11',
  f12: 'F12',
  ctrl: 'LeftControl',
  control: 'LeftControl',
  alt: 'LeftAlt',
  option: 'LeftAlt',
  opt: 'LeftAlt',
  shift: 'LeftShift',
  meta: 'LeftSuper',
  cmd: 'LeftSuper',
  command: 'LeftSuper',
  super: 'LeftSuper',
  win: 'LeftSuper',
  '.': 'Period',
  ',': 'Comma',
  '/': 'Slash',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  '[': 'LeftBracket',
  ']': 'RightBracket',
  '-': 'Minus',
  '=': 'Equal',
  '`': 'Grave',
  0: 'Num0',
  1: 'Num1',
  2: 'Num2',
  3: 'Num3',
  4: 'Num4',
  5: 'Num5',
  6: 'Num6',
  7: 'Num7',
  8: 'Num8',
  9: 'Num9'
}

// Word names the model reaches for ("period", "comma") → the character
// KEY_MAP already knows.
const KEY_WORDS = {
  period: '.',
  dot: '.',
  comma: ',',
  slash: '/',
  backslash: '\\',
  semicolon: ';',
  quote: "'",
  apostrophe: "'",
  minus: '-',
  dash: '-',
  hyphen: '-',
  equal: '=',
  equals: '=',
  grave: '`',
  backtick: '`',
  bracketleft: '[',
  bracketright: ']'
}

function resolveKey(Key, name) {
  const trimmed = String(name).trim()
  const lower = trimmed.toLowerCase()
  const mapped = KEY_MAP[lower] ?? KEY_MAP[KEY_WORDS[lower] ?? '']
  if (mapped && Key[mapped] !== undefined) return Key[mapped]
  if (trimmed.length === 1) {
    const upper = trimmed.toUpperCase()
    if (Key[upper] !== undefined) return Key[upper]
  }
  if (Key[trimmed] !== undefined) return Key[trimmed]
  return null
}

/** Split "cmd+shift+s" / key + comma-modifiers into { key, modifiers }. Pure. */
export function parseKeyCombo(rawKey, rawModifiers = '') {
  let keyName = String(rawKey ?? '').trim()
  const mods = []
  if (keyName.length > 1 && keyName.includes('+')) {
    const parts = keyName
      .split('+')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
    if (parts.length > 1) {
      keyName = parts[parts.length - 1]
      mods.push(...parts.slice(0, -1))
    }
  }
  for (const m of String(rawModifiers ?? '').split(',')) {
    const t = m.trim()
    if (t) mods.push(t)
  }
  return { key: keyName, modifiers: mods.map((m) => m.toLowerCase()) }
}

// ─── Config / locale ────────────────────────────────────────────────────

async function readConfig() {
  if (!workspaceRoot) return {}
  try {
    const raw = await fs.readFile(path.join(workspaceRoot, 'config.json'), 'utf8')
    return JSON.parse(raw)?.computerUse ?? {}
  } catch {
    return {}
  }
}

let appLocale = 'en'

function refreshAppLocale() {
  if (!workspaceRoot) return
  fs.readFile(path.join(workspaceRoot, 'config.json'), 'utf8')
    .then((raw) => {
      appLocale = JSON.parse(raw)?.locale === 'ar' ? 'ar' : 'en'
    })
    .catch(() => {})
}

// ─── Permissions (legacy probe; the real answer is computer_check_access) ──

async function checkNut() {
  try {
    await nutMouse.getPosition()
    nutReady = true
    permissionError = null
  } catch (err) {
    nutReady = false
    const msg = err?.message ?? String(err)
    if (process.platform === 'darwin') {
      permissionError =
        'Screen recording and accessibility permissions required. ' +
        'Grant them in System Settings → Privacy & Security → Screen Recording and Accessibility, then restart Wolffish.'
    } else if (process.platform === 'linux') {
      permissionError = msg.includes('X11')
        ? 'X11 is required for the fallback input path on Linux. Wayland works through the native driver where the compositor allows it.'
        : `Permission error: ${msg}`
    } else {
      permissionError = `Permission error: ${msg}`
    }
  }
}

function requirePermissions() {
  if (!nutReady && !driver.status().available) {
    return {
      success: false,
      error:
        (permissionError || 'Desktop automation is unavailable on this machine.') +
        ' Call computer_check_access for the exact grant that is missing.'
    }
  }
  return null
}

// ─── Coordinate spaces ──────────────────────────────────────────────────
//
//   frame   — pixels of the latest image the model saw
//   DIP     — Electron's logical global desktop coordinates
//   native  — what the legacy input layer expects (macOS: DIP; Windows and
//             Linux/X11: physical pixels)
//   winpx   — what the native driver expects for a window target: pixels of
//             the window's own capture (title bar included) at the display's
//             backing scale

function frameToDip(frame, x, y) {
  return {
    x: Math.floor((x + 0.5) * frame.scale + frame.offsetX),
    y: Math.floor((y + 0.5) * frame.scale + frame.offsetY)
  }
}

/**
 * A magnifier or zoom taken while the model works inside a window keeps
 * that window's scope, so clicks read off it still go to THAT window even
 * when another window has since been dragged over the point. Pure.
 */
export function inheritWindowScope(prev, region) {
  if (!prev || prev.scope !== 'window' || !prev.windowBounds) return {}
  // The region's CENTER decides: a magnifier or zoom around a control near
  // the window's edge spills past the frame, yet the point of interest is
  // still inside the window.
  const b = prev.windowBounds
  const cx = region.x + region.width / 2
  const cy = region.y + region.height / 2
  const inside = cx >= b.x && cy >= b.y && cx < b.x + b.width && cy < b.y + b.height
  if (!inside) return {}
  return { scope: 'window', pid: prev.pid, windowId: prev.windowId, app: prev.app, title: prev.title, windowBounds: { ...b } }
}

function dipToFrame(frame, dip) {
  return {
    x: Math.round((dip.x - frame.offsetX) / frame.scale),
    y: Math.round((dip.y - frame.offsetY) / frame.scale)
  }
}

function dipToNative(x, y) {
  if (process.platform === 'darwin') return { x, y }
  if (process.platform === 'win32' && typeof electronScreen.dipToScreenPoint === 'function') {
    const p = electronScreen.dipToScreenPoint({ x, y })
    return { x: p.x, y: p.y }
  }
  const display = electronScreen.getDisplayNearestPoint({ x, y })
  const f = display.scaleFactor || 1
  if (f === 1) return { x, y }
  return {
    x: Math.round(display.bounds.x * f + (x - display.bounds.x) * f),
    y: Math.round(display.bounds.y * f + (y - display.bounds.y) * f)
  }
}

function backingScaleFor(bounds) {
  try {
    return electronScreen.getDisplayMatching(bounds).scaleFactor || 1
  } catch {
    return 1
  }
}

/** Global DIP → window-local capture pixels for the driver. Pure given the scale. */
export function windowLocalPx(bounds, dip, scale) {
  return { x: (dip.x - bounds.x) * scale, y: (dip.y - bounds.y) * scale }
}

function validateFrameCoords(x, y, label = 'Coordinates') {
  const frame = currentFrame()
  if (!frame) {
    return (
      `${label} (${x}, ${y}) cannot be used yet: there is no current frame. ` +
      'Take a computer_screenshot (or computer_window_screenshot) first, then give coordinates read from that image.'
    )
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
    return frameCoordsError(frame, session().lastCapture, x, y, label)
  }
  return null
}

/**
 * The out-of-frame refusal. When the model is working from a magnifier or
 * zoom and its coordinates would fit the LAST full capture, say so by name:
 * that is the mistake (observed live) — reading the earlier screenshot after
 * a click made the magnifier the frame. Pure; exported for tests.
 */
export function frameCoordsError(frame, lastCapture, x, y, label = 'Coordinates') {
  const base =
    `${label} (${x}, ${y}) are outside the current frame. The current frame is the LATEST image you received ` +
    `(a ${frame.width}x${frame.height} ${frame.kind}); valid range is x 0-${frame.width - 1}, y 0-${frame.height - 1}.`
  const derived = frame.kind === 'magnifier' || frame.kind === 'zoom'
  if (derived && lastCapture && x >= 0 && y >= 0 && x < lastCapture.width && y < lastCapture.height) {
    return (
      `${base} These coordinates fit the earlier ${lastCapture.width}x${lastCapture.height} ${lastCapture.kind}, which is no longer the frame ` +
      `— the ${frame.kind} replaced it. Either act inside the ${frame.kind} using its own coordinates, or take a fresh capture ` +
      `(computer_screenshot or computer_window_screenshot) and read new coordinates from that.`
    )
  }
  return `${base} Coordinates from an older image are invalid — take a fresh capture and read new coordinates from it.`
}

// ─── Capture ────────────────────────────────────────────────────────────

function getDisplayByIndex(index) {
  const displays = electronScreen.getAllDisplays()
  return { displays, display: displays[index] || electronScreen.getPrimaryDisplay() }
}

async function captureNative(display) {
  const targetW = Math.round(display.size.width * display.scaleFactor)
  const targetH = Math.round(display.size.height * display.scaleFactor)
  await overlay.overlayBeforeCapture()
  let sources
  try {
    sources = await electronDesktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: targetW, height: targetH }
    })
  } finally {
    overlay.overlayAfterCapture()
  }
  const displayId = String(display.id)
  let source = sources.find((s) => s.display_id === displayId)
  if (!source) {
    const displays = electronScreen.getAllDisplays()
    const index = displays.findIndex((d) => d.id === display.id)
    source = sources[index >= 0 ? index : 0]
  }
  if (!source) throw new Error('No screen source found for capture.')
  const size = source.thumbnail.getSize()
  if (size.width === 0 || size.height === 0) {
    throw new Error(
      'Screenshot returned empty image. Check Screen Recording permission in System Settings → Privacy & Security.'
    )
  }
  return { png: source.thumbnail.toPNG(), nativeW: size.width, nativeH: size.height }
}

function realPointer() {
  try {
    return electronScreen.getCursorScreenPoint()
  } catch {
    return null
  }
}

/** The aim point: where the shadow cursor is parked, else the real pointer. */
function aimPoint() {
  return session().aim ?? realPointer()
}

// ─── Image helpers ──────────────────────────────────────────────────────

function crosshairSvg(imgW, imgH, cx, cy, hairlines = false) {
  const c = '#FF1B8D'
  const hair = hairlines
    ? `<g opacity="0.55" stroke="#FFFFFF" stroke-width="3">` +
      `<line x1="0" y1="${cy}" x2="${cx - 22}" y2="${cy}"/>` +
      `<line x1="${cx + 22}" y1="${cy}" x2="${imgW}" y2="${cy}"/>` +
      `<line x1="${cx}" y1="0" x2="${cx}" y2="${cy - 22}"/>` +
      `<line x1="${cx}" y1="${cy + 22}" x2="${cx}" y2="${imgH}"/>` +
      `</g>` +
      `<g stroke="${c}" stroke-width="1.2">` +
      `<line x1="0" y1="${cy}" x2="${cx - 22}" y2="${cy}"/>` +
      `<line x1="${cx + 22}" y1="${cy}" x2="${imgW}" y2="${cy}"/>` +
      `<line x1="${cx}" y1="0" x2="${cx}" y2="${cy - 22}"/>` +
      `<line x1="${cx}" y1="${cy + 22}" x2="${cx}" y2="${imgH}"/>` +
      `</g>`
    : ''
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${imgW}" height="${imgH}">` +
      `<g fill="none">` +
      hair +
      `<circle cx="${cx}" cy="${cy}" r="9" stroke="#FFFFFF" stroke-width="4" opacity="0.9"/>` +
      `<circle cx="${cx}" cy="${cy}" r="9" stroke="${c}" stroke-width="2"/>` +
      `<line x1="${cx - 16}" y1="${cy}" x2="${cx - 6}" y2="${cy}" stroke="${c}" stroke-width="2"/>` +
      `<line x1="${cx + 6}" y1="${cy}" x2="${cx + 16}" y2="${cy}" stroke="${c}" stroke-width="2"/>` +
      `<line x1="${cx}" y1="${cy - 16}" x2="${cx}" y2="${cy - 6}" stroke="${c}" stroke-width="2"/>` +
      `<line x1="${cx}" y1="${cy + 6}" x2="${cx}" y2="${cy + 16}" stroke="${c}" stroke-width="2"/>` +
      `<circle cx="${cx}" cy="${cy}" r="1.6" fill="${c}"/>` +
      `</g></svg>`
  )
}

async function savePersistedImage(buffer, ext, prefix) {
  try {
    const convId = getConversationId()
    const safe = (convId ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_')
    const dir = path.join(workspaceRoot, 'screenshots', `conv-${safe}`)
    await fs.mkdir(dir, { recursive: true })
    screenshotCounter++
    const filePath = path.join(dir, `${prefix}-${Date.now()}-${screenshotCounter}.${ext}`)
    await fs.writeFile(filePath, buffer)
    return filePath
  } catch {
    return ''
  }
}

async function regionChangePct(prePng, postPng, crop) {
  const prep = (png) => {
    let p = sharp(png)
    if (crop) {
      p = p.extract(crop)
      if (crop.width > 640) p = p.resize({ width: 640 })
    } else {
      p = p.resize({ width: 256 })
    }
    return p.greyscale().raw().toBuffer({ resolveWithObject: true })
  }
  const threshold = crop ? 20 : 26
  const [a, b] = await Promise.all([prep(prePng), prep(postPng)])
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) return null
  const n = Math.min(a.data.length, b.data.length)
  if (n === 0) return null
  let changed = 0
  for (let i = 0; i < n; i++) {
    if (Math.abs(a.data[i] - b.data[i]) > threshold) changed++
  }
  return (changed / n) * 100
}

/**
 * Magnified close-up centered on `center` (global DIP; default the aim
 * point), crosshair at the exact point. Installed as the new current frame.
 * With `preShot` the fresh capture is diffed against it for an objective
 * did-anything-change verdict.
 */
async function renderMagnifier(preShot = null, center = null) {
  const cur = center ?? aimPoint()
  if (!cur) throw new Error('Could not determine the aim point.')
  const display = electronScreen.getDisplayNearestPoint(cur)
  overlay.followOverlay(display)
  const { png, nativeW, nativeH } = await captureNative(display)

  const b = display.bounds
  const logicalW = display.size.width
  const logicalH = display.size.height
  const regW = Math.min(MAG_W, logicalW)
  const regH = Math.min(MAG_H, logicalH)
  let rx = Math.round(cur.x - b.x - regW / 2)
  let ry = Math.round(cur.y - b.y - regH / 2)
  rx = Math.max(0, Math.min(logicalW - regW, rx))
  ry = Math.max(0, Math.min(logicalH - regH, ry))

  const fx = nativeW / logicalW
  const fy = nativeH / logicalH
  const crop = {
    left: Math.max(0, Math.round(rx * fx)),
    top: Math.max(0, Math.round(ry * fy)),
    width: Math.min(nativeW, Math.round(regW * fx)),
    height: Math.min(nativeH, Math.round(regH * fy))
  }
  crop.width = Math.min(crop.width, nativeW - crop.left)
  crop.height = Math.min(crop.height, nativeH - crop.top)

  const outW = regW * MAG_SCALE
  const outH = regH * MAG_SCALE
  const cxImg = Math.round((cur.x - b.x - rx) * MAG_SCALE)
  const cyImg = Math.round((cur.y - b.y - ry) * MAG_SCALE)

  const buffer = await sharp(png)
    .extract(crop)
    .resize({ width: outW, height: outH, fit: 'fill' })
    .composite([{ input: crosshairSvg(outW, outH, cxImg, cyImg, true), left: 0, top: 0 }])
    .png()
    .toBuffer()

  setFrame({
    kind: 'magnifier',
    scope: 'display',
    scale: 1 / MAG_SCALE,
    offsetX: b.x + rx,
    offsetY: b.y + ry,
    width: outW,
    height: outH,
    displayId: display.id,
    ...inheritWindowScope(currentFrame(), { x: b.x + rx, y: b.y + ry, width: regW, height: regH })
  })

  let changeLine = ''
  let changed = null
  if (preShot && preShot.displayId === display.id && preShot.nativeW === nativeW && preShot.nativeH === nativeH) {
    try {
      const [patchPct, displayPct] = await Promise.all([
        regionChangePct(preShot.png, png, crop),
        regionChangePct(preShot.png, png, null)
      ])
      if (patchPct !== null && displayPct !== null) {
        changed = patchPct >= CHANGE_PATCH_MIN_PCT || displayPct >= CHANGE_DISPLAY_MIN_PCT
        changeLine = changed
          ? ` Screen change detected: ${patchPct.toFixed(1)}% of the area around the point changed` +
            ` (${displayPct.toFixed(1)}% of this display) — animation or video can also trigger this, so confirm with the` +
            ` magnifier/screenshot that it is the change YOU intended.`
          : ` NO visible change was detected on this display within ~0.4s (${patchPct.toFixed(2)}% around the point,` +
            ` ${displayPct.toFixed(2)}% of the display). An immediate local effect (a control toggling, a menu opening, a tab closing)` +
            ` would normally register here — if you expected one, treat this as a MISS: re-locate the target (fresh capture →` +
            ` computer_find or a tight zoom → computer_mouse_move) instead of reporting success. Slow-loading results, effects on another` +
            ` display, or tiny low-contrast changes can evade this check — if the effect may simply be slow, wait and take a` +
            ` computer_screenshot to confirm, and NEVER re-click a side-effectful control (send, submit, buy, delete) on this line alone.`
      }
    } catch {
      // Diffing is best-effort.
    }
  }

  const savedPath = await savePersistedImage(buffer, 'png', 'mag')

  return {
    image: { mediaType: 'image/png', data: buffer.toString('base64') },
    changeLine,
    changed,
    note:
      `The ${outW}x${outH} magnifier below (${MAG_SCALE}x zoom around the point) is now the current frame — ` +
      `the ring and the thin magenta hairlines running to the image edges mark the exact point acted on ` +
      `(drawn by the tool, not part of the UI). To adjust by a small amount, use coordinates read from ` +
      `this magnifier. For anything else, take a fresh capture first.` +
      (savedPath ? `\n${savedPath}` : '')
  }
}

// ─── Capture policy (exported, pure, tested) ────────────────────────────

export function resolveCapture({ args, cfg, logicalW, nativeW }) {
  const cfgWidth = cfg?.screenshotMaxWidth || DEFAULT_MAX_WIDTH
  const cfgFormat = cfg?.screenshotFormat === 'png' ? 'png' : DEFAULT_FORMAT
  const notes = []

  const rawWidth = Number(args?.max_width)
  const wantsWidth = Number.isFinite(rawWidth) && rawWidth > 0
  const reqWidth = wantsWidth ? Math.round(Math.min(MAX_REQ_WIDTH, Math.max(MIN_REQ_WIDTH, rawWidth))) : null
  if (wantsWidth && reqWidth !== Math.round(rawWidth)) {
    notes.push(
      `max_width ${Math.round(rawWidth)} is outside the supported ${MIN_REQ_WIDTH}-${MAX_REQ_WIDTH} range — used ${reqWidth}.`
    )
  }

  const rawFormat = typeof args?.format === 'string' ? args.format.trim().toLowerCase() : ''
  const reqFormat = rawFormat === 'png' ? 'png' : rawFormat === 'jpeg' || rawFormat === 'jpg' ? 'jpeg' : null
  if (rawFormat && reqFormat === null) {
    notes.push(`format "${args.format}" is not recognized — used ${cfgFormat.toUpperCase()}. Valid values: jpeg, png.`)
  }

  const maxWidth = reqWidth ?? Math.min(2048, Math.max(cfgWidth, Math.ceil(logicalW / 3)))
  const outW = Math.min(nativeW, maxWidth)
  if (reqWidth !== null && outW < reqWidth) {
    notes.push(`max_width ${reqWidth} is wider than this capture — this is its native ${outW}px, the most detail available.`)
  }

  return {
    cfgWidth,
    cfgFormat,
    format: reqFormat ?? cfgFormat,
    outW,
    overrode: reqWidth !== null || reqFormat !== null,
    notes
  }
}

/** Resize + encode a native PNG into the model-facing image. Shared by both capture scopes. */
async function encodeCapture({ png, nativeW, outW, format, drawCrosshairAt }) {
  const resized = await (outW < nativeW ? sharp(png).resize({ width: outW, withoutEnlargement: true }) : sharp(png))
    .raw()
    .toBuffer({ resolveWithObject: true })
  const outH = resized.info.height
  let pipeline = sharp(resized.data, {
    raw: { width: resized.info.width, height: resized.info.height, channels: resized.info.channels }
  })
  if (drawCrosshairAt) {
    pipeline = pipeline.composite([{ input: crosshairSvg(outW, outH, drawCrosshairAt.x, drawCrosshairAt.y), left: 0, top: 0 }])
  }
  let buffer, mediaType, ext
  let downgradeNote = ''
  if (format === 'png') {
    buffer = await pipeline.png().toBuffer()
    mediaType = 'image/png'
    ext = 'png'
    if (buffer.length * B64_RATIO > MAX_IMAGE_B64_BYTES) {
      const pngKb = Math.round(buffer.length / 1024)
      buffer = await pipeline.jpeg({ quality: JPEG_QUALITY }).toBuffer()
      mediaType = 'image/jpeg'
      ext = 'jpg'
      downgradeNote =
        ` PNG of this capture came to ${pngKb}KB — over the per-image budget — so it was encoded as JPEG at the SAME ${outW}px.` +
        ` The resolution you asked for is intact. For lossless pixels ask for png at a smaller max_width, or use computer_zoom.`
    }
  } else {
    buffer = await pipeline.jpeg({ quality: JPEG_QUALITY }).toBuffer()
    mediaType = 'image/jpeg'
    ext = 'jpg'
  }
  return { buffer, mediaType, ext, outH, downgradeNote }
}

function settingsLine({ overrode, outW, ext, notes, downgradeNote, cfgWidth, cfgFormat }) {
  const delivered = ext === 'png' ? 'PNG' : 'JPEG'
  return overrode
    ? ` Per-call capture settings applied to THIS image: ${outW}px wide, ${delivered}.` +
        notes.map((n) => ` ${n}`).join('') +
        downgradeNote +
        ` They do NOT persist — the next capture returns to the ${cfgWidth}px ${cfgFormat.toUpperCase()} default unless you pass max_width/format again.`
    : downgradeNote
}

async function takeScreenshot(args) {
  const denied = requirePermissions()
  if (denied) return denied
  try {
    const cfg = await readConfig()
    const displayIndex = Number(args?.display_index) || 0
    const { displays, display } = getDisplayByIndex(displayIndex)

    overlay.followOverlay(display)
    const { png, nativeW, nativeH } = await captureNative(display)
    const { cfgWidth, cfgFormat, format, outW, overrode, notes } = resolveCapture({
      args,
      cfg,
      logicalW: display.size.width,
      nativeW
    })

    const frame = {
      kind: 'screenshot',
      scope: 'display',
      scale: display.size.width / outW,
      offsetX: display.bounds.x,
      offsetY: display.bounds.y,
      width: outW,
      height: 0,
      displayId: display.id
    }

    // Crosshair at the aim point (shadow cursor, else the real pointer).
    const cur = aimPoint()
    let cursorLine = 'The aim point is on another display.'
    let drawAt = null
    if (
      cur &&
      cur.x >= display.bounds.x &&
      cur.x < display.bounds.x + display.size.width &&
      cur.y >= display.bounds.y &&
      cur.y < display.bounds.y + display.size.height
    ) {
      drawAt = { x: Math.round((cur.x - frame.offsetX) / frame.scale), y: Math.round((cur.y - frame.offsetY) / frame.scale) }
      cursorLine = `${session().aim ? 'Shadow cursor' : 'Pointer'} at (${drawAt.x}, ${drawAt.y}), marked with the magenta crosshair.`
    }
    const { buffer, mediaType, ext, outH, downgradeNote } = await encodeCapture({ png, nativeW, outW, format, drawCrosshairAt: drawAt })
    frame.height = outH
    void nativeH
    setFrame(frame)
    overlay.pulseOverlay()

    const displayInfo =
      displays.length > 1
        ? `display ${displayIndex} of ${displays.length} (${display.size.width}x${display.size.height} logical)`
        : `the primary display (${display.size.width}x${display.size.height} logical)`
    const savedPath = await savePersistedImage(buffer, ext, 'shot')
    const headroom = Math.min(nativeW, MAX_REQ_WIDTH)
    const compression = frame.scale
    const compressionLine =
      compression >= 2
        ? ` This overview is compressed ${compression.toFixed(1)}x — small text and small controls are degraded in it, so do NOT locate or judge small targets from this image alone: use computer_find or zoom into candidate regions with computer_zoom` +
          (outW < headroom ? `, or re-take this screenshot with a bigger max_width (up to ${headroom} here).` : '.')
        : ''
    return {
      success: true,
      output:
        `Frame ${outW}x${outH} — screenshot of ${displayInfo}. ${cursorLine} ` +
        `Mouse coordinates must be pixel positions read from THIS image (x 0-${outW - 1}, y 0-${outH - 1}); ` +
        `they are translated to the screen automatically. For a small or crowded target, use computer_find (element by name) or computer_zoom before clicking.` +
        settingsLine({ overrode, outW, ext, notes, downgradeNote, cfgWidth, cfgFormat }) +
        compressionLine +
        (savedPath ? `\n${savedPath}` : ''),
      images: [{ mediaType, data: buffer.toString('base64') }]
    }
  } catch (err) {
    return { success: false, error: `Screenshot failed: ${err?.message ?? String(err)}` }
  }
}

async function zoomRegion(args) {
  const denied = requirePermissions()
  if (denied) return denied

  const x = Number(args?.x)
  const y = Number(args?.y)
  const w = Number(args?.width)
  const h = Number(args?.height)
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
    return { success: false, error: 'x, y, width, height are required (finite numbers; width/height > 0).' }
  }
  const frame = currentFrame()
  const boundsError =
    validateFrameCoords(x, y, 'Region origin') ??
    validateFrameCoords(Math.min(x + w, (frame?.width ?? 1) - 1), Math.min(y + h, (frame?.height ?? 1) - 1), 'Region corner')
  if (boundsError) return refuse(boundsError)
  if (x + w > frame.width || y + h > frame.height) {
    return refuse(
      `Region (${x},${y}) ${w}x${h} extends past the current ${frame.width}x${frame.height} frame. ` +
        'Shrink it to fit, or take a fresh capture first.'
    )
  }

  try {
    const lx = x * frame.scale + frame.offsetX
    const ly = y * frame.scale + frame.offsetY
    const lw = Math.max(12, w * frame.scale)
    const lh = Math.max(8, h * frame.scale)

    const display =
      electronScreen.getAllDisplays().find((d) => d.id === frame.displayId) ??
      electronScreen.getDisplayNearestPoint({ x: Math.round(lx + lw / 2), y: Math.round(ly + lh / 2) })
    const b = display.bounds

    overlay.followOverlay(display)
    const { png, nativeW, nativeH } = await captureNative(display)
    const fx = nativeW / display.size.width
    const fy = nativeH / display.size.height
    const crop = {
      left: Math.max(0, Math.round((lx - b.x) * fx)),
      top: Math.max(0, Math.round((ly - b.y) * fy)),
      width: Math.max(1, Math.round(lw * fx)),
      height: Math.max(1, Math.round(lh * fy))
    }
    crop.width = Math.max(1, Math.min(crop.width, nativeW - crop.left))
    crop.height = Math.max(1, Math.min(crop.height, nativeH - crop.top))

    let factor = Math.min(ZOOM_MAX_FACTOR, ZOOM_MAX_OUT / lw)
    if (factor < ZOOM_TARGET_FACTOR) factor = Math.min(ZOOM_TARGET_FACTOR, ZOOM_WIDE_OUT / lw)
    factor = Math.min(factor, ZOOM_MAX_OUT_H / lh)
    const outW = Math.round(lw * factor)
    const outH = Math.round(lh * factor)

    let pipeline = sharp(png).extract(crop).resize({ width: outW, height: outH, fit: 'fill' })

    const newFrame = {
      kind: 'zoom',
      scope: 'display',
      scale: lw / outW,
      offsetX: lx,
      offsetY: ly,
      width: outW,
      height: outH,
      displayId: display.id,
      ...inheritWindowScope(frame, { x: lx, y: ly, width: lw, height: lh })
    }

    const cur = aimPoint()
    let cursorLine = ''
    if (cur && cur.x >= lx && cur.x < lx + lw && cur.y >= ly && cur.y < ly + lh) {
      const cx = Math.round((cur.x - lx) / newFrame.scale)
      const cy = Math.round((cur.y - ly) / newFrame.scale)
      pipeline = pipeline.composite([{ input: crosshairSvg(outW, outH, cx, cy, true), left: 0, top: 0 }])
      cursorLine =
        ` Aim point at (${cx}, ${cy}), marked with the crosshair and hairlines — that is only where the cursor sits,` +
        ` not proof it is on your target: never click the cursor's position because it "looks close"; read your` +
        ` target's own pixel coordinates from this image.`
    }

    const buffer = await pipeline.png().toBuffer()
    setFrame(newFrame)
    overlay.pulseOverlay()
    const savedPath = await savePersistedImage(buffer, 'png', 'zoom')

    let weakLine = ''
    if (factor < ZOOM_TARGET_FACTOR - 0.05) {
      const suggestW = Math.max(40, Math.min(outW, Math.floor(ZOOM_MAX_OUT / (3 * newFrame.scale))))
      const suggestH = Math.max(24, Math.min(outH, Math.floor(ZOOM_MAX_OUT_H / (3 * newFrame.scale))))
      weakLine =
        ` WARNING: this zoom is only ${factor.toFixed(1)}x — barely sharper than the screenshot, NOT enough to aim at` +
        ` small controls. Zoom again into a narrower slice of THIS frame around your target — a region of at most ${suggestW}x${suggestH} gives you 3x.`
    }

    return {
      success: true,
      output:
        `Frame ${outW}x${outH} — ${factor.toFixed(1)}x zoom into the region you selected, captured fresh at native resolution.${cursorLine} ` +
        `Coordinates now refer to THIS zoomed image (x 0-${outW - 1}, y 0-${outH - 1}) — click your target using them for maximum precision. ` +
        `To act outside this region, take a fresh capture first.` +
        weakLine +
        (savedPath ? `\n${savedPath}` : ''),
      images: [{ mediaType: 'image/png', data: buffer.toString('base64') }]
    }
  } catch (err) {
    return { success: false, error: `Zoom failed: ${err?.message ?? String(err)}` }
  }
}

// ─── Window targeting ───────────────────────────────────────────────────

let windowsCache = { at: 0, list: [] }

/**
 * Windows only: the ids of the top-level windows Chromium's enumeration can
 * see — everything DWM-cloaked (Start, Search, suspended UWP apps) and every
 * tool window is absent. ~200ms; runs alongside the driver's own listing.
 * Null where the probe does not apply or failed, so nothing gets marked.
 */
async function capturableWindowIds() {
  if (process.platform !== 'win32' || !electronDesktopCapturer) return null
  try {
    const sources = await electronDesktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
    const ids = new Set()
    for (const s of sources) {
      const id = Number(String(s.id).split(':')[1])
      if (Number.isFinite(id)) ids.add(id)
    }
    return ids
  } catch {
    return null
  }
}

async function visibleWindows(force = false) {
  if (!driver.status().available) return []
  if (!force && Date.now() - windowsCache.at < 800) return windowsCache.list
  try {
    const [raw, capturable] = await Promise.all([driver.listWindows({ onScreenOnly: true }), capturableWindowIds()])
    const list = driver.markCloaked(raw, capturable).filter((w) => w.cloaked !== true)
    windowsCache = { at: Date.now(), list }
    return list
  } catch {
    return windowsCache.list
  }
}

function describeWindow(w) {
  if (!w) return 'no window'
  return `${w.app || 'unknown app'}${w.title ? ` (window "${String(w.title).slice(0, 60)}")` : ''}`
}

/**
 * The window a global DIP point belongs to: the current frame's window when
 * the point is inside it, else the topmost visible window under the point.
 */
async function resolvePointTarget(dip) {
  const frame = currentFrame()
  if (frame?.scope === 'window' && frame.windowBounds) {
    const b = frame.windowBounds
    if (dip.x >= b.x && dip.x < b.x + b.width && dip.y >= b.y && dip.y < b.y + b.height) {
      return { pid: frame.pid, id: frame.windowId, app: frame.app ?? '', title: frame.title ?? '', bounds: b }
    }
  }
  const list = await visibleWindows()
  return driver.windowAt(list, dip)
}

async function frontmostWindow() {
  const list = await visibleWindows(true)
  const candidates = list.filter((w) => w.pid !== process.pid && w.onScreen && w.minimized !== true && w.onCurrentSpace !== false && (w.layer ?? 0) === 0)
  if (candidates.length === 0) return null
  try {
    const apps = await driver.listApps()
    const active = apps.find((a) => a.active)
    if (active) {
      const own = candidates.filter((w) => w.pid === active.pid).sort((a, b) => (b.z ?? -1) - (a.z ?? -1))
      if (own[0]) return own[0]
    }
  } catch {
    // Fall through to z-order.
  }
  candidates.sort((a, b) => (b.z ?? -1) - (a.z ?? -1))
  return candidates[0]
}

/** The tree for a window, cached briefly. Best-effort and bounded in time. */
async function snapshotFor(win, { maxAgeMs = 1500, timeoutMs = 1500, maxElements = 800 } = {}) {
  if (!win || !driver.status().available) return null
  const cached = elements.cachedSnapshot(win.pid, win.id, maxAgeMs)
  if (cached) return cached
  const work = driver.windowState({ pid: win.pid, windowId: win.id, tree: true, screenshot: false, maxElements })
  const timeout = new Promise((r) => setTimeout(() => r(null), timeoutMs))
  const state = await Promise.race([work, timeout])
  if (!state || !state.ok) return null
  return elements.rememberSnapshot(win.pid, win.id, state)
}

/** "Under the point: button "Close"" — the cheap second opinion on a pixel click. */
async function underPointLine(win, dip) {
  const snap = await snapshotFor(win)
  if (!snap || snap.elements.length === 0) return ''
  const el = elements.elementAt(snap.elements, dip)
  if (!el) return ' Under the point: no element the app reports (bare canvas or unlabeled area).'
  return ` Under the point: ${elements.describeElement(el)}.`
}

// ─── The delivery ladder ────────────────────────────────────────────────

function pointerDrift(before, after) {
  if (!before || !after) return 0
  return Math.hypot(after.x - before.x, after.y - before.y)
}

const FOREGROUND_ACTION = { effect: 'unverifiable', route: 'global_input', delivery: 'foreground', evidence: [], escalation: null }

/**
 * After a foreground-rung action. The driver moves the real pointer to act
 * and promises to put it back, but on Windows it is still at the action
 * point when the call returns (verified live), so the plugin puts it back
 * itself. Only a pointer that ended somewhere ELSE means the person moved
 * it during the action; that is the interruption the model must hear about.
 */
async function settlePointer(before, actedAt = null) {
  const after = realPointer()
  if (!before || !after) return null
  const drift = pointerDrift(before, after)
  if (drift <= INTERRUPT_PX) return null
  const residue = actedAt ? Math.hypot(after.x - actedAt.x, after.y - actedAt.y) <= 12 : false
  if (!residue) return `the real pointer moved ${Math.round(drift)}px during the action`
  try {
    if (nutReady) {
      const native = dipToNative(before.x, before.y)
      await nutMouse.setPosition(new nutPoint(native.x, native.y))
    }
  } catch {
    // Cosmetic: the pointer stays at the action point.
  }
  return null
}

/**
 * Deliver a click at a global DIP point. Rungs: native background → native
 * foreground → legacy synthesis. Returns { ok, rung, action, refusal, win,
 * interruption, error }.
 */
/**
 * Windows: a posted (background) right or middle click poisons a Chromium
 * window — every later posted click is dropped until real input arrives
 * (verified live on Windows 11: Escape and bring_to_front do not clear it, a
 * foreground click does) — and in a native app it opens a context menu whose
 * modal loop swallows posted clicks anyway. Those buttons take the
 * foreground rung there; the evidence line names why.
 */
export function backgroundUnsupported(button) {
  if (process.platform === 'win32' && button !== 'left') {
    return { code: 'windows_secondary_button', message: `a ${button} click needs real input on Windows (a posted one leaves the window dropping later clicks)` }
  }
  return null
}

async function deliverClick({ dip, button = 'left', count = 1, modifiers = [], delivery = 'auto' }) {
  const out = { ok: false, rung: null, action: null, refusal: null, win: null, interruption: null, error: null }
  const unsupported = backgroundUnsupported(button)
  const wantsBg = delivery !== 'foreground' && !unsupported
  const allowsFg = delivery !== 'background'
  const win = driver.status().available ? await resolvePointTarget(dip) : null
  out.win = win
  if (unsupported) {
    out.refusal = unsupported
    if (!allowsFg) return { ...out, error: `Background delivery refused (${unsupported.code}): ${unsupported.message}` }
  }

  if (win && modifiers.length === 0 && wantsBg) {
    const scale = backingScaleFor(win.bounds)
    const px = windowLocalPx(win.bounds, dip, scale)
    const r = await driver.clickWindow({ pid: win.pid, windowId: win.id, px, button, count, foreground: false })
    if (r.ok) return { ...out, ok: true, rung: 'background', action: r.action }
    out.refusal = r.refusal
    if (!allowsFg) return { ...out, error: `Background delivery refused (${r.refusal?.code}): ${r.refusal?.message}` }
  }

  if (win && modifiers.length === 0 && allowsFg) {
    const scale = backingScaleFor(win.bounds)
    const px = windowLocalPx(win.bounds, dip, scale)
    const before = realPointer()
    const r = await driver.clickWindow({ pid: win.pid, windowId: win.id, px, button, count, foreground: true })
    const interruption = await settlePointer(before, dip)
    if (r.ok) {
      return { ...out, ok: true, rung: 'foreground', action: r.action, interruption }
    }
    out.refusal = out.refusal ?? r.refusal
  }

  if (!allowsFg) return { ...out, error: 'No background route to this point: nothing under it is a window the driver can address.' }
  if (!nutReady) return { ...out, error: out.refusal ? `Native delivery refused (${out.refusal.code}): ${out.refusal.message}` : 'No input path is available on this machine.' }

  // Legacy rung: move the real pointer and click. Modifier keys are held
  // around the press.
  const before = realPointer()
  const native = dipToNative(dip.x, dip.y)
  await nutMouse.setPosition(new nutPoint(native.x, native.y))
  await sleep(80)
  const { Key } = await import('@nut-tree-fork/nut-js')
  const held = []
  for (const m of modifiers) {
    const k = resolveKey(Key, m)
    if (k === null) return { ...out, error: `Unknown modifier: ${m}` }
    held.push(k)
  }
  const btn = resolveButton(button).button
  try {
    for (const k of held) await nutKeyboard.pressKey(k)
    const n = Math.max(1, Math.min(3, Number(count) || 1))
    if (n === 2) await nutMouse.doubleClick(btn)
    else for (let i = 0; i < n; i++) await nutMouse.click(btn)
  } finally {
    for (const k of held.reverse()) await nutKeyboard.releaseKey(k).catch(() => {})
  }
  await sleep(40)
  return {
    ...out,
    ok: true,
    rung: 'legacy',
    action: { effect: 'unverifiable', route: 'global_input', delivery: 'foreground', evidence: [], escalation: null },
    interruption: await settlePointer(before, dip)
  }
}

/** The topmost window at a point when it is not the window we target. */
async function coveringWindow(win, dip) {
  if (!win || !driver.status().available) return null
  const top = driver.windowAt(await visibleWindows(), dip)
  if (!top || top.id === win.id) return null
  return top
}

function rungPhrase(res) {
  if (res.rung === 'background') return `delivered in the background to ${describeWindow(res.win)} (your pointer did not move, the window was not raised)`
  if (res.rung === 'foreground') return `delivered in the FOREGROUND to ${describeWindow(res.win)} — no background route (${res.refusal?.code ?? 'unavailable'}), so the window was briefly activated and the pointer put back`
  return `delivered by moving the real pointer${res.win ? ` over ${describeWindow(res.win)}` : ''} and putting it back (legacy path${res.refusal ? `; the native driver refused: ${res.refusal.code}` : ''})`
}

function effectPhrase(action) {
  if (!action) return ''
  const bits = [`effect ${action.effect.replace('_', ' ')}`]
  if (action.evidence?.length) bits.push(`evidence: ${action.evidence.join(', ')}`)
  if (action.escalation) bits.push(`driver suggests ${action.escalation.target} (${action.escalation.reason.replace(/_/g, ' ')})`)
  return bits.join('; ')
}

/** One evidence sentence for the model, and the structured record for the runtime tail. */
function evidence({ tool, target, expect, res, changeLine = '', under = '', covered = null }) {
  const parts = [`Evidence: ${rungPhrase(res)}`]
  if (covered) {
    parts.push(
      res.rung === 'background'
        ? `note: ${describeWindow(covered)} is on top of that point right now; the input went to the target window underneath`
        : `WARNING: ${describeWindow(covered)} is on top of that point, so a real-pointer action lands on IT, not on ${describeWindow(res.win)} — bring the target to the front (computer_focus_window) or use a background route`
    )
  }
  const eff = effectPhrase(res.action)
  if (eff) parts.push(eff)
  if (res.interruption) parts.push(`INTERRUPTED: ${res.interruption} — do not assume it landed; verify before repeating anything side-effectful`)
  let line = ` ${parts.join('; ')}.`
  if (under) line += under
  if (changeLine) line += changeLine
  const summary =
    `${tool}${target ? ` "${target}"` : ''}: ${res.rung ?? 'not delivered'}` +
    (res.action ? `, ${res.action.effect.replace('_', ' ')}` : '') +
    (res.interruption ? ', INTERRUPTED' : '') +
    (changeLine.includes('NO visible change') ? ', no visible change' : changeLine.includes('change detected') ? ', screen changed' : '')
  session().lastAction = { tool, target: target ?? null, expect: expect ?? null, summary }
  return { line, meta: { computerUse: { lastAction: session().lastAction } } }
}

function resolveButton(name) {
  switch (String(name ?? 'left').toLowerCase()) {
    case 'right':
      return { button: nutButton?.RIGHT, label: 'right' }
    case 'middle':
      return { button: nutButton?.MIDDLE, label: 'middle' }
    default:
      return { button: nutButton?.LEFT, label: 'left' }
  }
}

function argText(args, key) {
  return typeof args?.[key] === 'string' && args[key].trim().length > 0 ? args[key].trim() : null
}

function argModifiers(args) {
  const raw = args?.modifiers
  if (Array.isArray(raw)) return raw.map((m) => String(m).trim().toLowerCase()).filter(Boolean)
  return String(raw ?? '')
    .split(',')
    .map((m) => m.trim().toLowerCase())
    .filter(Boolean)
}

function argDelivery(args) {
  const d = String(args?.delivery ?? 'auto').toLowerCase()
  return d === 'background' || d === 'foreground' ? d : 'auto'
}

async function typingTarget() {
  const s = session()
  if (s.lastTarget) return s.lastTarget
  if (!driver.status().available) return null
  return frontmostWindow()
}

// ─── Mouse tools ────────────────────────────────────────────────────────

async function mouseMove(args) {
  const denied = requirePermissions()
  if (denied) return denied
  const x = Number(args?.x)
  const y = Number(args?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { success: false, error: 'x and y coordinates are required (finite numbers)' }
  const boundsError = validateFrameCoords(x, y)
  if (boundsError) return refuse(boundsError)
  const target = argText(args, 'target')
  try {
    const dip = frameToDip(currentFrame(), x, y)
    // Aiming moves the SHADOW cursor only. The person's pointer is untouched.
    session().aim = dip
    await overlay.cursorTo(dip, { kind: 'pointer', label: target ?? '' })
    const win = driver.status().available ? await resolvePointTarget(dip) : null
    const under = win ? await underPointLine(win, dip) : ''
    const covered = await coveringWindow(win, dip)
    const coveredLine = covered ? ` Note: ${describeWindow(covered)} is currently on top of this point; background clicks still reach ${describeWindow(win)} underneath, but the magnifier shows what is on screen.` : ''
    const mag = await renderMagnifier(null, dip)
    const aimWhat = target ? `"${target}"` : 'your target'
    return {
      success: true,
      output:
        `Aimed the shadow cursor at (${x}, ${y}) in the previous frame → screen (${dip.x}, ${dip.y}).` +
        (target ? ` Target: "${target}".` : '') +
        under +
        coveredLine +
        ` Check the magnifier: the hairlines must pass through the CENTER of ${aimWhat} — "close" is not on it. ` +
        `If they do, click with computer_mouse_click (no coordinates). If they are off, aim again using coordinates read from the magnifier. ` +
        `Your real pointer was not moved; to trigger hover states use computer_hover. ${mag.note}`,
      images: [mag.image]
    }
  } catch (err) {
    return { success: false, error: `Aim failed: ${err?.message ?? String(err)}` }
  }
}

async function hover(args) {
  const denied = requirePermissions()
  if (denied) return denied
  if (!nutReady) return { success: false, error: 'Hover needs the real pointer, and the fallback input path is unavailable here (see computer_check_access).' }
  const x = Number(args?.x)
  const y = Number(args?.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { success: false, error: 'x and y coordinates are required (finite numbers)' }
  const boundsError = validateFrameCoords(x, y)
  if (boundsError) return { success: false, error: boundsError }
  try {
    const dip = frameToDip(currentFrame(), x, y)
    session().aim = dip
    await overlay.cursorTo(dip, { kind: 'pointer', label: argText(args, 'target') ?? '' })
    const native = dipToNative(dip.x, dip.y)
    await nutMouse.setPosition(new nutPoint(native.x, native.y))
    const ms = Math.max(0, Math.min(10000, Number(args?.ms) || 400))
    await sleep(ms)
    const mag = await renderMagnifier(null, dip)
    return {
      success: true,
      output:
        `Moved the REAL pointer to (${x}, ${y}) → screen (${dip.x}, ${dip.y}) and held it there ${ms}ms — this is the one tool that moves the user's pointer, for tooltips and hover menus. ` +
        `Take a computer_screenshot to see anything that appeared. ${mag.note}`,
      images: [mag.image]
    }
  } catch (err) {
    return { success: false, error: `Hover failed: ${err?.message ?? String(err)}` }
  }
}

async function mouseClick(args) {
  const denied = requirePermissions()
  if (denied) return denied
  const hasCoords = args?.x !== undefined && args?.y !== undefined
  const x = hasCoords ? Number(args.x) : null
  const y = hasCoords ? Number(args.y) : null
  const button = String(args?.button ?? 'left').toLowerCase()
  if (!['left', 'right', 'middle'].includes(button)) return { success: false, error: `Unknown button: ${button}` }
  const count = args?.double === true ? 2 : Math.max(1, Math.min(3, Number(args?.count) || 1))
  const modifiers = argModifiers(args)
  const delivery = argDelivery(args)
  const target = argText(args, 'target')
  const expect = argText(args, 'expect')
  if (hasCoords) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { success: false, error: 'x and y must be finite numbers (or omit both to click at the aim point).' }
    const boundsError = validateFrameCoords(x, y)
    if (boundsError) return refuse(boundsError)
  }
  try {
    const dip = hasCoords ? frameToDip(currentFrame(), x, y) : aimPoint()
    if (!dip) return { success: false, error: 'No aim point yet: aim with computer_mouse_move or pass x and y.' }
    session().aim = dip
    const where = hasCoords ? `at (${x}, ${y}) in the previous frame → screen (${dip.x}, ${dip.y})` : `at the aim point (screen ${dip.x}, ${dip.y})`

    // Animate first, act second, pulse third — the person sees cause before effect.
    await overlay.cursorTo(dip, { kind: 'pointer', label: target ?? '' })

    // Before-picture for the objective change verdict.
    let preShot = null
    try {
      const preDisplay = electronScreen.getDisplayNearestPoint(dip)
      preShot = { ...(await captureNative(preDisplay)), displayId: preDisplay.id }
    } catch {
      // Verification is best-effort.
    }

    const res = await deliverClick({ dip, button, count, modifiers, delivery })
    if (!res.ok) return { success: false, error: `Click not delivered: ${res.error}` }
    overlay.cursorPulse()
    if (res.win) session().lastTarget = res.win
    await sleep(preShot ? 300 : 120)

    const under = res.win && res.rung !== 'legacy' ? await underPointLine(res.win, dip) : ''
    const covered = await coveringWindow(res.win, dip)
    const mag = await renderMagnifier(preShot, dip)
    const ev = evidence({ tool: 'click', target, expect, res, changeLine: mag.changeLine, under, covered })
    const clickType = count === 2 ? 'Double-clicked' : count === 3 ? 'Triple-clicked' : 'Clicked'
    const modText = modifiers.length ? ` with ${modifiers.join('+')} held` : ''
    const verifyWhat = target ? `"${target}"` : 'the target you meant'
    return {
      success: true,
      output:
        `${clickType} ${button}${modText} ${where}.${target ? ` Target: "${target}".` : ''}${expect ? ` Expected: ${expect}.` : ''}${ev.line} ` +
        `Verify in the magnifier that the crosshair is on ${verifyWhat} — if it shows empty space or a different control, the target was NOT clicked: ` +
        `do not report success; re-locate it (computer_find, or fresh capture + zoom) and click again. ` +
        `If this click should change the screen (menu, dialog, page), take a computer_screenshot to see the result. ${mag.note}`,
      images: [mag.image],
      meta: ev.meta
    }
  } catch (err) {
    return { success: false, error: `Mouse click failed: ${err?.message ?? String(err)}` }
  }
}

async function mouseDownUp(args, down) {
  const denied = requirePermissions()
  if (denied) return denied
  if (!nutReady) return { success: false, error: 'Holding a mouse button uses the real pointer, and the fallback input path is unavailable here.' }
  const button = resolveButton(args?.button)
  try {
    if (args?.x !== undefined && args?.y !== undefined) {
      const x = Number(args.x)
      const y = Number(args.y)
      const boundsError = validateFrameCoords(x, y)
      if (boundsError) return { success: false, error: boundsError }
      const dip = frameToDip(currentFrame(), x, y)
      session().aim = dip
      await overlay.cursorTo(dip, { kind: 'pointer', label: argText(args, 'target') ?? '' })
      const native = dipToNative(dip.x, dip.y)
      await nutMouse.setPosition(new nutPoint(native.x, native.y))
      await sleep(60)
    }
    if (down) await nutMouse.pressButton(button.button)
    else await nutMouse.releaseButton(button.button)
    await sleep(80)
    return {
      success: true,
      output: `${down ? 'Pressed and holding' : 'Released'} the ${button.label} mouse button at the real pointer (${down ? 'move with computer_hover, then computer_mouse_up' : 'done'}). This path moves the user's pointer.`
    }
  } catch (err) {
    return { success: false, error: `Mouse ${down ? 'down' : 'up'} failed: ${err?.message ?? String(err)}` }
  }
}

async function mouseDrag(args) {
  const denied = requirePermissions()
  if (denied) return denied
  const sx = Number(args?.start_x)
  const sy = Number(args?.start_y)
  const ex = Number(args?.end_x)
  const ey = Number(args?.end_y)
  if (![sx, sy, ex, ey].every(Number.isFinite)) return { success: false, error: 'start_x, start_y, end_x, end_y are required (finite numbers).' }
  const startError = validateFrameCoords(sx, sy, 'Start coordinates')
  if (startError) return refuse(startError)
  const endError = validateFrameCoords(ex, ey, 'End coordinates')
  if (endError) return refuse(endError)
  const button = String(args?.button ?? 'left').toLowerCase()
  const modifiers = argModifiers(args)
  const delivery = argDelivery(args)
  const target = argText(args, 'target')
  try {
    const frame = currentFrame()
    const startDip = frameToDip(frame, sx, sy)
    const endDip = frameToDip(frame, ex, ey)
    session().aim = endDip
    await overlay.cursorTo(startDip, { kind: 'pointer', label: target ?? '' })

    let res = { ok: false, rung: null, action: null, refusal: null, win: null, interruption: null }
    const win = driver.status().available ? await resolvePointTarget(startDip) : null
    const endWin = win ? await resolvePointTarget(endDip) : null
    if (win && endWin && endWin.id === win.id && delivery !== 'foreground') {
      const scale = backingScaleFor(win.bounds)
      const r = await driver.dragWindow({
        pid: win.pid,
        windowId: win.id,
        from: windowLocalPx(win.bounds, startDip, scale),
        to: windowLocalPx(win.bounds, endDip, scale),
        button,
        modifiers,
        durationMs: Math.max(200, Math.min(3000, Number(args?.duration_ms) || 500))
      })
      if (r.ok) res = { ok: true, rung: 'background', action: r.action ?? { effect: 'unverifiable', route: 'synthetic_events', delivery: 'background', evidence: [], escalation: null }, refusal: null, win }
      else res.refusal = r.refusal
    }
    if (!res.ok) {
      if (delivery === 'background') return { success: false, error: `Background drag refused${res.refusal ? ` (${res.refusal.code}): ${res.refusal.message}` : ': endpoints are not inside one window the driver can address'}` }
      if (!nutReady) return { success: false, error: 'No drag path is available on this machine.' }
      const before = realPointer()
      const startNative = dipToNative(startDip.x, startDip.y)
      const endNative = dipToNative(endDip.x, endDip.y)
      const btn = resolveButton(button).button
      await nutMouse.setPosition(new nutPoint(startNative.x, startNative.y))
      await sleep(80)
      await nutMouse.pressButton(btn)
      await sleep(150)
      try {
        await nutMouse.move(nutStraightTo(new nutPoint(endNative.x, endNative.y)))
        await sleep(120)
      } finally {
        await nutMouse.releaseButton(btn).catch(() => {})
      }
      await sleep(120)
      res = {
        ok: true,
        rung: 'legacy',
        action: { effect: 'unverifiable', route: 'global_input', delivery: 'foreground', evidence: [], escalation: null },
        refusal: res.refusal,
        win,
        interruption: await settlePointer(before, endDip)
      }
    }
    overlay.cursorPulse()
    await overlay.cursorTo(endDip, { kind: 'pointer', label: target ?? '', animate: true })
    if (res.win) session().lastTarget = res.win
    const covered = await coveringWindow(res.win, startDip)
    const mag = await renderMagnifier(null, endDip)
    const ev = evidence({ tool: 'drag', target, expect: argText(args, 'expect'), res, covered })
    return {
      success: true,
      output:
        `Dragged with the ${button} button from (${sx}, ${sy}) to (${ex}, ${ey}) in the previous frame ` +
        `(screen ${startDip.x},${startDip.y} → ${endDip.x},${endDip.y}).${ev.line} The magnifier shows the release point — ` +
        `anything you dragged is now THERE. If it missed, correct with a second short drag inside one zoom. Take a computer_screenshot to verify. ${mag.note}`,
      images: [mag.image],
      meta: ev.meta
    }
  } catch (err) {
    try {
      await nutMouse?.releaseButton(resolveButton(args?.button).button)
    } catch {
      // Best-effort.
    }
    return { success: false, error: `Drag failed: ${err?.message ?? String(err)}` }
  }
}

async function mouseScroll(args) {
  const denied = requirePermissions()
  if (denied) return denied
  const direction = String(args?.direction ?? 'down').toLowerCase()
  if (!['up', 'down', 'left', 'right'].includes(direction)) return { success: false, error: `Invalid scroll direction: ${direction}` }
  const amount = Math.max(1, Math.min(100, Number(args?.amount) || 3))
  const by = String(args?.by ?? 'lines').toLowerCase() === 'pages' ? 'pages' : 'lines'
  const delivery = argDelivery(args)
  const hasCoords = args?.x !== undefined && args?.y !== undefined
  let dip = null
  if (hasCoords) {
    const x = Number(args.x)
    const y = Number(args.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { success: false, error: 'x and y must be finite numbers when provided.' }
    const boundsError = validateFrameCoords(x, y)
    if (boundsError) return refuse(boundsError)
    dip = frameToDip(currentFrame(), x, y)
    session().aim = dip
  } else {
    dip = aimPoint()
  }
  if (!dip) return { success: false, error: 'No aim point yet: pass x and y.' }
  try {
    await overlay.cursorTo(dip, { kind: 'pointer', label: argText(args, 'target') ?? '' })
    let res = { ok: false, rung: null, action: null, refusal: null, win: null, interruption: null }
    const win = driver.status().available ? await resolvePointTarget(dip) : null
    if (win && delivery !== 'foreground') {
      const scale = backingScaleFor(win.bounds)
      const r = await driver.scrollWindow({ pid: win.pid, windowId: win.id, px: windowLocalPx(win.bounds, dip, scale), direction, amount, by })
      if (r.ok) res = { ok: true, rung: 'background', action: r.action ?? { effect: 'unverifiable', route: 'synthetic_events', delivery: 'background', evidence: [], escalation: null }, refusal: null, win }
      else res.refusal = r.refusal
    }
    if (!res.ok) {
      if (delivery === 'background') return { success: false, error: `Background scroll refused${res.refusal ? ` (${res.refusal.code}): ${res.refusal.message}` : ''}` }
      if (!nutReady) return { success: false, error: 'No scroll path is available on this machine.' }
      // A real wheel goes to the window under the pointer, so the pointer
      // has to visit the point; it is put back afterwards.
      const before = realPointer()
      const native = dipToNative(dip.x, dip.y)
      await nutMouse.setPosition(new nutPoint(native.x, native.y))
      await sleep(60)
      const notches = by === 'pages' ? amount * 10 : amount
      if (direction === 'up') await nutMouse.scrollUp(notches)
      else if (direction === 'down') await nutMouse.scrollDown(notches)
      else if (direction === 'left') await nutMouse.scrollLeft(notches)
      else await nutMouse.scrollRight(notches)
      await sleep(40)
      res = { ok: true, rung: 'legacy', action: { effect: 'unverifiable', route: 'global_input', delivery: 'foreground', evidence: [], escalation: null }, refusal: res.refusal, win, interruption: await settlePointer(before, dip) }
    }
    if (res.win) session().lastTarget = res.win
    await sleep(150)
    const covered = await coveringWindow(res.win, dip)
    const mag = await renderMagnifier(null, dip)
    const ev = evidence({ tool: 'scroll', target: argText(args, 'target'), expect: argText(args, 'expect'), res, covered })
    return {
      success: true,
      output:
        `Scrolled ${direction} by ${amount} ${by === 'pages' ? 'page(s)' : 'wheel notch(es)'} to reveal content on the ${direction} side.${ev.line} ` +
        `The magnifier shows the area around the point after the scroll — if the item you were scrolling toward is visible, click it using the magnifier's coordinates; otherwise scroll again. ` +
        `For the wider picture take a computer_screenshot (pre-scroll coordinates are stale). ${mag.note}`,
      images: [mag.image],
      meta: ev.meta
    }
  } catch (err) {
    return { success: false, error: `Scroll failed: ${err?.message ?? String(err)}` }
  }
}

// ─── Keyboard tools ─────────────────────────────────────────────────────

const ASCII_PRINTABLE = /^[\x20-\x7E\r\n\t]*$/

async function nutType(text) {
  const { Key } = await import('@nut-tree-fork/nut-js')
  if (ASCII_PRINTABLE.test(text) && text.length <= 120) {
    await nutKeyboard.type(text)
    return 'keystrokes'
  }
  const previous = electronClipboard.readText()
  electronClipboard.writeText(text)
  await sleep(100)
  const pasteMod = process.platform === 'darwin' ? Key.LeftSuper : Key.LeftControl
  await nutKeyboard.pressKey(pasteMod)
  await nutKeyboard.pressKey(Key.V)
  await nutKeyboard.releaseKey(Key.V)
  await nutKeyboard.releaseKey(pasteMod)
  await sleep(250)
  electronClipboard.writeText(previous)
  return 'clipboard'
}

async function nutPress(keyName, modifierNames) {
  const { Key } = await import('@nut-tree-fork/nut-js')
  const mainKey = resolveKey(Key, keyName)
  if (mainKey === null) throw new Error(`Unknown key: ${keyName}`)
  const modKeys = []
  for (const mod of modifierNames) {
    const resolved = resolveKey(Key, mod)
    if (resolved === null) throw new Error(`Unknown modifier: ${mod}`)
    modKeys.push(resolved)
  }
  for (const mk of modKeys) await nutKeyboard.pressKey(mk)
  await nutKeyboard.pressKey(mainKey)
  await nutKeyboard.releaseKey(mainKey)
  for (const mk of modKeys.reverse()) await nutKeyboard.releaseKey(mk)
}

/** Keys go to the window the last action targeted (background), else to the focused app. */
async function deliverKeys({ key, modifiers, delivery }) {
  const win = delivery !== 'foreground' ? await typingTarget() : null
  if (win && driver.status().available) {
    const r =
      modifiers.length > 0
        ? await driver.hotkey({ pid: win.pid, windowId: win.id, keys: [...modifiers, key] })
        : await driver.pressKey({ pid: win.pid, windowId: win.id, key, modifiers: [] })
    if (r.ok) return { ok: true, rung: 'background', action: r.action ?? { effect: 'unverifiable', route: 'synthetic_events', delivery: 'background', evidence: [], escalation: null }, refusal: null, win, interruption: null }
    if (delivery === 'background') return { ok: false, error: `Background key delivery refused (${r.refusal?.code}): ${r.refusal?.message}`, refusal: r.refusal, win }
    // Foreground rung: the driver activates the target, sends real input,
    // restores the previous foreground — the keys reach THIS window, not
    // whatever happens to be focused.
    const before = realPointer()
    const f = modifiers.length > 0 ? await driver.hotkeyForeground({ pid: win.pid, windowId: win.id, keys: [...modifiers, key] }) : await driver.pressKeyForeground({ pid: win.pid, windowId: win.id, key, modifiers: [] })
    if (f.ok) return { ok: true, rung: 'foreground', action: f.action ?? FOREGROUND_ACTION, refusal: r.refusal, win, interruption: await settlePointer(before) }
    if (!nutReady) return { ok: false, error: `Native delivery refused (${r.refusal?.code}): ${r.refusal?.message}`, refusal: r.refusal, win }
    await nutPress(key, modifiers)
    return { ok: true, rung: 'legacy', action: { effect: 'unverifiable', route: 'global_input', delivery: 'foreground', evidence: [], escalation: null }, refusal: r.refusal, win, interruption: null }
  }
  if (delivery === 'background') return { ok: false, error: 'No window to deliver keys to in the background: click or focus a window first.', refusal: null, win: null }
  if (!nutReady) return { ok: false, error: 'No keyboard path is available on this machine.', refusal: null, win: null }
  await nutPress(key, modifiers)
  return { ok: true, rung: 'legacy', action: { effect: 'unverifiable', route: 'global_input', delivery: 'foreground', evidence: [], escalation: null }, refusal: null, win: null, interruption: null }
}

async function deliverText({ text, via, delivery }) {
  const win = delivery !== 'foreground' ? await typingTarget() : null
  // The native driver types Unicode directly (per-character unicode key
  // events), so Arabic and emoji ride the background rung as keystrokes;
  // the clipboard is the LEGACY rung's answer to non-ASCII, and the model's
  // explicit choice. A background paste (cmd+v posted to an inactive app)
  // is unreliable in Chromium, so it is never the automatic pick.
  const preferClipboard = via === 'clipboard'
  if (win && driver.status().available) {
    let r
    if (preferClipboard) {
      const previous = electronClipboard.readText()
      electronClipboard.writeText(text)
      await sleep(80)
      r = await driver.hotkey({ pid: win.pid, windowId: win.id, keys: [process.platform === 'darwin' ? 'cmd' : 'ctrl', 'v'] })
      await sleep(200)
      electronClipboard.writeText(previous)
      if (r.ok) return { ok: true, rung: 'background', path: 'clipboard', action: r.action ?? null, refusal: null, win }
    } else {
      r = await driver.typeText({ pid: win.pid, windowId: win.id, text })
      if (r.ok) return { ok: true, rung: 'background', path: 'keystrokes', action: r.action ?? null, refusal: null, win, note: r.text }
    }
    if (delivery === 'background') return { ok: false, error: `Background typing refused (${r.refusal?.code}): ${r.refusal?.message}`, win }
    // Foreground rung (see deliverKeys). The clipboard variant pastes with
    // a foreground chord; the keystroke variant types real Unicode input.
    {
      const before = realPointer()
      let f
      if (preferClipboard) {
        const previous = electronClipboard.readText()
        electronClipboard.writeText(text)
        await sleep(80)
        f = await driver.hotkeyForeground({ pid: win.pid, windowId: win.id, keys: [process.platform === 'darwin' ? 'cmd' : 'ctrl', 'v'] })
        await sleep(200)
        electronClipboard.writeText(previous)
      } else {
        f = await driver.typeTextForeground({ pid: win.pid, windowId: win.id, text })
      }
      if (f.ok) return { ok: true, rung: 'foreground', path: preferClipboard ? 'clipboard' : 'keystrokes', action: f.action ?? FOREGROUND_ACTION, refusal: r.refusal, win, note: f.text, interruption: await settlePointer(before) }
    }
    if (!nutReady) return { ok: false, error: `Native typing refused (${r.refusal?.code}): ${r.refusal?.message}`, win }
    const p = await nutType(text)
    return { ok: true, rung: 'legacy', path: p, action: { effect: 'unverifiable', route: 'global_input', delivery: 'foreground', evidence: [], escalation: null }, refusal: r.refusal, win }
  }
  if (delivery === 'background') return { ok: false, error: 'No window to type into in the background: click the field first (that also picks the window).', win: null }
  if (!nutReady) return { ok: false, error: 'No keyboard path is available on this machine.', win: null }
  const p = await nutType(text)
  return { ok: true, rung: 'legacy', path: p, action: { effect: 'unverifiable', route: 'global_input', delivery: 'foreground', evidence: [], escalation: null }, refusal: null, win: null }
}

async function secureFieldGuard(win) {
  if (!win) return null
  const snap = await snapshotFor(win, { timeoutMs: 800 })
  if (!snap) return null
  const aim = session().aim
  const el = aim ? elements.elementAt(snap.elements, aim) : null
  if (el && elements.isSecureField(el)) {
    return `The field under the aim point is a ${elements.describeElement(el)}: a password field. Wolffish does not type into password fields unless the user gave that secret in this conversation — ask them to type it, or confirm they did.`
  }
  return null
}

async function keyboardType(args) {
  const denied = requirePermissions()
  if (denied) return denied
  const text = String(args?.text ?? '')
  if (text.length === 0) return { success: false, error: 'text is required and must be non-empty' }
  const via = ['keystrokes', 'clipboard', 'auto'].includes(String(args?.via ?? 'auto')) ? String(args?.via ?? 'auto') : 'auto'
  const delivery = argDelivery(args)
  const replace = args?.replace === true
  const enter = args?.enter === true
  try {
    const win = await typingTarget()
    if (args?.allow_secret !== true) {
      const guard = await secureFieldGuard(win)
      if (guard) return { success: false, error: guard }
    }
    overlay.followOverlayAtPoint(aimPoint())
    const aim = aimPoint()
    if (aim) await overlay.cursorTo(aim, { kind: 'keyboard', label: argText(args, 'target') ?? '', animate: false })
    if (replace) {
      // Select the existing text with editing keys the FIELD itself handles
      // (start of document, then select to the end): native text views and
      // Chromium's renderer both implement these, whereas a posted select-all
      // chord is a menu accelerator that an inactive Chromium ignores. The
      // chord is sent afterwards as a bonus for apps that honor it.
      const mac = process.platform === 'darwin'
      const toStart = mac ? { key: 'up', modifiers: ['cmd'] } : { key: 'home', modifiers: ['ctrl'] }
      const toEnd = mac ? { key: 'down', modifiers: ['cmd', 'shift'] } : { key: 'end', modifiers: ['ctrl', 'shift'] }
      const a = await deliverKeys({ ...toStart, delivery })
      if (!a.ok) return { success: false, error: `Could not select the existing text: ${a.error}` }
      await sleep(40)
      const b = await deliverKeys({ ...toEnd, delivery })
      if (!b.ok) return { success: false, error: `Could not select the existing text: ${b.error}` }
      await sleep(40)
      await deliverKeys({ key: 'a', modifiers: [mac ? 'cmd' : 'ctrl'], delivery })
      await sleep(80)
    }
    const res = await deliverText({ text, via, delivery })
    if (!res.ok) return { success: false, error: `Typing not delivered: ${res.error}` }
    overlay.cursorPulse()
    let enterRes = null
    if (enter) {
      await sleep(60)
      enterRes = await deliverKeys({ key: 'enter', modifiers: [], delivery })
    }
    if (res.win) session().lastTarget = res.win
    const ev = evidence({
      tool: 'type',
      target: argText(args, 'target'),
      expect: argText(args, 'expect'),
      res: { ...res, rung: res.rung, interruption: res.interruption ?? null }
    })
    return {
      success: true,
      output:
        `Typed ${text.length} characters${res.path === 'clipboard' ? ' (pasted via the clipboard for exact fidelity)' : ''}${replace ? ' after selecting the existing text' : ''}${enter ? enterRes?.ok ? ', then pressed Enter' : ', but Enter was NOT delivered' : ''}.${ev.line}` +
        (res.note && /unverified|web-content/i.test(res.note) ? ' The app is web content, so the driver cannot read the field back — verify with a screenshot that the text landed in the intended field.' : ' Verify with a screenshot that the text landed in the intended field.'),
      meta: ev.meta
    }
  } catch (err) {
    return { success: false, error: `Keyboard type failed: ${err?.message ?? String(err)}` }
  }
}

async function keyboardPress(args) {
  const denied = requirePermissions()
  if (denied) return denied
  const rawKey = String(args?.key ?? '').trim()
  if (rawKey.length === 0) return { success: false, error: 'key is required' }
  const { key, modifiers } = parseKeyCombo(rawKey, args?.modifiers)
  const delivery = argDelivery(args)
  try {
    overlay.followOverlayAtPoint(aimPoint())
    const aim = aimPoint()
    if (aim) await overlay.cursorTo(aim, { kind: 'keyboard', label: argText(args, 'target') ?? '', animate: false })
    const res = await deliverKeys({ key, modifiers, delivery })
    if (!res.ok) return /Unknown key|Unknown modifier/.test(res.error ?? '') ? refuse(`Key not delivered: ${res.error}`) : { success: false, error: `Key not delivered: ${res.error}` }
    overlay.cursorPulse()
    if (res.win) session().lastTarget = res.win
    const desc = modifiers.length > 0 ? `${modifiers.join('+')}+${key}` : key
    const ev = evidence({ tool: 'press', target: desc, expect: argText(args, 'expect'), res })
    return { success: true, output: `Pressed ${desc}.${ev.line}`, meta: ev.meta }
  } catch (err) {
    const msg = err?.message ?? String(err)
    return /Unknown key|Unknown modifier/.test(msg) ? refuse(`Key press failed: ${msg}`) : { success: false, error: `Key press failed: ${msg}` }
  }
}

async function keyDownUp(args, down) {
  const denied = requirePermissions()
  if (denied) return denied
  if (!nutReady) return { success: false, error: 'Holding a key uses the fallback input path, which is unavailable here.' }
  const name = String(args?.key ?? '').trim()
  if (!name) return { success: false, error: 'key is required' }
  try {
    const { Key } = await import('@nut-tree-fork/nut-js')
    const k = resolveKey(Key, name)
    if (k === null) return { success: false, error: `Unknown key: ${name}` }
    if (down) await nutKeyboard.pressKey(k)
    else await nutKeyboard.releaseKey(k)
    return { success: true, output: `${down ? 'Holding' : 'Released'} ${name} (goes to the focused app; release every key you hold).` }
  } catch (err) {
    return { success: false, error: `Key ${down ? 'down' : 'up'} failed: ${err?.message ?? String(err)}` }
  }
}

// ─── Indicator ──────────────────────────────────────────────────────────

// Session keepalive: while the indicator is on the driver's implicit session
// must not expire under a long model silence (see driver.SESSION_KEEPALIVE_MS).
let keepaliveTimer = null
function startKeepalive() {
  stopKeepalive()
  keepaliveTimer = setInterval(() => {
    driver.ping().catch(() => undefined)
  }, driver.SESSION_KEEPALIVE_MS)
  if (typeof keepaliveTimer.unref === 'function') keepaliveTimer.unref()
}
function stopKeepalive() {
  if (keepaliveTimer) clearInterval(keepaliveTimer)
  keepaliveTimer = null
}

async function glowOn(args) {
  try {
    if (!electronScreen || !electronBrowserWindow) {
      overlay.setOverlayUnavailable(true)
      return { success: false, error: 'Screen indicator unavailable (Electron APIs not loaded). Continue the task and tell the user the indicator could not be shown.' }
    }
    const displayIndex = Number(args?.display_index) || 0
    const { display } = getDisplayByIndex(displayIndex)
    if (!overlay.showOverlay(display)) {
      overlay.setOverlayUnavailable(true)
      return { success: false, error: 'Screen indicator could not be shown — continue the task and tell the user the indicator is unavailable.' }
    }
    overlay.setOverlayUnavailable(false)
    startKeepalive()
    // Proactive: say now what would otherwise fail later.
    const access = await accessSnapshot()
    const accessNote = access.ok ? '' : `\nACCESS CHECK: ${access.text}`
    return {
      success: true,
      output:
        `Screen indicator ON — display ${displayIndex} now shows the blue glow, the capture notice and the shadow cursor (it glides to wherever you act; the user's own pointer stays theirs). ` +
        `It follows your actions across displays and stays on until you call computer_glow_off, which MUST be your last action when you finish — or give up on — controlling the screen.` +
        accessNote
    }
  } catch (err) {
    return { success: false, error: `Screen indicator failed: ${err?.message ?? String(err)}` }
  }
}

async function glowOff() {
  const wasOn = overlay.overlayAlive() || overlay.overlayWanted()
  stopKeepalive()
  overlay.cursorHide()
  overlay.hideOverlay()
  overlay.setOverlayUnavailable(false)
  return { success: true, output: wasOn ? 'Screen indicator OFF — the user can see the session is over.' : 'Screen indicator was already off.' }
}

async function waitMs(args) {
  const requested = Number(args?.ms)
  const ms = Number.isFinite(requested) && requested > 0 ? requested : 0
  await sleep(ms)
  return { success: true, output: `Waited ${ms}ms` }
}

async function listDisplays() {
  try {
    const displays = electronScreen.getAllDisplays()
    const primary = electronScreen.getPrimaryDisplay()
    const lines = displays.map((d, i) => {
      const isPrimary = d.id === primary.id ? ' (primary)' : ''
      return `Display ${i}: ${d.size.width}x${d.size.height} logical @ ${d.scaleFactor}x, position (${d.bounds.x},${d.bounds.y})${isPrimary}`
    })
    lines.push('Capture any of them with computer_screenshot display_index. Coordinates are always read from the returned image — never add display offsets yourself.')
    return { success: true, output: lines.join('\n') }
  } catch (err) {
    return { success: false, error: `Failed to list displays: ${err?.message ?? String(err)}` }
  }
}

// ─── Window and element tools ───────────────────────────────────────────

function displayIndexOf(bounds) {
  try {
    const displays = electronScreen.getAllDisplays()
    const d = electronScreen.getDisplayMatching(bounds)
    const i = displays.findIndex((x) => x.id === d.id)
    return i >= 0 ? i : 0
  } catch {
    return 0
  }
}

async function listWindowsTool(args) {
  if (!driver.status().available) {
    return { success: false, error: `Window listing needs the native driver, which is not loaded (${driver.status().error ?? 'unknown reason'}). Use computer_screenshot and the system capability's app_list instead.` }
  }
  try {
    const filter = argText(args, 'app')?.toLowerCase() ?? null
    const all = await visibleWindows(true)
    const apps = await driver.listApps().catch(() => [])
    const active = apps.find((a) => a.active)?.pid ?? null
    let list = all.filter((w) => w.pid !== process.pid)
    if (filter) list = list.filter((w) => (w.app || '').toLowerCase().includes(filter) || (w.title || '').toLowerCase().includes(filter))
    list.sort((a, b) => (b.z ?? -1) - (a.z ?? -1))
    if (list.length === 0) return { success: true, output: filter ? `No visible window matches "${filter}".` : 'No visible windows.' }
    const lines = list.map(
      (w) =>
        `${w.app || 'unknown'}${w.title ? ` — "${String(w.title).slice(0, 80)}"` : ''} · window_id ${w.id} · pid ${w.pid ?? '?'} · ` +
        `${Math.round(w.bounds.width)}x${Math.round(w.bounds.height)} at (${Math.round(w.bounds.x)},${Math.round(w.bounds.y)}) on display ${displayIndexOf(w.bounds)}` +
        `${w.pid === active ? ' · frontmost app' : ''}${w.minimized ? ' · minimized' : ''}${w.onCurrentSpace === false ? ' · other space' : ''}`
    )
    return {
      success: true,
      output:
        `Visible windows (front to back):\n${lines.join('\n')}\n` +
        'Use window_id + pid with computer_window_screenshot (captures that window even when covered), computer_find (elements by name) and computer_focus_window.'
    }
  } catch (err) {
    return { success: false, error: `Failed to list windows: ${err?.message ?? String(err)}` }
  }
}

function windowArgs(args) {
  const pid = Number(args?.pid)
  const id = Number(args?.window_id)
  if (!Number.isFinite(pid) || !Number.isFinite(id)) return null
  return { pid, id }
}

async function findWindow(args) {
  const w = windowArgs(args)
  if (w) {
    const list = await visibleWindows(true)
    const hit = list.find((x) => x.id === w.id)
    return hit ?? { pid: w.pid, id: w.id, app: '', title: '', bounds: null }
  }
  const frame = currentFrame()
  if (frame?.scope === 'window') return { pid: frame.pid, id: frame.windowId, app: frame.app, title: frame.title, bounds: frame.windowBounds }
  const s = session()
  if (s.lastTarget) return s.lastTarget
  return frontmostWindow()
}

async function windowScreenshot(args) {
  const denied = requirePermissions()
  if (denied) return denied
  if (!driver.status().available) return { success: false, error: 'Window capture needs the native driver, which is not loaded. Use computer_screenshot.' }
  try {
    const win = await findWindow(args)
    if (!win) return { success: false, error: 'No window to capture: pass pid and window_id from computer_list_windows.' }
    const cfg = await readConfig()
    const state = await driver.windowState({ pid: win.pid, windowId: win.id, tree: false, screenshot: true })
    if (!state.ok) return { success: false, error: `Window capture refused (${state.refusal?.code}): ${state.refusal?.message}` }
    if (!state.screenshot) return { success: false, error: 'The driver returned no image for that window (minimized windows cannot be captured — restore it first).' }
    const png = Buffer.from(state.screenshot.base64, 'base64')
    const bounds = state.windowBounds ?? win.bounds
    if (!bounds) return { success: false, error: 'The driver reported no bounds for that window.' }
    const nativeW = state.screenshot.width
    const { cfgWidth, cfgFormat, format, outW, overrode, notes } = resolveCapture({ args, cfg, logicalW: bounds.width, nativeW })
    const frame = {
      kind: 'window screenshot',
      scope: 'window',
      scale: bounds.width / outW,
      offsetX: bounds.x,
      offsetY: bounds.y,
      width: outW,
      height: 0,
      displayId: electronScreen.getDisplayMatching(bounds).id,
      pid: win.pid,
      windowId: win.id,
      app: state.app || win.app,
      title: state.title || win.title,
      windowBounds: { ...bounds }
    }
    const cur = aimPoint()
    let drawAt = null
    if (cur && cur.x >= bounds.x && cur.x < bounds.x + bounds.width && cur.y >= bounds.y && cur.y < bounds.y + bounds.height) {
      drawAt = dipToFrame(frame, cur)
    }
    const { buffer, mediaType, ext, outH, downgradeNote } = await encodeCapture({ png, nativeW, outW, format, drawCrosshairAt: drawAt })
    frame.height = outH
    setFrame(frame)
    session().lastTarget = { pid: win.pid, id: win.id, app: frame.app, title: frame.title, bounds: { ...bounds } }
    overlay.followOverlay(electronScreen.getDisplayMatching(bounds))
    overlay.pulseOverlay()
    const savedPath = await savePersistedImage(buffer, ext, 'win')
    return {
      success: true,
      output:
        `Frame ${outW}x${outH} — window screenshot of ${describeWindow(frame)} (${Math.round(bounds.width)}x${Math.round(bounds.height)} logical, captured even if other windows cover it; the title bar is included at the top).` +
        (drawAt ? ` Aim point at (${drawAt.x}, ${drawAt.y}), marked with the crosshair.` : '') +
        ` Coordinates refer to THIS image (x 0-${outW - 1}, y 0-${outH - 1}); clicks inside it are delivered to this window in the background. ` +
        `Use computer_find to locate controls by name in it.` +
        settingsLine({ overrode, outW, ext, notes, downgradeNote, cfgWidth, cfgFormat }) +
        (state.degraded ? ` Note: ${state.degradedReason ?? 'the capture is degraded'}.` : '') +
        (savedPath ? `\n${savedPath}` : ''),
      images: [{ mediaType, data: buffer.toString('base64') }]
    }
  } catch (err) {
    return { success: false, error: `Window screenshot failed: ${err?.message ?? String(err)}` }
  }
}

function frameRectMapper() {
  const frame = currentFrame()
  if (!frame) return null
  return (rect) => {
    const tl = dipToFrame(frame, { x: rect.x, y: rect.y })
    const br = dipToFrame(frame, { x: rect.x + rect.width, y: rect.y + rect.height })
    const cx = Math.round((tl.x + br.x) / 2)
    const cy = Math.round((tl.y + br.y) / 2)
    if (cx < 0 || cy < 0 || cx >= frame.width || cy >= frame.height) return null
    return { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y, cx, cy }
  }
}

async function findTool(args) {
  const denied = requirePermissions()
  if (denied) return denied
  if (!driver.status().available) return { success: false, error: 'Element search needs the native driver, which is not loaded. Use computer_zoom to locate targets visually.' }
  try {
    const win = await findWindow(args)
    if (!win) return { success: false, error: 'No window to search: take a computer_window_screenshot or pass pid and window_id.' }
    const text = argText(args, 'text') ?? ''
    const role = argText(args, 'role') ?? ''
    if (!text && !role) return { success: false, error: 'Pass text (a label, value or part of one) and/or role (button, text field, checkbox, menu item, …).' }
    const state = await driver.windowState({ pid: win.pid, windowId: win.id, tree: true, screenshot: false, maxElements: 1500 })
    if (!state.ok) return { success: false, error: `Element tree unavailable (${state.refusal?.code}): ${state.refusal?.message}` }
    elements.rememberSnapshot(win.pid, win.id, state)
    const matches = elements.findElements(state.elements, { text, role, maxResults: Number(args?.max_results) || 25 })
    const header = `${describeWindow({ app: state.app || win.app, title: state.title || win.title })}: ${matches.length} match${matches.length === 1 ? '' : 'es'} for ${[text && `text "${text}"`, role && `role "${role}"`].filter(Boolean).join(' and ')} among ${state.elements.length} elements.`
    const webNote =
      state.elements.some((e) => e.inWebContent) || /chrome|safari|firefox|edge|arc|brave|electron|code/i.test(state.app || win.app || '')
        ? ' This app renders web content: its page elements are often NOT in the tree (only the window chrome is). If your target is missing, fall back to pixels (screenshot → zoom → click) or use the browser tools.'
        : ''
    const degraded = state.degraded ? ` The tree is degraded: ${state.degradedReason ?? 'partial'}.` : state.truncated ? ` The tree was truncated (${state.truncationReason ?? 'too large'}); narrow the search.` : ''
    if (matches.length === 0) return { success: true, output: `${header}${webNote}${degraded} Try a shorter text, a different role, or locate it visually.` }
    const listing = elements.renderElementList(matches, frameRectMapper())
    return {
      success: true,
      output:
        `${header}${webNote}${degraded}\n${listing}\n` +
        `Coordinates above are in the CURRENT frame (${currentFrame()?.width ?? '?'}x${currentFrame()?.height ?? '?'} ${currentFrame()?.kind ?? 'image'}); "outside the current frame" means take a capture that contains it first. ` +
        `Click a match with computer_click_element (token) — the most reliable route — or aim at its center with computer_mouse_move. Tokens expire when the window changes; call computer_find again after.`
    }
  } catch (err) {
    return { success: false, error: `Element search failed: ${err?.message ?? String(err)}` }
  }
}

function parseToken(args) {
  const token = argText(args, 'token')
  if (!token) return null
  const m = /^s([0-9a-f]{8}):(\d+)$/i.exec(token)
  return m ? { token, snapshotId: `s${m[1]}`, index: Number(m[2]) } : { token, snapshotId: null, index: null }
}

async function windowForToken(args) {
  const w = windowArgs(args)
  if (w) return { pid: w.pid, id: w.id }
  const frame = currentFrame()
  if (frame?.scope === 'window') return { pid: frame.pid, id: frame.windowId }
  return session().lastTarget ?? null
}

async function clickElementTool(args) {
  const denied = requirePermissions()
  if (denied) return denied
  if (!driver.status().available) return { success: false, error: 'Element clicks need the native driver, which is not loaded.' }
  const t = parseToken(args)
  if (!t) return { success: false, error: 'token is required (from computer_find).' }
  const button = String(args?.button ?? 'left').toLowerCase()
  const count = args?.double === true ? 2 : Math.max(1, Math.min(3, Number(args?.count) || 1))
  const delivery = argDelivery(args)
  const target = argText(args, 'target')
  const expect = argText(args, 'expect')
  try {
    const win = await windowForToken(args)
    if (!win) return { success: false, error: 'Which window? Pass pid and window_id (the ones computer_find used).' }
    const el = elements.elementByToken(win.pid, win.id, t.token)
    const center = el?.frame ? { x: Math.round(el.frame.x + el.frame.width / 2), y: Math.round(el.frame.y + el.frame.height / 2) } : null
    if (center) {
      session().aim = center
      await overlay.cursorTo(center, { kind: 'pointer', label: target ?? (el ? elements.describeElement(el) : '') })
    }
    let preShot = null
    if (center) {
      try {
        const d = electronScreen.getDisplayNearestPoint(center)
        preShot = { ...(await captureNative(d)), displayId: d.id }
      } catch {
        // Best-effort.
      }
    }
    let res
    const unsupported = backgroundUnsupported(button)
    if (unsupported && delivery === 'background') return { success: false, error: `Background delivery refused (${unsupported.code}): ${unsupported.message}` }
    const foreground = delivery === 'foreground' || !!unsupported
    const r = await driver.clickElement({ pid: win.pid, windowId: win.id, token: t.token, button, count, foreground })
    if (r.ok) res = { ok: true, rung: foreground ? 'foreground' : 'background', action: r.action, refusal: unsupported, win: { ...win, app: el ? '' : '', title: '' }, interruption: null }
    else if (r.refusal?.code === 'stale_snapshot' || /stale|snapshot/i.test(r.refusal?.message ?? '')) {
      return { success: false, error: `That token is stale — the window changed since computer_find. Call computer_find again and use the new token. (${r.refusal?.message})` }
    } else if (center && delivery !== 'background') {
      res = await deliverClick({ dip: center, button, count, modifiers: [], delivery: 'auto' })
      if (!res.ok) return { success: false, error: `Element click refused (${r.refusal?.code}: ${r.refusal?.message}) and the pixel fallback failed: ${res.error}` }
      res.refusal = res.refusal ?? r.refusal
    } else {
      return { success: false, error: `Element click refused (${r.refusal?.code}): ${r.refusal?.message}` }
    }
    overlay.cursorPulse()
    const list = await visibleWindows(true)
    const full = list.find((w) => w.id === win.id)
    if (full) {
      res.win = full
      session().lastTarget = full
    }
    await sleep(preShot ? 300 : 120)
    const mag = center ? await renderMagnifier(preShot, center) : null
    const ev = evidence({ tool: 'click element', target: target ?? (el ? elements.describeElement(el) : t.token), expect, res, changeLine: mag?.changeLine ?? '' })
    return {
      success: true,
      output:
        `Clicked ${el ? elements.describeElement(el) : `element ${t.token}`}${count === 2 ? ' (double)' : ''} through the accessibility route.${expect ? ` Expected: ${expect}.` : ''}${ev.line}` +
        (mag ? ` ${mag.note}` : ' The element has no on-screen frame, so there is no magnifier; take a screenshot to see the result.'),
      images: mag ? [mag.image] : undefined,
      meta: ev.meta
    }
  } catch (err) {
    return { success: false, error: `Element click failed: ${err?.message ?? String(err)}` }
  }
}

async function readElementTool(args) {
  const denied = requirePermissions()
  if (denied) return denied
  if (!driver.status().available) return { success: false, error: 'Reading elements needs the native driver, which is not loaded.' }
  try {
    const win = await findWindow(args)
    if (!win) return { success: false, error: 'No window: pass pid and window_id.' }
    const state = await driver.windowState({ pid: win.pid, windowId: win.id, tree: true, screenshot: false, maxElements: 1500 })
    if (!state.ok) return { success: false, error: `Element tree unavailable (${state.refusal?.code}): ${state.refusal?.message}` }
    elements.rememberSnapshot(win.pid, win.id, state)
    const t = parseToken(args)
    let el = null
    if (t) el = state.elements.find((e) => e.token === t.token) ?? (t.index != null ? state.elements.find((e) => e.index === t.index) : null)
    else {
      const text = argText(args, 'text') ?? ''
      const role = argText(args, 'role') ?? ''
      el = elements.findElements(state.elements, { text, role, maxResults: 1 })[0] ?? null
    }
    if (!el) return { success: true, output: 'No matching element. Use computer_find to see what the window exposes.' }
    return {
      success: true,
      output:
        `${elements.describeElement(el)}\nvalue: ${el.value ?? '(none)'}\nlabel: ${el.label ?? '(none)'}\nenabled: ${el.enabled ?? 'unknown'}, selected: ${el.selected ?? 'unknown'}` +
        (el.actions?.length ? `\nactions: ${el.actions.join(', ')}` : '') +
        (el.token ? `\ntoken: ${el.token}` : '')
    }
  } catch (err) {
    return { success: false, error: `Read element failed: ${err?.message ?? String(err)}` }
  }
}

async function windowStateTool(args) {
  const denied = requirePermissions()
  if (denied) return denied
  if (!driver.status().available) return { success: false, error: 'The element tree needs the native driver, which is not loaded.' }
  try {
    const win = await findWindow(args)
    if (!win) return { success: false, error: 'No window: pass pid and window_id.' }
    const state = await driver.windowState({ pid: win.pid, windowId: win.id, tree: true, screenshot: false, maxElements: Number(args?.max_elements) || 400, maxDepth: Number(args?.max_depth) || 14 })
    if (!state.ok) return { success: false, error: `Element tree unavailable (${state.refusal?.code}): ${state.refusal?.message}` }
    elements.rememberSnapshot(win.pid, win.id, state)
    const listing = elements.renderElementList(state.elements.filter((e) => e.frame || e.label || e.value), frameRectMapper())
    return {
      success: true,
      output:
        `${describeWindow({ app: state.app || win.app, title: state.title || win.title })}: ${state.elements.length} elements${state.truncated ? ' (truncated)' : ''}${state.degraded ? ` (degraded: ${state.degradedReason})` : ''}.\n` +
        (state.treeMarkdown ? `${state.treeMarkdown.slice(0, 12000)}\n` : '') +
        (listing ? `Elements with frames/labels (current-frame coordinates):\n${listing.slice(0, 12000)}` : '')
    }
  } catch (err) {
    return { success: false, error: `Window state failed: ${err?.message ?? String(err)}` }
  }
}

async function setValueTool(args) {
  const denied = requirePermissions()
  if (denied) return denied
  if (!driver.status().available) return { success: false, error: 'Setting a value directly needs the native driver, which is not loaded. Click the field and use computer_keyboard_type with replace: true.' }
  const value = args?.value
  if (value === undefined || value === null) return { success: false, error: 'value is required.' }
  try {
    const win = await windowForToken(args)
    if (!win) return { success: false, error: 'Which window? Pass pid and window_id.' }
    let el = null
    const t = parseToken(args)
    if (t) el = elements.elementByToken(win.pid, win.id, t.token)
    if (!el) {
      const state = await driver.windowState({ pid: win.pid, windowId: win.id, tree: true, screenshot: false, maxElements: 1500 })
      if (state.ok) {
        elements.rememberSnapshot(win.pid, win.id, state)
        el = t ? state.elements.find((e) => e.token === t.token) : elements.findElements(state.elements, { text: argText(args, 'text') ?? '', role: argText(args, 'role') ?? '', maxResults: 1 })[0] ?? null
      }
    }
    if (!el) return { success: false, error: 'No matching element to set. Use computer_find first.' }
    if (elements.isSecureField(el) && args?.allow_secret !== true) return { success: false, error: `${elements.describeElement(el)} is a password field; Wolffish does not fill those unless the user gave the secret in this conversation.` }
    if (driver.hasTool('set_value') && el.token) {
      const r = await driver.callTool('set_value', { pid: win.pid, window_id: win.id, element_token: el.token, element_index: el.index, value: String(value) })
      if (r.ok) {
        const after = await driver.windowState({ pid: win.pid, windowId: win.id, tree: true, screenshot: false, maxElements: 1500 })
        const now = after.ok ? after.elements.find((e) => e.index === el.index) : null
        const readback = now ? now.value : null
        const confirmed = readback != null && String(readback) === String(value)
        session().lastAction = { tool: 'set value', target: elements.describeElement(el), expect: null, summary: `set value on ${elements.describeElement(el)}: ${confirmed ? 'confirmed by readback' : 'unverified'}` }
        return { success: true, output: `Set ${elements.describeElement(el)} to "${String(value).slice(0, 200)}" through the accessibility API. Readback: ${readback == null ? 'unavailable' : `"${String(readback).slice(0, 200)}"`} — ${confirmed ? 'CONFIRMED' : 'not confirmed; verify with a screenshot'}.`, meta: { computerUse: { lastAction: session().lastAction } } }
      }
    }
    // Fallback: click the field, select all, type.
    if (!el.frame) return { success: false, error: 'Direct value setting is not available for this element and it has no on-screen frame to click.' }
    const center = { x: Math.round(el.frame.x + el.frame.width / 2), y: Math.round(el.frame.y + el.frame.height / 2) }
    session().aim = center
    await overlay.cursorTo(center, { kind: 'pointer', label: elements.describeElement(el) })
    const clicked = await deliverClick({ dip: center, button: 'left', count: 1, modifiers: [], delivery: 'auto' })
    if (!clicked.ok) return { success: false, error: `Could not focus the field: ${clicked.error}` }
    if (clicked.win) session().lastTarget = clicked.win
    await sleep(120)
    await deliverKeys({ key: 'a', modifiers: [process.platform === 'darwin' ? 'cmd' : 'ctrl'], delivery: 'auto' })
    await sleep(60)
    const typed = await deliverText({ text: String(value), via: 'auto', delivery: 'auto' })
    if (!typed.ok) return { success: false, error: `Could not type the value: ${typed.error}` }
    overlay.cursorPulse()
    session().lastAction = { tool: 'set value', target: elements.describeElement(el), expect: null, summary: `set value on ${elements.describeElement(el)} by click + select all + type (${typed.rung})` }
    return { success: true, output: `Direct value setting is not available here, so Wolffish clicked ${elements.describeElement(el)}, selected its text and typed the new value (${typed.rung} delivery). Verify with a screenshot.`, meta: { computerUse: { lastAction: session().lastAction } } }
  } catch (err) {
    return { success: false, error: `Set value failed: ${err?.message ?? String(err)}` }
  }
}

async function focusWindowTool(args) {
  const denied = requirePermissions()
  if (denied) return denied
  try {
    const win = await findWindow(args)
    if (!win) return { success: false, error: 'No window: pass pid and window_id from computer_list_windows.' }
    if (driver.status().available && driver.hasTool('bring_to_front')) {
      const r = await driver.callTool('bring_to_front', { pid: win.pid, window_id: win.id })
      if (r.ok) {
        session().lastTarget = win
        return { success: true, output: `Brought ${describeWindow(win)} to the front (the user's pointer was not moved). Keys and typing now go there.` }
      }
    }
    // Platform fallbacks: activate the owning app.
    const { execFile } = await import('node:child_process')
    const run = (cmd, a) => new Promise((resolve, reject) => execFile(cmd, a, { timeout: 8000 }, (e, out) => (e ? reject(e) : resolve(String(out)))))
    if (process.platform === 'darwin' && win.pid) {
      await run('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${Number(win.pid)}) to true`])
    } else if (process.platform === 'win32' && win.pid) {
      await run('powershell', ['-NoProfile', '-Command', `$w=(Get-Process -Id ${Number(win.pid)}).MainWindowHandle; Add-Type -Name U -Namespace W -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);'; [W.U]::SetForegroundWindow($w)`])
    } else if (process.platform === 'linux' && win.id) {
      await run('wmctrl', ['-ia', String(win.id)])
    } else {
      return { success: false, error: 'No way to focus that window on this machine.' }
    }
    session().lastTarget = win
    return { success: true, output: `Activated ${describeWindow(win)} through the operating system. Keys and typing now go there.` }
  } catch (err) {
    return { success: false, error: `Focus window failed: ${err?.message ?? String(err)}` }
  }
}

async function menuTool(args) {
  const denied = requirePermissions()
  if (denied) return denied
  if (!driver.status().available) return { success: false, error: 'Menu invocation needs the native driver, which is not loaded. Use the menu bar with clicks or a keyboard shortcut.' }
  const pathArg = Array.isArray(args?.path) ? args.path.map((p) => String(p).trim()).filter(Boolean) : []
  if (pathArg.length === 0) return { success: false, error: 'path is required: an array of menu labels from the top level down, e.g. ["File", "Save As…"].' }
  try {
    const win = await findWindow(args)
    if (!win) return { success: false, error: 'No window: pass pid and window_id.' }
    const r = await driver.invokeMenu({ pid: win.pid, windowId: win.id, path: pathArg })
    if (!r.ok) return { success: false, error: `Menu path ${pathArg.join(' › ')} could not be invoked (${r.refusal?.code}): ${r.refusal?.message}` }
    session().lastAction = { tool: 'menu', target: pathArg.join(' › '), expect: argText(args, 'expect'), summary: `menu ${pathArg.join(' › ')} invoked${r.action ? `, ${r.action.effect}` : ''}` }
    return { success: true, output: `Invoked menu ${pathArg.join(' › ')} in ${describeWindow(win)} through the accessibility API (no pointer movement). ${r.text} Take a screenshot to see the result.`, meta: { computerUse: { lastAction: session().lastAction } } }
  } catch (err) {
    return { success: false, error: `Menu failed: ${err?.message ?? String(err)}` }
  }
}

async function waitForTool(args) {
  const denied = requirePermissions()
  if (denied) return denied
  const timeoutMs = Math.max(100, Number(args?.timeout_ms) || 5000)
  const kind = String(args?.until ?? 'stable').toLowerCase()
  const started = Date.now()
  try {
    if (kind === 'stable') {
      // Two consecutive display captures with under 0.2% change.
      const display = electronScreen.getDisplayNearestPoint(aimPoint() ?? { x: 0, y: 0 })
      let prev = (await captureNative(display)).png
      let stableCount = 0
      while (Date.now() - started < timeoutMs) {
        await sleep(250)
        const cur = (await captureNative(display)).png
        const pct = await regionChangePct(prev, cur, null)
        prev = cur
        if (pct !== null && pct < CHANGE_DISPLAY_MIN_PCT) stableCount++
        else stableCount = 0
        if (stableCount >= 2) return { success: true, output: `The screen has been stable for two samples (${Date.now() - started}ms). Take a screenshot to read it.` }
      }
      return { success: true, output: `The screen kept changing for the whole ${timeoutMs}ms (animation, video or a long load). Take a screenshot and judge for yourself.` }
    }
    if (kind === 'window_title') {
      const needle = (argText(args, 'text') ?? '').toLowerCase()
      if (!needle) return { success: false, error: 'text is required for until: window_title.' }
      while (Date.now() - started < timeoutMs) {
        const list = await visibleWindows(true)
        const hit = list.find((w) => (w.title || '').toLowerCase().includes(needle))
        if (hit) return { success: true, output: `A window titled "${hit.title}" (${hit.app}, window_id ${hit.id}, pid ${hit.pid}) is now visible after ${Date.now() - started}ms.` }
        await sleep(250)
      }
      return { success: true, output: `No window title contained "${needle}" within ${timeoutMs}ms.` }
    }
    if (kind === 'element' || kind === 'element_gone') {
      if (!driver.status().available) return { success: false, error: 'Waiting for an element needs the native driver, which is not loaded. Use until: stable and a screenshot.' }
      const win = await findWindow(args)
      if (!win) return { success: false, error: 'No window: pass pid and window_id.' }
      const text = argText(args, 'text') ?? ''
      const role = argText(args, 'role') ?? ''
      if (!text && !role) return { success: false, error: 'text and/or role are required for element waits.' }
      while (Date.now() - started < timeoutMs) {
        const state = await driver.windowState({ pid: win.pid, windowId: win.id, tree: true, screenshot: false, maxElements: 1500 })
        if (state.ok) {
          elements.rememberSnapshot(win.pid, win.id, state)
          const hit = elements.findElements(state.elements, { text, role, maxResults: 1 })[0]
          if (kind === 'element' && hit) return { success: true, output: `${elements.describeElement(hit)} appeared after ${Date.now() - started}ms${hit.token ? ` (token ${hit.token})` : ''}.` }
          if (kind === 'element_gone' && !hit) return { success: true, output: `No element matching ${text ? `"${text}"` : role} remains after ${Date.now() - started}ms.` }
        }
        await sleep(300)
      }
      return { success: true, output: `Condition not met within ${timeoutMs}ms (${kind === 'element' ? 'element did not appear' : 'element is still there'}). Take a screenshot to see the actual state.` }
    }
    return { success: false, error: `Unknown until: ${kind}. Use stable, window_title, element or element_gone.` }
  } catch (err) {
    return { success: false, error: `Wait failed: ${err?.message ?? String(err)}` }
  }
}

async function clipboardReadTool() {
  try {
    const text = electronClipboard?.readText?.() ?? ''
    const formats = electronClipboard?.availableFormats?.() ?? []
    const hasImage = formats.some((f) => /image/i.test(f))
    return { success: true, output: text ? `Clipboard text (${text.length} chars):\n${text.slice(0, 20000)}` : hasImage ? 'The clipboard holds an image (no text).' : 'The clipboard is empty.' }
  } catch (err) {
    return { success: false, error: `Clipboard read failed: ${err?.message ?? String(err)}` }
  }
}

async function clipboardWriteTool(args) {
  try {
    const text = typeof args?.text === 'string' ? args.text : null
    const imagePath = argText(args, 'image_path')
    if (text == null && !imagePath) return { success: false, error: 'text or image_path is required.' }
    if (imagePath) {
      const { nativeImage } = electron
      const img = nativeImage.createFromPath(imagePath)
      if (img.isEmpty()) return { success: false, error: `Could not read an image from ${imagePath}.` }
      electronClipboard.writeImage(img)
      return { success: true, output: `Copied the image at ${imagePath} to the clipboard. Paste it with computer_keyboard_press cmd+v / ctrl+v.` }
    }
    electronClipboard.writeText(text)
    return { success: true, output: `Copied ${text.length} characters to the clipboard.` }
  } catch (err) {
    return { success: false, error: `Clipboard write failed: ${err?.message ?? String(err)}` }
  }
}

async function accessSnapshot() {
  const probes = await probeAccess({ electron, driverStatus: driver.status(), macPermissions: process.platform === 'darwin' ? await driver.macPermissions() : null })
  return buildAccessReport({ ...probes, overlayAvailable: !overlay.overlayUnavailable() })
}

async function checkAccessTool(args) {
  try {
    // Trigger the OS prompts when asked (macOS shows them once per app).
    if (args?.request === true && process.platform === 'darwin') {
      try {
        electron?.systemPreferences?.isTrustedAccessibilityClient?.(true)
      } catch {
        // Not in Electron.
      }
      await driver.macPermissions()
      try {
        // A probe capture is what makes macOS show the Screen Recording prompt.
        await electronDesktopCapturer?.getSources?.({ types: ['screen'], thumbnailSize: { width: 2, height: 2 } })
      } catch {
        // The prompt itself is the point.
      }
    }
    const report = await accessSnapshot()
    return { success: true, output: report.text, meta: { computerUse: { access: report } } }
  } catch (err) {
    return { success: false, error: `Access check failed: ${err?.message ?? String(err)}` }
  }
}

async function batchTool(args) {
  const steps = Array.isArray(args?.steps) ? args.steps : []
  if (steps.length === 0) return { success: false, error: 'steps is required: an array of { tool, args } objects.' }
  if (steps.length > 25) return { success: false, error: 'At most 25 steps per batch.' }
  const lines = []
  const images = []
  let lastMeta
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] ?? {}
    const name = String(step.tool ?? '')
    if (name === 'computer_batch' || !TOOL_MAP[name]) {
      lines.push(`${i + 1}. ${name || '(missing tool)'}: not a computer-use tool — batch stopped.`)
      return { success: false, error: lines.join('\n') }
    }
    const gated = indicatorGate(name)
    if (gated) return { success: false, error: `${i + 1}. ${name}: ${gated.error}` }
    const r = await TOOL_MAP[name](step.args ?? {})
    if (r?.images?.length) images.push(...r.images)
    if (r?.meta) lastMeta = r.meta
    const body = r?.success ? r.output ?? '' : `FAILED: ${r?.error ?? 'unknown error'}`
    lines.push(`${i + 1}. ${name}: ${String(body).slice(0, 1500)}`)
    if (!r?.success) return { success: false, error: `Batch stopped at step ${i + 1}.\n${lines.join('\n')}`, images: images.slice(-2) }
    // Stop on the strong signals only: the driver's own no-op verdict, or a
    // real-pointer action the person interrupted. The pixel "no visible
    // change" line stays in the step's text for the model to weigh — a click
    // that merely focuses a field legitimately changes almost nothing.
    const noop = /INTERRUPTED|effect suspected noop/i.test(String(r.output ?? ''))
    if (noop && step.stop_on_noop !== false) {
      lines.push(`Batch stopped after step ${i + 1}: it reported a suspected no-op or an interruption. Verify before continuing.`)
      break
    }
  }
  return { success: true, output: lines.join('\n'), images: images.slice(-2), meta: lastMeta }
}

// ─── Gate ───────────────────────────────────────────────────────────────

/**
 * Tools that look at the user's screen or move their mouse and keyboard —
 * everything the indicator exists to disclose. Listing displays, waiting,
 * the access check, the clipboard and the glow tools themselves stay open.
 */
export const INDICATOR_REQUIRED = new Set([
  'computer_screenshot',
  'computer_zoom',
  'computer_mouse_move',
  'computer_mouse_click',
  'computer_mouse_drag',
  'computer_mouse_scroll',
  'computer_keyboard_type',
  'computer_keyboard_press',
  'computer_hover',
  'computer_mouse_down',
  'computer_mouse_up',
  'computer_key_down',
  'computer_key_up',
  'computer_list_windows',
  'computer_window_screenshot',
  'computer_window_state',
  'computer_find',
  'computer_read_element',
  'computer_click_element',
  'computer_set_value',
  'computer_focus_window',
  'computer_menu',
  'computer_wait_for'
])

export function indicatorGateReason(toolName, { indicatorOn, unavailable }) {
  if (!INDICATOR_REQUIRED.has(toolName)) return null
  if (unavailable) return null
  if (indicatorOn) return null
  return (
    `Screen indicator is OFF, so ${toolName} did not run — the user has not been told their screen is ` +
    `being captured and controlled. Call computer_glow_on first (the FIRST action of every computer-use ` +
    `session), then repeat this call; computer_glow_off is the last action when you finish or give up.`
  )
}

function indicatorGate(toolName) {
  // Presence assertion: "on" must mean visibly on. A window the OS took
  // down while the model believes the indicator is up is recreated here.
  const indicatorOn = overlay.overlayWanted() ? overlay.ensureOverlayAlive() : false
  const reason = indicatorGateReason(toolName, { indicatorOn, unavailable: overlay.overlayUnavailable() })
  return reason ? refuse(reason) : null
}

// ─── Tool map and definitions ───────────────────────────────────────────

const TOOL_MAP = {
  computer_glow_on: glowOn,
  computer_glow_off: glowOff,
  computer_check_access: checkAccessTool,
  computer_screenshot: takeScreenshot,
  computer_zoom: zoomRegion,
  computer_list_displays: listDisplays,
  computer_list_windows: listWindowsTool,
  computer_window_screenshot: windowScreenshot,
  computer_window_state: windowStateTool,
  computer_find: findTool,
  computer_read_element: readElementTool,
  computer_click_element: clickElementTool,
  computer_set_value: setValueTool,
  computer_focus_window: focusWindowTool,
  computer_menu: menuTool,
  computer_mouse_move: mouseMove,
  computer_hover: hover,
  computer_mouse_click: mouseClick,
  computer_mouse_down: (a) => mouseDownUp(a, true),
  computer_mouse_up: (a) => mouseDownUp(a, false),
  computer_mouse_drag: mouseDrag,
  computer_mouse_scroll: mouseScroll,
  computer_keyboard_type: keyboardType,
  computer_keyboard_press: keyboardPress,
  computer_key_down: (a) => keyDownUp(a, true),
  computer_key_up: (a) => keyDownUp(a, false),
  computer_wait: waitMs,
  computer_wait_for: waitForTool,
  computer_clipboard_read: clipboardReadTool,
  computer_clipboard_write: clipboardWriteTool,
  computer_batch: batchTool
}

const num = (description) => ({ type: 'number', description })
const str = (description) => ({ type: 'string', description })
const bool = (description) => ({ type: 'boolean', description })
const obj = (properties, required = []) => ({ type: 'object', properties, required })
const coords = { x: num('X in current-frame pixels'), y: num('Y in current-frame pixels') }
const winRef = { pid: num('Process id from computer_list_windows (optional: defaults to the window of the current frame or the last action)'), window_id: num('Window id from computer_list_windows') }
const targetExpect = { target: str('What you are acting on, as a short phrase — echoed and checked against the element under the point'), expect: str('What should happen (e.g. "a menu opens") — carried into the next step so you verify it') }
const delivery = { delivery: { type: 'string', enum: ['auto', 'background', 'foreground'], description: 'auto (default): background first, foreground if refused. background: refuse rather than move the pointer. foreground: activate the window (brief flash), pointer restored.' } }

// Mirror of the SKILL.md frontmatter (the model-facing schema) for tooling
// that inspects the plugin directly.
const toolDefinitions = [
  { name: 'computer_glow_on', description: 'Turn ON the screen indicator (glow, capture notice, shadow cursor). FIRST action of every session.', parameters: obj({ display_index: num('Display to show it on first (default 0)') }) },
  { name: 'computer_glow_off', description: 'Turn OFF the screen indicator. LAST action when you finish or give up.', parameters: obj({}) },
  { name: 'computer_check_access', description: 'What this machine lets Wolffish see and control, per OS, with the exact fix for anything missing.', parameters: obj({ request: bool('Trigger the OS permission prompts (macOS) before reporting') }) },
  {
    name: 'computer_screenshot',
    description: 'Capture a display; becomes the current frame. Resolution and format are yours to choose per capture via max_width and format — there is no user setting for them.',
    parameters: obj({
      display_index: num('Display index (default 0)'),
      max_width: {
        type: 'number',
        description: 'Width cap in pixels for THIS capture only (480-2560, default 1280). Does not persist — pass it on every capture that needs it.'
      },
      format: {
        type: 'string',
        enum: ['jpeg', 'png'],
        description: 'Image format for THIS capture only (default jpeg). Does not persist — pass it on every capture that needs it.'
      }
    })
  },
  { name: 'computer_zoom', description: 'Magnify a region of the current frame at native resolution; becomes the current frame.', parameters: obj({ ...coords, width: num('Region width'), height: num('Region height') }, ['x', 'y', 'width', 'height']) },
  { name: 'computer_list_displays', description: 'List displays.', parameters: obj({}) },
  { name: 'computer_list_windows', description: 'List visible windows front to back with ids, apps, titles, bounds.', parameters: obj({ app: str('Filter by app or title substring') }) },
  { name: 'computer_window_screenshot', description: 'Capture one window (even when covered); becomes the current frame, scoped to that window.', parameters: obj({ ...winRef, max_width: num('Width cap for this capture'), format: { type: 'string', enum: ['jpeg', 'png'] } }) },
  { name: 'computer_window_state', description: 'The full element tree of one window.', parameters: obj({ ...winRef, max_elements: num('Cap (default 400)'), max_depth: num('Depth cap (default 14)') }) },
  { name: 'computer_find', description: 'Find elements by text and/or role in a window; returns tokens and current-frame coordinates. When the target is a web page in a browser the Wolffish extension is connected to, prefer the ext_* tools for reading, typing and clicking inside the page, and stay in computer use for the browser\'s chrome, dialogs and file pickers around it.', parameters: obj({ ...winRef, text: str('Label, value or part of one'), role: str('button, text field, checkbox, menu item, …'), max_results: num('Default 25') }) },
  { name: 'computer_read_element', description: 'Read one element (value, label, state) by token or text.', parameters: obj({ ...winRef, token: str('Token from computer_find'), text: str('Or find by text'), role: str('Or by role') }) },
  { name: 'computer_click_element', description: 'Click an element by token through the accessibility route (most reliable).', parameters: obj({ ...winRef, token: str('Token from computer_find'), button: { type: 'string', enum: ['left', 'right', 'middle'] }, count: num('1-3'), double: bool('Double-click'), ...targetExpect, ...delivery }, ['token']) },
  { name: 'computer_set_value', description: 'Write a field directly (with readback), or click + select all + type when direct writes are unsupported.', parameters: obj({ ...winRef, token: str('Token from computer_find'), text: str('Or find the field by text'), role: str('Or by role'), value: str('The new value'), allow_secret: bool('The user gave this secret in the conversation') }, ['value']) },
  { name: 'computer_focus_window', description: 'Bring a window to the front.', parameters: obj({ ...winRef }) },
  { name: 'computer_menu', description: 'Invoke an application menu path, e.g. ["File","Save"].', parameters: obj({ ...winRef, path: { type: 'array', items: { type: 'string' }, description: 'Menu labels from the top level down' }, expect: str('What should happen') }, ['path']) },
  { name: 'computer_mouse_move', description: 'Aim the SHADOW cursor at x,y (the real pointer does not move); returns a magnifier to verify the aim.', parameters: obj({ ...coords, target: str('What you are aiming at') }, ['x', 'y']) },
  { name: 'computer_hover', description: 'Move the REAL pointer to x,y and hold, for tooltips and hover menus.', parameters: obj({ ...coords, ms: num('Hold time (default 400)'), target: str('What you are hovering') }, ['x', 'y']) },
  { name: 'computer_mouse_click', description: 'Click at x,y (or at the aim point). Background delivery first; every result carries an evidence line.', parameters: obj({ ...coords, button: { type: 'string', enum: ['left', 'right', 'middle'] }, count: num('1-3'), double: bool('Double-click'), modifiers: str('Comma-separated: shift, ctrl, alt, cmd'), ...targetExpect, ...delivery }) },
  { name: 'computer_mouse_down', description: 'Press and hold a mouse button at the real pointer (optionally moving there first).', parameters: obj({ ...coords, button: { type: 'string', enum: ['left', 'right', 'middle'] } }) },
  { name: 'computer_mouse_up', description: 'Release a held mouse button.', parameters: obj({ button: { type: 'string', enum: ['left', 'right', 'middle'] } }) },
  { name: 'computer_mouse_drag', description: 'Press at the start point, glide to the end point, release.', parameters: obj({ start_x: num('Start X'), start_y: num('Start Y'), end_x: num('End X'), end_y: num('End Y'), button: { type: 'string', enum: ['left', 'right', 'middle'] }, modifiers: str('Comma-separated modifiers to hold'), duration_ms: num('Glide time (default 500)'), ...targetExpect, ...delivery }, ['start_x', 'start_y', 'end_x', 'end_y']) },
  { name: 'computer_mouse_scroll', description: 'Scroll to reveal content on the direction side, at x,y or the aim point. In a web page the Wolffish extension is connected to, prefer ext_scroll — it scrolls the page or a named element without touching the pointer; keep computer_mouse_scroll for windows the extension cannot reach.', parameters: obj({ direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: num('Notches or pages (default 3)'), by: { type: 'string', enum: ['lines', 'pages'] }, ...coords, ...targetExpect, ...delivery }, ['direction']) },
  { name: 'computer_keyboard_type', description: 'Type text into the focused field of the last window you acted on; web content cannot be read back by the driver — use ext_get_value / ext_take_snapshot for that; in a browser the Wolffish extension is connected to, prefer ext_type or ext_fill for the typing itself.', parameters: obj({ text: str('Text to type'), enter: bool('Press Enter afterwards'), replace: bool('Select all existing text first'), via: { type: 'string', enum: ['auto', 'keystrokes', 'clipboard'] }, allow_secret: bool('The user gave this secret in the conversation'), ...targetExpect, ...delivery }, ['text']) },
  { name: 'computer_keyboard_press', description: "Press a key or shortcut, e.g. 'enter' or 'cmd+shift+s'.", parameters: obj({ key: str('Key or combo'), modifiers: str('Comma-separated modifiers'), expect: str('What should happen'), ...delivery }, ['key']) },
  { name: 'computer_key_down', description: 'Hold a key down (release with computer_key_up).', parameters: obj({ key: str('Key name') }, ['key']) },
  { name: 'computer_key_up', description: 'Release a held key.', parameters: obj({ key: str('Key name') }, ['key']) },
  { name: 'computer_wait', description: 'Wait the given milliseconds.', parameters: obj({ ms: num('Milliseconds') }, ['ms']) },
  { name: 'computer_wait_for', description: 'Wait until the screen is stable, a window title appears, or an element appears/disappears.', parameters: obj({ until: { type: 'string', enum: ['stable', 'window_title', 'element', 'element_gone'] }, text: str('Title or element text'), role: str('Element role'), timeout_ms: num('Bounded wait (default 5000)'), ...winRef }) },
  { name: 'computer_clipboard_read', description: 'Read the clipboard text.', parameters: obj({}) },
  { name: 'computer_clipboard_write', description: 'Put text or an image file on the clipboard.', parameters: obj({ text: str('Text'), image_path: str('Absolute image path') }) },
  { name: 'computer_batch', description: 'Run several computer-use steps in order; stops on the first failure, refusal or no-effect step.', parameters: obj({ steps: { type: 'array', items: { type: 'object' }, description: 'Ordered { tool, args } steps' } }, ['steps']) }
]

/** Approval-card description. Resolves the target window so the user approves a meaning, not coordinates. */
async function describeAction(toolName, args) {
  const fmtXY = () => (args?.x !== undefined ? `(${args.x}, ${args.y})` : 'the aim point')
  const target = argText(args, 'target')
  const at = target ? ` — ${target}` : ''
  let appScope = null
  let appText = ''
  try {
    if (driver.status().available && /^computer_(mouse_click|mouse_drag|mouse_scroll|hover|mouse_down|keyboard_type|keyboard_press|click_element|set_value|menu|focus_window)$/.test(toolName)) {
      let win = null
      if (args?.x !== undefined && args?.y !== undefined && currentFrame()) {
        const x = Number(args.x)
        const y = Number(args.y)
        if (Number.isFinite(x) && Number.isFinite(y) && !validateFrameCoords(x, y)) win = await resolvePointTarget(frameToDip(currentFrame(), x, y))
      } else if (windowArgs(args)) {
        const list = await visibleWindows()
        win = list.find((w) => w.id === windowArgs(args).id) ?? null
      } else if (session().lastTarget) {
        win = session().lastTarget
      } else if (session().aim) {
        win = await resolvePointTarget(session().aim)
      }
      if (win?.app) {
        appScope = win.app
        appText = ` in ${describeWindow(win)}`
      }
    }
  } catch {
    // The card still renders without the app.
  }
  const withScope = (d) => (appScope ? { ...d, scope: `computer-use@${appScope}` } : d)
  switch (toolName) {
    case 'computer_glow_on':
      return { title: 'Show screen indicator', description: 'Show the glow, capture notice and shadow cursor on the controlled display', risk: 'low' }
    case 'computer_glow_off':
      return { title: 'Hide screen indicator', description: 'Hide the glow and capture notice', risk: 'low' }
    case 'computer_check_access':
      return { title: 'Check access', description: 'Report which screen and input permissions are granted', risk: 'low' }
    case 'computer_screenshot':
      return { title: 'Take screenshot', description: 'Capture the current screen', risk: 'low' }
    case 'computer_window_screenshot':
      return { title: 'Capture window', description: `Capture one window${appText}`, risk: 'low' }
    case 'computer_zoom':
      return { title: 'Zoom into screen', description: `Magnify screen region ${args?.width ?? '?'}x${args?.height ?? '?'} at (${args?.x ?? '?'}, ${args?.y ?? '?'})`, risk: 'low' }
    case 'computer_list_displays':
      return { title: 'List displays', description: 'List all connected displays', risk: 'low' }
    case 'computer_list_windows':
      return { title: 'List windows', description: 'List the visible windows', risk: 'low' }
    case 'computer_window_state':
    case 'computer_find':
    case 'computer_read_element':
      return { title: 'Read window elements', description: `Read the controls of a window${appText}`, risk: 'low' }
    case 'computer_mouse_move':
      return { title: 'Aim cursor', description: `Aim the shadow cursor at ${fmtXY()}${at}`, risk: 'low' }
    case 'computer_hover':
      return withScope({ title: 'Hover', description: `Move the pointer to ${fmtXY()}${at}${appText}`, risk: 'low' })
    case 'computer_mouse_click': {
      const btn = args?.button ?? 'left'
      const n = args?.double ? 'Double-click' : Number(args?.count) === 3 ? 'Triple-click' : 'Click'
      return withScope({ title: `${n} ${btn}`, description: `${n} ${btn} button at ${fmtXY()}${at}${appText}`, risk: 'medium' })
    }
    case 'computer_click_element':
      return withScope({ title: 'Click element', description: `Click ${target ?? `element ${args?.token ?? ''}`}${appText}`, risk: 'medium' })
    case 'computer_set_value':
      return withScope({ title: 'Set field value', description: `Set ${target ?? argText(args, 'text') ?? 'a field'} to ${String(args?.value ?? '').length} characters${appText}`, risk: 'medium' })
    case 'computer_mouse_down':
      return withScope({ title: 'Hold mouse button', description: `Press and hold the ${args?.button ?? 'left'} button${appText}`, risk: 'medium' })
    case 'computer_mouse_up':
      return withScope({ title: 'Release mouse button', description: `Release the ${args?.button ?? 'left'} button`, risk: 'low' })
    case 'computer_mouse_drag':
      return withScope({ title: 'Drag', description: `Drag from (${args?.start_x ?? '?'}, ${args?.start_y ?? '?'}) to (${args?.end_x ?? '?'}, ${args?.end_y ?? '?'})${at}${appText}`, risk: 'medium' })
    case 'computer_mouse_scroll':
      return withScope({ title: `Scroll ${args?.direction ?? 'down'}`, description: `Scroll ${args?.direction ?? 'down'} by ${args?.amount ?? 3}${appText}`, risk: 'low' })
    case 'computer_keyboard_type':
      return withScope({ title: 'Type text', description: `Type ${String(args?.text ?? '').length} characters${args?.enter ? ' and press Enter' : ''}${appText}`, risk: 'medium' })
    case 'computer_keyboard_press': {
      const key = args?.key ?? '?'
      const mods = args?.modifiers ? `${args.modifiers}+` : ''
      return withScope({ title: 'Press key', description: `Press ${mods}${key}${appText}`, command: `${mods}${key}`, risk: 'medium' })
    }
    case 'computer_key_down':
      return withScope({ title: 'Hold key', description: `Hold ${args?.key ?? '?'}`, risk: 'medium' })
    case 'computer_key_up':
      return { title: 'Release key', description: `Release ${args?.key ?? '?'}`, risk: 'low' }
    case 'computer_focus_window':
      return withScope({ title: 'Focus window', description: `Bring a window to the front${appText}`, risk: 'low' })
    case 'computer_menu':
      return withScope({ title: 'Invoke menu', description: `Open menu ${(Array.isArray(args?.path) ? args.path : []).join(' › ')}${appText}`, risk: 'medium' })
    case 'computer_wait':
      return { title: 'Wait', description: `Wait ${args?.ms ?? 0}ms`, risk: 'low' }
    case 'computer_wait_for':
      return { title: 'Wait for', description: `Wait until ${args?.until ?? 'the screen is stable'}`, risk: 'low' }
    case 'computer_clipboard_read':
      return { title: 'Read clipboard', description: 'Read the clipboard text', risk: 'low' }
    case 'computer_clipboard_write':
      return { title: 'Write clipboard', description: 'Replace the clipboard contents', risk: 'medium' }
    case 'computer_batch': {
      const steps = Array.isArray(args?.steps) ? args.steps : []
      return { title: 'Run steps', description: `Run ${steps.length} computer-use steps in order: ${steps.map((s) => String(s?.tool ?? '?').replace(/^computer_/, '')).join(', ')}`, risk: 'medium' }
    }
    default:
      return null
  }
}

const plugin = {
  name: 'computer-use',
  tools: toolDefinitions,
  describeAction,

  async init(context) {
    workspaceRoot = context.workspaceRoot
    if (context.getCurrentConversationId) getConversationId = context.getCurrentConversationId
    refreshAppLocale()

    try {
      electron = await import('electron')
      electronScreen = electron.screen
      electronDesktopCapturer = electron.desktopCapturer
      electronClipboard = electron.clipboard
      electronBrowserWindow = electron.BrowserWindow
      overlay.initOverlay({
        electron,
        locale: () => {
          refreshAppLocale()
          return appLocale
        },
        logger: log
      })
      try {
        electron.app?.on?.('before-quit', () => overlay.destroyOverlay())
      } catch {
        // Not in Electron.
      }
    } catch {
      // Will fall back to errors in the capture tools.
    }

    try {
      sharp = (await import('sharp')).default
    } catch (err) {
      permissionError = `Failed to load image dependencies: ${err?.message ?? String(err)}`
    }

    // The native driver first: it is the path that never touches the pointer.
    await driver.load({ log })

    try {
      const nut = await import('@nut-tree-fork/nut-js')
      nutMouse = nut.mouse
      nutKeyboard = nut.keyboard
      nutButton = nut.Button
      nutPoint = nut.Point
      nutStraightTo = nut.straightTo
      try {
        nutKeyboard.config.autoDelayMs = 15
        nutMouse.config.autoDelayMs = 25
        nutMouse.config.mouseSpeed = 2500
      } catch {
        // Config shape differs across forks.
      }
      await checkNut()
    } catch (err) {
      nutReady = false
      if (!driver.status().available) permissionError = `Failed to load computer-use dependencies: ${err?.message ?? String(err)}`
    }
  },

  async execute(toolName, args) {
    const handler = TOOL_MAP[toolName]
    if (!handler) return { success: false, error: `computer-use: unknown tool ${toolName}` }
    const gated = indicatorGate(toolName)
    if (gated) return gated
    return handler(args ?? {})
  },

  async destroy() {
    stopKeepalive()
    overlay.destroyOverlay()
    elements.clearSnapshots()
    await driver.unload()
  }
}

export default plugin
