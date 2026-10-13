import { ArrowLeft01Icon, ArrowRight01Icon } from '@/components/core/icons'
import { Toggle } from '@/components/settings/ConfigRows'
import { goBack } from '@/lib/utils/back'
import { cn } from '@/lib/utils/cn'
import { useTranslation } from 'react-i18next'
import { I18nManager, Pressable, ScrollView, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

/**
 * Settings building blocks — the desktop Settings grammar on one column:
 * screen header (`text-2xl font-semibold tracking-tight` + muted subtitle),
 * then `bg-surface border rounded-2xl` sections; toggles follow the desktop
 * switch pattern; rows keep the 1px `border-border` separation, never
 * elevation.
 */

export function PanelScreen({
  title,
  subtitle,
  trailing,
  tabs,
  children
}: {
  title: string
  subtitle?: string
  /** The trailing end of the header bar — a page-level control beside the title. */
  trailing?: React.ReactNode
  /**
   * A strip pinned under the header bar, above the scroller — the Library's
   * page tabs. Fixed rather than the first child: a tab strip that scrolls
   * away with the content is one the user has to scroll back up to find.
   */
  tabs?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  const insets = useSafeAreaInsets()
  const BackIcon = I18nManager.isRTL ? ArrowRight01Icon : ArrowLeft01Icon
  return (
    <View className="bg-bg flex-1" style={{ paddingTop: insets.top }}>
      <View className="border-border-soft flex-row items-center gap-1 border-b px-2 pb-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
          hitSlop={8}
          onPress={goBack}
          className="h-9 w-9 items-center justify-center rounded-lg active:bg-border-soft"
        >
          <BackIcon size={20} className="text-fg" />
        </Pressable>
        <Text numberOfLines={1} className="text-fg font-sans-semibold flex-1 text-left text-base">
          {title}
        </Text>
        {trailing}
      </View>
      {tabs ? <View className="px-4 pt-3">{tabs}</View> : null}
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 16 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        {subtitle ? (
          <Text className="text-muted text-left font-sans text-sm leading-relaxed">{subtitle}</Text>
        ) : null}
        {children}
      </ScrollView>
    </View>
  )
}

export function Section({
  title,
  children,
  className
}: {
  title?: string
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <View
      className={cn('bg-surface border-border flex-col gap-4 rounded-2xl border p-4', className)}
    >
      {title ? (
        <Text className="text-fg font-sans-semibold text-left text-base">{title}</Text>
      ) : null}
      {children}
    </View>
  )
}

export function SwitchRow({
  label,
  description,
  icon,
  value,
  onValueChange,
  disabled
}: {
  label: string
  description?: string
  icon?: React.ReactNode
  value: boolean
  onValueChange: (value: boolean) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <View className={cn('flex-row items-center gap-3', disabled && 'opacity-50')}>
      {icon}
      <View className="flex-1 flex-col gap-0.5">
        <Text className="text-fg font-sans-medium text-left text-sm">{label}</Text>
        {description ? (
          <Text className="text-muted text-left font-sans text-xs leading-5">{description}</Text>
        ) : null}
      </View>
      <Toggle
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        accessibilityLabel={label}
      />
    </View>
  )
}

/**
 * A value as an inline-code chip. The chip background is bg-bg because these
 * sit inside bg-surface cards — same contrast trick as MarkdownView's
 * code_inline. `mono` means "this is an LTR technical value"; chips holding
 * localized text (a translated channel name, a relative time) omit it so
 * Arabic keeps its direction.
 */
export function CodeChip({
  value,
  mono,
  selectable,
  className
}: {
  value: string
  mono?: boolean
  selectable?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <View className={cn('bg-bg rounded px-1.5 py-0.5', className)}>
      <Text
        numberOfLines={1}
        selectable={selectable}
        style={mono ? { writingDirection: 'ltr' } : undefined}
        className="text-fg text-left font-mono text-xs"
      >
        {value}
      </Text>
    </View>
  )
}

/** `code` renders the value as a CodeChip instead of plain trailing text;
 *  `icon` leads the label — a mark for rows whose label alone is ambiguous
 *  (two "Version" rows on one screen: whose?). */
export function InfoRow({
  label,
  value,
  mono,
  code,
  icon
}: {
  label: string
  value: string
  mono?: boolean
  code?: boolean
  icon?: React.ReactNode
}): React.JSX.Element {
  if (code) {
    return (
      <View className="flex-row items-center justify-between gap-3">
        <View className="flex-row items-center gap-2">
          {icon}
          <Text className="text-muted text-left font-sans text-sm">{label}</Text>
        </View>
        <CodeChip value={value} mono={mono} selectable className="flex-shrink" />
      </View>
    )
  }
  return (
    <View className="flex-row items-center justify-between gap-3">
      <View className="flex-row items-center gap-2">
        {icon}
        <Text className="text-muted text-left font-sans text-sm">{label}</Text>
      </View>
      <Text
        numberOfLines={1}
        selectable
        style={mono ? { writingDirection: 'ltr' } : undefined}
        className={cn(
          'text-fg flex-shrink text-left text-sm',
          mono ? 'font-mono text-xs' : 'font-sans-medium'
        )}
      >
        {value}
      </Text>
    </View>
  )
}

export type StatusTone = 'ok' | 'busy' | 'error' | 'idle'

/**
 * Connection state as a colour. `tone` distinguishes the two ways of not
 * being connected: working on it (amber) reads as progress, while the grey
 * of `idle` reads as nothing happening — showing grey mid-handshake tells
 * the user the link is dead when it is seconds from up.
 */
export function StatusDot({
  connected,
  tone
}: {
  connected?: boolean
  tone?: StatusTone
}): React.JSX.Element {
  const resolved = tone ?? (connected ? 'ok' : 'idle')
  const color = {
    ok: 'bg-emerald-500',
    busy: 'bg-amber-500',
    error: 'bg-rose-500',
    idle: 'bg-border'
  }[resolved]
  return <View className={cn('h-2 w-2 rounded-full', color)} accessibilityElementsHidden />
}

/**
 * SwitchRow's shape with a dot and a word where the toggle would be — for
 * state this device reports but must not drive.
 *
 * The sibling of ConfigRows' `ConfigStatusRow`, and separate from it on
 * purpose: that one binds to a boolean config key and can only ever say On or
 * Off. This one takes the reading straight, so it can carry a THIRD state —
 * unknown — and name each in the words that fit ("Ready" / "Not on your PATH"
 * rather than On / Off). A machine fact the desktop failed to probe has to
 * read as unanswered, not as a failure.
 */
export function StatusRow({
  label,
  description,
  icon,
  tone,
  value
}: {
  label: string
  description?: string
  icon?: React.ReactNode
  tone: StatusTone
  value: string
}): React.JSX.Element {
  return (
    <View className="flex-row items-center gap-3">
      {icon}
      <View className="flex-1 flex-col gap-0.5">
        <Text className="text-fg font-sans-medium text-left text-sm">{label}</Text>
        {description ? (
          <Text className="text-muted text-left font-sans text-xs leading-5">{description}</Text>
        ) : null}
      </View>
      <View
        className="shrink-0 flex-row items-center gap-1.5"
        accessibilityLabel={`${label} ${value}`}
      >
        <StatusDot tone={tone} />
        <Text
          className={cn(
            'font-sans text-xs',
            tone === 'ok'
              ? 'text-emerald-600 dark:text-emerald-400'
              : tone === 'error'
                ? 'text-rose-600 dark:text-rose-400'
                : 'text-muted'
          )}
        >
          {value}
        </Text>
      </View>
    </View>
  )
}

/**
 * `status` puts live state at the far end of the row, opposite the label: a
 * dot and a word, so a tab worth opening can be told from one that is merely
 * there without opening it. `trailing` is the same position for anything a
 * dot and a word cannot say — a count, a size, a pair of brand marks. Both
 * ride the row's own gap rather than a second line, because the answer they
 * give is one glance long.
 *
 * A `trailing` node carries its own layout (what shrinks, what must not) and
 * its own spoken form, so the row stops overriding the accessibility label and
 * lets the summary speak with the label instead.
 */
export function NavRow({
  label,
  description,
  icon,
  status,
  trailing,
  onPress
}: {
  label: string
  description?: string
  icon?: React.ReactNode
  status?: { tone: StatusTone; label: string }
  trailing?: React.ReactNode
  onPress: () => void
}): React.JSX.Element {
  const Chevron = I18nManager.isRTL ? ArrowLeft01Icon : ArrowRight01Icon
  return (
    <Pressable
      accessibilityRole="button"
      // The dot is decorative and the label below is inside a button, so the
      // status only reaches a screen reader if it is spoken with the row.
      accessibilityLabel={trailing ? undefined : status ? `${label}, ${status.label}` : label}
      onPress={onPress}
      className="bg-surface border-border flex-row items-center gap-3 rounded-xl border px-4 py-3 active:bg-border-soft"
    >
      {icon}
      <View className="flex-1 flex-col gap-0.5">
        <Text className="text-fg font-sans-medium text-left text-sm">{label}</Text>
        {description ? (
          <Text numberOfLines={1} className="text-muted text-left font-sans text-xs">
            {description}
          </Text>
        ) : null}
      </View>
      {status ? (
        <View className="shrink-0 flex-row items-center gap-1.5">
          <StatusDot tone={status.tone} />
          <Text numberOfLines={1} className="text-muted font-sans text-xs">
            {status.label}
          </Text>
        </View>
      ) : null}
      {trailing}
      <Chevron size={16} className="text-muted" />
    </Pressable>
  )
}
