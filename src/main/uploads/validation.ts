import path from 'node:path'

export const MAX_FILES_PER_MESSAGE = 10
export const MAX_TOTAL_BYTES = 1024 * 1024 * 1024 // 1 GB
export const MAX_IMAGE_BYTES = 1024 * 1024 * 1024 // 1 GB
export const MAX_PDF_BYTES = 512 * 1024 * 1024 // 512 MB
export const MAX_DOCUMENT_BYTES = 512 * 1024 * 1024 // 512 MB
export const MAX_AUDIO_BYTES = 512 * 1024 * 1024 // 512 MB
export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024 // 1 GB
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024 // 512 MB

const ALLOWED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
const ALLOWED_PDF_EXTS = new Set(['.pdf'])
const ALLOWED_DOCUMENT_EXTS = new Set([
  '.docx',
  '.xlsx',
  '.xls',
  '.csv',
  '.tsv',
  '.txt',
  '.md',
  '.json',
  '.pptx',
  '.html',
  '.htm'
])
const ALLOWED_AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.webm'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.m4v', '.wmv', '.flv'])
// Zip only — the archive capability is zip-only, so accepting a .tar.gz here
// would promise handling the tools don't have. Must stay in sync with
// uploads.ts ARCHIVE_EXTS and file-processor.ts ARCHIVE_EXTS.
const ALLOWED_ARCHIVE_EXTS = new Set(['.zip'])

export type FileCategory = 'image' | 'pdf' | 'document' | 'audio' | 'video' | 'archive' | 'unknown'

export type ValidationError =
  | { code: 'file_too_large'; maxBytes: number }
  | { code: 'max_files_reached'; max: number }
  | { code: 'total_size_exceeded'; maxBytes: number }
  | { code: 'type_not_supported' }

export function categorizeFile(fileName: string): FileCategory {
  const ext = path.extname(fileName).toLowerCase()
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (ALLOWED_IMAGE_EXTS.has(ext)) return 'image'
  if (ALLOWED_PDF_EXTS.has(ext)) return 'pdf'
  if (ALLOWED_DOCUMENT_EXTS.has(ext)) return 'document'
  if (ALLOWED_AUDIO_EXTS.has(ext)) return 'audio'
  if (ALLOWED_ARCHIVE_EXTS.has(ext)) return 'archive'
  return 'unknown'
}

export function getMaxBytesForCategory(category: FileCategory): number {
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

export function validateFile(
  fileName: string,
  sizeBytes: number,
  currentFileCount: number,
  currentTotalBytes: number
): ValidationError | null {
  const category = categorizeFile(fileName)

  if (category === 'unknown') return { code: 'type_not_supported' }
  if (currentFileCount >= MAX_FILES_PER_MESSAGE)
    return { code: 'max_files_reached', max: MAX_FILES_PER_MESSAGE }
  if (currentTotalBytes + sizeBytes > MAX_TOTAL_BYTES)
    return { code: 'total_size_exceeded', maxBytes: MAX_TOTAL_BYTES }

  const maxForType = getMaxBytesForCategory(category)
  if (sizeBytes > maxForType) return { code: 'file_too_large', maxBytes: maxForType }

  return null
}
