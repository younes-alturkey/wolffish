import { resetDemoRelay } from '@/lib/demo/relay'
import { getDb } from '@/lib/db/database'
import { QUERY_CACHE_KEY, queryClient } from '@/lib/query/queryClient'
import { useAppStore } from '@/state/appStore'
import { useChatRuntime } from '@/state/chatRuntime'
import { useDemoConfig } from '@/state/demoConfig'
import { useNotifications } from '@/state/notifications'
import { useRunStatus } from '@/state/runStatus'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { Directory, Paths } from 'expo-file-system'

/**
 * Wipe every trace of an imported demo dataset.
 *
 * A republished bundle is a NEW dataset, not a patch: conversations are
 * dropped upstream as well as added, media behind a workspace path can change
 * bytes without changing its path, and the config snapshot can lose a
 * capability or a project. Importing over the top only ever upserts, so
 * without this every device that has already entered demo mode accumulates the
 * union of every bundle it has seen — deleted conversations linger, stale
 * media renders, and the phone disagrees with the CDN in ways nothing on
 * screen explains. Purging first is what makes "new version" mean the same
 * thing on a returning device as on a fresh install.
 *
 * Everything demo mode writes, in the order a half-finished purge is safest:
 *
 *   1. `demoVersion` — cleared FIRST. If anything below throws or the app is
 *      killed mid-wipe, the device reads as "nothing imported" and the next
 *      tap redownloads, rather than claiming a dataset it no longer holds.
 *   2. SQLite — conversations, messages, and the cached_files LRU index.
 *   3. Documents/workspace — the media those conversations referenced.
 *   4. Documents/demo — the saved config snapshot.
 *   5. cache/downloads — scratch space from interrupted media downloads.
 *   6. The demo config store — back to its defaults, so a value the new
 *      snapshot does not carry cannot survive from the old one.
 *   7. The live chat runtime — in-flight streams point at conversation ids
 *      that no longer exist — and the demo's made-up relay link with it.
 *   8. The persisted query cache — anything derived from the above.
 *
 * Every step is independently guarded: a directory that cannot be deleted must
 * not cost the database wipe, and vice versa. Safe to run when there is
 * nothing to purge, which is why the import path runs it unconditionally
 * rather than trying to decide whether this device needs it.
 */
export async function purgeDemoState(): Promise<void> {
  useAppStore.getState().setDemoVersion(null)

  try {
    const db = await getDb()
    // sync_meta lives outside the migration set (created lazily by sync.ts) —
    // the CREATE guard keeps this batch valid on a database that has never
    // synced. It must be wiped with the rows it describes: a purge that kept
    // the cursor would make a later incremental sync silently skip everything
    // before it, and a stale "last synced" would describe deleted rows.
    await db.execAsync(
      'DELETE FROM messages; DELETE FROM conversations; DELETE FROM cached_files; ' +
        'CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT); ' +
        'DELETE FROM sync_meta;'
    )
  } catch {
    // A locked or missing database still leaves the rest worth clearing.
  }

  removeDirectory(new Directory(Paths.document, 'workspace'))
  removeDirectory(new Directory(Paths.document, 'demo'))
  removeDirectory(new Directory(Paths.cache, 'downloads'))

  try {
    useDemoConfig.getState().reset()
  } catch {
    // Defaults are restored on next launch from an untouched store.
  }

  try {
    useChatRuntime.getState().reset()
    // The chip tints point at conversations that are about to stop existing.
    useRunStatus.getState().reset()
    // So does every line of the notification log, and each one deep-links
    // into one.
    useNotifications.getState().clear()
    // The made-up relay link goes with the dataset it described; the next
    // demo entry starts a fresh one.
    resetDemoRelay()
  } catch {
    // In-memory only — a failure here costs nothing durable.
  }

  try {
    queryClient.clear()
    await AsyncStorage.removeItem(QUERY_CACHE_KEY)
  } catch {
    // The persisted cache expires on its own maxAge.
  }
}

/** Delete a directory and its contents; missing or unreadable is a no-op. */
function removeDirectory(directory: Directory): void {
  try {
    if (directory.exists) directory.delete()
  } catch {
    // A file the OS will not release stays; the import proceeds regardless.
  }
}
