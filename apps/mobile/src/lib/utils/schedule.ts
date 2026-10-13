import type { TFunction } from 'i18next'

/**
 * When the desktop's daily jobs next fire — the arithmetic behind every "next
 * run" chip. Shared because two screens ask the same question: the Knowledge
 * panel spells the answer out, and the Settings list shows it in a word.
 */

/**
 * Minutes until the next daily firing of `hour` — computed in the desktop's
 * zone when known (the schedule is that machine's), phone-local otherwise.
 * Exactly at the hour counts as tomorrow, matching the desktop's nextDailyMs.
 */
export function minutesUntilHour(hour: number, timezone: string | null, nowMs: number): number {
  let nowHour: number
  let nowMinute: number
  try {
    if (!timezone) throw new Error('no zone')
    const parts = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
      timeZone: timezone
    }).formatToParts(nowMs)
    nowHour = Number(parts.find((part) => part.type === 'hour')?.value)
    nowMinute = Number(parts.find((part) => part.type === 'minute')?.value)
    if (!Number.isFinite(nowHour) || !Number.isFinite(nowMinute)) throw new Error('bad parts')
  } catch {
    const d = new Date(nowMs)
    nowHour = d.getHours()
    nowMinute = d.getMinutes()
  }
  // Intl renders midnight as "24" under hour12:false in some engines.
  nowHour = nowHour % 24
  const remaining = (hour * 60 - (nowHour * 60 + nowMinute) + 1440) % 1440
  return remaining === 0 ? 1440 : remaining
}

/**
 * The same wait as one token — "45m", "4h", "1d" — from the localized units
 * table, exactly like formatRelativeTime's short forms. For rows where the
 * schedule is a glance, not a sentence.
 */
export function formatShortWait(minutes: number, t: TFunction): string {
  if (minutes < 60) return t('units.minutes', { value: minutes })
  if (minutes < 1440) return t('units.hours', { value: Math.floor(minutes / 60) })
  return t('units.days', { value: Math.floor(minutes / 1440) })
}
