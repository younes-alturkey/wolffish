import type { ReasoningMode } from '@/lib/tunnel/protocol'
import { cn } from '@/lib/utils/cn'
import { useTranslation } from 'react-i18next'
import { Pressable, Text, View } from 'react-native'

/**
 * Off | Normal | High | Max, as the phone's answer to the desktop card's
 * reasoning chips.
 *
 * Sibling to ModePills, deliberately: same pill frame, same `text-[10px] px-2`
 * size (a card's control row, not a settings switch), same disabled treatment.
 * The two sit together on a card and must read as one control cluster.
 *
 * `modes` is the subset the SELECTED MODEL honours, in canonical order — the
 * same list the composer's thinking control offers, so a card can never show a
 * mode the model would silently ignore. A single-mode model renders its one
 * pill inert; an empty list renders nothing at all.
 */
export function ThinkingPills({
  modes,
  value,
  disabled,
  onChange
}: {
  /** Ordered modes the chat's current model supports (from useChatReasoning). */
  modes: readonly ReasoningMode[]
  /** The active mode: the item's own stamp, else the model's current mode. */
  value: ReasoningMode
  disabled?: boolean
  onChange: (mode: ReasoningMode) => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (modes.length === 0) return null
  // One mode is not a choice — show it, but nothing to press.
  const switchable = modes.length > 1
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={t('procedures.thinkingAria')}
      className={cn(
        'border-border bg-bg flex-row items-center self-start rounded-lg border p-0.5',
        disabled && 'opacity-60'
      )}
    >
      {modes.map((mode) => {
        const active = value === mode
        return (
          <Pressable
            key={mode}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            disabled={disabled || active || !switchable}
            onPress={() => onChange(mode)}
            className={cn('rounded-md px-2 py-1', active && 'bg-primary')}
          >
            <Text
              className={cn(
                'font-sans-medium text-[10px]',
                active ? 'text-primary-fg' : 'text-muted'
              )}
            >
              {t(`settings.thinking.${mode}`)}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}
