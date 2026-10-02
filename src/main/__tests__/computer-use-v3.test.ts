/**
 * Computer use v3 — the pure seams of the plugin, run without Electron, the
 * native driver, sharp or nut-js (all of those load inside init()).
 *
 * What is guarded here and why each rule is worth a check:
 *
 * 1. Driver vocabulary: the numeric enums of the generated bindings become
 *    strings ONCE, and a thrown DriverError.Tool and an errorful ToolResult
 *    become one refusal shape. A wrong index here would report a refused
 *    click as confirmed.
 * 2. Window targeting: the topmost visible window under a point, never our
 *    own process (the driver refuses those), never a minimized window.
 * 3. Window-local pixels: global logical → the driver's capture pixels at
 *    the display's backing scale (verified live: a 2x display wants 2x).
 * 4. Elements: hit-testing picks the smallest control, containers only as a
 *    last resort; search ranks exact label matches first; secure fields are
 *    recognized.
 * 5. Access report: a missing macOS grant blocks, a missing Linux nicety
 *    limits, and every non-ok line names a fix.
 * 6. Key combos: "cmd+shift+s" and comma modifiers parse the same way, and
 *    the driver's key names differ per OS exactly where they must.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/__tests__/computer-use-v3.test.ts
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const PLUGIN = path.join(REPO, 'src/defaults/workspace/brain/cerebellum/computer-use/plugin')

let n = 0
const check = (name: string, fn: () => void | Promise<void>): Promise<void> =>
  Promise.resolve()
    .then(fn)
    .then(() => {
      n++
      console.log(`✅ ${name}`)
    })
    .catch((err: unknown) => {
      n++
      console.log(`❌ ${name}: ${(err as Error).message}`)
      process.exitCode = 1
    })

type Driver = {
  describeAction: (ar: unknown) => {
    effect: string
    route: string
    delivery: string
    evidence: string[]
    escalation: { target: string; reason: string } | null
  } | null
  refusalOf: (e: unknown) => { code: string; message: string } | null
  isBackgroundRefusal: (r: unknown) => boolean
  driverKeyName: (name: string, platform?: string) => string | null
  windowAt: (
    windows: unknown[],
    point: { x: number; y: number },
    opts?: { excludePid?: number }
  ) => { id: number } | null
  markCloaked: (windows: unknown[], ids: unknown) => Array<{ id: number; cloaked: boolean | null }>
}
type Elements = {
  elementAt: (els: unknown[], p: { x: number; y: number }) => { index: number } | null
  findElements: (els: unknown[], q: Record<string, unknown>) => Array<{ index: number }>
  describeElement: (e: unknown) => string
  friendlyRole: (r: string) => string
  isSecureField: (e: unknown) => boolean
}
type Access = {
  buildAccessReport: (i: Record<string, unknown>) => {
    ok: boolean
    items: Array<{ key: string; state: string; fix: string }>
    text: string
  }
}
type Index = {
  parseKeyCombo: (k: string, m?: string) => { key: string; modifiers: string[] }
  windowLocalPx: (
    b: { x: number; y: number },
    dip: { x: number; y: number },
    s: number
  ) => { x: number; y: number }
  frameCoordsError: (
    frame: Record<string, unknown>,
    lastCapture: Record<string, unknown> | null,
    x: number,
    y: number
  ) => string
  inheritWindowScope: (
    prev: Record<string, unknown> | null,
    region: { x: number; y: number; width: number; height: number }
  ) => Record<string, unknown>
  INDICATOR_REQUIRED: Set<string>
  backgroundUnsupported: (button: string) => { code: string; message: string } | null
  default: {
    tools: Array<{ name: string }>
    execute: (tool: string, args: Record<string, unknown>) => Promise<unknown>
  }
}

async function run(): Promise<void> {
  const driver = (await import(pathToFileURL(path.join(PLUGIN, 'driver.mjs')).href)) as Driver
  const elements = (await import(pathToFileURL(path.join(PLUGIN, 'elements.mjs')).href)) as Elements
  const access = (await import(pathToFileURL(path.join(PLUGIN, 'access.mjs')).href)) as Access
  const index = (await import(pathToFileURL(path.join(PLUGIN, 'index.mjs')).href)) as Index

  // ── 1. driver vocabulary ────────────────────────────────────────────────

  await check('numeric action results become words, in the generated order', () => {
    const a = driver.describeAction({
      effect: 0,
      route: 1,
      delivery: { mode: 0 },
      evidence: [{ kind: 0 }],
      escalation: { target: 1, reason: 0 }
    })
    assert.deepEqual(a, {
      effect: 'confirmed',
      route: 'synthetic_events',
      delivery: 'background',
      evidence: ['value_readback'],
      escalation: { target: 'foreground', reason: 'route_unavailable' }
    })
    assert.equal(driver.describeAction({ effect: 3, route: 0 })?.effect, 'suspected_noop')
    assert.equal(driver.describeAction({ effect: 4, route: 5 })?.effect, 'refused')
    assert.equal(
      driver.describeAction({ effect: 2, route: 1 })?.delivery,
      'unknown',
      'no delivery record → unknown, never background'
    )
    assert.equal(driver.describeAction(null), null)
  })

  await check('a thrown DriverError and an errorful ToolResult are one refusal shape', () => {
    const thrown = driver.refusalOf({
      tag: 'Tool',
      inner: {
        tool: 'click',
        message: 'Background scroll is unavailable',
        errorCode: 'background_unavailable'
      }
    })
    assert.deepEqual(thrown, {
      code: 'background_unavailable',
      message: 'Background scroll is unavailable',
      tool: 'click'
    })
    const result = driver.refusalOf({
      isError: true,
      errorCode: 'background_uipi_blocked',
      text: 'elevated target'
    })
    assert.equal(result?.code, 'background_uipi_blocked')
    assert.equal(driver.refusalOf({ isError: false, text: 'fine' }), null)
    assert.ok(driver.isBackgroundRefusal(thrown), 'background_* escalates')
    assert.ok(
      !driver.isBackgroundRefusal({ code: 'permission_denied' }),
      'a permission refusal is not a rung problem'
    )
  })

  await check(
    'driver key names: the OS key and forward-delete differ per platform, nothing else does',
    () => {
      assert.equal(driver.driverKeyName('cmd', 'darwin'), 'cmd')
      assert.equal(driver.driverKeyName('cmd', 'win32'), 'win')
      assert.equal(driver.driverKeyName('meta', 'linux'), 'super')
      assert.equal(driver.driverKeyName('enter', 'darwin'), 'return')
      assert.equal(driver.driverKeyName('Esc', 'linux'), 'escape')
      assert.equal(
        driver.driverKeyName('delete', 'darwin'),
        'forward_delete',
        'on macOS "delete" would be backspace'
      )
      assert.equal(driver.driverKeyName('delete', 'win32'), 'delete')
      assert.equal(driver.driverKeyName('backspace', 'darwin'), 'backspace')
      assert.equal(driver.driverKeyName('ArrowLeft', 'darwin'), 'left')
      assert.equal(driver.driverKeyName('F11', 'darwin'), 'f11')
      assert.equal(driver.driverKeyName('A', 'darwin'), 'a')
      assert.equal(driver.driverKeyName('', 'darwin'), null)
    }
  )

  // ── 2. window targeting ─────────────────────────────────────────────────

  const win = (
    id: number,
    x: number,
    y: number,
    w: number,
    h: number,
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> => ({
    id,
    pid: 100 + id,
    app: `App${id}`,
    title: '',
    bounds: { x, y, width: w, height: h },
    z: id,
    layer: 0,
    onScreen: true,
    minimized: false,
    onCurrentSpace: true,
    cloaked: null,
    ...extra
  })

  await check(
    'the topmost visible window under the point wins; ours, minimized and off-space windows never do',
    () => {
      const list = [
        win(1, 0, 0, 800, 600),
        win(2, 100, 100, 300, 300),
        win(3, 150, 150, 50, 50, { minimized: true }),
        win(4, 150, 150, 50, 50, { onCurrentSpace: false }),
        win(9, 0, 0, 800, 600, { pid: process.pid })
      ]
      assert.equal(driver.windowAt(list, { x: 160, y: 160 })?.id, 2, 'higher z under the point')
      assert.equal(driver.windowAt(list, { x: 10, y: 10 })?.id, 1)
      assert.equal(driver.windowAt(list, { x: 900, y: 900 }), null, 'bare desktop')
      const unknownZ = [win(1, 0, 0, 800, 600, { z: null }), win(2, 100, 100, 300, 300)]
      assert.equal(
        driver.windowAt(unknownZ, { x: 160, y: 160 })?.id,
        2,
        'a known stacking order beats an unknown one'
      )
    }
  )

  await check(
    'Windows: DWM-cloaked shell windows are marked from the capturable set and never targeted',
    () => {
      // Live shape from Windows 11: the Start menu, Search and a suspended
      // Settings sit above the real app in z and cover the display.
      const list = [
        win(9, 0, 0, 1920, 1032, { app: 'StartMenuExperienceHost.exe', title: 'Start' }),
        win(8, 531, 142, 858, 890, { app: 'SearchHost.exe', title: 'Search' }),
        win(7, 178, 141, 1142, 587, { app: 'Notepad.exe', title: 'Untitled - Notepad' }),
        win(2, 0, 8, 1920, 1032, { app: 'SystemSettings.exe', title: 'Settings' }),
        win(1, 0, 0, 1920, 1080, { app: 'explorer.exe', title: 'Program Manager' }),
        win(0, 50, 50, 10, 10, { title: '' })
      ]
      const marked = driver.markCloaked(list, new Set([7]))
      assert.deepEqual(
        marked.map((w) => [w.id, w.cloaked]),
        [
          [9, true],
          [8, true],
          [7, false],
          [2, true],
          [1, true],
          [0, null]
        ],
        'only the capturable window is on screen; an untitled one stays unknown'
      )
      assert.equal(
        driver.windowAt(marked, { x: 431, y: 240 })?.id,
        7,
        'the app under Start, not Start'
      )
      assert.equal(
        driver.windowAt(marked, { x: 1800, y: 1000 }),
        null,
        'a cloaked Settings is not a target either'
      )
      assert.equal(
        driver.windowAt(marked, { x: 55, y: 55 })?.id,
        0,
        'unknown cloaking does not exclude'
      )
      const untouched = driver.markCloaked(
        list.map((w) => ({ ...w, cloaked: null })),
        null
      )
      assert.ok(
        untouched.every((w) => w.cloaked === null),
        'no probe → nothing marked'
      )
      const empty = driver.markCloaked(
        list.map((w) => ({ ...w, cloaked: null })),
        new Set()
      )
      assert.ok(
        empty.every((w) => w.cloaked === null),
        'an empty probe result marks nothing'
      )
    }
  )

  await check(
    'Windows: right and middle clicks take the foreground rung; left clicks and other platforms do not',
    () => {
      const onWindows = process.platform === 'win32'
      assert.equal(index.backgroundUnsupported('left'), null)
      const right = index.backgroundUnsupported('right')
      const middle = index.backgroundUnsupported('middle')
      if (onWindows) {
        assert.equal(right?.code, 'windows_secondary_button')
        assert.equal(middle?.code, 'windows_secondary_button')
        assert.ok(right && right.message.length > 10, 'names the reason for the evidence line')
      } else {
        assert.equal(right, null)
        assert.equal(middle, null)
      }
    }
  )

  // ── 3. window-local pixels ──────────────────────────────────────────────

  await check('global logical points become the driver capture pixels at the backing scale', () => {
    const b = { x: 200, y: 200 }
    assert.deepEqual(
      index.windowLocalPx(b, { x: 315, y: 347 }, 2),
      { x: 230, y: 294 },
      'the exact numbers the live spike hit Button A with'
    )
    assert.deepEqual(index.windowLocalPx(b, { x: 315, y: 347 }, 1), { x: 115, y: 147 })
  })

  await check('a magnifier or zoom inside a window frame keeps that window as its target', () => {
    const prev = {
      scope: 'window',
      pid: 7,
      windowId: 42,
      app: 'Notes',
      title: 'Todo',
      windowBounds: { x: 200, y: 200, width: 700, height: 500 }
    }
    const inside = index.inheritWindowScope(prev, { x: 300, y: 300, width: 200, height: 125 })
    assert.equal(inside.scope, 'window')
    assert.equal(inside.windowId, 42)
    assert.deepEqual(inside.windowBounds, prev.windowBounds)
    const outside = index.inheritWindowScope(prev, { x: 850, y: 300, width: 200, height: 125 })
    assert.deepEqual(outside, {}, 'a region spilling past the window is display scope again')
    assert.deepEqual(
      index.inheritWindowScope({ scope: 'display' }, { x: 0, y: 0, width: 1, height: 1 }),
      {}
    )
    assert.deepEqual(index.inheritWindowScope(null, { x: 0, y: 0, width: 1, height: 1 }), {})
  })

  await check('word names for punctuation reach the driver as the characters themselves', () => {
    assert.equal(driver.driverKeyName('period', 'darwin'), '.')
    assert.equal(driver.driverKeyName('comma', 'win32'), ',')
    assert.equal(driver.driverKeyName('slash', 'linux'), '/')
    assert.equal(driver.driverKeyName('minus', 'darwin'), '-')
  })

  await check('an out-of-frame refusal names the earlier capture the coordinates came from', () => {
    const mag = { kind: 'magnifier', width: 600, height: 375 }
    const shot = { kind: 'screenshot', width: 1600, height: 900 }
    const msg = index.frameCoordsError(mag, shot, 1085, 300)
    assert.ok(msg.includes('600x375 magnifier'), msg)
    assert.ok(msg.includes('earlier 1600x900 screenshot'), 'must name the older capture')
    const plain = index.frameCoordsError(mag, shot, 5000, 5000)
    assert.ok(!plain.includes('earlier'), 'coordinates that fit nothing get the plain refusal')
    const fresh = index.frameCoordsError(shot, null, 2000, 10)
    assert.ok(fresh.includes('1600x900 screenshot') && !fresh.includes('earlier'))
  })

  await check(
    'a gate refusal is non-retryable so the loop does not burn three attempts on it',
    async () => {
      const r = (await index.default.execute('computer_screenshot', {})) as {
        success: boolean
        retryable?: boolean
        error?: string
      }
      assert.equal(r.success, false)
      assert.equal(r.retryable, false, 'refusals the model must fix are never retried')
    }
  )

  // ── 4. elements ─────────────────────────────────────────────────────────

  const el = (
    index: number,
    role: string,
    frame: [number, number, number, number] | null,
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> => ({
    index,
    role,
    depth: index,
    token: `s00000001:${index}`,
    label: null,
    value: null,
    valueDescription: null,
    enabled: true,
    selected: null,
    inWebContent: null,
    actions: [],
    parent: null,
    frame: frame ? { x: frame[0], y: frame[1], width: frame[2], height: frame[3] } : null,
    ...extra
  })

  await check(
    'hit-testing picks the smallest control under the point, a container only when nothing else is there',
    () => {
      const tree = [
        el(0, 'AXWindow', [0, 0, 800, 600]),
        el(1, 'AXGroup', [0, 0, 800, 600]),
        el(2, 'AXButton', [100, 100, 30, 30], { label: 'A' }),
        el(3, 'AXButton', [110, 110, 16, 16], { label: 'tiny' }),
        el(4, 'AXStaticText', null, { label: 'no frame' })
      ]
      assert.equal(
        elements.elementAt(tree, { x: 115, y: 115 })?.index,
        3,
        'smallest containing control'
      )
      assert.equal(elements.elementAt(tree, { x: 102, y: 102 })?.index, 2)
      assert.equal(
        elements.elementAt(tree, { x: 500, y: 500 })?.index,
        1,
        'the smallest container as a fallback'
      )
      assert.equal(elements.elementAt(tree, { x: 900, y: 900 }), null)
    }
  )

  await check(
    'search ranks exact label, then prefix, then contains, then value; role filters',
    () => {
      const tree = [
        el(0, 'AXButton', [0, 0, 10, 10], { label: 'Save As…' }),
        el(1, 'AXButton', [0, 0, 10, 10], { label: 'Save' }),
        el(2, 'AXStaticText', [0, 0, 10, 10], { value: 'Please save your work' }),
        el(3, 'AXTextField', [0, 0, 10, 10], { label: 'Name' })
      ]
      const hits = elements.findElements(tree, { text: 'save' })
      assert.deepEqual(
        hits.map((h) => h.index),
        [1, 0, 2]
      )
      assert.deepEqual(
        elements.findElements(tree, { role: 'text field' }).map((h) => h.index),
        [3]
      )
      assert.deepEqual(
        elements.findElements(tree, { role: 'button', text: 'as' }).map((h) => h.index),
        [0]
      )
      assert.equal(elements.findElements(tree, { text: 'nothing' }).length, 0)
    }
  )

  await check('elements read as words a person recognizes', () => {
    assert.equal(elements.friendlyRole('AXPopUpButton'), 'dropdown')
    assert.equal(elements.friendlyRole('AXSecureTextField'), 'password field')
    assert.equal(elements.friendlyRole('ControlType.CheckBox'), 'checkbox')
    assert.equal(
      elements.describeElement(el(1, 'AXButton', null, { label: 'Close tab' })),
      'button "Close tab"'
    )
    assert.equal(
      elements.describeElement(el(1, 'AXTextField', null, { label: 'Name', value: 'Ada' })),
      'text field "Name" (value: Ada)'
    )
    assert.equal(
      elements.describeElement(el(1, 'AXButton', null, { label: 'Go', enabled: false })),
      'button "Go" (disabled)'
    )
    assert.ok(elements.isSecureField(el(1, 'AXSecureTextField', null)))
    assert.ok(!elements.isSecureField(el(1, 'AXTextField', null)))
    // Windows UIA reports a web password input as a plain edit named after
    // its label (verified live: 'edit "Password" [web content]'); the name is
    // the only signal, so a text-entry role with a password-like name counts.
    assert.ok(elements.isSecureField(el(1, 'edit', null, { label: 'Password' })))
    assert.ok(
      elements.isSecureField(el(1, 'ControlType.Edit', null, { label: 'Confirm passphrase' }))
    )
    assert.ok(elements.isSecureField(el(1, 'AXTextField', null, { label: 'كلمة المرور' })))
    assert.ok(
      !elements.isSecureField(el(1, 'AXButton', null, { label: 'Show password' })),
      'only text entry roles'
    )
    assert.ok(!elements.isSecureField(el(1, 'edit', null, { label: 'Username' })))
  })

  // ── 5. access report ────────────────────────────────────────────────────

  await check(
    'a missing macOS grant BLOCKS and names the settings pane; a granted machine is ready',
    () => {
      const blocked = access.buildAccessReport({
        platform: 'darwin',
        driver: { available: true },
        mac: { accessibility: true, screenRecording: false },
        overlayAvailable: true
      })
      assert.equal(blocked.ok, false)
      assert.ok(blocked.text.startsWith('Computer use is BLOCKED on macOS: Screen Recording'))
      const item = blocked.items.find((i) => i.key === 'screenRecording')
      assert.equal(item?.state, 'missing')
      assert.ok(item?.fix.includes('Privacy & Security') && item.fix.includes('restart'))
      assert.ok(blocked.text.includes('ask_user'), 'the model is told how to hand off')
      const ready = access.buildAccessReport({
        platform: 'darwin',
        driver: { available: true },
        mac: { accessibility: true, screenRecording: true },
        overlayAvailable: true
      })
      assert.equal(ready.ok, true)
      assert.ok(ready.text.startsWith('Computer use is ready on macOS.'))
    }
  )

  await check(
    'Linux niceties limit but never block; a missing driver is a limit with a reason',
    () => {
      const r = access.buildAccessReport({
        platform: 'linux',
        driver: { available: false, error: 'dlopen failed' },
        linux: { sessionType: 'wayland', desktop: 'KDE', uinput: false, atspi: true },
        overlayAvailable: true
      })
      assert.equal(r.ok, true)
      assert.ok(r.text.includes('with limits'))
      assert.ok(r.text.includes('Wayland session: limited') && r.text.includes('KDE'))
      assert.ok(r.text.includes('dlopen failed'))
      for (const i of r.items)
        if (i.state !== 'ok') assert.ok(i.fix.length > 10, `${i.key} must carry a fix`)
    }
  )

  // ── 6. key combos ───────────────────────────────────────────────────────

  await check('"cmd+shift+s" and key + modifiers parse to the same shape', () => {
    assert.deepEqual(index.parseKeyCombo('cmd+shift+s'), { key: 's', modifiers: ['cmd', 'shift'] })
    assert.deepEqual(index.parseKeyCombo('s', 'cmd, shift'), {
      key: 's',
      modifiers: ['cmd', 'shift']
    })
    assert.deepEqual(index.parseKeyCombo('+'), { key: '+', modifiers: [] }, 'a bare plus is a key')
    assert.deepEqual(index.parseKeyCombo('enter'), { key: 'enter', modifiers: [] })
  })

  // ── 7. the surfaces agree ───────────────────────────────────────────────

  await check('every gated tool is a real tool, and every screen-touching tool is gated', () => {
    const names = new Set(index.default.tools.map((t) => t.name))
    for (const g of index.INDICATOR_REQUIRED) assert.ok(names.has(g), `${g} gated but not defined`)
    const open = [...names].filter((t) => !index.INDICATOR_REQUIRED.has(t))
    assert.deepEqual(
      open.sort(),
      [
        'computer_batch',
        'computer_check_access',
        'computer_clipboard_read',
        'computer_clipboard_write',
        'computer_glow_off',
        'computer_glow_on',
        'computer_list_displays',
        'computer_wait'
      ],
      'only tools that neither see nor touch the screen stay open (batch gates its members)'
    )
  })

  console.log(`\n${n} checks run`)
}

run().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
