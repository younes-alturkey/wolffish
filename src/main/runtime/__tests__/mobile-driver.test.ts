/**
 * The mobile-simulators capability (src/defaults/workspace/brain/cerebellum/
 * mobile-simulators/plugin/): the indicator gate, the executor seam, typed
 * errors, the element model, the frame contract (image px <-> device units),
 * the iOS and Android action pipelines through a fake executor, device
 * resolution, the helper registry, the window mapping, the SKILL.md
 * frontmatter, and the Agent-side indicator registry.
 *
 * Nothing here spawns xcrun, adb or axe: exec.mjs's __setExecutor takes a
 * fake that records every argv and answers from a scenario.
 *
 * Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/mobile-driver.test.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import yaml from 'js-yaml'
import sharp from 'sharp'

import {
  INDICATORS,
  indicatorNoticeText,
  indicatorNudge,
  indicatorOffTools,
  lastIndicatorActionFrom,
  MOBILE_INDICATOR_NOTICE,
  SCREEN_INDICATOR_NOTICE,
  trackIndicators
} from '../agent/screen-indicator-guard'

let passed = 0
let failed = 0
function ok(name: string, cond: unknown, detail?: unknown): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}`)
    if (detail !== undefined)
      console.log('    ', typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
}

// ─── Shapes of what the plugin returns (only what the checks touch) ───────
type Result = {
  success: boolean
  output?: string
  error?: string
  retryable?: boolean
  images?: { mediaType: string; data: string }[]
  meta?: { code?: string; mobile?: { lastAction?: { summary?: string } }; [k: string]: unknown }
}
type Plugin = {
  tools: { name: string }[]
  init: (ctx: unknown) => Promise<void>
  execute: (name: string, args: Record<string, unknown>) => Promise<Result>
  isReadOnlyCall: (name: string) => boolean
}
type Call = { cmd: string; args: string[]; opts: { input?: unknown } }
type XY = { x: number; y: number }
type WH = { w: number; h: number }
type Rect = XY & WH
type El = {
  ref?: string
  type: string
  label: string | null
  text: string | null
  frame: Rect
  interactive: boolean
  scrollable: boolean
  focused: boolean
  checked: boolean | null
  actions: string[]
}
type Parsed = { elements: El[]; omitted: number }
type Frame = { kind: string; image: WH; region: Rect; native: WH }
type Img = { buffer: Buffer; info: WH; region: Rect; original: WH }
type Snap = { status: string }
type Helper = { id: string }
type Gate = { indicatorOn: boolean; unavailable: boolean }
type Mods = {
  'exec.mjs': {
    __setExecutor(fn: unknown): void
    __resetExecutor(): void
    run(c: string, a: string[]): Promise<{ code: number; out: string; err: string; stdout: Buffer }>
    tail(t: string, n?: number): string
    isUuid(s: string): boolean
    isAdbSerial(s: string): boolean
    BUNDLE_ID_RE: RegExp
    PACKAGE_RE: RegExp
  }
  'errors.mjs': {
    CODES: Record<string, string>
    fail(code: string, m: string, h?: string, extra?: object): Result
    infra(m: string, o?: object): Result
  }
  'snapshot.mjs': {
    fromAxe(t: unknown, o: object): Parsed
    fromUiautomator(x: string, o: object): Parsed
    hashElements(e: El[]): string
    select(e: El[]): { chosen: El[]; truncated: { interactive: number } }
    formatElements(c: El[], o: { toFrame: (x: number, y: number) => XY }): string
    putSnapshot(k: string, v: object): { seq: number; expiresAt: number }
    getSnapshot(k: string): Snap
    resolveRef(k: string, r: string): Snap
    clearSnapshot(k: string): void
  }
  'frames.mjs': {
    ZOOM_MAX: number
    setFrame(k: string, f: object): Frame
    getFrame(k: string): Frame | null
    toNative(f: Frame, x: number, y: number): XY
    fromNative(f: Frame, x: number, y: number): XY & { offFrame: boolean }
    describeFrame(f: Frame): string
    encodeScreen(b: Buffer): Promise<Img>
    cropRegion(b: Buffer, r: Rect, o: object): Promise<Img>
    magnifier(b: Buffer, p: XY, o: object): Promise<Img>
    changeRatio(a: Buffer, b: Buffer, o?: object): Promise<{ whole: number; local: number | null }>
    screenHash(b: Buffer): Promise<string>
  }
  'helpers.mjs': {
    initHelpers(d: string): void
    registerHelper(r: object): Promise<Helper>
    listHelpers(f?: object): Promise<Helper[]>
    forgetHelper(id: string): Promise<void>
    commandLineOf(pid: number): Promise<string | null>
    helperAlive(r: Helper): Promise<boolean>
    sweepHelpers(): Promise<{ stopped: number; dropped: number }>
  }
  'windows.mjs': { emulatorOwners(): string[] }
  'indicator.mjs': { screenRectInWindow(d: object, g: object, o: object): Rect & { scale: number } }
  'devices.mjs': { __resetDevices(): void }
  'index.mjs': {
    default: Plugin
    INDICATOR_REQUIRED: Set<string>
    indicatorGateReason(t: string, s: Gate): string | null
  }
}

const REPO = process.cwd()
const PLUGIN = path.join(REPO, 'src/defaults/workspace/brain/cerebellum/mobile-simulators/plugin')
const load = <K extends keyof Mods>(file: K): Promise<Mods[K]> =>
  import(pathToFileURL(path.join(PLUGIN, file)).href) as Promise<Mods[K]>
const UDID = 'AAAAAAAA-0000-0000-0000-000000000001'
const UDID2 = 'BBBBBBBB-0000-0000-0000-000000000002'
const SERIAL = 'emulator-5554'
const NATIVE = { w: 402, h: 874 }
const has = (s: string | undefined, sub: string): boolean => !!s && s.includes(sub)
const near = (a: number, b: number, eps: number): boolean => Math.abs(a - b) <= eps

function png(w: number, h: number, bg = '#ffffff'): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: bg } })
    .png()
    .toBuffer()
}

function execScript(p: string): void {
  fs.writeFileSync(p, '#!/bin/sh\nexit 0\n')
  fs.chmodSync(p, 0o755)
}

async function main(): Promise<void> {
  const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-mobile-')))
  const WORKSPACE = path.join(TMP, 'workspace')
  fs.mkdirSync(WORKSPACE, { recursive: true })
  // Binaries the resolvers must FIND; the fake executor answers for them.
  const SDK = path.join(TMP, 'sdk')
  fs.mkdirSync(path.join(SDK, 'platform-tools'), { recursive: true })
  execScript(path.join(SDK, 'platform-tools', 'adb'))
  process.env.ANDROID_HOME = SDK
  const AXE = path.join(TMP, 'axe')
  execScript(AXE)
  process.env.WOLFFISH_AXE_PATH = AXE

  const iosPng = await png(1206, 2622, '#e0e0e0')
  const androidPng = await png(1080, 2400, '#d0d0d0')
  const axeTree = {
    type: 'Application',
    frame: { x: 0, y: 0, width: 402, height: 874 },
    children: [
      { type: 'Button', AXLabel: 'Sign in', frame: { x: 100, y: 600, width: 200, height: 44 } }
    ]
  }
  const uiXml =
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">` +
    `<node text="" class="android.widget.FrameLayout" clickable="false" bounds="[0,0][1080,2400]">` +
    `<node text="OK" class="android.widget.Button" clickable="true" bounds="[100,600][300,644]" />` +
    `</node></hierarchy>`
  const sim = (state: string, name = 'iPhone Test', udid = UDID): object => ({
    udid,
    name,
    state,
    isAvailable: true
  })
  const scenario = { sims: [sim('Booted')], droids: [] as string[], imes: 'com.x/.LatinIME\n' }
  const calls: Call[] = []
  const fake = (cmd: string, args: string[], opts: Call['opts']): object => {
    calls.push({ cmd, args, opts })
    const base = path.basename(cmd)
    if (base === 'xcrun' && args[0] === 'simctl') {
      const rt = 'com.apple.CoreSimulator.SimRuntime.iOS-18-0'
      if (args[1] === 'list')
        return { code: 0, out: JSON.stringify({ devices: { [rt]: scenario.sims } }) }
      if (args[1] === 'io' && args[3] === 'screenshot')
        fs.writeFileSync(args[args.length - 1], iosPng)
      return { code: 0, out: '' }
    }
    if (base === 'axe') {
      return { code: 0, out: args[0] === 'describe-ui' ? JSON.stringify(axeTree) : '' }
    }
    if (base === 'adb') {
      const s = (args[0] === '-s' ? args.slice(2) : args).join(' ')
      if (s === 'devices -l')
        return { code: 0, out: `List of devices\n${scenario.droids.join('\n')}\n` }
      if (s === 'emu avd name') return { code: 0, out: 'Dev_Phone\nOK\n' }
      if (s === 'exec-out screencap -p') return { code: 0, out: '', stdout: androidPng }
      if (s === 'shell wm density') return { code: 0, out: 'Physical density: 420\n' }
      if (s === 'exec-out uiautomator dump /dev/tty')
        return { code: 0, out: `${uiXml}\nUI hierchary dumped to: /dev/tty` }
      if (s === 'shell ime list -s') return { code: 0, out: scenario.imes }
      return { code: 0, out: '' }
    }
    return { code: 1, out: '', err: `fake: unhandled ${base} ${args.join(' ')}` }
  }
  /** Last recorded call of `base` whose (device-stripped) argv starts with `first`. */
  const findCall = (base: string, first: string): Call | undefined =>
    [...calls].reverse().find((c) => {
      if (path.basename(c.cmd) !== base) return false
      const argv = base === 'adb' ? c.args.slice(2) : c.args
      return argv.join(' ').startsWith(first)
    })
  const argAfter = (c: Call | undefined, flag: string): string | undefined =>
    c ? c.args[c.args.indexOf(flag) + 1] : undefined
  const numAfter = (c: Call | undefined, flag: string): number => Number(argAfter(c, flag))

  const exec = await load('exec.mjs')
  exec.__setExecutor(fake)
  const errors = await load('errors.mjs')
  const snap = await load('snapshot.mjs')
  const frames = await load('frames.mjs')
  const helpers = await load('helpers.mjs')
  const windows = await load('windows.mjs')
  const indicator = await load('indicator.mjs')
  const devices = await load('devices.mjs')
  const index = await load('index.mjs')
  const plugin = index.default
  const REQUIRED = [...index.INDICATOR_REQUIRED]
  const gateReason = index.indicatorGateReason
  await plugin.init({ workspaceRoot: WORKSPACE, getCurrentConversationId: () => 'conv1' })
  const run = (name: string, args: Record<string, unknown> = {}): Promise<Result> =>
    plugin.execute(name, { settle_ms: 0, ...args })
  const isMac = process.platform === 'darwin'

  console.log('1. indicator gate')
  {
    const off = { indicatorOn: false, unavailable: false }
    const refusals = REQUIRED.map((t) => gateReason(t, off) ?? '')
    ok(
      'every seeing/touching tool refused when off',
      refusals.every((r) => r.startsWith('INDICATOR_REQUIRED'))
    )
    ok(
      'the refusal names mobile_indicator_on',
      refusals.every((r) => has(r, 'mobile_indicator_on'))
    )
    ok(
      'not refused when on',
      REQUIRED.every((t) => gateReason(t, { indicatorOn: true, unavailable: false }) === null)
    )
    ok(
      'not refused when unavailable',
      REQUIRED.every((t) => gateReason(t, { indicatorOn: false, unavailable: true }) === null)
    )
    const free = [
      'mobile_devices',
      'mobile_use',
      'mobile_boot',
      'mobile_launch',
      'mobile_log',
      'mobile_doctor'
    ]
    ok(
      'lifecycle/log/doctor tools never gated',
      free.every((t) => gateReason(t, off) === null)
    )
    ok(
      'indicator on/off never gated',
      ['mobile_indicator_on', 'mobile_indicator_off'].every((t) => gateReason(t, off) === null)
    )
    if (isMac) {
      const refused = await run('mobile_snapshot')
      ok(
        'execute: snapshot refused before the indicator',
        refused.meta?.code === 'INDICATOR_REQUIRED',
        refused
      )
      const on = await run('mobile_indicator_on')
      ok(
        'mobile_indicator_on fails outside Electron',
        !on.success && /unavailable/i.test(on.error ?? ''),
        on
      )
      const after = await run('mobile_snapshot')
      ok(
        'a failed indicator_on opens the gate',
        after.success && after.meta?.code !== 'INDICATOR_REQUIRED',
        after
      )
      await run('mobile_indicator_off')
      const again = await run('mobile_snapshot')
      ok('mobile_indicator_off closes it again', again.meta?.code === 'INDICATOR_REQUIRED', again)
      await run('mobile_indicator_on')
    }
  }

  console.log('2. executor')
  {
    const r = await exec.run('xcrun', ['simctl', 'list', 'devices', '--json'])
    ok(
      'run() normalizes the fake result',
      r.code === 0 && r.out.startsWith('{') && r.err === '' && Buffer.isBuffer(r.stdout)
    )
    const t = exec.tail(Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n'), 200)
    ok(
      'tail keeps the last lines + omitted count',
      t.startsWith('…(100 earlier lines omitted)') && t.endsWith('line 300')
    )
    ok('isUuid', exec.isUuid(UDID) && !exec.isUuid(SERIAL) && !exec.isUuid('nope'))
    ok(
      'isAdbSerial',
      exec.isAdbSerial(SERIAL) &&
        exec.isAdbSerial('ZY22ABC123') &&
        !exec.isAdbSerial(UDID) &&
        !exec.isAdbSerial('a b')
    )
    ok(
      'BUNDLE_ID_RE',
      exec.BUNDLE_ID_RE.test('com.example.MyApp') && !exec.BUNDLE_ID_RE.test('bad id')
    )
    ok(
      'PACKAGE_RE',
      exec.PACKAGE_RE.test('com.example.app') &&
        !exec.PACKAGE_RE.test('single') &&
        !exec.PACKAGE_RE.test('1a.b')
    )
  }

  console.log('3. errors')
  {
    const f = errors.fail(errors.CODES.NO_DEVICE, 'nothing booted', 'call mobile_boot', {
      extra: 1
    })
    ok('fail(): success false, not retryable', f.success === false && f.retryable === false)
    ok(
      'fail(): error = code + message + hint',
      f.error === 'NO_DEVICE: nothing booted — call mobile_boot'
    )
    ok('fail(): meta.code + extras', f.meta?.code === 'NO_DEVICE' && f.meta?.extra === 1)
    const i = errors.infra('simctl died')
    ok(
      'infra() retryable by default',
      i.success === false && i.retryable === true && i.meta?.code === 'INFRA'
    )
    ok(
      'infra() can be pinned non-retryable',
      errors.infra('x', { retryable: false }).retryable === false
    )
  }

  console.log('4. snapshot')
  {
    const fr = (x: number, y: number, width: number, height: number): object => ({
      x,
      y,
      width,
      height
    })
    const tree = {
      type: 'Application',
      frame: fr(0, 0, 402, 874),
      children: [
        {
          type: 'Group',
          frame: fr(0, 0, 402, 874),
          children: [
            { type: 'Button', AXLabel: 'Sign in', frame: fr(100, 600, 200, 44) },
            { type: 'StaticText', AXLabel: 'Welcome back', frame: fr(20, 100, 200, 30) },
            { type: 'Button', AXLabel: 'Ghost', frame: fr(10, 10, 0, 0) },
            { type: 'Button', AXLabel: 'Off', frame: fr(-500, 100, 100, 40) },
            { type: 'ScrollArea', frame: fr(0, 200, 402, 600) }
          ]
        }
      ]
    }
    const a = snap.fromAxe(tree, { screen: NATIVE })
    const interactive = a.elements.filter((e) => e.interactive)
    ok(
      'fromAxe: 3 elements, 1 interactive, 2 omitted',
      a.elements.length === 3 && interactive.length === 1 && a.omitted === 2
    )
    ok(
      'fromAxe: scroll area flagged',
      a.elements.some((e) => e.type === 'ScrollArea' && e.scrollable && !e.interactive)
    )
    ok(
      'fromAxe: button label, frame, actions',
      a.elements[0].label === 'Sign in' &&
        a.elements[0].frame.x === 100 &&
        a.elements[0].actions.includes('tap')
    )

    const xml =
      `<?xml version='1.0'?><hierarchy rotation="0">` +
      `<node text="" class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">` +
      `<node text="Save &amp; exit" class="android.widget.Button" clickable="true" bounds="[100,600][300,644]" />` +
      `<node text="" class="android.widget.EditText" clickable="true" focused="true" bounds="[100,700][900,780]" />` +
      `<node text="gone" class="android.widget.TextView" clickable="true" bounds="[0,0][0,0]" />` +
      `<node class="android.widget.ScrollView" scrollable="true" bounds="[0,800][1080,2000]" />` +
      `<node class="android.widget.CheckBox" checkable="true" checked="true" clickable="true" bounds="[50,50][100,100]" />` +
      `</node></hierarchy>`
    const u = snap.fromUiautomator(xml, { screen: { w: 1080, h: 2400 } })
    const types = u.elements.map((e) => e.type).join(',')
    ok('fromUiautomator: types', types === 'Button,TextField,ScrollView,CheckBox', types)
    ok('fromUiautomator: entity decoded', u.elements[0].text === 'Save & exit', u.elements[0])
    ok(
      'fromUiautomator: focused EditText types',
      u.elements[1].focused === true && u.elements[1].actions.includes('type')
    )
    ok('fromUiautomator: checked flag', u.elements[3].checked === true)
    ok(
      'fromUiautomator: zero-size omitted, scroll flagged',
      u.omitted === 1 && u.elements[2].scrollable === true
    )

    const h1 = snap.hashElements(a.elements)
    const changed = JSON.parse(JSON.stringify(tree))
    changed.children[0].children[0].AXLabel = 'Sign out'
    const h2 = snap.hashElements(snap.fromAxe(changed, { screen: NATIVE }).elements)
    ok(
      'hashElements stable across identical trees',
      h1 === snap.hashElements(snap.fromAxe(tree, { screen: NATIVE }).elements)
    )
    ok('hashElements changes with a label', h1 !== h2)

    const many: El[] = Array.from({ length: 70 }, (_, i) => ({ ...a.elements[0], label: `b${i}` }))
    const sel = snap.select(many)
    ok(
      'select caps interactive at 64, refs e1..e64',
      sel.chosen.length === 64 && sel.chosen[0].ref === 'e1' && sel.chosen[63].ref === 'e64'
    )
    ok('select reports the truncated count', sel.truncated.interactive === 6)
    const chosen = snap.select(a.elements).chosen
    const line = snap.formatElements(chosen, { toFrame: (x, y) => ({ x, y }) }).split('\n')[0]
    ok(
      'formatElements line shape',
      line === '@e1 Button "Sign in" center=200,622 size=200x44',
      line
    )

    const key = 'conv1:snap-test'
    const rec = snap.putSnapshot(key, {
      elements: a.elements,
      chosen,
      hash: h1,
      platform: 'ios',
      screen: NATIVE,
      unit: 'pt'
    })
    ok('putSnapshot/getSnapshot ok', snap.getSnapshot(key).status === 'ok' && rec.seq === 1)
    ok(
      'resolveRef ok / not_found',
      snap.resolveRef(key, '@e1').status === 'ok' &&
        snap.resolveRef(key, 'e9').status === 'not_found'
    )
    rec.expiresAt = Date.now() - 1
    ok(
      'resolveRef expired',
      snap.resolveRef(key, 'e1').status === 'expired' && snap.getSnapshot(key).status === 'expired'
    )
    snap.clearSnapshot(key)
    ok('clearSnapshot → missing', snap.resolveRef(key, 'e1').status === 'missing')
  }

  console.log('5. frames')
  {
    const base = { native: NATIVE, pxPerUnit: 3, unit: 'pt' }
    const f = frames.setFrame('t:shot', {
      ...base,
      kind: 'screenshot',
      image: { w: 470, h: 1024 },
      region: { x: 0, y: 0, ...NATIVE }
    })
    const n = frames.toNative(f, 470, 1024)
    const b = frames.fromNative(f, n.x, n.y)
    ok(
      'screenshot frame round trip',
      near(n.x, 402, 1e-9) && near(n.y, 874, 1e-9) && near(b.x, 470, 1e-9) && !b.offFrame
    )
    ok(
      'fromNative marks off-frame points',
      frames.fromNative(f, 500, 100).offFrame && frames.fromNative(f, -1, 0).offFrame
    )
    const z = frames.setFrame('t:zoom', {
      ...base,
      kind: 'zoom',
      image: { w: 471, h: 1024 },
      region: { x: 100, y: 200, w: 134, h: 291 }
    })
    const zn = frames.toNative(z, 0, 0)
    const zb = frames.fromNative(z, 167, 345.5)
    ok(
      'zoom frame with offset round trips',
      zn.x === 100 && zn.y === 200 && near(zb.x, 235.5, 1e-6) && near(zb.y, 512, 1e-6)
    )
    ok(
      'describeFrame names the kind',
      frames.describeFrame(f).startsWith('screenshot 470x1024') &&
        frames.describeFrame(z).startsWith('zoom')
    )
    ok('describeFrame names the region', has(frames.describeFrame(z), 'region 100,200'))
    const enc = await frames.encodeScreen(iosPng)
    ok(
      'encodeScreen ≤1024 long edge',
      Math.max(enc.info.w, enc.info.h) === 1024 && enc.info.w <= 1024,
      enc.info
    )
    ok('encodeScreen reports original dims', enc.original.w === 1206 && enc.original.h === 2622)
    const crop = await frames.cropRegion(iosPng, { x: 1000, y: 2000, w: 100, h: 100 }, base)
    const cr = crop.region
    ok(
      'cropRegion clamps to the screen',
      cr.x === 302 && cr.y === 774 && cr.w === 100 && cr.h === 100,
      cr
    )
    ok(
      'cropRegion never enlarges past ZOOM_MAX',
      Math.max(crop.info.w, crop.info.h) <= 100 * frames.ZOOM_MAX
    )
    const inside = (r: Rect, p: XY): boolean =>
      p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
    const mag = await frames.magnifier(iosPng, { x: 200, y: 622 }, base)
    ok(
      'magnifier is 480x300 around the point',
      mag.info.w === 480 && mag.info.h === 300 && inside(mag.region, { x: 200, y: 622 })
    )
    const edge = await frames.magnifier(iosPng, { x: 0, y: 0 }, base)
    ok(
      'magnifier at an edge still holds the point',
      edge.region.x === 0 && edge.region.y === 0 && edge.info.w === 480
    )
    const black = await png(1206, 2622, '#000000')
    const same = await frames.changeRatio(iosPng, iosPng, { point: { x: 200, y: 622 }, ...base })
    const diff = await frames.changeRatio(black, iosPng)
    ok(
      'changeRatio ~0 identical, >0.5 black vs white',
      same.whole === 0 && same.local === 0 && diff.whole > 0.5
    )
    ok(
      'screenHash equal for identical images',
      (await frames.screenHash(iosPng)) === (await frames.screenHash(iosPng))
    )
    ok(
      'screenHash differs for different images',
      (await frames.screenHash(black)) !== (await frames.screenHash(iosPng))
    )
  }

  console.log('6. iOS frame contract through the plugin')
  if (!isMac) console.log('  (skipped: the iOS backend resolves only on macOS)')
  else {
    const use = await run('mobile_use', { device: 'iPhone Test' })
    ok(
      'mobile_use by name → active',
      use.success && has(use.output, 'Active device: iPhone Test'),
      use
    )
    const shot = await run('mobile_screenshot')
    const enc = await frames.encodeScreen(iosPng)
    const saved = /saved to (\S+\.png)/.exec(shot.output ?? '')?.[1] ?? ''
    ok(
      'mobile_screenshot: image + saved path',
      shot.success && !!shot.images?.[0]?.data && !!saved,
      shot
    )
    ok('mobile_screenshot: "pixels of THIS image"', has(shot.output, 'pixels of THIS image'))
    ok(
      'the file exists under files/screenshots',
      saved.startsWith(path.join(WORKSPACE, 'files', 'screenshots')) && fs.existsSync(saved)
    )
    const sn = await run('mobile_snapshot')
    const cx = Math.round((200 * enc.info.w) / 402)
    const cy = Math.round((622 * enc.info.h) / 874)
    ok(
      'mobile_snapshot lists @e1 Button "Sign in"',
      sn.success && has(sn.output, '@e1 Button "Sign in"'),
      sn
    )
    ok('its center is in screenshot pixels', has(sn.output, `center=${cx},${cy}`), sn.output)
    calls.length = 0
    const tap = await run('mobile_tap', { ref: 'e1' })
    const axeTap = findCall('axe', 'tap')
    ok(
      'tap ref=e1 → --label "Sign in" (or -x/-y)',
      argAfter(axeTap, '--label') === 'Sign in' || !!axeTap?.args.includes('-x'),
      axeTap
    )
    ok(
      'tap proof: Changed: + magnifier image',
      tap.success && has(tap.output, 'Changed:') && tap.images?.length === 1,
      tap
    )
    ok(
      'tap meta.mobile.lastAction.summary',
      typeof tap.meta?.mobile?.lastAction?.summary === 'string'
    )
    const stale = await run('mobile_tap', { ref: 'e1' })
    ok(
      'refs dropped by the action → SNAPSHOT_MISSING',
      stale.meta?.code === 'SNAPSHOT_MISSING',
      stale
    )
    await run('mobile_screenshot')
    calls.length = 0
    const xy = await run('mobile_tap', { x: 10, y: 10 })
    const c = findCall('axe', 'tap')
    const px = numAfter(c, '-x')
    const py = numAfter(c, '-y')
    ok(
      'tap x=10 y=10 → points ≈ 10*(402/471)',
      xy.success &&
        near(px, 10 * (402 / enc.info.w), 0.5) &&
        near(py, 10 * (874 / enc.info.h), 0.5),
      { px, py }
    )
    const oof = await run('mobile_tap', { x: 9999, y: 10 })
    ok('tap x=9999 → OUT_OF_FRAME', oof.meta?.code === 'OUT_OF_FRAME', oof)
    await run('mobile_screenshot')
    const zoom = await run('mobile_zoom', { x: 235, y: 512 })
    const zf = frames.getFrame(`conv1:${UDID}`)
    ok(
      'mobile_zoom → smaller region frame',
      zoom.success && zoom.images?.length === 1 && zf?.kind === 'zoom' && !!zf && zf.region.w < 402,
      zoom
    )
    calls.length = 0
    await run('mobile_tap', { x: 1, y: 1 })
    const zx = numAfter(findCall('axe', 'tap'), '-x')
    ok(
      'a tap in the zoomed frame maps inside its region',
      !!zf && zx >= zf.region.x && zx <= zf.region.x + zf.region.w,
      { zx, zf }
    )
    calls.length = 0
    const typed = await run('mobile_type', { text: 'Wifi' })
    ok(
      'type ASCII → axe type --stdin, text on stdin',
      typed.success && findCall('axe', 'type --stdin')?.opts.input === 'Wifi',
      typed
    )
    calls.length = 0
    const arabic = await run('mobile_type', { text: 'مرحبا' })
    const paste = findCall('axe', 'key-combo')
    ok(
      'type non-ASCII → simctl pbcopy with the text',
      arabic.success && findCall('xcrun', 'simctl pbcopy')?.opts.input === 'مرحبا',
      arabic
    )
    ok(
      '… then key-combo 227 / 25 (Cmd-V)',
      argAfter(paste, '--modifiers') === '227' && argAfter(paste, '--key') === '25',
      paste
    )
    calls.length = 0
    await run('mobile_key', { key: 'cmd+a' })
    const combo = findCall('axe', 'key-combo')
    ok(
      'key cmd+a → key-combo 227 / 4',
      argAfter(combo, '--modifiers') === '227' && argAfter(combo, '--key') === '4',
      combo
    )
    await run('mobile_key', { key: 'enter' })
    ok('key enter → key 40', !!findCall('axe', 'key 40'))
    await run('mobile_button', { button: 'home' })
    ok('button home → button home', !!findCall('axe', 'button home'))
    calls.length = 0
    const sw = await run('mobile_swipe', { direction: 'up' })
    const s = findCall('axe', 'swipe')
    const [sx, sy, ex, ey] = ['--start-x', '--start-y', '--end-x', '--end-y'].map((k) =>
      numAfter(s, k)
    )
    ok(
      'swipe up starts at the screen center (points)',
      sw.success && sx === 201 && sy === 437 && ex === 201,
      s
    )
    ok('swipe up ends above, clamped inside the screen', ey < sy && ey >= 2)
  }

  console.log('7. Android path')
  {
    scenario.droids = [`${SERIAL} device product:x model:Pixel device:y`]
    devices.__resetDevices()
    const use = await run('mobile_use', { device: SERIAL })
    ok(
      'mobile_use emulator-5554 → active, avd-named',
      use.success && has(use.output, 'Dev_Phone') && has(use.output, SERIAL),
      use
    )
    const sn = await run('mobile_snapshot')
    ok(
      'snapshot lists @e1 Button text="OK"',
      sn.success && has(sn.output, '@e1 Button') && has(sn.output, 'text="OK"'),
      sn
    )
    ok('its center is native px (no frame yet)', has(sn.output, 'center=200,622'))
    calls.length = 0
    const tap = await run('mobile_tap', { ref: 'e1' })
    ok(
      'tap ref=e1 → shell input tap 200 622',
      tap.success && !!findCall('adb', 'shell input tap 200 622'),
      tap
    )
    calls.length = 0
    const t1 = await run('mobile_type', { text: 'hi there' })
    ok(
      'type ASCII → input text hi%sthere',
      t1.success && !!findCall('adb', 'shell input text hi%sthere'),
      t1
    )
    const t2 = await run('mobile_type', { text: 'مرحبا' })
    ok(
      'type non-ASCII, no ADB Keyboard → CHARSET_UNSUPPORTED',
      t2.meta?.code === 'CHARSET_UNSUPPORTED',
      t2
    )
    await run('mobile_key', { key: 'back' })
    ok('key back → keyevent KEYCODE_BACK', !!findCall('adb', 'shell input keyevent KEYCODE_BACK'))
    await run('mobile_button', { button: 'home' })
    ok(
      'button home → keyevent KEYCODE_HOME',
      !!findCall('adb', 'shell input keyevent KEYCODE_HOME')
    )
  }

  console.log('8. device resolution')
  if (!isMac) console.log('  (skipped: needs the simulator list)')
  else {
    scenario.droids = []
    scenario.sims = [sim('Booted'), sim('Booted', 'iPad Test', UDID2)]
    devices.__resetDevices()
    const two = await run('mobile_apps')
    ok('two booted, none active → NO_DEVICE', two.meta?.code === 'NO_DEVICE', two)
    ok('… naming both', has(two.error, 'iPhone Test') && has(two.error, 'iPad Test'))
    const none = await run('mobile_apps', { device: 'nonexistent' })
    ok('device=nonexistent → DEVICE_NOT_FOUND', none.meta?.code === 'DEVICE_NOT_FOUND', none)
    scenario.sims = [sim('Shutdown')]
    devices.__resetDevices()
    const down = await run('mobile_apps', { device: UDID })
    ok(
      'Shutdown sim → NOT_BOOTED naming mobile_boot',
      down.meta?.code === 'NOT_BOOTED' && has(down.error, 'mobile_boot'),
      down
    )
  }

  console.log('9. helpers')
  {
    const HELP = path.join(TMP, 'helpers-ws')
    helpers.initHelpers(HELP)
    const line = await helpers.commandLineOf(process.pid)
    ok(
      'commandLineOf(process.pid) reads our command line',
      typeof line === 'string' && line.length > 0,
      line
    )
    const sig = (line ?? '').slice(0, 12)
    const mine = await helpers.registerHelper({
      kind: 'oslog',
      pid: process.pid,
      argv: ['x'],
      signature: sig,
      device: 'd1',
      app: 'a1'
    })
    const other = await helpers.registerHelper({
      kind: 'logcat',
      pid: process.pid,
      argv: ['y'],
      signature: 'zzz-no-such-argv',
      device: 'd2',
      app: 'a2'
    })
    ok(
      'registerHelper writes a JSON file',
      fs.existsSync(path.join(HELP, 'files', 'mobile', 'helpers', `${mine.id}.json`))
    )
    const byKind = await helpers.listHelpers({ kind: 'oslog' })
    const byDev = await helpers.listHelpers({ device: 'd2' })
    const byApp = await helpers.listHelpers({ app: 'a1' })
    ok(
      'listHelpers filters by kind/device/app',
      byKind.length === 1 && byDev[0]?.id === other.id && byApp[0]?.id === mine.id
    )
    ok('helperAlive: matching signature → true', (await helpers.helperAlive(mine)) === true)
    ok('helperAlive: non-matching signature → false', (await helpers.helperAlive(other)) === false)
    await helpers.forgetHelper(other.id)
    ok('forgetHelper removes the record', (await helpers.listHelpers()).length === 1)
    await helpers.registerHelper({
      kind: 'record',
      pid: 999999,
      argv: ['z'],
      signature: 'z',
      device: 'd3'
    })
    const swept = await helpers.sweepHelpers()
    const left = (await helpers.listHelpers()).map((h) => h.id).join()
    ok(
      'sweepHelpers drops the dead pid, keeps the live one',
      swept.dropped === 1 && left === mine.id,
      swept
    )
    await helpers.forgetHelper(mine.id)
  }

  console.log('10. windows / indicator mapping')
  {
    ok('emulatorOwners non-empty', windows.emulatorOwners().length > 0)
    const geo = { native: NATIVE, unit: 'pt', pxPerUnit: 3 }
    const dip = { x: 705, y: 50, width: 456, height: 972 }
    const r1 = indicator.screenRectInWindow(dip, geo, {
      chrome: true,
      windowScale: 1,
      titleBar: 28
    })
    ok('chrome + WindowScale 1 → scale 1, width 402', r1.scale === 1 && r1.w === 402, r1)
    ok('… centered in the content area', near(r1.x, 705 + 27, 1) && near(r1.y, 50 + 28 + 35, 1), r1)
    const r2 = indicator.screenRectInWindow(dip, geo, { chrome: false, titleBar: 28 })
    // 456/402 = 1.134 would overflow the 944 pt content height; the tighter axis binds.
    const fit = Math.min(456 / 402, (972 - 28) / 874)
    ok(
      'no chrome → scale fits the content area',
      near(r2.scale, fit, 1e-9) && r2.w <= 456 + 1e-6 && r2.h <= 944 + 1e-6,
      r2
    )
    const emuGeo = { native: { w: 1080, h: 2400 }, unit: 'px', pxPerUnit: 1 }
    const r3 = indicator.screenRectInWindow({ x: 0, y: 0, width: 388, height: 891 }, emuGeo, {
      titleBar: 28
    })
    ok(
      'emulator 388x891 for 1080x2400 → scale ≈ 0.359, h ≈ 862',
      near(r3.scale, 0.359, 0.001) && near(r3.h, 862, 1),
      r3
    )
  }

  console.log('11. SKILL.md frontmatter')
  {
    type Tool = { name: string; readOnly?: boolean; description: string }
    const raw = fs.readFileSync(path.join(PLUGIN, '..', 'SKILL.md'), 'utf8')
    const end = raw.indexOf('\n---', 3)
    const fm = yaml.load(raw.slice(3, end).trim()) as {
      tools: Tool[]
      confirm_patterns: { pattern: string }[]
    }
    const fmNames = fm.tools.map((t) => t.name)
    const plNames = plugin.tools.map((t) => t.name)
    const onlyFm = fmNames.filter((n) => !plNames.includes(n))
    const onlyPl = plNames.filter((n) => !fmNames.includes(n))
    ok(
      'frontmatter tools == plugin tools',
      onlyFm.length === 0 && onlyPl.length === 0 && fmNames.length === plNames.length,
      { onlyFm, onlyPl }
    )
    const silent = REQUIRED.filter(
      (n) => !has(fm.tools.find((t) => t.name === n)?.description, 'mobile_indicator_on')
    )
    ok('every gated tool description names mobile_indicator_on', silent.length === 0, silent)
    const confirms = (n: string): boolean =>
      fm.confirm_patterns.some((p) => new RegExp(p.pattern).test(n))
    ok(
      'mobile_erase and mobile_uninstall need confirmation',
      confirms('mobile_erase') && confirms('mobile_uninstall')
    )
    const fmRead = fm.tools.filter((t) => t.readOnly === true).map((t) => t.name)
    const plRead = plNames.filter((n) => plugin.isReadOnlyCall(n))
    const roDiff = [
      ...fmRead.filter((n) => !plRead.includes(n)),
      ...plRead.filter((n) => !fmRead.includes(n))
    ]
    ok(
      'readOnly frontmatter set == isReadOnlyCall set',
      roDiff.length === 0 && fmRead.length > 0,
      roDiff
    )
  }

  console.log('12. indicator registry (Agent side)')
  {
    ok('INDICATORS has screen and mobile', INDICATORS.map((i) => i.id).join() === 'screen,mobile')
    let st = new Set<string>()
    st = trackIndicators(st, 'computer_glow_on', true)
    st = trackIndicators(st, 'mobile_indicator_on', false)
    ok('a failed on-call adds nothing', st.has('screen') && !st.has('mobile'))
    st = trackIndicators(st, 'mobile_indicator_on', true)
    ok('both tracked independently', st.has('screen') && st.has('mobile'))
    const last = lastIndicatorActionFrom({ mobile: { lastAction: { summary: 'Tapped x' } } })
    ok(
      'lastIndicatorActionFrom → indicator mobile',
      last?.indicator === 'mobile' && last.summary === 'Tapped x'
    )
    ok(
      'lastIndicatorActionFrom ignores unrelated meta',
      lastIndicatorActionFrom({ diff: 1 }) === null
    )
    const text = indicatorNoticeText(st, last) ?? ''
    ok(
      'notice with both on carries both notices',
      has(text, SCREEN_INDICATOR_NOTICE) && has(text, MOBILE_INDICATOR_NOTICE)
    )
    ok(
      'LAST DEVICE ACTION rides only the mobile notice',
      has(text, 'LAST DEVICE ACTION: Tapped x') && !has(text, 'LAST SCREEN ACTION')
    )
    ok('no indicator → no notice', indicatorNoticeText(new Set(), null) === undefined)
    st = trackIndicators(st, 'computer_glow_off', true)
    const ended = {
      stopReason: 'end_turn' as const,
      text: 'done',
      toolCalls: [],
      thinking: undefined
    }
    const nudge = indicatorNudge(st, ended, 0)
    const aside = String(nudge?.messages[1]?.content ?? '')
    ok(
      'nudge for mobile only → mobile_indicator_off',
      nudge?.offTool === 'mobile_indicator_off' && nudge.messages.length === 2
    )
    ok(
      '… and its text names mobile_indicator_off, not computer_glow_off',
      has(aside, 'mobile_indicator_off') && !has(aside, 'computer_glow_off')
    )
    ok(
      'nudge respects the max and none-up',
      indicatorNudge(st, ended, 2) === null && indicatorNudge(new Set(), ended, 0) === null
    )
    ok(
      'indicatorOffTools lists the off tools of the ones up',
      indicatorOffTools(st).join() === 'mobile_indicator_off'
    )
    ok(
      '… in registry order when both are up',
      indicatorOffTools(new Set(['mobile', 'screen'])).join() ===
        'computer_glow_off,mobile_indicator_off'
    )
    const agentSrc = fs.readFileSync(path.join(REPO, 'src/main/runtime/agent/Agent.ts'), 'utf8')
    const fin = agentSrc.slice(agentSrc.indexOf('    } finally {'))
    ok(
      'Agent.ts finally block runs indicatorOffTools(indicatorsOn)',
      fin.includes('indicatorOffTools(indicatorsOn)')
    )
  }

  exec.__resetExecutor()
  fs.rmSync(TMP, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

void main()
