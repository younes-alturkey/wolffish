import { randomId } from '@lib/utils/randomId'
import type { MessageAttachment, MessageAttachmentType } from '@preload/index'

/**
 * Files picked, dropped or pasted in the Web UI, held in the page until the
 * message is sent.
 *
 * A browser cannot hand the server a path, only bytes, and the composer
 * deals in paths. So each File gets a virtual path here, the composer stages
 * it the instant it is chosen — name, size, type, no network — and the bytes
 * travel when Send is pressed (attachments.ts), with progress on the pill
 * above the composer. The registry is page state: a reload loses it, and a
 * send that meets a virtual path with no File behind it says so instead of
 * sending air.
 */
export const PICK_SCHEME = 'wolffish-web-pick://'

const picked = new Map<string, File>()

export function registerPickedFile(file: File): string {
  const key = `${PICK_SCHEME}${randomId()}/${file.name}`
  picked.set(key, file)
  return key
}

export function isPickedPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PICK_SCHEME)
}

export function peekPickedFile(virtualPath: string): File | undefined {
  return picked.get(virtualPath)
}

export function takePickedFile(virtualPath: string): File | undefined {
  const file = picked.get(virtualPath)
  picked.delete(virtualPath)
  return file
}

const IMAGE = /\.(jpe?g|png|gif|webp)$/i
const PDF = /\.pdf$/i
const AUDIO = /\.(mp3|wav|ogg|m4a|flac)$/i
const VIDEO = /\.(mp4|mov|avi|mkv|m4v|wmv|flv|webm)$/i

/** The feed's bucket for a file, from its MIME type first and its name second. */
export function attachmentTypeFor(name: string, mime: string): MessageAttachmentType {
  if (mime.startsWith('image/') || IMAGE.test(name)) return 'image'
  if (mime === 'application/pdf' || PDF.test(name)) return 'pdf'
  if (mime.startsWith('audio/') || AUDIO.test(name)) return 'audio'
  if (mime.startsWith('video/') || VIDEO.test(name)) return 'video'
  return 'other'
}

/**
 * What the composer shows the moment a file is picked. The real record,
 * with its workspace path, replaces it when the save runs at send time.
 */
export function pendingAttachmentFor(virtualPath: string, file: File): MessageAttachment {
  return {
    type: attachmentTypeFor(file.name, file.type),
    filePath: virtualPath,
    originalName: file.name,
    mimeType: file.type || 'application/octet-stream',
    sizeBytes: file.size
  }
}

export type Staged = { path: string; name: string; size: number }

/** POST the bytes to the staging route; XHR so the upload reports progress. */
export function uploadToStaging(
  file: Blob,
  name: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<Staged> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/upload?name=${encodeURIComponent(name)}`)
    xhr.responseType = 'json'
    xhr.upload.onprogress = (e) => {
      onProgress?.(e.loaded, e.lengthComputable ? e.total : file.size)
    }
    xhr.onload = () => {
      const body = xhr.response as {
        ok?: boolean
        path?: string
        name?: string
        size?: number
        error?: string
      } | null
      if (xhr.status === 200 && body?.ok && body.path) {
        resolve({ path: body.path, name: body.name ?? name, size: body.size ?? file.size })
      } else {
        reject(new Error(body?.error ?? `upload failed (${xhr.status})`))
      }
    }
    xhr.onerror = () => reject(new Error('upload failed'))
    xhr.send(file)
  })
}

// ── send-time progress, for the pill above the composer ──────────────────────

export type UploadProgress = {
  id: string
  name: string
  loaded: number
  total: number
  /** 1-based position among the files of this send. */
  index: number
  count: number
  done: boolean
  error: string | null
}

const listeners = new Set<(progress: UploadProgress) => void>()

export function onUploadProgress(listener: (progress: UploadProgress) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitUploadProgress(progress: UploadProgress): void {
  for (const listener of listeners) listener(progress)
}
