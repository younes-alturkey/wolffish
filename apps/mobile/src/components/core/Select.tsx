import { ArrowDown01Icon, Tick02Icon } from '@/components/core/icons'
import { INPUT_TEXT_ALIGN, WRITING_DIRECTION, rtlPlaceholder } from '@/components/core/Input'
import { KeyboardDismissAccessory } from '@/components/core/KeyboardDismissBar'
import { useTheme, useTokens } from '@/providers/theme/useTheme'
import { cn } from '@/lib/utils/cn'
import { BlurView } from 'expo-blur'
import { useId, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'

export type SelectOption<T extends string> = {
  value: T
  label: string
  icon?: ReactNode
  disabled?: boolean
}

export type SelectProps<T extends string> = {
  value: T
  options: readonly SelectOption<T>[]
  onChange: (value: T) => void
  label?: string
  disabled?: boolean
  placeholder?: string
  className?: string
  /** Max height of the options list in pixels. Beyond this, the list scrolls. */
  maxHeight?: number
  /** Show a search input at the top of the options to filter them. */
  searchable?: boolean
  searchPlaceholder?: string
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled = false,
  placeholder,
  className,
  maxHeight = 300,
  searchable = false,
  searchPlaceholder
}: SelectProps<T>): React.JSX.Element {
  const { t } = useTranslation()
  const { isDark } = useTheme()
  const tokens = useTokens()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // The search field's own iOS keyboard-dismiss chevron.
  const accessoryID = useId()

  const close = (): void => {
    setOpen(false)
    setQuery('')
  }

  const selected = options.find((o) => o.value === value)

  const filtered = useMemo(() => {
    if (!searchable || !query) return options
    const q = query.toLowerCase()
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)
    )
  }, [options, query, searchable])

  return (
    <View className={cn('flex-col gap-1.5', className)}>
      {label && <Text className="text-muted font-sans-medium text-left text-sm">{label}</Text>}
      <Pressable
        accessibilityRole="button"
        // The visible label is a SIBLING Text, so without this the button
        // announces only its current value — "Anthropic", with no hint that it
        // is the model picker. The label is the field's name either way.
        accessibilityLabel={label}
        accessibilityState={{ disabled, expanded: open }}
        disabled={disabled}
        onPress={() => setOpen(true)}
        className={cn(
          'bg-bg border-border h-10 w-full flex-row items-center justify-between gap-2 rounded-lg border px-3',
          open && 'border-accent',
          disabled && 'opacity-50'
        )}
      >
        <View className="min-w-0 flex-1 flex-row items-center gap-2">
          {selected?.icon && <View className="shrink-0">{selected.icon}</View>}
          <Text
            numberOfLines={1}
            className={cn('text-left font-sans text-sm', selected ? 'text-fg' : 'text-muted')}
          >
            {selected?.label ?? placeholder ?? ''}
          </Text>
        </View>
        {/* rotate-0 base keeps the transform CSS variables present from the
            first render — adding rotate-* only when open would upgrade the
            View in NativeWind and remount it (and its dev warning crashes on
            react-navigation context internals). */}
        <View className={cn('shrink-0 rotate-0', open && 'rotate-180')}>
          <ArrowDown01Icon size={16} className="text-muted" />
        </View>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
        <Pressable
          accessibilityRole="none"
          onPress={close}
          className="flex-1 items-center justify-center p-6"
        >
          {/* Glass backdrop — the mobile equivalent of the desktop Modal's
              bg-black/40 backdrop-blur-sm. pointerEvents none keeps the
              backdrop Pressable as the tap-to-close target. */}
          <BlurView
            pointerEvents="none"
            intensity={20}
            tint={isDark ? 'dark' : 'light'}
            blurMethod="dimezisBlurView"
            style={StyleSheet.absoluteFill}
          />
          <View pointerEvents="none" className="absolute inset-0 bg-black/40" />
          {/* Pressable card swallows taps so they don't fall through to the
              closing backdrop; option rows inside win the responder race. */}
          <Pressable
            accessibilityRole="none"
            onPress={() => {}}
            className="bg-surface border-border w-full max-w-md rounded-2xl border shadow-lg"
          >
            {label && (
              <View className="border-border border-b px-4 py-3">
                <Text className="text-fg font-sans-semibold text-left text-base">{label}</Text>
              </View>
            )}
            {searchable && (
              <View className="border-border border-b px-4 py-2">
                {/* Before the field: it autoFocuses, and an accessory that
                    registers after that focus is never looked up again. */}
                <KeyboardDismissAccessory nativeID={accessoryID} />
                <TextInput
                  value={query}
                  onChangeText={setQuery}
                  autoFocus
                  placeholder={rtlPlaceholder(searchPlaceholder ?? t('common.search'))}
                  placeholderTextColor={tokens.muted}
                  selectionColor={tokens.accent}
                  inputAccessoryViewID={accessoryID}
                  className={cn(
                    'text-fg h-9 w-full bg-transparent py-0 font-sans text-sm',
                    INPUT_TEXT_ALIGN
                  )}
                  style={WRITING_DIRECTION}
                />
              </View>
            )}
            {/* Virtualized so long option lists (100+) stay smooth. */}
            <FlatList
              data={filtered}
              keyExtractor={(option) => option.value}
              style={{ maxHeight }}
              contentContainerStyle={{ paddingVertical: 4 }}
              keyboardShouldPersistTaps="always"
              renderItem={({ item: option }) => {
                const isSelected = option.value === value
                const isDisabled = option.disabled === true
                return (
                  <Pressable
                    accessibilityRole="menuitem"
                    accessibilityState={{ selected: isSelected, disabled: isDisabled }}
                    disabled={isDisabled}
                    onPress={() => {
                      onChange(option.value)
                      close()
                    }}
                    className={cn(
                      'flex-row items-center justify-between gap-2 px-4 py-2.5',
                      !isDisabled && 'active:bg-border',
                      isDisabled && 'opacity-40'
                    )}
                  >
                    <View className="min-w-0 flex-1 flex-row items-center gap-2">
                      {option.icon && <View className="shrink-0">{option.icon}</View>}
                      <Text
                        numberOfLines={1}
                        className={cn(
                          'text-left text-sm',
                          isSelected ? 'text-primary font-sans-medium' : 'text-fg font-sans'
                        )}
                      >
                        {option.label}
                      </Text>
                    </View>
                    {isSelected && <Tick02Icon size={16} className="text-primary" />}
                  </Pressable>
                )
              }}
              ListEmptyComponent={
                searchable ? (
                  <View className="px-4 py-2.5">
                    <Text className="text-muted text-left font-sans text-sm">{'—'}</Text>
                  </View>
                ) : null
              }
            />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  )
}
