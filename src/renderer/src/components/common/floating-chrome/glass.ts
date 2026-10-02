import { cn } from '@lib/utils/cn'

/**
 * The floating glass disc — the desktop twin of the mobile app's FloatingChrome
 * buttons: a 40px circle whose "background" is the blurred content underneath
 * plus a faint bg-tinted wash, ringed by the standard border hairline (border,
 * not a softer tone — on glass a darker hairline reads as a black ring in dark
 * mode). No shadow, no color/opacity transitions (banned for perf); hover
 * deepens the wash and active dims instantly.
 */
export const glassButtonClass = cn(
  'pointer-events-auto flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full',
  'border-border bg-bg/40 text-fg border backdrop-blur-md',
  'hover:bg-bg/60 active:opacity-60',
  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
)
