import {
  MAX_FILES_PER_MESSAGE,
  MAX_TOTAL_BYTES,
  RELAY_MAX_FILE_BYTES,
  categorizeUpload,
  desktopMaxBytesFor,
  formatLimit,
  maxBytesFor,
  uploadErrorMessage,
  validateUpload
} from '@/lib/files/uploadPolicy'

const MB = 1024 * 1024
const GB = 1024 * MB

/** i18n stand-in: echoes the key and its interpolations. */
const t = (key: string, vars?: Record<string, unknown>): string =>
  vars ? `${key}:${JSON.stringify(vars)}` : key

describe('categorizeUpload', () => {
  it('mirrors the desktop buckets', () => {
    expect(categorizeUpload('photo.JPG')).toBe('image')
    expect(categorizeUpload('scan.pdf')).toBe('pdf')
    expect(categorizeUpload('notes.md')).toBe('document')
    expect(categorizeUpload('sheet.xlsx')).toBe('document')
    expect(categorizeUpload('clip.mov')).toBe('video')
    expect(categorizeUpload('memo.m4a')).toBe('audio')
    expect(categorizeUpload('bundle.zip')).toBe('archive')
  })

  it('refuses what the desktop refuses', () => {
    // HEIC is the one that matters: iPhone photos must be transcoded before
    // they reach here, because the desktop would not take them.
    expect(categorizeUpload('IMG_0001.heic')).toBe('unknown')
    expect(categorizeUpload('archive.tar.gz')).toBe('unknown')
    expect(categorizeUpload('.gitignore')).toBe('unknown')
    expect(categorizeUpload('noextension')).toBe('unknown')
    expect(categorizeUpload('app.exe')).toBe('unknown')
  })

  it('reads .webm as audio, like the desktop', () => {
    // .webm sits in the desktop's audio table and not its video one.
    expect(categorizeUpload('voice.webm')).toBe('audio')
    expect(maxBytesFor('audio')).toBe(512 * MB)
  })

  it('takes the extension from the basename, not the path', () => {
    expect(categorizeUpload('/tmp/a.png/report.pdf')).toBe('pdf')
  })
})

describe('caps', () => {
  it('keeps the desktop values', () => {
    expect(desktopMaxBytesFor('image')).toBe(1 * GB)
    expect(desktopMaxBytesFor('video')).toBe(1 * GB)
    expect(desktopMaxBytesFor('pdf')).toBe(512 * MB)
    expect(desktopMaxBytesFor('unknown')).toBe(0)
  })

  it('clamps the desktop 1 GB types to what the tunnel can carry', () => {
    expect(maxBytesFor('image')).toBe(RELAY_MAX_FILE_BYTES)
    expect(maxBytesFor('video')).toBe(RELAY_MAX_FILE_BYTES)
    // Already under the relay ceiling — unchanged.
    expect(maxBytesFor('pdf')).toBe(512 * MB)
  })
})

describe('validateUpload', () => {
  it('accepts an ordinary photo', () => {
    expect(validateUpload('photo.png', 2 * MB, 0, 0)).toBeNull()
  })

  it('reports an unsupported type before anything else', () => {
    // Over every other limit too — type still wins, as on the desktop.
    expect(validateUpload('clip.heic', 2 * GB, MAX_FILES_PER_MESSAGE, MAX_TOTAL_BYTES)).toEqual({
      code: 'type_not_supported'
    })
  })

  it('stops at ten files per message', () => {
    expect(validateUpload('photo.png', MB, MAX_FILES_PER_MESSAGE, 0)).toEqual({
      code: 'max_files_reached',
      max: 10
    })
    expect(validateUpload('photo.png', MB, MAX_FILES_PER_MESSAGE - 1, 0)).toBeNull()
  })

  it('stops at 1 GB across the message', () => {
    expect(validateUpload('photo.png', 2 * MB, 1, MAX_TOTAL_BYTES - MB)).toEqual({
      code: 'total_size_exceeded',
      maxBytes: MAX_TOTAL_BYTES
    })
  })

  it('rejects a video the desktop would take but the relay cannot carry', () => {
    // 700 MB is under the desktop's 1 GB video cap and over the tunnel's.
    expect(validateUpload('holiday.mp4', 700 * MB, 0, 0)).toEqual({
      code: 'file_too_large',
      maxBytes: RELAY_MAX_FILE_BYTES
    })
    expect(validateUpload('holiday.mp4', 500 * MB, 0, 0)).toBeNull()
  })
})

describe('messages', () => {
  it('formats a limit as a whole number in its own unit', () => {
    expect(formatLimit(512 * MB, t)).toBe('units.megabytes:{"value":"⁨512⁩"}')
    expect(formatLimit(1 * GB, t)).toBe('units.gigabytes:{"value":"⁨1⁩"}')
  })

  it('names the desktop key for every error', () => {
    expect(uploadErrorMessage({ code: 'type_not_supported' }, t)).toBe(
      'chat.upload.typeNotSupported'
    )
    expect(uploadErrorMessage({ code: 'max_files_reached', max: 10 }, t)).toContain(
      'chat.upload.maxFiles'
    )
    expect(uploadErrorMessage({ code: 'file_too_large', maxBytes: 512 * MB }, t)).toContain(
      'chat.upload.fileTooLarge'
    )
    expect(uploadErrorMessage({ code: 'total_size_exceeded', maxBytes: GB }, t)).toContain(
      'chat.upload.totalExceeded'
    )
  })
})
