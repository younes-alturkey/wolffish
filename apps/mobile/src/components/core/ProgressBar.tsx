import { cn } from '@/lib/utils/cn'
import { useEffect, useRef } from 'react'
import { Animated, Easing, View } from 'react-native'

export type ProgressBarProps = {
  /** 0–1. Values outside the range are clamped. */
  value: number
  /**
   * Breathe the fill while the work runs.
   *
   * For bars whose value is phase-derived rather than measured: those sit
   * perfectly still for as long as a phase lasts, and a still bar is how a
   * working app looks broken. The motion says the wait is alive without
   * claiming progress that has not happened — which an indeterminate sweep
   * would, by moving as if something were arriving.
   *
   * Deliberately React Native's own Animated rather than Reanimated, which
   * everything else animated in this app uses: this is a core primitive half
   * the screens import, and Reanimated needs its native runtime the moment it
   * is imported at all. Opacity on the native driver is the one case where the
   * built-in is exactly as good.
   */
  pulse?: boolean
  className?: string
}

/** How long one breath takes, in each direction. */
const PULSE_MS = 1100
/** How far down the fill dims. Low enough to read as motion, high enough that
 *  the bar never looks switched off. */
const PULSE_MIN = 0.45

/** Determinate progress track — the demo import, and anything measured later. */
export function ProgressBar({ value, pulse, className }: ProgressBarProps): React.JSX.Element {
  const percent = Math.max(0, Math.min(value, 1)) * 100
  const breath = useRef(new Animated.Value(1)).current

  useEffect(() => {
    if (!pulse) {
      breath.setValue(1)
      return
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, {
          toValue: PULSE_MIN,
          duration: PULSE_MS,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true
        }),
        Animated.timing(breath, {
          toValue: 1,
          duration: PULSE_MS,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true
        })
      ])
    )
    loop.start()
    return () => {
      loop.stop()
      breath.setValue(1)
    }
  }, [breath, pulse])

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(percent) }}
      className={cn('bg-border h-1 w-full overflow-hidden rounded-full', className)}
    >
      <Animated.View
        className="bg-primary h-full rounded-full"
        style={{ width: `${percent}%`, opacity: breath }}
      />
    </View>
  )
}
