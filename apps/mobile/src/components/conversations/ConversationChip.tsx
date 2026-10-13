import type { ConversationRow } from '@/lib/conversations/rows'
import { useEffect, useRef } from 'react'
import { Animated } from 'react-native'

/**
 * Shared numbered status-chip styling for conversations — the desktop's
 * lib/conversation-chip.ts, and shared for its reason: the conversations sheet
 * and the History screen both draw this chip, and one running turn must pulse
 * the same way in both places.
 */

/**
 * The number chip's tint, per phase — the desktop's conversationChipClasses.
 *
 * The primary tones are the precomputed ones rather than `primary/15`: the
 * semantic colors are CSS variables, and NativeWind drops the `/alpha` modifier
 * on a var() color (see global.css), which renders the chip invisible. The
 * emerald/red/amber tones are real palette colors, so they keep the desktop's
 * own alphas and its light/dark text pair.
 */
export function chipTone(phase: ConversationRow['phase'], active: boolean): string {
  if (active || phase === 'processing') {
    return 'border-primary-line bg-primary-soft'
  }
  switch (phase) {
    case 'completed':
      return 'border-emerald-500/40 bg-emerald-500/10'
    case 'failed':
      return 'border-red-500/40 bg-red-500/10'
    case 'stopped':
      return 'border-amber-500/40 bg-amber-500/10'
    default:
      return 'border-border'
  }
}

export function chipText(phase: ConversationRow['phase'], active: boolean): string {
  if (active || phase === 'processing') return 'text-primary'
  switch (phase) {
    case 'completed':
      return 'text-emerald-600 dark:text-emerald-400'
    case 'failed':
      return 'text-red-600 dark:text-red-400'
    case 'stopped':
      return 'text-amber-600 dark:text-amber-400'
    default:
      return 'text-muted'
  }
}

/**
 * The desktop's `animate-pulse` on the one element that needs it. RN's own
 * Animated rather than reanimated: this runs inside a Modal on the JS side of
 * an already-native-driven slide, and it keeps the component renderable in
 * tests without a worklets runtime.
 */
export function Pulse({
  active,
  children
}: {
  active: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const opacity = useRef(new Animated.Value(1)).current
  useEffect(() => {
    if (!active) {
      opacity.setValue(1)
      return
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.45, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true })
      ])
    )
    loop.start()
    return () => {
      loop.stop()
      opacity.setValue(1)
    }
  }, [active, opacity])
  return <Animated.View style={{ opacity }}>{children}</Animated.View>
}
