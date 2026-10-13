import {
  anchor,
  clampOffset,
  clampScale,
  DOUBLE_TAP_SCALE,
  MAX_SCALE,
  MIN_SCALE,
  paintedSize,
  PINCH_FLOOR,
  slack
} from '@/lib/utils/zoomPan'

/** A phone-shaped stage, and a landscape photo letterboxed inside it. */
const STAGE = { width: 400, height: 800 }
const LANDSCAPE = { width: 4000, height: 2000 }
/** Nothing decoded yet — the state the stage opens in. */
const UNKNOWN = { width: 0, height: 0 }

describe('paintedSize', () => {
  it('fits a landscape photo to the stage width', () => {
    // 4000x2000 into 400 wide -> 400x200, letterboxed top and bottom.
    expect(paintedSize(STAGE, LANDSCAPE)).toEqual({ width: 400, height: 200 })
  })

  it('fits a portrait photo to the stage height', () => {
    expect(paintedSize(STAGE, { width: 1000, height: 4000 })).toEqual({ width: 200, height: 800 })
  })

  it('falls back to the stage until the decoder reports a size', () => {
    expect(paintedSize(STAGE, UNKNOWN)).toEqual(STAGE)
  })
})

describe('slack', () => {
  it('pins an unzoomed picture dead centre', () => {
    expect(slack(STAGE, LANDSCAPE, MIN_SCALE)).toEqual({ x: 0, y: 0 })
  })

  it('opens up only the axis that overflows', () => {
    // At 2x the 400x200 picture is 800x400: it overflows the 400pt width by
    // 400 (200 each side) and still fits inside the 800pt height.
    expect(slack(STAGE, LANDSCAPE, 2)).toEqual({ x: 200, y: 0 })
  })

  it('bounds the picture, not the letterbox', () => {
    // The naive bound — the stage scaled — would be (400*2-400)/2 = 200 on
    // BOTH axes, which is what lets a letterboxed photo be dragged off screen.
    expect(slack(STAGE, LANDSCAPE, 2).y).toBe(0)
  })

  it('bounds off the stage while the pixel size is unknown', () => {
    expect(slack(STAGE, UNKNOWN, 2)).toEqual({ x: 200, y: 400 })
  })

  it('has nothing to bound before the stage is laid out', () => {
    expect(slack({ width: 0, height: 0 }, LANDSCAPE, 4)).toEqual({ x: 0, y: 0 })
  })
})

describe('clampOffset', () => {
  it('holds an offset inside its slack', () => {
    expect(clampOffset({ x: 900, y: -900 }, { x: 200, y: 0 })).toEqual({ x: 200, y: -0 })
  })

  it('leaves an offset already inside it alone', () => {
    expect(clampOffset({ x: 40, y: -10 }, { x: 200, y: 50 })).toEqual({ x: 40, y: -10 })
  })
})

describe('clampScale', () => {
  it('caps the zoom at the desktops ceiling', () => {
    expect(clampScale(20, MIN_SCALE)).toBe(MAX_SCALE)
  })

  it('refuses to shrink past the fit outside a pinch', () => {
    expect(clampScale(0.4, MIN_SCALE)).toBe(MIN_SCALE)
  })

  it('lets a live pinch shrink past it, as far as the floor', () => {
    expect(clampScale(0.8, PINCH_FLOOR)).toBe(0.8)
    expect(clampScale(0.1, PINCH_FLOOR)).toBe(PINCH_FLOOR)
  })
})

describe('anchor', () => {
  /** Where a content point lands on screen: the transform, run forwards. */
  const project = (point: number, scale: number, offset: number): number => scale * point + offset

  it('holds the pixel under a stationary focal still', () => {
    const focal = { x: 120, y: -60 }
    const from = { x: 10, y: 5 }
    const growth = DOUBLE_TAP_SCALE / MIN_SCALE
    const next = anchor(from, focal, focal, growth)

    // The content point that was under the focal before the zoom...
    const contentX = (focal.x - from.x) / MIN_SCALE
    const contentY = (focal.y - from.y) / MIN_SCALE
    // ...is still under it after.
    expect(project(contentX, DOUBLE_TAP_SCALE, next.x)).toBeCloseTo(focal.x)
    expect(project(contentY, DOUBLE_TAP_SCALE, next.y)).toBeCloseTo(focal.y)
  })

  it('carries the focal along when the fingers themselves move', () => {
    const from = { x: 100, y: 100 }
    const to = { x: 140, y: 90 }
    const offset = { x: 0, y: 0 }
    // Scale unchanged: a two-finger drag, and nothing else.
    const next = anchor(offset, from, to, 1)
    expect(next).toEqual({ x: 40, y: -10 })
  })

  it('is a no-op when nothing changes', () => {
    const offset = { x: 12, y: -34 }
    expect(anchor(offset, { x: 50, y: 50 }, { x: 50, y: 50 }, 1)).toEqual(offset)
  })

  it('zooms out about the focal as exactly as it zoomed in', () => {
    const focal = { x: -80, y: 200 }
    const start = { x: 0, y: 0 }
    const zoomedIn = anchor(start, focal, focal, 4)
    const backOut = anchor(zoomedIn, focal, focal, 1 / 4)
    expect(backOut.x).toBeCloseTo(start.x)
    expect(backOut.y).toBeCloseTo(start.y)
  })
})
