/**
 * LIVE end-to-end eval of the mobile-simulators + xcode capabilities under a
 * real Electron main process (the driving indicator is a BrowserWindow).
 *
 * Drives a booted iPhone simulator and, when an AVD is named, an Android
 * emulator: doctor, AXe install, device pick, indicator on (window capture
 * proves it renders), snapshot → tap by ref → proof, wait_for, screenshot,
 * zoom, typing (ASCII + Arabic), buttons, xcode_run of the Calculator sample
 * → drive it → read its log, video record, indicator off.
 *
 * Touches the REAL simulator on this Mac. Never run from an agent turn.
 *
 *   WOLFFISH_OVERLAY_CAPTURE_VISIBLE=1 npx electron src/main/runtime/__tests__/e2e-mobile-live.mjs \
 *     --ios "iPhone 16 Pro" [--android Dev_Phone] [--calculator /path/to/iOS_Calculator] [--out /tmp/e2e]
 */
import { app } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..')
const args = process.argv.slice(2)
const opt = (name, d = null) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : d
}
const IOS = opt('ios', 'iPhone 16 Pro')
const ANDROID = opt('android')
const CALC = opt(
  'calculator',
  '/Users/younes/Documents/wolffish/simulator/XcodeBuildMCP/example_projects/iOS_Calculator'
)
const OUT = opt('out', path.join(os.tmpdir(), `wolffish-mobile-e2e-${Date.now()}`))

let passed = 0
let failed = 0
const report = []
function ok(name, cond, detail) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}`)
    if (detail !== undefined)
      console.log(
        '    ',
        typeof detail === 'string' ? detail.slice(0, 600) : JSON.stringify(detail).slice(0, 600)
      )
  }
  report.push({ name, ok: !!cond, detail: cond ? undefined : String(detail ?? '').slice(0, 2000) })
}

function sh(cmd, a, timeout = 30_000) {
  return new Promise((resolve) =>
    execFile(cmd, a, { timeout, maxBuffer: 16e6 }, (err, stdout, stderr) =>
      resolve({ err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    )
  )
}

async function savePng(name, base64) {
  if (!base64) return null
  const f = path.join(OUT, name)
  await writeFile(f, Buffer.from(base64, 'base64'))
  return f
}

async function screencapture(name, bounds) {
  const f = path.join(OUT, name)
  const r = await sh('screencapture', [
    '-x',
    '-R',
    `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`,
    f
  ])
  return r.err ? null : f
}

const refOf = (output, needle) => {
  const line = String(output ?? '')
    .split('\n')
    .find((l) => l.includes(needle))
  const m = line ? /^@(e\d+)/.exec(line.trim()) : null
  return m ? m[1] : null
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const ws = path.join(OUT, 'workspace')
  await mkdir(ws, { recursive: true })
  app.setPath('userData', path.join(OUT, 'userData'))
  // The only windows here are indicator overlays; without this Electron quits
  // the harness the moment the indicator is taken down.
  app.on('window-all-closed', () => {})
  await app.whenReady()
  console.log(`e2e output: ${OUT}`)

  const capDir = path.join(REPO, 'src/defaults/workspace/brain/cerebellum')
  const mobile = (
    await import(pathToFileURL(path.join(capDir, 'mobile-simulators/plugin/index.mjs')).href)
  ).default
  const indicator = await import(
    pathToFileURL(path.join(capDir, 'mobile-simulators/plugin/indicator.mjs')).href
  )
  const xcode = (await import(pathToFileURL(path.join(capDir, 'xcode/plugin/index.mjs')).href))
    .default
  const ctx = {
    workspaceRoot: ws,
    getCurrentConversationId: () => 'e2e',
    getWorkingFolders: () => [CALC]
  }
  await mobile.init(ctx)
  await xcode.init(ctx)

  const t0 = Date.now()
  const call = async (tool, a = {}) => {
    const started = Date.now()
    const r = await mobile.execute(tool, a)
    r.output = r.output ?? ''
    const ms = Date.now() - started
    console.log(
      `\n▶ ${tool} ${JSON.stringify(a).slice(0, 120)} → ${r.success ? 'ok' : 'FAIL'} (${ms} ms)\n  ${(r.success ? r.output : (r.error ?? '')).split('\n').slice(0, 6).join('\n  ').slice(0, 900)}`
    )
    if (r.images?.[0])
      r.imageFile = await savePng(
        `${String(report.length).padStart(2, '0')}-${tool}.png`,
        r.images[0].data
      )
    return r
  }

  // ── Health + backend ────────────────────────────────────────────────────
  const doctor = await call('mobile_doctor')
  ok('doctor runs', doctor.success && /Xcode/.test(doctor.output), doctor.error)
  let axe = await call('axe_check')
  let axeInfo = JSON.parse(axe.output)
  if (!axeInfo.installed || axeInfo.version !== axeInfo.pinned) {
    const inst = await call('axe_install')
    ok('axe_install (managed download, checksum-verified)', inst.success, inst.error)
    axe = await call('axe_check')
    axeInfo = JSON.parse(axe.output)
  }
  ok('AXe pinned version present', axeInfo.installed && axeInfo.version === axeInfo.pinned, axeInfo)

  // ── Device ──────────────────────────────────────────────────────────────
  const devices = await call('mobile_devices')
  ok('devices lists the iPhone', devices.success && devices.output.includes(IOS), devices.output)
  const gated = await call('mobile_snapshot', { device: IOS })
  ok(
    'snapshot is refused before the indicator',
    !gated.success && /INDICATOR_REQUIRED/.test(gated.error),
    gated.error
  )
  const boot = await call('mobile_boot', { device: IOS })
  ok(
    'boot (idempotent) succeeds and sets active',
    boot.success && /Active device/.test(boot.output),
    boot.error
  )

  // ── Indicator ───────────────────────────────────────────────────────────
  const on = await call('mobile_indicator_on')
  ok(
    'indicator on over the Simulator window',
    on.success && /Driving indicator ON/.test(on.output),
    on.error
  )
  const target = {
    platform: 'ios',
    id: (/\(iOS Simulator, ([0-9A-F-]+)\)/.exec(on.output) ?? [])[1] ?? '',
    name: IOS
  }
  const entry = indicator.indicatorEntry(target)
  ok(
    'indicator entry has window bounds and a screen rect',
    !!entry?.bounds && !!entry?.screenRect,
    entry
  )
  await new Promise((r) => setTimeout(r, 700))
  if (entry?.bounds) {
    const shot = await screencapture('indicator-on.png', entry.bounds)
    ok(
      'captured the indicator over the window (see indicator-on.png)',
      !!shot,
      'screencapture failed'
    )
  }
  const dom = await indicator.indicatorDomState(target)
  ok('indicator pill names the device', dom?.name?.includes(IOS), dom)

  // ── See → touch → proof ─────────────────────────────────────────────────
  await call('mobile_button', { button: 'home' })
  const snap1 = await call('mobile_snapshot')
  ok(
    'snapshot lists refs with centers in frame px',
    snap1.success && /@e\d+ .* center=\d+,\d+ size=\d+x\d+/.test(snap1.output),
    snap1.output
  )
  const settingsRef = refOf(snap1.output, '"Settings"')
  ok('home screen shows a Settings icon with a ref', !!settingsRef, snap1.output)
  if (settingsRef) {
    // Draw a ripple and capture it, to prove placement on the window.
    const line = snap1.output.split('\n').find((l) => l.startsWith(`@${settingsRef}`))
    const center = /center=(\d+),(\d+)/.exec(line)
    const tap = await call('mobile_tap', { ref: settingsRef, expect: 'Settings opens' })
    ok(
      'tap by ref succeeds with proof',
      tap.success && /Changed: yes/.test(tap.output) && !!tap.images?.[0],
      tap.success ? tap.output : tap.error
    )
    ok(
      'tap result carries lastAction meta for the guard',
      tap.meta?.mobile?.lastAction?.summary?.includes('Tapped'),
      tap.meta
    )
    if (center && entry?.bounds) {
      indicator.ripple(target, { x: Number(center[1]), y: Number(center[2]) })
      await new Promise((r) => setTimeout(r, 250))
      await screencapture('ripple.png', entry.bounds)
    }
  }
  const wait = await call('mobile_wait_for', {
    condition: 'exists',
    marker: 'General',
    timeout_ms: 8000
  })
  ok(
    'wait_for finds General in Settings',
    wait.success && /Condition met/.test(wait.output),
    wait.error
  )
  const stale = settingsRef ? await call('mobile_tap', { ref: settingsRef }) : null
  ok(
    'a ref from before the tap is rejected as stale/missing',
    !stale ||
      (!stale.success && /SNAPSHOT_MISSING|SNAPSHOT_EXPIRED|REF_NOT_FOUND/.test(stale.error)),
    stale?.error
  )
  const shot = await call('mobile_screenshot')
  ok(
    'screenshot attaches pixels and states the frame',
    shot.success && !!shot.images?.[0] && /Frame: screenshot/.test(shot.output),
    shot.error
  )
  const zoom = await call('mobile_zoom', { x: 60, y: 300, width: 200, height: 200 })
  ok(
    'zoom returns a native crop frame',
    zoom.success && /Frame: zoom/.test(zoom.output) && !!zoom.images?.[0],
    zoom.error
  )
  const snap2 = await call('mobile_snapshot', { marker: 'Search' })
  const searchRef = refOf(snap2.output, 'SearchField') ?? refOf(snap2.output, 'TextField')
  ok('snapshot marker= narrows to the search field', !!searchRef, snap2.output)
  if (searchRef) {
    const typed = await call('mobile_type', { text: 'Wifi', ref: searchRef })
    ok(
      'ASCII typing after tapping the field',
      typed.success && /Typed 4 characters/.test(typed.output),
      typed.error
    )
    const check = await call('mobile_snapshot', { marker: 'Wifi' })
    ok(
      'typed text is visible in the tree',
      check.success && /Wifi/.test(check.output),
      check.output
    )
    const arabic = await call('mobile_key', { key: 'cmd+a' })
    ok('key combo cmd+a', arabic.success, arabic.error)
    const paste = await call('mobile_type', { text: 'مرحبا' })
    ok(
      'Arabic typing goes through the pasteboard',
      paste.success && /Pasted 5 characters/.test(paste.output),
      paste.error
    )
    const check2 = await call('mobile_snapshot', { marker: 'مرحبا' })
    ok(
      'Arabic text is visible in the tree',
      check2.success && /مرحبا/.test(check2.output),
      check2.output
    )
  }
  const home = await call('mobile_button', { button: 'home' })
  ok('home button', home.success, home.error)

  // ── Batch ───────────────────────────────────────────────────────────────
  const batch = await call('mobile_batch', {
    steps: [
      { tool: 'mobile_swipe', args: { direction: 'left' } },
      { tool: 'mobile_wait_for', args: { condition: 'settled' } },
      { tool: 'mobile_swipe', args: { direction: 'right' } }
    ]
  })
  ok('batch runs three steps', batch.success && /3 steps done/.test(batch.output), batch.error)

  // ── Build → run → drive → log ───────────────────────────────────────────
  const xc = async (tool, a = {}) => {
    const started = Date.now()
    const r = await xcode.execute(tool, a)
    console.log(
      `\n▶ ${tool} ${JSON.stringify(a).slice(0, 120)} → ${r.success ? 'ok' : 'FAIL'} (${Date.now() - started} ms)\n  ${(r.success ? r.output : (r.error ?? '')).split('\n').slice(0, 8).join('\n  ').slice(0, 1200)}`
    )
    return r
  }
  const disc = await xc('xcode_discover', { folder: CALC })
  ok(
    'xcode_discover finds the Calculator workspace',
    disc.success && /CalculatorApp\.xcworkspace/.test(disc.output),
    disc.error ?? disc.output
  )
  const schemes = await xc('xcode_schemes', {
    project: path.join(CALC, 'CalculatorApp.xcworkspace')
  })
  ok(
    'xcode_schemes lists CalculatorApp',
    schemes.success && /CalculatorApp/.test(schemes.output),
    schemes.error ?? schemes.output
  )
  const defs = await xc('xcode_defaults', {
    project: path.join(CALC, 'CalculatorApp.xcworkspace'),
    scheme: 'CalculatorApp',
    device: target.id || IOS
  })
  ok('xcode_defaults set', defs.success, defs.error)
  const bid = await xc('xcode_bundle_id', {})
  ok(
    'xcode_bundle_id reads io.sentry.calculatorapp',
    bid.success && /io\.sentry\.calculatorapp/.test(bid.output),
    bid.error ?? bid.output
  )
  const runRes = await xc('xcode_run', {})
  ok(
    'xcode_run builds, installs and launches',
    runRes.success && /Running|Launched/.test(runRes.output),
    runRes.error ?? runRes.output
  )
  if (runRes.success) {
    const launched = await call('mobile_launch', { bundle_id: 'io.sentry.calculatorapp' })
    ok(
      'mobile_launch with logs returns log paths',
      launched.success && /Console log:/.test(launched.output),
      launched.error
    )
    const settled = await call('mobile_wait_for', { condition: 'settled', timeout_ms: 8000 })
    ok('calculator settles', settled.success, settled.error)
    const calc = await call('mobile_snapshot')
    const seven = refOf(calc.output, '"7"')
    const plus =
      refOf(calc.output, '"+"') ?? refOf(calc.output, '"Add"') ?? refOf(calc.output, '"plus"')
    const eight = refOf(calc.output, '"8"')
    const equals =
      refOf(calc.output, '"="') ?? refOf(calc.output, '"Equals"') ?? refOf(calc.output, '"equals"')
    ok('calculator keys have refs', !!seven && !!eight, calc.output.slice(0, 1500))
    if (seven && plus && eight && equals) {
      const b = await call('mobile_batch', {
        steps: [{ tool: 'mobile_tap', args: { ref: seven } }]
      })
      ok('tap 7', b.success, b.error)
      const s2 = await call('mobile_snapshot')
      const plus2 =
        refOf(s2.output, '"+"') ?? refOf(s2.output, '"Add"') ?? refOf(s2.output, '"plus"')
      await call('mobile_tap', { ref: plus2 ?? plus })
      const s3 = await call('mobile_snapshot')
      await call('mobile_tap', { ref: refOf(s3.output, '"8"') ?? eight })
      const s4 = await call('mobile_snapshot')
      await call('mobile_tap', {
        ref: refOf(s4.output, '"="') ?? refOf(s4.output, '"Equals"') ?? equals
      })
      const result = await call('mobile_snapshot')
      ok('7 + 8 shows 15', /15/.test(result.output), result.output.slice(0, 1200))
    }
    const logs = await call('mobile_log', { bundle_id: 'io.sentry.calculatorapp' })
    ok('mobile_log reads captured output', logs.success, logs.error)
    const rec = await call('mobile_record', { action: 'start' })
    ok('recording starts', rec.success, rec.error)
    await call('mobile_button', { button: 'home' })
    await new Promise((r) => setTimeout(r, 1500))
    const stop = await call('mobile_record', { action: 'stop' })
    ok('recording saved an mp4', stop.success && /Saved recording/.test(stop.output), stop.error)
    const term = await call('mobile_terminate', { bundle_id: 'io.sentry.calculatorapp' })
    ok('terminate', term.success, term.error)
  }

  // ── Environment tools ───────────────────────────────────────────────────
  const dark = await call('mobile_appearance', { mode: 'dark' })
  ok('appearance dark', dark.success, dark.error)
  await call('mobile_appearance', { mode: 'light' })
  const sb = await call('mobile_status_bar', { time: '9:41', battery: 100 })
  ok('status bar override', sb.success, sb.error)
  await call('mobile_status_bar', { clear: true })
  const loc = await call('mobile_location', { latitude: 37.3349, longitude: -122.009 })
  ok('location set', loc.success, loc.error)
  await call('mobile_location', { clear: true })
  const url = await call('mobile_open_url', { url: 'https://example.com' })
  ok('open url', url.success, url.error)
  await new Promise((r) => setTimeout(r, 1500))
  await call('mobile_button', { button: 'home' })

  // ── Indicator off ───────────────────────────────────────────────────────
  const off = await call('mobile_indicator_off')
  ok('indicator off', off.success && /OFF/.test(off.output), off.error)
  await new Promise((r) => setTimeout(r, 900))
  ok('indicator window gone', !indicator.indicatorAlive(target))
  const gatedAgain = await call('mobile_snapshot')
  ok(
    'snapshot refused again after off',
    !gatedAgain.success && /INDICATOR_REQUIRED/.test(gatedAgain.error),
    gatedAgain.error
  )

  // ── Android ─────────────────────────────────────────────────────────────
  if (ANDROID) {
    const aboot = await call('mobile_boot', { device: ANDROID })
    ok(
      'android boot',
      aboot.success && /Booted AVD|already running/.test(aboot.output),
      aboot.error
    )
    if (aboot.success) {
      const aon = await call('mobile_indicator_on')
      ok('android indicator on', aon.success, aon.error)
      const aentry = indicator.indicatorEntry({
        platform: 'android',
        id: (/, (emulator-\d+)\)/.exec(aon.output) ?? [])[1] ?? '',
        name: ANDROID
      })
      if (aentry?.bounds) {
        await new Promise((r) => setTimeout(r, 700))
        await screencapture('android-indicator.png', aentry.bounds)
      }
      await call('mobile_button', { button: 'home' })
      const asnap = await call('mobile_snapshot')
      ok(
        'android snapshot lists elements',
        asnap.success && /@e\d+/.test(asnap.output),
        asnap.output
      )
      const ashot = await call('mobile_screenshot')
      ok('android screenshot', ashot.success && !!ashot.images?.[0], ashot.error)
      const aswipe = await call('mobile_swipe', { direction: 'up' })
      ok('android swipe with proof', aswipe.success && /Changed:/.test(aswipe.output), aswipe.error)
      const asnap2 = await call('mobile_snapshot')
      const anyBtn = (
        asnap2.output
          .split('\n')
          .find((l) => /^@e\d+ (TextView|Button|ImageView)/.test(l) && /center=/.test(l)) ?? ''
      ).match(/^@(e\d+)/)?.[1]
      if (anyBtn) {
        const atap = await call('mobile_tap', { ref: anyBtn })
        ok('android tap by ref', atap.success && /Changed:/.test(atap.output), atap.error)
      }
      const aback = await call('mobile_button', { button: 'back' })
      ok('android back', aback.success, aback.error)
      const atype = await call('mobile_type', { text: 'مرحبا' })
      ok(
        'android non-ASCII typing is a typed CHARSET_UNSUPPORTED (no IME)',
        (!atype.success && /CHARSET_UNSUPPORTED/.test(atype.error)) || atype.success,
        atype.error
      )
      const alog = await call('mobile_log', { lines: 20 })
      ok('android log fallback', alog.success, alog.error)
      await call('mobile_indicator_off')
      const ashut = await call('mobile_shutdown')
      ok('android shutdown', ashut.success, ashut.error)
    }
  }

  console.log(
    `\n${passed} passed, ${failed} failed in ${Math.round((Date.now() - t0) / 1000)}s — artifacts in ${OUT}`
  )
  await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  await mobile.destroy?.()
  app.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('e2e crashed:', e)
  app.exit(2)
})
