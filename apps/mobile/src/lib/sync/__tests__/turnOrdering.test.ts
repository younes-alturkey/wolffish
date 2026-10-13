jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * What the feed SHOWS, frame by frame, as a turn arrives over the tunnel.
 *
 * Every other test here checks a value. This one checks a sequence, because
 * the bug it exists to prevent was never visible in any single value: each
 * state the chat screen passed through was individually defensible, and the
 * order they came in made the reply appear, vanish, and come back. The
 * complaint was "no blanks, no come and go" — so the assertions are exactly
 * that, applied to every intermediate frame rather than the final one:
 *
 *   · once a turn is in flight the feed is never empty
 *   · a row that has appeared never disappears (until its stored copy
 *     replaces it, which is the same row, not a gap)
 *   · the assistant's text only ever grows
 *   · nothing is ever on screen twice
 *
 * Frames are rendered through the real `buildRenderBlocks`, under the real
 * clean/verbose gate, so what is asserted is what the eye gets: a thinking
 * bubble, a text bubble, a tool card — not the shape of a message object.
 *
 * The desktop half is scripted from the real one: the exact events
 * channels/mobile/channel.ts and index.ts emit, in the orders they can emit
 * them in — including the two that caused this (a bare nudge mid-turn, and
 * `turn.status: done` overtaking the disk write it announces).
 */

import type { ConversationMessage, Segment } from '@/lib/conversations/types'

// ---------------------------------------------------------------- fixtures

/** The desktop's disk for one conversation — what a body fetch would return. */
const mockDesktop: { messages: ConversationMessage[] } = { messages: [] }

/** This phone's SQLite copy, and the query cache the screen reads from. */
const mockPhone: { messages: ConversationMessage[] } = { messages: [] }
let mockCached: ConversationMessage[] | undefined

const mockBodyFetches: number[] = []

jest.mock('@/lib/sync/sync', () => ({
  // The real one DELETEs the conversation's rows and re-inserts the desktop's
  // — reconcile.test.ts covers that SQL. What matters here is the consequence:
  // whatever the desktop has NOT saved yet is gone from the phone afterwards.
  fetchConversationBody: jest.fn(async () => {
    mockBodyFetches.push(Date.now())
    mockPhone.messages = mockDesktop.messages.map((m) => ({ ...m }))
    return true
  })
}))

jest.mock('@/lib/conversations/cache', () => ({
  invalidateConversation: jest.fn(() => {
    mockCached = mockPhone.messages.map((m) => ({ ...m }))
  }),
  invalidateConversationList: jest.fn(),
  refetchConversation: jest.fn(async () => {
    mockCached = mockPhone.messages.map((m) => ({ ...m }))
  }),
  conversationHasMessage: (_id: string, messageId: string) =>
    (mockCached ?? []).some((message) => message.id === messageId)
}))

jest.mock('@/lib/i18n', () => ({ __esModule: true, default: { t: (key: string) => key } }))

const mockDb = {
  runAsync: jest.fn(async () => undefined),
  execAsync: jest.fn(async () => undefined),
  getFirstAsync: jest.fn(async () => ({ next: 0 })),
  getAllAsync: jest.fn(async () => []),
  withExclusiveTransactionAsync: jest.fn(async (fn: (tx: unknown) => Promise<void>) => {
    await fn(mockDb)
  })
}
jest.mock('@/lib/db/database', () => ({ getDb: () => Promise.resolve(mockDb) }))

type EventHandler = (payload: unknown) => void
const mockHandlers = new Map<string, EventHandler>()
const mockRpc = jest.fn()

jest.mock('@/lib/tunnel/client', () => ({
  tunnelClient: {
    get active() {
      return {
        rpc: mockRpc,
        onEvent: (topic: string, handler: EventHandler) => mockHandlers.set(topic, handler)
      }
    },
    connected: true
  }
}))

import { buildFeed } from '@/lib/conversations/feed'
import { buildRenderBlocks } from '@/lib/conversations/segments'
import { attachTurnStream, sendPrompt } from '@/lib/sync/prompt'
import { useChatRuntime } from '@/state/chatRuntime'

const CONVERSATION = 'conv-1'

function emit(topic: string, payload: unknown): void {
  mockHandlers.get(topic)?.(payload)
}

/** Let every promise chain the handlers kicked off run to completion. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

/**
 * Let the inbound stream batching window close (prompt.ts pools deltas and
 * mirrors for a few frames so a backlog fast-forwards instead of replaying
 * word by word). A frame is what the eye gets AFTER the window; boundaries —
 * nudges, turn.status, settles — flush it synchronously and need no wait.
 */
async function streamed(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60))
}

// ------------------------------------------------------------------ render

/**
 * One line per row, describing what that row draws — the same decisions
 * AssistantMessageView makes, so a frame here is a frame there.
 */
function describeBlock(block: ReturnType<typeof buildRenderBlocks>[number]): string {
  switch (block.type) {
    case 'text':
      return `text(${block.markdown})`
    case 'tool':
      return `tool(${block.call.name}${block.result ? ':done' : ':running'})`
    case 'file':
      return `file(${block.relPath})`
    case 'task':
      return `task(${block.snapshot.status})`
    default:
      return block.type
  }
}

function render(
  screen: { pendingUser?: ConversationMessage | null; sending?: boolean; conversationId?: string },
  verbose = false
): string[] {
  const live = screen.conversationId
    ? useChatRuntime.getState().streams[screen.conversationId]
    : undefined
  return buildFeed({
    messages: screen.conversationId ? mockCached : undefined,
    live,
    pendingUser: screen.pendingUser,
    sending: screen.sending
  }).map((item) => {
    if (item.message.role === 'user') return `user(${item.message.content})`
    const blocks = buildRenderBlocks(item.message).filter((block) =>
      block.type === 'tool' || block.type === 'model' || block.type === 'compaction'
        ? verbose
        : true
    )
    if (item.streaming && blocks.every((block) => block.type !== 'text')) return 'assistant(…)'
    return `assistant(${blocks.map(describeBlock).join(' + ')})`
  })
}

// -------------------------------------------------------------- invariants

/**
 * The four complaints, as assertions over a whole recording.
 *
 * `assistantText` is compared as a prefix chain rather than for equality: text
 * is allowed to grow and only to grow. A frame whose text is not an extension
 * of the previous frame's means something was rewritten or dropped mid-answer,
 * which is the "it went away" symptom whatever produced it.
 */
function expectSmooth(frames: string[][]): void {
  let previousText = ''
  let sawRows = false
  const faults: string[] = []
  for (const [index, rows] of frames.entries()) {
    const at = `frame ${index} ${JSON.stringify(rows)}`
    if (sawRows && rows.length === 0) faults.push(`${at} went blank`)
    if (rows.length) sawRows = true
    if (new Set(rows).size !== rows.length) faults.push(`${at} has a duplicate row`)

    const assistant = rows.find((row) => row.startsWith('assistant('))
    const text = /text\(([^)]*)\)/.exec(assistant ?? '')?.[1] ?? ''
    if (previousText && text && !text.startsWith(previousText)) {
      faults.push(`${at} rewrote "${previousText}"`)
    }
    if (text) previousText = text
  }
  expect(faults).toEqual([])
}

/** Every row present in an earlier frame is still present later. */
function expectNoRowLost(frames: string[][]): void {
  const users = frames.map((rows) => rows.filter((row) => row.startsWith('user(')))
  const faults: string[] = []
  for (let i = 1; i < users.length; i += 1) {
    for (const row of users[i - 1]) {
      if (!users[i].includes(row)) faults.push(`frame ${i} lost ${row}`)
    }
  }
  expect(faults).toEqual([])
}

/**
 * A conversation already on this phone: the desktop's copy and the query cache
 * holding the same thing, which is the state any conversation opened from
 * History is in.
 */
function seed(messages: ConversationMessage[]): void {
  mockDesktop.messages = messages.map((m) => ({ ...m }))
  mockPhone.messages = messages.map((m) => ({ ...m }))
  mockCached = messages.map((m) => ({ ...m }))
}

// ------------------------------------------------------------------- setup

function textSegment(id: string, delta: string): Segment {
  return { kind: 'text', turnId: 't1', segmentId: id, delta }
}

beforeEach(() => {
  mockDesktop.messages = []
  mockPhone.messages = []
  mockCached = undefined
  mockBodyFetches.length = 0
  mockHandlers.clear()
  mockRpc.mockReset()
  useChatRuntime.setState({ streams: {}, cards: {} })
  attachTurnStream()
})

describe('a turn started from this phone', () => {
  it('shows the prompt and the thinking words from the tap, through to the saved reply', async () => {
    const frames: string[][] = []
    // The chat screen's send sequence, modelled exactly: local state first, in
    // the same tick as the tap, then the round trip.
    const screen: {
      pendingUser: ConversationMessage | null
      sending: boolean
      conversationId?: string
    } = { pendingUser: null, sending: false }

    let resolveSend: (value: { conversationId: string }) => void = () => undefined
    mockRpc.mockImplementation(
      () => new Promise<{ conversationId: string }>((resolve) => (resolveSend = resolve))
    )

    screen.pendingUser = { id: 'm_1_aaaaaa', role: 'user', content: 'hello', timestamp: 1 }
    screen.sending = true
    const sent = sendPrompt({ conversationId: null, text: 'hello' })
    frames.push(render(screen)) // the tap

    // ... the desktop is still minting a conversation. Nothing has come back.
    await flush()
    frames.push(render(screen))

    resolveSend({ conversationId: CONVERSATION })
    await sent
    screen.pendingUser = null
    screen.sending = false
    screen.conversationId = CONVERSATION
    frames.push(render(screen)) // id in hand

    // The desktop persists the prompt and starts the turn.
    mockDesktop.messages.push({ id: 'm_1_aaaaaa', role: 'user', content: 'hello', timestamp: 1 })
    emit('turn.status', { conversationId: CONVERSATION, state: 'started' })
    frames.push(render(screen))

    // Text streams in as deltas.
    for (const delta of ['Hel', 'lo ', 'there']) {
      emit('message.delta', { conversationId: CONVERSATION, text: delta })
      await streamed()
      frames.push(render(screen))
    }

    // A throttled full snapshot lands, carrying the same words plus structure.
    emit('message.appended', {
      conversationId: CONVERSATION,
      message: {
        id: 'm_2_bbbbbb',
        role: 'assistant',
        content: 'Hello there',
        timestamp: 2,
        segments: [textSegment('s1', 'Hello there')]
      }
    })
    await streamed()
    frames.push(render(screen))

    // A bare nudge lands mid-turn — the video-task write-through sends one,
    // and every desktop before this change sent one per tool segment. Acting
    // on it fetches the transcript from BEFORE this turn.
    emit('message.appended', { conversationId: CONVERSATION })
    await flush()
    frames.push(render(screen))

    // ... and more deltas after it.
    emit('message.delta', { conversationId: CONVERSATION, text: ', friend' })
    await streamed()
    frames.push(render(screen))

    // The turn ends: the desktop saved first, then announced.
    mockDesktop.messages.push({
      id: 'm_2_bbbbbb',
      role: 'assistant',
      content: 'Hello there, friend',
      timestamp: 2,
      segments: [textSegment('s1', 'Hello there, friend')]
    })
    emit('turn.status', { conversationId: CONVERSATION, state: 'done' })
    await flush()
    frames.push(render(screen))

    expectSmooth(frames)
    expectNoRowLost(frames)

    // The tap already shows both rows — this is the "I see nothing when I send
    // a prompt" case, and it is the first frame that has to be right.
    expect(frames[0]).toEqual(['user(hello)', 'assistant(…)'])
    expect(frames[1]).toEqual(['user(hello)', 'assistant(…)'])
    expect(frames[2]).toEqual(['user(hello)', 'assistant(…)'])
    // The assistant row, frame by frame: thinking until there are words, then
    // words that only ever grow. No gap anywhere in the column.
    expect(frames.map((rows) => rows[1])).toEqual([
      'assistant(…)', // the tap
      'assistant(…)', // waiting on the desktop
      'assistant(…)', // id in hand
      'assistant(…)', // turn started
      'assistant(text(Hel))',
      'assistant(text(Hello))',
      'assistant(text(Hello there))',
      'assistant(text(Hello there))', // the snapshot carries the same words
      'assistant(text(Hello there))', // the bare nudge changes nothing
      'assistant(text(Hello there, friend))', // ... and the deltas resume on top
      'assistant(text(Hello there, friend))' // settled, now from the stored copy
    ])
    // Settled: one user row, one assistant row, both from the stored copy.
    expect(frames.at(-1)).toEqual(['user(hello)', 'assistant(text(Hello there, friend))'])
    expect(useChatRuntime.getState().streams[CONVERSATION]).toBeUndefined()
  })

  it('holds the reply on screen when done overtakes the desktop save', async () => {
    // The real race. `turn.status: done` comes from the turn runner's lifecycle
    // listener, the save from the channel sink — two paths, no ordering between
    // them — so the first body fetch after `done` can return a transcript that
    // stops before the answer. Releasing the live row on that fetch is what
    // made the reply blink out at the very end of a turn.
    const screen = { conversationId: CONVERSATION }
    const frames: string[][] = []
    seed([{ id: 'm_1_aaaaaa', role: 'user', content: 'hi', timestamp: 1 }])

    emit('turn.status', { conversationId: CONVERSATION, state: 'started' })
    emit('message.appended', {
      conversationId: CONVERSATION,
      message: {
        id: 'm_2_bbbbbb',
        role: 'assistant',
        content: 'the answer',
        timestamp: 2,
        segments: [textSegment('s1', 'the answer')]
      }
    })
    await streamed()
    frames.push(render(screen))

    // done, but the disk write has not landed.
    emit('turn.status', { conversationId: CONVERSATION, state: 'done' })
    await flush()
    frames.push(render(screen))
    expect(frames.at(-1)).toEqual(['user(hi)', 'assistant(text(the answer))'])

    // The save completes and the desktop nudges. Now the fetch has something.
    mockDesktop.messages.push({
      id: 'm_2_bbbbbb',
      role: 'assistant',
      content: 'the answer',
      timestamp: 2,
      segments: [textSegment('s1', 'the answer')]
    })
    emit('message.appended', { conversationId: CONVERSATION })
    await flush()
    frames.push(render(screen))

    expectSmooth(frames)
    expect(frames.at(-1)).toEqual(['user(hi)', 'assistant(text(the answer))'])
    expect(useChatRuntime.getState().streams[CONVERSATION]).toBeUndefined()
  })

  it('ignores a bare nudge mid-turn instead of refetching over the answer', async () => {
    // index.ts pushes an id-less `message.appended` from the video-task
    // write-through, and an older mockDesktop pushes one per tool segment. Acting
    // on it mid-turn fetches the pre-turn transcript — the exact wipe.
    const screen = { conversationId: CONVERSATION }
    seed([{ id: 'm_1_aaaaaa', role: 'user', content: 'hi', timestamp: 1 }])
    emit('turn.status', { conversationId: CONVERSATION, state: 'started' })
    emit('message.delta', { conversationId: CONVERSATION, text: 'half an ans' })
    await streamed()
    const before = render(screen)

    emit('message.appended', { conversationId: CONVERSATION })
    await flush()

    expect(render(screen)).toEqual(before)
    expect(render(screen)).toContain('assistant(text(half an ans))')
    expect(mockBodyFetches).toHaveLength(0)
  })

  it('renders tool and task cards in the order the desktop wrote them', async () => {
    // Verbose on: the mockPhone draws the same cards the mockDesktop's own feed does,
    // from the snapshots, in the sequence they were produced.
    const screen = { conversationId: CONVERSATION }
    seed([{ id: 'm_1_aaaaaa', role: 'user', content: 'make a video', timestamp: 1 }])
    emit('turn.status', { conversationId: CONVERSATION, state: 'started' })

    const segments: Segment[] = [textSegment('s1', 'On it.')]
    const snapshot = (): void =>
      emit('message.appended', {
        conversationId: CONVERSATION,
        message: {
          id: 'm_2_bbbbbb',
          role: 'assistant',
          content: 'On it.',
          timestamp: 2,
          segments: [...segments]
        }
      })

    snapshot()
    await streamed()
    expect(render(screen, true)).toEqual(['user(make a video)', 'assistant(text(On it.))'])

    segments.push({
      kind: 'tool_call',
      turnId: 't1',
      segmentId: 's2',
      toolCallId: 'c1',
      name: 'video_generate',
      args: {}
    })
    snapshot()
    await streamed()
    expect(render(screen, true)).toEqual([
      'user(make a video)',
      'assistant(text(On it.) + tool(video_generate:running))'
    ])

    segments.push({
      kind: 'tool_result',
      turnId: 't1',
      segmentId: 's3',
      toolCallId: 'c1',
      status: 'success',
      output: 'queued'
    })
    snapshot()
    await streamed()
    expect(render(screen, true)).toEqual([
      'user(make a video)',
      'assistant(text(On it.) + tool(video_generate:done))'
    ])
  })

  it('re-settles a turn the phone was disconnected through', async () => {
    // The phone drops mid-turn and the turn finishes without it, so the
    // terminal event is never delivered. Reconnecting re-attaches the stream,
    // and every turn still believed to be running is re-checked against the
    // desktop rather than left rotating.
    const screen = { conversationId: CONVERSATION }
    seed([{ id: 'm_1_aaaaaa', role: 'user', content: 'hi', timestamp: 1 }])
    emit('turn.status', { conversationId: CONVERSATION, state: 'started' })
    expect(render(screen)).toEqual(['user(hi)', 'assistant(…)'])

    // ... away. The desktop finishes and saves.
    mockDesktop.messages.push({
      id: 'm_2_bbbbbb',
      role: 'assistant',
      content: 'finished while you were away',
      timestamp: 2,
      segments: [textSegment('s1', 'finished while you were away')]
    })
    attachTurnStream() // what a reconnect does
    await flush()

    expect(render(screen)).toEqual(['user(hi)', 'assistant(text(finished while you were away))'])
    expect(useChatRuntime.getState().streams[CONVERSATION]).toBeUndefined()
  })

  it('takes the thinking words down when a turn ends without writing anything', async () => {
    // Aborted before its first segment: nothing to persist, so no stored
    // message will ever match the live row. It has to come down on the settle
    // rather than sit there rotating forever.
    const screen = { conversationId: CONVERSATION }
    seed([{ id: 'm_1_aaaaaa', role: 'user', content: 'hi', timestamp: 1 }])
    emit('turn.status', { conversationId: CONVERSATION, state: 'started' })
    expect(render(screen)).toEqual(['user(hi)', 'assistant(…)'])

    emit('turn.status', { conversationId: CONVERSATION, state: 'canceled' })
    await flush()

    expect(render(screen)).toEqual(['user(hi)'])
    expect(useChatRuntime.getState().streams[CONVERSATION]).toBeUndefined()
  })

  it('keeps the prompt visible when the desktop has not echoed it back yet', async () => {
    // A body fetch mid-flight returns the conversation WITHOUT the prompt (the
    // mockDesktop persists it a moment after answering the RPC). The optimistic row
    // is not in SQLite to be deleted — it is in the live turn, and it stays.
    mockRpc.mockResolvedValue({ conversationId: CONVERSATION })
    await sendPrompt({ conversationId: CONVERSATION, text: 'are you there' })
    mockCached = [] // an empty body landed
    expect(render({ conversationId: CONVERSATION })).toEqual([
      'user(are you there)',
      'assistant(…)'
    ])

    // Once the desktop's copy arrives — under the id the phone sent — the row
    // is replaced, not joined.
    mockCached = [{ id: sentMessageId(), role: 'user', content: 'are you there', timestamp: 9 }]
    expect(render({ conversationId: CONVERSATION })).toEqual([
      'user(are you there)',
      'assistant(…)'
    ])
  })
})

/** The id the phone minted and handed to the desktop with the prompt. */
function sentMessageId(): string {
  const id = useChatRuntime.getState().streams[CONVERSATION]?.user?.id
  expect(id).toMatch(/^m_\d+_[0-9a-f]{6}$/)
  expect(mockRpc).toHaveBeenCalledWith(
    'desktop.chat.send',
    expect.objectContaining({ messageId: id })
  )
  return id as string
}

describe('rows the renderer has to survive', () => {
  it('draws a stored message that has prose but no segments', () => {
    // Every message the DESKTOP writes carries segments, so this looks like a
    // case that cannot happen — but the phone writes its own offline reply,
    // and it has none. Rendered off segments alone it was an empty bubble with
    // a copy button under it.
    mockCached = [
      { id: 'm_9_ffffff', role: 'assistant', content: 'No desktop to answer.', timestamp: 9 }
    ]
    expect(render({ conversationId: CONVERSATION })).toEqual([
      'assistant(text(No desktop to answer.))'
    ])
  })

  it('never shows the same message twice while the overlay and the store overlap', () => {
    // The window the whole design exists to make harmless: both halves holding
    // the same message at once. The merge is by id, so this is a no-op rather
    // than a race to get right.
    const message: ConversationMessage = {
      id: 'm_2_bbbbbb',
      role: 'assistant',
      content: 'done',
      timestamp: 2,
      segments: [textSegment('s1', 'done')]
    }
    mockCached = [{ id: 'm_1_aaaaaa', role: 'user', content: 'hi', timestamp: 1 }, message]
    useChatRuntime.getState().putStream(CONVERSATION, {
      message,
      base: message,
      tail: '',
      status: 'complete',
      user: { id: 'm_1_aaaaaa', role: 'user', content: 'hi', timestamp: 1 }
    })
    expect(render({ conversationId: CONVERSATION })).toEqual(['user(hi)', 'assistant(text(done))'])
  })

  it('keeps the live row under one key as it turns from thinking into text', () => {
    // The typed thinking words are stateful; a key that changed when the
    // desktop finally named the message would remount the row and restart
    // them mid-turn.
    useChatRuntime.getState().putStream(CONVERSATION, {
      message: { role: 'assistant', content: '', timestamp: 1 },
      status: 'streaming'
    })
    const thinking = buildFeed({ live: useChatRuntime.getState().streams[CONVERSATION] })
    useChatRuntime.getState().putStream(CONVERSATION, {
      message: {
        id: 'm_2_bbbbbb',
        role: 'assistant',
        content: 'x',
        timestamp: 1,
        segments: [textSegment('s1', 'x')]
      },
      status: 'streaming'
    })
    const writing = buildFeed({ live: useChatRuntime.getState().streams[CONVERSATION] })
    expect(thinking.at(-1)?.key).toBe(writing.at(-1)?.key)
  })
})

describe('a turn started on the desktop', () => {
  /**
   * The reported bug, replayed from the logs that found it.
   *
   * A conversation was running on the desktop; the phone paired 21 seconds in
   * and opened it. The body it fetched was the honest truth on disk — an in-app
   * turn writes its user message only when it folds — so for nearly three
   * minutes the phone showed the answer being written under no question at all,
   * and the prompt only appeared when the whole transcript landed at the end.
   *
   * The mirror is the only signal a late joiner ever receives, which is why the
   * prompt has to ride it rather than be announced once at the start.
   */
  const PROMPT = { id: 'm_9_ccccc1', role: 'user' as const, content: 'make me a pdf', timestamp: 9 }

  /** The pre-turn transcript: all the desktop has saved while the turn runs. */
  function seedMidTurn(): void {
    seed([
      { id: 'm_1_aaaaaa', role: 'user', content: 'first question', timestamp: 1 },
      { id: 'm_2_bbbbbb', role: 'assistant', content: 'first answer', timestamp: 2 }
    ])
  }

  it('shows the prompt from the first mirror, before the desktop has saved it', async () => {
    const screen = { conversationId: CONVERSATION }
    const frames: string[][] = []
    seedMidTurn()

    // The phone joined mid-turn: no `turn.status: started` was ever delivered,
    // so a mirror snapshot is the first it hears of any of this.
    frames.push(render(screen))
    emit('message.appended', {
      conversationId: CONVERSATION,
      userMessage: PROMPT,
      message: {
        id: 'm_9_ccccc2',
        role: 'assistant',
        content: 'Building the PDF',
        timestamp: 9,
        segments: [textSegment('s1', 'Building the PDF')]
      }
    })
    await streamed()
    frames.push(render(screen))

    // THE ASSERTION. Without the prompt on the mirror this row is absent and
    // the answer stands alone — which is exactly what the user saw.
    expect(frames.at(-1)).toEqual([
      'user(first question)',
      'assistant(text(first answer))',
      'user(make me a pdf)',
      'assistant(text(Building the PDF))'
    ])

    // The turn folds: BOTH messages reach disk together, in one write.
    mockDesktop.messages.push(PROMPT, {
      id: 'm_9_ccccc2',
      role: 'assistant',
      content: 'Building the PDF. Done.',
      timestamp: 9,
      segments: [textSegment('s1', 'Building the PDF. Done.')]
    })
    emit('turn.status', { conversationId: CONVERSATION, state: 'done' })
    await flush()
    frames.push(render(screen))

    expectSmooth(frames)
    expectNoRowLost(frames)
    // Handed over, not joined: the stored prompt replaces the mirrored one
    // under the same id rather than appearing beside it.
    expect(frames.at(-1)).toEqual([
      'user(first question)',
      'assistant(text(first answer))',
      'user(make me a pdf)',
      'assistant(text(Building the PDF. Done.))'
    ])
    expect(useChatRuntime.getState().streams[CONVERSATION]).toBeUndefined()
  })

  it('still delivers the prompt when the answer was too big to mirror', async () => {
    // The conversation this was found in streamed 400–515 KB assistant
    // snapshots, past the 384 KB budget, so every mirror degraded to a bare
    // nudge. The prompt is a couple of hundred bytes and must not go down with
    // them — those long turns are where the missing question shows most.
    const screen = { conversationId: CONVERSATION }
    seedMidTurn()

    emit('message.appended', { conversationId: CONVERSATION, userMessage: PROMPT })
    await flush()

    expect(render(screen)).toEqual([
      'user(first question)',
      'assistant(text(first answer))',
      'user(make me a pdf)',
      'assistant(…)'
    ])
    // Still a nudge: it must not pull the pre-turn body over a running turn.
    expect(mockBodyFetches).toHaveLength(0)
  })

  it('shows the prompt before the first token, not at the first snapshot', () => {
    // The desktop emits one prompt-only mirror at send. Without it the phone
    // renders thinking words under nothing at all for the whole first-token
    // wait, which on a long tool-heavy turn is many seconds.
    const screen = { conversationId: CONVERSATION }
    seedMidTurn()
    emit('turn.status', { conversationId: CONVERSATION, state: 'started' })
    expect(render(screen)).toEqual([
      'user(first question)',
      'assistant(text(first answer))',
      'assistant(…)'
    ])

    emit('message.appended', { conversationId: CONVERSATION, userMessage: PROMPT })
    expect(render(screen)).toEqual([
      'user(first question)',
      'assistant(text(first answer))',
      'user(make me a pdf)',
      'assistant(…)'
    ])
  })

  it('does not re-publish the prompt on every tick', () => {
    // A mirror arrives twice a second for the length of the turn. Rewriting the
    // live entry each time would wake the feed for nothing.
    seedMidTurn()
    emit('message.appended', { conversationId: CONVERSATION, userMessage: PROMPT })
    const first = useChatRuntime.getState().streams[CONVERSATION]
    emit('message.appended', { conversationId: CONVERSATION, userMessage: PROMPT })
    expect(useChatRuntime.getState().streams[CONVERSATION]).toBe(first)
  })

  it('ignores a mirrored prompt with no id', () => {
    // The feed drops this row against the stored copy's id. One without an id
    // could never be dropped — it would sit under the answer for good, which is
    // worse than the gap being closed. The wire is data, not policy.
    seedMidTurn()
    emit('message.appended', {
      conversationId: CONVERSATION,
      userMessage: { role: 'user', content: 'no id here', timestamp: 9 }
    })
    expect(render({ conversationId: CONVERSATION })).toEqual([
      'user(first question)',
      'assistant(text(first answer))'
    ])
    emit('message.appended', {
      conversationId: CONVERSATION,
      userMessage: { id: 'm_9_ccccc1', role: 'assistant', content: 'wrong role', timestamp: 9 }
    })
    expect(render({ conversationId: CONVERSATION })).toEqual([
      'user(first question)',
      'assistant(text(first answer))'
    ])
  })

  it('keeps rendering the live mirror when a mid-run body fetch brings a progress snapshot', async () => {
    // An automation persists its answer-so-far WHILE it runs (that is what
    // lets a run survive a quit), under the same message id the mirror
    // streams. Opening the conversation mid-run fetches that body — so the
    // stored transcript now holds a STALE copy of the live message. The feed
    // must keep drawing the mirror: rendering the stored copy froze the
    // answer at whatever the fetch happened to catch, for the rest of the run.
    const screen = { conversationId: CONVERSATION }
    const frames: string[][] = []

    // The run begins on the desktop: shell on disk, `started` pushed.
    mockDesktop.messages = [PROMPT]
    emit('turn.status', { conversationId: CONVERSATION, state: 'started' })

    // Mirror ticks arrive; the desktop also persists a progress snapshot.
    emit('message.appended', {
      conversationId: CONVERSATION,
      userMessage: PROMPT,
      message: {
        id: 'm_9_ccccc2',
        role: 'assistant',
        content: 'Building',
        timestamp: 9,
        segments: [textSegment('s1', 'Building')]
      }
    })
    await streamed()
    mockDesktop.messages.push({
      id: 'm_9_ccccc2',
      role: 'assistant',
      content: 'Building',
      timestamp: 9,
      segments: [textSegment('s1', 'Building')]
    })

    // The user opens the conversation NOW: the body fetch returns the shell
    // plus that snapshot. (The chat screen's query does this fetch; here its
    // effect on the cache is applied directly.)
    mockCached = mockDesktop.messages.map((m) => ({ ...m }))
    frames.push(render(screen))

    // The turn keeps writing. The next mirror must be what is on screen —
    // not the stored snapshot, which still says 'Building'.
    emit('message.appended', {
      conversationId: CONVERSATION,
      userMessage: PROMPT,
      message: {
        id: 'm_9_ccccc2',
        role: 'assistant',
        content: 'Building the PDF',
        timestamp: 9,
        segments: [textSegment('s1', 'Building the PDF')]
      }
    })
    await streamed()
    frames.push(render(screen))
    expect(frames.at(-1)).toEqual(['user(make me a pdf)', 'assistant(text(Building the PDF))'])

    // The run ends: final save first, then the terminal status; the settle
    // fetch replaces the snapshot and releases the overlay.
    mockDesktop.messages = [
      PROMPT,
      {
        id: 'm_9_ccccc2',
        role: 'assistant',
        content: 'Building the PDF. Done.',
        timestamp: 9,
        segments: [textSegment('s1', 'Building the PDF. Done.')]
      }
    ]
    emit('turn.status', { conversationId: CONVERSATION, state: 'done' })
    await flush()
    frames.push(render(screen))

    expectSmooth(frames)
    expectNoRowLost(frames)
    expect(frames.at(-1)).toEqual([
      'user(make me a pdf)',
      'assistant(text(Building the PDF. Done.))'
    ])
    expect(useChatRuntime.getState().streams[CONVERSATION]).toBeUndefined()
  })

  it('keeps the accumulated answer when the prompt lands mid-stream', () => {
    // beginTurn re-bases a turn that is not streaming. A prompt arriving on a
    // tick after text has accumulated must fold into the live entry, not reset
    // it — that would be the reply blinking back to thinking words.
    seedMidTurn()
    emit('turn.status', { conversationId: CONVERSATION, state: 'started' })
    emit('message.delta', { conversationId: CONVERSATION, text: 'half an answer' })
    emit('message.appended', { conversationId: CONVERSATION, userMessage: PROMPT })
    expect(render({ conversationId: CONVERSATION })).toEqual([
      'user(first question)',
      'assistant(text(first answer))',
      'user(make me a pdf)',
      'assistant(text(half an answer))'
    ])
  })
})

describe('the parked cards across turns', () => {
  const ASK = {
    askId: 'ask_1',
    toolCallId: 'c1',
    questions: [{ question: 'Which db?', options: [{ label: 'Postgres' }], allowOther: false }]
  }

  it('drops the previous turn’s cards when the next turn begins, not before', async () => {
    seed([{ id: 'm_1_aaaaaa', role: 'user', content: 'hi', timestamp: 1 }])
    emit('turn.status', { conversationId: CONVERSATION, state: 'started' })
    emit('message.appended', {
      conversationId: CONVERSATION,
      message: {
        id: 'm_2_bbbbbb',
        role: 'assistant',
        content: 'pick one',
        timestamp: 2,
        segments: [textSegment('s1', 'pick one')]
      }
    })
    useChatRuntime.getState().putAsk(CONVERSATION, ASK)
    // `started` can be re-delivered mid-turn. The running turn's own card must
    // ride that out — it is the turn the user is being asked BY.
    emit('turn.status', { conversationId: CONVERSATION, state: 'started' })
    expect(useChatRuntime.getState().cards[CONVERSATION]?.asks.c1).toBeDefined()

    // The turn ends, but its save has not landed: the settle keeps the live
    // row AND the cards (the stored transcript cannot draw the outcome yet).
    emit('turn.status', { conversationId: CONVERSATION, state: 'done' })
    await flush()
    expect(useChatRuntime.getState().cards[CONVERSATION]?.asks.c1).toBeDefined()

    // A queued prompt flushes exactly here — after `done`, before the settle
    // fetch succeeds. The new turn must not inherit the old card: it would
    // ride the new live row's tail, below the prompt that follows it.
    mockRpc.mockResolvedValue({ conversationId: CONVERSATION })
    await sendPrompt({ conversationId: CONVERSATION, text: 'next question' })
    expect(useChatRuntime.getState().cards[CONVERSATION]).toBeUndefined()
    await flush()
  })
})
