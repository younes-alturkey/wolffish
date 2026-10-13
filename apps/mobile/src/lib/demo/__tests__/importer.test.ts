jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

import type { ConversationFile } from '@/lib/conversations/types'

/**
 * The demo bundle is a remote contract between scripts/demo/build-demo-bundle.mjs
 * and this importer, and it is the app's entire first-run experience: if the
 * client and the published layout disagree, the only symptom is a Demo Mode
 * button that fails on a stranger's phone. These tests pin the contract —
 * which URLs are requested, in what order, what the progress bar is allowed to
 * do, and what a bad conversation costs.
 */

const mockUpsert = jest.fn<Promise<void>, [ConversationFile]>().mockResolvedValue(undefined)
const mockWritten: string[] = []
const mockCreated = jest.fn()
const mockPurge = jest.fn<Promise<void>, []>().mockResolvedValue(undefined)

jest.mock('@/lib/conversations/repo', () => ({
  upsertConversation: (file: ConversationFile) => mockUpsert(file)
}))

jest.mock('@/lib/demo/reset', () => ({
  purgeDemoState: () => mockPurge()
}))

const mockSeed = jest.fn<boolean, [string, string]>().mockReturnValue(true)

jest.mock('@/lib/files/fileCache', () => ({
  seedWorkspaceFile: (relPath: string, content: string) => mockSeed(relPath, content)
}))

jest.mock('expo-file-system', () => ({
  Paths: { document: 'file:///doc' },
  Directory: class {
    create = mockCreated
  },
  File: class {
    exists = false
    write = (content: string) => mockWritten.push(content)
    text = () => Promise.resolve('')
  }
}))

import { DEMO_BASE_URL, importDemoData, type DemoProgress } from '@/lib/demo/importer'

function conversation(id: string): ConversationFile {
  return {
    id,
    title: id,
    model: null,
    createdAt: 1,
    updatedAt: 2,
    messages: [{ id: `${id}-m`, role: 'user', content: 'hi', timestamp: 1 }]
  } as ConversationFile
}

const CONFIG = { capabilities: [{ name: 'cap', description: '', enabled: true, official: true }] }

const MANIFEST = {
  version: 'abc123def456',
  builtAt: '2026-07-26T00:00:00.000Z',
  conversations: 3,
  totalBytes: 300,
  config: { file: 'config-snapshot.json', bytes: 40 },
  shards: [
    { file: 'conversations-000.json', bytes: 200, conversations: 2 },
    { file: 'conversations-001.json', bytes: 100, conversations: 1 }
  ]
}

let serveBody: (url: string) => Promise<unknown>

/** The bundle file a request is for, with any cache-busting query dropped. */
function fileOf(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1).split('?')[0]
}

/** Serves the bundle layout the build script emits, per-file overridable. */
function serve(overrides: Record<string, unknown> = {}): jest.Mock {
  const bodies: Record<string, unknown> = {
    'manifest.json': MANIFEST,
    'conversations-000.json': { conversations: [conversation('a'), conversation('b')] },
    'conversations-001.json': { conversations: [conversation('c')] },
    'config-snapshot.json': CONFIG,
    ...overrides
  }
  serveBody = (url: string) => {
    const body = bodies[fileOf(url)]
    if (body === undefined) return Promise.resolve({ ok: false, status: 404 })
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(body))
    })
  }
  const mock = jest.fn((url: string) => serveBody(url))
  globalThis.fetch = mock as unknown as typeof fetch
  return mock
}

describe('demo bundle import', () => {
  beforeEach(() => {
    mockUpsert.mockClear().mockResolvedValue(undefined)
    mockPurge.mockClear().mockResolvedValue(undefined)
    mockCreated.mockClear()
    mockSeed.mockClear().mockReturnValue(true)
    mockWritten.length = 0
  })

  it('fetches the manifest, then every shard, then the config snapshot', async () => {
    const fetched = serve()
    const result = await importDemoData()

    expect(fetched.mock.calls.map(([url]) => fileOf(url))).toEqual([
      'manifest.json',
      'conversations-000.json',
      'conversations-001.json',
      'config-snapshot.json'
    ])
    expect(result).toEqual({ version: 'abc123def456', imported: 3, failed: 0, total: 3 })
    expect(mockUpsert.mock.calls.map(([file]) => file.id)).toEqual(['a', 'b', 'c'])
  })

  /**
   * The published bundle carries no Cache-Control and React Native's fetch
   * cannot ask for a fresh copy, so the URL is the only thing standing between
   * a republished dataset and an HTTP cache that answers with the old one.
   */
  it('stamps every payload URL with the manifest version and never repeats a manifest URL', async () => {
    const fetched = serve()
    await importDemoData()
    const urls = fetched.mock.calls.map(([url]) => url as string)

    expect(urls.slice(1)).toEqual([
      `${DEMO_BASE_URL}/conversations-000.json?v=abc123def456`,
      `${DEMO_BASE_URL}/conversations-001.json?v=abc123def456`,
      `${DEMO_BASE_URL}/config-snapshot.json?v=abc123def456`
    ])
    expect(urls[0]).toMatch(new RegExp(`^${DEMO_BASE_URL}/manifest\\.json\\?t=\\d+$`))

    const first = urls[0]
    await new Promise((resolve) => setTimeout(resolve, 2))
    await importDemoData()
    expect(fetched.mock.calls[4][0]).not.toEqual(first)
  })

  it('downloads the whole bundle, then purges, then writes to the database', async () => {
    const order: string[] = []
    const fetched = serve()
    fetched.mockImplementation((url: string) => {
      order.push(`fetch:${fileOf(url)}`)
      return serveBody(url)
    })
    mockPurge.mockImplementation(() => {
      order.push('purge')
      return Promise.resolve()
    })
    mockUpsert.mockImplementation((file) => {
      order.push(`insert:${file.id}`)
      return Promise.resolve()
    })
    await importDemoData()

    // Every fetch precedes the purge, and the purge precedes every insert: a
    // shard that 404s must cost neither the old dataset nor half the new one.
    expect(order.lastIndexOf('fetch:config-snapshot.json')).toBeLessThan(order.indexOf('purge'))
    expect(order.indexOf('purge')).toBeLessThan(order.indexOf('insert:a'))
  })

  it('replaces the previous dataset rather than importing on top of it', async () => {
    serve()
    await importDemoData()
    expect(mockPurge).toHaveBeenCalledTimes(1)
  })

  it('saves the config snapshot so later entries work offline', async () => {
    serve()
    await importDemoData()
    expect(mockCreated).toHaveBeenCalledWith({ intermediates: true, idempotent: true })
    expect(JSON.parse(mockWritten[0] as string)).toEqual(CONFIG)
  })

  it('reports progress that only ever moves forward and ends at 1', async () => {
    serve()
    const seen: DemoProgress[] = []
    await importDemoData((progress) => seen.push(progress))

    expect(seen.length).toBeGreaterThan(1)
    for (const [index, progress] of seen.entries()) {
      expect(progress.ratio).toBeGreaterThanOrEqual(index === 0 ? 0 : seen[index - 1].ratio)
      expect(progress.ratio).toBeLessThanOrEqual(1)
      expect(progress.imported).toBeLessThanOrEqual(progress.total)
    }
    expect(seen[0]).toEqual({ phase: 'download', ratio: 0, imported: 0, total: 3 })
    expect(seen.at(-1)).toEqual({ phase: 'import', ratio: 1, imported: 3, total: 3 })

    // The wipe is a phase of its own — it happens after the download and the
    // label has to say so rather than claiming conversations are landing.
    const reset = seen.findIndex((progress) => progress.phase === 'reset')
    expect(reset).toBeGreaterThan(0)
    expect(seen.findIndex((progress) => progress.phase === 'import')).toBeGreaterThan(reset)
  })

  it('skips a malformed conversation instead of losing the shard', async () => {
    serve({
      'conversations-000.json': { conversations: [{ id: 'a', messages: null }, conversation('b')] }
    })
    const result = await importDemoData()
    expect(result).toMatchObject({ imported: 2, failed: 1 })
    expect(mockUpsert.mock.calls.map(([file]) => file.id)).toEqual(['b', 'c'])
  })

  it('throws on an unreachable shard without half-importing the dataset', async () => {
    serve({ 'conversations-001.json': undefined })
    await expect(importDemoData()).rejects.toThrow('404')
    expect(mockUpsert).not.toHaveBeenCalled()
    expect(mockWritten).toHaveLength(0)
    // Nothing was wiped either: a device that already holds a demo keeps it
    // when the refresh cannot complete.
    expect(mockPurge).not.toHaveBeenCalled()
  })

  it('rejects a manifest with no shards rather than reporting an empty success', async () => {
    serve({ 'manifest.json': { ...MANIFEST, shards: [] } })
    await expect(importDemoData()).rejects.toThrow('no shards')
    expect(mockPurge).not.toHaveBeenCalled()
  })

  it('rejects a manifest with no version — an unversioned bundle can never refresh', async () => {
    serve({ 'manifest.json': { ...MANIFEST, version: '' } })
    await expect(importDemoData()).rejects.toThrow('no version')
    expect(mockPurge).not.toHaveBeenCalled()
  })

  /**
   * Conversations may carry per-path file bytes inline (the chart showcase's
   * specs — see DemoConversationFile): each entry is written into the
   * workspace so the card renders its own spec instead of the by-extension
   * sample.
   */
  it('materializes inline conversation files into the workspace', async () => {
    const charty = {
      ...conversation('a'),
      files: {
        'files/charts/one.chart.json': '{"type":"line"}',
        'files/charts/two.chart.json': '{"type":"pie"}'
      }
    }
    serve({ 'conversations-000.json': { conversations: [charty, conversation('b')] } })
    const result = await importDemoData()

    expect(mockSeed.mock.calls).toEqual([
      ['files/charts/one.chart.json', '{"type":"line"}'],
      ['files/charts/two.chart.json', '{"type":"pie"}']
    ])
    expect(result).toMatchObject({ imported: 3, failed: 0 })
  })

  it('skips non-string inline entries and survives a rejected write', async () => {
    const charty = {
      ...conversation('a'),
      files: { 'files/charts/ok.chart.json': '{}', 'files/charts/bad.chart.json': 7 }
    }
    serve({ 'conversations-000.json': { conversations: [charty] } })
    mockSeed.mockReturnValue(false) // full disk, traversal-shaped path — card falls back
    const result = await importDemoData()

    expect(mockSeed.mock.calls).toEqual([['files/charts/ok.chart.json', '{}']])
    // A missing spec costs the card its bytes, never the conversation.
    expect(result).toMatchObject({ imported: 2, failed: 0 })
  })
})
