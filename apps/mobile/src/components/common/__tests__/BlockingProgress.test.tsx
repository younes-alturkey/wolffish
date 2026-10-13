/**
 * The card both waits wear.
 *
 * Three of the four things asserted here are about bugs that produced NO
 * visible card at all, which is why they are pinned rather than eyeballed:
 *
 * - It is not a presented Modal, and it is in the window's top layer. On iOS a
 *   Modal is a presented view controller and a second one cannot present while
 *   the first is up, so with any sheet open — the conversations list, an
 *   attachment picker, a settings dialog — the reconnect card silently failed
 *   to appear, on precisely the occasion the app most needed to speak. As an
 *   ordinary layer it always painted but painted UNDER those sheets, which are
 *   windows of their own; mounted into the window overlay it paints over them.
 * - It swallows what is underneath. That is the entire claim a blocking card
 *   makes, and as a plain View it is a claim that has to be built rather than
 *   inherited from the Modal it used to be.
 *
 * The last is the clock, which is the only honest number on the card: both
 * bars are phase-derived, so this is what separates a three-second blip from a
 * ninety-second outage.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

import { BlockingProgress } from '@/components/common/BlockingProgress'
import { ThemeContext } from '@/providers/theme/useTheme'
import { cleanup, render, screen } from '@testing-library/react-native'
import { Text } from 'react-native'

jest.mock('expo-blur', () => ({ BlurView: require('react-native').View }))

// Reanimated's halo needs the native runtime and says nothing about the card.
jest.mock('react-native-reanimated', () => {
  const { View: RNView } = jest.requireActual('react-native')
  return {
    __esModule: true,
    default: { View: RNView },
    Easing: { out: (fn: unknown) => fn, ease: 0 },
    useSharedValue: (value: number) => ({ value }),
    useAnimatedStyle: (style: () => object) => style(),
    withRepeat: (value: number) => value,
    withTiming: (value: number) => value
  }
})

/** The rendered host tree, as `screen.toJSON()` gives it. */
type Node = { type: string; props: Record<string, unknown>; children?: unknown[] } | string | null

function walk(node: unknown, visit: (node: Exclude<Node, string | null>) => void): void {
  if (!node || typeof node === 'string') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  const element = node as Exclude<Node, string | null>
  visit(element)
  for (const child of element.children ?? []) walk(child, visit)
}

async function mount(over: Partial<Parameters<typeof BlockingProgress>[0]> = {}): Promise<void> {
  await render(
    <ThemeContext.Provider value={{ theme: 'dark', isDark: true, setTheme: async () => undefined }}>
      <BlockingProgress
        icon={<Text>icon</Text>}
        title="Reconnecting"
        body="Waiting for your desktop."
        ratio={0.4}
        {...over}
      />
    </ThemeContext.Provider>
  )
}

afterEach(cleanup)

describe('presentation', () => {
  it('is not a Modal, so no other sheet can swallow it', async () => {
    await mount()

    expect(screen.getByText('Reconnecting')).toBeTruthy()
    const modals: string[] = []
    walk(screen.toJSON(), (node) => {
      if (node.type === 'Modal') modals.push(node.type)
    })
    expect(modals).toEqual([])
  })

  it('mounts into the window overlay, so no open sheet can cover it either', async () => {
    await mount()

    // The whole card, at the root — not a wrapper somewhere inside it. This is
    // what puts it above the sidebar and above every dialog a settings page
    // opens; as a plain layer under the Stack it sat behind both.
    const root = screen.toJSON() as Exclude<Node, string | null>
    expect(root.type).toBe('RNSFullWindowOverlay')
  })

  it('takes the touches aimed at the screen behind it', async () => {
    await mount()

    // A blocking card that lets presses through to the app underneath is a
    // picture of a block. As a Modal that came free; as a layer it is built.
    let covers = 0
    walk(screen.toJSON(), (node) => {
      const style = node.props.style as Record<string, unknown> | undefined
      const fills =
        style?.position === 'absolute' &&
        style.top === 0 &&
        style.bottom === 0 &&
        style.left === 0 &&
        style.right === 0
      if (fills && node.props.focusable === true) covers += 1
    })
    expect(covers).toBeGreaterThan(0)
  })
})

describe('the clock', () => {
  it('counts from when the wait began, not from when the card appeared', async () => {
    const now = Date.now()
    // 75 seconds ago: the card is typically held back a second or more, so a
    // clock started at mount would be visibly, checkably wrong.
    await mount({ since: now - 75_000, detail: 'Reaching the relay' })

    expect(screen.getByText('1:15')).toBeTruthy()
    expect(screen.getByText('Reaching the relay')).toBeTruthy()
  })

  it('is absent when the caller has no start to report', async () => {
    await mount({ detail: 'Reaching the relay' })

    expect(screen.queryByText('0:00')).toBeNull()
  })
})
