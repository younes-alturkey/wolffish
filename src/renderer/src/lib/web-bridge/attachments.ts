import i18n from '@lib/i18n'
import { isWeb } from '@lib/utils/platform'
import { randomId } from '@lib/utils/randomId'
import {
  emitUploadProgress,
  isPickedPath,
  takePickedFile,
  uploadToStaging
} from '@lib/web-bridge/picked-files'
import type { MessageAttachment } from '@preload/index'

/**
 * Send time in the Web UI: the files behind the composer's virtual paths go
 * up now, one after another with progress, each becomes a real attachment
 * through the same save handler the desktop uses, and the message leaves
 * with real workspace paths. Off the web, and for attachments that already
 * have real paths, this is a pass-through. Throws on the first failure, with
 * the rest of the files still held, so the caller can put the composer back.
 */
export async function finalizeAttachments(
  conversationId: string,
  attachments: MessageAttachment[]
): Promise<MessageAttachment[]> {
  if (!isWeb) return attachments
  const count = attachments.filter((a) => isPickedPath(a.filePath)).length
  if (count === 0) return attachments
  const id = randomId()
  const out: MessageAttachment[] = []
  let index = 0
  for (const attachment of attachments) {
    if (!isPickedPath(attachment.filePath)) {
      out.push(attachment)
      continue
    }
    index++
    const file = takePickedFile(attachment.filePath)
    if (!file) throw new Error(i18n.t('web.upload.lost', { name: attachment.originalName }))
    const report = (loaded: number, done: boolean, error: string | null = null): void =>
      emitUploadProgress({
        id,
        name: file.name,
        loaded,
        total: file.size,
        index,
        count,
        done,
        error
      })
    report(0, false)
    try {
      const staged = await uploadToStaging(file, file.name, (loaded) => report(loaded, false))
      const saved = await window.api.upload.saveFile({ conversationId, sourcePath: staged.path })
      out.push(saved)
      report(file.size, index === count)
    } catch (err) {
      report(0, true, err instanceof Error ? err.message : String(err))
      throw err
    }
  }
  return out
}
