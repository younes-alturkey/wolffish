import { cn } from '@lib/utils/cn'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

export type ActivityHeatmapEntry = {
  date: string
  value: number
}

type Props = {
  entries: ActivityHeatmapEntry[]
  year: number
  weekdayLabels?: string[]
  formatTooltip?: (entry: ActivityHeatmapEntry) => string
  monthLocale?: string
  showMonthLabels?: boolean
  showWeekdayLabels?: boolean
  // 0 = grid rows go Sun..Sat, 1 = Mon..Sun. Defaults to Monday.
  weekStartsOn?: 0 | 1
  className?: string
}

const SUNDAY_FIRST_WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const MONDAY_FIRST_WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const CELL_GAP = 2
const LABEL_COLUMN_WIDTH = 24

export function ActivityHeatmap({
  entries,
  year,
  weekdayLabels,
  formatTooltip,
  monthLocale,
  showMonthLabels = true,
  showWeekdayLabels = true,
  weekStartsOn = 1,
  className
}: Props): React.JSX.Element {
  const gridRef = useRef<HTMLDivElement>(null)
  const [cellSize, setCellSize] = useState(12)
  const labels =
    weekdayLabels ?? (weekStartsOn === 1 ? MONDAY_FIRST_WEEKDAYS : SUNDAY_FIRST_WEEKDAYS)
  const { weeks, monthLabels, maxValue, weekCount } = useMemo(() => {
    const start = new Date(year, 0, 1)
    const end = new Date(year, 11, 31)
    // Map JS getDay() (0=Sun..6=Sat) onto our row index 0..6 such that
    // row 0 is the configured start-of-week. For Monday-start: Mon→0,
    // Tue→1, …, Sun→6. For Sunday-start: Sun→0, …, Sat→6.
    const rowOf = (d: Date): number => (weekStartsOn === 1 ? (d.getDay() + 6) % 7 : d.getDay())
    const dayOffset = rowOf(start)

    const lookup = new Map<string, number>()
    for (const e of entries) lookup.set(e.date, e.value)

    let max = 0
    type Cell = { date: string; value: number; dayOfWeek: number; weekIndex: number }
    const cells: Cell[] = []

    const cursor = new Date(start)
    while (cursor <= end) {
      const dateStr = formatDateStr(cursor)
      const value = lookup.get(dateStr) ?? 0
      if (value > max) max = value
      const dayOfYear = Math.floor((cursor.getTime() - start.getTime()) / (24 * 60 * 60 * 1000))
      const weekIndex = Math.floor((dayOfYear + dayOffset) / 7)
      cells.push({ date: dateStr, value, dayOfWeek: rowOf(cursor), weekIndex })
      cursor.setDate(cursor.getDate() + 1)
    }

    const wkCount = cells.length > 0 ? cells[cells.length - 1].weekIndex + 1 : 0
    const grid: Array<Array<Cell | null>> = Array.from({ length: wkCount }, () =>
      Array.from({ length: 7 }, () => null)
    )
    for (const cell of cells) {
      if (grid[cell.weekIndex]) grid[cell.weekIndex][cell.dayOfWeek] = cell
    }

    const months: Array<{ label: string; weekStart: number }> = []
    let lastMonth = -1
    for (const cell of cells) {
      const month = parseInt(cell.date.slice(5, 7), 10) - 1
      if (month !== lastMonth) {
        months.push({
          label: new Date(year, month, 1).toLocaleString(monthLocale ?? 'default', {
            month: 'short'
          }),
          weekStart: cell.weekIndex
        })
        lastMonth = month
      }
    }

    return { weeks: grid, monthLabels: months, maxValue: max, weekCount: wkCount }
  }, [entries, year, monthLocale, weekStartsOn])

  useLayoutEffect(() => {
    const el = gridRef.current
    if (!el || weekCount === 0) return
    const update = (): void => {
      const totalGap = (weekCount - 1) * CELL_GAP
      const size = (el.clientWidth - totalGap) / weekCount
      setCellSize(Math.max(1, size))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [weekCount])

  const [tooltip, setTooltip] = useState<{
    entry: ActivityHeatmapEntry
    x: number
    y: number
  } | null>(null)

  useEffect(() => {
    if (!tooltip) return
    const dismiss = (): void => setTooltip(null)
    window.addEventListener('scroll', dismiss, true)
    return () => window.removeEventListener('scroll', dismiss, true)
  }, [tooltip])

  const gridColumnsStyle: React.CSSProperties = {
    gridTemplateColumns: `repeat(${weekCount}, minmax(0, 1fr))`,
    gap: `${CELL_GAP}px`
  }

  return (
    <div className={cn('relative w-full', className)}>
      {showMonthLabels && (
        <div className="mb-1 flex" style={{ gap: `${CELL_GAP}px` }}>
          {showWeekdayLabels && <div style={{ width: `${LABEL_COLUMN_WIDTH}px`, flexShrink: 0 }} />}
          <div className="text-muted grid flex-1 text-[10px]" style={gridColumnsStyle}>
            {monthLabels.map((m, i) => {
              const nextStart = monthLabels[i + 1]?.weekStart ?? weekCount
              const span = nextStart - m.weekStart
              return (
                <span
                  key={`${m.label}-${i}`}
                  style={{ gridColumn: `${m.weekStart + 1} / span ${span}` }}
                  className="truncate"
                >
                  {m.label}
                </span>
              )
            })}
          </div>
        </div>
      )}

      <div className="flex" style={{ gap: `${CELL_GAP}px` }}>
        {showWeekdayLabels && (
          <div
            className="text-muted flex flex-col pe-1 text-[10px]"
            style={{
              width: `${LABEL_COLUMN_WIDTH - 4}px`,
              flexShrink: 0,
              gap: `${CELL_GAP}px`
            }}
          >
            {labels.map((d, i) => (
              <div
                key={i}
                className="flex items-center justify-end"
                style={{ height: `${cellSize}px`, width: '100%' }}
              >
                {d}
              </div>
            ))}
          </div>
        )}
        <div
          ref={gridRef}
          className="grid flex-1"
          style={{
            ...gridColumnsStyle,
            gridTemplateRows: `repeat(7, ${cellSize}px)`,
            gridAutoFlow: 'column'
          }}
        >
          {weeks.flatMap((week, wi) =>
            week.map((cell, di) => (
              <div
                key={`${wi}-${di}`}
                className={cn(
                  'rounded-[1px]',
                  cell ? intensityClass(cell.value, maxValue) : PADDING_CLASS
                )}
                onMouseEnter={(e) => {
                  if (!cell) return
                  const rect = e.currentTarget.getBoundingClientRect()
                  setTooltip({
                    entry: { date: cell.date, value: cell.value },
                    x: rect.left + rect.width / 2,
                    y: rect.top
                  })
                }}
                onMouseLeave={() => setTooltip(null)}
              />
            ))
          )}
        </div>
      </div>

      {tooltip && (
        <div
          className="bg-surface text-fg border-border pointer-events-none fixed z-50 rounded border px-2 py-1 text-xs shadow-lg"
          style={{
            left: tooltip.x,
            top: tooltip.y - 30,
            transform: 'translateX(-50%)'
          }}
        >
          {formatTooltip
            ? formatTooltip(tooltip.entry)
            : `${tooltip.entry.date}: ${tooltip.entry.value}`}
        </div>
      )}
    </div>
  )
}

const PADDING_CLASS = 'bg-border/30 dark:bg-border/15'

function intensityClass(value: number, max: number): string {
  if (value === 0 || max === 0) return 'bg-border/60 dark:bg-border/40'
  const ratio = value / max
  if (ratio < 0.2) return 'bg-primary/25'
  if (ratio < 0.4) return 'bg-primary/45'
  if (ratio < 0.6) return 'bg-primary/65'
  if (ratio < 0.8) return 'bg-primary/85'
  return 'bg-primary'
}

function formatDateStr(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
