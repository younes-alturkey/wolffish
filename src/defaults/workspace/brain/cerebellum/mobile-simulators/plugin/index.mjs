// mobile-simulators: one platform-agnostic driver for the iOS Simulator and
// Android emulators/devices. A device is a device: the same tools look,
// touch, type, launch, read logs and record on both.
//
// Three contracts hold everything together (see the modules they live in):
//   frames.mjs    — the model gives coordinates only in the latest image's
//                   pixels; this plugin owns every translation;
//   snapshot.mjs  — the accessibility tree as one line per element with
//                   refs that expire on every action;
//   indicator.mjs — a driving indicator framed to the device's window,
//                   raised and lowered by the model, gating every tool that
//                   sees or touches the screen.
// Every touch returns proof: whether the screen changed and a magnifier
// patch on the exact point, which becomes the next frame.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as android from './android.mjs'
import { axe, axeCheck, axeInstall, axeUnavailableError, resolveAxe, axeVersion, AXE_VERSION } from './axe.mjs'
import { bootAvd, bootSimulator, describeTarget, eraseSimulator, getActive, listAll, listAvds, resolveTarget, setActive, shutdownAndroid, shutdownSimulator } from './devices.mjs'
import { CODES, fail, infra, invalid } from './errors.mjs'
import { androidSdkRoots, isUuid, resolveBinary, run } from './exec.mjs'
import * as frames from './frames.mjs'
import { initHelpers, listHelpers, stopOwnedHelpers, sweepHelpers } from './helpers.mjs'
import * as indicator from './indicator.mjs'
import * as ios from './ios.mjs'
import * as snap from './snapshot.mjs'
import { listWindows } from './windows.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

let workspaceRoot = null
let getConversationId = () => null
let appLocale = 'en'
let electron = null
const log = (m) => console.log(m)

function refreshLocale() {
  if (!workspaceRoot) return
  readFile(path.join(workspaceRoot, 'config.json'), 'utf8')
    .then((raw) => {
      appLocale = JSON.parse(raw)?.locale === 'ar' ? 'ar' : 'en'
    })
    .catch(() => {})
}

// Per (conversation, device) state the action pipeline needs.
const sessions = new Map()
function session(target) {
  const key = ctxKey(target)
  let s = sessions.get(key)
  if (!s) {
    s = { lastPoint: null, lastApp: null }
    sessions.set(key, s)
  }
  return s
}

function ctxKey(target) {
  return `${getConversationId() ?? 'default'}:${target.id}`
}

function backend(target) {
  return target.platform === 'ios' ? ios : android
}

const str = (v) => (typeof v === 'string' ? v.trim() : '')
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
const bool = (v, d = false) => (typeof v === 'boolean' ? v : typeof v === 'string' ? /^(true|yes|1)$/i.test(v) : d)

// ─── Gate ─────────────────────────────────────────────────────────────────

/** Tools that see or touch the screen. Everything else runs without the indicator. */
export const INDICATOR_REQUIRED = new Set([
  'mobile_screenshot',
  'mobile_zoom',
  'mobile_snapshot',
  'mobile_wait_for',
  'mobile_tap',
  'mobile_long_press',
  'mobile_swipe',
  'mobile_drag',
  'mobile_type',
  'mobile_key',
  'mobile_button',
  'mobile_batch'
])

export const INDICATOR_ON_TOOL = 'mobile_indicator_on'
export const INDICATOR_OFF_TOOL = 'mobile_indicator_off'

/** Pure: why a call is refused, or null. Mirrors computer-use's gate. */
export function indicatorGateReason(toolName, { indicatorOn, unavailable }) {
  if (!INDICATOR_REQUIRED.has(toolName)) return null
  if (unavailable) return null
  if (indicatorOn) return null
  return (
    `${CODES.INDICATOR_REQUIRED}: ${toolName} did not run — the driving indicator is off. ` +
    `Call ${INDICATOR_ON_TOOL} first (the user must see that Wolffish is driving their simulator), then ${toolName} again. ` +
    `Lifecycle, build and log tools work without it.`
  )
}

function gate(toolName) {
  const reason = indicatorGateReason(toolName, { indicatorOn: indicator.indicatorOn(), unavailable: indicator.indicatorUnavailable() })
  return reason ? fail(CODES.INDICATOR_REQUIRED, reason.replace(/^INDICATOR_REQUIRED: /, ''), null) : null
}

// ─── Shared pieces ────────────────────────────────────────────────────────

async function target(args, { needBooted = true } = {}) {
  const r = await resolveTarget(args?.device, getConversationId(), { needBooted })
  return r
}

async function geometryFor(t) {
  const g = await backend(t).geometry(t.id)
  if (!g) return null
  return g
}

async function capture(t) {
  const r = await backend(t).screenshotBuffer(t.id)
  return r
}

async function ensureIndicatorFor(t, g) {
  if (!indicator.indicatorOn()) return
  const mapping = t.platform === 'ios' ? await ios.windowMapping(t.id) : null
  await indicator.ensureIndicator(t, { geometry: g, mapping })
}

function frameKey(t) {
  return ctxKey(t)
}

function frameNote(f) {
  return `Frame: ${frames.describeFrame(f)}.`
}

/** Frame px → native units, validated. */
function pointFromFrame(t, x, y) {
  const f = frames.getFrame(frameKey(t))
  if (!f) return { error: fail(CODES.FRAME_MISSING, 'no image frame yet for this device', 'call mobile_screenshot (or mobile_snapshot) first, then give coordinates in that image') }
  if (!frames.inFrame(f, x, y)) return { error: fail(CODES.OUT_OF_FRAME, `(${x}, ${y}) is outside the current frame (${f.image.w}x${f.image.h} px)`, 'coordinates are pixels of the latest image; take a fresh mobile_screenshot if you meant another view') }
  return { point: frames.toNative(f, x, y), frame: f }
}

function elementCenter(el) {
  return { x: el.frame.x + el.frame.w / 2, y: el.frame.y + el.frame.h / 2 }
}

/** Resolve a ref or an (x, y) pair to a native point. */
function resolvePoint(t, args, { allowNone = false } = {}) {
  const ref = str(args?.ref)
  if (ref) {
    const r = snap.resolveRef(frameKey(t), ref)
    if (r.status === 'missing') return { error: fail(CODES.SNAPSHOT_MISSING, `no snapshot to resolve ${ref}`, 'call mobile_snapshot first') }
    if (r.status === 'expired') return { error: fail(CODES.SNAPSHOT_EXPIRED, `the snapshot that defined ${ref} is stale`, 'call mobile_snapshot again and use a fresh ref') }
    if (r.status === 'not_found') return { error: fail(CODES.REF_NOT_FOUND, `${ref} is not in the current snapshot (${r.available} refs)`, 'call mobile_snapshot again and use a ref it lists') }
    if (!r.element.enabled) return { error: fail(CODES.TARGET_NOT_ACTIONABLE, `${ref} (${r.element.type} ${JSON.stringify(r.element.label ?? r.element.text ?? '')}) is disabled`, 'pick another element or wait for it to enable with mobile_wait_for') }
    return { point: elementCenter(r.element), element: r.element }
  }
  const x = num(args?.x)
  const y = num(args?.y)
  if (x == null || y == null) {
    if (allowNone) return { point: null }
    return { error: invalid('pass ref=e12 from mobile_snapshot, or x and y in pixels of the latest image') }
  }
  return pointFromFrame(t, x, y)
}

function describePoint(t, p) {
  return `${Math.round(p.x)},${Math.round(p.y)} ${t.platform === 'ios' ? 'pt' : 'px'}`
}

/**
 * The act pipeline: capture → draw the ripple → do it → settle → capture →
 * change detection → magnifier patch → new frame → refs dropped.
 */
async function act(t, toolName, args, doAction, { point, from, to, hold = false, what, signal }) {
  const g = await geometryFor(t)
  if (!g) return infra('could not measure the device screen (is it booted and responsive?)')
  await ensureIndicatorFor(t, g)
  const before = await capture(t)
  const anchor = point ?? to ?? from ?? session(t).lastPoint ?? { x: g.native.w / 2, y: g.native.h / 2 }
  if (from && to) indicator.stroke(t, from, to)
  else if (point) indicator.ripple(t, point, { hold })
  const r = await doAction()
  if (!r.success) return r
  const settle = Math.max(0, Math.min(5000, num(args?.settle_ms) ?? 350))
  await new Promise((res) => setTimeout(res, settle))
  const after = await capture(t)
  snap.clearSnapshot(frameKey(t))
  session(t).lastPoint = anchor
  let changeText = 'Change: unknown (capture failed)'
  let images
  let frameText = ''
  if (before.buffer && after.buffer) {
    const c = await frames.changeRatio(before.buffer, after.buffer, { point: anchor, pxPerUnit: g.pxPerUnit, native: g.native })
    const local = c.local != null ? `, ${Math.round(c.local * 100)}% near the point` : ''
    changeText = c.whole >= 0.002 || (c.local != null && c.local >= 0.02) ? `Changed: yes (${(c.whole * 100).toFixed(1)}% of the screen${local})` : 'Changed: NO — the screen looks the same; the tap may have missed or the app ignored it'
    try {
      const mag = await frames.magnifier(after.buffer, anchor, { pxPerUnit: g.pxPerUnit, native: g.native })
      const f = frames.setFrame(frameKey(t), { kind: 'magnifier', image: mag.info, region: mag.region, native: g.native, pxPerUnit: g.pxPerUnit, unit: g.unit })
      images = [{ mediaType: 'image/png', data: mag.buffer.toString('base64') }]
      frameText = ` ${frameNote(f)} The crosshair marks the exact point; coordinates you give next are pixels of this patch — mobile_screenshot for the whole screen.`
    } catch (e) {
      frameText = ` (magnifier unavailable: ${e?.message ?? e})`
    }
  }
  const expect = str(args?.expect)
  const summary = `${what} on ${t.name}`
  const out = `${r.output ? `${r.output} ` : ''}${summary}. ${changeText}.${frameText}${expect ? `\nYou expected: ${expect} — verify it on the patch or a fresh mobile_snapshot before the next step.` : ''}`
  return {
    success: true,
    output: out,
    images,
    meta: { label: what, mobile: { lastAction: { tool: toolName, target: describeTarget(t), expect: expect || null, summary } } }
  }
}

// ─── Devices ──────────────────────────────────────────────────────────────

async function mobileDevices() {
  const { ios: sims, android: droids, avds } = await listAll()
  const active = getActive(getConversationId())
  const lines = []
  const mark = (d) => (active?.id === d.id ? ' ← active' : '')
  if (process.platform === 'darwin') {
    if (sims.error) lines.push(`iOS Simulator: ${sims.error}`)
    else if (!sims.devices.length) lines.push('iOS Simulator: no devices (install a runtime in Xcode › Settings › Components)')
    else {
      const booted = sims.devices.filter((d) => d.state === 'Booted')
      lines.push(`iOS Simulator (${sims.devices.length}; ${booted.length} booted):`)
      for (const d of sims.devices.slice(0, 30)) lines.push(`  ${d.state === 'Booted' ? '●' : '○'} ${d.name} — ${d.runtime} — ${d.id}${d.state === 'Booted' ? ' (booted)' : d.state !== 'Shutdown' ? ` (${d.state})` : ''}${mark(d)}`)
      if (sims.devices.length > 30) lines.push(`  … and ${sims.devices.length - 30} more`)
    }
  }
  if (droids.error) lines.push(`Android: ${droids.error}`)
  else if (!droids.devices.length) lines.push('Android: no emulator running and no device connected')
  else {
    lines.push(`Android (${droids.devices.length}):`)
    for (const d of droids.devices) lines.push(`  ${d.state === 'Booted' ? '●' : '○'} ${d.name} — ${d.id}${d.emulator ? ' (emulator)' : ''}${d.state !== 'Booted' ? ` (${d.state})` : ''}${mark(d)}`)
  }
  if (avds.avds?.length) lines.push(`Android AVDs (boot one with mobile_boot device=<name>): ${avds.avds.join(', ')}`)
  else if (avds.error) lines.push(`Android AVDs: ${avds.error}`)
  lines.push(active ? `Active device: ${active.name} (${active.id}).` : 'No active device — mobile_use device=<name or id> picks one, or tools use the single booted device.')
  return { success: true, output: lines.join('\n') }
}

async function mobileUse(args) {
  const r = await target(args, { needBooted: false })
  if (r.error) return r.error
  setActive(getConversationId(), { platform: r.target.platform, id: r.target.id, name: r.target.name })
  return { success: true, output: `Active device: ${describeTarget(r.target)}${r.target.state !== 'Booted' ? ` — it is ${r.target.state}; mobile_boot brings it up` : ''}.` }
}

async function mobileBoot(args, signal) {
  const dev = str(args?.device)
  const r = await target(args, { needBooted: false })
  if (r.error && r.error.meta?.code === CODES.DEVICE_NOT_FOUND && dev) {
    const { avds } = await listAvds()
    const match = avds.find((a) => a.toLowerCase() === dev.toLowerCase()) ?? avds.find((a) => a.toLowerCase().includes(dev.toLowerCase()))
    if (match) {
      const b = await bootAvd(match, { coldBoot: bool(args?.cold_boot), headless: bool(args?.headless), signal })
      if (!b.success) return b
      setActive(getConversationId(), { platform: 'android', id: b.serial, name: match })
      return { success: true, output: `${b.output}\nActive device: ${match} (${b.serial}). Next: mobile_indicator_on, then mobile_screenshot or mobile_snapshot.` }
    }
  }
  if (r.error) {
    if (r.error.meta?.code === CODES.NO_DEVICE && !dev) {
      // Nothing booted and nothing named: boot the first iPhone, else the first AVD.
      const { ios: sims, avds } = await listAll()
      const pick = sims.devices?.find((d) => /iPhone/.test(d.name)) ?? sims.devices?.[0]
      if (pick) return mobileBoot({ ...args, device: pick.id }, signal)
      if (avds.avds?.[0]) return mobileBoot({ ...args, device: avds.avds[0] }, signal)
    }
    return r.error
  }
  const t = r.target
  if (t.platform === 'ios') {
    const b = await bootSimulator(t.id, { headless: bool(args?.headless), signal })
    if (!b.success) return b
    ios.forgetGeometry(t.id)
    setActive(getConversationId(), { platform: 'ios', id: t.id, name: t.name })
    return { success: true, output: `${b.output} Active device: ${t.name}. Next: mobile_indicator_on, then mobile_screenshot or mobile_snapshot.` }
  }
  if (t.state === 'Booted') {
    setActive(getConversationId(), { platform: 'android', id: t.id, name: t.name })
    return { success: true, output: `${describeTarget(t)} is already running. Active device set.` }
  }
  return fail(CODES.NOT_BOOTED, `${describeTarget(t)} is ${t.state}`, 'reconnect the device or pick an AVD name from mobile_devices')
}

async function mobileShutdown(args) {
  const r = await target(args, { needBooted: false })
  if (r.error) return r.error
  const t = r.target
  const res = t.platform === 'ios' ? await shutdownSimulator(t.id) : await shutdownAndroid(t.id)
  if (res.success) {
    indicator.indicatorHide()
    frames.clearFrame(frameKey(t))
    snap.clearSnapshot(frameKey(t))
  }
  return res
}

async function mobileErase(args) {
  const r = await target(args, { needBooted: false })
  if (r.error) return r.error
  if (r.target.platform !== 'ios') return fail(CODES.UNSUPPORTED, 'erase is for iOS simulators', 'on Android wipe the AVD in Android Studio or uninstall the app with mobile_uninstall')
  return eraseSimulator(r.target.id)
}

// ─── Apps ─────────────────────────────────────────────────────────────────

async function mobileApps(args) {
  const r = await target(args)
  if (r.error) return r.error
  const res = await backend(r.target).listApps(r.target.id, { all: bool(args?.all) })
  if (res.error) return infra(res.error)
  const apps = res.apps.filter((a) => bool(args?.all) || r.target.platform !== 'ios' || a.type !== 'System')
  return { success: true, output: `${apps.length} apps on ${r.target.name}:\n${apps.map((a) => `  ${a.bundleId}${a.name && a.name !== a.bundleId ? ` — ${a.name}` : ''}`).join('\n')}` }
}

async function mobileInstall(args) {
  const r = await target(args)
  if (r.error) return r.error
  const app = str(args?.app)
  if (!app) return invalid('app is required (a .app bundle for iOS, an .apk for Android)')
  const abs = path.resolve(app)
  const t = r.target
  if (t.platform === 'ios' && !/\.app$/i.test(abs)) return invalid(`${abs} is not a .app bundle`, 'xcode_build returns the .app path')
  if (t.platform === 'android' && !/\.apk$/i.test(abs)) return invalid(`${abs} is not an .apk`, './gradlew assembleDebug writes one under app/build/outputs/apk/')
  const res = await backend(t).install(t.id, abs)
  if (res.success) res.output += ` Next: mobile_launch bundle_id=<id>.`
  return res
}

async function mobileUninstall(args) {
  const r = await target(args)
  if (r.error) return r.error
  const id = str(args?.bundle_id)
  if (!id) return invalid('bundle_id is required')
  return backend(r.target).uninstall(r.target.id, id)
}

async function mobileLaunch(args) {
  const r = await target(args)
  if (r.error) return r.error
  const id = str(args?.bundle_id)
  if (!id) return invalid('bundle_id is required (the iOS bundle id or the Android package name)')
  const t = r.target
  const res = await backend(t).launch(t.id, id, { logs: !bool(args?.no_logs) })
  if (res.success) {
    session(t).lastApp = id
    res.output += `\nNext: ${indicator.indicatorOn() ? '' : 'mobile_indicator_on, then '}mobile_snapshot to read the screen, mobile_log to read its output.`
  }
  return res
}

async function mobileTerminate(args) {
  const r = await target(args)
  if (r.error) return r.error
  const id = str(args?.bundle_id) || session(r.target).lastApp
  if (!id) return invalid('bundle_id is required')
  return backend(r.target).terminate(r.target.id, id)
}

async function mobileOpenUrl(args) {
  const r = await target(args)
  if (r.error) return r.error
  const url = str(args?.url)
  if (!url) return invalid('url is required')
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return invalid(`"${url}" has no scheme`, 'use https://… or your app scheme myapp://…')
  const res = await backend(r.target).openUrl(r.target.id, url)
  if (res.success) snap.clearSnapshot(frameKey(r.target))
  return res
}

// ─── Seeing ───────────────────────────────────────────────────────────────

async function mobileScreenshot(args) {
  const r = await target(args)
  if (r.error) return r.error
  const t = r.target
  const g = await geometryFor(t)
  if (!g) return infra('could not measure the device screen')
  await ensureIndicatorFor(t, g)
  indicator.pulse(t)
  const shot = await backend(t).screenshotBuffer(t.id, { keep: true })
  if (!shot.buffer) return infra(shot.error ?? 'screenshot failed')
  const enc = await frames.encodeScreen(shot.buffer, { maxDimension: num(args?.max_dimension) ?? undefined })
  const native = { w: enc.original.w / g.pxPerUnit, h: enc.original.h / g.pxPerUnit }
  if (Math.abs(native.w - g.native.w) > 2 || Math.abs(native.h - g.native.h) > 2) {
    // Orientation changed under us: trust the capture.
    g.native = native
    g.pixels = enc.original
  }
  const f = frames.setFrame(frameKey(t), { kind: 'screenshot', image: enc.info, region: { x: 0, y: 0, w: g.native.w, h: g.native.h }, native: g.native, pxPerUnit: g.pxPerUnit, unit: g.unit })
  const upp = frames.unitsPerPx(f)
  const small = upp >= 1.8 ? ` The image is ${upp.toFixed(1)}x smaller than the screen: use mobile_zoom on small targets before tapping them.` : ''
  return {
    success: true,
    output: `Screenshot of ${t.name} saved to ${shot.file} (screen ${enc.original.w}x${enc.original.h} px = ${Math.round(g.native.w)}x${Math.round(g.native.h)} ${g.unit}; sent at ${enc.info.w}x${enc.info.h}). ${frameNote(f)} Coordinates you give to mobile_tap, mobile_swipe and mobile_zoom are pixels of THIS image.${small} The pixels are attached for this turn; send_file the saved path when the user should see it.`,
    images: [{ mediaType: 'image/png', data: enc.buffer.toString('base64') }],
    meta: { label: 'Screenshot' }
  }
}

async function mobileZoom(args) {
  const r = await target(args)
  if (r.error) return r.error
  const t = r.target
  const f = frames.getFrame(frameKey(t))
  if (!f) return fail(CODES.FRAME_MISSING, 'no image frame to zoom into', 'call mobile_screenshot first')
  const x = num(args?.x)
  const y = num(args?.y)
  if (x == null || y == null) return invalid('x and y (center of the region, in pixels of the latest image) are required')
  if (!frames.inFrame(f, x, y)) return fail(CODES.OUT_OF_FRAME, `(${x}, ${y}) is outside the current frame`, 'take a fresh mobile_screenshot')
  const wPx = num(args?.width) ?? Math.round(f.image.w / 3)
  const hPx = num(args?.height) ?? Math.round(f.image.h / 3)
  const c = frames.toNative(f, x, y)
  const upp = frames.unitsPerPx(f)
  const region = { x: c.x - (wPx * upp) / 2, y: c.y - (hPx * upp) / 2, w: wPx * upp, h: hPx * upp }
  const g = await geometryFor(t)
  await ensureIndicatorFor(t, g)
  const shot = await capture(t)
  if (!shot.buffer) return infra(shot.error ?? 'screenshot failed')
  const crop = await frames.cropRegion(shot.buffer, region, { pxPerUnit: g.pxPerUnit, native: g.native })
  const nf = frames.setFrame(frameKey(t), { kind: 'zoom', image: crop.info, region: crop.region, native: g.native, pxPerUnit: g.pxPerUnit, unit: g.unit })
  return {
    success: true,
    output: `Zoomed into ${Math.round(crop.region.w)}x${Math.round(crop.region.h)} ${g.unit} around ${describePoint(t, c)} on ${t.name}. ${frameNote(nf)} Coordinates you give next are pixels of THIS zoomed image (fresh capture, native resolution).`,
    images: [{ mediaType: 'image/png', data: crop.buffer.toString('base64') }],
    meta: { label: 'Zoom' }
  }
}

async function readElements(t, { signal } = {}) {
  const g = await geometryFor(t)
  if (!g) return { error: infra('could not measure the device screen') }
  const b = backend(t)
  const raw = await b.tree(t.id, { signal })
  if (raw.error) return { error: raw.error }
  const parsed = t.platform === 'ios' ? snap.fromAxe(raw.tree, { screen: g.native }) : snap.fromUiautomator(raw.xml, { screen: g.native })
  return { g, ...parsed, hash: snap.hashElements(parsed.elements) }
}

function formatSnapshot(t, g, parsed, { marker } = {}) {
  const key = frameKey(t)
  let f = frames.getFrame(key)
  if (!f) f = frames.nativeFrame(key, { native: g.native, pxPerUnit: g.pxPerUnit, unit: g.unit })
  const { chosen, truncated, matched } = snap.select(parsed.elements, { marker })
  const rec = snap.putSnapshot(key, { elements: parsed.elements, chosen, hash: parsed.hash, platform: t.platform, screen: g.native, unit: g.unit })
  const body = snap.formatElements(chosen, { toFrame: (x, y) => frames.fromNative(f, x, y) })
  const omittedBits = []
  if (parsed.omitted) omittedBits.push(`${parsed.omitted} hidden/off-screen`)
  if (truncated.interactive) omittedBits.push(`${truncated.interactive} more interactive`)
  if (truncated.text) omittedBits.push(`${truncated.text} more text`)
  if (truncated.scroll) omittedBits.push(`${truncated.scroll} more scroll areas`)
  const head =
    `${chosen.length} elements on ${t.name}${marker ? ` matching "${marker}" (${matched} matched)` : ''}${omittedBits.length ? ` (${omittedBits.join(', ')} omitted — narrow with marker=)` : ''}; screen ${parsed.hash}. ` +
    `One per line: @ref Type "label" text= value= id= center=x,y size=WxH [flags]. center/size are pixels of the current frame (${frames.describeFrame(f)}). ` +
    `Tap by ref (mobile_tap ref=e3) — refs expire after any action or 60 s.`
  return { output: `${head}\n${body || '(no elements)'}`, rec }
}

async function mobileSnapshot(args, signal) {
  const r = await target(args)
  if (r.error) return r.error
  const t = r.target
  const g0 = await geometryFor(t)
  await ensureIndicatorFor(t, g0)
  indicator.pulse(t)
  const parsed = await readElements(t, { signal })
  if (parsed.error) return parsed.error
  const since = str(args?.since)
  if (since && since === parsed.hash) return { success: true, output: `Screen unchanged since ${since} (${parsed.elements.length} elements). Refs from that snapshot are still valid until an action.` }
  const { output } = formatSnapshot(t, parsed.g, parsed, { marker: str(args?.marker) || undefined })
  return { success: true, output, meta: { label: 'Snapshot' } }
}

function elementMatches(e, needle) {
  const n = needle.toLowerCase()
  return [e.label, e.text, e.value, e.id, e.type].some((s) => s && String(s).toLowerCase().includes(n))
}

async function mobileWaitFor(args, signal) {
  const r = await target(args)
  if (r.error) return r.error
  const t = r.target
  const condition = str(args?.condition) || 'exists'
  const marker = str(args?.marker)
  const timeout = Math.max(250, Math.min(60_000, num(args?.timeout_ms) ?? 5000))
  const interval = Math.max(100, Math.min(5000, num(args?.interval_ms) ?? 250))
  if (!['exists', 'gone', 'focused', 'text', 'settled'].includes(condition)) return invalid('condition must be exists, gone, focused, text or settled')
  if (condition !== 'settled' && !marker) return invalid('marker (a label, text, id or type substring) is required for this condition')
  const g = await geometryFor(t)
  await ensureIndicatorFor(t, g)
  const deadline = Date.now() + timeout
  if (condition === 'settled') {
    let lastHash = null
    let stableSince = null
    while (Date.now() < deadline) {
      if (signal?.aborted) return infra('aborted', { retryable: false })
      const shot = await capture(t)
      if (!shot.buffer) return infra(shot.error ?? 'screenshot failed')
      const h = await frames.screenHash(shot.buffer)
      if (h === lastHash) {
        if (stableSince && Date.now() - stableSince >= 500) return { success: true, output: `Screen settled (stable for 500 ms) on ${t.name}. Next: mobile_snapshot.` }
        if (!stableSince) stableSince = Date.now()
      } else {
        lastHash = h
        stableSince = null
      }
      await new Promise((res) => setTimeout(res, interval))
    }
    return fail(CODES.WAIT_TIMEOUT, `the screen kept changing for ${Math.round(timeout / 1000)}s`, 'an animation or spinner may be running; mobile_screenshot to see what')
  }
  let lastParsed = null
  while (Date.now() < deadline) {
    if (signal?.aborted) return infra('aborted', { retryable: false })
    const parsed = await readElements(t, { signal })
    if (!parsed.error) {
      lastParsed = parsed
      const hits = parsed.elements.filter((e) => elementMatches(e, marker))
      const ok =
        condition === 'exists' ? hits.length > 0 : condition === 'gone' ? hits.length === 0 : condition === 'focused' ? hits.some((e) => e.focused) : condition === 'text' ? hits.length > 0 : false
      if (ok) {
        const { output } = formatSnapshot(t, parsed.g, parsed, { marker: condition === 'gone' ? undefined : marker })
        return { success: true, output: `Condition met: ${condition} "${marker}" on ${t.name}.\n${output}` }
      }
    }
    await new Promise((res) => setTimeout(res, interval))
  }
  const seen = lastParsed ? lastParsed.elements.filter((e) => elementMatches(e, marker)).length : 0
  return fail(CODES.WAIT_TIMEOUT, `"${marker}" did not become ${condition} within ${Math.round(timeout / 1000)}s (${seen} matching now)`, 'mobile_snapshot to see what is on screen, then act on that')
}

// ─── Touching ─────────────────────────────────────────────────────────────

async function mobileTap(args, signal) {
  const r = await target(args)
  if (r.error) return r.error
  const t = r.target
  const p = resolvePoint(t, args)
  if (p.error) return p.error
  const el = p.element
  const label = el ? `${el.type} ${JSON.stringify(el.label ?? el.text ?? el.id ?? '')}` : `(${describePoint(t, p.point)})`
  return act(t, 'mobile_tap', args, async () => {
    if (t.platform === 'ios' && el) {
      // Semantic first when the selector is unique in the snapshot; AXe
      // resolves the activation point itself. Coordinates otherwise.
      const s = snap.getSnapshot(frameKey(t))
      const all = s.rec?.elements ?? []
      if (el.id && all.filter((e) => e.id === el.id).length === 1) {
        const res = await ios.tapSelector(t.id, { id: el.id, type: el.type }, { signal })
        if (res.success) return res
      } else if (el.label && all.filter((e) => e.label === el.label && e.type === el.type).length === 1) {
        const res = await ios.tapSelector(t.id, { label: el.label, type: el.type }, { signal })
        if (res.success) return res
      }
    }
    return backend(t).tap(t.id, p.point, { signal })
  }, { point: p.point, what: `Tapped ${label}`, signal })
}

async function mobileLongPress(args, signal) {
  const r = await target(args)
  if (r.error) return r.error
  const t = r.target
  const p = resolvePoint(t, args)
  if (p.error) return p.error
  const durationMs = Math.max(200, Math.min(10_000, num(args?.duration_ms) ?? 800))
  return act(t, 'mobile_long_press', args, () => backend(t).longPress(t.id, p.point, { durationMs, signal }), { point: p.point, hold: true, what: `Long-pressed ${p.element ? `${p.element.type} ${JSON.stringify(p.element.label ?? p.element.text ?? '')}` : describePoint(t, p.point)} for ${durationMs} ms`, signal })
}

async function swipeEndpoints(t, args) {
  const g = await geometryFor(t)
  if (!g) return { error: infra('could not measure the device screen') }
  const f = frames.getFrame(frameKey(t))
  let from
  if (str(args?.ref) || (num(args?.x) != null && num(args?.y) != null)) {
    const p = resolvePoint(t, args)
    if (p.error) return p
    from = p.point
  } else from = { x: g.native.w / 2, y: g.native.h / 2 }
  const toX = num(args?.to_x)
  const toY = num(args?.to_y)
  let to
  if (toX != null && toY != null) {
    if (!f) return { error: fail(CODES.FRAME_MISSING, 'to_x/to_y need an image frame', 'call mobile_screenshot first or use direction=') }
    to = frames.toNative(f, toX, toY)
  } else {
    const dir = str(args?.direction).toLowerCase()
    if (!['up', 'down', 'left', 'right'].includes(dir)) return { error: invalid('direction must be up, down, left or right (or pass to_x/to_y)') }
    const upp = f ? frames.unitsPerPx(f) : 1
    const distPx = num(args?.distance)
    const dist = distPx != null ? distPx * upp : dir === 'up' || dir === 'down' ? g.native.h * 0.4 : g.native.w * 0.5
    to = { x: from.x, y: from.y }
    if (dir === 'up') to.y -= dist
    if (dir === 'down') to.y += dist
    if (dir === 'left') to.x -= dist
    if (dir === 'right') to.x += dist
    to.x = Math.max(2, Math.min(g.native.w - 2, to.x))
    to.y = Math.max(2, Math.min(g.native.h - 2, to.y))
  }
  return { from, to, g }
}

async function mobileSwipe(args, signal) {
  const r = await target(args)
  if (r.error) return r.error
  const t = r.target
  const e = await swipeEndpoints(t, args)
  if (e.error) return e.error
  const durationMs = Math.max(50, Math.min(5000, num(args?.duration_ms) ?? 300))
  const dir = str(args?.direction) || 'to the point'
  return act(t, 'mobile_swipe', args, () => backend(t).swipe(t.id, e.from, e.to, { durationMs, signal }), { from: e.from, to: e.to, point: null, what: `Swiped ${dir} from ${describePoint(t, e.from)} to ${describePoint(t, e.to)}`, signal })
}

async function mobileDrag(args, signal) {
  const r = await target(args)
  if (r.error) return r.error
  const t = r.target
  const a = resolvePoint(t, args)
  if (a.error) return a.error
  let to
  if (str(args?.to_ref)) {
    const b = resolvePoint(t, { ref: args.to_ref })
    if (b.error) return b.error
    to = b.point
  } else {
    const b = pointFromFrame(t, num(args?.to_x), num(args?.to_y))
    if (b.error) return b.error
    to = b.point
  }
  const durationMs = Math.max(200, Math.min(10_000, num(args?.duration_ms) ?? 800))
  return act(t, 'mobile_drag', args, () => backend(t).drag(t.id, a.point, to, { durationMs, signal }), { from: a.point, to, point: null, what: `Dragged from ${describePoint(t, a.point)} to ${describePoint(t, to)}`, signal })
}

async function mobileType(args, signal) {
  const r = await target(args)
  if (r.error) return r.error
  const t = r.target
  const text = typeof args?.text === 'string' ? args.text : ''
  if (!text) return invalid('text is required')
  let point = null
  let pre = ''
  if (str(args?.ref)) {
    const p = resolvePoint(t, args)
    if (p.error) return p.error
    point = p.point
    const tapped = await backend(t).tap(t.id, point, { signal })
    if (!tapped.success) return tapped
    indicator.ripple(t, point)
    await new Promise((res) => setTimeout(res, 250))
    pre = `Tapped ${p.element.type} ${JSON.stringify(p.element.label ?? p.element.text ?? '')} first. `
  }
  const submit = bool(args?.submit)
  return act(t, 'mobile_type', args, async () => {
    const res = await backend(t).typeText(t.id, text, { signal })
    if (!res.success) return res
    if (submit) {
      const k = await backend(t).pressKey(t.id, 'enter', { signal })
      if (!k.success) return k
    }
    return { success: true, output: `${pre}${res.output}${submit ? ' Pressed Enter.' : ''}` }
  }, { point, what: `Typed ${JSON.stringify(text.length > 40 ? `${text.slice(0, 39)}…` : text)}`, signal })
}

async function mobileKey(args, signal) {
  const r = await target(args)
  if (r.error) return r.error
  const t = r.target
  const key = str(args?.key)
  if (!key) return invalid('key is required (e.g. enter, backspace, tab, cmd+a, back on Android)')
  return act(t, 'mobile_key', args, () => backend(t).pressKey(t.id, key, { signal }), { point: null, what: `Pressed ${key}`, signal })
}

async function mobileButton(args, signal) {
  const r = await target(args)
  if (r.error) return r.error
  const t = r.target
  const name = str(args?.button)
  if (!name) return invalid('button is required (home, lock, siri, side on iOS; home, back, app_switch, power, volume_up/down on Android)')
  return act(t, 'mobile_button', args, () => backend(t).button(t.id, name, { signal }), { point: null, what: `Pressed the ${name} button`, signal })
}

const BATCH_TOOLS = new Set(['mobile_tap', 'mobile_long_press', 'mobile_swipe', 'mobile_drag', 'mobile_type', 'mobile_key', 'mobile_button', 'mobile_wait_for'])

async function mobileBatch(args, signal) {
  const steps = Array.isArray(args?.steps) ? args.steps : null
  if (!steps || !steps.length) return invalid('steps is required: an array of {tool, args}')
  if (steps.length > 20) return invalid('at most 20 steps per batch')
  const stopOnError = bool(args?.stop_on_error, true)
  const results = []
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] ?? {}
    const tool = str(s.tool)
    if (!BATCH_TOOLS.has(tool)) return invalid(`step ${i + 1}: ${tool || '(missing tool)'} is not batchable`, `use ${[...BATCH_TOOLS].join(', ')}`)
    const stepArgs = { ...(s.args ?? {}), device: str(args?.device) || s.args?.device, settle_ms: s.args?.settle_ms ?? 250 }
    const res = await handlers[tool](stepArgs, signal)
    const line = `${i + 1}. ${tool}: ${res.success ? res.output.split('\n')[0].slice(0, 160) : `FAILED — ${res.error}`}`
    results.push(line)
    if (!res.success && stopOnError) return { success: false, error: `batch stopped at step ${i + 1}: ${res.error}`, output: results.join('\n'), retryable: false }
  }
  return { success: true, output: `Batch of ${steps.length} steps done:\n${results.join('\n')}\nNext: mobile_snapshot or mobile_screenshot to verify the end state.` }
}

// ─── Indicator ────────────────────────────────────────────────────────────

async function mobileIndicatorOn(args) {
  const r = await target(args)
  if (r.error) return r.error
  const t = r.target
  if (!electron?.BrowserWindow) {
    indicator.setIndicatorUnavailable(true)
    return { success: false, error: 'Driving indicator unavailable (not running inside Electron). Continue the task and tell the user the indicator could not be shown.', retryable: false }
  }
  const g = await geometryFor(t)
  const mapping = t.platform === 'ios' ? await ios.windowMapping(t.id) : null
  let shown = await indicator.indicatorShow(t, { geometry: g, mapping })
  if (!shown.shown && t.platform === 'ios') {
    // The device may be booted headless: bring its window up once, then retry.
    const { showSimulatorWindow } = await import('./devices.mjs')
    await showSimulatorWindow(t.id)
    await new Promise((res) => setTimeout(res, 2500))
    shown = await indicator.indicatorShow(t, { geometry: g, mapping })
  }
  if (!shown.shown) {
    indicator.setIndicatorUnavailable(true)
    return { success: false, error: `Driving indicator could not be shown for ${t.name}: ${shown.note ?? 'window not found'}. Continue the task and tell the user the indicator is unavailable.`, retryable: false }
  }
  indicator.setIndicatorUnavailable(false)
  setActive(getConversationId(), { platform: t.platform, id: t.id, name: t.name })
  const b = shown.where
  return {
    success: true,
    output: `Driving indicator ON over ${describeTarget(t)} — a blue frame around its window at ${b.x},${b.y} ${b.width}x${b.height} and the notice "Wolffish is driving ${t.name}". Every touch shows a ripple there. Take it down with ${INDICATOR_OFF_TOOL} as the LAST action of this session, whether you finished, gave up or are handing back.${shown.note ? ` (${shown.note})` : ''}`
  }
}

async function mobileIndicatorOff() {
  const was = indicator.indicatorOn()
  indicator.indicatorHide()
  indicator.setIndicatorUnavailable(false)
  return { success: true, output: was ? 'Driving indicator OFF.' : 'Driving indicator was already off.' }
}

// ─── Environment ──────────────────────────────────────────────────────────

async function mobileLocation(args) {
  const r = await target(args)
  if (r.error) return r.error
  const t = r.target
  if (bool(args?.clear)) return t.platform === 'ios' ? ios.clearLocation(t.id) : fail(CODES.UNSUPPORTED, 'Android has no "clear location"', 'set another fix instead')
  const lat = num(args?.latitude)
  const lng = num(args?.longitude)
  if (lat == null || lng == null) return invalid('latitude and longitude are required (or clear=true on iOS)')
  return backend(t).setLocation(t.id, lat, lng)
}

async function mobilePush(args) {
  const r = await target(args)
  if (r.error) return r.error
  if (r.target.platform !== 'ios') return android.pushUnsupported()
  const id = str(args?.bundle_id) || session(r.target).lastApp
  if (!id) return invalid('bundle_id is required')
  return ios.push(r.target.id, id, args?.payload)
}

async function mobilePrivacy(args) {
  const r = await target(args)
  if (r.error) return r.error
  const action = str(args?.action)
  const service = str(args?.service)
  if (!action || !service) return invalid('action (grant|revoke|reset) and service are required')
  return backend(r.target).privacy(r.target.id, action, service, str(args?.bundle_id) || session(r.target).lastApp || undefined)
}

async function mobileAppearance(args) {
  const r = await target(args)
  if (r.error) return r.error
  const res = await backend(r.target).appearance(r.target.id, str(args?.mode))
  if (res.success) snap.clearSnapshot(frameKey(r.target))
  return res
}

async function mobileStatusBar(args) {
  const r = await target(args)
  if (r.error) return r.error
  return backend(r.target).statusBar(r.target.id, { clear: bool(args?.clear), time: str(args?.time) || undefined, battery: num(args?.battery) ?? undefined, wifi: num(args?.wifi) ?? undefined, cellular: num(args?.cellular) ?? undefined })
}

async function mobileOrientation(args) {
  const r = await target(args)
  if (r.error) return r.error
  const t = r.target
  if (t.platform === 'ios') return fail(CODES.UNSUPPORTED, 'the iOS Simulator has no command-line rotation', 'rotate with computer-use on the Simulator window (Cmd+Left/Right arrow) or design the check for portrait')
  const res = await android.orientation(t.id, str(args?.mode))
  if (res.success) {
    frames.clearFrame(frameKey(t))
    snap.clearSnapshot(frameKey(t))
  }
  return res
}

// ─── Evidence ─────────────────────────────────────────────────────────────

async function mobileLog(args) {
  const r = await target(args)
  if (r.error) return r.error
  const t = r.target
  const app = str(args?.bundle_id) || session(t).lastApp || undefined
  const lines = Math.max(10, Math.min(2000, num(args?.lines) ?? 200))
  const seconds = Math.max(5, Math.min(3600, num(args?.seconds) ?? 60))
  return backend(t).readLog(t.id, { app, lines, seconds, filter: str(args?.filter) || undefined })
}

async function mobileRecord(args) {
  const r = await target(args)
  if (r.error) return r.error
  const action = str(args?.action)
  if (action === 'start') return backend(r.target).recordStart(r.target.id)
  if (action === 'stop') return backend(r.target).recordStop(r.target.id)
  return invalid('action must be start or stop')
}

// ─── Health ───────────────────────────────────────────────────────────────

async function mobileDoctor() {
  const lines = []
  const ok = (s) => lines.push(`✓ ${s}`)
  const bad = (s, fix) => lines.push(`✗ ${s}${fix ? ` — ${fix}` : ''}`)
  lines.push(`Host: ${process.platform} ${process.arch}`)
  if (process.platform === 'darwin') {
    const sel = await run('xcode-select', ['-p'], { timeout: 10_000 })
    if (sel.code === 0) ok(`Xcode at ${sel.out.trim()}`)
    else bad('Xcode command line tools not selected', 'install Xcode, then: sudo xcode-select -s /Applications/Xcode.app')
    const xb = await run('xcodebuild', ['-version'], { timeout: 20_000 })
    if (xb.code === 0) ok(xb.out.trim().split('\n').join(' '))
    else bad('xcodebuild not usable', 'open Xcode once to accept the license')
    const rt = await run('xcrun', ['simctl', 'list', 'runtimes', '--json'], { timeout: 20_000 })
    try {
      const n = JSON.parse(rt.out).runtimes.filter((x) => x.isAvailable).length
      n ? ok(`${n} simulator runtimes installed`) : bad('no simulator runtime', 'Xcode › Settings › Components › install an iOS runtime')
    } catch {
      bad('could not list simulator runtimes')
    }
    const bin = await resolveAxe({ fresh: true })
    if (bin) {
      const v = await axeVersion(bin)
      if (v === AXE_VERSION) ok(`AXe ${v} (${bin.source}) — iOS input and accessibility tree`)
      else lines.push(`△ AXe ${v ?? 'unknown'} from ${bin.source} (pinned ${AXE_VERSION}) — axe_install installs the pinned version`)
    } else bad('AXe not installed — no iOS taps or accessibility tree', 'call axe_install (managed download, no root)')
    const swiftc = await run('xcrun', ['--find', 'swiftc'], { timeout: 10_000 })
    swiftc.code === 0 ? ok('swiftc available (window locator compiles on first use)') : lines.push('△ swiftc missing — the indicator locates windows through System Events (needs Accessibility)')
    if (electron?.systemPreferences) {
      try {
        const trusted = electron.systemPreferences.isTrustedAccessibilityClient(false)
        trusted ? ok('Accessibility granted (window titles via System Events)') : lines.push('△ Accessibility not granted — fallback window lookup unavailable (System Settings › Privacy & Security › Accessibility)')
        const screen = electron.systemPreferences.getMediaAccessStatus('screen')
        screen === 'granted' ? ok('Screen Recording granted (window titles via CGWindowList)') : lines.push('△ Screen Recording not granted — Simulator windows are matched by owner only')
      } catch {
        // not available
      }
    }
  } else lines.push('△ iOS Simulator needs macOS; Android only on this host')
  const adbBin = await resolveBinary('adb')
  if (adbBin) {
    const v = await run(adbBin, ['version'], { timeout: 10_000 })
    ok(`adb at ${adbBin} (${v.out.split('\n')[0]?.trim() ?? ''})`)
  } else bad('adb not found', `install Android platform-tools; looked in ${androidSdkRoots().join(', ')} and PATH`)
  const emu = await resolveBinary('emulator')
  if (emu) {
    const { avds, error } = await listAvds()
    error ? bad(error) : avds.length ? ok(`emulator at ${emu}; AVDs: ${avds.join(', ')}`) : lines.push(`△ emulator found but no AVDs — create one in Android Studio › Device Manager`)
  } else lines.push('△ Android emulator not found (only plugged-in devices will work)')
  try {
    await import('sharp')
    ok('image pipeline (sharp) loaded')
  } catch (e) {
    bad(`sharp failed to load: ${e?.message ?? e}`, 'the capability reinstalls its dependency on next launch')
  }
  const helpers = await listHelpers()
  if (helpers.length) lines.push(`ℹ ${helpers.length} helper process(es) tracked: ${helpers.map((h) => `${h.kind}:${h.pid}`).join(', ')}`)
  const win = await listWindows({ owners: process.platform === 'darwin' ? ['Simulator'] : [] })
  lines.push(`ℹ window locator: ${win.via}${win.note ? ` (${win.note})` : ''}`)
  return { success: true, output: lines.join('\n') }
}

async function mobilePlaybook() {
  try {
    return { success: true, output: await readFile(path.join(HERE, 'playbook.md'), 'utf8') }
  } catch (e) {
    return infra(`playbook unavailable: ${e?.message ?? e}`, { retryable: false })
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────

const handlers = {
  mobile_devices: mobileDevices,
  mobile_use: mobileUse,
  mobile_boot: mobileBoot,
  mobile_shutdown: mobileShutdown,
  mobile_erase: mobileErase,
  mobile_apps: mobileApps,
  mobile_install: mobileInstall,
  mobile_uninstall: mobileUninstall,
  mobile_launch: mobileLaunch,
  mobile_terminate: mobileTerminate,
  mobile_open_url: mobileOpenUrl,
  mobile_screenshot: mobileScreenshot,
  mobile_zoom: mobileZoom,
  mobile_snapshot: mobileSnapshot,
  mobile_wait_for: mobileWaitFor,
  mobile_tap: mobileTap,
  mobile_long_press: mobileLongPress,
  mobile_swipe: mobileSwipe,
  mobile_drag: mobileDrag,
  mobile_type: mobileType,
  mobile_key: mobileKey,
  mobile_button: mobileButton,
  mobile_batch: mobileBatch,
  mobile_indicator_on: mobileIndicatorOn,
  mobile_indicator_off: mobileIndicatorOff,
  mobile_location: mobileLocation,
  mobile_push: mobilePush,
  mobile_privacy: mobilePrivacy,
  mobile_appearance: mobileAppearance,
  mobile_status_bar: mobileStatusBar,
  mobile_orientation: mobileOrientation,
  mobile_log: mobileLog,
  mobile_record: mobileRecord,
  mobile_doctor: mobileDoctor,
  mobile_playbook: mobilePlaybook,
  axe_check: axeCheck,
  axe_install: (args, signal) => axeInstall(args, signal)
}

const READ_ONLY = new Set(['mobile_devices', 'mobile_use', 'mobile_apps', 'mobile_screenshot', 'mobile_zoom', 'mobile_snapshot', 'mobile_wait_for', 'mobile_log', 'mobile_doctor', 'mobile_playbook', 'axe_check', 'mobile_indicator_on', 'mobile_indicator_off'])

const plugin = {
  name: 'mobile-simulators',
  tools: Object.keys(handlers).map((name) => ({ name, description: name, parameters: { type: 'object', properties: {} } })),
  async init(context) {
    workspaceRoot = context?.workspaceRoot ?? workspaceRoot
    if (typeof context?.getCurrentConversationId === 'function') getConversationId = context.getCurrentConversationId
    if (workspaceRoot) {
      frames.initFrames(workspaceRoot)
      initHelpers(workspaceRoot)
      refreshLocale()
      sweepHelpers().then((r) => {
        if (r.stopped || r.dropped) log(`[mobile] helper sweep: stopped ${r.stopped} orphan(s), dropped ${r.dropped} stale record(s)`)
      }).catch(() => {})
    }
    try {
      electron = await import('electron')
      indicator.initIndicator({
        electron,
        locale: () => {
          refreshLocale()
          return appLocale
        },
        logger: log
      })
      try {
        electron.app?.on?.('before-quit', () => indicator.destroyIndicator())
      } catch {
        // not in Electron
      }
    } catch {
      electron = null
    }
  },
  async destroy() {
    indicator.destroyIndicator()
    await stopOwnedHelpers().catch(() => {})
  },
  isReadOnlyCall(toolName) {
    return READ_ONLY.has(toolName)
  },
  describeAction(toolName, args) {
    const dev = args?.device ? ` on ${args.device}` : ''
    const labels = {
      mobile_boot: `Boot ${args?.device ?? 'a simulator'}`,
      mobile_shutdown: `Shut down${dev}`,
      mobile_erase: `Erase ${args?.device ?? 'the simulator'} to factory settings`,
      mobile_install: `Install ${args?.app ?? ''}${dev}`,
      mobile_uninstall: `Uninstall ${args?.bundle_id ?? ''}${dev}`,
      mobile_launch: `Launch ${args?.bundle_id ?? ''}${dev}`,
      mobile_terminate: `Stop ${args?.bundle_id ?? ''}${dev}`,
      mobile_open_url: `Open ${args?.url ?? ''}${dev}`,
      mobile_tap: `Tap ${args?.ref ? `element ${args.ref}` : `(${args?.x}, ${args?.y})`}${dev}`,
      mobile_long_press: `Long-press ${args?.ref ? `element ${args.ref}` : `(${args?.x}, ${args?.y})`}${dev}`,
      mobile_swipe: `Swipe ${args?.direction ?? ''}${dev}`,
      mobile_drag: `Drag${dev}`,
      mobile_type: `Type ${JSON.stringify(String(args?.text ?? '').slice(0, 60))}${dev}`,
      mobile_key: `Press ${args?.key ?? ''}${dev}`,
      mobile_button: `Press the ${args?.button ?? ''} button${dev}`,
      mobile_batch: `Run ${Array.isArray(args?.steps) ? args.steps.length : 0} touch steps${dev}`,
      mobile_record: `${args?.action === 'stop' ? 'Stop' : 'Start'} screen recording${dev}`,
      mobile_privacy: `${args?.action ?? ''} ${args?.service ?? ''} permission${dev}`,
      mobile_push: `Send a test push to ${args?.bundle_id ?? ''}${dev}`,
      axe_install: `Download AXe ${AXE_VERSION} (iOS input backend) into ~/.wolffish/bin`
    }
    const risk = toolName === 'mobile_erase' || toolName === 'mobile_uninstall' ? 'medium' : 'low'
    return labels[toolName] ? { title: 'Mobile device', description: labels[toolName], risk } : null
  },
  async execute(toolName, args, signal) {
    const fn = handlers[toolName]
    if (!fn) return { success: false, error: `mobile-simulators: unknown tool ${toolName}`, retryable: false }
    const blocked = gate(toolName)
    if (blocked) return blocked
    try {
      return await fn(args ?? {}, signal)
    } catch (err) {
      return { success: false, error: `${toolName}: ${err?.message ?? String(err)}` }
    }
  }
}

export default plugin
export { isUuid, axe, axeUnavailableError }
