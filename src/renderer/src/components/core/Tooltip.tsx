import { cn } from '@lib/utils/cn'
import { useCallback, useRef, useState, type ReactNode } from 'react'

type Side = 'top' | 'bottom' | 'left' | 'right'
type Align = 'center' | 'start' | 'end'

type TooltipProps = {
  content: ReactNode
  side?: Side
  align?: Align
  delay?: number
  className?: string
  children: ReactNode
}

const sideBase: Record<Side, string> = {
  top: 'bottom-full mb-2',
  bottom: 'top-full mt-2',
  left: 'right-full mr-2',
  right: 'left-full ml-2'
}

// start/end are logical (inset-inline-*), so they anchor to the trigger's
// leading/trailing edge and flip with the writing direction — matching the
// app's other hover cards (meter, folder, logs popovers) which use inset-s/e.
const horizontalAlign: Record<Align, string> = {
  center: 'left-1/2 -translate-x-1/2',
  start: 'inset-s-0',
  end: 'inset-e-0'
}

const verticalAlign: Record<Align, string> = {
  center: 'top-1/2 -translate-y-1/2',
  start: 'top-0',
  end: 'bottom-0'
}

function getPositionClasses(side: Side, align: Align): string {
  const isHorizontal = side === 'top' || side === 'bottom'
  return cn(sideBase[side], isHorizontal ? horizontalAlign[align] : verticalAlign[align])
}

/**
 * App-wide hover tooltip. Visual style matches the reasoning brain button's
 * tooltip — a clean bordered card on the base surface, single line, centered
 * above (or beside) the trigger.
 */
export function Tooltip({
  content,
  side = 'bottom',
  align = 'center',
  delay = 150,
  className,
  children
}: TooltipProps): React.JSX.Element {
  const [visible, setVisible] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const show = useCallback(() => {
    timer.current = setTimeout(() => setVisible(true), delay)
  }, [delay])

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    setVisible(false)
  }, [])

  return (
    <span className="relative inline-flex" onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {visible && (
        <span
          role="tooltip"
          className={cn(
            'border-border bg-surface text-fg pointer-events-none absolute z-50 w-max select-none',
            'whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-center text-[11px] leading-snug shadow-lg',
            getPositionClasses(side, align),
            className
          )}
        >
          {content}
        </span>
      )}
    </span>
  )
}
