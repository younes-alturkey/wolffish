import { cn } from '@/lib/utils/cn'
import { Pressable, Text, View } from 'react-native'

/**
 * A row of equal-width tabs on one bordered track, the active one filled —
 * the LanguageToggle's segmented dress, which the Changelog screen's source
 * switch and the Library screen's page tabs both wear. One control rather
 * than three copies of the same classes: a phone has exactly one way of
 * saying "these few things, pick one", and it should look the same wherever
 * it appears.
 *
 * Sized to the Button/Input/Select control metrics (h-10, rounded-lg). The
 * active segment is inert: re-pressing what is already selected is not a
 * change, and treating it as one would reset whatever the tab holds.
 *
 * The track is `bg-surface` — the CARDS' colour, not the page's. Every screen
 * that uses this sits on `bg-bg`, so a `bg-bg` track left the unselected half
 * of the control indistinguishable from the page behind it: a lone filled pill
 * floating in nothing, with no edge to say the other tab was a tab at all.
 * Surface gives the whole strip the same body the content below it has.
 */
export function SegmentedTabs<T extends string>({
  value,
  options,
  onChange,
  accessibilityLabel,
  className
}: {
  value: T
  options: readonly {
    value: T
    label: string
    /** Drawn before the label, at the size the tab strip's text sets. */
    icon?: (props: { size: number; className: string }) => React.JSX.Element
  }[]
  onChange: (next: T) => void
  accessibilityLabel?: string
  className?: string
}): React.JSX.Element {
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      className={cn(
        'border-border bg-surface h-10 w-full flex-row items-stretch rounded-lg border p-0.5',
        className
      )}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityLabel={option.label}
            accessibilityState={{ selected: active }}
            disabled={active}
            onPress={() => onChange(option.value)}
            className={cn(
              'flex-1 flex-row items-center justify-center gap-1.5 rounded-md px-2',
              active ? 'bg-primary' : 'bg-transparent'
            )}
          >
            {option.icon
              ? option.icon({ size: 14, className: active ? 'text-primary-fg' : 'text-muted' })
              : null}
            <Text
              numberOfLines={1}
              className={cn(
                'text-xs',
                active ? 'text-primary-fg font-sans-semibold' : 'text-muted font-sans'
              )}
            >
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}
