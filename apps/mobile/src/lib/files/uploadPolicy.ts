/**
 * What may be attached to a message, and how big.
 *
 * A port of the desktop's src/main/uploads/validation.ts — same categories,
 * same extension sets, same limits, same error codes, checked in the same
 * order. The phone validates BEFORE it uploads because the alternative is
 * spending a minute pushing a 400 MB file over the relay only for the desktop
 * to refuse it; the desktop still validates on its own side, and this is the
 * mirror, never the authority.
 *
 * One rule is the phone's alone: the tunnel caps a single upload at 512 MB
 * (MobileChannel.MAX_UPLOAD_BYTES), which is BELOW the desktop's own 1 GB
 * ceiling for images and video. A 700 MB video dropped on the desktop composer
 * is fine; the same file sent from here is not, and `uploadBegin` would answer
 * "upload size out of range" halfway through the user's evening. So the
 * effective per-file cap is the lower of the two and the user is told at the
 * pick, in the same words the desktop uses for its own limits.
 *
 * Keep in sync with wolffish-app:
 *   src/main/uploads/validation.ts        — categories, extensions, caps
 *   src/main/channels/mobile/channel.ts   — MAX_UPLOAD_BYTES
 */

export const MAX_FILES_PER_MESSAGE = 10
export const MAX_TOTAL_BYTES = 1024 * 1024 * 1024 // 1 GB
export const MAX_IMAGE_BYTES = 1024 * 1024 * 1024 // 1 GB
export const MAX_PDF_BYTES = 512 * 1024 * 1024 // 512 MB
export const MAX_DOCUMENT_BYTES = 512 * 1024 * 1024 // 512 MB
export const MAX_AUDIO_BYTES = 512 * 1024 * 1024 // 512 MB
export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024 // 1 GB
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024 // 512 MB

/** The tunnel's ceiling for one upload — channel.ts MAX_UPLOAD_BYTES. */
export const RELAY_MAX_FILE_BYTES = 512 * 1024 * 1024 // 512 MB

const ALLOWED_IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp'])
const ALLOWED_PDF_EXTS = new Set(['pdf'])
const ALLOWED_DOCUMENT_EXTS = new Set([
  'docx',
  'xlsx',
  'xls',
  'csv',
  'tsv',
  'txt',
  'md',
  'json',
  'pptx',
  'html',
  'htm'
])
const ALLOWED_AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'webm'])
const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'm4v', 'wmv', 'flv'])
// Zip only — the desktop's archive capability is zip-only, so accepting a
// .tar.gz here would promise handling the tools don't have.
const ALLOWED_ARCHIVE_EXTS = new Set(['zip'])

export type UploadCategory =
  'image' | 'pdf' | 'document' | 'audio' | 'video' | 'archive' | 'unknown'

export type UploadValidationError =
  | { code: 'file_too_large'; maxBytes: number }
  | { code: 'max_files_reached'; max: number }
  | { code: 'total_size_exceeded'; maxBytes: number }
  | { code: 'type_not_supported' }

/** Lowercase extension without the dot; '' when the name has none. */
function extensionOf(fileName: string): string {
  const name = fileName.trim().split(/[/\\]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

export function categorizeUpload(fileName: string): UploadCategory {
  const ext = extensionOf(fileName)
  // Video first, exactly as the desktop orders it: .webm is in both the audio
  // and the video table there, and video wins.
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (ALLOWED_IMAGE_EXTS.has(ext)) return 'image'
  if (ALLOWED_PDF_EXTS.has(ext)) return 'pdf'
  if (ALLOWED_DOCUMENT_EXTS.has(ext)) return 'document'
  if (ALLOWED_AUDIO_EXTS.has(ext)) return 'audio'
  if (ALLOWED_ARCHIVE_EXTS.has(ext)) return 'archive'
  return 'unknown'
}

/** The desktop's cap for a category, before the relay's own is applied. */
export function desktopMaxBytesFor(category: UploadCategory): number {
  switch (category) {
    case 'image':
      return MAX_IMAGE_BYTES
    case 'pdf':
      return MAX_PDF_BYTES
    case 'document':
      return MAX_DOCUMENT_BYTES
    case 'audio':
      return MAX_AUDIO_BYTES
    case 'video':
      return MAX_VIDEO_BYTES
    case 'archive':
      return MAX_ARCHIVE_BYTES
    default:
      return 0
  }
}

/**
 * What this file may actually weigh when sent from a phone: the desktop's cap
 * for its type, clamped to what one upload can carry over the tunnel.
 */
export function maxBytesFor(category: UploadCategory): number {
  const desktopMax = desktopMaxBytesFor(category)
  if (desktopMax === 0) return 0
  return Math.min(desktopMax, RELAY_MAX_FILE_BYTES)
}

/**
 * Validate one file against the limits and everything already staged. Returns
 * null when it may be attached. Checked in the desktop's order so a batch that
 * trips two rules reports the same one on both surfaces.
 */
export function validateUpload(
  fileName: string,
  sizeBytes: number,
  currentFileCount: number,
  currentTotalBytes: number
): UploadValidationError | null {
  const category = categorizeUpload(fileName)

  if (category === 'unknown') return { code: 'type_not_supported' }
  if (currentFileCount >= MAX_FILES_PER_MESSAGE)
    return { code: 'max_files_reached', max: MAX_FILES_PER_MESSAGE }
  if (currentTotalBytes + sizeBytes > MAX_TOTAL_BYTES)
    return { code: 'total_size_exceeded', maxBytes: MAX_TOTAL_BYTES }

  const maxForType = maxBytesFor(category)
  if (sizeBytes > maxForType) return { code: 'file_too_large', maxBytes: maxForType }

  return null
}

const BYTE_UNIT_KEYS = ['units.bytes', 'units.kilobytes', 'units.megabytes', 'units.gigabytes']

/**
 * The desktop's formatBytesL(bytes, t, 0): a whole-number limit in its natural
 * unit, through the `units.*` keys so the word reads natively in Arabic. The
 * digits are bidi-isolated, or an RTL run swallows them and strands the unit.
 */
export function formatLimit(
  bytes: number,
  t: (key: string, vars: { value: string }) => string
): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNIT_KEYS.length - 1) {
    value /= 1024
    unit++
  }
  return t(BYTE_UNIT_KEYS[unit], { value: `⁨${value.toFixed(0)}⁩` })
}

/** The toast a rejected file gets — the desktop's chat.upload.* messages. */
export function uploadErrorMessage(
  error: UploadValidationError,
  t: (key: string, vars?: Record<string, unknown>) => string
): string {
  switch (error.code) {
    case 'file_too_large':
      return t('chat.upload.fileTooLarge', { limit: formatLimit(error.maxBytes, t) })
    case 'max_files_reached':
      return t('chat.upload.maxFiles', { count: error.max })
    case 'total_size_exceeded':
      return t('chat.upload.totalExceeded', { limit: formatLimit(error.maxBytes, t) })
    case 'type_not_supported':
      return t('chat.upload.typeNotSupported')
  }
}
