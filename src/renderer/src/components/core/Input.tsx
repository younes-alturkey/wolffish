import { forwardRef, useId, type InputHTMLAttributes } from 'react'
import { cn } from '@lib/utils/cn'

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, id, className, ...rest },
  ref
) {
  const generatedId = useId()
  const inputId = id ?? `input-${generatedId}`
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="text-muted text-sm font-medium">
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        className={cn(
          'bg-bg text-fg border-border placeholder:text-muted enabled:hover:border-muted',
          'h-10 w-full rounded-lg border px-3 text-sm',
          'focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        {...rest}
      />
    </div>
  )
})
