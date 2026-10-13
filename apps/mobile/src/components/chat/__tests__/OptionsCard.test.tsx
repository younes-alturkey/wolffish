/**
 * The copy-and-paste options card (`offer_options`).
 *
 * What is at stake is not layout: the card's whole content rides the tool
 * CALL's args, and the letters it draws (A, B, C …) are the same letters the
 * model names in its reply. If a malformed entry is dropped here but counted
 * by the plugin — or kept here and dropped there — the model's "option C"
 * points at the user's D, and nothing fails loudly. So this pins the parse,
 * the letters, the fencing of `language` content, and the copy button putting
 * the RAW content on the clipboard rather than the fenced body on screen.
 */
import { ThemeContext } from '@/providers/theme/useTheme'
import { fireEvent, render, screen } from '@testing-library/react-native'

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))

// The `mock` prefix is what lets jest hoist this past the factory's
// out-of-scope-variable guard.
const mockSetStringAsync = jest.fn(async (_text: string) => true)
jest.mock('expo-clipboard', () => ({ setStringAsync: (t: string) => mockSetStringAsync(t) }))

import {
  OptionsCard,
  bodyMarkdown,
  optionLetter,
  parseOptionItems
} from '@/components/chat/OptionsCard'
import type { ToolCallInfo } from '@/lib/conversations/segments'
import '@/lib/i18n'

async function draw(node: React.JSX.Element) {
  return await render(
    <ThemeContext.Provider
      value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
    >
      {node}
    </ThemeContext.Provider>
  )
}

const call = (args: Record<string, unknown>): ToolCallInfo => ({
  toolCallId: 'call_1',
  name: 'offer_options',
  args
})

describe('optionLetter', () => {
  it('runs A…Z then AA, AB — the same scheme every other surface uses', () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(optionLetter)).toEqual([
      'A',
      'B',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA'
    ])
  })
})

describe('parseOptionItems', () => {
  it('accepts the documented shape, a bare string, and the synonyms', () => {
    const parsed = parseOptionItems([
      { title: 'Documented', description: 'why', language: 'ts', content: 'a' },
      'bare string',
      { label: 'Label synonym', code: 'b' },
      { title: 'Text synonym', text: 'c' },
      { title: 'Value synonym', value: 'd', lang: 'sql' }
    ])
    expect(parsed.map((o) => o.title)).toEqual([
      'Documented',
      'Option B',
      'Label synonym',
      'Text synonym',
      'Value synonym'
    ])
    expect(parsed.map((o) => o.content)).toEqual(['a', 'bare string', 'b', 'c', 'd'])
    expect(parsed[4].language).toBe('sql')
  })

  it('drops contentless entries so the letters close over the gap', () => {
    // A kept-but-empty entry would shift every letter after it, which is
    // exactly how "option C" ends up pointing at the wrong option.
    const parsed = parseOptionItems([
      { title: 'First', content: 'a' },
      { title: 'No content' },
      { title: 'Blank', content: '   ' },
      null,
      42,
      { title: 'Last', content: 'b' }
    ])
    expect(parsed.map((o) => o.title)).toEqual(['First', 'Last'])
  })

  it('returns nothing for a non-array', () => {
    expect(parseOptionItems(undefined)).toEqual([])
    expect(parseOptionItems('not a list')).toEqual([])
  })
})

describe('bodyMarkdown', () => {
  it('leaves markdown content alone', () => {
    expect(bodyMarkdown({ title: 't', content: '# hi' })).toBe('# hi')
  })

  it('fences raw code with its language', () => {
    expect(bodyMarkdown({ title: 't', language: 'ts', content: 'const a = 1' })).toBe(
      '```ts\nconst a = 1\n```'
    )
  })

  it('outgrows a fence the content carries itself', () => {
    // A 3-backtick outer fence would be closed by the inner one and the rest
    // of the snippet would leak out as prose.
    expect(bodyMarkdown({ title: 't', language: 'md', content: 'see:\n```js\nx\n```' })).toBe(
      '````md\nsee:\n```js\nx\n```\n````'
    )
  })
})

describe('OptionsCard', () => {
  beforeEach(() => mockSetStringAsync.mockClear())

  it('draws a lettered tab per option and the first option in the body', async () => {
    await draw(
      <OptionsCard
        call={call({
          title: 'Three ways to debounce',
          options: [
            {
              title: 'Plain timeout',
              description: 'No deps.',
              language: 'ts',
              content: 'const a = 1'
            },
            { title: 'Leading edge', content: 'b' },
            { title: 'lodash', content: 'npm i lodash.debounce' }
          ]
        })}
      />
    )
    expect(screen.getByText('Three ways to debounce')).toBeTruthy()
    expect(screen.getByText('Option 1 of 3')).toBeTruthy()
    for (const letter of ['A', 'B', 'C']) expect(screen.getByText(letter)).toBeTruthy()
    // The first option's own title and description head the body.
    expect(screen.getAllByText('Plain timeout').length).toBeGreaterThan(0)
    expect(screen.getByText('No deps.')).toBeTruthy()
  })

  it('switches the body when a tab is tapped', async () => {
    await draw(
      <OptionsCard
        call={call({
          options: [
            { title: 'First', content: 'a' },
            { title: 'Second', description: 'the other one', content: 'b' }
          ]
        })}
      />
    )
    expect(screen.queryByText('the other one')).toBeNull()
    fireEvent.press(screen.getByText('Second'))
    // RTL 14 publishes the re-render asynchronously — find, don't get.
    expect(await screen.findByText('the other one')).toBeTruthy()
    expect(screen.getByText('Option 2 of 2')).toBeTruthy()
  })

  it('copies the RAW content, not the fenced body on screen', async () => {
    await draw(
      <OptionsCard
        call={call({
          options: [
            { title: 'Code', language: 'ts', content: 'const a = 1' },
            { title: 'Other', content: 'b' }
          ]
        })}
      />
    )
    fireEvent.press(screen.getByLabelText('Copy this option'))
    expect(mockSetStringAsync).toHaveBeenCalledWith('const a = 1')
  })

  it('falls back to a counted heading when the model gave no title', async () => {
    await draw(
      <OptionsCard
        call={call({
          options: [
            { title: 'A one', content: 'a' },
            { title: 'A two', content: 'b' }
          ]
        })}
      />
    )
    expect(screen.getByText('2 options to copy')).toBeTruthy()
  })

  it('renders nothing at all when no option is usable', async () => {
    const view = await draw(<OptionsCard call={call({ options: [{ title: 'no content' }] })} />)
    expect(view.toJSON()).toBeNull()
  })
})
