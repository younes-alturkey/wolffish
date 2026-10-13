import type { IconProps } from '@/components/core/icons'
import { cn } from '@/lib/utils/cn'
import { Text, View } from 'react-native'

/**
 * The desktop's Badge (components/core/Badge.tsx), one-for-one: a small
 * icon + label chip in one of four tones. The desktop's `ring-1` becomes a
 * real 1px border here — React Native has no ring — and the colors are the
 * same tokens, so a chip reads identically on both surfaces.
 *
 * `primary` matches the desktop's core/official override
 * (`!bg-primary/10 !text-primary !ring-primary/30`), not the base primary
 * variant, because that override is the only place the desktop uses it.
 *
 * The neutral and primary fills come from precomputed tokens rather than an
 * alpha modifier: `bg-primary/10` over a var() color silently drops in RN and
 * leaves a black border (see global.css). Emerald/red are literal palette
 * colors, so those keep the desktop's alpha spelling.
 */
export type BadgeVariant = 'default' | 'primary' | 'success' | 'danger'

const VARIANTS: Record<BadgeVariant, { chip: string; text: string }> = {
  default: { chip: 'bg-surface-soft border-border', text: 'text-fg' },
  primary: { chip: 'bg-primary-soft border-primary-line', text: 'text-primary' },
  success: {
    chip: 'bg-emerald-500/15 border-emerald-500/30',
    text: 'text-emerald-700 dark:text-emerald-300'
  },
  danger: { chip: 'bg-red-500/15 border-red-500/30', text: 'text-red-600 dark:text-red-400' }
}

export function Badge({
  label,
  icon: Icon,
  variant = 'default'
}: {
  label: string
  /** Rendered at 11px in the chip's own text color, like the desktop. */
  icon?: (props: IconProps) => React.JSX.Element
  variant?: BadgeVariant
}): React.JSX.Element {
  const tone = VARIANTS[variant]
  return (
    <View className={cn('flex-row items-center gap-1 rounded-md border px-1.5 py-0.5', tone.chip)}>
      {Icon ? <Icon size={11} className={tone.text} /> : null}
      <Text className={cn('font-sans-medium text-left text-[10px]', tone.text)}>{label}</Text>
    </View>
  )
}
