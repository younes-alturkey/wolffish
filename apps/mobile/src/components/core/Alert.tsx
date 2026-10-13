import {
  Alert02Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  InformationCircleIcon
} from '@/components/core/icons'
import { cn } from '@/lib/utils/cn'
import { useTranslation } from 'react-i18next'
import { Pressable, Text, View } from 'react-native'

export type AlertTone = 'info' | 'success' | 'warning' | 'error'

export type AlertProps = {
  tone?: AlertTone
  /** Optional bold first line. */
  title?: string
  message: string
  /** When provided, a dismiss button is shown and wired to this callback. */
  onDismiss?: () => void
  className?: string
}

// Tone palette mirrors wolffish-app ToastProvider TONE_STYLES. Split into
// container/text pairs because React Native does not cascade text color.
const TONE_CONTAINER: Record<AlertTone, string> = {
  info: 'bg-surface border-border',
  success: 'bg-emerald-50 border-emerald-300 dark:bg-emerald-900/40 dark:border-emerald-700',
  warning: 'bg-amber-50 border-amber-300 dark:bg-amber-900/40 dark:border-amber-700',
  error: 'bg-red-50 border-red-300 dark:bg-red-900/40 dark:border-red-700'
}

export const TONE_TEXT: Record<AlertTone, string> = {
  info: 'text-fg',
  success: 'text-emerald-900 dark:text-emerald-100',
  warning: 'text-amber-900 dark:text-amber-100',
  error: 'text-red-900 dark:text-red-100'
}

export function ToneIcon({
  tone,
  className
}: {
  tone: AlertTone
  className?: string
}): React.JSX.Element {
  if (tone === 'success') return <CheckmarkCircle02Icon size={16} className={className} />
  if (tone === 'warning' || tone === 'error') return <Alert02Icon size={16} className={className} />
  return <InformationCircleIcon size={16} className={className} />
}

export function Alert({
  tone = 'info',
  title,
  message,
  onDismiss,
  className
}: AlertProps): React.JSX.Element {
  const { t } = useTranslation()
  const textClass = TONE_TEXT[tone]
  return (
    <View
      accessibilityLiveRegion="polite"
      className={cn(
        'flex-row items-start gap-2 rounded-xl border px-4 py-3',
        TONE_CONTAINER[tone],
        className
      )}
    >
      <View className="mt-0.5 shrink-0">
        <ToneIcon tone={tone} className={textClass} />
      </View>
      {/* Selectable: an alert is most often an error, and an error the user
          can't copy is one they have to retype into a search box. The dismiss
          control is its own Pressable outside this column, so nothing here
          competes with a long press. */}
      <View className="min-w-0 flex-1 flex-col gap-0.5">
        {title && (
          <Text selectable className={cn('font-sans-semibold text-left text-sm', textClass)}>
            {title}
          </Text>
        )}
        <Text selectable className={cn('text-left font-sans text-sm leading-relaxed', textClass)}>
          {message}
        </Text>
      </View>
      {onDismiss && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.dismiss')}
          onPress={onDismiss}
          className="mt-0.5 shrink-0 rounded-md p-0.5 opacity-60 active:opacity-100"
        >
          <Cancel01Icon size={14} className={textClass} />
        </Pressable>
      )}
    </View>
  )
}
