import { MAX_SCALE, MIN_SCALE, useZoomPan } from '@hooks/use-zoom-pan/useZoomPan'
import { cn } from '@lib/utils/cn'
import { MinusSignIcon, PlusSignIcon } from 'hugeicons-react'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'

export type MediaLightboxProps = {
  open: boolean
  onClose: () => void
  /** Accessible name for the dialog — normally the file name. */
  label: string
  /**
   * Sizes the clip frame. The media inside should fill it, since the frame is
   * what the zoomed content is clipped against.
   */
  frameStyle: React.CSSProperties
  /**
   * Scroll-to-zoom, drag-to-pan, and the zoom toolbar. Turn it off for content
   * that already scrolls and zooms on its own — a native PDF viewer swallows
   * the wheel and pointer events inside its frame anyway, so the toolbar would
   * be advertising gestures that never reach it.
   */
  zoomable?: boolean
  children: React.ReactNode
}

const FRAME = 'border-border bg-surface overflow-hidden rounded-2xl border shadow-xl'

const CHROME_BUTTON = cn(
  'text-muted hover:text-fg flex cursor-pointer items-center justify-center rounded-full',
  'disabled:cursor-default disabled:opacity-40 disabled:hover:text-muted',
  'focus-visible:ring-2 focus-visible:ring-accent'
)

/**
 * Fullscreen media overlay with scroll-to-zoom and pan, shared by the image and
 * video viewers. The frame keeps the media's aspect ratio and clips it, so the
 * card still hugs the content at rest and only the zoomed-in content overflows.
 *
 * Dismissed by Escape or a click on the backdrop itself — a click that landed
 * on the frame, the chrome, or the tail of a drag is not a dismiss.
 *
 * With `zoomable={false}` the same overlay carries content that zooms itself,
 * like the PDF viewer's embedded frame: backdrop and dismissal are unchanged,
 * only the transform surface and its toolbar drop away.
 */
export function MediaLightbox({
  open,
  onClose,
  label,
  frameStyle,
  zoomable = true,
  children
}: MediaLightboxProps): React.JSX.Element | null {
  if (!open || typeof document === 'undefined') return null

  // Mounting the stage only while open is what resets the zoom between
  // openings — the transform lives in `useZoomPan`'s own state.
  return createPortal(
    zoomable ? (
      <ZoomStage onClose={onClose} label={label} frameStyle={frameStyle}>
        {children}
      </ZoomStage>
    ) : (
      <PlainStage onClose={onClose} label={label} frameStyle={frameStyle}>
        {children}
      </PlainStage>
    ),
    document.body
  )
}

type StageProps = Omit<MediaLightboxProps, 'open' | 'zoomable'>

/**
 * Backdrop, Escape key, and click-to-dismiss. `shouldDismiss` lets a stage veto
 * the click that ended a drag.
 */
function Backdrop({
  onClose,
  shouldDismiss,
  children
}: {
  onClose: () => void
  shouldDismiss?: () => boolean
  children: React.ReactNode
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && (shouldDismiss?.() ?? true)) onClose()
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    >
      {children}
    </div>
  )
}

/** The frame alone: whatever is inside handles its own scrolling and zooming. */
function PlainStage({ onClose, label, frameStyle, children }: StageProps): React.JSX.Element {
  return (
    <Backdrop onClose={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        style={frameStyle}
        className={cn(FRAME, 'flex')}
      >
        {children}
      </div>
    </Backdrop>
  )
}

function ZoomStage({ onClose, label, frameStyle, children }: StageProps): React.JSX.Element {
  const { scale, transform, cursor, stageRef, contentRef, stage, zoomBy, reset, panned } =
    useZoomPan()

  return (
    <Backdrop onClose={onClose} shouldDismiss={() => !panned()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        ref={stageRef}
        style={{ ...frameStyle, cursor, touchAction: 'none' }}
        {...stage}
        className={FRAME}
      >
        <div
          ref={contentRef}
          className="flex h-full w-full items-center justify-center"
          style={{ transform, willChange: 'transform' }}
        >
          {children}
        </div>
      </div>

      <div
        className={cn(
          'absolute bottom-6 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2'
        )}
      >
        <div className="border-border bg-surface flex items-center gap-1 rounded-full border p-1 shadow-lg">
          <button
            type="button"
            onClick={() => zoomBy(1 / 1.25)}
            disabled={scale <= MIN_SCALE}
            aria-label="Zoom out"
            title="Zoom out (−)"
            className={cn(CHROME_BUTTON, 'p-2')}
          >
            <MinusSignIcon size={14} />
          </button>
          <button
            type="button"
            onClick={reset}
            disabled={scale <= MIN_SCALE}
            aria-label="Reset zoom"
            title="Reset zoom (0)"
            className={cn(CHROME_BUTTON, 'min-w-14 px-2 py-1 text-xs font-medium tabular-nums')}
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            type="button"
            onClick={() => zoomBy(1.25)}
            disabled={scale >= MAX_SCALE}
            aria-label="Zoom in"
            title="Zoom in (+)"
            className={cn(CHROME_BUTTON, 'p-2')}
          >
            <PlusSignIcon size={14} />
          </button>
        </div>
        {/* Only ever name the gesture that is actually available right now. */}
        <span className="text-[11px] text-white/70 drop-shadow">
          {scale > MIN_SCALE
            ? 'Drag to pan · double-click to reset'
            : 'Scroll or double-click to zoom'}
        </span>
      </div>
    </Backdrop>
  )
}
