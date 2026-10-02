import type { ConversationMessage } from '@main/conversations'
import type { Segment } from '@main/runtime/broca'

/**
 * Fitting a live mirror snapshot inside a wire budget.
 *
 * The tunnel's relay closes a connection on any record over 1 MiB, so every
 * mirrored message travels under a hard ceiling (MIRROR_MAX_BYTES in the
 * mobile channel). The first shape of that guard simply WITHHELD an oversized
 * snapshot — and that silence is how a long tool-heavy turn went dark on the
 * phone for its whole remaining runtime (2026-08-22: twelve minutes of a
 * Gmail sweep invisible, and a phone relaunched mid-turn came back to a blank
 * conversation, because the only pipe that could have redrawn it was the one
 * being withheld).
 *
 * So: never withhold — TRIM. The bulk of a big snapshot is never the prose
 * the user is reading; it is tool payloads (a gmail_search dump, a heredoc
 * command) that the phone renders as collapsed cards anyway. Shorten those,
 * oldest first, keep the newest segments whole — the live edge is what the
 * user is actually watching — and the persisted transcript restores every
 * byte when the turn folds, because the fold saves the accumulator, not the
 * trimmed copy.
 *
 * Everything here is PURE: the accumulator's segments are the very objects
 * the end-of-turn save persists, so nothing in this module may mutate its
 * input. Copies are made only where something is actually shortened.
 */

/**
 * Appended wherever the phone's copy shortens a string it is showing. Worded
 * for BOTH places a trim can land — a live mirror (replaced whole at the
 * fold) and a stored body served over the wire ceiling (which stays trimmed
 * on the phone) — so it promises only what is always true: the desktop has
 * the full record.
 */
export const MIRROR_TRIM_MARKER = '… [shortened to fit the phone — the desktop keeps the full text]'

/** What a fully elided tool payload reads as on the phone's card. */
export const MIRROR_ELIDED_OUTPUT =
  '[shortened to fit the phone — the desktop keeps the full output]'

/** Longest string a trimmed segment keeps (tool output, error, arg value). */
const LONG_STRING_CAP = 2_048

/** The assistant prose keeps at most this much — the newest words, since the
 *  feed is pinned to the bottom. Far above any real turn's prose; a guard,
 *  not a feature. */
const CONTENT_CAP = 96 * 1024

/** Headroom left under the caller's budget for JSON punctuation between the
 *  parts this module sizes separately. */
const SLACK_BYTES = 2_048

function byteSize(value: unknown): number | null {
  try {
    const json = JSON.stringify(value)
    return json === undefined ? null : Buffer.byteLength(json)
  } catch {
    return null
  }
}

/** Keep the FRONT of a string — tool output reads top-down. */
function capHead(value: string, cap: number): string {
  if (value.length <= cap) return value
  return `${value.slice(0, cap)}\n${MIRROR_TRIM_MARKER}`
}

/** Keep the TAIL of a string — prose is read at its newest end. */
function capTail(value: string, cap: number): string {
  if (value.length <= cap) return value
  return `${MIRROR_TRIM_MARKER}\n${value.slice(value.length - cap)}`
}

/**
 * Cap every long string leaf inside a tool_call's args, recursively. Args are
 * JSON off the model (acyclic by construction), but depth is bounded anyway —
 * the wire is data, not policy. Returns the input object untouched when
 * nothing needed shortening, so the common case allocates nothing.
 */
function capArgStrings(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > LONG_STRING_CAP ? capHead(value, LONG_STRING_CAP) : value
  }
  if (!value || typeof value !== 'object' || depth >= 6) return value
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((entry) => {
      const capped = capArgStrings(entry, depth + 1)
      if (capped !== entry) changed = true
      return capped
    })
    return changed ? next : value
  }
  let changed = false
  const next: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const capped = capArgStrings(entry, depth + 1)
    if (capped !== entry) changed = true
    next[key] = capped
  }
  return changed ? next : value
}

/** First pass: shorten the long strings a segment carries, copy-on-trim. */
function capSegment(segment: Segment): Segment {
  switch (segment.kind) {
    case 'tool_result': {
      const output =
        segment.output.length > LONG_STRING_CAP ? capHead(segment.output, LONG_STRING_CAP) : null
      const error =
        segment.error && segment.error.length > LONG_STRING_CAP
          ? capHead(segment.error, LONG_STRING_CAP)
          : null
      if (output === null && error === null) return segment
      return {
        ...segment,
        ...(output !== null ? { output } : {}),
        ...(error !== null ? { error } : {})
      }
    }
    case 'tool_call': {
      const args = capArgStrings(segment.args) as Record<string, unknown>
      return args === segment.args ? segment : { ...segment, args }
    }
    case 'turn_end': {
      if (!segment.reasoningContent || segment.reasoningContent.length <= LONG_STRING_CAP) {
        return segment
      }
      return { ...segment, reasoningContent: capHead(segment.reasoningContent, LONG_STRING_CAP) }
    }
    case 'reasoning': {
      if (segment.delta.length <= LONG_STRING_CAP) return segment
      return { ...segment, delta: capHead(segment.delta, LONG_STRING_CAP) }
    }
    default:
      return segment
  }
}

/**
 * Segments this module may never shorten, reduce or drop, at any budget.
 *
 * Everything else here is the AGENT's output, and losing some of it costs a
 * detail the desktop still holds. A `user_message` segment is the USER's own
 * words, sent mid-turn, and it has no other copy on the receiving surface: the
 * pending bubble that stood in for it comes down the moment it is delivered.
 * Trimming it is not degradation, it is deletion — and on a stored body served
 * over the wire ceiling (fitWireMessages) the trim is what the phone keeps.
 *
 * They are also tiny — a sentence or two — so exempting them costs the budget
 * nothing it will miss.
 */
function isProtectedSegment(segment: Segment): boolean {
  return segment.kind === 'user_message'
}

/**
 * Second pass: the minimal form of a segment — payloads gone, structure kept,
 * so the phone still draws the card (name, status, ordering) and only the
 * bulk is deferred to the saved transcript.
 */
function reduceSegment(segment: Segment): Segment {
  switch (segment.kind) {
    case 'tool_result':
      return {
        ...segment,
        output: MIRROR_ELIDED_OUTPUT,
        ...(segment.error ? { error: MIRROR_ELIDED_OUTPUT } : {})
      }
    case 'tool_call':
      return { ...segment, args: { trimmed: MIRROR_ELIDED_OUTPUT } }
    case 'turn_end':
      return segment.reasoningContent ? { ...segment, reasoningContent: undefined } : segment
    case 'reasoning':
      return segment.delta ? { ...segment, delta: '' } : segment
    default:
      return segment
  }
}

/**
 * Fit one message inside `maxBytes`, or null when even its bare envelope
 * cannot fit (which no real message reaches — the caller keeps its legacy
 * degrade path for exactly that impossibility).
 *
 * Under budget → the SAME object back, unchanged and unallocated. Over →
 * three passes, stopping at the first that fits: long strings capped
 * everywhere; then payloads elided oldest-first while the newest segments
 * stay whole; then whole oldest segments dropped. The message id, role and
 * timestamp always survive — they are how the phone replaces this snapshot
 * with the saved copy.
 */
export function fitMirrorMessage(
  message: ConversationMessage,
  maxBytes: number
): ConversationMessage | null {
  const whole = byteSize(message)
  if (whole === null) return null
  if (whole <= maxBytes) return message

  // Pass 1 — cap the long strings, and the prose to its newest CONTENT_CAP.
  const content =
    typeof message.content === 'string' && message.content.length > CONTENT_CAP
      ? capTail(message.content, CONTENT_CAP)
      : message.content
  const capped = (message.segments ?? []).map(capSegment)
  const candidate: ConversationMessage = { ...message, content, segments: capped }
  if (message.segments === undefined) delete candidate.segments
  const cappedSize = byteSize(candidate)
  if (cappedSize === null) return null
  if (cappedSize <= maxBytes) return candidate

  // Pass 2 — newest segments whole, older ones reduced. Sized per part so one
  // walk decides the split: keep taking full segments from the newest end
  // while everything older, in reduced form, still fits beside them.
  const envelope = byteSize({ ...candidate, segments: [] })
  if (envelope === null) return null
  const budget = maxBytes - envelope - SLACK_BYTES
  const fullSizes = capped.map((segment) => byteSize(segment) ?? 0)
  const reduced = capped.map(reduceSegment)
  const reducedSizes = reduced.map((segment) => byteSize(segment) ?? 0)
  // reducedPrefix[i] = bytes of segments 0..i-1 in reduced form.
  const reducedPrefix: number[] = [0]
  for (let i = 0; i < reducedSizes.length; i++) {
    reducedPrefix.push(reducedPrefix[i] + reducedSizes[i] + 1)
  }
  // Walk from the newest end: `keepFrom` is the first index kept whole.
  let keepFrom = capped.length
  let keptBytes = 0
  for (let i = capped.length - 1; i >= 0; i--) {
    const withThis = keptBytes + fullSizes[i] + 1
    if (withThis + reducedPrefix[i] > budget) break
    keptBytes = withThis
    keepFrom = i
  }
  let segments = [...reduced.slice(0, keepFrom), ...capped.slice(keepFrom)]
  if (reducedPrefix[keepFrom] + keptBytes <= budget) {
    const fitted: ConversationMessage = { ...candidate, segments }
    const fittedSize = byteSize(fitted)
    if (fittedSize !== null && fittedSize <= maxBytes) return fitted
  }

  // Pass 3 — even all-reduced is too big: drop the oldest segments outright.
  // The newest stay; the saved transcript restores the rest at the fold.
  // Protected segments are stepped over rather than dropped — they are the
  // user's own mid-turn messages, which have no other copy on the phone.
  segments = [...reduced]
  let cut = 0
  while (cut < segments.length) {
    if (isProtectedSegment(segments[cut])) {
      cut++
      continue
    }
    segments.splice(cut, 1)
    const fitted: ConversationMessage = { ...candidate, segments: [...segments] }
    const size = byteSize(fitted)
    if (size !== null && size <= maxBytes) return fitted
  }
  // Only protected segments left. They stay even here: a snapshot that fits by
  // deleting what the user said is not a snapshot worth sending.
  const bare: ConversationMessage = { ...candidate, segments: [...segments] }
  const bareSize = byteSize(bare)
  if (bareSize !== null && bareSize <= maxBytes) return bare
  // The envelope alone is over — the prose itself is the bulk. Chars, not
  // bytes, so a fully multibyte text still fits at 4 bytes per char.
  const squeezed: ConversationMessage = {
    ...bare,
    content: capTail(typeof bare.content === 'string' ? bare.content : '', Math.floor(maxBytes / 8))
  }
  const squeezedSize = byteSize(squeezed)
  return squeezedSize !== null && squeezedSize <= maxBytes ? squeezed : null
}

/**
 * Fit a whole transcript under one wire ceiling — the conversation-body serve,
 * which travels as a single frame today. A finished tool-heavy turn can push
 * the file past the relay's record cap, and an oversized answer does not
 * arrive late, it CLOSES the tunnel — after which every open of that
 * conversation kills the link again. Trimmed-but-served beats that every time.
 *
 * Messages are fitted individually under a per-message cap that halves until
 * the whole body fits (or the cap floors out — at which point the caller
 * serves the best effort rather than nothing). Under the ceiling → the same
 * array back, untouched.
 */
export function fitWireMessages(
  messages: ConversationMessage[],
  maxTotalBytes: number
): ConversationMessage[] {
  const whole = byteSize(messages)
  if (whole !== null && whole <= maxTotalBytes) return messages
  let perMessageCap = Math.max(Math.floor(maxTotalBytes / 2), 64 * 1024)
  let fitted = messages
  while (perMessageCap >= 8 * 1024) {
    const cap = perMessageCap
    fitted = messages.map(
      (message) =>
        fitMirrorMessage(message, cap) ?? {
          ...message,
          // The legacy degrade path keeps the user's own mid-turn messages:
          // this body is what an older phone STORES, so a segment dropped
          // here is dropped for good on that device.
          segments: (message.segments ?? []).filter(isProtectedSegment)
        }
    )
    const size = byteSize(fitted)
    if (size !== null && size <= maxTotalBytes) return fitted
    perMessageCap = Math.floor(perMessageCap / 2)
  }
  return fitted
}
