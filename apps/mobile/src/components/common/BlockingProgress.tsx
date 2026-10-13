import { Button } from '@/components/core/Button'
import { ProgressBar } from '@/components/core/ProgressBar'
import { elapsed } from '@/components/overlays/OverlayChrome'
import { useTheme } from '@/providers/theme/useTheme'
import { BlurView } from 'expo-blur'
import { useEffect, useState, type ReactNode } from 'react'
import {
  BackHandler,
  Modal as RNModal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View
} from 'react-native'
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming
} from 'react-native-reanimated'
import { FullWindowOverlay } from 'react-native-screens'

/**
 * The shape both waits wear: reconnecting, and syncing.
 *
 * Shared so the two read as the same event to the user — the app is busy
 * with the desktop, here is how far along it is — rather than two different
 * dialogs that happen to overlap in purpose. What differs between them is
 * only the words, the progress and whether there is a way out.
 *
 * Deliberately NOT a presented Modal on iOS, though it looks exactly like one.
 *
 * A React Native Modal is a presented view controller there, and a second one
 * cannot present while the first is up. Both of these mount at the root of the
 * app, so any sheet the user happens to have open — the conversations list, the
 * attachment picker, a settings dialog — silently swallowed them: the tunnel
 * would drop with a sheet open and nothing whatsoever appeared, on the one
 * occasion the app most needed to say something. Rendered as an ordinary
 * absolute layer it always paints, and it can never lose a presentation race it
 * has no way of retrying.
 *
 * That left the other half of the same problem: it painted, but UNDER those
 * sheets, because each of them is a window of its own and an absolute layer is
 * only ever above its own siblings — the card the app most needs to show was
 * behind the sidebar, and behind every dialog a settings page opens. So the
 * whole thing goes into the window's own top layer now (see TopLayer): above
 * every screen AND every sheet, on both platforms, while still presenting
 * nothing on iOS that could lose that race.
 */
export function BlockingProgress({
  icon,
  title,
  body,
  ratio,
  detail,
  note,
  since,
  escape
}: {
  icon: ReactNode
  title: string
  body: string
  /** 0–1. Phase-derived rather than measured — see each caller. */
  ratio: number
  detail?: string
  note?: string
  /**
   * When this wait began, for the clock beside the detail line. Not when the
   * card appeared: both callers hold it back for a moment first, and a counter
   * that started at zero half a second late would be quietly wrong about the
   * only number on screen anyone can check.
   */
  since?: number | null
  /** Present once waiting has gone on long enough to deserve a way out. */
  escape?: { label: string; hint?: string; onPress: () => void }
}): React.JSX.Element {
  const { isDark } = useTheme()

  // Nothing about a stalled reconnect changes on screen — same words, same
  // bar, for as long as it takes. Android's back button was the Modal's job
  // and is this layer's now: without it the block is a picture, and the user
  // navigates away underneath a card that says they cannot.
  useEffect(() => {
    if (Platform.OS !== 'android') return
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true)
    return () => subscription.remove()
  }, [])

  return (
    <TopLayer>
      <View
        // Rendered above every screen and every floating card, and taking every
        // touch on the way: what is underneath cannot be acted on until this is
        // over, which is the whole claim the card is making.
        style={[StyleSheet.absoluteFill, { zIndex: 100 }]}
        className="items-center justify-center p-4"
        accessibilityViewIsModal
      >
        <BlurView
          pointerEvents="none"
          intensity={20}
          tint={isDark ? 'dark' : 'light'}
          blurMethod="dimezisBlurView"
          style={StyleSheet.absoluteFill}
        />
        <View pointerEvents="none" className="absolute inset-0 bg-black/40" />
        {/* Swallows taps aimed at the screen behind. Not a dismiss — there is
          nothing back there worth reaching mid-wait. */}
        <Pressable
          accessibilityRole="none"
          style={StyleSheet.absoluteFill}
          onPress={() => undefined}
        />
        <View className="bg-surface border-border w-full max-w-md flex-col items-center gap-4 rounded-2xl border p-6 shadow-lg">
          <PulseDisc>{icon}</PulseDisc>
          <Text className="text-fg text-center font-sans-semibold text-base">{title}</Text>
          <Text className="text-muted text-center font-sans text-sm leading-relaxed">{body}</Text>
          <ProgressBar value={ratio} pulse className="w-full" />
          {detail || since ? (
            <View className="flex-row flex-wrap items-center justify-center gap-x-2">
              {detail ? (
                <Text className="text-muted text-center font-sans text-xs leading-relaxed">
                  {detail}
                </Text>
              ) : null}
              {/* Pinned LTR: mm:ss counts up left to right in every locale —
                the same treatment the reindex overlay gives its clock. */}
              {since ? <Clock since={since} /> : null}
            </View>
          ) : null}
          {note ? <Text className="text-muted text-center font-sans text-xs">{note}</Text> : null}
          {escape ? (
            <View className="w-full gap-2 pt-1">
              <Button variant="outline" style={{ alignSelf: 'stretch' }} onPress={escape.onPress}>
                {escape.label}
              </Button>
              {escape.hint ? (
                <Text className="text-muted text-center font-sans text-xs leading-relaxed">
                  {escape.hint}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
    </TopLayer>
  )
}

/**
 * The layer the card is mounted into: the top of the app's own window, above
 * every screen and above every sheet presented over them.
 *
 * Neither platform lets a view in the app's view tree paint over a sheet, and
 * for the same underlying reason: a React Native Modal is a window of its own —
 * a presented view controller on iOS, a Dialog on Android — so the sidebar, the
 * attachment picker and every settings dialog sit in a layer this card cannot
 * reach from where the screens live. Each platform's way up is different, and
 * neither of them is "present a Modal of our own", which is the one thing that
 * is NOT safe here: on iOS a second presentation while a sheet is up does not
 * happen at all, and that silence is the bug this card was rewritten to end.
 *
 * - iOS: the overlay's content is added as the last subview of the key window,
 *   beside the presented sheet's own transition view rather than beneath it.
 *   Added on mount, which is after any sheet already open was presented, so it
 *   lands on top — and it is removed again the moment the card unmounts, so
 *   there is never an invisible window layer left eating touches.
 * - Android: a Modal, which is exactly right here — dialogs stack in the order
 *   they are shown, so the one raised last is the one on top. The rule that
 *   forbids this on iOS is an iOS rule; there is no presentation to lose.
 *
 * The card inside is unchanged: same absolute fill, same backdrop, same touch
 * swallowing. Only which layer it fills is different.
 */
function TopLayer({ children }: { children: ReactNode }): React.JSX.Element {
  if (Platform.OS === 'ios') return <FullWindowOverlay>{children}</FullWindowOverlay>
  // Back is already blocked by the handler above; this is the Dialog's own
  // copy of that answer, and it has to be given or Android has no callback to
  // call. Neither one dismisses: the block is the point.
  return (
    <RNModal visible transparent animationType="none" onRequestClose={() => undefined}>
      {children}
    </RNModal>
  )
}

/** How long one halo takes to expand and fade — the desktop's `animate-ping`. */
const PULSE_MS = 1600

/** The disc behind the icon, with a halo pushing out of it forever.
 *
 *  A wait with no motion in it reads as a wait that has failed. The bar cannot
 *  carry that on its own: both of these bars are phase-derived, so one can sit
 *  at the same width for the entire reconnect while everything underneath is
 *  working exactly as it should. This is what says so. */
function PulseDisc({ children }: { children: ReactNode }): React.JSX.Element {
  const progress = useSharedValue(0)

  useEffect(() => {
    progress.value = withRepeat(
      withTiming(1, { duration: PULSE_MS, easing: Easing.out(Easing.ease) }),
      -1,
      false
    )
  }, [progress])

  const halo = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + progress.value * 0.8 }],
    opacity: 1 - progress.value
  }))

  return (
    <View className="h-12 w-12 items-center justify-center">
      {/* Sized by the same class as the disc rather than a number beside it:
          `h-12` is 42pt at this app's rem, not 48, and a halo written in raw
          points sat three points proud of the thing it is supposed to be
          pushing out of. One source, no drift. */}
      <Animated.View
        pointerEvents="none"
        style={halo}
        className="bg-primary-soft absolute h-12 w-12 rounded-full"
      />
      <View className="bg-primary-soft h-12 w-12 items-center justify-center rounded-2xl">
        {children}
      </View>
    </View>
  )
}

/** The elapsed clock only ticks while there is a card to show it on. */
const TICK_MS = 1000

/**
 * How long this wait has been going, mm:ss.
 *
 * The one honest number available. Neither bar is measuring anything — they
 * report which phase is running — so this is what tells someone whether they
 * are three seconds into a blip or ninety into an outage, which is the only
 * fact that changes what they should do about it.
 *
 * Keyed on `since` rather than on the parent's every render: the connecting
 * card re-renders on each tunnel counter tick, and an interval torn down and
 * rebuilt that often would never reach its first fire — the desktop's run
 * overlay froze at 0:00 in exactly this way.
 */
function Clock({ since }: { since: number }): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [since])

  return (
    <Text className="text-muted font-sans text-xs" style={{ writingDirection: 'ltr' }}>
      {elapsed(now - since)}
    </Text>
  )
}
