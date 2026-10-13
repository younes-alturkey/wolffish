/**
 * The reindex card on screen: nothing when the desktop is idle, the file count
 * while it rebuilds, and a sheet that leaves with the rebuild.
 */

// The store reaches the tunnel client, which reaches the push registration,
// which touches AsyncStorage at import time.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

import { ActiveOverlays } from '@/components/overlays/ActiveOverlays'
import { applyOverlayReindex, clearOverlays } from '@/lib/sync/overlays'
import { ThemeContext } from '@/providers/theme/useTheme'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'

// The pulse and the enter/exit transitions need the native runtime and have no
// say in what is on the card.
jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native')
  return {
    __esModule: true,
    default: { View },
    Easing: { out: (fn: unknown) => fn, ease: 0 },
    FadeInUp: { duration: () => ({}) },
    FadeOut: { duration: () => ({}) },
    useSharedValue: (value: number) => ({ value }),
    useAnimatedStyle: (style: () => object) => style(),
    withRepeat: (value: number) => value,
    withTiming: (value: number) => value
  }
})

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 })
}))

beforeEach(() => {
  clearOverlays()
})

/**
 * The sheet's Modal reads the theme, so the stack always needs the context.
 *
 * Awaited, as every screen test here is: a bare `render()` called from inside a
 * helper never binds `screen`, and every later query then fails with "render
 * function has not been called" rather than with what is actually wrong.
 */
async function mount(): Promise<void> {
  await render(
    <ThemeContext.Provider
      value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
    >
      <ActiveOverlays />
    </ThemeContext.Provider>
  )
}

it('draws nothing at all when the desktop is idle', async () => {
  // Not an empty container — nothing, so no invisible strip sits over the
  // screen swallowing the top of every other view.
  await mount()
  expect(screen.toJSON()).toBeNull()
})

it('shows a reindex as its file count', async () => {
  applyOverlayReindex({ startedAt: 1_000, done: 1204, total: 3900 })
  await mount()
  expect(screen.getByText('Rebuilding memory index')).toBeTruthy()
  expect(screen.getByText('1,204 / 3,900')).toBeTruthy()
})

it('opens the details on tap, and closes them when the rebuild ends', async () => {
  applyOverlayReindex({ startedAt: 1_000, done: 1, total: 2 })
  await mount()

  fireEvent.press(screen.getByRole('button', { name: 'Rebuilding memory index' }))
  // The sheet says where it is running; the card never does.
  await waitFor(() => expect(screen.getByText(/running on your desktop/)).toBeTruthy())

  // The rebuild ends. A sheet left standing over a finished one would go on
  // claiming it is still going.
  act(() => applyOverlayReindex(null))
  await waitFor(() => expect(screen.toJSON()).toBeNull())
})
