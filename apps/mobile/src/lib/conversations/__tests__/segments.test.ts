import {
  CODE_ACTIVITY_TOOLS,
  buildRenderBlocks,
  latestTodoLists,
  todoListId,
  coalesceTextSegments,
  failedTurnEnd,
  messageFilePaths,
  messageText,
  toWorkspaceRelative
} from '@/lib/conversations/segments'
import type {
  ConversationMessage,
  NoProviderAvailableInfo,
  Segment
} from '@/lib/conversations/types'

function textSeg(delta: string, id: string, worker?: { id: string }): Segment {
  return { kind: 'text', turnId: 't1', segmentId: id, delta, ...(worker ? { worker } : {}) }
}

function message(segments: Segment[], extra?: Partial<ConversationMessage>): ConversationMessage {
  return { id: 'm1', role: 'assistant', content: '', timestamp: 1, segments, ...extra }
}

describe('toWorkspaceRelative', () => {
  it('strips any absolute desktop workspace prefix', () => {
    expect(toWorkspaceRelative('/Users/x/.wolffish/workspace/files/a.pdf')).toBe('files/a.pdf')
    expect(toWorkspaceRelative('files/a.pdf')).toBe('files/a.pdf')
  })
})

describe('paths outside the workspace', () => {
  // Tool output sometimes names files the desktop cannot serve — /tmp scratch
  // frames a meme pipeline inspected, absolute paths a shell tool printed.
  // A card built for one sat as a loading placeholder retrying a download
  // that can never exist; they stay prose instead (2026-08-27).
  const toolPair = (output: string): Segment[] => [
    {
      kind: 'tool_call',
      turnId: 't1',
      segmentId: 'c1',
      toolCallId: 'call1',
      name: 'shell',
      args: {}
    },
    {
      kind: 'tool_result',
      turnId: 't1',
      segmentId: 'r1',
      toolCallId: 'call1',
      status: 'success',
      output
    }
  ]

  it('an output marker naming an unservable path emits no file card', () => {
    const outside = message(toolPair('[wolffish-output: /tmp/frame_23.png (image)]'))
    expect(buildRenderBlocks(outside).filter((b) => b.type === 'file')).toEqual([])

    const inside = message(toolPair('[wolffish-output: uploads/memes/a.gif (image)]'))
    expect(buildRenderBlocks(inside).filter((b) => b.type === 'file')).toMatchObject([
      { relPath: 'uploads/memes/a.gif' }
    ])
  })

  it('a media-only line for an unservable path renders as prose, not a card', () => {
    const outside = message([textSeg('![frame](wolffish-media:///tmp/frame_23.png)', 's1')])
    const blocks = buildRenderBlocks(outside)
    expect(blocks.filter((b) => b.type === 'media')).toEqual([])
    expect(blocks.filter((b) => b.type === 'text')).toHaveLength(1)

    const inside = message([textSeg('![meme](wolffish-media://uploads/memes/a.gif)', 's1')])
    expect(buildRenderBlocks(inside).filter((b) => b.type === 'media')).toMatchObject([
      { relPath: 'uploads/memes/a.gif' }
    ])
  })

  it('messageFilePaths never offers an unservable path to the prefetcher', () => {
    const mixed = message(
      toolPair(
        '[wolffish-output: uploads/memes/a.gif (image)] and [wolffish-output: /tmp/b.png (image)]'
      )
    )
    expect(messageFilePaths(mixed)).toEqual(['uploads/memes/a.gif'])
  })
})

describe('coalesceTextSegments', () => {
  it('merges consecutive text runs and keeps boundaries', () => {
    const out = coalesceTextSegments([
      textSeg('Hel', 's1'),
      textSeg('lo', 's2'),
      { kind: 'separator', turnId: 't1', segmentId: 's3' },
      textSeg('World', 's4')
    ])
    expect(out).toHaveLength(3)
    expect(out[0]).toMatchObject({ kind: 'text', delta: 'Hello' })
    expect(out[2]).toMatchObject({ kind: 'text', delta: 'World' })
  })

  it('never merges across different workers', () => {
    const out = coalesceTextSegments([
      textSeg('a', 's1', { id: 'w1' }),
      textSeg('b', 's2', { id: 'w2' }),
      textSeg('c', 's3')
    ])
    expect(out).toHaveLength(3)
  })
})

describe('buildRenderBlocks', () => {
  it('accumulates deltas into one text block and flushes at tool calls', () => {
    const blocks = buildRenderBlocks(
      message([
        textSeg('Hello ', 's1'),
        textSeg('world', 's2'),
        {
          kind: 'tool_call',
          turnId: 't1',
          segmentId: 's3',
          toolCallId: 'c1',
          name: 'shell_exec',
          args: { command: 'date' }
        },
        {
          kind: 'tool_result',
          turnId: 't1',
          segmentId: 's4',
          toolCallId: 'c1',
          status: 'success',
          output: '2026-07-23'
        },
        textSeg('Done.', 's5')
      ])
    )
    expect(blocks.map((block) => block.type)).toEqual(['text', 'tool', 'text'])
    expect(blocks[0]).toMatchObject({ markdown: 'Hello world' })
    const tool = blocks[1]
    if (tool.type !== 'tool') throw new Error('expected tool block')
    expect(tool.call.name).toBe('shell_exec')
    expect(tool.result?.output).toBe('2026-07-23')
  })

  it('skips worker-tagged segments and workflow orchestration tools', () => {
    const blocks = buildRenderBlocks(
      message([
        textSeg('visible', 's1'),
        textSeg('hidden', 's2', { id: 'w1' }),
        {
          kind: 'tool_call',
          turnId: 't1',
          segmentId: 's3',
          toolCallId: 'c1',
          name: 'agent_spawn',
          args: {}
        }
      ])
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'text', markdown: 'visible' })
  })

  it('extracts delivered-file markers from tool output, normalized and deduped', () => {
    const output =
      'done [wolffish-output: /Users/x/.wolffish/workspace/files/a.pdf (document)]\n' +
      '[wolffish-output: files/a.pdf (document)]'
    const blocks = buildRenderBlocks(
      message([
        {
          kind: 'tool_call',
          turnId: 't1',
          segmentId: 's1',
          toolCallId: 'c1',
          name: 'pdf_render',
          args: {}
        },
        {
          kind: 'tool_result',
          turnId: 't1',
          segmentId: 's2',
          toolCallId: 'c1',
          status: 'success',
          output
        }
      ])
    )
    const files = blocks.filter((block) => block.type === 'file')
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ relPath: 'files/a.pdf', kind: 'document' })
  })

  it('extracts chart markers — the desktop emits (chart) for .chart.json specs', () => {
    const blocks = buildRenderBlocks(
      message([
        {
          kind: 'tool_call',
          turnId: 't1',
          segmentId: 's1',
          toolCallId: 'c1',
          name: 'send_file',
          args: {}
        },
        {
          kind: 'tool_result',
          turnId: 't1',
          segmentId: 's2',
          toolCallId: 'c1',
          status: 'success',
          output: 'delivered [wolffish-output: files/q3-revenue.chart.json (chart)]'
        }
      ])
    )
    const files = blocks.filter((block) => block.type === 'file')
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ relPath: 'files/q3-revenue.chart.json', kind: 'chart' })
  })

  it('never renders markers quoted inside file-content tool output', () => {
    const blocks = buildRenderBlocks(
      message([
        {
          kind: 'tool_call',
          turnId: 't1',
          segmentId: 's1',
          toolCallId: 'c1',
          name: 'file_read',
          args: { path: 'notes.md' }
        },
        {
          kind: 'tool_result',
          turnId: 't1',
          segmentId: 's2',
          toolCallId: 'c1',
          status: 'success',
          output: 'docs say [wolffish-output: files/x.pdf (document)]'
        }
      ])
    )
    expect(blocks.filter((block) => block.type === 'file')).toHaveLength(0)
  })

  it('renders a media-only text buffer as an image block', () => {
    const blocks = buildRenderBlocks(
      message([textSeg('![meme](wolffish-media://uploads/memes/a.gif)', 's1')])
    )
    expect(blocks).toEqual([
      expect.objectContaining({ type: 'media', relPath: 'uploads/memes/a.gif' })
    ])
  })

  it('routes ask_user to a question block', () => {
    const blocks = buildRenderBlocks(
      message([
        {
          kind: 'tool_call',
          turnId: 't1',
          segmentId: 's1',
          toolCallId: 'c1',
          name: 'ask_user',
          args: { questions: [{ question: 'Which?', options: [] }] }
        }
      ])
    )
    expect(blocks[0]?.type).toBe('question')
  })

  it('routes offer_options to an options block and absorbs its result', () => {
    // The card draws from the CALL's args alone; its result is a one-line
    // confirmation written for the model, so it must not raise a tool row or
    // an orphan anchor of its own.
    const blocks = buildRenderBlocks(
      message([
        {
          kind: 'tool_call',
          turnId: 't1',
          segmentId: 's1',
          toolCallId: 'c1',
          name: 'offer_options',
          args: {
            title: 'Three ways',
            options: [
              { title: 'Plain', language: 'ts', content: 'const a = 1' },
              { title: 'Other', content: 'b' }
            ]
          }
        },
        {
          kind: 'tool_result',
          turnId: 't1',
          segmentId: 's2',
          toolCallId: 'c1',
          status: 'success',
          output:
            'Showed the user a card with 2 options they can read and copy: A. Plain, B. Other.'
        }
      ])
    )
    expect(blocks.map((b) => b.type)).toEqual(['options'])
    const block = blocks[0]
    if (block.type !== 'options') throw new Error('expected options block')
    expect(block.call.name).toBe('offer_options')
    expect(block.call.args.title).toBe('Three ways')
  })

  it('anchors an unmatched tool_result at its place in the stream', () => {
    // The clean-feed live mirror strips tool_call segments, so mid-turn a
    // parked card's result arrives with no call to pair with — the anchor
    // preserves the position for the feed to render the live card at, so
    // text streamed after the user's answer lands BELOW the card.
    const blocks = buildRenderBlocks(
      message([
        textSeg('Before. ', 's1'),
        {
          kind: 'tool_result',
          turnId: 't1',
          segmentId: 's2',
          toolCallId: 'c9',
          status: 'success',
          output: 'The user selected option 1 of 2: "Lusin" — Armenian'
        },
        textSeg('After.', 's3')
      ])
    )
    expect(blocks.map((block) => block.type)).toEqual(['text', 'toolAnchor', 'text'])
    expect(blocks[1]).toMatchObject({
      toolCallId: 'c9',
      result: expect.objectContaining({ status: 'success' })
    })
    // A result WITH its call pairs up as it always did — no anchor appears in
    // a stored body, which carries every call.
    const stored = buildRenderBlocks(
      message([
        {
          kind: 'tool_call',
          turnId: 't1',
          segmentId: 's1',
          toolCallId: 'c9',
          name: 'ask_user',
          args: { questions: [{ question: 'Which?', options: [] }] }
        },
        {
          kind: 'tool_result',
          turnId: 't1',
          segmentId: 's2',
          toolCallId: 'c9',
          status: 'success',
          output: 'The user selected option 1 of 2: "Lusin" — Armenian'
        }
      ])
    )
    expect(stored.some((block) => block.type === 'toolAnchor')).toBe(false)
  })

  it('emits turn_end only for abnormal stops or reasoning', () => {
    const clean = buildRenderBlocks(
      message([
        {
          kind: 'turn_end',
          turnId: 't1',
          segmentId: 's1',
          stopReason: 'end_turn',
          iterationCount: 1
        }
      ])
    )
    expect(clean).toHaveLength(0)
    const reasoned = buildRenderBlocks(
      message([
        {
          kind: 'turn_end',
          turnId: 't1',
          segmentId: 's1',
          stopReason: 'end_turn',
          iterationCount: 1,
          reasoningContent: 'because'
        }
      ])
    )
    expect(reasoned[0]).toMatchObject({ type: 'turnEnd', reasoningContent: 'because' })
  })

  it('emits turnEnd for a recovered turn — a clean stop still carrying providerErrors', () => {
    const blocks = buildRenderBlocks(
      message([
        {
          kind: 'turn_end',
          turnId: 't1',
          segmentId: 's1',
          stopReason: 'end_turn',
          iterationCount: 21,
          providerErrors: [
            {
              provider: 'deepseek',
              providerLogo: 'deepseek',
              statusCode: null,
              errorReason: 'offline',
              errorDetail: null,
              retriesAttempted: 1,
              totalDurationMs: 35294
            }
          ]
        }
      ])
    )
    expect(blocks[0]).toMatchObject({ type: 'turnEnd', stopReason: 'end_turn' })
  })

  it('carries providerErrors through the turnEnd block', () => {
    const failure: NoProviderAvailableInfo = {
      provider: 'anthropic',
      providerLogo: 'anthropic',
      statusCode: 529,
      errorReason: 'overloaded',
      errorDetail: 'Overloaded',
      retriesAttempted: 3,
      totalDurationMs: 45000
    }
    const blocks = buildRenderBlocks(
      message([
        {
          kind: 'turn_end',
          turnId: 't1',
          segmentId: 's1',
          stopReason: 'error',
          iterationCount: 1,
          providerErrors: [failure]
        }
      ])
    )
    expect(blocks[0]).toMatchObject({ type: 'turnEnd', providerErrors: [failure] })
  })

  it('replaces workflow snapshots by workflowId instead of appending', () => {
    const snapshot = (status: 'running' | 'completed') => ({
      workflowId: 'wf1',
      status,
      startedAt: 1,
      phases: [],
      agents: [],
      totals: {
        agents: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0
      }
    })
    const blocks = buildRenderBlocks(
      message([
        { kind: 'workflow', turnId: 't1', segmentId: 's1', snapshot: snapshot('running') },
        { kind: 'workflow', turnId: 't1', segmentId: 's2', snapshot: snapshot('completed') }
      ])
    )
    const workflows = blocks.filter((block) => block.type === 'workflow')
    expect(workflows).toHaveLength(1)
    expect(workflows[0]).toMatchObject({
      snapshot: expect.objectContaining({ status: 'completed' })
    })
  })

  it('tolerates unknown segment kinds and malformed entries', () => {
    const weird = [
      { kind: 'hologram', turnId: 't1', segmentId: 's1' },
      null,
      42,
      textSeg('ok', 's2')
    ] as unknown as Segment[]
    expect(buildRenderBlocks(message(weird))).toEqual([
      expect.objectContaining({ type: 'text', markdown: 'ok' })
    ])
  })
})

describe('messageText', () => {
  it('prefers persisted content and falls back to joined deltas', () => {
    expect(messageText(message([textSeg('a', 's1')], { content: 'full' }))).toBe('full')
    expect(messageText(message([textSeg('a', 's1'), textSeg('b', 's2')]))).toBe('ab')
  })
})

describe('messageFilePaths', () => {
  const attachment = {
    type: 'audio' as const,
    filePath: 'uploads/conv-1/voice.m4a',
    originalName: 'voice.m4a',
    mimeType: 'audio/mp4',
    sizeBytes: 10
  }

  it('collects user attachments, normalized to workspace-relative', () => {
    const user: ConversationMessage = {
      id: 'u1',
      role: 'user',
      content: 'hi',
      timestamp: 1,
      attachments: [
        attachment,
        { ...attachment, filePath: '/Users/x/.wolffish/workspace/uploads/conv-1/p.png' }
      ]
    }
    expect(messageFilePaths(user)).toEqual(['uploads/conv-1/voice.m4a', 'uploads/conv-1/p.png'])
  })

  it('collects delivered files and media from assistant segments, deduplicated', () => {
    const assistant = message([
      {
        kind: 'tool_call',
        turnId: 't1',
        segmentId: 's1',
        toolCallId: 'c1',
        name: 'send_file',
        args: {}
      },
      {
        kind: 'tool_result',
        turnId: 't1',
        segmentId: 's2',
        toolCallId: 'c1',
        status: 'success',
        output: '[wolffish-output: files/report.pdf (document)]'
      },
      textSeg('![chart](wolffish-media://files/chart.png)', 's3')
    ])
    expect(messageFilePaths(assistant)).toEqual(['files/report.pdf', 'files/chart.png'])
    // The same paths again must not double up.
    expect(messageFilePaths(assistant)).toHaveLength(2)
  })

  it('never reads segments on user messages and never throws on bare ones', () => {
    expect(messageFilePaths({ id: 'u2', role: 'user', content: 'plain', timestamp: 2 })).toEqual([])
  })
})

describe('task segments', () => {
  const taskSeg = (id: string, status: string, segId: string, outputPath?: string): Segment =>
    ({
      kind: 'task',
      turnId: 't1',
      segmentId: segId,
      snapshot: {
        taskId: id,
        kind: 'video',
        conversationId: 'c1',
        title: 'Sunset waves',
        status,
        createdAt: 1,
        updatedAt: 2,
        estimateSeconds: 220,
        ...(outputPath ? { outputPath } : {})
      }
    }) as Segment

  it('folds snapshots by taskId — one card per task, latest state wins', () => {
    const blocks = buildRenderBlocks(
      message([
        taskSeg('427', 'submitted', 's1'),
        textSeg('Waiting for the clip…', 's2'),
        taskSeg('427', 'running', 's3'),
        taskSeg('427', 'succeeded', 's4', 'generations/video/conv-c1/video-427.mp4')
      ])
    )
    const tasks = blocks.filter((b) => b.type === 'task')
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      key: 'tk:427',
      snapshot: { status: 'succeeded', outputPath: 'generations/video/conv-c1/video-427.mp4' }
    })
    // The card keeps its original position (where the task was announced).
    expect(blocks[0].type).toBe('task')
  })

  it('prefetches the finished artifact with the conversation', () => {
    const paths = messageFilePaths(
      message([taskSeg('427', 'succeeded', 's1', 'generations/video/conv-c1/video-427.mp4')])
    )
    expect(paths).toContain('generations/video/conv-c1/video-427.mp4')
  })

  it('renders two independent tasks as two cards', () => {
    const blocks = buildRenderBlocks(
      message([taskSeg('a1', 'running', 's1'), taskSeg('b2', 'queued', 's2')])
    )
    expect(blocks.filter((b) => b.type === 'task')).toHaveLength(2)
  })
})

describe('failedTurnEnd', () => {
  const end = (
    stopReason: 'end_turn' | 'error' | 'no_provider_available',
    id: string,
    providerErrors?: NoProviderAvailableInfo[]
  ): Segment => ({
    kind: 'turn_end',
    turnId: 't1',
    segmentId: id,
    stopReason,
    iterationCount: 1,
    ...(providerErrors ? { providerErrors } : {})
  })

  it('finds the failed turn_end with its providerErrors', () => {
    const failure: NoProviderAvailableInfo = {
      provider: 'openai',
      providerLogo: 'openai',
      statusCode: 401,
      errorReason: 'authentication failed',
      errorDetail: null,
      retriesAttempted: 0,
      totalDurationMs: 900
    }
    const found = failedTurnEnd(message([textSeg('partial', 's1'), end('error', 's2', [failure])]))
    expect(found).toMatchObject({ stopReason: 'error', providerErrors: [failure] })
    expect(failedTurnEnd(message([end('no_provider_available', 's1')]))).toMatchObject({
      stopReason: 'no_provider_available'
    })
  })

  it('lets a later clean turn absolve an earlier failure — the LAST turn_end decides', () => {
    const recovered = message([
      end('error', 's1'),
      { kind: 'separator', turnId: 't2', segmentId: 's2' },
      end('end_turn', 's3')
    ])
    expect(failedTurnEnd(recovered)).toBeNull()
  })

  it('is null for clean or segment-less messages', () => {
    expect(failedTurnEnd(message([end('end_turn', 's1')]))).toBeNull()
    expect(failedTurnEnd(message([textSeg('hi', 's1')]))).toBeNull()
    expect(failedTurnEnd({ role: 'assistant', content: '', timestamp: 1 })).toBeNull()
  })
})

describe('in-place reasoning', () => {
  // The desktop streams thinking as kind:'reasoning' segments (2026-08-30)
  // and dual-publishes the FINAL iteration's thinking on turn_end for
  // surfaces that predate the kind — so the feed must render the in-place
  // runs at their true positions and skip the turn_end duplicate.
  const reasoningSeg = (delta: string, id: string): Segment => ({
    kind: 'reasoning',
    turnId: 't1',
    segmentId: id,
    delta
  })

  it('renders each thinking run in place, above the prose/tools it produced', () => {
    const blocks = buildRenderBlocks(
      message([
        reasoningSeg('plan the ', 's1'),
        reasoningSeg('first step', 's2'),
        textSeg('hello', 's3'),
        {
          kind: 'tool_call',
          turnId: 't1',
          segmentId: 's4',
          toolCallId: 'c1',
          name: 'shell',
          args: {}
        },
        reasoningSeg('wrap up', 's5'),
        {
          kind: 'turn_end',
          turnId: 't1',
          segmentId: 's6',
          stopReason: 'end_turn',
          iterationCount: 2,
          reasoningContent: 'wrap up'
        }
      ])
    )
    expect(blocks.map((b) => b.type)).toEqual(['reasoning', 'text', 'tool', 'reasoning'])
    // Adjacent deltas fold into one run; the run keys off its first segment.
    expect(blocks[0]).toMatchObject({ content: 'plan the first step', key: 'rs:s1' })
    // The turn_end copy is the last run's duplicate — no turnEnd block at all
    // on a clean stop once its reasoning is suppressed.
    expect(blocks.filter((b) => b.type === 'turnEnd')).toEqual([])
  })

  it('still renders the turn_end reasoning on legacy messages without reasoning segments', () => {
    const blocks = buildRenderBlocks(
      message([
        textSeg('hello', 's1'),
        {
          kind: 'turn_end',
          turnId: 't1',
          segmentId: 's2',
          stopReason: 'end_turn',
          iterationCount: 1,
          reasoningContent: 'because'
        }
      ])
    )
    expect(blocks.map((b) => b.type)).toEqual(['text', 'turnEnd'])
    expect(blocks[1]).toMatchObject({ reasoningContent: 'because' })
  })

  it('never leaks thinking into the copy payload', () => {
    const copied = messageText(message([reasoningSeg('secret plan', 's1'), textSeg('hi', 's2')]))
    expect(copied).toBe('hi')
  })

  it('coalesces reasoning runs but never across kinds', () => {
    const folded = coalesceTextSegments([
      reasoningSeg('a', 's1'),
      reasoningSeg('b', 's2'),
      textSeg('c', 's3'),
      textSeg('d', 's4'),
      reasoningSeg('e', 's5')
    ])
    expect(
      folded.map((s) =>
        s.kind === 'text' || s.kind === 'reasoning' ? `${s.kind}:${s.delta}` : s.kind
      )
    ).toEqual(['reasoning:ab', 'text:cd', 'reasoning:e'])
  })
})

describe('code activity: result meta and the task list', () => {
  const edit = (meta?: Record<string, unknown>): Segment[] => [
    {
      kind: 'tool_call',
      turnId: 't1',
      segmentId: 'c1',
      toolCallId: 'call1',
      name: 'file_edit',
      args: { path: '/repo/src/a.ts' }
    },
    {
      kind: 'tool_result',
      turnId: 't1',
      segmentId: 'r1',
      toolCallId: 'call1',
      status: 'success',
      output: 'edited',
      ...(meta ? { meta } : {})
    } as Segment
  ]

  it('carries the diff, exit code and duration onto the tool block', () => {
    const meta = {
      diff: { path: '/repo/src/a.ts', patch: '@@ -1 +1 @@\n-a\n+b', additions: 1, deletions: 1 },
      exitCode: 0,
      durationMs: 42,
      label: 'Edit'
    }
    const blocks = buildRenderBlocks(message(edit(meta)))
    expect(blocks[0]).toMatchObject({ type: 'tool', result: { status: 'success', meta } })
  })

  it('leaves meta off a result that has none', () => {
    const blocks = buildRenderBlocks(message(edit()))
    const block = blocks[0]
    expect(block.type).toBe('tool')
    if (block.type === 'tool') expect(block.result).not.toHaveProperty('meta')
  })

  it('folds every todo write of a turn into one card, in its latest state', () => {
    const blocks = buildRenderBlocks(
      message([
        textSeg('Starting.', 's1'),
        {
          kind: 'todo',
          turnId: 't1',
          segmentId: 'd1',
          items: [{ content: 'a', status: 'pending' }]
        },
        textSeg('Working.', 's2'),
        {
          kind: 'todo',
          turnId: 't1',
          segmentId: 'd2',
          items: [
            { content: 'a', status: 'completed' },
            { content: 'b', status: 'in_progress' }
          ]
        }
      ])
    )
    expect(blocks.map((block) => block.type)).toEqual(['text', 'todo', 'text'])
    expect(blocks[1]).toEqual({
      type: 'todo',
      key: 'td:t1',
      items: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' }
      ]
    })
  })

  it('keeps one card per turn across turns', () => {
    const blocks = buildRenderBlocks(
      message([
        {
          kind: 'todo',
          turnId: 't1',
          segmentId: 'd1',
          items: [{ content: 'a', status: 'pending' }]
        },
        { kind: 'separator', turnId: 't1', segmentId: 'sep' },
        {
          kind: 'todo',
          turnId: 't2',
          segmentId: 'd2',
          items: [{ content: 'b', status: 'pending' }]
        }
      ])
    )
    expect(blocks.filter((block) => block.type === 'todo').map((block) => block.key)).toEqual([
      'td:t1',
      'td:t2'
    ])
  })

  it('names the code tools the clean feed keeps', () => {
    expect([...CODE_ACTIVITY_TOOLS].sort()).toEqual([
      'file_edit',
      'file_patch',
      'file_write',
      'shell_exec'
    ])
  })
})

describe('a task list continued by a later turn', () => {
  const open: Segment = {
    kind: 'todo',
    turnId: 't1',
    segmentId: 'd1',
    items: [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' }
    ]
  }
  const continued: Segment = {
    kind: 'todo',
    turnId: 't2',
    segmentId: 'd2',
    listId: 't1',
    items: [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' }
    ]
  }
  const first = message([textSeg('Working.', 's1'), open])
  const second = { ...message([textSeg('Done.', 's2'), continued]), id: 'm2' }

  it('names the original list on a continuation', () => {
    expect(todoListId(open)).toBe('t1')
    expect(todoListId(continued)).toBe('t1')
  })

  it('collects the latest state per list across messages', () => {
    const lists = latestTodoLists([first, second])
    expect([...lists.keys()]).toEqual(['t1'])
    expect(lists.get('t1')).toBe(continued.items)
  })

  it('draws the card once, on the creating turn, in the latest state', () => {
    const lists = latestTodoLists([first, second])
    const firstBlocks = buildRenderBlocks(first, { todoLists: lists })
    expect(firstBlocks.map((b) => b.type)).toEqual(['text', 'todo'])
    expect(firstBlocks[1]).toEqual({ type: 'todo', key: 'td:t1', items: continued.items })
    const secondBlocks = buildRenderBlocks(second, { todoLists: lists })
    expect(secondBlocks.map((b) => b.type)).toEqual(['text'])
  })

  it('without the map a card shows its own write', () => {
    expect(buildRenderBlocks(first)[1]).toEqual({ type: 'todo', key: 'td:t1', items: open.items })
  })
})

describe('process card segments', () => {
  const snap = (state: 'running' | 'stopped') => ({
    cardId: 'card-1',
    conversationId: 'c1',
    turnId: 't1',
    title: null,
    names: ['web-dev'],
    processes: [
      {
        id: 'p1',
        name: 'web-dev',
        command: 'npm run dev -- -p {port}',
        cwd: '/proj',
        env: {},
        port: { mode: 'wolffish' as const },
        ready: {},
        restart: 'on-failure' as const,
        onQuit: 'keep' as const,
        autostart: 'off' as const,
        origin: { conversationId: 'c1', kind: 'started' as const },
        createdAt: 1,
        updatedAt: 1,
        run: {
          pid: 1,
          signature: 'npm',
          osStart: null,
          port: 20001,
          url: 'http://localhost:20001',
          state,
          exitCode: null,
          exitSignal: null,
          startedAt: 1,
          readyAt: 1,
          endedAt: null,
          restarts: 0,
          logPath: null,
          unit: null,
          adoptedAt: null,
          lastError: null
        }
      }
    ],
    createdAt: 1,
    updatedAt: 1
  })

  it('folds by cardId so two snapshots of one card render once, in the latest state', () => {
    const blocks = buildRenderBlocks(
      message([
        textSeg('before', 's1'),
        { kind: 'process', turnId: 't1', segmentId: 's2', snapshot: snap('running') },
        { kind: 'process', turnId: 't1', segmentId: 's3', snapshot: snap('stopped') },
        textSeg('after', 's4')
      ])
    )
    const cards = blocks.filter((b) => b.type === 'process')
    expect(cards).toHaveLength(1)
    expect(cards[0].type === 'process' && cards[0].snapshot.processes[0].run.state).toBe('stopped')
    // It sits where the card was first shown, between the two text bubbles.
    expect(blocks.map((b) => b.type)).toEqual(['text', 'process', 'text'])
  })
})
