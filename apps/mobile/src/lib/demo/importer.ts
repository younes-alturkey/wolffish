import { upsertConversation } from '@/lib/conversations/repo'
import type { ConversationFile } from '@/lib/conversations/types'
import { markDemoRelaySync } from '@/lib/demo/relay'
import { purgeDemoState } from '@/lib/demo/reset'
import { seedWorkspaceFile } from '@/lib/files/fileCache'
import { invalidateAutomations } from '@/lib/sync/automations'
import { invalidateProcedures } from '@/lib/sync/procedures'
import { invalidateProjects } from '@/lib/sync/projects'
import { useDemoConfig, type ConfigSnapshot } from '@/state/demoConfig'
import { useNotifications } from '@/state/notifications'
import { NOTIFY_PHASES, type NotifyPhase } from '@/lib/tunnel/protocol'
import { Directory, File, Paths } from 'expo-file-system'

/**
 * Demo mode ingestion. The demo dataset — curated in the repo's demo/
 * directory and packed by
 * scripts/demo/build-demo-bundle.mjs — is published at cdn.wolffi.sh/demo and
 * downloaded on first entry. Nothing ships in the app and nothing is pushed to
 * a device: tapping Demo Mode on a fresh install off the App Store is the only
 * step there is.
 *
 * The 18 MB of conversation JSON arrives as ~1.5 MB shards (see the bundle
 * script for why), each downloaded, parsed, imported into SQLite and released
 * before the next one starts. Cloudflare brotli/gzips application/json in
 * transit, so the wire cost is ~4 MB and the client needs no decompression.
 *
 * The media those conversations reference is a separate, lazier layer: each
 * workspace path resolves to the published sample for its file type and is
 * fetched on first view (see lib/files/sampleFiles.ts) — the same
 * metadata-first, content-on-demand flow the real desktop sync will use.
 */

/**
 * Where the published demo bundle lives. Peer of SAMPLE_BASE_URL.
 *
 * EXPO_PUBLIC_DEMO_BASE_URL points a development run at a bundle that has not
 * been uploaded yet — `npx serve demo/bundle` and start the app with the
 * variable set — which is the only way to see a freshly built dataset before
 * publishing it. Expo inlines EXPO_PUBLIC_* at bundle time, so leave it unset
 * for any build that ships.
 */
export const DEMO_BASE_URL = process.env.EXPO_PUBLIC_DEMO_BASE_URL ?? 'https://cdn.wolffi.sh/demo'

/** One packed slice of the dataset. `bytes` is the uncompressed shard size. */
export type DemoShard = { file: string; bytes: number; conversations: number }

/**
 * A bundle conversation. `files` is a demo-bundle extension of the desktop's
 * conversation shape: most demo media stays metadata-only and resolves to the
 * published per-type sample on first view (lib/files/sampleFiles.ts) — right
 * for photos and PDFs, where "a real file of that type" is the point. Chart
 * specs are the exception: by-extension every `.chart.json` would render the
 * same sample spec, so a showcase of the eleven chart types would draw the
 * same column chart eleven times. A conversation that needs per-path bytes
 * carries them inline (relPath → text, a few KB of JSON), written into the
 * workspace at import time so the cards work offline and never hit the
 * by-extension fallback. Storage never sees the key: upsertConversation
 * projects the fields it knows.
 */
export type DemoConversationFile = ConversationFile & { files?: Record<string, string> }

export type DemoManifest = {
  /** Content hash of the bundle — changes only when the dataset changes. */
  version: string
  builtAt: string
  conversations: number
  totalBytes: number
  config: { file: string; bytes: number }
  /** Absent in bundles built before the notification log existed. */
  notifications?: { file: string; bytes: number; count: number }
  shards: DemoShard[]
}

/**
 * One line of the demo's notification log. The persisted record's shape minus
 * the two fields the demo has no business setting: `counted`, which is forced
 * false below, and nothing else — read/archived are part of the curated state,
 * so the tour opens on a list that has plainly been lived in.
 */
export type DemoNotification = {
  id: string
  title: string
  body: string
  at: number
  conversationId: string | null
  deeplink: string | null
  phase: NotifyPhase
  read?: boolean
  archived?: boolean
}

export type DemoProgress = {
  /**
   * `reset` sits between the two: the old dataset is wiped only once the new
   * one is safely downloaded, so the bar never rewinds and a failed download
   * never costs the user what they already had.
   */
  phase: 'download' | 'reset' | 'import'
  /** 0–1 across the whole bundle. */
  ratio: number
  imported: number
  total: number
}

export type DemoImportResult = {
  version: string
  imported: number
  failed: number
  total: number
}

/**
 * Where the bar sits when the last shard finishes downloading. Download is the
 * long pole — ~4 MB over the wire against 169 conversations of 612 messages
 * total — so it gets most of the travel. Inside each phase the bar moves in
 * proportion to real work (bytes fetched, then conversations inserted), which
 * is what keeps it from lurching.
 */
const DOWNLOAD_WEIGHT = 0.7

function demoDir(): Directory {
  return new Directory(Paths.document, 'demo')
}

function configFile(): File {
  return new File(demoDir(), 'config-snapshot.json')
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`)
  return await response.text()
}

async function fetchJson<T>(url: string): Promise<T> {
  return JSON.parse(await fetchText(url)) as T
}

/**
 * Bundle-relative URL, stamped with the version whose manifest named the file.
 *
 * Shard filenames are positional — `conversations-000.json` is a different
 * dataset in every bundle — and nothing in the response says how long it may
 * be reused: the CDN sends no Cache-Control, which licenses the HTTP client to
 * apply heuristic freshness and answer from its own cache. React Native's
 * fetch cannot override that (the `cache` init option is not plumbed through
 * its XHR), so the URL is the only lever: a new version is a new URL, and the
 * stale copy is never asked for again. Below the app, Cloudflare and the
 * device both keep caching normally, which is what a versioned URL is for.
 */
function bundleUrl(file: string, version: string): string {
  return `${DEMO_BASE_URL}/${file}?v=${encodeURIComponent(version)}`
}

/**
 * The manifest URL, unique per call.
 *
 * The manifest is the version probe, so it is the one file that must never
 * come from a cache: a stale copy reports the version this device already
 * holds and the refresh silently never happens — the exact failure the version
 * check exists to prevent, and one that looks like nothing at all on screen.
 * It is ~1 KB, so paying full price for it on every check is free.
 */
function manifestUrl(): string {
  return `${DEMO_BASE_URL}/manifest.json?t=${Date.now()}`
}

/**
 * The published manifest — a ~1 KB version probe. `version` is a content hash
 * of the bundle, so comparing it against the imported one is what lets a
 * republished dataset reach a device that already imported an older copy;
 * without it, the first import is the only one a device ever performs.
 *
 * Bounded so a hanging network cannot hold the demo door shut: callers treat
 * any failure as "no refresh available" and enter with what they have.
 */
export async function fetchDemoManifest(timeoutMs = 4000): Promise<DemoManifest> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(manifestUrl(), { signal: controller.signal })
    if (!response.ok) throw new Error(`manifest → HTTP ${response.status}`)
    return JSON.parse(await response.text()) as DemoManifest
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Apply the real-workspace config snapshot into the demo config store —
 * capabilities with their SKILL.md descriptions, MCP servers, connections,
 * channel settings, brain/preferences, and the workspace content the
 * Projects / Procedures / Automations / Customization screens render. Reads
 * the copy saved at import time, so it runs offline on every demo entry
 * (cheap), modeling live sync's cached-then-refresh behavior.
 *
 * The invalidation at the end is not housekeeping. Three screens read the
 * snapshot through react-query rather than off the store, and each of those
 * queries answers `[]` when the store is still empty — which it is right up
 * until this function returns. A query that ran first caches that empty answer
 * for its whole staleTime, and the screen's own refetch reads the same empty
 * cache straight back: an automation would render under the default heart with
 * no project name, on the one visit a demo actually gets looked at. Announcing
 * the change is what the desktop's own pushes do (lib/sync invalidate*), and
 * this is the same event from the other source.
 */
export async function applyConfigSnapshot(): Promise<boolean> {
  try {
    const file = configFile()
    if (!file.exists) return false
    const snapshot = JSON.parse(await file.text()) as ConfigSnapshot
    if (!Array.isArray(snapshot.capabilities)) return false
    useDemoConfig.getState().applySnapshot(snapshot)
    invalidateProjects()
    invalidateProcedures()
    invalidateAutomations()
    // This read IS the demo's catch-up, so it stamps the made-up link's
    // "last catch-up" clock — every entry and every Sync press lands here.
    markDemoRelaySync()
    return true
  } catch {
    return false
  }
}

/**
 * Materialize a conversation's inline files (see DemoConversationFile) into
 * the workspace. Best-effort by design: a failed or rejected write costs one
 * card its per-path bytes — the viewer falls back to the by-extension sample
 * — never the conversation.
 */
function seedConversationFiles(conversation: DemoConversationFile): void {
  const files = conversation.files
  if (!files || typeof files !== 'object') return
  for (const [relPath, content] of Object.entries(files)) {
    if (typeof content !== 'string') continue
    seedWorkspaceFile(relPath, content)
  }
}

/**
 * Seed the notification log from the bundle.
 *
 * DEMO NOTIFICATIONS HOLD NO BADGE, and that is enforced here rather than
 * trusted to the data: `counted` is forced false on every record. A badge
 * bucket is the phone's half of a count the RELAY also keeps and the OS icon
 * renders, and a demo has neither — so a demo that minted buckets would put a
 * number on the app icon and on conversation rows that nothing in the tour can
 * ever clear honestly. What the demo does show is the unread count on the
 * conversations sheet's Notifications row, which is read straight off this log
 * and owes the relay nothing.
 *
 * Runs inside the import, after the purge that empties the store — so a
 * re-import restores the curated list, while a device that has been reading
 * and archiving between entries keeps its own state (nothing re-imports until
 * the published version changes).
 *
 * Best-effort: a malformed log costs the notifications page its content, never
 * the 171 conversations that came with it.
 */
function seedNotifications(raw: string): void {
  try {
    const payload = JSON.parse(raw) as { notifications?: DemoNotification[] }
    if (!Array.isArray(payload.notifications)) return
    const store = useNotifications.getState()
    for (const entry of payload.notifications) {
      if (!entry?.id || typeof entry.title !== 'string' || typeof entry.body !== 'string') continue
      store.record({
        id: entry.id,
        title: entry.title,
        body: entry.body,
        at: typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : Date.now(),
        conversationId: typeof entry.conversationId === 'string' ? entry.conversationId : null,
        deeplink: typeof entry.deeplink === 'string' ? entry.deeplink : null,
        phase: NOTIFY_PHASES.includes(entry.phase) ? entry.phase : 'info',
        counted: false,
        read: entry.read === true
      })
      // record() only ever sets `read`, so the archive state is applied after
      // it — and archiving reads on its own, which is why a curated archived
      // record needs no read flag of its own to come out right.
      if (entry.archived === true) store.archive(entry.id)
    }
  } catch {
    // A malformed log leaves the page empty; the tour is otherwise intact.
  }
}

/** Persist the snapshot beside the conversations it describes. */
function saveConfigSnapshot(raw: string): void {
  const snapshot = JSON.parse(raw) as ConfigSnapshot
  if (!Array.isArray(snapshot.capabilities)) throw new Error('malformed config snapshot')
  demoDir().create({ intermediates: true, idempotent: true })
  configFile().write(raw)
}

/**
 * Download the published bundle, wipe whatever this device holds, and ingest
 * the new dataset into SQLite.
 *
 * Every shard is fetched before anything is deleted or inserted, so a network
 * failure leaves the existing demo untouched rather than half a dataset behind
 * a flag that says it imported. Shard bodies are held as strings and released
 * as each is parsed — the whole set is ~18 MB of text, and holding it is what
 * buys a download phase that can be measured instead of guessed at.
 *
 * The purge in the middle is unconditional: this function only runs when the
 * published version differs from the imported one (or nothing is imported at
 * all), which is precisely when a full replacement is what "refresh" means.
 * Deciding again here would only add a way for the two answers to disagree.
 *
 * Throws when the manifest or any shard cannot be fetched; the caller reports
 * it and leaves the version unset, so the next tap starts over. Inserts are
 * upserts keyed by conversation id, so a retry costs time, never correctness.
 */
export async function importDemoData(
  onProgress?: (progress: DemoProgress) => void
): Promise<DemoImportResult> {
  const manifest = await fetchJson<DemoManifest>(manifestUrl())
  if (!Array.isArray(manifest.shards) || manifest.shards.length === 0) {
    throw new Error('demo manifest has no shards')
  }
  if (!manifest.config?.file) throw new Error('demo manifest has no config snapshot')
  if (!manifest.version) throw new Error('demo manifest has no version')

  const totalBytes =
    manifest.totalBytes || manifest.shards.reduce((sum, shard) => sum + shard.bytes, 0)
  const total = manifest.conversations || 0
  let imported = 0
  let failed = 0

  // Repainting on every one of 169 inserts costs more than the bar can show —
  // but only within a phase: the first report of a new phase always lands, or
  // the label lags behind the work it names.
  let lastPercent = -1
  let lastPhase: DemoProgress['phase'] | null = null
  const report = (phase: DemoProgress['phase'], ratio: number): void => {
    const clamped = Math.max(0, Math.min(ratio, 1))
    const percent = Math.round(clamped * 100)
    if (percent === lastPercent && phase === lastPhase && phase === 'import') return
    lastPercent = percent
    lastPhase = phase
    onProgress?.({ phase, ratio: clamped, imported, total })
  }

  // ---- Download --------------------------------------------------------
  const bodies: string[] = []
  let doneBytes = 0
  report('download', 0)
  for (const shard of manifest.shards) {
    bodies.push(await fetchText(bundleUrl(shard.file, manifest.version)))
    doneBytes += shard.bytes
    report('download', totalBytes > 0 ? (doneBytes / totalBytes) * DOWNLOAD_WEIGHT : 0)
  }
  const configRaw = await fetchText(bundleUrl(manifest.config.file, manifest.version))
  // Optional, and deliberately not fatal: a bundle published before the
  // notification log existed must still import everything else.
  const notificationsRaw = manifest.notifications?.file
    ? await fetchText(bundleUrl(manifest.notifications.file, manifest.version)).catch(() => null)
    : null

  // ---- Purge -----------------------------------------------------------
  // Last point at which nothing has been destroyed: everything the new bundle
  // needs is in hand, so the old dataset — conversations, cached media, saved
  // snapshot, this device's config edits — goes now rather than being merged
  // into. See lib/demo/reset for why a union of bundles is the wrong answer.
  report('reset', DOWNLOAD_WEIGHT)
  await purgeDemoState()

  // ---- Import ----------------------------------------------------------
  let processed = 0
  const expected = total || manifest.shards.reduce((sum, shard) => sum + shard.conversations, 0)
  for (const [index, shard] of manifest.shards.entries()) {
    const payload = JSON.parse(bodies[index]) as { conversations: DemoConversationFile[] }
    bodies[index] = '' // The parsed copy is the live one from here on.
    if (!Array.isArray(payload.conversations)) throw new Error(`malformed shard: ${shard.file}`)

    for (const conversation of payload.conversations) {
      try {
        if (!conversation?.id || !Array.isArray(conversation.messages)) {
          throw new Error('malformed conversation')
        }
        await upsertConversation(conversation)
        seedConversationFiles(conversation)
        imported += 1
      } catch {
        // One unreadable conversation must not cost the other 168.
        failed += 1
      }
      processed += 1
      report(
        'import',
        DOWNLOAD_WEIGHT + (1 - DOWNLOAD_WEIGHT) * (expected > 0 ? processed / expected : 1)
      )
    }
  }

  // Last, and only once the conversations it describes are in: a saved
  // snapshot is what makes later entries work offline.
  saveConfigSnapshot(configRaw)
  // After the conversations too, for the same reason: every line of the log
  // deep-links into one, and a notification that lands before its conversation
  // is a card that opens onto nothing.
  if (notificationsRaw) seedNotifications(notificationsRaw)
  onProgress?.({ phase: 'import', ratio: 1, imported, total })

  return { version: manifest.version, imported, failed, total }
}
