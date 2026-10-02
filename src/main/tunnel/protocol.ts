/**
 * The tunnel wire contract, shared verbatim between desktop and mobile.
 *
 * This file is vendored identically into wolffish-app (`src/main/tunnel/`) and
 * wolffish-mobile (`src/lib/tunnel/`). Keep the two byte-identical — a drift
 * here is a protocol split, and the frame types below are the only thing the
 * two apps agree on. It has no imports for exactly that reason.
 *
 * The relay (wolffish-relay) never parses any of this: it forwards opaque
 * binary records between one `host` (desktop) and one `guest` (mobile) that
 * presented the same rendezvous ID. Everything below is end-to-end sealed
 * before it reaches the socket.
 */

export const PROTOCOL_VERSION = 1

export const DEFAULT_RELAY_URL = 'wss://relay.wolffi.sh'

/**
 * Outer record type — the first byte of every binary message.
 *
 * A reconnecting device can otherwise mistake a straggler from the previous
 * session for a handshake message: when a phone drops mid-transfer the
 * desktop's socket still holds queued chunks, and those flush to the *new*
 * connection. This marker lets each side ignore records belonging to a session
 * it has already left. It reveals only "handshake" versus "data" — the same
 * metadata a TLS record header exposes — never anything about content.
 *
 * CONTROL is the one deliberate exception to "the relay never parses": a
 * CONTROL record's body is plaintext JSON addressed to the RELAY (the push
 * control plane below), terminated there and never forwarded. Old relays
 * forward it like any binary frame and old peers drop unknown record types,
 * so version skew degrades to "no push", never to a broken tunnel.
 */
export const RecordType = { HANDSHAKE: 0x01, TRANSPORT: 0x02, CONTROL: 0x03 } as const

/** Frame types inside a decrypted record. */
export const FrameType = {
  PING: 0x00,
  HELLO: 0x01,
  RPC_REQ: 0x02,
  RPC_RES: 0x03,
  EVENT: 0x04,
  FILE_MANIFEST: 0x10,
  FILE_WANT: 0x11,
  FILE_CHUNK: 0x12,
  FILE_ACK: 0x13,
  FILE_DONE: 0x14
} as const

/** Ciphertext stays far under the relay's 1 MiB cap. */
export const CHUNK_SIZE = 256 * 1024
/** Chunks in flight before the sender waits for credit. */
export const WINDOW = 32
/** Receiver acknowledges (and checkpoints) this often. */
export const ACK_EVERY = 16
/** Relay-answered keepalive cadence; never wakes the Durable Object. */
export const KEEPALIVE_MS = 25_000

/** Application close codes the relay uses (4000–4999 is the app range). */
export const CloseCode = {
  Replaced: 4000,
  ProtocolViolation: 4400,
  MessageTooLarge: 4413
} as const

/** Relay → client presence notices. The only text the relay ever sends. */
export const PEER_PRESENT = '{"t":"peer-present"}'
export const PEER_GONE = '{"t":"peer-gone"}'
export const KEEPALIVE_REQUEST = 'ping'
export const KEEPALIVE_RESPONSE = 'pong'

/** Rendezvous IDs are exactly 256 bits, lowercase hex. */
export const RID_REGEX = /^[0-9a-f]{64}$/

/**
 * RPC methods. Desktop serves everything under `desktop.*`; the phone serves
 * `device.*` so the agent can reach capabilities only a phone has.
 *
 * Kept as a const map rather than free strings so both sides fail at compile
 * time when a method is renamed on one side only.
 */
export const Rpc = {
  /** Handshake sanity + versions. */
  hello: 'desktop.hello',
  /** The full ConfigSnapshot the mobile settings screens render. */
  configSnapshot: 'desktop.config.snapshot',
  /**
   * Replace the workspace's prompt variables with the given array — the one
   * setting the phone edits rather than mirrors. Whole-array replace, exactly
   * like the desktop's own save: the desktop applies writes in arrival order
   * and the last one wins, so both screens converge on whatever was written
   * last. Params: `{ variables: Array<{name, value, sensitive}> }`.
   */
  variablesSet: 'desktop.variables.set',
  /** Conversation index — metadata only, never message bodies. */
  conversationIndex: 'desktop.conversations.index',
  /**
   * One conversation's messages, fetched when the user opens it. Params
   * `{ id, chunked? }`. The answer is normally the wire conversation inline;
   * a body too large for one frame answers `{ chunked: true, bodyId,
   * sizeBytes, updatedAt }` when the caller passed `chunked: true` — the
   * caller then pulls the complete JSON through `conversationBodyChunk` —
   * and is served trimmed to one frame otherwise (a caller that never asks
   * for chunks is a build that predates them).
   */
  conversationBody: 'desktop.conversations.body',
  /**
   * One window of a chunked conversation body. Params `{ bodyId, offset,
   * length? }` → `{ data, sizeBytes }` — base64url bytes of the serialized
   * wire conversation, windows capped at CHUNK_SIZE, exactly the fileRead
   * contract. The spool behind a bodyId lives for a couple of minutes and
   * every read refreshes it; an expired or unknown id is an error and the
   * caller re-requests the conversation.
   */
  conversationBodyChunk: 'desktop.conversations.bodyChunk',
  /**
   * File one conversation under a project, or unfile it with null. Params:
   * `{ conversationId, projectId }` → `{ ok, projectId }` with the binding
   * that actually holds (an unknown project id unfiles rather than dangles).
   *
   * The phone cannot do this locally: the overlay every turn runs with is
   * built from the `projectId` on the DESKTOP's conversation file, so a
   * binding written only to the phone's SQLite would show a project on screen
   * while the turns ran without its instructions.
   */
  conversationProject: 'desktop.conversations.project',
  /**
   * One conversation's plan-mode stance — `{ conversationId }` →
   * `{ planMode }`. Read when the phone opens a chat so its switch matches
   * the desktop's chip; the desktop holds the stance (main/runtime/plan-mode).
   */
  planModeGet: 'desktop.chat.planMode.get',
  /**
   * Set one conversation's plan-mode stance — `{ conversationId, planMode }`
   * → `{ planMode }`. The desktop applies it and pushes `Event.planMode` to
   * every surface, the phone included, so both sides settle on one answer.
   */
  planModeSet: 'desktop.chat.planMode.set',
  /** Usage totals and per-provider breakdown. */
  usage: 'desktop.usage',
  /**
   * One month of the desktop's own release notes — the markdown of
   * src/changelog/<month>/<locale>.md verbatim, English when the requested
   * locale has no page. The snapshot's `changelog.months` says what exists;
   * bodies are fetched one at a time because the full set is hundreds of KB
   * and read far more rarely than the settings that ride the snapshot.
   * Params: `{ month: 'YYYY-MM', locale }` → `{ markdown }` (null when the
   * month is unknown).
   */
  changelogRead: 'desktop.changelog.read',
  /**
   * Flip one capability on or off from the phone. The desktop applies it
   * through the exact same path as its own settings toggle and answers
   * `{ ok, enabled }` with the state that actually holds — a locked core
   * capability refuses the off, an unknown name is an error.
   */
  capabilitySet: 'desktop.capabilities.set',
  /**
   * Apply a settings patch the phone edited. Params: `{ settings }` — a flat
   * partial of the phone's editable config surface. The desktop persists it
   * through the same setters its own panels use (whitelisted — an unknown key
   * is an error, and the phone reverts by refetching the snapshot). Answers
   * `{ ok: true }`; the config.changed push that follows is the confirmation.
   */
  configSet: 'desktop.config.set',
  /**
   * Send a user turn; the reply streams back as events. A `projectId` files a
   * NEWLY CREATED conversation under that project at creation, so the very turn
   * this send starts already carries the project's overlay — re-filing it a
   * moment later would leave the first turn without the instructions. Ignored
   * when the send names an existing conversation, which already has its own
   * binding (change that with `conversationProject`).
   */
  sendMessage: 'desktop.chat.send',
  /** Stop the running turn. */
  abortTurn: 'desktop.chat.abort',
  /**
   * Hand a message to the conversation's RUNNING turn instead of starting a
   * new one — the phone's mid-turn send. Params mirror `sendMessage` minus
   * the creation fields: `{ conversationId, messageId, text, attachments,
   * voicePrompt?, voiceLang? }`. The desktop saves nothing here: the message
   * parks in the turn runner's inbox and the agent reads it at its next stop
   * point, where it becomes a `user_message` segment on the assistant
   * message the phone is already mirroring. Answers the runtime's
   * InterjectResult — `{ status: 'pending' }`, or `{ status: 'no_live_turn' }`
   * when nothing is running and the phone should send a normal turn.
   * A voice note is transcribed BEFORE it parks (the transcript is what the
   * model reads), so the answer can take as long as STT does.
   */
  interject: 'desktop.chat.interject',
  /**
   * Take a still-unread mid-turn message back out. Params
   * `{ conversationId, messageId }` → `{ ok }`; false once the agent has
   * already read it — a delivered message is history and cannot be unsent.
   */
  withdrawInterjection: 'desktop.chat.withdrawInterjection',
  /**
   * The mid-turn messages parked for one conversation and not yet read, as
   * `{ pending: Interjection[] }` — for a phone that connects or relaunches
   * into a running turn and has missed the `interjection.status` pushes.
   */
  pendingInterjections: 'desktop.chat.pendingInterjections',
  /**
   * Which conversations have a turn in flight right now, as
   * `{ conversationIds: string[] }` — this app's own chat:activeRuns, served
   * to the phone for the reason a renderer window gets it: 'started' is a
   * broadcast, so a surface that connects mid-run has already missed the only
   * announcement that turn was ever going to send.
   *
   * The phone reads it once per connection and opens a live overlay per id,
   * which is what every piece of its chat chrome derives "running" from.
   */
  activeRuns: 'desktop.chat.activeRuns',
  /**
   * The turn-so-far for one conversation with a run in flight. Params:
   * `{ conversationId }` → `{ message, userMessage?, asks, approvals }` —
   * the newest live-mirror snapshot of the assistant message being written
   * (null when the turn has produced nothing yet), the prompt it answers,
   * and the ask/approval cards the turn is still parked on, each shaped as
   * its original push event was.
   *
   * This exists for the phone that JOINS a run late: pushes only describe
   * what happens next, the assistant message reaches disk only when the turn
   * folds, and across a long tool call the next mirror tick is minutes away.
   * A phone that pairs mid-turn, or relaunches after iOS reclaimed it, calls
   * this once per active run it has no live state for (see seedActiveRuns)
   * and redraws the turn instead of a blank thinking row. An older desktop
   * answers with an error and the phone keeps the blank row it always had.
   */
  turnMirror: 'desktop.chat.turnMirror',
  /**
   * The user answered an ask-the-user card. Params: `{ id, response }` where
   * `response` is the desktop's AskUserResponse — `{ kind: 'answered',
   * answers }` (one answer per question, in order) or `{ kind: 'canceled' }`.
   * Answers `{ ok }`: false when the id names no pending request, which is
   * how the phone learns a card it still shows was already resolved (turn
   * ended, or the tunnel dropped and the desktop failed it closed).
   */
  askRespond: 'desktop.chat.askRespond',
  /**
   * The user approved or denied a flagged tool call. Params:
   * `{ id, decision: 'approved' | 'denied' }`, answering `{ ok }` on the same
   * contract as askRespond. Fails closed everywhere: an unanswered request is
   * denied when its turn ends or the phone goes away.
   */
  approvalRespond: 'desktop.chat.approvalRespond',
  /**
   * Update the reflection schedule config. The body is a partial
   * ReflectionConfig-shaped patch ({ hour?, quietHours? }); the
   * answer is the desktop's complete post-write config. Callers render
   * the answer, never their own optimism — both screens can only ever show
   * what the desktop actually persisted.
   */
  setReflectionConfig: 'desktop.config.setReflection',
  /**
   * Start a reflection job immediately: { kind: 'reflection' | 'deepClean' }.
   * Answers { result: 'running' | 'queued' | 'coalesced' } — the same states
   * the desktop's own Run-now button gets from brainstem.
   */
  runReflection: 'desktop.reflection.run',
  /**
   * Projects — `brain/projects.json`, the store the desktop's Projects page
   * edits. Read AND written from the phone, through the very functions the
   * desktop's own IPC calls, so a mutation from either screen is one write
   * serialized by one mutation tail.
   *
   * `projectsList` answers `{ projects }` (newest-edited first, as the desktop
   * lists them). `projectCreate` takes `{ title, icon?, instructions?,
   * thinking? }`, `projectUpdate` a partial `{ id, title?, icon?,
   * instructions?, thinking?, files? }` — a `files` array is a whole-list
   * replace and the desktop deletes the copies it owns for anything dropped,
   * exactly as its own dialog does — and `projectDelete` takes `{ id }`. Each
   * answers the stored project (or `{ ok }` for the delete), never the phone's
   * optimism.
   *
   * `thinking` is the item's own reasoning effort and rides the same
   * create/update contract `mode` already has on procedures: absent ⇒ the item
   * follows the selected model's mode, present ⇒ the run uses it. Setting it
   * is how the phone's card switch and the desktop's card switch stay one
   * state seen from two places.
   */
  projectsList: 'desktop.projects.list',
  projectCreate: 'desktop.projects.create',
  projectUpdate: 'desktop.projects.update',
  projectDelete: 'desktop.projects.delete',
  /**
   * Procedures — `brain/procedures.json`, same contract as the projects trio
   * above: `{ procedures }`, then create/update/delete answering the stored
   * row. `projectId: ''` on an update unbinds, matching the desktop's setter.
   * `thinking` behaves as it does on projects.
   *
   * `files` and `directories` on an update are WHOLE-LIST replaces, honoured
   * only as real arrays: dropping a file DELETES the desktop's copy, so an
   * absent field must leave the list alone. Files can only be removed this way
   * (adding one uploads its bytes — see uploadBegin's `procedureId`), while a
   * directory is added by naming it: the desktop refuses a path that is not a
   * folder on ITS filesystem, with the reason.
   */
  proceduresList: 'desktop.procedures.list',
  procedureCreate: 'desktop.procedures.create',
  procedureUpdate: 'desktop.procedures.update',
  procedureDelete: 'desktop.procedures.delete',
  /**
   * Automations — `brain/brainstem/heartbeat.md`. Unlike the two stores above
   * this one is a MARKDOWN FILE the scheduler parses, so the phone edits it
   * the same way the desktop's cards editor does: read the whole file, splice
   * one block, write the whole file back. There is no per-automation write on
   * either side.
   *
   * `automationsRead` answers `{ markdown, jobs, stamps, runs }` — the file
   * verbatim, the scheduler's live view of the ACTIVE jobs (cron + next run,
   * which only the engine knows), the per-label edit stamps, and the run pool.
   * `automationsWrite` takes `{ markdown }` and persists through the same
   * atomic writer the desktop's markdown view uses, so the file watcher
   * reloads the scheduler for both screens. `automationRun` takes `{ label }`
   * and answers the brainstem's own `{ ok, started, error? }`.
   *
   * Each `AutomationJob` also carries its `thinking` — the job's own
   * `thinking:` marker, or null when it has none. It is the one marker the
   * phone cannot read off its own parse without duplicating the engine's
   * regex set, and it is what the card's switch renders.
   */
  /**
   * Validate a working-folder path against THIS machine. A phone cannot browse
   * the desktop's filesystem, so folders are added by naming them — and a path
   * that is not a folder over here is refused with the reason, which is the
   * screen's validation. Params `{ path }` → `{ path }` resolved absolute
   * (`~` expanded); rejects otherwise.
   *
   * Projects and procedures validate inside their own update call; automations
   * have none (heartbeat.md is the store), which is why this stands alone.
   */
  resolveDirectory: 'desktop.paths.resolveDirectory',
  automationsRead: 'desktop.automations.read',
  automationsWrite: 'desktop.automations.write',
  automationRun: 'desktop.automations.run',
  /** Everything the phone can do, advertised to the desktop agent. */
  deviceTools: 'device.tools',
  /** Live device state for the desktop's Mobile panel. */
  deviceStatus: 'device.status',
  /**
   * Workspace file transfer. Bytes ride ordinary RPC frames as base64url
   * strings so nothing new touches the transport: each read/chunk stays at or
   * under CHUNK_SIZE raw bytes, which lands well inside the relay's 1 MiB
   * record cap after base64 and encryption overhead.
   *
   * Download (desktop → phone): `fileStat` answers { exists, sizeBytes };
   * `fileRead` takes { path, offset, length } and answers { data, sizeBytes }
   * for the requested window. Paths are workspace-relative and validated on
   * the desktop — anything escaping the workspace root is an error.
   *
   * Upload (phone → desktop): `uploadBegin` takes { name, mimeType,
   * sizeBytes, conversationId? } and answers { uploadId, conversationId } —
   * creating the conversation when none is named, so a first message's file
   * has somewhere to land. `uploadChunk` appends { uploadId, offset, data };
   * `uploadCommit` finalizes and answers the stored attachment metadata
   * { type, filePath, originalName, mimeType, sizeBytes } with the path the
   * desktop actually chose (collisions rename, Finder-style).
   *
   * A `projectId` on `uploadBegin` retargets the same three frames at a
   * PROJECT's file list instead of a conversation: nothing is staged
   * differently, but the commit adopts the bytes into `uploads/project-<id>/`
   * and attaches the ref, so the answer additionally carries `{ project }` —
   * the stored project, which is what the phone renders. A `procedureId` does
   * the same for a PROCEDURE (`uploads/procedure-<id>/`, answer carries
   * `{ procedure }`). `automationFiles` — the `file:` paths the automation
   * already holds — targets an AUTOMATION: the desktop derives the folder from
   * them, adopts the bytes, and answers `{ path, name }` with the ABSOLUTE path
   * it chose, which the phone writes into heartbeat.md as a `file:` marker.
   * One upload path for every destination by construction:
   * the chunk ordering, the idle sweep and the size ceiling are the transfer's
   * business, not the destination's.
   */
  fileStat: 'desktop.files.stat',
  fileRead: 'desktop.files.read',
  uploadBegin: 'desktop.files.uploadBegin',
  uploadChunk: 'desktop.files.uploadChunk',
  uploadCommit: 'desktop.files.uploadCommit',
  /**
   * Collect one conversation's diagnostic bundle — the desktop's own
   * `diagnostics:export`, reached from the phone. Params `{ conversationId }`,
   * answers a `DiagnosticResult`: the same object the desktop's overlay
   * renders, with `relativePath` pointing at the archive under the workspace
   * (`diagnostics/<fileName>`), which the phone then pulls down the ordinary
   * `fileStat`/`fileRead` path and hands to the share sheet.
   *
   * It runs behind the SAME single-flight guard as the desktop's own button:
   * the collectors read the same log files, and a phone run racing a desktop
   * run would only fight over IO. A caller arriving while the same
   * conversation is being collected attaches to that run instead of being
   * refused. Progress arrives as `Event.diagnosticsProgress` while it works.
   */
  diagnosticsExport: 'desktop.diagnostics.export',
  /**
   * What the phone's overlay stack should show right now — an `OverlaySeed`.
   *
   * Taken once per connection, because both halves of it only ever arrive as
   * pushes: a phone that connects while a nightly reflection is halfway
   * through has already missed the only announcement it was going to get, and
   * would sit blank until the run ended. Nothing polls it afterwards; the
   * pushes are what keep it current.
   */
  overlaysRead: 'desktop.overlays.read',
  /**
   * The desktop's self-updater, driven from the phone. All three land on the
   * SAME registered handlers the desktop's own Updates panel and the CLI
   * invoke, so a check or install from the phone is the identical act —
   * guards, state machine and all.
   *
   * `updaterState` answers `{ state: UpdaterWireState | null }` — the live
   * phase machine, taken once per connection like the overlay seed (a phone
   * connecting mid-download has missed every announcement); `updater.state`
   * pushes keep it current after that. Null = this desktop cannot self-update.
   *
   * `updaterCheck` answers the desktop's own `{ ok, version }` — version null
   * means up to date, and with auto-download on, a found update starts
   * downloading immediately, reported by the pushes. A check during an active
   * download is the same safe no-op it is on the desktop.
   *
   * `updaterInstall` arms the restart, answering `{ ok }` BEFORE the desktop
   * begins shutting down — the reply has to leave on a tunnel the restart is
   * about to close. `ok: false` = nothing downloaded and verified yet. After
   * `ok: true` the phone watches the connection drop and re-form; the new
   * version arrives with the next config snapshot.
   */
  updaterState: 'desktop.updater.state',
  updaterCheck: 'desktop.updater.check',
  updaterInstall: 'desktop.updater.install',
  /**
   * Abort a pending turn-end countdown (the card's Abort button on the
   * phone). `{ ok }` — false once it already fired or was aborted.
   */
  countdownAbort: 'desktop.countdown.abort',
  /**
   * Managed processes — the desktop's process manager (main/processes), the
   * registry behind its Library → Processes tab and the `process_*` tools.
   * Read AND driven from the phone through the very functions the desktop's
   * own page calls, so a Stop pressed here and one pressed there are one
   * function.
   *
   * `processesList` answers `{ processes: SyncProcess[] }`. `processStart`
   * takes `{ name, command, cwd?, env?, port?, restart?, onQuit?, autostart? }`
   * and answers `{ ok, record?, error? }` once the process is ready (or the
   * readiness wait timed out — the record says which). `processStop` /
   * `processRestart` / `processRemove` take `{ name }`; `processStopAll` takes
   * nothing and answers `{ results: [{ name, stopped }] }`. `processUpdate`
   * takes `{ name }` plus any definition field (`command`, `cwd`, `env`,
   * `port`, `restart`, `onQuit`, `autostart`, `newName`) and answers
   * `{ ok, record?, error?, warning? }` — `autostart: "system"` installs an OS
   * login unit on the desktop and may be refused with the reason (a macOS
   * project under Desktop/Documents/Downloads). `processLogs` takes
   * `{ name, lines? }` and answers `{ text }`, the tail of the process log.
   * Every answer is the desktop's stored record, never the phone's optimism.
   */
  processesList: 'desktop.processes.list',
  processStart: 'desktop.processes.start',
  processStop: 'desktop.processes.stop',
  processStopAll: 'desktop.processes.stopAll',
  processRestart: 'desktop.processes.restart',
  processUpdate: 'desktop.processes.update',
  processRemove: 'desktop.processes.remove',
  processLogs: 'desktop.processes.logs'
} as const

/** Event topics pushed without a request. */
export const Event = {
  /** A conversation was created or its metadata changed. */
  conversationUpserted: 'conversation.upserted',
  /** A conversation was deleted on the desktop. */
  conversationDeleted: 'conversation.deleted',
  /** Streaming assistant output for an open conversation. */
  messageDelta: 'message.delta',
  /** A completed message (assistant, tool result, or user echo). */
  messageAppended: 'message.appended',
  /** Turn lifecycle: thinking / running a tool / done. */
  turnStatus: 'turn.status',
  /**
   * A mid-turn user message changed state — `{ conversationId, messageId,
   * channel, text, attachments, state: 'pending' | 'delivered' | 'withdrawn',
   * reason? }`. Its own event, not a turn status: a pending message is not
   * a turn boundary and must not reset the phone's live overlay.
   */
  interjection: 'interjection.status',
  /**
   * A conversation's plan-mode stance changed on any surface —
   * `{ conversationId, planMode }`. The phone mirrors it into its switch and
   * chip; the desktop chip does the same through its own IPC.
   */
  planMode: 'chat.planMode',
  /**
   * The agent is asking the user multiple-choice question(s) and the turn is
   * parked until they answer. Payload mirrors the desktop's own chat:askRequest
   * IPC — `{ conversationId, turnId, id, toolCallId, questions }` — so the
   * phone renders the same card from the same data, and answers with
   * `Rpc.askRespond`.
   */
  askRequest: 'ask.request',
  /**
   * A tool call the desktop flagged for approval, parked the same way.
   * Payload mirrors chat:approvalRequest — `{ conversationId, turnId, id,
   * toolCallId, tool, args, level, reason, description }` — and the phone
   * answers with `Rpc.approvalRespond`.
   */
  approvalRequest: 'approval.request',
  /** Any config section changed on the desktop. */
  configChanged: 'config.changed',
  /**
   * The variables array changed, whoever wrote it — payload carries the whole
   * array (`{ variables }`), so the phone renders it straight into its store
   * with no snapshot round trip. A debounced config.changed still follows for
   * everything that rebuilds from the full snapshot, and a phone that predates
   * this topic converges through that path alone.
   */
  variablesChanged: 'variables.changed',
  /** Usage counters moved. */
  usageChanged: 'usage.changed',
  /**
   * `brain/projects.json` changed, whoever wrote it — either screen's editor,
   * the agent's `project_*` tools, an autonomous run. Payload-free on purpose:
   * the phone re-lists, exactly as an open desktop Projects page re-fetches on
   * its own `projects:changed`. Projects also ride the config snapshot (they
   * are workspace state the chat's project picker reads), so a phone that
   * predates this topic still converges through the debounced config.changed
   * that the same write announces.
   */
  projectsChanged: 'projects.changed',
  /** `brain/procedures.json` changed — same contract as projectsChanged. */
  proceduresChanged: 'procedures.changed',
  /**
   * The scheduler reloaded, which is the one signal that means "heartbeat.md
   * changed" whatever wrote it: either screen's editor, the agent's
   * `automation_*` tools, a Once-job self-delete, an external edit. The phone
   * re-reads the file and the job list, exactly as the desktop's Automations
   * page does on `heartbeat:changed`.
   */
  automationsChanged: 'automations.changed',
  /**
   * The automation run pool moved: `{ running, queued }`, the brainstem's own
   * snapshot. Carries its payload because it fires several times per run and a
   * fetch per tick would be pure overhead — the phone renders it straight into
   * the Automations screen's play-button gating.
   *
   * Compaction, reflection and procedure runs ride this same pool: they are
   * brainstem jobs, not a separate system. `kind` on each row says which, and
   * the gating skips everything that is not an automation.
   */
  automationRunsChanged: 'automations.runs',
  /**
   * One step of a running diagnostic export — `{ conversationId, step, index,
   * total, files }`, the desktop's own `diagnostics:progress` payload verbatim,
   * so both overlays count the same steps in the same order. Pushed to the
   * phone only while a phone-initiated run is collecting; the answer to
   * `Rpc.diagnosticsExport` is what actually settles it, and a phone that
   * misses every tick still ends with a complete result.
   */
  diagnosticsProgress: 'diagnostics.progress',
  /**
   * The memory index is being rebuilt, or has finished — `{ status }`, either
   * a `ReindexStatus` or null when it is over.
   *
   * The desktop treats this as a blocking takeover (its chat screen is replaced
   * for the duration); the phone shows it as one more card in the overlay
   * stack, because a phone that cannot be used at all while an index rebuilds
   * is a phone that looks broken. Same state, less ceremony.
   *
   * Throttled on the desktop side: the underlying progress event fires once per
   * batch of files and every tick is one repaint of a single line.
   */
  reindexChanged: 'reindex.status',
  /**
   * The desktop's self-updater moved — checking, downloading (percent ticks),
   * verifying, ready, installing, error. Payload
   * `{ state: UpdaterWireState }`: the whole machine every time, exactly what
   * the desktop's own `updater:state` broadcast carries, so the phone renders
   * it straight and a missed tick costs nothing. In-memory on the phone and
   * cleared on disconnect; the next connection re-seeds via
   * `Rpc.updaterState`.
   */
  updaterChanged: 'updater.state',
  /**
   * A turn-end countdown changed state (`{ snapshot }`) — counting, fired,
   * aborted, failed. Its arming state rides the turn mirror like any other
   * segment; this push is for the transitions after the turn ended, which
   * no turn stream carries. The phone folds it into the matching
   * `countdown` segment by countdownId.
   */
  countdownChanged: 'countdown.changed',
  /**
   * The process registry changed — a start, a state transition, a stop, an
   * edit, a removal, whoever caused it (the model's tools, the desktop's
   * page, this phone, the supervisor). Payload-free on purpose: the phone
   * re-lists, exactly as the desktop's Processes tab re-fetches on its own
   * `processes:changed`.
   */
  processesChanged: 'processes.changed',
  /**
   * A process card in a conversation changed (`{ snapshot }`) — the card a
   * `process_show` opened, re-rendered with the processes' current state
   * after its turn ended. The phone folds it into the matching `process`
   * segment by cardId, the countdown contract.
   */
  processCardChanged: 'process.card',
  /**
   * The conversation's in-app browser changed (`{ snapshot }`) — a page
   * loaded, the active tab switched, a still frame landed. The phone folds
   * it into the conversation's `browser` segment (one per conversation).
   */
  browserChanged: 'browser.changed'
} as const

export type RpcMethod = (typeof Rpc)[keyof typeof Rpc]
export type EventTopic = (typeof Event)[keyof typeof Event]

/** What the QR encodes. Base64url JSON behind a `wolffish-pair:v1:` prefix. */
export type PairingPayload = {
  v: number
  /** Relay URL, so a self-hosted relay travels with the pairing. */
  relay: string
  /** Desktop's static public key, hex. Absent for code pairing (XX learns it). */
  pk?: string
  /** Pairing secret, base64url. */
  ps: string
}

export const PAIRING_PREFIX = 'wolffish-pair:v1:'

/** Conversation metadata — the only conversation data synced up front. */
export type ConversationMeta = {
  id: string
  title: string
  model: string | null
  channel: string | null
  icon: string | null
  projectId: string | null
  sealed: boolean
  createdAt: number
  updatedAt: number
  messageCount: number
  /** Serialized desktop stats blob; mobile renders it verbatim. */
  stats: unknown | null
  summary: string | null
}

/** One message as the phone stores it. */
export type SyncMessage = {
  id: string
  role: string
  content: string
  timestamp: number
  /** Attachments, tool payloads, segments — opaque to the transport. */
  payload?: unknown
}

/**
 * One attached project file. `path` is workspace-relative on the wire — the
 * desktop stores an absolute path, but an absolute one is meaningless on a
 * phone and would leak the home directory for nothing. The phone resolves it
 * through the same file cache conversation attachments use, so a project file
 * downloads and opens exactly like one on a message.
 */
export type SyncProjectFile = { path: string; name: string }

/**
 * The canonical reasoning scale, on the wire.
 *
 * Declared here rather than imported from `@main/runtime/reasoning` because
 * protocol.ts has NO imports — it is the one file that must stay
 * byte-identical between the desktop and the phone, and the phone cannot reach
 * into the desktop's main process. The desktop's own ReasoningMode is
 * structurally identical; the two must be changed together.
 *
 * A model may honour fewer modes than this list (some have no distinct max,
 * some only off/on). The wire carries the item's STAMP, which is always one of
 * these four canonical tokens; the phone renders whichever subset the selected
 * model supports, exactly as the desktop's card does.
 */
export type ReasoningMode = 'off' | 'on' | 'high' | 'max'
export const REASONING_MODES: readonly ReasoningMode[] = ['off', 'on', 'high', 'max']

/**
 * The diagnostic export, on the wire — the desktop's own DiagnosticStep,
 * DiagnosticProgress and DiagnosticResult (src/main/diagnostics.ts) verbatim,
 * so both overlays render one shape and neither has to translate.
 *
 * The step list is the ORDER as well as the vocabulary: the progress bar is
 * `index / total` over it, and a phone whose desktop is newer must not divide
 * by its own idea of the total — which is why `total` travels on every tick
 * rather than being counted here.
 */
export const DIAGNOSTIC_STEPS = [
  'conversation',
  'logs',
  'tasks',
  'memory',
  'context',
  'settings',
  'attachments',
  'opinion',
  'archive'
] as const

export type DiagnosticStep = (typeof DIAGNOSTIC_STEPS)[number]

export type DiagnosticProgress = {
  conversationId: string
  step: DiagnosticStep
  /** 1-based position of `step` in DIAGNOSTIC_STEPS. */
  index: number
  total: number
  /** Files gathered so far — the count shown next to the bar. */
  files: number
}

/** Why the model opinion isn't in the bundle (absent when it is). */
export type OpinionSkipReason = 'no-model' | 'local-only' | 'failed' | 'empty'

export type DiagnosticGroup = { key: string; count: number }

export type DiagnosticResult = {
  ok: boolean
  error?: string
  conversationId: string
  conversationTitle: string
  /** Archive basename, e.g. `wolffish-diagnostics-2026-07-25_00-16-04.zip`. */
  fileName: string
  /** Absolute path on the DESKTOP. Meaningless to the phone; it downloads
   *  `relativePath` instead. */
  zipPath: string
  /** Path relative to the workspace root — `diagnostics/<fileName>`. */
  relativePath: string
  sizeBytes: number
  fileCount: number
  durationMs: number
  /** True when a model wrote an opinion into the bundle. */
  modelOpinion: boolean
  opinionSkipped?: OpinionSkipReason
  groups: DiagnosticGroup[]
  warnings: string[]
}

/**
 * A managed process — the desktop's ProcessRecord (main/processes/types.ts)
 * on the wire, field for field. A DEFINITION (name, command, cwd, policies)
 * plus its current or last RUN (pid, port, URL, state, exit). Names are
 * slugs unique per workspace; `run.state` is `stopped | starting | running |
 * stopping | exited | crashed`. Read tolerantly: a desktop older than a field
 * simply does not send it.
 */
/** How a managed process gets its port — the Wolffish band, an exact port, or none. */
export type SyncProcessPort =
  /** A free port from the Wolffish band (20000-20999), filled into `{port}`. */
  | { mode: 'wolffish' }
  /** This exact port; `takeover` stops whatever holds it first (confirmed on the desktop). */
  | { mode: 'fixed'; port: number; takeover?: boolean }
  | { mode: 'none' }

export type SyncProcess = {
  id: string
  name: string
  command: string
  cwd: string
  env: Record<string, string>
  port: SyncProcessPort
  ready: { port?: boolean; logMatch?: string; timeoutMs?: number }
  restart: 'never' | 'on-failure' | 'always'
  onQuit: 'keep' | 'stop'
  autostart: 'off' | 'wolffish' | 'system'
  origin: { conversationId: string | null; kind: 'started' | 'shell' | 'adopted' }
  createdAt: number
  updatedAt: number
  run: {
    pid: number | null
    signature: string
    osStart: string | null
    port: number | null
    url: string | null
    state: 'stopped' | 'starting' | 'running' | 'stopping' | 'exited' | 'crashed'
    exitCode: number | null
    exitSignal: string | null
    startedAt: number | null
    readyAt: number | null
    endedAt: number | null
    restarts: number
    logPath: string | null
    unit: string | null
    adoptedAt: number | null
    lastError: string | null
  }
}

/**
 * A process card in a conversation (the desktop's ProcessCardSnapshot): the
 * processes a `process_show` chose to show, replaced whole by cardId on every
 * change. `names: null` follows every managed process.
 */
export type SyncProcessCard = {
  cardId: string
  conversationId: string | null
  turnId: string | null
  title: string | null
  names: string[] | null
  processes: SyncProcess[]
  createdAt: number
  updatedAt: number
}

/** A project — the desktop's Project (main/projects.ts) on the wire. */
export type SyncProject = {
  id: string
  title: string
  /** Emoji icon, native emoji set. */
  icon: string
  instructions: string
  files: SyncProjectFile[]
  /**
   * Working folders every turn inside the project gets a fresh listing of.
   * ABSOLUTE desktop paths, shown verbatim on the phone — a folder named
   * "reports" means nothing without knowing which "reports" on that machine it
   * is. An added one is checked against the desktop's own filesystem first.
   */
  directories: string[]
  /**
   * The project's own reasoning effort — what every turn inside it runs at.
   * Null ⇒ follows the selected model's thinking mode. Omitted by a desktop
   * older than this field; the phone normalizes it to null.
   */
  thinking: ReasoningMode | null
  createdAt: number
  updatedAt: number
}

/** A procedure — the desktop's Procedure (main/procedures.ts) on the wire. */
export type SyncProcedure = {
  id: string
  title: string
  prompt: string
  /** Null ⇒ the row follows the workspace's global chat mode. */
  mode: 'single' | 'workflow' | null
  /**
   * The procedure's own reasoning effort. Null ⇒ the row follows the model's
   * thinking mode — the same live-fallback contract as `mode`. Omitted by a
   * desktop older than this field, which the phone normalizes to null.
   */
  thinking: ReasoningMode | null
  /** Always present on the wire; the desktop defaults it at creation. */
  icon: string
  /** Null ⇒ unbound. */
  projectId: string | null
  /**
   * Reference files every run of this procedure is told about (name, size,
   * path) and reads with its own tools — content is never injected. Paths are
   * WORKSPACE-RELATIVE for the copies the desktop owns, exactly like a
   * project's, which is what lets a removal round-trip: the phone sends the
   * list back and the desktop maps each path to the ref it actually holds.
   */
  files: SyncProjectFile[]
  /**
   * Working folders every run gets a fresh listing of. ABSOLUTE desktop paths,
   * shown verbatim on the phone — a folder named "reports" means nothing
   * without knowing which "reports" on that machine it is. An added one is
   * checked against the desktop's own filesystem before it is stored.
   */
  directories: string[]
  createdAt: number
  updatedAt: number
}

/**
 * One ACTIVE automation as the scheduler sees it. Deliberately only what the
 * engine uniquely owns: `cron` (compiled from the heading) and `nextRunMs`.
 * Everything else a card shows — label, body, mode/project/icon markers,
 * whether it is switched off at all — is parsed from the markdown on the
 * rendering side, because a disabled automation never reaches the scheduler
 * and would otherwise have no card.
 */
export type AutomationJob = {
  id: string
  label: string
  type: string
  cron: string | null
  nextRunMs: number | null
  mode: 'single' | 'workflow' | null
  /** The job's own reasoning effort; null ⇒ follows the model's mode. */
  thinking: ReasoningMode | null
}

/**
 * Which family a run belongs to. Resolved on the DESKTOP from the brainstem's
 * job id, so the phone never parses ids to decide what it is looking at — the
 * built-in jobs are `compaction-daily`, `reflection-nightly` and friends,
 * procedure runs are `procedure:<id>`, and that naming is the scheduler's
 * business, not the wire's.
 *
 * Every family rides the wire. Consumers that mean *automations* specifically
 * (the Automations screen's per-job status) must skip `procedure` rather than
 * assume every row is a heading in heartbeat.md.
 */
export const RUN_KINDS = ['automation', 'compaction', 'reflection', 'procedure'] as const
export type RunKind = (typeof RUN_KINDS)[number]

/** One in-flight run — what the Automations screen's play-button gating reads. */
export type AutomationRun = {
  id: string
  label: string
  kind: RunKind
}

export type AutomationQueuedRun = {
  id: string
  label: string
  kind: RunKind
}

/**
 * The brainstem's run pool: in-flight runs plus the FIFO overflow. The phone
 * normalizes every row rather than trusting the shape (an older desktop may
 * send rows without `kind`).
 */
export type AutomationRuns = {
  running: AutomationRun[]
  queued: AutomationQueuedRun[]
}

/**
 * The memory index being rebuilt from scratch — the desktop's own
 * `reindex:getStatus` on the wire, verbatim.
 *
 * `total` is the file count the rebuild started with and `done` is how far it
 * has got, so the bar is `done / total`. The desktop counts these itself and
 * they travel together on every tick: a phone must never divide by its own idea
 * of the total.
 */
export type ReindexStatus = {
  startedAt: number
  done: number
  total: number
}

/**
 * What the phone's reindex overlay shows, in one answer.
 *
 * It exists because the reindex is PUSH-shaped: no screen fetches it, so a
 * phone that connects while a rebuild is halfway through would otherwise show
 * nothing until it ended. This is the seed that push traffic then keeps
 * current, taken once per connection.
 */
export type OverlaySeed = {
  reindex: ReindexStatus | null
}

/**
 * The desktop updater's phase machine on the wire — main/updater.ts
 * UpdaterState minus `releaseNotes`, which is deliberately left home: state
 * is pushed on every download-percent tick, and the notes' markdown riding a
 * hundred times per update would buy nothing the phone shows.
 *
 * The phase vocabulary is the desktop's own, exported as a list (the
 * RUN_KINDS pattern) so the phone validates against it rather than
 * keeping a copy. A phone reading a phase it does not know treats the
 * machine as 'idle' rather than guessing — an older app against a newer
 * desktop degrades to "no live card", never to a wrong one.
 */
export const UPDATER_PHASES = [
  'idle',
  'checking',
  'downloading',
  'verifying',
  'ready',
  'installing',
  'error'
] as const

export type UpdaterWirePhase = (typeof UPDATER_PHASES)[number]

/**
 * Coarse failure category + sanitized detail — the desktop's UpdaterErrorInfo
 * verbatim. `code` is one of its UpdaterErrorCode values; renderers translate
 * by code and fall back to `message` for one they do not know.
 */
export type UpdaterWireError = {
  code: string
  message: string
  detail: string | null
}

export type UpdaterWireState = {
  phase: UpdaterWirePhase
  /** The version being fetched or installed; null outside an update cycle. */
  version: string | null
  /** Download progress 0–100, meaningful in the downloading phase. */
  percent: number
  /** Set in the error phase (and recorded, but not rendered, outside it). */
  error: UpdaterWireError | null
}

// ---------------------------------------------------------------------------
// Push-notification control plane (relay-terminated; mirrored in the relay's
// own protocol.ts)
// ---------------------------------------------------------------------------
//
// These frames ride CONTROL records and are the one part of the wire the
// relay reads on purpose: the phone registers its Expo push token by a stable
// phoneId, the desktop asks for a notification to reach the phone, and the
// relay decides the route — the live tunnel first, Expo push as the fallback.
// Notifications are 100% model-initiated on the desktop; the desktop stamps
// notificationId and phoneId itself (never the model), and the phone dedupes
// by notificationId because both routes can legitimately fire.

export const PUSH_WIRE_VERSION = 1

export const NOTIFY_PHASES = ['started', 'needs_input', 'failed', 'completed', 'info'] as const
export type NotifyPhase = (typeof NOTIFY_PHASES)[number]

export const NOTIFY_URGENCIES = ['normal', 'high'] as const
export type NotifyUrgency = (typeof NOTIFY_URGENCIES)[number]

export type PushPlatform = 'ios' | 'android'

export const NOTIFY_TITLE_MAX = 60
// No body ceiling. The banner is read at a glance, but the phone keeps its own
// log and renders the body whole on its notifications page — a cap here cut
// text the user could then read nowhere at all. Only presence is validated.
export const NOTIFY_TTL_MIN = 60
export const NOTIFY_TTL_MAX = 86_400

/** Android notification channel; the phone creates it, the relay names it. */
export const ANDROID_CHANNEL_ID = 'agent-runs'

/** Deep links must stay inside the app's own scheme. */
export const DEEPLINK_SCHEME = 'wolffish://'

export function isAllowedDeeplink(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 512 &&
    value.startsWith(DEEPLINK_SCHEME) &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1f\x7f\s]/.test(value)
  )
}

/**
 * Every screen a notification tap can land on, spelled exactly as the mobile
 * app's router knows it (the expo-router file routes under mobile src/app).
 *
 * This list IS the contract, and both ends hold it: the desktop refuses a
 * deeplink naming anything else — so the model is corrected inside the call
 * that got it wrong, instead of sending someone to a screen that does not
 * exist — and the phone ignores one it cannot resolve, which is what keeps an
 * older app safe against a newer desktop. `chat` is the only route that takes
 * a parameter (`?id=<conversationId>`); without one it opens a new chat.
 *
 * Deliberately absent: `/` (the pairing door, which a paired phone bounces off
 * anyway) and `/showcase` (a component gallery, not a destination).
 */
export const DEEPLINK_ROUTES = [
  'chat',
  'history',
  'settings',
  'settings/model',
  'settings/appearance',
  'settings/preferences',
  'settings/projects',
  'settings/automations',
  'settings/procedures',
  'settings/processes',
  'settings/customization',
  'settings/channels',
  'settings/capabilities',
  'settings/knowledge',
  'settings/mcp',
  'settings/services',
  'settings/variables',
  'settings/usage',
  'settings/data',
  'settings/updates',
  'settings/relay',
  'settings/changelog'
] as const

export type DeeplinkRoute = (typeof DEEPLINK_ROUTES)[number]

/** A deeplink resolved to a screen this build actually has. */
export type DeeplinkTarget = {
  route: DeeplinkRoute
  /** Only ever set for `chat` — the conversation the tap opens. */
  conversationId: string | null
}

/** Conversation ids ARE filenames on the desktop (see conversations.ts), so
 *  this is that same safe set — and a title, a sentence or a URL fails it. */
const CONVERSATION_ID_SHAPE = /^[A-Za-z0-9._-]{1,128}$/

/**
 * Resolve a `wolffish://…` link to a screen, or null when it names one this
 * build does not have.
 *
 * Tolerant where tolerance is harmless — extra slashes (`wolffish:///chat`), a
 * trailing slash, unknown query parameters — and strict about the only two
 * things that decide where a tap lands: the route and the conversation id.
 */
export function parseDeeplink(value: unknown): DeeplinkTarget | null {
  if (!isAllowedDeeplink(value)) return null
  const withoutScheme = value.slice(DEEPLINK_SCHEME.length)
  const queryAt = withoutScheme.indexOf('?')
  const rawRoute = queryAt === -1 ? withoutScheme : withoutScheme.slice(0, queryAt)
  const query = queryAt === -1 ? '' : withoutScheme.slice(queryAt + 1)
  const route = rawRoute.replace(/^\/+/, '').replace(/\/+$/, '')
  if (!(DEEPLINK_ROUTES as readonly string[]).includes(route)) return null
  if (route !== 'chat') return { route: route as DeeplinkRoute, conversationId: null }
  const conversationId = readQueryParam(query, 'id')
  if (conversationId !== null && !CONVERSATION_ID_SHAPE.test(conversationId)) return null
  return { route: 'chat', conversationId }
}

/** The canonical link for a target — the one shape the desktop ever sends,
 *  so a phone parsing it naively still lands in the right place. */
export function buildDeeplink(target: DeeplinkTarget): string {
  const query =
    target.route === 'chat' && target.conversationId ? `?id=${target.conversationId}` : ''
  return `${DEEPLINK_SCHEME}${target.route}${query}`
}

function readQueryParam(query: string, name: string): string | null {
  for (const pair of query.split('&')) {
    if (!pair) continue
    const equals = pair.indexOf('=')
    if ((equals === -1 ? pair : pair.slice(0, equals)) !== name) continue
    const raw = equals === -1 ? '' : pair.slice(equals + 1)
    try {
      return decodeURIComponent(raw) || null
    } catch {
      return null
    }
  }
  return null
}

/** Phone → relay, on pairing and on every app foreground. */
export type RegisterPushFrame = {
  v: 1
  type: 'register_push'
  /** Stable per-device id minted by the phone — never the rendezvous or
   *  session id (both ephemeral), and never derived from the identity key. */
  phoneId: string
  /** Null when notification permission was denied — in-band only then. */
  expoPushToken: string | null
  platform: PushPlatform
  appVersion?: string | null
}

/** Desktop → relay, when the model calls the notify tool. */
export type NotifyFrame = {
  v: 1
  type: 'notify'
  /** ULID, generated by the desktop — never by the model. */
  notificationId: string
  /** From the desktop's pairing record — never from the model. */
  phoneId: string
  runId: string
  phase: NotifyPhase
  title: string
  body: string
  urgency: NotifyUrgency
  deeplink: string | null
  /**
   * The conversation this notification came OUT of — the run's own, stamped
   * by the desktop from the same turn scope `runId` comes from and never
   * taken from the model. Null only when the run has no conversation yet.
   *
   * NOT the same question as `deeplink`, which is where a TAP goes and is the
   * model's choice (it may be absent entirely, or point at another screen).
   * The phone badges the conversation a notification came out of; inferring
   * that from the deeplink meant a notify_phone call with no deeplink — which
   * the tool deliberately allows — badged nothing at all, so a conversation
   * that had raised five notifications wore a 2.
   */
  conversationId: string | null
  /** Seconds. */
  ttl: number
  /** Unix ms at the desktop. */
  ts: number
}

/** Relay → phone, in-band delivery: the notify frame under another type. */
export type NotificationFrame = Omit<NotifyFrame, 'type'> & { type: 'notification' }

/** Phone → relay: the in-band delivery arrived and was rendered. */
export type NotificationAckFrame = { v: 1; type: 'notification_ack'; notificationId: string }

/**
 * Phone → relay: the phone's current unread notification count, absolute.
 * The relay keeps one integer per device, incremented per delivered notify
 * and stamped as `badge` onto Expo pushes so the app icon counts while the
 * app is dead; this frame overwrites it whenever the phone's own state
 * changes. The desktop never sends or receives it — mirrored here so the
 * three protocol files carry the same control-plane contract.
 */
export type SetBadgeFrame = { v: 1; type: 'set_badge'; phoneId: string; count: number }

/**
 * Phone → relay, on unpairing: forget the device entirely — token, platform,
 * badge count. The relay then answers every later notify for that phoneId
 * with `dropped` instead of claiming delivery to a phone that wiped its copy
 * of everything the notification would describe. The desktop never sends or
 * receives it — mirrored here so the three protocol files carry the same
 * control-plane contract.
 */
export type UnregisterPushFrame = { v: 1; type: 'unregister_push'; phoneId: string }

/** Relay → desktop: how the notify was routed, answered immediately. */
export type NotifyResultFrame = {
  v: 1
  type: 'notify_result'
  /** Null only when the frame was too malformed to carry an id. */
  notificationId: string | null
  route: 'inband' | 'push' | 'dropped'
  /** Present when dropped (and on validation rejects). */
  reason?: string
}

/**
 * An incoming in-band notification, reduced to the fields this build
 * understands — tolerant reads, because a newer desktop/relay may add fields
 * (or phases) this app version predates. Unknown fields are ignored, an
 * unknown phase or urgency degrades to its default, and only a frame with no
 * usable id/title/body is rejected outright (null).
 */
export function parseNotification(raw: Record<string, unknown>): NotificationFrame | null {
  if (raw.v !== PUSH_WIRE_VERSION || raw.type !== 'notification') return null
  const notificationId = raw.notificationId
  if (typeof notificationId !== 'string' || !notificationId || notificationId.length > 64) {
    return null
  }
  const title = raw.title
  const body = raw.body
  if (typeof title !== 'string' || !title || title.length > NOTIFY_TITLE_MAX) return null
  if (typeof body !== 'string' || !body) return null
  const ttlRaw = typeof raw.ttl === 'number' && Number.isFinite(raw.ttl) ? raw.ttl : NOTIFY_TTL_MIN
  return {
    v: 1,
    type: 'notification',
    notificationId,
    phoneId: typeof raw.phoneId === 'string' ? raw.phoneId : '',
    runId: typeof raw.runId === 'string' ? raw.runId : '',
    phase: NOTIFY_PHASES.includes(raw.phase as NotifyPhase) ? (raw.phase as NotifyPhase) : 'info',
    title,
    body,
    urgency: NOTIFY_URGENCIES.includes(raw.urgency as NotifyUrgency)
      ? (raw.urgency as NotifyUrgency)
      : 'normal',
    deeplink: isAllowedDeeplink(raw.deeplink) ? raw.deeplink : null,
    // Absent from anything older than the frame that introduced it, and the
    // phone falls back to reading the deeplink — which is what it always did.
    conversationId:
      typeof raw.conversationId === 'string' && CONVERSATION_ID_SHAPE.test(raw.conversationId)
        ? raw.conversationId
        : null,
    ttl: Math.min(NOTIFY_TTL_MAX, Math.max(NOTIFY_TTL_MIN, Math.round(ttlRaw))),
    ts: typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? raw.ts : Date.now()
  }
}
