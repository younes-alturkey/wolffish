// Relative (not @main): outbound stays electron-free / tsx-testable, and its
// other @main imports are type-only (erased). A value import must resolve at
// runtime for the standalone tests, so it goes through the relative path.
import { deliveredFilesReminder } from './agent/delivered-files'
import type { RuntimeContext } from '@main/runtime/prefrontal'
import type { ChatMessage, ProviderStreamOptions } from '@main/runtime/thalamus'

/**
 * Outbound request shaping — the structural clone boundary.
 *
 * Everything here operates on a copy of the request right before provider
 * dispatch. The internal full-fidelity messages array is never mutated and
 * never sees any of these transformations; they exist only on the wire.
 * This module is deliberately pure and electron-free so it stays unit-
 * testable.
 *
 * Cardinal rule: only content that is provably obsolete (superseded by
 * newer state of the same context), provably duplicated (byte-equal), or
 * provably inert is replaced — and always with a self-describing stub, so
 * the model knows something existed, what it was, and how to get it back.
 * Anything requiring judgment stays.
 */

/**
 * Tools whose successful result is a snapshot of live page state for one
 * browser session. A newer successful read of the same tool+session
 * provably supersedes older ones — the old text described a page that no
 * longer looks like that, and the model already acted on it. These two
 * tools carried 96% (2026-06-11 run) and 68% (2026-06-12 run) of all
 * tool-result bytes.
 */
const PAGE_STATE_TOOLS = new Set(['browser_page_content', 'ext_read_page'])

/**
 * Results smaller than this stay untouched. Stubbing tiny content saves
 * nothing and costs clarity — and the stub itself is ~60 tokens.
 */
const MIN_STUB_CHARS = 2_000

/**
 * Told to the model only while the host is definitively offline (Electron's
 * net.isOnline() — the same signal the thalamus uses to skip cloud
 * providers). Sampled fresh every iteration, so the notice appears the
 * moment the network drops mid-turn and disappears the moment it returns.
 * Nothing is rendered while online: the online state is the silent default,
 * so the common case costs zero tokens and zero cache churn.
 */
export const OFFLINE_NOTICE =
  'NETWORK: OFFLINE — this machine has no internet connection right now. ' +
  'Any tool that needs the network (web search/fetch, browsing, downloads, package installs, cloud APIs, messaging channels) WILL fail — do not attempt them. ' +
  'Work fully offline: rely on your own knowledge and the tools that run locally (memory recall, reading/writing files, shell, skills). ' +
  'If the task genuinely requires the internet, say so plainly, do the offline part now, and suggest retrying once the connection returns.'

/**
 * Rides every iteration of every master/single turn while the Voice replies
 * preference is ON — the switch is the ONLY gate (see
 * RuntimeContext.voiceReply); nothing inspects the turn for a voice note,
 * which is why the wording is conditional and stays truthful on typed
 * turns. The <voice_prompts> system-prompt block carries the full rule;
 * this line restates the non-negotiable core at the most salient position
 * in the request, because the shipped failure was a model reading the rule
 * in a 25k-token prompt and replying in text anyway. Deliberately repeats
 * "one" and "last": the channels dedupe a second voice_respond, and a memo
 * followed by trailing prose reads as broken.
 */
export const VOICE_REPLY_NOTICE =
  'Voice replies are ON: whenever the CURRENT user message is tagged <voice_note> (the user spoke it), this turn MUST end with exactly one voice_respond call speaking your answer (in the <voice_note> lang). ' +
  'Deliver any files/media/text the work needs first; the voice_respond comes LAST, as your wrap-up. ' +
  'Only an explicit request in the user\'s own message ("reply in text") lifts this. Typed messages are unaffected.'

/**
 * Phone-notification notices — the every-iteration restatement of the
 * agents.core.md doctrine ("Phone notifications — notify_phone, every turn").
 *
 * Same reasoning as VOICE_REPLY_NOTICE, and the same shipped failure behind
 * it: a rule that lives only in a 25k-token system prompt loses to whatever
 * the turn is actually about. The doctrine's whole point is that the last
 * tool call of a turn is easy to forget precisely when the work went well,
 * so the reminder rides at the request's most salient position — after every
 * cache breakpoint, so it costs tail tokens and never a prefix rehash.
 *
 * Three states, chosen once per iteration by the Agent (availability, role
 * and channel gates live there):
 *
 *   NOTICE          the default surface (in-app, mobile, CLI, automations) —
 *                   end the turn with one, and interrupt mid-turn for a
 *                   major beat.
 *   CHANNEL_NOTICE  Telegram/WhatsApp, where the reply ITSELF already
 *                   arrived on that same phone with its own notification, so
 *                   a turn-end push would buzz twice for one thing. Major
 *                   beats only.
 *   SENT_NOTICE     something already went out this turn. Flips exactly once
 *                   per turn (one tail transition, like deliveredFiles) and
 *                   guards the one restraint the doctrine kept: never the
 *                   same news twice.
 */
export const PHONE_NOTIFY_NOTICE =
  'PHONE: a paired phone is reachable, and notify_phone lands on it even when the app is closed, backgrounded, or offline. ' +
  'END THIS TURN with ONE notify_phone carrying the real outcome (phase completed/failed, deeplink wolffish://chat?id=current) — a turn the user watched you finish still gets one. ' +
  'Send one NOW instead of waiting if you are blocked on them, a step failed, or you found something worth acting on immediately. ' +
  'Stay silent only when there is genuinely nothing to carry (small talk, a one-line acknowledgment) or the user asked for quiet.'

export const PHONE_NOTIFY_CHANNEL_NOTICE =
  'PHONE: this reply reaches the user as a channel message that already notifies their phone, so do NOT close the turn with a duplicate notify_phone. ' +
  'Use it only for a major beat they would otherwise miss: you are blocked on them, a step failed, or a finding is worth acting on now.'

export const PHONE_NOTIFY_SENT_NOTICE =
  'PHONE: a notify_phone for this turn has already gone out (an UNCONFIRMED one may be on their lock screen too) — do not repeat it, reworded or otherwise. ' +
  'Send another only if something NEW and major has happened since: blocked on the user, a failure, a finding worth acting on now.'

/**
 * Live runtime context, injected at the tail of the outbound clone each
 * iteration instead of into the system prompt. Two kinds of volatile fact
 * ride here: the host clock (current date/time, UTC offset, and IANA zone
 * — a coarse location hint, all useful to any agent) and the loop-position
 * counters. Keeping them out of the prompt is what lets the entire prompt
 * prefix-match in provider caches; keeping them at the very end means only
 * these ~90 tokens are ever re-billed — and the volatile tail renders
 * strictly after every cache breakpoint (see anthropic.ts), so its
 * per-iteration churn never perturbs a prefix hash.
 *
 * The clock is sampled fresh per call (`now` is injectable for tests), so
 * unlike the once-per-turn `<device>` block it stays accurate even across
 * a long tool loop.
 *
 * The wording matters: as the most recent message in the request, this
 * line is highly salient. The 2026-06-12 run showed a model reading the
 * bare counter at a frustrating moment, deciding to "close this turn and
 * continue next turn", and ending the task — so the line must declare
 * itself non-conversational and restate the loop mechanic (no tool calls
 * = task over) without overriding the model's judgment to stop when a
 * task is truly complete or hopeless.
 */
export function formatRuntimeStatus(runtime: RuntimeContext, now: Date = new Date()): string {
  // Files the model already delivered this turn (via send_file's marker) ride
  // here (after every cache breakpoint) rather than in a tool-result message —
  // so reminding it not to re-send them never perturbs the cached history prefix.
  const delivered = deliveredFilesReminder(runtime.deliveredFiles ?? [])
  return (
    `[runtime] Current date/time: ${formatClock(now)}. ` +
    `Tool iteration this turn: ${runtime.iteration}. Tools called this turn: ${runtime.toolsCalled}. ` +
    // Conversation-resumed notice (the previous message is ≥30min old) sits
    // right after the clock so the two temporal facts read as one: what time
    // it is now, and how long ago the transcript above stopped being "now".
    (runtime.lastMessage ? `${runtime.lastMessage} ` : '') +
    (delivered ? `${delivered} ` : '') +
    (runtime.online === false ? `${OFFLINE_NOTICE} ` : '') +
    // No-progress notice rides here — after every cache breakpoint — so its
    // appearance/change never perturbs the cached prompt prefix.
    (runtime.noProgress ? `${runtime.noProgress} ` : '') +
    // Channel-format notice (a prose block already delivered to the user's
    // phone carried raw markup) — same vehicle, same cache reason.
    (runtime.channelFormat ? `${runtime.channelFormat} ` : '') +
    // Control-token notice (the model's previous reply ended in a literal
    // control token the user saw as text) — same vehicle, same cache reason.
    (runtime.controlToken ? `${runtime.controlToken} ` : '') +
    // Video-task landing notice (an async generation finished while the
    // model was mid-task) — same vehicle, same cache reason.
    (runtime.videoTasks ? `${runtime.videoTasks} ` : '') +
    // Open-task-list notice (a list from an earlier turn is still unfinished
    // on the user's card) and the task-list notice (the list THIS turn wrote
    // still has open items) — same vehicle; each changes at most a few times
    // per turn, on a todo_write. See agent/todo-guard.
    (runtime.openTodo ? `${runtime.openTodo} ` : '') +
    (runtime.taskList ? `${runtime.taskList} ` : '') +
    // Voice-reply notice (voice-prompted turn, Voice replies ON) — same
    // vehicle; stable across the turn, so it never churns the tail.
    (runtime.voiceReply ? `${runtime.voiceReply} ` : '') +
    // Phone-notification notice (a phone is paired and notify_phone is
    // registered) — same vehicle. Changes at most once per turn, when the
    // first notification goes out.
    (runtime.phoneNotify ? `${runtime.phoneNotify} ` : '') +
    // Screen-indicator notice (this turn raised the computer-use glow and has
    // not lowered it) — same vehicle. Changes at most twice per turn.
    (runtime.screenIndicator ? `${runtime.screenIndicator} ` : '') +
    // Mid-turn user-message notice (an interjection was just delivered into
    // this turn's history) — same vehicle; present on exactly one iteration.
    (runtime.interjection ? `${runtime.interjection} ` : '') +
    // Closing-message notice (this turn already wrote its wrap-up and closed it
    // with a turn-closing tool) — same vehicle; spent when drained, so it rides
    // exactly one iteration. See agent/closing-guard.
    (runtime.closing ? `${runtime.closing} ` : '') +
    `(Automated telemetry, not a user message — do not reply to it or summarize progress because of it. ` +
    `If the task is unfinished, keep calling tools: a response without tool calls ends the task; there is no next turn.)`
  )
}

/**
 * Compact, unambiguous local timestamp for the runtime tail — weekday,
 * ISO date, 24h time, UTC offset, and IANA zone, e.g.
 * "Mon 2026-06-15 14:34 (GMT+03:00, Asia/Riyadh)". Pure given
 * (now, timeZone) so it unit-tests deterministically; the live caller lets
 * `timeZone` resolve to the host zone. Defensive by contract: this runs on
 * every iteration and a throw here would break the tool loop, so any
 * ICU/option gap degrades to a bare UTC ISO instant rather than throwing.
 */
export function formatClock(now: Date, timeZone: string = resolveHostTimeZone()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset'
    }).formatToParts(now)
    const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
    if (!part('year') || !part('hour')) throw new Error('incomplete parts')
    const date = `${part('year')}-${part('month')}-${part('day')}`
    const time = `${part('hour')}:${part('minute')}`
    return `${part('weekday')} ${date} ${time} (${part('timeZoneName')}, ${timeZone})`
  } catch {
    return `${now.toISOString()} (UTC, ${timeZone})`
  }
}

function resolveHostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * Below this gap the conversation-resumed notice renders nothing: replies
 * inside an active exchange carry no temporal information worth tail tokens,
 * and suppressing them keeps iteration 1 of ordinary turns as lean as today.
 * At or above it, the user demonstrably stepped away and came back — the
 * transcript's "now" and the actual now have separated far enough that the
 * model must be told, because replayed history carries no timestamps at all.
 */
export const RESUME_NOTICE_MIN_GAP_MS = 30 * 60_000

/**
 * Coarse human-scale rendering of a time gap — "42 minutes ago", "about 5
 * hours ago", "3 days ago", "about 2 months ago". Deliberately imprecise
 * past the hour scale: the notice's job is orders of magnitude (is the user
 * back after lunch, after a weekend, or after a quarter?), and false
 * precision ("37 days ago") reads worse than honest coarseness. Pure, so it
 * unit-tests deterministically.
 */
export function formatTimeGap(ms: number): string {
  const MINUTE = 60_000
  const HOUR = 3_600_000
  const DAY = 86_400_000
  const ago = (n: number, unit: string, about = false): string =>
    `${about ? 'about ' : ''}${n} ${unit}${n === 1 ? '' : 's'} ago`
  if (ms < HOUR) return ago(Math.max(1, Math.round(ms / MINUTE)), 'minute')
  if (ms < 2 * DAY) return ago(Math.max(1, Math.round(ms / HOUR)), 'hour', true)
  if (ms < 14 * DAY) return ago(Math.round(ms / DAY), 'day')
  if (ms < 61 * DAY) return ago(Math.round(ms / (7 * DAY)), 'week', true)
  if (ms < 365 * DAY) return ago(Math.max(2, Math.round(ms / (30.44 * DAY))), 'month', true)
  const years = ms / (365.25 * DAY)
  return years < 2 ? 'over a year ago' : ago(Math.round(years), 'year', true)
}

/**
 * The conversation-resumed notice: when the previous persisted message in
 * this conversation is RESUME_NOTICE_MIN_GAP_MS or older, tell the model —
 * relative gap first (the salient fact), then the full timestamp via
 * formatClock (same format as the tail's own clock, so the two lines are
 * directly comparable). Undefined below the threshold or with no previous
 * message, so the common case renders nothing.
 *
 * This exists because replayed history is timeless: without it, a user
 * returning after three weeks gets answers that treat the transcript's
 * "today", prices, and running state as still current. Computed ONCE per
 * turn by the Agent (now = turn start) so the string is byte-stable across
 * the turn's iterations, like the voice and phone notices.
 */
export function formatLastMessageNotice(
  lastMessageAt: number | null | undefined,
  now: Date = new Date(),
  timeZone: string = resolveHostTimeZone()
): string | undefined {
  if (typeof lastMessageAt !== 'number' || !Number.isFinite(lastMessageAt) || lastMessageAt <= 0) {
    return undefined
  }
  const gapMs = now.getTime() - lastMessageAt
  if (gapMs < RESUME_NOTICE_MIN_GAP_MS) return undefined
  return (
    `CONVERSATION RESUMED: the previous message in this conversation was ${formatTimeGap(gapMs)} — ` +
    `${formatClock(new Date(lastMessageAt), timeZone)}. ` +
    `The user is writing from the present; the turns above spoke from that older "now", so treat their ` +
    `time-sensitive content (dates, "today", running state, fresh data) as dated and re-check what matters.`
  )
}

/**
 * Assemble the outbound clone: deterministic truncation of provably
 * superseded/duplicated payloads (when enabled), then the volatile
 * runtime tail. Returns the original options object untouched when there
 * is nothing to do.
 */
export function shapeOutbound(options: ProviderStreamOptions): ProviderStreamOptions {
  let messages = options.messages
  if (options.truncateOutbound) {
    messages = truncateSuperseded(messages)
  }
  if (options.volatileStatus) {
    const tail: ChatMessage = { role: 'user', content: options.volatileStatus, volatile: true }
    messages = [...messages, tail]
  }
  return messages === options.messages ? options : { ...options, messages }
}

/**
 * Build the outbound structural clone with only the volatile tail.
 * Retained for callers/tests that exercise the tail in isolation;
 * shapeOutbound is the full pipeline.
 */
export function withVolatileTail(options: ProviderStreamOptions): ProviderStreamOptions {
  return shapeOutbound({ ...options, truncateOutbound: false })
}

/**
 * Deterministic outbound truncation. Three passes, all keyed on provable
 * facts, all producing new message objects (originals are never touched):
 *
 * 1. Superseded page state — older successful page-state reads of the
 *    same tool+browser-session collapse to a stub once a newer successful
 *    read exists. The newest read of each session always stays full, and
 *    failed reads always stay full (failures are evidence).
 * 2. Byte-equal duplicates — a later result identical to an earlier one
 *    collapses to a backward pointer. The earliest full copy is kept
 *    (not the latest) deliberately: pointing backward never invalidates
 *    the provider cache prefix, while rewriting an old message to favor
 *    a recent copy would re-bill everything after it. The information is
 *    identical either way — it exists in full earlier in context.
 * 3. Screenshots — only the most recent image-bearing tool result keeps
 *    its images; older ones keep their text but drop the pixels. The
 *    message carrying the newest screenshot is immune to every pass:
 *    the latest visual state is always load-bearing.
 *
 * Stub texts are pure functions of (tool, original size), so once a
 * message is stubbed its outbound bytes never change again — the cache
 * pays for each stub transition exactly once.
 */
export function truncateSuperseded(messages: ChatMessage[]): ChatMessage[] {
  // tool_use id → args, for browser-session keying. Reads from different
  // sessions never supersede each other.
  const argsById = new Map<string, Record<string, unknown>>()
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolUses) {
      for (const tu of m.toolUses) argsById.set(tu.id, tu.args)
    }
  }

  // Latest successful page-state read per (tool, session).
  const latestPageState = new Map<string, number>()
  // Latest successful file read per (path, window): a re-read of the same
  // window after an edit provably supersedes the earlier copy.
  const latestFileRead = new Map<string, number>()
  // Latest image-bearing tool result — immune to all stubbing.
  let latestImagesIdx = -1
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== 'tool') continue
    if (!m.isError && PAGE_STATE_TOOLS.has(m.toolName)) {
      latestPageState.set(pageStateKey(m.toolName, m.toolUseId, argsById), i)
    }
    if (!m.isError && m.toolName === FILE_READ_TOOL) {
      const key = fileReadKey(m.toolUseId, argsById)
      if (key) latestFileRead.set(key, i)
    }
    if (m.images && m.images.length > 0) latestImagesIdx = i
  }

  // First occurrence of each full (tool, content) pair, for dedup.
  const firstSeen = new Map<string, number>()
  let changed = false

  const out = messages.map((m, i) => {
    if (m.role !== 'tool') return m
    if (i === latestImagesIdx) return m

    let next = m

    if (
      !m.isError &&
      PAGE_STATE_TOOLS.has(m.toolName) &&
      m.content.length >= MIN_STUB_CHARS &&
      latestPageState.get(pageStateKey(m.toolName, m.toolUseId, argsById)) !== i
    ) {
      next = { ...m, content: supersededStub(m.toolName, m.content.length), images: undefined }
    }

    if (
      next === m &&
      !m.isError &&
      m.toolName === FILE_READ_TOOL &&
      m.content.length >= MIN_STUB_CHARS
    ) {
      const key = fileReadKey(m.toolUseId, argsById)
      if (key && latestFileRead.get(key) !== i) {
        next = { ...m, content: supersededReadStub(key, m.content.length), images: undefined }
      }
    }

    // Dedup only among results that are still full — a stubbed earlier
    // copy must not become the target of a backward pointer.
    if (next === m && !m.isError && m.content.length >= MIN_STUB_CHARS) {
      const key = `${m.toolName} ${m.content}`
      const first = firstSeen.get(key)
      if (first === undefined) {
        firstSeen.set(key, i)
      } else {
        next = { ...m, content: duplicateStub(m.toolName, m.content.length), images: undefined }
      }
    }

    if (next === m && m.images && m.images.length > 0) {
      next = { ...m, images: undefined, content: imagesOmittedNote(m.images.length) + m.content }
    }

    if (next !== m) changed = true
    return next
  })

  return changed ? out : messages
}

function pageStateKey(
  toolName: string,
  toolUseId: string,
  argsById: Map<string, Record<string, unknown>>
): string {
  const args = argsById.get(toolUseId)
  const session = typeof args?.session_id === 'string' ? args.session_id : ''
  return `${toolName} ${session}`
}

const FILE_READ_TOOL = 'file_read'

/** `path|offset|limit` for a file_read call; null when the args are not a read. */
function fileReadKey(
  toolUseId: string,
  argsById: Map<string, Record<string, unknown>>
): string | null {
  const args = argsById.get(toolUseId)
  if (!args || typeof args.path !== 'string') return null
  const offset =
    typeof args.offset === 'number'
      ? args.offset
      : typeof args.startLine === 'number'
        ? args.startLine
        : 1
  const limit =
    typeof args.limit === 'number'
      ? args.limit
      : typeof args.endLine === 'number'
        ? args.endLine - offset + 1
        : 'default'
  return `${args.path}|${offset}|${limit}`
}

function supersededReadStub(key: string, chars: number): string {
  const file = key.split('|')[0]
  return (
    `[superseded file read — this file_read of ${file} (${chars.toLocaleString()} chars) was replaced by a ` +
    `newer read of the same window later in this conversation; that copy is current.]`
  )
}

function supersededStub(tool: string, chars: number): string {
  return (
    `[superseded page state — this ${tool} result (${chars.toLocaleString()} chars) was replaced by a ` +
    `newer read of the same browser session later in this conversation. The page may have changed since; ` +
    `call ${tool} again if you need its current content.]`
  )
}

function duplicateStub(tool: string, chars: number): string {
  return `[duplicate result — byte-identical to an earlier ${tool} result above (${chars.toLocaleString()} chars); refer to that copy.]`
}

function imagesOmittedNote(count: number): string {
  const what = count === 1 ? 'screenshot' : `${count} screenshots`
  return `[${what} omitted — a newer screenshot appears later in this conversation; take a new one if you need current visuals.]\n`
}
