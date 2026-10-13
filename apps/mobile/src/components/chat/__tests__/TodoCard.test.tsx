/**
 * The in-progress row of the task list is a REAL spinner. Every glyph in the
 * icon set is a static SVG and react-native-svg has no rotation animation, so
 * the `animate-pulse` the row used to carry only faded the icon in place — a
 * spinner that never spun, which reads as a frozen row. ActivityIndicator is
 * native, so it turns on its own. This pins that it stays that way, and that
 * the spinner stays off every other status.
 */
import { ThemeContext } from '@/providers/theme/useTheme'
import { render } from '@testing-library/react-native'

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))

import { TodoCard } from '@/components/chat/TodoCard'
import type { TodoItem } from '@/lib/conversations/types'
import '@/lib/i18n'

/**
 * The host types in the rendered tree. A real spinner is a native view, so it
 * shows up here as `ActivityIndicator`; the SVG glyph it replaced shows up as
 * `RNSVGSvgView` instead — which is the whole difference this test guards.
 */
function hostTypes(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((child) => hostTypes(child, found))
    return found
  }
  if (node && typeof node === 'object') {
    const el = node as { type?: unknown; children?: unknown }
    if (typeof el.type === 'string') found.push(el.type)
    if (el.children) hostTypes(el.children, found)
  }
  return found
}

function spinners(node: unknown): string[] {
  return hostTypes(node).filter((type) => type === 'ActivityIndicator')
}

/** The card needs the theme context: the spinner asks for the primary token. */
function draw(items: TodoItem[]) {
  return render(
    <ThemeContext.Provider
      value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
    >
      <TodoCard items={items} />
    </ThemeContext.Provider>
  )
}

describe('TodoCard', () => {
  it('spins the in-progress row with a real ActivityIndicator', async () => {
    const view = await draw([
      { content: 'Read the failing assertion', status: 'completed' },
      { content: 'Fix the pager', status: 'in_progress' },
      { content: 'Ship it', status: 'pending' }
    ])

    // Exactly one: the in-progress row, and only that row.
    expect(spinners(view.toJSON())).toHaveLength(1)
  })

  it('leaves a list with no in-progress row free of spinners', async () => {
    const view = await draw([
      { content: 'Read the failing assertion', status: 'completed' },
      { content: 'Ship it', status: 'pending' }
    ])

    expect(spinners(view.toJSON())).toHaveLength(0)
  })
})
