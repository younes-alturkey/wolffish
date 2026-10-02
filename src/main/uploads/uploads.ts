import { conversationDirName, type MessageAttachmentType } from '@main/conversations'
import { diskWriter } from '@main/io/diskWriter'
import { copyFileWithProgress } from '@main/uploads/copy-progress'
// workspace/root, not workspace.ts (which reaches electron): file-processor
// imports this module statically, and its policy tests run under plain node.
import { workspaceRoot } from '@main/workspace/root'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Uploads is core infrastructure (not a capability). Files attached to a
 * conversation land in `workspace/uploads/${conversationDirName(id)}/`,
 * sharing the same per-conversation folder name as the markdown file and
 * voice/speech directories. Renderers read the bytes back through
 * IPC-served readFile (not via a custom protocol) — same pattern voice
 * uses, which keeps Blob URLs scoped to the renderer's lifetime and
 * sidesteps Electron's protocol-handler quirks.
 */

export type UploadedFileMetadata = {
  type: MessageAttachmentType
  filePath: string
  originalName: string
  mimeType: string
  sizeBytes: number
  width?: number
  height?: number
  durationSeconds?: number
}

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.oga', '.flac', '.webm', '.aac'])
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.heic'])
const PDF_EXTS = new Set(['.pdf'])
const DOCUMENT_EXTS = new Set([
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
// Archives ride the `other` bucket like documents, but are kept in their own
// set: the archive capability is zip-only, and the file-processor gives them a
// different reference note (list-then-ask, never auto-extract). Must stay in
// sync with validation.ts ALLOWED_ARCHIVE_EXTS and file-processor.ts.
const ARCHIVE_EXTS = new Set(['.zip'])

const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.webm': 'video/webm',
  '.aac': 'audio/aac',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.m4v': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf'
}

/**
 * Classify a file into a coarse type bucket + mimetype, primarily from its
 * extension. `mimeHint` is a fallback for files whose extension is unknown
 * or absent — inbound channel media (WhatsApp/Telegram) that arrives with a
 * reliable mimetype but no usable filename extension. Without it, such files
 * collapse to `other`/`application/octet-stream`, and the file-processor
 * gates PDF/image handling on the mime, so the model would silently never
 * see the file. The extension still wins when it's meaningful.
 */
export function classifyFile(
  fileName: string,
  mimeHint?: string
): {
  type: MessageAttachmentType
  mimeType: string
} {
  const ext = path.extname(fileName).toLowerCase()
  const mimeType = MIME_BY_EXT[ext] ?? 'application/octet-stream'
  if (AUDIO_EXTS.has(ext)) {
    if (ext === '.webm') return { type: 'audio', mimeType: 'audio/webm' }
    return { type: 'audio', mimeType: mimeType.startsWith('audio/') ? mimeType : 'audio/mpeg' }
  }
  if (VIDEO_EXTS.has(ext)) return { type: 'video', mimeType }
  if (IMAGE_EXTS.has(ext)) return { type: 'image', mimeType }
  if (PDF_EXTS.has(ext)) return { type: 'pdf', mimeType }
  if (DOCUMENT_EXTS.has(ext))
    return { type: 'other', mimeType: DOCUMENT_MIME_BY_EXT[ext] ?? mimeType }
  if (ARCHIVE_EXTS.has(ext)) return { type: 'other', mimeType: 'application/zip' }
  return classifyByMime(mimeHint)
}

/**
 * Fallback classification from a mimetype alone, for extension-less files.
 * Returns the opaque `other`/octet-stream default when the hint is missing
 * or itself opaque.
 */
function classifyByMime(mimeHint?: string): {
  type: MessageAttachmentType
  mimeType: string
} {
  const mime = (mimeHint ?? '').split(';')[0].trim().toLowerCase()
  if (!mime || mime === 'application/octet-stream')
    return { type: 'other', mimeType: 'application/octet-stream' }
  if (mime === 'application/pdf') return { type: 'pdf', mimeType: mime }
  if (mime.startsWith('image/')) return { type: 'image', mimeType: mime }
  if (mime.startsWith('audio/')) return { type: 'audio', mimeType: mime }
  if (mime.startsWith('video/')) return { type: 'video', mimeType: mime }
  return { type: 'other', mimeType: mime }
}

const DOCUMENT_MIME_BY_EXT: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.html': 'text/html',
  '.htm': 'text/html'
}

export function isSupportedExtension(fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase()
  return (
    AUDIO_EXTS.has(ext) ||
    VIDEO_EXTS.has(ext) ||
    IMAGE_EXTS.has(ext) ||
    PDF_EXTS.has(ext) ||
    DOCUMENT_EXTS.has(ext) ||
    ARCHIVE_EXTS.has(ext)
  )
}

function uploadsDir(): string {
  return path.join(workspaceRoot(), 'uploads')
}

function conversationUploadsDir(conversationId: string): string {
  return path.join(uploadsDir(), conversationDirName(conversationId))
}

/**
 * Resolve a workspace-relative path back to an absolute path on disk.
 * Refuses anything that escapes the workspace root so a malformed
 * relativePath can't read arbitrary files via IPC.
 */
export function resolveUploadPath(relativePath: string): string | null {
  if (!relativePath || typeof relativePath !== 'string') return null
  if (relativePath.includes('..')) return null
  const root = workspaceRoot()
  const abs = path.resolve(root, relativePath)
  if (!abs.startsWith(root + path.sep) && abs !== root) return null
  return abs
}

/**
 * Pick a unique filename inside `dir`, appending " (1)", " (2)", … to
 * the stem until nothing collides. Mirrors Finder/Explorer behavior so
 * users uploading the same file twice see both.
 */
async function uniqueFilename(dir: string, originalName: string): Promise<string> {
  const ext = path.extname(originalName)
  const stem = path.basename(originalName, ext)
  let candidate = originalName
  let counter = 0
  while (existsSync(path.join(dir, candidate))) {
    counter += 1
    candidate = `${stem} (${counter})${ext}`
    if (counter > 9999) break
  }
  return candidate
}

/**
 * Copy a source file into `workspace/uploads/${conversationDirName(id)}/`,
 * resolving name collisions by appending a counter. Returns metadata
 * including the path RELATIVE to workspace root (what gets stored in the
 * conversation message) plus the type bucket and mime type.
 *
 * `onProgress` (optional) reports copied bytes while the copy runs — the
 * composer's staging chip draws its ring from it. Omitting it skips the
 * polling entirely, so non-UI callers pay nothing.
 */
export async function saveUpload(
  conversationId: string,
  sourcePath: string,
  onProgress?: (copiedBytes: number, totalBytes: number) => void
): Promise<UploadedFileMetadata> {
  const sourceStat = await fs.stat(sourcePath)
  if (!sourceStat.isFile()) {
    throw new Error(`Not a regular file: ${sourcePath}`)
  }

  const dir = conversationUploadsDir(conversationId)
  await fs.mkdir(dir, { recursive: true })

  const originalName = path.basename(sourcePath)
  const finalName = await uniqueFilename(dir, originalName)
  const destPath = path.join(dir, finalName)
  // The size is known before the first byte moves — emit it immediately so
  // the chip can show a real denominator instead of a mystery spinner.
  onProgress?.(0, sourceStat.size)
  await copyFileWithProgress(
    sourcePath,
    destPath,
    sourceStat.size,
    onProgress ? (copied) => onProgress(copied, sourceStat.size) : undefined
  )

  const { type, mimeType } = classifyFile(finalName)
  const root = workspaceRoot()
  const relPath = path.relative(root, destPath)

  return {
    type,
    filePath: relPath,
    originalName: finalName,
    mimeType,
    sizeBytes: sourceStat.size
  }
}

/**
 * Save an in-memory buffer as a conversation upload. Used by the
 * Telegram channel, which receives files as bytes from grammY rather
 * than as a path on disk. Same naming and collision behavior as
 * saveUpload — Finder-style " (1)" suffix, type/mime classification,
 * relative path returned for the conversation message.
 */
export async function saveUploadFromBuffer(
  conversationId: string,
  buffer: Buffer,
  originalName: string,
  mimeHint?: string
): Promise<UploadedFileMetadata> {
  if (!buffer || buffer.length === 0) {
    throw new Error('saveUploadFromBuffer: empty buffer')
  }
  const dir = conversationUploadsDir(conversationId)
  await fs.mkdir(dir, { recursive: true })

  const safeName = sanitizeFileName(originalName)
  const finalName = await uniqueFilename(dir, safeName)
  const destPath = path.join(dir, finalName)
  await diskWriter.writeFileAtomic(destPath, buffer)

  const { type, mimeType } = classifyFile(finalName, mimeHint)
  const root = workspaceRoot()
  const relPath = path.relative(root, destPath)

  return {
    type,
    filePath: relPath,
    originalName: finalName,
    mimeType,
    sizeBytes: buffer.length
  }
}

/**
 * Adopt an already-staged file (a finished chunked upload from the phone) as
 * a conversation upload. Same naming, collision and classification behavior
 * as saveUploadFromBuffer, but the bytes move with a rename instead of being
 * buffered — the staging area lives under the workspace root precisely so
 * this stays a same-volume atomic move.
 */
export async function saveUploadFromFile(
  conversationId: string,
  stagedPath: string,
  originalName: string,
  mimeHint?: string
): Promise<UploadedFileMetadata> {
  const staged = await fs.stat(stagedPath)
  if (!staged.isFile() || staged.size === 0) {
    throw new Error('saveUploadFromFile: staged upload is empty')
  }
  const dir = conversationUploadsDir(conversationId)
  await fs.mkdir(dir, { recursive: true })

  const safeName = sanitizeFileName(originalName)
  const finalName = await uniqueFilename(dir, safeName)
  const destPath = path.join(dir, finalName)
  await fs.rename(stagedPath, destPath)

  const { type, mimeType } = classifyFile(finalName, mimeHint)
  const root = workspaceRoot()
  const relPath = path.relative(root, destPath)

  return {
    type,
    filePath: relPath,
    originalName: finalName,
    mimeType,
    sizeBytes: staged.size
  }
}

/**
 * Strip path separators and trim to something safe for the filesystem.
 * Telegram document names come from the user's machine and may contain
 * slashes or null bytes on adversarial input. Empty or all-suspect
 * names fall back to a generic placeholder.
 */
export function sanitizeFileName(name: string): string {
  const trimmed = (name ?? '').trim()
  if (!trimmed) return 'upload.bin'
  const stripped = trimmed.replace(/[/\\]/g, '_').replace(/\0/g, '_')
  if (stripped.length === 0) return 'upload.bin'
  return stripped.slice(0, 200)
}

/**
 * Verify an uploaded file still exists on disk. Used when loading past
 * conversations so the renderer can show a "deleted" state for files the
 * user (or some external process) removed since the chat happened.
 */
export async function uploadExists(relativePath: string): Promise<boolean> {
  const abs = resolveUploadPath(relativePath)
  if (!abs) return false
  try {
    const st = await fs.stat(abs)
    return st.isFile()
  } catch {
    return false
  }
}

/**
 * Read an uploaded file's bytes. The renderer wraps the buffer in a Blob
 * and `URL.createObjectURL` to feed `<img>`, `<audio>`, `<video>` — same
 * pattern voice memos already use.
 *
 * Returns null (never throws) for a path that doesn't resolve or a file
 * that isn't readable: a since-deleted file is a designed-for state every
 * caller already renders as a "deleted" placeholder, and a thrown
 * ipcMain.handle error would only spam Electron's "Error occurred in
 * handler" log in the main console for it.
 */
export async function readUpload(relativePath: string): Promise<Buffer | null> {
  const abs = resolveUploadPath(relativePath)
  if (!abs) return null
  try {
    return await fs.readFile(abs)
  } catch {
    return null
  }
}

/**
 * Stat an uploaded file. Returns null when missing; callers display a
 * "deleted" placeholder in that case.
 */
export async function statUpload(
  relativePath: string
): Promise<{ sizeBytes: number; mtimeMs: number } | null> {
  const abs = resolveUploadPath(relativePath)
  if (!abs) return null
  try {
    const st = await fs.stat(abs)
    return { sizeBytes: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}

/**
 * Remove the entire `uploads/${conversationDirName(id)}/` folder. Wired
 * into conversation deletion so a deleted chat doesn't leave orphan
 * media on disk.
 */
export async function deleteConversationUploads(conversationId: string): Promise<void> {
  const dir = conversationUploadsDir(conversationId)
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
}
