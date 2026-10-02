import { useCallback, useEffect, useRef, useState } from 'react'

export const MIN_SCALE = 1
export const MAX_SCALE = 8

/** Wheel delta → scale factor, tuned so one mouse notch is roughly 15%. */
const WHEEL_SENSITIVITY = 0.0015
/** Line-mode wheels report notches instead of pixels; ~16px per line. */
const LINE_HEIGHT = 16
const STEP = 1.25
const DOUBLE_CLICK_SCALE = 2.5
/** Pointer travel, in px, past which a click counts as a pan and not a dismiss. */
const DRAG_SLOP = 4

type Transform = { scale: number; x: number; y: number }

const IDLE: Transform = { scale: 1, x: 0, y: 0 }

export type ZoomPanBindings = {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void
  onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void
  onDoubleClick: (e: React.MouseEvent<HTMLElement>) => void
}

export type ZoomPan = {
  scale: number
  /** CSS transform for the content wrapper. */
  transform: string
  cursor: string
  /** The clip frame. Sizes the visible window and owns the wheel listener. */
  stageRef: React.RefObject<HTMLDivElement | null>
  /** Wrapper the transform applies to; measured to clamp panning. */
  contentRef: React.RefObject<HTMLDivElement | null>
  /** Spread onto the stage element. */
  stage: ZoomPanBindings
  zoomBy: (factor: number) => void
  reset: () => void
  /**
   * Whether the pointer sequence that just ended was a pan rather than a click.
   * Reading it clears the flag, so a backdrop handler can swallow exactly the
   * one click that terminated a drag and stay responsive afterwards.
   */
  panned: () => boolean
}

/**
 * Scroll-to-zoom and pan for a media lightbox.
 *
 * Zoom anchors on the pointer, so the pixel under the cursor stays put as the
 * scale changes. Panning is a left-button drag, and only above 1× — at rest
 * there is nothing to pan, so the pointer stays with the content underneath
 * (a `<video>`'s native controls, and the backdrop's click-to-dismiss).
 *
 * State is scoped to the mount: the caller should render the zooming surface
 * only while it is open, so closing it resets the transform and unbinds the
 * window listeners without any teardown of its own.
 */
export function useZoomPan(): ZoomPan {
  const [view, setView] = useState<Transform>(IDLE)
  const [dragging, setDragging] = useState(false)

  const viewRef = useRef<Transform>(IDLE)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const dragPointRef = useRef<{ x: number; y: number } | null>(null)
  const travelRef = useRef(0)

  const apply = useCallback((next: Transform): void => {
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next.scale))
    const stage = stageRef.current
    const content = contentRef.current
    let { x, y } = next
    if (stage && content) {
      // Never let the media be flung into empty space: the offset can only go
      // as far as the part of the scaled content that overflows the frame.
      const slackX = Math.max(0, (content.offsetWidth * scale - stage.clientWidth) / 2)
      const slackY = Math.max(0, (content.offsetHeight * scale - stage.clientHeight) / 2)
      x = Math.min(slackX, Math.max(-slackX, x))
      y = Math.min(slackY, Math.max(-slackY, y))
    }
    const settled = { scale, x, y }
    viewRef.current = settled
    setView(settled)
  }, [])

  const zoomAt = useCallback(
    (factor: number, clientX?: number, clientY?: number): void => {
      const prev = viewRef.current
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev.scale * factor))
      if (scale === prev.scale) return

      const stage = stageRef.current
      let px = 0
      let py = 0
      if (stage && clientX !== undefined && clientY !== undefined) {
        const rect = stage.getBoundingClientRect()
        px = clientX - (rect.left + rect.width / 2)
        py = clientY - (rect.top + rect.height / 2)
      }
      // A content point p renders at scale·p + offset. Solving that for the
      // point currently under the cursor gives the offset that holds it still.
      const growth = scale / prev.scale
      apply({ scale, x: px - (px - prev.x) * growth, y: py - (py - prev.y) * growth })
    },
    [apply]
  )

  const zoomBy = useCallback((factor: number): void => zoomAt(factor), [zoomAt])
  const reset = useCallback((): void => apply(IDLE), [apply])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return

    const onWheel = (e: WheelEvent): void => {
      // Swallowing this also stops Chromium's ctrl+wheel page zoom, which would
      // otherwise scale the entire window instead of the media.
      e.preventDefault()
      const pixels = e.deltaMode === 1 ? e.deltaY * LINE_HEIGHT : e.deltaY
      zoomAt(Math.exp(-pixels * WHEEL_SENSITIVITY), e.clientX, e.clientY)
    }

    // React attaches onWheel passively at the root, where preventDefault is a
    // no-op, so the listener has to be bound directly.
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === '+' || e.key === '=') {
        e.preventDefault()
        zoomBy(STEP)
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        zoomBy(1 / STEP)
      } else if (e.key === '0') {
        e.preventDefault()
        reset()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [zoomBy, reset])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>): void => {
    travelRef.current = 0
    if (e.button !== 0) return
    if (viewRef.current.scale <= MIN_SCALE) return
    e.preventDefault()
    dragPointRef.current = { x: e.clientX, y: e.clientY }
    setDragging(true)
    try {
      // Capture keeps the drag alive when the pointer leaves the frame. It
      // throws if the pointer is already gone, which must not take the handler
      // down with it — the drag tracks off dragPointRef either way.
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // best-effort
    }
  }, [])

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>): void => {
      const last = dragPointRef.current
      if (!last) return
      // Deltas come from clientX/Y rather than movementX/Y: Chromium multiplies
      // movement by the display scale factor on Windows, so a 150% monitor
      // would pan half again too fast.
      const dx = e.clientX - last.x
      const dy = e.clientY - last.y
      dragPointRef.current = { x: e.clientX, y: e.clientY }
      travelRef.current += Math.abs(dx) + Math.abs(dy)
      const prev = viewRef.current
      apply({ ...prev, x: prev.x + dx, y: prev.y + dy })
    },
    [apply]
  )

  const endDrag = useCallback((e: React.PointerEvent<HTMLElement>): void => {
    if (!dragPointRef.current) return
    dragPointRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    setDragging(false)
  }, [])

  const onDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLElement>): void => {
      // Chromium maps double-click on a <video> to fullscreen; keep it here.
      e.preventDefault()
      if (viewRef.current.scale > MIN_SCALE) {
        reset()
        return
      }
      zoomAt(DOUBLE_CLICK_SCALE, e.clientX, e.clientY)
    },
    [reset, zoomAt]
  )

  const panned = useCallback((): boolean => {
    const moved = travelRef.current > DRAG_SLOP
    travelRef.current = 0
    return moved
  }, [])

  const cursor = dragging ? 'grabbing' : view.scale > MIN_SCALE ? 'grab' : 'zoom-in'

  return {
    scale: view.scale,
    transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`,
    cursor,
    stageRef,
    contentRef,
    stage: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onDoubleClick
    },
    zoomBy,
    reset,
    panned
  }
}
