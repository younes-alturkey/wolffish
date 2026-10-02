import { cn } from '@lib/utils/cn'
import { forwardRef, type ButtonHTMLAttributes } from 'react'

export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
}

const base =
  'inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap select-none cursor-pointer ' +
  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg ' +
  'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none'

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-fg hover:brightness-110 active:brightness-95 shadow-sm',
  ghost: 'bg-transparent text-fg hover:bg-border/60 active:bg-border',
  outline: 'bg-bg/20 text-fg border border-border hover:bg-bg active:bg-bg/40',
  // Destructive text button — rose text on a transparent base, matching
  // the danger actions used across the other settings tabs.
  danger: 'bg-transparent text-rose-500 hover:bg-rose-500/10 active:bg-rose-500/20'
}

const sizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-5 text-base'
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', className, type = 'button', children, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(base, variants[variant], sizes[size], className)}
      {...rest}
    >
      {children}
    </button>
  )
})
