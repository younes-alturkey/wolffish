/**
 * The clean feed's code activity: with Task results OFF, an edit, a write or
 * a shell run still shows — as a compact row carrying the file or command,
 * the edit's +N −M or the run's exit code — while every other tool stays
 * hidden; the model's task list renders as a checklist on both settings; and
 * the compact row opens to the red/green diff. Everything on screen comes
 * from the persisted segments, so a reopened conversation draws the same.
 */
import { ThemeContext } from '@/providers/theme/useTheme'
import { act, fireEvent, render, screen } from '@testing-library/react-native'

jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }))
// The pulsing status pill and the in-progress task glyph animate through
// reanimated, which has no place in a placement test.
jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native')
  const anim = { duration: () => anim, delay: () => anim, springify: () => anim }
  return { __esModule: true, default: { View }, FadeInDown: anim, FadeInUp: anim, FadeOut: anim }
})
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
jest.mock('@/state/demoConfig', () => ({ useConfigValue: () => true }))
jest.mock('@/lib/sync/cards', () => ({ respondAsk: jest.fn(), respondApproval: jest.fn() }))

import { AssistantMessageView } from '@/components/chat/MessageBubbles'
import type { ConversationMessage, Segment } from '@/lib/conversations/types'
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

/** The flat text of every rendered node — a Text's string and number
 *  children joined, so "+1" is one string even though React keeps the
 *  '+' and the 1 apart. */
function texts(): string[] {
  const out: string[] = []
  const flat = (node: unknown): string => {
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(flat).join('')
    if (node && typeof node === 'object') return flat((node as { children?: unknown }).children)
    return ''
  }
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk)
    else if (node && typeof node === 'object') {
      out.push(flat(node))
      walk((node as { children?: unknown }).children)
    }
  }
  walk(screen.toJSON())
  return out
}

const has = (text: string): boolean => texts().some((value) => value.includes(text))

const PATCH = '@@ -1,2 +1,2 @@\n context\n-old line\n+new line'

function pair(
  id: string,
  name: string,
  args: Record<string, unknown>,
  result: Partial<Extract<Segment, { kind: 'tool_result' }>> = {}
): Segment[] {
  return [
    { kind: 'tool_call', turnId: 't1', segmentId: `c-${id}`, toolCallId: id, name, args },
    {
      kind: 'tool_result',
      turnId: 't1',
      segmentId: `r-${id}`,
      toolCallId: id,
      status: 'success',
      output: '',
      ...result
    }
  ]
}

const message: ConversationMessage = {
  id: 'm1',
  role: 'assistant',
  content: 'Done.',
  timestamp: 1,
  segments: [
    ...pair('read', 'file_read', { path: '/repo/src/a.ts' }, { output: '1: hello' }),
    ...pair(
      'edit',
      'file_edit',
      { path: '/repo/src/a.ts' },
      {
        output: 'Edited /repo/src/a.ts',
        meta: {
          diff: { path: '/repo/src/a.ts', patch: PATCH, additions: 1, deletions: 1 },
          label: 'Edit'
        }
      }
    ),
    ...pair(
      'run',
      'shell_exec',
      { command: 'npm test' },
      { output: '12 passing', meta: { exitCode: 0, durationMs: 411, label: 'Run tests' } }
    ),
    {
      kind: 'todo',
      turnId: 't1',
      segmentId: 'd1',
      items: [
        { content: 'Fix the slicer', status: 'completed' },
        { content: 'Run the suite', status: 'in_progress', priority: 'high' }
      ]
    },
    { kind: 'text', turnId: 't1', segmentId: 's1', delta: 'Done.' }
  ]
}

describe('clean feed (Task results off)', () => {
  beforeEach(async () => {
    await draw(<AssistantMessageView message={message} conversationId="conv-1" verbose={false} />)
  })

  it('shows the edit and the run as compact rows, and hides the read', () => {
    expect(has('/repo/src/a.ts')).toBe(true)
    expect(has('npm test')).toBe(true)
    expect(has('file_read')).toBe(false)
    expect(has('1: hello')).toBe(false)
  })

  it('carries the edit count and the exit code on the rows', () => {
    expect(has('+1')).toBe(true)
    expect(has('−1')).toBe(true)
    expect(has('exit 0')).toBe(true)
    expect(has('411ms')).toBe(true)
    expect(has('Run tests')).toBe(true)
  })

  it('renders the task list with its progress', () => {
    expect(has('Tasks')).toBe(true)
    expect(has('1/2 done')).toBe(true)
    expect(has('Fix the slicer')).toBe(true)
    expect(has('high')).toBe(true)
  })

  it('starts folded and opens to the red/green diff', async () => {
    expect(has('new line')).toBe(false)
    // Tapping anywhere on the row — its path here — opens it.
    await act(async () => fireEvent.press(screen.getByText('/repo/src/a.ts')))
    expect(has('new line')).toBe(true)
    expect(has('old line')).toBe(true)
  })
})

const parked: ConversationMessage = {
  ...message,
  segments: pair(
    'slow',
    'shell_exec',
    { command: 'find ~ -name x' },
    {
      status: 'checked_in',
      output: 'STILL RUNNING: `shell_exec` has been running for 2m.',
      meta: { checkIn: { handle: 'call-3', state: 'running' }, durationMs: 120_000 }
    }
  )
}

const stoppedByUser: ConversationMessage = {
  ...message,
  segments: pair(
    'halted',
    'shell_exec',
    { command: 'npm test' },
    {
      status: 'stopped',
      output: 'Tool execution was stopped by the user before it completed. No output was produced.',
      meta: { stoppedBy: 'user' }
    }
  )
}

const stoppedByModel: ConversationMessage = {
  ...message,
  segments: pair(
    'halted',
    'shell_exec',
    { command: 'find ~ -name x' },
    {
      status: 'stopped',
      output: 'call-3 (`shell_exec`) was stopped after 2m. Its output up to the stop:',
      meta: { stoppedBy: 'model', checkIn: { handle: 'call-3', state: 'stopped' } }
    }
  )
}

describe('a run the user stopped', () => {
  it('wears the stopped-by-you pill, never Failed', async () => {
    await draw(
      <AssistantMessageView message={stoppedByUser} conversationId="conv-1" verbose={false} />
    )
    expect(has('Stopped by you')).toBe(true)
    expect(has('Failed')).toBe(false)
    expect(has('Done')).toBe(false)
  })

  it('says why, once the row is open', async () => {
    await draw(<AssistantMessageView message={stoppedByUser} conversationId="conv-1" verbose />)
    expect(has('You pressed Stop before it finished.')).toBe(true)
  })
})

describe('a run the model stopped', () => {
  it('names Wolffish, not the user', async () => {
    await draw(<AssistantMessageView message={stoppedByModel} conversationId="conv-1" verbose />)
    expect(has('Stopped by Wolffish')).toBe(true)
    expect(has('Stopped by you')).toBe(false)
    expect(has('ended it early with call_stop')).toBe(true)
  })
})

describe('a checked-in run (still running)', () => {
  it('shows the still-running pill and the handle in the clean feed', async () => {
    await draw(<AssistantMessageView message={parked} conversationId="conv-1" verbose={false} />)
    expect(has('Still running')).toBe(true)
    expect(has('call-3')).toBe(true)
    expect(has('find ~ -name x')).toBe(true)
    expect(has('Done')).toBe(false)
    expect(has('Failed')).toBe(false)
  })

  it('shows them in the verbose feed too', async () => {
    await draw(<AssistantMessageView message={parked} conversationId="conv-1" verbose />)
    expect(has('Still running')).toBe(true)
    expect(has('call-3')).toBe(true)
    expect(has('shell_exec')).toBe(true)
  })
})

describe('verbose feed (Task results on)', () => {
  it('shows every tool as a full card, the task list included', async () => {
    await draw(<AssistantMessageView message={message} conversationId="conv-1" verbose />)
    expect(has('file_read')).toBe(true)
    expect(has('file_edit')).toBe(true)
    expect(has('shell_exec')).toBe(true)
    expect(has('Tasks')).toBe(true)
    // Verbose cards open expanded — the diff is already on screen.
    expect(has('new line')).toBe(true)
  })
})
