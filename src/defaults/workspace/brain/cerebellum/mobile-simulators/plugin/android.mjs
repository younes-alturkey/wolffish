// Android backend: adb for everything. Emulators and plugged-in devices
// look the same here. The accessibility tree is `uiautomator dump`, input
// is `input tap|swipe|text|keyevent`, logs are a per-pid logcat helper
// started at launch, video is `screenrecord` pulled on stop.
//
// Units: everything is PIXELS in the screen's current orientation, so the
// pixel-per-unit ratio is 1 and the screencap size is the native size.
import { closeSync, openSync } from 'node:fs'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import { CODES, fail, infra, invalid, stderrOf } from './errors.mjs'
import { PACKAGE_RE, adb, resolveBinary, spawnDetached } from './exec.mjs'
import { filesDir, screenshotPath } from './frames.mjs'
import { listHelpers, registerHelper, stopHelper } from './helpers.mjs'

const geometryCache = new Map()

/** `{ native:{w,h}, unit:'px', pxPerUnit:1, density }`. Measured from a screencap. */
export async function geometry(serial, { fresh = false } = {}) {
  if (!fresh && geometryCache.has(serial)) return geometryCache.get(serial)
  const shot = await screenshotBuffer(serial)
  if (!shot.buffer) return null
  const { imageSize } = await import('./frames.mjs')
  const px = await imageSize(shot.buffer)
  const dens = await adb(serial, ['shell', 'wm', 'density'], { timeout: 8000 })
  const density = Number((/(\d+)/.exec(dens.out) ?? [])[1]) || 160
  const g = { native: { w: px.w, h: px.h }, unit: 'px', pxPerUnit: 1, pixels: px, density }
  geometryCache.set(serial, g)
  return g
}

export function forgetGeometry(serial) {
  geometryCache.delete(serial)
}

export async function screenshotBuffer(serial, { keep = false } = {}) {
  const r = await adb(serial, ['exec-out', 'screencap', '-p'], { timeout: 30_000, binary: true })
  if (r.code !== 0 || r.stdout.length < 100) return { error: `screencap failed: ${stderrOf(r, 'no image data')}` }
  let file = null
  if (keep) {
    file = await screenshotPath('android')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, r.stdout)
  }
  return { buffer: r.stdout, file }
}

/** uiautomator XML, with the "null root node" transient retried. */
export async function tree(serial, { signal } = {}) {
  let last = ''
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await adb(serial, ['exec-out', 'uiautomator', 'dump', '/dev/tty'], { timeout: 20_000, signal })
    last = r.out
    const i = r.out.indexOf('<?xml')
    if (r.code === 0 && i >= 0 && !/null root node/i.test(r.out)) return { xml: r.out.slice(i).replace(/UI hierchary dumped to:.*$/m, '') }
    if (signal?.aborted) break
    await new Promise((res) => setTimeout(res, 300))
  }
  if (/null root node/i.test(last)) return { error: infra('uiautomator could not read the screen (null root node) — the UI may be mid-transition; try again after mobile_wait_for settled', { retryable: false }) }
  return { error: infra(`uiautomator dump failed: ${last.trim().slice(-300) || 'no output'}`) }
}

function px(n) {
  return String(Math.round(n))
}

async function input(serial, args, { signal } = {}) {
  const r = await adb(serial, ['shell', 'input', ...args], { timeout: 30_000, signal })
  if (r.code !== 0 || /Error|Exception/.test(r.out)) return infra(`input ${args[0]} failed: ${stderrOf(r)}`, { retryable: false })
  return { success: true, output: r.out.trim() }
}

export function tap(serial, p, opts) {
  return input(serial, ['tap', px(p.x), px(p.y)], opts)
}

export function longPress(serial, p, { durationMs = 800, signal } = {}) {
  return input(serial, ['swipe', px(p.x), px(p.y), px(p.x), px(p.y), String(Math.round(durationMs))], { signal })
}

export function swipe(serial, from, to, { durationMs = 300, signal } = {}) {
  return input(serial, ['swipe', px(from.x), px(from.y), px(to.x), px(to.y), String(Math.round(durationMs))], { signal })
}

export async function drag(serial, from, to, { durationMs = 600, signal } = {}) {
  const r = await input(serial, ['draganddrop', px(from.x), px(from.y), px(to.x), px(to.y), String(Math.round(durationMs))], { signal })
  if (r.success) return r
  return input(serial, ['swipe', px(from.x), px(from.y), px(to.x), px(to.y), String(Math.round(Math.max(durationMs, 800)))], { signal })
}

export function isAscii(text) {
  return /^[\x20-\x7E\n\t]*$/.test(text)
}

const ADB_KEYBOARD_IME = 'com.android.adbkeyboard/.AdbIME'

/** ASCII via `input text`; non-ASCII through the ADB Keyboard IME when installed. */
export async function typeText(serial, text, { signal } = {}) {
  if (!text) return invalid('text is empty')
  if (isAscii(text) && !text.includes('\n')) {
    // `input text` takes one argument; spaces become %s and shell-special
    // characters are escaped for the device-side shell.
    const escaped = text.replace(/[\\'"`$&|;()<>{}[\]*?~!#]/g, (c) => `\\${c}`).replace(/ /g, '%s')
    const r = await input(serial, ['text', escaped], { signal })
    if (!r.success) return r
    return { success: true, output: `Typed ${text.length} characters.`, via: 'keys' }
  }
  const imes = await adb(serial, ['shell', 'ime', 'list', '-s'], { timeout: 8000 })
  if (!imes.out.includes(ADB_KEYBOARD_IME)) {
    return fail(
      CODES.CHARSET_UNSUPPORTED,
      'Android `input text` only types ASCII on one line',
      'for other scripts or newlines install the open-source ADB Keyboard IME (github.com/senzhk/ADBKeyBoard, APK "ADBKeyboard.apk") with mobile_install, then retry; or type the ASCII part and enter the rest by tapping the on-screen keyboard'
    )
  }
  const cur = await adb(serial, ['shell', 'settings', 'get', 'secure', 'default_input_method'], { timeout: 8000 })
  const previous = cur.out.trim()
  if (previous !== ADB_KEYBOARD_IME) await adb(serial, ['shell', 'ime', 'set', ADB_KEYBOARD_IME], { timeout: 8000 })
  const b64 = Buffer.from(text, 'utf8').toString('base64')
  const r = await adb(serial, ['shell', 'am', 'broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', b64], { timeout: 15_000, signal })
  if (previous && previous !== ADB_KEYBOARD_IME) await adb(serial, ['shell', 'ime', 'set', previous], { timeout: 8000 })
  if (r.code !== 0) return infra(`ADB Keyboard broadcast failed: ${stderrOf(r)}`, { retryable: false })
  return { success: true, output: `Typed ${text.length} characters through ADB Keyboard.`, via: 'ime' }
}

const KEYS = {
  enter: 'ENTER', return: 'ENTER', tab: 'TAB', space: 'SPACE', backspace: 'DEL', delete: 'FORWARD_DEL', del: 'DEL', escape: 'ESCAPE', esc: 'ESCAPE',
  back: 'BACK', home: 'HOME', menu: 'MENU', app_switch: 'APP_SWITCH', recents: 'APP_SWITCH', power: 'POWER', search: 'SEARCH',
  up: 'DPAD_UP', down: 'DPAD_DOWN', left: 'DPAD_LEFT', right: 'DPAD_RIGHT', center: 'DPAD_CENTER',
  volume_up: 'VOLUME_UP', volume_down: 'VOLUME_DOWN', mute: 'VOLUME_MUTE', camera: 'CAMERA', pageup: 'PAGE_UP', pagedown: 'PAGE_DOWN',
  move_home: 'MOVE_HOME', move_end: 'MOVE_END', paste: 'PASTE', copy: 'COPY', cut: 'CUT'
}

export function pressKey(serial, spec, { signal } = {}) {
  const parts = String(spec).toLowerCase().split('+').map((s) => s.trim()).filter(Boolean)
  const last = parts[parts.length - 1]
  const meta = []
  for (const m of parts.slice(0, -1)) {
    if (m === 'ctrl' || m === 'control') meta.push('--meta', '4096')
    else if (m === 'shift') meta.push('--meta', '1')
    else if (m === 'alt') meta.push('--meta', '2')
    else return Promise.resolve(invalid(`unknown modifier "${m}"`, 'use ctrl, shift or alt'))
  }
  let code = KEYS[last]
  if (!code && /^[a-z]$/.test(last)) code = last.toUpperCase()
  if (!code && /^[0-9]$/.test(last)) code = last
  if (!code && /^keycode_/.test(last)) code = last.toUpperCase().replace(/^KEYCODE_/, '')
  if (!code) return Promise.resolve(invalid(`unknown key "${last}"`, `use a letter, a digit, a KEYCODE_* name, or one of: ${Object.keys(KEYS).join(', ')}`))
  return input(serial, ['keyevent', ...meta, `KEYCODE_${code}`], { signal })
}

const BUTTONS = { home: 'HOME', back: 'BACK', app_switch: 'APP_SWITCH', recents: 'APP_SWITCH', power: 'POWER', lock: 'POWER', volume_up: 'VOLUME_UP', volume_down: 'VOLUME_DOWN', menu: 'MENU' }

export function button(serial, name, opts) {
  const b = BUTTONS[String(name).toLowerCase()]
  if (!b) return Promise.resolve(invalid(`unknown Android button "${name}"`, `use ${Object.keys(BUTTONS).join(', ')}`))
  return input(serial, ['keyevent', `KEYCODE_${b}`], opts)
}

// ─── Apps ─────────────────────────────────────────────────────────────────

export async function listApps(serial, { all = false } = {}) {
  const r = await adb(serial, ['shell', 'pm', 'list', 'packages', ...(all ? [] : ['-3'])], { timeout: 20_000 })
  if (r.code !== 0) return { error: stderrOf(r) }
  const apps = r.out
    .split('\n')
    .map((l) => l.trim().replace(/^package:/, ''))
    .filter(Boolean)
    .sort()
    .map((id) => ({ bundleId: id, name: id }))
  return { apps }
}

export async function isInstalled(serial, pkg) {
  const r = await adb(serial, ['shell', 'pm', 'path', pkg], { timeout: 10_000 })
  return r.code === 0 && /package:/.test(r.out)
}

export async function install(serial, apk) {
  try {
    const s = await stat(apk)
    if (!s.isFile() || !/\.apk$/i.test(apk)) return invalid(`${apk} is not an .apk file`)
  } catch {
    return invalid(`${apk} does not exist`)
  }
  const r = await adb(serial, ['install', '-r', '-g', apk], { timeout: 300_000 })
  if (r.code !== 0 || /Failure/i.test(r.out)) return infra(`install failed: ${stderrOf(r)}`, { retryable: false })
  return { success: true, output: `Installed ${path.basename(apk)} (runtime permissions granted).` }
}

export async function uninstall(serial, pkg) {
  const r = await adb(serial, ['uninstall', pkg], { timeout: 60_000 })
  if (r.code !== 0 || /Failure/i.test(r.out)) return infra(`uninstall failed: ${stderrOf(r)}`, { retryable: false })
  return { success: true, output: `Uninstalled ${pkg}.` }
}

async function stopAppHelpers(serial, pkg) {
  for (const h of await listHelpers({ kind: 'logcat', device: serial, app: pkg })) await stopHelper(h).catch(() => {})
}

async function pidOf(serial, pkg) {
  for (let i = 0; i < 12; i++) {
    const r = await adb(serial, ['shell', 'pidof', pkg], { timeout: 8000 })
    const pid = Number(r.out.trim().split(/\s+/)[0])
    if (pid) return pid
    await new Promise((res) => setTimeout(res, 300))
  }
  return null
}

/** Launch the launcher activity and start a per-pid logcat helper into a file. */
export async function launch(serial, pkg, { logs = true } = {}) {
  if (!PACKAGE_RE.test(pkg)) return invalid(`"${pkg}" is not a package name`)
  if (!(await isInstalled(serial, pkg))) return fail(CODES.APP_NOT_INSTALLED, `${pkg} is not installed on this device`, 'call mobile_install apk=<path> first')
  await stopAppHelpers(serial, pkg)
  await adb(serial, ['shell', 'am', 'force-stop', pkg], { timeout: 15_000 })
  const r = await adb(serial, ['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'], { timeout: 30_000 })
  if (r.code !== 0 || /No activities found|Error/.test(r.out)) return infra(`launch failed for ${pkg}: ${stderrOf(r)}`, { retryable: false })
  const pid = await pidOf(serial, pkg)
  let logFile = null
  if (logs && pid) {
    const dir = filesDir('logs')
    await mkdir(dir, { recursive: true })
    logFile = path.join(dir, `${pkg}-logcat-${Date.now()}.log`)
    const fd = openSync(logFile, 'a')
    const bin = (await resolveBinary('adb')) ?? 'adb'
    const started = spawnDetached(bin, ['-s', serial, 'logcat', '-v', 'time', `--pid=${pid}`], { logFd: fd })
    closeSync(fd)
    if (!started.error) await registerHelper({ kind: 'logcat', pid: started.pid, argv: ['adb', '-s', serial, 'logcat'], signature: `--pid=${pid}`, device: serial, app: pkg, file: logFile })
  }
  return { success: true, output: `Launched ${pkg}${pid ? ` (pid ${pid})` : ''}.${logFile ? `\nlogcat: ${logFile}` : ''}`, pid, logFile }
}

export async function terminate(serial, pkg) {
  await stopAppHelpers(serial, pkg)
  const r = await adb(serial, ['shell', 'am', 'force-stop', pkg], { timeout: 15_000 })
  if (r.code !== 0) return infra(`force-stop failed: ${stderrOf(r)}`, { retryable: false })
  return { success: true, output: `Stopped ${pkg}.` }
}

export async function openUrl(serial, url) {
  const r = await adb(serial, ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url], { timeout: 30_000 })
  if (r.code !== 0 || /Error/.test(r.out)) return infra(`could not open ${url}: ${stderrOf(r)}`, { retryable: false })
  return { success: true, output: `Opened ${url}.` }
}

export async function readLog(serial, { app, lines = 200, filter } = {}) {
  const helpers = await listHelpers({ kind: 'logcat', device: serial, app })
  const parts = []
  for (const h of helpers) {
    try {
      const all = (await readFile(h.file, 'utf8')).split('\n')
      const kept = (filter ? all.filter((l) => l.includes(filter)) : all).slice(-lines)
      if (kept.join('').trim()) parts.push(`── logcat for ${h.app} (${path.basename(h.file)}, last ${kept.length} lines)\n${kept.join('\n').trim()}`)
    } catch {
      // gone
    }
  }
  if (parts.length) return { success: true, output: parts.join('\n\n') }
  const r = await adb(serial, ['logcat', '-d', '-v', 'time', '-t', String(Math.min(5000, lines * 4))], { timeout: 30_000 })
  if (r.code !== 0) return infra(`logcat failed: ${stderrOf(r)}`)
  const all = r.out.split('\n')
  const needle = filter ?? app
  const kept = (needle ? all.filter((l) => l.includes(needle)) : all).slice(-lines).join('\n').trim()
  return { success: true, output: kept || `No log lines${needle ? ` matching "${needle}"` : ''} (launch with mobile_launch to capture the app's logcat live).` }
}

// ─── Video ────────────────────────────────────────────────────────────────

export async function recordStart(serial, { timeLimit = 180 } = {}) {
  const active = await listHelpers({ kind: 'record', device: serial })
  if (active.length) return fail(CODES.RECORDING_ACTIVE, 'a recording is already running', 'call mobile_record action=stop first')
  const remote = `/sdcard/wolffish-rec-${Date.now()}.mp4`
  const bin = (await resolveBinary('adb')) ?? 'adb'
  const started = spawnDetached(bin, ['-s', serial, 'shell', 'screenrecord', '--time-limit', String(Math.min(180, timeLimit)), remote], {})
  if (started.error) return infra(`could not start screenrecord: ${started.error}`)
  await registerHelper({ kind: 'record', pid: started.pid, argv: ['adb', 'shell', 'screenrecord'], signature: 'screenrecord', device: serial, file: remote })
  await new Promise((r) => setTimeout(r, 800))
  return { success: true, output: `Recording ${serial} (up to ${Math.min(180, timeLimit)}s). Call mobile_record action=stop to save the mp4.` }
}

export async function recordStop(serial) {
  const active = await listHelpers({ kind: 'record', device: serial })
  if (!active.length) return fail(CODES.NO_RECORDING, 'no recording is running on this device', 'call mobile_record action=start first')
  const h = active[active.length - 1]
  await adb(serial, ['shell', 'pkill', '-2', 'screenrecord'], { timeout: 8000 })
  await new Promise((r) => setTimeout(r, 2500))
  await stopHelper(h, { signal: 'SIGINT', graceMs: 3000 })
  const local = await screenshotPath('android-recording', 'mp4')
  const pull = await adb(serial, ['pull', h.file, local], { timeout: 120_000 })
  await adb(serial, ['shell', 'rm', '-f', h.file], { timeout: 8000 })
  if (pull.code !== 0) return infra(`could not pull the recording: ${stderrOf(pull)}`, { retryable: false })
  const s = await stat(local).catch(() => null)
  if (!s || s.size < 1024) return infra('the recording file is empty', { retryable: false })
  return { success: true, output: `Saved recording: ${local} (${Math.round(s.size / 1024)} KB). Deliver it with send_file when the user should see it.`, file: local }
}

// ─── Environment ──────────────────────────────────────────────────────────

export async function setLocation(serial, lat, lng) {
  const r = await adb(serial, ['emu', 'geo', 'fix', String(lng), String(lat)], { timeout: 10_000 })
  if (r.code !== 0 || !/OK/.test(r.out)) return fail(CODES.UNSUPPORTED, 'location can only be set on an emulator (adb emu geo fix)', 'use a mock-location app on a physical device')
  return { success: true, output: `Location set to ${lat},${lng}.` }
}

export async function privacy(serial, action, permission, pkg) {
  if (!['grant', 'revoke'].includes(action)) return invalid('action must be grant or revoke on Android')
  if (!pkg) return invalid('bundle_id (package) is required on Android')
  const perm = permission.includes('.') ? permission : `android.permission.${permission.toUpperCase()}`
  const r = await adb(serial, ['shell', 'pm', action, pkg, perm], { timeout: 15_000 })
  if (r.code !== 0 || /Exception|Error/.test(r.out)) return infra(`pm ${action} failed: ${stderrOf(r)}`, { retryable: false })
  return { success: true, output: `${action} ${perm} for ${pkg}.` }
}

export async function appearance(serial, mode) {
  if (!['light', 'dark'].includes(mode)) return invalid('mode must be light or dark')
  const r = await adb(serial, ['shell', 'cmd', 'uimode', 'night', mode === 'dark' ? 'yes' : 'no'], { timeout: 15_000 })
  if (r.code !== 0) return infra(`uimode failed: ${stderrOf(r)}`, { retryable: false })
  return { success: true, output: `Appearance set to ${mode}.` }
}

export async function statusBar(serial, { clear, time, battery } = {}) {
  if (clear) {
    await adb(serial, ['shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', 'exit'], { timeout: 10_000 })
    return { success: true, output: 'Status bar demo mode cleared.' }
  }
  await adb(serial, ['shell', 'settings', 'put', 'global', 'sysui_demo_allowed', '1'], { timeout: 10_000 })
  await adb(serial, ['shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', 'enter'], { timeout: 10_000 })
  if (time) {
    const hhmm = String(time).replace(':', '').padStart(4, '0')
    await adb(serial, ['shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', 'clock', '-e', 'hhmm', hhmm], { timeout: 10_000 })
  }
  if (battery != null) await adb(serial, ['shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', 'battery', '-e', 'level', String(battery), '-e', 'plugged', 'false'], { timeout: 10_000 })
  await adb(serial, ['shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', 'notifications', '-e', 'visible', 'false'], { timeout: 10_000 })
  return { success: true, output: 'Status bar in demo mode (clean screenshots).' }
}

export async function orientation(serial, mode) {
  const rot = { portrait: 0, landscape: 1, 'portrait-upside-down': 2, 'landscape-right': 3 }[mode]
  if (rot == null) return invalid('orientation must be portrait, landscape, portrait-upside-down or landscape-right')
  await adb(serial, ['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'], { timeout: 10_000 })
  const r = await adb(serial, ['shell', 'settings', 'put', 'system', 'user_rotation', String(rot)], { timeout: 10_000 })
  if (r.code !== 0) return infra(`rotation failed: ${stderrOf(r)}`, { retryable: false })
  geometryCache.delete(serial)
  return { success: true, output: `Orientation set to ${mode}.` }
}

export async function pushUnsupported() {
  return fail(CODES.UNSUPPORTED, 'simulated push notifications exist only on the iOS Simulator', 'on Android trigger the notification from the app or through Firebase')
}
