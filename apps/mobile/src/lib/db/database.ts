import * as SQLite from 'expo-sqlite'

/**
 * On-device conversation store. SQLite (not the AsyncStorage query persister)
 * because real workspaces are heavy — the analyzed desktop workspace holds
 * 868 conversations / 106 MB of JSON — and the app promises instant list +
 * open. Conversation metadata and messages live here; media files live in the
 * file cache (lib/files) which uses the cached_files table as its LRU index.
 *
 * TanStack Query remains the read layer on top (lib/conversations/hooks.ts);
 * when desktop sync lands it writes into this store and invalidates queries.
 */

const DB_NAME = 'wolffish.db'

const SCHEMA_VERSION = 3

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null

async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version')
  const current = row?.user_version ?? 0
  if (current >= SCHEMA_VERSION) return

  await db.withExclusiveTransactionAsync(async (tx) => {
    if (current < 1) {
      await tx.execAsync(`
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          model TEXT,
          channel TEXT,
          icon TEXT,
          project_id TEXT,
          sealed INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          message_count INTEGER NOT NULL DEFAULT 0,
          stats_json TEXT,
          summary TEXT,
          last_opened_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_conversations_updated
          ON conversations(updated_at DESC);

        CREATE TABLE IF NOT EXISTS messages (
          conversation_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          payload_json TEXT,
          PRIMARY KEY (conversation_id, seq)
        );

        CREATE TABLE IF NOT EXISTS cached_files (
          rel_path TEXT PRIMARY KEY,
          size_bytes INTEGER NOT NULL,
          last_access_at INTEGER NOT NULL,
          conversation_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_cached_files_access
          ON cached_files(last_access_at ASC);
      `)
    }
    if (current < 2) {
      // When this conversation's messages were last pulled. Compared against
      // the desktop's updated_at to know a cached body has fallen behind —
      // without it, a conversation that grew while the phone was away keeps
      // showing the stale copy, because it is no longer empty.
      await tx.execAsync('ALTER TABLE conversations ADD COLUMN body_synced_at INTEGER')
    }
    // Version 3 added a ratings_json column for the retired turn-scoring
    // feature. Nothing reads or writes it any more: databases that have it
    // simply carry an ignored column, and fresh installs never create it.
    await tx.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  })
}

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync(DB_NAME)
      // WAL keeps reads (chat feed) unblocked during import/persist writes.
      await db.execAsync('PRAGMA journal_mode = WAL')
      await db.execAsync('PRAGMA foreign_keys = ON')
      await migrate(db)
      return db
    })()
  }
  return dbPromise
}

/** Test/dev helper: drop every row without deleting the database file. */
export async function resetDb(): Promise<void> {
  const db = await getDb()
  await db.execAsync(
    'DELETE FROM messages; DELETE FROM conversations; DELETE FROM cached_files; ' +
      // Created lazily by sync.ts — the guard keeps the batch valid pre-sync.
      'CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT); ' +
      'DELETE FROM sync_meta;'
  )
}
