import { cn } from '@lib/utils/cn'
import { BubbleChatIcon, WorkflowSquare03Icon } from 'hugeicons-react'
import { useTranslation } from 'react-i18next'

/** The chat mode picker's own glyphs — a single answer vs. the planner swarm. */
const MODE_ICON = {
  single: BubbleChatIcon,
  workflow: WorkflowSquare03Icon
} as const

const MODE_NAME_KEY = {
  single: 'chat.modePicker.single',
  workflow: 'chat.modePicker.workflow'
} as const

const MODE_DESC_KEY = {
  single: 'chat.modePicker.singleDesc',
  workflow: 'chat.modePicker.workflowDesc'
} as const

/**
 * The cards' run-mode switch: single vs. workflow, one icon button each, the
 * active one lit. The glyphs are the chat model card's own so the mode reads
 * the same everywhere; icon-only at card scale, with the tooltip carrying the
 * chat's description and the aria-label its name. The automations and
 * procedures cards are the only callers, and the value they pass is the same
 * effective `mode ?? global` the old text tabs showed.
 */
export function ModeSwitch({
  value,
  onPick,
  ariaLabel,
  className
}: {
  /** The effective mode: the item's stamp, else the global one. */
  value: 'single' | 'workflow'
  onPick: (mode: 'single' | 'workflow') => void
  /** Localized name for the group ("Run mode" on both card pages). */
  ariaLabel: string
  className?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'border-border bg-bg/40 inline-flex shrink-0 items-center gap-0.5 rounded-lg border p-0.5',
        className
      )}
    >
      {(['single', 'workflow'] as const).map((m) => {
        const active = m === value
        const Icon = MODE_ICON[m]
        return (
          <button
            key={m}
            role="tab"
            type="button"
            aria-selected={active}
            aria-label={t(MODE_NAME_KEY[m])}
            title={t(MODE_DESC_KEY[m])}
            onClick={(e) => {
              e.stopPropagation()
              if (!active) onPick(m)
            }}
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded-md',
              active
                ? 'bg-primary text-primary-fg shadow-sm'
                : 'text-muted hover:text-fg cursor-pointer'
            )}
          >
            <Icon size={14} className="shrink-0" />
          </button>
        )
      })}
    </div>
  )
}
