import { INPUT_TEXT_ALIGN, WRITING_DIRECTION, rtlPlaceholder } from '@/components/core/Input'
import { KeyboardDismissAccessory } from '@/components/core/KeyboardDismissBar'
import { useTokens } from '@/providers/theme/useTheme'
import { cn } from '@/lib/utils/cn'
import { forwardRef, useId, useState } from 'react'
import { Text, TextInput, View, type TextInputProps } from 'react-native'

export type TextareaProps = TextInputProps & {
  label?: string
  /** Visible line count used to size the field (default 4). */
  rows?: number
  className?: string
  containerClassName?: string
}

const LINE_HEIGHT = 20
const VERTICAL_PADDING = 20

export const Textarea = forwardRef<TextInput, TextareaProps>(function Textarea(
  {
    label,
    rows = 4,
    className,
    containerClassName,
    editable,
    placeholder,
    onFocus,
    onBlur,
    style,
    ...rest
  },
  ref
) {
  const tokens = useTokens()
  const [focused, setFocused] = useState(false)
  // Same contract as Input: the field's own iOS dismiss chevron.
  const accessoryID = useId()
  const disabled = editable === false
  return (
    <View className={cn('flex-col gap-1.5', containerClassName)}>
      {/* Before the field in tree order, so a field that autoFocuses on
          mount still finds its accessory registered (see KeyboardDismissBar). */}
      <KeyboardDismissAccessory nativeID={accessoryID} />
      {label && <Text className="text-muted font-sans-medium text-left text-sm">{label}</Text>}
      <TextInput
        ref={ref}
        multiline
        inputAccessoryViewID={accessoryID}
        editable={editable}
        textAlignVertical="top"
        placeholder={rtlPlaceholder(placeholder)}
        placeholderTextColor={tokens.muted}
        selectionColor={tokens.accent}
        onFocus={(e) => {
          setFocused(true)
          onFocus?.(e)
        }}
        onBlur={(e) => {
          setFocused(false)
          onBlur?.(e)
        }}
        style={[{ minHeight: rows * LINE_HEIGHT + VERTICAL_PADDING }, WRITING_DIRECTION, style]}
        className={cn(
          'bg-bg text-fg border-border w-full rounded-lg border px-3 py-2.5 font-sans text-sm leading-5',
          INPUT_TEXT_ALIGN,
          focused && 'border-accent',
          disabled && 'opacity-50',
          className
        )}
        {...rest}
      />
    </View>
  )
})
