import { fetchDesktopFileInto } from '@/lib/sync/files'
import { tunnelClient } from '@/lib/tunnel/client'
import { Event, Rpc, type DiagnosticProgress, type DiagnosticResult } from '@/lib/tunnel/protocol'
import { Directory, File, Paths } from 'expo-file-system'

/**
 * The Debug button's export — the desktop's per-conversation diagnostic bundle,
 * asked for from the phone and brought back to it.
 *
 * NOTHING is collected here. The desktop runs the same collector its own
 * History page runs, behind the same single-flight guard, and writes the same
 * archive into `diagnostics/` in the workspace. The phone's whole part is three
 * steps, and they are separate on purpose because they fail differently and
 * take different amounts of time:
 *
 *   collect   an RPC that can run for tens of seconds (it asks a model for an
 *             opinion), reporting progress as `Event.diagnosticsProgress`
 *   download  the archive over the ordinary chunked file path — a zip is
 *             megabytes, so it has a bar of its own rather than a spinner
 *   share     the file, from the phone's own cache, through the system sheet
 *
 * The archive is downloaded into the CACHE directory, not the workspace mirror:
 * it is a thing being handed to someone else, not a file the conversation
 * refers to, and the next export supersedes it. iOS may reclaim the directory
 * whenever it likes, which is exactly the right lifetime for it.
 */

/** Where the downloaded archives land — swept on every export. */
const ARCHIVE_DIR = 'diagnostics'

export type DiagnosticPhase =
  | { kind: 'collecting'; progress: DiagnosticProgress | null }
  | { kind: 'downloading'; receivedBytes: number; totalBytes: number }

export type DiagnosticExport = {
  result: DiagnosticResult
  /** Local file URI of the archive, or null when the transfer failed. */
  uri: string | null
}

/**
 * Watch a running export. Returns a teardown the caller owns.
 *
 * The tunnel keeps ONE handler per topic, replaced on re-registration (see
 * Tunnel.onEvent) — there is no unsubscribe to call, so the teardown swaps in
 * a sink. For a topic nothing else listens to that is the same thing, and it
 * is what keeps a finished overlay from holding the live handler.
 *
 * Ticks for another conversation are the desktop's own screen collecting
 * something else at the same time; filtered here rather than by every caller.
 */
export function onDiagnosticProgress(
  conversationId: string,
  handler: (progress: DiagnosticProgress) => void
): () => void {
  const tunnel = tunnelClient.active
  if (!tunnel) return () => undefined
  tunnel.onEvent(Event.diagnosticsProgress, (payload) => {
    const progress = payload as DiagnosticProgress | null
    if (progress?.conversationId === conversationId) handler(progress)
  })
  return () => tunnel.onEvent(Event.diagnosticsProgress, () => undefined)
}

/** The result shape a failure takes, so callers render one thing either way. */
function failure(conversationId: string, error: string): DiagnosticResult {
  return {
    ok: false,
    error,
    conversationId,
    conversationTitle: '',
    fileName: '',
    zipPath: '',
    relativePath: '',
    sizeBytes: 0,
    fileCount: 0,
    durationMs: 0,
    modelOpinion: false,
    groups: [],
    warnings: []
  }
}

/**
 * Collect the bundle on the desktop, then bring the archive down.
 *
 * Never throws: an export that could not run is a RESULT that says so, because
 * the overlay renders one card for every outcome and a thrown error would
 * leave it spinning over nothing.
 *
 * A failed DOWNLOAD is deliberately not a failed export. The archive exists —
 * on the desktop, where the developer's copy can still be fetched from — so the
 * result stands and only the share step is missing; the overlay says which.
 */
export async function exportDiagnostics(
  conversationId: string,
  onPhase: (phase: DiagnosticPhase) => void
): Promise<DiagnosticExport> {
  const tunnel = tunnelClient.active
  if (!tunnel || !tunnelClient.connected) {
    return { result: failure(conversationId, 'not connected to your desktop'), uri: null }
  }

  onPhase({ kind: 'collecting', progress: null })
  let result: DiagnosticResult
  try {
    result = (await tunnel.rpc(Rpc.diagnosticsExport, { conversationId })) as DiagnosticResult
  } catch (error) {
    tunnelClient.reportRpcFailure(error)
    return {
      result: failure(conversationId, error instanceof Error ? error.message : String(error)),
      uri: null
    }
  }
  if (!result?.ok || !result.relativePath) {
    return { result: result ?? failure(conversationId, 'the desktop returned nothing'), uri: null }
  }

  // One archive on the device at a time. The previous one has either been
  // shared already or been abandoned, and either way it is superseded.
  const dir = new Directory(Paths.cache, ARCHIVE_DIR)
  try {
    if (dir.exists) dir.delete()
  } catch {
    // A directory that will not clear is not worth failing an export over;
    // the write below overwrites the file it collides with anyway.
  }
  const target = new File(dir, result.fileName)

  onPhase({ kind: 'downloading', receivedBytes: 0, totalBytes: result.sizeBytes })
  const landed = await fetchDesktopFileInto(result.relativePath, target, (received, total) =>
    onPhase({ kind: 'downloading', receivedBytes: received, totalBytes: total })
  )
  // 'done' alone means the archive is on the device — 'absent' and 'failed'
  // are strings and truthy, so a bare truthiness check here would hand the
  // share sheet a path with nothing at it.
  return { result, uri: landed === 'done' ? target.uri : null }
}
