import { cn } from '@lib/utils/cn'
import { ToggleOffIcon, ToggleOnIcon } from 'hugeicons-react'

/**
 * A generic on/off button — one glyph, no text.
 *
 * The state is carried by the glyph itself (the lit switch vs. the struck
 * one), the accent tint while on, and `aria-pressed`; the tooltip carries the
 * words. One button rather than a two-tab group, because a two-option control
 * phrased as two buttons reads as a choice of two things, and this is one
 * thing with two states.
 *
 * `labelOn`/`labelOff` are required: a codepoint-only control has no readable
 * name otherwise. Pass localized strings — they become both the tooltip and
 * the accessible name.
 */
export function ToggleSwitch({
  on,
  onToggle,
  labelOn,
  labelOff,
  iconSize = 20,
  className
}: {
  /** Whether the switch is on. */
  on: boolean
  /** Called with the NEXT state — never the current one. */
  onToggle: (next: boolean) => void
  /** Tooltip + accessible name while on, e.g. "Active — click to pause". */
  labelOn: string
  /** Tooltip + accessible name while off, e.g. "Inactive — click to enable". */
  labelOff: string
  /** Glyph size in px. Defaults to the card-row scale. */
  iconSize?: number
  className?: string
}): React.JSX.Element {
  const label = on ? labelOn : labelOff
  return (
    <button
      type="button"
      onClick={(e) => {
        // A switch inside a clickable card must not also trigger the card —
        // the same guard ThinkingSwitch and ModeSwitch carry.
        e.stopPropagation()
        onToggle(!on)
      }}
      aria-pressed={on}
      aria-label={label}
      title={label}
      className={cn(
        'flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg',
        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        on ? 'text-primary' : 'text-muted hover:text-fg',
        className
      )}
    >
      {on ? (
        <ToggleOnIcon size={iconSize} className="shrink-0" />
      ) : (
        <ToggleOffIcon size={iconSize} className="shrink-0" />
      )}
    </button>
  )
}
