/**
 * The desktop file transfer across a failure — the resume contract.
 *
 * The incident this pins: a 1.2 MB GIF over a slow link, where each retry
 * used to restart from byte zero, re-pay every window the last attempt had
 * landed, and time out at the same depth forever — the download that "never
 * finishes" while the tunnel is perfectly healthy. A transient failure must
 * leave the partial (and its sidecar) behind, and the next attempt must
 * continue from the byte it stopped at.
 *
 * What may NEVER resume: a partial whose recorded total disagrees with the
 * desktop's current stat, or a pull that catches the file changing size
 * mid-transfer. Bytes from two versions of a file must not meet in one cache
 * entry — those discard the partial and start clean.
 */

// ------------------------------------------------------- in-memory filesystem
// Defined inside the factory: jest.mock is hoisted above the imports that
// trigger it, so an out-of-body class would still be uninitialized when the
// module first loads. The disk map rides out on the mocked module.
jest.mock('expo-file-system', () => {
  const disk = new Map<string, { bytes: number[] }>()
  class File {
    path: string
    constructor(...parts: Array<string | File | { path: string }>) {
      this.path = parts.map((part) => (typeof part === 'string' ? part : part.path)).join('/')
    }
    get name(): string {
      return this.path.split('/').pop() ?? ''
    }
    get parentDirectory(): { path: string } {
      return { path: this.path.split('/').slice(0, -1).join('/') }
    }
    get exists(): boolean {
      return disk.has(this.path)
    }
    get size(): number {
      return disk.get(this.path)?.bytes.length ?? 0
    }
    create(): void {
      disk.set(this.path, { bytes: [] })
    }
    delete(): void {
      disk.delete(this.path)
    }
    write(content: string): void {
      disk.set(this.path, { bytes: Array.from(new TextEncoder().encode(content)) })
    }
    textSync(): string {
      const stored = disk.get(this.path)
      if (!stored) throw new Error(`no file at ${this.path}`)
      return new TextDecoder().decode(new Uint8Array(stored.bytes))
    }
    open(): {
      writeBytes: (bytes: Uint8Array) => void
      readBytes: (count: number) => Uint8Array
      close: () => void
    } {
      const file = this
      let readAt = 0
      return {
        writeBytes(bytes: Uint8Array): void {
          const stored = disk.get(file.path) ?? { bytes: [] }
          // No spread: a CHUNK_SIZE window as spread arguments overflows the
          // call stack.
          for (const byte of bytes) stored.bytes.push(byte)
          disk.set(file.path, stored)
        },
        readBytes(count: number): Uint8Array {
          const stored = disk.get(file.path) ?? { bytes: [] }
          const slice = stored.bytes.slice(readAt, readAt + count)
          readAt += slice.length
          return new Uint8Array(slice)
        },
        close(): void {}
      }
    }
  }
  return { File, FileMode: { Append: 'append', ReadOnly: 'readOnly' }, __disk: disk }
})

// The mocked module IS the handle to the fake filesystem.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockDisk = (require('expo-file-system') as { __disk: Map<string, { bytes: number[] }> })
  .__disk

// ------------------------------------------------------------- fake transport
const mockRpc = jest.fn<Promise<unknown>, [string, Record<string, unknown>, number?]>()
jest.mock('@/lib/tunnel/client', () => ({
  tunnelClient: {
    get active() {
      return { rpc: mockRpc }
    },
    connected: true,
    reportRpcFailure: jest.fn()
  }
}))

import { toBase64Url } from '@/lib/tunnel/pairing'
import { CHUNK_SIZE } from '@/lib/tunnel/protocol'
import { fetchDesktopFileInto } from '@/lib/sync/files'
import { File } from 'expo-file-system'

/** A deterministic source file: byte i = i mod 251, so offsets are provable. */
function sourceBytes(total: number): Uint8Array {
  const bytes = new Uint8Array(total)
  for (let i = 0; i < total; i++) bytes[i] = i % 251
  return bytes
}

/** Serve stat + windowed reads of `source`; `failAt` offsets throw instead. */
function serveFile(source: Uint8Array, failAt: Set<number>, servedSize?: number): void {
  mockRpc.mockImplementation(async (method, params) => {
    if (method === 'desktop.files.stat') {
      return { exists: true, sizeBytes: source.length }
    }
    if (method === 'desktop.files.read') {
      const offset = Number(params.offset)
      if (failAt.has(offset)) throw new Error('desktop.files.read timed out')
      const window = source.subarray(offset, offset + Number(params.length))
      return { data: toBase64Url(window), sizeBytes: servedSize ?? source.length }
    }
    throw new Error(`unexpected rpc ${method}`)
  })
}

const TOTAL = CHUNK_SIZE * 2 + 5_000 // three windows, last one short
const scratchPath = 'cache/downloads/meme.gif'

function readOffsets(): number[] {
  return mockRpc.mock.calls
    .filter(([method]) => method === 'desktop.files.read')
    .map(([, params]) => Number(params.offset))
}

beforeEach(() => {
  mockDisk.clear()
  mockRpc.mockReset()
})

describe('fetchDesktopFileInto resume', () => {
  it('keeps the partial on a transient failure and continues from it', async () => {
    const source = sourceBytes(TOTAL)
    serveFile(source, new Set([CHUNK_SIZE])) // second window dies

    const scratch = new File(scratchPath)
    expect(await fetchDesktopFileInto('uploads/meme.gif', scratch)).toBe('failed')
    // The landed window survives, with the sidecar naming the total it
    // belongs to.
    expect(mockDisk.get(scratchPath)?.bytes.length).toBe(CHUNK_SIZE)
    expect(
      new TextDecoder().decode(new Uint8Array(mockDisk.get(`${scratchPath}.total`)?.bytes ?? []))
    ).toBe(String(TOTAL))

    mockRpc.mockClear()
    serveFile(source, new Set())
    const progress: Array<[number, number]> = []
    expect(
      await fetchDesktopFileInto('uploads/meme.gif', new File(scratchPath), (received, total) =>
        progress.push([received, total])
      )
    ).toBe('done')

    // The second attempt started where the first stopped — no re-paid window
    // — and the bar opened at the resumed byte count, not at zero.
    expect(readOffsets()).toEqual([CHUNK_SIZE, CHUNK_SIZE * 2])
    expect(progress[0]).toEqual([CHUNK_SIZE, TOTAL])
    // The assembled file is byte-for-byte the source, and the sidecar is gone.
    expect(mockDisk.get(scratchPath)?.bytes).toEqual(Array.from(source))
    expect(mockDisk.has(`${scratchPath}.total`)).toBe(false)
  })

  it('refuses to resume when the desktop file changed size between attempts', async () => {
    const source = sourceBytes(TOTAL)
    serveFile(source, new Set([CHUNK_SIZE]))
    expect(await fetchDesktopFileInto('uploads/meme.gif', new File(scratchPath))).toBe('failed')

    // The file was replaced: same path, different size.
    mockRpc.mockClear()
    const replaced = sourceBytes(TOTAL + 999)
    serveFile(replaced, new Set())
    expect(await fetchDesktopFileInto('uploads/meme.gif', new File(scratchPath))).toBe('done')

    // Started over from zero — the stale partial was discarded, and the
    // result is the replacement, whole.
    expect(readOffsets()[0]).toBe(0)
    expect(mockDisk.get(scratchPath)?.bytes).toEqual(Array.from(replaced))
  })

  it('discards the partial when the file changes size mid-transfer', async () => {
    const source = sourceBytes(TOTAL)
    // Window reads report a different current size than the opening stat.
    serveFile(source, new Set(), TOTAL - 100)

    expect(await fetchDesktopFileInto('uploads/meme.gif', new File(scratchPath))).toBe('failed')
    expect(mockDisk.has(scratchPath)).toBe(false)
    expect(mockDisk.has(`${scratchPath}.total`)).toBe(false)
  })

  it('discards the partial when the source answers absent', async () => {
    const source = sourceBytes(TOTAL)
    serveFile(source, new Set([CHUNK_SIZE]))
    expect(await fetchDesktopFileInto('uploads/meme.gif', new File(scratchPath))).toBe('failed')
    expect(mockDisk.has(scratchPath)).toBe(true)

    mockRpc.mockReset()
    mockRpc.mockImplementation(async (method) => {
      if (method === 'desktop.files.stat') return { exists: false, sizeBytes: 0 }
      throw new Error('no reads expected')
    })
    expect(await fetchDesktopFileInto('uploads/meme.gif', new File(scratchPath))).toBe('absent')
    expect(mockDisk.has(scratchPath)).toBe(false)
    expect(mockDisk.has(`${scratchPath}.total`)).toBe(false)
  })

  it('passes the bulk timeout to window reads', async () => {
    const source = sourceBytes(CHUNK_SIZE)
    serveFile(source, new Set())
    expect(await fetchDesktopFileInto('uploads/meme.gif', new File(scratchPath))).toBe('done')
    const readCall = mockRpc.mock.calls.find(([method]) => method === 'desktop.files.read')
    expect(readCall?.[2]).toBe(120_000)
  })
})
