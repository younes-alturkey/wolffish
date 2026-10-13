import {
  anchor,
  CENTERED,
  clampOffset,
  clampScale,
  DOUBLE_TAP_SCALE,
  MAX_SCALE,
  MIN_SCALE,
  PINCH_FLOOR,
  slack,
  type Offset,
  type Size
} from '@/lib/utils/zoomPan'
import { Image, type ImageLoadEventData } from 'expo-image'
import { View, type LayoutChangeEvent } from 'react-native'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDecay,
  withTiming
} from 'react-native-reanimated'

/**
 * The zooming stage inside the expanded image viewer — the phone's reading of
 * the desktop's useZoomPan lightbox, holding to the same contract: 1× at rest,
 * 8× at most, and a double tap that jumps to 2.5× anchored on the point tapped
 * (or back to fit, if already in). Scroll-to-zoom and drag-to-pan become a
 * pinch and a one-finger drag.
 *
 * Every frame runs on the UI thread: the gestures write shared values, a
 * transform reads them, and no React state changes while a finger is down. So
 * the picture tracks the fingers rather than the JS queue — which is the whole
 * difference between a zoom that feels like the system photo viewer and one
 * that feels like a widget being animated at you.
 */

/** Settling back inside the bounds after a gesture — short enough to feel elastic. */
const SETTLE = { duration: 180 }

export function ZoomableImage({
  uri,
  label
}: {
  uri: string
  /** Accessible name for the picture — normally the file name. */
  label: string
}): React.JSX.Element {
  const scale = useSharedValue(MIN_SCALE)
  const offsetX = useSharedValue(0)
  const offsetY = useSharedValue(0)

  // The stage's box and the image's own pixel size: together they give the
  // rectangle the picture is painted in, and that rectangle — not the stage —
  // is what panning is bounded by, so a wide photo can never be dragged until
  // only its letterbox is left on screen. The desktop bounds against its frame
  // for the same reason: there the frame already IS the picture, being sized
  // to the image's aspect.
  const stage = useSharedValue<Size>({ width: 0, height: 0 })
  const pixels = useSharedValue<Size>({ width: 0, height: 0 })

  // Pinch bookkeeping: the previous frame's focal point and raw gesture scale,
  // so every update is an increment on top of the last rather than a fresh
  // solve against where the gesture began.
  const lastPinch = useSharedValue(1)
  const focal = useSharedValue<Offset>(CENTERED)
  // The pan's baseline, read once at touch-down: a pinch interrupting a drag
  // must not leave the next drag rebasing off an offset that has since moved.
  const panFrom = useSharedValue<Offset>(CENTERED)

  /** Gesture coordinates are stage-relative; the transform is centre-relative. */
  const fromCenter = (px: number, py: number): Offset => {
    'worklet'
    return { x: px - stage.value.width / 2, y: py - stage.value.height / 2 }
  }

  const apply = (next: Offset): void => {
    'worklet'
    offsetX.value = next.x
    offsetY.value = next.y
  }

  /** Give back whatever the gesture borrowed: over-pinch, and drift past the bounds. */
  const settle = (): void => {
    'worklet'
    const next = clampScale(scale.value, MIN_SCALE)
    // Bounds for where the scale is GOING, not where it is — shrinking back to
    // the fit leaves no slack at all, which is what re-centres an over-pinch.
    const settled = clampOffset(
      { x: offsetX.value, y: offsetY.value },
      slack(stage.value, pixels.value, next)
    )
    if (next !== scale.value) scale.value = withTiming(next, SETTLE)
    if (settled.x !== offsetX.value) offsetX.value = withTiming(settled.x, SETTLE)
    if (settled.y !== offsetY.value) offsetY.value = withTiming(settled.y, SETTLE)
  }

  const pinch = Gesture.Pinch()
    .onStart((event) => {
      'worklet'
      lastPinch.value = event.scale
      focal.value = fromCenter(event.focalX, event.focalY)
    })
    .onUpdate((event) => {
      'worklet'
      const to = fromCenter(event.focalX, event.focalY)
      const next = clampScale(scale.value * (event.scale / lastPinch.value), PINCH_FLOOR)
      apply(anchor({ x: offsetX.value, y: offsetY.value }, focal.value, to, next / scale.value))
      scale.value = next
      lastPinch.value = event.scale
      focal.value = to
    })
    .onEnd(() => {
      'worklet'
      settle()
    })

  const pan = Gesture.Pan()
    // Two fingers on the glass is a pinch, and its focal already carries the
    // drag — letting the pan move the picture as well would double it.
    .maxPointers(1)
    .onStart(() => {
      'worklet'
      panFrom.value = { x: offsetX.value, y: offsetY.value }
    })
    .onUpdate((event) => {
      'worklet'
      apply(
        clampOffset(
          { x: panFrom.value.x + event.translationX, y: panFrom.value.y + event.translationY },
          slack(stage.value, pixels.value, scale.value)
        )
      )
    })
    .onEnd((event) => {
      'worklet'
      // Flick momentum, stopped dead at the same edges the drag was held to.
      const room = slack(stage.value, pixels.value, scale.value)
      if (room.x > 0) {
        offsetX.value = withDecay({ velocity: event.velocityX, clamp: [-room.x, room.x] })
      }
      if (room.y > 0) {
        offsetY.value = withDecay({ velocity: event.velocityY, clamp: [-room.y, room.y] })
      }
    })

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((event, success) => {
      'worklet'
      if (!success) return
      if (scale.value > MIN_SCALE) {
        scale.value = withTiming(MIN_SCALE, SETTLE)
        offsetX.value = withTiming(0, SETTLE)
        offsetY.value = withTiming(0, SETTLE)
        return
      }
      // Zooming in lands on the tapped point, by the same solve the pinch uses.
      const at = fromCenter(event.x, event.y)
      const target = clampOffset(
        anchor({ x: offsetX.value, y: offsetY.value }, at, at, DOUBLE_TAP_SCALE / scale.value),
        slack(stage.value, pixels.value, DOUBLE_TAP_SCALE)
      )
      scale.value = withTiming(DOUBLE_TAP_SCALE, SETTLE)
      offsetX.value = withTiming(target.x, SETTLE)
      offsetY.value = withTiming(target.y, SETTLE)
    })

  // Race, not Exclusive: a drag that has already begun cancels the tap
  // outright, so panning never waits out a double-tap window before it moves.
  const gesture = Gesture.Race(doubleTap, Gesture.Simultaneous(pinch, pan))

  const transform = useAnimatedStyle(() => ({
    transform: [
      { translateX: offsetX.value },
      { translateY: offsetY.value },
      { scale: scale.value }
    ]
  }))

  return (
    // Gestures inside a react-native Modal are cut off from the app's root
    // handler tree on Android, so the sheet's stage carries its own root.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <GestureDetector gesture={gesture}>
        <View
          style={{ flex: 1, overflow: 'hidden', backgroundColor: 'black' }}
          onLayout={(event: LayoutChangeEvent) => {
            const { width, height } = event.nativeEvent.layout
            stage.value = { width, height }
          }}
        >
          <Animated.View style={[{ flex: 1 }, transform]}>
            {/* contain + full bleed: the whole image at the largest size that
                fits, which is also the 1× everything else is measured from. */}
            <Image
              source={{ uri }}
              contentFit="contain"
              style={{ width: '100%', height: '100%' }}
              accessibilityLabel={label}
              onLoad={(event: ImageLoadEventData) => {
                pixels.value = { width: event.source.width, height: event.source.height }
              }}
            />
          </Animated.View>
        </View>
      </GestureDetector>
    </GestureHandlerRootView>
  )
}
