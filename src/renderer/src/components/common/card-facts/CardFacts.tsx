import { cn } from '@lib/utils/cn'

/**
 * One reference fact on a card — a small muted glyph beside its text, so the
 * facts line reads by icons before words. The text truncates inside the fact;
 * the row reflows between facts.
 */
export function CardFact({
  icon,
  title,
  children
}: {
  icon: React.ReactNode
  /** Optional tooltip for the whole fact (e.g. the full moment behind a relative one). */
  title?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span title={title} className="inline-flex min-w-0 items-center gap-1">
      <span aria-hidden className="shrink-0">
        {icon}
      </span>
      <span className="truncate">{children}</span>
    </span>
  )
}

/**
 * The facts row a card closes with — edit stamp, bound project, counts — as
 * wrapped icon-led facts. Shared by the automations, procedures and projects
 * cards so the three footers can never drift apart.
 */
export function CardFacts({
  children,
  className
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'text-muted flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-tight',
        className
      )}
    >
      {children}
    </div>
  )
}
