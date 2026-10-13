import type {
  BrowserTabSnapshot,
  ConversationMessage,
  NoProviderAvailableInfo,
  Segment,
  SegmentTurnEndReason,
  TaskSnapshot,
  CountdownSnapshot,
  TodoItem,
  ToolResultMeta,
  ToolResultStatus,
  ToolTiming,
  ProcessCardSnapshot,
  WaitSnapshot,
  WorkflowSnapshot
} from '@/lib/conversations/types'

/**
 * Pure transforms from the persisted segment stream to what the feed renders.
 * Ported from wolffish-app Chat.tsx renderSegments/coalesceTextSegments with
 * the same invariants:
 *  - worker-tagged segments and workflow orchestration tools never render
 *  - text deltas accumulate and flush at any non-text segment or separator
 *  - file/path cards are marker-only — bare paths in prose never render
 *  - unknown segment kinds and tool names must degrade gracefully, never throw
 */

/** Orchestration tools whose surface is the workflow card, never a tool card. */
const WORKFLOW_TOOL_NAMES = new Set([
  'workflow_plan',
  'agent_spawn',
  'agent_send',
  'agents_await',
  'agent_cancel'
])

const ASK_TOOL_NAME = 'ask_user'

/**
 * The `options` capability's single tool. Its call renders as a tabbed
 * copy-and-paste card, never a tool row — and always, clean feed included:
 * the card is content the model produced FOR the user, not tool mechanics.
 */
const OPTIONS_TOOL_NAME = 'offer_options'

/** Tools whose output is file content — markers quoted inside never render. */
const FILE_CONTENT_TOOL_NAMES = new Set(['file_read', 'file_write', 'file_patch'])

/**
 * The code tools that earn a compact activity row on the clean feed — an
 * edit, a write or a shell run is a change the user can see in their project,
 * so it shows with verbose off too (desktop ToolCard.CODE_ACTIVITY_TOOLS).
 */
export const CODE_ACTIVITY_TOOLS: ReadonlySet<string> = new Set([
  'file_edit',
  'file_write',
  'file_patch',
  'shell_exec'
])

export type ToolCallInfo = {
  toolCallId: string
  name: string
  args: Record<string, unknown>
}

export type ToolResultInfo = {
  status: ToolResultStatus
  output: string
  error?: string
  meta?: ToolResultMeta
}

export type DeliveredFileKind = 'image' | 'document' | 'audio' | 'video' | 'file' | 'chart'

export type RenderBlock =
  | { type: 'text'; key: string; markdown: string }
  /** A run of the model's thinking, at its true position in the stream. */
  | { type: 'reasoning'; key: string; content: string }
  | { type: 'media'; key: string; relPath: string }
  | {
      type: 'tool'
      key: string
      call: ToolCallInfo
      result?: ToolResultInfo
      timing?: ToolTiming
    }
  | { type: 'question'; key: string; call: ToolCallInfo; result?: ToolResultInfo }
  /**
   * An offer_options card. Carries only the CALL: everything it draws is in
   * the args, and its result is a one-line confirmation written for the model.
   */
  | { type: 'options'; key: string; call: ToolCallInfo }
  /** A tool_result with no tool_call in the stream — see the emit site. */
  | { type: 'toolAnchor'; key: string; toolCallId: string; result: ToolResultInfo }
  | { type: 'model'; key: string; provider: string; model: string }
  /**
   * A message the user sent mid-turn, at the point the agent read it — drawn
   * as a user bubble INSIDE the assistant card, in clean and verbose feeds
   * alike (it is the user's own words, never mechanics). Carried as a full
   * user message so the bubble renderer needs no second shape.
   */
  | { type: 'userMessage'; key: string; message: ConversationMessage }
  | { type: 'file'; key: string; relPath: string; kind: DeliveredFileKind }
  | { type: 'path'; key: string; path: string; kind: 'folder' | 'file' }
  | { type: 'workflow'; key: string; snapshot: WorkflowSnapshot }
  | { type: 'task'; key: string; snapshot: TaskSnapshot }
  | { type: 'countdown'; key: string; snapshot: CountdownSnapshot }
  | { type: 'wait'; key: string; snapshot: WaitSnapshot }
  | { type: 'process'; key: string; snapshot: ProcessCardSnapshot }
  /** The conversation's in-app browser — read-only on the phone. */
  | { type: 'browser'; key: string; snapshot: BrowserTabSnapshot }
  /** The model's task list for one turn, in its latest state. */
  | { type: 'todo'; key: string; items: TodoItem[] }
  | {
      type: 'compaction'
      key: string
      phase: 'started' | 'done'
      tokensSaved?: number
      targetsCount: number
      messagesCount?: number
    }
  | {
      type: 'turnEnd'
      key: string
      stopReason: SegmentTurnEndReason
      reasoningContent?: string
      providerErrors?: NoProviderAvailableInfo[]
    }

const WORKSPACE_PREFIX_RE = /^.*?\/\.wolffish\/workspace\//

/** Normalize any absolute desktop workspace path to workspace-relative. */
export function toWorkspaceRelative(path: string): string {
  return path.replace(WORKSPACE_PREFIX_RE, '')
}

/**
 * Whether a normalized path is one the desktop can actually serve — i.e. it
 * landed inside the workspace and normalized to a relative path. Tool output
 * sometimes names files OUTSIDE it (/tmp scratch frames a meme pipeline
 * inspected, an absolute path a shell tool printed): the desktop's fileRead
 * refuses anything not under its root, so a card built for such a path can
 * never resolve — it sat as a loading placeholder retrying a download that
 * will never exist. Those stay prose; the path is still readable in the tool
 * card's own output.
 */
function isServableWorkspacePath(relPath: string): boolean {
  return relPath.length > 0 && !relPath.startsWith('/')
}

/** `[wolffish-output: <path> (<kind>)]` — delivered-file markers, output only. */
const OUTPUT_MARKER_RE =
  /\[wolffish-output:\s*([^\]]+?)\s*\((image|document|audio|video|file|chart)\)\]/g

/** `[wolffish-path: <path> (folder|file)]` — show_path markers. */
const PATH_MARKER_RE = /\[wolffish-path:\s*([^\]]+?)\s*\((folder|file)\)\]/g

/** A text buffer that is exactly one media image renders as an image, not markdown. */
const MEDIA_ONLY_RE = /^!\[[^\]]*\]\(wolffish-media:\/\/([^)]+)\)$/

export function isRenderableSegment(segment: Segment): boolean {
  if ('worker' in segment && segment.worker) return false
  if (segment.kind === 'tool_call' && WORKFLOW_TOOL_NAMES.has(segment.name)) return false
  if (segment.kind === 'tool_result') return true
  return true
}

/**
 * Voice tool replies persist as JSON `{filePath, fileName, isResponse}` in the
 * tool result output. Returns the relative path when this is such a payload.
 */
function parseVoiceResult(output: string): string | null {
  const trimmed = output.trim()
  if (!trimmed.startsWith('{') || !trimmed.includes('filePath')) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as { filePath?: unknown }).filePath === 'string'
    ) {
      return toWorkspaceRelative((parsed as { filePath: string }).filePath)
    }
  } catch {
    // Not JSON — a plain tool output.
  }
  return null
}

function extractDeliveredFiles(
  call: ToolCallInfo | undefined,
  result: ToolResultInfo,
  key: string,
  emitted: Set<string>
): RenderBlock[] {
  if (call && FILE_CONTENT_TOOL_NAMES.has(call.name)) return []
  const blocks: RenderBlock[] = []

  const voicePath = parseVoiceResult(result.output)
  if (voicePath) {
    if (isServableWorkspacePath(voicePath) && !emitted.has(voicePath)) {
      emitted.add(voicePath)
      blocks.push({ type: 'file', key: `${key}:voice`, relPath: voicePath, kind: 'audio' })
    }
    return blocks
  }

  let match: RegExpExecArray | null
  OUTPUT_MARKER_RE.lastIndex = 0
  let index = 0
  while ((match = OUTPUT_MARKER_RE.exec(result.output)) !== null) {
    const relPath = toWorkspaceRelative(match[1])
    const kind = match[2] as DeliveredFileKind
    // Placeholder/self-referential markers (e.g. docs quoting the format).
    if (relPath === 'path' || relPath.includes('${')) continue
    if (!isServableWorkspacePath(relPath)) continue
    if (emitted.has(relPath)) continue
    emitted.add(relPath)
    blocks.push({ type: 'file', key: `${key}:out${index}`, relPath, kind })
    index += 1
  }

  PATH_MARKER_RE.lastIndex = 0
  index = 0
  while ((match = PATH_MARKER_RE.exec(result.output)) !== null) {
    blocks.push({
      type: 'path',
      key: `${key}:path${index}`,
      path: match[1],
      kind: match[2] as 'folder' | 'file'
    })
    index += 1
  }

  return blocks
}

/**
 * Walk an assistant message's segments into orderly render blocks. Total —
 * unknown kinds are skipped, malformed data never throws.
 *
 * A message with prose but NO segments renders that prose. Every message the
 * desktop persists carries segments, so this looks like dead code and was
 * missing for that reason — but the phone writes messages the desktop never
 * sees (the offline reply) and reads text off the wire before its segments
 * exist (a turn streaming in as deltas). Without the fallback both render as
 * an empty bubble: text on screen everywhere else, silently blank here.
 */
/** The list a todo segment belongs to — its own turn unless it continues an earlier one. */
export function todoListId(segment: Extract<Segment, { kind: 'todo' }>): string {
  return segment.listId ?? segment.turnId
}

/**
 * Every task list in a conversation in its LATEST state, keyed by list id,
 * walking the messages in order (a later write replaces an earlier one).
 * The feed draws each list once, on the card of the turn that created it,
 * with these items — so a continuation write in a later turn resolves the
 * earlier card in place (the desktop's latestTodoLists, mirrored).
 */
export function latestTodoLists(messages: ConversationMessage[]): Map<string, TodoItem[]> {
  const out = new Map<string, TodoItem[]>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const segment of message.segments ?? []) {
      if (segment && typeof segment === 'object' && segment.kind === 'todo') {
        out.set(todoListId(segment), Array.isArray(segment.items) ? segment.items : [])
      }
    }
  }
  return out
}

export type RenderOptions = {
  /** Every task list in its latest state — see latestTodoLists. Without it,
   *  each card shows the items of its own write. */
  todoLists?: Map<string, TodoItem[]>
  /**
   * Where each conversation browser's ONE card lives — see latestBrowserCards.
   * A message that is not that holder draws no browser card. Without it,
   * every message that carries a browser segment draws one.
   */
  browserCards?: Map<string, { messageId: string; snapshot: BrowserTabSnapshot }>
}

/** What a browser card stands for: the conversation, else the tab (desktop's browserKey). */
export function browserKey(snapshot: Pick<BrowserTabSnapshot, 'conversationId' | 'tabId'>): string {
  return snapshot.conversationId ?? snapshot.tabId
}

/**
 * One browser card per conversation, in the LATEST message that carries it —
 * the desktop's keepLatestBrowserCard, mirrored: the card follows the last
 * turn that used the browser, so nobody scrolls up to find it. Later
 * messages win; within one message the last segment wins.
 */
export function latestBrowserCards(
  messages: ConversationMessage[]
): Map<string, { messageId: string; snapshot: BrowserTabSnapshot }> {
  const out = new Map<string, { messageId: string; snapshot: BrowserTabSnapshot }>()
  for (const message of messages) {
    for (const segment of message.segments ?? []) {
      if (segment.kind !== 'browser' || !segment.snapshot) continue
      out.set(browserKey(segment.snapshot), {
        messageId: message.id ?? '',
        snapshot: segment.snapshot
      })
    }
  }
  return out
}

export function buildRenderBlocks(
  message: ConversationMessage,
  options: RenderOptions = {}
): RenderBlock[] {
  const segments = message.segments ?? []
  if (segments.length === 0) {
    const prose = message.content?.trim() ?? ''
    return prose ? [{ type: 'text', key: `t:${message.id ?? 'content'}`, markdown: prose }] : []
  }
  const blocks: RenderBlock[] = []
  const openTools = new Map<string, number>() // toolCallId -> block index
  const emittedFiles = new Set<string>()
  const workflowIndexById = new Map<string, number>()
  const taskIndexById = new Map<string, number>()
  const countdownIndexById = new Map<string, number>()
  const waitIndexById = new Map<string, number>()
  const processIndexById = new Map<string, number>()
  const browserIndexByKey = new Map<string, number>()
  const todoIndexByTurn = new Map<string, number>()
  let textBuffer = ''
  let textKey = ''
  let reasoningBuffer = ''
  let reasoningKey = ''
  let compactionStartedIndex = -1
  // In-place reasoning supersedes the legacy turn_end copy: the desktop
  // dual-publishes the final iteration's thinking on turn_end for surfaces
  // that predate the 'reasoning' kind, so rendering both would show it twice.
  const hasReasoningSegments = segments.some(
    (segment) =>
      segment &&
      typeof segment === 'object' &&
      segment.kind === 'reasoning' &&
      !('worker' in segment && segment.worker)
  )

  const flushTextOnly = (): void => {
    const trimmed = textBuffer.trim()
    textBuffer = ''
    if (!trimmed) return
    const mediaMatch = MEDIA_ONLY_RE.exec(trimmed)
    if (mediaMatch) {
      const relPath = toWorkspaceRelative(mediaMatch[1])
      if (isServableWorkspacePath(relPath)) {
        blocks.push({ type: 'media', key: textKey, relPath })
        return
      }
      // Falls through: a media reference outside the workspace renders as the
      // prose it came in as rather than a card that can never load.
    }
    blocks.push({ type: 'text', key: textKey, markdown: trimmed })
  }

  // A run of streamed thinking flushes as one collapsed card at its true
  // position — above the prose/tool activity that thinking produced. At most
  // one of textBuffer/reasoningBuffer is ever non-empty (each case flushes
  // the other before accumulating), so the combined flushText below — text
  // first — can never reorder them.
  const flushReasoning = (): void => {
    const trimmed = reasoningBuffer.trim()
    reasoningBuffer = ''
    if (!trimmed) return
    blocks.push({ type: 'reasoning', key: reasoningKey, content: trimmed })
  }

  const flushText = (): void => {
    flushTextOnly()
    flushReasoning()
  }

  for (const segment of segments) {
    if (!segment || typeof segment !== 'object' || !('kind' in segment)) continue
    if (!isRenderableSegment(segment)) continue

    switch (segment.kind) {
      case 'text':
        // A pending thinking run preceded this prose — its card goes above.
        flushReasoning()
        if (!textBuffer) textKey = `t:${segment.segmentId}`
        textBuffer += segment.delta
        break
      case 'reasoning':
        // Prose already buffered belongs to the previous iteration — it goes
        // above this thinking run. Text only: draining the reasoning buffer
        // here would split one streamed run into a card per delta.
        flushTextOnly()
        if (!reasoningBuffer) reasoningKey = `rs:${segment.segmentId}`
        reasoningBuffer += segment.delta
        break
      case 'separator':
        flushText()
        break
      case 'tool_call': {
        flushText()
        const call: ToolCallInfo = {
          toolCallId: segment.toolCallId,
          name: segment.name,
          args: segment.args ?? {}
        }
        const timing = message.toolTimings?.[segment.toolCallId]
        if (segment.name === OPTIONS_TOOL_NAME) {
          // Registered in openTools like any other call, so the matching
          // result pairs with it and is absorbed — the block ignores it (its
          // output is a one-line confirmation for the model, never for the
          // user), and without the entry that result would raise a stray
          // orphan anchor instead.
          openTools.set(segment.toolCallId, blocks.length)
          blocks.push({ type: 'options', key: `c:${segment.toolCallId}`, call })
          break
        }
        const type = segment.name === ASK_TOOL_NAME ? 'question' : 'tool'
        openTools.set(segment.toolCallId, blocks.length)
        blocks.push({ type, key: `c:${segment.toolCallId}`, call, timing })
        break
      }
      case 'tool_result': {
        flushText()
        const result: ToolResultInfo = {
          status: segment.status,
          output: segment.output ?? '',
          error: segment.error,
          ...(segment.meta && typeof segment.meta === 'object' ? { meta: segment.meta } : {})
        }
        const callIndex = openTools.get(segment.toolCallId)
        let call: ToolCallInfo | undefined
        if (callIndex !== undefined) {
          const block = blocks[callIndex]
          if (block.type === 'tool' || block.type === 'question') {
            block.result = result
            call = block.call
          }
        } else {
          // The clean-feed live mirror strips tool_call segments, so mid-turn
          // the result of a parked card (ask_user, an approved tool) arrives
          // with no call to pair with — yet it sits at the exact point in the
          // stream where the turn parked. The anchor holds that position so
          // the feed can render the live card THERE instead of appending it
          // after everything (MessageBubbles). Stored bodies carry every
          // call, so once a turn is persisted this block never appears.
          blocks.push({
            type: 'toolAnchor',
            key: `a:${segment.toolCallId}`,
            toolCallId: segment.toolCallId,
            result
          })
        }
        blocks.push(...extractDeliveredFiles(call, result, `r:${segment.toolCallId}`, emittedFiles))
        break
      }
      case 'active_model':
        flushText()
        blocks.push({
          type: 'model',
          key: `m:${segment.segmentId}`,
          provider: segment.provider,
          model: segment.model
        })
        break
      case 'user_message':
        // The prose before it is one reply, the prose after it the answer
        // to this — never one buffer across the two. Keyed by the message
        // id, the same key the pending bubble it retires was drawn under.
        flushText()
        blocks.push({
          type: 'userMessage',
          key: `u:${segment.messageId}`,
          message: interjectionMessage(segment)
        })
        break
      case 'workflow': {
        flushText()
        const id = segment.snapshot?.workflowId
        if (!id) break
        const existing = workflowIndexById.get(id)
        if (existing !== undefined) {
          blocks[existing] = { type: 'workflow', key: `w:${id}`, snapshot: segment.snapshot }
        } else {
          workflowIndexById.set(id, blocks.length)
          blocks.push({ type: 'workflow', key: `w:${id}`, snapshot: segment.snapshot })
        }
        break
      }
      case 'task': {
        // Async generation task card — replace-by-taskId, exactly like the
        // workflow fold above (the desktop's upsertTaskSegment contract).
        flushText()
        const id = segment.snapshot?.taskId
        if (!id) break
        const existing = taskIndexById.get(id)
        if (existing !== undefined) {
          blocks[existing] = { type: 'task', key: `tk:${id}`, snapshot: segment.snapshot }
        } else {
          taskIndexById.set(id, blocks.length)
          blocks.push({ type: 'task', key: `tk:${id}`, snapshot: segment.snapshot })
        }
        break
      }
      case 'countdown': {
        // Turn-end countdown card — replace-by-countdownId, the task fold.
        flushText()
        const id = segment.snapshot?.countdownId
        if (!id) break
        const existing = countdownIndexById.get(id)
        if (existing !== undefined) {
          blocks[existing] = { type: 'countdown', key: `cd:${id}`, snapshot: segment.snapshot }
        } else {
          countdownIndexById.set(id, blocks.length)
          blocks.push({ type: 'countdown', key: `cd:${id}`, snapshot: segment.snapshot })
        }
        break
      }
      case 'wait': {
        // Blocking-wait card — replace-by-waitId, the task fold. Never
        // verbose-gated: a turn that goes quiet with no card reads as a hang.
        flushText()
        const id = segment.snapshot?.waitId
        if (!id) break
        const existing = waitIndexById.get(id)
        if (existing !== undefined) {
          blocks[existing] = { type: 'wait', key: `wt:${id}`, snapshot: segment.snapshot }
        } else {
          waitIndexById.set(id, blocks.length)
          blocks.push({ type: 'wait', key: `wt:${id}`, snapshot: segment.snapshot })
        }
        break
      }
      case 'process': {
        // Process card — replace-by-cardId, the task fold. Never
        // verbose-gated: it is output FOR the user, with buttons.
        flushText()
        const id = segment.snapshot?.cardId
        if (!id) break
        const existing = processIndexById.get(id)
        if (existing !== undefined) {
          blocks[existing] = { type: 'process', key: `pc:${id}`, snapshot: segment.snapshot }
        } else {
          processIndexById.set(id, blocks.length)
          blocks.push({ type: 'process', key: `pc:${id}`, snapshot: segment.snapshot })
        }
        break
      }
      case 'browser': {
        // The conversation's browser: one card, at the latest message that
        // used it, in its latest state. Never verbose-gated — the user
        // watches what the model is looking at.
        if (!segment.snapshot) break
        const key = browserKey(segment.snapshot)
        const holder = options.browserCards?.get(key)
        if (holder && holder.messageId !== (message.id ?? '')) break
        const snapshot = holder?.snapshot ?? segment.snapshot
        flushText()
        const existing = browserIndexByKey.get(key)
        if (existing !== undefined) {
          blocks[existing] = { type: 'browser', key: `br:${key}`, snapshot }
        } else {
          browserIndexByKey.set(key, blocks.length)
          blocks.push({ type: 'browser', key: `br:${key}`, snapshot })
        }
        break
      }
      case 'todo': {
        // The task list: one checklist per LIST, at the turn that created it,
        // in its latest state. A later turn's write that continues the list
        // (listId ≠ turnId) resolves that earlier card and draws nothing of
        // its own; within one turn every write replaces the card — the
        // desktop's upsertTodoSegment contract, applied again here so a
        // transcript that still carries several writes renders exactly one.
        if (todoListId(segment) !== segment.turnId) break
        flushText()
        const items =
          options.todoLists?.get(segment.turnId) ??
          (Array.isArray(segment.items) ? segment.items : [])
        const key = `td:${segment.turnId}`
        const existing = todoIndexByTurn.get(segment.turnId)
        if (existing !== undefined) {
          blocks[existing] = { type: 'todo', key, items }
        } else {
          todoIndexByTurn.set(segment.turnId, blocks.length)
          blocks.push({ type: 'todo', key, items })
        }
        break
      }
      case 'compaction_started':
        flushText()
        compactionStartedIndex = blocks.length
        blocks.push({
          type: 'compaction',
          key: `cs:${segment.segmentId}`,
          phase: 'started',
          targetsCount: segment.targetsCount,
          messagesCount: segment.messagesCount
        })
        break
      case 'compaction':
        flushText()
        // A completed compaction supersedes its "started" card.
        if (compactionStartedIndex >= 0) {
          blocks.splice(compactionStartedIndex, 1)
          compactionStartedIndex = -1
        }
        blocks.push({
          type: 'compaction',
          key: `cd:${segment.segmentId}`,
          phase: 'done',
          targetsCount: segment.targetsCount,
          tokensSaved: segment.tokensSaved
        })
        break
      case 'turn_end': {
        flushText()
        // LEGACY: conversations persisted before in-place reasoning segments
        // carry the final iteration's thinking only here. When the message
        // has reasoning segments, this is a duplicate of the last one — the
        // in-place card already rendered it.
        const reasoningContent = hasReasoningSegments ? undefined : segment.reasoningContent
        // providerErrors emit even on a clean stop: a turn that retried
        // through a provider failure and recovered still shows the failure
        // record mid-transcript, exactly as the desktop renders it.
        if (
          segment.stopReason !== 'end_turn' ||
          segment.providerErrors?.length ||
          (reasoningContent && reasoningContent.trim())
        ) {
          blocks.push({
            type: 'turnEnd',
            key: `e:${segment.segmentId}`,
            stopReason: segment.stopReason,
            reasoningContent,
            providerErrors: segment.providerErrors
          })
        }
        break
      }
      default:
        // Unknown segment kind from a newer desktop — skip, never crash.
        break
    }
  }
  flushText()
  return blocks
}

/** The user message a `user_message` segment records, in the feed's own shape. */
export function interjectionMessage(
  segment: Extract<Segment, { kind: 'user_message' }>
): ConversationMessage {
  return {
    id: segment.messageId,
    role: 'user',
    content: segment.text ?? '',
    timestamp: segment.timestamp,
    ...(segment.attachments && segment.attachments.length > 0
      ? { attachments: segment.attachments }
      : {}),
    ...(segment.voicePrompt ? { voicePrompt: true } : {}),
    ...(segment.voiceLang ? { voiceLang: segment.voiceLang } : {})
  }
}

/**
 * Every mid-turn message id the transcript already holds as a
 * `user_message` segment — in the stored assistant messages and in the live
 * one. What the feed checks a pending row against (feed.ts): a row whose id
 * is here has been read by the agent and is drawn inside the assistant card.
 */
export function deliveredInterjectionIds(
  messages: ConversationMessage[],
  live?: ConversationMessage
): Set<string> {
  const ids = new Set<string>()
  const collect = (message: ConversationMessage | undefined): void => {
    if (!message || message.role !== 'assistant') return
    for (const segment of message.segments ?? []) {
      if (segment && typeof segment === 'object' && segment.kind === 'user_message') {
        ids.add(segment.messageId)
      }
    }
  }
  for (const message of messages) collect(message)
  collect(live)
  return ids
}

/**
 * Merge consecutive text and reasoning segments into one per run (same kind
 * only, never across kinds) — the desktop does this at persist time (a raw
 * stream was 28k segments / 4 MB). Used by the demo importer, the demo
 * streaming persister, and the sync ingest path.
 */
export function coalesceTextSegments(segments: Segment[]): Segment[] {
  const out: Segment[] = []
  for (const segment of segments) {
    const last = out[out.length - 1]
    if (
      (segment.kind === 'text' || segment.kind === 'reasoning') &&
      last &&
      (last.kind === 'text' || last.kind === 'reasoning') &&
      last.kind === segment.kind &&
      Boolean(last.worker) === Boolean(segment.worker) &&
      last.worker?.id === segment.worker?.id
    ) {
      out[out.length - 1] = { ...last, delta: last.delta + segment.delta }
    } else {
      out.push(segment)
    }
  }
  return out
}

/**
 * Every workspace path a message renders: its attachments, plus the delivered
 * file and media blocks its segments produce. This is what the sync layer
 * prefetches after a conversation body lands — collected through the same
 * buildRenderBlocks the feed uses, so prefetch and display can never disagree
 * about what counts as a file.
 */
export function messageFilePaths(message: ConversationMessage): string[] {
  const paths = new Set<string>()
  for (const attachment of message.attachments ?? []) {
    if (attachment?.filePath) paths.add(toWorkspaceRelative(attachment.filePath))
  }
  if (message.role === 'assistant') {
    for (const block of buildRenderBlocks(message)) {
      if (block.type === 'file' || block.type === 'media') paths.add(block.relPath)
      // A mid-turn message's own files, so its bubble inside the card renders
      // from cache exactly as a user row's does.
      if (block.type === 'userMessage') {
        for (const attachment of block.message.attachments ?? []) {
          if (attachment?.filePath) paths.add(toWorkspaceRelative(attachment.filePath))
        }
      }
      // A finished generation task renders its mp4 inline — prefetch it with
      // the conversation instead of downloading lazily on first render.
      if (block.type === 'task' && block.snapshot.outputPath) {
        paths.add(toWorkspaceRelative(block.snapshot.outputPath))
      }
    }
  }
  // Only paths the desktop can serve: anything still absolute would spend
  // the prefetch (and its retries) on downloads that can never exist.
  return [...paths].filter(isServableWorkspacePath)
}

/** Concatenated assistant prose — the "copy message" payload. */
export function messageText(message: ConversationMessage): string {
  if (message.role === 'user') return message.content
  if (message.content) return message.content
  const parts: string[] = []
  for (const segment of message.segments ?? []) {
    if (segment.kind === 'text' && !segment.worker) parts.push(segment.delta)
  }
  return parts.join('')
}

/**
 * The turn_end that failed, when this message IS a failed turn — the phone's
 * stand-in for the desktop's `message.status === 'error'`, which does not
 * cross the wire as such. The LAST turn_end decides: a coalesced multi-turn
 * message can hold an old failure a later turn recovered from.
 */
export function failedTurnEnd(
  message: ConversationMessage
): Extract<Segment, { kind: 'turn_end' }> | null {
  const segments = message.segments ?? []
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]
    if (segment.kind !== 'turn_end') continue
    const failed = segment.stopReason === 'error' || segment.stopReason === 'no_provider_available'
    return failed ? segment : null
  }
  return null
}
