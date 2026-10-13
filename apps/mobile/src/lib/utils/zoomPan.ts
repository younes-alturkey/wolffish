/**
 * Geometry for the expanded image viewer's zooming stage — the arithmetic half
 * of the desktop's useZoomPan, kept out of the component so it can be checked
 * without a gesture runtime behind it.
 *
 * Every function here is a worklet: they are called from gesture callbacks
 * running on the UI thread, where a plain JS function is not reachable.
 */

/** The desktop's MIN_SCALE / MAX_SCALE / DOUBLE_CLICK_SCALE, unchanged. */
export const MIN_SCALE = 1
export const MAX_SCALE = 8
export const DOUBLE_TAP_SCALE = 2.5
/**
 * How far a pinch may shrink past the fit before it is sprung back to it.
 * The desktop clamps hard at 1× because a wheel has no give; a pinch that
 * simply stops dead reads as a broken gesture, so shrinking past the fit is
 * allowed during the gesture and given back on release.
 */
export const PINCH_FLOOR = 0.5

export type Size = { width: number; height: number }
export type Offset = { x: number; y: number }

export const CENTERED: Offset = { x: 0, y: 0 }

/**
 * Where the picture is actually painted inside the stage. `contentFit:
 * 'contain'` draws the largest box with the image's ratio that fits, so on a
 * phone every image but an exact-ratio one is letterboxed — and the letterbox
 * is not part of the picture. Before the decoder reports a size there is
 * nothing to compute from, and the stage is the honest answer.
 */
export function paintedSize(stage: Size, pixels: Size): Size {
  'worklet'
  if (pixels.width <= 0 || pixels.height <= 0) return stage
  const fit = Math.min(stage.width / pixels.width, stage.height / pixels.height)
  return { width: pixels.width * fit, height: pixels.height * fit }
}

/**
 * Half the overhang of the painted picture past the stage at `scale` — how far
 * the offset may travel on each axis. Zero on an axis that still fits, which
 * is what pins an un-zoomed image dead centre.
 */
export function slack(stage: Size, pixels: Size, scale: number): Offset {
  'worklet'
  if (stage.width <= 0 || stage.height <= 0) return CENTERED
  const painted = paintedSize(stage, pixels)
  return {
    x: Math.max(0, (painted.width * scale - stage.width) / 2),
    y: Math.max(0, (painted.height * scale - stage.height) / 2)
  }
}

/** Hold an offset inside its slack, so the picture never flies into empty space. */
export function clampOffset(offset: Offset, limit: Offset): Offset {
  'worklet'
  return {
    x: Math.min(limit.x, Math.max(-limit.x, offset.x)),
    y: Math.min(limit.y, Math.max(-limit.y, offset.y))
  }
}

export function clampScale(scale: number, floor: number): number {
  'worklet'
  return Math.min(MAX_SCALE, Math.max(floor, scale))
}

/**
 * The offset that keeps a point of the picture under the finger while the
 * scale changes. A content point renders at `scale·point + offset`; solving
 * that for the point currently at `from` gives this — the same step the
 * desktop's zoomAt takes.
 *
 * `from` is where that point sits now and `to` is where it should end up: they
 * differ while a pinch's own focal is travelling, and folding the two into one
 * solve is what makes a two-finger drag move the picture without a second
 * gesture to do it. `growth` is the ratio of the new scale to the old.
 */
export function anchor(offset: Offset, from: Offset, to: Offset, growth: number): Offset {
  'worklet'
  return {
    x: to.x - (from.x - offset.x) * growth,
    y: to.y - (from.y - offset.y) * growth
  }
}
