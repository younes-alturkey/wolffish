/**
 * The element route: one window's accessibility tree (macOS AX, Windows
 * UIA, Linux AT-SPI, all through the native driver) as a second way to
 * ground a target — find by text or role, click by snapshot-bound token,
 * read a field — and as the cheap cross-check on every pixel click: the
 * element under the point is echoed back so the model can compare it with
 * what it meant to hit.
 *
 * Pure helpers here take a normalized window state (driver.windowState) and
 * never touch the driver; the small cache at the bottom is the only state.
 */

const ROLE_WORDS = [
  ['securetextfield', 'password field'],
  ['textfield', 'text field'],
  ['textarea', 'text area'],
  ['statictext', 'text'],
  ['checkbox', 'checkbox'],
  ['radiobutton', 'radio button'],
  ['popupbutton', 'dropdown'],
  ['menubutton', 'menu button'],
  ['menubaritem', 'menu bar item'],
  ['menuitem', 'menu item'],
  ['menubar', 'menu bar'],
  ['menu', 'menu'],
  ['button', 'button'],
  ['link', 'link'],
  ['image', 'image'],
  ['slider', 'slider'],
  ['tab', 'tab'],
  ['toolbar', 'toolbar'],
  ['scrollarea', 'scroll area'],
  ['scrollbar', 'scrollbar'],
  ['table', 'table'],
  ['row', 'row'],
  ['cell', 'cell'],
  ['list', 'list'],
  ['outline', 'outline'],
  ['group', 'group'],
  ['window', 'window'],
  ['webarea', 'web area'],
  ['heading', 'heading'],
  ['combobox', 'combo box'],
  ['incrementor', 'stepper'],
  ['disclosuretriangle', 'disclosure'],
  ['splitter', 'splitter'],
  ['sheet', 'sheet'],
  ['dialog', 'dialog']
]

/** "AXPopUpButton" / "ControlType.Button" / "push button" → a plain word. Pure. */
export function friendlyRole(role) {
  const raw = String(role ?? '').trim()
  if (!raw) return 'element'
  const key = raw.replace(/^AX/, '').replace(/^ControlType\./, '').replace(/[\s_-]/g, '').toLowerCase()
  for (const [needle, word] of ROLE_WORDS) if (key === needle) return word
  for (const [needle, word] of ROLE_WORDS) if (key.endsWith(needle)) return word
  return raw.replace(/^AX/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
}

// Text-entry roles across the three trees (AX, UIA, AT-SPI).
const TEXT_ENTRY_ROLE = /textfield|textarea|securetextfield|edit|entry|text$/i
// Windows UIA (and often AT-SPI) expose a web password input as a plain
// edit whose only tell is its accessible name (verified live on Windows 11:
// 'edit "Password" [web content]'). The name decides there.
const PASSWORD_NAME = /\bpass(word|code|phrase)\b|\bpwd\b|كلمة (المرور|السر)/i

export function isSecureField(element) {
  const role = String(element?.role ?? '').toLowerCase()
  if (role.includes('secure') || role.includes('password')) return true
  const key = role.replace(/^ax/, '').replace(/^controltype\./, '').replace(/[\s_-]/g, '')
  if (!TEXT_ENTRY_ROLE.test(key)) return false
  const name = `${element?.label ?? ''} ${element?.valueDescription ?? ''}`
  return PASSWORD_NAME.test(name)
}

/** `button "Close tab"` — how an element reads in tool output. Pure. */
export function describeElement(element) {
  if (!element) return 'nothing'
  const role = friendlyRole(element.role)
  const name = element.label || element.valueDescription || null
  const value = element.value != null && element.value !== '' ? element.value : null
  let text = role
  if (name) text += ` "${String(name).slice(0, 80)}"`
  if (!name && value != null) text += ` "${String(value).slice(0, 80)}"`
  else if (value != null && role !== 'text' && String(value).length <= 60) text += ` (value: ${value})`
  if (element.enabled === false) text += ' (disabled)'
  if (element.inWebContent) text += ' [web content]'
  return text
}

function area(frame) {
  return Math.max(0, frame.width) * Math.max(0, frame.height)
}

function contains(frame, point) {
  return (
    !!frame &&
    frame.width > 0 &&
    frame.height > 0 &&
    point.x >= frame.x &&
    point.x < frame.x + frame.width &&
    point.y >= frame.y &&
    point.y < frame.y + frame.height
  )
}

// Containers that merely surround the point say nothing about what a click
// would hit; they only win when nothing more specific is there.
const CONTAINER_ROLES = /window|group|scrollarea|webarea|splitgroup|layoutarea|toolbar|list|table|outline|sheet|dialog|application/i

/**
 * The element a click at a global logical point would most plausibly hit:
 * the smallest non-container element whose frame contains the point (ties
 * broken by depth), else the smallest container. Null when nothing there.
 * Pure; exported for tests.
 */
export function elementAt(elements, point) {
  let best = null
  let bestArea = Infinity
  let bestContainer = null
  let bestContainerArea = Infinity
  for (const e of elements ?? []) {
    if (!e.frame || !contains(e.frame, point)) continue
    const a = area(e.frame)
    if (CONTAINER_ROLES.test(String(e.role).replace(/^AX/, ''))) {
      if (a < bestContainerArea || (a === bestContainerArea && (e.depth ?? 0) > (bestContainer?.depth ?? 0))) {
        bestContainer = e
        bestContainerArea = a
      }
      continue
    }
    if (a < bestArea || (a === bestArea && (e.depth ?? 0) > (best?.depth ?? 0))) {
      best = e
      bestArea = a
    }
  }
  return best ?? bestContainer
}

/**
 * Case-insensitive search by text (label, value, description) and/or role.
 * Ranking: exact label match, then label starts-with, then contains, then a
 * value/description hit. Pure; exported for tests.
 */
export function findElements(elements, { text = '', role = '', maxResults = 25, withFrame = false } = {}) {
  const q = String(text ?? '').trim().toLowerCase()
  const r = String(role ?? '').trim().toLowerCase().replace(/^ax/, '').replace(/[\s_-]/g, '')
  const scored = []
  for (const e of elements ?? []) {
    if (withFrame && !e.frame) continue
    if (r) {
      const er = String(e.role ?? '').replace(/^AX/, '').replace(/[\s_-]/g, '').toLowerCase()
      const friendly = friendlyRole(e.role).replace(/\s/g, '')
      if (!(er === r || er.endsWith(r) || friendly === r || friendly.includes(r))) continue
    }
    if (!q) {
      scored.push({ e, score: 1 })
      continue
    }
    const label = String(e.label ?? '').toLowerCase()
    const value = String(e.value ?? '').toLowerCase()
    const desc = String(e.valueDescription ?? '').toLowerCase()
    let score = 0
    if (label === q) score = 100
    else if (label.startsWith(q)) score = 80
    else if (label.includes(q)) score = 60
    else if (value === q) score = 50
    else if (value.includes(q) || desc.includes(q)) score = 30
    if (score > 0) scored.push({ e, score })
  }
  scored.sort((a, b) => b.score - a.score || (a.e.index ?? 0) - (b.e.index ?? 0))
  const cap = Math.max(1, Math.min(200, Number(maxResults) || 25))
  return scored.slice(0, cap).map((s) => s.e)
}

// ─── Snapshot cache ─────────────────────────────────────────────────────

const SNAPSHOT_TTL_MS = 1500
const snapshots = new Map()

function key(pid, windowId) {
  return `${pid}:${windowId}`
}

/** The most recent tree for a window if it is younger than `maxAgeMs`. */
export function cachedSnapshot(pid, windowId, maxAgeMs = SNAPSHOT_TTL_MS) {
  const hit = snapshots.get(key(pid, windowId))
  if (!hit) return null
  if (Date.now() - hit.at > maxAgeMs) return null
  return hit.state
}

export function rememberSnapshot(pid, windowId, state) {
  snapshots.set(key(pid, windowId), { at: Date.now(), state })
  // Bound the cache: a long session touches many windows.
  if (snapshots.size > 32) {
    const oldest = [...snapshots.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) snapshots.delete(oldest[0])
  }
  return state
}

/** Find a token's element in the latest snapshot for its window. */
export function elementByToken(pid, windowId, token) {
  const hit = snapshots.get(key(pid, windowId))
  if (!hit) return null
  return hit.state.elements.find((e) => e.token === token) ?? null
}

export function clearSnapshots() {
  snapshots.clear()
}

/**
 * Render a list of elements for the model, numbered, with frames in the
 * caller's chosen coordinate space (`toFrame` maps a global logical rect to
 * frame pixels, or returns null when the element is outside the frame).
 */
export function renderElementList(elements, toFrame) {
  const lines = []
  for (const e of elements) {
    let where = ''
    if (e.frame) {
      const f = toFrame ? toFrame(e.frame) : null
      where = f
        ? ` at (${f.x}, ${f.y}) size ${f.width}x${f.height} — center (${f.cx}, ${f.cy})`
        : ' (outside the current frame)'
    } else {
      where = ' (no on-screen frame)'
    }
    const actions = (e.actions ?? []).filter((a) => /press|pick|confirm|showmenu|increment|decrement|open/i.test(a))
    lines.push(
      `[${e.index}] ${describeElement(e)}${where}` +
        (e.token ? ` token=${e.token}` : '') +
        (actions.length > 0 ? ` actions=${actions.map((a) => a.replace(/^AX/, '').toLowerCase()).join(',')}` : '')
    )
  }
  return lines.join('\n')
}
