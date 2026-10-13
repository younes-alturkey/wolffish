import { cn } from '@lib/utils/cn'

/**
 * The unread pill — solid primary, the one mark "unread" wears everywhere
 * (the menu disc, the bell, a conversation row, the Notifications row).
 * Zero renders nothing: a pill reading 0 is a mark with nothing behind it.
 */
export function UnreadBadge({
  count,
  className
}: {
  count: number
  className?: string
}): React.JSX.Element | null {
  if (count <= 0) return null
  return (
    <span
      className={cn(
        'bg-primary text-primary-fg inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold tabular-nums',
        className
      )}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}
