import { fromBase64Url, toBase64Url } from '@/lib/tunnel/pairing'
import { CHUNK_SIZE, Rpc } from '@/lib/tunnel/protocol'
import { tunnelClient } from '@/lib/tunnel/client'
import { File, FileMode } from 'expo-file-system'

/**
 * Workspace file bytes over the tunnel — the paired counterpart of the demo
 * CDN. Bytes ride ordinary RPC frames as base64url in CHUNK_SIZE windows, so
 * nothing here touches the transport layer; the desktop validates every path
 * against its workspace root and picks the final name for every upload.
 *
 * Only transfer lives here. What to fetch and where it lands is the file
 * cache's business (lib/files/fileCache.ts calls into this module), and what
 * to prefetch is the sync layer's (lib/sync/sync.ts) — keeping this file free
 * of both avoids an import cycle between the cache and sync.
 */

type FileStat = { exists: boolean; sizeBytes: number }
type FileChunk = { data: string; sizeBytes: number }

/** Attachment metadata as the desktop stores it — what uploadCommit answers. */
export type DesktopAttachment = {
  type: 'audio' | 'video' | 'image' | 'pdf' | 'other'
  filePath: string
  originalName: string
  mimeType: string
  sizeBytes: number
}

/**
 * How a desktop file transfer ended. The distinction between the last two is
 * load-bearing for every file card on screen:
 *
 *   'done'    the whole file landed in `scratch`;
 *   'absent'  the DESKTOP ANSWERED and said the path does not exist — the one
 *             outcome that may render as "deleted";
 *   'failed'  the transfer broke — not connected, an RPC timed out under a
 *             busy link, the socket flapped mid-file, the file shrank. The
 *             file may be perfectly fine on the desktop; the only honest next
 *             move is to try again.
 *
 * Collapsing 'failed' into 'absent' was how a transient stall during a busy
 * sync pass painted "file was deleted or unavailable" over files that were
 * fine, permanently, until the conversation was reopened.
 */
export type DesktopFileFetch = 'done' | 'absent' | 'failed'

/**
 * How long one bulk window may spend on the wire before the RPC gives up.
 *
 * The default 30s is sized for control traffic and is too tight for a
 * CHUNK_SIZE window on a slow link: 256 KB rides as ~340 KB of base64 in one
 * relay frame, so any pipe under ~11 KB/s times the chunk out no matter how
 * healthily it is flowing — and each such timeout used to restart the whole
 * file. Two minutes keeps a genuinely dead link bounded while letting a slow
 * one finish moving the window it is visibly moving.
 */
const BULK_RPC_TIMEOUT_MS = 120_000

/**
 * The resume sidecar: `<scratch>.total` holds the byte total the partial in
 * `scratch` was downloaded against. A retry may only continue a partial whose
 * recorded total matches the desktop's CURRENT stat — anything else (the file
 * changed between attempts, a stale leftover, an unreadable sidecar) restarts
 * clean. Deleted with the scratch on every terminal outcome, so it can never
 * describe bytes that are gone.
 */
function resumeSidecar(scratch: File): File {
  return new File(scratch.parentDirectory, `${scratch.name}.total`)
}

function discardPartial(scratch: File, sidecar: File): void {
  try {
    if (scratch.exists) scratch.delete()
  } catch {
    // A partial that cannot be deleted is re-judged (and re-refused) next try.
  }
  try {
    if (sidecar.exists) sidecar.delete()
  } catch {
    // Same: an orphaned sidecar never matches a fresh stat by accident alone.
  }
}

/**
 * Where a fresh attempt may pick up a previous one's bytes. Zero unless a
 * partial AND its sidecar agree with the desktop's current total — strictly
 * smaller than it, from an attempt at this same version of the file.
 */
function resumableOffset(scratch: File, sidecar: File, totalBytes: number): number {
  try {
    if (!scratch.exists || !sidecar.exists) return 0
    const recorded = Number(sidecar.textSync())
    const have = scratch.size ?? 0
    if (recorded === totalBytes && have > 0 && have < totalBytes) return have
  } catch {
    // Unreadable partial state — restart clean below.
  }
  return 0
}

/**
 * Download a workspace file into `scratch`, chunk by chunk. See
 * DesktopFileFetch for the outcomes; on anything but 'done' the caller keeps
 * its cache untouched.
 *
 * A transient failure KEEPS the partial in `scratch` (plus its sidecar), and
 * the next attempt continues from the byte it stopped at. Restarting from
 * zero was how a slow link could never finish a file at all: each retry
 * re-paid every window the last attempt had already landed, timed out at the
 * same depth, and the bar visibly started over. Only 'failed' preserves the
 * partial — a changed or vanished source discards it, because bytes from two
 * versions of a file must never meet in one cache entry.
 *
 * `onProgress` is called with the size before the first chunk and after every
 * one after it, which is what lets a file card show a real bar rather than a
 * spinner. It is advisory: throwing from it would fail the transfer, so the
 * caller keeps it cheap.
 */
export async function fetchDesktopFileInto(
  relPath: string,
  scratch: File,
  onProgress?: (receivedBytes: number, totalBytes: number) => void
): Promise<DesktopFileFetch> {
  const tunnel = tunnelClient.active
  if (!tunnel || !tunnelClient.connected) return 'failed'
  const sidecar = resumeSidecar(scratch)

  try {
    const stat = (await tunnel.rpc(Rpc.fileStat, { path: relPath })) as FileStat
    if (!stat?.exists) {
      discardPartial(scratch, sidecar)
      return 'absent'
    }
    // The size is known a full round-trip before any bytes are — publish it
    // now (with whatever a previous attempt already landed) so the bar is
    // sized correctly from its first frame.
    let offset = resumableOffset(scratch, sidecar, stat.sizeBytes)
    onProgress?.(offset, stat.sizeBytes)

    if (offset === 0) {
      discardPartial(scratch, sidecar)
      scratch.create({ intermediates: true, overwrite: true })
      sidecar.write(String(stat.sizeBytes))
    }
    const handle = scratch.open(FileMode.Append)
    let changed = false
    try {
      while (offset < stat.sizeBytes) {
        const chunk = (await tunnel.rpc(
          Rpc.fileRead,
          { path: relPath, offset, length: CHUNK_SIZE },
          BULK_RPC_TIMEOUT_MS
        )) as FileChunk
        const bytes = fromBase64Url(chunk?.data ?? '')
        // An empty window before the end, or a size that moved mid-transfer:
        // the file changed under the download. The partial holds bytes of a
        // version that no longer exists — discard it, or a truncated or
        // stitched cache entry would read as a valid hit forever.
        changed =
          bytes.length === 0 ||
          (typeof chunk?.sizeBytes === 'number' && chunk.sizeBytes !== stat.sizeBytes)
        if (changed) break
        handle.writeBytes(bytes)
        offset += bytes.length
        onProgress?.(offset, stat.sizeBytes)
      }
    } finally {
      handle.close()
    }
    if (changed) {
      discardPartial(scratch, sidecar)
      return 'failed'
    }
    sidecar.delete()
    return 'done'
  } catch (error) {
    tunnelClient.reportRpcFailure(error)
    return 'failed'
  }
}

export type UploadResult = { attachment: DesktopAttachment; conversationId: string }

/**
 * Upload a local file into the desktop's workspace. The desktop stores it as
 * a conversation upload — same folder, naming and collision behavior as a
 * file dropped on its composer — and answers with the attachment metadata the
 * message should carry. Passing a null conversationId asks the desktop to
 * create the conversation first, so a first message's file has somewhere to
 * land; the returned id is the one to send the message into.
 *
 * Returns null when nothing is connected. Transfer failures throw — the
 * caller decides whether a message without its file is worth sending.
 */
export async function uploadFileToDesktop(
  localUri: string,
  name: string,
  mimeType: string | null,
  conversationId: string | null
): Promise<UploadResult | null> {
  const tunnel = tunnelClient.active
  if (!tunnel || !tunnelClient.connected) return null

  const source = new File(localUri)
  if (!source.exists) throw new Error(`no file at ${localUri}`)
  const sizeBytes = source.size ?? 0
  if (sizeBytes <= 0) throw new Error(`empty file at ${localUri}`)

  const begin = (await tunnel.rpc(Rpc.uploadBegin, {
    name,
    mimeType,
    sizeBytes,
    conversationId
  })) as { uploadId: string; conversationId: string }

  const handle = source.open(FileMode.ReadOnly)
  try {
    let offset = 0
    while (offset < sizeBytes) {
      const bytes = handle.readBytes(Math.min(CHUNK_SIZE, sizeBytes - offset))
      if (bytes.length === 0) throw new Error('local file truncated mid-upload')
      // Bulk timeout for the same reason fileRead carries it: a window on a
      // slow uplink is not a dead one.
      await tunnel.rpc(
        Rpc.uploadChunk,
        {
          uploadId: begin.uploadId,
          offset,
          data: toBase64Url(bytes)
        },
        BULK_RPC_TIMEOUT_MS
      )
      offset += bytes.length
    }
  } finally {
    handle.close()
  }

  const attachment = (await tunnel.rpc(Rpc.uploadCommit, {
    uploadId: begin.uploadId
  })) as DesktopAttachment & { conversationId: string }
  return {
    attachment: {
      type: attachment.type,
      filePath: attachment.filePath,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes
    },
    conversationId: attachment.conversationId ?? begin.conversationId
  }
}
