/**
 * WHERE a parked card sits in the transcript — the other half of what
 * ParkedCards.test covers (what a card shows and when it is a control).
 *
 * The contract: a card keeps the position the turn parked at. While the turn
 * is waiting it is the last thing written, so the tail IS that position; once
 * the user answers and the turn moves on, everything that streams afterwards
 * lands BELOW the card, and no other message — earlier ones in the transcript,
 * later turns' rows — ever hosts a copy. The clean-feed mirror strips
 * tool_call segments, so mid-turn the card cannot anchor the way a stored
 * body's can; its RESULT segment still lands at the park position, and the
 * toolAnchor block (segments.ts) is how the feed finds it.
 */
import { ThemeContext } from '@/providers/theme/useTheme'
import { render, screen } from '@testing-library/react-native'

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => undefined) }))
// Card placement is decided in MessageBubbles; the heavy leaves around the
// cards (video players, chart WebViews, markdown engine) have no say in it.
jest.mock('@/components/chat/FileBlock', () => ({ FileBlock: () => null }))
jest.mock('@/components/chat/TaskCard', () => ({ TaskCard: () => null }))
jest.mock('@/components/chat/BrowserCard', () => ({ BrowserCard: () => null }))
jest.mock('@/components/chat/MarkdownView', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native')
  return {
    MarkdownView: ({ children }: { children?: unknown }) =>
      React.createElement(Text, null, String(children)),
    markdownHasTable: () => false
  }
})
// InlineCards reads the `inapp.reasoning` switch from the config store, which
// reaches for AsyncStorage on import. The switch is not what this suite is
// about — pin it on (its shipping default) and keep the native module out.
jest.mock('@/state/demoConfig', () => ({ useConfigValue: () => true }))
jest.mock('@/lib/sync/cards', () => ({ respondAsk: jest.fn(), respondApproval: jest.fn() }))

import { AssistantMessageView } from '@/components/chat/MessageBubbles'
import type { ConversationMessage, Segment } from '@/lib/conversations/types'
import { useChatRuntime, type AskCardState } from '@/state/chatRuntime'
import '@/lib/i18n'

const CONVERSATION = 'conv-1'

async function draw(node: React.JSX.Element): Promise<void> {
  await render(
    <ThemeContext.Provider
      value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
    >
      {node}
    </ThemeContext.Provider>
  )
}

/** Every rendered string, in tree order — positions are the whole subject. */
function textsInOrder(): string[] {
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (typeof node === 'string') out.push(node)
    else if (Array.isArray(node)) node.forEach(walk)
    else if (node && typeof node === 'object') walk((node as { children?: unknown }).children)
  }
  walk(screen.toJSON())
  return out
}

function at(text: string): number {
  const index = textsInOrder().findIndex((value) => value.includes(text))
  expect(index).toBeGreaterThanOrEqual(0)
  return index
}

function textSegment(id: string, delta: string): Segment {
  return { kind: 'text', turnId: 't1', segmentId: id, delta }
}

function askResult(id: string): Segment {
  return {
    kind: 'tool_result',
    turnId: 't1',
    segmentId: id,
    toolCallId: 'c1',
    status: 'success',
    output: 'The user selected option 1 of 2: "Lusin" — Armenian'
  }
}

/** The live message as the clean-feed mirror builds it: no tool_call segments. */
function mirrored(segments: Segment[]): ConversationMessage {
  return { id: 'm_2', role: 'assistant', content: '', timestamp: 2, segments }
}

const ASK: AskCardState = {
  askId: 'ask_1',
  toolCallId: 'c1',
  questions: [
    {
      question: 'Where do you want to grab lunch?',
      options: [{ label: 'Lusin' }, { label: 'Chotto Matte' }],
      allowOther: false
    }
  ]
}

beforeEach(() => {
  useChatRuntime.setState({ streams: {}, cards: {} })
})

describe('where the parked cards sit', () => {
  it('keeps a parked ask at the tail — the park position — while nothing has streamed past it', async () => {
    useChatRuntime.getState().putAsk(CONVERSATION, ASK)
    await draw(
      <AssistantMessageView
        message={mirrored([textSegment('s1', 'Checking the options.')])}
        conversationId={CONVERSATION}
        verbose={false}
        streaming
        liveTurn
      />
    )
    // Rendered as the card, not swallowed by the thinking indicator, and after
    // the prose the turn wrote before parking.
    expect(at('Where do you want to grab lunch?')).toBeGreaterThan(at('Checking the options.'))
  })

  it('renders the answered ask at its result anchor, above what streamed after it', async () => {
    useChatRuntime
      .getState()
      .putAsk(CONVERSATION, { ...ASK, answered: true, answers: [{ kind: 'option', index: 0 }] })
    await draw(
      <AssistantMessageView
        message={mirrored([
          textSegment('s1', 'Checking the options.'),
          askResult('s2'),
          textSegment('s3', 'Lusin it is — booking a table.')
        ])}
        conversationId={CONVERSATION}
        verbose={false}
        streaming
        liveTurn
      />
    )
    const question = at('Where do you want to grab lunch?')
    expect(question).toBeGreaterThan(at('Checking the options.'))
    expect(question).toBeLessThan(at('Lusin it is — booking a table.'))
  })

  it('places a decided approval at its result anchor the same way', async () => {
    useChatRuntime.getState().putApproval(CONVERSATION, {
      approvalId: 'appr_1',
      toolCallId: 'c1',
      tool: 'shell_run',
      args: { command: 'rm -rf build' },
      reason: 'matched a destructive pattern',
      level: 'destructive',
      description: {
        title: 'Delete files',
        description: 'Removes the build directory',
        risk: 'high'
      },
      decision: 'approved'
    })
    await draw(
      <AssistantMessageView
        message={mirrored([
          textSegment('s1', 'This needs a sign-off.'),
          {
            kind: 'tool_result',
            turnId: 't1',
            segmentId: 's2',
            toolCallId: 'c1',
            status: 'success',
            output: 'removed'
          },
          textSegment('s3', 'Build directory is gone.')
        ])}
        conversationId={CONVERSATION}
        verbose={false}
        streaming
        liveTurn
      />
    )
    const card = at('Delete files')
    expect(card).toBeGreaterThan(at('This needs a sign-off.'))
    expect(card).toBeLessThan(at('Build directory is gone.'))
  })

  it('never draws the live card under any other message', async () => {
    // While a card is live, every stored assistant message in the transcript
    // renders alongside it — and none of them may host a copy. Only the live
    // row does.
    useChatRuntime.getState().putAsk(CONVERSATION, ASK)
    await draw(
      <AssistantMessageView
        message={{
          id: 'm_0',
          role: 'assistant',
          content: '',
          timestamp: 1,
          segments: [textSegment('s1', 'An earlier reply.')]
        }}
        conversationId={CONVERSATION}
        verbose={false}
      />
    )
    expect(screen.queryByText('Where do you want to grab lunch?')).toBeNull()
    expect(screen.getByText('An earlier reply.')).toBeTruthy()
  })
})
