import type { ProcessState } from '@preload/index'

const FROM_NOW_RANGES: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000]
]

export function formatRelative(targetMs: number, nowMs: number, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  // A stamp written after this tick's `now` is "just now", never "in N seconds".
  const diff = Math.min(0, targetMs - nowMs)
  for (const [unit, ms] of FROM_NOW_RANGES) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit)
  }
  return rtf.format(Math.round(diff / 1000), 'second')
}

export function isLiveState(state: ProcessState): boolean {
  return state === 'starting' || state === 'running' || state === 'stopping'
}

const DURATION_RANGES: ReadonlyArray<readonly [Intl.NumberFormatOptions['unit'], number]> = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1000]
]

/** A localized elapsed duration ("12 sec", "3 min", "2 hr"), for uptime. */
export function formatDuration(ms: number, locale: string): string {
  const abs = Math.max(0, ms)
  for (const [unit, size] of DURATION_RANGES) {
    if (abs >= size || unit === 'second') {
      return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short' }).format(
        Math.round(abs / size)
      )
    }
  }
  return ''
}
