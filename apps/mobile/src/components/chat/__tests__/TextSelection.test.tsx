/**
 * Getting at the text: select part of it, copy that part.
 *
 * The two platforms need different mechanisms, and the reason is a hard React
 * Native limitation rather than a preference. Android's `selectable` maps to
 * setTextIsSelectable(true) — a real cursor with drag handles, in place. iOS
 * has no equivalent for <Text> at all: RCTSelectableText ships only under
 * ReactAndroid, so `selectable` there resolves to RCTParagraphComponentView,
 * whose entire contribution is a long-press menu that copies the whole node —
 * which is just the copy button the feed already has. iOS therefore spends the
 * long press on SelectTextSheet, whose read-only multiline TextInput is a
 * UITextView and does have a cursor.
 *
 * So the invariant under test is "content is reachable by THIS platform's
 * route", plus a pin on which route that is, so the split cannot silently
 * flip. The second half of the file is the guard in the other direction: a
 * control's label must offer neither, or it stops being a control.
 */
import { ThemeContext } from '@/providers/theme/useTheme'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { Platform } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }))
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => undefined) }))

import { ApprovalCard } from '@/components/chat/ApprovalCard'
import { MarkdownView } from '@/components/chat/MarkdownView'
import {
  SelectTextHost,
  closeSelectText,
  openSelectMarkdown,
  openSelectText
} from '@/components/chat/SelectTextSheet'
import * as Clipboard from 'expo-clipboard'
import { CodeBlockText } from '@/components/chat/ToolCard'
import type { ApprovalCardState } from '@/state/chatRuntime'
import '@/lib/i18n'

afterEach(() => closeSelectText())

/** Where in-place selection is the platform's own answer. */
const IN_PLACE = Platform.OS === 'android'

const SAFE_AREA = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 }
}

// `render` is async in RNTL 14 — it resolves its own act() before publishing
// to `screen`, so every call site must await or the queries race the mount.
async function draw(node: React.JSX.Element): Promise<void> {
  await render(
    <SafeAreaProvider initialMetrics={SAFE_AREA}>
      <ThemeContext.Provider
        value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
      >
        {node}
      </ThemeContext.Provider>
    </SafeAreaProvider>
  )
}

type Rendered = {
  type?: string
  props?: {
    selectable?: boolean
    onLongPress?: unknown
    accessibilityRole?: string
    [key: string]: unknown
  }
  children?: unknown
}

type Entry = { text: string; selectable: boolean; longPressable: boolean; inControl: boolean }

/**
 * Every rendered string paired with the routes available to it. Ancestor-based
 * because nested Text is virtual — a run's bold/link children ride the outer
 * node's selection and its long press.
 */
function strings(): Entry[] {
  const out: Entry[] = []
  const walk = (node: unknown, state: Omit<Entry, 'text'>): void => {
    if (typeof node === 'string') {
      if (node.trim()) out.push({ ...state, text: node })
      return
    }
    if (Array.isArray(node)) {
      node.forEach((child) => walk(child, state))
      return
    }
    if (!node || typeof node !== 'object') return
    const el = node as Rendered
    walk(el.children, {
      selectable: state.selectable || el.props?.selectable === true,
      longPressable: state.longPressable || typeof el.props?.onLongPress === 'function',
      inControl: state.inControl || el.props?.accessibilityRole === 'button'
    })
  }
  walk(screen.toJSON(), { selectable: false, longPressable: false, inControl: false })
  return out
}

/**
 * Content the reader cannot get at by any route, minus list markers.
 *
 * A bullet or "1." is decoration, not content — react-native-markdown-display
 * says so itself by rendering the bullet with `accessible={false}`. Matched a
 * fragment at a time because the library emits an ordered marker as two
 * children ({number}{markup}), so "1." arrives as "1" and ".".
 */
const LIST_MARKER = /^(?:[·•]|\d+|\.)$/

function unreachable(): string[] {
  return strings()
    .filter((e) => !e.selectable && !e.longPressable && !LIST_MARKER.test(e.text.trim()))
    .map((e) => e.text)
}

/** The first TextInput in the tree — the sheet's selectable body. */
function textInputNode(): Rendered | undefined {
  let found: Rendered | undefined
  const walk = (node: unknown): void => {
    if (found || !node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    const el = node as Rendered
    if (el.type === 'TextInput') {
      found = el
      return
    }
    walk(el.children)
  }
  walk(screen.toJSON())
  return found
}

function textInput(): Rendered['props'] | undefined {
  return textInputNode()?.props
}

/**
 * Everything the field actually shows. Read from children rather than `value`
 * because the rendered form arrives as nested Text — that nesting is what
 * carries the weights and fonts into iOS's attributed string.
 */
function inputText(): string {
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node)
      return
    }
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (node && typeof node === 'object') walk((node as Rendered).children)
  }
  walk(textInputNode()?.children)
  return out.join('')
}

const RICH_MARKDOWN = [
  '# A heading',
  '',
  'A paragraph with **bold**, `inline code` and a [link](https://example.com).',
  '',
  '- first item',
  '- second item',
  '',
  '1. step one',
  '2. step two',
  '',
  '> a quoted line',
  '',
  '| col | other |',
  '| --- | ----- |',
  '| a   | b     |'
].join('\n')

describe('chat prose is reachable on this platform', () => {
  it('leaves nothing in a rendered message out of reach', async () => {
    await draw(<MarkdownView onLongPress={() => undefined}>{RICH_MARKDOWN}</MarkdownView>)
    expect(unreachable()).toEqual([])
    // Not vacuous: the blocks that get there by four different routes —
    // heading and paragraph directly, list item and table cell nested deeper —
    // are all actually on screen.
    expect(strings().map((e) => e.text)).toEqual(
      expect.arrayContaining([
        'A heading',
        'bold',
        'first item',
        'step one',
        'a quoted line',
        'col'
      ])
    )
  })

  it('covers fenced code, which is a block token and misses the prose rule', async () => {
    await draw(
      <MarkdownView onLongPress={() => undefined}>{'```bash\nnpm run ios\n```'}</MarkdownView>
    )
    expect(unreachable()).toEqual([])
    // ...and still trims the parser's surplus trailing newline, the one
    // behaviour the library's own rule had that ours has to keep.
    expect(strings().map((e) => e.text)).toEqual(['npm run ios'])
  })

  it('uses in-place selection only where the platform actually has it', async () => {
    await draw(<MarkdownView onLongPress={() => undefined}>{RICH_MARKDOWN}</MarkdownView>)
    const content = strings().filter((e) => !LIST_MARKER.test(e.text.trim()))
    expect(content.length).toBeGreaterThan(0)
    // The pin. On iOS `selectable` would only re-add the whole-node copy menu
    // that the feed's copy button already is, so it must stay off there.
    expect(content.every((e) => e.selectable === IN_PLACE)).toBe(true)
    // The long press is wired on both — Android simply never gets to it,
    // because its own selection claims the gesture first.
    expect(content.every((e) => e.longPressable)).toBe(true)
  })

  it('offers no long press when no handler was given', async () => {
    await draw(<MarkdownView>{'Just a line.'}</MarkdownView>)
    expect(strings().every((e) => !e.longPressable)).toBe(true)
  })
})

describe('the select sheet is a real text cursor', () => {
  const BODY = 'line one\nline two\nline three'

  it('stays entirely unmounted until something asks for it', async () => {
    // Bare on purpose — no SafeAreaProvider, no theme. A closed host must
    // contribute nothing at all, not merely render something invisible. When
    // the sheet lived inside each message and ran its hooks unconditionally,
    // this is what broke: every test that drew a bubble without a provider
    // died on useSafeAreaInsets.
    await render(<SelectTextHost />)
    expect(screen.toJSON()).toBeNull()
  })

  it('puts the text in a read-only multiline field once opened', async () => {
    await draw(<SelectTextHost />)
    openSelectText(BODY)
    await waitFor(() => expect(textInput()).toBeDefined())
    const input = textInput()
    // multiline is what makes it a UITextView rather than a UITextField, and
    // a UITextView is the only thing in React Native with a selection cursor.
    expect(input?.multiline).toBe(true)
    // editable=false sets UITextView.editable=NO while selectable stays YES:
    // no keyboard, full cursor. Losing this makes the sheet an editor.
    expect(input?.editable).toBe(false)
    // Literal text goes in whole and untouched — a command or a tool output
    // must not have characters eaten by a markdown pass.
    expect(inputText()).toBe(BODY)
  })

  it('shows a message RENDERED, never its markdown source', async () => {
    await draw(<SelectTextHost />)
    openSelectMarkdown(
      [
        '## Release notes',
        '',
        'Shipped **bold** and `code` today.',
        '',
        '- first item',
        '- second item',
        '',
        '| col | other |',
        '| --- | ----- |',
        '| a   | b     |'
      ].join('\n')
    )
    await waitFor(() => expect(textInput()).toBeDefined())
    const shown = inputText()

    // The content survives...
    expect(shown).toContain('Release notes')
    expect(shown).toContain('bold')
    expect(shown).toContain('code')
    expect(shown).toContain('first item')
    // ...and a list still reads as a list, by marker rather than by layout.
    expect(shown).toContain('• first item')
    // ...but not one character of syntax comes with it. This is the whole
    // complaint the sheet exists to answer: selecting out of `**bold**` and
    // `| a | b |` is selecting out of the source, not the message.
    expect(shown).not.toContain('**')
    expect(shown).not.toContain('##')
    expect(shown).not.toContain('`')
    expect(shown).not.toContain('|')
    expect(shown).not.toContain('- first')
  })

  it('copies what is on screen, not the source behind it', async () => {
    await draw(<SelectTextHost />)
    openSelectMarkdown('A **bold** claim.')
    await waitFor(() => expect(textInput()).toBeDefined())
    fireEvent.press(screen.getByLabelText('Copy message'))
    // Copy-all and a drag-select must agree, or the button is a trap.
    await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalledWith('A bold claim.'))
  })
})

describe('a long press on tool output opens the whole output', () => {
  // Longer than ToolCard's 1200-char clamp, so the two differ.
  const LONG = `${'x'.repeat(1500)}END`

  it('hands the sheet the unclamped text the card had to truncate', async () => {
    await draw(
      <>
        <CodeBlockText text={LONG} />
        <SelectTextHost />
      </>
    )
    // The card itself shows the clamp...
    const shown = strings().map((e) => e.text)
    expect(shown.every((value) => value.length <= 1201)).toBe(true)
    expect(shown.join('')).not.toContain('END')

    if (!IN_PLACE) {
      // ...but the sheet it opens holds all of it, which is the point: a long
      // output is exactly when the line you want is past the clamp.
      fireEvent(screen.getByText(shown[0] as string), 'longPress')
      await waitFor(() => expect(inputText()).toBe(LONG))
    }
  })
})

const APPROVAL: ApprovalCardState = {
  approvalId: 'ap_1',
  toolCallId: 'c1',
  tool: 'bash',
  args: { command: 'rm -rf build' },
  reason: 'Deletes files',
  level: 'destructive',
  description: {
    title: 'Delete the build directory',
    description: 'This removes generated output.',
    command: 'rm -rf build',
    impact: 'The next build starts from scratch.',
    risk: 'high'
  }
}

describe('a card puts its prose within reach without disarming its buttons', () => {
  it('leaves every control label neither selectable nor long-pressable', async () => {
    await draw(<ApprovalCard state={APPROVAL} onDecision={() => undefined} />)
    const inControl = strings().filter((e) => e.inControl)
    // The Approve / Deny labels — proof the subject exists at all, so a card
    // that stopped rendering its buttons can't pass this vacuously.
    expect(inControl.map((e) => e.text)).toEqual(['Approve', 'Deny'])
    // On Android a selectable label takes focus and eats the tap that was the
    // whole point of the control; a long press there would open a sheet over
    // a decision the user is trying to make.
    expect(inControl.filter((e) => e.selectable || e.longPressable)).toEqual([])
  })
})
