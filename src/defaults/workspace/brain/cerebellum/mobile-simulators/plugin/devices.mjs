// Devices: one registry for iOS simulators and Android emulators/devices,
// a per-conversation "active device", and the boot state machines.
//
// Resolution order for every tool's optional `device`: an explicit udid,
// serial or name; else the conversation's active device; else the single
// booted/online device; else a typed NO_DEVICE that lists what exists.
import { readdir } from 'node:fs/promises'
import { openSync, closeSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { adb, isUuid, resolveBinary, run, simctl, spawnDetached } from './exec.mjs'
import { CODES, fail, infra, stderrOf } from './errors.mjs'
import { registerHelper, listHelpers, stopHelper } from './helpers.mjs'
import { filesDir } from './frames.mjs'

const active = new Map()
let simCache = { at: 0, devices: [] }
const SIM_CACHE_MS = 1500

export function setActive(convId, target) {
  active.set(convId ?? 'default', target)
}
export function getActive(convId) {
  return active.get(convId ?? 'default') ?? null
}
export function __resetDevices() {
  active.clear()
  simCache = { at: 0, devices: [] }
}

// ─── iOS ──────────────────────────────────────────────────────────────────

export async function listSimulators({ fresh = false } = {}) {
  if (!fresh && Date.now() - simCache.at < SIM_CACHE_MS) return simCache
  const xcrun = await resolveBinary('xcrun')
  if (!xcrun) return { error: 'Xcode command line tools not found (xcrun missing)', devices: [], at: Date.now() }
  const r = await simctl(['list', 'devices', '--json'], { timeout: 20_000 })
  if (r.code !== 0) return { error: `simctl list failed: ${stderrOf(r)}`, devices: [], at: Date.now() }
  let json
  try {
    json = JSON.parse(r.out)
  } catch {
    return { error: 'could not parse simctl output', devices: [], at: Date.now() }
  }
  const devices = []
  for (const [runtime, list] of Object.entries(json.devices ?? {})) {
    for (const d of list) {
      if (d.isAvailable === false) continue
      devices.push({
        platform: 'ios',
        id: d.udid,
        name: d.name,
        state: d.state,
        runtime: runtime.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, '').replace(/-/g, '.'),
        deviceType: d.deviceTypeIdentifier ?? ''
      })
    }
  }
  devices.sort((a, b) => (a.state === 'Booted' ? -1 : b.state === 'Booted' ? 1 : a.name.localeCompare(b.name)))
  simCache = { at: Date.now(), devices }
  return simCache
}

async function simState(udid) {
  const { devices } = await listSimulators({ fresh: true })
  return devices.find((d) => d.id === udid) ?? null
}

async function waitSimState(udid, wanted, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const d = await simState(udid)
    if (d && wanted.includes(d.state)) return d
    await new Promise((r) => setTimeout(r, 750))
  }
  return null
}

/**
 * Boot state machine: Booted returns; Booting waits; Shutting Down waits
 * for Shutdown and boots; Shutdown boots. Exit 149 means already booted.
 */
export async function bootSimulator(udid, { headless = false, signal } = {}) {
  let d = await simState(udid)
  if (!d) return fail(CODES.DEVICE_NOT_FOUND, `no simulator with udid ${udid}`, 'call mobile_devices')
  if (d.state === 'Shutting Down') {
    d = (await waitSimState(udid, ['Shutdown'], 60_000)) ?? d
  }
  if (d.state === 'Shutdown' || d.state === 'Creating') {
    const r = await simctl(['boot', udid], { timeout: 90_000, signal })
    if (r.code !== 0 && r.code !== 149 && !/current state: Booted/i.test(r.err)) {
      return fail(CODES.BOOT_FAILED, `simctl boot failed: ${stderrOf(r)}`, 'check mobile_doctor, then retry mobile_boot')
    }
  }
  const bs = await simctl(['bootstatus', udid, '-b'], { timeout: 150_000, signal })
  if (bs.code !== 0) {
    const now = await simState(udid)
    if (now?.state !== 'Booted') return fail(CODES.BOOT_FAILED, `simulator did not finish booting: ${stderrOf(bs)}`, 'retry mobile_boot; if it repeats, mobile_shutdown then mobile_boot')
  }
  if (!headless) await showSimulatorWindow(udid)
  simCache.at = 0
  return { success: true, output: `Booted ${d.name} (${udid}).` }
}

export async function showSimulatorWindow(udid) {
  if (process.platform !== 'darwin') return
  await run('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', udid], { timeout: 15_000 })
}

export async function shutdownSimulator(udid) {
  const r = await simctl(['shutdown', udid], { timeout: 60_000 })
  simCache.at = 0
  if (r.code !== 0 && !/current state: Shutdown/i.test(r.err)) return infra(`simctl shutdown failed: ${stderrOf(r)}`)
  return { success: true, output: `Shut down ${udid}.` }
}

export async function eraseSimulator(udid) {
  const d = await simState(udid)
  if (d?.state === 'Booted') {
    const s = await shutdownSimulator(udid)
    if (!s.success) return s
  }
  const r = await simctl(['erase', udid], { timeout: 120_000 })
  simCache.at = 0
  if (r.code !== 0) return infra(`simctl erase failed: ${stderrOf(r)}`, { retryable: false })
  return { success: true, output: `Erased ${udid} to factory settings (shut down).` }
}

// ─── Android ──────────────────────────────────────────────────────────────

export async function listAndroid() {
  const bin = await resolveBinary('adb')
  if (!bin) return { error: 'adb not found (install Android platform-tools or set ANDROID_HOME)', devices: [] }
  const r = await adb(null, ['devices', '-l'], { timeout: 15_000 })
  if (r.code !== 0) return { error: `adb devices failed: ${stderrOf(r)}`, devices: [] }
  const devices = []
  for (const line of r.out.split('\n').slice(1)) {
    const t = line.trim()
    if (!t || t.startsWith('*')) continue
    const [serial, state, ...rest] = t.split(/\s+/)
    const props = Object.fromEntries(rest.map((kv) => kv.split(':')).filter((p) => p.length === 2))
    const isEmu = /^emulator-\d+$/.test(serial)
    let name = props.model ?? props.device ?? serial
    if (isEmu && state === 'device') {
      const a = await adb(serial, ['emu', 'avd', 'name'], { timeout: 5000 })
      const first = a.out.split('\n').map((l) => l.trim()).find((l) => l && l !== 'OK')
      if (first) name = first
    }
    devices.push({ platform: 'android', id: serial, name, state: state === 'device' ? 'Booted' : state, emulator: isEmu, model: props.model ?? '' })
  }
  return { devices }
}

export async function listAvds() {
  const bin = await resolveBinary('emulator')
  if (!bin) return { error: 'Android emulator not found (install the SDK emulator package or set ANDROID_HOME)', avds: [] }
  const r = await run(bin, ['-list-avds'], { timeout: 15_000 })
  if (r.code !== 0) return { error: `emulator -list-avds failed: ${stderrOf(r)}`, avds: [] }
  return { avds: r.out.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('INFO') && !l.startsWith('WARNING')) }
}

async function freeEmulatorPort() {
  const { devices } = await listAndroid()
  const used = new Set(devices.map((d) => Number((/^emulator-(\d+)$/.exec(d.id) ?? [])[1])).filter(Boolean))
  for (let p = 5554; p <= 5680; p += 2) if (!used.has(p)) return p
  return 5554
}

/**
 * Start an AVD and wait for `sys.boot_completed`. Returns the serial.
 * The emulator process is a tracked helper so it can be stopped later.
 */
export async function bootAvd(avdName, { coldBoot = false, headless = false, signal, timeoutMs = 240_000 } = {}) {
  const bin = await resolveBinary('emulator')
  if (!bin) return fail(CODES.TOOLCHAIN_MISSING, 'Android emulator binary not found', 'install the SDK emulator package or set ANDROID_HOME')
  const { avds } = await listAvds()
  if (!avds.includes(avdName)) return fail(CODES.DEVICE_NOT_FOUND, `no AVD named ${avdName}`, `available: ${avds.join(', ') || 'none — create one in Android Studio'}`)
  const port = await freeEmulatorPort()
  const serial = `emulator-${port}`
  const logDir = filesDir('logs')
  await mkdir(logDir, { recursive: true })
  const logFile = path.join(logDir, `emulator-${avdName}-${Date.now()}.log`)
  const fd = openSync(logFile, 'a')
  const args = ['-avd', avdName, '-port', String(port), '-no-boot-anim']
  if (coldBoot) args.push('-no-snapshot-load')
  if (headless) args.push('-no-window')
  const started = spawnDetached(bin, args, { logFd: fd })
  closeSync(fd)
  if (started.error) return infra(`could not start the emulator: ${started.error}`)
  await registerHelper({ kind: 'emulator', pid: started.pid, argv: [bin, ...args], signature: `-avd ${avdName}`, device: serial, file: logFile })
  const deadline = Date.now() + timeoutMs
  let seen = false
  while (Date.now() < deadline) {
    if (signal?.aborted) return infra('aborted', { retryable: false })
    const r = await adb(serial, ['shell', 'getprop', 'sys.boot_completed'], { timeout: 8000 })
    if (r.code === 0) seen = true
    if (r.out.trim() === '1') {
      const pm = await adb(serial, ['shell', 'pm', 'path', 'android'], { timeout: 8000 })
      if (pm.code === 0 && /package:/.test(pm.out)) {
        return { success: true, output: `Booted AVD ${avdName} as ${serial} in ${Math.round((timeoutMs - (deadline - Date.now())) / 1000)}s. Emulator log: ${logFile}`, serial }
      }
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  return fail(CODES.BOOT_FAILED, `emulator ${avdName} did not report boot_completed within ${Math.round(timeoutMs / 1000)}s${seen ? '' : ' (adb never saw it)'}`, `read ${logFile} for the emulator's own error; try mobile_boot again with cold_boot=true`)
}

export async function shutdownAndroid(serial) {
  const r = await adb(serial, ['emu', 'kill'], { timeout: 15_000 })
  const helpers = await listHelpers({ kind: 'emulator', device: serial })
  for (const h of helpers) await stopHelper(h, { graceMs: 4000 }).catch(() => {})
  if (r.code !== 0 && !/OK/.test(r.out)) return infra(`could not stop ${serial}: ${stderrOf(r)}`)
  return { success: true, output: `Stopped ${serial}.` }
}

// ─── Unified ──────────────────────────────────────────────────────────────

export async function listAll() {
  const [ios, android] = await Promise.all([process.platform === 'darwin' ? listSimulators({ fresh: true }) : Promise.resolve({ devices: [], error: 'iOS simulators need macOS' }), listAndroid()])
  const avds = process.platform === 'win32' || process.platform === 'linux' || process.platform === 'darwin' ? await listAvds() : { avds: [] }
  return { ios, android, avds }
}

function nameMatch(name, needle) {
  return String(name ?? '')
    .toLowerCase()
    .includes(needle)
}

/**
 * Resolve the target device for a tool call. Returns `{ target }` or a
 * failure result `{ error: <ToolExecutionResult> }`.
 */
export async function resolveTarget(deviceArg, convId, { needBooted = true } = {}) {
  const raw = typeof deviceArg === 'string' ? deviceArg.trim() : ''
  const { devices: sims } = process.platform === 'darwin' ? await listSimulators() : { devices: [] }
  const { devices: droids } = await listAndroid()
  const all = [...sims, ...droids]
  let target = null
  if (raw && raw !== 'booted') {
    target = all.find((d) => d.id === raw) ?? null
    if (!target) {
      const needle = raw.toLowerCase()
      const byName = all.filter((d) => nameMatch(d.name, needle))
      target = byName.find((d) => d.state === 'Booted') ?? byName[0] ?? null
    }
    if (!target && isUuid(raw)) return { error: fail(CODES.DEVICE_NOT_FOUND, `no simulator with udid ${raw}`, 'call mobile_devices for the list') }
    if (!target) return { error: fail(CODES.DEVICE_NOT_FOUND, `no device matches "${raw}"`, `call mobile_devices; names seen: ${all.slice(0, 8).map((d) => d.name).join(', ') || 'none'}`) }
  } else {
    const act = getActive(convId)
    if (act) {
      target = all.find((d) => d.id === act.id) ?? null
      if (!target) return { error: fail(CODES.DEVICE_NOT_FOUND, `the active device ${act.name} (${act.id}) is gone`, 'call mobile_devices and mobile_use again') }
    } else {
      const booted = all.filter((d) => d.state === 'Booted')
      if (booted.length === 1) target = booted[0]
      else if (booted.length > 1)
        return { error: fail(CODES.NO_DEVICE, `${booted.length} devices are booted: ${booted.map((d) => `${d.name} (${d.id})`).join(', ')}`, 'pick one with mobile_use device=<id or name> or pass device=') }
      else if (all.length === 1 && !needBooted) target = all[0]
      else
        return {
          error: fail(
            CODES.NO_DEVICE,
            all.length ? `no device is booted (${all.length} available)` : 'no simulator or Android device found',
            all.length ? 'call mobile_boot device=<name or udid>, or mobile_devices to choose' : 'call mobile_doctor'
          )
        }
    }
  }
  if (needBooted && target.state !== 'Booted') {
    return { error: fail(CODES.NOT_BOOTED, `${target.name} (${target.id}) is ${target.state}`, `call mobile_boot device=${target.id} first`) }
  }
  return { target }
}

export function describeTarget(t) {
  return `${t.name} (${t.platform === 'ios' ? 'iOS Simulator' : t.emulator ? 'Android emulator' : 'Android device'}, ${t.id})`
}
