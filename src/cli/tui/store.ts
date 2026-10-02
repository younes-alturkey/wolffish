/**
 * The client store: one Solid store fed by the daemon's frames.
 *
 * Nothing here is agent state — the daemon owns the conversation. This is the
 * terminal's picture of it, shaped for rendering: a feed of messages, each
 * assistant message a list of parts keyed by segment id (so a streamed delta
 * appends in place), plus the live turn's meter, cost and pending cards.
 */
import { batch } from 'solid-js'
import { createStore, produce, type SetStoreFunction } from 'solid-js/store'

export type Attachment = { name: string; path?: string; type?: string; size?: number }

export type ToolStatus = 'running' | 'ok' | 'error' | 'denied' | 'checked_in' | 'stopped'

export type Delivery = { path: string; kind: string; index: number }

export type Part =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'reasoning'; id: string; text: string; startedAt: number; endedAt?: number }
  | {
      kind: 'tool'
      id: string
      toolCallId: string
      name: string
      args: Record<string, unknown>
      status: ToolStatus
      output?: string
      error?: string
      meta?: Record<string, unknown>
      startedAt: number
      durationMs?: number
      files: Delivery[]
      paths: { path: string; kind: string }[]
      expanded: boolean
      worker?: string
    }
  /**
   * The model's copy-and-paste options card (offer_options). Its whole
   * content rides the tool CALL's args — there is no result to wait for —
   * so the part is complete the instant the call lands and identical on a
   * reload.
   */
  | { kind: 'options'; id: string; toolCallId: string; title?: string; options: OptionItem[] }
  | { kind: 'todo'; id: string; listId: string; items: TodoItem[] }
  | { kind: 'workflow'; id: string; snapshot: Record<string, unknown> }
  | { kind: 'task'; id: string; snapshot: Record<string, unknown> }
  | { kind: 'wait'; id: string; snapshot: Record<string, unknown> }
  | { kind: 'countdown'; id: string; snapshot: Record<string, unknown> }
  | { kind: 'process'; id: string; snapshot: Record<string, unknown> }
  | { kind: 'browser'; id: string; snapshot: Record<string, unknown> }
  | {
      kind: 'compaction'
      id: string
      phase: 'started' | 'done'
      targetsCount?: number
      tokensSaved?: number
      durationMs?: number
      messagesCount?: number
    }
  | { kind: 'provider_errors'; id: string; errors: Array<Record<string, unknown>> }
  /**
   * A message the user sent MID-TURN, at the point the agent read it. It sits
   * inside the assistant message because that is where it happened: the
   * daemon persists it as a `user_message` segment of the same turn, so a
   * reload draws it in the same place.
   */
  | {
      kind: 'user'
      id: string
      messageId: string
      text: string
      attachments: Attachment[]
      timestamp: number
    }

/** The `options` capability's single tool — folded to an options part, not a tool row. */
const OFFER_OPTIONS_TOOL = 'offer_options'

/**
 * The tab letter for position i: A…Z, then AA … — mirrors the plugin and
 * every other renderer, so "option C" in the reply is option C on screen.
 */
function optionLetter(index: number): string {
  let n = index
  let out = ''
  do {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

/**
 * Recover an options card from its persisted tool_call args. As tolerant as
 * the plugin's own normalizer — the same synonyms it accepts (a bare string,
 * `label`/`code`/`text`/`value`) must survive, or a card the user saw in the
 * app would come back empty here.
 */
function parseOptionItems(raw: unknown): OptionItem[] {
  if (!Array.isArray(raw)) return []
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  const out: OptionItem[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const content = item.trim()
      if (content)
        out.push({
          letter: optionLetter(out.length),
          title: `Option ${optionLetter(out.length)}`,
          content
        })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const content = str(r.content) || str(r.code) || str(r.text) || str(r.value)
    if (!content) continue
    const letter = optionLetter(out.length)
    const title = str(r.title) || str(r.label)
    const description = str(r.description)
    const language = str(r.language) || str(r.lang)
    out.push({
      letter,
      title: title || `Option ${letter}`,
      ...(description ? { description } : {}),
      ...(language ? { language } : {}),
      content
    })
  }
  return out
}

/** One alternative on an options card, already lettered for display. */
export type OptionItem = {
  letter: string
  title: string
  description?: string
  language?: string
  content: string
}

export type TodoItem = { id?: string; content: string; status: string }

export type UserMessage = {
  kind: 'user'
  id: string
  text: string
  attachments: Attachment[]
  timestamp: number
  voice?: boolean
}

export type AssistantMessage = {
  kind: 'assistant'
  id: string
  turnId: string | null
  parts: Part[]
  startedAt: number
  endedAt?: number
  provider?: string
  model?: string
  stopReason?: string
  iterations?: number
  error?: string
  /** Set when the daemon persisted a turn-end reasoning blob (stored turns). */
  reasoningContent?: string
  interrupted?: boolean
}

export type FeedItem = UserMessage | AssistantMessage

export type Meter = {
  tokens: number
  budget: number
  compactionAt: number | null
  model: string | null
}

export type PendingCard =
  | {
      kind: 'approval'
      id: string
      turnId: string
      tool: string
      args: Record<string, unknown>
      reason: string
      level: string
      description?: unknown
      parked?: boolean
    }
  | {
      kind: 'ask'
      id: string
      turnId: string
      questions: AskQuestion[]
      parked?: boolean
    }

export type AskQuestion = {
  header?: string
  question?: string
  options?: Array<{ label?: string; description?: string } | string>
  multiple?: boolean
  custom?: boolean
}

/**
 * A message sent while the turn runs and not yet read by the agent. `mine`
 * marks one this terminal sent: those are the rows Escape can take back and
 * whose text comes home to the prompt when the daemon hands them back; a row
 * from another surface (the app, the phone) only renders.
 */
export type PendingMessage = { id: string; text: string; attachments: string[]; mine: boolean }

export type RunState = {
  conversationId: string
  channel?: string
  title?: string
  state: string
}

export type Brain = { provider: string | null; model: string | null }

export type ChatMode = 'single' | 'workflow'
export type ThinkingMode = 'off' | 'on' | 'high' | 'max'

export type Toast = {
  id: number
  message: string
  variant: 'info' | 'success' | 'warning' | 'error'
}

export type State = {
  connection: 'connecting' | 'connected' | 'reconnecting' | 'closed'
  version: string | null
  daemonPid: number | null
  headless: boolean
  /** Brain and chat settings mirrored from the daemon. */
  brain: Brain
  chatMode: ChatMode
  localOnly: boolean
  thinking: ThinkingMode
  thinkingModes: ThinkingMode[]
  planMode: boolean
  projectId: string | null
  projectTitle: string | null
  verbose: boolean
  showThinking: boolean
  contextWindow: number | null
  /** The conversation on screen. */
  conversationId: string | null
  title: string | null
  feed: FeedItem[]
  /** Files the session has delivered, numbered for /open. */
  files: Delivery[]
  stagedAttachments: string[]
  /** Mid-turn messages parked for the agent's next stop point, in send order. */
  pending: PendingMessage[]
  working: boolean
  turnId: string | null
  sendAt: number | null
  activity: string | null
  meter: Meter
  cost: number
  turnUsage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null
  lastTurn: { durationMs: number; input: number; output: number; cost: number } | null
  allTime: { cost: number; turns: number; inputTokens: number; outputTokens: number } | null
  card: PendingCard | null
  parked: PendingCard[]
  runs: RunState[]
  channels: Array<{ id: string; label?: string; connected: boolean; state?: string }>
  toasts: Toast[]
  sidebar: boolean
  /** Last provider error surfaced by the turn, for the red card. */
  lastError: string | null
  /** A message that never reached the daemon, handed back to the prompt. */
  restoreDraft: string | null
}

export function initialState(): State {
  return {
    connection: 'connecting',
    version: null,
    daemonPid: null,
    headless: false,
    brain: { provider: null, model: null },
    chatMode: 'single',
    localOnly: false,
    thinking: 'off',
    thinkingModes: [],
    planMode: false,
    projectId: null,
    projectTitle: null,
    verbose: false,
    showThinking: false,
    contextWindow: null,
    conversationId: null,
    title: null,
    feed: [],
    files: [],
    stagedAttachments: [],
    pending: [],
    working: false,
    turnId: null,
    sendAt: null,
    activity: null,
    meter: { tokens: 0, budget: 0, compactionAt: null, model: null },
    cost: 0,
    turnUsage: null,
    lastTurn: null,
    allTime: null,
    card: null,
    parked: [],
    runs: [],
    channels: [],
    toasts: [],
    sidebar: false,
    lastError: null,
    restoreDraft: null
  }
}

export type Store = [State, SetStoreFunction<State>]

export function createAppStore(): Store {
  return createStore<State>(initialState())
}

/* ───────────────────────── delivery markers ───────────────────────── */

// Line-anchored: a real marker stands on its own line; quoted templates do not count.
const OUTPUT_MARKER =
  /^[ \t]*\[wolffish-output:[ \t]*([^\]\n]+?)[ \t]+\((image|audio|video|document|file|chart)\)\][ \t]*$/gm
const PATH_MARKER = /^[ \t]*\[wolffish-path:[ \t]*([^\]\n]+?)[ \t]+\((folder|file)\)\][ \t]*$/gm

export function extractDeliveries(output: string): {
  files: { path: string; kind: string }[]
  paths: { path: string; kind: string }[]
  rest: string
} {
  const files: { path: string; kind: string }[] = []
  const paths: { path: string; kind: string }[] = []
  if (typeof output !== 'string' || output.length === 0) return { files, paths, rest: '' }
  let rest = output
  OUTPUT_MARKER.lastIndex = 0
  for (const match of output.matchAll(OUTPUT_MARKER)) {
    files.push({ path: match[1].trim(), kind: match[2] })
    rest = rest.replace(match[0], '')
  }
  PATH_MARKER.lastIndex = 0
  for (const match of output.matchAll(PATH_MARKER)) {
    paths.push({ path: match[1].trim(), kind: match[2] })
    rest = rest.replace(match[0], '')
  }
  return { files, paths, rest: rest.trim() }
}

/* ───────────────────────── segment reducer ───────────────────────── */

export type Segment = Record<string, unknown> & {
  kind: string
  turnId?: string
  segmentId?: string
}

let idCounter = 0
export function mintId(prefix = 'c'): string {
  idCounter += 1
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`
}

function lastAssistant(state: State): AssistantMessage | null {
  const last = state.feed[state.feed.length - 1]
  return last && last.kind === 'assistant' ? last : null
}

/** Ensure the feed ends with an assistant message for this turn. */
/** Patch fields on the assistant message at `index` (a union-safe set). */
export function patchAssistant(
  set: SetStoreFunction<State>,
  index: number,
  patch: Partial<AssistantMessage>
): void {
  set(
    'feed',
    index,
    produce((message) => {
      if (message.kind !== 'assistant') return
      Object.assign(message, patch)
    })
  )
}

export function ensureAssistant(
  set: SetStoreFunction<State>,
  get: State,
  turnId: string | null
): void {
  const last = lastAssistant(get)
  if (last && (last.turnId === turnId || last.turnId === null) && !last.endedAt) {
    if (last.turnId === null && turnId) patchAssistant(set, get.feed.length - 1, { turnId })
    return
  }
  set(
    'feed',
    produce((feed) => {
      feed.push({
        kind: 'assistant',
        id: mintId('a'),
        turnId,
        parts: [],
        startedAt: Date.now()
      })
    })
  )
}

/**
 * Fold one segment into the last assistant message. `live` is true for a
 * streaming turn (activity labels update); false when replaying stored
 * segments from disk.
 */
export function applySegment(
  [get, set]: Store,
  segment: Segment,
  options: {
    live: boolean
    approvals?: Record<string, { decision?: string }>
    timings?: Record<string, { durationMs?: number }>
  }
): void {
  const turnId = typeof segment.turnId === 'string' ? segment.turnId : get.turnId
  const segmentId = typeof segment.segmentId === 'string' ? segment.segmentId : mintId('s')
  ensureAssistant(set, get, turnId)
  const index = get.feed.length - 1

  const editParts = (fn: (parts: Part[], message: AssistantMessage) => void) =>
    set(
      'feed',
      index,
      produce((message) => {
        if (message.kind !== 'assistant') return
        fn(message.parts, message)
      })
    )

  switch (segment.kind) {
    // Text and reasoning deltas fold into the LAST part of their kind when it
    // is still open — the daemon stamps a new segment id per delta, so folding
    // by id would give one part per token. A run closes when another kind of
    // part lands after it (a tool call, the other of the two).
    case 'text': {
      const delta = String(segment.delta ?? '')
      editParts((parts) => {
        const last = parts[parts.length - 1]
        if (last && last.kind === 'text') last.text += delta
        else {
          for (const p of parts) if (p.kind === 'reasoning' && !p.endedAt) p.endedAt = Date.now()
          parts.push({ kind: 'text', id: segmentId, text: delta })
        }
      })
      if (options.live) set('activity', null)
      return
    }
    case 'reasoning': {
      const delta = String(segment.delta ?? '')
      editParts((parts) => {
        const last = parts[parts.length - 1]
        if (last && last.kind === 'reasoning' && !last.endedAt) last.text += delta
        else parts.push({ kind: 'reasoning', id: segmentId, text: delta, startedAt: Date.now() })
      })
      if (options.live) set('activity', 'Thinking')
      return
    }
    case 'tool_call': {
      const name = String(segment.name ?? 'tool')
      const toolCallId = String(segment.toolCallId ?? segmentId)
      // offer_options is a card, never a tool row: everything it draws is in
      // these args, so it folds to its own part here and skips the tool
      // bookkeeping entirely (its result is a one-line confirmation written
      // for the model). Drawn in clean and verbose alike — content the model
      // produced FOR the user, not tool mechanics.
      if (name === OFFER_OPTIONS_TOOL) {
        const args = (segment.args as Record<string, unknown>) ?? {}
        const options = parseOptionItems(args.options)
        if (options.length > 0) {
          const title = typeof args.title === 'string' ? args.title.trim() : ''
          editParts((parts) => {
            for (const q of parts) if (q.kind === 'reasoning' && !q.endedAt) q.endedAt = Date.now()
            parts.push({
              kind: 'options',
              id: segmentId,
              toolCallId,
              ...(title ? { title } : {}),
              options
            })
          })
        }
        return
      }
      editParts((parts) => {
        // Close any open reasoning run: the model moved on to acting.
        for (const p of parts) if (p.kind === 'reasoning' && !p.endedAt) p.endedAt = Date.now()
        parts.push({
          kind: 'tool',
          id: segmentId,
          toolCallId,
          name,
          args: (segment.args as Record<string, unknown>) ?? {},
          status: 'running',
          startedAt: Date.now(),
          files: [],
          paths: [],
          expanded: false,
          worker: segment.worker
            ? String((segment.worker as { name?: string }).name ?? '')
            : undefined
        })
      })
      if (options.live) set('activity', name)
      return
    }
    case 'tool_result': {
      const toolCallId = String(segment.toolCallId ?? '')
      const output = typeof segment.output === 'string' ? segment.output : ''
      const { files, paths, rest } = extractDeliveries(output)
      const status = String(segment.status ?? 'success')
      const decision = options.approvals?.[toolCallId]?.decision
      const startCount = get.files.length
      const deliveries: Delivery[] = files.map((f, i) => ({ ...f, index: startCount + i + 1 }))
      editParts((parts) => {
        const tool = parts.find((p) => p.kind === 'tool' && p.toolCallId === toolCallId)
        if (!tool || tool.kind !== 'tool') return
        tool.output = rest
        tool.error = typeof segment.error === 'string' ? segment.error : undefined
        tool.meta = (segment.meta as Record<string, unknown>) ?? undefined
        tool.files = deliveries
        tool.paths = paths
        tool.durationMs =
          options.timings?.[toolCallId]?.durationMs ??
          (typeof (segment.meta as { durationMs?: number })?.durationMs === 'number'
            ? (segment.meta as { durationMs: number }).durationMs
            : Date.now() - tool.startedAt)
        tool.status =
          decision === 'denied' ||
          /denied by user|rejected by user|user denied/i.test(
            `${tool.error ?? ''} ${rest.slice(0, 200)}`
          )
            ? 'denied'
            : status === 'checked_in'
              ? 'checked_in'
              : status === 'stopped'
                ? 'stopped'
                : status === 'error' || status === 'failed' || tool.error
                  ? 'error'
                  : 'ok'
      })
      if (deliveries.length > 0) set('files', (files) => [...files, ...deliveries])
      if (options.live) set('activity', 'Thinking')
      return
    }
    case 'todo': {
      const listId = String(segment.listId ?? turnId ?? segmentId)
      const items = (segment.items as TodoItem[]) ?? []
      // Replace-by-list-id anywhere in the feed: a later turn may update an
      // earlier card in place.
      let replaced = false
      set(
        'feed',
        produce((feed) => {
          for (const message of feed) {
            if (message.kind !== 'assistant') continue
            for (const part of message.parts) {
              if (part.kind === 'todo' && part.listId === listId) {
                part.items = items
                replaced = true
              }
            }
          }
        })
      )
      if (!replaced)
        editParts((parts) => parts.push({ kind: 'todo', id: segmentId, listId, items }))
      return
    }
    case 'workflow':
    case 'task':
    case 'countdown':
    case 'process':
    case 'browser':
    case 'wait': {
      const snapshot = (segment.snapshot as Record<string, unknown>) ?? {}
      const keyField =
        segment.kind === 'workflow'
          ? 'workflowId'
          : segment.kind === 'task'
            ? 'taskId'
            : segment.kind === 'wait'
              ? 'waitId'
              : segment.kind === 'browser'
                ? 'conversationId'
                : segment.kind === 'process'
                  ? 'cardId'
                  : 'countdownId'
      const key = String(snapshot[keyField] ?? segmentId)
      let replaced = false
      set(
        'feed',
        produce((feed) => {
          for (const message of feed) {
            if (message.kind !== 'assistant') continue
            for (const part of message.parts) {
              if (
                part.kind === segment.kind &&
                (part.kind === 'workflow' ||
                  part.kind === 'task' ||
                  part.kind === 'countdown' ||
                  part.kind === 'process' ||
                  part.kind === 'browser' ||
                  part.kind === 'wait') &&
                String(part.snapshot[keyField] ?? part.id) === key
              ) {
                part.snapshot = snapshot
                replaced = true
              }
            }
          }
        })
      )
      if (!replaced) {
        editParts((parts) =>
          parts.push({
            kind: segment.kind as
              | 'workflow'
              | 'task'
              | 'countdown'
              | 'process'
              | 'browser'
              | 'wait',
            id: segmentId,
            snapshot
          })
        )
      }
      if (options.live && segment.kind === 'workflow') set('activity', 'Workflow')
      return
    }
    case 'compaction_started': {
      editParts((parts) =>
        parts.push({
          kind: 'compaction',
          id: segmentId,
          phase: 'started',
          messagesCount: Number(segment.messagesCount ?? 0),
          targetsCount: Number(segment.targetsCount ?? 0)
        })
      )
      if (options.live) set('activity', 'Compacting')
      return
    }
    case 'compaction': {
      editParts((parts) => {
        const started = [...parts]
          .reverse()
          .find((p) => p.kind === 'compaction' && p.phase === 'started')
        if (started && started.kind === 'compaction') {
          started.phase = 'done'
          started.targetsCount = Number(segment.targetsCount ?? 0)
          started.tokensSaved = Number(segment.tokensSaved ?? 0)
          started.durationMs = Number(segment.durationMs ?? 0)
        } else {
          parts.push({
            kind: 'compaction',
            id: segmentId,
            phase: 'done',
            targetsCount: Number(segment.targetsCount ?? 0),
            tokensSaved: Number(segment.tokensSaved ?? 0),
            durationMs: Number(segment.durationMs ?? 0)
          })
        }
      })
      return
    }
    case 'active_model': {
      patchAssistant(set, index, {
        provider: String(segment.provider ?? ''),
        model: String(segment.model ?? '')
      })
      if (options.live) set('activity', 'Thinking')
      return
    }
    case 'turn_end': {
      const errors = segment.providerErrors as Array<Record<string, unknown>> | undefined
      editParts((parts, message) => {
        for (const p of parts) if (p.kind === 'reasoning' && !p.endedAt) p.endedAt = Date.now()
        message.stopReason = String(segment.stopReason ?? '')
        message.iterations = Number(segment.iterationCount ?? 0)
        if (
          typeof segment.reasoningContent === 'string' &&
          !parts.some((p) => p.kind === 'reasoning')
        ) {
          message.reasoningContent = segment.reasoningContent
        }
        if (errors && errors.length > 0)
          parts.push({ kind: 'provider_errors', id: segmentId, errors })
      })
      return
    }
    // The agent read a mid-turn message: it becomes a user row INSIDE this
    // assistant message, and the optimistic pending row it retires is found
    // by the id the sender minted. The next text delta opens a fresh text
    // part after it — the fold-into-last-text rule sees a `user` part last.
    case 'user_message': {
      const messageId = String(segment.messageId ?? segmentId)
      const raw = Array.isArray(segment.attachments)
        ? (segment.attachments as Array<Record<string, unknown>>)
        : []
      const timestamp = typeof segment.timestamp === 'number' ? segment.timestamp : Date.now()
      editParts((parts) => {
        for (const p of parts) if (p.kind === 'reasoning' && !p.endedAt) p.endedAt = Date.now()
        parts.push({
          kind: 'user',
          id: segmentId,
          messageId,
          text: String(segment.text ?? ''),
          attachments: raw.map(attachmentOf),
          timestamp
        })
      })
      set('pending', (rows) => rows.filter((row) => row.id !== messageId))
      if (options.live) set('activity', 'Thinking')
      return
    }
    case 'separator':
    default:
      return
  }
}

/** A persisted MessageAttachment (or the store's own shape) as a feed attachment. */
function attachmentOf(a: Record<string, unknown>): Attachment {
  const path =
    typeof a.filePath === 'string' ? a.filePath : typeof a.path === 'string' ? a.path : ''
  const name =
    typeof a.originalName === 'string'
      ? a.originalName
      : typeof a.name === 'string'
        ? a.name
        : basenameOf(path)
  const size =
    typeof a.sizeBytes === 'number' ? a.sizeBytes : typeof a.size === 'number' ? a.size : undefined
  return {
    name,
    path: path || undefined,
    type: typeof a.type === 'string' ? a.type : undefined,
    size
  }
}

/** Seal the last assistant message: the turn is over. */
export function endAssistant([get, set]: Store, error?: string): void {
  const index = get.feed.length - 1
  const last = get.feed[index]
  if (!last || last.kind !== 'assistant') return
  batch(() => {
    patchAssistant(set, index, { endedAt: Date.now(), ...(error ? { error } : {}) })
    set(
      'feed',
      index,
      produce((message) => {
        if (message.kind !== 'assistant') return
        for (const p of message.parts) {
          if (p.kind === 'reasoning' && !p.endedAt) p.endedAt = Date.now()
          if (p.kind === 'tool' && p.status === 'running') {
            p.status = error ? 'error' : p.status
            p.durationMs = p.durationMs ?? Date.now() - p.startedAt
          }
        }
      })
    )
  })
}

/* ───────────────────────── stored conversations ───────────────────────── */

export type StoredMessage = {
  id?: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  attachments?: Array<{ name?: string; path?: string; type?: string; size?: number }>
  voicePrompt?: boolean
  segments?: Segment[]
  approvals?: Record<string, { decision?: string }>
  toolTimings?: Record<string, { durationMs?: number }>
  stopReason?: string
  error?: string
  interrupted?: boolean
}

/** Rebuild the feed from a stored conversation. */
export function loadConversation(store: Store, messages: StoredMessage[]): void {
  const [, set] = store
  batch(() => {
    set('feed', [])
    set('files', [])
    for (const message of messages) {
      if (message.role === 'user') {
        set('feed', (feed) => [
          ...feed,
          {
            kind: 'user',
            id: message.id ?? mintId('u'),
            text: message.content ?? '',
            attachments: (message.attachments ?? []).map((a) => ({
              name: a.name ?? basenameOf(a.path ?? ''),
              path: a.path,
              type: a.type,
              size: a.size
            })),
            timestamp: message.timestamp,
            voice: message.voicePrompt
          }
        ])
        continue
      }
      // Assistant: replay the segment stream, or fall back to the flat text.
      set('feed', (feed) => [
        ...feed,
        {
          kind: 'assistant',
          id: message.id ?? mintId('a'),
          turnId: null,
          parts: [],
          startedAt: message.timestamp,
          endedAt: message.timestamp,
          error: message.error,
          stopReason: message.stopReason,
          interrupted: message.interrupted
        }
      ])
      const segments = message.segments ?? []
      if (segments.length === 0 && message.content) {
        const [get] = store
        patchAssistant(set, get.feed.length - 1, {
          parts: [{ kind: 'text', id: mintId('t'), text: message.content }]
        })
        continue
      }
      // The reducer needs an OPEN assistant message to fold into: reopen, then close.
      const [get] = store
      patchAssistant(set, get.feed.length - 1, { endedAt: undefined })
      for (const segment of segments) {
        applySegment(store, segment, {
          live: false,
          approvals: message.approvals,
          timings: message.toolTimings
        })
      }
      patchAssistant(set, get.feed.length - 1, { endedAt: message.timestamp })
    }
  })
}

function basenameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}
