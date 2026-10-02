/**
 * Mobile file-transfer tests — pins the tunnel's file RPCs on the desktop
 * end: workspace-scoped path validation, chunked reads that reassemble to the
 * exact bytes on disk, and the chunked upload session (begin → sequential
 * chunks → commit) including the failure modes that must refuse rather than
 * store a corrupt file (out-of-order chunk, short upload).
 *
 * The channel is driven through a fake tunnel that just captures onRpc
 * handlers — no relay, no crypto; those live in their own tests. HOME is
 * pointed at a temp dir BEFORE any import so workspaceRoot() lands there and
 * nothing touches the real ~/.wolffish.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/mobile-file-transfer.test.ts
 */

import Module from 'node:module'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// workspaceRoot() reads os.homedir() at module import — override first.
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'wolffish-mobile-files-'))
process.env.HOME = SANDBOX

// Shim `electron` so the channel's import graph (safeStorage in keys.ts,
// app in snapshot.ts/workspace.ts) loads outside an Electron process.
const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => os.tmpdir() },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (s: string) => Buffer.from(s),
        decryptString: (b: Buffer) => b.toString()
      }
    }
  }
  return origLoad.apply(this, args)
}

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
}

async function throws(label: string, fn: () => Promise<unknown>, pattern?: RegExp): Promise<void> {
  try {
    await fn()
    ok(label, false, 'did not throw')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ok(label, pattern ? pattern.test(message) : true, message)
  }
}

/** Deterministic pseudo-random bytes, sized to cross chunk boundaries. */
function sampleBytes(length: number): Buffer {
  const bytes = Buffer.alloc(length)
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + 7) % 256
  return bytes
}

type RpcHandler = (params: Record<string, unknown>) => Promise<unknown> | unknown

async function run(): Promise<void> {
  const { MobileChannel } = await import('@main/channels/mobile/channel')
  const { Rpc, CHUNK_SIZE } = await import('@main/tunnel/protocol')
  const { workspaceRoot } = await import('@main/workspace/root')
  const { loadConversation } = await import('@main/conversations')
  const fs = await import('node:fs/promises')

  ok('sandboxed workspace', workspaceRoot().startsWith(SANDBOX), workspaceRoot())

  const channel = new MobileChannel({
    agent: {},
    runner: {},
    serializeCapabilities: async () => []
  } as never)

  const handlers = new Map<string, RpcHandler>()
  const fakeTunnel = {
    onRpc: (method: string, handler: RpcHandler) => handlers.set(method, handler),
    emit: () => undefined
  }
  ;(channel as unknown as { registerHandlers: (t: unknown) => void }).registerHandlers(fakeTunnel)
  const call = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const handler = handlers.get(method)
    if (!handler) throw new Error(`no handler registered for ${method}`)
    return Promise.resolve(handler(params))
  }

  // ------------------------------------------------------------- stat + read
  const filesDir = path.join(workspaceRoot(), 'files')
  await fs.mkdir(filesDir, { recursive: true })
  // Deliberately NOT a multiple of CHUNK_SIZE: the last window is short.
  const source = sampleBytes(CHUNK_SIZE * 2 + 175_713)
  await fs.writeFile(path.join(filesDir, 'report.pdf'), source)

  const stat = (await call(Rpc.fileStat, { path: 'files/report.pdf' })) as {
    exists: boolean
    sizeBytes: number
  }
  ok('stat: exists with exact size', stat.exists && stat.sizeBytes === source.length)

  const missing = (await call(Rpc.fileStat, { path: 'files/nope.pdf' })) as { exists: boolean }
  ok('stat: missing file answers exists=false', missing.exists === false)

  await throws(
    'stat: traversal refused',
    () => call(Rpc.fileStat, { path: '../outside.txt' }),
    /invalid path/
  )
  await throws(
    'read: absolute path refused',
    () => call(Rpc.fileRead, { path: '/etc/hosts' }),
    /invalid path/
  )

  // Reassemble through the same loop the phone runs.
  const pieces: Buffer[] = []
  let offset = 0
  while (offset < source.length) {
    const chunk = (await call(Rpc.fileRead, {
      path: 'files/report.pdf',
      offset,
      length: CHUNK_SIZE
    })) as { data: string; sizeBytes: number }
    ok(`read@${offset}: reports full size`, chunk.sizeBytes === source.length)
    const bytes = Buffer.from(chunk.data, 'base64url')
    ok(`read@${offset}: window bounded`, bytes.length > 0 && bytes.length <= CHUNK_SIZE)
    pieces.push(bytes)
    offset += bytes.length
  }
  ok('read: reassembles byte-identical', Buffer.concat(pieces).equals(source))
  ok('read: three windows for 2×CHUNK+tail', pieces.length === 3, String(pieces.length))

  const past = (await call(Rpc.fileRead, {
    path: 'files/report.pdf',
    offset: source.length + 5,
    length: CHUNK_SIZE
  })) as { data: string }
  ok('read: past-EOF window is empty', Buffer.from(past.data, 'base64url').length === 0)

  const capped = (await call(Rpc.fileRead, {
    path: 'files/report.pdf',
    offset: 0,
    length: CHUNK_SIZE * 50
  })) as { data: string }
  ok(
    'read: oversized ask capped at CHUNK_SIZE',
    Buffer.from(capped.data, 'base64url').length === CHUNK_SIZE
  )

  // ------------------------------------------------------------------ upload
  const payload = sampleBytes(CHUNK_SIZE + 51_200)
  const begin = (await call(Rpc.uploadBegin, {
    name: 'voice-1.m4a',
    mimeType: 'audio/mp4',
    sizeBytes: payload.length
  })) as { uploadId: string; conversationId: string }
  ok(
    'uploadBegin: mints an upload id',
    typeof begin.uploadId === 'string' && begin.uploadId.length > 0
  )
  ok('uploadBegin: created a conversation', (await loadConversation(begin.conversationId)) !== null)

  let sent = 0
  while (sent < payload.length) {
    const window = payload.subarray(sent, sent + CHUNK_SIZE)
    const result = (await call(Rpc.uploadChunk, {
      uploadId: begin.uploadId,
      offset: sent,
      data: window.toString('base64url')
    })) as { received: number }
    sent += window.length
    ok(`uploadChunk@${sent}: acks received`, result.received === sent)
  }
  const committed = (await call(Rpc.uploadCommit, { uploadId: begin.uploadId })) as {
    type: string
    filePath: string
    originalName: string
    sizeBytes: number
    conversationId: string
  }
  ok('uploadCommit: classified audio', committed.type === 'audio', committed.type)
  ok(
    'uploadCommit: filed under the conversation uploads dir',
    committed.filePath.startsWith('uploads/conv-')
  )
  ok('uploadCommit: same conversation as begin', committed.conversationId === begin.conversationId)
  const stored = await fs.readFile(path.join(workspaceRoot(), committed.filePath))
  ok('uploadCommit: bytes byte-identical', stored.equals(payload))

  // Served straight back: what the phone uploads it can also re-download.
  const echo = (await call(Rpc.fileRead, {
    path: committed.filePath,
    offset: 0,
    length: CHUNK_SIZE
  })) as { sizeBytes: number }
  ok('uploaded file is servable', echo.sizeBytes === payload.length)

  // Same name again → Finder-style rename, never an overwrite.
  const second = (await call(Rpc.uploadBegin, {
    name: 'voice-1.m4a',
    mimeType: 'audio/mp4',
    sizeBytes: 4,
    conversationId: begin.conversationId
  })) as { uploadId: string }
  await call(Rpc.uploadChunk, {
    uploadId: second.uploadId,
    offset: 0,
    data: Buffer.from('abcd').toString('base64url')
  })
  const renamed = (await call(Rpc.uploadCommit, { uploadId: second.uploadId })) as {
    originalName: string
  }
  ok('upload collision renamed', renamed.originalName === 'voice-1 (1).m4a', renamed.originalName)

  // ------------------------------------------------------- upload rejections
  const short = (await call(Rpc.uploadBegin, { name: 'x.bin', sizeBytes: 10 })) as {
    uploadId: string
  }
  await call(Rpc.uploadChunk, {
    uploadId: short.uploadId,
    offset: 0,
    data: Buffer.from('abcd').toString('base64url')
  })
  await throws(
    'commit refuses a short upload',
    () => call(Rpc.uploadCommit, { uploadId: short.uploadId }),
    /incomplete/
  )

  const disorder = (await call(Rpc.uploadBegin, { name: 'y.bin', sizeBytes: 10 })) as {
    uploadId: string
  }
  await call(Rpc.uploadChunk, {
    uploadId: disorder.uploadId,
    offset: 0,
    data: Buffer.from('abcd').toString('base64url')
  })
  await throws(
    'out-of-order chunk refused',
    () =>
      call(Rpc.uploadChunk, {
        uploadId: disorder.uploadId,
        offset: 3,
        data: Buffer.from('zz').toString('base64url')
      }),
    /out of order/
  )
  await throws(
    'aborted upload is gone',
    () => call(Rpc.uploadCommit, { uploadId: disorder.uploadId }),
    /unknown upload/
  )

  await throws(
    'oversized declaration refused',
    () => call(Rpc.uploadBegin, { name: 'big.bin', sizeBytes: 1024 * 1024 * 1024 }),
    /out of range/
  )

  // No pending upload may outlive the test — a live idle timer holds the
  // process open for ten minutes.
  await (channel as unknown as { abortAllUploads: () => Promise<void> }).abortAllUploads()

  // ------------------------------------------------------ attachment gating
  const sanitize = (raw: unknown): Promise<unknown[]> =>
    (
      channel as unknown as { sanitizeAttachments: (r: unknown) => Promise<unknown[]> }
    ).sanitizeAttachments(raw)
  const kept = (await sanitize([
    { filePath: committed.filePath, originalName: 'voice-1.m4a', mimeType: 'audio/mp4' },
    { filePath: 'uploads/conv-x/ghost.pdf', originalName: 'ghost.pdf' },
    { filePath: '../escape.pdf', originalName: 'escape.pdf' }
  ])) as Array<{ filePath: string; type: string; sizeBytes: number }>
  ok('sanitize: keeps only files with bytes on disk', kept.length === 1, String(kept.length))
  ok(
    'sanitize: re-derives type and size',
    kept[0]?.type === 'audio' && kept[0]?.sizeBytes === payload.length
  )

  await fs.rm(SANDBOX, { recursive: true, force: true })
  console.log(`${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void run()
