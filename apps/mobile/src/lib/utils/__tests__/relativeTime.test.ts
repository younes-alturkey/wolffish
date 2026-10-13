import { formatDayFromNow, formatRelativeTime } from '@/lib/utils/relativeTime'
import type { TFunction } from 'i18next'

// Fake t that renders like the en units table.
const t = ((key: string, options?: { value?: number }) => {
  const table: Record<string, string> = {
    'units.now': 'now',
    'units.minutes': `${options?.value}m`,
    'units.hours': `${options?.value}h`,
    'units.days': `${options?.value}d`,
    'units.months': `${options?.value}mo`,
    'units.years': `${options?.value}y`
  }
  return table[key] ?? key
}) as TFunction

describe('formatRelativeTime', () => {
  const NOW = Date.now()

  it('renders "now" under a minute', () => {
    expect(formatRelativeTime(NOW - 10_000, t)).toBe('now')
  })

  it('renders minutes, hours, days, months, years', () => {
    expect(formatRelativeTime(NOW - 5 * 60_000, t)).toBe('5m')
    expect(formatRelativeTime(NOW - 3 * 3_600_000, t)).toBe('3h')
    expect(formatRelativeTime(NOW - 2 * 86_400_000, t)).toBe('2d')
    expect(formatRelativeTime(NOW - 65 * 86_400_000, t)).toBe('2mo')
    expect(formatRelativeTime(NOW - 400 * 86_400_000, t)).toBe('1y')
  })

  it('clamps future timestamps to "now"', () => {
    expect(formatRelativeTime(NOW + 60_000, t)).toBe('now')
  })
})

// Fake t that renders like the en relative table.
const tDay = ((key: string, options?: { count?: number }) => {
  const table: Record<string, string> = {
    'relative.today': 'Today',
    'relative.yesterday': 'Yesterday',
    'relative.tomorrow': 'Tomorrow',
    'relative.twoDaysAgo': '2 days ago',
    'relative.daysAgo': `${options?.count} days ago`,
    'relative.inTwoDays': 'in 2 days',
    'relative.inDays': `in ${options?.count} days`,
    'relative.oneMonthAgo': 'a month ago',
    'relative.twoMonthsAgo': '2 months ago',
    'relative.monthsAgo': `${options?.count} months ago`,
    'relative.inOneMonth': 'in a month',
    'relative.inTwoMonths': 'in 2 months',
    'relative.inMonths': `in ${options?.count} months`,
    'relative.oneYearAgo': 'a year ago',
    'relative.twoYearsAgo': '2 years ago',
    'relative.yearsAgo': `${options?.count} years ago`,
    'relative.inOneYear': 'in a year',
    'relative.inTwoYears': 'in 2 years',
    'relative.inYears': `in ${options?.count} years`
  }
  return table[key] ?? key
}) as TFunction

describe('formatDayFromNow', () => {
  const NOW = new Date(2026, 6, 31, 13, 45) // local Jul 31 2026, mid-afternoon

  /** `NOW`'s calendar day shifted by `days`, as the ledger's `YYYY-MM-DD`. */
  const day = (days: number): string => {
    const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + days)
    const m = String(d.getMonth() + 1).padStart(2, '0')
    return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, '0')}`
  }

  it('names the adjacent days', () => {
    expect(formatDayFromNow(day(0), NOW, tDay)).toBe('Today')
    expect(formatDayFromNow(day(-1), NOW, tDay)).toBe('Yesterday')
    expect(formatDayFromNow(day(1), NOW, tDay)).toBe('Tomorrow')
  })

  it('counts days below a month, with the dual split out', () => {
    expect(formatDayFromNow(day(-2), NOW, tDay)).toBe('2 days ago')
    expect(formatDayFromNow(day(-13), NOW, tDay)).toBe('13 days ago')
    expect(formatDayFromNow(day(-29), NOW, tDay)).toBe('29 days ago')
    expect(formatDayFromNow(day(2), NOW, tDay)).toBe('in 2 days')
    expect(formatDayFromNow(day(5), NOW, tDay)).toBe('in 5 days')
  })

  it('rolls into months at 30 days', () => {
    expect(formatDayFromNow(day(-30), NOW, tDay)).toBe('a month ago')
    expect(formatDayFromNow(day(-61), NOW, tDay)).toBe('2 months ago')
    expect(formatDayFromNow(day(-100), NOW, tDay)).toBe('3 months ago')
    expect(formatDayFromNow(day(45), NOW, tDay)).toBe('in a month')
  })

  it('rolls into years around 12 months', () => {
    expect(formatDayFromNow(day(-400), NOW, tDay)).toBe('a year ago')
    expect(formatDayFromNow(day(-750), NOW, tDay)).toBe('2 years ago')
    expect(formatDayFromNow(day(-1200), NOW, tDay)).toBe('3 years ago')
  })

  it('returns empty for an unparseable date', () => {
    expect(formatDayFromNow('not-a-date', NOW, tDay)).toBe('')
  })
})
