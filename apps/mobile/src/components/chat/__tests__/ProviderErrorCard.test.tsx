/**
 * The provider error card — the desktop's failed-turn surface, ported.
 *
 * The contract under test: a failed turn renders as its error card and
 * nothing else (no partial prose, no copy footer — the desktop replaces the
 * bubble the same way); a structured failure names its provider while a bare
 * error string falls back to the generic card; "View details" opens the
 * verbatim trace; and the retry button exists only where the screen passes a
 * handler — one per turn, on the first card — reporting the failure line the
 * continuation prompt is built from.
 */
import { ThemeContext } from '@/providers/theme/useTheme'
import { fireEvent, render, screen } from '@testing-library/react-native'

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => undefined) }))
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
import type {
  ConversationMessage,
  NoProviderAvailableInfo,
  Segment
} from '@/lib/conversations/types'
import '@/lib/i18n'

async function draw(node: React.JSX.Element): Promise<void> {
  await render(
    <ThemeContext.Provider
      value={{ theme: 'light', isDark: false, setTheme: async () => undefined }}
    >
      {node}
    </ThemeContext.Provider>
  )
}

const FAILURE: NoProviderAvailableInfo = {
  provider: 'anthropic',
  providerLogo: 'anthropic',
  statusCode: 401,
  errorReason: 'authentication failed',
  errorDetail: 'invalid x-api-key',
  retriesAttempted: 2,
  totalDurationMs: 21000
}

function failedMessage(
  providerErrors?: NoProviderAvailableInfo[],
  extra?: Partial<ConversationMessage>
): ConversationMessage {
  const segments: Segment[] = [
    { kind: 'text', turnId: 't1', segmentId: 's1', delta: 'Partial prose before the failure.' },
    {
      kind: 'turn_end',
      turnId: 't1',
      segmentId: 's2',
      stopReason: 'error',
      iterationCount: 1,
      ...(providerErrors ? { providerErrors } : {})
    }
  ]
  return { id: 'm1', role: 'assistant', content: '', timestamp: 1, segments, ...extra }
}

describe('a failed turn renders as the desktop card, and only the card', () => {
  it('names the provider failure and hides the partial prose', async () => {
    await draw(<AssistantMessageView message={failedMessage([FAILURE])} verbose={false} />)
    expect(screen.getByText('API key invalid')).toBeTruthy()
    expect(screen.getByText('API key invalid or expired — update in settings.')).toBeTruthy()
    expect(screen.queryByText('Partial prose before the failure.')).toBeNull()
  })

  it('opens the verbatim trace on View details', async () => {
    await draw(<AssistantMessageView message={failedMessage([FAILURE])} verbose={false} />)
    expect(screen.queryByText(/Provider: anthropic/)).toBeNull()
    fireEvent.press(screen.getByText('View details'))
    const trace = await screen.findByText(/Provider: anthropic/)
    expect(trace.props.children).toContain('Status: HTTP 401')
    expect(trace.props.children).toContain('Detail: invalid x-api-key')
    expect(trace.props.children).toContain('Retries: 2')
  })

  it('falls back to the generic card for a bare error string', async () => {
    const bare: ConversationMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      error: 'stream cut mid-reply'
    }
    await draw(<AssistantMessageView message={bare} verbose={false} />)
    expect(screen.getByText('API provider error')).toBeTruthy()
    fireEvent.press(screen.getByText('View details'))
    expect(await screen.findByText(/Error: stream cut mid-reply/)).toBeTruthy()
  })

  it('renders the generic card for a live turn the desktop marked failed', async () => {
    const empty: ConversationMessage = { role: 'assistant', content: '', timestamp: 1 }
    await draw(<AssistantMessageView message={empty} verbose={false} liveTurn liveError />)
    expect(screen.getByText('API provider error')).toBeTruthy()
  })

  it('keeps the prose and shows the card inline for a turn that recovered', async () => {
    // stopReason end_turn + providerErrors = the turn retried through a
    // failure and finished. The desktop renders the reply AND the failure
    // record; only a turn that actually FAILED collapses to card-only.
    const recovered: ConversationMessage = {
      id: 'm1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      segments: [
        { kind: 'text', turnId: 't1', segmentId: 's1', delta: 'The full answer.' },
        {
          kind: 'turn_end',
          turnId: 't1',
          segmentId: 's2',
          stopReason: 'end_turn',
          iterationCount: 2,
          providerErrors: [{ ...FAILURE, errorReason: 'offline', statusCode: null }]
        }
      ]
    }
    await draw(<AssistantMessageView message={recovered} verbose={false} />)
    expect(screen.getByText('The full answer.')).toBeTruthy()
    expect(screen.getByText('API provider error')).toBeTruthy()
    // A mid-transcript record, not a control — no retry on recovered turns.
    expect(screen.queryByText('Try again')).toBeNull()
  })
})

describe('the retry button', () => {
  it('rides only the first card, and reports the failure line', async () => {
    const onTryAgain = jest.fn()
    const second: NoProviderAvailableInfo = {
      ...FAILURE,
      provider: 'openai',
      providerLogo: 'openai',
      statusCode: 429,
      errorReason: 'rate-limited'
    }
    await draw(
      <AssistantMessageView
        message={failedMessage([FAILURE, second])}
        verbose={false}
        onTryAgain={onTryAgain}
      />
    )
    const buttons = screen.getAllByText('Try again')
    expect(buttons).toHaveLength(1)
    fireEvent.press(buttons[0])
    expect(onTryAgain).toHaveBeenCalledWith('anthropic · HTTP 401 · authentication failed')
  })

  it('is absent without a handler — a historical failure is a record, not a control', async () => {
    await draw(<AssistantMessageView message={failedMessage([FAILURE])} verbose={false} />)
    expect(screen.queryByText('Try again')).toBeNull()
  })
})
