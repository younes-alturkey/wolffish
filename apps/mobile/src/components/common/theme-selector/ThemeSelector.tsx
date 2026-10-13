import { cn } from '@/lib/utils/cn'
import { useTheme, type ThemeSource } from '@/providers/theme/useTheme'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, Text, View } from 'react-native'

/**
 * Theme picker as a three-way switch — the desktop uses a Select here, but on
 * a phone the three options fit on one track, and it then reads as a sibling
 * of the language switch it sits next to in Appearance.
 */
export function ThemeSelector({
  className,
  hideLabel = false
}: {
  className?: string
  /** Hide the inline label when a surrounding section already titles it. */
  hideLabel?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const { theme, setTheme } = useTheme()

  const options = useMemo<readonly { value: ThemeSource; label: string }[]>(
    () => [
      { value: 'system', label: t('theme.system') },
      { value: 'light', label: t('theme.light') },
      { value: 'dark', label: t('theme.dark') }
    ],
    [t]
  )

  return (
    <View className={cn('flex-col gap-1.5', className)}>
      {!hideLabel && (
        <Text className="text-muted font-sans-medium text-left text-sm">{t('theme.label')}</Text>
      )}
      {/* Same track metrics as the LanguageToggle: h-10 + rounded-lg match the
          Button/Input/Select controls. */}
      <View className="border-border bg-bg h-10 w-full flex-row items-stretch rounded-lg border p-0.5">
        {options.map((option) => {
          const active = option.value === theme
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              disabled={active}
              // Applying a theme is instant and reversible, so unlike the
              // language switch there is nothing to confirm first.
              onPress={() => void setTheme(option.value)}
              className={cn(
                'flex-1 flex-row items-center justify-center rounded-md px-2',
                active ? 'bg-primary' : 'bg-transparent'
              )}
            >
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
    </View>
  )
}
