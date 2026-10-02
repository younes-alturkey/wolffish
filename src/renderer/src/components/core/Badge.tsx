import type { HTMLAttributes } from 'react'
import { cn } from '@lib/utils/cn'

export type BadgeVariant = 'default' | 'primary' | 'warning' | 'success' | 'danger'
export type BadgeSize = 'sm' | 'md'

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  variant?: BadgeVariant
  size?: BadgeSize
}

const base = 'inline-flex items-center gap-1 rounded-md font-medium select-none whitespace-nowrap'

const variants: Record<BadgeVariant, string> = {
  default: 'bg-border/40 text-fg ring-1 ring-border',
  primary: 'bg-primary/15 text-primary ring-1 ring-primary/30',
  warning: 'bg-amber-500/15 text-amber-700 ring-1 ring-amber-500/30 dark:text-amber-300',
  success: 'bg-emerald-500/15 text-emerald-700 ring-1 ring-emerald-500/30 dark:text-emerald-300',
  danger: 'bg-red-500/15 text-red-600 ring-1 ring-red-500/30 dark:text-red-400'
}

const sizes: Record<BadgeSize, string> = {
  sm: 'h-5 px-1.5 text-[10px]',
  md: 'h-7 px-2.5 text-xs'
}

export function Badge({
  variant = 'default',
  size = 'sm',
  className,
  children,
  ...rest
}: BadgeProps): React.JSX.Element {
  return (
    <span className={cn(base, variants[variant], sizes[size], className)} {...rest}>
      {children}
    </span>
  )
}
