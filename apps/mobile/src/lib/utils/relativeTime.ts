import type { TFunction } from 'i18next'

/**
 * Compact relative time ("5m", "3h", "2d") from the localized units strings.
 * Hermes ships without Intl.RelativeTimeFormat (unlike the desktop's
 * Electron), so this is string-table based — and the short form suits the
 * mobile rows better anyway.
 */
export function formatRelativeTime(timestamp: number, t: TFunction): string {
  const deltaMs = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(deltaMs / 60_000)
  if (minutes < 1) return t('units.now')
  if (minutes < 60) return t('units.minutes', { value: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('units.hours', { value: hours })
  const days = Math.floor(hours / 24)
  if (days < 30) return t('units.days', { value: days })
  const months = Math.floor(days / 30)
  if (months < 12) return t('units.months', { value: months })
  return t('units.years', { value: Math.floor(months / 12) })
}

/**
 * The same compact token as above, but SIGNED: "in 3h" for a moment ahead,
 * "3h ago" for one behind. The workspace cards need both — an automation's next
 * fire is in the future, its last edit in the past — and one function keeps the
 * two reading alike on the same line.
 *
 * Built from the units table rather than Intl.RelativeTimeFormat so the Arabic
 * wording comes from the same strings every other duration in the app uses.
 */
export function formatSignedRelative(targetMs: number, nowMs: number, t: TFunction): string {
  const deltaMs = targetMs - nowMs
  const ahead = deltaMs > 0
  const minutes = Math.floor(Math.abs(deltaMs) / 60_000)
  const token = ((): string => {
    if (minutes < 1) return t('units.now')
    if (minutes < 60) return t('units.minutes', { value: minutes })
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return t('units.hours', { value: hours })
    const days = Math.floor(hours / 24)
    if (days < 30) return t('units.days', { value: days })
    const months = Math.floor(days / 30)
    if (months < 12) return t('units.months', { value: months })
    return t('units.years', { value: Math.floor(months / 12) })
  })()
  // "now" is already a complete phrase in both directions.
  if (minutes < 1) return token
  return t(ahead ? 'relative.inShort' : 'relative.agoShort', { value: token })
}

/**
 * The absolute moment beside the relative one — the desktop's formatAbsolute:
 * weekday, month, day, and a 2-digit time. Both cards print the pair, because
 * "in 3h" alone does not tell you whether that is tonight or tomorrow morning.
 *
 * Hermes ships Intl, but not on every build in this project's history, so the
 * fallback is the same ISO slice the other screens use rather than a throw.
 */
export function formatAbsoluteMoment(ms: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(ms)
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
  }
}

/**
 * Day-granularity "fromNow" for a local-naive `YYYY-MM-DD` date (the usage
 * ledger's format): today/yesterday/tomorrow, then day, month and year
 * phrases in either direction. String-table based like the above — and the
 * one/two counts get dedicated keys because Arabic needs the dual form.
 */
export function formatDayFromNow(date: string, now: Date, t: TFunction): string {
  const day = new Date(`${date}T00:00:00`)
  if (Number.isNaN(day.getTime())) return ''
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  // Rounding absorbs the 23h/25h midnight-to-midnight gaps DST creates.
  const diff = Math.round((day.getTime() - todayMidnight.getTime()) / 86_400_000)
  if (diff === 0) return t('relative.today')
  if (diff === -1) return t('relative.yesterday')
  if (diff === 1) return t('relative.tomorrow')

  const past = diff < 0
  const days = Math.abs(diff)
  if (days < 30) {
    if (days === 2) return t(past ? 'relative.twoDaysAgo' : 'relative.inTwoDays')
    return t(past ? 'relative.daysAgo' : 'relative.inDays', { count: days })
  }
  const months = Math.round(days / 30.44)
  if (months < 12) {
    if (months === 1) return t(past ? 'relative.oneMonthAgo' : 'relative.inOneMonth')
    if (months === 2) return t(past ? 'relative.twoMonthsAgo' : 'relative.inTwoMonths')
    return t(past ? 'relative.monthsAgo' : 'relative.inMonths', { count: months })
  }
  const years = Math.round(days / 365.25)
  if (years === 1) return t(past ? 'relative.oneYearAgo' : 'relative.inOneYear')
  if (years === 2) return t(past ? 'relative.twoYearsAgo' : 'relative.inTwoYears')
  return t(past ? 'relative.yearsAgo' : 'relative.inYears', { count: years })
}
