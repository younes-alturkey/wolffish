// The frame contract, ported from computer-use: every image a tool returns
// (screenshot, zoom, magnifier) becomes "the current frame" for that
// conversation and device. The model gives coordinates ONLY in the latest
// image's pixels; this module owns every translation into device units
// (points on iOS, pixels on Android) and back. The model never multiplies.
//
// A frame records: the image size the model saw, the native region it
// shows (in device units), the device's pixel density, and how it came to
// be. A text-only snapshot with no prior image establishes a "native" frame
// (1 image px == 1 device unit) so refs and coordinates still share a space.
//
// Image work is sharp (the capability's one dependency, loaded lazily).
import path from 'node:path'
import { mkdir } from 'node:fs/promises'

export const IMAGE_MAX_DIMENSION = 1024
export const IMAGE_WIRE_CAP_BYTES = 3 * 1024 * 1024
export const MAGNIFIER_UNITS = { w: 240, h: 150 }
export const MAGNIFIER_PX = { w: 480, h: 300 }
export const ZOOM_MAX = 4

let sharpMod = null
async function sharp() {
  if (!sharpMod) sharpMod = (await import('sharp')).default
  return sharpMod
}

const frames = new Map()

/**
 * Record a frame. `region` is in device units, `image` the size the model
 * received, `pxPerUnit` the device's framebuffer scale (3 on an iPhone
 * 16 Pro, 1 on Android).
 */
export function setFrame(key, { kind, image, region, native, pxPerUnit, unit }) {
  const f = { kind, image: { ...image }, region: { ...region }, native: { ...native }, pxPerUnit, unit, at: Date.now() }
  frames.set(key, f)
  return f
}

export function getFrame(key) {
  return frames.get(key) ?? null
}

export function clearFrame(key) {
  frames.delete(key)
}

export function __resetFrames() {
  frames.clear()
}

/** A frame that stands for the whole screen at 1 px per unit. */
export function nativeFrame(key, { native, pxPerUnit, unit }) {
  return setFrame(key, {
    kind: 'native',
    image: { w: native.w, h: native.h },
    region: { x: 0, y: 0, w: native.w, h: native.h },
    native,
    pxPerUnit,
    unit
  })
}

/** Frame pixels -> device units. Pure. */
export function toNative(frame, x, y) {
  const sx = frame.region.w / frame.image.w
  const sy = frame.region.h / frame.image.h
  return { x: frame.region.x + x * sx, y: frame.region.y + y * sy }
}

/** Device units -> frame pixels. Marks points outside the image. Pure. */
export function fromNative(frame, nx, ny) {
  const sx = frame.image.w / frame.region.w
  const sy = frame.image.h / frame.region.h
  const x = (nx - frame.region.x) * sx
  const y = (ny - frame.region.y) * sy
  const offFrame = x < 0 || y < 0 || x > frame.image.w || y > frame.image.h
  return { x, y, offFrame }
}

export function inFrame(frame, x, y) {
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x <= frame.image.w && y <= frame.image.h
}

/** Compression factor of the current frame relative to the native screen: units per image px. */
export function unitsPerPx(frame) {
  return frame.region.w / frame.image.w
}

export function describeFrame(frame) {
  if (!frame) return 'no frame yet'
  const upp = unitsPerPx(frame)
  const whole = frame.region.x === 0 && frame.region.y === 0 && frame.region.w === frame.native.w && frame.region.h === frame.native.h
  const where = whole ? 'whole screen' : `region ${Math.round(frame.region.x)},${Math.round(frame.region.y)} ${Math.round(frame.region.w)}x${Math.round(frame.region.h)} ${frame.unit}`
  return `${frame.kind} ${frame.image.w}x${frame.image.h} px = ${where} (${upp.toFixed(2)} ${frame.unit}/px)`
}

// ─── Image operations ─────────────────────────────────────────────────────

/** PNG metadata. */
export async function imageSize(buffer) {
  const s = await sharp()
  const m = await s(buffer).metadata()
  return { w: m.width ?? 0, h: m.height ?? 0 }
}

/**
 * Downscale a full-screen PNG for the model. Returns `{ buffer, info:{w,h}, original:{w,h} }`.
 * Shrinks further until under the wire cap.
 */
export async function encodeScreen(buffer, { maxDimension } = {}) {
  const s = await sharp()
  const meta = await s(buffer).metadata()
  let edge = Number.isFinite(maxDimension) && maxDimension > 0 ? Math.round(maxDimension) : IMAGE_MAX_DIMENSION
  let out
  let info
  for (let attempt = 0; attempt < 4; attempt++) {
    const enc = await s(buffer).resize(edge, edge, { fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true })
    out = enc.data
    info = enc.info
    if (out.length <= IMAGE_WIRE_CAP_BYTES) break
    edge = Math.max(256, Math.floor(Math.max(info.width, info.height) * Math.sqrt(IMAGE_WIRE_CAP_BYTES / out.length) * 0.9))
  }
  return { buffer: out, info: { w: info.width, h: info.height }, original: { w: meta.width ?? 0, h: meta.height ?? 0 } }
}

/**
 * Crop a native-unit region out of a full-screen PNG and scale it so the
 * result is at most `maxEdge` px, never enlarged past `ZOOM_MAX` px per unit.
 * Returns `{ buffer, info, region }` with the region clamped to the screen.
 */
export async function cropRegion(buffer, region, { pxPerUnit, native, maxEdge = IMAGE_MAX_DIMENSION, minUnits = 40 }) {
  const s = await sharp()
  let { x, y, w, h } = region
  w = Math.max(minUnits, w)
  h = Math.max(minUnits, h)
  x = Math.max(0, Math.min(native.w - w, x))
  y = Math.max(0, Math.min(native.h - h, y))
  w = Math.min(w, native.w - x)
  h = Math.min(h, native.h - y)
  const px = { left: Math.round(x * pxPerUnit), top: Math.round(y * pxPerUnit), width: Math.max(1, Math.round(w * pxPerUnit)), height: Math.max(1, Math.round(h * pxPerUnit)) }
  const maxByZoom = Math.round(Math.max(w, h) * ZOOM_MAX)
  const edge = Math.min(maxEdge, maxByZoom)
  const enc = await s(buffer).extract(px).resize(edge, edge, { fit: 'inside' }).png().toBuffer({ resolveWithObject: true })
  return { buffer: enc.data, info: { w: enc.info.width, h: enc.info.height }, region: { x, y, w, h } }
}

function crosshairSvg(w, h, cx, cy) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      `<circle cx="${cx}" cy="${cy}" r="14" fill="none" stroke="#000" stroke-opacity="0.55" stroke-width="4"/>` +
      `<circle cx="${cx}" cy="${cy}" r="14" fill="none" stroke="#3B82F6" stroke-width="2"/>` +
      `<line x1="${cx - 24}" y1="${cy}" x2="${cx - 8}" y2="${cy}" stroke="#3B82F6" stroke-width="2"/>` +
      `<line x1="${cx + 8}" y1="${cy}" x2="${cx + 24}" y2="${cy}" stroke="#3B82F6" stroke-width="2"/>` +
      `<line x1="${cx}" y1="${cy - 24}" x2="${cx}" y2="${cy - 8}" stroke="#3B82F6" stroke-width="2"/>` +
      `<line x1="${cx}" y1="${cy + 8}" x2="${cx}" y2="${cy + 24}" stroke="#3B82F6" stroke-width="2"/>` +
      `<circle cx="${cx}" cy="${cy}" r="2" fill="#3B82F6"/>` +
      `</svg>`
  )
}

/**
 * The proof patch after an action: a 480x300 close-up at 2 image px per
 * device unit centered on the acted point, with a crosshair on the exact
 * unit. Returns `{ buffer, info, region }`; the region is what the patch shows.
 */
export async function magnifier(buffer, point, { pxPerUnit, native }) {
  const s = await sharp()
  const w = MAGNIFIER_UNITS.w
  const h = MAGNIFIER_UNITS.h
  let x = point.x - w / 2
  let y = point.y - h / 2
  x = Math.max(0, Math.min(native.w - w, x))
  y = Math.max(0, Math.min(native.h - h, y))
  const region = { x, y, w: Math.min(w, native.w), h: Math.min(h, native.h) }
  const px = { left: Math.round(region.x * pxPerUnit), top: Math.round(region.y * pxPerUnit), width: Math.max(1, Math.round(region.w * pxPerUnit)), height: Math.max(1, Math.round(region.h * pxPerUnit)) }
  const outW = Math.round(region.w * (MAGNIFIER_PX.w / MAGNIFIER_UNITS.w))
  const outH = Math.round(region.h * (MAGNIFIER_PX.h / MAGNIFIER_UNITS.h))
  const cx = (point.x - region.x) * (outW / region.w)
  const cy = (point.y - region.y) * (outH / region.h)
  const enc = await s(buffer)
    .extract(px)
    .resize(outW, outH, { fit: 'fill' })
    .composite([{ input: crosshairSvg(outW, outH, cx, cy), top: 0, left: 0 }])
    .png()
    .toBuffer({ resolveWithObject: true })
  return { buffer: enc.data, info: { w: enc.info.width, h: enc.info.height }, region }
}

/**
 * Fraction of the screen that changed between two full-screen PNGs
 * (greyscale, downscaled, threshold 26/255). Also the fraction inside a
 * window around `point` (device units) when given. Pure of side effects.
 */
export async function changeRatio(before, after, { point, pxPerUnit, native } = {}) {
  const s = await sharp()
  const W = 96
  const [a, b] = await Promise.all([
    s(before).resize(W, null, { fit: 'inside' }).greyscale().raw().toBuffer({ resolveWithObject: true }),
    s(after).resize(W, null, { fit: 'inside' }).greyscale().raw().toBuffer({ resolveWithObject: true })
  ])
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) return { whole: 1, local: 1 }
  const n = a.data.length
  let changed = 0
  let localChanged = 0
  let localTotal = 0
  let lx0 = -1
  let ly0 = -1
  let lx1 = -1
  let ly1 = -1
  if (point && native) {
    const sx = a.info.width / native.w
    const sy = a.info.height / native.h
    const rw = MAGNIFIER_UNITS.w * sx
    const rh = MAGNIFIER_UNITS.h * sy
    lx0 = Math.floor(point.x * sx - rw / 2)
    ly0 = Math.floor(point.y * sy - rh / 2)
    lx1 = Math.ceil(point.x * sx + rw / 2)
    ly1 = Math.ceil(point.y * sy + rh / 2)
  }
  for (let i = 0; i < n; i++) {
    const diff = Math.abs(a.data[i] - b.data[i]) > 26
    if (diff) changed++
    if (lx0 >= 0) {
      const x = i % a.info.width
      const y = Math.floor(i / a.info.width)
      if (x >= lx0 && x <= lx1 && y >= ly0 && y <= ly1) {
        localTotal++
        if (diff) localChanged++
      }
    }
  }
  return { whole: n ? changed / n : 0, local: localTotal ? localChanged / localTotal : null }
}

/** A quick content hash of a screenshot, for `settled` waits. */
export async function screenHash(buffer) {
  const s = await sharp()
  const raw = await s(buffer).resize(48, null, { fit: 'inside' }).greyscale().raw().toBuffer()
  let h = 2166136261
  for (let i = 0; i < raw.length; i++) {
    h ^= raw[i] >> 3
    h = Math.imul(h, 16777619) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// ─── Files on disk ────────────────────────────────────────────────────────

let workspaceRoot = null
export function initFrames(root) {
  workspaceRoot = root
}

let counter = 0
/** Unique path under files/screenshots for a capture. */
export async function screenshotPath(prefix, ext = 'png') {
  const dir = path.join(workspaceRoot, 'files', 'screenshots')
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17)
  counter = (counter + 1) % 1000
  return path.join(dir, `${prefix}-${stamp}-${String(counter).padStart(3, '0')}.${ext}`)
}

export function filesDir(...parts) {
  return path.join(workspaceRoot, 'files', 'mobile', ...parts)
}
