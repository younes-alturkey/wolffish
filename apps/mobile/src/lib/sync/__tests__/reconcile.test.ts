jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * Reconciliation is the half of sync nobody sees working.
 *
 * Pushes cover the phone while it is awake; this covers everything it slept
 * through, and every miss here is silent by nature — a conversation deleted
 * on the desktop that lingers on the phone looks exactly like a real one, and
 * a body that stopped growing looks exactly like a finished answer. So the
 * cases pinned here are the ones with no visible symptom: deletions the
 * incremental pull cannot express, and staleness that emptiness cannot detect.
 */

type Row = { id: string; updated_at: number; body_synced_at: number | null }

const mockState: { rows: Row[]; messages: Record<string, number> } = { rows: [], messages: {} }
const mockRunCalls: Array<{ sql: string; args: unknown[] }> = []

const mockRunAsync = jest.fn(async (sql: string, args: unknown[] = []) => {
  mockRunCalls.push({ sql, args })
  if (sql.startsWith('DELETE FROM conversations')) {
    mockState.rows = mockState.rows.filter((r) => r.id !== args[0])
  }
  if (sql.startsWith('DELETE FROM messages')) delete mockState.messages[args[0] as string]
  if (sql.startsWith('UPDATE conversations SET body_synced_at')) {
    const row = mockState.rows.find((r) => r.id === args[1])
    if (row) row.body_synced_at = args[0] as number
  }
  return undefined
})

const mockDb = {
  runAsync: mockRunAsync,
  execAsync: jest.fn(async () => undefined),
  getFirstAsync: jest.fn(async (sql: string, args: unknown[] = []) => {
    if (sql.includes('FROM sync_meta')) return { value: '100' }
    if (sql.includes('COUNT(*) AS count FROM messages')) {
      return { count: mockState.messages[args[0] as string] ?? 0 }
    }
    if (sql.includes('body_synced_at FROM conversations')) {
      return mockState.rows.find((r) => r.id === args[0]) ?? null
    }
    // The pre-read fetchConversationBody does before asking for a body.
    // Checked after the two-column query above, which also mentions updated_at.
    if (sql.includes('updated_at FROM conversations')) {
      return mockState.rows.find((r) => r.id === args[0]) ?? null
    }
    return null
  }),
  getAllAsync: jest.fn(async (sql: string, args: unknown[] = []) => {
    // Mirrors `SELECT id FROM conversations [WHERE id NOT IN (...)]`.
    if (!sql.includes('NOT IN')) return mockState.rows.map((r) => ({ id: r.id }))
    const keep = new Set(args as string[])
    return mockState.rows.filter((r) => !keep.has(r.id)).map((r) => ({ id: r.id }))
  }),
  withExclusiveTransactionAsync: jest.fn(async (fn: (tx: unknown) => Promise<void>) => {
    await fn({ runAsync: mockRunAsync, execAsync: mockDb.execAsync })
  })
}

jest.mock('@/lib/db/database', () => ({ getDb: () => Promise.resolve(mockDb) }))

const mockRpc = jest.fn()
const mockHandlers = new Map<string, (payload: unknown) => void>()
jest.mock('@/lib/tunnel/client', () => ({
  tunnelClient: {
    get active() {
      return {
        rpc: mockRpc,
        onEvent: (topic: string, handler: (payload: unknown) => void) => {
          mockHandlers.set(topic, handler)
        }
      }
    },
    connected: true
  }
}))

jest.mock('@/lib/conversations/cache', () => ({
  invalidateConversation: jest.fn(),
  invalidateConversationList: jest.fn()
}))
const cacheMock = jest.requireMock('@/lib/conversations/cache') as {
  invalidateConversation: jest.Mock
  invalidateConversationList: jest.Mock
}

jest.mock('@/state/demoConfig', () => ({
  useDemoConfig: { getState: () => ({ applySnapshot: jest.fn() }) },
  // The config half of reconcile delegates here (outbox-aware wrapper); the
  // mock keeps the old observable behavior — one snapshot RPC that can fail
  // independently — so the assertions below stay about reconcile's contract.
  refreshConfigSnapshot: async () => {
    await mockRpc('desktop.config.snapshot')
  }
}))

import {
  attachLiveUpdates,
  fetchConversationBody,
  isBodyStale,
  pullChunkedBody,
  refreshSync,
  reconcile,
  setConversationSettleHook
} from '@/lib/sync/sync'
import { isConversationDirty, markConversationDirty } from '@/lib/sync/dirty'
import { setActiveConversation } from '@/lib/notifications/push'
import { toBase64Url } from '@/lib/tunnel/pairing'
import { CHUNK_SIZE, Event, Rpc } from '@/lib/tunnel/protocol'
import { useChatRuntime } from '@/state/chatRuntime'
import type { ConversationMessage } from '@/lib/conversations/types'

beforeEach(() => {
  mockState.rows = []
  mockState.messages = {}
  mockRunCalls.length = 0
  mockRpc.mockReset()
  mockHandlers.clear()
  cacheMock.invalidateConversation.mockClear()
  cacheMock.invalidateConversationList.mockClear()
  useChatRuntime.getState().reset()
  setConversationSettleHook(() => undefined)
  setActiveConversation(null)
})

/** Let the fire-and-forget handler chains drain. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Conversation ids the desktop was asked bodies for, in call order. */
const bodyCalls = (): string[] =>
  mockRpc.mock.calls
    .filter(([method]) => method === Rpc.conversationBody)
    .map(([, params]) => (params as { id: string }).id)

const liveMessage = (id: string): ConversationMessage => ({
  id,
  role: 'assistant',
  content: 'streaming',
  timestamp: 1
})

/** A live overlay in the runtime store, as beginTurn/turnStatus would leave it. */
const putStream = (conversationId: string, status: 'streaming' | 'complete'): void => {
  useChatRuntime.getState().putStream(conversationId, {
    base: liveMessage('m-live'),
    tail: '',
    status,
    channel: null,
    message: liveMessage('m-live'),
    ...(status === 'complete' ? { ended: 'desktop' as const } : {})
  })
}

describe('refreshSync deletion reconciliation', () => {
  it('drops local conversations the desktop no longer lists', async () => {
    mockState.rows = [
      { id: 'kept', updated_at: 1, body_synced_at: 1 },
      { id: 'deleted-while-asleep', updated_at: 1, body_synced_at: 1 }
    ]
    mockState.messages['deleted-while-asleep'] = 3
    mockRpc.mockResolvedValue({ rows: [], at: 200, ids: ['kept'] })

    const result = await refreshSync(true)

    expect(result.removed).toBe(1)
    expect(mockState.rows.map((r) => r.id)).toEqual(['kept'])
    // Its messages go too — a body with no conversation is unreachable bytes.
    expect(mockState.messages['deleted-while-asleep']).toBeUndefined()
  })

  it('prunes everything when the desktop reports an empty workspace', async () => {
    mockState.rows = [{ id: 'a', updated_at: 1, body_synced_at: null }]
    mockRpc.mockResolvedValue({ rows: [], at: 200, ids: [] })

    expect((await refreshSync(true)).removed).toBe(1)
    expect(mockState.rows).toEqual([])
  })

  // The dangerous direction: a response without ids must never be read as
  // "the desktop has nothing", or one odd reply wipes the phone.
  it('never prunes when the desktop did not send an id list', async () => {
    mockState.rows = [{ id: 'a', updated_at: 1, body_synced_at: null }]
    mockRpc.mockResolvedValue({ rows: [], at: 200 })

    expect((await refreshSync(false)).removed).toBe(0)
    expect(mockState.rows.map((r) => r.id)).toEqual(['a'])
  })

  it('asks for ids only when reconciling', async () => {
    mockRpc.mockResolvedValue({ rows: [], at: 1 })
    await refreshSync(false)
    expect(mockRpc.mock.calls[0][1]).toMatchObject({ withIds: false })
    await refreshSync(true)
    expect(mockRpc.mock.calls[1][1]).toMatchObject({ withIds: true })
  })

  it('never prunes the conversation on screen — an absent id there is a race, not a deletion', async () => {
    // A desktop index read can catch a conversation file mid-life and omit its
    // id for one sweep. Pruning on that yanked the transcript out from under
    // the open chat (the blank-chat report, 2026-08-25). Real deletions arrive
    // as conversation.deleted pushes; the sweep only takes the open one after
    // the user has left it.
    mockState.rows = [
      { id: 'on-screen', updated_at: 1, body_synced_at: 1 },
      { id: 'elsewhere', updated_at: 1, body_synced_at: 1 }
    ]
    mockState.messages['on-screen'] = 4
    setActiveConversation('on-screen')
    mockRpc.mockResolvedValue({ rows: [], at: 200, ids: [] })

    const result = await refreshSync(true)

    expect(result.removed).toBe(1)
    expect(mockState.rows.map((r) => r.id)).toEqual(['on-screen'])
    expect(mockState.messages['on-screen']).toBe(4)

    // The user walks away; the next sweep is free to take it.
    setActiveConversation(null)
    mockRpc.mockResolvedValue({ rows: [], at: 300, ids: [] })
    expect((await refreshSync(true)).removed).toBe(1)
    expect(mockState.rows).toEqual([])
  })
})

describe('body staleness', () => {
  it('is stale when the desktop changed it after the last body pull', async () => {
    mockState.rows = [{ id: 'c', updated_at: 500, body_synced_at: 400 }]
    expect(await isBodyStale('c')).toBe(true)
  })

  it('is stale when the body was never pulled', async () => {
    mockState.rows = [{ id: 'c', updated_at: 500, body_synced_at: null }]
    expect(await isBodyStale('c')).toBe(true)
  })

  it('is current when the body pull is at least as new as the change', async () => {
    mockState.rows = [{ id: 'c', updated_at: 400, body_synced_at: 400 }]
    expect(await isBodyStale('c')).toBe(false)
  })

  it('stamps body_synced_at so the next open trusts the cache', async () => {
    mockState.rows = [{ id: 'c', updated_at: 400, body_synced_at: null }]
    mockRpc.mockResolvedValue({
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }]
    })

    await fetchConversationBody('c')

    expect(await isBodyStale('c')).toBe(false)
  })

  it('leaves the stamp unset when the write fails, so the copy is retried', async () => {
    mockState.rows = [{ id: 'c', updated_at: 400, body_synced_at: null }]
    mockRpc.mockResolvedValue({ messages: [] })
    mockDb.withExclusiveTransactionAsync.mockRejectedValueOnce(new Error('disk full'))

    await expect(fetchConversationBody('c')).rejects.toThrow()
    expect(await isBodyStale('c')).toBe(true)
  })
})

describe('reconcile', () => {
  it('brings config and conversations level in one pass', async () => {
    mockRpc.mockImplementation(async (method: string) => {
      if (method === 'desktop.config.snapshot') return {}
      return { rows: [], at: 1, ids: [] }
    })

    await reconcile()

    const methods = mockRpc.mock.calls.map((c) => c[0])
    expect(methods).toEqual(
      expect.arrayContaining(['desktop.config.snapshot', 'desktop.conversations.index'])
    )
  })

  // Half a reconcile is better than none: a desktop that cannot answer for
  // settings must still be able to correct the conversation list.
  it('still syncs conversations when the config pull fails', async () => {
    mockState.rows = [{ id: 'gone', updated_at: 1, body_synced_at: null }]
    mockRpc.mockImplementation(async (method: string) => {
      if (method === 'desktop.config.snapshot') throw new Error('no config')
      return { rows: [], at: 1, ids: [] }
    })

    await expect(reconcile()).resolves.toBeUndefined()
    expect(mockState.rows).toEqual([])
  })
})

describe('fetchConversationBody', () => {
  it('stamps the desktop clock, not this phone clock', async () => {
    // The silent bug: body_synced_at taken from Date.now() is compared
    // against a timestamp the *desktop* wrote. A phone running ahead makes
    // every conversation look current and it never refreshes again.
    mockState.rows = [{ id: 'c', updated_at: 1_000, body_synced_at: null }]
    mockRpc.mockResolvedValue({ messages: [{ id: 'm', role: 'user', content: 'x', timestamp: 1 }] })

    await fetchConversationBody('c')

    expect(mockState.rows[0].body_synced_at).toBe(1_000)
    expect(await isBodyStale('c')).toBe(false)
  })

  it('stamps the version the desktop served, not the one this phone knew about', async () => {
    // A turn run on the DESKTOP moves updated_at without telling the phone
    // first: `turn.status: done` arrives, this fetch pulls the finished
    // transcript, and the meta push carrying the new updated_at lands a few
    // hundred ms LATER. Stamping what the phone knew when it asked marked a
    // complete body stale, and the upsert handler's staleness check then
    // downloaded the whole conversation a second time. The served value
    // describes the messages in the reply, so it is the one that is true.
    mockState.rows = [{ id: 'c', updated_at: 1_000, body_synced_at: 1_000 }]
    mockRpc.mockResolvedValue({
      updatedAt: 2_000,
      messages: [{ id: 'm', role: 'user', content: 'x', timestamp: 1 }]
    })

    await fetchConversationBody('c')
    expect(mockState.rows[0].body_synced_at).toBe(2_000)

    // ... and now the push lands, carrying the same version. Nothing to do.
    mockState.rows[0].updated_at = 2_000
    expect(await isBodyStale('c')).toBe(false)
  })

  it('is stale again as soon as the desktop moves past the version it served', async () => {
    // The guarantee the stamp must never trade away: a body one turn behind
    // has to be recognised as behind.
    mockState.rows = [{ id: 'c', updated_at: 1_000, body_synced_at: null }]
    mockRpc.mockResolvedValue({
      updatedAt: 2_000,
      messages: [{ id: 'm', role: 'user', content: 'x', timestamp: 1 }]
    })

    await fetchConversationBody('c')
    mockState.rows[0].updated_at = 3_000

    expect(await isBodyStale('c')).toBe(true)
  })

  it('falls back to what it knew when asked if the desktop serves no version', async () => {
    // An older desktop, or a reply whose updatedAt is not a number: the stamp
    // degrades to the previous behaviour rather than to Date.now() or 0.
    for (const reply of [{}, { updatedAt: 'soon' }, { updatedAt: Number.NaN }]) {
      mockState.rows = [{ id: 'c', updated_at: 1_000, body_synced_at: null }]
      mockRpc.mockResolvedValue({
        ...reply,
        messages: [{ id: 'm', role: 'user', content: 'x', timestamp: 1 }]
      })

      await fetchConversationBody('c')

      expect(mockState.rows[0].body_synced_at).toBe(1_000)
    }
  })

  it('records the version it actually fetched, so a mid-fetch change refetches', async () => {
    mockState.rows = [{ id: 'c', updated_at: 1_000, body_synced_at: null }]
    mockRpc.mockImplementation(async () => {
      // The desktop edits the conversation while the body is in flight; the
      // push lands before the write completes.
      mockState.rows[0].updated_at = 2_000
      return { messages: [{ id: 'm', role: 'user', content: 'x', timestamp: 1 }] }
    })

    await fetchConversationBody('c')

    // Stamped with what was asked for, not what arrived after — so the copy
    // in hand is correctly seen as behind.
    expect(mockState.rows[0].body_synced_at).toBe(1_000)
    expect(await isBodyStale('c')).toBe(true)
  })

  it('keeps a mid-fetch change stale even when the desktop names its version', async () => {
    // The same race, with the served stamp in play: the reply describes the
    // version the desktop read, and a change made after that read moves
    // updated_at past it. Nothing is missed — it just isn't missed by
    // accident any more.
    mockState.rows = [{ id: 'c', updated_at: 1_000, body_synced_at: null }]
    mockRpc.mockImplementation(async () => {
      mockState.rows[0].updated_at = 2_000
      return { updatedAt: 1_000, messages: [{ id: 'm', role: 'user', content: 'x', timestamp: 1 }] }
    })

    await fetchConversationBody('c')

    expect(mockState.rows[0].body_synced_at).toBe(1_000)
    expect(await isBodyStale('c')).toBe(true)
  })

  it('never wipes a good transcript when the answer is malformed', async () => {
    mockState.rows = [{ id: 'c', updated_at: 1_000, body_synced_at: 1_000 }]
    mockState.messages['c'] = 12
    for (const bad of [{}, { messages: null }, { messages: 'nope' }, undefined]) {
      mockRpc.mockResolvedValue(bad)
      expect(await fetchConversationBody('c')).toBe(false)
      expect(mockState.messages['c']).toBe(12)
    }
  })

  it('refuses an empty answer over a transcript this phone holds', async () => {
    // Nothing in the product empties a conversation in place — the one real
    // producer of a served [] for a known conversation is a NEW conversation's
    // titled shell caught before its first turn folded. Honouring it deleted
    // the local transcript under the open chat (the blank-chat report,
    // 2026-08-25); the copy in hand stays, and the post-save signal refetches.
    mockState.rows = [{ id: 'c', updated_at: 1_000, body_synced_at: null }]
    mockState.messages['c'] = 3
    mockRpc.mockResolvedValue({ messages: [] })

    expect(await fetchConversationBody('c')).toBe(false)
    expect(mockState.messages['c']).toBe(3)
  })

  it('still syncs a conversation that is genuinely empty on both sides', async () => {
    mockState.rows = [{ id: 'c', updated_at: 1_000, body_synced_at: null }]
    mockRpc.mockResolvedValue({ updatedAt: 1_000, messages: [] })

    expect(await fetchConversationBody('c')).toBe(true)
    expect(await isBodyStale('c')).toBe(false)
  })

  it('refuses an empty answer while a live turn overlays the conversation', async () => {
    // Nothing cached yet — a notification tap mid-run lands exactly here: the
    // run is seeded before the first body fetch answers, and the served [] is
    // that very turn's pre-fold shell. Stamping it as the synced body wasted a
    // round on emptiness the settle then had to claw back.
    mockState.rows = [{ id: 'c', updated_at: 1_000, body_synced_at: null }]
    putStream('c', 'streaming')
    mockRpc.mockResolvedValue({ updatedAt: 1_000, messages: [] })

    expect(await fetchConversationBody('c')).toBe(false)
    expect(await isBodyStale('c')).toBe(true)
  })
})

/**
 * Oversize bodies arrive in windows. A finished tool-heavy turn can outgrow
 * the relay's one-frame record cap, and an inline answer past it does not
 * arrive late — it CLOSES the tunnel, after which every open of the
 * conversation kills the link again (the 2026-08-22 sweep finished 12% under
 * that cliff). The desktop spools the serialized body instead and this side
 * reassembles it; every failure shape must leave the cached copy untouched,
 * exactly like a malformed inline answer.
 */
describe('chunked body pulls', () => {
  const wireBody = {
    updatedAt: 500,
    messages: [
      { id: 'u1', role: 'user', content: 'sweep my inbox', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'done: ' + 'x'.repeat(200), timestamp: 2 }
    ]
  }
  const encoded = new TextEncoder().encode(JSON.stringify(wireBody))
  // Deliberately tiny windows — the loop must advance by the bytes actually
  // served, not by the length it asked for.
  const serveWindows = (windowSize: number): void => {
    mockRpc.mockImplementation((method: string, params?: { offset?: number }) => {
      if (method === Rpc.conversationBody) {
        return Promise.resolve({ chunked: true, bodyId: 'b1', sizeBytes: encoded.length })
      }
      if (method === Rpc.conversationBodyChunk) {
        const offset = params?.offset ?? 0
        const window = encoded.subarray(offset, offset + windowSize)
        return Promise.resolve({ data: toBase64Url(window), sizeBytes: encoded.length })
      }
      return Promise.resolve(null)
    })
  }

  it('reassembles a spooled body end-to-end and stores it', async () => {
    mockState.rows = [{ id: 'big', updated_at: 100, body_synced_at: null }]
    serveWindows(7)

    expect(await fetchConversationBody('big')).toBe(true)
    const inserts = mockRunCalls.filter(({ sql }) => sql.startsWith('INSERT INTO messages'))
    expect(inserts).toHaveLength(2)
    expect(inserts[1].args).toContain('done: ' + 'x'.repeat(200))
    // The stamp is the SERVED updatedAt, carried through the chunked shape.
    expect(mockState.rows[0].body_synced_at).toBe(500)
  })

  it('a spool that dies mid-pull leaves the cached copy untouched', async () => {
    mockState.rows = [{ id: 'big', updated_at: 100, body_synced_at: 42 }]
    mockState.messages['big'] = 9
    let served = 0
    mockRpc.mockImplementation((method: string) => {
      if (method === Rpc.conversationBody) {
        return Promise.resolve({ chunked: true, bodyId: 'b1', sizeBytes: encoded.length })
      }
      // First window lands, then the spool expires: empty data.
      served += 1
      return Promise.resolve({
        data: served === 1 ? toBase64Url(encoded.subarray(0, 5)) : '',
        sizeBytes: encoded.length
      })
    })

    expect(await fetchConversationBody('big')).toBe(false)
    expect(mockState.messages['big']).toBe(9)
    expect(mockState.rows[0].body_synced_at).toBe(42)
  })

  it('pullChunkedBody refuses junk meta without touching the wire', async () => {
    const rpc = jest.fn()
    expect(await pullChunkedBody(rpc, {})).toBeNull()
    expect(await pullChunkedBody(rpc, { bodyId: 'b', sizeBytes: 0 })).toBeNull()
    expect(await pullChunkedBody(rpc, { bodyId: 'b', sizeBytes: Number.NaN })).toBeNull()
    expect(await pullChunkedBody(rpc, { bodyId: 'b', sizeBytes: 65 * 1024 * 1024 })).toBeNull()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('pullChunkedBody yields null for bytes that do not parse', async () => {
    const junk = new TextEncoder().encode('not json at all')
    const rpc = jest.fn(async () => ({ data: toBase64Url(junk), sizeBytes: junk.length }))
    expect(await pullChunkedBody(rpc, { bodyId: 'b', sizeBytes: junk.length })).toBeNull()
  })

  it('pulls a multi-window body at full contract windows and reassembles it in order', async () => {
    // Big enough for three windows, so the parallel path actually spans them.
    const big = {
      updatedAt: 700,
      messages: [
        { id: 'm1', role: 'assistant', content: 'y'.repeat(CHUNK_SIZE * 2 + 500), timestamp: 1 }
      ]
    }
    const bytes = new TextEncoder().encode(JSON.stringify(big))
    const rpc = jest.fn(async (_method: string, params: Record<string, unknown>) => {
      const offset = params.offset as number
      return {
        data: toBase64Url(bytes.subarray(offset, offset + CHUNK_SIZE)),
        sizeBytes: bytes.length
      }
    })

    const pulled = (await pullChunkedBody(rpc, { bodyId: 'b', sizeBytes: bytes.length })) as {
      updatedAt: number
      messages: Array<{ content: string }>
    }

    expect(pulled.updatedAt).toBe(700)
    expect(pulled.messages[0].content).toHaveLength(CHUNK_SIZE * 2 + 500)
    // One request per window, each at its computed offset — no serial re-walk.
    const offsets = rpc.mock.calls
      .map(([, params]) => (params as { offset: number }).offset)
      .sort((a, b) => a - b)
    expect(offsets).toEqual([0, CHUNK_SIZE, CHUNK_SIZE * 2])
  })

  it('an empty window inside a parallel pull is final — the cached copy stays', async () => {
    const bytes = new TextEncoder().encode('z'.repeat(CHUNK_SIZE + 100))
    const rpc = jest.fn(async (_method: string, params: Record<string, unknown>) => {
      const offset = params.offset as number
      // The first window serves; the spool is gone by the second.
      if (offset === 0) {
        return { data: toBase64Url(bytes.subarray(0, CHUNK_SIZE)), sizeBytes: bytes.length }
      }
      return { data: '', sizeBytes: bytes.length }
    })

    expect(await pullChunkedBody(rpc, { bodyId: 'b', sizeBytes: bytes.length })).toBeNull()
  })
})

/**
 * The aggressive half of catch-up, added 2026-08-25: metadata alone cannot
 * un-stale a transcript, and the pushes that normally would were exactly what
 * the phone slept through. These pin the three rules — changed conversations
 * re-read, cached-and-stale bodies refetch under a cap, and live-turn
 * conversations are left to the turn machinery.
 */
describe('aggressive catch-up', () => {
  it('refreshSync invalidates every changed conversation, not just the list', async () => {
    mockRpc.mockResolvedValue({
      rows: [
        { id: 'a', updatedAt: 300 },
        { id: 'b', updatedAt: 200 }
      ],
      at: 400
    })

    await refreshSync(false)

    expect(cacheMock.invalidateConversation).toHaveBeenCalledWith('a')
    expect(cacheMock.invalidateConversation).toHaveBeenCalledWith('b')
  })

  it('a row without an id never reaches the store', async () => {
    // A malformed frame INSERTed under a NULL key is a ghost: pruneMissing's
    // `NOT IN` can never select it, and every id-keyed list trips on it.
    mockRpc.mockResolvedValue({
      rows: [{ title: 'ghost', updatedAt: 300 }, null, { id: '', updatedAt: 200 }],
      at: 400
    })

    await refreshSync(false)

    expect(mockRunCalls.filter(({ sql }) => sql.startsWith('INSERT INTO conversations'))).toEqual(
      []
    )
    expect(cacheMock.invalidateConversation).not.toHaveBeenCalled()
  })

  it('reconcile refetches the newest stale cached bodies, capped', async () => {
    // Six conversations changed while the phone slept; all have cached,
    // now-stale bodies. Only the four newest download — the rest heal on open.
    const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']
    mockState.rows = ids.map((id, i) => ({ id, updated_at: (i + 1) * 100, body_synced_at: 1 }))
    for (const id of ids) mockState.messages[id] = 2
    mockRpc.mockImplementation(async (method: string) => {
      if (method === 'desktop.config.snapshot') return {}
      if (method === Rpc.conversationIndex) {
        return { rows: ids.map((id, i) => ({ id, updatedAt: (i + 1) * 100 })), at: 999, ids }
      }
      if (method === Rpc.conversationBody) {
        return { updatedAt: 999, messages: [{ id: 'm', role: 'user', content: 'x', timestamp: 1 }] }
      }
      return null
    })

    await reconcile()

    expect(bodyCalls()).toEqual(['c6', 'c5', 'c4', 'c3'])
  })

  it('reconcile leaves a conversation with a running turn to the turn machinery', async () => {
    mockState.rows = [
      { id: 'busy', updated_at: 500, body_synced_at: 1 },
      { id: 'idle', updated_at: 400, body_synced_at: 1 }
    ]
    mockState.messages['busy'] = 2
    mockState.messages['idle'] = 2
    putStream('busy', 'streaming')
    mockRpc.mockImplementation(async (method: string) => {
      if (method === 'desktop.config.snapshot') return {}
      if (method === Rpc.conversationIndex) {
        return {
          rows: [
            { id: 'busy', updatedAt: 500 },
            { id: 'idle', updatedAt: 400 }
          ],
          at: 999,
          ids: ['busy', 'idle']
        }
      }
      if (method === Rpc.conversationBody) {
        return { updatedAt: 999, messages: [{ id: 'm', role: 'user', content: 'x', timestamp: 1 }] }
      }
      return null
    })

    await reconcile()

    expect(bodyCalls()).toEqual(['idle'])
  })
})

/**
 * The upsert push, re-pinned after its 2026-08-25 rework: it must invalidate
 * the conversation UNCONDITIONALLY (a mounted screen sitting on an empty or
 * failed first fetch re-reads only through that), fetch a cached-stale body,
 * and hand a just-ended turn to the settle path instead of racing it.
 */
describe('conversationUpserted push', () => {
  const emitUpserted = async (meta: Record<string, unknown>): Promise<void> => {
    attachLiveUpdates()
    mockHandlers.get(Event.conversationUpserted)?.(meta)
    await flush()
  }

  it('always invalidates the conversation, cached body or not', async () => {
    await emitUpserted({ id: 'never-opened', updatedAt: 100 })

    expect(cacheMock.invalidateConversation).toHaveBeenCalledWith('never-opened')
    expect(bodyCalls()).toEqual([])
  })

  it('refetches a cached body the push just made stale', async () => {
    mockState.rows = [{ id: 'c', updated_at: 500, body_synced_at: 100 }]
    mockState.messages['c'] = 3
    mockRpc.mockResolvedValue({
      updatedAt: 500,
      messages: [{ id: 'm', role: 'user', content: 'x', timestamp: 1 }]
    })

    await emitUpserted({ id: 'c', updatedAt: 500 })

    expect(bodyCalls()).toEqual(['c'])
  })

  it('fetches nothing mid-turn — the body on disk predates the turn', async () => {
    mockState.rows = [{ id: 'c', updated_at: 500, body_synced_at: 100 }]
    mockState.messages['c'] = 3
    putStream('c', 'streaming')

    await emitUpserted({ id: 'c', updatedAt: 500 })

    expect(bodyCalls()).toEqual([])
    expect(cacheMock.invalidateConversation).toHaveBeenCalledWith('c')
  })

  it('routes a just-ended turn through the settle path, not a bare fetch', async () => {
    mockState.rows = [{ id: 'c', updated_at: 500, body_synced_at: 100 }]
    mockState.messages['c'] = 3
    putStream('c', 'complete')
    const settle = jest.fn()
    setConversationSettleHook(settle)

    await emitUpserted({ id: 'c', updatedAt: 500 })

    expect(settle).toHaveBeenCalledWith('c')
    // The settle owns the fetch — a second one here would race its own.
    expect(bodyCalls()).toEqual([])
  })
})

describe('store-boundary segment compaction', () => {
  it('folds per-tick text confetti before it reaches SQLite', async () => {
    // Until the desktop coalesces its own persists, a streamed reply can
    // arrive as thousands of few-character text segments (one heartbeat
    // answer carried 2,441). They fold to prose runs here, once, so the
    // store and every later parse hold the compact shape.
    mockState.rows = [{ id: 'c', updated_at: 400, body_synced_at: null }]
    const confetti = Array.from({ length: 200 }, (_, i) => ({
      kind: 'text',
      turnId: 't1',
      segmentId: `s${i}`,
      delta: `w${i} `
    }))
    mockRpc.mockResolvedValue({
      updatedAt: 400,
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: '',
          timestamp: 1,
          payload: { segments: confetti }
        }
      ]
    })

    await fetchConversationBody('c')

    const insert = mockRunCalls.find(({ sql }) => sql.startsWith('INSERT INTO messages'))
    const stored = JSON.parse(insert?.args[6] as string) as { segments: unknown[] }
    expect(stored.segments).toHaveLength(1)
    expect((stored.segments[0] as { delta: string }).delta.startsWith('w0 w1 ')).toBe(true)
  })
})

describe('notification evidence', () => {
  it('a successful body fetch pays off the dirty mark', async () => {
    mockState.rows = [{ id: 'c', updated_at: 400, body_synced_at: null }]
    mockRpc.mockResolvedValue({
      messages: [{ id: 'm', role: 'user', content: 'x', timestamp: 1 }]
    })
    markConversationDirty('c')

    await fetchConversationBody('c')

    expect(isConversationDirty('c')).toBe(false)
  })

  it('a failed fetch keeps the debt', async () => {
    mockState.rows = [{ id: 'c', updated_at: 400, body_synced_at: null }]
    mockRpc.mockResolvedValue({})
    markConversationDirty('c')

    expect(await fetchConversationBody('c')).toBe(false)
    expect(isConversationDirty('c')).toBe(true)
  })
})
