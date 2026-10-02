import { cn } from '@lib/utils/cn'
import { ArrowDown01Icon, Tick02Icon } from 'hugeicons-react'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'

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
  id?: string
  /** Max height of the dropdown list in pixels. Beyond this, the list scrolls. */
  maxHeight?: number
  /** Show a search input at the top of the dropdown to filter options. */
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
  id,
  maxHeight = 300,
  searchable = false,
  searchPlaceholder
}: SelectProps<T>): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const generatedId = useId()
  const buttonId = id ?? `select-${generatedId}`
  const listboxId = `${buttonId}-listbox`
  const labelId = `${buttonId}-label`

  const close = (): void => {
    setOpen(false)
    setQuery('')
  }

  const selected = options.find((o) => o.value === value) ?? options[0]

  const filtered = useMemo(() => {
    if (!searchable || !query) return options
    const q = query.toLowerCase()
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)
    )
  }, [options, query, searchable])

  useEffect(() => {
    if (!open) return
    if (searchable) {
      requestAnimationFrame(() => searchRef.current?.focus())
    }
    const onPointerDown = (e: PointerEvent): void => {
      if (!rootRef.current) return
      if (!rootRef.current.contains(e.target as Node)) close()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        close()
        buttonRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, searchable])

  return (
    <div ref={rootRef} className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label id={labelId} htmlFor={buttonId} className="text-muted text-sm font-medium">
          {label}
        </label>
      )}
      <div className="relative">
        <button
          ref={buttonRef}
          id={buttonId}
          type="button"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-labelledby={label ? labelId : undefined}
          onClick={() => (open ? close() : setOpen(true))}
          className={cn(
            'bg-bg text-fg border-border hover:border-muted w-full',
            'flex h-10 items-center justify-between gap-2 rounded-lg border px-3 text-sm',
            'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
            'disabled:cursor-not-allowed disabled:opacity-50',
            open && 'border-accent'
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected?.icon && (
              <span className="text-muted flex shrink-0 items-center">{selected.icon}</span>
            )}
            <span className={cn('truncate', !selected && placeholder && 'text-muted')}>
              {selected?.label ?? placeholder}
            </span>
          </span>
          <ArrowDown01Icon
            size={16}
            className={cn(
              'text-muted shrink-0 transition-transform duration-150',
              open && 'rotate-180'
            )}
          />
        </button>
        {open && (
          <div
            className={cn(
              'bg-bg border-border absolute z-20 mt-1.5 w-full',
              'rounded-lg border shadow-lg'
            )}
          >
            {searchable && (
              <div className="border-border border-b px-2 py-1.5">
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={searchPlaceholder ?? 'Search…'}
                  className={cn(
                    'bg-transparent text-fg placeholder:text-muted/50 w-full text-sm outline-none'
                  )}
                />
              </div>
            )}
            <ul
              id={listboxId}
              role="listbox"
              aria-labelledby={label ? labelId : undefined}
              style={{ maxHeight }}
              className="overflow-y-auto py-1"
            >
              {filtered.map((option) => {
                const isSelected = option.value === value
                const isDisabled = option.disabled === true
                return (
                  <li
                    key={option.value}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={isDisabled || undefined}
                    onClick={() => {
                      if (isDisabled) return
                      onChange(option.value)
                      close()
                      buttonRef.current?.focus()
                    }}
                    className={cn(
                      'flex items-center justify-between gap-2 px-3 py-2 text-sm',
                      isDisabled
                        ? 'cursor-not-allowed opacity-40'
                        : cn('cursor-pointer hover:bg-border/50'),
                      isSelected && 'text-primary font-medium'
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {option.icon && (
                        <span
                          className={cn(
                            'flex shrink-0 items-center',
                            isSelected ? 'text-primary' : 'text-muted'
                          )}
                        >
                          {option.icon}
                        </span>
                      )}
                      <span className="truncate">{option.label}</span>
                    </span>
                    {isSelected && <Tick02Icon size={16} className="text-primary shrink-0" />}
                  </li>
                )
              })}
              {searchable && filtered.length === 0 && (
                <li className="text-muted/50 px-3 py-2 text-sm">{'—'}</li>
              )}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
