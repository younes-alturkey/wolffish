/**
 * The Mobile channel — the desktop end of the tunnel to wolffish-mobile.
 *
 * Structurally a sibling of the Telegram and WhatsApp channels: it owns a
 * transport, exposes status to the settings panel, and serves the agent's
 * world to a remote surface. What differs is the shape of that surface. A
 * Telegram chat is a message stream; the phone is a second view of the whole
 * app, so this channel answers for configuration, the conversation index,
 * conversation bodies on demand, and usage — and pushes changes as they
 * happen so the phone stays live rather than polling.
 *
 * The desktop is the `host`: it parks on the relay and waits. The phone dials
 * in when it is in the foreground and disappears when iOS suspends it, which
 * is why every reconnect re-handshakes and nothing here assumes continuity.
 */
import type { BrowserTabSnapshot } from '@main/browser/types'
import {
  loadIdentity,
  loadPairing,
  loadRelayUrl,
  peerKeyBytes,
  ridForPairing,
  savePairing,
  saveRelayUrl,
  secretBytes,
  updatePairing,
  clearPairing,
  storageBackend,
  type MobilePairing
} from '@main/channels/mobile/keys'
import { buildConfigSnapshot, type SnapshotSources } from '@main/channels/mobile/snapshot'
import {
  assistantSegmentsToHistory,
  buildAssistantMessage,
  replayWindow,
  stubStaleToolResults,
  type AssistantAccumulator,
  type MirrorMessageListener
} from '@main/channels/channel'
import { fitMirrorMessage, fitWireMessages } from '@main/channels/mirror-budget'
import { registerInterjectionDispatcher } from '@main/channels/interjection-reconciler'
import { releaseHeldInterjection } from '@main/channels/interjection-store'
import { extractTranscript, extractVoiceLanguage } from '@main/channels/stt-result'
import {
  createConversation,
  listConversations,
  loadConversation,
  mintMessageId,
  saveConversation,
  updateConversation,
  type ConversationFile,
  type ConversationMessage,
  type MessageAttachment
} from '@main/conversations'
import {
  adoptUploadedProcedureFile,
  createProcedure,
  deleteProcedure,
  listProcedures,
  updateProcedure,
  type Procedure,
  type ProcedureFileRef
} from '@main/procedures'
import {
  adoptUploadedProjectFile,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
  type Project,
  type ProjectFileRef
} from '@main/projects'
import { nextCronMs } from '@main/runtime/brainstem'
import type { QueuedJobInfo, RunningJobInfo } from '@main/runtime/brainstem'
import { composeAttachmentContext } from '@main/uploads/compose-attachments'
import {
  classifyFile,
  resolveUploadPath,
  saveUploadFromFile,
  statUpload,
  uploadExists
} from '@main/uploads/uploads'
import { adoptUploadedAutomationFile } from '@main/automations/files'
import { resolveWorkingDirectory } from '@main/uploads/owned-copies'
import { readViewerFile, writeViewerFile } from '@main/viewer'
import { workspaceRoot } from '@main/workspace/root'
import { processManager } from '@main/processes/instance'
import {
  CHUNK_SIZE,
  DEFAULT_RELAY_URL,
  Event,
  PUSH_WIRE_VERSION,
  REASONING_MODES,
  Rpc,
  type ReasoningMode,
  type AutomationJob,
  type AutomationRuns,
  type ConversationMeta,
  type DiagnosticProgress,
  type DiagnosticResult,
  type NotifyFrame,
  type NotifyResultFrame,
  type OverlaySeed,
  type ReindexStatus,
  type SyncProcedure,
  type SyncProject,
  type UpdaterWireState
} from '@main/tunnel/protocol'
import {
  MOBILE_CAPABILITY_NAME,
  TTL_BY_PHASE,
  buildMobileCapability,
  mintNotificationId,
  type NotifyPhoneRequest
} from '@main/channels/mobile/tools'
import {
  generateCode,
  encodePairingPayload,
  rendezvousId,
  secretFromCode,
  toBase64Url,
  toHex,
  CODE_TTL_MS
} from '@main/tunnel/pairing'
import { Tunnel, type TunnelState } from '@main/tunnel/tunnel'
import { getPlanMode, onPlanModeChange, setPlanMode } from '@main/runtime/plan-mode'
import type { TurnRunner } from '@main/channels/turn-runner'
import { TurnStatsCollector } from '@main/channels/turn-stats'
import type { TurnSink } from '@main/channels/channel'
import {
  CODE_ACTIVITY_TOOLS,
  appendTextSegment,
  upsertTaskSegment,
  upsertTodoSegment,
  upsertWorkflowSegment,
  type Segment,
  type CountdownSnapshot,
  upsertCountdownSegment,
  upsertWaitSegment,
  upsertToolResultSegment,
  upsertProcessSegment,
  upsertBrowserSegment
} from '@main/runtime/broca'
import type { ApprovalDecision, ApprovalRequest } from '@main/runtime/amygdala'
import type {
  Interjection,
  InterjectResult,
  InterjectionEvent
} from '@main/runtime/agent/interjection'
import { OFFER_OPTIONS_TOOL } from '@main/runtime/cerebellum'
import type { AskUserAnswer, AskUserRequest, AskUserResponse } from '@main/runtime/cerebellum'
import type { ChatHistoryMessage } from '@preload/index'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Min gap between live mirror snapshots of an in-flight turn — the same budget
 * the Electron/Telegram/WhatsApp mirrors use, for the same reason: a fast text
 * stream must not emit (and make the phone re-render) per token.
 */
const MIRROR_THROTTLE_MS = 500

/**
 * How long a notify waits for the relay's notify_result before reporting the
 * notification as dropped. The relay answers before it talks to Expo, so a
 * healthy round trip is tens of milliseconds — this only fires against an
 * unreachable relay or one that predates the push control plane.
 */
const NOTIFY_RESULT_TIMEOUT_MS = 10_000

/**
 * Ceiling on one mirrored message, well under the relay's 1 MiB record cap.
 * Events are single frames — nothing chunks them — so an oversized push is not
 * a slow push, it is a closed connection (CloseCode.MessageTooLarge). A turn
 * that accumulates more (a few large tool outputs) is TRIMMED to fit — tool
 * payloads shortened oldest-first, the live edge kept whole — never withheld:
 * withholding is how a 12-minute Gmail sweep once went dark on the phone for
 * its whole remaining runtime, and a phone relaunched mid-turn came back to a
 * blank conversation. The saved transcript restores every byte at the fold.
 */
const MIRROR_MAX_BYTES = 384 * 1024

/**
 * Byte budget for the mirror rail — the sustained rate the full-snapshot
 * pushes may ask of the tunnel, per conversation. The 500ms throttle bounds
 * mirrors in TIME; nothing bounded them in BYTES, and a long turn's snapshot
 * grows without limit until every emit is a six-figure payload twice a second
 * (768 KB/s at the ceiling) on a single FIFO socket the relay forwards
 * fire-and-forget. A phone link slower than that never catches up: the queue
 * grows for the whole run, every other event sits behind it, and the phone
 * replays the backlog for minutes after the desktop finished — the reply
 * still "streaming" a word a second long after the turn ended.
 *
 * So a mirror's own size sets the earliest moment of the NEXT one: under
 * 16 KB keeps the 500ms cadence (every ordinary turn — nothing changes),
 * a 125 KB automation monster drops to one every ~4s, the ceiling to one
 * every 12s. Nothing is lost to the slower cadence: a skipped tick's content
 * rides the next snapshot (each is a superset of the last), the trailing
 * flush below sends the newest cached snapshot the moment the window opens,
 * and phone-run turns keep their token-by-token feel from the delta rail,
 * whose cost is the prose itself.
 *
 * The budget is charged GLOBALLY as well as per conversation — the socket is
 * one pipe, and two automations overlapping would otherwise each claim the
 * full rate and rebuild the very backlog this bounds. The number leaves
 * interactive headroom (deltas, card events, file chunks) even on a 3G-grade
 * ~50 KB/s link.
 */
const MIRROR_BYTES_PER_SEC = 32 * 1024

/**
 * Local-socket backlog above which even a due mirror waits. bufferedAmount
 * sees only the desktop→relay hop — what the relay is still holding for a
 * slow phone drains out of sight — so this is a supplement to the byte
 * pacing above, not the mechanism: it catches this machine's own uplink
 * filling, which no wall-clock budget can.
 */
const MIRROR_BACKLOG_MAX_BYTES = 512 * 1024

/** Re-check cadence while a due mirror waits out a congested socket. */
const MIRROR_RETRY_MS = 250

/**
 * Ceiling on one served conversation body, under the same 1 MiB record cap
 * with room for the RPC envelope, encryption overhead and the metadata
 * columns riding beside the messages. A body that outgrew it used to go out
 * anyway — and the relay answered by CLOSING the tunnel, after which every
 * open of that conversation killed the link again. Over this, messages are
 * served trimmed (fitWireMessages) rather than the connection lost.
 */
const WIRE_BODY_MAX_BYTES = 768 * 1024

/** How long a spooled oversize body waits for its chunked pickup. Refreshed
 *  on every read, so only an abandoned pull ever expires mid-transfer. */
const BODY_SPOOL_TTL_MS = 2 * 60_000

/** Concurrent spools kept at most — one per open conversation, and a phone
 *  opens one at a time; the cap is a leak guard, not a feature. */
const BODY_SPOOL_MAX = 4

/**
 * What a non-verbose phone is shown WHILE a turn runs: assistant prose,
 * file-bearing results and errors, task and options cards — the clean feed the Mobile
 * panel's "Task results / off" setting describes. Tool mechanics are held
 * back from the live push, exactly as they were when this channel nudged
 * instead of mirroring; the stored body the phone reads afterwards still
 * carries everything, and its own verbose switch decides what to draw.
 */
function isCleanFeedSegment(segment: Segment): boolean {
  return (
    segment.kind === 'text' ||
    // The user's OWN words, read mid-turn. Never tool mechanics, never
    // optional: the phone retires its pending bubble the instant the
    // `delivered` push lands, so a mirror that filtered this out made the
    // message the user had just typed disappear from the screen for the rest
    // of the run — visibly dropped, and only restored when the stored body
    // replaced the overlay at the fold.
    segment.kind === 'user_message' ||
    // In-place thinking is the reply's provenance, not tool mechanics — the
    // in-app feed and the phone's stored bodies show it regardless of
    // verbose, so the live mirror must too or the cards pop in only after
    // the turn persists.
    segment.kind === 'reasoning' ||
    segment.kind === 'tool_result' ||
    // The code tools are the one call the clean feed does show: an edit, a
    // write or a shell run is a change in the user's project, and the phone
    // draws it as a compact activity row (label, path, +N −M, exit code) —
    // which needs the call's name and args, not just its result.
    (segment.kind === 'tool_call' && CODE_ACTIVITY_TOOLS.has(segment.name)) ||
    // The copy-and-paste options card. Its ENTIRE content lives in the call's
    // args — there is no result to fall back on — so stripping the call here
    // would leave the phone with nothing to draw until the turn persisted.
    (segment.kind === 'tool_call' && segment.name === OFFER_OPTIONS_TOOL) ||
    segment.kind === 'task' ||
    segment.kind === 'countdown' ||
    // Why the agent went quiet. A wait with no card is indistinguishable
    // from a hang, which is the one thing the phone must never look like.
    segment.kind === 'wait' ||
    // A live process card: the phone lists the processes with their state.
    segment.kind === 'process' ||
    // A page open in the in-app browser: the phone draws it as a link card.
    segment.kind === 'browser' ||
    segment.kind === 'todo' ||
    segment.kind === 'separator' ||
    segment.kind === 'turn_end'
  )
}

export type MobileStatus = {
  /** Nothing paired, or a phone is known. */
  paired: boolean
  pairing: {
    method: 'qr' | 'code'
    pairedAt: number
    lastSeenAt: number | null
    deviceName: string | null
    /** How the phone describes itself. Null on a phone running an older build. */
    platform: 'ios' | 'android' | null
    model: string | null
    osVersion: string | null
    appVersion: string | null
  } | null
  /** Live tunnel state; null before a tunnel is started. */
  tunnel: TunnelState | null
  /** Present only while a pairing offer is open. */
  offer: {
    mode: 'qr' | 'code'
    /** The QR's payload string; the panel renders it as a QR image. */
    payload: string | null
    /** The typed code, formatted `K7M9-2QXR`. */
    code: string | null
    expiresAt: number
  } | null
  /** Which platform store protects the keys, for the privacy card. */
  storage: { available: boolean; backend: string }
  verbose: boolean
  /** Whether the model's notify_phone tool may send push notifications. */
  notificationsEnabled: boolean
  /** Relay endpoint the tunnel dials — known before pairing, shown in the panel. */
  relayUrl: string
  /** What "reset to default" returns to, so the panel needn't hardcode it. */
  defaultRelayUrl: string
}

/** The reflection fields the phone may patch — mirrors workspace's ReflectionConfig. */
export type ReflectionWirePatch = {
  hour?: number
  quietHours?: number
}

export type MobileChannelDeps = SnapshotSources & {
  /** Runs turns the phone starts, exactly as the other channels do. */
  runner: TurnRunner
  /**
   * Parked mid-turn messages for a conversation — the live inbox plus what the
   * durable park is holding after a Stop. Supplied by main so one assembler
   * answers the phone, the in-app window and the terminal identically.
   */
  listPendingInterjections: (
    conversationId: string
  ) => Promise<Array<Interjection & { held?: boolean }>>
  /**
   * Apply a reflection-config patch exactly as the settings IPC does —
   * persist, reschedule, announce — answering the complete post-write
   * config. Optional so hosts that don't serve reflection simply refuse.
   */
  applyReflectionConfig?: (patch: ReflectionWirePatch) => Promise<Record<string, unknown>>
  /** Start a reflection job now — the same enqueue the panel's Run-now uses. */
  runReflectionJob?: (
    kind: 'reflection' | 'deepClean'
  ) => Promise<'running' | 'queued' | 'coalesced'>
  /**
   * Apply a phone-edited settings patch through the same setters the
   * desktop's own panels use. Whitelisted inside; throws on unknown keys.
   * Absent = phone settings stay a read-only mirror.
   */
  applySettings?: (settings: Record<string, unknown>) => Promise<void>
  /** Replace the workspace's prompt variables — the phone's Variables page. */
  applyVariables?: (
    variables: Array<{ name: string; value: string; sensitive: boolean }>
  ) => Promise<void>
  /**
   * Flip one capability through the same implementation the desktop's own
   * settings toggle runs. Resolves to the enabled state that actually holds
   * (a locked core refuses the off); throws on a name this desktop no longer
   * has, which can only be a stale phone screen.
   */
  applyCapability?: (name: string, enabled: boolean) => Promise<boolean>
  /**
   * One month of this build's own release notes, markdown verbatim — the
   * same pages the desktop's Changelog screen reads. Null for a month this
   * build does not carry. Absent = the snapshot omits `changelog` and the
   * phone's What's-new desktop tab shows its empty state.
   */
  readChangelog?: (month: string, locale: string) => Promise<string | null>
  /**
   * The self-updater, reached through the SAME registered handlers the
   * desktop's own Updates panel and the CLI invoke (main wires these to
   * updater:getState / updater:check / updater:install) — one implementation,
   * three surfaces. `updaterCheck` carries the desktop's own guards: a check
   * never disturbs an in-flight download. `updaterInstall` must answer BEFORE
   * arming the restart, because its reply has to leave on a tunnel the
   * shutdown is about to close; `ok: false` means nothing verified is ready.
   * All three absent = this desktop cannot self-update, and the phone's card
   * stays the mirror-only surface it was before the feature.
   */
  updaterState?: () => Promise<UpdaterWireState>
  updaterCheck?: () => Promise<{ ok: boolean; version?: string | null; error?: string }>
  updaterInstall?: () => Promise<{ ok: boolean }>
  /** Abort a pending turn-end countdown from the phone's card. */
  countdownAbort?: (countdownId: string) => Promise<{ ok: boolean; error?: string }>
  /**
   * Persisted switch for model-initiated phone notifications. Absent = the
   * feature is always on (tests). Checked before anything else in the notify
   * path, so "off" means no frame is even built.
   */
  loadNotificationsEnabled?: () => Promise<boolean>
  saveNotificationsEnabled?: (enabled: boolean) => Promise<void>
  /**
   * Persisted feed preference — see setVerbose. Stored beside notifications
   * so the phone's feed reads the same on the next launch as it did on this
   * one. Absent = clean feed, never remembered (tests).
   */
  loadVerbose?: () => Promise<boolean>
  saveVerbose?: (verbose: boolean) => Promise<void>
  /** Broadcast to the renderer so the panel updates without polling. */
  onStatus?: (status: MobileStatus) => void
  /**
   * One conversation's stored metadata changed because the PHONE wrote it —
   * today only a project re-file. Announced so this app's own rail, History and
   * Projects pages re-read, exactly as they do for a re-file made here. Absent
   * = no renderer to tell (tests).
   */
  onConversationChanged?: (conversationId: string) => void
  /**
   * Relay logging. Always on and always per-day, in the workspace log beside
   * every other channel: the desktop is the source of truth for what the
   * connection did, and the phone keeps no log of its own.
   */
  log?: (line: string) => void
  /** Detail for diagnosis — frame-level activity, resolved values. */
  debug?: (line: string) => void
  relayUrl?: string
}

/** Chunked uploads park here until committed — under the workspace uploads
 *  root so the final adopt is a same-volume atomic rename. Dot-prefixed so it
 *  can never collide with a conversation's `conv-…` upload folder. */
const UPLOAD_STAGING_DIR = '.pending'
/** An upload nobody has touched for this long is abandoned and swept. */
const UPLOAD_IDLE_MS = 10 * 60_000
/** Ceiling for one uploaded file. Far above anything the phone produces today
 *  (a voice note is ~1 MB/min); exists so a runaway client stays bounded. */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024

/** The scheduler's source file, workspace-relative — the desktop's own path. */
const HEARTBEAT_PATH = 'brain/brainstem/heartbeat.md'

/**
 * Ceilings on phone-authored text. Every one is far above anything a person
 * types on a phone and exists for the same reason MAX_UPLOAD_BYTES does: these
 * values are written into workspace files the agent reads back as instructions,
 * so a runaway client must stay bounded rather than grow one unboundedly.
 */
const ID_MAX = 128
const ICON_MAX = 16
const TITLE_MAX = 200
const INSTRUCTIONS_MAX = 100_000
const PROMPT_MAX = 100_000
const HEARTBEAT_MAX = 1_000_000
/**
 * Floor between two reindex progress ticks on the wire. The rebuild indexes in
 * batches of eight files and emits on each, which on a real workspace is far
 * faster than a phone can repaint one line of text — and far faster than anyone
 * can read it.
 */
const REINDEX_PUSH_THROTTLE_MS = 1_000

type PendingUpload = {
  /**
   * Where the committed bytes land. Decided once, at begin, and never read
   * before then: the transfer itself (ordering, idle sweep, size ceiling) is
   * identical for both destinations, so only the commit branches.
   */
  target:
    | { kind: 'conversation'; conversationId: string }
    | { kind: 'project'; projectId: string }
    | { kind: 'procedure'; procedureId: string }
    /**
     * An automation has no id — heartbeat.md is its store — so the phone sends
     * the `file:` paths it already holds and the desktop derives the dir from
     * them. The MARKER is the phone's to write; the commit only answers with
     * the absolute path it chose.
     */
    | { kind: 'automation'; existing: string[] }
  name: string
  mimeType: string | null
  /** Size the phone declared at begin — commit refuses any other total. */
  expected: number
  received: number
  stagedPath: string
  handle: fs.FileHandle
  idleTimer: ReturnType<typeof setTimeout>
}

export class MobileChannel {
  private tunnel: Tunnel | null = null
  private offer: MobileStatus['offer'] = null
  private offerTimer: ReturnType<typeof setTimeout> | null = null
  private pairing: MobilePairing | null = null
  private tunnelState: TunnelState | null = null
  private verbose = false
  /** Mutable: the panel can point the tunnel at a self-hosted relay. */
  private relayUrl: string
  /** Live turns the phone started, so it can abort them. */
  private readonly turns = new Map<string, { turnId: string; controller: AbortController }>()
  /**
   * Requests the agent has parked waiting on the phone, keyed by request id —
   * approvals and ask-the-user cards, exactly as the Electron channel holds
   * the renderer's. The turn is BLOCKED inside the pipeline until one of these
   * resolves, so every exit path has to fire one: the phone's answer, the end
   * of the turn, or the tunnel going away. None of them may be missed.
   */
  private readonly pendingApprovals = new Map<
    string,
    {
      turnId: string
      conversationId: string
      resolve: (decision: ApprovalDecision) => void
      /** The turn's accumulator map, so a decision reaches the saved record. */
      approvals: AssistantAccumulator['approvals']
    }
  >()
  private readonly pendingAsks = new Map<
    string,
    {
      turnId: string
      conversationId: string
      resolve: (response: AskUserResponse) => void
      /** The card as it was pushed, re-served to a phone that rejoins mid-park
       *  (a relaunched app has lost the original push and nothing re-sends it). */
      card: { toolCallId: string; questions: AskUserRequest['questions'] }
    }
  >()
  /**
   * The newest mirror snapshot per conversation with a turn in flight — the
   * fitted message exactly as the last push carried it (or would have, had a
   * phone been connected), plus the prompt it answers. This is what
   * Rpc.turnMirror serves: a phone that connects — or RECONNECTS after iOS
   * killed it — mid-turn has missed every push so far, and across a long tool
   * call the next one is minutes away; this cache is the only copy of the
   * turn-so-far anywhere outside the accumulator. Written on every mirror
   * tick whether or not a phone is listening, dropped when the turn ends.
   */
  private readonly lastMirrors = new Map<
    string,
    /** deltaSeq: how many text deltas had been pushed when this snapshot was
     *  cached — the trailing flush's staleness check (see mirrorDeltaSeq). */
    { message: ConversationMessage; userMessage?: ConversationMessage; deltaSeq?: number }
  >()
  /**
   * Mirror pacing per conversation: when the last snapshot was actually SENT
   * and how big it was — its size decides the earliest next send — plus the
   * trailing timer that pushes the newest cached snapshot once the window
   * opens. A deferred tick loses nothing: lastMirrors above always holds the
   * freshest fitted snapshot, and the flush sends THAT, so the phone's next
   * mirror is a superset of every one skipped under it.
   */
  private readonly mirrorPace = new Map<
    string,
    { sentAt: number; sentBytes: number; timer: NodeJS.Timeout | null }
  >()
  /**
   * The whole rail's last send — every conversation's mirrors share one
   * socket, so the byte budget is charged here as well as per conversation:
   * concurrent turns split the rate instead of stacking it.
   */
  private mirrorRail = { sentAt: 0, sentBytes: 0 }
  /**
   * Text deltas pushed per conversation, counted so the trailing flush can
   * tell whether its cached snapshot is already BEHIND the delta rail. A
   * snapshot is only allowed to reset the phone's tail when it contains
   * every delta sent before it (prompt.ts composes on that promise); one
   * cached before the newest delta would punch that delta's words out of
   * the visible prose. Such a flush is skipped — the phone holds the words
   * as tail, and the next fresh tick sends a snapshot that truly contains
   * them.
   */
  private readonly mirrorDeltaSeq = new Map<string, number>()
  /**
   * Live out-of-window mirror INTO the renderer — the exact counterpart of
   * ElectronChannel.setMessageMirror, pointed the other way. A phone-run turn
   * used to reach the desktop's own window only at the end-of-turn save, so
   * an open conversation there sat on a thinking shimmer for the whole run
   * while the phone showed prose and cards. index.ts wires this to the same
   * `conversation:messageMirror` broadcast the Telegram/WhatsApp mirrors use;
   * the renderer upserts by the stable message id, so the saved copy replaces
   * the snapshot rather than joining it.
   */
  private rendererMirror: MirrorMessageListener | null = null

  setMessageMirror(listener: MirrorMessageListener | null): void {
    this.rendererMirror = listener
  }

  /**
   * The cached turn-so-far for one conversation, for surfaces on THIS
   * machine — the renderer's counterpart of Rpc.turnMirror. A window opened
   * (or reloaded) mid-run has the same problem a rejoining phone does: the
   * assistant message is not on disk until the fold, and the next mirror
   * tick can be a long tool call away. The cache is fed by every channel's
   * mirror (this channel's own sinks, and the telegram/whatsapp/cli/
   * autonomous/in-app mirrors routed through pushMessageAppended), so it
   * answers for a run started anywhere.
   */
  turnMirrorFor(conversationId: string): ConversationMessage | null {
    return this.lastMirrors.get(conversationId)?.message ?? null
  }

  /** Park one serialized body for chunked pickup; returns its handle. */
  private spoolBody(buffer: Buffer): string {
    const now = Date.now()
    for (const [key, entry] of this.bodySpools) {
      if (entry.expiresAt <= now) this.bodySpools.delete(key)
    }
    // Insertion order is age order — evict the oldest past the cap.
    while (this.bodySpools.size >= BODY_SPOOL_MAX) {
      const oldest = this.bodySpools.keys().next().value
      if (oldest === undefined) break
      this.bodySpools.delete(oldest)
    }
    const bodyId = randomBytes(8).toString('hex')
    this.bodySpools.set(bodyId, { buffer, expiresAt: now + BODY_SPOOL_TTL_MS })
    return bodyId
  }

  /** A live spool by id, its TTL refreshed — or null when expired/unknown. */
  private bodySpool(bodyId: string): { buffer: Buffer } | null {
    const entry = this.bodySpools.get(bodyId)
    if (!entry) return null
    if (entry.expiresAt <= Date.now()) {
      this.bodySpools.delete(bodyId)
      return null
    }
    entry.expiresAt = Date.now() + BODY_SPOOL_TTL_MS
    return entry
  }
  /** Chunked uploads in flight, keyed by upload id. */
  private readonly uploads = new Map<string, PendingUpload>()
  /**
   * Serialized oversize conversation bodies awaiting chunked pickup
   * (Rpc.conversationBodyChunk), keyed by a per-serve id. TTL-reaped rather
   * than freed on the last read, so a phone that retries a pull mid-way
   * never finds the spool half-gone; the cap bounds memory to a handful of
   * bodies for the length of one TTL.
   */
  private readonly bodySpools = new Map<string, { buffer: Buffer; expiresAt: number }>()
  /**
   * When the last reindex tick went out, so the throttle has something to
   * measure against. Zero means "no rebuild is being reported" — which is both
   * the resting state and the flag that makes the next tick an unthrottled
   * start edge.
   */
  private lastReindexPush = 0
  /** notify frames awaiting the relay's notify_result, by notificationId. */
  private readonly pendingNotifies = new Map<
    string,
    { resolve: (result: NotifyResultFrame) => void; timer: ReturnType<typeof setTimeout> }
  >()
  /** Gate for the model's notify_phone tool. Restored from config at start. */
  private notificationsEnabled = true
  /** The built capability pair, made once and re-registered as needed. */
  private phoneCapability: ReturnType<typeof buildMobileCapability> | null = null
  /** Whether notify_phone is currently registered with the cerebellum. */
  private phoneCapabilityRegistered = false
  /** Set while the channel is stopped, so status churn can't re-register. */
  private channelStopped = false
  /** Unsubscribes for the mid-turn message lifecycle — see watchInterjections. */
  private offInterjection: (() => void) | null = null
  private offInterjectionDispatcher: (() => void) | null = null
  /** Message ids with a re-send in flight — see redispatchInterjection. */
  private readonly redispatching = new Set<string>()
  /**
   * The diagnostic-export runner, injected from main because it owns the
   * single-flight guard the desktop's own button runs behind. Absent until
   * main wires it, which is also what makes the RPC honest on an older build:
   * the phone is told this desktop cannot export rather than being left to
   * wait on a promise nobody will settle.
   */
  private diagnosticExporter:
    | ((
        conversationId: string,
        onProgress: (progress: DiagnosticProgress) => void
      ) => Promise<DiagnosticResult>)
    | null = null

  constructor(private readonly deps: MobileChannelDeps) {
    // Plan mode is the desktop's stance (runtime/plan-mode); every change,
    // from the composer chip or the phone's own switch, reaches the phone
    // here. Subscribed for the channel's lifetime (it is a singleton) — a link that is down
    // simply drops the push, and the phone re-reads on its next open.
    onPlanModeChange((change) => this.tunnel?.emit(Event.planMode, change))
    this.relayUrl = deps.relayUrl ?? DEFAULT_RELAY_URL
  }

  /** Wire the collector main owns — see `diagnosticExporter`. */
  setDiagnosticExporter(
    exporter: (
      conversationId: string,
      onProgress: (progress: DiagnosticProgress) => void
    ) => Promise<DiagnosticResult>
  ): void {
    this.diagnosticExporter = exporter
  }

  // -------------------------------------------------------------- lifecycle

  /** Restore a stored pairing and start listening. Safe to call on every boot. */
  async start(): Promise<void> {
    this.channelStopped = false
    this.watchInterjections()
    // The stored override must win before any tunnel dials out; deps.relayUrl
    // stays the programmatic default (tests), DEFAULT_RELAY_URL the shipped one.
    this.relayUrl = (await loadRelayUrl()) ?? this.deps.relayUrl ?? DEFAULT_RELAY_URL
    this.notificationsEnabled = (await this.deps.loadNotificationsEnabled?.()) ?? true
    this.verbose = (await this.deps.loadVerbose?.()) ?? false

    this.pairing = await loadPairing()
    // The notify_phone tool's presence IS the availability signal — see
    // syncPhoneCapability. A stored pairing that already carries a phoneId
    // registers it right here, before any tunnel forms: push works against
    // an away phone, so the tool must not wait for a live connection.
    this.syncPhoneCapability()
    if (!this.pairing) {
      this.log('no pairing stored — waiting for one to be offered')
      this.emitStatus()
      return
    }
    this.log(
      `restoring pairing from ${new Date(this.pairing.pairedAt).toISOString()} ` +
        `(${this.pairing.method}, device ${this.pairing.deviceName ?? 'unknown'})`
    )
    await this.openTunnel('qr')
  }

  async stop(): Promise<void> {
    this.log('channel stopping')
    this.channelStopped = true
    this.unwatchInterjections()
    this.syncPhoneCapability()
    for (const [id, pending] of this.pendingNotifies) {
      clearTimeout(pending.timer)
      pending.resolve({
        v: 1,
        type: 'notify_result',
        notificationId: id,
        route: 'dropped',
        reason: 'channel stopped'
      })
    }
    this.pendingNotifies.clear()
    this.drainTurnRequests(null, 'channel stopped')
    this.clearOffer()
    this.clearMirrorPacing()
    await this.abortAllUploads()
    this.tunnel?.stop()
    this.tunnel = null
    this.tunnelState = null
    this.emitStatus()
  }

  // ---------------------------------------------------------- notifications

  /**
   * Keep the notify_phone tool's EXISTENCE in step with deliverability: the
   * capability is registered exactly while a phone is paired, has identified
   * itself (phoneId), and the user allows notifications. Presence in the
   * model's capability index is therefore the cheap availability check — the
   * model never has to probe, and a send can never be attempted into a void.
   * A parked (backgrounded) phone stays deliverable on purpose: reaching an
   * away phone via push is the feature. Runs off every emitStatus, so any
   * state change — pairing formed or dropped, phoneId learned at hello, the
   * settings toggle — converges the registration without dedicated wiring.
   */
  private syncPhoneCapability(): void {
    const deliverable =
      !this.channelStopped &&
      Boolean(this.pairing?.peerPublicKey && this.pairing.phoneId && this.notificationsEnabled)
    if (deliverable === this.phoneCapabilityRegistered) return
    if (deliverable) {
      this.phoneCapability ??= buildMobileCapability({
        notify: (request) => this.notifyPhone(request)
      })
      this.deps.agent.cerebellum.registerInProcessCapability(
        this.phoneCapability.capability,
        this.phoneCapability.plugin
      )
      this.log('notify_phone exposed — phone identified and notifications allowed')
    } else {
      this.deps.agent.cerebellum.unregisterInProcessCapability(MOBILE_CAPABILITY_NAME)
      this.log('notify_phone withdrawn — unpaired, unidentified phone, or notifications off')
    }
    this.phoneCapabilityRegistered = deliverable
  }

  /**
   * The whole notify path, model side down: the tool handler (tools.ts) has
   * already validated the model's words — validated, not rationed; nothing
   * caps how many a run may send. This stamps the routing identity the model
   * must never control — the phoneId from the
   * pairing record and a freshly minted ULID — derives the ttl from the
   * phase, emits the frame over the EXISTING relay connection, and resolves
   * with the relay's routing decision. Every refusal is a thrown Error with
   * a message the model can read and act on.
   */
  async notifyPhone(request: NotifyPhoneRequest): Promise<NotifyResultFrame> {
    if (!this.notificationsEnabled) {
      throw new Error(
        "phone notifications are disabled in this desktop's Settings → Mobile — do not retry"
      )
    }
    const pairing = this.pairing
    if (!pairing?.peerPublicKey) throw new Error('no phone paired')
    if (!pairing.phoneId) {
      throw new Error(
        'the paired phone has not identified itself for notifications yet — it must connect ' +
          'once on a build with notification support (update the mobile app), do not retry'
      )
    }
    const tunnel = this.tunnel
    if (!tunnel) throw new Error('the relay connection is not running')

    const frame: NotifyFrame = {
      v: PUSH_WIRE_VERSION,
      type: 'notify',
      notificationId: mintNotificationId(),
      phoneId: pairing.phoneId,
      runId: request.runId,
      phase: request.phase,
      title: request.title,
      body: request.body,
      urgency: request.urgency,
      deeplink: request.deeplink,
      conversationId: request.conversationId,
      ttl: TTL_BY_PHASE[request.phase],
      ts: Date.now()
    }

    const result = new Promise<NotifyResultFrame>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingNotifies.delete(frame.notificationId)
        resolve({
          v: 1,
          type: 'notify_result',
          notificationId: frame.notificationId,
          route: 'dropped',
          // Deliberately worded as ignorance, not failure. The relay forwards
          // to the phone BEFORE it answers, so a missing answer says nothing
          // about whether the notification arrived — and it usually did. Read
          // as "not delivered" this was retried, and the user got the same
          // notification three times.
          reason:
            'the relay did not answer within ' +
            `${NOTIFY_RESULT_TIMEOUT_MS / 1000}s, so delivery is unknown — the notification may ` +
            'have reached the phone anyway. The relay may also be unreachable or predate ' +
            'notification support'
        })
      }, NOTIFY_RESULT_TIMEOUT_MS)
      this.pendingNotifies.set(frame.notificationId, { resolve, timer })
    })

    try {
      tunnel.sendControl(frame)
    } catch {
      const pending = this.pendingNotifies.get(frame.notificationId)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingNotifies.delete(frame.notificationId)
      }
      throw new Error('the relay link is down right now — the notification was not sent')
    }
    this.debug(`notify ${frame.notificationId} sent (${frame.phase}, run ${frame.runId})`)

    const answer = await result
    this.log(
      `notification ${frame.notificationId} → ${answer.route}` +
        (answer.reason ? ` (${answer.reason})` : '')
    )
    return answer
  }

  /** The relay's answer to a notify — resolves the matching waiter. */
  private onNotifyResult(raw: Record<string, unknown>): void {
    const id = typeof raw.notificationId === 'string' ? raw.notificationId : null
    if (!id) return
    const pending = this.pendingNotifies.get(id)
    if (!pending) return
    this.pendingNotifies.delete(id)
    clearTimeout(pending.timer)
    const route = raw.route === 'inband' || raw.route === 'push' ? raw.route : 'dropped'
    pending.resolve({
      v: 1,
      type: 'notify_result',
      notificationId: id,
      route,
      ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {})
    })
  }

  /** Flip the persisted notifications gate; answers the updated status. */
  async setNotificationsEnabled(enabled: boolean): Promise<MobileStatus> {
    this.notificationsEnabled = enabled
    await this.deps.saveNotificationsEnabled?.(enabled)
    this.log(`model-initiated phone notifications ${enabled ? 'enabled' : 'disabled'}`)
    this.emitStatus()
    return this.getStatus()
  }

  /**
   * Whether the phone's feed shows tool calls and task results, mirroring the
   * same switch on Telegram, WhatsApp and the in-app feed. Off (default) sends
   * a clean feed: assistant messages, file-bearing results and errors only.
   * Display-only — it never affects what is stored, and never affects logging.
   *
   * Persisted, like the notifications gate beside it: this switch is edited
   * from two devices, and one that forgot itself on restart would have the
   * phone and the panel disagreeing about a setting neither of them changed.
   */
  async setVerbose(verbose: boolean): Promise<MobileStatus> {
    this.verbose = verbose
    await this.deps.saveVerbose?.(verbose)
    this.log(`phone feed ${verbose ? 'relays every tool call' : 'kept clean'}`)
    this.emitStatus()
    return this.getStatus()
  }

  /**
   * Point the tunnel at a different relay — any deployment of the open-source
   * wolffish-relay, or a service speaking the same forwarding contract. Null
   * clears the override and returns to the default.
   *
   * The relay is part of the pairing contract: the QR/code payload names it,
   * and the phone keeps dialing whatever it learned at pairing time. So a
   * change drops any open offer and any paired phone rather than leave a link
   * that can never form again — the panel warns before calling this.
   */
  async setRelayUrl(url: string | null): Promise<MobileStatus> {
    const override = normalizeRelayUrl(url) // throws on a malformed URL
    await saveRelayUrl(override)
    const next = override ?? this.deps.relayUrl ?? DEFAULT_RELAY_URL
    if (next !== this.relayUrl) {
      if (this.pairing) await this.unpair()
      this.relayUrl = next
      this.log(`relay set to ${next}`)
    }
    this.emitStatus()
    return this.getStatus()
  }

  /**
   * Connection logging is unconditional. A tunnel that will not connect is
   * exactly when the record matters, and nobody can be asked to reproduce a
   * failure with logging switched on afterwards. `verbose` is a *feed*
   * preference and has nothing to do with this.
   */
  private log(line: string): void {
    this.deps.log?.(line)
  }

  /** Detail: served RPCs, pushes, per-frame activity. */
  private debug(line: string): void {
    this.deps.debug?.(line)
  }

  // ---------------------------------------------------------------- pairing

  /**
   * Begin a QR pairing. The payload carries the relay, this desktop's public
   * key and a fresh secret, so the phone can run IKpsk2 in one round trip.
   */
  async offerQr(): Promise<MobileStatus> {
    const identity = await loadIdentity()
    const secret = new Uint8Array(randomBytes(32))
    const payload = encodePairingPayload({
      v: 1,
      relay: this.relayUrl,
      pk: toHex(identity.publicKey),
      ps: toBase64Url(secret)
    })
    await this.beginPairing(secret, 'qr', { payload, code: null })
    return this.getStatus()
  }

  /**
   * Begin a typed-code pairing, for a desktop with no screen the phone can see
   * — a headless box, or a session over SSH. The code carries only the secret,
   * so the handshake is XXpsk3 and both keys are exchanged inside it.
   */
  async offerCode(): Promise<MobileStatus> {
    const code = generateCode((length) => new Uint8Array(randomBytes(length)))
    const secret = secretFromCode(code)
    await this.beginPairing(secret, 'code', { payload: null, code })
    return this.getStatus()
  }

  private async beginPairing(
    secret: Uint8Array,
    mode: 'qr' | 'code',
    display: { payload: string | null; code: string | null }
  ): Promise<void> {
    this.clearOffer()
    this.clearMirrorPacing()
    this.tunnel?.stop()
    this.tunnel = null

    // The offer *is* the pairing until a phone completes a handshake: the
    // rendezvous is derived from this secret, so the desktop must already be
    // waiting there when the phone arrives.
    this.pairing = {
      secret: toBase64Url(secret),
      peerPublicKey: null,
      method: mode,
      pairedAt: Date.now(),
      lastSeenAt: null,
      deviceName: null
    }
    await savePairing(this.pairing)

    const expiresAt = Date.now() + CODE_TTL_MS
    this.offer = { mode, payload: display.payload, code: display.code, expiresAt }
    this.offerTimer = setTimeout(() => {
      // An unclaimed offer must not linger: a code read aloud or a QR left on
      // screen should stop working on its own.
      if (this.pairing && !this.pairing.peerPublicKey) void this.unpair()
      else this.clearOffer()
    }, CODE_TTL_MS)

    this.log(`pairing offer opened (${mode}), rendezvous ${rendezvousId(secret).slice(0, 16)}…`)
    await this.openTunnel(mode)
  }

  private clearOffer(): void {
    if (this.offerTimer) clearTimeout(this.offerTimer)
    this.offerTimer = null
    this.offer = null
  }

  /**
   * Drop the live link but keep the pairing. The phone reconnects on its own
   * the next time it is opened — this is for cutting a session loose, not for
   * ending the relationship, which is what unpair() is for.
   */
  async disconnect(): Promise<MobileStatus> {
    this.clearOffer()
    this.clearMirrorPacing()
    this.tunnel?.stop()
    this.tunnel = null
    this.tunnelState = null
    this.log('disconnected by request — pairing kept')
    this.emitStatus()
    return this.getStatus()
  }

  /** Forget the phone entirely. */
  async unpair(): Promise<MobileStatus> {
    this.drainTurnRequests(null, 'phone unpaired')
    this.clearOffer()
    this.clearMirrorPacing()
    this.lastMirrors.clear()
    this.mirrorDeltaSeq.clear()
    this.tunnel?.stop()
    this.tunnel = null
    this.tunnelState = null
    this.pairing = null
    await clearPairing()
    this.log('unpaired — keys removed, tunnel closed')
    this.emitStatus()
    return this.getStatus()
  }

  // ----------------------------------------------------------------- tunnel

  private async openTunnel(mode: 'qr' | 'code'): Promise<void> {
    if (!this.pairing) return
    const identity = await loadIdentity()
    const pairing = this.pairing

    const tunnel = new Tunnel({
      role: 'host',
      relayUrl: this.relayUrl,
      rid: ridForPairing(pairing),
      staticKeypair: identity,
      pairingSecret: secretBytes(pairing),
      peerStaticPublicKey: peerKeyBytes(pairing),
      identity: { device: 'wolffish-app', platform: process.platform },
      autoReconnect: true,
      // The desktop parks. It is the host: it must be sitting at the
      // rendezvous whenever the phone decides to open, which is most often
      // when nothing here is watching.
      peerWaitMs: null,
      // Always on: see log() above.
      verbose: true,
      log: (line) => this.deps.log?.(line)
    })
    this.tunnel = tunnel

    tunnel.onState((state) => {
      const previous = this.tunnelState
      this.tunnelState = state
      const transition =
        state.status !== previous?.status || state.peerPresent !== previous?.peerPresent
      // Every transition is recorded: this sequence is the whole story when a
      // link will not form. Transitions ONLY — this listener also fires on
      // counter movement, and logging per frame is a disk write per frame.
      if (transition) {
        this.log(
          state.lastError
            ? `${state.status} — ${state.lastError}`
            : `${state.status}${state.peerPresent ? ' (phone present)' : ''}`
        )
        this.debug(
          `state: ${state.status} peer=${state.peerPresent} frames=${state.framesSent}/${state.framesReceived} ` +
            `bytes=${state.bytesSent}/${state.bytesReceived} reconnects=${state.reconnects}`
        )
      }
      // A completed handshake is the moment a pairing offer becomes a pairing
      // — the moment, not the duration. Running this on every event while
      // connected rewrote the sealed pairing file (a safeStorage encrypt plus
      // a whole-file write) once per tick, and that grind is what froze the
      // desktop mid-sync.
      if (state.status === 'connected' && previous?.status !== 'connected') {
        void this.onConnected()
      }
      // The phone is where every parked card lives. Lose the link and nobody
      // can answer one — so anything still waiting fails closed here rather
      // than holding its turn open until the app is opened again, which on a
      // phone can be hours.
      if (state.status !== 'connected' && previous?.status === 'connected') {
        this.drainTurnRequests(null, 'phone disconnected')
      }
      this.emitStatus()
    })

    this.registerHandlers(tunnel)
    // The relay's answers to notify frames arrive as control records on the
    // same socket the notify left on.
    tunnel.onControl('notify_result', (frame) => this.onNotifyResult(frame))
    // Failures are already folded into tunnel state and retried with backoff;
    // surfacing them again here would double-report the same condition.
    void tunnel.start(mode).catch(() => undefined)
  }

  private async onConnected(): Promise<void> {
    const key = this.tunnel?.peerStaticPublicKey
    if (!key || !this.pairing) return
    const hex = toHex(key)
    if (this.pairing.peerPublicKey !== hex) {
      // First completed handshake — pin the phone and close the offer, so the
      // QR on screen and the code stop being usable by anyone else.
      this.pairing = (await updatePairing({ peerPublicKey: hex, lastSeenAt: Date.now() })) ?? null
      this.clearOffer()
      this.log(`paired — phone key pinned ${hex.slice(0, 8)}…, offer closed`)
    } else {
      this.pairing = (await updatePairing({ lastSeenAt: Date.now() })) ?? null
      this.debug('reconnected to the pinned phone')
    }
    this.emitStatus()
  }

  // --------------------------------------------------------------- handlers

  private registerHandlers(tunnel: Tunnel): void {
    tunnel.onRpc(Rpc.hello, async (params) => {
      // The phone describes itself here. Everything is optional and only
      // written when it changes, so an older phone that sends a name alone
      // still works and a reconnect does not rewrite the file for nothing.
      const text = (value: unknown): string | null =>
        typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : null
      const platform =
        params.platform === 'ios' || params.platform === 'android' ? params.platform : null
      // The phone's stable device id — the ONLY identity notify frames are
      // ever stamped with. Shape-validated (the wire is data, not policy)
      // and stored in the pairing record; absent on older phone builds,
      // which leaves notifications refused rather than misaddressed.
      const phoneId =
        typeof params.deviceId === 'string' && /^[A-Za-z0-9_.-]{8,128}$/.test(params.deviceId)
          ? params.deviceId
          : null
      const described = {
        deviceName: text(params.deviceName),
        platform,
        model: text(params.model),
        osVersion: text(params.osVersion),
        appVersion: text(params.appVersion),
        phoneId
      }
      const patch = Object.fromEntries(
        Object.entries(described).filter(
          ([key, value]) =>
            value !== null && value !== this.pairing?.[key as keyof typeof described]
        )
      )
      if (Object.keys(patch).length > 0) {
        this.pairing = (await updatePairing(patch)) ?? null
        this.emitStatus()
      }
      return { ok: true, app: 'wolffish-app', platform: process.platform }
    })

    /**
     * Which conversations have a turn in flight RIGHT NOW — the phone's
     * chat:activeRuns, and it exists for the reason that one does: 'started'
     * is a broadcast, so a surface that connects mid-run has already missed
     * the only announcement that turn was ever going to send. Both halves,
     * exactly as index.ts concatenates them for this app's own windows —
     * channel turns and autonomous runs.
     *
     * Without it a phone opening a conversation this desktop is still writing
     * renders it idle: live composer and no stop, over a turn that has not
     * finished.
     */
    tunnel.onRpc(Rpc.activeRuns, async () => {
      const ids = [...this.deps.runner.activeRuns(), ...this.deps.agent.activeAutonomousRuns()].map(
        (run) => run.conversationId
      )
      return { conversationIds: [...new Set(ids)] }
    })

    /**
     * The turn-so-far for one conversation — the newest mirror snapshot (with
     * the prompt it answers) plus every card the turn is still parked on.
     *
     * This is the recovery path for a phone that joins or REJOINS a turn in
     * flight: pushes only describe what happens next, the assistant message
     * is not on disk until the fold, and across a long tool call the next
     * mirror tick is minutes away — so without this, a phone relaunched
     * mid-turn (iOS reclaiming a backgrounded app is the ordinary case)
     * renders a running conversation as blank thinking words, and a question
     * the turn is parked on is lost until the tunnel drops. Served from the
     * same cache every mirror tick maintains, so it costs a map read.
     */
    tunnel.onRpc(Rpc.turnMirror, async (params) => {
      const conversationId = String(params.conversationId ?? '')
      const cached = this.lastMirrors.get(conversationId)
      const asks = [...this.pendingAsks.entries()]
        .filter(([, entry]) => entry.conversationId === conversationId)
        .map(([id, entry]) => ({
          id,
          toolCallId: entry.card.toolCallId,
          questions: entry.card.questions
        }))
      const approvals = [...this.pendingApprovals.entries()]
        .filter(([, entry]) => entry.conversationId === conversationId)
        .flatMap(([id, entry]) => {
          const stored = entry.approvals.get(id)
          if (!stored || stored.decision) return []
          return [
            {
              id,
              toolCallId: stored.toolCallId,
              tool: stored.tool,
              args: stored.args,
              level: stored.level,
              reason: stored.reason,
              description: stored.description
            }
          ]
        })
      this.debug(
        `served turn mirror for ${conversationId} — ` +
          `${cached ? 'snapshot' : 'no snapshot'}, ${asks.length} ask(s), ` +
          `${approvals.length} approval(s)`
      )
      return {
        message: cached?.message ?? null,
        ...(cached?.userMessage !== undefined ? { userMessage: cached.userMessage } : {}),
        asks,
        approvals
      }
    })

    tunnel.onRpc(Rpc.configSnapshot, async () => {
      const snapshot = await buildConfigSnapshot(this.deps)
      this.debug(`served config snapshot (${Object.keys(snapshot).length} sections)`)
      return snapshot
    })

    /**
     * The phone edits a setting; this desktop persists it through the same
     * setters its own panels call, so the change is live everywhere at once.
     * The applier validates against a whitelist and throws on anything else —
     * an error here makes the phone refetch the snapshot and revert.
     */
    tunnel.onRpc(Rpc.configSet, async (params) => {
      const settings = (params as { settings?: unknown })?.settings
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        throw new Error('configSet needs a settings object')
      }
      if (!this.deps.applySettings) throw new Error('this desktop does not accept phone edits')
      await this.deps.applySettings(settings as Record<string, unknown>)
      this.debug(`applied phone settings: ${Object.keys(settings).join(', ')}`)
      return { ok: true }
    })

    /**
     * Whole-array variables replace — same contract as the desktop's own
     * variables:save. Each row is coerced field by field so a malformed
     * entry costs itself, never the write.
     */
    tunnel.onRpc(Rpc.variablesSet, async (params) => {
      const raw = (params as { variables?: unknown })?.variables
      if (!Array.isArray(raw)) throw new Error('variablesSet needs a variables array')
      if (!this.deps.applyVariables) throw new Error('this desktop does not accept phone edits')
      const variables = raw
        .map((entry) => {
          const row = (entry ?? {}) as Record<string, unknown>
          return {
            name: typeof row.name === 'string' ? row.name.trim() : '',
            value: typeof row.value === 'string' ? row.value : '',
            sensitive: row.sensitive === true
          }
        })
        .filter((row) => row.name.length > 0)
      await this.deps.applyVariables(variables)
      this.debug(`applied ${variables.length} variable(s) from phone`)
      return { ok: true }
    })

    /**
     * One capability toggle, applied through the same implementation the
     * desktop's own switch runs (validation, locked-core guard, broadcast).
     * The answer carries the state that actually holds, which is how a
     * refused write tells the phone to snap its switch back without a full
     * snapshot round trip.
     */
    tunnel.onRpc(Rpc.capabilitySet, async (params) => {
      const { name, enabled } = (params ?? {}) as { name?: unknown; enabled?: unknown }
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error('capabilitySet needs a capability name')
      }
      if (!this.deps.applyCapability) throw new Error('this desktop does not accept phone edits')
      const actual = await this.deps.applyCapability(name, enabled === true)
      this.log(`capability ${name} switched ${actual ? 'on' : 'off'} by the phone`)
      return { ok: true, enabled: actual }
    })

    /**
     * Metadata only — titles, icons, counts, timestamps. Never message bodies:
     * a real workspace is ~900 MB of conversation JSON, and the phone opens
     * one conversation at a time.
     */
    tunnel.onRpc(Rpc.conversationIndex, async (params) => {
      const since = typeof params.since === 'number' ? params.since : 0
      const all = await listConversations()
      const rows = all
        .filter((meta) => (meta.updatedAt ?? 0) > since)
        .map(
          (meta): ConversationMeta => ({
            id: meta.id,
            title: meta.title,
            model: null,
            channel: meta.channel ?? null,
            icon: meta.icon ?? null,
            projectId: meta.projectId ?? null,
            sealed: false,
            createdAt: meta.updatedAt,
            updatedAt: meta.updatedAt,
            messageCount: meta.messageCount,
            stats: null,
            summary: null
          })
        )
      // The full id list, on request. `since` can only ever report what still
      // exists, so a conversation deleted while the phone was away is
      // invisible to an incremental pull — it would sit on the phone forever.
      // Ids are small (a reconcile of 1000 conversations is tens of KB) and
      // this runs on reconnect, not on a timer.
      const ids = params.withIds === true ? all.map((meta) => meta.id) : undefined
      this.debug(`served conversation index — ${rows.length} of ${all.length} rows since ${since}`)
      return { rows, total: all.length, at: Date.now(), ...(ids ? { ids } : {}) }
    })

    /**
     * File a conversation under a project. The phone cannot do this locally:
     * every turn's project overlay is built from the `projectId` on THIS side's
     * conversation file, so a binding written only to the phone's database
     * would show project chrome over turns that never received the project's
     * instructions.
     */
    // Plan mode: the phone's chat-controls switch reads and writes the SAME
    // stance the desktop composer's chip does (runtime/plan-mode); a set from
    // either side reaches the other through Event.planMode.
    tunnel.onRpc(Rpc.planModeGet, (params) => ({
      planMode: getPlanMode(String(params.conversationId ?? ''))
    }))
    tunnel.onRpc(Rpc.planModeSet, (params) => ({
      planMode: setPlanMode(String(params.conversationId ?? ''), params.planMode === true)
    }))

    tunnel.onRpc(Rpc.conversationProject, async (params) => {
      const conversationId = String(params.conversationId ?? '')
      if (!conversationId) throw new Error('conversationProject needs a conversationId')
      const requested = wireText(params.projectId, ID_MAX) || null
      // An unknown project unfiles rather than dangles. buildProjectOverlay
      // returns an empty overlay for a missing id, so a dangling binding is
      // precisely the silent case above — a stale phone screen must not create
      // one, and answering with what actually holds lets it correct itself.
      const projectId = requested && (await getProject(requested)) ? requested : null
      let found = false
      await updateConversation(conversationId, (current) => {
        if (!current) return null
        found = true
        current.projectId = projectId ?? undefined
        return current
      })
      if (!found) throw new Error(`unknown conversation ${conversationId}`)
      this.log(`conversation ${conversationId} filed under project ${projectId ?? 'none'}`)
      // The desktop's own list re-reads on this, so an open Projects page and
      // the conversations rail both follow a re-file made on the phone.
      this.deps.onConversationChanged?.(conversationId)
      return { ok: true, projectId }
    })

    /**
     * One conversation, fetched when the phone opens it.
     *
     * The answer is normally one frame, and a frame past the relay's record
     * cap closes the tunnel — after which every open of this conversation
     * kills the link again. A body over the ceiling is therefore never sent
     * whole: a phone that asked with `chunked: true` gets a spool handle and
     * pulls the COMPLETE body through conversationBodyChunk (the same
     * base64url windows fileRead serves); an older phone gets it trimmed to
     * one frame (fitWireMessages) — shorter old tool dumps, never a dead
     * tunnel.
     */
    tunnel.onRpc(Rpc.conversationBody, async (params) => {
      const id = String(params.id ?? '')
      const file = await loadConversation(id)
      if (!file) {
        this.log(`conversation body requested for unknown id ${id}`)
        throw new Error(`unknown conversation ${id}`)
      }
      const wire = toWireConversation(file)
      let json: Buffer | null = null
      try {
        json = Buffer.from(JSON.stringify(wire))
      } catch {
        json = null
      }
      if (json && json.byteLength <= WIRE_BODY_MAX_BYTES) {
        this.debug(`served conversation ${id} (${file.messages?.length ?? 0} messages)`)
        return wire
      }
      if (json && params.chunked === true) {
        const bodyId = this.spoolBody(json)
        this.debug(
          `serving conversation ${id} chunked — ${json.byteLength} bytes as body ${bodyId}`
        )
        return { chunked: true, bodyId, sizeBytes: json.byteLength, updatedAt: file.updatedAt }
      }
      const fitted = fitWireMessages(file.messages ?? [], WIRE_BODY_MAX_BYTES)
      this.log(`conversation ${id} served trimmed — body over the wire ceiling`)
      this.debug(`served conversation ${id} (${file.messages?.length ?? 0} messages)`)
      return toWireConversation({ ...file, messages: fitted })
    })

    /**
     * One window of a spooled oversize body. Same contract as fileRead —
     * base64url data, CHUNK_SIZE-capped windows, `sizeBytes` on every answer
     * — so the phone reads both with one loop shape. The spool outlives the
     * last read until its TTL, so a retried pull never finds it half-gone.
     */
    tunnel.onRpc(Rpc.conversationBodyChunk, async (params) => {
      const bodyId = String(params.bodyId ?? '')
      const spool = this.bodySpool(bodyId)
      if (!spool) throw new Error(`unknown body ${bodyId} — request the conversation again`)
      const offset = clampCount(params.offset, 0)
      const length = Math.min(clampCount(params.length, CHUNK_SIZE), CHUNK_SIZE)
      const window = Math.max(0, Math.min(length, spool.buffer.byteLength - offset))
      return {
        data: spool.buffer.subarray(offset, offset + window).toString('base64url'),
        sizeBytes: spool.buffer.byteLength
      }
    })

    tunnel.onRpc(Rpc.usage, async () => {
      const days = (await this.deps.usageDays?.()) ?? []
      this.debug(`served usage ledger (${days.length} days)`)
      return { days }
    })

    /**
     * One month of this desktop's own release notes. The month is a path
     * segment on the serving side, so anything but a literal `YYYY-MM` is
     * refused here — wire values index into the filesystem and must never
     * carry a traversal. Locale likewise reduces to a plain language tag;
     * the reader falls back to English exactly as the desktop's own
     * Changelog screen does.
     */
    tunnel.onRpc(Rpc.changelogRead, async (params) => {
      const month = String(params.month ?? '')
      if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`not a changelog month: ${month}`)
      const locale = /^[a-z]{2}$/.test(String(params.locale ?? '')) ? String(params.locale) : 'en'
      const markdown = (await this.deps.readChangelog?.(month, locale)) ?? null
      this.debug(`served changelog ${month} (${locale}) — ${markdown ? markdown.length : 0} chars`)
      return { markdown }
    })

    /**
     * The self-updater, from the phone: seed, check, install. Thin passes
     * into the same registered handlers the desktop's own panel and the CLI
     * invoke (see MobileChannelDeps), so a tap over the tunnel is the
     * identical act. A host without the deps answers the honest no — the
     * phone hides its controls rather than offering a button that lies.
     */
    tunnel.onRpc(Rpc.updaterState, async () => {
      if (!this.deps.updaterState) return { state: null }
      return { state: await this.deps.updaterState() }
    })

    tunnel.onRpc(Rpc.updaterCheck, async () => {
      if (!this.deps.updaterCheck) return { ok: false, error: 'this desktop cannot self-update' }
      const result = await this.deps.updaterCheck()
      this.log(
        `update check from phone — ${result.ok ? (result.version ?? 'up to date') : `failed (${result.error ?? 'unknown'})`}`
      )
      return result
    })

    tunnel.onRpc(Rpc.updaterInstall, async () => {
      if (!this.deps.updaterInstall) return { ok: false }
      const result = await this.deps.updaterInstall()
      this.log(
        `update install from phone — ${result.ok ? 'armed, restarting' : 'refused (nothing ready)'}`
      )
      return result
    })

    /**
     * The phone hands over a prompt; this desktop runs the turn. Output goes
     * back as events rather than an RPC result — the phone renders a stream,
     * not a reply, so it looks the same as a turn started here.
     *
     * The answer carries only the conversation id, and the rest of the turn —
     * persisting the user message, transcribing a voice note, dispatching the
     * runner — continues after the reply is on the wire. It has to: a voice
     * note's transcription can outlive the phone's RPC timeout (the STT model
     * may still be downloading), and the phone needs the id immediately to
     * navigate. Failures in the continuation surface as a `turn.status` error
     * push against that id, which the phone already renders.
     */
    tunnel.onRpc(Rpc.sendMessage, async (params) => {
      const text = String(params.text ?? '').trim()
      const attachments = await this.sanitizeAttachments(params.attachments)
      // Only an audio file can be a voice prompt — a flag on anything else is
      // a malformed client and is ignored rather than honored.
      const voicePrompt = params.voicePrompt === true && attachments.some((a) => a.type === 'audio')
      const voiceLang =
        typeof params.voiceLang === 'string' && params.voiceLang.trim()
          ? params.voiceLang.trim()
          : undefined
      if (!text && attachments.length === 0) throw new Error('empty prompt')
      let conversationId = typeof params.conversationId === 'string' ? params.conversationId : null
      // The phone shows the prompt from the moment it is typed and needs the
      // stored copy to REPLACE that bubble rather than join it, which it can
      // only do if both carry one id. So the phone mints it and this desktop
      // saves under it. Validated to the shape mintMessageId produces — the
      // wire is data, not policy — and simply minted here when absent, which
      // is what a phone predating this field leaves.
      const messageId = /^m_\d{1,17}_[0-9a-f]{6}$/.test(String(params.messageId ?? ''))
        ? String(params.messageId)
        : undefined

      if (!conversationId) {
        const created = createConversation(null)
        // A voice note has no text yet — leave 'Untitled' so the titler names
        // it from the transcript once the turn runs.
        if (text) created.title = text.slice(0, 60)
        created.messages = []
        // Where this conversation began, the same way a Telegram one is
        // stamped. Both apps badge it from here, and it is the only record —
        // the desktop cannot tell later which surface asked.
        created.channel = 'mobile'
        // A first message sent from inside a project files the conversation
        // under it AT CREATION, not afterwards: the very turn this send starts
        // reads projectId off this file to build its overlay, so a re-file a
        // moment later would give the project's instructions to every turn
        // except the first. An unknown id is dropped rather than dangled — see
        // Rpc.conversationProject for why a dangling one is the silent case.
        const projectId = wireText(params.projectId, ID_MAX) || null
        if (projectId && (await getProject(projectId))) created.projectId = projectId
        await saveConversation(created)
        conversationId = created.id
      }

      const cid = conversationId
      // Plan mode: the phone's chat controls carry the same per-conversation
      // stance the desktop composer does — a read-only turn that only writes
      // its plan file (Agent.planMode). The wire is data: anything but a
      // literal true is off.
      const planMode = params.planMode === true
      // The send's stance is the conversation's stance from here on — the
      // desktop chip follows the phone's switch, not only the other way.
      setPlanMode(cid, planMode)
      void this.continueSend(
        cid,
        text,
        attachments,
        voicePrompt,
        voiceLang,
        messageId,
        planMode
      ).catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        this.log(`send from the phone failed in ${cid} — ${message}`)
        this.pushTurnStatus(cid, 'error', message)
      })
      return { conversationId: cid }
    })

    /**
     * The phone's mid-turn send. Validated exactly like Rpc.sendMessage —
     * the same attachment sanitizer (bytes must already be on disk from the
     * upload RPCs; the inbox rule is that media is real before it parks) and
     * the same voice-note gate — but nothing is persisted here: the message
     * goes to the turn runner's inbox and lands in the transcript as a
     * `user_message` segment when the agent reads it. The phone minted the
     * id; it is what lets the phone's pending bubble be replaced by the
     * segment rather than joined by it.
     *
     * A voice note is transcribed BEFORE it parks, because the transcript is
     * the message. The liveness check runs first so a note into an idle
     * conversation is refused instantly rather than after a transcription
     * the phone would then repeat on its normal send. The answer is awaited
     * (not fire-and-forget like sendMessage) because the phone needs the
     * verdict — pending, or start a normal turn — and the phone allows STT
     * its time on this call.
     */
    tunnel.onRpc(Rpc.interject, async (params) => {
      const conversationId = wireText(params.conversationId, ID_MAX)
      if (!conversationId) throw new Error('interject needs a conversation')
      const text = String(params.text ?? '').trim()
      const attachments = await this.sanitizeAttachments(params.attachments)
      const voicePrompt = params.voicePrompt === true && attachments.some((a) => a.type === 'audio')
      const voiceLangHint =
        typeof params.voiceLang === 'string' && params.voiceLang.trim()
          ? params.voiceLang.trim()
          : undefined
      if (!text && attachments.length === 0) throw new Error('empty prompt')
      const messageId = /^m_\d{1,17}_[0-9a-f]{6}$/.test(String(params.messageId ?? ''))
        ? String(params.messageId)
        : mintMessageId()
      // Asked ahead of the transcribe below, which is expensive and pointless
      // with nothing to hand the result to — and asked as `canInterject`, the
      // same question interject() answers, so an automation run (which owns no
      // lane) is not refused here after the inbox agreed to take it.
      if (!this.deps.runner.canInterject(conversationId)) {
        return { status: 'no_live_turn' } satisfies InterjectResult
      }
      let content = text
      let voiceLang = voiceLangHint
      if (voicePrompt && !content) {
        const transcribed = await this.transcribeVoiceNote(conversationId, attachments, voiceLang)
        content = transcribed.content
        voiceLang = transcribed.voiceLang
      }
      const result = this.deps.runner.interject(conversationId, {
        messageId,
        text: content,
        attachments,
        ...(voicePrompt ? { voicePrompt: true } : {}),
        ...(voiceLang ? { voiceLang } : {}),
        channel: 'mobile',
        sentAt: Date.now()
      })
      // The phone is told "got it" only once the park has ANSWERED. It has no
      // other copy — the pending bubble comes down the moment the agent reads
      // it — so an ack that outran durability would be a promise this process
      // could break by crashing.
      //
      // A park that FAILED is still acked: the message is in the live inbox
      // and the running turn will almost certainly read it, whereas refusing
      // here would make the phone re-send and land the same words twice. What
      // it does not do is pass silently — the one guarantee this await exists
      // for did not hold, and the log is where that has to show up.
      if (result.status === 'pending' && !(await result.durable)) {
        this.log(
          `interjection ${messageId} from the phone in ${conversationId} could NOT be parked — acked, but it survives only in memory`
        )
      }
      this.log(`interjection ${messageId} from the phone in ${conversationId} — ${result.status}`)
      // Only the verdict crosses the wire — `durable` is a local promise.
      return { status: result.status }
    })

    tunnel.onRpc(Rpc.withdrawInterjection, async (params) => {
      const conversationId = wireText(params.conversationId, ID_MAX)
      const messageId = wireText(params.messageId, ID_MAX)
      if (!conversationId || !messageId) return { ok: false }
      // Inbox first; then the durable park, where a message whose run was
      // STOPPED is being held. The phone restores those to its composer on
      // seed and withdraws them to say it has them — without this fallback the
      // park would hand the same words back on every reconnect forever.
      if (this.deps.runner.withdrawInterjection(conversationId, messageId, 'user')) {
        return { ok: true }
      }
      return { ok: await releaseHeldInterjection(conversationId, messageId) }
    })

    /**
     * What is parked on a conversation, for a phone attaching cold (paired
     * mid-run, relaunched, back from the background). The live inbox plus
     * anything the park is HOLDING: a message whose run was stopped before the
     * agent read it is never auto-resent, so without this it would be visible
     * only to a phone that happened to be connected at the moment of the Stop
     * — which is exactly the phone that did not need saving.
     */
    tunnel.onRpc(Rpc.pendingInterjections, async (params) => {
      const conversationId = wireText(params.conversationId, ID_MAX)
      if (!conversationId) return { pending: [] }
      return { pending: await this.deps.listPendingInterjections(conversationId) }
    })

    tunnel.onRpc(Rpc.countdownAbort, async (params) => {
      const countdownId = String(params.countdownId ?? '')
      if (!this.deps.countdownAbort || !countdownId) return { ok: false }
      const result = await this.deps.countdownAbort(countdownId)
      this.log(
        `countdown abort from phone — ${result.ok ? 'aborted' : (result.error ?? 'refused')}`
      )
      return result
    })

    // -------------------------------------------------------- processes
    // The desktop's process manager, driven from the phone through the same
    // functions its Library tab and the model's process_* tools call. Every
    // answer is the stored record; the registry's own push (processesChanged)
    // is what re-lists the phone, exactly as it does the desktop page.

    tunnel.onRpc(Rpc.processesList, async () => {
      const processes = processManager.list()
      this.debug(`served ${processes.length} process(es)`)
      return { processes }
    })

    tunnel.onRpc(Rpc.processStart, async (params) => {
      const name = String(params.name ?? '')
      const command = String(params.command ?? '')
      if (!name || !command) throw new Error('processStart needs a name and a command')
      const result = await processManager.start({
        name,
        command,
        cwd: typeof params.cwd === 'string' ? params.cwd : undefined,
        env:
          params.env && typeof params.env === 'object'
            ? (params.env as Record<string, string>)
            : undefined,
        port: params.port as Parameters<typeof processManager.start>[0]['port'],
        restart: params.restart as Parameters<typeof processManager.start>[0]['restart'],
        onQuit: params.onQuit as Parameters<typeof processManager.start>[0]['onQuit'],
        autostart: params.autostart as Parameters<typeof processManager.start>[0]['autostart'],
        origin: { conversationId: null, kind: 'started' },
        wait: true
      })
      this.log(`process ${name} started from the phone — ${result.ok ? 'ok' : result.error}`)
      return result.ok
        ? { ok: true, record: result.record }
        : { ok: false, error: result.error, record: result.record }
    })

    tunnel.onRpc(Rpc.processStop, async (params) => {
      const name = String(params.name ?? '')
      if (!name) throw new Error('processStop needs a name')
      const result = await processManager.stop(name)
      this.log(
        `process ${name} stop from the phone — ${result.ok ? (result.stopped ? 'stopped' : 'was not running') : result.error}`
      )
      return result
    })

    tunnel.onRpc(Rpc.processStopAll, async () => {
      const results = await processManager.stopAll()
      this.log(`stop all from the phone — ${results.filter((r) => r.stopped).length} stopped`)
      return { results }
    })

    tunnel.onRpc(Rpc.processRestart, async (params) => {
      const name = String(params.name ?? '')
      if (!name) throw new Error('processRestart needs a name')
      const result = await processManager.restart(name)
      this.log(`process ${name} restart from the phone — ${result.ok ? 'ok' : result.error}`)
      return result.ok
        ? { ok: true, record: result.record }
        : { ok: false, error: result.error, record: result.record }
    })

    tunnel.onRpc(Rpc.processUpdate, async (params) => {
      const name = String(params.name ?? '')
      if (!name) throw new Error('processUpdate needs a name')
      const patch: Parameters<typeof processManager.update>[1] = {}
      if (typeof params.command === 'string') patch.command = params.command
      if (typeof params.cwd === 'string') patch.cwd = params.cwd
      if (params.env && typeof params.env === 'object')
        patch.env = params.env as Record<string, string>
      if (params.port && typeof params.port === 'object')
        patch.port = params.port as NonNullable<typeof patch.port>
      if (
        params.restart === 'never' ||
        params.restart === 'on-failure' ||
        params.restart === 'always'
      )
        patch.restart = params.restart
      if (params.onQuit === 'keep' || params.onQuit === 'stop') patch.onQuit = params.onQuit
      if (
        params.autostart === 'off' ||
        params.autostart === 'wolffish' ||
        params.autostart === 'system'
      )
        patch.autostart = params.autostart
      if (typeof params.newName === 'string') patch.newName = params.newName
      const result = await processManager.update(name, patch)
      this.log(`process ${name} update from the phone — ${result.ok ? 'ok' : result.error}`)
      return result
    })

    tunnel.onRpc(Rpc.processRemove, async (params) => {
      const name = String(params.name ?? '')
      if (!name) throw new Error('processRemove needs a name')
      const result = await processManager.remove(name)
      this.log(`process ${name} removed from the phone — ${result.ok ? 'ok' : result.error}`)
      return result
    })

    tunnel.onRpc(Rpc.processLogs, async (params) => {
      const name = String(params.name ?? '')
      if (!name) throw new Error('processLogs needs a name')
      const lines = typeof params.lines === 'number' ? params.lines : 200
      return { text: await processManager.logs(name, { lines }) }
    })

    tunnel.onRpc(Rpc.abortTurn, async (params) => {
      const conversationId = String(params.conversationId ?? '')
      const live = this.turns.get(conversationId)
      live?.controller.abort()
      this.turns.delete(conversationId)
      // An aborted turn takes its parked cards with it: the abort unwinds the
      // pipeline, but the promise the pipeline is sitting on is held here.
      if (live) this.drainTurnRequests(live.turnId, 'turn aborted from the phone')
      this.log(`abort requested for ${conversationId} — ${live ? 'stopped' : 'nothing running'}`)
      return { aborted: Boolean(live) }
    })

    /**
     * The phone answered an ask-the-user card. `ok: false` means the id names
     * nothing pending — the turn ended, or the link dropped and the request
     * was already failed closed — which is how the phone learns to take a
     * card down instead of leaving it interactive forever.
     */
    tunnel.onRpc(Rpc.askRespond, async (params) => {
      const id = String(params.id ?? '')
      const entry = this.pendingAsks.get(id)
      if (!entry) {
        this.log(`ask answer for ${id} arrived too late — nothing pending`)
        return { ok: false }
      }
      const response = sanitizeAskResponse(params.response)
      this.pendingAsks.delete(id)
      this.log(`ask ${id} answered from the phone — ${response.kind}`)
      entry.resolve(response)
      return { ok: true }
    })

    /** The phone approved or denied a flagged tool call. */
    tunnel.onRpc(Rpc.approvalRespond, async (params) => {
      const id = String(params.id ?? '')
      const entry = this.pendingApprovals.get(id)
      if (!entry) {
        this.log(`approval decision for ${id} arrived too late — nothing pending`)
        return { ok: false }
      }
      // Anything that is not an explicit approval is a denial: the wire is
      // data, and this gate only ever opens on the exact word.
      const decision: ApprovalDecision = params.decision === 'approved' ? 'approved' : 'denied'
      this.pendingApprovals.delete(id)
      const stored = entry.approvals.get(id)
      if (stored) stored.decision = decision
      this.log(`approval ${id} ${decision} from the phone`)
      entry.resolve(decision)
      return { ok: true }
    })

    /**
     * The phone edits the reflection schedule. The wire shape is data, not
     * policy: every field is re-derived here and anything malformed costs
     * itself rather than the whole patch. The answer is the desktop's own
     * post-write config — the phone renders that, so the two screens can
     * never disagree about what was saved.
     */
    tunnel.onRpc(Rpc.setReflectionConfig, async (params) => {
      const apply = this.deps.applyReflectionConfig
      if (!apply) throw new Error('reflection config not served here')
      const patch = sanitizeReflectionPatch(params)
      const cfg = await apply(patch)
      this.log(
        `reflection config updated from the phone (${Object.keys(patch).join(', ') || 'no-op'})`
      )
      return cfg
    })

    tunnel.onRpc(Rpc.runReflection, async (params) => {
      const run = this.deps.runReflectionJob
      if (!run) throw new Error('reflection jobs not served here')
      const kind = params.kind === 'deepClean' ? 'deepClean' : 'reflection'
      const result = await run(kind)
      this.log(`${kind} run requested from the phone — ${result}`)
      return { result }
    })

    // ---------------------------------------------------------- projects
    //
    // Straight through to the store the desktop's own Projects page edits —
    // same functions, same mutation tail, same changed-listener. That is what
    // makes a phone edit land on an open desktop page (and vice versa) rather
    // than the two screens keeping separate copies of one JSON file.

    tunnel.onRpc(Rpc.projectsList, async () => {
      const projects = await listProjects()
      this.debug(`served ${projects.length} project(s)`)
      return { projects: projects.map(toWireProject) }
    })

    tunnel.onRpc(Rpc.projectCreate, async (params) => {
      const project = await createProject({
        title: wireText(params.title, TITLE_MAX) ?? '',
        icon: wireText(params.icon, ICON_MAX),
        instructions: wireText(params.instructions, INSTRUCTIONS_MAX),
        // Same contract as procedureCreate: absent ⇒ the store stamps chat's
        // current mode at creation.
        thinking: wireReasoning(params.thinking)
      })
      this.log(`project created from the phone — ${project.id}`)
      return { project: toWireProject(project) }
    })

    tunnel.onRpc(Rpc.projectUpdate, async (params) => {
      const id = String(params.id ?? '')
      if (!id) throw new Error('projectUpdate needs an id')
      // A `files` array is a whole-list replace and the desktop deletes the
      // copies it owns for everything dropped, so it is only ever honoured as
      // a real array — an absent field must leave the list alone, and reading
      // a malformed one as `[]` would delete every attached file.
      const files = Array.isArray(params.files)
        ? await this.resolveProjectFiles(id, params.files as unknown[])
        : undefined
      // Folders are references, so a dropped one costs nothing — but an ADDED
      // one is a path typed on a phone, and it names something on THIS machine
      // or nothing at all. Checked here, once, for both directions.
      const directories = Array.isArray(params.directories)
        ? await resolveWireDirectories(params.directories as unknown[])
        : undefined
      const project = await updateProject({
        id,
        title: wireText(params.title, TITLE_MAX),
        icon: wireText(params.icon, ICON_MAX),
        instructions: wireText(params.instructions, INSTRUCTIONS_MAX),
        // `undefined` leaves the stamp alone; a canonical token sets it. The
        // wire never carries null here — the phone sends a mode or nothing.
        ...(wireReasoning(params.thinking) ? { thinking: wireReasoning(params.thinking)! } : {}),
        ...(files ? { files } : {}),
        ...(directories ? { directories } : {})
      })
      this.debug(`project ${id} updated from the phone`)
      return { project: toWireProject(project) }
    })

    tunnel.onRpc(Rpc.projectDelete, async (params) => {
      const id = String(params.id ?? '')
      if (!id) throw new Error('projectDelete needs an id')
      await deleteProject(id)
      this.log(`project ${id} deleted from the phone`)
      return { ok: true }
    })

    // -------------------------------------------------------- procedures

    tunnel.onRpc(Rpc.proceduresList, async () => {
      const procedures = await listProcedures()
      this.debug(`served ${procedures.length} procedure(s)`)
      return { procedures: procedures.map(toWireProcedure) }
    })

    tunnel.onRpc(Rpc.procedureCreate, async (params) => {
      const procedure = await createProcedure({
        title: wireText(params.title, TITLE_MAX) ?? '',
        prompt: wireText(params.prompt, PROMPT_MAX) ?? '',
        mode: wireMode(params.mode),
        // Absent ⇒ the store stamps the chat's current mode, which is the
        // desktop's own create contract; the phone only sends one when the
        // user overrode it on the card.
        thinking: wireReasoning(params.thinking),
        icon: wireText(params.icon, ICON_MAX),
        projectId: wireText(params.projectId, ID_MAX)
      })
      this.log(`procedure created from the phone — ${procedure.id}`)
      return { procedure: toWireProcedure(procedure) }
    })

    tunnel.onRpc(Rpc.procedureUpdate, async (params) => {
      const id = String(params.id ?? '')
      if (!id) throw new Error('procedureUpdate needs an id')
      // A `files` array is a whole-list replace and the desktop deletes the
      // copies it owns for everything dropped, so it is only ever honoured as
      // a real array — an absent field must leave the list alone, and reading
      // a malformed one as `[]` would delete every attached file.
      const files = Array.isArray(params.files)
        ? await this.resolveProcedureFiles(id, params.files as unknown[])
        : undefined
      // Folders are references, so a dropped one costs nothing — but an ADDED
      // one is a path typed on a phone, and it names something on THIS machine
      // or nothing at all. Checked here, once, for both directions.
      const directories = Array.isArray(params.directories)
        ? await resolveWireDirectories(params.directories as unknown[])
        : undefined
      const procedure = await updateProcedure({
        id,
        title: wireText(params.title, TITLE_MAX),
        prompt: wireText(params.prompt, PROMPT_MAX),
        mode: wireMode(params.mode),
        icon: wireText(params.icon, ICON_MAX),
        // '' unbinds, exactly as the desktop's setter reads it — so this one
        // passes an empty string through rather than treating it as absent.
        projectId: wireText(params.projectId, ID_MAX),
        ...(wireReasoning(params.thinking) ? { thinking: wireReasoning(params.thinking)! } : {}),
        ...(files ? { files } : {}),
        ...(directories ? { directories } : {})
      })
      this.debug(`procedure ${id} updated from the phone`)
      return { procedure: toWireProcedure(procedure) }
    })

    tunnel.onRpc(Rpc.procedureDelete, async (params) => {
      const id = String(params.id ?? '')
      if (!id) throw new Error('procedureDelete needs an id')
      await deleteProcedure(id)
      this.log(`procedure ${id} deleted from the phone`)
      return { ok: true }
    })

    // ------------------------------------------------------- automations

    tunnel.onRpc(Rpc.automationsRead, async () => {
      const [markdown, stamps] = await Promise.all([
        readViewerFile(HEARTBEAT_PATH).catch(() => ''),
        this.deps.agent.brainstem.getHeartbeatEditStamps().catch(() => ({}))
      ])
      const jobs = this.activeAutomationJobs()
      this.debug(`served heartbeat.md (${markdown.length} chars, ${jobs.length} active job(s))`)
      return { markdown, jobs, stamps, runs: this.automationRuns() }
    })

    /**
     * Whole-file write — the same shape the desktop's markdown view and card
     * editor both use, because the scheduler's unit of truth is the file. The
     * atomic writer means a reader never sees a torn file, and the watcher
     * reloads the scheduler for both screens off the same change.
     */
    tunnel.onRpc(Rpc.automationsWrite, async (params) => {
      const markdown = wireText(params.markdown, HEARTBEAT_MAX)
      if (markdown === undefined) throw new Error('automationsWrite needs markdown')
      await writeViewerFile(HEARTBEAT_PATH, markdown)
      this.log(`heartbeat.md written from the phone (${markdown.length} chars)`)
      return { ok: true }
    })

    tunnel.onRpc(Rpc.resolveDirectory, async (params) => {
      const resolved = await resolveWorkingDirectory(String(params.path ?? ''))
      if (!resolved.ok) throw new Error(resolved.error)
      this.debug(`resolved working folder for the phone — ${resolved.path}`)
      return { path: resolved.path }
    })

    tunnel.onRpc(Rpc.automationRun, async (params) => {
      const label = String(params.label ?? '')
      if (!label) throw new Error('automationRun needs a label')
      const result = this.deps.agent.brainstem.runJobNow(label)
      this.log(
        `automation "${label}" run requested from the phone — ` +
          (result.started
            ? 'started'
            : result.ok
              ? `${result.state ?? 'queued'} (${result.running ?? 0} runs hold the pool)`
              : `refused: ${result.error}`)
      )
      return result
    })

    /**
     * The reindex overlay's seed, taken once per connection.
     *
     * The reindex is push-only — it announces itself when it starts and stops
     * — so a phone that connects mid-rebuild has already missed the
     * announcement and would show nothing until it ended. This is the one read
     * that closes that window.
     */
    tunnel.onRpc(Rpc.overlaysRead, async () => {
      const seed: OverlaySeed = { reindex: this.deps.agent.cortex.getReindexStatus() }
      this.debug(`served overlay seed (reindex ${seed.reindex ? 'active' : 'idle'})`)
      return seed
    })

    /**
     * Workspace file bytes for the phone's cache. Any path a synced
     * conversation references is servable — resolveUploadPath refuses
     * anything that escapes the workspace root, and that refusal is the
     * entire access story: the tunnel is end-to-end encrypted to one pinned
     * device, so whoever can ask is whoever paired.
     */
    tunnel.onRpc(Rpc.fileStat, async (params) => {
      const rel = String(params.path ?? '')
      if (!resolveUploadPath(rel)) throw new Error(`invalid path: ${rel}`)
      const stat = await statUpload(rel)
      return { exists: stat !== null, sizeBytes: stat?.sizeBytes ?? 0 }
    })

    tunnel.onRpc(Rpc.fileRead, async (params) => {
      const rel = String(params.path ?? '')
      const abs = resolveUploadPath(rel)
      if (!abs) throw new Error(`invalid path: ${rel}`)
      const offset = clampCount(params.offset, 0)
      // The cap is the contract: one answer must stay under the relay's
      // record limit whatever the phone asks for.
      const length = Math.min(clampCount(params.length, CHUNK_SIZE), CHUNK_SIZE)
      const handle = await fs.open(abs, 'r')
      try {
        const stat = await handle.stat()
        const window = Math.max(0, Math.min(length, stat.size - offset))
        const buffer = Buffer.alloc(window)
        if (window > 0) await handle.read(buffer, 0, window, offset)
        return { data: buffer.toString('base64url'), sizeBytes: stat.size }
      } finally {
        await handle.close()
      }
    })

    /**
     * The phone's Debug button — the same per-conversation bundle the desktop's
     * own History page collects, through the same runner and the same
     * single-flight guard (see setDiagnosticExporter).
     *
     * Only the RESULT crosses the tunnel. The archive itself stays where it was
     * written, under `diagnostics/` in the workspace, and the phone pulls it
     * down the ordinary fileStat/fileRead path — a zip is exactly the kind of
     * thing the chunked transfer exists for, and inlining megabytes into one
     * RPC answer would blow the relay's record cap.
     *
     * Progress is pushed as it happens and is advisory: it makes the bar move,
     * and a phone that misses every tick still gets a complete result here.
     */
    tunnel.onRpc(Rpc.diagnosticsExport, async (params) => {
      const conversationId = String(params.conversationId ?? '')
      if (!conversationId) throw new Error('diagnosticsExport needs a conversationId')
      if (!this.diagnosticExporter) throw new Error('this desktop cannot export diagnostics')
      this.debug(`diagnostic export requested for ${conversationId}`)
      const result = await this.diagnosticExporter(conversationId, (progress) => {
        this.tunnel?.emit(Event.diagnosticsProgress, progress)
      })
      this.debug(
        result.ok
          ? `diagnostic export ready: ${result.fileName} (${result.sizeBytes} bytes)`
          : `diagnostic export failed: ${result.error}`
      )
      return result as unknown as Record<string, unknown>
    })

    /**
     * Chunked upload from the phone: begin stakes out a staging file (and a
     * conversation, when the message that will carry the file is the first),
     * chunks append strictly in order, commit adopts the staged bytes as a
     * normal conversation upload and answers with the metadata the message
     * should carry — the desktop picks the final name, so a collision renames
     * here exactly as it would for a file dropped on the composer.
     *
     * A `projectId` instead points the commit at that project's file list, for
     * the phone's project Add-files. The transfer is byte-identical either way;
     * see the PendingUpload target.
     */
    tunnel.onRpc(Rpc.uploadBegin, async (params) => {
      const name = String(params.name ?? '').trim()
      if (!name) throw new Error('upload needs a file name')
      const expected = clampCount(params.sizeBytes, 0)
      if (expected <= 0 || expected > MAX_UPLOAD_BYTES) {
        throw new Error(`upload size out of range: ${expected}`)
      }
      const projectId =
        typeof params.projectId === 'string' && params.projectId ? params.projectId : null
      const procedureId =
        typeof params.procedureId === 'string' && params.procedureId ? params.procedureId : null
      const automationFiles = Array.isArray(params.automationFiles)
        ? (params.automationFiles as unknown[]).filter((v): v is string => typeof v === 'string')
        : null
      let target: PendingUpload['target']
      if (automationFiles) {
        target = { kind: 'automation', existing: automationFiles }
      } else if (procedureId) {
        // Same pre-flight as a project upload: verified before a byte moves,
        // so a long transfer can't end with nowhere to put the file.
        const procedure = (await listProcedures()).find((p) => p.id === procedureId)
        if (!procedure) throw new Error(`procedure not found: ${procedureId}`)
        target = { kind: 'procedure', procedureId }
      } else if (projectId) {
        // Verified BEFORE a byte moves: a whole video uploaded against a
        // project deleted on the desktop meanwhile would fail at commit, after
        // the minute of transfer, with nowhere for the bytes to go.
        const project = await getProject(projectId)
        if (!project) throw new Error(`project not found: ${projectId}`)
        target = { kind: 'project', projectId }
      } else {
        let conversationId =
          typeof params.conversationId === 'string' && params.conversationId
            ? params.conversationId
            : null
        if (!conversationId) {
          const created = createConversation(null)
          created.messages = []
          // Same stamp as the send path: a conversation a phone's first upload
          // brings into being started on the phone just as surely.
          created.channel = 'mobile'
          await saveConversation(created)
          conversationId = created.id
        }
        target = { kind: 'conversation', conversationId }
      }

      const uploadId = toHex(new Uint8Array(randomBytes(16)))
      const stagingDir = path.join(workspaceRoot(), 'uploads', UPLOAD_STAGING_DIR)
      await fs.mkdir(stagingDir, { recursive: true })
      const stagedPath = path.join(stagingDir, uploadId)
      const handle = await fs.open(stagedPath, 'w')
      const upload: PendingUpload = {
        target,
        name,
        mimeType: typeof params.mimeType === 'string' ? params.mimeType : null,
        expected,
        received: 0,
        stagedPath,
        handle,
        idleTimer: setTimeout(() => void this.abortUpload(uploadId, 'idle'), UPLOAD_IDLE_MS)
      }
      this.uploads.set(uploadId, upload)
      this.debug(
        `upload ${uploadId} begun — ${name}, ${expected} bytes, ` +
          (target.kind === 'project'
            ? `project ${target.projectId}`
            : target.kind === 'procedure'
              ? `procedure ${target.procedureId}`
              : target.kind === 'automation'
                ? 'an automation'
                : `conv ${target.conversationId}`)
      )
      return {
        uploadId,
        ...(target.kind === 'project'
          ? { projectId: target.projectId }
          : target.kind === 'procedure'
            ? { procedureId: target.procedureId }
            : target.kind === 'automation'
              ? {}
              : { conversationId: target.conversationId })
      }
    })

    tunnel.onRpc(Rpc.uploadChunk, async (params) => {
      const uploadId = String(params.uploadId ?? '')
      const upload = this.uploads.get(uploadId)
      if (!upload) throw new Error('unknown upload')
      const offset = clampCount(params.offset, -1)
      const bytes = Buffer.from(String(params.data ?? ''), 'base64url')
      // Strict sequencing: the phone sends one chunk at a time, so anything
      // out of order means a lost or replayed frame — refuse rather than
      // stitch a corrupt file.
      if (offset !== upload.received || bytes.length === 0) {
        await this.abortUpload(uploadId, 'out-of-order chunk')
        throw new Error('upload chunk out of order')
      }
      if (upload.received + bytes.length > upload.expected) {
        await this.abortUpload(uploadId, 'overran declared size')
        throw new Error('upload larger than declared')
      }
      await upload.handle.write(bytes, 0, bytes.length, offset)
      upload.received += bytes.length
      upload.idleTimer.refresh()
      return { received: upload.received }
    })

    tunnel.onRpc(Rpc.uploadCommit, async (params) => {
      const uploadId = String(params.uploadId ?? '')
      const upload = this.uploads.get(uploadId)
      if (!upload) throw new Error('unknown upload')
      this.uploads.delete(uploadId)
      clearTimeout(upload.idleTimer)
      await upload.handle.close()
      if (upload.received !== upload.expected) {
        await fs.rm(upload.stagedPath, { force: true }).catch(() => undefined)
        throw new Error(`upload incomplete: ${upload.received} of ${upload.expected} bytes`)
      }
      if (upload.target.kind === 'automation') {
        // Adopted into uploads/automation-<uuid>/; the ABSOLUTE path goes back
        // because that is what a `file:` marker holds and the engine reads.
        const file = await adoptUploadedAutomationFile(
          upload.target.existing,
          upload.stagedPath,
          upload.name
        )
        this.log(`automation file added from the phone — ${file.name}`)
        return { ...this.ownedFileMetadata(file, upload), path: file.path, name: file.name }
      }
      if (upload.target.kind === 'procedure') {
        // Adopted into uploads/procedure-<id>/ and attached in one serialized
        // write, so the answer already describes the stored procedure — the
        // phone renders that, never its own optimism.
        const { procedure, file } = await adoptUploadedProcedureFile(
          upload.target.procedureId,
          upload.stagedPath,
          upload.name
        )
        this.log(`procedure file added from the phone — ${file.name}`)
        return {
          ...this.ownedFileMetadata(file, upload),
          procedureId: upload.target.procedureId,
          procedure: toWireProcedure(procedure)
        }
      }
      if (upload.target.kind === 'project') {
        // Adopted into uploads/project-<id>/ and attached in one serialized
        // write, so the answer already describes the stored project — the
        // phone renders that, never its own optimism.
        const { project, file } = await adoptUploadedProjectFile(
          upload.target.projectId,
          upload.stagedPath,
          upload.name
        )
        this.log(`project file added from the phone — ${file.name}`)
        return {
          ...this.ownedFileMetadata(file, upload),
          projectId: upload.target.projectId,
          project: toWireProject(project)
        }
      }
      const metadata = await saveUploadFromFile(
        upload.target.conversationId,
        upload.stagedPath,
        upload.name,
        upload.mimeType ?? undefined
      )
      this.debug(`upload ${uploadId} committed — ${metadata.filePath}`)
      return { ...metadata, conversationId: upload.target.conversationId }
    })
  }

  /**
   * The phone's project file list, reduced to refs the project ACTUALLY holds.
   *
   * The phone only ever removes files here — adding goes through the upload
   * path — so this write is a subset filter, and stating it as one is what
   * makes it safe: a wire path is matched against the stored refs rather than
   * resolved into one. Nothing else can be attached (an absolute path the
   * agent would then be told to read), and nothing else can be deleted (a
   * mismatched path would drop a file the phone meant to keep, since
   * updateProject removes the copies it owns for everything not in the list).
   */
  private async resolveProjectFiles(id: string, wire: unknown[]): Promise<ProjectFileRef[]> {
    const project = await getProject(id)
    if (!project) throw new Error(`project not found: ${id}`)
    const root = workspaceRoot()
    const byWirePath = new Map(
      project.files.map((file) => [
        file.path.startsWith(root + path.sep) ? path.relative(root, file.path) : file.path,
        file
      ])
    )
    const kept: ProjectFileRef[] = []
    const seen = new Set<string>()
    for (const entry of wire) {
      const wirePath = (entry as { path?: unknown } | null)?.path
      if (typeof wirePath !== 'string') continue
      const file = byWirePath.get(wirePath)
      if (!file || seen.has(file.path)) continue
      seen.add(file.path)
      kept.push(file)
    }
    return kept
  }

  /**
   * The phone's procedure file list, reduced to refs the procedure ACTUALLY
   * holds — the same guard resolveProjectFiles applies, for the same reason:
   * the list is a whole-list replace that DELETES the copies it drops, so a
   * path the phone invented can never enter it.
   */
  private async resolveProcedureFiles(id: string, wire: unknown[]): Promise<ProcedureFileRef[]> {
    const procedure = (await listProcedures()).find((p) => p.id === id)
    if (!procedure) throw new Error(`procedure not found: ${id}`)
    const byWirePath = new Map((procedure.files ?? []).map((file) => [toWirePath(file.path), file]))
    const kept: ProcedureFileRef[] = []
    const seen = new Set<string>()
    for (const entry of wire) {
      const wirePath = (entry as { path?: unknown } | null)?.path
      if (typeof wirePath !== 'string') continue
      const file = byWirePath.get(wirePath)
      if (!file || seen.has(file.path)) continue
      seen.add(file.path)
      kept.push(file)
    }
    return kept
  }

  /** The scheduler's live view: the cron and the next fire, in THIS zone. */
  private activeAutomationJobs(): AutomationJob[] {
    const now = Date.now()
    return this.deps.agent.brainstem.getActiveJobs().map((job) => ({
      id: job.id,
      label: job.label,
      type: job.type,
      cron: job.cron,
      // A `once` job's moment is absolute and already registered; everything
      // else resolves from its cron. Served rather than computed on the phone:
      // these fire against this machine's clock and zone.
      nextRunMs: job.runAt ?? (job.cron ? nextCronMs(job.cron, now) : null),
      mode: job.mode,
      // Straight off the engine's parse — the same value the run uses, so the
      // phone's card switch can never show a mode the scheduler disagrees with.
      thinking: job.thinking ?? null
    }))
  }

  /**
   * The run pool as the phone reads it — every row, `kind` included, so the
   * phone's Automations screen can gate its play buttons and skip procedure
   * runs (which share the pool but are not headings in heartbeat.md).
   */
  private automationRuns(): AutomationRuns {
    const brainstem = this.deps.agent.brainstem
    return toWireRuns({ running: brainstem.getRunningJobs(), queued: brainstem.getQueuedJobs() })
  }

  /**
   * The attachment-shaped metadata a committed PROJECT upload answers with, so
   * the phone can file the bytes it just sent under the desktop's chosen path
   * (a cache hit instead of an immediate re-download) exactly as it does for a
   * conversation upload.
   */
  private ownedFileMetadata(
    file: { path: string; name: string },
    upload: PendingUpload
  ): { type: string; filePath: string; originalName: string; mimeType: string; sizeBytes: number } {
    const { type, mimeType } = classifyFile(file.name, upload.mimeType ?? undefined)
    return {
      type,
      filePath: path.relative(workspaceRoot(), file.path),
      originalName: file.name,
      mimeType,
      sizeBytes: upload.expected
    }
  }

  /**
   * A phone voice note's transcript — the prompt the model reads. Same
   * pipeline as a Telegram voice note: conversation-scoped so the transcript
   * files under speech/conv-…, ffmpeg ensured because a direct tool call
   * bypasses the agent loop's dependency resolution. Shared by the send path
   * and the mid-turn interject path, which must transcribe identically —
   * the only difference between them is where the text goes afterwards.
   */
  private async transcribeVoiceNote(
    conversationId: string,
    attachments: MessageAttachment[],
    voiceLangHint: string | undefined
  ): Promise<{ content: string; voiceLang: string | undefined }> {
    const audio = attachments.find((a) => a.type === 'audio')
    if (!audio) throw new Error('voice note without an audio attachment')
    await this.deps.agent.cerebellum.ensureSystemTool('ffmpeg')
    const result = await this.deps.agent.cerebellum.runWithConversation(conversationId, () =>
      this.deps.agent.cerebellum.executeTool('stt_transcribe', { filePath: audio.filePath })
    )
    if (!result.success) throw new Error(result.error ?? 'transcription failed')
    const content = extractTranscript(result.output ?? '')
    if (!content) throw new Error('voice message transcribed to nothing')
    const voiceLang = extractVoiceLanguage(result.output ?? '') || voiceLangHint
    return { content, voiceLang }
  }

  /**
   * The rest of a send after the RPC reply: transcribe a voice note, persist
   * the user message, build the LLM history, dispatch the runner. Failures
   * here reach the phone as a turn.status error push — the caller wired that.
   */
  private async continueSend(
    conversationId: string,
    text: string,
    attachments: MessageAttachment[],
    voicePrompt: boolean,
    voiceLangHint: string | undefined,
    messageId?: string,
    planMode = false
  ): Promise<void> {
    let content = text
    let voiceLang = voiceLangHint

    if (voicePrompt && !content) {
      try {
        const transcribed = await this.transcribeVoiceNote(conversationId, attachments, voiceLang)
        content = transcribed.content
        voiceLang = transcribed.voiceLang
      } catch (error) {
        // The recording must survive its failed transcription: persist the
        // message (empty content, audio attached) so both transcripts keep
        // the voice note, then let the error reach the phone.
        await this.persistUserMessage(
          conversationId,
          '',
          attachments,
          voicePrompt,
          voiceLang,
          messageId
        )
        throw error
      }
    }

    const conversation = await loadConversation(conversationId)
    if (!conversation) throw new Error(`unknown conversation ${conversationId}`)

    // Idempotence on the message id. A mid-turn message that was never read
    // can be re-sent from two places — the sweep the moment the lane closes,
    // and the reconciler if that sweep could not finish — and the phone's own
    // older fallback may still be in play against a mixed-version pair. All of
    // them carry the SAME id, so a transcript that already holds it means the
    // message has a home and a second turn would only duplicate it.
    if (messageId && conversation.messages.some((m) => m.id === messageId)) {
      this.log(`send ${messageId} in ${conversationId} skipped — already in the transcript`)
      return
    }

    const userMessage = await this.persistUserMessage(
      conversationId,
      content,
      attachments,
      voicePrompt,
      voiceLang,
      messageId
    )
    // The local copy feeds the history build below; the persist above already
    // merged it onto the freshest disk state.
    conversation.messages.push(userMessage)
    conversation.updatedAt = userMessage.timestamp

    // Same-conversation preemption, matching the Electron channel: a second
    // send into a streaming conversation replaces its turn rather than
    // running two against one transcript.
    this.turns.get(conversationId)?.controller.abort()

    const handle = this.deps.runner.send({
      history: this.buildHistory(conversation),
      conversationId,
      userMessageId: userMessage.id,
      projectId: conversation.projectId ?? null,
      planMode,
      makeSink: ({ turnId, conversationId: sinkConversationId }) =>
        this.createSink(turnId, sinkConversationId ?? conversationId, userMessage)
    })
    this.turns.set(conversationId, { turnId: handle.turnId, controller: handle.controller })
    this.log(`turn ${handle.turnId} started from the phone in ${conversationId}`)
  }

  /**
   * Append the phone's user message to the conversation file. An append-RMW
   * against the freshest disk state, exactly like the Telegram channel: a
   * concurrent writer (summarizer, another surface) must never be clobbered
   * by a stale copy. A null disk means the conversation was deleted out from
   * under us — the write is skipped rather than resurrecting the file.
   *
   * `id` comes from the phone when it sent one: it is already showing this
   * message, and matching ids are what let its copy be replaced by this one
   * rather than appear twice. Ids are scoped to a conversation and the phone
   * mints in the same `m_<ts>_<rand>` shape, so adopting one is no different
   * from minting it here.
   */
  private async persistUserMessage(
    conversationId: string,
    content: string,
    attachments: MessageAttachment[],
    voicePrompt: boolean,
    voiceLang: string | undefined,
    id?: string
  ): Promise<ConversationMessage> {
    const message: ConversationMessage = {
      id: id ?? mintMessageId(),
      role: 'user',
      content,
      timestamp: Date.now(),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(voicePrompt ? { voicePrompt: true } : {}),
      ...(voiceLang ? { voiceLang } : {})
    }
    await updateConversation(conversationId, (disk) => {
      if (!disk) return null
      // Inside the RMW, where the check is actually sound: the caller's own
      // pre-check read the file before this queue entry ran, so a racing
      // writer (a re-send that beat us by a microtask) is only visible here.
      if (disk.messages.some((m) => m.id === message.id)) return null
      disk.messages.push(message)
      disk.updatedAt = message.timestamp
      return disk
    })
    return message
  }

  /**
   * The LLM-bound history, built the way the Telegram channel builds it so a
   * turn from the phone sees exactly what a turn from anywhere else sees:
   * summarized prefix + replay window, assistant segments with their tool
   * calls and results, voice notes as `<voice_note>` transcripts (the audio
   * never reaches the model), attachments composed into the message content
   * and forwarded so images and PDFs become native blocks downstream.
   */
  private buildHistory(conversation: ConversationFile): ChatHistoryMessage[] {
    const window = replayWindow(conversation)
    return stubStaleToolResults(
      window.preamble.concat(
        window.messages.flatMap((m) => {
          if (m.role !== 'user') return assistantSegmentsToHistory(m)
          if (m.voicePrompt) {
            const langAttr = m.voiceLang ? ` lang="${m.voiceLang}"` : ''
            return [{ role: 'user' as const, content: `<voice_note${langAttr}>\n${m.content}` }]
          }
          const atts = m.attachments ?? []
          const entry: ChatHistoryMessage = {
            role: 'user',
            content: composeAttachmentContext(m.content, atts)
          }
          if (atts.length > 0) {
            entry.attachments = atts.map((a) => ({
              type: a.type,
              filePath: a.filePath,
              originalName: a.originalName,
              mimeType: a.mimeType,
              sizeBytes: a.sizeBytes
            }))
          }
          return [entry]
        })
      ),
      conversation.id
    )
  }

  /**
   * The attachments a phone message may carry, reduced to the ones that are
   * real: a workspace-relative path that resolves inside the root and whose
   * bytes are already here (the phone uploads before it sends). Type and mime
   * are re-derived rather than trusted — the wire shape is data, not policy.
   */
  private async sanitizeAttachments(raw: unknown): Promise<MessageAttachment[]> {
    if (!Array.isArray(raw)) return []
    const out: MessageAttachment[] = []
    for (const item of raw.slice(0, 10)) {
      if (!item || typeof item !== 'object') continue
      const candidate = item as Record<string, unknown>
      const filePath = typeof candidate.filePath === 'string' ? candidate.filePath : ''
      if (!filePath || !resolveUploadPath(filePath)) continue
      if (!(await uploadExists(filePath))) {
        this.log(`attachment dropped — no bytes on disk for ${filePath}`)
        continue
      }
      const originalName =
        typeof candidate.originalName === 'string' && candidate.originalName
          ? candidate.originalName
          : (filePath.split('/').pop() ?? filePath)
      const declaredMime = typeof candidate.mimeType === 'string' ? candidate.mimeType : undefined
      const { type, mimeType } = classifyFile(originalName, declaredMime)
      const stat = await statUpload(filePath)
      const attachment: MessageAttachment = {
        type,
        filePath,
        originalName,
        mimeType,
        sizeBytes: stat?.sizeBytes ?? 0
      }
      for (const key of ['width', 'height', 'durationSeconds'] as const) {
        const value = candidate[key]
        if (typeof value === 'number' && Number.isFinite(value)) attachment[key] = value
      }
      out.push(attachment)
    }
    return out
  }

  /** Drop one pending upload and its staged bytes. */
  private async abortUpload(uploadId: string, reason: string): Promise<void> {
    const upload = this.uploads.get(uploadId)
    if (!upload) return
    this.uploads.delete(uploadId)
    clearTimeout(upload.idleTimer)
    await upload.handle.close().catch(() => undefined)
    await fs.rm(upload.stagedPath, { force: true }).catch(() => undefined)
    this.debug(`upload ${uploadId} aborted — ${reason}`)
  }

  private async abortAllUploads(): Promise<void> {
    await Promise.all([...this.uploads.keys()].map((id) => this.abortUpload(id, 'channel stopped')))
  }

  /**
   * Renders a turn onto the phone. Text deltas stream as they arrive so the
   * phone shows the assistant writing; anything else (tool calls, the finished
   * message) resolves to a fetch, because the phone already knows how to read
   * a stored conversation and that keeps one shape rather than two.
   *
   * The sink is also this channel's persister. The Electron channel leans on
   * its renderer to save the turn and Telegram saves inside its own sink —
   * nobody else writes a mobile turn to disk, so without the accumulator here
   * the phone's post-turn refetch would pull a transcript that stops before
   * the answer it just watched stream.
   */
  private createSink(
    turnId: string,
    conversationId: string,
    userMessage?: ConversationMessage
  ): TurnSink {
    let seq = 0
    const acc: AssistantAccumulator = {
      assistantMessageId: mintMessageId(),
      assistantTimestamp: Date.now(),
      assistantContent: '',
      segments: [],
      approvals: new Map(),
      toolTimings: new Map(),
      stopReason: null
    }
    /**
     * Tokenomics for the persisted context-meter `stats`. The renderer builds
     * these itself for in-app turns; every other channel must fold them in at
     * the fold, and this one did not — so a conversation started on the phone
     * showed a blank meter card when reopened in the app. Same collector
     * Telegram/WhatsApp/CLI use.
     */
    const stats = new TurnStatsCollector(Date.now())
    /**
     * Append the accumulated assistant message; resolves once it is on disk.
     * Runs even without an assistant message when the turn reached the model,
     * so an errored/empty turn still records its all-time roll-up.
     */
    const persistTurn = async (error?: string): Promise<void> => {
      const assistant = buildAssistantMessage(acc)
      const foldStats = stats.hasData()
      if (!assistant && !foldStats) return
      if (assistant && error) assistant.error = error
      const endedAt = Date.now()
      await updateConversation(conversationId, (disk) => {
        if (!disk) return null
        if (assistant) {
          disk.messages.push(assistant)
          disk.updatedAt = endedAt
        }
        if (foldStats) disk.stats = stats.foldInto(disk.stats, endedAt)
        return disk
      }).catch(() => undefined)
    }
    /**
     * The live mirror of this turn, throttled — the same message this sink
     * will persist, as it stands right now, under the id it will be saved
     * with. Identical in kind to what the Electron/Telegram/WhatsApp mirrors
     * send the phone, which is the point: a turn started ON the phone was the
     * one case that pushed something else, and that something else was a bare
     * `{turnId, kind}` nudge meaning "re-read the conversation". Mid-turn
     * there is nothing to re-read — the assistant message is not on disk until
     * persistTurn above — so the phone would fetch a transcript from BEFORE
     * the turn and overwrite what it was showing. Sending the message itself
     * costs the same push and needs no fetch at all.
     */
    let lastMirrorAt = 0
    let mirrorTimer: NodeJS.Timeout | null = null
    const emitMirror = (urgent: boolean): void => {
      // A trailing tick from a turn already released — finished, or preempted
      // by a second send into the same conversation — must not push a stale
      // snapshot over the message that replaced it.
      if (this.turns.get(conversationId)?.turnId !== turnId) return
      lastMirrorAt = Date.now()
      // The desktop's own window first, with the FULL accumulator: it renders
      // every segment its own turns produce and has no relay record cap, so
      // neither the phone's clean-feed setting nor the wire budget applies.
      try {
        const full = buildAssistantMessage(acc)
        if (full) this.rendererMirror?.(conversationId, full, userMessage)
      } catch {
        // a broken renderer bridge must never affect the turn
      }
      const message = buildAssistantMessage(
        this.verbose ? acc : { ...acc, segments: acc.segments.filter(isCleanFeedSegment) }
      )
      if (!message) return
      // The prompt rides every tick, exactly as the in-app mirror sends it: a
      // phone that pairs — or relaunches — mid-turn only ever sees ticks, and
      // the answer without its question is the gap this closes. `urgent` is
      // the immediate flush — a parked card's anchor — which must not sit out
      // the byte pacing either.
      this.pushMessageAppended(conversationId, message, userMessage, { urgent })
    }
    /**
     * The FINISHED turn, to this machine's window, once.
     *
     * `emitMirror` above refuses to fire for a turn that no longer holds the
     * conversation's slot, and `onDone` releases that slot first — so the
     * renderer's last snapshot is whatever stood at the previous tick, up to
     * a whole reply behind (a short answer finishes inside the 500ms throttle,
     * leaving the window on the FIRST snapshot: usually a model chip alone,
     * which draws as an empty bubble under the prompt). The phone doesn't
     * notice — `pushConversationRefresh` makes it refetch the saved body —
     * but nothing told the window, so it sat on that stub until the app was
     * restarted. This is the window's counterpart of that refresh: one last
     * snapshot, past the throttle and past the slot guard, carrying exactly
     * what `persistTurn` writes under the same id the ticks already used.
     */
    const flushFinalMirror = (error?: string): void => {
      if (mirrorTimer) {
        clearTimeout(mirrorTimer)
        mirrorTimer = null
      }
      try {
        const full = buildAssistantMessage(acc)
        if (!full) return
        if (error) full.error = error
        this.rendererMirror?.(conversationId, full, userMessage)
      } catch {
        // a broken renderer bridge must never affect the turn
      }
    }
    const scheduleMirror = (immediate: boolean): void => {
      const sinceLast = Date.now() - lastMirrorAt
      if (immediate || sinceLast >= MIRROR_THROTTLE_MS) {
        if (mirrorTimer) {
          clearTimeout(mirrorTimer)
          mirrorTimer = null
        }
        emitMirror(immediate)
        return
      }
      if (mirrorTimer) return
      mirrorTimer = setTimeout(() => {
        mirrorTimer = null
        emitMirror(false)
      }, MIRROR_THROTTLE_MS - sinceLast)
      mirrorTimer.unref?.()
    }
    return {
      channelId: 'mobile' as TurnSink['channelId'],
      turnId,
      conversationId,
      onSegment: (segment: Segment) => {
        // Subagent output never renders as the assistant's own voice — the
        // same rule every other channel's replay path follows. `worker` is
        // only present on the segment kinds that can carry it.
        if ('worker' in segment && segment.worker) return
        // Everything the phone's replay will want, whatever the mirror below
        // decides to push right now. Workflow/task snapshots upsert by id — a
        // stream of them is one card, not a card per tick.
        if (segment.kind === 'workflow') upsertWorkflowSegment(acc.segments, segment)
        else if (segment.kind === 'task') upsertTaskSegment(acc.segments, segment)
        else if (segment.kind === 'countdown') upsertCountdownSegment(acc.segments, segment)
        else if (segment.kind === 'wait') upsertWaitSegment(acc.segments, segment)
        else if (segment.kind === 'process') upsertProcessSegment(acc.segments, segment)
        else if (segment.kind === 'browser') upsertBrowserSegment(acc.segments, segment)
        else if (segment.kind === 'tool_result') upsertToolResultSegment(acc.segments, segment)
        else if (segment.kind === 'todo') upsertTodoSegment(acc.segments, segment)
        else if (segment.kind === 'text' || segment.kind === 'reasoning')
          appendTextSegment(acc.segments, segment)
        else acc.segments.push(segment)
        if (segment.kind === 'turn_end') acc.stopReason = segment.stopReason
        if (segment.kind === 'text') {
          acc.assistantContent += segment.delta
          // Text rides BOTH rails: the delta so the phone shows the answer
          // arriving token by token, the throttled snapshot so it also gets
          // the structure around it. The phone folds one into the other —
          // a snapshot supersedes the deltas it already contains — so the two
          // can never print the same words twice.
          this.pushMessageDelta(conversationId, segment.delta, seq++)
          scheduleMirror(false)
          return
        }
        // A card flipping to running/succeeded should not wait out the text
        // throttle, exactly as in the in-app mirror.
        scheduleMirror(
          segment.kind === 'task' ||
            segment.kind === 'countdown' ||
            segment.kind === 'wait' ||
            segment.kind === 'process' ||
            segment.kind === 'browser' ||
            segment.kind === 'user_message'
        )
      },
      // Accumulate tokenomics for the persisted context-meter stats.
      onTurnEvent: (type, payload) => stats.note(type, payload),
      /**
       * A flagged tool call, put to the phone as the card the desktop shows
       * for the same request. The turn parks here until the phone answers,
       * the turn ends, or the tunnel drops — `drainTurnRequests` owns the
       * last two, and every one of them resolves this promise.
       *
       * The record goes into the accumulator whether or not it is ever
       * answered, so the saved transcript carries the same approval card the
       * in-app and Telegram histories do; the decision is back-filled where
       * it is made.
       */
      onApprovalRequest: (req: ApprovalRequest & { id: string }) => {
        return new Promise<ApprovalDecision>((resolve) => {
          acc.approvals.set(req.id, {
            approvalId: req.id,
            toolCallId: req.toolCall.id,
            tool: req.toolCall.name,
            args: req.toolCall.args,
            reason: req.reason,
            level: req.level,
            description: req.description
          })
          // Nothing on the other end can answer — fail closed exactly as this
          // sink did before it could ask at all.
          if (!this.tunnel?.connected) {
            const stored = acc.approvals.get(req.id)
            if (stored) stored.decision = 'denied'
            this.log(`approval ${req.toolCall.name} denied — no phone connected`)
            resolve('denied')
            return
          }
          // Several requests can be parked at once — a turn can have more than
          // one tool call in flight, and the phone anchors a card per tool
          // call, so nothing here supersedes anything. Same as the Electron
          // channel; the text channels collapse to one only because a chat
          // thread has no way to show two.
          this.pendingApprovals.set(req.id, {
            turnId,
            conversationId,
            resolve,
            approvals: acc.approvals
          })
          // The card anchors to its tool_call segment, so the phone must have
          // that segment before the request arrives — flush the mirror rather
          // than let it sit out the throttle.
          scheduleMirror(true)
          this.log(`approval requested from the phone — ${req.toolCall.name} (${req.level})`)
          this.tunnel?.emit(Event.approvalRequest, {
            conversationId,
            turnId,
            id: req.id,
            toolCallId: req.toolCall.id,
            tool: req.toolCall.name,
            args: req.toolCall.args,
            level: req.level,
            reason: req.reason,
            description: req.description
          })
        })
      },
      /**
       * ask_user, put to the phone as the interactive question card. With no
       * phone on the other end this resolves `unsupported` rather than
       * `canceled` — the `ask` tool then degrades to posing the question as
       * plain text, which is readable whenever the user next opens the app,
       * where a cancel would just lose it.
       */
      onAskUserRequest: (req: AskUserRequest & { id: string }) => {
        return new Promise<AskUserResponse>((resolve) => {
          if (!this.tunnel?.connected) {
            this.debug('ask_user degraded to text — no phone connected')
            resolve({ kind: 'unsupported' })
            return
          }
          this.pendingAsks.set(req.id, {
            turnId,
            conversationId,
            resolve,
            card: { toolCallId: req.toolCallId, questions: req.questions }
          })
          scheduleMirror(true)
          this.log(`ask_user put to the phone — ${req.questions.length} question(s)`)
          this.tunnel?.emit(Event.askRequest, {
            conversationId,
            turnId,
            id: req.id,
            toolCallId: req.toolCallId,
            questions: req.questions
          })
        })
      },
      onDone: () => {
        this.turns.delete(conversationId)
        this.drainTurnRequests(turnId, 'turn ended')
        this.log(`turn ${turnId} finished`)
        flushFinalMirror()
        // Disk first, pushes second: the refresh push triggers the phone's
        // body refetch, and a refetch that outruns the save would hand back
        // a transcript without the reply — the exact hole this sink closes.
        void persistTurn().then(() => {
          this.pushTurnStatus(conversationId, 'done')
          void this.pushConversationRefresh(conversationId)
        })
      },
      onError: (error: string) => {
        this.turns.delete(conversationId)
        this.drainTurnRequests(turnId, 'turn failed')
        this.log(`turn ${turnId} failed — ${error}`)
        flushFinalMirror(error)
        // A failed turn still persists what streamed before it broke —
        // matching every other channel, and keeping both transcripts honest
        // about how far the answer got.
        void persistTurn(error).then(() => {
          this.pushTurnStatus(conversationId, 'error', error)
          void this.pushConversationRefresh(conversationId)
        })
      },
      onCredentialBlocked: (type: string) => {
        this.pushTurnStatus(conversationId, 'error', `blocked: ${type}`)
      }
    }
  }

  /**
   * Resolve every request still parked on the phone — for one turn, or for
   * all of them when `turnId` is null (the tunnel went away, the channel
   * stopped). Fails closed, exactly like the Electron channel draining a
   * closed window: approvals deny, asks cancel, and a denied approval is
   * written into the turn's accumulator so the saved transcript records the
   * outcome the agent actually got.
   *
   * The pipeline is BLOCKED on these promises. Anything that ends a turn or
   * takes the phone away has to come through here, or the turn hangs forever.
   */
  private drainTurnRequests(turnId: string | null, reason: string): void {
    for (const [id, entry] of this.pendingApprovals) {
      if (turnId !== null && entry.turnId !== turnId) continue
      this.pendingApprovals.delete(id)
      const stored = entry.approvals.get(id)
      if (stored && !stored.decision) stored.decision = 'denied'
      this.log(`approval ${id} denied — ${reason}`)
      entry.resolve('denied')
    }
    for (const [id, entry] of this.pendingAsks) {
      if (turnId !== null && entry.turnId !== turnId) continue
      this.pendingAsks.delete(id)
      this.log(`ask ${id} canceled — ${reason}`)
      entry.resolve({ kind: 'canceled' })
    }
  }

  /** Nudge the phone to re-read a conversation whose body just changed. */
  private async pushConversationRefresh(conversationId: string): Promise<void> {
    this.tunnel?.emit(Event.messageAppended, { conversationId })
  }

  // ------------------------------------------------------------------ push

  /** A conversation was created or changed — the phone's list updates live. */
  pushConversationUpserted(meta: ConversationMeta): void {
    this.debug(`push conversation ${meta.id} (${meta.messageCount} messages)`)
    this.tunnel?.emit(Event.conversationUpserted, meta)
  }

  pushConversationDeleted(id: string): void {
    this.debug(`push delete ${id}`)
    this.tunnel?.emit(Event.conversationDeleted, { id })
  }

  /** Streaming assistant output for whichever conversation the phone has open. */
  pushMessageDelta(conversationId: string, text: string, seq: number): void {
    // Counted before the emit so a snapshot cached in the same tick reads the
    // count INCLUDING this delta exactly when it includes its text.
    this.mirrorDeltaSeq.set(conversationId, (this.mirrorDeltaSeq.get(conversationId) ?? 0) + 1)
    this.tunnel?.emit(Event.messageDelta, { conversationId, text, seq })
  }

  /**
   * The assistant message so far, in full, rather than the piece just added.
   * `replace` tells the phone to show this instead of appending it — the
   * mirror other channels emit is a snapshot, and appending snapshots would
   * repeat the whole answer on screen once per tick.
   */
  pushMessageSnapshot(conversationId: string, text: string): void {
    this.tunnel?.emit(Event.messageDelta, { conversationId, text, replace: true })
  }

  /**
   * A message the phone should show, or — with no message — a bare nudge to
   * re-read the conversation once nothing is being written into it.
   *
   * An event is one frame with no chunking behind it, so a push past the
   * relay's record cap does not arrive late, it closes the tunnel. An
   * oversized snapshot is therefore TRIMMED to the budget (fitMirrorMessage:
   * tool payloads shortened oldest-first, the live edge kept whole, the id
   * kept always) rather than sent — and rather than WITHHELD, which was the
   * old degrade and is how a long tool-heavy turn went dark on the phone for
   * its whole remaining runtime. Only a message that defeats even the trimmer
   * (unserializable, or an envelope no budget can hold) falls back to the
   * nudge.
   *
   * Every full snapshot that passes through here is also CACHED as the
   * conversation's turn-so-far, connected phone or not — Rpc.turnMirror
   * serves it to a phone that joins or rejoins mid-turn, which is the one
   * moment nothing else can redraw the run.
   *
   * `userMessage` — the prompt this turn is answering — travels on BOTH paths.
   * It is a couple of hundred bytes and it is the half of the exchange the
   * phone cannot get anywhere else while the turn runs, so it must not be
   * dropped along with an assistant snapshot that needed trimming: those are
   * exactly the long turns where the gap is most visible.
   */
  pushMessageAppended(
    conversationId: string,
    message: unknown,
    userMessage?: unknown,
    opts?: { urgent?: boolean }
  ): void {
    const prompt = userMessage === undefined ? {} : { userMessage }
    if (message !== undefined) {
      const fitted = this.fitMirror(conversationId, message)
      if (fitted === null) {
        this.tunnel?.emit(Event.messageAppended, { conversationId, ...prompt })
        return
      }
      // A mid-turn message the run has just read takes the same urgent lane a
      // parked approval's anchor does, and for the same reason: its
      // `delivered` push has already retired the phone's pending bubble, so
      // until this snapshot lands the user's own words are on no screen at
      // all. Only the FIRST snapshot carrying it skips the pacing — compared
      // against the previous cache, so the rest of the turn pays as usual.
      const seenUserMessages = new Set(
        this.userMessageIdsOf(this.lastMirrors.get(conversationId)?.message)
      )
      const carriesNewUserMessage = this.userMessageIdsOf(fitted.message).some(
        (id) => !seenUserMessages.has(id)
      )
      this.lastMirrors.set(conversationId, {
        message: fitted.message,
        deltaSeq: this.mirrorDeltaSeq.get(conversationId) ?? 0,
        ...(userMessage !== undefined ? { userMessage: userMessage as ConversationMessage } : {})
      })
      // Urgent flushes (a parked approval/ask needs its anchor segment on the
      // phone BEFORE the request event) go regardless; everything else pays
      // the byte pacing. A deferred tick is not lost — the trailing flush
      // sends the newest cached snapshot when the window opens.
      if (!opts?.urgent && !carriesNewUserMessage && this.deferMirror(conversationId)) return
      this.mirrorPace.set(conversationId, {
        sentAt: Date.now(),
        sentBytes: fitted.bytes,
        timer: this.clearMirrorTimer(conversationId)
      })
      this.mirrorRail = { sentAt: Date.now(), sentBytes: fitted.bytes }
      this.tunnel?.emit(Event.messageAppended, {
        conversationId,
        message: fitted.message,
        ...prompt
      })
      return
    }
    this.tunnel?.emit(Event.messageAppended, { conversationId, ...prompt })
  }

  /**
   * The `user_message` ids a mirror snapshot carries — a mid-turn message the
   * run has read, sitting at the point it read it.
   */
  private userMessageIdsOf(message: unknown): string[] {
    const segments = (message as { segments?: unknown } | null | undefined)?.segments
    if (!Array.isArray(segments)) return []
    const out: string[] = []
    for (const seg of segments) {
      if (!seg || typeof seg !== 'object') continue
      if ((seg as { kind?: unknown }).kind !== 'user_message') continue
      const id = (seg as { messageId?: unknown }).messageId
      if (typeof id === 'string') out.push(id)
    }
    return out
  }

  /** Cancel a conversation's pending mirror flush, if any. Returns null for
   *  the convenience of writing the cleared field in one expression. */
  private clearMirrorTimer(conversationId: string): null {
    const pace = this.mirrorPace.get(conversationId)
    if (pace?.timer) clearTimeout(pace.timer)
    if (pace) pace.timer = null
    return null
  }

  /**
   * Drop every pacing record and pending flush — the tunnel they were pacing
   * is going away. The turn-so-far cache is NOT touched here: a disconnect
   * keeps the pairing, and the rejoin serves lastMirrors to the returning
   * phone. Only unpair forgets that too, with the rest of the relationship.
   */
  private clearMirrorPacing(): void {
    for (const pace of this.mirrorPace.values()) {
      if (pace.timer) clearTimeout(pace.timer)
    }
    this.mirrorPace.clear()
    this.mirrorRail = { sentAt: 0, sentBytes: 0 }
  }

  /**
   * True when this mirror tick must wait — still inside the pace window its
   * predecessor's size bought, or behind a congested local socket. Arms the
   * trailing flush so the newest snapshot still goes out the moment it may.
   */
  private deferMirror(conversationId: string): boolean {
    const pace = this.mirrorPace.get(conversationId)
    const congested = (this.tunnel?.outboundBufferedBytes ?? 0) > MIRROR_BACKLOG_MAX_BYTES
    const paceWait = (sent: { sentAt: number; sentBytes: number } | undefined): number =>
      sent
        ? sent.sentAt + Math.ceil((sent.sentBytes * 1000) / MIRROR_BYTES_PER_SEC) - Date.now()
        : 0
    // The stricter of two windows: this conversation's own, and the whole
    // rail's — one socket, so concurrent turns split the budget rather than
    // each claiming it.
    const waitMs = Math.max(paceWait(pace), paceWait(this.mirrorRail))
    if (!congested && waitMs <= 0) return false
    const delay = congested ? Math.max(waitMs, MIRROR_RETRY_MS) : waitMs
    const entry = pace ?? { sentAt: 0, sentBytes: 0, timer: null }
    if (!pace) this.mirrorPace.set(conversationId, entry)
    if (!entry.timer) {
      entry.timer = setTimeout(() => this.flushPacedMirror(conversationId), delay)
      entry.timer.unref?.()
    }
    return true
  }

  /** The trailing edge of the pacing: push the newest cached snapshot, or
   *  nothing if the turn has since ended — the stored body is the truth then. */
  private flushPacedMirror(conversationId: string): void {
    this.clearMirrorTimer(conversationId)
    const cached = this.lastMirrors.get(conversationId)
    if (!cached) return
    // A snapshot cached BEFORE the newest delta must not go out: on the
    // phone a mirror resets the tail on the promise that it contains every
    // delta sent before it, and this one would arrive after deltas it does
    // not contain — their words would vanish from the visible prose. The
    // phone already holds them as tail; the next tick caches a snapshot
    // that truly contains them and sends into a now-open window.
    if ((this.mirrorDeltaSeq.get(conversationId) ?? 0) !== (cached.deltaSeq ?? 0)) return
    try {
      // Re-enters the paced path: a still-congested socket re-arms the timer,
      // an open window sends.
      this.pushMessageAppended(conversationId, cached.message, cached.userMessage)
    } catch {
      // a socket that died between the check and the send costs one mirror,
      // never the process — the reconnect path re-serves the turn-so-far
    }
  }

  /** The snapshot within the wire budget — trimmed when it must be, null only
   *  when nothing sendable can be made of it. */
  private fitMirror(
    conversationId: string,
    message: unknown
  ): { message: ConversationMessage; bytes: number } | null {
    let size = 0
    try {
      size = Buffer.byteLength(JSON.stringify(message) ?? '')
    } catch {
      return null // unserializable is not sendable either
    }
    if (size <= MIRROR_MAX_BYTES) return { message: message as ConversationMessage, bytes: size }
    const fitted = fitMirrorMessage(message as ConversationMessage, MIRROR_MAX_BYTES)
    if (fitted === null) {
      this.debug(`mirror for ${conversationId} withheld — ${size} bytes and untrimmable`)
      return null
    }
    this.debug(`mirror for ${conversationId} trimmed to fit — ${size} bytes over budget`)
    let fittedBytes = MIRROR_MAX_BYTES
    try {
      fittedBytes = Buffer.byteLength(JSON.stringify(fitted) ?? '')
    } catch {
      // sized a moment ago; the ceiling stands in if it will not size again
    }
    return { message: fitted, bytes: fittedBytes }
  }

  pushTurnStatus(conversationId: string, state: string, detail?: unknown): void {
    // Every state this carries is a turn boundary — started, done, canceled,
    // error — and at a boundary the cached turn-so-far is over: a finished
    // turn's truth is the stored body, a fresh turn's first tick re-caches.
    // The pace record and its pending flush go with it: a mirror sent after
    // the boundary would re-open the live overlay the phone just settled.
    this.clearMirrorTimer(conversationId)
    this.mirrorPace.delete(conversationId)
    this.mirrorDeltaSeq.delete(conversationId)
    this.lastMirrors.delete(conversationId)
    this.tunnel?.emit(Event.turnStatus, { conversationId, state, detail })
  }

  /**
   * A mid-turn user message changed state (pending / delivered / withdrawn).
   * Deliberately NOT pushTurnStatus: a pending message is not a turn
   * boundary, and resetting the live overlay for it would blank the run the
   * phone is watching. The phone draws it as a pending bubble after the
   * streaming card and retires it when the `user_message` segment lands.
   */
  pushInterjection(ev: InterjectionEvent): void {
    this.tunnel?.emit(Event.interjection, ev)
  }

  /**
   * Own the lifecycle of the mid-turn messages the PHONE sent, desktop-side.
   *
   * Telegram and WhatsApp have had this since mid-turn messaging shipped; the
   * phone did not, and that asymmetry was the hole. Their fallback could be
   * left to the sending surface because the message is still sitting in the
   * user's own chat app — losing it costs a scroll-up and a re-send. The phone
   * app is not a second copy of anything: its pending bubble is React state
   * that the `delivered`/`withdrawn` push takes down, and if that push lands
   * while the app is backgrounded, relaunching, or off the tunnel, the words
   * existed nowhere at all.
   *
   * So the desktop re-sends, not the phone. It is the side that cannot miss
   * the event (it emits it), it holds the transcript, and it persists the
   * message before the turn starts. The phone's own handler now only draws.
   *
   * Registered once per start; idempotent.
   */
  private watchInterjections(): void {
    if (this.offInterjection) return
    this.offInterjection = this.deps.runner.onInterjection((ev) => {
      if (ev.channel !== 'mobile') return
      if (ev.state !== 'withdrawn') return
      if (ev.reason !== 'turn_ended' && ev.reason !== 'error') return
      // The turn finished (or died) in the sliver between the agent's last
      // drain and the lane closing, so the message was never read. It is still
      // a message the user sent: it becomes the next turn.
      void this.redispatchInterjection(ev).catch((error) => {
        this.log(
          `re-sending mid-turn message ${ev.messageId} failed — ` +
            `${error instanceof Error ? error.message : String(error)}`
        )
      })
    })
    this.offInterjectionDispatcher = registerInterjectionDispatcher('mobile', (item) =>
      this.redispatchInterjection(item)
    )
  }

  private unwatchInterjections(): void {
    this.offInterjection?.()
    this.offInterjection = null
    this.offInterjectionDispatcher?.()
    this.offInterjectionDispatcher = null
  }

  /**
   * Send a never-read mid-turn message as a fresh turn, under ITS OWN id so
   * the transcript carries the message the user actually wrote rather than a
   * copy of it. Reached twice over: immediately by the sweep above, and later
   * by the reconciler for anything that sweep could not finish (the desktop
   * was quitting, the conversation was busy, a dispatch threw). Both are safe
   * because `continueSend` is idempotent on the message id.
   *
   * Returns false when nothing could be started — the reconciler keeps the
   * park and tries again.
   */
  private async redispatchInterjection(item: {
    conversationId: string
    messageId: string
    text: string
    attachments: MessageAttachment[]
    voicePrompt?: boolean
    voiceLang?: string
  }): Promise<boolean> {
    if (this.channelStopped) return false
    // Two callers, one message: the sweep fires the instant the lane closes and
    // the reconciler wakes on the same event. Both read a park that still holds
    // it, and continueSend's transcript check cannot separate them — neither
    // has written yet. This can, because it is the one thing both go through.
    if (this.redispatching.has(item.messageId)) return false
    this.redispatching.add(item.messageId)
    try {
      // A turn may be running AGAIN by now: the user started one in the window
      // between the sweep and this call, or the reconciler woke on a save while
      // a later run was live. Hand the message to THAT turn instead of starting
      // another — continueSend preempts its conversation's turn, so a blind
      // re-send here would abort work the user had just asked for. Same
      // interject-first rule the channel queues follow when they flush.
      //
      // Reported as NOT sent, which is the truth: the running turn owns the
      // message now, the park keeps it, and the next reconciler pass steps over
      // it because it is back in the live inbox.
      if (this.deps.runner.canInterject(item.conversationId)) {
        const handed = this.deps.runner.interject(item.conversationId, {
          messageId: item.messageId,
          text: item.text,
          attachments: item.attachments ?? [],
          ...(item.voicePrompt ? { voicePrompt: true } : {}),
          ...(item.voiceLang ? { voiceLang: item.voiceLang } : {}),
          channel: 'mobile',
          sentAt: Date.now()
        })
        if (handed.status === 'pending') {
          this.log(`unread mid-turn message ${item.messageId} handed to the live turn instead`)
          return false
        }
      }
      this.log(`re-sending unread mid-turn message ${item.messageId} in ${item.conversationId}`)
      // Awaited only as far as the LAUNCH — a turn runs for minutes, and the
      // caller only needs to know the message is committed, which it is: the
      // user message is persisted inside continueSend before the runner is
      // touched at all.
      await this.continueSend(
        item.conversationId,
        item.text,
        item.attachments ?? [],
        item.voicePrompt === true,
        item.voiceLang,
        item.messageId,
        getPlanMode(item.conversationId)
      )
      return true
    } finally {
      this.redispatching.delete(item.messageId)
    }
  }

  /**
   * The same config snapshot the phone fetches, for a caller that isn't a
   * phone. The CLI reads current setting values from exactly this — one
   * assembler for every non-renderer surface, so a terminal and a phone can
   * never disagree about what a setting is set to.
   */
  buildSnapshot(): Promise<Record<string, unknown>> {
    return buildConfigSnapshot(this.deps)
  }

  /** True when a phone is actually on the other end — lets callers skip the
   *  work of building a push nobody will receive. */
  get hasPeer(): boolean {
    return this.tunnel?.connected ?? false
  }

  /** Any settings change — the phone refreshes the affected screen. */
  pushConfigChanged(section?: string): void {
    this.debug(`push config change (${section ?? 'all'})`)
    this.tunnel?.emit(Event.configChanged, { section: section ?? null, at: Date.now() })
  }

  /**
   * Variables travel whole and immediately — the phone writes them straight
   * into its store, no snapshot round trip, so an edit made here (or echoed
   * back from there) is on its screen in the push's own latency. The
   * debounced config.changed that follows every save still covers phones
   * that predate this topic.
   */
  pushVariablesChanged(
    variables: Array<{ name: string; value: string; sensitive: boolean }>
  ): void {
    this.tunnel?.emit(Event.variablesChanged, { variables, at: Date.now() })
  }

  pushUsageChanged(): void {
    this.tunnel?.emit(Event.usageChanged, { at: Date.now() })
  }

  /**
   * `brain/projects.json` changed, whoever wrote it. Payload-free: the phone
   * re-lists, exactly as an open desktop Projects page re-fetches on the same
   * signal. Fired from the store's own changed-listener, so a write made ON the
   * phone echoes back here too — which is what confirms it landed.
   */
  pushProjectsChanged(): void {
    this.tunnel?.emit(Event.projectsChanged, { at: Date.now() })
  }

  /** `brain/procedures.json` changed — same contract as projects. */
  pushProceduresChanged(): void {
    this.tunnel?.emit(Event.proceduresChanged, { at: Date.now() })
  }

  /** The process registry changed — same contract as projects. */
  pushProcessesChanged(): void {
    this.tunnel?.emit(Event.processesChanged, { at: Date.now() })
  }

  /** A process card re-rendered — see Event.processCardChanged. */
  pushProcessCardChanged(snapshot: unknown): void {
    this.tunnel?.emit(Event.processCardChanged, { snapshot })
  }

  /** The scheduler reloaded: heartbeat.md changed, whatever wrote it. */
  pushAutomationsChanged(): void {
    this.tunnel?.emit(Event.automationsChanged, { at: Date.now() })
  }

  /**
   * The run pool moved. Carries its payload — this fires several times per run
   * and a fetch per tick would be pure overhead. Every row travels, procedure
   * runs included; the phone filters by `kind` where it means automations.
   */
  pushAutomationRuns(snapshot: { running: RunningJobInfo[]; queued: QueuedJobInfo[] }): void {
    this.tunnel?.emit(Event.automationRunsChanged, toWireRuns(snapshot))
  }

  /**
   * The memory index started, moved, or finished rebuilding — null when it is
   * over, which is what retires the phone's card.
   *
   * Throttled, unlike the run pool: progress ticks once per batch of eight
   * files, so a large workspace would otherwise spend the tunnel on a number
   * that changes faster than anyone can read it. Start and finish are never
   * throttled — those are the two edges the card appears and disappears on, and
   * dropping either would leave a card that never showed or never left.
   */
  pushReindexStatus(status: ReindexStatus | null): void {
    const now = Date.now()
    const isEdge = status === null || this.lastReindexPush === 0
    if (!isEdge && now - this.lastReindexPush < REINDEX_PUSH_THROTTLE_MS) return
    this.lastReindexPush = status === null ? 0 : now
    this.tunnel?.emit(Event.reindexChanged, { status })
  }

  /**
   * The self-updater moved — checking, downloading (percent ticks), ready,
   * installing, error. The whole machine travels every time, exactly as the
   * renderer's own updater:state broadcast does, so the phone renders it
   * straight and a missed tick costs nothing. Unthrottled on purpose: the
   * download emits per whole percent, tens of ticks over minutes, and the
   * 'installing' edge right before this app exits must never be the one a
   * throttle swallows.
   */
  pushUpdaterState(state: UpdaterWireState): void {
    this.tunnel?.emit(Event.updaterChanged, { state })
  }

  /** A turn-end countdown transition after its turn ended — see Event.countdownChanged. */
  pushCountdownChanged(snapshot: CountdownSnapshot): void {
    this.tunnel?.emit(Event.countdownChanged, { snapshot })
  }

  /** The in-app browser moved (load, tab switch, still frame) — see Event.browserChanged. */
  pushBrowserChanged(snapshot: BrowserTabSnapshot): void {
    this.tunnel?.emit(Event.browserChanged, { snapshot })
  }

  // ----------------------------------------------------------------- status

  getStatus(): MobileStatus {
    return {
      paired: Boolean(this.pairing?.peerPublicKey),
      pairing: this.pairing
        ? {
            method: this.pairing.method,
            pairedAt: this.pairing.pairedAt,
            lastSeenAt: this.pairing.lastSeenAt,
            deviceName: this.pairing.deviceName,
            platform: this.pairing.platform ?? null,
            model: this.pairing.model ?? null,
            osVersion: this.pairing.osVersion ?? null,
            appVersion: this.pairing.appVersion ?? null
          }
        : null,
      tunnel: this.tunnelState,
      offer: this.offer,
      storage: storageBackend(),
      verbose: this.verbose,
      notificationsEnabled: this.notificationsEnabled,
      relayUrl: this.relayUrl,
      defaultRelayUrl: this.deps.relayUrl ?? DEFAULT_RELAY_URL
    }
  }

  private emitStatus(): void {
    // Every state change flows through here, which makes it the one place
    // the notify_phone tool's registration is kept honest — pairing formed
    // or dropped, phoneId learned at hello, the settings toggle.
    this.syncPhoneCapability()
    this.deps.onStatus?.(this.getStatus())
  }

  get connected(): boolean {
    return this.tunnel?.connected ?? false
  }
}

/**
 * Canonical form for a relay endpoint a user typed or pasted. Accepts the
 * https:// page URL of a relay (the same host serves both) and bare hosts;
 * returns `wss://host[/path]` with no trailing slash. Null or empty means
 * "no override — use the default". Throws when the input cannot name a relay.
 */
export function normalizeRelayUrl(raw: string | null): string | null {
  if (raw === null) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Recognize an explicit scheme first, so `ftp://x` is rejected instead of
  // being swallowed as a host named "ftp" by the bare-host fallback below.
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)?.[1]?.toLowerCase() ?? null
  if (scheme !== null && !['ws', 'wss', 'http', 'https'].includes(scheme))
    throw new Error(`not a relay URL: ${raw}`)
  let candidate: string
  if (scheme === 'https') candidate = `wss://${trimmed.slice('https://'.length)}`
  else if (scheme === 'http') candidate = `ws://${trimmed.slice('http://'.length)}`
  else if (scheme === null) candidate = `wss://${trimmed}`
  else candidate = trimmed
  const parsed = new URL(candidate) // throws on garbage
  if ((parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') || !parsed.hostname)
    throw new Error(`not a relay URL: ${raw}`)
  // A scheme-less input must look like a host (a dot or a port) — otherwise a
  // pairing code pasted into the wrong field becomes wss://K7M9-2QXR.
  if (scheme === null && !parsed.hostname.includes('.') && !parsed.port)
    throw new Error(`not a relay URL: ${raw}`)
  // The tunnel appends `/t/<rid>` — a trailing slash would double up, while a
  // path prefix (a relay mounted under one) passes through untouched.
  const prefix = parsed.pathname.replace(/\/+$/, '')
  return `${parsed.protocol}//${parsed.host}${prefix}`
}

/**
 * A reflection patch from the wire, reduced to the fields that are real: an
 * integer hour 0-23, an integer quiet window 1-48 h.
 * Malformed fields are dropped rather than clamped — clamping would persist a
 * value the user never chose, while dropping costs that field alone and the
 * authoritative answer corrects the screen that sent it.
 */
export function sanitizeReflectionPatch(params: unknown): ReflectionWirePatch {
  const raw = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>
  const patch: ReflectionWirePatch = {}
  if (
    typeof raw.hour === 'number' &&
    Number.isInteger(raw.hour) &&
    raw.hour >= 0 &&
    raw.hour <= 23
  ) {
    patch.hour = raw.hour
  }
  if (
    typeof raw.quietHours === 'number' &&
    Number.isInteger(raw.quietHours) &&
    raw.quietHours >= 1 &&
    raw.quietHours <= 48
  ) {
    patch.quietHours = raw.quietHours
  }
  return patch
}

/** A wire number as a byte count: a non-negative safe integer, else the
 *  fallback. Offsets and lengths come from the peer and index into files —
 *  NaN, negatives and floats must never reach an fs call. */
function clampCount(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fallback
  return value
}

/** Desktop conversation file → the phone's message shape. */
function toWireConversation(file: ConversationFile): Record<string, unknown> {
  return {
    id: file.id,
    title: file.title,
    model: file.model ?? null,
    channel: (file as { channel?: string }).channel ?? null,
    icon: (file as { icon?: string }).icon ?? null,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    stats: (file as { stats?: unknown }).stats ?? null,
    messages: (file.messages ?? []).map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      // Attachments and tool payloads travel verbatim; the phone's renderers
      // already understand the desktop's shapes. Approvals and tool timings
      // ride along for the same reason: they are what the approval card and
      // the tool card's elapsed time are drawn from, and a transcript without
      // them renders a decided approval as a bare tool call. voicePrompt is
      // here for the same reason: it is how the phone knows this message's
      // content is a transcript of the audio right under it, and so must not
      // be printed as a bubble. Without it the stored copy landing at the end
      // of a turn would put the transcript back under the player that the
      // live copy correctly kept out.
      payload: stripUndefined({
        attachments: (message as { attachments?: unknown }).attachments,
        segments: (message as { segments?: unknown }).segments,
        approvals: (message as { approvals?: unknown }).approvals,
        toolTimings: (message as { toolTimings?: unknown }).toolTimings,
        voicePrompt: (message as { voicePrompt?: unknown }).voicePrompt,
        // How the turn ended. `error` is what the phone's provider error card
        // synthesizes from when a failure carries no structured providerErrors
        // on its turn_end — without these a failed turn reads as a normal
        // reply once the stored body replaces the live mirror.
        stopReason: (message as { stopReason?: unknown }).stopReason,
        error: (message as { error?: unknown }).error
      })
    }))
  }
}

/**
 * Desktop project → wire project. The one transformation is the file path:
 * stored absolute, served workspace-relative, because that is the form the
 * phone's file cache resolves and an absolute path would only leak the home
 * directory. Legacy refs from outside the workspace (pre-copy-on-attach, which
 * importOutsideProjectFiles migrates at launch) keep their absolute path —
 * path.relative would produce a `..` escape the phone's cache refuses, so the
 * file simply reads as unavailable there rather than as some other file.
 */
function toWireProject(project: Project): SyncProject {
  const root = workspaceRoot()
  return {
    id: project.id,
    title: project.title,
    icon: project.icon,
    instructions: project.instructions,
    files: project.files.map((file) => ({
      path: file.path.startsWith(root + path.sep) ? path.relative(root, file.path) : file.path,
      name: file.name
    })),
    directories: project.directories ?? [],
    thinking: project.thinking ?? null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  }
}

/** Desktop procedure → wire procedure; optionals become explicit nulls. */
function toWireProcedure(procedure: Procedure): SyncProcedure {
  return {
    id: procedure.id,
    title: procedure.title,
    prompt: procedure.prompt,
    mode: procedure.mode ?? null,
    icon: procedure.icon ?? '',
    projectId: procedure.projectId ?? null,
    // Paths are sent WORKSPACE-RELATIVE for the copies we own (the phone shows
    // a name, and an absolute desktop path means nothing to it) — the same
    // shape a project's files travel in, so removal round-trips through
    // resolveProcedureFiles below.
    files: procedure.files?.map((file) => ({ path: toWirePath(file.path), name: file.name })) ?? [],
    directories: procedure.directories ?? [],
    thinking: procedure.thinking ?? null,
    createdAt: procedure.createdAt,
    updatedAt: procedure.updatedAt
  }
}

/** Workspace-relative when the file is ours, absolute otherwise. */
function toWirePath(filePath: string): string {
  const root = workspaceRoot()
  return filePath.startsWith(root + path.sep) ? path.relative(root, filePath) : filePath
}

/**
 * A phone's directory list, resolved and checked against THIS machine. A path
 * that names nothing here is refused with the reason rather than stored — a
 * working folder the run cannot list is worse than no folder at all.
 */
async function resolveWireDirectories(wire: unknown[]): Promise<string[]> {
  const out: string[] = []
  for (const entry of wire) {
    if (typeof entry !== 'string') continue
    const resolved = await resolveWorkingDirectory(entry)
    if (!resolved.ok) throw new Error(resolved.error)
    if (!out.includes(resolved.path)) out.push(resolved.path)
  }
  return out
}

/**
 * The run pool as the phone reads it — every row, whatever family.
 *
 * `kind` is the brainstem's own `family`, resolved from the job id where the
 * ids are minted (see its `runFamily`), so no surface re-derives it. The two
 * vocabularies are the same four words on purpose. Procedure runs travel like
 * the rest; a consumer that means automations SPECIFICALLY — the Automations
 * screen's per-job status — filters `kind === 'procedure'` itself.
 *
 * Only what that gating reads goes over: the id, the heading label and the
 * kind. The prompt body, start time and mode stay home.
 */
function toWireRuns(snapshot: {
  running: RunningJobInfo[]
  queued: QueuedJobInfo[]
}): AutomationRuns {
  return {
    running: snapshot.running.map((row) => ({ id: row.id, label: row.label, kind: row.family })),
    queued: snapshot.queued.map((row) => ({ id: row.id, label: row.label, kind: row.family }))
  }
}

/**
 * Read a string off the wire, trimmed and bounded. Every phone-authored field
 * below goes through here — the wire is data, not policy, and these values are
 * written into a workspace file the agent reads back as instructions.
 */
function wireText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.slice(0, max)
}

/** The two chat modes, or undefined — which means "leave it alone". */
function wireMode(value: unknown): 'single' | 'workflow' | undefined {
  return value === 'single' || value === 'workflow' ? value : undefined
}

/**
 * A canonical reasoning token off the wire, or undefined for anything else.
 *
 * Only the four canonical tokens are ever stored, so a stray value is read as
 * absent rather than written through — an unknown mode would make the item's
 * run fall back to a default silently, which is worse than leaving the stamp
 * as it was. `null` reads as undefined too: the phone never needs to CLEAR a
 * stamp (the fallback is "no marker, follow the model"), and the desktop's
 * setters take `undefined` as "leave alone".
 */
function wireReasoning(value: unknown): ReasoningMode | undefined {
  return typeof value === 'string' && (REASONING_MODES as readonly string[]).includes(value)
    ? (value as ReasoningMode)
    : undefined
}

/**
 * Read an AskUserResponse off the wire. The `ask` plugin pairs answers with
 * questions BY POSITION, so a malformed entry cannot simply be dropped — that
 * would shift every answer after it onto the wrong question. Anything that is
 * not a complete, well-formed answer list is therefore read as a cancel, which
 * is the one outcome that cannot be misattributed.
 */
function sanitizeAskResponse(raw: unknown): AskUserResponse {
  if (!raw || typeof raw !== 'object') return { kind: 'canceled' }
  const value = raw as Record<string, unknown>
  if (value.kind !== 'answered' || !Array.isArray(value.answers)) return { kind: 'canceled' }
  const answers: AskUserAnswer[] = []
  for (const item of value.answers) {
    if (!item || typeof item !== 'object') return { kind: 'canceled' }
    const answer = item as Record<string, unknown>
    if (answer.kind === 'option') {
      const index = answer.index
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
        return { kind: 'canceled' }
      }
      answers.push({ kind: 'option', index })
      continue
    }
    if (answer.kind === 'custom' && typeof answer.text === 'string' && answer.text.trim()) {
      answers.push({ kind: 'custom', text: answer.text })
      continue
    }
    return { kind: 'canceled' }
  }
  if (answers.length === 0) return { kind: 'canceled' }
  return { kind: 'answered', answers }
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined)
  return entries.length ? Object.fromEntries(entries) : undefined
}
