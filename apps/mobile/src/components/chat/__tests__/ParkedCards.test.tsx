/**
 * The two cards a parked turn puts on screen: the ask-the-user question and
 * the approval for a flagged tool call.
 *
 * What is actually at stake here is not layout. A card is INTERACTIVE only
 * while the desktop is still holding the turn open for it — the same card
 * replayed from the transcript, or mirrored from a turn running on another
 * surface, is a record of what happened and must not offer buttons that
 * resolve nothing. And an answered card has to say what was answered, which
 * for questions means parsing it back out of the `ask` plugin's output, since
 * that output is the only place the answer is ever written down.
 */
import { ThemeContext } from '@/providers/theme/useTheme'
import { fireEvent, render, screen } from '@testing-library/react-native'

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))

import { ApprovalCard } from '@/components/chat/ApprovalCard'
import { QuestionCard } from '@/components/chat/QuestionCard'
import type { ToolCallInfo, ToolResultInfo } from '@/lib/conversations/segments'
import type { AskCardState } from '@/state/chatRuntime'
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

const askCall = (args: Record<string, unknown>): ToolCallInfo => ({
  toolCallId: 'call_1',
  name: 'ask_user',
  args
})

const success = (output: string): ToolResultInfo => ({ status: 'success', output })

const LUNCH = {
  question: 'Where do you want to grab lunch?',
  options: [
    { label: 'Lusin — Armenian', description: 'Upscale mezze' },
    { label: 'Chotto Matte — Nikkei', description: 'Japanese-Peruvian' }
  ]
}

describe('the question card', () => {
  it('reads the chosen option back out of the plugin output', async () => {
    await draw(
      <QuestionCard
        call={askCall(LUNCH)}
        result={success(
          'The user selected option 2 of 2: "Chotto Matte — Nikkei" — Japanese-Peruvian'
        )}
      />
    )
    // The card keeps its full shape after answering — both options still
    // render — and the answered one is the one marked as chosen.
    expect(screen.getByText('Where do you want to grab lunch?')).toBeTruthy()
    expect(screen.getByText('Lusin — Armenian')).toBeTruthy()
    const chosen = screen.getByText('Chotto Matte — Nikkei')
    expect(chosen).toBeTruthy()
    // Option 1 keeps its number; the answered one swapped its number for the
    // check, so a bare "1" is present and "2" is gone.
    expect(screen.getByText('1')).toBeTruthy()
    expect(screen.queryByText('2')).toBeNull()
  })

  it('reads a free-text answer back too', async () => {
    await draw(
      <QuestionCard
        call={askCall(LUNCH)}
        result={success(
          'The user did not pick any of the listed options and instead instructed:\nI love korean bbq any killers in Riyadh?'
        )}
      />
    )
    expect(screen.getByText('I love korean bbq any killers in Riyadh?')).toBeTruthy()
  })

  it('falls back to the raw output when it cannot be parsed', async () => {
    await draw(<QuestionCard call={askCall(LUNCH)} result={success('something else entirely')} />)
    // Labelled as the answer and shown verbatim — an unrecognized output is
    // still the only record of what the user said.
    expect(screen.getByText(/Your answer:\s*something else entirely/)).toBeTruthy()
  })

  it('answers with the option the user tapped while the turn is parked', async () => {
    const onRespond = jest.fn()
    const ask: AskCardState = {
      askId: 'ask_1',
      toolCallId: 'call_1',
      questions: [{ ...LUNCH, allowOther: true }]
    }
    await draw(<QuestionCard call={askCall({})} ask={ask} onRespond={onRespond} />)
    fireEvent.press(screen.getByText('Lusin — Armenian'))
    // A one-question card submits on the first pick — the whole response, in
    // the shape the desktop's ask bridge resolves with.
    expect(onRespond).toHaveBeenCalledWith('ask_1', {
      kind: 'answered',
      answers: [{ kind: 'option', index: 0 }]
    })
  })

  it('holds every answer back until the last question of a multi-question card', async () => {
    const onRespond = jest.fn()
    const ask: AskCardState = {
      askId: 'ask_2',
      toolCallId: 'call_1',
      questions: [
        { question: 'Database?', options: [{ label: 'Postgres' }], allowOther: false },
        { question: 'Region?', options: [{ label: 'eu-west' }], allowOther: false }
      ]
    }
    await draw(<QuestionCard call={askCall({})} ask={ask} onRespond={onRespond} />)
    fireEvent.press(screen.getByText('Postgres'))
    // Answering advanced to the next question rather than submitting. (RTL 14
    // publishes the re-render asynchronously — find, don't get.)
    expect(onRespond).not.toHaveBeenCalled()
    expect(await screen.findByText('Region?')).toBeTruthy()
    fireEvent.press(screen.getByText('eu-west'))
    expect(onRespond).toHaveBeenCalledWith('ask_2', {
      kind: 'answered',
      answers: [
        { kind: 'option', index: 0 },
        { kind: 'option', index: 0 }
      ]
    })
  })

  it('is a record, not a control, once the turn is no longer holding it', async () => {
    const onRespond = jest.fn()
    await draw(
      <QuestionCard
        call={askCall(LUNCH)}
        result={success('The user selected option 1 of 2: "Lusin — Armenian" — Upscale mezze')}
        onRespond={onRespond}
      />
    )
    fireEvent.press(screen.getByText('Chotto Matte — Nikkei'))
    expect(onRespond).not.toHaveBeenCalled()
  })
})

describe('the approval card', () => {
  const approval = {
    approvalId: 'appr_1',
    toolCallId: 'call_1',
    tool: 'shell_run',
    args: { command: 'rm -rf build' },
    reason: 'matched a destructive pattern',
    level: 'destructive' as const,
    description: {
      title: 'Delete files',
      description: 'Removes the build directory',
      command: 'rm -rf build',
      impact: 'This cannot be undone.',
      risk: 'high' as const
    }
  }

  it('shows exactly what would run, and lets the user decide', async () => {
    const onDecision = jest.fn()
    await draw(<ApprovalCard state={approval} onDecision={onDecision} />)
    expect(screen.getByText('Delete files')).toBeTruthy()
    expect(screen.getByText('Removes the build directory')).toBeTruthy()
    expect(screen.getByText('rm -rf build')).toBeTruthy()
    expect(screen.getByText('This cannot be undone.')).toBeTruthy()
    expect(screen.getByLabelText('High risk')).toBeTruthy()
    fireEvent.press(screen.getByText('Deny'))
    expect(onDecision).toHaveBeenCalledWith('denied')
  })

  it('names the tool when the plugin supplied no description', async () => {
    await draw(
      <ApprovalCard state={{ ...approval, description: undefined }} onDecision={() => undefined} />
    )
    expect(screen.getByText('Shell Run')).toBeTruthy()
    expect(screen.getByText('matched a destructive pattern')).toBeTruthy()
    // No risk from the plugin ⇒ the middle of the three, like the desktop.
    expect(screen.getByLabelText('Medium risk')).toBeTruthy()
  })

  it('states the decision instead of the buttons once one is made', async () => {
    const onDecision = jest.fn()
    await draw(
      <ApprovalCard state={{ ...approval, decision: 'approved' }} onDecision={onDecision} />
    )
    expect(screen.getByText('Approved')).toBeTruthy()
    expect(screen.queryByText('Approve')).toBeNull()
    expect(screen.queryByText('Deny')).toBeNull()
  })

  it('replays from the transcript with no way to act on it', async () => {
    await draw(<ApprovalCard state={{ ...approval, decision: 'denied' }} />)
    expect(screen.getByText('Denied')).toBeTruthy()
  })
})
