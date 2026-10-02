// iOS Simulator backend: simctl for lifecycle, screenshots, video, logs,
// URLs, pasteboard, location, push, privacy, appearance and status bar;
// AXe for the accessibility tree and every touch and key (see axe.mjs).
//
// Units: the tree, taps and swipes are in POINTS; simctl screenshots are
// framebuffer PIXELS. `geometry()` measures the ratio once per device so
// frames.mjs can translate; nothing here asks the model to.
import { closeSync, openSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { axe, axeUnavailableError } from './axe.mjs'
import { CODES, fail, infra, invalid, stderrOf } from './errors.mjs'
import { BUNDLE_ID_RE, resolveBinary, run, simctl, spawnDetached } from './exec.mjs'
import { filesDir, screenshotPath } from './frames.mjs'
import { listHelpers, registerHelper, stopHelper } from './helpers.mjs'

const geometryCache = new Map()

/** `{ native:{w,h}, unit:'pt', pxPerUnit }` for a booted simulator. */
export async function geometry(udid, { fresh = false } = {}) {
  if (!fresh && geometryCache.has(udid)) return geometryCache.get(udid)
  const shot = await screenshotBuffer(udid)
  let px = null
  if (shot.buffer) {
    const { imageSize } = await import('./frames.mjs')
    px = await imageSize(shot.buffer)
  }
  let pt = null
  const t = await axe(['describe-ui'], { udid, timeout: 20_000 })
  if (!t.unavailable && t.code === 0) {
    try {
      const root = JSON.parse(t.out)
      const r = Array.isArray(root) ? root[0] : root
      if (r?.frame?.width > 0 && r?.frame?.height > 0) pt = { w: r.frame.width, h: r.frame.height }
    } catch {
      // fall through to the heuristic
    }
  }
  let pxPerUnit
  if (pt && px) pxPerUnit = Math.max(1, Math.round(px.w / pt.w))
  else if (px) {
    // Without AXe: iPads and the SE line are 2x, every other iPhone since X is 3x.
    const { devices } = await (await import('./devices.mjs')).listSimulators()
    const d = devices.find((x) => x.id === udid)
    pxPerUnit = d && /iPad|SE/i.test(d.name) ? 2 : 3
    pt = { w: px.w / pxPerUnit, h: px.h / pxPerUnit }
  } else return null
  const g = { native: { w: pt.w, h: pt.h }, unit: 'pt', pxPerUnit, pixels: px ?? { w: pt.w * pxPerUnit, h: pt.h * pxPerUnit } }
  geometryCache.set(udid, g)
  return g
}

export function forgetGeometry(udid) {
  geometryCache.delete(udid)
}

/** Full-screen PNG. Returns `{ buffer, file }` (the file is kept under files/screenshots). */
export async function screenshotBuffer(udid, { keep = false } = {}) {
  const file = await screenshotPath('ios')
  const r = await simctl(['io', udid, 'screenshot', '--type', 'png', file], { timeout: 30_000 })
  if (r.code !== 0) return { error: `screenshot failed: ${stderrOf(r)}` }
  try {
    const buffer = await readFile(file)
    if (!keep) await rm(file, { force: true }).catch(() => {})
    return { buffer, file: keep ? file : null }
  } catch (e) {
    return { error: `screenshot file unreadable: ${e?.message ?? e}` }
  }
}

export async function tree(udid, { signal } = {}) {
  const r = await axe(['describe-ui'], { udid, timeout: 30_000, signal })
  if (r.unavailable) return { error: axeUnavailableError() }
  if (r.code !== 0) return { error: infra(`AXe describe-ui failed: ${stderrOf(r)}`) }
  try {
    return { tree: JSON.parse(r.out) }
  } catch {
    return { error: infra('AXe returned a tree that is not JSON') }
  }
}

function num(n) {
  return String(Math.round(n * 100) / 100)
}

async function axeAction(args, { udid, signal, timeout = 30_000 }) {
  const r = await axe(args, { udid, signal, timeout })
  if (r.unavailable) return axeUnavailableError()
  if (r.code !== 0) {
    const text = stderrOf(r)
    if (/not booted/i.test(text)) return fail(CODES.NOT_BOOTED, `simulator ${udid} is not booted`, `call mobile_boot device=${udid}`)
    if (/multiple|ambiguous/i.test(text)) return fail(CODES.TARGET_AMBIGUOUS, text, 'tap by ref or by coordinate instead')
    if (/no element|not found|could not find/i.test(text)) return fail(CODES.REF_NOT_FOUND, text, 'call mobile_snapshot and use a fresh ref')
    return infra(`AXe ${args[0]} failed: ${text}`, { retryable: false })
  }
  // AXe's own confirmation line ("Tap at … completed successfully") is
  // noise next to the proof the pipeline adds; keep the result quiet.
  return { success: true, output: '' }
}

export function tap(udid, p, { style, signal } = {}) {
  const args = ['tap', '-x', num(p.x), '-y', num(p.y)]
  if (style) args.push('--tap-style', style)
  return axeAction(args, { udid, signal })
}

export function tapSelector(udid, { id, label, value, type }, { signal } = {}) {
  const args = ['tap']
  if (id) args.push('--id', id)
  else if (label) args.push('--label', label)
  else if (value) args.push('--value', value)
  if (type) args.push('--element-type', type)
  return axeAction(args, { udid, signal })
}

export function longPress(udid, p, { durationMs = 800, signal } = {}) {
  return axeAction(['touch', '-x', num(p.x), '-y', num(p.y), '--down', '--up', '--delay', num(durationMs / 1000)], { udid, signal })
}

export function swipe(udid, from, to, { durationMs = 300, signal } = {}) {
  return axeAction(['swipe', '--start-x', num(from.x), '--start-y', num(from.y), '--end-x', num(to.x), '--end-y', num(to.y), '--duration', num(durationMs / 1000)], { udid, signal })
}

export function drag(udid, from, to, { durationMs = 600, signal } = {}) {
  return axeAction(['drag', '--start-x', num(from.x), '--start-y', num(from.y), '--end-x', num(to.x), '--end-y', num(to.y), '--duration', num(durationMs / 1000)], { udid, signal })
}

export function isAscii(text) {
  return /^[\x20-\x7E\n\t]*$/.test(text)
}

/** Type text: ASCII by HID keys; anything else via the simulator pasteboard and Cmd-V. */
export async function typeText(udid, text, { signal } = {}) {
  if (!text) return invalid('text is empty')
  if (isAscii(text)) {
    const r = await axe(['type', '--stdin'], { udid, signal, timeout: Math.max(30_000, text.length * 120), input: text })
    if (r.unavailable) return axeUnavailableError()
    if (r.code !== 0) return infra(`AXe type failed: ${stderrOf(r)}`, { retryable: false })
    return { success: true, output: `Typed ${text.length} characters.`, via: 'keys' }
  }
  // simctl decodes stdin in the process locale; pin UTF-8 so Arabic and
  // emoji land on the pasteboard as text, not Mac Roman mojibake.
  const pb = await simctl(['pbcopy', udid], { timeout: 15_000, input: text, env: { LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' } })
  if (pb.code !== 0) return infra(`could not put the text on the simulator pasteboard: ${stderrOf(pb)}`)
  const paste = await axeAction(['key-combo', '--modifiers', '227', '--key', '25'], { udid, signal })
  if (!paste.success) return paste
  return { success: true, output: `Pasted ${text.length} characters (non-ASCII text goes through the simulator pasteboard + Cmd-V).`, via: 'paste' }
}

// HID usage ids (keyboard page).
const HID = {
  enter: 40, return: 40, escape: 41, esc: 41, backspace: 42, delete: 42, del: 42, tab: 43, space: 44,
  right: 79, left: 80, down: 81, up: 82, home: 74, end: 77, pageup: 75, pagedown: 78,
  f1: 58, f2: 59, f3: 60, f4: 61, f5: 62, f6: 63, f7: 64, f8: 65, f9: 66, f10: 67, f11: 68, f12: 69
}
const MOD = { cmd: 227, command: 227, meta: 227, ctrl: 224, control: 224, shift: 225, alt: 226, option: 226 }

function letterCode(ch) {
  const c = ch.toLowerCase()
  if (/^[a-z]$/.test(c)) return 4 + (c.charCodeAt(0) - 97)
  if (/^[1-9]$/.test(c)) return 30 + (Number(c) - 1)
  if (c === '0') return 39
  return HID[c] ?? null
}

/** `key`: "enter", "backspace", "cmd+a", "shift+tab". */
export async function pressKey(udid, spec, { signal } = {}) {
  const parts = String(spec).toLowerCase().split('+').map((s) => s.trim()).filter(Boolean)
  if (!parts.length) return invalid('key is empty')
  const mods = parts.slice(0, -1).map((m) => MOD[m])
  if (mods.some((m) => !m)) return invalid(`unknown modifier in "${spec}"`, 'use cmd, ctrl, shift, alt')
  const code = letterCode(parts[parts.length - 1])
  if (code == null) return invalid(`unknown key "${parts[parts.length - 1]}"`, `use a letter, a digit, or one of: ${Object.keys(HID).join(', ')}`)
  if (mods.length) return axeAction(['key-combo', '--modifiers', mods.join(','), '--key', String(code)], { udid, signal })
  return axeAction(['key', String(code)], { udid, signal })
}

const BUTTONS = { home: 'home', lock: 'lock', power: 'lock', siri: 'siri', side: 'side-button', side_button: 'side-button', apple_pay: 'apple-pay' }

export function button(udid, name, { signal } = {}) {
  const b = BUTTONS[String(name).toLowerCase()]
  if (!b) return Promise.resolve(invalid(`unknown iOS button "${name}"`, 'use home, lock, siri, side or apple_pay'))
  return axeAction(['button', b], { udid, signal })
}

// ─── Apps ─────────────────────────────────────────────────────────────────

export async function appContainer(udid, bundle) {
  const r = await simctl(['get_app_container', udid, bundle, 'app'], { timeout: 15_000 })
  return r.code === 0 ? r.out.trim() : null
}

export async function listApps(udid) {
  const r = await simctl(['listapps', udid], { timeout: 20_000 })
  if (r.code !== 0) return { error: stderrOf(r) }
  const conv = await run('plutil', ['-convert', 'json', '-o', '-', '-'], { timeout: 15_000, input: r.out })
  if (conv.code !== 0) return { error: 'could not parse the app list' }
  try {
    const json = JSON.parse(conv.out)
    const apps = Object.entries(json).map(([id, v]) => ({ bundleId: id, name: v?.CFBundleDisplayName ?? v?.CFBundleName ?? id, type: v?.ApplicationType ?? '' }))
    return { apps }
  } catch {
    return { error: 'could not parse the app list' }
  }
}

export async function install(udid, appPath) {
  try {
    const s = await stat(appPath)
    if (!s.isDirectory()) return invalid(`${appPath} is not a .app bundle directory`)
  } catch {
    return invalid(`${appPath} does not exist`)
  }
  const r = await simctl(['install', udid, appPath], { timeout: 180_000 })
  if (r.code !== 0) return infra(`install failed: ${stderrOf(r)}`, { retryable: false })
  return { success: true, output: `Installed ${path.basename(appPath)}.` }
}

export async function uninstall(udid, bundle) {
  const r = await simctl(['uninstall', udid, bundle], { timeout: 60_000 })
  if (r.code !== 0) return infra(`uninstall failed: ${stderrOf(r)}`, { retryable: false })
  return { success: true, output: `Uninstalled ${bundle}.` }
}

async function stopAppHelpers(udid, bundle) {
  for (const kind of ['console', 'oslog']) {
    for (const h of await listHelpers({ kind, device: udid, app: bundle })) await stopHelper(h).catch(() => {})
  }
}

/**
 * Launch with logs: the app's stdout/stderr go to a file through a
 * console-pty launch, os_log lines through a detached `log stream`
 * helper. Both files are returned; `mobile_log` reads them.
 */
export async function launch(udid, bundle, { logs = true, args = [] } = {}) {
  if (!BUNDLE_ID_RE.test(bundle)) return invalid(`"${bundle}" is not a bundle id`)
  const container = await appContainer(udid, bundle)
  if (!container) return fail(CODES.APP_NOT_INSTALLED, `${bundle} is not installed on this simulator`, 'call mobile_install app=<path to .app> first (xcode_run does build+install+launch)')
  const appName = path.basename(container).replace(/\.app$/, '')
  await stopAppHelpers(udid, bundle)
  const xcrun = (await resolveBinary('xcrun')) ?? 'xcrun'
  const dir = filesDir('logs')
  await mkdir(dir, { recursive: true })
  const stamp = Date.now()
  let consoleFile = null
  let oslogFile = null
  if (logs) {
    consoleFile = path.join(dir, `${bundle}-console-${stamp}.log`)
    const fd = openSync(consoleFile, 'a')
    const started = spawnDetached(xcrun, ['simctl', 'launch', '--console-pty', '--terminate-running-process', udid, bundle, ...args], { logFd: fd })
    closeSync(fd)
    if (!started.error) await registerHelper({ kind: 'console', pid: started.pid, argv: ['simctl', 'launch', '--console-pty'], signature: `--console-pty`, device: udid, app: bundle, file: consoleFile })
    await new Promise((r) => setTimeout(r, 600))
  }
  // A plain launch is idempotent and reports the running pid.
  const r = await simctl(['launch', ...(logs ? [] : ['--terminate-running-process']), udid, bundle, ...(logs ? [] : args)], { timeout: 60_000 })
  if (r.code !== 0) return infra(`launch failed: ${stderrOf(r)}`, { retryable: false })
  const pid = Number((/:\s*(\d+)\s*$/.exec(r.out.trim()) ?? [])[1]) || null
  if (logs) {
    oslogFile = path.join(dir, `${bundle}-oslog-${stamp}.log`)
    const fd = openSync(oslogFile, 'a')
    const predicate = `subsystem == "${bundle}" OR process == "${appName}"`
    const started = spawnDetached(xcrun, ['simctl', 'spawn', udid, 'log', 'stream', '--level', 'debug', '--style', 'compact', '--predicate', predicate], { logFd: fd })
    closeSync(fd)
    if (!started.error) await registerHelper({ kind: 'oslog', pid: started.pid, argv: ['simctl', 'spawn', udid, 'log', 'stream'], signature: 'log stream', device: udid, app: bundle, file: oslogFile })
  }
  return { success: true, output: `Launched ${bundle}${pid ? ` (pid ${pid})` : ''}.${logs ? `\nConsole log: ${consoleFile}\nos_log: ${oslogFile}` : ''}`, pid, consoleFile, oslogFile, appName }
}

export async function terminate(udid, bundle) {
  await stopAppHelpers(udid, bundle)
  const r = await simctl(['terminate', udid, bundle], { timeout: 30_000 })
  if (r.code !== 0 && !/not running|found nothing|No matching/i.test(r.err + r.out)) return infra(`terminate failed: ${stderrOf(r)}`, { retryable: false })
  return { success: true, output: `Terminated ${bundle}.` }
}

export async function openUrl(udid, url) {
  const r = await simctl(['openurl', udid, url], { timeout: 30_000 })
  if (r.code !== 0) return infra(`openurl failed: ${stderrOf(r)}`, { retryable: false })
  return { success: true, output: `Opened ${url}.` }
}

/** Tail of the live log files for (device, app), or `log show` when there are none. */
export async function readLog(udid, { app, seconds = 60, lines = 200, filter } = {}) {
  const helpers = [...(await listHelpers({ kind: 'console', device: udid, app })), ...(await listHelpers({ kind: 'oslog', device: udid, app }))]
  const parts = []
  for (const h of helpers) {
    try {
      const text = await readFile(h.file, 'utf8')
      const all = text.split('\n')
      const kept = (filter ? all.filter((l) => l.includes(filter)) : all).slice(-lines)
      if (kept.join('').trim()) parts.push(`── ${h.kind === 'console' ? 'stdout/stderr' : 'os_log'} (${path.basename(h.file)}, last ${kept.length} lines)\n${kept.join('\n').trim()}`)
    } catch {
      // file gone
    }
  }
  if (parts.length) return { success: true, output: parts.join('\n\n') }
  const predicate = app ? `subsystem CONTAINS "${app}" OR process == "${app.split('.').pop()}"` : 'eventType == logEvent'
  const r = await simctl(['spawn', udid, 'log', 'show', '--last', `${Math.min(3600, seconds)}s`, '--style', 'compact', '--predicate', predicate], { timeout: 60_000 })
  if (r.code !== 0) return infra(`log show failed: ${stderrOf(r)}`)
  const all = r.out.split('\n')
  const kept = (filter ? all.filter((l) => l.includes(filter)) : all).slice(-lines).join('\n').trim()
  return { success: true, output: kept || `No log lines${app ? ` for ${app}` : ''} in the last ${seconds}s (launch with mobile_launch to capture stdout and os_log live).` }
}

// ─── Video ────────────────────────────────────────────────────────────────

export async function recordStart(udid) {
  const active = await listHelpers({ kind: 'record', device: udid })
  if (active.length) return fail(CODES.RECORDING_ACTIVE, `a recording is already running (${path.basename(active[0].file)})`, 'call mobile_record action=stop first')
  const file = await screenshotPath('ios-recording', 'mp4')
  const xcrun = (await resolveBinary('xcrun')) ?? 'xcrun'
  const logFile = `${file}.log`
  const fd = openSync(logFile, 'a')
  const started = spawnDetached(xcrun, ['simctl', 'io', udid, 'recordVideo', '--codec', 'h264', '-f', file], { logFd: fd })
  closeSync(fd)
  if (started.error) return infra(`could not start recording: ${started.error}`)
  await registerHelper({ kind: 'record', pid: started.pid, argv: ['simctl', 'io', udid, 'recordVideo'], signature: 'recordVideo', device: udid, file })
  await new Promise((r) => setTimeout(r, 800))
  return { success: true, output: `Recording ${udid} to ${file}. Call mobile_record action=stop to finish (the file is written on stop).` }
}

export async function recordStop(udid) {
  const active = await listHelpers({ kind: 'record', device: udid })
  if (!active.length) return fail(CODES.NO_RECORDING, 'no recording is running on this device', 'call mobile_record action=start first')
  const h = active[active.length - 1]
  await stopHelper(h, { signal: 'SIGINT', graceMs: 12_000 })
  await rm(`${h.file}.log`, { force: true }).catch(() => {})
  try {
    const s = await stat(h.file)
    if (s.size < 1024) return infra(`the recording file is empty (${s.size} bytes) — the simulator may have stopped before any frame was written`, { retryable: false })
    return { success: true, output: `Saved recording: ${h.file} (${Math.round(s.size / 1024)} KB). Deliver it with send_file when the user should see it.`, file: h.file }
  } catch {
    return infra('the recording file was not written', { retryable: false })
  }
}

// ─── Environment ──────────────────────────────────────────────────────────

export async function setLocation(udid, lat, lng) {
  const r = await simctl(['location', udid, 'set', `${lat},${lng}`], { timeout: 15_000 })
  if (r.code !== 0) return infra(`location set failed: ${stderrOf(r)}`, { retryable: false })
  return { success: true, output: `Location set to ${lat},${lng}.` }
}

export async function clearLocation(udid) {
  const r = await simctl(['location', udid, 'clear'], { timeout: 15_000 })
  if (r.code !== 0) return infra(`location clear failed: ${stderrOf(r)}`, { retryable: false })
  return { success: true, output: 'Simulated location cleared.' }
}

export async function push(udid, bundle, payload) {
  let obj = payload
  if (typeof payload === 'string') {
    try {
      obj = JSON.parse(payload)
    } catch {
      return invalid('payload must be a JSON object like {"aps":{"alert":"Hi"}}')
    }
  }
  if (!obj || typeof obj !== 'object' || !obj.aps) return invalid('payload must contain an "aps" object')
  const dir = filesDir('push')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `push-${Date.now()}.json`)
  await writeFile(file, JSON.stringify({ 'Simulator Target Bundle': bundle, ...obj }), 'utf8')
  const r = await simctl(['push', udid, bundle, file], { timeout: 15_000 })
  await rm(file, { force: true }).catch(() => {})
  if (r.code !== 0) return infra(`push failed: ${stderrOf(r)}`, { retryable: false })
  return { success: true, output: `Delivered a push notification to ${bundle}.` }
}

const PRIVACY = new Set(['all', 'calendar', 'contacts-limited', 'contacts', 'location', 'location-always', 'photos-add', 'photos', 'media-library', 'microphone', 'motion', 'reminders', 'siri'])

export async function privacy(udid, action, service, bundle) {
  if (!['grant', 'revoke', 'reset'].includes(action)) return invalid('action must be grant, revoke or reset')
  if (!PRIVACY.has(service)) return invalid(`unknown privacy service "${service}"`, `one of ${[...PRIVACY].join(', ')}`)
  const r = await simctl(['privacy', udid, action, service, ...(bundle ? [bundle] : [])], { timeout: 15_000 })
  if (r.code !== 0) return infra(`privacy ${action} failed: ${stderrOf(r)}`, { retryable: false })
  return { success: true, output: `${action} ${service}${bundle ? ` for ${bundle}` : ''}.` }
}

export async function appearance(udid, mode) {
  if (!['light', 'dark'].includes(mode)) return invalid('mode must be light or dark')
  const r = await simctl(['ui', udid, 'appearance', mode], { timeout: 15_000 })
  if (r.code !== 0) return infra(`appearance failed: ${stderrOf(r)}`, { retryable: false })
  return { success: true, output: `Appearance set to ${mode}.` }
}

export async function statusBar(udid, { clear, time, battery, wifi, cellular } = {}) {
  if (clear) {
    const r = await simctl(['status_bar', udid, 'clear'], { timeout: 15_000 })
    return r.code === 0 ? { success: true, output: 'Status bar overrides cleared.' } : infra(`status_bar clear failed: ${stderrOf(r)}`, { retryable: false })
  }
  const args = ['status_bar', udid, 'override']
  if (time) args.push('--time', String(time))
  if (battery != null) args.push('--batteryState', 'charged', '--batteryLevel', String(battery))
  if (wifi != null) args.push('--wifiBars', String(wifi), '--wifiMode', 'active')
  if (cellular != null) args.push('--cellularBars', String(cellular), '--cellularMode', 'active')
  if (args.length === 3) return invalid('nothing to override', 'pass time, battery, wifi or cellular, or clear=true')
  const r = await simctl(args, { timeout: 15_000 })
  if (r.code !== 0) return infra(`status_bar override failed: ${stderrOf(r)}`, { retryable: false })
  return { success: true, output: 'Status bar overridden (9:41-style screenshots).' }
}

/** `{ chrome, windowScale }` from Simulator.app preferences, for the indicator mapping. */
export async function windowMapping(udid) {
  const r = await run('defaults', ['export', 'com.apple.iphonesimulator', '-'], { timeout: 10_000, binary: true })
  if (r.code !== 0) return { chrome: true, windowScale: null }
  const conv = await run('plutil', ['-convert', 'json', '-o', '-', '-'], { timeout: 10_000, input: r.stdout })
  if (conv.code !== 0) return { chrome: true, windowScale: null }
  try {
    const json = JSON.parse(conv.out)
    const chrome = json.ShowChrome == null ? true : !!json.ShowChrome
    const geo = json.DevicePreferences?.[udid]?.SimulatorWindowGeometry ?? {}
    const first = Object.values(geo)[0]
    const scale = Number(first?.WindowScale)
    return { chrome, windowScale: Number.isFinite(scale) && scale > 0 ? scale : null }
  } catch {
    return { chrome: true, windowScale: null }
  }
}
