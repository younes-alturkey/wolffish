/**
 * The app-wide keyboard dismiss chevron: every field pairs its own
 * InputAccessoryView by a per-instance id (which is what lets the bar show
 * on pushed screens and inside RN Modals alike — a shared bar mounted far
 * from the field never attaches). The chevron's one contract is everywhere
 * the same — it parks the keyboard and touches nothing else.
 */

import { cleanup, fireEvent, render } from '@testing-library/react-native'
import { Keyboard } from 'react-native'

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))

import { KeyboardDismissAccessory } from '@/components/core/KeyboardDismissBar'
import { Input } from '@/components/core/Input'
import { Textarea } from '@/components/core/Textarea'
import { ThemeContext } from '@/providers/theme/useTheme'
import '@/lib/i18n'

const theme = { theme: 'light' as const, isDark: false, setTheme: async () => undefined }

const dismissed = jest.spyOn(Keyboard, 'dismiss')

beforeEach(() => {
  dismissed.mockClear()
})

afterEach(() => {
  cleanup()
})

describe('the accessory', () => {
  it('parks the keyboard from its chevron', async () => {
    const view = await render(<KeyboardDismissAccessory nativeID="test-accessory" />)
    fireEvent.press(view.getByLabelText('Hide keyboard'))
    expect(dismissed).toHaveBeenCalled()
  })

  it('is paired by the core field wrappers — every field carries its own', async () => {
    const view = await render(
      <ThemeContext.Provider value={theme}>
        <Input placeholder="name" />
        <Textarea placeholder="notes" />
      </ThemeContext.Provider>
    )
    const name = view.getByPlaceholderText('name').props.inputAccessoryViewID as string
    const notes = view.getByPlaceholderText('notes').props.inputAccessoryViewID as string
    expect(name.length).toBeGreaterThan(0)
    expect(notes.length).toBeGreaterThan(0)
    // Distinct per instance, so two fields on one screen never collide.
    expect(name).not.toBe(notes)
    // And each field renders the accessory it names: one chevron per field.
    expect(view.getAllByLabelText('Hide keyboard')).toHaveLength(2)
  })
})
