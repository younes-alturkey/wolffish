import { useEffect } from 'react'
import { View, useWindowDimensions } from 'react-native'
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming
} from 'react-native-reanimated'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'

/**
 * The desktop's `.rainbow-border`: a 1.5px strip with a 6-color gradient
 * sliding across it while a turn streams — the app's "alive" indicator.
 * Implemented as a double-width SVG gradient translated in a loop.
 */

const COLORS = ['#f43f5e', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899']
const CYCLE_MS = 2500

export function RainbowBorder(): React.JSX.Element {
  const { width } = useWindowDimensions()
  const offset = useSharedValue(0)

  useEffect(() => {
    offset.value = withRepeat(withTiming(-width, { duration: CYCLE_MS, easing: Easing.linear }), -1)
  }, [offset, width])

  const style = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }))

  // Two copies of the gradient side by side; translating one full width and
  // snapping back reads as a seamless slide.
  const stops = [...COLORS, ...COLORS, COLORS[0]]
  return (
    <View style={{ height: 1.5, width, overflow: 'hidden' }}>
      <Animated.View style={[{ width: width * 2, height: 1.5 }, style]}>
        <Svg width={width * 2} height={1.5}>
          <Defs>
            <LinearGradient id="rainbow" x1="0" y1="0" x2="1" y2="0">
              {stops.map((color, index) => (
                <Stop
                  key={index}
                  offset={`${(index / (stops.length - 1)) * 100}%`}
                  stopColor={color}
                />
              ))}
            </LinearGradient>
          </Defs>
          <Rect x={0} y={0} width={width * 2} height={1.5} fill="url(#rainbow)" />
        </Svg>
      </Animated.View>
    </View>
  )
}
