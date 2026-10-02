import type { ReasoningMode } from '@main/runtime/reasoning'
import { cn } from '@lib/utils/cn'
import { AiBrain01Icon, BrainIcon, FireIcon, FlashIcon } from 'hugeicons-react'
import { useTranslation } from 'react-i18next'

/** One-word title per reasoning mode — the chat brain button's own labels. */
const MODE_SHORT_KEY: Record<ReasoningMode, string> = {
  off: 'chat.reasoning.shortOff',
  on: 'chat.reasoning.shortOn',
  high: 'chat.reasoning.shortHigh',
  max: 'chat.reasoning.shortMax'
}

/** One-line description per mode, carried as each button's tooltip. */
const MODE_DESC_KEY: Record<ReasoningMode, string> = {
  off: 'chat.reasoning.off',
  on: 'chat.reasoning.on',
  high: 'chat.reasoning.high',
  max: 'chat.reasoning.max'
}

/**
 * Effort ladder, one glyph per mode — the chat model card's exact map
 * (ModelSwitch.tsx MODE_ICON): instant → brain → amped brain → full burn.
 * The two surfaces must never disagree about a mode's icon.
 */
const MODE_ICON: Record<ReasoningMode, typeof BrainIcon> = {
  off: FlashIcon,
  on: BrainIcon,
  high: AiBrain01Icon,
  max: FireIcon
}

/**
 * The card-sized twin of the chat brain button's reasoning chips: one icon
 * button per mode the CHAT'S selected model honours, in canonical order, the
 * active one lit. Icon-only at card scale — the tooltip carries the chat
 * chip's own description and the aria-label its short name, so the control
 * reads as a single glyph group instead of a row of text. Same contract as
 * chat — same registry (reasoningModesFor), same labels, same clamping — so
 * an automation's, project's or procedure's switch reads exactly like the
 * control it mirrors. Renders nothing for a model with no reasoning at all;
 * a single-mode model shows its one glyph inert.
 */
export function ThinkingSwitch({
  modes,
  value,
  onPick,
  className
}: {
  /** Ordered modes from useChatReasoning — the chat's current model's own. */
  modes: readonly ReasoningMode[]
  /** The effective mode: the item's stamp, else the chat's current. */
  value: ReasoningMode
  onPick: (mode: ReasoningMode) => void
  className?: string
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (modes.length === 0) return null
  const switchable = modes.length > 1
  return (
    <div
      role="tablist"
      aria-label={t('chat.reasoning.ariaLabel')}
      className={cn(
        'border-border bg-bg/40 inline-flex shrink-0 items-center gap-0.5 rounded-lg border p-0.5',
        className
      )}
    >
      {modes.map((m) => {
        const active = m === value
        const Icon = MODE_ICON[m]
        return (
          <button
            key={m}
            role="tab"
            type="button"
            aria-selected={active}
            aria-label={t(MODE_SHORT_KEY[m])}
            disabled={!switchable}
            title={t(MODE_DESC_KEY[m])}
            onClick={(e) => {
              // The projects card is itself a button (opens chat) — a chip
              // click must never fall through to it.
              e.stopPropagation()
              if (switchable && !active) onPick(m)
            }}
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded-md',
              active ? 'bg-primary text-primary-fg shadow-sm' : 'text-muted',
              switchable && !active && 'hover:text-fg cursor-pointer',
              !switchable && 'cursor-default'
            )}
          >
            <Icon size={14} className="shrink-0" />
          </button>
        )
      })}
    </div>
  )
}
