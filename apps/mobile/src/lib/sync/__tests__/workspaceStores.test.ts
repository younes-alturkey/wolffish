// The query client is constructed at import time with an AsyncStorage persister.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
)

/**
 * The write paths for the three workspace stores the phone shares with the
 * desktop: projects, procedures and automations.
 *
 * These are two screens editing three files that live on the other machine, so
 * every failure mode here is a divergence rather than a crash — the phone
 * showing a value the desktop never took, or two of this screen's edits racing
 * and dropping one. What is pinned below is therefore the ordering and the
 * source of truth: the desktop's answer is what lands in the cache, and one
 * whole-file edit at a time.
 */

const mockRpc = jest.fn()
const mockReportRpcFailure = jest.fn()
const link = { connected: true }
jest.mock('@/lib/tunnel/client', () => ({
  tunnelClient: {
    get connected() {
      return link.connected
    },
    get active() {
      return link.connected ? { rpc: mockRpc, connected: true } : null
    },
    reportRpcFailure: (error: unknown) => mockReportRpcFailure(error)
  }
}))

jest.mock('@/lib/files/fileCache', () => ({ importLocalFile: jest.fn(async () => null) }))

import { queryClient } from '@/lib/query/queryClient'
import { automationKeys, applyRunsPush, editAutomations } from '@/lib/sync/automations'
import { procedureKeys, createProcedure, updateProcedure } from '@/lib/sync/procedures'
import { projectKeys, deleteProject, updateProject } from '@/lib/sync/projects'
import { Rpc, type SyncProcedure, type SyncProject } from '@/lib/tunnel/protocol'

function project(id: string, over: Partial<SyncProject> = {}): SyncProject {
  return {
    id,
    title: id,
    icon: '📁',
    instructions: '',
    files: [],
    directories: [],
    thinking: null,
    createdAt: 1,
    updatedAt: 1,
    ...over
  }
}

function procedure(id: string, over: Partial<SyncProcedure> = {}): SyncProcedure {
  return {
    id,
    title: id,
    prompt: '',
    mode: null,
    thinking: null,
    icon: '📋',
    projectId: null,
    files: [],
    directories: [],
    createdAt: 1,
    updatedAt: 1,
    ...over
  }
}

beforeEach(() => {
  queryClient.clear()
  mockRpc.mockReset()
  mockReportRpcFailure.mockReset()
  link.connected = true
})

describe('projects', () => {
  it('writes the DESKTOP answer into the cache, not what was asked for', async () => {
    // The desktop is the one that decides — it may have renamed a file on
    // collision, or refused a field. Rendering the request instead of the answer
    // is how the two screens end up disagreeing.
    queryClient.setQueryData(projectKeys.list, [project('a', { title: 'old' })])
    mockRpc.mockResolvedValue({ project: project('a', { title: 'canonical', updatedAt: 9 }) })

    const returned = await updateProject({ id: 'a', title: 'typed' })

    expect(mockRpc).toHaveBeenCalledWith(Rpc.projectUpdate, { id: 'a', title: 'typed' })
    expect(returned.title).toBe('canonical')
    expect(queryClient.getQueryData<SyncProject[]>(projectKeys.list)).toEqual([
      project('a', { title: 'canonical', updatedAt: 9 })
    ])
  })

  it('keeps the list newest-edited first, as the desktop lists it', async () => {
    queryClient.setQueryData(projectKeys.list, [
      project('a', { updatedAt: 5 }),
      project('b', { updatedAt: 3 })
    ])
    mockRpc.mockResolvedValue({ project: project('b', { updatedAt: 20 }) })
    await updateProject({ id: 'b', title: 'b' })
    expect(queryClient.getQueryData<SyncProject[]>(projectKeys.list)?.map((row) => row.id)).toEqual(
      ['b', 'a']
    )
  })

  it('drops the row on delete', async () => {
    queryClient.setQueryData(projectKeys.list, [project('a'), project('b')])
    mockRpc.mockResolvedValue({ ok: true })
    await deleteProject('a')
    expect(queryClient.getQueryData<SyncProject[]>(projectKeys.list)?.map((row) => row.id)).toEqual(
      ['b']
    )
  })

  it('leaves the cache alone when the write never landed', async () => {
    // A failed write must not look applied: the next refresh would silently put
    // the desktop's value back and the edit would appear to have been undone by
    // itself.
    const before = [project('a', { title: 'stored' })]
    queryClient.setQueryData(projectKeys.list, before)
    mockRpc.mockRejectedValue(new Error('tunnel gone'))

    await expect(updateProject({ id: 'a', title: 'typed' })).rejects.toThrow('tunnel gone')
    expect(queryClient.getQueryData<SyncProject[]>(projectKeys.list)).toEqual(before)
    expect(mockReportRpcFailure).toHaveBeenCalled()
  })

  it('refuses to write while disconnected rather than pretending', async () => {
    link.connected = false
    await expect(updateProject({ id: 'a', title: 'x' })).rejects.toThrow('not connected')
    expect(mockRpc).not.toHaveBeenCalled()
  })
})

describe('procedures', () => {
  it('prepends a created procedure and absorbs the stored row', async () => {
    queryClient.setQueryData(procedureKeys.list, [procedure('old', { updatedAt: 2 })])
    mockRpc.mockResolvedValue({ procedure: procedure('new', { updatedAt: 7, icon: '📋' }) })
    await createProcedure({ title: '', prompt: '' })
    expect(
      queryClient.getQueryData<SyncProcedure[]>(procedureKeys.list)?.map((row) => row.id)
    ).toEqual(['new', 'old'])
  })

  it("passes an empty projectId through, since that is the desktop's unbind", async () => {
    mockRpc.mockResolvedValue({ procedure: procedure('a', { projectId: null }) })
    await updateProcedure({ id: 'a', projectId: '' })
    expect(mockRpc).toHaveBeenCalledWith(Rpc.procedureUpdate, { id: 'a', projectId: '' })
  })
})

describe('automations', () => {
  /** The snapshot the desktop answers `automationsRead` with. */
  function served(markdown: string): Record<string, unknown> {
    return { markdown, jobs: [], stamps: {}, runs: { running: [], queued: [] } }
  }

  it('splices against the file as it stands on the DESKTOP, not the cache', async () => {
    // The cache can be a read old: the desktop's own page may have written since.
    // Splicing into the stale copy would silently revert that edit.
    queryClient.setQueryData(automationKeys.snapshot, served('stale'))
    mockRpc.mockImplementation(async (method: string) =>
      method === Rpc.automationsRead ? served('## Daily (09:00)\n\nFresh.\n') : { ok: true }
    )

    const seen: string[] = []
    await editAutomations((markdown) => {
      seen.push(markdown)
      return `${markdown}\n## Startup\n\nAdded.\n`
    })

    expect(seen).toEqual(['## Daily (09:00)\n\nFresh.\n'])
    expect(mockRpc).toHaveBeenCalledWith(Rpc.automationsWrite, {
      markdown: '## Daily (09:00)\n\nFresh.\n\n## Startup\n\nAdded.\n'
    })
  })

  it('writes the new file into the cache so cards repaint immediately', async () => {
    mockRpc.mockImplementation(async (method: string) =>
      method === Rpc.automationsRead ? served('a') : { ok: true }
    )
    await editAutomations(() => 'b')
    expect(
      (queryClient.getQueryData(automationKeys.snapshot) as { markdown: string }).markdown
    ).toBe('b')
  })

  it('serializes edits, so the second one reads the first one back', async () => {
    // Two whole-file edits in flight against one snapshot is how one of them
    // silently disappears. The chain is what makes "append, then append" mean it.
    let stored = 'start'
    mockRpc.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === Rpc.automationsRead) return served(stored)
      stored = params?.markdown as string
      return { ok: true }
    })

    await Promise.all([
      editAutomations((markdown) => `${markdown}|one`),
      editAutomations((markdown) => `${markdown}|two`)
    ])

    expect(stored).toBe('start|one|two')
  })

  it('abandons the edit when the block it was going to touch is gone', async () => {
    mockRpc.mockImplementation(async (method: string) =>
      method === Rpc.automationsRead ? served('a') : { ok: true }
    )
    const result = await editAutomations(() => null)
    expect(result).toBeNull()
    expect(mockRpc).not.toHaveBeenCalledWith(Rpc.automationsWrite, expect.anything())
  })

  it('leaves the cached file untouched when the write fails', async () => {
    queryClient.setQueryData(automationKeys.snapshot, served('stored'))
    mockRpc.mockImplementation(async (method: string) => {
      if (method === Rpc.automationsRead) return served('stored')
      throw new Error('write refused')
    })
    await expect(editAutomations(() => 'attempted')).rejects.toThrow('write refused')
    expect(
      (queryClient.getQueryData(automationKeys.snapshot) as { markdown: string }).markdown
    ).toBe('stored')
  })

  it('folds a run-pool push in without a fetch', () => {
    queryClient.setQueryData(automationKeys.snapshot, served('a'))
    applyRunsPush({
      running: [{ id: 'j', label: 'Daily (09:00)', kind: 'automation' }],
      queued: []
    })
    const snapshot = queryClient.getQueryData(automationKeys.snapshot) as {
      markdown: string
      runs: { running: Array<{ label: string }> }
    }
    expect(snapshot.markdown).toBe('a')
    expect(snapshot.runs.running[0].label).toBe('Daily (09:00)')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('ignores a run push before the snapshot exists', () => {
    // Nothing to fold into, and inventing a snapshot with an empty file would
    // render an empty automations list until the real read landed.
    applyRunsPush({ running: [], queued: [] })
    expect(queryClient.getQueryData(automationKeys.snapshot)).toBeUndefined()
  })
})
