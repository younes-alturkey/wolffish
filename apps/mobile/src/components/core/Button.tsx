import { cn } from '@/lib/utils/cn'
import { Children, forwardRef } from 'react'
import { Pressable, Text, View, type PressableProps } from 'react-native'

export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'danger' | 'soft' | 'dangerSoft'
export type ButtonSize = 'sm' | 'md' | 'lg'

export type ButtonProps = PressableProps & {
  variant?: ButtonVariant
  size?: ButtonSize
  className?: string
  /** Extra classes for text children (merged after the variant text style). */
  textClassName?: string
}

const base = 'flex-row items-center justify-center gap-2 rounded-lg self-start'

// Container styles per variant — mirrors wolffish-app Button.tsx. Touch has
// no hover, so the pressed state maps to the desktop :active state.
const variants: Record<ButtonVariant, string> = {
  primary: 'bg-primary shadow-sm active:opacity-90',
  ghost: 'bg-transparent active:bg-border',
  outline: 'bg-bg border border-border active:bg-border',
  danger: 'bg-transparent active:bg-rose-500/20',
  // Filled, borderless pair for side-by-side bulk actions (gray + red).
  soft: 'bg-border active:opacity-80',
  dangerSoft: 'bg-rose-500/15 active:bg-rose-500/25'
}

// Text color per variant — React Native does not cascade color to children.
const textVariants: Record<ButtonVariant, string> = {
  primary: 'text-primary-fg',
  ghost: 'text-fg',
  outline: 'text-fg',
  danger: 'text-rose-500',
  soft: 'text-fg',
  dangerSoft: 'text-rose-500'
}

const sizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3',
  md: 'h-10 px-4',
  lg: 'h-12 px-5'
}

const textSizes: Record<ButtonSize, string> = {
  sm: 'text-sm',
  md: 'text-sm',
  lg: 'text-base'
}

export const Button = forwardRef<View, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className, textClassName, disabled, children, ...rest },
  ref
) {
  const textClass = cn('font-sans-medium', textVariants[variant], textSizes[size], textClassName)
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      disabled={disabled}
      className={cn(base, variants[variant], sizes[size], disabled && 'opacity-50', className)}
      {...rest}
    >
      {Children.map(children as React.ReactNode, (child) =>
        typeof child === 'string' || typeof child === 'number' ? (
          <Text className={textClass}>{child}</Text>
        ) : (
          child
        )
      )}
    </Pressable>
  )
})
