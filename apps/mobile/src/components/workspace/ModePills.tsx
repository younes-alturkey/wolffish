import { cn } from '@/lib/utils/cn'
import { useTranslation } from 'react-i18next'
import { Pressable, Text, View } from 'react-native'

/**
 * Single | Workflow, as the desktop's two-segment pill. Written out rather than
 * reusing settings' Toggle because this is not a boolean setting — the labels
 * come from the chat mode picker's own keys, so the wording matches the control
 * the user already knows from the composer.
 *
 * Sized to the desktop's card pills (`text-[10px] px-2`), not to the settings
 * switches: these sit in a card's action row beside the icon buttons, where the
 * settings size would push the title column off the row.
 */
export function ModePills({
  value,
  disabled,
  onChange
}: {
  value: 'single' | 'workflow'
  disabled?: boolean
  onChange: (mode: 'single' | 'workflow') => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={t('procedures.modeAria')}
      className={cn(
        'border-border bg-bg flex-row items-center self-start rounded-lg border p-0.5',
        disabled && 'opacity-60'
      )}
    >
      {(['single', 'workflow'] as const).map((mode) => {
        const active = value === mode
        return (
          <Pressable
            key={mode}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            disabled={disabled || active}
            onPress={() => onChange(mode)}
            className={cn('rounded-md px-2 py-1', active && 'bg-primary')}
          >
            <Text
              className={cn(
                'font-sans-medium text-[10px]',
                active ? 'text-primary-fg' : 'text-muted'
              )}
            >
              {t(`settings.chatModes.${mode}`)}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}
