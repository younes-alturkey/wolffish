import type { MessageAttachment, MessageAttachmentType } from '@/lib/conversations/types'
import {
  discardStagedFile,
  importLocalFile,
  stageOutgoingFile,
  type StagedFile
} from '@/lib/files/fileCache'
import { classifyFile } from '@/lib/files/fileKinds'
import type { PickedFile } from '@/lib/files/pickAttachments'
import { uploadFileToDesktop } from '@/lib/sync/files'

/**
 * Getting the composer's staged files onto the desktop, in the order that keeps
 * the chat honest at every step.
 *
 * The desktop owns the workspace, so it also owns the path: a file dropped on
 * its composer lands in `uploads/conv-…/` under a name IT picks (collisions
 * rename Finder-style), and a file sent from here has to land in exactly the
 * same place — that is the whole point. But the desktop can only answer with
 * that name once the last byte has arrived, and over the relay that is seconds
 * for a photo and a minute for a video. The message is on screen from the tap.
 *
 * So the bytes move twice:
 *
 *   pick   → staged path in the workspace   (bubble renders from the cache)
 *   commit → the desktop's chosen path      (bubble re-renders, same bytes)
 *
 * Both are cache hits, so neither transition costs a download or a frame — the
 * second one is invisible. And because the phone keeps a copy under the real
 * path, opening the conversation later never re-fetches what it just sent.
 */

/** A picked file whose bytes are parked in the workspace, ready to send. */
export type StagedAttachment = {
  picked: PickedFile
  staged: StagedFile
}

/** How a batch ended, per file, so the caller can say what did not go. */
export type DeliveryResult = {
  attachments: MessageAttachment[]
  /** Names of files whose transfer broke. The rest of the message still sends. */
  failed: string[]
  /** The conversation the files landed in — minted by the desktop when the
   *  message that carries them is the first one. */
  conversationId: string | null
}

/**
 * Move each picked file into the workspace so the optimistic bubble has
 * something to render. A file that cannot be staged is dropped here rather
 * than sent: without local bytes there is nothing to upload either.
 */
export async function stageForSend(files: PickedFile[]): Promise<StagedAttachment[]> {
  const out: StagedAttachment[] = []
  for (const picked of files) {
    const staged = await stageOutgoingFile(picked.uri, picked.id, picked.name)
    if (staged) out.push({ picked, staged })
  }
  return out
}

/**
 * The attachment a staged file becomes while it is still only on the phone —
 * what the optimistic bubble draws, and what the demo and offline paths send.
 * The type is re-derived from the name, the same way the desktop derives it,
 * so a card looks identical before and after the round trip.
 */
export function stagedAttachment(entry: StagedAttachment): MessageAttachment {
  return {
    type: attachmentTypeFor(entry.picked.name),
    filePath: entry.staged.relPath,
    originalName: entry.picked.name,
    mimeType: entry.picked.mimeType,
    sizeBytes: entry.staged.sizeBytes || entry.picked.sizeBytes,
    ...media(entry.picked)
  }
}

/**
 * Upload every staged file and answer with the attachments the message should
 * carry — the desktop's own metadata, with the phone's measurements added back
 * (it records width/height/duration for its own uploads; the phone is the only
 * side that knows them for a library asset).
 *
 * Sequential on purpose. Each upload is a run of ordered chunk RPCs and the
 * desktop refuses anything out of order, so interleaving two of them buys
 * nothing and risks the file. A batch does not fail fast: one broken transfer
 * costs its own file, exactly as a bad file costs only itself on the desktop.
 *
 * Only call this with a live connection — the send path checks once, for the
 * whole message, and files everything locally when there is no desktop to
 * reach. A tunnel that drops PART WAY through is a different thing and is
 * reported as what it is: those files failed, and the user is told which.
 */
export async function uploadForSend(
  entries: StagedAttachment[],
  conversationId: string | null
): Promise<DeliveryResult> {
  const attachments: MessageAttachment[] = []
  const failed: string[] = []
  let target = conversationId

  for (const entry of entries) {
    try {
      const result = await uploadFileToDesktop(
        entry.staged.uri,
        entry.picked.name,
        entry.picked.mimeType,
        target
      )
      // Null is uploadFileToDesktop's "nothing is connected". Reaching it here
      // means the link died mid-batch — this file did not go.
      if (!result) throw new Error('tunnel went away mid-upload')

      target = result.conversationId
      // The staged bytes ARE the file the desktop now holds: move them to the
      // path it chose, so the bubble's re-render is a cache hit rather than a
      // download of what this phone just finished uploading.
      await importLocalFile(entry.staged.uri, result.attachment.filePath, target)
      discardStagedFile(entry.staged.relPath)
      attachments.push({ ...result.attachment, ...media(entry.picked) })
    } catch {
      // The transfer broke. Say so rather than sending a message that claims a
      // file the desktop has no bytes for — it would drop the attachment on
      // arrival and the model would never learn there was one.
      discardStagedFile(entry.staged.relPath)
      failed.push(entry.picked.name)
    }
  }

  return { attachments, failed, conversationId: target }
}

/**
 * File the staged bytes locally under a conversation's uploads folder — the
 * demo agent's path, and the one a paired phone takes when its desktop is out
 * of reach. Same shape the desktop would have produced, so the feed renders
 * one kind of attachment either way; the desktop's own copy replaces the
 * conversation wholesale when the link comes back.
 */
export async function fileLocally(
  entries: StagedAttachment[],
  conversationId: string
): Promise<MessageAttachment[]> {
  const attachments: MessageAttachment[] = []
  for (const entry of entries) {
    const relPath = `uploads/conv-${conversationId}/${entry.picked.name}`
    const landed = await importLocalFile(entry.staged.uri, relPath, conversationId)
    discardStagedFile(entry.staged.relPath)
    if (!landed) continue
    attachments.push({ ...stagedAttachment(entry), filePath: relPath })
  }
  return attachments
}

/** Give back every staged file — a send that never happened. */
export function discardStaged(entries: StagedAttachment[]): void {
  for (const entry of entries) discardStagedFile(entry.staged.relPath)
}

function media(picked: PickedFile): Partial<MessageAttachment> {
  return {
    ...(picked.width ? { width: picked.width } : {}),
    ...(picked.height ? { height: picked.height } : {}),
    ...(picked.durationSeconds ? { durationSeconds: picked.durationSeconds } : {})
  }
}

/**
 * The desktop's five attachment buckets, from the name. `classifyFile` is the
 * app's one classifier, and its richer kinds (code, sheet, markdown, html,
 * chart) all collapse into the desktop's `other` — which is exactly what the
 * desktop stores for them too.
 */
function attachmentTypeFor(name: string): MessageAttachmentType {
  const { kind } = classifyFile(name)
  switch (kind) {
    case 'image':
    case 'video':
    case 'audio':
    case 'pdf':
      return kind
    default:
      return 'other'
  }
}
