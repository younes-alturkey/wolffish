import type { ReactNode } from 'react'
import { cn } from '@lib/utils/cn'

/**
 * Forces left-to-right rendering for numeric content whose units are ASCII
 * (percentages, counts, bare numbers). Without `dir="ltr"`, strings like
 * "1.2 MB/s" get reordered under RTL (Arabic) and end up reading wrong.
 *
 * Do NOT wrap a localized unit string (anything from `formatBytesL` /
 * `formatDurationL`) in this: once the unit is an Arabic word the string is
 * RTL-majority, and pinning an LTR base under it tears each numeral away from
 * its unit — "4.0 جيجا بايت / 1.2 جيجا بايت" renders with the "4.0" stranded
 * at the far left. Those formatters already bidi-isolate their numerals, so
 * they render correctly in ambient flow; use a plain `tabular-nums` span.
 */
export function Num({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <span dir="ltr" className={cn('inline-block tabular-nums', className)}>
      {children}
    </span>
  )
}
