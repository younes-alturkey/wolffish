import type { Amygdala, DangerLevel, DangerPattern } from '@main/runtime/amygdala'
import type { ChannelStatusSnapshot } from '@main/channels/status'
import { diskWriter } from '@main/io/diskWriter'
import { turnScope, type Corpus } from '@main/runtime/corpus'
import { SnapshotStore } from '@main/runtime/snapshots'
import type {
  ArtifactHit,
  ConversationSummary,
  RecordHit,
  RecordRow,
  UsageSummary
} from '@main/runtime/cortex'
import type { RecordSource } from '@main/runtime/cortexIngest'
import type {
  McpAddInput,
  McpAddResult,
  McpServerSnapshot,
  McpTestResult
} from '@main/runtime/mcp/types'
import type { WorkflowEffort, WorkflowWaitOutcome } from '@main/runtime/workflow'
import type {
  CountdownSnapshot,
  TaskSnapshot,
  ToolResultStatus,
  WorkflowAgentView
} from '@main/runtime/broca'
import type { CountdownArmInput, CountdownArmResult } from '@main/runtime/countdown'
import type { WaitStartInput, WaitStartResult } from '@main/runtime/wait'
import type { VideoSubmitInput, VideoSubmitResult } from '@main/runtime/video-tasks'
import { sudoSession, type SudoSession } from '@main/runtime/sudoSession'
import type { ToolDefinition } from '@main/runtime/thalamus'
import type { ToolCall } from '@main/runtime/wernicke'
import yaml from 'js-yaml'
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Cerebellum loads skills (markdown procedures) and plugins (tool
 * providers) from the workspace.
 *
 * Maps to: the cerebellum — the dense knot at the back of the brain that
 * stores learned procedures and motor patterns. Riding a bike, signing
 * your name, the perfectly-cadenced apology you've given a hundred times:
 * those routines live in the cerebellum. You don't have to think about
 * them; you just run them.
 *
 * In Wolffish, each capability is a folder under brain/cerebellum/ with
 * a SKILL.md (frontmatter + body) and an optional plugin/index.mjs. The
 * cerebellum scans the folder at startup, parses each SKILL.md, registers
 * danger and confirm patterns with amygdala, and dynamic-imports any
 * plugin code so its tools become callable.
 */

export type ToolParameterSpec = {
  type?: string
  description?: string
  enum?: string[]
  required?: boolean
  /**
   * JSON Schema for array items / object shape, passed through verbatim to
   * the model-facing schema. Lets a frontmatter param declare a precise
   * nested structure (e.g. an array of `{ label, description }` objects)
   * instead of an opaque `type: array`. Some strict providers also reject an
   * array param that has no `items`.
   */
  items?: Record<string, unknown>
  properties?: Record<string, unknown>
  /**
   * Complete JSON Schema for this parameter, used verbatim as the
   * property schema (only `required` is still read from the spec).
   * For tool sources that already speak JSON Schema — MCP servers —
   * so unions, formats, defaults and nested required arrays survive
   * without a lossy round-trip through the simplified fields above.
   */
  raw?: Record<string, unknown>
}

export type SkillTrigger = {
  keywords: string[]
}

export type SkillToolDescriptor = {
  name: string
  description: string
  parameters: Record<string, ToolParameterSpec>
  /**
   * Declares that the tool observes without changing anything outside the
   * conversation (reads, searches, lookups). Two consumers: the agent loop
   * runs consecutive read-only calls concurrently, and a read-only turn
   * (plan mode) refuses every tool that is NOT flagged. Absent means
   * mutating — nothing is accidentally allowed.
   */
  readOnly?: boolean
}

export type ConfirmPattern = {
  match: RegExp
  reason: string
}

export type SkillFrontmatter = {
  name: string
  description: string
  triggers?: string[]
  tools?: SkillToolDescriptor[]
  danger_patterns?: Array<{ pattern: string; level: DangerLevel; reason: string; args?: string[] }>
  confirm_patterns?: Array<{ pattern: string; reason: string; args?: string[] }>
  requires?: string[]
  packages?: Record<string, string>
  /**
   * Who authored this capability. `skill_create` stamps "wolffish" here so
   * self-authored skills are distinguishable from bundled (official) and
   * hand-imported (unknown) ones — the settings panel shows a Wolffish badge
   * and the tested-state tracking below applies only to these.
   */
  author?: string
}

/** The `author` value skill_create stamps into self-authored skills. */
export const WOLFFISH_AUTHOR = 'wolffish'

/**
 * Marker recording that a Wolffish-authored capability passed a real tool
 * call. Lives in the capability folder, holds a hash of SKILL.md + the plugin
 * entry file at the moment the call succeeded — so editing either file
 * invalidates it and the skill drops back to "untested" until it passes again.
 */
const TESTED_MARKER_FILE = '.wolffish-tested'

export type CapabilityStatus = 'ok' | 'error'

export type Capability = {
  name: string
  dir: string
  description: string
  triggers: SkillTrigger
  tools: SkillToolDescriptor[]
  body: string
  hasPlugin: boolean
  status: CapabilityStatus
  error?: string
  requires: string[]
  packages: Record<string, string>
  /**
   * npm package dependencies parsed from the capability's own package.json
   * (next to SKILL.md). Empty if no package.json or no deps. Installed
   * lazily into <capability>/node_modules on first tool use, then cached
   * for the rest of the session.
   */
  npmDependencies: Record<string, string>
  /**
   * Path to the plugin entry file (index.mjs/.js/.cjs). Set when
   * hasPlugin is true. The plugin itself is imported lazily on first use,
   * AFTER npm deps are installed — that way plugins can use static imports
   * for their npm deps without crashing startup when deps aren't installed
   * yet.
   */
  pluginEntryPath?: string
  /**
   * True when this capability was registered via
   * registerInProcessCapability rather than discovered on disk under
   * brain/cerebellum/. Built-in channels (Telegram) use this so the
   * LLM still sees their tools but the Cerebellum settings panel can
   * hide them — they're core features, not external plugins.
   */
  inProcess?: boolean
  /** Frontmatter `author` — "wolffish" for self-authored skills. */
  author?: string
  /**
   * Tested state, tracked ONLY for Wolffish-authored plugin capabilities:
   * `false` until a tool of this capability succeeds for real (then the
   * marker is stamped and this flips to `true`); editing SKILL.md or the
   * plugin entry invalidates the marker on the next reload. `undefined` for
   * everything else — bundled, hand-imported, in-process, and pure skills,
   * where the concept doesn't apply.
   */
  tested?: boolean
}

export type ToolResultImage = {
  mediaType: string
  data: string
}

export type ToolExecutionResult = {
  success: boolean
  output?: string
  error?: string
  images?: ToolResultImage[]
  exitCode?: number | null
  partial?: boolean
  /**
   * `false` when this failure must never be auto-retried. Motor's classifier
   * guesses retryability from the error TEXT; this is the tool stating the
   * fact, and it wins over the guess.
   *
   * The case it exists for is not "the retry would fail again" — it is "the
   * retry would SUCCEED, twice". A tool whose side effect leaves the machine
   * (a notification, a message, a payment) cannot report the difference
   * between "not delivered" and "delivered, but the confirmation was lost",
   * so a failure it returns is at best *unknown*. Re-firing it on that
   * unknown is how one notification became three on the user's phone.
   * At-most-once beats at-least-once for anything the user can see.
   */
  retryable?: boolean
  /**
   * UI-only structured facts about the result — a unified diff for a file
   * change, a shell exit code and duration, the spill path of a truncated
   * output. Passed through untouched to the tool_result segment's `meta`
   * (see broca's ToolResultMeta); never replayed into model context.
   */
  meta?: Record<string, unknown>
}

export type RiskLevel = 'low' | 'medium' | 'high'

/**
 * Human-readable description of a tool action, surfaced on the approval
 * card so the user can make an informed decision instead of staring at
 * raw JSON args.
 */
export type ApprovalDescription = {
  title: string
  description: string
  command?: string
  impact?: string
  risk: RiskLevel
  /**
   * The rule "Allow for this conversation" grants when the user approves
   * THIS card, when the tool name is the wrong unit of consent. Computer use
   * sets it to the application it resolved the action to
   * (`computer-use@Safari`): one approval then covers every screen action
   * into that app for the rest of the conversation, and a new app asks
   * again. Absent, the rule is derived from the call (see sessionAllowRule).
   */
  scope?: string
}

/** The single tool the `ask` capability exposes. */
export const ASK_USER_TOOL = 'ask_user'

/** The single tool the `options` capability exposes. */
export const OFFER_OPTIONS_TOOL = 'offer_options'

/** One alternative on an offer_options card. */
export type OfferedOption = {
  /** Short tab label (2–4 words). */
  title: string
  /** Optional one-line note under the title — the trade-off this option makes. */
  description?: string
  /** Language id when `content` is raw code; absent means the content is markdown. */
  language?: string
  /** The body, copied verbatim when the user hits copy. */
  content: string
}

/**
 * The tab letter for position i: A…Z, then AA, AB … — the spreadsheet column
 * scheme. Every renderer (desktop, mobile, CLI, the text channels, the PDF
 * export) mirrors this, so the letter the model names in its reply is the
 * letter the user sees.
 */
export function optionLetter(index: number): string {
  let n = index
  let out = ''
  do {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

/**
 * Recover an offer_options card from its persisted tool_call args. Kept as
 * tolerant as the plugin's own normalizer — the same synonyms it accepts (a
 * bare string option, `label`/`code`/`text`/`value`) must survive here, or a
 * card the user saw in the app would render empty on a channel.
 */
export function parseOfferedOptions(args: Record<string, unknown> | undefined): OfferedOption[] {
  const raw = Array.isArray(args?.options) ? args.options : []
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  const out: OfferedOption[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const content = item.trim()
      if (content) out.push({ title: `Option ${optionLetter(out.length)}`, content })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const content = str(r.content) || str(r.code) || str(r.text) || str(r.value)
    if (!content) continue
    const title = str(r.title) || str(r.label)
    const description = str(r.description)
    const language = str(r.language) || str(r.lang)
    out.push({
      title: title || `Option ${optionLetter(out.length)}`,
      ...(description ? { description } : {}),
      ...(language ? { language } : {}),
      content
    })
  }
  return out
}

/** One selectable choice on an ask-the-user question card. */
export type AskUserOption = {
  /** The choice shown to the user (e.g. "Use PostgreSQL"). */
  label: string
  /** Optional one-line explanation rendered under the label. */
  description?: string
}

/** One question on an ask-the-user card. A card carries 1..N of these. */
export type AskUserQuestion = {
  question: string
  details?: string
  options: AskUserOption[]
  /** Show the free-text "something else" escape hatch (default true). */
  allowOther: boolean
  /** Override the default label/description of the free-text option. */
  otherLabel?: string
  otherDescription?: string
}

/**
 * What a plugin hands `context.askUser` to pose questions to the user.
 * Built by the `ask` capability from the model's tool args; the toolCallId
 * is injected by Cerebellum so the renderer can anchor the question card to
 * the right tool_call segment. A single-question ask is a one-item list —
 * the renderer shows numbered tabs only when there's more than one.
 */
export type AskUserRequestInput = {
  questions: AskUserQuestion[]
}

export type AskUserRequest = AskUserRequestInput & { toolCallId: string }

/**
 * The user's answer to ONE question: `option` = they picked listed choice N
 * (0-based); `custom` = they wrote their own instructions in the free-text
 * field.
 */
export type AskUserAnswer = { kind: 'option'; index: number } | { kind: 'custom'; text: string }

/**
 * The user's response to a whole ask-the-user request. `answered` carries
 * one answer per question, same order (`answers[i]` answers `questions[i]`
 * — the card only submits once every question is answered); `canceled` =
 * the request was dismissed (run stopped / window closed); `unsupported` =
 * the active channel can't pose questions.
 */
export type AskUserResponse =
  | { kind: 'answered'; answers: AskUserAnswer[] }
  | { kind: 'canceled' }
  | { kind: 'unsupported' }

/**
 * Bridge that bounces an ask-the-user request to whichever channel owns the
 * active turn (mirrors the amygdala approval bridge). Wired in main over the
 * singleton turnRouter; absent in headless/test runtimes, where asking
 * resolves `unsupported`.
 */
export type AskUserBridge = (request: AskUserRequest & { id: string }) => Promise<AskUserResponse>

/**
 * Optional hook the agent passes into ensureDependencies so the dependency
 * resolver can emit broca segments for synthetic install calls. Without
 * this, the approval IPC fires correctly but the renderer has no
 * `tool_call` segment to anchor the approval card to — the dialog
 * silently never appears.
 */
export type DependencyEmitHook = {
  emitToolCall: (toolCallId: string, name: string, args: Record<string, unknown>) => void
  emitToolResult: (
    toolCallId: string,
    status: ToolResultStatus,
    output: string,
    error?: string
  ) => void
}

/**
 * Compact, serializable view of a capability handed to the `skills`
 * management plugin so it can list / search / manage capabilities without
 * reaching into Cerebellum internals. `official` capabilities ship with the
 * app (bundled, or in-process core channels) and can never be deleted; `dir`
 * is the on-disk folder.
 */
export type ManagedCapability = {
  name: string
  description: string
  triggers: string[]
  tools: Array<{ name: string; description: string }>
  hasPlugin: boolean
  status: CapabilityStatus
  enabled: boolean
  official: boolean
  /** A locked core capability (see LOCKED_CAPABILITIES) — cannot be disabled. */
  core: boolean
  /** Authored by Wolffish itself (skill_create) — shows the Wolffish badge. */
  wolffish: boolean
  /**
   * True unless this is a Wolffish-authored plugin capability that has not
   * yet passed a real tool call since it was created or last edited.
   */
  tested: boolean
  inProcess: boolean
  dir: string
  error?: string
}

/**
 * Result of importing/creating a capability — the subset of
 * CapabilityImportResult the `skills` plugin needs.
 */
export type ManagedImportResult = {
  ok: boolean
  error?: string
  name?: string
  hasPlugin?: boolean
  toolCount?: number
}

/**
 * Management surface injected into the `skills` capability's plugin via its
 * init context (PluginContext.host). Implemented in the main process
 * (index.ts) over the very same helpers the Cerebellum settings panel uses,
 * so agent-driven skill management and UI-driven management stay in lockstep:
 * config persistence is atomic, official capabilities are protected, and a
 * disk change is applied live via reload. Optional on PluginContext — every
 * plugin other than `skills` ignores it.
 */
export type CerebellumPluginHost = {
  /** Live snapshot of every loaded capability with enabled/official flags. */
  listCapabilities: () => Promise<ManagedCapability[]>
  /** Enable/disable a capability: persists `disabledCapabilities` AND applies live. */
  setCapabilityEnabled: (name: string, enabled: boolean) => Promise<void>
  /** Delete a non-official capability folder, prune config, and reload. */
  deleteCapability: (name: string) => Promise<{ ok: boolean; error?: string }>
  /** Validate + copy a staged capability (SKILL.md / folder / zip) into place. */
  importCapability: (sourcePath: string) => Promise<ManagedImportResult>
  /** Re-scan brain/cerebellum/ from disk so new/changed skills take effect. */
  reload: () => Promise<void>
}

/** A single scheduled automation (heartbeat job) as the agent sees it. */
export type AutomationJobInfo = {
  id: string
  /** Schedule kind — daily, weekly, every, hourly, weekday, monthly, startup, cron. */
  kind: string
  /** The 5-field cron expression the job runs on, or null for a startup job. */
  cron: string | null
  /** The exact ## heading text (e.g. "Every (5m)"). */
  label: string
  /** The instruction body the agent runs when the job fires. */
  body: string
  /** Plain-English description of the schedule (e.g. "every 5 minutes"). */
  human: string
  /** True while this job is executing right now. */
  running: boolean
  /** Epoch ms of the last run, or null if it hasn't run this session. */
  lastRunAt: number | null
  /** Outcome of the last run, or null if it hasn't run this session. */
  lastStatus: 'completed' | 'failed' | 'skipped' | null
  /** Error text from the last run, when it failed. */
  lastError?: string
  /** The job's own chat mode (its `mode: …` marker); null ⇒ follows global. */
  mode: 'single' | 'workflow' | null
  /**
   * The job's own reasoning effort (its `thinking: …` marker); null ⇒
   * follows the chat's selected thinking mode.
   */
  thinking: 'off' | 'on' | 'high' | 'max' | null
}

/**
 * Automation-management surface injected into the `automations` capability's
 * plugin via its init context (PluginContext.automations). Implemented in the
 * main process (index.ts) over the live Brainstem instance, so agent-driven
 * automation management and the engine that actually fires the jobs share one
 * source of truth: the same parser validates a schedule, the same reload path
 * applies an edit, the same executeJob runs a job on demand. Optional on
 * PluginContext — every plugin other than `automations` ignores it.
 */
export type AutomationsHost = {
  /**
   * The CURRENT global chat mode — automation_create stamps it on new jobs
   * as their default (the "mode the user was in when they created it").
   */
  getGlobalMode: () => Promise<'single' | 'workflow'>
  /** Read the raw brainstem/heartbeat.md file verbatim. */
  readHeartbeat: () => Promise<string>
  /** Overwrite brainstem/heartbeat.md, reload the scheduler, return the new live jobs. */
  writeHeartbeat: (
    raw: string
  ) => Promise<{ ok: boolean; jobs: AutomationJobInfo[]; error?: string }>
  /** Live snapshot of every scheduled automation, enriched with run status. */
  listJobs: () => AutomationJobInfo[]
  /** Validate a proposed schedule heading and describe it; the syntax single-source-of-truth. */
  previewSchedule: (
    heading: string
  ) =>
    | { ok: true; kind: string; cron: string | null; human: string; runAt?: number | null }
    | { ok: false; error: string }
  /** Every automation currently running (up to the pool's cap), oldest first. */
  getRunningJobs: () => Array<{ id: string; label: string; body: string; startedAt: number }>
  /** Run an automation immediately by id or heading label (fire-and-forget). */
  runJobNow: (idOrLabel: string) => {
    ok: boolean
    started: boolean
    state?: 'running' | 'queued' | 'coalesced'
    running?: number
    error?: string
  }
}

/**
 * Procedure-management surface injected into the `procedures` capability's
 * plugin via its init context (PluginContext.procedures). Implemented in the
 * main process (index.ts) over the same procedures store the renderer uses, plus
 * the Brainstem's detached-run queue for `run`. Present only to the `procedures`
 * plugin; undefined for every other plugin.
 */
export type ProcedureInfo = {
  id: string
  title: string
  prompt: string
  /** The procedure's own chat mode; absent ⇒ follows the global mode. */
  mode?: 'single' | 'workflow'
  createdAt: number
  updatedAt: number
}

export type ProceduresHost = {
  /** Every saved procedure, most-recently-edited first. */
  list: () => Promise<ProcedureInfo[]>
  /** Save a new procedure; returns the created row. */
  create: (title: string, prompt: string) => Promise<ProcedureInfo>
  /** Edit title/prompt/mode (omitted fields kept); returns the updated row. */
  update: (
    id: string,
    patch: { title?: string; prompt?: string; mode?: 'single' | 'workflow' }
  ) => Promise<ProcedureInfo>
  /** Permanently delete a procedure by id. */
  delete: (id: string) => Promise<{ ok: boolean; error?: string }>
  /**
   * Run a procedure now as a detached background job — the same single-flight
   * queue and sealed-conversation run a triggered automation uses. Fire-and-
   * forget: returns as soon as the run is queued.
   */
  run: (id: string) => Promise<{ ok: boolean; started: boolean; error?: string }>
}

export type ProjectInfo = {
  id: string
  title: string
  icon: string
  instructions: string
  files: Array<{ path: string; name: string }>
  createdAt: number
  updatedAt: number
}

export type ProjectConversationInfo = {
  id: string
  title: string
  updatedAt: number
  messageCount: number
}

/**
 * Project-management surface injected into the `projects` capability's plugin
 * via its init context (PluginContext.projects). Implemented in the main
 * process over the same store the Projects page uses (src/main/projects.ts),
 * plus a project-scoped conversation listing for visibility.
 */
export type ProjectsHost = {
  /** Every project, most-recently-edited first. */
  list: () => Promise<ProjectInfo[]>
  /** Create a project; returns the created row. */
  create: (payload: { title: string; icon?: string; instructions?: string }) => Promise<ProjectInfo>
  /** Edit title/icon/instructions/files (omitted fields kept); returns the updated row. */
  update: (
    id: string,
    patch: {
      title?: string
      icon?: string
      instructions?: string
      files?: Array<{ path: string; name: string }>
    }
  ) => Promise<ProjectInfo>
  /** Permanently delete a project by id. */
  delete: (id: string) => Promise<{ ok: boolean; error?: string }>
  /**
   * Copy sources into the project's uploads dir and attach them — real
   * copies (uniform with conversation uploads), never references.
   */
  attachFiles: (
    projectId: string,
    paths: string[]
  ) => Promise<{
    project: ProjectInfo
    added: Array<{ path: string; name: string }>
    skipped: string[]
    missing: string[]
  }>
  /** Conversations bound to a project, newest first. */
  conversationsFor: (projectId: string) => Promise<ProjectConversationInfo[]>
}

/**
 * Agent-management surface injected into the `workflow` capability's plugin
 * via its init context (PluginContext.workflow). Implemented by the Agent
 * (workflowHost) over the active WorkflowSession — the single source of truth
 * for a master turn's live subagents. Present only to the master role in
 * workflow mode; undefined for every other plugin and for agents themselves
 * (two-level: an agent never delegates). All methods throw if called outside
 * an active workflow turn.
 */
export type WorkflowHost = {
  /**
   * Declare (or revise) the run's intended phases. Recorded deterministically
   * on the workflow card; agents reference a phase by its exact title.
   */
  plan: (phases: string[], note?: string) => void
  /**
   * Spawn a live agent on a task. Non-blocking — returns its id. `model` is a
   * `provider/model-id` string (validated against the connected providers;
   * omitted ⇒ the master's own model); `effort` sets the agent's reasoning
   * level (clamped to the resolved model's support).
   */
  spawnAgent: (args: {
    /** Read-only explore agent: observes and reports, never changes state. */
    readOnly?: boolean
    task: string
    name?: string
    model?: string
    effort?: WorkflowEffort
    phase?: string
  }) => string
  /** Send a follow-up to a landed agent, optionally re-tuning its effort. */
  sendToAgent: (agentId: string, message: string, effort?: WorkflowEffort) => void
  /**
   * Block until the NEXT agent (optionally restricted to `agentIds`) either
   * lands (result ready) or trips a no-progress escalation (still running but
   * stuck — the master is woken to decide) — or null when none is still live.
   */
  awaitAgents: (agentIds?: string[]) => Promise<WorkflowWaitOutcome | null>
  /** Cancel an agent, aborting its in-flight tool calls. */
  cancelAgent: (agentId: string) => void
  /** Snapshot every agent in the active turn's registry. */
  listAgents: () => WorkflowAgentView[]
}

/**
 * MCP-management surface injected into the `mcp` capability's plugin via its
 * init context (PluginContext.mcp). Implemented in the main process (index.ts)
 * over the McpManager — the same methods the Settings → MCP IPC handlers call,
 * so an agent-driven add/test/remove reflects in the UI exactly like a manual
 * one. All ids are the server ids surfaced by `list`. Present only to the `mcp`
 * plugin; undefined for every other plugin.
 */
export type McpHost = {
  /** Every configured MCP server with its live status snapshot. */
  list: () => McpServerSnapshot[]
  /** Add a connection (stdio command or remote URL); connects immediately. */
  add: (input: McpAddInput) => Promise<McpAddResult>
  /** Re-check / reconnect a server now; returns tool count + latency or error. */
  test: (id: string) => Promise<McpTestResult>
  /** Remove a server and everything it owns (tokens, disabled entry). */
  remove: (id: string) => Promise<{ ok: boolean; error?: string }>
  /** Enable or disable a server without deleting it. */
  setEnabled: (id: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>
  /** Begin the OAuth sign-in flow for a remote server (opens the browser). */
  authorize: (id: string) => Promise<{ ok: boolean; error?: string }>
}

/**
 * Async generation-task surface injected into the `video` capability's
 * plugin via its init context (PluginContext.videoTasks). Implemented in
 * the main process (index.ts) over the VideoTaskManager singleton, which
 * owns the MiniMax H3 task lifecycle: media preparation, task creation,
 * the 10s poll loop, artifact download, and the task-card snapshot flow.
 * The host implementation stamps the active conversation/turn onto every
 * submit, so the plugin never handles ids. Optional on PluginContext —
 * every plugin other than `video` ignores it.
 */
export type VideoTasksHost = {
  /**
   * Is the service usable right now — key present and accepted? Called by
   * `video_check` so the agent can confirm configuration before spending a
   * generation, and report the exact remedy when it can't.
   */
  check: () => Promise<{ configured: boolean; reachable: boolean; detail: string }>
  /** Validate + prepare media, create the task, start polling. */
  submit: (input: VideoSubmitInput) => Promise<VideoSubmitResult>
  /**
   * Park until the task reaches a terminal state (artifact downloaded for
   * successes). Null when the signal aborts first or the id is unknown.
   */
  awaitTask: (taskId: string, signal?: AbortSignal) => Promise<TaskSnapshot | null>
  /** Cancel a queued/running task server-side. */
  cancel: (taskId: string) => Promise<{ ok: boolean; error?: string }>
  /** Snapshot of one task. */
  get: (taskId: string) => TaskSnapshot | null
  /** Every task belonging to the active conversation, oldest first. */
  list: () => TaskSnapshot[]
}

/**
 * Turn-end countdown surface (see runtime/countdown.ts), injected into every
 * plugin's init context as PluginContext.countdown. A plugin whose effect
 * would take the app or machine down (the `system` power actions) arms a
 * countdown here instead of running the effect, so the turn ends and its
 * transcript lands first; the manager fires the armed tool call after the
 * grace period unless the user aborts it from the card.
 */
export type CountdownHost = {
  /**
   * Register `tool(args)` to run `seconds` after the current turn ends. The
   * host stamps the active conversation/turn. Fails outside a turn, and in
   * an autonomous (automation) turn — nobody is watching that card.
   */
  arm: (input: CountdownArmInput) => Promise<CountdownArmResult>
  /**
   * True while the manager is executing an armed target. A plugin that arms
   * on the model's call reads this to run for real when the countdown
   * calls it back.
   */
  isFiring: () => boolean
  /** The single armed-or-counting countdown, if any. */
  pending: () => CountdownSnapshot | null
}

/**
 * Blocking waits, injected into the `utilities` plugin via its init context
 * (PluginContext.wait). Implemented in the main process over the WaitManager
 * singleton: it renders the waiting card, blocks for as long as the model
 * asked, and resolves early when the user sends a mid-turn message.
 */
/**
 * Long-lived process surface (src/main/processes). Present once main calls
 * setProcessesHost — the shell plugin routes `shell_exec background=true`,
 * `shell_jobs` and `shell_stop` through it so there is ONE registry of
 * background processes, persisted and supervised, instead of a per-plugin
 * in-memory map that dies with the app.
 */
export type ProcessesHost = {
  start: (input: {
    name?: string
    command: string
    cwd?: string
    env?: Record<string, string>
    wait?: boolean
    origin?: { conversationId: string | null; kind: 'started' | 'shell' | 'adopted' }
  }) => Promise<{
    ok: boolean
    error?: string
    name?: string
    pid?: number | null
    logPath?: string | null
    url?: string | null
  }>
  list: () => Array<{
    name: string
    pid: number | null
    state: string
    command: string
    cwd: string
    logPath: string | null
    startedAt: number | null
  }>
  stop: (name: string) => Promise<{ ok: boolean; stopped: boolean; error?: string }>
  stopAll: () => Promise<Array<{ name: string; stopped: boolean }>>
  findByPid: (pid: number) => string | null
}

export type WaitHost = {
  /**
   * Block for `input.seconds`, showing a card that says why. Resolves with
   * how the wait ended (`elapsed` / `interrupted` / `canceled`) — never
   * rejects, and never imposes a maximum.
   */
  start: (input: WaitStartInput, signal?: AbortSignal) => Promise<WaitStartResult>
}

/**
 * Retrieval surface injected into the `introspect` capability's plugin via
 * its init context (PluginContext.cortex). Implemented in the main process
 * (index.ts) over the live Cortex index + Hippocampus write path, so the
 * memory_search / conversation_list / usage_report tool family queries the
 * same records the ambient context assembly reads — one index, no drift.
 * Optional on PluginContext — every plugin other than `introspect` ignores it.
 */
export type CortexHost = {
  /** Ranked record-level FTS across every indexed source, with snippets. */
  searchRecords: (
    query: string,
    opts?: { sources?: RecordSource[]; after?: string; before?: string; limit?: number }
  ) => RecordHit[]
  /** Full stored records by exact ref or ref prefix (ordered). */
  getRecordsByRef: (refPrefix: string, limit?: number) => RecordRow[]
  /** Records pinned to a single resolved day. */
  recordsByDate: (date: string, sources?: RecordSource[], limit?: number) => RecordRow[]
  /** Enumerate conversations, newest first. */
  listConversations: (opts?: {
    channel?: string
    after?: number
    before?: number
    limit?: number
  }) => ConversationSummary[]
  /** Aggregate LLM spend from the usage ledger. */
  usageSummary: (opts?: { after?: string; before?: string }) => UsageSummary
  /** Generated/uploaded artifact lookup with conversation provenance. */
  searchArtifacts: (opts?: {
    query?: string
    kind?: string
    conversationId?: string
    limit?: number
  }) => ArtifactHit[]
  /** Cheap per-source counts + date coverage — the "what memory exists" map. */
  coverage: () => {
    recordsBySource: Array<{
      source: string
      count: number
      minDate: string | null
      maxDate: string | null
    }>
    conversations: number
    artifacts: number
  }
  /**
   * Durably save a fact into the curated knowledge store (with exact-line
   * dedup). The write path is hippocampus.promoteToKnowledge — the same file
   * the nightly consolidation appends to — so model-saved and consolidated
   * facts live together.
   */
  saveKnowledge: (
    file: 'projects' | 'people' | 'preferences' | 'technical' | 'decisions',
    fact: string,
    topic?: string
  ) => Promise<{ ok: boolean; deduped: boolean; filed: boolean }>
}

/**
 * The amend surface over everything the agent believes long-term: its
 * playbook, custom instructions, identity files, and the five curated
 * knowledge files. Implemented in main over KnowledgeStore, which owns the
 * allowlist, the structure invariants and the `.bak` safety net — the plugin
 * only formats. Present only when the host wired one in via setKnowledgeHost.
 */
export type KnowledgeHost = {
  list: () => Promise<KnowledgeTargetInfo[]>
  read: (
    target: KnowledgeTargetName
  ) => Promise<{ ok: true; rel: string; content: string } | { ok: false; error: string }>
  add: (
    target: KnowledgeTargetName,
    entry: string,
    opts: { section?: string; source?: string }
  ) => Promise<KnowledgeWriteResult>
  edit: (
    target: KnowledgeTargetName,
    find: string,
    replace: string
  ) => Promise<KnowledgeWriteResult>
  forget: (target: KnowledgeTargetName, find: string) => Promise<KnowledgeWriteResult>
  rewrite: (target: KnowledgeTargetName, content: string) => Promise<KnowledgeWriteResult>
  restore: (target: KnowledgeTargetName) => Promise<KnowledgeWriteResult>
  /** Valid target names, so the plugin can reject a typo without a round trip. */
  targets: () => KnowledgeTargetName[]
}

export type KnowledgeTargetName = string

export type KnowledgeTargetInfo = {
  target: string
  rel: string
  governs: string
  everyPrompt: boolean
  bytes: number
  maxChars: number
  sections: string[]
  entries: number
  updatedAt: string | null
  hasBackup: boolean
}

export type KnowledgeWriteResult =
  | { ok: true; message: string; warning?: string }
  | { ok: false; error: string }

/**
 * The local voice engines' settings + provisioning seam, injected into the
 * `text-to-speech` and `speech-to-text` plugins via their init context
 * (PluginContext.voice). Implemented in the main process over the SAME
 * functions the Settings panels' IPC handlers call — persistTtsConfig /
 * persistSttConfig followed by `services:changed`, and the deduped
 * installTts / installStt with their progress broadcast.
 *
 * That sameness is the point. A setting the agent changes has to be
 * indistinguishable from one the user changed in the panel: the config write,
 * the renderer re-seed and the CLI/phone surfaces are one path, so an open
 * TTS/STT panel moves under the agent's hand and every other surface follows,
 * without any of them knowing which side made the change.
 *
 * Undefined for every other plugin, and for a headless host or a test that
 * never wired one — the plugins refuse the settings tools rather than falling
 * back to a raw config write, which would land on disk with no surface told.
 */
export type VoiceHost = {
  /** Current TTS defaults, normalized field-by-field. */
  getTts: () => Promise<{ defaultVoice: string; defaultSpeed: string; voiceReplies: boolean }>
  /** Persist TTS defaults and announce them (renderer re-seed + surface push). */
  setTts: (patch: {
    defaultVoice?: string
    defaultSpeed?: string
  }) => Promise<{ defaultVoice: string; defaultSpeed: string; voiceReplies: boolean }>
  /** Current STT defaults, normalized field-by-field. */
  getStt: () => Promise<{ defaultModel: string; language: string }>
  /** Persist STT defaults and announce them (renderer re-seed + surface push). */
  setStt: (patch: {
    defaultModel?: string
    language?: string
  }) => Promise<{ defaultModel: string; language: string }>
  /** Whether each engine is provisioned on this device right now. */
  ttsInstalled: () => Promise<boolean>
  sttInstalled: () => Promise<boolean>
  /**
   * Provision an engine, driving the very same install the panel's button
   * runs — deduped against an in-flight one, with progress broadcast to every
   * window, so the panel's card tracks an agent-triggered install live.
   */
  installTts: () => Promise<{ ok: true } | { ok: false; error: string }>
  installStt: () => Promise<{ ok: true } | { ok: false; error: string }>
  /** True while an install this process started is still running. */
  ttsInstalling: () => boolean
  sttInstalling: () => boolean
}

export type PluginContext = {
  pluginDir: string
  workspaceRoot: string
  /**
   * Resolves to the conversation id of the turn currently in flight, or
   * null when no turn is active. Plugins that produce per-conversation
   * artifacts (voice memos, attachments) call this at execute time —
   * not init — so the value reflects the active conversation, not the
   * one that happened to be active when the plugin first loaded.
   */
  getCurrentConversationId: () => string | null
  /**
   * The working folders of the turn in flight (conversation picker ∪ project
   * directories), first one primary — `[]` outside any turn. Read at execute
   * time, never at init: the shell defaults its cwd to the first folder and
   * the filesystem tools resolve relative paths against it, so the model can
   * say `src/foo.ts` and `npm test` and land in the project.
   */
  getWorkingFolders: () => string[]
  /**
   * Progress for the tool call in flight. Called synchronously at the top of
   * execute() — it binds to the current tool call id — and the reporter it
   * returns takes either a text or a function that produces one on demand.
   * A check-in (runtime/check-in.ts) reads the latest value when the call
   * runs long, so the model sees what the call has done so far. Optional
   * for every plugin; a call that never reports checks in with elapsed time
   * only.
   */
  progressReporter: () => (value: string | (() => string)) => void
  /**
   * Shared, app-lifetime admin-password session. Plugins that run privileged
   * (sudo) commands call `sudo.ensurePassword()` once and merge
   * `sudo.getElevatedEnv()` into their elevated spawns so the user is prompted
   * a single time per app run instead of per command. macOS-only; callers
   * gate on platform and fall back to their own elevation path elsewhere.
   */
  sudo: SudoSession
  /**
   * Capability-management surface. Present only when the host wired one in
   * via setPluginHost — used by the `skills` capability to list, enable,
   * disable, delete, and create other capabilities. Undefined for every
   * other plugin.
   */
  host?: CerebellumPluginHost
  /**
   * Automation-management surface. Present only when the host wired one in via
   * setAutomationsHost — used by the `automations` capability to list, create,
   * edit, delete, check, and run the scheduled heartbeat jobs. Undefined for
   * every other plugin.
   */
  automations?: AutomationsHost
  /**
   * Procedure-management surface. Present only when the host wired one in via
   * setProceduresHost — used by the `procedures` capability to list, view,
   * create, edit, delete, and run saved procedures. Undefined for every other
   * plugin.
   */
  procedures?: ProceduresHost
  /**
   * setProjectsHost — used by the `projects` capability to list, view,
   * create, edit, and delete projects and see their conversations.
   */
  projects?: ProjectsHost
  /**
   * Agent-management surface. Present only when the host wired one in via
   * setWorkflowHost — used by the `workflow` capability to plan, spawn, drive,
   * await, and cancel live subagent sessions. Undefined for every other plugin
   * and for agents themselves (two-level: an agent never delegates).
   */
  workflow?: WorkflowHost
  /**
   * MCP-management surface. Present only when the host wired one in via
   * setMcpHost — used by the `mcp` capability to list, add, test, enable,
   * disable, remove, and authorize MCP server connections. Undefined for
   * every other plugin.
   */
  mcp?: McpHost
  /**
   * Retrieval surface over the cortex index. Present only when the host wired
   * one in via setCortexHost — used by the `introspect` capability's
   * memory_search / memory_get / conversation_list / conversation_read /
   * memory_save / usage_report tools. Undefined for every other plugin.
   */
  cortex?: CortexHost
  /**
   * Long-term knowledge amend surface. Present only when the host wired one
   * in via setKnowledgeHost — used by the `knowledge` capability to read,
   * amend, forget, rewrite and restore the agent's own playbook, custom
   * instructions, identity files and curated knowledge. Undefined for every
   * other plugin.
   */
  knowledge?: KnowledgeHost
  /**
   * The local voice engines' settings + provisioning seam. Present only when
   * the host wired one in via setVoiceHost — used by the `text-to-speech` and
   * `speech-to-text` capabilities to read and change their own defaults (voice,
   * speed, model, language) and to install their engines, through the exact
   * paths the Settings panels use. Undefined for every other plugin.
   */
  voice?: VoiceHost
  /**
   * Async video-generation surface. Present only when the host wired one in
   * via setVideoTasksHost — used by the `video` capability to submit, await,
   * inspect, and cancel MiniMax H3 generation tasks. Undefined for every
   * other plugin.
   */
  videoTasks?: VideoTasksHost
  /**
   * Turn-end countdown surface. Present once the host wired one in via
   * setCountdownHost — see CountdownHost.
   */
  countdown?: CountdownHost
  /**
   * Blocking waits for the `utilities` capability's `wait` tool. Present
   * once main calls setWaitHost — see WaitHost.
   */
  wait?: WaitHost
  /**
   * Long-lived process registry — see ProcessesHost. Present once main
   * calls setProcessesHost.
   */
  processes?: ProcessesHost
  /**
   * Ask the user a multiple-choice question and block until they answer.
   * Used by the `ask` capability to pause the agent loop, render an
   * interactive question card in the chat, and resume with the user's
   * choice (a listed option or free-text instructions). Resolves
   * `unsupported` when no channel can render the card (e.g. a headless
   * runtime), and `canceled` if the run is stopped before they answer.
   */
  askUser: (request: AskUserRequestInput) => Promise<AskUserResponse>
  /**
   * Live connection status for every messaging channel (Telegram, WhatsApp,
   * in-app chat). Used by the `introspect` capability to report whether a
   * channel is reachable and, when it isn't, how the user can reconnect it.
   * Returns an empty array until the host wires a provider via
   * setChannelStatusProvider; every plugin other than `introspect` ignores it.
   */
  getChannelStatus: () => ChannelStatusSnapshot[]
}

export type WolffishPlugin = {
  name: string
  tools: ToolDefinition[]
  /**
   * Run a tool. The optional `signal` aborts when the user stops the run;
   * long-running plugins (shell, ffmpeg, …) should honor it by killing the
   * in-flight work and returning a failure result. Quick plugins may ignore
   * it. Existing untyped .mjs plugins that declare execute(toolName, args)
   * keep working — the extra positional arg is simply unused.
   */
  execute: (
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<ToolExecutionResult>
  init?: (context: PluginContext) => Promise<void>
  /**
   * Per-call read-only classification for tools whose effect depends on
   * their arguments (the shell: `git status` observes, `git push` acts).
   * Consulted by a read-only turn (plan mode, explore agents) after the
   * frontmatter `readOnly` flag; absent means the tool is judged by the
   * flag alone. Must be pure and fast.
   */
  isReadOnlyCall?: (toolName: string, args: Record<string, unknown>) => boolean | Promise<boolean>
  destroy?: () => Promise<void>
  /**
   * Optional: produce a rich, human-readable description of what this
   * tool call will do. Shown on the approval card. Plugins should resolve
   * platform-specific commands (e.g. the actual brew/winget invocation)
   * at call time so the user sees what will run on their machine.
   */
  describeAction?: (
    toolName: string,
    args: Record<string, unknown>
  ) => ApprovalDescription | Promise<ApprovalDescription>
}

export type CerebellumOptions = {
  workspaceRoot?: string
  amygdala?: Amygdala
  corpus?: Corpus
}

const PLUGIN_FILES = ['index.mjs', 'index.js', 'index.cjs']

/**
 * Capabilities whose full tool schemas ship on EVERY request: the bootstrap
 * set that must never require a discovery hop. (1) tool-discovery + the
 * introspect retrieval suite — the keys to every other tool and every byte of
 * memory; (2) universal primitives used across most task types (filesystem,
 * shell, web-search, secrets, system, ask, send_file); (3) the channel send
 * tools, which register only while connected and can't wait a hop to reply.
 * Everything else — github, google, browser(s), media, documents, MCP
 * servers — is one tool_search away. Tunable via config.pinnedCapabilities.
 */
export const CORE_CAPABILITIES: ReadonlySet<string> = new Set([
  'tool-discovery',
  // call_wait / call_stop — the two moves a check-in offers. The moment a
  // tool call reports STILL RUNNING, both must be callable without a hop.
  'check-in',
  // Turn-end countdowns (countdown_start) — the safe way to run anything that
  // would cut off the reply announcing it; `system` (core) arms through the
  // same manager, so the generic tool must be callable without a hop too.
  'countdown',
  // Undo for file edits (changes_list / changes_revert) — always callable so
  // "put it back" never needs a discovery hop.
  'changes',
  // The model's task list (todo_write) — a coding-loop staple that must be
  // callable without a discovery hop; the doctrine tells the model to keep
  // it for any multi-step work.
  'todo',
  // Delegation must be core: workflow.md commands workflow_plan/agent_spawn
  // at turn start, so its schemas must ship without a discovery hop. Role
  // gating (excludedCapabilitiesFor) still hides it from single-mode/agent turns.
  'workflow',
  'introspect',
  'filesystem',
  'shell',
  'ask',
  // The tabbed copy-and-paste card (offer_options). Core for the same reason
  // `ask` is: the moment the honest answer is "here are a few ways", the card
  // must be one call away — a discovery hop before a presentational tool is a
  // hop the model simply doesn't take, and the fallback (stacking variants as
  // raw code blocks in the reply) is exactly what it exists to replace.
  'options',
  'utilities',
  'web-search',
  'secrets',
  'system',
  'telegram',
  'whatsapp',
  // The phone-notification tool (notify_phone), registered in-process by the
  // mobile channel. Core for the same reason the other channel sends are:
  // "notify me when this finishes" must not require a discovery hop, and the
  // tool answers its own refusals (nothing paired, notifications off).
  'phone',
  'electron',
  // Same body-load pattern for the design manuals. Document/PDF requests,
  // web-page requests, and chart requests are frequent and quality-critical;
  // a discovery hop before the manual halves the trigger rate, which is
  // exactly the inconsistent-output failure
  // these exist to fix.
  'pdf-design',
  'web-design',
  'dataviz',
  // Async video generation (MiniMax H3). Core so the schemas always ship:
  // a video request must reach video_generate without a discovery hop, and
  // the task-card protocol in the tool descriptions is what keeps the flow
  // model-led. Missing API key degrades to a clear error naming Settings.
  'video',
  // Long-lived processes (dev servers, tunnels, watchers). Core so a "start
  // the dev server" turn never spends a discovery hop and the port rule in
  // process_start's description is always in front of the model; the shell
  // plugin's background path depends on the registry being present.
  'processes'
])

/**
 * The "core" capabilities surfaced in the Capabilities settings panel with a
 * primary "Core" badge, sorted last, and LOCKED — they can never be toggled
 * off (from the UI, the agent's skill_disable, or a stale config entry). These
 * are the load-bearing built-ins the app assumes are always present:
 * self-management (skills), workflow delegation, introspection,
 * automations/procedures/projects scheduling, secrets, and the shared
 * utilities. Distinct from CORE_CAPABILITIES above, which governs
 * always-expose-to-the-model (no discovery hop) — a different concern that
 * happens to overlap. setDisabled() filters this set out defensively, so
 * membership here is the single source of truth for "cannot be disabled".
 */
export const LOCKED_CAPABILITIES: ReadonlySet<string> = new Set([
  'check-in',
  'processes',
  'workflow',
  'countdown',
  'todo',
  'automations',
  'projects',
  'introspect',
  // Amending its own long-term memory is self-management, not an optional
  // extra: with this off the agent can learn (memory_save, nightly reflection)
  // but never unlearn, and a wrong belief would survive every correction the
  // user makes. Locked for the same reason `skills` is.
  'knowledge',
  'pdf-design',
  'web-design',
  'dataviz',
  'procedures',
  'secrets',
  'skills',
  'utilities'
])

/** Max non-core capabilities exposed per conversation before LRU eviction. */
const ACTIVE_SET_MAX = 10

/** Individual index lines before the unloaded remainder collapses to a count. */
const CAPABILITY_INDEX_MAX_LINES = 60

type ActiveToolset = {
  names: Set<string>
  version: number
  lastUsed: Map<string, number>
}

function oneLineDescription(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

export class Cerebellum {
  private capabilities = new Map<string, Capability>()
  private plugins = new Map<string, WolffishPlugin>()
  private toolToCapability = new Map<string, string>()
  /** Per-conversation activated (non-core) capabilities. Key: conversationId. */
  private activeSets = new Map<string, ActiveToolset>()
  /** Extra always-exposed capabilities from config.pinnedCapabilities. */
  private pinnedCapabilities = new Set<string>()
  private dependencyCache = new Map<string, boolean>()
  /**
   * Single-flight guards for concurrent dependency resolution: keyed by
   * capability name for whole-capability flights and `dep:<name>` for the
   * per-dependency check→install blocks (see singleFlight).
   */
  private dependencyInflight = new Map<string, Promise<void>>()
  /** Single-flight for ensureSystemTool's silent installs (ffmpeg etc.). */
  private systemToolInflight = new Map<string, Promise<{ ok: boolean; error?: string }>>()
  private loaded = false
  private currentConversationId: string | null = null
  // Per-turn conversation scope. Under concurrent turns (workflow master + live
  // workers) a single global field is clobbered — a worker running with no
  // conversation would null out the master's stamp. AsyncLocalStorage
  // gives every turn (and the tool calls inside it) its OWN value that follows
  // the async call tree, so a subagent's null can't bleed into the master's
  // artifact stamping. `currentConversationId` remains the fallback for the
  // imperative callers outside a turn (STT path, channel pre-roll).
  private conversationCtx = new AsyncLocalStorage<string | null>()
  private disabled = new Set<string>()
  private pluginHost?: CerebellumPluginHost
  private automationsHost?: AutomationsHost
  private proceduresHost?: ProceduresHost
  private projectsHost?: ProjectsHost
  private workflowHost?: WorkflowHost
  private mcpHost?: McpHost
  private cortexHost?: CortexHost
  private knowledgeHost?: KnowledgeHost
  private voiceHost?: VoiceHost
  private videoTasksHost?: VideoTasksHost
  private countdownHost?: CountdownHost
  private waitHost?: WaitHost
  private processesHost?: ProcessesHost
  /**
   * Bumped every time the live tool surface changes — a reload (skills
   * added/edited/removed) or an enable/disable toggle. The agent loop pins
   * the system prompt + tool list once per turn for cache efficiency; it
   * re-reads this counter each iteration and rebuilds the pin when it moves,
   * so a skill created or edited mid-turn becomes callable on the very next
   * step instead of only on the next user turn. Also drives the plugin
   * import cache-buster so an edited plugin re-evaluates instead of resolving
   * to Node's stale ESM module cache.
   */
  private generation = 0
  private askBridge?: AskUserBridge
  private channelStatusProvider?: () => ChannelStatusSnapshot[]
  /**
   * The toolCallId of the tool currently executing, established by
   * executeTool for the duration of one plugin.execute call. The `ask`
   * capability needs it to anchor its question card to the right tool_call
   * segment, but plugin.execute isn't handed the id. AsyncLocalStorage
   * (not a field) because tool calls from CONCURRENT turns interleave —
   * a save/restore field protects nesting, not interleaving, and would
   * anchor one turn's ask card to another turn's tool_call segment.
   */
  private toolCallCtx = new AsyncLocalStorage<string>()
  /** Latest progress per in-flight tool call — see PluginContext.progressReporter. */
  private readonly toolProgress = new Map<string, string | (() => string)>()
  /**
   * The turn's working folders, entered by the agent once it has resolved
   * them (conversation picker ∪ project directories). Plugins read it at
   * execute time through `PluginContext.getWorkingFolders()` — the shell's
   * default cwd and the filesystem tools' relative-path base both come from
   * here. AsyncLocalStorage (not a field) for the same reason as
   * conversationCtx: concurrent turns interleave, and a workflow agent that
   * runs inside the master's async tree inherits the master's folders
   * without either clobbering the other.
   */
  private workingFoldersCtx = new AsyncLocalStorage<string[]>()
  /** Per-turn file snapshots (see snapshots.ts) — captured by the Agent, restored by `changes`. */
  readonly snapshots: SnapshotStore

  constructor(private options: CerebellumOptions = {}) {
    this.snapshots = new SnapshotStore(options.workspaceRoot ?? '')
  }

  /**
   * Enter `folders` as the working folders for the rest of the current
   * async execution (the turn) and everything it awaits or spawns. A no-op
   * for an empty list so a nested turn that resolved nothing of its own
   * keeps inheriting its parent's folders.
   */
  enterWorkingFolders(folders: string[]): void {
    if (folders.length === 0) return
    this.workingFoldersCtx.enterWith([...folders])
  }

  /** The working folders of the turn in flight — `[]` outside any turn. */
  getWorkingFolders(): string[] {
    return this.workingFoldersCtx.getStore() ?? []
  }

  /**
   * Wire the ask-the-user bridge after construction (mirrors amygdala's
   * setApprovalBridge). Used by main to route question cards to whichever
   * channel owns the active turn. Without it, `context.askUser` resolves
   * `unsupported`.
   */
  setAskBridge(bridge: AskUserBridge | null): void {
    this.askBridge = bridge ?? undefined
  }

  /**
   * Wire a provider that reports live channel connection status. Set by main
   * once the channels exist; backs `PluginContext.getChannelStatus` so the
   * introspect capability can tell the model which channels are reachable and
   * how to reconnect a disconnected one. Resolved at call time, so the
   * provider can be set after plugins have already loaded.
   */
  setChannelStatusProvider(provider: (() => ChannelStatusSnapshot[]) | null): void {
    this.channelStatusProvider = provider ?? undefined
  }

  /**
   * Build the full ask request (injecting the active toolCallId + a fresh
   * id) and bounce it through the bridge. Backs `PluginContext.askUser`.
   */
  private async dispatchAskUser(input: AskUserRequestInput): Promise<AskUserResponse> {
    const bridge = this.askBridge
    const toolCallId = this.toolCallCtx.getStore() ?? null
    if (!bridge || !toolCallId) return { kind: 'unsupported' }
    const id = `ask_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    try {
      return await bridge({ ...input, toolCallId, id })
    } catch {
      return { kind: 'canceled' }
    }
  }

  setDisabled(names: string[]): void {
    // Locked core capabilities can never be disabled — filter them out here so
    // this is the single runtime chokepoint: a stale config entry, an agent's
    // skill_disable, or a UI toggle can't remove a load-bearing built-in.
    this.disabled = new Set(names.filter((n) => !LOCKED_CAPABILITIES.has(n)))
    this.generation++
  }

  /**
   * Monotonic tool-surface version. Changes whenever capabilities are
   * reloaded or a skill is enabled/disabled. The agent loop compares this
   * against the value it pinned at turn start to decide whether to rebuild.
   */
  getGeneration(): number {
    return this.generation
  }

  /**
   * Wire the capability-management host (implemented in the main process)
   * that the `skills` capability's plugin receives in its init context.
   * Set once at startup; survives reload() so the bridge keeps working
   * after the `skills` plugin is re-imported.
   */
  setPluginHost(host: CerebellumPluginHost): void {
    this.pluginHost = host
  }

  /**
   * Wire the automation-management host (implemented in the main process over
   * the Brainstem) that the `automations` capability's plugin receives in its
   * init context. Set once at startup; survives reload() so the bridge keeps
   * working after the plugin is re-imported.
   */
  setAutomationsHost(host: AutomationsHost): void {
    this.automationsHost = host
  }

  /**
   * Wire the procedure-management host (implemented in the main process over the
   * procedures store + the Brainstem's detached-run queue) that the `procedures`
   * capability's plugin receives in its init context. Set once at startup;
   * survives reload() so the bridge keeps working after the plugin is re-imported.
   */
  setProceduresHost(host: ProceduresHost): void {
    this.proceduresHost = host
  }

  /**
   * Wire the project-management host (implemented in main over the same
   * store the Projects page uses) that the `projects` capability's plugin
   * receives in its init context. Set once at startup; survives reload().
   */
  setProjectsHost(host: ProjectsHost): void {
    this.projectsHost = host
  }

  /**
   * Wire the agent-management host (implemented by the Agent over the active
   * WorkflowSession) that the `workflow` capability's plugin receives in its
   * init context. Set once at startup; survives reload().
   */
  setWorkflowHost(host: WorkflowHost): void {
    this.workflowHost = host
  }

  /**
   * Wire the MCP-management host (implemented in the main process over the
   * McpManager) that the `mcp` capability's plugin receives in its init
   * context. Set once at startup; survives reload() so the bridge keeps working
   * after the plugin is re-imported.
   */
  setMcpHost(host: McpHost): void {
    this.mcpHost = host
  }

  /**
   * Wire the retrieval host (implemented in the main process over the live
   * Cortex index + Hippocampus) that the `introspect` capability's plugin
   * receives in its init context. Set once at startup; survives reload() so
   * the bridge keeps working after the plugin is re-imported.
   */
  setCortexHost(host: CortexHost): void {
    this.cortexHost = host
  }

  /**
   * Wire the long-term knowledge host (implemented in main over KnowledgeStore)
   * that the `knowledge` capability's plugin receives in its init context. Set
   * once at startup; survives reload() so the bridge keeps working after the
   * plugin is re-imported.
   */
  setKnowledgeHost(host: KnowledgeHost): void {
    this.knowledgeHost = host
  }

  /**
   * Wire the voice-engine settings + provisioning seam (implemented in main
   * over the same setters, broadcast and installers the Settings panels use)
   * that the `text-to-speech` and `speech-to-text` plugins receive in their
   * init context. Set once at startup; survives reload() so the bridge keeps
   * working after either plugin is re-imported.
   */
  setVoiceHost(host: VoiceHost): void {
    this.voiceHost = host
  }

  /**
   * Wire the video-task host (implemented in the main process over the
   * VideoTaskManager singleton) that the `video` capability's plugin
   * receives in its init context. Set once at startup; survives reload().
   */
  setVideoTasksHost(host: VideoTasksHost): void {
    this.videoTasksHost = host
  }

  /** Is this tool name registered by any loaded capability right now? */
  hasTool(name: string): boolean {
    return this.toolToCapability.has(name)
  }

  /**
   * Wire the turn-end countdown host (implemented in the main process over
   * the CountdownManager singleton). Set once at startup; survives reload().
   */
  setCountdownHost(host: CountdownHost): void {
    this.countdownHost = host
  }

  /**
   * Wire the blocking-wait host (implemented in the main process over the
   * WaitManager singleton) that the `utilities` capability's `wait` tool
   * receives in its init context. Set once at startup; survives reload().
   */
  setWaitHost(host: WaitHost): void {
    this.waitHost = host
  }

  /** Wire the process registry the shell plugin's background path delegates to. */
  setProcessesHost(host: ProcessesHost): void {
    this.processesHost = host
  }

  isDisabled(name: string): boolean {
    return this.disabled.has(name)
  }

  /**
   * Set by the agent at the start of every turn so plugins can stamp
   * their outputs with the active conversation id. Cleared in the
   * agent's finally block — a stale id leaking into the next turn
   * would silently misroute artifacts.
   */
  setCurrentConversationId(id: string | null, title?: string | null): void {
    this.currentConversationId = id
    this.options.corpus?.emit('conversation.changed', { conversationId: id, title })
  }

  /**
   * Clear the global pointer ONLY if it still names `id`. Under concurrent
   * turns the finishing turn must not null out a pointer a later-started
   * conversation has since claimed.
   */
  clearCurrentConversationId(id: string | null): void {
    if (this.currentConversationId !== id) return
    this.setCurrentConversationId(null)
  }

  getCurrentConversationId(): string | null {
    // Prefer the turn-scoped value; getStore() is undefined only outside any
    // runWithConversation scope, where the imperative global is the source.
    const scoped = this.conversationCtx.getStore()
    return scoped !== undefined ? scoped : this.currentConversationId
  }

  /**
   * Run `fn` with `id` as the turn-scoped conversation. Every getCurrentConversationId
   * call inside `fn` (including nested tool plugins) resolves to `id` regardless
   * of what other concurrent turns set — the isolation that lets workers run with
   * a null conversation without disturbing the master's. Does NOT touch the
   * global or emit conversation.changed; the agent does that, once, for real
   * (non-worker) turns so the UI/extension only ever track visible conversations.
   */
  runWithConversation<T>(id: string | null, fn: () => Promise<T>): Promise<T> {
    return this.conversationCtx.run(id, fn)
  }

  /**
   * Register an in-process capability that doesn't live on disk. Used
   * by core channels (currently Telegram) to expose channel-specific
   * tools to the LLM as if they were a regular cerebellum capability.
   * Replaces any prior registration of the same name so callers can
   * re-register on lifecycle changes (bot restart with a new config)
   * without leaking stale handlers.
   *
   * Caller is responsible for calling unregisterInProcessCapability
   * when the underlying resource (bot) shuts down — otherwise the LLM
   * keeps seeing tools it can no longer execute.
   */
  registerInProcessCapability(capability: Capability, plugin: WolffishPlugin): void {
    // Drop tool ownership from any prior registration so the new one wins.
    const prior = this.capabilities.get(capability.name)
    if (prior) {
      for (const tool of prior.tools) {
        if (this.toolToCapability.get(tool.name) === capability.name) {
          this.toolToCapability.delete(tool.name)
        }
      }
    }
    this.capabilities.set(capability.name, { ...capability, inProcess: true })
    this.plugins.set(capability.name, plugin)
    for (const tool of capability.tools) {
      this.toolToCapability.set(tool.name, capability.name)
    }
    // The tool surface changed: let a turn already in flight re-pin its
    // prompt + tool list on the next loop iteration (same mechanism as
    // skill_create / setDisabled).
    this.generation++
  }

  /**
   * Remove an in-process capability registered via
   * registerInProcessCapability. Idempotent.
   */
  unregisterInProcessCapability(name: string): void {
    const cap = this.capabilities.get(name)
    if (!cap) return
    for (const tool of cap.tools) {
      if (this.toolToCapability.get(tool.name) === name) {
        this.toolToCapability.delete(tool.name)
      }
    }
    this.capabilities.delete(name)
    this.plugins.delete(name)
    this.generation++
  }

  /**
   * Discover and load every capability in brain/cerebellum/. Idempotent:
   * a second call after a successful load is a no-op. Errors loading any
   * single capability are logged but never throw — the agent continues
   * with whatever loaded.
   */
  async loadAll(): Promise<{ capabilities: Capability[] }> {
    if (this.loaded) return { capabilities: [...this.capabilities.values()] }
    // The built-in discovery capability (tool_search / tool_activate) exists
    // regardless of what — if anything — loads from disk: it is the bootstrap
    // tool the lean surface depends on. Registered before the disk scan so
    // every loadAll exit path has it.
    this.registerDiscoveryCapability()
    this.registerTodoCapability()
    this.registerCloseTurnCapability()
    this.registerChangesCapability()
    const root = this.options.workspaceRoot
    if (!root) {
      this.loaded = true
      return { capabilities: [...this.capabilities.values()] }
    }
    const dir = path.join(root, 'brain', 'cerebellum')
    let entries: Array<import('node:fs').Dirent>
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      this.loaded = true
      return { capabilities: [...this.capabilities.values()] }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // Bundled capabilities live in dot-prefixed folders (.git, .browser, …)
      // so they're hidden in `ls` but still load. Don't skip them.
      const capDir = path.join(dir, entry.name)
      try {
        const cap = await this.loadCapability(capDir, entry.name)
        if (cap) this.capabilities.set(cap.name, cap)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.capabilities.set(entry.name, {
          name: entry.name,
          dir: capDir,
          description: '',
          triggers: { keywords: [] },
          tools: [],
          body: '',
          hasPlugin: false,
          status: 'error',
          error: message,
          requires: [],
          packages: {},
          npmDependencies: {}
        })
      }
    }

    this.loaded = true
    return { capabilities: [...this.capabilities.values()] }
  }

  /**
   * One-line-per-capability index the prefrontal folds into the system
   * prompt in place of the old full `<tools>` catalog. The model always
   * KNOWS what exists (name + short description + tool count) without
   * carrying schemas; `tool_search` activates a capability on demand.
   * Exposed (core/pinned/activated) capabilities are marked `[loaded]` so
   * the model can tell which tools are callable right now. Past
   * CAPABILITY_INDEX_MAX_LINES the unloaded remainder collapses to a
   * grouped count so prompt cost stays O(1) in installed-capability count.
   */
  getCapabilityIndex(exclude?: ReadonlySet<string>, conversationId?: string | null): string {
    const key = this.activeKey(conversationId)
    const loaded: string[] = []
    const unloaded: string[] = []
    let collapsedCaps = 0
    let collapsedTools = 0
    const describe = (cap: Capability): string => {
      const desc = oneLineDescription(cap.description, 90)
      const kind = cap.tools.length > 0 ? `${cap.tools.length} tools` : 'guide'
      return `- ${cap.name} (${kind}) — ${desc}`
    }
    for (const cap of this.capabilities.values()) {
      if (cap.status !== 'ok') continue
      if (this.disabled.has(cap.name)) continue
      if (exclude?.has(cap.name)) continue
      if (cap.tools.length === 0 && !cap.body) continue
      if (cap.tools.length > 0 && this.isExposed(cap.name, key)) {
        loaded.push(`${describe(cap)} [loaded]`)
      } else if (unloaded.length < CAPABILITY_INDEX_MAX_LINES) {
        unloaded.push(describe(cap))
      } else {
        collapsedCaps++
        collapsedTools += cap.tools.length
      }
    }
    const lines = [...loaded, ...unloaded]
    if (collapsedCaps > 0) {
      lines.push(
        `- …plus ${collapsedCaps} more capabilities (${collapsedTools} tools) — tool_search finds any of them`
      )
    }
    return lines.join('\n')
  }

  /**
   * Structured tool definitions handed to the LLM API call. Tools from
   * pure-skill capabilities (no plugin) are filtered out — the LLM should
   * only see what can actually execute.
   *
   * Without `opts`, returns EVERY enabled capability's tools (management
   * surfaces, counts). The agent loop passes `{ conversationId }` to get the
   * per-conversation exposed set: core + pinned + capabilities activated via
   * tool_search — the lean surface that actually ships to the provider.
   */
  getToolDefinitions(
    exclude?: ReadonlySet<string>,
    opts?: { conversationId?: string | null }
  ): ToolDefinition[] {
    const key = opts ? this.activeKey(opts.conversationId) : null
    const out: ToolDefinition[] = []
    for (const cap of this.capabilities.values()) {
      if (cap.status !== 'ok') continue
      if (!cap.hasPlugin) continue
      if (this.disabled.has(cap.name)) continue
      if (exclude?.has(cap.name)) continue
      if (key !== null && !this.isExposed(cap.name, key)) continue
      for (const tool of cap.tools) {
        out.push({
          name: tool.name,
          description: tool.description,
          parameters: toJSONSchema(tool.parameters)
        })
      }
    }
    return out
  }

  // ── Active toolset (conversation-scoped tool discovery) ──────────────

  /**
   * Wire extra always-exposed capabilities from config.pinnedCapabilities.
   * Set once at startup — the escape hatch for tuning the core set without
   * a code change.
   */
  setPinnedCapabilities(names: string[]): void {
    this.pinnedCapabilities = new Set(names)
    this.generation++
  }

  /**
   * Toolset version for one conversation: global generation (capability
   * reloads, MCP connects, skill toggles) plus that conversation's private
   * activation counter. The agent's per-turn pin compares THIS — so an
   * activation in a heartbeat run never invalidates a live chat's pinned
   * tools (and its provider prompt cache) and vice versa.
   */
  getToolsetVersion(conversationId?: string | null): number {
    const set = this.activeSets.get(this.activeKey(conversationId))
    return this.generation + (set?.version ?? 0)
  }

  /**
   * Expose a capability's tools to one conversation. Idempotent; core and
   * pinned capabilities are always exposed. Bounded by an LRU: the least
   * recently USED activation is dropped past ACTIVE_SET_MAX — invisible to
   * the model because a call to an evicted tool auto-reactivates it.
   */
  activateCapability(
    name: string,
    conversationId?: string | null
  ): { ok: boolean; error?: string } {
    const cap = this.capabilities.get(name)
    if (!cap || cap.status !== 'ok') {
      return { ok: false, error: `no capability named "${name}"` }
    }
    if (this.disabled.has(name)) {
      return { ok: false, error: `capability "${name}" is disabled (skill_enable to turn it on)` }
    }
    const key = this.activeKey(conversationId)
    if (CORE_CAPABILITIES.has(name) || this.pinnedCapabilities.has(name)) {
      return { ok: true }
    }
    let set = this.activeSets.get(key)
    if (!set) {
      set = { names: new Set(), version: 0, lastUsed: new Map() }
      this.activeSets.set(key, set)
    }
    set.lastUsed.set(name, Date.now())
    if (set.names.has(name)) return { ok: true }
    set.names.add(name)
    if (set.names.size > ACTIVE_SET_MAX) {
      let oldest: string | null = null
      let oldestAt = Infinity
      for (const n of set.names) {
        if (n === name) continue
        const at = set.lastUsed.get(n) ?? 0
        if (at < oldestAt) {
          oldestAt = at
          oldest = n
        }
      }
      if (oldest) set.names.delete(oldest)
    }
    set.version++
    return { ok: true }
  }

  /** True when a capability's tools ship to this conversation's requests. */
  private isExposed(capName: string, key: string): boolean {
    if (CORE_CAPABILITIES.has(capName)) return true
    if (this.pinnedCapabilities.has(capName)) return true
    return this.activeSets.get(key)?.names.has(capName) ?? false
  }

  private activeKey(conversationId?: string | null): string {
    return conversationId ?? this.getCurrentConversationId() ?? '(none)'
  }

  /** Refresh a capability's LRU stamp when one of its tools actually runs. */
  private touchCapabilityUse(capName: string): void {
    const set = this.activeSets.get(this.activeKey())
    if (set?.names.has(capName)) set.lastUsed.set(capName, Date.now())
  }

  /**
   * Score every capability (and pure skill) against a query — the engine
   * behind tool_search. Deterministic term matching over name, description,
   * trigger keywords, and tool names/descriptions.
   */
  searchCapabilities(query: string, limit = 5): Array<{ cap: Capability; score: number }> {
    const terms = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((t) => t.length >= 3)
    if (terms.length === 0) return []
    const scored: Array<{ cap: Capability; score: number }> = []
    for (const cap of this.capabilities.values()) {
      if (cap.status !== 'ok') continue
      if (this.disabled.has(cap.name)) continue
      const name = cap.name.toLowerCase()
      const desc = cap.description.toLowerCase()
      const triggers = cap.triggers.keywords.join(' ').toLowerCase()
      const toolNames = cap.tools
        .map((t) => t.name)
        .join(' ')
        .toLowerCase()
      const toolDescs = cap.tools
        .map((t) => t.description)
        .join(' ')
        .toLowerCase()
      let score = 0
      for (const term of terms) {
        if (name.includes(term)) score += 4
        if (toolNames.includes(term)) score += 3
        if (triggers.includes(term)) score += 2
        if (desc.includes(term)) score += 2
        if (toolDescs.includes(term)) score += 1
      }
      if (score > 0) scored.push({ cap, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  /**
   * True when the tool declared `readOnly: true` in its frontmatter — it
   * observes without changing anything outside the conversation. Consumers:
   * the agent loop's parallel read batches and the read-only turn gate.
   * Unknown tools are mutating.
   */
  isReadOnlyTool(toolName: string): boolean {
    const capName = this.toolToCapability.get(toolName)
    if (!capName) return false
    const cap = this.capabilities.get(capName)
    return cap?.tools.find((t) => t.name === toolName)?.readOnly === true
  }

  /**
   * Whether ONE call observes without changing anything: the tool's
   * frontmatter `readOnly` flag, else the plugin's per-call judgement
   * (`isReadOnlyCall`), else mutating. A read-only turn refuses every call
   * this returns false for. Loads the plugin if needed (an import, never a
   * dependency install).
   */
  async isReadOnlyCall(toolName: string, args: Record<string, unknown>): Promise<boolean> {
    if (this.isReadOnlyTool(toolName)) return true
    const capName = this.toolToCapability.get(toolName)
    if (!capName) return false
    const cap = this.capabilities.get(capName)
    if (!cap || cap.status !== 'ok') return false
    let plugin = this.plugins.get(capName)
    if (!plugin && !cap.inProcess) {
      await this.ensurePluginLoaded(cap).catch(() => undefined)
      plugin = this.plugins.get(capName)
    }
    if (!plugin?.isReadOnlyCall) return false
    try {
      return (await plugin.isReadOnlyCall(toolName, args)) === true
    } catch {
      return false
    }
  }

  /**
   * True when a call to `toolName` would execute without any dependency
   * work — capability loaded, plugin imported, dependency chain already
   * resolved this process. The agent loop only pre-starts read-only calls
   * that are ready, so a first call that must install or approve something
   * keeps its sequential slot and its dialogs in order.
   */
  isToolReady(toolName: string): boolean {
    const capName = this.toolToCapability.get(toolName)
    if (!capName) return false
    const cap = this.capabilities.get(capName)
    if (!cap || cap.status !== 'ok') return false
    if (cap.inProcess) return true
    return this.plugins.has(capName) && this.dependencyCache.get(capName) === true
  }

  /**
   * Register the built-in `changes` capability: the undo for file edits.
   * The Agent snapshots a file before the first mutating file tool touches
   * it in a turn (see snapshots.ts); these tools list the turns and put the
   * files back. Model-led — "that made it worse, put it back" — with no
   * git dependency, so it works in any folder.
   */
  private registerChangesCapability(): void {
    const plugin: WolffishPlugin = {
      name: 'changes',
      tools: [],
      execute: async (toolName, args) => {
        const conversationId = this.getCurrentConversationId()
        if (!conversationId) {
          return { success: false, error: 'No conversation in flight — nothing to list or revert.' }
        }
        if (toolName === 'changes_list') {
          const turns = await this.snapshots.list(conversationId)
          if (turns.length === 0)
            return { success: true, output: 'No file changes recorded in this conversation.' }
          const lines = turns.map((t, i) => {
            const files = Object.entries(t.files)
              .map(
                ([file, e]) =>
                  `    ${e.blob === null && e.size === 0 && !e.skipped ? 'created' : e.skipped ? 'not restorable' : 'edited '} ${file}`
              )
              .join('\n')
            return `${i === 0 ? '[latest] ' : ''}turn ${t.turnId} (${new Date(t.startedAt).toISOString()}):\n${files}`
          })
          return {
            success: true,
            output: `${lines.join('\n')}\n\nchanges_revert restores a turn's files to their state before that turn (turn=latest or a turn id above; path narrows it to one file).`
          }
        }
        if (toolName === 'changes_revert') {
          const turns = await this.snapshots.list(conversationId)
          if (turns.length === 0)
            return { success: false, error: 'No file changes recorded in this conversation.' }
          const wanted =
            typeof args?.turn === 'string' && args.turn !== 'latest' ? args.turn : turns[0].turnId
          const turn = turns.find((t) => t.turnId === wanted)
          if (!turn)
            return {
              success: false,
              error: `No recorded changes for turn ${wanted}. changes_list shows the turns.`
            }
          const only = typeof args?.path === 'string' && args.path ? args.path : undefined
          const result = await this.snapshots.revert(conversationId, turn.turnId, only)
          const parts: string[] = []
          if (result.restored.length)
            parts.push(`Restored:\n${result.restored.map((f) => `  ${f}`).join('\n')}`)
          if (result.deleted.length)
            parts.push(
              `Deleted (did not exist before the turn):\n${result.deleted.map((f) => `  ${f}`).join('\n')}`
            )
          if (result.skipped.length)
            parts.push(`Skipped:\n${result.skipped.map((f) => `  ${f}`).join('\n')}`)
          if (parts.length === 0)
            return {
              success: false,
              error: only ? `That turn did not touch ${only}.` : 'Nothing to revert.'
            }
          return { success: true, output: parts.join('\n'), meta: { label: 'Revert changes' } }
        }
        return { success: false, error: `changes: unknown tool ${toolName}` }
      }
    }
    this.registerInProcessCapability(
      {
        name: 'changes',
        dir: '',
        description:
          'Undo for file changes: list the files each turn of this conversation edited or created, and restore them to their pre-turn state.',
        triggers: {
          keywords: ['undo', 'revert', 'put it back', 'restore file', 'rollback change']
        },
        tools: [
          {
            name: 'changes_list',
            readOnly: true,
            description:
              'List the file changes recorded in this conversation, newest turn first: which files each turn edited or created. Every file_edit / file_write is snapshotted before the first change of a turn, so this is the record changes_revert restores from.',
            parameters: {}
          },
          {
            name: 'changes_revert',
            description:
              'Restore files to their state before a turn: edited files get their original bytes back, files the turn created are deleted. Default turn=latest; pass a turn id from changes_list, and path to revert a single file. Use it when a change made things worse and the user (or you) wants the previous state back — then re-run the check to confirm.',
            parameters: {
              turn: {
                type: 'string',
                required: false,
                description: '"latest" (default) or a turn id from changes_list'
              },
              path: {
                type: 'string',
                required: false,
                description: 'Revert only this file (absolute path as listed)'
              }
            }
          }
        ],
        body: '',
        hasPlugin: true,
        status: 'ok',
        requires: [],
        packages: {},
        npmDependencies: {}
      },
      plugin
    )
  }

  /**
   * Register the built-in `todo` capability: the model's task list for
   * multi-step work (OpenCode's todowrite, generalised beyond coding). The
   * tool validates and echoes the list; the Agent turns a successful call
   * into a `todo` segment so the feed shows one checklist card per turn.
   * Read-only by declaration: it changes nothing outside the conversation,
   * so a plan-mode turn may keep its list.
   */
  private registerTodoCapability(): void {
    const statuses = new Set(['pending', 'in_progress', 'completed', 'cancelled'])
    const priorities = new Set(['high', 'medium', 'low'])
    const plugin: WolffishPlugin = {
      name: 'todo',
      tools: [],
      execute: async (toolName, args) => {
        if (toolName !== 'todo_write')
          return { success: false, error: `todo: unknown tool ${toolName}` }
        const raw = args?.todos
        if (!Array.isArray(raw)) {
          return {
            success: false,
            error: 'todos must be an array of { content, status, priority? }.'
          }
        }
        const items: Array<{ content: string; status: string; priority?: string }> = []
        const problems: string[] = []
        raw.forEach((entry, i) => {
          if (!entry || typeof entry !== 'object') {
            problems.push(`item ${i + 1} is not an object`)
            return
          }
          const e = entry as Record<string, unknown>
          const content = typeof e.content === 'string' ? e.content.trim() : ''
          if (!content) {
            problems.push(`item ${i + 1} has no content`)
            return
          }
          const status = typeof e.status === 'string' ? e.status : 'pending'
          if (!statuses.has(status)) {
            problems.push(
              `item ${i + 1} has unknown status "${status}" (pending | in_progress | completed | cancelled)`
            )
            return
          }
          const item: { content: string; status: string; priority?: string } = { content, status }
          if (typeof e.priority === 'string' && priorities.has(e.priority))
            item.priority = e.priority
          items.push(item)
        })
        if (problems.length > 0) return { success: false, error: problems.join('; ') }
        const inProgress = items.filter((t) => t.status === 'in_progress').length
        const done = items.filter((t) => t.status === 'completed').length
        const note =
          inProgress > 1
            ? `\nNote: ${inProgress} items are in_progress — keep exactly one in progress at a time.`
            : ''
        return {
          success: true,
          output: `${items.length} todos (${done} completed, ${inProgress} in progress)${note}\n${JSON.stringify(items, null, 2)}`
        }
      }
    }
    this.registerInProcessCapability(
      {
        name: 'todo',
        dir: '',
        description:
          'Your task list for multi-step work: todo_write keeps a checklist the user sees as a card and you update as you go.',
        triggers: { keywords: ['todo', 'task list', 'checklist', 'plan steps', 'track progress'] },
        tools: [
          {
            name: 'todo_write',
            readOnly: true,
            description: [
              'Create and maintain a structured task list for the current piece of work — a bug fix, a feature, a research task, a document, a data cleanup. Tracks progress, organizes multi-step work, and surfaces status to the user as a checklist card that updates in place.',
              '',
              'Use it proactively when: the task needs 3+ distinct steps (not 3 tool calls for one step); the work is non-trivial and benefits from planning; the user gave several tasks or asked for a list; new instructions arrive mid-task (capture them); you start a step (mark it in_progress, exactly ONE at a time); you finish a step (mark it completed and add follow-ups you discovered).',
              'Skip it when: the work is one straightforward step (or fewer than 3 trivial ones); the request is informational or conversational; tracking adds nothing.',
              '',
              'States: pending (not started) · in_progress (exactly ONE at a time) · completed (finished) · cancelled (no longer needed).',
              'Rules: update status in real time, never batch completions; mark completed ONLY after the work is actually done, including any verification it needed — never on intent; keep exactly one in_progress while work remains; if blocked or partial, keep it in_progress and add a follow-up todo naming the blocker; preserve user-provided commands verbatim; items are specific and actionable — break big work into smaller steps.',
              'Each call REPLACES the whole list, so send every item every time. When in doubt, use it.',
              "The list is the user's progress bar on every surface (app, phone, terminal), so it is never left stale: write a step's completion the moment it lands, before starting the next one, and make your last todo_write of the turn carry the true final state — the runtime will not let a turn end with items you actually finished still open.",
              'A list left unfinished by an earlier turn (an interrupted run) is yours to carry on: the runtime tells you what is still open, and your next todo_write updates THAT card in place — so when you finish that work, write the list with those items completed. Pass fresh: true only when this turn starts unrelated work that deserves its own list.'
            ].join('\n'),
            parameters: {
              fresh: {
                type: 'boolean',
                required: false,
                description:
                  'Start a separate list instead of continuing the open list from an earlier turn (default false).'
              },
              todos: {
                type: 'array',
                required: true,
                description: 'The complete, updated task list.',
                items: {
                  type: 'object',
                  properties: {
                    content: {
                      type: 'string',
                      description: 'Brief, specific description of the step'
                    },
                    status: {
                      type: 'string',
                      enum: ['pending', 'in_progress', 'completed', 'cancelled'],
                      description: 'pending | in_progress (exactly one) | completed | cancelled'
                    },
                    priority: {
                      type: 'string',
                      enum: ['high', 'medium', 'low'],
                      description: 'Optional priority'
                    }
                  },
                  required: ['content', 'status']
                }
              }
            }
          }
        ],
        body: '',
        hasPlugin: true,
        status: 'ok',
        requires: [],
        packages: {},
        npmDependencies: {}
      },
      plugin
    )
  }

  /**
   * Register the built-in `close_turn` tool: the model's explicit, producible
   * way to say "everything is delivered and nothing further is needed".
   *
   * It exists because the alternative was impossible. The runtime tail used to
   * ask the model to "end with an entirely empty response — zero characters",
   * and no OpenAI-compatible provider carries an empty assistant content
   * channel (the same constraint that makes Agent.ts skip pushing an empty
   * assistant message). A model that had genuinely finished therefore had no
   * way to obey: it reached for the smallest stand-in it could type and
   * shipped it to the user as real text. Documented leaks of exactly that
   * shape: `(no output)`, `(no content)`, `[Empty response]`, `(empty —
   * nothing further)`, and the Chinese `空空如也`.
   *
   * A tool call is a normal, producible token sequence, so this gives the
   * model a legal exit that costs nothing and needs no special provider
   * support. The Agent sees the call and ends the turn; the content channel
   * ends at the model's last real character, exactly as intended, with no
   * post-processing anywhere.
   *
   * Declared read-only: it changes nothing outside the conversation, so a
   * plan-mode or explore turn may use it too — refusal to close would be worse
   * than useless there. The plugin execute() is a no-op returning success; the
   * Agent intercepts the call before dispatch, so nothing is ever recorded as
   * a task step.
   */
  private registerCloseTurnCapability(): void {
    const plugin: WolffishPlugin = {
      name: 'close-turn',
      tools: [],
      execute: async (toolName) => {
        if (toolName !== 'close_turn')
          return { success: false, error: `close-turn: unknown tool ${toolName}` }
        return { success: true, output: 'Turn closed.' }
      }
    }
    this.registerInProcessCapability(
      {
        name: 'close-turn',
        dir: '',
        description:
          'End the turn when everything the user needs is already said and delivered — the explicit, correct way to say "nothing further".',
        triggers: { keywords: ['close turn', 'nothing further', 'nothing to add'] },
        tools: [
          {
            name: 'close_turn',
            readOnly: true,
            description: [
              'End the turn with no further message to the user, when everything they need is already said and delivered — your closing reply already went out, a card or file you produced is the answer, or the work is handed back.',
              '',
              'This is the correct, explicit way to say "nothing further". Calling it ends the turn immediately and cleanly; your content up to this point is exactly what the user receives.',
              '',
              'Use it when: your reply and any files/notifications for this turn are already delivered and a further message would only repeat them or pad. Do NOT call it while the user still needs something you have not said — a wrap-up, an answer, a next step — and never as a shortcut past work that is not finished.',
              '',
              'Never write a stand-in for silence instead: no bracketed note, no lone punctuation mark, no word or set phrase meaning "empty" or "nothing further" in any language. Anything you write is delivered to the user verbatim as a message; calling this tool is not.'
            ].join('\n'),
            parameters: {}
          }
        ],
        body: '',
        hasPlugin: true,
        status: 'ok',
        requires: [],
        packages: {},
        npmDependencies: {}
      },
      plugin
    )
  }

  /**
   * Register the built-in `tool-discovery` capability (tool_search /
   * tool_activate). In-process like the channel/MCP capabilities, part of
   * the core set, and implemented over this cerebellum's own registry —
   * activation bumps only the calling conversation's toolset version, so
   * the new tools are callable on the very next loop iteration.
   */
  private registerDiscoveryCapability(): void {
    const describeMatch = (cap: Capability, exposed: boolean): string => {
      const head = `## ${cap.name}${exposed ? ' [loaded]' : ''} — ${oneLineDescription(cap.description, 120)}`
      if (cap.tools.length === 0) {
        return `${head}\n(guide only — read it with skill_read_source or ask skills to show it)`
      }
      const shown = cap.tools.slice(0, 8)
      const lines = shown.map((t) => `- \`${t.name}\` — ${oneLineDescription(t.description, 100)}`)
      if (cap.tools.length > shown.length) {
        lines.push(`- …and ${cap.tools.length - shown.length} more`)
      }
      return `${head}\n${lines.join('\n')}`
    }
    const plugin: WolffishPlugin = {
      name: 'tool-discovery',
      tools: [],
      execute: async (toolName, args) => {
        if (toolName === 'tool_search') {
          const query = typeof args?.query === 'string' ? args.query.trim() : ''
          if (!query) {
            return { success: false, error: 'Provide a query describing what you need to do.' }
          }
          const matches = this.searchCapabilities(query, 5)
          if (matches.length === 0) {
            return {
              success: true,
              output:
                `No capability matches "${query}". Try different words (tool_search is term-based) — ` +
                'and only fall back to shell_exec after 2-3 rephrasings find nothing.'
            }
          }
          const key = this.activeKey(null)
          const top = matches.find((m) => m.cap.tools.length > 0)
          let activationNote = ''
          if (top && !this.isExposed(top.cap.name, key)) {
            const res = this.activateCapability(top.cap.name)
            if (res.ok) {
              activationNote = `Activated \`${top.cap.name}\` — its tools are callable now. `
            }
          } else if (top) {
            activationNote = `\`${top.cap.name}\` is already loaded. `
          }
          const blocks = matches.map((m) => describeMatch(m.cap, this.isExposed(m.cap.name, key)))
          return {
            success: true,
            output: `${activationNote}tool_activate(<name>) loads any other match.\n\n${blocks.join('\n\n')}`
          }
        }
        if (toolName === 'tool_activate') {
          const name = typeof args?.capability === 'string' ? args.capability.trim() : ''
          if (!name)
            return {
              success: false,
              error: 'Provide `capability` (a name from tool_search or the capability index).'
            }
          const cap = this.capabilities.get(name)
          const res = this.activateCapability(name)
          if (!res.ok || !cap) {
            return {
              success: false,
              error: `${res.error ?? `no capability named "${name}"`}. tool_search to find the right name.`
            }
          }
          return {
            success: true,
            output: `Loaded \`${name}\`.\n\n${describeMatch(cap, true)}`
          }
        }
        return { success: false, error: `tool-discovery: unknown tool ${toolName}` }
      }
    }
    this.registerInProcessCapability(
      {
        name: 'tool-discovery',
        dir: '',
        description:
          'Find and load tools on demand. The capability index in your prompt lists what exists; tool_search/tool_activate make a capability callable.',
        triggers: { keywords: [] },
        tools: [
          {
            name: 'tool_search',
            description:
              'Search every installed capability (including MCP servers) by what you need to do, and auto-load the best match so its tools become callable this turn. Use BEFORE assuming a tool does not exist and BEFORE reaching for shell — try 2-3 phrasings.',
            parameters: {
              query: {
                type: 'string',
                required: true,
                description: 'What you need to do (e.g. "resize a video", "create github issue").'
              }
            }
          },
          {
            name: 'tool_activate',
            description:
              'Load a specific capability by name (from the capability index or a tool_search result) so its tools become callable this turn.',
            parameters: {
              capability: {
                type: 'string',
                required: true,
                description: 'Exact capability name, e.g. "ffmpeg", "github", "mcp-zapier-com".'
              }
            }
          }
        ],
        body: '',
        hasPlugin: true,
        status: 'ok',
        requires: [],
        packages: {},
        npmDependencies: {}
      },
      plugin
    )
  }

  /**
   * Find the plugin that owns this tool name and call its execute method.
   * Returns a structured failure when the tool is unknown rather than
   * throwing, so the LLM can see the error and recover.
   */
  async executeTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    toolCallId?: string
  ): Promise<ToolExecutionResult> {
    // Expose the toolCallId to plugins that ask the user a question (the
    // `ask` capability anchors its card to it). ALS follows this call's
    // async tree only, so nested executeTool invocations (dependency checks)
    // and concurrent turns' tool calls each resolve their own id.
    if (toolCallId) {
      try {
        return await this.toolCallCtx.run(toolCallId, () =>
          this.executeToolInner(name, args, signal)
        )
      } finally {
        this.toolProgress.delete(toolCallId)
      }
    }
    return this.executeToolInner(name, args, signal)
  }

  /** The latest progress a running tool reported for this call, if any. */
  getToolProgress(toolCallId: string): string | (() => string) | null {
    return this.toolProgress.get(toolCallId) ?? null
  }

  private progressReporter(): (value: string | (() => string)) => void {
    const id = this.toolCallCtx.getStore() ?? null
    if (!id) return () => undefined
    return (value) => {
      this.toolProgress.set(id, value)
    }
  }

  private async executeToolInner(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<ToolExecutionResult> {
    const capName = this.toolToCapability.get(name)
    if (!capName) {
      // Deterministic and instructive — a retry would fail identically, and
      // under lean tool exposure "unknown" usually means "not discovered yet".
      return {
        success: false,
        error: `unknown tool: ${name}. Not every tool is preloaded — tool_search("what you need to do") finds and loads the right capability.`
      }
    }
    if (this.disabled.has(capName)) {
      return { success: false, error: `capability "${capName}" is disabled` }
    }
    // Transparent auto-activation: the model may call a tool it knows from
    // the capability index, an earlier conversation, or after LRU eviction.
    // The plugin is loaded either way — expose the capability to this
    // conversation so the NEXT pin ships its schemas too.
    this.activateCapability(capName)
    this.touchCapabilityUse(capName)
    let plugin = this.plugins.get(capName)
    if (!plugin) {
      // Plugin is registered but not yet loaded. This path runs when a tool
      // is invoked without going through ensureDependencies first — e.g.
      // dependency check tools called from within ensureDependencies, or
      // any path that bypasses the agent loop. Trigger the same lazy
      // sequence: install npm deps if needed, then import the plugin.
      const cap = this.capabilities.get(capName)
      if (!cap) return { success: false, error: `no capability for tool: ${name}` }
      try {
        await this.ensureNpmDependencies(cap)
        await this.ensurePluginLoaded(cap)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { success: false, error: message }
      }
      plugin = this.plugins.get(capName)
      if (!plugin) {
        return { success: false, error: `no plugin loaded for tool: ${name}` }
      }
    }
    try {
      // Normalize whatever the plugin returned into a proper
      // ToolExecutionResult. Plugins authored at runtime (the `skills`
      // capability) commonly return a bare string or put their payload on a
      // non-standard field (`return { result }` instead of `{ success, output }`);
      // without this, a successful call renders an EMPTY tool card and the model
      // can't see what happened. Well-formed results pass through untouched.
      const result = normalizeToolResult(await plugin.execute(name, args, signal))
      // A successful *_install can place a binary on the persistent PATH that
      // this long-lived process didn't inherit (Windows: a new registry entry;
      // macOS/Linux: a brand-new bin dir such as a first Homebrew install).
      // Re-read PATH so the next tool — in ANY capability, since process.env.PATH
      // is shared by every plugin spawn — finds it without an app restart. This
      // is the central counterpart to the refreshPath() in ensureDependencies:
      // that covers auto-resolved dependency installs, this covers a direct
      // *_install tool call. Centralized here so every install tool is covered on
      // every OS, not just the few plugins that self-refresh.
      if (result.success && name.endsWith('_install')) {
        refreshPath()
      }
      // A Wolffish-authored skill earns its "tested" state here — the first
      // successful REAL call of one of its tools since creation/last edit.
      // Observed by the framework, driven by the model: the create flow tells
      // the model to test immediately, and this is what clears the badge.
      if (result.success) {
        await this.markCapabilityTested(capName)
      }
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: message }
    }
  }

  /**
   * Stamp a Wolffish-authored capability as tested after a successful tool
   * call. Writes the marker (hash of SKILL.md + plugin entry, so any later
   * edit invalidates it), flips the in-memory flag, and announces the change
   * so the settings panel can refresh its badge live. Best-effort — a failed
   * stamp never fails the tool call; the skill just stays "untested" until
   * the next successful call retries it. No-op for everything that isn't a
   * currently-untested Wolffish-authored plugin capability.
   */
  private async markCapabilityTested(capName: string): Promise<void> {
    const cap = this.capabilities.get(capName)
    if (!cap || cap.tested !== false || !cap.pluginEntryPath) return
    try {
      const skillMd = await fs.readFile(path.join(cap.dir, 'SKILL.md'), 'utf8')
      const pluginSource = await fs.readFile(cap.pluginEntryPath, 'utf8')
      await diskWriter.writeFileAtomic(
        path.join(cap.dir, TESTED_MARKER_FILE),
        hashString(`${skillMd}\0${pluginSource}`)
      )
      cap.tested = true
      this.options.corpus?.emit('capability.tested', { capability: capName })
    } catch {
      // best-effort — stays untested, next successful call tries again
    }
  }

  /**
   * Look up which capability owns a given tool name.
   */
  getToolCapability(toolName: string): string | undefined {
    return this.toolToCapability.get(toolName)
  }

  /**
   * Walk the `requires` chain for a capability and ensure every dependency
   * is installed. Each missing dependency is installed through amygdala
   * (which prompts the user). The capability itself is NOT auto-installed —
   * if the LLM is calling an _install tool, that's the install. This only
   * resolves transitive prerequisites.
   *
   * Cache is per-session: once a dependency is satisfied we never re-check
   * it on this run. Recursion is capped at depth 3 to break cycles.
   *
   * @param capabilityName - The capability whose `requires` chain to resolve
   * @param hook - Optional segment emitter so synthetic install tool calls
   *   surface as cards in the renderer (without it, the approval card has
   *   nowhere to render and the user sees nothing)
   * @param depth - Internal recursion depth tracker
   * @throws When a dependency install fails or the user denies it
   */
  async ensureDependencies(
    capabilityName: string,
    hook?: DependencyEmitHook,
    depth = 0
  ): Promise<void> {
    if (this.dependencyCache.get(capabilityName)) return
    return this.singleFlight(capabilityName, () =>
      this.ensureDependenciesInner(capabilityName, hook, depth)
    )
  }

  /**
   * Single-flight per capability/dependency NAME (any depth): two concurrent
   * turns needing the same uninstalled dependency — directly OR transitively
   * (pdf and browser both require node; the STT/TTS pair shares ffmpeg) —
   * must not race duplicate approval dialogs and parallel brew/npm
   * installers. The second caller awaits the first resolution (approval
   * dialogs and all). A rejected flight is evicted immediately (the .finally)
   * so the next caller retries fresh in its own context. A sealed background
   * run never PUBLISHES a flight — its approval-less context would deny the
   * install and poison a concurrent foreground caller waiting on it — but it
   * still awaits an existing foreground flight.
   */
  private singleFlight(name: string, work: () => Promise<void>): Promise<void> {
    const inflight = this.dependencyInflight.get(name)
    if (inflight) return inflight
    if (turnScope.getStore()?.autonomous) return work()
    const flight = work().finally(() => {
      this.dependencyInflight.delete(name)
    })
    this.dependencyInflight.set(name, flight)
    return flight
  }

  private async ensureDependenciesInner(
    capabilityName: string,
    hook?: DependencyEmitHook,
    depth = 0
  ): Promise<void> {
    if (depth > 3) {
      throw new Error(
        `Dependency depth exceeded (max 3) resolving "${capabilityName}". Possible circular dependency.`
      )
    }

    const cap = this.capabilities.get(capabilityName)
    if (!cap) {
      // Unknown capability — nothing we can resolve. Don't throw; the
      // caller may be a tool from a plugin that didn't declare a SKILL.md.
      this.dependencyCache.set(capabilityName, true)
      return
    }
    if (cap.status !== 'ok') {
      throw new Error(`Capability "${capabilityName}" failed to load: ${cap.error}`)
    }

    // Resolve transitive system-tool requires first (e.g. node, ffmpeg).
    // This may trigger amygdala-gated installs.
    for (const depName of cap.requires) {
      this.options.corpus?.emit('dependency.checking', {
        capability: capabilityName,
        dependency: depName
      })

      if (this.dependencyCache.get(depName)) {
        this.options.corpus?.emit('dependency.satisfied', {
          capability: capabilityName,
          dependency: depName,
          cached: true
        })
        continue
      }

      // First resolve the dependency's own requires (transitive chain)
      await this.ensureDependencies(depName, hook, depth + 1)

      // Now check if the dependency itself is installed
      const depCap = this.capabilities.get(depName)
      if (!depCap || depCap.status !== 'ok') {
        throw new Error(
          `Cannot use ${capabilityName} — required capability "${depName}" is not loaded`
        )
      }

      // Single-flight the check→install of the dependency ITSELF, keyed by
      // the dependency name. Two concurrent turns whose capabilities share a
      // transitive dependency (pdf + browser both require node) would
      // otherwise both pass the cache check above and race duplicate
      // approval dialogs and parallel installers.
      await this.singleFlight(`dep:${depName}`, async () => {
        // Another flight may have satisfied it while we queued.
        if (this.dependencyCache.get(depName)) return

        const checkTool = depCap.tools.find((t) => t.name.endsWith('_check'))
        if (!checkTool) {
          // No check tool means the dependency is a pure logical capability
          // (no installable software). Treat as satisfied.
          this.dependencyCache.set(depName, true)
          this.options.corpus?.emit('dependency.satisfied', {
            capability: capabilityName,
            dependency: depName,
            cached: false
          })
          return
        }

        const checkResult = await this.executeTool(checkTool.name, {})
        const parsed = checkResult.success ? safeJsonParse(checkResult.output) : null

        if (parsed?.installed) {
          this.dependencyCache.set(depName, true)
          this.options.corpus?.emit('dependency.satisfied', {
            capability: capabilityName,
            dependency: depName,
            cached: false
          })
          return
        }

        this.options.corpus?.emit('dependency.missing', {
          capability: capabilityName,
          dependency: depName
        })

        try {
          await this.installCapability(depCap, capabilityName, hook)
          refreshPath()
          this.dependencyCache.set(depName, true)
          this.options.corpus?.emit('dependency.installed', {
            capability: capabilityName,
            dependency: depName
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          this.options.corpus?.emit('dependency.failed', {
            capability: capabilityName,
            dependency: depName,
            error: message
          })
          throw new Error(`Cannot use ${capabilityName} — ${message}`)
        }
      })
    }

    // System requires are now satisfied. Install the capability's own npm
    // deps (if any) into <capability>/node_modules, then lazy-load the
    // plugin module. Plugins use the standard Node module resolution
    // walking up from their file location, so deps installed at the
    // capability root resolve correctly.
    if (cap.hasPlugin) {
      await this.ensureNpmDependencies(cap, hook)
      await this.ensurePluginLoaded(cap)
    }

    this.dependencyCache.set(capabilityName, true)
  }

  /**
   * Ensure a single system-tool capability (e.g. `ffmpeg`) is installed,
   * for the code paths that invoke a plugin tool DIRECTLY via executeTool
   * and therefore bypass the agent loop's ensureDependencies() resolution —
   * the in-app STT IPC handler and the Telegram/WhatsApp voice handlers.
   * Without this, transcription on a fresh machine dead-ends with
   * "ffmpeg is required for transcription" instead of self-healing.
   *
   * Mirrors the per-dependency block of ensureDependencies (check → install
   * → refreshPath → cache) but runs the install through executeTool, NOT
   * executeWithApproval — so it is SILENT (no amygdala approval card). That's
   * deliberate: this is an internal prerequisite the user never asked to
   * confirm, on a single-user machine. Idempotent and cached per session, so
   * it's cheap to call before every transcription. Never throws — returns a
   * result the caller can fall through on.
   */
  async ensureSystemTool(capName: string): Promise<{ ok: boolean; error?: string }> {
    if (this.dependencyCache.get(capName)) return { ok: true }
    // Single-flight: two channels' voice notes arriving together (WhatsApp +
    // Telegram both ensuring ffmpeg) must not race duplicate silent installs.
    const inflight = this.systemToolInflight.get(capName)
    if (inflight) return inflight
    const flight = this.ensureSystemToolInner(capName).finally(() => {
      this.systemToolInflight.delete(capName)
    })
    this.systemToolInflight.set(capName, flight)
    return flight
  }

  private async ensureSystemToolInner(capName: string): Promise<{ ok: boolean; error?: string }> {
    if (this.dependencyCache.get(capName)) return { ok: true }
    const cap = this.capabilities.get(capName)
    // Unknown/failed capability — don't block the caller; let the tool run
    // and surface its own error (mirrors ensureDependencies' lenient stance).
    if (!cap || cap.status !== 'ok') return { ok: true }

    const checkTool = cap.tools.find((t) => t.name.endsWith('_check'))
    if (!checkTool) {
      this.dependencyCache.set(capName, true)
      return { ok: true }
    }
    const checkResult = await this.executeTool(checkTool.name, {})
    const parsed = checkResult.success ? safeJsonParse(checkResult.output) : null
    if (parsed?.installed) {
      this.dependencyCache.set(capName, true)
      return { ok: true }
    }

    const installTool =
      cap.tools.find((t) => t.name.endsWith('_install_manager')) ??
      cap.tools.find((t) => t.name.endsWith('_install'))
    if (!installTool) {
      return { ok: false, error: `${capName} is not installed and has no install tool` }
    }
    // executeTool() calls refreshPath() after a successful *_install, so the
    // freshly installed binary is on PATH for the very next spawn.
    const installResult = await this.executeTool(installTool.name, {})
    if (!installResult.success) {
      return { ok: false, error: installResult.error ?? `failed to install ${capName}` }
    }
    this.dependencyCache.set(capName, true)
    return { ok: true }
  }

  /**
   * If the capability has a package.json with declared deps, run `npm
   * install` in its folder once per session. Idempotent: a marker file in
   * <capability>/node_modules/.wolffish-installed records the package.json
   * hash so the install is skipped on later sessions when nothing changed.
   * Generic — works for any capability with a package.json, no per-cap code.
   */
  private async ensureNpmDependencies(cap: Capability, hook?: DependencyEmitHook): Promise<void> {
    if (Object.keys(cap.npmDependencies).length === 0) return
    const cacheKey = `npm:${cap.name}`
    if (this.dependencyCache.get(cacheKey)) return

    // On Windows the Electron process may have launched with a stale PATH that
    // doesn't include binaries installed in a prior session (e.g. node/npm from
    // winget). Refresh once before the first npm spawn so we don't fail with
    // "npm.cmd not recognized" when npm is actually on disk.
    if (!this.dependencyCache.get('__pathRefreshed')) {
      refreshPath()
      this.dependencyCache.set('__pathRefreshed', true)
    }

    const pkgPath = path.join(cap.dir, 'package.json')
    const markerPath = path.join(cap.dir, 'node_modules', '.wolffish-installed')

    let pkgRaw: string
    try {
      pkgRaw = await fs.readFile(pkgPath, 'utf8')
    } catch {
      this.dependencyCache.set(cacheKey, true)
      return
    }

    const pkgHash = hashString(pkgRaw)

    let needsInstall = true
    try {
      const marker = await fs.readFile(markerPath, 'utf8')
      if (marker.trim() === pkgHash) needsInstall = false
    } catch {
      needsInstall = true
    }

    if (!needsInstall) {
      this.dependencyCache.set(cacheKey, true)
      return
    }

    // Defense-in-depth: npm install needs node + npm on PATH. Plugins that carry
    // npmDependencies SHOULD declare requires:[node], but to make this class of
    // failure impossible (a fresh non-dev machine has no system Node), provision
    // the managed Node — and put it on PATH — before installing, regardless of
    // what the plugin declared. ensureDependencies is cached, so this is a no-op
    // once Node is ready; skipped for the node capability itself to avoid a cycle.
    if (cap.name !== 'node') {
      await this.ensureDependencies('node', hook)
    }

    this.options.corpus?.emit('dependency.npm.installing', {
      capability: cap.name,
      deps: Object.keys(cap.npmDependencies)
    })

    // Unique per emission. A bare timestamp can collide when the same
    // capability's install is re-attempted (it's only marked done on success,
    // so a failing install re-enters here), and two identical synthetic
    // `tool_call_id`s in the replayed history make OpenAI-style providers
    // (DeepSeek, etc.) reject the whole request with HTTP 400 "Duplicate
    // value for 'tool_call_id'". The random suffix guarantees uniqueness.
    const callId = `npm_${cap.name}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    hook?.emitToolCall(callId, '__npm_install', {
      capability: cap.name,
      packages: cap.npmDependencies
    })

    try {
      const result = await runNpmInstall(cap.dir)
      if (!result.success) {
        hook?.emitToolResult(
          callId,
          'failed',
          result.output ?? '',
          result.error ?? 'npm install failed'
        )
        this.options.corpus?.emit('dependency.npm.failed', {
          capability: cap.name,
          error: result.error
        })
        throw new Error(
          `Failed to install npm dependencies for "${cap.name}": ${result.error ?? 'unknown error'}`
        )
      }

      await diskWriter.writeFileAtomic(markerPath, pkgHash).catch(() => {
        // Best-effort marker; if it fails we'll just reinstall next session.
      })

      hook?.emitToolResult(
        callId,
        'success',
        `Installed ${Object.keys(cap.npmDependencies).length} npm package(s) for ${cap.name}.`
      )
      this.options.corpus?.emit('dependency.npm.installed', { capability: cap.name })
      this.dependencyCache.set(cacheKey, true)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      hook?.emitToolResult(callId, 'failed', '', message)
      throw err
    }
  }

  /**
   * Import the plugin module (now that npm deps are guaranteed installed)
   * and call its init hook. Cached after first successful load.
   */
  private async ensurePluginLoaded(cap: Capability): Promise<void> {
    if (this.plugins.has(cap.name)) return
    if (!cap.pluginEntryPath) return

    let plugin: WolffishPlugin
    try {
      plugin = await this.importPlugin(cap.pluginEntryPath, cap.name)
    } catch (err) {
      // Surface the ACTUAL reason (syntax error, wrong export shape, …) instead
      // of a generic "exports a valid Wolffish plugin" — the model needs the
      // specific mistake to fix its own skill on the next step.
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Failed to load plugin for "${cap.name}": ${message} (${cap.pluginEntryPath})`
      )
    }

    try {
      await plugin.init?.({
        pluginDir: path.dirname(cap.pluginEntryPath),
        workspaceRoot: this.options.workspaceRoot ?? '',
        getCurrentConversationId: () => this.getCurrentConversationId(),
        getWorkingFolders: () => this.getWorkingFolders(),
        progressReporter: () => this.progressReporter(),
        sudo: sudoSession,
        host: this.pluginHost,
        automations: this.automationsHost,
        procedures: this.proceduresHost,
        projects: this.projectsHost,
        workflow: this.workflowHost,
        mcp: this.mcpHost,
        cortex: this.cortexHost,
        knowledge: this.knowledgeHost,
        voice: this.voiceHost,
        videoTasks: this.videoTasksHost,
        countdown: this.countdownHost,
        wait: this.waitHost,
        processes: this.processesHost,
        askUser: (input) => this.dispatchAskUser(input),
        getChannelStatus: () => this.channelStatusProvider?.() ?? []
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`Plugin "${cap.name}" init failed: ${message}`)
    }

    this.plugins.set(cap.name, plugin)
  }

  /**
   * Build a human-readable description of a tool call for the approval
   * card. Calls the plugin's `describeAction` if defined, otherwise falls
   * back to the tool's SKILL.md description.
   */
  async describeToolCall(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<ApprovalDescription> {
    const capName = this.toolToCapability.get(toolName)
    if (capName) {
      const plugin = this.plugins.get(capName)
      if (plugin?.describeAction) {
        try {
          return await plugin.describeAction(toolName, args)
        } catch {
          // fall through to schema-based fallback
        }
      }
    }

    const cap = capName ? this.capabilities.get(capName) : undefined
    const tool = cap?.tools.find((t) => t.name === toolName)
    return {
      title: titleCase(toolName),
      description: tool?.description ?? toolName,
      risk: 'medium'
    }
  }

  /**
   * Return the platform-specific package identifiers from a capability's
   * SKILL.md `packages` field, mapped to pkg_install argument names.
   */
  getPackageIdentifiers(capabilityName: string): Record<string, string> {
    const cap = this.capabilities.get(capabilityName)
    if (!cap) return {}
    const out: Record<string, string> = {}
    if (cap.packages.brew) out.brew_name = cap.packages.brew
    if (cap.packages.winget_id) out.winget_id = cap.packages.winget_id
    if (cap.packages.apt) out.apt_name = cap.packages.apt
    if (cap.packages.dnf) out.dnf_name = cap.packages.dnf
    return out
  }

  getCapabilities(): Capability[] {
    return [...this.capabilities.values()]
  }

  /**
   * Drop the cached scan and re-read brain/cerebellum/ from disk. Lets the
   * UI pick up newly added or edited SKILL.md files without an app restart.
   * Existing plugins are torn down first so their destroy() hooks run.
   */
  async reload(): Promise<{ capabilities: Capability[] }> {
    // In-process capabilities (channel tools, MCP servers) don't live on
    // disk, so the rescan below can't restore them — carry them across.
    // Their plugins' lifecycles belong to their registrars (a reload is
    // not a disconnect), so they're excluded from the destroy pass too.
    const inProcess: Array<{ capability: Capability; plugin: WolffishPlugin }> = []
    for (const cap of this.capabilities.values()) {
      if (!cap.inProcess) continue
      const plugin = this.plugins.get(cap.name)
      if (plugin) inProcess.push({ capability: cap, plugin })
    }
    for (const [name, plugin] of this.plugins) {
      if (this.capabilities.get(name)?.inProcess) continue
      try {
        await plugin.destroy?.()
      } catch {
        // best-effort
      }
    }
    this.plugins.clear()
    this.capabilities.clear()
    this.toolToCapability.clear()
    this.dependencyCache.clear()
    this.loaded = false
    // New tool surface, and any re-imported plugin must dodge Node's ESM
    // cache (see importPlugin) — both ride on this bump.
    this.generation++
    await this.loadAll()
    for (const entry of inProcess) {
      this.registerInProcessCapability(entry.capability, entry.plugin)
    }
    return { capabilities: [...this.capabilities.values()] }
  }

  /**
   * Tear down every plugin's destroy hook. Called on app shutdown.
   */
  async stop(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      try {
        await plugin.destroy?.()
      } catch {
        // best-effort: a plugin's destroy failure must not block shutdown
      }
    }
    this.plugins.clear()
    // Drop the cached admin password and remove the askpass helper dir on app
    // shutdown. (reload() deliberately does NOT do this, so the password
    // survives a capability reload.)
    await sudoSession.destroy().catch(() => {})
  }

  private async loadCapability(capDir: string, folderName: string): Promise<Capability | null> {
    const skillPath = path.join(capDir, 'SKILL.md')
    let raw: string
    try {
      raw = await fs.readFile(skillPath, 'utf8')
    } catch {
      return null
    }

    const { frontmatter, body } = parseSkillMd(raw)
    if (!frontmatter || !frontmatter.name) {
      throw new Error(`SKILL.md in ${folderName}/ missing required frontmatter (name)`)
    }

    const name = frontmatter.name
    const tools = frontmatter.tools ?? []
    const triggers = frontmatter.triggers ?? []
    const dangers = frontmatter.danger_patterns ?? []
    const confirms = frontmatter.confirm_patterns ?? []

    if (this.options.amygdala) {
      const dangerPatterns: DangerPattern[] = []
      for (const d of dangers) {
        const re = safeRegExp(d.pattern)
        if (!re) continue
        dangerPatterns.push({
          match: re,
          level: d.level,
          reason: d.reason,
          args: patternArgs(d.args)
        })
      }
      for (const c of confirms) {
        const re = safeRegExp(c.pattern)
        if (!re) continue
        dangerPatterns.push({
          match: re,
          level: 'confirm',
          reason: c.reason,
          args: patternArgs(c.args)
        })
      }
      if (dangerPatterns.length > 0) this.options.amygdala.registerPatterns(dangerPatterns)
    }

    const pluginDir = path.join(capDir, 'plugin')
    let hasPlugin = false
    let pluginEntryPath: string | undefined
    try {
      const stat = await fs.stat(pluginDir)
      if (stat.isDirectory()) {
        const pluginFile = await findPluginEntry(pluginDir)
        if (pluginFile) {
          hasPlugin = true
          pluginEntryPath = pluginFile
          // Register tool ownership immediately so executeTool() can route
          // calls and ensureDependencies() can be triggered by the agent —
          // even though the plugin module itself is not imported until
          // first use (after npm deps install).
          for (const tool of tools) {
            this.toolToCapability.set(tool.name, name)
          }
        }
      }
    } catch {
      hasPlugin = false
    }

    const npmDependencies = await readNpmDependencies(capDir)

    // Tested state exists only for Wolffish-authored plugin capabilities: the
    // marker holds a hash of SKILL.md + the plugin entry as of the last
    // successful call, so a fresh creation OR any edit since then reads as
    // untested — the skill must pass a real call again before the badge clears.
    const author = typeof frontmatter.author === 'string' ? frontmatter.author.trim() : undefined
    let tested: boolean | undefined
    if (author === WOLFFISH_AUTHOR && hasPlugin && pluginEntryPath) {
      tested = false
      try {
        const marker = (await fs.readFile(path.join(capDir, TESTED_MARKER_FILE), 'utf8')).trim()
        const pluginSource = await fs.readFile(pluginEntryPath, 'utf8')
        tested = marker === hashString(`${raw}\0${pluginSource}`)
      } catch {
        tested = false
      }
    }

    const cap: Capability = {
      name,
      dir: capDir,
      description: frontmatter.description ?? '',
      triggers: { keywords: triggers },
      tools,
      body,
      hasPlugin,
      status: 'ok',
      requires: frontmatter.requires ?? [],
      packages: (frontmatter.packages ?? {}) as Record<string, string>,
      npmDependencies,
      pluginEntryPath,
      author,
      tested
    }

    return cap
  }

  /**
   * Import a plugin module and validate its export shape. Throws a descriptive
   * error on failure (caught by ensurePluginLoaded) so the model sees the real
   * reason — a syntax error, or the most common mistake: `tools` declared as an
   * object with inline handlers instead of an array plus a separate execute().
   */
  private async importPlugin(file: string, capName: string): Promise<WolffishPlugin> {
    let mod: { default?: WolffishPlugin } | WolffishPlugin
    try {
      // pathToFileURL keeps Windows happy and bypasses the loader's
      // resolve-from-cwd behaviour for plain string paths. The `?v=`
      // generation suffix busts Node's ESM module cache so a plugin edited
      // on disk and reloaded actually re-evaluates instead of resolving to
      // the stale first-import — without it, the create→edit→reload→retest
      // loop would silently keep running the original code. fileURLToPath
      // ignores the query, so plugins that locate bundled files via
      // import.meta.url (speech-to-text, text-to-speech) are unaffected.
      const href = `${pathToFileURL(file).href}?v=${this.generation}`
      mod = (await import(href)) as { default?: WolffishPlugin } | WolffishPlugin
    } catch (err) {
      void capName
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`module failed to import (${message})`)
    }
    const plugin = (mod as { default?: WolffishPlugin }).default ?? (mod as WolffishPlugin)
    // Be liberal in what we accept (Postel's law): model-authored plugins
    // routinely use a different convention from some other tool framework.
    // If `execute` is missing, synthesize one from whatever dispatcher the
    // plugin DID provide — a top-level alias (MCP `handleToolCall`, `run`, …)
    // or per-tool inline handlers (`tools: [{ name, handler }]`, array or
    // object). Result shapes are normalized in normalizeToolResult.
    if (plugin && typeof plugin.execute !== 'function') {
      const synthesized = synthesizeExecute(plugin)
      if (synthesized) plugin.execute = synthesized
    }
    if (!plugin || typeof plugin.execute !== 'function') {
      throw new Error(
        'no dispatcher found — export `async execute(toolName, args)` (an MCP-style `handleToolCall`, ' +
          'or per-tool `handler` functions on the tools, are also accepted). ' +
          'Canonical shape: export default { name, tools: [...], async execute(toolName, args) {...} }'
      )
    }
    return plugin
  }

  private async installCapability(
    cap: Capability,
    parentCap: string,
    hook?: DependencyEmitHook
  ): Promise<void> {
    if (Object.keys(cap.packages).length > 0 && cap.requires.includes('package-manager')) {
      const args: Record<string, unknown> = { package_name: cap.name }
      if (cap.packages.brew) args.brew_name = cap.packages.brew
      if (cap.packages.winget_id) args.winget_id = cap.packages.winget_id
      if (cap.packages.apt) args.apt_name = cap.packages.apt
      if (cap.packages.dnf) args.dnf_name = cap.packages.dnf
      await this.executeWithApproval('pkg_install', args, cap.name, parentCap, hook)
    } else {
      const installTool =
        cap.tools.find((t) => t.name.endsWith('_install_manager')) ??
        cap.tools.find((t) => t.name.endsWith('_install'))
      if (!installTool) {
        throw new Error(`"${cap.name}" is not installed and has no install tool`)
      }
      await this.executeWithApproval(installTool.name, {}, cap.name, parentCap, hook)
    }
  }

  private async executeWithApproval(
    toolName: string,
    args: Record<string, unknown>,
    depName: string,
    parentCap: string,
    hook?: DependencyEmitHook
  ): Promise<void> {
    const call: ToolCall = {
      id: `dep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      name: toolName,
      args
    }

    // Emit a synthetic tool_call segment BEFORE asking amygdala for
    // approval. The renderer keys approval cards off matching tool_call
    // segments — without one, the IPC fires fine but the dialog never
    // renders and the install Promise hangs forever waiting for a click
    // that can't happen.
    hook?.emitToolCall(call.id, toolName, args)

    if (this.options.amygdala) {
      const match = this.options.amygdala.match(call)
      if (match) {
        if (match.level === 'block') {
          hook?.emitToolResult(call.id, 'denied', '', `Blocked: ${match.reason}`)
          throw new Error(`Installation of "${depName}" blocked: ${match.reason}`)
        }
        if (match.level === 'confirm' || match.level === 'destructive') {
          const description = await this.describeToolCall(toolName, args)
          const decision = await this.options.amygdala.requestApproval({
            toolCall: call,
            level: match.level,
            reason: match.reason,
            description
          })
          if (decision === 'denied') {
            this.options.corpus?.emit('dependency.denied', {
              capability: parentCap,
              dependency: depName
            })
            hook?.emitToolResult(
              call.id,
              'denied',
              `Denied: ${depName} installation`,
              'user denied'
            )
            throw new Error(`user denied ${depName} installation, which is a required dependency`)
          }
          this.options.corpus?.emit('dependency.approved', {
            capability: parentCap,
            dependency: depName
          })
        }
      }
    }

    this.options.corpus?.emit('dependency.installing', {
      capability: parentCap,
      dependency: depName
    })

    const result = await this.executeTool(toolName, args)
    if (!result.success) {
      hook?.emitToolResult(call.id, 'failed', result.output ?? '', result.error ?? 'unknown error')
      throw new Error(`failed to install ${depName}: ${result.error ?? 'unknown error'}`)
    }
    hook?.emitToolResult(call.id, 'success', result.output ?? '')
  }
}

async function findPluginEntry(pluginDir: string): Promise<string | null> {
  for (const filename of PLUGIN_FILES) {
    const p = path.join(pluginDir, filename)
    try {
      const stat = await fs.stat(p)
      if (stat.isFile()) return p
    } catch {
      // try next
    }
  }
  return null
}

function parseSkillMd(raw: string): {
  frontmatter: SkillFrontmatter | null
  body: string
} {
  if (!raw.startsWith('---')) return { frontmatter: null, body: raw.trim() }
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return { frontmatter: null, body: raw.trim() }
  const yamlBlock = raw.slice(3, end).trim()
  const body = raw.slice(end + 4).trim()
  let frontmatter: SkillFrontmatter | null = null
  try {
    const parsed = yaml.load(yamlBlock)
    if (parsed && typeof parsed === 'object') {
      frontmatter = parsed as SkillFrontmatter
    }
  } catch {
    return { frontmatter: null, body }
  }
  return { frontmatter, body }
}

function safeRegExp(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i')
  } catch {
    return null
  }
}

/**
 * A pattern's optional `args:` scope — the argument names it should be
 * tested against instead of the whole call (see DangerPattern.args). Anything
 * that is not a non-empty list of strings means "unscoped", the old behaviour.
 */
function patternArgs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const names = value.filter((v): v is string => typeof v === 'string' && v.length > 0)
  return names.length > 0 ? names : undefined
}

function titleCase(toolName: string): string {
  return toolName
    .split('_')
    .map((part) => (part.length === 0 ? '' : part[0].toUpperCase() + part.slice(1)))
    .join(' ')
}

/**
 * Coerce whatever a plugin's execute() returned into a well-formed
 * ToolExecutionResult. The contract is `{ success, output }`, but a plugin
 * authored at runtime by the model often returns a bare value or stashes its
 * payload on a different key. Rather than render an empty card (success with
 * no visible output — exactly the confusing failure mode the coinflip test
 * hit), surface the payload:
 *
 *  - a bare string/number/bool        → { success: true, output: <stringified> }
 *  - `{ result: 'heads' }`            → output becomes "heads" (lone scalar field)
 *  - `{ foo: 1, bar: 2 }`             → output becomes the JSON of the extra fields
 *  - `{ error: 'boom' }`              → success: false
 *  - already `{ success, output }`    → passed through unchanged
 *
 * A deliberate empty success (`{ success: true }` with no other data) stays
 * empty — we only synthesize output when the plugin clearly returned data on
 * the wrong field.
 */
/**
 * When a plugin doesn't export `execute`, build one from whatever dispatcher
 * convention it DID use, so model-authored plugins that mirror another tool
 * framework still load. Returns null if no usable dispatcher is found.
 *
 * Recognized, in order: a top-level alias (handleToolCall/run/call/…), then
 * per-tool inline handlers on `tools` — an array (`[{ name, handler }]`) or an
 * object keyed by tool name (`{ toolName: { handler } }`). Handlers may be
 * named handler/run/fn/execute/callback. Kept in sync with the skills
 * capability's smoke-test (DISPATCHER_NAMES / per-tool handler detection).
 */
function synthesizeExecute(plugin: WolffishPlugin): WolffishPlugin['execute'] | null {
  const p = plugin as unknown as Record<string, unknown>

  const aliasKey = [
    'handleToolCall',
    'handle',
    'run',
    'call',
    'invoke',
    'onToolCall',
    'dispatch'
  ].find((k) => typeof p[k] === 'function')
  if (aliasKey) {
    const alias = p[aliasKey] as (...a: unknown[]) => unknown
    return (toolName, args, signal) =>
      Promise.resolve(alias.call(plugin, toolName, args, signal)) as ReturnType<
        WolffishPlugin['execute']
      >
  }

  const handlerOf = (t: unknown): unknown => {
    if (!t || typeof t !== 'object') return undefined
    const o = t as Record<string, unknown>
    return o.handler ?? o.run ?? o.fn ?? o.execute ?? o.callback
  }
  const tools = p.tools
  let lookup: ((name: string) => unknown) | null = null
  let sample: unknown[] = []
  if (Array.isArray(tools)) {
    lookup = (name) => tools.find((t) => (t as Record<string, unknown>)?.name === name)
    sample = tools
  } else if (tools && typeof tools === 'object') {
    const o = tools as Record<string, unknown>
    lookup = (name) => o[name]
    sample = Object.values(o)
  }
  if (lookup && sample.some((t) => typeof handlerOf(t) === 'function')) {
    const find = lookup
    return ((toolName: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const tool = find(toolName)
      const fn = handlerOf(tool)
      if (typeof fn !== 'function') {
        return Promise.resolve({ success: false, error: `unknown or unhandled tool: ${toolName}` })
      }
      return Promise.resolve((fn as (...a: unknown[]) => unknown).call(tool, args, signal))
    }) as WolffishPlugin['execute']
  }

  return null
}

function normalizeToolResult(raw: unknown): ToolExecutionResult {
  if (raw === null || raw === undefined) {
    return {
      success: false,
      error: 'plugin returned no result — execute() must return { success, output }'
    }
  }
  if (typeof raw === 'string') return { success: true, output: raw }
  if (typeof raw !== 'object') return { success: true, output: String(raw) }

  const r = raw as Record<string, unknown>
  const success =
    typeof r.success === 'boolean' ? r.success : r.error != null && r.error !== '' ? false : true

  let output = typeof r.output === 'string' ? r.output : r.output != null ? String(r.output) : ''

  // Plugin returned data but not on `output`/`error`: pull it onto output so
  // the call isn't a silent blank.
  if (success && output === '' && (r.error == null || r.error === '')) {
    // MCP-style result: { content: [{ type: 'text', text }] }. Flatten the
    // text blocks so a plugin written to the MCP tool contract renders cleanly
    // instead of dumping raw JSON.
    if (Array.isArray(r.content)) {
      const text = (r.content as unknown[])
        .map((c) => (c && typeof c === 'object' ? (c as Record<string, unknown>).text : undefined))
        .filter((t): t is string => typeof t === 'string')
        .join('\n')
      if (text) output = text
    }
    if (output === '') {
      const known = new Set([
        'success',
        'output',
        'error',
        'images',
        'exitCode',
        'partial',
        'retryable',
        'meta'
      ])
      const extra: Record<string, unknown> = {}
      for (const k of Object.keys(r)) if (!known.has(k)) extra[k] = r[k]
      const keys = Object.keys(extra)
      if (keys.length === 1 && ['string', 'number', 'boolean'].includes(typeof extra[keys[0]])) {
        output = String(extra[keys[0]])
      } else if (keys.length > 0) {
        try {
          output = JSON.stringify(extra)
        } catch {
          // non-serializable — leave output empty rather than throw
        }
      }
    }
  }

  const out: ToolExecutionResult = { success, output }
  if (r.error != null && r.error !== '') {
    out.error = typeof r.error === 'string' ? r.error : String(r.error)
  }
  if (Array.isArray(r.images)) out.images = r.images as ToolResultImage[]
  if (typeof r.exitCode === 'number' || r.exitCode === null) {
    out.exitCode = r.exitCode as number | null
  }
  if (typeof r.partial === 'boolean') out.partial = r.partial
  if (typeof r.retryable === 'boolean') out.retryable = r.retryable
  if (r.meta && typeof r.meta === 'object' && !Array.isArray(r.meta)) {
    out.meta = r.meta as Record<string, unknown>
  }
  return out
}

function safeJsonParse(str?: string): Record<string, unknown> | null {
  if (!str) return null
  try {
    const obj = JSON.parse(str)
    return typeof obj === 'object' && obj !== null ? (obj as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function toJSONSchema(parameters: Record<string, ToolParameterSpec>): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, spec] of Object.entries(parameters ?? {})) {
    if (spec.raw) {
      properties[key] = spec.raw
      if (spec.required !== false) required.push(key)
      continue
    }
    const prop: Record<string, unknown> = {
      type: spec.type ?? 'string'
    }
    if (spec.description) prop.description = spec.description
    if (spec.enum) prop.enum = spec.enum
    // Pass nested array/object schemas through so the model sees the precise
    // shape (and strict providers don't reject an item-less array).
    if (spec.items) prop.items = spec.items
    if (spec.properties) prop.properties = spec.properties
    properties[key] = prop
    // Default required so existing skills (which omit the field) keep their
    // current schema. Opt out per-param with `required: false` in frontmatter.
    if (spec.required !== false) required.push(key)
  }
  return {
    type: 'object',
    properties,
    required
  }
}

/**
 * Read the capability's package.json (if it exists) and return the
 * combined dependencies + devDependencies map. Returns an empty object
 * when no package.json or no deps. Each capability is a self-contained
 * npm project — its deps go in <capability>/node_modules, never in
 * wolffish-core's node_modules.
 */
async function readNpmDependencies(capDir: string): Promise<Record<string, string>> {
  const pkgPath = path.join(capDir, 'package.json')
  let raw: string
  try {
    raw = await fs.readFile(pkgPath, 'utf8')
  } catch {
    return {}
  }
  try {
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const deps: Record<string, string> = {}
    if (pkg.dependencies) Object.assign(deps, pkg.dependencies)
    if (pkg.devDependencies) Object.assign(deps, pkg.devDependencies)
    return deps
  } catch {
    return {}
  }
}

const NPM_OUTPUT_LIMIT = 50_000

// Hard cap for a single `npm install` (download + extract + postinstall). The
// browser capability's postinstall pulls a ~150 MB Chromium build, so this is
// generous — but finite, so a stalled network can't hang the task forever.
const NPM_INSTALL_TIMEOUT_MS = 10 * 60_000

/**
 * Spawn `npm install` in the capability directory. Returns success/failure
 * with truncated combined output. Cross-platform: resolves the npm binary
 * via PATH (npm.cmd on Windows). Surfaces a clear error if npm is missing
 * so the agent can prompt the user to install Node.js.
 */
function runNpmInstall(
  cwd: string
): Promise<{ success: boolean; output?: string; error?: string }> {
  return new Promise((resolve) => {
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const args = ['install', '--no-audit', '--no-fund', '--prefer-offline', '--omit=dev']

    let child
    try {
      child = spawn(npmBin, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32'
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      resolve({
        success: false,
        error: `Failed to spawn npm: ${message}. Is Node.js installed?`
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let resolved = false
    let timedOut = false
    // Hard backstop: a hung install (stalled network, wedged postinstall like
    // Playwright's Chromium download) must not block the task forever. After
    // the cap, kill the whole process tree — npm runs under a shell and spawns
    // node for postinstall scripts, so a plain child.kill() would orphan them.
    const killTree = (): void => {
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
        } else {
          child.kill('SIGKILL')
        }
      } catch {
        // best-effort
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, NPM_INSTALL_TIMEOUT_MS)

    const finish = (result: { success: boolean; output?: string; error?: string }): void => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      resolve(result)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < NPM_OUTPUT_LIMIT) {
        stdout += chunk.toString().slice(0, NPM_OUTPUT_LIMIT - stdout.length)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < NPM_OUTPUT_LIMIT) {
        stderr += chunk.toString().slice(0, NPM_OUTPUT_LIMIT - stderr.length)
      }
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      const message =
        err.code === 'ENOENT'
          ? 'npm command not found. Install Node.js (which bundles npm) and try again.'
          : err.message
      finish({ success: false, error: message })
    })

    child.on('close', (code: number | null) => {
      const combined = (stdout + (stderr ? '\n' + stderr : '')).trim()
      if (timedOut) {
        finish({
          success: false,
          error:
            `npm install timed out after ${Math.round(NPM_INSTALL_TIMEOUT_MS / 60_000)} min and was terminated (likely a stalled download or postinstall). ${combined.slice(-1000)}`.trim(),
          output: combined
        })
      } else if (code === 0) {
        finish({ success: true, output: combined || 'npm install completed.' })
      } else {
        finish({
          success: false,
          error: `npm install exited with code ${code}: ${combined.slice(-2000)}`,
          output: combined
        })
      }
    })
  })
}

function hashString(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 32)
}

/**
 * Re-resolve PATH from the user's login shell and write it back into
 * process.env.PATH. Called after a system dependency install so newly
 * installed binaries are visible to every subsequent spawn — shell
 * plugin, npm install, browser plugin, all of them.
 */
function refreshPath(): void {
  if (process.platform === 'win32') {
    try {
      const script =
        "[Environment]::GetEnvironmentVariable('PATH','Machine');" +
        "[Environment]::GetEnvironmentVariable('PATH','User')"
      const raw = execFileSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
      )
      const additions = raw
        .split(/\r?\n/)
        .flatMap((line: string) => line.split(';'))
        .map((p: string) => p.trim().replace(/[\\/]+$/, ''))
        .filter(Boolean)
      if (additions.length === 0) return
      const current = (process.env.PATH ?? '')
        .split(';')
        .map((p: string) => p.trim())
        .filter(Boolean)
      const seen = new Set(current.map((p: string) => p.toLowerCase().replace(/[\\/]+$/, '')))
      for (const entry of additions) {
        if (seen.has(entry.toLowerCase())) continue
        seen.add(entry.toLowerCase())
        current.push(entry)
      }
      process.env.PATH = current.join(';')
    } catch {
      // best-effort
    }
    return
  }
  const userShell = process.env.SHELL || '/bin/sh'
  try {
    const raw = execFileSync(userShell, ['-ilc', 'printf "__WFPATH__%s__WFPATH__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const resolved = raw.match(/__WFPATH__(.+?)__WFPATH__/)?.[1]
    if (resolved && resolved.includes(':')) {
      const current = (process.env.PATH ?? '').split(':').filter(Boolean)
      const seen = new Set(current)
      for (const dir of resolved.split(':')) {
        if (dir && !seen.has(dir)) {
          seen.add(dir)
          current.push(dir)
        }
      }
      process.env.PATH = current.join(':')
    }
  } catch {
    // best-effort
  }
}
