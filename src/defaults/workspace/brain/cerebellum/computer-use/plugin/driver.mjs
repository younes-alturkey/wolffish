/**
 * The native driver seam: cua's Rust driver (`@trycua/cua-driver`, MIT)
 * loaded in-process, wrapped so the rest of the plugin never touches its
 * enums, bigints or thrown error shapes.
 *
 * Why cua: it is the one cross-platform driver that posts input to a target
 * WINDOW without moving the real pointer or raising the window — SkyLight
 * `SLEventPostToPid` on macOS, synthetic pointer injection / PostMessage on
 * Windows, XSendEvent + AT-SPI on X11 — and that answers with a structured
 * refusal (`background_unavailable`, `background_occluded`,
 * `background_uipi_blocked`) instead of a silent no-op when a background
 * route does not exist. That refusal is what lets the plugin escalate on
 * purpose (see the delivery ladder in index.mjs) and tell the model exactly
 * what happened.
 *
 * Everything here is best-effort: when the package or its native library is
 * missing (offline first install, an unsupported CPU, a dev checkout without
 * the dependency) `load()` reports `available: false` and the plugin runs on
 * the foreground fallback alone. Nothing in this file throws to a tool.
 *
 * Verified live 2026-09-15 on macOS 26.6 / Electron 39.8 against a separate
 * Chromium process with DOM ground truth: background click lands on the
 * exact pixel (16px target included), double/right click, typing and key
 * chords arrive, the real pointer does not move, the frontmost app does not
 * change, background scroll into Chromium is refused with a code, and a
 * content-protected Electron overlay is invisible to `get_desktop_state`.
 */

let sdk = null
let driver = null
let loadError = null
let toolNames = new Set()
let platformLabel = process.platform

const j = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x)))

// ─── Enum vocabulary (numeric in the generated bindings) ───────────────

export const EFFECT = ['confirmed', 'partial', 'unverifiable', 'suspected_noop', 'refused']
export const ROUTE = ['accessibility', 'synthetic_events', 'global_input', 'system_api', 'dom', 'trusted_input']
export const DELIVERY = ['background', 'foreground', 'not_applicable', 'unknown']
export const ESCALATION_TARGET = ['pixel', 'foreground', 'page', 'session']
export const ESCALATION_REASON = ['route_unavailable', 'delivery_failed', 'effect_unconfirmed', 'suspected_noop', 'permission_required']
export const EVIDENCE_KIND = ['value_readback', 'window_change']
export const VERIFY_STATUS = ['satisfied', 'unsatisfied', 'unknown']
export const UNKNOWN_REASON = [
  'invalid_predicate',
  'unsupported_predicate',
  'untrusted_source',
  'multi_match',
  'target_missing',
  'observation_unavailable',
  'stability_unproven'
]

/** Refusal codes that mean "this route cannot deliver here" — escalate, do not retry. */
export const BACKGROUND_REFUSALS = new Set([
  'background_unavailable',
  'background_occluded',
  'background_uipi_blocked',
  'route_unavailable'
])

/**
 * Normalize an ActionResult (or the `action` field of a ToolResult) into
 * plain strings. Pure; exported for tests.
 */
export function describeAction(ar) {
  if (!ar || typeof ar !== 'object') return null
  const num = (v) => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : -1)
  return {
    effect: EFFECT[num(ar.effect)] ?? 'unverifiable',
    route: ROUTE[num(ar.route)] ?? 'unknown',
    delivery: ar.delivery ? (DELIVERY[num(ar.delivery.mode)] ?? 'unknown') : 'unknown',
    evidence: Array.isArray(ar.evidence) ? ar.evidence.map((e) => EVIDENCE_KIND[num(e.kind)] ?? 'unknown') : [],
    escalation: ar.escalation
      ? {
          target: ESCALATION_TARGET[num(ar.escalation.target)] ?? 'unknown',
          reason: ESCALATION_REASON[num(ar.escalation.reason)] ?? 'unknown'
        }
      : null
  }
}

/**
 * The driver throws `DriverError.Tool` with the real message and code on
 * `inner`; a ToolResult carries them as `isError` + `errorCode`. Both become
 * one shape here. Pure; exported for tests.
 */
export function refusalOf(errOrResult) {
  if (!errOrResult) return null
  const inner = errOrResult.inner
  if (inner && typeof inner === 'object' && (inner.message || inner.errorCode)) {
    return { code: String(inner.errorCode ?? 'error'), message: String(inner.message ?? 'driver error'), tool: inner.tool ?? null }
  }
  if (errOrResult.isError === true) {
    return { code: String(errOrResult.errorCode ?? 'error'), message: String(errOrResult.text ?? 'driver error'), tool: null }
  }
  if (errOrResult instanceof Error) {
    return { code: 'error', message: errOrResult.message, tool: null }
  }
  return null
}

export function isBackgroundRefusal(refusal) {
  return !!refusal && BACKGROUND_REFUSALS.has(refusal.code)
}

// ─── Key vocabulary ─────────────────────────────────────────────────────

// Wolffish key names (what the model types) → the driver's names. The three
// platform crates agree on the common set; the two that differ are the
// forward-delete key and the OS key.
const KEY_ALIASES = {
  period: '.',
  dot: '.',
  comma: ',',
  slash: '/',
  backslash: '\\',
  semicolon: ';',
  colon: ':',
  quote: "'",
  apostrophe: "'",
  minus: '-',
  dash: '-',
  hyphen: '-',
  equal: '=',
  equals: '=',
  plus: '+',
  grave: '`',
  backtick: '`',
  bracketleft: '[',
  bracketright: ']',
  enter: 'return',
  return: 'return',
  esc: 'escape',
  escape: 'escape',
  backspace: 'backspace',
  del: 'delete',
  delete: 'delete',
  space: 'space',
  tab: 'tab',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  pgup: 'pageup',
  pageup: 'pageup',
  pgdn: 'pagedown',
  pagedown: 'pagedown',
  home: 'home',
  end: 'end',
  capslock: 'capslock'
}

const MOD_ALIASES = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
  meta: 'os',
  cmd: 'os',
  command: 'os',
  super: 'os',
  win: 'os',
  windows: 'os'
}

/** Map a Wolffish key or modifier name to the driver's vocabulary. Pure. */
export function driverKeyName(name, platform = process.platform) {
  const lower = String(name ?? '').trim().toLowerCase()
  if (!lower) return null
  if (MOD_ALIASES[lower]) {
    const mod = MOD_ALIASES[lower]
    if (mod !== 'os') return mod
    return platform === 'darwin' ? 'cmd' : platform === 'win32' ? 'win' : 'super'
  }
  if (lower === 'delete' || lower === 'del') {
    // macOS names the forward-delete key differently; "delete" there is backspace.
    return platform === 'darwin' ? 'forward_delete' : 'delete'
  }
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower]
  if (/^f([1-9]|1[0-2])$/.test(lower)) return lower
  if (lower.length === 1) return lower
  return lower
}

export function isModifierName(name) {
  return !!MOD_ALIASES[String(name ?? '').trim().toLowerCase()]
}

// ─── Loading ────────────────────────────────────────────────────────────

/**
 * Load the SDK and create the in-process runtime. Idempotent. Never throws.
 * Returns the status the plugin reports to the model through
 * computer_check_access.
 */
export async function load({ log = () => {} } = {}) {
  if (driver) return status()
  if (loadError) return status()
  try {
    sdk = await import('@trycua/cua-driver')
    driver = sdk.CuaDriver.create({ claudeCodeCompatibility: false })
    try {
      const names = JSON.parse(await driver.listToolsJson())
      const list = Array.isArray(names) ? names : Array.isArray(names?.tools) ? names.tools : []
      toolNames = new Set(list.map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean))
    } catch {
      toolNames = new Set()
    }
    try {
      const meta = j(await driver.metadata())
      platformLabel = meta?.platform ?? process.platform
      log(`[computer-use] native driver ready (${JSON.stringify(meta).slice(0, 160)})`)
    } catch {
      log('[computer-use] native driver ready')
    }
  } catch (err) {
    driver = null
    loadError = err?.message ?? String(err)
    log(`[computer-use] native driver unavailable: ${loadError}`)
  }
  return status()
}

/**
 * The driver's implicit session expires after five minutes idle (cua
 * DEFAULT_SESSION_IDLE_TTL). A model that sits silent for longer — one
 * stalled API call is enough (observed 2026-09-15) — comes back to every
 * call refusing with `session_ended`. Two answers: a keepalive ping while
 * the indicator is on (index.mjs drives it), and a transparent recycle +
 * single retry the moment a call reports the session gone.
 */
export const SESSION_KEEPALIVE_MS = 4 * 60_000

export function isSessionEnded(refusal) {
  return !!refusal && (refusal.code === 'session_ended' || /session has ended/i.test(refusal.message ?? ''))
}

/** Tear the runtime down and create a fresh one; the next call starts a new implicit session. */
export async function recycle({ log = () => {} } = {}) {
  const d = driver
  driver = null
  loadError = null
  if (d) {
    try {
      await d.shutdown()
    } catch {
      // Already down.
    }
    try {
      d.uniffiDestroy()
    } catch {
      // Already destroyed.
    }
  }
  log('[computer-use] native driver session ended — recycling the runtime')
  return load({ log })
}

/** A cheap call that touches the session so it does not expire between actions. */
export async function ping() {
  if (!driver) return false
  try {
    await driver.getScreenSize({})
    return true
  } catch (err) {
    return !isSessionEnded(refusalOf(err))
  }
}

/**
 * Run a driver call; when the session has ended, recycle once and run it
 * again. `fn` must read `driver` fresh on every invocation (it does — every
 * caller passes an arrow over the module binding).
 */
async function withSession(fn) {
  try {
    return await fn()
  } catch (err) {
    if (!isSessionEnded(refusalOf(err))) throw err
    await recycle()
    return fn()
  }
}

export function status() {
  return {
    available: !!driver,
    error: loadError,
    tools: [...toolNames],
    platform: platformLabel
  }
}

export function hasTool(name) {
  return toolNames.has(name)
}

export async function unload() {
  const d = driver
  driver = null
  if (!d) return
  try {
    await d.shutdown()
  } catch {
    // Already down.
  }
  try {
    d.uniffiDestroy()
  } catch {
    // Already destroyed.
  }
}

/** macOS TCC probes run in this process so the OS attributes them to the app. */
export async function macPermissions() {
  try {
    const el = await import('@trycua/cua-driver/electron')
    return el.requestMacOSPermissions()
  } catch {
    return null
  }
}

// ─── Targets ────────────────────────────────────────────────────────────

export function windowTarget(pid, windowId) {
  return new sdk.ActionTarget.Window({ pid: Number(pid), windowId: BigInt(windowId) })
}

export function desktopTarget() {
  return new sdk.ActionTarget.Desktop({ displayId: 'primary' })
}

function normalizeWindow(w) {
  return {
    id: Number(w.windowId),
    pid: typeof w.pid === 'number' ? w.pid : null,
    app: w.appName ?? '',
    title: w.title ?? '',
    bounds: { x: w.bounds.x, y: w.bounds.y, width: w.bounds.width, height: w.bounds.height },
    z: w.zIndex == null ? null : Number(w.zIndex),
    layer: w.layer ?? null,
    onScreen: !!w.isOnScreen,
    minimized: w.minimized ?? null,
    onCurrentSpace: w.onCurrentSpace ?? null,
    // Windows only: DWM-cloaked (see markCloaked). Null where unknown.
    cloaked: null
  }
}

/**
 * Windows keeps shell surfaces — the Start menu, Search, the notification
 * center, every suspended UWP app such as a closed Settings — as top-level
 * windows that are "visible" to EnumWindows but DWM-cloaked: they sit at the
 * top of the stacking order, cover the whole display and receive nothing.
 * The driver lists them as on screen (verified live on Windows 11 26200: a
 * background click meant for an app went to StartMenuExperienceHost "Start"
 * and vanished). Chromium's window enumeration skips cloaked and tool
 * windows, so the ids Electron's desktopCapturer can see are the windows
 * really on screen; everything else is marked cloaked. An empty title is
 * left alone because Chromium skips those too, cloaked or not. Pure;
 * exported for tests.
 */
export function markCloaked(windows, capturableIds) {
  if (!(capturableIds instanceof Set) || capturableIds.size === 0) return windows
  for (const w of windows) {
    if (w.cloaked === true) continue
    if (!w.title) continue
    w.cloaked = !capturableIds.has(w.id)
  }
  return windows
}

/**
 * Windows the driver can see, normalized. `bounds` are logical screen points
 * with a top-left origin on every platform (the driver converts).
 */
export async function listWindows({ pid = undefined, onScreenOnly = true } = {}) {
  if (!driver) return []
  const out = await withSession(() => driver.listWindows({ pid, onScreenOnly }))
  return out.windows.map(normalizeWindow)
}

export async function listApps() {
  if (!driver) return []
  const out = await withSession(() => driver.listApps({}))
  return out.apps.map((a) => ({
    pid: a.pid,
    name: a.name,
    bundleId: a.bundleId ?? null,
    active: !!a.active,
    running: !!a.running,
    kind: a.kind ?? null
  }))
}

/**
 * The topmost visible window under a logical screen point, ignoring our own
 * process (the driver refuses to act on it anyway) and windows that are
 * minimized or off the current space. Null when the point is bare desktop.
 */
export function windowAt(windows, point, { excludePid = process.pid } = {}) {
  const inside = windows.filter((w) => {
    if (w.pid === excludePid) return false
    if (!w.onScreen || w.minimized === true || w.onCurrentSpace === false || w.cloaked === true) return false
    if (w.layer != null && w.layer !== 0) return false
    const b = w.bounds
    return point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height
  })
  if (inside.length === 0) return null
  // Higher z is closer to the front; unknown z sorts last so a known
  // stacking order always wins over a guess.
  inside.sort((a, b) => (b.z ?? -Infinity) - (a.z ?? -Infinity))
  return inside[0]
}

// ─── Actions ────────────────────────────────────────────────────────────

const BUTTON = { left: 0, right: 1, middle: 2 }

/**
 * Click inside a window. `px` is in the window's own capture pixels (top-left
 * of the window frame, title bar included, at the display's backing scale) —
 * exactly what the driver's window-scope contract expects. Returns
 * `{ ok, action, refusal }`; never throws.
 */
export async function clickWindow({ pid, windowId, px, button = 'left', count = 1, foreground = false }) {
  if (!driver) return { ok: false, refusal: { code: 'driver_unavailable', message: 'native driver not loaded' } }
  try {
    const result = await withSession(() => driver.click({
      target: windowTarget(pid, windowId),
      position: new sdk.ClickPosition.Coordinates({ x: Math.round(px.x), y: Math.round(px.y) }),
      deliveryMode: foreground ? sdk.InputDeliveryMode.Foreground : sdk.InputDeliveryMode.Background,
      button: BUTTON[button] ?? 0,
      count: Math.max(1, Math.min(3, Number(count) || 1))
    }))
    return { ok: true, action: describeAction(result), refusal: null }
  } catch (err) {
    return { ok: false, action: null, refusal: refusalOf(err) ?? { code: 'error', message: String(err) } }
  }
}

export async function clickElement({ pid, windowId, token, button = 'left', count = 1, foreground = false }) {
  if (!driver) return { ok: false, refusal: { code: 'driver_unavailable', message: 'native driver not loaded' } }
  try {
    const result = await withSession(() => driver.click({
      target: windowTarget(pid, windowId),
      position: new sdk.ClickPosition.Element({ elementToken: String(token) }),
      deliveryMode: foreground ? sdk.InputDeliveryMode.Foreground : sdk.InputDeliveryMode.Background,
      button: BUTTON[button] ?? 0,
      count: Math.max(1, Math.min(3, Number(count) || 1))
    }))
    return { ok: true, action: describeAction(result), refusal: null }
  } catch (err) {
    return { ok: false, action: null, refusal: refusalOf(err) ?? { code: 'error', message: String(err) } }
  }
}

function toolOutcome(result) {
  const refusal = result?.isError ? refusalOf(result) : null
  return {
    ok: !result?.isError,
    text: result?.text ?? '',
    action: describeAction(result?.action),
    refusal,
    degraded: !!result?.degraded,
    structured: safeParse(result?.structuredJson),
    images: Array.isArray(result?.images) ? result.images : [],
    verification: result?.verification ?? null
  }
}

function safeParse(s) {
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

async function guarded(fn) {
  if (!driver) return { ok: false, text: '', action: null, refusal: { code: 'driver_unavailable', message: 'native driver not loaded' }, images: [], structured: null }
  try {
    let result = await withSession(fn)
    // A ToolResult can carry the refusal in-band instead of throwing.
    if (result?.isError && isSessionEnded(refusalOf(result))) {
      await recycle()
      result = await fn()
    }
    return toolOutcome(result)
  } catch (err) {
    return { ok: false, text: '', action: null, refusal: refusalOf(err) ?? { code: 'error', message: String(err) }, images: [], structured: null }
  }
}

/** Background typing into a window (the driver picks the route per app). */
export function typeText({ pid, windowId, text }) {
  return guarded(() => driver.typeText({ text: String(text), target: windowTarget(pid, windowId) }))
}

export function pressKey({ pid, windowId, key, modifiers = [] }) {
  return guarded(() =>
    driver.pressKey({
      key: driverKeyName(key),
      modifiers: modifiers.map((m) => driverKeyName(m)).filter(Boolean),
      target: windowTarget(pid, windowId)
    })
  )
}

export function hotkey({ pid, windowId, keys }) {
  return guarded(() => driver.hotkey({ keys: keys.map((k) => driverKeyName(k)).filter(Boolean), target: windowTarget(pid, windowId) }))
}

const SCROLL_DIR = { up: 0, down: 1, left: 2, right: 3 }

/** `px` in window capture pixels, like clickWindow. */
export function scrollWindow({ pid, windowId, px, direction, amount = 3, by = 'lines' }) {
  return guarded(() =>
    driver.scroll({
      x: Math.round(px.x),
      y: Math.round(px.y),
      direction: SCROLL_DIR[direction] ?? 1,
      target: windowTarget(pid, windowId),
      by: by === 'pages' ? 1 : 0,
      amount: BigInt(Math.max(1, Math.round(Number(amount) || 1)))
    })
  )
}

export function dragWindow({ pid, windowId, from, to, button = 'left', durationMs = 400, modifiers = [] }) {
  return guarded(() =>
    driver.drag({
      fromX: Math.round(from.x),
      fromY: Math.round(from.y),
      toX: Math.round(to.x),
      toY: Math.round(to.y),
      target: windowTarget(pid, windowId),
      durationMs: BigInt(Math.max(50, Math.round(durationMs))),
      steps: BigInt(Math.max(4, Math.min(60, Math.round(durationMs / 16)))),
      button: BUTTON[button] ?? 0,
      modifier: modifiers.map((m) => driverKeyName(m)).filter(Boolean)
    })
  )
}

/**
 * One exact window: elements (optionally filtered by `query`) and/or a
 * native-resolution screenshot. Elements come back with logical screen
 * frames and snapshot-bound tokens.
 */
export async function windowState({ pid, windowId, tree = true, screenshot = false, query = undefined, maxElements = 400, maxDepth = 14 }) {
  if (!driver) return { ok: false, refusal: { code: 'driver_unavailable', message: 'native driver not loaded' } }
  try {
    const ws = await withSession(() => driver.getWindowState({
      pid: Number(pid),
      windowId: BigInt(windowId),
      includeAccessibilityTree: !!tree,
      includeScreenshot: !!screenshot,
      query,
      maxElements: Math.max(1, Math.min(2000, Number(maxElements) || 400)),
      maxDepth: Math.max(1, Math.min(30, Number(maxDepth) || 14))
    }))
    return {
      ok: true,
      snapshotId: ws.snapshotId ?? null,
      app: ws.appName ?? '',
      title: ws.windowTitle ?? '',
      elements: (ws.elements ?? []).map((e) => ({
        index: Number(e.elementIndex),
        role: e.role,
        depth: e.depth,
        token: e.elementToken ?? null,
        label: e.label ?? null,
        value: e.value ?? null,
        valueDescription: e.valueDescription ?? null,
        enabled: e.enabled ?? null,
        selected: e.selected ?? null,
        inWebContent: e.inWebContent ?? null,
        actions: e.actions ?? [],
        parent: e.parentIndex == null ? null : Number(e.parentIndex),
        frame: e.frame ? { x: e.frame.x, y: e.frame.y, width: e.frame.w, height: e.frame.h } : null
      })),
      treeMarkdown: ws.treeMarkdown ?? null,
      counts: {
        total: ws.totalElementCount == null ? null : Number(ws.totalElementCount),
        returned: ws.returnedElementCount == null ? null : Number(ws.returnedElementCount),
        complete: ws.elementsComplete ?? null
      },
      degraded: ws.degraded ?? false,
      degradedReason: ws.degradedReason ?? null,
      truncated: ws.truncated ?? false,
      truncationReason: ws.truncationReason ?? null,
      screenshot: ws.images[0]
        ? {
            mimeType: ws.images[0].mimeType,
            base64: ws.images[0].dataBase64,
            width: ws.screenshotWidth ?? null,
            height: ws.screenshotHeight ?? null,
            scale: ws.screenshotScale ?? null,
            frameValid: ws.screenshotFrameValid ?? null
          }
        : null,
      windowBounds: ws.windowBounds ? { ...ws.windowBounds } : null
    }
  } catch (err) {
    return { ok: false, refusal: refusalOf(err) ?? { code: 'error', message: String(err) } }
  }
}

/**
 * Bounded, deterministic wait on one window: element exists / value equals /
 * window exists. Returns the normalized verification.
 */
export async function verifyState({ pid, windowId, expect, timeoutMs = 5000, stableSamples = 2 }) {
  if (!driver) return { ok: false, refusal: { code: 'driver_unavailable', message: 'native driver not loaded' } }
  try {
    const r = await withSession(() => driver.verifyState({
      pid: BigInt(pid),
      windowId: BigInt(windowId),
      expect,
      timeoutMs: BigInt(Math.max(0, Math.round(timeoutMs))),
      stableSamples: BigInt(Math.max(1, Math.round(stableSamples)))
    }))
    const v = r.verification
    return {
      ok: !r.isError,
      text: r.text,
      status: v ? (VERIFY_STATUS[Number(v.status)] ?? 'unknown') : 'unknown',
      stable: v ? !!v.stable : false,
      elapsedMs: v ? Number(v.elapsedMs) : 0,
      samples: v ? Number(v.samples) : 0,
      predicates: v
        ? v.predicates.map((p) => ({
            index: Number(p.index),
            status: VERIFY_STATUS[Number(p.status)] ?? 'unknown',
            unknownReason: p.unknownReason == null ? null : (UNKNOWN_REASON[Number(p.unknownReason)] ?? 'unknown'),
            observed: safeParse(p.observedJson)
          }))
        : [],
      refusal: r.isError ? refusalOf(r) : null
    }
  } catch (err) {
    return { ok: false, refusal: refusalOf(err) ?? { code: 'error', message: String(err) } }
  }
}

export function invokeMenu({ pid, windowId, path }) {
  return guarded(() => driver.invokeMenu({ pid: Number(pid), windowId: BigInt(windowId), path: path.map(String) }))
}

export async function clipboardRead() {
  if (!driver) return null
  try {
    const r = await driver.clipboardRead({ includeText: true })
    const s = safeParse(r.structuredJson)
    return { text: s?.text ?? null, types: s?.types ?? [], supported: s?.supported !== false }
  } catch {
    return null
  }
}

export function clipboardWrite({ text = undefined, imagePath = undefined, filePath = undefined }) {
  return guarded(() => driver.clipboardWrite({ text, imagePath, filePath }))
}

/** Escape hatch into platform-specific registry tools (bring_to_front, set_value, …). */
export function callTool(name, args) {
  return guarded(() => driver.callTool(name, JSON.stringify(args ?? {})))
}

// ─── Foreground rung for keys and text ──────────────────────────────────
//
// The typed SDK only carries a delivery mode on click; the registry tools
// take one for everything. 'foreground' is the driver's own escalation: a
// brief foreground swap, real input (SendInput / CGEvent), the previous
// foreground restored. Used only after the background rung was refused —
// the driver documents fronting up-front as a bug.

function foregroundArgs(pid, windowId, extra) {
  return { pid: Number(pid), window_id: Number(windowId), delivery_mode: 'foreground', ...extra }
}

export function typeTextForeground({ pid, windowId, text }) {
  return callTool('type_text', foregroundArgs(pid, windowId, { text: String(text) }))
}

export function pressKeyForeground({ pid, windowId, key, modifiers = [] }) {
  return callTool('press_key', foregroundArgs(pid, windowId, { key: driverKeyName(key), modifiers: modifiers.map((m) => driverKeyName(m)).filter(Boolean) }))
}

export function hotkeyForeground({ pid, windowId, keys }) {
  return callTool('hotkey', foregroundArgs(pid, windowId, { keys: keys.map((k) => driverKeyName(k)).filter(Boolean) }))
}

