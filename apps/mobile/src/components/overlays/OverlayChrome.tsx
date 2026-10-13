import { Database02Icon, type IconProps } from '@/components/core/icons'
import { cn } from '@/lib/utils/cn'
import { useEffect } from 'react'
import { View } from 'react-native'
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming
} from 'react-native-reanimated'

/**
 * The pieces the reindex card and its opened sheet both need: what it looks
 * like, the elapsed clock, and the pinged dot.
 *
 * Its own module because the card renders the sheet and the sheet renders the
 * card's chrome — sharing through either one would be a cycle.
 */

// ------------------------------------------------------------------- tone

/**
 * What the reindex card looks like.
 *
 * The colors are literal palette values, not tokens: RN cannot alpha-compose a
 * `var()` color, so `bg-primary/15` would silently render black (see
 * global.css) while `bg-indigo-500/15` is fine.
 */
export type OverlayTone = {
  icon: (props: IconProps) => React.JSX.Element
  /** The disc behind the icon. */
  disc: string
  /** The halo that pulses out from it. */
  halo: string
  /** The icon itself, and any label drawn in the accent. */
  tint: string
  /** The progress bar's fill — the one place a solid version is needed. */
  fill: string
}

export const REINDEX_TONE: OverlayTone = {
  icon: Database02Icon,
  disc: 'bg-indigo-500/15',
  halo: 'bg-indigo-500/20',
  tint: 'text-indigo-600 dark:text-indigo-400',
  fill: 'bg-indigo-500'
}

// ------------------------------------------------------------------- text

/** mm:ss, growing an hours field only once there is one. */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const seconds = String(total % 60).padStart(2, '0')
  const minutes = Math.floor(total / 60)
  if (total < 3600) return `${minutes}:${seconds}`
  return `${Math.floor(total / 3600)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`
}

// ------------------------------------------------------------------- icon

/** How long one halo takes to expand and fade — the desktop's `animate-ping`. */
const PULSE_MS = 1600

/**
 * The desktop's pinged dot: a disc with a halo expanding out of it, forever.
 * The one thing on the card that says the rebuild is still going, since
 * nothing else about it moves between progress ticks.
 */
export function PulsingIcon({
  tone,
  halo,
  size = 24,
  children
}: {
  tone: string
  halo: string
  size?: number
  children: React.ReactNode
}): React.JSX.Element {
  const progress = useSharedValue(0)

  useEffect(() => {
    progress.value = withRepeat(
      withTiming(1, { duration: PULSE_MS, easing: Easing.out(Easing.ease) }),
      -1,
      false
    )
  }, [progress])

  const haloStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + progress.value * 0.8 }],
    opacity: 1 - progress.value
  }))

  return (
    <View style={{ width: size, height: size }} className="shrink-0 items-center justify-center">
      <Animated.View
        pointerEvents="none"
        style={[{ position: 'absolute', width: size, height: size }, haloStyle]}
        className={cn('rounded-full', halo)}
      />
      <View
        style={{ width: size, height: size }}
        className={cn('items-center justify-center rounded-full', tone)}
      >
        {children}
      </View>
    </View>
  )
}
