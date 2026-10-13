/**
 * The theme switch: three segments on one track, the active one marked, and a
 * press handing the theme straight to the provider — no confirm step, unlike
 * the language switch it sits next to.
 */

import { ThemeSelector } from '@/components/common/theme-selector/ThemeSelector'
import { ThemeContext, type ThemeSource } from '@/providers/theme/useTheme'
import { cleanup, fireEvent, render, screen } from '@testing-library/react-native'

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

// Importing the module initialises i18next, so the segments carry their English
// labels rather than raw keys.
import '@/lib/i18n'

const setTheme = jest.fn<Promise<void>, [ThemeSource]>(async () => undefined)

async function mount(theme: ThemeSource): Promise<void> {
  await render(
    <ThemeContext.Provider value={{ theme, isDark: theme === 'dark', setTheme }}>
      <ThemeSelector hideLabel />
    </ThemeContext.Provider>
  )
}

afterEach(() => {
  cleanup()
  setTheme.mockClear()
})

test('offers all three sources with the active one selected', async () => {
  await mount('system')

  expect(screen.getByText('System')).toBeTruthy()
  expect(screen.getByText('Light')).toBeTruthy()
  expect(screen.getByText('Dark')).toBeTruthy()

  const selected = screen
    .getAllByRole('button')
    .filter((segment) => segment.props.accessibilityState?.selected)
  expect(selected).toHaveLength(1)
})

test('a press applies that source directly', async () => {
  await mount('system')

  await fireEvent.press(screen.getByText('Dark'))

  expect(setTheme).toHaveBeenCalledTimes(1)
  expect(setTheme).toHaveBeenCalledWith('dark')
})

test('the active segment is inert', async () => {
  await mount('dark')

  await fireEvent.press(screen.getByText('Dark'))

  expect(setTheme).not.toHaveBeenCalled()
})
