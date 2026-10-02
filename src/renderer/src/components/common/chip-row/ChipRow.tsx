import { cn } from '@lib/utils/cn'
import { useLayoutEffect, useRef } from 'react'

export type ChipRowChip = {
  value: string
  label: string
  /** Leading icon; `activeIcon` swaps in on the lit chip, so a provider
   *  logo can flip to primary-fg there. */
  icon?: React.ReactNode
  activeIcon?: React.ReactNode
}

/**
 * The mobile app's picker row (ModelSwitch/ChatMenuSheet chips), in DOM: the
 * whole list on one x-scrolling line, one click to choose. Chips rather than
 * a Select because the whole list is the point — a Select hid every option
 * behind a modal and truncated the value it showed. The row never wraps and
 * scrolls freely on x with the scrollbar hidden, so every chip carries its
 * full label however long it runs, unless the caller caps it with
 * `truncateLabels` (the project rows' cap).
 */
export function ChipRow({
  chips,
  value,
  onChange,
  ariaLabel,
  ltrLabels = false,
  truncateLabels = false,
  className
}: {
  chips: readonly ChipRowChip[]
  value: string
  onChange: (value: string) => void
  /** The visible label is the caller's SIBLING element, so without this the
   *  row announces only its chips, with no hint of what they choose. */
  ariaLabel: string
  /** Identifier chips (provider/model names) hold LTR even under RTL. */
  ltrLabels?: boolean
  /** Cap each label at a fixed width instead of letting it run. */
  truncateLabels?: boolean
  className?: string
}): React.JSX.Element {
  // The lit chip can start off the row's far edge — the row would open
  // reading as nothing chosen. Scroll it into view the once; every later
  // change comes from a click, which is already in view. Horizontal ONLY and
  // by hand: scrollIntoView would also scroll the dialog behind on y. The
  // latch turns only on a scroll that actually happened, and the effect
  // re-runs as the chip list changes, so a chip laid out at the start before
  // an async list lands still gets carried in when the list pushes it along.
  // scrollBy left-deltas are physical px under both directions, so the math
  // holds in RTL.
  const rowRef = useRef<HTMLDivElement>(null)
  const settled = useRef(false)
  useLayoutEffect(() => {
    if (settled.current) return
    const row = rowRef.current
    const el = row?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!row || !el) return
    const rtl = getComputedStyle(row).direction === 'rtl'
    const rowRect = row.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    const delta = rtl ? elRect.right - rowRect.right + 12 : elRect.left - rowRect.left - 12
    if (rtl ? delta > -1 : delta < 1) return
    settled.current = true
    row.scrollBy({ left: delta })
  }, [chips, value])

  return (
    <div
      ref={rowRef}
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'flex min-w-0 items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className
      )}
    >
      {chips.map((chip) => {
        const active = chip.value === value
        return (
          <button
            key={chip.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(chip.value)}
            className={cn(
              'inline-flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-lg border px-3 text-xs font-medium',
              'focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
              active
                ? 'border-primary bg-primary text-primary-fg'
                : 'border-border bg-bg text-fg hover:bg-border/40'
            )}
          >
            {active ? (chip.activeIcon ?? chip.icon) : chip.icon}
            <span
              dir={ltrLabels ? 'ltr' : 'auto'}
              className={cn('whitespace-nowrap', truncateLabels && 'max-w-40 truncate')}
            >
              {chip.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
