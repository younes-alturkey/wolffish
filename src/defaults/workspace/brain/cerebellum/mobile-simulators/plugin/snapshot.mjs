// One element model for both platforms, and the text the model reads.
//
// iOS comes from AXe's nested accessibility JSON (frames in points), Android
// from `uiautomator dump` XML (bounds in pixels). Both normalize to
// `{ ref, type, label, text, value, id, frame, enabled, focused, selected,
//    checked, scrollable, actions }` in the device's native unit. The
// formatter then expresses coordinates in the CURRENT FRAME the model last
// saw (see frames.mjs), so a ref and a coordinate always share one space.
//
// Refs (`e12`) are handles into one snapshot: they expire after a TTL and
// are dropped by every input action, because the screen they pointed at
// may have changed. A stale ref is a typed error, never a silent mis-tap.
import { createHash } from 'node:crypto'

export const SNAPSHOT_TTL_MS = 60_000
export const MAX_INTERACTIVE = 64
export const MAX_TEXT = 40
export const MAX_SCROLL = 8
export const TEXT_MAX = 60

const INTERACTIVE_IOS = new Set([
  'Button',
  'TextField',
  'SecureTextField',
  'SearchField',
  'Switch',
  'Toggle',
  'Slider',
  'Cell',
  'Link',
  'Tab',
  'TabBar',
  'SegmentedControl',
  'Checkbox',
  'RadioButton',
  'Stepper',
  'PickerWheel',
  'Picker',
  'MenuItem',
  'MenuButton',
  'PopUpButton',
  'Key',
  'Keyboard',
  'DatePicker',
  'TextView',
  'Table',
  'CollectionView'
])
const TEXTUAL_IOS = new Set(['StaticText', 'Image', 'Heading', 'Text', 'GenericElement', 'Other'])
const SCROLL_IOS = new Set(['ScrollArea', 'ScrollView', 'Table', 'CollectionView', 'WebView'])

function clip(s, max = TEXT_MAX) {
  if (s == null) return null
  const t = String(s).replace(/\s+/g, ' ').trim()
  if (!t) return null
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function rectFromAxe(node) {
  const f = node?.frame
  if (f && Number.isFinite(f.x) && Number.isFinite(f.y) && Number.isFinite(f.width) && Number.isFinite(f.height)) {
    return { x: f.x, y: f.y, w: f.width, h: f.height }
  }
  const m = /\{\{([-\d.]+), ([-\d.]+)\}, \{([-\d.]+), ([-\d.]+)\}\}/.exec(node?.AXFrame ?? '')
  if (m) return { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) }
  return null
}

function inScreen(r, screen) {
  if (!screen) return true
  return r.x + r.w > 0 && r.y + r.h > 0 && r.x < screen.w && r.y < screen.h
}

function round1(n) {
  return Math.round(n * 10) / 10
}

/**
 * Normalize AXe `describe-ui` output. `screen` is `{w, h}` in points.
 * Returns `{ elements, omitted }`.
 */
export function fromAxe(tree, { screen } = {}) {
  const roots = Array.isArray(tree) ? tree : tree ? [tree] : []
  const elements = []
  let omitted = 0
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object') return
    const rect = rectFromAxe(node)
    const type = typeof node.type === 'string' ? node.type : 'Other'
    const label = clip(node.AXLabel)
    const value = clip(node.AXValue)
    const id = clip(node.AXUniqueId, 80)
    const title = clip(node.title)
    const traits = Array.isArray(node.traits) ? node.traits.map(String) : []
    const customActions = Array.isArray(node.custom_actions) ? node.custom_actions.map(String) : []
    const interactive = INTERACTIVE_IOS.has(type) || (type === 'Image' && customActions.length > 0) || traits.includes('Button')
    const scroll = SCROLL_IOS.has(type)
    const textual = !interactive && !scroll && TEXTUAL_IOS.has(type) && (label || value || title)
    const container = type === 'Application' || type === 'Window' || type === 'Group' || type === 'Other'
    if (rect && (rect.w <= 0 || rect.h <= 0)) {
      omitted++
    } else if (rect && !inScreen(rect, screen)) {
      omitted++
    } else if (rect && (interactive || scroll || textual) && !(container && !label && !value)) {
      elements.push({
        type: type === 'TextField' && node.subrole === 'AXSearchField' ? 'SearchField' : type,
        label: label ?? title,
        text: null,
        value,
        id,
        frame: { x: round1(rect.x), y: round1(rect.y), w: round1(rect.w), h: round1(rect.h) },
        enabled: node.enabled !== false,
        focused: traits.includes('Focused') || node.focused === true,
        selected: traits.includes('Selected') || node.selected === true,
        checked: value === '1' && (type === 'Switch' || type === 'Toggle' || type === 'Checkbox') ? true : value === '0' && (type === 'Switch' || type === 'Toggle' || type === 'Checkbox') ? false : null,
        scrollable: scroll,
        actions: interactive ? ['tap', ...(type.includes('Text') ? ['type'] : []), 'long_press'] : scroll ? ['swipe'] : [],
        interactive,
        depth
      })
    }
    for (const child of node.children ?? []) walk(child, depth + 1)
  }
  for (const r of roots) walk(r, 0)
  return { elements, omitted }
}

/** Parse `uiautomator dump` XML without a dependency. `screen` is `{w, h}` in pixels. */
export function fromUiautomator(xml, { screen } = {}) {
  const elements = []
  let omitted = 0
  const nodeRe = /<node\b([^>]*)\/?>/g
  const attrRe = /([\w:-]+)="([^"]*)"/g
  const decode = (s) =>
    s
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
  let m
  let depth = 0
  const src = String(xml ?? '')
  // Depth tracking: count opening vs closing tags before each node.
  let cursor = 0
  while ((m = nodeRe.exec(src))) {
    const between = src.slice(cursor, m.index)
    depth += (between.match(/<node\b[^>]*[^/]>/g) ?? []).length - (between.match(/<\/node>/g) ?? []).length
    cursor = m.index + m[0].length
    const attrs = {}
    let a
    while ((a = attrRe.exec(m[1]))) attrs[a[1]] = decode(a[2])
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(attrs.bounds ?? '')
    if (!b) continue
    const rect = { x: Number(b[1]), y: Number(b[2]), w: Number(b[3]) - Number(b[1]), h: Number(b[4]) - Number(b[2]) }
    const cls = attrs.class ?? ''
    const type = cls.split('.').pop() || 'View'
    const text = clip(attrs.text)
    const label = clip(attrs['content-desc'])
    const id = clip(attrs['resource-id'], 80)
    const clickable = attrs.clickable === 'true'
    const checkable = attrs.checkable === 'true'
    const scrollable = attrs.scrollable === 'true'
    const longClickable = attrs['long-clickable'] === 'true'
    const editable = /EditText|AutoComplete|SearchView/.test(cls)
    const interactive = clickable || checkable || editable || longClickable
    const textual = !interactive && !scrollable && (text || label)
    if (rect.w <= 0 || rect.h <= 0) {
      omitted++
      continue
    }
    if (!inScreen(rect, screen)) {
      omitted++
      continue
    }
    if (!(interactive || scrollable || textual)) continue
    elements.push({
      type: editable ? 'TextField' : type,
      label,
      text,
      value: attrs.password === 'true' ? '••••' : null,
      id,
      frame: rect,
      enabled: attrs.enabled !== 'false',
      focused: attrs.focused === 'true',
      selected: attrs.selected === 'true',
      checked: checkable ? attrs.checked === 'true' : null,
      scrollable,
      actions: interactive ? ['tap', ...(editable ? ['type'] : []), ...(longClickable ? ['long_press'] : [])] : scrollable ? ['swipe'] : [],
      interactive,
      depth
    })
  }
  return { elements, omitted }
}

/** Stable content hash: what the screen "is", ignoring sub-point jitter. */
export function hashElements(elements) {
  const h = createHash('sha1')
  for (const e of elements) {
    h.update(`${e.type}|${e.label ?? ''}|${e.text ?? ''}|${e.value ?? ''}|${e.id ?? ''}|${Math.round(e.frame.x / 4)},${Math.round(e.frame.y / 4)},${Math.round(e.frame.w / 4)},${Math.round(e.frame.h / 4)}|${e.focused ? 1 : 0}\n`)
  }
  return h.digest('hex').slice(0, 10)
}

/**
 * Pick what the model sees: interactive elements first (capped), then
 * text, then scroll containers, in document order. Assigns refs.
 */
export function select(elements, { marker } = {}) {
  let pool = elements
  if (marker) {
    const needle = String(marker).toLowerCase()
    pool = elements.filter((e) => [e.label, e.text, e.value, e.id, e.type].some((s) => s && String(s).toLowerCase().includes(needle)))
  }
  const interactive = pool.filter((e) => e.interactive)
  const scroll = pool.filter((e) => !e.interactive && e.scrollable)
  const textual = pool.filter((e) => !e.interactive && !e.scrollable)
  const chosen = [...interactive.slice(0, MAX_INTERACTIVE), ...textual.slice(0, MAX_TEXT), ...scroll.slice(0, MAX_SCROLL)]
  chosen.sort((a, b) => elements.indexOf(a) - elements.indexOf(b))
  const truncated = {
    interactive: Math.max(0, interactive.length - MAX_INTERACTIVE),
    text: Math.max(0, textual.length - MAX_TEXT),
    scroll: Math.max(0, scroll.length - MAX_SCROLL)
  }
  let n = 1
  for (const e of chosen) e.ref = `e${n++}`
  return { chosen, truncated, matched: pool.length }
}

function q(s) {
  return JSON.stringify(s)
}

/**
 * One line per element. `toFrame(x, y)` maps native units to the current
 * frame's pixels; `fmtN` rounds. Coordinates are the element's CENTER.
 */
export function formatElements(chosen, { toFrame }) {
  const lines = []
  for (const e of chosen) {
    const cx = e.frame.x + e.frame.w / 2
    const cy = e.frame.y + e.frame.h / 2
    const c = toFrame(cx, cy)
    const tl = toFrame(e.frame.x, e.frame.y)
    const br = toFrame(e.frame.x + e.frame.w, e.frame.y + e.frame.h)
    const parts = [`@${e.ref}`, e.type]
    if (e.label) parts.push(q(e.label))
    if (e.text && e.text !== e.label) parts.push(`text=${q(e.text)}`)
    if (e.value != null && e.value !== e.label && e.value !== e.text) parts.push(`value=${q(e.value)}`)
    if (e.id) parts.push(`id=${q(e.id)}`)
    parts.push(`center=${Math.round(c.x)},${Math.round(c.y)}`)
    parts.push(`size=${Math.max(1, Math.round(br.x - tl.x))}x${Math.max(1, Math.round(br.y - tl.y))}`)
    const flags = []
    if (e.focused) flags.push('focused')
    if (e.selected) flags.push('selected')
    if (e.checked === true) flags.push('checked')
    if (e.checked === false) flags.push('unchecked')
    if (!e.enabled) flags.push('disabled')
    if (e.scrollable && !e.interactive) flags.push('scrollable')
    if (c.offFrame) flags.push('off-frame')
    if (flags.length) parts.push(`[${flags.join(' ')}]`)
    lines.push(parts.join(' '))
  }
  return lines.join('\n')
}

// ─── Store ────────────────────────────────────────────────────────────────

const store = new Map()
const seqs = new Map()

export function putSnapshot(key, { elements, chosen, hash, platform, screen, unit }) {
  const seq = (seqs.get(key) ?? 0) + 1
  seqs.set(key, seq)
  const rec = { seq, hash, elements, chosen, platform, screen, unit, createdAt: Date.now(), expiresAt: Date.now() + SNAPSHOT_TTL_MS }
  store.set(key, rec)
  return rec
}

export function getSnapshot(key) {
  const rec = store.get(key)
  if (!rec) return { status: 'missing' }
  if (Date.now() > rec.expiresAt) return { status: 'expired', rec }
  return { status: 'ok', rec }
}

export function clearSnapshot(key) {
  store.delete(key)
}

export function lastHash(key) {
  return store.get(key)?.hash ?? null
}

/** Resolve `e12` inside the live snapshot. Returns `{element}` or `{error}` text for a typed failure. */
export function resolveRef(key, ref) {
  const r = getSnapshot(key)
  const norm = String(ref ?? '')
    .trim()
    .replace(/^@/, '')
  if (r.status === 'missing') return { status: 'missing' }
  if (r.status === 'expired') return { status: 'expired' }
  const el = r.rec.chosen.find((e) => e.ref === norm)
  if (!el) return { status: 'not_found', available: r.rec.chosen.length }
  return { status: 'ok', element: el, rec: r.rec }
}

export function __resetSnapshots() {
  store.clear()
  seqs.clear()
}
