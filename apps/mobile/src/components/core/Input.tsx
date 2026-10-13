import { EyeIcon, ViewOffIcon } from '@/components/core/icons'
import { KeyboardDismissAccessory } from '@/components/core/KeyboardDismissBar'
import { useTokens } from '@/providers/theme/useTheme'
import { cn } from '@/lib/utils/cn'
import { forwardRef, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { I18nManager, Pressable, Text, TextInput, View, type TextInputProps } from 'react-native'

// Base bidi direction for typed input text. Alignment alone (text-left,
// swapped in RTL) puts the text on the correct side, but with an LTR base
// direction Arabic punctuation like the trailing ؟ still renders on the
// wrong end of the sentence.
export const WRITING_DIRECTION = {
  writingDirection: I18nManager.isRTL ? 'rtl' : 'ltr'
} as const

// TextInput ignores React Native's RTL left/right swap (it works for Text
// but not for input placeholders), so alignment is set explicitly per
// direction — the growth-app approach.
export const INPUT_TEXT_ALIGN = I18nManager.isRTL ? 'text-right' : 'text-left'

/**
 * Placeholders ignore the writingDirection text style (the native field
 * renders them separately), so wrap them in Unicode RTL-isolate marks
 * (U+2067…U+2069) when the app is RTL. This forces correct bidi ordering
 * of the string itself; Latin-only placeholders are visually unaffected.
 */
export function rtlPlaceholder(placeholder: string | undefined): string | undefined {
  if (!placeholder || !I18nManager.isRTL) return placeholder
  return `⁧${placeholder}⁩`
}

// The reveal toggle sits on the input's logical end edge, with matching
// paddingEnd so typed text never runs under it. Yoga resolves Start/End
// before physical Left/Right/Horizontal (so paddingEnd beats px-3 on that
// edge only) and flips both with I18nManager — the eye mirrors in RTL.
const TOGGLE_INSET = { end: 0 } as const
const TOGGLE_TEXT_PADDING = { paddingEnd: 40 } as const

export type InputProps = TextInputProps & {
  label?: string
  className?: string
  /** Extra classes for the wrapping column (label + field). */
  containerClassName?: string
}

export const Input = forwardRef<TextInput, InputProps>(function Input(
  {
    label,
    className,
    containerClassName,
    editable,
    placeholder,
    secureTextEntry,
    onFocus,
    onBlur,
    style,
    ...rest
  },
  ref
) {
  const { t } = useTranslation()
  const tokens = useTokens()
  const [focused, setFocused] = useState(false)
  const [revealed, setRevealed] = useState(false)
  // Every field gets its own iOS dismiss chevron, paired by a per-instance
  // id — which is what makes it show on pushed screens and inside RN Modal
  // dialogs alike (see KeyboardDismissBar).
  const accessoryID = useId()
  const disabled = editable === false
  const field = (
    <TextInput
      ref={ref}
      inputAccessoryViewID={accessoryID}
      editable={editable}
      secureTextEntry={secureTextEntry && !revealed}
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
      className={cn(
        'bg-bg text-fg border-border h-10 w-full rounded-lg border px-3 py-0 font-sans text-sm',
        INPUT_TEXT_ALIGN,
        focused && 'border-accent',
        disabled && 'opacity-50',
        className
      )}
      style={[WRITING_DIRECTION, secureTextEntry ? TOGGLE_TEXT_PADDING : undefined, style]}
      {...rest}
    />
  )
  return (
    <View className={cn('flex-col gap-1.5', containerClassName)}>
      {/* Before the field in tree order, so a field that autoFocuses on
          mount still finds its accessory registered (see KeyboardDismissBar).
          Zero-size — it never earns the column gap. */}
      <KeyboardDismissAccessory nativeID={accessoryID} />
      {/* text-left = start alignment: React Native swaps left/right in RTL,
          matching the desktop app's dir-driven alignment. */}
      {label && <Text className="text-muted font-sans-medium text-left text-sm">{label}</Text>}
      {secureTextEntry ? (
        <View className="relative">
          {field}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(revealed ? 'common.hidePassword' : 'common.showPassword')}
            disabled={disabled}
            onPress={() => setRevealed((v) => !v)}
            className={cn(
              'absolute bottom-0 top-0 w-10 items-center justify-center',
              disabled && 'opacity-50'
            )}
            style={TOGGLE_INSET}
          >
            {revealed ? (
              <ViewOffIcon size={16} className="text-muted" />
            ) : (
              <EyeIcon size={16} className="text-muted" />
            )}
          </Pressable>
        </View>
      ) : (
        field
      )}
    </View>
  )
})
