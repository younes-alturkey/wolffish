/**
 * The send path for a message carrying files.
 *
 * What matters here is not that bytes move — files.ts does that and the
 * simulator run proves it end to end — but the ORDER and the bookkeeping
 * around them, which is where a mobile upload can quietly diverge from a
 * desktop one:
 *
 *  - the conversation the desktop mints for the FIRST file has to carry the
 *    rest of them, or a five-photo message lands in five conversations;
 *  - the path the desktop chose has to be what the message references, not the
 *    name the phone picked, or the attachment is dropped on arrival;
 *  - a file that fails has to cost only itself.
 */

import type { StagedFile } from '@/lib/files/fileCache'
import type { UploadResult } from '@/lib/sync/files'

const mockUpload = jest.fn<
  Promise<UploadResult | null>,
  [string, string, string | null, string | null]
>()
jest.mock('@/lib/sync/files', () => ({
  uploadFileToDesktop: (...args: Parameters<typeof mockUpload>) => mockUpload(...args)
}))

const mockImport = jest.fn<Promise<string | null>, [string, string, string?]>()
const mockStage = jest.fn<Promise<StagedFile | null>, [string, string, string]>()
const mockDiscard = jest.fn<void, [string]>()
jest.mock('@/lib/files/fileCache', () => ({
  importLocalFile: (...args: Parameters<typeof mockImport>) => mockImport(...args),
  stageOutgoingFile: (...args: Parameters<typeof mockStage>) => mockStage(...args),
  discardStagedFile: (...args: Parameters<typeof mockDiscard>) => mockDiscard(...args)
}))

import type { PickedFile } from '@/lib/files/pickAttachments'
import {
  fileLocally,
  stageForSend,
  stagedAttachment,
  uploadForSend,
  type StagedAttachment
} from '@/lib/sync/attachments'

function picked(name: string, extra: Partial<PickedFile> = {}): PickedFile {
  return {
    id: `pick_${name}`,
    uri: `file:///cache/${name}`,
    name,
    mimeType: 'application/octet-stream',
    sizeBytes: 1234,
    ...extra
  }
}

function staged(name: string, extra: Partial<PickedFile> = {}): StagedAttachment {
  const file = picked(name, extra)
  return {
    picked: file,
    staged: {
      relPath: `uploads/.staging/${file.id}/${name}`,
      uri: `file:///workspace/uploads/.staging/${file.id}/${name}`,
      sizeBytes: file.sizeBytes
    }
  }
}

/** What the desktop answers from uploadCommit. */
function committed(name: string, conversationId: string): UploadResult {
  return {
    attachment: {
      type: 'image',
      // The desktop's own path, and its own name — a collision renamed it.
      filePath: `uploads/conv-${conversationId}/${name}`,
      originalName: name,
      mimeType: 'image/png',
      sizeBytes: 999
    },
    conversationId
  }
}

beforeEach(() => {
  mockUpload.mockReset()
  mockImport.mockReset().mockResolvedValue('file:///workspace/landed')
  mockStage.mockReset()
  mockDiscard.mockReset()
})

describe('stageForSend', () => {
  it('keeps the files that landed and drops the ones that did not', async () => {
    mockStage
      .mockResolvedValueOnce({
        relPath: 'uploads/.staging/a/a.png',
        uri: 'file:///a',
        sizeBytes: 10
      })
      .mockResolvedValueOnce(null)
    const out = await stageForSend([picked('a.png'), picked('b.png')])
    expect(out.map((entry) => entry.picked.name)).toEqual(['a.png'])
  })
})

describe('stagedAttachment', () => {
  it('derives the desktop attachment buckets from the name', () => {
    expect(stagedAttachment(staged('photo.png')).type).toBe('image')
    expect(stagedAttachment(staged('clip.mp4')).type).toBe('video')
    expect(stagedAttachment(staged('memo.m4a')).type).toBe('audio')
    expect(stagedAttachment(staged('scan.pdf')).type).toBe('pdf')
    // Everything the desktop stores as `other`: documents, sheets, archives.
    expect(stagedAttachment(staged('sheet.csv')).type).toBe('other')
    expect(stagedAttachment(staged('bundle.zip')).type).toBe('other')
  })

  it('renders from the staging path and carries the phone measurements', () => {
    const attachment = stagedAttachment(staged('photo.png', { width: 400, height: 300 }))
    expect(attachment.filePath).toBe('uploads/.staging/pick_photo.png/photo.png')
    expect(attachment).toMatchObject({ width: 400, height: 300, originalName: 'photo.png' })
  })
})

describe('uploadForSend', () => {
  it('sends the whole batch into the conversation the first upload minted', async () => {
    mockUpload
      .mockResolvedValueOnce(committed('a.png', 'conv-new'))
      .mockResolvedValueOnce(committed('b.png', 'conv-new'))

    const result = await uploadForSend([staged('a.png'), staged('b.png')], null)

    expect(result.conversationId).toBe('conv-new')
    // First call asks for a conversation; every one after it names the answer.
    expect(mockUpload.mock.calls[0][3]).toBeNull()
    expect(mockUpload.mock.calls[1][3]).toBe('conv-new')
    expect(result.attachments.map((a) => a.filePath)).toEqual([
      'uploads/conv-conv-new/a.png',
      'uploads/conv-conv-new/b.png'
    ])
    expect(result.failed).toEqual([])
  })

  it('moves the staged bytes to the path the desktop chose', async () => {
    mockUpload.mockResolvedValueOnce(committed('a.png', 'conv-1'))
    const entry = staged('a.png')

    await uploadForSend([entry], 'conv-1')

    // The bytes this phone just uploaded become the cache entry for the
    // desktop's path — opening the conversation later must not re-download it.
    expect(mockImport).toHaveBeenCalledWith(entry.staged.uri, 'uploads/conv-conv-1/a.png', 'conv-1')
    expect(mockDiscard).toHaveBeenCalledWith(entry.staged.relPath)
  })

  it('carries the phone measurements onto the desktop metadata', async () => {
    mockUpload.mockResolvedValueOnce(committed('clip.mp4', 'conv-1'))
    const result = await uploadForSend(
      [staged('clip.mp4', { width: 1920, height: 1080, durationSeconds: 12.5 })],
      'conv-1'
    )
    expect(result.attachments[0]).toMatchObject({
      filePath: 'uploads/conv-conv-1/clip.mp4',
      width: 1920,
      height: 1080,
      durationSeconds: 12.5
    })
  })

  it('lets a broken transfer cost only its own file', async () => {
    mockUpload
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockResolvedValueOnce(committed('b.png', 'conv-1'))

    const result = await uploadForSend([staged('a.png'), staged('b.png')], 'conv-1')

    expect(result.failed).toEqual(['a.png'])
    expect(result.attachments.map((a) => a.originalName)).toEqual(['b.png'])
    // The file that never went does not leave its bytes staged forever.
    expect(mockDiscard).toHaveBeenCalledWith('uploads/.staging/pick_a.png/a.png')
  })

  it('treats a tunnel that went away mid-batch as a failure of that file', async () => {
    // uploadFileToDesktop answers null when nothing is connected.
    mockUpload.mockResolvedValueOnce(null)
    const result = await uploadForSend([staged('a.png')], 'conv-1')
    expect(result.failed).toEqual(['a.png'])
    expect(result.attachments).toEqual([])
  })
})

describe('fileLocally', () => {
  it('files under the conversation uploads folder, like the desktop would', async () => {
    const entry = staged('photo.png')
    const attachments = await fileLocally([entry], 'conv-7')

    expect(mockImport).toHaveBeenCalledWith(
      entry.staged.uri,
      'uploads/conv-conv-7/photo.png',
      'conv-7'
    )
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({
      type: 'image',
      filePath: 'uploads/conv-conv-7/photo.png',
      originalName: 'photo.png'
    })
  })

  it('drops a file whose bytes never landed', async () => {
    mockImport.mockResolvedValueOnce(null)
    expect(await fileLocally([staged('photo.png')], 'conv-7')).toEqual([])
  })
})
