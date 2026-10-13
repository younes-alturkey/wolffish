import { coalesceTextSegments, messageFilePaths } from '@/lib/conversations/segments'
import type {
  BrowserTabSnapshot,
  ConversationMessage,
  CountdownSnapshot,
  ProcessCardSnapshot,
  Segment
} from '@/lib/conversations/types'
import { getDb } from '@/lib/db/database'
import { resolveWorkspaceFile } from '@/lib/files/fileCache'
import { tunnelClient } from '@/lib/tunnel/client'
import { fromBase64Url } from '@/lib/tunnel/pairing'
import { CHUNK_SIZE, Event, Rpc, type ConversationMeta } from '@/lib/tunnel/protocol'
import {
  applyVariablesPush,
  refreshConfigSnapshot,
  useDemoConfig,
  type ConfigSnapshot
} from '@/state/demoConfig'
import { pushCapability, setOutboxRefreshHook } from '@/lib/sync/outbox'
import { applyRunsPush, invalidateAutomations, readRuns } from '@/lib/sync/automations'
import { applyOverlayReindex, readReindex } from '@/lib/sync/overlays'
import { applyUpdaterPush, readUpdaterState } from '@/lib/sync/updater'
import { invalidateProcedures } from '@/lib/sync/procedures'
import { invalidateProcesses } from '@/lib/sync/processes'
import { invalidateProjects } from '@/lib/sync/projects'
import { useAppStore } from '@/state/appStore'
import { useNotifications } from '@/state/notifications'
import { useChatRuntime } from '@/state/chatRuntime'
import { forgetConversationNotifications, getActiveConversation } from '@/lib/notifications/push'
import { clearConversationDirty } from '@/lib/sync/dirty'
import { invalidateConversation, invalidateConversationList } from '@/lib/conversations/cache'
import { getConversation, replaceMessage } from '@/lib/conversations/repo'
import { beginSync } from '@/lib/sync/activity'

/**
 * Live sync with the paired desktop.
 *
 * The shape mirrors demo mode deliberately. Demo mode downloads a bundle into
 * SQLite and applies a config snapshot; paired mode pulls the same two things
 * from the desktop instead of the CDN. Every screen downstream — conversation
 * list, settings, usage — reads the same local store either way and cannot
 * tell the difference, which is what keeps demo mode intact rather than
 * special-cased.
 *
 * What travels up front is deliberately small: conversation *metadata* only.
 * A real workspace is ~900 MB of message bodies and the phone opens one
 * conversation at a time, so bodies are fetched on open and cached after.
 */

export type SyncPhase = 'connect' | 'config' | 'conversations' | 'usage' | 'done'

export type SyncProgress = {
  phase: SyncPhase
  /** 0–1 across the whole run, so one bar can show the lot. */
  ratio: number
  /** Rows written so far, for the "N of M" line. */
  imported: number
  total: number
}

export type SyncResult = { conversations: number; at: number }

/** Weighting so the bar moves in proportion to real work, not step count. */
const PHASE_START: Record<SyncPhase, number> = {
  connect: 0,
  config: 0.1,
  conversations: 0.25,
  usage: 0.9,
  done: 1
}

/**
 * First sync after pairing: config, the full conversation index, and usage.
 * Safe to re-run — every write is an upsert keyed by conversation id, so a
 * failed run leaves a partial index that the next run completes rather than
 * duplicating.
 */
export async function initialSync(
  onProgress?: (progress: SyncProgress) => void
): Promise<SyncResult> {
  const tunnel = tunnelClient.active
  if (!tunnel) throw new Error('not connected')

  const report = (phase: SyncPhase, within = 0, imported = 0, total = 0): void => {
    const start = PHASE_START[phase]
    const next = phase === 'done' ? 1 : PHASE_START[nextPhase(phase)]
    onProgress?.({
      phase,
      ratio: Math.min(1, start + (next - start) * Math.min(1, Math.max(0, within))),
      imported,
      total
    })
  }

  report('connect', 1)

  // 1. Config — the settings surface, straight into the same store demo mode
  //    fills, so every settings screen works with no branch.
  report('config', 0)
  const snapshot = (await tunnel.rpc(Rpc.configSnapshot)) as ConfigSnapshot
  useDemoConfig.getState().applySnapshot(snapshot)
  report('config', 1)

  // 2. Conversation index — metadata only.
  report('conversations', 0)
  const index = (await tunnel.rpc(Rpc.conversationIndex, { since: 0 })) as {
    rows: ConversationMeta[]
    total: number
    at: number
  }
  const rows = index.rows ?? []
  await upsertConversations(rows, (done) =>
    report('conversations', rows.length ? done / rows.length : 1, done, rows.length)
  )

  // 3. Usage — the ledger the Usage screen aggregates on device.
  report('usage', 0)
  try {
    // The ledger rows are the desktop's shape verbatim; the phone's usage
    // screen owns their meaning, so they travel through untouched.
    const usage = (await tunnel.rpc(Rpc.usage)) as {
      days?: ConfigSnapshot['usage'] extends { days?: infer D } | undefined ? D : never
    }
    if (Array.isArray(usage?.days)) {
      useDemoConfig.getState().applySnapshot({ ...snapshot, usage: { days: usage.days } })
    }
  } catch {
    // Usage is a nice-to-have; a desktop that cannot answer must not fail a
    // pairing that has already delivered conversations and settings.
  }
  report('usage', 1)

  await setSyncCursor(index.at ?? Date.now())
  invalidateConversationList()
  noteSynced()
  report('done', 1, rows.length, rows.length)
  return { conversations: rows.length, at: Date.now() }
}

function nextPhase(phase: SyncPhase): SyncPhase {
  const order: SyncPhase[] = ['connect', 'config', 'conversations', 'usage', 'done']
  return order[Math.min(order.length - 1, order.indexOf(phase) + 1)]
}

/**
 * Catch-up sync: ask only for what changed since the last cursor.
 *
 * The phone is often asleep while the desktop keeps working, so this runs on
 * every foreground and whenever a screen that renders desktop-owned data
 * opens. Cheap by construction — an unchanged desktop answers with an empty
 * list.
 *
 * `withIds` additionally asks for the desktop's full id list and prunes
 * anything missing from it. An incremental pull can only ever describe what
 * still exists, so without this a conversation deleted while the phone was
 * away would survive on the phone indefinitely.
 */
export async function refreshSync(
  withIds = false
): Promise<{ changed: number; removed: number; changedIds: string[] }> {
  const tunnel = tunnelClient.active
  if (!tunnel) return { changed: 0, removed: 0, changedIds: [] }
  const since = await getSyncCursor()

  const startedAt = Date.now()
  const index = (await tunnel.rpc(Rpc.conversationIndex, { since, withIds })) as {
    rows: ConversationMeta[]
    at: number
    ids?: string[]
  }
  const rows = index.rows ?? []
  let removed = 0
  if (rows.length) await upsertConversations(rows)
  if (Array.isArray(index.ids)) {
    removed = await pruneMissing(index.ids)
    // Badges follow the same rule as rows: a conversation the desktop no
    // longer has cannot keep one. Buckets younger than this fetch are spared
    // — their conversation may simply be newer than the id list.
    useNotifications.getState().prune(index.ids, startedAt)
  }
  if (rows.length || removed) invalidateConversationList()
  // Every changed conversation's own query too, not just the list. The one
  // on screen is the one that matters: its query re-ran on the connected
  // edge, BEFORE this pull moved updated_at, judged its cached body current
  // and pinned it (staleTime: Infinity) — which is how a phone that slept
  // through a finished turn kept showing the old transcript until the user
  // left and came back. Invalidated here, the mounted screen re-reads
  // against the fresh metadata and fetches exactly when it is behind.
  for (const row of rows) {
    if (row?.id) invalidateConversation(row.id)
  }
  await setSyncCursor(index.at ?? Date.now())
  noteSynced()
  // Newest first, so a caller refreshing bodies under a cap spends it on the
  // conversations the user is most likely to open next.
  const changedIds = rows
    .filter((row): row is ConversationMeta => Boolean(row?.id))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .map((row) => row.id)
  return { changed: rows.length, removed, changedIds }
}

/**
 * Everything the phone mirrors, brought level with the desktop in one pass:
 * settings, usage (which rides in the same snapshot), the conversation index,
 * and the deletions an incremental pull cannot express.
 *
 * This is what runs on every reconnect and every return to the foreground —
 * the answer to "the phone was off and missed the events". Silent by design:
 * it reports nothing and shows nothing, because the user did not ask for it.
 * Each half is independent, so a desktop that cannot answer one still brings
 * the other up to date.
 */
export async function reconcile(): Promise<void> {
  const progress = beginSync()
  let settings = false
  let conversations = false
  let changedIds: string[] = []
  try {
    await Promise.allSettled([
      refreshConfig().finally(() => {
        settings = true
        progress.step({ settings, conversations })
      }),
      refreshSync(true)
        .then((result) => {
          changedIds = result.changedIds
        })
        .finally(() => {
          conversations = true
          progress.step({ settings, conversations })
        })
    ])
  } finally {
    // Always, including on failure: an overlay left up after a sync that
    // gave up is worse than the failed sync.
    progress.end()
  }
  // Bodies, for the conversations that moved while the phone was away — the
  // half a metadata pull cannot deliver, and the reason a finished turn used
  // to sit stale until the next open. Bounded and newest-first: only
  // conversations whose body is already on the device refetch (the rest
  // download on open, as ever), and a week of catch-up must not become a
  // download storm on the connect edge. After progress.end(), deliberately —
  // this is background freshening, not the sync the overlay reports.
  for (const id of changedIds.slice(0, RECONCILE_BODY_REFRESH_MAX)) {
    await refreshChangedBody(id).catch(() => undefined)
  }
}

/** How many changed conversations a single reconcile refreshes the bodies
 *  of. The rest stay metadata-fresh and download on open. */
const RECONCILE_BODY_REFRESH_MAX = 4

/**
 * The settle path for a conversation whose turn just ended — registered by
 * sync/prompt.ts (which owns live turns and cannot be imported from here
 * without a cycle). Routing through it rather than fetching directly is what
 * releases the live overlay once the stored copy holds the turn's message.
 */
let settleHook: ((conversationId: string) => void) | null = null

export function setConversationSettleHook(hook: (conversationId: string) => void): void {
  settleHook = hook
}

/**
 * Bring one changed conversation's BODY level with the desktop, respecting
 * the live-turn contract. One rule set, shared by the upsert push handler and
 * reconcile's catch-up pass, so the two signals cannot disagree:
 *
 *  - a turn still streaming fetches nothing — the assistant message is not on
 *    disk yet, and a mid-turn body is the transcript from BEFORE the turn;
 *  - a turn just ended routes through the settle path, which fetches AND
 *    releases the live overlay against the stored copy;
 *  - otherwise, a cached-but-stale body refetches. A conversation never
 *    opened has nothing here to go stale and downloads on open, as ever.
 */
async function refreshChangedBody(id: string): Promise<void> {
  const live = useChatRuntime.getState().streams[id]
  if (live?.status === 'streaming') return
  if (live) {
    settleHook?.(id)
    return
  }
  if ((await hasCachedBody(id)) && (await isBodyStale(id))) {
    const fetched = await fetchConversationBody(id).catch(() => false)
    if (fetched) invalidateConversation(id)
  }
}

/**
 * When the last catch-up finished. Persisted in sync_meta beside the cursor:
 * "last synced" is a fact about the data on this device, and the data
 * survives a relaunch, so the timestamp must too — a phone that cold-starts
 * offline with yesterday's rows should say "yesterday", never "pending".
 */
let lastSyncedAt: number | null = null
let lastSyncedHydrated = false

function noteSynced(): void {
  lastSyncedAt = Date.now()
  lastSyncedHydrated = true
  void setMeta('lastSyncedAt', String(lastSyncedAt)).catch(() => undefined)
}

export function getLastSyncedAt(): number | null {
  if (!lastSyncedHydrated) {
    lastSyncedHydrated = true
    // Fire-and-forget: callers poll (the Relay screen, every 5 s), so the
    // persisted value appears one tick later. A sync finishing in between
    // wins the race by construction — it is strictly newer.
    void getMeta('lastSyncedAt')
      .then((value) => {
        const at = Number(value)
        if (at && lastSyncedAt === null) lastSyncedAt = at
      })
      .catch(() => undefined)
  }
  return lastSyncedAt
}

/**
 * Coalesce a burst of change signals into one snapshot fetch.
 *
 * The desktop announces a config change on every path that touches settings,
 * and a single user action there can fire several. Each one is a whole
 * snapshot to pull, so the phone waits for the burst to settle instead of
 * fetching once per signal.
 */
let configRefreshTimer: ReturnType<typeof setTimeout> | null = null

function scheduleConfigRefresh(): void {
  if (configRefreshTimer) clearTimeout(configRefreshTimer)
  configRefreshTimer = setTimeout(() => {
    configRefreshTimer = null
    void refreshConfig().catch(() => undefined)
  }, 250)
}

// A failed outbox send leaves this phone claiming a value the desktop never
// took; the outbox asks for a refresh through here to re-align. Registered at
// module scope so the hook exists before the first edit could need it.
setOutboxRefreshHook(scheduleConfigRefresh)

/**
 * Pull the newest config without touching conversations — for settings
 * screens and change pushes.
 *
 * One fetch at a time, with a trailing rerun. Concurrent pulls could apply
 * out of order — whichever RESPONSE lands last wins, which is not whichever
 * state is newest — so late callers share the running fetch, and a signal
 * that arrives mid-flight queues exactly one more round after it. The fetch
 * itself goes through refreshConfigSnapshot, which keeps this phone's
 * mid-edit keys local rather than letting a raced snapshot undo them.
 */
let configRefreshRunning: Promise<void> | null = null
let configRefreshAgain = false

export function refreshConfig(): Promise<void> {
  if (configRefreshRunning) {
    configRefreshAgain = true
    return configRefreshRunning
  }
  configRefreshRunning = (async () => {
    try {
      do {
        configRefreshAgain = false
        await refreshConfigSnapshot()
      } while (configRefreshAgain)
    } finally {
      configRefreshRunning = null
    }
  })()
  return configRefreshRunning
}

/**
 * Flip one capability — the write path that makes the Capabilities screen's
 * toggle real on the paired desktop rather than cosmetic.
 *
 * The local store updates first so the switch answers the finger instantly;
 * the outbox then owns the wire (pushCapability): it sends the flip, holds
 * the key's dirty window so a snapshot raced against the edit cannot revert
 * the switch, and on any failure or refusal (locked core, stale row) asks
 * for a corrective refresh that lands the state the desktop actually holds.
 * The desktop persists through the same path as its own panel's toggle,
 * moves that panel live, and pushes config.changed back as confirmation.
 *
 * Demo mode (unpaired) keeps its offline behavior: the store owns the config
 * outright and the local edit is the whole act. Paired but disconnected
 * refuses, exactly like setConfigValue — these are the desktop's values, and
 * an edit with nowhere to land would sit on screen until the next sync
 * silently undid it.
 */
export function setCapabilityEnabled(name: string, enabled: boolean): void {
  const store = useDemoConfig.getState()
  if (!useAppStore.getState().paired) {
    store.setMapEntry('capabilities', name, enabled)
    return
  }
  if (!tunnelClient.connected) return
  store.setMapEntry('capabilities', name, enabled)
  pushCapability(name, enabled)
}

/**
 * Subscribe to the desktop's pushes so the phone feels live rather than
 * polled: a conversation started on the desktop appears here immediately, the
 * same way it appears in the desktop's own list.
 */
export function attachLiveUpdates(): () => void {
  const tunnel = tunnelClient.active
  if (!tunnel) return () => undefined

  tunnel.onEvent(Event.conversationUpserted, (payload) => {
    const meta = payload as ConversationMeta
    void upsertConversations([meta]).then(async () => {
      invalidateConversationList()
      if (!meta?.id) return
      // Unconditionally, before any staleness verdict: a mounted screen
      // showing this conversation must re-read against the metadata that
      // just landed. The old gate only invalidated when a cached body was
      // refetched, so a screen sitting on an empty or failed first fetch
      // (opened while the tunnel was still dialing) never re-ran its query
      // and stayed blank-or-stale for the session.
      invalidateConversation(meta.id)
      // A run on the desktop, or from Telegram, moves this conversation's
      // updated_at. If its body is already on the phone it is now behind, so
      // pull it — otherwise the list would show a new message count against
      // a transcript that stops short of it. Shared with reconcile's
      // catch-up pass: mid-turn fetches nothing, a just-ended turn settles.
      await refreshChangedBody(meta.id)
    })
  })

  tunnel.onEvent(Event.conversationDeleted, (payload) => {
    const id = (payload as { id?: string })?.id
    if (id) {
      // A deleted conversation cannot keep a badge — the row it would mark is
      // gone, and an unclearable count on the icon is worse than a missed one.
      // The full clear (not just the bucket): its notifications leave the tray
      // too, or the next reconciliation would find them with no row to charge.
      forgetConversationNotifications(id)
      void deleteConversation(id).then(invalidateConversationList)
    }
  })

  tunnel.onEvent(Event.configChanged, () => {
    scheduleConfigRefresh()
  })

  // Variables arrive with their payload — straight into the store, no
  // snapshot fetch, so an edit on the desktop is on this screen in the
  // push's own latency. The debounced config.changed that follows the same
  // save is then a no-op for this key and truth for everything else.
  tunnel.onEvent(Event.variablesChanged, (payload) => {
    applyVariablesPush((payload as { variables?: unknown })?.variables)
  })

  // Usage moves on every scored turn from any channel. The desktop has always
  // announced it; nothing was listening, so the Usage screen only ever showed
  // what the last snapshot happened to carry. Usage travels inside the config
  // snapshot, so both signals land on the same fetch.
  tunnel.onEvent(Event.usageChanged, () => {
    scheduleConfigRefresh()
  })

  // The three workspace stores the phone edits alongside the desktop. Each push
  // fires on EVERY committed write to its store, whoever wrote — the desktop's
  // own page, the agent's project_*/procedure_*/automation_* tools, an
  // autonomous run, or this phone's editor echoing back. Invalidation, not a
  // fetch: react-query only re-reads for a screen that is actually mounted, so
  // a push while the user is in chat costs nothing.
  tunnel.onEvent(Event.projectsChanged, () => {
    invalidateProjects()
  })

  tunnel.onEvent(Event.proceduresChanged, () => {
    invalidateProcedures()
  })

  tunnel.onEvent(Event.automationsChanged, () => {
    invalidateAutomations()
  })

  // The process registry — every start, transition, stop and edit, whoever
  // caused it. Same invalidation contract as the three stores above.
  tunnel.onEvent(Event.processesChanged, () => {
    invalidateProcesses()
  })

  // A process card re-rendered after its turn ended (a stop from the desktop's
  // page, a crash, a restart). Same fold as the countdown, keyed by cardId.
  tunnel.onEvent(Event.processCardChanged, (payload) => {
    const snapshot = (payload as { snapshot?: ProcessCardSnapshot } | null)?.snapshot
    if (!snapshot?.cardId || !snapshot.conversationId) return
    void foldProcessSnapshot(snapshot.conversationId, snapshot)
  })

  // The run pool carries its state, so it folds in without a fetch — and it is
  // also the signal that an automation just FIRED, which is the one moment a
  // served `nextRunMs` goes stale. Re-reading on it keeps the "fires in" line
  // honest instead of counting backwards past a run that already happened.
  tunnel.onEvent(Event.automationRunsChanged, (payload) => {
    applyRunsPush(readRuns(payload))
    invalidateAutomations()
  })

  // The memory index started, moved, or finished rebuilding — the one thing
  // the phone cards over its screens. Payload-carrying and throttled on the
  // desktop; `{ status: null }` is the end, which is what takes the card away.
  tunnel.onEvent(Event.reindexChanged, (payload) => {
    applyOverlayReindex(readReindex(payload))
  })

  // The desktop's self-updater — phase, download percent, ready/installing,
  // error — so the Updates screen mirrors it live. Payload-carrying like the
  // run pool: it ticks once per downloaded percent, and a fetch per tick
  // would be pure overhead.
  tunnel.onEvent(Event.updaterChanged, (payload) => {
    applyUpdaterPush(readUpdaterState(payload))
  })

  // A turn-end countdown moved (counting → fired/aborted/failed) after its
  // turn ended. Fold the snapshot into the stored message that carries the
  // card so an open conversation flips at once; a body the phone does not
  // hold yet is covered by the nudge the desktop sends after its own write.
  tunnel.onEvent(Event.countdownChanged, (payload) => {
    const snapshot = (payload as { snapshot?: CountdownSnapshot } | null)?.snapshot
    if (!snapshot?.countdownId || !snapshot.conversationId) return
    void foldCountdownSnapshot(snapshot.conversationId, snapshot)
  })

  // The conversation's in-app browser moved (a load, a tab switch, a fresh
  // still) — fold into the one `browser` segment the conversation carries,
  // keyed by conversation, the countdown contract.
  tunnel.onEvent(Event.browserChanged, (payload) => {
    const snapshot = (payload as { snapshot?: BrowserTabSnapshot } | null)?.snapshot
    if (!snapshot?.tabId || !snapshot.conversationId) return
    void foldBrowserSnapshot(snapshot.conversationId, snapshot)
  })

  return () => undefined
}

/** Whether this conversation's messages are on the device at all. */
async function hasCachedBody(id: string): Promise<boolean> {
  const db = await getDb()
  const row = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?',
    [id]
  )
  return (row?.count ?? 0) > 0
}

// --------------------------------------------------------------- persistence

/**
 * Upsert metadata. Conflicts resolve last-write-wins on `updated_at`: whoever
 * edited most recently owns the row, which matches how the two apps are used
 * — one person, two screens, never a merge.
 */
async function upsertConversations(
  rows: ConversationMeta[],
  onProgress?: (done: number) => void
): Promise<void> {
  // A row without a string id is not a conversation, it is a malformed
  // frame — and INSERTed it becomes a NULL-keyed ghost: pruneMissing can
  // never select it (`NULL NOT IN (...)` is never true), every list keyed
  // by id trips over it, and it renders as an untitled row nothing can
  // delete. Found the hard way: a test harness once pushed a wrapped
  // payload and four such ghosts survived every reconcile since.
  rows = rows.filter((row) => typeof row?.id === 'string' && row.id.length > 0)
  if (!rows.length) return
  const db = await getDb()
  let done = 0
  await db.withExclusiveTransactionAsync(async (tx) => {
    for (const row of rows) {
      await tx.runAsync(
        `INSERT INTO conversations
           (id, title, model, channel, icon, project_id, sealed, created_at, updated_at,
            message_count, stats_json, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           model = excluded.model,
           channel = excluded.channel,
           icon = excluded.icon,
           project_id = excluded.project_id,
           sealed = excluded.sealed,
           updated_at = excluded.updated_at,
           message_count = excluded.message_count,
           stats_json = excluded.stats_json,
           summary = excluded.summary
         WHERE excluded.updated_at >= conversations.updated_at`,
        [
          row.id,
          row.title ?? '',
          row.model ?? null,
          row.channel ?? null,
          row.icon ?? null,
          row.projectId ?? null,
          row.sealed ? 1 : 0,
          row.createdAt ?? row.updatedAt ?? Date.now(),
          row.updatedAt ?? Date.now(),
          row.messageCount ?? 0,
          row.stats ? JSON.stringify(row.stats) : null,
          row.summary ?? null
        ]
      )
      done += 1
      if (onProgress && done % 25 === 0) onProgress(done)
    }
  })
  onProgress?.(done)
}

/**
 * Drop every local conversation the desktop no longer lists. Runs inside one
 * statement rather than a loop: the id list is the desktop's whole truth, so
 * this is a set difference, not a sequence of decisions.
 */
async function pruneMissing(ids: string[]): Promise<number> {
  const db = await getDb()
  // Everything except the conversation ON SCREEN. An id sweep that omits the
  // open conversation is far more likely a desktop-side read race (its index
  // skips a file it happened to catch mid-life) than a real deletion — and
  // pruning it yanks the transcript out from under the user, which is how a
  // chat went blank mid-file-download until it was reselected. Real deletions
  // arrive as conversation.deleted pushes, which do take the open one down;
  // a genuinely deleted conversation the user is sitting in goes on the first
  // sweep after they leave it.
  const active = getActiveConversation()
  const keep = active && !ids.includes(active) ? [...ids, active] : ids
  // An empty desktop is a real state (everything deleted) and must prune all.
  const placeholders = keep.map(() => '?').join(',')
  const where = keep.length ? `WHERE id NOT IN (${placeholders})` : ''
  const doomed = await db.getAllAsync<{ id: string }>(`SELECT id FROM conversations ${where}`, keep)
  if (!doomed.length) return 0
  await db.withExclusiveTransactionAsync(async (tx) => {
    for (const row of doomed) {
      await tx.runAsync('DELETE FROM messages WHERE conversation_id = ?', [row.id])
      await tx.runAsync('DELETE FROM conversations WHERE id = ?', [row.id])
    }
  })
  return doomed.length
}

async function deleteConversation(id: string): Promise<void> {
  const db = await getDb()
  await db.runAsync('DELETE FROM messages WHERE conversation_id = ?', [id])
  await db.runAsync('DELETE FROM conversations WHERE id = ?', [id])
}

/**
 * Fetch one conversation's messages. Called when the user opens it, never up
 * front — this is the whole reason the index carries metadata alone.
 *
 * Single-flight per conversation, with a trailing rerun. Three callers can
 * want the same body inside one second — the open query, the settle after a
 * finished turn, the upsert push that follows the save — and un-coordinated
 * they raced whole-transcript downloads on one socket, with the LOSER's
 * DELETE+INSERT committing last: an older copy could overwrite a newer one,
 * and the duplicate download is exactly the "opening feels slower" tax. A
 * caller arriving mid-fetch now joins the flight and asks for one rerun
 * after it — its signal may describe a save the running fetch predates — so
 * everyone resolves against the freshest copy, downloaded once.
 */
export function fetchConversationBody(id: string): Promise<boolean> {
  const active = bodyFetches.get(id)
  if (active) {
    active.again = true
    return active.run
  }
  const entry = { again: false, run: Promise.resolve(false) }
  entry.run = (async () => {
    try {
      let fetched = false
      do {
        entry.again = false
        fetched = await fetchConversationBodyOnce(id)
      } while (entry.again)
      return fetched
    } finally {
      bodyFetches.delete(id)
    }
  })()
  bodyFetches.set(id, entry)
  return entry.run
}

const bodyFetches = new Map<string, { again: boolean; run: Promise<boolean> }>()

async function fetchConversationBodyOnce(id: string): Promise<boolean> {
  const tunnel = tunnelClient.active
  if (!tunnel) return false
  const db = await getDb()

  // body_synced_at answers one question — WHICH VERSION is the copy on this
  // device — and the honest answer travels with the copy: the desktop builds
  // the reply from a single read of the conversation file, so its `updatedAt`
  // describes exactly the messages in it. Two hazards it has to keep clearing:
  //
  // The clock. It must hold the desktop's own updated_at, never this phone's
  // Date.now(): the two clocks are not synchronised, so comparing across them
  // either refetches on every open (phone behind) or — the silent one — never
  // refetches again (phone ahead). The served value is the desktop's, and it
  // is the same field the index and the upsert pushes carry, so both sides of
  // the comparison in isBodyStale are one number from one file.
  //
  // The ordering. A change landing after that read still moves the desktop's
  // updated_at past this stamp, and the push carrying it makes the copy stale
  // again — so nothing is missed. What this CANNOT do, and what reading the
  // phone's row after the fetch could, is record a version the copy does not
  // contain.
  //
  // The local row is the fallback only. Read before the RPC, it holds the
  // PRE-turn updated_at for a turn run on the desktop — `turn.status: done`
  // arrives, this fetch pulls the finished transcript, and the meta push with
  // the new updated_at lands a few hundred ms later. Stamping that pre-turn
  // value marked a complete body stale and bought a second, identical
  // download of the whole conversation moments after the first.
  const before = await db.getFirstAsync<{ updated_at: number }>(
    'SELECT updated_at FROM conversations WHERE id = ?',
    [id]
  )
  // Taken here, not read off `before` later: the fallback is "what this phone
  // knew when it asked", and a push landing mid-fetch must not rewrite it.
  const askedAt = before?.updated_at ?? 0

  // `chunked: true` says this build can pull an oversize body in windows. A
  // finished tool-heavy turn can outgrow the relay's one-frame record cap,
  // and an inline answer past it does not arrive late — it CLOSES the
  // tunnel, after which every open of the conversation kills the link again.
  // The desktop answers inline when the body fits (the ordinary case) and
  // with a spool handle when it does not.
  let answer = (await tunnel.rpc(Rpc.conversationBody, { id, chunked: true })) as {
    updatedAt?: number
    messages?: Array<{
      id: string
      role: string
      content: string
      timestamp: number
      payload?: unknown
    }>
  }
  if ((answer as { chunked?: unknown } | null)?.chunked === true) {
    const pulled = await pullChunkedBody(
      (method, params, timeoutMs) => tunnel.rpc(method, params, timeoutMs),
      answer as { bodyId?: unknown; sizeBytes?: unknown }
    )
    // A broken pull leaves the copy in hand untouched, exactly as a
    // malformed inline answer does below.
    if (pulled === null || typeof pulled !== 'object') return false
    answer = pulled as typeof answer
  }
  const body = answer
  const served = body?.updatedAt
  const syncedTo = typeof served === 'number' && Number.isFinite(served) ? served : askedAt
  // No messages array is a failed lookup, not an empty conversation. The old
  // `?? []` turned any malformed answer into a DELETE of a good transcript —
  // the worst outcome available here, and invisible until the user scrolls.
  const messages = Array.isArray(body?.messages) ? body.messages : null
  if (messages === null) return false
  // An explicit empty answer over a NON-empty local copy is refused too.
  // Nothing in the product empties a conversation in place — deletion removes
  // it whole, and that arrives as conversation.deleted — so a served [] for a
  // transcript this phone holds is a desktop-side race, not a fact: the one
  // real producer is a NEW conversation's titled shell, on disk before its
  // first turn folds, handed to a fetch that raced the fold. Honouring it
  // deleted the local transcript, flipped the open chat to the empty state,
  // and the user read that as the chat going blank. A conversation with no
  // local messages still takes [] fine (there is nothing to lose), so a
  // genuinely empty one syncs as it always did.
  //
  // A LIVE overlay extends the same refusal to a conversation with nothing
  // cached yet: a turn this phone is rendering (or settling) means the served
  // [] IS that turn's pre-fold shell — a notification tap lands exactly in
  // this window, with the run seeded before the first body fetch answers.
  // Stamping the shell as the synced body cost a wasted round of emptiness;
  // refused, the settle's own retries pull the folded transcript instead.
  if (messages.length === 0) {
    if (await hasCachedBody(id)) return false
    if (useChatRuntime.getState().streams[id]) return false
  }
  await db.withExclusiveTransactionAsync(async (tx) => {
    await tx.runAsync('DELETE FROM messages WHERE conversation_id = ?', [id])
    let seq = 0
    for (const message of messages) {
      // Compact at the store boundary: the desktop streams prose as one text
      // segment per model tick and (until it coalesces its own persists) can
      // serve a single reply as THOUSANDS of few-character segments — one
      // meme automation's answer arrived as 2,441 of them, ~250 KB of pure
      // segment envelope on a 10 KB reply, re-parsed on every later read.
      // Adjacent same-run text folds into one segment here, once, so SQLite
      // and every render after it hold the compact shape.
      let payload = message.payload as Record<string, unknown> | null | undefined
      if (payload && Array.isArray(payload.segments)) {
        payload = { ...payload, segments: coalesceTextSegments(payload.segments as Segment[]) }
      }
      await tx.runAsync(
        `INSERT INTO messages (conversation_id, seq, id, role, content, timestamp, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          seq++,
          message.id,
          message.role,
          message.content ?? '',
          message.timestamp ?? Date.now(),
          payload ? JSON.stringify(payload) : null
        ]
      )
    }
    // Stamped inside the same transaction as the rows it describes, so a
    // failed write can never leave the phone believing it is current.
    await tx.runAsync('UPDATE conversations SET body_synced_at = ? WHERE id = ?', [syncedTo, id])
  })
  // The copy in hand is fresh — whatever evidence a notification carried
  // about this conversation is answered by it.
  clearConversationDirty(id)
  // Every file this conversation shows, pulled into the cache now rather than
  // when its card scrolls into view — the difference between attachments that
  // are simply there and a screen of spinners resolving one by one. Fire and
  // forget: the viewers resolve the same paths themselves and dedupe against
  // this via the cache's in-flight map, so a slow prefetch delays nothing.
  //
  // Only for the conversation on screen (or an open that outran the focus
  // report). Body fetches also run in the BACKGROUND now — settle retries,
  // reconcile's catch-up, the upsert push — and their file prefetches were
  // contending on the one socket with the transfers the visible cards were
  // waiting on; a starved transfer times out, and a timed-out card used to
  // read as "deleted". Background conversations keep fresh transcripts and
  // download their files on open, exactly as before the catch-up existed.
  const active = getActiveConversation()
  if (active === null || active === id) {
    void prefetchConversationFiles(id, referencedFilePaths(messages))
  }
  return true
}

/** Sanity ceiling on a chunked body — far above any real conversation, and
 *  the guard that a corrupt `sizeBytes` can never drive an unbounded pull. */
const CHUNKED_BODY_MAX_BYTES = 64 * 1024 * 1024

/** Chunk pulls in flight at once. The tunnel multiplexes RPCs on one socket,
 *  so the win is pipelining: each serial window paid a full relay round trip
 *  of dead air, which on a big transcript was the whole "opening this
 *  conversation got slower". Three keeps under a megabyte of base64 in
 *  flight — comfortably inside the relay's per-record cap per answer. */
const CHUNK_PULL_CONCURRENCY = 3

/**
 * Pull an oversize conversation body the desktop spooled for chunked pickup —
 * base64url windows on the fileRead contract, reassembled and parsed here.
 * Returns the parsed wire conversation, or null on ANY failure (expired
 * spool, short read, malformed JSON): the caller then keeps its cached copy
 * untouched, exactly as it does for a malformed inline answer.
 *
 * Windows are pulled CONCURRENTLY at fixed offsets, which is safe because the
 * desktop serves exactly the window asked for (capped only by CHUNK_SIZE and
 * the end of the spool). A server that answers short anyway — some other
 * implementation of the contract — drops this to the sequential pull below,
 * which advances by the bytes actually served, exactly as before.
 *
 * Takes the rpc function rather than the tunnel so tests can drive it
 * without a transport.
 */
export async function pullChunkedBody(
  rpc: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>,
  meta: { bodyId?: unknown; sizeBytes?: unknown }
): Promise<unknown | null> {
  const bodyId = typeof meta.bodyId === 'string' ? meta.bodyId : ''
  const sizeBytes =
    typeof meta.sizeBytes === 'number' && Number.isFinite(meta.sizeBytes) ? meta.sizeBytes : 0
  if (!bodyId || sizeBytes <= 0 || sizeBytes > CHUNKED_BODY_MAX_BYTES) return null
  const fast = await pullWindowsParallel(rpc, bodyId, sizeBytes)
  if (fast !== 'short') return fast
  return pullWindowsSequential(rpc, bodyId, sizeBytes)
}

/** Bulk-window timeout, matching the file transfer's: a CHUNK_SIZE frame on
 *  a slow link can honestly need more than the 30s control-RPC default. */
const BODY_WINDOW_TIMEOUT_MS = 120_000

/** One window off the wire, or null on any transport/shape failure. */
async function pullWindow(
  rpc: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>,
  bodyId: string,
  offset: number
): Promise<Uint8Array | null> {
  try {
    const chunk = (await rpc(
      Rpc.conversationBodyChunk,
      {
        bodyId,
        offset,
        length: CHUNK_SIZE
      },
      BODY_WINDOW_TIMEOUT_MS
    )) as { data?: unknown } | null
    return fromBase64Url(typeof chunk?.data === 'string' ? chunk.data : '')
  } catch {
    return null
  }
}

/**
 * The fast path: every window at its computed offset, a few in flight at a
 * time. `'short'` means a window came back smaller than the contract promises
 * — not an error, a server this path does not understand — and the caller
 * falls back to the sequential pull. Empty windows and transport failures are
 * final: the spool expired, and a truncated transcript must never parse as a
 * complete one.
 */
async function pullWindowsParallel(
  rpc: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>,
  bodyId: string,
  sizeBytes: number
): Promise<unknown | null | 'short'> {
  const offsets: number[] = []
  for (let at = 0; at < sizeBytes; at += CHUNK_SIZE) offsets.push(at)
  const parts = new Array<Uint8Array | null>(offsets.length).fill(null)
  let failed = false
  let short = false
  let next = 0
  const worker = async (): Promise<void> => {
    while (!failed && !short) {
      const index = next
      next += 1
      if (index >= offsets.length) return
      const offset = offsets[index]
      const bytes = await pullWindow(rpc, bodyId, offset)
      if (bytes === null || bytes.length === 0) {
        failed = true
        return
      }
      const expected = Math.min(CHUNK_SIZE, sizeBytes - offset)
      if (bytes.length !== expected) {
        short = true
        return
      }
      parts[index] = bytes
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CHUNK_PULL_CONCURRENCY, offsets.length) }, worker)
  )
  if (failed) return null
  if (short) return 'short'
  return assembleBody(parts as Uint8Array[], sizeBytes)
}

/** The tolerant path: advance by the bytes actually served, whatever their
 *  size — the original contract, kept for any peer that windows differently. */
async function pullWindowsSequential(
  rpc: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>,
  bodyId: string,
  sizeBytes: number
): Promise<unknown | null> {
  const parts: Uint8Array[] = []
  let offset = 0
  while (offset < sizeBytes) {
    const bytes = await pullWindow(rpc, bodyId, offset)
    // An empty window before the promised end means the spool expired or
    // shrank — a truncated transcript must never parse as a complete one.
    if (bytes === null || bytes.length === 0) return null
    parts.push(bytes)
    offset += bytes.length
  }
  return assembleBody(parts, offset)
}

function assembleBody(parts: Uint8Array[], totalBytes: number): unknown | null {
  try {
    const whole = new Uint8Array(totalBytes)
    let at = 0
    for (const part of parts) {
      whole.set(part, at)
      at += part.length
    }
    return JSON.parse(new TextDecoder().decode(whole))
  } catch {
    return null
  }
}

/**
 * The workspace paths a fetched body renders, unioned across its messages.
 * Each wire message is reshaped exactly as the repo stores it — payload
 * spread under the core columns — before messageFilePaths reads it, so the
 * collection sees what the feed will see.
 */
function referencedFilePaths(
  messages: Array<{
    id: string
    role: string
    content: string
    timestamp: number
    payload?: unknown
  }>
): string[] {
  const seen = new Set<string>()
  for (const message of messages) {
    const payload = (message.payload ?? {}) as Partial<ConversationMessage>
    const full: ConversationMessage = {
      ...payload,
      id: message.id,
      role: message.role === 'user' ? 'user' : 'assistant',
      content: message.content ?? '',
      timestamp: message.timestamp
    }
    for (const relPath of messageFilePaths(full)) seen.add(relPath)
  }
  return [...seen]
}

/**
 * One file at a time, deliberately: the tunnel serializes onto one socket
 * anyway, and a burst of parallel downloads would only compete with the
 * chunk requests of whichever file the user is actually looking at.
 */
async function prefetchConversationFiles(
  conversationId: string,
  relPaths: string[]
): Promise<void> {
  for (const relPath of relPaths) {
    try {
      await resolveWorkspaceFile(relPath, conversationId)
    } catch {
      // A file that will not come is the viewer's problem to report.
    }
  }
}

/**
 * Has this conversation changed on the desktop since its body was pulled?
 *
 * The check that keeps an already-cached conversation from going stale: a
 * body is only skipped when it is empty *and* current, never merely because
 * it has messages in it.
 */
export async function isBodyStale(id: string): Promise<boolean> {
  const db = await getDb()
  const row = await db.getFirstAsync<{ updated_at: number; body_synced_at: number | null }>(
    'SELECT updated_at, body_synced_at FROM conversations WHERE id = ?',
    [id]
  )
  if (!row) return false
  return row.body_synced_at === null || row.updated_at > row.body_synced_at
}

// ------------------------------------------------------------------- cursor

/**
 * The cursor lives in SQLite beside the rows it describes, so it can never
 * disagree with them — a cleared database resyncs from zero automatically.
 */
async function ensureMeta(): Promise<void> {
  const db = await getDb()
  await db.execAsync('CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT)')
}

async function getMeta(key: string): Promise<string | null> {
  await ensureMeta()
  const db = await getDb()
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM sync_meta WHERE key = ?',
    [key]
  )
  return row?.value ?? null
}

async function setMeta(key: string, value: string): Promise<void> {
  await ensureMeta()
  const db = await getDb()
  await db.runAsync(
    'INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  )
}

export async function getSyncCursor(): Promise<number> {
  return Number(await getMeta('cursor')) || 0
}

async function setSyncCursor(at: number): Promise<void> {
  await setMeta('cursor', String(at))
}

/** Replace the matching `process` segment's snapshot in the stored body. */
async function foldProcessSnapshot(
  conversationId: string,
  snapshot: ProcessCardSnapshot
): Promise<void> {
  const conversation = await getConversation(conversationId).catch(() => null)
  if (!conversation) return
  let changed = false
  for (const message of conversation.messages) {
    const segments = message.segments ?? []
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      if (seg.kind === 'process' && seg.snapshot.cardId === snapshot.cardId) {
        segments[i] = { ...seg, snapshot }
        changed = true
      }
    }
    if (changed) {
      await replaceMessage(conversationId, message).catch(() => undefined)
      break
    }
  }
  if (changed) invalidateConversation(conversationId)
}

/** Replace the conversation's `browser` segment snapshot in the stored body. */
async function foldBrowserSnapshot(
  conversationId: string,
  snapshot: BrowserTabSnapshot
): Promise<void> {
  const conversation = await getConversation(conversationId).catch(() => null)
  if (!conversation) return
  let folded = false
  for (const message of conversation.messages) {
    const segments = message.segments ?? []
    let changed = false
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      if (
        seg.kind === 'browser' &&
        (seg.snapshot.conversationId ?? seg.snapshot.tabId) ===
          (snapshot.conversationId ?? snapshot.tabId)
      ) {
        segments[i] = { ...seg, snapshot }
        changed = true
      }
    }
    if (changed) {
      await replaceMessage(conversationId, message).catch(() => undefined)
      folded = true
      // keep going: the latest holder wins on render, but every copy stays current
    }
  }
  // Only when a stored copy actually moved — the browser pushes on every load,
  // tab switch and still, and a conversation whose body holds no browser
  // segment yet (the live turn's) must not pay a body re-read for each one.
  if (folded) invalidateConversation(conversationId)
}

/** Replace the matching `countdown` segment's snapshot in the stored body. */
async function foldCountdownSnapshot(
  conversationId: string,
  snapshot: CountdownSnapshot
): Promise<void> {
  const conversation = await getConversation(conversationId).catch(() => null)
  if (!conversation) return
  let changed = false
  for (const message of conversation.messages) {
    const segments = message.segments ?? []
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      if (seg.kind === 'countdown' && seg.snapshot.countdownId === snapshot.countdownId) {
        segments[i] = { ...seg, snapshot }
        changed = true
      }
    }
    if (changed) {
      await replaceMessage(conversationId, message).catch(() => undefined)
      break
    }
  }
  if (changed) invalidateConversation(conversationId)
}
