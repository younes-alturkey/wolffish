export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 60) return `${Math.ceil(seconds)}s`
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    const s = Math.round(seconds % 60)
    return s === 0 ? `${m}m` : `${m}m ${s}s`
  }
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

type TFn = (key: string, vars?: Record<string, unknown>) => string

/**
 * Localized duration formatter. Uses the `units.*` i18n keys so the trailing
 * unit word (e.g. "ثانية" in Arabic, "s" in English) reads natively. The
 * numeric portion is bidi-isolated so digits stay together inside RTL flow.
 */
export function formatDurationL(seconds: number | null | undefined, t: TFn): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 60) return t('units.seconds', { value: ltrIsolate(Math.ceil(seconds)) })
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    const s = Math.round(seconds % 60)
    if (s === 0) return t('units.minutes', { value: ltrIsolate(m) })
    return `${t('units.minutes', { value: ltrIsolate(m) })} ${t('units.seconds', { value: ltrIsolate(s) })}`
  }
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  if (m === 0) return t('units.hours', { value: ltrIsolate(h) })
  return `${t('units.hours', { value: ltrIsolate(h) })} ${t('units.minutes', { value: ltrIsolate(m) })}`
}

const BYTE_UNIT_KEYS = [
  'units.bytes',
  'units.kilobytes',
  'units.megabytes',
  'units.gigabytes',
  'units.terabytes'
]

/**
 * Localized byte-size formatter. Uses the `units.*` i18n keys so the unit word
 * reads natively (e.g. "ميجا بايت" in Arabic, "MB" in English). The numeric
 * portion is bidi-isolated so the digits stay together inside RTL flow.
 */
export function formatBytesL(bytes: number | null | undefined, t: TFn, digits = 1): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNIT_KEYS.length - 1) {
    value /= 1024
    unit++
  }
  const precision = unit === 0 ? 0 : digits
  return t(BYTE_UNIT_KEYS[unit], { value: ltrIsolate(value.toFixed(precision)) })
}

/**
 * Localized whole-gigabyte formatter, for hardware specs where a fractional
 * figure reads as false precision ("16 GB", not "16.0 GB").
 *
 * Below 1 GB, rounding to whole gigabytes collapses to a meaningless "0 GB"
 * (the catalog's smallest model wants 246 MB), so sub-GB figures step down to
 * their natural unit instead — a whole number either way, never "0.2 GB".
 */
export function formatGBL(bytes: number | null | undefined, t: TFn): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024 ** 3) return formatBytesL(bytes, t, 0)
  return t('units.gigabytes', { value: ltrIsolate(Math.round(bytes / 1024 ** 3)) })
}

/**
 * Compact count: 967232 → "967.2k". The single k/m/b formatter for every
 * numeric chip in the UI — token counts, message counts, query counts.
 *
 * `locale` is optional because several call sites are module-level render
 * helpers with no hook scope; omitting it falls back to the runtime locale.
 * Pass it wherever the app locale is already in hand so Arabic renders its
 * own digits. Scaling happens before formatting, so the scaled value is
 * always under 1000 and no group separator ever appears.
 */
export function formatCompact(n: number, locale?: string): string {
  const fmt = (v: number): string => {
    try {
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(v)
    } catch {
      return String(Math.round(v * 10) / 10)
    }
  }
  if (n >= 1_000_000_000) return `${fmt(n / 1_000_000_000)}b`
  if (n >= 1_000_000) return `${fmt(n / 1_000_000)}m`
  if (n >= 1_000) return `${fmt(n / 1_000)}k`
  return fmt(n)
}

/**
 * Wrap a value with Unicode First Strong Isolate (FSI) + Pop Directional
 * Isolate (PDI) so the bidi algorithm renders it as a directional unit
 * regardless of the surrounding text direction. Use this for numbers and
 * sizes embedded inside RTL strings — keeps "25 GB" reading correctly
 * inside an Arabic sentence without forcing the sentence to LTR.
 */
export function ltrIsolate(value: string | number): string {
  return `\u2068${value}\u2069`
}
