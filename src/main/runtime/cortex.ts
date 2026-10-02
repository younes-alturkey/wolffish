import Database, { type Database as Db } from 'better-sqlite3'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Corpus } from '@main/runtime/corpus'
import { toFtsMatchQuery } from '@main/runtime/cortexQuery'
import {
  buildArtifactRecord,
  buildArtifactRow,
  ingestTextFile,
  isArtifactPath,
  isIndexablePath,
  type ArtifactRow,
  type IngestRecord,
  type RecordSource
} from '@main/runtime/cortexIngest'

/**
 * Cortex is the fast retrieval index over everything Wolffish knows.
 *
 * Maps to: the cerebral cortex — the wrinkled outer sheet of the brain
 * where pattern matching, association, and recall happen at speed. The
 * cortex doesn't *store* the original sensory experience; it stores a
 * compressed, queryable representation that can be regenerated quickly.
 *
 * v2: one `records` store (SQLite + FTS5, section/message granular) spanning
 * episodes, knowledge, consolidated digests, conversations (including tool
 * calls and outputs), motor task transcripts + detail logs, basalganglia
 * outcome logs, the usage ledger, corpus event logs, app/extension logs, and
 * generated-file provenance. The database is disposable — deleted, it is
 * rebuilt from the files that live next to it. Startup is an incremental
 * catch-up diff against `indexed_files` bookkeeping; a full rebuild happens
 * only when SCHEMA_VERSION bumps (or on explicit reindex).
 */

export type CortexSearchResult = {
  path: string
  score: number
}

export type RecordHit = {
  ref: string
  source: RecordSource
  date: string | null
  title: string
  snippet: string
  sourceFile: string
  score: number
  meta: string | null
}

export type RecordRow = {
  ref: string
  source: RecordSource
  date: string | null
  title: string
  content: string
  sourceFile: string
  meta: string | null
}

export type ConversationSummary = {
  id: string
  title: string
  channel: string
  createdAt: number
  updatedAt: number
  messageCount: number
  sizeBytes: number
  sealed: boolean
  projectId?: string
  /** Source emoji (automation/procedure icon) for the rail's number-chip badge. */
  icon?: string
  sourceFile: string
}

export type UsageSummary = {
  requests: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  cost: number
  byModel: Array<{ model: string; requests: number; cost: number }>
}

export type ArtifactHit = ArtifactRow

export type CortexOptions = {
  workspaceRoot?: string
  dbPath?: string
  corpus?: Corpus
}

/** Bump to force a full drop-and-rebuild on next launch. */
// v3: conversations.project_id — the bump forces a full rebuild on launch,
// which re-ingests every conversation file and backfills the column for
// rows indexed before projects existed.
// v4: conversations.icon — same deal for the stamped automation/procedure
// emoji. Without it the list fast path returned no icon, so the rail's
// number-chip badge only ever appeared on a cold index.
const SCHEMA_VERSION = 4

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  ref TEXT NOT NULL,
  date TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  meta TEXT,
  source_file TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
  title,
  content,
  content='records',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS records_ai AFTER INSERT ON records BEGIN
  INSERT INTO records_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
END;

CREATE TRIGGER IF NOT EXISTS records_ad AFTER DELETE ON records BEGIN
  INSERT INTO records_fts(records_fts, rowid, title, content)
  VALUES ('delete', old.id, old.title, old.content);
END;

CREATE TABLE IF NOT EXISTS indexed_files (
  path TEXT PRIMARY KEY,
  mtime_ms INTEGER NOT NULL,
  size INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  channel TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  sealed INTEGER NOT NULL,
  project_id TEXT,
  icon TEXT,
  source_file TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_ledger (
  ts TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input INTEGER NOT NULL,
  output INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cost REAL NOT NULL,
  source_file TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  name TEXT,
  status TEXT,
  created_at TEXT,
  completed_at TEXT,
  steps_total INTEGER,
  steps_done INTEGER,
  source_file TEXT
);

CREATE TABLE IF NOT EXISTS artifacts (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dir TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  kind TEXT NOT NULL,
  conversation_id TEXT
);

CREATE INDEX IF NOT EXISTS records_source_date ON records(source, date);
CREATE INDEX IF NOT EXISTS records_ref ON records(ref);
CREATE INDEX IF NOT EXISTS records_file ON records(source_file);
CREATE INDEX IF NOT EXISTS usage_ts ON usage_ledger(ts);
CREATE INDEX IF NOT EXISTS usage_file ON usage_ledger(source_file);
CREATE INDEX IF NOT EXISTS tasks_source ON tasks(source_file);
CREATE INDEX IF NOT EXISTS conversations_updated ON conversations(updated_at);
CREATE INDEX IF NOT EXISTS artifacts_dir ON artifacts(dir);
`

/** Files indexed per synchronous batch before yielding the event loop. */
const REINDEX_BATCH = 8
/** Only surface the blocking overlay once a rebuild has run this long. */
const REINDEX_NOTICE_MS = 500

/**
 * The legacy path-level `search()` feeds prefrontal's ambient memory
 * injection, which reads matched files WHOLE. Restrict it to the curated
 * markdown sources it was built for — a 9MB conversation JSON or a raw log
 * must never be whole-file-injected into a prompt. The retrieval tools use
 * `searchRecords()`, which spans every source.
 */
const PATH_SEARCH_SOURCES: ReadonlySet<string> = new Set([
  'episode',
  'knowledge',
  'consolidated',
  'doc'
])

/** Progress of an in-flight full reindex, surfaced to the renderer overlay. */
export type ReindexStatus = { startedAt: number; total: number; done: number }

type WalkedFile = { rel: string; abs: string; mtimeMs: number; size: number; artifact: boolean }

export class Cortex {
  private db: Db | null = null
  private workspaceRoot: string | null
  private corpus: Corpus | null
  private dbFile: string | null
  private reindexStatus: ReindexStatus | null = null

  constructor(options: CortexOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? null
    this.corpus = options.corpus ?? null
    this.dbFile = options.dbPath ?? this.defaultDbPath()
  }

  /**
   * Open cortex.db, ensure schema, and bring the index current. A schema
   * bump forces a full rebuild; otherwise startup is an incremental diff of
   * (mtime, size) against the bookkeeping table. Safe to call repeatedly.
   */
  async init(): Promise<void> {
    if (this.db) return
    if (!this.dbFile) {
      throw new Error('Cortex.init: dbPath unresolved (workspaceRoot is required)')
    }
    await fsp.mkdir(path.dirname(this.dbFile), { recursive: true })
    this.db = new Database(this.dbFile)
    this.db.pragma('journal_mode = WAL')

    const version = this.db.pragma('user_version', { simple: true }) as number
    if (version !== SCHEMA_VERSION) {
      this.dropAllTables()
      this.db.exec(SCHEMA_SQL)
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`)
      await this.reindex()
    } else {
      this.db.exec(SCHEMA_SQL)
      await this.catchUp()
    }
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  /**
   * Current reindex status, or null when no rebuild is in flight (or it's
   * still below the notice threshold). Drives the blocking "Rebuilding memory"
   * overlay in the renderer.
   */
  getReindexStatus(): ReindexStatus | null {
    return this.reindexStatus
  }

  /**
   * Full rebuild: drop every row and re-walk the workspace. Used on schema
   * bumps and the explicit "rebuild index" IPC — normal startup uses
   * catchUp() instead.
   *
   * better-sqlite3 is synchronous, so the walk is indexed in batches with the
   * event loop yielded between them: the "Rebuilding memory" overlay renders
   * with a live timer, and callers that await readiness still get a fully
   * built index before the next turn runs.
   */
  async reindex(): Promise<void> {
    const db = this.requireDb()
    const root = this.workspaceRoot
    if (!root) return

    const startedAt = Date.now()

    db.exec(
      'DELETE FROM records; DELETE FROM indexed_files; DELETE FROM conversations; ' +
        'DELETE FROM usage_ledger; DELETE FROM tasks; DELETE FROM artifacts;'
    )

    const files = await collectIndexableFiles(root)
    await this.indexBatches(files, startedAt)

    this.reindexStatus = null
    if (this.corpus) {
      this.corpus.emit('index.reindexed', {
        filesCount: files.length,
        durationMs: Date.now() - startedAt
      })
    }
  }

  /**
   * Incremental startup pass: index new/changed files, drop rows for files
   * that no longer exist. Replaces the old every-launch full rebuild.
   */
  async catchUp(): Promise<void> {
    const db = this.requireDb()
    const root = this.workspaceRoot
    if (!root) return

    const startedAt = Date.now()
    const files = await collectIndexableFiles(root)
    const known = new Map<string, { mtime_ms: number; size: number }>()
    for (const row of db.prepare('SELECT path, mtime_ms, size FROM indexed_files').all() as Array<{
      path: string
      mtime_ms: number
      size: number
    }>) {
      known.set(row.path, row)
    }

    const changed: WalkedFile[] = []
    const seen = new Set<string>()
    for (const f of files) {
      seen.add(f.rel)
      const prev = known.get(f.rel)
      if (!prev || prev.mtime_ms !== Math.floor(f.mtimeMs) || prev.size !== f.size) {
        changed.push(f)
      }
    }
    const removed = [...known.keys()].filter((rel) => !seen.has(rel))

    for (const rel of removed) {
      this.removeRelSync(rel)
    }
    await this.indexBatches(changed, startedAt)

    this.reindexStatus = null
    if ((changed.length > 0 || removed.length > 0) && this.corpus) {
      this.corpus.emit('index.reindexed', {
        filesCount: changed.length,
        durationMs: Date.now() - startedAt
      })
    }
  }

  private async indexBatches(files: WalkedFile[], startedAt: number): Promise<void> {
    const db = this.requireDb()
    const total = files.length
    let done = 0
    let notified = false

    for (let i = 0; i < files.length; i += REINDEX_BATCH) {
      const batch = files.slice(i, i + REINDEX_BATCH)
      const insert = db.transaction((items: WalkedFile[]) => {
        for (const f of items) this.indexWalkedSync(f)
      })
      insert(batch)
      done += batch.length

      // Only raise the blocking overlay once the rebuild has proven slow
      // enough to be worth interrupting the user for.
      if (!notified && Date.now() - startedAt >= REINDEX_NOTICE_MS) {
        notified = true
        this.reindexStatus = { startedAt, total, done }
        this.corpus?.emit('index.reindexStarted', { startedAt, total })
      }
      if (notified) {
        this.reindexStatus = { startedAt, total, done }
        this.corpus?.emit('index.reindexProgress', { done, total })
      }

      // Yield so IPC and the overlay timer keep flowing during the rebuild.
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  /**
   * Index (or reindex) a single file — the watcher's entry point. Artifact
   * paths are stat-indexed (metadata only); text sources are parsed into
   * records. Removes any existing rows for the file first.
   */
  async indexFile(absPath: string): Promise<void> {
    this.requireDb()
    const rel = this.toRelative(absPath)
    if (!isIndexablePath(rel)) return
    let stat: fs.Stats
    try {
      stat = fs.statSync(absPath)
    } catch {
      return
    }
    this.indexWalkedSync({
      rel,
      abs: absPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      artifact: isArtifactPath(rel)
    })
    // Push a list-changed signal for conversation writes ONLY. This is the
    // incremental watcher path (catchUp/reindex call indexWalkedSync directly,
    // so they never fire this) — one event per live conversation write, after
    // the row is committed, so the renderer's refetch is guaranteed fresh.
    if (rel.startsWith('brain/conversations/')) {
      this.corpus?.emit('conversation.indexed', { rel })
    }
  }

  /** Drop every row associated with a file (file deleted from workspace). */
  async removeFile(absPath: string): Promise<void> {
    this.requireDb()
    const rel = this.toRelative(absPath)
    this.removeRelSync(rel)
    if (rel.startsWith('brain/conversations/')) {
      this.corpus?.emit('conversation.indexed', { rel })
    }
  }

  /**
   * Legacy path-level FTS search over the curated markdown sources
   * (episodes / knowledge / consolidated / docs). Feeds prefrontal's ambient
   * memory injection, which reads matched files whole — so conversation
   * JSONs, logs, and artifacts are deliberately out of scope here.
   */
  search(query: string, limit = 10): CortexSearchResult[] {
    const db = this.requireDb()
    const ftsQuery = toFtsMatchQuery(query.trim())
    if (!ftsQuery) return []

    const placeholders = [...PATH_SEARCH_SOURCES].map(() => '?').join(', ')
    // bm25() cannot ride inside an aggregate or a flattened subquery
    // ("unable to use function bm25 in the requested context"), so rank per
    // RECORD in SQL and fold to best-rank-per-file here.
    let rows: Array<{ path: string; rank: number }>
    try {
      rows = db
        .prepare(
          `SELECT r.source_file AS path, bm25(records_fts) AS rank
           FROM records_fts
           JOIN records r ON r.id = records_fts.rowid
           WHERE records_fts MATCH ?
             AND r.source IN (${placeholders})
           ORDER BY rank
           LIMIT ?`
        )
        .all(ftsQuery, ...PATH_SEARCH_SOURCES, limit * 8) as Array<{ path: string; rank: number }>
    } catch {
      return []
    }

    const bestByPath = new Map<string, number>()
    for (const row of rows) {
      const prev = bestByPath.get(row.path)
      if (prev === undefined || row.rank < prev) bestByPath.set(row.path, row.rank)
    }
    return [...bestByPath.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit)
      .map(([p, rank]) => ({ path: p, score: bm25ToScore(rank) }))
  }

  /**
   * Record-level ranked search across EVERY indexed source — the engine
   * behind the memory_search tool. Returns snippets, not whole files;
   * `getRecordsByRef` / the conversation reader fetch full content on demand.
   */
  searchRecords(
    query: string,
    opts: {
      sources?: RecordSource[]
      after?: string
      before?: string
      limit?: number
    } = {}
  ): RecordHit[] {
    const db = this.requireDb()
    const ftsQuery = toFtsMatchQuery(query.trim())
    if (!ftsQuery) return []
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100)

    const conditions: string[] = ['records_fts MATCH ?']
    const params: unknown[] = [ftsQuery]
    if (opts.sources && opts.sources.length > 0) {
      conditions.push(`r.source IN (${opts.sources.map(() => '?').join(', ')})`)
      params.push(...opts.sources)
    }
    if (opts.after) {
      conditions.push('r.date >= ?')
      params.push(opts.after)
    }
    if (opts.before) {
      conditions.push('r.date <= ?')
      params.push(opts.before)
    }
    params.push(limit)

    let rows: Array<{
      ref: string
      source: RecordSource
      date: string | null
      title: string
      snippet: string
      source_file: string
      rank: number
      meta: string | null
    }>
    try {
      rows = db
        .prepare(
          `SELECT r.ref AS ref, r.source AS source, r.date AS date, r.title AS title,
                  snippet(records_fts, 1, '', '', '…', 32) AS snippet,
                  r.source_file AS source_file, bm25(records_fts) AS rank, r.meta AS meta
           FROM records_fts
           JOIN records r ON r.id = records_fts.rowid
           WHERE ${conditions.join(' AND ')}
           ORDER BY rank
           LIMIT ?`
        )
        .all(...params) as typeof rows
    } catch {
      return []
    }

    return rows.map((r) => ({
      ref: r.ref,
      source: r.source,
      date: r.date,
      title: r.title,
      snippet: r.snippet,
      sourceFile: r.source_file,
      score: bm25ToScore(r.rank),
      meta: r.meta
    }))
  }

  /**
   * Fetch records by exact ref or ref prefix (`conversation:<id>#` returns a
   * whole conversation's records in order). Full stored content, no snippets.
   */
  getRecordsByRef(refPrefix: string, limit = 50): RecordRow[] {
    const db = this.requireDb()
    const rows = db
      .prepare(
        `SELECT ref, source, date, title, content, source_file, meta
         FROM records
         WHERE ref = ? OR ref LIKE ?
         ORDER BY id
         LIMIT ?`
      )
      .all(refPrefix, `${refPrefix}%`, Math.min(Math.max(limit, 1), 500)) as Array<{
      ref: string
      source: RecordSource
      date: string | null
      title: string
      content: string
      source_file: string
      meta: string | null
    }>
    return rows.map((r) => ({
      ref: r.ref,
      source: r.source,
      date: r.date,
      title: r.title,
      content: r.content,
      sourceFile: r.source_file,
      meta: r.meta
    }))
  }

  /** Records for one day (episode/feedback/etc. by resolved date). */
  recordsByDate(date: string, sources?: RecordSource[], limit = 50): RecordRow[] {
    const db = this.requireDb()
    const conditions = ['date = ?']
    const params: unknown[] = [date]
    if (sources && sources.length > 0) {
      conditions.push(`source IN (${sources.map(() => '?').join(', ')})`)
      params.push(...sources)
    }
    params.push(Math.min(Math.max(limit, 1), 500))
    const rows = db
      .prepare(
        `SELECT ref, source, date, title, content, source_file, meta
         FROM records WHERE ${conditions.join(' AND ')} ORDER BY id LIMIT ?`
      )
      .all(...params) as Array<{
      ref: string
      source: RecordSource
      date: string | null
      title: string
      content: string
      source_file: string
      meta: string | null
    }>
    return rows.map((r) => ({
      ref: r.ref,
      source: r.source,
      date: r.date,
      title: r.title,
      content: r.content,
      sourceFile: r.source_file,
      meta: r.meta
    }))
  }

  /** Enumerate conversations, newest first, with optional filters. */
  listConversations(
    opts: { channel?: string; after?: number; before?: number; limit?: number } = {}
  ): ConversationSummary[] {
    const db = this.requireDb()
    const conditions: string[] = []
    const params: unknown[] = []
    if (opts.channel) {
      conditions.push('channel = ?')
      params.push(opts.channel)
    }
    if (opts.after != null) {
      conditions.push('updated_at >= ?')
      params.push(opts.after)
    }
    if (opts.before != null) {
      conditions.push('updated_at <= ?')
      params.push(opts.before)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    // Ceiling, not a page size: callers that want a window pass one, and the
    // conversations list wants all of them. Capping here silently truncated
    // it at 500 — the desktop showed a short list while the phone, which
    // reads from disk, showed every conversation there actually is.
    params.push(Math.min(Math.max(opts.limit ?? 30, 1), 1_000_000))
    const rows = db
      .prepare(
        `SELECT id, title, channel, created_at, updated_at, message_count, size_bytes, sealed, project_id, icon, source_file
         FROM conversations ${where} ORDER BY updated_at DESC LIMIT ?`
      )
      .all(...params) as Array<{
      id: string
      title: string
      channel: string
      created_at: number
      updated_at: number
      message_count: number
      size_bytes: number
      sealed: number
      project_id: string | null
      icon: string | null
      source_file: string
    }>
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      channel: r.channel,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      messageCount: r.message_count,
      sizeBytes: r.size_bytes,
      sealed: r.sealed === 1,
      projectId: r.project_id ?? undefined,
      icon: r.icon ?? undefined,
      sourceFile: r.source_file
    }))
  }

  /**
   * Count conversations created at or after `sinceMs`.
   *
   * Deliberately not `listConversations({ after }).length`: that filter is on
   * updated_at (an old conversation replied to today would count as created
   * today) and its result is clamped to 500 rows, so a large corpus would
   * silently report 500.
   *
   * Returns null when the index can't answer — no db, or a table that is empty
   * because nothing has been indexed yet — so the caller falls back to reading
   * the files rather than reporting a confident zero. The emptiness check is on
   * the whole table, not on the filtered count: a genuine zero for a narrow
   * range (nothing created today yet) is a real answer, not a cold index.
   */
  countConversationsSince(sinceMs: number): number | null {
    const db = this.db
    if (!db) return null
    const total = (db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n
    if (total === 0) return null
    return (
      db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE created_at >= ?').get(sinceMs) as {
        n: number
      }
    ).n
  }

  /** Aggregate spend over an ISO-timestamp range from the usage ledger. */
  usageSummary(opts: { after?: string; before?: string } = {}): UsageSummary {
    const db = this.requireDb()
    const conditions: string[] = []
    const params: unknown[] = []
    if (opts.after) {
      conditions.push('ts >= ?')
      params.push(opts.after)
    }
    if (opts.before) {
      conditions.push('ts <= ?')
      params.push(opts.before)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const total = db
      .prepare(
        `SELECT COUNT(*) AS requests, COALESCE(SUM(input),0) AS input, COALESCE(SUM(output),0) AS output,
                COALESCE(SUM(cache_write),0) AS cw, COALESCE(SUM(cache_read),0) AS cr, COALESCE(SUM(cost),0) AS cost
         FROM usage_ledger ${where}`
      )
      .get(...params) as {
      requests: number
      input: number
      output: number
      cw: number
      cr: number
      cost: number
    }
    const byModel = db
      .prepare(
        `SELECT model, COUNT(*) AS requests, COALESCE(SUM(cost),0) AS cost
         FROM usage_ledger ${where} GROUP BY model ORDER BY cost DESC LIMIT 20`
      )
      .all(...params) as Array<{ model: string; requests: number; cost: number }>
    return {
      requests: total.requests,
      inputTokens: total.input,
      outputTokens: total.output,
      cacheWriteTokens: total.cw,
      cacheReadTokens: total.cr,
      cost: total.cost,
      byModel
    }
  }

  /** Generated/uploaded artifact lookup by name substring and/or kind. */
  searchArtifacts(
    opts: { query?: string; kind?: string; conversationId?: string; limit?: number } = {}
  ): ArtifactHit[] {
    const db = this.requireDb()
    const conditions: string[] = []
    const params: unknown[] = []
    if (opts.query) {
      conditions.push('(name LIKE ? OR path LIKE ?)')
      params.push(`%${opts.query}%`, `%${opts.query}%`)
    }
    if (opts.kind) {
      conditions.push('kind = ?')
      params.push(opts.kind)
    }
    if (opts.conversationId) {
      conditions.push('conversation_id = ?')
      params.push(opts.conversationId)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    params.push(Math.min(Math.max(opts.limit ?? 30, 1), 200))
    const rows = db
      .prepare(
        `SELECT path, name, dir, size, mtime_ms, kind, conversation_id
         FROM artifacts ${where} ORDER BY mtime_ms DESC LIMIT ?`
      )
      .all(...params) as Array<{
      path: string
      name: string
      dir: string
      size: number
      mtime_ms: number
      kind: string
      conversation_id: string | null
    }>
    return rows.map((r) => ({
      path: r.path,
      name: r.name,
      dir: r.dir,
      size: r.size,
      mtimeMs: r.mtime_ms,
      kind: r.kind,
      conversationId: r.conversation_id
    }))
  }

  /** Cheap coverage map for the "what memory exists" index stub. */
  coverage(): {
    recordsBySource: Array<{
      source: string
      count: number
      minDate: string | null
      maxDate: string | null
    }>
    conversations: number
    artifacts: number
  } {
    const db = this.requireDb()
    const recordsBySource = db
      .prepare(
        `SELECT source, COUNT(*) AS count, MIN(date) AS minDate, MAX(date) AS maxDate
         FROM records GROUP BY source ORDER BY count DESC`
      )
      .all() as Array<{
      source: string
      count: number
      minDate: string | null
      maxDate: string | null
    }>
    const conversations = (
      db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }
    ).n
    const artifacts = (db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as { n: number }).n
    return { recordsBySource, conversations, artifacts }
  }

  // ── Internals ───────────────────────────────────────────────────────

  private indexWalkedSync(f: WalkedFile): void {
    const db = this.requireDb()
    this.removeRelSync(f.rel)

    if (f.artifact) {
      const row = buildArtifactRow(f.rel, f.size, f.mtimeMs)
      db.prepare(
        `INSERT OR REPLACE INTO artifacts (path, name, dir, size, mtime_ms, kind, conversation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        row.path,
        row.name,
        row.dir,
        row.size,
        Math.floor(row.mtimeMs),
        row.kind,
        row.conversationId
      )
      this.insertRecords([buildArtifactRecord(row)], f.rel)
    } else {
      let raw: string
      try {
        raw = fs.readFileSync(f.abs, 'utf8')
      } catch {
        return
      }
      const result = ingestTextFile(f.rel, raw, f.mtimeMs)
      this.insertRecords(result.records, f.rel)

      if (result.conversation) {
        const c = result.conversation
        db.prepare(
          `INSERT OR REPLACE INTO conversations
           (id, title, channel, created_at, updated_at, message_count, size_bytes, sealed, project_id, icon, source_file)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          c.id,
          c.title,
          c.channel,
          c.createdAt,
          c.updatedAt,
          c.messageCount,
          c.sizeBytes,
          c.sealed,
          c.projectId,
          c.icon,
          f.rel
        )
      }
      if (result.usageRows) {
        const insert = db.prepare(
          `INSERT INTO usage_ledger (ts, provider, model, input, output, cache_write, cache_read, cost, source_file)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        for (const u of result.usageRows) {
          insert.run(
            u.ts,
            u.provider,
            u.model,
            u.input,
            u.output,
            u.cacheWrite,
            u.cacheRead,
            u.cost,
            f.rel
          )
        }
      }
      if (f.rel.startsWith('brain/motor/tasks/') && f.rel.endsWith('.md')) {
        this.indexTaskHeader(f.rel, raw)
      }
    }

    db.prepare('INSERT OR REPLACE INTO indexed_files (path, mtime_ms, size) VALUES (?, ?, ?)').run(
      f.rel,
      Math.floor(f.mtimeMs),
      f.size
    )
  }

  private insertRecords(records: IngestRecord[], sourceFile: string): void {
    const db = this.requireDb()
    const insert = db.prepare(
      `INSERT INTO records (source, ref, date, title, content, meta, source_file)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    for (const r of records) {
      insert.run(r.source, r.ref, r.date, r.title, r.content, r.meta, sourceFile)
    }
  }

  private indexTaskHeader(rel: string, raw: string): void {
    const db = this.requireDb()
    const header = parseTaskHeader(raw)
    const id = header.id ?? path.basename(rel, '.md').replace(/^TASK-/, '')
    db.prepare(
      `INSERT OR REPLACE INTO tasks (id, name, status, created_at, completed_at, steps_total, steps_done, source_file)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      header.name,
      header.status,
      header.createdAt,
      header.completedAt,
      header.stepsTotal,
      header.stepsDone,
      rel
    )
  }

  private removeRelSync(rel: string): void {
    const db = this.requireDb()
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM records WHERE source_file = ?').run(rel)
      db.prepare('DELETE FROM tasks WHERE source_file = ?').run(rel)
      db.prepare('DELETE FROM usage_ledger WHERE source_file = ?').run(rel)
      db.prepare('DELETE FROM conversations WHERE source_file = ?').run(rel)
      db.prepare('DELETE FROM artifacts WHERE path = ?').run(rel)
      db.prepare('DELETE FROM indexed_files WHERE path = ?').run(rel)
    })
    tx()
  }

  private dropAllTables(): void {
    const db = this.requireDb()
    // Legacy v1 tables (memory_entries, search_index) and every v2 table —
    // a version bump means the on-disk shape is untrusted.
    db.exec(`
      DROP TABLE IF EXISTS memory_entries;
      DROP TABLE IF EXISTS search_index;
      DROP TRIGGER IF EXISTS records_ai;
      DROP TRIGGER IF EXISTS records_ad;
      DROP TABLE IF EXISTS records_fts;
      DROP TABLE IF EXISTS records;
      DROP TABLE IF EXISTS indexed_files;
      DROP TABLE IF EXISTS conversations;
      DROP TABLE IF EXISTS usage_ledger;
      DROP TABLE IF EXISTS tasks;
      DROP TABLE IF EXISTS artifacts;
    `)
  }

  private requireDb(): Db {
    if (!this.db) {
      throw new Error('Cortex not initialized — call init() first')
    }
    return this.db
  }

  private toRelative(absPath: string): string {
    if (!this.workspaceRoot) return absPath
    const rel = path.relative(this.workspaceRoot, absPath)
    return rel.split(path.sep).join('/')
  }

  private defaultDbPath(): string | null {
    if (!this.workspaceRoot) return null
    return path.join(this.workspaceRoot, 'brain', 'cortex.db')
  }
}

async function collectIndexableFiles(root: string): Promise<WalkedFile[]> {
  const out: WalkedFile[] = []
  await walk(root, root, out)
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return out
}

async function walk(root: string, dir: string, out: WalkedFile[]): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.name === 'node_modules') continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(root, abs, out)
    } else if (entry.isFile()) {
      const rel = path.relative(root, abs).split(path.sep).join('/')
      if (!isIndexablePath(rel)) continue
      let stat: fs.Stats
      try {
        stat = fs.statSync(abs)
      } catch {
        continue
      }
      out.push({ rel, abs, mtimeMs: stat.mtimeMs, size: stat.size, artifact: isArtifactPath(rel) })
    }
  }
}

type ParsedTaskHeader = {
  id: string | null
  name: string | null
  status: string | null
  createdAt: string | null
  completedAt: string | null
  stepsTotal: number | null
  stepsDone: number | null
}

function parseTaskHeader(raw: string): ParsedTaskHeader {
  // Motor's renderTranscript writes bullet fields (`- **Status:** …`) under a
  // `# Task: <description>` title, with the id on its own `- **ID:** TASK-…`
  // line. There is no Name/Completed field — the description lives in the
  // title and Updated is the closest thing to a completion stamp.
  const get = (label: string): string | null => {
    const re = new RegExp(`^(?:[-*]\\s*)?\\*\\*${label}:\\*\\*\\s*(.+)$`, 'mi')
    const m = re.exec(raw)
    return m ? m[1].trim() : null
  }
  const idField = get('ID')
  const idMatch = idField ? /TASK-([A-Za-z0-9._-]+)/.exec(idField) : null
  const titleMatch = /^#\s*Task:\s*(.+\S)\s*$/im.exec(raw)
  const stepsRaw = get('Steps')
  let stepsTotal: number | null = null
  let stepsDone: number | null = null
  if (stepsRaw) {
    const m = /(\d+)\s*\/\s*(\d+)/.exec(stepsRaw)
    if (m) {
      stepsDone = Number(m[1])
      stepsTotal = Number(m[2])
    }
  }
  return {
    id: idMatch ? idMatch[1] : null,
    name: titleMatch ? titleMatch[1].trim() : get('Name'),
    status: get('Status'),
    createdAt: get('Created'),
    completedAt: get('Completed') ?? get('Updated'),
    stepsTotal,
    stepsDone
  }
}

function bm25ToScore(rank: number): number {
  if (!Number.isFinite(rank)) return 0
  // bm25 returns negative values for matches (lower/more negative is better
  // in SQLite's FTS5 implementation). Map match strength into [0, 1) so a
  // stronger match yields a HIGHER score.
  const strength = Math.max(0, -rank)
  return strength / (1 + strength)
}
