import { ConfirmDialog } from '@/components/core/ConfirmDialog'
import type { SupportedLocale } from '@/lib/i18n'
import { useLocale } from '@/providers/locale/useLocale'
import { cn } from '@/lib/utils/cn'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, Text, View } from 'react-native'

// Each option is labelled with its full name in its own language so the
// control stays readable whichever language the app is currently in.
const OPTIONS: readonly { value: SupportedLocale; label: string }[] = [
  { value: 'ar', label: 'العربية' },
  { value: 'en', label: 'English' }
]

export function LanguageToggle({
  label,
  className
}: {
  label?: string
  className?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const { locale, setLocale } = useLocale()
  const [pending, setPending] = useState<SupportedLocale | null>(null)
  const [switching, setSwitching] = useState<SupportedLocale | null>(null)

  const apply = async (next: SupportedLocale): Promise<void> => {
    setPending(null)
    setSwitching(next)
    // Reloads the app to flip RTL — nothing after this runs in dev.
    await setLocale(next)
    setSwitching(null)
  }

  const choose = (next: SupportedLocale): void => {
    // Tapping the language already in use stays inert. Confirm before
    // switching: applying a language restarts the app, which would throw
    // away anything in progress.
    if (next === locale || switching) return
    setPending(next)
  }

  return (
    <View className={cn('flex-col gap-1.5', className)}>
      {label && <Text className="text-muted font-sans-medium text-left text-sm">{label}</Text>}
      {/* h-10 + rounded-lg match the Button/Input/Select control metrics;
          the whole track dims while a switch is applying, like a disabled
          control. */}
      <View
        className={cn(
          'border-border bg-bg h-10 w-full flex-row items-stretch rounded-lg border p-0.5',
          switching !== null && 'opacity-50'
        )}
      >
        {OPTIONS.map((option) => {
          const active = option.value === locale
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              disabled={active || switching !== null}
              onPress={() => choose(option.value)}
              // Equal-width segments fill the track. The labels never swap
              // for a spinner while a switch applies — the track-level dim
              // above is the busy signal, so nothing in here ever changes.
              className={cn(
                'flex-1 flex-row items-center justify-center rounded-md px-3',
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

      <ConfirmDialog
        open={pending !== null}
        busy={switching !== null}
        title={t('locale.confirmTitle')}
        message={t('locale.confirmMessage')}
        confirmLabel={t('locale.confirmSwitch')}
        cancelLabel={t('common.cancel')}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending) void apply(pending)
        }}
      />
    </View>
  )
}
