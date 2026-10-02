import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy01Icon, Tick02Icon } from 'hugeicons-react'
import { cn } from '@lib/utils/cn'

export type CopyButtonProps = {
  text: string
  size?: number
  variant?: 'inline' | 'overlay'
  ariaLabelKey?: string
  className?: string
}

export function CopyButton({
  text,
  size = 14,
  variant = 'inline',
  ariaLabelKey = 'chat.copy',
  className
}: CopyButtonProps): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard write can fail in restricted contexts; silently swallow.
    }
  }

  // Icon only — matches the icon-only reveal/download/expand controls in the
  // viewers. The label lives in the tooltip + aria-label instead, and the
  // checkmark icon is the "copied" confirmation.
  const base =
    'inline-flex items-center rounded-md cursor-pointer ' +
    'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
  const styles =
    variant === 'overlay'
      ? 'bg-surface/80 text-muted hover:text-fg border border-border/60 p-1 backdrop-blur'
      : 'text-muted hover:text-fg p-1'

  const label = t(copied ? 'chat.copied' : ariaLabelKey)

  return (
    <button
      type="button"
      onClick={() => void onCopy()}
      aria-label={label}
      title={label}
      className={cn(base, styles, className)}
    >
      {copied ? <Tick02Icon size={size} /> : <Copy01Icon size={size} />}
    </button>
  )
}
