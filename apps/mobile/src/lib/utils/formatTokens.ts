/**
 * Locale-aware compact token count: 967232 → "967.2k". One format everywhere —
 * the context meter, the compaction cards, anywhere a raw token figure would
 * otherwise be read digit by digit.
 */
export function formatTokens(value: number | undefined, locale: string): string {
  const n = value ?? 0
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
