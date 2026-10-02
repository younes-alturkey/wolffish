import type { proto } from '@whiskeysockets/baileys'

/**
 * Message wrapper keys that WhatsApp nests real content inside.
 * Recursively unwrapped (up to 4 levels) before extraction.
 */
const WRAPPER_KEYS: ReadonlyArray<keyof proto.IMessage> = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage'
]

/**
 * Recursively unwrap WhatsApp message wrappers to reach the inner
 * content message. Returns the deepest non-wrapper message found,
 * or the original if no wrappers are present.
 */
export function unwrapMessage(msg: proto.IMessage, depth = 0): proto.IMessage {
  if (depth >= 4) return msg
  for (const key of WRAPPER_KEYS) {
    const wrapper = msg[key] as { message?: proto.IMessage } | undefined
    if (wrapper?.message) return unwrapMessage(wrapper.message, depth + 1)
  }
  return msg
}

/**
 * Extract text body from an inbound WhatsApp message. Follows the
 * same priority chain OpenClaw uses:
 *  1. conversation (plain text)
 *  2. extendedTextMessage.text
 *  3. caption from image/video/document
 *  4. media placeholder for non-text content
 */
export function extractTextBody(raw: proto.IWebMessageInfo): string | null {
  const msg = raw.message
  if (!msg) return null

  const inner = unwrapMessage(msg)

  // Plain text
  const conversation = inner.conversation?.trim()
  if (conversation) return conversation

  // Extended text (links, formatting, mentions)
  const extended = inner.extendedTextMessage?.text?.trim()
  if (extended) return extended

  // Captions on media
  const caption =
    inner.imageMessage?.caption?.trim() ??
    inner.videoMessage?.caption?.trim() ??
    inner.documentMessage?.caption?.trim()
  if (caption) return caption

  // Media placeholders — let the agent know something was sent
  if (inner.imageMessage) return '<media:image>'
  if (inner.videoMessage) return '<media:video>'
  if (inner.audioMessage) return '<media:audio>'
  if (inner.documentMessage) return '<media:document>'
  if (inner.stickerMessage) return '<media:sticker>'
  if (inner.locationMessage) {
    const lat = inner.locationMessage.degreesLatitude
    const lng = inner.locationMessage.degreesLongitude
    return `<location:${lat},${lng}>`
  }
  if (inner.contactMessage) {
    const name = inner.contactMessage.displayName
    return name ? `<contact:${name}>` : '<contact>'
  }

  return null
}

/**
 * True when the message is a push-to-talk voice note (the mic button),
 * which we download + transcribe. Forwarded music / attached audio files
 * (audioMessage without ptt) are intentionally excluded — they keep the
 * '<media:audio>' placeholder behaviour, mirroring Telegram which only
 * transcribes `message:voice` and treats `message:audio` as a plain file.
 */
export function isInboundVoiceNote(raw: proto.IWebMessageInfo): boolean {
  const msg = raw.message
  if (!msg) return false
  return unwrapMessage(msg).audioMessage?.ptt === true
}

/**
 * Downloadable inbound media kinds. Voice notes (ptt) are intentionally
 * excluded — they are transcribed, not attached (see isInboundVoiceNote).
 */
export type InboundMediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker'

export type InboundMedia = {
  kind: InboundMediaKind
  /**
   * Filename to save the download under. ALWAYS carries a usable
   * extension: the sender's document filename when present, otherwise one
   * synthesized from the media mimetype. The extension is load-bearing —
   * classifyFile() derives the attachment type AND mime from it, and the
   * file-processor gates PDF/image handling on that mime, so a missing or
   * wrong extension silently drops the file before the model ever sees it.
   */
  fileName: string
  /** Best-effort mimetype reported by WhatsApp, parameters stripped. */
  mimeType: string
  /** User caption, if any (image / video / document carry one). */
  caption: string | null
  /** Declared byte size for a pre-download size guard, when present. */
  fileLength: number | null
}

/**
 * Map a media mimetype to a file extension. Used to synthesize a filename
 * for media that arrives without one (images, video, audio, stickers) or
 * a document whose filename has no extension.
 */
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/3gpp': '.3gp',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/csv': '.csv',
  'text/tab-separated-values': '.tsv',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/json': '.json',
  'text/html': '.html'
}

/** Strip mimetype parameters: "audio/ogg; codecs=opus" → "audio/ogg". */
function baseMime(mimetype: string | null | undefined): string {
  return (mimetype ?? '').split(';')[0].trim().toLowerCase()
}

/** Baileys stores byte lengths as number | Long | null — normalize to number. */
function toByteCount(len: unknown): number | null {
  if (len == null) return null
  if (typeof len === 'number') return Number.isFinite(len) ? len : null
  const asLong = len as { toNumber?: () => number }
  if (typeof asLong.toNumber === 'function') {
    const n = asLong.toNumber()
    return Number.isFinite(n) ? n : null
  }
  const n = Number(len)
  return Number.isFinite(n) ? n : null
}

/** True when `name` already ends in a plausible file extension. */
function hasExtension(name: string): boolean {
  return /\.[A-Za-z0-9]{1,8}$/.test(name)
}

/**
 * Guarantee a filename carries an extension. Names that already have one
 * are returned untouched; otherwise the mimetype's extension is appended.
 * An unknown mimetype leaves the name bare — an unclassifiable blob the
 * model can still inspect via the shell.
 */
function withExtension(name: string, mimeType: string): string {
  if (hasExtension(name)) return name
  const ext = EXT_BY_MIME[mimeType]
  return ext ? `${name}${ext}` : name
}

/**
 * Extract downloadable media from an inbound WhatsApp message. Returns
 * null for plain text, voice notes (ptt — transcribed elsewhere),
 * locations, contacts, and anything with no media payload.
 *
 * This is the inbound counterpart to the in-app upload pipeline: the
 * channel downloads the bytes, saves them via saveUploadFromBuffer under
 * the returned fileName, and dispatches the turn with the file attached —
 * so a PDF sent over WhatsApp reaches the model exactly like an in-app
 * upload instead of a dead '<media:document>' placeholder the agent
 * cannot act on.
 */
export function extractInboundMedia(raw: proto.IWebMessageInfo): InboundMedia | null {
  const msg = raw.message
  if (!msg) return null
  const inner = unwrapMessage(msg)
  const id = raw.key?.id ?? String(Date.now())

  // Voice notes are transcribed (isInboundVoiceNote), never attached.
  if (inner.audioMessage?.ptt === true) return null

  if (inner.imageMessage) {
    const mimeType = baseMime(inner.imageMessage.mimetype) || 'image/jpeg'
    return {
      kind: 'image',
      fileName: `image_${id}${EXT_BY_MIME[mimeType] ?? '.jpg'}`,
      mimeType,
      caption: inner.imageMessage.caption?.trim() || null,
      fileLength: toByteCount(inner.imageMessage.fileLength)
    }
  }

  if (inner.videoMessage) {
    const mimeType = baseMime(inner.videoMessage.mimetype) || 'video/mp4'
    return {
      kind: 'video',
      fileName: `video_${id}${EXT_BY_MIME[mimeType] ?? '.mp4'}`,
      mimeType,
      caption: inner.videoMessage.caption?.trim() || null,
      fileLength: toByteCount(inner.videoMessage.fileLength)
    }
  }

  // Non-ptt audio (forwarded music, attached audio files) — ptt handled above.
  if (inner.audioMessage) {
    const mimeType = baseMime(inner.audioMessage.mimetype) || 'audio/ogg'
    return {
      kind: 'audio',
      fileName: `audio_${id}${EXT_BY_MIME[mimeType] ?? '.ogg'}`,
      mimeType,
      caption: null,
      fileLength: toByteCount(inner.audioMessage.fileLength)
    }
  }

  if (inner.documentMessage) {
    const mimeType = baseMime(inner.documentMessage.mimetype) || 'application/octet-stream'
    const rawName = inner.documentMessage.fileName?.trim()
    const fileName = withExtension(rawName || `document_${id}`, mimeType)
    return {
      kind: 'document',
      fileName,
      mimeType,
      caption: inner.documentMessage.caption?.trim() || null,
      fileLength: toByteCount(inner.documentMessage.fileLength)
    }
  }

  if (inner.stickerMessage) {
    const mimeType = baseMime(inner.stickerMessage.mimetype) || 'image/webp'
    return {
      kind: 'sticker',
      fileName: `sticker_${id}${EXT_BY_MIME[mimeType] ?? '.webp'}`,
      mimeType,
      caption: null,
      fileLength: toByteCount(inner.stickerMessage.fileLength)
    }
  }

  return null
}

/**
 * Determine whether an inbound message should be forwarded to the
 * agent pipeline or silently dropped. Mirrors OpenClaw's filter chain.
 */
export function shouldProcessMessage(msg: proto.IWebMessageInfo): boolean {
  const key = msg.key
  if (!key?.remoteJid) return false

  // Drop status broadcasts and broadcast lists
  if (key.remoteJid.endsWith('@broadcast')) return false
  if (key.remoteJid.endsWith('@status')) return false
  if (key.remoteJid === 'status@broadcast') return false

  // Drop protocol messages with no user content
  if (!msg.message) return false
  if (hasOnlyProtocolContent(msg.message)) return false

  return true
}

/**
 * Returns true when the message contains only protocol-level content
 * (receipts, typing, reactions, protocol messages) with nothing the
 * agent could meaningfully process.
 */
function hasOnlyProtocolContent(msg: proto.IMessage): boolean {
  const inner = unwrapMessage(msg)

  // These are protocol/system messages, not user content
  if (inner.protocolMessage) return true
  if (inner.reactionMessage) return true
  if (inner.senderKeyDistributionMessage && !inner.conversation && !inner.extendedTextMessage)
    return true

  return false
}

/**
 * Extract the message timestamp as a JS Date. Baileys stores
 * timestamps as either a number (unix seconds) or a Long object.
 */
export function messageTimestamp(msg: proto.IWebMessageInfo): Date {
  const ts = msg.messageTimestamp
  if (!ts) return new Date()
  if (typeof ts === 'number') return new Date(ts * 1000)
  // Long object — toNumber() gives us seconds
  if (typeof (ts as { toNumber?: () => number }).toNumber === 'function') {
    return new Date((ts as { toNumber: () => number }).toNumber() * 1000)
  }
  return new Date(Number(ts) * 1000)
}

/**
 * Extract the sender's phone-format JID from a message key.
 * For DMs this is remoteJid; for groups it's participant.
 * Returns null if the JID is a LID without phone mapping.
 */
export function senderJid(msg: proto.IWebMessageInfo): string | null {
  const key = msg.key
  if (!key?.remoteJid) return null

  // Group messages — participant holds the sender
  if (key.remoteJid.endsWith('@g.us')) {
    return key.participant ?? null
  }

  // DMs — remoteJid is the sender
  return key.remoteJid
}

/**
 * Check whether a JID is a LID (Linked Identity) rather than a
 * phone-based JID. LID JIDs cannot be messaged directly without
 * a phone mapping.
 */
export function isLidJid(jid: string): boolean {
  return /@(lid|hosted\.lid)$/i.test(jid)
}
